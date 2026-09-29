#!/usr/bin/env node
/**
 * Browser proof of the anomalies layer acceptance: registration, sample data,
 * chronometer ring and band layouts, keyboard year control, dossier open and
 * close, an off/on re-enable with hero overlay labels surviving, and
 * share-link restore via token 3. Needs the dev server on :4173 (QA_BASE_URL
 * overrides).
 */
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHAPE_GLYPH_URLS } from '../src/layers/anomalies/shapeGlyphs.js';
import { statusHue } from '../src/layers/anomalies/model.js';
import { WAVES } from '../src/layers/anomalies/waves.js';
const base = process.env.QA_BASE_URL || 'http://localhost:4173';
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
// Shared with qa-claims.mjs and qa-ancient-sites.mjs (task: presence pass):
// each writes its own distinctly-named files into this one directory.
const PRESENCE_SHOT_DIR = resolve(REPO_ROOT, 'qa-shots/presence-pass');
mkdirSync(PRESENCE_SHOT_DIR, { recursive: true });
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
    `[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? `: ${detail}` : ''}`,
  );
  if (!passed) failures++;
};

/**
 * Mean luminance (0-255) and the brightest surviving colour's saturation,
 * sampled from a full-page screenshot decoded back to a 2D canvas inside the
 * page (the same PNG-round-trip idiom qa-label-readability.mjs uses to read
 * a WebGL canvas's actual pixels). Saturation only counts pixels bright
 * enough (max channel > 80) to be an actual point, craft or heat pixel, so
 * the near-black void's own tiny channel noise never reads as "saturated".
 */
