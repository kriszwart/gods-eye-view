import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SCHEMA,
  round4,
  wikiTitleFromUrl,
  bceCoverage,
  dedupeAgainstHeroes,
  dedupeByQid,
  truncateName,
  typesIndex,
  countriesIndex,
  toColumns,
  validateV2,
  build,
} from '../src/build-ancient.mjs';
import { writeJsonl } from '../src/lib/records.mjs';

// -- pure functions --------------------------------------------------------

test('round4 rounds a coordinate to 4 decimal places', () => {
  assert.equal(round4(37.223123456), 37.2231);
  assert.equal(round4(-9.20290874), -9.2029);
  assert.equal(round4(51.42839968297), 51.4284);
});

test('wikiTitleFromUrl extracts the still-encoded title segment after /wiki/', () => {
  assert.equal(
    wikiTitleFromUrl('https://en.wikipedia.org/wiki/G%C3%B6bekli_Tepe'),
    'G%C3%B6bekli_Tepe',
  );
  assert.equal(wikiTitleFromUrl('https://en.wikipedia.org/wiki/Stonehenge'), 'Stonehenge');
  assert.equal(wikiTitleFromUrl('https://en.wikipedia.org/wiki/Foo?action=edit'), 'Foo');
});

test('wikiTitleFromUrl returns the empty string when there is no article', () => {
  assert.equal(wikiTitleFromUrl(undefined), '');
  assert.equal(wikiTitleFromUrl(null), '');
  assert.equal(wikiTitleFromUrl(''), '');
});

test('bceCoverage is the fraction of rows carrying an inception date', () => {
  assert.equal(bceCoverage([]), 0);
  assert.equal(bceCoverage([{ inception: '2020' }, {}, {}, {}]), 0.25);
  assert.equal(bceCoverage([{ inception: 'x' }, { inception: 'y' }]), 1);
});

test('dedupeAgainstHeroes drops a sweep row within radiusKm of any hero, keeps the rest', () => {
  const heroes = [{ lat: 51.178875491763, lon: -1.8261907688977 }]; // Stonehenge
  const rows = [
    { qid: 'Q1', lat: 51.1789, lon: -1.8262 }, // ~0.01 km from Stonehenge
    { qid: 'Q2', lat: 51.2, lon: -1.83 }, // several km away
    { qid: 'Q3', lat: -33.8688, lon: 151.2093 }, // Sydney, nowhere close
  ];
  const { kept, dropped } = dedupeAgainstHeroes(rows, heroes, 1);
  assert.equal(dropped, 1);
  assert.deepEqual(kept.map((r) => r.qid), ['Q2', 'Q3']);
});

test('dedupeByQid keeps the first occurrence of each qid', () => {
  const rows = [{ qid: 'Q1', n: 1 }, { qid: 'Q2', n: 2 }, { qid: 'Q1', n: 3 }];
  const { kept, dropped } = dedupeByQid(rows);
  assert.equal(dropped, 1);
  assert.deepEqual(kept, [{ qid: 'Q1', n: 1 }, { qid: 'Q2', n: 2 }]);
});

test('truncateName leaves short names alone and shortens long ones with an ellipsis', () => {
  assert.equal(truncateName('Stonehenge'), 'Stonehenge');
  const long = 'A'.repeat(80);
  const short = truncateName(long, 60);
  assert.equal(short.length, 60);
  assert.ok(short.endsWith('…'));
});

test('typesIndex returns the sorted, deduplicated set of types present', () => {
  assert.deepEqual(
    typesIndex([{ type: 'mound' }, { type: 'circle' }, { type: 'mound' }, { type: 'megalith' }]),
    ['circle', 'megalith', 'mound'],
  );
});

test('countriesIndex returns the sorted, deduplicated set of countries present, with a blank for rows missing one', () => {
  assert.deepEqual(
    countriesIndex([{ country: 'Sweden' }, { country: 'Peru' }, {}, { country: 'Sweden' }]),
    ['', 'Peru', 'Sweden'],
  );
});

