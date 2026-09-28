import * as Cesium from 'cesium';
import { isExplicitLayerStateOrigin } from '../data/layerState.js';
import {
  registerCctvFocusRequestListener,
  routeCctvFocusRequest,
} from '../cctvFocusRequest.js';
import {
  flyToWorldTarget,
  registerWorldFocusRequestListener,
  routeWorldFocusRequest,
} from '../worldFocus.js';
import { registerNavigationAuthorityListener } from '../navigationPolicy.js';
import { createPhenomenaMode } from '../app/phenomenaMode.js';
import { searchCases } from '../app/caseSearch.js';
import { createSpotter } from '../app/spotter.js';
import { rankCandidates } from '../spotter/rank.js';
import { createObservatory } from '../app/observatory.js';
import { createAnomalySource } from '../layers/anomalies/source.js';
import { createAncientSource } from '../layers/ancientSites/source.js';
/** Own manager subscriptions and the camera-entry events that outlive controls. */
export class LayerBindings {
  constructor({
    viewer,
    services,
    readControls,
    operations,
    feedback,
    shareRestoration,
  }) {
    Object.assign(
      this,
      {
        viewer,
        services,
        readControls,
        _feedback: feedback,
        _shareRestoration: shareRestoration,
      },
      operations,
    );
    this._disposed = false;
    this._dataManager = null;
    this._directionsShellModule = null;
    this._weatherShellModules = [];
    this._anomaliesShellModule = null;
    this._anomaliesMode = null;
    this._anomaliesSetPhenomenaActive = null;
    this._anomaliesSetSpotterOpen = null;
    this._anomaliesSetObservatoryOpen = null;
    this._ancientShellModule = null;
    this._ancientNotifySkyChanged = null;
    this._liveClaimsShellModule = null;
    this._spotter = null;
    this._observatory = null;
    this._observatorySkyStats = null;
    this._observatoryAncientStats = null;
    this._cctvRequestFocusHandler = null;
    this._removeCctvRequestFocusListener = null;
    this._worldRequestFocusHandler = null;
    this._removeWorldRequestFocusListener = null;
    this._removeNavigationAuthorityListener = null;
    this._navigationOwnerChangedRemover = null;
    this._awarenessSelectedHandler = null;
    this._awarenessClearedHandler = null;
    this._anomalySearchSource = null;
    this._ancientSearchSource = null;
    this._skySearchRecords = null;
    this._ancientSearchRecords = null;
  }
  get hud() {
    return this.readControls().hud;
  }
  get _contextControls() {
    return this.readControls()._contextControls;
  }
  get _cctvControls() {
    return this.readControls()._cctvControls;
  }
  get _radioControls() {
    return this.readControls()._radioControls;
  }
  observeCamera() {
    this._cctvRequestFocusHandler = (event) =>
      routeCctvFocusRequest(
        event,
        (activate, focus) => this._runExplicitCctvFocus(activate, focus),
        (cameraId, durationSec) =>
          this.services.cctvLayer.focusCamera(cameraId, durationSec),
      );
    this._removeCctvRequestFocusListener = registerCctvFocusRequestListener(
      window,
      this._cctvRequestFocusHandler,
    );
    this._worldRequestFocusHandler = (event) =>
      routeWorldFocusRequest(
        event,
        (detail, fly) => this._runExplicitWorldFocus(detail, fly),
        (detail) => flyToWorldTarget(this.viewer, detail),
      );
    this._removeWorldRequestFocusListener = registerWorldFocusRequestListener(
      window,
      this._worldRequestFocusHandler,
    );
    this._navigationOwnerChangedRemover =
      this.viewer.trackedEntityChanged.addEventListener((entity) => {
        if (entity && !this._disposed)
          this._stampNavigation({ cancelPendingSelection: false });
      });
    // Vessel/installation focus flies without ever assigning a tracked entity,
    // so it cannot reach the listener above. It announces instead.
    this._removeNavigationAuthorityListener =
      registerNavigationAuthorityListener(window, (event) => {
        if (this._disposed) return;
        this._stampNavigation({
          cancelPendingSelection:
            event?.detail?.cancelPendingSelection !== false,
        });
      });
  }
  _connectDirectionsCamera() {
    if (!this._dataManager) {
      // Detaching: the layer outlives this shell, so it must not keep calling
      // a facade whose viewer is going away.
      this._directionsShellModule?.attachShellServices?.(null);
      this._directionsShellModule = null;
      return;
    }
    const directions = this._dataManager.layers?.get('directions')?.module;
    if (this._directionsShellModule !== directions) {
      this._directionsShellModule?.attachShellServices?.(null);
      this._directionsShellModule = null;
    }
    if (typeof directions?.attachShellServices !== 'function') return;
    this._directionsShellModule = directions;
    directions.attachShellServices({
      runNavigation: (navigate) =>
        this.runImmediateNavigation('route', navigate),
      floorFn: (lat, lon) => this.services.cachedGroundFloor(lat, lon),
      warmFn: (cells) => this.services.warmGroundFloor(cells),
      showToast: (message) => this._showToast(message),
    });
  }

