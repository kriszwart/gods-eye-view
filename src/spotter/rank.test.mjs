import test from 'node:test';
import assert from 'node:assert/strict';
import { rankCandidates } from './rank.js';

const OBSERVATION = { lat: 51.5074, lon: -0.1278 };

// Roughly 10 km due north of the observation.
const NEAR_AIRCRAFT = {
  id: 'a1',
  kind: 'aircraft',
  label: 'BAW123',
  lat: 51.5974,
  lon: -0.1278,
  altM: 11000,
};

// Roughly 100 km due north: within the default 150 km radius, but far.
const FAR_SATELLITE = {
  id: 's1',
  kind: 'satellite',
  label: 'ISS',
  lat: 52.4074,
  lon: -0.1278,
  altM: 420000,
};

// Roughly 222 km due north: outside the default 150 km radius.
const BEYOND_RADIUS = {
  id: 'l1',
  kind: 'lightning',
  label: 'Strike',
  lat: 53.5074,
  lon: -0.1278,
};

test('rankCandidates filters candidates beyond the radius', () => {
  const rows = rankCandidates(OBSERVATION, [NEAR_AIRCRAFT, BEYOND_RADIUS]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'a1');
});

test('rankCandidates respects a smaller radiusKm override', () => {
  const rows = rankCandidates({ ...OBSERVATION, radiusKm: 50 }, [
    NEAR_AIRCRAFT,
    FAR_SATELLITE,
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'a1');
});

test('rankCandidates orders a near aircraft above a far satellite', () => {
  const rows = rankCandidates(OBSERVATION, [FAR_SATELLITE, NEAR_AIRCRAFT]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'a1');
  assert.equal(rows[1].id, 's1');
  assert.ok(rows[0].score > rows[1].score);
});

test('rankCandidates rows carry distanceKm, bearingDeg, elevationDeg and a why with the compass point', () => {
  const rows = rankCandidates(OBSERVATION, [NEAR_AIRCRAFT]);
  const [row] = rows;
  assert.equal(row.id, 'a1');
  assert.equal(row.kind, 'aircraft');
  assert.equal(row.label, 'BAW123');
  assert.ok(
    row.distanceKm >= 9 && row.distanceKm <= 11,
    `expected ~10, got ${row.distanceKm}`,
  );
  assert.ok(row.bearingDeg >= 0 && row.bearingDeg < 360);
  assert.ok(row.elevationDeg > 0);
  assert.match(row.why, /north/);
  assert.match(row.why, /km/);
});

test('rankCandidates omits elevationDeg and the altitude clause when a candidate has no altM', () => {
  const rows = rankCandidates(OBSERVATION, [BEYOND_RADIUS], undefined);
  // BEYOND_RADIUS is outside the default radius, so widen it to include the candidate.
  const wideRows = rankCandidates({ ...OBSERVATION, radiusKm: 250 }, [
    BEYOND_RADIUS,
  ]);
  assert.equal(rows.length, 0);
  assert.equal(wideRows.length, 1);
  assert.equal(wideRows[0].elevationDeg, undefined);
  assert.doesNotMatch(wideRows[0].why, / m,/);
});
