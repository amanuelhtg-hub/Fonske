'use strict';
// Transaction-driven personal finance assistant engine:
//   transactions -> signals -> opportunities (with evidence) -> guard-railed decision -> channel.
// Pure functions, no I/O, no shared mutable state => trivially horizontally scalable
// (partition by customer id) and easy to unit test.
const { compose } = require('./composer');

const THRESHOLD = 0.5;
const MAX_CARDS = 2;

const { FEATURES, ACTIONS } = require('./features');
const { sum, count } = require('./features/util');

const clamp = (x, hi = 0.95) => Math.min(hi, x);

// ---- 1. Signals: shared basics + each feature's own signals ----------------------------
function deriveSignals(c) {
  const ev = c.events;
  const base = {
    balance: c.balance,
    outflow: -sum(ev, (e) => e.amt < 0 && e.cat !== 'savings_transfer' && e.d < 180) / 6,
    overdraft: count(ev, (e) => e.cat === 'overdraft_fee' && e.d < 60),
    savingsRecent: count(ev, (e) => e.cat === 'savings_transfer' && e.d < 90),
    riskComfort: c.prefs && c.prefs.riskComfort,
  };
  const features = {};
  for (const f of FEATURES) features[f.name] = f.derive(c, base);
  return { base, features };
}

// ---- 2. Opportunities, each with confidence, evidence and the facts used for wording ----
function detect({ base, features }) {
  const out = [];
  for (const f of FEATURES) {
    for (const m of f.detect(features[f.name], base)) {
      if (m.confidence >= THRESHOLD) out.push({ ...m, confidence: +clamp(m.confidence).toFixed(2) });
    }
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

// ---- 3. Action catalogue lives with each feature (src/features/*.js) -------------------
// kind 'care' = expense-control help, always allowed; 'commercial' = product offers, suppressed under overdraft.

const GENERIC = {
  id: 'generic-tips', kind: 'care',
  en: () => ({ title: 'Welcome back', body: 'Personalised suggestions are switched off. You can turn them on in your privacy settings at any time.', cta: 'Privacy settings' }),
};

// ---- 4. Decision with guardrails ----------------------------------------------------------
// state: { dismissed: Set<actionId> } is supplied by the caller (per customer).
function decide(customer, state = {}) {
  const guardrails = [];
  const c = customer.consent;
  if (!c.personalization) {
    guardrails.push('Personalisation consent is off: no customer data was analysed');
    return { customer: customer.id, moments: [], decisions: [{ action: GENERIC, moment: null, confidence: 1, why: [], facts: {} }], guardrails };
  }
  if (!c.transactionInsights) {
    guardrails.push('Transaction-insight consent is off: transactions were not analysed');
    return { customer: customer.id, moments: [], decisions: [], guardrails };
  }
  const signals = deriveSignals(customer);
  const moments = detect(signals);
  let cands = moments.map((m) => ({ action: ACTIONS[m.id], moment: m.id, confidence: m.confidence, why: m.evidence, facts: m.facts }));
  if (signals.base.overdraft > 0 || signals.base.balance < 0) {
    const before = cands.length;
    cands = cands.filter((x) => x.action.kind === 'care');
    if (before > cands.length) guardrails.push('Overdraft detected: product offers suppressed, expense-control help only');
  }
  const dismissed = state.dismissed || new Set();
  const kept = cands.filter((x) => !dismissed.has(x.action.id));
  if (kept.length < cands.length) guardrails.push('Previously dismissed suggestions are not shown again');
  kept.sort((a, b) => b.action.priority * b.confidence - a.action.priority * a.confidence);
  if (kept.length > MAX_CARDS) guardrails.push(`Frequency cap: at most ${MAX_CARDS} suggestions at a time`);
  if (kept.some((x) => x.moment === 'excess_cash' && !x.facts.riskComfort)) {
    guardrails.push('No risk profile on file: only a safe option is suggested, no investment advice');
  }
  return { customer: customer.id, moments, decisions: kept.slice(0, MAX_CARDS), guardrails };
}

// ---- 5. Same decision, adapted per channel ------------------------------------------------
function render(result, channel, customer) {
  const first = customer.name.split(' ')[0];
  const items = result.decisions.map((d) => {
    const t = compose(d.action, { moment: d.moment, evidence: d.why, facts: d.facts, firstName: first });
    const product = (d.facts && d.facts.product) || d.action.product || null;
    return { actionId: d.action.id, moment: d.moment, confidence: d.confidence, why: d.why, title: t.title, body: t.body, cta: t.cta, product, facts: d.facts || {}, talkingPoints: d.action.advisor || [] };
  });
  if (channel === 'email') {
    const top = items[0];
    if (!top) return { channel, skipped: 'Nothing relevant to say right now. Silence is a feature.' };
    return {
      channel, subject: top.title, preheader: top.body.slice(0, 70),
      text: `Hi ${first},\n\n${top.body}\n\n→ ${top.cta}\n\nKBC`,
    };
  }
  if (channel === 'advisor') {
    if (!customer.consent.advisorInsights) return { channel, blocked: 'Customer has not consented to advisor insights.' };
    return {
      channel, customer: first, moments: result.moments.map(({ facts, ...m }) => m),
      talkingPoints: items.flatMap((i) => i.talkingPoints), guardrails: result.guardrails,
      note: 'Signals are hints, not facts. Ask; do not assume.',
    };
  }
  return { channel: 'app', greeting: `Hi ${first}`, cards: items, guardrails: result.guardrails };
}

module.exports = { deriveSignals, detect, decide, render, ACTIONS, THRESHOLD, MAX_CARDS };
