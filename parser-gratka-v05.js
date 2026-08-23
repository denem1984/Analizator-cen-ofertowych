const https = require('https');
const http = require('http');
const { URL } = require('url');

const MAX_PAGES = 50;
const FETCH_TIMEOUT_MS = 30000;

function slugLocation(location = 'Olsztyn') {
  return String(location).trim().toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function targetUrl(location = 'Olsztyn', areaTarget = 62, tolerance = 10) {
  const url = new URL(`https://gratka.pl/nieruchomosci/mieszkania/${slugLocation(location)}`);
  const minArea = areaTarget * (1 - tolerance / 100);
  const maxArea = areaTarget * (1 + tolerance / 100);
  if (Number.isFinite(minArea) && Number.isFinite(maxArea)) {
    url.searchParams.set('powierzchnia-w-m2:max', String(Math.round(maxArea)));
    url.searchParams.set('powierzchnia-w-m2:min', String(Math.floor(minArea)));
  }
  return url.href;
}

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/139 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8'
      }
    }, res => {
      let html = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { html += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        html,
        finalUrl: res.headers.location || url
      }));
    });
    req.on('error', reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
  });
}

function jsonLd(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try { out.push(JSON.parse(m[1].trim())); } catch (_) {}
  }
  return out;
}

function flatten(value) {
  const out = [];
  const walk = v => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(walk);
    out.push(v);
    Object.values(v).forEach(walk);
  };
  walk(value);
  return out;
}

