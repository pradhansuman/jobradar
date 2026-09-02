'use strict';
/**
 * ingest.js — pulls jobs from all enabled boards, dedupes, extracts skills, records run stats.
 */
const { db, now, upsertJob } = require('./db');
const { fetchBoard } = require('./sources');
const { extractSkills } = require('./match');

const DEFAULT_BOARDS = [
  { kind: 'greenhouse', slug: 'postman', label: 'Postman' },
  { kind: 'greenhouse', slug: 'stripe', label: 'Stripe' },
  { kind: 'greenhouse', slug: 'databricks', label: 'Databricks' },
  { kind: 'greenhouse', slug: 'canonical', label: 'Canonical' },
  { kind: 'greenhouse', slug: 'gitlab', label: 'GitLab' },
  { kind: 'lever', slug: 'meesho', label: 'Meesho' },
  { kind: 'lever', slug: 'cred', label: 'CRED' },
  { kind: 'lever', slug: 'paytm', label: 'Paytm' },
  // Disabled by default: RemoteOK's public API feed is currently polluted with
  // mis-tagged non-tech listings. The adapter + filters remain available; re-enable from the Pipeline tab.
  { kind: 'remoteok-api', slug: 'remoteok', label: 'RemoteOK (remote, public API)', enabled: 0 }
];

function ensureBoardsSeeded() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM boards').get().n;
  if (count === 0) {
    const ins = db.prepare('INSERT OR IGNORE INTO boards (kind, slug, label, url, enabled) VALUES (?,?,?,?,?)');
    const tx = db.transaction(() => { for (const b of DEFAULT_BOARDS) ins.run(b.kind, b.slug, b.label, null, b.enabled === 0 ? 0 : 1); });
    tx();
  }
}

async function runIngest() {
  ensureBoardsSeeded();
  const boards = db.prepare('SELECT * FROM boards WHERE enabled = 1').all();
  const runId = db.prepare('INSERT INTO ingest_runs (started_at) VALUES (?)').run(now()).lastInsertRowid;
  let fetched = 0, inserted = 0, updated = 0;
  const failures = [];

  const concurrency = 4;
  for (let i = 0; i < boards.length; i += concurrency) {
    const batch = boards.slice(i, i + concurrency);
    const results = await Promise.allSettled(batch.map(async (b) => ({ board: b, jobs: await fetchBoard(b) })));
    for (const r of results) {
      if (r.status === 'rejected') {
        failures.push(String(r.reason && r.reason.message || r.reason));
        continue;
      }
      const { board, jobs } = r.value;
      for (const j of jobs) {
        j.skills = JSON.stringify(extractSkills(`${j.title || ''} ${j.description || ''}`));
        const res = upsertJob(j);
        if (res.inserted) inserted++; else updated++;
        fetched++;
      }
    }
  }

  db.prepare('UPDATE ingest_runs SET finished_at=?, fetched=?, inserted=?, updated=?, failed_boards=? WHERE id=?')
    .run(now(), fetched, inserted, updated, failures.length ? JSON.stringify(failures) : null, runId);

  return { runId, fetched, inserted, updated, failures };
}

function lastRun() {
  const r = db.prepare('SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 1').get();
  if (r && r.failed_boards) r.failures = JSON.parse(r.failed_boards);
  return r;
}

module.exports = { runIngest, ensureBoardsSeeded, lastRun, DEFAULT_BOARDS };
