'use strict';
// Travel vs. relocation, plus travel disruption (part of the travel feature).
const { sum, count, eur, country } = require('./util');

// Demo customers are 100% synthetic.
const ON = { personalization: true, transactionInsights: true, advisorInsights: true };
const monthly = (cat, amt, months, off) => Array.from({ length: months }, (_, i) => ({ d: i * 30 + off, cat, amt }));
const base = (salary, rent, groceries) => [...monthly('salary', salary, 6, 26), ...monthly('rent', -rent, 6, 3), ...monthly('groceries', -groceries, 6, 10)];

module.exports = {
  name: 'travel',
  derive(c) {
    const ev = c.events;
    const abroad = ev.filter((e) => e.cat === 'abroad' && e.d < 45);
    const last = abroad.reduce((a, e) => (!a || e.d < a.d ? e : a), null);
    // Zero-amount marker events carry the customer's own answers: travel_confirm (m = holiday|stay|move,
    // c = country), travel_booking (m = carrier/hotel, amt = price) and booking_cancelled (m = carrier).
    let confirm = null, booking = null, cancelled = null;
    for (const e of ev) {
      if (e.cat === 'travel_confirm' && e.d < 120 && (!confirm || e.d < confirm.d)) confirm = e;
      else if (e.cat === 'travel_booking' && e.d < 60 && (!booking || e.d < booking.d)) booking = e;
      else if (e.cat === 'booking_cancelled' && e.d < 14 && (!cancelled || e.d < cancelled.d)) cancelled = e;
    }
    return {
      situation: confirm ? confirm.m : null,
      months: confirm && confirm.amt ? Math.round(confirm.amt) : null,
      confirmCountry: confirm ? confirm.c || null : null,
      booking: booking ? { m: booking.m, cost: -booking.amt } : null,
      cancelled: cancelled ? cancelled.m : null,
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
    const cc = s.country || s.confirmCountry;
    const heuristicMove = s.foreignRent || (s.abroadDays >= 15 && s.homeActivity === 0);
    const travelling = s.abroadRecent > 100;
    // 1. The customer's own answer is the reliable basis: it overrides what the payments suggest.
    if (s.situation === 'move') {
      out.push({ id: 'relocation', confidence: 0.95, facts: { country: cc, confirmed: true },
        evidence: ['you confirmed a move abroad', ...(s.abroadDays ? [`${s.abroadDays} days with spending abroad in the last 45 days`] : [])] });
    } else if (s.situation === 'stay') {
      out.push({ id: 'temporary_stay', confidence: 0.92, facts: { country: cc, months: s.months },
        evidence: ['you confirmed a temporary stay abroad', ...(s.months ? [`planned duration: ${s.months} months`] : []),
          ...(s.abroadDays ? [`${s.abroadDays} days with spending abroad in the last 45 days`] : [])] });
    } else if (s.situation === 'holiday') {
      out.push({ id: 'travel', confidence: 0.9, facts: { country: cc, spent: s.abroadRecent, confirmed: true },
        evidence: ['you confirmed this is a holiday', ...(travelling ? [`${eur(s.abroadRecent)} spent abroad in the last 14 days`] : [])] });
    } else if (heuristicMove) {
      // 2. Unconfirmed signals: ask, don't assume.
      out.push({ id: 'relocation', confidence: 0.9, facts: { country: cc },
        evidence: [`${s.abroadDays} days with spending abroad in the last 45 days`,
          s.foreignRent ? 'recurring rent paid abroad' : 'no spending at home in the last 30 days'] });
    } else if (travelling) {
      out.push({ id: 'travel', confidence: 0.9, facts: { country: cc, spent: s.abroadRecent },
        evidence: [`${eur(s.abroadRecent)} spent abroad in the last 14 days`, 'spending at home continues: looks like a trip, not a move'] });
    } else if (s.booking && s.abroadDays === 0 && !s.cancelled) {
      out.push({ id: 'trip_upcoming', confidence: 0.75, facts: { merchant: s.booking.m, cost: s.booking.cost },
        evidence: [`payment of ${eur(s.booking.cost)} to ${s.booking.m} (flight or accommodation)`, 'no spending abroad yet: a trip may be coming up'] });
    }
    // 3. Disruption: a shared booking that was cancelled beats a cost-only hint.
    if (s.cancelled) {
      out.push({ id: 'travel_disruption', confidence: 0.95, facts: { booking: s.cancelled, cost: s.disruption },
        evidence: [`your booking with ${s.cancelled} was reported as cancelled`, 'refund, rebooking and claim routes depend on the circumstances'] });
    } else if (travelling && !s.situation && !heuristicMove && s.disruption > 0) {
      out.push({ id: 'travel_disruption', confidence: 0.95, facts: { cost: s.disruption },
        evidence: [`unexpected ${eur(s.disruption)} travel cost while abroad (rebooking or similar)`] });
    }
    return out;
  },
  eventCats: ['travel_confirm', 'travel_booking', 'booking_cancelled'],
  personas: [
    { // Booked flight + hotel, nothing abroad yet: Kate asks what the payments are for.
      id: 'tr1', name: 'Lotte Peeters', age: 29, lang: 'nl', balance: 3100, consent: { ...ON },
      events: [...base(2600, 720, 280),
        { d: 12, cat: 'travel_booking', amt: -286, m: 'Brussels Airlines' }, { d: 11, cat: 'travel_booking', amt: -540, m: 'Booking.com' }],
    },
    { // Confirmed a three-month stay in Portugal: coverage duration check.
      id: 'tr2', name: 'Maarten Claes', age: 31, lang: 'en', balance: 4200, consent: { ...ON },
      events: [...base(3100, 850, 320),
        ...Array.from({ length: 12 }, (_, i) => ({ d: i * 3 + 1, cat: 'abroad', amt: -38, c: 'PT' })),
        { d: 4, cat: 'travel_confirm', amt: 3, m: 'stay', c: 'PT' }],
    },
    { // Fictional cancelled booking shared with Kate: prefilled request for review.
      id: 'tr3', name: 'Emma Wouters', age: 37, lang: 'en', balance: 2500, consent: { ...ON },
      events: [...base(2900, 780, 310),
        { d: 20, cat: 'travel_booking', amt: -412, m: 'Brussels Airlines' }, { d: 1, cat: 'booking_cancelled', amt: 0, m: 'Brussels Airlines' }],
    },
  ],
  actions: {
    trip_upcoming: {
      id: 'trip-question', kind: 'care', priority: 4,
      product: { id: 'kbc-travel-insurance', name: 'KBC travel insurance' },
      en: (f) => ({ title: `Is your ${f.merchant} payment for a trip?`, body: 'Are these payments related to a holiday, a temporary stay or a move? Tell us and we will prepare the right help: card settings, cover details and assistance contacts.', cta: 'Tell Kate' }),
      nl: (f) => ({ title: `Is je betaling aan ${f.merchant} voor een reis?`, body: 'Hebben deze betalingen te maken met een vakantie, een tijdelijk verblijf of een verhuis? Laat het ons weten en we bereiden de juiste hulp voor: kaartinstellingen, dekking en noodnummers.', cta: 'Vertel het aan Kate' }),
      advisor: ['Flight/accommodation payment seen: ask what it is for, do not assume'],
    },
    travel: {
      id: 'travel-cover', kind: 'commercial', priority: 4,
      product: { id: 'kbc-travel-insurance', name: 'KBC travel insurance' },
      en: (f) => ({ title: `Enjoying your trip${f.country ? ` to ${country(f.country)}` : ''}?`,
        body: f.confirmed ? 'Your card settings, payment info, travel cover details and assistance contacts are ready in one place.'
          : 'Are these payments related to a holiday, a temporary stay or a move? If it is a holiday, check your travel cover, card limits and lost-card help in one tap.', cta: f.confirmed ? 'Open travel help' : 'Tell Kate' }),
      nl: (f) => ({ title: `Geniet je van je reis${f.country ? ` naar ${country(f.country)}` : ''}?`,
        body: f.confirmed ? 'Je kaartinstellingen, betaalinfo, details over je reisverzekering en noodnummers staan klaar op één plek.'
          : 'Hebben deze betalingen te maken met een vakantie, een tijdelijk verblijf of een verhuis? Bij een vakantie bekijk je reisverzekering, kaartlimieten en hulp bij verlies in één tik.', cta: f.confirmed ? 'Open reishulp' : 'Vertel het aan Kate' }),
      advisor: ['Customer is abroad now; contact only if they call', 'Travel cover on request'],
    },
    temporary_stay: {
      id: 'temporary-stay', kind: 'commercial', priority: 5,
      product: { id: 'kbc-travel-insurance', name: 'KBC travel insurance: long-stay cover check' },
      en: (f) => ({ title: f.months ? `You confirmed a ${f.months}-month stay${f.country ? ` in ${country(f.country)}` : ''}` : 'You confirmed a temporary stay abroad',
        body: 'Want to check whether your current travel cover applies for the full period? Standard trip cover often has a maximum duration. We can also set up a longer-term spending plan.', cta: 'Check my cover' }),
      nl: (f) => ({ title: f.months ? `Je bevestigde een verblijf van ${f.months} maanden${f.country ? ` in ${country(f.country)}` : ''}` : 'Je bevestigde een tijdelijk verblijf in het buitenland',
        body: 'Wil je nakijken of je huidige reisverzekering de volledige periode dekt? Een standaard reisverzekering heeft vaak een maximumduur. We stellen ook graag een uitgavenplan op langere termijn op.', cta: 'Controleer mijn dekking' }),
      advisor: ['Customer confirmed a temporary stay: check the cover duration, do not assume holiday insurance fits', 'Offer a longer-term spending plan'],
    },
    travel_disruption: {
      id: 'travel-disruption', kind: 'care', priority: 6,
      product: { id: 'kbc-travel-assistance', name: 'KBC travel assistance & claims' },
      en: (f) => f.booking
        ? ({ title: `Your ${f.booking} booking was cancelled`, body: 'We prepared your booking details so you can review rebooking and refund options. Whether you qualify for a refund or compensation depends on the circumstances, and an airline request is separate from an insurance claim. Nothing is sent until you approve it.', cta: 'Review prefilled request' })
        : ({ title: 'Trouble with your trip?', body: `We noticed an unexpected ${eur(f.cost)} travel cost. Start a claim and reach assistance right away. Keep your receipts.`, cta: 'Start a claim' }),
      nl: (f) => f.booking
        ? ({ title: `Je boeking bij ${f.booking} werd geannuleerd`, body: 'We hebben je boekingsgegevens klaargezet zodat je de opties voor omboeking en terugbetaling kan bekijken. Of je recht hebt op terugbetaling of compensatie hangt af van de omstandigheden, en een aanvraag bij de luchtvaartmaatschappij staat los van een verzekeringsclaim. Er wordt niets verstuurd zonder jouw goedkeuring.', cta: 'Bekijk ingevulde aanvraag' })
        : ({ title: 'Problemen met je reis?', body: `We zagen een onverwachte reiskost van ${eur(f.cost)}. Start meteen een schadeclaim en bereik bijstand. Bewaar je bonnetjes.`, cta: 'Start een claim' }),
      advisor: ['Possible travel disruption: offer claim help', 'Airline request and insurance claim are separate processes; promise no compensation', 'Do not sell; assist'],
    },
    relocation: {
      id: 'moving-abroad', kind: 'commercial', priority: 4,
      product: { id: 'kbc-international', name: 'KBC international banking & address change' },
      en: (f) => ({ title: f.confirmed ? `Your move${f.country ? ` to ${country(f.country)}` : ''}: checklist ready` : `Looks like you moved${f.country ? ` to ${country(f.country)}` : ' abroad'}`,
        body: f.confirmed ? 'Update your address and details, review your insurance (holiday cover does not cover a move) and adapt your recurring expenses.'
          : 'Are these payments related to a holiday, a temporary stay or a move? If you moved: update your address, set up cheap international transfers and review your home and health cover.', cta: f.confirmed ? 'Open my checklist' : 'Tell Kate' }),
      nl: (f) => ({ title: f.confirmed ? `Je verhuis${f.country ? ` naar ${country(f.country)}` : ''}: checklist klaar` : `Het lijkt erop dat je verhuisd bent${f.country ? ` naar ${country(f.country)}` : ''}`,
        body: f.confirmed ? 'Pas je adres en gegevens aan, herbekijk je verzekeringen (een reisverzekering dekt geen verhuis) en stem je terugkerende uitgaven af.'
          : 'Hebben deze betalingen te maken met een vakantie, een tijdelijk verblijf of een verhuis? Bij een verhuis: pas je adres aan, stel goedkope internationale overschrijvingen in en herbekijk je woon- en ziekteverzekering.', cta: f.confirmed ? 'Open mijn checklist' : 'Vertel het aan Kate' }),
      advisor: ['Likely relocation abroad: confirm with customer', 'Address change, international transfers, insurance review (ordinary holiday cover may not fit)'],
    },
  },
};
