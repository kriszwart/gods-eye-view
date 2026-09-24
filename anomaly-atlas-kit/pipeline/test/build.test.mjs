import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { build } from '../src/build-dataset.mjs';

test('sample dataset builds, validates and round-trips through the globe decoder', async () => {
  const { app, cases, stats } = await build({ sample: true, out: 'out/test' });
  assert.equal(stats.count, 24);
  assert.equal(app.schema, 'anomaly.app.v1');
  assert.deepEqual(app.range, [1942, 2009]);
  for (const col of Object.values(app.columns)) assert.equal(col.length, app.count);
  assert.equal(cases.cases.length, 24);
  assert.ok(!JSON.stringify(cases).includes('\u2014'), 'no em dashes in shipped text');
  const decoder = new URL('../../gev-overlay/src/layers/anomalies/records.js', import.meta.url);
  if (!existsSync(decoder)) return;
  const { normalizeAnomalySnapshot, yearHistogram } = await import(decoder.href);
  const rows = normalizeAnomalySnapshot(JSON.parse(JSON.stringify(app)));
  assert.equal(rows.length, 24);
  assert.equal(rows[0].year, 1942);
  const socorro = rows.find((r) => r.id === 'case-socorro-1964');
  assert.equal(socorro.status, 'unresolved');
  assert.equal(socorro.craft, 'egg');
  assert.equal(socorro.hero, true);
  const hist = yearHistogram(rows, 1940, 2026);
  assert.equal(hist.length, 87);
  assert.equal(hist.reduce((a, b) => a + b, 0), 24);
});
