import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAnomalySnapshot,
  yearHistogram,
  bucketByYear,
} from './records.js';
import {
  pointColor,
  inWindow,
  mapAnalystRecord,
  describeYear,
} from './model.js';

const payload = () => ({
  schema: 'anomaly.app.v1',
  count: 2,
  sources: [{ id: 'bluebook' }],
  crafts: ['egg', 'orb'],
  statuses: ['explained', 'insufficient', 'contested', 'unresolved'],
  columns: {
    id: ['a-1964', 'b-1965'],
    t: [-2077, -1484],
    prec: [0, 0],
    lat: [34.06, 40.19],
    lon: [-106.89, -79.46],
    km: [5, 10],
    src: [0, 0],
    craft: [0, 1],
    status: [3, 0],
    u: [90, 15],
    hero: [1, 0],
    title: ['Socorro', ''],
  },
});

test('decodes a valid dataset', () => {
  const rows = normalizeAnomalySnapshot(payload());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].year, 1964);
  assert.equal(rows[0].status, 'unresolved');
  assert.equal(rows[0].hero, true);
  assert.equal(rows[1].craft, 'orb');
  assert.deepEqual(yearHistogram(rows, 1964, 1966), [1, 1, 0]);
  assert.equal(bucketByYear(rows).get(1965).length, 1);
});

test('rejects malformed datasets outright', () => {
  const bad = payload();
  bad.columns.lat[1] = 123;
  assert.equal(normalizeAnomalySnapshot(bad), null);
  const dup = payload();
  dup.columns.id[1] = 'a-1964';
  assert.equal(normalizeAnomalySnapshot(dup), null);
  assert.equal(normalizeAnomalySnapshot({ schema: 'other' }), null);
});

test('encodings and time windows', () => {
  const [a, b] = normalizeAnomalySnapshot(payload());
  assert.ok(pointColor(a)[0] > pointColor(b)[0]);
  assert.equal(inWindow(a, 1964, 'cumulative'), true);
  assert.equal(inWindow(b, 1964, 'cumulative'), false);
  assert.equal(inWindow(b, 1964, 'window', 1), true);
  assert.equal(mapAnalystRecord(a).title, 'Socorro');
  assert.equal(describeYear(1964, 1, 'cumulative'), '1 report up to 1964');
});
