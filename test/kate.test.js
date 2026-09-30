'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { CUSTOMERS } = require('../src/data');
const { decide } = require('../src/engine');
const { server, PASSCODE } = require('../src/server');

const cust = (id) => structuredClone(CUSTOMERS.find((c) => c.id === id));
const ids = (id, cust = cust_(id)) => decide(cust).moments.map((m) => m.id).sort();
function cust_(id) { return cust(id); }

test('each persona maps to the expected opportunities', () => {
  assert.deepStrictEqual(ids('c1'), ['subscriptions']);
  assert.deepStrictEqual(ids('c2'), ['excess_cash']);
  assert.deepStrictEqual(ids('c3'), ['subscriptions']);
  assert.deepStrictEqual(ids('c4'), ['travel', 'travel_disruption']);
  assert.deepStrictEqual(ids('c5'), ['relocation']);
  assert.deepStrictEqual(ids('c6'), ['excess_cash', 'household']);
});

test('subscriptions: finds price hikes and overlapping services', () => {
  const m = decide(cust('c1')).moments[0];
  assert.strictEqual(m.facts.count, 5);
  assert.ok(m.facts.hikes.includes('Netflix') && m.facts.hikes.includes('FitClub'));
  assert.ok(m.facts.overlaps.some((o) => o.includes('Netflix + Disney+')));
});

test('travel is distinguished from relocation', () => {
  assert.ok(!ids('c4').includes('relocation'));
  assert.ok(!ids('c5').includes('travel'));
});

test('household: detects bills and the upcoming annual renewal', () => {
  const m = decide(cust('c6')).moments.find((x) => x.id === 'household');
  assert.strictEqual(m.facts.count, 3);
  assert.strictEqual(m.facts.upcoming[0].m, 'Car insurance');
  assert.strictEqual(m.facts.upcoming[0].inDays, 20);
});

test('savings suggestion follows risk comfort and never advises without a profile', () => {
  const low = decide(cust('c6')).moments.find((x) => x.id === 'excess_cash');
  assert.strictEqual(low.facts.product.id, 'kbc-savings');
  const med = decide(cust('c2')).moments[0];
  assert.strictEqual(med.facts.product.id, 'kbc-balanced-fund');
  const c = cust('c2');
  delete c.prefs;
  const none = decide(c);
  assert.strictEqual(none.moments[0].facts.product.id, 'kbc-savings');
  assert.ok(none.guardrails.some((g) => g.includes('No risk profile')));
});

test('overdraft suppresses product offers but keeps expense-control help', () => {
  const c = cust('c4');
  c.events.push({ d: 3, cat: 'overdraft_fee', amt: -12 });
  const r = decide(c);
  assert.ok(r.moments.some((m) => m.id === 'travel'));
  assert.ok(r.decisions.every((d) => d.action.kind === 'care'));
  const a = decide(cust('c3'));
  assert.ok(a.decisions.length > 0 && a.decisions.every((d) => d.action.kind === 'care'));
});

test('no consent means no analysis', () => {
  const r = decide(cust('c7'));
  assert.deepStrictEqual(r.moments, []);
  assert.strictEqual(r.decisions[0].action.id, 'generic-tips');
  const c = cust('c1');
  c.consent.transactionInsights = false;
  assert.deepStrictEqual(decide(c).decisions, []);
});

test('dismissed suggestions do not return', () => {
  const r = decide(cust('c1'), { dismissed: new Set(['review-subscriptions']) });
  assert.strictEqual(r.decisions.length, 0);
});

// ---- HTTP: authentication, authorization (IDOR) ----
let base;
test.before(() => new Promise((res) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; res(); })));
test.after(() => server.close());

async function login(userId, passcode = PASSCODE) {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, passcode }) });
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

test('login rejects a wrong passcode and unauthenticated calls', async () => {
  assert.strictEqual((await login('c1', 'nope')).status, 401);
  assert.strictEqual((await fetch(`${base}/api/me/experience`)).status, 401);
});

test('forged session cookie is rejected', async () => {
  const r = await fetch(`${base}/api/me`, { headers: { Cookie: 'kate=eyJzdWIiOiJhMSJ9.abc' } });
  assert.strictEqual(r.status, 401);
});

test('customer cannot reach advisor endpoints', async () => {
  const { cookie } = await login('c1');
  const r = await fetch(`${base}/api/advisor/customers/c2/brief`, { headers: { Cookie: cookie } });
  assert.strictEqual(r.status, 404);
});

test('advisor cannot read a customer that is not assigned (IDOR)', async () => {
  const { cookie } = await login('a1');
  const mine = await fetch(`${base}/api/advisor/customers/c1/brief`, { headers: { Cookie: cookie } });
  assert.strictEqual(mine.status, 200);
  const other = await fetch(`${base}/api/advisor/customers/c6/brief`, { headers: { Cookie: cookie } });
  assert.strictEqual(other.status, 403);
});

test('advisor brief respects customer consent', async () => {
  const { cookie } = await login('a2');
  const r = await (await fetch(`${base}/api/advisor/customers/c4/brief`, { headers: { Cookie: cookie } })).json();
  assert.ok(r.blocked);
});

test('mutations require JSON and same origin', async () => {
  const { cookie } = await login('c1');
  const bad = await fetch(`${base}/api/me/consent`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.strictEqual(bad.status, 415);
  const cross = await fetch(`${base}/api/me/consent`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.strictEqual(cross.status, 403);
});

test('static server blocks path traversal', async () => {
  const r = await fetch(`${base}/..%2fsrc%2fserver.js`);
  assert.notStrictEqual(r.status, 200);
});

// ---- streaming pipeline ----
const { runBatch, processRange } = require('../src/batch');

test('parallel batch equals serial batch', async () => {
  const par = await runBatch(20000, 4);
  const ser = processRange(0, 20000);
  assert.strictEqual(par.cards, ser.cards);
  assert.deepStrictEqual(par.actions, ser.actions);
  assert.deepStrictEqual(par.moments, ser.moments);
});

test('event ingestion validates input', async () => {
  const { cookie } = await login('c6');
  const post = (body) => fetch(`${base}/api/me/events`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.strictEqual((await post({ cat: 'drop_table', amt: -1 })).status, 400);
  assert.strictEqual((await post({ cat: 'groceries', amt: 'x' })).status, 400);
  assert.strictEqual((await post({ cat: 'groceries', amt: -1e9 })).status, 400);
  assert.strictEqual((await post({ cat: 'groceries', amt: -5, d: 9999 })).status, 400);
  assert.strictEqual((await post({ cat: 'groceries', amt: -5 })).status, 202);
});

test('a new event is pushed live over SSE and changes the decision', async () => {
  const { cookie } = await login('c2');
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/me/stream`, { headers: { Cookie: cookie }, signal: ctrl.signal });
  assert.strictEqual(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const got = (async () => {
    let buf = '';
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return buf;
      buf += dec.decode(value);
      if (buf.includes('event: update')) return buf;
    }
  })();
  await new Promise((r) => setTimeout(r, 50));
  // Thomas has an excess-cash suggestion; an overdraft fee must retract it (suitability guardrail).
  const r = await fetch(`${base}/api/me/events`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ cat: 'overdraft_fee', amt: -12 }) });
  assert.strictEqual((await r.json()).changed, true);
  const text = await got;
  ctrl.abort();
  assert.match(text, /"cards":\[\]/);
});
