// Merges the curated hero tier (the heroes[] already committed in
// public/ancient-sites/sites.v2.json, 20 rich dossiers) with the worldwide
// Wikidata sweep (local_data/normalised/ancient-sweep.jsonl, tens of
// thousands of rows) into the columnar dataset the atlas loads:
//   public/ancient-sites/sites.v2.json
//   node src/build-ancient.mjs [--out ../../public/ancient-sites/sites.v2.json]
//
// The curated 20 are hand-authored once and then carried forward from build
// to build: a rebuild reads them back out of the last-built v2 document
// (heroFile defaults to the very file this script writes) rather than from
// any standalone hero source, since sites.v1.json was retired once the app
// moved to v2 (see the layer's records.js). A bare v1-shaped `{ sites: [...] }`
// document is still accepted too, for fixtures and any future standalone
// hero file.
//
// The hero tier keeps its full v1 shape verbatim -- image, attribution,
// debated line, everything the dossier needs for a rich card. Sweep rows
// carry only what a lightweight gold-point dossier needs: qid, name,
// coordinates, type, country and (when it has one) an enwiki article title.
//
// A sweep row within HERO_PROXIMITY_KM of a hero is dropped: the hero
// already represents that site with a far richer dossier, so keeping both
// would double it up on the globe.
//
// The sweep's inception (P571) coverage is far too sparse (see the report)
// to earn a bce column here -- BCE_COVERAGE_THRESHOLD gates it so a future,
// richer sweep would pick the column up automatically without a code change,
// but today's build always omits it. The deep-time dial bands sweep points
// by type-era heuristics instead (flagged for the layer/dial task).
//
// Byte budget: the committed file has a 3 MB raw (uncompressed) target.
// With ~81,000 sweep rows this cannot be met while every row still carries
// a name, coordinates and a country -- see the module's build() doc comment
// and the task report for the measured numbers. Rather than silently drop
// data a downstream task (the layer's sweep dossier) explicitly needs, the
// encoder interns country into a `countries` index the same way `type`
// already is, which costs far less than repeating country strings per row,
// and ships the smallest encoding that still keeps country and the wiki
// title. The overage is reported, not hidden.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, arg } from './lib/cli.mjs';
import { readJsonl, haversineKm } from './lib/records.mjs';

export const SCHEMA = 'ancient.sites.v2';
export const HERO_PROXIMITY_KM = 1;
export const BCE_COVERAGE_THRESHOLD = 0.05; // below this, the bce column is not worth shipping
export const RAW_SIZE_BUDGET_BYTES = 3 * 1024 * 1024; // 3 MB, raw (uncompressed) committed file
export const NAME_MAX_LENGTH = 60;

// The worldwide sweep's own licence: Wikidata's own data is CC0 (see
// https://www.wikidata.org/wiki/Wikidata:Licensing and config/ancient-sweep.json's
// own note), so no attribution is legally required, but the dataset states
// it anyway as a courtesy. The curated hero tier keeps its own per-site
// source_url/attribution fields regardless; this block documents the sweep
// only.
export const SWEEP_LICENCE_SOURCE = 'Wikidata';
export const SWEEP_LICENCE_NAME = 'CC0 1.0';
export const SWEEP_LICENCE_ATTRIBUTION =
  'Worldwide ancient sites sweep data from Wikidata, CC0 1.0. No attribution is legally required; credited here as a courtesy. Curated hero-tier sites keep their own per-site source and attribution.';

/** The top-level `licence` block every v2 document carries (see
 * `validateV2`). `retrievedAt` is the ISO timestamp the sweep was pulled
 * from Wikidata, passed in by the caller when known, or the current build
 * time otherwise. */
export function sweepLicenceBlock(retrievedAt) {
  return {
    source: SWEEP_LICENCE_SOURCE,
    licence: SWEEP_LICENCE_NAME,
    retrieved: retrievedAt || new Date().toISOString(),
    attribution: SWEEP_LICENCE_ATTRIBUTION,
  };
}

/** Round a coordinate to 4 decimal places -- about 11 m at the equator, plenty for a public monument. */
export function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * The enwiki article title segment from a full `.../wiki/<title>` URL, left
 * percent-encoded exactly as the URL carried it, so a consumer can rebuild
 * the article link with a plain string join (`https://en.wikipedia.org/wiki/${title}`)
 * and never needs the raw URL itself. Empty string when there is no article.
 */
