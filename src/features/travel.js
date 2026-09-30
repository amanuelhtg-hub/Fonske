'use strict';
// Travel vs. relocation, plus travel disruption (part of the travel feature).
const { sum, count, eur, country } = require('./util');

module.exports = {
  name: 'travel',
  derive(c) {
    const ev = c.events;
    const abroad = ev.filter((e) => e.cat === 'abroad' && e.d < 45);
    const last = abroad.reduce((a, e) => (!a || e.d < a.d ? e : a), null);
    return {
      abroadDays: new Set(abroad.map((e) => e.d)).size,
      abroadRecent: -sum(ev, (e) => e.cat === 'abroad' && e.d < 14),
      country: last ? last.c : null,
      foreignRent: count(ev, (e) => e.cat === 'rent_abroad' && e.d < 90) > 0,
      homeActivity: count(ev, (e) => (e.cat === 'groceries' || e.cat === 'rent' || e.cat === 'mortgage') && e.d < 30),
      disruption: -sum(ev, (e) => e.cat === 'disruption' && e.d < 7),
    };
  },
  detect(s) {
    const out = [];
    if (s.foreignRent || (s.abroadDays >= 15 && s.homeActivity === 0)) {
      out.push({ id: 'relocation', confidence: 0.9, facts: { country: s.country }, evidence: [
        `${s.abroadDays} days with spending abroad in the last 45 days`,
        s.foreignRent ? 'recurring rent paid abroad' : 'no spending at home in the last 30 days'] });
    } else if (s.abroadRecent > 100) {
      out.push({ id: 'travel', confidence: 0.9, facts: { country: s.country, spent: s.abroadRecent },
        evidence: [`${eur(s.abroadRecent)} spent abroad in the last 14 days`, 'spending at home continues: looks like a trip, not a move'] });
      if (s.disruption > 0) {
        out.push({ id: 'travel_disruption', confidence: 0.95, facts: { cost: s.disruption },
          evidence: [`unexpected ${eur(s.disruption)} travel cost while abroad (rebooking or similar)`] });
      }
    }
    return out;
  },
  actions: {
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
  },
};
