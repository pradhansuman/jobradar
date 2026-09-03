'use strict';
/**
 * tailor.js — per-job resume tailoring + rendering (pdf / docx / txt / preview).
 *
 * Integrity rule: the engine NEVER invents experience. It reorders and emphasizes
 * what the CV already contains, mirrors the posting's vocabulary for skills the
 * user has, and only adds "missing" skills the user explicitly claims via the
 * review checkboxes.
 */
const { extractSkills, matchScore, keywordGap, STOP } = require('./match');

/* ---------- tailoring ---------- */

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

function detectYears(cvText) {
  const years = (String(cvText).match(/\b(19[89]\d|20[0-4]\d)\b/g) || []).map(Number).filter((y) => y >= 1980 && y <= new Date().getFullYear());
  if (!years.length) return null;
  const span = new Date().getFullYear() - Math.min(...years);
  return span >= 1 && span <= 45 ? span : null;
}

function bodyWithoutHeader(cvText, name, contactLines) {
  let lines = String(cvText || '').split('\n');
  if (name && lines[0] && lines[0].trim() === name) lines = lines.slice(1);
  const drop = new Set(contactLines);
  lines = lines.filter((l) => !drop.has(l.trim()));
  return lines.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n').trim();
}

const SECTION_HEADERS = /^(summary|professional summary|objective|profile|about me|skills?|technical skills|core competencies|core skills|key skills|areas of expertise|competencies|skills & tools|technologies)\s*:?\s*$/i;
const CAPS_HEADER = /^(?!.*[a-z]{4})[A-Z0-9][A-Z0-9 &,/.'-]{2,48}:?$/;

/** Remove the CV's own skills/summary blocks (they get rebuilt canonically). Returns { body, removed } */
function stripDuplicateSections(cvText) {
  const lines = String(cvText || '').split('\n');
  const out = [];
  let removed = 0, skipping = false;
  for (const line of lines) {
    const t = line.trim();
    if (SECTION_HEADERS.test(t)) { skipping = true; removed++; continue; }
    if (skipping && t && (SECTION_HEADERS.test(t) || (CAPS_HEADER.test(t) && !t.endsWith('.')))) { skipping = false; out.push(line); continue; }
    if (skipping && !t) continue; // drop blank lines inside removed blocks
    skipping = false;
    out.push(line);
  }
  return { body: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed };
}

/** Top requirement phrases from the posting (frequent bigrams), excluding skill tokens already used. */
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

  const target = `${job.title} — ${job.company}${job.location ? ` (${job.location})` : ''}`;
  const summaryBits = [];
  summaryBits.push(`${years ? years + '+ years of ' : 'Hands-on '}experience${matched.length ? ` across ${matched.slice(0, 4).join(', ')}` : ''}.`);
  summaryBits.push(`Strong fit for this role: ${matched.length}/${jobSkills.length || matched.length} core requirements already matched${claimed.length ? `, plus ${claimed.length} you confirmed` : ''}.`);
  const summary = summaryBits.join(' ');
  const emphasis = jdEmphasis(job.description, jobSkills);
  const stripped = stripDuplicateSections(bodyWithoutHeader(cvText, name, contact));
  const changes = [];
  changes.push('Added target-role & fit header');
  changes.push('Rebuilt skills section, prioritized for this posting');
  if (claimed.length) changes.push(`Added ${claimed.length} skill${claimed.length === 1 ? '' : 's'} you confirmed`);
  if (stripped.removed) changes.push(`Removed ${stripped.removed} duplicate section${stripped.removed === 1 ? '' : 's'} from the original`);
  if (emphasis.length) changes.push("Mirrored the posting's key requirement language");

  return {
    name,
    contact,
    target,
    score: m.score,
    summary,
    emphasis,
    coreSkills: matched,
    additionalSkills: additional,
    claimedSkills: claimed,
    unclaimedGaps: missing.filter((s) => !claimed.includes(s)),
    body: stripped.body,
    changes,
    job: { uid: job.uid, title: job.title, company: job.company, url: job.url }
  };
}

