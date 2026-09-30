'use strict';
// Transaction-driven personal finance assistant engine:
//   transactions -> signals -> opportunities (with evidence) -> guard-railed decision -> channel.
// Pure functions, no I/O, no shared mutable state => trivially horizontally scalable
// (partition by customer id) and easy to unit test.
const { compose } = require('./composer');

const THRESHOLD = 0.5;
const MAX_CARDS = 2;

const sum = (evs, f) => evs.reduce((s, e) => (f(e) ? s + e.amt : s), 0);
const count = (evs, f) => evs.reduce((n, e) => (f(e) ? n + 1 : n), 0);
const COUNTRY = { ES: 'Spain', DE: 'Germany', FR: 'France', IT: 'Italy', PT: 'Portugal', NL: 'the Netherlands', GB: 'the UK', US: 'the USA', GR: 'Greece', TR: 'Turkey' };
const country = (c) => COUNTRY[c] || c;
const clamp = (x, hi = 0.95) => Math.min(hi, x);
const eur = (n) => `€${Math.abs(Math.round(n)).toLocaleString('en-GB')}`;

// Services that do roughly the same job: paying for two of a group is worth flagging.
const GROUPS = { Netflix: 'video streaming', 'Disney+': 'video streaming', 'Prime Video': 'video streaming',
  'HBO Max': 'video streaming', Spotify: 'music streaming', 'Apple Music': 'music streaming' };

// A merchant is "recurring" when it is charged at ~monthly intervals at least 3 times and is still active.
function recurring(ev, cat) {
  const by = new Map();
  for (const e of ev) {
    if (e.cat !== cat || !e.m) continue;
    const list = by.get(e.m);
    if (list) list.push(e); else by.set(e.m, [e]);
  }
  const out = [];
  for (const [m, list] of by) {
    if (list.length < 3) continue;
    list.sort((a, b) => b.d - a.d); // oldest first
    let ok = list[list.length - 1].d <= 35;
    for (let i = 1; ok && i < list.length; i++) {
      const gap = list[i - 1].d - list[i].d;
      ok = gap >= 25 && gap <= 35;
    }
    if (!ok) continue;
    const first = -list[0].amt;
    const last = -list[list.length - 1].amt;
    out.push({ m, monthly: last, increase: first > 0 ? last / first - 1 : 0 });
  }
  return out;
}

// ---- 1. Signals: raw transactions -> compact, explainable features --------------------
function deriveSignals(c) {
  const ev = c.events;
  const outflow = -sum(ev, (e) => e.amt < 0 && e.cat !== 'savings_transfer' && e.d < 180) / 6;
  const abroad = ev.filter((e) => e.cat === 'abroad' && e.d < 45);
  const lastAbroad = abroad.reduce((a, e) => (!a || e.d < a.d ? e : a), null);
  return {
    subscriptions: recurring(ev, 'subscription'),
    utilities: recurring(ev, 'utility'),
    annual: ev.filter((e) => e.cat === 'insurance' && e.d >= 335 && e.d <= 395)
      .map((e) => ({ m: e.m, amount: -e.amt, inDays: 365 - e.d })),
    abroadDays: new Set(abroad.map((e) => e.d)).size,
    abroadRecent: -sum(ev, (e) => e.cat === 'abroad' && e.d < 14),
    country: lastAbroad ? lastAbroad.c : null,
    foreignRent: count(ev, (e) => e.cat === 'rent_abroad' && e.d < 90) > 0,
    homeActivity: count(ev, (e) => (e.cat === 'groceries' || e.cat === 'rent' || e.cat === 'mortgage') && e.d < 30),
    disruption: -sum(ev, (e) => e.cat === 'disruption' && e.d < 7),
    overdraft: count(ev, (e) => e.cat === 'overdraft_fee' && e.d < 60),
    savingsRecent: count(ev, (e) => e.cat === 'savings_transfer' && e.d < 90),
    outflow,
    balance: c.balance,
    riskComfort: c.prefs && c.prefs.riskComfort,
  };
}

