'use strict';
const sum = (evs, f) => evs.reduce((s, e) => (f(e) ? s + e.amt : s), 0);
const count = (evs, f) => evs.reduce((n, e) => (f(e) ? n + 1 : n), 0);
const eur = (n) => `€${Math.abs(Math.round(n)).toLocaleString('en-GB')}`;
const COUNTRY = { ES: 'Spain', DE: 'Germany', FR: 'France', IT: 'Italy', PT: 'Portugal', NL: 'the Netherlands', GB: 'the UK', US: 'the USA', GR: 'Greece', TR: 'Turkey' };
const country = (c) => COUNTRY[c] || c;

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

module.exports = { sum, count, eur, country, recurring };
