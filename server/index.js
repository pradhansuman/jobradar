'use strict';
/**
 * index.js — JobRadar server: API + static UI + ingest scheduler + alert flusher.
 */
const path = require('path');
const express = require('express');
const { db, now, latestCv, saveCv, saveAlertPrefs, getAlertPrefs } = require('./db');
const { runIngest, ensureBoardsSeeded, lastRun } = require('./ingest');
const { extractSkills, matchScore, atsCheck, analyzeJobAgainstLatestCv, jobSignals } = require('./match');
const { queueAlertsForNewJobs, flushOutbox } = require('./notify');

const app = express();
const PORT = process.env.PORT || 8787;
const INGEST_INTERVAL_MIN = Number(process.env.INGEST_INTERVAL_MIN || 30);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ---------- helpers ---------- */
function rowToJob(r, cvCtx) {
  const j = {
    uid: r.uid, company: r.company, title: r.title, location: r.location,
    employment_type: r.employment_type, url: r.url, salary: r.salary,
    source: r.source, source_board: r.source_board,
    posted_at: r.posted_at, first_seen_at: r.first_seen_at,
    ageHours: Math.max(0, Math.round((Date.now() - r.first_seen_at) / 3.6e6)),
    skills: r.skills ? JSON.parse(r.skills) : []
  };
  if (cvCtx) {
    const m = matchScore(cvCtx.text, cvCtx.skills, `${r.title} ${r.description || ''}`, j.skills);
    j.match_score = m.score;
  }
  return j;
}

function getCvCtx() {
  const cv = latestCv();
  if (!cv) return null;
  return { id: cv.id, name: cv.name, text: cv.text, skills: cv.skills ? JSON.parse(cv.skills) : extractSkills(cv.text) };
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next(); // open when no token configured (local/self-host default)
  if (req.header('x-admin-token') === ADMIN_TOKEN) return next();
  res.status(401).json({ error: 'invalid admin token' });
}

/* ---------- jobs ---------- */
app.get('/api/jobs', (req, res) => {
  const { q, source, location, max_age_h, sort, limit = 60, offset = 0 } = req.query;
  const where = [];
  const args = [];
  if (q) { where.push('(title LIKE ? OR company LIKE ? OR description LIKE ?)'); const like = `%${q}%`; args.push(like, like, like); }
  if (source) { where.push('source = ?'); args.push(source); }
  if (location) { where.push('location LIKE ?'); args.push(`%${location}%`); }
  if (max_age_h) { where.push('first_seen_at >= ?'); args.push(Date.now() - Number(max_age_h) * 3.6e6); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM jobs ${whereSql}`).get(...args).n;
  const cvCtx = getCvCtx();
  let jobs;
  if (sort === 'match' && cvCtx) {
    // score the full candidate pool (capped), then rank and paginate in JS
    const pool = db.prepare(`SELECT * FROM jobs ${whereSql} ORDER BY first_seen_at DESC LIMIT 5000`).all(...args);
    jobs = pool.map((r) => rowToJob(r, cvCtx)).sort((a, b) => (b.match_score || 0) - (a.match_score || 0));
    jobs = jobs.slice(Number(offset) || 0, (Number(offset) || 0) + Math.min(Number(limit), 300));
  } else {
    const orderBy = sort === 'company' ? 'company COLLATE NOCASE, title' : 'first_seen_at DESC';
    const rows = db.prepare(`SELECT * FROM jobs ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...args, Math.min(Number(limit), 300), Number(offset) || 0);
    jobs = rows.map((r) => rowToJob(r, cvCtx));
  }
  res.json({ total, jobs, hasCv: !!cvCtx });
});

app.get('/api/jobs/:uid', (req, res) => {
  const r = db.prepare('SELECT * FROM jobs WHERE uid = ?').get(req.params.uid);
  if (!r) return res.status(404).json({ error: 'job not found' });
  const analysis = analyzeJobAgainstLatestCv(r);
  const desc = r.description || '';
  res.json({
    job: rowToJob(r, null),
    description: desc,
    analysis: analysis.hasCv ? analysis : { hasCv: false, signals: jobSignals(r, { skillBoost: 0.3 }) }
  });
});

/* ---------- CV ---------- */
app.get('/api/cv', (req, res) => {
  const cv = latestCv();
  if (!cv) return res.json({ cv: null });
  res.json({ cv: { id: cv.id, name: cv.name, created_at: cv.created_at, skills: cv.skills ? JSON.parse(cv.skills) : [], ats: cv.ats ? JSON.parse(cv.ats) : null, text_preview: cv.text.slice(0, 400) } });
});

app.post('/api/cv', (req, res) => {
  const { name, text } = req.body || {};
  if (!text || String(text).trim().length < 80) return res.status(400).json({ error: 'paste or upload at least ~80 characters of CV text' });
  const clean = String(text).slice(0, 60000);
  const skills = extractSkills(clean);
  const ats = atsCheck(clean);
  const id = saveCv(name || null, clean, JSON.stringify(skills), JSON.stringify(ats));
  res.json({ id, skills, ats });
});

/* ---------- alerts ---------- */
app.get('/api/alerts', (req, res) => {
  const prefs = getAlertPrefs();
  const outbox = db.prepare('SELECT id, channel, target, subject, status, error, created_at, sent_at FROM outbox ORDER BY id DESC LIMIT 30').all();
  res.json({ prefs: prefs ? { keywords: prefs.keywords, locations: prefs.locations, min_score: prefs.min_score, channels: JSON.parse(prefs.channels || '[]') } : null, outbox });
});

