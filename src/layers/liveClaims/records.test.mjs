import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClaimRow, normalizeClaimsSnapshot } from './records.js';
import {
  brightnessForAge,
  pointAlpha,
  pointPixelSize,
  mapAnalystRecord,
  BRIGHTNESS_FLOOR,
  CLAIM_WINDOW_MS,
} from './model.js';

const validRow = () => ({
  id: 'reddit:abc123',
  url: 'https://example.com/reddit/abc123',
  source: 'reddit',
  lat: 40.7128,
  lon: -74.006,
  place: 'New York City, New York, United States',
  shape: 'triangle',
  when: null,
  fetchedAt: '2026-09-27T12:00:00.000Z',
});

test('normalizeClaimRow accepts a well-formed row', () => {
  const row = normalizeClaimRow(validRow());
  assert.deepEqual(row, validRow());
});

test('normalizeClaimRow rejects malformed rows', () => {
  assert.equal(normalizeClaimRow(null), null);
  assert.equal(normalizeClaimRow({ ...validRow(), id: '' }), null);
  assert.equal(normalizeClaimRow({ ...validRow(), source: 'twitter' }), null);
  assert.equal(normalizeClaimRow({ ...validRow(), lat: 200 }), null);
  assert.equal(normalizeClaimRow({ ...validRow(), lon: -200 }), null);
  assert.equal(normalizeClaimRow({ ...validRow(), place: '' }), null);
  assert.equal(
    normalizeClaimRow({ ...validRow(), place: 'x'.repeat(200) }),
    null,
  );
  assert.equal(
    normalizeClaimRow({ ...validRow(), url: 'javascript:alert(1)' }),
    null,
  );
  assert.equal(normalizeClaimRow({ ...validRow(), fetchedAt: 'nope' }), null);
});

test('normalizeClaimRow drops an unknown shape and keeps a stated one', () => {
  assert.equal(normalizeClaimRow({ ...validRow(), shape: '' }).shape, null);
  assert.equal(normalizeClaimRow({ ...validRow(), shape: 'orb' }).shape, 'orb');
});

test('normalizeClaimsSnapshot decodes a valid response, drops bad rows, dedupes ids', () => {
  const snapshot = normalizeClaimsSnapshot({
    claims: [validRow(), { bad: true }, validRow()],
    status: 'ok',
    unplaced: 2,
  });
  assert.equal(snapshot.claims.length, 1);
  assert.equal(snapshot.status, 'ok');
  assert.equal(snapshot.unplaced, 2);
});

test('normalizeClaimsSnapshot honours the keyless status with an empty register', () => {
  const snapshot = normalizeClaimsSnapshot({
    claims: [],
    status: 'no-key',
    unplaced: 0,
  });
  assert.deepEqual(snapshot, { claims: [], status: 'no-key', unplaced: 0 });
});

test('normalizeClaimsSnapshot rejects an unrecognisable payload', () => {
  assert.equal(normalizeClaimsSnapshot(null), null);
  assert.equal(normalizeClaimsSnapshot({ status: 'other' }), null);
});

test('brightnessForAge encodes recency only, newest brightest, with a floor', () => {
  assert.equal(brightnessForAge(0), 1);
  assert.equal(brightnessForAge(-100), 1);
  assert.ok(
    Math.abs(brightnessForAge(CLAIM_WINDOW_MS) - BRIGHTNESS_FLOOR) < 1e-9,
  );
  assert.ok(
    Math.abs(brightnessForAge(CLAIM_WINDOW_MS * 10) - BRIGHTNESS_FLOOR) < 1e-9,
  );
  const half = brightnessForAge(CLAIM_WINDOW_MS / 2);
  assert.ok(half < 1 && half > BRIGHTNESS_FLOOR);
});

test('pointPixelSize and pointAlpha increase monotonically with brightness', () => {
  assert.ok(pointPixelSize(1) > pointPixelSize(0));
  assert.ok(pointAlpha(1) > pointAlpha(0));
});

test('mapAnalystRecord carries no credibility field', () => {
  const record = mapAnalystRecord(validRow());
  assert.deepEqual(Object.keys(record).sort(), [
    'id',
    'lat',
    'lon',
    'place',
    'shape',
    'source',
    'when',
  ]);
});
