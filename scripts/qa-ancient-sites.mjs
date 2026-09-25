#!/usr/bin/env node
/**
 * Browser proof of the ancient sites layer acceptance: registration, the
 * curated 20-site register, an off/on re-enable with overlay labels
 * surviving, decoupling from the anomalies year dial, dossier open with a
 * debated line, record link, site photograph (host-guarded), photo credit
 * and Wikipedia link, Escape close, and share-link restore via token 4,
 * solo and alongside anomalies. Needs the dev server on :4173 (QA_BASE_URL
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

  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('ancient-sites', true, {
      origin: 'user',
    }),
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('ancient-sites')
        ?.module?.getStats?.().count === 20,
    { timeout: 30000 },
  );
  check('20 curated sites loaded after toggle on', true);

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
    reenable.enabled === true && reenable.count === 20,
    JSON.stringify(reenable),
  );
  check(
    'site overlay labels survive an off/on toggle',
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
    decoupled.before === 20 &&
      decoupled.after === 20 &&
      decoupled.yearBefore !== decoupled.yearAfter,
    JSON.stringify(decoupled),
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
