/* probe-boards.js — batch-test candidate job board slugs across platforms.
 * Prints which return HTTP 200 with jobs; used to pick new seeds.
 * Usage: node scripts/probe-boards.js
 */
const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };

async function code(url, opts) {
  try { const r = await fetch(url, { headers: UA, ...opts, signal: AbortSignal.timeout(9000) }); return r.status; }
  catch (e) { return 'ERR:' + String(e).slice(0, 40); }
}

async function json(url, opts) {
  try {
    const r = await fetch(url, { headers: UA, ...opts, signal: AbortSignal.timeout(12000) });
    if (r.status !== 200) return { status: r.status };
    return { status: 200, body: await r.json() };
  } catch (e) { return { status: 'ERR:' + String(e).slice(0, 40) }; }
}

const GH = ['gainsight', 'rubrik', 'nutanix', 'netskope', 'mongodb', 'confluent', 'splunk', 'sumologic', 'hackerrank', 'zetwerk', 'inmobi', 'glance', 'sharechat', 'jujama', 'rippling', 'gong', 'clari', 'medallia', 'microfocus', 'opensearch', 'salesloft', 'outreach', 'gusto', 'blend', 'plaid', 'ramp', 'notion', 'benchling', 'airtable', 'webflow', 'zapier', 'twilio', 'square', 'block', 'coinbase', 'current', 'chime'];
const LEVER = ['hackerrank', 'sharechat', 'jupitermoney', 'fampay', 'koo', 'glance', 'zetwerk', 'toplyne', 'atlan', 'hasura', 'chargebee', 'postman', 'cleartap', 'netomi', 'observeai', 'uniphore', 'skit', 'vedantu', 'leverageedu', 'cuemath'];
const ASHBY_ORGS = ['ashby', 'deel', 'ramp', 'coda', 'linear', 'mitra', 'zepto', 'jupiter'];
const SR_COMPANIES = ['wipro', 'Visa', 'bosch', 'gojek', 'ocado', 'Bosch', 'Cognizant', 'accenture'];
const WORKABLE_ACCOUNTS = ['workable', 'zoho', 'audiense'];

(async () => {
  console.log('--- Greenhouse ---');
  for (const slug of GH) {
    const s = await code(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    if (s === 200) console.log('OK  gh/' + slug);
  }
  console.log('--- Lever ---');
  for (const slug of LEVER) {
    const s = await code(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    if (s === 200) console.log('OK  lever/' + slug);
  }
  console.log('--- Ashby (endpoint shape probe) ---');
  for (const org of ASHBY_ORGS.slice(0, 3)) {
    const g = await json(`https://api.ashbyhq.com/postingApi/jobBoard/${org}`);
    const p = await json(`https://api.ashbyhq.com/postingApi/jobBoard/${org}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    console.log(org, '| GET:', g.status, '| POST:', p.status, p.status === 200 ? '| keys:' + Object.keys(p.body).slice(0, 5) : '');
  }
  console.log('--- SmartRecruiters ---');
  for (const c of SR_COMPANIES.slice(0, 4)) {
    const r = await json(`https://api.smartrecruiters.com/v1/companies/${c}/postings?limit=10`);
    console.log(c, '| status:', r.status, r.status === 200 ? '| total found: ' + (r.body.totalFound || '?') : '');
  }
  console.log('--- Workable ---');
  for (const a of WORKABLE_ACCOUNTS) {
    const r = await json(`https://apply.workable.com/api/v3/accounts/${a}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '', limit: 10 }) });
    console.log(a, '| status:', r.status, r.status === 200 ? '| jobs: ' + (r.body.jobs ? r.body.jobs.length : Object.keys(r.body).slice(0, 4)) : '');
  }
})();
