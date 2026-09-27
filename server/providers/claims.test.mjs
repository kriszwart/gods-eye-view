import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIM_CAP,
  CLAIM_FIELDS,
  CLAIM_WINDOW_MS,
  FALLBACK_SHAPE_CATEGORIES,
  MAX_CLASSIFY_ATTEMPTS,
  blueskyRowToCandidate,
  classifyWithRetryLimit,
  dedupeById,
  evictWindow,
  loadShapeCategories,
  redditRowToCandidate,
  validateClassified,
} from './claims.js';

test('redditRowToCandidate maps a Listing child to a source-prefixed candidate', () => {
  const child = {
    kind: 't3',
    data: {
      id: 'abc123',
      title: 'Saw a bright light over the ridge',
      selftext: 'It hovered for a minute then shot upward.',
      permalink: '/r/UFOs/comments/abc123/saw_a_bright_light/',
      created_utc: 1735000000,
      author: 'someRedditor',
    },
  };
  const candidate = redditRowToCandidate(child);
  assert.equal(candidate.id, 'reddit:abc123');
  assert.equal(
    candidate.url,
    'https://www.reddit.com/r/UFOs/comments/abc123/saw_a_bright_light/',
  );
  assert.equal(candidate.source, 'reddit');
  assert.match(candidate.text, /bright light/);
  assert.match(candidate.text, /hovered/);
  assert.equal(candidate.when, new Date(1735000000 * 1000).toISOString());
  assert.equal(JSON.stringify(candidate).includes('someRedditor'), false);
});

test('redditRowToCandidate rejects malformed or empty rows', () => {
  assert.equal(redditRowToCandidate(null), null);
  assert.equal(redditRowToCandidate({ data: {} }), null);
  assert.equal(
    redditRowToCandidate({
      data: {
        id: 'x',
        permalink: 'not-a-path',
        created_utc: 1735000000,
        title: 'title',
      },
    }),
    null,
  );
  assert.equal(
    redditRowToCandidate({
      data: {
        id: 'x',
        permalink: '/r/UFOs/comments/x/y/',
        created_utc: 'not-a-number',
        title: 'title',
      },
    }),
    null,
  );
  assert.equal(
    redditRowToCandidate({
      data: {
        id: 'x',
        permalink: '/r/UFOs/comments/x/y/',
        created_utc: 1735000000,
        title: '',
        selftext: '   ',
      },
    }),
    null,
  );
});

test('blueskyRowToCandidate derives id and link-out url from the post uri, never the handle', () => {
  const post = {
    uri: 'at://did:plc:abcdefghijklmno/app.bsky.feed.post/3l7xyzabc12',
    cid: 'bafyabc',
    author: {
      did: 'did:plc:abcdefghijklmno',
      handle: 'realwitness.bsky.social',
      displayName: 'Real Witness',
    },
    record: {
      text: 'Watched a silent triangle cross the sky over the harbour.',
      createdAt: '2026-09-20T04:30:00.000Z',
    },
  };
  const candidate = blueskyRowToCandidate(post);
  assert.equal(candidate.id, 'bluesky:did:plc:abcdefghijklmno:3l7xyzabc12');
  assert.equal(
    candidate.url,
    'https://bsky.app/profile/did:plc:abcdefghijklmno/post/3l7xyzabc12',
  );
  assert.equal(candidate.source, 'bluesky');
  assert.equal(candidate.when, '2026-09-20T04:30:00.000Z');
  const serialised = JSON.stringify(candidate);
  assert.equal(serialised.includes('realwitness.bsky.social'), false);
  assert.equal(serialised.includes('Real Witness'), false);
});

test('blueskyRowToCandidate rejects malformed uris and empty text', () => {
  assert.equal(blueskyRowToCandidate(null), null);
  assert.equal(
    blueskyRowToCandidate({ uri: 'https://example.com/not-at-uri' }),
    null,
  );
  assert.equal(
    blueskyRowToCandidate({
      uri: 'at://did:plc:abc/app.bsky.feed.post/xyz',
      record: { text: '   ' },
    }),
    null,
  );
});

test('dedupeById drops repeats within the batch and ids already known, preserving order', () => {
  const candidates = [
    { id: 'reddit:a' },
    { id: 'reddit:b' },
    { id: 'reddit:a' },
    { id: 'bluesky:c' },
  ];
  const known = new Set(['bluesky:c']);
  const { fresh, seen } = dedupeById(candidates, known);
  assert.deepEqual(
    fresh.map((c) => c.id),
    ['reddit:a', 'reddit:b'],
  );
  assert.equal(seen.has('reddit:a'), true);
  assert.equal(seen.has('bluesky:c'), true);
  // Pure: the caller's Set is untouched.
  assert.equal(known.size, 1);
});

test('dedupeById ignores malformed entries without throwing', () => {
  const { fresh } = dedupeById([null, {}, { id: 42 }, { id: 'reddit:ok' }]);
  assert.deepEqual(
    fresh.map((c) => c.id),
    ['reddit:ok'],
  );
});

