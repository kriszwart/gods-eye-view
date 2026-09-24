# Phenomena phase 2a and 2b implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand the app to Phenomena with the atlas styles and mode (2a), and ship the ancient sites register with a curated sample sourced with clean licensing (2b).

**Architecture:** Product-facing strings change; internal ids do not. Three shader styles join STYLES. A new `ancient-sites` layer mirrors the anomalies layer contract with portable modules, gold register styling, token 4, and no year-dial coupling. The Modern Antiquarian KML stays local (pipeline raw data); only a hand-curated sample ships.

**Tech Stack:** Vanilla ES modules, Cesium, Vite, node:test, Puppeteer qa harnesses.

**Spec:** anomaly-atlas-kit/docs/PHENOMENA_DESIGN.md

## Global constraints

- Gates green after every commit: `npm run build`, `npm test`, `npm run check:boundaries`. `npm run test:track` and named qa gates at milestones (dev server must already be running on :4173).
- One commit per task. British English, no em dashes, sentence case in copy.
- Style: 2 spaces, single quotes, semicolons, JSDoc on exports. New files join `scripts/format-scope.json` and pass `npm run format:check`.
- Portable layer modules (`model.js`, `records.js`, `source.js`) import no Cesium and touch no browser globals.
- The Modern Antiquarian data: reference links and locally held raw only. No bulk redistribution; the shipped sample is hand-curated facts with per-site attribution.

---

### Task 0: UAP visibility, status filter and tour pacing

User-directed tune of the live phase 1 layer: points bigger and brighter, a status filter so the interesting reports stand out, and a slower, closer tour.

**Files:**
- Modify: `src/layers/anomalies/model.js:59-68` (pointSize, pointAlpha)
- Modify: `src/layers/anomalies/rendering.js` (status on primitive ids; per-status show in apply)
- Modify: `src/layers/anomalies/index.js` (status filter toggles, filtered counts and pulses, tour pacing)
- Modify: `scripts/qa-anomalies.mjs` (filter check)

**Interfaces:**
- Consumes: existing `pointColor/pointSize/pointAlpha` from model.js; `renderer.apply(next)` state object in rendering.js; `chrono.addAction(label, fn)` and `refreshTime()` in index.js. Statuses in the data are exactly: `explained`, `insufficient`, `unresolved`, `contested`.
- Produces: `renderer.apply({ statuses })` accepting a `Set` of status strings or `null` (all); four toggle buttons in the chronometer panel.

- [ ] **Step 1: bigger, brighter points** in model.js:

```js
/** Pixel size: the current year reads loud, the past recedes. */
export function pointSize(row, { current = true } = {}) {
  const u = row.unexplained ?? 0.5;
  return current ? 7 + 6 * u + (row.hero ? 3 : 0) : 3.5 + 3 * u;
}

export function pointAlpha(row, { current = true } = {}) {
  const u = row.unexplained ?? 0.5;
  return current ? 0.95 : 0.3 + 0.4 * u;
}
```

- [ ] **Step 2: status carried on primitive ids and filtered in apply** (rendering.js). Point creation gains status: `id: { id: `anomaly:${r.id}`, anomalyId: r.id, status: r.status }` (both the points site and the hero model site). `state` gains `statuses: null`. In `apply()`, after the collection show loops, filter per point and per hero:

```js
    const passes = (status) => !state.statuses || state.statuses.has(status);
    for (const map of [bright, faded])
      for (const [, c] of map)
        for (let i = 0; i < c.length; i++) {
          const p = c.get(i);
          p.show = passes(p.id.status);
        }
```

and extend the hero show expression with `&& passes(h.row.status)`.

- [ ] **Step 3: filter toggles and filtered counts** (index.js). Track `let activeStatuses = null;` beside the other state. After the tour button is created in `init()`, add four toggles:

```js
      const STATUS_FILTERS = [
        ['explained', 'Explained'],
        ['insufficient', 'Too little data'],
        ['unresolved', 'Unresolved'],
        ['contested', 'Contested'],
      ];
      const enabledStatuses = new Set(STATUS_FILTERS.map(([k]) => k));
      for (const [key, label] of STATUS_FILTERS) {
        const btn = chrono.addAction(label, () => {
          enabledStatuses.has(key)
            ? enabledStatuses.delete(key)
            : enabledStatuses.add(key);
          btn.setAttribute('aria-pressed', String(enabledStatuses.has(key)));
          activeStatuses =
            enabledStatuses.size === STATUS_FILTERS.length
              ? null
              : new Set(enabledStatuses);
          refreshTime();
        });
        btn.setAttribute('aria-pressed', 'true');
      }
```

In `refreshTime()`: pass the filter through and filter the pulses,

```js
    renderer.apply({ visible: enabled, year: chrono.year, mode: chrono.mode, statuses: activeStatuses });
    if (chrono.mode !== 'all' && lastYear != null && chrono.year !== lastYear)
      renderer.pulse(
        rows.filter(
          (r) => r.year === chrono.year && (!activeStatuses || activeStatuses.has(r.status)),
        ),
      );
```

and `visibleCount` gains the same status condition.

- [ ] **Step 4: tour pacing** (index.js playTour): flight `duration: 4.5`, range `60000` (was 120000), pitch `Cesium.Math.toRadians(-26)`, dwell `await wait(8000)` (was 4500). Everything else unchanged.

- [ ] **Step 5: qa check** in scripts/qa-anomalies.mjs, after the play check: read the readout, toggle "Unresolved" off, assert the readout count drops, toggle it back on:

