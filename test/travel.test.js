'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { CUSTOMERS } = require('../src/data');
const { decide, render } = require('../src/engine');

const cust = (id) => structuredClone(CUSTOMERS.find((c) => c.id === id));
const ids = (c) => decide(c).moments.map((m) => m.id).sort();

test('booking without foreign spending asks what the trip is', () => {
  assert.deepStrictEqual(ids(cust('tr1')), ['trip_upcoming']);
  const card = render(decide(cust('tr1')), 'app', cust('tr1')).cards[0];
  assert.match(card.body, /holiday, a work trip, a temporary stay or a move/);
});

test('confirmed temporary stay yields the cover-duration card, not relocation', () => {
  const r = decide(cust('tr2'));
  assert.deepStrictEqual(ids(cust('tr2')), ['temporary_stay']);
  assert.strictEqual(r.moments[0].facts.months, 3);
  assert.match(render(r, 'app', cust('tr2')).cards[0].body, /travel cover applies for the full period/);
});

test('cancelled booking gives a prefilled-request card without promising compensation', () => {
  const r = decide(cust('tr3'));
  assert.deepStrictEqual(ids(cust('tr3')), ['travel_disruption']);
  const body = render(r, 'app', cust('tr3')).cards[0].body;
  assert.match(body, /depends on the circumstances/);
  assert.doesNotMatch(body, /you will (receive|get)/i);
});

test('the answer overrides the heuristic both ways', () => {
  const c5 = cust('c5'); // looks like a move
  c5.events.push({ d: 1, cat: 'travel_confirm', amt: 0, m: 'holiday', c: 'DE' });
  assert.ok(!ids(c5).includes('relocation'));
  const c4 = cust('c4'); // looks like a holiday
  c4.events.push({ d: 1, cat: 'travel_confirm', amt: 0, m: 'move', c: 'ES' });
  assert.deepStrictEqual(ids(c4), ['relocation']);
  assert.ok(decide(c4).moments[0].facts.confirmed);
});

test('does not fire for unrelated personas, or for a booking when already abroad', () => {
  for (const id of ['c1', 'c2', 'c3', 'c6', 'c7']) assert.ok(!ids(cust(id)).some((m) => /travel|trip|stay|relocation/.test(m)), id);
  const c = cust('tr1');
  for (let i = 0; i < 4; i++) c.events.push({ d: i, cat: 'abroad', amt: -80, c: 'IT' });
  assert.ok(!ids(c).includes('trip_upcoming'));
});

test('old bookings are ignored and overdraft suppresses the commercial cards', () => {
  const c = cust('tr1');
  c.events.forEach((e) => { if (e.cat === 'travel_booking') e.d += 100; });
  assert.deepStrictEqual(ids(c), []);
  const t = cust('tr2');
  t.events.push({ d: 2, cat: 'overdraft_fee', amt: -12 });
  assert.ok(decide(t).decisions.every((d) => d.action.kind === 'care'));
  assert.strictEqual(decide(t).decisions.length, 0);
});

test('every travel action renders title, body and cta', () => {
  const { ACTIONS } = require('../src/features');
  for (const id of ['trip_upcoming', 'travel', 'temporary_stay', 'travel_disruption', 'relocation']) {
    for (const f of [{ country: 'ES', merchant: 'X', booking: 'X' }, { confirmed: true, cost: 10, months: 3 }]) {
      const t = ACTIONS[id].en(f); assert.ok(t.title && t.body && t.cta);
    }
  }
});

test('odd inputs: refunds, missing merchants and empty events do not misfire', () => {
  const c = cust('tr1');
  const tv = (x) => ids(x).filter((m) => /travel|trip|stay|relocation/.test(m));
  assert.deepStrictEqual(tv({ ...c, events: [] }), []);
  c.events.forEach((e) => { if (e.cat === 'travel_booking') e.amt = Math.abs(e.amt); });
  assert.deepStrictEqual(tv(c), []);
  const n = cust('tr1');
  n.events.forEach((e) => { delete e.m; });
  const card = render(decide(n), 'app', n).cards[0];
  assert.ok(!/undefined/.test(card.title + card.body));
  const x = cust('tr3');
  delete x.events.find((e) => e.cat === 'booking_cancelled').m;
  assert.ok(decide(x).moments.find((m) => m.id === 'travel_disruption').facts.booking);
});

