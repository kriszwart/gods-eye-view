import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parsePoint,
  qidFromUri,
  imageFileFromFilePathUrl,
  mapBinding,
  dedupeByQid,
  buildCountQuery,
  buildPageQuery,
  sweepClass,
  runSweep,
  USER_AGENT,
} from '../src/adapters/wikidata-sweep.mjs';
import { readJsonl } from '../src/lib/records.mjs';

// -- pure functions --------------------------------------------------------

test('parsePoint reads a Wikidata WKT literal as lon-then-lat and returns {lat, lon}', () => {
  assert.deepEqual(parsePoint('Point(-6.310925 53.26069444)'), { lat: 53.26069444, lon: -6.310925 });
  assert.deepEqual(parsePoint('Point(119.574433 -9.590833)'), { lat: -9.590833, lon: 119.574433 });
});

test('parsePoint rejects malformed or out-of-range literals', () => {
  assert.equal(parsePoint(null), null);
  assert.equal(parsePoint(undefined), null);
  assert.equal(parsePoint(''), null);
  assert.equal(parsePoint('not a point'), null);
  assert.equal(parsePoint('Point(200 91)'), null, 'lat/lon out of range');
});

test('qidFromUri extracts the Q-id from a full Wikidata entity URI', () => {
  assert.equal(qidFromUri('http://www.wikidata.org/entity/Q2104938'), 'Q2104938');
  assert.equal(qidFromUri('http://www.wikidata.org/entity/Q45791'), 'Q45791');
  assert.equal(qidFromUri(null), null);
  assert.equal(qidFromUri(''), null);
  assert.equal(qidFromUri('http://www.wikidata.org/entity/statement/Q1-abc'), null);
});

test('imageFileFromFilePathUrl decodes the Commons filename from a Special:FilePath URL', () => {
  assert.equal(
    imageFileFromFilePathUrl('http://commons.wikimedia.org/wiki/Special:FilePath/Toros%20de%20Guisando.jpg'),
    'Toros de Guisando.jpg',
  );
  assert.equal(
    imageFileFromFilePathUrl("http://commons.wikimedia.org/wiki/Special:FilePath/Gilgal%20Refa'im.JPG"),
    "Gilgal Refa'im.JPG",
  );
  assert.equal(imageFileFromFilePathUrl(null), null);
  assert.equal(imageFileFromFilePathUrl('http://example.com/not-a-filepath-url'), null);
});

// One realistic full binding, shaped like the live probe response.
const BULLS_OF_GUISANDO = {
  item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q2454775' },
  coord: { type: 'literal', datatype: 'http://www.opengis.net/ont/geosparql#wktLiteral', value: 'Point(-4.44161111 40.36069444)' },
  itemLabel: { type: 'literal', 'xml:lang': 'en', value: 'Bulls of Guisando' },
  countryLabel: { type: 'literal', 'xml:lang': 'en', value: 'Spain' },
  image: { type: 'uri', value: 'http://commons.wikimedia.org/wiki/Special:FilePath/Toros%20de%20Guisando.jpg' },
  article: { type: 'uri', value: 'https://en.wikipedia.org/wiki/Bulls_of_Guisando' },
};

test('mapBinding builds the full row shape from a complete binding', () => {
  const row = mapBinding(BULLS_OF_GUISANDO, 'megalith');
  assert.deepEqual(row, {
    qid: 'Q2454775',
    name: 'Bulls of Guisando',
    lat: 40.36069444,
    lon: -4.44161111,
    type: 'megalith',
    country: 'Spain',
    image_file: 'Toros de Guisando.jpg',
    wikipedia: 'https://en.wikipedia.org/wiki/Bulls_of_Guisando',
  });
});

test('mapBinding returns null when the item or its coordinate is missing (P625 is required)', () => {
  assert.equal(mapBinding({ ...BULLS_OF_GUISANDO, item: undefined }, 'megalith'), null);
  assert.equal(mapBinding({ ...BULLS_OF_GUISANDO, coord: undefined }, 'megalith'), null);
  assert.equal(mapBinding(null, 'megalith'), null);
});

test('mapBinding falls back to the QID as the name when no English label is bound', () => {
  const { itemLabel, ...rest } = BULLS_OF_GUISANDO;
  const row = mapBinding(rest, 'megalith');
  assert.equal(row.name, 'Q2454775');
});

test('mapBinding omits optional fields entirely when their bindings are absent', () => {
  const row = mapBinding({ item: BULLS_OF_GUISANDO.item, coord: BULLS_OF_GUISANDO.coord }, 'circle');
  assert.deepEqual(row, { qid: 'Q2454775', name: 'Q2454775', lat: 40.36069444, lon: -4.44161111, type: 'circle' });
  assert.ok(!('country' in row) && !('inception' in row) && !('image_file' in row) && !('wikipedia' in row));
});

test('mapBinding includes a real dateTime inception literal, including BCE (negative year) dates', () => {
  const withInception = { ...BULLS_OF_GUISANDO, inception: { type: 'literal', datatype: 'http://www.w3.org/2001/XMLSchema#dateTime', value: '-3000-01-01T00:00:00Z' } };
  assert.equal(mapBinding(withInception, 'megalith').inception, '-3000-01-01T00:00:00Z');
});

