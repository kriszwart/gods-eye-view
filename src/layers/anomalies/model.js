/**
 * Pure encodings for the anomaly layer. Colours are plain numbers so this
 * module stays portable and unit-testable.
 *
 * Brightness says how unexplained a report is; hue says what kind of claim it
 * is: grey for explained, violet for thin data, magenta for unresolved, amber
 * for contested. Ion blue marks curated hero cases.
 */
export const ANOMALY_LAYER_ID = 'anomalies';
export const YEAR_MIN = 1940;
export const YEAR_MAX = 2026;
export const TIME_MODES = Object.freeze(['cumulative', 'window', 'all']);

export const PALETTE = Object.freeze({
  void: '#070812',
  ink: '#D9DCE6',
  dim: '#7C8195',
  magenta: '#FF2E9A',
  violet: '#7B5CFF',
  ion: '#3FE0FF',
  amber: '#FFB547',
});

const rgb = (hex) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** Overlay label entry for a hero case, on the shared ambient-label lane. */
export function createAnomalyOverlayEntry({ id, position, title, year }) {
  return {
    id: `anomaly:${id}`,
    position,
    variant: 'label',
    title: String(title || 'Report'),
    accent: PALETTE.ion,
    priority: Math.round(Number(year) || 0),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/** RGB (0 to 1) for a row. */
export function pointColor(row) {
  if (row.status === 'contested') return rgb(PALETTE.amber);
  if (row.status === 'explained') return rgb(PALETTE.dim);
  const u = Math.max(0, Math.min(1, row.unexplained ?? 0.5));
  return u < 0.6
    ? mix(rgb(PALETTE.dim), rgb(PALETTE.violet), u / 0.6)
    : mix(rgb(PALETTE.violet), rgb(PALETTE.magenta), (u - 0.6) / 0.4);
}

/**
 * One fixed hue per status (task 2, luminous-pins: the close-range
 * shape-glyph billboards in rendering.js). `pointColor` above takes a
 * continuous `unexplained` value for anything short of contested/explained,
 * so it can produce any of millions of distinct RGB values along the
 * dim/violet/magenta ramp - fine for the glow-sprite tier, which applies
 * colour per billboard via Cesium's own colour multiply, but wrong for a
 * composed glyph raster, where a distinct hue means a distinct cached
 * canvas. Bounding that cache to a small, fixed set of hues means
 * quantising to the same four status buckets the chronometer's own status
 * filters, readout tint (`chronometer.js`'s `setReadoutTint`,
 * `anomaly-atlas.css`'s `.uap-readout-<status>` rules) and legend
 * (`index.js`) already use: explained -> dim, insufficient ("too little
 * data") -> violet, unresolved -> magenta, contested -> amber. A status
 * outside this set (defensive only - `records.js` already defaults a
 * missing status to `'unresolved'` at decode time) falls back to magenta,
 * the same systemic default.
 */
export const STATUS_HUE = Object.freeze({
  explained: PALETTE.dim,
  insufficient: PALETTE.violet,
  unresolved: PALETTE.magenta,
  contested: PALETTE.amber,
});

/**
 * The fixed hue for a row's status (see `STATUS_HUE` above).
 * @param {string} status
 * @returns {string} A `#rrggbb` colour.
 */
export function statusHue(status) {
  return STATUS_HUE[status] || PALETTE.magenta;
}

/** Pixel size: the current year reads loud, the past recedes. */
export function pointSize(row, { current = true } = {}) {
  const u = row.unexplained ?? 0.5;
  return current ? 7 + 6 * u + (row.hero ? 3 : 0) : 3.5 + 3 * u;
}

export function pointAlpha(row, { current = true } = {}) {
  const u = row.unexplained ?? 0.5;
  return current ? 0.95 : 0.3 + 0.4 * u;
}

/** Whether a row shows for the chronometer's year and mode. */
export function inWindow(row, year, mode = 'cumulative', span = 2) {
  if (mode === 'all' || year == null) return true;
  if (mode === 'window') return Math.abs(row.year - year) <= span;
  return row.year <= year;
}

/** JSON-safe analyst record for the voice and query engine. */
export function mapAnalystRecord(row, index = 0) {
  return {
    id: row?.id || `UAP-${String(index).padStart(5, '0')}`,
    year: Number.isInteger(row?.year) ? row.year : null,
    lat: Number.isFinite(row?.lat) ? row.lat : null,
    lon: Number.isFinite(row?.lon) ? row.lon : null,
    source: row?.source || null,
    craft: row?.craft || null,
    status: row?.status || null,
    unexplained: Number.isFinite(row?.unexplained) ? row.unexplained : null,
    title: row?.title || null,
  };
}

/** Plain-language readout for the chronometer, in sentence case. */
export function describeYear(year, count, mode) {
  const n =
    count === 1 ? '1 report' : `${count.toLocaleString('en-GB')} reports`;
  if (mode === 'all') return `${n} across all years`;
  if (mode === 'window') return `${n} around ${year}`;
  return `${n} up to ${year}`;
}