```js
  const filter = await page.evaluate(async () => {
    const readout = () => document.querySelector('.uap-readout').textContent;
    const before = readout();
    const btn = [...document.querySelectorAll('.uap-chrono-panel button')].find(
      (b) => b.textContent === 'Unresolved',
    );
    btn.click();
    await new Promise((r) => setTimeout(r, 300));
    const filtered = readout();
    btn.click();
    await new Promise((r) => setTimeout(r, 300));
    return { before, filtered, restored: readout() };
  });
  check(
    'status filter changes the visible count',
    filter.before !== filter.filtered && filter.before === filter.restored,
    JSON.stringify(filter),
  );
```

- [ ] **Step 6: gates** — `npm run format:check`, `npm test`, `npm run check:boundaries` green; dev server up, `node scripts/qa-anomalies.mjs` 0 failures including the new check; eyeball the tour once (slower, closer) and the bigger points.

- [ ] **Step 7: commit**

```bash
git add src/layers/anomalies/model.js src/layers/anomalies/rendering.js src/layers/anomalies/index.js scripts/qa-anomalies.mjs
git commit -m "feat(anomalies): status filter, larger points and a calmer tour"
```

---

### Task 1: rebrand strings to Phenomena

**Files:**
- Modify: `index.html:6`
- Modify: `src/ui/templates/scene-chrome.html:13-14`
- Modify: `src/ui/templates/hud-loading.html:8`
- Modify: `src/main.js:11`

**Interfaces:** none produced; pure copy change. Do NOT touch `src/pinokioLauncherContract.test.mjs` or the launcher text "Open God's Eye View" it pins; that is an external launcher contract, out of scope.

- [ ] **Step 1: edit the four strings**

index.html line 6: `<title>Phenomena</title>`

scene-chrome.html lines 13-14 (keep the logo span exactly as is):

```html
<h1><span class="title-logo brand-logo" data-logo-gaze data-logo-src="/logo.svg" aria-hidden="true"><img src="/logo.svg" alt="" /></span> <span>Phenom<span class="title-accent">ena</span></span></h1>
<p class="subtitle">The unexplained, mapped</p>
```

hud-loading.html line 8: `<h2>Phenom<span class="title-accent">ena</span></h2>`

main.js line 11: `console.error('Phenomena initialization failed:', error);`

- [ ] **Step 2: check nothing else pins the strings**

Run: `grep -rn "GOD'S EYE\|NO PLACE LEFT" src index.html` — expect no hits. Run `npm test`; if a test fails on the new copy, update that assertion in the same commit (known safe: none found in recon except the Pinokio contract, which is untouched).

- [ ] **Step 3: gates and screenshot**

`npm run build && npm test && npm run check:boundaries` all green. With the dev server up, `node scripts/qa-anomalies.mjs` still passes. Screenshot the header and loader at 1440 px.

- [ ] **Step 4: commit**

```bash
git add index.html src/ui/templates/scene-chrome.html src/ui/templates/hud-loading.html src/main.js
git commit -m "feat(shell): rename the product to Phenomena"
```

---

### Task 2: register Spectral, Radar and Infrared styles

**Files:**
- Modify: `src/ui/visualPresets.js:1-19` (imports and STYLES)
- Modify: `src/sharelink.js:24` (STYLE_TO_URL)
- Test: existing suite; any test pinning the style set gets updated in this commit

**Interfaces:**
- Consumes: `src/styles/spectral.js`, `radar.js`, `infrared.js` (already in tree; check their export names first: `grep -n export src/styles/spectral.js src/styles/radar.js src/styles/infrared.js`).
- Produces: style names `spectral`, `radar`, `infrared` usable by `styleManager.setStyle`, with URL tokens `spectral`, `radar`, `ir`.

- [ ] **Step 1: add imports and STYLES entries**

In visualPresets.js after the thermal import (use the actual export identifiers found above; the kit modules export `{ name, uniforms, fragmentShader }` shaped objects):

```js
import { spectralShader } from '../styles/spectral.js';
import { radarShader } from '../styles/radar.js';
import { infraredShader } from '../styles/infrared.js';
```

and in STYLES:

```js
  spectral: spectralShader,
  radar: radarShader,
  infrared: infraredShader,
```

- [ ] **Step 2: add share URL tokens**

In sharelink.js STYLE_TO_URL add:

```js
  spectral: 'spectral',
  radar: 'radar',
  infrared: 'ir',
```

- [ ] **Step 3: run the suite and fix pinned lists**

`npm test`. If a test pins the style count or list (search `grep -rn "retro.*surveillance.*thermal" src --include='*.mjs'` and `grep -rln "Object.keys(STYLES)" src`), extend it with the three new names in this commit.

- [ ] **Step 4: browser check**

Dev server up: the visual presets tray shows the three new styles; selecting Spectral renders (shaders compiled in the sandbox per INTEGRATION_NOTES, so failures here mean wiring, not GLSL). Screenshot at 1440 px. Run `QA_BASE_URL=http://localhost:4173 node scripts/qa-map-source-tray.mjs` (it exercises style buttons) on a freshly restarted dev server.

- [ ] **Step 5: commit**

```bash
git add src/ui/visualPresets.js src/sharelink.js
git commit -m "feat(styles): register the Spectral, Radar and Infrared atlas styles"
```

---

### Task 3: infrared style reveals infrared-only craft

**Files:**
- Modify: `src/app/layers/anomalies.js`
- Modify: `scripts/qa-anomalies.mjs` (new check)

**Interfaces:**
- Consumes: `layer.setInfrared(on)` (exists, `src/layers/anomalies/index.js:353`); `document.documentElement.dataset.gevStyle` set by `src/ui/visualSettings.js:1524` on every style change.
- Produces: nothing new.

- [ ] **Step 1: watch the style attribute from the wrapper**

In `createApplicationAnomalies`, after building the layer, observe the root attribute and forward it; disconnect on destroy:

