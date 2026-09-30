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

test('savings: odd inputs do not fire or crash', () => {
  const base = () => { const c = cust('sav1'); c.prefs = {}; return c; };
  const none = base(); none.events = [];
  assert.strictEqual(excess(none), undefined); // no history: nothing to forecast from
  const one = base(); one.events = [{ d: 0, cat: 'groceries', amt: -50 }]; one.balance = 50000;
  assert.ok(excess(one)); // single event still forecastable
  const old = base(); old.events = [{ d: 400, cat: 'rent', amt: -900 }];
  assert.strictEqual(excess(old), undefined);
  const zero = base(); zero.events = [{ d: 1, cat: 'groceries', amt: 0 }, { d: 2, cat: 'rent', amt: 500 }];
  assert.strictEqual(excess(zero), undefined);
  const neg = base(); neg.balance = -100;
  assert.strictEqual(excess(neg), undefined);
  const off = cust('sav1'); off.consent.transactionInsights = false;
  assert.deepStrictEqual(decide(off).moments, []);
});

test('savings: wording names the savings account, never a fund, and promises no return', () => {
  const c = cust('sav1'); c.prefs.riskComfort = 'high';
  const card = render(decide(c), 'app', c).cards[0];
  assert.ok(!/fund|return|rendement|guarantee/i.test(card.title + card.body));
  assert.strictEqual(card.facts.savingsProduct.id, 'kbc-savings');
});

test('autopilot: prepares a one-tap transfer below the surplus, to savings by default', () => {
  const f = excess(cust('sav1')).facts;
  assert.strictEqual(f.savingsTransfer.amount, 700); // 900 surplus minus 10% uncertainty buffer, rounded down
  assert.strictEqual(f.savingsTransfer.toProductId, 'kbc-savings');
  assert.strictEqual(f.automation.authorized, false);
  const c = cust('sav1'); const card = render(decide(c), 'app', c).cards[0];
  assert.ok(card.body.includes('€700') && card.body.includes('one-tap'));
});

test('autopilot: investment destination only with an existing investment profile', () => {
  const c = cust('sav1'); c.prefs.riskComfort = 'medium';
  assert.strictEqual(excess(c).facts.savingsTransfer.toProductId, 'kbc-savings');
  c.prefs.investmentProfile = true;
  const f = excess(c).facts;
  assert.strictEqual(f.savingsTransfer.toProductId, 'kbc-balanced-fund');
  assert.strictEqual(f.hasInvestmentProfile, true);
});

test('autopilot: amount shrinks when spending rises and stops when income goes quiet', () => {
  const rising = cust('sav1');
  rising.balance = 6000;
  const normal = excess(rising).facts.savingsTransfer.amount;
  rising.events.push({ d: 5, cat: 'groceries', amt: -500 });
  const r = excess(rising);
  assert.ok(!r || r.facts.savingsTransfer.amount < normal);
  const quiet = cust('sav1');
  quiet.events = quiet.events.filter((e) => e.cat !== 'salary' || e.d >= 45);
  assert.strictEqual(excess(quiet), undefined);
});

test('autopilot: authorized automation is capped at the agreed limit', () => {
  const c = cust('sav1'); c.prefs.autoSave = { max: 300 };
  const f = excess(c).facts;
  assert.strictEqual(f.savingsTransfer.amount, 300);
  assert.deepStrictEqual(f.automation, { authorized: true, maxMonthly: 300 });
});
