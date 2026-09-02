'use strict';
/**
 * sources.js — job source adapters.
 *  - greenhouse(slug): public Greenhouse boards API (job boards hosted by companies)
 *  - lever(slug):      public Lever postings API
 *  - generic(name,url): fetch any career page and extract schema.org JobPosting JSON-LD blocks
 * All adapters return normalized jobs:
 *  { uid, company, title, location, employment_type, url, description, salary, posted_at, source, source_board, raw }
 */
const crypto = require('crypto');

const UA = 'JobRadar/0.1 (+https://github.com/pradhansuman/jobradar)';

async function fetchWithTimeout(url, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json, text/html;q=0.9,*/*;q=0.8' }, signal: ctrl.signal });
  } finally { clearTimeout(t); }
}

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}

function makeUid(company, title, url) {
  return crypto.createHash('sha1').update(`${(company || '').toLowerCase()}|${(title || '').toLowerCase()}|${url}`).digest('hex').slice(0, 20);
}

/* ---------- Greenhouse ---------- */
async function fetchGreenhouse(slug) {
  const res = await fetchWithTimeout(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`);
  if (!res.ok) throw new Error(`greenhouse ${slug}: HTTP ${res.status}`);
  const data = await res.json();
  const out = [];
  for (const j of data.jobs || []) {
    const description = stripHtml(j.content || '');
    out.push({
      uid: makeUid(data.title || slug, j.title, j.absolute_url),
      company: (data.title || slug).trim(),
      title: j.title,
      location: j.location && j.location.name ? j.location.name : null,
      employment_type: null,
      url: j.absolute_url,
      description,
      salary: null,
      posted_at: j.updated_at ? Date.parse(j.updated_at) : null,
      source: 'greenhouse',
      source_board: slug,
      raw: null
    });
  }
  return out;
}

/* ---------- Lever ---------- */
async function fetchLever(slug) {
  const res = await fetchWithTimeout(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
  if (!res.ok) throw new Error(`lever ${slug}: HTTP ${res.status}`);
  const data = await res.json();
  const out = [];
  for (const j of data) {
    let extra = '';
    for (const list of j.lists || []) {
      const items = Array.isArray(list.content) ? list.content.map((c) => `• ${c.text}`).join('\n') : String(list.content || '');
      extra += `\n\n${list.text}\n${items}`;
    }
    out.push({
      uid: makeUid(j.categories && j.categories.team ? `${slug} ${j.categories.team}` : slug, j.text, j.hostedUrl),
      company: (j.company || slug).trim(),
      title: j.text,
      location: j.categories && j.categories.location ? j.categories.location : null,
      employment_type: j.categories && j.categories.commitment ? j.categories.commitment : null,
      url: j.hostedUrl,
      description: stripHtml((j.descriptionPlain || '') + extra),
      salary: null,
      posted_at: j.createdAt ? Number(j.createdAt) : null,
      source: 'lever',
      source_board: slug,
      raw: null
    });
  }
  return out;
}

/* ---------- Generic JSON-LD career page scraper ---------- */
function extractJsonLdJobs(html, fallbackCompany) {
  const jobs = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let json;
    try { json = JSON.parse(m[1].trim()); } catch { continue; }
    const nodes = Array.isArray(json) ? json : (json['@graph'] ? json['@graph'] : [json]);
    for (const n of nodes) {
      if (!n || n['@type'] !== 'JobPosting') continue;
      const org = n.hiringOrganization && (typeof n.hiringOrganization === 'string' ? n.hiringOrganization : n.hiringOrganization.name);
      const url = typeof n.url === 'string' ? n.url : (typeof n.sameAs === 'string' ? n.sameAs : null);
      if (!url) continue;
      let loc = null;
      if (n.jobLocation) {
        const jl = Array.isArray(n.jobLocation) ? n.jobLocation[0] : n.jobLocation;
        const addr = jl && jl.address;
        if (addr) loc = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(', ');
        if (!loc && jl && jl.remote) loc = 'Remote';
      }
      let salary = null;
      if (n.baseSalary) {
        const bs = typeof n.baseSalary === 'string' ? n.baseSalary : null;
        const val = !bs && n.baseSalary.value ? n.baseSalary.value : null;
        if (bs) salary = bs;
        else if (val) salary = `${val.minValue ? val.minValue + '-' : ''}${val.maxValue || ''} ${val.unitText || ''} ${n.baseSalary.currency || ''}`.trim();
      }
      jobs.push({
        uid: makeUid(org || fallbackCompany, n.title, url),
        company: org || fallbackCompany,
        title: n.title,
        location: loc,
        employment_type: n.employmentType || null,
        url,
        description: stripHtml(n.description || ''),
        salary,
        posted_at: n.datePosted ? Date.parse(n.datePosted) : null,
        source: 'careers-page',
        source_board: fallbackCompany,
        raw: null
      });
    }
  }
  return jobs;
}

async function fetchGeneric(name, url) {
  const res = await fetchWithTimeout(url, 25000);
  if (!res.ok) throw new Error(`careers-page ${name}: HTTP ${res.status}`);
  const html = await res.text();
  const jobs = extractJsonLdJobs(html, name);
  if (!jobs.length) throw new Error(`careers-page ${name}: no JobPosting JSON-LD found`);
  return jobs;
}

/* ---------- dispatch ---------- */
async function fetchBoard(board) {
  if (board.kind === 'greenhouse') return fetchGreenhouse(board.slug);
  if (board.kind === 'lever') return fetchLever(board.slug);
  if (board.kind === 'careers-page') return fetchGeneric(board.label || board.slug, board.url);
  throw new Error(`unknown board kind: ${board.kind}`);
}

module.exports = { fetchBoard, stripHtml, makeUid, extractJsonLdJobs };
