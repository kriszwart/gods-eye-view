/**
 * Search across both phenomena registers (sky reports and ancient sites).
 * Portable and pure: no Cesium, no browser globals, so it stays unit
 * testable and reusable from any shell.
 */

/** @type {number} */
const RESULT_CAP = 8;

/** Rank tiers, lower is better. Ties keep the input record order. */
const RANK_TITLE_STARTS_WITH = 0;
const RANK_TITLE_CONTAINS = 1;
const RANK_FIELD_MATCH = 2;

const YEAR_QUERY = /^\d{4}$/;

/**
 * Rank a single record against a lower-cased, already-trimmed query.
 * @param {{title?: string, year?: number, craft?: string, type?: string, country?: string}} record
 * @param {string} query
 * @returns {number|null} A rank, or null when the record does not match.
 */
function rankRecord(record, query) {
  const title = String(record?.title ?? '').toLowerCase();
  if (title.startsWith(query)) return RANK_TITLE_STARTS_WITH;
  if (title.includes(query)) return RANK_TITLE_CONTAINS;
  if (YEAR_QUERY.test(query) && String(record?.year ?? '') === query) {
    return RANK_FIELD_MATCH;
  }
  for (const field of [record?.craft, record?.type, record?.country]) {
    if (field != null && String(field).toLowerCase().startsWith(query)) {
      return RANK_FIELD_MATCH;
    }
  }
  return null;
}

/**
 * Search a mixed list of sky and ancient-site records.
 *
 * Matching is case-insensitive. A title match beats a field match; a
 * title-starts-with match beats a title-contains match. A 4-digit query
 * also matches a record's year exactly, and craft, type and country match
 * by prefix. An empty or whitespace-only query returns no results.
 *
 * @param {string} query Free-text query typed by the user.
 * @param {Array<{id: string, register: 'sky'|'ancient', title?: string, year?: number, craft?: string, type?: string, period?: string, country?: string}>} records
 * @returns {Array<Object>} Up to 8 matching records, best match first.
 */
