const app = require("../server.js");

   module.exports = async (req, res) => {
     if (app.ready) { try { await app.ready; } catch (e) {} }
     if (req.url && !req.url.startsWith("/api")) {
       req.url = "/api" + (req.url.startsWith("/") ? "" : "/") + req.url;
     }
     return app(req, res);
   };
