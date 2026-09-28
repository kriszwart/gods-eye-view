import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sizeBucket,
  glowCacheKey,
  GLOW_SIZE_BUCKETS_PX,
} from './glowSprite.js';

test('sizeBucket snaps up to the nearest bucket at or above the requested size', () => {
  assert.equal(sizeBucket(3.5), 4);
  assert.equal(sizeBucket(4), 4);
  assert.equal(sizeBucket(4.01), 6);
  assert.equal(sizeBucket(7), 9);
  assert.equal(sizeBucket(13), 13);
  assert.equal(sizeBucket(13.01), 18);
});

test('sizeBucket clamps anything past the largest bucket to that bucket', () => {
  const largest = GLOW_SIZE_BUCKETS_PX[GLOW_SIZE_BUCKETS_PX.length - 1];
  assert.equal(sizeBucket(largest), largest);
  assert.equal(sizeBucket(largest + 50), largest);
  assert.equal(sizeBucket(1000), largest);
});

test('sizeBucket falls back to the smallest bucket for a non-finite input', () => {
  assert.equal(sizeBucket(NaN), GLOW_SIZE_BUCKETS_PX[0]);
  assert.equal(sizeBucket(undefined), GLOW_SIZE_BUCKETS_PX[0]);
  assert.equal(sizeBucket(Infinity), GLOW_SIZE_BUCKETS_PX[0]);
});

test('glowCacheKey composes a stable key from hue and size', () => {
  assert.equal(glowCacheKey('#ff2e9a', 24), 'glow:#ff2e9a:24');
  assert.equal(glowCacheKey('#3fe0ff', 9), 'glow:#3fe0ff:9');
});

test('glowCacheKey normalises hue case, so it never opens two entries for the same colour', () => {
  assert.equal(glowCacheKey('#FF2E9A', 24), glowCacheKey('#ff2e9a', 24));
});

test('glowCacheKey distinguishes different hues at the same size', () => {
  assert.notEqual(glowCacheKey('#ff2e9a', 24), glowCacheKey('#3fe0ff', 24));
});

test('glowCacheKey distinguishes the same hue at different sizes', () => {
  assert.notEqual(glowCacheKey('#ff2e9a', 24), glowCacheKey('#ff2e9a', 18));
});
