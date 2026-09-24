// PDF-based sources (PURSUE, UK MoD). Files are downloaded by hand into
// local_data/raw/<source>/. Large PDFs must be split into page ranges first
// (check the current PDF size and page limits in the Claude API docs).

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadJson, root, arg } from '../lib/cli.mjs';
import { readJsonl, writeJsonl } from '../lib/records.mjs';
import { shapeMatcher } from '../lib/normalise.mjs';
import { loadGazetteer } from '../lib/gazetteer.mjs';
import { request, walk, pdfBlock, customIdFor, incidentToRecord } from './common.mjs';

const MAX_PDF_BYTES = 30 * 1024 * 1024;

export async function runDocuments(source, prefix) {
  const sources = await loadJson('config/sources.json');
  const cmd = process.argv[2];
  const rawDir = root(`local_data/raw/${source}`);
  const indexFile = root(`local_data/extraction/${source}.index.jsonl`);
  if (cmd === 'requests') {
    const pdfs = await walk(rawDir, ['.pdf']);
    const media = await walk(rawDir, ['.mp4', '.mov', '.m4v', '.webm', '.jpg', '.jpeg', '.png']);
    const index = [];
    const lines = [];
    for (const f of pdfs) {
      const rel = path.relative(rawDir, f.path);
      if (f.bytes > MAX_PDF_BYTES) {
        index.push({ rel, skipped: 'too large, split into page ranges' });
        continue;
      }
      const id = customIdFor(prefix, rel);
      index.push({ custom_id: id, rel, bytes: f.bytes });
      lines.push(JSON.stringify(request(id, source, [await pdfBlock(f.path)], 4000)));
    }
    for (const m of media) index.push({ rel: path.relative(rawDir, m.path), media: true, note: 'Attach to a case by hand; video content is not auto-extracted' });
    await writeJsonl(indexFile, index);
    await writeFile(root(`local_data/extraction/${source}.requests.jsonl`), lines.join('\n') + (lines.length ? '\n' : ''));
    console.log(`${source}: ${lines.length} requests, ${media.length} media files listed for manual linking, ${index.filter((i) => i.skipped).length} too large`);
  } else if (cmd === 'ingest') {
    const gazetteer = await loadGazetteer(arg('gazetteer', root('local_data/geonames/cities1000.txt')));
    const matchShape = shapeMatcher(await loadJson('config/shape-map.json'));
    const index = new Map((await readJsonl(indexFile)).filter((i) => i.custom_id).map((i) => [i.custom_id, i]));
    const out = [];
    const review = [];
    for (const row of await readJsonl(root(`local_data/extraction/${source}.results.jsonl`))) {
      const incidents = row.data?.incidents || [];
      if (!row.ok || !incidents.length) {
        review.push({ custom_id: row.custom_id, reason: row.error || 'no incidents' });
        continue;
      }
      const file = index.get(row.custom_id);
      const ref = row.data.file_id || row.data.file_ref || file?.rel || null;
      incidents.forEach((inc, i) => {
        const res = incidentToRecord(inc, {
          source, ref, url: null, attribution: sources[source].attribution, licence: sources[source].licence,
          gazetteer, matchShape, model: row.model, index: incidents.length > 1 ? i + 1 : 0,
        });
        if (res.record) out.push(res.record);
        else review.push({ custom_id: row.custom_id, incident: i, reason: res.skipped, place: res.place });
      });
    }
    await writeJsonl(root(`local_data/normalised/${source}.jsonl`), out);
    await writeJsonl(root(`local_data/extraction/${source}.review.jsonl`), review);
    console.log(`${source}: ${out.length} records, ${review.length} for review`);
  } else console.log(`Usage: ${source}.mjs requests | ingest [--gazetteer file]`);
}
