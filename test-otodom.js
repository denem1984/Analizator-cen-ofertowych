const { searchOtodom } = require('./live-otodom');

(async () => {
  const result = await searchOtodom({ location: 'Olsztyn', areaTarget: 60, tolerance: 10, radius: 0, maxPages: 2 });
  console.log(JSON.stringify(result, null, 2));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
