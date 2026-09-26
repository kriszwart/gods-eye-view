import * as Cesium from 'cesium';
import { GOLD } from './model.js';
import {
  clusterSweep,
  cellDegForHeight,
  nextBandTargetHeight,
  wrapLon,
} from './clusters.js';

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
 * The recompute is postRender-throttled and refreshed again on `moveEnd`
 * (mirroring the FIRMS layer's LOD watcher): no continuous render hold, and
 * no per-frame work while the camera is parked.
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

  let sweep = null;
  let visible = false;
  let currentClusters = [];
  let currentSingles = [];
  let currentCellDeg = null;
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
    const cellDeg = cellDegForHeight(height);
    const bounds = cellDeg > 0 ? null : paddedViewBoundsDeg();
    const { clusters, singles } = clusterSweep(sweep, { cellDeg, bounds });
    currentClusters = clusters;
    currentSingles = singles;
    currentCellDeg = cellDeg;
    renderSweepPrimitives();
  }

  function setSweep(accessor) {
    sweep = accessor;
    if (visible) recomputeSweep();
  }

  function scheduleRecompute() {
    clearTimeout(moveEndSettleTimer);
    moveEndSettleTimer = setTimeout(() => {
      recomputeSweep();
    }, SWEEP_RECOMPUTE_THROTTLE_MS + 40);
  }

  function installBandWatcher() {
    if (bandRemover || !viewer) return;
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
    return null;
  }

  /** Cluster centroid for a "fly one band closer" click; null once stale. */
  function getCluster(index) {
    return currentClusters[index] ?? null;
  }

  function getDiagnostics() {
    let topCluster = null;
    for (const cluster of currentClusters) {
      if (!topCluster || cluster.count > topCluster.count) topCluster = cluster;
    }
    return {
      heroCount: heroPoints.length,
      clusterCount: clusterPoints.length,
      singleCount: sweepPoints.length,
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
  }

  return {
    setHeroes,
    setSweep,
    apply,
    pick,
    getCluster,
    getDiagnostics,
    /** Camera height to fly toward for a "one band closer" cluster click. */
    nextBandTargetHeight: () => nextBandTargetHeight(cameraHeight()),
    destroy,
  };
}
