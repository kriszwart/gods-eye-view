import test from 'node:test';
import assert from 'node:assert/strict';
import {
  searchCases,
  buildCaseSearchIndex,
  searchCasesWithIndex,
} from './caseSearch.js';

test('empty or whitespace query returns no results', () => {
  const records = [
    { id: 'a', register: 'sky', title: 'Phoenix lights', year: 1997 },
  ];
  assert.deepEqual(searchCases('', records), []);
  assert.deepEqual(searchCases('   ', records), []);
  assert.deepEqual(searchCases(undefined, records), []);
});

test('title-starts-with ranks above title-contains', () => {
  const records = [
    { id: 'contains', register: 'sky', title: 'Bright phoenix event' },
    { id: 'starts', register: 'sky', title: 'Phoenix lights' },
  ];
  const results = searchCases('phoenix', records);
  assert.deepEqual(
    results.map((r) => r.id),
    ['starts', 'contains'],
  );
});

test('title match ranks above a field match', () => {
  const records = [
    { id: 'field', register: 'ancient', title: 'Avebury', type: 'circle' },
    {
      id: 'title',
      register: 'sky',
      title: 'Circle over the harbour',
      type: 'formation',
    },
  ];
  const results = searchCases('circle', records);
  assert.deepEqual(
    results.map((r) => r.id),
    ['title', 'field'],
  );
});

test('a 4-digit query matches the year exactly', () => {
  const records = [
    { id: 'roswell', register: 'sky', title: 'Roswell debris', year: 1947 },
    {
      id: 'rainier',
      register: 'sky',
      title: 'Mount Rainier sighting',
      year: 1947,
    },
    { id: 'phoenix', register: 'sky', title: 'Phoenix lights', year: 1997 },
  ];
  const results = searchCases('1947', records);
  assert.deepEqual(
    new Set(results.map((r) => r.id)),
    new Set(['roswell', 'rainier']),
  );
  assert.equal(
    results.some((r) => r.id === 'phoenix'),
    false,
  );
});

test('a non-year 4-digit query does not match year alone unless it is a genuine field or title hit', () => {
  const records = [
    { id: 'a', register: 'sky', title: 'Report one', year: 1947 },
  ];
  assert.deepEqual(searchCases('1948', records), []);
});

test('type query finds a field match by prefix, case-insensitively', () => {
  const records = [
    {
      id: 'stonehenge',
      register: 'ancient',
      title: 'Stonehenge',
      type: 'circle',
    },
    { id: 'avebury', register: 'ancient', title: 'Avebury', type: 'circle' },
    {
      id: 'gobekli-tepe',
      register: 'ancient',
      title: 'Gobekli Tepe',
      type: 'temple',
    },
  ];
  const results = searchCases('CIRCLE', records);
  const ids = results.map((r) => r.id);
  assert.ok(ids.includes('avebury'));
  assert.ok(ids.includes('stonehenge'));
  assert.ok(!ids.includes('gobekli-tepe'));
});

test('craft and country match by prefix too', () => {
  const records = [
    {
      id: 'tic-tac',
      register: 'sky',
      title: 'Nimitz encounter',
      craft: 'tic-tac',
    },
    { id: 'nowhere', register: 'sky', title: 'Unrelated report', craft: 'orb' },
    {
      id: 'egypt-site',
      register: 'ancient',
      title: 'Nabta Playa',
      country: 'Egypt',
    },
  ];
  assert.deepEqual(
    searchCases('tic', records).map((r) => r.id),
    ['tic-tac'],
  );
  assert.deepEqual(
    searchCases('egy', records).map((r) => r.id),
    ['egypt-site'],
  );
});

test('results are capped at 8', () => {
  const records = Array.from({ length: 12 }, (_, i) => ({
    id: `case-${i}`,
    register: 'sky',
    title: `Sighting near town ${i}`,
  }));
  const results = searchCases('sighting', records);
  assert.equal(results.length, 8);
});

test('a record carrying no matching field is excluded', () => {
  const records = [
    { id: 'a', register: 'sky', title: 'Roswell debris', year: 1947 },
    { id: 'b', register: 'ancient', title: 'Newgrange', type: 'mound' },
  ];
  assert.deepEqual(
    searchCases('nonexistentword', records).map((r) => r.id),
    [],
  );
});

// buildCaseSearchIndex / searchCasesWithIndex: the prefix-bucket index used
// for the ~85k-record production corpus (see the task report for the
// unindexed-vs-indexed latency measurements that motivated it). Every
// scenario above is re-run through the indexed path too, since the two are
// meant to agree everywhere except the one documented gap below.

test('indexed: empty or whitespace query returns no results', () => {
  const records = [
    { id: 'a', register: 'sky', title: 'Phoenix lights', year: 1997 },
  ];
  const index = buildCaseSearchIndex(records);
  assert.deepEqual(searchCasesWithIndex('', index), []);
  assert.deepEqual(searchCasesWithIndex('   ', index), []);
  assert.deepEqual(searchCasesWithIndex(undefined, index), []);
});

