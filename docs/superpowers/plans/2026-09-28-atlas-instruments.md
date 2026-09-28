# Atlas instruments implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three instrument upgrades: an observatory stats plate, documented report-wave landmarks on the chronometer, and search that reaches every register's records.

**Architecture:** The stats plate reads shipped stats and live getStats through the shell; landmarks are a small curated, sourced dataset rendered as corona ticks with note plates; search grows lazy indices over the GEIPAN columnar records and the ancient sweep names, composed into the existing portable searchCases corpus.

**Tech Stack:** Vanilla ES modules, SVG (chronometer), node:test, Puppeteer gates.

**Spec:** user-approved design in chat, 28 September 2026 (items 1 observatory stats, 2 dial landmarks, 3 search everything; the mobile pass deliberately deferred to its own branch).

## Facts established

- public/anomalies/stats.json: { generatedAt, count: 3405, range: [1937, 2026], bySource: { sample: 24, geipan: 3381 }, byStatus: { explained: 2264, unresolved: 116, contested: 10, insufficient: 1015 }, review: 32 }.
- Ancient dataset: sites.v2.json count 81,313, countries[] interned (85), types[] (5); licence block present. Live claims getStats exists (ephemeral counts).
- Chronometer: src/layers/anomalies/chronometer.js renders SVG (g.ticks at ~line 73, tickValues() ~109); scales are pluggable ({ toT, fromT, values, isMajor, format, step, pageStep, histogram }); yearly histogram is the corona. Deep-time scale coexists; landmarks are a SKY-scale feature only.
- Search: src/app/caseSearch.js is portable/pure (searchCases(query, records), RESULT_CAP 8, rank tiers title/field/year); corpus built in src/ui/layerBindings.js:237 _buildCaseSearchRecords (hero-only today by ledgered deferral). Records shape: { id, register: 'sky'|'ancient', title, year, craft, type, period, country }.
- GEIPAN rows: columnar in anomalies.v1.json (lat/lon/year/status per row; ids map to geipan.fr case links; no witness text). Place names: NOT in the columnar data (rounded coords only): a GEIPAN case's searchable fields are id, year, status, source. Honesty: no invented place names.
- Ancient sweep names: columnar sites.name array (81,293 strings) with typeName/countryName accessors (records.js).
- Result focus: layerBindings _focusCaseSearchResult flies and opens via module lookup (focusCase/focusSite).
- Overlay/plate idioms: .uap-legend/.uap-dossier plate family in anomaly-atlas.css; chrono.addAction for dial-adjacent buttons.

## Global constraints

- Gates green per commit: npm run format:check, npm test, npm run check:boundaries, npm run build; browser gates on the controller-managed :4173 (never restart; controller handles stale-cache 504s). One commit per task. British English, sentence case, no em dashes in added lines.
- Honesty: every stats figure comes from shipped data or live getStats, never invented; landmark waves are documented report waves with a source link each, worded as "reported wave", never as fact claims about craft; no credibility scoring anywhere; search never fabricates fields (GEIPAN entries surface as "GEIPAN case <id>, <year>", no invented places).
- Portable modules stay portable (caseSearch stays pure; new landmark data module portable; index builders portable over the columnar arrays). layerState.js untouched. Bounded: search indices built lazily ONCE per session, capped memory (strings already in memory via the fetched datasets; the index references, never copies, where possible).
- Reduced motion respected in anything that animates; AA contrast; usable at 1440 and 390 (the deep mobile pass is a later branch, but nothing new may regress 390 further).

---

### Task 1: observatory stats plate

**Files:**
- Create: `src/app/observatory.js` (assembles the readout model from stats.json fetch + each register's getStats via the shell channel; portable maths split into `src/app/observatoryModel.js` if any non-trivial shaping emerges, with unit tests)
- Modify: `src/ui/layerBindings.js` (a dock/tray toggle "Observatory" opening the plate; lifecycle like the spotter plate: Escape closes, layer-independent), `src/ui/styles/anomaly-atlas.css`, `scripts/qa-anomalies.mjs` (plate opens; the sky count equals the fetched stats.json count; status split rows sum to the count; ancient count equals the v2 dataset count; Escape closes; no page errors)

- [ ] Content: sky reports (count, by status, by source, range), ancient sites (count, types, countries covered), live claims (current window count or the keyless line), decade histogram (small SVG bars from the columnar year array, computed client-side, cached). Every number traceable to data; the plate carries "Counts reflect the shipped datasets and the live window".
- [ ] Commit `feat(atlas): the observatory readout`

### Task 2: dial landmarks

**Files:**
- Create: `src/layers/anomalies/waves.js` (portable curated dataset: ~6 documented report waves, 1947 United States wave, 1952 Washington DC flap, 1954 French wave, 1965 South American wave, 1989 Belgian wave, 2017 Nimitz disclosure reporting, each { year, label, note (neutral, sourced wording, 160 chars max), source_url }; unit test validates shape and https URLs)
- Modify: `src/layers/anomalies/chronometer.js` (sky scale only: landmark ticks on the corona at those years, small distinct marks, gold or ion accent, aria-labelled; hovering or focusing shows the note plate with the label, note and source link through safeSourceUrl; keyboard reachable; deep-time scale unaffected), `src/ui/styles/anomaly-atlas.css`, `scripts/qa-anomalies.mjs` (landmark tick present at 1952; its note plate opens with a source link; deep-time dial shows no landmarks; existing dial checks keep passing)

- [ ] Wording rule: every note says reports/reported ("a wave of reports over..."), never asserts objects were present; the reviewer verdicts each note's wording.
- [ ] Commit `feat(anomalies): documented waves mark the dial`

### Task 3: search everything, record

**Files:**
- Modify: `src/ui/layerBindings.js` (_buildCaseSearchRecords grows two lazy indices, built once and cached: GEIPAN cases from the anomalies columnar data as { id, register: 'sky', title: 'GEIPAN case <id>', year, craft: null, country: 'France' }, and ancient sweep names from the v2 columnar arrays as { id: 'ancient:sweep:<i>', register: 'ancient', title: name, type, country }; heroes keep their richer entries and outrank on ties by input order), `src/app/caseSearch.js` ONLY if ranking needs a tweak for 81k-row inputs (measure: searchCases is O(n) per keystroke over ~85k records: if a keystroke exceeds ~10 ms, add a portable prefix-bucket index in caseSearch with unit tests; state the measurement), focus path handles sweep results (fly to lat/lon and open the sweep dossier via the ancient module's existing channel)
- Modify: `scripts/qa-anomalies.mjs` or the search qa home (search "Carnac" finds a sweep site and focuses it; search a GEIPAN id or "1954" finds a case; results stay capped at 8; typing latency sanity), CHANGELOG.md (entry "Atlas instruments" covering all three tasks)

- [ ] Measure search latency over the full corpus before optimising; state numbers.
- [ ] Commit `feat(atlas): search reaches every register` then `docs(changelog): record the atlas instruments`

## Self-review notes

- All three tasks read shipped or live data; nothing invented, every landmark sourced.
- Search index references existing arrays; memory bound is the already-loaded datasets.
- Landmarks live in the sky scale only, keeping the deep-time register clean.
