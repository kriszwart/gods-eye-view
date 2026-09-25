#!/usr/bin/env node
/**
 * Deterministic browser proof of the Spotter panel (src/app/spotter.js,
 * candidates from src/ui/layerBindings.js's `_spotterCandidates`, ranking
 * from src/spotter/rank.js) over a fixture OpenSky feed. Two isolated
 * contexts:
 *
 *   1. Fixture context — a fetch shim serves one synthetic aircraft at a
 *      known offset from the observation point the Spotter uses (the map
 *      centre). The camera is steered to a known lat/lon first
 *      (cancelFlight + setView, straight-down orientation) so the map
 *      centre equals that lat/lon; truth distance/bearing are computed on
 *      the Node side with the SAME portable maths the app uses
 *      (src/spotter/geometry.js). Asserts the synthetic aircraft's label
 *      appears in the first row, its rendered distance is within 2 km of
 *      the truth distance, and its rendered compass abbreviation matches
 *      the 16-point rose direction for the truth bearing.
 *   2. Empty context — the same shim returns no aircraft and only the
 *      Spotter's host layer (anomalies) is enabled; asserts the exact
 *      honest empty-state text.
 *
 * The OpenSky shim mirrors scripts/track-regression.mjs's proven technique:
 * a persistent `fetch` override installed via `evaluateOnNewDocument`
 * (before any app code runs) that answers `/api/opensky` with
 * `{ time, states: [ <state-vector[]> ] }`, the exact shape
 * `src/sources/live/standalone.js` parses.
 *
 * Needs the dev server on :4173 (QA_BASE_URL overrides).
 */
import puppeteer from 'puppeteer';
import { haversineKm, bearingDeg } from '../src/spotter/geometry.js';

const base = process.env.QA_BASE_URL || 'http://localhost:4173';

/** Map centre the fixture camera is steered to (straight-down, so the
 * Spotter's `pickEllipsoid`-derived observation lands on this point). */
const OBSERVATION = { lat: 34.0, lon: -118.2 };

/** Synthetic aircraft at a known offset from OBSERVATION — north-east,
 * about 32 km out, comfortably inside both the default 150 km search
 * radius and the middle of the NE compass bucket (33.75-56.25 deg), so a
 * few degrees of measurement drift can never flip the expected rose
 * point. All-hex icao24, matching track-regression.mjs's convention. */
const AIRCRAFT = {
  icao: 'a10001',
  callsign: 'SPOT01',
  lat: 34.2,
  lon: -117.95,
  altM: 3000,
  velMps: 90,
  trackDeg: 270,
};

/** 16-point compass abbreviations, copied from the private `COMPASS_ABBR`
 * in src/app/spotter.js (not exported) so this gate computes the exact
 * same expected label for its own truth bearing. */
const COMPASS_ABBR = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];
function compassAbbr(bearingDegrees) {
  return COMPASS_ABBR[Math.round(bearingDegrees / 22.5) % COMPASS_ABBR.length];
}

const TRUTH_DISTANCE_KM = haversineKm(OBSERVATION, AIRCRAFT);
const TRUTH_BEARING_DEG = bearingDeg(OBSERVATION, AIRCRAFT);
const TRUTH_COMPASS = compassAbbr(TRUTH_BEARING_DEG);

const EMPTY_TEXT =
  'No match in tracked sources. Tracked sources do not cover everything.';

/**
 * Install the OpenSky fetch shim before any app code runs. Serves one
 * synthetic aircraft (or none) in the exact upstream state-vector shape
 * `src/sources/live/standalone.js` parses, mirroring
 * scripts/track-regression.mjs's proven technique.
 * @param {import('puppeteer').Page} page
 * @param {Object|null} aircraft - `AIRCRAFT`-shaped fixture, or `null` for
 *   an empty feed.
 */
