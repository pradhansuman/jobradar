/* JobRadar frontend — vanilla JS, hash routing, no build step */
'use strict';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer = null;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function timeAgo(ts) {
  if (!ts) return '—';
  const h = Math.round((Date.now() - ts) / 3.6e6);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}

function compBadge(ageH, direct) {
  let cls, txt;
  if (ageH <= 24 && direct) { cls = 'comp-low'; txt = 'competition: low (early)'; }
  else if (ageH <= 72 && direct) { cls = 'comp-low'; txt = 'competition: low-mid'; }
  else if (ageH <= 168) { cls = 'comp-mid'; txt = 'competition: medium'; }
  else { cls = 'comp-high'; txt = 'competition: high'; }
  return `<span class="badge ${cls}">${txt}</span>`;
}

function scoreRing(score) {
  if (score == null) return '<div class="score none" title="Save a CV in CV Studio to get match scores"><span>–</span></div>';
  return `<div class="score" style="--v:${score}" title="Match score ${score}%"><span>${score}</span></div>`;
}

/* ---------- router ---------- */
const views = ['jobs', 'cv', 'alerts', 'pipeline', 'about'];
function route() {
  const name = (location.hash.replace(/^#\/?/, '') || 'jobs').split('?')[0];
  const v = views.includes(name) ? name : 'jobs';
  views.forEach((x) => { $(`#view-${x}`).hidden = x !== v; });
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === v));
  if (v === 'jobs') loadStats(), loadJobs();
  if (v === 'cv') loadCv(), loadTailorJobs();
  if (v === 'alerts') loadAlerts();
  if (v === 'pipeline') loadPipeline();
}
window.addEventListener('hashchange', route);

/* ---------- jobs ---------- */
const filters = { q: '', source: '', age: '', loc: '', sort: 'fresh' };
let debounceT = null;
let jobCache = [];

function bindFilters() {
  $('#f-q').addEventListener('input', (e) => { filters.q = e.target.value; loadJobs.offset = 0; clearTimeout(debounceT); debounceT = setTimeout(loadJobs, 300); });
  $('#f-loc').addEventListener('input', (e) => { filters.loc = e.target.value; loadJobs.offset = 0; clearTimeout(debounceT); debounceT = setTimeout(loadJobs, 300); });
  $('#f-source').addEventListener('change', (e) => { filters.source = e.target.value; loadJobs.offset = 0; loadJobs(); });
  $('#f-age').addEventListener('change', (e) => { filters.age = e.target.value; loadJobs.offset = 0; loadJobs(); });
  $('#f-sort').addEventListener('change', (e) => { filters.sort = e.target.value; loadJobs.offset = 0; loadJobs(); });
  $('#jobs-more').addEventListener('click', () => { loadJobs.offset = (loadJobs.offset || 0) + 60; loadJobs(); });
}

async function loadStats() {
  try {
    const s = await api('/api/stats');
    $('#statrow').innerHTML = `
      <div class="stat"><b>${s.jobs}</b><span>live postings</span></div>
      <div class="stat"><b>${s.last24}</b><span>first seen ≤ 24h</span></div>
      <div class="stat"><b>${s.last72}</b><span>first seen ≤ 72h</span></div>
      <div class="stat"><b>${s.companies}</b><span>companies</span></div>
      <div class="stat"><b>${s.boards}</b><span>boards tracked</span></div>
      <div class="stat"><b>${s.hasCv ? '✓' : '—'}</b><span>CV on file</span></div>`;
  } catch { /* stats are cosmetic */ }
}

function jobCard(j) {
  const fresh = j.ageHours <= 72 ? 'fresh' : '';
  return `
  <article class="job" data-uid="${esc(j.uid)}">
    <div class="top">
      <div>
        <h3>${esc(j.title)}</h3>
        <div class="co">${esc(j.company)}${j.location ? ' · ' + esc(j.location) : ''}</div>
      </div>
      ${scoreRing(j.match_score)}
    </div>
    <div class="badges">
      <span class="badge fresh">first seen ${esc(timeAgo(j.first_seen_at))}</span>
      ${compBadge(j.ageHours, j.source !== 'board')}
      <span class="badge src">${esc(j.source === 'greenhouse' ? 'Greenhouse' : j.source === 'lever' ? 'Lever' : j.source === 'smartrecruiters' ? 'SmartRecruiters' : j.source === 'remoteok' ? 'RemoteOK API' : 'Careers page')}</span>
      ${j.salary ? `<span class="badge">${esc(j.salary)}</span>` : ''}
    </div>
  </article>`;
}

