#!/usr/bin/env node
/**
 * qa-presence-pass-shot — retina-composition proof for task 1 of the
 * presence pass (src/ui/glowSprite.js, src/layers/anomalies/rendering.js,
 * src/layers/ancientSites/rendering.js all now compose at
 * min(devicePixelRatio, 2) times the CSS size, with the DPR bucket joining
 * every cache key and imageId). Not a pass/fail qa gate: a throwaway
 * capture script that
 *   1. launches Puppeteer with deviceScaleFactor 2 (so devicePixelRatio
 *      reads 2 in the page, the retina path Puppeteer's headless default
 *      of 1 never otherwise exercises),
 *   2. flies to a close-zoom shape-glyph billboard over the anomalies
 *      register's densest cluster (GEIPAN's own France concentration, the
 *      same anchor qa-anomalies.mjs uses for its own shape-glyph check),
 *   3. saves a 1440px screenshot into the gitignored qa-shots/presence-pass/
 *      directory, and
 *   4. reads the picked billboard's own imageId back and logs whether it
 *      carries the "@2" DPR bucket token, proving the retina wiring reaches
 *      a real rendered billboard end to end - not just the composer
 *      functions in isolation, and not just the "@1" headless-default case
 *      the persistent qa-anomalies/qa-ancient-sites/qa-claims gates assert
 *      (those gates deliberately leave deviceScaleFactor alone, to avoid
 *      disturbing their own pixel-sampling checks - see their own "@1"
 *      comments).
 *
 * Usage: node scripts/qa-presence-pass-shot.mjs [--url http://localhost:4173]
 */
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const argv = process.argv;
const url = argv.includes('--url')
  ? argv[argv.indexOf('--url') + 1]
  : process.env.QA_BASE_URL || 'http://localhost:4173';
const SHOT_DIR = new URL('../qa-shots/presence-pass/', import.meta.url);
mkdirSync(SHOT_DIR, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});

let exitCode = 0;
try {
  const page = await browser.newPage();
  // deviceScaleFactor 2 is the point of this script: Puppeteer reports
  // devicePixelRatio 2 to the page from here on, so every composer this
  // task touched actually exercises its retina branch rather than the
  // headless-default "@1" bucket.
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  // ?welcome=0 skips the boot/welcome overlay (the qa gates all do this -
  // see qa-anomalies.mjs), which otherwise sits over the globe and can
  // obscure a screenshot or a tight crop taken shortly after load.
  await page.goto(`${url}?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.dataManager, {
    timeout: 60_000,
  });

  const reportedDpr = await page.evaluate(() => window.devicePixelRatio);
  console.log(`page devicePixelRatio: ${reportedDpr}`);

  await page.evaluate(async () => {
    await window.__godsEyeView.dataManager.setEnabled('anomalies', true, {
      origin: 'user',
    });
  });
  await page.waitForFunction(
    () =>
      (window.__godsEyeView.dataManager.layers
        .get('anomalies')
        ?.module?.getStats?.().count ?? 0) > 0,
    { timeout: 30_000 },
  );
  // Known year, same reasoning as qa-anomalies.mjs's own shape-glyph check:
  // a fixed year means every candidate below (chosen well before it) stays
  // inWindow regardless of wherever the dial would otherwise default to.
  await page.evaluate(() => {
    window.__godsEyeView.dataManager.layers
      .get('anomalies')
      ?.module?.setYear?.(2026);
  });

  // Same France-area, pre-2010, non-hero anchor qa-anomalies.mjs's own
  // shape-glyph check uses - a real case from the shipped dataset, never
  // hardcoded coordinates.
  const target = await page.evaluate(async () => {
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
  if (!target) {
    console.error('no France-area shape-glyph anchor found in the dataset');
    exitCode = 1;
  } else {
    const point = await page.evaluate((site) => {
      const viewer = window.__godsEyeView.viewer;
      const ellipsoid = viewer.scene.globe.ellipsoid;
      viewer.camera.cancelFlight();
      viewer.camera.setView({
        destination: ellipsoid.cartographicToCartesian({
          longitude: (site.lon * Math.PI) / 180,
          latitude: (site.lat * Math.PI) / 180,
          height: 200000,
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
    }, target);
    await new Promise((r) => setTimeout(r, 900));
    await page.evaluate(() =>
      window.__godsEyeView.viewer.scene.requestRender(),
    );
    await new Promise((r) => setTimeout(r, 200));

    const shotPath = new URL('shape-glyph-1440.png', SHOT_DIR).pathname;
    await page.screenshot({ path: shotPath });
    console.log(`saved ${shotPath}`);

    // A tight crop around the picked billboard itself (Puppeteer's `clip`
    // is in CSS pixels; the saved PNG still carries the full
    // deviceScaleFactor-2 physical-pixel density within that region), so
    // the glyph's own retina sharpness is inspectable at native resolution
    // rather than lost in a full 1440px page capture where the billboard
    // is only a few CSS pixels across.
    if (point) {
      const cropPath = new URL('shape-glyph-crop-1440.png', SHOT_DIR).pathname;
      await page.screenshot({
        path: cropPath,
        clip: { x: point.x - 40, y: point.y - 40, width: 80, height: 80 },
      });
      console.log(`saved ${cropPath}`);
    }

    const imageId = point
      ? await page.evaluate((pt) => {
          const scene = window.__godsEyeView.viewer.scene;
          const picked = scene.pick({ x: pt.x, y: pt.y }, 12, 12);
          const primitive = picked?.primitive;
          return typeof primitive?.image === 'string' ? primitive.image : null;
        }, point)
      : null;
    console.log(`picked billboard imageId: ${imageId}`);
    if (typeof imageId === 'string' && imageId.endsWith('@2')) {
      console.log(
        '[PASS] the picked billboard composed at the retina (@2) DPR bucket',
      );
    } else {
      console.error(
        `[FAIL] expected an imageId ending "@2", got ${JSON.stringify(imageId)}`,
      );
      exitCode = 1;
    }
  }
} finally {
  await browser.close();
}
process.exit(exitCode);
