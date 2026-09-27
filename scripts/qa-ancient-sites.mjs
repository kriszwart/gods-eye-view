#!/usr/bin/env node
/**
 * Browser proof of the ancient sites layer acceptance: registration, the
 * v2 dataset's curated hero tier plus its worldwide Wikidata sweep loading
 * to the dynamic total the dataset itself reports, an off/on re-enable with
 * (hero-only) overlay labels surviving, decoupling from the anomalies year
 * dial, hero dossier open with a debated line, record link, site photograph
 * (host-guarded), photo credit, Wikipedia link and Street view link, Escape
 * close, and share-link restore via token 4, solo and alongside anomalies.
 *
 * Also proves the sweep never becomes ~81k primitives at once: at world
 * zoom the sweep renders as a handful of clustered gold badges; clicking the
 * densest badge flies the camera one band closer and the clustering
 * re-coarsens accordingly; teleporting directly over a sweep site below the
 * closest clustering band renders it as an individual, pickable single, and
 * clicking it opens a compact dossier with a Wikidata link (and a Wikipedia
 * link when the sweep flagged one).
 *
 * Also proves the type filter chips and the badge breakdown plate (task 2,
 * ancient-legibility): one chip per sweep type plus "All" on the deep-time
 * dial's own panel, unchecking a chip narrows the visible sweep and "All"
 * restores it, the chip filter composes as AND with the deep-time era band
 * rather than overriding it, and clicking a cluster badge shows a one-line
 * type breakdown that auto-dismisses once the camera settles.
 *
 * Also proves the ambient sweep-name labels (task 3, ancient-legibility): at
 * close range over a sparse-but-nonzero area, a known sweep site's name
 * appears in the ambient overlay through a sibling overlay source, and
 * zooming out past the closest band clears those labels while the hero
 * labels keep working.
 *
 * Also proves the local-only Modern Antiquarian register (phase 5b task 4)
 * is absent with PHENOMENA_LOCAL_TMA unset, which is how this gate's own
 * server always runs: its dev-only route serves the app shell rather than
 * TMA data, and enabling the layer never requests that route at all. Also
 * proves the git-ignored TMA export is denied at the raw dev-server paths
 * (the repository-relative path and its /@fs/<absolute-path> form), not
 * just at the friendly /local-tma/ route, per the phase 5b task 4 fix
 * round's server.fs.deny entry in build/vite.js.
 *
 * Needs the dev server on :4173 (QA_BASE_URL overrides).
 */