async function loadJobs() {
  const list = $('#jobs-list');
  if (!loadJobs.offset) { list.innerHTML = '<div class="empty">Loading jobs…</div>'; }
  $('#jobs-empty').hidden = true;
  try {
    const p = new URLSearchParams();
    if (filters.q) p.set('q', filters.q);
    if (filters.loc) p.set('location', filters.loc);
    if (filters.source) p.set('source', filters.source);
    if (filters.age) p.set('max_age_h', filters.age);
    p.set('sort', filters.sort);
    p.set('limit', '60');
    p.set('offset', String(loadJobs.offset || 0));
    const data = await api(`/api/jobs?${p}`);
    jobCache = loadJobs.offset ? jobCache.concat(data.jobs) : data.jobs;
    $('#jobs-meta').textContent = `Showing ${jobCache.length} of ${data.total} posting${data.total === 1 ? '' : 's'}${data.hasCv ? ' · scored against your latest CV' : ' · save a CV to see match scores'}`;
    $('#jobs-more').hidden = jobCache.length >= data.total;
    const frag = data.jobs.map(jobCard).join('');
    if (loadJobs.offset) list.insertAdjacentHTML('beforeend', frag);
    else list.innerHTML = frag;
    list.querySelectorAll('.job').forEach((el) => { if (!el.dataset.bound) { el.dataset.bound = '1'; el.addEventListener('click', () => openJob(el.dataset.uid)); } });
  } catch (e) {
    list.innerHTML = `<div class="empty"><h3>Couldn't load jobs</h3><p>${esc(e.message)} — is the server running?</p></div>`;
  }
}
loadJobs.offset = 0;

async function openJob(uid) {
  try {
    const { job, description, analysis } = await api(`/api/jobs/${encodeURIComponent(uid)}`);
    const a = analysis;
    const sig = a.signals || {};
    $('#modal-body').innerHTML = `
      <h2>${esc(job.title)}</h2>
      <div class="co hint">${esc(job.company)}${job.location ? ' · ' + esc(job.location) : ''} · first seen ${esc(timeAgo(job.first_seen_at))}${job.salary ? ' · ' + esc(job.salary) : ''}</div>
      ${a.hasCv ? `
        <div class="gauge" style="margin-top:14px"><div class="score" style="--v:${a.score}"><span>${a.score}</span></div>
          <div><b>Match score</b><div class="hint">${esc(a.matchedSkills.length || 0)} of your skills match · ${esc((a.missingSkills || []).length)} gaps</div></div></div>
        <div class="pillset">${(a.matchedSkills || []).slice(0, 12).map((s) => `<span class="pill hit">${esc(s)}</span>`).join('')}
          ${(a.missingSkills || []).map((s) => `<span class="pill miss">${esc(s)}</span>`).join('')}</div>` :
        `<p class="hint" style="margin-top:12px">No CV on file — save one in <a href="#/cv">CV Studio</a> to unlock match score, gaps and fit signals.</p>`}
      <div class="pillset" style="margin-top:12px">
        ${sig.competition ? `<span class="badge ${sig.ageHours <= 72 ? 'comp-low' : 'comp-mid'}">${esc(sig.competition)}</span>` : ''}
        ${sig.strictness ? `<span class="badge">${esc(sig.strictness)}</span>` : ''}
        ${sig.fitSens ? `<span class="badge">${esc(sig.fitSens)}</span>` : ''}
      </div>
      <div class="modal-actions">
        <a href="${esc(job.url)}" target="_blank" rel="noopener"><button class="primary">Apply on ${esc(job.company)} careers page ↗</button></a>
        <button class="primary" id="tailor-this">Tailor my resume for this job</button>
        <button class="ghost" id="copy-job">Copy details for the autofill extension</button>
      </div>
      <div class="desc">${esc(description)}</div>`;
    $('#modal').hidden = false;
    $('#tailor-this').addEventListener('click', () => {
      localStorage.setItem('jobradar.tailorJob', job.uid);
      location.hash = '#/cv';
      $('#modal').hidden = true;
      toast('Job preselected in CV Studio — review the gaps and generate.');
    });
    $('#copy-job').addEventListener('click', () => {
      localStorage.setItem('jobradar.apply', JSON.stringify({ title: job.title, company: job.company, url: job.url, matched: a.matchedSkills || [], missing: a.missingSkills || [] }));
      toast('Job details copied for the extension profile.');
    });
  } catch (e) { toast(e.message, true); }
}
$('#modal-close').addEventListener('click', () => { $('#modal').hidden = true; });
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) $('#modal').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#modal').hidden = true; });

