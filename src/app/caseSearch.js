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