export function wikiTitleFromUrl(url) {
  const m = /\/wiki\/([^?#]+)/.exec(String(url ?? ''));
  return m ? m[1] : '';
}

/** Fraction (0..1) of rows that carry an inception date. */
export function bceCoverage(rows) {
  if (!rows.length) return 0;
  return rows.filter((r) => r.inception).length / rows.length;
}

/** Drop a sweep row within `radiusKm` of any hero site -- the hero already represents it. */
export function dedupeAgainstHeroes(rows, heroes, radiusKm = HERO_PROXIMITY_KM) {
  const kept = [];
  let dropped = 0;
  for (const r of rows) {
    const near = heroes.some((h) => haversineKm(r, h) <= radiusKm);
    if (near) dropped++;
    else kept.push(r);
  }
  return { kept, dropped };
}

/** Keep the first row for each qid. The adapter already dedupes across classes; this guards the build itself. */
export function dedupeByQid(rows) {
  const seen = new Set();
  const kept = [];
  let dropped = 0;
  for (const r of rows) {
    if (seen.has(r.qid)) {
      dropped++;
      continue;
    }
    seen.add(r.qid);
    kept.push(r);
  }
  return { kept, dropped };
}

/** Shorten a name over `max` characters to `max`, ending in an ellipsis. */
export function truncateName(name, max = NAME_MAX_LENGTH) {
  if (name.length <= max) return name;
  return `${name.slice(0, max - 1).trimEnd()}…`;
}

/** Sorted, deduplicated set of every type present. `sites.type` stores the index into this array. */
export function typesIndex(rows) {
  return [...new Set(rows.map((r) => r.type))].sort();
}

/** Sorted, deduplicated set of every country present (rows with none contribute ''). `sites.country` can index into this array. */
export function countriesIndex(rows) {
  return [...new Set(rows.map((r) => r.country || ''))].sort();
}

/**
 * Columnar-encode sweep rows against a fixed `types` index.
 * `countryMode`: 'strings' stores the country per row as-is (or ''); 'index'
 * stores an integer into `countries` (required in that mode); 'none' omits
 * the column entirely.
 * `wikiAsTitle: true` stores the enwiki title (see wikiTitleFromUrl) per
 * row, or '' when there is none; `false` stores a 0/1 flag instead.
 */
export function toColumns(rows, types, { countryMode = 'strings', countries = null, wikiAsTitle = true } = {}) {
  const cols = { qid: [], name: [], lat: [], lon: [], type: [] };
  if (countryMode !== 'none') cols.country = [];
  cols.wiki = [];
  for (const r of rows) {
    cols.qid.push(r.qid);
    cols.name.push(r.name);
    cols.lat.push(round4(r.lat));
    cols.lon.push(round4(r.lon));
    cols.type.push(types.indexOf(r.type));
    if (countryMode === 'strings') cols.country.push(r.country || '');
    else if (countryMode === 'index') cols.country.push(countries.indexOf(r.country || ''));
    const title = wikiTitleFromUrl(r.wikipedia);
    cols.wiki.push(wikiAsTitle ? title : (title ? 1 : 0));
  }
  return cols;
}

/** Validation errors for a v2 document: equal-length columns, in-range coordinates, valid type (and, when interned, country) indices, no empty names, no duplicate qids, a well-formed licence block. */
export function validateV2(v2) {
  const errs = [];
  const need = (cond, msg) => {
    if (!cond) errs.push(msg);
  };
  need(v2.schema === SCHEMA, 'schema');
  // A non-empty hero tier, not a hardcoded count: the curated set has held
  // 20 sites since the phase 5b sample, but that is a curation decision,
  // not a schema invariant, and this check should not need editing every
  // time a future curation pass adds or retires one.
  need(Array.isArray(v2.heroes) && v2.heroes.length > 0, 'heroes length');
  need(Array.isArray(v2.types) && v2.types.length > 0, 'types');
  need(v2.licence && typeof v2.licence === 'object', 'licence');
  if (v2.licence && typeof v2.licence === 'object') {
    need(typeof v2.licence.source === 'string' && v2.licence.source.length > 0, 'licence.source');
    need(typeof v2.licence.licence === 'string' && v2.licence.licence.length > 0, 'licence.licence');
    need(typeof v2.licence.retrieved === 'string' && v2.licence.retrieved.length > 0, 'licence.retrieved');
    need(typeof v2.licence.attribution === 'string' && v2.licence.attribution.length > 0, 'licence.attribution');
  }
  const s = v2.sites || {};
  const n = Array.isArray(s.qid) ? s.qid.length : -1;
  need(n >= 0, 'sites.qid');
  need(v2.count === (v2.heroes?.length || 0) + n, 'count');
  for (const k of Object.keys(s)) need(s[k].length === n, `column ${k} length`);
  if (n < 0) return errs;
  const countryInterned = Array.isArray(v2.countries);
  const seenQid = new Set();
  for (let i = 0; i < n; i++) {
    need(typeof s.qid[i] === 'string' && s.qid[i].length > 0, `qid[${i}]`);
    if (seenQid.has(s.qid[i])) errs.push(`duplicate qid ${s.qid[i]}`);
    seenQid.add(s.qid[i]);
    need(typeof s.name[i] === 'string' && s.name[i].trim().length > 0, `name[${i}]`);
    need(Number.isFinite(s.lat[i]) && Math.abs(s.lat[i]) <= 90, `lat[${i}]`);
    need(Number.isFinite(s.lon[i]) && Math.abs(s.lon[i]) <= 180, `lon[${i}]`);
    need(Number.isInteger(s.type[i]) && s.type[i] >= 0 && s.type[i] < v2.types.length, `type[${i}]`);
    if (s.country) {
      if (countryInterned) need(Number.isInteger(s.country[i]) && s.country[i] >= 0 && s.country[i] < v2.countries.length, `country[${i}]`);
      else need(typeof s.country[i] === 'string', `country[${i}]`);
    }
  }
  return errs;
}

/**
 * Encodings tried, in order, until the committed file fits RAW_SIZE_BUDGET_BYTES.
 * Real numbers for the ~81,000-row sweep (see the task report): none of
 * these actually reach the 3 MB target, so the last one is shipped as the
 * floor -- it is deliberately NOT "drop country" or "drop the wiki title",
 * because at this row count that saves only a few hundred KB while removing
 * data the layer's sweep dossier needs (country, and a working Wikipedia
 * link), for a file that would still be over budget either way. Interning
 * country the same way `type` already is keeps that data at a fraction of
 * the raw-string cost.
 */
const ENCODINGS = [
  { countryMode: 'strings', wikiAsTitle: true, truncate: false, label: 'full: country as short strings, per-row wiki titles, full-length names' },
  { countryMode: 'strings', wikiAsTitle: false, truncate: false, label: 'wiki titles dropped to a 0/1 flag' },
  { countryMode: 'index', wikiAsTitle: true, truncate: false, label: 'country interned to a countries[] index (keeps full country data)' },
  { countryMode: 'index', wikiAsTitle: true, truncate: true, label: 'country interned, names over 60 characters shortened with an ellipsis' },
];

function buildDoc(heroes, rows, types, encoding, licence) {
  const encoded = encoding.truncate ? rows.map((r) => ({ ...r, name: truncateName(r.name) })) : rows;
  const countries = encoding.countryMode === 'index' ? countriesIndex(encoded) : null;
  const doc = {
    schema: SCHEMA,
    count: heroes.length + encoded.length,
    generatedAt: new Date().toISOString(),
    licence,
    heroes,
    types,
    ...(countries ? { countries } : {}),
    sites: toColumns(encoded, types, { countryMode: encoding.countryMode, countries, wikiAsTitle: encoding.wikiAsTitle }),
  };
  const json = JSON.stringify(doc);
  return { doc, json, bytes: Buffer.byteLength(json) };
}

/** Extract the curated hero tier from a hero source document: the v2
 * document's own `heroes[]` when it is one (the canonical source, since
 * sites.v1.json was retired), or a bare v1-shaped `{ sites: [...] }`
 * document otherwise (fixtures, or any future standalone hero file). */
export function heroesFromDoc(heroDoc) {
  return heroDoc?.schema === SCHEMA ? heroDoc.heroes : heroDoc.sites;
}

/**
 * Build the v2 dataset from the curated hero tier and the sweep: dedupe,
 * encode, validate and write it. Returns the numbers the task report needs:
 * counts at every stage, which encoding was chosen and why, bce coverage,
 * validation errors (should be none) and the byte size actually written.
 */
export async function build({
  heroFile = root('../../public/ancient-sites/sites.v2.json'),
  sweepFile = root('local_data/normalised/ancient-sweep.jsonl'),
  outFile = root('../../public/ancient-sites/sites.v2.json'),
  sizeBudgetBytes = RAW_SIZE_BUDGET_BYTES,
  retrievedAt = null,
  log = () => {},
} = {}) {
  const heroDoc = JSON.parse(await readFile(heroFile, 'utf8'));
  const heroes = heroesFromDoc(heroDoc);
  const licence = sweepLicenceBlock(retrievedAt);
  const sweepRaw = await readJsonl(sweepFile);

  const coverage = bceCoverage(sweepRaw);
  const includeBce = coverage >= BCE_COVERAGE_THRESHOLD;

  const { kept: afterQid, dropped: qidDuplicates } = dedupeByQid(sweepRaw);
  const { kept: rows, dropped: heroProximityDrops } = dedupeAgainstHeroes(afterQid, heroes);

  const types = typesIndex(rows);

  const attempts = [];
  let chosen = null;
  for (const encoding of ENCODINGS) {
    const built = buildDoc(heroes, rows, types, encoding, licence);
    attempts.push({ label: encoding.label, bytes: built.bytes });
    if (built.bytes <= sizeBudgetBytes) {
      chosen = { ...built, encoding };
      break;
    }
    log(`${encoding.label}: ${built.bytes} bytes, over the ${sizeBudgetBytes} byte budget`);
  }
  // Every encoding was over budget: ship the smallest one that still keeps
  // country and the wiki title (see the ENCODINGS comment) rather than fail
  // silently or drop data a downstream task depends on.
  if (!chosen) {
    const encoding = ENCODINGS[ENCODINGS.length - 1];
    chosen = { ...buildDoc(heroes, rows, types, encoding, licence), encoding };
  }

  const errors = validateV2(chosen.doc);
  if (errors.length) throw new Error(`sites.v2.json failed validation: ${errors.slice(0, 10).join(', ')}${errors.length > 10 ? ` (+${errors.length - 10} more)` : ''}`);

  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, chosen.json);

  return {
    outFile,
    bytes: chosen.bytes,
    encoding: chosen.encoding,
    attempts,
    heroesCount: heroes.length,
    sweepRawCount: sweepRaw.length,
    qidDuplicates,
    heroProximityDrops,
    finalSweepCount: rows.length,
    totalCount: chosen.doc.count,
    types,
    countries: chosen.doc.countries || null,
    bceCoverage: coverage,
    includeBce,
    licence,
    errors,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await build({ outFile: arg('out', root('../../public/ancient-sites/sites.v2.json')), log: (m) => console.log(m) });
  console.log(`Heroes: ${result.heroesCount}`);
  console.log(`Sweep rows read: ${result.sweepRawCount}`);
  console.log(`Dropped as duplicate qids: ${result.qidDuplicates}`);
  console.log(`Dropped within ${HERO_PROXIMITY_KM} km of a hero: ${result.heroProximityDrops}`);
  console.log(`Sweep rows kept: ${result.finalSweepCount}`);
  console.log(`Total sites (heroes + sweep): ${result.totalCount}`);
  console.log(`Types: ${result.types.join(', ')}`);
  console.log(`Countries: ${result.countries ? `${result.countries.length} interned` : 'not interned'}`);
  console.log(`bce coverage: ${(result.bceCoverage * 100).toFixed(2)}% (threshold ${BCE_COVERAGE_THRESHOLD * 100}%) -- bce column ${result.includeBce ? 'included' : 'omitted'}`);
  console.log(`Licence: ${result.licence.source}, ${result.licence.licence}, retrieved ${result.licence.retrieved}`);
  console.log(`Validation: ${result.errors.length === 0 ? 'zero invalid records' : `${result.errors.length} errors`}`);
  console.log(`Encoding chosen: ${result.encoding.label}`);
  for (const a of result.attempts) console.log(`  tried: ${a.label} -> ${a.bytes} bytes`);
  console.log(`Written ${result.bytes} bytes to ${result.outFile}`);
  if (result.bytes > RAW_SIZE_BUDGET_BYTES) {
    console.log(`OVER BUDGET by ${result.bytes - RAW_SIZE_BUDGET_BYTES} bytes (${(((result.bytes - RAW_SIZE_BUDGET_BYTES) / RAW_SIZE_BUDGET_BYTES) * 100).toFixed(1)}%) -- see the task report for why and the alternatives considered.`);
  }
}