// ---- 2. Opportunities, each with confidence, evidence and the facts used for wording ----
function detect(s) {
  const out = [];
  const add = (id, confidence, evidence, facts) => {
    if (confidence >= THRESHOLD) out.push({ id, confidence: +clamp(confidence).toFixed(2), evidence, facts });
  };

  // Subscription management
  if (s.subscriptions.length >= 2) {
    const total = s.subscriptions.reduce((t, x) => t + x.monthly, 0);
    const hikes = s.subscriptions.filter((x) => x.increase >= 0.05).map((x) => x.m);
    const byGroup = {};
    for (const x of s.subscriptions) if (GROUPS[x.m]) (byGroup[GROUPS[x.m]] ||= []).push(x.m);
    const overlaps = Object.entries(byGroup).filter(([, v]) => v.length > 1).map(([g, v]) => `${v.join(' + ')} (${g})`);
    const evidence = [`${s.subscriptions.length} recurring subscriptions costing ${eur(total)}/month`];
    if (hikes.length) evidence.push(`price increase detected: ${hikes.join(', ')}`);
    if (overlaps.length) evidence.push(`overlap: ${overlaps.join('; ')}`);
    add('subscriptions', 0.5 + 0.08 * s.subscriptions.length + (hikes.length ? 0.1 : 0) + (overlaps.length ? 0.1 : 0),
      evidence, { count: s.subscriptions.length, total, hikes, overlaps });
  }

  // Household payments (monthly bills and annual renewals)
  const upcoming = s.annual.filter((a) => a.inDays >= 0 && a.inDays <= 45);
  if (s.utilities.length >= 2 || upcoming.length) {
    const total = s.utilities.reduce((t, x) => t + x.monthly, 0);
    const evidence = [];
    if (s.utilities.length) evidence.push(`${s.utilities.length} recurring bills costing ${eur(total)}/month (${s.utilities.map((u) => u.m).join(', ')})`);
    for (const u of s.utilities) if (u.increase >= 0.05) evidence.push(`${u.m} up ${Math.round(u.increase * 100)}% since first payment`);
    for (const a of upcoming) evidence.push(`${a.m} (${eur(a.amount)}) looks annual and is due in ~${a.inDays} days`);
    add('household', 0.5 + 0.1 * s.utilities.length + (upcoming.length ? 0.2 : 0), evidence,
      { count: s.utilities.length, total, upcoming, hikes: s.utilities.filter((u) => u.increase >= 0.05).map((u) => u.m) });
  }

  // Travel vs. relocation
  const relocating = s.foreignRent || (s.abroadDays >= 15 && s.homeActivity === 0);
  if (relocating) {
    add('relocation', 0.9, [
      `${s.abroadDays} days with spending abroad in the last 45 days`,
      s.foreignRent ? 'recurring rent paid abroad' : 'no spending at home in the last 30 days'], { country: s.country });
  } else if (s.abroadRecent > 100) {
    add('travel', 0.9, [`${eur(s.abroadRecent)} spent abroad in the last 14 days`, 'spending at home continues: looks like a trip, not a move'],
      { country: s.country, spent: s.abroadRecent });
    if (s.disruption > 0) {
      add('travel_disruption', 0.95, [`unexpected ${eur(s.disruption)} travel cost while abroad (rebooking or similar)`], { cost: s.disruption });
    }
  }

  // Savings and investments: cash beyond a 3-month buffer that is just sitting there
  const excess = s.balance - 3 * s.outflow;
  if (excess > 3000 && s.savingsRecent < 2 && s.overdraft === 0) {
    const product = { low: { id: 'kbc-savings', name: 'KBC savings account' },
      medium: { id: 'kbc-balanced-fund', name: 'KBC balanced fund' },
      high: { id: 'kbc-growth-fund', name: 'KBC growth fund' } }[s.riskComfort] || { id: 'kbc-savings', name: 'KBC savings account' };
    add('excess_cash', 0.7, [`${eur(s.balance)} on the current account, about ${eur(excess)} above a 3-month buffer`,
      s.riskComfort ? `stated comfort with risk: ${s.riskComfort}` : 'no stated risk comfort yet: only safe options suggested'],
    { excess: Math.floor(excess / 500) * 500, riskComfort: s.riskComfort || null, product });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

// ---- 3. Action catalogue: one decision, many channels ---------------------------------
// kind 'care' = expense-control help, always allowed; 'commercial' = product offers, suppressed under stress.
const ACTIONS = {
  subscriptions: {
    id: 'review-subscriptions', kind: 'care', priority: 3,
    product: { id: 'kbc-mobile-subs', name: 'KBC Mobile: subscription overview & alerts' },
    en: (f) => ({ title: `You pay ${eur(f.total)}/month on ${f.count} subscriptions`,
      body: `${f.hikes.length ? `${f.hikes.join(' and ')} got more expensive. ` : ''}${f.overlaps.length ? `You pay for overlapping services: ${f.overlaps.join('; ')}. ` : ''}Review them in one place and get alerts on price changes.`, cta: 'Review subscriptions' }),
    nl: (f) => ({ title: `Je betaalt ${eur(f.total)}/maand voor ${f.count} abonnementen`,
      body: `${f.hikes.length ? `${f.hikes.join(' en ')} werd duurder. ` : ''}${f.overlaps.length ? `Je betaalt voor overlappende diensten: ${f.overlaps.join('; ')}. ` : ''}Bekijk ze op één plek en ontvang een melding bij prijswijzigingen.`, cta: 'Bekijk abonnementen' }),
    advisor: ['Subscription spend reviewed with customer', 'Offer overview and price-change alerts'],
  },
  household: {
    id: 'household-bills', kind: 'care', priority: 3,
    product: { id: 'kbc-bills', name: 'KBC Mobile: bills calendar & direct debits' },
    en: (f) => ({ title: f.upcoming.length ? `${f.upcoming[0].m} renews in about ${f.upcoming[0].inDays} days` : `Your household bills: ${eur(f.total)}/month`,
      body: `${f.upcoming.length ? `It cost ${eur(f.upcoming[0].amount)} last year: a good moment to compare offers. ` : ''}${f.hikes.length ? `${f.hikes.join(' and ')} went up. ` : ''}See every recurring bill in one calendar and never miss a payment.`, cta: 'Open bills calendar' }),
    nl: (f) => ({ title: f.upcoming.length ? `${f.upcoming[0].m} verlengt binnen ongeveer ${f.upcoming[0].inDays} dagen` : `Je huishoudelijke facturen: ${eur(f.total)}/maand`,
      body: `${f.upcoming.length ? `Vorig jaar kostte het ${eur(f.upcoming[0].amount)}: een goed moment om aanbiedingen te vergelijken. ` : ''}${f.hikes.length ? `${f.hikes.join(' en ')} werd duurder. ` : ''}Bekijk alle terugkerende facturen in één kalender en mis nooit een betaling.`, cta: 'Open factuurkalender' }),
    advisor: ['Recurring household costs identified', 'Offer bills calendar; review insurance at renewal'],
  },
  travel: {
    id: 'travel-cover', kind: 'commercial', priority: 4,
    product: { id: 'kbc-travel-insurance', name: 'KBC travel insurance' },
    en: (f) => ({ title: `Enjoying your trip${f.country ? ` to ${country(f.country)}` : ''}?`, body: 'Your card works abroad. Check your travel cover, card limits and lost-card help in one tap.', cta: 'Open travel help' }),
    nl: (f) => ({ title: `Geniet je van je reis${f.country ? ` naar ${country(f.country)}` : ''}?`, body: 'Je kaart werkt in het buitenland. Bekijk je reisverzekering, kaartlimieten en hulp bij verlies in één tik.', cta: 'Open reishulp' }),
    advisor: ['Customer is abroad now; contact only if they call', 'Travel cover on request'],
  },
  travel_disruption: {
    id: 'travel-disruption', kind: 'care', priority: 6,
    product: { id: 'kbc-travel-assistance', name: 'KBC travel assistance & claims' },
    en: (f) => ({ title: 'Trouble with your trip?', body: `We noticed an unexpected ${eur(f.cost)} travel cost. Start a claim and reach assistance right away. Keep your receipts.`, cta: 'Start a claim' }),
    nl: (f) => ({ title: 'Problemen met je reis?', body: `We zagen een onverwachte reiskost van ${eur(f.cost)}. Start meteen een schadeclaim en bereik bijstand. Bewaar je bonnetjes.`, cta: 'Start een claim' }),
    advisor: ['Possible travel disruption: offer claim help', 'Do not sell; assist'],
  },
  relocation: {
    id: 'moving-abroad', kind: 'commercial', priority: 4,
    product: { id: 'kbc-international', name: 'KBC international banking & address change' },
    en: (f) => ({ title: `Looks like you moved${f.country ? ` to ${country(f.country)}` : ' abroad'}`, body: 'This looks like a move, not a trip. Update your address, set up cheap international transfers and review your home and health cover.', cta: 'Plan my move' }),
    nl: (f) => ({ title: `Het lijkt erop dat je verhuisd bent${f.country ? ` naar ${country(f.country)}` : ''}`, body: 'Dit lijkt een verhuizing, geen reis. Pas je adres aan, stel goedkope internationale overschrijvingen in en herbekijk je woon- en ziekteverzekering.', cta: 'Plan mijn verhuis' }),
    advisor: ['Likely relocation abroad: confirm with customer', 'Address change, international transfers, insurance review'],
  },
  excess_cash: {
    id: 'excess-cash', kind: 'commercial', priority: 2,
    en: (f) => ({ title: `About ${eur(f.excess)} could be working for you`, body: f.riskComfort ? `Beyond a 3-month safety buffer, your money sits idle. Based on your comfort with risk, consider a ${f.product.name}.` : `Beyond a 3-month safety buffer, your money sits idle. A ${f.product.name} is a safe start; tell us how comfortable you are with risk for more options.`, cta: 'Compare options' }),
    nl: (f) => ({ title: `Ongeveer ${eur(f.excess)} kan voor je werken`, body: f.riskComfort ? `Boven een buffer van 3 maanden staat je geld stil. Op basis van je risicobereidheid: overweeg een ${f.product.name}.` : `Boven een buffer van 3 maanden staat je geld stil. Een ${f.product.name} is een veilige start; laat weten hoeveel risico je wil nemen voor meer opties.`, cta: 'Vergelijk opties' }),
    advisor: ['Idle cash beyond buffer: savings vs. investing conversation', 'MiFID suitability profile required before any investment advice'],
  },
};

const GENERIC = {
  id: 'generic-tips', kind: 'care',
  en: () => ({ title: 'Welcome back', body: 'Personalised suggestions are switched off. You can turn them on in your privacy settings at any time.', cta: 'Privacy settings' }),
  nl: () => ({ title: 'Welkom terug', body: 'Gepersonaliseerde suggesties staan uit. Je kan ze op elk moment inschakelen in je privacyinstellingen.', cta: 'Privacyinstellingen' }),
};

// ---- 4. Decision with guardrails ----------------------------------------------------------
// state: { dismissed: Set<actionId> } is supplied by the caller (per customer).
function decide(customer, state = {}) {
  const guardrails = [];
  const lang = customer.lang === 'nl' ? 'nl' : 'en';
  const c = customer.consent;
  if (!c.personalization) {
    guardrails.push('Personalisation consent is off: no customer data was analysed');
    return { customer: customer.id, lang, moments: [], decisions: [{ action: GENERIC, moment: null, confidence: 1, why: [], facts: {} }], guardrails };
  }
  if (!c.transactionInsights) {
    guardrails.push('Transaction-insight consent is off: transactions were not analysed');
    return { customer: customer.id, lang, moments: [], decisions: [], guardrails };
  }
  const signals = deriveSignals(customer);
  const moments = detect(signals);
  let cands = moments.map((m) => ({ action: ACTIONS[m.id], moment: m.id, confidence: m.confidence, why: m.evidence, facts: m.facts }));
  if (signals.overdraft > 0 || signals.balance < 0) {
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
  return { customer: customer.id, lang, moments, decisions: kept.slice(0, MAX_CARDS), guardrails };
}

// ---- 5. Same decision, adapted per channel ------------------------------------------------
function render(result, channel, customer) {
  const first = customer.name.split(' ')[0];
  const lang = result.lang;
  const items = result.decisions.map((d) => {
    const t = compose(d.action, lang, { moment: d.moment, evidence: d.why, facts: d.facts, firstName: first });
    const product = (d.facts && d.facts.product) || d.action.product || null;
    return { actionId: d.action.id, moment: d.moment, confidence: d.confidence, why: d.why, title: t.title, body: t.body, cta: t.cta, product, talkingPoints: d.action.advisor || [] };
  });
  if (channel === 'email') {
    const top = items[0];
    if (!top) return { channel, skipped: 'Nothing relevant to say right now. Silence is a feature.' };
    return {
      channel, subject: top.title, preheader: top.body.slice(0, 70),
      text: `${lang === 'nl' ? 'Dag' : 'Hi'} ${first},\n\n${top.body}\n\n→ ${top.cta}\n\nKBC`,
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
  return { channel: 'app', greeting: `${lang === 'nl' ? 'Dag' : 'Hi'} ${first}`, cards: items, guardrails: result.guardrails };
}

module.exports = { deriveSignals, detect, decide, render, ACTIONS, THRESHOLD, MAX_CARDS };
