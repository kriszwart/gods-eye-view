/**
 * Shared hover-pick helper contract tests (task: presence pass).
 *
 * Covers the pure throttle/resolve helpers directly, then the integrated
 * install/register/dispatch wiring against a minimal fake canvas and scene
 * (no Cesium, no DOM - `hoverPick.js` is duck-typed on `{scene: {canvas,
 * pick}}`, matching its own module doc comment).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldSample,
  canvasPositionOf,
  ownerOfPicked,
  installHoverPick,
  registerHoverClient,
  unregisterHoverClient,
  uninstallHoverPick,
  HOVER_THROTTLE_MS,
  HOVER_PICK_BOX_PX,
} from './hoverPick.js';
import { registerPickOwner, unregisterPickOwner } from '../data/pickRegistry.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('shouldSample: false before the interval elapses, true at and past it', () => {
  assert.equal(shouldSample(100, 50, 80), false); // 50ms elapsed, needs 80
  assert.equal(shouldSample(130, 50, 80), true); // exactly 80ms elapsed
  assert.equal(shouldSample(200, 50, 80), true); // well past
});

test('shouldSample: defaults to HOVER_THROTTLE_MS when no interval is given', () => {
  assert.equal(shouldSample(HOVER_THROTTLE_MS, 0), true);
  assert.equal(shouldSample(HOVER_THROTTLE_MS - 1, 0), false);
});

test('canvasPositionOf: translates client coordinates into the canvas-local space', () => {
  const canvas = { getBoundingClientRect: () => ({ left: 10, top: 20 }) };
  assert.deepEqual(canvasPositionOf({ clientX: 50, clientY: 70 }, canvas), {
    x: 40,
    y: 50,
  });
});

test('ownerOfPicked: resolves an already-picked result to its registered owner via the pick registry', () => {
  registerPickOwner('anomalies', (id) => id.startsWith('anomaly:'));
  try {
    assert.equal(ownerOfPicked({ id: { id: 'anomaly:1' } }), 'anomalies');
    assert.equal(ownerOfPicked({ id: { id: 'ancient:1' } }), null);
    assert.equal(ownerOfPicked(null), null);
    assert.equal(ownerOfPicked(undefined), null);
  } finally {
    unregisterPickOwner('anomalies');
  }
});

// ---------------------------------------------------------------------------
// Integrated install/register/dispatch wiring, against a fake canvas+scene
// ---------------------------------------------------------------------------

/** A minimal fake canvas: tracks its own listeners so the test can dispatch
 * a synthetic mousemove directly, and a plain `style` object so cursor
 * writes are observable. */