  _connectWeatherCamera() {
    for (const layer of this._weatherShellModules)
      layer.attachShellServices?.(null);
    this._weatherShellModules = [];
    for (const id of [
      'wind',
      'weather-radar',
      'weather-satellite',
      'weather-lightning',
      'weather-cyclones',
    ]) {
      const layer = this._dataManager?.layers?.get(id)?.module;
      if (typeof layer?.attachShellServices !== 'function') continue;
      layer.attachShellServices({
        runNavigation: (navigate) =>
          this.runImmediateNavigation('weather', navigate),
        imageryHost: this.services.imageryHost,
      });
      this._weatherShellModules.push(layer);
    }
  }

  /**
   * Give the anomalies layer a Phenomena mode toggle. The mode itself is
   * built here, against the data manager; the layer only wires a button to
   * the callback so it never reaches across a package boundary for it.
   *
   * A live mode is exited before it is ever discarded (teardown, a changed
   * anomalies module, or a fresh mode for a reconnected manager), so a
   * manager swap while Phenomena mode is active restores the layers it had
   * hidden instead of stranding them off. That is a forced exit: the layer
   * never asked for it, so its `attachShellServices` return value (recorded
   * the last time it was attached) is used to tell the layer to reset its
   * own button, since the mode restoring layers and style says nothing
   * about the button's aria-pressed state by itself.
   *
   * The same channel also carries the Spotter panel's toggle
   * (`_toggleSpotter`) and close (`_closeSpotter`), and the Observatory
   * plate's own toggle (`_toggleObservatory`) and close
   * (`_closeObservatory`) alongside it, same idiom. Both panels are built
   * lazily, on the first press, and then live for as long as this instance
   * does (`stop()` destroys them); the callbacks are re-attached on every
   * connect, same as the mode and search callbacks above. Unlike Phenomena
   * mode, closing has no "restore" step to force, so this function just
   * closes both plates unconditionally on every connect (below) rather
   * than tracking an active/inactive pair: a plate that was never opened
   * has nothing to close, and one left open across a rewire is exactly the
   * orphaned-plate bug this fixes.
   */
  _connectAnomaliesShell() {
    if (this._anomaliesMode?.active) {
      this._anomaliesMode.exit();
      this._anomaliesSetPhenomenaActive?.(false);
    } else {
      this._anomaliesMode?.exit?.();
    }
    this._anomaliesMode = null;
    this._anomaliesSetPhenomenaActive = null;
    // The Spotter and Observatory plates are siblings of the viewer
    // container, not children of the anomalies module's own DOM, so a
    // rewire (teardown or a fresh manager) must close both here too,
    // otherwise a live-data plate could be left on screen with the very
    // channel that can reach it about to be torn down and rebuilt.
    // `_closeSpotter`/`_closeObservatory` also reset their button's
    // `aria-pressed` (via `_anomaliesSetSpotterOpen`/
    // `_anomaliesSetObservatoryOpen`, still the outgoing module's callback
    // at this point), so each button and its plate stay in lockstep; the
    // fields are then nulled below so a stale callback is never used
    // before the new module attaches its own.
    this._closeSpotter();
    this._anomaliesSetSpotterOpen = null;
    this._closeObservatory();
    this._anomaliesSetObservatoryOpen = null;
    if (!this._dataManager) {
      this._anomaliesShellModule?.attachShellServices?.(null);
      this._anomaliesShellModule = null;
      return;
    }
    const anomalies = this._dataManager.layers?.get('anomalies')?.module;
    if (this._anomaliesShellModule !== anomalies) {
      this._anomaliesShellModule?.attachShellServices?.(null);
      this._anomaliesShellModule = null;
    }
    if (typeof anomalies?.attachShellServices !== 'function') return;
    this._anomaliesShellModule = anomalies;
    const manager = this._dataManager;
    const mode = createPhenomenaMode({
      layerIds: [...manager.layers.keys()],
      isEnabled: (id) => manager.isEnabled(id),
      setEnabled: (id, on) => manager.setEnabled(id, on, { origin: 'user' }),
      keep: ['anomalies', 'ancient-sites'],
      getStyle: this.services.getStyle,
      setStyle: this.services.setStyle,
    });
    this._anomaliesMode = mode;
    // Cyclones' and the weather layers' attachShellServices calls also
    // ignore their return value, so returning one here is safe everywhere
    // else it is called.
    const attached = anomalies.attachShellServices({
      togglePhenomenaMode: () => {
        mode.active ? mode.exit() : mode.enter();
        return mode.active;
      },
      searchCases: async (query) =>
        searchCases(query, await this._buildCaseSearchRecords()),
      focusResult: (result) => this._focusCaseSearchResult(result),
      // Built lazily, on the first press, so wiring this channel never
      // requires a document (a headless unit-test shell attaches a data
      // manager with no browser globals at all).
      toggleSpotter: () => this._toggleSpotter(),
      // The reverse direction: the layer calls this from its own
      // disable()/destroy() so a layer-panel toggle-off (or the layer
      // tearing down) closes the plate the shell owns, instead of leaving
      // it orphaned with a dead Spotter button behind it.
      closeSpotter: () => this._closeSpotter(),
      // The Observatory plate: same lazy-build-on-first-press and
      // shell-closes-it-back idiom as the Spotter pair above.
      toggleObservatory: () => this._toggleObservatory(),
      closeObservatory: () => this._closeObservatory(),
      // Same channel the weather layers use (_connectWeatherCamera above)
      // so the Hotspots heat overlay drapes on whatever surface the active
      // map stack can host imagery on, globe or 3D tileset, instead of
      // reaching for viewer.imageryLayers directly.
      imageryHost: this.services.imageryHost,
    });
    this._anomaliesSetPhenomenaActive =
      typeof attached?.setPhenomenaActive === 'function'
        ? attached.setPhenomenaActive
        : null;
    this._anomaliesSetSpotterOpen =
      typeof attached?.setSpotterOpen === 'function'
        ? attached.setSpotterOpen
        : null;
    this._anomaliesSetObservatoryOpen =
      typeof attached?.setObservatoryOpen === 'function'
        ? attached.setObservatoryOpen
        : null;
  }

