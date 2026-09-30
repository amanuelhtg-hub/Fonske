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
  assert.match(card.body, /holiday, a temporary stay or a move/);
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
