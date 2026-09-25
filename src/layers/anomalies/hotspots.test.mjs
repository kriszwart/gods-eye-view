import test from 'node:test';
import assert from 'node:assert/strict';
import { binRows, blurBins, heatAlpha } from './hotspots.js';

test('binRows: a row at lat 0 lon 0 lands the centre cell', () => {
  const width = 720;
  const height = 360;
  const bins = binRows([{ lat: 0, lon: 0 }], { width, height });
  const x = Math.floor(((0 + 180) / 360) * width);
  const y = Math.floor(((90 - 0) / 180) * height);
  const index = y * width + x;
  assert.equal(bins[index], 1);
  const total = bins.reduce((sum, v) => sum + v, 0);
  assert.equal(total, 1);
});

test('binRows: lat 90 clamps to the first row without throwing', () => {
  const width = 720;
  const height = 360;
  assert.doesNotThrow(() => {
    const bins = binRows([{ lat: 90, lon: 0 }], { width, height });
    const x = Math.floor(((0 + 180) / 360) * width);
    assert.equal(bins[0 * width + x], 1);
  });
});

test('binRows: lat -90 clamps to the last row without throwing', () => {
  const width = 720;
  const height = 360;
  assert.doesNotThrow(() => {
    const bins = binRows([{ lat: -90, lon: 0 }], { width, height });
    const x = Math.floor(((0 + 180) / 360) * width);
    assert.equal(bins[(height - 1) * width + x], 1);
  });
});

test('binRows: lon -180 and lon 180 clamp within the grid width', () => {
  const width = 720;
  const height = 360;
  assert.doesNotThrow(() => {
    binRows(
      [
        { lat: 0, lon: -180 },
        { lat: 0, lon: 180 },
      ],
      { width, height },
    );
  });
});

test('binRows: returns a Float32Array sized width x height', () => {
  const width = 10;
  const height = 5;
  const bins = binRows([], { width, height });
  assert.ok(bins instanceof Float32Array);
  assert.equal(bins.length, width * height);
});

test('binRows: defaults to a 720x360 grid', () => {
  const bins = binRows([{ lat: 0, lon: 0 }]);
  assert.equal(bins.length, 720 * 360);
});

test('binRows: filter excludes rows', () => {
  const width = 10;
  const height = 10;
  const rows = [
    { lat: 0, lon: 0, status: 'unresolved' },
    { lat: 0, lon: 0, status: 'explained' },
  ];
  const bins = binRows(rows, {
    width,
    height,
    filter: (row) => row.status === 'unresolved',
  });
  const total = bins.reduce((sum, v) => sum + v, 0);
  assert.equal(total, 1);
});

test('binRows: multiple rows in the same cell accumulate', () => {
  const width = 10;
  const height = 10;
  const rows = [
    { lat: 1, lon: 1 },
    { lat: 1, lon: 1 },
    { lat: 1, lon: 1 },
  ];
  const bins = binRows(rows, { width, height });
  const total = bins.reduce((sum, v) => sum + v, 0);
  assert.equal(total, 3);
});

test('blurBins: radius 0 returns an equal array', () => {
  const width = 5;
  const height = 5;
  const bins = new Float32Array(width * height);
  for (let i = 0; i < bins.length; i++) bins[i] = Math.random();
  const blurred = blurBins(bins, width, height, 0);
  assert.deepEqual(Array.from(blurred), Array.from(bins));
});

test('blurBins: conserves total mass within 1 percent on a random field', () => {
  const width = 40;
  const height = 20;
  const bins = new Float32Array(width * height);
  for (let i = 0; i < bins.length; i++) bins[i] = Math.random() * 10;
  const before = bins.reduce((sum, v) => sum + v, 0);
  const blurred = blurBins(bins, width, height, 2);
  const after = blurred.reduce((sum, v) => sum + v, 0);
  const diff = Math.abs(after - before) / before;
  assert.ok(diff <= 0.01, `expected mass to be conserved, drift was ${diff}`);
});

test('blurBins: returns a Float32Array the same size as the input', () => {
  const width = 8;
  const height = 4;
  const bins = new Float32Array(width * height).fill(1);
  const blurred = blurBins(bins, width, height, 2);
  assert.ok(blurred instanceof Float32Array);
  assert.equal(blurred.length, width * height);
});

test('blurBins: smooths a single spike into its neighbours', () => {
  const width = 9;
  const height = 9;
  const bins = new Float32Array(width * height);
  const centre = 4 * width + 4;
  bins[centre] = 100;
  const blurred = blurBins(bins, width, height, 2);
  assert.ok(blurred[centre] < 100);
  assert.ok(blurred[centre - 1] > 0);
});

test('heatAlpha: 0 value is 0', () => {
  assert.equal(heatAlpha(0, 10), 0);
});

test('heatAlpha: is strictly increasing on 0..max', () => {
  const max = 10;
  let previous = heatAlpha(0, max);
  for (let v = 1; v <= max; v++) {
    const current = heatAlpha(v, max);
    assert.ok(
      current > previous,
      `expected heatAlpha(${v}) > heatAlpha(${v - 1}), got ${current} <= ${previous}`,
    );
    previous = current;
  }
});

test('heatAlpha: max value is 1', () => {
  assert.equal(heatAlpha(10, 10), 1);
});

test('heatAlpha: is clamped to 1 beyond max', () => {
  assert.equal(heatAlpha(50, 10), 1);
});

test('heatAlpha: max <= 0 returns 0', () => {
  assert.equal(heatAlpha(5, 0), 0);
  assert.equal(heatAlpha(5, -10), 0);
});

test('heatAlpha: negative value is clamped to 0', () => {
  assert.equal(heatAlpha(-5, 10), 0);
});
