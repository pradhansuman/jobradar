'use strict';

const FIELDS = ['name', 'email', 'phone', 'location', 'linkedin', 'portfolio'];

function load() {
  chrome.storage.local.get('profile', ({ profile }) => {
    const p = profile || {};
    for (const f of FIELDS) document.getElementById('p-' + f).value = p[f] || '';
  });
}

function save() {
  const p = {};
  for (const f of FIELDS) p[f] = document.getElementById('p-' + f).value.trim();
  chrome.storage.local.set({ profile: p }, () => {
    const s = document.getElementById('saved');
    s.textContent = 'Profile saved ✓';
    setTimeout(() => { s.textContent = ''; }, 1800);
  });
  return p;
}

document.getElementById('fill').addEventListener('click', async () => {
  const profile = save();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: autofill,
    args: [profile]
  });
  window.close();
});

document.querySelectorAll('input').forEach((el) => el.addEventListener('change', save));
load();

/* Runs in the page: fills only EMPTY fields, matched by common label heuristics. */
function autofill(profile) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const matchers = {
    name: (t) => /^(fullname|name|firstname|givenname|first|yourname|candidatefullname|applicantname)$/.test(t) || t.includes('fullname') || t === 'firstname' || t === 'first',
    email: (t) => t.includes('email') || t === 'mail',
    phone: (t) => t.includes('phone') || t.includes('mobile') || t.includes('contactnumber') || t.includes('phonenumber'),
    location: (t) => t.includes('location') || t.includes('city') || t.includes('currentcity') || t.includes('basedin'),
    linkedin: (t) => t.includes('linkedin'),
    portfolio: (t) => t.includes('github') || t.includes('portfolio') || t.includes('website') || t.includes('gitlab') || t.includes('blog')
  };
  const emailOk = (v) => !v || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

  const inputs = Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea'));
  let filled = 0;
  const highlight = (el) => {
    const old = el.style.boxShadow;
    el.style.boxShadow = '0 0 0 3px rgba(79,140,255,.55)';
    setTimeout(() => { el.style.boxShadow = old; }, 1200);
  };
  const setVal = (el, val) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    highlight(el);
    filled++;
  };

  for (const el of inputs) {
    const type = (el.type || 'text').toLowerCase();
    if (['checkbox', 'radio', 'file', 'submit', 'button'].includes(type)) continue;
    if (el.value && el.value.trim()) continue;
    if (el.disabled || el.readOnly || !el.offsetParent) continue;
    const t = norm(el.name) + ' ' + norm(el.id) + ' ' + norm(el.getAttribute('autocomplete')) + ' ' + norm(el.placeholder);
    const labelText = (() => {
      const lbl = el.labels && el.labels[0] ? el.labels[0].textContent : '';
      const wrap = el.closest('label');
      return norm(lbl) + ' ' + norm(wrap ? wrap.textContent : '');
    })();
    const all = t + ' ' + labelText;
    for (const key of Object.keys(matchers)) {
      const val = profile[key];
      if (!val) continue;
      if (matchers[key](all)) {
        if (type === 'email' && !emailOk(val)) break;
        if (type === 'tel' && key !== 'phone' && key !== 'name') break;
        setVal(el, val);
        break;
      }
    }
  }
  return filled;
}