  /**
   * Give the ancient-sites layer the live "is the sky register active"
   * signal its deep-time dial needs (see the layer's own
   * `attachShellServices`): `isSkyActive` is a pull query backed directly
   * by the data manager's `isEnabled('anomalies')`, and the returned
   * `notifySkyChanged` is the push side this class calls from the
   * `dataManager.subscribe` callback below whenever either layer's enabled
   * state settles, so the dial reacts immediately rather than only at the
   * ancient layer's own next enable(). Mirrors `_connectAnomaliesShell`'s
   * own teardown-on-rewire dance (a changed or torn-down manager detaches
   * the outgoing module first).
   *
   * The outgoing module is detached with `isSkyActive: () => true`, never
   * with `null`: the layer's own `attachShellServices(null)` falls back to
   * `() => false` (see its doc comment), which would read as "the sky
   * register is off" and briefly mount the deep-time dial even when it is
   * genuinely on, for the instant between this detach and whatever
   * reconnects next. Assuming the sky IS active on a detach we cannot
   * verify keeps the dial down, the conservative failure mode, rather than
   * mounting it on a guess.
   */
  _connectAncientSitesShell() {
    if (!this._dataManager) {
      this._ancientShellModule?.attachShellServices?.({
        isSkyActive: () => true,
      });
      this._ancientShellModule = null;
      this._ancientNotifySkyChanged = null;
      return;
    }
    const ancient = this._dataManager.layers?.get('ancient-sites')?.module;
    if (this._ancientShellModule !== ancient) {
      this._ancientShellModule?.attachShellServices?.({
        isSkyActive: () => true,
      });
      this._ancientShellModule = null;
      this._ancientNotifySkyChanged = null;
    }
    if (typeof ancient?.attachShellServices !== 'function') return;
    this._ancientShellModule = ancient;
    const manager = this._dataManager;
    const attached = ancient.attachShellServices({
      isSkyActive: () => manager.isEnabled('anomalies'),
    });
    this._ancientNotifySkyChanged =
      typeof attached?.notifySkyChanged === 'function'
        ? attached.notifySkyChanged
        : null;
  }

