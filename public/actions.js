'use strict';
// Card call-to-action flows. Everything is SIMULATED: no message is ever sent to a merchant, airline or bank,
// and nothing changes until the customer approves. All text is rendered with textContent (no innerHTML).
(function () {
  const { api, el, notify, refresh } = window.Kate;
  const money = (n) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
  const btn = (text, onclick, className = '') => el('button', { textContent: text, onclick, className });
  const row = (label, value) => el('div', { className: 'kv' }, el('span', { textContent: label }), el('strong', { textContent: value }));
  const close = (panel) => btn('Close', () => panel.remove(), 'ghost');

  // ---- travel: "what are these payments for?" -----------------------------------------------
  function situation(card, panel) {
    const months = el('select', { id: 'stay-months' });
    for (let m = 1; m <= 12; m++) months.append(el('option', { value: String(m), textContent: `${m} month${m > 1 ? 's' : ''}`, selected: m === 3 }));
    const stayRow = el('div', { hidden: true }, el('label', {}, 'How long will you stay? ', months));
    const send = async (kind, amt) => {
      const ev = { cat: 'travel_confirm', m: kind, amt };
      if (/^[A-Z]{2}$/.test(card.facts.country || '')) ev.c = card.facts.country;
      await api('/api/me/events', 'POST', ev);
      notify(`Thanks, Kate now treats this as: ${{ holiday: 'a holiday', stay: 'a temporary stay', move: 'a move abroad' }[kind]}.`);
      refresh();
    };
    const go = btn('Confirm temporary stay', () => send('stay', Number(months.value)));
    stayRow.append(go);
    panel.append(el('p', { textContent: 'What are these payments for? Your answer beats our guess.' }),
      btn('A holiday', () => send('holiday', 0)), ' ',
      btn('A temporary stay', () => { stayRow.hidden = false; }), ' ',
      btn('A move abroad', () => send('move', 0)), stayRow);
  }

  // ---- travel: prefilled request after a cancelled booking (customer must approve) -----------
  function prefilled(card, panel) {
    const text = `Booking with ${card.facts.booking} was cancelled. I ask for the refund or rebooking options that apply to my booking.`;
    panel.append(el('p', { className: 'sim', textContent: 'SIMULATION: nothing is sent until you approve, and even then only in this demo.' }),
      row('Booking', card.facts.booking), el('pre', { textContent: text }),
      el('p', { className: 'muted', textContent: 'Whether you qualify for a refund or compensation depends on the circumstances. An airline request is separate from an insurance claim.' }),
      btn('Approve request (simulated)', () => { notify(`Request to ${card.facts.booking} approved (simulation). Nothing was actually sent.`); panel.remove(); }), ' ', close(panel));
  }

  // ---- subscriptions: prepare + approve a (simulated) cancellation ----------------------------
  async function cancel(card, panel) {
    const merchants = card.facts.m ? [card.facts.m] : (await api('/api/me/subscriptions')).map((x) => x.m);
    const out = el('div');
    const prepare = async (m) => {
      const r = await api('/api/me/subscriptions/cancel', 'POST', { merchant: m });
      out.replaceChildren(el('p', { className: 'sim', textContent: r.label }), el('pre', { textContent: r.request.text }),
        el('ul', {}, ...r.steps.map((s) => el('li', { textContent: s }))), el('p', { className: 'muted', textContent: r.note }),
        btn('Approve (simulated)', async () => {
          await api('/api/me/subscriptions/cancel', 'POST', { merchant: m, approve: true });
          notify(`Cancellation of ${m} approved (simulation). Nothing was sent. Kate now watches for further charges.`);
          refresh();
        }));
    };
    panel.append(el('p', { textContent: 'Which subscription do you want to cancel? Stopping payments is not the same as cancelling the contract.' }),
      ...merchants.flatMap((m) => [btn(`Cancel ${m}`, () => prepare(m)), ' ']), close(panel), out);
  }

  // ---- household: approve a (simulated) transfer from savings -------------------------------
  function transfer(card, panel) {
    const f = card.facts;
    panel.append(el('p', { className: 'sim', textContent: 'SIMULATION: only moves money between your own accounts, only after you approve.' }),
      row('Upcoming bill', `${f.m} ${money(f.need)} in ${f.dueIn} day(s)`), row('Payment account', money(f.account)), row('Short by', money(f.short)),
      row('Transfer', `${money(f.transfer.amount)} from savings to payment account`),
      btn(`Approve ${money(f.transfer.amount)} transfer`, async () => {
        const r = await api('/api/me/transfer', 'POST', { amount: f.transfer.amount });
        notify(`Transfer approved (simulation). Payment account now ${money(r.balance)}, savings ${money(r.savings)}.`);
        refresh();
      }), ' ', close(panel));
  }

  // ---- savings: show the sums, let the customer correct them and say what the money is for ----
  function savings(card, panel) {
    const f = card.facts;
    const reserve = el('input', { type: 'number', min: '0', step: '100', value: String(f.reserve) });
    const result = el('p', { className: 'muted' });
    const route = (text) => () => { result.textContent = text; };
    panel.append(el('p', { textContent: 'How we got there (correct anything that is off):' }),
      row('Balance', money(f.balance)), row('Bills per month', money(f.bills)), row('Everyday spending per month', money(f.everyday)),
      row('Renewals coming up', money(f.planned)), row(f.reserveChosen ? 'Your reserve' : 'Default reserve (3 months)', money(f.reserve)),
      el('label', {}, 'Reserve to keep: ', reserve), btn('Update reserve', async () => {
        await api('/api/me/preferences', 'PUT', { reserve: Number(reserve.value) });
        notify('Reserve updated, estimate recalculated.');
        refresh();
      }), ' ', btn('Use default', async () => { await api('/api/me/preferences', 'PUT', { reserve: null }); refresh(); }, 'ghost'),
      el('p', { textContent: 'Is this money needed for something coming up?' }),
      btn('Yes, soon', route('Okay, we keep it accessible. Nothing moves.')), ' ',
      btn('I am building a reserve', route(`Suggestion: an accessible ${f.product.name}. Nothing moves until you approve.`)), ' ',
      btn('No, long-term', route('Next step: a guided investment profile (objectives, risk comfort, finances, horizon). Kate gives no investment advice.')),
      result, close(panel));
  }

  function info(card, panel) {
    panel.append(el('p', { className: 'sim', textContent: 'SIMULATION' }),
      el('p', { textContent: `This would open: ${card.product ? card.product.name : 'the related KBC service'}.` }), close(panel));
  }

  const SUBS = cancel;
  const HANDLERS = {
    'trip-question': situation,
    'travel-cover': (c, p) => (c.facts.confirmed ? info(c, p) : situation(c, p)),
    'moving-abroad': (c, p) => (c.facts.confirmed ? info(c, p) : situation(c, p)),
    'travel-disruption': (c, p) => (c.facts.booking ? prefilled(c, p) : info(c, p)),
    'review-subscriptions': SUBS, 'subscription-hike': SUBS, 'subscription-cancelled-charge': SUBS, 'subscription-annual': SUBS,
    'household-bill-shortfall': (c, p) => (c.facts.transfer ? transfer(c, p) : info(c, p)),
    'excess-cash': savings,
  };

  window.KateActions = {
    open(card, cardEl) {
      const old = cardEl.querySelector('.panel');
      if (old) { old.remove(); return; }
      const panel = el('div', { className: 'panel' });
      cardEl.append(panel);
      (HANDLERS[card.actionId] || info)(card, panel);
    },
  };
}());
