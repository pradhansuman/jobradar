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

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
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

/* ---------- Generic JSON-LD career-page crawler ---------- */
function extractDetailLinks(html, baseUrl) {
  const found = new Map();
  const origin = new URL(baseUrl).origin;
  const re = /<a[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let href = m[1];
    const text = stripHtml(m[2]).trim();
    if (/^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let u;
    try { u = new URL(href, baseUrl); } catch { continue; }
    if (u.origin !== origin) continue;
    if (u.href.replace(/\/$/, '') === baseUrl.replace(/\/$/, '')) continue;
    const path = u.pathname.toLowerCase();
    const pathHit = /\/(job|jobs|career|careers|opening|openings|position|positions|vacanc\w*|requirement\w*|role|roles|hiring|apply)(\/|$|-|_)/i.test(path);
    const textHit = text.length >= 8 && text.length <= 90 && /\s/.test(text) && /[a-z]/i.test(text)
      && !/^(about|contact|blog|faq|press|privacy|terms|home|login|sign|learn more|read more|apply now|see all|view all|back)/i.test(text);
    if (pathHit || textHit) found.set(u.href, text);
  }
  return [...found.keys()];
}

async function mapLimited(items, limit, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    results.push(...await Promise.all(items.slice(i, i + limit).map(fn)));
  }
  return results;
}

/**
 * Fetch a careers page and extract schema.org JobPosting JSON-LD.
 * Two modes: the listing embeds JobPostings inline (WordPress/Squarespace/teamtailor style),
 * or we crawl up to 15 same-site job detail links and extract from each.
 */
async function fetchGeneric(name, url) {
  const res = await fetchWithTimeout(url, 25000);
  if (!res.ok) throw new Error(`careers-page ${name}: HTTP ${res.status}`);
  const html = await res.text();
  const jobs = extractJsonLdJobs(html, name);
  if (jobs.length) return jobs;

  const links = extractDetailLinks(html, url).slice(0, 15);
  if (!links.length) throw new Error(`careers-page ${name}: no JobPosting JSON-LD and no candidate job links found`);
  const details = await mapLimited(links, 6, async (link) => {
    try {
      const r = await fetchWithTimeout(link, 12000);
      if (!r.ok) return [];
      return extractJsonLdJobs(await r.text(), name);
    } catch { return []; }
  });
  const all = details.flat();
  if (!all.length) throw new Error(`careers-page ${name}: crawled ${links.length} linked pages, no JobPosting JSON-LD found`);
  return all;
}
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

/* ---------- RemoteOK public API ---------- */
const TECH_TAGS = new Set(['javascript','typescript','react','vue','angular','svelte','node','nodejs','python','java','golang','go','rust','php','ruby','rails','django','laravel','dotnet','.net','c++','devops','sre','frontend','front-end','backend','back-end','full-stack','fullstack','ios','android','flutter','react-native','qa','data-engineering','data-science','machine-learning','ml','ai','nlp','llm','cloud','aws','gcp','azure','kubernetes','docker','terraform','security','cybersecurity','blockchain','web3','solidity','scala','kotlin','swift','graphql','elasticsearch','microservices','emberjs','nextjs','clojure','elixir','erlang','haskell','perl','objective-c']);

async function fetchRemoteOk() {
  const res = await fetchWithTimeout('https://remoteok.com/api', 25000);
  if (!res.ok) throw new Error(`remoteok: HTTP ${res.status}`);
  const arr = await res.json();
  const out = [];
  for (const j of Array.isArray(arr) ? arr : []) {
    if (!j || !j.position || !(j.url || j.slug)) continue; // first element is a legal notice
    const tags = Array.isArray(j.tags) ? j.tags : [];
    const low = tags.map((t) => String(t).toLowerCase());
    if (low.includes('non tech')) continue; // board's own explicit marker
    if (!low.some((t) => TECH_TAGS.has(t))) continue; // quality gate: tech-relevant only
    const tagStr = tags.join(', ');
    out.push({
      uid: makeUid(j.company || 'remoteok', decodeEntities(j.position), j.url || `https://remoteok.com/remote-jobs/${j.slug}`),
      company: decodeEntities(String(j.company || 'Unknown').trim()),
      title: decodeEntities(String(j.position).trim()),
      location: decodeEntities(String(j.location || 'Remote').trim()),
      employment_type: j.type ? String(j.type).trim() : null,
      url: j.url || `https://remoteok.com/remote-jobs/${j.slug}`,
      description: stripHtml((j.description || '') + (tagStr ? `\n\nSkills: ${tagStr}` : '')),
      salary: j.salary_min && j.salary_max ? `$${j.salary_min}–$${j.salary_max}` : null,
      posted_at: j.date ? Date.parse(j.date) : (j.epoch ? j.epoch * 1000 : null),
      source: 'remoteok',
      source_board: 'remoteok',
      raw: null
    });
  }
  if (!out.length) throw new Error('remoteok: API returned no jobs');
  return out;
}

/* ---------- dispatch ---------- */
async function fetchBoard(board) {
  if (board.kind === 'greenhouse') return fetchGreenhouse(board.slug);
  if (board.kind === 'lever') return fetchLever(board.slug);
  if (board.kind === 'careers-page') return fetchGeneric(board.label || board.slug, board.url);
  if (board.kind === 'remoteok-api') return fetchRemoteOk();
  throw new Error(`unknown board kind: ${board.kind}`);
}

module.exports = { fetchBoard, stripHtml, decodeEntities, makeUid, extractJsonLdJobs };
