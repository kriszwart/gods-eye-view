import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findNearbyCases, NEARBY_RADIUS_KM, NEARBY_LIMIT } from './nearby.js';

// Earth radius used by nearby.js (mirrors src/spotter/geometry.js). For two
// points sharing a longitude, the haversine central angle is exactly their
// latitude difference, so the great-circle distance reduces to
// R * dLatRadians with no approximation. That closed form gives us
// hand-computed expectations without a third-party reference.
const EARTH_RADIUS_KM = 6371;
const kmPerDegree = (EARTH_RADIUS_KM * Math.PI) / 180; // ~111.1949 km

const row = (overrides) => ({
  id: 'geipan:sample',
  lat: 0,
  lon: 0,
  year: 1975,
  status: 'unresolved',
  ...overrides,
});

test('a row exactly at the claim is included at distance 0', () => {
  const claim = { lat: 48.8566, lon: 2.3522 };
  const { count, top } = findNearbyCases(claim, [
    row({ id: 'a', lat: 48.8566, lon: 2.3522 }),
  ]);
  assert.equal(count, 1);
  assert.equal(top.length, 1);
  assert.equal(top[0].index, 0);
  assert.equal(top[0].id, 'a');
  assert.ok(Math.abs(top[0].distanceKm) < 1e-9);
});

test('a row just inside the 50 km radius is counted (hand-computed distance)', () => {
  // 0.44 degrees of latitude at the same longitude: distance = 0.44 *
  // kmPerDegree ~= 48.93 km, inside the default 50 km radius.
  const claim = { lat: 0, lon: 0 };
  const target = row({ id: 'inside', lat: 0.44, lon: 0, year: 1961 });
  const expectedKm = 0.44 * kmPerDegree;
  const { count, top } = findNearbyCases(claim, [target]);
  assert.equal(count, 1);
  assert.equal(top[0].year, 1961);
  assert.equal(top[0].status, 'unresolved');
  assert.ok(
    Math.abs(top[0].distanceKm - expectedKm) < 0.001,
    `expected ~${expectedKm} km, got ${top[0].distanceKm}`,
  );
  assert.ok(top[0].distanceKm < NEARBY_RADIUS_KM);
});

test('a row just outside the 50 km radius is excluded (hand-computed distance)', () => {
  // 0.45 degrees of latitude: distance = 0.45 * kmPerDegree ~= 50.04 km,
  // just past the default 50 km radius.
  const claim = { lat: 0, lon: 0 };
  const target = row({ id: 'outside', lat: 0.45, lon: 0 });
  const expectedKm = 0.45 * kmPerDegree;
  assert.ok(expectedKm > NEARBY_RADIUS_KM, 'fixture must sit outside 50 km');
  const { count, top } = findNearbyCases(claim, [target]);
  assert.equal(count, 0);
  assert.deepEqual(top, []);
});

test('known cities far apart yield no matches', () => {
  const newYork = { lat: 40.7128, lon: -74.006 };
  const { count, top } = findNearbyCases(newYork, [
    row({ id: 'london', lat: 51.5074, lon: -0.1278 }),
  ]);
  assert.equal(count, 0);
  assert.deepEqual(top, []);
});

test('empty result: no rows within radius returns count 0 and an empty top', () => {
  const claim = { lat: 10, lon: 10 };
  const { count, top } = findNearbyCases(claim, []);
  assert.equal(count, 0);
  assert.deepEqual(top, []);
});

test('empty result: rows exist but none are close enough', () => {
  const claim = { lat: 0, lon: 0 };
  const rows = [row({ lat: 10, lon: 10 }), row({ lat: -20, lon: -30 })];
  const { count, top } = findNearbyCases(claim, rows);
  assert.equal(count, 0);
  assert.deepEqual(top, []);
});

