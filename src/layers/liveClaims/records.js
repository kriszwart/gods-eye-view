import { safeSourceUrl } from '../../sources/safeUrl.js';

/**
 * Decode and validate GET /api/claims responses (see
 * server/providers/claims.js). Portable: no Cesium, no browser globals, so
 * this module stays unit-testable and satisfies the repository's
 * source-boundary checks.
 */

const VALID_SOURCES = new Set(['reddit', 'bluesky']);
const MAX_PLACE_CHARS = 120;
const WHEN_PATTERN =
  /^\d{4}-\d{2}(-\d{2})?(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** True if `value` contains any ASCII control character (codes below 0x20). */
function hasControlCharacter(value) {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

/**
 * Validate and normalise one row of GET /api/claims's `claims` array,
 * bounding coordinates and whitelisting fields to exactly the shape
 * server/providers/claims.js promises: id, url, source, lat, lon, place,
 * shape, when, fetchedAt, nothing else, whatever extra fields the row
 * otherwise carries. Returns null for anything malformed, so the caller can
 * drop the row rather than fail the whole snapshot (a best-effort live feed,
 * unlike the anomalies dataset's own all-or-nothing validated build).
 *
 * @param {*} row - one entry of the `claims` array.
 * @returns {?{id: string, url: string, source: 'reddit'|'bluesky', lat: number,
 *   lon: number, place: string, shape: ?string, when: ?string, fetchedAt: string}}
 */
export function normalizeClaimRow(row) {
  if (!row || typeof row !== 'object') return null;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!id) return null;
  const source = VALID_SOURCES.has(row.source) ? row.source : null;
  if (!source) return null;
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) return null;
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) return null;
  const place = typeof row.place === 'string' ? row.place.trim() : '';
  if (!place || place.length > MAX_PLACE_CHARS || hasControlCharacter(place))
    return null;
  const shape =
    typeof row.shape === 'string' && row.shape.trim() ? row.shape.trim() : null;
  const when =
    typeof row.when === 'string' && WHEN_PATTERN.test(row.when.trim())
      ? row.when.trim()
      : null;
  const fetchedAtMs = Date.parse(row.fetchedAt);
  if (typeof row.fetchedAt !== 'string' || !Number.isFinite(fetchedAtMs))
    return null;
  const url = safeSourceUrl(row.url);
  if (!url) return null;
  return {
    id,
    url,
    source,
    lat,
    lon,
    place,
    shape,
    when,
    fetchedAt: row.fetchedAt,
  };
}

/**
 * Validate the complete GET /api/claims response and normalise its rows,
 * dropping malformed ones individually rather than failing the whole
 * snapshot. Duplicate ids keep only the first occurrence.
 *
 * @param {*} payload - Parsed /api/claims JSON body.
 * @returns {?{claims: Array<object>, status: 'ok'|'no-key', unplaced: number}}
 *   null when the payload itself is not a recognisable shape.
 */
export function normalizeClaimsSnapshot(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const status = payload.status;
  if (status !== 'ok' && status !== 'no-key') return null;
  const rawClaims = Array.isArray(payload.claims) ? payload.claims : [];
  const ids = new Set();
  const claims = [];
  for (const row of rawClaims) {
    const normalized = normalizeClaimRow(row);
    if (!normalized || ids.has(normalized.id)) continue;
    ids.add(normalized.id);
    claims.push(normalized);
  }
  const unplaced =
    Number.isFinite(payload.unplaced) && payload.unplaced >= 0
      ? Math.floor(payload.unplaced)
      : 0;
  return { claims, status, unplaced };
}
