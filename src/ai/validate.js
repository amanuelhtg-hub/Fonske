'use strict';
// Output validation for AI-worded cards. Anything that fails here means "use the template".
const LIMITS = { title: 90, body: 420, cta: 32 };

// Plain English only: ASCII letters/digits/punctuation plus the euro sign and typographic quotes/dashes.
const ALLOWED_CHARS = /^[A-Za-z0-9 .,;:!?'"()%+\-&/€‘’“”–—…]*$/;
const STOPWORDS = new Set(['the', 'you', 'your', 'a', 'an', 'is', 'are', 'to', 'and', 'of', 'in', 'for', 'on', 'it', 'this', 'that', 'with', 'can', 'may', 'we', 'was', 'has', 'have', 'at', 'or']);

// Promises, advice and product pushing are never allowed in AI wording (the templates are the reviewed baseline).
const FORBIDDEN = [
  /\bguarant\w*/i, /\bpromis\w*/i, /\byou\s*(will|'ll|’ll)\s+(receive|get|earn|gain|save|make|be refunded)\b/i,
  /\brefund\w*/i, /\bcompensat\w*/i, /\bentitled\b/i, /\brisk[- ]free\b/i, /\bno risk\b/i, /\bcertain(ly)?\b/i,
  /\bbuy\b/i, /\bsell\b/i, /\binvest\s+in\b/i, /\breturns?\b/i, /\bprofits?\b/i, /\byields?\b/i,
  /\byou\s+should\b/i, /\bwe\s+(recommend|advise)\b/i, /\bi\s+(recommend|advise)\b/i, /\bbest\s+(option|choice|deal)\b/i,
  /\bhttps?:/i, /\bwww\./i, /@/, /\b(hundred|thousand|million|billion)\b/i,
];

const NUM = /\d+(?:,\d{3})*(?:\.\d+)?/g;
const numbersIn = (text) => (String(text).match(NUM) || []).map((t) => Number(t.replace(/,/g, '')));

function collect(value, out) {
  if (typeof value === 'number' && Number.isFinite(value)) out.add(Math.abs(value));
  else if (typeof value === 'string') for (const n of numbersIn(value)) out.add(n);
  else if (Array.isArray(value)) for (const v of value) collect(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collect(v, out);
  return out;
}

// Numbers the output may contain: those in the facts, the evidence lines and the reviewed template text.
const allowedNumbers = (facts, evidence, template) => collect([facts, evidence, template && [template.title, template.body, template.cta]], new Set());

// Returns { title, body, cta } or null.
function validateOutput(out, { facts, evidence, template }) {
  if (!out || typeof out !== 'object' || Array.isArray(out)) return null;
  const res = {};
  for (const k of Object.keys(LIMITS)) {
    const v = out[k];
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (!t || t.length > LIMITS[k] || !ALLOWED_CHARS.test(t)) return null;
    if (FORBIDDEN.some((re) => re.test(t))) return null;
    res[k] = t;
  }
  if (res.body.length < 20) return null;
  const words = res.body.toLowerCase().match(/[a-z']+/g) || [];
  if (words.filter((w) => STOPWORDS.has(w)).length < 3) return null; // not recognisably English
  const allowed = allowedNumbers(facts, evidence, template);
  for (const k of Object.keys(res)) for (const n of numbersIn(res[k])) if (!allowed.has(n)) return null;
  return res;
}

module.exports = { validateOutput, LIMITS, allowedNumbers };
