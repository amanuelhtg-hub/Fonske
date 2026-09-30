'use strict';
// Message composition seam. The engine decides WHETHER and WHAT to say (deterministic, auditable);
// the composer decides HOW it is worded. The default renders the template from the action
// catalogue. An AI composer (e.g. Gemini on Google Cloud / Vertex AI) can replace `compose`
// without touching decisions or guardrails: it receives only the decision, its evidence/facts, and
// its output must be validated, falling back to the template on any failure.
const templateComposer = {
  compose(action, ctx) {
    return action.en(ctx.facts || {});
  },
};

let composer = templateComposer;
const setComposer = (c) => { composer = c || templateComposer; };
const compose = (...args) => composer.compose(...args);
// Optional async warm-up (an AI composer fills its cache here). Never rejects; a no-op for templates.
const prepare = async (decisions) => { try { if (composer.prepare) await composer.prepare(decisions); } catch { /* fall back to templates */ } };

module.exports = { compose, prepare, setComposer, templateComposer };
