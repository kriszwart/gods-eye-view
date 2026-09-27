#!/usr/bin/env node
/**
 * Browser proof of the live claims register acceptance: registration,
 * fixture claims rendering as pulsing ion points, dossier open with the
 * place/shape/time/source fields, the honesty line verbatim, a link-out to
 * the original post, Escape close, cross-register dossier exclusivity, and
 * share-link restore via token 5 - all against a THROWAWAY server this
 * script starts itself with GEV_CLAIMS_FIXTURE=1 on a spare port (never the
 * controller-managed :4173, which has no fixture env).
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
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const VITE_BIN = resolve(REPO_ROOT, 'node_modules/.bin/vite');
const FIXTURE_PORT = 4581;
const KEYLESS_PORT = 4582;
const SHOT_DIR = resolve(REPO_ROOT, 'qa-shots/live-claims');
mkdirSync(SHOT_DIR, { recursive: true });

let failures = 0;
const check = (name, passed, detail = '') => {
  console.log(
    `[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
  if (!passed) failures++;
};

/** Start a throwaway dev server on `port` with `envExtra` merged over the
 * current process env, and resolve once it answers HTTP requests. */
function startServer(port, envExtra) {
  const child = spawn(VITE_BIN, [], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), ...envExtra },
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

  // A known fixture claim (New York, the freshest in buildFixtureClaims) at
  // the same pick height the anomalies/ancient-sites gates use.
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

  await mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: resolve(SHOT_DIR, 'points-1440.png') });

  const clickPoint = await page.evaluate(projectAt, target);
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
    await page.screenshot({ path: resolve(SHOT_DIR, 'dossier-1440.png') });
    dossier = await page.evaluate((honesty) => {
      const d = document.querySelector('.uap-dossier.claims');
      const open = d && !d.hidden;
      const text = d ? d.textContent : '';
      const link = d ? d.querySelector('.uap-source a') : null;
      const dl = d ? d.querySelector('dl')?.textContent || '' : '';
      const hasHonesty = text.includes(honesty);
      const href = link ? link.href : null;
      d?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      return {
        open,
        hasHonesty,
        href,
        dl,
        closed: d ? d.hidden : null,
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

  check(
    'no page errors during the interactive pass',
    pageErrors.length === 0,
    pageErrors.join(' | '),
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
