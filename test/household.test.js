'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { CUSTOMERS } = require('../src/data');
const { decide, render } = require('../src/engine');

const cust = (id) => structuredClone(CUSTOMERS.find((c) => c.id === id));
const ids = (id) => decide(cust(id)).moments.map((m) => m.id);

test('household: bill increase detected for hh1 only', () => {
  const m = decide(cust('hh1')).moments.find((x) => x.id === 'bill_increase');
  assert.deepStrictEqual([m.facts.from, m.facts.to, m.facts.energy], [45, 60, false]);
  for (const id of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'hh2']) assert.ok(!ids(id).includes('bill_increase'), id);
});

test('household: shortfall with linked-savings transfer for hh2 only', () => {
  const m = decide(cust('hh2')).moments.find((x) => x.id === 'bill_shortfall');
  assert.strictEqual(m.facts.short, 80);
  assert.strictEqual(m.facts.dueIn, 1);
  assert.deepStrictEqual(m.facts.transfer, { from: 'savings', to: 'payment account', amount: 80 });
  for (const id of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'hh1']) assert.ok(!ids(id).includes('bill_shortfall'), id);
});

test('household: shortfall without savings gives no transfer; enough balance gives no shortfall', () => {
  const c = cust('hh2'); delete c.savings;
  const m = decide(c).moments.find((x) => x.id === 'bill_shortfall');
  assert.strictEqual(m.facts.transfer, null);
  c.balance = 500;
  assert.ok(!decide(c).moments.some((x) => x.id === 'bill_shortfall'));
});

test('household: energy increase is framed with the usage caveat', () => {
  const c = cust('c6');
  c.events.filter((e) => e.m === 'Energy supplier').forEach((e) => { if (e.d < 10) e.amt = -220; });
  const m = decide(c).moments.find((x) => x.id === 'bill_increase');
  assert.ok(m.facts.energy && m.evidence.some((e) => e.includes('consumption')));
});

test('household: not fired for one-off payments or a stale bill', () => {
  const c = cust('hh1');
  c.events = c.events.filter((e) => e.m !== 'Internet provider').concat({ d: 2, cat: 'utility', amt: -60, m: 'Internet provider' });
  assert.ok(!decide(c).moments.some((x) => x.id === 'bill_increase'));
});

test('household: shortfall is care (survives overdraft) and says how much is missing', () => {
  const c = cust('hh2'); c.events.push({ d: 2, cat: 'overdraft_fee', amt: -12 });
  const r = decide(c);
  assert.ok(r.decisions.some((d) => d.moment === 'bill_shortfall'));
  assert.match(render(r, 'app', c).cards[0].title, /€80 short/);
});

test('household: odd inputs do not crash or fire', () => {
  const base = cust('hh2');
  for (const events of [[], [{ d: 1, cat: 'utility', amt: -60, m: 'X' }], [{ d: 900, cat: 'utility', amt: -60, m: 'X' }],
    [{ d: 1, cat: 'utility', amt: 0, m: 'X' }, { d: 31, cat: 'utility', amt: 50, m: 'X' }, { d: 61, cat: 'utility', amt: 0, m: 'X' }],
    [1, 2, 3].map((i) => ({ d: i * 30, cat: 'utility', amt: -50 }))]) {
    const r = decide({ ...base, events });
    assert.ok(!r.moments.some((m) => m.id.startsWith('bill_')));
  }
});

test('household: refunds (positive utility amounts) are ignored and consent off means no analysis', () => {
  const c = cust('hh1');
  c.events.forEach((e) => { if (e.m === 'Internet provider') e.amt = -e.amt; });
  assert.ok(!decide(c).moments.some((m) => m.id === 'bill_increase'));
  const n = cust('hh2'); n.consent.transactionInsights = false;
  assert.deepStrictEqual(decide(n).moments, []);
});

test('contract watch: ended discount + document gives a prepared same-provider change (hh3)', () => {
  const m = decide(cust('hh3')).moments.find((x) => x.id === 'contract_watch');
  assert.strictEqual(m.facts.status, 'ready');
  assert.deepStrictEqual([m.facts.monthlySaving, m.facts.annualSaving, m.facts.newPlan, m.facts.promoEnded], [12, 144, 'Fibre 100 Web', true]);
  assert.deepStrictEqual(m.facts.prepared, { type: 'plan_change', supplier: 'Internet provider', fromPlan: 'Fibre 100', toPlan: 'Fibre 100 Web' });
  assert.ok(!decide(cust('hh3')).moments.some((x) => x.id === 'bill_increase'), 'no duplicate card for the same bill');
  const card = render(decide(cust('hh3')), 'app', cust('hh3')).cards[0];
  assert.match(card.body, /€144/);
  for (const id of ['c1', 'c6', 'hh1', 'hh2']) assert.ok(!ids(id).includes('contract_watch'), id);
});

test('contract watch: no document means no comparison; hh1 keeps the plain bill_increase', () => {
  const c = cust('hh3'); delete c.documents;
  const r = decide(c).moments.map((m) => m.id);
  assert.ok(r.includes('bill_increase') && !r.includes('contract_watch'));
});

test('contract watch: energy without usage asks for the bill and makes no saving claim', () => {
  const c = cust('hh3');
  c.events.forEach((e) => { if (e.m === 'Internet provider') e.m = 'Energy supplier'; });
  c.documents = [{ m: 'Energy supplier', plan: 'Variable', renewalInDays: 90 }];
  const m = decide(c).moments.find((x) => x.id === 'contract_watch');
  assert.strictEqual(m.facts.status, 'needs_info');
  assert.ok(m.facts.missing.includes('yearly usage (kWh)') && m.facts.annualSaving === undefined);
});

test('contract watch: no cheaper equal-speed plan, tiny saving, or stale discount = no card', () => {
  const a = cust('hh3'); a.documents[0].speedMbps = 500;
  assert.ok(!decide(a).moments.some((x) => x.id === 'contract_watch'));
  const b = cust('hh3'); b.documents = [{ m: 'Internet provider', plan: 'Fibre 100', speedMbps: 100, renewalInDays: 10 }];
  b.events.forEach((e) => { if (e.m === 'Internet provider' && e.d <= 12) e.amt = -50; });
  assert.ok(!decide(b).moments.some((x) => x.id === 'contract_watch'));
});

test('contract watch: overdraft customer still gets it (care), odd documents do not crash', () => {
  const c = cust('hh3'); c.events.push({ d: 2, cat: 'overdraft_fee', amt: -12 });
  assert.ok(decide(c).decisions.some((d) => d.moment === 'contract_watch'));
  for (const documents of [null, [], [{}], [{ m: 'Internet provider' }], 'x']) assert.doesNotThrow(() => decide({ ...cust('hh3'), documents }));
});
