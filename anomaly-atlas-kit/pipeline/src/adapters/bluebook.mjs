// Project Blue Book via NARA's bulk JSON metadata.
//   index     read catalog-export-597821.json, list each case file and its first page image
//   requests  build Batch API requests that read each record card straight from its URL
//   ingest    map batch results into normalised records
// The NARA export structure should be confirmed on first run: "index" prints the
// keys it found so the field names below can be tightened.

import { readFile, writeFile } from 'node:fs/promises';
import { loadJson, root, arg } from '../lib/cli.mjs';
import { readJsonl, writeJsonl } from '../lib/records.mjs';
import { shapeMatcher } from '../lib/normalise.mjs';
import { loadGazetteer } from '../lib/gazetteer.mjs';
import { request, incidentToRecord } from './common.mjs';

const sources = await loadJson('config/sources.json');
const cmd = process.argv[2];
const RAW = root('local_data/raw/bluebook/catalog-export-597821.json');
const INDEX = root('local_data/extraction/bluebook.index.jsonl');

function* units(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return;
  if (Array.isArray(node)) {
    for (const n of node) yield* units(n, depth + 1);
    return;
  }
  const objects = node.digitalObjects || node.objects || node.digitalObjectArray;
  const id = node.naId ?? node.naid ?? node.id;
  if (id && node.title && Array.isArray(objects) && objects.length) yield { node, objects };
  for (const v of Object.values(node)) if (v && typeof v === 'object') yield* units(v, depth + 1);
}
const urlOf = (o) => o.objectUrl || o.url || o.downloadUrl || o.file?.url || null;

if (cmd === 'index') {
  const json = JSON.parse(await readFile(RAW, 'utf8'));
  const rows = [];
  let sampleKeys = null;
  for (const { node, objects } of units(json)) {
    sampleKeys ||= { unit: Object.keys(node), object: Object.keys(objects[0]) };
    const first = objects.find((o) => /\.(jpe?g|png|gif|pdf)$/i.test(urlOf(o) || '')) || objects[0];
    rows.push({ naId: String(node.naId ?? node.naid ?? node.id), title: node.title, url: urlOf(first), pages: objects.length });
  }
  await writeJsonl(INDEX, rows);
  console.log(`Indexed ${rows.length} file units. Keys seen: ${JSON.stringify(sampleKeys)}`);
} else if (cmd === 'requests') {
  const limit = Number(arg('limit', 0)) || Infinity;
  const rows = (await readJsonl(INDEX)).filter((r) => r.url).slice(0, limit);
  const reqs = rows.map((r) => {
    const block = /\.pdf$/i.test(r.url) ? { type: 'document', source: { type: 'url', url: r.url } } : { type: 'image', source: { type: 'url', url: r.url } };
    return request(`bb-${r.naId}`, 'bluebook', [block], 900);
  });
  await writeFile(root('local_data/extraction/bluebook.requests.jsonl'), reqs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`${reqs.length} requests written. Try --limit 50 first and check the results before the full run.`);
} else if (cmd === 'ingest') {
  const gazetteer = await loadGazetteer(arg('gazetteer', root('local_data/geonames/cities1000.txt')));
  const matchShape = shapeMatcher(await loadJson('config/shape-map.json'));
  const index = new Map((await readJsonl(INDEX)).map((r) => [`bb-${r.naId}`, r]));
  const out = [];
  const review = [];
  for (const row of await readJsonl(root('local_data/extraction/bluebook.results.jsonl'))) {
    if (!row.ok || !row.data?.incident) {
      review.push({ custom_id: row.custom_id, reason: row.error || 'no incident' });
      continue;
    }
    const unit = index.get(row.custom_id);
    const res = incidentToRecord(row.data.incident, {
      source: 'bluebook', ref: unit?.naId, url: unit ? `https://catalog.archives.gov/id/${unit.naId}` : null,
      attribution: sources.bluebook.attribution, licence: sources.bluebook.licence, gazetteer, matchShape, model: row.model,
    });
    if (res.record) out.push(res.record);
    else review.push({ custom_id: row.custom_id, reason: res.skipped, place: res.place });
  }
  await writeJsonl(root('local_data/normalised/bluebook.jsonl'), out);
  await writeJsonl(root('local_data/extraction/bluebook.review.jsonl'), review);
  console.log(`Blue Book: ${out.length} records, ${review.length} for review`);
} else console.log('Usage: bluebook.mjs index | requests [--limit n] | ingest [--gazetteer file]');