/* ---------- renderers ---------- */

const ROLE_LINE = (t) => `TARGET ROLE: ${t.target}`;
const SCORE_LINE = (t) => `FIT FOR THIS ROLE: ${t.score}% — ${t.coreSkills.length} core skills matched`;

function plainLines(t) {
  const L = [];
  L.push(t.name.toUpperCase());
  if (t.contact.length) L.push(t.contact.join('  |  '));
  L.push('');
  L.push(ROLE_LINE(t.target));
  L.push(SCORE_LINE(t));
  if (t.emphasis && t.emphasis.length) L.push('ROLE EMPHASIS: ' + t.emphasis.join(' · '));
  L.push('');
  L.push('SUMMARY');
  L.push(t.summary);
  L.push('');
  L.push('CORE SKILLS FOR THIS ROLE');
  L.push(t.coreSkills.join('  ·  ') || '(none matched — review the gap report)');
  if (t.claimedSkills.length) { L.push('CONFIRMED ADDITIONS'); L.push(t.claimedSkills.join('  ·  ')); }
  if (t.additionalSkills.length) { L.push(''); L.push('ADDITIONAL SKILLS'); L.push(t.additionalSkills.join('  ·  ')); }
  L.push('');
  L.push('EXPERIENCE & BACKGROUND');
  L.push(t.body || '(original resume body)');
  return L;
}

function renderTxt(t) { return plainLines(t).join('\n'); }

async function renderPdf(t) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margins: { top: 42, bottom: 42, left: 48, right: 48 }, info: { Title: `${t.name} — ${t.job.title}` } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', resolve));

  const W = doc.page.width - 96;
  doc.font('Helvetica-Bold').fontSize(17).text(t.name, { width: W });
  doc.font('Helvetica').fontSize(9.5).fillColor('#444444').text(t.contact.join('  |  '), { width: W });
  doc.moveTo(48, doc.y + 4).lineTo(48 + W, doc.y + 4).lineWidth(0.8).strokeColor('#2a6df4').stroke();
  doc.moveDown(0.6);

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#2a6df4').text(ROLE_LINE(t), { width: W });
  doc.font('Helvetica').fontSize(9).fillColor('#333333').text(SCORE_LINE(t), { width: W });
  if (t.emphasis && t.emphasis.length) {
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#555555').text('Role emphasis: ' + t.emphasis.join(' · '), { width: W });
  }
  doc.moveDown(0.5);

  doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111111').text('SUMMARY', { width: W });
  doc.font('Helvetica').fontSize(9.5).fillColor('#222222').text(t.summary, { width: W });
  doc.moveDown(0.4);

  doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111111').text('CORE SKILLS FOR THIS ROLE', { width: W });
  doc.font('Helvetica').fontSize(9.5).fillColor('#222222').text(t.coreSkills.join('  ·  ') || '(none matched)', { width: W });
  if (t.claimedSkills.length) {
    doc.moveDown(0.2);
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111111').text('CONFIRMED ADDITIONS', { width: W });
    doc.font('Helvetica').fontSize(9.5).fillColor('#222222').text(t.claimedSkills.join('  ·  '), { width: W });
  }
  if (t.additionalSkills.length) {
    doc.moveDown(0.2);
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111111').text('ADDITIONAL SKILLS', { width: W });
    doc.font('Helvetica').fontSize(9.5).fillColor('#222222').text(t.additionalSkills.join('  ·  '), { width: W });
  }
  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111111').text('EXPERIENCE & BACKGROUND', { width: W });
  doc.font('Helvetica').fontSize(9.5).fillColor('#222222').text(t.body || '(original resume body)', { width: W });

  doc.end();
  await done;
  return Buffer.concat(chunks);
}

