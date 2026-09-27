import * as Cesium from 'cesium';
import {
  LIVE_CLAIMS_LAYER_ID,
  HONESTY_LINE,
  KEYLESS_MESSAGE,
  mapAnalystRecord,
} from './model.js';
import { createLiveClaimsRenderer } from './rendering.js';
import { safeSourceUrl } from '../../sources/safeUrl.js';
export * from './model.js';
export { normalizeClaimsSnapshot, normalizeClaimRow } from './records.js';
export { createLiveClaimsSource } from './source.js';

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * Fired on `window` whenever any register's dossier plate opens, so the
 * other registers can close their own (every register's plate shares one
 * on-screen slot). Kept a plain window event rather than a shared module:
 * the anomaly, ancient-sites and live-claims layers are independent,
 * sibling-only-by-the-shell modules. Matching dispatch/listen pairs live in
 * src/layers/anomalies/index.js and src/layers/ancientSites/index.js.
 */
const DOSSIER_OPEN_EVENT = 'gev:dossier-open';

const SOURCE_LABELS = Object.freeze({ reddit: 'Reddit', bluesky: 'Bluesky' });

/** Sentence-case source label for the dossier and status plate. */
function formatSource(source) {
  return SOURCE_LABELS[source] || 'Unknown';
}

/** Sentence-case shape label, or an honest "not stated" placeholder. */
function formatShape(shape) {
  return shape ? shape.replace(/-/g, ' ') : 'Not stated';
}

/** The claim's own stated time when it has one; otherwise when it was
 * fetched, labelled to keep that distinction honest. */
function formatWhen(row) {
  if (row.when) return row.when;
  return `${row.fetchedAt} (fetched; no time was stated in the post)`;
}

/**
 * Live claims register: unverified public claims from Reddit and Bluesky,
 * placed on the globe as pulsing ion points, newest brightest. Implements
 * the standard GEV layer contract. No credibility scoring anywhere: the
 * dossier and this module's own honesty line say so plainly (see
 * docs/superpowers/specs/2026-09-27-live-claims-design.md).
 *
 * @param {{source: object, picking?: object, render?: object, container?: Element}} options
 */
