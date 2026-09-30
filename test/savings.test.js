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

test('autopilot: investment destination only with a profile AND a fully built reserve', () => {
  const c = cust('sav1'); c.prefs.riskComfort = 'medium'; c.prefs.investmentProfile = true;
  let f = excess(c).facts;
  assert.strictEqual(f.tier, 'safety_buffer'); // reserve not yet in savings: savings first, even with a profile
  assert.strictEqual(f.bufferGap, 1500);
  assert.strictEqual(f.savingsTransfer.toProductId, 'kbc-savings');
  assert.strictEqual(f.microInvest, null);
  c.savings = 1500; // reserve fully held in savings
  f = excess(c).facts;
  assert.strictEqual(f.tier, 'wealth');
  assert.strictEqual(f.savingsTransfer.toProductId, 'kbc-balanced-fund');
  assert.strictEqual(f.microInvest.minMonthly, 25);
  assert.strictEqual(f.microInvest.needsProfile, false);
  delete c.prefs.investmentProfile; // reserve met but no profile: still savings, investing is a handoff
  f = excess(c).facts;
  assert.strictEqual(f.savingsTransfer.toProductId, 'kbc-savings');
  assert.strictEqual(f.microInvest.needsProfile, true);
});

test('idle cash: opportunity cost is a labelled estimate, not a promise', () => {
  const m = excess(cust('sav1'));
  assert.strictEqual(m.facts.idleCost, 11); // 700 x 1.5%
  assert.ok(m.evidence.some((e) => e.includes('illustrative') && e.includes('differ')));
  const c = cust('sav1'); const body = render(decide(c), 'app', c).cards[0].body;
  assert.ok(body.includes('illustrative') && !/guarantee|will earn|risk-free/i.test(body));
});

test('clawback: unexpected debit below the reserve offers a 1-tap transfer back', () => {
  const m = decide(cust('sav3')).moments.find((x) => x.id === 'buffer_clawback');
  assert.ok(m);
  assert.strictEqual(m.facts.transfer.amount, 400); // reserve 1500 - balance 1100
  assert.strictEqual(m.facts.transfer.from, 'savings');
  assert.ok(m.evidence[0].includes('€450'));
  assert.ok(m.evidence[1].includes('instant savings account'));
  const c = cust('sav3'); const card = render(decide(c), 'app', c).cards[0];
  assert.ok(card.body.includes('available instantly') && card.product.id === 'kbc-savings');
  assert.strictEqual(excess(cust('sav3')), undefined);
});

test('clawback: stays quiet without savings, without a breach, or without an unexpected debit', () => {
  const has = (c) => decide(c).moments.some((x) => x.id === 'buffer_clawback');
  const a = cust('sav3'); a.savings = 0; a.events = a.events.filter((e) => e.cat !== 'savings_transfer');
  assert.strictEqual(has(a), false);
  const b = cust('sav3'); b.balance = 1600;
  assert.strictEqual(has(b), false);
  const d = cust('sav3'); d.events = d.events.filter((e) => e.cat !== 'disruption');
  assert.strictEqual(has(d), false);
  const small = cust('sav3'); small.balance = 1450; small.savings = 50; // savings below the minimum
  assert.strictEqual(has(small), false);
});

test('clawback: is care, so it survives overdraft, and capped at savings', () => {
  const c = cust('sav3'); c.balance = 1100; c.savings = 250; c.events.push({ d: 2, cat: 'overdraft_fee', amt: -12 });
  const r = decide(c);
  const d = r.decisions.find((x) => x.moment === 'buffer_clawback');
  assert.ok(d && d.action.kind === 'care');
  assert.strictEqual(d.facts.transfer.amount, 250);
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