async function renderDocx(t) {
  const docx = require('docx');
  const P = (text, opts = {}) => new docx.Paragraph({ children: [new docx.TextRun({ text, bold: !!opts.bold, size: opts.size || 20, color: opts.color || '222222' })], spacing: { after: opts.after == null ? 80 : opts.after } });
  const children = [
    P(t.name.toUpperCase(), { bold: true, size: 34, after: 60 }),
    P(t.contact.join('  |  '), { size: 18, color: '555555', after: 160 }),
    P(ROLE_LINE(t), { bold: true, size: 19, color: '2a6df4' }),
    P(SCORE_LINE(t), { size: 18 }),
    ...(t.emphasis && t.emphasis.length ? [P('Role emphasis: ' + t.emphasis.join(' · '), { size: 17, color: '555555', after: 120 })] : []),
    P('SUMMARY', { bold: true, size: 22, after: 40 }),
    P(t.summary),
    P('CORE SKILLS FOR THIS ROLE', { bold: true, size: 22, after: 40 }),
    P(t.coreSkills.join('  ·  ') || '(none matched)')
  ];
  if (t.claimedSkills.length) { children.push(P('CONFIRMED ADDITIONS', { bold: true, size: 22, after: 40 })); children.push(P(t.claimedSkills.join('  ·  '))); }
  if (t.additionalSkills.length) { children.push(P('ADDITIONAL SKILLS', { bold: true, size: 22, after: 40 })); children.push(P(t.additionalSkills.join('  ·  '))); }
  children.push(P('EXPERIENCE & BACKGROUND', { bold: true, size: 22, after: 40 }));
  for (const para of (t.body || '(original resume body)').split(/\n{1,}/)) {
    if (para.trim()) children.push(P(para.trim()));
  }
  const doc = new docx.Document({ sections: [{ properties: {}, children }] });
  const buf = await docx.Packer.toBuffer(doc);
  return Buffer.from(buf);
}

function renderPreviewHtml(t) {
  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pills = (arr, cls) => arr.map((s) => `<span class="pill ${cls || ''}">${esc(s)}</span>`).join('');
  return `
    <div class="pv-name">${esc(t.name.toUpperCase())}</div>
    <div class="pv-contact">${esc(t.contact.join('  |  '))}</div>
    <div class="pv-target">${esc(ROLE_LINE(t))} · ${esc(SCORE_LINE(t))}</div>
    ${t.emphasis && t.emphasis.length ? `<div class="pv-t" style="color:#8fa0bf">Role emphasis: ${esc(t.emphasis.join(' · '))}</div>` : ''}
    ${t.changes && t.changes.length ? `<div class="pv-t" style="margin-top:6px"><b>What changed:</b> ${esc(t.changes.join(' · '))}</div>` : ''}
    <div class="pv-h">Summary</div><div class="pv-t">${esc(t.summary)}</div>
    <div class="pv-h">Core skills for this role</div><div class="pv-t">${pills(t.coreSkills, 'hit') || '<i>none matched</i>'}</div>
    ${t.claimedSkills.length ? `<div class="pv-h">Confirmed additions</div><div class="pv-t">${pills(t.claimedSkills, 'hit')}</div>` : ''}
    ${t.additionalSkills.length ? `<div class="pv-h">Additional skills</div><div class="pv-t">${pills(t.additionalSkills)}</div>` : ''}
    ${t.unclaimedGaps.length ? `<div class="pv-h">Gaps you chose NOT to add</div><div class="pv-t">${pills(t.unclaimedGaps, 'miss')}</div>` : ''}
    <div class="pv-h">Experience & background</div><pre class="pv-body">${esc(t.body || '(original resume body)')}</pre>`;
}

async function renderTailored(t, format) {
  if (format === 'pdf') { const buf = await renderPdf(t); return { buf, mime: 'application/pdf', ext: 'pdf' }; }
  if (format === 'docx') { const buf = await renderDocx(t); return { buf, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' }; }
  if (format === 'txt') return { buf: Buffer.from(renderTxt(t), 'utf8'), mime: 'text/plain', ext: 'txt' };
  return { buf: Buffer.from(renderPreviewHtml(t), 'utf8'), mime: 'text/html', ext: 'html' };
}

module.exports = { buildTailored, renderTailored, renderTxt };
