/**
 * Portable sweep-type-to-glyph and TMA-category-to-type mapping for the
 * ancient-sites close-range billboards. No Cesium, no browser globals: this
 * module only resolves strings to URLs and strings to strings, so it stays
 * unit-testable and safe to import from anywhere (see rendering.js, which
 * does the actual canvas compositing and Cesium billboard work).
 *
 * The worldwide sweep carries exactly five typological types (see eras.js's
 * `TYPE_ERA_WINDOWS`): circle, geoglyph, megalith, mound, settlement.
 */

/** Public asset base every glyph SVG lives under (see public/ancient-sites/). */
const GLYPH_BASE = '/ancient-sites/glyphs/';

/** The five sweep types, in the order the legend key row displays them. */
export const SWEEP_TYPES = Object.freeze([
  'circle',
  'geoglyph',
  'megalith',
  'mound',
  'settlement',
]);

/**
 * Sweep type -> glyph filename (without extension or base path). The shipped
 * glyph set (public/ancient-sites/glyphs/) predates the five-type sweep and
 * carries no `megalith.svg` of its own: it was drawn for the curated hero
 * tier's own richer `glyph` field, which uses finer categories such as
 * `temple` and `trilith`. CONTROLLER RULING (task 1, ancient-legibility,
 * 27 September 2026): megalith maps to `trilith.svg` - a trilithon reads as
 * a generic megalith silhouette clearly enough that drawing a new SVG in
 * the same style was not warranted for this task.
 */
const SWEEP_TYPE_GLYPH_NAMES = Object.freeze({
  circle: 'circle',
  geoglyph: 'geoglyph',
  megalith: 'trilith',
  mound: 'mound',
  settlement: 'settlement',
});

/** An unrecognised sweep type falls back to this glyph; defensive only,
 * every type the shipped sweep actually uses has its own entry above. */
const DEFAULT_GLYPH_NAME = 'circle';

/**
 * URL of the glyph SVG for a sweep type, under the ancient-sites public
 * asset base. Falls back to a default glyph for a type outside `SWEEP_TYPES`
 * (defensive: the shipped sweep never emits one).
 * @param {string} typeName - A sweep `type` name (see records.js's `typeName`).
 * @returns {string} An absolute path such as `/ancient-sites/glyphs/circle.svg`.
 */
export function glyphUrlForType(typeName) {
  const name = SWEEP_TYPE_GLYPH_NAMES[typeName] || DEFAULT_GLYPH_NAME;
  return `${GLYPH_BASE}${name}.svg`;
}

/**
 * Keyword rules mapping a local Modern Antiquarian (TMA) category string to
 * the nearest sweep type. Checked in order, first match wins, case
 * -insensitive substring matching against the raw KML category text (for
 * example "Alignement" or "Round Barrow(s)"): TMA's own category list runs
 * to about 100 free-text strings across English, French, Danish, Catalan
 * and Italian terms, so this is a practical nearest-type heuristic, not an
 * archaeological classification.
 */
const TMA_CATEGORY_RULES = Object.freeze([
  Object.freeze({ type: 'geoglyph', keywords: ['geoglyph', 'hill figure'] }),
  Object.freeze({ type: 'circle', keywords: ['circle', 'henge', 'avenue'] }),
  Object.freeze({
    type: 'settlement',
    keywords: [
      'settlement',
      'village',
      'fort',
      'enclosure',
      'broch',
      'dun',
      'crannog',
      'rath',
      'souterrain',
      'fogou',
      'earthwork',
      'trackway',
      'camp',
      'poblat',
      'cave',
      'shrine',
      'sanctuary',
    ],
  }),
  Object.freeze({
    type: 'mound',
    keywords: ['barrow', 'cairn', 'mound', 'tumulus', 'tertre'],
  }),
  Object.freeze({
    type: 'megalith',
    keywords: [
      'stone',
      'menhir',
      'dolmen',
      'cromlech',
      'quoit',
      'tomb',
      'grave',
      'cist',
      'chamber',
      'megalithic',
      'dysse',
      'jættestue',
      'skibssætning',
      'talaiot',
      'taula',
      'naveta',
      'nuraghe',
      'allee',
      'allée',
      'giganti',
      'align',
    ],
  }),
]);

/**
 * Unrecognised or empty categories fall back here. TMA (The Modern
 * Antiquarian) is a megalith-focused gazetteer, so an uncategorised or
 * unmatched row is more often some kind of stone monument than any other
 * register type.
 */
const DEFAULT_TMA_TYPE = 'megalith';

/**
 * Map a TMA category string (raw KML free text) to the nearest sweep type,
 * case-insensitive and keyword-based. An empty, missing or unrecognised
 * category returns `DEFAULT_TMA_TYPE`.
 * @param {string} category - Raw TMA `category` field (see tmaLocal.js).
 * @returns {string} One of `SWEEP_TYPES`.
 */
export function typeForTmaCategory(category) {
  const text = typeof category === 'string' ? category.toLowerCase() : '';
  if (text) {
    for (const rule of TMA_CATEGORY_RULES) {
      if (rule.keywords.some((keyword) => text.includes(keyword)))
        return rule.type;
    }
  }
  return DEFAULT_TMA_TYPE;
}

/**
 * Glyph URL for a TMA category: composes `typeForTmaCategory` and
 * `glyphUrlForType` for callers that only need the final asset URL.
 * @param {string} category - Raw TMA `category` field.
 * @returns {string}
 */
export function glyphUrlForTmaCategory(category) {
  return glyphUrlForType(typeForTmaCategory(category));
}
