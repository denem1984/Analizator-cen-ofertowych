const http = require("http");
const { URL } = require("url");
const { searchNieruchomosciOnline } = require("./live-parser");
const { searchMorizon } = require("./live-morizon");

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

// STAŁA ZASADA PROJEKTU:
// ten sam URL LUB ta sama cena + ta sama powierzchnia = duplikat.
function dedupeOffers(offers) {
  const seenUrl = new Set();
  const seenData = new Set();
  const duplicates = [];
  const result = [];

  for (const offer of offers) {
    const urlKey = normalizeUrl(offer.url);
    const price = Number(offer.price);
    const area = Number(offer.area);
    const dataKey = Number.isFinite(price) && Number.isFinite(area)
      ? `${price}|${area}` : "";

    let reason = "";
    if (urlKey && seenUrl.has(urlKey)) reason = "ten sam URL";
    else if (dataKey && seenData.has(dataKey)) reason = "ta sama cena + ta sama powierzchnia";

    if (reason) {
      const kept = result.find(x =>
        (urlKey && normalizeUrl(x.url) === urlKey) ||
        (dataKey && `${Number(x.price)}|${Number(x.area)}` === dataKey)
      );
      duplicates.push({ reason, kept: kept || result[0], duplicate: offer });
      continue;
    }

    if (urlKey) seenUrl.add(urlKey);
    if (dataKey) seenData.add(dataKey);
    result.push(offer);
  }

  return { rows: result, duplicates };
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function run(body = {}) {
  const location = String(body.location || "Olsztyn").trim();
  const area = Number(body.area || 62);
  const tolerance = Number(body.tolerance ?? 10);

  if (location.toLowerCase() !== "olsztyn" || !Number.isFinite(area) || area <= 0) {
    const e = new Error("Test v0.5 działa obecnie dla Olsztyna.");
    e.status = 400;
    throw e;
  }

  const minArea = area * (1 - tolerance / 100);
  const maxArea = area * (1 + tolerance / 100);
  const EPS = 1e-9;

  const [no, morizon] = await Promise.all([
    searchNieruchomosciOnline({ location }),
    searchMorizon()
  ]);

  const sources = [no, morizon].map(live => {
    const complete = live.offers.filter(o =>
      o.locality && Number.isFinite(o.price) && Number.isFinite(o.area) && o.url
    );
    const filtered = complete.filter(o =>
      o.area >= minArea - EPS && o.area <= maxArea + EPS
    );
    return {
      portal: live.portal,
      httpStatus: live.httpStatus,
      fetched: live.fetched,
      htmlLength: live.htmlLength,
      recognized: live.recognized,
      complete: complete.length,
      filtered: filtered.length,
      offers: filtered
    };
  });

  const before = sources.flatMap(s => s.offers);
  const cross = dedupeOffers(before);

  return {
    version: "0.5.0-combined-test",
    location,
    area,
    tolerance,
    minArea,
    maxArea,
    sources: sources.map(s => ({
      portal: s.portal,
      httpStatus: s.httpStatus,
      fetched: s.fetched,
      htmlLength: s.htmlLength,
      recognized: s.recognized,
      complete: s.complete,
      filtered: s.filtered,
      uniqueAfterCrossPortal: cross.rows.filter(o => o.source === s.portal).length
    })),
    beforeCrossDedup: before.length,
    unique: cross.rows.length,
    duplicatesRemoved: cross.duplicates.length,
    duplicates: cross.duplicates,
    offers: cross.rows
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, service: "combined-live-v05" });
  }

  if (req.method === "POST" && url.pathname === "/api/live/combined") {
    try {
      return send(res, 200, await run(await parseBody(req)));
    } catch (e) {
      return send(res, e.status || 500, { error: e.message || "Błąd serwera" });
    }
  }

  return send(res, 404, { error: "Nie znaleziono endpointu." });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Combined live v0.5 listening on port ${PORT}`);
  run({ location: "Olsztyn", area: 62, tolerance: 10 })
    .then(r => console.log(JSON.stringify({
      liveSelfTest: true,
      beforeCrossDedup: r.beforeCrossDedup,
      unique: r.unique,
      duplicatesRemoved: r.duplicatesRemoved,
      sources: r.sources,
      duplicates: r.duplicates.slice(0, 20).map(d => ({
        reason: d.reason,
        kept: { source: d.kept.source, price: d.kept.price, area: d.kept.area },
        duplicate: { source: d.duplicate.source, price: d.duplicate.price, area: d.duplicate.area }
      }))
    })))
    .catch(e => console.error(`liveSelfTest ERROR: ${e.message}`));
});
