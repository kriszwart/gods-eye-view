import test from 'node:test';
import assert from 'node:assert/strict';
import { LayerBindings } from './layerBindings.js';

/** Minimal LayerBindings instance: `_connectAncientSitesShell` only ever
 * touches `this._dataManager` and the ancient-sites module it looks up
 * through it, so nothing else the constructor accepts needs to be real. */
function makeBindings() {
  return new LayerBindings({
    viewer: {},
    services: {},
    readControls: () => ({}),
    operations: {},
    feedback: {},
    shareRestoration: {},
  });
}

/** A fake ancient-sites layer module recording every `attachShellServices`
 * call it receives, so a test can inspect exactly what the teardown path
 * passed. */
function makeFakeAncientModule() {
  const calls = [];
  return {
    calls,
    attachShellServices(services) {
      calls.push(services);
      return { notifySkyChanged() {} };
    },
  };
}

function makeFakeManager(ancientModule) {
  return {
    layers: new Map([['ancient-sites', { module: ancientModule }]]),
    isEnabled: () => true,
  };
}

test('_connectAncientSitesShell detaching to no manager keeps the deep-time dial down, not defaulting sky to off', () => {
  const bindings = makeBindings();
  const ancient = makeFakeAncientModule();
  bindings._dataManager = makeFakeManager(ancient);
  bindings._connectAncientSitesShell();
  assert.equal(ancient.calls.length, 1, 'the live attach call');

  // The manager goes away entirely (e.g. the shell rewiring): the outgoing
  // module must be detached in a way that keeps its dial hidden, never with
  // a bare null (which the layer's own attachShellServices(null) reads as
  // "sky is off" and would use to mount the dial).
  bindings._dataManager = null;
  bindings._connectAncientSitesShell();
  assert.equal(ancient.calls.length, 2, 'the detach call');
  const detachServices = ancient.calls[1];
  assert.notEqual(detachServices, null, 'must not detach with a bare null');
  assert.equal(
    typeof detachServices?.isSkyActive,
    'function',
    'must supply an isSkyActive so the layer never falls back to its own () => false default',
  );
  assert.equal(
    detachServices.isSkyActive(),
    true,
    'must assume the sky register might still be active, so the dial stays down',
  );
});

test('_connectAncientSitesShell detaching to a different ancient module (manager rewired) also keeps the outgoing dial down', () => {
  const bindings = makeBindings();
  const firstAncient = makeFakeAncientModule();
  bindings._dataManager = makeFakeManager(firstAncient);
  bindings._connectAncientSitesShell();
  assert.equal(firstAncient.calls.length, 1);

  const secondAncient = makeFakeAncientModule();
  bindings._dataManager = makeFakeManager(secondAncient);
  bindings._connectAncientSitesShell();

  assert.equal(firstAncient.calls.length, 2, 'the outgoing module is detached');
  const detachServices = firstAncient.calls[1];
  assert.notEqual(detachServices, null);
  assert.equal(detachServices.isSkyActive(), true);

  assert.equal(secondAncient.calls.length, 1, 'the incoming module gets the live attach');
  assert.equal(typeof secondAncient.calls[0].isSkyActive, 'function');
});
