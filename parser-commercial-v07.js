const base = require('./parser-commercial-v01');
const { searchNieruchomosciOnline } = require('./parser-no-active');
const { search: searchAdresowo } = require('./parser-adresowo-v05');
const PORTAL_NO = 'Nieruchomości-online';
const PORTAL_ADRESOWO = 'Adresowo';

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

  return result.map(item => {
    if (item.portal === PORTAL_NO) {
      return { ...fixedNO, requestedRadius: radius, appliedRadius: 0, radiusSupported: false };
    }
    if (item.portal === PORTAL_ADRESOWO) {
      return { ...fixedAdresowo, requestedRadius: radius };
    }
    return item;
  });
}

module.exports = { searchCommercial };
