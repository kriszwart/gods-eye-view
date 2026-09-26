import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAncientSites, normalizeAncientSitesV2 } from './records.js';
import { mapSweepAnalystRecord } from './model.js';

const VALID = {
  schema: 'ancient.sites.v1',
  count: 1,
  sites: [
    {
      id: 'x',
      name: 'X',
      lat: 1,
      lon: 2,
      country: 'C',
      period: 'c. 3000 BCE',
      period_start_bce: 3000,
      type: 'circle',
      summary: 's',
      debated: 'd',
      unesco: null,
      source_url: 'https://example.org',
      attribution: 'a',
      glyph: 'circle',
    },
  ],
};

test('valid payload normalises to rows', () => {
  const rows = normalizeAncientSites(VALID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'x');
});

test('wrong schema and bad coordinates are rejected', () => {
  assert.throws(() => normalizeAncientSites({ schema: 'nope', sites: [] }));
  assert.throws(() =>
    normalizeAncientSites({
      ...VALID,
      sites: [{ ...VALID.sites[0], lat: 400 }],
    }),
  );
});

const HERO = {
  id: 'gobekli-tepe',
  name: 'Gobekli Tepe',
  lat: 37.2231,
  lon: 38.9226,
  country: 'Turkey',
  period: 'c. 9500 BCE',
  period_start_bce: 9500,
  type: 'temple',
  summary: 's',
  debated: 'd',
  unesco: null,
  source_url: 'https://example.org',
  attribution: 'a',
  glyph: 'temple',
};

const VALID_V2 = {
  schema: 'ancient.sites.v2',
  count: 3,
  generatedAt: '2026-09-26T00:00:00.000Z',
  heroes: [HERO],
  types: ['circle', 'megalith'],
  countries: ['', 'France', 'Japan'],
  sites: {
    qid: ['Q1', 'Q2'],
    name: ['Menhir A', 'Q2'],
    lat: [47.5, 35.1],
    lon: [-2.1, 139.2],
    type: [1, 0],
    country: [1, 2],
    wiki: ['Menhir_A', ''],
  },
};

test('v2 payload decodes heroes verbatim and exposes typed sweep accessors', () => {
  const { heroes, sweep, count } = normalizeAncientSitesV2(VALID_V2);
  assert.equal(heroes.length, 1);
  assert.equal(heroes[0].id, 'gobekli-tepe');
  assert.equal(count, 3);
  assert.equal(sweep.length, 2);
  assert.equal(sweep.qid(0), 'Q1');
  assert.equal(sweep.name(0), 'Menhir A');
  assert.equal(sweep.lat(0), 47.5);
  assert.equal(sweep.lon(0), -2.1);
  assert.equal(sweep.typeName(0), 'megalith');
  assert.equal(sweep.countryName(0), 'France');
  assert.equal(sweep.wikiTitle(0), 'Menhir_A');
  assert.equal(sweep.typeName(1), 'circle');
  assert.equal(sweep.countryName(1), 'Japan');
  assert.equal(sweep.wikiTitle(1), '');
});

test('v2 rejects the wrong schema, a missing sweep column, and mismatched column lengths', () => {
  assert.throws(() =>
    normalizeAncientSitesV2({ ...VALID_V2, schema: 'ancient.sites.v1' }),
  );
  assert.throws(() =>
    normalizeAncientSitesV2({
      ...VALID_V2,
      sites: { ...VALID_V2.sites, wiki: undefined },
    }),
  );
  assert.throws(() =>
    normalizeAncientSitesV2({
      ...VALID_V2,
      sites: { ...VALID_V2.sites, lat: [47.5] },
    }),
  );
});

test('v2 rejects a hero with bad coordinates, same as v1', () => {
  assert.throws(() =>
    normalizeAncientSitesV2({
      ...VALID_V2,
      heroes: [{ ...HERO, lat: 400 }],
    }),
  );
});

test('mapSweepAnalystRecord reads a sweep row through the typed accessor', () => {
  const { sweep } = normalizeAncientSitesV2(VALID_V2);
  const record = mapSweepAnalystRecord(sweep, 0);
  assert.equal(record.id, 'sweep:Q1');
  assert.equal(record.name, 'Menhir A');
  assert.equal(record.lat, 47.5);
  assert.equal(record.lon, -2.1);
  assert.equal(record.type, 'megalith');
  assert.equal(record.country, 'France');
});
