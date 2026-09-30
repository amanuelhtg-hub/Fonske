'use strict';
// FEATURE: subscription management.
// Triggers: overview (2+ subscriptions), price hike, newly found subscription, annual renewal approaching,
// charge after the customer marked a subscription as cancelled.
// Customer-supplied confirmations are plain events: { cat: 'subscription_cancelled', m, d, amt: 0 }.
// Trial protection is opt-in (prefs.trialGuard, or a 'subscription_guard' event). Customer/merchant-supplied events:
//   subscription_trial (supported trial started), subscription_blocked (first paid charge held; amt = price, 0 if unknown),
//   subscription_enabled (customer allows the charge; renewals then proceed), subscription_kept (customer keeps it).
// Transactions cannot reveal whether a service is used, or when an uncharged trial ends: trials need customer input.
const { eur, recurring } = require('./util');

const GROUPS = { Netflix: 'video streaming', 'Disney+': 'video streaming', 'Prime Video': 'video streaming',
  'HBO Max': 'video streaming', Spotify: 'music streaming', 'Apple Music': 'music streaming' };
const PRODUCT = { id: 'kbc-mobile-subs', name: 'KBC Mobile: subscription overview & alerts' };

const money = (n) => (Number.isInteger(n) ? eur(n) : `€${n.toFixed(2)}`);
const plural = (n, one, many) => (n === 1 ? one : many);

