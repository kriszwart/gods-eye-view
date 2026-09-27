import * as Cesium from 'cesium';
import { GOLD } from './model.js';
import {
  clusterSweep,
  cellDegForHeight,
  nextBandTargetHeight,
  wrapLon,
  SKYWARD_FALLBACK_CELL_DEG,
  CAMERA_BANDS,
} from './clusters.js';
import { sweepTypeInEraBand } from './eras.js';
import {
  SWEEP_TYPES,
  glyphUrlForType,
  glyphUrlForTmaCategory,
} from './glyphMap.js';

/**
 * Local-only Modern Antiquarian overlay (see tmaLocal.js): every reference
 * to it below sits behind this constant, folded to a literal `false` by
 * `import.meta.env.PHENOMENA_LOCAL_TMA`'s build-time define when the flag
 * is unset, so a production build can prove the whole register (its
 * primitive collection, its pick branch, its point data) dead and drop it.
 * Strict `=== '1'` (rather than a plain truthy check) so
 * `PHENOMENA_LOCAL_TMA=0` stays off.
 */
const LOCAL_TMA_ENABLED = import.meta.env?.PHENOMENA_LOCAL_TMA === '1';

/** Throttle for the camera-height-band sweep recompute (postRender fires at
 * up to render cadence during camera motion; this bounds how often the ~81k
 * row scan actually runs). */
const SWEEP_RECOMPUTE_THROTTLE_MS = 250;
/** Extra margin (fraction of the view rectangle's own size) added around the
 * current view when the closest band renders unclustered singles, so a small
 * pan does not immediately pop sites in/out at the screen edge. */
const CLOSE_BAND_VIEW_PADDING = 0.3;

const gold = () => Cesium.Color.fromCssColorString(GOLD);
const goldAlpha = (alpha) => gold().withAlpha(alpha);

/** `count >= 1000` compacts to e.g. "1.2k" so the badge stays narrow. */
function formatClusterCount(count) {
  return count >= 1000 ? `${Math.round(count / 100) / 10}k` : String(count);
}

/** Close-range single markers (task 1, ancient-legibility): each renders as
 * a small composed image (a dark halo ring behind the type's gold glyph)
 * rather than a bare point, so a single reads against any terrain and its
 * type is legible without opening the dossier. `BILLBOARD_CANVAS_DIM` is the
 * raster size the composed image is drawn at (higher than the on-screen
 * size, for crispness on high-DPI screens); `BILLBOARD_DISPLAY_PX` is the
 * billboard's actual on-screen size, "roughly 20 px" per the task brief. */
const BILLBOARD_CANVAS_DIM = 40;
const BILLBOARD_DISPLAY_PX = 20;
/** Dark halo fill, matching the plate background other atlas panels already
 * use (`--uap-void` at the same alpha as `.uap-legend`'s own background). */
const BILLBOARD_HALO_FILL = 'rgba(7, 8, 18, 0.72)';
/** A faint gold ring around the halo gives the disc a defined edge without
 * competing with the glyph itself. */
const BILLBOARD_HALO_STROKE = 'rgba(216, 179, 106, 0.55)';

/**
 * Load an image element from a URL (used for the glyph SVGs under
 * public/ancient-sites/glyphs/). Rejects on load failure rather than
 * resolving a broken image, so a caller's `.catch` sees a real error.
 * @param {string} url
 * @returns {Promise<HTMLImageElement>}
 */
function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error(`Failed to load glyph image: ${url}`));
    image.src = url;
  });
}

/**
 * Recolour a monochrome glyph image to gold via canvas compositing: draw the
 * source image (the shipped glyphs use `fill="currentColor"`, which resolves
 * to black when loaded standalone as an `<img>`), then `source-in` composite
 * a solid gold fill so only the glyph's own opaque pixels - and their
 * anti-aliased edges - take the gold colour, leaving transparent areas
 * untouched.
 * @param {HTMLImageElement} image
 * @returns {HTMLCanvasElement}
 */
