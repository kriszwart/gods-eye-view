/**
 * Pure candidate ranking for the spotter. Portable: no rendering engine
 * and no browser globals, so this module stays unit-testable.
 */
import { haversineKm, bearingDeg, elevationDeg } from './geometry.js';

/** Default search radius in kilometres when the observation omits one. */
const DEFAULT_RADIUS_KM = 150;

/** Score weight applied per candidate kind ahead of the distance decay. */
const KIND_PRIORS = Object.freeze({
  aircraft: 1.0,
  military: 1.0,
  satellite: 0.8,
  launch: 0.6,
  lightning: 0.5,
});

/** One-sentence description of each kind, used in the `why` field. */
const KIND_PHRASES = Object.freeze({
  aircraft: 'tracked aircraft',
  military: 'tracked military aircraft',
  satellite: 'satellite pass',
  launch: 'rocket launch',
  lightning: 'lightning strike',
});

/** 16-point compass rose, spelled out and sentence-cased for prose use. */
const COMPASS_POINTS = Object.freeze([
  'north',
  'north-north-east',
  'north-east',
  'east-north-east',
  'east',
  'east-south-east',
  'south-east',
  'south-south-east',
  'south',
  'south-south-west',
  'south-west',
  'west-south-west',
  'west',
  'west-north-west',
  'north-west',
  'north-north-west',
]);

/**
 * Compass point (16-point rose) matching a true bearing.
 * @param {number} bearing degrees, 0-360
 * @returns {string}
 */
function compassPoint(bearing) {
  const index = Math.round(bearing / 22.5) % COMPASS_POINTS.length;
  return COMPASS_POINTS[index];
}

/**
 * One-sentence explanation of why a candidate matches an observation.
 * @param {{ distanceKm: number, bearingDeg: number, elevationDeg?: number, kind: string }} row
 * @returns {string}
 */
function describeWhy(row) {
  const distance = `${Math.round(row.distanceKm)} km ${compassPoint(row.bearingDeg)}`;
  const kindPhrase = KIND_PHRASES[row.kind] ?? row.kind;
  const altitude =
    row.elevationDeg !== undefined && Number.isFinite(row.altM)
      ? ` at ${row.altM.toLocaleString('en-GB')} m`
      : '';
  return `${distance}${altitude}, ${kindPhrase}.`;
}

/**
 * Rank candidates by relevance to an observation.
 * @param {{ lat: number, lon: number, radiusKm?: number }} observation
 * @param {Array<{ id: string, kind: 'aircraft'|'military'|'satellite'|'launch'|'lightning', label: string, lat: number, lon: number, altM?: number, detail?: string }>} candidates
 * @returns {Array<Object>} candidates within the radius, each carrying
 *   `distanceKm`, `bearingDeg`, `elevationDeg` (when the candidate has an
 *   altitude), `score` and a one-sentence `why`, sorted by score
 *   descending.
 */
export function rankCandidates(observation, candidates) {
  const radiusKm = observation.radiusKm ?? DEFAULT_RADIUS_KM;
  const rows = candidates
    .map((candidate) => {
      const distanceKm = haversineKm(observation, candidate);
      const bearing = bearingDeg(observation, candidate);
      const elevation = elevationDeg(observation, candidate);
      const prior = KIND_PRIORS[candidate.kind] ?? 0;
      const score = (1 / (1 + distanceKm / 50)) * prior;
      const row = {
        ...candidate,
        distanceKm,
        bearingDeg: bearing,
        elevationDeg: elevation,
        score,
      };
      row.why = describeWhy(row);
      return row;
    })
    .filter((row) => row.distanceKm <= radiusKm);
  rows.sort((a, b) => b.score - a.score);
  return rows;
}