test('toColumns encodes rows against a types index, rounds coordinates and can store the wiki title or a flag, and country as strings, an index, or omitted', () => {
  const rows = [
    { qid: 'Q1', name: 'Alpha', lat: 1.23456, lon: 2.34567, type: 'circle', country: 'Sweden', wikipedia: 'https://en.wikipedia.org/wiki/Alpha' },
    { qid: 'Q2', name: 'Beta', lat: -3.1, lon: 4.2, type: 'mound', country: '' },
  ];
  const types = typesIndex(rows);

  const withTitles = toColumns(rows, types, { countryMode: 'strings', wikiAsTitle: true });
  assert.deepEqual(withTitles.qid, ['Q1', 'Q2']);
  assert.deepEqual(withTitles.lat, [1.2346, -3.1]);
  assert.deepEqual(withTitles.type, [types.indexOf('circle'), types.indexOf('mound')]);
  assert.deepEqual(withTitles.country, ['Sweden', '']);
  assert.deepEqual(withTitles.wiki, ['Alpha', '']);

  const flagsNoCountry = toColumns(rows, types, { countryMode: 'none', wikiAsTitle: false });
  assert.equal(flagsNoCountry.country, undefined);
  assert.deepEqual(flagsNoCountry.wiki, [1, 0]);

  const countries = countriesIndex(rows);
  const interned = toColumns(rows, types, { countryMode: 'index', countries, wikiAsTitle: true });
  assert.deepEqual(interned.country, [countries.indexOf('Sweden'), countries.indexOf('')]);
});

test('validateV2 accepts a well-formed document and rejects broken ones', () => {
  const heroes = Array.from({ length: 20 }, (_, i) => ({ id: `hero-${i}`, name: `Hero ${i}`, lat: 0, lon: 0 }));
  const good = {
    schema: SCHEMA,
    count: 22,
    generatedAt: new Date().toISOString(),
    heroes,
    types: ['circle', 'mound'],
    sites: { qid: ['Q1', 'Q2'], name: ['A', 'B'], lat: [1, 2], lon: [3, 4], type: [0, 1], wiki: ['', ''] },
  };
  assert.deepEqual(validateV2(good), []);

  const badLength = { ...good, sites: { ...good.sites, lat: [1] } };
  assert.ok(validateV2(badLength).length > 0);

  const badCount = { ...good, count: 999 };
  assert.ok(validateV2(badCount).some((e) => e === 'count'));

  const badType = { ...good, sites: { ...good.sites, type: [0, 5] } };
  assert.ok(validateV2(badType).some((e) => e.startsWith('type[')));

  const dupQid = { ...good, sites: { ...good.sites, qid: ['Q1', 'Q1'] } };
  assert.ok(dupQid && validateV2(dupQid).some((e) => e.includes('duplicate qid')));

  const emptyName = { ...good, sites: { ...good.sites, name: ['', 'B'] } };
  assert.ok(validateV2(emptyName).some((e) => e.startsWith('name[')));

  const outOfRangeLat = { ...good, sites: { ...good.sites, lat: [999, 2] } };
  assert.ok(validateV2(outOfRangeLat).some((e) => e.startsWith('lat[')));

  const tooFewHeroes = { ...good, heroes: heroes.slice(0, 5) };
  assert.ok(validateV2(tooFewHeroes).some((e) => e === 'heroes length'));
});

test('validateV2 checks country indices against countries[] when country is interned, and plain strings otherwise', () => {
  const heroes = Array.from({ length: 20 }, (_, i) => ({ id: `hero-${i}`, name: `Hero ${i}`, lat: 0, lon: 0 }));
  const interned = {
    schema: SCHEMA,
    count: 22,
    generatedAt: new Date().toISOString(),
    heroes,
    types: ['circle'],
    countries: ['Peru', 'Sweden'],
    sites: { qid: ['Q1', 'Q2'], name: ['A', 'B'], lat: [1, 2], lon: [3, 4], type: [0, 0], country: [0, 1], wiki: ['', ''] },
  };
  assert.deepEqual(validateV2(interned), []);

  const outOfRangeCountry = { ...interned, sites: { ...interned.sites, country: [0, 5] } };
  assert.ok(validateV2(outOfRangeCountry).some((e) => e.startsWith('country[')));

  const stringCountry = { ...interned, countries: undefined, sites: { ...interned.sites, country: ['Peru', 'Sweden'] } };
  assert.deepEqual(validateV2(stringCountry), []);

  const wrongTypeCountry = { ...interned, countries: undefined, sites: { ...interned.sites, country: [0, 1] } };
  assert.ok(validateV2(wrongTypeCountry).some((e) => e.startsWith('country[')));
});

// -- the real build ---------------------------------------------------------

