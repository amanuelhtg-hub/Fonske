'use strict';
// FEATURE: subscription management. Copy this file's shape to add a new feature.
// Contract: { name, derive(customer, base) -> signals, detect(signals, base) -> moments[], actions: { [momentId]: action } }
const { eur, recurring } = require('./util');

const GROUPS = { Netflix: 'video streaming', 'Disney+': 'video streaming', 'Prime Video': 'video streaming',
  'HBO Max': 'video streaming', Spotify: 'music streaming', 'Apple Music': 'music streaming' };

module.exports = {
  name: 'subscriptions',
  derive: (c) => ({ items: recurring(c.events, 'subscription') }),
  detect(s) {
    if (s.items.length < 2) return [];
    const total = s.items.reduce((t, x) => t + x.monthly, 0);
    const hikes = s.items.filter((x) => x.increase >= 0.05).map((x) => x.m);
    const byGroup = {};
    for (const x of s.items) if (GROUPS[x.m]) (byGroup[GROUPS[x.m]] ||= []).push(x.m);
    const overlaps = Object.entries(byGroup).filter(([, v]) => v.length > 1).map(([g, v]) => `${v.join(' + ')} (${g})`);
    const evidence = [`${s.items.length} recurring subscriptions costing ${eur(total)}/month`];
    if (hikes.length) evidence.push(`price increase detected: ${hikes.join(', ')}`);
    if (overlaps.length) evidence.push(`overlap: ${overlaps.join('; ')}`);
    return [{ id: 'subscriptions', confidence: 0.5 + 0.08 * s.items.length + (hikes.length ? 0.1 : 0) + (overlaps.length ? 0.1 : 0),
      evidence, facts: { count: s.items.length, total, hikes, overlaps } }];
  },
  actions: {
    subscriptions: {
      id: 'review-subscriptions', kind: 'care', priority: 3,
      product: { id: 'kbc-mobile-subs', name: 'KBC Mobile: subscription overview & alerts' },
      en: (f) => ({ title: `You pay ${eur(f.total)}/month on ${f.count} subscriptions`,
        body: `${f.hikes.length ? `${f.hikes.join(' and ')} got more expensive. ` : ''}${f.overlaps.length ? `You pay for overlapping services: ${f.overlaps.join('; ')}. ` : ''}Review them in one place and get alerts on price changes.`, cta: 'Review subscriptions' }),
      nl: (f) => ({ title: `Je betaalt ${eur(f.total)}/maand voor ${f.count} abonnementen`,
        body: `${f.hikes.length ? `${f.hikes.join(' en ')} werd duurder. ` : ''}${f.overlaps.length ? `Je betaalt voor overlappende diensten: ${f.overlaps.join('; ')}. ` : ''}Bekijk ze op één plek en ontvang een melding bij prijswijzigingen.`, cta: 'Bekijk abonnementen' }),
      advisor: ['Subscription spend reviewed with customer', 'Offer overview and price-change alerts'],
    },
  },
};
