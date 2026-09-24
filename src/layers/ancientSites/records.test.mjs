import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAncientSites } from './records.js';

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
