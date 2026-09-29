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
 *   assetBase?: string}} options `render` mirrors the object every
 *   register's own renderer already receives (`src/renderGovernor.js`'s
 *   three exports); omitted, the summon falls back to a direct
 *   `scene.requestRender()` and never takes a continuous hold. `assetBase`
 *   mirrors the calling register's own configured base (`'/anomalies/'` by
 *   default - the only craft library the app ships; `src/layers/liveClaims`
 *   has none of its own and passes the anomalies one through).
 * @returns {{despawn: () => void}}
 */
export function summon({
  viewer,
  shape,
  lat,
  lon,
  render,
  assetBase = '/anomalies/',
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
  })
    .then((model) => {
      // Despawned while loading (a rapid second summon, or the dossier
      // closed before the GLB arrived): discard without ever touching the
      // scene or taking a hold.
      if (state.despawned) return;
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
 * Diagnostics for the qa gates (task: presence pass). `active` is true only
 * once the model has actually been added to the scene (not merely
 * requested); `holding` and `animating` track the render governor hold and
 * whether `activeAnimations` has actually started, independently - the two
 * can briefly disagree in the window between the model arriving and its
 * own `readyEvent` firing.
 * @returns {{active: boolean, shape: string|null, holding: boolean,
 *   animating: boolean}}
 */
export function getSummonDiagnostics() {
  if (!currentSummon || currentSummon.despawned)
    return { active: false, shape: null, holding: false, animating: false };
  return {
    active: Boolean(currentSummon.model),
    shape: currentSummon.shape,
    holding: currentSummon.holding,
    animating: currentSummon.animating,
  };
}
