# Phenomena: product direction design

Approved 24 September 2026. Extends BUILD_PLAN.md; phase 0 and phase 1 are
complete and unaffected.

## What changes

The atlas becomes **Phenomena**: one instrument, three registers.

1. **Sky events** (exists): the anomalies layer, UAP and UFO reports on the
   1940 to 2026 chronometer. Unchanged internals: layer id `anomalies`,
   share token 3.
2. **Ancient sites** (new): documented enigmatic places on the ground,
   megaliths and worldwide ancient anomalies. Places, not events.
3. **Spotter** (new): a live sky-check instrument answering "what is over
   this spot right now" from the layers GEV already tracks.

## Naming and rebrand

- Product name: **Phenomena**. Tagline: "The unexplained, mapped".
- Product-facing strings only: `<title>` in index.html, the header wordmark,
  the boot loader text, welcome copy, and the "UAP mode" preset name, which
  becomes "Phenomena mode". CLAUDE.md and the kit docs say Phenomena.
- Internal identifiers do not move: repo name, layer ids, share tokens,
  file paths, test names. Renaming code buys nothing and risks the suite.

## Register differentiation

| | Sky events | Ancient sites |
| --- | --- | --- |
| Nature | Events at a moment | Places across millennia |
| Time | Chronometer 1940 to 2026 | Ignores the year dial (deep-time dial deferred) |
| Motion | Craft loops, arrival pulses | Static, grounded markers |
| Colour | Magenta, violet, ion, amber | Gold accent |
| Glyphs | Craft archetypes | Stone forms (trilith, circle, mound, geoglyph) |
| Claims | Source grade per record | Documented archaeology, debate stated |

New design token, both themes:

| Token | Dark (void) | Light (clean room) |
| --- | --- | --- |
| Gold (deep time) | #D8B36A | #8A6A2F |

Honesty rule for ancient sites: every record is documented archaeology.
The record states what is genuinely debated (method, purpose, dating),
never speculative origin claims. No "ancient alien" framing anywhere.

## Ancient sites layer

- Layer id `ancient-sites`, share token 4 (free; a to z and 1 to 3 taken).
  Registry entry sorts between `alpr-cameras` and `anomalies`.
- Standard GEV layer contract; portable modules (`records.js`, `source.js`,
  `model.js`) with no Cesium and no browser globals, mirroring anomalies.
- Data in `public/ancient-sites/`: `sites.v1.json` plus `glyphs/`.
- Curated sample of about 20 sites first (Gobekli Tepe, Stonehenge, Carnac,
  Nabta Playa, Sacsayhuaman, Yonaguni, Newgrange, Avebury, Puma Punku,
  Nazca lines, Ggantija, Baalbek trilithon, Derinkuyu, Serpent Mound,
  Poverty Point, Callanish, Rujm el-Hiri, Mohenjo-daro, Great Zimbabwe,
  Plain of Jars). Full sweep from Wikidata (CC0) and UNESCO comes later.
- Schema per site: `id`, `name`, `lat`, `lon`, `country`, `period` (label,
  for example "c. 9500 BCE"), `period_start_bce`, `type` (megalith,
  geoglyph, temple, earthwork, underwater, settlement), `summary` (neutral,
  280 characters or fewer), `debated` (what scholars actually debate),
  `unesco` (reference or null), `source_url`, `attribution`, `glyph`.
- Sites are public monuments: exact coordinates are fine, no rounding.
- Rendering: gold points with glyph billboards at close range, ambient
  labels through the overlay host, picks through the pick registry
  (owner `ancient-sites`, ids `ancient:`), one-shot renders only, no
  continuous hold. Dossier reuses the anomaly dossier plate with the
  gold register and the debate line.

## Spotter instrument

Question it answers: "I see something over this place, now; what is it?"

- A Spotter panel: pick a place by map click or geolocation; radius
  default 150 km; now-mode only. Live feeds cannot answer about the past;
  the panel says so plainly.
- Candidate sources, all already in GEV: flights (OpenSky and local ADS-B),
  military aircraft, satellite passes and Starlink trains from the
  satellites layer, recent rocket launches, lightning cells. Read-only:
  the spotter never mutates layer state.
- Output: ranked candidates with type, label, bearing, distance, altitude
  and a one-line "why this ranks here". Honest fallback when nothing
  matches: "No match in tracked sources. Tracked sources do not cover
  everything."
- Boundaries: a portable core `src/spotter/` (bearing and distance
  geometry, candidate ranking; no Cesium, no globals) and an app wiring
  module `src/app/spotter.js` that reads layer modules and owns the panel.
- Voice ("what did I just see") joins in the voice phase.

## Phase plan (replaces phase 2; later phases unchanged)

- **Phase 2a: Phenomena shell.** Rebrand strings; Spectral, Radar and
  Infrared registered in STYLES with presets (Spectral default for the
  atlas); design-system pass (hairline plates, registration corners, one
  accent per register, sentence case); "Phenomena mode" preset; legend.
  Acceptance: existing phase 2 acceptance list plus the name appears in
  title, header and loader; screenshots 1440 and 390 px.
- **Phase 2b: ancient sites sample.** Layer, token 4, curated sample,
  glyphs, dossier, labels, boundary declarations, registry test bumps.
  Acceptance: toggle shows the sites; year dial does not affect them;
  clicking opens a dossier with the debate line and source link; share
  link with token 4 restores; gates green; extended qa gate passes.
- **Phase 2c: spotter MVP.** Portable core with unit tests, panel, wiring
  to live layers, honest empty states. Acceptance: with fixture feeds a
  known aircraft ranks first with correct bearing and distance; empty sky
  yields the honest fallback; gates green; qa-spotter gate passes.
- Phases 3 to 5 (real UAP data) proceed as written in BUILD_PLAN.md.
- **Phase 5b: ancient sites sweep.** Wikidata CC0 plus UNESCO extraction
  through the pipeline, deep-time dial mode for the chronometer.

## Verification

Per repo rules every commit keeps npm run build, npm test,
npm run check:boundaries green, with npm run test:track and the named
qa gates at milestones. New and extended gates: scripts/qa-anomalies.mjs
grows the rebrand assertions; a qa check for ancient sites (token 4
restore, dial decoupling) and one for the spotter (fixture feeds, ranking)
join it. Visual changes get Chrome screenshots at 1440 and 390 px.
