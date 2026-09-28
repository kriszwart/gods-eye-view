import test from 'node:test';
import assert from 'node:assert/strict';
import { LayerBindings } from './layerBindings.js';
import { searchCasesWithIndex } from '../app/caseSearch.js';

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

// Cross-register search caching (fix round, finding 2): a transient
// tier-fetch failure on the very first search call must not strand a
// degraded corpus (or an index built from it) in the instance cache for the
// rest of the session. `_anomalySearchSource`/`_ancientSearchSource` are
// plain instance fields set lazily with `||=` inside `_getSkySearchRecords`/
// `_getAncientSnapshot`, so pre-setting them here before the first call
// substitutes a fake in place of the real `createAnomalySource`/
// `createAncientSource` fetches, without needing to mock a module.

/** A fake search source that throws on every `getSnapshot()` call while
 * `state.failing` is true, and returns `makeValue()` once flipped to false.
 * `_getSkySearchRecords` is called twice within a single
 * `_buildCaseSearchRecords()` round (directly, and again inside
 * `_getGeipanSearchRecords`, since neither call has resolved and cached yet
 * when the other starts) - scripting by a shared failing/succeeding state
 * rather than a fixed per-call sequence keeps both of that round's calls
 * consistent with each other, the way a real network outage would, rather
 * than one arbitrarily drawing a later "already recovered" step. */
function makeSwitchableSearchSource(makeValue) {
  const state = { failing: true };
  return {
    state,
    async getSnapshot() {
      if (state.failing) throw new Error('network hiccup');
      return makeValue();
    },
  };
}

/** An ancient-sites snapshot with a given hero list and an empty sweep -
 * enough shape for `_getAncientSearchRecords`/`_getAncientSweepSearchRecords`
 * to run without needing a real `sites.v2.json`. */
function makeAncientSnapshot(heroes = []) {
  return {
    heroes,
    sweep: { length: 0, name: () => '', typeName: () => '', countryName: () => '' },
    count: heroes.length,
  };
}

test('_buildCaseSearchRecords does not cache a corpus degraded by a transient tier-fetch failure, and completes on retry', async () => {
  const bindings = makeBindings();
  const skyRows = [
    { id: 'sky-1', title: 'Roswell debris', year: 1947, craft: 'disc' },
  ];
  const skySource = makeSwitchableSearchSource(() => skyRows);
  bindings._anomalySearchSource = skySource;
  bindings._ancientSearchSource = {
    async getSnapshot() {
      return makeAncientSnapshot([
        {
          id: 'ancient-1',
          name: 'Stonehenge',
          type: 'circle',
          period: 'c. 2500 BCE',
          country: 'United Kingdom',
        },
      ]);
    },
  };

  const firstPass = await bindings._buildCaseSearchRecords();
  assert.equal(
    firstPass.some((r) => r.title === 'Roswell debris'),
    false,
    'the sky tier failed this round, so its record is missing from this call',
  );
  assert.equal(
    firstPass.some((r) => r.title === 'Stonehenge'),
    true,
    'the ancient tier succeeded and is still present',
  );
  assert.equal(
    bindings._caseSearchRecords,
    null,
    'a corpus degraded by a tier failure must not be cached',
  );

  skySource.state.failing = false;
  const secondPass = await bindings._buildCaseSearchRecords();
  assert.equal(
    secondPass.some((r) => r.title === 'Roswell debris'),
    true,
    'a retry after the transient failure completes the corpus',
  );
  assert.equal(
    bindings._caseSearchRecords,
    secondPass,
    'a fully-succeeded corpus is now cached',
  );
});

test('_getCaseSearchIndex does not cache an index built from a degraded corpus, and completes on retry', async () => {
  const bindings = makeBindings();
  const skySource = makeSwitchableSearchSource(() => [
    { id: 'sky-1', title: 'Roswell debris', year: 1947, craft: 'disc' },
  ]);
  bindings._anomalySearchSource = skySource;
  bindings._ancientSearchSource = {
    async getSnapshot() {
      return makeAncientSnapshot([]);
    },
  };

  const firstIndex = await bindings._getCaseSearchIndex();
  assert.equal(
    bindings._caseSearchIndex,
    null,
    'an index built from a degraded corpus must not be cached',
  );
  assert.deepEqual(
    searchCasesWithIndex('roswell', firstIndex),
    [],
    'the sky tier failed this round, so this call\'s own index cannot find it',
  );

  skySource.state.failing = false;
  const secondIndex = await bindings._getCaseSearchIndex();
  assert.notEqual(
    bindings._caseSearchIndex,
    null,
    'the fully-succeeded index is now cached',
  );
  assert.equal(
    searchCasesWithIndex('roswell', secondIndex)[0]?.id,
    'sky-1',
    'a retry after the transient failure finds the sky record',
  );
});
