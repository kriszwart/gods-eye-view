/**
 * Cached radial-glow sprite canvases for the atlas's luminous points (task:
 * luminous pins, sky events/live claims/ancient sites). Cesium's own
 * PointPrimitive renders a hard-edged flat circle; this module composes a
 * small radial-gradient sprite instead - a bright core softening to a
 * transparent edge, with a faint outer ring - for `BillboardCollection` to
 * draw in its place.
 *
 * DOM-side (uses `document` and `CanvasRenderingContext2D`, so it has no unit
 * tests of its own beyond the pure helpers below) but Cesium-free, so it
 * stays out of every register's Cesium-only import graph while remaining
 * importable by their Cesium-side rendering.js modules (see
 * scripts/package-boundaries.json: this file is declared in each register's
 * own boundary group, and in the two application-wide groups that bundle
 * them, since a billboard's own texture atlas needs it as a transitive
 * dependency of rendering.js).
 *
 * Approach chosen for colour (see the task 1 report): every sprite this
 * module composes is a NEUTRAL, uncoloured core - hue is baked in only when
 * a caller supplies one (liveClaims and ancientSites both pass their own
 * single fixed hue, since each register paints every point the same
 * colour). The anomalies register's hue varies continuously per row (a
 * mix along the dim/violet/magenta ramp, or a fixed amber/dim for
 * contested/explained), which would make a per-hue cache entry per row
 * unbounded; that renderer instead composes with a neutral white core and
 * applies the row's own RGB and alpha via Cesium's per-billboard `color`
 * multiply, exactly reproducing today's `pointColor()`/`pointAlpha()`
 * output with no quantisation. Brightness/alpha always applies the same
 * way, via the billboard's own `color` alpha channel, in every register.
 *
 * Size is bucketed (`sizeBucket`) so the cache never grows past one canvas
 * per (hue, bucket) pair however finely a register's own size curve varies
 * continuously; a billboard's own `width`/`height` are then set to the
 * exact continuous size a register wants (Cesium scales the cached raster
 * to fit), so the on-screen size stays exactly what it was before this
 * change, only the underlying texture is shared.
 */

/** Oversampling baked into every composed canvas, so a sprite bucketed to a
 * given on-screen size still looks crisp at high pixel density (mirrors the
 * 2x factor ancientSites/rendering.js's own glyph billboards use). */
const CANVAS_OVERSAMPLE = 2;

/** Highest devicePixelRatio a composed canvas ever oversamples for (task:
 * presence pass, retina-sharp composition). Capped, not left unbounded, so
 * a very high-density external monitor cannot balloon a composed canvas's
 * memory and GPU texture-upload cost without limit; every caller's own
 * cache stays at most this many DPR-keyed entries per (hue, size) or
 * (shape/type) pair - in practice almost always 1 (dpr === 1) or 2
 * (dpr === 1 and dpr === 2, if a visitor moves the window between a
 * standard and a retina display in the same session; see `dprBucket`'s own
 * doc comment for why that coexistence needs no live listener). */
export const MAX_COMPOSE_DPR = 2;

/**
 * Clamp a raw devicePixelRatio reading (typically `window.devicePixelRatio`)
 * to the bucket every canvas composer in the atlas shares: floored at 1
 * (`|| 1` covers 0, `NaN` and `undefined` alike - none of which is a sane
 * oversample factor), capped at `MAX_COMPOSE_DPR`. Pure, so it is unit
 * tested directly with plain numbers, without a DOM environment - unlike
 * `currentDprBucket` below, which wraps this around the live global.
 * @param {number} rawDpr
 * @returns {number}
 */
export function dprBucket(rawDpr) {
  return Math.min(rawDpr || 1, MAX_COMPOSE_DPR);
}

/**
 * The current `window.devicePixelRatio`, clamped via `dprBucket`. Read
 * fresh on every call - never cached at module load or memoised across
 * calls - so a change (a visitor dragging the window to an external
 * monitor with a different pixel density mid-session) is picked up
 * automatically the next time anything recomposes; no live
 * `resize`/`matchMedia` listener is needed for this, since a stale bucket
 * only ever means a sprite composed for the OLD density keeps rendering
 * until the next natural rebuild (a size-bucket miss, a new hue, a fresh
 * `setRows`/`renderShapeGlyphBillboards` pass) - never a wrong pick or a
 * crash, just a one-build-cycle staleness window. Every Cesium-side
 * composer in the atlas (this module's own `composeGlowSprite`, and the
 * shape/ancient-glyph composers in anomalies/rendering.js and
 * ancientSites/rendering.js) calls this rather than reading
 * `window.devicePixelRatio` directly, so the fallback-and-clamp logic
 * lives in exactly one place. Guarded for non-browser environments the
 * same way the rest of this DOM-side module implicitly assumes a browser
 * (see the module doc comment); returns 1 there.
 * @returns {number}
 */
