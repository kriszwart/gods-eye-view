import * as Cesium from 'cesium';
import {
  ANCIENT_LAYER_ID,
  mapAnalystRecord,
  mapSweepAnalystRecord,
  createAncientOverlayEntry,
} from './model.js';
import { createAncientRenderer } from './rendering.js';
import { safeSourceUrl, safeImageUrl } from '../../sources/safeUrl.js';
import { createTmaLocalSource, TMA_ID_PREFIX } from './tmaLocal.js';
// The chronometer widget lives in the anomalies package (see CLAUDE.md's
// "Where things are"); it is reused here, unmodified in its own default
// behaviour, for the deep-time dial's second scale (see chronometer.js's
// own `scale` option and eras.js below). Declared in the "ancient-sites"
// package boundary (scripts/package-boundaries.json) since this package's
// own build now reaches it.
import { createChronometer } from '../anomalies/chronometer.js';
import {
  DEEP_TIME_MAX_BCE,
  DEEP_TIME_MIN_BCE,
  DEEP_TIME_TICKS,
  deepTimeT,
  bceFromT,
  formatBceYear,
  describeEraBand,
  heroInEraBand,
} from './eras.js';
export * from './model.js';
export { normalizeAncientSitesV2 } from './records.js';
export { createAncientSource } from './source.js';

/**
 * Local-only Modern Antiquarian register (see tmaLocal.js): every reference
 * to it below sits behind this constant, folded to a literal `false` when
 * `PHENOMENA_LOCAL_TMA` is unset, so a production build can prove the whole
 * branch dead and drop it, its dossier text included. Strict `=== '1'`
 * (rather than a plain truthy check) so `PHENOMENA_LOCAL_TMA=0` stays off.
 */
