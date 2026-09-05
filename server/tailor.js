'use strict';
/**
 * tailor.js — per-job resume tailoring + rendering (pdf / docx / txt / preview).
 *
 * Integrity rules:
 *  - NEVER invents experience; missing skills are added only when the user claims them.
 *  - The rendered document is a real resume: no fit scores, no app jargon, no
 *    "what changed" traces. App metadata (score, gaps, changes) is returned
 *    separately as `meta` for the UI only.
 */
const { extractSkills, matchScore, keywordGap, STOP } = require('./match');

/* ---------- CV structure detection ---------- */

function detectName(cvText) {
  const first = String(cvText || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
  const words = first.split(/\s+/);
  if (first.length <= 48 && words.length <= 5 && !/[@\d]/.test(first) && /^[A-Za-z .'-]+$/.test(first)) return first;
  return null;
}

function detectContactLines(cvText) {
  return String(cvText || '').split('\n').map((l) => l.trim())
    .filter((l) => l && (/[\w.+-]+@[\w-]+\.[\w.]+/.test(l) || /(\+?\d[\d\s-]{8,}\d)/.test(l) || /linkedin\.com|github\.com/i.test(l)))
    .slice(0, 3);
}

/** The CV's own headline, e.g. "QA Director | Quality Engineering Leader | AI Quality" */
function detectHeadline(cvText) {
  const lines = String(cvText || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4);
  for (const l of lines) {
    if (l.includes('|') && l.length <= 95 && !/[@\d]{3}/.test(l) && !/^[\W]+$/.test(l)) return l;
  }
  return null;
}

function detectYears(cvText) {
  const years = (String(cvText).match(/\b(19[89]\d|20[0-4]\d)\b/g) || []).map(Number).filter((y) => y >= 1980 && y <= new Date().getFullYear());
  if (!years.length) return null;
  const span = new Date().getFullYear() - Math.min(...years);
  return span >= 1 && span <= 45 ? span : null;
}

const SECTION_HEADERS = /^(summary|professional summary|objective|profile|about me|skills?|technical skills|core competencies|core skills|key skills|areas of expertise|competencies|skills & tools|technologies)\s*:?\s*$/i;
const CAPS_HEADER = /^(?!.*[a-z]{4})[A-Z0-9][A-Z0-9 &,/.'-]{2,48}:?$/;

/** Remove the CV's own skills/summary blocks (rebuilt canonically). */
function stripDuplicateSections(cvText) {
  const lines = String(cvText || '').split('\n');
  const out = [];
  let removed = 0, skipping = false;
  for (const line of lines) {
    const t = line.trim();
    if (SECTION_HEADERS.test(t)) { skipping = true; removed++; continue; }
    if (skipping && t && (SECTION_HEADERS.test(t) || (CAPS_HEADER.test(t) && !t.endsWith('.')))) { skipping = false; out.push(line); continue; }
    if (skipping && !t) continue;
    skipping = false;
    out.push(line);
  }
  return { body: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed };
}

/** Top requirement phrases from the posting (frequent bigrams), excluding known skill tokens. */
function jdEmphasis(jobDescription, existingSkills) {
  const text = String(jobDescription || '').toLowerCase();
  if (!text) return [];
  const tokens = text.replace(/[^a-z0-9+#. ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
  const skillWords = new Set(existingSkills.join(' ').split(/[^a-z0-9+#.]+/));
  const bi = new Map();
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i], b = tokens[i + 1];
    if (skillWords.has(a) || skillWords.has(b)) continue;
    const g = a + ' ' + b;
    bi.set(g, (bi.get(g) || 0) + 1);
  }
  const phrases = [...bi.entries()].filter(([, n]) => n >= 3).sort((x, y) => y[1] - x[1]).map(([g]) => g);
  const kept = [];
  for (const p of phrases) { if (!kept.some((k) => k.includes(p) || p.includes(k))) kept.push(p); if (kept.length >= 6) break; }
  return kept.map((p) => p.replace(/\b\w/g, (c) => c.toUpperCase()));
}

const BUCKETS = {
  'software engineering': ['javascript', 'typescript', 'react', 'vue', 'angular', 'node.js', 'express', 'django', 'flask', 'fastapi', 'spring', 'spring boot', 'rails', '.net', 'rest api', 'graphql', 'grpc', 'microservices', 'system design', 'distributed systems', 'java', 'python', 'go', 'golang', 'rust', 'kotlin', 'swift', 'scala', 'php', 'ruby', 'c++', 'c#', 'html', 'css'],
  'cloud & devops': ['aws', 'gcp', 'azure', 'docker', 'kubernetes', 'terraform', 'ansible', 'ci/cd', 'jenkins', 'github actions', 'gitlab ci', 'linux', 'nginx', 'devops', 'sre', 'observability', 'prometheus', 'grafana', 'datadog'],
  'data & ai': ['machine learning', 'deep learning', 'nlp', 'llm', 'computer vision', 'pytorch', 'tensorflow', 'scikit-learn', 'pandas', 'numpy', 'spark', 'kafka', 'airflow', 'dbt', 'etl', 'data warehouse', 'snowflake', 'bigquery', 'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'prompt engineering', 'rag', 'mlops', 'sql', 'data modeling', 'statistics', 'tableau', 'power bi', 'looker'],
  'quality & security': ['qa', 'automation', 'selenium', 'cypress', 'playwright', 'jest', 'unit testing', 'tdd', 'penetration testing', 'security', 'oauth', 'encryption', 'soc 2', 'iso 27001', 'gdpr', 'privacy', 'appsec'],
  'product & delivery': ['product management', 'product strategy', 'roadmap', 'agile', 'scrum', 'kanban', 'stakeholder management', 'leadership', 'mentoring', 'program management', 'project management', 'okr', 'kpi', 'analytics', 'a/b testing']
};
function topDomains(skills) {
  const scores = {};
  const lower = skills.map((s) => s.toLowerCase());
  for (const [bucket, list] of Object.entries(BUCKETS)) {
    let n = 0;
    for (const s of lower) if (list.includes(s)) n++;
    if (n) scores[bucket] = n;
  }
  return Object.entries(scores).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([b]) => b);
}

/* ---------- tailoring ---------- */

function buildTailored({ cvText, cvSkills, job, includeSkills }) {
  const jobSkills = job.skills ? JSON.parse(job.skills) : extractSkills(`${job.title} ${job.description || ''}`);
  const jobText = `${job.title}\n${job.description || ''}`;
  const m = matchScore(cvText, cvSkills, jobText, jobSkills);
  const missing = keywordGap(cvText, cvSkills, jobText, jobSkills, 20);

  const claimed = (includeSkills || []).filter((s) => missing.includes(s));
  const name = detectName(cvText) || 'Your Name';
  const contact = detectContactLines(cvText);
  const years = detectYears(cvText);
  const cvSet = new Set(cvSkills.map((s) => s.toLowerCase()));

  const matched = jobSkills.filter((s) => cvSet.has(String(s).toLowerCase()) || claimed.map((c) => c.toLowerCase()).includes(String(s).toLowerCase()));
  const additional = cvSkills.filter((s) => !matched.map((x) => x.toLowerCase()).includes(String(s).toLowerCase()));

  const headline = detectHeadline(cvText);
  const domains = topDomains([...matched, ...cvSkills]);
  const emphasis = jdEmphasis(job.description, jobSkills);

  // Professional summary: identity → relevance → coverage. No scores, no counts.
  const lead = headline
    ? `${headline.replace(/\s*\|\s*/g, ' · ')} — ${years ? years + '+ years' : 'extensive experience'}${domains.length ? ' across ' + domains.join(' and ') : ''}.`
    : `${years ? years + '+ years of experience' : 'Experienced professional'}${domains.length ? ' across ' + domains.join(' and ') : ''}.`;
  const rel = matched.length
    ? `Directly relevant to the ${job.title} mandate: brings ${matched.slice(0, 5).join(', ')}.`
    : `Applying a broad background to the ${job.title} mandate.`;
  const claimedBit = claimed.length ? ` Current working depth in ${claimed.join(', ')}.` : '';
  const summary = `${lead} ${rel}${claimedBit}`;

  // Single skills section when coverage is thin; two-tier only when it earns it.
  const twoTier = matched.length >= 4;
  // drop name/contact header lines, then strip the CV's own summary/skills blocks
  let bodyLines = String(cvText || '').split('\n');
  if (name && bodyLines[0] && bodyLines[0].trim() === name) bodyLines = bodyLines.slice(1);
  const dropSet = new Set(contact);
  bodyLines = bodyLines.filter((l) => !dropSet.has(l.trim()));
  const stripped = stripDuplicateSections(bodyLines.join('\n'));
  const changes = [];
  changes.push('Rebuilt skills section, prioritized for this posting');
  if (claimed.length) changes.push(`Added ${claimed.length} skill${claimed.length === 1 ? '' : 's'} you confirmed`);
  if (stripped.removed) changes.push(`Merged ${stripped.removed} duplicate section${stripped.removed === 1 ? '' : 's'} from the original`);
  if (emphasis.length) changes.push("Mirrored the posting's key requirement language");

  return {
    // document fields
    name,
    contact,
    headline: headline || null,
    summary,
    coreSkills: matched,
    additionalSkills: additional,
    twoTier,
    body: stripped.body,
    // app-only metadata (never rendered into the document)
    meta: {
      score: m.score,
      matchedCount: matched.length,
      jobSkillsCount: jobSkills.length,
      target: `${job.title} — ${job.company}${job.location ? ` (${job.location})` : ''}`,
      emphasis,
      claimedSkills: claimed,
      unclaimedGaps: missing.filter((s) => !claimed.includes(s)),
      changes
    },
    job: { uid: job.uid, title: job.title, company: job.company, url: job.url }
  };
}

/* ---------- renderers (document only — no app jargon) ---------- */

function plainLines(t) {
  const L = [];
  L.push(t.name.toUpperCase());
  if (t.contact.length) L.push(t.contact.join('  |  '));
  if (t.headline) L.push(t.headline);
  L.push('');
  L.push('SUMMARY');
  L.push(t.summary);
  L.push('');
  if (t.twoTier) {
    L.push('CORE SKILLS');
    L.push(t.coreSkills.join('  ·  '));
    if (t.additionalSkills.length) { L.push(''); L.push('ADDITIONAL SKILLS'); L.push(t.additionalSkills.join('  ·  ')); }
  } else {
    L.push('KEY SKILLS');
    L.push([...t.coreSkills, ...t.additionalSkills].join('  ·  ') || '(none)');
  }
  L.push('');
  L.push('EXPERIENCE & BACKGROUND');
  L.push(t.body || '(original resume body)');
  return L;
}

function renderTxt(t) { return plainLines(t).join('\n'); }

async function renderPdf(t) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margins: { top: 46, bottom: 46, left: 50, right: 50 }, info: { Title: `${t.name} — Resume` } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', resolve));

  const W = doc.page.width - 100;
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#111111').text(t.name, { width: W });
  doc.font('Helvetica').fontSize(9.5).fillColor('#555555').text(t.contact.join('   ·   '), { width: W });
  if (t.headline) doc.font('Helvetica-Oblique').fontSize(10).fillColor('#2a6df4').text(t.headline, { width: W });
  const y = doc.y + 8;
  doc.moveTo(50, y).lineTo(50 + W, y).lineWidth(0.8).strokeColor('#2a6df4').stroke();
  doc.moveDown(0.9);

  const H = (s) => { doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111111').text(s.toUpperCase(), { width: W, characterSpacing: 0.5 }); doc.moveDown(0.15); };
  const T = (s, italic) => { doc.font(italic ? 'Helvetica-Oblique' : 'Helvetica').fontSize(9.5).fillColor('#222222').text(s, { width: W }); };

  H('Summary'); T(t.summary); doc.moveDown(0.5);
  if (t.twoTier) {
    H('Core skills'); T(t.coreSkills.join('  ·  ')); doc.moveDown(0.4);
    if (t.additionalSkills.length) { H('Additional skills'); T(t.additionalSkills.join('  ·  ')); doc.moveDown(0.4); }
  } else {
    H('Key skills'); T([...t.coreSkills, ...t.additionalSkills].join('  ·  ')); doc.moveDown(0.4);
  }
  H('Experience & background');
  for (const para of (t.body || '(original resume body)').split(/\n{1,}/)) {
    if (para.trim()) T(para.trim());
    else doc.moveDown(0.2);
  }

  // footer page numbers
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font('Helvetica').fontSize(8).fillColor('#999999').text(`${i + 1} / ${range.count}`, 50, doc.page.height - 36, { width: W, align: 'center' });
  }

  doc.end();
  await done;
  return Buffer.concat(chunks);
}

async function renderDocx(t) {
  const docx = require('docx');
  const P = (text, opts = {}) => new docx.Paragraph({
    children: [new docx.TextRun({ text, bold: !!opts.bold, italics: !!opts.italics, size: opts.size || 20, color: opts.color || '222222' })],
    spacing: { after: opts.after == null ? 80 : opts.after }
  });
  const children = [
    P(t.name.toUpperCase(), { bold: true, size: 34, after: 40 }),
    P(t.contact.join('   ·   '), { size: 18, color: '555555', after: t.headline ? 20 : 140 }),
  ];
  if (t.headline) children.push(P(t.headline, { italics: true, size: 20, color: '2a6df4', after: 140 }));
  children.push(P('SUMMARY', { bold: true, size: 21, after: 40 }));
  children.push(P(t.summary));
  if (t.twoTier) {
    children.push(P('CORE SKILLS', { bold: true, size: 21, after: 40 }));
    children.push(P(t.coreSkills.join('  ·  ')));
    if (t.additionalSkills.length) { children.push(P('ADDITIONAL SKILLS', { bold: true, size: 21, after: 40 })); children.push(P(t.additionalSkills.join('  ·  '))); }
  } else {
    children.push(P('KEY SKILLS', { bold: true, size: 21, after: 40 }));
    children.push(P([...t.coreSkills, ...t.additionalSkills].join('  ·  ')));
  }
  children.push(P('EXPERIENCE & BACKGROUND', { bold: true, size: 21, after: 40 }));
  for (const para of (t.body || '(original resume body)').split(/\n{1,}/)) {
    if (para.trim()) children.push(P(para.trim()));
  }
  const doc = new docx.Document({ sections: [{ properties: {}, children }] });
  const buf = await docx.Packer.toBuffer(doc);
  return Buffer.from(buf);
}

/** Clean document preview — app commentary lives outside this markup. */
function renderPreviewHtml(t) {
  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pills = (arr, cls) => arr.map((s) => `<span class="pill ${cls || ''}">${esc(s)}</span>`).join('');
  const bodyParas = (t.body || '(original resume body)').split(/\n{1,}/).filter((p) => p.trim()).map((p) => `<p class="pv-p">${esc(p.trim())}</p>`).join('');
  return `
    <div class="pv-name">${esc(t.name.toUpperCase())}</div>
    <div class="pv-contact">${esc(t.contact.join('   ·   '))}</div>
    ${t.headline ? `<div class="pv-headline">${esc(t.headline)}</div>` : ''}
    <div class="pv-h">Summary</div><div class="pv-t">${esc(t.summary)}</div>
    ${t.twoTier ? `
      <div class="pv-h">Core skills</div><div class="pv-t">${pills(t.coreSkills, 'hit') || '<i>none matched</i>'}</div>
      ${t.additionalSkills.length ? `<div class="pv-h">Additional skills</div><div class="pv-t">${pills(t.additionalSkills)}</div>` : ''}` : `
      <div class="pv-h">Key skills</div><div class="pv-t">${pills([...t.coreSkills, ...t.additionalSkills]) || '<i>none</i>'}</div>`}
    <div class="pv-h">Experience & background</div><div class="pv-body">${bodyParas}</div>`;
}

async function renderTailored(t, format) {
  if (format === 'pdf') { const buf = await renderPdf(t); return { buf, mime: 'application/pdf', ext: 'pdf' }; }
  if (format === 'docx') { const buf = await renderDocx(t); return { buf, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' }; }
  if (format === 'txt') return { buf: Buffer.from(renderTxt(t), 'utf8'), mime: 'text/plain', ext: 'txt' };
  return { buf: Buffer.from(renderPreviewHtml(t), 'utf8'), mime: 'text/html', ext: 'html' };
}

module.exports = { buildTailored, renderTailored, renderTxt };
