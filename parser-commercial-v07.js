const base = require('./parser-commercial-v01');
const { searchNieruchomosciOnline } = require('./parser-no-active');
const { search: searchAdresowo } = require('./parser-adresowo-v05');
const { searchOtodom } = require('./live-otodom');
const PORTAL_NO = 'Nieruchomości-online';
const PORTAL_ADRESOWO = 'Adresowo';
const PORTAL_OTODOM = 'Otodom';

function isRealCommercialOffer(offer) {
  const url = String(offer?.url || '').toLowerCase();
  const title = String(offer?.title || '').toLowerCase();
  const type = String(offer?.type || '').toLowerCase();

  if (!url) return false;

  // Nigdy nie wpuszczamy stron wyników wyszukiwania/listingu jako ofert.
  if (url.includes('morizon.pl') && !/morizon\.pl\/oferta\//i.test(url)) return false;
  if (url.includes('gratka.pl') && !/gratka\.pl\/nieruchomosci\/.*\/ob\//i.test(url)) return false;
  if (url.includes('domiporta.pl') && !/domiporta\.pl\/nieruchomosci\/sprzedam-/i.test(url)) return false;
  if (url.includes('adresowo.pl') && !/adresowo\.pl\/o\//i.test(url)) return false;
  if (url.includes('nieruchomosci-online.pl') && !/\.html(?:\?|$)/i.test(url)) return false;
  if (url.includes('otodom.pl') && !/otodom\.pl\/pl\/oferta\//i.test(url)) return false;

  // To jest moduł KOMERCYJNY. Odrzucamy mieszkania/domy/działki,
  // nawet jeśli parser źródłowy błędnie przypisał je do kategorii komercyjnej.
  if (/\bmieszkan(?:ie|ia|iu|iem|iach|i)\b/.test(type)) return false;
  if (/\bdom(?:y|u|em|ach)?\b/.test(type)) return false;
  if (/\bdziałk(?:a|i|ę|ą|ach)\b/.test(type)) return false;

  if (/(?:^|[\s,;|])mieszkanie(?:\s|$)/i.test(title)) return false;
  if (/(?:^|[\s,;|])dom(?:\s|$)/i.test(title)) return false;
  if (/(?:^|[\s,;|])działka(?:\s|$)/i.test(title)) return false;

  return true;
}

function cleanCommercialResult(item) {
  const offers = (item?.offers || []).filter(isRealCommercialOffer);
  return {
    ...item,
    recognized: Number(item?.recognized || 0),
    complete: offers.length,
    filtered: offers.length,
    offers
  };
}

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
    .map(o => ({ ...o, locality: o.locality || location, type: 'Nieruchomość komercyjna' }))
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

  return [...result.map(cleanCommercialResult),
    cleanCommercialResult(itemForPortal(result, PORTAL_NO, fixedNO, radius)),
    cleanCommercialResult(itemForPortal(result, PORTAL_ADRESOWO, fixedAdresowo, radius)),
    cleanCommercialResult(fixedOtodom)
  ];
}

function itemForPortal(result, portal, replacement, radius) {
  const existing = result.find(x => x.portal === portal);
  if (portal === PORTAL_NO) return { ...(existing || {}), ...replacement, requestedRadius: radius, appliedRadius: 0, radiusSupported: false };
  return { ...(existing || {}), ...replacement, requestedRadius: radius };
}

module.exports = { searchCommercial, isRealCommercialOffer };