function recolorGlyphGold(image) {
  const width = image.naturalWidth || image.width || BILLBOARD_CANVAS_DIM;
  const height = image.naturalHeight || image.height || BILLBOARD_CANVAS_DIM;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.drawImage(image, 0, 0, width, height);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = GOLD;
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

/**
 * Compose one billboard image: a dark halo ring behind the gold-recoloured
 * glyph, centred, at `BILLBOARD_CANVAS_DIM`. Built once per distinct glyph
 * URL (see `requestBillboardGlyph`'s cache below) and reused for every
 * billboard of that type - never rebuilt per site.
 * @param {HTMLImageElement} glyphImage - Already-loaded glyph image (black on transparent).
 * @returns {HTMLCanvasElement}
 */
function composeGlyphBillboardCanvas(glyphImage) {
  const dim = BILLBOARD_CANVAS_DIM;
  const canvas = document.createElement('canvas');
  canvas.width = dim;
  canvas.height = dim;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const centre = dim / 2;
  ctx.beginPath();
  ctx.arc(centre, centre, centre - 2, 0, Math.PI * 2);
  ctx.fillStyle = BILLBOARD_HALO_FILL;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = BILLBOARD_HALO_STROKE;
  ctx.stroke();
  const glyphSize = dim * 0.6;
  const offset = (dim - glyphSize) / 2;
  ctx.drawImage(
    recolorGlyphGold(glyphImage),
    offset,
    offset,
    glyphSize,
    glyphSize,
  );
  return canvas;
}

/** Lazily-built halo-only placeholder (a small gold dot in the same dark
 * halo ring) shown for the brief window - if any - between a billboard's
 * first request and its real glyph finishing its (tiny, same-origin, local)
 * fetch. Built once, shared by every type until its own glyph is ready. */
let fallbackGlyphCanvasEl = null;
function fallbackGlyphCanvas() {
  if (fallbackGlyphCanvasEl) return fallbackGlyphCanvasEl;
  const dim = BILLBOARD_CANVAS_DIM;
  const canvas = document.createElement('canvas');
  canvas.width = dim;
  canvas.height = dim;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const centre = dim / 2;
    ctx.beginPath();
    ctx.arc(centre, centre, centre - 2, 0, Math.PI * 2);
    ctx.fillStyle = BILLBOARD_HALO_FILL;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(centre, centre, dim * 0.18, 0, Math.PI * 2);
    ctx.fillStyle = GOLD;
    ctx.fill();
  }
  fallbackGlyphCanvasEl = canvas;
  return fallbackGlyphCanvasEl;
}

/** Composed billboard images, cached per glyph URL (module scope: shared
 * across every renderer instance and every enable/disable cycle, since the
 * shipped glyph SVGs never change while the app is running - "cache per
 * type, never per site"). `billboardGlyphLoading` guards against firing a
 * second fetch for a URL that is already in flight; `billboardGlyphSubscribers`
 * are notified once a fetch settles, so an active renderer can redraw its
 * currently-visible billboards from a placeholder to the real glyph. */
const billboardGlyphCache = new Map();
const billboardGlyphLoading = new Set();
const billboardGlyphSubscribers = new Set();

/**
 * The cached composed billboard image for a glyph URL, kicking off a load if
 * this is the first request for it. Returns `null` (caller should use
 * `fallbackGlyphCanvas()` meanwhile) until the load and compose finish.
 * @param {string} url
 * @returns {HTMLCanvasElement|null}
 */
function requestBillboardGlyph(url) {
  const ready = billboardGlyphCache.get(url);
  if (ready) return ready;
  if (!billboardGlyphLoading.has(url)) {
    billboardGlyphLoading.add(url);
    loadImageElement(url)
      .then((image) => {
        billboardGlyphCache.set(url, composeGlyphBillboardCanvas(image));
      })
      .catch((error) => {
        console.warn(
          '[Data:AncientSites] Glyph billboard failed to load:',
          url,
          error,
        );
      })
      .finally(() => {
        billboardGlyphLoading.delete(url);
        for (const notify of billboardGlyphSubscribers) notify();
      });
  }
  return null;
}

