/**
 * Pure spotter geometry. Portable: no rendering engine and no browser
 * globals, so this module stays unit-testable.
 */

/** Mean Earth radius in kilometres, used for the haversine distance. */
const EARTH_RADIUS_KM = 6371;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/**
 * Great-circle distance between two `{ lat, lon }` points, in kilometres.
 * @param {{ lat: number, lon: number }} a
 * @param {{ lat: number, lon: number }} b
 * @returns {number}
 */
export function haversineKm(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_KM * c;
}

/**
 * Initial true bearing from one `{ lat, lon }` point to another, in
 * degrees, normalised to 0-360.
 * @param {{ lat: number, lon: number }} from
 * @param {{ lat: number, lon: number }} to
 * @returns {number}
 */
export function bearingDeg(from, to) {
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const dLon = toRad(to.lon - from.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const theta = Math.atan2(y, x);
  return (toDeg(theta) + 360) % 360;
}

/**
 * Apparent elevation angle of a target above the observer's horizon, in
 * degrees. This is a flat-earth small-angle approximation
 * (`atan2(altM, distanceKm * 1000)`), which is fine for the spotter's
 * radius but drifts from the true angle beyond about 400 km as the
 * Earth's curvature and refraction start to matter.
 * @param {{ lat: number, lon: number }} observer
 * @param {{ lat: number, lon: number, altM?: number }} target
 * @returns {number|undefined} degrees above the horizon, or `undefined`
 *   when the target carries no altitude.
 */
export function elevationDeg(observer, target) {
  if (!Number.isFinite(target.altM)) return undefined;
  const distanceKm = haversineKm(observer, target);
  return toDeg(Math.atan2(target.altM, distanceKm * 1000));
}
