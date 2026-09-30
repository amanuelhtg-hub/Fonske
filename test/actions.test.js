'use strict';
// Server-side flows behind the card buttons: all simulated, all scoped to the logged-in customer.
const test = require('node:test');
const assert = require('node:assert');
const { server, PASSCODE } = require('../src/server');

let base;
test.before(() => new Promise((res) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; res(); })));
test.after(() => server.close());

const sessions = new Map(); // one login per persona: the server throttles logins (10/min per address)
async function as(userId) {
  if (sessions.has(userId)) return sessions.get(userId);
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, passcode: PASSCODE }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const call = (path, method = 'GET', body) => fetch(`${base}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const session = { get: (p) => call(p).then((r2) => r2.json()), call };
  sessions.set(userId, session);
  return session;
}
const cards = async (u) => (await u.get('/api/me/experience?channel=app')).cards;

test('cards carry their facts so the UI can act on them', async () => {
  const u = await as('hh2');
  const c = (await cards(u)).find((x) => x.actionId === 'household-bill-shortfall');
  assert.strictEqual(c.facts.transfer.amount, 80);
});

test('transfer: approving moves only the customer\'s own savings and clears the shortfall', async () => {
  const u = await as('hh2');
  const r = await (await u.call('/api/me/transfer', 'POST', { amount: 80 })).json();
  assert.deepStrictEqual([r.balance, r.savings], [200, 2420]);
  assert.ok(!(await cards(u)).some((x) => x.actionId === 'household-bill-shortfall'));
});

test('transfer: rejects more than the savings, negatives, non-numbers and customers without savings', async () => {
  const u = await as('hh2');
  for (const amount of [1e9, -5, 0, 'x', null]) assert.strictEqual((await u.call('/api/me/transfer', 'POST', { amount })).status, 400);
  const other = await as('c1');
  assert.strictEqual((await other.call('/api/me/transfer', 'POST', { amount: 10 })).status, 400);
});

test('cancellation: prepare does not change anything, approve makes Kate watch for charges', async () => {
  const u = await as('sub1');
  const prep = await (await u.call('/api/me/subscriptions/cancel', 'POST', { merchant: 'StreamFlix' })).json();
  assert.strictEqual(prep.approved, false);
  assert.match(prep.label, /SIMULATION/);
  assert.ok(!('trackEvent' in prep));
  const done = await (await u.call('/api/me/subscriptions/cancel', 'POST', { merchant: 'StreamFlix', approve: true })).json();
  assert.strictEqual(done.approved, true);
});

test('cancellation: only the customer\'s own subscriptions', async () => {
  const u = await as('sub1');
  assert.strictEqual((await u.call('/api/me/subscriptions/cancel', 'POST', { merchant: 'Somebody Else Ltd' })).status, 404);
  assert.strictEqual((await u.call('/api/me/subscriptions/cancel', 'POST', { merchant: 42 })).status, 404);
});

test('travel: the customer\'s answer changes the card', async () => {
  const u = await as('tr1');
  assert.strictEqual((await cards(u))[0].actionId, 'trip-question');
  await u.call('/api/me/events', 'POST', { cat: 'travel_confirm', m: 'stay', amt: 4 });
  assert.ok((await cards(u)).some((x) => x.actionId === 'temporary-stay'));
});

test('savings: customer can correct the reserve and the estimate follows', async () => {
  const u = await as('sav1');
  const before = (await cards(u))[0].facts.excess;
  assert.strictEqual((await u.call('/api/me/preferences', 'PUT', { reserve: 1000 })).status, 200);
  assert.ok((await cards(u))[0].facts.excess > before);
  for (const reserve of [-1, 'x', 1e12]) assert.strictEqual((await u.call('/api/me/preferences', 'PUT', { reserve })).status, 400);
  await u.call('/api/me/preferences', 'PUT', { reserve: null });
});

test('advisor and customer scopes stay separate for the new endpoints', async () => {
  const adv = await as('a1');
  for (const p of ['/api/me/subscriptions', '/api/me/transfer', '/api/me/preferences']) assert.ok((await adv.call(p)).status >= 400);
});

test('set aside: only up to what the engine proposes, from the customer\'s own balance', async () => {
  const u = await as('c2');
  const card = (await cards(u)).find((x) => x.actionId === 'excess-cash');
  const max = card.facts.savingsTransfer.amount;
  for (const amount of [max + 1, 1e9, -5, 0, 'x', null]) assert.strictEqual((await u.call('/api/me/savings-transfer', 'POST', { amount })).status, 400);
  const r = await (await u.call('/api/me/savings-transfer', 'POST', { amount: max })).json();
  assert.strictEqual(r.balance, 28000 - max);
  assert.strictEqual(r.savings, max);
  const nobody = await as('c3'); // overdrawn customer: no proposal, so nothing may move
  assert.strictEqual((await nobody.call('/api/me/savings-transfer', 'POST', { amount: 10 })).status, 400);
});

test('automatic saving: limited opt-in that can be turned off', async () => {
  const u = await as('c2');
  for (const autoSave of [{ max: -1 }, { max: 'x' }, { max: 1e9 }, 5, {}]) assert.strictEqual((await u.call('/api/me/preferences', 'PUT', { autoSave })).status, 400);
  const on = await (await u.call('/api/me/preferences', 'PUT', { autoSave: { max: 300 } })).json();
  assert.deepStrictEqual(on.autoSave, { max: 300 });
  const off = await (await u.call('/api/me/preferences', 'PUT', { autoSave: null })).json();
  assert.strictEqual(off.autoSave, null);
});

test('trial held: enabling the payment and marking a claim settled go through the normal paths', async () => {
  const u = await as('sub3');
  assert.ok((await cards(u)).some((x) => x.actionId === 'subscription-trial-blocked'));
  assert.strictEqual((await u.call('/api/me/events', 'POST', { cat: 'subscription_enabled', m: 'LearnPlus', amt: 0 })).status, 202);
  assert.ok(!(await cards(u)).some((x) => x.actionId === 'subscription-trial-blocked'));
  const t = await as('tr5');
  assert.strictEqual((await t.call('/api/me/dismiss', 'POST', { actionId: 'claim-settled' })).status, 200);
  assert.ok(!(await cards(t)).some((x) => x.actionId === 'claim-settled'));
});