export function currentDprBucket() {
  return dprBucket(typeof window !== 'undefined' ? window.devicePixelRatio : 1);
}

/**
 * Fraction of the sprite's radius that stays fully opaque before the
 * gradient begins softening into the halo.
 *
 * Deliberately more than half the radius, wider than the task 1 brief's
 * illustrative "~30%": a smaller core measured true at every register's
 * largest sizes (hero cases, cluster badges) but broke down at the small
 * end (the anomalies register's faded, past-year tier runs down to about
 * 3.5-6.5px). At those sizes a 30%-radius core is under a physical pixel
 * across, so a billboard's GPU downsampling of the cached raster averages
 * that tiny bright speck against the mostly-transparent halo around it,
 * and the point all but disappears - a real regression against the flat
 * PointPrimitive it replaced, which filled its whole disc at one uniform
 * alpha regardless of size. Reproduced directly: a faded 4.85px point
 * sampled by reading the rendered WebGL pixels back showed no trace of its
 * expected colour at CORE_RADIUS_FRACTION 0.3, and a plainly visible one
 * once widened here. A core this size keeps the sprite reading as a solid
 * dot at every size this atlas ever draws, with the halo now a
 * genuinely-thinner band outside it rather than most of the sprite's own
 * area.
 */
const CORE_RADIUS_FRACTION = 0.55;

/** Size buckets, in on-screen pixels. Bounded to a handful of entries (well
 * under the "~6 sizes per register" ceiling) so the sprite cache never
 * grows unbounded however finely a register's own continuous pixel-size
 * curve varies; every register's own point sizes fall inside this range
 * (anomalies: ~3.5 to 16px; live claims: ~4.4 to 13.6px; ancient sites:
 * ~4 to 14px), so the coarsest applicable bucket is always big enough to
 * hold every point at that size or smaller. */
export const GLOW_SIZE_BUCKETS_PX = Object.freeze([4, 6, 9, 13, 18, 24]);

/**
 * Snap a raw pixel size up to the nearest size bucket at or above it
 * (clamped to the largest bucket for anything bigger), so a sprite's
 * underlying raster is never asked to represent a size smaller than what a
 * caller actually wants - only ever the same size or a little larger, which
 * a billboard's own `width`/`height` then scales back down to the exact
 * requested size.
 * @param {number} sizePx - Raw, unbucketed pixel size.
 * @returns {number} One of `GLOW_SIZE_BUCKETS_PX`.
 */
export function sizeBucket(sizePx) {
  const n = Number.isFinite(sizePx) ? sizePx : GLOW_SIZE_BUCKETS_PX[0];
  for (const bucket of GLOW_SIZE_BUCKETS_PX) {
    if (n <= bucket) return bucket;
  }
  return GLOW_SIZE_BUCKETS_PX[GLOW_SIZE_BUCKETS_PX.length - 1];
}

/**
 * The sprite cache's key for a given hue, (already-bucketed) size and
 * (already-bucketed) DPR: the `imageId` a billboard must use so
 * `BillboardCollection`'s own texture atlas de-duplicates identical sprites
 * rather than rasterising one per point (the d967cd5 lesson carried over
 * from ancientSites/rendering.js's glyph billboards: a distinct canvas
 * needs a stable, distinct id, and a placeholder must never claim a real
 * sprite's id - extended by the presence-pass task: a DPR-1 and a DPR-2
 * sprite are ALSO distinct content, composed at different physical pixel
 * dimensions, so the DPR bucket joins the hue and size as a third part of
 * both the cache key and the imageId, never left implicit). Normalises the
 * hue's case so `'#FFF'` and `'#fff'` never open two cache entries for the
 * same colour.
 * @param {string} hue - CSS colour string, for example '#ff2e9a'.
 * @param {number} sizePx - Bucketed display size in px (see `sizeBucket`).
 * @param {number} dpr - Bucketed devicePixelRatio (see `dprBucket`).
 * @returns {string}
 */
