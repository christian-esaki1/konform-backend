/**
 * Konform — API de conformité ISO/IEC 27001 & RGPD
 * Express + JWT. Données via ./db (PostgreSQL si DATABASE_URL, sinon fichier JSON).
 *
 *   npm install
 *   cp .env.example .env          # mettez un vrai JWT_SECRET ; DATABASE_URL pour PostgreSQL
 *   node server.js                #  → http://localhost:4000
 */
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("./db");
const { ANNEX_A } = require("./catalog");

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";
const FREE_PROJECT_LIMIT = 1;
const FREE_RISK_LIMIT = 8;

const app = express();
app.use(cors());
app.use(express.json());

// petit emballage : attrape les erreurs des handlers async sans planter le serveur
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const sign = (u) => jwt.sign({ id: u.id, email: u.email }, JWT_SECRET, { expiresIn: "7d" });
const publicUser = (u) => ({ id: u.id, email: u.email, plan: u.plan });

const auth = ah(async (req, res, next) => {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentification requise." });
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch (e) { return res.status(401).json({ error: "Jeton expiré ou invalide." }); }
  const user = await db.getUserById(payload.id);
  if (!user) return res.status(401).json({ error: "Session invalide." });
  req.user = user;
  next();
});

// =================== AUTH ===================
app.post("/api/auth/register", ah(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 8)
    return res.status(400).json({ error: "Email et mot de passe (8 caractères min.) requis." });
  if (await db.getUserByEmail(email))
    return res.status(409).json({ error: "Un compte existe déjà avec cet email." });
  const user = await db.createUser({ email, password_hash: bcrypt.hashSync(password, 10) });
  res.status(201).json({ token: sign(user), user: publicUser(user) });
}));

app.post("/api/auth/login", ah(async (req, res) => {
  const { email, password } = req.body || {};
  const user = await db.getUserByEmail(email);
  if (!user || !bcrypt.compareSync(password || "", user.password_hash))
    return res.status(401).json({ error: "Identifiants incorrects." });
  res.json({ token: sign(user), user: publicUser(user) });
}));

app.get("/api/me", auth, (req, res) => res.json({ user: publicUser(req.user) }));

// =================== PROJECTS ===================
app.get("/api/projects", auth, ah(async (req, res) => {
  res.json({ projects: await db.listProjects(req.user.id) });
}));

app.post("/api/projects", auth, ah(async (req, res) => {
  const count = await db.countProjects(req.user.id);
  if (req.user.plan !== "pro" && count >= FREE_PROJECT_LIMIT)
    return res.status(402).json({ error: "Limite du plan gratuit atteinte (1 projet). Passez à Pro.", upgrade: true });
  const { name, scope = "", rssi = "" } = req.body || {};
  if (!name) return res.status(400).json({ error: "Le nom du projet est requis." });
  const project = await db.createProject(req.user.id, { name, scope, rssi });
  res.status(201).json({ project });
}));

app.get("/api/projects/:id", auth, ah(async (req, res) => {
  const full = await db.getProjectFull(req.user.id, req.params.id);
  if (!full) return res.status(404).json({ error: "Projet introuvable." });
  res.json(full);
}));

app.put("/api/projects/:id", auth, ah(async (req, res) => {
  const cur = await db.ownProject(req.user.id, req.params.id);
  if (!cur) return res.status(404).json({ error: "Projet introuvable." });
  const project = await db.updateProject(req.user.id, req.params.id, {
    name: req.body.name ?? cur.name, scope: req.body.scope ?? cur.scope, rssi: req.body.rssi ?? cur.rssi,
  });
  res.json({ project });
}));

// =================== CONTROLS (Déclaration d'Applicabilité) ===================
app.put("/api/controls/:id", auth, ah(async (req, res) => {
  const ctrl = await db.getControlOwned(req.user.id, req.params.id);
  if (!ctrl) return res.status(404).json({ error: "Mesure introuvable." });
  if (req.body.applicable != null) ctrl.applicable = !!req.body.applicable;
  ctrl.status = ctrl.applicable ? (req.body.status || ctrl.status) : "na";
  if (req.body.justif != null) ctrl.justif = req.body.justif;
  if (req.body.owner != null) ctrl.owner = req.body.owner;
  const control = await db.updateControl(ctrl);
  res.json({ control });
}));

// =================== RISKS (plan de traitement) ===================
app.post("/api/projects/:id/risks", auth, ah(async (req, res) => {
  const project = await db.ownProject(req.user.id, req.params.id);
  if (!project) return res.status(404).json({ error: "Projet introuvable." });
  const count = await db.countRisks(project.id);
  if (req.user.plan !== "pro" && count >= FREE_RISK_LIMIT)
    return res.status(402).json({ error: "Limite du plan gratuit atteinte (8 risques). Passez à Pro.", upgrade: true });
  const b = req.body || {};
  const risk = await db.createRisk(project.id, {
    title: b.title || "Nouveau risque", asset: b.asset || "", crit: b.crit || "C",
    v: b.v || 2, i: b.i || 2, treat: b.treat || "reduce", ctrls: b.ctrls || [], owner: b.owner || "",
  });
  res.status(201).json({ risk });
}));

app.put("/api/risks/:id", auth, ah(async (req, res) => {
  const r = await db.getRiskOwned(req.user.id, req.params.id);
  if (!r) return res.status(404).json({ error: "Risque introuvable." });
  const b = req.body || {};
  Object.assign(r, {
    title: b.title ?? r.title, asset: b.asset ?? r.asset, crit: b.crit ?? r.crit,
    v: b.v ?? r.v, i: b.i ?? r.i, treat: b.treat ?? r.treat, ctrls: b.ctrls ?? r.ctrls, owner: b.owner ?? r.owner,
  });
  const risk = await db.updateRisk(r);
  res.json({ risk });
}));

app.delete("/api/risks/:id", auth, ah(async (req, res) => {
  const r = await db.getRiskOwned(req.user.id, req.params.id);
  if (!r) return res.status(404).json({ error: "Risque introuvable." });
  await db.deleteRisk(r.id);
  res.json({ ok: true });
}));

// =================== BILLING (freemium) ===================
// En production, l'upgrade est déclenché par un webhook Stripe (voir README).
app.post("/api/billing/upgrade", auth, ah(async (req, res) => {
  const user = await db.setPlan(req.user.id, "pro");
  res.json({ user: publicUser(user) });
}));

app.get("/api/health", (_req, res) => res.json({ ok: true, mode: db.mode, controls: ANNEX_A.length }));

// gestionnaire d'erreurs (toute exception async finit ici proprement)
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Erreur serveur." });
});

const ready = db.init();
if (require.main === module) {
  ready
    .then(() => app.listen(PORT, () => console.log(`Konform API → http://localhost:${PORT}  (base: ${db.mode}, ${ANNEX_A.length} mesures)`)))
    .catch((e) => { console.error("Échec d'initialisation de la base :", e); process.exit(1); });
}
module.exports = app;
module.exports.ready = ready;
