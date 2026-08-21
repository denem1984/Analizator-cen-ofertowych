const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

function send(res, status, data) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": typeof data === "string"
      ? "text/plain; charset=utf-8"
      : "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
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

const clean = s => String(s || "").replace(/\s+/g, " ").trim();

function hostname(url) {
  try { return new URL(url).hostname.toLowerCase(); }
  catch { return ""; }
}

/*
 * Heurystyka: strony z listami/archiwami nie są ofertami.
 * To nie jest lista zamknięta - będziemy ją rozszerzać po testach.
 */
const LISTING_SEGMENTS = [
  "mieszkania-na-sprzedaz",
  "mieszkania,sprzedaz",
  "mieszkania/sprzedaz",
  "sprzedaz/mieszkania",
  "nieruchomosci/mieszkania",
  "nieruchomosci/mieszkania/sprzedaz",
  "mieszkania-na-sprzedaz-",
  "mieszkania/sprzedaz/",
  "sprzedaz/mieszkania/"
];

function looksLikeListingPage(url, title = "") {
  const u = url.toLowerCase();
  const t = title.toLowerCase();

  if (LISTING_SEGMENTS.some(x => u.includes(x))) return true;

  const listingWords = [
    "mieszkania na sprzedaż",
    "mieszkania na sprzedaz",
    "mieszkania - sprzedaż",
    "mieszkania - sprzedaz",
    "mieszkania sprzedaż",
    "mieszkania sprzedaz"
  ];

  if (listingWords.some(x => t.includes(x)) && !/\/oferta[\/-]|\/property[\/-]|\/ogloszenie[\/-]|[?&](id|offer|listing)=/i.test(u)) {
    return true;
  }

  return false;
}

function buildQueries({ type, location, unit, radius, area, tolerance }) {
  const min = area * (1 - tolerance / 100);
  const max = area * (1 + tolerance / 100);
  const a = Math.round(area);
  const lo = Math.round(min);
  const hi = Math.round(max);
  const near = Number(radius) > 0 ? ` okolice ${radius} km` : "";

  return [
    `"${type}" "na sprzedaż" "${location}" ${a} m2${near}`,
    `"${type}" "na sprzedaż" "${location}" ${lo}-${hi} m2`,
    `"${type}" "${location}" ${a} m2 "zł" "m2"`,
    `"${location}" mieszkanie sprzedaż ${a} m2 oferta`
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
    const e = new Error(data?.detail || data?.error || `Tavily HTTP ${response.status}`);
    e.status = response.status;
    throw e;
  }
  return data;
}

async function fetchPage(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);

    const r = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AnalizatorCenOfertowych/0.2)"
      }
    });

    clearTimeout(timer);

    if (!r.ok) return { ok: false, status: r.status, html: "" };
    const html = await r.text();
    return { ok: true, status: r.status, html: html.slice(0, 1500000) };
  } catch {
    return { ok: false, status: 0, html: "" };
  }
}

function decodeHtml(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripTags(html) {
  return decodeHtml(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

function parseJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch {}
  }
  return out;
}

function flattenJsonLd(items) {
  const out = [];
  const walk = x => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) return x.forEach(walk);
    if (x["@graph"]) walk(x["@graph"]);
    out.push(x);
  };
  items.forEach(walk);
  return out;
}

