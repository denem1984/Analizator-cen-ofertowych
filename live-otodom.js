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
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Timeout Otodom')));
    req.on('error', reject);
  });
}

function slugify(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/ł/g, 'l').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseNextData(html) {
  const m = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function absoluteUrl(value, sourceUrl) {
  try { return new URL(value, sourceUrl).href; } catch { return ''; }
}

function numberFrom(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return NaN;
  const s = value.replace(/\s/g, '').replace(/zł|PLN/gi, '');
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  if (/^\d+(?:,\d+)?$/.test(s)) return Number(s.replace(',', '.'));
  return NaN;
}

function pickNumber(obj, keys, depth = 0) {
  if (!obj || depth > 3 || typeof obj !== 'object') return NaN;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const direct = numberFrom(obj[key]);
      if (Number.isFinite(direct)) return direct;
      if (obj[key] && typeof obj[key] === 'object') {
        const nested = pickNumber(obj[key], ['value', 'amount', 'raw', 'displayValue'], depth + 1);
        if (Number.isFinite(nested)) return nested;
      }
    }
  }
  return NaN;
}

function pickString(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of keys) if (typeof obj[key] === 'string' && obj[key].trim()) return cleanText(obj[key]);
  return '';
}

function addCandidate(offers, seen, obj, sourceUrl) {
  if (!obj || typeof obj !== 'object') return false;
  const rawUrl = pickString(obj, ['url', 'link', 'href', 'detailUrl']);
  if (!rawUrl || !/\/pl\/oferta\//i.test(rawUrl)) return false;
  const url = absoluteUrl(rawUrl, sourceUrl);
  if (!url || seen.has(url)) return false;

  const price = pickNumber(obj, ['priceAmount', 'totalPrice', 'price', 'amount']);
  const area = pickNumber(obj, ['areaInSquareMeters', 'areaSqm', 'livingArea', 'area']);
  const title = pickString(obj, ['title', 'name', 'shortDescription', 'description']);

  if (!Number.isFinite(price) || !Number.isFinite(area)) return false;
  seen.add(url);
  offers.push({ portal: PORTAL, url, title, price, area });
  return true;
}

function walkNextData(node, offers, seen, sourceUrl, depth = 0) {
  if (!node || depth > 18) return;
  if (Array.isArray(node)) {
    for (const item of node) walkNextData(item, offers, seen, sourceUrl, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;

  addCandidate(offers, seen, node, sourceUrl);
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') walkNextData(value, offers, seen, sourceUrl, depth + 1);
  }
}

function parseJsonLd(html, sourceUrl, offers, seen) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      walkNextData(parsed, offers, seen, sourceUrl, 0);
    } catch {}
  }
}

function parseOffers(html, sourceUrl) {
  const offers = [];
  const seen = new Set();

  // Otodom is a Next.js application. The search page contains structured
  // listing data in __NEXT_DATA__; parse that first instead of scraping CSS.
  const nextData = parseNextData(html);
  if (nextData) walkNextData(nextData, offers, seen, sourceUrl, 0);

  // JSON-LD is a secondary structured source.
  parseJsonLd(html, sourceUrl, offers, seen);

  // Conservative HTML fallback: use only the text immediately following the
  // offer link, avoiding the broad neighbourhood window that mixed prices from
  // adjacent cards in the first version.
  const hrefRe = /href=["'](\/pl\/oferta\/[^"'#?]+)["']/gi;
  let m;
  while ((m = hrefRe.exec(html))) {
    const url = absoluteUrl(m[1], sourceUrl);
    if (!url || seen.has(url)) continue;
    const start = m.index;
    const next = hrefRe.exec(html);
    const end = next ? next.index : Math.min(html.length, start + 5000);
    if (next) hrefRe.lastIndex = next.index;
    const block = html.slice(start, end);
    const text = cleanText(block);
    const areaMatches = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*m[²2]/gi)];
    const priceMatches = [...text.matchAll(/(\d[\d\s.]*(?:,\d+)?)\s*(?:zł|PLN)/gi)];
    const area = areaMatches.length ? numberFrom(areaMatches[0][1]) : NaN;
    const price = priceMatches.length ? numberFrom(priceMatches[0][1]) : NaN;
    const titleMatch = block.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i);
    const title = titleMatch ? cleanText(titleMatch[1]) : '';
    if (Number.isFinite(price) && Number.isFinite(area)) {
      seen.add(url);
      offers.push({ portal: PORTAL, url, title, price, area });
    }
  }
  return offers;
}

function extractPagination(html) {
  const candidates = [];
  for (const re of [/[?&]page=(\d+)/g, /["']page["']\s*:\s*(\d+)/g, /["']totalPages["']\s*:\s*(\d+)/g]) {
    for (const m of html.matchAll(re)) candidates.push(Number(m[1]));
  }
  return candidates.length ? Math.max(...candidates, 1) : 1;
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
      fetched = fetched || response.status >= 200 && response.status < 400;
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
