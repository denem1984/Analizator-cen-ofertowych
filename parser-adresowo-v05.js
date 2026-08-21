const http = require("http");
const { URL } = require("url");

const TARGET_URL = "https://adresowo.pl/mieszkania/olsztyn/";
const PORT = Number(process.env.PORT) || 10000;

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8"
      }
    });
    return { status: response.status, ok: response.ok, finalUrl: response.url, html: await response.text() };
  } finally { clearTimeout(timer); }
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function number(value) {
  if (value == null) return null;
  const s = String(value).replace(/\u00a0/g, " ").trim();
  const cleaned = s.replace(/zł|PLN/gi, "").replace(/[^0-9,.-]/g, "").replace(/,/g, ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function absUrl(value) {
  try {
    const u = new URL(String(value), TARGET_URL);
    u.hash = "";
    return u.href.replace(/\/$/, "").toLowerCase();
  } catch (_) { return ""; }
}

function extractListingUrls(html) {
  const urls = [];
  const seen = new Set();
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].replace(/\\\//g, "/");
    if (!raw.startsWith("/o/")) continue;
    const url = absUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function parseJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(m[1].trim());
      const arr = Array.isArray(data) ? data : [data];
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const offers = item.offers || item.Offers;
        const price = offers?.price ?? item.price;
        const areaRaw = item.floorSize?.value ?? item.floorSize ?? item.area;
        const area = number(areaRaw);
        const p = number(price);
        if (Number.isFinite(p) && Number.isFinite(area)) out.push({ price: p, area });
      }
    } catch (_) {}
  }
  return out;
}

function parseDetail(html) {
  const text = stripHtml(html);
  const json = parseJsonLd(html);
  const jsonGood = json.find(x => x.price >= 10000 && x.area >= 10 && x.area <= 1000);
  if (jsonGood) return jsonGood;

  const areaMatches = [...text.matchAll(/([0-9]+(?:[,.][0-9]+)?)\s*m(?:²|2)\b/gi)]
    .map(m => ({ area: number(m[1]), index: m.index }))
    .filter(x => x.area >= 10 && x.area <= 1000);
  const priceMatches = [...text.matchAll(/([0-9][0-9 .\u00a0]{2,})\s*(?:zł|PLN)\b/gi)]
    .map(m => ({ price: number(m[1]), index: m.index }))
    .filter(x => x.price >= 10000);

  let best = null;
  for (const p of priceMatches) {
    for (const a of areaMatches) {
      const distance = Math.abs(p.index - a.index);
      if (!best || distance < best.distance) best = { price: p.price, area: a.area, distance };
    }
  }
  return best ? { price: best.price, area: best.area } : null;
}

async function parseListing(url) {
  try {
    const response = await fetchHtml(url);
    if (!response.ok) return null;
    const data = parseDetail(response.html);
    if (!data) return null;
    return {
      source: "Adresowo",
      type: "mieszkanie",
      locality: "Olsztyn",
      street: "",
      title: "",
      price: data.price,
      area: data.area,
      priceM2: data.price / data.area,
      url
    };
  } catch (_) { return null; }
}

function dedupe(rows) {
  const urls = new Set();
  const keys = new Set();
  const unique = [];
  const duplicates = [];
  for (const r of rows) {
    const u = r.url;
    const k = `${r.price}|${r.area}`;
    if ((u && urls.has(u)) || keys.has(k)) { duplicates.push(r); continue; }
    if (u) urls.add(u);
    keys.add(k);
    unique.push(r);
  }
  return { unique, duplicates };
}

async function searchAdresowo({ areaTarget = 62, tolerance = 10 } = {}) {
  const listingResponse = await fetchHtml(TARGET_URL);
  const urls = extractListingUrls(listingResponse.html);
  const parsed = (await Promise.all(urls.map(parseListing))).filter(Boolean);
  const minArea = areaTarget * (1 - tolerance / 100);
  const maxArea = areaTarget * (1 + tolerance / 100);
  const filtered = parsed.filter(o => o.area >= minArea && o.area <= maxArea);
  const d = dedupe(filtered);

  return {
    portal: "Adresowo",
    sourceUrl: TARGET_URL,
    httpStatus: listingResponse.status,
    fetched: listingResponse.ok,
    htmlLength: listingResponse.html.length,
    listingUrls: urls.length,
    recognized: parsed.length,
    complete: parsed.length,
    filtered: filtered.length,
    unique: d.unique.length,
    duplicates: d.duplicates.length,
    offers: d.unique
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (u.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, portal: "Adresowo" }));
    }
    if (u.pathname === "/api/adresowo") {
      const areaTarget = Number(u.searchParams.get("area") || 62);
      const tolerance = Number(u.searchParams.get("tolerance") || 10);
      const result = await searchAdresowo({ areaTarget, tolerance });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(result));
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ service: "Adresowo parser v0.5", status: "ok" }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ADRESOWO_SERVER_LISTENING port=${PORT}`);
  searchAdresowo({ areaTarget: 62, tolerance: 10 })
    .then(r => console.log("ADRESOWO_SELFTEST " + JSON.stringify({ httpStatus: r.httpStatus, fetched: r.fetched, htmlLength: r.htmlLength, listingUrls: r.listingUrls, recognized: r.recognized, complete: r.complete, filtered: r.filtered, unique: r.unique, duplicates: r.duplicates, offers: r.offers })))
    .catch(e => console.error("ADRESOWO_SELFTEST_ERROR " + e.message));
});