test('mapBinding drops an "unknown value" inception (a skolemized blank node, not a literal)', () => {
  // Wikidata's "unknown value" snaks come back from WDQS as a uri under
  // /.well-known/genid/, never as a literal -- a real date is always type
  // "literal" with an xsd:dateTime datatype.
  const unknownValue = { ...BULLS_OF_GUISANDO, inception: { type: 'uri', value: 'http://www.wikidata.org/.well-known/genid/deadbeef' } };
  const row = mapBinding(unknownValue, 'megalith');
  assert.ok(!('inception' in row));
});

test('dedupeByQid keeps the first occurrence of each QID and drops the rest, preserving order', () => {
  const rows = [
    { qid: 'Q1', type: 'megalith', name: 'A' },
    { qid: 'Q2', type: 'circle', name: 'B' },
    { qid: 'Q1', type: 'circle', name: 'A duplicate under a later class' },
    { qid: 'Q3', type: 'mound', name: 'C' },
  ];
  assert.deepEqual(dedupeByQid(rows), [
    { qid: 'Q1', type: 'megalith', name: 'A' },
    { qid: 'Q2', type: 'circle', name: 'B' },
    { qid: 'Q3', type: 'mound', name: 'C' },
  ]);
});

test('dedupeByQid tolerates null/falsy entries', () => {
  assert.deepEqual(dedupeByQid([null, { qid: 'Q1' }, undefined, { qid: 'Q1' }]), [{ qid: 'Q1' }]);
});

test('buildCountQuery counts distinct items in the class that carry a P625 coordinate', () => {
  const q = buildCountQuery('Q164240');
  assert.match(q, /COUNT\(DISTINCT \?item\)/);
  assert.match(q, /wd:Q164240/);
  assert.match(q, /wdt:P31\/wdt:P279\*/);
  assert.match(q, /wdt:P625/);
});

