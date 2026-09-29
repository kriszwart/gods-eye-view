import * as Cesium from 'cesium';

/**
 * Summons a single reported-archetype craft model over a dossier's case
 * location, mirroring the hero craft loader's own placement exactly
 * (`src/layers/anomalies/rendering.js`'s `setHeroes`: same height offset,
 * `minimumPixelSize`, `maximumScale`; only the heading's own hash input
 * differs, since a summon has no row id of its own - see `hashDeg` below).
 * Exactly one craft is summoned globally at a time (module state below):
 * opening a shaped dossier in ANY register (anomalies, live claims)
 * despawns whatever was summoned before, from any register. Hero cases
 * never summon - they already carry their own permanent animated craft
 * (`src/layers/anomalies/index.js`'s own openDossier skips this module
 * entirely for a hero row).
 *
 * App-side, not portable: it imports Cesium directly, like `src/orbit.js`
 * and `src/cameraVerbs.js`. Declared in the `application-components` and
 * `application-layer-construction` boundary groups in
 * `scripts/package-boundaries.json` - the same two groups
 * `src/renderGovernor.js` and `src/ui/hoverPick.js` already belong to.
 *
 * CONTROLLER RULING (task: presence pass): the render governor hold is
 * taken only while a craft is up and its animations are meant to run.
 * Reduced motion spawns a static pose - `activeAnimations` is never
 * started - and takes no hold at all: a static model needs no continuous
 * frames, just the one-shot render this module already requests on spawn
 * and despawn. Where motion IS allowed, the hold engages as soon as the
 * model is added to the scene, not only once its own `readyEvent` has
 * fired - mirroring the hero loader's own `syncHold` timing exactly
 * (`heroes.length > 0` engages the hold before any hero model is
 * necessarily ready). Engaging on presence rather than readiness is not
 * just cosmetic parity: it is what lets the render loop actually run long
 * enough, across however many frames Cesium needs, for the model to finish
 * loading and its `readyEvent` to fire in the first place - waiting for
 * readiness before taking the hold would risk the loop staying idle and
 * the model never becoming ready at all.
 *
 * FIX ROUND (task: presence pass, finding 1 - GPU leak on despawn-during-
 * load): a despawn arriving before the GLB resolves used to discard the
 * resolved Model by merely dropping the reference - the Model itself had
 * already allocated real GPU buffers and textures on arrival, so every
 * rapid dossier-switch-before-load race leaked one Model's GPU allocation
 * for the session. The `.then()` handler below now destroys a discarded
 * Model explicitly before returning, and counts the discard in
 * `discardedLoads` (see `getSummonDiagnostics` below) so the fix itself is
 * provable from outside the module.
 *
 * FIX ROUND (fold 3 - customShader parity): the hero loader always applies
 * the current style's shader to a hero model (spectral thin-film sheen, or
 * the infrared shader when the atlas is in infrared style - see
 * `anomalies/rendering.js`'s own `setHeroes`/`apply`). A summoned craft
 * used to get no shader at all: no sheen, and an infrared-only archetype
 * (baked fully transparent outside the infrared shader) would have been
 * invisible if ever summoned. `summon()` now accepts an optional
 * `customShader`, applied at spawn; a caller with no shader of its own
 * (live claims, which has no infrared toggle - PHENOMENA_DESIGN.md: "the
 * claims register uses the same spectral default") gets this module's own
 * `DEFAULT_SHADER` instead, a spectral shader mirroring
 * `anomalies/rendering.js`'s own SPECTRAL_FS exactly. `setCraftShader()`
 * lets a caller whose current style changes while a dossier is already
 * open (`anomalies/index.js`'s own `setInfrared`) re-apply the shader to
 * whatever is currently summoned, so a mid-summon style switch is not
 * stuck with the spawn-time shader either.
 */

/** Render governor owner id for a summoned craft's continuous-render hold
 * (see `src/renderGovernor.js`). One id for the whole module: only one
 * craft is ever summoned at a time, regardless of which register asked. */
const RENDER_OWNER_ID = 'craft-summon';

/** Height above the reported location, in metres - identical to the hero
 * loader's own `Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 650)`. */
const SUMMON_HEIGHT_M = 650;

/** Identical to the hero loader's own `Cesium.Model.fromGltfAsync` options
 * (`minimumPixelSize`, `maximumScale`). */
const MIN_PIXEL_SIZE = 56;
const MAX_SCALE = 40000;

/** A handle whose despawn() does nothing - returned when a summon cannot
 * proceed at all (no viewer/scene, no shape, or non-finite coordinates), so
 * a caller never needs to null-check before calling despawn(). */
const NO_OP_HANDLE = Object.freeze({ despawn() {} });

/** Thin-film sheen, mirroring `anomalies/rendering.js`'s own SPECTRAL_FS
 * fragment shader exactly (fold 3, customShader parity - see this module's
 * own doc comment above). Duplicated rather than imported: this module
 * already mirrors several of that file's own constants the same way
 * (`SUMMON_HEIGHT_M`, `MIN_PIXEL_SIZE`, `MAX_SCALE`, `hashDeg`), and a
 * static import the other way would tie a generic, register-agnostic
 * summoner to one register's own rendering internals. */
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

