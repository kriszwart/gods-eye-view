#!/usr/bin/env node
/**
 * Browser proof of the live claims register acceptance: registration,
 * fixture claims rendering as pulsing ion points, dossier open with the
 * place/shape/time/source fields, the honesty line verbatim, a link-out to
 * the original post, Escape close, cross-register dossier exclusivity, the
 * nearby-cases block, the stream ticker, and share-link restore via token 5
 * - all against a THROWAWAY server this script starts itself with
 * GEV_CLAIMS_FIXTURE=1 on a spare port (never the controller-managed :4173,
 * which has no fixture env).
 *
 * The nearby-cases expectation is computed here, in Node, from the same
 * bundled public/anomalies/anomalies.v1.json the browser fetches (reusing
 * the portable nearby.js and anomalies/records.js modules), rather than
 * pinned as a literal number: the fixture claims' coordinates are fixed,
 * but the anomalies dataset grows across build phases, so a hardcoded
 * count would go stale.
 *
 * Both branches of that nearby-cases check run live every pass: the New
 * York fixture claim sits far from the France-heavy GEIPAN mass (an honest
 * zero-case result), while the Paris fixture claim sits at a real French
 * location squarely inside that mass (a genuine nonzero result). The Paris
 * claim's fetchedAt also sits out of step with its position at the end of
 * buildFixtureClaims()'s array, so the stream ticker's newest-first order
 * check below is only satisfied by an actual sort, not a pass-through of
 * feed order (see the fixture's own doc comment in
 * server/providers/claims.js).
 *
 * Also proves the keyless path against a SECOND throwaway server with no
 * fixture and no DEEPSEEK_API_KEY: the register stays empty and shows
 * "Classifier key not set" rather than erroring.
 *
 * Usage: node scripts/qa-claims.mjs
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  findNearbyCases,
  NEARBY_RADIUS_KM,
} from '../src/layers/liveClaims/nearby.js';
import { normalizeAnomalySnapshot } from '../src/layers/anomalies/records.js';
import { SHAPE_GLYPH_URLS } from '../src/layers/anomalies/shapeGlyphs.js';
import { PALETTE } from '../src/layers/liveClaims/model.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const VITE_BIN = resolve(REPO_ROOT, 'node_modules/.bin/vite');
const FIXTURE_PORT = 4581;
const KEYLESS_PORT = 4582;
const SHOT_DIR = resolve(REPO_ROOT, 'qa-shots/live-claims');
mkdirSync(SHOT_DIR, { recursive: true });
// Shared with qa-anomalies.mjs and qa-ancient-sites.mjs (task: presence
// pass): each writes its own distinctly-named files into this one directory.
const PRESENCE_SHOT_DIR = resolve(REPO_ROOT, 'qa-shots/presence-pass');
mkdirSync(PRESENCE_SHOT_DIR, { recursive: true });

let failures = 0;
const check = (name, passed, detail = '') => {
  console.log(
    `[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`,
  );
  if (!passed) failures++;
};

/** Start a throwaway dev server on `port` with `envExtra` merged over the
 * current process env, and resolve once it answers HTTP requests. Gets its
 * own Vite cache directory (server/standalone/vite.config.js reads
 * GEV_VITE_CACHE_DIR), so it never shares - or goes stale against -
 * node_modules/.vite, which the controller-managed :4173 server keeps. */
function startServer(port, envExtra) {
  const child = spawn(VITE_BIN, [], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      GEV_VITE_CACHE_DIR: resolve(
        REPO_ROOT,
        `node_modules/.vite-qa-claims-${port}`,
      ),
      ...envExtra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d.toString()));
  child.stderr.on('data', (d) => (err += d.toString()));
  return { child, getOutput: () => `${out}\n${err}` };
}

