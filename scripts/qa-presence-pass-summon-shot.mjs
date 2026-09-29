#!/usr/bin/env node
/**
 * qa-presence-pass-summon-shot: visual proof for task 3 of the presence
 * pass (src/app/craftSummon.js, wired through
 * src/layers/anomalies/index.js's openDossier). Not a pass/fail qa gate: a
 * throwaway capture script that
 *   1. enables the anomalies layer and opens a real, non-hero, shaped
 *      case's dossier (a genuine dataset row, never hardcoded coordinates),
 *      which summons its reported archetype at the case's own location,
 *   2. waits for the summon's animations to actually start
 *      (getCraftSummonDiagnostics().animating), proving the model loaded
 *      and is not just requested,
 *   3. sets Spectral explicitly (registered as the atlas default per
 *      PHENOMENA_DESIGN.md, though the HUD's own boot-default label reads
 *      "Normal" - a pre-existing, out-of-scope characteristic) and saves a
 *      1440px screenshot, then switches to Void and saves a second
 *      screenshot once the style crossfade settles,
 * into the gitignored qa-shots/presence-pass/ directory.
 *
 * Usage: node scripts/qa-presence-pass-summon-shot.mjs [--url http://localhost:4173]
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
  await page.setViewport({ width: 1440, height: 900 });
  // ?welcome=0 skips the boot/welcome overlay, which otherwise sits over
  // the globe and would obscure the screenshot.
  await page.goto(`${url}?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.dataManager, {
    timeout: 60_000,
  });

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

  // A real, non-hero row from the shipped dataset - the France-area anchor
  // qa-anomalies.mjs's own shape-glyph check uses, so a craft always exists
  // at public/anomalies/crafts/<shape>.glb for it.
  const target = await page.evaluate(async () => {
    const r = await fetch('/anomalies/anomalies.v1.json');
    const json = await r.json();
    const cols = json.columns;
    const crafts = json.crafts;
    for (let i = 0; i < cols.id.length; i++) {
      const lat = cols.lat[i];
      const lon = cols.lon[i];
      if (
        typeof lat === 'number' &&
        typeof lon === 'number' &&
        lat > 48.3 &&
        lat < 49.3 &&
        lon > 1.7 &&
        lon < 2.9 &&
        cols.hero?.[i] !== 1
      ) {
        return {
          id: cols.id[i],
          lat,
          lon,
          craft: crafts[cols.craft[i]] || 'orb',
        };
      }
    }
    return null;
  });

  if (!target) {
    console.error('no France-area, non-hero anchor found in the dataset');
    exitCode = 1;
  } else {
    console.log(`target case ${target.id}, craft ${target.craft}`);
    // focusCase (src/layers/anomalies/index.js) both flies to the row and
    // opens its dossier - the same path a real click or the case-search
    // picker uses - which summons the craft for a non-hero, shaped row.
    // Its own `viewer.camera.flyTo({destination, duration: 2.2})` is
    // fire-and-forget (focusCase's returned promise resolves once the
    // dossier's own case-detail fetch settles, not once the 2.2s flight
    // finishes), so the flight is still under way when this evaluate call
    // returns - wait out the flight itself before framing a screenshot on
    // it, not just the (much faster) craft load.
    await page.evaluate(
      (id) =>
        window.__godsEyeView.dataManager.layers
          .get('anomalies')
          .module.focusCase(id),
      target.id,
    );
    await new Promise((r) => setTimeout(r, 2600));
    // focusCase's own flight (above) lands on a strict nadir view (no
    // orientation given to flyTo, Cesium's default is straight down) at
    // the case's own lat/lon - directly above both the case's flat point
    // marker AND the summoned craft floating 650m over it. A billboard
    // with disableDepthTestDistance (every point marker in this register)
    // always draws over any 3D geometry at the same screen pixel
    // regardless of true depth order, so a strict nadir view collapses the
    // craft and its marker onto the identical pixel and the marker wins,
    // hiding the craft entirely - a screenshot-framing artifact, not a
    // feature bug (a real click never snaps the camera to nadir; the
    // guided tour's own hero framing already uses this same oblique
    // offset for exactly this reason). Reframe onto a manually-computed
    // oblique offset (heading 20 deg, pitch -26 deg, matching playTour's
    // own hero framing angles, this same file) so the craft reads as a
    // distinct shape floating above its marker.
    //
    // flyToBoundingSphere was tried first and dropped: it auto-expands the
    // offset's own range to whatever distance fits the WHOLE bounding
    // sphere in frame, so a small, close-up radius/range pairing got
    // silently overridden into a much wider shot than intended, and at
    // small ranges (a few hundred metres) the camera ended up clipped
    // into or under real terrain here (Yvelines has real elevation above
    // the WGS84 ellipsoid), throwing the projected craft position off
    // screen entirely. A flat-plane approximation (1 deg latitude =
    // 111,320 m, 1 deg longitude scaled by cos(latitude)) at a few
    // kilometres' range keeps the same terrain-height error a small
    // fraction of the camera's own height above it, and needs no `Cesium`
    // global (not exposed on `window`) beyond plain trigonometry and the
    // viewer's own ellipsoid, mirroring this file's own projectAt() idiom.
    await page.evaluate((site) => {
      const viewer = window.__godsEyeView.viewer;
      const headingDeg = 20;
      const pitchDeg = -26;
      const rangeM = 3000;
      const depression = (Math.abs(pitchDeg) * Math.PI) / 180;
      const horizontalM = rangeM * Math.cos(depression);
      const verticalM = rangeM * Math.sin(depression);
      const headingRad = (headingDeg * Math.PI) / 180;
      const eastM = horizontalM * Math.sin(headingRad);
      const northM = horizontalM * Math.cos(headingRad);
      const metresPerDegLat = 111320;
      const metresPerDegLon = 111320 * Math.cos((site.lat * Math.PI) / 180);
      const camLat = site.lat + northM / metresPerDegLat;
      const camLon = site.lon + eastM / metresPerDegLon;
      const ellipsoid = viewer.scene.globe.ellipsoid;
      const destination = ellipsoid.cartographicToCartesian({
        longitude: (camLon * Math.PI) / 180,
        latitude: (camLat * Math.PI) / 180,
        height: verticalM,
      });
      viewer.camera.cancelFlight();
      viewer.camera.setView({
        destination,
        orientation: {
          heading: ((headingDeg + 180) * Math.PI) / 180,
          pitch: (pitchDeg * Math.PI) / 180,
          roll: 0,
        },
      });
    }, target);
    await new Promise((r) => setTimeout(r, 300));
    const summoned = await page
      .waitForFunction(
        () =>
          window.__godsEyeView.dataManager.layers
            .get('anomalies')
            ?.module?.getCraftSummonDiagnostics?.()?.animating === true,
        { timeout: 8000 },
      )
      .then(() => true)
      .catch(() => false);
    if (!summoned) {
      console.error('the craft never reached animating=true in time');
      exitCode = 1;
    }
    // A settling frame after the poll resolves, so the just-started loop
    // animation is visibly mid-motion rather than caught on its very first
    // pose.
    await new Promise((r) => setTimeout(r, 400));

    // Spectral is registered as the atlas default (PHENOMENA_DESIGN.md),
    // but the HUD's own "ACTIVE STYLE" pill reads the boot default as
    // "Normal" rather than "Spectral" - a pre-existing characteristic of
    // the visual-effects system, unrelated to and out of scope for this
    // task. Setting it explicitly here means this screenshot genuinely
    // shows Spectral regardless of that boot-default label.
    await page.evaluate(() =>
      window.__godsEyeView.styleManager.setStyle('spectral'),
    );
    await new Promise((r) => setTimeout(r, 700));
    const spectralShotPath = new URL('summon-spectral-1440.png', SHOT_DIR)
      .pathname;
    await page.screenshot({ path: spectralShotPath });
    console.log(`saved ${spectralShotPath}`);

    await page.evaluate(() =>
      window.__godsEyeView.styleManager.setStyle('void'),
    );
    // TRANSITION_DURATION_MS (src/ui/visualPresets.js) is 500ms; wait past
    // the crossfade before capturing.
    await new Promise((r) => setTimeout(r, 700));
    const voidShotPath = new URL('summon-void-1440.png', SHOT_DIR).pathname;
    await page.screenshot({ path: voidShotPath });
    console.log(`saved ${voidShotPath}`);

    const diagnostics = await page.evaluate(() => ({
      craft: window.__godsEyeView.dataManager.layers
        .get('anomalies')
        ?.module?.getCraftSummonDiagnostics?.(),
      holds: window.__godsEyeView.getRenderGovernorDiagnostics?.()?.holds ?? [],
    }));
    console.log('craft summon diagnostics:', JSON.stringify(diagnostics));
    if (
      diagnostics.craft?.active !== true ||
      !diagnostics.holds.includes('craft-summon')
    ) {
      console.error(
        '[FAIL] expected an active, holding summon at capture time',
      );
      exitCode = 1;
    } else {
      console.log(
        '[PASS] a summoned craft was active and holding at capture time',
      );
    }
  }
} finally {
  await browser.close();
}
process.exit(exitCode);
