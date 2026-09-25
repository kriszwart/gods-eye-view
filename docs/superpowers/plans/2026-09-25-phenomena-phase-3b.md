# Phenomena phase 3b implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Free-tier enrichment: Commons photos and Wikipedia links for the ancient sites, Wikipedia links for the hero UAP cases, and the already-collected geipan.fr record links surfaced in every real case dossier.

**Architecture:** Enrichment is build-time and committed, never runtime-fetched: a pipeline script queries Wikidata and Commons once and the results land in the shipped JSON. Dossiers render an image (hotlinked from upload.wikimedia.org with per-image attribution) and extra links, all through safeSourceUrl. No LLM anywhere.

**Tech Stack:** Node pipeline, Wikidata/Commons public APIs, Cesium app, Puppeteer gates.

**Spec:** user direction (images and details, wiki links to save costs) plus the phase 3 ruling that real GEIPAN cases get their geipan.fr links surfaced.

## Facts established

- The 20 ancient sites live in public/ancient-sites/sites.v1.json (schema ancient.sites.v1); every site has a Wikipedia article and a Wikidata item with a P18 Commons image.
- Wikidata API: https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q<id>&props=claims|sitelinks&format=json gives P18 (image filename) and enwiki sitelink. Commons imageinfo API (action=query&titles=File:<name>&prop=imageinfo&iiprop=extmetadata) gives licence short name and artist. Thumbnail URL shape: https://commons.wikimedia.org/wiki/Special:FilePath/<FILENAME>?width=640 (redirects to upload.wikimedia.org).
- The 24 hero cases sit in anomaly-atlas-kit/pipeline/sample/hero-cases.sample.json and flow through build-dataset into cases.v1.json; the anomalies dossier reads detail via source.getCases() from cases.v1.json.
- toCases (anomaly-atlas-kit/pipeline/src/lib/records.mjs:114) filters to heroes only, so the 3,381 GEIPAN source_url values never reach the app today; the adapter collects them (https://www.geipan.fr/fr/cas/<id>).
- Dossier link guard: safeSourceUrl (src/sources/safeUrl.js). qa gates: qa-anomalies (22 checks), qa-ancient-sites (11 checks), dynamic count pins.

## Global constraints

- Gates green per commit: npm run format:check, npm test, npm run check:boundaries, npm run build; pipeline suite where pipeline files change; browser gates on the running :4173 server.
- One commit per task. British English, no em dashes, sentence case. All external links and image URLs through safeSourceUrl (extend it or add a sibling guard for upload.wikimedia.org/commons image sources if needed — images must be https and host-checked against upload.wikimedia.org or commons.wikimedia.org).
- Licence honesty: every rendered Commons image carries its licence short name and author in the dossier; enrichment stores both. No image without attribution data ships.
- Enrichment runs offline-safe: the app never fetches Wikidata or Commons at runtime except the <img> hotlink itself; a failed image load degrades to alt text.

---

### Task 1: Wikidata enrichment for the ancient sites

**Files:**
- Create: `anomaly-atlas-kit/pipeline/src/adapters/wikidata-enrich.mjs` (+ fixture test), `anomaly-atlas-kit/pipeline/config/ancient-wikidata.json` (site id -> Wikidata QID map, hand-curated, 20 entries)
- Modify: `public/ancient-sites/sites.v1.json` (new per-site fields: `image` (Special:FilePath URL with width=640), `image_attribution` ({ licence, author }), `wikipedia` (enwiki URL)), `anomaly-atlas-kit/pipeline/test/ancient-sample.test.mjs` (schema grows: the three new fields required, image null allowed only with a report note), `anomaly-atlas-kit/pipeline/package.json` (script `ancient:enrich`)

- [ ] **Step 1:** curate the QID map (verify each QID by label match via one batched wbgetentities call; put the verification output in the report).
- [ ] **Step 2:** TDD the enrichment script against a fixture (one entity JSON + one imageinfo JSON): emits image URL, licence short name, artist (strip HTML from the artist value; textContent semantics), enwiki URL. Then run for real (batch of 20, one polite call each API, 1 s delay) and write the fields into sites.v1.json in place.
- [ ] **Step 3:** schema test extended and green; spot-check 3 sites' image URLs load (curl -I 200/302) and licences are CC or public domain; any site whose P18 is missing or whose licence is not free stays image: null with the reason in the report.
- [ ] **Step 4:** gates; commit `feat(ancient): Commons images and Wikipedia links from Wikidata`

---

### Task 2: ancient dossier renders the photo and links

**Files:**
- Modify: `src/layers/ancientSites/index.js` (dossier: img above the dl when `image` passes the https+host guard, alt = site name, loading lazy; attribution line "Photo: <author>, <licence>" below it; 'Wikipedia' link beside 'Open record', both via safeSourceUrl), `src/sources/safeUrl.js` (add `safeImageUrl(value)` allowing https only AND host upload.wikimedia.org or commons.wikimedia.org; TDD in safeUrl.test.mjs), `src/ui/styles/anomaly-atlas.css` (image sizing: max-width 100 percent, max-height ~180px, object-fit cover)
- Modify: `scripts/qa-ancient-sites.mjs` (check: the Gobekli Tepe dossier contains an img whose src host is upload.wikimedia.org or commons.wikimedia.org, an attribution line, and a Wikipedia link)

- [ ] TDD safeImageUrl; wire; gates; qa 3 consecutive clean runs; screenshots (dossier with photo, 1440 and 390) into qa-shots/phase3b/.
- [ ] Commit `feat(ancient): dossiers show the site photograph with attribution`

---

### Task 3: hero cases link to Wikipedia

**Files:**
- Modify: `anomaly-atlas-kit/pipeline/sample/hero-cases.sample.json` (new `wikipedia` field per hero; curate the 24 URLs; a hero without a solid article keeps null), `anomaly-atlas-kit/pipeline/src/lib/records.mjs` (carry the field through toCases), `public/anomalies/cases.v1.json` (+ anomalies.v1.json/stats.json only if the rebuild touches them; rebuild via `node src/build-dataset.mjs --out ../../public/anomalies`), `src/layers/anomalies/index.js` (dossier renders 'Wikipedia' link when present, via safeSourceUrl), `scripts/qa-anomalies.mjs` (check: the Phoenix lights dossier carries a Wikipedia link)

- [ ] Curate URLs (verify each with curl -I 200; list in the report); pipeline test asserting the field survives toCases; rebuild; wire; gates + qa; commit `feat(anomalies): hero dossiers link to Wikipedia`

---

### Task 4: every real case links to its GEIPAN record

**Files:**
- Modify: `anomaly-atlas-kit/pipeline/src/lib/records.mjs` (toCases emits a compact entry for EVERY record: heroes keep their full shape; non-heroes emit { id, source_url } only — nothing textual), `anomaly-atlas-kit/pipeline/test/` (test: non-hero entries are exactly two keys), `public/anomalies/cases.v1.json` (rebuild; expect roughly +350 KB), `scripts/qa-anomalies.mjs` (check: search a GEIPAN case via the year query '1981', open its dossier, assert an 'Open record' link with host www.geipan.fr)

- [ ] TDD; rebuild; verify the dossier fetch path handles the larger cases file (lazy load already); check the built size and note it; gates + full qa set; commit `feat(anomalies): real cases link to their GEIPAN records`

---

### Task 5: phase record

- [ ] Full sweep (root gates, pipeline suite, test:track, qa-anomalies, qa-ancient-sites, qa-spotter, qa-perf); CHANGELOG entry "Phenomena phase 3b" (what shipped, image licensing approach, cases file growth, the free-tier decision, cryptids register noted as a future direction); commit `docs(changelog): record phase 3b`

## Self-review notes

- All enrichment is committed build output; runtime touches only the img hotlink, guarded by safeImageUrl, degrading to alt text offline.
- Licence honesty carried per image; non-free or missing images stay null rather than shipping unattributed.
- Task order: 1 before 2 (data before render), 3 and 4 rebuild the same outputs — sequential, 4 after 3 so one rebuild chain each.
