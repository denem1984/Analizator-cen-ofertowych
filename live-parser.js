const { URL } = require("url");

const PORTAL = "Nieruchomości-online";
const DEFAULT_BASE = "https://olsztyn.nieruchomosci-online.pl/";

function asNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^0-9.\-]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function absUrl(href, base = DEFAULT_BASE) {
  if (!href) return "";
  try { return new URL(href, base).href; }
  catch { return ""; }
}

function makeOffer(source, locality, street, price, area, url, type = "Lokal mieszkalny", title = "") {
  locality = String(locality || "").trim();
  street = String(street || "").trim();
  return {
    source,
    type,
    locality,
    street,
    location: locality ? (street ? `${locality}, ${street}` : locality) : "",
    url: String(url || ""),
    price,
    area,
    priceM2: price != null && area != null && area > 0 ? price / area : null,
    title
  };
}

function walkOffers(x, out) {
  if (Array.isArray(x)) return x.forEach(v => walkOffers(v, out));
  if (!x || typeof x !== "object") return;
  const t = x["@type"];
  if (t === "Offer" || (Array.isArray(t) && t.includes("Offer"))) out.push(x);
  Object.values(x).forEach(v => walkOffers(v, out));
}

function parseJsonLd(html) {
  const offers = [];
  const scripts = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const obj = JSON.parse(m[1].trim());
      scripts.push(obj);
      walkOffers(obj, offers);
    } catch (_) {}
  }
  return { offers, scripts };
}

function parseNieruchomosciOnline(html, base = DEFAULT_BASE) {
  const parsed = parseJsonLd(html);
  const rows = [];

  for (const o of parsed.offers) {
    const item = o.itemOffered || {};
    const addr = item.address || {};
    const fs = item.floorSize || {};
    const price = asNumber(o.price);
    const area = asNumber(fs.value);
    const url = absUrl(o.url, base);
    const locality = addr.addressLocality || "";
    const street = addr.streetAddress || "";

    rows.push(makeOffer(
      PORTAL,
      locality,
      street,
      price,
      area,
      url,
      "Lokal mieszkalny",
      o.name || ""
    ));
  }

  return {
    source: PORTAL,
    recognized: parsed.offers.length,
    offers: rows
  };
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

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

    const html = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      finalUrl: response.url,
      html
    };
  } finally {
    clearTimeout(timer);
  }
}

async function searchNieruchomosciOnline({ location = "Olsztyn", path = "/mieszkania/sprzedaz/" } = {}) {
  const base = `https://olsztyn.nieruchomosci-online.pl${path}`;
  const url = new URL(base);
  const result = await fetchHtml(url.href);
  const parsed = parseNieruchomosciOnline(result.html, result.finalUrl || url.href);

  return {
    portal: PORTAL,
    requestedLocation: location,
    url: result.finalUrl || url.href,
    httpStatus: result.status,
    fetched: result.ok,
    htmlLength: result.html.length,
    recognized: parsed.recognized,
    complete: parsed.offers.filter(o => o.locality && o.price != null && o.area != null && o.url).length,
    offers: parsed.offers
  };
}

module.exports = {
  PORTAL,
  parseNieruchomosciOnline,
  fetchHtml,
  searchNieruchomosciOnline
};
