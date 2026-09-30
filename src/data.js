'use strict';
// 100% synthetic data. No real customer information is used anywhere in this project.
// Event: { d: days ago, cat, amt: signed euros (spend < 0), m?: merchant, c?: country code }

const monthly = (cat, amt, months, off, extra = {}) =>
  Array.from({ length: months }, (_, i) => ({ d: i * 30 + off, cat, amt, ...extra }));

// `amounts` lists oldest -> newest so a subscription can have a price increase.
const recurring = (cat, m, amounts, off) =>
  amounts.map((amt, i) => ({ d: (amounts.length - 1 - i) * 30 + off, cat, amt, m }));

const base = (salary, rent, groceries) => [
  ...monthly('salary', salary, 6, 26), ...monthly('rent', -rent, 6, 3),
  ...monthly('groceries', -groceries, 6, 10),
];

const ON = { personalization: true, transactionInsights: true, advisorInsights: true };

const CORE_CUSTOMERS = [
  { // Subscription creep: five subscriptions, two streaming services, one price increase.
    id: 'c1', name: 'Lotte Peeters', age: 29, lang: 'nl', balance: 4200, consent: { ...ON },
    events: [
      ...base(3100, 850, 380),
      ...recurring('subscription', 'Netflix', [-13, -13, -13, -13, -15, -15], 5),
      ...recurring('subscription', 'Disney+', [-9, -9, -9, -9, -9, -9], 8),
      ...recurring('subscription', 'Spotify', [-11, -11, -11, -11, -11, -11], 12),
      ...recurring('subscription', 'FitClub', [-30, -30, -30, -30, -30, -38], 15),
      ...recurring('subscription', 'Cloud storage', [-3, -3, -3, -3, -3, -3], 18),
    ],
  },
  { // Excess cash, comfortable with some risk.
    id: 'c2', name: 'Thomas Claes', age: 32, lang: 'en', balance: 28000, consent: { ...ON },
    prefs: { riskComfort: 'medium' },
    events: base(3600, 900, 320),
  },
  { // Overdrawn: expense-control help only, no product pushing. Also has subscriptions.
    id: 'c3', name: 'Amina El Idrissi', age: 41, lang: 'nl', balance: -240, consent: { ...ON },
    events: [
      ...base(2000, 1050, 420),
      ...recurring('subscription', 'Netflix', [-15, -15, -15, -15, -15, -15], 5),
      ...recurring('subscription', 'Disney+', [-9, -9, -9, -9, -9, -9], 8),
      ...recurring('subscription', 'Mobile games', [-10, -10, -10, -10, -10, -10], 20),
      { d: 40, cat: 'overdraft_fee', amt: -12 }, { d: 21, cat: 'overdraft_fee', amt: -12 },
      { d: 6, cat: 'overdraft_fee', amt: -12 },
    ],
  },
  { // Short holiday in Spain, with a flight rebooking: travel + disruption.
    id: 'c4', name: 'Jonas Willems', age: 26, lang: 'en', balance: 2800,
    consent: { ...ON, advisorInsights: false },
    events: [
      ...base(2700, 700, 300),
      { d: 6, cat: 'abroad', amt: -240, c: 'ES' }, { d: 5, cat: 'abroad', amt: -95, c: 'ES' },
      { d: 4, cat: 'abroad', amt: -60, c: 'ES' }, { d: 2, cat: 'abroad', amt: -130, c: 'ES' },
      { d: 1, cat: 'disruption', amt: -185, m: 'Airline rebooking', c: 'ES' },
    ],
  },
  { // Moved to Germany: steady spending abroad, foreign rent, home spending stopped.
    id: 'c5', name: 'Sophie Maes', age: 34, lang: 'nl', balance: 3500, consent: { ...ON },
    events: [
      ...monthly('salary', 3400, 6, 26), ...monthly('rent', -800, 6, 50),
      ...monthly('groceries', -350, 6, 55),
      ...monthly('rent_abroad', -950, 2, 8, { c: 'DE' }),
      ...Array.from({ length: 20 }, (_, i) => ({ d: i * 2 + 1, cat: 'abroad', amt: -45, c: 'DE' })),
    ],
  },
  { // Household bills, an annual insurance renewal coming up, and idle cash (low risk comfort).
    id: 'c6', name: 'Luc Vermeulen', age: 52, lang: 'nl', balance: 41000, consent: { ...ON },
    prefs: { riskComfort: 'low' },
    events: [
      ...monthly('salary', 4200, 6, 26), ...monthly('mortgage', -1100, 6, 3),
      ...monthly('groceries', -500, 6, 10),
      ...recurring('utility', 'Energy supplier', [-140, -140, -140, -150, -150, -165], 7),
      ...recurring('utility', 'Mobile operator', [-35, -35, -35, -35, -35, -35], 14),
      ...recurring('utility', 'Water company', [-28, -28, -28, -28, -28, -28], 19),
      { d: 345, cat: 'insurance', amt: -620, m: 'Car insurance' },
    ],
  },
  { // Personalisation switched off: the engine must not analyse her data at all.
    id: 'c7', name: 'Marie Dubois', age: 38, lang: 'en', balance: 26000,
    consent: { personalization: false, transactionInsights: false, advisorInsights: false },
    events: [
      ...base(3000, 800, 300),
      ...recurring('subscription', 'Netflix', [-15, -15, -15, -15, -15, -15], 5),
      ...recurring('subscription', 'Spotify', [-11, -11, -11, -11, -11, -11], 12),
    ],
  },
];

// Features can ship their own demo personas (`personas` export in src/features/<name>.js).
// Give them unique ids (c8, c9, ...) and assign them to an advisor below if needed.
const CUSTOMERS = [...CORE_CUSTOMERS, ...require('./features').FEATURES.flatMap((f) => f.personas || [])];

// Advisors can only ever see customers assigned to them (and only with consent).
const ADVISORS = [
  { id: 'a1', name: 'An Jacobs (advisor)', assigned: ['c1', 'c2', 'c3', 'c5'] },
  { id: 'a2', name: 'Bart Goossens (advisor)', assigned: ['c4', 'c6', 'c7'] },
];

// Seeded PRNG so the scale benchmark is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministically derive the i-th synthetic customer from a persona template.
function syntheticCustomer(i) {
  const rnd = mulberry32(i * 2654435761);
  const t = CUSTOMERS[i % CUSTOMERS.length];
  const k = 0.8 + rnd() * 0.5;
  return {
    id: `s${i}`, name: `Synthetic ${i}`, age: t.age, lang: t.lang, prefs: t.prefs,
    balance: Math.round(t.balance * k), consent: t.consent,
    events: t.events.map((e) => ({ ...e, amt: Math.round(e.amt * k) })),
  };
}

module.exports = { CUSTOMERS, ADVISORS, syntheticCustomer };
