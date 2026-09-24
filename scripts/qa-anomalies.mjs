#!/usr/bin/env node
/**
 * Browser proof of the anomalies layer acceptance: registration, sample data,
 * chronometer ring and band layouts, keyboard year control, dossier open and
 * close, and share-link restore via token 3. Needs the dev server on :4173
 * (QA_BASE_URL overrides).
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
      has: m.layers.has('anomalies'),
      enabled: m.isEnabled('anomalies'),
    };
  });
  check(
    'anomalies layer registered and initially off',
    present.has && !present.enabled,
    JSON.stringify(present),
  );

  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('anomalies', true, {
      origin: 'user',
    }),
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('anomalies')
        ?.module?.getStats?.().count === 24,
    { timeout: 30000 },
  );
  check('24 sample points loaded after toggle on', true);

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
    return {
      enabled: m.isEnabled('anomalies'),
      count: m.layers.get('anomalies')?.module?.getStats?.().count,
    };
  });
  check(
    'layer re-enables cleanly after first load',
    reenable.enabled === true && reenable.count === 24,
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