/* ---------- CV studio ---------- */
async function loadCv() {
  try {
    const { cv } = await api('/api/cv');
    if (cv) {
      if (!$('#cv-text').value) $('#cv-text').value = cv.text || '';
      if (!$('#cv-name').value) $('#cv-name').value = cv.name || '';
      renderAts(cv.ats);
      renderSkills(cv.skills);
      $('#cv-status').textContent = `Active CV “${cv.name || 'untitled'}” saved ${timeAgo(cv.created_at)}.`;
    }
    const hist = await api('/api/cv/list');
    $('#cv-history').innerHTML = hist.cvs.length ? hist.cvs.map((c) => `
      <div class="board">
        <span>#${c.id} <b>${esc(c.name || 'untitled')}</b> <span class="n">· ${c.chars} chars · saved ${esc(timeAgo(c.created_at))}</span></span>
        <span>
          ${c.active ? '<span class="badge fresh">active</span> ' : `<button class="ghost cv-use" data-id="${c.id}">Use</button> `}
          <button class="ghost cv-del" data-id="${c.id}" title="Delete">✕</button>
        </span>
      </div>`).join('') : '<div class="empty-inline">No saved resumes yet.</div>';
    $('#cv-history').querySelectorAll('.cv-use').forEach((b) => b.addEventListener('click', async () => {
      await api('/api/cv/activate/' + b.dataset.id, { method: 'POST' });
      $('#cv-text').value = ''; $('#cv-name').value = '';
      loadCv(); loadStats(); loadTailorJobs();
      toast('CV activated.');
    }));
    $('#cv-history').querySelectorAll('.cv-del').forEach((b) => b.addEventListener('click', async () => {
      await api('/api/cv/' + b.dataset.id, { method: 'DELETE' });
      $('#cv-text').value = ''; $('#cv-name').value = ''; $('#cv-status').textContent = '';
      loadCv(); loadStats(); loadTailorJobs();
      toast('CV deleted.');
    }));
  } catch { /* first run */ }
}

function renderAts(ats) {
  if (!ats) { $('#ats-result').innerHTML = '<div class="empty-inline">Save a CV to see the formatting score and tips.</div>'; return; }
  $('#ats-result').innerHTML = `
    <div class="gauge"><div class="score" style="--v:${ats.score}"><span>${ats.score}</span></div><div><b>ATS formatting score</b><div class="hint">heuristic checklist below</div></div></div>
    <div class="ats">${ats.checks.map((c) => `<div class="ats-item"><span class="${c.ok ? 'ok' : 'no'}">${c.ok ? '✓' : '✕'}</span><span>${esc(c.label)}${c.tip ? ` <span class="tip">— ${esc(c.tip)}</span>` : ''}</span></div>`).join('')}</div>`;
}

function renderSkills(skills) {
  if (!skills || !skills.length) { $('#skills-result').innerHTML = '<div class="empty-inline">Extracted skills will appear here.</div>'; return; }
  $('#skills-result').innerHTML = `<div class="pillset">${skills.map((s) => `<span class="pill hit">${esc(s)}</span>`).join('')}</div>`;
}

$('#cv-save').addEventListener('click', async () => {
  const text = $('#cv-text').value.trim();
  if (text.length < 80) return toast('Paste at least ~80 characters of CV text.', true);
  $('#cv-save').disabled = true;
  try {
    const r = await api('/api/cv', { method: 'POST', body: { name: $('#cv-name').value, text } });
    renderAts(r.ats);
    renderSkills(r.skills);
    $('#cv-status').textContent = 'Saved. Jobs list is now scored against this CV.';
    toast(`CV saved — ${r.skills.length} skills extracted, ATS score ${r.ats.score}/100.`);
    loadStats();
  } catch (e) { toast(e.message, true); }
  $('#cv-save').disabled = false;
});