const plus = (id, ...ev) => { const c = cust(id); c.events.push(...ev); return c; };
const card = (c) => render(decide(c), 'app', c).cards;

test('business trip: confirmed work trip gets expense help and no personal cross-sell', () => {
  const c = cust('tr4');
  assert.deepStrictEqual(ids(c).filter((m) => /travel|trip|stay|relocation|business/.test(m)), ['business_trip']);
  const r = decide(c);
  assert.strictEqual(r.decisions[0].action.kind, 'care');
  assert.match(card(c)[0].cta, /business expense/);
  // unconfirmed, the same bookings only trigger the question
  c.events = c.events.filter((e) => e.cat !== 'travel_confirm');
  assert.deepStrictEqual(ids(c).filter((m) => /trip|business/.test(m)), ['trip_upcoming']);
});

test('confidence gate: a small booking is not worth an alert', () => {
  const c = cust('tr1');
  c.events.forEach((e) => { if (e.cat === 'travel_booking') e.amt = -12; });
  assert.ok(!ids(c).includes('trip_upcoming'));
});

test('long stay warns about cover caps, short stay does not', () => {
  const long = plus('tr2', { d: 1, cat: 'travel_confirm', amt: 5, m: 'stay', c: 'PT' });
  assert.match(card(long)[0].body, /120 consecutive days.*longer than that/);
  assert.doesNotMatch(card(cust('tr2'))[0].body, /longer than that/);
});

test('confirmed move lists recurring home payments as a checklist item', () => {
  const c = cust('c5');
  c.events.push({ d: 1, cat: 'travel_confirm', amt: 0, m: 'move', c: 'DE' }, { d: 5, cat: 'utility', amt: -60, m: 'Electrabel' });
  const m = decide(c).moments.find((x) => x.id === 'relocation');
  assert.ok(m.facts.bills.includes('Electrabel'));
  assert.match(card(c)[0].body, /Electrabel/);
});

test('delay: threshold wording depends on hours and never promises money', () => {
  const short = plus('tr1', { d: 1, cat: 'flight_delay', amt: 2, m: 'Ryanair' });
  assert.ok(!card(short)[0].body.includes('statutory'));
  const long = plus('tr1', { d: 1, cat: 'flight_delay', amt: 4, m: 'Ryanair' }, { d: 1, cat: 'travel_pnr', amt: 0, m: 'X4J9LQ' });
  const m = decide(long).moments.find((x) => x.id === 'travel_disruption');
  assert.deepStrictEqual([m.facts.delayHours, m.facts.pnr, m.facts.booking], [4, 'X4J9LQ', 'Ryanair']);
  const b = card(long)[0].body;
  assert.match(b, /statutory claim is possible/);
  assert.doesNotMatch(b, /you are owed|you will receive|€\d+ compensation/i);
  assert.ok(!ids(long).includes('trip_upcoming'));
  assert.ok(!decide(plus('tr1', { d: 1, cat: 'flight_delay', amt: 0, m: 'X' })).moments.some((x) => x.id === 'travel_disruption'));
  assert.strictEqual(decide(plus('tr1', { d: 1, cat: 'travel_pnr', amt: 0, m: 'bad' })).moments[0].facts.pnr, null);
});

test('payout from the carrier closes the loop', () => {
  assert.deepStrictEqual(ids(cust('tr5')).filter((m) => /claim|disruption/.test(m)), ['claim_settled']);
  const c = plus('tr3', { d: 2, cat: 'claim_payout', amt: 400, m: 'Brussels Airlines' });
  const moments = ids(c);
  assert.ok(moments.includes('claim_settled') && !moments.includes('travel_disruption'));
  assert.match(card(c)[0].title, /€400 from Brussels Airlines/);
  assert.ok(!ids(plus('tr3', { d: 2, cat: 'claim_payout', amt: -400, m: 'X' })).includes('claim_settled'));
});