async function installOpenSkyShim(page, aircraft) {
  await page.evaluateOnNewDocument(
    (synthAircraft, appOrigin) => {
      const realFetch = window.fetch.bind(window);
      const jsonResponse = (obj) =>
        new Response(JSON.stringify(obj), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      window.fetch = (input, init) => {
        const requestUrl =
          typeof input === 'string' || input instanceof URL
            ? String(input)
            : input?.url;
        const url = new URL(requestUrl, window.location.href);
        if (url.origin === appOrigin && url.pathname === '/api/opensky') {
          const states = synthAircraft
            ? [
                [
                  synthAircraft.icao, // 0 icao24
                  synthAircraft.callsign, // 1 callsign
                  'Synthetica', // 2 origin_country
                  Math.floor(Date.now() / 1000), // 3 time_position
                  Math.floor(Date.now() / 1000), // 4 last_contact
                  synthAircraft.lon, // 5 longitude
                  synthAircraft.lat, // 6 latitude
                  synthAircraft.altM, // 7 baro_altitude (m)
                  false, // 8 on_ground
                  synthAircraft.velMps, // 9 velocity (m/s)
                  synthAircraft.trackDeg, // 10 true_track (deg)
                  0,
                  null,
                  null,
                  null,
                  false,
                  0, // padding to match state-vector length
                ],
              ]
            : [];
          return Promise.resolve(
            jsonResponse({ time: Math.floor(Date.now() / 1000), states }),
          );
        }
        return realFetch(input, init);
      };
    },
    aircraft,
    new URL(base).origin,
  );
}

/**
 * Poll the camera's cartographic position until it stops changing for
 * `checks` consecutive polls, or give up at `timeout`. With no share-link
 * state in the URL, app startup fires a fire-and-forget `flyToAustin`
 * flight (src/app/controls.js) that is still animating when
 * `window.__godsEyeView.dataManager` first appears — a `cancelFlight` +
 * `setView` issued into that race gets overwritten by the flight's own
 * next tick. Waiting for the camera to go idle first (and again after our
 * own `setView`, to confirm nothing else pre-empts it) makes the
 * observation point deterministic instead of racing that startup flight.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>} whether the camera settled before `timeout`
 */
async function waitForCameraIdle(
  page,
  { checks = 3, intervalMs = 200, timeout = 10000 } = {},
) {
  const start = Date.now();
  let last = null;
  let stableCount = 0;
  while (Date.now() - start < timeout) {
    const pos = await page.evaluate(() => {
      const c = window.__godsEyeView.viewer.camera.positionCartographic;
      return { lat: c.latitude, lon: c.longitude, height: c.height };
    });
    if (
      last &&
      Math.abs(pos.lat - last.lat) < 1e-9 &&
      Math.abs(pos.lon - last.lon) < 1e-9 &&
      Math.abs(pos.height - last.height) < 1
    ) {
      stableCount += 1;
      if (stableCount >= checks) return true;
    } else {
      stableCount = 0;
    }
    last = pos;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * cancelFlight, then setView straight down over a known lat/lon, so the
 * Spotter's map-centre observation (`_spotterObservation` in
 * src/ui/layerBindings.js: `camera.pickEllipsoid` at the canvas centre)
 * lands on that exact point. Waits out any startup camera flight first,
 * then confirms the new position sticks — see `waitForCameraIdle`.
 * @param {import('puppeteer').Page} page
 * @param {{lat: number, lon: number}} point
 */
async function steerCamera(page, point) {
  await waitForCameraIdle(page);
  await page.evaluate((p) => {
    const viewer = window.__godsEyeView.viewer;
    const camera = viewer.camera;
    camera.cancelFlight?.();
    const Cartesian3 = camera.positionWC.constructor;
    camera.setView({
      destination: Cartesian3.fromDegrees(p.lon, p.lat, 300000),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    viewer.scene.requestRender();
  }, point);
  await waitForCameraIdle(page, { timeout: 3000 });
}

/** Click the chronometer's Spotter button, waiting for it to exist first
 * (it is created synchronously in the anomalies layer's init, but the
 * layer itself is only attached once the panel toggle resolves). */
async function openSpotter(page) {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.uap-chrono-panel button')].some(
        (b) => b.textContent === 'Spotter',
      ),
    { timeout: 15000 },
  );
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.uap-chrono-panel button')].find(
      (b) => b.textContent === 'Spotter',
    );
    btn.click();
  });
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
let failures = 0;
const check = (name, passed, detail = '') => {
  console.log(
    `[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
  if (!passed) failures++;
};

try {
  // ================================================================
  // Context 1: fixture aircraft — the Spotter ranks it, with a distance
  // and compass direction matching the geometry truth.
  // ================================================================
  {
    const isolated = await browser.createBrowserContext();
    const page = await isolated.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await installOpenSkyShim(page, AIRCRAFT);

    await page.goto(`${base}/?welcome=0`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
      timeout: 60000,
    });

    await steerCamera(page, OBSERVATION);

    await page.evaluate(async () => {
      const m = window.__godsEyeView.dataManager;
      await m.setEnabled('military', false, { origin: 'user' }).catch(() => {});
      await m
        .setEnabled('satellites', false, { origin: 'user' })
        .catch(() => {});
      await m
        .setEnabled('local-adsb', false, { origin: 'user' })
        .catch(() => {});
      await m.setEnabled('anomalies', true, { origin: 'user' });
      await m.setEnabled('flights', true, { origin: 'user' });
      // Force one more update so the freshly-shimmed feed is ingested
      // (matches scripts/track-regression.mjs's own hardening).
      await m.layers.get('flights').module.update(window.__godsEyeView.viewer);
    });
    await page.waitForFunction(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('flights')
          ?.module?.getAnalystRecords?.().length > 0,
      { timeout: 30000 },
    );

    await openSpotter(page);
    await page.waitForFunction(
      () => document.querySelectorAll('.uap-spotter-row').length > 0,
      { timeout: 10000 },
    );

    const row = await page.evaluate(() => {
      const first = document.querySelector('.uap-spotter-row');
      return {
        rowCount: document.querySelectorAll('.uap-spotter-row').length,
        label: first?.querySelector('.uap-spotter-label')?.textContent ?? null,
        bearing:
          first?.querySelector('.uap-spotter-bearing')?.textContent ?? null,
        distance:
          first?.querySelector('.uap-spotter-distance')?.textContent ?? null,
      };
    });

    check(
      'the synthetic aircraft label appears in the first row',
      row.label === AIRCRAFT.callsign,
      JSON.stringify(row),
    );

    const parsedDistanceKm = row.distance
      ? Number.parseInt(row.distance, 10)
      : NaN;
    check(
      'the first row distance is within 2 km of the geometry truth',
      Number.isFinite(parsedDistanceKm) &&
        Math.abs(parsedDistanceKm - TRUTH_DISTANCE_KM) <= 2,
      `rendered=${row.distance} truth=${TRUTH_DISTANCE_KM.toFixed(3)} km`,
    );
    check(
      'the first row compass matches the 16-point rose direction for the truth bearing',
      row.bearing === TRUTH_COMPASS,
      `rendered=${row.bearing} truth=${TRUTH_COMPASS} (bearing=${TRUTH_BEARING_DEG.toFixed(3)} deg)`,
    );

    check(
      'no page errors in the fixture-aircraft context',
      pageErrors.length === 0,
      pageErrors.join(' | '),
    );
  }

  // ================================================================
  // Context 2: empty feed, anomalies-only — the honest empty state.
  // ================================================================
  {
    const isolated = await browser.createBrowserContext();
    const page = await isolated.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await installOpenSkyShim(page, null);

    await page.goto(`${base}/?welcome=0`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
      timeout: 60000,
    });

    await steerCamera(page, OBSERVATION);

    await page.evaluate(async () => {
      const m = window.__godsEyeView.dataManager;
      await m.setEnabled('flights', false, { origin: 'user' }).catch(() => {});
      await m.setEnabled('military', false, { origin: 'user' }).catch(() => {});
      await m
        .setEnabled('satellites', false, { origin: 'user' })
        .catch(() => {});
      await m
        .setEnabled('local-adsb', false, { origin: 'user' })
        .catch(() => {});
      await m.setEnabled('anomalies', true, { origin: 'user' });
    });

    await openSpotter(page);
    await page.waitForFunction(
      () => {
        const empty = document.querySelector('.uap-spotter-empty');
        return empty && !empty.hidden;
      },
      { timeout: 10000 },
    );

    const emptyState = await page.evaluate(() => ({
      text: document.querySelector('.uap-spotter-empty')?.textContent ?? null,
      rowCount: document.querySelectorAll('.uap-spotter-row').length,
      listHidden: document.querySelector('.uap-spotter-rows')?.hidden,
    }));
    check(
      'the exact honest empty-state text renders with no tracked sources',
      emptyState.text === EMPTY_TEXT &&
        emptyState.rowCount === 0 &&
        emptyState.listHidden === true,
      JSON.stringify(emptyState),
    );

    check(
      'no page errors in the empty-feed context',
      pageErrors.length === 0,
      pageErrors.join(' | '),
    );
  }
} finally {
  await browser.close();
}
console.log(`RESULT: ${failures} failures`);
process.exit(failures ? 1 : 0);
