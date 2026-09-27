import * as Cesium from 'cesium';
import {
  LIVE_CLAIMS_LAYER_ID,
  PALETTE,
  brightnessForAge,
  pointPixelSize,
  pointAlpha,
} from './model.js';

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

// A wider pick box than Cesium's ~3px default (matches the anomalies and
// ancient-sites renderers): these points render small even at close range,
// and a click-only path (never hover, so no extra per-frame cost) can
// afford the looser tolerance.
const CLICK_PICK_BOX_PX = 12;

/**
 * Owns every Cesium resource for the live-claims layer: a single
 * PointPrimitiveCollection of pulsing ion points, ticked continuously (via a
 * render-governor hold) only while the layer is visible and claims exist.
 *
 * @param {Cesium.Viewer} viewer
 * @param {{render?: {holdContinuousRender: Function, releaseContinuousRender:
 *   Function, governorRequestRender: Function}}} [options]
 */
export function createLiveClaimsRenderer(viewer, { render } = {}) {
  const scene = viewer.scene;
  const points = scene.primitives.add(
    new Cesium.PointPrimitiveCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    }),
  );
  points.show = false;
  const ion = Cesium.Color.fromCssColorString(PALETTE.ionDark);
  let visible = false;
  let rowCount = 0;
  let holding = false;

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

  const t0 = performance.now();
  function tick() {
    if (!visible || !points.length) return;
    const now = performance.now();
    const nowMs = Date.now();
    for (let i = 0; i < points.length; i++) {
      const point = points.get(i);
      const meta = point.id;
      const ageMs = nowMs - meta.fetchedAtMs;
      const brightness = brightnessForAge(ageMs);
      const phase = ((now - t0) / 1000) * PULSE_HZ * 2 * Math.PI + meta.phase;
      const pulse = 0.5 + 0.5 * Math.sin(phase);
      point.pixelSize =
        pointPixelSize(brightness) + PULSE_SIZE_AMPLITUDE_PX * pulse;
      point.color = ion.withAlpha(
        Math.max(
          0,
          Math.min(1, pointAlpha(brightness) + PULSE_ALPHA_AMPLITUDE * pulse),
        ),
      );
    }
    if (!render) scene.requestRender();
  }
  const removeTick = viewer.clock.onTick.addEventListener(tick);

  /** Replace the rendered claims. Rows must carry `id`, `lat`, `lon` and
   * `fetchedAt` (see records.js's normalizeClaimRow). */
  function setRows(rows) {
    points.removeAll();
    for (const row of rows) {
      points.add({
        id: {
          id: `claim:${row.id}`,
          claimId: row.id,
          fetchedAtMs: Date.parse(row.fetchedAt) || Date.now(),
          phase: hashPhase(row.id),
        },
        position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat, 0),
        pixelSize: pointPixelSize(1),
        color: ion.withAlpha(pointAlpha(1)),
        outlineColor: Cesium.Color.TRANSPARENT,
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
    syncHold();
    requestFrame('live-claims-apply');
  }

  /** Resolve a click to a claim id, or null. @param {Cesium.Cartesian2} windowPosition */
  function pick(windowPosition) {
    const picked = scene.pick(
      windowPosition,
      CLICK_PICK_BOX_PX,
      CLICK_PICK_BOX_PX,
    );
    return picked?.id?.claimId ?? picked?.primitive?.id?.claimId ?? null;
  }

  function destroy() {
    removeTick();
    scene.primitives.remove(points);
    rowCount = 0;
    syncHold();
  }

  return { setRows, apply, pick, destroy };
}