function findJsonLdOffer(html) {
  const objects = flattenJsonLd(parseJsonLd(html));
  const types = o => {
    const t = o?.["@type"];
    return Array.isArray(t) ? t.map(String) : [String(t || "")];
  };

  let price = NaN, area = NaN, location = "";

  for (const o of objects) {
    const ts = types(o).join(" ").toLowerCase();

    if (o.offers) {
      const offers = Array.isArray(o.offers) ? o.offers : [o.offers];
      for (const offer of offers) {
        const p = Number(String(offer?.price ?? "").replace(/\s/g, "").replace(",", "."));
        if (Number.isFinite(p) && p >= 10000) { price = p; break; }
      }
    }

    const p = Number(String(o.price ?? "").replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(price) && Number.isFinite(p) && p >= 10000) price = p;

    const ar = o.floorSize?.value ?? o.floorSize ?? o.size ?? o.area;
    const av = Number(String(ar ?? "").replace(/[^\d,.-]/g, "").replace(",", "."));
    if (!Number.isFinite(area) && av > 10 && av < 500) area = av;

    const addr = o.address;
    if (!location && addr) {
      if (typeof addr === "string") location = clean(addr);
      else {
        location = clean([
          addr.streetAddress,
          addr.addressLocality,
          addr.addressRegion
        ].filter(Boolean).join(", "));
      }
    }

    if (!location && o.location) {
      const a = o.location?.address;
      if (typeof a === "string") location = clean(a);
      else if (a) location = clean([a.streetAddress, a.addressLocality].filter(Boolean).join(", "));
    }

    // Keep JSON-LD evidence but do not accept a generic collection page solely because it has JSON-LD.
    if ((ts.includes("realestatelisting") || ts.includes("product") || ts.includes("offer")) && !location && o.name) {
      // no-op: name is retained later if needed
    }
  }

  return { price, area, location };
}

function firstPrice(text) {
  const patterns = [
    /(?:cena(?:\s+ofertowa)?|cena\s+sprzedaży|cena\s+sprzedazy)\s*[:\-]?\s*([0-9][0-9\s.]*)\s*(?:zł|PLN)\b/i,
    /(?:^|\s)([1-9][0-9]{4,6})\s*(?:zł|PLN)\b/i
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const x = Number(m[1].replace(/[ .\s]/g, ""));
    if (x >= 20000 && x <= 100000000) return x;
  }
  return NaN;
}

function firstArea(text) {
  const patterns = [
    /(?:powierzchnia(?:\s+użytkowa|\s+uzytkowa)?|metraż|metraz)\s*[:\-]?\s*([0-9]{1,4}(?:[,.][0-9]{1,2})?)\s*(?:m²|m2|m kw\.?|mkw)\b/i,
    /([0-9]{1,4}(?:[,.][0-9]{1,2})?)\s*(?:m²|m2|m kw\.?|mkw)\b/i
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const x = Number(m[1].replace(",", "."));
    if (x > 10 && x < 500) return x;
  }
  return NaN;
}

function firstLocation(text, requestedLocation) {
  const patterns = [
    /(?:lokalizacja|adres|miejsce)\s*[:\-]\s*([^|.;]{3,100})/i,
    /(?:ul\.|aleja|al\.)\s*[^,.;]{2,60}(?:,\s*)?[^,.;]{2,60}/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return clean(m[1] || m[0]);
  }
  return requestedLocation;
}

function extractOffer(result, requested) {
  const url = result.url || "";
  const title = clean(result.title);
  if (!url) return { status: "INVALID_URL", source: "", url, title };

  if (looksLikeListingPage(url, title)) {
    return { status: "LISTING_PAGE", source: hostname(url), url, title };
  }

  let html = "";
  let page = null;

  // Prefer the actual page over Tavily's snippet. This is what prevents
  // aggregate values such as "average price per m²" from being treated as a sale price.
  page = fetchPage(url);

  // fetchPage is async; caller supplies the fetched page through _page below.
  return { status: "PENDING", source: hostname(url), url, title, _result: result };
}