  /**
   * Give the live-claims register a way to open the sky register's own
   * dossier for a nearby historical case, through the same idiom
   * `_connectAnomaliesShell` already uses for case search: a shell-owned
   * lookup by layer id, never a direct module reference held by
   * `src/layers/liveClaims/index.js` itself. `focusAnomalyCase` re-checks
   * `isEnabled('anomalies')` itself (never trusting a caller's own stale
   * read) and is a no-op returning `false` when the sky register is off,
   * since enabling it on the visitor's behalf is out of scope for that
   * nearby-case row; the layer's own `isAnomaliesEnabled` lets it decide
   * whether to offer that click at all. Mirrors the teardown-on-rewire
   * dance in `_connectAnomaliesShell`/`_connectAncientSitesShell`: the
   * outgoing module is detached (with `null`, safe here since neither
   * callback needs a live fallback) before a changed or torn-down manager
   * is wired to a fresh one.
   */
  _connectLiveClaimsShell() {
    if (!this._dataManager) {
      this._liveClaimsShellModule?.attachShellServices?.(null);
      this._liveClaimsShellModule = null;
      return;
    }
    const liveClaims = this._dataManager.layers?.get('live-claims')?.module;
    if (this._liveClaimsShellModule !== liveClaims) {
      this._liveClaimsShellModule?.attachShellServices?.(null);
      this._liveClaimsShellModule = null;
    }
    if (typeof liveClaims?.attachShellServices !== 'function') return;
    this._liveClaimsShellModule = liveClaims;
    const manager = this._dataManager;
    liveClaims.attachShellServices({
      isAnomaliesEnabled: () => manager.isEnabled('anomalies'),
      focusAnomalyCase: async (id) => {
        if (!manager.isEnabled('anomalies')) return false;
        const mod = manager.layers?.get('anomalies')?.module;
        if (typeof mod?.focusCase !== 'function') return false;
        await mod.focusCase(id);
        return true;
      },
    });
  }

  /**
   * Show or hide the Spotter panel, building it on first use. Returns the
   * panel's new open state.
   * @returns {boolean}
   */
  _toggleSpotter() {
    this._spotter ||= createSpotter({
      getObservation: () => this._spotterObservation(),
      getCandidates: () => this._spotterCandidates(),
      rank: rankCandidates,
      container: this.viewer.container,
    });
    return this._spotter.toggle();
  }

  /**
   * Close the Spotter panel if one has been built, and reset the Spotter
   * button's `aria-pressed` through the currently attached module's
   * `setSpotterOpen`, if any, so the button and the plate stay in
   * lockstep. Never builds a panel just to close it: a panel that was
   * never opened has nothing to close, so this is always safe to call
   * unconditionally (layer disable/destroy, a shell rewire) without first
   * checking whether the panel exists or is open.
   */
  _closeSpotter() {
    this._spotter?.close?.();
    this._anomaliesSetSpotterOpen?.(false);
  }

  /**
   * Show or hide the Observatory plate, building it on first use. Same
   * lazy-build idiom as `_toggleSpotter`: the plate is a shell-owned
   * sibling of the viewer container, layer-independent (it reads shipped
   * datasets and live getStats() straight through the functions below,
   * never through the anomalies layer's own enabled/loaded state), so it
   * keeps answering "what does the atlas hold" even while every register's
   * own layer sits off. Returns the plate's new open state.
   * @returns {boolean}
   */
  _toggleObservatory() {
    this._observatory ||= createObservatory({
      fetchSkyStats: () => this._fetchObservatorySkyStats(),
      fetchSkyYears: () => this._fetchObservatorySkyYears(),
      fetchAncientStats: () => this._fetchObservatoryAncientStats(),
      getLiveClaimsStats: () => this._observatoryLiveClaimsStats(),
      container: this.viewer.container,
    });
    return this._observatory.toggle();
  }

