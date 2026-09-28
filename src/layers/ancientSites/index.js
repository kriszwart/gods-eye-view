import * as Cesium from 'cesium';
import {
  ANCIENT_LAYER_ID,
  mapAnalystRecord,
  mapSweepAnalystRecord,
  createAncientOverlayEntry,
  ANCIENT_SWEEP_OVERLAY_SOURCE_ID,
  ANCIENT_SWEEP_LABEL_CAP,
  createAncientSweepOverlayEntry,
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
import { SWEEP_TYPES, glyphUrlForType } from './glyphMap.js';
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
 * Fired on `window` whenever any register's dossier plate opens, so the
 * other registers can close their own (every register's plate shares one
 * on-screen slot). Matching dispatch/listen pairs live in
 * src/layers/anomalies/index.js and src/layers/liveClaims/index.js; kept a
 * plain window event rather than a shared module since the three layers
 * are independent, sibling-only-by-the-shell modules.
 */
const DOSSIER_OPEN_EVENT = 'gev:dossier-open';

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
 * The honesty line the type filter chips require (task 2, ancient-legibility,
 * controller ruling): heroes are curated, not swept, so a chip toggling a
 * type off never removes a hero of that type from the globe. Said plainly
 * next to the chips so a hero staying visible with its type unchecked never
 * reads as the filter being broken. British English, sentence case.
 */
const TYPE_FILTER_HERO_HINT =
  'Heroes always show, regardless of the type filters.';

/** Sentence-case display label for a sweep type name (`circle` -> `Circle`),
 * for the legend's glyph key row below. */
const sweepTypeLabel = (type) => type.charAt(0).toUpperCase() + type.slice(1);

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
 * At the closest band, the sweep's view-bounded singles also carry ambient
 * name labels (task 3, ancient-legibility) through a sibling overlay
 * source, smaller and dimmer than the hero labels, and only while there are
 * few enough of them on screen to read as legibility rather than clutter
 * (`ANCIENT_SWEEP_LABEL_CAP`, see model.js and `syncSweepLabels` below).
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
  let onOtherDossierOpen = null;
  // Deep-time dial: `host` is stashed at init() for reuse (the dial mounts
  // and unmounts on demand, long after init() has returned). `isSkyActive`
  // is the shell's live signal (attachShellServices below); it defaults to
  // "sky is off" so the dial can still work before any shell ever attaches
  // it (a plain unit or integration harness, or the moment before
  // layerBindings.js connects at boot).
  let host = null;
  let isSkyActive = () => false;
  let deepChrono = null;
  let legend = null;
  let deepRelayoutRemover = null;
  let lastDeepLayoutKey = '';
  // Type filter chips (task 2, ancient-legibility): a Set of enabled sweep
  // types, or null meaning "every type" (the "All" chip and the default
  // before any chip is touched) - mirrors the sky register's own
  // `activeStatuses` (src/layers/anomalies/index.js). Chips share the
  // deep-time dial's own lifecycle (installTypeFilterChips below, called
  // from syncDeepTime): built fresh, and reset to "every type", every time
  // the dial engages - the sky register becoming active resets both back to
  // defaults, exactly like the era band, never a stale selection carried
  // across.
  let activeTypes = null;
  // Badge breakdown plate (task 2, ancient-legibility): a small gold
  // one-liner shown while a cluster-badge click flies the camera one band
  // closer, naming the cluster's per-type counts (see clusters.js's
  // `byType`). Created once in init(), like the dossier and legend.
  let breakdownPlate = null;

  /**
   * Reveals the (already-populated) dossier and moves focus to its close
   * button, shared by openHeroDossier, openSweepDossier and openTmaDossier.
   * Both registers' dossiers share one on-screen slot: this also tells the
   * anomalies layer to close its own, if it has one open.
   */
  function showDossier() {
    window.dispatchEvent(
      new CustomEvent(DOSSIER_OPEN_EVENT, {
        detail: { register: ANCIENT_LAYER_ID },
      }),
    );
    dossier.hidden = false;
    dossier.querySelector('.uap-close').focus();
  }

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
    showDossier();
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
    showDossier();
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
    showDossier();
  }

  /**
   * Apply the deep-time dial's current era band (or its absence) and the
   * type filter chips' current selection to the renderer and the hero tier,
   * and refresh the dial's readout. Heroes filter by their own
   * `period_start_bce` and never by the type chips (they are curated, not
   * swept - see `TYPE_FILTER_HERO_HINT`); the sweep is banded by era and
   * type together inside `rendering.js`'s `setEraFilter`/`setTypeFilter`
   * (one combined AND predicate - see eras.js and installTypeFilterChips
   * below). Overlay labels stay in lockstep with which heroes are actually
   * rendered, so a filtered-out hero's label never floats with no point
   * beneath it. Safe to call before any data has loaded (an empty
   * `heroRows`) or before the renderer exists at all. "All eras" mode passes
   * a null band, same as the dial being absent altogether: every site
   * already shows in that mode (see eras.js's `withinBand`), so a non-null
   * band there would only cost the sweep an 81k-row closure scan that
   * always answers true.
   */
  function syncEraState() {
    if (!renderer) return;
    const band =
      deepChrono && deepChrono.mode !== 'all'
        ? { bceValue: deepChrono.year, mode: deepChrono.mode }
        : null;
    renderer.setEraFilter(band);
    renderer.setTypeFilter(activeTypes);
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

  /**
   * Ambient sweep-name labels (task 3, ancient-legibility): a quieter,
   * secondary label lane beside the hero labels, published to the sibling
   * `ANCIENT_SWEEP_OVERLAY_SOURCE_ID` overlay source (see model.js's own
   * doc comment on that constant for why it is a sibling rather than the
   * hero source itself). Shown only at the closest band (`cellDeg === 0`,
   * the same view-bounded singles the glyph billboards already render -
   * see rendering.js's `currentSingles`/`renderSweepSingles`) and only when
   * there are few enough of them on screen (`ANCIENT_SWEEP_LABEL_CAP`) that
   * names add legibility rather than clutter; any coarser band, or too many
   * singles at the closest one, clears the source instead.
   *
   * Wired as the renderer's own `onSweepSinglesChange` callback (see
   * rendering.js), so this runs on the renderer's existing throttled
   * recompute/settle cadence - never per frame - and reads the `singles`
   * it already clustered: no new recompute path. `singles` already comes
   * from `clusterSweep`'s own `filter`, so the deep-time era band and the
   * type-filter chips (composed there as one AND predicate - see
   * rendering.js's `recomputeSweep`) narrow these labels exactly as they
   * narrow the billboards, with no extra plumbing here.
   *
   * Names only, gold register, and smaller/dimmer than the hero labels so
   * heroes stay visually primary (see model.js's
   * `createAncientSweepOverlayEntry`).
   * @param {number} cellDeg - The clustering grid resolution just used (0 at the closest band).
   * @param {Array<{index:number}>} singles - The closest band's current view-bounded singles.
   */
  function syncSweepLabels(cellDeg, singles) {
    if (
      cellDeg !== 0 ||
      !sweepAccessor ||
      singles.length > ANCIENT_SWEEP_LABEL_CAP
    ) {
      overlayHost?.clearSource?.(ANCIENT_SWEEP_OVERLAY_SOURCE_ID);
      return;
    }
    overlayHost?.setEntries?.(
      ANCIENT_SWEEP_OVERLAY_SOURCE_ID,
      singles.map(({ index }) =>
        createAncientSweepOverlayEntry({
          id: index,
          position: Cesium.Cartesian3.fromDegrees(
            sweepAccessor.lon(index),
            sweepAccessor.lat(index),
            0,
          ),
          name: sweepAccessor.name(index),
        }),
      ),
      { moving: false },
    );
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
   * Type filter chips (task 2, ancient-legibility): one chip per sweep type
   * plus "All", added to the deep-time dial's own panel via `addAction` -
   * the exact mechanism the sky register's own status filter chips use
   * (src/layers/anomalies/index.js's STATUS_FILTERS) - so these share the
   * dial's lifecycle: built fresh every time the dial engages (syncDeepTime
   * calls this right after creating it), gone the moment it does not. The
   * sky register becoming active resets both the era band and this
   * selection back to defaults, never a stale filter carried across (see
   * syncDeepTime's teardown branch, which resets `activeTypes` to null the
   * same instant it clears `deepChrono`).
   *
   * Multiple types are selectable at once - each chip toggles independently
   * of the others, mirroring the sky register's own status chips - and
   * "All" resets every type back on. `activeTypes` (the outer closure
   * variable `syncEraState` reads) is kept in lockstep with every chip's own
   * `aria-pressed` state, collapsing to `null` (the renderer's "no
   * filtering" value) the moment every type is enabled again, so an
   * unfiltered selection never costs the sweep a per-row type-name check it
   * does not need (mirrors `activeStatuses`'s own null-when-full-set
   * collapse in the sky register).
   * @param {ReturnType<typeof createChronometer>} chrono
   */
  function installTypeFilterChips(chrono) {
    const enabledTypes = new Set(SWEEP_TYPES);
    const typeButtons = new Map();
    const allBtn = chrono.addAction('All', () => {
      enabledTypes.clear();
      for (const type of SWEEP_TYPES) enabledTypes.add(type);
      for (const btn of typeButtons.values())
        btn.setAttribute('aria-pressed', 'true');
      allBtn.setAttribute('aria-pressed', 'true');
      activeTypes = null;
      syncEraState();
    });
    allBtn.classList.add('ancient-type-chip');
    allBtn.setAttribute('aria-pressed', 'true');
    for (const type of SWEEP_TYPES) {
      const btn = chrono.addAction(sweepTypeLabel(type), () => {
        enabledTypes.has(type)
          ? enabledTypes.delete(type)
          : enabledTypes.add(type);
        btn.setAttribute('aria-pressed', String(enabledTypes.has(type)));
        allBtn.setAttribute(
          'aria-pressed',
          String(enabledTypes.size === SWEEP_TYPES.length),
        );
        activeTypes =
          enabledTypes.size === SWEEP_TYPES.length
            ? null
            : new Set(enabledTypes);
        syncEraState();
      });
      btn.classList.add('ancient-type-chip');
      btn.setAttribute('aria-pressed', 'true');
      typeButtons.set(type, btn);
    }
    // Narrow-viewport fix (ancient-legibility, fix wave): group the six
    // chips into their own wrapper so anomaly-atlas.css can relocate them
    // as a unit below 480px, clear of the Cyber HUD telemetry chrome (and
    // the Cesium attribution/key-setup chips beside it) that the panel's
    // own bottom-anchored position shares at narrow widths. `addAction`
    // (chronometer.js) inserts each button directly into the dial's panel
    // as a flat sibling of Play, the slider and the era modes, so there is
    // no existing container to select for a CSS-only fix - flexbox has no
    // way to move a contiguous run of siblings as a group while leaving
    // the rest of the panel's own items in their normal flow. `display:
    // contents` in the CSS keeps this wrapper invisible to layout above
    // that breakpoint, so it is a no-op everywhere else (desktop stays
    // pixel-unchanged, and the sky register never creates this class).
    const panel = allBtn.parentElement;
    if (panel) {
      const chipRow = document.createElement('div');
      chipRow.className = 'ancient-type-chip-row';
      panel.insertBefore(chipRow, allBtn);
      chipRow.appendChild(allBtn);
      for (const btn of typeButtons.values()) chipRow.appendChild(btn);
    }
    activeTypes = null;
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
   *
   * The register's own legend (glyph key plus the honesty line, built in
   * init()) shares the dial's own show/hide lifecycle below: both occupy the
   * same top-left plate slot the sky register's own legend uses, so only one
   * of the two ever shows at a time, the same "sky wins" arbitration already
   * governing the dial itself.
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
      installTypeFilterChips(deepChrono);
      deepChrono.setVisible(true);
      lastDeepLayoutKey = '';
      relayoutDeepChrono();
      deepRelayoutRemover ||=
        viewer.scene.postRender.addEventListener(relayoutDeepChrono);
      if (legend) legend.hidden = false;
      syncEraState();
    } else if (!shouldShow && deepChrono) {
      deepChrono.destroy();
      deepChrono = null;
      deepRelayoutRemover?.();
      deepRelayoutRemover = null;
      if (legend) legend.hidden = true;
      // The type-filter chips just went with the dial (they are its own
      // panel buttons, destroyed above); reset the selection back to
      // "every type" too, exactly mirroring the era band's own implicit
      // reset (syncEraState below reads `deepChrono`, already null here) -
      // never a stale filter left engaged with no chip left to show it.
      activeTypes = null;
      syncEraState();
    }
  }

  /** Escape dismisses the badge breakdown plate; only ever bound while the
   * plate is actually showing (see showClusterBreakdown/hideClusterBreakdown
   * below), since the plate is passive read-out (role="status") and never
   * takes focus itself, unlike the dossier's own Escape handling. */
  function onBreakdownKeydown(e) {
    if (e.key === 'Escape') hideClusterBreakdown();
  }

  /**
   * Show the one-line type breakdown for a cluster badge just clicked, for
   * example "126 sites: 87 megalith, 22 mound, 17 circle" - entries sorted
   * by count, descending, so the most common type reads first. `byType`
   * comes straight from `clusters.js`'s `clusterSweep` (see rendering.js's
   * `getCluster`), already filtered by whatever era band and type chips are
   * currently active, so this always describes exactly what the badge's own
   * count represents, never a stale or unfiltered total.
   * @param {{count:number, byType?: Object<string,number>}} cluster
   */
  function showClusterBreakdown(cluster) {
    if (!breakdownPlate) return;
    const entries = Object.entries(cluster.byType || {}).sort(
      (a, b) => b[1] - a[1],
    );
    const parts = entries.map(([type, count]) => `${count} ${type}`).join(', ');
    const total = cluster.count;
    const noun = total === 1 ? 'site' : 'sites';
    breakdownPlate.textContent = `${total} ${noun}: ${parts || 'type unrecorded'}`;
    if (breakdownPlate.hidden) {
      breakdownPlate.hidden = false;
      document.addEventListener('keydown', onBreakdownKeydown);
    }
  }

  /** Hide the badge breakdown plate (camera settle, Escape, or teardown). */
  function hideClusterBreakdown() {
    if (!breakdownPlate || breakdownPlate.hidden) return;
    breakdownPlate.hidden = true;
    document.removeEventListener('keydown', onBreakdownKeydown);
  }

  /** Clicking a badge shows its type breakdown and flies the camera one band
   * closer, centred on it; the breakdown plate auto-dismisses once the
   * camera settles (or sooner, on Escape - see hideClusterBreakdown). */
  async function flyToCluster(index) {
    const cluster = renderer?.getCluster(index);
    if (!cluster || !viewer) return;
    showClusterBreakdown(cluster);
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
    hideClusterBreakdown();
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
      renderer = createAncientRenderer(viewer, {
        render,
        onSweepSinglesChange: syncSweepLabels,
      });
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
      // Mirror of the dispatch in showDossier: the anomalies dossier opening
      // closes this one, so the two plates never stack.
      onOtherDossierOpen = (e) => {
        if (
          e.detail?.register !== ANCIENT_LAYER_ID &&
          dossier &&
          !dossier.hidden
        )
          dossier.hidden = true;
      };
      window.addEventListener(DOSSIER_OPEN_EVENT, onOtherDossierOpen);
      // The register's legend: a glyph key row naming all five sweep types
      // (task 1, ancient-legibility - the same glyphs the closest-band
      // billboards and the hero dossier already use, see glyphMap.js) plus
      // the deep-time dial's own honesty line. Created once, hidden until
      // the dial itself is showing (syncDeepTime toggles it alongside the
      // dial's own lifecycle): the glyph key sits in the same slot as the
      // dial for the same reason the dial itself yields to the sky
      // register's own chronometer when both layers are on (see
      // syncDeepTime's doc comment) - one shared top-left legend slot,
      // arbitrated the same way throughout this register.
      legend = document.createElement('div');
      legend.className = 'uap-legend ancient';
      legend.hidden = true;
      // Each glyph is a CSS mask (not an <img src>): the shipped SVGs use
      // `fill="currentColor"`, which resolves to black - not this element's
      // own CSS colour - when loaded as an external image resource, so a
      // plain <img> would render a near-invisible black icon on this dark
      // plate. A mask-image keeps the actual glyph colour under CSS control
      // (gold here) with no extra fetch or canvas work.
      legend.innerHTML = `
        <ul class="uap-glyph-key">
          ${SWEEP_TYPES.map((type) => {
            const url = escapeHtml(glyphUrlForType(type));
            return `<li><i class="uap-glyph-icon" style="-webkit-mask-image:url('${url}');mask-image:url('${url}')"></i>${escapeHtml(sweepTypeLabel(type))}</li>`;
          }).join('')}
        </ul>
        <p>${escapeHtml(DEEP_TIME_HONESTY_LINE)}</p>
        <p>${escapeHtml(TYPE_FILTER_HERO_HINT)}</p>`;
      host.appendChild(legend);
      // Badge breakdown plate (task 2, ancient-legibility): a passive,
      // read-only one-liner (role="status", not a dialog - it never takes
      // focus), so Escape dismissing it is handled by a document-level
      // keydown listener added only while it is showing (see
      // showClusterBreakdown/hideClusterBreakdown below), not a listener on
      // the plate itself.
      breakdownPlate = document.createElement('p');
      breakdownPlate.className = 'uap-cluster-breakdown ancient';
      breakdownPlate.hidden = true;
      breakdownPlate.setAttribute('role', 'status');
      breakdownPlate.setAttribute('aria-live', 'polite');
      host.appendChild(breakdownPlate);
      overlayHost?.setVisible?.(ANCIENT_LAYER_ID, false);
      // Ambient sweep-name labels (task 3, ancient-legibility): the sibling
      // overlay source shares the hero source's off-until-enabled lifecycle
      // (see enable/disable/destroy below).
      overlayHost?.setVisible?.(ANCIENT_SWEEP_OVERLAY_SOURCE_ID, false);
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
      overlayHost?.setVisible?.(ANCIENT_SWEEP_OVERLAY_SOURCE_ID, true);
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
      hideClusterBreakdown();
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
      overlayHost?.setVisible?.(ANCIENT_SWEEP_OVERLAY_SOURCE_ID, false);
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
        // Hero overlay labels: syncEraState() sets the renderer's heroes and
        // their labels together, filtered by the deep-time dial's era band
        // when it is engaged, or the full hero tier when it is not - exactly
        // the set this call used to pass unconditionally before the
        // deep-time dial existed. The sweep itself is still far too dense
        // for an unconditional ambient-label lane - its cluster badges carry
        // their own Cesium-native count text instead (see rendering.js) -
        // but its closest-band singles get their own, separate ambient
        // sweep-name labels (task 3, ancient-legibility) whenever there are
        // few enough on screen to add legibility rather than clutter: see
        // `syncSweepLabels`, wired as the renderer's own
        // `onSweepSinglesChange` callback above, which reacts to the
        // renderer's own recompute rather than this load callback.
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
      legend?.remove();
      legend = null;
      overlayHost?.clearSource?.(ANCIENT_LAYER_ID);
      overlayHost?.clearSource?.(ANCIENT_SWEEP_OVERLAY_SOURCE_ID);
      renderer?.destroy();
      if (onOtherDossierOpen)
        window.removeEventListener(DOSSIER_OPEN_EVENT, onOtherDossierOpen);
      onOtherDossierOpen = null;
      dossier?.remove();
      hideClusterBreakdown();
      breakdownPlate?.remove();
      renderer = null;
      dossier = null;
      breakdownPlate = null;
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

    /**
     * Search hook (task 3, atlas-instruments): fly to a worldwide-sweep
     * site by its index into the loaded sweep and open its compact
     * dossier, mirroring `focusSite` above but for a sweep row (addressed
     * by index, the same id the pick path already uses - see
     * `handlePick`'s own `picked.index`) rather than a hero (addressed by
     * id).
     */
    async focusSweep(index) {
      if (
        !sweepAccessor ||
        !viewer ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= sweepAccessor.length
      )
        return;
      const lat = sweepAccessor.lat(index);
      const lon = sweepAccessor.lon(index);
      await new Promise((resolve) =>
        viewer.camera.flyToBoundingSphere(
          new Cesium.BoundingSphere(
            Cesium.Cartesian3.fromDegrees(lon, lat, 0),
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
      openSweepDossier(index);
    },
  };
  return layer;
}
