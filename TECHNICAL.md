# Technical notes

For the team's documentation and README. Numbers below were measured on an 8-core laptop.

## Architecture
`transactions -> signals -> opportunities (with evidence) -> guard-railed decision -> channel (app / e-mail / advisor)`

- **Engine (`src/engine.js`)**: pure functions with no I/O or shared state. It runs unchanged in a request handler, a stream processor or a batch job, and is easy to unit test.
- **Opportunities**: subscription management (recurring-charge detection, price hikes, overlapping services), household payments (recurring bills, annual renewals), travel vs. relocation (+ travel disruption), savings and investments (cash above a 3-month buffer, matched to the customer's stated risk comfort). Every opportunity carries a confidence and human-readable evidence, which powers "Why am I seeing this?".
- **Guardrails (deterministic code, never AI)**: consent switches (off = data not analysed), overdraft suppresses all product offers, no investment advice without a risk profile, dismissed suggestions never return, frequency cap of 2 cards.
- **Product links**: each action maps to a KBC product (`product` field in `ACTIONS`). Product names are illustrative placeholders.
- **AI seam (`src/composer.js`)**: the engine decides whether and what to say, and the composer decides the wording. A Gemini (Google Cloud) composer can be plugged in with `setComposer()` and must fall back to the templates on any failure.

## Scale
- Real-time: `POST /api/me/events` (validated and bounded) -> re-decide that customer only -> push over Server-Sent Events (`/api/me/stream`) if the decision changed.
- Batch: `src/batch.js` shards the customer id space over worker threads. **All 2,300,000 synthetic customers are scored in about 4 s on 8 cores** (`npm run bench`). A test proves parallel results equal serial results.
- Robustness: event validation and caps, bounded request bodies, SSE connection limits, one batch run at a time, graceful shutdown, `/api/healthz`.

## Testing
`npm test` runs 18 tests: opportunity detection per persona, guardrails, auth/IDOR/CSRF, batch equivalence, ingestion validation and a live SSE push. The UI was also driven end to end in headless Chromium.

## Known limits
Rules-based detection (an ML model is a planned upgrade), in-memory state, demo login, synthetic data only.
