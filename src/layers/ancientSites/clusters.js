/**
 * Portable grid clustering over the ancient-sites v2 sweep accessor. No
 * rendering engine, no browser globals, so this stays unit-testable and
 * reusable from any renderer.
 */

/**
 * Camera-height bands (metres) driving both the clustering grid resolution
 * and "one band closer" cluster-click camera flights. Ordered widest first;
 * the first band whose `minHeight` the camera clears applies. `cellDeg` of 0
 * means "no grid clustering: every in-bounds site is its own single", which
 * only makes sense paired with a tight viewport `bounds`. `targetHeight` is
 * the representative height comfortably inside that band, used as the fly
 * target when a click on a coarser band's cluster brings the camera one band
 * in.
 */
export const CAMERA_BANDS = Object.freeze([
  Object.freeze({ minHeight: 8_000_000, cellDeg: 5, targetHeight: 12_000_000 }),
  Object.freeze({ minHeight: 2_000_000, cellDeg: 2, targetHeight: 4_000_000 }),
  Object.freeze({ minHeight: 500_000, cellDeg: 0.5, targetHeight: 1_000_000 }),
  Object.freeze({ minHeight: 0, cellDeg: 0, targetHeight: 150_000 }),
]);

/**
 * Whole-world clustering grid (degrees) a renderer can fall back to when the
 * closest band (`cellDeg === 0`, unclustered singles bounded to the current
 * view rectangle) has no view rectangle to bound against: the camera is
 * pitched above the horizon, a routine state at close range. Every band
 * coarser than the closest one clusters the *entire* sweep with no viewport
 * bound at all (see `clusterSweep`'s whole-world path), so it is already a
 * bounded, safe substitute: this is simply the finest of those bands, the
 * one immediately coarser than "closest". Mirrors the FIRMS renderer's own
 * sky/horizon handling (`aggregateFires`/`renderDetections` in
 * `src/layers/firms/rendering.js`), which never renders its full dataset
 * when `bounds` is null: it falls back to a still-bounded, globally-ranked
 * selection instead. The sweep has no ranking signal (no FRP-like score) to
 * take a "top N" from, so stepping up to the next coarser band's grid is the
 * bounded fallback that reads cleanest here, rather than inventing a ranking.
 */
export const SKYWARD_FALLBACK_CELL_DEG =
  CAMERA_BANDS[CAMERA_BANDS.length - 2].cellDeg;

function bandIndexForHeight(height) {
  const h = Number.isFinite(height) ? height : 0;
  const index = CAMERA_BANDS.findIndex((band) => h >= band.minHeight);
  return index === -1 ? CAMERA_BANDS.length - 1 : index;
}

/**
 * Grid resolution (degrees) to cluster the sweep at, for a camera height in
 * metres. 0 means the caller should skip grid clustering and render
 * in-viewport singles only.
 * @param {number} height - Camera height above the ellipsoid, in metres.
 * @returns {number}
 */
export function cellDegForHeight(height) {
  return CAMERA_BANDS[bandIndexForHeight(height)].cellDeg;
}

/**
 * Camera height (metres) to fly a "one band closer" cluster click toward.
 * Already at the closest band, this just zooms the camera in further rather
 * than picking a new band.
 * @param {number} height - Current camera height above the ellipsoid, in metres.
 * @returns {number}
 */
export function nextBandTargetHeight(height) {
  const h = Number.isFinite(height) ? height : 0;
  const currentIndex = bandIndexForHeight(h);
  if (currentIndex >= CAMERA_BANDS.length - 1) return Math.max(h * 0.5, 20_000);
  return CAMERA_BANDS[currentIndex + 1].targetHeight;
}

/** Wrap a longitude into [-180, 180). Exported for renderers that need to
 * normalise a padded view rectangle before passing it in as `bounds`. */
export function wrapLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** True when (lat, lon) falls inside bounds, handling antimeridian wraparound. */
function inBounds(lat, lon, bounds) {
  if (!bounds) return true;
  const { west, south, east, north } = bounds;
  if (lat < south || lat > north) return false;
  if (west <= east) return lon >= west && lon <= east;
  return lon >= west || lon <= east; // bounds straddle +/-180
}

/**
 * Grid-cluster the v2 sweep accessor into badges and singles.
 *
 * A cell holding more than one site collapses into one cluster entry
 * `{ lat, lon, count, sampleIndex }` (lat/lon are the cell's site centroid,
 * sampleIndex the first sweep index that landed in it); a cell holding
 * exactly one site becomes a `single` `{ index }` instead, so a lone site
 * never carries a misleading count badge. `cellDeg <= 0` disables grid
 * clustering: every in-bounds site is its own single (the caller should pair
 * this with a tight `bounds` (the current view rectangle) to keep the
 * result small at close camera range).
 *
 * `filter`, when given, is called with each candidate index and skips any
 * index it returns false for before that site ever reaches a bucket or a
 * single - the deep-time dial's era band (see `eras.js`'s
 * `sweepTypeInEraBand`) applies here, upstream of clustering, so a badge's
 * count only ever reflects sites the current era band actually includes.
 *
 * @param {{length:number, lat:(i:number)=>number, lon:(i:number)=>number}} sweep
 * @param {{cellDeg?: number, bounds?: {west:number,south:number,east:number,north:number}|null, filter?: ((index:number)=>boolean)|null}} [options]
 * @returns {{clusters: Array<{lat:number, lon:number, count:number, sampleIndex:number}>, singles: Array<{index:number}>}}
 */
export function clusterSweep(
  sweep,
  { cellDeg = 5, bounds = null, filter = null } = {},
) {
  const length = sweep?.length || 0;
  const clusters = [];
  const singles = [];
  if (!length) return { clusters, singles };
  const cell = Number(cellDeg) || 0;
  if (cell <= 0) {
    for (let i = 0; i < length; i += 1) {
      const lat = sweep.lat(i);
      const lon = sweep.lon(i);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (!inBounds(lat, lon, bounds)) continue;
      if (filter && !filter(i)) continue;
      singles.push({ index: i });
    }
    return { clusters, singles };
  }
  const buckets = new Map();
  for (let i = 0; i < length; i += 1) {
    const lat = sweep.lat(i);
    const lon = sweep.lon(i);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!inBounds(lat, lon, bounds)) continue;
    if (filter && !filter(i)) continue;
    const latIndex = Math.floor((lat + 90) / cell);
    const lonIndex = Math.floor((wrapLon(lon) + 180) / cell);
    const key = `${latIndex}:${lonIndex}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { sumLat: 0, sumLon: 0, count: 0, sampleIndex: i };
      buckets.set(key, bucket);
    }
    bucket.sumLat += lat;
    bucket.sumLon += lon;
    bucket.count += 1;
  }
  for (const bucket of buckets.values()) {
    if (bucket.count > 1) {
      clusters.push({
        lat: bucket.sumLat / bucket.count,
        lon: bucket.sumLon / bucket.count,
        count: bucket.count,
        sampleIndex: bucket.sampleIndex,
      });
    } else {
      singles.push({ index: bucket.sampleIndex });
    }
  }
  return { clusters, singles };
}
