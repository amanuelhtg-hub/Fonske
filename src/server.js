'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CUSTOMERS, ADVISORS } = require('./data');
const { decide, render } = require('./engine');
const { runBatch } = require('./batch');
const { simulateCancellation } = require('./features/subscriptions');
const { recurring } = require('./features/util');

const PUBLIC = path.join(__dirname, '..', 'public');
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PASSCODE = process.env.DEMO_PASSCODE || crypto.randomBytes(4).toString('hex');
const SESSION_MS = 60 * 60 * 1000;
const MAX_BODY = 4096;
const MAX_BENCH = 2_300_000;
let benchRunning = false;
const MAX_EVENTS = 5000;
const MAX_STREAMS = 3;
const EVENT_CATS = new Set([...require('./features').FEATURES.flatMap((f) => f.eventCats || []),'salary', 'rent', 'mortgage', 'groceries', 'savings_transfer', 'subscription', 'utility', 'insurance', 'abroad', 'rent_abroad', 'disruption', 'overdraft_fee']);

const customers = new Map(CUSTOMERS.map((c) => [c.id, structuredClone(c)]));
const advisors = new Map(ADVISORS.map((a) => [a.id, a]));
const dismissed = new Map(); // customerId -> Set(actionId)
const streams = new Map(); // customerId -> Set(res) of live SSE connections
const lastSig = new Map(); // customerId -> signature of last pushed decision

// Re-decide for one customer and push to their open streams if anything changed.
const signature = (r) => JSON.stringify([r.moments.map((m) => m.id), r.decisions.map((d) => [d.action.id, d.facts])]);
function publish(cust) {
  const r = decide(cust, { dismissed: dismissed.get(cust.id) });
  const sig = signature(r);
  const changed = lastSig.get(cust.id) !== sig;
  lastSig.set(cust.id, sig);
  const set = streams.get(cust.id);
  if (changed && set) {
    const msg = `event: update\ndata: ${JSON.stringify(render(r, 'app', cust))}\n\n`;
    for (const res of set) res.write(msg);
  }
  return changed;
}

// ---- helpers ----
const safeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
const sign = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
};
function verify(token) {
  if (typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (!safeEq(mac, good)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
const cookieOf = (req, name) => {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
};
const session = (req) => verify(cookieOf(req, 'kate'));

const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};
function send(res, code, obj, extra = {}) {
  res.writeHead(code, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch { reject(Object.assign(new Error('bad json'), { code: 400 })); }
    });
    req.on('error', reject);
  });
}

// crude per-IP login throttle: 10 attempts / minute
const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  attempts.set(ip, list);
  if (attempts.size > 10000) for (const [k, v] of attempts) if (now - v[v.length - 1] > 60000) attempts.delete(k);
  return list.length > 10;
}

const SCENARIOS = { c1: 'subscription overview', c2: 'excess cash, medium risk', c3: 'overdrawn (care only)', c4: 'holiday + disruption', c5: 'moved abroad',
  c6: 'household bills + idle cash', c7: 'personalisation off', sub1: 'subscription price hike', sub2: 'charged after cancelling', sav1: 'savings with chosen reserve',
  sav2: 'one-off payment (no card)', hh1: 'bill increase', hh2: 'bill shortfall + savings transfer', tr1: 'booking, nothing abroad yet', tr2: 'temporary stay', tr3: 'cancelled booking' };
const CHANNELS = new Set(['app', 'email', 'advisor']);
const CONSENT_KEYS = ['personalization', 'transactionInsights', 'advisorInsights'];

