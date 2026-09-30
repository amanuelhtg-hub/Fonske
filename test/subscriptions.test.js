'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { CUSTOMERS } = require('../src/data');
const { decide, render } = require('../src/engine');
const sub = require('../src/features/subscriptions');

const cust = (id) => structuredClone(CUSTOMERS.find((c) => c.id === id));
const ids = (c) => decide(c).moments.map((m) => m.id).sort();

test('sub1: single subscription with a price hike gets a hike card with yearly impact', () => {
  const r = decide(cust('sub1'));
  assert.deepStrictEqual(ids(cust('sub1')), ['subscription_hike']);
  const f = r.moments[0].facts;
  assert.deepStrictEqual([f.from, f.to, f.yearly], [10, 15, 60]);
  const card = render(r, 'app', cust('sub1')).cards[0];
  assert.match(card.title, /€10 to €15/);
  assert.match(card.body, /€60\/year/);
  assert.ok(card.why.length >= 3);
});

test('sub2: charge after cancellation and annual renewal', () => {
  assert.deepStrictEqual(ids(cust('sub2')), ['subscription_annual', 'subscription_cancelled_charge']);
  const cards = render(decide(cust('sub2')), 'app', cust('sub2')).cards;
  assert.match(cards[0].title, /after you cancelled/);
});

test('other personas do not get the new cards', () => {
  for (const id of ['c2', 'c4', 'c5', 'c6', 'c7']) {
    assert.ok(!ids(cust(id)).some((m) => m.startsWith('subscription')), id);
  }
  assert.deepStrictEqual(ids(cust('c1')), ['subscriptions']); // overview absorbs hikes, no duplicate card
});

test('injecting a higher charge into a one-subscription customer triggers the hike card', () => {
  const c = cust('sub1');
  c.events = c.events.filter((e) => !(e.cat === 'subscription' && e.d < 30));
  assert.deepStrictEqual(ids(c), []);
  c.events.push({ d: 0, cat: 'subscription', amt: -17, m: 'StreamFlix' });
  assert.deepStrictEqual(ids(c), ['subscription_hike']);
});

test('newly identified subscription: three charges, all recent', () => {
  const c = cust('sub1');
  c.events = c.events.filter((e) => e.cat !== 'subscription');
  for (const d of [65, 35, 5]) c.events.push({ d, cat: 'subscription', amt: -9, m: 'NewApp' });
  assert.deepStrictEqual(ids(c), ['subscription_new']);
});

test('edge cases: irregular payments, tiny change, cancelled before the last charge', () => {
  const c = cust('sub1');
  c.events = c.events.filter((e) => e.cat !== 'subscription');
  for (const d of [80, 50, 5]) c.events.push({ d, cat: 'subscription', amt: -9, m: 'Gappy' }); // 45-day gap
  assert.deepStrictEqual(ids(c), []);
  const c2 = cust('sub1');
  for (const e of c2.events) if (e.cat === 'subscription' && e.d === 5) e.amt = -10.2; // +2%: not a hike
  assert.deepStrictEqual(ids(c2), []);
  const c3 = cust('sub2');
  c3.events.find((e) => e.cat === 'subscription_cancelled').d = 2; // cancelled after last charge
  assert.ok(!ids(c3).includes('subscription_cancelled_charge'));
});

test('overdraft keeps these care cards; simulated cancellation is labelled and pure', () => {
  const c = cust('sub2');
  c.events.push({ d: 3, cat: 'overdraft_fee', amt: -12 });
  const r = decide(c);
  assert.ok(r.decisions.length > 0 && r.decisions.every((d) => d.action.kind === 'care'));
  for (const a of Object.values(sub.actions)) assert.strictEqual(a.kind, 'care');
  const sim = sub.simulateCancellation(cust('sub1'), 'StreamFlix');
  assert.ok(sim.simulated && /SIMULATION/.test(sim.label) && /does not cancel/.test(sim.note));
  const sub1 = cust('sub1');
  sub1.events.push(sim.trackEvent, { d: 0, cat: 'subscription', amt: -15, m: 'StreamFlix' });
  sub1.events.find((e) => e === sim.trackEvent).d = 3; // cancellation marked, then charged again
  assert.ok(ids(sub1).includes('subscription_cancelled_charge'));
});

test('all actions render title, body and cta', () => {
  const facts = { m: 'X', from: 1, to: 2, yearly: 12, amount: 5, more: 0, daysAgo: 1, cancelledDaysAgo: 5, inDays: 9, count: 2, total: 9, hikes: [], overlaps: [] };
  for (const a of Object.values(sub.actions)) {
    const t = a.en(facts);
    assert.ok(t.title && t.body && t.cta);
  }
});

test('odd input: empty, single, merchant-less, credits and very old events never fire', () => {
  const base = cust('sub1');
  const run = (events) => ids({ ...base, events }).filter((m) => m.startsWith('subscription'));
  assert.deepStrictEqual(run([]), []);
  assert.deepStrictEqual(run([{ d: 0, cat: 'subscription', amt: -5, m: 'A' }]), []);
  assert.deepStrictEqual(run([30, 60, 90].map((d) => ({ d, cat: 'subscription', amt: -5 }))), []);
  assert.deepStrictEqual(run([5, 35, 65].map((d) => ({ d, cat: 'subscription', amt: 9, m: 'Refunds' }))), []);
  assert.deepStrictEqual(run([305, 335, 365].map((d) => ({ d, cat: 'subscription', amt: -9, m: 'Old' }))), []);
});

