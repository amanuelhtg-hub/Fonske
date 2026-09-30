'use strict';
// Savings and investments: cash beyond a 3-month buffer, matched to the customer's stated risk comfort.
const { eur } = require('./util');

const PRODUCTS = { low: { id: 'kbc-savings', name: 'KBC savings account' },
  medium: { id: 'kbc-balanced-fund', name: 'KBC balanced fund' },
  high: { id: 'kbc-growth-fund', name: 'KBC growth fund' } };

module.exports = {
  name: 'savings',
  derive: () => ({}),
  detect(_s, b) {
    const excess = b.balance - 3 * b.outflow;
    if (excess <= 3000 || b.savingsRecent >= 2 || b.overdraft > 0) return [];
    const product = PRODUCTS[b.riskComfort] || PRODUCTS.low;
    return [{ id: 'excess_cash', confidence: 0.7,
      evidence: [`${eur(b.balance)} on the current account, about ${eur(excess)} above a 3-month buffer`,
        b.riskComfort ? `stated comfort with risk: ${b.riskComfort}` : 'no stated risk comfort yet: only safe options suggested'],
      facts: { excess: Math.floor(excess / 500) * 500, riskComfort: b.riskComfort || null, product } }];
  },
  actions: {
    excess_cash: {
      id: 'excess-cash', kind: 'commercial', priority: 2,
      en: (f) => ({ title: `About ${eur(f.excess)} could be working for you`, body: f.riskComfort ? `Beyond a 3-month safety buffer, your money sits idle. Based on your comfort with risk, consider a ${f.product.name}.` : `Beyond a 3-month safety buffer, your money sits idle. A ${f.product.name} is a safe start; tell us how comfortable you are with risk for more options.`, cta: 'Compare options' }),
      nl: (f) => ({ title: `Ongeveer ${eur(f.excess)} kan voor je werken`, body: f.riskComfort ? `Boven een buffer van 3 maanden staat je geld stil. Op basis van je risicobereidheid: overweeg een ${f.product.name}.` : `Boven een buffer van 3 maanden staat je geld stil. Een ${f.product.name} is een veilige start; laat weten hoeveel risico je wil nemen voor meer opties.`, cta: 'Vergelijk opties' }),
      advisor: ['Idle cash beyond buffer: savings vs. investing conversation', 'MiFID suitability profile required before any investment advice'],
    },
  },
};