test('buildPageQuery paginates one coordinate per item and carries the optional enrichment fields', () => {
  const q = buildPageQuery('Q45791', { limit: 2000, offset: 4000 });
  assert.match(q, /wd:Q45791/);
  assert.match(q, /LIMIT 2000 OFFSET 4000/);
  assert.match(q, /GROUP BY \?item/, 'one coordinate per item via a SAMPLE subquery, not a cartesian product');
  assert.match(q, /ORDER BY \?item/, 'stable pagination');
  assert.match(q, /OPTIONAL \{ \?item wdt:P17/);
  assert.match(q, /OPTIONAL \{ \?item wdt:P571/);
  assert.match(q, /OPTIONAL \{ \?item wdt:P18/);
  assert.match(q, /isPartOf <https:\/\/en\.wikipedia\.org\/>/);
});

// -- paging, resume and politeness (fixture SPARQL endpoint) ---------------

/**
 * A tiny HTTP server standing in for the WDQS endpoint: answers a COUNT
 * query with `total`, and a paged SELECT query (recognised by its OFFSET)
 * with that page's bindings from `pagesOfFive`. Records every request's
 * headers and query text so tests can assert on politeness and pagination.
 */
function startFixtureSparql({ total, pageSize, makeBinding }) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const query = url.searchParams.get('query') || '';
    requests.push({ query, userAgent: req.headers['user-agent'], accept: req.headers.accept });

    res.writeHead(200, { 'content-type': 'application/sparql-results+json' });
    if (/COUNT\(DISTINCT/.test(query)) {
      res.end(JSON.stringify({ head: { vars: ['c'] }, results: { bindings: [{ c: { type: 'literal', value: String(total) } }] } }));
      return;
    }
    const m = /OFFSET (\d+)/.exec(query);
    const offset = m ? Number(m[1]) : 0;
    const bindings = [];
    for (let i = offset; i < Math.min(offset + pageSize, total); i++) bindings.push(makeBinding(i));
    res.end(JSON.stringify({ head: { vars: [] }, results: { bindings } }));
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/sparql`, requests, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const binding = (i) => ({
  item: { type: 'uri', value: `http://www.wikidata.org/entity/Q${1000 + i}` },
  coord: { type: 'literal', value: `Point(${i}.0 ${i}.0)` },
  itemLabel: { type: 'literal', value: `Site ${i}` },
});

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wikidata-sweep-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const noSleep = async () => {};

test('sweepClass paginates a class into per-page JSONL files and returns every mapped row', async () => {
  const { url, close } = await startFixtureSparql({ total: 5, pageSize: 2, makeBinding: binding });
  try {
    await withTempDir(async (outDir) => {
      const result = await sweepClass({
        endpoint: url, classId: 'megalith', qid: 'Q164240', type: 'megalith',
        pageSize: 2, outDir, delayMs: 0, sleep: noSleep, log: () => {},
      });
      assert.equal(result.count, 5);
      assert.equal(result.pages, 3);
      assert.equal(result.fetched, 3);
      assert.equal(result.rows.length, 5);
      assert.deepEqual(result.rows.map((r) => r.qid), ['Q1000', 'Q1001', 'Q1002', 'Q1003', 'Q1004']);
      for (const r of result.rows) assert.equal(r.type, 'megalith');

      const page0 = await readJsonl(path.join(outDir, 'megalith-page-00000.jsonl'));
      assert.equal(page0.length, 2);
      const page2 = await readJsonl(path.join(outDir, 'megalith-page-00002.jsonl'));
      assert.equal(page2.length, 1, 'the last page is short');
    });
  } finally {
    await close();
  }
});

test('sweepClass resumes: a page already on disk is not re-fetched, but still contributes its rows', async () => {
  const { url, requests, close } = await startFixtureSparql({ total: 5, pageSize: 2, makeBinding: binding });
  try {
    await withTempDir(async (outDir) => {
      await mkdir(outDir, { recursive: true });
      await writeFile(path.join(outDir, 'megalith-page-00000.jsonl'), `${JSON.stringify(mapBinding(binding(0), 'megalith'))}\n${JSON.stringify(mapBinding(binding(1), 'megalith'))}\n`);

      const result = await sweepClass({
        endpoint: url, classId: 'megalith', qid: 'Q164240', type: 'megalith',
        pageSize: 2, outDir, delayMs: 0, sleep: noSleep, log: () => {},
      });
      assert.equal(result.rows.length, 5, 'the resumed page still contributes its rows');
      assert.equal(result.fetched, 2, 'only the two missing pages were fetched');

      const pageQueries = requests.filter((r) => !/COUNT\(DISTINCT/.test(r.query));
      assert.equal(pageQueries.length, 2, 'the on-disk page never hit the network');
    });
  } finally {
    await close();
  }
});

test('sweepClass sends the polite Wikimedia User-Agent and the sparql-results Accept header on every request', async () => {
  const { url, requests, close } = await startFixtureSparql({ total: 2, pageSize: 2, makeBinding: binding });
  try {
    await withTempDir(async (outDir) => {
      await sweepClass({ endpoint: url, classId: 'megalith', qid: 'Q164240', type: 'megalith', pageSize: 2, outDir, delayMs: 0, sleep: noSleep, log: () => {} });
      assert.ok(requests.length >= 2);
      for (const r of requests) {
        assert.equal(r.userAgent, USER_AGENT);
        assert.equal(r.accept, 'application/sparql-results+json');
      }
    });
  } finally {
    await close();
  }
});

test('sweepClass waits delayMs between successive page fetches but not after the last page', async () => {
  const { url, close } = await startFixtureSparql({ total: 6, pageSize: 2, makeBinding: binding });
  try {
    await withTempDir(async (outDir) => {
      const sleeps = [];
      await sweepClass({
        endpoint: url, classId: 'megalith', qid: 'Q164240', type: 'megalith',
        pageSize: 2, outDir, delayMs: 2000, sleep: async (ms) => sleeps.push(ms), log: () => {},
      });
      // 3 pages fetched: 2 delays between them, none after the last.
      assert.deepEqual(sleeps, [2000, 2000]);
    });
  } finally {
    await close();
  }
});

test('runSweep sweeps every configured class, dedupes across classes (first class wins) and writes the merged JSONL', async () => {
  const classAUrl = await startFixtureSparql({ total: 2, pageSize: 2, makeBinding: binding }); // Q1000, Q1001
  const classBUrl = await startFixtureSparql({
    total: 2, pageSize: 2,
    makeBinding: (i) => (i === 0 ? binding(0) : { item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q2000' }, coord: { type: 'literal', value: 'Point(9.0 9.0)' }, itemLabel: { type: 'literal', value: 'Only in class B' } }),
  }); // Q1000 (overlaps class A) and Q2000
  try {
    await withTempDir(async (dir) => {
      const rawDir = path.join(dir, 'raw');
      const outFile = path.join(dir, 'ancient-sweep.jsonl');
      const result = await runSweep({
        classes: [
          { id: 'megalith', qid: 'Q164240', type: 'megalith', endpoint: classAUrl.url },
          { id: 'circle', qid: 'Q1935728', type: 'circle', endpoint: classBUrl.url },
        ],
        pageSize: 2, rawDir, outFile, delayMs: 0, sleep: noSleep, log: () => {},
      });

      assert.equal(result.perClass.length, 2);
      assert.equal(result.perClass[0].id, 'megalith');
      assert.equal(result.perClass[0].count, 2);
      assert.equal(result.totalRaw, 4);
      assert.equal(result.totalDeduped, 3, 'Q1000 counted once');
      assert.equal(result.dedupedAway, 1);

      const merged = await readJsonl(outFile);
      assert.equal(merged.length, 3);
      assert.deepEqual(merged.map((r) => r.qid).sort(), ['Q1000', 'Q1001', 'Q2000']);
      const overlap = merged.find((r) => r.qid === 'Q1000');
      assert.equal(overlap.type, 'megalith', 'the first class in config order keeps the item');
    });
  } finally {
    await classAUrl.close();
    await classBUrl.close();
  }
});
