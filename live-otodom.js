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
      res.on('end', () => resolve({ status: res.statusCode || 0, body, finalUrl: res.headers.location || url }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Timeout Otodom')));
    req.on('error', reject);
  });
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim()
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, '-')
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
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function parseJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) out.push(...parsed); else out.push(parsed);
    } catch {}
  }
  return out;
}

function parseOffers(html, sourceUrl) {
  const offers = [];
  const seen = new Set();
  const ld = parseJsonLd(html);

  for (const item of ld) {
    const list = Array.isArray(item.itemListElement) ? item.itemListElement : [];
    for (const entry of list) {
      const obj = entry?.item || entry;
      const url = obj?.url;
      if (!url) continue;
      const name = obj.name || '';
      const image = obj.image || '';
      const offersText = `${name} ${obj.description || ''}`;
      const areaMatch = offersText.match(/(\d+(?:[.,]\d+)?)\s*m[²2]/i);
      const priceMatch = offersText.match(/(\d[\d\s.,]*)\s*(?:zł|PLN)/i);
      const area = areaMatch ? Number(areaMatch[1].replace(',', '.')) : NaN;
      const price = priceMatch ? Number(priceMatch[1].replace(/\s/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.')) : NaN;
      const absolute = new URL(url, sourceUrl).href;
      if (!seen.has(absolute)) {
        seen.add(absolute);
        offers.push({ portal: PORTAL, url: absolute, title: cleanText(name), price, area, image });
      }
    }
  }

  // Otodom embeds listing-card data in JSON/HTML. This fallback deliberately
  // targets offer URLs first and extracts nearby text rather than depending on
  // volatile CSS class names.
  const hrefRe = /href=["'](\/pl\/oferta\/[^"'#?]+)["']/gi;
  let m;
  while ((m = hrefRe.exec(html))) {
    const absolute = new URL(m[1], sourceUrl).href;
    if (seen.has(absolute)) continue;
    const start = Math.max(0, m.index - 2500);
    const end = Math.min(html.length, m.index + 5000);
    const block = decodeHtml(cleanText(html.slice(start, end)));
    const areaMatches = [...block.matchAll(/(\d+(?:[.,]\d+)?)\s*m[²2]/gi)];
    const priceMatches = [...block.matchAll(/(\d[\d\s.,]*)\s*(?:zł|PLN)/gi)];
    const area = areaMatches.length ? Number(areaMatches[0][1].replace(',', '.')) : NaN;
    let price = NaN;
    if (priceMatches.length) {
      const raw = priceMatches[0][1].replace(/\s/g, '');
      const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/\.(?=\d{3}(?:\D|$))/g, '');
      price = Number(normalized);
    }
    const title = block.slice(0, 300).trim();
    seen.add(absolute);
    offers.push({ portal: PORTAL, url: absolute, title, price, area });
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

  // Otodom URL does not currently encode our radius concept; keep it explicit
  // in diagnostics and let the Combined API apply cross-portal radius rules.
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