async function measureFrame(page) {
  const base64 = await page.screenshot({ encoding: 'base64' });
  return page.evaluate(async (b64) => {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = `data:image/png;base64,${b64}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const x0 = Math.round(image.width * 0.1);
    const x1 = Math.round(image.width * 0.9);
    const y0 = Math.round(image.height * 0.1);
    const y1 = Math.round(image.height * 0.9);
    const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let sum = 0;
    let count = 0;
    let maxSaturation = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      sum += r * 0.2126 + g * 0.7152 + b * 0.0722;
      count++;
      const max = Math.max(r, g, b);
      if (max > 80) {
        const sat = (max - Math.min(r, g, b)) / max;
        if (sat > maxSaturation) maxSaturation = sat;
      }
    }
    return { meanLuminance: sum / count, maxSaturation };
  }, base64);
}

try {
  const isolated = await browser.createBrowserContext();
  const page = await isolated.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`${base}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 60000,
  });

  const present = await page.evaluate(() => {
    const m = window.__godsEyeView.dataManager;
    return {
      has: m.layers.has('anomalies'),
      enabled: m.isEnabled('anomalies'),
    };
  });
  check(
    'anomalies layer registered and initially off',
    present.has && !present.enabled,
    JSON.stringify(present),
  );

  // The real dataset's size is read from stats.json rather than pinned, so
  // this gate stays valid as GEIPAN, Blue Book and future sources grow it.
  const statsCount = await page.evaluate(async () => {
    const r = await fetch('/anomalies/stats.json');
    return (await r.json()).count;
  });
  check(
    'stats.json reports at least 3,000 records',
    Number.isInteger(statsCount) && statsCount >= 3000,
    String(statsCount),
  );

  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('anomalies', true, {
      origin: 'user',
    }),
  );
  await page.waitForFunction(
    (expected) =>
      window.__godsEyeView.dataManager.layers
        .get('anomalies')
        ?.module?.getStats?.().count === expected,
    { timeout: 30000 },
    statsCount,
  );
  check(
    'real dataset loaded after toggle on, matching stats.json',
    true,
    `count=${statsCount}`,
  );

  await page.evaluate(() => {
    const cam = window.__godsEyeView.viewer.camera;
    cam.cancelFlight?.();
    const p = cam.positionWC;
    const k = 26.0e6 / Math.hypot(p.x, p.y, p.z);
    cam.setView({ destination: new p.constructor(p.x * k, p.y * k, p.z * k) });
    window.__godsEyeView.viewer.scene.requestRender();
  });
  await page
    .waitForFunction(
      () => document.querySelector('.uap-chrono')?.dataset.layout === 'ring',
      { timeout: 10000 },
    )
    .catch(() => {});
  const chrono = await page.evaluate(() => {
    const root = document.querySelector('.uap-chrono');
    const slider = document.querySelector('.uap-slider');
    return root && slider
      ? {
          layout: root.dataset.layout,
          year: slider.getAttribute('aria-valuenow'),
        }
      : null;
  });
  check(
    'chronometer wraps the globe when zoomed out',
    chrono?.layout === 'ring',
    JSON.stringify(chrono),
  );

  // Documented report waves (task 2, atlas-instruments): a small landmark
  // mark on the sky dial's corona for each entry in waves.js, checked here
  // while the dial is in its ring layout from the step just above.
  const landmarkCount = await page.evaluate(
    () => document.querySelectorAll('.uap-landmark').length,
  );
  check(
    'the sky dial carries exactly one landmark mark per documented report wave',
    landmarkCount === WAVES.length,
    `marks=${landmarkCount} waves=${WAVES.length}`,
  );

  const wave1952 = WAVES.find((w) => w.year === 1952);
  const landmark1952 = await page.evaluate(() => {
    const mark = document.querySelector('.uap-landmark[data-year="1952"]');
    mark?.focus();
    const plate = document.querySelector('.uap-landmark-plate');
    const opened = !!plate && !plate.hidden;
    const label = plate?.querySelector('.uap-landmark-label')?.textContent;
    const note = plate?.querySelector('.uap-landmark-note')?.textContent;
    const link = plate?.querySelector('.uap-landmark-link');
    const href = link && !link.hidden ? link.getAttribute('href') : null;
    // Fix 1 (atlas-instruments): aria-describedby ties the mark to its own
    // plate, so assistive tech announces the note on focus.
    const describesPlate =
      !!plate?.id && mark?.getAttribute('aria-describedby') === plate.id;

    // Fix 1's core repro: the pointer crosses the visual gap between the
    // mark and the plate (mouseleave on the mark, then mouseenter on the
    // plate - the plate never receives a mouseenter without a leave first
    // in a real drag, but the two overlapping here is exactly what proves
    // the plate stays open through the gap rather than vanishing on the
    // mark's own mouseleave). Dispatched synchronously, well inside the
    // close-scheduling delay chronometer.js now uses.
    mark?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    plate?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    const survivesPointerGap = plate ? !plate.hidden : null;

    // The source link must be a real, reachable click target: intercept its
    // default navigation (this check must never actually leave the page)
    // and confirm the click itself lands and the plate is still open
    // immediately afterwards, proving the plate never closed underneath
    // the pointer on the way to the link.
    let linkClicked = false;
    const onClick = (e) => {
      linkClicked = true;
      e.preventDefault();
    };
    link?.addEventListener('click', onClick, { capture: true });
    link?.click();
    link?.removeEventListener('click', onClick, { capture: true });
    const openAfterLinkClick = plate ? !plate.hidden : null;

    mark?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    const closedAfterEscape = plate ? plate.hidden : null;
    return {
      found: !!mark,
      opened,
      label,
      note,
      href,
      describesPlate,
      survivesPointerGap,
      linkClicked,
      openAfterLinkClick,
      closedAfterEscape,
    };
  });
  check(
    'focusing the 1952 landmark mark opens the note plate with its own label and note',
    landmark1952.found &&
      landmark1952.opened === true &&
      landmark1952.label === wave1952?.label &&
      landmark1952.note === wave1952?.note,
    JSON.stringify(landmark1952),
  );
  check(
    "the 1952 landmark's note plate carries an https source link",
    typeof landmark1952.href === 'string' &&
      landmark1952.href.startsWith('https://'),
    JSON.stringify({ href: landmark1952.href }),
  );
  check(
    "the mark's aria-describedby names its own plate",
    landmark1952.describesPlate === true,
    JSON.stringify({ describesPlate: landmark1952.describesPlate }),
  );
  check(
    'the note plate survives the pointer crossing the gap from the mark to the plate',
    landmark1952.survivesPointerGap === true,
    JSON.stringify({ survivesPointerGap: landmark1952.survivesPointerGap }),
  );
  check(
    'a real click lands on the source link, and the plate is still open right after',
    landmark1952.linkClicked === true &&
      landmark1952.openAfterLinkClick === true,
    JSON.stringify({
      linkClicked: landmark1952.linkClicked,
      openAfterLinkClick: landmark1952.openAfterLinkClick,
    }),
  );
  check(
    'Escape closes the landmark note plate',
    landmark1952.closedAfterEscape === true,
    JSON.stringify({ closedAfterEscape: landmark1952.closedAfterEscape }),
  );

  // Phase 5b deep-time dial: the sky register's own dial must behave
  // exactly as it did before the ancient layer gained a second scale.
  // Ancient sites is still off at this point in this script, so the only
  // chronometer in the DOM is the sky one, at its original plain calendar
  // bounds.
  const skyDialUnaffected = await page.evaluate(() => {
    const m = window.__godsEyeView.dataManager;
    const slider = document.querySelector('.uap-slider');
    const cumulativeMode = document.querySelector('[data-mode="cumulative"]');
    return {
      ancientEnabled: m.isEnabled('ancient-sites'),
      min: slider?.getAttribute('aria-valuemin'),
      max: slider?.getAttribute('aria-valuemax'),
      ariaLabel: slider?.getAttribute('aria-label'),
      modeLabel: cumulativeMode?.textContent.trim() || null,
    };
  });
  check(
    'sky mode is unaffected: the 1940-2026 dial still drives the anomalies layer with ancient off, and its mode label still reads "Up to year"',
    skyDialUnaffected.ancientEnabled === false &&
      skyDialUnaffected.min === '1940' &&
      skyDialUnaffected.max === '2026' &&
      skyDialUnaffected.ariaLabel === 'Year' &&
      skyDialUnaffected.modeLabel === 'Up to year',
    JSON.stringify(skyDialUnaffected),
  );

  const arrow = await page.evaluate(() => {
    const slider = document.querySelector('.uap-slider');
    const before = slider.getAttribute('aria-valuenow');
    slider.focus();
    slider.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    );
    return { before, after: slider.getAttribute('aria-valuenow') };
  });
  check(
    'arrow keys change the year',
    arrow.before !== arrow.after,
    `${arrow.before} -> ${arrow.after}`,
  );

  const playBefore = await page.evaluate(() => {
    const slider = document.querySelector('.uap-slider');
    const before = slider.getAttribute('aria-valuenow');
    document.querySelector('.uap-play').click();
    return before;
  });
  await page
    .waitForFunction(
      (before) =>
        document.querySelector('.uap-slider').getAttribute('aria-valuenow') !==
        before,
      { timeout: 10000 },
      playBefore,
    )
    .catch(() => {});
  const play = await page.evaluate((before) => {
    const slider = document.querySelector('.uap-slider');
    const btn = document.querySelector('.uap-play');
    const after = slider.getAttribute('aria-valuenow');
    if (btn.getAttribute('aria-pressed') === 'true') btn.click();
    return { before, after };
  }, playBefore);
  check(
    'play steps through years',
    play.before !== play.after,
    `${play.before} -> ${play.after}`,
  );

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

  const reenable = await page.evaluate(async () => {
    const m = window.__godsEyeView.dataManager;
    await m.setEnabled('anomalies', false, { origin: 'user' });
    await m.setEnabled('anomalies', true, { origin: 'user' });
    const { getWorldOverlayDiagnostics } =
      await import('/src/overlays/worldOverlay.js');
    return {
      enabled: m.isEnabled('anomalies'),
      count: m.layers.get('anomalies')?.module?.getStats?.().count,
      overlayEntries:
        getWorldOverlayDiagnostics().entriesBySource?.anomalies || 0,
    };
  });
  check(
    'layer re-enables cleanly after first load',
    reenable.enabled === true && reenable.count === statsCount,
    JSON.stringify(reenable),
  );
  check(
    'hero overlay labels survive an off/on toggle',
    reenable.overlayEntries === 24,
    JSON.stringify(reenable),
  );

  await page.evaluate(() => {
    const cam = window.__godsEyeView.viewer.camera;
    cam.cancelFlight?.();
    const p = cam.positionWC;
    const k = (6378137 + 4000) / Math.hypot(p.x, p.y, p.z);
    cam.setView({ destination: new p.constructor(p.x * k, p.y * k, p.z * k) });
    window.__godsEyeView.viewer.scene.requestRender();
  });
  await page
    .waitForFunction(
      () => document.querySelector('.uap-chrono')?.dataset.layout === 'band',
      { timeout: 10000 },
    )
    .catch(() => {});
  const band = await page.evaluate(
    () => document.querySelector('.uap-chrono')?.dataset.layout,
  );
  check(
    'chronometer collapses to a bottom band when zoomed in',
    band === 'band',
    String(band),
  );

  const dossier = await page.evaluate(async () => {
    const m = window.__godsEyeView.dataManager;
    const mod = m.layers.get('anomalies').module;
    const records = mod.getAnalystRecords(5);
    const id = records[0]?.id || records[0]?.caseId;
    await mod.focusCase(id || 'case-los-angeles-1942');
    await new Promise((r) => setTimeout(r, 400));
    const d = document.querySelector('.uap-dossier');
    const open = d && !d.hidden;
    d?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    return { open, closed: d ? d.hidden : null };
  });
  check('focusCase opens the dossier', dossier.open === true);
  check('Escape closes the dossier', dossier.closed === true);

  // Task 3, luminous-pins: the dossier header carries an animated craft
  // preview (src/ui/craftPreview.js) for any case whose shape resolves to a
  // shipped glyph - which every anomaly row does, since records.js already
  // defaults a missing craft to 'orb' at decode time. The expected glyph
  // URL and accent hue are pulled from the SAME source modules the layer
  // itself imports (shapeGlyphs.js's SHAPE_GLYPH_URLS, model.js's
  // statusHue), fetched here in Node, rather than hardcoded, so this check
  // stays honest against either table changing shape.
  const previewCase = await page.evaluate(async () => {
    const m = window.__godsEyeView.dataManager;
    const mod = m.layers.get('anomalies').module;
    const records = mod.getAnalystRecords(5);
    const record = records.find((r) => r.craft && r.status) || records[0];
    await mod.focusCase(record.id);
    await new Promise((r) => setTimeout(r, 400));
    const d = document.querySelector('.uap-dossier');
    const preview = d?.querySelector('.uap-craft-preview');
    const img = preview?.querySelector('.uap-craft-preview-glyph');
    const result = {
      craft: record.craft,
      status: record.status,
      found: !!preview,
      src: img ? img.getAttribute('src') : null,
      alt: img ? img.getAttribute('alt') : null,
      loading: img ? img.getAttribute('loading') : null,
      accent: preview
        ? preview.style.getPropertyValue('--uap-preview-accent').trim()
        : null,
    };
    d?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    return result;
  });
  check(
    "a shaped case's dossier shows the animated craft preview with the matching glyph, loaded lazily",
    previewCase.found &&
      previewCase.src === SHAPE_GLYPH_URLS[previewCase.craft] &&
      previewCase.loading === 'lazy' &&
      !!previewCase.alt,
    JSON.stringify(previewCase),
  );
  check(
    "the craft preview's accent border matches the case's own status hue",
    previewCase.accent?.toLowerCase() ===
      statusHue(previewCase.status).toLowerCase(),
    JSON.stringify(previewCase),
  );

  // Reduced motion: the preview's drift and sheen are pure CSS keyframes
  // (anomaly-atlas.css's .uap-craft-preview rules), so a computed-style
  // read proves the guard directly - no diagnostics function needed, unlike
  // live claims' JS-driven pulse (qa-claims.mjs). A fresh, isolated page
  // per branch, since prefers-reduced-motion is set once at page creation.
  async function craftPreviewAnimationNames(reduceMotion) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    if (reduceMotion) {
      await p.emulateMediaFeatures([
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ]);
    }
    await p.goto(`${base}/?welcome=0`, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => window.__godsEyeView?.dataManager, {
      timeout: 60000,
    });
    // A fresh page starts with the layer registered but off (see "anomalies
    // layer registered and initially off" above): enable it and wait for
    // real rows before asking for a record to focus.
    await p.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('anomalies', true, {
        origin: 'user',
      }),
    );
    await p.waitForFunction(
      () =>
        (window.__godsEyeView.dataManager.layers
          .get('anomalies')
          ?.module?.getStats?.().count ?? 0) > 0,
      { timeout: 30000 },
    );
    const names = await p.evaluate(async () => {
      const m = window.__godsEyeView.dataManager;
      const mod = m.layers.get('anomalies').module;
      const records = mod.getAnalystRecords(5);
      const record = records.find((r) => r.craft && r.status) || records[0];
      await mod.focusCase(record.id);
      await new Promise((r) => setTimeout(r, 400));
      const preview = document.querySelector('.uap-dossier .uap-craft-preview');
      const glyph = preview?.querySelector('.uap-craft-preview-glyph');
      return {
        found: !!preview,
        glyphAnimation: glyph ? getComputedStyle(glyph).animationName : null,
        sheenAnimation: preview
          ? getComputedStyle(preview, '::after').animationName
          : null,
      };
    });
    await ctx.close();
    return names;
  }
  const reducedNames = await craftPreviewAnimationNames(true);
  check(
    'the craft preview drift and sheen never run under prefers-reduced-motion',
    reducedNames.found &&
      reducedNames.glyphAnimation === 'none' &&
      reducedNames.sheenAnimation === 'none',
    JSON.stringify(reducedNames),
  );
  const fullMotionNames = await craftPreviewAnimationNames(false);
  check(
    'the craft preview drift and sheen do run without prefers-reduced-motion (the reduced-motion guard above is a real bypass)',
    fullMotionNames.found &&
      fullMotionNames.glyphAnimation === 'uap-craft-preview-drift' &&
      fullMotionNames.sheenAnimation === 'uap-craft-preview-sheen',
    JSON.stringify(fullMotionNames),
  );

  // Cross-click dossier switch (feat/atlas: the Void style and spectrum
  // accents, piece 6): with one dossier open, a real click on a different
  // anomaly point must replace it in the same gesture, no Close step in
  // between (regression: clicking a different point used to do nothing
  // until Close was pressed). Compares the dl (When/Where/...) rather than
  // the title, since non-hero cases default their title to plain "Report".
  const clickSwitchTargets = await page.evaluate(async () => {
    const r = await fetch('/anomalies/anomalies.v1.json');
    const json = await r.json();
    const cols = json.columns;
    const picked = [];
    for (let i = 0; i < cols.id.length && picked.length < 2; i++) {
      if (typeof cols.lat[i] === 'number' && typeof cols.lon[i] === 'number')
        picked.push({ lat: cols.lat[i], lon: cols.lon[i] });
    }
    return picked;
  });
  const projectAt = (site) => {
    const viewer = window.__godsEyeView.viewer;
    const ellipsoid = viewer.scene.globe.ellipsoid;
    viewer.camera.cancelFlight();
    viewer.camera.setView({
      destination: ellipsoid.cartographicToCartesian({
        longitude: (site.lon * Math.PI) / 180,
        latitude: (site.lat * Math.PI) / 180,
        height: 20000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    const target = ellipsoid.cartographicToCartesian({
      longitude: (site.lon * Math.PI) / 180,
      latitude: (site.lat * Math.PI) / 180,
      height: 0,
    });
    const p = viewer.scene.cartesianToCanvasCoordinates(target);
    return p ? { x: p.x, y: p.y } : null;
  };
  const clickSwitch = {
    firstOpen: false,
    firstDl: '',
    secondOpen: false,
    secondDl: '',
  };
  if (clickSwitchTargets.length === 2) {
    const [siteA, siteB] = clickSwitchTargets;
    const clickA = await page.evaluate(projectAt, siteA);
    if (clickA) {
      await page.mouse.click(clickA.x, clickA.y);
      await page
        .waitForFunction(
          () => {
            const d = document.querySelector('.uap-dossier');
            return d && !d.hidden;
          },
          { timeout: 8000 },
        )
        .catch(() => {});
      const first = await page.evaluate(() => {
        const d = document.querySelector('.uap-dossier');
        return {
          open: d && !d.hidden,
          dl: d?.querySelector('dl')?.textContent || '',
        };
      });
      clickSwitch.firstOpen = first.open;
      clickSwitch.firstDl = first.dl;

      const clickB = await page.evaluate(projectAt, siteB);
      if (clickB) {
        // No Escape, no Close: the dossier is left exactly as the first
        // click opened it, then a second real click picks a different
        // point directly.
        await page.mouse.click(clickB.x, clickB.y);
        await page
          .waitForFunction(
            (prevDl) =>
              (document.querySelector('.uap-dossier dl')?.textContent || '') !==
              prevDl,
            { timeout: 8000 },
            first.dl,
          )
          .catch(() => {});
        const second = await page.evaluate(() => {
          const d = document.querySelector('.uap-dossier');
          return {
            open: d && !d.hidden,
            dl: d?.querySelector('dl')?.textContent || '',
          };
        });
        clickSwitch.secondOpen = second.open;
        clickSwitch.secondDl = second.dl;
      }
    }
  }
  check(
    'clicking a different anomaly point while a dossier is open switches it in the same gesture, no Close needed',
    clickSwitch.firstOpen === true &&
      clickSwitch.secondOpen === true &&
      clickSwitch.firstDl.length > 0 &&
      clickSwitch.secondDl !== clickSwitch.firstDl,
    JSON.stringify(clickSwitch),
  );
  await page.evaluate(() => {
    document
      .querySelector('.uap-dossier')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
  });

  // Hover and selection feedback (task: presence pass): a real mousemove
  // over a known, non-hero point sets getRenderDiagnostics().hoveredId and
  // the canvas cursor to 'pointer' once the shared hover helper's ~80ms
  // throttle (src/ui/hoverPick.js) has had time to fire; moving to a
  // pick-empty point on the same canvas clears both. Opening that point's
  // dossier then sets selectedId and adds a selection-ring billboard
  // (getDiagnostics().selectionRingCount); Escape clears both again. A
  // non-hero target is picked deliberately: heroes already carry a
  // permanent ring (the controller ruling this task follows skips a
  // second one on top of it), so a hero target would make the ring-count
  // assertion ambiguous.
  const hoverSite = await page.evaluate(async () => {
    const r = await fetch('/anomalies/anomalies.v1.json');
    const json = await r.json();
    const cols = json.columns;
    for (let i = 0; i < cols.id.length; i++) {
      if (
        typeof cols.lat[i] === 'number' &&
        typeof cols.lon[i] === 'number' &&
        !cols.hero[i]
      )
        return { lat: cols.lat[i], lon: cols.lon[i] };
    }
    return null;
  });
  const hoverPoint = hoverSite
    ? await page.evaluate(projectAt, hoverSite)
    : null;

  // Pick-cost measurement (task: presence pass, hover and selection
  // feedback): one `scene.pick` call, timed with `performance.now`, at
  // world zoom (the default boot view) and again at the close zoom the
  // hover/selection checks below actually use. The 80ms throttle in
  // src/ui/hoverPick.js bounds how often this cost is paid regardless of
  // pointer speed.
  const worldZoomPickCost = await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    const scene = viewer.scene;
    const ellipsoid = scene.globe.ellipsoid;
    viewer.camera.cancelFlight();
    viewer.camera.setView({
      destination: ellipsoid.cartographicToCartesian({
        longitude: 0,
        latitude: 0,
        height: 2.0e7,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    const canvas = scene.canvas;
    const t0 = performance.now();
    scene.pick(
      { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 },
      12,
      12,
    );
    return performance.now() - t0;
  });
  const closeZoomPickCost = hoverPoint
    ? await page.evaluate((pt) => {
        const scene = window.__godsEyeView.viewer.scene;
        const t0 = performance.now();
        scene.pick({ x: pt.x, y: pt.y }, 12, 12);
        return performance.now() - t0;
      }, hoverPoint)
    : null;
  check(
    'hover pick cost (one scene.pick, world zoom and close zoom) stays comfortably inside the 80ms throttle window',
    worldZoomPickCost < 50 &&
      (closeZoomPickCost == null || closeZoomPickCost < 50),
    `world=${worldZoomPickCost.toFixed(3)}ms close=${closeZoomPickCost == null ? 'n/a' : closeZoomPickCost.toFixed(3) + 'ms'}`,
  );

  let hoverProbe = null;
  if (hoverPoint) {
    // projectAt (above) already re-pointed the camera at hoverSite's own
    // nadir view for this call. Settled before hovering (mirrors every
    // other projectAt call in this file): the close-range shape-glyph
    // tier only populates once the renderer's own postRender/moveEnd
    // -driven recompute has actually run, not synchronously with setView.
    await page.evaluate(projectAt, hoverSite);
    await new Promise((r) => setTimeout(r, 700));
    await page.mouse.move(hoverPoint.x, hoverPoint.y);
    // Past the shared hover helper's ~80ms throttle, with margin.
    await new Promise((r) => setTimeout(r, 300));
    const hovering = await page.evaluate(() => ({
      diagnostics: window.__godsEyeView.dataManager.layers
        .get('anomalies')
        ?.module?.getRenderDiagnostics?.(),
      cursor: window.__godsEyeView.viewer.scene.canvas.style.cursor,
    }));
    await page.screenshot({
      path: resolve(PRESENCE_SHOT_DIR, 'anomalies-hover-1440.png'),
    });
    // A pixel that is (a) still the canvas element at that point (not some
    // HUD chrome sitting on top of it) and (b) genuinely pick-empty right
    // now, found by probing a handful of candidates around the hovered
    // point and the canvas corners - never assumed from screen-distance
    // alone, which a dense cluster could still populate.
    const awayPoint = await page.evaluate((around) => {
      const viewer = window.__godsEyeView.viewer;
      const scene = viewer.scene;
      const canvas = scene.canvas;
      const candidates = [
        { x: around.x + 350, y: around.y },
        { x: around.x - 350, y: around.y },
        { x: around.x, y: around.y + 250 },
        { x: around.x, y: around.y - 250 },
        { x: 30, y: canvas.clientHeight - 30 },
        { x: canvas.clientWidth - 30, y: canvas.clientHeight - 30 },
        { x: canvas.clientWidth - 30, y: 30 },
      ];
      for (const p of candidates) {
        if (
          p.x < 0 ||
          p.y < 0 ||
          p.x >= canvas.clientWidth ||
          p.y >= canvas.clientHeight
        )
          continue;
        if (document.elementFromPoint(p.x, p.y) !== canvas) continue;
        if (!scene.pick({ x: p.x, y: p.y }, 12, 12)) return p;
      }
      return null;
    }, hoverPoint);
    let away = null;
    if (awayPoint) {
      await page.mouse.move(awayPoint.x, awayPoint.y);
      await new Promise((r) => setTimeout(r, 300));
      away = await page.evaluate(() => ({
        diagnostics: window.__godsEyeView.dataManager.layers
          .get('anomalies')
          ?.module?.getRenderDiagnostics?.(),
        cursor: window.__godsEyeView.viewer.scene.canvas.style.cursor,
      }));
    }
    hoverProbe = { hovering, away, awayPoint };
  }
  check(
    "hovering a known point sets hoveredId and the canvas cursor to pointer, past the shared hover helper's throttle",
    hoverProbe?.hovering.diagnostics?.hoveredId != null &&
      hoverProbe?.hovering.cursor === 'pointer',
    JSON.stringify(hoverProbe?.hovering),
  );
  check(
    'moving to a pick-empty point clears hoveredId and the pointer cursor',
    hoverProbe?.away != null &&
      hoverProbe.away.diagnostics?.hoveredId == null &&
      hoverProbe.away.cursor !== 'pointer',
    JSON.stringify(hoverProbe?.away),
  );

  let selectionProbe = null;
  if (hoverPoint) {
    await page.mouse.click(hoverPoint.x, hoverPoint.y);
    await page
      .waitForFunction(
        () => {
          const d = document.querySelector('.uap-dossier');
          return d && !d.hidden;
        },
        { timeout: 8000 },
      )
      .catch(() => {});
    const opened = await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('anomalies')
        ?.module?.getRenderDiagnostics?.(),
    );
    await page.screenshot({
      path: resolve(PRESENCE_SHOT_DIR, 'anomalies-selection-1440.png'),
    });
    await page.evaluate(() => {
      document
        .querySelector('.uap-dossier')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
    });
    const closed = await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('anomalies')
        ?.module?.getRenderDiagnostics?.(),
    );
    selectionProbe = { opened, closed };
  }
  check(
    "opening a non-hero point's dossier sets selectedId and adds a selection-ring billboard",
    selectionProbe?.opened.selectedId != null &&
      selectionProbe?.opened.selectionRingCount === 1,
    JSON.stringify(selectionProbe?.opened),
  );
  check(
    'Escape closes the dossier and clears selectedId and the selection ring',
    selectionProbe?.closed.selectedId == null &&
      selectionProbe?.closed.selectionRingCount === 0,
    JSON.stringify(selectionProbe?.closed),
  );

  // Rebuild-race check (presence-pass fix round, finding 1: stale
  // billboard references across tier rebuilds): renderShapeGlyphBillboards
  // rebuilds its billboard collection from scratch on a camera-bounds
  // change, independently of hover state - a rebuild firing mid-hover must
  // not leave a stale billboard reference in hoveredOriginals
  // (src/layers/anomalies/rendering.js). Hover hoverSite, force a REAL
  // rebuild by nudging the camera enough to change the padded view bounds
  // key while staying well below SHAPE_GLYPH_HEIGHT_THRESHOLD_M (so this
  // exercises the shape-glyph tier's own rebuild, not the coarser
  // clear-to-nothing branch), wait past the 250ms shape-glyph recompute
  // throttle, then assert: a real rebuild happened
  // (shapeGlyphRebuildCount advanced, proving the race was actually
  // exercised), hoveredId is unchanged, and hoveredBillboardCount is back
  // to 1 (the brighten was re-applied to the rebuilt billboard, not
  // silently dropped). Moving the mouse away afterwards then clears hover
  // cleanly - proving the eventual restore never wrote to the destroyed
  // pre-rebuild billboard - with no page error either side.
  let rebuildRaceProbe = null;
  if (hoverPoint && hoverSite) {
    const errorsBefore = pageErrors.length;
    await page.evaluate(projectAt, hoverSite);
    await new Promise((r) => setTimeout(r, 700));
    await page.mouse.move(hoverPoint.x, hoverPoint.y);
    await new Promise((r) => setTimeout(r, 300));
    const before = await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('anomalies')
        ?.module?.getRenderDiagnostics?.(),
    );
    // Nudge the camera off hoverSite's own nadir, still close and below
    // threshold: shifts the padded view rectangle enough to change its
    // bounds key without crossing into the "above threshold" band.
    await page.evaluate((site) => {
      const viewer = window.__godsEyeView.viewer;
      const ellipsoid = viewer.scene.globe.ellipsoid;
      viewer.camera.cancelFlight();
      viewer.camera.setView({
        destination: ellipsoid.cartographicToCartesian({
          longitude: ((site.lon + 0.08) * Math.PI) / 180,
          latitude: ((site.lat + 0.08) * Math.PI) / 180,
          height: 20000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    }, hoverSite);
    // Past the shape-glyph recompute throttle (SHAPE_RECOMPUTE_THROTTLE_MS
    // = 250ms) with margin for the postRender tick that actually applies it.
    await new Promise((r) => setTimeout(r, 600));
    const after = await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('anomalies')
        ?.module?.getRenderDiagnostics?.(),
    );
    // A pixel that is definitely pick-empty (canvas corners, probed live -
    // mirrors the away-point search in the hover check above), to move to
    // afterwards and confirm the eventual restore is clean.
    const awayPoint = await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      const scene = viewer.scene;
      const canvas = scene.canvas;
      const candidates = [
        { x: 30, y: canvas.clientHeight - 30 },
        { x: canvas.clientWidth - 30, y: canvas.clientHeight - 30 },
        { x: canvas.clientWidth - 30, y: 30 },
        { x: 30, y: 30 },
      ];
      for (const p of candidates) {
        if (document.elementFromPoint(p.x, p.y) !== canvas) continue;
        if (!scene.pick({ x: p.x, y: p.y }, 12, 12)) return p;
      }
      return null;
    });
    let afterAway = null;
    if (awayPoint) {
      await page.mouse.move(awayPoint.x, awayPoint.y);
      await new Promise((r) => setTimeout(r, 300));
      afterAway = await page.evaluate(() =>
        window.__godsEyeView.dataManager.layers
          .get('anomalies')
          ?.module?.getRenderDiagnostics?.(),
      );
    }
    rebuildRaceProbe = {
      before,
      after,
      afterAway,
      newPageErrors: pageErrors.slice(errorsBefore),
    };
  }
  check(
    'rebuild-race: a camera nudge past the shape-glyph throttle forces a real rebuild while hovering (shapeGlyphRebuildCount advances)',
    rebuildRaceProbe != null &&
      rebuildRaceProbe.before != null &&
      rebuildRaceProbe.after?.shapeGlyphRebuildCount >
        rebuildRaceProbe.before.shapeGlyphRebuildCount,
    JSON.stringify({
      before: rebuildRaceProbe?.before?.shapeGlyphRebuildCount,
      after: rebuildRaceProbe?.after?.shapeGlyphRebuildCount,
    }),
  );
  check(
    'rebuild-race: hover survives the rebuild - hoveredId unchanged, brighten re-applied to the rebuilt billboard, no page errors',
    rebuildRaceProbe != null &&
      rebuildRaceProbe.after?.hoveredId != null &&
      rebuildRaceProbe.after.hoveredId === rebuildRaceProbe.before?.hoveredId &&
      rebuildRaceProbe.after.hoveredBillboardCount === 1 &&
      rebuildRaceProbe.newPageErrors.length === 0,
    JSON.stringify({
      before: rebuildRaceProbe?.before,
      after: rebuildRaceProbe?.after,
      newPageErrors: rebuildRaceProbe?.newPageErrors,
    }),
  );
  check(
    'rebuild-race: moving away after the rebuild clears hover cleanly - the restore never touches the destroyed pre-rebuild billboard, no page errors',
    rebuildRaceProbe?.afterAway != null &&
      rebuildRaceProbe.afterAway.hoveredId == null &&
      rebuildRaceProbe.afterAway.hoveredBillboardCount === 0 &&
      rebuildRaceProbe.newPageErrors.length === 0,
    JSON.stringify(rebuildRaceProbe?.afterAway),
  );

  // Escape during the debounce window must cancel the pending query: no
  // stale render should land even after the 150 ms debounce would have
  // fired had it not been cancelled.
  const escapeDuringDebounce = await page.evaluate(async () => {
    const input = document.querySelector('.uap-search');
    input.value = 'Roswell';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 400));
    return {
      rowCount: document.querySelectorAll('.uap-search-results li').length,
      hidden: document.querySelector('.uap-search-results')?.hidden,
      value: input.value,
    };
  });
  check(
    'Escape during the debounce window cancels the pending query',
    escapeDuringDebounce.rowCount === 0 &&
      escapeDuringDebounce.hidden === true &&
      escapeDuringDebounce.value === '',
    JSON.stringify(escapeDuringDebounce),
  );

  // Cross-register case search: at this point only the anomalies layer has
  // ever been enabled in this session -- ancient sites is still off. The
  // search corpus must still find a site whose own layer is disabled, and
  // picking that result must enable ancient sites itself (the shell's
  // enable-then-focus path) before opening its dossier.
  const siteQuery = await page.evaluate(() => {
    const m = window.__godsEyeView.dataManager;
    const beforeEnabled = m.isEnabled('ancient-sites');
    const input = document.querySelector('.uap-search');
    input.value = 'Stonehenge';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { beforeEnabled };
  });
  await page
    .waitForFunction(
      () => document.querySelectorAll('.uap-search-results li').length > 0,
      { timeout: 10000 },
    )
    .catch(() => {});
  const siteClick = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.uap-search-results li')];
    rows[0]?.click();
    return { rowCount: rows.length };
  });
  check(
    'search finds Stonehenge while ancient sites is off',
    siteQuery.beforeEnabled === false && siteClick.rowCount > 0,
    JSON.stringify({ ...siteQuery, ...siteClick }),
  );
  await page
    .waitForFunction(
      () => {
        const d = document.querySelector('.uap-dossier.ancient');
        return d && !d.hidden;
      },
      { timeout: 15000 },
    )
    .catch(() => {});
  const siteResult = await page.evaluate(() => {
    const m = window.__godsEyeView.dataManager;
    const d = document.querySelector('.uap-dossier.ancient');
    const open = d && !d.hidden;
    const text = d ? d.textContent : '';
    d?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    return { enabled: m.isEnabled('ancient-sites'), open, text };
  });
  check(
    'picking the result enables ancient sites and opens its dossier',
    siteResult.enabled === true &&
      siteResult.open === true &&
      siteResult.text.includes('Stonehenge'),
    JSON.stringify({ enabled: siteResult.enabled, open: siteResult.open }),
  );

  const caseSearch = await page.evaluate(async () => {
    const input = document.querySelector('.uap-search');
    input.value = 'Phoenix';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const rows = [...document.querySelectorAll('.uap-search-results li')];
    rows[0]?.click();
    await new Promise((r) => setTimeout(r, 800));
    const d = document.querySelector('.uap-dossier:not(.ancient)');
    const open = d && !d.hidden;
    const text = d ? d.textContent : '';
    const wikiLink = d?.querySelector('.uap-source a[href*="wikipedia.org"]');
    const wikiHost = wikiLink ? new URL(wikiLink.href).host : null;
    const streetViewLink = [
      ...(d?.querySelectorAll('.uap-source a') || []),
    ].find((a) => a.textContent === 'Street view');
    const streetViewHost = streetViewLink
      ? new URL(streetViewLink.href).host
      : null;
    const streetViewHref = streetViewLink ? streetViewLink.href : null;
    d?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    return {
      rowCount: rows.length,
      open,
      text,
      wikiHost,
      streetViewHost,
      streetViewHref,
    };
  });
  check(
    'search finds Phoenix and opens the anomalies dossier',
    caseSearch.rowCount > 0 &&
      caseSearch.open === true &&
      caseSearch.text.includes('Phoenix'),
    JSON.stringify({ rowCount: caseSearch.rowCount, open: caseSearch.open }),
  );
  check(
    'Phoenix lights dossier carries a Wikipedia link to en.wikipedia.org',
    caseSearch.wikiHost === 'en.wikipedia.org',
    JSON.stringify({ wikiHost: caseSearch.wikiHost }),
  );
  check(
    'Phoenix lights dossier carries a Street view link to the reported coordinates',
    caseSearch.streetViewHost === 'www.google.com' &&
      typeof caseSearch.streetViewHref === 'string' &&
      caseSearch.streetViewHref.includes('33.4000'),
    JSON.stringify({
      streetViewHost: caseSearch.streetViewHost,
      streetViewHref: caseSearch.streetViewHref,
    }),
  );

  // Real (non-hero) GEIPAN cases now carry a compact { id, source_url } dossier
  // entry too, so their "Open record" link works the same way a hero case's
  // does. A bare year query ('1981') matches by year rather than by title,
  // and sample hero cases can also carry 1981, so more than one result can
  // tie-order first after a rebuild. Rather than trust the top result
  // blindly, walk the results in order and use the first whose dossier's
  // Open record link actually points at www.geipan.fr.
  const geipanRecordLink = await page.evaluate(async () => {
    const input = document.querySelector('.uap-search');
    input.value = '1981';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const rows = [...document.querySelectorAll('.uap-search-results li')];
    let open = false;
    let text = '';
    let host = null;
    for (const row of rows) {
      row.click();
      await new Promise((r) => setTimeout(r, 800));
      const d = document.querySelector('.uap-dossier:not(.ancient)');
      open = !!(d && !d.hidden);
      text = d ? d.textContent : '';
      const openRecordLink = [
        ...(d?.querySelectorAll('.uap-source a') || []),
      ].find((a) => a.textContent === 'Open record');
      host = openRecordLink ? new URL(openRecordLink.href).host : null;
      d?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await new Promise((r) => setTimeout(r, 100));
      if (host === 'www.geipan.fr') break;
    }
    return {
      rowCount: rows.length,
      open,
      host,
      hasUndefined: /undefined/.test(text),
    };
  });
  check(
    'search finds a real GEIPAN case for the year query 1981',
    geipanRecordLink.rowCount > 0 && geipanRecordLink.open === true,
    JSON.stringify({
      rowCount: geipanRecordLink.rowCount,
      open: geipanRecordLink.open,
    }),
  );
  check(
    'its dossier carries an Open record link to www.geipan.fr, with no undefined text',
    geipanRecordLink.host === 'www.geipan.fr' &&
      geipanRecordLink.hasUndefined === false,
    JSON.stringify({
      host: geipanRecordLink.host,
      hasUndefined: geipanRecordLink.hasUndefined,
    }),
  );

  // Ancient sites match by country as well as by name (Gobekli Tepe and
  // Derinkuyu are both Turkey hero rows in public/ancient-sites/sites.v2.json).
  const countrySearch = await page.evaluate(async () => {
    const input = document.querySelector('.uap-search');
    input.value = 'Turkey';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const rows = [...document.querySelectorAll('.uap-search-results li')];
    const text = rows.map((row) => row.textContent).join(' | ');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return { rowCount: rows.length, text };
  });
  check(
    'search matches ancient sites by country (Turkey)',
    countrySearch.rowCount > 0 &&
      (countrySearch.text.includes('Gobekli Tepe') ||
        countrySearch.text.includes('Derinkuyu')),
    JSON.stringify(countrySearch),
  );

  // Search reaches every register (task 3, atlas-instruments): the
  // worldwide ancient-sites sweep (~81k rows) and GEIPAN's real caseload
  // (~3,381 rows), both previously left out of the in-memory corpus, join
  // the curated hero tiers above. "Carnac" matches only a sweep row here -
  // the curated hero at that location is catalogued under its precise
  // name, "Alignements de Menec" (see PHENOMENA_DESIGN.md's curated list),
  // so a hit here proves the sweep tier itself is reachable, not a hero.
  await page.evaluate(() => {
    const input = document.querySelector('.uap-search');
    input.value = 'Carnac';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page
    .waitForFunction(
      () => document.querySelectorAll('.uap-search-results li').length > 0,
      { timeout: 10000 },
    )
    .catch(() => {});
  const sweepQuery = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.uap-search-results li')];
    const text = rows.map((row) => row.textContent).join(' | ');
    rows[0]?.click();
    return { rowCount: rows.length, text };
  });
  check(
    'search finds Carnac in the worldwide ancient-sites sweep',
    sweepQuery.rowCount > 0 && /carnac/i.test(sweepQuery.text),
    JSON.stringify(sweepQuery),
  );
  // The ancient layer's focusSweep flies (flyToBoundingSphere, ~2.5s) before
  // opening the dossier, exactly like focusSite for a hero - see its own
  // doc comment in src/layers/ancientSites/index.js - so this waits for the
  // flight to settle rather than a fixed delay.
  await page
    .waitForFunction(
      () => {
        const d = document.querySelector('.uap-dossier.ancient');
        return d && !d.hidden;
      },
      { timeout: 15000 },
    )
    .catch(() => {});
  const sweepResult = await page.evaluate(() => {
    const d = document.querySelector('.uap-dossier.ancient');
    const open = d && !d.hidden;
    const text = d ? d.textContent : '';
    d?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    return { open, text };
  });
  check(
    'picking a sweep result flies there and opens the compact sweep dossier',
    sweepResult.open === true && /carnac/i.test(sweepResult.text),
    JSON.stringify(sweepResult),
  );

  // GEIPAN's columnar rows carry no title of their own (no place names -
  // see DATA_PIPELINE.md's privacy rule, rounded coordinates only); the
  // search corpus instead carries "GEIPAN case <id>", the id verbatim, so a
  // query for the id itself finds the case (rankRecord only ever looks at
  // title, never id directly - see src/app/caseSearch.js). The id is read
  // off the live dataset rather than pinned, so this stays valid as the
  // GEIPAN sync grows.
  const geipanIdQuery = await page.evaluate(async () => {
    const res = await fetch('/anomalies/anomalies.v1.json');
    const json = await res.json();
    const c = json.columns;
    let geipanId = null;
    for (let i = 0; i < json.count; i++) {
      if (!c.title[i]) {
        geipanId = c.id[i];
        break;
      }
    }
    const input = document.querySelector('.uap-search');
    input.value = geipanId;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const rows = [...document.querySelectorAll('.uap-search-results li')];
    const text = rows.map((row) => row.textContent).join(' | ');
    return { geipanId, rowCount: rows.length, text };
  });
  check(
    'searching a GEIPAN case id by itself finds that case',
    geipanIdQuery.rowCount > 0 &&
      typeof geipanIdQuery.geipanId === 'string' &&
      geipanIdQuery.text.includes(geipanIdQuery.geipanId),
    JSON.stringify(geipanIdQuery),
  );

  const yearSearch1954 = await page.evaluate(async () => {
    const input = document.querySelector('.uap-search');
    input.value = '1954';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const rows = [...document.querySelectorAll('.uap-search-results li')];
    const text = rows.map((row) => row.textContent).join(' | ');
    return { rowCount: rows.length, text };
  });
  check(
    'search "1954" finds a GEIPAN case',
    yearSearch1954.rowCount > 0 && /GEIPAN case/.test(yearSearch1954.text),
    JSON.stringify(yearSearch1954),
  );

  const capSearch = await page.evaluate(async () => {
    const input = document.querySelector('.uap-search');
    input.value = 'megalith';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const rows = [...document.querySelectorAll('.uap-search-results li')];
    return { rowCount: rows.length };
  });
  check(
    'results stay capped at 8 even for a broad query over the ~85k corpus',
    capSearch.rowCount === 8,
    JSON.stringify(capSearch),
  );

  // Latency sanity check: the corpus and its prefix-bucket index build once,
  // lazily, on the first search - every check above already triggered at
  // least one, so this query's `uapSearchLastMs` (set by chronometer.js's
  // addSearch around its own onQuery call on every query) reflects a
  // steady-state search call over the full corpus, not the cold first one.
  const latency = await page.evaluate(async () => {
    const input = document.querySelector('.uap-search');
    input.value = 'stonehenge';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const wrap = document.querySelector('.uap-search-wrap');
    return { lastMs: Number(wrap?.dataset.uapSearchLastMs) };
  });
  check(
    'a steady-state search call over the full corpus stays under 50ms',
    Number.isFinite(latency.lastMs) && latency.lastMs < 50,
    JSON.stringify(latency),
  );

  await page.evaluate(() => {
    const input = document.querySelector('.uap-search');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const ir = await page.evaluate(async () => {
    window.__godsEyeView.styleManager.setStyle('infrared');
    await new Promise((r) => setTimeout(r, 600));
    const on = document.documentElement.dataset.gevStyle === 'infrared';
    window.__godsEyeView.styleManager.setStyle('normal');
    return on;
  });
  check('infrared style reaches the layer', ir === true);

  // Hotspots: a debounced imagery-layer overlay that follows the dial.
  // Turning it on must add exactly one imagery layer immediately (no
  // waiting on the 250 ms debounce); stepping the year twice while it is
  // on must settle back at the same +1 (proving debounced swaps remove the
  // old layer before or as they add the new one, never leaking a second);
  // turning it off must return to the original count.
  const heat = await page.evaluate(async () => {
    const viewer = window.__godsEyeView.viewer;
    const before = viewer.imageryLayers.length;
    const btn = [...document.querySelectorAll('.uap-chrono-panel button')].find(
      (b) => b.textContent === 'Hotspots',
    );
    btn.click();
    const afterOn = viewer.imageryLayers.length;
    const ariaPressedOn = btn.getAttribute('aria-pressed');
    const slider = document.querySelector('.uap-slider');
    slider.focus();
    slider.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    );
    slider.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 600));
    const afterSteps = viewer.imageryLayers.length;
    btn.click();
    const afterOff = viewer.imageryLayers.length;
    const ariaPressedOff = btn.getAttribute('aria-pressed');
    return {
      before,
      afterOn,
      ariaPressedOn,
      afterSteps,
      afterOff,
      ariaPressedOff,
    };
  });
  check(
    'toggling Hotspots on adds exactly one imagery layer',
    heat.afterOn === heat.before + 1 && heat.ariaPressedOn === 'true',
    JSON.stringify(heat),
  );
  check(
    'stepping the year with Hotspots on holds at +1 after the debounce settles (no leak)',
    heat.afterSteps === heat.before + 1,
    JSON.stringify(heat),
  );
  check(
    'toggling Hotspots off returns to the base imagery layer count',
    heat.afterOff === heat.before && heat.ariaPressedOff === 'false',
    JSON.stringify(heat),
  );

  // The Void style (feat/atlas: the Void style and spectrum accents): the
  // map should crush to near-black while the anomaly spectrum stays
  // saturated and glows, proven over France's dense report cluster with
  // Hotspots lit, the case most likely to wash out into a whiteout.
  await page.evaluate(() => {
    const cam = window.__godsEyeView.viewer.camera;
    cam.cancelFlight?.();
    const Cartesian3 = cam.position.constructor;
    cam.setView({
      destination: Cartesian3.fromDegrees(2.35, 48.85, 900000),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    window.__godsEyeView.viewer.scene.requestRender();
  });
  await new Promise((r) => setTimeout(r, 400));
  const heatWasOn = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.uap-chrono-panel button')].find(
      (b) => b.textContent === 'Hotspots',
    );
    const wasOn = btn?.getAttribute('aria-pressed') === 'true';
    if (!wasOn) btn?.click();
    return wasOn === true;
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.setStyle('normal'),
  );
  await new Promise((r) => setTimeout(r, 700));
  const beforeVoid = await measureFrame(page);
  await page.evaluate(() => window.__godsEyeView.styleManager.setStyle('void'));
  await new Promise((r) => setTimeout(r, 700));
  const afterVoid = await measureFrame(page);
  const voidStyleApplied = await page.evaluate(
    () => document.documentElement.dataset.gevStyle === 'void',
  );
  // Restore: heat back to how this block found it, style back to normal, so
  // later checks in this pass see the state they expect.
  if (!heatWasOn) {
    await page.evaluate(() => {
      const btn = [
        ...document.querySelectorAll('.uap-chrono-panel button'),
      ].find((b) => b.textContent === 'Hotspots');
      btn?.click();
    });
  }
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.setStyle('normal'),
  );
  await new Promise((r) => setTimeout(r, 200));
  check('Void style reaches the layer', voidStyleApplied === true);
  check(
    'Void style visibly darkens the globe',
    afterVoid.meanLuminance < beforeVoid.meanLuminance &&
      afterVoid.meanLuminance < 90,
    `before=${beforeVoid.meanLuminance.toFixed(1)} after=${afterVoid.meanLuminance.toFixed(1)}`,
  );
  check(
    'Void keeps the anomaly spectrum saturated over a dense cluster (France) with Hotspots on',
    afterVoid.maxSaturation > 0.5,
    `maxSaturation=${afterVoid.maxSaturation.toFixed(2)}`,
  );

  // Close-range shape glyphs (task 2, luminous-pins): below the shared
  // close-zoom threshold (matching ancient sites' own closest-band cutoff,
  // 500,000m - see rendering.js's SHAPE_GLYPH_HEIGHT_THRESHOLD_M) anomaly
  // points swap from the neutral glow sprite to a status-hued shape-glyph
  // billboard (the row's own reported craft/shape, see shapeGlyphs.js),
  // bounded to the current camera view rectangle so a dense cluster like
  // GEIPAN's own France concentration never rebuilds thousands of
  // billboards in one frame. Proven over that same France cluster: glyph
  // billboards present and bounded, one real case's glyph matching its own
  // shape field (fetched from the dataset, never hardcoded), and zooming
  // back out restoring the neutral glow sprite - read directly off the
  // picked billboard's own imageId (glow:... vs shape:...) via a real
  // scene.pick(), so this proves what actually rendered and is still
  // pickable, not just what the renderer intended.
  //
  // The dial is forced to a known year first (module.setYear) so this check
  // does not depend on wherever earlier steps in this script (arrow keys,
  // Play) left it: every candidate below is chosen well before that year,
  // so it stays inWindow regardless.
  await page.evaluate(() => {
    window.__godsEyeView.dataManager.layers
      .get('anomalies')
      ?.module?.setYear?.(2026);
  });
  const shapeGlyphTarget = await page.evaluate(async () => {
    const r = await fetch('/anomalies/anomalies.v1.json');
    const json = await r.json();
    const cols = json.columns;
    const crafts = json.crafts;
    for (let i = 0; i < cols.id.length; i++) {
      const lat = cols.lat[i];
      const lon = cols.lon[i];
      const year = new Date(cols.t[i] * 86400000).getUTCFullYear();
      if (
        typeof lat === 'number' &&
        typeof lon === 'number' &&
        lat > 48.3 &&
        lat < 49.3 &&
        lon > 1.7 &&
        lon < 2.9 &&
        year < 2010 &&
        cols.hero?.[i] !== 1
      ) {
        return { lat, lon, craft: crafts[cols.craft[i]] || 'orb' };
      }
    }
    return null;
  });
  check(
    'a France-area, pre-2010, non-hero case exists in the dataset for the shape-glyph check',
    !!shapeGlyphTarget,
    JSON.stringify(shapeGlyphTarget),
  );

  const projectSite = (site) => {
    const viewer = window.__godsEyeView.viewer;
    const ellipsoid = viewer.scene.globe.ellipsoid;
    viewer.camera.cancelFlight();
    viewer.camera.setView({
      destination: ellipsoid.cartographicToCartesian({
        longitude: (site.lon * Math.PI) / 180,
        latitude: (site.lat * Math.PI) / 180,
        height: site.height,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    const target = ellipsoid.cartographicToCartesian({
      longitude: (site.lon * Math.PI) / 180,
      latitude: (site.lat * Math.PI) / 180,
      height: 0,
    });
    const p = viewer.scene.cartesianToCanvasCoordinates(target);
    return p ? { x: p.x, y: p.y } : null;
  };
  const pickImageIdAt = async (point) =>
    point
      ? page.evaluate((pt) => {
          const scene = window.__godsEyeView.viewer.scene;
          const picked = scene.pick({ x: pt.x, y: pt.y }, 12, 12);
          const primitive = picked?.primitive;
          const anomalyId =
            picked?.id?.anomalyId ?? primitive?.id?.anomalyId ?? null;
          const imageId =
            typeof primitive?.image === 'string' ? primitive.image : null;
          const diag = window.__godsEyeView.dataManager.layers
            .get('anomalies')
            ?.module?.getRenderDiagnostics?.();
          return { anomalyId, imageId, diag };
        }, point)
      : null;

  let closeGlyph = null;
  let farGlyph = null;
  if (shapeGlyphTarget) {
    const closePoint = await page.evaluate(projectSite, {
      lat: shapeGlyphTarget.lat,
      lon: shapeGlyphTarget.lon,
      height: 200000,
    });
    await new Promise((r) => setTimeout(r, 900));
    await page.evaluate(() =>
      window.__godsEyeView.viewer.scene.requestRender(),
    );
    await new Promise((r) => setTimeout(r, 100));
    closeGlyph = await pickImageIdAt(closePoint);

    const farPoint = await page.evaluate(projectSite, {
      lat: shapeGlyphTarget.lat,
      lon: shapeGlyphTarget.lon,
      height: 900000,
    });
    await new Promise((r) => setTimeout(r, 900));
    await page.evaluate(() =>
      window.__godsEyeView.viewer.scene.requestRender(),
    );
    await new Promise((r) => setTimeout(r, 100));
    farGlyph = await pickImageIdAt(farPoint);
  }
  check(
    'close zoom over a dense area (France) renders shape-glyph billboards, present and bounded',
    // maxShapeGlyphBillboards caps candidate ROWS, not billboards: a hero
    // row adds a second billboard (its ion ring), so the true bound is 2x
    // the row cap, never more - see rendering.js's own MAX_SHAPE_GLYPH_
    // BILLBOARDS doc comment.
    closeGlyph?.diag?.glyphBillboardCount > 0 &&
      closeGlyph.diag.glyphBillboardCount <
        closeGlyph.diag.maxShapeGlyphBillboards * 2,
    JSON.stringify(closeGlyph?.diag),
  );
  check(
    'the picked close-zoom billboard is a shape glyph (imageId starts "shape:") matching the case\'s own reported shape',
    typeof closeGlyph?.imageId === 'string' &&
      closeGlyph.imageId.startsWith('shape:') &&
      closeGlyph.imageId.includes(`:${shapeGlyphTarget?.craft}:`) &&
      closeGlyph.anomalyId != null,
    JSON.stringify({
      imageId: closeGlyph?.imageId,
      craft: shapeGlyphTarget?.craft,
    }),
  );
  check(
    'zooming back out restores the neutral glow sprite (imageId prefix flips to "glow:") and clears the glyph tier',
    typeof farGlyph?.imageId === 'string' &&
      farGlyph.imageId.startsWith('glow:') &&
      farGlyph.anomalyId != null &&
      farGlyph.diag?.glyphBillboardCount === 0,
    JSON.stringify({ imageId: farGlyph?.imageId, diag: farGlyph?.diag }),
  );

  // Retina-sharp composition (task: presence pass): every composer's cache
  // key and imageId carry the DPR bucket (glowSprite.js's `dprBucket`), so a
  // live billboard's own imageId must end with the "@<dpr>" token this run
  // actually composed at, proving the wiring reaches all the way to a real
  // rendered billboard, not just the composer functions in isolation.
  // Headless Puppeteer runs at devicePixelRatio 1 unless a page/viewport
  // requests otherwise (this gate's own setViewport above never sets
  // deviceScaleFactor, deliberately left alone here rather than risking the
  // other pixel-sampling checks in this large, delicate gate), so "@1" is
  // the honest bucket to expect - the retina path itself (deviceScaleFactor
  // 2) is proven separately by the presence-pass screenshot script.
  check(
    'the picked close-zoom shape-glyph billboard\'s own imageId carries the DPR bucket this run composed at ("@1" under headless Puppeteer, which reports devicePixelRatio 1 unless a page requests otherwise)',
    typeof closeGlyph?.imageId === 'string' &&
      closeGlyph.imageId.endsWith('@1'),
    JSON.stringify({ imageId: closeGlyph?.imageId }),
  );

  // The Spotter plate is a sibling of the viewer container, not a child of
  // the anomalies layer's own DOM (task 5 fix round 1): disabling the
  // layer must still close it, since the Spotter button that opened it
  // disappears along with the rest of the chronometer.
  const spotterCloses = await page.evaluate(async () => {
    const btn = [...document.querySelectorAll('.uap-chrono-panel button')].find(
      (b) => b.textContent === 'Spotter',
    );
    btn?.click();
    const opened = document.querySelector('.uap-spotter');
    const openedVisible = !!opened && !opened.hidden;
    const m = window.__godsEyeView.dataManager;
    await m.setEnabled('anomalies', false, { origin: 'user' });
    const after = document.querySelector('.uap-spotter');
    const afterHiddenOrAbsent = !after || after.hidden === true;
    // Restore for the rest of this pass (re-enable is already proven safe above).
    await m.setEnabled('anomalies', true, { origin: 'user' });
    return { openedVisible, afterHiddenOrAbsent };
  });
  check(
    'disabling the anomalies layer closes the Spotter plate',
    spotterCloses.openedVisible === true &&
      spotterCloses.afterHiddenOrAbsent === true,
    JSON.stringify(spotterCloses),
  );

  const sourcesPanel = await page.evaluate(async () => {
    const btn = [...document.querySelectorAll('.uap-chrono-panel button')].find(
      (b) => b.textContent === 'Sources',
    );
    btn?.click();
    await new Promise((r) => setTimeout(r, 200));
    const panel = document.querySelector('.uap-credits');
    const open = panel && !panel.hidden;
    const text = panel ? panel.textContent : '';
    panel?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 100));
    return { open, closed: panel ? panel.hidden : null, text };
  });
  check(
    'Sources panel lists GEIPAN and the National Archives',
    sourcesPanel.open === true &&
      sourcesPanel.text.includes('GEIPAN') &&
      sourcesPanel.text.includes('National Archives'),
    JSON.stringify({
      open: sourcesPanel.open,
      hasGeipan: sourcesPanel.text.includes('GEIPAN'),
      hasNARA: sourcesPanel.text.includes('National Archives'),
    }),
  );
  check(
    'Escape closes the Sources panel',
    sourcesPanel.closed === true,
    JSON.stringify({ closed: sourcesPanel.closed }),
  );

  // Observatory (task 1, atlas-instruments): a layer-independent readout of
  // every register at a glance, opened from its own standalone toggle (fix
  // round: relocated off the sky chronometer's action row, which
  // disappears whenever that one register is disabled - see
  // src/ui/layerBindings.js's `_createObservatoryToggle`). Every number it
  // shows must trace back to the same shipped datasets, computed here from
  // a fresh fetch rather than pinned, so this gate stays valid as GEIPAN
  // and the ancient sweep grow. The plate's sky and ancient sections render
  // asynchronously (each fetch resolves and paints independently - see
  // src/app/observatory.js's refresh()), so the count elements are awaited
  // before being read.
  const [obsSkyStats, obsAncientJson] = await Promise.all([
    page.evaluate(async () => (await fetch('/anomalies/stats.json')).json()),
    page.evaluate(async () =>
      (await fetch('/ancient-sites/sites.v2.json')).json(),
    ),
  ]);
  await page.evaluate(() => {
    document.querySelector('.uap-observatory-toggle')?.click();
  });
  const observatoryOpened = await page.evaluate(() => {
    const plate = document.querySelector('.uap-observatory');
    return !!plate && !plate.hidden;
  });
  await page
    .waitForFunction(
      () =>
        document.querySelector(
          '.uap-observatory-section[data-register="sky"] .uap-observatory-count[data-count]',
        ) &&
        document.querySelector(
          '.uap-observatory-section[data-register="ancient"] .uap-observatory-count[data-count]',
        ),
      { timeout: 20000 },
    )
    .catch(() => {});
  const observatory = await page.evaluate(() => {
    const plate = document.querySelector('.uap-observatory');
    const skyCountEl = plate?.querySelector(
      '.uap-observatory-section[data-register="sky"] .uap-observatory-count',
    );
    const ancientCountEl = plate?.querySelector(
      '.uap-observatory-section[data-register="ancient"] .uap-observatory-count',
    );
    const statusValues = [
      ...(plate?.querySelectorAll('.uap-observatory-status li') || []),
    ].map((li) => Number(li.dataset.count));
    const footerText =
      plate?.querySelector('.uap-observatory-footer')?.textContent || '';
    return {
      skyCount: skyCountEl ? Number(skyCountEl.dataset.count) : null,
      ancientCount: ancientCountEl
        ? Number(ancientCountEl.dataset.count)
        : null,
      statusSum: statusValues.reduce((a, b) => a + b, 0),
      statusValues,
      footerText,
    };
  });
  check(
    'Observatory plate opens from its standalone toggle',
    observatoryOpened === true,
    JSON.stringify({ observatoryOpened }),
  );
  check(
    'Observatory sky count equals the fetched stats.json count',
    observatory.skyCount === obsSkyStats.count,
    `plate=${observatory.skyCount} stats.json=${obsSkyStats.count}`,
  );
  check(
    'Observatory status split rows sum to the sky count',
    observatory.statusValues.length > 0 &&
      observatory.statusSum === obsSkyStats.count,
    `sum=${observatory.statusSum} count=${obsSkyStats.count} rows=${JSON.stringify(observatory.statusValues)}`,
  );
  check(
    'Observatory ancient count equals the fetched v2 dataset count',
    observatory.ancientCount === obsAncientJson.count,
    `plate=${observatory.ancientCount} sites.v2.json=${obsAncientJson.count}`,
  );
  check(
    'Observatory footer states counts reflect the shipped datasets and the live window',
    observatory.footerText.includes(
      'Counts reflect the shipped datasets and the live window.',
    ),
    observatory.footerText,
  );
  // Fix 3 (atlas-instruments): Escape closes the plate through
  // observatory.js's own close(), which must now also tell the shell via
  // its onClose callback, so the persistent toggle button (built and owned
  // by LayerBindings, not this plate) drops back to aria-pressed="false"
  // and receives focus back, rather than being left stuck reading "true"
  // for a plate that is no longer on screen.
  const observatoryEscape = await page.evaluate(() => {
    const plate = document.querySelector('.uap-observatory');
    const btn = document.querySelector('.uap-observatory-toggle');
    plate?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    return {
      closed: plate ? plate.hidden : null,
      toggleAriaPressed: btn?.getAttribute('aria-pressed'),
      toggleHasFocus: !!btn && document.activeElement === btn,
    };
  });
  check(
    'Escape closes the Observatory plate',
    observatoryEscape.closed === true,
    JSON.stringify(observatoryEscape),
  );
  check(
    "Escape-closing the Observatory resets the toggle's aria-pressed and returns focus to it",
    observatoryEscape.toggleAriaPressed === 'false' &&
      observatoryEscape.toggleHasFocus === true,
    JSON.stringify(observatoryEscape),
  );

  // Reachability regression (fix round, atlas-instruments task 1): the
  // blocking finding on the first pass was that the Observatory toggle
  // lived on the sky chronometer's own action row, which
  // chronometer.js's setVisible(false) removes from the DOM whenever that
  // one register is disabled - stranding the plate with no reachable
  // control, even though it reads every register's own shipped stats, not
  // just the sky's. Disable the layer and prove the standalone toggle
  // (built once, directly by LayerBindings, never a child of the
  // chronometer) still exists and still opens the plate with correct
  // data; then re-enable and prove none of that regresses.
  const observatoryWhileDisabled = await page.evaluate(async () => {
    const m = window.__godsEyeView.dataManager;
    await m.setEnabled('anomalies', false, { origin: 'user' });
    const btn = document.querySelector('.uap-observatory-toggle');
    const btnExists = !!btn;
    btn?.click();
    const plate = document.querySelector('.uap-observatory');
    return { btnExists, opened: !!plate && !plate.hidden };
  });
  check(
    'the Observatory toggle still exists after the anomalies layer is disabled',
    observatoryWhileDisabled.btnExists === true,
    JSON.stringify(observatoryWhileDisabled),
  );
  check(
    'the Observatory toggle still opens the plate while the anomalies layer is disabled',
    observatoryWhileDisabled.opened === true,
    JSON.stringify(observatoryWhileDisabled),
  );
  await page
    .waitForFunction(
      () =>
        document.querySelector(
          '.uap-observatory-section[data-register="sky"] .uap-observatory-count[data-count]',
        ) &&
        document.querySelector(
          '.uap-observatory-section[data-register="ancient"] .uap-observatory-count[data-count]',
        ),
      { timeout: 20000 },
    )
    .catch(() => {});
  const observatoryDataWhileDisabled = await page.evaluate(() => {
    const plate = document.querySelector('.uap-observatory');
    const skyCountEl = plate?.querySelector(
      '.uap-observatory-section[data-register="sky"] .uap-observatory-count',
    );
    const ancientCountEl = plate?.querySelector(
      '.uap-observatory-section[data-register="ancient"] .uap-observatory-count',
    );
    return {
      skyCount: skyCountEl ? Number(skyCountEl.dataset.count) : null,
      ancientCount: ancientCountEl
        ? Number(ancientCountEl.dataset.count)
        : null,
    };
  });
  check(
    'the Observatory plate still shows the correct sky count while the anomalies layer is disabled',
    observatoryDataWhileDisabled.skyCount === obsSkyStats.count,
    `plate=${observatoryDataWhileDisabled.skyCount} stats.json=${obsSkyStats.count}`,
  );
  check(
    'the Observatory plate still shows the correct ancient count while the anomalies layer is disabled',
    observatoryDataWhileDisabled.ancientCount === obsAncientJson.count,
    `plate=${observatoryDataWhileDisabled.ancientCount} sites.v2.json=${obsAncientJson.count}`,
  );
  const observatoryAfterReEnable = await page.evaluate(async () => {
    const m = window.__godsEyeView.dataManager;
    await m.setEnabled('anomalies', true, { origin: 'user' });
    const btn = document.querySelector('.uap-observatory-toggle');
    const plate = document.querySelector('.uap-observatory');
    // Re-enabling the sky layer never touched the Observatory toggle or
    // plate before this fix round either; this just proves that stays
    // true now that the two are fully decoupled (no attachShellServices
    // channel between them at all - see src/layers/anomalies/index.js).
    return {
      btnExists: !!btn,
      stillOpen: !!plate && !plate.hidden,
    };
  });
  check(
    'the Observatory toggle still exists after the anomalies layer is re-enabled',
    observatoryAfterReEnable.btnExists === true,
    JSON.stringify(observatoryAfterReEnable),
  );
  check(
    'the Observatory plate was not force-closed by re-enabling the anomalies layer',
    observatoryAfterReEnable.stillOpen === true,
    JSON.stringify(observatoryAfterReEnable),
  );
  await page.evaluate(() => {
    document.querySelector('.uap-observatory-toggle')?.click();
  });

  // Deep-time dial decoupling (task 2, atlas-instruments): landmark marks
  // belong to the sky scale only (see chronometer.js's `landmarksLayer`
  // guard on the scale identity). Ancient sites has been on since the
  // cross-register search step earlier in this script; switching the sky
  // (anomalies) register off here hands `.uap-chrono` to the deep-time
  // dial (its own reactive engagement is already proven in
  // qa-ancient-sites.mjs), which must carry zero landmark marks.
  await page.evaluate(async () => {
    await window.__godsEyeView.dataManager.setEnabled('anomalies', false, {
      origin: 'user',
    });
  });
  const deepTimeLandmarks = await page.evaluate(
    () => document.querySelectorAll('.uap-landmark').length,
  );
  check(
    'the deep-time dial (ancient on, sky off) carries zero landmark marks',
    deepTimeLandmarks === 0,
    `count=${deepTimeLandmarks}`,
  );
  // Restore for the checks below (pageErrors is a plain array unaffected by
  // layer state, but leaving the layer on matches every check before this
  // block and keeps this script's end state sensible for future edits).
  await page.evaluate(async () => {
    await window.__godsEyeView.dataManager.setEnabled('anomalies', true, {
      origin: 'user',
    });
  });

  check(
    'no page errors during the interactive pass',
    pageErrors.length === 0,
    pageErrors.join(' | '),
  );

  const fresh = await browser.createBrowserContext();
  const share = await fresh.newPage();
  await share.goto(
    `${base}/?welcome=0#lat=34.05&lon=-118.24&alt=26000000&pitch=-90&v=2&l=3`,
    { waitUntil: 'domcontentloaded' },
  );
  await share.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 60000,
  });
  await share
    .waitForFunction(
      () => window.__godsEyeView.dataManager.isEnabled('anomalies'),
      { timeout: 30000 },
    )
    .catch(() => {});
  const restored = await share.evaluate(() =>
    window.__godsEyeView.dataManager.isEnabled('anomalies'),
  );
  check('share link with token 3 restores the layer', restored === true);
} finally {
  await browser.close();
}
console.log(`RESULT: ${failures} failures`);
process.exit(failures ? 1 : 0);
