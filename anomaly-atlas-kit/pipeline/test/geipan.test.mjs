import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { csvObjects } from '../src/lib/csv.mjs';
import { shapeMatcher } from '../src/lib/normalise.mjs';
import { geipanRowToRecord, parseGeipanDate, pickColumn } from '../src/adapters/geipan.mjs';

const sources = JSON.parse(await readFile(new URL('../config/sources.json', import.meta.url), 'utf8'));
const columns = JSON.parse(await readFile(new URL('../config/geipan-columns.json', import.meta.url), 'utf8'));
const shapeMap = JSON.parse(await readFile(new URL('../config/shape-map.json', import.meta.url), 'utf8'));
const matchShape = shapeMatcher(shapeMap);

// The real cas_pub.csv header (August 2026 export), in the export's own
// column order, with five synthetic rows covering: a full date, a fully
// masked "--/--/YYYY" date, missing coordinates, a masked-day
// "--/mm/YYYY" date, an accented département, and all four classifications.
const HEADER = [
  'ID Etude de Cas', 'Titre du Cas', 'Détails', 'Année', 'Identification', 'Classification',
  'Code département', "Date d'observation", 'Département', 'Document pour cas',
  'Cas contenant des documents', 'Nouveau cas', 'Cas revisité', 'Latitude', 'Longitude',
  'Phénomène', 'Région', 'Temoignage associé', 'Type de cas',
].join(';');

const DETAILS_MARKER = 'NEVER-SHIP-THIS-WITNESS-NARRATIVE';

const ROWS = [
  // A, full date
  [
    '1980-06-00100', 'PARIS (75) 12.06.1980', `Long witness narrative. ${DETAILS_MARKER}.`, '1980',
    'Observation d\'une soucoupe argentee : identification certaine.', 'A', '75', '12/06/1980', 'Paris',
    '', 'Non', 'Non', 'Non', '48.85', '2.35', 'Ballon scientifique ou technologique', 'Ile-de-France',
    'PARIS (75) 12.06.1980', 'Observation terrestre',
  ],
  // B, fully masked date --/--/YYYY
  [
    '1955-01-00200', 'TOULOUSE (31) --.--.1955', `Long witness narrative. ${DETAILS_MARKER}.`, '1955',
    'Observation d\'une lumiere blanche : probablement une etoile.', 'B', '31', '--/--/1955', 'Haute-Garonne',
    '', 'Non', 'Non', 'Non', '43.6', '1.44', 'Etoile', 'Occitanie',
    'TOULOUSE (31) --.--.1955', 'Observation terrestre',
  ],
  // C, missing coordinates
  [
    '1990-03-00300', 'NANTES (44) 05.03.1990', `Long witness narrative. ${DETAILS_MARKER}.`, '1990',
    "manque d'information", 'C', '44', '05/03/1990', 'Loire-Atlantique',
    '', 'Non', 'Non', 'Non', '', '', "Manque d'informations fiables", 'Pays de la Loire',
    'NANTES (44) 05.03.1990', 'Observation terrestre',
  ],
  // D, accented département, full date
  [
    '1968-09-00400', 'BÉZIERS (34) 21.09.1968', `Long witness narrative. ${DETAILS_MARKER}.`, '1968',
    'Observation d\'un triangle lumineux : phenomene etrange non identifie.', 'D', '34', '21/09/1968', 'Hérault',
    '', 'Non', 'Non', 'Non', '43.34', '3.21', 'Phénomène étrange à très étrange/ de consistance moyenne à forte',
    'Occitanie', 'BÉZIERS (34) 21.09.1968', 'Observation terrestre',
  ],
  // A again, masked-day date --/mm/YYYY
  [
    '1999-07-00500', 'LYON (69) --.07.1999', `Long witness narrative. ${DETAILS_MARKER}.`, '1999',
    "Observation d'un objet ovale argente : manque d'information.", 'A', '69', '--/07/1999', 'Rhône',
    '', 'Non', 'Non', 'Non', '45.76', '4.84', 'Ballon', 'Auvergne-Rhône-Alpes',
    'LYON (69) --.07.1999', 'Observation terrestre',
  ],
];

const csv = [HEADER, ...ROWS.map((r) => r.map((v) => (v.includes(';') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v)).join(';'))].join('\r\n');
const rows = csvObjects(csv);

test('column picker finds the real header names, accents and punctuation aside', () => {
  assert.equal(pickColumn(rows[0], columns, 'id'), '1980-06-00100');
  assert.equal(pickColumn(rows[0], columns, 'departement'), 'Paris');
  assert.equal(pickColumn(rows[3], columns, 'departement'), 'Hérault');
});

