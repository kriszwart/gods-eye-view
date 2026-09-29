import * as Cesium from 'cesium';
import {
  ANOMALY_LAYER_ID,
  YEAR_MIN,
  YEAR_MAX,
  inWindow,
  mapAnalystRecord,
  describeYear,
  createAnomalyOverlayEntry,
  statusHue,
} from './model.js';
import { yearHistogram } from './records.js';
import { createAnomalyRenderer } from './rendering.js';
import { createChronometer } from './chronometer.js';
import { applyAtlasAtmosphere } from './atmosphere.js';
import { safeSourceUrl } from '../../sources/safeUrl.js';
import { resolveImageryHost } from '../../maps/imageryHost.js';
import { buildCraftPreview } from '../../ui/craftPreview.js';
export * from './model.js';
export { normalizeAnomalySnapshot, yearHistogram } from './records.js';
export { createAnomalySource } from './source.js';

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * Fired on `window` whenever any register's dossier plate opens, so the
 * other registers can close their own (every register's plate shares one
 * on-screen slot). Kept a plain window event rather than a shared module:
 * the anomaly, ancient-sites and live-claims layers are independent,
 * sibling-only-by-the-shell modules. Matching dispatch/listen pairs live in
 * src/layers/ancientSites/index.js and src/layers/liveClaims/index.js.
 */
