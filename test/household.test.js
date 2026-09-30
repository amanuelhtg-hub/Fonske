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

test('household: shortfall is care (survives overdraft) and text exists in EN and NL', () => {
  const c = cust('hh2'); c.events.push({ d: 2, cat: 'overdraft_fee', amt: -12 });
  const r = decide(c);
  assert.ok(r.decisions.some((d) => d.moment === 'bill_shortfall'));
  assert.match(render(r, 'app', c).cards[0].title, /tekort/);
  const e = cust('hh2'); e.lang = 'en';
  assert.match(render(decide(e), 'app', e).cards[0].title, /short/);
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
