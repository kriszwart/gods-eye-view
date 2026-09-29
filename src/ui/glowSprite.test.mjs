import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sizeBucket,
  dprBucket,
  glowCacheKey,
  GLOW_SIZE_BUCKETS_PX,
  MAX_COMPOSE_DPR,
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

test('dprBucket passes a plain devicePixelRatio of 1 through unchanged', () => {
  assert.equal(dprBucket(1), 1);
});

test('dprBucket caps anything above MAX_COMPOSE_DPR at MAX_COMPOSE_DPR', () => {
  assert.equal(dprBucket(2), MAX_COMPOSE_DPR);
  assert.equal(dprBucket(3), MAX_COMPOSE_DPR);
  assert.equal(dprBucket(2.5), MAX_COMPOSE_DPR);
});

test('dprBucket passes an in-range fractional devicePixelRatio through unchanged', () => {
  assert.equal(dprBucket(1.5), 1.5);
});

test('dprBucket falls back to 1 for a falsy input (NaN, undefined or 0), mirroring window.devicePixelRatio || 1', () => {
  assert.equal(dprBucket(NaN), 1);
  assert.equal(dprBucket(undefined), 1);
  assert.equal(dprBucket(0), 1);
});

test('glowCacheKey composes a stable key from hue, size and the DPR bucket', () => {
  assert.equal(glowCacheKey('#ff2e9a', 24, 1), 'glow:#ff2e9a:24@1');
  assert.equal(glowCacheKey('#3fe0ff', 9, 2), 'glow:#3fe0ff:9@2');
});

test('glowCacheKey normalises hue case, so it never opens two entries for the same colour', () => {
  assert.equal(glowCacheKey('#FF2E9A', 24, 1), glowCacheKey('#ff2e9a', 24, 1));
});

test('glowCacheKey distinguishes different hues at the same size and DPR', () => {
  assert.notEqual(
    glowCacheKey('#ff2e9a', 24, 1),
    glowCacheKey('#3fe0ff', 24, 1),
  );
});

test('glowCacheKey distinguishes the same hue at different sizes, same DPR', () => {
  assert.notEqual(
    glowCacheKey('#ff2e9a', 24, 1),
    glowCacheKey('#ff2e9a', 18, 1),
  );
});

test('glowCacheKey distinguishes the same hue and size at different DPR buckets (a DPR-1 and a DPR-2 sprite are distinct content, task: presence pass)', () => {
  assert.notEqual(
    glowCacheKey('#ff2e9a', 24, 1),
    glowCacheKey('#ff2e9a', 24, 2),
  );
});
