#!/usr/bin/env node
/**
 * Browser proof of the anomalies layer acceptance: registration, sample data,
 * chronometer ring and band layouts, keyboard year control, dossier open and
 * close, an off/on re-enable with hero overlay labels surviving, and
 * share-link restore via token 3. Needs the dev server on :4173 (QA_BASE_URL
 * overrides).
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
    closeGlyph?.diag?.glyphBillboardCount > 0 &&
      closeGlyph.diag.glyphBillboardCount <
        closeGlyph.diag.maxShapeGlyphBillboards,
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
