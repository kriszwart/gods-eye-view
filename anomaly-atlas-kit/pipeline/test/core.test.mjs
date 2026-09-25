import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDate, gradeFor, shapeMatcher, roundLocation, makeId } from '../src/lib/normalise.mjs';
import { redactText } from '../src/lib/redact.mjs';
import { parseCsv, csvObjects } from '../src/lib/csv.mjs';
import { parsePlace } from '../src/lib/gazetteer.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { haversineKm, readNormalised, writeJsonl, toCases } from '../src/lib/records.mjs';

const shapeMap = JSON.parse(await readFile(new URL('../config/shape-map.json', import.meta.url), 'utf8'));

test('dates in every format the sources use', () => {
  assert.deepEqual(parseDate('1964-04-24'), { iso: '1964-04-24', precision: 'day', year: 1964, days: -2078 });
  assert.equal(parseDate('08/01/1981').iso, '1981-01-08');
  assert.equal(parseDate('1977-10').precision, 'month');
  assert.equal(parseDate('2008').precision, 'year');
  assert.equal(parseDate('June 24, 1947').iso, '1947-06-24');
  assert.equal(parseDate('24 juin 1947').iso, '1947-06-24');
  assert.equal(parseDate('31/02/1990'), null);
  assert.equal(parseDate('not a date'), null);
});

test('grades map to shared statuses and scores', () => {
  assert.equal(gradeFor('geipan', 'D').status, 'unresolved');
  assert.equal(gradeFor('geipan', 'Cas A').status, 'explained');
  assert.equal(gradeFor('bluebook', 'UNIDENTIFIED').status, 'unresolved');
  assert.equal(gradeFor('bluebook', 'Balloon').status, 'explained');
  assert.equal(gradeFor('bluebook', '').status, 'insufficient');
  assert.equal(gradeFor('pursue', 'contested').score, 0.6);
});

test('shape vocabulary resolves to craft ids, longest phrase first, French included', () => {
  const m = shapeMatcher(shapeMap);
  assert.equal(m('A flying saucer with lights'), 'domed-disc');
  assert.equal(m('green fireball'), 'fireball');
  assert.equal(m('V-shaped formation'), 'light-v');
  assert.equal(m('a V-shaped craft'), 'boomerang');
  assert.equal(m('une boule lumineuse orange'), 'orb');
  assert.equal(m('soucoupe'), 'domed-disc');
  assert.equal(m('Tic Tac'), 'tic-tac');
  assert.equal(m(''), 'orb');
});

test('civilian locations are never finer than about a kilometre', () => {
  const r = roundLocation(52.123456, 1.987654, { precisionKm: 0.2, civilian: true });
  assert.deepEqual([r.lat, r.lon, r.precision_km], [52.12, 1.99, 1]);
  assert.equal(roundLocation(52.123456, 1.987654, { precisionKm: 60 }).lat, 52.1);
});

test('redaction removes contact details and named people', () => {
  const { text, hits } = redactText('Call 0114 496 0123 or mail jo@example.com. Mr John Smith of 12 High Street saw it. Witness: A. N. Other');
  assert.ok(!/0114|example|Smith|High Street|Other/.test(text), text);
  assert.ok(hits.length >= 4);
  assert.equal(redactText('The object hovered for 30 seconds').text, 'The object hovered for 30 seconds');
});

test('CSV reader copes with semicolons, quotes, CRLF and BOM', () => {
  const rows = csvObjects('\ufeffid;commune;resume\r\n1;"Trans; Var";"un ""objet"""\r\n');
  assert.deepEqual(rows, [{ id: '1', commune: 'Trans; Var', resume: 'un "objet"' }]);
  assert.equal(parseCsv('a,b\n1,2\n').length, 2);
});

test('place parsing and distance helpers', () => {
  assert.deepEqual(parsePlace('Socorro, New Mexico').admin1, 'NM');
  assert.equal(parsePlace('Levelland, TX').country, 'US');
  assert.ok(Math.abs(haversineKm({ lat: 51.5, lon: 0 }, { lat: 48.85, lon: 2.35 }) - 342) < 5);
  assert.match(makeId('bluebook', '1952-07-19', 'Washington, D.C.', '597821'), /^bluebook-1952-07-19-washington-d-c-597821$/);
});

test('readNormalised, given an allow-list, reads only the named files and skips the rest of the folder', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'read-normalised-'));
  try {
    await writeJsonl(path.join(dir, 'geipan.jsonl'), [{ a: 1 }]);
    await writeJsonl(path.join(dir, 'other-layer.jsonl'), [{ b: 2 }]);
    const all = await readNormalised(dir);
    assert.equal(all.length, 2, 'no allow-list reads every jsonl file, unchanged default behaviour');
    const filtered = await readNormalised(dir, ['geipan']);
    assert.deepEqual(filtered, [{ a: 1 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toCases carries the wikipedia field through for hero records, leaving non-hero behaviour untouched', () => {
  const base = {
    title: 'Hero case', hero: true,
    date: { iso: '1997-03-13', precision: 'day', days: 9933 },
    location: { lat: 33, lon: -112, precision_km: 50 },
    craft_id: 'boomerang', shape_raw: null,
    grade: { scheme: 'sample', value: null, status: 'contested', score: 0.5 },
    explanation: null, summary: null, source: 'sample',
    source_ref: null, source_url: null, source_note: null,
    attribution: 'Sample', media: [], tags: [], related: [],
  };
  const heroWithWikipedia = { ...base, id: 'case-hero-with-wikipedia', wikipedia: 'https://en.wikipedia.org/wiki/Example' };
  const heroWithoutWikipedia = { ...base, id: 'case-hero-without-wikipedia', wikipedia: null };
  const nonHero = { ...base, id: 'not-a-hero', hero: false, wikipedia: 'https://en.wikipedia.org/wiki/Ignored' };
  const cases = toCases([heroWithWikipedia, heroWithoutWikipedia, nonHero]);
  assert.equal(cases.length, 2, 'non-hero records are still excluded from the dossier output');
  assert.equal(
    cases.find((c) => c.id === 'case-hero-with-wikipedia').wikipedia,
    'https://en.wikipedia.org/wiki/Example',
  );
  assert.equal(cases.find((c) => c.id === 'case-hero-without-wikipedia').wikipedia, null);
});
