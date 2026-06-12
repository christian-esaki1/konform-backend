/**
 * Couche de données Konform.
 * - Si la variable d'environnement DATABASE_URL existe  → PostgreSQL (production, persistant).
 * - Sinon                                               → fichier JSON local (démo / dev rapide).
 * Même interface dans les deux cas : le reste du serveur ne voit pas la différence.
 */
const { ANNEX_A } = require("./catalog");

const USE_PG = !!process.env.DATABASE_URL;

/* ------------------------------------------------------------------ */
/* Implémentation PostgreSQL                                           */
/* ------------------------------------------------------------------ */
function makePg() {
  const { Pool } = require("pg");
  const url = process.env.DATABASE_URL;
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new Pool({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false }, // Neon & co exigent SSL
    max: process.env.VERCEL ? 1 : 10, // en serverless (Vercel), garder peu de connexions
  });
  const q = (text, params) => pool.query(text, params);

  return {
    mode: "postgres",

    async init() {
      await q(`CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await q(`CREATE TABLE IF NOT EXISTS projects (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        rssi TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await q(`CREATE TABLE IF NOT EXISTS controls (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        ref TEXT NOT NULL, theme TEXT NOT NULL, title TEXT NOT NULL,
        applicable BOOLEAN NOT NULL DEFAULT true,
        status TEXT NOT NULL DEFAULT 'todo',
        justif TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT ''
      )`);
      await q(`CREATE TABLE IF NOT EXISTS risks (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        asset TEXT NOT NULL DEFAULT '',
        crit TEXT NOT NULL DEFAULT 'C',
        v INTEGER NOT NULL DEFAULT 2,
        i INTEGER NOT NULL DEFAULT 2,
        treat TEXT NOT NULL DEFAULT 'reduce',
        ctrls JSONB NOT NULL DEFAULT '[]',
        owner TEXT NOT NULL DEFAULT ''
      )`);
    },

    async getUserByEmail(email) {
      return (await q(`SELECT * FROM users WHERE email=$1`, [email])).rows[0] || null;
    },
    async getUserById(id) {
      return (await q(`SELECT * FROM users WHERE id=$1`, [id])).rows[0] || null;
    },
    async createUser({ email, password_hash }) {
      return (await q(
        `INSERT INTO users(email, password_hash) VALUES($1,$2) RETURNING *`,
        [email, password_hash]
      )).rows[0];
    },
    async setPlan(id, plan) {
      return (await q(`UPDATE users SET plan=$1 WHERE id=$2 RETURNING *`, [plan, id])).rows[0];
    },

    async countProjects(userId) {
      return (await q(`SELECT count(*)::int AS n FROM projects WHERE user_id=$1`, [userId])).rows[0].n;
    },
    async listProjects(userId) {
      return (await q(`SELECT * FROM projects WHERE user_id=$1 ORDER BY id`, [userId])).rows;
    },
    async ownProject(userId, projectId) {
      return (await q(`SELECT * FROM projects WHERE id=$1 AND user_id=$2`, [projectId, userId])).rows[0] || null;
    },
    async createProject(userId, { name, scope, rssi }) {
      const project = (await q(
        `INSERT INTO projects(user_id, name, scope, rssi) VALUES($1,$2,$3,$4) RETURNING *`,
        [userId, name, scope, rssi]
      )).rows[0];
      // initialise les 93 mesures de l'Annexe A (Déclaration d'Applicabilité) en un seul insert
      const vals = [];
      const params = [];
      let k = 1;
      for (const c of ANNEX_A) {
        vals.push(`($${k++},$${k++},$${k++},$${k++})`);
        params.push(project.id, c.ref, c.theme, c.title);
      }
      await q(`INSERT INTO controls(project_id, ref, theme, title) VALUES ${vals.join(",")}`, params);
      return project;
    },
    async updateProject(userId, projectId, f) {
      return (await q(
        `UPDATE projects SET name=$1, scope=$2, rssi=$3 WHERE id=$4 AND user_id=$5 RETURNING *`,
        [f.name, f.scope, f.rssi, projectId, userId]
      )).rows[0] || null;
    },
    async getProjectFull(userId, projectId) {
      const project = await this.ownProject(userId, projectId);
      if (!project) return null;
      const controls = (await q(`SELECT * FROM controls WHERE project_id=$1 ORDER BY id`, [projectId])).rows;
      const risks = (await q(`SELECT * FROM risks WHERE project_id=$1 ORDER BY (v*i) DESC, id`, [projectId])).rows;
      return { project, controls, risks };
    },

    async getControlOwned(userId, controlId) {
      return (await q(
        `SELECT c.* FROM controls c JOIN projects p ON p.id=c.project_id WHERE c.id=$1 AND p.user_id=$2`,
        [controlId, userId]
      )).rows[0] || null;
    },
    async updateControl(c) {
      return (await q(
        `UPDATE controls SET applicable=$1, status=$2, justif=$3, owner=$4 WHERE id=$5 RETURNING *`,
        [c.applicable, c.status, c.justif, c.owner, c.id]
      )).rows[0];
    },

    async countRisks(projectId) {
      return (await q(`SELECT count(*)::int AS n FROM risks WHERE project_id=$1`, [projectId])).rows[0].n;
    },
    async createRisk(projectId, r) {
      return (await q(
        `INSERT INTO risks(project_id, title, asset, crit, v, i, treat, ctrls, owner)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [projectId, r.title, r.asset, r.crit, r.v, r.i, r.treat, JSON.stringify(r.ctrls), r.owner]
      )).rows[0];
    },
    async getRiskOwned(userId, riskId) {
      return (await q(
        `SELECT r.* FROM risks r JOIN projects p ON p.id=r.project_id WHERE r.id=$1 AND p.user_id=$2`,
        [riskId, userId]
      )).rows[0] || null;
    },
    async updateRisk(r) {
      return (await q(
        `UPDATE risks SET title=$1, asset=$2, crit=$3, v=$4, i=$5, treat=$6, ctrls=$7, owner=$8 WHERE id=$9 RETURNING *`,
        [r.title, r.asset, r.crit, r.v, r.i, r.treat, JSON.stringify(r.ctrls), r.owner, r.id]
      )).rows[0];
    },
    async deleteRisk(riskId) {
      await q(`DELETE FROM risks WHERE id=$1`, [riskId]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Implémentation fichier JSON (repli local, zéro dépendance)          */
/* ------------------------------------------------------------------ */
function makeJson() {
  const fs = require("fs");
  const path = require("path");
  const FILE = process.env.DB_FILE || path.join(__dirname, "data.json");
  let db;
  try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch (e) { db = { users: [], projects: [], controls: [], risks: [], seq: {} }; }
  let t = null;
  const save = () => { clearTimeout(t); t = setTimeout(() => fs.writeFileSync(FILE, JSON.stringify(db)), 40); };
  const nextId = (k) => (db.seq[k] = (db.seq[k] || 0) + 1);

  return {
    mode: "json",
    async init() { /* déjà chargé */ },

    async getUserByEmail(email) { return db.users.find((u) => u.email === email) || null; },
    async getUserById(id) { return db.users.find((u) => u.id === id) || null; },
    async createUser({ email, password_hash }) {
      const u = { id: nextId("users"), email, password_hash, plan: "free", created_at: new Date().toISOString() };
      db.users.push(u); save(); return u;
    },
    async setPlan(id, plan) { const u = await this.getUserById(id); if (u) { u.plan = plan; save(); } return u; },

    async countProjects(userId) { return db.projects.filter((p) => p.user_id === userId).length; },
    async listProjects(userId) { return db.projects.filter((p) => p.user_id === userId); },
    async ownProject(userId, projectId) {
      return db.projects.find((p) => p.id === +projectId && p.user_id === userId) || null;
    },
    async createProject(userId, { name, scope, rssi }) {
      const p = { id: nextId("projects"), user_id: userId, name, scope, rssi, created_at: new Date().toISOString() };
      db.projects.push(p);
      ANNEX_A.forEach((c) =>
        db.controls.push({ id: nextId("controls"), project_id: p.id, ref: c.ref, theme: c.theme, title: c.title, applicable: true, status: "todo", justif: "", owner: "" })
      );
      save(); return p;
    },
    async updateProject(userId, projectId, f) {
      const p = await this.ownProject(userId, projectId); if (!p) return null;
      Object.assign(p, { name: f.name, scope: f.scope, rssi: f.rssi }); save(); return p;
    },
    async getProjectFull(userId, projectId) {
      const project = await this.ownProject(userId, projectId); if (!project) return null;
      const controls = db.controls.filter((c) => c.project_id === project.id);
      const risks = db.risks.filter((r) => r.project_id === project.id).sort((a, b) => b.v * b.i - a.v * a.i);
      return { project, controls, risks };
    },

    async getControlOwned(userId, controlId) {
      const c = db.controls.find((x) => x.id === +controlId);
      if (!c || !(await this.ownProject(userId, c.project_id))) return null;
      return c;
    },
    async updateControl(c) { save(); return c; }, // c est une référence à l'objet stocké

    async countRisks(projectId) { return db.risks.filter((r) => r.project_id === +projectId).length; },
    async createRisk(projectId, r) {
      const risk = { id: nextId("risks"), project_id: +projectId, title: r.title, asset: r.asset, crit: r.crit, v: r.v, i: r.i, treat: r.treat, ctrls: r.ctrls, owner: r.owner };
      db.risks.push(risk); save(); return risk;
    },
    async getRiskOwned(userId, riskId) {
      const r = db.risks.find((x) => x.id === +riskId);
      if (!r || !(await this.ownProject(userId, r.project_id))) return null;
      return r;
    },
    async updateRisk(r) { save(); return r; },
    async deleteRisk(riskId) {
      const i = db.risks.findIndex((x) => x.id === +riskId);
      if (i >= 0) db.risks.splice(i, 1); save();
    },
  };
}

module.exports = USE_PG ? makePg() : makeJson();