const LOCAL_TMA_ENABLED = import.meta.env?.PHENOMENA_LOCAL_TMA === '1';

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * The honesty line the deep-time dial's era band requires wherever it
 * surfaces (see eras.js's own top-of-file note): undated sweep sites are
 * placed by their type's typical worldwide period, never by anything
 * about the individual site, and this line says so plainly next to the
 * dial itself. British English, sentence case.
 */
const DEEP_TIME_HONESTY_LINE =
  "Undated sites are placed by their type's typical period, not their own dating.";

/**
 * Curated ancient and disputed-archaeology sites, shown as a static gold
 * register with a dossier per site, plus a worldwide Wikidata sweep of tens
 * of thousands more. Implements the standard GEV layer contract, without the
 * anomalies layer's atmosphere, tour or craft: this is a calm, unmoving
 * companion register.
 *
 * Deep-time dial: when this layer is on and the sky (anomalies) layer is
 * off, this layer builds its own second instance of the anomalies
 * package's chronometer widget, configured with a 10,000 BCE to 1500 CE
 * log-compressed scale (see chronometer.js's `scale` option and eras.js).
 * The sky scale always wins when both layers are on - the ancient register
 * ignores the year dial entirely then, exactly as before the deep-time
 * dial existed. `attachShellServices` below receives the live sky-active
 * signal from the shell; the dial is created and destroyed on demand
 * (never left mounted-but-hidden), and the sky layer's own chronometer
 * detaches its root from the DOM outright whenever it is hidden (see
 * chronometer.js's own `setVisible`, not just an added `hidden` attribute),
 * so the two chronometer instances - this one and the sky layer's own -
 * are never both in the DOM at once, which would make every
 * `.uap-chrono`/`.uap-slider` query in the sky layer's own gates
 * ambiguous.
 *
 * Heroes filter by their own real `period_start_bce`; the worldwide sweep
 * carries no per-site dating, so it is banded by its TYPE's typological
 * era window instead (`eras.js`), never presented as the individual site's
 * own dating - the honesty line next to the dial says so.
 *
 * Bounded-render guarantees (camera-height clustering bands, the skyward
 * fallback) are unaffected: the era band is an extra filter applied to the
 * clustering inputs (`clusters.js`'s `filter` option), not a change to how
 * `cellDeg`/`bounds` are chosen.
 *
 * The hero tier (curated, photographed, debated) is unclustered and always
 * addressable by id, exactly as before this layer carried the sweep. The
 * sweep never clusters by identity: `rendering.js` bands it by camera height
 * into grid clusters and singles, so ~81k sites do not become ~81k
 * primitives at once. A sweep site's dossier is compact (name, type,
 * country, a Wikidata link and a Wikipedia link when the sweep flagged one)
 * because the sweep carries no photo, debate or era column (see the phase
 * 5b task 2 report on the omitted `bce` column).
 *
 * A third, local-only register, The Modern Antiquarian (`tmaLocal.js`), can
 * add unclustered gold points with a compact dossier and record link when
 * `PHENOMENA_LOCAL_TMA` is set at build time. TMA's terms permit curation
 * and per-site links only, never bulk redistribution, so this register
 * never ships: see `LOCAL_TMA_ENABLED` above, `server/providers/local-tma.js`
 * for the dev server's own env gate, and DATA_SOURCES.md for the owner note.
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
  let heroRows = [];
  let sweepAccessor = null;
  let tmaRows = [];
  let totalCount = 0;
  let enabled = false;
  let loaded = false;
  let request = null;
  let lastUpdate = null;
  let lastError = null;
  let clickHandler = null;
  // Deep-time dial: `host` is stashed at init() for reuse (the dial mounts
  // and unmounts on demand, long after init() has returned). `isSkyActive`
  // is the shell's live signal (attachShellServices below); it defaults to
  // "sky is off" so the dial can still work before any shell ever attaches
  // it (a plain unit or integration harness, or the moment before
  // layerBindings.js connects at boot).
  let host = null;
  let isSkyActive = () => false;
  let deepChrono = null;
  let deepTimeNote = null;
  let deepRelayoutRemover = null;
  let lastDeepLayoutKey = '';

  function openHeroDossier(id) {
    const row = heroRows.find((r) => r.id === id);
    if (!row || !dossier) return;
    const sourceUrl = safeSourceUrl(row.source_url);
    const wikipediaUrl = safeSourceUrl(row.wikipedia);
    const streetViewUrl = safeSourceUrl(
      `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${row.lat.toFixed(4)},${row.lon.toFixed(4)}`,
    );
    const credit = row.image_attribution;
    const attributed = !!(credit?.author && credit?.licence);
    const imageUrl = attributed ? safeImageUrl(row.image) : null;
    dossier.innerHTML = `
      <button type="button" class="uap-close" aria-label="Close site">Close</button>
      <h2>${escapeHtml(row.name)}</h2>
      <img class="uap-glyph" alt="" src="${assetBase}glyphs/${escapeHtml(row.glyph)}.svg">
      ${imageUrl ? `<img class="uap-photo" alt="${escapeHtml(row.name)}" loading="lazy" src="${escapeHtml(imageUrl)}">` : ''}
      ${imageUrl ? `<p class="uap-photo-credit">Photo: ${escapeHtml(credit.author)}, ${escapeHtml(credit.licence)}</p>` : ''}
      <dl>
        <dt>Period</dt><dd>${escapeHtml(row.period)}</dd>
        <dt>Country</dt><dd>${escapeHtml(row.country)}</dd>
        <dt>Type</dt><dd>${escapeHtml(row.type)}</dd>
      </dl>
      ${row.debated ? `<p class="uap-debated">Debated: ${escapeHtml(row.debated)}</p>` : ''}
      <p class="uap-summary">${escapeHtml(row.summary)}</p>
      ${
        sourceUrl || wikipediaUrl || streetViewUrl
          ? `<p class="uap-source">${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Open record</a>` : ''}${wikipediaUrl ? `<a href="${escapeHtml(wikipediaUrl)}" target="_blank" rel="noopener noreferrer">Wikipedia</a>` : ''}${streetViewUrl ? `<a href="${escapeHtml(streetViewUrl)}" target="_blank" rel="noopener noreferrer">Street view</a>` : ''}</p>`
          : ''
      }
      ${row.attribution ? `<p class="uap-attribution">${escapeHtml(row.attribution)}</p>` : ''}`;
    dossier.hidden = false;
    dossier.querySelector('.uap-close').focus();
  }

  /**
   * Compact dossier for a single worldwide-sweep site: no photo or debate
   * (hero-only), no era (the sweep ships no bce column). A Wikidata link is
   * always available (every sweep row carries a qid); the Wikipedia link
   * only appears when the sweep flagged an enwiki title for this row.
   */
  function openSweepDossier(index) {
    if (
      !dossier ||
      !sweepAccessor ||
      index < 0 ||
      index >= sweepAccessor.length
    )
      return;
    const name = sweepAccessor.name(index);
    const typeName = sweepAccessor.typeName(index);
    const countryName = sweepAccessor.countryName(index);
    const qid = sweepAccessor.qid(index);
    const wikiTitle = sweepAccessor.wikiTitle(index);
    const lat = sweepAccessor.lat(index);
    const lon = sweepAccessor.lon(index);
    const wikidataUrl = safeSourceUrl(`https://www.wikidata.org/wiki/${qid}`);
    const wikipediaUrl = wikiTitle
      ? safeSourceUrl(`https://en.wikipedia.org/wiki/${wikiTitle}`)
      : null;
    const streetViewUrl = safeSourceUrl(
      `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(4)},${lon.toFixed(4)}`,
    );
    dossier.innerHTML = `
      <button type="button" class="uap-close" aria-label="Close site">Close</button>
      <h2>${escapeHtml(name)}</h2>
      <dl>
        <dt>Type</dt><dd>${escapeHtml(typeName)}</dd>
        <dt>Country</dt><dd>${escapeHtml(countryName || 'Unrecorded')}</dd>
      </dl>
      ${
        wikidataUrl || wikipediaUrl || streetViewUrl
          ? `<p class="uap-source">${wikidataUrl ? `<a href="${escapeHtml(wikidataUrl)}" target="_blank" rel="noopener noreferrer">Wikidata</a>` : ''}${wikipediaUrl ? `<a href="${escapeHtml(wikipediaUrl)}" target="_blank" rel="noopener noreferrer">Wikipedia</a>` : ''}${streetViewUrl ? `<a href="${escapeHtml(streetViewUrl)}" target="_blank" rel="noopener noreferrer">Street view</a>` : ''}</p>`
          : ''
      }`;
    dossier.hidden = false;
    dossier.querySelector('.uap-close').focus();
  }

  /**
   * Compact dossier for a local-only Modern Antiquarian row: name, category
   * and its own record link, no photo or debate. Never reachable unless
   * `LOCAL_TMA_ENABLED` gated this register on at build time.
   */
  function openTmaDossier(id) {
    const row = tmaRows.find((r) => r.id === id);
    if (!row || !dossier) return;
    const sourceUrl = safeSourceUrl(row.url);
    dossier.innerHTML = `
      <button type="button" class="uap-close" aria-label="Close site">Close</button>
      <h2>${escapeHtml(row.name)}</h2>
      <dl>
        <dt>Category</dt><dd>${escapeHtml(row.category || 'Unrecorded')}</dd>
      </dl>
      ${sourceUrl ? `<p class="uap-source"><a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Open record</a></p>` : ''}
      <p class="uap-attribution">Source: The Modern Antiquarian. Local reference only, not included in the shared dataset.</p>`;
    dossier.hidden = false;
    dossier.querySelector('.uap-close').focus();
  }

  /**
   * Apply the deep-time dial's current era band (or its absence) to the
   * renderer and the hero tier, and refresh the dial's readout. Heroes
   * filter by their own `period_start_bce`; the sweep is banded by type
   * inside `rendering.js`'s `setEraFilter` (see eras.js). Overlay labels
   * stay in lockstep with which heroes are actually rendered, so a
   * filtered-out hero's label never floats with no point beneath it.
   * Safe to call before any data has loaded (an empty `heroRows`) or
   * before the renderer exists at all. "All eras" mode passes a null band,
   * same as the dial being absent altogether: every site already shows in
   * that mode (see eras.js's `withinBand`), so a non-null band there would
   * only cost the sweep an 81k-row closure scan that always answers true.
   */
  function syncEraState() {
    if (!renderer) return;
    const band =
      deepChrono && deepChrono.mode !== 'all'
        ? { bceValue: deepChrono.year, mode: deepChrono.mode }
        : null;
    renderer.setEraFilter(band);
    const rows = band
      ? heroRows.filter((r) =>
          heroInEraBand(r.period_start_bce, band.bceValue, band.mode),
        )
      : heroRows;
    renderer.setHeroes(rows);
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
    if (deepChrono) {
      const diagnostics = renderer.getDiagnostics();
      const count = rows.length + (diagnostics?.sweepVisibleCount ?? 0);
      deepChrono.setReadout(
        describeEraBand(deepChrono.year, count, deepChrono.mode),
      );
    }
  }

  /** Keep the deep-time dial's band layout current as the canvas resizes,
   * mirroring the sky chronometer's own postRender-driven relayout - a
   * passive listener (never itself requests a render), memoised so an
   * unchanged canvas size is a no-op. Always band layout (never the ring
   * that wraps the globe): a secondary, less central time control, kept
   * simple by design. */
  function relayoutDeepChrono() {
    if (!deepChrono || !viewer) return;
    const canvas = viewer.scene.canvas;
    const key = `${canvas.clientWidth}x${canvas.clientHeight}`;
    if (key === lastDeepLayoutKey) return;
    lastDeepLayoutKey = key;
    deepChrono.layout(null, {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
    });
  }

  /**
   * Build or tear down the deep-time dial: it shows only while this layer
   * is enabled and the sky (anomalies) layer is not - the sky scale always
   * wins when both are on (ruling: preserves today's decoupled behaviour).
   * The dial is a second, independent instance of the anomalies package's
   * chronometer widget, created and destroyed on demand rather than kept
   * mounted-but-hidden. That, plus the sky layer's own chronometer
   * detaching its root from the DOM whenever it is hidden (chronometer.js's
   * `setVisible`, not just a `hidden` attribute), is what keeps the sky
   * layer's own `.uap-chrono`/`.uap-slider` queries (its own qa gate) from
   * ever being made ambiguous by a second such element sitting in the DOM
   * at the same time.
   */
  function syncDeepTime() {
    const shouldShow = enabled && !isSkyActive();
    if (shouldShow && !deepChrono) {
      deepChrono = createChronometer({
        container: host,
        from: DEEP_TIME_MIN_BCE,
        to: DEEP_TIME_MAX_BCE,
        labels: {
          year: 'Era',
          modes: 'Era filter',
          cumulative: 'Up to era',
          window: 'Around era',
          all: 'All eras',
        },
        scale: {
          initial: DEEP_TIME_MIN_BCE,
          posOf: deepTimeT,
          fromPos: bceFromT,
          values: () => DEEP_TIME_TICKS,
          isMajor: () => true,
          format: formatBceYear,
          step: 50,
          pageStep: 500,
          histogram: false,
        },
        onChange: syncEraState,
        onModeChange: syncEraState,
      });
      deepChrono.setVisible(true);
      lastDeepLayoutKey = '';
      relayoutDeepChrono();
      deepRelayoutRemover ||=
        viewer.scene.postRender.addEventListener(relayoutDeepChrono);
      if (deepTimeNote) deepTimeNote.hidden = false;
      syncEraState();
    } else if (!shouldShow && deepChrono) {
      deepChrono.destroy();
      deepChrono = null;
      deepRelayoutRemover?.();
      deepRelayoutRemover = null;
      if (deepTimeNote) deepTimeNote.hidden = true;
      syncEraState();
    }
  }

  /** Clicking a badge flies the camera one band closer, centred on it. */
  async function flyToCluster(index) {
    const cluster = renderer?.getCluster(index);
    if (!cluster || !viewer) return;
    const targetHeight = renderer.nextBandTargetHeight();
    await new Promise((resolve) =>
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          cluster.lon,
          cluster.lat,
          targetHeight,
        ),
        duration: 1.5,
        complete: resolve,
        cancel: resolve,
      }),
    );
  }

  /** Pick-registry ownership test: `ancient:` and `ancient-cluster:` always;
   * `tma:` only when the local-only register is build-time enabled, so an
   * unset flag never registers interest in an id prefix it never emits. */
  function isOwnedPickId(pickedId) {
    if (!enabled || typeof pickedId !== 'string') return false;
    if (
      pickedId.startsWith('ancient:') ||
      pickedId.startsWith('ancient-cluster:')
    )
      return true;
    return LOCAL_TMA_ENABLED && pickedId.startsWith(TMA_ID_PREFIX);
  }

  function handlePick(picked) {
    if (!picked) return;
    if (picked.kind === 'hero') return openHeroDossier(picked.id);
    if (picked.kind === 'sweep') return openSweepDossier(picked.index);
    if (picked.kind === 'cluster') return void flyToCluster(picked.index);
    if (LOCAL_TMA_ENABLED && picked.kind === 'tma')
      return openTmaDossier(picked.id);
  }

  const layer = {
    id: ANCIENT_LAYER_ID,
    name: 'Ancient sites',
    icon: '△',
    source: 'Curated sample + Wikidata sweep',
    updateInterval: -1,

    init(v) {
      if (viewer) throw new Error('Ancient sites layer is already initialized');
      viewer = v;
      renderer = createAncientRenderer(viewer, { render });
      host = container || viewer.container;
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
      // The deep-time dial's honesty line: created once, hidden until the
      // dial itself is showing (syncDeepTime toggles it alongside the
      // dial's own lifecycle).
      deepTimeNote = document.createElement('p');
      deepTimeNote.className = 'uap-legend ancient';
      deepTimeNote.hidden = true;
      deepTimeNote.textContent = DEEP_TIME_HONESTY_LINE;
      host.appendChild(deepTimeNote);
      overlayHost?.setVisible?.(ANCIENT_LAYER_ID, false);
      console.log('[Data:AncientSites] Initialized');
    },

    /**
     * The shell supplies the live "is the sky register active" signal the
     * deep-time dial needs (see syncDeepTime above): `isSkyActive()` is a
     * pull query the dial checks whenever it might need to change state,
     * and the returned `notifySkyChanged` is the push side - the shell
     * calls it whenever the sky (anomalies) layer's own enabled state
     * settles, so the dial reacts immediately rather than only at this
     * layer's next enable().
     */
    attachShellServices(services) {
      isSkyActive =
        typeof services?.isSkyActive === 'function'
          ? services.isSkyActive
          : () => false;
      syncDeepTime();
      return {
        notifySkyChanged() {
          syncDeepTime();
        },
      };
    },

    enable() {
      enabled = true;
      // Establish the deep-time dial - and its initial era band, if one
      // mounts - before the renderer becomes visible. The renderer is not
      // visible yet, so this call's own setEraFilter (inside syncEraState)
      // only records the era band and recomputes nothing (see
      // rendering.js's setEraFilter); the visibility-driven recompute below
      // then runs exactly once, already carrying the correct band, rather
      // than once unfiltered and then again immediately re-filtered.
      syncDeepTime();
      renderer?.apply({ visible: true });
      overlayHost?.setVisible?.(ANCIENT_LAYER_ID, true);
      if (!clickHandler) {
        clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        clickHandler.setInputAction(
          (e) => handlePick(renderer?.pick(e.position)),
          Cesium.ScreenSpaceEventType.LEFT_CLICK,
        );
      }
      picking?.registerPickOwner?.(ANCIENT_LAYER_ID, isOwnedPickId);
      // Refresh heroes, overlay labels and the dial's readout against the
      // renderer's now-current diagnostics. setEraFilter's own recompute
      // here is a no-op (the era band already matches what syncDeepTime()
      // set above, and rendering.js's recomputeSweep skips a request whose
      // inputs are unchanged since the last one it actually ran).
      syncEraState();
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      picking?.unregisterPickOwner?.(ANCIENT_LAYER_ID);
      if (dossier) dossier.hidden = true;
      clickHandler?.destroy();
      clickHandler = null;
      // Hide the renderer first, so the deep-time dial's teardown below
      // (which clears the era band via setEraFilter) finds the register
      // already invisible and skips its own recompute entirely, rather than
      // running one last, wholly wasted scan just before everything is
      // hidden anyway. `enabled` is already false above, so the dial still
      // tears down correctly regardless of this ordering.
      renderer?.apply({ visible: false });
      syncDeepTime();
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
        heroRows = next.heroes;
        sweepAccessor = next.sweep;
        totalCount = next.count;
        renderer.setSweep(sweepAccessor);
        if (LOCAL_TMA_ENABLED) {
          // Best-effort: a missing or unreachable local file never fails the
          // public dataset's own load, since this register is a dev-only
          // owner convenience, not part of the layer's real contract.
          try {
            tmaRows = await createTmaLocalSource().getRows({
              signal: current.signal,
            });
          } catch (error) {
            tmaRows = [];
            console.warn(
              '[Data:AncientSites] Local TMA register unavailable:',
              error,
            );
          }
          if (current.signal.aborted || request !== current || !enabled)
            return false;
          renderer.setTma(tmaRows);
        }
        // Overlay labels stay hero-only: the sweep is far too dense for the
        // ambient-label lane, and its cluster badges already carry their own
        // Cesium-native count text (see rendering.js). syncEraState() sets
        // the renderer's heroes and these labels together, filtered by the
        // deep-time dial's era band when it is engaged, or the full hero
        // tier when it is not - exactly the set this call used to pass
        // unconditionally before the deep-time dial existed.
        syncEraState();
        loaded = true;
        lastUpdate = Date.now();
        lastError = null;
        console.log(
          `[Data:AncientSites] Loaded ${heroRows.length} hero sites and ${sweepAccessor.length} sweep sites (${totalCount} total)`,
        );
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
      // disable() above already tears the deep-time dial down (enabled is
      // false by then); defensive here in case a future edit ever stops
      // destroy() delegating to disable() first, mirroring the anomalies
      // layer's own defensive Spotter-close call in its destroy().
      deepChrono?.destroy();
      deepChrono = null;
      deepTimeNote?.remove();
      deepTimeNote = null;
      overlayHost?.clearSource?.(ANCIENT_LAYER_ID);
      renderer?.destroy();
      dossier?.remove();
      renderer = null;
      dossier = null;
      viewer = null;
      host = null;
      heroRows = [];
      sweepAccessor = null;
      tmaRows = [];
      totalCount = 0;
      loaded = false;
    },

    /** Analyst records, heroes first (richer dossiers) then sweep rows. */
    getAnalystRecords(maxCount = 2000) {
      if (!enabled) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const heroRecords = heroRows.slice(0, limit).map(mapAnalystRecord);
      if (heroRecords.length >= limit || !sweepAccessor) return heroRecords;
      const remaining = limit - heroRecords.length;
      const sweepRecords = [];
      for (
        let i = 0;
        i < sweepAccessor.length && sweepRecords.length < remaining;
        i += 1
      ) {
        sweepRecords.push(mapSweepAnalystRecord(sweepAccessor, i));
      }
      return [...heroRecords, ...sweepRecords];
    },

    getStats() {
      return { count: totalCount, lastUpdate, error: lastError };
    },

    /** Diagnostic hook (also used by qa): rendered primitive counts and the
     * camera band currently driving sweep clustering. */
    getRenderDiagnostics() {
      return renderer?.getDiagnostics() ?? null;
    },

    /** Voice and UI hook: fly to a hero site and open its dossier. */
    async focusSite(id) {
      const row = heroRows.find((r) => r.id === id);
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
      openHeroDossier(id);
    },
  };
  return layer;
}