import puppeteer from 'puppeteer';
import path from 'node:path';
const base = process.env.QA_BASE_URL || 'http://localhost:4173';
const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});
let failures = 0;
const check = (name, passed, detail = '') => {
  console.log(
    `[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
  if (!passed) failures++;
};
try {
  const isolated = await browser.createBrowserContext();
  const page = await isolated.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  // The local-only Modern Antiquarian register (phase 5b task 4) must never
  // be reached with PHENOMENA_LOCAL_TMA unset, which is how this gate's own
  // :4173 server always runs. Watch for any request the app itself makes to
  // the dev-only route before enabling the layer below.
  const tmaRequests = [];
  page.on('request', (req) => {
    if (req.url().includes('/local-tma/')) tmaRequests.push(req.url());
  });
  await page.goto(`${base}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 60000,
  });

  const present = await page.evaluate(() => {
    const m = window.__godsEyeView.dataManager;
    return {
      has: m.layers.has('ancient-sites'),
      enabled: m.isEnabled('ancient-sites'),
    };
  });
  check(
    'ancient sites layer registered and initially off',
    present.has && !present.enabled,
    JSON.stringify(present),
  );

  // The count pin is dynamic: read the v2 document's own `count` field
  // (heroes + sweep) rather than hardcoding it, so this gate does not need
  // editing every time the sweep is rebuilt.
  const expectedCount = await page.evaluate(async () => {
    const res = await fetch('/ancient-sites/sites.v2.json');
    const json = await res.json();
    return json.count;
  });
  check(
    'the v2 dataset reports a count far larger than the curated hero tier alone',
    Number.isFinite(expectedCount) && expectedCount > 1000,
    String(expectedCount),
  );

  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('ancient-sites', true, {
      origin: 'user',
    }),
  );
  await page.waitForFunction(
    (expected) =>
      window.__godsEyeView.dataManager.layers
        .get('ancient-sites')
        ?.module?.getStats?.().count === expected,
    { timeout: 30000 },
    expectedCount,
  );
  check(
    `${expectedCount} sites (heroes + worldwide sweep) loaded after toggle on`,
    true,
  );

  // Legend glyph key (task 1, ancient-legibility): five sweep-type glyphs
  // named in the register's own legend, visible now (the deep-time dial and
  // its shared legend slot both engage on a fresh enable with the sky
  // register still off - see index.js's syncDeepTime).
  const glyphKey = await page.evaluate(() => {
    const plate = document.querySelector('.uap-legend.ancient');
    const key = plate?.querySelector('.uap-glyph-key') ?? null;
    return {
      plateFound: !!plate,
      plateHidden: plate ? plate.hidden : null,
      keyFound: !!key,
      items: key
        ? [...key.querySelectorAll('li')].map((li) => li.textContent.trim())
        : [],
    };
  });
  check(
    'ancient-sites legend carries a glyph key row naming all five sweep types',
    glyphKey.plateFound &&
      glyphKey.plateHidden === false &&
      glyphKey.keyFound &&
      ['Circle', 'Geoglyph', 'Megalith', 'Mound', 'Settlement'].every((name) =>
        glyphKey.items.includes(name),
      ),
    JSON.stringify(glyphKey),
  );

  // Local-only Modern Antiquarian register: absent with the flag unset.
  // Snapshot the request tally now, before the deliberate probe fetch just
  // below adds its own matching request to the same array.
  const tmaRequestsFromTheApp = tmaRequests.length;
  check(
    'enabling the ancient sites layer never requests the local TMA route',
    tmaRequestsFromTheApp === 0,
    JSON.stringify(tmaRequests),
  );

  // The dev-only route falls through to the SPA shell rather than 404ing (no
  // middleware is registered for it at all), so the proof is that the
  // response is the app shell, not TMA's own NDJSON.
  const tmaProbe = await page.evaluate(async () => {
    try {
      const res = await fetch('/local-tma/tma-sites.jsonl');
      const contentType = res.headers.get('content-type') || '';
      const text = await res.text();
      return {
        status: res.status,
        contentType,
        looksLikeAppShell: /<html/i.test(text),
        looksLikeTmaData:
          contentType.includes('ndjson') || /^\s*\{"name"/.test(text),
      };
    } catch (error) {
      return { error: String(error) };
    }
  });
  check(
    'the local TMA route serves the app shell, not TMA data, without the env flag',
    tmaProbe.looksLikeAppShell === true && tmaProbe.looksLikeTmaData !== true,
    JSON.stringify(tmaProbe),
  );

  // The friendly /local-tma/ route above is a separate, Node-level
  // fs.readFile (server/providers/local-tma.js); it is not proof that Vite's
  // own static fallthrough is closed. Probe the raw repository path and its
  // /@fs/<absolute-path> form directly: before the phase 5b task 4 fix
  // round's server.fs.deny entry (build/vite.js), both served the
  // git-ignored TMA jsonl straight off disk regardless of the env flag. A
  // clean denial is typically a 403, but the contract this gate cares about
  // is narrower and host-independent: never a 200 with a TMA-shaped body.
  // Computed from process.cwd() rather than hardcoded, so this probe still
  // means something on a checkout at a different path than this machine's.
  const tmaAbsolutePath = path.join(
    process.cwd(),
    'anomaly-atlas-kit/pipeline/local_data/normalised/tma-sites.jsonl',
  );
  const rawFallthroughProbes = await page.evaluate(async (fsAbsolutePath) => {
    const urls = [
      '/anomaly-atlas-kit/pipeline/local_data/normalised/tma-sites.jsonl',
      `/@fs${fsAbsolutePath}`,
    ];
    const results = [];
    for (const url of urls) {
      try {
        const res = await fetch(url);
        const text = await res.text();
        results.push({
          url,
          status: res.status,
          servedTmaData: res.status === 200 && /^\s*\{"name"/.test(text),
        });
      } catch (error) {
        results.push({ url, error: String(error) });
      }
    }
    return results;
  }, tmaAbsolutePath);
  for (const probe of rawFallthroughProbes) {
    check(
      `raw dev-server path denies the TMA export: ${probe.url}`,
      probe.servedTmaData !== true,
      JSON.stringify(probe),
    );
  }

  const reenable = await page.evaluate(async () => {
    const m = window.__godsEyeView.dataManager;
    await m.setEnabled('ancient-sites', false, { origin: 'user' });
    await m.setEnabled('ancient-sites', true, { origin: 'user' });
    // The deep-time dial engages fresh on this re-enable (the sky register
    // is still off at this point in the script) and defaults to "up to
    // era" mode, which honestly excludes Yonaguni (no known date - see
    // eras.js's heroInEraBand). Switch to "All eras" so this check
    // measures toggle survival, not era filtering (its own checks follow
    // below).
    document.querySelector('[data-mode="all"]')?.click();
    const { getWorldOverlayDiagnostics } =
      await import('/src/overlays/worldOverlay.js');
    return {
      enabled: m.isEnabled('ancient-sites'),
      count: m.layers.get('ancient-sites')?.module?.getStats?.().count,
      overlayEntries:
        getWorldOverlayDiagnostics().entriesBySource?.['ancient-sites'] || 0,
    };
  });
  check(
    'layer re-enables cleanly after first load',
    reenable.enabled === true && reenable.count === expectedCount,
    JSON.stringify(reenable),
  );
  check(
    // The hero overlay source stays hero-only even though the dataset now
    // carries tens of thousands more sites: the sweep's own ambient
    // sweep-name labels (task 3, ancient-legibility) publish to a sibling
    // overlay source instead (checked further down, at a deliberately
    // close, sparse camera position), never inflating this fixed count -
    // that separation matters here because the boot camera can already be
    // at close range (city level) by this point in the script.
    'site overlay labels survive an off/on toggle, hero tier only',
    reenable.overlayEntries === 20,
    JSON.stringify(reenable),
  );

  // ── deep-time dial: engagement, honesty line, era-band filtering ──
  //
  // A fresh enable with the sky (anomalies) register still off (untouched
  // so far in this script): the deep-time dial engages automatically, at
  // its default "up to era" mode and its newest-end starting position
  // (1500 CE).
  await page.evaluate(async () => {
    const m = window.__godsEyeView.dataManager;
    await m.setEnabled('ancient-sites', false, { origin: 'user' });
    await m.setEnabled('ancient-sites', true, { origin: 'user' });
  });
  const deepEngaged = await page.evaluate(() => {
    const slider = document.querySelector('.uap-slider');
    const cumulativeMode = document.querySelector('[data-mode="cumulative"]');
    return slider
      ? {
          found: true,
          ariaLabel: slider.getAttribute('aria-label'),
          min: slider.getAttribute('aria-valuemin'),
          max: slider.getAttribute('aria-valuemax'),
          modeLabel: cumulativeMode?.textContent.trim() || null,
        }
      : { found: false };
  });
  check(
    'deep-time mode engages when the ancient layer is on and the sky layer is off, with era-mode copy',
    deepEngaged.found &&
      deepEngaged.ariaLabel === 'Era' &&
      deepEngaged.min === '-1500' &&
      deepEngaged.max === '10000' &&
      deepEngaged.modeLabel === 'Up to era',
    JSON.stringify(deepEngaged),
  );
  check(
    "the deep-time dial states its honesty line ('undated sites are placed by their type's typical period') visibly in the UI",
    await page.evaluate(() => {
      const note = [...document.querySelectorAll('.uap-legend.ancient')].find(
        (el) => el.textContent.includes("type's typical period"),
      );
      return !!note && !note.hidden;
    }),
  );

  // A known world-zoom camera first: the default boot camera can start
  // anywhere, including a close-up view whose padded bounds cover an area
  // with few or no sweep sites at all, which would make a before/after
  // delta meaningless regardless of era filtering. World zoom clusters the
  // whole sweep with no bounds, so the count genuinely reflects the era
  // band alone.
  await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    const ellipsoid = viewer.scene.globe.ellipsoid;
    viewer.camera.cancelFlight?.();
    viewer.camera.setView({
      destination: ellipsoid.cartographicToCartesian({
        longitude: 0,
        latitude: (15 * Math.PI) / 180,
        height: 20_000_000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  });
  await new Promise((r) => setTimeout(r, 700));

  const eraBand = await page.evaluate(async () => {
    const m = window.__godsEyeView.dataManager;
    const before = m.layers
      .get('ancient-sites')
      ?.module?.getRenderDiagnostics?.();
    const slider = document.querySelector('.uap-slider');
    slider.focus();
    slider.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 300));
    const after = m.layers
      .get('ancient-sites')
      ?.module?.getRenderDiagnostics?.();
    return {
      sweepBefore: before?.sweepVisibleCount,
      sweepAfter: after?.sweepVisibleCount,
      heroesBefore: before?.heroCount,
      heroesAfter: after?.heroCount,
    };
  });
  check(
    'moving the deep-time dial changes the visible sweep count',
    Number.isFinite(eraBand.sweepBefore) &&
      Number.isFinite(eraBand.sweepAfter) &&
      eraBand.sweepBefore !== eraBand.sweepAfter,
    JSON.stringify(eraBand),
  );
  check(
    "heroes with an out-of-band period_start_bce disappear at the dial's far (oldest) end",
    Number.isFinite(eraBand.heroesBefore) &&
      Number.isFinite(eraBand.heroesAfter) &&
      eraBand.heroesAfter < eraBand.heroesBefore,
    JSON.stringify(eraBand),
  );

  // Fix round regression (finding 1): enabling the sky register for the
  // first time lazily builds its own chronometer widget (see
  // src/layers/anomalies/index.js's init()); disabling it again must not
  // leave that widget behind in the DOM, even hidden, because the sky
  // register turning off is exactly the ancient layer's own signal to bring
  // its deep-time dial straight back up (see the ancient layer's
  // attachShellServices doc comment). Before the fix, a stale hidden
  // `.uap-chrono` sat in the DOM at the same time as the fresh, visible Era
  // one, so every unqualified `.uap-slider`/`.uap-chrono` query below (this
  // file uses `.uap-slider` unqualified six times) could resolve to the
  // wrong, hidden widget. Ancient sites stays enabled throughout, so its
  // own dial re-engages the instant the sky register settles off.
  const oneChronoAfterSkyToggle = await page.evaluate(async () => {
    const m = window.__godsEyeView.dataManager;
    await m.setEnabled('anomalies', true, { origin: 'user' });
    await m.setEnabled('anomalies', false, { origin: 'user' });
    const chronos = [...document.querySelectorAll('.uap-chrono')];
    const slider = document.querySelector('.uap-slider');
    return {
      chronoCount: chronos.length,
      hiddenCount: chronos.filter((c) => c.hidden).length,
      sliderAriaLabel: slider?.getAttribute('aria-label') || null,
    };
  });
  check(
    'exactly one chronometer is in the DOM after the sky register is enabled then disabled again (the deep-time dial, not a hidden stale sky one)',
    oneChronoAfterSkyToggle.chronoCount === 1 &&
      oneChronoAfterSkyToggle.hiddenCount === 0 &&
      oneChronoAfterSkyToggle.sliderAriaLabel === 'Era',
    JSON.stringify(oneChronoAfterSkyToggle),
  );

  // ── type filter chips (task 2, ancient-legibility) ──
  //
  // Run here, not later: the sky register is off right now (the previous
  // check disabled it again), so the ancient layer's own deep-time dial -
  // and the type chips added to its panel - are actually in the DOM. The
  // very next section below turns the sky register on and leaves it on for
  // the rest of this script, which tears the dial (and the chips) down.
  //
  // One chip per sweep type plus "All": unchecking a chip narrows
  // sweepVisibleCount, "All" restores it, and the chip filter composes as
  // AND with the deep-time era band rather than overriding it - "around
  // era" mode at the dial's fresh default position (1500 CE) already
  // excludes the circle and mound types on its own (their typological
  // windows do not reach this era, see eras.js's TYPE_ERA_WINDOWS), so
  // additionally unchecking Megalith there must narrow the count further
  // still, not reset it.
  //
  // Pin the camera to a known world-zoom view first, exactly like the era
  // band and worldwide-sweep sections elsewhere in this file: the app's own
  // one-time boot cinematic (flyToAustin, src/camera.js) can still be
  // easing toward Austin this far into the script on a slower run, and an
  // uncancelled flyTo keeps overwriting camera.setView every frame for its
  // own remaining duration, silently drifting the camera out from under a
  // multi-step test that never repositions it itself.
  await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    const ellipsoid = viewer.scene.globe.ellipsoid;
    viewer.camera.cancelFlight();
    viewer.camera.setView({
      destination: ellipsoid.cartographicToCartesian({
        longitude: 0,
        latitude: (15 * Math.PI) / 180,
        height: 20_000_000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  });
  await new Promise((r) => setTimeout(r, 700));
  const typeChips = await page.evaluate(async () => {
    const m = window.__godsEyeView.dataManager;
    const diag = () =>
      m.layers.get('ancient-sites')?.module?.getRenderDiagnostics?.();
    const findChip = (label) =>
      [
        ...document.querySelectorAll(
          '.uap-chrono-panel button.ancient-type-chip',
        ),
      ].find((b) => b.textContent.trim() === label);
    // The dial just rebuilt fresh (the previous check toggled the sky
    // register off again); its own reset recompute is throttled, so wait
    // for it to actually land before treating this reading as the
    // unfiltered baseline - otherwise this would read the stale count left
    // over from the earlier "End" (oldest era) position instead.
    await new Promise((r) => setTimeout(r, 400));
    const before = diag()?.sweepVisibleCount;
    const megalithBtn = findChip('Megalith');
    const allBtn = findChip('All');
    const wasMegalithPressed = megalithBtn?.getAttribute('aria-pressed');
    megalithBtn?.click();
    await new Promise((r) => setTimeout(r, 400));
    const uncheckedNowPressed = megalithBtn?.getAttribute('aria-pressed');
    const unchecked = diag()?.sweepVisibleCount;
    allBtn?.click();
    await new Promise((r) => setTimeout(r, 400));
    const restoredAfterAll = diag()?.sweepVisibleCount;
    document.querySelector('[data-mode="window"]')?.click();
    await new Promise((r) => setTimeout(r, 400));
    const eraOnly = diag()?.sweepVisibleCount;
    megalithBtn?.click();
    await new Promise((r) => setTimeout(r, 400));
    const both = diag()?.sweepVisibleCount;
    // Restore defaults: a specific hardcoded sweep row is picked by
    // coordinates later in this script and must still render there. One
    // click at a time, each given its own settle wait, rather than firing
    // both back to back - the throttled recompute path only guarantees the
    // *final* state lands, not that an in-flight deferred recompute from
    // the first click has not already been superseded before it runs.
    allBtn?.click();
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('[data-mode="cumulative"]')?.click();
    await new Promise((r) => setTimeout(r, 400));
    const restoredFinal = diag()?.sweepVisibleCount;
    return {
      foundMegalith: !!megalithBtn,
      foundAll: !!allBtn,
      wasMegalithPressed,
      uncheckedNowPressed,
      before,
      unchecked,
      restoredAfterAll,
      eraOnly,
      both,
      restoredFinal,
    };
  });
  check(
    'unchecking the Megalith chip narrows sweepVisibleCount',
    typeChips.foundMegalith &&
      typeChips.wasMegalithPressed === 'true' &&
      typeChips.uncheckedNowPressed === 'false' &&
      Number.isFinite(typeChips.before) &&
      Number.isFinite(typeChips.unchecked) &&
      typeChips.unchecked < typeChips.before,
    JSON.stringify(typeChips),
  );
  check(
    'the All chip re-checks every type and restores the original sweepVisibleCount',
    typeChips.foundAll && typeChips.restoredAfterAll === typeChips.before,
    JSON.stringify(typeChips),
  );
  check(
    'the type-chip filter composes with the era band (AND): a chip unchecked while "around era" mode is active narrows further, not overridden',
    Number.isFinite(typeChips.eraOnly) &&
      Number.isFinite(typeChips.both) &&
      typeChips.eraOnly < typeChips.before &&
      typeChips.both < typeChips.eraOnly,
    JSON.stringify(typeChips),
  );
  check(
    'era filter still composes cleanly: restoring All and cumulative mode returns the original sweepVisibleCount',
    typeChips.restoredFinal === typeChips.before,
    JSON.stringify(typeChips),
  );

  // Year-dial decoupling: bring the anomalies chronometer up alongside the
  // static register, step its year, and prove the ancient count never moves
  // with it.
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('anomalies', true, {
      origin: 'user',
    }),
  );
  await page.waitForFunction(() => document.querySelector('.uap-slider'), {
    timeout: 30000,
  });
  const decoupled = await page.evaluate(async () => {
    const m = window.__godsEyeView.dataManager;
    const before = m.layers.get('ancient-sites')?.module?.getStats?.().count;
    const slider = document.querySelector('.uap-slider');
    const yearBefore = slider.getAttribute('aria-valuenow');
    slider.focus();
    slider.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 300));
    const yearAfter = slider.getAttribute('aria-valuenow');
    const after = m.layers.get('ancient-sites')?.module?.getStats?.().count;
    return { before, after, yearBefore, yearAfter };
  });
  check(
    'ancient register is decoupled from the year dial',
    decoupled.before === expectedCount &&
      decoupled.after === expectedCount &&
      decoupled.yearBefore !== decoupled.yearAfter,
    JSON.stringify(decoupled),
  );

  // ── worldwide sweep: clustering, badge clicks, singles, sweep dossier ──
  //
  // World zoom: the sweep must collapse into a handful of gold badges, not
  // ~81k individual primitives.
  await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    const ellipsoid = viewer.scene.globe.ellipsoid;
    viewer.camera.cancelFlight();
    viewer.camera.setView({
      destination: ellipsoid.cartographicToCartesian({
        longitude: 0,
        latitude: (15 * Math.PI) / 180,
        height: 20_000_000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  });
  await new Promise((r) => setTimeout(r, 700));
  const worldZoom = await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('ancient-sites')
      ?.module?.getRenderDiagnostics?.(),
  );
  const worldPrimitives =
    (worldZoom?.heroCount || 0) +
    (worldZoom?.clusterCount || 0) +
    (worldZoom?.singleCount || 0);
  check(
    'at world zoom the sweep renders as badges, with rendered primitives far below the site count',
    worldZoom?.clusterCount > 0 && worldPrimitives < 5000,
    JSON.stringify({ ...worldZoom, worldPrimitives, expectedCount }),
  );

  // Click the densest badge: the camera should fly one band closer and the
  // grid should re-coarsen (a smaller cellDeg) at the new height. Re-centre
  // the (still world-zoom) camera on the cluster's own coordinates first:
  // `cartesianToCanvasCoordinates` does not test globe occlusion, so a
  // cluster on the far side of the initial arbitrary vantage would otherwise
  // project to a plausible-looking but unclickable canvas point.
  const clusterClick = worldZoom?.topCluster
    ? await page.evaluate((cluster) => {
        const viewer = window.__godsEyeView.viewer;
        const ellipsoid = viewer.scene.globe.ellipsoid;
        viewer.camera.cancelFlight();
        viewer.camera.setView({
          destination: ellipsoid.cartographicToCartesian({
            longitude: (cluster.lon * Math.PI) / 180,
            latitude: (cluster.lat * Math.PI) / 180,
            height: 20_000_000,
          }),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        const target = ellipsoid.cartographicToCartesian({
          longitude: (cluster.lon * Math.PI) / 180,
          latitude: (cluster.lat * Math.PI) / 180,
          height: 0,
        });
        const canvasPoint = viewer.scene.cartesianToCanvasCoordinates(target);
        return canvasPoint ? { x: canvasPoint.x, y: canvasPoint.y } : null;
      }, worldZoom.topCluster)
    : null;
  await new Promise((r) => setTimeout(r, 700));
  if (clusterClick) {
    await page.mouse.click(clusterClick.x, clusterClick.y);
    // Badge breakdown (task 2, ancient-legibility): a one-line type
    // breakdown shows while the camera flies one band closer - read it well
    // before the 1.5s flight settles (the wait below is deliberately
    // shorter than that).
    await new Promise((r) => setTimeout(r, 300));
    const breakdown = await page.evaluate(() => {
      const plate = document.querySelector('.uap-cluster-breakdown');
      return {
        found: !!plate,
        visible: plate ? !plate.hidden : false,
        text: plate?.textContent || '',
      };
    });
    const sweepTypeNames = [
      'circle',
      'geoglyph',
      'megalith',
      'mound',
      'settlement',
    ];
    check(
      'clicking a cluster badge shows a one-line type breakdown while flying closer',
      breakdown.found &&
        breakdown.visible &&
        /\d+ sites?:/.test(breakdown.text) &&
        sweepTypeNames.some((t) => breakdown.text.toLowerCase().includes(t)),
      JSON.stringify(breakdown),
    );
    await new Promise((r) => setTimeout(r, 2200));
    const afterClusterClick = await page.evaluate(() => ({
      diag: window.__godsEyeView.dataManager.layers
        .get('ancient-sites')
        ?.module?.getRenderDiagnostics?.(),
      breakdownHidden:
        document.querySelector('.uap-cluster-breakdown')?.hidden ?? null,
    }));
    check(
      'clicking a cluster badge flies the camera one band closer and re-clusters at finer resolution',
      afterClusterClick.diag?.cameraHeight < worldZoom.cameraHeight &&
        afterClusterClick.diag?.cellDeg < worldZoom.cellDeg,
      JSON.stringify({ before: worldZoom, after: afterClusterClick.diag }),
    );
    check(
      'the badge breakdown plate auto-dismisses once the camera settles',
      afterClusterClick.breakdownHidden === true,
      JSON.stringify(afterClusterClick),
    );
  } else {
    check(
      'clicking a cluster badge flies the camera one band closer',
      false,
      'no cluster badge found at world zoom',
    );
  }

  // Teleport directly over a real sweep site (deterministically the first
  // sweep row) below the closest clustering band: it must render as an
  // individual, pickable single, and clicking it opens a compact dossier
  // with a Wikidata link (and Wikipedia when the sweep flagged one).
  const sweepTarget = await page.evaluate(async () => {
    const res = await fetch('/ancient-sites/sites.v2.json');
    const json = await res.json();
    return {
      lat: json.sites.lat[0],
      lon: json.sites.lon[0],
      name: json.sites.name[0],
      qid: json.sites.qid[0],
      wiki: json.sites.wiki[0],
    };
  });
  // setView plus the canvas-point computation for `site`, in one synchronous
  // evaluate call: the camera-to-screen projection is read in the same tick
  // the camera is (re)set. Reused below to recompute the click point fresh
  // immediately before the actual click, rather than reusing a point
  // computed well before it fires.
  const setViewAndProject = (site) => {
    const viewer = window.__godsEyeView.viewer;
    const ellipsoid = viewer.scene.globe.ellipsoid;
    viewer.camera.cancelFlight();
    viewer.camera.setView({
      destination: ellipsoid.cartographicToCartesian({
        longitude: (site.lon * Math.PI) / 180,
        latitude: (site.lat * Math.PI) / 180,
        height: 50_000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    const target = ellipsoid.cartographicToCartesian({
      longitude: (site.lon * Math.PI) / 180,
      latitude: (site.lat * Math.PI) / 180,
      height: 0,
    });
    const canvasPoint = viewer.scene.cartesianToCanvasCoordinates(target);
    return canvasPoint ? { x: canvasPoint.x, y: canvasPoint.y } : null;
  };
  await page.evaluate(setViewAndProject, sweepTarget);
  await new Promise((r) => setTimeout(r, 700));
  const closeZoom = await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('ancient-sites')
      ?.module?.getRenderDiagnostics?.(),
  );
  check(
    'zoomed in close over a sweep site, individual points return as singles (no clustering)',
    closeZoom?.cellDeg === 0 && closeZoom?.singleCount > 0,
    JSON.stringify(closeZoom),
  );

  // Ambient sweep-name labels (task 3, ancient-legibility): this exact spot
  // (the first sweep row) is a sparse-but-nonzero close-zoom area, measured
  // at 29 singles - comfortably under the ~30 cap - so the closest band's
  // ambient labels should be showing here, carrying the site's real name,
  // through the sibling `ancient-sites-sweep` overlay source (see
  // model.js's ANCIENT_SWEEP_LABEL_CAP and index.js's syncSweepLabels).
  // Camera is unchanged from the check just above.
  await page.evaluate(() => window.__godsEyeView.viewer.scene.requestRender());
  await new Promise((r) => setTimeout(r, 500));
  const sweepLabel = await page.evaluate(async () => {
    const { getOverlayPaintRect, getWorldOverlayDiagnostics } =
      await import('/src/overlays/worldOverlay.js');
    const rect = getOverlayPaintRect('ancient-sites-sweep', 'ancient:sweep:0');
    return {
      title: rect?.entry?.title ?? null,
      sweepEntries:
        getWorldOverlayDiagnostics().entriesBySource?.['ancient-sites-sweep'] ??
        0,
    };
  });
  check(
    'a known sweep site name appears in the ambient overlay labels at close range over a sparse area',
    sweepLabel.title === sweepTarget.name && sweepLabel.sweepEntries > 0,
    JSON.stringify({ sweepLabel, expectedName: sweepTarget.name }),
  );

  // Recompute the click point fresh, right before clicking (see
  // setViewAndProject's own comment above).
  const sweepClick = await page.evaluate(setViewAndProject, sweepTarget);
  let sweepDossier = { open: false };
  if (sweepClick) {
    await page.mouse.click(sweepClick.x, sweepClick.y);
    await page
      .waitForFunction(
        () => {
          const d = document.querySelector('.uap-dossier.ancient');
          return d && !d.hidden;
        },
        { timeout: 8000 },
      )
      .catch(() => {});
    sweepDossier = await page.evaluate(() => {
      const d = document.querySelector('.uap-dossier.ancient');
      const open = d && !d.hidden;
      const text = d ? d.textContent : '';
      const links = d ? [...d.querySelectorAll('.uap-source a')] : [];
      const wikidataHref =
        links.find((a) => a.textContent.trim() === 'Wikidata')?.href ?? null;
      const wikipediaHref =
        links.find((a) => a.textContent.trim() === 'Wikipedia')?.href ?? null;
      d?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      return { open, text, wikidataHref, wikipediaHref };
    });
  }
  check(
    'clicking a rendered sweep site opens a compact dossier with its name',
    sweepDossier.open === true && sweepDossier.text.includes(sweepTarget.name),
    JSON.stringify({ open: sweepDossier.open, name: sweepTarget.name }),
  );
  check(
    'sweep dossier carries a Wikidata link for the site',
    typeof sweepDossier.wikidataHref === 'string' &&
      sweepDossier.wikidataHref.includes(
        `wikidata.org/wiki/${sweepTarget.qid}`,
      ),
    String(sweepDossier.wikidataHref),
  );
  check(
    'sweep dossier carries no photo or debated line (hero-only fields)',
    !sweepDossier.text.includes('Photo:') &&
      !sweepDossier.text.includes('Debated:'),
    JSON.stringify({ textLength: sweepDossier.text.length }),
  );
  if (sweepTarget.wiki) {
    check(
      'sweep dossier carries a Wikipedia link when the sweep flagged one',
      typeof sweepDossier.wikipediaHref === 'string' &&
        sweepDossier.wikipediaHref.includes('en.wikipedia.org/wiki/'),
      String(sweepDossier.wikipediaHref),
    );
  }

  // Zooming out one band from that same sparse spot (past the closest-band
  // threshold, cellDeg no longer 0) must clear the ambient sweep-name
  // labels outright, while the hero labels keep working exactly as before.
  // Run after the sweep-dossier click above (not interleaved with it), for
  // the same reason the skyward-fallback check below waits its turn: a
  // camera repositioned away and instantly back would otherwise leave the
  // pre-existing click test racing the renderer's own throttled recompute.
  await page.evaluate((site) => {
    const viewer = window.__godsEyeView.viewer;
    const ellipsoid = viewer.scene.globe.ellipsoid;
    viewer.camera.cancelFlight();
    viewer.camera.setView({
      destination: ellipsoid.cartographicToCartesian({
        longitude: (site.lon * Math.PI) / 180,
        latitude: (site.lat * Math.PI) / 180,
        height: 600_000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  }, sweepTarget);
  await new Promise((r) => setTimeout(r, 700));
  await page.evaluate(() => window.__godsEyeView.viewer.scene.requestRender());
  await new Promise((r) => setTimeout(r, 500));
  const sweepLabelsAfterZoomOut = await page.evaluate(async () => {
    const { getWorldOverlayDiagnostics } =
      await import('/src/overlays/worldOverlay.js');
    const diag = window.__godsEyeView.dataManager.layers
      .get('ancient-sites')
      ?.module?.getRenderDiagnostics?.();
    const host = getWorldOverlayDiagnostics();
    return {
      cellDeg: diag?.cellDeg,
      sweepEntries: host.entriesBySource?.['ancient-sites-sweep'] ?? 0,
      heroEntries: host.entriesBySource?.['ancient-sites'] ?? 0,
    };
  });
  check(
    'zooming out one band clears the ambient sweep-name labels while hero labels keep working',
    sweepLabelsAfterZoomOut.cellDeg > 0 &&
      sweepLabelsAfterZoomOut.sweepEntries === 0 &&
      sweepLabelsAfterZoomOut.heroEntries > 0,
    JSON.stringify(sweepLabelsAfterZoomOut),
  );

  // Close-range legibility (task 1, ancient-legibility): zoom into a dense
  // sweep area - Carnac, France, one of the densest concentrations of
  // megalithic standing stones in the dataset - and prove the closest
  // band's singles render as billboards (a gold glyph over a dark halo, see
  // rendering.js's renderSweepSingles), not the near-invisible flat dots the
  // pre-task screenshots complained about, and that this still stays
  // bounded rather than turning into one primitive per site in the area.
  await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    const ellipsoid = viewer.scene.globe.ellipsoid;
    viewer.camera.cancelFlight();
    viewer.camera.setView({
      destination: ellipsoid.cartographicToCartesian({
        longitude: (-3.08 * Math.PI) / 180,
        latitude: (47.61 * Math.PI) / 180,
        height: 50_000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  });
  await new Promise((r) => setTimeout(r, 900));
  const carnacZoom = await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('ancient-sites')
      ?.module?.getRenderDiagnostics?.(),
  );
  check(
    'close zoom over a dense area (Carnac) renders singles as bounded billboards',
    carnacZoom?.cellDeg === 0 &&
      carnacZoom?.billboardCount > 0 &&
      carnacZoom?.billboardCount < 5000,
    JSON.stringify(carnacZoom),
  );

  // Regression: at close range with the camera pitched above the horizon,
  // computeViewRectangle() returns nothing to bound unclustered singles
  // against. Without a fallback this used to render all ~81k sweep sites as
  // individual primitives in one frame, defeating the whole banding scheme.
  // Run after the sweep-dossier click above (not interleaved with it) since
  // this repositions the camera and would otherwise invalidate that click's
  // precomputed canvas coordinates.
  await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    const ellipsoid = viewer.scene.globe.ellipsoid;
    viewer.camera.cancelFlight();
    viewer.camera.setView({
      destination: ellipsoid.cartographicToCartesian({
        longitude: 0,
        latitude: (15 * Math.PI) / 180,
        height: 100_000,
      }),
      orientation: { heading: 0, pitch: (10 * Math.PI) / 180, roll: 0 },
    });
  });
  await new Promise((r) => setTimeout(r, 700));
  const skywardZoom = await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('ancient-sites')
      ?.module?.getRenderDiagnostics?.(),
  );
  const skywardPrimitives =
    (skywardZoom?.heroCount || 0) +
    (skywardZoom?.clusterCount || 0) +
    (skywardZoom?.singleCount || 0);
  check(
    'camera pitched skyward at close range never renders the unbounded sweep',
    skywardPrimitives < 5000,
    JSON.stringify({ ...skywardZoom, skywardPrimitives, expectedCount }),
  );

  const dossier = await page.evaluate(async () => {
    const m = window.__godsEyeView.dataManager;
    const mod = m.layers.get('ancient-sites').module;
    await mod.focusSite('gobekli-tepe');
    await new Promise((r) => setTimeout(r, 400));
    const d = document.querySelector('.uap-dossier.ancient');
    const open = d && !d.hidden;
    const text = d ? d.textContent : '';
    const link = d ? d.querySelector('a') : null;
    const hasDebated = !!d?.querySelector('.uap-debated');
    const linkText = link ? link.textContent.trim() : null;
    const photo = d ? d.querySelector('.uap-photo') : null;
    const photoHost = photo ? new URL(photo.src).hostname : null;
    const creditText =
      d?.querySelector('.uap-photo-credit')?.textContent.trim() ?? null;
    const wikipediaLink = d
      ? [...d.querySelectorAll('.uap-source a')].find(
          (a) => a.textContent.trim() === 'Wikipedia',
        )
      : null;
    const wikipediaHref = wikipediaLink ? wikipediaLink.href : null;
    const streetViewLink = d
      ? [...d.querySelectorAll('.uap-source a')].find(
          (a) => a.textContent.trim() === 'Street view',
        )
      : null;
    const streetViewHref = streetViewLink ? streetViewLink.href : null;
    const streetViewHost = streetViewLink
      ? new URL(streetViewLink.href).host
      : null;
    d?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    return {
      open,
      text,
      hasDebated,
      linkText,
      closed: d ? d.hidden : null,
      photoHost,
      creditText,
      wikipediaHref,
      streetViewHref,
      streetViewHost,
    };
  });
  check(
    'focusSite opens the dossier with a debated line',
    dossier.open === true &&
      dossier.hasDebated &&
      dossier.text.includes('Debated'),
    JSON.stringify({ open: dossier.open, hasDebated: dossier.hasDebated }),
  );
  check(
    'dossier carries an Open record link',
    dossier.linkText === 'Open record',
    String(dossier.linkText),
  );
  check(
    'dossier photo resolves from an allowed Wikimedia host',
    dossier.photoHost === 'upload.wikimedia.org' ||
      dossier.photoHost === 'commons.wikimedia.org',
    String(dossier.photoHost),
  );
  check(
    'dossier carries a photo credit line',
    typeof dossier.creditText === 'string' &&
      dossier.creditText.startsWith('Photo:'),
    String(dossier.creditText),
  );
  check(
    'dossier carries a Wikipedia link',
    typeof dossier.wikipediaHref === 'string' &&
      dossier.wikipediaHref.includes('wikipedia.org'),
    String(dossier.wikipediaHref),
  );
  check(
    'dossier carries a Street view link to the site coordinates',
    dossier.streetViewHost === 'www.google.com' &&
      typeof dossier.streetViewHref === 'string' &&
      dossier.streetViewHref.includes('37.2231'),
    JSON.stringify({
      streetViewHost: dossier.streetViewHost,
      streetViewHref: dossier.streetViewHref,
    }),
  );
  check('Escape closes the dossier', dossier.closed === true);

  check(
    'no page errors during the interactive pass',
    pageErrors.length === 0,
    pageErrors.join(' | '),
  );

  const fresh = await browser.createBrowserContext();
  const share = await fresh.newPage();
  await share.goto(
    `${base}/?welcome=0#lat=37.22&lon=38.92&alt=26000000&pitch=-90&v=2&l=4`,
    { waitUntil: 'domcontentloaded' },
  );
  await share.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 60000,
  });
  await share
    .waitForFunction(
      () => window.__godsEyeView.dataManager.isEnabled('ancient-sites'),
      { timeout: 30000 },
    )
    .catch(() => {});
  const restored = await share.evaluate(() =>
    window.__godsEyeView.dataManager.isEnabled('ancient-sites'),
  );
  check('share link with token 4 restores the layer', restored === true);

  const freshBoth = await browser.createBrowserContext();
  const both = await freshBoth.newPage();
  await both.goto(
    `${base}/?welcome=0#lat=37.22&lon=38.92&alt=26000000&pitch=-90&v=2&l=3.4`,
    { waitUntil: 'domcontentloaded' },
  );
  await both.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 60000,
  });
  await both
    .waitForFunction(
      () =>
        window.__godsEyeView.dataManager.isEnabled('ancient-sites') &&
        window.__godsEyeView.dataManager.isEnabled('anomalies'),
      { timeout: 30000 },
    )
    .catch(() => {});
  const restoredBoth = await both.evaluate(() => ({
    ancient: window.__godsEyeView.dataManager.isEnabled('ancient-sites'),
    anomalies: window.__godsEyeView.dataManager.isEnabled('anomalies'),
  }));
  check(
    'combined share link l=3.4 restores both layers',
    restoredBoth.ancient === true && restoredBoth.anomalies === true,
    JSON.stringify(restoredBoth),
  );
} finally {
  await browser.close();
}
console.log(`RESULT: ${failures} failures`);
process.exit(failures ? 1 : 0);
