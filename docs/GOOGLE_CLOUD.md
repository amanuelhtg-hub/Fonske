# Google Cloud: Gemini wording layer and Cloud Run

## Architecture
```
transactions -> signals -> opportunities (+evidence) -> guard-railed decision   (deterministic code, unchanged)
                                                              |
                                                     render() -> compose()      <- the only seam
                                                              |
                          template (default)  or  Gemini wording read from a cache
```
- The engine decides **whether** and **what** to say. Gemini may only change **how** a card is worded, through `setComposer()` in `src/composer.js`. It cannot add, rank, suppress or re-order cards, and it never sees or touches guardrails (consent, overdraft, risk profile, frequency cap, dismissals).
- `compose()` stays synchronous and only reads a cache (key = sha256 of prompt version + action id + facts JSON). An asynchronous `prepare()` step fills the cache: the server awaits it (hard timeout 2.5 s) before rendering the app/e-mail experience, and before pushing an SSE update. Stale pushes (a newer update arrived meanwhile) are dropped.
- Batch scoring (`npm run bench`, 2.3M customers) calls `decide()` only, which never composes. No model call can happen there.
- Code: `src/ai/index.js` (config, cache, limits), `src/ai/vertex.js` (Vertex REST over `fetch`, ADC auth, prompt), `src/ai/validate.js` (output checks). No npm dependencies.

## Turning it on
`KATE_AI=on`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `KATE_AI_MODEL` (a Gemini Flash-class model ID available in that region; check it with the curl in `deploy/README.md`). Optional: `GOOGLE_CLOUD_QUOTA_PROJECT`, `KATE_AI_CACHE_TTL_S` (3600), `KATE_AI_CACHE_MAX` (500), `KATE_AI_MAX_CONCURRENT` (4), `KATE_AI_MAX_CALLS` (300 per process), `KATE_AI_PREPARE_TIMEOUT_MS` (2500), `KATE_AI_REQUEST_TIMEOUT_MS` (6000). Anything missing or `KATE_AI` not `on` means templates only.
Auth is Application Default Credentials: on Cloud Run the metadata-server token of the service account (needs `roles/aiplatform.user`); locally `gcloud auth application-default print-access-token`.

## What goes to Gemini, and what never does
Sent (JSON-encoded, one request per card): action id, opportunity id, the decision's **facts** and **evidence lines** (for example merchant name, old/new price, amounts, counts, days). Strings are truncated to 80/240 characters and the payload is capped at 6,000 characters (otherwise no call).
Never sent: customer name or id, e-mail, account numbers, raw transactions, the full balance history, consent or preference settings beyond what a fact already states, session data. Customers with personalisation switched off get the generic card, which is never sent.
Merchant strings come from transactions and are untrusted: they are only ever inside the JSON payload and the system instruction tells the model to treat them as data, never as instructions. Even if that fails, the output validation below still applies.

## Validation and fallbacks
The response must be JSON `{title, body, cta}` (enforced with `responseMimeType` + `responseSchema`, then re-checked): lengths 90/420/32, plain English characters only, no links, markup or line breaks, at least a few English function words, **every number or € amount must appear in the facts, the evidence or the reviewed template**, and no promises or advice (guarantee, promise, "you will receive", refund, compensation, buy/sell, "invest in", returns, "you should", "we recommend", ...). Validation runs again on every cache read against the current facts.
Any failure (no credentials, HTTP error, timeout, bad JSON, rejected output, call budget used up, circuit breaker open after 5 consecutive failures) silently gives the template. Failures are cached negatively (60 s; rejected output 5 min) so a broken backend is not hammered. One warning line is logged per process. Kill switch: `KATE_AI=off` (env) or `setEnabled(false)` in code.
Known limit: the number check cannot catch a wrong *claim* that reuses valid numbers; that is why promises/advice wording is also blocked and the templates stay the fallback.

## Cost and scale
LLM cost scales with **cards shown**, not with customers. Scoring 2.3M customers costs nothing in model calls. Only a card that is actually rendered for a logged-in customer triggers a call, at most 2 cards per view (frequency cap), and identical facts share one cache entry for an hour. A call is about 400 input and 100 output tokens of a Flash-class model, so a demo session costs fractions of a cent. Hard limits: 300 calls per process, 4 concurrent calls, 500 cache entries. At production scale the same wording could be pre-generated once per distinct (action, facts) pair and served from a shared cache.

## Cloud Run
See `deploy/README.md`. Single instance (`--max-instances=1`) because state and SSE streams are in memory. `SECURE_COOKIES=1` adds the `Secure` flag to the session cookie (HTTPS).
