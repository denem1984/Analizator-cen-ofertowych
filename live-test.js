const { searchNieruchomosciOnline } = require("./live-parser");

(async () => {
  try {
    const result = await searchNieruchomosciOnline({
      location: "Olsztyn",
      path: "/mieszkania/sprzedaz/"
    });

    console.log(JSON.stringify({
      portal: result.portal,
      requestedLocation: result.requestedLocation,
      url: result.url,
      httpStatus: result.httpStatus,
      fetched: result.fetched,
      htmlLength: result.htmlLength,
      recognized: result.recognized,
      complete: result.complete,
      sample: result.offers.slice(0, 5)
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      error: error.message,
      stack: error.stack
    }, null, 2));
    process.exitCode = 1;
  }
})();
