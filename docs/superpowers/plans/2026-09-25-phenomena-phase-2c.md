# Phenomena phase 2c implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the spotter MVP plus three user-directed improvements: reachable preset buttons, Spectral applied by Phenomena mode, and case search across both registers.

**Architecture:** The spotter follows the register pattern: a portable core (`src/spotter/`, no Cesium, unit tested) and app wiring that reads live layer records read-only. Search is a pure matcher over both layers' analyst records, surfaced in the chronometer panel. Tray and mode fixes are small seam repairs.

**Tech Stack:** Vanilla ES modules, Cesium, node:test, Puppeteer qa harnesses.

**Spec:** anomaly-atlas-kit/docs/PHENOMENA_DESIGN.md (spotter section) plus the final-review ledger rulings carried below.

## Global constraints

- Gates green after every commit: `npm run format:check`, `npm test`, `npm run check:boundaries`, `npm run build`. Browser gates against the dev server already on :4173 (never start or kill it; BLOCKED if down): `node scripts/qa-anomalies.mjs`, `node scripts/qa-ancient-sites.mjs`, plus new gates as they land. qa camera moves always call `window.__godsEyeView.viewer.camera.cancelFlight?.()` first.
- One commit per task. New files join `scripts/format-scope.json`; run `npm run format` before `format:check`.
- 2 spaces, single quotes, semicolons, JSDoc on exports, British English, no em dashes, sentence case copy.
- Spotter honesty: read-only over layer data; now-mode only; the empty state says plainly "No match in tracked sources. Tracked sources do not cover everything."
- Portable modules import no Cesium and touch no browser globals.
- Carried rulings from the phase 2a/2b final review: fix the stale `aria-pressed` on forced Phenomena mode exit (task 2); correct the stale CHANGELOG test counts at the next CHANGELOG touch (task 7); `exit()` restore-set semantics stay as-is but get documented (task 2).

---

### Task 1: preset buttons reachable

The tray (`#style-buttons.button-grid`, src/ui/styles/controls.css:145-152) scrolls horizontally with the scrollbar hidden and no wheel mapping, so the three atlas styles added after Snow are unreachable by mouse.

**Files:**
- Modify: `src/ui/styles/controls.css:145-152`

- [ ] **Step 1: recon shared usage** — `grep -rn 'button-grid' src/ui/templates src/ui/*.js`: if `.button-grid` is used by other rows, scope the change to `#style-buttons.button-grid` instead of the bare class.
- [ ] **Step 2: wrap instead of hidden scroll**

```css
#style-buttons.button-grid {
  flex-wrap: wrap;
  overflow-x: visible;
}
```

Keep the base class untouched for other users. Check the popover's height behaviour with 10 buttons in two rows at 1440 and 390 px.
- [ ] **Step 3: verify** — throwaway Puppeteer (delete after): open the presets popover, assert the Infrared button's bounding rect sits fully inside the viewport and click it (style applies). Screenshots to qa-shots/presets-wrap/ at 1440 and 390. Run `QA_BASE_URL=http://localhost:4173 node scripts/qa-map-source-tray.mjs` on a fresh dev server state (Shift+Tab counts unchanged: DOM order unchanged).
- [ ] **Step 4: gates and commit**

```bash
git add src/ui/styles/controls.css
git commit -m "fix(shell): preset buttons wrap so every style stays reachable"
```

---

### Task 2: Phenomena mode applies Spectral

**Files:**
- Modify: `src/app/phenomenaMode.js`, `src/app/phenomenaMode.test.mjs`, `src/ui/layerBindings.js`, `src/layers/anomalies/index.js`

**Interfaces:**
- `createPhenomenaMode` gains optional `{ getStyle, setStyle }` hooks. `enter()` stores `getStyle()` then `setStyle('spectral')`; `exit()` restores the stored style. Both optional: absent hooks change nothing (tests cover both shapes).
- `attachShellServices` on the anomalies layer gains `setPhenomenaActive(on)` so a forced exit (manager reconnect or teardown) resets the chronometer button's `aria-pressed` (final-review minor).

- [ ] **Step 1: failing tests** — extend phenomenaMode.test.mjs: (a) enter applies spectral and exit restores the prior style name via stub hooks; (b) missing hooks still work; (c) forced `exit()` fires the style restore exactly once.
- [ ] **Step 2: implement** the hooks in createPhenomenaMode (JSDoc documents the restore-set semantics ruling: exit restores the exact prior enabled set, including a kept layer the user toggled off during the mode).
- [ ] **Step 3: wire** — in `_connectAnomaliesShell` (src/ui/layerBindings.js), pass `getStyle`/`setStyle` from the shell's style manager (recon: the constructor's `services`/`operations` — find how displayBindings reaches `setStyle`; one focused grep) and pass `setPhenomenaActive` through `attachShellServices`; in src/layers/anomalies/index.js store it and update `phenomenaBtn`'s `aria-pressed`.
- [ ] **Step 4: verify** — unit suite; throwaway Puppeteer: press Phenomena mode, assert `document.documentElement.dataset.gevStyle === 'spectral'` and flights disabled; press again, style restored. `node scripts/qa-anomalies.mjs` green.
- [ ] **Step 5: commit**

