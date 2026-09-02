'use strict';
/**
 * notify.js — alert pipeline.
 * Channels: Email (Resend API) and WhatsApp (Meta Cloud API). Both are optional:
 * without env keys, alerts are queued and marked "skipped — channel not configured"
 * so the outbox stays inspectable in the UI.
 */
const { db, now } = require('./db');
const { extractSkills, matchScore } = require('./match');

function buildDigest(jobs) {
  const lines = jobs.slice(0, 10).map((j, i) => {
    const ageH = Math.max(1, Math.round((Date.now() - j.first_seen_at) / 3.6e6));
    const score = j.match_score != null ? ` | match ${j.match_score}%` : '';
    return `${i + 1}. ${j.title} — ${j.company}${j.location ? ' (' + j.location + ')' : ''}\n   first seen ${ageH}h ago${score}\n   ${j.url}`;
  });
  const header = `🚨 JobRadar: ${jobs.length} fresh role${jobs.length === 1 ? '' : 's'} matching your profile\n\n`;
  const footer = `\n— JobRadar (early discovery from company career pages)`;
  return header + lines.join('\n\n') + footer;
}

const parseSkills = (s) => (Array.isArray(s) ? s : s ? JSON.parse(s) : []);

function jobMatchesPrefs(job, prefs, cv) {
  const kws = (prefs.keywords || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const locs = (prefs.locations || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const hay = `${job.title} ${job.company} ${job.description || ''}`.toLowerCase();
  if (kws.length && !kws.some((k) => hay.includes(k))) return false;
  const loc = (job.location || '').toLowerCase();
  if (locs.length && !locs.some((l) => loc.includes(l) || (l === 'remote' && loc.includes('remote')))) return false;
  if (prefs.min_score && cv) {
    const cvSkills = parseSkills(cv.skills).length ? parseSkills(cv.skills) : extractSkills(cv.text);
    const jobSkills = parseSkills(job.skills);
    const m = matchScore(cv.text, cvSkills, `${job.title} ${job.description || ''}`, jobSkills);
    if (m.score < prefs.min_score) return false;
  }
  return true;
}

function queueAlertsForNewJobs(newJobs) {
  const prefs = db.prepare('SELECT * FROM alert_prefs ORDER BY id DESC LIMIT 1').get();
  if (!prefs || !newJobs.length) return 0;
  const cv = db.prepare('SELECT * FROM cvs ORDER BY id DESC LIMIT 1').get();
  const matched = newJobs.filter((j) => jobMatchesPrefs(j, prefs, cv));
  if (!matched.length) return 0;
  const channels = JSON.parse(prefs.channels || '[]');
  const digest = buildDigest(matched);
  const ts = now();
  const ins = db.prepare('INSERT INTO outbox (channel, target, subject, body, job_uid, status, created_at) VALUES (?,?,?,?,?,?,?)');
  const tx = db.transaction(() => {
    for (const ch of channels) {
      if (ch === 'email') ins.run('email', process.env.ALERT_TO_EMAIL || null, `JobRadar: ${matched.length} fresh matches`, digest, matched[0].uid, 'queued', ts);
      if (ch === 'whatsapp') ins.run('whatsapp', process.env.ALERT_TO_WHATSAPP || null, null, digest, matched[0].uid, 'queued', ts);
    }
  });
  tx();
  return matched.length * channels.length;
}

async function sendEmail(target, subject, body) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_FROM_EMAIL;
  if (!key || !from || !target) throw new Error('email not configured (need RESEND_API_KEY, ALERT_FROM_EMAIL, ALERT_TO_EMAIL)');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [target], subject, text: body })
  });
  if (!res.ok) throw new Error(`resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function sendWhatsApp(target, body) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId || !target) throw new Error('whatsapp not configured (need WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, ALERT_TO_WHATSAPP)');
  const res = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: target, type: 'text', text: { body } })
  });
  if (!res.ok) throw new Error(`whatsapp HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function flushOutbox() {
  const rows = db.prepare("SELECT * FROM outbox WHERE status = 'queued' ORDER BY id ASC LIMIT 20").all();
  let sent = 0, failed = 0;
  for (const r of rows) {
    try {
      if (r.channel === 'email') await sendEmail(r.target, r.subject || 'JobRadar digest', r.body);
      else if (r.channel === 'whatsapp') await sendWhatsApp(r.target, r.body);
      db.prepare("UPDATE outbox SET status='sent', sent_at=?, error=NULL WHERE id=?").run(now(), r.id);
      sent++;
    } catch (e) {
      const msg = String(e.message || e);
      if (/not configured/.test(msg)) db.prepare("UPDATE outbox SET status='skipped', error=? WHERE id=?").run(msg, r.id);
      else { db.prepare("UPDATE outbox SET status='failed', error=? WHERE id=?").run(msg.slice(0, 500), r.id); failed++; }
    }
  }
  return { processed: rows.length, sent, failed };
}

module.exports = { queueAlertsForNewJobs, flushOutbox, buildDigest, jobMatchesPrefs };