test('evictWindow keeps only items inside the window, newest first, capped', () => {
  const now = Date.parse('2026-09-27T12:00:00.000Z');
  const items = [
    { id: 'old', fetchedAt: new Date(now - 49 * 3600_000).toISOString() },
    { id: 'edge', fetchedAt: new Date(now - 47 * 3600_000).toISOString() },
    { id: 'newer', fetchedAt: new Date(now - 1 * 3600_000).toISOString() },
    { id: 'future', fetchedAt: new Date(now + 3600_000).toISOString() },
  ];
  const kept = evictWindow(items, now);
  assert.deepEqual(
    kept.map((item) => item.id),
    ['newer', 'edge'],
  );
});

test('evictWindow honours a custom cap', () => {
  const now = Date.parse('2026-09-27T12:00:00.000Z');
  const items = Array.from({ length: 10 }, (_, i) => ({
    id: `c${i}`,
    fetchedAt: new Date(now - i * 60_000).toISOString(),
  }));
  const kept = evictWindow(items, now, { cap: 3 });
  assert.deepEqual(
    kept.map((item) => item.id),
    ['c0', 'c1', 'c2'],
  );
});

test('evictWindow defaults match the 48h/500 register bounds', () => {
  assert.equal(CLAIM_WINDOW_MS, 48 * 60 * 60 * 1000);
  assert.equal(CLAIM_CAP, 500);
});

const shapeCategories = ['triangle', 'orb', 'cigar'];
const candidate = {
  id: 'reddit:abc123',
  url: 'https://www.reddit.com/r/UFOs/comments/abc123/x/',
  source: 'reddit',
  fetchedAt: '2026-09-27T12:00:00.000Z',
  // Extra field a caller must never let leak into the stored claim.
  text: 'the original post body, never stored',
};

test('validateClassified produces exactly the nine stored-claim fields, nothing else', () => {
  const claim = validateClassified(
    candidate,
    {
      sighting: true,
      place: 'Austin, Texas, United States',
      lat: 30.2672,
      lon: -97.7431,
      shape: 'triangle',
      when: '2026-09-26T22:00:00.000Z',
    },
    shapeCategories,
  );
  assert.deepEqual(Object.keys(claim).sort(), [...CLAIM_FIELDS].sort());
  assert.equal(claim.id, 'reddit:abc123');
  assert.equal(claim.source, 'reddit');
  assert.equal(claim.lat, 30.2672);
  assert.equal(claim.lon, -97.7431);
  assert.equal(claim.place, 'Austin, Texas, United States');
  assert.equal(claim.shape, 'triangle');
  assert.equal(claim.when, '2026-09-26T22:00:00.000Z');
  assert.equal(claim.fetchedAt, '2026-09-27T12:00:00.000Z');
  assert.equal(JSON.stringify(claim).includes('never stored'), false);
});

test('validateClassified drops non-sightings', () => {
  assert.equal(
    validateClassified(
      candidate,
      { sighting: false, place: 'Austin', lat: 30, lon: -97 },
      shapeCategories,
    ),
    null,
  );
  assert.equal(validateClassified(candidate, {}, shapeCategories), null);
  assert.equal(validateClassified(candidate, null, shapeCategories), null);
});

test('validateClassified enforces lat/lon sanity bounds', () => {
  const base = { sighting: true, place: 'Somewhere' };
  assert.equal(
    validateClassified(
      candidate,
      { ...base, lat: 91, lon: 0 },
      shapeCategories,
    ),
    null,
  );
  assert.equal(
    validateClassified(
      candidate,
      { ...base, lat: 0, lon: 181 },
      shapeCategories,
    ),
    null,
  );
  assert.equal(
    validateClassified(
      candidate,
      { ...base, lat: 'not-a-number', lon: 0 },
      shapeCategories,
    ),
    null,
  );
});

test('validateClassified requires a non-empty place', () => {
  assert.equal(
    validateClassified(
      candidate,
      { sighting: true, place: null, lat: 0, lon: 0 },
      shapeCategories,
    ),
    null,
  );
  assert.equal(
    validateClassified(
      candidate,
      { sighting: true, place: '   ', lat: 0, lon: 0 },
      shapeCategories,
    ),
    null,
  );
});

test('validateClassified falls back shape and when to null when not recognised', () => {
  const claim = validateClassified(
    candidate,
    {
      sighting: true,
      place: 'Austin',
      lat: 30,
      lon: -97,
      shape: 'flying-teapot',
      when: 'not a date',
    },
    shapeCategories,
  );
  assert.equal(claim.shape, null);
  assert.equal(claim.when, null);
});

test('loadShapeCategories reads the bundled craft manifest and pins known archetypes', () => {
  const categories = loadShapeCategories();
  assert.ok(Array.isArray(categories));
  assert.ok(categories.length > 10);
  assert.ok(categories.includes('triangle'));
  assert.ok(categories.includes('orb'));
  assert.ok(categories.includes('tic-tac'));
});

