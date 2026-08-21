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
  } finally {
    clearTimeout(timer);
  }
}

function jsonLd(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { out.push(JSON.parse(m[1].trim())); } catch (_) {}
  }
  return out;
}

function flatten(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) { value.forEach(v => flatten(v, out)); return out; }
  out.push(value);
  Object.values(value).forEach(v => flatten(v, out));
  return out;
}

function number(value) {
  if (value == null) return null;
  if (typeof value === "object") value = value.value ?? value.minValue ?? value.maxValue ?? value.price;
  const n = Number(String(value).replace(/\s/g, "").replace(/zł|PLN/gi, "").replace(/[^0-9,.-]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function area(value) {
  if (value == null) return null;
  if (typeof value === "object") value = value.value ?? value.minValue ?? value.maxValue;
  const s = String(value);
  const m = s.match(/([0-9]+(?:[.,][0-9]+)?)\s*m(?:²|2|kw|kw\.)?/i);
  return m ? number(m[1]) : number(value);
}

function absUrl(value, base = TARGET_URL) {
  try {
    const u = new URL(String(value), base);
    u.hash = "";
    [...u.searchParams.keys()].forEach(k => { if (/utm_|fbclid|gclid/i.test(k)) u.searchParams.delete(k); });
    return u.href.replace(/\/$/, "").toLowerCase();
  } catch (_) { return ""; }
}

function addressOf(value) {
  if (!value) return { locality: "", street: "" };
  if (typeof value === "string") return { locality: value, street: "" };
  return {
    locality: value.addressLocality || value.locality || value.city || "",
    street: value.streetAddress || value.street || value.addressLine || ""
  };
}

function findFirst(obj, keys) {
  const wanted = new Set(keys);
  for (const x of flatten(obj)) {
    for (const k of Object.keys(x)) {
      if (wanted.has(k) && x[k] != null) return x[k];
    }
  }
  return null;
}

function extractFromJsonLd(roots) {
  const rows = [];
  for (const obj of roots.flatMap(x => flatten(x))) {
    const types = Array.isArray(obj["@type"]) ? obj["@type"] : [obj["@type"]];
    const isOffer = types.includes("Offer") || types.includes("Product") || types.includes("RealEstateListing") || obj.itemOffered;
    if (!isOffer) continue;

    const variants = obj.offers ? (Array.isArray(obj.offers) ? obj.offers : [obj.offers]) : [obj];
    for (const offer of variants) {
      const item = offer.itemOffered && typeof offer.itemOffered === "object" ? offer.itemOffered : obj.itemOffered || obj;
      const price = number(offer.price ?? offer.priceSpecification?.price ?? offer.lowPrice ?? findFirst(offer, ["price", "lowPrice"]) ?? findFirst(item, ["price", "lowPrice"]));
      const ar = area(findFirst(item, ["floorSize", "area", "size"]) ?? findFirst(obj, ["floorSize", "area", "size"]));
      const url = absUrl(offer.url || item.url || obj.url);
      const address = addressOf(item.address || obj.address || findFirst(item, ["address"]));
      if (price == null || ar == null || !url) continue;
      rows.push({ source: "Adresowo", type: "mieszkanie", locality: String(address.locality || "").trim(), street: String(address.street || "").trim(), price, area: ar, priceM2: price / ar, url });
    }
  }
  return rows;
}

function extractVisible(html) {
  const rows = [];
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const blocks = text.split(/<(?:article|li|div)[^>]*>/i);
  for (const block of blocks) {
    const clean = block.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
    if (!/Olsztyn/i.test(clean) || !/m²|m2/i.test(clean) || !/(?:zł|PLN)/i.test(clean)) continue;
    const priceMatch = clean.match(/([0-9][0-9\s.]*)\s*(?:zł|PLN)\b/i);
    const areaMatch = clean.match(/([0-9]+(?:[.,][0-9]+)?)\s*m(?:²|2)\b/i);
    const hrefMatch = block.match(/href=["']([^"']+)["']/i);
    if (!priceMatch || !areaMatch || !hrefMatch) continue;
    const price = number(priceMatch[1]);
    const ar = number(areaMatch[1]);
    const url = absUrl(hrefMatch[1]);
    if (!price || !ar || !url) continue;
    rows.push({ source: "Adresowo", type: "mieszkanie", locality: "Olsztyn", street: "", price, area: ar, priceM2: price / ar, url });
  }
  return rows;
}

function dedupe(rows) {
  const urls = new Set(), keys = new Set(), unique = [], duplicates = [];
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
  const response = await fetchHtml(TARGET_URL);
  const roots = jsonLd(response.html);
  const recognized = extractFromJsonLd(roots);
  const visible = extractVisible(response.html);
  const combined = [...recognized, ...visible];
  const seen = new Set();
  const parsed = combined.filter(o => {
    const key = `${o.url}|${o.price}|${o.area}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const complete = parsed.filter(o => o.locality && Number.isFinite(o.price) && Number.isFinite(o.area) && o.url);
  const minArea = areaTarget * (1 - tolerance / 100);
  const maxArea = areaTarget * (1 + tolerance / 100);
  const filtered = complete.filter(o => o.area >= minArea && o.area <= maxArea);
  const d = dedupe(filtered);
  return {
    portal: "Adresowo",
    sourceUrl: TARGET_URL,
    httpStatus: response.status,
    fetched: response.ok,
    htmlLength: response.html.length,
    recognized: parsed.length,
    complete: complete.length,
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
    res.end(JSON.stringify({ service: "Adresowo parser v0.5", status: "ok", endpoints: ["/health", "/api/adresowo?area=62&tolerance=10"] }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ADRESOWO_SERVER_LISTENING port=${PORT}`);
  searchAdresowo({ areaTarget: 62, tolerance: 10 })
    .then(r => console.log("ADRESOWO_SELFTEST " + JSON.stringify({ httpStatus: r.httpStatus, fetched: r.fetched, htmlLength: r.htmlLength, recognized: r.recognized, complete: r.complete, filtered: r.filtered, unique: r.unique, duplicates: r.duplicates })))
    .catch(e => console.error("ADRESOWO_SELFTEST_ERROR " + e.message));
});