```js
  const layer = createAnomaliesLayer({ ... });
  const syncInfrared = () =>
    layer.setInfrared(document.documentElement.dataset.gevStyle === 'infrared');
  const observer = new MutationObserver(syncInfrared);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-gev-style'],
  });
  syncInfrared();
  const destroy = layer.destroy;
  layer.destroy = (...args) => {
    observer.disconnect();
    return destroy.apply(layer, args);
  };
  return layer;
```

- [ ] **Step 2: qa check**

Add to scripts/qa-anomalies.mjs after the dossier checks: set the style, then read back the layer's stats or an exposed flag:

```js
  const ir = await page.evaluate(async () => {
    const { application } = await import(
      document.querySelector('script[type="module"][src*="/src/main.js"]').src
    );
    window.__godsEyeView.styleManager.setStyle('infrared');
    await new Promise((r) => setTimeout(r, 600));
    const on = document.documentElement.dataset.gevStyle === 'infrared';
    window.__godsEyeView.styleManager.setStyle('normal');
    return on;
  });
  check('infrared style reaches the layer', ir === true);
```

- [ ] **Step 3: gates**

`npm test && npm run check:boundaries`; dev server up, `node scripts/qa-anomalies.mjs` passes with the new check.

- [ ] **Step 4: commit**

```bash
git add src/app/layers/anomalies.js scripts/qa-anomalies.mjs
git commit -m "feat(anomalies): infrared style reveals infrared-only craft"
```

---

### Task 4: Phenomena mode

**Files:**
- Create: `src/app/phenomenaMode.js`
- Test: `src/app/phenomenaMode.test.mjs`
- Modify: wiring site found in step 3 (recon), plus `src/layers/anomalies/index.js` (one `addAction` call)

**Interfaces:**
- Produces: `createPhenomenaMode({ layerIds, isEnabled, setEnabled, keep })` returning `{ enter(), exit(), active }`. `keep` is the id set to leave on: `['anomalies', 'ancient-sites']`.

- [ ] **Step 1: failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhenomenaMode } from './phenomenaMode.js';

test('enter disables everything but the kept registers and exit restores', () => {
  const enabled = new Set(['flights', 'anomalies', 'weather-radar']);
  const mode = createPhenomenaMode({
    layerIds: ['flights', 'anomalies', 'weather-radar', 'ancient-sites'],
    isEnabled: (id) => enabled.has(id),
    setEnabled: (id, on) => (on ? enabled.add(id) : enabled.delete(id)),
    keep: ['anomalies', 'ancient-sites'],
  });
  mode.enter();
  assert.deepEqual([...enabled].sort(), ['anomalies']);
  mode.exit();
  assert.deepEqual([...enabled].sort(), ['anomalies', 'flights', 'weather-radar']);
});
```

Run: `npm test` (or `node --test src/app/phenomenaMode.test.mjs`). Expect FAIL, module missing.

- [ ] **Step 2: implement**

```js
/**
 * Solo the Phenomena registers: disable every other layer, remember the
 * exact prior set, and restore it on exit. Layers are hidden, not removed.
 */
export function createPhenomenaMode({ layerIds, isEnabled, setEnabled, keep }) {
  const kept = new Set(keep);
  let previous = null;
  return {
    get active() {
      return previous !== null;
    },
    enter() {
      if (previous) return;
      previous = layerIds.filter((id) => isEnabled(id));
      for (const id of previous) if (!kept.has(id)) setEnabled(id, false);
    },
    exit() {
      if (!previous) return;
      for (const id of previous) if (!isEnabled(id)) setEnabled(id, true);
      previous = null;
    },
  };
}
```

Run the test: PASS.

- [ ] **Step 3: recon the wiring channel, then wire a toggle**

Run: `grep -rn 'attachShellServices' src/app src/data | grep -v test | head` to find where GEV calls `attachShellServices(services)` on layers and what `services` carries. Wire accordingly: give the anomalies layer an `attachShellServices(services)` method that, when the services expose layer control (or the data manager), builds the mode with `manager.layers.keys()`, `manager.isEnabled`, `manager.setEnabled` and adds a chronometer panel action:

```js
    attachShellServices(services) {
      const manager = services?.dataManager;
      if (!manager || !chrono) return;
      const mode = createPhenomenaMode({
        layerIds: [...manager.layers.keys()],
        isEnabled: (id) => manager.isEnabled(id),
        setEnabled: (id, on) => manager.setEnabled(id, on, { origin: 'user' }),
        keep: ['anomalies', 'ancient-sites'],
      });
      chrono.addAction('Phenomena mode', (btn) => {
        mode.active ? mode.exit() : mode.enter();
        btn.setAttribute('aria-pressed', String(mode.active));
      });
    },
