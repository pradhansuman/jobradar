'use strict';
/**
 * db.js — SQLite storage layer (better-sqlite3).
 * Single-file DB at data/jobs.db. Swap to Postgres/Neon in prod (see README).
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'jobs.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT UNIQUE NOT NULL,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT,
  employment_type TEXT,
  url TEXT NOT NULL,
  description TEXT,
  salary TEXT,
  source TEXT NOT NULL,
  source_board TEXT,
  posted_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  skills TEXT,
  raw TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_first_seen ON jobs(first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);

CREATE TABLE IF NOT EXISTS cvs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  text TEXT NOT NULL,
  skills TEXT,
  ats TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_prefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keywords TEXT,
  locations TEXT,
  min_score INTEGER DEFAULT 0,
  channels TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  target TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  job_uid TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  fetched INTEGER DEFAULT 0,
  inserted INTEGER DEFAULT 0,
  updated INTEGER DEFAULT 0,
  failed_boards TEXT
);

CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  slug TEXT NOT NULL,
  label TEXT,
  url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(kind, slug)
);
`);

const now = () => Date.now();

function upsertJob(j) {
  const existing = db.prepare('SELECT id, first_seen_at FROM jobs WHERE uid = ?').get(j.uid);
  const ts = now();
  if (existing) {
    db.prepare(`UPDATE jobs SET title=?, location=?, employment_type=?, description=?, salary=?, posted_at=?, last_seen_at=?, skills=?, raw=? WHERE id=?`)
      .run(j.title, j.location || null, j.employment_type || null, j.description || null, j.salary || null, j.posted_at || null, ts, j.skills || null, j.raw || null, existing.id);
    return { updated: true };
  }
  db.prepare(`INSERT INTO jobs (uid, company, title, location, employment_type, url, description, salary, source, source_board, posted_at, first_seen_at, last_seen_at, skills, raw)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(j.uid, j.company, j.title, j.location || null, j.employment_type || null, j.url, j.description || null, j.salary || null, j.source, j.source_board || null, j.posted_at || null, ts, ts, j.skills || null, j.raw || null);
  return { inserted: true };
}

function seedBoards(list) {
  const ins = db.prepare('INSERT OR IGNORE INTO boards (kind, slug, label, url, enabled) VALUES (?,?,?,?,1)');
  const tx = db.transaction((rows) => { for (const r of rows) ins.run(r.kind, r.slug, r.label || null, r.url || null); });
  tx(list);
}

function latestCv() {
  return db.prepare('SELECT * FROM cvs ORDER BY active DESC, id DESC LIMIT 1').get() || null;
}

function activateCv(id) {
  const tx = db.transaction(() => {
    db.prepare('UPDATE cvs SET active = 0').run();
    db.prepare('UPDATE cvs SET active = 1 WHERE id = ?').run(id);
  });
  tx();
  return db.prepare('SELECT id FROM cvs WHERE id = ? AND active = 1').get(id);
}

function listCvs() {
  return db.prepare('SELECT id, name, active, length(text) AS chars, created_at FROM cvs ORDER BY active DESC, id DESC').all();
}

function deleteCv(id) {
  const wasActive = db.prepare('SELECT active FROM cvs WHERE id = ?').get(id);
  db.prepare('DELETE FROM cvs WHERE id = ?').run(id);
  if (wasActive && wasActive.active) {
    const next = db.prepare('SELECT id FROM cvs ORDER BY id DESC LIMIT 1').get();
    if (next) activateCv(next.id);
  }
  return true;
}

function saveCv(name, text, skills, ats) {
  const r = db.prepare('INSERT INTO cvs (name, text, skills, ats, created_at) VALUES (?,?,?,?,?)').run(name || null, text, skills || null, ats || null, now());
  return r.lastInsertRowid;
}

function saveAlertPrefs(p) {
  const existing = db.prepare('SELECT id FROM alert_prefs ORDER BY id DESC LIMIT 1').get();
  const ts = now();
  if (existing) {
    db.prepare('UPDATE alert_prefs SET keywords=?, locations=?, min_score=?, channels=?, updated_at=? WHERE id=?')
      .run(p.keywords, p.locations, p.min_score, p.channels, ts, existing.id);
    return existing.id;
  }
  const r = db.prepare('INSERT INTO alert_prefs (keywords, locations, min_score, channels, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(p.keywords, p.locations, p.min_score, p.channels, ts, ts);
  return r.lastInsertRowid;
}

function getAlertPrefs() {
  return db.prepare('SELECT * FROM alert_prefs ORDER BY id DESC LIMIT 1').get() || null;
}

module.exports = { db, now, upsertJob, seedBoards, latestCv, activateCv, listCvs, deleteCv, saveCv, saveAlertPrefs, getAlertPrefs };
