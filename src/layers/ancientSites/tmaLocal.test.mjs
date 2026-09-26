import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTmaJsonl,
  createTmaLocalSource,
  TMA_ID_PREFIX,
  TMA_LOCAL_URL,
} from './tmaLocal.js';

const VALID_LINE = JSON.stringify({
  name: 'Palaggiu',
  category: 'Alignement',
  lat: 41.556616666667,
  lon: 8.8869,
  url: 'https://www.themodernantiquarian.com/site/14262/palaggiu',
});

test('decodes a valid row, keying its id off the record URL', () => {
  const rows = parseTmaJsonl(VALID_LINE);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: `${TMA_ID_PREFIX}14262`,
    name: 'Palaggiu',
    category: 'Alignement',
    lat: 41.556616666667,
    lon: 8.8869,
    url: 'https://www.themodernantiquarian.com/site/14262/palaggiu',
  });
});

test('skips blank lines and malformed JSON without failing the whole load', () => {
  const text = [VALID_LINE, '', '   ', 'not json', VALID_LINE].join('\n');
  const rows = parseTmaJsonl(text);
  assert.equal(rows.length, 2);
});

test('skips a row with an out-of-range or missing coordinate', () => {
  const badLat = JSON.stringify({
    name: 'The Cairns, Hall of Ireland',
    category: 'Cairn(s)',
    lat: 100,
    lon: -1.2228069199776,
    url: 'https://www.themodernantiquarian.com/site/12020/cairns-hall-of-ireland',
  });
  const missingLon = JSON.stringify({
    name: 'No coordinates',
    category: 'Other',
    lat: 51.1,
    url: 'https://www.themodernantiquarian.com/site/1/no-coordinates',
  });
  const rows = parseTmaJsonl([VALID_LINE, badLat, missingLon].join('\n'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Palaggiu');
});

test('skips a row with a missing or empty name', () => {
  const noName = JSON.stringify({
    category: 'Other',
    lat: 51.1,
    lon: -1.1,
    url: 'https://www.themodernantiquarian.com/site/2/nameless',
  });
  assert.equal(parseTmaJsonl(noName).length, 0);
});

test('falls back to a row-index id when a URL carries no TMA site id', () => {
  const noUrl = JSON.stringify({ name: 'Undocumented', lat: 1, lon: 1 });
  const rows = parseTmaJsonl(noUrl);
  assert.equal(rows[0].id, `${TMA_ID_PREFIX}row-0`);
  assert.equal(rows[0].category, '');
  assert.equal(rows[0].url, '');
});

test('rejects a non-string payload', () => {
  assert.throws(() => parseTmaJsonl(null));
  assert.throws(() => parseTmaJsonl(undefined));
});

test('createTmaLocalSource fetches the configured URL and decodes the body', async () => {
  const calls = [];
  const source = createTmaLocalSource({
    url: '/local-tma/tma-sites.jsonl',
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      async text() {
        return VALID_LINE;
      },
    };
  };
  try {
    const rows = await source.getRows();
    assert.equal(calls[0].url, TMA_LOCAL_URL);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Palaggiu');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createTmaLocalSource surfaces a non-ok response as an error', async () => {
  const source = createTmaLocalSource();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  try {
    await assert.rejects(() => source.getRows(), /404/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
