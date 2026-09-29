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
import {
  buildCaseSearchIndex,
  searchCasesWithIndex,
} from '../app/caseSearch.js';
import { createSpotter } from '../app/spotter.js';
import { rankCandidates } from '../spotter/rank.js';
import { createObservatory } from '../app/observatory.js';
import { createHelpOverlay } from '../app/helpOverlay.js';
import { createWelcome, WELCOME_STORAGE_KEY } from '../app/welcome.js';
import { createAnomalySource } from '../layers/anomalies/source.js';
import { createAncientSource } from '../layers/ancientSites/source.js';

/**
 * Read the welcome plate's durable "seen it" flag, best-effort: a blocked or
 * hostile Storage getter (Safari private mode, some enterprise policies)
 * must read as "not yet seen" and never throw, mirroring
 * src/firstRunExperience.js's own guarded storage helpers. Storage is
 * resolved lazily, inside the try, for the same reason that module resolves
 * it lazily rather than as a default parameter: `globalThis.localStorage`
 * is a getter that can itself throw.
 * @returns {boolean}
 */
function hasSeenWelcome() {
  try {
    return globalThis.localStorage?.getItem?.(WELCOME_STORAGE_KEY) === 'seen';
  } catch {
    return false;
  }
}

/** Write the welcome plate's durable "seen it" flag, best-effort; never
 * throws. A blocked store just means the welcome returns on the visitor's
 * next visit, the same fail-open shape firstRunExperience.js's own
 * writeStored() takes. */
