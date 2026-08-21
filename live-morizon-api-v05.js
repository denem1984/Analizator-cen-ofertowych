const http = require("http");
const { URL } = require("url");
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
    u.hash = ""; u.search = "";
    return u.href.replace(/\/$/, "").toLowerCase();
  } catch { return String(value || "").trim().toLowerCase(); }
}

function dedupeOffers(offers) {
  // NIE ZMIENIAĆ: ten sam URL LUB ta sama cena + ta sama powierzchnia.
  const seenUrl = new Set(), seenData = new Set(), result = [];
  for (const offer of offers) {
    const urlKey = normalizeUrl(offer.url);
    const price = Number(offer.price), area = Number(offer.area);
    const dataKey = Number.isFinite(price) && Number.isFinite(area) ? `${price}|${area}` : "";
    if (urlKey && seenUrl.has(urlKey)) continue;
    if (dataKey && seenData.has(dataKey)) continue;
    if (urlKey) seenUrl.add(urlKey);
    if (dataKey) seenData.add(dataKey);
    result.push(offer);
  }
  return result;
}

async function run(body = {}) {
  const location = String(body.location || "Olsztyn").trim();
  const area = Number(body.area || 62);
  const tolerance = Number(body.tolerance ?? 10);
  if (location.toLowerCase() !== "olsztyn" || !Number.isFinite(area) || area <= 0) {
    const e = new Error("Test v0.5 Morizon działa obecnie dla Olsztyna."); e.status = 400; throw e;
  }
  const live = await searchMorizon();
  const minArea = area * (1 - tolerance / 100), maxArea = area * (1 + tolerance / 100);
  const complete = live.offers.filter(o => o.locality && Number.isFinite(o.price) && Number.isFinite(o.area) && o.url);
  const filtered = complete.filter(o => o.area >= minArea - 1e-9 && o.area <= maxArea + 1e-9);
  const unique = dedupeOffers(filtered);
  return { version:"0.5.0-morizon-test", portal:live.portal, location, area, tolerance, minArea, maxArea,
    sourceUrl:live.url, httpStatus:live.httpStatus, fetched:live.fetched, htmlLength:live.htmlLength,
    recognized:live.recognized, complete:complete.length, filtered:filtered.length, unique:unique.length, offers:unique };
}

const server = http.createServer(async (req,res) => {
  if (req.method === "OPTIONS") return send(res,204,{});
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/health") return send(res,200,{ok:true,service:"morizon-live-v05"});
  if (req.method === "POST" && url.pathname === "/api/live/morizon") {
    try {
      let raw=""; for await (const chunk of req) raw += chunk;
      return send(res,200,await run(raw ? JSON.parse(raw) : {}));
    } catch(e) { return send(res,e.status||500,{error:e.message||"Błąd serwera"}); }
  }
  return send(res,404,{error:"Nie znaleziono endpointu."});
});

server.listen(PORT,"0.0.0.0",()=>{
  console.log(`Morizon live v0.5 listening on port ${PORT}`);
  run({location:"Olsztyn",area:62,tolerance:10})
    .then(r=>console.log(JSON.stringify({liveSelfTest:true,httpStatus:r.httpStatus,fetched:r.fetched,recognized:r.recognized,complete:r.complete,filtered:r.filtered,unique:r.unique,sample:r.offers.slice(0,5)})))
    .catch(e=>console.error(`liveSelfTest ERROR: ${e.message}`));
});