$('#cv-clear').addEventListener('click', () => { $('#cv-text').value = ''; $('#cv-name').value = ''; $('#cv-file').value = ''; $('#cv-status').textContent = ''; $('#ats-result').innerHTML = '<div class="empty-inline">Save a CV to see the formatting score and tips.</div>'; $('#skills-result').innerHTML = '<div class="empty-inline">Extracted skills will appear here.</div>'; });

/* file → base64 → server-side parse (pdf/docx/doc/txt) */
async function parseFile(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) return toast('File too large — max 8 MB.', true);
  $('#cv-status').textContent = `Parsing ${file.name}…`;
  const b64 = await new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.readAsDataURL(file);
  });
  try {
    const { text, warning } = await api('/api/cv/parse', { method: 'POST', body: { filename: file.name, content_b64: b64 } });
    $('#cv-text').value = text;
    if (!$('#cv-name').value) $('#cv-name').value = file.name.replace(/\.(pdf|docx|doc|txt|md)$/i, '');
    $('#cv-status').textContent = warning || `Parsed ${file.name} — review the text, then Analyze & save.`;
    if (warning) toast(warning, true);
    else toast('Resume parsed. Review the extracted text and save.');
  } catch (e) {
    $('#cv-status').textContent = e.message;
    toast(e.message, true);
  }
}

const dz = $('#drop-zone');
dz.addEventListener('click', () => $('#cv-file').click());
dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#cv-file').click(); } });
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); parseFile(e.dataTransfer.files && e.dataTransfer.files[0]); });
$('#cv-file').addEventListener('change', (e) => parseFile(e.target.files && e.target.files[0]));

/* ---------- tailor for a job ---------- */
let tailorState = { jobUid: null, include: [], missing: [], lastBrief: null };

async function loadTailorJobs() {
  try {
    const data = await api('/api/jobs?sort=match&limit=40');
    if (!data.hasCv) { $('#tl-status').textContent = 'Save a CV first — then tailor for any posting.'; return; }
    tailorState.allJobs = data.jobs;
    renderJobOptions('');
    const handoff = localStorage.getItem('jobradar.tailorJob');
    if (handoff && data.jobs.some((j) => j.uid === handoff)) {
      $('#tl-job').value = handoff;
      localStorage.removeItem('jobradar.tailorJob');
      $('#tl-status').textContent = 'Job preselected from the posting you opened — review the gaps below.';
    }
    await refreshMissing();
  } catch { /* needs CV */ }
}

function renderJobOptions(filter) {
  const f = (filter || '').toLowerCase();
  const jobs = (tailorState.allJobs || []).filter((j) => !f || (j.title + ' ' + j.company).toLowerCase().includes(f));
  $('#tl-job').innerHTML = jobs.map((j) => `<option value="${esc(j.uid)}">${esc(j.match_score + '% · ' + j.title + ' — ' + j.company)}</option>`).join('') || '<option value="">(no jobs match that filter)</option>';
  $('#tl-job').dispatchEvent(new Event('change'));
}

async function refreshMissing() {
  tailorState.jobUid = $('#tl-job').value;
  tailorState.include = [];
  $('#tl-pdf').disabled = $('#tl-docx').disabled = $('#tl-txt').disabled = $('#tl-apply').disabled = true;
  $('#tl-preview').innerHTML = 'Generate a preview to review the tailored resume here.';
  $('#tl-missing').innerHTML = '<span class="hint">Checking skill gaps for this posting…</span>';
  if (!tailorState.jobUid) return;
  try {
    const { analysis } = await api('/api/jobs/' + encodeURIComponent(tailorState.jobUid));
    tailorState.missing = (analysis && analysis.missingSkills) || [];
    $('#tl-missing').innerHTML = tailorState.missing.length
      ? tailorState.missing.map((s) => `<span class="pill gapchip" data-skill="${esc(s)}" title="Click to claim — only add skills you actually have">+ ${esc(s)}</span>`).join('')
      : '<span class="hint">No gaps — your CV covers every skill this posting names.</span>';
    $('#tl-missing').querySelectorAll('.gapchip').forEach((el) => el.addEventListener('click', () => {
      const s = el.dataset.skill;
      if (tailorState.include.includes(s)) { tailorState.include = tailorState.include.filter((x) => x !== s); el.classList.remove('claimed'); el.textContent = '+ ' + s; }
      else { tailorState.include.push(s); el.classList.add('claimed'); el.textContent = '✓ ' + s; }
    }));
  } catch (e) { $('#tl-missing').innerHTML = `<span class="hint">${esc(e.message)}</span>`; }
}