test('loadShapeCategories falls back to the pinned list when the manifest is unreadable', () => {
  const categories = loadShapeCategories({ sourceRoot: '/nonexistent-root' });
  assert.deepEqual(categories, FALLBACK_SHAPE_CATEGORIES);
});

/** Swap console.warn for the duration of `fn`, returning its captured
 * calls (each an argument array) alongside `fn`'s own return value. Always
 * restores the original console.warn, even if `fn` throws. */
async function captureWarnings(fn) {
  const calls = [];
  const original = console.warn;
  console.warn = (...args) => calls.push(args);
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    console.warn = original;
  }
}

test('classifyWithRetryLimit drops a poisoned post after exactly three failed attempts and never retries it again', async () => {
  assert.equal(MAX_CLASSIFY_ATTEMPTS, 3);
  const retryCounts = new Map();
  const candidates = [
    { id: 'reddit:poison', url: 'https://reddit.com/poison', source: 'reddit' },
  ];
  // A classifier stub that always throws, mirroring classifyBatch's own
  // deepseek_malformed_json case (a fixed message, never a snippet of raw
  // classifier output). Each attempt is awaited, and its effect on
  // `retryCounts` checked, before the next one runs: the map is mutated in
  // place, so checking it only after all three calls would just see its
  // final, post-give-up state.
  const classify = async () => {
    throw new Error('deepseek_malformed_json');
  };

  const { result: first, calls: warnings1 } = await captureWarnings(() =>
    classifyWithRetryLimit(candidates, classify, retryCounts),
  );
  assert.equal(first.failed, true);
  assert.deepEqual(first.gaveUp, []);
  assert.equal(retryCounts.get('reddit:poison'), 1);
  assert.equal(
    warnings1.some((args) => String(args[0]).includes('deepseek_gave_up')),
    false,
    'the first failed attempt never gives up',
  );

  const { result: second, calls: warnings2 } = await captureWarnings(() =>
    classifyWithRetryLimit(candidates, classify, retryCounts),
  );
  assert.equal(second.failed, true);
  assert.deepEqual(second.gaveUp, []);
  assert.equal(retryCounts.get('reddit:poison'), 2);
  assert.equal(
    warnings2.some((args) => String(args[0]).includes('deepseek_gave_up')),
    false,
    'the second failed attempt never gives up either',
  );

  const { result: third, calls: warnings3 } = await captureWarnings(() =>
    classifyWithRetryLimit(candidates, classify, retryCounts),
  );
  assert.equal(third.failed, true);
  assert.deepEqual(
    third.gaveUp,
    ['reddit:poison'],
    'gives up on exactly the third attempt (MAX_CLASSIFY_ATTEMPTS)',
  );
  assert.equal(
    retryCounts.has('reddit:poison'),
    false,
    'the retry count is cleared once given up, so a caller adding this id back in never retries it starting mid-count',
  );
  const giveUpWarnings = warnings3.filter((args) =>
    String(args[0]).includes('deepseek_gave_up'),
  );
  assert.equal(
    giveUpWarnings.length,
    1,
    'exactly one deepseek_gave_up warning, on the attempt that actually gives up',
  );
  assert.deepEqual(
    giveUpWarnings[0],
    [
      '[claims-proxy] deepseek_gave_up:',
      'reddit:poison',
      'after',
      3,
      'attempts',
    ],
    'the give-up warning carries only the id and the attempt count, never the classifier text',
  );
});

test('classifyWithRetryLimit classifies normally once the stub recovers on a later attempt, and resets the retry count on success', async () => {
  const retryCounts = new Map();
  const candidates = [
    { id: 'bluesky:paris', url: 'https://bsky.app/paris', source: 'bluesky' },
  ];
  let attempts = 0;
  const classify = async (batch) => {
    attempts++;
    if (attempts === 1) throw new Error('deepseek_upstream_500');
    return new Map(
      batch.map((c) => [
        c.id,
        {
          sighting: true,
          place: 'Paris, France',
          lat: 48.8566,
          lon: 2.3522,
          shape: null,
          when: null,
        },
      ]),
    );
  };

  const first = await classifyWithRetryLimit(candidates, classify, retryCounts);
  assert.equal(first.failed, true);
  assert.deepEqual(first.gaveUp, []);
  assert.equal(retryCounts.get('bluesky:paris'), 1);

  const second = await classifyWithRetryLimit(
    candidates,
    classify,
    retryCounts,
  );
  assert.equal(second.failed, false);
  assert.deepEqual(second.gaveUp, []);
  assert.equal(
    second.classifiedById.get('bluesky:paris')?.place,
    'Paris, France',
  );
  assert.equal(
    retryCounts.has('bluesky:paris'),
    false,
    'a success clears the retry count, so a later transient failure starts counting from zero again',
  );
});