/** Poll a throwaway server's root URL until it answers, or throw after `timeoutMs`. */
async function waitForServer(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/`);
      if (res.ok || res.status < 500) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `Server on port ${port} never answered within ${timeoutMs}ms`,
  );
}

/** Kill a throwaway server's whole process group. */
function stopServer({ child }) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});

let fixtureServer = null;
let keylessServer = null;
try {
  // ── fixture server: layer registration, points, dossier, share link ──
  fixtureServer = startServer(FIXTURE_PORT, { GEV_CLAIMS_FIXTURE: '1' });
  await waitForServer(FIXTURE_PORT);
  const fixtureBase = `http://localhost:${FIXTURE_PORT}`;

  const isolated = await browser.createBrowserContext();
  const page = await isolated.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`${fixtureBase}/?welcome=0`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 60000,
  });
  await page
    .waitForFunction(
      () =>
        document.getElementById('loading-screen')?.classList.contains('hidden'),
      { timeout: 60000 },
    )
    .catch(() => {});

  const present = await page.evaluate(() => {
    const m = window.__godsEyeView.dataManager;
    return {
      has: m.layers.has('live-claims'),
      enabled: m.isEnabled('live-claims'),
    };
  });
  check(
    'live-claims layer registered and initially off',
    present.has && !present.enabled,
    JSON.stringify(present),
  );

  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('live-claims', true, {
      origin: 'user',
    }),
  );
  await page.waitForFunction(
    () =>
      (window.__godsEyeView.dataManager.layers
        .get('live-claims')
        ?.module?.getStats?.().count ?? 0) > 0,
    { timeout: 30000 },
  );
  const fixtureStats = await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('live-claims')
      .module.getStats(),
  );
  check(
    'fixture claims loaded after toggle on (count > 0)',
    fixtureStats.count > 0 && fixtureStats.status === 'ok',
    JSON.stringify(fixtureStats),
  );

  const strings = await page.evaluate(async () => {
    const mod = await import('/src/layers/liveClaims/model.js');
    return { honesty: mod.HONESTY_LINE, keyless: mod.KEYLESS_MESSAGE };
  });

  // Status plate: always visible with the honesty line while enabled.
  const statusPlate = await page.evaluate((honesty) => {
    const plate = document.querySelector('.uap-legend.claims');
    return {
      found: !!plate,
      hidden: plate ? plate.hidden : null,
      hasHonesty: plate ? plate.textContent.includes(honesty) : false,
      text: plate ? plate.textContent : '',
    };
  }, strings.honesty);
  check(
    'status plate is visible and carries the honesty line verbatim',
    statusPlate.found && statusPlate.hidden === false && statusPlate.hasHonesty,
    JSON.stringify(statusPlate),
  );

  // A known fixture claim (New York, the freshest in buildFixtureClaims and
  // far from the France-heavy GEIPAN mass, so this is the honest zero-case
  // nearby anchor) at the same pick height the anomalies/ancient-sites
  // gates use.
  const target = await page.evaluate(() => {
    const records = window.__godsEyeView.dataManager.layers
      .get('live-claims')
      .module.getAnalystRecords(20);
    return (
      records.find((r) => r.place?.includes('New York')) ||
      records.find((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon))
    );
  });
  const projectAt = (site) => {
    const viewer = window.__godsEyeView.viewer;
    const ellipsoid = viewer.scene.globe.ellipsoid;
    viewer.camera.cancelFlight?.();
    viewer.camera.setView({
      destination: ellipsoid.cartographicToCartesian({
        longitude: (site.lon * Math.PI) / 180,
        latitude: (site.lat * Math.PI) / 180,
        height: 20000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    const carto = ellipsoid.cartographicToCartesian({
      longitude: (site.lon * Math.PI) / 180,
      latitude: (site.lat * Math.PI) / 180,
      height: 0,
    });
    const p = viewer.scene.cartesianToCanvasCoordinates(carto);
    return p ? { x: p.x, y: p.y } : null;
  };
  await page.evaluate(projectAt, target);
  await new Promise((r) => setTimeout(r, 700));

  await page.screenshot({ path: resolve(SHOT_DIR, 'points-1440.png') });

  const clickPoint = await page.evaluate(projectAt, target);

  // Retina-sharp composition (task: presence pass): every composer's cache
  // key and imageId carry the DPR bucket (glowSprite.js's `dprBucket`), so a
  // live glow-sprite billboard's own imageId must end with the "@<dpr>"
  // token this run actually composed at - proving the wiring reaches a real
  // rendered billboard, not just the composer functions in isolation.
  // Headless Puppeteer runs at devicePixelRatio 1 unless a page/viewport
  // requests otherwise (this gate's own setViewport above never sets
  // deviceScaleFactor), so "@1" is the honest bucket to expect - the retina
  // path itself (deviceScaleFactor 2) is proven separately by the
  // presence-pass screenshot script.
  const claimGlyphImageId = clickPoint
    ? await page.evaluate((pt) => {
        const scene = window.__godsEyeView.viewer.scene;
        const picked = scene.pick({ x: pt.x, y: pt.y }, 12, 12);
        const primitive = picked?.primitive;
        return typeof primitive?.image === 'string' ? primitive.image : null;
      }, clickPoint)
    : null;
  check(
    'the picked live-claims glow-sprite billboard\'s own imageId carries the DPR bucket this run composed at ("@1" under headless Puppeteer, which reports devicePixelRatio 1 unless a page requests otherwise)',
    typeof claimGlyphImageId === 'string' &&
      claimGlyphImageId.startsWith('glow:') &&
      claimGlyphImageId.endsWith('@1'),
    JSON.stringify({ claimGlyphImageId }),
  );

  let dossier = { open: false };
  if (clickPoint) {
    await page.mouse.click(clickPoint.x, clickPoint.y);
    await page
      .waitForFunction(
        () => {
          const d = document.querySelector('.uap-dossier.claims');
          return d && !d.hidden;
        },
        { timeout: 8000 },
      )
      .catch(() => {});
    // The nearby-cases block attaches asynchronously (a lazy fetch of the
    // bundled anomalies dataset), after the dossier itself opens.
    await page
      .waitForFunction(
        () =>
          document.querySelector('.uap-dossier.claims .uap-nearby') !== null,
        { timeout: 8000 },
      )
      .catch(() => {});
    await page.screenshot({ path: resolve(SHOT_DIR, 'dossier-1440.png') });
    dossier = await page.evaluate((honesty) => {
      const d = document.querySelector('.uap-dossier.claims');
      const open = d && !d.hidden;
      const text = d ? d.textContent : '';
      const link = d ? d.querySelector('.uap-source a') : null;
      const dl = d ? d.querySelector('dl')?.textContent || '' : '';
      const hasHonesty = text.includes(honesty);
      const href = link ? link.href : null;
      const nearbyCountText =
        d?.querySelector('.uap-nearby-count')?.textContent ?? null;
      const nearbyEmptyText =
        d?.querySelector('.uap-nearby-empty')?.textContent ?? null;
      const nearbyRowsText = d
        ? [...d.querySelectorAll('.uap-nearby-row')].map(
            (row) => row.textContent,
          )
        : [];
      // Task 3, luminous-pins: this fixture claim (New York) always carries
      // shape 'triangle' (server/providers/claims.js's buildFixtureClaims),
      // so its dossier's animated craft preview (src/ui/craftPreview.js)
      // must be present here, read before the Escape dispatch below closes
      // the dossier.
      const preview = d?.querySelector('.uap-craft-preview') ?? null;
      const previewImg = preview?.querySelector('.uap-craft-preview-glyph');
      const previewSrc = previewImg ? previewImg.getAttribute('src') : null;
      const previewLoading = previewImg
        ? previewImg.getAttribute('loading')
        : null;
      const previewAccent = preview
        ? preview.style.getPropertyValue('--uap-preview-accent').trim()
        : null;
      d?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      return {
        open,
        hasHonesty,
        href,
        dl,
        closed: d ? d.hidden : null,
        nearbyCountText,
        nearbyEmptyText,
        nearbyRowsText,
        previewFound: !!preview,
        previewSrc,
        previewLoading,
        previewAccent,
      };
    }, strings.honesty);
  }
  check(
    'clicking a fixture claim opens the dossier with place/shape/time/source',
    dossier.open === true &&
      /Place/.test(dossier.dl) &&
      /Shape/.test(dossier.dl) &&
      /Time/.test(dossier.dl) &&
      /Source/.test(dossier.dl),
    JSON.stringify(dossier),
  );
  check(
    'dossier carries the honesty line verbatim',
    dossier.hasHonesty === true,
    JSON.stringify(dossier),
  );
  check(
    'dossier links out to the original post (example.com in fixture mode)',
    typeof dossier.href === 'string' && dossier.href.includes('example.com'),
    String(dossier.href),
  );
  check('Escape closes the dossier', dossier.closed === true);

  // Task 3, luminous-pins: the New York fixture claim always carries shape
  // 'triangle' (server/providers/claims.js's buildFixtureClaims), so its
  // dossier's animated craft preview (src/ui/craftPreview.js) must be
  // present, pointing at that shape's own shipped glyph
  // (shapeGlyphs.js's SHAPE_GLYPH_URLS - the same table the layer itself
  // imports, fetched here rather than hardcoded), with the register's own
  // fixed ion accent (PALETTE.ionDark).
  check(
    "a shaped fixture claim's dossier shows the animated craft preview with the matching glyph, loaded lazily",
    target?.shape === 'triangle' &&
      dossier.previewFound === true &&
      dossier.previewSrc === SHAPE_GLYPH_URLS[target.shape] &&
      dossier.previewLoading === 'lazy',
    JSON.stringify({ shape: target?.shape, dossier }),
  );
  check(
    "the craft preview's accent border is the register's own fixed ion hue",
    dossier.previewAccent?.toLowerCase() === PALETTE.ionDark.toLowerCase(),
    JSON.stringify(dossier),
  );

  // Hover and selection feedback (task: presence pass): a real mousemove
  // over the same New York fixture claim sets getRenderDiagnostics()
  // .hoveredId and the canvas cursor to 'pointer' once the shared hover
  // helper's ~80ms throttle (src/ui/hoverPick.js) has had time to fire;
  // moving to a pick-empty point clears both. Opening the claim's dossier
  // then sets selectedId and adds an ion selection-ring billboard
  // (getDiagnostics().selectionRingCount); Escape clears both again.
  // Reuses target/projectAt from the dossier check above.

  // Pick-cost measurement: one `scene.pick` call, timed with
  // `performance.now`, at world zoom (the default boot view) and again at
  // the close zoom the checks below actually use.
  const worldZoomPickCost = await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    const scene = viewer.scene;
    const ellipsoid = scene.globe.ellipsoid;
    viewer.camera.cancelFlight?.();
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
  // world-zoom measurement moved the camera away - re-point it at the
  // fixture claim before the close-zoom measurement and the hover checks.
  const hoverPoint = await page.evaluate(projectAt, target);
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
    await page.mouse.move(hoverPoint.x, hoverPoint.y);
    // Past the shared hover helper's ~80ms throttle, with margin.
    await new Promise((r) => setTimeout(r, 300));
    const hovering = await page.evaluate(() => ({
      diagnostics: window.__godsEyeView.dataManager.layers
        .get('live-claims')
        ?.module?.getDiagnostics?.(),
      cursor: window.__godsEyeView.viewer.scene.canvas.style.cursor,
    }));
    await page.screenshot({
      path: resolve(PRESENCE_SHOT_DIR, 'live-claims-hover-1440.png'),
    });
    // A pixel that is (a) still the canvas element there (not HUD chrome on
    // top of it) and (b) genuinely pick-empty right now - probed rather
    // than assumed from screen distance alone.
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
          .get('live-claims')
          ?.module?.getDiagnostics?.(),
        cursor: window.__godsEyeView.viewer.scene.canvas.style.cursor,
      }));
    }
    hoverProbe = { hovering, away, awayPoint };
  }
  check(
    "hovering the New York fixture claim sets hoveredId and the canvas cursor to pointer, past the shared hover helper's throttle",
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
          const d = document.querySelector('.uap-dossier.claims');
          return d && !d.hidden;
        },
        { timeout: 8000 },
      )
      .catch(() => {});
    // Presence pass (summoned craft): the New York fixture claim always
    // carries a shape (see this file's own doc comment), so this same
    // click also summons its reported archetype. Poll for `animating`
    // specifically - by construction (craftSummon.js) that also proves the
    // model is in the scene and the governor hold is already engaged.
    await page
      .waitForFunction(
        () =>
          window.__godsEyeView.dataManager.layers
            .get('live-claims')
            ?.module?.getCraftSummonDiagnostics?.()?.animating === true,
        { timeout: 5000 },
      )
      .catch(() => {});
    const opened = await page.evaluate(() => ({
      diagnostics: window.__godsEyeView.dataManager.layers
        .get('live-claims')
        ?.module?.getDiagnostics?.(),
      craft: window.__godsEyeView.dataManager.layers
        .get('live-claims')
        ?.module?.getCraftSummonDiagnostics?.(),
      holds: window.__godsEyeView.getRenderGovernorDiagnostics?.()?.holds ?? [],
    }));
    await page.screenshot({
      path: resolve(PRESENCE_SHOT_DIR, 'live-claims-selection-1440.png'),
    });
    await page.evaluate(() => {
      document
        .querySelector('.uap-dossier.claims')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
    });
    const closedState = await page.evaluate(() => ({
      diagnostics: window.__godsEyeView.dataManager.layers
        .get('live-claims')
        ?.module?.getDiagnostics?.(),
      craft: window.__godsEyeView.dataManager.layers
        .get('live-claims')
        ?.module?.getCraftSummonDiagnostics?.(),
      holds: window.__godsEyeView.getRenderGovernorDiagnostics?.()?.holds ?? [],
    }));
    selectionProbe = { opened, closedState };
  }
  check(
    "opening the New York claim's dossier sets selectedId and adds a selection-ring billboard",
    selectionProbe?.opened.diagnostics.selectedId != null &&
      selectionProbe?.opened.diagnostics.selectionRingCount === 1,
    JSON.stringify(selectionProbe?.opened.diagnostics),
  );
  check(
    'Escape closes the dossier and clears selectedId and the selection ring',
    selectionProbe?.closedState.diagnostics.selectedId == null &&
      selectionProbe?.closedState.diagnostics.selectionRingCount === 0,
    JSON.stringify(selectionProbe?.closedState.diagnostics),
  );
  check(
    "opening the shaped New York claim's dossier summons its reported archetype: a Model primitive appears, its animations run and the render governor holds continuous render under its own owner id",
    selectionProbe?.opened.craft?.active === true &&
      selectionProbe?.opened.craft?.holding === true &&
      selectionProbe?.opened.craft?.animating === true &&
      selectionProbe?.opened.holds.includes('craft-summon'),
    JSON.stringify(selectionProbe?.opened.craft) +
      ' holds=' +
      JSON.stringify(selectionProbe?.opened.holds),
  );
  check(
    'closing the claim dossier despawns the summoned craft and releases the governor hold',
    selectionProbe?.closedState.craft?.active === false &&
      selectionProbe?.closedState.craft?.holding === false &&
      !selectionProbe?.closedState.holds.includes('craft-summon'),
    JSON.stringify(selectionProbe?.closedState.craft) +
      ' holds=' +
      JSON.stringify(selectionProbe?.closedState.holds),
  );

  // A shapeless fixture claim (shape: null - "the classifier could not
  // place it in one of the pinned categories", see buildFixtureClaims's own
  // doc comment) must show NO preview at all: no orb fallback here (see
  // buildCraftPreview's own doc comment in src/ui/craftPreview.js) - a
  // dossier should not show a shape the claim never carried.
  const shapelessTarget = await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('live-claims')
      .module.getAnalystRecords(20)
      .find((r) => r.id === 'bluesky:fixture-pacific-south'),
  );
  let shapelessDossier = { found: false };
  const shapelessPoint = shapelessTarget
    ? await page.evaluate(projectAt, shapelessTarget)
    : null;
  if (shapelessPoint) {
    await page.mouse.click(shapelessPoint.x, shapelessPoint.y);
    await page
      .waitForFunction(
        () => {
          const d = document.querySelector('.uap-dossier.claims');
          return d && !d.hidden;
        },
        { timeout: 8000 },
      )
      .catch(() => {});
    // Presence pass (summoned craft): a shapeless claim has nothing for
    // craftSummon.js to load, so there is no async craft state to wait
    // out - a short settle margin is still worth the small cost, so a
    // regression that DID start a summon here would not slip past on
    // timing alone.
    await new Promise((r) => setTimeout(r, 300));
    shapelessDossier = await page.evaluate(() => {
      const d = document.querySelector('.uap-dossier.claims');
      const found = !!d && !d.hidden;
      const preview = d?.querySelector('.uap-craft-preview') ?? null;
      const shapeText = d?.querySelector('dl')?.textContent || '';
      const craft = window.__godsEyeView.dataManager.layers
        .get('live-claims')
        ?.module?.getCraftSummonDiagnostics?.();
      d?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      return { found, previewFound: !!preview, shapeText, craft };
    });
  }
  check(
    'a shapeless fixture claim (shape: null) opens its dossier with no craft preview at all',
    !!shapelessTarget &&
      shapelessTarget.shape == null &&
      shapelessDossier.found === true &&
      shapelessDossier.previewFound === false &&
      /Not stated/.test(shapelessDossier.shapeText),
    JSON.stringify({ shapelessTarget, shapelessDossier }),
  );
  check(
    'a shapeless fixture claim never summons a craft (nothing for craftSummon.js to load)',
    shapelessDossier.craft?.active === false,
    JSON.stringify(shapelessDossier.craft),
  );

  // Reduced motion: the preview's drift and sheen are pure CSS keyframes
  // (anomaly-atlas.css's .uap-craft-preview rules), read directly via
  // computed style rather than a diagnostics function, mirroring
  // qa-anomalies.mjs's own equivalent check. Drives the same fixture
  // dossier-open path already proven above (projectAt/click), once per
  // motion preference, on two fresh pages.
  async function claimsPreviewAnimationOnFreshPage(reduceMotion) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width: 1440, height: 900 });
    if (reduceMotion) {
      await p.emulateMediaFeatures([
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ]);
    }
    await p.goto(`${fixtureBase}/?welcome=0`, {
      waitUntil: 'domcontentloaded',
    });
    await p.waitForFunction(() => window.__godsEyeView?.dataManager, {
      timeout: 60000,
    });
    await p.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('live-claims', true, {
        origin: 'user',
      }),
    );
    await p.waitForFunction(
      () =>
        (window.__godsEyeView.dataManager.layers
          .get('live-claims')
          ?.module?.getStats?.().count ?? 0) > 0,
      { timeout: 30000 },
    );
    const nyTarget = await p.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('live-claims')
        .module.getAnalystRecords(20)
        .find((r) => r.id === 'reddit:fixture-newyork'),
    );
    // Mirrors the main page's own two-step settle (camera fly, wait, THEN
    // read the settled pixel coordinates) - a single immediate projection
    // right after the camera move reads stale coordinates before the
    // renderer's point billboards have actually settled into place. A
    // freshly created browser context's first click can still land before
    // the renderer's very first paint on a slow run, so this retries the
    // click (re-projecting each time, in case the settled pixel coordinate
    // itself drifts) rather than failing on one missed frame.
    let dossierOpen = false;
    for (let attempt = 0; attempt < 3 && !dossierOpen; attempt++) {
      await p.evaluate(projectAt, nyTarget);
      await new Promise((r) => setTimeout(r, 700));
      const point = await p.evaluate(projectAt, nyTarget);
      if (!point) continue;
      await p.mouse.click(point.x, point.y);
      dossierOpen = await p
        .waitForFunction(
          () => {
            const d = document.querySelector('.uap-dossier.claims');
            return d && !d.hidden;
          },
          { timeout: 8000 },
        )
        .then(() => true)
        .catch(() => false);
    }
    const result = await p.evaluate(() => {
      const d = document.querySelector('.uap-dossier.claims');
      const preview = d?.querySelector('.uap-craft-preview');
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
    return result;
  }
  const reducedClaimsPreview = await claimsPreviewAnimationOnFreshPage(true);
  check(
    'the claims craft preview drift and sheen never run under prefers-reduced-motion',
    reducedClaimsPreview.found &&
      reducedClaimsPreview.glyphAnimation === 'none' &&
      reducedClaimsPreview.sheenAnimation === 'none',
    JSON.stringify(reducedClaimsPreview),
  );
  const fullMotionClaimsPreview =
    await claimsPreviewAnimationOnFreshPage(false);
  check(
    'the claims craft preview drift and sheen do run without prefers-reduced-motion (the reduced-motion guard above is a real bypass)',
    fullMotionClaimsPreview.found &&
      fullMotionClaimsPreview.glyphAnimation === 'uap-craft-preview-drift' &&
      fullMotionClaimsPreview.sheenAnimation === 'uap-craft-preview-sheen',
    JSON.stringify(fullMotionClaimsPreview),
  );

  // Nearby historical cases: the truth is computed here, independently,
  // from the same bundled dataset the dossier itself lazily fetches, so
  // this check keeps working as the anomalies dataset grows (see the file
  // header comment).
  const anomaliesRaw = JSON.parse(
    await readFile(
      resolve(REPO_ROOT, 'public/anomalies/anomalies.v1.json'),
      'utf8',
    ),
  );
  const anomalyRows = normalizeAnomalySnapshot(anomaliesRaw);
  const nearbyTruth =
    anomalyRows && Number.isFinite(target?.lat) && Number.isFinite(target?.lon)
      ? findNearbyCases({ lat: target.lat, lon: target.lon }, anomalyRows)
      : null;
  check(
    'the bundled anomalies dataset decodes, so the nearby truth is computable',
    nearbyTruth !== null,
    `target=${JSON.stringify(target)}`,
  );
  // New York sits far from the France-heavy GEIPAN mass: this is genuinely
  // the zero-case branch, not a vacuous check that never runs.
  check(
    'the New York fixture claim genuinely has zero cases nearby (a real zero-path anchor)',
    nearbyTruth !== null && nearbyTruth.count === 0,
    JSON.stringify(nearbyTruth),
  );
  check(
    'nearby block shows the honest zero-case message (computed truth, not a hardcoded number)',
    dossier.nearbyEmptyText ===
      `No historical cases within ${NEARBY_RADIUS_KM} km`,
    JSON.stringify({ nearbyTruth, dossier }),
  );

  check(
    'no page errors during the interactive pass',
    pageErrors.length === 0,
    pageErrors.join(' | '),
  );

  // ── nonzero nearby path: the Paris fixture claim sits at a real French
  // location inside the bundled GEIPAN case mass, so this branch is proven
  // live against real data, not just at the unit level. ──
  const parisTarget = await page.evaluate(() => {
    const records = window.__godsEyeView.dataManager.layers
      .get('live-claims')
      .module.getAnalystRecords(20);
    return records.find((r) => r.place?.includes('Paris'));
  });
  const parisTruth =
    anomalyRows &&
    Number.isFinite(parisTarget?.lat) &&
    Number.isFinite(parisTarget?.lon)
      ? findNearbyCases(
          { lat: parisTarget.lat, lon: parisTarget.lon },
          anomalyRows,
        )
      : null;
  check(
    'the Paris fixture claim genuinely has cases nearby (a real nonzero-path anchor, computed truth)',
    parisTruth !== null && parisTruth.count > 0,
    JSON.stringify(parisTruth),
  );

  const parisClickPoint = await page.evaluate(projectAt, parisTarget);
  let parisDossier = { open: false };
  if (parisClickPoint) {
    await page.mouse.click(parisClickPoint.x, parisClickPoint.y);
    await page
      .waitForFunction(
        () => {
          const d = document.querySelector('.uap-dossier.claims');
          return d && !d.hidden;
        },
        { timeout: 8000 },
      )
      .catch(() => {});
    await page
      .waitForFunction(
        () =>
          document.querySelector('.uap-dossier.claims .uap-nearby') !== null,
        { timeout: 8000 },
      )
      .catch(() => {});
    // Wrap camera.flyTo before clicking a nearby row so a click's effect on
    // the camera is provable even though the flight itself takes 2.2s to
    // finish animating.
    const flyProbe = await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      const original = viewer.camera.flyTo.bind(viewer.camera);
      window.__qaFlyToCalls = 0;
      viewer.camera.flyTo = (options) => {
        window.__qaFlyToCalls++;
        return original(options);
      };
      const row = document.querySelector('.uap-dossier.claims .uap-nearby-row');
      const before = window.__qaFlyToCalls;
      row?.click();
      return {
        rowFound: !!row,
        rowText: row?.textContent ?? null,
        rowTitle: row?.title ?? null,
        calledBefore: before,
        calledAfter: window.__qaFlyToCalls,
      };
    });
    parisDossier = await page.evaluate(() => {
      const d = document.querySelector('.uap-dossier.claims');
      const open = !!(d && !d.hidden);
      const dl = d ? d.querySelector('dl')?.textContent || '' : '';
      const nearbyCountText =
        d?.querySelector('.uap-nearby-count')?.textContent ?? null;
      const nearbyRowsText = d
        ? [...d.querySelectorAll('.uap-nearby-row')].map(
            (row) => row.textContent,
          )
        : [];
      d?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      return { open, dl, nearbyCountText, nearbyRowsText };
    });
    parisDossier.flyProbe = flyProbe;
  }
  check(
    'clicking the Paris fixture claim opens its dossier',
    parisClickPoint !== null && /Place/.test(parisDossier.dl || ''),
    JSON.stringify({ parisTarget, parisDossier }),
  );
  const parisExpectedCountText = parisTruth
    ? `${parisTruth.count} historical case${parisTruth.count === 1 ? '' : 's'} within ${NEARBY_RADIUS_KM} km`
    : null;
  const parisExpectedRows = parisTruth
    ? parisTruth.top.map(
        (c) =>
          `${c.year ?? 'unknown'}, ${c.status ?? 'unknown'}, ${Math.round(c.distanceKm)} km`,
      )
    : null;
  check(
    'nearby block shows the correct nonzero case count for Paris (computed truth, not a hardcoded number)',
    parisDossier.nearbyCountText === parisExpectedCountText,
    JSON.stringify({
      expected: parisExpectedCountText,
      got: parisDossier.nearbyCountText,
    }),
  );
  check(
    'nearby block lists the nearest cases for Paris, nearest first, matching the computed truth (top rows render)',
    JSON.stringify(parisDossier.nearbyRowsText) ===
      JSON.stringify(parisExpectedRows),
    JSON.stringify({
      expected: parisExpectedRows,
      got: parisDossier.nearbyRowsText,
    }),
  );
  check(
    'clicking a nearby-case row invokes the camera fly-to (the nonzero branch is interactive, not just rendered)',
    parisDossier.flyProbe?.rowFound === true &&
      parisDossier.flyProbe?.calledAfter >
        (parisDossier.flyProbe?.calledBefore ?? -1),
    JSON.stringify(parisDossier.flyProbe),
  );
  check(
    'with anomalies off, a nearby row carries a tooltip explaining why it will not open a case',
    parisDossier.flyProbe?.rowTitle === 'Enable sky events to open the case',
    JSON.stringify(parisDossier.flyProbe),
  );
  const anomalyDossierWhileOff = await page.evaluate(() => {
    const d = document.querySelector('aside[aria-label="Case dossier"]');
    return { present: !!d, hidden: d ? d.hidden : null };
  });
  check(
    "with anomalies off, clicking the nearby row never opens the sky register's own dossier (fly-only stays fly-only)",
    anomalyDossierWhileOff.present === false ||
      anomalyDossierWhileOff.hidden === true,
    JSON.stringify(anomalyDossierWhileOff),
  );

  // ── fly-and-open: with the sky register enabled, the same nearby row also
  // opens that case's own dossier, through the shell channel
  // LayerBindings#_connectLiveClaimsShell hands the live-claims layer -
  // mirroring how case search already reaches focusCase - never a direct
  // reference this register holds on the anomalies module itself. ──
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('anomalies', true, {
      origin: 'user',
    }),
  );
  await page.waitForFunction(
    () =>
      (window.__godsEyeView.dataManager.layers
        .get('anomalies')
        ?.module?.getStats?.().count ?? 0) > 0,
    { timeout: 30000 },
  );
  // The earlier nearby-row click flew the camera away from the Paris
  // claim's on-screen position, so it is reprojected fresh before this
  // block clicks it again, exactly as it was the first time.
  const parisClickPointAgain = await page.evaluate(projectAt, parisTarget);
  await page.mouse.click(parisClickPointAgain.x, parisClickPointAgain.y);
  await page
    .waitForFunction(
      () => {
        const d = document.querySelector('.uap-dossier.claims');
        return d && !d.hidden;
      },
      { timeout: 8000 },
    )
    .catch(() => {});
  await page
    .waitForFunction(
      () =>
        document.querySelector('.uap-dossier.claims .uap-nearby-row') !== null,
      { timeout: 8000 },
    )
    .catch(() => {});
  const enabledRowTitle = await page.evaluate(
    () =>
      document.querySelector('.uap-dossier.claims .uap-nearby-row')?.title ??
      null,
  );
  check(
    'with anomalies on, the nearby row no longer carries the "enable sky events" tooltip',
    enabledRowTitle === 'Open the case dossier',
    String(enabledRowTitle),
  );
  await page.evaluate(() =>
    document.querySelector('.uap-dossier.claims .uap-nearby-row')?.click(),
  );
  await page
    .waitForFunction(
      () => {
        const d = document.querySelector('aside[aria-label="Case dossier"]');
        return d && !d.hidden;
      },
      { timeout: 8000 },
    )
    .catch(() => {});
  const anomalyDossierWhileOn = await page.evaluate(() => {
    const d = document.querySelector('aside[aria-label="Case dossier"]');
    const claims = document.querySelector('.uap-dossier.claims');
    return {
      open: !!(d && !d.hidden),
      dl: d ? d.querySelector('dl')?.textContent || '' : '',
      claimsHidden: claims ? claims.hidden : null,
    };
  });
  check(
    "with anomalies on, clicking a nearby row opens the sky register's own case dossier (its plate appears)",
    anomalyDossierWhileOn.open === true &&
      /Where/.test(anomalyDossierWhileOn.dl) &&
      /Reported as/.test(anomalyDossierWhileOn.dl),
    JSON.stringify(anomalyDossierWhileOn),
  );
  check(
    "opening the sky register's dossier from a nearby row closes the claim dossier (one on-screen dossier slot, shared across registers)",
    anomalyDossierWhileOn.claimsHidden === true,
    JSON.stringify(anomalyDossierWhileOn),
  );
  // Close the case dossier and turn the sky register back off, so the rest
  // of this script runs against the same live-claims-only state as before
  // this block.
  await page.evaluate(() => {
    document
      .querySelector('aside[aria-label="Case dossier"]')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
  });
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('anomalies', false, {
      origin: 'user',
    }),
  );

  // --- Stream ticker: newest ~10 claims, newest first, a row click flies
  // and opens that claim's dossier (which also closes the ticker, since
  // both plates share the register's right-hand edge), reduced motion
  // never animates a row in, and disabling the layer closes the ticker
  // rather than leaving it orphaned open.
  await page.evaluate(() =>
    document.querySelector('.uap-claims-stream-toggle')?.click(),
  );
  await page
    .waitForFunction(
      () => {
        const t = document.querySelector('.uap-claims-ticker');
        return t && !t.hidden;
      },
      { timeout: 8000 },
    )
    .catch(() => {});
  await page.screenshot({ path: resolve(SHOT_DIR, 'ticker-1440.png') });
  const tickerOpen = await page.evaluate(() => {
    const t = document.querySelector('.uap-claims-ticker');
    const rows = t ? [...t.querySelectorAll('.uap-claims-ticker-row')] : [];
    return {
      visible: !!(t && !t.hidden),
      count: rows.length,
      places: rows.map(
        (r) => r.querySelector('.uap-claims-ticker-place')?.textContent ?? '',
      ),
    };
  });
  check(
    'stream ticker opens with fixture entries (count > 0)',
    tickerOpen.visible && tickerOpen.count > 0,
    JSON.stringify(tickerOpen),
  );
  // buildFixtureClaims() (server/providers/claims.js) deliberately does NOT
  // list its ~9 fictional claims newest first by `fetchedAt`: the Paris
  // entry sits at the end of that array but is chronologically the fourth
  // newest, so this assertion only passes if the ticker genuinely sorts by
  // `fetchedAt` itself. A pass-through of feed order would put Paris last,
  // not fourth, and fail this check.
  const expectedTickerPlaceOrder = [
    'New York City, New York, United States',
    'London, United Kingdom',
    'Tokyo, Japan',
    'Paris, France',
    'Sydney, Australia',
    'Mexico City, Mexico',
    'Open Pacific Ocean',
    'Moscow, Russia',
    'Open Pacific Ocean',
  ];
  check(
    'stream ticker lists claims newest first by fetchedAt',
    JSON.stringify(tickerOpen.places) ===
      JSON.stringify(expectedTickerPlaceOrder),
    JSON.stringify(tickerOpen.places),
  );

  const tickerRowClick = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.uap-claims-ticker-row')];
    const tokyoRow = rows.find((r) =>
      r
        .querySelector('.uap-claims-ticker-place')
        ?.textContent?.includes('Tokyo'),
    );
    tokyoRow?.click();
    return { clicked: !!tokyoRow };
  });
  await page
    .waitForFunction(
      () => {
        const d = document.querySelector('.uap-dossier.claims');
        return d && !d.hidden;
      },
      { timeout: 8000 },
    )
    .catch(() => {});
  const afterTickerClick = await page.evaluate(() => {
    const d = document.querySelector('.uap-dossier.claims');
    const t = document.querySelector('.uap-claims-ticker');
    return {
      dossierOpen: !!(d && !d.hidden),
      dossierPlace: d?.querySelector('h2')?.textContent ?? null,
      tickerHiddenAfterClick: t ? t.hidden : null,
    };
  });
  check(
    'a stream ticker row click flies the camera and opens that claim' +
      "'s dossier",
    tickerRowClick.clicked &&
      afterTickerClick.dossierOpen &&
      afterTickerClick.dossierPlace === 'Tokyo, Japan',
    JSON.stringify({ tickerRowClick, afterTickerClick }),
  );
  check(
    'opening a dossier from the ticker closes the ticker (the two plates never overlap)',
    afterTickerClick.tickerHiddenAfterClick === true,
    JSON.stringify(afterTickerClick),
  );

  // Close the dossier and reopen the ticker on the main page, ready for the
  // disable check below. openTicker() always renders with animateNew:false
  // ("a fresh open is not a new arrival" - src/layers/liveClaims/index.js)
  // so this reopen alone proves nothing about the entrance animation; that
  // is what the two fresh-page checks right after this actually drive.
  await page.evaluate(() => {
    const d = document.querySelector('.uap-dossier.claims');
    d?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  await page.evaluate(() =>
    document.querySelector('.uap-claims-stream-toggle')?.click(),
  );
  await page
    .waitForFunction(
      () => {
        const t = document.querySelector('.uap-claims-ticker');
        return t && !t.hidden;
      },
      { timeout: 8000 },
    )
    .catch(() => {});

  // Reduced motion: the entrance class only ever comes from update()'s own
  // renderTicker({ animateNew: true }) call while the ticker plate is
  // already open. openTicker() forces animateNew:false unconditionally, so
  // reopening the ticker (as above) can never reach that path - this check
  // must drive update() itself while the plate is open. Every fixture
  // claim id is only ever "new" the first time the ticker renders it, so
  // each branch below runs on its own fresh page (a fresh layer instance
  // that has never rendered the ticker, so no id is marked seen yet),
  // reveals the ticker plate directly through the DOM - never through
  // openTicker() - and then calls the layer's own update() with the plate
  // already open, via the same dataManager module handle used throughout
  // this script.
  async function tickerAnimateOnFreshPage(reduceMotion) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    if (reduceMotion) {
      await p.emulateMediaFeatures([
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ]);
    }
    await p.goto(`${fixtureBase}/?welcome=0`, {
      waitUntil: 'domcontentloaded',
    });
    await p.waitForFunction(() => window.__godsEyeView?.dataManager, {
      timeout: 60000,
    });
    await p.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('live-claims', true, {
        origin: 'user',
      }),
    );
    await p.waitForFunction(
      () =>
        (window.__godsEyeView.dataManager.layers
          .get('live-claims')
          ?.module?.getStats?.().count ?? 0) > 0,
      { timeout: 30000 },
    );
    return p.evaluate(async () => {
      const entry = window.__godsEyeView.dataManager.layers.get('live-claims');
      const ticker = document.querySelector('.uap-claims-ticker');
      ticker.hidden = false;
      await entry.module.update();
      const rows = [...ticker.querySelectorAll('.uap-claims-ticker-row')];
      return {
        count: rows.length,
        anyAnimated: rows.some((r) =>
          r.classList.contains('uap-ticker-row-enter'),
        ),
      };
    });
  }

  const reducedMotionTicker = await tickerAnimateOnFreshPage(true);
  check(
    'stream ticker never carries the slide-in animation class under prefers-reduced-motion',
    reducedMotionTicker.count > 0 && reducedMotionTicker.anyAnimated === false,
    JSON.stringify(reducedMotionTicker),
  );

  const fullMotionTicker = await tickerAnimateOnFreshPage(false);
  check(
    'stream ticker carries the slide-in animation class on a genuinely new arrival without prefers-reduced-motion',
    fullMotionTicker.count > 0 && fullMotionTicker.anyAnimated === true,
    JSON.stringify(fullMotionTicker),
  );

  // Reduced motion: the points themselves carry a continuous sine "breathing"
  // pulse (src/layers/liveClaims/rendering.js, onTick), independent of the
  // ticker's own one-shot entrance animation checked above. Proven through a
  // tiny diagnostic (`layer.getDiagnostics()`, mirroring the getDiagnostics
  // pattern other layers already expose for their own qa gates) rather than
  // screenshot diffing: two snapshots of the same rendered point across a
  // real delay must hold near-steady under prefers-reduced-motion (within
  // DRIFT_EPSILON, not bit-exact: age-based brightness legitimately keeps
  // decaying with real elapsed time even with the sine term removed, a
  // few thousandths at most over well under a second against the 48-hour
  // window), and must move well past that epsilon under ordinary motion
  // (the sine pulse's own amplitude is over an order of magnitude larger),
  // proving the reduced-motion branch is a genuine bypass, not an accident
  // of the fixture data.
  async function pulseDiagnosticsOnFreshPage(reduceMotion) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    if (reduceMotion) {
      await p.emulateMediaFeatures([
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ]);
    }
    await p.goto(`${fixtureBase}/?welcome=0`, {
      waitUntil: 'domcontentloaded',
    });
    await p.waitForFunction(() => window.__godsEyeView?.dataManager, {
      timeout: 60000,
    });
    await p.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('live-claims', true, {
        origin: 'user',
      }),
    );
    await p.waitForFunction(
      () =>
        (window.__godsEyeView.dataManager.layers
          .get('live-claims')
          ?.module?.getStats?.().count ?? 0) > 0,
      { timeout: 30000 },
    );
    const readDiagnostics = () =>
      p.evaluate(() =>
        window.__godsEyeView.dataManager.layers
          .get('live-claims')
          .module.getDiagnostics(),
      );
    // A tick needs to have actually run at least once before the first
    // snapshot: the renderer only updates a point's size/alpha on
    // viewer.clock.onTick, which only fires while the layer holds
    // continuous render (rows loaded and visible).
    await new Promise((r) => setTimeout(r, 300));
    const first = await readDiagnostics();
    await new Promise((r) => setTimeout(r, 900));
    const second = await readDiagnostics();
    return { first, second };
  }

  // Comfortably above the largest age-decay drift a sub-second delay can
  // produce (observed order of 1e-5), and comfortably below the sine
  // pulse's own amplitude (PULSE_SIZE_AMPLITUDE_PX 1.6,
  // PULSE_ALPHA_AMPLITUDE 0.12 - see rendering.js), so it cleanly separates
  // "held steady" from "still pulsing".
  const PIXEL_DRIFT_EPSILON = 0.05;
  const ALPHA_DRIFT_EPSILON = 0.01;

  const reducedPulse = await pulseDiagnosticsOnFreshPage(true);
  check(
    'live claims points: getDiagnostics reports prefers-reduced-motion',
    reducedPulse.first.reducedMotion === true &&
      reducedPulse.second.reducedMotion === true,
    JSON.stringify(reducedPulse),
  );
  check(
    "live claims points: the tick's sine pulse never runs under prefers-reduced-motion (pixel size and alpha hold near-steady across ticks, only age-decay drift)",
    reducedPulse.first.pointCount > 0 &&
      Math.abs(
        reducedPulse.first.firstPixelSize - reducedPulse.second.firstPixelSize,
      ) < PIXEL_DRIFT_EPSILON &&
      Math.abs(reducedPulse.first.firstAlpha - reducedPulse.second.firstAlpha) <
        ALPHA_DRIFT_EPSILON,
    JSON.stringify(reducedPulse),
  );

  const fullMotionPulse = await pulseDiagnosticsOnFreshPage(false);
  check(
    'live claims points: without prefers-reduced-motion the sine pulse keeps modulating pixel size or alpha well past the age-decay epsilon (the reduced-motion branch above is a real bypass, not an accident)',
    fullMotionPulse.first.pointCount > 0 &&
      (Math.abs(
        fullMotionPulse.first.firstPixelSize -
          fullMotionPulse.second.firstPixelSize,
      ) >= PIXEL_DRIFT_EPSILON ||
        Math.abs(
          fullMotionPulse.first.firstAlpha - fullMotionPulse.second.firstAlpha,
        ) >= ALPHA_DRIFT_EPSILON),
    JSON.stringify(fullMotionPulse),
  );

  // Disable: the ticker plate must close, not stay open with a dead
  // channel behind it (the Spotter plate orphan lesson).
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('live-claims', false, {
      origin: 'user',
    }),
  );
  const afterDisable = await page.evaluate(() => {
    const t = document.querySelector('.uap-claims-ticker');
    return { stillInDom: !!t, hidden: t ? t.hidden : null };
  });
  check(
    'disabling the layer closes the stream ticker rather than orphaning it open',
    afterDisable.stillInDom === true && afterDisable.hidden === true,
    JSON.stringify(afterDisable),
  );

  // Mobile screenshots: fresh page at 390x844, layer already restorable via
  // the share link below doubles as the mobile points+dossier capture.
  const mobile = await browser.createBrowserContext();
  const mobilePage = await mobile.newPage();
  await mobilePage.setViewport({ width: 390, height: 844 });
  await mobilePage.goto(`${fixtureBase}/?welcome=0`, {
    waitUntil: 'domcontentloaded',
  });
  await mobilePage.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 60000,
  });
  await mobilePage
    .waitForFunction(
      () =>
        document.getElementById('loading-screen')?.classList.contains('hidden'),
      { timeout: 60000 },
    )
    .catch(() => {});
  await mobilePage.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('live-claims', true, {
      origin: 'user',
    }),
  );
  await mobilePage
    .waitForFunction(
      () =>
        (window.__godsEyeView.dataManager.layers
          .get('live-claims')
          ?.module?.getStats?.().count ?? 0) > 0,
      { timeout: 30000 },
    )
    .catch(() => {});
  await mobilePage.evaluate(projectAt, target);
  await new Promise((r) => setTimeout(r, 700));
  await mobilePage.screenshot({ path: resolve(SHOT_DIR, 'points-390.png') });
  const mobileClick = await mobilePage.evaluate(projectAt, target);
  if (mobileClick) {
    await mobilePage.mouse.click(mobileClick.x, mobileClick.y);
    await mobilePage
      .waitForFunction(
        () => {
          const d = document.querySelector('.uap-dossier.claims');
          return d && !d.hidden;
        },
        { timeout: 8000 },
      )
      .catch(() => {});
  }
  const mobileDossier = await mobilePage.evaluate(() => {
    const d = document.querySelector('.uap-dossier.claims');
    return { found: !!d, open: !!(d && !d.hidden) };
  });
  await mobilePage.screenshot({ path: resolve(SHOT_DIR, 'dossier-390.png') });
  check(
    'mobile (390px) dossier opens from a real click and both screenshots are captured',
    mobileDossier.found && mobileDossier.open,
    JSON.stringify(mobileDossier),
  );

  // Share link with token 5.
  const fresh = await browser.createBrowserContext();
  const share = await fresh.newPage();
  await share.goto(
    `${fixtureBase}/?welcome=0#lat=40.71&lon=-74.01&alt=26000000&pitch=-90&v=2&l=5`,
    { waitUntil: 'domcontentloaded' },
  );
  await share.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 60000,
  });
  await share
    .waitForFunction(
      () => window.__godsEyeView.dataManager.isEnabled('live-claims'),
      { timeout: 30000 },
    )
    .catch(() => {});
  const restored = await share.evaluate(() =>
    window.__godsEyeView.dataManager.isEnabled('live-claims'),
  );
  check('share link with token 5 restores the layer', restored === true);

  // ── keyless server: no fixture, no key, honest empty state ──
  keylessServer = startServer(KEYLESS_PORT, {
    GEV_CLAIMS_FIXTURE: '',
    DEEPSEEK_API_KEY: '',
  });
  await waitForServer(KEYLESS_PORT);
  const keylessBase = `http://localhost:${KEYLESS_PORT}`;
  const keylessCtx = await browser.createBrowserContext();
  const keylessPage = await keylessCtx.newPage();
  await keylessPage.goto(`${keylessBase}/?welcome=0`, {
    waitUntil: 'domcontentloaded',
  });
  await keylessPage.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 60000,
  });
  await keylessPage.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('live-claims', true, {
      origin: 'user',
    }),
  );
  await keylessPage
    .waitForFunction(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('live-claims')
          ?.module?.getStats?.().status === 'no-key',
      { timeout: 30000 },
    )
    .catch(() => {});
  const keylessState = await keylessPage.evaluate((keyless) => {
    const stats = window.__godsEyeView.dataManager.layers
      .get('live-claims')
      .module.getStats();
    const plate = document.querySelector('.uap-legend.claims');
    return {
      stats,
      plateText: plate ? plate.textContent : '',
      hasKeylessMessage: plate ? plate.textContent.includes(keyless) : false,
    };
  }, strings.keyless);
  check(
    'keyless boot keeps the register empty and honest, no error',
    keylessState.stats.status === 'no-key' &&
      keylessState.stats.count === 0 &&
      keylessState.stats.error === null &&
      keylessState.hasKeylessMessage,
    JSON.stringify(keylessState),
  );
} finally {
  await browser.close();
  if (fixtureServer) stopServer(fixtureServer);
  if (keylessServer) stopServer(keylessServer);
}
console.log(`RESULT: ${failures} failures`);
process.exit(failures ? 1 : 0);