$('#tl-job').addEventListener('change', refreshMissing);
$('#tl-filter') && $('#tl-filter').addEventListener('input', (e) => {
  clearTimeout(window.__tlDebounce); window.__tlDebounce = setTimeout(() => renderJobOptions(e.target.value), 250);
});

$('#tl-generate').addEventListener('click', async () => {
  if (!$('#tl-job').value) return toast('Save a CV first.', true);
  $('#tl-generate').disabled = true;
  $('#tl-status').textContent = 'Building tailored resume…';
  try {
    const r = await api('/api/tailor', { method: 'POST', body: { job_uid: $('#tl-job').value, include_skills: tailorState.include, format: 'preview' } });
    $('#tl-preview').innerHTML = `<div class="pv">${r.preview_html}</div>
      <div class="pv-meta">
        <span class="badge src">Fit ${r.meta.score}%</span>
        <span class="badge">${r.meta.matchedCount} of ${r.meta.jobSkillsCount} posting skills matched</span>
        <span class="hint">What changed: ${esc(r.meta.changes.join(' · '))}</span>
        ${r.meta.unclaimedGaps.length ? `<span class="hint">Unclaimed gaps: ${esc(r.meta.unclaimedGaps.join(', '))}</span>` : ''}
      </div>`;
    $('#tl-pdf').disabled = $('#tl-docx').disabled = $('#tl-txt').disabled = $('#tl-apply').disabled = false;
    $('#tl-status').textContent = 'Preview shows exactly what downloads — fit score and change trace stay out of the document.';
    tailorState.lastBrief = { title: r.job.title, company: r.job.company, url: r.job.url, matched: [], missing: r.meta.unclaimedGaps };
    toast('Preview ready — review, then download or apply.');
  } catch (e) { $('#tl-status').textContent = e.message; toast(e.message, true); }
  $('#tl-generate').disabled = false;
});

