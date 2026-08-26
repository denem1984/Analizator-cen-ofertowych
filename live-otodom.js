const https = require('https');
const { URL } = require('url');

const PORTAL = 'Otodom';
const BASE = 'https://www.otodom.pl';

function httpGet(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.7'
      }
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body, finalUrl: url }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Timeout Otodom'));
    req.on('error', reject);
  });
}

function slugify(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/ł/g, 'l').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildUrl(location, minArea, maxArea, page = 1) {
  const city = slugify(location);
  const path = `/pl/wyniki/sprzedaz/mieszkanie/warminsko--mazurskie/${city}/${city}/${city}`;
  const u = new URL(BASE + path);
  u.searchParams.set('areaMin', String(Math.floor(minArea)));
  u.searchParams.set('areaMax', String(Math.ceil(maxArea)));
  if (page > 1) u.searchParams.set('page', String(page));
  return u.href;
}

function cleanText(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

function numberFrom(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return NaN;
  const s = value.replace(/\s/g, '').replace(/zł|PLN/gi, '');
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  if (/^\d+(?:,\d+)?$/.test(s)) return Number(s.replace(',', '.'));
  return NaN;
}

function absoluteUrl(value, sourceUrl) {
  try { return new URL(value, sourceUrl).href; } catch { return ''; }
}

function parseOffers(html, sourceUrl) {
  const offers = [];
  const seen = new Set();

  // Otodom's result page contains the offer cards in the HTML delivered by
  // Next.js. We deliberately parse each card as the text between two offer
  // links. This avoids the broad neighbourhood scan that mixed values from
  // adjacent cards, while avoiding a full recursive walk of __NEXT_DATA__.
  const hrefRe = /href=["'](\/pl\/oferta\/[^"'#?]+)["']/gi;
  const matches = [...html.matchAll(hrefRe)];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const url = absoluteUrl(m[1], sourceUrl);
    if (!url || seen.has(url)) continue;

    const start = m.index;
    const end = i + 1 < matches.length ? matches[i + 1].index : Math.min(html.length, start + 12000);
    const block = html.slice(start, end);
    const text = cleanText(block);

    // Price is normally rendered in the card as a PLN value. Prefer the first
    // plausible property price and ignore tiny values such as room counts.
    const priceMatches = [...text.matchAll(/(\d{2,3}(?:[\s.]\d{3})+|\d{4,8})(?:,\d{1,2})?\s*(?:zł|PLN)/gi)];
    let price = NaN;
    for (const pm of priceMatches) {
      const n = numberFrom(pm[1]);
      if (Number.isFinite(n) && n >= 10000) { price = n; break; }
    }

    const areaMatches = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*m[²2]/gi)];
    let area = NaN;
    for (const am of areaMatches) {
      const n = numberFrom(am[1]);
      if (Number.isFinite(n) && n >= 10 && n <= 1000) { area = n; break; }
    }

    // Extract a clean visible title when possible; otherwise leave it empty.
    const titleMatch = block.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
    const title = titleMatch ? cleanText(titleMatch[1]) : '';

    if (Number.isFinite(price) && Number.isFinite(area)) {
      seen.add(url);
      offers.push({ portal: PORTAL, url, title, price, area });
    }
  }

  return offers;
}

function extractPagination(html) {
  const nums = [...html.matchAll(/[?&]page=(\d+)/g)].map(m => Number(m[1])).filter(Number.isFinite);
  return nums.length ? Math.max(...nums, 1) : 1;
}

async function searchOtodom({ location = 'Olsztyn', areaTarget = 62, tolerance = 10, radius = 0, maxPages = 20 } = {}) {
  const minArea = areaTarget * (1 - tolerance / 100);
  const maxArea = areaTarget * (1 + tolerance / 100);
  const pages = [];
  const all = [];
  let totalHtmlLength = 0;
  let httpStatus = 0;
  let fetched = false;
  let error = '';
  let recognized = 0;
  void radius;

  for (let page = 1; page <= maxPages; page++) {
    const url = buildUrl(location, minArea, maxArea, page);
    try {
      const response = await httpGet(url);
      httpStatus = response.status;
      totalHtmlLength += response.body.length;
      fetched = fetched || (response.status >= 200 && response.status < 400);
      const offers = parseOffers(response.body, url);
      recognized += offers.length;
      const filtered = offers.filter(o => Number.isFinite(o.area) && o.area >= minArea && o.area <= maxArea && Number.isFinite(o.price) && o.url);
      all.push(...filtered);
      pages.push({ page, url, httpStatus: response.status, htmlLength: response.body.length, recognized: offers.length, filtered: filtered.length });
      const maxAdvertisedPage = extractPagination(response.body);
      if (page >= maxAdvertisedPage || offers.length === 0) break;
    } catch (e) {
      error = String(e?.message || e);
      pages.push({ page, url, httpStatus, htmlLength: 0, recognized: 0, filtered: 0, error });
      break;
    }
  }

  const unique = [];
  const seen = new Set();
  for (const offer of all) {
    const key = String(offer.url || '').toLowerCase().replace(/\/$/, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(offer);
  }

  return {
    portal: PORTAL,
    httpStatus,
    fetched,
    htmlLength: totalHtmlLength,
    recognized,
    complete: unique.length,
    filtered: unique.length,
    requestedRadius: Number(radius) || 0,
    appliedRadius: 0,
    radiusSupported: false,
    radiusStrategy: 'Otodom URL bez parametru promienia; promień pozostawiony do warstwy wspólnej',
    pagesFetched: pages.length,
    portalAreaRange: { min: minArea, max: maxArea },
    pages,
    offers: unique,
    ...(error ? { error } : {})
  };
}

module.exports = { searchOtodom, buildUrl };
