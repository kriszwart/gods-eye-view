import * as Cesium from 'cesium';
import {
  pointColor,
  pointSize,
  pointAlpha,
  PALETTE,
  ANOMALY_LAYER_ID,
} from './model.js';
import { binRows, blurBins, heatAlpha } from './hotspots.js';
import { resolveImageryHost, NO_IMAGERY_HOST } from '../../maps/imageryHost.js';

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
  const ion = Cesium.Color.fromCssColorString(PALETTE.ion);

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
    heatRows = rows;
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

  // A wider pick box than Cesium's ~3px default: these points render small
  // even at close range, and a click-only path (never hover, so no extra
  // per-frame cost) can afford the looser tolerance.
  const CLICK_PICK_BOX_PX = 12;

  function pick(windowPosition) {
    const picked = scene.pick(
      windowPosition,
      CLICK_PICK_BOX_PX,
      CLICK_PICK_BOX_PX,
    );
    return picked?.id?.anomalyId ?? picked?.primitive?.id?.anomalyId ?? null;
  }

  function heroPosition(id) {
    const h = heroes.find((x) => x.row.id === id);
    return h ? Cesium.Cartesian3.fromDegrees(h.row.lon, h.row.lat, 4000) : null;
  }

  function destroy() {
    removeTick();
    motionQuery?.removeEventListener?.('change', onMotionChange);
    motionQuery = null;
    onMotionChange = null;
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
    syncHold();
  }

  return {
    setRows,
    setHeroes,
    apply,
    pick,
    heroPosition,
    pulse,
    setHeat,
    refreshHeat,
    /** NO_IMAGERY_HOST while heat is on but the active map stack has
     * nowhere to drape it; null otherwise. */
    getHeatStatus: () => heatStatus,
    destroy,
  };
}
