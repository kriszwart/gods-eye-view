# Phenomena phase 5b implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** All the sites: a Wikidata CC0 worldwide ancient-sites sweep as the public dataset, a local-only Modern Antiquarian layer for the owner's machine, and the deep-time dial so millennia become navigable.

**Architecture:** The sweep is a pipeline adapter querying Wikidata's SPARQL endpoint for megalithic and ancient monument classes with coordinates, normalised into a versioned public dataset that replaces the 20-site curated sample (which becomes the hero tier within it). The TMA layer is a dev-mode source reading local_data (git-ignored) behind an env flag, never bundled. The deep-time dial extends the chronometer with a second scale (10,000 BCE to 1500 CE, log-compressed) that activates when the ancient layer is soloed.

**Tech Stack:** Wikidata SPARQL (CC0), Node pipeline, Cesium, node:test, Puppeteer gates.

## Facts established

- Curated sample: public/ancient-sites/sites.v1.json (20 sites, images, wikipedia, per-site attribution); layer id 'ancient-sites', token 4; renderer draws gold points, overlay labels, dossiers with photos.
- TMA normalised rows on disk: anomaly-atlas-kit/pipeline/local_data/normalised/tma-sites.jsonl (17,392: name, category, lat, lon, url). Licence: local only, per-site links allowed. Ruling: local-only layer, env-flagged, never committed or served publicly.
- Wikidata SPARQL: https://query.wikidata.org/sparql (GET with query param, Accept application/sparql-results+json, browser-ish UA, be polite: paginate with LIMIT/OFFSET, 2 s between pages). Relevant classes (instance of / subclass of, P31/P279*): megalith Q164323, dolmen Q152056, menhir Q189299, stone circle Q1329373, tumulus Q34023, hillfort Q744099, geoglyph Q1339299, archaeological site Q839954 (broad — constrain by heritage designation or inception before 1500 where present). Coordinate P625, image P18, country P17, inception P571, enwiki sitelink.
- Chronometer: src/layers/anomalies/chronometer.js (1940-2026 linear); the ancient layer ignores it today. period_start_bce convention: positive BCE, negative CE, null unknown.
- Performance: phase 6 planned a GPU point cloud if frame time suffers; the ancient sweep may reach tens of thousands of points — the existing PointPrimitiveCollection handled 5,000 observations in perf tests; measure before optimising.

## Global constraints

- Gates green per commit (root suite, boundaries, build; pipeline suite where touched; browser gates on :4173). One commit per task. British English, no em dashes, sentence case.
- Data honesty: every swept record keeps source (wikidata QID URL), licence (CC0 statement), country, type; documented-archaeology framing; no speculative claims; images only via the free-licence filter from phase 3b's enrichment module (reuse isFreeLicence/cleanAuthor).
- The TMA layer NEVER ships: env flag PHENOMENA_LOCAL_TMA=1 gates its registration; the dataset file stays in local_data; CI and default dev run without it; a qa check proves the layer is absent when the flag is unset.
- The curated 20 keep their hand-written summaries, debates and photos as the 'hero' tier; swept rows get compact fields only.

---

### Task 1: Wikidata sweep adapter

**Files:**
- Create: `anomaly-atlas-kit/pipeline/src/adapters/wikidata-sweep.mjs` (+ fixture tests), config `anomaly-atlas-kit/pipeline/config/ancient-sweep.json` (class QIDs, paging size, type mapping to the existing glyph taxonomy)
- Modify: pipeline package.json (script `ancient:sweep`)

- [ ] Recon: run ONE probe SPARQL query (LIMIT 5) per class group; paste result shapes into the report; settle the final query (dedupe by QID; require P625; optional P18/P571/P17/enwiki).
- [ ] TDD the row mapper (SPARQL JSON binding -> { qid, name, lat, lon, type, country?, inception?, image_file?, wikipedia? }); paging with resume (per-page JSONL in local_data/raw/wikidata/); polite pacing.
- [ ] Full run; report counts per class and total (expect thousands); dedupe stats. Output local_data/normalised/ancient-sweep.jsonl. Nothing committed from local_data.
- [ ] Commit `feat(pipeline): sweep ancient sites from Wikidata`

