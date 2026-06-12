// Point d'entrée Vercel (fonction serverless) : enveloppe l'application Express.
// Vercel route toutes les requêtes ici (voir vercel.json) ; Express gère ensuite /api/*.
const app = require("../server.js");

module.exports = async (req, res) => {
  // s'assure que les tables existent (idempotent) avant de traiter la 1re requête
  if (app.ready) {
    try { await app.ready; } catch (e) { /* déjà loggé dans server.js */ }
  }
  return app(req, res);
};
