const base = require('./parser-commercial-v01');
const { searchNieruchomosciOnline } = require('./parser-no-active');
const PORTAL = 'Nieruchomości-online';

async function searchCommercial(options = {}) {
  const result = await base.searchCommercial(options);
  const area = Number(options.area ?? 62);
  const tolerance = Number(options.tolerance ?? 10);
  const minArea = area * (1 - tolerance / 100);
  const maxArea = area * (1 + tolerance / 100);
  const location = options.location || 'Olsztyn';
  const fixedNO = await searchNieruchomosciOnline(location, minArea, maxArea);
  return result.map(item => item.portal === PORTAL
    ? { ...fixedNO, requestedRadius: Number(options.radius) || 0, appliedRadius: 0, radiusSupported: false }
    : item);
}

module.exports = { searchCommercial };