export function glowCacheKey(hue, sizePx, dpr) {
  return `glow:${String(hue).toLowerCase()}:${sizePx}@${dpr}`;
}

/** [r, g, b] byte components for a '#rrggbb' string. Every hue this module
 * ever receives is one of the atlas's own six-digit palette constants, so
 * no shorthand ('#fff') or named-colour parsing is needed. */
function hexToRgbBytes(hex) {
  const s = String(hex);
  return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) || 0);
}

/** Composed canvases, cached forever by `glowCacheKey` - never rebuilt per
 * point, never per frame. Bounded by (distinct hues a caller ever passes) x
 * `GLOW_SIZE_BUCKETS_PX.length`; in practice a small handful of entries,
 * since every register passes at most one or two distinct hues (see the
 * module doc comment above). */
const cache = new Map();

/**
 * The cached composed glow sprite for a (hue, size bucket) pair, painting it
 * lazily on first request and reusing the canvas forever after.
 *
 * A radial gradient: a bright, saturated core out to roughly
 * `CORE_RADIUS_FRACTION` of the sprite's radius, softening to fully
 * transparent at the edge, with a faint outer ring just inside that edge so
 * the sprite reads with a defined boundary rather than dissolving
 * formlessly.
 *
 * @param {{hue: string, sizePx: number}} options - `hue` a CSS colour
 *   string (see the module doc comment for how each register chooses one);
 *   `sizePx` the raw, unbucketed pixel size a caller wants - bucketed
 *   internally via `sizeBucket`.
 * @returns {HTMLCanvasElement}
 */
export function composeGlowSprite({ hue, sizePx }) {
  const bucket = sizeBucket(sizePx);
  // Read fresh, not cached at module load - see currentDprBucket's own doc
  // comment (task: presence pass, retina-sharp composition).
  const dpr = currentDprBucket();
  const key = glowCacheKey(hue, bucket, dpr);
  const cached = cache.get(key);
  if (cached) return cached;
  const canvas = paintGlowSprite(hue, bucket, dpr);
  cache.set(key, canvas);
  return canvas;
}

/**
 * Paint one glow sprite canvas at the given hue and (bucketed) size, at
 * `dpr` times that size in actual canvas pixels (task: presence pass,
 * retina-sharp composition): `dim` stays the logical, CSS-pixel-equivalent
 * drawing size every coordinate below is expressed in (unchanged from
 * before this task), while the canvas's own `width`/`height` - the actual
 * raster resolution `BillboardCollection` uploads as a texture - scale by
 * `dpr`. `ctx.scale(dpr, dpr)` maps the unchanged logical drawing calls
 * onto that larger raster, so every physical pixel below is filled at
 * `dpr` times the density a DPR-1 canvas would carry, without touching the
 * geometry math itself. The billboard's own `width`/`height` (set by every
 * caller, unchanged by this task) stay in CSS pixels, so the on-screen size
 * is identical to before - only the underlying texture is sharper on a
 * high-density screen.
 */
function paintGlowSprite(hue, sizePx, dpr) {
  const dim = Math.round(sizePx * CANVAS_OVERSAMPLE);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(dim * dpr);
  canvas.height = Math.round(dim * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(dpr, dpr);
  const centre = dim / 2;
  const [r, g, b] = hexToRgbBytes(hue);
  const rgb = `${r}, ${g}, ${b}`;
  const gradient = ctx.createRadialGradient(
    centre,
    centre,
    0,
    centre,
    centre,
    centre,
  );
  gradient.addColorStop(0, `rgba(${rgb}, 1)`);
  gradient.addColorStop(CORE_RADIUS_FRACTION, `rgba(${rgb}, 1)`);
  gradient.addColorStop(0.8, `rgba(${rgb}, 0.4)`);
  gradient.addColorStop(1, `rgba(${rgb}, 0)`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(centre, centre, centre, 0, Math.PI * 2);
  ctx.fill();
  // A subtle outer ring, a touch brighter than the fading edge beneath it,
  // so the sprite keeps a defined boundary at a glance rather than reading
  // as a formless smear.
  ctx.beginPath();
  ctx.arc(centre, centre, centre * 0.82, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1, dim * 0.035);
  ctx.strokeStyle = `rgba(${rgb}, 0.35)`;
  ctx.stroke();
  return canvas;
}
