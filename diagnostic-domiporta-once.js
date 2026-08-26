const { searchDomiporta } = require('./parser-domiporta-v05');

setTimeout(async () => {
  const request = {
    location: 'Olsztyn',
    areaTarget: 61,
    tolerance: 1.6393442623,
    radius: 0
  };
  console.log('DOMIPORTA_SELFTEST_REQUEST', JSON.stringify(request));
  try {
    const data = await searchDomiporta(request);
    console.log('DOMIPORTA_SELFTEST_RESULT', JSON.stringify({
      portal: data.portal,
      propertyType: data.propertyType,
      httpStatus: data.httpStatus,
      fetched: data.fetched,
      recognized: data.recognized,
      complete: data.complete,
      filtered: data.filtered,
      unique: data.unique,
      duplicates: data.duplicates,
      parser: data.parser,
      pagesFetched: data.pagesFetched,
      pages: data.pages,
      requestedRadius: data.requestedRadius,
      appliedRadius: data.appliedRadius,
      diagnosticCounts: data.diagnosticCounts,
      offers: data.offers
    }));
  } catch (error) {
    console.error('DOMIPORTA_SELFTEST_ERROR', error.stack || error.message || error);
  }
}, 5000);
