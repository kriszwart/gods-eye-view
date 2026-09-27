# Live claims implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fourth register showing unverified public sighting claims live from Reddit and Bluesky, classified server-side by DeepSeek, placed on the globe with nearby historical cases and a stream ticker.

**Architecture:** A server provider polls both public feeds, gates posts through a DeepSeek classifier, geocodes and serves a bounded in-memory window at /api/claims; the live-claims layer (token 5, ion accent) renders pulsing points with link-out dossiers; nearby-case lookup and the ticker read existing layer data only.

**Tech Stack:** Node server providers, DeepSeek chat API, Cesium, node:test, Puppeteer gates.

**Spec:** docs/superpowers/specs/2026-09-27-live-claims-design.md (approved 27 September 2026; its Decisions section is binding).

## Facts established

- Provider pattern: server/providers/*.js composed by localProviderPlugins() in server/providers/local.js; env keys via .env loaded in server/standalone/vite.config.js; rate-limit convention GEV_RATELIMIT_*_PER_MIN in .env.example (see GEV_RATELIMIT_OPENAI_PER_MIN).
- Share token 5 is free (1-4 and a-z taken). LAYER_STATE_REGISTRY is alphabetical; two pinned tests count layers exactly (constructCatalog.test.mjs, layerState.test.mjs) and bump by one.
- Reddit public JSON: https://www.reddit.com/r/<sub>/new.json?limit=25 (browser-ish UA required; no key). Bluesky: https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=<terms>&limit=25 (public, no key). Both to be probe-verified in Task 1 recon.
- Geocoding: pipeline GeoNames cities1000 exists at anomaly-atlas-kit/pipeline/local_data/geonames/cities1000.txt (git-ignored, owner machine); the SERVER cannot depend on it in general. Task 1 recon decides: either a small bundled place index (top ~30k places extracted to a committed compact file, size-checked) or DeepSeek returns lat/lon directly when confident (it often can for towns) with a plausibility bound check. Prefer classifier-returned coordinates with sanity checks (|lat| <= 90, |lon| <= 180, place text non-null) to avoid new committed data; note the choice.
- Shape categories: the anomaly archetype categories live in the crafts manifest public/anomalies/crafts/ and records; classifier must emit one of those or null.
- Nearby cases: anomalies records ship in public/anomalies/anomalies.v1.json (columnar lat/lon/year/status; 3,405 rows); portable distance maths precedent in src/spotter/geometry.js (haversine). The claims layer must read the anomalies SOURCE data (fetch the public JSON via the anomalies source module), never mutate the anomalies layer.
- Standing rulings: no credibility scoring; link-out only, no verbatim text, no handles; age/recency may encode brightness, credibility never; British English, no em dashes; keys never committed.

## Global constraints

- Gates green per commit: npm run format:check, npm test, npm run check:boundaries, npm run build; browser gates on the controller-managed :4173 (never restart it). One commit per task. Sentence case, British English, no em dashes anywhere in added lines.
- Portable modules (records, source, model, nearby) import no Cesium and touch no browser globals. Boundary declarations follow the ancientSites precedent; format-scope additions after format:check passes.
- The server never persists post content to disk; the in-memory window is capped (48 h, 500 claims); post text is discarded after classification; stored claim fields are exactly: id (source-prefixed post id), url, source ('reddit'|'bluesky'), lat, lon, place, shape|null, when|null, fetchedAt.
- Without DEEPSEEK_API_KEY: /api/claims returns { claims: [], status: 'no-key' }; the register shows "Classifier key not set"; nothing errors; all gates pass keyless.
- Rate limits: Reddit and Bluesky polled at most every 2 minutes; DeepSeek calls capped via GEV_RATELIMIT_DEEPSEEK_PER_MIN (default 20); batch new posts per poll into as few classifier calls as practical.
- One-shot renders through the governor; the pulse animation uses the existing style/time conventions (czm_frameNumber or the layer's existing pulse precedent from anomalies arrival pulses), no continuous hold beyond what pulses already require; follow the anomalies layer's hold discipline.

---

### Task 1: server provider and classifier

**Files:**
- Create: `server/providers/claims.js` (+ `server/providers/claims.test.mjs` for the pure parts: feed row mapping, dedupe, window bounds, classifier response validation)
- Modify: `server/providers/local.js` (compose the plugin), `.env.example` (DEEPSEEK_API_KEY=, DEEPSEEK_MODEL=deepseek-chat, GEV_RATELIMIT_DEEPSEEK_PER_MIN=20)

- [ ] Recon: probe both feed endpoints with curl (browser UA), paste result shapes into the report; probe DeepSeek chat completions with the key IF present in .env (never print the key), else code to the documented API shape.
- [ ] TDD the pure functions: Reddit row -> candidate, Bluesky row -> candidate, dedupe by id, window eviction (48 h/500), classifier JSON validation (sighting/place/lat/lon/shape/when with sanity bounds).
- [ ] Endpoint /api/claims: { claims: [...], status: 'ok'|'no-key', unplaced: N }. Poll loop only while at least one client has fetched recently (idle backoff) or simplest compliant: poll on demand with a 2-minute cache. State the choice.
- [ ] Fixture mode for qa: env GEV_CLAIMS_FIXTURE=1 serves canned claims from a fixture module (committed, invented data clearly marked fictional, coordinates over open ocean or major cities, no real handles or ids).
- [ ] Commit `feat(server): live claims provider with the DeepSeek gate`

### Task 2: the live-claims layer

**Files:**
- Create: `src/layers/liveClaims/{records,source,model,index,rendering}.js` + records.test.mjs (portable: records validates/normalises claim rows; source fetches /api/claims; model holds ion palette and honesty strings)
- Modify: `src/app/constructCatalog.js` (factory), `src/app/layers/` wiring file (mirror anomalies wrapper), `src/data/layerState.js` ({ id: 'live-claims', token: '5' } in alphabetical position), the two pinned registry tests (+1 each), `scripts/package-boundaries.json`, `scripts/format-scope.json`, `src/ui/styles/anomaly-atlas.css` (ion register styles)
- Create: `scripts/qa-claims.mjs` (fixture mode: point appears, dossier links out with the honesty line, keyless status message, share token 5 restores)

- [ ] Layer contract complete (init/enable/disable/update/destroy/getAnalystRecords/getStats); pulsing ion points (age -> brightness, newest brightest; a comment states recency-not-credibility); picks through the pick registry (owner 'live-claims', ids 'claim:'); dossier plate reuses the atlas plate with the ion accent, fields place/shape/time/source/link plus the honesty line verbatim from the spec.
- [ ] Update interval ~2 minutes via the layer's updateInterval; update() returns true when loaded (the phase 1 lifecycle lesson).
- [ ] Commit `feat(claims): the live claims register`

### Task 3: nearby cases and stream mode

**Files:**
- Create: `src/layers/liveClaims/nearby.js` (+ test; portable: haversine over the anomalies columnar arrays, returns count and top 3 by distance within 50 km)
- Modify: `src/layers/liveClaims/index.js` (dossier gains the nearby block: "N historical cases within 50 km", top 3 clickable -> fly and open via the anomalies layer's focusCase channel if exposed, else fly only; stream ticker: chrono action or dock toggle showing a right-edge plate, newest first, click flies; reduced motion honoured), `scripts/qa-claims.mjs` (nearby count against the fixture claim placed near a known GEIPAN cluster; ticker shows fixture entries; reduced-motion check)

- [ ] Nearby reads the anomalies public JSON through a lazy fetch (cache once); never mutates the anomalies layer.
- [ ] Commit `feat(claims): nearby history and the stream ticker`

### Task 4: record

- [ ] Full gate sweep (root gates, pipeline untouched, test:track, qa-claims 3x, qa-anomalies, qa-ancient-sites, qa-spotter, qa-perf); CHANGELOG entry "Live claims register" (sources, link-out-only stance, no-scoring stance, ephemerality, token 5); commit `docs(changelog): record the live claims register`

## Self-review notes

- Honesty rules carried into UI strings verbatim; brightness encodes recency only.
- Keyless and fixture paths make every gate deterministic; no live network in qa.
- Ephemerality keeps the project out of social-content hosting; link-out respects both platforms' display norms.
