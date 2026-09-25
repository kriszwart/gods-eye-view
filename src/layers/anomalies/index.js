import * as Cesium from 'cesium';
import {
  ANOMALY_LAYER_ID,
  YEAR_MIN,
  YEAR_MAX,
  inWindow,
  mapAnalystRecord,
  describeYear,
  createAnomalyOverlayEntry,
} from './model.js';
import { yearHistogram } from './records.js';
import { createAnomalyRenderer } from './rendering.js';
import { createChronometer } from './chronometer.js';
import { applyAtlasAtmosphere } from './atmosphere.js';
import { safeSourceUrl } from '../../sources/safeUrl.js';
export * from './model.js';
export { normalizeAnomalySnapshot, yearHistogram } from './records.js';
export { createAnomalySource } from './source.js';

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * An escaped, safeSourceUrl-guarded link for the Sources panel. Returns an
 * empty string (no dangling anchor) when the URL fails the guard.
 */
function creditLink(url, label) {
  const safe = safeSourceUrl(url);
  if (!safe) return '';
  return ` <a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

/** Sentence-case attribution rows for the Sources and credits plate. */
const CREDIT_ROWS = [
  {
    name: 'GEIPAN (CNES)',
    text: "Case data under GEIPAN's open reuse notice, 3,381 cases at August 2026.",
    url: 'https://www.geipan.fr',
    label: 'geipan.fr',
  },
  {
    name: 'Project Blue Book',
    text: 'US National Archives, NAID 597821, public domain. 10,622 digitised file units indexed, extraction pending.',
    url: 'https://catalog.archives.gov/id/597821',
    label: 'catalog.archives.gov',
  },
  {
    name: 'GeoNames',
    text: 'Gazetteer, CC BY 4.0.',
    url: 'https://www.geonames.org',
    label: 'geonames.org',
  },
  {
    name: 'Sample hero cases',
    text: 'Illustrative, verification pending (phase 4).',
  },
  {
    name: 'The Modern Antiquarian',
    text: 'Per-site reference links in the ancient register.',
    url: 'https://www.themodernantiquarian.com',
    label: 'themodernantiquarian.com',
  },
  {
    name: 'Wikimedia Commons and Wikidata',
    text: 'Site photographs and links in the ancient register, each shown with its own per-image credit in the dossier.',
    url: 'https://commons.wikimedia.org',
    label: 'commons.wikimedia.org',
  },
];

/** Project the Earth's disc into window space so the dial can wrap it. */
function earthDisc(viewer) {
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const d = Cesium.Cartesian3.magnitude(scene.camera.positionWC);
  const R = Cesium.Ellipsoid.WGS84.maximumRadius;
  if (!(d > R * 1.02)) return null;
  const toWindow =
    Cesium.SceneTransforms.worldToWindowCoordinates ||
    Cesium.SceneTransforms.wgs84ToWindowCoordinates;
  const c = toWindow(scene, Cesium.Cartesian3.ZERO);
  const fovy = scene.camera.frustum.fovy;
  if (!c || !Number.isFinite(fovy)) return null;
  const r =
    (Math.tan(Math.asin(R / d)) / Math.tan(fovy / 2)) *
    (canvas.clientHeight / 2);
  return {
    cx: c.x,
    cy: c.y,
    r,
    width: canvas.clientWidth,
    height: canvas.clientHeight,
  };
}

/**
 * UAP and UFO sightings with a radial time dial, animated hero craft and a
 * case dossier. Implements the standard GEV layer contract.
 */
export function createAnomaliesLayer({
  source,
  overlayHost,
  picking,
  render,
  assetBase = '/anomalies/',
  container,
  atmosphere = true,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Anomalies require a snapshot source');
  let viewer = null;
  let renderer = null;
  let chrono = null;
  let dossier = null;
  let rows = [];
  let enabled = false;
  let loaded = false;
  let request = null;
  let lastUpdate = null;
  let lastError = null;
  let removeCamera = null;
  let clickHandler = null;
  let lastLayout = '';
  let lastYear = null;
  let restoreAtmosphere = null;
  let legend = null;
  let credits = null;
  let creditsBtn = null;
  let tourToken = 0;
  let tourBtn = null;
  let activeStatuses = null;
  let togglePhenomenaMode = null;
  let phenomenaBtn = null;
  let toggleSpotter = null;
  let shellCloseSpotter = null;
  let spotterBtn = null;
  let shellSearchCases = null;
  let shellFocusResult = null;
  let searchControl = null;

  const visibleCount = () =>
    rows.filter(
      (r) =>
        inWindow(r, chrono?.year, chrono?.mode) &&
        (!activeStatuses || activeStatuses.has(r.status)),
    ).length;
  const refreshTime = () => {
    if (!renderer || !chrono) return;
    renderer.apply({
      visible: enabled,
      year: chrono.year,
      mode: chrono.mode,
      statuses: activeStatuses,
    });
    if (chrono.mode !== 'all' && lastYear != null && chrono.year !== lastYear)
      renderer.pulse(
        rows.filter(
          (r) =>
            r.year === chrono.year &&
            (!activeStatuses || activeStatuses.has(r.status)),
        ),
      );
    lastYear = chrono.year;
    chrono.setReadout(describeYear(chrono.year, visibleCount(), chrono.mode));
  };
  const relayout = () => {
    if (!chrono || !viewer) return;
    const disc = earthDisc(viewer);
    const canvas = viewer.scene.canvas;
    const key = disc
      ? `${disc.cx | 0},${disc.cy | 0},${disc.r | 0}`
      : `band${canvas.clientWidth}x${canvas.clientHeight}`;
    if (key === lastLayout) return;
    lastLayout = key;
    chrono.layout(disc, {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
    });
  };

  async function openDossier(id) {
    const row = rows.find((r) => r.id === id);
    if (!row || !dossier) return;
    let detail = null;
    try {
      detail = (await source.getCases?.())?.get(id) || null;
    } catch (error) {
      console.warn('[Data:Anomalies] Cases unavailable', error);
    }
    const when = detail?.date?.iso || String(row.year);
    const sourceUrl = safeSourceUrl(detail?.source_url);
    const wikipediaUrl = safeSourceUrl(detail?.wikipedia);
    dossier.innerHTML = `
      <button type="button" class="uap-close" aria-label="Close case">Close</button>
      <p class="uap-code">${escapeHtml(row.source)} / ${escapeHtml(row.status)}</p>
      <h2>${escapeHtml(detail?.title || row.title || 'Report')}</h2>
      <img class="uap-glyph" alt="" src="${assetBase}glyphs/${escapeHtml(row.craft)}.svg">
      <dl>
        <dt>When</dt><dd>${escapeHtml(when)}</dd>
        <dt>Where</dt><dd>${escapeHtml(detail?.location?.place || `${row.lat.toFixed(2)}, ${row.lon.toFixed(2)}`)}${row.precisionKm ? ` (within ${row.precisionKm} km)` : ''}</dd>
        <dt>Reported as</dt><dd>${escapeHtml(detail?.shape_raw || row.craft.replace(/-/g, ' '))}</dd>
        <dt>Outcome</dt><dd>${escapeHtml(detail?.explanation || row.status)}</dd>
        <dt>Source</dt><dd>${escapeHtml(detail?.source_note || detail?.attribution || row.source)}</dd>
      </dl>
      ${detail?.summary ? `<p class="uap-summary">${escapeHtml(detail.summary)}</p>` : ''}
      ${
        sourceUrl || wikipediaUrl
          ? `<p class="uap-source">${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Open record</a>` : ''}${wikipediaUrl ? `<a href="${escapeHtml(wikipediaUrl)}" target="_blank" rel="noopener noreferrer">Wikipedia</a>` : ''}</p>`
          : ''
      }`;
    dossier.hidden = false;
    dossier.querySelector('.uap-close').focus();
  }

  /** Open the Sources and credits plate, syncing its toggle button. */
  function openCredits() {
    if (!credits) return;
    credits.hidden = false;
    creditsBtn?.setAttribute('aria-pressed', 'true');
    credits.querySelector('.uap-close')?.focus();
  }
  /** Close the Sources and credits plate, syncing its toggle button. */
  function closeCredits() {
    if (!credits) return;
    credits.hidden = true;
    creditsBtn?.setAttribute('aria-pressed', 'false');
  }
  function toggleCredits() {
    if (!credits) return;
    credits.hidden ? openCredits() : closeCredits();
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  function stopTour() {
    tourToken = 0;
    if (tourBtn) tourBtn.textContent = 'Tour hero cases';
  }
  /**
   * Close the shell-owned Spotter plate and reset this layer's own button.
   * The plate sits outside this layer's DOM (a sibling of the viewer
   * container, owned by the shell), so leaving it open across a disable
   * would strand a live-data panel on screen with no reachable control:
   * the Spotter button that opened it just went invisible along with the
   * rest of the chronometer.
   */
  function closeSpotterPanel() {
    shellCloseSpotter?.();
    spotterBtn?.setAttribute('aria-pressed', 'false');
  }
  /** Fly through hero cases in date order, setting the dial and opening each dossier. */
  async function playTour() {
    const heroes = rows
      .filter((r) => r.hero)
      .sort((a, b) => a.timeMs - b.timeMs);
    if (!heroes.length || !viewer) return;
    const token = (tourToken = Date.now());
    if (tourBtn) tourBtn.textContent = 'Stop tour';
    for (const r of heroes) {
      if (tourToken !== token || !viewer) return;
      chrono.setYear(r.year);
      await new Promise((resolve) =>
        viewer.camera.flyToBoundingSphere(
          new Cesium.BoundingSphere(
            Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 0),
            15000,
          ),
          {
            offset: new Cesium.HeadingPitchRange(
              Cesium.Math.toRadians(20),
              Cesium.Math.toRadians(-26),
              60000,
            ),
            duration: 4.5,
            complete: resolve,
            cancel: resolve,
          },
        ),
      );
      if (tourToken !== token) return;
      await openDossier(r.id);
      await wait(8000);
    }
    stopTour();
  }

  const layer = {
    id: ANOMALY_LAYER_ID,
    name: 'UAP sightings',
    icon: '◌',
    source: 'NARA, GEIPAN, PURSUE',
    updateInterval: 3_600_000,

    init(v) {
      if (viewer) throw new Error('Anomaly layer is already initialized');
      viewer = v;
      renderer = createAnomalyRenderer(viewer, { assetBase, render });
      const host = container || viewer.container;
      chrono = createChronometer({
        container: host,
        from: YEAR_MIN,
        to: YEAR_MAX,
        onChange: refreshTime,
        onModeChange: refreshTime,
      });
      chrono.setVisible(false);
      dossier = document.createElement('aside');
      dossier.className = 'uap-dossier';
      dossier.hidden = true;
      dossier.setAttribute('aria-label', 'Case dossier');
      dossier.addEventListener(
        'click',
        (e) => e.target.closest('.uap-close') && (dossier.hidden = true),
      );
      dossier.addEventListener(
        'keydown',
        (e) => e.key === 'Escape' && (dossier.hidden = true),
      );
      host.appendChild(dossier);
      legend = document.createElement('div');
      legend.className = 'uap-legend';
      legend.hidden = true;
      legend.innerHTML = `
        <p>Brighter means less explained</p>
        <ul>
          <li><i style="--c: var(--uap-dim)"></i>Explained</li>
          <li><i style="--c: var(--uap-violet)"></i>Too little data</li>
          <li><i style="--c: var(--uap-magenta)"></i>Unresolved</li>
          <li><i style="--c: var(--uap-amber)"></i>Contested</li>
          <li><i class="ring"></i>Hero case with craft</li>
        </ul>`;
      host.appendChild(legend);
      credits = document.createElement('div');
      credits.className = 'uap-credits';
      credits.hidden = true;
      credits.setAttribute('role', 'dialog');
      credits.setAttribute('aria-label', 'Sources and credits');
      credits.tabIndex = -1;
      credits.innerHTML = `
        <button type="button" class="uap-close" aria-label="Close sources and credits">Close</button>
        <h2>Sources and credits</h2>
        <dl>
          ${CREDIT_ROWS.map(
            (row) =>
              `<dt>${escapeHtml(row.name)}</dt><dd>${escapeHtml(row.text)}${row.url ? creditLink(row.url, row.label) : ''}</dd>`,
          ).join('')}
        </dl>`;
      credits.addEventListener(
        'click',
        (e) => e.target.closest('.uap-close') && closeCredits(),
      );
      credits.addEventListener(
        'keydown',
        (e) => e.key === 'Escape' && closeCredits(),
      );
      host.appendChild(credits);
      creditsBtn = chrono.addAction('Sources', () => toggleCredits());
      creditsBtn.setAttribute('aria-pressed', 'false');
      tourBtn = chrono.addAction('Tour hero cases', () =>
        tourToken ? stopTour() : playTour(),
      );
      const STATUS_FILTERS = [
        ['explained', 'Explained'],
        ['insufficient', 'Too little data'],
        ['unresolved', 'Unresolved'],
        ['contested', 'Contested'],
      ];
      const enabledStatuses = new Set(STATUS_FILTERS.map(([k]) => k));
      for (const [key, label] of STATUS_FILTERS) {
        const btn = chrono.addAction(label, () => {
          enabledStatuses.has(key)
            ? enabledStatuses.delete(key)
            : enabledStatuses.add(key);
          btn.setAttribute('aria-pressed', String(enabledStatuses.has(key)));
          activeStatuses =
            enabledStatuses.size === STATUS_FILTERS.length
              ? null
              : new Set(enabledStatuses);
          refreshTime();
        });
        btn.setAttribute('aria-pressed', 'true');
      }
      phenomenaBtn = chrono.addAction('Phenomena mode', (btn) => {
        if (typeof togglePhenomenaMode !== 'function') return;
        btn.setAttribute('aria-pressed', String(togglePhenomenaMode()));
      });
      phenomenaBtn.setAttribute('aria-pressed', 'false');
      spotterBtn = chrono.addAction('Spotter', (btn) => {
        if (typeof toggleSpotter !== 'function') return;
        btn.setAttribute('aria-pressed', String(toggleSpotter()));
      });
      spotterBtn.setAttribute('aria-pressed', 'false');
      searchControl = chrono.addSearch({
        onQuery: (query) => shellSearchCases?.(query) || [],
        onPick: (result) => shellFocusResult?.(result),
      });
      overlayHost?.setVisible?.(ANOMALY_LAYER_ID, false);
      console.log('[Data:Anomalies] Initialized');
    },

    /**
     * The shell supplies the Phenomena mode toggle, the cross-register case
     * search and the Spotter panel's toggle and close; the layer only
     * exposes the buttons and the search box. Returns
     * `{ setPhenomenaActive, setSpotterOpen }` so the shell can reset each
     * button's `aria-pressed` when it force-exits a live mode (manager
     * reconnect or teardown) without the layer having asked for it.
     * `closeSpotter` runs the other direction: this layer calls it from
     * `disable()`/`destroy()` so the shell-owned plate never outlives the
     * button that opened it.
     */
    attachShellServices(services) {
      togglePhenomenaMode =
        typeof services?.togglePhenomenaMode === 'function'
          ? services.togglePhenomenaMode
          : null;
      shellSearchCases =
        typeof services?.searchCases === 'function'
          ? services.searchCases
          : null;
      shellFocusResult =
        typeof services?.focusResult === 'function'
          ? services.focusResult
          : null;
      toggleSpotter =
        typeof services?.toggleSpotter === 'function'
          ? services.toggleSpotter
          : null;
      shellCloseSpotter =
        typeof services?.closeSpotter === 'function'
          ? services.closeSpotter
          : null;
      return {
        setPhenomenaActive(on) {
          phenomenaBtn?.setAttribute('aria-pressed', String(Boolean(on)));
        },
        setSpotterOpen(on) {
          spotterBtn?.setAttribute('aria-pressed', String(Boolean(on)));
        },
      };
    },

    enable() {
      enabled = true;
      chrono?.setVisible(true);
      overlayHost?.setVisible?.(ANOMALY_LAYER_ID, true);
      if (legend) legend.hidden = false;
      if (atmosphere && !restoreAtmosphere)
        restoreAtmosphere = applyAtlasAtmosphere(viewer);
      lastLayout = '';
      relayout();
      removeCamera ||= viewer.scene.postRender.addEventListener(relayout);
      if (!clickHandler) {
        clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        clickHandler.setInputAction((e) => {
          const id = renderer?.pick(e.position);
          if (id) openDossier(id);
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      }
      picking?.registerPickOwner?.(
        ANOMALY_LAYER_ID,
        (pickedId) =>
          enabled &&
          typeof pickedId === 'string' &&
          pickedId.startsWith('anomaly:'),
      );
      refreshTime();
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      picking?.unregisterPickOwner?.(ANOMALY_LAYER_ID);
      chrono?.setVisible(false);
      searchControl?.clear();
      stopTour();
      closeSpotterPanel();
      closeCredits();
      if (legend) legend.hidden = true;
      restoreAtmosphere?.();
      restoreAtmosphere = null;
      if (dossier) dossier.hidden = true;
      removeCamera?.();
      removeCamera = null;
      clickHandler?.destroy();
      clickHandler = null;
      renderer?.apply({ visible: false });
      overlayHost?.setVisible?.(ANOMALY_LAYER_ID, false);
    },

    async update() {
      if (!enabled || !renderer) return false;
      // The dataset is static once fetched, so a loaded layer's update() on a
      // repeat enable is an idempotent success, not a failure.
      if (loaded) return true;
      request?.abort();
      const current = new AbortController();
      request = current;
      try {
        const next = await source.getSnapshot({ signal: current.signal });
        if (current.signal.aborted || request !== current || !enabled)
          return false;
        rows = next;
        renderer.setRows(rows);
        chrono.setHistogram(yearHistogram(rows, YEAR_MIN, YEAR_MAX));
        const heroRows = rows.filter((r) => r.hero);
        await renderer.setHeroes(heroRows);
        overlayHost?.setEntries?.(
          ANOMALY_LAYER_ID,
          heroRows.map((r) =>
            createAnomalyOverlayEntry({
              id: r.id,
              position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 650),
              title: r.title,
              year: r.year,
            }),
          ),
          { moving: false },
        );
        loaded = true;
        lastUpdate = Date.now();
        lastError = null;
        refreshTime();
        console.log(`[Data:Anomalies] Loaded ${rows.length} reports`);
        return true;
      } catch (error) {
        if (current.signal.aborted) return false;
        lastError = error?.message || 'Anomaly dataset unavailable';
        console.warn('[Data:Anomalies] Load error:', error);
        return false;
      } finally {
        if (request === current) request = null;
      }
    },

    destroy() {
      layer.disable();
      // disable() above already closes the Spotter plate; called again
      // explicitly so this path stays correct even if a future edit ever
      // stops destroy() from delegating to disable() first.
      closeSpotterPanel();
      searchControl?.clear();
      searchControl = null;
      overlayHost?.clearSource?.(ANOMALY_LAYER_ID);
      renderer?.destroy();
      chrono?.destroy();
      dossier?.remove();
      legend?.remove();
      legend = null;
      credits?.remove();
      credits = null;
      creditsBtn = null;
      renderer = null;
      chrono = null;
      dossier = null;
      viewer = null;
      rows = [];
      loaded = false;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!enabled) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      return rows
        .filter((r) => inWindow(r, chrono?.year, chrono?.mode))
        .slice(0, limit)
        .map(mapAnalystRecord);
    },

    getStats() {
      return { count: rows.length, lastUpdate, error: lastError };
    },

    /** Voice and UI hooks. */
    setYear(y) {
      chrono?.setYear(y);
    },
    setTimeMode(mode) {
      chrono && chrono.mode !== mode && chrono.layout && refreshTime();
    },
    setInfrared(on) {
      renderer?.apply({ infrared: !!on });
    },
    playTour,
    stopTour,
    async focusCase(id) {
      const target = renderer?.heroPosition(id);
      if (target) viewer.camera.flyTo({ destination: target, duration: 2.2 });
      await openDossier(id);
    },
  };
  return layer;
}
