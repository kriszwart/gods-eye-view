// NUFORC import, only under a written licence. Refuses to run without one.
//   NUFORC_LICENCE=path/to/licence.pdf node src/adapters/nuforc-licensed.mjs path/to/export.csv
// Stores dates, places, shapes and durations only; never the witness narratives.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { csvObjects } from '../lib/csv.mjs';
import { parseDate, shapeMatcher, makeId, roundLocation } from '../lib/normalise.mjs';
import { loadGazetteer, parsePlace } from '../lib/gazetteer.mjs';
import { writeJsonl } from '../lib/records.mjs';
import { loadJson, root, arg } from '../lib/cli.mjs';

const licence = process.env.NUFORC_LICENCE;
if (!licence || !existsSync(licence)) {
  console.error('Refusing to run: NUFORC data needs written permission (support@nuforc.org). Set NUFORC_LICENCE to the licence file.');
  process.exit(1);
}
const file = process.argv[2];
const gazetteer = await loadGazetteer(arg('gazetteer', root('local_data/geonames/cities1000.txt')));
const matchShape = shapeMatcher(await loadJson('config/shape-map.json'));
const out = [];
for (const row of csvObjects(await readFile(file, 'utf8'))) {
  const date = parseDate(row.date || row.Date || row.datetime);
  const p = parsePlace([row.city || row.City, row.state || row.State].filter(Boolean).join(', '));
  const geo = date && gazetteer.lookup(p.locality, { country: p.country || undefined, admin1: p.admin1 || undefined });
  if (!geo) continue;
  out.push({
    id: makeId('nuforc', date.iso, geo.place, row.id || row.ID || ''),
    source: 'nuforc', source_ref: row.id || null, source_url: null,
    licence: `NUFORC licence: ${licence}`, attribution: 'National UFO Reporting Center (used under licence)',
    title: null, date: { iso: date.iso, precision: date.precision, days: date.days },
    location: { ...roundLocation(geo.lat, geo.lon, { precisionKm: geo.precision_km }), place: geo.place, country: geo.country, geocoder: 'geonames' },
    shape_raw: row.shape || row.Shape || null, craft_id: matchShape(row.shape || row.Shape),
    grade: { scheme: 'nuforc', value: null, status: 'insufficient', score: 0.35 },
    explanation: null, summary: null, media: [], tags: ['witness-report'], hero: false, review: false,
    extraction: { method: 'parser', model: null, confidence: 0.8 },
  });
}
await writeJsonl(root('local_data/normalised/nuforc.jsonl'), out);
console.log(`NUFORC (licensed): ${out.length} records`);