  /**
   * Close the Observatory plate if one has been built, and reset its
   * button's `aria-pressed` through the currently attached module's
   * `setObservatoryOpen`, if any. Mirrors `_closeSpotter`: idempotent and
   * always safe to call unconditionally, so a shell rewire or teardown
   * never has to check whether the plate exists or is open first (the
   * Spotter orphan lesson this plate must not repeat).
   */
  _closeObservatory() {
    this._observatory?.close?.();
    this._anomaliesSetObservatoryOpen?.(false);
  }

  /**
   * Sky reports summary for the Observatory plate: `public/anomalies/
   * stats.json`, the pre-aggregated dataset totals (count, year range, the
   * status and source splits) rather than the anomalies layer's own live
   * `getStats()`, which reports 0 while that layer has never been enabled
   * and loaded. Fetched once and cached; a failed fetch is not cached, so
   * a later open tries again (mirrors `_getSkySearchRecords`'s own
   * cache-the-result idiom above).
   * @returns {Promise<Object|null>}
   */
  async _fetchObservatorySkyStats() {
    if (this._observatorySkyStats) return this._observatorySkyStats;
    try {
      const res = await fetch(this._caseSearchBaseUrl('anomalies/stats.json'));
      if (!res.ok) throw new Error(`Sky stats fetch failed: ${res.status}`);
      const json = await res.json();
      this._observatorySkyStats = {
        count: json.count,
        range: json.range,
        bySource: json.bySource || {},
        byStatus: json.byStatus || {},
      };
    } catch (error) {
      console.warn('[UI:Observatory] Sky stats unavailable', error);
      return null;
    }
    return this._observatorySkyStats;
  }

  /**
   * Per-record years for the Observatory's decade histogram, read from the
   * same cached cross-register search records `_getSkySearchRecords`
   * already fetches (each row carries its own `.year`), rather than a
   * second fetch of the same anomalies.v1.json dataset.
   * @returns {Promise<Array<number>>}
   */
  async _fetchObservatorySkyYears() {
    const records = await this._getSkySearchRecords();
    return records.map((r) => r.year).filter((y) => Number.isFinite(y));
  }

  /**
   * Ancient sites header stats for the Observatory plate: count, the
   * sweep's own `types[]` and `countries[]`. `normalizeAncientSitesV2`
   * (the ancient source module's own portable decoder, used by
   * `_getAncientSearchRecords` above) drops these header fields on the way
   * to its heroes/sweep shape, so this fetches `sites.v2.json` directly
   * rather than through `createAncientSource`, reading only the small
   * header fields the document carries alongside its ~81k-row sweep.
   * Fetched once and cached, same failed-fetch-not-cached rule as sky
   * stats above.
   * @returns {Promise<Object|null>}
   */
  async _fetchObservatoryAncientStats() {
    if (this._observatoryAncientStats) return this._observatoryAncientStats;
    try {
      const res = await fetch(
        this._caseSearchBaseUrl('ancient-sites/sites.v2.json'),
      );
      if (!res.ok) throw new Error(`Ancient sites fetch failed: ${res.status}`);
      const json = await res.json();
      this._observatoryAncientStats = {
        count: json.count,
        types: Array.isArray(json.types) ? json.types : [],
        countries: Array.isArray(json.countries)
          ? json.countries.filter((c) => typeof c === 'string' && c)
          : [],
      };
    } catch (error) {
      console.warn('[UI:Observatory] Ancient sites stats unavailable', error);
      return null;
    }
    return this._observatoryAncientStats;
  }

  /**
   * Live claims register stats for the Observatory plate, read straight
   * off the layer module's own `getStats()` (see
   * `src/layers/liveClaims/index.js`): `{count, status, unplaced,
   * lastUpdate, error}`. Read fresh on every open rather than cached: this
   * register's window genuinely changes over time, unlike the two shipped
   * datasets above. Returns null with no data manager or no live-claims
   * module attached, so the plate can show an honest "unavailable" line
   * rather than a bare zero presented as fact.
   * @returns {Object|null}
   */
  _observatoryLiveClaimsStats() {
    const module = this._dataManager?.layers?.get('live-claims')?.module;
    return typeof module?.getStats === 'function' ? module.getStats() : null;
  }

