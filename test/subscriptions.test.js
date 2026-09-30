'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { CUSTOMERS } = require('../src/data');
const { decide, render } = require('../src/engine');
const sub = require('../src/features/subscriptions');

const cust = (id) => structuredClone(CUSTOMERS.find((c) => c.id === id));
const ids = (c) => decide(c).moments.map((m) => m.id).sort();

test('c8: single subscription with a price hike gets a hike card with yearly impact', () => {
  const r = decide(cust('c8'));
  assert.deepStrictEqual(ids(cust('c8')), ['subscription_hike']);
  const f = r.moments[0].facts;
  assert.deepStrictEqual([f.from, f.to, f.yearly], [10, 15, 60]);
  const card = render(r, 'app', cust('c8')).cards[0];
  assert.match(card.title, /€10 to €15/);
  assert.match(card.body, /€60\/year/);
  assert.ok(card.why.length >= 3);
});

test('c9: charge after cancellation and annual renewal, in Dutch', () => {
  assert.deepStrictEqual(ids(cust('c9')), ['subscription_annual', 'subscription_cancelled_charge']);
  const cards = render(decide(cust('c9')), 'app', cust('c9')).cards;
  assert.match(cards[0].title, /na je opzegging/);
});

test('other personas do not get the new cards', () => {
  for (const id of ['c2', 'c4', 'c5', 'c6', 'c7']) {
    assert.ok(!ids(cust(id)).some((m) => m.startsWith('subscription')), id);
  }
  assert.deepStrictEqual(ids(cust('c1')), ['subscriptions']); // overview absorbs hikes, no duplicate card
});

test('injecting a higher charge into a one-subscription customer triggers the hike card', () => {
  const c = cust('c8');
  c.events = c.events.filter((e) => !(e.cat === 'subscription' && e.d < 30));
  assert.deepStrictEqual(ids(c), []);
  c.events.push({ d: 0, cat: 'subscription', amt: -17, m: 'StreamFlix' });
  assert.deepStrictEqual(ids(c), ['subscription_hike']);
});

test('newly identified subscription: three charges, all recent', () => {
  const c = cust('c8');
  c.events = c.events.filter((e) => e.cat !== 'subscription');
  for (const d of [65, 35, 5]) c.events.push({ d, cat: 'subscription', amt: -9, m: 'NewApp' });
  assert.deepStrictEqual(ids(c), ['subscription_new']);
});

test('edge cases: irregular payments, tiny change, cancelled before the last charge', () => {
  const c = cust('c8');
  c.events = c.events.filter((e) => e.cat !== 'subscription');
  for (const d of [80, 50, 5]) c.events.push({ d, cat: 'subscription', amt: -9, m: 'Gappy' }); // 45-day gap
  assert.deepStrictEqual(ids(c), []);
  const c2 = cust('c8');
  for (const e of c2.events) if (e.cat === 'subscription' && e.d === 5) e.amt = -10.2; // +2%: not a hike
  assert.deepStrictEqual(ids(c2), []);
  const c3 = cust('c9');
  c3.events.find((e) => e.cat === 'subscription_cancelled').d = 2; // cancelled after last charge
  assert.ok(!ids(c3).includes('subscription_cancelled_charge'));
});

test('overdraft keeps these care cards; simulated cancellation is labelled and pure', () => {
  const c = cust('c9');
  c.events.push({ d: 3, cat: 'overdraft_fee', amt: -12 });
  const r = decide(c);
  assert.ok(r.decisions.length > 0 && r.decisions.every((d) => d.action.kind === 'care'));
  for (const a of Object.values(sub.actions)) assert.strictEqual(a.kind, 'care');
  const sim = sub.simulateCancellation(cust('c8'), 'StreamFlix');
  assert.ok(sim.simulated && /SIMULATION/.test(sim.label) && /does not cancel/.test(sim.note));
  const c8 = cust('c8');
  c8.events.push(sim.trackEvent, { d: 0, cat: 'subscription', amt: -15, m: 'StreamFlix' });
  c8.events.find((e) => e === sim.trackEvent).d = 3; // cancellation marked, then charged again
  assert.ok(ids(c8).includes('subscription_cancelled_charge'));
});

test('all actions have English and Dutch text', () => {
  const facts = { m: 'X', from: 1, to: 2, yearly: 12, amount: 5, more: 0, daysAgo: 1, cancelledDaysAgo: 5, inDays: 9, count: 2, total: 9, hikes: [], overlaps: [] };
  for (const a of Object.values(sub.actions)) for (const l of ['en', 'nl']) {
    const t = a[l](facts);
    assert.ok(t.title && t.body && t.cta);
  }
});