/** Default shader applied when a caller doesn't supply its own current-style
 * `customShader` (fold 3) - always spectral, matching the hero loader's own
 * default. A private, un-ticked instance (`u_time` stays at its initial
 * value): this module has no per-frame tick loop of its own, unlike
 * `anomalies/rendering.js`, so the view-angle-driven grazing sheen still
 * shows but its colour-cycling drift does not animate. Acceptable scope for
 * the one caller that ever falls back to it (live claims, which has no
 * infrared toggle to switch shaders over in the first place). */
const DEFAULT_SHADER = new Cesium.CustomShader({
  uniforms: {
    u_time: { type: Cesium.UniformType.FLOAT, value: 0 },
    u_strength: { type: Cesium.UniformType.FLOAT, value: 0.85 },
  },
  fragmentShaderText: SPECTRAL_FS,
});

/** True when the visitor has asked for reduced motion. Read once per
 * summon, not watched live (unlike the hero renderer's own live-watched
 * flag): a summon's whole lifetime is a single dossier's open-to-close
 * span, short enough that a mid-summon OS setting flip is not worth
 * tracking. Guarded for non-browser environments. */
function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
  );
}

/** Deterministic per-summon heading, mirroring the hero loader's own
 * `hashDeg(r.id)` (anomalies/rendering.js) - hashed here from the shape and
 * location together, since a summon carries no row id of its own, so the
 * same case always faces the same way rather than jittering on repeat
 * opens. */
