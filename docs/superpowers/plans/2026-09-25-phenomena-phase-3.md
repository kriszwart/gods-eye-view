# Phenomena phase 3 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real data in the atlas: 3,000+ GEIPAN cases and the Blue Book index, behind a source-link allowlist, with visible attribution.

**Architecture:** Pipeline adapters normalise raw exports (already downloaded to local_data) into JSONL; build-dataset.mjs validates, redacts and writes public/anomalies/. The app side gains a shared safe-URL helper and a sources and credits panel. Sample hero cases stay until phase 4.

**Tech Stack:** Node pipeline (no new deps), Cesium app, node:test, Puppeteer gates.

**Spec:** anomaly-atlas-kit/docs/BUILD_PLAN.md phase 3, anomaly-atlas-kit/docs/DATA_PIPELINE.md, plus carried ruling: the source_url https allowlist leads the phase.

## Facts already established (do not re-derive)

- Raw data ON DISK (git-ignored): `anomaly-atlas-kit/pipeline/local_data/raw/geipan/cas_pub.csv` (3,382 cases incl. header) and `temoignages_pub.csv` (6,069 rows), converted from the August 2026 XLSX exports (kept beside them as .xlsx); `local_data/geonames/cities1000.txt` (GeoNames CC BY 4.0).
- Real GEIPAN header, verbatim: `ID Etude de Cas,Titre du Cas,Détails,Année,Identification,Classification,Code département,Date d'observation,Département,Document pour cas,Cas contenant des documents,Nouveau cas,Cas revisité,Latitude,Longitude,Phénomène,Région,Temoignage associé,Type de cas`.
- Classification values exactly A, B, C, D. 3,381 rows have non-empty Latitude and Longitude (GEIPAN pre-rounds to 0.1 degree for anonymisation, which exceeds the project's 1 km rule; record precisionKm 11). Dates come as `dd/mm/yyyy` with `--` for unknown day or month (`--/--/1937`). IDs look like `1937-01-01656`. `Phénomène` carries the explanation label; `Détails` a case URL fragment.
- NARA catalog API reachable without a key: `https://catalog.archives.gov/proxy/records/search?naId_is=597821&limit=1` returns the series record (Elasticsearch hit shape: body.hits.hits[]._source.record). Children of the series page via the same proxy with a parentNaId-style filter; the adapter expects `local_data/raw/bluebook/catalog-export-597821.json`.
- The GEIPAN export endpoints (for the DATA_SOURCES record): `https://geipan.fr/fr/cnes/export/cas` and `/fr/cnes/export/temoignages` (served as XLSX despite the historical CSV naming; a browser UA is required, the default curl UA gets 429).
- App-side pins that WILL break with real data: scripts/qa-anomalies.mjs asserts `getStats().count === 24` in several checks and searches for 'Phoenix'/'Stonehenge'; public/anomalies/stats.json drives the chronometer histogram; the search corpus fetches anomalies.v1.json. The dataset build replaces public/anomalies/*.json.

## Global constraints

- Gates green after every commit: npm run format:check, npm test, npm run check:boundaries, npm run build; pipeline suite (`cd anomaly-atlas-kit/pipeline && npm test`) where pipeline files change; browser gates against the dev server on :4173 (never start or kill it): qa-anomalies, qa-ancient-sites, qa-spotter as relevant.
- One commit per task. British English, no em dashes, sentence case. New app files into scripts/format-scope.json; new cross-package imports declared in scripts/package-boundaries.json.
- Data honesty: no witness names, addresses or verbatim narratives ship (redact.mjs is the net; GEIPAN summaries must be OUR neutral words or omitted, never the Détails text); every record keeps source, licence and attribution; nothing from local_data ships except through build-dataset.
- Nothing TMA-related in this phase.

---

### Task 1: safe source URL helper (ruled phase lead)

**Files:**
- Create: `src/sources/safeUrl.js`, `src/sources/safeUrl.test.mjs`
- Modify: `src/layers/anomalies/index.js` (dossier link), `src/layers/ancientSites/index.js` (dossier link), `scripts/package-boundaries.json` (co-own the module in the groups that own each importer: `reference-sources`, `anomalies`, `ancient-sites`, plus the two application groups if the checker asks), `scripts/format-scope.json`

**Interfaces:**
- `safeSourceUrl(value)` returns the string unchanged when it parses as a URL with protocol http: or https:, else null. Portable (no browser globals; use the URL constructor available in Node and browsers).

- [ ] **Step 1: failing tests** — accepts https and http URLs; rejects javascript:, data:, vbscript:, protocol-relative `//host`, bare strings, null, undefined, and a string with leading whitespace before javascript:.
- [ ] **Step 2: implement** (about 10 lines, JSDoc).
- [ ] **Step 3: wire both dossiers** — anomalies index.js (the `detail?.source_url` link) and ancientSites index.js (the `row.source_url` link): render the anchor only when `safeSourceUrl(...)` returns non-null, using the returned value.
- [ ] **Step 4: gates** and boundary co-ownership; qa-anomalies and qa-ancient-sites still green (both assert an 'Open record' link with curated data — all curated URLs are https so behaviour is unchanged).
- [ ] **Step 5: commit** `feat(atlas): source links pass an http and https allowlist`

---

### Task 2: GEIPAN adapter against the real export

**Files:**
- Modify: `anomaly-atlas-kit/pipeline/config/geipan-columns.json` (replace the guesses with the real names listed above, first in each array), `anomaly-atlas-kit/pipeline/src/adapters/geipan.mjs` (whatever `--inspect` reveals needs fixing: the date format `dd/mm/yyyy` with `--` placeholders, the 0.1 degree pre-rounding recorded as precisionKm 11, classification A to D to the shared status mapping, `Phénomène` as the explanation, the GEIPAN case URL built per BUILD_PLAN from `Détails` or the case id)
- Test: extend `anomaly-atlas-kit/pipeline/test/` with a geipan fixture test (5 synthetic rows in the REAL header shape covering: full date, `--/--/YYYY` date, missing coords, each classification, an accented commune)

The status mapping (data honesty, shared statuses from the app: explained, insufficient, unresolved, contested): A explained, B explained (probable), C insufficient, D unresolved. Record GEIPAN's own grade verbatim in the record's source grade field alongside.

- [ ] **Step 1:** run `node src/adapters/geipan.mjs --inspect` from the pipeline dir; paste its findings into the report.
- [ ] **Step 2:** fix config and adapter with TDD on the fixture (RED first).
- [ ] **Step 3:** full run: `npm run geipan` writes `local_data/normalised/geipan.jsonl`; require at least 3,000 records with coordinates and zero rows dropped for parse errors (dropped-for-no-coordinates is fine, log the count); spot-check 5 records by hand in the report (id, year, status, grade, coords, url).
- [ ] **Step 4:** pipeline suite green; NOTHING committed from local_data. Update the DATA_PIPELINE.md GEIPAN row (3,382 cases at August 2026; XLSX export; endpoints noted).
- [ ] **Step 5: commit** `feat(pipeline): parse the real GEIPAN export` (config, adapter, test, doc row only).

---

### Task 3: Blue Book catalogue download and index

**Files:**
- Create: `anomaly-atlas-kit/pipeline/src/adapters/nara-download.mjs` (paged fetch of all children of NAID 597821 through the catalog proxy verified above: browser UA, 2 second delay between pages, resume support by skipping already-saved pages, writes `local_data/raw/bluebook/catalog-export-597821.json`)
- Modify: `anomaly-atlas-kit/pipeline/package.json` (script `bluebook:download`), `anomaly-atlas-kit/pipeline/src/adapters/bluebook.mjs` (tighten field names from the keys the real export prints, per its own header comment)
- Test: fixture test for the index step (2 synthetic catalog records in the real hit shape)

- [ ] **Step 1:** probe one children page (limit 2) to learn the exact child-query parameter and record shape; paste into the report.
- [ ] **Step 2:** implement the downloader with TDD on a paging fixture; then run it for real (about 12,618 records; expect several minutes; log progress every 10 pages).
- [ ] **Step 3:** `npm run bluebook:index` over the real export; report the key names it prints and the tightening applied; index row count in the report.
- [ ] **Step 4:** pipeline suite green; raw stays local (git status clean).
- [ ] **Step 5: commit** `feat(pipeline): download and index the Blue Book catalogue`

---

### Task 4: build the real dataset

**Files:**
- Modify: `anomaly-atlas-kit/pipeline/src/build-dataset.mjs` only if the run surfaces defects (each fix TDD'd); `public/anomalies/*.json` (built outputs); `scripts/qa-anomalies.mjs` (count pins)

- [ ] **Step 1:** recon build-dataset.mjs: how it merges normalised sources with the sample hero cases; confirm heroes survive and GEIPAN records join. Then run from pipeline dir: `node src/build-dataset.mjs --out ../../public/anomalies`.
- [ ] **Step 2:** acceptance on the output: zero invalid records (the build's own validation), total count 3,000+ plus the sample heroes, stats.json byStatus covers the new statuses, grep proof no witness names: run `node src/lib/redact.mjs --check ../../public/anomalies/cases.v1.json` if the safety net offers a check mode, else grep the built cases for the Détails narrative markers and assert summaries are ours or absent.
- [ ] **Step 3:** app gates with the real dataset: qa-anomalies count pins change from 24 to a dynamic read (assert count >= 3000 and equals stats.json's count; keep the Phoenix search check, it is a sample hero and survives). Chronometer histogram, filter, tour, spotter, search must all stay green: run qa-anomalies, qa-ancient-sites, qa-spotter, qa-perf, test:track. Performance note: 3,400 points is well inside the earlier 5,000-observation perf envelope, but record qa-perf numbers in the report.
- [ ] **Step 4:** screenshots 1440 and 390 of the globe with real density (qa-shots/phase3/).
- [ ] **Step 5: commit** `feat(data): the atlas carries the real GEIPAN cases` (built public outputs, qa pin changes, any TDD'd build fixes).

---

### Task 5: sources and credits panel

**Files:**
- Modify: `DATA_SOURCES.md` (GEIPAN, NARA Blue Book, GeoNames entries with licences and the export endpoints), `src/layers/anomalies/index.js` (a 'Sources' chronometer action opening a `.uap-credits` plate), `src/ui/styles/anomaly-atlas.css` (the plate)
- The plate lists: GEIPAN (CNES) open data with its reuse notice line; Project Blue Book records, US National Archives (NAID 597821), public domain; GeoNames CC BY 4.0; sample hero cases pending verification (phase 4); The Modern Antiquarian reference links (ancient register). Every line sentence case, links through safeSourceUrl.

- [ ] **Step 1:** implement plate + action (mirror the legend plate's construction and z-order).
- [ ] **Step 2:** qa-anomalies check: open Sources, assert 'GEIPAN' and 'National Archives' appear; Escape closes.
- [ ] **Step 3:** gates; commit `feat(shell): sources and credits panel with real attribution`

---

### Task 6: phase record

- [ ] Full sweep (build, test, boundaries, test:track, qa-anomalies, qa-ancient-sites, qa-spotter, qa-perf), CHANGELOG entry "Phenomena phase 3" (counts: GEIPAN records placed, Blue Book indexed, acceptance results, what phase 4 still owes: extraction, hero verification), commit `docs(changelog): record phase 3`.

## Self-review notes

- Acceptance coverage: 3,000+ GEIPAN placed with grades mapped (T2/T4), zero invalid in the build (T4), attribution visible in-app (T5). Allowlist leads (T1) per ruling.
- The qa count-pin change (24 to dynamic) is called out in T4 so the gate suite survives the data swap.
- Blue Book EXTRACTION (record cards, Batch API) is phase 4 and out of scope; this phase ends at the index.