test('antimeridian sanity: points straddling +/-180 longitude read as close, not half the globe apart', () => {
  // 0.1 degrees of longitude apart at the equator, one just past +180 wrap
  // (via -179.95) and one just before it (179.95). A naive dLon subtraction
  // (179.95 - -179.95 = 359.9 degrees) would wrongly read this as almost a
  // full circumference; the haversine formula's periodicity handles the
  // wrap correctly without any explicit normalisation.
  const claim = { lat: 0, lon: 179.95 };
  const target = row({ id: 'wrap', lat: 0, lon: -179.95 });
  const expectedKm = 0.1 * kmPerDegree; // ~11.12 km
  const { count, top } = findNearbyCases(claim, [target]);
  assert.equal(count, 1);
  assert.ok(
    Math.abs(top[0].distanceKm - expectedKm) < 0.01,
    `expected ~${expectedKm} km, got ${top[0].distanceKm}`,
  );
  assert.ok(
    top[0].distanceKm < 1000,
    'must not be read as roughly half the globe apart',
  );
});

test('more than the limit within radius: count reflects all, top keeps the nearest few, nearest first', () => {
  const claim = { lat: 0, lon: 0 };
  const rows = [0.4, 0.1, 0.3, 0.05, 0.2].map((deg, i) =>
    row({ id: `r${i}`, lat: deg, lon: 0, year: 1950 + i }),
  );
  const { count, top } = findNearbyCases(claim, rows);
  assert.equal(count, 5);
  assert.equal(top.length, NEARBY_LIMIT);
  const distances = top.map((c) => c.distanceKm);
  assert.deepEqual(
    distances,
    [...distances].sort((a, b) => a - b),
    'top must be sorted nearest first',
  );
  assert.equal(top[0].id, 'r3'); // 0.05 degrees: the nearest
  assert.equal(top[1].id, 'r1'); // 0.1 degrees
  assert.equal(top[2].id, 'r4'); // 0.2 degrees
});

test('a custom radius and limit are honoured', () => {
  const claim = { lat: 0, lon: 0 };
  const rows = [0.05, 0.1, 0.2, 0.3].map((deg, i) =>
    row({ id: `r${i}`, lat: deg, lon: 0 }),
  );
  const { count, top } = findNearbyCases(claim, rows, {
    radiusKm: 15,
    limit: 1,
  });
  // 15 km ~= 0.135 degrees, so only the first two rows (0.05, 0.1) qualify.
  assert.equal(count, 2);
  assert.equal(top.length, 1);
  assert.equal(top[0].id, 'r0');
});

test('rows missing or malformed are skipped, never thrown on', () => {
  const claim = { lat: 0, lon: 0 };
  const rows = [
    null,
    undefined,
    {},
    row({ id: 'bad-lat', lat: NaN, lon: 0 }),
    row({ id: 'bad-lon', lat: 0, lon: 'nope' }),
    row({ id: 'good', lat: 0.01, lon: 0 }),
  ];
  const { count, top } = findNearbyCases(claim, rows);
  assert.equal(count, 1);
  assert.equal(top[0].id, 'good');
});

test('a malformed claim or non-array rows return the honest empty shape', () => {
  assert.deepEqual(findNearbyCases(null, []), { count: 0, top: [] });
  assert.deepEqual(findNearbyCases({ lat: NaN, lon: 0 }, []), {
    count: 0,
    top: [],
  });
  assert.deepEqual(findNearbyCases({ lat: 0, lon: 0 }, null), {
    count: 0,
    top: [],
  });
  assert.deepEqual(findNearbyCases({ lat: 0, lon: 0 }, 'not-an-array'), {
    count: 0,
    top: [],
  });
});

test('a row with no status or non-finite year still reports honestly (null, not a guess)', () => {
  const claim = { lat: 0, lon: 0 };
  const { top } = findNearbyCases(claim, [
    { id: 'x', lat: 0, lon: 0, year: 'unknown', status: 7 },
  ]);
  assert.equal(top[0].year, null);
  assert.equal(top[0].status, null);
});
