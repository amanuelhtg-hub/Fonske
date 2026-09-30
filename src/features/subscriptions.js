'use strict';
// FEATURE: subscription management.
// Triggers: overview (2+ subscriptions), price hike, newly found subscription, annual renewal approaching,
// charge after the customer marked a subscription as cancelled.
// Customer-supplied confirmations are plain events: { cat: 'subscription_cancelled', m, d, amt: 0 }.
// Transactions cannot reveal whether a service is used, or when an uncharged trial ends: trials need customer input.
const { eur, recurring } = require('./util');

const GROUPS = { Netflix: 'video streaming', 'Disney+': 'video streaming', 'Prime Video': 'video streaming',
  'HBO Max': 'video streaming', Spotify: 'music streaming', 'Apple Music': 'music streaming' };
const PRODUCT = { id: 'kbc-mobile-subs', name: 'KBC Mobile: subscription overview & alerts' };

const money = (n) => (Number.isInteger(n) ? eur(n) : `€${n.toFixed(2)}`);
const plural = (n, one, many) => (n === 1 ? one : many);

module.exports = {
  name: 'subscriptions',
  eventCats: ['subscription_annual', 'subscription_cancelled'],
  derive(c) {
    const items = recurring(c.events, 'subscription');
    const last = new Map(); // merchant -> two latest charges
    const cancelled = new Map();
    const annual = [];
    for (const e of c.events) {
      if (!e.m) continue;
      if (e.cat === 'subscription') {
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
      if (r.a2 > 0 && r.a1 >= r.a2 * 1.05 && r.d1 <= 35) hikes.push({ m: x.m, from: r.a2, to: r.a1, yearly: Math.round((r.a1 - r.a2) * 12 * 100) / 100 });
      if (r.n === 3 && r.first <= 100) fresh.push({ m: x.m, amount: r.a1 });
    }
    for (const [m, cd] of cancelled) {
      const r = last.get(m);
      if (r && r.d1 < cd) chargedAfterCancel.push({ m, amount: r.a1, daysAgo: r.d1, cancelledDaysAgo: cd });
    }
    return { items, hikes, fresh, chargedAfterCancel, annual };
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
    const up = s.annual.filter((a) => a.inDays >= 0 && a.inDays <= 30).sort((a, b) => a.inDays - b.inDays)[0];
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
      nl: (f) => ({ title: `Je betaalt ${eur(f.total)}/maand voor ${f.count} abonnementen`,
        body: `${f.hikes.length ? `${f.hikes.join(' en ')} werd duurder. ` : ''}${f.overlaps.length ? `Je betaalt voor overlappende diensten: ${f.overlaps.join('; ')}. ` : ''}Bekijk ze op één plek en ontvang een melding bij prijswijzigingen.`, cta: 'Bekijk abonnementen' }),
      advisor: ['Subscription spend reviewed with customer', 'Offer overview and price-change alerts'],
    },
    subscription_hike: {
      id: 'subscription-hike', kind: 'care', priority: 4, product: PRODUCT,
      en: (f) => ({ title: `${f.m} went from ${money(f.from)} to ${money(f.to)}/month`,
        body: `That adds ${money(f.yearly)}/year if the new price continues. Keep it, or review your options? Stopping payments is not the same as cancelling the contract.`, cta: 'Review cancellation options' }),
      nl: (f) => ({ title: `${f.m} ging van ${money(f.from)} naar ${money(f.to)}/maand`,
        body: `Dat is ${money(f.yearly)}/jaar extra als de nieuwe prijs blijft. Behouden, of je opties bekijken? Betalingen stopzetten is niet hetzelfde als het contract opzeggen.`, cta: 'Bekijk opzegopties' }),
      advisor: ['Price increase on a recurring subscription', 'Ask whether the customer still uses it; offer price-change alerts'],
    },
    subscription_new: {
      id: 'subscription-new', kind: 'care', priority: 2, product: PRODUCT,
      en: (f) => ({ title: `New recurring payment: ${f.m}`,
        body: `We noticed ${money(f.amount)} leaving your account monthly to ${f.m}${f.more ? ` (and ${f.more} more new ${plural(f.more, 'one', 'ones')})` : ''}. Is this one yours? Confirm it to track its price and renewals.`, cta: 'Confirm subscription' }),
      nl: (f) => ({ title: `Nieuwe terugkerende betaling: ${f.m}`,
        body: `We zagen maandelijks ${money(f.amount)} naar ${f.m}${f.more ? ` (en nog ${f.more} ${plural(f.more, 'nieuwe', 'nieuwe')})` : ''}. Is die van jou? Bevestig om prijs en verlengingen op te volgen.`, cta: 'Bevestig abonnement' }),
      advisor: ['New recurring payment detected; ask the customer to confirm it'],
    },
    subscription_cancelled_charge: {
      id: 'subscription-cancelled-charge', kind: 'care', priority: 5, product: PRODUCT,
      en: (f) => ({ title: `${f.m} charged you ${money(f.amount)} after you cancelled`,
        body: `You marked it as cancelled ${f.cancelledDaysAgo} days ago, but a payment followed ${f.daysAgo} days ago. The cancellation may not have gone through. You can follow up with the merchant or ask for a refund; blocking future payments alone does not end the contract.`, cta: 'Follow up cancellation' }),
      nl: (f) => ({ title: `${f.m} rekende ${money(f.amount)} aan na je opzegging`,
        body: `Je markeerde het ${f.cancelledDaysAgo} dagen geleden als opgezegd, maar ${f.daysAgo} dagen geleden volgde toch een betaling. De opzegging is mogelijk niet doorgekomen. Neem contact op met de handelaar of vraag een terugbetaling; toekomstige betalingen blokkeren beëindigt het contract niet.`, cta: 'Opzegging opvolgen' }),
      advisor: ['Charge after customer-reported cancellation', 'Help follow up with merchant; distinguish payment blocking from cancelling'],
    },
    subscription_annual: {
      id: 'subscription-annual', kind: 'care', priority: 3, product: PRODUCT,
      en: (f) => ({ title: `${f.m} probably renews in about ${f.inDays} days`,
        body: `It cost ${money(f.amount)} last year. Decide now whether to keep it, before the charge arrives.`, cta: 'Review renewal' }),
      nl: (f) => ({ title: `${f.m} verlengt waarschijnlijk binnen ongeveer ${f.inDays} dagen`,
        body: `Vorig jaar kostte het ${money(f.amount)}. Beslis nu of je het behoudt, vóór de betaling binnenkomt.`, cta: 'Bekijk verlenging' }),
      advisor: ['Annual subscription renewal approaching'],
    },
  },
  personas: [
    { // One streaming service whose latest charge went up: EUR 10 -> EUR 15.
      id: 'sub1', name: 'Tim Jacobs', age: 27, lang: 'en', balance: 3100,
      consent: { personalization: true, transactionInsights: true, advisorInsights: true },
      events: [
        ...[0, 1, 2, 3, 4, 5].map((i) => ({ d: i * 30 + 26, cat: 'salary', amt: 2800 })),
        ...[0, 1, 2, 3, 4, 5].map((i) => ({ d: i * 30 + 3, cat: 'rent', amt: -800 })),
        ...[0, 1, 2, 3, 4, 5].map((i) => ({ d: i * 30 + 10, cat: 'groceries', amt: -300 })),
        ...[10, 10, 10, 10, 10, 15].map((amt, i, a) => ({ d: (a.length - 1 - i) * 30 + 5, cat: 'subscription', amt: -amt, m: 'StreamFlix' })),
      ],
    },
    { // Cancelled Spotify, still charged; plus a yearly cloud plan about to renew.
      id: 'sub2', name: 'Nora Vandamme', age: 31, lang: 'nl', balance: 2600,
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
