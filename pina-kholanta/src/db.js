const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite'); // SQLite intégré à Node.js (>= 22.13), rien à compiler
const { DEFAULT_CATEGORIES } = require('./config');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'pina-kholanta.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// Petite aide pour exécuter plusieurs écritures d'un bloc (tout ou rien)
const transaction = (fn) => (...args) => {
  db.exec('BEGIN');
  try {
    const result = fn(...args);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
};

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS players (
    user_id   TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    joined_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS categories (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name   TEXT NOT NULL UNIQUE COLLATE NOCASE,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at     INTEGER NOT NULL,
    ended_at       INTEGER,
    vote_closes_at INTEGER,
    status         TEXT NOT NULL CHECK (status IN ('en_cours', 'vote', 'terminee', 'annulee'))
  );

  CREATE TABLE IF NOT EXISTS presence (
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    user_id    TEXT NOT NULL REFERENCES players(user_id),
    total_ms   INTEGER NOT NULL DEFAULT 0,
    eligible   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS ratings (
    session_id  INTEGER NOT NULL REFERENCES sessions(id),
    voter_id    TEXT NOT NULL,
    target_id   TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    note        INTEGER NOT NULL CHECK (note BETWEEN 1 AND 5),
    PRIMARY KEY (session_id, voter_id, target_id, category_id)
  );

  CREATE TABLE IF NOT EXISTS results (
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    user_id    TEXT NOT NULL,
    score      REAL NOT NULL,
    is_mvp     INTEGER NOT NULL DEFAULT 0,
    is_boulet  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, user_id)
  );
`);

// Catégories par défaut au tout premier lancement
if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n === 0) {
  const insert = db.prepare('INSERT INTO categories (name) VALUES (?)');
  for (const name of DEFAULT_CATEGORIES) insert.run(name);
}

// ---------- Réglages ----------
const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);

// ---------- Joueurs ----------
const upsertPlayer = (userId, name) =>
  db.prepare(`INSERT INTO players (user_id, name, joined_at) VALUES (?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET name = excluded.name`)
    .run(userId, name, Date.now());
const getPlayerName = (userId) =>
  db.prepare('SELECT name FROM players WHERE user_id = ?').get(userId)?.name ?? 'Joueur inconnu';

// ---------- Catégories ----------
const listActiveCategories = () => db.prepare('SELECT id, name FROM categories WHERE active = 1 ORDER BY id').all();
const getCategoriesByIds = (ids) => {
  if (ids.length === 0) return [];
  const rows = db.prepare(`SELECT id, name FROM categories WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  return ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean);
};
const addCategory = (name) => {
  const existing = db.prepare('SELECT id, active FROM categories WHERE name = ?').get(name);
  if (existing?.active) return 'existe';
  if (existing) {
    db.prepare('UPDATE categories SET active = 1 WHERE id = ?').run(existing.id);
    return 'reactivee';
  }
  db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
  return 'ajoutee';
};
// On désactive au lieu de supprimer pour garder l'historique des notes
const deactivateCategory = (name) =>
  db.prepare('UPDATE categories SET active = 0 WHERE name = ? AND active = 1').run(name).changes > 0;

// ---------- Sessions ----------
const getOpenSession = () =>
  db.prepare("SELECT * FROM sessions WHERE status = 'en_cours' ORDER BY id DESC LIMIT 1").get() ?? null;
const getVotingSessions = () => db.prepare("SELECT * FROM sessions WHERE status = 'vote'").all();
const getSession = (id) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) ?? null;
const createSession = (now) =>
  getSession(Number(db.prepare("INSERT INTO sessions (started_at, status) VALUES (?, 'en_cours')").run(now).lastInsertRowid));
const updateSession = (id, { endedAt, voteClosesAt, status }) =>
  db.prepare(`UPDATE sessions SET ended_at = COALESCE(?, ended_at), vote_closes_at = COALESCE(?, vote_closes_at),
              status = ? WHERE id = ?`)
    .run(endedAt ?? null, voteClosesAt ?? null, status, id);

// ---------- Présence ----------
const addPresence = (sessionId, userId, ms) =>
  db.prepare(`INSERT INTO presence (session_id, user_id, total_ms) VALUES (?, ?, ?)
              ON CONFLICT(session_id, user_id) DO UPDATE SET total_ms = total_ms + excluded.total_ms`)
    .run(sessionId, userId, Math.max(0, Math.round(ms)));
