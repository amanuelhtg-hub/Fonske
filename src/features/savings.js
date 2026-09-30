'use strict';
// Savings and investments: forecast the next 30 days and estimate what could be set aside while
// keeping commitments and the customer's chosen reserve. No investment advice: investing is a handoff
// to the KBC investment-profile process (objectives, risk preferences, finances, horizon).
const { eur } = require('./util');

const PRODUCTS = { low: { id: 'kbc-savings', name: 'KBC savings account' },
  medium: { id: 'kbc-balanced-fund', name: 'KBC balanced fund' },
  high: { id: 'kbc-growth-fund', name: 'KBC growth fund' } };

const BILLS = new Set(['rent', 'mortgage', 'utility', 'insurance', 'subscription', 'rent_abroad']);
const SKIP = new Set(['savings_transfer', 'overdraft_fee']); // not everyday spending
const WINDOW = 90; // days of history used for run rates
const HORIZON = 30; // days forecast
const MIN_SURPLUS = 500;

module.exports = {
  name: 'savings',
  eventCats: ['transfer_in'],
  // One pass. Every outflow lands in exactly one bucket, so nothing is counted twice:
  // bills (rent, insurance, ...) vs. everyday spending (everything else).
  derive(c, b) {
    let bills = 0, everyday = 0, planned = 0, oneOff = 0, in30 = 0, in60 = 0;
    for (const e of c.events) {
      if (e.d < 30) in30 += e.amt;
      if (e.d < 60) in60 += e.amt;
      if (e.amt > 0 && e.cat !== 'salary' && e.d < 60 && e.amt > oneOff) oneOff = e.amt;
      if (e.amt >= 0 || SKIP.has(e.cat)) continue;
      if (e.d < WINDOW) { if (BILLS.has(e.cat)) bills -= e.amt; else everyday -= e.amt; }
      // Annual bill (charged 11-12 months ago) renews within the horizon.
      else if (e.cat === 'insurance' && e.d >= 365 - HORIZON && e.d <= 365) planned -= e.amt;
    }
    const monthlyBills = bills / (WINDOW / 30);
    const monthlyEveryday = everyday / (WINDOW / 30);
    const reserveChosen = c.prefs && Number.isFinite(c.prefs.reserve) && c.prefs.reserve >= 0;
    const reserve = reserveChosen ? c.prefs.reserve : 3 * (monthlyBills + monthlyEveryday);
    const surplus = b.balance - monthlyBills - monthlyEveryday - planned - reserve;
    // Reconstructed balance 30 / 60 days ago, measured against the same needs: is high cash a habit?
    const need = monthlyBills + monthlyEveryday + reserve + MIN_SURPLUS;
    const sustained = b.balance - in30 >= need && b.balance - in60 >= need;
    return { monthlyBills, monthlyEveryday, planned, reserve, reserveChosen: !!reserveChosen, surplus, sustained, oneOff };
  },
  detect(s, b) {
    if (s.surplus < MIN_SURPLUS || b.savingsRecent >= 2 || b.overdraft > 0) return [];
    const oneOffDriven = s.oneOff > 0 && b.balance - s.oneOff < s.reserve + s.monthlyBills + s.monthlyEveryday;
    const confidence = 0.6 + (s.sustained ? 0.2 : 0) - (oneOffDriven ? 0.2 : 0);
    const product = PRODUCTS[b.riskComfort] || PRODUCTS.low;
    const amount = Math.floor(s.surplus / 100) * 100;
    const r = Math.round;
    return [{ id: 'excess_cash', confidence,
      evidence: [
        `Available balance ${eur(b.balance)}, minus expected bills ${eur(s.monthlyBills)}, everyday spending ${eur(s.monthlyEveryday)}${s.planned ? `, a renewal of ${eur(s.planned)} coming up` : ''} and ${s.reserveChosen ? 'your chosen' : 'a default 3-month'} reserve of ${eur(s.reserve)}, leaves about ${eur(amount)} over the next 30 days (future income ignored)`,
        s.sustained ? 'Your balance has stayed at this level for two months, not just after one payment'
          : oneOffDriven ? `A single incoming payment of ${eur(s.oneOff)} recently lifted your balance, so this estimate is less certain` : 'Your balance was lower earlier in the last two months',
        b.riskComfort ? `stated comfort with risk: ${b.riskComfort} (investing still needs a full investment profile)` : 'no stated risk comfort yet: only safe options suggested'],
      facts: { excess: amount, balance: r(b.balance), bills: r(s.monthlyBills), everyday: r(s.monthlyEveryday), planned: r(s.planned), reserve: r(s.reserve),
        reserveChosen: s.reserveChosen, riskComfort: b.riskComfort || null, product,
        // Customer can correct any assumption; the route follows their answer to "is it needed soon?".
        routes: { soon: 'keep accessible / savings goal', reserve: 'accessible savings account', longTerm: 'investment-profile process (guided handoff)' } } }];
  },
  actions: {
    excess_cash: {
      id: 'excess-cash', kind: 'commercial', priority: 2,
      en: (f) => ({ title: `An estimated ${eur(f.excess)} could be set aside`,
        body: `We kept your bills, everyday spending${f.planned ? ', an upcoming renewal' : ''} and ${f.reserveChosen ? 'your chosen' : 'a 3-month'} buffer of ${eur(f.reserve)} out of it. Is this money needed for something coming up? If not, we can move it to a ${f.product.name}; for investing we would first walk you through your investment profile. You can correct any assumption.`, cta: 'Review and set aside' }),
      advisor: ['Ask first: is this money needed soon? Needed soon: keep accessible or a savings goal',
        'Emergency reserve still being built: accessible savings route',
        'Long-term goal and interest in investing: open the investment-profile process (objectives, risk, finances, horizon). A high balance or risk toggle is not enough',
        'Review the assumptions (bills, spending, reserve) with the customer; estimate ignores future income'],
    },
  },
  personas: [
    { // Illustrative surplus: €4,200 - €1,200 bills - €600 everyday - €1,500 chosen reserve = ~€900.
      id: 'sav1', name: 'Emma Jacobs', age: 35, balance: 4200,
      consent: { personalization: true, transactionInsights: true, advisorInsights: true },
      prefs: { reserve: 1500 },
      events: [
        ...Array.from({ length: 6 }, (_, i) => ({ d: i * 30 + 26, cat: 'salary', amt: 2800 })),
        ...Array.from({ length: 6 }, (_, i) => ({ d: i * 30 + 3, cat: 'rent', amt: -1200 })),
        ...Array.from({ length: 6 }, (_, i) => ({ d: i * 30 + 10, cat: 'groceries', amt: -600 })),
      ] },
    { // One large incoming payment lifted the balance: weaker evidence than a steadily high balance.
      id: 'sav2', name: 'Pieter De Smet', age: 47, balance: 9000,
      consent: { personalization: true, transactionInsights: true, advisorInsights: true },
      events: [
        ...Array.from({ length: 6 }, (_, i) => ({ d: i * 30 + 26, cat: 'salary', amt: 2500 })),
        ...Array.from({ length: 6 }, (_, i) => ({ d: i * 30 + 3, cat: 'rent', amt: -900 })),
        ...Array.from({ length: 6 }, (_, i) => ({ d: i * 30 + 10, cat: 'groceries', amt: -400 })),
        { d: 4, cat: 'transfer_in', amt: 5000 },
      ] },
  ],
};
