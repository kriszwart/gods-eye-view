import * as Cesium from 'cesium';
import {
  pointColor,
  pointSize,
  pointAlpha,
  PALETTE,
  ANOMALY_LAYER_ID,
  STATUS_HUE,
  statusHue,
  inWindow,
} from './model.js';
import { binRows, blurBins, heatAlpha } from './hotspots.js';
import { resolveImageryHost, NO_IMAGERY_HOST } from '../../maps/imageryHost.js';
import { SHAPE_CATEGORIES, glyphUrlForShape } from './shapeGlyphs.js';
import {
  composeGlowSprite,
  glowCacheKey,
  sizeBucket,
  currentDprBucket,
} from '../../ui/glowSprite.js';

// Luminous points (task: luminous pins): every status-hued point is a glow
// sprite billboard rather than a flat Cesium PointPrimitive. The anomalies
// register's hue varies continuously per row (see model.js's pointColor - a
// mix along the dim/violet/magenta ramp, or a fixed amber/dim for
// contested/explained), so composing one sprite per distinct row colour
// would leave the cache unbounded. Every row instead shares ONE neutral
// white-core sprite per size bucket (see glowSprite.js's own doc comment for
// why this differs from live claims and ancient sites, which each bake
// their single fixed hue into the sprite instead); the row's actual colour
// and alpha apply via the billboard's own `color`, which Cesium multiplies
// against the sprite's white core - reproducing pointColor()/pointAlpha()'s
// output exactly, with no quantisation.
const GLOW_NEUTRAL_HUE = '#ffffff';

// Hover brighten (task: presence pass, hover and selection feedback): a
// fixed multiplicative factor applied to a hovered billboard's own colour
// (RGB and alpha alike, each independently clamped to 1) rather than a
// recomputed value - see `brightenColor` and `setHovered` below. Every
// billboard this renderer draws (bright/faded glow sprites, shape glyphs,
// the hero ring) is set once at build time and never repainted per tick
// (only its `show` flag toggles - see `apply`/`syncPointVisibility`), so
// "store the original, restore exactly on leave" is exact here: nothing
// else ever touches a billboard's `color` between the hover starting and
// ending, unlike the live-claims register (rendering.js there recomputes
// colour every tick from a continuously advancing age curve, so it takes a
// different approach - see that module's own doc comment).
const HOVER_BRIGHTEN_FACTOR = 1.4;

/** Scale a Cesium.Color's RGB and alpha channels by `factor`, each
 * independently clamped to 1 - a visible "step up" on saturated status
 * hues (contested amber, unresolved magenta) and a plain alpha boost on
 * already-white channels (the hero ring, or a glow sprite's white core
 * before the register's own colour multiply - see the module doc comment
 * on GLOW_NEUTRAL_HUE above for why glow sprites carry colour via the
 * billboard's own `color` rather than the baked sprite). */
function brightenColor(color, factor) {
  return new Cesium.Color(
    Math.min(1, color.red * factor),
    Math.min(1, color.green * factor),
    Math.min(1, color.blue * factor),
    Math.min(1, color.alpha * factor),
  );
}
// `dpr` here must be the same bucket `composeGlowSprite` resolved for
// `glowImage`'s own call (task: presence pass, retina-sharp composition):
// both read fresh via `currentDprBucket` in the same synchronous build pass
// (setRows below), so they always agree without threading a value between
// them.
const glowImageId = (sizePx, dpr) =>
  glowCacheKey(GLOW_NEUTRAL_HUE, sizeBucket(sizePx), dpr);
const glowImage = (sizePx) =>
  composeGlowSprite({ hue: GLOW_NEUTRAL_HUE, sizePx });

// Close-range shape glyphs (task 2, luminous-pins): below a camera-height
// threshold (see SHAPE_GLYPH_HEIGHT_THRESHOLD_M in createAnomalyRenderer
// below) a point in view swaps from the neutral glow sprite above to a
// small composed billboard - a dark halo ring behind the row's own reported
// shape glyph (shapeGlyphs.js), recoloured to the row's STATUS hue rather
// than pointColor()'s continuous unexplained-ness ramp: baking a distinct
// hue per row here would make the glyph cache unbounded, so hue is
// quantised to the same four discrete values the chronometer's own status
// filters, readout tint and legend already use (model.js's STATUS_HUE).
// Composed lazily per (shape, hue) pair and cached forever at module scope
// - shared across every renderer instance, exactly like glowImage above -
// mirroring ancientSites/rendering.js's own glyph-billboard compositing
// (composeGlyphBillboardCanvas/requestBillboardGlyph) closely, including its
// failure sentinel (a failed SVG load caches a fallback as the pair's
// permanent result, so one failure ends the retry chain rather than looping
// - see ancient's commit f6a62d8) and its placeholder-id discipline (the
// "still loading" placeholder is added under its OWN imageId, never a real
// glyph's, so the real glyph's first successful add is never pre-empted -
// see ancient's commit d967cd5 and SHAPE_GLYPH_PLACEHOLDER_IMAGE_ID below).
// Duplicated from, not extracted out of, the ancient module: the two
// registers' compositing differs enough (one fixed hue there, one of four
// hues here; a fixed display size there, the row's own continuous
// pointSize()/pointAlpha() here) that sharing the small amount of code the
// two approaches have in common was judged not worth coupling an
// already-shipped, extensively-commented module to a second caller (see the
// task 2 report's own "extract vs duplicate" note).
const SHAPE_GLYPH_CANVAS_DIM = 40;
const SHAPE_GLYPH_HALO_FILL = 'rgba(7, 8, 18, 0.72)';
const SHAPE_GLYPH_PLACEHOLDER_IMAGE_ID = 'anomaly-shape-glyph-placeholder';

/**
 * Load an image element from a URL (used for the glyph SVGs under
 * public/anomalies/glyphs/). Rejects on load failure rather than resolving a
 * broken image, so a caller's `.catch` sees a real error.
 * @param {string} url
 * @returns {Promise<HTMLImageElement>}
 */
function loadShapeGlyphImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error(`Failed to load shape glyph image: ${url}`));
    image.src = url;
  });
}

