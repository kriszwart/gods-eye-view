// GEIPAN case export (CSV) to normalised records.
//   node src/adapters/geipan.mjs --inspect
//   node src/adapters/geipan.mjs --gazetteer local_data/geonames/cities1000.txt
// GEIPAN's own case summaries are not copied; they are read only to detect
// the reported shape. Link back to GEIPAN for the full text.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { csvObjects } from '../lib/csv.mjs';
import { parseDate, gradeFor, shapeMatcher, makeId, roundLocation, clampText, stripAccents } from '../lib/normalise.mjs';
import { loadGazetteer } from '../lib/gazetteer.mjs';
import { writeJsonl } from '../lib/records.mjs';
import { arg, root, loadJson } from '../lib/cli.mjs';
import { walk } from './common.mjs';

const sources = await loadJson('config/sources.json');
const columns = await loadJson('config/geipan-columns.json');
const matchShape = shapeMatcher(await loadJson('config/shape-map.json'));
const files = await walk(root('local_data/raw/geipan'), ['.csv']);
if (!files.length) {
  console.log('No CSV files in local_data/raw/geipan/. Download the GEIPAN exports there first.');
  process.exit(0);
}
const norm = (s) => stripAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, '_');
const pick = (row, key) => {
  const wanted = columns[key].map(norm);
  for (const [k, v] of Object.entries(row)) if (wanted.includes(norm(k))) return v;
  return '';
};

if (arg('inspect')) {
  for (const f of files) {
    const rows = csvObjects(await readFile(f.path, 'utf8'));
    console.log(`\n${path.basename(f.path)}: ${rows.length} rows\nHeader: ${Object.keys(rows[0] || {}).join(' | ')}\nFirst row: ${JSON.stringify(rows[0]).slice(0, 600)}`);
  }
  process.exit(0);
}

const gazFile = arg('gazetteer', root('local_data/geonames/cities1000.txt'));
const gazetteer = await loadGazetteer(gazFile).catch(() => null);
if (!gazetteer) console.warn(`Gazetteer not found at ${gazFile}; records cannot be placed.`);

const out = [];
const skipped = {};
for (const f of files) {
  for (const row of csvObjects(await readFile(f.path, 'utf8'))) {
    const date = parseDate(pick(row, 'date'));
    const commune = pick(row, 'commune');
    const dpt = pick(row, 'departement').replace(/^0+(?=\d{2})/, '');
    const ref = pick(row, 'id');
    if (!date) {
      skipped.date = (skipped.date || 0) + 1;
      continue;
    }
    const geo = gazetteer?.lookup(commune, { country: 'FR', admin2: dpt || undefined }) || gazetteer?.lookup(commune, { country: 'FR' });
    if (!geo) {
      skipped.location = (skipped.location || 0) + 1;
      continue;
    }
    const loc = roundLocation(geo.lat, geo.lon, { precisionKm: Math.max(3, geo.precision_km), civilian: true });
    out.push({
      id: makeId('geipan', date.iso, commune, ref),
      source: 'geipan', source_ref: ref || null, source_url: null,
      licence: sources.geipan.licence, attribution: sources.geipan.attribution,
      title: clampText(`${commune}${dpt ? ` (${dpt})` : ''}`, 120),
      date: { iso: date.iso, precision: date.precision, days: date.days },
      location: { ...loc, place: commune, country: 'FR', geocoder: 'geonames' },
      shape_raw: null, craft_id: matchShape(pick(row, 'summary')),
      grade: gradeFor('geipan', pick(row, 'classification')),
      explanation: null, summary: null, media: [], tags: [], hero: false, review: !!geo.ambiguous,
      extraction: { method: 'parser', model: null, confidence: geo.ambiguous ? 0.6 : 0.9 },
    });
  }
}
await writeJsonl(root('local_data/normalised/geipan.jsonl'), out);
console.log(`GEIPAN: ${out.length} records written; skipped ${JSON.stringify(skipped)}`);
