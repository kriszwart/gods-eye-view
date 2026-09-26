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
 * Needs the dev server on :4173 (QA_BASE_URL overrides).
 */
import puppeteer from 'puppeteer';
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

  const reenable = await page.evaluate(async () => {
    const m = window.__godsEyeView.dataManager;
    await m.setEnabled('ancient-sites', false, { origin: 'user' });
    await m.setEnabled('ancient-sites', true, { origin: 'user' });
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
    // Overlay labels stay hero-only even though the dataset now carries
    // tens of thousands more sites: the sweep is far too dense for the
    // ambient-label lane, and its cluster badges carry their own
    // Cesium-native count text instead (checked below).
    'site overlay labels survive an off/on toggle, hero tier only',
    reenable.overlayEntries === 20,
    JSON.stringify(reenable),
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
  // the (still world-zoom) camera on the cluster's own coordinates first —
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
    await new Promise((r) => setTimeout(r, 2200));
    const afterClusterClick = await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('ancient-sites')
        ?.module?.getRenderDiagnostics?.(),
    );
    check(
      'clicking a cluster badge flies the camera one band closer and re-clusters at finer resolution',
      afterClusterClick?.cameraHeight < worldZoom.cameraHeight &&
        afterClusterClick?.cellDeg < worldZoom.cellDeg,
      JSON.stringify({ before: worldZoom, after: afterClusterClick }),
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
  const sweepClick = await page.evaluate((site) => {
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
  }, sweepTarget);
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
