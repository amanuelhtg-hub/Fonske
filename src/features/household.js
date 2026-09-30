'use strict';
const { eur, recurring } = require('./util');

// Demo-data helpers (oldest -> newest amounts, `off` = days since the latest payment).
const monthly = (cat, amt, months, off) => Array.from({ length: months }, (_, i) => ({ d: i * 30 + off, cat, amt }));
const bill = (m, amounts, off) => amounts.map((amt, i) => ({ d: (amounts.length - 1 - i) * 30 + off, cat: 'utility', amt, m }));

// Step change + next due date per monthly bill: the latest payment vs the one before it.
function billCalendar(ev) {
  const by = new Map();
  for (const e of ev) {
    if (e.cat !== 'utility' || !e.m || e.amt >= 0) continue;
    const l = by.get(e.m);
    if (l) l.push(e); else by.set(e.m, [e]);
  }
  const out = [];
  for (const [m, l] of by) {
    if (l.length < 3) continue;
    l.sort((a, b) => b.d - a.d); // oldest first
    const n = l.length;
    let ok = l[n - 1].d <= 35;
    for (let i = 1; ok && i < n; i++) { const gap = l[i - 1].d - l[i].d; ok = gap >= 25 && gap <= 35; }
    if (!ok) continue;
    out.push({ m, amount: -l[n - 1].amt, prev: -l[n - 2].amt, dueIn: 30 - l[n - 1].d, energy: /energy|electric|gas/i.test(m) });
  }
  return out;
}

const STEP = 0.15; // latest payment at least 15% (and €5) above the previous one

// ---- Contract Watch (prototype): documents and tariff catalogue are SIMULATED ----------------------
// customer.documents = structured e-invoice data received through Zoomit (the e-invoicing service inside KBC
// Mobile), already parsed into fields: no inbox access, no PDF scraping. Simulated here. Anything the invoice
// does not contain is simply absent and is reported as missing, never guessed.
//   { m, plan, speedMbps?, usageKwh?, promoEndedDaysAgo?, renewalInDays?, cancelNoticeDays?, terminationFee? }
const CATALOGUE = { // current tariffs per supplier (illustrative; in production this is a tariff-data feed)
  'Internet provider': [
    { name: 'Fibre 100', speedMbps: 100, monthly: 60, switchFee: 0 },
    { name: 'Fibre 100 Web', speedMbps: 100, monthly: 48, switchFee: 0 },
    { name: 'Fibre 500', speedMbps: 500, monthly: 75, switchFee: 0 },
  ],
};
const MIN_SAVING = 60; // estimated first-year saving (after switch fee) needed before we prepare a change