test('build merges the curated heroes with the sweep, dedupes near heroes, and writes a valid v2 document', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ancient-build-'));
  try {
    const heroFile = path.join(dir, 'sites.v1.json');
    const sweepFile = path.join(dir, 'ancient-sweep.jsonl');
    const outFile = path.join(dir, 'sites.v2.json');

    const heroes = Array.from({ length: 20 }, (_, i) => ({
      id: `hero-${i}`, name: `Hero ${i}`, lat: i, lon: i, country: 'Nowhere', period: 'c. 1 BCE',
      period_start_bce: 1, type: 'circle', summary: 's', debated: 'd', unesco: null,
      source_url: 'https://example.org', attribution: 'Example', glyph: 'circle', image: null,
      image_attribution: null, wikipedia: 'https://en.wikipedia.org/wiki/Hero',
    }));
    await writeFile(heroFile, JSON.stringify({ schema: 'ancient.sites.v1', count: 20, sites: heroes }));

    await writeJsonl(sweepFile, [
      // Right on top of hero-0 (lat 0, lon 0) -- should be dropped as a duplicate of the hero.
      { qid: 'Q-near-hero', name: 'Near a hero', lat: 0.0001, lon: 0.0001, type: 'circle' },
      // Far from every hero -- should survive.
      { qid: 'Q-far', name: 'Far away', lat: 40.0, lon: 40.0, type: 'mound', country: 'Turkiye', wikipedia: 'https://en.wikipedia.org/wiki/Far_away' },
      // Duplicate qid of the row above -- should be dropped by the defensive qid dedupe.
      { qid: 'Q-far', name: 'Far away again', lat: 40.0, lon: 40.0, type: 'mound' },
      // No wikipedia link -- wiki column should read empty/false for it.
      { qid: 'Q-other', name: 'Something else', lat: -10, lon: -10, type: 'megalith', country: 'Peru' },
    ]);

    const result = await build({ heroFile, sweepFile, outFile, sizeBudgetBytes: 5 * 1024 * 1024 });

    assert.equal(result.heroesCount, 20);
    assert.equal(result.sweepRawCount, 4);
    assert.equal(result.qidDuplicates, 1);
    assert.equal(result.heroProximityDrops, 1);
    assert.equal(result.finalSweepCount, 2);
    assert.equal(result.totalCount, 22);

    const written = JSON.parse(await readFile(outFile, 'utf8'));
    assert.equal(written.schema, SCHEMA);
    assert.equal(written.count, 22);
    assert.equal(written.heroes.length, 20);
    assert.deepEqual(written.heroes[0], heroes[0]);
    assert.equal(written.sites.qid.length, 2);
    assert.deepEqual(written.sites.qid.sort(), ['Q-far', 'Q-other']);
    assert.deepEqual(validateV2(written), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('build honours a tight size budget by interning country and truncating long names, without dropping either', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ancient-build-trim-'));
  try {
    const heroFile = path.join(dir, 'sites.v1.json');
    const sweepFile = path.join(dir, 'ancient-sweep.jsonl');
    const outFile = path.join(dir, 'sites.v2.json');

    const heroes = Array.from({ length: 20 }, (_, i) => ({ id: `hero-${i}`, name: `Hero ${i}`, lat: -70 - i * 0.5, lon: -70 - i * 0.5 }));
    await writeFile(heroFile, JSON.stringify({ schema: 'ancient.sites.v1', count: 20, sites: heroes }));

    const rows = Array.from({ length: 200 }, (_, i) => ({
      qid: `Q${i}`,
      name: i === 0 ? 'X'.repeat(80) : `Site number ${i}`,
      lat: (i % 90) + 0.123456,
      lon: (i % 180) + 0.654321,
      type: 'mound',
      country: 'A fairly long country name string',
      wikipedia: i === 1 ? 'https://en.wikipedia.org/wiki/Site_1' : undefined,
    }));
    await writeJsonl(sweepFile, rows);

    // A budget too small for the full encoding but big enough once country is interned.
    const result = await build({ heroFile, sweepFile, outFile, sizeBudgetBytes: 4000 });

    const written = JSON.parse(await readFile(outFile, 'utf8'));
    assert.deepEqual(validateV2(written), []);
    assert.ok(Array.isArray(written.countries) && written.countries.length === 1, 'country should have been interned, not dropped');
    assert.deepEqual(written.sites.country, written.sites.qid.map(() => 0));
    assert.ok(written.sites.name[0].length <= 60, 'the very long name should have been truncated');
    assert.equal(written.sites.wiki[1], 'Site_1', 'wiki titles should still be kept, not reduced to a flag');
    assert.equal(result.encoding.truncate, true, 'should have reached the last, smallest encoding that keeps country and the wiki title');
    assert.equal(result.encoding.countryMode, 'index');
    assert.equal(result.encoding.wikiAsTitle, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
