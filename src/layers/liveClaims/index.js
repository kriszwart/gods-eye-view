import * as Cesium from 'cesium';
import {
  LIVE_CLAIMS_LAYER_ID,
  HONESTY_LINE,
  KEYLESS_MESSAGE,
  PALETTE,
  mapAnalystRecord,
} from './model.js';
import { createLiveClaimsRenderer } from './rendering.js';
import { findNearbyCases, NEARBY_RADIUS_KM } from './nearby.js';
import { safeSourceUrl } from '../../sources/safeUrl.js';
import { buildCraftPreview } from '../../ui/craftPreview.js';
export * from './model.js';
export { normalizeClaimsSnapshot, normalizeClaimRow } from './records.js';
export { createLiveClaimsSource } from './source.js';
export { findNearbyCases, NEARBY_RADIUS_KM, NEARBY_LIMIT } from './nearby.js';

/** Newest claims kept in the stream ticker, per the design spec. */
const TICKER_LIMIT = 10;

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

/** Coarse "how long ago" label for the stream ticker, from a claim's
 * `fetchedAt`. Recency only, matching the register's brightness rule: never
 * a claim about how many claims exist or how credible one is. */
function formatRelativeAge(fetchedAt) {
  const fetchedMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedMs)) return '';
  const ageMs = Math.max(0, Date.now() - fetchedMs);
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** True when the visitor has asked for reduced motion; the stream ticker's
 * row entrances are skipped in that case (newest claims still appear, they
 * just do not slide in). Guarded for non-browser test environments. */
function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
  );
}

/**
 * Live claims register: unverified public claims from Reddit and Bluesky,
 * placed on the globe as pulsing ion points, newest brightest. Implements
 * the standard GEV layer contract. No credibility scoring anywhere: the
 * dossier and this module's own honesty line say so plainly (see
 * docs/superpowers/specs/2026-09-27-live-claims-design.md).
 *
 * `anomalySource` is an optional read-only dependency (same shape as
 * `src/layers/anomalies/source.js`'s `createAnomalySource()`: an object with
 * an async `getSnapshot()`) used only to fetch the bundled anomalies
 * dataset once, lazily, for the dossier's nearby-cases block. It is never
 * used to write anything back to the anomalies layer, and its absence just
 * means that block stays absent - no error.
 *
 * @param {{source: object, anomalySource?: object, picking?: object,
 *   render?: object, container?: Element}} options
 */
