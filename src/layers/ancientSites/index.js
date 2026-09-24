import * as Cesium from 'cesium';
import {
  ANCIENT_LAYER_ID,
  mapAnalystRecord,
  createAncientOverlayEntry,
} from './model.js';
import { createAncientRenderer } from './rendering.js';
export * from './model.js';
export { normalizeAncientSites } from './records.js';
export { createAncientSource } from './source.js';

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * Curated ancient and disputed-archaeology sites, shown as a static gold
 * register with a dossier per site. Implements the standard GEV layer
 * contract, without the anomalies layer's chronometer, atmosphere, tour or
 * craft: this is a calm, unmoving companion register with no year-dial
 * coupling.
 */
export function createAncientSitesLayer({
  source,
  overlayHost,
  picking,
  render,
  assetBase = '/ancient-sites/',
  container,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Ancient sites require a snapshot source');
  let viewer = null;
  let renderer = null;
  let dossier = null;
  let rows = [];
  let enabled = false;
  let loaded = false;
  let request = null;
  let lastUpdate = null;
  let lastError = null;
  let clickHandler = null;

  function openDossier(id) {
    const row = rows.find((r) => r.id === id);
    if (!row || !dossier) return;
    dossier.innerHTML = `
      <button type="button" class="uap-close" aria-label="Close site">Close</button>
      <h2>${escapeHtml(row.name)}</h2>
      <img class="uap-glyph" alt="" src="${assetBase}glyphs/${escapeHtml(row.glyph)}.svg">
      <dl>
        <dt>Period</dt><dd>${escapeHtml(row.period)}</dd>
        <dt>Country</dt><dd>${escapeHtml(row.country)}</dd>
        <dt>Type</dt><dd>${escapeHtml(row.type)}</dd>
      </dl>
      ${row.debated ? `<p class="uap-debated">Debated: ${escapeHtml(row.debated)}</p>` : ''}
      <p class="uap-summary">${escapeHtml(row.summary)}</p>
      ${row.source_url ? `<p class="uap-source"><a href="${escapeHtml(row.source_url)}" target="_blank" rel="noopener noreferrer">Open record</a></p>` : ''}
      ${row.attribution ? `<p class="uap-attribution">${escapeHtml(row.attribution)}</p>` : ''}`;
    dossier.hidden = false;
    dossier.querySelector('.uap-close').focus();
  }

  const layer = {
    id: ANCIENT_LAYER_ID,
    name: 'Ancient sites',
    icon: '△',
    source: 'Curated sample',
    updateInterval: -1,

    init(v) {
      if (viewer) throw new Error('Ancient sites layer is already initialized');
      viewer = v;
      renderer = createAncientRenderer(viewer, { render });
      const host = container || viewer.container;
      dossier = document.createElement('aside');
      dossier.className = 'uap-dossier ancient';
      dossier.hidden = true;
      dossier.setAttribute('aria-label', 'Site dossier');
      dossier.addEventListener(
        'click',
        (e) => e.target.closest('.uap-close') && (dossier.hidden = true),
      );
      dossier.addEventListener(
        'keydown',
        (e) => e.key === 'Escape' && (dossier.hidden = true),
      );
      host.appendChild(dossier);
      overlayHost?.setVisible?.(ANCIENT_LAYER_ID, false);
      console.log('[Data:AncientSites] Initialized');
    },

    enable() {
      enabled = true;
      renderer?.apply({ visible: true });
      overlayHost?.setVisible?.(ANCIENT_LAYER_ID, true);
      if (!clickHandler) {
        clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        clickHandler.setInputAction(
          (e) => openDossier(renderer?.pick(e.position)),
          Cesium.ScreenSpaceEventType.LEFT_CLICK,
        );
      }
      picking?.registerPickOwner?.(
        ANCIENT_LAYER_ID,
        (pickedId) =>
          enabled &&
          typeof pickedId === 'string' &&
          pickedId.startsWith('ancient:'),
      );
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      picking?.unregisterPickOwner?.(ANCIENT_LAYER_ID);
      if (dossier) dossier.hidden = true;
      clickHandler?.destroy();
      clickHandler = null;
      renderer?.apply({ visible: false });
      overlayHost?.setVisible?.(ANCIENT_LAYER_ID, false);
    },

    async update() {
      if (!enabled || !renderer) return false;
      // The register is static once fetched, so a loaded layer's update() on
      // a repeat enable is an idempotent success, not a failure.
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
        overlayHost?.setEntries?.(
          ANCIENT_LAYER_ID,
          rows.map((r) =>
            createAncientOverlayEntry({
              id: r.id,
              position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 200),
              name: r.name,
            }),
          ),
          { moving: false },
        );
        loaded = true;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:AncientSites] Loaded ${rows.length} sites`);
        return true;
      } catch (error) {
        if (current.signal.aborted) return false;
        lastError = error?.message || 'Ancient sites dataset unavailable';
        console.warn('[Data:AncientSites] Load error:', error);
        return false;
      } finally {
        if (request === current) request = null;
      }
    },

    destroy() {
      layer.disable();
      overlayHost?.clearSource?.(ANCIENT_LAYER_ID);
      renderer?.destroy();
      dossier?.remove();
      renderer = null;
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
      return rows.slice(0, limit).map(mapAnalystRecord);
    },

    getStats() {
      return { count: rows.length, lastUpdate, error: lastError };
    },

    /** Voice and UI hook: fly to a site and open its dossier. */
    async focusSite(id) {
      const row = rows.find((r) => r.id === id);
      if (!row || !viewer) return;
      await new Promise((resolve) =>
        viewer.camera.flyToBoundingSphere(
          new Cesium.BoundingSphere(
            Cesium.Cartesian3.fromDegrees(row.lon, row.lat, 0),
            500,
          ),
          {
            offset: new Cesium.HeadingPitchRange(
              0,
              Cesium.Math.toRadians(-30),
              6000,
            ),
            duration: 2.5,
            complete: resolve,
            cancel: resolve,
          },
        ),
      );
      openDossier(id);
    },
  };
  return layer;
}