```

If the recon shows `services` does not carry the data manager, add `dataManager` to the services object at the call site in the same commit (one line, follow how `runNavigation` is provided).

- [ ] **Step 4: gates and manual check**

`npm test && npm run check:boundaries` green. Dev server: enable flights plus anomalies, press "Phenomena mode": flights row goes off, anomalies stays; press again: flights returns. `node scripts/qa-anomalies.mjs` still green.

- [ ] **Step 5: commit**

```bash
git add src/app/phenomenaMode.js src/app/phenomenaMode.test.mjs src/layers/anomalies/index.js src/app/layers/anomalies.js scripts/format-scope.json
git commit -m "feat(shell): Phenomena mode solos the atlas registers"
```

(Add the two new files to scripts/format-scope.json and run `npm run format` first.)

---

### Task 5: design-system pass on panels

**Files:**
- Modify: `src/ui/styles/anomaly-atlas.css`

**Interfaces:** none; CSS scoped under `.anomaly-atlas` only.

- [ ] **Step 1: recon panel chrome selectors**

`grep -n 'border-radius' src/ui/styles/foundation.css src/ui/styles/controls.css src/ui/styles/layers.css | head -20` to list the rounded-glass surfaces (panel containers, buttons, trays).

- [ ] **Step 2: apply the plate language**

Append to anomaly-atlas.css, using the selectors found (pattern below; extend to each listed surface):

```css
/* Hairline plates with registration corners; DESIGN_SYSTEM.md section 3. */
.anomaly-atlas .control-panel,
.anomaly-atlas .layer-panel {
  border-radius: 0;
  border: 1px solid var(--uap-hairline, rgba(217, 220, 230, 0.16));
  background: rgba(7, 8, 18, 0.82);
}
.anomaly-atlas .control-panel::before,
.anomaly-atlas .layer-panel::before {
  content: '';
  position: absolute;
  inset: 3px;
  pointer-events: none;
  background:
    linear-gradient(var(--uap-ink) 0 0) top left / 8px 1px,
    linear-gradient(var(--uap-ink) 0 0) top left / 1px 8px,
    linear-gradient(var(--uap-ink) 0 0) bottom right / 8px 1px,
    linear-gradient(var(--uap-ink) 0 0) bottom right / 1px 8px;
  background-repeat: no-repeat;
  opacity: 0.35;
}
```

- [ ] **Step 3: verify quality floor**

Chrome at 1440 and 390 px: plates render, focus outlines stay visible, no layout breakage; AA contrast spot-check ink on plate (contrast ratio of #D9DCE6 on #070812 is 15.7:1, passes). `node scripts/qa-cockpit-plates.mjs` green on a fresh dev server. Cyber HUD unaffected (`grep` the cyber test: `npm test` covers it).

- [ ] **Step 4: commit**

```bash
git add src/ui/styles/anomaly-atlas.css
git commit -m "feat(shell): hairline plates with registration corners"
```

---

### Task 6: live-globe tune and phase 2a record

**Files:**
- Modify: `src/layers/anomalies/index.js` and `src/layers/anomalies/atmosphere.js` (constants only, as the live checks dictate)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: live checks** (dev server, Chrome): tour camera distances comfortable; pulse density on busy years readable; atmosphere against Google 3D tiles at street level not blown out. Adjust the constants the checks flag (tour height in `focusCase`/`playTour`, pulse cap 400, atmosphere light intensity), one value at a time, re-checking.

- [ ] **Step 2: screenshots** at 1440 and 390 px against stock GEV (style normal, layer off) for the side-by-side acceptance.

- [ ] **Step 3: CHANGELOG entry** headed "Phenomena phase 2a" recording rebrand, styles, infrared wiring, Phenomena mode, plates, tuning results and screenshots location.

- [ ] **Step 4: gates** full sweep: build, test, boundaries, test:track, `node scripts/qa-anomalies.mjs`, `node scripts/qa-perf.mjs`.

- [ ] **Step 5: commit**

```bash
git add src/layers/anomalies/index.js src/layers/anomalies/atmosphere.js CHANGELOG.md
git commit -m "docs(changelog): record phase 2a with live-globe tuning"
```

---

### Task 7: TMA KML adapter (pipeline, local only)

**Files:**
- Create: `anomaly-atlas-kit/pipeline/src/adapters/tma-kml.mjs`
- Test: `anomaly-atlas-kit/pipeline/test/tma-kml.test.mjs`
- Modify: `anomaly-atlas-kit/pipeline/package.json` (script `ancient:tma`)
- Modify: `anomaly-atlas-kit/docs/DATA_PIPELINE.md` (TMA row)

**Interfaces:**
- Produces: `parseTmaKml(xmlString)` returning `[{ name, category, lat, lon, url }]`; CLI writes `local_data/normalised/tma-sites.jsonl`.

The KML shape (verified): `<Folder><name>Category (n)</name>` containing `<Placemark><name>Site</name><description><![CDATA[Category<br><a href="URL">URL</a>]]></description><Point><coordinates>lon,lat,0</coordinates></Point></Placemark>`. 17,392 placemarks, 100 folders.

- [ ] **Step 1: failing test with an inline fixture**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTmaKml } from '../src/adapters/tma-kml.mjs';

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>The Modern Antiquarian sites</name>
<Folder><name>Stone Circle (2)</name>
<Placemark><name>Avebury</name><description><![CDATA[Stone Circle<br><a href="https://www.themodernantiquarian.com/site/23/avebury">https://www.themodernantiquarian.com/site/23/avebury</a>]]></description><Point><coordinates>-1.8547071211094,51.42839968297,0</coordinates></Point></Placemark>
</Folder></Document></kml>`;

test('parses placemarks with folder category, swapped lat lon and url', () => {
  const rows = parseTmaKml(FIXTURE);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    name: 'Avebury',
    category: 'Stone Circle',
    lat: 51.42839968297,
    lon: -1.8547071211094,
    url: 'https://www.themodernantiquarian.com/site/23/avebury',
  });
});
```

Run: `cd anomaly-atlas-kit/pipeline && npm test`. Expect FAIL.

- [ ] **Step 2: implement with regex parsing (no XML dependency, matching the other adapters)**

```js
/**
 * Parse a Modern Antiquarian KML export into plain site rows. The raw file
 * and its output stay in local_data: TMA grants no bulk redistribution
 * licence, so this feeds curation and cross-checking only.
 */
export function parseTmaKml(xml) {
  const rows = [];
  const folders = xml.split('<Folder>').slice(1);
  for (const folder of folders) {
    const category = (/<name>([^<]+?)\s*\(\d+\)<\/name>/.exec(folder) || [])[1] || '';
    for (const m of folder.matchAll(
      /<Placemark><name>([^<]+)<\/name><description><!\[CDATA\[.*?href="([^"]+)".*?<coordinates>([-\d.]+),([-\d.]+)/gs,
    )) {
      rows.push({
        name: decodeEntities(m[1]),
        category,
        lat: Number(m[4]),
        lon: Number(m[3]),
        url: m[2],
      });
    }
  }
  return rows;
}

