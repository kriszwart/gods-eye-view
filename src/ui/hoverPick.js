/**
 * Shared hover-pick helper for the atlas's three registers (sky events,
 * ancient sites, live claims) - task: presence pass.
 *
 * One throttled `mousemove` listener on the viewer canvas, one
 * `scene.pick()` per allowed tick (never a raw per-mousemove pick, never
 * `drillPick`), resolved to an owning register via the existing pick
 * registry (`src/data/pickRegistry.js`'s own `ownerOf`, reusing the exact
 * predicates each register already installs for click ownership rather than
 * duplicating that logic here). The owning register's own `onHover`
 * callback fires with whatever id shape its own `resolveHover` extracts
 * from the picked result (mirroring its `pick()` click path's extraction,
 * given the SAME already-picked result rather than picking the scene
 * again); every other registered client is told `onHover(null)`.
 *
 * Module-scope singleton state (mirrors `pickRegistry.js`'s own style):
 * the app runs exactly one Cesium viewer for its whole lifetime, so a
 * factory per instance buys nothing and only complicates the three
 * registers' own wiring, each of which would otherwise need to hold and
 * thread an extra object.
 *
 * Cursor: set to `'pointer'` only while a registered client's hover
 * resolves to a non-null id, cleared back to `''` only when THIS module was
 * the one that last set it. Other GEV features already write
 * `scene.canvas.style.cursor` directly and unconditionally on their own
 * independent listeners (`src/layers/launches/lifecycle.js`'s mission
 * hover, `src/data/cctvGizmo.js`'s gizmo hover) - there is no existing
 * central cursor manager to defer to. Composing with that precedent means
 * never assuming ownership of the whole cursor: this module's own pick box
 * is wide (12px, matching every register's click box) and scans through
 * EVERY registered pick owner via `ownerOf` (not just this module's own
 * three hover-aware registers), so it routinely lands on ids some other
 * unrelated layer owns (a flight, a CCTV gizmo handle) for which no hover
 * CLIENT is registered here. Unconditionally clearing the cursor to `''` in
 * that branch - the naive approach, and what the two existing writers above
 * already do to each other - would fight whichever of those other features
 * just set it to `'pointer'`/`'grab'` on its own listener for the exact
 * same pixel. Tracking "did WE set it" avoids that: this module only ever
 * touches the cursor coming from or going back to its own prior write.
 */
import { resolvePickId, ownerOf } from '../data/pickRegistry.js';

/** Matches every register's own `CLICK_PICK_BOX_PX` (anomalies/rendering.js,
 * ancientSites/rendering.js, liveClaims/rendering.js): these points render
 * small even at close range. */
export const HOVER_PICK_BOX_PX = 12;

/** Controller ruling (presence pass): hover pick is throttled to roughly
 * 80ms, bounding the added `scene.pick` cost to at most ~12.5 picks/second
 * regardless of how fast the pointer moves. */
export const HOVER_THROTTLE_MS = 80;

let _canvas = null;
let _scene = null;
let _listener = null;
/** layerId -> { resolveHover?(picked): id|null, onHover(id|null): void } */
const _clients = new Map();
/** The layerId whose `onHover` last received a non-null id, or null. */
let _hoveredOwner = null;
let _lastPickAt = 0;
/** True only while the cursor's current `'pointer'` came from THIS module -
 * see the module doc comment's "never fight it" note above. */
let _weSetPointer = false;

/**
 * Pure throttle gate: true once at least `intervalMs` has elapsed since
 * `lastAtMs`. Exported so the throttling itself is unit-testable without a
 * real canvas or timers.
 * @param {number} nowMs
 * @param {number} lastAtMs
 * @param {number} [intervalMs]
 * @returns {boolean}
 */
export function shouldSample(nowMs, lastAtMs, intervalMs = HOVER_THROTTLE_MS) {
  return nowMs - lastAtMs >= intervalMs;
}

/**
 * A `mousemove` event's position translated into the canvas's own local
 * (CSS-pixel) coordinate space - the same space `scene.pick`/
 * `ScreenSpaceEventHandler` positions live in. Pure given a minimal
 * `{clientX, clientY}` event and a `{getBoundingClientRect()}` canvas, so
 * it is unit-testable with plain fakes.
 * @param {{clientX: number, clientY: number}} event
 * @param {{getBoundingClientRect: () => {left: number, top: number}}} canvas
 * @returns {{x: number, y: number}}
 */
