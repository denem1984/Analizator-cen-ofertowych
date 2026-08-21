const { searchNieruchomosciOnline } = require("./live-parser");

(async () => {
  const result = await searchNieruchomosciOnline({
    location: "Olsztyn",
    path: "/mieszkania/sprzedaz/"
  });

  console.log(JSON.stringify({
    portal: result.portal,
    requestedLocation: result.requestedLocation,
    fetchedUrl: result.url,
    httpStatus: result.httpStatus,
    fetched: result.fetched,
    htmlLength: result.htmlLength,
    recognized: result.recognized,
    complete: result.complete,
    firstOffers: result.offers.slice(0, 10)
  }, null, 2));
})();
