// GEIPAN case export (CSV) to normalised records.
//   node src/adapters/geipan.mjs --inspect
//   node src/adapters/geipan.mjs
// Only cas_pub.csv (one row per case, with coordinates) is turned into
// records. temoignages_pub.csv sits alongside it in local_data/raw/geipan/
// but is per-testimony detail with a different shape; it is not read here.
// GEIPAN's own case narrative (Détails) is never read or stored. Only
// Phénomène (GEIPAN's short category label, used as the explanation) and
// Identification (read only to detect the reported shape) are consulted;
// Titre du Cas -- place and date only, no witness information -- is the
// only free text that ships, as the record's title.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { csvObjects } from '../lib/csv.mjs';
import { parseDate, gradeFor, shapeMatcher, makeId, roundLocation, clampText, stripAccents } from '../lib/normalise.mjs';
import { writeJsonl } from '../lib/records.mjs';
import { arg, root, loadJson } from '../lib/cli.mjs';
import { walk } from './common.mjs';

const norm = (s) => stripAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, '_');

/** Look up a column by its configured aliases (the real header name first), tolerant of accents and punctuation. */
export function pickColumn(row, columns, key) {
  const wanted = columns[key].map(norm);
  for (const [k, v] of Object.entries(row)) if (wanted.includes(norm(k))) return v;
  return '';
}

/**
 * Assert that every primary column name configured in geipan-columns.json
 * (the first, canonical alias for every key this adapter reads via
 * pickColumn) is present in the export's actual header. A renamed or
 * dropped column degrades silently otherwise: pickColumn falls through to
 * '', an unrecognised date column makes every row skip as 'date' (the
 * adapter still exits 0), and a renamed id or classification column leaves
 * source_ref or grade null without any error. Throws with the missing
 * column names and the header actually found on failure, so the caller can
 * print it and exit non-zero instead of writing a silently empty or wrong
 * dataset.
 */
export function assertPrimaryColumns(header, columns) {
  const found = new Set(header.map(norm));
  const missing = Object.entries(columns)
    .filter(([, aliases]) => Array.isArray(aliases))
    .map(([key, aliases]) => ({ key, primary: aliases[0] }))
    .filter(({ primary }) => !found.has(norm(primary)));
  if (missing.length) {
    const names = missing.map(({ key, primary }) => `${key}: "${primary}"`).join(', ');
    throw new Error(
      `GEIPAN export header is missing primary column(s): ${names}. ` +
      `Found header: ${header.join(' | ')}`,
    );
  }
}

/**
 * Parse GEIPAN's "Date d'observation" column: dd/mm/yyyy, where `--` for the
 * day or the month means that part is unknown (kept at month or year
 * precision). A handful of rows also mask a digit of the day, or of the
 * year itself ("2-/05/1995", "--/--/199-"), or hold a calendar-invalid date
 * ("31/09/2000", September has no 31st); those fall back to the Année
 * column, which GEIPAN always fills with a clean four-digit year, and are
 * marked approximate so the caller can flag them for review.
 */
export function parseGeipanDate(raw, yearFallback) {
  const m = String(raw ?? '').trim().match(/^(--|\d{2})\/(--|\d{2})\/(\d{4})$/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    if (dd !== '--' && mm !== '--') {
      const full = parseDate(`${dd}/${mm}/${yyyy}`);
      if (full) return { date: full, approximate: false };
    } else if (mm !== '--') {
      const month = parseDate(`${yyyy}-${mm}`);
      if (month) return { date: month, approximate: false };
    } else {
      return { date: parseDate(yyyy), approximate: false };
    }
  }
  const y = String(yearFallback ?? '').trim();
  return { date: /^\d{4}$/.test(y) ? parseDate(y) : null, approximate: true };
}

/**
 * Turn one GEIPAN case row (real export header) into a normalised record, or
 * a skip reason. Coordinates come straight from the export's own Latitude
 * and Longitude columns (GEIPAN pre-rounds these to about 0.1 degree before
 * publication), so there is no gazetteer lookup here.
 */
export function geipanRowToRecord(row, { columns, sources, matchShape }) {
  const pick = (key) => pickColumn(row, columns, key);
  const ref = pick('id');
  const { date, approximate } = parseGeipanDate(pick('date'), pick('year'));
  if (!date) return { skipped: 'date' };
  const latRaw = pick('latitude');
  const lonRaw = pick('longitude');
  const lat = latRaw === '' ? NaN : Number(latRaw);
  const lon = lonRaw === '' ? NaN : Number(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { skipped: 'location' };
  const departement = pick('departement');
  const loc = roundLocation(lat, lon, { precisionKm: 11, civilian: true });
  const record = {
    id: makeId('geipan', date.iso, departement || 'fr', ref),
    source: 'geipan', source_ref: ref || null,
    source_url: ref ? `https://www.geipan.fr/fr/cas/${ref}` : null,
    licence: sources.geipan.licence, attribution: sources.geipan.attribution,
    title: clampText(pick('title'), 120),
    date: { iso: date.iso, precision: date.precision, days: date.days },
    location: { ...loc, place: departement || null, country: 'FR', geocoder: 'source' },
    shape_raw: null, craft_id: matchShape(pick('identification')),
    grade: gradeFor('geipan', pick('classification')),
    explanation: clampText(pick('phenomene'), 200), summary: null,
    media: [], tags: [], hero: false, review: approximate,
    extraction: { method: 'parser', model: null, confidence: approximate ? 0.6 : 0.95 },
  };
  return { record };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = await walk(root('local_data/raw/geipan'), ['.csv']);
  if (!files.length) {
    console.log('No CSV files in local_data/raw/geipan/. Download the GEIPAN exports there first.');
    process.exit(0);
  }

  if (arg('inspect')) {
    for (const f of files) {
      const rows = csvObjects(await readFile(f.path, 'utf8'));
      console.log(`\n${path.basename(f.path)}: ${rows.length} rows\nHeader: ${Object.keys(rows[0] || {}).join(' | ')}\nFirst row: ${JSON.stringify(rows[0]).slice(0, 600)}`);
    }
    process.exit(0);
  }

  const sources = await loadJson('config/sources.json');
  const columns = await loadJson('config/geipan-columns.json');
  const matchShape = shapeMatcher(await loadJson('config/shape-map.json'));

  const caseFiles = files.filter((f) => /^cas/i.test(path.basename(f.path)));
  const ignored = files.length - caseFiles.length;
  if (ignored) console.log(`Ignoring ${ignored} non-case CSV file(s) (per-testimony detail, not read by this adapter).`);

  const out = [];
  const skipped = {};
  let headerChecked = false;
  for (const f of caseFiles) {
    const rows = csvObjects(await readFile(f.path, 'utf8'));
    if (!headerChecked && rows.length) {
      try {
        assertPrimaryColumns(Object.keys(rows[0]), columns);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      }
      headerChecked = true;
    }
    for (const row of rows) {
      const res = geipanRowToRecord(row, { columns, sources, matchShape });
      if (res.record) out.push(res.record);
      else skipped[res.skipped] = (skipped[res.skipped] || 0) + 1;
    }
  }
  if (!out.length) {
    console.error(`GEIPAN: 0 records written; skipped ${JSON.stringify(skipped)}. Aborting without writing an empty dataset.`);
    process.exit(1);
  }
  await writeJsonl(root('local_data/normalised/geipan.jsonl'), out);
  console.log(`GEIPAN: ${out.length} records written; skipped ${JSON.stringify(skipped)}`);
}
