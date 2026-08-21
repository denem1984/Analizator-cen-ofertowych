const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

function send(res, status, data, headers = {}) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": typeof data === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...headers
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 100000) {
        req.destroy();
        reject(new Error("Request too large"));
      }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error("Nieprawidłowy JSON")); }
    });
    req.on("error", reject);
  });
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function buildQueries({ type, location, unit, radius, area, tolerance }) {
  const min = area * (1 - tolerance / 100);
  const max = area * (1 + tolerance / 100);
  const sizePhrase = `${min.toFixed(1)} ${max.toFixed(1)} m2`;
  const base = `${type} sprzedaż ${location} ${sizePhrase}`;
  const extra = Number(radius) > 0 ? ` okolice ${radius} km` : "";
  return [
    `${base}${extra}`,
    `${type} na sprzedaż ${location} mieszkanie ${Math.round(area)} m2`,
    `${type} sprzedaż ${location} ${Math.round(min)}-${Math.round(max)} m2`
  ];
}

async function tavilySearch(query) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TAVILY_API_KEY}`
    },
    body: JSON.stringify({
      query,
      topic: "general",
      search_depth: "basic",
      max_results: 10,
      include_answer: false,
      include_raw_content: true,
      country: "poland"
    })
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text }; }

  if (!response.ok) {
    const err = new Error(data?.detail || data?.error || `Tavily HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return data;
}

function extractOffer(result, requestedType) {
  const text = cleanText(`${result.title || ""} ${result.content || ""} ${result.raw_content || ""}`);
  const url = result.url || "";
  if (!url) return null;

  // Heuristics only. The frontend/backend will later be refined for individual portals.
  const priceMatches = [...text.matchAll(/(?:cena|price)?\s*[:\-]?\s*([0-9][0-9 .]{2,})\s*(?:zł|PLN)/gi)];
  const areaMatches = [...text.matchAll(/([0-9]{1,4}(?:[,.][0-9]{1,2})?)\s*(?:m²|m2|m kw\.|mkw)/gi)];

  let price = NaN;
  for (const m of priceMatches) {
    const x = Number(m[1].replace(/[ .]/g, "").replace(",", "."));
    if (x >= 10000) { price = x; break; }
  }

  let area = NaN;
  for (const m of areaMatches) {
    const x = Number(m[1].replace(",", "."));
    if (x > 10 && x < 500) { area = x; break; }
  }

  if (!Number.isFinite(price) || !Number.isFinite(area)) return null;

  return {
    type: requestedType,
    location: "",
    url,
    price,
    area,
    title: cleanText(result.title),
    source: (() => { try { return new URL(url).hostname; } catch { return ""; } })()
  };
}

function dedupe(items) {
  const map = new Map();
  for (const item of items) {
    const key = [
      cleanText(item.location).toLowerCase(),
      Math.round(item.area * 100) / 100,
      Math.round(item.price)
    ].join("|");
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}

async function handleSearch(body) {
  if (!TAVILY_API_KEY) {
    const e = new Error("Brak zmiennej środowiskowej TAVILY_API_KEY na Renderze.");
    e.status = 500;
    throw e;
  }

  const type = cleanText(body.type);
  const location = cleanText(body.location);
  const unit = cleanText(body.unit);
  const radius = Number(body.radius || 0);
  const area = Number(body.area);
  const tolerance = Number(body.tolerance || 10);

  if (!type || !location || !Number.isFinite(area) || area <= 0) {
    const e = new Error("Brak wymaganych parametrów: typ, lokalizacja lub powierzchnia.");
    e.status = 400;
    throw e;
  }

  const queries = buildQueries({ type, location, unit, radius, area, tolerance });
  const raw = [];

  for (const query of queries) {
    const data = await tavilySearch(query);
    for (const result of (data.results || [])) {
      const item = extractOffer(result, type);
      if (item) raw.push(item);
    }
  }

  const min = area * (1 - tolerance / 100);
  const max = area * (1 + tolerance / 100);
  const filtered = raw.filter(x => x.area >= min && x.area <= max);
  const unique = dedupe(filtered);

  return {
    parameters: { type, location, unit, radius, area, tolerance, minArea: min, maxArea: max },
    found: raw.length,
    filtered: filtered.length,
    unique: unique.length,
    results: unique
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, "");

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, service: "analizator-cen-ofertowych", tavilyConfigured: Boolean(TAVILY_API_KEY) });
  }

  if (req.method === "POST" && url.pathname === "/api/search-offers") {
    try {
      const body = await parseBody(req);
      const result = await handleSearch(body);
      return send(res, 200, result);
    } catch (err) {
      return send(res, err.status || 500, { error: err.message || "Błąd serwera" });
    }
  }

  return send(res, 404, { error: "Nie znaleziono endpointu." });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Analizator backend listening on 0.0.0.0:${PORT}`);
});