function watch(s) {
  const out = [];
  for (const d of s.docs) {
    const b = s.bills.find((x) => x.m === d.m);
    if (!b) continue;
    const stepped = b.amount - b.prev >= 5 && b.amount / b.prev - 1 >= STEP;
    const promoEnded = Number.isFinite(d.promoEndedDaysAgo) && d.promoEndedDaysAgo >= 0 && d.promoEndedDaysAgo <= 60;
    if (!stepped && !promoEnded) continue;
    const missing = [];
    if (b.energy && !Number.isFinite(d.usageKwh)) missing.push('yearly usage (kWh)');
    if (!b.energy && !Number.isFinite(d.speedMbps)) missing.push('plan speed');
    if (!Number.isFinite(d.renewalInDays)) missing.push('renewal date');
    const base = { m: d.m, plan: d.plan || null, from: b.prev, to: b.amount, energy: b.energy, promoEnded, missing,
      renewalInDays: Number.isFinite(d.renewalInDays) ? d.renewalInDays : null, cancelNoticeDays: d.cancelNoticeDays ?? null };
    const lines = [`Your ${d.m} e-invoice via Zoomit shows ${d.plan ? `the plan ${d.plan}` : 'your contract details'}`,
      `${d.m}: latest payment ${eur(b.amount)}, previous payment ${eur(b.prev)}`];
    if (promoEnded) lines.push(`The e-invoice says the discount ended ${d.promoEndedDaysAgo} day(s) ago`);
    if (b.energy || missing.includes('plan speed')) {
      out.push({ id: 'contract_watch', confidence: 0.65, evidence: [...lines, `Cannot compare yet. Missing: ${missing.join(', ') || 'usage and contract terms'}`],
        facts: { ...base, status: 'needs_info', source: 'zoomit', missing: missing.length ? missing : ['usage'] } });
      continue;
    }
    const opts = (CATALOGUE[d.m] || []).filter((o) => o.speedMbps >= d.speedMbps && o.monthly < b.amount)
      .sort((x, y) => x.monthly - y.monthly || x.speedMbps - y.speedMbps);
    const best = opts[0];
    if (!best) continue;
    const monthlySaving = b.amount - best.monthly;
    const annualSaving = Math.round(monthlySaving * 12 - best.switchFee);
    if (annualSaving < MIN_SAVING) continue;
    lines.push(`Same provider lists "${best.name}" at ${best.speedMbps} Mbps for ${eur(best.monthly)}/month (yours: ${d.speedMbps} Mbps)`,
      `Switch fee ${eur(best.switchFee)}; estimated first-year saving ${eur(annualSaving)}`);
    if (missing.length) lines.push(`Not found in the e-invoice: ${missing.join(', ')}`);
    out.push({ id: 'contract_watch', confidence: 0.9 - (missing.length ? 0.1 : 0), evidence: lines,
      facts: { ...base, status: 'ready', source: 'zoomit', newPlan: best.name, newSpeedMbps: best.speedMbps, newMonthly: best.monthly, switchFee: best.switchFee,
        monthlySaving, annualSaving, prepared: { type: 'plan_change', supplier: d.m, fromPlan: d.plan || null, toPlan: best.name } } });
  }
  return out;
}

// Bill increase + shortfall opportunities (cheap: no bills -> nothing to do).
function extra(s) {
  const out = [];
  if (!s.bills.length) return out;
  const watched = s.docs.length ? watch(s) : [];
  out.push(...watched);
  const up = s.bills.filter((b) => !watched.some((w) => w.facts.m === b.m) && b.amount - b.prev >= 5 && b.amount / b.prev - 1 >= STEP)
    .sort((a, b) => (b.amount - b.prev) - (a.amount - a.prev))[0];
  if (up) {
    out.push({ id: 'bill_increase', confidence: up.energy ? 0.7 : 0.85, evidence: [
      `${up.m}: latest payment ${eur(up.amount)}, previous payment ${eur(up.prev)} (+${Math.round((up.amount / up.prev - 1) * 100)}%)`,
      up.energy ? 'Energy bills also move with consumption, advance adjustments or an annual settlement, so a higher payment is not necessarily a worse tariff'
        : 'A jump like this can mean a promotional discount ended (we cannot see the reason from transactions alone)'],
    facts: { m: up.m, from: up.prev, to: up.amount, energy: up.energy } });
  }
  const due = s.bills.filter((b) => b.dueIn >= 0 && b.dueIn <= 3);
  const need = due.reduce((t, b) => t + b.amount, 0);
  const short = Math.ceil(need - s.account);
  if (due.length && short > 0) {
    const top = due.reduce((a, b) => (b.amount > a.amount ? b : a));
    const canCover = s.savings >= short;
    out.push({ id: 'bill_shortfall', confidence: 0.9, evidence: [
      `${due.map((b) => `${b.m} (${eur(b.amount)})`).join(', ')} expected within ${Math.max(...due.map((b) => b.dueIn))} day(s), based on its monthly pattern`,
      `Payment account holds ${eur(s.account)}: about ${eur(short)} short`,
      canCover ? `Your linked savings account holds ${eur(s.savings)}` : 'No linked savings balance is available to cover it'],
    facts: { m: top.m, dueIn: top.dueIn, need, account: s.account, short, canCover,
      transfer: canCover ? { from: 'savings', to: 'payment account', amount: short } : null } });
  }
  return out;
}

