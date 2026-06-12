const app = require("../server.js");

module.exports = async (req, res) => {
  if (app.ready) { try { await app.ready; } catch (e) {} }
  return app(req, res);
};
