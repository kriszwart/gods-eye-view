import * as Cesium from 'cesium';
import {
  ANOMALY_LAYER_ID,
  YEAR_MIN,
  YEAR_MAX,
  inWindow,
  mapAnalystRecord,
  describeYear,
} from './model.js';
import { yearHistogram } from './records.js';
import { createAnomalyRenderer } from './rendering.js';
import { createChronometer } from './chronometer.js';
import { applyAtlasAtmosphere } from './atmosphere.js';
export * from './model.js';
export { normalizeAnomalySnapshot, yearHistogram } from './records.js';
export { createAnomalySource } from './source.js';

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

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
  let tourToken = 0;
  let tourBtn = null;

  const visibleCount = () =>
    rows.filter((r) => inWindow(r, chrono?.year, chrono?.mode)).length;
  const refreshTime = () => {
    if (!renderer || !chrono) return;
    renderer.apply({ visible: enabled, year: chrono.year, mode: chrono.mode });
    if (chrono.mode !== 'all' && lastYear != null && chrono.year !== lastYear)
      renderer.pulse(rows.filter((r) => r.year === chrono.year));
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
        <dt>Source</dt><dd>${escapeHtml(detail?.source_note || detail?.attribution || row.source)}${detail?.source_url ? ` <a href="${escapeHtml(detail.source_url)}" target="_blank" rel="noopener noreferrer">Open record</a>` : ''}</dd>
      </dl>
      ${detail?.summary ? `<p class="uap-summary">${escapeHtml(detail.summary)}</p>` : ''}`;
    dossier.hidden = false;
    dossier.querySelector('.uap-close').focus();
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  function stopTour() {
    tourToken = 0;
    if (tourBtn) tourBtn.textContent = 'Tour hero cases';
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
              Cesium.Math.toRadians(-32),
              120000,
            ),
            duration: 3.2,
            complete: resolve,
            cancel: resolve,
          },
        ),
      );
      if (tourToken !== token) return;
      await openDossier(r.id);
      await wait(4500);
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
      renderer = createAnomalyRenderer(viewer, { assetBase });
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
      tourBtn = chrono.addAction('Tour hero cases', () =>
        tourToken ? stopTour() : playTour(),
      );
      overlayHost?.setVisible?.(ANOMALY_LAYER_ID, false);
      console.log('[Data:Anomalies] Initialized');
    },

    enable() {
      enabled = true;
      chrono?.setVisible(true);
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
      stopTour();
      if (legend) legend.hidden = true;
      restoreAtmosphere?.();
      restoreAtmosphere = null;
      if (dossier) dossier.hidden = true;
      removeCamera?.();
      removeCamera = null;
      clickHandler?.destroy();
      clickHandler = null;
      renderer?.apply({ visible: false });
      overlayHost?.clearSource?.(ANOMALY_LAYER_ID);
    },

    async update() {
      if (!enabled || !renderer || loaded) return false;
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
        await renderer.setHeroes(rows.filter((r) => r.hero));
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
      renderer?.destroy();
      chrono?.destroy();
      dossier?.remove();
      legend?.remove();
      legend = null;
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