  /**
   * The spotter's observation point: the current map centre. Mirrors the
   * traffic layer's own fetch-centre idiom (`src/layers/traffic/viewport.js`
   * `getFetchCenter`): `camera.pickEllipsoid` at the canvas centre, which
   * works even with the globe hidden under Google 3D tiles, falling back to
   * the camera's own nadir (`positionCartographic`) when nothing is hit,
   * for example a camera pitched up at open sky.
   * @returns {{lat: number, lon: number}|null}
   */
  _spotterObservation() {
    const camera = this.viewer?.camera;
    const canvas = this.viewer?.scene?.canvas;
    if (!camera) return null;
    let cartographic = null;
    if (canvas && typeof camera.pickEllipsoid === 'function') {
      const width = canvas.clientWidth || canvas.width;
      const height = canvas.clientHeight || canvas.height;
      if (width > 0 && height > 0) {
        let hit = null;
        try {
          hit = camera.pickEllipsoid(
            new Cesium.Cartesian2(width / 2, height / 2),
            Cesium.Ellipsoid.WGS84,
          );
        } catch {
          hit = null;
        }
        if (hit) cartographic = Cesium.Cartographic.fromCartesian(hit);
      }
    }
    cartographic ||= camera.positionCartographic || null;
    if (!cartographic) return null;
    return {
      lat: Cesium.Math.toDegrees(cartographic.latitude),
      lon: Cesium.Math.toDegrees(cartographic.longitude),
    };
  }

  /**
   * Read-only candidate list for the spotter, built from whichever tracked
   * layers are currently enabled. Each module's analyst-record shape
   * differs (see the task report's field-mapping table), so every source
   * is mapped defensively here and rows without a finite position are
   * skipped. `rocket-launches` and `weather-lightning` expose no
   * analyst-record (or equivalent) accessor on this branch, so the
   * `launch` and `lightning` kinds never surface candidates yet; wiring
   * them in is future work once those layers grow one.
   * @returns {Array<{id: string, kind: string, label: string, lat: number, lon: number, altM?: number}>}
   */
  _spotterCandidates() {
    const manager = this._dataManager;
    if (!manager) return [];
    const candidates = [];
    const push = (kind, id, label, lat, lon, altM) => {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const row = {
        id: String(id ?? `${kind}-${candidates.length}`),
        kind,
        label: String(label || id || kind),
        lat,
        lon,
      };
      if (Number.isFinite(altM)) row.altM = altM;
      candidates.push(row);
    };
    const fromAircraftLayer = (layerId, kind) => {
      if (!manager.isEnabled(layerId)) return;
      const module = manager.layers?.get(layerId)?.module;
      const rows = module?.getAnalystRecords?.() || [];
      for (const row of rows)
        push(
          kind,
          row.icao24 || row.id,
          row.callsign || row.id,
          row.lat,
          row.lon,
          row.altitudeM,
        );
    };
    fromAircraftLayer('flights', 'aircraft');
    fromAircraftLayer('military', 'military');
    if (manager.isEnabled('local-adsb')) {
      const module = manager.layers?.get('local-adsb')?.module;
      // local-adsb has no getAnalystRecords: getAllPositions is its closest
      // equivalent (id/label/callsign plus latitude/longitude/altitudeM;
      // note the longer field names, unlike every other source here).
      const rows = module?.getAllPositions?.() || [];
      for (const row of rows)
        push(
          'aircraft',
          row.id,
          row.label || row.callsign || row.id,
          row.latitude,
          row.longitude,
          row.altitudeM,
        );
    }
    if (manager.isEnabled('satellites')) {
      const module = manager.layers?.get('satellites')?.module;
      const rows = module?.getAnalystRecords?.() || [];
      for (const row of rows)
        push(
          'satellite',
          row.noradId || row.id,
          row.name || row.id,
          row.lat,
          row.lon,
          row.altitudeM,
        );
    }
    return candidates;
  }

  /** Base URL matching the `import.meta.env.BASE_URL` pattern the anomalies
   * and ancient-sites application wrappers use (src/app/layers/anomalies.js,
   * src/app/layers/ancientSites.js), so the search's own source fetches the
   * same bundled dataset from the same place.
   */
  _caseSearchBaseUrl(suffix) {
    return `${import.meta.env?.BASE_URL ?? '/'}${suffix}`;
  }

