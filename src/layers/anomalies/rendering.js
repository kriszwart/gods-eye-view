import * as Cesium from 'cesium';
import {
  pointColor,
  pointSize,
  pointAlpha,
  PALETTE,
  ANOMALY_LAYER_ID,
} from './model.js';

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

/**
 * Owns every Cesium resource for the layer: one pair of point collections per
 * year (current and past), plus animated hero models.
 */
export function createAnomalyRenderer(
  viewer,
  { assetBase = '/anomalies/', render } = {},
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
  const ion = Cesium.Color.fromCssColorString(PALETTE.ion);
  const t0 = performance.now();
  const tick = () => {
    if (!state.visible || !heroes.length) return;
    const t = (performance.now() - t0) / 1000;
    spectral.setUniform('u_time', t);
    infrared.setUniform('u_time', t);
    // Hero loops need frames; the governor hold covers this when injected.
    if (!render) scene.requestRender();
  };
  // Arrival pulses: a ring blooms at each report as its year arrives.
  const pulses = scene.primitives.add(
    new Cesium.PointPrimitiveCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    }),
  );
  let live = [];
  const PULSE_MS = 1600;
  const stepPulses = () => {
    if (!live.length) return;
    const now = performance.now();
    live = live.filter((p) => {
      const t = (now - p.start) / PULSE_MS;
      if (t >= 1) {
        pulses.remove(p.point);
        return false;
      }
      p.point.pixelSize = 6 + 34 * t;
      p.point.outlineColor = p.color.withAlpha(0.9 * (1 - t) * (1 - t));
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
        pixelSize: 6,
        color: Cesium.Color.TRANSPARENT,
        outlineColor: color,
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
        new Cesium.PointPrimitiveCollection({
          blendOption: Cesium.BlendOption.TRANSLUCENT,
        }),
      );
      c.show = false;
      map.set(year, c);
    }
    return c;
  }

  function clearPoints() {
    for (const c of [...bright.values(), ...faded.values()])
      scene.primitives.remove(c);
    bright.clear();
    faded.clear();
  }

  function setRows(rows) {
    clearPoints();
    const far = new Cesium.NearFarScalar(2.0e5, 1.6, 2.0e7, 0.75);
    for (const r of rows) {
      const position = Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 0);
      const [red, green, blue] = pointColor(r);
      for (const [map, current] of [
        [bright, true],
        [faded, false],
      ]) {
        collection(map, r.year).add({
          id: { id: `anomaly:${r.id}`, anomalyId: r.id, status: r.status },
          position,
          pixelSize: pointSize(r, { current }),
          color: new Cesium.Color(red, green, blue, pointAlpha(r, { current })),
          outlineColor: r.hero
            ? ion.withAlpha(current ? 0.9 : 0.35)
            : Cesium.Color.TRANSPARENT,
          outlineWidth: r.hero ? 1.5 : 0,
          scaleByDistance: far,
        });
      }
    }
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
    const passes = (status) => !state.statuses || state.statuses.has(status);
    for (const map of [bright, faded])
      for (const [, c] of map)
        for (let i = 0; i < c.length; i++) {
          const p = c.get(i);
          p.show = passes(p.id.status);
        }
    for (const h of heroes) {
      h.model.show =
        visible &&
        (mode === 'all' ||
          year == null ||
          (mode === 'window'
            ? Math.abs(h.row.year - year) <= span
            : h.row.year <= year)) &&
        passes(h.row.status);
      h.model.customShader = state.infrared ? infrared : spectral;
    }
    syncHold();
    requestFrame('anomalies-apply');
  }

  function pick(windowPosition) {
    const picked = scene.pick(windowPosition);
    return picked?.id?.anomalyId ?? picked?.primitive?.id?.anomalyId ?? null;
  }

  function heroPosition(id) {
    const h = heroes.find((x) => x.row.id === id);
    return h ? Cesium.Cartesian3.fromDegrees(h.row.lon, h.row.lat, 4000) : null;
  }

  function destroy() {
    removeTick();
    scene.primitives.remove(pulses);
    live = [];
    clearPoints();
    for (const h of heroes) scene.primitives.remove(h.model);
    heroes = [];
    syncHold();
  }

  return { setRows, setHeroes, apply, pick, heroPosition, pulse, destroy };
}
