/**
 * Pure encodings for the live-claims register, Phenomena's fourth register
 * (see docs/superpowers/specs/2026-09-27-live-claims-design.md). Portable:
 * no Cesium, no browser globals, so this module stays unit-testable.
 *
 * Brightness encodes ONLY how recently a claim was posted, newest
 * brightest, and NEVER anything about whether a claim is believed, verified
 * or credible - the spec's standing "no credibility scoring" rule. A floor
 * keeps a claim near the edge of the register's 48-hour window still
 * visible rather than fading out entirely.
 */
export const LIVE_CLAIMS_LAYER_ID = 'live-claims';

/** Ion accent, both themes (DESIGN_SYSTEM.md). The app is hardcoded dark
 * today (no in-app theme toggle - see anomaly-atlas.css's own note), so only
 * the dark value is wired into CSS; the light value is held here ready for
 * whenever a theme selector exists. */
export const PALETTE = Object.freeze({
  ionDark: '#3fe0ff',
  ionLight: '#0a93b8',
});

/** Mirrors server/providers/claims.js's CLAIM_WINDOW_MS: the ephemeral
 * register's own 48-hour bound. Used here only to shape the recency curve,
 * never to filter rows - the server has already evicted anything older. */
export const CLAIM_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Brightness never falls below this, however old a claim gets within the
 * window, so a day-old claim stays visible rather than fading to nothing. */
export const BRIGHTNESS_FLOOR = 0.32;

/** The register's standing honesty line, verbatim from the design spec. */
export const HONESTY_LINE =
  'Unverified public claims, shown as posted; nothing here is evaluated or endorsed.';

/** Shown in place of any claim data when DEEPSEEK_API_KEY is unset, verbatim
 * from the design spec and .env.example. */
export const KEYLESS_MESSAGE = 'Classifier key not set';

/**
 * Recency-only brightness in [floor, 1]: 1 for a claim that just arrived,
 * decaying linearly to `floor` by the edge of the window. Never anything
 * about credibility - see the module doc comment above.
 *
 * @param {number} ageMs - Milliseconds since the claim was fetched.
 * @param {{windowMs?: number, floor?: number}} [options]
 * @returns {number}
 */
export function brightnessForAge(
  ageMs,
  { windowMs = CLAIM_WINDOW_MS, floor = BRIGHTNESS_FLOOR } = {},
) {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  const t = Math.min(1, ageMs / windowMs);
  return 1 - t * (1 - floor);
}

/** Pixel size for a point at the given recency brightness (0 to 1). */
export function pointPixelSize(brightness) {
  return 6 + 6 * Math.max(0, Math.min(1, brightness));
}

/** Alpha for a point at the given recency brightness (0 to 1). */
export function pointAlpha(brightness) {
  return 0.35 + 0.65 * Math.max(0, Math.min(1, brightness));
}

/** JSON-safe analyst record for the voice and query engine. */
export function mapAnalystRecord(row) {
  return {
    id: row?.id || null,
    place: row?.place || null,
    lat: Number.isFinite(row?.lat) ? row.lat : null,
    lon: Number.isFinite(row?.lon) ? row.lon : null,
    source: row?.source || null,
    shape: row?.shape || null,
    when: row?.when || null,
  };
}
