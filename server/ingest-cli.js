#!/usr/bin/env node
'use strict';
/* One-shot ingest from the CLI: npm run ingest */
const { runIngest, lastRun } = require('./ingest');
const { queueAlertsForNewJobs } = require('./notify');
const { db } = require('./db');

(async () => {
  console.log('[jobradar] ingest started…');
  const r = await runIngest();
  console.log(`fetched=${r.fetched} inserted=${r.inserted} updated=${r.updated} failures=${r.failures.length}`);
  if (r.failures.length) console.log('failed boards:\n  ' + r.failures.join('\n  '));
  const fresh = db.prepare('SELECT * FROM jobs WHERE first_seen_at >= ?').all(Date.now() - 36e5);
  const queued = queueAlertsForNewJobs(fresh);
  console.log(`alerts queued for ${queued} channel-slots (channels without keys stay queued/skipped — see /alerts in UI)`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
