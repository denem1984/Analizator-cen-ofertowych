const { searchGratka } = require('./parser-gratka-v05');
searchGratka({ areaTarget: 62, tolerance: 10 })
  .then(r => console.log('GRATKA_SELFTEST', JSON.stringify(r)))
  .catch(e => { console.error('GRATKA_SELFTEST_ERROR', e); process.exit(1); });
