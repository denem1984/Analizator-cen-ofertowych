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
    return { status: r.status, ok: r.ok, finalUrl: r.url, html: await r.text() };
  } finally { clearTimeout(timer); }
}

function offerLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = abs(m[1], baseUrl);
    if (!url || seen.has(url)) continue;
    if (!/nieruchomosci-online\.pl\/.*(?:na-sprzedaz|na-wynajem)/i.test(url) &&
        !/nieruchomosci-online\.pl\/[^/]+,na-sprzedaz\//i.test(url)) continue;
    seen.add(url);
    out.push({ url, label: strip(m[2]), index: m.index });
  }
  return out;
}

function parseNO(html, baseUrl, location, minArea, maxArea, category) {
  const rows = [];
  for (const link of offerLinks(html, baseUrl)) {
    const text = strip(html.slice(Math.max(0, link.index - 1500), Math.min(html.length, link.index + 3000)));
    const priceMatch = text.match(/([0-9][0-9\s.,]{2,})\s*(?:zł|PLN)\b/i);
    const areaMatch = text.match(/([0-9]+(?:[.,][0-9]+)?)\s*m\s*(?:²|2)\b/i);
    const price = priceMatch ? num(priceMatch[1]) : null;
    const area = areaMatch ? num(areaMatch[1]) : null;
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
  const seenData = new Set();
  const out = [];
  for (const row of rows) {
    const url = String(row.url || '').toLowerCase();
    const data = `${row.price}|${row.area}`;
    if ((url && seenUrl.has(url)) || seenData.has(data)) continue;
    if (url) seenUrl.add(url);
    seenData.add(data);
    out.push(row);
  }
  return out;
}

async function searchNieruchomosciOnline(location, minArea, maxArea) {
  if (String(location).toLowerCase() !== 'olsztyn') {
    return {
      portal: PORTAL, httpStatus: 0, fetched: false, htmlLength: 0,
      recognized: 0, complete: 0, offers: [], pagesFetched: 0, pages: [],
      categories: ['lokal-uzytkowy', 'budynek-uzytkowy'], requestedRadius: 0,
      appliedRadius: 0, radiusSupported: false,
      error: 'Brak identyfikatora lokalizacji dla tej miejscowości.'
    };
  }

  const categories = ['lokal-uzytkowy', 'budynek-uzytkowy'];
  const rows = [];
  const pages = [];

  for (const category of categories) {
    const baseUrl = `https://www.nieruchomosci-online.pl/szukaj.html?3,${category},sprzedaz,,Olsztyn:18670,,,,,${Math.floor(minArea)}-${Math.ceil(maxArea)}&q=`;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = pageUrl(baseUrl, page);
      let result;
      try {
        result = await get(url);
      } catch (e) {
        pages.push({ category, page, url, httpStatus: 0, htmlLength: 0, recognized: 0, newOffers: 0, error: String(e.message || e) });
        break;
      }

      const finalUrl = result.finalUrl || url;
      if (result.status < 200 || result.status >= 400) {
        pages.push({ category, page, url: finalUrl, httpStatus: result.status, htmlLength: result.html.length, recognized: 0, newOffers: 0 });
        break;
      }

      const parsed = parseNO(result.html, finalUrl, location, minArea, maxArea, category);
      const before = rows.length;
      rows.push(...parsed);
      const pageUnique = unique(parsed);
      const existingKeys = new Set(rows.slice(0, before).map(o => `${o.url}|${o.price}|${o.area}`));
      const newOffers = pageUnique.filter(o => !existingKeys.has(`${o.url}|${o.price}|${o.area}`)).length;
      pages.push({ category, page, url: finalUrl, httpStatus: result.status, htmlLength: result.html.length, recognized: parsed.length, newOffers });
      if (newOffers === 0) break;
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
    categories,
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
  const fixed = result.map(item => item.portal === PORTAL ? {
    ...fixedNO,
    requestedRadius: Number(options.radius) || 0,
    appliedRadius: 0,
    radiusSupported: false
  } : item);
  return fixed;
}

module.exports = { searchCommercial };