function findFirst(root, keys) {
  const wanted = new Set(keys);
  let found = null;
  const walk = v => {
    if (found !== null || v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(walk);
    for (const key of Object.keys(v)) {
      if (wanted.has(key) && v[key] != null) {
        found = v[key];
        return;
      }
    }
    Object.values(v).forEach(walk);
  };
  walk(root);
  return found;
}

function num(value) {
  if (value == null) return null;
  if (typeof value === 'object') value = value.value ?? value.lowPrice ?? value.price;
  const n = Number(String(value).replace(/\s/g, '').replace(/zł/gi, '')
    .replace(/[^0-9,.-]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function areaNum(value) {
  if (value == null) return null;
  if (typeof value === 'object') value = value.value ?? value.minValue ?? value.maxValue;
  const text = String(value);
  const match = text.match(/([0-9]+(?:[.,][0-9]+)?)\s*m(?:²|2|kw)?/i);
  return match ? num(match[1]) : num(value);
}

function normalizeUrl(value, base) {
  try {
    const u = new URL(String(value), base);
    u.hash = '';
    [...u.searchParams.keys()].forEach(k => {
      if (/utm_|fbclid|gclid/i.test(k)) u.searchParams.delete(k);
    });
    return u.href.replace(/\/$/, '').toLowerCase();
  } catch (_) {
    return String(value || '').trim().toLowerCase();
  }
}

function absoluteUrl(href, base) {
  if (!href) return null;
  try { return new URL(href, base).href; } catch (_) { return null; }
}

function address(value) {
  const a = value && typeof value === 'object' ? value : {};
  return {
    locality: a.addressLocality || a.locality || a.city || '',
    street: a.streetAddress || a.street || a.addressLine || ''
  };
}

function offerVariants(product) {
  const offers = product?.offers;
  if (!offers) return [];
  if (Array.isArray(offers)) {
    return offers.flatMap(x => x?.offers
      ? (Array.isArray(x.offers) ? x.offers : [x.offers])
      : [x]);
  }
  if (offers.offers) return Array.isArray(offers.offers) ? offers.offers : [offers.offers];
  return [offers];
}

function parseProduct(product, offer, base) {
  const offered = offer?.itemOffered && typeof offer.itemOffered === 'object'
    ? offer.itemOffered : {};
  const price = num(
    offer?.price ?? offer?.priceSpecification?.price ?? offer?.lowPrice ??
    findFirst(offer, ['price', 'lowPrice']) ??
    findFirst(product, ['price', 'lowPrice', 'highPrice'])
  );
  const area = areaNum(
    findFirst(offered, ['floorSize', 'area', 'size']) ??
    findFirst(product, ['floorSize', 'area', 'size'])
  );
  const url = normalizeUrl(
    offer?.url || findFirst(offered, ['url']) || product.url || findFirst(product, ['url']),
    base
  );
  const addr = address(
    offered.address || findFirst(offered, ['address']) ||
    product.address || findFirst(product, ['address'])
  );
  if (price == null || area == null || !url) return null;
  return {
    source: 'Gratka', type: 'mieszkanie', locality: addr.locality,
    street: addr.street, price, area, priceM2: price / area, url
  };
}

function extract(roots, base) {
  const rows = [];
  for (const root of roots) {
    for (const obj of flatten(root)) {
      const types = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']];
      if (!types.includes('Product')) continue;
      for (const offer of offerVariants(obj)) {
        const row = parseProduct(obj, offer, base);
        if (row) rows.push(row);
      }
    }
  }
  return rows;
}

function dedupe(rows) {
  const urls = new Set();
  const keys = new Set();
  const unique = [];
  const duplicates = [];
  for (const row of rows) {
    const urlKey = row.url;
    const dataKey = `${row.price}|${row.area}`;
    if ((urlKey && urls.has(urlKey)) || keys.has(dataKey)) {
      duplicates.push(row);
      continue;
    }
    if (urlKey) urls.add(urlKey);
    keys.add(dataKey);
    unique.push(row);
  }
  return { unique, duplicates };
}

function pageNumber(url) {
  try {
    const n = Number(new URL(url).searchParams.get('page') || 1);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
  } catch (_) {
    return 1;
  }
}

function nextPageFromHtml(html, baseUrl, currentPage) {
  const links = [...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)];
  for (const match of links) {
    const url = absoluteUrl(match[1], baseUrl);
    if (url && pageNumber(url) === currentPage + 1) return url;
  }

  const relNext = [
    ...html.matchAll(/<a\b[^>]*\brel\s*=\s*["']next["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi),
    ...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*\brel\s*=\s*["']next["'][^>]*>/gi)
  ];
  for (const match of relNext) {
    const url = absoluteUrl(match[1], baseUrl);
    if (url && pageNumber(url) === currentPage + 1) return url;
  }
  return null;
}

async function searchGratka({ location = 'Olsztyn', areaTarget = 62, tolerance = 10, radius = 0 } = {}) {
  // Gratka nie obsługuje promienia. Filtr powierzchni przekazujemy bezpośrednio
  // do portalu, zachowując dokładny format używany przez jego URL-e.
  const sourceUrl = targetUrl(location, areaTarget, tolerance);
  let currentUrl = sourceUrl;
  let pagesFetched = 0;
  let totalHtmlLength = 0;
  let totalRecognized = 0;
  let firstStatus = 0;
  const allRows = [];
  const seenPages = new Set();

  while (currentUrl && pagesFetched < MAX_PAGES) {
    const normalizedPageUrl = normalizeUrl(currentUrl, currentUrl);
    if (!normalizedPageUrl || seenPages.has(normalizedPageUrl)) break;
    seenPages.add(normalizedPageUrl);

    const response = await fetchHtml(currentUrl);
    pagesFetched++;
    if (!firstStatus) firstStatus = Number(response.status) || 0;
    totalHtmlLength += response.html.length;

    if (!(response.status >= 200 && response.status < 400)) break;

    const baseUrl = response.finalUrl || currentUrl;
    const rows = extract(jsonLd(response.html), baseUrl);
    totalRecognized += rows.length;
    allRows.push(...rows);

    if (rows.length === 0) break;

    const next = nextPageFromHtml(response.html, baseUrl, pageNumber(baseUrl));
    if (!next) break;
    currentUrl = next;
  }

  const complete = allRows.filter(o => o.locality && Number.isFinite(o.price) && Number.isFinite(o.area) && o.url);
  const minArea = areaTarget * (1 - tolerance / 100);
  const maxArea = areaTarget * (1 + tolerance / 100);
  const filtered = complete.filter(o => o.area >= minArea && o.area <= maxArea);
  const d = dedupe(filtered);

  return {
    portal: 'Gratka', requestedLocation: location, sourceUrl,
    httpStatus: firstStatus, fetched: firstStatus >= 200 && firstStatus < 400,
    htmlLength: totalHtmlLength, recognized: totalRecognized,
    complete: complete.length, filtered: filtered.length,
    unique: d.unique.length, duplicates: d.duplicates.length,
    offers: d.unique, requestedRadius: Number(radius) || 0,
    appliedRadius: 0, radiusSupported: false, pagesFetched
  };
}

module.exports = { searchGratka };

if (require.main === module || process.argv[1] === undefined) {
  const port = Number(process.env.PORT) || 10000;
  http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (u.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, portal: 'Gratka' }));
      }
      if (u.pathname === '/api/gratka') {
        const result = await searchGratka({
          location: u.searchParams.get('location') || 'Olsztyn',
          areaTarget: Number(u.searchParams.get('area') || 62),
          tolerance: Number(u.searchParams.get('tolerance') || 10),
          radius: Number(u.searchParams.get('radius') || 0)
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(result));
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ service: 'Gratka parser v0.5', status: 'ok' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
    }
  }).listen(port, '0.0.0.0', () => console.log(`GRATKA_SERVER_LISTENING port=${port}`));
  setInterval(() => {}, 2147483647);
}