  /**
   * Sky register records for the cross-register search, read through the
   * anomalies layer's own portable source module directly rather than
   * through its `getAnalystRecords()` (which returns `[]` while the layer
   * is disabled, defeating a search meant to find a case whose layer the
   * user never turned on). Fetched once and cached on this instance; a
   * failed fetch is not cached, so the next query tries again.
   */
  async _getSkySearchRecords() {
    if (this._skySearchRecords) return this._skySearchRecords;
    this._anomalySearchSource ||= createAnomalySource({
      baseUrl: this._caseSearchBaseUrl('anomalies/'),
    });
    try {
      const rows = await this._anomalySearchSource.getSnapshot();
      this._skySearchRecords = rows.map((r) => ({
        id: r.id,
        register: 'sky',
        title: r.title,
        year: r.year,
        craft: r.craft,
      }));
    } catch (error) {
      console.warn('[UI:CaseSearch] Sky dataset unavailable', error);
      return [];
    }
    return this._skySearchRecords;
  }

  /**
   * Ancient-sites register records, same independence and caching as above.
   * Hero tier only: the worldwide sweep (~81k rows) is deliberately left out
   * of this in-memory matcher to avoid bloating it, a searchable sweep
   * needs its own index, ledgered as a phase 5b follow-up.
   */
  async _getAncientSearchRecords() {
    if (this._ancientSearchRecords) return this._ancientSearchRecords;
    this._ancientSearchSource ||= createAncientSource({
      baseUrl: this._caseSearchBaseUrl('ancient-sites/'),
    });
    try {
      const { heroes } = await this._ancientSearchSource.getSnapshot();
      this._ancientSearchRecords = heroes.map((r) => ({
        id: r.id,
        register: 'ancient',
        title: r.name,
        type: r.type,
        period: r.period,
        country: r.country,
      }));
    } catch (error) {
      console.warn('[UI:CaseSearch] Ancient sites dataset unavailable', error);
      return [];
    }
    return this._ancientSearchRecords;
  }

  /**
   * Records for the chronometer's cross-register search: the sky register
   * plus the ancient-sites register, mapped into the shared search shape.
   * Each register is fetched once, independent of whether its own layer is
   * currently enabled, and the mapped result is cached for reuse on every
   * subsequent query; only a prior failed fetch triggers a refetch.
   */
  async _buildCaseSearchRecords() {
    const [sky, ancient] = await Promise.all([
      this._getSkySearchRecords(),
      this._getAncientSearchRecords(),
    ]);
    return [...sky, ...ancient];
  }

  /**
   * Fly to and open the dossier for a case-search result. The target
   * register's layer is enabled first when it is off (awaited, so its
   * first data load has settled) before the layer's own focus call runs.
   */
  async _focusCaseSearchResult(result) {
    const manager = this._dataManager;
    if (!manager || !result) return;
    const targetId =
      result.register === 'ancient' ? 'ancient-sites' : 'anomalies';
    if (!manager.layers?.get(targetId)) return;
    if (!manager.isEnabled(targetId)) {
      await manager.setEnabled(targetId, true, { origin: 'user' });
    }
    const mod = manager.layers.get(targetId)?.module;
    if (targetId === 'ancient-sites') await mod?.focusSite?.(result.id);
    else await mod?.focusCase?.(result.id);
  }

  _persistAwarenessSelection(event, cleared = false) {
    if (!this._dataManager) return;
    const origin = String(event?.detail?.origin || 'programmatic');
    if (!isExplicitLayerStateOrigin(origin)) return;
    const layerId = String(event?.detail?.layerId || '');
    const config = {
      flights: {
        key: 'selectedFlightsTrackingId',
        normalize: (value) =>
          String(value ?? '')
            .trim()
            .toLowerCase() || null,
      },
      military: {
        key: 'selectedMilitaryTrackingId',
        normalize: (value) =>
          String(value ?? '')
            .trim()
            .toLowerCase() || null,
      },
      satellites: {
        key: 'selectedSatTrackingId',
        normalize: (value) => {
          const candidate = Number(value);
          return Number.isFinite(candidate) && candidate > 0
            ? Math.trunc(candidate)
            : null;
        },
      },
    }[layerId];
    if (!config) return;
    const selectedValue = cleared ? null : config.normalize(event?.detail?.id);
    if (cleared || selectedValue === null) {
      this._dataManager.adoptLayerParams?.(
        layerId,
        {
          [config.key]: selectedValue,
        },
        { origin },
      );
      return;
    }
    // A direct selection promotes a Context-owned tracker dependency into
    // durable visibility before its selected ID is normalized. Context exit
    // also keeps this adopted layer instead of tearing down the user's track.
    const visibilityAdopted = this._dataManager.adoptLayerVisibility?.(
      layerId,
      true,
      { origin, adoptedFromSelection: true },
    );
    if (visibilityAdopted === false) return;
    // Clear the prior family before publishing the replacement. Otherwise the
    // coordinator briefly sees two IDs and correctly treats them as an
    // ambiguous incoming state, which would discard the new durable target.
    for (const [otherLayerId, otherKey] of [
      ['flights', 'selectedFlightsTrackingId'],
      ['military', 'selectedMilitaryTrackingId'],
      ['satellites', 'selectedSatTrackingId'],
    ]) {
      if (otherLayerId === layerId) continue;
      this._dataManager.setLayerParams(
        otherLayerId,
        { [otherKey]: null },
        { origin },
      );
    }
    this._dataManager.adoptLayerParams?.(
      layerId,
      {
        [config.key]: selectedValue,
      },
      { origin },
    );
  }