function fakeCanvas() {
  const listeners = new Map();
  let addCalls = 0;
  return {
    style: { cursor: '' },
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    addEventListener(type, fn) {
      addCalls++;
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
    dispatch(type, event) {
      listeners.get(type)?.(event);
    },
    hasListener(type) {
      return listeners.has(type);
    },
    addCallCount() {
      return addCalls;
    },
  };
}

/** Swap `globalThis.performance.now` for a controllable fake for the
 * duration of `fn`, restoring the original afterward even on failure - so
 * the throttle's real 80ms window never has to actually elapse in a test. */
async function withFakeNow(fn) {
  const original = globalThis.performance.now;
  let now = 0;
  globalThis.performance.now = () => now;
  try {
    await fn((next) => {
      now = next;
    });
  } finally {
    globalThis.performance.now = original;
  }
}

const MOVE = { clientX: 5, clientY: 5 };

test('installHoverPick: attaches one mousemove listener, idempotent for the same canvas', () => {
  const canvas = fakeCanvas();
  const scene = { canvas, pick: () => null };
  try {
    installHoverPick({ scene });
    assert.equal(canvas.hasListener('mousemove'), true);
    assert.equal(canvas.hasListener('mouseleave'), true);
    // One addEventListener call each for mousemove and mouseleave.
    assert.equal(canvas.addCallCount(), 2);
    installHoverPick({ scene }); // second call, same canvas: no-op
    installHoverPick({ scene }); // and a third, for good measure
    assert.equal(
      canvas.addCallCount(),
      2,
      'a repeat install for the same canvas must not attach a second pair of listeners',
    );
  } finally {
    uninstallHoverPick();
  }
});

test('registerHoverClient + dispatch: an owned pick calls onHover with the resolved id and sets the pointer cursor', async () => {
  await withFakeNow(async (setNow) => {
    const canvas = fakeCanvas();
    const picked = { id: { id: 'anomaly:1', anomalyId: '1' } };
    const scene = { canvas, pick: () => picked };
    registerPickOwner('anomalies', (id) => id.startsWith('anomaly:'));
    const hovers = [];
    try {
      installHoverPick({ scene });
      registerHoverClient('anomalies', {
        resolveHover: (p) => p?.id?.anomalyId ?? null,
        onHover: (id) => hovers.push(id),
      });
      setNow(1000);
      canvas.dispatch('mousemove', MOVE);
      assert.deepEqual(hovers, ['1']);
      assert.equal(canvas.style.cursor, 'pointer');
    } finally {
      uninstallHoverPick();
      unregisterPickOwner('anomalies');
    }
  });
});

test('the 80ms throttle bounds scene.pick to one call per window, regardless of move frequency', async () => {
  await withFakeNow(async (setNow) => {
    const canvas = fakeCanvas();
    let pickCalls = 0;
    const scene = {
      canvas,
      pick: () => {
        pickCalls++;
        return null;
      },
    };
    try {
      installHoverPick({ scene });
      registerHoverClient('anomalies', { onHover: () => {} });
      setNow(1000);
      canvas.dispatch('mousemove', MOVE); // picks
      setNow(1010);
      canvas.dispatch('mousemove', MOVE); // within the window: skipped
      setNow(1079);
      canvas.dispatch('mousemove', MOVE); // still within the window: skipped
      setNow(1080);
      canvas.dispatch('mousemove', MOVE); // exactly at the window: picks again
      assert.equal(pickCalls, 2);
    } finally {
      uninstallHoverPick();
    }
  });
});

test('moving off an owned pick clears that client\'s hover and the cursor', async () => {
  await withFakeNow(async (setNow) => {
    const canvas = fakeCanvas();
    let picked = { id: { id: 'anomaly:1', anomalyId: '1' } };
    const scene = { canvas, pick: () => picked };
    registerPickOwner('anomalies', (id) => id.startsWith('anomaly:'));
    const hovers = [];
    try {
      installHoverPick({ scene });
      registerHoverClient('anomalies', {
        resolveHover: (p) => p?.id?.anomalyId ?? null,
        onHover: (id) => hovers.push(id),
      });
      setNow(1000);
      canvas.dispatch('mousemove', MOVE);
      assert.equal(canvas.style.cursor, 'pointer');
      picked = null; // pointer now over empty space
      setNow(1080);
      canvas.dispatch('mousemove', MOVE);
      assert.deepEqual(hovers, ['1', null]);
      assert.equal(canvas.style.cursor, '');
    } finally {
      uninstallHoverPick();
      unregisterPickOwner('anomalies');
    }
  });
});

test('mouseleave clears the current hover and cursor, mirroring moving off an owned pick', async () => {
  await withFakeNow(async (setNow) => {
    const canvas = fakeCanvas();
    const picked = { id: { id: 'anomaly:1', anomalyId: '1' } };
    const scene = { canvas, pick: () => picked };
    registerPickOwner('anomalies', (id) => id.startsWith('anomaly:'));
    const hovers = [];
    try {
      installHoverPick({ scene });
      registerHoverClient('anomalies', {
        resolveHover: (p) => p?.id?.anomalyId ?? null,
        onHover: (id) => hovers.push(id),
      });
      setNow(1000);
      canvas.dispatch('mousemove', MOVE);
      assert.deepEqual(hovers, ['1']);
      assert.equal(canvas.style.cursor, 'pointer');
      // The pointer leaves the canvas (onto a dossier plate, the dial, or
      // out of the window entirely) rather than moving to another spot on
      // the canvas - no further mousemove ever fires for this.
      canvas.dispatch('mouseleave', {});
      assert.deepEqual(hovers, ['1', null]);
      assert.equal(canvas.style.cursor, '');
    } finally {
      uninstallHoverPick();
      unregisterPickOwner('anomalies');
    }
  });
});

test('switching to a pick owned by a different registered client clears the previous one first', async () => {
  await withFakeNow(async (setNow) => {
    const canvas = fakeCanvas();
    let picked = { id: { id: 'anomaly:1', anomalyId: '1' } };
    const scene = { canvas, pick: () => picked };
    registerPickOwner('anomalies', (id) => id.startsWith('anomaly:'));
    registerPickOwner('ancient-sites', (id) => id.startsWith('ancient:'));
    const anomalyHovers = [];
    const ancientHovers = [];
    try {
      installHoverPick({ scene });
      registerHoverClient('anomalies', {
        resolveHover: (p) => p?.id?.anomalyId ?? null,
        onHover: (id) => anomalyHovers.push(id),
      });
      registerHoverClient('ancient-sites', {
        resolveHover: (p) => p?.id?.ancientId ?? null,
        onHover: (id) => ancientHovers.push(id),
      });
      setNow(1000);
      canvas.dispatch('mousemove', MOVE);
      assert.deepEqual(anomalyHovers, ['1']);
      picked = { id: { id: 'ancient:stonehenge', ancientId: 'stonehenge' } };
      setNow(1080);
      canvas.dispatch('mousemove', MOVE);
      assert.deepEqual(anomalyHovers, ['1', null]);
      assert.deepEqual(ancientHovers, ['stonehenge']);
      assert.equal(canvas.style.cursor, 'pointer');
    } finally {
      uninstallHoverPick();
      unregisterPickOwner('anomalies');
      unregisterPickOwner('ancient-sites');
    }
  });
});

test('a pick owned by an unrelated, non-hover-registered layer never touches a cursor this module did not itself set', async () => {
  // 'flights' owns this pick (registered for click ownership, exactly as
  // src/app/layers/flights.js does), but never registered a HOVER client
  // here - its own independent MOUSE_MOVE handler
  // (src/layers/launches/lifecycle.js) sets 'pointer'/'grab' on its own,
  // outside this module entirely. Starting from a cursor THIS module never
  // wrote (simulating that other handler having already set it this same
  // frame) proves the "only clear what we set" rule from the module doc
  // comment: `_weSetPointer` stays false throughout, so applyCursor's
  // `else if (_weSetPointer)` branch never fires.
  await withFakeNow(async (setNow) => {
    const canvas = fakeCanvas();
    canvas.style.cursor = 'grab'; // some other feature's own write
    const picked = { id: { id: 'flight:aaa001' } };
    const scene = { canvas, pick: () => picked };
    registerPickOwner('anomalies', (id) => id.startsWith('anomaly:'));
    registerPickOwner('flights', (id) => id.startsWith('flight:'));
    try {
      installHoverPick({ scene });
      registerHoverClient('anomalies', {
        resolveHover: (p) => p?.id?.anomalyId ?? null,
        onHover: () => {},
      });
      setNow(1000);
      canvas.dispatch('mousemove', MOVE);
      assert.equal(
        canvas.style.cursor,
        'grab',
        'a pick this module has no hover client for must leave the existing cursor alone',
      );
    } finally {
      uninstallHoverPick();
      unregisterPickOwner('anomalies');
      unregisterPickOwner('flights');
    }
  });
});

test('unregisterHoverClient clears that client\'s own hover and the cursor if it was the one hovered', async () => {
  await withFakeNow(async (setNow) => {
    const canvas = fakeCanvas();
    const picked = { id: { id: 'anomaly:1', anomalyId: '1' } };
    const scene = { canvas, pick: () => picked };
    registerPickOwner('anomalies', (id) => id.startsWith('anomaly:'));
    const hovers = [];
    try {
      installHoverPick({ scene });
      registerHoverClient('anomalies', {
        resolveHover: (p) => p?.id?.anomalyId ?? null,
        onHover: (id) => hovers.push(id),
      });
      setNow(1000);
      canvas.dispatch('mousemove', MOVE);
      assert.deepEqual(hovers, ['1']);
      assert.equal(canvas.style.cursor, 'pointer');
      unregisterHoverClient('anomalies');
      assert.deepEqual(hovers, ['1', null]);
      assert.equal(canvas.style.cursor, '');
    } finally {
      uninstallHoverPick();
      unregisterPickOwner('anomalies');
    }
  });
});

test('no registered clients: the pick is skipped entirely (never called)', () => {
  const canvas = fakeCanvas();
  let pickCalls = 0;
  const scene = {
    canvas,
    pick: () => {
      pickCalls++;
      return null;
    },
  };
  try {
    installHoverPick({ scene });
    canvas.dispatch('mousemove', MOVE);
    assert.equal(pickCalls, 0);
  } finally {
    uninstallHoverPick();
  }
});

test('uninstallHoverPick removes the listener and clears every client', () => {
  const canvas = fakeCanvas();
  const scene = { canvas, pick: () => null };
  installHoverPick({ scene });
  registerHoverClient('anomalies', { onHover: () => {} });
  uninstallHoverPick();
  assert.equal(canvas.hasListener('mousemove'), false);
  assert.equal(canvas.hasListener('mouseleave'), false);
  // A fresh install on the same canvas re-attaches (proves state was really
  // cleared, not just the listener skipped as "already installed").
  installHoverPick({ scene });
  assert.equal(canvas.hasListener('mousemove'), true);
  assert.equal(canvas.hasListener('mouseleave'), true);
  uninstallHoverPick();
});