function rememberWelcomeSeen() {
  try {
    globalThis.localStorage?.setItem?.(WELCOME_STORAGE_KEY, 'seen');
  } catch {
    /* best-effort */
  }
}
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
    this._ancientShellModule = null;
    this._ancientNotifySkyChanged = null;
    this._liveClaimsShellModule = null;
    this._spotter = null;
    this._observatory = null;
    this._observatorySkyStats = null;
    this._observatoryAncientStats = null;
    this._help = null;
    this._helpKeydownHandler = null;
    this._welcome = null;
    this._welcomeRevealTimer = null;
    this._welcomeTourInFlight = false;
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
    // The in-flight fetch-and-decode promise for the field above (or for
    // `_ancientSnapshot` below), while one is running: a fix-wave finding
    // (fix 2, atlas-instruments) - `_getSkySearchRecords` is awaited both
    // directly and, in the same `Promise.all` round, from inside
    // `_getGeipanSearchRecords`, and likewise `_getAncientSnapshot` from
    // both `_getAncientSearchRecords` and `_getAncientSweepSearchRecords`;
    // with no cache set yet on the first call of a cold search, the second
    // call used to start its own redundant fetch. Caching the pending
    // promise itself (cleared once the fetch settles, success or failure)
    // means every caller in the same round shares the one fetch, while a
    // failed round still leaves nothing cached, so the next call retries.
    this._skySearchRecordsInFlight = null;
    this._ancientSearchRecords = null;
    // Search's cross-register corpus (task 3, atlas-instruments): the
    // GEIPAN and ancient-sweep tiers derive from the same two fetches as
    // the fields above rather than a fetch of their own (see
    // `_getGeipanSearchRecords` and `_getAncientSnapshot`/
    // `_getAncientSweepSearchRecords`), and the built ~85k-record corpus
    // and its prefix-bucket index (src/app/caseSearch.js) are each cached
    // once here, never rebuilt per keystroke.
    this._ancientSnapshot = null;
    this._ancientSnapshotInFlight = null;
    this._ancientSweepSearchRecords = null;
    this._geipanSearchRecords = null;
    this._caseSearchRecords = null;
    this._caseSearchIndex = null;
    // Always present, independent of every layer's own enabled state (see
    // `_createObservatoryToggle`'s doc comment) - built last, once every
    // other field this class's methods can reach for is already in place.
    // Guarded on `document` existing: this class is also constructed by
    // headless unit tests with no DOM at all (see layerBindings.test.mjs's
    // `makeBindings`), and this is the only constructor work that would
    // otherwise require one.
    this._observatoryToggleBtn =
      typeof document !== 'undefined' ? this._createObservatoryToggle() : null;
    // Same always-present, layer-independent idiom as the Observatory
    // toggle just above (see `_createObservatoryToggle`'s doc comment) and
    // built right after it for the same reason: the help overlay explains
    // every register at once, so its own reachability must not depend on
    // any one layer's enabled state either.
    this._helpToggleBtn =
      typeof document !== 'undefined' ? this._createHelpToggle() : null;
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
    this._watchForWelcomeReveal();
    this._bindHelpShortcut();
  }

  /**
   * Bind the document-level "?" shortcut that toggles the help overlay.
   * Guarded on `document.activeElement` being neither an input nor a
   * textarea nor a `contenteditable` element - mirroring
   * src/ui/applicationShortcuts.js's own `isFormControl` guard for its
   * bubbling shortcuts - so the sky register's own case-and-site search
   * field (a plain `<input type="search">`, see
   * src/layers/anomalies/chronometer.js's `addSearch`) keeps typing a
   * literal "?" character rather than ever toggling this overlay instead.
   * Escape is NOT handled here: the overlay's own root listens for it
   * directly (see helpOverlay.js's doc comment), the same self-contained
   * pattern the Observatory and welcome plates already use, so nothing
   * here needs to know whether the overlay happens to be open.
   *
   * Bound once, in `observeCamera()` (itself called once - see
   * src/ui/applicationShell.js), and unbound in `stop()`.
   */
  _bindHelpShortcut() {
    if (typeof document === 'undefined' || this._disposed) return;
    this._helpKeydownHandler = (event) => {
      if (event.key !== '?') return;
      const active = document.activeElement;
      const tag = active?.tagName;
      const isEditable =
        tag === 'INPUT' || tag === 'TEXTAREA' || !!active?.isContentEditable;
      if (isEditable) return;
      event.preventDefault();
      this._toggleHelp();
    };
    document.addEventListener('keydown', this._helpKeydownHandler);
  }

  /**
   * WELCOME PASS ORDERING RULING. Two independent "first thing you see"
   * surfaces both want the visitor's first moment on a fresh browser:
   *
   *   - src/firstRunExperience.js's own launcher (#first-run-launcher) is
   *     the incumbent mission chooser. It is NOT one-shot: unless durably
   *     suppressed, it returns every fresh session. src/app/startupChrome.js
   *     reveals it right after #loading-screen finishes hiding.
   *   - The Phenomena welcome plate (src/app/welcome.js) introduces the
   *     three registers and IS a true one-shot: a single localStorage key,
   *     once per browser, gone for good after the first dismissal.
   *
   * RULING: the two never show together, and the launcher goes first when
   * both would fire this load - it is the more actionable of the two
   * (mission tiles vs. an explainer) and it already owns the "loading
   * screen just hid" trigger. The welcome instead waits for the launcher to
   * be completely OUT OF THE WAY: gone from the DOM, whether because it
   * decided not to show at all (durably suppressed, a share link, or
   * `?welcome=0`) or because the visitor opened and dismissed it. Reading
   * the DOM this way, rather than re-deriving firstRunExperience.js's own
   * `shouldShowFirstRun()` decision here, keeps this class decoupled from
   * that module's internals and correct even if its rules change.
   *
   * A poll (not a MutationObserver) checks this on an interval and clears
   * itself the instant both conditions are satisfied: the launcher's own
   * dismiss path removes itself asynchronously (a `transitionend` or a
   * 400ms fallback timer - see initFirstRunExperience's `dismiss()`), so
   * nothing shorter than that window is worth watching more eagerly, and a
   * poll never risks missing a mutation the way an under-scoped observer
   * could. This never blocks or delays boot itself: `observeCamera()` (the
   * caller) has already returned by the time anything here settles.
   */
  _watchForWelcomeReveal() {
    if (typeof document === 'undefined' || this._disposed) return;
    const loadingScreen = document.getElementById('loading-screen');
    const settled = () => {
      // Still booting: #loading-screen has not even started its hide
      // transition, so first-run has not been given the chance to decide
      // whether it is showing yet either.
      if (loadingScreen && !loadingScreen.classList.contains('hidden'))
        return false;
      const launcher = document.getElementById('first-run-launcher');
      return !launcher || !launcher.isConnected;
    };
    const attempt = () => {
      if (this._disposed) {
        this._clearWelcomeRevealTimer();
        return;
      }
      if (!settled()) return;
      this._clearWelcomeRevealTimer();
      this._revealWelcomeOnce();
    };
    if (settled()) {
      this._revealWelcomeOnce();
      return;
    }
    this._welcomeRevealTimer = setInterval(attempt, 200);
  }

  _clearWelcomeRevealTimer() {
    if (this._welcomeRevealTimer) {
      clearInterval(this._welcomeRevealTimer);
      this._welcomeRevealTimer = null;
    }
  }

  /**
   * Build and open the welcome plate, exactly once: guarded on both "already
   * built" (a second settle of the poll above must never build a second
   * plate) and the durable "seen it" flag. `onOpenChange` is the plate's own
   * single shared close path (see createWelcome's doc comment) - the only
   * place this class remembers the plate has been seen and tears it down,
   * so every dismissal (Escape, Close, Explore freely, or the tour once it
   * has started) does both exactly once, the same way. Destroying here
   * (rather than leaving the plate merely hidden) matches welcome.js's own
   * one-shot framing: once genuinely dismissed there is nothing left to
   * reopen it, so there is nothing worth keeping in the DOM either.
   *
   * The welcome and help plates must never stack (welcome pass ruling): the
   * help overlay's own `_toggleHelp` already refuses to open while the
   * welcome plate is up, covering a "?" press arriving first; this method
   * covers the reverse ordering - the help overlay opened (a genuine "?"
   * press can land before this poll ever settles) before this poll's own
   * settle condition was met - by closing it here, unconditionally, before
   * the welcome plate ever appears.
   */
  _revealWelcomeOnce() {
    if (this._disposed || this._welcome || hasSeenWelcome()) return;
    this._closeHelp();
    this._welcome = createWelcome({
      container: document.body,
      onOpenChange: (open) => {
        if (open) return;
        rememberWelcomeSeen();
        this._welcome?.destroy?.();
        this._welcome = null;
      },
      onTakeTour: () => this._handleWelcomeTour(),
    });
    this._welcome.open();
  }

  /**
   * "Take the hero tour": enable the anomalies layer through the same
   * manager channel `_connectAnomaliesShell` already uses
   * (`manager.setEnabled(id, on, {origin: 'user'})` - a real click enabling
   * a real register, same as clicking its panel row), then reach the
   * layer's own `playTour()` through the same module-lookup idiom
   * `_connectLiveClaimsShell`'s `focusAnomalyCase` already uses
   * (`manager.layers.get('anomalies').module`), and only THEN close the
   * plate - not before, so a visitor who declines to wait still sees the
   * tour genuinely under way rather than a dismissed plate that silently
   * failed to start anything. `setEnabled`'s promise resolves only after
   * the layer's first data fetch settles (src/data/lifecycle.js), so
   * `playTour()` always has real hero cases to fly through by the time it
   * is called; it is not itself awaited to completion (it runs for minutes,
   * flying through every hero case in turn) - only kicked off.
   */
  async _handleWelcomeTour() {
    if (this._welcomeTourInFlight) return;
    this._welcomeTourInFlight = true;
    try {
      const manager = this._dataManager;
      if (manager) {
        if (!manager.isEnabled?.('anomalies')) {
          await manager
            .setEnabled?.('anomalies', true, { origin: 'user' })
            .catch(() => false);
        }
        const mod = manager.layers?.get('anomalies')?.module;
        mod?.playTour?.();
      }
    } finally {
      this._welcomeTourInFlight = false;
      this._welcome?.close();
    }
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
   * (`_toggleSpotter`) and close (`_closeSpotter`) alongside it, same
   * idiom: built lazily, on the first press, and then live for as long as
   * this instance does (`stop()` destroys it); the callback is re-attached
   * on every connect, same as the mode and search callbacks above. Unlike
   * Phenomena mode, closing has no "restore" step to force, so this
   * function just closes the plate unconditionally on every connect
   * (below) rather than tracking an active/inactive pair: a plate that was
   * never opened has nothing to close, and one left open across a rewire
   * is exactly the orphaned-plate bug this fixes.
   *
   * The Observatory plate's own toggle (`_toggleObservatory`) is not part
   * of this channel (fix round, atlas-instruments task 1): it is a
   * standalone button built directly by this class (see
   * `_createObservatoryToggle`), always present regardless of the
   * anomalies module's own enabled state, so it needs no button to reset
   * here. `_closeObservatory` is still called unconditionally on every
   * connect below, for the same orphaned-plate reason as Spotter.
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
    // `_closeSpotter` also resets its button's `aria-pressed` (via
    // `_anomaliesSetSpotterOpen`, still the outgoing module's callback at
    // this point), so the button and its plate stay in lockstep; the field
    // is then nulled below so a stale callback is never used before the new
    // module attaches its own. `_closeObservatory` resets its own toggle
    // directly (that button is not part of this module's channel at all -
    // see `_toggleObservatory`'s doc comment), so it needs no matching
    // field here.
    this._closeSpotter();
    this._anomaliesSetSpotterOpen = null;
    this._closeObservatory();
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
        searchCasesWithIndex(query, await this._getCaseSearchIndex()),
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
   * Build the Observatory plate's own open control: a small, always-present
   * button appended directly to the viewer container, never to the sky
   * chronometer's action row (fix round, atlas-instruments task 1, fixing
   * the blocking finding on the first pass: the chronometer's own
   * `setVisible(false)` detaches its whole DOM tree - chronometer.js's
   * `root.remove()` - so a toggle placed there vanished the instant the
   * sky register was disabled, even though the plate itself reads shipped
   * datasets and live getStats() through the functions below, never the
   * anomalies layer's own enabled state, and so has nothing to do with
   * whether that one register happens to be on). Built once, here, in the
   * constructor, so the control's own reachability never depends on any
   * layer's enabled state, or on the anomalies module having loaded at
   * all. The click handler owns the button's `aria-pressed` sync on open
   * (mirroring the old chrono-action idiom: set it from the toggle's own
   * return value); `_closeObservatory` below covers every other path that
   * can close the plate from outside a click on this button.
   * @returns {HTMLButtonElement}
   */
  _createObservatoryToggle() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'uap-observatory-toggle';
    btn.textContent = 'Observatory';
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      btn.setAttribute('aria-pressed', String(this._toggleObservatory()));
    });
    (this.viewer?.container || document.body).appendChild(btn);
    return btn;
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
      container: this.viewer?.container,
      // Fix 3 (atlas-instruments): the plate's own Escape and Close-button
      // paths close it without going through this class at all, so the
      // standalone toggle button below was left stuck at
      // aria-pressed="true". `onClose` fires from every path that actually
      // closes the plate (observatory.js's own `close()`), including this
      // method's own `toggle()` call just below, so resetting the button
      // here and in `_closeObservatory` is redundant but harmless, never
      // wrong. Also returns focus to the toggle (minor 7): the dialog that
      // held it just disappeared, so the toggle is where focus should land
      // next, same as a standard dialog-close pattern.
      onClose: () => {
        this._observatoryToggleBtn?.setAttribute('aria-pressed', 'false');
        this._observatoryToggleBtn?.focus?.();
      },
    });
    return this._observatory.toggle();
  }

  /**
   * Close the Observatory plate if one has been built, and reset its own
   * standalone toggle's `aria-pressed` directly (the button this class
   * built itself in `_createObservatoryToggle`, not a callback borrowed
   * from the anomalies module - unlike Spotter, this plate has no shell
   * services channel to go stale). Idempotent and always safe to call
   * unconditionally, so a shell rewire or teardown never has to check
   * whether the plate exists or is open first (the orphan lesson this
   * plate must not repeat).
   */
  _closeObservatory() {
    this._observatory?.close?.();
    this._observatoryToggleBtn?.setAttribute('aria-pressed', 'false');
  }

  /**
   * Build the help overlay's own open control: a small, always-present "?"
   * button, appended directly to the viewer container right beside the
   * Observatory toggle (`_createObservatoryToggle`), same always-present,
   * layer-independent reasoning as that button. Unlike the Observatory
   * toggle, this button's own click handler does not set `aria-pressed`
   * from `_toggleHelp`'s return value itself - it does not need to,
   * because `_toggleHelp` always builds the overlay with an `onOpenChange`
   * that already syncs it on every genuine open and close, including the
   * ones this button's own click causes. That is the one genuine
   * behavioural difference from the Observatory toggle: the help overlay
   * can also be opened by the "?" keydown shortcut below, never going
   * through this button's click handler at all, so `aria-pressed` can only
   * ever be kept correct by listening from inside the overlay itself.
   * @returns {HTMLButtonElement}
   */
  _createHelpToggle() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'uap-help-toggle';
    btn.textContent = '?';
    btn.setAttribute('aria-label', 'Help');
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => this._toggleHelp());
    (this.viewer?.container || document.body).appendChild(btn);
    return btn;
  }

  /**
   * Show or hide the help overlay, building it on first use (same lazy-build
   * idiom as `_toggleObservatory`). Inert while the welcome plate is
   * currently showing: the welcome pass ruling (see `_revealWelcomeOnce`'s
   * own doc comment) is that the two never stack, and unlike
   * `_revealWelcomeOnce` - which fires once, from a poll, and so can simply
   * refuse to open over an already-open help overlay (see its own guard
   * just above its `createWelcome` call) - this method can be invoked at
   * any moment after boot by a genuine keypress, including the brief window
   * before the welcome plate has appeared at all. Refusing to open here
   * whenever the welcome plate is open covers that direction; the
   * corresponding guard in `_revealWelcomeOnce` covers the other one.
   * Returns the overlay's new open state, or `false` while inert.
   * @returns {boolean}
   */
  _toggleHelp() {
    if (this._welcome?.isOpen?.()) return false;
    this._help ||= createHelpOverlay({
      container: this.viewer?.container,
      onOpenChange: (open) => {
        this._helpToggleBtn?.setAttribute('aria-pressed', String(open));
        if (!open) this._helpToggleBtn?.focus?.();
      },
    });
    return this._help.toggle();
  }

  /**
   * Close the help overlay if one has been built, and reset its own
   * standalone toggle's `aria-pressed` directly - same shape as
   * `_closeObservatory`, and for the same orphan-close reason: always safe
   * to call unconditionally, whether or not the overlay exists or is open.
   */
  _closeHelp() {
    this._help?.close?.();
    this._helpToggleBtn?.setAttribute('aria-pressed', 'false');
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
        // The literal string "preserved" turns up in this header alongside
        // real country names (an upstream data-quality artefact in the
        // sweep's own countries[] field, not a place), so it is filtered
        // out here next to the existing empty-string guard rather than
        // counted as a country.
        countries: Array.isArray(json.countries)
          ? json.countries.filter(
              (c) => typeof c === 'string' && c && c !== 'preserved',
            )
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
   * failed fetch is not cached, so the next query tries again. While a
   * fetch is in flight, every concurrent caller (this method is awaited
   * both directly and from inside `_getGeipanSearchRecords` in the same
   * `_buildCaseSearchRecords` round) shares that one promise rather than
   * starting a fetch of its own - see `_skySearchRecordsInFlight`'s own
   * doc comment in the constructor.
   */
  async _getSkySearchRecords() {
    if (this._skySearchRecords) return this._skySearchRecords;
    if (this._skySearchRecordsInFlight) return this._skySearchRecordsInFlight;
    this._anomalySearchSource ||= createAnomalySource({
      baseUrl: this._caseSearchBaseUrl('anomalies/'),
    });
    this._skySearchRecordsInFlight = (async () => {
      try {
        const rows = await this._anomalySearchSource.getSnapshot();
        this._skySearchRecords = rows.map((r) => ({
          id: r.id,
          register: 'sky',
          title: r.title,
          year: r.year,
          craft: r.craft,
        }));
        return this._skySearchRecords;
      } catch (error) {
        console.warn('[UI:CaseSearch] Sky dataset unavailable', error);
        return [];
      } finally {
        this._skySearchRecordsInFlight = null;
      }
    })();
    return this._skySearchRecordsInFlight;
  }

  /**
   * The raw ancient-sites snapshot (`{heroes, sweep, count}`, decoded by
   * `normalizeAncientSitesV2` inside `createAncientSource`), fetched once
   * and cached so `_getAncientSearchRecords` (heroes) and
   * `_getAncientSweepSearchRecords` (the ~81k-row sweep, task 3,
   * atlas-instruments) share one fetch of `sites.v2.json` rather than one
   * each. Not the Observatory's own `_fetchObservatoryAncientStats` fetch
   * of the same file (task 1): that one keeps only the header fields
   * (`count`/`types`/`countries`) and throws the columnar `sites` block
   * away, so it cannot supply the per-site names this search needs - the
   * sanctioned reader for those is `createAncientSource`'s own decode, used
   * here exactly as `_getAncientSearchRecords` already used it. A failed
   * fetch is not cached, so the next call tries again. While a fetch is in
   * flight, every concurrent caller (this method is awaited from both
   * `_getAncientSearchRecords` and `_getAncientSweepSearchRecords` in the
   * same `_buildCaseSearchRecords` round) shares that one promise rather
   * than starting a fetch of its own - see `_ancientSnapshotInFlight`'s own
   * doc comment in the constructor.
   */
  async _getAncientSnapshot() {
    if (this._ancientSnapshot) return this._ancientSnapshot;
    if (this._ancientSnapshotInFlight) return this._ancientSnapshotInFlight;
    this._ancientSearchSource ||= createAncientSource({
      baseUrl: this._caseSearchBaseUrl('ancient-sites/'),
    });
    this._ancientSnapshotInFlight = (async () => {
      try {
        this._ancientSnapshot = await this._ancientSearchSource.getSnapshot();
        return this._ancientSnapshot;
      } catch (error) {
        console.warn(
          '[UI:CaseSearch] Ancient sites dataset unavailable',
          error,
        );
        return null;
      } finally {
        this._ancientSnapshotInFlight = null;
      }
    })();
    return this._ancientSnapshotInFlight;
  }

  /**
   * Ancient-sites hero-tier records for the cross-register search, same
   * independence and caching as `_getSkySearchRecords` above, read off the
   * shared snapshot cache (`_getAncientSnapshot`) rather than a fetch of
   * its own.
   */
  async _getAncientSearchRecords() {
    if (this._ancientSearchRecords) return this._ancientSearchRecords;
    const snapshot = await this._getAncientSnapshot();
    if (!snapshot) return [];
    this._ancientSearchRecords = snapshot.heroes.map((r) => ({
      id: r.id,
      register: 'ancient',
      title: r.name,
      type: r.type,
      period: r.period,
      country: r.country,
    }));
    return this._ancientSearchRecords;
  }

  /**
   * The worldwide ancient-sites sweep (~81k rows), mapped into the shared
   * search shape from the same columnar accessors `rendering.js` and the
   * sweep dossier already read (task 3, atlas-instruments): id
   * `ancient:sweep:<i>`, the site's real name as its title, and its type
   * and country - nothing invented, no place name beyond what the sweep
   * itself carries. Read off the same shared snapshot cache as the hero
   * tier above (one fetch of `sites.v2.json` serves both), and, like every
   * cache on this class, built once: this allocates one small plain object
   * per sweep row (id/register/title/type/country, five string/number
   * fields) rather than 81k copies of anything already held by the
   * decoded snapshot, which `sweepAccessor` above still owns.
   */
  async _getAncientSweepSearchRecords() {
    if (this._ancientSweepSearchRecords) return this._ancientSweepSearchRecords;
    const snapshot = await this._getAncientSnapshot();
    if (!snapshot) return [];
    const { sweep } = snapshot;
    const records = new Array(sweep.length);
    for (let i = 0; i < sweep.length; i++) {
      records[i] = {
        id: `ancient:sweep:${i}`,
        register: 'ancient',
        title: sweep.name(i),
        type: sweep.typeName(i),
        country: sweep.countryName(i),
      };
    }
    this._ancientSweepSearchRecords = records;
    return this._ancientSweepSearchRecords;
  }

  /**
   * Real (non-hero, non-sample) GEIPAN cases for the cross-register search:
   * every row `_getSkySearchRecords` already fetched and cached that
   * carries no title of its own (GEIPAN's columnar rows ship none - see
   * DATA_PIPELINE.md's privacy rule, no place names, rounded coordinates
   * only). Reuses that same cached fetch rather than a second one; the
   * title synthesised here is `GEIPAN case <id>`, the id verbatim from the
   * shipped dataset and nothing invented, which doubles as how a query for
   * the id itself (or a fragment of it) finds the case, since `rankRecord`
   * only ever looks at `title`, never at `id` directly. `country: 'France'`
   * is likewise not a placement guess: GEIPAN's whole caseload is French
   * airspace. `craft: null` throughout - the search entry does not carry a
   * shape claim the dataset's own title never made.
   */
  async _getGeipanSearchRecords() {
    if (this._geipanSearchRecords) return this._geipanSearchRecords;
    const rows = await this._getSkySearchRecords();
    const records = rows
      .filter((r) => !r.title)
      .map((r) => ({
        id: r.id,
        register: 'sky',
        title: `GEIPAN case ${r.id}`,
        year: r.year,
        craft: null,
        country: 'France',
      }));
    // `_getSkySearchRecords` only sets `this._skySearchRecords` when its own
    // fetch succeeded (a failed fetch returns a fresh `[]` without caching -
    // see its own doc comment); a falsy `_skySearchRecords` here means that
    // just happened, so `rows` is a transient empty result, not a genuine
    // one, and caching this tier off it would strand a degraded (empty)
    // GEIPAN tier in the search corpus for the rest of the session (fix
    // round, finding 2). Skip the cache write in that case; the very next
    // search call will retry `_getSkySearchRecords` on its own.
    if (!this._skySearchRecords) return records;
    this._geipanSearchRecords = records;
    return this._geipanSearchRecords;
  }

  /**
   * Records for the chronometer's cross-register search: hero-tier sky and
   * ancient-sites records first, then the two worldwide tiers (GEIPAN's
   * real caseload, then the ancient-sites sweep) - heroes carry the
   * richer, curated entries, and `searchCases`/`searchCasesWithIndex` are
   * stable sorts, so on a tied rank a hero always outranks a swept row
   * (see the task report's honesty pins). Each tier is fetched once and
   * cached on this instance (see the fields above); this method's own
   * combined result is cached too, so the ~85k-record concatenation itself
   * runs once, not once per keystroke - but only once every tier's own
   * fetch has actually succeeded (fix round, finding 2). A transient
   * fetch failure on the very first search (a tier-fetch hiccup, not a
   * genuinely empty dataset) must not freeze a degraded corpus in place
   * for the rest of the session: each tier getter above already leaves
   * its own cache field unset when its own fetch failed rather than
   * caching the empty result it returns for that one call (see their own
   * doc comments), so checking those four fields here tells a real,
   * cacheable empty result apart from a failure that should retry next
   * time.
   */
  async _buildCaseSearchRecords() {
    if (this._caseSearchRecords) return this._caseSearchRecords;
    const [skyAll, ancient, geipan, sweep] = await Promise.all([
      this._getSkySearchRecords(),
      this._getAncientSearchRecords(),
      this._getGeipanSearchRecords(),
      this._getAncientSweepSearchRecords(),
    ]);
    // `skyAll` is `_getSkySearchRecords`'s own full, unfiltered result
    // (also used by `_fetchObservatorySkyYears` for its histogram, so that
    // method's own fetch must keep every row, titled or not) - narrowed to
    // its titled (hero/sample) rows here, since the untitled ones already
    // have their own richer entry above, from `_getGeipanSearchRecords`.
    const sky = skyAll.filter((r) => r.title);
    const records = [...sky, ...ancient, ...geipan, ...sweep];
    const everyTierSucceeded =
      Boolean(this._skySearchRecords) &&
      Boolean(this._ancientSearchRecords) &&
      Boolean(this._geipanSearchRecords) &&
      Boolean(this._ancientSweepSearchRecords);
    if (everyTierSucceeded) this._caseSearchRecords = records;
    return records;
  }

  /**
   * The cross-register search index (src/app/caseSearch.js), built once
   * from `_buildCaseSearchRecords` and cached: `buildCaseSearchIndex` is
   * itself a single O(n) pass over the ~85k-record corpus, measured in the
   * task report at tens of milliseconds, so this runs it once per session
   * rather than once per keystroke. Cached only when
   * `_buildCaseSearchRecords` itself cached (see its own doc comment,
   * fix round finding 2) - an index built from a degraded corpus is
   * returned for this one call but never stranded in `_caseSearchIndex`,
   * so a retried search after a transient failure gets a freshly built
   * index over the now-complete corpus rather than a stale, incomplete
   * one.
   */
  async _getCaseSearchIndex() {
    if (this._caseSearchIndex) return this._caseSearchIndex;
    const records = await this._buildCaseSearchRecords();
    const index = buildCaseSearchIndex(records);
    if (this._caseSearchRecords) this._caseSearchIndex = index;
    return index;
  }

  /**
   * Fly to and open the dossier for a case-search result. The target
   * register's layer is enabled first when it is off (awaited, so its
   * first data load has settled) before the layer's own focus call runs.
   * An ancient-sites result whose id is `ancient:sweep:<i>` (task 3,
   * atlas-instruments) routes to the ancient layer's `focusSweep`, mirroring
   * `focusSite`'s own shape but for a sweep row addressed by index rather
   * than a hero addressed by id; every other ancient-sites result is a
   * hero and still goes through `focusSite`.
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
    if (targetId === 'ancient-sites') {
      const sweepMatch = /^ancient:sweep:(\d+)$/.exec(String(result.id ?? ''));
      if (sweepMatch) await mod?.focusSweep?.(Number(sweepMatch[1]));
      else await mod?.focusSite?.(result.id);
    } else {
      await mod?.focusCase?.(result.id);
    }
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
    this._observatoryToggleBtn?.remove();
    this._observatoryToggleBtn = null;
    // Orphan close on detach, same reasoning as the Observatory plate just
    // above: a shell teardown must not leave the help overlay on screen
    // with nothing left to answer its buttons, nor its document-level "?"
    // listener still bound past this instance's own lifetime.
    if (this._helpKeydownHandler) {
      document.removeEventListener('keydown', this._helpKeydownHandler);
      this._helpKeydownHandler = null;
    }
    this._help?.destroy?.();
    this._help = null;
    this._helpToggleBtn?.remove();
    this._helpToggleBtn = null;
    // Orphan close on detach: a shell teardown mid-boot (before the poll
    // above has even settled) must not leave a dangling timer running past
    // this instance's own lifetime, nor a plate on screen with nothing left
    // to answer its buttons.
    this._clearWelcomeRevealTimer();
    this._welcome?.destroy?.();
    this._welcome = null;
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
