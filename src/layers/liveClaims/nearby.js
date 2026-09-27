/**
 * Nearby historical cases: portable distance maths (no Cesium, no browser
 * globals) linking one live claim to the bundled sky-register dataset, so a
 * claim's dossier can honestly say "N historical cases within 50 km"
 * without ever mutating the anomalies layer (see
 * docs/superpowers/specs/2026-09-27-live-claims-design.md, component 4).
 *
 * This module works over the anomalies layer's own DECODED rows, the shape
 * `src/layers/anomalies/records.js`'s `normalizeAnomalySnapshot` returns
 * ({id, lat, lon, year, status, ...}), not the raw columnar JSON: that
 * module's decoder is the one place that knows the exact column layout of
 * anomalies.v1.json (anomaly-atlas-kit/docs/DATA_PIPELINE.md), so this
 * module leans on its output rather than re-implementing the columnar
 * decode itself.
 *
 * The haversine formula below mirrors `src/spotter/geometry.js`'s
 * `haversineKm` rather than importing it: `scripts/package-boundaries.json`
 * scopes the `live-claims` boundary group to `src/layers/liveClaims/**` plus
 * a short, explicit external allowlist, and does not grant it the spotter
 * package's module graph. A five-line duplicate here is the lighter cost
 * against contorting that boundary for one function.
 *
 * No credibility scoring: `findNearbyCases` returns a count and a distance,
 * nothing else. It never ranks, scores or otherwise says anything about
 * whether a claim is corroborated.
 */

/** Mean Earth radius in kilometres, matching src/spotter/geometry.js. */
const EARTH_RADIUS_KM = 6371;

/** Default search radius for "nearby", per the design spec. */
export const NEARBY_RADIUS_KM = 50;

/** Default number of nearest cases to return alongside the count. */
export const NEARBY_LIMIT = 3;

const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance between two lat/lon points, in kilometres.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number}
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Historical anomalies cases within `radiusKm` of a claim's location,
 * nearest first. Read-only: it never touches the rows it is given.
 *
 * @param {{lat: number, lon: number}} claim
 * @param {Array<{id?: string, lat: number, lon: number, year?: number,
 *   status?: string}>} rows Decoded anomalies rows (the shape
 *   `normalizeAnomalySnapshot` returns), or any array shaped the same way.
 * @param {{radiusKm?: number, limit?: number}} [options]
 * @returns {{count: number, top: Array<{index: number, id: ?string,
 *   lat: number, lon: number, distanceKm: number, year: ?number,
 *   status: ?string}>}} `count` is every row within range; `top` is the
 *   nearest `limit` of them (default 3), nearest first.
 */
export function findNearbyCases(
  claim,
  rows,
  { radiusKm = NEARBY_RADIUS_KM, limit = NEARBY_LIMIT } = {},
) {
  if (
    !claim ||
    !Number.isFinite(claim.lat) ||
    !Number.isFinite(claim.lon) ||
    !Array.isArray(rows)
  ) {
    return { count: 0, top: [] };
  }
  const within = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row || !Number.isFinite(row.lat) || !Number.isFinite(row.lon))
      continue;
    const distanceKm = haversineKm(claim.lat, claim.lon, row.lat, row.lon);
    if (distanceKm <= radiusKm) {
      within.push({
        index,
        id: row.id ?? null,
        lat: row.lat,
        lon: row.lon,
        distanceKm,
        year: Number.isFinite(row.year) ? row.year : null,
        status: typeof row.status === 'string' ? row.status : null,
      });
    }
  }
  within.sort((a, b) => a.distanceKm - b.distanceKm);
  return { count: within.length, top: within.slice(0, Math.max(0, limit)) };
}
