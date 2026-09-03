'use strict';
/**
 * match.js — deterministic (no-API-key) matching & signals engine.
 *  - extractSkills(): dictionary-based skill/entity extraction
 *  - matchScore():    weighted TF-IDF cosine over full text + skill overlap boost → 0..100
 *  - jobSignals():    estimated competition / recruiter strictness / fit sensitivity (honest heuristics)
 *  - keywordGap():    top skills in the posting missing from the CV
 *  - atsCheck():      resume formatting heuristics → 0..100 + tips
 */
const { db } = require('./db');

const SKILLS = new Set([
  // engineering
  'python','java','javascript','typescript','go','golang','rust','kotlin','swift','c++','c#','php','ruby','scala','bash','sql',
  'react','react native','next.js','vue','angular','svelte','node.js','express','django','flask','fastapi','spring','spring boot','rails','.net',
  'html','css','tailwind','bootstrap','rest api','graphql','grpc','microservices','system design','distributed systems','concurrency','multithreading',
  'aws','gcp','azure','docker','kubernetes','terraform','ansible','ci/cd','jenkins','github actions','gitlab ci','linux','nginx','devops','sre',
  'postgresql','mysql','sqlite','mongodb','redis','elasticsearch','cassandra','dynamodb','snowflake','bigquery','kafka','rabbitmq','spark','hadoop','airflow','dbt','etl','data warehouse','data modeling',
  'machine learning','deep learning','nlp','llm','computer vision','pytorch','tensorflow','keras','scikit-learn','pandas','numpy','matplotlib','hugging face','langchain','rag','fine-tuning','mlops','prompt engineering',
  'android','ios','flutter','swiftui','jetpack compose',
  'unit testing','jest','cypress','selenium','playwright','tdd','observability','prometheus','grafana','datadog','splunk',
  'security','oauth','jwt','encryption','penetration testing','soc 2','iso 27001','gdpr','privacy','appsec',
  'blockchain','solidity','web3','smart contracts',
  // product / data / business
  'product management','product strategy','roadmap','prioritization','backlog','user stories','jira','confluence','okr','kpi','a/b testing','experimentation','causal inference','statistics','forecasting','pricing','monetization','unit economics','market research','competitive analysis','go-to-market','gtm','customer research','user research','usability','analytics','mixpanel','amplitude','google analytics',
  'tableau','power bi','looker','excel','advanced excel','google sheets','dashboards','reporting','data visualization',
  'fintech','payments','upi','lending','credit risk','risk management','compliance','kyc','aml','fraud','underwriting','banking','insurance','reinsurance','claims','actuarial',
  'sales','b2b','b2c','saas','crm','salesforce','hubspot','lead generation','account management','customer success','onboarding','retention','churn','upsell','negotiation','partnerships','business development','pre-sales','solution selling',
  'marketing','seo','sem','ppc','content marketing','social media','brand','growth','lifecycle','email marketing','performance marketing','copywriting','campaign management',
  'supply chain','logistics','operations','inventory','demand planning','procurement','vendor management','quality assurance','six sigma','lean','process improvement',
  'fp&a','financial modeling','valuation','accounting','gaap','ifrs','tax','audit','treasury','budgeting','variance analysis','mis','zoho books','quickbooks','tally','gst','ind as',
  'hr','recruiting','talent acquisition','hiring','interviewing','employer branding','payroll','hris','performance management','employee engagement','learning and development','l&d','training',
  // soft / process
  'communication','stakeholder management','cross-functional','leadership','mentoring','coaching','presentation','problem solving','critical thinking','documentation','technical writing','project management','program management','agile','scrum','kanban','waterfall','risk analysis','time management','collaboration','remote work','hiring strategy','vendor negotiation','client handling','escalation management','sla management'
]);

const STOP = new Set(['the','a','an','and','or','of','to','in','for','with','on','at','by','from','as','is','are','be','been','will','you','your','we','our','they','their','this','that','it','its','have','has','had','do','does','not','but','if','then','than','so','such','can','may','should','would','must','about','into','over','under','across','within','per','using','use','used','work','working','role','team','teams','company','candidate','candidates','experience','experienced','years','year','plus','strong','good','great','excellent','knowledge','understanding','ability','able','skills','skill','including','include','includes','etc','new','other','others','more','most','all','any','every','who','whom','which','what','when','where','while','also','well','best','like','across','against','along','already','always','among','around','because','before','being','below','between','both','during','each','either','few','further','here','how','however','just','least','less','let','many','may','maybe','me','might','mine','more','much','need','needs','never','none','no','nor','nothing','now','off','often','once','one','only','onto','own','same','several','should','since','some','someone','something','still','take','takes','them','there','these','thing','things','think','those','through','too','toward','two','up','us','very','via','want','way','ways','were','what','which','while','whoever','why','will','with','without','would','yet']);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#./ -]/g, ' ')
    .split(/[\s/,-]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, '').trim())
    .filter((t) => t.length >= 2 && !STOP.has(t) && !/^\d+$/.test(t));
}

function extractSkills(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9+#./ -]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const found = [];
  for (const s of SKILLS) {
    const pattern = '\\b' + s.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b';
    if (new RegExp(pattern).test(t)) found.push(s);
  }
  return found;
}

function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

function cosine(tf1, tf2) {
  let dot = 0, n1 = 0, n2 = 0;
  for (const [, v] of tf1) n1 += v * v;
  for (const [k, v] of tf2) { n2 += v * v; const u = tf1.get(k); if (u) dot += u * v; }
  if (!n1 || !n2) return 0;
  return dot / Math.sqrt(n1 * n2);
}

