// Sweeps Wikidata (CC0) for the atlas's worldwide ancient-sites layer:
// megaliths, dolmens, menhirs, stone circles, tumuli, hillforts and
// geoglyphs -- everything with a P625 coordinate, from any of the classes
// configured in config/ancient-sweep.json.
//   node src/adapters/wikidata-sweep.mjs
//
// Each class is queried against https://query.wikidata.org/sparql as
// `?item wdt:P31/wdt:P279* wd:<QID>` (instance or subclass, transitively),
// requiring a coordinate and optionally carrying a country, an inception
// date, a Commons image and an enwiki sitelink. A class's total item count
// is fetched first (a plain COUNT, independent of the optional fields) so
// paging can be pre-computed and resumed exactly like nara-download.mjs:
// each page is written to its own JSONL file in local_data/raw/wikidata/,
// and a page already on disk is loaded instead of re-fetched.
//
// A single Wikidata item can carry more than one P625 statement (rare, but
// real -- see the report), so the page query picks one coordinate per item
// via a SAMPLE/GROUP BY subquery rather than joining P625 directly: without
// it, an OFFSET/LIMIT page would not line up with a stable item count and
// pagination could skip or repeat items across page boundaries.
//
// An item can also match more than one configured class (a dolmen is a
// subclass of megalith, for instance). Rows are deduped by QID once, after
// every class has been swept, keeping the first occurrence -- so an item's
// type comes from whichever class is listed first in the config.
//
// Licence: Wikidata's own data is CC0 (https://www.wikidata.org/wiki/Wikidata:Licensing).
// Images pulled from Commons still carry their own per-file licence, which
// this adapter does not resolve -- see wikidata-enrich.mjs for that.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonl, readJsonl } from '../lib/records.mjs';
import { root, loadJson } from '../lib/cli.mjs';

export const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';
const CONTACT = process.env.WIKIMEDIA_CONTACT || 'phenomena-atlas (contact via repository)';
export const USER_AGENT = `AnomalyAtlasPipeline/1.0 (contact: ${CONTACT})`;
const ACCEPT = 'application/sparql-results+json';
export const DEFAULT_PAGE_SIZE = 2000;
export const DEFAULT_DELAY_MS = 2000;

/** Parse a Wikidata P625 WKT literal, `Point(lon lat)` -- longitude first. */
export function parsePoint(wkt) {
  const m = /^Point\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/.exec(String(wkt ?? ''));
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** The Q-id from a full Wikidata entity URI, or null. */
export function qidFromUri(uri) {
  const m = /\/(Q\d+)$/.exec(String(uri ?? ''));
  return m ? m[1] : null;
}

/** The Commons filename from a `Special:FilePath` URL (as wdt:P18 resolves to), URL-decoded, or null. */
export function imageFileFromFilePathUrl(url) {
  const m = /\/Special:FilePath\/([^?]+)/.exec(String(url ?? ''));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/**
 * One SPARQL JSON binding -> a compact row, or null when the item or its
 * coordinate is missing (P625 is required; everything else is optional and
 * omitted from the row entirely rather than written as null, since most
 * rows will not carry every field). `type` comes from the matching class's
 * config entry, not from the binding itself.
 *
 * An inception binding is only used when it is a real dateTime literal: a
 * Wikidata "unknown value" snak comes back from WDQS as a uri under
 * `/.well-known/genid/`, never as a literal, so checking `type === 'literal'`
 * is enough to exclude it.
 */
export function mapBinding(binding, type) {
  if (!binding) return null;
  const qid = qidFromUri(binding.item?.value);
  const point = parsePoint(binding.coord?.value);
  if (!qid || !point) return null;

  const row = { qid, name: binding.itemLabel?.value || qid, lat: point.lat, lon: point.lon, type };

  const country = binding.countryLabel?.value;
  if (country) row.country = country;

  const inception = binding.inception;
  if (inception?.type === 'literal' && inception.value) row.inception = inception.value;

  const imageFile = imageFileFromFilePathUrl(binding.image?.value);
  if (imageFile) row.image_file = imageFile;

  const wikipedia = binding.article?.value;
  if (wikipedia) row.wikipedia = wikipedia;

  return row;
}

/** Keep the first occurrence of each QID, dropping later duplicates, order preserved. */
export function dedupeByQid(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r || seen.has(r.qid)) continue;
    seen.add(r.qid);
    out.push(r);
  }
  return out;
}

/** A plain count of distinct items in the class that carry a P625 coordinate. */
export function buildCountQuery(qid) {
  return `SELECT (COUNT(DISTINCT ?item) AS ?c) WHERE {
  ?item wdt:P31/wdt:P279* wd:${qid} .
  ?item wdt:P625 ?coord0 .
}`;
}

/**
 * One page of a class: one coordinate per item (via SAMPLE/GROUP BY, so an
 * item with more than one P625 statement contributes a single row and
 * pagination stays aligned with buildCountQuery's total), ordered by item
 * for stable OFFSET paging, then the optional enrichment fields joined on.
 */
