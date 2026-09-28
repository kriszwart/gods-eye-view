/**
 * Animated craft preview plate for case and claim dossiers (task 3,
 * luminous-pins). The shipped glyph SVG (see shapeGlyphs.js's own
 * `SHAPE_GLYPH_URLS` - the canonical, frozen shape-to-glyph mapping, imported
 * directly here rather than re-deriving the URL scheme, per the task 2
 * ruling in that module's own doc comment) sits inside a small hairline
 * plate, reproducing the craft-specimens page's own motion language in
 * miniature: a slow vertical hover drift and a thin-film sheen sweep, both
 * pure CSS keyframes (see src/ui/styles/anomaly-atlas.css's
 * `.uap-craft-preview` rules) - no WebGL, no JS timers, so the preview
 * carries no lifecycle of its own beyond the DOM node it lives in. It dies
 * the instant a dossier's own `innerHTML` is replaced or cleared; nothing
 * here ever attaches a listener, observer or timer that would outlive that.
 *
 * Returns an HTML string rather than a DOM element: both dossier builders
 * this wires into (`src/layers/anomalies/index.js`,
 * `src/layers/liveClaims/index.js`) already build their whole plate via one
 * `innerHTML` template literal, escaping every interpolated field with their
 * own local `escapeHtml`. A string splices straight into that idiom; a
 * built element would force each caller to switch to a mixed
 * template-plus-DOM-surgery approach for one field alone.
 *
 * This module lives under `src/ui/` (an "application/rendering" module by
 * the repository's own import-direction rules) rather than beside
 * shapeGlyphs.js under `src/layers/anomalies/`: it is reused by two
 * separate registers' dossiers (anomalies and live claims), neither of
 * which owns the other, so a shared UI-side module is the natural home -
 * mirroring `src/ui/glowSprite.js` (task 1, luminous-pins), which is
 * likewise DOM-facing and shared across all three registers' renderers.
 * Declared in `scripts/package-boundaries.json` under every boundary group
 * that already carries `src/layers/anomalies/shapeGlyphs.js` and now
 * transitively reaches this file too (`anomalies`, `live-claims`,
 * `application-components`, `application-layer-construction`).
 */
import { SHAPE_GLYPH_URLS } from '../layers/anomalies/shapeGlyphs.js';

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** A shape category id's own hyphenated words as a sentence-case phrase
 * ('tic-tac' -> 'Tic tac'), used only as the preview glyph's `alt` text. */
function shapeLabel(shape) {
  const words = String(shape).replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * An animated preview plate for a case or claim's reported shape, or an
 * empty string when there is nothing honest to show.
 *
 * A shape that does not resolve to a shipped glyph - `null`/`undefined`
 * (no shape was reported at all - live claims can genuinely carry this,
 * see `formatShape` in `src/layers/liveClaims/index.js`), or a value
 * outside `SHAPE_GLYPH_URLS` - returns `''`: no preview, and deliberately
 * NO orb fallback here. This differs from the globe's own close-range
 * glyph tier (task 2, `src/layers/anomalies/rendering.js`), which DOES
 * fall back to `orb.svg` for a missing/unrecognised craft, because every
 * row reaching that tier already carries a concrete decoded value
 * (`records.js` defaults a missing `craft` index to `'orb'` at decode
 * time) - falling back there just keeps a mixed shaped/unshaped point
 * field from reading as broken. A dossier is a different kind of claim: it
 * says what was actually reported. Showing an orb glyph next to a report,
 * or a live claim, that never claimed any shape at all would misrepresent
 * the record rather than merely default it - so the caller shows no
 * preview at all instead (see each dossier's own call site).
 *
 * @param {{shape: ?string, hue: string}} options - `shape` a shape
 *   category id (see shapeGlyphs.js's `SHAPE_CATEGORIES`), or
 *   `null`/`undefined` when none was reported; `hue` a CSS colour string
 *   for the plate's accent border - the row's own status hue for
 *   anomalies (`statusHue` in `src/layers/anomalies/model.js`), the
 *   register's fixed ion hue for live claims (`PALETTE.ionDark` in
 *   `src/layers/liveClaims/model.js`). Always passed in by the caller,
 *   never derived here, so this module stays agnostic of either register's
 *   own encoding rules.
 * @returns {string} An HTML string ready to splice into a dossier's own
 *   `innerHTML` template, or `''` when `shape` has no shipped glyph.
 */
export function buildCraftPreview({ shape, hue }) {
  const url = shape ? SHAPE_GLYPH_URLS[shape] : null;
  if (!url) return '';
  return `<div class="uap-craft-preview" style="--uap-preview-accent: ${escapeHtml(hue || '')}"><img class="uap-craft-preview-glyph" src="${escapeHtml(url)}" alt="${escapeHtml(shapeLabel(shape))}" loading="lazy"></div>`;
}