export function createLiveClaimsLayer({
  source,
  anomalySource,
  picking,
  hoverPick,
  render,
  container,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Live claims require a snapshot source');
  let viewer = null;
  let renderer = null;
  let dossier = null;
  let statusPlate = null;
  let statusText = null;
  let streamToggle = null;
  let tickerPlate = null;
  let tickerList = null;
  let tickerEmpty = null;
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
  let anomalyRowsPromise = null;
  let openToken = 0;
  let tickerSeenIds = new Set();
  let shellFocusAnomalyCase = null;
  let shellIsAnomaliesEnabled = null;

  /**
   * Lazily fetch the bundled anomalies dataset exactly once (cached for the
   * lifetime of this layer instance), for the dossier's nearby-cases block.
   * Read-only: `anomalySource.getSnapshot()` is the same call the anomalies
   * layer's own source module makes against its own public JSON, so nothing
   * here ever touches that layer's live state. A failed or missing source
   * resolves to `null` rather than rejecting, so the caller can treat "no
   * data" and "fetch failed" identically: the nearby block is simply absent.
   */
  function loadAnomalyRows() {
    if (!anomalySource) return Promise.resolve(null);
    if (!anomalyRowsPromise) {
      anomalyRowsPromise = anomalySource.getSnapshot().catch((error) => {
        console.warn('[Data:LiveClaims] Nearby cases unavailable:', error);
        return null;
      });
    }
    return anomalyRowsPromise;
  }

  /**
   * Append the "N historical cases within 50 km" block to the currently
   * open dossier, once the anomalies dataset resolves. `token` guards
   * against a stale fetch landing after the dossier has since closed or
   * moved to a different claim.
   */
  async function attachNearbyBlock(row, token) {
    const rows = await loadAnomalyRows();
    if (token !== openToken || !dossier) return;
    const anchor = dossier.querySelector('.uap-honesty');
    if (!anchor) return;
    if (!rows) return; // fetch failed, or no anomalySource was given: absent, no error.
    const { count, top } = findNearbyCases(row, rows, {
      radiusKm: NEARBY_RADIUS_KM,
    });
    const block = document.createElement('div');
    block.className = 'uap-nearby';
    if (count === 0) {
      block.innerHTML = `<p class="uap-nearby-empty">No historical cases within ${NEARBY_RADIUS_KM} km</p>`;
    } else {
      const rowsHtml = top
        .map(
          (c) =>
            `<li class="uap-nearby-row" data-lat="${c.lat}" data-lon="${c.lon}" data-id="${escapeHtml(c.id != null ? String(c.id) : '')}" tabindex="0" role="button">${escapeHtml(String(c.year ?? 'unknown'))}, ${escapeHtml(c.status ?? 'unknown')}, ${Math.round(c.distanceKm)} km</li>`,
        )
        .join('');
      block.innerHTML = `<p class="uap-nearby-count">${count} historical case${count === 1 ? '' : 's'} within ${NEARBY_RADIUS_KM} km</p><ul class="uap-nearby-rows">${rowsHtml}</ul>`;
      block.querySelectorAll('.uap-nearby-row').forEach((el) => {
        // The case's own id, from the bundled anomalies dataset this block
        // fetched read-only (see loadAnomalyRows above); null when the
        // decoded row carried none. `canOpenCase` is read fresh on every
        // click rather than cached, so a layer toggle that happens while
        // this dossier stays open is honoured immediately.
        const caseId = el.dataset.id || null;
        const flyThere = () => {
          const lat = Number(el.dataset.lat);
          const lon = Number(el.dataset.lon);
          if (!viewer || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
          viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(lon, lat, 15000),
            duration: 2.2,
          });
        };
        // Opening the sky register's own dossier for this case goes through
        // the shell channel layerBindings.js already uses for case search
        // (`_focusCaseSearchResult`), never a direct reference to the
        // anomalies layer: this module never imports it. Enabling the
        // anomalies layer on the visitor's behalf is out of scope here, so
        // a disabled register just keeps today's fly-only behaviour, with a
        // tooltip explaining why the row does not open a case.
        const canOpenCase = Boolean(
          caseId && shellFocusAnomalyCase && shellIsAnomaliesEnabled?.(),
        );
        el.title = canOpenCase
          ? 'Open the case dossier'
          : 'Enable sky events to open the case';
        const openCase = () => {
          flyThere();
          if (canOpenCase) shellFocusAnomalyCase(caseId);
        };
        el.addEventListener('click', openCase);
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openCase();
          }
        });
      });
    }
    anchor.before(block);
  }

  function openDossier(id) {
    const row = claims.find((r) => r.id === id);
    if (!row || !dossier) return;
    const token = ++openToken;
    const sourceUrl = safeSourceUrl(row.url);
    dossier.innerHTML = `
      <button type="button" class="uap-close" aria-label="Close claim">Close</button>
      <p class="uap-code">${escapeHtml(formatSource(row.source))}</p>
      <h2>${escapeHtml(row.place)}</h2>
      ${buildCraftPreview({ shape: row.shape, hue: PALETTE.ionDark })}
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
    // The stream ticker sits over the same right-hand edge of the screen as
    // the dossier; a dossier taking focus (from a direct point click or a
    // ticker row) closes the ticker rather than the two plates fighting for
    // the same space.
    closeTicker();
    dossier.hidden = false;
    // Selection ring (task: presence pass): the id shape setSelected takes
    // mirrors renderer.pick()'s own return value exactly - a plain claimId
    // string here.
    renderer?.setSelected(id);
    dossier.querySelector('.uap-close').focus();
    attachNearbyBlock(row, token);
  }

  /** Every dossier-close path (Close button, Escape, a different register's
   * dossier opening, layer disable) routes through here, so the selection
   * ring (task: presence pass) is cleared exactly where the dossier itself
   * closes. */
  function closeDossier() {
    if (dossier) dossier.hidden = true;
    renderer?.setSelected(null);
  }

  /** Refresh the always-visible status plate: the honesty line, plus either
   * the keyless message, an honest empty state, or the current count, and
   * the unplaced-claims tally when nonzero. */
  function refreshStatus() {
    if (!statusText) return;
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
    statusText.innerHTML = `<p>${escapeHtml(HONESTY_LINE)}</p>${lines
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join('')}`;
  }

  /** Fly to a claim's location and reuse the existing dossier-open path. */
  function selectTickerRow(id) {
    const row = claims.find((r) => r.id === id);
    if (!row) return;
    if (viewer) {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(row.lon, row.lat, 20000),
        duration: 2.0,
      });
    }
    openDossier(id);
  }

  /** Render up to `TICKER_LIMIT` claims, newest first. `animateNew` gates
   * the slide-in entrance for rows that were not present at the last
   * render (skipped outright under prefers-reduced-motion): opening the
   * plate never animates, a genuinely new arrival while it is already open
   * does. */
  function renderTicker({ animateNew } = {}) {
    if (!tickerList) return;
    const sorted = [...claims].sort(
      (a, b) => (Date.parse(b.fetchedAt) || 0) - (Date.parse(a.fetchedAt) || 0),
    );
    const top = sorted.slice(0, TICKER_LIMIT);
    const reduceMotion = prefersReducedMotion();
    tickerList.replaceChildren();
    for (const row of top) {
      const isNew = Boolean(animateNew) && !tickerSeenIds.has(row.id);
      const item = document.createElement('li');
      item.className =
        'uap-claims-ticker-row' +
        (isNew && !reduceMotion ? ' uap-ticker-row-enter' : '');
      item.tabIndex = 0;
      item.setAttribute('role', 'button');

      const place = document.createElement('span');
      place.className = 'uap-claims-ticker-place';
      place.textContent = row.place;

      const shape = document.createElement('span');
      shape.className = 'uap-claims-ticker-shape';
      shape.textContent = formatShape(row.shape);

      const age = document.createElement('span');
      age.className = 'uap-claims-ticker-age';
      age.textContent = formatRelativeAge(row.fetchedAt);

      const src = document.createElement('span');
      src.className = 'uap-claims-ticker-source';
      src.textContent = formatSource(row.source);

      item.append(place, shape, age, src);
      const select = () => selectTickerRow(row.id);
      item.addEventListener('click', select);
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select();
        }
      });
      tickerList.appendChild(item);
    }
    tickerSeenIds = new Set(top.map((row) => row.id));
    const hasRows = top.length > 0;
    tickerList.hidden = !hasRows;
    if (tickerEmpty) tickerEmpty.hidden = hasRows;
  }

  /** Open the stream ticker plate, rendering it fresh (never animated: a
   * fresh open is not a new arrival). */
  function openTicker() {
    if (!tickerPlate) return;
    tickerPlate.hidden = false;
    streamToggle?.setAttribute('aria-pressed', 'true');
    renderTicker({ animateNew: false });
    tickerPlate.querySelector('.uap-claims-ticker-close')?.focus();
  }

  /** Close the stream ticker plate. Idempotent: safe whether or not it is
   * currently open. */
  function closeTicker() {
    if (!tickerPlate) return;
    tickerPlate.hidden = true;
    streamToggle?.setAttribute('aria-pressed', 'false');
  }

  function toggleTicker() {
    if (!tickerPlate) return;
    if (tickerPlate.hidden) openTicker();
    else closeTicker();
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
      // Shared hover-pick helper (task: presence pass): idempotent across
      // every register's own init() call - see anomalies/index.js's own
      // matching comment.
      hoverPick?.installHoverPick?.(v);
      renderer = createLiveClaimsRenderer(viewer, { render });
      const host = container || viewer.container;
      dossier = document.createElement('aside');
      dossier.className = 'uap-dossier claims';
      dossier.hidden = true;
      dossier.setAttribute('aria-label', 'Claim dossier');
      dossier.addEventListener(
        'click',
        (e) => e.target.closest('.uap-close') && closeDossier(),
      );
      dossier.addEventListener(
        'keydown',
        (e) => e.key === 'Escape' && closeDossier(),
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
          closeDossier();
      };
      window.addEventListener(DOSSIER_OPEN_EVENT, onOtherDossierOpen);
      statusPlate = document.createElement('div');
      statusPlate.className = 'uap-legend claims';
      statusPlate.hidden = true;
      statusText = document.createElement('div');
      statusText.className = 'uap-legend-text';
      streamToggle = document.createElement('button');
      streamToggle.type = 'button';
      streamToggle.className = 'uap-claims-stream-toggle';
      streamToggle.textContent = 'Stream';
      streamToggle.setAttribute('aria-pressed', 'false');
      streamToggle.setAttribute('aria-label', 'Toggle the live claims stream');
      streamToggle.addEventListener('click', () => toggleTicker());
      // The toggle leads (mirrors the dossier's own close button, the
      // first thing in its markup too) and stays pinned to the plate's
      // left edge at a fixed width, ahead of the honesty text, which
      // wraps around whatever room is left. That keeps the toggle clear
      // of the bottom-centre voice dock at narrow viewports, where the
      // dock sits close to the left edge and a trailing button would
      // land underneath it.
      statusPlate.append(streamToggle, statusText);
      host.appendChild(statusPlate);
      // The stream ticker: the register's own right-edge plate, newest
      // claims first, built once here (like the dossier and status plate
      // above) and torn down only in destroy() - never left orphaned by a
      // disable().
      tickerPlate = document.createElement('aside');
      tickerPlate.className = 'uap-claims-ticker';
      tickerPlate.hidden = true;
      tickerPlate.setAttribute('aria-label', 'Live claims stream');
      const tickerHead = document.createElement('div');
      tickerHead.className = 'uap-claims-ticker-head';
      const tickerTitle = document.createElement('h2');
      tickerTitle.textContent = 'Stream';
      const tickerClose = document.createElement('button');
      tickerClose.type = 'button';
      tickerClose.className = 'uap-claims-ticker-close';
      tickerClose.textContent = 'Close';
      tickerClose.setAttribute('aria-label', 'Close stream');
      tickerClose.addEventListener('click', () => closeTicker());
      tickerHead.append(tickerTitle, tickerClose);
      tickerList = document.createElement('ul');
      tickerList.className = 'uap-claims-ticker-rows';
      tickerEmpty = document.createElement('p');
      tickerEmpty.className = 'uap-claims-ticker-empty';
      tickerEmpty.textContent = 'No claims in the last 48 hours.';
      tickerEmpty.hidden = true;
      tickerPlate.append(tickerHead, tickerList, tickerEmpty);
      tickerPlate.addEventListener(
        'keydown',
        (e) => e.key === 'Escape' && closeTicker(),
      );
      host.appendChild(tickerPlate);
      console.log('[Data:LiveClaims] Initialized');
    },

    /**
     * The shell supplies the sky register's own `focusCase(id)` (and a live
     * "is the sky register on" query) so a nearby-case row in this layer's
     * own dossier can open that case's dossier, without this module ever
     * importing `src/layers/anomalies/index.js` directly (see
     * `attachNearbyBlock`). Mirrors the channel `layerBindings.js` already
     * uses for cross-register case search
     * (`_connectAnomaliesShell`/`_focusCaseSearchResult`): a shell-owned
     * lookup by layer id, never an ad-hoc cross-layer reference. Missing or
     * non-function services fall back to null, so a detach (a manager
     * rewire, or this layer tearing down) just returns the row to
     * fly-only.
     */
    attachShellServices(services) {
      shellFocusAnomalyCase =
        typeof services?.focusAnomalyCase === 'function'
          ? services.focusAnomalyCase
          : null;
      shellIsAnomaliesEnabled =
        typeof services?.isAnomaliesEnabled === 'function'
          ? services.isAnomaliesEnabled
          : null;
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
      // Shared hover-pick helper (task: presence pass): resolveHover mirrors
      // renderer.pick()'s own extraction, given the hover helper's own
      // already-picked result rather than picking the scene again.
      hoverPick?.registerHoverClient?.(LIVE_CLAIMS_LAYER_ID, {
        resolveHover: (picked) => renderer?.resolveHover(picked),
        onHover: (id) => renderer?.setHovered(id),
      });
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      picking?.unregisterPickOwner?.(LIVE_CLAIMS_LAYER_ID);
      hoverPick?.unregisterHoverClient?.(LIVE_CLAIMS_LAYER_ID);
      closeDossier();
      if (statusPlate) statusPlate.hidden = true;
      closeTicker();
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
        // The ticker rides the layer's own 2-minute refresh, never a
        // separate poll. It only re-renders while actually open: a fresh
        // open always renders from the current claims anyway, so there is
        // nothing to keep in sync while closed.
        if (tickerPlate && !tickerPlate.hidden)
          renderTicker({ animateNew: true });
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
      tickerPlate?.remove();
      renderer?.destroy();
      renderer = null;
      dossier = null;
      statusPlate = null;
      statusText = null;
      streamToggle = null;
      tickerPlate = null;
      tickerList = null;
      tickerEmpty = null;
      viewer = null;
      claims = [];
      loaded = false;
      anomalyRowsPromise = null;
      tickerSeenIds = new Set();
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

    /** Read-only diagnostic for qa-claims.mjs's reduced-motion check; see
     * `createLiveClaimsRenderer`'s own `getDiagnostics()` doc comment.
     * Returns a null-ish default before `init()` has built a renderer. */
    getDiagnostics() {
      return (
        renderer?.getDiagnostics?.() ?? {
          reducedMotion: null,
          pointCount: 0,
          firstPixelSize: null,
          firstAlpha: null,
          hoveredId: null,
          selectedId: null,
          selectionRingCount: 0,
        }
      );
    },
  };
  return layer;
}
