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
const IDLE_RATE = 0.015; // illustrative yearly savings rate for the opportunity-cost estimate, not a promise
const MICRO_MIN = 25; // micro-investing starts from this monthly amount

module.exports = {
  name: 'savings',
  eventCats: ['transfer_in'],
  // One pass. Every outflow lands in exactly one bucket, so nothing is counted twice:
  // bills (rent, insurance, ...) vs. everyday spending (everything else).
  derive(c, b) {
    let bills = 0, everyday = 0, planned = 0, oneOff = 0, in30 = 0, in60 = 0, spend30 = 0, salaryRecent = 0, salaryOlder = 0, transferred = 0, unexpected = 0;
    for (const e of c.events) {
      if (e.d < 30) in30 += e.amt;
      if (e.d < 60) in60 += e.amt;
      if (e.cat === 'salary' && e.amt > 0) { if (e.d < 45) salaryRecent++; else if (e.d < 180) salaryOlder++; }
      if (e.amt > 0 && e.cat !== 'salary' && e.d < 60 && e.amt > oneOff) oneOff = e.amt;
      if (e.cat === 'savings_transfer') transferred -= e.amt;
      if (e.amt >= 0 || SKIP.has(e.cat)) continue;
      // Unexpected recent debit: not a recurring bill and not regular groceries.
      if (e.d < 14 && !BILLS.has(e.cat) && e.cat !== 'groceries' && -e.amt > unexpected) unexpected = -e.amt;
      if (e.d < 30) spend30 -= e.amt;
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
    // Adaptive amount: shrink when this month's spending runs well above the norm, stop when income went quiet.
    const monthly = monthlyBills + monthlyEveryday;
    const rising = monthly > 0 && spend30 > 1.15 * monthly;
    const incomeUncertain = salaryRecent === 0 && salaryOlder > 0;
    const buffer = 0.1 * monthly; // uncertainty buffer on top of the reserve
    let suggested = Math.floor((surplus - buffer) / 100) * 100;
    if (rising) suggested = Math.floor(suggested / 200) * 100;
    const profile = !!(c.prefs && c.prefs.investmentProfile);
    const auto = c.prefs && c.prefs.autoSave && Number.isFinite(c.prefs.autoSave.max) && c.prefs.autoSave.max > 0 ? c.prefs.autoSave.max : 0;
    // Safety buffer already held in savings: the simulated savings balance if present, else transfers on record.
    const saved = Math.max(0, Number.isFinite(c.savings) ? c.savings : transferred);
    return { saved, unexpected, rising, incomeUncertain, suggested, profile, auto, monthlyBills, monthlyEveryday, planned, reserve, reserveChosen: !!reserveChosen, surplus, sustained, oneOff };
  },
  detect(s, b) {
    const out = [];
    // Emergency clawback: an unexpected debit pushed the balance below the reserve while savings can cover it.
    if (s.saved >= 100 && b.balance < s.reserve && b.balance + s.unexpected >= s.reserve && s.unexpected >= 100) {
      const amount = Math.min(Math.floor(s.saved), Math.ceil((s.reserve - b.balance) / 10) * 10);
      out.push({ id: 'buffer_clawback', confidence: 0.85,
        evidence: [`An unexpected payment of ${eur(s.unexpected)} in the last two weeks took your current account to ${eur(b.balance)}, below your reserve of ${eur(s.reserve)}`,
          `${eur(s.saved)} is held in your savings, which can cover it`],
        facts: { transfer: { amount, from: 'savings', to: 'payment account' }, balance: Math.round(b.balance), reserve: Math.round(s.reserve),
          unexpected: Math.round(s.unexpected), saved: Math.round(s.saved), product: PRODUCTS.low } });
    }
    if (s.incomeUncertain || s.suggested < 100 || s.monthlyBills + s.monthlyEveryday <= 0 || s.surplus < MIN_SURPLUS || b.savingsRecent >= 2 || b.overdraft > 0) return out;
    const oneOffDriven = s.oneOff > 0 && b.balance - s.oneOff < s.reserve + s.monthlyBills + s.monthlyEveryday;
    const confidence = 0.6 + (s.sustained ? 0.2 : 0) - (oneOffDriven ? 0.2 : 0);
    const product = PRODUCTS[b.riskComfort] || PRODUCTS.low;
    const amount = Math.floor(s.surplus / 100) * 100;
    // Liquidity cascade: 1) checking keeps commitments (already subtracted), 2) savings until the reserve is met,
    // 3) only then micro-investing, and only with an existing investment profile.
    const bufferGap = Math.max(0, Math.round(s.reserve - s.saved));
    const tier = bufferGap > 0 ? 'safety_buffer' : 'wealth';
    const destination = s.profile && tier === 'wealth' ? product : PRODUCTS.low;
    const amt = s.auto ? Math.min(s.suggested, s.auto) : s.suggested;
    const r = Math.round;
    const idleCost = r(amt * IDLE_RATE);
    out.push({ id: 'excess_cash', confidence,
      evidence: [
        `Available balance ${eur(b.balance)}, minus expected bills ${eur(s.monthlyBills)}, everyday spending ${eur(s.monthlyEveryday)}${s.planned ? `, a renewal of ${eur(s.planned)} coming up` : ''} and ${s.reserveChosen ? 'your chosen' : 'a default 3-month'} reserve of ${eur(s.reserve)}, leaves about ${eur(amount)} over the next 30 days (future income ignored)`,
        s.sustained ? 'Your balance was at least this high 30 and 60 days ago too, not just after one payment'
          : oneOffDriven ? `A single incoming payment of ${eur(s.oneOff)} recently lifted your balance, so this estimate is less certain` : 'Your balance was lower at some point in the last two months',
        idleCost >= 1 ? `Left on the current account, ${eur(amt)} typically earns little or no interest; at an illustrative ${IDLE_RATE * 100}% a year on a savings account it could earn roughly ${eur(idleCost)} a year (real rates differ and can change)` : 'The amount is small, so the interest at stake is minimal',
        tier === 'safety_buffer' ? `Your reserve of ${eur(s.reserve)} is not yet fully held in savings (${eur(bufferGap)} to go), so savings comes first` : 'Your reserve is already held in savings, so the next step could be micro-investing (needs an investment profile)',
        s.rising ? 'Your spending this month is running well above your usual level, so the suggested amount is lower' : 'Your spending this month is in line with your usual level',
        b.riskComfort ? `stated comfort with risk: ${b.riskComfort} (investing still needs a full investment profile)` : 'no stated risk comfort yet: only safe options suggested'],
      facts: { excess: amount, balance: r(b.balance), bills: r(s.monthlyBills), everyday: r(s.monthlyEveryday), planned: r(s.planned), reserve: r(s.reserve),
        reserveChosen: s.reserveChosen, riskComfort: b.riskComfort || null, product, savingsProduct: PRODUCTS.low,
        // Prepared for one-tap approval; nothing moves until the customer approves.
        savingsTransfer: { amount: amt, from: 'payment account', to: destination.name, toProductId: destination.id },
        tier, bufferGap, idleCost, idleRate: IDLE_RATE,
        microInvest: tier === 'wealth' ? { minMonthly: MICRO_MIN, needsProfile: !s.profile } : null,
        hasInvestmentProfile: s.profile, spendingRising: s.rising,
        // Optional automation: only a proposal until the customer authorizes it within a limit.
        automation: { authorized: s.auto > 0, maxMonthly: s.auto || amt },
        // Customer can correct any assumption; the route follows their answer to "is it needed soon?".
        routes: { soon: 'keep accessible / savings goal', reserve: 'accessible savings account', longTerm: 'investment-profile process (guided handoff)' } } });
    return out;
  },
  actions: {
    buffer_clawback: {
      id: 'buffer-clawback', kind: 'care', priority: 4,
      product: PRODUCTS.low,
      en: (f) => ({ title: `Move ${eur(f.transfer.amount)} back from savings?`,
        body: `An unexpected payment of ${eur(f.unexpected)} took your current account to ${eur(f.balance)}, below your reserve of ${eur(f.reserve)}. You can move ${eur(f.transfer.amount)} back from your savings in one tap, to keep your account comfortably in the black. Nothing moves until you approve.`, cta: 'Move money back' }),
      advisor: ['Unexpected debit dropped the current account below the customer\'s reserve', 'Savings can cover it: offer a 1-tap transfer back, no penalty talk', 'Ask whether the reserve target still fits'],
    },
    excess_cash: {
      id: 'excess-cash', kind: 'commercial', priority: 2,
      en: (f) => ({ title: `An estimated ${eur(f.excess)} could be set aside`,
        body: `We kept your bills, everyday spending${f.planned ? ', an upcoming renewal' : ''} and ${f.reserveChosen ? 'your chosen' : 'a 3-month'} buffer of ${eur(f.reserve)} out of it. Is this money needed for something coming up? If not, we can prepare a transfer of ${eur(f.savingsTransfer.amount)} to a ${f.savingsProduct.name} for one-tap approval; ${f.hasInvestmentProfile ? 'for investing we would check the options against your existing investment profile' : 'for investing we would first walk you through your investment profile'}. ${f.idleCost >= 1 ? `Idle on your current account it typically earns little or no interest; at an illustrative rate of ${f.idleRate * 100}% a year a savings account could earn roughly ${eur(f.idleCost)} a year (rates differ and can change). ` : ''}${f.tier === 'safety_buffer' ? `Savings comes first, until your reserve is fully there (${eur(f.bufferGap)} to go). ` : `Your reserve is covered, so small regular investments from ${eur(f.microInvest.minMonthly)} a month could be a next step, after an investment profile. `}You can correct any assumption.`, cta: 'Review and set aside' }),
      advisor: ['Ask first: is this money needed soon? Needed soon: keep accessible or a savings goal',
        'Emergency reserve still being built: accessible savings route',
        'Long-term goal and interest in investing: open the investment-profile process (objectives, risk, finances, horizon). A high balance or risk toggle is not enough',
        'Review the assumptions (bills, spending, reserve) with the customer; estimate ignores future income'],
    },
  },
  personas: [
    { // Unexpected debit breached the reserve while savings exist: 1-tap transfer back.
      id: 'sav3', name: 'Noor Hendrickx', age: 29, balance: 1100, savings: 2000,
      consent: { personalization: true, transactionInsights: true, advisorInsights: true },
      prefs: { reserve: 1500 },
      events: [
        ...Array.from({ length: 6 }, (_, i) => ({ d: i * 30 + 26, cat: 'salary', amt: 2400 })),
        ...Array.from({ length: 6 }, (_, i) => ({ d: i * 30 + 3, cat: 'rent', amt: -900 })),
        ...Array.from({ length: 6 }, (_, i) => ({ d: i * 30 + 10, cat: 'groceries', amt: -400 })),
        { d: 120, cat: 'savings_transfer', amt: -2000 },
        { d: 4, cat: 'disruption', amt: -450, m: 'Car repair' },
      ] },
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