module.exports = {
  name: 'subscriptions',
  eventCats: ['subscription_annual', 'subscription_cancelled', 'subscription_trial', 'subscription_blocked',
    'subscription_enabled', 'subscription_kept', 'subscription_guard'],
  derive(c) {
    const items = recurring(c.events, 'subscription').filter((x) => x.monthly > 0); // credits are not charges
    const last = new Map(); // merchant -> two latest charges
    const cancelled = new Map();
    const annual = [];
    const trial = new Map(); const blocked = new Map(); const enabled = new Map(); const kept = new Map();
    let guard = !!(c.prefs && c.prefs.trialGuard);
    const latest = (map, e) => { if (!(map.get(e.m) <= e.d)) map.set(e.m, e.d); }; // keep the most recent marker
    for (const e of c.events) {
      if (!e.cat.startsWith('subscription')) continue;
      if (e.cat === 'subscription_guard') { guard = true; continue; }
      if (!e.m) continue;
      if (e.cat === 'subscription_trial') latest(trial, e);
      else if (e.cat === 'subscription_blocked') { if (!(blocked.get(e.m) && blocked.get(e.m).d <= e.d)) blocked.set(e.m, { d: e.d, amount: Math.abs(e.amt) }); }
      else if (e.cat === 'subscription_enabled') latest(enabled, e);
      else if (e.cat === 'subscription_kept') latest(kept, e);
      else if (e.cat === 'subscription' && e.amt < 0) {
        let r = last.get(e.m);
        if (!r) last.set(e.m, (r = { d1: 1e9, a1: 0, d2: 1e9, a2: 0, n: 0, first: 0 }));
        r.n++;
        if (e.d > r.first) r.first = e.d;
        if (e.d < r.d1) { r.d2 = r.d1; r.a2 = r.a1; r.d1 = e.d; r.a1 = -e.amt; }
        else if (e.d < r.d2) { r.d2 = e.d; r.a2 = -e.amt; }
      } else if (e.cat === 'subscription_cancelled') {
        if (!(cancelled.get(e.m) <= e.d)) cancelled.set(e.m, e.d); // keep the latest marker
      } else if (e.cat === 'subscription_annual' && e.d >= 335 && e.d <= 365) {
        annual.push({ m: e.m, amount: -e.amt, inDays: 365 - e.d });
      }
    }
    const hikes = []; const fresh = []; const chargedAfterCancel = [];
    for (const x of items) {
      const r = last.get(x.m);
      if (cancelled.has(x.m)) continue;
      if (r.a2 > 0 && r.a1 >= r.a2 * 1.05 && r.d1 <= 35 && !(kept.get(x.m) <= r.d1)) hikes.push({ m: x.m, from: r.a2, to: r.a1, yearly: Math.round((r.a1 - r.a2) * 12 * 100) / 100 });
      if (r.n === 3 && r.first <= 100) fresh.push({ m: x.m, amount: r.a1 });
    }
    for (const [m, cd] of cancelled) {
      const r = last.get(m);
      if (r && r.d1 < cd) chargedAfterCancel.push({ m, amount: r.a1, daysAgo: r.d1, cancelledDaysAgo: cd });
    }
    const heldTrials = [];
    if (guard) {
      for (const [m, b] of blocked) {
        if (trial.get(m) >= b.d && !(enabled.get(m) <= b.d) && !cancelled.has(m)) heldTrials.push({ m, amount: b.amount, daysAgo: b.d });
      }
    }
    for (const a of annual) a.kept = kept.get(a.m) <= 30;
    return { items, hikes, fresh, chargedAfterCancel, annual, heldTrials };
  },
  detect(s) {
    const out = [];
    const overview = s.items.length >= 2;
    if (overview) {
      const total = s.items.reduce((t, x) => t + x.monthly, 0);
      const hikeNames = s.items.filter((x) => x.increase >= 0.05).map((x) => x.m);
      const byGroup = {};
      for (const x of s.items) if (GROUPS[x.m]) (byGroup[GROUPS[x.m]] ||= []).push(x.m);
      const overlaps = Object.entries(byGroup).filter(([, v]) => v.length > 1).map(([g, v]) => `${v.join(' + ')} (${g})`);
      const evidence = [`${s.items.length} recurring subscriptions costing ${eur(total)}/month`];
      if (hikeNames.length) evidence.push(`price increase detected: ${hikeNames.join(', ')}`);
      if (overlaps.length) evidence.push(`overlap: ${overlaps.join('; ')}`);
      out.push({ id: 'subscriptions', confidence: 0.5 + 0.08 * s.items.length + (hikeNames.length ? 0.1 : 0) + (overlaps.length ? 0.1 : 0),
        evidence, facts: { count: s.items.length, total, hikes: hikeNames, overlaps } });
    }
    // With 2+ subscriptions the overview card already names price hikes; a dedicated card is for a single service.
    if (!overview && s.hikes.length) {
      const h = s.hikes.reduce((a, b) => (b.yearly > a.yearly ? b : a));
      out.push({ id: 'subscription_hike', confidence: 0.85,
        evidence: [`${h.m} is charged about monthly (recurring pattern)`, `latest payment ${money(h.to)} vs ${money(h.from)} before (+${Math.round((h.to / h.from - 1) * 100)}%)`,
          `if the new price continues: +${money(h.yearly)}/year`],
        facts: { ...h, product: PRODUCT } });
    }
    if (s.fresh.length) {
      const f = s.fresh[0];
      out.push({ id: 'subscription_new', confidence: 0.6,
        evidence: [`${f.m} was charged 3 times at about monthly intervals, all within the last 100 days`, 'first seen only recently, so it may be new to you'],
        facts: { m: f.m, amount: f.amount, more: s.fresh.length - 1 } });
    }
    if (s.chargedAfterCancel.length) {
      const c = s.chargedAfterCancel[0];
      out.push({ id: 'subscription_cancelled_charge', confidence: 0.92,
        evidence: [`you marked ${c.m} as cancelled ${c.cancelledDaysAgo} days ago`, `${c.m} charged ${money(c.amount)} ${c.daysAgo} days ago, after that`],
        facts: { m: c.m, amount: c.amount, daysAgo: c.daysAgo, cancelledDaysAgo: c.cancelledDaysAgo } });
    }
    if (s.heldTrials.length) {
      const h = s.heldTrials[0];
      out.push({ id: 'subscription_trial_blocked', confidence: 0.95,
        evidence: [`you turned on trial protection`, `${h.m} is a supported free trial`,
          `its first paid charge${h.amount ? ` (${money(h.amount)})` : ''} was held ${h.daysAgo} days ago and has not been paid`],
        facts: { m: h.m, amount: h.amount, daysAgo: h.daysAgo } });
    }
    const up = s.annual.filter((a) => a.inDays >= 0 && a.inDays <= 30 && !a.kept).sort((a, b) => a.inDays - b.inDays)[0];
    if (up) {
      out.push({ id: 'subscription_annual', confidence: 0.7,
        evidence: [`${up.m} was charged ${money(up.amount)} once, about a year ago`, `it probably renews in ~${up.inDays} days`],
        facts: { m: up.m, amount: up.amount, inDays: up.inDays } });
    }
    return out;
  },
  actions: {
    subscriptions: {
      id: 'review-subscriptions', kind: 'care', priority: 3, product: PRODUCT,
      en: (f) => ({ title: `You pay ${eur(f.total)}/month on ${f.count} subscriptions`,
        body: `${f.hikes.length ? `${f.hikes.join(' and ')} got more expensive. ` : ''}${f.overlaps.length ? `You pay for overlapping services: ${f.overlaps.join('; ')}. ` : ''}Review them in one place and get alerts on price changes.`, cta: 'Review subscriptions' }),
      advisor: ['Subscription spend reviewed with customer', 'Offer overview and price-change alerts'],
    },
    subscription_hike: {
      id: 'subscription-hike', kind: 'care', priority: 4, product: PRODUCT,
      en: (f) => ({ title: `${f.m} went from ${money(f.from)} to ${money(f.to)}/month`,
        body: `That adds ${money(f.yearly)}/year if the new price continues. Keep it, or review your options? Stopping payments is not the same as cancelling the contract.`, cta: 'Review cancellation options' }),
      advisor: ['Price increase on a recurring subscription', 'Ask whether the customer still uses it; offer price-change alerts'],
    },
    subscription_new: {
      id: 'subscription-new', kind: 'care', priority: 2, product: PRODUCT,
      en: (f) => ({ title: `New recurring payment: ${f.m}`,
        body: `We noticed ${money(f.amount)} leaving your account monthly to ${f.m}${f.more ? ` (and ${f.more} more new ${plural(f.more, 'one', 'ones')})` : ''}. Is this one yours? Confirm it to track its price and renewals.`, cta: 'Confirm subscription' }),
      advisor: ['New recurring payment detected; ask the customer to confirm it'],
    },
    subscription_cancelled_charge: {
      id: 'subscription-cancelled-charge', kind: 'care', priority: 5, product: PRODUCT,
      en: (f) => ({ title: `${f.m} charged you ${money(f.amount)} after you cancelled`,
        body: `You marked it as cancelled ${f.cancelledDaysAgo} days ago, but a payment followed ${f.daysAgo} days ago. The cancellation may not have gone through. You can follow up with the merchant; blocking future payments alone does not end the contract.`, cta: 'Follow up cancellation' }),
      advisor: ['Charge after customer-reported cancellation', 'Help follow up with merchant; distinguish payment blocking from cancelling'],
    },
    subscription_trial_blocked: {
      id: 'subscription-trial-blocked', kind: 'care', priority: 6, product: PRODUCT,
      en: (f) => ({ title: `${f.m}: first paid payment held`,
        body: `Your free trial ended and ${f.m} tried to charge${f.amount ? ` ${money(f.amount)}` : ''}. We held it because trial protection is on. Enable the payment to continue, or get help cancelling. Holding a payment does not cancel the contract.`, cta: 'Enable payments' }),
      advisor: ['Trial payment held by customer-activated trial protection', 'Ask whether to enable it or help cancel; holding a payment is not cancelling'],
    },
    subscription_annual: {
      id: 'subscription-annual', kind: 'care', priority: 3, product: PRODUCT,
      en: (f) => ({ title: `${f.m} probably renews in about ${f.inDays} days`,
        body: `It cost ${money(f.amount)} last year. Decide now whether to keep it, before the charge arrives.`, cta: 'Review renewal' }),
      advisor: ['Annual subscription renewal approaching'],
    },
  },
  personas: [
    { // One streaming service whose latest charge went up: EUR 10 -> EUR 15.
      id: 'sub1', name: 'Tim Jacobs', age: 27, balance: 3100,
      consent: { personalization: true, transactionInsights: true, advisorInsights: true },
      events: [
        ...[0, 1, 2, 3, 4, 5].map((i) => ({ d: i * 30 + 26, cat: 'salary', amt: 2800 })),
        ...[0, 1, 2, 3, 4, 5].map((i) => ({ d: i * 30 + 3, cat: 'rent', amt: -800 })),
        ...[0, 1, 2, 3, 4, 5].map((i) => ({ d: i * 30 + 10, cat: 'groceries', amt: -300 })),
        ...[10, 10, 10, 10, 10, 15].map((amt, i, a) => ({ d: (a.length - 1 - i) * 30 + 5, cat: 'subscription', amt: -amt, m: 'StreamFlix' })),
      ],
    },
    { // Cancelled Spotify, still charged; plus a yearly cloud plan about to renew.
      id: 'sub2', name: 'Nora Vandamme', age: 31, balance: 2600,
      consent: { personalization: true, transactionInsights: true, advisorInsights: true },
      events: [
        ...[0, 1, 2, 3, 4, 5].map((i) => ({ d: i * 30 + 26, cat: 'salary', amt: 2500 })),
        ...[0, 1, 2, 3, 4, 5].map((i) => ({ d: i * 30 + 3, cat: 'rent', amt: -750 })),
        ...[0, 1, 2, 3, 4, 5].map((i) => ({ d: i * 30 + 10, cat: 'groceries', amt: -280 })),
        ...[0, 1, 2, 3, 4, 5].map((i) => ({ d: i * 30 + 5, cat: 'subscription', amt: -11, m: 'Spotify' })),
        { d: 20, cat: 'subscription_cancelled', amt: 0, m: 'Spotify' },
        { d: 350, cat: 'subscription_annual', amt: -89, m: 'Photo cloud plan' },
      ],
    },
    { // Opted in to trial protection: a supported trial's first paid charge was held.
      id: 'sub3', name: 'Elise Hendrickx', age: 24, balance: 1900, prefs: { trialGuard: true },
      consent: { personalization: true, transactionInsights: true, advisorInsights: true },
      events: [
        ...[0, 1, 2, 3, 4, 5].map((i) => ({ d: i * 30 + 26, cat: 'salary', amt: 2300 })),
        ...[0, 1, 2, 3, 4, 5].map((i) => ({ d: i * 30 + 3, cat: 'rent', amt: -700 })),
        ...[0, 1, 2, 3, 4, 5].map((i) => ({ d: i * 30 + 10, cat: 'groceries', amt: -260 })),
        { d: 16, cat: 'subscription_trial', amt: 0, m: 'LearnPlus' },
        { d: 2, cat: 'subscription_blocked', amt: -12, m: 'LearnPlus' },
      ],
    },
  ],
};

