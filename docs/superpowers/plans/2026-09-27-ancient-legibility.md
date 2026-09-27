# Ancient legibility implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ancient register legible up close and tell its types apart: glyph billboards at close range, type differentiation, type filter chips, cluster badge breakdowns and ambient labels.

**Architecture:** All rendering changes live in the ancient layer's Cesium-side modules (rendering.js, index.js) over the existing columnar accessors and clustering; type-to-glyph mapping is a portable table; the filter reuses the era-filter plumbing; labels go through the overlay host like heroes do.

**Tech Stack:** Cesium (BillboardCollection), vanilla ES modules, node:test, Puppeteer gates.

**Spec:** user direction 26 September 2026 (screenshots: sweep points near-invisible at close zoom; asked for visibility, differentiation, and accepted filter chips, badge breakdown, ambient labels). Design approved in chat.

## Facts established

- Sweep singles render at pixelSize 4, alpha 0.55, NearFarScalar(2.0e5, 1.3, 2.0e7, 0.6) in src/layers/ancientSites/rendering.js; at close zoom they clamp to ~5 px and vanish against terrain. Badges exist only at distance bands.
- Glyph SVGs shipped: public/ancient-sites/glyphs/{circle,geoglyph,mound,rock-art,settlement,temple,trilith,underwater}.svg. Sweep types: circle, geoglyph, megalith, mound, settlement (types[] in sites.v2.json). No megalith.svg: map megalith to trilith.svg or draw megalith.svg in the same style.
- Closest band already renders view-bounded unclustered singles (bounded by paddedViewBoundsDeg with SKYWARD_FALLBACK_CELL_DEG fallback); billboards there stay bounded by construction.
- Era filter plumbing: setEraFilter/requestSweepRecompute throttle in rendering.js, filter composed in index.js; clusterSweep accepts a row filter, badge counts reflect it.
- Sky status filter chips: anomalies/index.js (statuses set, chrono action row) is the interaction precedent.
- Overlay host labels: index.js:264 setEntries (hero labels), clearSource on destroy at index.js:577.
- TMA local register (flag-gated) shares rendering.js; rows carry `category` strings from the KML.
- Cluster pick path: ancient-cluster: ids fly one band closer (index.js); cluster objects carry member indices or count from clusters.js.

## Global constraints

- Gates green per commit: npm run format:check, npm test, npm run check:boundaries, npm run build; qa-ancient-sites (3 consecutive clean) and qa-anomalies on the running :4173 server. One commit per task. British English, sentence case, no em dashes anywhere (added lines).
- Register stays gold: differentiation by glyph shape, never hue; brightness never encodes credibility; no per-site dating claims; heroes keep their existing look, labels and dossiers unchanged.
- Bounded rendering preserved: billboards and labels only in the view-bounded closest band; no continuous render hold; recomputes stay behind the existing throttle and memo (do not regress the fix-wave guards).
- Portable modules stay portable (no Cesium, no browser globals). layerState.js untouched. TMA never ships: its glyph mapping sits behind the existing LOCAL_TMA_ENABLED guard.
- Reduced motion respected; WCAG AA contrast for chips and labels; usable at 390 px.

---

### Task 1: glyph billboards and type differentiation at close range

**Files:**
- Create: `src/layers/ancientSites/glyphMap.js` (portable: sweep type -> glyph URL under /ancient-sites/glyphs/, TMA category -> nearest type; unit test)
- Modify: `src/layers/ancientSites/rendering.js` (a BillboardCollection for the closest band: ~20 px gold glyph with a dark halo ring per single, replacing the bare 4 px dot there; raise mid-band point sizes and alpha so the transition is smooth; TMA points get the same billboard treatment behind LOCAL_TMA_ENABLED), `src/layers/ancientSites/index.js` (legend gains a glyph key row), `src/ui/styles/anomaly-atlas.css` (legend key styling)
- Modify: `scripts/qa-ancient-sites.mjs` (close zoom over a dense area: billboards present and count bounded; legend key present)

- [ ] TDD glyphMap; implement; gates; qa 3x clean; screenshots 1440 and 390 into qa-shots/ancient-legibility/; commit `feat(ancient): glyph billboards make close range legible`

### Task 2: type filter chips and badge breakdown

**Files:**
- Modify: `src/layers/ancientSites/index.js` (chip row above the dial area, one chip per sweep type plus All, modelled on the sky status filter; composes with the era filter into the existing setEraFilter/filter plumbing so badges and singles both honour it; aria-pressed), `src/layers/ancientSites/rendering.js` or `clusters.js` (clusters carry a per-type count breakdown), badge click shows a one-line breakdown (type counts, gold plate) before or while flying one band closer
- Modify: `scripts/qa-ancient-sites.mjs` (chip toggling changes sweepVisibleCount; badge breakdown line appears on badge click; era filter still composes)

- [ ] Implement; portable breakdown maths in clusters.js with a unit test; gates; qa 3x; commit `feat(ancient): type filters and badge breakdowns`

### Task 3: ambient labels, record

**Files:**
- Modify: `src/layers/ancientSites/index.js` (when the closest band shows fewer than ~30 singles on screen, push their names through overlayHost.setEntries alongside hero labels, smaller style; clear with the same lifecycle as hero labels), `scripts/qa-ancient-sites.mjs` (close zoom: a known sweep site name appears in the overlay; zooming out clears sweep labels), CHANGELOG.md (entry "Ancient legibility")
- [ ] Implement; gates; qa 3x; qa-anomalies 1x; screenshots; commit `feat(ancient): ambient names at close range` then `docs(changelog): record ancient legibility` (two commits allowed here: feature, then record)

## Self-review notes

- Chips compose with the era filter rather than replacing it; both funnel through the one throttled recompute path.
- Billboards bounded by the closest band's view rectangle; badge breakdown computed inside clusterSweep where counts already are.
- TMA treatment entirely behind LOCAL_TMA_ENABLED; no new public surface for it.