app.put('/api/alerts', (req, res) => {
  const { keywords = '', locations = '', min_score = 0, channels = ['email'] } = req.body || {};
  if (!Array.isArray(channels) || !channels.length) return res.status(400).json({ error: 'pick at least one channel' });
  const id = saveAlertPrefs({ keywords, locations, min_score: Number(min_score) || 0, channels: JSON.stringify(channels) });
  res.json({ ok: true, id });
});

app.post('/api/alerts/test', async (req, res) => {
  try {
  ensureBoardsSeeded();
  const prefs = getAlertPrefs();
  if (!prefs) return res.status(400).json({ error: 'save alert preferences first' });
  const { jobMatchesPrefs } = require('./notify');
  const cv = latestCv();
  const cvCtx = cv ? { text: cv.text, skills: cv.skills ? JSON.parse(cv.skills) : extractSkills(cv.text) } : null;
  const pool = db.prepare('SELECT * FROM jobs ORDER BY first_seen_at DESC LIMIT 400').all();
  const matches = pool
    .map((r) => {
      const job = { uid: r.uid, title: r.title, company: r.company, location: r.location, url: r.url, description: r.description, first_seen_at: r.first_seen_at, skills: r.skills ? JSON.parse(r.skills) : [] };
      if (cvCtx) job.match_score = matchScore(cvCtx.text, cvCtx.skills, `${r.title} ${r.description || ''}`, job.skills).score;
      return job;
    })
    .filter((j) => jobMatchesPrefs(j, prefs, cv))
    .sort((a, b) => (b.match_score || 0) - (a.match_score || 0))
    .slice(0, 10);
  const queued = queueAlertsForNewJobs(matches);
  const result = await flushOutbox();
  res.json({ considered: pool.length, matched: matches.length, queued, result });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

/* ---------- ingest & boards ---------- */
app.post('/api/ingest', requireAdmin, async (req, res) => {
  try { res.json(await runIngest()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/ingest/status', (req, res) => {
  const runs = db.prepare('SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 10').all();
  for (const r of runs) if (r.failed_boards) r.failures = JSON.parse(r.failed_boards);
  res.json({ lastRun: lastRun(), runs, intervalMin: INGEST_INTERVAL_MIN });
});

app.get('/api/boards', (req, res) => {
  const boards = db.prepare(`SELECT b.*, (SELECT COUNT(*) FROM jobs j WHERE j.source = b.kind AND j.source_board = b.slug) AS job_count FROM boards b ORDER BY b.enabled DESC, b.kind, b.slug`).all();
  res.json({ boards });
});

app.post('/api/boards', requireAdmin, async (req, res) => {
  const { kind, slug, url, label } = req.body || {};
  if (!['greenhouse', 'lever', 'careers-page'].includes(kind)) return res.status(400).json({ error: 'kind must be greenhouse | lever | careers-page' });
  if (kind === 'careers-page' && !url) return res.status(400).json({ error: 'careers-page boards need a URL' });
  if (kind !== 'careers-page' && !slug) return res.status(400).json({ error: 'slug required' });
  const board = { kind, slug: slug || label, label: label || slug, url: url || null };
  const { fetchBoard } = require('./sources');
  try { const jobs = await fetchBoard(board); if (!jobs.length) throw new Error('no jobs returned — check the slug/URL'); }
  catch (e) { return res.status(400).json({ error: `board check failed: ${e.message}` }); }
  db.prepare('INSERT OR IGNORE INTO boards (kind, slug, label, url, enabled) VALUES (?,?,?,?,1)').run(kind, board.slug, board.label, board.url);
  res.json({ ok: true, board });
});

app.delete('/api/boards/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM boards WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------- stats ---------- */
app.get('/api/stats', (req, res) => {
  const jobs = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
  const last24 = db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE first_seen_at >= ?').get(Date.now() - 864e5).n;
  const last72 = db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE first_seen_at >= ?').get(Date.now() - 3 * 864e5).n;
  const companies = db.prepare('SELECT COUNT(DISTINCT company) AS n FROM jobs').get().n;
  const cv = latestCv();
  res.json({ jobs, last24, last72, companies, boards: db.prepare('SELECT COUNT(*) AS n FROM boards WHERE enabled=1').get().n, hasCv: !!cv });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

/* ---------- boot ---------- */
process.on('unhandledRejection', (e) => console.error('[jobradar] unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('[jobradar] uncaught exception:', e));
ensureBoardsSeeded();
app.listen(PORT, () => {
  console.log(`[jobradar] listening on http://localhost:${PORT}`);
  const count = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
  if (count === 0) {
    console.log('[jobradar] empty DB — running first ingest in background…');
    runIngest().then((r) => console.log(`[jobradar] first ingest: fetched=${r.fetched} inserted=${r.inserted} failures=${r.failures.length}`)).catch((e) => console.error('[jobradar] first ingest failed:', e));
  }
  setInterval(() => { runIngest().catch((e) => console.error('[jobradar] ingest error:', e)); }, INGEST_INTERVAL_MIN * 60000);
  setInterval(() => { flushOutbox().catch((e) => console.error('[jobradar] outbox error:', e)); }, 60000);
});