const getPresence = (sessionId) =>
  db.prepare('SELECT user_id, total_ms, eligible FROM presence WHERE session_id = ? ORDER BY total_ms DESC').all(sessionId);
const markEligibility = (sessionId, minMs) =>
  db.prepare('UPDATE presence SET eligible = CASE WHEN total_ms >= ? THEN 1 ELSE 0 END WHERE session_id = ?')
    .run(minMs, sessionId);
const getEligibleIds = (sessionId) =>
  db.prepare('SELECT user_id FROM presence WHERE session_id = ? AND eligible = 1').all(sessionId).map((r) => r.user_id);
const isEligible = (sessionId, userId) =>
  !!db.prepare('SELECT 1 FROM presence WHERE session_id = ? AND user_id = ? AND eligible = 1').get(sessionId, userId);

// ---------- Notes ----------
const upsertRating = (sessionId, voterId, targetId, categoryId, note) =>
  db.prepare(`INSERT INTO ratings (session_id, voter_id, target_id, category_id, note) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(session_id, voter_id, target_id, category_id) DO UPDATE SET note = excluded.note`)
    .run(sessionId, voterId, targetId, categoryId, note);
const getNotesGiven = (sessionId, voterId, targetId) =>
  new Map(db.prepare('SELECT category_id, note FROM ratings WHERE session_id = ? AND voter_id = ? AND target_id = ?')
    .all(sessionId, voterId, targetId).map((r) => [r.category_id, r.note]));
const getSessionRatings = (sessionId) =>
  db.prepare('SELECT voter_id, target_id, category_id, note FROM ratings WHERE session_id = ?').all(sessionId);

// ---------- Résultats ----------
const finishSession = transaction((sessionId, rows, mvpIds, bouletIds) => {
  const insert = db.prepare('INSERT OR REPLACE INTO results (session_id, user_id, score, is_mvp, is_boulet) VALUES (?, ?, ?, ?, ?)');
  for (const row of rows) {
    insert.run(sessionId, row.userId, row.score, mvpIds.includes(row.userId) ? 1 : 0, bouletIds.includes(row.userId) ? 1 : 0);
  }
  updateSession(sessionId, { status: 'terminee' });
});

// ---------- Statistiques (uniquement sur les sessions terminées) ----------
const STATS_SQL = `
  SELECT p.user_id, pl.name,
         COUNT(*)                         AS sessions,
         SUM(COALESCE(res.is_mvp, 0))     AS mvp,
         SUM(COALESCE(res.is_boulet, 0))  AS boulet
  FROM presence p
  JOIN sessions s  ON s.id = p.session_id AND s.status = 'terminee'
  JOIN players pl  ON pl.user_id = p.user_id
  LEFT JOIN results res ON res.session_id = p.session_id AND res.user_id = p.user_id
  WHERE p.eligible = 1`;

const getAllStats = () => db.prepare(`${STATS_SQL} GROUP BY p.user_id`).all();
const getPlayerStats = (userId) =>
  db.prepare(`${STATS_SQL} AND p.user_id = ? GROUP BY p.user_id`).get(userId) ?? null;

const getCategoryAverages = (userId) =>
  db.prepare(`SELECT c.name, AVG(r.note) AS avg, COUNT(*) AS n
              FROM ratings r
              JOIN categories c ON c.id = r.category_id
              JOIN sessions s   ON s.id = r.session_id AND s.status = 'terminee'
              WHERE r.target_id = ?
              GROUP BY c.id ORDER BY c.id`).all(userId);

const getCategoryLeaderboard = (categoryName) =>
  db.prepare(`SELECT r.target_id AS user_id, pl.name, AVG(r.note) AS avg, COUNT(*) AS n
              FROM ratings r
              JOIN categories c ON c.id = r.category_id AND c.name = ?
              JOIN sessions s   ON s.id = r.session_id AND s.status = 'terminee'
              JOIN players pl   ON pl.user_id = r.target_id
              GROUP BY r.target_id ORDER BY avg DESC`).all(categoryName);

module.exports = {
  getSetting, setSetting,
  upsertPlayer, getPlayerName,
  listActiveCategories, getCategoriesByIds, addCategory, deactivateCategory,
  getOpenSession, getVotingSessions, getSession, createSession, updateSession,
  addPresence, getPresence, markEligibility, getEligibleIds, isEligible,
  upsertRating, getNotesGiven, getSessionRatings,
  finishSession,
  getAllStats, getPlayerStats, getCategoryAverages, getCategoryLeaderboard,
};