test('GEIPAN dd/mm/yyyy dates, with -- placeholders kept at month or year precision', () => {
  const full = parseGeipanDate('12/06/1980', '1980');
  assert.equal(full.approximate, false);
  assert.deepEqual(full.date, { iso: '1980-06-12', precision: 'day', year: 1980, days: Math.floor(Date.UTC(1980, 5, 12) / 86400000) });
  const yearOnly = parseGeipanDate('--/--/1955', '1955');
  assert.equal(yearOnly.approximate, false);
  assert.deepEqual(yearOnly.date, { iso: '1955', precision: 'year', year: 1955, days: Math.floor(Date.UTC(1955, 0, 1) / 86400000) });
  assert.equal(parseGeipanDate('--/07/1999', '1999').date.precision, 'month');
  assert.equal(parseGeipanDate('--/07/1999', '1999').date.iso, '1999-07');
});

test('a masked digit in the day or year falls back to Année and is marked approximate', () => {
  const r = parseGeipanDate('2-/05/1995', '1995');
  assert.equal(r.approximate, true);
  assert.equal(r.date.precision, 'year');
  assert.equal(r.date.iso, '1995');
  const r2 = parseGeipanDate('--/--/199-', '1990');
  assert.equal(r2.approximate, true);
  assert.equal(r2.date.iso, '1990');
});

test('a calendar-invalid full date (GEIPAN data error) falls back to Année instead of being dropped', () => {
  // A real row in the export: "31/09/2000" -- September has no 31st.
  const r = parseGeipanDate('31/09/2000', '2000');
  assert.equal(r.approximate, true);
  assert.equal(r.date.precision, 'year');
  assert.equal(r.date.iso, '2000');
});

test('row A: full date, explained, grade A, shape matched', () => {
  const { record } = geipanRowToRecord(rows[0], { columns, sources, matchShape });
  assert.equal(record.date.iso, '1980-06-12');
  assert.equal(record.date.precision, 'day');
  assert.equal(record.grade.status, 'explained');
  assert.equal(record.grade.value, 'A');
  assert.equal(record.craft_id, 'domed-disc');
  assert.deepEqual([record.location.lat, record.location.lon, record.location.precision_km], [48.85, 2.35, 11]);
  assert.equal(record.source_url, 'https://www.geipan.fr/fr/cas/1980-06-00100');
  assert.equal(record.title, 'PARIS (75) 12.06.1980');
  assert.equal(record.explanation, 'Ballon scientifique ou technologique');
  assert.equal(record.summary, null);
  assert.equal(record.shape_raw, null);
  assert.match(record.id, /^[a-z0-9-]{6,120}$/);
});

test('row B: masked date, explained (probable), grade B', () => {
  const { record } = geipanRowToRecord(rows[1], { columns, sources, matchShape });
  assert.equal(record.date.iso, '1955');
  assert.equal(record.date.precision, 'year');
  assert.equal(record.grade.status, 'explained');
  assert.equal(record.grade.value, 'B');
  assert.equal(record.craft_id, 'orb');
});

test('row C: missing coordinates is dropped, not written with a bogus location', () => {
  const res = geipanRowToRecord(rows[2], { columns, sources, matchShape });
  assert.equal(res.record, undefined);
  assert.equal(res.skipped, 'location');
});

test('row D: accented département survives into the id and location, grade D unresolved', () => {
  const { record } = geipanRowToRecord(rows[3], { columns, sources, matchShape });
  assert.equal(record.grade.status, 'unresolved');
  assert.equal(record.grade.value, 'D');
  assert.equal(record.craft_id, 'triangle');
  assert.equal(record.location.place, 'Hérault');
  assert.match(record.id, /^[a-z0-9-]{6,120}$/);
  assert.ok(!record.id.includes('é'));
});

test('row A2: masked-day date keeps month precision', () => {
  const { record } = geipanRowToRecord(rows[4], { columns, sources, matchShape });
  assert.equal(record.date.iso, '1999-07');
  assert.equal(record.date.precision, 'month');
  assert.equal(record.craft_id, 'lens-disc');
});

test('the long Détails narrative never appears in any record', () => {
  for (const row of rows) {
    const res = geipanRowToRecord(row, { columns, sources, matchShape });
    if (res.record) assert.ok(!JSON.stringify(res.record).includes(DETAILS_MARKER), 'Détails leaked into a record');
  }
});
