/**
 * Pure hotspot maths for the anomaly atlas: bin reports onto an
 * equirectangular grid, smooth the grid with a separable box blur, and map
 * a bin's count to a display alpha. Portable: no rendering engine and no
 * browser globals, so this module satisfies the repository's
 * source-boundary checks and stays unit-testable.
 */

/** Default grid width in columns (one cell per half degree of longitude). */
const DEFAULT_WIDTH = 720;
/** Default grid height in rows (one cell per half degree of latitude). */
const DEFAULT_HEIGHT = 360;

/**
 * Bin rows onto an equirectangular grid. Longitude maps to columns west to
 * east and latitude maps to rows north to south (row 0 is the north pole).
 * Out-of-range coordinates clamp to the nearest edge cell rather than
 * throwing.
 * @param {Array<{ lat: number, lon: number }>} rows Anomaly rows, each
 *   carrying at least `lat` (-90..90) and `lon` (-180..180).
 * @param {{ width?: number, height?: number,
 *   filter?: (row: object) => boolean }} [options]
 * @returns {Float32Array} Counts per cell, row-major, length `width * height`.
 */
export function binRows(rows, options = {}) {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const filter = options.filter;
  const bins = new Float32Array(width * height);
  for (const row of rows) {
    if (filter && !filter(row)) continue;
    const x = clampIndex(Math.floor(((row.lon + 180) / 360) * width), width);
    const y = clampIndex(Math.floor(((90 - row.lat) / 180) * height), height);
    bins[y * width + x] += 1;
  }
  return bins;
}

const clampIndex = (index, size) => Math.min(size - 1, Math.max(0, index));

/**
 * Smooth a grid with a separable box blur (a horizontal pass then a
 * vertical pass), each pass averaging over `2 * radius + 1` cells with
 * edge cells clamped to the grid boundary. Conserves total mass.
 * @param {Float32Array} bins Row-major grid, length `width * height`.
 * @param {number} width
 * @param {number} height
 * @param {number} [radius] Blur radius in cells; 0 returns a copy unchanged.
 * @returns {Float32Array}
 */
export function blurBins(bins, width, height, radius = 2) {
  if (radius <= 0) return Float32Array.from(bins);
  const horizontal = boxBlurPass(bins, width, height, radius, true);
  return boxBlurPass(horizontal, width, height, radius, false);
}

/**
 * One pass of a box blur, along rows or along columns.
 * @param {Float32Array} src
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 * @param {boolean} alongRows `true` to blur each row horizontally, `false`
 *   to blur each column vertically.
 * @returns {Float32Array}
 */
function boxBlurPass(src, width, height, radius, alongRows) {
  const out = new Float32Array(width * height);
  const outer = alongRows ? height : width;
  const inner = alongRows ? width : height;
  const window = 2 * radius + 1;
  for (let o = 0; o < outer; o++) {
    for (let i = 0; i < inner; i++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = clampIndex(i + k, inner);
        const index = alongRows ? o * width + j : j * width + o;
        sum += src[index];
      }
      const index = alongRows ? o * width + i : i * width + o;
      out[index] = sum / window;
    }
  }
  return out;
}

/**
 * Map a bin's value to a display alpha with a soft knee: the ratio to
 * `max` is clamped to 0..1, then a square root curve lifts low values so
 * faint hotspots stay visible.
 * @param {number} value
 * @param {number} max
 * @returns {number} 0..1
 */
export function heatAlpha(value, max) {
  if (!(max > 0)) return 0;
  const ratio = Math.min(1, Math.max(0, value / max));
  return Math.sqrt(ratio);
}
