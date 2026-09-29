import * as Cesium from 'cesium';
import {
  LIVE_CLAIMS_LAYER_ID,
  PALETTE,
  brightnessForAge,
  pointPixelSize,
  pointAlpha,
} from './model.js';
import {
  composeGlowSprite,
  glowCacheKey,
  sizeBucket,
  currentDprBucket,
} from '../../ui/glowSprite.js';

/** A stable [0, 2*PI) phase per claim id, so points do not all pulse in
 * lockstep. Pure string hash; no cryptographic weight intended. */
const hashPhase = (s) =>
  (([...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 11) % 1000) /
    1000) *
  (2 * Math.PI);

// Continuous, subtle breathing pulse (unlike the anomalies layer's one-shot
// arrival ring): a slow sine modulation of size and alpha around each
// point's recency-driven baseline, so the register reads as alive without
// drawing attention away from the freshest claims.
const PULSE_HZ = 0.12;
const PULSE_SIZE_AMPLITUDE_PX = 1.6;
const PULSE_ALPHA_AMPLITUDE = 0.12;

// Luminous points (task: luminous pins): the register's own single fixed
// ion hue is baked into the sprite once (unlike the anomalies register,
// whose hue varies continuously per row - see glowSprite.js's own doc
// comment). Every billboard shares ONE sprite, composed at the largest size
// this register's continuous curve ever reaches (brightness in
// [BRIGHTNESS_FLOOR, 1] via pointPixelSize, plus the sine pulse's own
// amplitude), fixed for the billboard's whole lifetime - never reassigned
// per tick.
//
// This is deliberate, not an optimisation left on the table: re-setting a
// billboard's `image`/`imageId` on the same frame as a `width`/`height`
// change reliably breaks `scene.pick()` for that billboard within a couple
// of seconds (reproduced in isolation - a billboard ticked with image/
// imageId AND width/height/colour reassigned every frame, even to an
// unchanged cached value, stops picking; the identical billboard ticked
// with only width/height/colour varying keeps picking correctly
// indefinitely). Since this register's sine pulse spans several of
// glowSprite.js's size buckets, recomputing the bucket per tick would
// reassign image/imageId whenever the continuous size crosses a bucket
// boundary - and a value oscillating near a boundary can cross it
// repeatedly, reproducing the same bug. Composing once at the guaranteed
// maximum and only ever changing width/height/colour afterwards (which
// Cesium scales the cached raster to fit, always downscaling, never up)
// sidesteps the bug entirely while keeping the exact on-screen size
// pointPixelSize()'s continuous curve always produced.
const MAX_POINT_SIZE_PX = pointPixelSize(1) + PULSE_SIZE_AMPLITUDE_PX;
// `glowImageId` is a function of the DPR bucket, not a module-load-time
// constant (task: presence pass, retina-sharp composition): DPR is read
// fresh at each composition (setRows below, the register's only write path
// per the module doc comment above - never the tick), never cached at
// import time, so a session that starts before a window move to a
// different-density display still composes correctly on the next rebuild.
const glowImageId = (dpr) =>
  glowCacheKey(PALETTE.ionDark, sizeBucket(MAX_POINT_SIZE_PX), dpr);
const glowImage = () =>
  composeGlowSprite({ hue: PALETTE.ionDark, sizePx: MAX_POINT_SIZE_PX });

/**
 * Hover brighten (task: presence pass, hover and selection feedback): a
 * fixed multiplicative factor, same value the anomalies and ancient-sites
 * registers use. THIS register differs from those two in how it gets
 * applied: every billboard here is repainted every tick from a live
 * age-brightness curve plus the breathing pulse (see `tick` below) - there
 * is no static "original colour" to store and restore, and freezing one
 * would stop the honest age-decay the register's whole design is built on.
 * So instead of a store/restore pair, `tick`'s own per-frame computation
 * multiplies the CURRENT frame's honest size/alpha by this factor for
 * whichever billboard is hovered - deterministic every frame, never a
 * stale snapshot, and "un-hovering" is simply the next tick no longer
 * applying it (no explicit restore call needed).
 */