module.exports = {
  name: 'household',
  personas: [
    { // Internet bill jumped from €45 to €60 (promotion probably ended). Healthy account.
      id: 'hh1', name: 'Eva Janssens', age: 31, balance: 3100, consent: { personalization: true, transactionInsights: true, advisorInsights: true },
      events: [
        ...monthly('salary', 3000, 6, 26), ...monthly('rent', -900, 6, 3), ...monthly('groceries', -350, 6, 10),
        ...bill('Internet provider', [-45, -45, -45, -45, -45, -60], 10),
        ...bill('Mobile operator', [-20, -20, -20, -20, -20, -20], 17),
      ],
    },
    { // Electricity bill due tomorrow but the current account is €80 short; linked savings can cover it.
      id: 'hh2', name: 'Piet Vermeersch', age: 44, balance: 120, savings: 2500, consent: { personalization: true, transactionInsights: true, advisorInsights: true },
      events: [
        ...monthly('salary', 2800, 6, 12), ...monthly('rent', -950, 6, 3), ...monthly('groceries', -400, 6, 8),
        ...bill('Energy supplier', [-200, -200, -200, -200, -200, -200], 29),
        ...bill('Water company', [-25, -25, -25, -25, -25, -25], 19),
      ],
    },
    { // Internet discount ended (€45 -> €60). Contract and tariff catalogue are simulated: same provider has a €48 plan at equal speed.
      id: 'hh3', name: 'Noor Claessens', age: 36, balance: 2600, consent: { personalization: true, transactionInsights: true, advisorInsights: true },
      documents: [{ m: 'Internet provider', plan: 'Fibre 100', speedMbps: 100, promoEndedDaysAgo: 12, renewalInDays: 200, cancelNoticeDays: 30 }],
      events: [
        ...monthly('salary', 3100, 6, 26), ...monthly('rent', -850, 6, 3), ...monthly('groceries', -380, 6, 10),
        ...bill('Internet provider', [-45, -45, -45, -45, -45, -60], 12),
        ...bill('Mobile operator', [-18, -18, -18, -18, -18, -18], 20),
      ],
    },
  ],
  derive: (c) => ({
    bills: billCalendar(c.events), docs: Array.isArray(c.documents) ? c.documents : [],
    account: c.balance, savings: c.savings > 0 ? c.savings : 0,
    utilities: recurring(c.events, 'utility'),
    annual: c.events.filter((e) => e.cat === 'insurance' && e.d >= 335 && e.d <= 395)
      .map((e) => ({ m: e.m, amount: -e.amt, inDays: 365 - e.d })),
  }),
  detect(s) {
    const out = extra(s);
    const upcoming = s.annual.filter((a) => a.inDays >= 0 && a.inDays <= 45);
    if (s.utilities.length < 2 && !upcoming.length) return out;
    const total = s.utilities.reduce((t, x) => t + x.monthly, 0);
    const evidence = [];
    if (s.utilities.length) evidence.push(`${s.utilities.length} recurring bills costing ${eur(total)}/month (${s.utilities.map((u) => u.m).join(', ')})`);
    for (const u of s.utilities) if (u.increase >= 0.05) evidence.push(`${u.m} up ${Math.round(u.increase * 100)}% since first payment`);
    for (const a of upcoming) evidence.push(`${a.m} (${eur(a.amount)}) looks annual and is due in ~${a.inDays} days`);
    out.push({ id: 'household', confidence: 0.5 + 0.1 * s.utilities.length + (upcoming.length ? 0.2 : 0), evidence,
      facts: { count: s.utilities.length, total, upcoming, hikes: s.utilities.filter((u) => u.increase >= 0.05).map((u) => u.m) } });
    return out;
  },
  actions: {
    contract_watch: {
      id: 'household-contract-watch', kind: 'care', priority: 5,
      product: { id: 'kbc-bills', name: 'KBC Mobile: bills calendar & direct debits' },
      en: (f) => (f.status === 'ready'
        ? { title: `${f.promoEnded ? `Your ${f.m} discount ended` : `Your ${f.m} payment rose`}: a cheaper plan may fit`,
          body: `Based on your Zoomit e-invoice, "${f.newPlan}" from the same provider lists the same speed for ${eur(f.monthlySaving)} less per month. Estimated saving about ${eur(f.annualSaving)} in the first year${f.switchFee ? ` after a ${eur(f.switchFee)} switch fee` : ''}. The provider confirms the final price, and nothing changes until you approve.`,
          cta: 'Review prepared change' }
        : { title: `Your ${f.m} payment rose from ${eur(f.from)} to ${eur(f.to)}`,
          body: `I can't compare plans yet. Missing: ${f.missing.join(', ')}. ${f.energy ? 'A higher energy payment can come from usage, an adjusted advance or a yearly settlement, so I need the invoice details (Zoomit) or your latest bill before saying anything about the tariff.' : 'If this supplier sends its invoices through Zoomit, the plan and usage details arrive automatically. Otherwise you can share your latest bill.'}`,
          cta: 'Add latest bill' }),
      advisor: ['Invoice data received via Zoomit; recurring bill changed', 'Only compare with contract terms (and usage for energy); show fees and switching costs', 'Estimates, not guarantees'],
    },
    bill_increase: {
      id: 'household-bill-increase', kind: 'care', priority: 4,
      product: { id: 'kbc-bills', name: 'KBC Mobile: bills calendar & direct debits' },
      en: (f) => ({ title: `Your ${f.m} payment rose from ${eur(f.from)} to ${eur(f.to)}`,
        body: f.energy ? 'This can be higher consumption, an adjusted advance or a yearly settlement. Want me to look at your latest bill? Share it only if you like, and I will check whether it is worth comparing.'
          : 'Want me to check whether a promotional discount ended? If the reason is not visible to me I will ask for your latest bill, then prepare options.', cta: 'Check my bill' }),
      advisor: ['Recurring bill increased; reason unknown', 'Ask for the bill before comparing; energy changes can be usage or advance related'],
    },
    bill_shortfall: {
      id: 'household-bill-shortfall', kind: 'care', priority: 5,
      product: { id: 'kbc-own-transfer', name: 'KBC Mobile: transfer between own accounts' },
      en: (f) => ({ title: `${f.m} is due ${f.dueIn === 0 ? 'today' : f.dueIn === 1 ? 'tomorrow' : `in ${f.dueIn} days`}: your account is ${eur(f.short)} short`,
        body: f.canCover ? `Your linked savings account has enough. Review a ${eur(f.short)} transfer? Nothing moves until you approve it.` : 'Top up your payment account before the payment date to avoid fees.',
        cta: f.canCover ? `Review ${eur(f.short)} transfer` : 'Open accounts' }),
      advisor: ['Expected bill exceeds payment account balance', 'Offer a customer-approved own-account transfer; no product sale'],
    },
    household: {
      id: 'household-bills', kind: 'care', priority: 3,
      product: { id: 'kbc-bills', name: 'KBC Mobile: bills calendar & direct debits' },
      en: (f) => ({ title: f.upcoming.length ? `${f.upcoming[0].m} renews in about ${f.upcoming[0].inDays} days` : `Your household bills: ${eur(f.total)}/month`,
        body: `${f.upcoming.length ? `It cost ${eur(f.upcoming[0].amount)} last year: a good moment to compare offers. ` : ''}${f.hikes.length ? `${f.hikes.join(' and ')} went up. ` : ''}See every recurring bill in one calendar and never miss a payment.`, cta: 'Open bills calendar' }),
      advisor: ['Recurring household costs identified', 'Offer bills calendar; review insurance at renewal'],
    },
  },
};
