const { searchDomiporta } = require('./parser-domiporta-v05');

async function searchDomiportaHouses({
  location='Olsztyn',
  wojewodztwo='warminsko-mazurskie',
  areaTarget=100,
  tolerance=10,
  radius=0
}={}) {
  const result = await searchDomiporta({
    location,
    wojewodztwo,
    areaTarget,
    tolerance,
    radius,
    propertyType: 'Dom'
  });

  return {
    ...result,
    portal: 'Domiporta',
    propertyType: 'Dom'
  };
}

module.exports = { searchDomiportaHouses };