```bash
git add src/app/phenomenaMode.js src/app/phenomenaMode.test.mjs src/ui/layerBindings.js src/layers/anomalies/index.js
git commit -m "feat(shell): Phenomena mode applies Spectral and restores the prior style"
```

---

### Task 3: case search across both registers

**Files:**
- Create: `src/app/caseSearch.js`, `src/app/caseSearch.test.mjs`
- Modify: `src/ui/layerBindings.js`, `src/layers/anomalies/index.js`, `src/ui/styles/anomaly-atlas.css`

**Interfaces:**
- `searchCases(query, records)` (portable, pure): records are `{ id, register, title, year?, craft?, type?, period?, country? }`; case-insensitive substring over title plus field matches (a 4-digit query matches year; craft/type/country match by prefix); returns top 8 sorted by match quality (title-start beats title-contains beats field match).
- Shell side builds the records array from both layers' `getAnalystRecords()` (anomalies: id, title, year, craft; ancient: id, name as title, type, period, country) and passes `searchCases` results plus `focusCase`/`focusSite` callbacks to the anomalies layer through `attachShellServices({ searchCases: (q) => [...], focusResult: (r) => ... })`.
- UI: a search input in the chronometer panel (`.uap-search`, before the readout); results list under it; Enter or click flies to the top result via `focusCase` (anomalies) or `focusSite` (ancient); Escape clears.

- [ ] **Step 1: failing tests** — searchCases: title-start ranking beats contains; year query '1947' matches Roswell-era rows; type query 'circle' finds Avebury; cap at 8; empty query returns [].
- [ ] **Step 2: implement** the pure matcher.
- [ ] **Step 3: wire** shell records + callbacks in `_connectAnomaliesShell`; input + results DOM in the layer's init (mirroring the panel's existing action buttons; sentence case placeholder "Search cases and sites"); gold result rows for ancient register, ion for sky.
- [ ] **Step 4: verify** — unit suite; qa-anomalies gains a check: type 'Stonehenge', assert a result row appears and clicking it opens the ancient dossier; type 'Phoenix', assert the anomalies dossier opens. `node scripts/qa-ancient-sites.mjs` still green.
- [ ] **Step 5: commit**

```bash
git add src/app/caseSearch.js src/app/caseSearch.test.mjs src/ui/layerBindings.js src/layers/anomalies/index.js src/ui/styles/anomaly-atlas.css scripts/qa-anomalies.mjs scripts/format-scope.json
git commit -m "feat(shell): search cases and sites from the chronometer"
```

---

### Task 4: spotter portable core

**Files:**
- Create: `src/spotter/geometry.js`, `src/spotter/rank.js`
- Test: `src/spotter/geometry.test.mjs`, `src/spotter/rank.test.mjs`

**Interfaces:**
- `haversineKm(a, b)` for `{lat, lon}`; `bearingDeg(from, to)` 0-360 true; `elevationDeg(observer, target)` where target has `altM` (flat-earth small-angle approximation is fine under 400 km: `atan2(altM, distanceKm * 1000)` in degrees, documented).
- `rankCandidates(observation, candidates)`: observation `{ lat, lon, radiusKm = 150 }`; candidates `{ id, kind, label, lat, lon, altM?, detail? }` with kind one of `aircraft`, `military`, `satellite`, `launch`, `lightning`. Filters to radius, scores `1 / (1 + distanceKm / 50)` times a kind prior (aircraft 1.0, military 1.0, satellite 0.8, launch 0.6, lightning 0.5), returns sorted `{ ...candidate, distanceKm, bearingDeg, elevationDeg?, score, why }` where `why` is one sentence ("32 km north-east at 11,000 m, tracked aircraft").
- No Cesium, no browser globals.

- [ ] **Step 1: failing tests** — haversine London to Paris within 340-350 km; bearing London to Paris ~148-152; elevation of a 10,000 m target at 20 km ~26-28 deg; rank filters beyond radius, orders a near aircraft above a far satellite, includes bearing and why text.
- [ ] **Step 2: implement.** JSDoc on every export.
- [ ] **Step 3: gates** (new tests run under root suite; portability grep clean) **and commit**