const decodeEntities = (s) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
```

CLI entry (same file, matching the other adapters' pattern: read argv path, write JSONL to `local_data/normalised/tma-sites.jsonl`). Add script: `"ancient:tma": "node src/adapters/tma-kml.mjs"`.

- [ ] **Step 3: test passes, then run on the real file**

`npm test` green. Then `npm run ancient:tma -- /Users/kriszwart/Downloads/modern-antiquarian-sites.kml` and confirm the JSONL row count is 17392. Copy the raw KML to `anomaly-atlas-kit/pipeline/local_data/raw/tma/modern-antiquarian-sites.kml` (git-ignored; verify with `git status`).

- [ ] **Step 4: document** in DATA_PIPELINE.md sources table: "The Modern Antiquarian | 17,392 sites | KML export, local only | no redistribution licence; curation and cross-checking only; per-site reference links allowed".

- [ ] **Step 5: commit**

```bash
git add anomaly-atlas-kit/pipeline/src/adapters/tma-kml.mjs anomaly-atlas-kit/pipeline/test/tma-kml.test.mjs anomaly-atlas-kit/pipeline/package.json anomaly-atlas-kit/docs/DATA_PIPELINE.md
git commit -m "feat(pipeline): parse The Modern Antiquarian KML locally"
```

---

### Task 8: curated ancient sites sample dataset

**Files:**
- Create: `public/ancient-sites/sites.v1.json`
- Create: `anomaly-atlas-kit/pipeline/test/ancient-sample.test.mjs` (schema validation)
- Modify: `src/data/local_data/anomalies/README.md` (sibling note) or create `src/data/local_data/ancient_sites/README.md`

**Interfaces:**
- Produces: `public/ancient-sites/sites.v1.json` with shape `{ schema: 'ancient.sites.v1', count, sites: [...] }`; site fields `id, name, lat, lon, country, period, period_start_bce, type, summary, debated, unesco, source_url, attribution, glyph`.

Types and glyphs: `megalith` (trilith glyph), `circle`, `mound`, `geoglyph`, `temple`, `rock-art`, `settlement`, `underwater`.

The 20 sites, coordinates from the TMA KML where marked (TMA) else published values:

| id | name | lat | lon | type | period |
| --- | --- | --- | --- | --- | --- |
| gobekli-tepe | Gobekli Tepe | 37.2231 | 38.9226 | temple | c. 9500 BCE |
| stonehenge | Stonehenge (TMA) | 51.178875491763 | -1.8261907688977 | circle | c. 3000 BCE |
| avebury | Avebury (TMA) | 51.42839968297 | -1.8547071211094 | circle | c. 2850 BCE |
| newgrange | Newgrange (TMA) | 53.694635636713 | -6.4754641056061 | mound | c. 3200 BCE |
| callanish | Callanish (TMA) | 58.197711659214 | -6.7440416258443 | circle | c. 2900 BCE |
| carnac-menec | Alignements de Menec (TMA) | 47.5929093595 | -3.081407547 | megalith | c. 4500 BCE |
| ggantija | Ggantija (TMA) | 36.047194904482 | 14.26885843277 | temple | c. 3600 BCE |
| baalbek | Baalbek trilithon | 34.0069 | 36.2039 | megalith | c. 1st century BCE |
| nabta-playa | Nabta Playa | 22.5083 | 30.7256 | circle | c. 4800 BCE |
| great-zimbabwe | Great Zimbabwe | -20.2675 | 30.9333 | settlement | c. 1100 CE |
| derinkuyu | Derinkuyu | 38.3735 | 34.7352 | settlement | c. 8th century BCE |
| mohenjo-daro | Mohenjo-daro | 27.3294 | 68.1386 | settlement | c. 2500 BCE |
| plain-of-jars | Plain of Jars, site 1 | 19.4319 | 103.1519 | megalith | c. 500 BCE |
| nazca-lines | Nazca lines | -14.739 | -75.13 | geoglyph | c. 200 BCE |
| sacsayhuaman | Sacsayhuaman | -13.5078 | -71.9822 | megalith | c. 1450 CE |
| puma-punku | Puma Punku | -16.5619 | -68.6797 | temple | c. 600 CE |
| serpent-mound | Serpent Mound | 39.0254 | -83.4302 | geoglyph | c. 300 BCE |
| poverty-point | Poverty Point | 32.6367 | -91.4076 | mound | c. 1700 BCE |
| yonaguni | Yonaguni monument | 24.4358 | 123.011 | underwater | debated |
| rujm-el-hiri | Rujm el-Hiri | 32.9082 | 35.8011 | circle | c. 3000 BCE |

- [ ] **Step 1: failing schema test** (in pipeline tests, reading the repo file)

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const data = JSON.parse(
  readFileSync(new URL('../../../public/ancient-sites/sites.v1.json', import.meta.url), 'utf8'),
);

test('ancient sample is valid, honest and attributed', () => {
  assert.equal(data.schema, 'ancient.sites.v1');
  assert.equal(data.count, data.sites.length);
  assert.ok(data.sites.length >= 20);
  for (const s of data.sites) {
    for (const key of ['id', 'name', 'lat', 'lon', 'country', 'period', 'type', 'summary', 'debated', 'source_url', 'attribution', 'glyph'])
      assert.ok(s[key] !== undefined && s[key] !== '', `${s.id ?? s.name} missing ${key}`);
    assert.ok(Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180);
    assert.ok(s.summary.length <= 280);
    assert.match(s.summary + s.debated, /^(?!.*ancient alien)/i);
  }
});
```

- [ ] **Step 2: author the dataset**

