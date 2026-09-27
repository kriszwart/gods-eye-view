# Live claims register: design

Approved in chat on 27 September 2026. Fourth Phenomena register: what people are reporting right now, placed against what was reported before.

## Decisions

- Sources: Reddit public JSON (r/UFOs, r/HighStrangeness, r/aliens) and Bluesky public search. Free, keyless.
- Classifier: DeepSeek chat API, server-side only, `DEEPSEEK_API_KEY` in .env, model via `DEEPSEEK_MODEL` (default deepseek-chat).
- Link-out only: the map and dossier carry extracted structure (place, shape category, rough time, source name) and one link to the original post. No verbatim post text and no author handles are stored, shown or shipped; post text goes to the classifier and is discarded.
- No credibility scoring anywhere (standing ruling). The register's honesty line: "Unverified public claims, shown as posted; nothing here is evaluated or endorsed."
- Ephemeral: bounded in-memory window on the server (48 hours, cap 500 claims), no disk persistence. A restart empties the register; that is by design.
- Keyless boot unaffected: without DEEPSEEK_API_KEY the register stays empty with the message "Classifier key not set" and never errors.

## Components

1. Server provider `server/providers/claims.js`: polls both sources every ~2 minutes, dedupes by post id, drops non-sighting posts (classifier gate), geocodes place text against bundled GeoNames data, keeps the bounded window, serves `/api/claims` to the app. Polite: browser-ish UA, per-source rate limits following the `GEV_RATELIMIT_*` convention.
2. Classifier call: one DeepSeek request per new post (batched where possible): { sighting: bool, place: string|null, shape: one of the existing archetype categories|null, when: ISO-ish|null }. Unplaceable claims are dropped and counted; the count is honest UI ("N claims had no placeable location").
3. Layer `live-claims`, share token 5, ion accent #3FE0FF, standard GEV layer contract, portable records/source/model (no Cesium, no browser globals). Pulsing ion points, newest brightest (age encodes recency, never credibility). Dossier: place, shape, time, source, link out, the honesty line.
4. Nearby cases: the claim dossier lists historical cases within 50 km from the anomalies records ("3 GEIPAN cases within 50 km"), clickable to fly and open. Portable distance maths shared with or mirroring src/spotter/geometry.
5. Stream mode: a chrono action toggling a right-edge ticker plate; newest claims slide in (reduced motion: no animation, plain list); clicking flies to the point. Read-only over layer data.

## Boundaries

Portable modules `src/layers/liveClaims/{records,source,model,nearby}.js`; app wiring in the layer index and constructCatalog; server provider in server/providers. Registry entry sorts alphabetically (`live-claims` between `lightning` and whatever follows, wherever alphabetical order puts it); the two pinned registry tests bump by one.

## Verification

Fixture feeds (canned Reddit and Bluesky JSON, canned classifier output) drive scripts/qa-claims.mjs: a fixture post appears as an ion point; its dossier links out and shows the honesty line; nearby-case count correct against the bundled anomalies dataset; empty feed yields the honest fallback; keyless boot clean. Unit tests for dedupe, window bounds, nearby maths. Gates green per commit; screenshots 1440 and 390.