### Task 2: build the public sweep dataset

**Files:**
- Create: `anomaly-atlas-kit/pipeline/src/build-ancient.mjs` (merges the curated 20 as hero tier + sweep rows compact; validates; writes public/ancient-sites/sites.v2.json: { schema: 'ancient.sites.v2', count, heroes: [...v1 shape...], sites: columnar arrays id/qid, lat, lon, type, bce (period_start_bce or null), country, wiki flag })
- Modify: schema tests; public/ancient-sites/sites.v2.json committed (size target under 3 MB; if over, trim optional columns and note)

- [ ] TDD; build; validate zero invalid; report size and count; keep sites.v1.json until the app flips (next task) then delete it in that task.
- [ ] Commit `feat(ancient): the public sweep dataset with the curated hero tier`

### Task 3: the layer reads v2 (heroes + sweep)

**Files:**
- Modify: `src/layers/ancientSites/{records,source,model,rendering,index}.js` (v2 decode: heroes keep dossier richness; sweep points render as smaller gold points with QID dossiers: name, type, country, era, wikidata link, wikipedia when flagged; labels stay hero-only; search corpus gains sweep names via the shared channel), delete public/ancient-sites/sites.v1.json, qa-ancient-sites updated (count check becomes dynamic vs the v2 count; heroes still photographed; a sweep site dossier opens)
- Perf check: qa-perf green; measure frame cost with the sweep on and record numbers; if degraded, cap rendered sweep points by camera distance (LOD note, not full GPU work).

- [ ] Commit `feat(ancient): the atlas carries the worldwide sweep`

### Task 4: local-only TMA layer

**Files:**
- Create: `src/layers/ancientSites/tmaLocal.js` (dev-only source reading /local-tma/tma-sites.jsonl served ONLY when the env flag is set), server/dev wiring to serve the file from local_data when PHENOMENA_LOCAL_TMA=1 (recon how the dev server exposes extra static paths; vite config env-gated alias or middleware), registration gated on import.meta.env.PHENOMENA_LOCAL_TMA (build-time define so production bundles exclude it entirely)
- qa: a check that the layer is ABSENT without the flag (run in the normal gate); a manual note for the owner on enabling it.

- [ ] Verify with the flag on locally (screenshot for the report: Britain dense with TMA points), then confirm the committed bundle contains no TMA strings (grep dist).
- [ ] Commit `feat(ancient): local-only Modern Antiquarian layer behind an env flag`

### Task 5: deep-time dial

**Files:**
- Modify: `src/layers/anomalies/chronometer.js` (a second scale mode: 10,000 BCE to 1500 CE, log-compressed toward the present; activates when the ancient layer is on and the anomalies layer is off — recon the cleanest signal; the dial filters sweep points by bce era band), `src/layers/ancientSites/*` (era filtering hooks mirroring the sky layer's inWindow), docs (period_start_bce sign convention documented per the phase 3 ruling), qa checks (deep-time mode engages; era band filters counts; sky mode unaffected)

- [ ] Commit `feat(ancient): the deep-time dial`

### Task 6: phase record

- [ ] Full sweep of every gate; CHANGELOG "Phenomena phase 5b" (public sweep count, CC0 licensing, hero tier, local TMA position restated, deep-time dial, perf numbers); commit `docs(changelog): record phase 5b`.

## Self-review notes

- Licence split holds: CC0 sweep public, TMA local-only and build-excluded, curated tier keeps its attributions.
- Deep-time dial scoped to a second scale on the existing chronometer rather than a new widget; log compression stated.
- Perf measured before optimised; the phase 6 GPU path stays reserved.
