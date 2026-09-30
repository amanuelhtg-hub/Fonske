'use strict';
// All dynamic content is rendered with textContent / createElement: no innerHTML, so no XSS sink.
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};
async function api(path, method = 'GET', body) {
  const r = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

let channel = 'app';
let source = null;

function connectStream() {
  if (source) source.close();
  source = new EventSource('/api/me/stream');
  source.onopen = () => { $('live').textContent = 'Live updates: connected'; };
  source.onerror = () => { $('live').textContent = 'Live updates: reconnecting…'; };
  source.addEventListener('update', () => renderCustomer());
}

function showOnly(id) {
  for (const v of ['login', 'customer', 'advisor']) $(v).hidden = v !== id;
  $('logout').hidden = id === 'login';
}

async function loadPersonas() {
  const p = await api('/api/personas');
  const sel = $('persona');
  sel.replaceChildren();
  for (const c of [...p.customers, ...p.advisors]) sel.append(el('option', { value: c.id, textContent: c.name }));
}

async function enter() {
  try {
    const me = await api('/api/me');
    if (me.role === 'customer') { showOnly('customer'); await renderCustomer(); connectStream(); }
    else { showOnly('advisor'); await renderAdvisor(); }
  } catch { showOnly('login'); await loadPersonas(); }
}

function whyBlock(c) {
  const d = el('details', {}, el('summary', { textContent: 'Why am I seeing this?' }));
  if (!c.why.length) d.append(el('p', { textContent: 'This is a general message; nothing about you was analysed.' }));
  else {
    d.append(el('p', { textContent: `Opportunity: ${c.moment.replace(/_/g, ' ')} (confidence ${Math.round(c.confidence * 100)}%)` }));
    const ul = el('ul');
    for (const w of c.why) ul.append(el('li', { textContent: w }));
    d.append(ul);
  }
  return d;
}

async function renderCustomer() {
  const exp = await api(`/api/me/experience?channel=${channel}`);
  const box = $('channel');
  box.replaceChildren();
  if (exp.skipped) box.append(el('p', { className: 'muted', textContent: exp.skipped }));
  else if (channel === 'email') {
    box.append(el('div', { className: 'card' },
      el('p', { className: 'muted', textContent: `Subject: ${exp.subject}` }),
      el('p', { className: 'muted', textContent: exp.preheader }),
      el('pre', { textContent: exp.text })));
  } else {
    box.append(el('h2', { textContent: exp.greeting }));
    if (!exp.cards.length) box.append(el('p', { className: 'muted', textContent: 'Nothing to suggest right now. Silence is a feature.' }));
    for (const c of exp.cards) {
      const dismiss = el('button', { textContent: 'Not interested', className: 'ghost' });
      dismiss.onclick = async () => { await api('/api/me/dismiss', 'POST', { actionId: c.actionId }); renderCustomer(); };
      box.append(el('div', { className: 'card' }, el('h4', { textContent: c.title }), el('p', { textContent: c.body }),
        el('button', { textContent: c.cta }), ' ', dismiss,
        ...(c.product ? [el('p', { className: 'muted', textContent: `Related: ${c.product.name}` })] : []), whyBlock(c)));
    }
    for (const g of exp.guardrails) box.append(el('div', { className: 'guard muted', textContent: `Guardrail: ${g}` }));
  }
  $('risk').value = (await api('/api/me/preferences')).riskComfort || '';
  const consent = await api('/api/me/consent');
  const cbox = $('consent');
  cbox.replaceChildren();
  const labels = { personalization: 'Personalised suggestions', transactionInsights: 'Use my transactions to spot ways to help', advisorInsights: 'Share insights with my advisor' };
  for (const k of Object.keys(labels)) {
    const cb = el('input', { type: 'checkbox', checked: consent[k], id: `c-${k}` });
    cb.onchange = async () => { await api('/api/me/consent', 'PUT', { [k]: cb.checked }); renderCustomer(); };
    cbox.append(el('label', { className: 'switch' }, cb, labels[k]));
  }
}

async function renderAdvisor() {
  const list = await api('/api/advisor/customers');
  const box = $('clients');
  box.replaceChildren();
  for (const c of list) {
    const b = el('button', { textContent: c.name });
    b.onclick = async () => {
      const brief = await api(`/api/advisor/customers/${encodeURIComponent(c.id)}/brief`);
      const out = $('brief');
      out.replaceChildren();
      if (brief.blocked) { out.append(el('p', { className: 'error', textContent: brief.blocked })); return; }
      const card = el('div', { className: 'card' }, el('h4', { textContent: `Brief: ${brief.customer}` }));
      const ul = el('ul');
      for (const t of brief.talkingPoints) ul.append(el('li', { textContent: t }));
      card.append(ul, el('p', { className: 'muted', textContent: brief.note }));
      for (const g of brief.guardrails) card.append(el('div', { className: 'guard muted', textContent: g }));
      out.append(card);
    };
    box.append(b);
  }
}

$('go').onclick = async () => {
  $('err').textContent = '';
  try { await api('/api/login', 'POST', { userId: $('persona').value, passcode: $('passcode').value }); await enter(); }
  catch (e) { $('err').textContent = e.message; }
};
$('logout').onclick = async () => {
  if (source) { source.close(); source = null; } await api('/api/logout', 'POST', {}); showOnly('login'); loadPersonas(); };
$('risk').onchange = async () => { await api('/api/me/preferences', 'PUT', { riskComfort: $('risk').value || null }); };
document.querySelectorAll('.tabs button').forEach((b) => {
  b.onclick = () => {
    channel = b.dataset.ch;
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    renderCustomer();
  };
});
document.querySelectorAll('#sim button').forEach((b) => {
  b.onclick = () => {
    const ev = { cat: b.dataset.cat, amt: Number(b.dataset.amt) };
    if (b.dataset.m) ev.m = b.dataset.m;
    if (b.dataset.c) ev.c = b.dataset.c;
    api('/api/me/events', 'POST', ev);
  };
});
$('bench').onclick = async () => {
  $('benchOut').textContent = 'Running…';
  try {
    const r = await api('/api/advisor/bench?n=2300000');
    $('benchOut').textContent = JSON.stringify(r, null, 2);
  } catch (e) { $('benchOut').textContent = e.message; }
};
enter();