export function canvasPositionOf(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/**
 * Resolve an already-picked `scene.pick()` result to the registered layer
 * id that owns it (or `null`), via the pick registry's own `ownerOf` -
 * reusing the exact ownership predicates each register's `enable()` already
 * installs for click disambiguation, never a second copy of that logic.
 * Pure given `picked` (the caller owns the single `scene.pick` call).
 * @param {object|null|undefined} picked
 * @returns {string|null}
 */
export function ownerOfPicked(picked) {
  const pickedId = resolvePickId(picked);
  return pickedId ? ownerOf(pickedId) : null;
}

/** Set the canvas cursor, tracking whether THIS module owns the current
 * `'pointer'` (see the module doc comment). */
function applyCursor(hovering) {
  if (!_canvas?.style) return;
  if (hovering) {
    _canvas.style.cursor = 'pointer';
    _weSetPointer = true;
  } else if (_weSetPointer) {
    _canvas.style.cursor = '';
    _weSetPointer = false;
  }
}

/** Tell the previous owner (if different) its hover is gone, tell the new
 * owner (if any) its hover id, and sync the cursor - the one place hover
 * state actually changes. */
function applyHover(ownerId, hoverId) {
  if (_hoveredOwner && _hoveredOwner !== ownerId) {
    _clients.get(_hoveredOwner)?.onHover?.(null);
  }
  if (ownerId) _clients.get(ownerId)?.onHover?.(hoverId);
  _hoveredOwner = ownerId;
  applyCursor(ownerId !== null);
}

function handleMove(event) {
  // Nothing registered (every register disabled, or none of the three ever
  // enabled this session): skip the pick entirely, not just the dispatch -
  // the whole point of the throttle is bounding `scene.pick` calls, and an
  // unregistered tick has nobody to tell anyway.
  if (!_clients.size || !_scene || !_canvas) return;
  const now = performance.now();
  if (!shouldSample(now, _lastPickAt)) return;
  _lastPickAt = now;
  const windowPosition = canvasPositionOf(event, _canvas);
  let picked;
  try {
    picked = _scene.pick(windowPosition, HOVER_PICK_BOX_PX, HOVER_PICK_BOX_PX);
  } catch {
    picked = undefined;
  }
  const ownerId = ownerOfPicked(picked);
  const client = ownerId ? _clients.get(ownerId) : null;
  if (client) {
    const hoverId =
      typeof client.resolveHover === 'function'
        ? client.resolveHover(picked)
        : resolvePickId(picked);
    if (hoverId != null) {
      applyHover(ownerId, hoverId);
      return;
    }
  }
  applyHover(null, null);
}

/**
 * Install the shared throttled `mousemove` listener on `viewer`'s canvas.
 * Idempotent for the same canvas (every register's `init()` calls this with
 * the same app-wide viewer, so only the first call actually attaches
 * anything); re-points to a new canvas if one is ever supplied (a fresh
 * viewer in a test harness), tearing down the previous listener first.
 * @param {{scene: {canvas: object, pick: Function}}|null|undefined} viewer
 * @returns {void}
 */
export function installHoverPick(viewer) {
  const scene = viewer?.scene;
  const canvas = scene?.canvas;
  if (!canvas || typeof canvas.addEventListener !== 'function') return;
  if (_canvas === canvas) return;
  if (_canvas && _listener) _canvas.removeEventListener('mousemove', _listener);
  _scene = scene;
  _canvas = canvas;
  _listener = (event) => handleMove(event);
  _canvas.addEventListener('mousemove', _listener);
}

/**
 * Register a register's hover client. `resolveHover(picked)` extracts that
 * register's own semantic id (or `null`) from an already-picked
 * `scene.pick()` result - mirroring its `pick()` click path's own
 * extraction, given the SAME picked result rather than picking again;
 * omit it to fall back to the raw resolved pick-id string. `onHover(id)`
 * receives that id, or `null` when this register's hover just ended
 * (moved off, or another register's pick now owns the cursor).
 * @param {string} layerId
 * @param {{resolveHover?: (picked: object) => *, onHover: (id: *) => void}} client
 * @returns {void}
 */
export function registerHoverClient(layerId, client) {
  if (!layerId || typeof client?.onHover !== 'function') return;
  _clients.set(layerId, client);
}

/** Unregister a register's hover client (call on disable/destroy), clearing
 * its own hover state first if it was the one currently hovered. */
export function unregisterHoverClient(layerId) {
  const client = _clients.get(layerId);
  const wasHovered = _hoveredOwner === layerId;
  _clients.delete(layerId);
  if (wasHovered) {
    client?.onHover?.(null);
    _hoveredOwner = null;
    applyCursor(false);
  }
}

/** Full teardown (tests, and a viewer that is itself torn down): removes
 * the listener, clears every client and all hover/cursor state. */
export function uninstallHoverPick() {
  if (_canvas && _listener) _canvas.removeEventListener('mousemove', _listener);
  _canvas = null;
  _scene = null;
  _listener = null;
  _clients.clear();
  _hoveredOwner = null;
  _lastPickAt = 0;
  _weSetPointer = false;
}
