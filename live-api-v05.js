const http = require("http");
const { URL } = require("url");
const { searchNieruchomosciOnline } = require("./live-parser");

const PORT = process.env.PORT || 10000;

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 100000) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error("Nieprawidłowy JSON")); }
    });
    req.on("error", reject);
  });
}

function normalizeUrl(value) {
  try {
    const u = new URL(value);
    u.hash = "";
    u.search = "";
    return u.href.replace(/\/$/, "").toLowerCase();
  } catch {
    return String(value || "").trim().toLowerCase();
  }
}

function dedupeOffers(offers) {
  // Zasada projektu: cena + powierzchnia jest głównym, niezależnym
  // kryterium deduplikacji. URL jest dodatkowym kryterium, nie zamiennikiem.
  const seenUrl = new Set();
  const seenData = new Set();
  const result = [];

  for (const offer of offers) {
    const urlKey = normalizeUrl(offer.url);
    const price = Number(offer.price);
    const area = Number(offer.area);
    const dataKey = Number.isFinite(price) && Number.isFinite(area)
      ? `${price}|${area}`
      : "";

    if (urlKey && seenUrl.has(urlKey)) continue;
    if (dataKey && seenData.has(dataKey)) continue;

    if (urlKey) seenUrl.add(urlKey);
    if (dataKey) seenData.add(dataKey);
    result.push(offer);
  }

  return result;
}

async function runSearch(body) {
  const location = String(body.location || "Olsztyn").trim();
  const area = Number(body.area);
  const tolerance = Number(body.tolerance ?? 10);

  if (!location || !Number.isFinite(area) || area <= 0) {
    const error = new Error("Podaj miejscowość i powierzchnię.");
    error.status = 400;
    throw error;
  }

  if (location.toLowerCase() !== "olsztyn") {
    const error = new Error("W wersji testowej v0.5 pierwszy portal działa dla Olsztyna.");
    error.status = 400;
    throw error;
  }

  const live = await searchNieruchomosciOnline({ location });
  const minArea = area * (1 - tolerance / 100);
  const maxArea = area * (1 + tolerance / 100);

  const complete = live.offers.filter(o =>
    o.locality &&
    Number.isFinite(o.price) &&
    Number.isFinite(o.area) &&
    o.url
  );

  const filtered = complete.filter(o => o.area >= minArea && o.area <= maxArea);
  const unique = dedupeOffers(filtered);

  return {
    version: "0.5.0-test",
    portal: live.portal,
    location,
    area,
    tolerance,
    minArea,
    maxArea,
    sourceUrl: live.url,
    httpStatus: live.httpStatus,
    fetched: live.fetched,
    htmlLength: live.htmlLength,
    recognized: live.recognized,
    complete: complete.length,
    filtered: filtered.length,
    unique: unique.length,
    offers: unique
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, service: "analizator-cen-ofertowych-live-v05" });
  }

  if (req.method === "POST" && url.pathname === "/api/live/nieruchomosci-online") {
    try {
      const body = await parseBody(req);
      return send(res, 200, await runSearch(body));
    } catch (err) {
      return send(res, err.status || 500, { error: err.message || "Błąd serwera" });
    }
  }

  return send(res, 404, { error: "Nie znaleziono endpointu." });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Analizator live v0.5 listening on port ${PORT}`);

  runSearch({ location: "Olsztyn", area: 62, tolerance: 10 })
    .then(r => console.log(JSON.stringify({
      liveSelfTest: true,
      httpStatus: r.httpStatus,
      fetched: r.fetched,
      recognized: r.recognized,
      complete: r.complete,
      filtered: r.filtered,
      unique: r.unique,
      sample: r.offers.slice(0, 3).map(o => ({
        locality: o.locality,
        street: o.street,
        price: o.price,
        area: o.area,
        priceM2: o.priceM2,
        url: o.url
      }))
    })))
    .catch(err => console.error(`liveSelfTest ERROR: ${err.message}`));
});
