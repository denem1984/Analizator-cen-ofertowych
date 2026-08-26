const base = require('./parser-commercial-v01');
const { searchNieruchomosciOnline } = require('./parser-no-active');
const { search: searchAdresowo } = require('./parser-adresowo-v05');
const { searchOtodom } = require('./live-otodom');
const PORTAL_NO = 'Nieruchomości-online';
const PORTAL_ADRESOWO = 'Adresowo';
const PORTAL_OTODOM = 'Otodom';

async function searchCommercial(options = {}) {
  const result = await base.searchCommercial(options);
  const area = Number(options.area ?? 62);
  const tolerance = Number(options.tolerance ?? 10);
  const minArea = area * (1 - tolerance / 100);
  const maxArea = area * (1 + tolerance / 100);
  const location = options.location || 'Olsztyn';
  const radius = Number(options.radius) || 0;

  const fixedNO = await searchNieruchomosciOnline(location, minArea, maxArea);
  const fixedAdresowo = await searchAdresowo({ location, areaTarget: area, tolerance, radius });

  const [otodomLokale, otodomHale] = await Promise.all([
    searchOtodom({ location, areaTarget: area, tolerance, radius, propertyType: 'lokale użytkowe' }),
    searchOtodom({ location, areaTarget: area, tolerance, radius, propertyType: 'hale i magazyny' })
  ]);

  const otodomOffers = [...(otodomLokale.offers || []), ...(otodomHale.offers || [])]
    .map(o => ({ ...o, locality: o.locality || location }))
    .filter(o => o.area >= minArea && o.area <= maxArea && Number.isFinite(o.price) && Number.isFinite(o.area) && o.url);

  const seen = new Set();
  const uniqueOtodomOffers = otodomOffers.filter(o => {
    const key = String(o.url || '').toLowerCase().replace(/\/$/, '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const fixedOtodom = {
    portal: PORTAL_OTODOM,
    httpStatus: otodomHale.httpStatus || otodomLokale.httpStatus || 0,
    fetched: Boolean(otodomLokale.fetched || otodomHale.fetched),
    htmlLength: Number(otodomLokale.htmlLength || 0) + Number(otodomHale.htmlLength || 0),
    recognized: Number(otodomLokale.recognized || 0) + Number(otodomHale.recognized || 0),
    complete: uniqueOtodomOffers.length,
    filtered: uniqueOtodomOffers.length,
    offers: uniqueOtodomOffers,
    pagesFetched: Number(otodomLokale.pagesFetched || 0) + Number(otodomHale.pagesFetched || 0),
    pages: [
      ...(otodomLokale.pages || []).map(p => ({ ...p, propertyType: 'lokale użytkowe' })),
      ...(otodomHale.pages || []).map(p => ({ ...p, propertyType: 'hale i magazyny' }))
    ],
    requestedRadius: radius,
    appliedRadius: Math.max(Number(otodomLokale.appliedRadius || 0), Number(otodomHale.appliedRadius || 0)),
    radiusSupported: Boolean(otodomLokale.radiusSupported || otodomHale.radiusSupported),
    radiusStrategy: 'Otodom: lokale użytkowe + hale i magazyny'
  };

  return [...result.map(item => {
    if (item.portal === PORTAL_NO) {
      return { ...fixedNO, requestedRadius: radius, appliedRadius: 0, radiusSupported: false };
    }
    if (item.portal === PORTAL_ADRESOWO) {
      return { ...fixedAdresowo, requestedRadius: radius };
    }
    return item;
  }), fixedOtodom];
}

module.exports = { searchCommercial };