// ---- routes ----
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p.startsWith('/api/')) {
    // CSRF defence in depth on top of SameSite=Strict: JSON only + same-origin for mutations.
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'cross-origin' });
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'json only' });
    }

    if (p === '/api/healthz' && req.method === 'GET') return send(res, 200, { ok: true, uptimeSeconds: Math.round(process.uptime()) });
    if (p === '/api/personas' && req.method === 'GET') {
      return send(res, 200, {
        customers: [...customers.values()].map((c) => ({ id: c.id, name: c.name, scenario: SCENARIOS[c.id] || '' })),
        advisors: [...advisors.values()].map((a) => ({ id: a.id, name: a.name })),
      });
    }
    if (p === '/api/login' && req.method === 'POST') {
      if (throttled(req.socket.remoteAddress)) return send(res, 429, { error: 'too many attempts' });
      const b = await readJson(req);
      const role = customers.has(b.userId) ? 'customer' : advisors.has(b.userId) ? 'advisor' : null;
      if (!role || !safeEq(b.passcode ?? '', PASSCODE)) return send(res, 401, { error: 'invalid credentials' });
      const token = sign({ sub: b.userId, role, exp: Date.now() + SESSION_MS });
      return send(res, 200, { role, id: b.userId }, {
        'Set-Cookie': `kate=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`,
      });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'kate=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }

    const s = session(req);
    if (!s) return send(res, 401, { error: 'not logged in' });

    if (p === '/api/me' && req.method === 'GET') {
      const name = s.role === 'customer' ? customers.get(s.sub).name : advisors.get(s.sub).name;
      return send(res, 200, { id: s.sub, role: s.role, name });
    }

    // Customer endpoints: identity always comes from the session, never from a client-supplied id.
    if (s.role === 'customer') {
      const me = customers.get(s.sub);
      if (p === '/api/me/experience' && req.method === 'GET') {
        const ch = url.searchParams.get('channel') || 'app';
        if (ch === 'advisor' || !CHANNELS.has(ch)) return send(res, 400, { error: 'bad channel' });
        const r = decide(me, { dismissed: dismissed.get(me.id) });
        return send(res, 200, render(r, ch, me));
      }
      if (p === '/api/me/stream' && req.method === 'GET') {
        const set = streams.get(me.id) || new Set();
        if (set.size >= MAX_STREAMS) return send(res, 429, { error: 'too many streams' });
        streams.set(me.id, set);
        res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        res.write(': connected\n\n');
        set.add(res);
        lastSig.set(me.id, signature(decide(me, { dismissed: dismissed.get(me.id) })));
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(ping); set.delete(res); });
        return;
      }
      if (p === '/api/me/events' && req.method === 'POST') {
        const b = await readJson(req);
        const d = b.d === undefined ? 0 : b.d;
        const okM = b.m === undefined || (typeof b.m === 'string' && /^[\w .+&'-]{1,40}$/.test(b.m));
        const okC = b.c === undefined || (typeof b.c === 'string' && /^[A-Z]{2}$/.test(b.c));
        if (!EVENT_CATS.has(b.cat) || !Number.isFinite(b.amt) || Math.abs(b.amt) > 1e6 || !Number.isInteger(d) || d < 0 || d > 400 || !okM || !okC) {
          return send(res, 400, { error: 'invalid event' });
        }
        const ev = { d, cat: b.cat, amt: b.amt };
        if (b.m !== undefined) ev.m = b.m;
        if (b.c !== undefined) ev.c = b.c;
        me.events.push(ev);
        if (me.events.length > MAX_EVENTS) me.events.splice(0, me.events.length - MAX_EVENTS);
        me.balance += b.amt;
        return send(res, 202, { accepted: true, changed: publish(me) });
      }
      if (p === '/api/me/consent' && req.method === 'GET') return send(res, 200, me.consent);
      if (p === '/api/me/consent' && req.method === 'PUT') {
        const b = await readJson(req);
        for (const k of CONSENT_KEYS) if (typeof b[k] === 'boolean') me.consent[k] = b[k];
        if (!me.consent.personalization) me.consent.transactionInsights = me.consent.advisorInsights = false;
        publish(me);
        return send(res, 200, me.consent);
      }
      if (p === '/api/me/preferences' && req.method === 'PUT') {
        const b = await readJson(req);
        const next = { ...me.prefs };
        if ('riskComfort' in b) {
          if (!['low', 'medium', 'high', null].includes(b.riskComfort)) return send(res, 400, { error: 'invalid riskComfort' });
          if (b.riskComfort) next.riskComfort = b.riskComfort; else delete next.riskComfort;
        }
        if ('reserve' in b) {
          if (b.reserve !== null && !(Number.isFinite(b.reserve) && b.reserve >= 0 && b.reserve <= 1e7)) return send(res, 400, { error: 'invalid reserve' });
          if (b.reserve !== null) next.reserve = b.reserve; else delete next.reserve;
        }
        me.prefs = next;
        publish(me);
        return send(res, 200, { riskComfort: next.riskComfort || null, reserve: next.reserve ?? null });
      }
      if (p === '/api/me/preferences' && req.method === 'GET') {
        return send(res, 200, { riskComfort: (me.prefs && me.prefs.riskComfort) || null, reserve: me.prefs && me.prefs.reserve !== undefined ? me.prefs.reserve : null });
      }
      if (p === '/api/me/subscriptions' && req.method === 'GET') {
        return send(res, 200, recurring(me.events, 'subscription').map((x) => ({ m: x.m, monthly: x.monthly })));
      }
      // SIMULATED cancellation: first call prepares the request, approve:true records the customer's
      // confirmation so Kate watches for later charges. Nothing is ever sent to a merchant.
      if (p === '/api/me/subscriptions/cancel' && req.method === 'POST') {
        const b = await readJson(req);
        const known = typeof b.merchant === 'string' && me.events.some((e) => e.m === b.merchant && String(e.cat).startsWith('subscription'));
        if (!known) return send(res, 404, { error: 'unknown subscription' });
        const { trackEvent, ...prepared } = simulateCancellation(me, b.merchant);
        if (b.approve !== true) return send(res, 200, { ...prepared, approved: false });
        me.events.push({ ...trackEvent });
        publish(me);
        return send(res, 200, { ...prepared, approved: true });
      }
      // SIMULATED own-account transfer (savings -> payment account); only moves the customer's own money.
      if (p === '/api/me/transfer' && req.method === 'POST') {
        const b = await readJson(req);
        const have = Number.isFinite(me.savings) ? me.savings : 0;
        const amt = Math.round(b.amount * 100) / 100;
        if (!Number.isFinite(amt) || amt <= 0 || amt > have) return send(res, 400, { error: 'invalid transfer' });
        me.savings = Math.round((have - amt) * 100) / 100;
        me.balance = Math.round((me.balance + amt) * 100) / 100;
        publish(me);
        return send(res, 200, { simulated: true, balance: me.balance, savings: me.savings });
      }
      if (p === '/api/me/dismiss' && req.method === 'POST') {
        const b = await readJson(req);
        if (typeof b.actionId !== 'string' || b.actionId.length > 40) return send(res, 400, { error: 'bad actionId' });
        if (!dismissed.has(me.id)) dismissed.set(me.id, new Set());
        dismissed.get(me.id).add(b.actionId);
        publish(me);
        return send(res, 200, { ok: true });
      }
    }

    // Advisor endpoints: only assigned customers, only with consent.
    if (s.role === 'advisor') {
      const adv = advisors.get(s.sub);
      if (p === '/api/advisor/customers' && req.method === 'GET') {
        return send(res, 200, adv.assigned.map((id) => ({ id, name: customers.get(id).name })));
      }
      const m = p.match(/^\/api\/advisor\/customers\/([a-z0-9]{1,8})\/brief$/);
      if (m && req.method === 'GET') {
        if (!adv.assigned.includes(m[1])) return send(res, 403, { error: 'not your customer' });
        const cust = customers.get(m[1]);
        return send(res, 200, render(decide(cust, { dismissed: dismissed.get(cust.id) }), 'advisor', cust));
      }
      if (p === '/api/advisor/bench' && req.method === 'GET') {
        const n = Math.min(MAX_BENCH, Math.max(1000, parseInt(url.searchParams.get('n'), 10) || 100000));
        if (benchRunning) return send(res, 429, { error: 'a batch run is already in progress' });
        benchRunning = true;
        try { return send(res, 200, await runBatch(n)); } finally { benchRunning = false; }
      }
    }
    return send(res, 404, { error: 'not found' });
  }

  // ---- static files (no directory traversal) ----
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'forbidden' });
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  fs.readFile(file, (err, data) => {
    if (err || !types[path.extname(file)]) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { ...HEADERS, 'Content-Type': `${types[path.extname(file)]}; charset=utf-8` });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => send(res, e.code === 413 || e.code === 400 ? e.code : 500, { error: e.code ? e.message : 'server error' }));
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '127.0.0.1', () => {
    console.log(`Kate for KBC running on http://localhost:${port}`);
    if (!process.env.DEMO_PASSCODE) console.log(`Demo passcode for this run: ${PASSCODE}`);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { for (const set of streams.values()) for (const r of set) r.end(); server.close(() => process.exit(0)); });
}

module.exports = { server, PASSCODE };
