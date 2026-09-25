// Downloads NARA's Project Blue Book bulk export (NAID 597821) into
// local_data/raw/bluebook/catalog-export-597821.json, which bluebook.mjs
// reads.
//
// The catalog's records-search proxy (catalog.archives.gov/proxy/records/
// search) answers a plain naId_is=597821 lookup without a key, returning the
// series record. But no child-query parameter we tried lists the series'
// fileUnits: naId_is=597821&limit=2 with each of ancestorNaId_is,
// parentNaId_is, ancestors.naId_is, ancestors.naId_is combined with
// levelOfDescription_is=fileUnit, and ancestorNaIds_is (the plural name the
// catalog's own search UI uses as a URL facet, f.ancestorNaIds=<id>) all
// fell through to the site's SPA shell (HTTP 200, text/html) instead of the
// Elasticsearch JSON the base query returns. That is five distinct attempts
// against the one confirmed-working endpoint shape; see task-3-report.md.
//
// NARA instead publishes the complete series as one static file at BULK_URL,
// which is exactly catalog-export-597821.json: a JSON array of every
// fileUnit, each with naId, title and digitalObjects, already in the shape
// bluebook.mjs's units() expects. This module downloads that file in
// byte-range "pages" so a slow or interrupted connection can resume, with a
// browser User-Agent, a delay between requests, and progress logged every 10
// pages, then assembles the pages in order into the target file.

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { root } from '../lib/cli.mjs';

export const BULK_URL = 'https://catalog.archives.gov/medialz/bulk-downloads/uaps/JSON/catalog-export-597821.json';
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
export const DEFAULT_CHUNK_BYTES = 1024 * 1024; // 1 MiB pages: ~86 pages for the ~90 MB export
export const DEFAULT_DELAY_MS = 2000;

/** Split a byte length into inclusive [start, end] ranges of at most `size` bytes each. */
export function chunkRanges(totalBytes, size) {
  const ranges = [];
  for (let start = 0; start < totalBytes; start += size) ranges.push([start, Math.min(start + size, totalBytes) - 1]);
  return ranges;
}

const pageFile = (pagesDir, i) => path.join(pagesDir, `page-${String(i).padStart(5, '0')}.part`);

async function pageIsComplete(file, expectedBytes) {
  const st = await stat(file).catch(() => null);
  return !!st && st.size === expectedBytes;
}

/**
 * Download `url` in byte-range pages into `pagesDir`, skipping any page
 * already saved at its expected size, then assemble the pages in order into
 * `outFile`. `fetchImpl`, `sleep` and `log` are injectable for tests.
 * Returns `{ pages, bytes, fetched }`.
 */
export async function downloadPaged({
  url,
  pagesDir,
  outFile,
  chunkBytes = DEFAULT_CHUNK_BYTES,
  delayMs = DEFAULT_DELAY_MS,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
}) {
  await mkdir(pagesDir, { recursive: true });

  const head = await fetchImpl(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } });
  if (!head.ok) throw new Error(`HEAD ${url} failed: HTTP ${head.status}`);
  const totalBytes = Number(head.headers.get('content-length'));
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) throw new Error('could not determine the export size from content-length');

  const ranges = chunkRanges(totalBytes, chunkBytes);
  let fetched = 0;

  for (let i = 0; i < ranges.length; i++) {
    const [start, end] = ranges[i];
    const file = pageFile(pagesDir, i);
    const expected = end - start + 1;
    if (await pageIsComplete(file, expected)) continue;

    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Range: `bytes=${start}-${end}` } });
    if (!res.ok && res.status !== 206) throw new Error(`page ${i} (bytes ${start}-${end}) failed: HTTP ${res.status}`);
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    fetched++;
    if ((i + 1) % 10 === 0 || i === ranges.length - 1) log(`page ${i + 1}/${ranges.length} saved`);
    if (i < ranges.length - 1) await sleep(delayMs);
  }

  const parts = [];
  for (let i = 0; i < ranges.length; i++) parts.push(await readFile(pageFile(pagesDir, i)));
  await writeFile(outFile, Buffer.concat(parts));

  return { pages: ranges.length, bytes: totalBytes, fetched };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pagesDir = root('local_data/raw/bluebook/pages');
  const outFile = root('local_data/raw/bluebook/catalog-export-597821.json');
  console.log(`Downloading ${BULK_URL}`);
  const result = await downloadPaged({
    url: BULK_URL,
    pagesDir,
    outFile,
    log: (m) => console.log(m),
  });
  console.log(`Done: ${result.pages} pages, ${result.bytes} bytes, ${result.fetched} freshly fetched, ${result.pages - result.fetched} resumed from disk.`);
  console.log(`Written to ${outFile}`);
}