  attachDataManager(dataManager) {
    if (this._disposed) return;
    this._dataManager = dataManager || null;
    this.hud.attachDataManager(this._dataManager);
    this._updateTrafficSyncChip();
    if (this._dataManagerUnsubscribe) {
      this._dataManagerUnsubscribe();
      this._dataManagerUnsubscribe = null;
    }
    this._contextControls.connect(this._dataManager);
    if (typeof this._dataManager?.subscribe === 'function') {
      this._dataManagerUnsubscribe = this._dataManager.subscribe((change) => {
        this._feedback._loadingFeedbackEvent = change;
        this._updateGlobalLoadingFeedback(performance.now());
        // The deep-time dial's activation signal: whenever either
        // register's own enabled state settles, tell the ancient layer to
        // re-check whether the sky register is now active (see
        // _connectAncientSitesShell above and the layer's own
        // attachShellServices doc comment).
        if (
          change?.type === 'visibility' &&
          (change.layerId === 'anomalies' || change.layerId === 'ancient-sites')
        ) {
          this._ancientNotifySkyChanged?.();
        }
      });
    }
    this._updateGlobalLoadingFeedback(performance.now());
    this._syncContextModeButtons();
    this._cctvControls.connect();
    this._radioControls.connect();
    this._connectDirectionsCamera();
    this._connectWeatherCamera();
    this._connectAnomaliesShell();
    this._connectAncientSitesShell();
    this._connectLiveClaimsShell();
    if (!this._awarenessSelectedHandler) {
      this._awarenessSelectedHandler = (event) =>
        this._persistAwarenessSelection(event, false);
      this._awarenessClearedHandler = (event) =>
        this._persistAwarenessSelection(event, true);
      window.addEventListener(
        'gev:awareness-subject-selected',
        this._awarenessSelectedHandler,
      );
      window.addEventListener(
        'gev:awareness-subject-cleared',
        this._awarenessClearedHandler,
      );
    }
    this._shareRestoration.connect(this._dataManager);
  }
  stop() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._awarenessSelectedHandler) {
      window.removeEventListener(
        'gev:awareness-subject-selected',
        this._awarenessSelectedHandler,
      );
      this._awarenessSelectedHandler = null;
    }
    if (this._awarenessClearedHandler) {
      window.removeEventListener(
        'gev:awareness-subject-cleared',
        this._awarenessClearedHandler,
      );
      this._awarenessClearedHandler = null;
    }

    this._removeCctvRequestFocusListener?.();
    this._removeCctvRequestFocusListener = null;
    this._cctvRequestFocusHandler = null;
    this._removeWorldRequestFocusListener?.();
    this._removeWorldRequestFocusListener = null;
    this._worldRequestFocusHandler = null;
    this._navigationOwnerChangedRemover?.();
    this._navigationOwnerChangedRemover = null;
    this._removeNavigationAuthorityListener?.();
    this._removeNavigationAuthorityListener = null;
    this._spotter?.destroy?.();
    this._spotter = null;
    this._observatory?.destroy?.();
    this._observatory = null;
  }
  disconnect() {
    this._dataManagerUnsubscribe?.();
    this._dataManagerUnsubscribe = null;
    this._directionsShellModule?.attachShellServices?.(null);
    this._directionsShellModule = null;
    this._dataManager = null;
    this._connectWeatherCamera();
    this._connectAnomaliesShell();
    this._connectAncientSitesShell();
    this._connectLiveClaimsShell();
  }
}
