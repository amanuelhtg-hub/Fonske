'use strict';
// App shell: login, idle home screen, Kate action cards (slide up when triggered), settings drawer and advisor view.
// Screen states: idle (home page) -> triggered (card slides up) -> processing -> success (see cards.js).
(function () {
  const { $, el, svg, kateIcon, logo, categoryBadge, money, api, toast } = window.UI;

  let me = null;
  let cards = [];                 // latest cards from the server, in priority order
  let source = null;              // SSE connection
  const snoozed = new Set();      // "Not now": hidden until reload or until re-triggered with a number key
  const revealed = new Set();     // presenter mode: cards triggered so far
  let presenter = new URLSearchParams(location.search).has('presenter');
  let hiddenAll = false;          // Esc / 0: back to the plain home screen
  let sheet = null;
  let lastIds = new Set();

  const isShown = (id) => !snoozed.has(id) && !hiddenAll && (!presenter || revealed.has(id));

  // ---------- screens ----------
  // On wide screens the customer app is shown inside a phone frame (great for screencasts). The advisor view stays full width.
  const wideQuery = window.matchMedia('(min-width: 900px) and (min-height: 640px)');
  const frameOff = new URLSearchParams(location.search).get('frame') === '0';
  let screen = 'login';
  function applyFrame() { document.body.classList.toggle('device', wideQuery.matches && !frameOff && screen !== 'advisor'); }
  wideQuery.addEventListener('change', applyFrame);

  function show(name) {
    screen = name;
    applyFrame();
    for (const s of ['login', 'customer', 'advisor']) $(s).hidden = s !== name;
    $('topbar').hidden = name === 'login';
    $('openSettings').hidden = name !== 'customer';
    $('presenterTag').hidden = name !== 'customer' || !presenter;
    if (name !== 'customer' && sheet) sheet.clear();
  }

  async function loadPersonas() {
    const p = await api('/api/personas');
    const sel = $('persona');
    sel.replaceChildren();
    for (const c of p.customers) sel.append(el('option', { value: c.id, textContent: c.scenario ? `${c.name} · ${c.scenario}` : c.name }));
    for (const a of p.advisors) sel.append(el('option', { value: a.id, textContent: a.name }));
  }

  async function enter() {
    try {
      me = await api('/api/me');
    } catch {
      show('login');
      await loadPersonas();
      return;
    }
    if (me.role === 'customer') await enterCustomer(); else await enterAdvisor();
  }

  // ---------- customer: idle home + cards ----------
  const QUICK = [['send', 'Pay'], ['wallet', 'Transfer'], ['card', 'Cards'], ['home', 'Home']];
  const CAT_ICON = { salary: 'arrowDown', transfer_in: 'arrowDown', claim_payout: 'arrowDown', rent: 'home', mortgage: 'home', rent_abroad: 'home', groceries: 'cart', utility: 'zap',
    insurance: 'shield', savings_transfer: 'wallet', abroad: 'card', disruption: 'plane', travel_booking: 'plane', overdraft_fee: 'alert', subscription: 'repeat', subscription_annual: 'repeat' };
  const CAT_LABEL = { salary: 'Salary', rent: 'Rent', mortgage: 'Mortgage', groceries: 'Groceries', savings_transfer: 'Savings transfer', utility: 'Utilities', insurance: 'Insurance',
    abroad: 'Card payment abroad', rent_abroad: 'Rent abroad', disruption: 'Travel cost', overdraft_fee: 'Overdraft fee', transfer_in: 'Incoming payment', travel_booking: 'Travel booking',
    claim_payout: 'Payout', subscription: 'Subscription', subscription_annual: 'Annual subscription' };

  async function enterCustomer() {
    show('customer');
    hiddenAll = presenter;       // presenter mode starts on the plain home screen
    revealed.clear(); snoozed.clear(); lastIds = new Set();
    sheet = window.KateCards.createSheet($('sheet'), { refresh: loadCards, snooze: (id) => { snoozed.add(id); } });
    $('quick').replaceChildren(...QUICK.map(([i, t]) => el('div', {}, svg(i, 22), t)));
    await Promise.all([loadHome(), buildDrawer()]);
    connectStream();
    setTimeout(loadCards, presenter ? 0 : 700);
  }

  async function loadHome() {
    const h = await api('/api/me/home');
    const first = h.name.split(' ')[0];
    const hour = new Date().getHours();
    $('hello').textContent = `${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, ${first}`;
    $('date').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    $('total').textContent = money(h.balance + (h.savings || 0), 2);
    $('accounts').replaceChildren(
      el('div', { className: 'account' }, el('div', { className: 'name', textContent: 'Current account' }), el('div', { className: 'value', textContent: money(h.balance, 2) })),
      ...(h.savings !== null ? [el('div', { className: 'account' }, el('div', { className: 'name', textContent: 'Savings' }), el('div', { className: 'value', textContent: money(h.savings, 2) }))] : []));
    $('tx').replaceChildren(...h.transactions.map((t) => {
      const name = t.label || CAT_LABEL[t.cat] || t.cat;
      const when = t.daysAgo === 0 ? 'Today' : t.daysAgo === 1 ? 'Yesterday' : `${t.daysAgo} days ago`;
      return el('li', { className: 'tx' }, t.label ? logo(t.label, 'sm') : categoryBadge(CAT_ICON[t.cat] || 'receipt', 'sm'),
        el('div', { className: 'grow' }, el('div', { className: 'name', textContent: name }), el('div', { className: 'when', textContent: when })),
        el('div', { className: `amt${t.amount > 0 ? ' in' : ''}`, textContent: `${t.amount > 0 ? '+' : '−'}${money(Math.abs(t.amount), 2)}` }));
    }));
  }

  let loading = false;
  async function loadCards() {
    if (!me || me.role !== 'customer' || loading) return;
    loading = true;
    try {
      const exp = await api('/api/me/experience?channel=app');
      cards = exp.cards.filter((c) => c.moment !== null || c.actionId === 'generic-tips');
      const ids = new Set(cards.map((c) => c.actionId));
      // A card that just appeared (live event) is itself the trigger: reveal it even in presenter mode.
      if (lastIds.size || revealed.size) for (const id of ids) if (!lastIds.has(id)) revealed.add(id);
      lastIds = ids;
      sheet.sync(cards, isShown);
      renderGuardrails(exp.guardrails);
      loadHome().catch(() => {});
    } finally { loading = false; }
  }

  function connectStream() {
    if (source) source.close();
    source = new EventSource('/api/me/stream');
    source.onopen = () => { $('live').textContent = 'Live updates: connected'; };
    source.onerror = () => { $('live').textContent = 'Live updates: reconnecting…'; };
    source.addEventListener('update', () => loadCards());
  }

  // ---------- settings drawer ----------
  async function buildDrawer() {
    const consent = await api('/api/me/consent');
    const labels = { personalization: 'Personalised suggestions', transactionInsights: 'Use my transactions to spot ways to help', advisorInsights: 'Share insights with my advisor' };
    $('consent').replaceChildren(...Object.keys(labels).map((k) => {
      const cb = el('input', { type: 'checkbox', checked: consent[k], attrs: { 'aria-label': labels[k] } });
      cb.onchange = async () => { await api('/api/me/consent', 'PUT', { [k]: cb.checked }); await buildDrawer(); loadCards(); };
      return el('label', { className: 'switch' }, el('span', { textContent: labels[k] }), cb);
    }));
    $('risk').value = (await api('/api/me/preferences')).riskComfort || '';
  }
  function renderGuardrails(list) {
    $('guardrails').replaceChildren(...(list.length ? list.map((g) => el('div', { className: 'guard', textContent: g })) : [el('p', { className: 'muted', textContent: 'No guardrail was needed right now.' })]));
  }
  const openDrawer = () => { $('drawer').hidden = false; $('closeSettings').focus(); };
  const closeDrawer = () => { $('drawer').hidden = true; };

  // ---------- presenter controls (keyboard) ----------
  function setPresenter(on) {
    presenter = on;
    $('presenterTag').hidden = !on || me?.role !== 'customer';
    hiddenAll = on;
    revealed.clear();
    snoozed.clear();
    sheet.sync(cards, isShown);
    toast(on ? 'Presenter mode: press 1–9 to trigger a card, 0 to clear.' : 'Presenter mode off.');
  }
  document.addEventListener('keydown', (e) => {
    if (!me || me.role !== 'customer' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    if (!$('drawer').hidden) { if (e.key === 'Escape') closeDrawer(); return; }
    if (/^[1-9]$/.test(e.key)) {
      const c = cards[Number(e.key) - 1];
      if (!c) return;
      hiddenAll = false; snoozed.delete(c.actionId); revealed.add(c.actionId);
      sheet.sync(cards, isShown);
    } else if (e.key === '0' || e.key === 'Escape') {
      hiddenAll = true; sheet.clear();
    } else if (e.key.toLowerCase() === 'p') {
      setPresenter(!presenter);
    } else if (e.key.toLowerCase() === 'r') {
      hiddenAll = false; snoozed.clear(); loadCards();
    }
  });

  // ---------- advisor ----------
  async function enterAdvisor() {
    show('advisor');
    const list = await api('/api/advisor/customers');
    const box = $('clients');
    box.replaceChildren();
    for (const c of list) {
      const b = el('button', { className: 'btn btn-neutral', textContent: c.name, attrs: { 'aria-pressed': 'false' } });
      b.onclick = async () => {
        for (const x of box.children) x.setAttribute('aria-pressed', String(x === b));
        const out = $('brief');
        out.replaceChildren();
        try {
          const brief = await api(`/api/advisor/customers/${encodeURIComponent(c.id)}/brief`);
          if (brief.blocked) { out.append(el('p', { className: 'k-error', textContent: brief.blocked })); return; }
          out.append(el('h2', { className: 'h2', textContent: `Brief: ${brief.customer}` }),
            ...(brief.talkingPoints.length ? [el('ul', {}, ...brief.talkingPoints.map((t) => el('li', { textContent: t })))] : [el('p', { className: 'muted', textContent: 'Nothing to discuss right now.' })]),
            el('p', { className: 'muted', textContent: brief.note }),
            ...(brief.guardrails.length ? [el('div', {}, ...brief.guardrails.map((g) => el('div', { className: 'guard', textContent: g })))] : []));
        } catch (e) { out.append(el('p', { className: 'k-error', textContent: e.message })); }
      };
      box.append(b);
    }
  }
  const n = (x) => new Intl.NumberFormat('en-GB').format(x);
  async function runBench() {
    const out = $('benchOut');
    out.replaceChildren(el('p', { className: 'muted', textContent: 'Running…' }));
    try {
      const r = await api('/api/advisor/bench?n=2300000');
      const max = Math.max(1, ...Object.values(r.actions));
      out.replaceChildren(
        el('div', { className: 'stats' },
          ...[['Customers', n(r.customers)], ['CPU workers', n(r.workers)], ['Time', `${(r.ms / 1000).toFixed(1)} s`], ['Per second', n(r.customersPerSecond)], ['Cards produced', n(r.cards)]]
            .map(([k, v]) => el('div', { className: 'stat' }, el('div', { className: 'v', textContent: v }), el('div', { className: 'k', textContent: k })))),
        el('div', { className: 'bars' }, ...Object.entries(r.actions).sort((a, b) => b[1] - a[1]).map(([id, v]) =>
          el('div', { className: 'bar' }, el('span', { className: 'n', textContent: id }), el('span', { className: 'track' }, (() => { const f = el('span', { className: 'fill' }); f.style.width = `${Math.round((v / max) * 100)}%`; return f; })()), el('span', { textContent: n(v) })))));
    } catch (e) { out.replaceChildren(el('p', { className: 'k-error', textContent: e.message })); }
  }

  // Decorative status-bar icons for the phone frame (signal bars and a battery).
  function statusIcons() {
    const NS = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 54 14', width: 54, height: 14, 'aria-hidden': 'true' })) s.setAttribute(k, v);
    const add = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); s.append(n); };
    [4, 6, 8, 10].forEach((h, i) => add('rect', { x: i * 5, y: 12 - h, width: 3, height: h, rx: 1, fill: '#2D3748' }));
    add('rect', { x: 26, y: 1.5, width: 24, height: 11, rx: 3.5, fill: 'none', stroke: '#2D3748', 'stroke-width': 1, opacity: 0.45 });
    add('rect', { x: 28, y: 3.5, width: 17, height: 7, rx: 2, fill: '#2D3748' });
    add('rect', { x: 51.5, y: 5, width: 1.5, height: 4, rx: 0.75, fill: '#2D3748', opacity: 0.45 });
    return s;
  }

  // ---------- wiring ----------
  $('sbIcons').append(statusIcons());
  $('openSettings').append(svg('sliders', 20));
  $('closeSettings').append(svg('x', 20));
  $('openSettings').onclick = openDrawer;
  $('closeSettings').onclick = closeDrawer;
  $('drawer').addEventListener('click', (e) => { if (e.target === $('drawer')) closeDrawer(); });
  $('togglePresenter').onclick = () => { closeDrawer(); setPresenter(!presenter); };
  $('risk').onchange = async () => { await api('/api/me/preferences', 'PUT', { riskComfort: $('risk').value || null }); };
  $('previewEmail').onclick = async () => {
    const x = await api('/api/me/experience?channel=email');
    $('email').replaceChildren(el('div', { className: 'email-preview' },
      ...(x.skipped ? [el('p', { className: 'muted', textContent: x.skipped })] : [el('p', { className: 'label', textContent: `Subject: ${x.subject}` }), el('pre', { textContent: x.text })])));
  };
  document.querySelectorAll('#sim button').forEach((b) => {
    b.onclick = () => {
      const ev = { cat: b.dataset.cat, amt: Number(b.dataset.amt) };
      if (b.dataset.m) ev.m = b.dataset.m;
      if (b.dataset.c) ev.c = b.dataset.c;
      closeDrawer();
      api('/api/me/events', 'POST', ev).catch((e) => toast(e.message));
    };
  });
  $('go').onclick = async () => {
    $('err').textContent = '';
    try { await api('/api/login', 'POST', { userId: $('persona').value, passcode: $('passcode').value }); $('passcode').value = ''; await enter(); }
    catch (e) { $('err').textContent = e.message; }
  };
  $('passcode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('go').click(); });
  $('logout').onclick = async () => {
    if (source) { source.close(); source = null; }
    closeDrawer(); toast('');
    await api('/api/logout', 'POST', {});
    me = null; cards = [];
    if (sheet) sheet.clear();
    show('login'); loadPersonas();
  };
  $('bench').onclick = runBench;
  enter();
}());
