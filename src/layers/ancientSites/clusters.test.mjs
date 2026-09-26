import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clusterSweep,
  cellDegForHeight,
  nextBandTargetHeight,
  CAMERA_BANDS,
} from './clusters.js';

/** Build a sweep accessor over plain [lat, lon] pairs, for test fixtures. */
function fixtureSweep(points) {
  return {
    length: points.length,
    lat: (i) => points[i][0],
    lon: (i) => points[i][1],
  };
}

test('clusterSweep collapses two nearby sites into one cluster with the right count and centroid', () => {
  const sweep = fixtureSweep([
    [51.0, -1.0],
    [51.1, -1.1],
  ]);
  const { clusters, singles } = clusterSweep(sweep, { cellDeg: 5 });
  assert.equal(clusters.length, 1);
  assert.equal(singles.length, 0);
  assert.equal(clusters[0].count, 2);
  assert.equal(clusters[0].sampleIndex, 0);
  assert.ok(Math.abs(clusters[0].lat - 51.05) < 1e-9);
  assert.ok(Math.abs(clusters[0].lon - -1.05) < 1e-9);
});

test('clusterSweep keeps a lone site in a cell as a single, not a cluster', () => {
  const sweep = fixtureSweep([[10, 10]]);
  const { clusters, singles } = clusterSweep(sweep, { cellDeg: 5 });
  assert.equal(clusters.length, 0);
  assert.deepEqual(singles, [{ index: 0 }]);
});

test('clusterSweep separates sites into different cells when they are far apart', () => {
  const sweep = fixtureSweep([
    [10, 10],
    [-40, 120],
  ]);
  const { clusters, singles } = clusterSweep(sweep, { cellDeg: 5 });
  assert.equal(clusters.length, 0);
  assert.equal(singles.length, 2);
  assert.deepEqual(singles.map((s) => s.index).sort(), [0, 1]);
});

test('clusterSweep with cellDeg <= 0 disables grid clustering entirely', () => {
  const sweep = fixtureSweep([
    [51.0, -1.0],
    [51.001, -1.001],
    [51.002, -1.002],
  ]);
  const { clusters, singles } = clusterSweep(sweep, { cellDeg: 0 });
  assert.equal(clusters.length, 0);
  assert.equal(singles.length, 3);
});

test('clusterSweep drops sites outside the given bounds', () => {
  const sweep = fixtureSweep([
    [10, 10],
    [80, 170],
  ]);
  const { clusters, singles } = clusterSweep(sweep, {
    cellDeg: 5,
    bounds: { west: 0, south: 0, east: 20, north: 20 },
  });
  assert.equal(clusters.length, 0);
  assert.deepEqual(singles, [{ index: 0 }]);
});

test('clusterSweep bounds handle antimeridian wraparound (west > east)', () => {
  const sweep = fixtureSweep([
    [10, 179],
    [10, -179],
    [10, 0],
  ]);
  const { singles } = clusterSweep(sweep, {
    cellDeg: 0,
    bounds: { west: 170, south: 0, east: -170, north: 20 },
  });
  assert.deepEqual(singles.map((s) => s.index).sort(), [0, 1]);
});

test('clusterSweep ignores non-finite coordinates rather than throwing', () => {
  const sweep = fixtureSweep([
    [NaN, 10],
    [10, 10],
  ]);
  const { clusters, singles } = clusterSweep(sweep, { cellDeg: 5 });
  assert.equal(clusters.length, 0);
  assert.deepEqual(singles, [{ index: 1 }]);
});

test('clusterSweep on an empty sweep returns empty results', () => {
  const { clusters, singles } = clusterSweep(fixtureSweep([]), { cellDeg: 5 });
  assert.deepEqual(clusters, []);
  assert.deepEqual(singles, []);
});

test('cellDegForHeight selects the coarsest band at world altitude', () => {
  assert.equal(cellDegForHeight(9_000_000), 5);
  assert.equal(cellDegForHeight(8_000_000), 5);
});

test('cellDegForHeight selects the mid band just below the world floor', () => {
  assert.equal(cellDegForHeight(7_999_999), 2);
  assert.equal(cellDegForHeight(2_000_000), 2);
});

test('cellDegForHeight selects the near band just below the mid floor', () => {
  assert.equal(cellDegForHeight(1_999_999), 0.5);
  assert.equal(cellDegForHeight(500_000), 0.5);
});

test('cellDegForHeight disables clustering below the near floor', () => {
  assert.equal(cellDegForHeight(499_999), 0);
  assert.equal(cellDegForHeight(0), 0);
});

test('nextBandTargetHeight flies one band closer, landing inside the next band range', () => {
  const worldToMid = nextBandTargetHeight(9_000_000);
  assert.ok(worldToMid < CAMERA_BANDS[0].minHeight);
  assert.ok(worldToMid >= CAMERA_BANDS[1].minHeight);

  const midToNear = nextBandTargetHeight(5_000_000);
  assert.ok(midToNear < CAMERA_BANDS[1].minHeight);
  assert.ok(midToNear >= CAMERA_BANDS[2].minHeight);

  const nearToClose = nextBandTargetHeight(1_000_000);
  assert.ok(nearToClose < CAMERA_BANDS[2].minHeight);
});

test('nextBandTargetHeight just zooms in further when already at the closest band', () => {
  const target = nextBandTargetHeight(100_000);
  assert.ok(target < 100_000);
  assert.ok(target > 0);
});