/** The mid-band single-point style ramps between the coarsest camera band's
 * `cellDeg` and the closest non-billboard band's `cellDeg` (also the
 * skyward fallback's own resolution - see `SKYWARD_FALLBACK_CELL_DEG`). */
const MID_BAND_FAR_CELL_DEG = CAMERA_BANDS[0].cellDeg;
const MID_BAND_NEAR_CELL_DEG = SKYWARD_FALLBACK_CELL_DEG;

/**
 * Point size and alpha for the sweep's unclustered singles at every camera
 * band except the closest one (which renders billboards instead - see
 * `renderSweepSingles`): a linear ramp from a faint 4px/0.55-alpha dot at the
 * coarsest band up to a clearer 6px/0.8-alpha dot just above the billboard
 * transition, so stepping into billboards is not the only legibility change
 * on the way in (task 1, ancient-legibility: a flat 4px/0.55 dot at every
 * non-close band read as barely-there against terrain).
 * @param {number} cellDeg - The clustering grid resolution currently in use.
 * @returns {{size: number, alpha: number}}
 */
function midBandSingleStyle(cellDeg) {
  const t = Cesium.Math.clamp(
    (MID_BAND_FAR_CELL_DEG - cellDeg) /
      (MID_BAND_FAR_CELL_DEG - MID_BAND_NEAR_CELL_DEG),
    0,
    1,
  );
  return { size: 4 + t * 2, alpha: 0.55 + t * 0.25 };
}

/**
 * Owns every Cesium primitive for the ancient register.
 *
 * The curated hero tier renders exactly as before: one static gold point per
 * site, unclustered. The worldwide sweep (~81k sites) never becomes ~81k
 * primitives: it renders through camera-height-banded grid clustering
 * (`clusters.js`, portable): coarse grid badges (a larger gold point plus a
 * `LabelCollection` count) at world/continent/country zoom, individual
 * "singles" for cells holding exactly one site - a gold point at every band
 * except the closest, and, below the closest clustering band, a gold-glyph
 * billboard (dark halo ring plus the site's type glyph, see `glyphMap.js`
 * and the billboard-compositing helpers above) bounded to the current view
 * rectangle instead of the whole sweep (task 1, ancient-legibility: the bare
 * 4px/0.55-alpha dot the closest band used to render was unreadable against
 * varied terrain, and gave no way to tell sweep types apart).
 *
 * A local-only Modern Antiquarian register (`tmaLocal.js`) can add a third,
 * much smaller billboard set, gold like the rest, gated behind
 * `LOCAL_TMA_ENABLED` above so it renders as one-shot unclustered billboards
 * with no camera-height banding of its own and, when the flag is off,
 * carries no primitives, pick branch or data into the build at all.
 *
 * The sweep recompute is postRender-throttled and refreshed again on
 * `moveEnd` (mirroring the FIRMS layer's LOD watcher): no continuous render
 * hold, and no per-frame work while the camera is parked.
 */