async function downloadTailored(format) {
  try {
    const res = await fetch('/api/tailor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job_uid: $('#tl-job').value, include_skills: tailorState.include, format }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'HTTP ' + res.status);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const fn = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/);
    a.download = fn ? fn[1] : `tailored-resume.${format}`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Tailored resume downloaded as ${format.toUpperCase()}.`);
  } catch (e) { toast(e.message, true); }
}
$('#tl-pdf').addEventListener('click', () => downloadTailored('pdf'));
$('#tl-docx').addEventListener('click', () => downloadTailored('docx'));
$('#tl-txt').addEventListener('click', () => downloadTailored('txt'));

$('#tl-apply').addEventListener('click', async () => {
  await downloadTailored('pdf');
  if (tailorState.lastBrief) {
    localStorage.setItem('jobradar.apply', JSON.stringify(tailorState.lastBrief));
    window.open(tailorState.lastBrief.url, '_blank', 'noopener');
    toast('Application package ready: resume downloaded, brief saved for the autofill extension, portal opened.');
  }
});

/* ---------- alerts ---------- */
async function loadAlerts() {
  try {
    const { prefs, outbox } = await api('/api/alerts');
    if (prefs) {
      $('#al-keywords').value = prefs.keywords || '';
      $('#al-locations').value = prefs.locations || '';
      $('#al-minscore').value = prefs.min_score || 0;
      $('#al-minscore-val').textContent = prefs.min_score || 0;
      $('#al-email').checked = (prefs.channels || []).includes('email');
      $('#al-whatsapp').checked = (prefs.channels || []).includes('whatsapp');
    }
    $('#outbox').innerHTML = outbox.length ? outbox.map((o) => `
      <div class="outbox-item">
        <span class="st ${esc(o.status)}">${esc(o.status)}</span>
        <b>${esc(o.channel)}</b> → ${esc(o.target || '(no target configured)')}
        <div>${esc(o.subject || o.body.slice(0, 90) + '…')}</div>
        ${o.error ? `<div class="err">${esc(o.error)}</div>` : ''}
        <div class="hint">${esc(timeAgo(o.created_at))}${o.sent_at ? ' · sent ' + esc(timeAgo(o.sent_at)) : ''}</div>
      </div>`).join('') : '<div class="empty-inline">Nothing queued yet. Alerts are created when an ingest finds jobs matching your preferences.</div>';
  } catch (e) { toast(e.message, true); }
}

$('#al-minscore').addEventListener('input', (e) => { $('#al-minscore-val').textContent = e.target.value; });

$('#al-save').addEventListener('click', async () => {
  const channels = [];
  if ($('#al-email').checked) channels.push('email');
  if ($('#al-whatsapp').checked) channels.push('whatsapp');
  if (!channels.length) return toast('Pick at least one channel.', true);
  try {
    await api('/api/alerts', { method: 'PUT', body: { keywords: $('#al-keywords').value, locations: $('#al-locations').value, min_score: $('#al-minscore').value, channels } });
    toast('Alert preferences saved.');
    loadAlerts();
  } catch (e) { toast(e.message, true); }
});

$('#al-test').addEventListener('click', async () => {
  $('#al-test').disabled = true;
  try {
    const r = await api('/api/alerts/test', { method: 'POST' });
    toast(`Test run: ${r.queued} alert slot(s) → sent ${r.result.sent}, failed ${r.result.failed}. Unconfigured channels are marked skipped.`);
    loadAlerts();
  } catch (e) { toast(e.message, true); }
  $('#al-test').disabled = false;
});

/* ---------- pipeline ---------- */
async function loadPipeline() {
  try {
    const [{ boards }, { runs }] = await Promise.all([api('/api/boards'), api('/api/ingest/status')]);
    $('#boards-list').innerHTML = boards.map((b) => `
      <div class="board">
        <span><b>${esc(b.label || b.slug)}</b> <span class="n">· ${esc(b.kind)}${b.slug && b.slug !== b.label ? ' / ' + esc(b.slug) : ''}</span></span>
        <span class="n">${b.job_count} jobs ${b.enabled ? '' : '· disabled'}</span>
      </div>`).join('') || '<div class="empty-inline">No boards configured.</div>';
    $('#ing-runs').innerHTML = runs.length ? runs.map((r) => `
      <div class="run"><span>run #${r.id} · ${esc(timeAgo(r.started_at))}</span><span>fetched <b>${r.fetched}</b> · new <b>${r.inserted}</b> · updated <b>${r.updated}</b>${r.failures && r.failures.length ? ` · <span style="color:var(--bad)">${r.failures.length} failed boards</span>` : ''}</span></div>`).join('') : '<div class="empty-inline">No runs yet.</div>';
    if (runs[0] && runs[0].failures && runs[0].failures.length) $('#ing-status').innerHTML = `Last run board failures:<br>· ${runs[0].failures.map(esc).join('<br>· ')}`;
    else $('#ing-status').textContent = '';
  } catch (e) { toast(e.message, true); }
}

$('#ing-run').addEventListener('click', async () => {
  $('#ing-run').disabled = true;
  $('#ing-status').textContent = 'Ingesting… (fetching all boards)';
  try {
    const r = await api('/api/ingest', { method: 'POST' });
    $('#ing-status').textContent = `Done: fetched ${r.fetched}, new ${r.inserted}, updated ${r.updated}, failed boards ${r.failures.length}.`;
    toast('Ingest complete.');
    loadPipeline(); loadStats();
  } catch (e) { $('#ing-status').textContent = e.message; toast(e.message, true); }
  $('#ing-run').disabled = false;
});

$('#bd-kind').addEventListener('change', () => {
  const isPage = $('#bd-kind').value === 'careers-page';
  $('#bd-slug').placeholder = isPage ? 'https://company.com/careers' : 'slug (e.g. postman)';
});

$('#bd-add').addEventListener('click', async () => {
  const kind = $('#bd-kind').value;
  const body = { kind, slug: $('#bd-slug').value.trim(), label: $('#bd-label').value.trim() || $('#bd-slug').value.trim() };
  if (!body.slug) return toast('Enter a slug or URL first.', true);
  $('#bd-add').disabled = true;
  try {
    await api('/api/boards', { method: 'POST', body });
    toast('Board verified and added.');
    $('#bd-slug').value = ''; $('#bd-label').value = '';
    loadPipeline();
  } catch (e) { $('#bd-status').textContent = e.message; toast(e.message, true); }
  $('#bd-add').disabled = false;
});

/* ---------- boot ---------- */
bindFilters();
route();