test('consent off: nothing is analysed', () => {
  const c = cust('sub1');
  c.consent = { personalization: true, transactionInsights: false, advisorInsights: false };
  assert.deepStrictEqual(ids(c), []);
});

test('wording never promises refunds or returns', () => {
  const facts = { m: 'X', from: 1, to: 2, yearly: 12, amount: 5, more: 0, daysAgo: 1, cancelledDaysAgo: 5, inDays: 9, count: 2, total: 9, hikes: [], overlaps: [] };
  for (const a of Object.values(sub.actions)) {
    const t = a.en(facts);
    assert.ok(!/refund|guarantee/i.test(`${t.title} ${t.body}`));
  }
});

test('trial: a tiny card-verification payment yields a reminder card, never a block', () => {
  assert.deepStrictEqual(ids(cust('sub3')), ['subscription_trial_started']);
  const f = decide(cust('sub3')).moments[0].facts;
  assert.deepStrictEqual([f.daysAgo, f.expectedInDays, f.reminderInDays], [10, 20, 17]);
  const card = render(decide(cust('sub3')), 'app', cust('sub3')).cards[0];
  assert.match(card.body, /Nothing is blocked/);
  assert.match(card.cta, /reminder/i);
  assert.ok(card.why.every((w) => !/guarantee|refund/i.test(w)));
});

test('trial: not for real charges, old pings, billed/cancelled/reminded trials', () => {
  const run = (mut) => { const c = cust('sub3'); mut(c); return ids(c); };
  assert.deepStrictEqual(run((c) => { c.events.find((e) => e.cat === 'subscription_trial').amt = -15; }), []); // a real charge
  assert.deepStrictEqual(run((c) => { c.events.find((e) => e.cat === 'subscription_trial').d = 45; }), []);
  assert.deepStrictEqual(run((c) => c.events.push({ d: 2, cat: 'subscription', amt: -12, m: 'LearnPlus' })), []);
  assert.deepStrictEqual(run((c) => c.events.push({ d: 3, cat: 'subscription_cancelled', amt: 0, m: 'LearnPlus' })), []);
  assert.deepStrictEqual(run((c) => c.events.push(sub.setTrialReminder(c, 'LearnPlus').trackEvent)), []);
  assert.deepStrictEqual(run((c) => { c.events.find((e) => e.cat === 'subscription_trial').d = 29; }), ['subscription_trial_started']);
});

test('trial card is care (kept under overdraft); other personas never get it', () => {
  const c = cust('sub3'); c.events.push({ d: 1, cat: 'overdraft_fee', amt: -12 });
  assert.ok(decide(c).decisions.some((d) => d.moment === 'subscription_trial_started'));
  for (const id of ['sub1', 'sub2', 'c1', 'c2']) assert.ok(!ids(cust(id)).includes('subscription_trial_started'));
});

test('cancellation help points at the direct debit mandate manager and promises no refund', () => {
  const sim = sub.simulateCancellation(cust('sub2'), 'Spotify');
  assert.strictEqual(sim.product.id, 'kbc-sdd-mandates');
  assert.ok(sim.steps.some((s) => /mandate manager/.test(s)));
  assert.match(sim.note, /does not cancel the contract/);
  const card = render(decide(cust('sub2')), 'app', cust('sub2')).cards.find((x) => x.moment === 'subscription_cancelled_charge');
  assert.strictEqual(card.product.id, 'kbc-sdd-mandates');
});

test('keep marker silences the hike and annual cards', () => {
  const c = cust('sub1'); c.events.push({ d: 1, cat: 'subscription_kept', amt: 0, m: 'StreamFlix' });
  assert.deepStrictEqual(ids(c), []);
  const a = cust('sub2'); a.events.push({ d: 1, cat: 'subscription_kept', amt: 0, m: 'Photo cloud plan' });
  assert.ok(!ids(a).includes('subscription_annual'));
});

test('overview lists cost, frequency, next charge, status and monthly total', () => {
  const o = sub.subscriptionOverview(cust('sub2'));
  const sp = o.items.find((x) => x.m === 'Spotify');
  assert.deepStrictEqual([sp.amount, sp.frequency, sp.nextInDays, sp.status], [11, 'monthly', 25, 'charged after cancellation']);
  const cl = o.items.find((x) => x.m === 'Photo cloud plan');
  assert.deepStrictEqual([cl.frequency, cl.nextInDays], ['yearly', 15]);
  assert.strictEqual(o.monthlyTotal, Math.round((11 + 89 / 12) * 100) / 100);
  assert.strictEqual(sub.subscriptionOverview(cust('sub1')).items[0].status, 'price increased');
  const tr = sub.subscriptionOverview(cust('sub3'));
  assert.deepStrictEqual([tr.items[0].frequency, tr.items[0].nextInDays, tr.items[0].amount, tr.monthlyTotal], ['trial', 20, null, 0]);
  assert.deepStrictEqual(sub.subscriptionOverview({ ...cust('sub1'), events: [] }), { items: [], monthlyTotal: 0 });
});