function parseOfferPage(candidate, requested, page) {
  const url = candidate.url;
  const title = candidate.title;
  const html = page?.html || "";
  const text = stripTags(html || `${candidate._result?.content || ""} ${candidate._result?.raw_content || ""}`);

  const json = findJsonLdOffer(html);
  let price = json.price;
  let area = json.area;
  let location = json.location;

  if (!Number.isFinite(price)) price = firstPrice(text);
  if (!Number.isFinite(area)) area = firstArea(text);
  if (!location) location = firstLocation(text, requested.location);

  // Basic sanity check: avoid accepting average price/m² as total price.
  if (Number.isFinite(price) && Number.isFinite(area)) {
    const unit = price / area;
    if (unit < 500 || unit > 50000) {
      return { status: "INVALID_DATA", source: hostname(url), url, title, reason: "Pode to być wartość niebędąca ceną całkowitą." };
    }
  }

  if (!Number.isFinite(price)) return { status: "NO_PRICE", source: hostname(url), url, title };
  if (!Number.isFinite(area)) return { status: "NO_AREA", source: hostname(url), url, title };

  return {
    status: "VALID",
    type: requested.type,
    location: clean(location || requested.location),
    url,
    price,
    area,
    title,
    source: hostname(url)
  };
}

function dedupe(items) {
  const map = new Map();
  for (const item of items) {
    const key = [
      clean(item.location).toLowerCase().replace(/\s+/g, " "),
      Math.round(item.area * 100) / 100,
      Math.round(item.price)
    ].join("|");
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}

async function handleSearch(body) {
  if (!TAVILY_API_KEY) {
    const e = new Error("Brak TAVILY_API_KEY na Renderze.");
    e.status = 500; throw e;
  }

  const requested = {
    type: clean(body.type),
    location: clean(body.location),
    unit: clean(body.unit),
    radius: Number(body.radius || 0),
    area: Number(body.area),
    tolerance: Number(body.tolerance || 10)
  };

  if (!requested.type || !requested.location || !(requested.area > 0)) {
    const e = new Error("Brak wymaganych parametrów.");
    e.status = 400; throw e;
  }

  const queries = buildQueries(requested);
  const candidates = [];
  const seenUrls = new Set();

  for (const query of queries) {
    const data = await tavilySearch(query);
    for (const r of data.results || []) {
      if (!r.url || seenUrls.has(r.url)) continue;
      seenUrls.add(r.url);
      candidates.push({
        url: r.url,
        title: clean(r.title),
        content: clean(r.content),
        raw_content: r.raw_content || ""
      });
    }
  }

  const diagnostics = [];
  const parsed = [];

  // Limit direct page fetches in the first prototype to keep the free service predictable.
  for (const candidate of candidates.slice(0, 25)) {
    if (looksLikeListingPage(candidate.url, candidate.title)) {
      diagnostics.push({ status: "LISTING_PAGE", url: candidate.url, title: candidate.title });
      continue;
    }

    const page = await fetchPage(candidate.url);
    if (!page.ok) {
      diagnostics.push({ status: "FETCH_FAILED", url: candidate.url, title: candidate.title, http: page.status });
      continue;
    }

    const item = parseOfferPage(candidate, requested, page);
    diagnostics.push({
      status: item.status,
      url: item.url,
      title: item.title,
      source: item.source,
      reason: item.reason || ""
    });

    if (item.status === "VALID") parsed.push(item);
  }

  const min = requested.area * (1 - requested.tolerance / 100);
  const max = requested.area * (1 + requested.tolerance / 100);
  const filtered = parsed.filter(x => x.area >= min && x.area <= max);
  const unique = dedupe(filtered);

  return {
    parameters: {
      ...requested,
      minArea: min,
      maxArea: max
    },
    found: candidates.length,
    pagesChecked: Math.min(candidates.length, 25),
    valid: parsed.length,
    filtered: filtered.length,
    unique: unique.length,
    results: unique,
    diagnostics
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, "");

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, {
      ok: true,
      service: "analizator-cen-ofertowych",
      version: "0.2",
      tavilyConfigured: Boolean(TAVILY_API_KEY)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/search-offers") {
    try {
      const body = await parseBody(req);
      return send(res, await handleSearch(body));
    } catch (err) {
      return send(res, err.status || 500, { error: err.message || "Błąd serwera" });
    }
  }

  return send(res, 404, { error: "Nie znaleziono endpointu." });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Analizator backend v0.2 listening on 0.0.0.0:${PORT}`);
});