Write all 20 records. Per record: neutral `summary` (what it is, when, what was found), `debated` naming the genuine scholarly debate (construction method, purpose, dating), `source_url` (UNESCO page where listed, else the TMA site page for TMA-sourced rows, else a museum or survey page), `attribution` ("Coordinates: The Modern Antiquarian" for TMA rows, else the source), `unesco` reference or null, `glyph` from the type mapping. Example record, full shape:

```json
{
  "id": "gobekli-tepe",
  "name": "Gobekli Tepe",
  "lat": 37.2231,
  "lon": 38.9226,
  "country": "Turkey",
  "period": "c. 9500 BCE",
  "period_start_bce": 9500,
  "type": "temple",
  "summary": "Monumental enclosures of carved T-shaped pillars raised by pre-agricultural people, buried deliberately and excavated from 1995. The oldest known monumental architecture.",
  "debated": "How a society without farming organised the labour, and why the enclosures were periodically buried.",
  "unesco": "https://whc.unesco.org/en/list/1572/",
  "source_url": "https://whc.unesco.org/en/list/1572/",
  "attribution": "UNESCO World Heritage listing",
  "glyph": "temple"
}
```

- [ ] **Step 3: tests green** (`cd anomaly-atlas-kit/pipeline && npm test`), root gates unaffected (`npm test` at root; the pipeline suite is separate).

- [ ] **Step 4: dataset README** at `src/data/local_data/ancient_sites/README.md`: sources, the TMA position (reference links and locally held raw only), sample-needs-review note mirroring the anomalies README.

- [ ] **Step 5: commit**

```bash
git add public/ancient-sites/sites.v1.json anomaly-atlas-kit/pipeline/test/ancient-sample.test.mjs src/data/local_data/ancient_sites/README.md
git commit -m "feat(ancient): curated sample of twenty documented sites"
```

---

### Task 9: stone glyphs

**Files:**
- Create: `public/ancient-sites/glyphs/{trilith,circle,mound,geoglyph,temple,rock-art,settlement,underwater}.svg`

- [ ] **Step 1: author eight minimal line glyphs** in the same visual language as `public/anomalies/glyphs/` (inspect one first: single stroke, `currentColor`, 64 viewBox). Example, trilith:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3">
  <rect x="14" y="24" width="8" height="26"/>
  <rect x="42" y="24" width="8" height="26"/>
  <rect x="10" y="14" width="44" height="8"/>
</svg>
```

circle: ring of eight short radial strokes. mound: a low arc on a baseline. geoglyph: a spiral polyline. temple: three pillars under a pediment line. rock-art: concentric arcs with a dot. settlement: three small squares on a baseline. underwater: a trilith over two wave lines.

- [ ] **Step 2: visual check** in the browser (open each file), then commit:

```bash
git add public/ancient-sites/glyphs
git commit -m "feat(ancient): stone glyph set"
```

---

### Task 10: portable modules for ancient sites

**Files:**
- Create: `src/layers/ancientSites/model.js`, `src/layers/ancientSites/records.js`, `src/layers/ancientSites/source.js`
- Test: `src/layers/ancientSites/records.test.mjs`

**Interfaces:**
- Produces: `ANCIENT_LAYER_ID = 'ancient-sites'`; `GOLD = '#D8B36A'`; `normalizeAncientSites(json)` returning validated site rows; `createAncientSource({ baseUrl })` with `getSnapshot({ signal })`; `mapAnalystRecord(row)`; `createAncientOverlayEntry({ id, position, name })`.
- No Cesium, no window, no document in any of the three.

- [ ] **Step 1: failing records test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAncientSites } from './records.js';

const VALID = {
  schema: 'ancient.sites.v1',
  count: 1,
  sites: [{ id: 'x', name: 'X', lat: 1, lon: 2, country: 'C', period: 'c. 3000 BCE', period_start_bce: 3000, type: 'circle', summary: 's', debated: 'd', unesco: null, source_url: 'https://example.org', attribution: 'a', glyph: 'circle' }],
};

test('valid payload normalises to rows', () => {
  const rows = normalizeAncientSites(VALID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'x');
});

test('wrong schema and bad coordinates are rejected', () => {
  assert.throws(() => normalizeAncientSites({ schema: 'nope', sites: [] }));
  assert.throws(() => normalizeAncientSites({ ...VALID, sites: [{ ...VALID.sites[0], lat: 400 }] }));
});
```

Run `npm test`: FAIL.

- [ ] **Step 2: implement records.js**

```js
/** Decode ancient.sites.v1. No Cesium and no browser globals. */
export function normalizeAncientSites(json) {
  if (json?.schema !== 'ancient.sites.v1' || !Array.isArray(json.sites))
    throw new TypeError('Unsupported ancient sites payload');
  return json.sites.map((s) => {
    if (typeof s.id !== 'string' || !s.id) throw new TypeError('Site id missing');
    if (!(Math.abs(s.lat) <= 90) || !(Math.abs(s.lon) <= 180))
      throw new TypeError(`Bad coordinates on ${s.id}`);
    return { ...s };
  });
}
```

model.js:

```js
export const ANCIENT_LAYER_ID = 'ancient-sites';
export const GOLD = '#D8B36A';

/** Analyst record for the voice and analyst surfaces. */
export function mapAnalystRecord(row) {
  return { id: row.id, name: row.name, lat: row.lat, lon: row.lon, type: row.type, period: row.period };
}

/** Overlay label entry on the shared ambient-label lane, gold register. */
export function createAncientOverlayEntry({ id, position, name }) {
  return {
    id: `ancient:${id}`,
    position,
    variant: 'label',
    title: String(name),
    accent: GOLD,
    priority: 500,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
```

source.js (mirror `src/layers/anomalies/source.js` fetch shape):

