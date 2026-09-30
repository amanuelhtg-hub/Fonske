'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { CUSTOMERS } = require('../src/data');
const { decide, render } = require('../src/engine');

const cust = (id) => structuredClone(CUSTOMERS.find((c) => c.id === id));
const excess = (c) => decide(c).moments.find((m) => m.id === 'excess_cash');

test('savings: illustrative surplus is 900 with a chosen reserve', () => {
  const m = excess(cust('sav1'));
  assert.ok(m);
  assert.strictEqual(m.facts.excess, 900);
  assert.strictEqual(m.facts.reserve, 1500);
  assert.strictEqual(m.facts.bills, 1200);
  assert.strictEqual(m.facts.everyday, 600);
  assert.ok(m.evidence[0].includes('€900'));
});

test('savings: customer can correct the reserve', () => {
  const c = cust('sav1');
  c.prefs.reserve = 3500;
  assert.strictEqual(excess(c), undefined);
});

test('savings: a single large incoming payment is not enough', () => {
  assert.strictEqual(excess(cust('sav2')), undefined);
});

test('savings: does not fire for customers without surplus', () => {
  for (const id of ['c1', 'c3', 'c4', 'c5', 'c7']) assert.strictEqual(excess(cust(id)), undefined, id);
});

test('savings: upcoming annual renewal is reserved, not double counted', () => {
  const m = excess(cust('c6'));
  assert.strictEqual(m.facts.planned, 620);
});

test('savings: suppressed in overdraft, and the card explains the investment profile', () => {
  const c = cust('sav1');
  c.events.push({ d: 2, cat: 'overdraft_fee', amt: -12 });
  assert.strictEqual(decide(c).decisions.length, 0);
  const ok = cust('sav1');
  const card = render(decide(ok), 'app', ok).cards[0];
  assert.ok(card.title.includes('€900') && card.body.includes('investment profile'));
});
