import * as Cesium from 'cesium';
import { GOLD } from './model.js';

/** Owns the point collection for the ancient register. Static: no animation. */
export function createAncientRenderer(viewer, { render } = {}) {
  const scene = viewer.scene;
  const gold = Cesium.Color.fromCssColorString(GOLD);
  const points = scene.primitives.add(
    new Cesium.PointPrimitiveCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    }),
  );
  points.show = false;
  const requestFrame = (reason) =>
    render ? render.governorRequestRender(reason) : scene.requestRender();

  function setRows(rows) {
    points.removeAll();
    for (const r of rows)
      points.add({
        id: { id: `ancient:${r.id}`, ancientId: r.id },
        position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 0),
        pixelSize: 7,
        color: gold.withAlpha(0.9),
        outlineColor: gold.withAlpha(0.35),
        outlineWidth: 2,
        scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.5, 2.0e7, 0.8),
      });
    requestFrame('ancient-rows');
  }

  function apply({ visible }) {
    points.show = visible;
    requestFrame('ancient-visibility');
  }

  function pick(windowPosition) {
    const picked = scene.pick(windowPosition);
    return picked?.id?.ancientId ?? picked?.primitive?.id?.ancientId ?? null;
  }

  function destroy() {
    scene.primitives.remove(points);
  }

  return { setRows, apply, pick, destroy };
}
