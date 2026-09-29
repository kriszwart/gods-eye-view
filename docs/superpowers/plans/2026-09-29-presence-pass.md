# Presence pass implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The atlas responds to presence: retina-sharp sprites and glyphs, hover and selection feedback in every register, and any shaped case or claim summoning its animated archetype craft while its dossier is open.

**Architecture:** The sprite and glyph composers become devicePixelRatio-aware (cache keys gain a DPR bucket); a throttled hover pick brightens the hovered billboard and a selection ring marks the open dossier's point; a shared summon module loads the archetype GLB on dossier open (the hero craft loader in anomalies rendering.js:1146 is the precedent) and despawns on close.

**Tech Stack:** Cesium (Model.fromGltfAsync, BillboardCollection), Canvas 2D, vanilla ES modules, node:test, Puppeteer gates.

**Spec:** user-approved design in chat, 29 September 2026 (A hover/selection, B summon the craft, C retina sharpness; ordered C, A, B here so later tasks build on the DPR-aware composers).

## Facts established

- Hero craft loader: src/layers/anomalies/rendering.js:1146 `Cesium.Model.fromGltfAsync({ url: `${assetBase}crafts/${r.craft}.glb` })` with ModelAnimationLoop.REPEAT (line 1161) and a load-failure warn (1167); thin-film sheen comment at 293; 30 GLBs in public/anomalies/crafts/.
- Sprite composer: src/ui/glowSprite.js (cache per (hue, size bucket), imageId = cache key). Shape glyph composer: anomalies/rendering.js (cache per (shape, hue), placeholder id separate). Ancient glyph composer: ancientSites/rendering.js. All compose at CSS pixel size today.
- Click pick: 12 px box, click path only (deliberate: hover was left untouched for perf). Pick ids: 'anomaly:', 'claim:', 'ancient:'/'ancient:sweep:'/'ancient-cluster:'.
- Dossier open/close paths: anomalies openDossier/index.js, liveClaims index.js, ancientSites openSweepDossier/hero dossier; cross-register exclusivity via gev:dossier-open; Escape closes.
- Render governor: holdContinuousRender per ownerId; heroes already hold while visible; a summoned craft is animated content and needs a hold scoped to its lifetime.
- Reduced motion: matchMedia guards exist in both renderers (pulse precedents); a summoned craft under reduce shows a static pose (activeAnimations not started).
- Claims rows carry shape|null; GEIPAN rows carry craft (the archetype id) — recon confirms rendering.js:916 uses r.craft for glyphs, so the field exists per row.
- qa homes: qa-anomalies (70 checks), qa-claims (39), qa-ancient-sites; qa-perf 24.

## Global constraints

- Gates green per commit: npm run format:check, npm test, npm run check:boundaries, npm run build; browser gates on the controller-managed :4173 (never restart; the known devCctv/toolProjectRoot full-suite collisions are environmental and proven by isolation reruns). One commit per task. British English, sentence case, no em dashes in added lines.
- Presentation only: hue/brightness encodings untouched; the craft are generic archetypes for reported shape categories, never depictions of real objects (the existing CLAUDE.md rule; dossier copy already says "Reported as").
- Bounded: hover pick throttled (never per mousemove raw, never drillPick); one summoned craft at a time (opening another dossier despawns the previous); render hold only while a craft is up or animating; DPR capped at 2, cache sizes stay tiny (x2 entries at most).
- Texture-atlas discipline: DPR joins the cache key AND the imageId; placeholder ids stay distinct (the d967cd5 lesson).
- Reduced motion: summoned craft static pose, no animation start; hover brighten is a state change not an animation (allowed).
- Portable modules stay portable. layerState.js untouched. Pick id shapes unchanged.

---

### Task 1: retina-sharp composition

**Files:**
- Modify: `src/ui/glowSprite.js` (compose at min(devicePixelRatio, 2) x size; canvas width/height scale, billboard width/height stay CSS px; DPR bucket in cache key and imageId; the pure key/bucket helpers and tests updated), `src/layers/anomalies/rendering.js` (shape glyph composer same treatment), `src/layers/ancientSites/rendering.js` (ancient glyph composer same), tests
- qa: extend one existing check per register to assert the imageId carries the DPR bucket (proves the wiring without screenshots); visual screenshots 1440 (a retina capture if the environment allows deviceScaleFactor 2 in Puppeteer — use it) into qa-shots/presence-pass/.

- [ ] Gates; qa-anomalies 3x, qa-ancient-sites 1x, qa-claims 1x, qa-perf 1x.
- [ ] Commit `feat(atlas): sprites and glyphs compose at retina scale`

### Task 2: hover and selection feedback

**Files:**
- Modify: the three renderers and their index.js files: (a) cursor: pointer over any owned pickable (a throttled ~80 ms hover pick with the 12 px box on mousemove, shared helper — recon where GEV handles cursor styles; set/clear the canvas cursor); (b) hover brighten: the hovered billboard's color steps up (scale existing alpha/brightness by a fixed factor, restored on leave; no new sprite composition); (c) selection ring: while a dossier is open, its point carries a ring (reuse the hero ion-ring billboard idiom from anomalies rendering.js) cleared on dossier close (all close paths: Escape, Close, cross-register switch, layer disable).
- qa: hover diagnostics (getDiagnostics exposes hoveredId; move the mouse over a known point, assert set and cursor pointer; move off, assert cleared); selection ring present while dossier open, absent after Escape, in all three registers.

- [ ] Hover pick cost measured (the 80 ms throttle bounds it; state the per-pick cost).
- [ ] Gates; qa-anomalies 3x, qa-claims 1x, qa-ancient-sites 1x, qa-perf 1x.
- [ ] Commit `feat(atlas): the atlas answers the pointer`

### Task 3: summon the craft, record

**Files:**
- Create: `src/app/craftSummon.js` (shared: summon({ viewer, shape, lat, lon, render }) loads `${assetBase}crafts/<shape>.glb` via Model.fromGltfAsync mirroring the hero loader at anomalies/rendering.js:1146 (scale/height-offset recon from the hero placement), starts animations unless reduced motion, holds continuous render under its own ownerId, returns a handle with despawn(); one craft at a time globally (module state); load failure warns once and returns a no-op handle)
- Modify: `src/layers/anomalies/index.js` (non-hero shaped case dossier open summons; close despawns; heroes keep their permanent craft, no double spawn), `src/layers/liveClaims/index.js` (shaped claim dossier same), boundaries/format-scope, `scripts/qa-anomalies.mjs` and `scripts/qa-claims.mjs` (open a shaped non-hero dossier: primitives gain a model, governor hold active; close: model gone, hold released; reduced-motion emulation: model present, animations not running via diagnostics), CHANGELOG.md (entry "Presence pass" covering all three tasks)
- [ ] The dossier plate notes the archetype honestly where it summons (reuse the existing "Reported as" language; no new claims).
- [ ] Gates; qa-anomalies 3x, qa-claims 1x, qa-perf 1x (the hold must release).
- [ ] Commits `feat(atlas): dossiers summon the reported archetype` then `docs(changelog): record the presence pass`

## Self-review notes

- Task order C-A-B as approved: DPR first so hover/selection and summon build on sharp assets.
- One-craft-at-a-time plus hold-scoped-to-lifetime keeps the governor honest; qa-perf pins release.
- The archetype rule is carried in copy and code comments; nothing presents craft as real objects.
