import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCases } from './caseSearch.js';

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
