// Compatibility gateway used by the production Render service.
// Render is configured to start `node server.js`, while the active
// implementation lives in compat-server.js.
require("./compat-server.js");