```js
import { normalizeAncientSites } from './records.js';

/** Fetch-based source over public/ancient-sites/. Portable. */
export function createAncientSource({ baseUrl = '/ancient-sites/' } = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const res = await fetch(`${baseUrl}sites.v1.json`, { signal });
      if (!res.ok) throw new Error(`Ancient sites fetch failed: ${res.status}`);
      return normalizeAncientSites(await res.json());
    },
  };
}
```

- [ ] **Step 3: tests pass; portability check**

`npm test` green. `grep -n "Cesium\|window\.\|document\." src/layers/ancientSites/model.js src/layers/ancientSites/records.js src/layers/ancientSites/source.js` returns nothing.

- [ ] **Step 4: commit** (format scope first: add the four files, `npm run format`)

```bash
git add src/layers/ancientSites scripts/format-scope.json
git commit -m "feat(ancient): portable model, records and source modules"
```

---

### Task 11: rendering, layer contract and app wrapper

**Files:**
- Create: `src/layers/ancientSites/rendering.js`, `src/layers/ancientSites/index.js`
- Create: `src/app/layers/ancientSites.js`

**Interfaces:**
- Consumes: task 10 exports; `overlayHost` (`src/app/layers/overlayHost.js`); `registerPickOwner`/`unregisterPickOwner` (`src/data/pickRegistry.js`); `governorRequestRender` (`src/renderGovernor.js`).
- Produces: `createAncientSitesLayer({ source, overlayHost, picking, render })` implementing the standard contract with `focusSite(id)`; `createApplicationAncientSites()` wrapper.

- [ ] **Step 1: rendering.js** — one gold point per site, no tick loop, no continuous hold, one-shot renders only:

```js
import * as Cesium from 'cesium';
import { GOLD } from './model.js';

/** Owns the point collection for the ancient register. Static: no animation. */
export function createAncientRenderer(viewer, { render } = {}) {
  const scene = viewer.scene;
  const gold = Cesium.Color.fromCssColorString(GOLD);
  const points = scene.primitives.add(
    new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT }),
  );
  points.show = false;
  const requestFrame = (reason) =>
    render ? render.governorRequestRender(reason) : scene.requestRender();

  function setRows(rows) {
    points.removeAll();
    for (const r of rows)
      points.add({
        id: { id: `ancient:${r.id}`, ancientId: r.id },
        position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 0),
        pixelSize: 7,
        color: gold.withAlpha(0.9),
        outlineColor: gold.withAlpha(0.35),
        outlineWidth: 2,
        scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.5, 2.0e7, 0.8),
      });
    requestFrame('ancient-rows');
  }

  function apply({ visible }) {
    points.show = visible;
    requestFrame('ancient-visibility');
  }

  function pick(windowPosition) {
    const picked = scene.pick(windowPosition);
    return picked?.id?.ancientId ?? picked?.primitive?.id?.ancientId ?? null;
  }

  function destroy() {
    scene.primitives.remove(points);
  }

  return { setRows, apply, pick, destroy };
}
```

- [ ] **Step 2: index.js** — contract mirroring `src/layers/anomalies/index.js` but without chronometer, atmosphere, tour or craft. Key parts: `id: 'ancient-sites'`, `name: 'Ancient sites'`, `icon: '△'`, `source: 'Curated sample'`, `updateInterval: -1` (static dataset: update loads once). Enable registers the pick owner (`ancient:` prefix predicate) and a `ScreenSpaceEventHandler` LEFT_CLICK calling `openDossier(renderer.pick(e.position))`; disable unregisters, destroys the handler, hides the dossier and clears the overlay source. Update fetches once, calls `renderer.setRows(rows)` and `overlayHost.setEntries(ANCIENT_LAYER_ID, rows.map((r) => createAncientOverlayEntry({ id: r.id, position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 200), name: r.name })), { moving: false })`. The dossier is a `div.uap-dossier.ancient` (reusing the plate) with name, period, country, type glyph image from `/ancient-sites/glyphs/`, summary, a "Debated" line and the source link. `focusSite(id)` flies the camera to the site at 6,000 m and opens the dossier. `getStats()` returns `{ count, lastUpdate, error }`. NO year-dial coupling anywhere.

- [ ] **Step 3: wrapper** `src/app/layers/ancientSites.js`:

```js
import { createAncientSitesLayer } from '../../layers/ancientSites/index.js';
import { createAncientSource } from '../../layers/ancientSites/source.js';
import { overlayHost } from './overlayHost.js';
import { registerPickOwner, unregisterPickOwner } from '../../data/pickRegistry.js';
import { governorRequestRender } from '../../renderGovernor.js';

/** Wire the bundled ancient sites dataset to the application services. */
export function createApplicationAncientSites(options = {}) {
  const base = options.assetBase || `${import.meta.env?.BASE_URL ?? '/'}ancient-sites/`;
  return createAncientSitesLayer({
    source: options.source || createAncientSource({ baseUrl: base }),
    overlayHost,
    picking: { registerPickOwner, unregisterPickOwner },
    render: { governorRequestRender },
    assetBase: base,
    ...options,
  });
}
```

- [ ] **Step 4: gates** — `npm run build && npm test` green (nothing imports these yet; the boundary check stays green as unowned unimported files, proven in phase 1). Format scope + `npm run format`.

- [ ] **Step 5: commit**

```bash
git add src/layers/ancientSites src/app/layers/ancientSites.js scripts/format-scope.json
git commit -m "feat(ancient): rendering, layer contract and app wrapper"
```

---

### Task 12: register ancient sites with share token 4

**Files:**
- Modify: `src/app/constructCatalog.js` (import + factory after `createApplicationAnomalies()`)
- Modify: `src/data/layerState.js` (registry entry between `alpr-cameras` and `anomalies`)
- Modify: `src/app/constructCatalog.test.mjs` (30 to 31), `src/data/layerState.test.mjs` (29 to 30, both places)
- Modify: `package.json` exports, `scripts/package-boundaries.json`