export function buildPageQuery(qid, { limit, offset }) {
  return `SELECT ?item ?itemLabel ?coord ?countryLabel ?inception ?image ?article WHERE {
  {
    SELECT ?item (SAMPLE(?coord0) AS ?coord) WHERE {
      ?item wdt:P31/wdt:P279* wd:${qid} .
      ?item wdt:P625 ?coord0 .
    }
    GROUP BY ?item
    ORDER BY ?item
    LIMIT ${limit} OFFSET ${offset}
  }
  OPTIONAL { ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel)="en") }
  OPTIONAL { ?item wdt:P17 ?country . ?country rdfs:label ?countryLabel . FILTER(LANG(?countryLabel)="en") }
  OPTIONAL { ?item wdt:P571 ?inception . }
  OPTIONAL { ?item wdt:P18 ?image . }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }
}`;
}

async function fetchSparqlJson(endpoint, query, { userAgent, fetchImpl }) {
  const url = `${endpoint}?format=json&query=${encodeURIComponent(query)}`;
  const res = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: ACCEPT } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for SPARQL query against ${endpoint}`);
  return res.json();
}

const pageFile = (dir, classId, i) => path.join(dir, `${classId}-page-${String(i).padStart(5, '0')}.jsonl`);

async function loadPage(file) {
  try {
    return await readJsonl(file);
  } catch {
    return null;
  }
}

/**
 * Sweep one class: count its items, then fetch (or resume from disk) each
 * page of `pageSize`, mapping every binding to a row as it lands. Returns
 * `{ classId, qid, type, count, pages, fetched, rows }`; `fetchImpl`,
 * `sleep` and `log` are injectable for tests.
 */
export async function sweepClass({
  endpoint = WIKIDATA_ENDPOINT,
  classId,
  qid,
  type,
  pageSize = DEFAULT_PAGE_SIZE,
  outDir,
  delayMs = DEFAULT_DELAY_MS,
  userAgent = USER_AGENT,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
}) {
  await mkdir(outDir, { recursive: true });

  const countJson = await fetchSparqlJson(endpoint, buildCountQuery(qid), { userAgent, fetchImpl });
  const count = Number(countJson?.results?.bindings?.[0]?.c?.value ?? 0);
  const pages = Math.ceil(count / pageSize);

  const rows = [];
  let fetched = 0;
  for (let i = 0; i < pages; i++) {
    const file = pageFile(outDir, classId, i);
    let pageRows = await loadPage(file);
    if (pageRows) {
      log(`${classId}: page ${i + 1}/${pages} resumed from disk (${pageRows.length} rows)`);
    } else {
      const json = await fetchSparqlJson(endpoint, buildPageQuery(qid, { limit: pageSize, offset: i * pageSize }), { userAgent, fetchImpl });
      const bindings = json?.results?.bindings ?? [];
      pageRows = bindings.map((b) => mapBinding(b, type)).filter(Boolean);
      await writeJsonl(file, pageRows);
      fetched++;
      log(`${classId}: page ${i + 1}/${pages} fetched (${pageRows.length} rows)`);
      if (i < pages - 1) await sleep(delayMs);
    }
    rows.push(...pageRows);
  }

  return { classId, qid, type, count, pages, fetched, rows };
}

/**
 * Sweep every configured class, in order, then dedupe the combined rows by
 * QID (first class wins) and write the merged JSONL. A class entry may
 * carry its own `endpoint` override (used by the tests); otherwise the
 * top-level `endpoint` (default the live WDQS) applies to all of them.
 * Returns per-class counts plus the total and deduped row counts.
 */
export async function runSweep({
  endpoint = WIKIDATA_ENDPOINT,
  classes,
  pageSize = DEFAULT_PAGE_SIZE,
  delayMs = DEFAULT_DELAY_MS,
  rawDir,
  outFile,
  userAgent = USER_AGENT,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
}) {
  const perClass = [];
  const allRows = [];
  for (const cls of classes) {
    const result = await sweepClass({
      endpoint: cls.endpoint || endpoint,
      classId: cls.id,
      qid: cls.qid,
      type: cls.type,
      pageSize,
      outDir: rawDir,
      delayMs,
      userAgent,
      fetchImpl,
      sleep,
      log,
    });
    perClass.push({ id: cls.id, qid: cls.qid, type: cls.type, count: result.count, pages: result.pages, fetched: result.fetched, rows: result.rows.length });
    allRows.push(...result.rows);
  }

  const deduped = dedupeByQid(allRows);
  await writeJsonl(outFile, deduped);

  return { perClass, totalRaw: allRows.length, totalDeduped: deduped.length, dedupedAway: allRows.length - deduped.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = await loadJson('config/ancient-sweep.json');
  const rawDir = root('local_data/raw/wikidata');
  const outFile = root('local_data/normalised/ancient-sweep.jsonl');

  console.log(`Wikidata sweep: ${config.classes.length} classes -> ${outFile}`);
  const result = await runSweep({
    endpoint: config.endpoint || WIKIDATA_ENDPOINT,
    classes: config.classes,
    pageSize: config.pageSize || DEFAULT_PAGE_SIZE,
    delayMs: config.delayMs || DEFAULT_DELAY_MS,
    rawDir,
    outFile,
    log: (m) => console.log(m),
  });

  for (const c of result.perClass) {
    console.log(`  ${c.id} (${c.qid} -> ${c.type}): ${c.count} items, ${c.pages} pages (${c.fetched} freshly fetched), ${c.rows} rows`);
  }
  console.log(`Total rows before dedupe: ${result.totalRaw}`);
  console.log(`Deduped by QID (first class wins): ${result.totalDeduped} (${result.dedupedAway} duplicates removed across classes)`);
  console.log(`Written to ${outFile}`);
}
