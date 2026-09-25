import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, bearingDeg, elevationDeg } from './geometry.js';

const LONDON = { lat: 51.5074, lon: -0.1278 };
const PARIS = { lat: 48.8566, lon: 2.3522 };

test('haversineKm: London to Paris is within 340-350 km', () => {
  const km = haversineKm(LONDON, PARIS);
  assert.ok(km >= 340 && km <= 350, `expected 340-350, got ${km}`);
});

test('haversineKm: a point to itself is zero', () => {
  assert.equal(haversineKm(LONDON, LONDON), 0);
});

test('bearingDeg: London to Paris is within 145-155 degrees true', () => {
  const bearing = bearingDeg(LONDON, PARIS);
  assert.ok(
    bearing >= 145 && bearing <= 155,
    `expected 145-155, got ${bearing}`,
  );
});

test('bearingDeg: stays within the 0-360 range', () => {
  const bearing = bearingDeg(PARIS, LONDON);
  assert.ok(bearing >= 0 && bearing < 360, `expected 0-360, got ${bearing}`);
});

test('elevationDeg: a 10,000 m target at 20 km is within 26-28 degrees', () => {
  const observer = { lat: 51.5074, lon: -0.1278 };
  // Roughly 20 km due north of the observer.
  const target = { lat: 51.6874, lon: -0.1278, altM: 10000 };
  const elevation = elevationDeg(observer, target);
  assert.ok(
    elevation >= 26 && elevation <= 28,
    `expected 26-28, got ${elevation}`,
  );
});

test('elevationDeg: is undefined when the target carries no altM', () => {
  const observer = { lat: 51.5074, lon: -0.1278 };
  const target = { lat: 51.6874, lon: -0.1278 };
  assert.equal(elevationDeg(observer, target), undefined);
});
