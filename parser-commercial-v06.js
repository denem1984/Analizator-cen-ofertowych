const { URL } = require('url');
const base = require('./parser-commercial-v01');

const MAX_PAGES = 20;
const TIMEOUT = 25000;
const PORTAL = 'Nieruchomości-online';

function num(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(/\u00a0/g, ' ').replace(/\s/g, '').replace(/[^0-9,.-]/g, '');
  if (!s) return null;
  const normalized = s.includes(',') && s.includes('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function strip(v) {
  return String(v || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function abs(v, baseUrl) {
  try {
    const u = new URL(String(v), baseUrl);
    u.hash = '';
    return u.href;
  } catch (_) { return ''; }
}

async function get(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      redirect: 'follow', signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8'
      }
    });
    return { status: r.status, finalUrl: r.url, html: await r.text() };
  } finally { clearTimeout(timer); }
}

function offerLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = abs(m[1], baseUrl);
    if (!url || seen.has(url)) continue;
    if (!/nieruchomosci-online\.pl\//i.test(url)) continue;
    if (!/(?:lokal-uzytkowy|budynek-uzytkowy)[^/]*,na-sprzedaz\//i.test(url)) continue;
    seen.add(url);
    out.push({ url, label: strip(m[2]), index: m.index });
  }
  return out;
}

function parseNO(html, baseUrl, location, minArea, maxArea, category) {
  const rows = [];
  for (const link of offerLinks(html, baseUrl)) {
    const text = strip(html.slice(Math.max(0, link.index - 1200), Math.min(html.length, link.index + 3200)));
    // Nie pobieramy ceny jednostkowej z fragmentu typu „5 731,43 zł/m²”.
    const money = [...text.matchAll(/([0-9][0-9\s.,]{2,})\s*(?:zł|PLN)(?!\s*\/\s*m)/gi)];
    const areas = [...text.matchAll(/([0-9]+(?:[.,][0-9]+)?)\s*m\s*(?:²|2)\b/gi)];
    const price = money.length ? num(money[0][1]) : null;
    const area = areas.length ? num(areas[0][1]) : null;
    if (!Number.isFinite(price) || !Number.isFinite(area) || area < minArea || area > maxArea) continue;
    const title = category === 'budynek-uzytkowy' ? 'Budynek użytkowy' : 'Lokal użytkowy';
    rows.push({ source: PORTAL, type: title, locality: location, street: '', price, area, priceM2: price / area, url: link.url, title });
  }
  return rows;
}

function pageUrl(baseUrl, page) {
  if (page === 1) return baseUrl;
  const u = new URL(baseUrl);
  u.searchParams.set('p', String(page));
  return u.href;
}

function unique(rows) {
  const seenUrl = new Set();
  const out = [];
  for (const row of rows) {
    const url = String(row.url || '').toLowerCase();
    if (url && seenUrl.has(url)) continue;
    if (url) seenUrl.add(url);
    out.push(row);
  }
  return out;
}

async function searchNieruchomosciOnline(location, minArea, maxArea) {
  if (String(location).trim().toLowerCase() !== 'olsztyn') {
    return {
      portal: PORTAL, httpStatus: 0, fetched: false, htmlLength: 0,
      recognized: 0, complete: 0, offers: [], pagesFetched: 0, pages: [],
      categories: ['lokal-uzytkowy', 'budynek-uzytkowy'], requestedRadius: 0,
      appliedRadius: 0, radiusSupported: false,
      error: 'Parser N-O v08 obsługuje obecnie lokalizację Olsztyn.'
    };
  }

  // Aktualne adresy kategorii N-O. Poprzednia wersja używała starego
  // endpointu /szukaj.html, który nie zwracał właściwej listy ofert.
  const categories = [
    { key: 'lokal-uzytkowy', url: 'https://olsztyn.nieruchomosci-online.pl/lokale-uzytkowe,sprzedaz/' },
    { key: 'budynek-uzytkowy', url: 'https://olsztyn.nieruchomosci-online.pl/budynki-uzytkowe,sprzedaz/' }
  ];
  const rows = [];
  const pages = [];

  for (const category of categories) {
    let previousUrls = new Set();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = pageUrl(category.url, page);
      let result;
      try {
        result = await get(url);
      } catch (e) {
        pages.push({ category: category.key, page, url, httpStatus: 0, htmlLength: 0, recognized: 0, newOffers: 0, error: String(e.message || e) });
        break;
      }
      const finalUrl = result.finalUrl || url;
      if (result.status < 200 || result.status >= 400) {
        pages.push({ category: category.key, page, url: finalUrl, httpStatus: result.status, htmlLength: result.html.length, recognized: 0, newOffers: 0 });
        break;
      }

      const parsed = parseNO(result.html, finalUrl, location, minArea, maxArea, category.key);
      const currentUrls = new Set(offerLinks(result.html, finalUrl).map(x => x.url.toLowerCase()));
      const newPageUrls = [...currentUrls].filter(u => !previousUrls.has(u));
      rows.push(...parsed);
      pages.push({ category: category.key, page, url: finalUrl, httpStatus: result.status, htmlLength: result.html.length, recognized: parsed.length, newOffers: newPageUrls.length });
      previousUrls = currentUrls;
      if (newPageUrls.length === 0 || currentUrls.size === 0) break;
    }
  }

  const offers = unique(rows);
  return {
    portal: PORTAL,
    httpStatus: pages[0]?.httpStatus || 0,
    fetched: pages.some(p => p.httpStatus >= 200 && p.httpStatus < 400),
    htmlLength: pages.reduce((n, p) => n + p.htmlLength, 0),
    recognized: rows.length,
    complete: offers.length,
    offers,
    pagesFetched: pages.length,
    pages,
    categories: categories.map(c => c.key),
    requestedRadius: 0,
    appliedRadius: 0,
    radiusSupported: false
  };
}

async function searchCommercial(options = {}) {
  const result = await base.searchCommercial(options);
  const area = Number(options.area ?? 62);
  const tolerance = Number(options.tolerance ?? 10);
  const minArea = area * (1 - tolerance / 100);
  const maxArea = area * (1 + tolerance / 100);
  const location = options.location || 'Olsztyn';
  const fixedNO = await searchNieruchomosciOnline(location, minArea, maxArea);
  return result.map(item => item.portal === PORTAL ? {
    ...fixedNO,
    requestedRadius: Number(options.radius) || 0,
    appliedRadius: 0,
    radiusSupported: false
  } : item);
}

module.exports = { searchCommercial };
