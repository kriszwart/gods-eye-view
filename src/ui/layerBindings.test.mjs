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

/** A fake live-claims layer module recording every `attachShellServices`
 * call it receives, mirroring `makeFakeAncientModule` above. */
function makeFakeLiveClaimsModule() {
  const calls = [];
  return {
    calls,
    attachShellServices(services) {
      calls.push(services);
    },
  };
}

/** A fake data manager carrying a live-claims module and, optionally, an
 * anomalies module: `_connectLiveClaimsShell` looks both up by id, and
 * `focusAnomalyCase` re-checks `isEnabled('anomalies')` itself rather than
 * trusting a caller's own read. */
function makeFakeManagerWithLiveClaims({
  liveClaimsModule,
  anomaliesModule,
  anomaliesEnabled = true,
} = {}) {
  const layers = new Map();
  if (liveClaimsModule) layers.set('live-claims', { module: liveClaimsModule });
  if (anomaliesModule) layers.set('anomalies', { module: anomaliesModule });
  return {
    layers,
    isEnabled: (id) => (id === 'anomalies' ? anomaliesEnabled : true),
  };
}

test('_connectLiveClaimsShell attaches a live isAnomaliesEnabled and a focusAnomalyCase that reaches the sky register', async () => {
  const bindings = makeBindings();
  const liveClaims = makeFakeLiveClaimsModule();
  const focusCaseCalls = [];
  const anomalies = {
    async focusCase(id) {
      focusCaseCalls.push(id);
    },
  };
  bindings._dataManager = makeFakeManagerWithLiveClaims({
    liveClaimsModule: liveClaims,
    anomaliesModule: anomalies,
    anomaliesEnabled: true,
  });
  bindings._connectLiveClaimsShell();
  assert.equal(liveClaims.calls.length, 1);
  const services = liveClaims.calls[0];
  assert.equal(services.isAnomaliesEnabled(), true);
  const opened = await services.focusAnomalyCase('case-1');
  assert.equal(opened, true);
  assert.deepEqual(focusCaseCalls, ['case-1']);
});

test('_connectLiveClaimsShell.focusAnomalyCase is a no-op while the sky register is off, never enabling it on the visitor\'s behalf', async () => {
  const bindings = makeBindings();
  const liveClaims = makeFakeLiveClaimsModule();
  const focusCaseCalls = [];
  const anomalies = {
    async focusCase(id) {
      focusCaseCalls.push(id);
    },
  };
  bindings._dataManager = makeFakeManagerWithLiveClaims({
    liveClaimsModule: liveClaims,
    anomaliesModule: anomalies,
    anomaliesEnabled: false,
  });
  bindings._connectLiveClaimsShell();
  const services = liveClaims.calls[0];
  assert.equal(services.isAnomaliesEnabled(), false);
  const opened = await services.focusAnomalyCase('case-1');
  assert.equal(opened, false);
  assert.deepEqual(focusCaseCalls, [], 'the sky register is never enabled or focused on the visitor\'s behalf');
});

test('_connectLiveClaimsShell detaching to no manager detaches the outgoing module with a bare null', () => {
  const bindings = makeBindings();
  const liveClaims = makeFakeLiveClaimsModule();
  bindings._dataManager = makeFakeManagerWithLiveClaims({
    liveClaimsModule: liveClaims,
  });
  bindings._connectLiveClaimsShell();
  assert.equal(liveClaims.calls.length, 1);

  bindings._dataManager = null;
  bindings._connectLiveClaimsShell();
  assert.equal(liveClaims.calls.length, 2, 'the detach call');
  assert.equal(liveClaims.calls[1], null);
});
