/**
 * Decode the columnar anomaly dataset (schema anomaly.app.v1) written by the
 * Anomaly atlas pipeline. Portable: no Cesium and no browser globals, so it
 * satisfies the repository's source-boundary checks.
 */
export const ANOMALY_APP_SCHEMA = 'anomaly.app.v1';
const DAY_MS = 86_400_000;
const REQUIRED = ['id', 't', 'lat', 'lon', 'src', 'craft', 'status', 'u'];
const PRECISIONS = ['day', 'month', 'year'];

/**
 * Validate a complete dataset before it can replace the displayed one.
 * @param {object} payload Parsed anomalies.v1.json.
 * @returns {Array<object>|null} Rows, or null when anything is malformed.
 */
export function normalizeAnomalySnapshot(payload) {
  if (!payload || payload.schema !== ANOMALY_APP_SCHEMA) return null;
  const n = payload.count;
  const c = payload.columns;
  if (!Number.isInteger(n) || n < 0 || !c) return null;
  for (const k of REQUIRED)
    if (!Array.isArray(c[k]) || c[k].length !== n) return null;
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  const crafts = Array.isArray(payload.crafts) ? payload.crafts : [];
  const statuses = Array.isArray(payload.statuses) ? payload.statuses : [];
  const ids = new Set();
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const lat = c.lat[i];
    const lon = c.lon[i];
    const days = c.t[i];
    if (
      !Number.isFinite(lat) ||
      Math.abs(lat) > 90 ||
      !Number.isFinite(lon) ||
      Math.abs(lon) > 180 ||
      !Number.isInteger(days)
    )
      return null;
    const id = String(c.id[i] ?? '');
    if (!id || ids.has(id)) return null;
    ids.add(id);
    const timeMs = days * DAY_MS;
    rows[i] = {
      id,
      timeMs,
      year: new Date(timeMs).getUTCFullYear(),
      datePrecision: PRECISIONS[c.prec?.[i] ?? 0] ?? 'day',
      lat,
      lon,
      precisionKm: Number.isFinite(c.km?.[i]) ? c.km[i] : null,
      source: sources[c.src[i]]?.id ?? 'unknown',
      craft: crafts[c.craft[i]] ?? 'orb',
      status: statuses[c.status[i]] ?? 'unresolved',
      unexplained: Math.max(0, Math.min(1, (Number(c.u[i]) || 0) / 100)),
      hero: c.hero?.[i] === 1,
      title: c.title?.[i] || null,
    };
  }
  return rows;
}

/** Sightings per year for the chronometer, inclusive of both ends. */
export function yearHistogram(rows, from, to) {
  const out = new Array(Math.max(0, to - from + 1)).fill(0);
  for (const r of rows)
    if (r.year >= from && r.year <= to) out[r.year - from]++;
  return out;
}

/** Group rows by calendar year. */
export function bucketByYear(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.year)) map.set(r.year, []);
    map.get(r.year).push(r);
  }
  return map;
}
