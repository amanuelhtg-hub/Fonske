'use strict';
// Shared UI helpers. All dynamic content goes through textContent / createElement (no innerHTML).
(function () {
  const $ = (id) => document.getElementById(id);

  function el(tag, props = {}, ...kids) {
    const { attrs, dataset, ...rest } = props;
    const n = Object.assign(document.createElement(tag), rest);
    if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (dataset) for (const [k, v] of Object.entries(dataset)) n.dataset[k] = v;
    for (const k of kids) if (k !== null && k !== undefined && k !== false) n.append(k);
    return n;
  }

  // ---- inline icons (Lucide-style strokes) ----
  const NS = 'http://www.w3.org/2000/svg';
  const PATHS = {
    check: ['M20 6L9 17l-5-5'],
    repeat: ['M17 1l4 4-4 4', 'M3 11V9a4 4 0 0 1 4-4h14', 'M7 23l-4-4 4-4', 'M21 13v2a4 4 0 0 1-4 4H3'],
    receipt: ['M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z', 'M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8', 'M12 17.5v-11'],
    plane: ['M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z'],
    briefcase: ['M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z', 'M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16'],
    wallet: ['M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4', 'M4 6v12c0 1.1.9 2 2 2h14v-4', 'M18 12a2 2 0 0 0 0 4h4v-4z'],
    home: ['M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9 22V12h6v10'],
    sliders: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
    send: ['M22 2L11 13', 'M22 2l-7 20-4-9-9-4z'],
    card: ['M21 4H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z', 'M1 10h22'],
    x: ['M18 6L6 18', 'M6 6l12 12'],
    cart: ['M9 22a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M20 22a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6'],
    arrowDown: ['M12 5v14', 'M19 12l-7 7-7-7'],
    zap: ['M13 2L3 14h9l-1 8 10-12h-9l1-8z'],
    shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
    alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
  };
  function svg(name, size = 20, stroke = 2) {
    const s = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
      'stroke-width': stroke, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v);
    for (const d of PATHS[name] || []) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p); }
    return s;
  }
  // The Kate assistant icon: the official circle mark (blue bars), shown on white surfaces.
  function kateIcon(size = 32) {
    return el('img', { className: 'kate-icon', src: '/kate-icon.png', alt: 'Kate', width: size, height: size });
  }

  // ---- mock merchant logos: initials on a stable colour (never the KBC blue) ----
  function hue(name) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const x = h % 300; // skip the 180-230 blue range, which is reserved for Kate
    return x < 180 ? x : x + 60;
  }
  function initials(name) {
    const words = name.replace(/[^A-Za-z0-9+ ]/g, ' ').trim().split(/\s+/).filter(Boolean);
    return ((words[0] || '?')[0] + (words.length > 1 ? words[1][0] : '')).toUpperCase();
  }
  function logo(name, size = '') {
    const n = el('span', { className: `logo ${size}`, textContent: initials(name), attrs: { role: 'img', 'aria-label': name } });
    n.style.background = `hsl(${hue(name)} 45% 42%)`;
    return n;
  }
  function categoryBadge(iconName, size = '') {
    return el('span', { className: `logo neutral ${size}` }, svg(iconName, 18));
  }

  const money = (n, digits) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR',
    minimumFractionDigits: digits ?? (Number.isInteger(n) ? 0 : 2), maximumFractionDigits: digits ?? (Number.isInteger(n) ? 0 : 2) }).format(n);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function api(path, method = 'GET', body) {
    const r = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  }

  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = !msg;
    clearTimeout(toastTimer);
    if (msg) toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  window.UI = { $, el, svg, kateIcon, logo, categoryBadge, money, sleep, api, toast };
}());
