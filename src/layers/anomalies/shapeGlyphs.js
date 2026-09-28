/**
 * Portable reported-shape-category to glyph URL mapping for the anomalies
 * register's close-range shape billboards (see rendering.js). No Cesium, no
 * browser globals, so it stays unit-testable and safe to import from
 * anywhere - including task 3's dossier previews, which import this
 * module's own `SHAPE_GLYPH_URLS` table directly rather than reconstructing
 * the URL scheme themselves.
 *
 * Every craft id in the shipped craft manifest
 * (public/anomalies/crafts/manifest.json) is also the shipped glyph SVG's
 * own filename (public/anomalies/glyphs/<id>.svg): unlike the ancient-sites
 * register, which maps five broad sweep types down onto a smaller shipped
 * glyph set (see ancientSites/glyphMap.js's own "megalith -> trilith.svg"
 * ruling), the anomalies craft library and its glyph set were drawn
 * together, one glyph per craft, so no such remapping is needed here - this
 * module is a thin, defensive lookup, not a real classifier.
 */

/** Public asset base every glyph SVG lives under (see public/anomalies/). */
const GLYPH_BASE = '/anomalies/glyphs/';

/**
 * Every reported-shape category the shipped craft manifest and glyph set
 * carry, in the manifest's own order
 * (public/anomalies/crafts/manifest.json's `crafts[].id`, generated
 * 24 September 2026) - the canonical list per the task brief. A row's
 * `craft` field (see records.js) is always one of these once decoded
 * (records.js itself defaults a missing craft index to `'orb'`);
 * `glyphUrlForShape` below still falls back defensively for anything
 * outside this list.
 */
export const SHAPE_CATEGORIES = Object.freeze([
  'domed-disc',
  'lens-disc',
  'ringed-disc',
  'bell',
  'hat',
  'spinning-top',
  'pyramid',
  'cigar',
  'tic-tac',
  'egg',
  'torus',
  'orb',
  'orb-trio',
  'orb-swarm',
  'flaring-orb',
  'cold-pair',
  'triangle',
  'boomerang',
  'crescent',
  'tetrahedron',
  'diamond',
  'slab',
  'wedge',
  'light-v',
  'light-arc',
  'fireball',
  'spiral',
  'jellyfish',
  'lander',
  'manta',
]);

/**
 * A row with no reported shape, or a shape outside `SHAPE_CATEGORIES`
 * (defensive only - `records.js` already defaults a missing `craft` to
 * `'orb'` at decode time), falls back to the orb glyph: a plain light/sphere
 * silhouette, the broadest "unidentified light" reading among the shipped
 * set, and already the systemic default the columnar decoder itself uses.
 *
 * CONTROLLER RULING (task 2, luminous-pins): a shipped fallback glyph, not
 * `null`/"keep the glow sprite" - a mix of shaped and unshaped points at the
 * same close-zoom band would read as broken rather than intentional, and
 * every row already carries a concrete `craft` value by the time it reaches
 * this module.
 */
export const DEFAULT_SHAPE_CATEGORY = 'orb';

/**
 * Shape category -> glyph URL, for every category `glyphUrlForShape` ever
 * resolves cleanly. A plain, frozen object (never a function only), built
 * from `SHAPE_CATEGORIES` so the two can never drift apart.
 */
export const SHAPE_GLYPH_URLS = Object.freeze(
  Object.fromEntries(
    SHAPE_CATEGORIES.map((id) => [id, `${GLYPH_BASE}${id}.svg`]),
  ),
);

/**
 * Glyph URL for a reported shape category. An unrecognised or missing
 * category falls back to `DEFAULT_SHAPE_CATEGORY`'s own glyph (see its doc
 * comment above).
 * @param {string} category - A row's `craft` field (see records.js).
 * @returns {string} An absolute path such as `/anomalies/glyphs/orb.svg`.
 */
export function glyphUrlForShape(category) {
  return SHAPE_GLYPH_URLS[category] || SHAPE_GLYPH_URLS[DEFAULT_SHAPE_CATEGORY];
}
