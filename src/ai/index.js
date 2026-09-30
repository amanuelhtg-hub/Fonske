'use strict';
// AI wording layer (Gemini on Vertex AI). Decides nothing: it only rewords a card the engine already
// chose. compose() stays synchronous and reads a cache; prepare() fills it asynchronously.
// OFF unless KATE_AI=on + GOOGLE_CLOUD_PROJECT + GOOGLE_CLOUD_LOCATION + KATE_AI_MODEL are set.
const crypto = require('node:crypto');
const { setComposer, templateComposer } = require('../composer');
const { validateOutput } = require('./validate');
const vertex = require('./vertex');

const PROMPT_VERSION = 'v1';

function loadConfig(env = process.env) {
  if (env.KATE_AI !== 'on') return null;
  const project = env.GOOGLE_CLOUD_PROJECT, location = env.GOOGLE_CLOUD_LOCATION, model = env.KATE_AI_MODEL;
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project || '') || !/^[a-z0-9-]{3,30}$/.test(location || '') || !/^[\w.-]{3,80}$/.test(model || '')) {
    console.warn('[kate-ai] KATE_AI=on but GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION / KATE_AI_MODEL are missing or invalid: AI wording stays off');
    return null;
  }
  const int = (v, d) => (Number.isInteger(+v) && +v > 0 ? +v : d);
  return {
    project, location, model, quotaProject: env.GOOGLE_CLOUD_QUOTA_PROJECT || null,
    ttlMs: int(env.KATE_AI_CACHE_TTL_S, 3600) * 1000, cacheMax: int(env.KATE_AI_CACHE_MAX, 500),
    maxConcurrent: int(env.KATE_AI_MAX_CONCURRENT, 4), maxCalls: int(env.KATE_AI_MAX_CALLS, 300),
    prepareTimeoutMs: int(env.KATE_AI_PREPARE_TIMEOUT_MS, 2500), requestTimeoutMs: int(env.KATE_AI_REQUEST_TIMEOUT_MS, 6000),
  };
}

const keyOf = (actionId, facts) => crypto.createHash('sha256').update(`${PROMPT_VERSION}\n${actionId}\n${JSON.stringify(facts || {})}`).digest('hex');

function createAiComposer(cfg, { fetchFn = fetch, getToken, now = Date.now, log = console.warn } = {}) {
  const tokenFn = getToken || vertex.createTokenProvider({ fetchFn });
  const cache = new Map(); // key -> { out|null, exp }; Map order = LRU order
  const inflight = new Map(); // key -> Promise
  let enabled = true, calls = 0, failures = 0, pausedUntil = 0, warned = false;
  const stats = { hits: 0, calls: 0, rejected: 0, errors: 0 };

  const put = (key, out, ttl) => {
    cache.delete(key);
    cache.set(key, { out, exp: now() + ttl });
    while (cache.size > cfg.cacheMax) cache.delete(cache.keys().next().value);
  };
  const fresh = (key) => {
    const e = cache.get(key);
    if (!e) return null;
    if (e.exp <= now()) { cache.delete(key); return null; }
    return e;
  };
  const warnOnce = (msg) => { if (!warned) { warned = true; log(`[kate-ai] ${msg}; falling back to templates`); } };

  async function generateOne(key, d) {
    const prompt = vertex.buildPrompt({ actionId: d.action.id, opportunityId: d.moment, facts: d.facts, evidence: d.why });
    if (!prompt) return put(key, null, 60000);
    calls++; stats.calls++;
    try {
      const raw = await vertex.generate(cfg, prompt, { fetchFn, getToken: tokenFn, timeoutMs: cfg.requestTimeoutMs });
      const template = d.action.en(d.facts || {});
      const out = validateOutput(raw, { facts: d.facts, evidence: d.why, template });
      if (out) { failures = 0; put(key, out, cfg.ttlMs); } else { stats.rejected++; put(key, null, 5 * 60000); }
    } catch (e) {
      stats.errors++;
      warnOnce(`Vertex call failed (${e.message})`);
      put(key, null, 60000); // negative cache: do not hammer a broken backend
      if (++failures >= 5) { pausedUntil = now() + 30000; failures = 0; } // circuit breaker
    } finally { inflight.delete(key); }
  }

  const eligible = (d) => d && d.moment && d.action && typeof d.action.en === 'function';

  return {
    // Synchronous: cached (and re-validated) AI wording, otherwise the template.
    compose(action, ctx) {
      const tpl = action.en(ctx.facts || {});
      if (!enabled || !ctx.moment) return tpl;
      const e = fresh(keyOf(action.id, ctx.facts));
      if (!e || !e.out) return tpl;
      stats.hits++;
      return validateOutput(e.out, { facts: ctx.facts, evidence: ctx.evidence, template: tpl }) || tpl;
    },
    // Fills the cache for the given decisions; never throws; resolves within prepareTimeoutMs.
    async prepare(decisions) {
      if (!enabled || now() < pausedUntil) return;
      const jobs = [];
      for (const d of decisions || []) {
        if (!eligible(d)) continue;
        const key = keyOf(d.action.id, d.facts);
        if (fresh(key)) continue;
        let p = inflight.get(key);
        if (!p) {
          if (inflight.size >= cfg.maxConcurrent || calls >= cfg.maxCalls) continue; // cost control
          p = generateOne(key, d);
          inflight.set(key, p);
        }
        jobs.push(p);
      }
      if (!jobs.length) return;
      let timer;
      await Promise.race([Promise.allSettled(jobs), new Promise((r) => { timer = setTimeout(r, cfg.prepareTimeoutMs); })]);
      clearTimeout(timer);
    },
    setEnabled(v) { enabled = !!v; }, stats, cache,
  };
}

let active = null;
// Registers the AI composer when configured. Safe to call unconditionally at startup.
function install(env = process.env, deps) {
  const cfg = loadConfig(env);
  if (!cfg) return false;
  active = createAiComposer(cfg, deps);
  setComposer(active);
  console.log(`[kate-ai] Gemini wording on (${cfg.model}, ${cfg.location}); decisions and guardrails stay in code`);
  return true;
}
function uninstall() { active = null; setComposer(templateComposer); }

module.exports = { install, uninstall, loadConfig, createAiComposer, keyOf };