/** Job skills cached at ingest; CV skills computed on save. */
function matchScore(cvText, cvSkills, jobText, jobSkills) {
  const cvS = new Set(cvSkills || extractSkills(cvText));
  const jobS = new Set(jobSkills || extractSkills(jobText));
  let overlap = 0;
  for (const s of jobS) if (cvS.has(s)) overlap++;
  const skillBoost = jobS.size ? overlap / jobS.size : 0;           // recall of job skills by CV
  const cov = cvS.size ? overlap / cvS.size : 0;                     // precision: CV skills used by job
  const textSim = cosine(termFreq(tokenize(cvText)), termFreq(tokenize(jobText)));
  // 55% skill recall, 20% skill precision, 25% text similarity
  const score = Math.round(100 * (0.55 * skillBoost + 0.20 * cov + 0.25 * Math.min(1, textSim * 2.2)));
  return { score: Math.max(0, Math.min(100, score)), overlap, skillBoost, textSim };
}

function jobSignals(job, m) {
  const ageH = job.first_seen_at ? (Date.now() - job.first_seen_at) / 3.6e6 : 999;
  const direct = job.source === 'greenhouse' || job.source === 'lever' || job.source === 'careers-page';
  let competition;
  if (ageH <= 24 && direct) competition = 'Low — early window, sourced directly from the careers page';
  else if (ageH <= 72 && direct) competition = 'Low–Medium — still ahead of most boards';
  else if (ageH <= 168) competition = 'Medium — circulating for about a week';
  else competition = 'High — widely circulated, expect volume';

  const d = (job.description || '').toLowerCase();
  const hardReq = ['must have', 'must-have', 'required', 'requirement', 'minimum of', 'at least', 'years of experience', 'expert', 'advanced', 'proven', 'deep', 'strong background'].filter((k) => d.includes(k)).length;
  const degree = /(b\.?tech|bachelor|master|m\.?tech|mba|phd)/.test(d);
  const strict = hardReq + (degree ? 2 : 0);
  const strictness = strict >= 6 ? 'High — long hard-requirements list' : strict >= 3 ? 'Medium — standard bar' : 'Low — flexible must-haves';

  let fitSens;
  if (m.skillBoost >= 0.6) fitSens = 'Skills-led — your stack dominates the shortlist call';
  else if (m.skillBoost >= 0.3) fitSens = 'Balanced — skills and narrative both matter here';
  else fitSens = 'Narrative-sensitive — keywords alone won\'t carry this one';
  return { competition, strictness, fitSens, ageHours: Math.round(ageH), directSource: direct };
}

function keywordGap(cvText, cvSkills, jobText, jobSkills, topN = 8) {
  const cvS = new Set((cvSkills || extractSkills(cvText)).map((s) => s.toLowerCase()));
  const jobS = jobSkills || extractSkills(jobText);
  return jobS.filter((s) => !cvS.has(String(s).toLowerCase())).slice(0, topN);
}

function atsCheck(text) {
  const t = String(text || '');
  const words = t.split(/\s+/).filter(Boolean).length;
  const checks = [];
  const add = (ok, label, tip) => checks.push({ ok: !!ok, label, tip: ok ? null : tip });
  add(/[\w.+-]+@[\w-]+\.[\w.]+/.test(t), 'Email found', 'Add a professional email near the top.');
  add(/(\+?\d[\d\s-]{8,}\d)/.test(t), 'Phone found', 'Add a phone number with country code.');
  add(/linkedin\.com\/(in|pub)\//i.test(t), 'LinkedIn URL found', 'Add your LinkedIn profile URL.');
  add(/experience|employment|work history/i.test(t), 'Experience section', 'Add a clear "Experience" heading.');
  add(/education|b\.?tech|bachelor|university|college/i.test(t), 'Education section', 'Add an "Education" section.');
  add(/skill/i.test(t), 'Skills section', 'Add a "Skills" section with hard keywords.');
  add(words >= 250 && words <= 1100, `Length ${words} words (250–1100 ideal)`, words < 250 ? 'Too thin — flesh out impact per role.' : 'Too long — trim to the last ~10 years.');
  add((t.match(/\n[-•*]|\s[-•*]\s/g) || []).length >= 5, 'Bullet points used', 'Convert dense paragraphs into achievement bullets.');
  add(/\b(20\d{2})\b/.test(t), 'Dates present', 'Add year ranges (e.g., 2021–2024) for each role.');
  add(!/\bI\b|\bmy\b|\bmyself\b/i.test(t.slice(0, 800)) || true, 'Third-person style (info)', 'Prefer "Led", "Built" over "I led", "my".');
  const score = Math.round((checks.filter((c) => c.ok).length / checks.length) * 100);
  return { score, checks };
}

function analyzeJobAgainstLatestCv(job) {
  const cv = db.prepare('SELECT * FROM cvs ORDER BY id DESC LIMIT 1').get();
  if (!cv) return { hasCv: false };
  const cvSkills = cv.skills ? JSON.parse(cv.skills) : extractSkills(cv.text);
  const jobSkills = job.skills ? JSON.parse(job.skills) : extractSkills((job.title || '') + ' ' + (job.description || ''));
  const jobText = (job.title || '') + '\n' + (job.description || '');
  const m = matchScore(cv.text, cvSkills, jobText, jobSkills);
  return {
    hasCv: true,
    cvId: cv.id,
    cvName: cv.name,
    score: m.score,
    matchedSkills: (jobSkills || []).filter((s) => cvSkills.map((x) => x.toLowerCase()).includes(String(s).toLowerCase())),
    missingSkills: keywordGap(cv.text, cvSkills, jobText, jobSkills),
    signals: jobSignals(job, m)
  };
}

module.exports = { SKILLS, STOP, tokenize, extractSkills, matchScore, jobSignals, keywordGap, atsCheck, analyzeJobAgainstLatestCv };
