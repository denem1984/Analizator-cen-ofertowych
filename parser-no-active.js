const { URL } = require('url');

const PORTAL = 'Nieruchomości-online';
const TIMEOUT = 25000;
const MAX_PAGES = 20;

function num(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(/\u00a0/g, ' ').replace(/\s/g, '').replace(/[^0-9,.-]/g, '');
  if (!s) return null;
  const normalized = s.includes(',') && s.includes('.')
    ? s.replace(/\./g, '').replace(',', '.')
    : s.replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function strip(v) {
  return String(v || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&sup2;|&#178;|&#xB2;/gi, '²')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function abs(v, b) {
  try {
    const u = new URL(String(v).replace(/&amp;/gi, '&'), b);
    u.hash = '';
    return u.href;
  } catch {
    return '';
  }
}

async function get(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: c.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8'
      }
    });
    return { status: r.status, finalUrl: r.url, html: await r.text() };
  } finally {
    clearTimeout(t);
  }
}

function activeOnlyHtml(html) {
  const source = String(html || '');
  const marker = /<h2\b[^>]*\bid\s*=\s*["']pie_archive["'][^>]*>/i.exec(source);
  if (marker) {
    return { html: source.slice(0, marker.index), archiveMarkerFound: true, archiveMarker: 'pie_archive' };
  }
  const heading = /<h[1-6]\b[^>]*>[\s\S]{0,500}?<span[^>]*>\s*Ogłoszenia\s+archiwalne\s*<\/span>[\s\S]{0,100}?<\/h[1-6]>/i.exec(source);
  if (heading) {
    return { html: source.slice(0, heading.index), archiveMarkerFound: true, archiveMarker: 'visible-heading' };
  }
  return { html: source, archiveMarkerFound: false, archiveMarker: null };
}

function isOfferUrl(url) {
  return /nieruchomosci-online\.pl\//i.test(url) &&
    /(?:lokal-uzytkowy|budynek-uzytkowy|lokal-handlowy|lokal-uslugowy|biuro|magazyn|hala)[^?#]*,na-sprzedaz\//i.test(url);
}

function offerLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = abs(m[1], baseUrl);
    if (!url || seen.has(url) || !isOfferUrl(url)) continue;
    seen.add(url);
    out.push({ url, label: strip(m[2]), index: m.index, end: m.index + m[0].length });
  }
  return out;
}

function parseCardContext(html, link) {
  const start = Math.max(0, link.index - 1800);
  const end = Math.min(html.length, link.index + 3500);
  return strip(html.slice(start, end));
}

function parseCardSegment(segment, baseUrl, location, minArea, maxArea, category, link) {
  const text = String(segment || '');
  const priceMatches = [...text.matchAll(/([0-9][0-9\s.,]{2,})\s*(?:zł|PLN)\b/gi)]
    .map(m => num(m[1]))
    .filter(Number.isFinite)
    .filter(p => p >= 1000);

  // Do not use \b after ²: Unicode superscript ² is not a JS \w character,
  // so a word-boundary test can fail for the normal "m²" representation.
  const areaMatches = [...text.matchAll(/([0-9]+(?:[\s][0-9]{3})*(?:[.,][0-9]+)?)\s*m\s*(?:²|2|kw\.?)(?![A-Za-z0-9])/gi)]
    .map(m => num(m[1]))
    .filter(Number.isFinite);

  const area = areaMatches.find(a => a >= minArea && a <= maxArea);
  const price = priceMatches[0];
  if (!Number.isFinite(price) || !Number.isFinite(area)) return null;

  return {
    source: PORTAL,
    type: category === 'budynek-uzytkowy' ? 'Budynek użytkowy' : 'Lokal użytkowy',
    locality: location,
    street: '',
    price,
    area,
    priceM2: price / area,
    url: link.url,
    title: link.label
  };
}

function parseActiveCards(html, baseUrl, location, minArea, maxArea, category) {
  const boundary = activeOnlyHtml(html);
  const activeHtml = boundary.html;
  const links = offerLinks(activeHtml, baseUrl);
  const rows = [];
  for (const link of links) {
    const context = parseCardContext(activeHtml, link);
    const row = parseCardSegment(context, baseUrl, location, minArea, maxArea, category, link);
    if (row) rows.push(row);
  }
  return {
    rows,
    activeHtmlLength: activeHtml.length,
    archiveMarkerFound: boundary.archiveMarkerFound,
    archiveMarker: boundary.archiveMarker,
    offerLinks: links.length
  };
}

function unique(rows) {
  const u = new Set();
  const out = [];
  for (const r of rows) {
    const key = String(r.url || '').toLowerCase();
    if (!key || u.has(key)) continue;
    u.add(key);
    out.push(r);
  }
  return out;
}

function pageUrl(base, page) {
  if (page === 1) return base;
  const u = new URL(base);
  u.searchParams.set('p', String(page));
  return u.href;
}

async function searchNieruchomosciOnline(location, minArea, maxArea) {
  if (String(location).toLowerCase() !== 'olsztyn') {
    return {
      portal: PORTAL,
      httpStatus: 0,
      fetched: false,
      htmlLength: 0,
      recognized: 0,
      complete: 0,
      offers: [],
      pagesFetched: 0,
      pages: [],
      categories: ['lokal-uzytkowy', 'budynek-uzytkowy'],
      error: 'Brak identyfikatora lokalizacji dla tej miejscowości.'
    };
  }

  const categories = ['lokal-uzytkowy', 'budynek-uzytkowy'];
  const rows = [];
  const pages = [];

  for (const category of categories) {
    const base = `https://www.nieruchomosci-online.pl/szukaj.html?3,${category},sprzedaz,,Olsztyn:18670,,,,,${Math.floor(minArea)}-${Math.ceil(maxArea)}&q=`;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = pageUrl(base, page);
      let r;
      try {
        r = await get(url);
      } catch (e) {
        pages.push({ category, page, url, httpStatus: 0, htmlLength: 0, recognized: 0, newOffers: 0, error: String(e.message || e) });
        break;
      }

      const finalUrl = r.finalUrl || url;
      if (r.status < 200 || r.status >= 400) {
        pages.push({ category, page, url: finalUrl, httpStatus: r.status, htmlLength: r.html.length, recognized: 0, newOffers: 0 });
        break;
      }

      const parsed = parseActiveCards(r.html, finalUrl, location, minArea, maxArea, category);
      const before = rows.length;
      rows.push(...parsed.rows);
      const seenBefore = new Set(rows.slice(0, before).map(x => String(x.url || '').toLowerCase()));
      const newOffers = parsed.rows.filter(x => !seenBefore.has(String(x.url || '').toLowerCase())).length;

      pages.push({
        category,
        page,
        url: finalUrl,
        httpStatus: r.status,
        htmlLength: r.html.length,
        activeHtmlLength: parsed.activeHtmlLength,
        archiveMarkerFound: parsed.archiveMarkerFound,
        archiveMarker: parsed.archiveMarker,
        offerLinks: parsed.offerLinks,
        recognized: parsed.rows.length,
        newOffers
      });

      if (parsed.archiveMarkerFound) break;
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

module.exports = { searchNieruchomosciOnline };
