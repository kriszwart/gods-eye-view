/**
 * Portable maths for the observatory plate: bucketing sky-report years into
 * decades for the small histogram. No Cesium, no browser globals, so this
 * stays unit testable and reusable from any shell (mirrors src/spotter/
 * rank.js's own "portable maths behind a DOM shell" split).
 */

/**
 * Bucket a list of years into decades (1937 becomes 1930, 2026 becomes
 * 2020). Non-finite or missing entries are skipped rather than thrown on,
 * since the caller's fetch may hand back a partial or empty list on a slow
 * or failed load.
 * @param {Array<number>} years
 * @returns {Array<{decade: number, count: number}>} One entry per decade
 *   that has at least one year, sorted ascending by decade. Never includes
 *   empty decades: a caller wanting a continuous axis fills gaps itself.
 */
export function decadeBuckets(years) {
  const counts = new Map();
  for (const year of Array.isArray(years) ? years : []) {
    if (!Number.isFinite(year)) continue;
    const decade = Math.floor(year / 10) * 10;
    counts.set(decade, (counts.get(decade) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([decade, count]) => ({ decade, count }));
}