const DOSSIER_OPEN_EVENT = 'gev:dossier-open';

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
    text: "Wikidata supplies the ancient register's worldwide sweep of sites, CC0, plus site photographs and links, each shown with its own per-image credit in the dossier.",
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
  hoverPick,
  render,
  craftSummon,
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
  // Presence pass: the reported-archetype craft summoned for whichever
  // non-hero dossier is currently open, or null. Cleared through
  // despawnCraft() on every dossier-close path AND re-asserted at the top
  // of every openDossier call (same-register switch without an
  // intervening close). craftSummon.js itself is a global one-at-a-time
  // singleton (module state), so despawning THIS register's own stale
  // handle is always safe even when it was already replaced by a summon
  // from another register - despawn() is idempotent on an already-gone
  // state.
  let craftHandle = null;
  let rows = [];
  let enabled = false;
  let loaded = false;
  let request = null;
  let lastUpdate = null;
  let lastError = null;
  let removeCamera = null;
  let clickHandler = null;
  let onOtherDossierOpen = null;
  let lastLayout = '';
  let lastYear = null;
  let restoreAtmosphere = null;
  let legend = null;
  let credits = null;
  let creditsBtn = null;
  let tourToken = 0;
  let tourBtn = null;
  let activeStatuses = null;
  let heatOn = false;
  let heatBtn = null;
  // Shell-supplied resolver for the active map stack's imagery host (globe
  // or 3D tileset); null until attachShellServices connects it, and the
  // renderer falls back to resolving against the viewer alone until then.
  let getImageryHost = null;
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
  /** The row predicate the dial currently implies, shared by heat's immediate
   * paint (setHeat) and its debounced repaint (refreshHeat) so both agree. */
  const heatFilterFn = () =>
    chrono
      ? (r) =>
          inWindow(r, chrono.year, chrono.mode) &&
          (!activeStatuses || activeStatuses.has(r.status))
      : undefined;
  /** Reflect whether heat can actually render on the active map stack: the
   * button stays pressed to record the user's choice (weather's own
   * disable-with-guidance pattern for a hidden imagery host), but its title
   * carries the reason when the stack has nowhere to drape it. */
  const syncHeatStatus = () => {
    if (heatBtn) heatBtn.title = (heatOn && renderer?.getHeatStatus()) || '';
  };
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
    if (heatOn) {
      renderer.refreshHeat(heatFilterFn());
      syncHeatStatus();
    }
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

  /** Despawn whatever craft this register itself last summoned (task:
   * presence pass), if any. Safe to call unconditionally - a no-op both
   * when nothing was summoned and when craftHandle already points at a
   * state some later summon (this register or another) has since
   * replaced. */
  function despawnCraft() {
    craftHandle?.despawn();
    craftHandle = null;
  }

  async function openDossier(id) {
    const row = rows.find((r) => r.id === id);
    if (!row || !dossier) return;
    // Presence pass: every dossier open first drops whatever craft THIS
    // register last summoned (a same-register switch between two open
    // dossiers never goes through closeDossier), then summons afresh for a
    // non-hero row - a hero already carries its own permanent animated
    // craft, so summoning here would double it. Every row carries a craft
    // archetype (records.js defaults a missing one to 'orb'), so the only
    // gate is row.hero.
    despawnCraft();
    if (!row.hero && craftSummon?.summon) {
      // Fix round, fold 3 (customShader parity): the same shader a hero
      // model would currently wear (spectral, or infrared while the atlas
      // is in infrared style), so a summoned craft never spawns bare and an
      // infrared-only archetype is not invisible under spectral.
      craftHandle = craftSummon.summon({
        viewer,
        shape: row.craft,
        lat: row.lat,
        lon: row.lon,
        render,
        assetBase,
        customShader: renderer?.getCraftShader?.(),
      });
    }
    let detail = null;
    try {
      detail = (await source.getCases?.())?.get(id) || null;
    } catch (error) {
      console.warn('[Data:Anomalies] Cases unavailable', error);
    }
    const when = detail?.date?.iso || String(row.year);
    const sourceUrl = safeSourceUrl(detail?.source_url);
    const wikipediaUrl = safeSourceUrl(detail?.wikipedia);
    const streetViewUrl = safeSourceUrl(
      `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${row.lat.toFixed(4)},${row.lon.toFixed(4)}`,
    );
    // Civilian reports carry a rounded location (data honesty, see
    // DATA_PIPELINE.md); the ancient register's rows have no precisionKm,
    // so its own Street view links keep the exact-coordinates default with
    // no title added.
    const streetViewTitle = row.precisionKm
      ? ` title="${escapeHtml(`Approximate vantage: location rounded to within ${row.precisionKm} km`)}"`
      : '';
    dossier.innerHTML = `
      <button type="button" class="uap-close" aria-label="Close case">Close</button>
      <p class="uap-code">${escapeHtml(row.source)} / ${escapeHtml(row.status)}</p>
      <h2>${escapeHtml(detail?.title || row.title || 'Report')}</h2>
      ${buildCraftPreview({ shape: row.craft, hue: statusHue(row.status) })}
      <dl>
        <dt>When</dt><dd>${escapeHtml(when)}</dd>
        <dt>Where</dt><dd>${escapeHtml(detail?.location?.place || `${row.lat.toFixed(2)}, ${row.lon.toFixed(2)}`)}${row.precisionKm ? ` (within ${row.precisionKm} km)` : ''}</dd>
        <dt>Reported as</dt><dd>${escapeHtml(detail?.shape_raw || row.craft.replace(/-/g, ' '))}</dd>
        <dt>Outcome</dt><dd>${escapeHtml(detail?.explanation || row.status)}</dd>
        <dt>Source</dt><dd>${escapeHtml(detail?.source_note || detail?.attribution || row.source)}</dd>
      </dl>
      ${detail?.summary ? `<p class="uap-summary">${escapeHtml(detail.summary)}</p>` : ''}
      ${
        sourceUrl || wikipediaUrl || streetViewUrl
          ? `<p class="uap-source">${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Open record</a>` : ''}${wikipediaUrl ? `<a href="${escapeHtml(wikipediaUrl)}" target="_blank" rel="noopener noreferrer">Wikipedia</a>` : ''}${streetViewUrl ? `<a href="${escapeHtml(streetViewUrl)}" target="_blank" rel="noopener noreferrer"${streetViewTitle}>Street view</a>` : ''}</p>`
          : ''
      }`;
    // Both registers' dossiers share one on-screen slot: opening this one
    // tells the ancient-sites layer to close its own, if it has one open.
    window.dispatchEvent(
      new CustomEvent(DOSSIER_OPEN_EVENT, {
        detail: { register: ANOMALY_LAYER_ID },
      }),
    );
    dossier.hidden = false;
    // Selection ring (task: presence pass): the id shape setSelected takes
    // mirrors renderer.pick()'s own return value exactly - a plain
    // anomalyId string here.
    renderer?.setSelected(id);
    dossier.querySelector('.uap-close').focus();
  }

  /** Every dossier-close path (Close button, Escape, a different register's
   * dossier opening, layer disable) routes through here, so the selection
   * ring (task: presence pass) is cleared exactly where the dossier itself
   * closes - never a separate, easy-to-miss second call site. */
  function closeDossier() {
    if (dossier) dossier.hidden = true;
    renderer?.setSelected(null);
    despawnCraft();
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
      // Shared hover-pick helper (task: presence pass): idempotent across
      // every register's own init() call, since all three share the same
      // app-wide viewer/canvas - only the first call actually attaches the
      // listener.
      hoverPick?.installHoverPick?.(v);
      renderer = createAnomalyRenderer(viewer, {
        assetBase,
        render,
        // A live closure over getImageryHost, not a snapshot: it keeps
        // resolving through the shell's mapStackController once
        // attachShellServices connects it (usually just after init), and
        // falls back to resolving against the viewer alone until then.
        host: () =>
          typeof getImageryHost === 'function'
            ? getImageryHost()
            : resolveImageryHost({ viewer }),
      });
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
        (e) => e.target.closest('.uap-close') && closeDossier(),
      );
      dossier.addEventListener(
        'keydown',
        (e) => e.key === 'Escape' && closeDossier(),
      );
      host.appendChild(dossier);
      // Mirror of the dispatch in openDossier: the ancient-sites dossier
      // opening closes this one, so the two plates never stack.
      onOtherDossierOpen = (e) => {
        if (
          e.detail?.register !== ANOMALY_LAYER_ID &&
          dossier &&
          !dossier.hidden
        )
          closeDossier();
      };
      window.addEventListener(DOSSIER_OPEN_EVENT, onOtherDossierOpen);
      legend = document.createElement('div');
      legend.className = 'uap-legend';
      legend.hidden = true;
      legend.innerHTML = `
        <p>Brighter means less explained</p>
        <p>Heat shows report density, not credibility</p>
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
      // The readout takes on the one active status's hue only when exactly
      // one filter is left on; two or more (or the all-on default) stay ink.
      const syncReadoutTint = () =>
        chrono.setReadoutTint(
          enabledStatuses.size === 1 ? [...enabledStatuses][0] : null,
        );
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
          syncReadoutTint();
          refreshTime();
        });
        btn.setAttribute('aria-pressed', 'true');
      }
      heatBtn = chrono.addAction('Hotspots', (btn) => {
        heatOn = !heatOn;
        btn.setAttribute('aria-pressed', String(heatOn));
        // Pass the dial's current predicate straight in so the first paint
        // already honours it, instead of a brief unfiltered frame before
        // refreshTime()'s own (debounced) refreshHeat call lands.
        renderer.setHeat(heatOn, heatFilterFn());
        syncHeatStatus();
        refreshTime();
      });
      heatBtn.setAttribute('aria-pressed', 'false');
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
     * search, and the Spotter panel's toggle and close; the layer only
     * exposes the buttons and the search box. Returns `{ setPhenomenaActive,
     * setSpotterOpen }` so the shell can reset each button's `aria-pressed`
     * when it force-exits a live mode (manager reconnect or teardown)
     * without the layer having asked for it. `closeSpotter` runs the other
     * direction: this layer calls it from `disable()`/`destroy()` so the
     * shell-owned Spotter plate never outlives the button that opened it.
     * The Observatory plate is not part of this channel (fix round, task 1,
     * atlas-instruments): its own toggle is a standalone control built
     * directly by LayerBindings, always present regardless of this layer's
     * enabled state, so it never needed a place in this handshake.
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
      getImageryHost =
        typeof services?.imageryHost === 'function'
          ? services.imageryHost
          : null;
      syncHeatStatus();
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
      // Shared hover-pick helper (task: presence pass): resolveHover mirrors
      // renderer.pick()'s own extraction, given the hover helper's own
      // already-picked result rather than picking the scene again.
      hoverPick?.registerHoverClient?.(ANOMALY_LAYER_ID, {
        resolveHover: (picked) => renderer?.resolveHover(picked),
        onHover: (id) => renderer?.setHovered(id),
      });
      refreshTime();
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      picking?.unregisterPickOwner?.(ANOMALY_LAYER_ID);
      hoverPick?.unregisterHoverClient?.(ANOMALY_LAYER_ID);
      chrono?.setVisible(false);
      searchControl?.clear();
      stopTour();
      closeSpotterPanel();
      closeCredits();
      heatOn = false;
      heatBtn?.setAttribute('aria-pressed', 'false');
      renderer?.setHeat(false);
      syncHeatStatus();
      if (legend) legend.hidden = true;
      restoreAtmosphere?.();
      restoreAtmosphere = null;
      closeDossier();
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
      if (onOtherDossierOpen)
        window.removeEventListener(DOSSIER_OPEN_EVENT, onOtherDossierOpen);
      onOtherDossierOpen = null;
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

    /** Render diagnostics for the qa gate (task 2, luminous-pins): camera
     * height, whether the close-range shape-glyph tier is currently active,
     * its billboard count and the composed-glyph cache size. */
    getRenderDiagnostics() {
      return renderer?.getDiagnostics() ?? null;
    },

    /** Summoned-craft diagnostics for the qa gate (task: presence pass):
     * whether a reported-archetype craft is currently up, its shape, and
     * whether it is holding continuous render / actually animating. The
     * underlying state is a module-level singleton in craftSummon.js
     * (shared across every register), so this reads the same answer
     * regardless of which register's own dossier asked for it. */
    getCraftSummonDiagnostics() {
      return (
        craftSummon?.getSummonDiagnostics?.() ?? {
          active: false,
          shape: null,
          holding: false,
          animating: false,
          discardedLoads: 0,
          lastDiscardDestroyed: null,
        }
      );
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
      // Fix round, fold 3 (customShader parity): a summoned craft's shader
      // used to be stuck at whatever it spawned with, so a style switch
      // while a dossier was already open never carried over. Re-applying
      // here keeps it in step with heroes, which `apply()` above already
      // re-shades on every call.
      craftSummon?.setCraftShader?.(renderer?.getCraftShader?.());
    },
    playTour,
    stopTour,
    async focusCase(id) {
      // Hero cases fly via the renderer's own animated position; every
      // other row (task 3, atlas-instruments - a real GEIPAN case the
      // cross-register search found) still has a lat/lon in `rows`, so a
      // search hit for one flies there too rather than only opening its
      // dossier in place.
      const row = rows.find((r) => r.id === id);
      const target =
        renderer?.heroPosition(id) ??
        (row ? Cesium.Cartesian3.fromDegrees(row.lon, row.lat, 4000) : null);
      if (target) viewer.camera.flyTo({ destination: target, duration: 2.2 });
      await openDossier(id);
    },
  };
  return layer;
}