test('indexed: a falsy index returns no results rather than throwing', () => {
  assert.deepEqual(searchCasesWithIndex('phoenix', null), []);
  assert.deepEqual(searchCasesWithIndex('phoenix', undefined), []);
});

test('indexed: title-starts-with ranks above title-contains', () => {
  const records = [
    { id: 'contains', register: 'sky', title: 'Bright phoenix event' },
    { id: 'starts', register: 'sky', title: 'Phoenix lights' },
  ];
  const index = buildCaseSearchIndex(records);
  assert.deepEqual(
    searchCasesWithIndex('phoenix', index).map((r) => r.id),
    ['starts', 'contains'],
  );
});

test('indexed: title match ranks above a field match', () => {
  const records = [
    { id: 'field', register: 'ancient', title: 'Avebury', type: 'circle' },
    {
      id: 'title',
      register: 'sky',
      title: 'Circle over the harbour',
      type: 'formation',
    },
  ];
  const index = buildCaseSearchIndex(records);
  assert.deepEqual(
    searchCasesWithIndex('circle', index).map((r) => r.id),
    ['title', 'field'],
  );
});

test('indexed: a 4-digit query matches the year exactly, via the year bucket', () => {
  const records = [
    { id: 'roswell', register: 'sky', title: 'Roswell debris', year: 1947 },
    {
      id: 'rainier',
      register: 'sky',
      title: 'Mount Rainier sighting',
      year: 1947,
    },
    { id: 'phoenix', register: 'sky', title: 'Phoenix lights', year: 1997 },
  ];
  const index = buildCaseSearchIndex(records);
  const results = searchCasesWithIndex('1947', index);
  assert.deepEqual(
    new Set(results.map((r) => r.id)),
    new Set(['roswell', 'rainier']),
  );
  assert.equal(
    results.some((r) => r.id === 'phoenix'),
    false,
  );
});

test('indexed: craft, type and country match by prefix, case-insensitively', () => {
  const records = [
    {
      id: 'tic-tac',
      register: 'sky',
      title: 'Nimitz encounter',
      craft: 'tic-tac',
    },
    { id: 'nowhere', register: 'sky', title: 'Unrelated report', craft: 'orb' },
    {
      id: 'egypt-site',
      register: 'ancient',
      title: 'Nabta Playa',
      country: 'Egypt',
    },
  ];
  const index = buildCaseSearchIndex(records);
  assert.deepEqual(
    searchCasesWithIndex('tic', index).map((r) => r.id),
    ['tic-tac'],
  );
  assert.deepEqual(
    searchCasesWithIndex('EGY', index).map((r) => r.id),
    ['egypt-site'],
  );
});

test('indexed: a field value that dominates the corpus does not swamp a narrower query', () => {
  // Mirrors the shipped ancient-sites sweep, where about two-thirds of all
  // ~81k rows share the type "mound" - if the field index bucketed by a
  // value's first character rather than its whole value, every query
  // starting with "m" would have to scan that entire majority-type slab
  // regardless of what it was actually looking for.
  const records = [
    ...Array.from({ length: 500 }, (_, i) => ({
      id: `mound-${i}`,
      register: 'ancient',
      title: `Unnamed earthwork ${i}`,
      type: 'mound',
    })),
    {
      id: 'megalith-1',
      register: 'ancient',
      title: 'Standing stone',
      type: 'megalith',
    },
  ];
  const index = buildCaseSearchIndex(records);
  assert.deepEqual(
    searchCasesWithIndex('megalith', index).map((r) => r.id),
    ['megalith-1'],
  );
});

test('indexed: title matches at a word boundary are found (not just at the title start)', () => {
  const records = [
    { id: 'great-zim', register: 'ancient', title: 'Great Zimbabwe' },
    { id: 'carnac', register: 'ancient', title: 'Dolmen de Carnac-Plage' },
  ];
  const index = buildCaseSearchIndex(records);
  assert.deepEqual(
    searchCasesWithIndex('zimbabwe', index).map((r) => r.id),
    ['great-zim'],
  );
  assert.deepEqual(
    searchCasesWithIndex('carnac', index).map((r) => r.id),
    ['carnac'],
  );
  assert.deepEqual(
    searchCasesWithIndex('great zim', index).map((r) => r.id),
    ['great-zim'],
  );
});

test('indexed: a documented gap - a query matching strictly inside a word (not at a word boundary) is not found', () => {
  // "orb" is a substring of "Morbihan" but does not start any of its words,
  // so the indexed path misses it - see buildCaseSearchIndex's own doc
  // comment. searchCases (unindexed) still finds it, for callers with small
  // enough corpora that the exact O(n) scan is affordable.
  const records = [
    { id: 'morbihan', register: 'sky', title: 'GEIPAN case morbihan-1976' },
  ];
  const index = buildCaseSearchIndex(records);
  assert.deepEqual(searchCasesWithIndex('orb', index), []);
  assert.deepEqual(
    searchCases('orb', records).map((r) => r.id),
    ['morbihan'],
  );
});