export function createLiveClaimsLayer({
  source,
  picking,
  render,
  container,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Live claims require a snapshot source');
  let viewer = null;
  let renderer = null;
  let dossier = null;
  let statusPlate = null;
  let claims = [];
  let status = 'no-key';
  let unplaced = 0;
  let enabled = false;
  let loaded = false;
  let request = null;
  let lastUpdate = null;
  let lastError = null;
  let clickHandler = null;
  let onOtherDossierOpen = null;

  function openDossier(id) {
    const row = claims.find((r) => r.id === id);
    if (!row || !dossier) return;
    const sourceUrl = safeSourceUrl(row.url);
    dossier.innerHTML = `
      <button type="button" class="uap-close" aria-label="Close claim">Close</button>
      <p class="uap-code">${escapeHtml(formatSource(row.source))}</p>
      <h2>${escapeHtml(row.place)}</h2>
      <dl>
        <dt>Place</dt><dd>${escapeHtml(row.place)}</dd>
        <dt>Shape</dt><dd>${escapeHtml(formatShape(row.shape))}</dd>
        <dt>Time</dt><dd>${escapeHtml(formatWhen(row))}</dd>
        <dt>Source</dt><dd>${escapeHtml(formatSource(row.source))}</dd>
      </dl>
      <p class="uap-honesty">${escapeHtml(HONESTY_LINE)}</p>
      ${
        sourceUrl
          ? `<p class="uap-source"><a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Open post</a></p>`
          : ''
      }`;
    // Every register's dossier shares one on-screen slot: opening this one
    // tells the other registers to close their own, if they have one open.
    window.dispatchEvent(
      new CustomEvent(DOSSIER_OPEN_EVENT, {
        detail: { register: LIVE_CLAIMS_LAYER_ID },
      }),
    );
    dossier.hidden = false;
    dossier.querySelector('.uap-close').focus();
  }

  /** Refresh the always-visible status plate: the honesty line, plus either
   * the keyless message, an honest empty state, or the current count, and
   * the unplaced-claims tally when nonzero. */
  function refreshStatus() {
    if (!statusPlate) return;
    const lines = [];
    if (status === 'no-key') {
      lines.push(KEYLESS_MESSAGE);
    } else if (!claims.length) {
      lines.push('No claims in the last 48 hours.');
    } else {
      lines.push(
        `${claims.length} claim${claims.length === 1 ? '' : 's'} in the last 48 hours.`,
      );
    }
    if (unplaced > 0) {
      lines.push(
        `${unplaced} claim${unplaced === 1 ? '' : 's'} had no placeable location.`,
      );
    }
    statusPlate.innerHTML = `<p>${escapeHtml(HONESTY_LINE)}</p>${lines
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join('')}`;
  }

  const layer = {
    id: LIVE_CLAIMS_LAYER_ID,
    name: 'Live claims',
    icon: '◇',
    source: 'Reddit, Bluesky',
    updateInterval: 120_000,

    init(v) {
      if (viewer) throw new Error('Live claims layer is already initialized');
      viewer = v;
      renderer = createLiveClaimsRenderer(viewer, { render });
      const host = container || viewer.container;
      dossier = document.createElement('aside');
      dossier.className = 'uap-dossier claims';
      dossier.hidden = true;
      dossier.setAttribute('aria-label', 'Claim dossier');
      dossier.addEventListener(
        'click',
        (e) => e.target.closest('.uap-close') && (dossier.hidden = true),
      );
      dossier.addEventListener(
        'keydown',
        (e) => e.key === 'Escape' && (dossier.hidden = true),
      );
      host.appendChild(dossier);
      // Mirror of the dispatch in openDossier: another register's dossier
      // opening closes this one, so plates never stack.
      onOtherDossierOpen = (e) => {
        if (
          e.detail?.register !== LIVE_CLAIMS_LAYER_ID &&
          dossier &&
          !dossier.hidden
        )
          dossier.hidden = true;
      };
      window.addEventListener(DOSSIER_OPEN_EVENT, onOtherDossierOpen);
      statusPlate = document.createElement('div');
      statusPlate.className = 'uap-legend claims';
      statusPlate.hidden = true;
      host.appendChild(statusPlate);
      console.log('[Data:LiveClaims] Initialized');
    },

    enable() {
      enabled = true;
      renderer?.apply({ visible: true });
      if (statusPlate) statusPlate.hidden = false;
      refreshStatus();
      if (!clickHandler) {
        clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        clickHandler.setInputAction((e) => {
          const id = renderer?.pick(e.position);
          if (id) openDossier(id);
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      }
      picking?.registerPickOwner?.(
        LIVE_CLAIMS_LAYER_ID,
        (pickedId) =>
          enabled &&
          typeof pickedId === 'string' &&
          pickedId.startsWith('claim:'),
      );
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      picking?.unregisterPickOwner?.(LIVE_CLAIMS_LAYER_ID);
      if (dossier) dossier.hidden = true;
      if (statusPlate) statusPlate.hidden = true;
      clickHandler?.destroy();
      clickHandler = null;
      renderer?.apply({ visible: false });
    },

    async update() {
      if (!enabled || !renderer) return false;
      request?.abort();
      const current = new AbortController();
      request = current;
      try {
        const next = await source.getSnapshot({ signal: current.signal });
        if (current.signal.aborted || request !== current || !enabled)
          return false;
        claims = next.claims;
        status = next.status;
        unplaced = next.unplaced;
        renderer.setRows(claims);
        refreshStatus();
        loaded = true;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:LiveClaims] Loaded ${claims.length} claims`);
        return true;
      } catch (error) {
        if (current.signal.aborted) return false;
        lastError = error?.message || 'Live claims unavailable';
        console.warn('[Data:LiveClaims] Load error:', error);
        // Unlike the anomalies/ancient-sites bundled datasets, this register
        // genuinely refreshes every updateInterval tick, so every call above
        // still attempts a real fetch rather than short-circuiting on a
        // permanent "already loaded" flag. Only the OUTCOME of a failure
        // takes that lesson: once the register has shown good data at least
        // once, a later transient failure (a routine periodic tick, or the
        // enable transaction's own mandatory first call on a repeat enable)
        // must not roll back an already-working register or fail the
        // enable transaction outright - it keeps showing the last good
        // snapshot and reports success. A failure before anything has ever
        // loaded is a genuine failure and still returns false.
        return loaded;
      } finally {
        if (request === current) request = null;
      }
    },

    destroy() {
      layer.disable();
      if (onOtherDossierOpen)
        window.removeEventListener(DOSSIER_OPEN_EVENT, onOtherDossierOpen);
      onOtherDossierOpen = null;
      dossier?.remove();
      statusPlate?.remove();
      renderer?.destroy();
      renderer = null;
      dossier = null;
      statusPlate = null;
      viewer = null;
      claims = [];
      loaded = false;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!enabled) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      return claims.slice(0, limit).map(mapAnalystRecord);
    },

    getStats() {
      return {
        count: claims.length,
        lastUpdate,
        error: lastError,
        status,
        unplaced,
      };
    },
  };
  return layer;
}
