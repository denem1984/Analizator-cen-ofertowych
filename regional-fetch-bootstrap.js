const { URL } = require('url');
const Module = require('module');

const originalFetch = global.fetch;
const cache = new Map();

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-+$/g, '');
}

function cityFromNieruchomosciUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!/^(www\.)?nieruchomosci-online\.pl$/i.test(u.hostname)) return '';
    const raw = decodeURIComponent(u.search || '');
    const match = raw.match(/,,([^,:&]+)(?::\d+)?(?:,|&|$)/i);
    return match ? String(match[1]).trim() : '';
  } catch (_) {
    return '';
  }
}

function regionalUrl(rawUrl, city) {
  const slug = slugify(city);
  if (!slug) return null;
  const u = new URL(rawUrl);
  u.hostname = `${slug}.nieruchomosci-online.pl`;
  return u.href;
}

global.fetch = async function patchedFetch(input, init) {
  const raw = typeof input === 'string' ? input : input?.url;
  const city = cityFromNieruchomosciUrl(raw);
  if (!city) return originalFetch(input, init);

  const target = regionalUrl(raw, city);
  if (!target) return originalFetch(input, init);

  const key = target.split('#')[0];
  try {
    const regional = await originalFetch(target, init);
    if (regional.ok || regional.status === 304) return regional;
    if (regional.status >= 400) return originalFetch(raw, init);
    return regional;
  } catch (_) {
    return originalFetch(raw, init);
  }
};

const originalRequire = Module.prototype.require;
Module.prototype.require = function patchedRequire(request) {
  if (request === './live-combined-api-v05' && /compat-server\.js$/i.test(this.filename || '')) {
    return originalRequire.call(this, './live-combined-with-counts');
  }
  return originalRequire.apply(this, arguments);
};

console.log('REGIONAL N-O FETCH ENABLED');
console.log('COMBINED PORTAL COUNTS ENABLED');
require('./compat-server');