// SIMULATED cancellation workflow (demo only). Sends nothing to any merchant: it prepares the request,
// and returns the customer-confirmation event that makes Kate watch for later charges.
// Blocking payments (stopping a direct debit) is a different thing from cancelling the contract.
module.exports.simulateCancellation = (customer, merchant) => ({
  simulated: true,
  label: 'SIMULATION: nothing was sent to the merchant and no contract was changed',
  merchant,
  steps: ['Open the merchant\'s subscription-management page (simulated)', 'Prepare a cancellation request (simulated)', 'Kate watches for further charges'],
  request: { to: merchant, from: customer.name, text: `Please cancel my subscription with ${merchant} with effect from the next billing date and confirm in writing.` },
  note: 'Stopping payments at the bank does not cancel the contract; you may still owe the merchant.',
  trackEvent: { cat: 'subscription_cancelled', m: merchant, d: 0, amt: 0 },
});

// Overview for the UI: detected subscriptions, cost, frequency, next expected charge, status, monthly total.
// Computed on request only (not part of the batch path).
module.exports.subscriptionOverview = (customer) => {
  const s = module.exports.derive(customer);
  const d1 = new Map();
  for (const e of customer.events) {
    if (e.cat === 'subscription' && e.amt < 0 && e.m && !(d1.get(e.m) <= e.d)) d1.set(e.m, e.d);
  }
  const cancelledNow = new Set(s.chargedAfterCancel.map((x) => x.m));
  const hiked = new Set(s.hikes.map((x) => x.m));
  const held = new Set(s.heldTrials.map((x) => x.m));
  const items = s.items.map((x) => ({
    m: x.m, amount: x.monthly, frequency: 'monthly', nextInDays: Math.max(0, 30 - d1.get(x.m)),
    status: cancelledNow.has(x.m) ? 'charged after cancellation' : hiked.has(x.m) || x.increase >= 0.05 ? 'price increased' : 'active',
  }));
  for (const a of s.annual) items.push({ m: a.m, amount: a.amount, frequency: 'yearly', nextInDays: a.inDays, status: 'active' });
  for (const h of s.heldTrials) items.push({ m: h.m, amount: h.amount, frequency: 'monthly', nextInDays: null, status: 'first payment held' });
  const monthlyTotal = Math.round(items.reduce((t, x) => (held.has(x.m) ? t : t + (x.frequency === 'yearly' ? x.amount / 12 : x.amount)), 0) * 100) / 100;
  return { items, monthlyTotal };
};

// SIMULATED payment controls (demo only): they only produce the customer's confirmation event.
const control = (cat, label) => (customer, merchant) => ({ simulated: true, label, merchant, trackEvent: { cat, m: merchant, d: 0, amt: 0 } });
module.exports.enablePayments = control('subscription_enabled', 'SIMULATION: payments enabled for this merchant; later renewals proceed normally');
module.exports.keepSubscription = control('subscription_kept', 'SIMULATION: marked as kept; Kate stops flagging this change');
