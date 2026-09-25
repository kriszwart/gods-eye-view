// Project Blue Book via NARA's bulk JSON export (see nara-download.mjs for
// how catalog-export-597821.json is downloaded).
//   index     read catalog-export-597821.json, list each case file and its first page image
//   requests  build Batch API requests that read each record card straight from its URL
//   ingest    map batch results into normalised records
// The export (confirmed against the real download, 25 September 2026) is a
// flat JSON array of fileUnit records: naId, title, levelOfDescription and
// digitalObjects[]. Each digital object carries objectFilename, objectUrl,
// objectFileSize, objectDesignator, objectId, objectDescription and
// objectType. index prints the keys it found on each first run, in case a
// future export changes shape. It also repairs a single missing comma
// between two top-level array elements found in NARA's own file (see
// repairExportText below) before parsing.

import { readFile, writeFile } from 'node:fs/promises';
import { loadJson, root, arg } from '../lib/cli.mjs';
import { readJsonl, writeJsonl } from '../lib/records.mjs';
import { shapeMatcher } from '../lib/normalise.mjs';
import { loadGazetteer } from '../lib/gazetteer.mjs';
import { request, incidentToRecord } from './common.mjs';

const RAW = root('local_data/raw/bluebook/catalog-export-597821.json');
const INDEX = root('local_data/extraction/bluebook.index.jsonl');

/** True when `node` is a fileUnit case file: a naId, a title and at least one digital object. */
export function isFileUnit(node) {
  return !!(node && typeof node === 'object' && node.naId && node.title && Array.isArray(node.digitalObjects) && node.digitalObjects.length);
}

/** The record card for one fileUnit: its first image or PDF page, else whatever its first digital object points to. */
export function firstPageUrl(digitalObjects) {
  const withUrl = digitalObjects.filter((o) => o.objectUrl);
  const page = withUrl.find((o) => /\.(jpe?g|png|gif|pdf)$/i.test(o.objectUrl)) || withUrl[0];
  return page ? page.objectUrl : null;
}

/**
 * NARA's bulk export is one JSON array, but the download taken on 25
 * September 2026 has a single comma missing between two top-level array
 * elements (a `}` immediately followed by a `{` at the array's own two-space
 * indent, nothing in between) -- confirmed present in NARA's own file, not
 * an artefact of downloading it in pages, and most likely a seam left over
 * from how NARA assembles the export from its own paged output. Repairing
 * it here keeps `index` working without hand-editing NARA's file; if the
 * pattern never recurs in a future export this is a no-op.
 */
export function repairExportText(text) {
  const pattern = /\}(\r?\n  \{)/g;
  const repaired = (text.match(pattern) || []).length;
  return { text: repaired ? text.replace(pattern, '},$1') : text, repaired };
}

/**
 * Turn the bulk export (a JSON array of fileUnit records) into index rows,
 * plus the field names seen on the first matching record and its first
 * digital object, for `index`'s own key-check log line.
 */
export function indexExport(json) {
  const rows = [];
  let sampleKeys = null;
  for (const node of Array.isArray(json) ? json : []) {
    if (!isFileUnit(node)) continue;
    sampleKeys ||= { unit: Object.keys(node), object: Object.keys(node.digitalObjects[0]) };
    rows.push({ naId: String(node.naId), title: node.title, url: firstPageUrl(node.digitalObjects), pages: node.digitalObjects.length });
  }
  return { rows, sampleKeys };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sources = await loadJson('config/sources.json');
  const cmd = process.argv[2];

  if (cmd === 'index') {
    const { text, repaired } = repairExportText(await readFile(RAW, 'utf8'));
    if (repaired) console.log(`Repaired ${repaired} missing comma(s) between top-level array elements before parsing.`);
    const { rows, sampleKeys } = indexExport(JSON.parse(text));
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
  } else {
    console.log('Usage: bluebook.mjs index | requests [--limit n] | ingest [--gazetteer file]');
  }
}