```bash
git add src/spotter scripts/format-scope.json
git commit -m "feat(spotter): portable geometry and candidate ranking"
```

---

### Task 5: spotter panel and live wiring

**Files:**
- Create: `src/app/spotter.js`
- Modify: `src/ui/layerBindings.js`, `src/layers/anomalies/index.js`, `src/ui/styles/anomaly-atlas.css`, `scripts/package-boundaries.json` (declare src/spotter/* and src/app/spotter.js where the importers are owned)

**Interfaces:**
- `createSpotter({ getCandidates, rank })` in src/app/spotter.js owns the `.uap-spotter` plate: a "Use map centre" observation point (viewer camera pick at screen centre; geolocation optional later), runs `rank`, renders the top 6 rows (kind glyph, label, bearing as compass point, distance, why) and the honest empty state verbatim: "No match in tracked sources. Tracked sources do not cover everything." Now-mode note in the plate footer: "Live sources only. The spotter cannot answer about past sightings."
- `getCandidates()` builds the candidate list read-only from `dataManager.layers` modules that are enabled: flights and military and local-adsb (`getAnalystRecords()` rows carry lat/lon/alt), satellites (analyst records for visible passes), rocket-launches (recent launches with pad coords), weather-lightning (cell positions). Recon each module's analyst record shape first (`getAnalystRecords` exists on the contract); map defensively, skip layers that are off, tag `kind` per layer.
- Entry point: a "Spotter" action button in the chronometer panel (beside Tour), wired through `attachShellServices({ toggleSpotter })` like the mode toggle.

- [ ] **Step 1: recon** analyst record shapes for flights, military, localAdsb, satellites, launches, lightning (one grep each into their getAnalystRecords). Write the field mapping table into your report.
- [ ] **Step 2: implement** createSpotter + getCandidates + button wiring.
- [ ] **Step 3: verify** — throwaway Puppeteer with the track-regression fetch shim pattern NOT needed: the dev server runs keyless OpenSky, flights layer on gives real candidates; test: enable flights + anomalies, open Spotter, assert rows render or the honest empty state (either is truthful; assert the plate opened and one of the two states shows). Disable flights, refresh spotter, assert the empty state text exactly.
- [ ] **Step 4: gates** (boundaries now include the new modules) **and commit**

```bash
git add src/app/spotter.js src/spotter src/ui/layerBindings.js src/layers/anomalies/index.js src/ui/styles/anomaly-atlas.css scripts/package-boundaries.json scripts/format-scope.json
git commit -m "feat(spotter): live sky-check panel over tracked sources"
```

---

### Task 6: spotter qa gate

**Files:**
- Create: `scripts/qa-spotter.mjs`
- Modify: `scripts/format-scope.json`

- [ ] **Step 1: the gate**, modelled on qa-anomalies.mjs (isolated contexts, cancelFlight, polling): with a fixture fetch shim for `/api/opensky` (copy the shim shape from scripts/track-regression.mjs so a known aircraft sits at a known offset from the observation point), assert: the known aircraft ranks first; its bearing and distance are within tolerance (bearing plus or minus 5 deg, distance plus or minus 2 km of the computed truth); with the shim returning empty and all layers off, the exact honest empty state renders; no page errors.
- [ ] **Step 2: three consecutive clean runs**, then commit

```bash
git add scripts/qa-spotter.mjs scripts/format-scope.json
git commit -m "test(spotter): deterministic gate over fixture feeds"
```

---

### Task 7: phase 2c record

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: full sweep** — build, test, boundaries, test:track, qa-anomalies, qa-ancient-sites, qa-spotter, qa-perf, qa-map-source-tray (fresh server).
- [ ] **Step 2: CHANGELOG entry** "Phenomena phase 2c": tray wrap, Spectral-on-mode, case search, spotter MVP with its honesty limits, gate list. Also correct the stale test totals recorded in the 2a and 2b entries to the counts this sweep reports (final-review minor).
- [ ] **Step 3: commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): record phase 2c"
```

## Self-review notes

- User asks covered: tray reachability (T1), UAP-standout default (T2, Spectral is the standout filter and the mode now applies it), search (T3). Spotter (T4-6) per spec. Carried rulings all land (T2 aria-pressed and semantics doc, T7 CHANGELOG counts).
- Type consistency: `attachShellServices` gains `setPhenomenaActive`, `searchCases`, `focusResult`, `toggleSpotter` — all optional, the layer guards each; `createPhenomenaMode` hook names `getStyle`/`setStyle` used in T2 wiring; spotter kinds fixed list shared between rank.js and getCandidates.
- No placeholders; recon steps carry explicit greps where shapes are unverified.
