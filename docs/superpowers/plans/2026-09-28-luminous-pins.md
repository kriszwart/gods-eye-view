# Luminous pins implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The atlas's points stop looking like flat map pins: glow sprites with soft falloff in every register, UAP shape glyphs at close zoom, and an animated craft preview in every dossier that knows its shape.

**Architecture:** A shared sprite module composes tiny radial-gradient canvases per hue (cached per hue, never per point) that billboards consume in all three registers; the anomalies renderer gains a close-zoom glyph billboard band mirroring the ancient-sites precedent; dossier previews are pure SVG/CSS animation drawing on the craft-specimens visual language.

**Tech Stack:** Cesium BillboardCollection, Canvas 2D, vanilla ES modules, node:test, Puppeteer gates.

**Spec:** user-approved design in chat, 28 September 2026 (three parts A/B/C). The craft-specimens page is the visual reference.

## Facts established

- Anomalies renderer: src/layers/anomalies/rendering.js draws PointPrimitiveCollections (points at line ~384, pulses ~316-336); 3,405 rows; status hues from the atlas palette; reduced-motion guard already present (REDUCED_PULSE_PIXEL_SIZE, matchMedia listener from 00c0e20).
- 30 shape glyph SVGs ship at public/anomalies/glyphs/ (bell, boomerang, cigar, ..., triangle, wedge) matching the crafts manifest categories; currently unused on the globe.
- Ancient billboards precedent: src/layers/ancientSites/rendering.js composes per-type canvases once (requestBillboardGlyph, failure sentinel from f6a62d8, placeholder imageId separation from d967cd5, disableDepthTestDistance). glyphMap.js precedent for portable URL mapping.
- Live claims: src/layers/liveClaims/rendering.js ion points with sine pulse; claims may carry shape (one of the 30 categories) or null.
- Ancient sweep/hero/TMA points: gold points and glyph billboards at closest band already; part A restyles the POINT tiers (heroes, singles, cluster dots) with glow sprites, glyph billboards stay.
- Dossiers: anomalies (src/layers/anomalies/index.js), claims (src/layers/liveClaims/index.js) both know a shape category; ancient dossiers keep their photo/glyph header unchanged.
- Specimens-page motion language: slow hover drift, thin-film sheen sweep, void background, spectrum accents.
- Perf gate: scripts/qa-perf.mjs (24 checks, render governor discipline); test:track 109 checks.

## Global constraints

- Gates green per commit: npm run format:check, npm test, npm run check:boundaries, npm run build; browser gates on the controller-managed :4173 (never restart it; the controller handles stale-cache 504s). One commit per task. British English, sentence case, no em dashes in added lines.
- Encodings unchanged: brightness/hue mean exactly what they mean today (status, recency, unexplainedness) and never credibility. Glow is presentation only.
- Sprite canvases cached per hue/size bucket; never one canvas per point; texture-atlas imageId discipline per the d967cd5 lesson (placeholder ids never claim a real sprite's id).
- Bounded rendering preserved everywhere: no new per-frame work beyond what exists; glyph billboards only in view-bounded close bands; the skyward fallback and recompute memo guards untouched.
- Reduced motion respected in every new animation (dossier previews static, existing pulse guards unchanged).
- Portable modules stay portable. layerState.js untouched. Pick ids and pick behaviour unchanged in every register.

---

### Task 1: glow sprites across the registers

**Files:**
- Create: `src/ui/glowSprite.js` (+ glowSprite.test.mjs where the pure parts allow: canvas composition needs document, so keep the module Cesium-free but DOM-side; pure helpers like size bucketing and cache keying get tests)
- Modify: `src/layers/anomalies/rendering.js`, `src/layers/liveClaims/rendering.js`, `src/layers/ancientSites/rendering.js` (point tiers become glow billboards: bright core, soft radial halo, per-hue cached canvas; keep PointPrimitives only where a billboard would regress perf and note where), `scripts/package-boundaries.json`, `scripts/format-scope.json`
- Modify: `scripts/qa-perf.mjs` only if its budgets need a note (measure first; budgets should hold)

- [ ] Compose once per (hue, size bucket); billboards use disableDepthTestDistance and keep every existing pick id object shape; pulses and brightness curves unchanged on top of the new sprite.
- [ ] Gates; qa-anomalies 3x, qa-claims 1x, qa-ancient-sites 1x, qa-perf 1x; screenshots 1440/390 in Void and Spectral into qa-shots/luminous-pins/.
- [ ] Commit `feat(atlas): glow sprites replace the flat pins`

### Task 2: UAP shape glyphs at close zoom

**Files:**
- Create: `src/layers/anomalies/shapeGlyphs.js` (portable: shape category to glyph URL under /anomalies/glyphs/, unknown fallback; unit test)
- Modify: `src/layers/anomalies/rendering.js` (below a camera-height threshold, points swap to shape-glyph billboards in the row's status hue with a dark halo, composed per (shape, hue) pair, cached, failure sentinel and placeholder-id discipline per the ancient precedent; above the threshold the Task 1 glow sprites stay; view-bounded like the ancient closest band; picks unchanged), `scripts/qa-anomalies.mjs` (close zoom over a dense area: glyph billboards present and bounded; a known case's glyph matches its shape; zoom out restores sprites)

- [ ] Cache bound: at most 30 shapes x 4 hues composed lazily; report the observed count.
- [ ] Gates; qa-anomalies 3x; screenshots.
- [ ] Commit `feat(anomalies): shapes appear at close range`

### Task 3: animated craft preview in dossiers

**Files:**
- Create: `src/ui/craftPreview.js` (builds an inline SVG preview for a shape category: the glyph with specimens-language motion, slow hover drift and a thin-film sheen sweep, pure SVG/CSS, no WebGL, no external fetches beyond the already-shipped glyph SVGs; reduced motion renders static)
- Modify: `src/layers/anomalies/index.js` and `src/layers/liveClaims/index.js` (dossier header gains the preview when the case/claim has a shape; ancient dossiers untouched), `src/ui/styles/anomaly-atlas.css`, `scripts/qa-anomalies.mjs` and `scripts/qa-claims.mjs` (dossier shows the preview for a shaped case; reduced-motion emulation yields no running animation, via a class or computed-style assertion), boundary/format-scope declarations
- [ ] Escape/lifecycle: preview dies with the dossier; no leaked animation timers (CSS animation only, no JS timers).
- [ ] Gates; qa-anomalies 3x, qa-claims 1x; screenshots of a dossier with the preview at 1440/390.
- [ ] Commit `feat(atlas): dossiers preview the reported shape`

## Self-review notes

- Presentation-only: every encoding claim (brightness, hue) survives untouched; the honesty rules never meet this diff.
- The d967cd5 atlas-id lesson is pinned into Tasks 1 and 2 so the placeholder bug cannot recur.
- Task order: sprites first (the base look), glyphs on top, previews independent of both.
