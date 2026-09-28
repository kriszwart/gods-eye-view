import test from 'node:test';
import assert from 'node:assert/strict';
import { decadeBuckets } from './observatoryModel.js';

test('decadeBuckets: groups years into their decade, sorted ascending', () => {
  const buckets = decadeBuckets([1947, 1952, 1954, 1965, 1989, 2017, 2019]);
  assert.deepEqual(buckets, [
    { decade: 1940, count: 1 },
    { decade: 1950, count: 2 },
    { decade: 1960, count: 1 },
    { decade: 1980, count: 1 },
    { decade: 2010, count: 2 },
  ]);
});

test('decadeBuckets: 1937 buckets into 1930, 2026 buckets into 2020', () => {
  const buckets = decadeBuckets([1937, 2026]);
  assert.deepEqual(buckets, [
    { decade: 1930, count: 1 },
    { decade: 2020, count: 1 },
  ]);
});

test('decadeBuckets: an empty list returns an empty array', () => {
  assert.deepEqual(decadeBuckets([]), []);
});

test('decadeBuckets: non-finite or missing entries are skipped, not thrown on', () => {
  const buckets = decadeBuckets([1940, NaN, undefined, null, Infinity, 1941]);
  assert.deepEqual(buckets, [{ decade: 1940, count: 2 }]);
});

test('decadeBuckets: a non-array input returns an empty array', () => {
  assert.deepEqual(decadeBuckets(undefined), []);
  assert.deepEqual(decadeBuckets(null), []);
});