export function createAncientRenderer(viewer, { render } = {}) {
  const scene = viewer.scene;
  const heroPoints = scene.primitives.add(
    new Cesium.PointPrimitiveCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    }),
  );
  const sweepPoints = scene.primitives.add(
    new Cesium.PointPrimitiveCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    }),
  );
  // Closest-band singles only (see recomputeSweep/renderSweepPrimitives):
  // gold-glyph-plus-halo billboards, never populated at the same time as
  // sweepPoints above.
  const sweepBillboards = scene.primitives.add(
    new Cesium.BillboardCollection({
      scene,
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    }),
  );
  const clusterPoints = scene.primitives.add(
    new Cesium.PointPrimitiveCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    }),
  );
  const clusterLabels = scene.primitives.add(new Cesium.LabelCollection());
  heroPoints.show = false;
  sweepPoints.show = false;
  sweepBillboards.show = false;
  clusterPoints.show = false;
  clusterLabels.show = false;
  // Local-only Modern Antiquarian register (see LOCAL_TMA_ENABLED above): a
  // flag-off build never allocates this collection.
  let tmaBillboards = null;
  if (LOCAL_TMA_ENABLED) {
    tmaBillboards = scene.primitives.add(
      new Cesium.BillboardCollection({
        scene,
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      }),
    );
    tmaBillboards.show = false;
  }

  let sweep = null;
  let visible = false;
  let currentClusters = [];
  let currentSingles = [];
  let currentCellDeg = null;
  // The deep-time dial's current era band (see eras.js), or null when the
  // dial is not engaged (either register default: every sweep site shows,
  // exactly as before the deep-time dial existed).
  let eraBand = null;
  let bandRemover = null;
  let moveEndRemover = null;
  let moveEndSettleTimer = null;
  let lastRecomputeAt = 0;
  // The inputs the last successful recomputeSweep() actually clustered
  // against (see recomputeSweep's own nothing-changed guard below).
  // `undefined` sentinels so the very first call always proceeds.
  let lastRecomputeSweep;
  let lastRecomputeCellDeg;
  let lastRecomputeBoundsKey;
  let lastRecomputeEraKey;

  const requestFrame = (reason) =>
    render ? render.governorRequestRender(reason) : scene.requestRender();

  // Glyph billboards load asynchronously (see requestBillboardGlyph above),
  // though kicking off every type's load at creation time below means this
  // almost never has visible work left to do by the time a user actually
  // reaches the closest band. When a glyph does finish loading after a
  // billboard was already drawn with the placeholder, redraw so it upgrades
  // to the real glyph without waiting for the next camera move.
  function onGlyphReady() {
    if (visible && sweep && currentCellDeg === 0) {
      renderSweepPrimitives();
      requestFrame('ancient-glyph-ready');
    }
  }
  billboardGlyphSubscribers.add(onGlyphReady);
  // Kick every sweep-type glyph's load off now, well before any camera could
  // plausibly reach the closest band.
  for (const type of SWEEP_TYPES) requestBillboardGlyph(glyphUrlForType(type));

  function cameraHeight() {
    return (
      viewer.camera?.positionCartographic?.height ?? Number.POSITIVE_INFINITY
    );
  }

  /** Current view rectangle padded outward, in degrees; null off-globe. */
  function paddedViewBoundsDeg() {
    let rect;
    try {
      rect = viewer.camera.computeViewRectangle(scene.globe.ellipsoid);
    } catch {
      return null;
    }
    if (!rect) return null;
    const widthRad = Cesium.Rectangle.computeWidth(rect);
    const heightRad = Cesium.Rectangle.computeHeight(rect);
    const padRad = ((widthRad + heightRad) / 2) * CLOSE_BAND_VIEW_PADDING;
    return {
      west: wrapLon(Cesium.Math.toDegrees(rect.west - padRad)),
      south: Math.max(-90, Cesium.Math.toDegrees(rect.south - padRad)),
      east: wrapLon(Cesium.Math.toDegrees(rect.east + padRad)),
      north: Math.min(90, Cesium.Math.toDegrees(rect.north + padRad)),
    };
  }

  function setHeroes(rows) {
    heroPoints.removeAll();
    for (const r of rows)
      heroPoints.add({
        id: { id: `ancient:${r.id}`, ancientKind: 'hero', ancientId: r.id },
        position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 0),
        pixelSize: 7,
        color: goldAlpha(0.9),
        outlineColor: goldAlpha(0.35),
        outlineWidth: 2,
        scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.5, 2.0e7, 0.8),
      });
    requestFrame('ancient-heroes');
  }

  /**
   * Render the sweep's current unclustered singles: gold-glyph billboards at
   * the closest band (`currentCellDeg === 0`, the view-bounded path - see
   * recomputeSweep), plain gold points everywhere else. Never both at once:
   * whichever collection does not apply for the current band is cleared.
   */
  function renderSweepSingles() {
    sweepPoints.removeAll();
    sweepBillboards.removeAll();
    const closeBand = currentCellDeg === 0;
    if (closeBand) {
      for (const single of currentSingles) {
        const i = single.index;
        const url = glyphUrlForType(sweep.typeName(i));
        sweepBillboards.add({
          id: {
            id: `ancient:sweep:${i}`,
            ancientKind: 'sweep',
            ancientIndex: i,
          },
          position: Cesium.Cartesian3.fromDegrees(
            sweep.lon(i),
            sweep.lat(i),
            0,
          ),
          image: requestBillboardGlyph(url) || fallbackGlyphCanvas(),
          imageId: url,
          width: BILLBOARD_DISPLAY_PX,
          height: BILLBOARD_DISPLAY_PX,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          // Ground-level billboards depth-test against the globe/terrain by
          // default, unlike the plain points this replaces at close range:
          // at a few tens of km altitude looking straight down, that reads
          // as an intermittent depth-precision miss against the ellipsoid
          // surface right underneath the billboard's own anchor point - not
          // a visible z-fighting flicker, but the billboard failing to pick
          // at all despite rendering and sitting at the right screen
          // position (reproduced with a minimal, unrelated billboard at the
          // same camera height and pitch; matches FIRMS's own billboards,
          // src/layers/firms/rendering.js, which set this for the same
          // reason).
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
      }
      return;
    }
    const { size, alpha } = midBandSingleStyle(currentCellDeg);
    for (const single of currentSingles) {
      const i = single.index;
      sweepPoints.add({
        id: {
          id: `ancient:sweep:${i}`,
          ancientKind: 'sweep',
          ancientIndex: i,
        },
        position: Cesium.Cartesian3.fromDegrees(sweep.lon(i), sweep.lat(i), 0),
        pixelSize: size,
        color: goldAlpha(alpha),
        outlineColor: goldAlpha(alpha * 0.36),
        outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.3, 2.0e7, 0.6),
      });
    }
  }

  function renderSweepPrimitives() {
    renderSweepSingles();
    clusterPoints.removeAll();
    clusterLabels.removeAll();
    currentClusters.forEach((cluster, index) => {
      const position = Cesium.Cartesian3.fromDegrees(
        cluster.lon,
        cluster.lat,
        0,
      );
      const id = {
        id: `ancient-cluster:${index}`,
        ancientKind: 'cluster',
        clusterIndex: index,
      };
      clusterPoints.add({
        id,
        position,
        pixelSize: 14,
        color: goldAlpha(0.85),
        outlineColor: goldAlpha(0.4),
        outlineWidth: 2,
        scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.4, 3.0e7, 0.7),
      });
      clusterLabels.add({
        id,
        position,
        text: formatClusterCount(cluster.count),
        font: 'bold 12px "Martian Mono", "JetBrains Mono", monospace',
        fillColor: Cesium.Color.fromCssColorString('#070812'),
        outlineColor: gold(),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.2, 3.0e7, 0.6),
      });
    });
    requestFrame('ancient-sweep');
  }

  /** Stable string key for a bounds rectangle (or its absence), for the
   * nothing-changed guard below; not for geometry. */
  function boundsKeyOf(bounds) {
    return bounds
      ? `${bounds.west.toFixed(3)},${bounds.south.toFixed(3)},${bounds.east.toFixed(3)},${bounds.north.toFixed(3)}`
      : null;
  }

  /** Stable string key for an era band (or its absence), for the
   * nothing-changed guard below. */
  function eraKeyOf(band) {
    return band ? `${band.mode}:${band.bceValue}` : null;
  }

  function recomputeSweep() {
    if (!sweep) return;
    const height = cameraHeight();
    let cellDeg = cellDegForHeight(height);
    let bounds = null;
    if (cellDeg <= 0) {
      bounds = paddedViewBoundsDeg();
      // The closest band renders unclustered singles bounded to the current
      // view rectangle, but a camera pitched above the horizon (a routine
      // state at close range) has no view rectangle at all. Rendering every
      // ~81k sweep site in that case would defeat the whole point of banding
      // by camera height. Step up to the finest whole-world-clustering band
      // instead: every band coarser than "closest" clusters the entire
      // sweep with no bounds needed (already proven bounded and cheap, see
      // the task report's perf numbers), so it is a safe, always-available
      // fallback. This mirrors the FIRMS renderer's own sky/horizon handling
      // (`aggregateFires`/`renderDetections` in
      // `src/layers/firms/rendering.js`), which never renders its unbounded
      // dataset when `bounds` is null either: it falls back to a still
      // -bounded, globally-ranked selection instead. The sweep has no
      // ranking signal to take a "top N" from, so a coarser grid is the
      // cleaner bounded fallback here, not a fabricated ranking.
      if (!bounds) cellDeg = SKYWARD_FALLBACK_CELL_DEG;
    }
    const boundsKey = boundsKeyOf(bounds);
    const eraKey = eraKeyOf(eraBand);
    // No per-frame work while the camera is parked: a postRender tick (or a
    // throttled era-filter request, see requestSweepRecompute below) whose
    // camera-height band, view rectangle and era band are all identical to
    // the last successful recompute has nothing new to cluster, so it skips
    // straight past the ~81k-row scan and the primitive rebuild. Without
    // this, another layer holding continuous render (sky hero craft) with
    // the camera parked reruns an unchanged recompute every throttle window
    // forever.
    if (
      sweep === lastRecomputeSweep &&
      cellDeg === lastRecomputeCellDeg &&
      boundsKey === lastRecomputeBoundsKey &&
      eraKey === lastRecomputeEraKey
    ) {
      return;
    }
    lastRecomputeSweep = sweep;
    lastRecomputeCellDeg = cellDeg;
    lastRecomputeBoundsKey = boundsKey;
    lastRecomputeEraKey = eraKey;
    // The deep-time dial's era band, applied upstream of clustering (see
    // eras.js): only sites whose TYPE's typological window matches the
    // dial's current position ever reach a bucket or a single, so a
    // cluster badge's count already reflects the filtered total. `null`
    // (the dial disengaged) filters nothing, exactly as before the
    // deep-time dial existed.
    const filter = eraBand
      ? (i) =>
          sweepTypeInEraBand(sweep.typeName(i), eraBand.bceValue, eraBand.mode)
      : null;
    const { clusters, singles } = clusterSweep(sweep, {
      cellDeg,
      bounds,
      filter,
    });
    currentClusters = clusters;
    currentSingles = singles;
    currentCellDeg = cellDeg;
    renderSweepPrimitives();
  }

  /**
   * Recompute now if the throttle window has elapsed since the last one,
   * otherwise defer to the moveEnd-style settle timer (`scheduleRecompute`)
   * so a flood of requests inside the same window - dragging the era dial,
   * same as panning the camera - collapses into at most one settle
   * recompute rather than one per pointer event. A no-op while the register
   * is not visible.
   */
  function requestSweepRecompute() {
    if (!visible) return;
    const now = performance.now();
    if (now - lastRecomputeAt < SWEEP_RECOMPUTE_THROTTLE_MS) {
      scheduleRecompute();
      return;
    }
    lastRecomputeAt = now;
    recomputeSweep();
  }

  function setSweep(accessor) {
    sweep = accessor;
    if (visible) recomputeSweep();
  }

  /**
   * Set or clear the deep-time dial's era band: `{ bceValue, mode }` or
   * null to disengage (every sweep site shows again). Routes its recompute
   * through the same throttle/settle machinery as camera motion (see
   * `requestSweepRecompute`), so pointer-dragging the dial does not run the
   * ~81k-row scan at pointermove cadence; a no-op while the register is not
   * visible, mirroring `setSweep`.
   */
  function setEraFilter(band) {
    eraBand = band;
    requestSweepRecompute();
  }

  /**
   * Render the local-only Modern Antiquarian rows as one-shot, unclustered
   * gold-glyph billboards: no camera-height banding of its own (the register
   * is small enough, ~17k rows, that this is cheap, and it is a dev-only
   * owner convenience, not a shipped register). Each row's free-text
   * `category` maps to the nearest sweep type (`glyphUrlForTmaCategory`, see
   * glyphMap.js), so it gets the same glyph-plus-halo treatment as the
   * sweep's own closest-band singles (task 1, ancient-legibility). Point
   * -based cost was measured previously (phase 5b task 4 fix report:
   * 17,388 points, ~8.7ms one-off build, no measurable per-frame cost); the
   * billboard replacement reuses the same five cached glyph images the
   * sweep already loads (see requestBillboardGlyph above), so it adds no
   * further network cost and a comparable one-off build cost, not
   * separately re-measured here. A flag-off build never reaches past the
   * guard below, so this is the only place TMA data or its `tma` pick kind
   * ever exists.
   */
  function setTma(rows) {
    if (!LOCAL_TMA_ENABLED || !tmaBillboards) return;
    tmaBillboards.removeAll();
    for (const r of rows) {
      const url = glyphUrlForTmaCategory(r.category);
      tmaBillboards.add({
        id: { id: r.id, ancientKind: 'tma', tmaId: r.id },
        position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 0),
        image: requestBillboardGlyph(url) || fallbackGlyphCanvas(),
        imageId: url,
        width: BILLBOARD_DISPLAY_PX,
        height: BILLBOARD_DISPLAY_PX,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        // See the matching comment on the sweep billboard add above.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    requestFrame('ancient-tma');
  }

  function scheduleRecompute() {
    clearTimeout(moveEndSettleTimer);
    moveEndSettleTimer = setTimeout(() => {
      // Same throttle variable the postRender watcher below reads: without
      // this, the very next postRender tick after a settle recompute sees a
      // stale lastRecomputeAt and immediately fires a redundant second one.
      lastRecomputeAt = performance.now();
      recomputeSweep();
    }, SWEEP_RECOMPUTE_THROTTLE_MS + 40);
  }

  function installBandWatcher() {
    if (bandRemover || !viewer) return;
    // Seed the throttle clock now, before the caller's own explicit
    // recomputeSweep() runs (see apply()): otherwise the first postRender
    // that follows sees a stale (zero) lastRecomputeAt, treats the throttle
    // window as already elapsed, and fires an immediate redundant second
    // recompute right after enable.
    lastRecomputeAt = performance.now();
    bandRemover = scene.postRender.addEventListener(() => {
      if (!visible) return;
      const now = performance.now();
      if (now - lastRecomputeAt < SWEEP_RECOMPUTE_THROTTLE_MS) return;
      lastRecomputeAt = now;
      recomputeSweep();
    });
    // A camera that settles inside the throttle window above would otherwise
    // wait for a postRender that idle mode may never produce again. Schedule
    // one settle recompute, mirroring the FIRMS LOD watcher's moveEnd seam.
    moveEndRemover = viewer.camera.moveEnd.addEventListener(() => {
      if (!visible) return;
      scheduleRecompute();
    });
  }

  function removeBandWatcher() {
    if (bandRemover) {
      bandRemover();
      bandRemover = null;
    }
    if (moveEndRemover) {
      moveEndRemover();
      moveEndRemover = null;
    }
    clearTimeout(moveEndSettleTimer);
    moveEndSettleTimer = null;
  }

  function apply({ visible: next }) {
    visible = next;
    heroPoints.show = next;
    sweepPoints.show = next;
    sweepBillboards.show = next;
    clusterPoints.show = next;
    clusterLabels.show = next;
    if (tmaBillboards) tmaBillboards.show = next;
    if (next) {
      installBandWatcher();
      recomputeSweep();
    } else {
      removeBandWatcher();
    }
    requestFrame('ancient-visibility');
  }

  function pick(windowPosition) {
    const picked = scene.pick(windowPosition);
    const id = picked?.id ?? picked?.primitive?.id;
    if (!id || typeof id !== 'object') return null;
    if (id.ancientKind === 'hero') return { kind: 'hero', id: id.ancientId };
    if (id.ancientKind === 'sweep')
      return { kind: 'sweep', index: id.ancientIndex };
    if (id.ancientKind === 'cluster')
      return { kind: 'cluster', index: id.clusterIndex };
    if (LOCAL_TMA_ENABLED && id.ancientKind === 'tma')
      return { kind: 'tma', id: id.tmaId };
    return null;
  }

  /** Cluster centroid for a "fly one band closer" click; null once stale. */
  function getCluster(index) {
    return currentClusters[index] ?? null;
  }

  function getDiagnostics() {
    let topCluster = null;
    let sweepVisibleCount = currentSingles.length;
    for (const cluster of currentClusters) {
      sweepVisibleCount += cluster.count;
      if (!topCluster || cluster.count > topCluster.count) topCluster = cluster;
    }
    return {
      heroCount: heroPoints.length,
      clusterCount: clusterPoints.length,
      // The logical count of unclustered singles the sweep currently
      // represents, regardless of which primitive collection actually draws
      // them (plain points at every band except the closest, gold-glyph
      // billboards at the closest one - see renderSweepSingles): this stays
      // meaningful across that switch, unlike reading either collection's
      // own `.length` directly (only one of the two is ever populated).
      singleCount: currentSingles.length,
      // The closest band's billboard primitive count specifically (0 at
      // every other band, since renderSweepSingles clears sweepBillboards
      // whenever it is not the closest band) - task 1's own qa gate checks
      // this stays bounded at close range over a dense area.
      billboardCount: sweepBillboards.length,
      // The true filtered sweep total currently represented on screen,
      // clustered or not - unlike clusterCount/singleCount (primitive
      // counts, which shrink as clustering coarsens), this is what the
      // deep-time dial's era band actually changes as it moves.
      sweepVisibleCount,
      cellDeg: currentCellDeg,
      cameraHeight: cameraHeight(),
      topCluster: topCluster
        ? { lat: topCluster.lat, lon: topCluster.lon, count: topCluster.count }
        : null,
    };
  }

  function destroy() {
    removeBandWatcher();
    billboardGlyphSubscribers.delete(onGlyphReady);
    scene.primitives.remove(heroPoints);
    scene.primitives.remove(sweepPoints);
    scene.primitives.remove(sweepBillboards);
    scene.primitives.remove(clusterPoints);
    scene.primitives.remove(clusterLabels);
    if (tmaBillboards) scene.primitives.remove(tmaBillboards);
  }

  const api = {
    setHeroes,
    setSweep,
    setEraFilter,
    apply,
    pick,
    getCluster,
    getDiagnostics,
    /** Camera height to fly toward for a "one band closer" cluster click. */
    nextBandTargetHeight: () => nextBandTargetHeight(cameraHeight()),
    destroy,
  };
  // Kept off the API surface entirely on a flag-off build, so no caller can
  // even name `setTma` there (see LOCAL_TMA_ENABLED above).
  if (LOCAL_TMA_ENABLED) api.setTma = setTma;
  return api;
}
