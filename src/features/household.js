'use strict';
const { eur, recurring } = require('./util');

module.exports = {
  name: 'household',
  derive: (c) => ({
    utilities: recurring(c.events, 'utility'),
    annual: c.events.filter((e) => e.cat === 'insurance' && e.d >= 335 && e.d <= 395)
      .map((e) => ({ m: e.m, amount: -e.amt, inDays: 365 - e.d })),
  }),
  detect(s) {
    const upcoming = s.annual.filter((a) => a.inDays >= 0 && a.inDays <= 45);
    if (s.utilities.length < 2 && !upcoming.length) return [];
    const total = s.utilities.reduce((t, x) => t + x.monthly, 0);
    const evidence = [];
    if (s.utilities.length) evidence.push(`${s.utilities.length} recurring bills costing ${eur(total)}/month (${s.utilities.map((u) => u.m).join(', ')})`);
    for (const u of s.utilities) if (u.increase >= 0.05) evidence.push(`${u.m} up ${Math.round(u.increase * 100)}% since first payment`);
    for (const a of upcoming) evidence.push(`${a.m} (${eur(a.amount)}) looks annual and is due in ~${a.inDays} days`);
    return [{ id: 'household', confidence: 0.5 + 0.1 * s.utilities.length + (upcoming.length ? 0.2 : 0), evidence,
      facts: { count: s.utilities.length, total, upcoming, hikes: s.utilities.filter((u) => u.increase >= 0.05).map((u) => u.m) } }];
  },
  actions: {
    household: {
      id: 'household-bills', kind: 'care', priority: 3,
      product: { id: 'kbc-bills', name: 'KBC Mobile: bills calendar & direct debits' },
      en: (f) => ({ title: f.upcoming.length ? `${f.upcoming[0].m} renews in about ${f.upcoming[0].inDays} days` : `Your household bills: ${eur(f.total)}/month`,
        body: `${f.upcoming.length ? `It cost ${eur(f.upcoming[0].amount)} last year: a good moment to compare offers. ` : ''}${f.hikes.length ? `${f.hikes.join(' and ')} went up. ` : ''}See every recurring bill in one calendar and never miss a payment.`, cta: 'Open bills calendar' }),
      nl: (f) => ({ title: f.upcoming.length ? `${f.upcoming[0].m} verlengt binnen ongeveer ${f.upcoming[0].inDays} dagen` : `Je huishoudelijke facturen: ${eur(f.total)}/maand`,
        body: `${f.upcoming.length ? `Vorig jaar kostte het ${eur(f.upcoming[0].amount)}: een goed moment om aanbiedingen te vergelijken. ` : ''}${f.hikes.length ? `${f.hikes.join(' en ')} werd duurder. ` : ''}Bekijk alle terugkerende facturen in één kalender en mis nooit een betaling.`, cta: 'Open factuurkalender' }),
      advisor: ['Recurring household costs identified', 'Offer bills calendar; review insurance at renewal'],
    },
  },
};