/** `#rrggbb` plus an alpha, as an `rgba()` string. */
function withAlphaHex(hex, alpha) {
  const n = hex.replace('#', '');
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Recolour a monochrome glyph image to one hue via canvas compositing: draw
 * the source image (the shipped glyphs use `fill="currentColor"`, which
 * resolves to black when loaded standalone as an `<img>`), then `source-in`
 * composite a solid fill of `hue` so only the glyph's own opaque pixels -
 * and their anti-aliased edges - take the colour, leaving transparent areas
 * untouched.
 *
 * Takes explicit `width`/`height` for the intermediate canvas rather than
 * deriving them from `image.naturalWidth`/`naturalHeight` (task: presence
 * pass, retina-sharp composition): the shipped glyphs are `viewBox`-only
 * SVGs with no explicit intrinsic size, so their natural dimensions are an
 * implementation-dependent default-object-size guess, not something tied to
 * how large the glyph will actually render. Asking the browser to rasterise
 * the source SVG directly at the CALLER'S final on-canvas pixel size - see
 * `composeShapeGlyphCanvas`'s own `glyphPx` below - re-renders the vector
 * artwork fresh at that resolution (crisp at any DPR); drawing it first into
 * a small natural-size raster and only then scaling THAT bitmap up would
 * bake in blur before the DPR multiplier ever gets a chance to help ("scales
 * the source, not stretches a raster of it" - see the task brief).
 * @param {HTMLImageElement} image
 * @param {string} hue - A `#rrggbb` colour.
 * @param {number} width - Target raster width, in actual canvas pixels.
 * @param {number} height - Target raster height, in actual canvas pixels.
 * @returns {HTMLCanvasElement}
 */
function recolourShapeGlyph(image, hue, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.drawImage(image, 0, 0, width, height);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = hue;
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

/**
 * Compose one shape-glyph billboard image: a dark halo ring, stroked in the
 * same hue at reduced alpha, behind the hue-recoloured glyph, centred at
 * SHAPE_GLYPH_CANVAS_DIM. Built once per distinct (shape, hue, DPR bucket)
 * triple (see the cache below) and reused for every billboard of that
 * triple - never rebuilt per row. The billboard's own continuous
 * width/height (the row's pointSize()) then scale this whole
 * fixed-resolution raster, so "how unexplained" still reads as size exactly
 * as it does on the glow-sprite tier.
 *
 * `dim` stays the logical, CSS-pixel-equivalent drawing size every
 * coordinate below is expressed in (unchanged from before the presence-pass
 * task); the canvas's own `width`/`height` - the actual raster resolution
 * `BillboardCollection` uploads as a texture - scale by `dpr`, mapped onto
 * the unchanged geometry via `ctx.scale(dpr, dpr)`. The embedded glyph gets
 * the same treatment one level down: `recolourShapeGlyph` is asked to
 * rasterise the SOURCE SVG directly at `glyphPx` (the glyph's own on-canvas
 * footprint, already DPR-scaled), not at some fixed natural size later
 * stretched - see that function's own doc comment for why.
 * @param {HTMLImageElement} glyphImage - Already-loaded glyph image (black on transparent).
 * @param {string} hue - A `#rrggbb` colour.
 * @param {number} dpr - Bucketed devicePixelRatio (see glowSprite.js's `dprBucket`).
 * @returns {HTMLCanvasElement}
 */
function composeShapeGlyphCanvas(glyphImage, hue, dpr) {
  const dim = SHAPE_GLYPH_CANVAS_DIM;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(dim * dpr);
  canvas.height = Math.round(dim * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(dpr, dpr);
  const centre = dim / 2;
  ctx.beginPath();
  ctx.arc(centre, centre, centre - 2, 0, Math.PI * 2);
  ctx.fillStyle = SHAPE_GLYPH_HALO_FILL;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = withAlphaHex(hue, 0.55);
  ctx.stroke();
  const glyphSize = dim * 0.6;
  const offset = (dim - glyphSize) / 2;
  const glyphPx = Math.round(glyphSize * dpr);
  ctx.drawImage(
    recolourShapeGlyph(glyphImage, hue, glyphPx, glyphPx),
    offset,
    offset,
    glyphSize,
    glyphSize,
  );
  return canvas;
}

/** `imageId` for the loading-state placeholder canvas below, per DPR bucket
 * (task: presence pass, retina-sharp composition): keeps the placeholder's
 * own id namespace distinct from every real glyph's - the d967cd5 rule this
 * module's own SHAPE_GLYPH_PLACEHOLDER_IMAGE_ID doc comment already names -
 * while a DPR-1 and a DPR-2 placeholder canvas, now distinct content
 * themselves, each get their own id too. */
function shapeGlyphPlaceholderImageId(dpr) {
  return `${SHAPE_GLYPH_PLACEHOLDER_IMAGE_ID}@${dpr}`;
}

/** Lazily-built halo-only placeholder (a small ink-grey dot in the same
 * dark halo ring) shown for the brief window - if any - between a
 * billboard's first request and its own (shape, hue) pair finishing its
 * (tiny, same-origin, local) fetch. Carries no status hue of its own (it is
 * a "still loading" state only, never a row's real colour), so it never
 * flashes the wrong hue before the real pair upgrades in. Built once per DPR
 * bucket (at most `MAX_COMPOSE_DPR`-many entries - see glowSprite.js),
 * shared by every shape and hue until each pair's own request settles. */
const shapeGlyphPlaceholderCanvasByDpr = new Map();
function shapeGlyphPlaceholderCanvas(dpr) {
  const cached = shapeGlyphPlaceholderCanvasByDpr.get(dpr);
  if (cached) return cached;
  const dim = SHAPE_GLYPH_CANVAS_DIM;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(dim * dpr);
  canvas.height = Math.round(dim * dpr);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.scale(dpr, dpr);
    const centre = dim / 2;
    ctx.beginPath();
    ctx.arc(centre, centre, centre - 2, 0, Math.PI * 2);
    ctx.fillStyle = SHAPE_GLYPH_HALO_FILL;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(centre, centre, dim * 0.18, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.dim;
    ctx.fill();
  }
  shapeGlyphPlaceholderCanvasByDpr.set(dpr, canvas);
  return canvas;
}

/** A permanently-failed (shape, hue) pair still needs to carry its hue (hue
 * still means status, even without the shape detail) - a plain hue-coloured
 * dot in the same dark halo, cached per (hue, DPR bucket) (bounded to the
 * four status hues times `MAX_COMPOSE_DPR`, see model.js's STATUS_HUE and
 * glowSprite.js), never per shape. */
const shapeGlyphFallbackByKey = new Map();
function shapeGlyphFallbackCanvas(hue, dpr) {
  const key = `${hue}@${dpr}`;
  const cached = shapeGlyphFallbackByKey.get(key);
  if (cached) return cached;
  const dim = SHAPE_GLYPH_CANVAS_DIM;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(dim * dpr);
  canvas.height = Math.round(dim * dpr);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.scale(dpr, dpr);
    const centre = dim / 2;
    ctx.beginPath();
    ctx.arc(centre, centre, centre - 2, 0, Math.PI * 2);
    ctx.fillStyle = SHAPE_GLYPH_HALO_FILL;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(centre, centre, dim * 0.18, 0, Math.PI * 2);
    ctx.fillStyle = hue;
    ctx.fill();
  }
  shapeGlyphFallbackByKey.set(key, canvas);
  return canvas;
}

/**
 * Stable id (and cache key) for a (glyph URL, hue, DPR bucket) triple,
 * derived from the URL's own basename rather than the row's raw `craft`
 * string, so it always names the glyph actually rendered even when
 * `glyphUrlForShape` had to fall back (see shapeGlyphs.js). Starts with a
 * distinct `shape:` prefix so a caller (or a qa gate) can tell a
 * shape-glyph billboard's imageId apart from a glow sprite's own
 * `glow:`-prefixed one (glowSprite.js's `glowCacheKey`) at a glance. The DPR
 * bucket joins hue and shape as a third part (task: presence pass,
 * retina-sharp composition): a DPR-1 and a DPR-2 raster of the same
 * (shape, hue) are distinct content, so they need distinct ids, never a
 * shared one that would let one silently pre-empt the other in the texture
 * atlas.
 * @param {string} url
 * @param {string} hue
 * @param {number} dpr
 * @returns {string}
 */
function shapeGlyphImageId(url, hue, dpr) {
  const name = url.slice(url.lastIndexOf('/') + 1).replace(/\.svg$/, '');
  return `shape:${name}:${hue}@${dpr}`;
}

/** Composed shape-glyph billboard images, cached per (shape, hue, DPR
 * bucket) triple - module scope, shared across every renderer instance,
 * bounded to the shipped shape count times the four status hues times
 * `MAX_COMPOSE_DPR` (30 x 4 x 2 = 240 at most, see shapeGlyphs.js's
 * SHAPE_CATEGORIES, model.js's STATUS_HUE and glowSprite.js's
 * MAX_COMPOSE_DPR). A failed load caches shapeGlyphFallbackCanvas(hue, dpr)
 * as that triple's permanent result too, so the cache doubles as "do not
 * retry this pair" (see the
 * catch branch below - mirrors ancientSites/rendering.js's own
 * requestBillboardGlyph, commit f6a62d8). `shapeGlyphLoading` guards
 * against firing a second fetch for a pair already in flight;
 * `shapeGlyphSubscribers` are notified once a fetch settles, so an active
 * renderer can redraw its currently-visible glyph billboards from the
 * placeholder to the real glyph (or, on failure, to the permanent
 * hue-coloured fallback). */
const shapeGlyphCache = new Map();
const shapeGlyphLoading = new Set();
const shapeGlyphSubscribers = new Set();

/**
 * The cached composed billboard image for a (glyph URL, hue, DPR bucket)
 * triple, kicking off a load if this is the first request for it. Returns
 * `null` (caller should use `shapeGlyphPlaceholderCanvas(dpr)` meanwhile)
 * until the load settles.
 *
 * `dpr` is the caller's already-resolved DPR bucket (read once per
 * composition build - see `renderShapeGlyphBillboards`'s and setRows's own
 * `currentDprBucket()` call - task: presence pass, retina-sharp
 * composition), threaded through here rather than re-read internally so the
 * SAME value survives into the async `.then`/`.catch` below regardless of
 * when they settle.
 * @param {string} url
 * @param {string} hue
 * @param {number} dpr
 * @returns {HTMLCanvasElement|null}
 */
function requestShapeGlyph(url, hue, dpr) {
  const key = shapeGlyphImageId(url, hue, dpr);
  const ready = shapeGlyphCache.get(key);
  if (ready) return ready;
  if (!shapeGlyphLoading.has(key)) {
    shapeGlyphLoading.add(key);
    loadShapeGlyphImage(url)
      .then((image) => {
        shapeGlyphCache.set(key, composeShapeGlyphCanvas(image, hue, dpr));
      })
      .catch((error) => {
        console.warn(
          '[Data:Anomalies] Shape glyph failed to load:',
          url,
          error,
        );
        // See shapeGlyphFallbackCanvas's own doc comment: caching the
        // fallback here (not just returning it transiently) is what stops a
        // failed pair from being re-requested on every subsequent
        // renderShapeGlyphBillboards() call for as long as the camera sits
        // at close range over that shape.
        shapeGlyphCache.set(key, shapeGlyphFallbackCanvas(hue, dpr));
      })
      .finally(() => {
        shapeGlyphLoading.delete(key);
        for (const notify of shapeGlyphSubscribers) notify();
      });
  }
  return null;
}

// Thin-film sheen for hero craft: strongest at grazing angles, drifting slowly.
const SPECTRAL_FS = /* glsl */ `
  void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
    vec3 n = normalize(fsInput.attributes.normalEC);
    vec3 v = normalize(-fsInput.attributes.positionEC);
    float f = pow(1.0 - abs(dot(n, v)), 3.0);
    float phase = f * 1.6 + u_time * 0.04;
    vec3 film = 0.5 + 0.5 * cos(6.2831853 * (phase + vec3(0.0, 0.33, 0.67)));
    vec3 spectrum = mix(vec3(1.0, 0.18, 0.6), vec3(0.25, 0.88, 1.0), film.y) * mix(0.7, 1.0, film.x);
    material.emissive += spectrum * f * u_strength * (1.0 - clamp(material.emissive.r, 0.0, 1.0));
  }`;

// Infrared: every craft reads hot, including infrared-only ones that are
// otherwise fully transparent.
const INFRARED_FS = /* glsl */ `
  void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
    vec3 n = normalize(fsInput.attributes.normalEC);
    vec3 v = normalize(-fsInput.attributes.positionEC);
    float f = pow(1.0 - abs(dot(n, v)), 2.0);
    material.diffuse = vec3(0.0);
    material.emissive = mix(vec3(0.95, 0.55, 0.3), vec3(1.0, 0.97, 0.9), f) * (0.75 + 0.25 * sin(u_time * 3.0));
    material.alpha = 1.0;
  }`;

const hashDeg = (s) =>
  [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 360;

/** True when the visitor has asked for reduced motion. This module is
 * Cesium-side (it already imports Cesium and drives the scene directly),
 * where reading `window.matchMedia` is allowed, unlike the portable
 * records/source/model modules. Guarded for non-browser environments. */
function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
  );
}

/**
 * Owns every Cesium resource for the layer: one pair of point collections per
 * year (current and past), plus animated hero models.
 */
export function createAnomalyRenderer(
  viewer,
  {
    assetBase = '/anomalies/',
    render,
    host = () => resolveImageryHost({ viewer }),
  } = {},
) {
  const scene = viewer.scene;
  const bright = new Map();
  const faded = new Map();
  let heroes = [];
  let state = {
    visible: false,
    year: null,
    mode: 'cumulative',
    span: 2,
    infrared: false,
    statuses: null,
  };
  // Continuous frames only while something animates: hero loops or pulses.
  let holding = false;
  let reducedMotion = prefersReducedMotion();
  // Live: a visitor can flip the OS/browser reduced-motion setting while
  // the app is already running, so the query is watched rather than read
  // once at construction. Guarded the same way prefersReducedMotion() is,
  // for non-browser test environments.
  let motionQuery = null;
  let onMotionChange = null;
  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
  ) {
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    onMotionChange = (event) => {
      reducedMotion = event.matches;
    };
    motionQuery.addEventListener?.('change', onMotionChange);
  }
  const syncHold = () => {
    if (!render) return;
    const want = state.visible && (heroes.length > 0 || live.length > 0);
    if (want === holding) return;
    holding = want;
    if (want) render.holdContinuousRender(ANOMALY_LAYER_ID);
    else render.releaseContinuousRender(ANOMALY_LAYER_ID);
  };
  const requestFrame = (reason) =>
    render ? render.governorRequestRender(reason) : scene.requestRender();
  const uniforms = () => ({
    u_time: { type: Cesium.UniformType.FLOAT, value: 0 },
    u_strength: { type: Cesium.UniformType.FLOAT, value: 0.85 },
  });
  const spectral = new Cesium.CustomShader({
    uniforms: uniforms(),
    fragmentShaderText: SPECTRAL_FS,
  });
  const infrared = new Cesium.CustomShader({
    uniforms: uniforms(),
    fragmentShaderText: INFRARED_FS,
  });

  // Heat overlay: reports binned onto hotspots.js's default grid (so
  // blurBins's radius keeps the real-world extent it was tuned for), then
  // drawn ion-to-magenta and upsampled (bilinear) onto a 1440x720 canvas:
  // a smoother glow than binning at full canvas resolution, for a fraction
  // of the blur cost. Cesium-side only: no portability constraint here.
  const HEAT_BIN_WIDTH = 720;
  const HEAT_BIN_HEIGHT = 360;
  const HEAT_CANVAS_WIDTH = 1440;
  const HEAT_CANVAS_HEIGHT = 720;
  const HEAT_BLUR_RADIUS = 2;
  const HEAT_ALPHA = 0.55;
  const HEAT_DEBOUNCE_MS = 250;
  const hexToRgb = (hex) =>
    [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const heatIonRgb = hexToRgb(PALETTE.ion);
  const heatMagentaRgb = hexToRgb(PALETTE.magenta);
  const heatBinCanvas = document.createElement('canvas');
  heatBinCanvas.width = HEAT_BIN_WIDTH;
  heatBinCanvas.height = HEAT_BIN_HEIGHT;
  const heatBinCtx = heatBinCanvas.getContext('2d');
  const heatCanvas = document.createElement('canvas');
  heatCanvas.width = HEAT_CANVAS_WIDTH;
  heatCanvas.height = HEAT_CANVAS_HEIGHT;
  const heatCtx = heatCanvas.getContext('2d');
  heatCtx.imageSmoothingEnabled = true;
  let heatRows = [];
  let heatOn = false;
  let heatFilter;
  let heatLayer = null;
  // The collection the current heatLayer actually lives on, so it is
  // removed from the same place it was added, even if the map stack (and
  // so the resolved host) changed in between.
  let heatHostCollection = null;
  // NO_IMAGERY_HOST while the active map stack has nowhere to drape heat
  // (host().kind === 'none'); null once a globe or tileset host resolves.
  let heatStatus = null;
  let heatTimer = null;

  /** Paint the density ramp (ion low, magenta high) and return a data: URL. */
  function paintHeat(filter) {
    const bins = binRows(heatRows, {
      width: HEAT_BIN_WIDTH,
      height: HEAT_BIN_HEIGHT,
      filter,
    });
    const blurred = blurBins(
      bins,
      HEAT_BIN_WIDTH,
      HEAT_BIN_HEIGHT,
      HEAT_BLUR_RADIUS,
    );
    let max = 0;
    for (let i = 0; i < blurred.length; i++)
      if (blurred[i] > max) max = blurred[i];
    const image = heatBinCtx.createImageData(HEAT_BIN_WIDTH, HEAT_BIN_HEIGHT);
    const data = image.data;
    for (let i = 0; i < blurred.length; i++) {
      const value = blurred[i];
      const ratio = max > 0 ? Math.min(1, value / max) : 0;
      const p = i * 4;
      data[p] = heatIonRgb[0] + (heatMagentaRgb[0] - heatIonRgb[0]) * ratio;
      data[p + 1] = heatIonRgb[1] + (heatMagentaRgb[1] - heatIonRgb[1]) * ratio;
      data[p + 2] = heatIonRgb[2] + (heatMagentaRgb[2] - heatIonRgb[2]) * ratio;
      data[p + 3] = Math.round(heatAlpha(value, max) * 255);
    }
    heatBinCtx.putImageData(image, 0, 0);
    heatCtx.clearRect(0, 0, HEAT_CANVAS_WIDTH, HEAT_CANVAS_HEIGHT);
    heatCtx.drawImage(
      heatBinCanvas,
      0,
      0,
      HEAT_CANVAS_WIDTH,
      HEAT_CANVAS_HEIGHT,
    );
    return heatCanvas.toDataURL('image/png');
  }

  /**
   * Repaint the heat texture and swap it in on whatever surface the active
   * map stack can host draped imagery on (a globe, or a 3D tileset's own
   * imageryLayers), resolved fresh on every swap through imageryHost.js's
   * `host()` so a map-stack change is picked up at the next toggle or dial
   * step rather than staying stuck on a stale collection. When the stack
   * has nowhere to drape imagery, no layer is created and `heatStatus`
   * carries `NO_IMAGERY_HOST` instead, so the caller can surface it.
   * SingleTileImageryProvider is immutable once created, so a fresh
   * provider is added and the old layer removed (from whichever collection
   * it actually lives on) once the new one is in place; a one-shot
   * governed render covers the swap (the overlay never holds continuous
   * render).
   */
  function swapHeatLayer(filter) {
    const { collection } = host() || {};
    const old = heatLayer;
    const oldCollection = heatHostCollection;
    heatLayer = null;
    heatHostCollection = null;
    heatStatus = collection ? null : NO_IMAGERY_HOST;
    if (collection) {
      const provider = new Cesium.SingleTileImageryProvider({
        url: paintHeat(filter),
        tileWidth: HEAT_CANVAS_WIDTH,
        tileHeight: HEAT_CANVAS_HEIGHT,
        rectangle: Cesium.Rectangle.fromDegrees(-180, -90, 180, 90),
      });
      heatLayer = collection.addImageryProvider(provider);
      heatLayer.alpha = HEAT_ALPHA;
      heatHostCollection = collection;
    }
    if (old && oldCollection) oldCollection.remove(old, true);
    requestFrame('anomalies-heat');
  }

  function cancelHeatDebounce() {
    if (heatTimer) {
      clearTimeout(heatTimer);
      heatTimer = null;
    }
  }

  /**
   * Add or remove the heat imagery layer. Turning on repaints and swaps in
   * immediately, so the layer never lags the toggle; turning off cancels
   * any pending debounced swap. `filter` is the row predicate for the
   * immediate paint (the same shape `refreshHeat` takes) so the first
   * frame already honours the dial instead of briefly showing every row;
   * when omitted, the last filter passed to `refreshHeat` is reused.
   * @param {boolean} on
   * @param {(row: object) => boolean} [filter]
   */
  function setHeat(on, filter) {
    const next = !!on;
    if (filter !== undefined) heatFilter = filter;
    if (next === heatOn) return;
    heatOn = next;
    cancelHeatDebounce();
    if (!heatOn) {
      const old = heatLayer;
      const oldCollection = heatHostCollection;
      heatLayer = null;
      heatHostCollection = null;
      heatStatus = null;
      if (old && oldCollection) oldCollection.remove(old, true);
      requestFrame('anomalies-heat');
      return;
    }
    swapHeatLayer(heatFilter);
  }

  /**
   * Recompute the heat texture for the current row filter. A no-op while
   * heat is off; otherwise debounced 250 ms so rapid dial input (arrow
   * repeat, drag) coalesces into a single texture swap.
   * @param {(row: object) => boolean} [filter]
   */
  function refreshHeat(filter) {
    heatFilter = filter;
    if (!heatOn) return;
    cancelHeatDebounce();
    heatTimer = setTimeout(() => {
      heatTimer = null;
      swapHeatLayer(heatFilter);
    }, HEAT_DEBOUNCE_MS);
  }

  const t0 = performance.now();
  const tick = () => {
    if (!state.visible || !heroes.length) return;
    const t = (performance.now() - t0) / 1000;
    spectral.setUniform('u_time', t);
    infrared.setUniform('u_time', t);
    // Hero loops need frames; the governor hold covers this when injected.
    if (!render) scene.requestRender();
  };
  // Arrival pulses: a ring blooms at each report as its year arrives. Under
  // reduced motion (see prefersReducedMotion above) a ring never grows or
  // fades: it appears once at a fixed, fully-bloomed size and alpha, holds
  // there unchanged, then is removed outright once PULSE_MS elapses -
  // never a per-frame tween.
  const pulses = scene.primitives.add(
    new Cesium.PointPrimitiveCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    }),
  );
  let live = [];
  const PULSE_MS = 1600;
  const REDUCED_PULSE_PIXEL_SIZE = 26;
  const REDUCED_PULSE_ALPHA = 0.6;
  const stepPulses = () => {
    if (!live.length) return;
    const now = performance.now();
    live = live.filter((p) => {
      const t = (now - p.start) / PULSE_MS;
      if (t >= 1) {
        pulses.remove(p.point);
        return false;
      }
      if (!reducedMotion) {
        p.point.pixelSize = 6 + 34 * t;
        p.point.outlineColor = p.color.withAlpha(0.9 * (1 - t) * (1 - t));
      }
      return true;
    });
    if (!render) scene.requestRender();
    syncHold();
  };
  const removeTick = viewer.clock.onTick.addEventListener(() => {
    tick();
    stepPulses();
  });
  function pulse(rows) {
    if (!state.visible) return;
    const start = performance.now();
    for (const r of rows.slice(0, 400)) {
      const [red, green, blue] = pointColor(r);
      const color = new Cesium.Color(red, green, blue, 1);
      const point = pulses.add({
        position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 0),
        pixelSize: reducedMotion ? REDUCED_PULSE_PIXEL_SIZE : 6,
        color: Cesium.Color.TRANSPARENT,
        outlineColor: reducedMotion
          ? color.withAlpha(REDUCED_PULSE_ALPHA)
          : color,
        outlineWidth: 1.5,
      });
      live.push({ point, start, color });
    }
    syncHold();
    requestFrame('anomalies-pulse');
  }

  function collection(map, year) {
    let c = map.get(year);
    if (!c) {
      c = scene.primitives.add(
        new Cesium.BillboardCollection({
          scene,
          blendOption: Cesium.BlendOption.TRANSLUCENT,
        }),
      );
      c.show = false;
      map.set(year, c);
    }
    return c;
  }

  // Hero ion ring (DESIGN_SYSTEM.md: "ion ring: curated hero case with a 3D
  // craft"): today's PointPrimitive draws this as an outlineColor/
  // outlineWidth ring straddling the point's own edge. A billboard has no
  // outline concept, so a hero row instead gets a SECOND billboard: a
  // ring-only sprite (transparent centre, a stroked ion ring, transparent
  // outside), added just after the row's own glow sprite at a slightly
  // larger display size so the ring sits just outside the glow rather than
  // overlapping it. Composed once, lazily, and cached forever (a single
  // canvas, not bucketed by size: the ring is a thin vector stroke, and the
  // billboard's own width/height scale it continuously to match the row's
  // point size exactly as the old outline scaled with pixelSize). Reused
  // as-is by the shape-glyph tier below for a glyphed hero row's own ring.
  const HERO_RING_IMAGE_ID = 'anomaly-hero-ring';
  const HERO_RING_DISPLAY_SCALE = 1.35;
  const HERO_RING_CANVAS_DIM = 48;
  /** `imageId` for the hero ring canvas at a given DPR bucket (task:
   * presence pass, retina-sharp composition): a DPR-1 and a DPR-2 ring
   * raster are distinct content, so each needs its own atlas id. */
  const heroRingImageId = (dpr) => `${HERO_RING_IMAGE_ID}@${dpr}`;
  /** Composed once per DPR bucket (at most `MAX_COMPOSE_DPR`-many entries -
   * see glowSprite.js), not a single canvas: same retina treatment as every
   * other composer in this module - `dim` stays the logical drawing size,
   * the canvas's own `width`/`height` scale by `dpr` via `ctx.scale`. */
  const heroRingCanvasByDpr = new Map();
  function heroRingImage(dpr) {
    const cached = heroRingCanvasByDpr.get(dpr);
    if (cached) return cached;
    const dim = HERO_RING_CANVAS_DIM;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(dim * dpr);
    canvas.height = Math.round(dim * dpr);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.scale(dpr, dpr);
      const centre = dim / 2;
      ctx.beginPath();
      ctx.arc(centre, centre, centre * 0.72, 0, Math.PI * 2);
      ctx.lineWidth = dim * 0.09;
      ctx.strokeStyle = PALETTE.ion;
      ctx.stroke();
    }
    heroRingCanvasByDpr.set(dpr, canvas);
    return canvas;
  }

  /** Shared `scaleByDistance` for every point-tier billboard (glow sprites
   * in setRows below and shape glyphs in renderShapeGlyphBillboards): kept
   * identical across both tiers so a row's on-screen size does not visibly
   * jump at the moment it crosses SHAPE_GLYPH_HEIGHT_THRESHOLD_M. */
  const GLOW_SCALE_BY_DISTANCE = new Cesium.NearFarScalar(
    2.0e5,
    1.6,
    2.0e7,
    0.75,
  );

  // Close-range shape glyphs (task 2, luminous-pins): a SEPARATE billboard
  // collection, never mixed into bright/faded above. The glow-sprite
  // billboards in bright/faded are built once in setRows() and, per the
  // luminous-pins task 1 report's own finding, must never have their
  // image/imageId reassigned on the same frame as a size change (it breaks
  // picking within about a second) - so this tier does not touch them at
  // all beyond their ordinary `show` flag (see glyphedIds/syncPointVisibility
  // below, the same mechanism the status filter already uses). It is
  // rebuilt wholesale (`removeAll()` then fresh `add()`s, never an in-place
  // image swap on an existing billboard) only on a throttled/settled camera
  // move or a state change (year, mode, status filter) - never a tick path -
  // mirroring ancientSites/rendering.js's own sweepBillboards tier.
  const shapeGlyphBillboards = scene.primitives.add(
    new Cesium.BillboardCollection({
      scene,
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    }),
  );
  shapeGlyphBillboards.show = false;
  /** Anomaly ids currently rendered as a shape glyph: `syncPointVisibility`
   * hides exactly these rows' glow-sprite billboards (in bright/faded)
   * underneath, so the two tiers never double-render the same row. */
  let glyphedIds = new Set();

  // Selection ring (task: presence pass, hover and selection feedback):
  // while the dossier is open for a row, its point carries a ring - the
  // same hero ion-ring idiom (`heroRingImage`) reused verbatim, never a
  // second composed sprite. A dedicated collection, at most one billboard
  // at a time, rebuilt wholesale on every `setSelected` call (a rare user
  // action - opening or closing a dossier - never a tick or camera-move
  // path, so a removeAll()+add() here costs nothing worth measuring).
  const selectionRingBillboards = scene.primitives.add(
    new Cesium.BillboardCollection({
      scene,
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    }),
  );
  selectionRingBillboards.show = false;
  let selectedAnomalyId = null;

  /** Camera height (metres) above the ellipsoid; +Infinity off-globe. */
  function cameraHeight() {
    return (
      viewer.camera?.positionCartographic?.height ?? Number.POSITIVE_INFINITY
    );
  }

  /**
   * Below this height every point in view swaps to a shape-glyph billboard;
   * at or above it, the neutral glow sprite (above) stays. Matches
   * ancientSites/clusters.js's own CAMERA_BANDS closest-band cutoff
   * (500,000m, the height below which its own sweep singles become gold
   * -glyph billboards too): a shared cutoff means a visitor crossing into
   * "shape-legible" range sees both registers change together, one
   * consistent close-range transition rather than two arbitrary,
   * independently-tuned ones. It is also roughly the altitude at which
   * individual reports in the shipped dataset's own densest cluster (GEIPAN,
   * concentrated around France) separate into distinguishable points rather
   * than a solid smear (see the task 2 report's own measurements).
   */
  const SHAPE_GLYPH_HEIGHT_THRESHOLD_M = 500_000;
  /** Extra margin (fraction of the view rectangle's own size) added around
   * the current view before filtering candidate rows, so a small pan does
   * not immediately pop points in/out of glyph mode at the screen edge -
   * mirrors ancientSites/rendering.js's own CLOSE_BAND_VIEW_PADDING. */
  const SHAPE_GLYPH_VIEW_PADDING = 0.3;
  /**
   * Measured (task 2 report): the shipped dataset is heavily concentrated
   * around GEIPAN's own France coverage - a view centred there at exactly
   * the height threshold above holds on the order of 2,500-2,800 rows
   * before any cap, comfortably past a sane per-recompute billboard-rebuild
   * cost. Candidates beyond this cap are dropped by distance from the view
   * rectangle's own centre (nearest first, see renderShapeGlyphBillboards),
   * never arbitrarily, so a capped view still reads as "the middle of
   * what's on screen" rather than a ragged partial fill.
   *
   * This caps candidate ROWS, not billboards: a hero row adds a second
   * billboard (its ion ring, see the `r.hero` branch in
   * renderShapeGlyphBillboards), so the actual billboard count for a capped
   * view can run up to 2x this figure when every capped-in candidate
   * happens to be a hero - never more, since the row scan itself is capped
   * here before any billboards are added.
   */
  const MAX_SHAPE_GLYPH_BILLBOARDS = 2000;
  const SHAPE_RECOMPUTE_THROTTLE_MS = 250;

  /** Current view rectangle padded outward, in degrees; null off-globe or
   * when the camera is pitched above the horizon (no rectangle to bound
   * against - routine at close range). No antimeridian unwrap, unlike
   * ancientSites/clusters.js's wrapLon-aware version: when a view straddles
   * the ±180° seam, `west` ends up greater than `east` here, and the
   * candidate scan's plain `r.lon < bounds.west || r.lon > bounds.east`
   * check (renderShapeGlyphBillboards) then rejects every row, not just
   * the ones near the seam - the WHOLE view keeps its ordinary glow sprites
   * instead of glyphs until the camera moves off the seam. A cosmetic miss,
   * not a correctness bug (picking, hue and count stay right; only the
   * close-range glyph swap sits out), and rare enough at the close ranges
   * this tier operates in to leave unhandled here. */
  function paddedShapeGlyphViewBoundsDeg() {
    let rect;
    try {
      rect = viewer.camera.computeViewRectangle(scene.globe.ellipsoid);
    } catch {
      return null;
    }
    if (!rect) return null;
    const widthRad = Cesium.Rectangle.computeWidth(rect);
    const heightRad = Cesium.Rectangle.computeHeight(rect);
    const padRad = ((widthRad + heightRad) / 2) * SHAPE_GLYPH_VIEW_PADDING;
    return {
      west: Cesium.Math.toDegrees(rect.west - padRad),
      south: Math.max(-90, Cesium.Math.toDegrees(rect.south - padRad)),
      east: Cesium.Math.toDegrees(rect.east + padRad),
      north: Math.min(90, Cesium.Math.toDegrees(rect.north + padRad)),
    };
  }

  /** Stable string key for a bounds rectangle (or its absence), for the
   * nothing-changed guard below; mirrors ancientSites/rendering.js's own
   * boundsKeyOf. */
  function shapeGlyphBoundsKeyOf(bounds) {
    return bounds
      ? `${bounds.west.toFixed(3)},${bounds.south.toFixed(3)},${bounds.east.toFixed(3)},${bounds.north.toFixed(3)}`
      : null;
  }

  /** Whether the status filter currently passes a row (same predicate
   * apply()'s visibility pass and the shape-glyph candidate scan both use,
   * so the two tiers never disagree about which rows are hidden). */
  function passesStatus(status) {
    return !state.statuses || state.statuses.has(status);
  }

  /**
   * Sync every glow-sprite billboard's own `show` flag from the status
   * filter AND the current glyphed set: a row passes the status filter but
   * is hidden here if - and only if - it is currently rendered as a shape
   * glyph instead (see glyphedIds above). Never touches `image`/`imageId`,
   * only `show` - safe to call as often as needed, including from a
   * throttled camera-move recompute, unlike a real image swap.
   */
  function syncPointVisibility() {
    for (const map of [bright, faded])
      for (const [, c] of map)
        for (let i = 0; i < c.length; i++) {
          const p = c.get(i);
          p.show = passesStatus(p.id.status) && !glyphedIds.has(p.id.anomalyId);
        }
  }

  // Nothing-changed guard for the tier rebuilt below: while the camera sits
  // parked below SHAPE_GLYPH_HEIGHT_THRESHOLD_M with heroes or pulses
  // holding continuous render (see syncHold), scene.postRender fires every
  // frame and installShapeGlyphWatcher's listener calls recomputeShapeGlyphs()
  // at most every SHAPE_RECOMPUTE_THROTTLE_MS - still up to 4 times a
  // second, forever, with nothing new to draw. These hold the inputs of the
  // last actual rebuild (the same predicate inputs apply() uses to decide
  // bright/faded/status visibility, plus the camera-height band), so a
  // recompute whose inputs all match can skip the removeAll()/row-scan/
  // billboard-add/syncPointVisibility work entirely. Mirrors
  // ancientSites/rendering.js's own recomputeSweep guard, whose comment
  // names this exact hazard. `undefined` on every field until the first
  // real build, so that build is never mistaken for a match.
  let lastGlyphRenderBand;
  let lastGlyphRenderBoundsKey;
  let lastGlyphRenderYear;
  let lastGlyphRenderMode;
  let lastGlyphRenderSpan;
  let lastGlyphRenderStatuses;
  /** Rebuilds actually performed (i.e. not short-circuited by the guard
   * above) this session - a qa/diagnostic counter only (see getDiagnostics
   * below), not read by any rendering logic. */
  let shapeGlyphRebuildCount = 0;

  /**
   * Rebuild the shape-glyph billboard tier from scratch for the current
   * camera view and dial/filter state: candidates are rows currently
   * "active" for the dial (inWindow, matching the SAME bright/faded logic
   * apply() uses) and the status filter, whose position falls inside the
   * padded view rectangle. Never a tick path - see the recompute/watcher
   * functions below, which throttle and settle calls into this one.
   *
   * Guarded by the nothing-changed check above: a call whose bounds key,
   * year, mode, span and statuses (by reference - index.js only ever
   * reassigns `activeStatuses` to a new Set when the filter itself changes,
   * never on every apply()) all match the last real build returns
   * immediately. `force` bypasses the guard for onShapeGlyphReady's own
   * redraw, whose recompute inputs are unchanged but whose glyph IMAGE just
   * did (a (shape, hue) pair upgraded from the placeholder to a real
   * composed glyph, or to the failure fallback).
   * @param {{force?: boolean}} [options]
   */
  function renderShapeGlyphBillboards({ force = false } = {}) {
    const bounds = paddedShapeGlyphViewBoundsDeg();
    const band =
      cameraHeight() >= SHAPE_GLYPH_HEIGHT_THRESHOLD_M ? 'above' : 'below';
    const boundsKey = shapeGlyphBoundsKeyOf(bounds);
    if (
      !force &&
      band === lastGlyphRenderBand &&
      boundsKey === lastGlyphRenderBoundsKey &&
      state.year === lastGlyphRenderYear &&
      state.mode === lastGlyphRenderMode &&
      state.span === lastGlyphRenderSpan &&
      state.statuses === lastGlyphRenderStatuses
    ) {
      return;
    }
    lastGlyphRenderBand = band;
    lastGlyphRenderBoundsKey = boundsKey;
    lastGlyphRenderYear = state.year;
    lastGlyphRenderMode = state.mode;
    lastGlyphRenderSpan = state.span;
    lastGlyphRenderStatuses = state.statuses;
    shapeGlyphRebuildCount += 1;
    // Presence-pass fix round finding 1: this tier's own billboards are the
    // brighten TARGETS a live hover may hold references to in
    // `hoveredOriginals` (see setHovered/forEachAnomalyBillboard above).
    // `removeAll()` below destroys them, so restore-and-clear FIRST, while
    // the old billboards are still valid, rather than ever writing to a
    // destroyed one later. Re-applied by id (never by the old reference)
    // once the new billboards exist, below - a same-id hover survives the
    // rebuild with the correct brighten re-applied to the NEW billboard; an
    // id that no longer renders anywhere (forEachAnomalyBillboard finds
    // nothing) simply stays un-brightened until it moves back into view,
    // with no stale state left behind either way.
    if (hoveredAnomalyId != null) restoreHovered();
    shapeGlyphBillboards.removeAll();
    const nextIds = new Set();
    // Read once for this whole rebuild pass (task: presence pass,
    // retina-sharp composition), not per candidate: every billboard added
    // below shares the same DPR bucket, matching composeGlowSprite's own
    // "one composition, one DPR read" discipline.
    const dpr = currentDprBucket();
    if (bounds) {
      let candidates = [];
      // heatRows already carries the full row set (see setRows below) - no
      // separate copy kept just for this tier.
      for (const r of heatRows) {
        if (!inWindow(r, state.year, state.mode, state.span)) continue;
        if (!passesStatus(r.status)) continue;
        if (r.lat < bounds.south || r.lat > bounds.north) continue;
        if (r.lon < bounds.west || r.lon > bounds.east) continue;
        candidates.push(r);
      }
      if (candidates.length > MAX_SHAPE_GLYPH_BILLBOARDS) {
        const centreLat = (bounds.south + bounds.north) / 2;
        const centreLon = (bounds.west + bounds.east) / 2;
        const dist2 = (r) => {
          const dLat = r.lat - centreLat;
          const dLon = r.lon - centreLon;
          return dLat * dLat + dLon * dLon;
        };
        candidates.sort((a, b) => dist2(a) - dist2(b));
        candidates = candidates.slice(0, MAX_SHAPE_GLYPH_BILLBOARDS);
      }
      for (const r of candidates) {
        nextIds.add(r.id);
        const hue = statusHue(r.status);
        const url = glyphUrlForShape(r.craft);
        const composed = requestShapeGlyph(url, hue, dpr);
        const isFaded =
          state.mode === 'cumulative' &&
          state.year != null &&
          r.year < state.year;
        const size = pointSize(r, { current: !isFaded });
        const alpha = pointAlpha(r, { current: !isFaded });
        const id = { id: `anomaly:${r.id}`, anomalyId: r.id, status: r.status };
        shapeGlyphBillboards.add({
          id,
          position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 0),
          image: composed || shapeGlyphPlaceholderCanvas(dpr),
          imageId: composed
            ? shapeGlyphImageId(url, hue, dpr)
            : shapeGlyphPlaceholderImageId(dpr),
          width: size,
          height: size,
          color: Cesium.Color.WHITE.withAlpha(alpha),
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          scaleByDistance: GLOW_SCALE_BY_DISTANCE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
        if (r.hero) {
          shapeGlyphBillboards.add({
            // A distinct `id` object (`ring: true`), not the shared `id`
            // above: hover's own billboard scan (`forEachAnomalyBillboard`
            // below) must brighten only the primary point, never double up
            // on this permanent hero ring - both carry the same
            // `anomalyId` (so a pick landing on either still resolves the
            // right row), but only an untagged one is a brighten target.
            id: { ...id, ring: true },
            position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 0),
            image: heroRingImage(dpr),
            imageId: heroRingImageId(dpr),
            width: size * HERO_RING_DISPLAY_SCALE,
            height: size * HERO_RING_DISPLAY_SCALE,
            color: Cesium.Color.WHITE.withAlpha(isFaded ? 0.35 : 0.9),
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            scaleByDistance: GLOW_SCALE_BY_DISTANCE,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          });
        }
      }
    }
    glyphedIds = nextIds;
    syncPointVisibility();
    shapeGlyphBillboards.show = state.visible && glyphedIds.size > 0;
    // Re-apply the hover brighten by id now the new billboards exist (see
    // this function's own restore above) - a no-op scan when the hovered id
    // is not currently shown in any tier.
    if (hoveredAnomalyId != null) applyHoverBrighten(hoveredAnomalyId);
    requestFrame('anomalies-shape-glyphs');
  }

  /** Glyph assets load asynchronously (see requestShapeGlyph above). Eager,
   * not lazy per pair: every (shape, hue) combination is requested below,
   * at renderer creation - which is already deferred to the layer's own
   * first enable, not app boot (src/data/lifecycle.js only calls a layer's
   * `init` the first time it is enabled), so this warm-up costs nothing
   * before a visitor ever opens the register. Firing the whole burst at
   * once (rather than, say, only the pair a billboard first needs) is
   * deliberate: they are 30 tiny, same-origin SVGs
   * (public/anomalies/glyphs/), cheap enough as one burst that the cache is
   * normally warm well before a visitor reaches close-zoom range - which is
   * what "composed lazily" in the plan's own Task 2 checklist means
   * (composed on first use of the SESSION, never per row), not staggered
   * further. When a pair does finish loading after a billboard was already
   * drawn with the placeholder, redraw so it upgrades without waiting for
   * the next camera move (mirrors ancientSites/rendering.js's own
   * onGlyphReady); `force: true` bypasses renderShapeGlyphBillboards's own
   * nothing-changed guard, since the recompute inputs have not changed here
   * - only the glyph image has. */
  function onShapeGlyphReady() {
    if (state.visible && glyphedIds.size) {
      renderShapeGlyphBillboards({ force: true });
      requestFrame('anomalies-shape-glyph-ready');
    }
  }
  shapeGlyphSubscribers.add(onShapeGlyphReady);
  // One DPR read for the whole warm-up burst (task: presence pass,
  // retina-sharp composition): every pair below shares it, matching the
  // "one composition, one DPR read" discipline used everywhere else in this
  // module.
  const warmDpr = currentDprBucket();
  for (const shape of SHAPE_CATEGORIES)
    for (const hue of Object.values(STATUS_HUE))
      requestShapeGlyph(glyphUrlForShape(shape), hue, warmDpr);

  /** Recompute now if the camera height is below threshold, otherwise clear
   * the glyph tier back to nothing (restoring the glow sprites, via
   * syncPointVisibility). A no-op while the register is not visible. */
  function recomputeShapeGlyphs() {
    if (!state.visible) return;
    if (cameraHeight() >= SHAPE_GLYPH_HEIGHT_THRESHOLD_M) {
      if (glyphedIds.size || shapeGlyphBillboards.length) {
        // Presence-pass fix round finding 1: the same stale-billboard-
        // reference risk as renderShapeGlyphBillboards's own rebuild above -
        // a threshold crossing clears this tier to nothing independently of
        // hover state. Restore before removeAll destroys the old
        // billboards, then re-apply by id after: syncPointVisibility below
        // hands the row back to the bright/faded glow-sprite tier, so the
        // re-scan finds and re-brightens it there.
        if (hoveredAnomalyId != null) restoreHovered();
        shapeGlyphBillboards.removeAll();
        glyphedIds = new Set();
        syncPointVisibility();
        shapeGlyphBillboards.show = false;
        if (hoveredAnomalyId != null) applyHoverBrighten(hoveredAnomalyId);
        requestFrame('anomalies-shape-glyphs-off');
      }
      // Invalidate renderShapeGlyphBillboards's own nothing-changed guard:
      // the tier was just cleared out from under whatever key it last built
      // with (or was already empty), so a later return below threshold must
      // rebuild even if bounds/year/mode/span/statuses land back on exactly
      // the values the tier was last built with - a real threshold crossing,
      // not a no-op recompute.
      lastGlyphRenderBand = undefined;
      return;
    }
    renderShapeGlyphBillboards();
  }

  let shapeGlyphBandRemover = null;
  let shapeGlyphMoveEndRemover = null;
  let shapeGlyphSettleTimer = null;
  let lastShapeGlyphRecomputeAt = 0;

  /** Recompute now if the throttle window has elapsed since the last one,
   * otherwise defer to the moveEnd-style settle timer, so a flood of
   * requests inside the same window (dragging the camera) collapses into at
   * most one settle recompute. Mirrors ancientSites/rendering.js's own
   * requestSweepRecompute/scheduleRecompute. */
  function requestShapeGlyphRecompute() {
    if (!state.visible) return;
    const now = performance.now();
    if (now - lastShapeGlyphRecomputeAt < SHAPE_RECOMPUTE_THROTTLE_MS) {
      scheduleShapeGlyphRecompute();
      return;
    }
    lastShapeGlyphRecomputeAt = now;
    recomputeShapeGlyphs();
  }

  function scheduleShapeGlyphRecompute() {
    clearTimeout(shapeGlyphSettleTimer);
    shapeGlyphSettleTimer = setTimeout(() => {
      lastShapeGlyphRecomputeAt = performance.now();
      recomputeShapeGlyphs();
    }, SHAPE_RECOMPUTE_THROTTLE_MS + 40);
  }

  function installShapeGlyphWatcher() {
    if (shapeGlyphBandRemover || !viewer) return;
    // Seed the throttle clock now, before apply()'s own direct
    // recomputeShapeGlyphs() call runs, so the very next postRender tick
    // does not also see a stale lastShapeGlyphRecomputeAt and immediately
    // fire a redundant second recompute right after enable.
    lastShapeGlyphRecomputeAt = performance.now();
    shapeGlyphBandRemover = scene.postRender.addEventListener(() => {
      if (!state.visible) return;
      const now = performance.now();
      if (now - lastShapeGlyphRecomputeAt < SHAPE_RECOMPUTE_THROTTLE_MS) return;
      lastShapeGlyphRecomputeAt = now;
      recomputeShapeGlyphs();
    });
    shapeGlyphMoveEndRemover = viewer.camera.moveEnd.addEventListener(() => {
      if (!state.visible) return;
      scheduleShapeGlyphRecompute();
    });
  }

  function removeShapeGlyphWatcher() {
    if (shapeGlyphBandRemover) {
      shapeGlyphBandRemover();
      shapeGlyphBandRemover = null;
    }
    if (shapeGlyphMoveEndRemover) {
      shapeGlyphMoveEndRemover();
      shapeGlyphMoveEndRemover = null;
    }
    clearTimeout(shapeGlyphSettleTimer);
    shapeGlyphSettleTimer = null;
  }

  function clearPoints() {
    for (const c of [...bright.values(), ...faded.values()])
      scene.primitives.remove(c);
    bright.clear();
    faded.clear();
  }

  function setRows(rows) {
    heatRows = rows;
    // Fix wave (presence pass): setRows rebuilds the bright/faded billboard
    // collections from scratch (clearPoints), which a live hover may hold
    // stale `{billboard, color}` references into (hoveredOriginals - see
    // setHovered/forEachAnomalyBillboard below). Restore-and-clear FIRST,
    // while the old billboards are still valid, then re-apply by id once
    // the new ones exist, mirroring renderShapeGlyphBillboards's own
    // rebuild bracket above.
    if (hoveredAnomalyId != null) restoreHovered();
    clearPoints();
    // Read once for this whole build pass (task: presence pass, retina-sharp
    // composition): every billboard added below shares the same DPR bucket.
    const dpr = currentDprBucket();
    for (const r of rows) {
      const position = Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 0);
      const [red, green, blue] = pointColor(r);
      for (const [map, current] of [
        [bright, true],
        [faded, false],
      ]) {
        const size = pointSize(r, { current });
        const coll = collection(map, r.year);
        coll.add({
          id: { id: `anomaly:${r.id}`, anomalyId: r.id, status: r.status },
          position,
          image: glowImage(size),
          imageId: glowImageId(size, dpr),
          width: size,
          height: size,
          color: new Cesium.Color(red, green, blue, pointAlpha(r, { current })),
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          scaleByDistance: GLOW_SCALE_BY_DISTANCE,
          // Ground-level billboards depth-test against the globe by default,
          // unlike the plain points they replace (see the matching comment
          // on ancientSites/rendering.js's own sweep billboards, which hit
          // the identical intermittent depth-precision miss at close range).
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
        if (r.hero) {
          // `ring: true` - see the matching comment on
          // renderShapeGlyphBillboards's own hero-ring add above.
          coll.add({
            id: {
              id: `anomaly:${r.id}`,
              anomalyId: r.id,
              status: r.status,
              ring: true,
            },
            position,
            image: heroRingImage(dpr),
            imageId: heroRingImageId(dpr),
            width: size * HERO_RING_DISPLAY_SCALE,
            height: size * HERO_RING_DISPLAY_SCALE,
            color: Cesium.Color.WHITE.withAlpha(current ? 0.9 : 0.35),
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            scaleByDistance: GLOW_SCALE_BY_DISTANCE,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          });
        }
      }
    }
    // Re-apply the hover brighten by id now the new billboards exist (see
    // this function's own restore above) - a no-op scan when the hovered id
    // is not currently shown in any tier. apply() below issues its own
    // requestFrame, after this, so the reapplied brighten is never dropped
    // from the frame it lands in.
    if (hoveredAnomalyId != null) applyHoverBrighten(hoveredAnomalyId);
    apply();
  }

  async function setHeroes(rows) {
    for (const h of heroes) scene.primitives.remove(h.model);
    heroes = [];
    for (const r of rows) {
      const origin = Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 650);
      const hpr = new Cesium.HeadingPitchRoll(
        Cesium.Math.toRadians(hashDeg(r.id)),
        0,
        0,
      );
      try {
        const model = await Cesium.Model.fromGltfAsync({
          url: `${assetBase}crafts/${r.craft}.glb`,
          modelMatrix: Cesium.Transforms.headingPitchRollToFixedFrame(
            origin,
            hpr,
          ),
          heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
          scene,
          minimumPixelSize: 56,
          maximumScale: 40000,
          customShader: state.infrared ? infrared : spectral,
          id: { id: `anomaly:${r.id}`, anomalyId: r.id, status: r.status },
        });
        model.readyEvent.addEventListener(() =>
          model.activeAnimations.addAll({
            loop: Cesium.ModelAnimationLoop.REPEAT,
          }),
        );
        scene.primitives.add(model);
        heroes.push({ row: r, model });
      } catch (error) {
        console.warn('[Data:Anomalies] Craft failed to load', r.craft, error);
      }
    }
    apply();
  }

  function apply(next = {}) {
    state = { ...state, ...next };
    const { visible, year, mode, span } = state;
    for (const [y, c] of bright)
      c.show =
        visible &&
        (mode === 'all' ||
          year == null ||
          (mode === 'window' ? Math.abs(y - year) <= span : y === year));
    for (const [y, c] of faded)
      c.show = visible && mode === 'cumulative' && year != null && y < year;
    // Every glow-sprite billboard's own show flag (status filter AND not
    // currently rendered as a shape glyph instead - see syncPointVisibility
    // and glyphedIds above).
    syncPointVisibility();
    for (const h of heroes) {
      h.model.show =
        visible &&
        (mode === 'all' ||
          year == null ||
          (mode === 'window'
            ? Math.abs(h.row.year - year) <= span
            : h.row.year <= year)) &&
        passesStatus(h.row.status);
      h.model.customShader = state.infrared ? infrared : spectral;
    }
    // Close-range shape glyphs (task 2, luminous-pins): the tier depends on
    // camera height AND this same visible/year/mode/statuses state, so it
    // recomputes on every apply() call, not just camera movement. The very
    // first enable calls recomputeShapeGlyphs() directly (bypassing the
    // throttle, exactly like ancientSites/rendering.js's own apply() calling
    // recomputeSweep() directly right after installBandWatcher seeds its
    // throttle clock) so a fresh enable applies immediately rather than
    // waiting out a throttle window; every later apply() call while already
    // visible (a status-filter toggle, a year step) goes through the SAME
    // throttled path camera movement uses - a held arrow key repeats far
    // faster than SHAPE_RECOMPUTE_THROTTLE_MS, so this still needs the
    // throttle's coalescing, unlike a single enable/disable click.
    if (visible) {
      const alreadyWatching = !!shapeGlyphBandRemover;
      installShapeGlyphWatcher();
      if (alreadyWatching) requestShapeGlyphRecompute();
      else recomputeShapeGlyphs();
    } else {
      removeShapeGlyphWatcher();
      if (glyphedIds.size || shapeGlyphBillboards.length) {
        shapeGlyphBillboards.removeAll();
        glyphedIds = new Set();
        shapeGlyphBillboards.show = false;
      }
      // Same invalidation as recomputeShapeGlyphs's own above-threshold
      // branch: disabling clears the tier outside renderShapeGlyphBillboards's
      // own nothing-changed guard, so a later re-enable landing back on the
      // exact bounds/year/mode/span/statuses the tier was last built with
      // must still rebuild rather than see a stale match and stay empty.
      lastGlyphRenderBand = undefined;
    }
    // Selection ring (task: presence pass): a defensive sync alongside the
    // dossier-close paths in index.js, which already call `setSelected(null)`
    // on layer disable - belt and braces, so a visible flag flip can never
    // leave a stale ring showing regardless of call order.
    selectionRingBillboards.show = visible && selectedAnomalyId != null;
    syncHold();
    requestFrame('anomalies-apply');
  }

  // A wider pick box than Cesium's ~3px default: these points render small
  // even at close range, and a click-only path (never hover, so no extra
  // per-frame cost) can afford the looser tolerance.
  const CLICK_PICK_BOX_PX = 12;

  /** Pure extraction of an already-picked `scene.pick()` result's own
   * anomaly id (or null) - the click path (`pick` below) and the shared
   * hover helper's `resolveHover` (src/ui/hoverPick.js, task: presence
   * pass) both resolve through this ONE function, so a picked result is
   * only ever interpreted one way. The hover helper calls this against a
   * result from ITS OWN throttled `scene.pick`, never triggering a second
   * one here. */
  function idFromPicked(picked) {
    return picked?.id?.anomalyId ?? picked?.primitive?.id?.anomalyId ?? null;
  }

  function pick(windowPosition) {
    const picked = scene.pick(
      windowPosition,
      CLICK_PICK_BOX_PX,
      CLICK_PICK_BOX_PX,
    );
    return idFromPicked(picked);
  }

  function heroPosition(id) {
    const h = heroes.find((x) => x.row.id === id);
    return h ? Cesium.Cartesian3.fromDegrees(h.row.lon, h.row.lat, 4000) : null;
  }

  /** Every currently-rendered billboard for `anomalyId` that is a brighten
   * TARGET - i.e. not the hero ring (tagged `ring: true` at construction,
   * see setRows/renderShapeGlyphBillboards) and currently `show === true`
   * (the one tier actually on screen for this row: exactly one of
   * bright/faded/shapeGlyphBillboards is showing it at a time, per
   * syncPointVisibility). Scans only on an actual hover transition (see
   * setHovered's own idempotency guard below), never every throttled tick. */
  function forEachAnomalyBillboard(anomalyId, fn) {
    const visit = (collection) => {
      for (let i = 0; i < collection.length; i++) {
        const bb = collection.get(i);
        if (bb.id?.anomalyId === anomalyId && !bb.id?.ring && bb.show) fn(bb);
      }
    };
    for (const map of [bright, faded]) for (const [, c] of map) visit(c);
    visit(shapeGlyphBillboards);
  }

  let hoveredAnomalyId = null;
  /** `[{billboard, color}]` for the currently hovered id's own brighten
   * target(s) - the EXACT `Cesium.Color` each carried right before this
   * hover started, restored by direct assignment (never recomputed) on
   * leave. Usually one entry; safe if a rebuild ever left more than one
   * visible match. */
  let hoveredOriginals = [];

  function restoreHovered() {
    for (const { billboard, color } of hoveredOriginals)
      billboard.color = color;
    hoveredOriginals = [];
  }

  /** Brighten every currently-shown billboard for `id` and record each
   * one's original colour into `hoveredOriginals` for the eventual
   * restore. Assumes `hoveredOriginals` is already empty (callers restore
   * first). Extracted so both `setHovered` and the shape-glyph rebuild path
   * (`renderShapeGlyphBillboards`, presence-pass fix round finding 1: stale
   * billboard references across tier rebuilds) apply the exact same
   * brighten logic, re-resolving billboards by id via
   * `forEachAnomalyBillboard` rather than ever trusting a billboard
   * reference captured before a rebuild.
   * @param {string} id
   */
  function applyHoverBrighten(id) {
    forEachAnomalyBillboard(id, (billboard) => {
      const original = billboard.color.clone();
      hoveredOriginals.push({ billboard, color: original });
      billboard.color = brightenColor(original, HOVER_BRIGHTEN_FACTOR);
    });
  }

  /**
   * Hover feedback (task: presence pass, controller ruling): brighten the
   * hovered row's own point billboard by a fixed factor, restoring the
   * EXACT stored original on leave or on switching to a different id.
   * Idempotent on a repeated call with the same id (the shared hover
   * helper calls this on every throttled tick while the pointer sits still
   * over the same point, not just on a change) - re-storing and
   * re-brightening an already-brightened colour on every one of those
   * ticks would compound the factor instead of holding it steady, so a
   * same-id call is a deliberate no-op.
   * @param {string|null} id
   */
  function setHovered(id) {
    if (id === hoveredAnomalyId) return;
    restoreHovered();
    hoveredAnomalyId = id;
    if (id != null) applyHoverBrighten(id);
    requestFrame('anomalies-hover');
  }

  /**
   * Selection ring (task: presence pass, controller ruling): while the
   * dossier is open for `id`, its point carries an ion ring (the hero-ring
   * idiom, `heroRingImage`) - ion for sky-register consistency with heroes,
   * per the controller ruling. A hero row is skipped outright rather than
   * doubling a second ring on top of its own PERMANENT one (see the
   * `ring: true` billboards in setRows/renderShapeGlyphBillboards):
   * `selectedId` still reports the hovered id in getDiagnostics below even
   * though no extra billboard was added for it. Idempotent on a repeated
   * call with the same id, same reasoning as setHovered above (index.js
   * calls this once per dossier open/close, not per tick, but guarding
   * costs nothing and keeps the two functions symmetric).
   * @param {string|null} id
   */
  function setSelected(id) {
    if (id === selectedAnomalyId) return;
    selectedAnomalyId = id;
    selectionRingBillboards.removeAll();
    if (id != null) {
      const row = heatRows.find((r) => r.id === id);
      if (row && !row.hero) {
        const dpr = currentDprBucket();
        const size = pointSize(row, { current: true });
        selectionRingBillboards.add({
          position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat, 0),
          image: heroRingImage(dpr),
          imageId: heroRingImageId(dpr),
          width: size * HERO_RING_DISPLAY_SCALE,
          height: size * HERO_RING_DISPLAY_SCALE,
          color: Cesium.Color.WHITE.withAlpha(0.9),
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          scaleByDistance: GLOW_SCALE_BY_DISTANCE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
      }
    }
    selectionRingBillboards.show =
      state.visible && selectionRingBillboards.length > 0;
    requestFrame('anomalies-selection');
  }

  /**
   * Diagnostics for the qa gate (scripts/qa-anomalies.mjs) and, potentially,
   * a future in-app readout: proves the close-range shape-glyph tier is
   * present and bounded without reaching into Cesium primitives directly.
   * `glyphCacheSize` is the number of distinct (shape, hue) composed
   * canvases built so far this session - bounded at 30 shapes x 4 hues
   * (120), never per row.
   */
  function getDiagnostics() {
    return {
      cameraHeight: cameraHeight(),
      shapeGlyphActive: shapeGlyphBillboards.show === true,
      glyphBillboardCount: shapeGlyphBillboards.length,
      glyphCacheSize: shapeGlyphCache.size,
      shapeGlyphHeightThreshold: SHAPE_GLYPH_HEIGHT_THRESHOLD_M,
      maxShapeGlyphBillboards: MAX_SHAPE_GLYPH_BILLBOARDS,
      // Rebuilds renderShapeGlyphBillboards actually performed (not
      // short-circuited by its own nothing-changed guard) so far this
      // session - read this twice a few seconds apart with the camera
      // parked below threshold and heroes visible to confirm idle churn is
      // gone: it should not move.
      shapeGlyphRebuildCount,
      // Task: presence pass, hover and selection feedback.
      hoveredId: hoveredAnomalyId,
      selectedId: selectedAnomalyId,
      selectionRingCount: selectionRingBillboards.length,
      // Presence-pass fix round finding 1 (rebuild-race qa evidence): the
      // count of billboards currently tracked as the hovered id's own
      // brighten target(s) - normally 0 (nothing hovered) or 1. A qa gate
      // forcing a shape-glyph tier rebuild mid-hover reads this right after
      // the rebuild to prove the brighten was actually re-applied to the
      // rebuilt billboard (count back to 1), not silently dropped (0) while
      // hoveredId itself stays non-null.
      hoveredBillboardCount: hoveredOriginals.length,
    };
  }

  function destroy() {
    removeTick();
    motionQuery?.removeEventListener?.('change', onMotionChange);
    motionQuery = null;
    onMotionChange = null;
    removeShapeGlyphWatcher();
    shapeGlyphSubscribers.delete(onShapeGlyphReady);
    scene.primitives.remove(shapeGlyphBillboards);
    glyphedIds = new Set();
    scene.primitives.remove(pulses);
    live = [];
    clearPoints();
    for (const h of heroes) scene.primitives.remove(h.model);
    heroes = [];
    cancelHeatDebounce();
    if (heatLayer && heatHostCollection) {
      heatHostCollection.remove(heatLayer, true);
      heatLayer = null;
      heatHostCollection = null;
    }
    scene.primitives.remove(selectionRingBillboards);
    selectedAnomalyId = null;
    hoveredAnomalyId = null;
    hoveredOriginals = [];
    syncHold();
  }

  return {
    setRows,
    setHeroes,
    apply,
    pick,
    resolveHover: idFromPicked,
    setHovered,
    setSelected,
    heroPosition,
    pulse,
    setHeat,
    refreshHeat,
    /** NO_IMAGERY_HOST while heat is on but the active map stack has
     * nowhere to drape it; null otherwise. */
    getHeatStatus: () => heatStatus,
    getDiagnostics,
    /** The currently active craft shader instance - `infrared` when the
     * atlas is in infrared style, `spectral` otherwise (fix round, fold 3:
     * customShader parity). The SAME instances every hero model already
     * shares. `tick()` (above) only advances their own `u_time` while at
     * least one hero is visible, so a summoned craft opened alongside a
     * visible hero shares its exact live-ticked sheen; with no hero visible
     * (the common case for a summon) `u_time` simply stays wherever it last
     * settled - the view-angle-driven grazing sheen still responds to
     * camera movement, only its own colour-cycling drift does not, the same
     * limited scope `src/app/craftSummon.js`'s own DEFAULT_SHADER fallback
     * accepts for live claims. Read by `anomalies/index.js`'s own
     * `openDossier` (spawn-time) and `setInfrared` (live re-apply on a
     * mid-summon style change). */
    getCraftShader: () => (state.infrared ? infrared : spectral),
    destroy,
  };
}
