import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chunkRanges, downloadPaged, USER_AGENT } from '../src/adapters/nara-download.mjs';

/** A tiny HTTP server standing in for the NARA bulk-export CDN: serves one
 * fixed buffer, honours HEAD and Range requests the same way CloudFront/S3
 * do, and records every request it receives so tests can assert on it. */
async function startFixtureServer(body) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, range: req.headers.range, userAgent: req.headers['user-agent'] });
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' });
      res.end();
      return;
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!m) {
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), body.length - 1);
    const slice = body.subarray(start, end + 1);
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': String(slice.length) });
    res.end(slice);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/fixture.json`, requests, close: () => new Promise((r) => server.close(r)) };
}

/** A fixture server that always truncates its 206 body, short of what the
 * requested Range asked for -- standing in for a flaky connection or a CDN
 * edge that cuts a response off early. */
async function startShortBodyServer(body, shortBy) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, range: req.headers.range });
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' });
      res.end();
      return;
    }
    const [, s, e] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const start = Number(s);
    const end = Number(e);
    const slice = body.subarray(start, end + 1 - shortBy);
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': String(slice.length) });
    res.end(slice);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/fixture.json`, requests, close: () => new Promise((r) => server.close(r)) };
}

async function withTempDirs(fn) {
  const base = await mkdtemp(path.join(tmpdir(), 'nara-download-'));
  try {
    await fn({ pagesDir: path.join(base, 'pages'), outFile: path.join(base, 'catalog-export-597821.json') });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const noSleep = async () => {};

test('chunkRanges splits a byte length into inclusive ranges of the given size, last one short', () => {
  assert.deepEqual(chunkRanges(25, 13), [[0, 12], [13, 24]]);
  assert.deepEqual(chunkRanges(10, 10), [[0, 9]]);
  assert.deepEqual(chunkRanges(0, 10), []);
});

test('downloads a two-page fixture and assembles the pages back into the original bytes', async () => {
  const body = Buffer.from('0123456789ABCDEFGHIJ'); // 20 bytes
  const { url, close } = await startFixtureServer(body);
  try {
    await withTempDirs(async ({ pagesDir, outFile }) => {
      const logs = [];
      const result = await downloadPaged({ url, pagesDir, outFile, chunkBytes: 11, delayMs: 0, sleep: noSleep, log: (m) => logs.push(m) });
      assert.equal(result.pages, 2);
      assert.equal(result.bytes, 20);
      assert.equal(result.fetched, 2);
      assert.deepEqual(await readFile(outFile), body);
      assert.ok(logs.length >= 1, 'progress is logged at least once');
    });
  } finally {
    await close();
  }
});

test('sends a browser User-Agent header on every request', async () => {
  const body = Buffer.from('12345678901234567890'); // 20 bytes
  const { url, requests, close } = await startFixtureServer(body);
  try {
    await withTempDirs(async ({ pagesDir, outFile }) => {
      await downloadPaged({ url, pagesDir, outFile, chunkBytes: 10, delayMs: 0, sleep: noSleep, log: () => {} });
      assert.ok(requests.length > 0);
      for (const r of requests) assert.equal(r.userAgent, USER_AGENT);
      assert.match(USER_AGENT, /Mozilla/);
    });
  } finally {
    await close();
  }
});

test('resumes by skipping a page already saved at its expected size, and does not re-fetch it', async () => {
  const body = Buffer.from('0123456789ABCDEFGHIJ'); // 20 bytes, chunkBytes 11 -> pages [0-10] (11 bytes), [11-19] (9 bytes)
  const { url, requests, close } = await startFixtureServer(body);
  try {
    await withTempDirs(async ({ pagesDir, outFile }) => {
      const { mkdir, writeFile: wf } = await import('node:fs/promises');
      await mkdir(pagesDir, { recursive: true });
      await wf(path.join(pagesDir, 'page-00000.part'), body.subarray(0, 11));

      const result = await downloadPaged({ url, pagesDir, outFile, chunkBytes: 11, delayMs: 0, sleep: noSleep, log: () => {} });
      assert.equal(result.pages, 2);
      assert.equal(result.fetched, 1, 'only the missing page should be fetched');
      assert.deepEqual(await readFile(outFile), body);

      const rangeRequests = requests.filter((r) => r.method === 'GET');
      assert.equal(rangeRequests.length, 1);
      assert.equal(rangeRequests[0].range, 'bytes=11-19');
    });
  } finally {
    await close();
  }
});

test('waits delayMs between successive fetches but not after the last page, and not for skipped pages', async () => {
  const body = Buffer.alloc(30, 'x');
  const { url, close } = await startFixtureServer(body);
  try {
    await withTempDirs(async ({ pagesDir, outFile }) => {
      const sleeps = [];
      await downloadPaged({ url, pagesDir, outFile, chunkBytes: 10, delayMs: 2000, sleep: async (ms) => sleeps.push(ms), log: () => {} });
      // 3 pages, all freshly fetched: 2 delays (after page 1 and page 2, none after the last)
      assert.deepEqual(sleeps, [2000, 2000]);
    });
  } finally {
    await close();
  }
});

test('logs progress every 10 pages and always on the final page', async () => {
  const body = Buffer.alloc(250, 'y');
  const { url, close } = await startFixtureServer(body);
  try {
    await withTempDirs(async ({ pagesDir, outFile }) => {
      const logs = [];
      const result = await downloadPaged({ url, pagesDir, outFile, chunkBytes: 10, delayMs: 0, sleep: noSleep, log: (m) => logs.push(m) });
      assert.equal(result.pages, 25);
      const mentions10 = logs.some((m) => /10\/25/.test(m));
      const mentions20 = logs.some((m) => /20\/25/.test(m));
      const mentionsFinal = logs.some((m) => /25\/25/.test(m));
      assert.ok(mentions10, `expected a log mentioning page 10/25, got: ${JSON.stringify(logs)}`);
      assert.ok(mentions20, `expected a log mentioning page 20/25, got: ${JSON.stringify(logs)}`);
      assert.ok(mentionsFinal, `expected a log mentioning the final page 25/25, got: ${JSON.stringify(logs)}`);
    });
  } finally {
    await close();
  }
});

test('a short 206 body is retried up to maxAttempts, then fails loudly instead of assembling a corrupt file', async () => {
  const body = Buffer.from('0123456789ABCDEFGHIJ'); // 20 bytes, one page (chunkBytes 20)
  const { url, requests, close } = await startShortBodyServer(body, 3); // every response is 3 bytes short
  try {
    await withTempDirs(async ({ pagesDir, outFile }) => {
      await assert.rejects(
        downloadPaged({ url, pagesDir, outFile, chunkBytes: 20, delayMs: 0, maxAttempts: 3, sleep: noSleep, log: () => {} }),
        /returned 17 bytes, expected 20/,
      );
      const getRequests = requests.filter((r) => r.method === 'GET');
      assert.equal(getRequests.length, 3, 'every attempt should have been retried up to maxAttempts');
      await assert.rejects(readFile(outFile), { code: 'ENOENT' }, 'no assembled file should exist after a failed download');
      await assert.rejects(readFile(path.join(pagesDir, 'page-00000.part')), { code: 'ENOENT' }, 'the short page should never be written to disk');
    });
  } finally {
    await close();
  }
});