const hashDeg = (s) =>
  [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 360;

/** The single currently-summoned (or still-loading) craft's own private
 * state, or null when nothing is summoned. Module-level by design: exactly
 * one craft is summoned globally, regardless of which register asked (see
 * this module's own doc comment above). */
let currentSummon = null;

/** Count of GLB loads discarded because their dossier closed (or was
 * replaced by a later summon) before the model arrived (fix round, finding
 * 1). Exposed through `getSummonDiagnostics` purely as qa/throwaway proof
 * that the discard branch actually runs and destroys its Model - not read
 * by any rendering logic. */
let discardedLoads = 0;

/** Whether the most recently discarded load's Model reported itself
 * destroyed (`model.isDestroyed()`) immediately after `.destroy()` was
 * called on it - the real proof, not just that the discard branch ran.
 * `null` until at least one load has been discarded. */
let lastDiscardDestroyed = null;

/** Release the render governor hold for a summon state, if it is holding.
 * Idempotent. */
function releaseHold(state) {
  if (!state.holding) return;
  state.holding = false;
  state.render?.releaseContinuousRender?.(RENDER_OWNER_ID);
}

/** Despawn a summon state: remove its model from the scene (if it ever
 * arrived), release its render hold (if it took one), request one settling
 * frame, and clear the module's own reference if this was still current.
 * Guards double-despawn - safe to call more than once on the same state,
 * including one whose GLB never finished loading (nothing to remove yet)
 * or one already replaced by a later summon. */
function despawnState(state) {
  if (state.despawned) return;
  state.despawned = true;
  if (state.model) {
    state.scene.primitives.remove(state.model);
    state.model = null;
  }
  releaseHold(state);
  state.requestFrame('craft-summon-despawn');
  if (currentSummon === state) currentSummon = null;
}

/**
 * Summon the reported-archetype craft for a shaped, non-hero case at its
 * location. Returns a handle immediately - the GLB itself loads in the
 * background - whose `despawn()` is always safe to call, including before
 * the model has finished loading (in which case it is simply never added
 * to the scene) or after a load failure (already inert, and already
 * warned once). Exactly one craft is summoned globally: calling this
 * again, from any register, despawns whatever this module currently
 * considers current first.
 *
 * @param {{viewer: import('cesium').Viewer, shape: string, lat: number,
 *   lon: number, render?: {holdContinuousRender: Function,
 *   releaseContinuousRender: Function, governorRequestRender: Function},
 *   assetBase?: string, customShader?: import('cesium').CustomShader}}
 *   options `render` mirrors the object every register's own renderer
 *   already receives (`src/renderGovernor.js`'s three exports); omitted,
 *   the summon falls back to a direct `scene.requestRender()` and never
 *   takes a continuous hold. `assetBase` mirrors the calling register's own
 *   configured base (`'/anomalies/'` by default - the only craft library
 *   the app ships; `src/layers/liveClaims` has none of its own and passes
 *   the anomalies one through). `customShader` is the caller's own current-
 *   style shader (fold 3, customShader parity - see this module's own doc
 *   comment above); omitted, the summon falls back to this module's own
 *   `DEFAULT_SHADER`.
 * @returns {{despawn: () => void}}
 */
export function summon({
  viewer,
  shape,
  lat,
  lon,
  render,
  assetBase = '/anomalies/',
  customShader,
} = {}) {
  if (
    !viewer?.scene ||
    typeof shape !== 'string' ||
    !shape ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  )
    return NO_OP_HANDLE;
  // One craft at a time, globally: replace whatever this module currently
  // considers current (spawned or still loading), from any register.
  if (currentSummon) despawnState(currentSummon);
  const scene = viewer.scene;
  const reducedMotion = prefersReducedMotion();
  const requestFrame = (reason) =>
    render ? render.governorRequestRender(reason) : scene.requestRender();
  const state = {
    despawned: false,
    model: null,
    holding: false,
    animating: false,
    shape,
    scene,
    render,
    requestFrame,
  };
  currentSummon = state;
  const origin = Cesium.Cartesian3.fromDegrees(lon, lat, SUMMON_HEIGHT_M);
  const hpr = new Cesium.HeadingPitchRoll(
    Cesium.Math.toRadians(hashDeg(`${shape}:${lat}:${lon}`)),
    0,
    0,
  );
  Cesium.Model.fromGltfAsync({
    url: `${assetBase}crafts/${shape}.glb`,
    modelMatrix: Cesium.Transforms.headingPitchRollToFixedFrame(origin, hpr),
    heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
    scene,
    minimumPixelSize: MIN_PIXEL_SIZE,
    maximumScale: MAX_SCALE,
    customShader: customShader ?? DEFAULT_SHADER,
  })
    .then((model) => {
      // Despawned while loading (a rapid second summon, or the dossier
      // closed before the GLB arrived): discard without ever touching the
      // scene or taking a hold. The Model itself already allocated real GPU
      // buffers and textures on arrival, though, so it must be destroyed
      // explicitly here or every such race leaks one Model's GPU allocation
      // for the session (fix round, finding 1) - dropping the reference
      // alone is not enough.
      if (state.despawned) {
        discardedLoads += 1;
        if (!model.isDestroyed()) model.destroy();
        lastDiscardDestroyed = model.isDestroyed();
        return;
      }
      state.model = model;
      scene.primitives.add(model);
      if (!reducedMotion) {
        // Hold engaged now, before readyEvent has necessarily fired - see
        // this module's own doc comment above.
        state.holding = true;
        render?.holdContinuousRender?.(RENDER_OWNER_ID);
        model.readyEvent.addEventListener(() => {
          if (state.despawned) return;
          model.activeAnimations.addAll({
            loop: Cesium.ModelAnimationLoop.REPEAT,
          });
          state.animating = true;
        });
      }
      requestFrame('craft-summon-spawn');
    })
    .catch((error) => {
      if (!state.despawned)
        console.warn('[App:CraftSummon] Craft failed to load', shape, error);
      if (currentSummon === state) currentSummon = null;
    });
  return {
    despawn() {
      despawnState(state);
    },
  };
}

/**
 * Re-apply a shader to the currently summoned craft's own model, if one is
 * up and its model has already arrived (fold 3, customShader parity - see
 * this module's own doc comment above). Lets a caller whose current style
 * changes while a dossier is already open (`anomalies/index.js`'s own
 * `setInfrared`) keep a summoned craft's shader in step with the newly
 * active style, rather than stuck with whatever `summon()` chose at spawn
 * time. A no-op when nothing is summoned, the summon has already
 * despawned, or the model hasn't arrived yet - the next `summon()` call
 * already carries the right shader as its own `customShader` argument, so
 * there is nothing here to re-apply to in that window.
 * @param {import('cesium').CustomShader} [shader] Falls back to this
 *   module's own `DEFAULT_SHADER` when omitted, matching `summon()`'s own
 *   fallback.
 */
export function setCraftShader(shader) {
  if (!currentSummon || currentSummon.despawned || !currentSummon.model) return;
  currentSummon.model.customShader = shader ?? DEFAULT_SHADER;
}

/**
 * Diagnostics for the qa gates (task: presence pass). `active` is true only
 * once the model has actually been added to the scene (not merely
 * requested); `holding` and `animating` track the render governor hold and
 * whether `activeAnimations` has actually started, independently - the two
 * can briefly disagree in the window between the model arriving and its
 * own `readyEvent` firing. `discardedLoads` and `lastDiscardDestroyed` are
 * fix-round evidence (finding 1) for the despawn-during-load GPU leak fix,
 * independent of whatever is currently summoned.
 * @returns {{active: boolean, shape: string|null, holding: boolean,
 *   animating: boolean, discardedLoads: number,
 *   lastDiscardDestroyed: boolean|null}}
 */
export function getSummonDiagnostics() {
  if (!currentSummon || currentSummon.despawned)
    return {
      active: false,
      shape: null,
      holding: false,
      animating: false,
      discardedLoads,
      lastDiscardDestroyed,
    };
  return {
    active: Boolean(currentSummon.model),
    shape: currentSummon.shape,
    holding: currentSummon.holding,
    animating: currentSummon.animating,
    discardedLoads,
    lastDiscardDestroyed,
  };
}
