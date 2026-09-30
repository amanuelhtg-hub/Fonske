'use strict';
// One real Gemini call with a sample fact set. Usage: npm run ai:check   (reads the same env vars as the server, and .env if present)
const { loadConfig } = require('./index');
const vertex = require('./vertex');
const { checkOutput } = require('./validate');
const { ACTIONS } = require('../features');

(async () => {
  const cfg = loadConfig({ ...process.env, KATE_AI: 'on' });
  if (!cfg) { console.error('Set GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION and KATE_AI_MODEL (see docs/GOOGLE_CLOUD.md).'); process.exit(2); }
  const action = ACTIONS.subscription_hike;
  const facts = { m: 'StreamFlix', from: 10, to: 15, yearly: 60 };
  const evidence = ['StreamFlix is charged about monthly (recurring pattern)', 'latest payment €15 vs €10 before (+50%)', 'if the new price continues: +€60/year'];
  const draft = action.en(facts);
  const prompt = vertex.buildPrompt({ actionId: action.id, opportunityId: 'subscription_hike', facts, evidence, draft });
  console.log(`model:    ${cfg.model} @ ${cfg.location}`);
  console.log(`thinking: ${JSON.stringify(vertex.thinkingConfig(cfg.model, process.env.KATE_AI_THINKING))}`);
  console.log(`template: ${draft.title} | ${draft.body} | [${draft.cta}]`);
  const t0 = Date.now();
  try {
    const raw = await vertex.generate(cfg, prompt, { getToken: vertex.createTokenProvider(), timeoutMs: 20000 });
    const ms = Date.now() - t0;
    const r = checkOutput(raw, { facts, evidence, template: draft });
    console.log(`latency:  ${ms} ms`);
    console.log(`gemini:   ${JSON.stringify(raw)}`);
    console.log(r.ok ? 'validation: ACCEPTED (this wording would be shown, aiWorded=true)' : `validation: REJECTED (${r.reason}); the template would be shown`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.log(`FAILED after ${Date.now() - t0} ms: ${e.message}`);
    console.log('hints: "vertex 404" = wrong model id or location (try GOOGLE_CLOUD_LOCATION=global); "vertex 403" = API not enabled / missing role; "vertex 400" = see KATE_AI_THINKING in docs; gcloud errors = run gcloud auth application-default login');
    process.exit(1);
  }
})();
