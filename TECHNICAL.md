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

## Front end (style guide implementation)
Vanilla JS, no build step, strict CSP (no inline scripts or styles, no `innerHTML`).
- `public/style.css`: design tokens from the style guide (KBC blue `#00A6EB` only on primary buttons and the Kate icon).
- `public/ui.js`: DOM helpers, inline SVG icons, the Kate icon, generated mock merchant logos (initials on a stable colour, never the real trademarks).
- `public/cards.js`: the action card component. Payload contract `{ event_id, card_type, merchant, amount, title, description, primary_cta, secondary_cta }`. State flow per card: triggered (slides up) -> processing (spinner, 800 ms) -> success (green check, "Done", fades out after 2 s). "Not now" hides a card for the session. One flow per action id (`FLOWS`), all simulated.
- `public/app.js`: login, idle home screen (balance and activity from `GET /api/me/home`), settings drawer, presenter controls, advisor view.
- Presenter / "Wizard of Oz" controls: `P` toggles presenter mode (cards stay hidden until triggered), `1`-`9` triggers the n-th card, `0` or `Esc` returns to the idle home screen, `R` reloads. Open the app with `?presenter=1` to start in presenter mode.

### Look and feel (verified)
- Typography: Inter, self-hosted in `public/fonts/` (SIL Open Font License), so text renders identically on every device. Card headings 18px/600, body 15px/400/1.5, buttons 16px/600.
- Phone frame: on screens at least 900x640 the customer app is shown inside a phone frame (status bar, home indicator) so a screencast looks like a native app. The advisor view stays full width. Add `?frame=0` to turn the frame off.
- Long card descriptions are clamped to 4 lines with "Read more", to keep cards brief.
- Accessibility: touch targets are at least 44px, keyboard focus ring is visible, `prefers-reduced-motion` is respected, and the canvas does not change in dark mode. Known trade-off: the guide's own colours give 4.0:1 for muted text and 2.7:1 for white on #00A6EB, below WCAG AA for small text.
- Automated checks used during development: computed-style audit against every number in the style guide, plus a sweep of login/home/card/drawer/advisor at 320, 360, 390, 768, 1280 and 1440px for fonts, palette, use of blue, touch targets, overflow and image loading.

### AI wording layer (Google Cloud)
Off unless configured (`KATE_AI=on` plus project, location and model). Gemini on Vertex AI only rewords a card's text; what Kate suggests, every number and every guardrail come from code. Output is validated (numbers must come from the facts, no promises or advice) and falls back to the template on any failure. Cards carry `aiWorded`, and the UI shows an "AI wording" label when it is true. Details: `docs/GOOGLE_CLOUD.md`, deploy steps: `deploy/README.md`, live check: `npm run ai:check`.