export function searchCases(query, records) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed || !Array.isArray(records) || !records.length) return [];
  const q = trimmed.toLowerCase();
  const ranked = [];
  for (const record of records) {
    const rank = rankRecord(record, q);
    if (rank !== null) ranked.push({ record, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked.slice(0, RESULT_CAP).map((entry) => entry.record);
}

/** A record's title, split into lower-cased word tokens on any run of
 * non-alphanumeric characters, so "Dolmen de Carnac-Plage" tokenises to
 * ["dolmen", "de", "carnac", "plage"]. Digits count as word characters, so
 * an id like "geipan-1954-08-..." tokenises with "1954" as its own word. */
const WORD_SPLIT_RE = /[^a-z0-9]+/;

/** Push `record` onto `map.get(key)`, creating the bucket on first use. */
function pushBucket(map, key, record) {
  const bucket = map.get(key);
  if (bucket) bucket.push(record);
  else map.set(key, [record]);
}

/** The three fields `rankRecord` checks by prefix for a field match. */
const FIELD_NAMES = ['craft', 'type', 'country'];

/**
 * Build a reusable prefix-bucket index over `records`, so a later query
 * scans only the records that could plausibly match instead of every
 * record in the corpus. A pure build step: it reads `records` once and
 * stores references back into it (no per-record copies), so its memory
 * cost is a handful of small arrays of object references plus one small
 * object per record in `order`, not a second copy of the corpus.
 *
 * - `wordStartBuckets` (keyed by a single lower-cased character): every
 *   record that has some word in its title starting with that character
 *   (a title's own first word included, so this alone covers both the
 *   title-starts-with and the title-contains tiers for any query that
 *   lines up with a word boundary).
 * - `fieldValueBuckets` (keyed by `"<field>:<lower-cased value>"`) plus
 *   `distinctFieldValues`, the small deduplicated list of those keys: a
 *   query is checked against that short list (bounded by how many
 *   distinct craft, type and country values the corpus actually holds,
 *   not by its row count), and only the buckets whose value it prefixes
 *   are scanned. Keyed by the *whole* field value rather than its first
 *   character on purpose: this corpus has ~81,000 rows and only 5 ancient
 *   site types, two-thirds of them "mound" - a first-character bucket for
 *   type would put most of the corpus behind the letter "m" and defeat
 *   the index for any query starting with it.
 * - `yearBuckets` (keyed by the numeric year): every record with that
 *   exact year, for 4-digit year queries.
 *
 * `searchCasesWithIndex` still runs every candidate it gathers through the
 * exact same `rankRecord` used by `searchCases`, so a record that reaches
 * the ranking step is ranked identically either way. The one behavioural
 * difference from a full scan: a query that matches strictly *inside* a
 * word (for example "orb" inside "Morbihan", not at a word boundary) is
 * not found here, since no bucket is keyed by a mid-word character.
 * `searchCases` remains the exact, unindexed reference implementation for
 * small inputs where that gap does not matter and the O(n) scan is cheap
 * anyway.
 *
 * @param {Array<Object>} records Same shape `searchCases` accepts.
 * @returns {{wordStartBuckets: Map<string, Array<Object>>, fieldValueBuckets: Map<string, Array<Object>>, distinctFieldValues: Array<{value: string, key: string}>, yearBuckets: Map<number, Array<Object>>, order: Map<Object, number>}}
 */
export function buildCaseSearchIndex(records) {
  const list = Array.isArray(records) ? records : [];
  const wordStartBuckets = new Map();
  const fieldValueBuckets = new Map();
  const distinctFieldValues = [];
  const seenFieldValueKeys = new Set();
  const yearBuckets = new Map();
  const order = new Map();
  list.forEach((record, i) => {
    order.set(record, i);
    const title = String(record?.title ?? '').toLowerCase();
    const seenTitleChars = new Set();
    for (const word of title.split(WORD_SPLIT_RE)) {
      if (!word) continue;
      const ch = word[0];
      if (seenTitleChars.has(ch)) continue;
      seenTitleChars.add(ch);
      pushBucket(wordStartBuckets, ch, record);
    }
    for (const field of FIELD_NAMES) {
      const raw = record?.[field];
      if (raw == null) continue;
      const value = String(raw).toLowerCase();
      if (!value) continue;
      const key = `${field}:${value}`;
      if (!seenFieldValueKeys.has(key)) {
        seenFieldValueKeys.add(key);
        distinctFieldValues.push({ value, key });
      }
      pushBucket(fieldValueBuckets, key, record);
    }
    if (Number.isFinite(record?.year))
      pushBucket(yearBuckets, record.year, record);
  });
  return {
    wordStartBuckets,
    fieldValueBuckets,
    distinctFieldValues,
    yearBuckets,
    order,
  };
}

/**
 * Search using an index built by `buildCaseSearchIndex`. Same ranking,
 * cap and tie-break rules as `searchCases` (ties keep the original corpus
 * order, via the index's own `order` map, since candidates are gathered
 * out of bucket order rather than corpus order) - see that function's own
 * doc comment, and `buildCaseSearchIndex`'s for the one behavioural gap
 * (mid-word substrings) this path accepts in exchange for not scanning
 * every record on every keystroke.
 * @param {string} query
 * @param {ReturnType<typeof buildCaseSearchIndex>} index
 * @returns {Array<Object>} Up to 8 matching records, best match first.
 */
export function searchCasesWithIndex(query, index) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed || !index) return [];
  const q = trimmed.toLowerCase();
  const ch = q[0];
  const candidates = new Set();
  for (const record of index.wordStartBuckets.get(ch) || [])
    candidates.add(record);
  for (const { value, key } of index.distinctFieldValues) {
    if (!value.startsWith(q)) continue;
    for (const record of index.fieldValueBuckets.get(key) || [])
      candidates.add(record);
  }
  if (YEAR_QUERY.test(q)) {
    for (const record of index.yearBuckets.get(Number(q)) || [])
      candidates.add(record);
  }
  const ranked = [];
  for (const record of candidates) {
    const rank = rankRecord(record, q);
    if (rank !== null)
      ranked.push({ record, rank, order: index.order.get(record) ?? 0 });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return ranked.slice(0, RESULT_CAP).map((entry) => entry.record);
}
