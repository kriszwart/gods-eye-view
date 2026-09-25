// Merge normalised records, validate, redact, link duplicates and write the
// files the globe loads:
//   anomalies.v1.json  columnar points for every record
//   cases.v1.json      dossiers for hero cases
//   stats.json         counts for the legend and the release notes
//   node src/build-dataset.mjs --out ../gev-overlay/public/anomalies [--sample]

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadJson, root, arg } from './lib/cli.mjs';
import { readNormalised, validateRecord, linkDuplicates, toAppDataset, toCases, writeJson } from './lib/records.mjs';
import { parseDate, gradeFor, roundLocation } from './lib/normalise.mjs';
import { redactText } from './lib/redact.mjs';

export function fromSample(sample, sources) {
  return sample.cases.map((c) => {
    const date = parseDate(c.date);
    return {
      id: `case-${c.id}`,
      source: 'sample', source_ref: null, source_url: null, source_note: c.source,
      licence: sources.sample.licence, attribution: sources.sample.attribution,
      title: c.title,
      date: { iso: date.iso, precision: date.precision, days: date.days },
      location: { ...roundLocation(c.lat, c.lon, { precisionKm: c.precision_km, civilian: false }), place: c.place, country: c.country, geocoder: 'manual' },
      shape_raw: c.shape_raw, craft_id: c.craft_id,
      grade: gradeFor('sample', c.status),
      explanation: c.explanation ?? null, summary: c.summary ?? null,
      media: [], tags: c.tags || [], hero: true, review: true,
      extraction: { method: 'sample', model: null, confidence: null },
    };
  });
}

export async function build({ sample = false, out = 'out', normalisedDir = root('local_data/normalised') } = {}) {
  const sources = await loadJson('config/sources.json');
  const heroes = fromSample(await loadJson('sample/hero-cases.sample.json'), sources);
  // The hero sample cases are the atlas's curated cases (phase 4 replaces
  // them with verified hero cases one by one; until then they must survive
  // every build). `--sample` alone still gives the fast, offline-friendly
  // 24-case set. Otherwise, merge them with every real source declared in
  // sources.json -- filtering by declared source id keeps out anything else
  // that happens to land in this shared folder (other pipelines' normalised
  // output, sharing the naming convention but not this dataset's schema).
  const knownSourceIds = Object.keys(sources).filter((id) => id !== 'sample');
  const records = sample ? heroes : [...heroes, ...(await readNormalised(normalisedDir, knownSourceIds))];
  const bad = [];
  const seen = new Set();
  for (const r of records) {
    for (const k of ['summary', 'explanation', 'title']) if (r[k]) r[k] = redactText(r[k]).text;
    const errs = validateRecord(r);
    if (seen.has(r.id)) errs.push('duplicate id');
    seen.add(r.id);
    if (errs.length) bad.push({ id: r.id, errs });
  }
  if (bad.length) {
    console.error(`${bad.length} invalid records, first: ${JSON.stringify(bad.slice(0, 3))}`);
    process.exitCode = 1;
  }
  const good = records.filter((r) => !bad.some((b) => b.id === r.id));
  linkDuplicates(good);
  const app = toAppDataset(good, { sources });
  const cases = { schema: 'anomaly.cases.v1', generatedAt: app.generatedAt, cases: toCases(good) };
  const bySource = {};
  const byStatus = {};
  for (const r of good) {
    bySource[r.source] = (bySource[r.source] || 0) + 1;
    byStatus[r.grade.status] = (byStatus[r.grade.status] || 0) + 1;
  }
  const stats = { generatedAt: app.generatedAt, count: good.length, range: app.range, bySource, byStatus, review: good.filter((r) => r.review).length };
  const dir = path.resolve(root(), out);
  await mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, 'anomalies.v1.json'), app);
  await writeJson(path.join(dir, 'cases.v1.json'), cases);
  await writeJson(path.join(dir, 'stats.json'), stats);
  return { app, cases, stats, dir };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { stats, dir } = await build({ sample: !!arg('sample'), out: arg('out', 'out') });
  console.log(`Wrote ${stats.count} records to ${dir}\n${JSON.stringify(stats)}`);
}
