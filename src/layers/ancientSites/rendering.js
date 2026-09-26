import * as Cesium from 'cesium';
import { GOLD } from './model.js';
import {
  clusterSweep,
  cellDegForHeight,
  nextBandTargetHeight,
  wrapLon,
  SKYWARD_FALLBACK_CELL_DEG,
} from './clusters.js';
import { sweepTypeInEraBand } from './eras.js';

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

/**
 * Owns every Cesium primitive for the ancient register.
 *
 * The curated hero tier renders exactly as before: one static gold point per
 * site, unclustered. The worldwide sweep (~81k sites) never becomes ~81k
 * primitives — it renders through camera-height-banded grid clustering
 * (`clusters.js`, portable): coarse grid badges (a larger gold point plus a
 * `LabelCollection` count) at world/continent/country zoom, individual
 * "singles" gold points for cells holding exactly one site, and — below the
 * closest clustering band — unclustered singles bounded to the current view
 * rectangle instead of the whole sweep.
 *
 * A local-only Modern Antiquarian register (`tmaLocal.js`) can add a third,
 * much smaller point set, gold like the rest, gated behind
 * `LOCAL_TMA_ENABLED` above so it renders as one-shot unclustered points
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
  const clusterPoints = scene.primitives.add(
    new Cesium.PointPrimitiveCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    }),
  );
  const clusterLabels = scene.primitives.add(new Cesium.LabelCollection());
  heroPoints.show = false;
  sweepPoints.show = false;
  clusterPoints.show = false;
  clusterLabels.show = false;
  // Local-only Modern Antiquarian register (see LOCAL_TMA_ENABLED above): a
  // flag-off build never allocates this collection.
  let tmaPoints = null;
  if (LOCAL_TMA_ENABLED) {
    tmaPoints = scene.primitives.add(
      new Cesium.PointPrimitiveCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      }),
    );
    tmaPoints.show = false;
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

  const requestFrame = (reason) =>
    render ? render.governorRequestRender(reason) : scene.requestRender();

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

  function renderSweepPrimitives() {
    sweepPoints.removeAll();
    for (const single of currentSingles) {
      const i = single.index;
      sweepPoints.add({
        id: {
          id: `ancient:sweep:${i}`,
          ancientKind: 'sweep',
          ancientIndex: i,
        },
        position: Cesium.Cartesian3.fromDegrees(sweep.lon(i), sweep.lat(i), 0),
        pixelSize: 4,
        color: goldAlpha(0.55),
        outlineColor: goldAlpha(0.2),
        outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.3, 2.0e7, 0.6),
      });
    }
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

  function recomputeSweep() {
    if (!sweep) return;
    const height = cameraHeight();
    let cellDeg = cellDegForHeight(height);
    let bounds = null;
    if (cellDeg <= 0) {
      bounds = paddedViewBoundsDeg();
      // The closest band renders unclustered singles bounded to the current
      // view rectangle — but a camera pitched above the horizon (a routine
      // state at close range) has no view rectangle at all. Rendering every
      // ~81k sweep site in that case would defeat the whole point of banding
      // by camera height. Step up to the finest whole-world-clustering band
      // instead: every band coarser than "closest" clusters the entire
      // sweep with no bounds needed (already proven bounded and cheap — see
      // the task report's perf numbers), so it is a safe, always-available
      // fallback. This mirrors the FIRMS renderer's own sky/horizon handling
      // (`aggregateFires`/`renderDetections` in
      // `src/layers/firms/rendering.js`), which never renders its unbounded
      // dataset when `bounds` is null either — it falls back to a still
      // -bounded, globally-ranked selection instead. The sweep has no
      // ranking signal to take a "top N" from, so a coarser grid is the
      // cleaner bounded fallback here, not a fabricated ranking.
      if (!bounds) cellDeg = SKYWARD_FALLBACK_CELL_DEG;
    }
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

  function setSweep(accessor) {
    sweep = accessor;
    if (visible) recomputeSweep();
  }

  /**
   * Set or clear the deep-time dial's era band: `{ bceValue, mode }` or
   * null to disengage (every sweep site shows again). Triggers one
   * recompute so the sweep re-clusters against the new band immediately;
   * a no-op while the register is not visible, mirroring `setSweep`.
   */
  function setEraFilter(band) {
    eraBand = band;
    if (visible) recomputeSweep();
  }

  /**
   * Render the local-only Modern Antiquarian rows as one-shot, unclustered
   * gold points: no camera-height banding of its own (the register is small
   * enough, ~17k rows, that plain points are cheap, and it is a dev-only
   * owner convenience, not a shipped register). Measured rather than
   * assumed (phase 5b task 4 fix report): 17,388 points cost ~8.7ms to
   * batch-build once on load, and add no measurable per-frame render cost
   * at world zoom (scene.render() sampled over 60 calls: ~0.015ms mean with
   * the register on vs ~0.012ms off, both effectively noise), comfortably
   * inside a single frame budget either way, so folding this small a
   * register through the sweep's clustering path would add complexity
   * without a performance reason. A flag-off build never reaches past the
   * guard below, so this is the only place TMA point data or its `tma`
   * pick kind ever exists.
   */
  function setTma(rows) {
    if (!LOCAL_TMA_ENABLED || !tmaPoints) return;
    tmaPoints.removeAll();
    for (const r of rows) {
      tmaPoints.add({
        id: { id: r.id, ancientKind: 'tma', tmaId: r.id },
        position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 0),
        pixelSize: 3,
        color: goldAlpha(0.5),
        outlineColor: goldAlpha(0.2),
        outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.2, 2.0e7, 0.5),
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
    // recomputeSweep() runs (see apply()) — otherwise the first postRender
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
    clusterPoints.show = next;
    clusterLabels.show = next;
    if (tmaPoints) tmaPoints.show = next;
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
      singleCount: sweepPoints.length,
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
    scene.primitives.remove(heroPoints);
    scene.primitives.remove(sweepPoints);
    scene.primitives.remove(clusterPoints);
    scene.primitives.remove(clusterLabels);
    if (tmaPoints) scene.primitives.remove(tmaPoints);
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
