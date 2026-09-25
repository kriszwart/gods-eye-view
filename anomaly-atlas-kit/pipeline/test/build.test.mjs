import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from '../src/build-dataset.mjs';
import { writeJsonl } from '../src/lib/records.mjs';

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

test('a real build merges the sample hero cases with normalised sources, and ignores unrelated jsonl files sharing the folder', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'anomaly-normalised-'));
  try {
    // A well-formed row from a source declared in config/sources.json.
    await writeJsonl(path.join(dir, 'geipan.jsonl'), [
      {
        id: 'geipan-1999-01-01-somewhere-000001',
        source: 'geipan',
        source_ref: '1999-01-000001',
        source_url: 'https://www.geipan.fr/fr/cas/1999-01-000001',
        licence: 'test licence',
        attribution: 'GEIPAN, CNES',
        title: 'SOMEWHERE (99) 01.01.1999',
        date: { iso: '1999-01-01', precision: 'day', days: 10592 },
        location: { lat: 45, lon: 2, precision_km: 11, place: 'Somewhere', country: 'FR', geocoder: 'source' },
        shape_raw: null,
        craft_id: 'orb',
        grade: { scheme: 'geipan', value: 'D', status: 'unresolved', score: 0.95 },
        explanation: null,
        summary: null,
        media: [],
        tags: [],
        hero: false,
        review: false,
        extraction: { method: 'parser', model: null, confidence: 0.95 },
      },
    ]);
    // Another dataset's normalised rows, sharing this folder but never
    // declared as an anomalies source (a different layer's pipeline output,
    // wrong schema entirely) -- must be ignored, not reported as invalid.
    await writeJsonl(path.join(dir, 'tma-sites.jsonl'), [
      { name: 'Somewhere Stone Circle', category: 'Alignement', lat: 1, lon: 1, url: 'https://example.invalid' },
    ]);
    const { stats, cases } = await build({ sample: false, out: 'out/test-merge', normalisedDir: dir });
    assert.equal(stats.count, 25, 'the one geipan row plus the 24 sample heroes');
    assert.equal(stats.bySource.geipan, 1);
    assert.equal(stats.bySource.sample, 24);
    assert.ok(!('tma-sites' in stats.bySource) && !('tma' in stats.bySource));
    assert.ok(
      cases.cases.some((c) => c.id === 'case-los-angeles-1942'),
      'hero cases survive the real (non-sample) build',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