test('indexed: results are capped at 8 and keep the original corpus order on ties', () => {
  const records = Array.from({ length: 12 }, (_, i) => ({
    id: `case-${i}`,
    register: 'sky',
    title: `Sighting near town ${i}`,
  }));
  const index = buildCaseSearchIndex(records);
  const results = searchCasesWithIndex('sighting', index);
  assert.equal(results.length, 8);
  assert.deepEqual(
    results.map((r) => r.id),
    records.slice(0, 8).map((r) => r.id),
  );
});

test('indexed: a record carrying no matching field is excluded', () => {
  const records = [
    { id: 'a', register: 'sky', title: 'Roswell debris', year: 1947 },
    { id: 'b', register: 'ancient', title: 'Newgrange', type: 'mound' },
  ];
  const index = buildCaseSearchIndex(records);
  assert.deepEqual(
    searchCasesWithIndex('nonexistentword', index).map((r) => r.id),
    [],
  );
});

// Unicode-aware word starts (fix round, finding 1): `WORD_SPLIT_RE` used to
// be ASCII-only (`/[^a-z0-9]+/`), which treated every accented or non-Latin
// opening letter as a separator, so the word before it (usually the whole
// title, when it is the title's first word) was silently dropped from
// `wordStartBuckets` and the record became unreachable by its own name. 224
// of 81,293 sweep titles in the shipped dataset open this way; these five
// are the ones named in the review finding.
const NON_ASCII_TITLE_RECORDS = [
  {
    id: 'arslev',
    register: 'ancient',
    title: 'Årslev Dyssen',
    type: 'megalith',
  },
  { id: 'certuv', register: 'ancient', title: 'Čertův stůl', type: 'megalith' },
  { id: 'hagar', register: 'ancient', title: 'Ħaġar Qim', type: 'temple' },
  {
    id: 'ile-milliau',
    register: 'ancient',
    title: 'Île Milliau gallery grave',
    type: 'megalith',
  },
  {
    id: 'oyu',
    register: 'ancient',
    title: 'Ōyu Stone Circles',
    type: 'megalith',
  },
];

test('indexed: a title opening on an accented letter is reachable by that letter', () => {
  const index = buildCaseSearchIndex(NON_ASCII_TITLE_RECORDS);
  assert.deepEqual(
    searchCasesWithIndex('årslev', index).map((r) => r.id),
    ['arslev'],
  );
});

test('indexed: a title opening on a non-Latin letter is reachable by that letter', () => {
  const index = buildCaseSearchIndex(NON_ASCII_TITLE_RECORDS);
  assert.deepEqual(
    searchCasesWithIndex('ħaġar', index).map((r) => r.id),
    ['hagar'],
  );
});

test('indexed: agrees with the unindexed search across non-ASCII first letters', () => {
  const index = buildCaseSearchIndex(NON_ASCII_TITLE_RECORDS);
  for (const q of ['årslev', 'čertův', 'ħaġar', 'île', 'ōyu']) {
    const indexed = searchCasesWithIndex(q, index).map((r) => r.id);
    const unindexed = searchCases(q, NON_ASCII_TITLE_RECORDS).map((r) => r.id);
    assert.ok(indexed.length > 0, `expected a match for query "${q}"`);
    assert.deepEqual(indexed, unindexed, `mismatch for query "${q}"`);
  }
});

test('indexed: agrees with the unindexed search on word-boundary queries', () => {
  const records = [
    {
      id: 'a',
      register: 'sky',
      title: 'Roswell debris',
      year: 1947,
      craft: 'egg',
    },
    {
      id: 'b',
      register: 'ancient',
      title: 'Newgrange',
      type: 'mound',
      country: 'Ireland',
    },
    {
      id: 'c',
      register: 'ancient',
      title: 'Great Zimbabwe',
      type: 'settlement',
      country: 'Zimbabwe',
    },
    {
      id: 'd',
      register: 'sky',
      title: 'GEIPAN case geipan-1954-somme-000',
      year: 1954,
      craft: null,
      country: 'France',
    },
    {
      id: 'e',
      register: 'ancient',
      title: 'Stonehenge',
      type: 'circle',
      country: 'United Kingdom',
    },
  ];
  const index = buildCaseSearchIndex(records);
  for (const q of [
    'roswell',
    'newgrange',
    'zimbabwe',
    '1954',
    'mound',
    'ireland',
    'egg',
    'stonehenge',
  ]) {
    assert.deepEqual(
      searchCasesWithIndex(q, index).map((r) => r.id),
      searchCases(q, records).map((r) => r.id),
      `mismatch for query "${q}"`,
    );
  }
});
