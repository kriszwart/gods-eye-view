# Phenomena phase 3c implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two free, visible wins: a report-density hotspot layer that breathes with the year dial, and a street-view link in every dossier opening the witness's vantage.

**Architecture:** Hotspots are computed locally: a portable binning and kernel module feeds an offscreen-canvas equirectangular heat texture applied as a Cesium imagery layer with alpha, owned by the anomalies renderer family and recomputed (debounced) when the dial or status filter changes. Street view is a plain URL, no key, no billing, guarded like every other external link.

**Tech Stack:** Vanilla ES modules, Canvas 2D, Cesium SingleTileImageryProvider, node:test, Puppeteer gates.

## Facts established

- 3,405 records ship in public/anomalies/anomalies.v1.json (columnar; lat/lon/year/status per row); the renderer (src/layers/anomalies/rendering.js) holds decoded rows and a state { visible, year, mode, span, statuses }; refreshTime() in index.js is the single repaint entry; chrono.addAction adds panel buttons.
- Street view URL scheme, keyless: https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=<lat>,<lon> — safeSourceUrl passes it (https, any host).
- Both dossiers already have a guarded link row (.uap-source) with 'Open record' and 'Wikipedia'.
- Cesium: viewer.imageryLayers.addImageryProvider(new Cesium.SingleTileImageryProvider({ url: canvas.toDataURL(), rectangle: Cesium.Rectangle.MAX_VALUE })) renders a world-spanning overlay; layer.alpha settable; imageryLayers.remove cleans up. Governor: one-shot governorRequestRender on texture swap.

## Global constraints

- Gates green per commit: npm run format:check, npm test, npm run check:boundaries, npm run build; browser gates on the running :4173 server (qa-anomalies, qa-ancient-sites as touched). One commit per task. British English, no em dashes, sentence case. New files into scripts/format-scope.json; new cross-package imports declared in scripts/package-boundaries.json.
- The heat overlay encodes report DENSITY only; the legend line must say so ("Heat shows report density, not credibility").
- Portable maths module: no Cesium, no browser globals (the canvas render lives in the Cesium-side module).

---

### Task 1: street view links in both dossiers

**Files:**
- Modify: `src/layers/anomalies/index.js` (dossier .uap-source row gains 'Street view' link built from row.lat/row.lon via the URL scheme, through safeSourceUrl + escapeHtml, target _blank rel noopener noreferrer), `src/layers/ancientSites/index.js` (same), `scripts/qa-anomalies.mjs` and `scripts/qa-ancient-sites.mjs` (each: the dossier carries a Street view link with host www.google.com and the viewpoint containing the row's rounded coordinates)

- [ ] Implement both; toFixed(4) coordinates in the URL; gates; both qa gates 0 failures; ONE commit "feat(atlas): dossiers open the street view vantage".

---

### Task 2: hotspot maths (portable)

**Files:**
- Create: `src/layers/anomalies/hotspots.js`, `src/layers/anomalies/hotspots.test.mjs`

**Interfaces (binding):**
- `binRows(rows, { width, height, filter })`: equirectangular grid (width x height, default 720x360), returns Float32Array of counts; filter is the same predicate shape refreshTime uses (year/mode/span/statuses) — accept a plain `(row) => boolean`.
- `blurBins(bins, width, height, radius = 2)`: separable box blur (two passes), returns Float32Array.
- `heatAlpha(value, max)`: 0..1 with a soft knee (value/max clamped, sqrt curve).
- No Cesium, no DOM. TDD: a row at lat 0 lon 0 lands centre cell; poles clamp; blur conserves mass within 1 percent; heatAlpha(0)=0, monotonic.

- [ ] TDD RED then GREEN; portability grep clean; format-scope; gates; ONE commit "feat(anomalies): portable hotspot binning and kernel".

---

### Task 3: heat overlay rendering and toggle

**Files:**
- Modify: `src/layers/anomalies/rendering.js` (heat canvas: 1440x720 offscreen canvas painted from binRows+blurBins with the ion-to-magenta ramp at heatAlpha alpha; `setHeat(on)` adds/removes a SingleTileImageryProvider imagery layer (alpha 0.55) and `refreshHeat(filterState)` recomputes debounced 250 ms; destroy removes the layer), `src/layers/anomalies/index.js` (chrono action 'Hotspots' toggling, aria-pressed; refreshTime calls refreshHeat when on; legend gains the density line), `scripts/qa-anomalies.mjs` (check: toggling Hotspots on adds one imagery layer — read viewer.imageryLayers.length delta — and stepping the year with hotspots on keeps it at one, off removes it; no page errors)
- Boundary note: rendering.js already owned by the anomalies groups; no new imports expected beyond ./hotspots.js (same package).

- [ ] Implement; verify visually with a throwaway screenshot (delete script; keep qa-shots/phase3c/hotspots-1440.png) — France should glow; gates; qa-anomalies 3 consecutive clean runs; qa-perf green (the overlay must not hold continuous render — texture swaps are one-shot). ONE commit "feat(anomalies): hotspot heat layer follows the dial".

---

### Task 4: phase record

- [ ] Full sweep (root gates, test:track, qa-anomalies, qa-ancient-sites, qa-spotter, qa-perf); CHANGELOG entry "Phenomena phase 3c" (street view vantage links, density hotspots with the honesty line, all free tier); ONE commit "docs(changelog): record phase 3c".

## Self-review notes

- Density-not-credibility line satisfies the honesty rule for a layer that could otherwise read as a truth map.
- The heat texture recompute is CPU-cheap (3,405 points into a 720x360 grid) and debounced; no continuous render hold.
- Street view links reuse the existing guard path end to end.