const HOVER_BRIGHTEN_FACTOR = 1.4;

// A wider pick box than Cesium's ~3px default (matches the anomalies and
// ancient-sites renderers): these points render small even at close range,
// and a click-only path (never hover, so no extra per-frame cost) can
// afford the looser tolerance.
const CLICK_PICK_BOX_PX = 12;

/** True when the visitor has asked for reduced motion. This module is
 * Cesium-side (it already imports Cesium and touches the viewer), where
 * reading `window.matchMedia` is allowed - unlike the portable
 * records/source/model modules, which must never touch a browser global.
 * Guarded for non-browser environments all the same. */
function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
  );
}

/**
 * Owns every Cesium resource for the live-claims layer: a single
 * BillboardCollection of pulsing ion glow sprites (see glowSprite.js),
 * ticked continuously (via a render-governor hold) only while the layer is
 * visible and claims exist.
 *
 * @param {Cesium.Viewer} viewer
 * @param {{render?: {holdContinuousRender: Function, releaseContinuousRender:
 *   Function, governorRequestRender: Function}}} [options]
 */
export function createLiveClaimsRenderer(viewer, { render } = {}) {
  const scene = viewer.scene;
  const points = scene.primitives.add(
    new Cesium.BillboardCollection({
      scene,
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    }),
  );
  points.show = false;
  let visible = false;
  let rowCount = 0;
  let holding = false;
  let hoveredClaimId = null;

  // Selection ring (task: presence pass, hover and selection feedback):
  // while the dossier is open for a claim, its point carries an ion ring
  // (the hero-ring idiom other registers already use, reused here with
  // this register's own fixed ion hue - controller ruling: ion for
  // claims). At most one billboard at a time, rebuilt wholesale on every
  // `setSelected` call.
  const selectionRingBillboards = scene.primitives.add(
    new Cesium.BillboardCollection({
      scene,
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    }),
  );
  selectionRingBillboards.show = false;
  let selectedClaimId = null;
  const SELECTION_RING_DISPLAY_SCALE = 1.4;
  const SELECTION_RING_IMAGE_ID = 'live-claims-selection-ring';
  const SELECTION_RING_CANVAS_DIM = 48;
  const selectionRingImageId = (dpr) => `${SELECTION_RING_IMAGE_ID}@${dpr}`;
  /** Composed once per DPR bucket, mirroring anomalies/rendering.js's own
   * `heroRingImage`. */
  const selectionRingCanvasByDpr = new Map();
  function selectionRingImage(dpr) {
    const cached = selectionRingCanvasByDpr.get(dpr);
    if (cached) return cached;
    const dim = SELECTION_RING_CANVAS_DIM;
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
      ctx.strokeStyle = PALETTE.ionDark;
      ctx.stroke();
    }
    selectionRingCanvasByDpr.set(dpr, canvas);
    return canvas;
  }
  /** The live claim billboard for `id`, or null (a plain scan - `points`
   * holds at most a few hundred entries, and this only runs on a
   * setSelected call, never per tick). */
  function findClaimBillboard(id) {
    for (let i = 0; i < points.length; i++) {
      const bb = points.get(i);
      if (bb.id?.claimId === id) return bb;
    }
    return null;
  }
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
      requestFrame('live-claims-motion-preference-changed');
    };
    motionQuery.addEventListener?.('change', onMotionChange);
  }

  const syncHold = () => {
    if (!render) return;
    const want = visible && rowCount > 0;
    if (want === holding) return;
    holding = want;
    if (want) render.holdContinuousRender(LIVE_CLAIMS_LAYER_ID);
    else render.releaseContinuousRender(LIVE_CLAIMS_LAYER_ID);
  };
  const requestFrame = (reason) =>
    render ? render.governorRequestRender(reason) : scene.requestRender();

  /**
   * Apply a computed size/alpha to a billboard: width/height carry the
   * exact continuous size every tick (Cesium scales the one fixed sprite -
   * see `glowImage`/`MAX_POINT_SIZE_PX` above - down to fit; it is never
   * asked to scale up), and colour stays a white tint over the already-ion
   * -coloured sprite, so only alpha changes, never hue. Deliberately never
   * touches `image`/`imageId` (see the module doc comment above for why).
   */
  function paint(billboard, sizePx, alpha) {
    billboard.width = sizePx;
    billboard.height = sizePx;
    billboard.color = Cesium.Color.WHITE.withAlpha(alpha);
  }

  const t0 = performance.now();
  function tick() {
    if (!visible || !points.length) return;
    const now = performance.now();
    const nowMs = Date.now();
    for (let i = 0; i < points.length; i++) {
      const billboard = points.get(i);
      const meta = billboard.id;
      const ageMs = nowMs - meta.fetchedAtMs;
      const brightness = brightnessForAge(ageMs);
      let sizePx;
      let alpha;
      if (reducedMotion) {
        // No sine modulation: the point sits at its plain age-brightness
        // size and alpha, unchanging frame to frame (see
        // docs/superpowers/plans - reduced motion parked follow-up).
        sizePx = pointPixelSize(brightness);
        alpha = pointAlpha(brightness);
      } else {
        const phase = ((now - t0) / 1000) * PULSE_HZ * 2 * Math.PI + meta.phase;
        const pulse = 0.5 + 0.5 * Math.sin(phase);
        sizePx = pointPixelSize(brightness) + PULSE_SIZE_AMPLITUDE_PX * pulse;
        alpha = Math.max(
          0,
          Math.min(1, pointAlpha(brightness) + PULSE_ALPHA_AMPLITUDE * pulse),
        );
      }
      // Hover brighten (task: presence pass): see HOVER_BRIGHTEN_FACTOR's
      // own doc comment above for why this multiplies the current frame's
      // honest values rather than storing/restoring a snapshot.
      if (meta.claimId === hoveredClaimId) {
        sizePx *= HOVER_BRIGHTEN_FACTOR;
        alpha = Math.min(1, alpha * HOVER_BRIGHTEN_FACTOR);
      }
      paint(billboard, sizePx, alpha);
    }
    if (!render) scene.requestRender();
  }
  const removeTick = viewer.clock.onTick.addEventListener(tick);

  /** Replace the rendered claims. Rows must carry `id`, `lat`, `lon` and
   * `fetchedAt` (see records.js's normalizeClaimRow). */
  function setRows(rows) {
    points.removeAll();
    // Read once for this whole build pass (task: presence pass, retina-sharp
    // composition): every billboard added below shares the same DPR bucket,
    // matching composeGlowSprite's own internal read for `glowImage()`.
    const dpr = currentDprBucket();
    for (const row of rows) {
      const size = pointPixelSize(1);
      points.add({
        id: {
          id: `claim:${row.id}`,
          claimId: row.id,
          fetchedAtMs: Date.parse(row.fetchedAt) || Date.now(),
          phase: hashPhase(row.id),
        },
        position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat, 0),
        image: glowImage(),
        imageId: glowImageId(dpr),
        width: size,
        height: size,
        color: Cesium.Color.WHITE.withAlpha(pointAlpha(1)),
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    rowCount = rows.length;
    syncHold();
    requestFrame('live-claims-set-rows');
  }

  /** @param {{visible?: boolean}} [next] */
  function apply({ visible: nextVisible } = {}) {
    if (nextVisible !== undefined) visible = nextVisible;
    points.show = visible;
    // Selection ring (task: presence pass): a defensive sync alongside the
    // dossier-close paths in index.js, which already call `setSelected(null)`
    // on layer disable.
    selectionRingBillboards.show =
      visible && selectionRingBillboards.length > 0;
    syncHold();
    requestFrame('live-claims-apply');
  }

  /** Pure extraction of an already-picked `scene.pick()` result's own claim
   * id (or null) - the click path (`pick` below) and the shared hover
   * helper's `resolveHover` (src/ui/hoverPick.js, task: presence pass) both
   * resolve through this ONE function, given a result from ONE `scene.pick`
   * call. */
  function idFromPicked(picked) {
    return picked?.id?.claimId ?? picked?.primitive?.id?.claimId ?? null;
  }

  /** Resolve a click to a claim id, or null. @param {Cesium.Cartesian2} windowPosition */
  function pick(windowPosition) {
    const picked = scene.pick(
      windowPosition,
      CLICK_PICK_BOX_PX,
      CLICK_PICK_BOX_PX,
    );
    return idFromPicked(picked);
  }

  /**
   * Hover feedback (task: presence pass, controller ruling): see
   * HOVER_BRIGHTEN_FACTOR's own doc comment above - this register applies
   * the brighten inside `tick`'s own per-frame computation rather than a
   * store/restore pair, so this setter only records which id is hovered.
   * Idempotent on a repeated call with the same id (the shared hover helper
   * calls this on every throttled tick while the pointer sits still).
   * @param {string|null} id
   */
  function setHovered(id) {
    if (id === hoveredClaimId) return;
    hoveredClaimId = id;
    requestFrame('live-claims-hover');
  }

  /**
   * Selection ring (task: presence pass, controller ruling): while the
   * dossier is open for `id`, its point carries an ion ring. Idempotent on
   * a repeated call with the same id.
   * @param {string|null} id
   */
  function setSelected(id) {
    if (id === selectedClaimId) return;
    selectedClaimId = id;
    selectionRingBillboards.removeAll();
    if (id != null) {
      const billboard = findClaimBillboard(id);
      if (billboard) {
        const dpr = currentDprBucket();
        // A one-shot snapshot of the billboard's current (continuously
        // ticking) size, not itself re-synced per tick - "no image/imageId
        // writes in any tick or hover path" extends to this ring too: it is
        // sized once, on selection, and holds that size for as long as the
        // dossier stays open.
        const size = billboard.width;
        selectionRingBillboards.add({
          position: billboard.position,
          image: selectionRingImage(dpr),
          imageId: selectionRingImageId(dpr),
          width: size * SELECTION_RING_DISPLAY_SCALE,
          height: size * SELECTION_RING_DISPLAY_SCALE,
          color: Cesium.Color.WHITE.withAlpha(0.9),
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
      }
    }
    selectionRingBillboards.show =
      visible && selectionRingBillboards.length > 0;
    requestFrame('live-claims-selection');
  }

  /**
   * A tiny read-only snapshot for qa-claims.mjs's reduced-motion check
   * (mirrors the `getDiagnostics()` pattern other layers already expose for
   * their own qa gates, for example `src/layers/cyclones/index.js`), rather
   * than proving the tick's sine modulation is bypassed through screenshot
   * diffing. `firstPixelSize`/`firstAlpha` are the first rendered point's
   * current values, so a caller can snapshot this twice across a short
   * delay and confirm they hold steady under reduced motion (and move
   * without it).
   * @returns {{reducedMotion: boolean, pointCount: number,
   *   firstPixelSize: ?number, firstAlpha: ?number}}
   */
  function getDiagnostics() {
    const first = points.length ? points.get(0) : null;
    return {
      reducedMotion,
      pointCount: points.length,
      // `width` (a billboard has no `pixelSize`) carries the exact
      // continuous size `paint()` computed above - the same value
      // `pixelSize` used to hold, just on a different property.
      firstPixelSize: first ? first.width : null,
      firstAlpha: first ? first.color.alpha : null,
      // Task: presence pass, hover and selection feedback.
      hoveredId: hoveredClaimId,
      selectedId: selectedClaimId,
      selectionRingCount: selectionRingBillboards.length,
    };
  }

  function destroy() {
    removeTick();
    motionQuery?.removeEventListener?.('change', onMotionChange);
    motionQuery = null;
    onMotionChange = null;
    scene.primitives.remove(points);
    scene.primitives.remove(selectionRingBillboards);
    rowCount = 0;
    hoveredClaimId = null;
    selectedClaimId = null;
    syncHold();
  }

  return {
    setRows,
    apply,
    pick,
    resolveHover: idFromPicked,
    setHovered,
    setSelected,
    destroy,
    getDiagnostics,
  };
}