- [ ] **Step 1: registry entry** in LAYER_STATE_REGISTRY, alphabetical position (after `alpr-cameras`, before `anomalies`):

```js
  Object.freeze({ id: 'ancient-sites', token: '4', disposition: 'enabled-only' }),
```

Catalogue: `import { createApplicationAncientSites } from './layers/ancientSites.js';` and `createApplicationAncientSites(),` directly after `createApplicationAnomalies(),`.

- [ ] **Step 2: test pins** — constructCatalog.test.mjs `layers.length` 30 to 31; layerState.test.mjs 29 to 30 twice. The traffic-to-directions slice assertion is untouched by this insertion point.

- [ ] **Step 3: exports and boundaries** — package.json exports add `"./layers/ancient-sites": "./src/layers/ancientSites/index.js"` (after `./layers/anomalies`) and `"./layers/ancient-sites/source": "./src/layers/ancientSites/source.js"` (after `./layers/anomalies/source`). scripts/package-boundaries.json: new groups `ancient-sites` (exports `./layers/ancient-sites`, modules index/model/records/source/rendering, external `["cesium"]`) after `anomalies`, and `ancient-sites-source` (exports `./layers/ancient-sites/source`, modules records+source, external `[]`) after `anomalies-source`; add `src/app/layers/ancientSites.js` plus the five layer modules to `application-components` and `application-layer-construction` beside the anomalies entries. Remember phase 1's bug: the two new GROUPS must be present in the file actually written.

- [ ] **Step 4: gates** — build, test, boundaries all green (`Checked ancient-sites: 1 exports, 5 owned modules.` appears). Dev server restart, layer toggles, 20 gold points appear; changing the year dial does not change them. `npm run test:track` green (now boots 31 layers).

- [ ] **Step 5: commit**

```bash
git add src/app/constructCatalog.js src/data/layerState.js src/app/constructCatalog.test.mjs src/data/layerState.test.mjs package.json scripts/package-boundaries.json
git commit -m "feat(ancient): register the layer in the catalogue with share token 4"
```

---

### Task 13: gold register styling

**Files:**
- Modify: `src/ui/styles/anomaly-atlas.css`

- [ ] **Step 1: dossier and label variants**

```css
/* Gold register: the ancient sites dossier variant. */
.anomaly-atlas .uap-dossier.ancient {
  --uap-accent: #d8b36a;
}
.anomaly-atlas .uap-dossier.ancient .uap-code {
  color: #d8b36a;
}
.anomaly-atlas .uap-dossier.ancient .uap-debated {
  border-left: 2px solid rgba(216, 179, 106, 0.6);
  padding-left: 8px;
  color: var(--uap-dim, #7c8195);
}
```

(Selectors must match the classes used in task 11's dossier markup; adjust there, not here, if they drift.)

- [ ] **Step 2: verify** in Chrome at 1440 and 390 px: dossier opens gold-accented, debated line reads clearly, AA contrast holds (#D8B36A on #070812 is 9.4:1). Commit:

```bash
git add src/ui/styles/anomaly-atlas.css
git commit -m "feat(ancient): gold register styling"
```

---

### Task 14: ancient sites qa gate and phase 2b record

**Files:**
- Create: `scripts/qa-ancient-sites.mjs` (modelled exactly on `scripts/qa-anomalies.mjs`)
- Modify: `CHANGELOG.md`, `scripts/format-scope.json`

- [ ] **Step 1: the gate** — same skeleton as qa-anomalies.mjs (isolated context, ?welcome=0, wait for dataManager). Checks: layer registered and initially off; `setEnabled('ancient-sites', true)` loads `getStats().count === 20`; year-dial decoupling (enable anomalies too, step the year via the slider, ancient count and visibility unchanged); `focusSite('gobekli-tepe')` opens a dossier containing the text "Debated" and a source link; Escape closes; share restore in a fresh context via `#lat=37.22&lon=38.92&alt=26000000&pitch=-90&v=2&l=4` (and `l=3.4` restores both layers); no page errors.

- [ ] **Step 2: run it three times** on a fresh dev server: `RESULT: 0 failures` each time.

- [ ] **Step 3: CHANGELOG** entry "Phenomena phase 2b" with the acceptance results, the TMA licence position, and screenshots at 1440 and 390 px in `qa-shots/ancient-sites/`.

- [ ] **Step 4: full gate sweep** — build, test, boundaries, test:track, `node scripts/qa-anomalies.mjs`, `node scripts/qa-ancient-sites.mjs`, `node scripts/qa-perf.mjs`.

- [ ] **Step 5: commit**

```bash
git add scripts/qa-ancient-sites.mjs scripts/format-scope.json CHANGELOG.md
git commit -m "docs(changelog): record phase 2b with the ancient sites gate"
```

---

## Self-review notes

- Spec coverage: rebrand (T1), styles and Spectral default surfacing (T2), infrared reveal (T3), Phenomena mode (T4), design-system plates (T5), phase 2a acceptance and tuning (T6), TMA handling (T7), curated sample with honesty rules (T8), glyphs (T9), portable modules (T10), rendering and contract (T11), token 4 registration (T12), gold register (T13), qa gate and record (T14). Spec's "glyph billboards at close range" is deliberately deferred to the phase 5b sweep; the sample uses points plus dossier glyphs (recorded in T14's CHANGELOG note).
- Spectral as "atlas default": surfaced through Phenomena mode and the share link, not by changing GEV's global default style; changing the global default would fight GEV's owner-locked baseline in visualPresets.js.
- Type consistency: `createAncientSitesLayer`, `createApplicationAncientSites`, `createAncientSource`, `normalizeAncientSites`, `createAncientOverlayEntry`, `ANCIENT_LAYER_ID`, ids `ancient:<id>`, token `'4'` used consistently across T10 to T14.
