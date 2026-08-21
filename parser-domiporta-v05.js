const https = require("https");
const { URL } = require("url");

const TARGET_URL = "https://www.domiporta.pl/mieszkanie/sprzedam/warminsko-mazurskie/olsztyn";

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/139 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8"
      }
    }, res => {
      let html = "";
      res.setEncoding("utf8");
      res.on("data", chunk => html += chunk);
      res.on("end", () => resolve({ status: res.statusCode, html, finalUrl: res.headers.location || url }));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("timeout")));
  });
}

function parseJsonLd(html) {
  const scripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const roots = [];
  for (const match of scripts) {
    try { roots.push(JSON.parse(match[1].trim())); } catch (_) {}
  }
  return roots;
}

function flatten(x) {
  const out = [];
  const walk = value => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(walk);
    out.push(value);
    Object.values(value).forEach(walk);
  };
  walk(x);
  return out;
}

function number(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s/g, "").replace(/zł/gi, "").replace(/[^0-9,.-]/g, "").replace(",", ".");
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function area(value) {
  if (value == null) return null;
  const text = String(value);
  const m = text.match(/([0-9]+(?:[.,][0-9]+)?)\s*m(?:²|2|kw)/i);
  return m ? number(m[1]) : number(text);
}

function url(value) {
  try {
    const u = new URL(String(value), TARGET_URL);
    u.hash = "";
    [...u.searchParams.keys()].forEach(k => {
      if (/utm_|fbclid|gclid/i.test(k)) u.searchParams.delete(k);
    });
    return u.href.replace(/\/$/, "").toLowerCase();
  } catch (_) { return String(value || "").trim().toLowerCase(); }
}

function addressOf(item) {
  const a = item?.address;
  if (typeof a === "string") return { locality: a, street: "" };
  if (a && typeof a === "object") return {
    locality: a.addressLocality || "",
    street: a.streetAddress || ""
  };
  return { locality: "", street: "" };
}

function parseOffer(offer, parent) {
  const source = offer || {};
  const item = source.itemOffered || source.item || parent?.item || parent || {};
  const price = number(source.price ?? source.priceSpecification?.price ?? item.price);
  const areaValue = area(item.floorSize?.value ?? item.floorSize ?? item.area ?? item.description);
  const offerUrl = url(source.url || item.url || parent?.url || "");
  const address = addressOf(item);
  if (!Number.isFinite(price) || !Number.isFinite(areaValue) || !offerUrl) return null;
  return {
    source: "Domiporta",
    type: "mieszkanie",
    locality: address.locality,
    street: address.street,
    price,
    area: areaValue,
    priceM2: price / areaValue,
    url: offerUrl
  };
}

function extract(root) {
  const objects = flatten(root);
  const rows = [];
  for (const obj of objects) {
    const type = obj["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (!types.includes("ListItem")) continue;
    const item = obj.item || {};
    const itemObjects = flatten(item);
    const offers = [];
    for (const candidate of itemObjects) {
      const candidateTypes = Array.isArray(candidate["@type"]) ? candidate["@type"] : [candidate["@type"]];
      if (candidateTypes.includes("Offer")) offers.push(candidate);
    }
    for (const offer of offers) {
      const row = parseOffer(offer, item);
      if (row) rows.push(row);
    }
  }
  return rows;
}

function dedupe(rows) {
  const seenUrl = new Set();
  const seenData = new Set();
  const unique = [];
  const duplicates = [];
  for (const row of rows) {
    const u = row.url;
    const d = `${row.price}|${row.area}`;
    if ((u && seenUrl.has(u)) || seenData.has(d)) {
      duplicates.push(row);
      continue;
    }
    if (u) seenUrl.add(u);
    seenData.add(d);
    unique.push(row);
  }
  return { unique, duplicates };
}

async function searchDomiporta({ areaTarget = 62, tolerance = 10 } = {}) {
  const response = await fetchHtml(TARGET_URL);
  const roots = parseJsonLd(response.html);
  const recognized = extract(roots);
  const complete = recognized.filter(o => o.locality && Number.isFinite(o.price) && Number.isFinite(o.area) && o.url);
  const minArea = areaTarget * (1 - tolerance / 100);
  const maxArea = areaTarget * (1 + tolerance / 100);
  const filtered = complete.filter(o => o.area >= minArea && o.area <= maxArea);
  const d = dedupe(filtered);
  return {
    portal: "Domiporta",
    sourceUrl: TARGET_URL,
    httpStatus: response.status,
    fetched: response.status >= 200 && response.status < 400,
    htmlLength: response.html.length,
    recognized: recognized.length,
    complete: complete.length,
    filtered: filtered.length,
    unique: d.unique.length,
    duplicates: d.duplicates.length,
    offers: d.unique
  };
}

module.exports = { searchDomiporta };
