'use strict';
// Kate action cards. One card = one intervention with one primary action.
// Card contract (per the style guide):
//   { event_id, card_type, merchant, amount, title, description, primary_cta, secondary_cta }
// State flow per card: triggered (slides up) -> processing (spinner, 800 ms) -> success (green check, fades out after 2 s).
// Everything the customer approves here is SIMULATED: nothing is sent to a merchant, airline or bank.
(function () {
  const { el, svg, kateIcon, logo, categoryBadge, money, sleep, api, toast } = window.UI;
  const PROCESSING_MS = 800;
  const SUCCESS_MS = 2000;

  // ---------- server card -> style-guide payload ----------
  const merchantOf = (f) => f.m || f.merchant || f.carrier || f.booking || null;
  const amountOf = (f) => {
    const v = f.amount ?? f.cost ?? f.to ?? f.need ?? null;
    return typeof v === 'number' && v > 0 ? v : null;
  };
  function toPayload(c, flow) {
    const f = c.facts || {};
    const a = amountOf(f);
    return {
      event_id: `${c.actionId}_${c.moment || 'general'}`,
      card_type: String(c.moment || 'general').toUpperCase(),
      merchant: merchantOf(f),
      amount: a === null ? null : money(a, 2),
      title: c.title,
      description: c.body,
      primary_cta: flow.primary,
      secondary_cta: flow.secondary,
    };
  }
  function categoryIcon(moment) {
    if (/subscription/.test(moment)) return 'repeat';
    if (/business/.test(moment)) return 'briefcase';
    if (/bill|household/.test(moment)) return 'receipt';
    if (/trip|travel|stay|relocation|claim/.test(moment)) return 'plane';
    if (/cash/.test(moment)) return 'wallet';
    return 'card';
  }

  // ---------- flows: what the primary button does for each action ----------
  const cancelNote = (m) => `Demo: nothing is sent${m ? ` to ${m}` : ''}. Stopping payments at the bank does not cancel a contract.`;
  function cancelFlow(c, opts = {}) {
    const f = c.facts || {};
    return {
      primary: opts.primary || 'Let Kate cancel', secondary: opts.secondary || 'Not now', note: cancelNote(f.m),
      choices: f.m ? null : { load: async () => (await api('/api/me/subscriptions')).map((x) => ({ value: x.m, label: `${x.m} · ${money(x.monthly, 2)}/mo` })), initial: 0 },
      onSecondary: opts.onSecondary,
      run: async (s) => {
        const m = f.m || s.choice;
        if (!m) throw new Error('Pick a subscription first.');
        await api('/api/me/subscriptions/cancel', 'POST', { merchant: m, approve: true });
        return 'Cancellation request sent.';
      },
    };
  }
  const dismissServer = (c) => api('/api/me/dismiss', 'POST', { actionId: c.actionId });
  const info = (c, message = 'All set.') => ({ primary: c.cta, secondary: 'Not now', note: 'Demo: simulated, nothing is sent.', run: async () => message });

  function situationFlow(c) {
    const f = c.facts || {};
    const months = { v: 3 };
    return {
      primary: 'Tell Kate', secondary: 'Not now',
      choices: { items: [{ value: 'holiday', label: 'Holiday' }, { value: 'business', label: 'Work trip' }, { value: 'stay', label: 'Temporary stay' }, { value: 'move', label: 'Move abroad' }] },
      choiceExtra: (value) => {
        if (value !== 'stay') return null;
        const sel = el('select', { attrs: { 'aria-label': 'How long will you stay?' }, onchange: () => { months.v = Number(sel.value); } });
        for (let m = 1; m <= 12; m++) sel.append(el('option', { value: String(m), textContent: `${m} month${m > 1 ? 's' : ''}`, selected: m === months.v }));
        return el('label', { className: 'label' }, 'How long will you stay? ', sel);
      },
      run: async (s) => {
        const ev = { cat: 'travel_confirm', m: s.choice, amt: s.choice === 'stay' ? months.v : 0 };
        if (/^[A-Z]{2}$/.test(f.country || '')) ev.c = f.country;
        await api('/api/me/events', 'POST', ev);
        return 'Thanks, Kate updated your trip.';
      },
    };
  }

  function savingsFlow(c, ctx) {
    const f = c.facts || {};
    const t = f.savingsTransfer;
    const flow = {
      primary: t ? `Set aside ${money(t.amount)}` : c.cta, secondary: 'Not now',
      note: 'Demo: only moves money between your own accounts. Kate gives no investment advice.',
      run: async () => {
        if (!t) return 'Noted.';
        await api('/api/me/savings-transfer', 'POST', { amount: t.amount });
        return 'Money set aside.';
      },
      extra: () => adjustPanel(f, ctx),
    };
    return flow;
  }
  // "Adjust my numbers": reserve, automatic saving limit, and what the money is for.
  function adjustPanel(f, ctx) {
    const reserve = el('input', { type: 'number', min: '0', step: '100', value: String(f.reserve), attrs: { 'aria-label': 'Reserve to keep' } });
    const answer = el('p', { className: 'answer' });
    const routes = {
      'Needed soon': 'Okay, we keep it accessible. Nothing moves.',
      'Building a reserve': `Suggestion: an accessible ${(f.savingsProduct || f.product).name}. Nothing moves until you approve.`,
      'Long-term': 'Next step: a guided investment profile (objectives, risk comfort, finances, horizon). Kate gives no investment advice.',
    };
    const rows = [
      el('div', { className: 'row' }, el('label', { textContent: `Balance ${money(f.balance)} · bills ${money(f.bills)}/mo · everyday ${money(f.everyday)}/mo · renewals ${money(f.planned)}` })),
      el('div', { className: 'row' }, el('label', { textContent: f.reserveChosen ? 'Your reserve' : 'Reserve to keep (default: 3 months)' }), reserve,
        el('button', { className: 'btn btn-neutral', textContent: 'Update', onclick: async () => { await api('/api/me/preferences', 'PUT', { reserve: Number(reserve.value) }); toast('Reserve updated, estimate recalculated.'); ctx.refresh(); } }),
        ...(f.reserveChosen ? [el('button', { className: 'btn btn-neutral', textContent: 'Use default', onclick: async () => { await api('/api/me/preferences', 'PUT', { reserve: null }); ctx.refresh(); } })] : [])),
    ];
    if (f.savingsTransfer) {
      const limit = el('input', { type: 'number', min: '1', step: '50', value: String(Math.min(f.savingsTransfer.amount, 500)), attrs: { 'aria-label': 'Automatic saving limit per month' } });
      rows.push(f.automation.authorized
        ? el('div', { className: 'row' }, el('label', { textContent: `Automatic saving is on (up to ${money(f.automation.maxMonthly)}/month)` }),
          el('button', { className: 'btn btn-neutral', textContent: 'Turn off', onclick: async () => { await api('/api/me/preferences', 'PUT', { autoSave: null }); toast('Automatic saving turned off.'); ctx.refresh(); } }))
        : el('div', { className: 'row' }, el('label', { textContent: 'Optional: automatic saving, up to this amount per month' }), limit,
          el('button', { className: 'btn btn-neutral', textContent: 'Allow', onclick: async () => {
            const max = Number(limit.value);
            if (!(max > 0)) { toast('Enter a monthly limit above 0.'); return; }
            await api('/api/me/preferences', 'PUT', { autoSave: { max } });
            toast(`Automatic saving allowed up to ${money(max)}/month. You can turn it off any time.`);
            ctx.refresh();
          } })));
    }
    rows.push(el('div', { className: 'row' }, el('label', { textContent: 'Is this money needed for something coming up?' }),
      ...Object.keys(routes).map((k) => el('button', { className: 'btn btn-neutral', textContent: k, onclick: () => { answer.textContent = routes[k]; } }))), answer);
    return el('details', { className: 'k-adjust' }, el('summary', { textContent: 'Adjust my numbers' }), ...rows);
  }

  const FLOWS = {
    'review-subscriptions': (c) => cancelFlow(c),
    'subscription-hike': (c) => cancelFlow(c, { secondary: 'Keep subscription' }),
    'subscription-annual': (c) => cancelFlow(c, { secondary: 'Keep subscription' }),
    'subscription-new': (c) => ({ ...cancelFlow(c, { primary: 'Let Kate cancel', secondary: 'It is mine', onSecondary: () => dismissServer(c) }) }),
    'subscription-cancelled-charge': (c) => ({ primary: `Follow up with ${c.facts.m}`, secondary: 'Not now', note: 'Demo: nothing is sent. Blocking payments at the bank does not end a contract.',
      run: async () => 'Message sent.' }),
    'subscription-trial-started': (c) => ({ primary: 'Remind me', secondary: 'I will keep it', note: 'Kate never blocks a charge. She only reminds you.',
      onSecondary: () => api('/api/me/events', 'POST', { cat: 'subscription_kept', m: c.facts.m, amt: 0 }),
      run: async () => { await api('/api/me/events', 'POST', { cat: 'subscription_reminder', m: c.facts.m, amt: 0 }); return 'Reminder set.'; } }),
    'household-bill-shortfall': (c) => (c.facts.transfer
      ? { primary: `Approve ${money(c.facts.transfer.amount)} transfer`, secondary: 'Not now', note: 'Demo: only moves money between your own accounts.',
        run: async () => { await api('/api/me/transfer', 'POST', { amount: c.facts.transfer.amount }); return 'Transfer done. Your bill is covered.'; } }
      : info(c, 'Opened your accounts.')),
    'household-bill-increase': (c) => ({ primary: 'Confirm', secondary: 'Not now',
      choices: { items: [{ value: 'discount', label: 'A discount ended' }, { value: 'unsure', label: 'Not sure' }] },
      run: async (s) => { await dismissServer(c); return s.choice === 'discount' ? 'Noted. Kate uses the new amount as your usual price.' : 'Okay. Check your latest bill for the reason.'; } }),
    'household-bills': (c) => info(c, 'Bills calendar opened.'),
    'trip-question': (c) => situationFlow(c),
    'travel-cover': (c) => (c.facts.confirmed ? info(c, 'Travel help opened.') : situationFlow(c)),
    'moving-abroad': (c) => (c.facts.confirmed ? info(c, 'Your move checklist is ready.') : situationFlow(c)),
    'temporary-stay': (c) => ({ primary: 'Check my cover', secondary: 'Not now', note: 'Demo: simulated, nothing is sent.', run: async () => 'Cover review requested.' }),
    'travel-disruption': (c) => (c.facts.booking
      ? { primary: 'Send request', secondary: 'Not now', note: 'Demo: nothing is sent. Whether you qualify for a refund or compensation depends on the circumstances.', run: async () => 'Request sent.' }
      : info(c, 'Claim started.')),
    'business-trip': () => ({ primary: 'Tag as business expense', secondary: 'Not now', note: 'Demo: nothing is exported.', run: async () => 'Tagged as a business expense.' }),
    'claim-settled': (c) => ({ primary: 'Mark as settled', secondary: 'Not now', run: async () => { await dismissServer(c); return 'Claim marked as settled.'; } }),
    'excess-cash': (c, ctx) => savingsFlow(c, ctx),
    'buffer-clawback': (c) => ({ primary: `Move ${money(c.facts.transfer.amount)} back`, secondary: 'Not now', note: 'Demo: only moves money between your own accounts.',
      run: async () => { await api('/api/me/transfer', 'POST', { amount: c.facts.transfer.amount }); return 'Money moved back to your current account.'; } }),
    'household-contract-watch': (c) => ({ primary: c.cta, secondary: 'Not now',
      note: 'Demo: simulated. The provider confirms the final price, and nothing changes until you approve.',
      run: async () => (c.facts.status === 'ready' ? 'Change request sent.' : 'Got it. Kate checks again once you share the documents.') }),
  };
  const flowFor = (c, ctx) => (FLOWS[c.actionId] || ((x) => info(x)))(c, ctx);

  // ---------- the card component ----------
  function createCard(c, ctx) {
    const flow = flowFor(c, ctx);
    const payload = toPayload(c, flow);
    const state = { choice: null };
    const card = el('article', { className: 'k-card k-enter', attrs: { 'aria-label': payload.title }, dataset: { state: 'triggered', cardType: payload.card_type, eventId: payload.event_id } });
    const sig = JSON.stringify([c.title, c.body, c.cta, c.facts]);
    let primaryBtn;

    function setBusy(busy) { primaryBtn.disabled = busy || (!!flow.choices && !state.choice); }

    function buildChoices() {
      if (!flow.choices) return null;
      const wrap = el('div', { className: 'k-choices', attrs: { role: 'group', 'aria-label': 'Choose one' } });
      const extra = el('div', { className: 'k-choice-extra' });
      const paint = (items) => {
        wrap.replaceChildren(...items.map((it) => {
          const b = el('button', { className: 'k-chip', textContent: it.label, attrs: { 'aria-pressed': String(state.choice === it.value) }, onclick: () => pick(it.value) });
          b.dataset.value = it.value;
          return b;
        }));
      };
      const pick = (value) => {
        state.choice = value;
        for (const b of wrap.children) b.setAttribute('aria-pressed', String(b.dataset.value === value));
        const node = flow.choiceExtra ? flow.choiceExtra(value) : null;
        extra.replaceChildren(...(node ? [node] : []));
        setBusy(false);
      };
      if (flow.choices.items) paint(flow.choices.items);
      else flow.choices.load().then((items) => { paint(items); if (items.length) pick(items[flow.choices.initial ?? 0].value); }).catch(() => {});
      return el('div', {}, wrap, extra);
    }

    function build() {
      const icon = categoryIcon(c.moment || '');
      const head = el('div', { className: 'k-head' }, kateIcon(32), el('span', { className: 'k-brand', textContent: 'Kate' }), el('span', { className: 'k-time', textContent: '· now' }),
        el('span', { className: 'k-spacer' }),
        ...(payload.amount ? [el('span', { className: 'k-amount', textContent: payload.amount })] : []),
        payload.merchant ? logo(payload.merchant, 'sm') : categoryBadge(icon, 'sm'));
      const why = el('details', { className: 'k-why' }, el('summary', { textContent: 'Why am I seeing this?' }),
        c.why && c.why.length ? el('ul', {}, ...c.why.map((w) => el('li', { textContent: w }))) : el('p', { textContent: 'This is a general message. Nothing about you was analysed.' }));
      primaryBtn = el('button', { className: 'btn btn-primary', textContent: payload.primary_cta, onclick: onPrimary });
      const secondary = el('button', { className: 'btn-text', textContent: payload.secondary_cta, onclick: onSecondary });
      card.replaceChildren(head, el('h3', { className: 'k-title', textContent: payload.title }), el('p', { className: 'k-desc', textContent: payload.description }),
        ...[buildChoices(), flow.extra ? flow.extra() : null].filter(Boolean), primaryBtn, secondary,
        ...(flow.note ? [el('p', { className: 'k-note', textContent: flow.note })] : []), why);
      setBusy(false);
    }

    async function onPrimary() {
      if (card.dataset.state !== 'triggered') return;
      card.dataset.state = 'processing';
      const height = card.offsetHeight;
      primaryBtn.disabled = true;
      primaryBtn.replaceChildren(el('span', { className: 'spinner', attrs: { role: 'status', 'aria-label': 'Working' } }));
      try {
        const [message] = await Promise.all([flow.run(state), sleep(PROCESSING_MS)]);
        card.dataset.state = 'success';
        card.style.minHeight = `${Math.min(height, 300)}px`;
        card.replaceChildren(el('div', { className: 'k-success', attrs: { role: 'status' } },
          el('div', { className: 'k-check' }, svg('check', 44, 3)),
          el('h3', { className: 'k-title', textContent: 'Done' }), el('p', { textContent: message })));
        await sleep(SUCCESS_MS);
        card.classList.add('k-fade');
        await sleep(520);
        ctx.snooze(c.actionId); // a finished card must not pop straight back
        remove();
        ctx.refresh();
      } catch (e) {
        card.dataset.state = 'triggered';
        primaryBtn.replaceChildren(document.createTextNode(payload.primary_cta));
        setBusy(false);
        card.querySelector('.k-error')?.remove();
        primaryBtn.after(el('p', { className: 'k-error', textContent: e.message || 'Something went wrong. Try again.', attrs: { role: 'alert' } }));
      }
    }

    async function onSecondary() {
      if (card.dataset.state !== 'triggered') return;
      try { if (flow.onSecondary) await flow.onSecondary(); } catch { /* secondary is best effort */ }
      ctx.snooze(c.actionId);
      leave();
    }

    let removed = false;
    function remove() { if (removed) return; removed = true; card.remove(); ctx.onRemoved(c.actionId, card); }
    function leave() { card.classList.add('k-leave'); setTimeout(remove, 480); }
    function enter(delay = 0) {
      setTimeout(() => { requestAnimationFrame(() => requestAnimationFrame(() => card.classList.remove('k-enter'))); }, delay);
    }

    build();
    return { el: card, sig, state: () => card.dataset.state, leave, enter, rebuild: () => build() };
  }

  // ---------- the sheet: keeps the registry of visible cards ----------
  function createSheet(host, hooks) {
    const reg = new Map();
    const ctx = {
      refresh: () => hooks.refresh(),
      snooze: (id) => hooks.snooze(id),
      onRemoved: (id, node) => { const r = reg.get(id); if (r && r.el === node) reg.delete(id); },
    };
    return {
      // list: cards from the server in priority order. isShown(id): whether the presenter/customer state allows showing it.
      sync(list, isShown) {
        const want = list.filter((c) => isShown(c.actionId));
        const wantIds = new Set(want.map((c) => c.actionId));
        for (const [id, r] of reg) if (!wantIds.has(id) && r.state() === 'triggered') { reg.delete(id); r.leave(); }
        let stagger = 0;
        for (const c of want) {
          const sig = JSON.stringify([c.title, c.body, c.cta, c.facts]);
          const r = reg.get(c.actionId);
          if (!r) {
            const card = createCard(c, ctx);
            reg.set(c.actionId, card);
            host.append(card.el);
            card.enter(stagger);
            stagger += 350;
          } else if (r.sig !== sig && r.state() === 'triggered') {
            reg.delete(c.actionId); r.el.remove();
            const card = createCard(c, ctx);
            card.el.classList.remove('k-enter');
            reg.set(c.actionId, card);
            host.append(card.el);
          }
        }
      },
      clear() { for (const [id, r] of reg) { if (r.state() === 'triggered') { reg.delete(id); r.leave(); } } },
    };
  }

  window.KateCards = { createSheet, toPayload, PROCESSING_MS, SUCCESS_MS };
}());
