import fs from 'node:fs';
import path from 'node:path';
import { defaultSourceRoot } from './common/source-root.js';
import { readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter } from '../../src/sources/rateLimit.js';

/**
 * Live claims register (Phenomena's fourth register, see
 * anomaly-atlas-kit/docs and docs/superpowers/specs/2026-09-27-live-claims-design.md).
 * Polls Reddit and Bluesky public search for possible UAP sighting posts,
 * gates each new post through the DeepSeek chat API to decide whether it is
 * a genuine sighting and, if so, where and what shape it describes, then
 * serves a bounded, ephemeral in-memory window at GET /api/claims.
 *
 * Post text and any author identifier are read only long enough to build the
 * classifier request; the stored claim keeps exactly nine fields (see
 * `CLAIM_FIELDS`) and nothing else ever reaches disk, a log line or the
 * response body.
 *
 * Keyless (no DEEPSEEK_API_KEY): the endpoint returns
 * { claims: [], status: 'no-key', unplaced: 0 } and never touches the
 * network or the classifier.
 *
 * Fixture mode (GEV_CLAIMS_FIXTURE=1): the endpoint serves
 * `buildFixtureClaims()`'s canned, clearly fictional claims, bypassing both
 * the feeds and the classifier, so QA stays deterministic and keyless.
 *
 * Polling: on-demand fetch with a 2-minute cache, single-flight (the
 * simplest shape that stays inside the "at most every 2 minutes per feed"
 * bound). A request within the cache window is served from memory; a
 * request after it triggers one poll that concurrent requests join rather
 * than duplicate.
 */

/** Ephemeral window bounds for the served register (see the design spec). */
export const CLAIM_WINDOW_MS = 48 * 60 * 60 * 1000;
export const CLAIM_CAP = 500;

/** How many times a single post may fail classification before it is given
 * up on (marked considered/dropped without ever being classified), so a
 * persistently malformed or failing batch cannot retry the same post
 * forever (see `classifyWithRetryLimit`). */
export const MAX_CLASSIFY_ATTEMPTS = 3;

/** Exactly the fields a stored claim may carry. */
export const CLAIM_FIELDS = Object.freeze([
  'id',
  'url',
  'source',
  'lat',
  'lon',
  'place',
  'shape',
  'when',
  'fetchedAt',
]);

/** Repository-relative path to the bundled craft manifest (see anomaly-atlas-kit/docs/DATA_PIPELINE.md). */
const CRAFT_MANIFEST_PATH = 'public/anomalies/crafts/manifest.json';

/**
 * Pinned fallback used only if the bundled manifest cannot be read (for
 * example a checkout missing public/ assets). Kept in sync with
 * public/anomalies/crafts/manifest.json's craft ids.
 */
export const FALLBACK_SHAPE_CATEGORIES = Object.freeze([
  'domed-disc',
  'lens-disc',
  'ringed-disc',
  'bell',
  'hat',
  'spinning-top',
  'pyramid',
  'cigar',
  'tic-tac',
  'egg',
  'torus',
  'orb',
  'orb-trio',
  'orb-swarm',
  'flaring-orb',
  'cold-pair',
  'triangle',
  'boomerang',
  'crescent',
  'tetrahedron',
  'diamond',
  'slab',
  'wedge',
  'light-v',
  'light-arc',
  'fireball',
  'spiral',
  'jellyfish',
  'lander',
  'manta',
]);

const shapeCategoryCache = new Map();

/**
 * Read the anomaly craft archetype ids from the bundled manifest, pinning
 * the exact list the classifier is allowed to choose a `shape` from. Cached
 * per `sourceRoot` so a poll never re-reads the file. Falls back to
 * `FALLBACK_SHAPE_CATEGORIES` if the manifest is missing or malformed.
 *
 * @param {{sourceRoot?: string}} [options]
 * @returns {string[]}
 */
export function loadShapeCategories({ sourceRoot = defaultSourceRoot } = {}) {
  if (shapeCategoryCache.has(sourceRoot))
    return shapeCategoryCache.get(sourceRoot);
  let categories = FALLBACK_SHAPE_CATEGORIES;
  try {
    const raw = fs.readFileSync(
      path.join(sourceRoot, CRAFT_MANIFEST_PATH),
      'utf8',
    );
    const parsed = JSON.parse(raw);
    const ids = Array.isArray(parsed?.crafts)
      ? parsed.crafts
          .map((craft) => craft?.id)
          .filter((id) => typeof id === 'string' && id)
      : [];
    if (ids.length) categories = ids;
  } catch {
    categories = FALLBACK_SHAPE_CATEGORIES;
  }
  shapeCategoryCache.set(sourceRoot, categories);
  return categories;
}

const REDDIT_ID_PATTERN = /^[A-Za-z0-9_]{1,16}$/;

/**
 * Map one Reddit Listing child (from `/r/<sub>/new.json`) to a
 * classification candidate. `text` (title + body) exists only for the
 * classifier call; the caller must discard it once classification returns.
 *
 * @param {*} child - one entry of `data.children` in a Reddit Listing response.
 * @returns {{id: string, url: string, source: 'reddit', text: string, when: string}|null}
 */
export function redditRowToCandidate(child) {
  const data = child?.data;
  if (!data || typeof data.id !== 'string' || !REDDIT_ID_PATTERN.test(data.id))
    return null;
  if (typeof data.permalink !== 'string' || !data.permalink.startsWith('/'))
    return null;
  const createdUtc = Number(data.created_utc);
  if (!Number.isFinite(createdUtc) || createdUtc <= 0) return null;
  const title = typeof data.title === 'string' ? data.title : '';
  const body = typeof data.selftext === 'string' ? data.selftext : '';
  const text = [title, body]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);
  if (!text) return null;
  return {
    id: `reddit:${data.id}`,
    url: `https://www.reddit.com${data.permalink}`,
    source: 'reddit',
    text,
    when: new Date(createdUtc * 1000).toISOString(),
  };
}

const BLUESKY_POST_URI =
  /^at:\/\/(did:[a-zA-Z0-9._:%-]+)\/app\.bsky\.feed\.post\/([a-zA-Z0-9._-]{1,64})$/;

/**
 * Map one Bluesky `app.bsky.feed.searchPosts` result to a classification
 * candidate. Only the DID embedded in the post's own `at://` uri is used to
 * build the id (globally unique, `did:rkey`) and the link-out url; the
 * author's handle and display name are never read, so they cannot leak
 * even if present on the input row.
 *
 * @param {*} post - one entry of `posts` from app.bsky.feed.searchPosts.
 * @returns {{id: string, url: string, source: 'bluesky', text: string, when: string}|null}
 */
export function blueskyRowToCandidate(post) {
  const match =
    typeof post?.uri === 'string' ? post.uri.match(BLUESKY_POST_URI) : null;
  if (!match) return null;
  const [, did, rkey] = match;
  const rawText = post?.record?.text;
  const text = typeof rawText === 'string' ? rawText.trim().slice(0, 4000) : '';
  if (!text) return null;
  const createdAt = post?.record?.createdAt;
  const parsed = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
  const when = Number.isFinite(parsed)
    ? new Date(parsed).toISOString()
    : new Date().toISOString();
  return {
    // The did:rkey pair is what Bluesky itself treats as globally unique;
    // the rkey alone is only unique per-author.
    id: `bluesky:${did}:${rkey}`,
    url: `https://bsky.app/profile/${did}/post/${rkey}`,
    source: 'bluesky',
    text,
    when,
  };
}

/**
 * Drop candidates whose id repeats earlier in the batch or already appears
 * in `knownIds`. Pure: neither `candidates` nor `knownIds` is mutated.
 *
 * @param {Array<{id: string}>} candidates
 * @param {Set<string>|Iterable<string>} [knownIds]
 * @returns {{fresh: Array<object>, seen: Set<string>}}
 */
export function dedupeById(candidates, knownIds = []) {
  const seen = new Set(knownIds);
  const fresh = [];
  for (const candidate of candidates) {
    if (
      !candidate ||
      typeof candidate.id !== 'string' ||
      seen.has(candidate.id)
    )
      continue;
    seen.add(candidate.id);
    fresh.push(candidate);
  }
  return { fresh, seen };
}

/**
 * Age a list of `{fetchedAt}` records out of the ephemeral window and cap
 * the remainder at `cap`, newest first. Used both for the served claims
 * store (48 h / 500) and, with a larger cap, for the internal dedupe-id
 * ledger.
 *
 * @param {Array<{fetchedAt: string}>} items
 * @param {number} now - epoch ms.
 * @param {{windowMs?: number, cap?: number}} [options]
 * @returns {Array<object>}
 */
export function evictWindow(
  items,
  now,
  { windowMs = CLAIM_WINDOW_MS, cap = CLAIM_CAP } = {},
) {
  return items
    .filter((item) => {
      const at = Date.parse(item?.fetchedAt);
      return Number.isFinite(at) && at <= now && now - at <= windowMs;
    })
    .sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))
    .slice(0, cap);
}

const WHEN_PATTERN =
  /^\d{4}-\d{2}(-\d{2})?(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** True if `value` contains any ASCII control character (codes below 0x20). */
function hasControlCharacter(value) {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

/**
 * Validate one classifier result against its source candidate and produce
 * the exact stored-claim shape: `id`, `url`, `source`, `lat`, `lon`,
 * `place`, `shape`, `when`, `fetchedAt`, nothing else, regardless of what
 * extra fields `candidate` or `classified` carry (post text included).
 * Returns null when the post is not a sighting, or when it is one but the
 * placement fails the sanity bounds; the caller decides whether the latter
 * counts towards the honest "unplaced" total.
 *
 * @param {{id: string, url: string, source: 'reddit'|'bluesky', fetchedAt: string}} candidate
 * @param {*} classified - raw classifier JSON for this candidate.
 * @param {string[]} shapeCategories - the pinned archetype ids offered to the classifier.
 * @returns {?{id: string, url: string, source: string, lat: number, lon: number, place: string, shape: ?string, when: ?string, fetchedAt: string}}
 */
export function validateClassified(candidate, classified, shapeCategories) {
  if (!candidate || !classified || classified.sighting !== true) return null;
  const lat = Number(classified.lat);
  const lon = Number(classified.lon);
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) return null;
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) return null;
  const place =
    typeof classified.place === 'string' ? classified.place.trim() : '';
  if (!place || place.length > 120 || hasControlCharacter(place)) return null;
  const shape =
    typeof classified.shape === 'string' &&
    shapeCategories.includes(classified.shape)
      ? classified.shape
      : null;
  const when =
    typeof classified.when === 'string' &&
    WHEN_PATTERN.test(classified.when.trim())
      ? classified.when.trim()
      : null;
  return {
    id: candidate.id,
    url: candidate.url,
    source: candidate.source,
    lat,
    lon,
    place,
    shape,
    when,
    fetchedAt: candidate.fetchedAt,
  };
}

/**
 * Build ~9 clearly fictional claims spread across the 48 h window so
 * age-driven brightness ramps show, plus a fixed unplaced count. Used only
 * when GEV_CLAIMS_FIXTURE=1; never mixed with live data.
 *
 * The Paris entry sits at a real French location, deliberately near the
 * GEIPAN case mass the bundled `anomalies.v1.json` carries, so the
 * dossier's nearby-cases block (`src/layers/liveClaims/nearby.js`) has a
 * genuine nonzero result to render against real data; every other claim
 * sits far enough from that France-heavy dataset to keep the honest
 * zero-case path live too (see `scripts/qa-claims.mjs`, which proves both
 * branches).
 *
 * The Paris entry's `fetchedAt` (5 h ago) is deliberately out of step with
 * its position at the end of this array (which otherwise lists the other
 * eight claims oldest-last): this makes the array's own order NOT the
 * newest-first order, so a stream ticker that renders claims as given,
 * without sorting them by `fetchedAt` itself, would show them in the wrong
 * order. That keeps the ticker's own sort genuinely load-bearing rather
 * than a no-op over pre-ordered fixture data.
 *
 * @param {number} [now] - epoch ms.
 * @returns {{claims: Array<object>, unplaced: number}}
 */
export function buildFixtureClaims(now = Date.now()) {
  const ago = (hours) => new Date(now - hours * 3600_000).toISOString();
  const claims = [
    {
      id: 'reddit:fixture-newyork',
      url: 'https://example.com/reddit/fixture-newyork',
      source: 'reddit',
      lat: 40.7128,
      lon: -74.006,
      place: 'New York City, New York, United States',
      shape: 'triangle',
      when: null,
      fetchedAt: ago(0.1),
    },
    {
      id: 'bluesky:fixture-london',
      url: 'https://example.com/bluesky/fixture-london',
      source: 'bluesky',
      lat: 51.5074,
      lon: -0.1278,
      place: 'London, United Kingdom',
      shape: 'orb',
      when: ago(0.75),
      fetchedAt: ago(0.75),
    },
    {
      id: 'reddit:fixture-tokyo',
      url: 'https://example.com/reddit/fixture-tokyo',
      source: 'reddit',
      lat: 35.6762,
      lon: 139.6503,
      place: 'Tokyo, Japan',
      shape: 'tic-tac',
      when: null,
      fetchedAt: ago(3),
    },
    {
      id: 'bluesky:fixture-sydney',
      url: 'https://example.com/bluesky/fixture-sydney',
      source: 'bluesky',
      lat: -33.8688,
      lon: 151.2093,
      place: 'Sydney, Australia',
      shape: 'cigar',
      when: ago(8),
      fetchedAt: ago(8),
    },
    {
      id: 'reddit:fixture-mexicocity',
      url: 'https://example.com/reddit/fixture-mexicocity',
      source: 'reddit',
      lat: 19.4326,
      lon: -99.1332,
      place: 'Mexico City, Mexico',
      shape: 'orb-trio',
      when: null,
      fetchedAt: ago(14),
    },
    {
      id: 'bluesky:fixture-pacific-north',
      url: 'https://example.com/bluesky/fixture-pacific-north',
      source: 'bluesky',
      lat: 12.5,
      lon: -155.0,
      place: 'Open Pacific Ocean',
      shape: 'light-v',
      when: ago(20),
      fetchedAt: ago(20),
    },
    {
      id: 'reddit:fixture-moscow',
      url: 'https://example.com/reddit/fixture-moscow',
      source: 'reddit',
      lat: 55.7558,
      lon: 37.6173,
      place: 'Moscow, Russia',
      shape: 'diamond',
      when: ago(30),
      fetchedAt: ago(30),
    },
    {
      id: 'bluesky:fixture-pacific-south',
      url: 'https://example.com/bluesky/fixture-pacific-south',
      source: 'bluesky',
      lat: -14.0,
      lon: -170.0,
      place: 'Open Pacific Ocean',
      shape: null,
      when: null,
      fetchedAt: ago(40),
    },
    {
      id: 'reddit:fixture-paris',
      url: 'https://example.com/reddit/fixture-paris',
      source: 'reddit',
      lat: 48.8566,
      lon: 2.3522,
      place: 'Paris, France',
      shape: 'boomerang',
      when: null,
      // Deliberately out of age order against this array's own position
      // (see the function's doc comment): chronologically this sits
      // between the Tokyo and Sydney entries above, not after Pacific
      // South.
      fetchedAt: ago(5),
    },
  ];
  return { claims, unplaced: 2 };
}

const REDDIT_SUBREDDITS = ['UFOs', 'HighStrangeness', 'aliens'];
const BLUESKY_QUERY = 'ufo sighting';
const FEED_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 (Phenomena live claims register; polite polling, see docs/superpowers/specs/2026-09-27-live-claims-design.md)';
const FEED_MAX_RESPONSE_BYTES = 512 * 1024;

/** Fetch and flatten candidates from the configured subreddits (best-effort per subreddit). */
async function fetchRedditCandidates(fetchImpl, signal) {
  const results = await Promise.allSettled(
    REDDIT_SUBREDDITS.map(async (sub) => {
      const response = await fetchImpl(
        `https://www.reddit.com/r/${sub}/new.json?limit=25`,
        {
          signal,
          redirect: 'error',
          headers: {
            'User-Agent': FEED_USER_AGENT,
            Accept: 'application/json',
          },
        },
      );
      if (!response.ok) throw new Error(`reddit_upstream_${response.status}`);
      const body = await readResponseJsonCapped(
        response,
        FEED_MAX_RESPONSE_BYTES,
        signal,
      );
      const children = Array.isArray(body?.data?.children)
        ? body.data.children
        : [];
      return children.map(redditRowToCandidate).filter(Boolean);
    }),
  );
  return results.flatMap((result) =>
    result.status === 'fulfilled' ? result.value : [],
  );
}

/** Fetch and map Bluesky search-post candidates (best-effort: an error yields none). */
async function fetchBlueskyCandidates(fetchImpl, signal) {
  try {
    const response = await fetchImpl(
      `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(BLUESKY_QUERY)}&limit=25`,
      {
        signal,
        redirect: 'error',
        headers: { 'User-Agent': FEED_USER_AGENT, Accept: 'application/json' },
      },
    );
    if (!response.ok) throw new Error(`bluesky_upstream_${response.status}`);
    const body = await readResponseJsonCapped(
      response,
      FEED_MAX_RESPONSE_BYTES,
      signal,
    );
    const posts = Array.isArray(body?.posts) ? body.posts : [];
    return posts.map(blueskyRowToCandidate).filter(Boolean);
  } catch {
    return [];
  }
}

const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const CLASSIFIER_MAX_RESPONSE_BYTES = 256 * 1024;

/** The classifier's system prompt, with the pinned shape categories inlined. */
function buildClassifierPrompt(shapeCategories) {
  return [
    'You triage public social media posts for a UAP sighting register.',
    'For each post decide whether it genuinely describes a first-hand or reported sighting of an unidentified aerial phenomenon happening now or recently, as opposed to news round-ups, jokes, merchandise, memes or meta-discussion.',
    'Reply with strict JSON only, no commentary, shaped exactly as {"results":[{"id":"<the input id, unchanged>","sighting":true|false,"place":"<place name>"|null,"lat":<number>|null,"lon":<number>|null,"shape":"<one category>"|null,"when":"<ISO 8601 date or date-time>"|null}, ...]}.',
    'Return exactly one result per input id; the order does not matter but every id must appear once.',
    'When sighting is false, the other fields may be null.',
    'When sighting is true: place is the most specific place name stated or clearly implied by the text (city, region or landmark); lat and lon are your best-guess decimal degree coordinates for that place; if you cannot confidently name a real place, set place, lat and lon to null so the claim is counted as unplaced rather than misplaced.',
    `shape must be exactly one of: ${shapeCategories.join(', ')}. Use null if the description does not clearly match one of these.`,
    'when is the date or time the sighting is reported to have happened, in ISO 8601 form (a date, or a date and time); use null if the post does not state one.',
  ].join(' ');
}

/**
 * One batched DeepSeek chat-completions call classifying several candidates
 * at once (OpenAI-compatible chat/completions shape). Only `id` and `text`
 * leave the process in the request; the caller discards `text` as soon as
 * this returns.
 *
 * @returns {Promise<Map<string, object>>} classifier results keyed by candidate id.
 */
async function classifyBatch(
  candidates,
  { fetchImpl, apiKey, model, shapeCategories, signal, timeoutMs },
) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: buildClassifierPrompt(shapeCategories) },
          {
            role: 'user',
            content: JSON.stringify(
              candidates.map((c) => ({ id: c.id, text: c.text })),
            ),
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(`deepseek_upstream_${response.status}`);
    }
    const body = await readResponseJsonCapped(
      response,
      CLASSIFIER_MAX_RESPONSE_BYTES,
      controller.signal,
    );
    const content = body?.choices?.[0]?.message?.content;
    let parsed = null;
    if (typeof content === 'string') {
      try {
        parsed = JSON.parse(content);
      } catch {
        // Never let a malformed-JSON SyntaxError carry a snippet of the
        // classifier's raw output to console.warn (some JSON.parse
        // implementations quote nearby input in the error message): a
        // fixed message only. The batch stays un-considered and the next
        // poll retries it, same as any other classifier failure.
        throw new Error('deepseek_malformed_json');
      }
    }
    const results = Array.isArray(parsed?.results) ? parsed.results : [];
    const byId = new Map();
    for (const item of results) {
      if (item && typeof item.id === 'string' && !byId.has(item.id))
        byId.set(item.id, item);
    }
    return byId;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Bound on how many distinct post ids `classifyWithRetryLimit` tracks a
 * retry count for at once, the same "bounded, in-memory" shape as
 * `state.considered`'s own `CONSIDERED_CAP`: a post that fails once or
 * twice and then simply never reappears in a later feed poll must not hold
 * its count forever. Eviction is oldest-tracked-first, not a strict LRU;
 * good enough for a soft memory bound on a best-effort retry counter. */
const RETRY_TRACK_CAP = 5000;

/**
 * Classify one batch of fresh candidates via `classify`, tracking each
 * post's consecutive-failure count across calls in the caller-owned
 * `retryCounts` map (bounded to `RETRY_TRACK_CAP` ids). Guards against a
 * persistently malformed or failing classifier batch retrying the same
 * post forever (the `deepseek_malformed_json` case in `classifyBatch`,
 * or any other rejection): once a post's count reaches
 * `MAX_CLASSIFY_ATTEMPTS`, it is reported back in `gaveUp` (so the caller
 * can mark it considered/dropped, never retried again) and its count is
 * cleared, with exactly one `console.warn('deepseek_gave_up', ...)` per
 * post that gives up, carrying only its id and the attempt count - never
 * the classifier's raw response. A post below the limit is left off
 * `gaveUp` so the caller can leave it un-considered and retry it next
 * poll, same as before this guard existed. A successful `classify` call
 * clears every one of `candidates`' retry counts (a later transient
 * failure starts counting from zero again) and never rejects: this
 * function always resolves, so a classifier or network failure never
 * surfaces past it.
 *
 * @param {Array<{id: string}>} candidates
 * @param {(candidates: Array<{id: string}>) => Promise<Map<string, object>>} classify
 * @param {Map<string, number>} retryCounts
 * @returns {Promise<{classifiedById: Map<string, object>, gaveUp: string[], failed: boolean}>}
 */
export async function classifyWithRetryLimit(
  candidates,
  classify,
  retryCounts,
) {
  try {
    const classifiedById = await classify(candidates);
    for (const item of candidates) retryCounts.delete(item.id);
    return { classifiedById, gaveUp: [], failed: false };
  } catch (error) {
    // Never let a malformed-JSON or upstream error carry a snippet of the
    // classifier's raw output to console.warn: a fixed message plus the
    // thrown Error's own message only (classifyBatch's errors are already
    // fixed strings such as deepseek_malformed_json or
    // deepseek_upstream_<status>, never raw content).
    console.warn(
      '[claims-proxy] classifier call failed:',
      error?.message || error,
    );
    const gaveUp = [];
    for (const item of candidates) {
      const attempts = (retryCounts.get(item.id) || 0) + 1;
      if (attempts >= MAX_CLASSIFY_ATTEMPTS) {
        retryCounts.delete(item.id);
        gaveUp.push(item.id);
        console.warn(
          '[claims-proxy] deepseek_gave_up:',
          item.id,
          'after',
          attempts,
          'attempts',
        );
      } else {
        retryCounts.set(item.id, attempts);
        if (retryCounts.size > RETRY_TRACK_CAP) {
          const oldest = retryCounts.keys().next().value;
          if (oldest !== undefined) retryCounts.delete(oldest);
        }
      }
    }
    return { classifiedById: new Map(), gaveUp, failed: true };
  }
}

const DEFAULT_DEEPSEEK_RATE_PER_MIN = 20;
let deepseekLimiter;

/** Global (not per-IP) throttle on outbound DeepSeek calls; defaults to 20/min, unlike the opt-in-unlimited GEV_RATELIMIT_* convention, because this one guards a metered upstream even in the default configuration. */
function classifierRateLimiter() {
  if (deepseekLimiter === undefined) {
    const configured = Number(process.env.GEV_RATELIMIT_DEEPSEEK_PER_MIN);
    const max =
      Number.isFinite(configured) && configured > 0
        ? Math.floor(configured)
        : DEFAULT_DEEPSEEK_RATE_PER_MIN;
    deepseekLimiter = makeRateLimiter({
      windowMs: 60_000,
      max,
      globalMax: max,
    });
  }
  return deepseekLimiter;
}

const POLL_INTERVAL_MS = 2 * 60_000;
const CONSIDERED_CAP = 5000;

/**
 * Construct the live claims register plugin: polls Reddit and Bluesky,
 * classifies new posts through DeepSeek, and serves the bounded window at
 * GET /api/claims. See the module doc comment for the keyless and fixture
 * short-circuits.
 *
 * @param {{fetchImpl?: typeof fetch, now?: () => number, sourceRoot?: string, pollIntervalMs?: number, timeoutMs?: number}} [options]
 * @returns {import('vite').Plugin}
 */
export function claimsProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  sourceRoot = defaultSourceRoot,
  pollIntervalMs = POLL_INTERVAL_MS,
  timeoutMs = 15_000,
} = {}) {
  /** @type {{claims: Array<object>, considered: Array<{id: string, fetchedAt: string}>, unplacedAt: number[], lastPollAt: number, retryCounts: Map<string, number>}} */
  const state = {
    claims: [],
    considered: [],
    unplacedAt: [],
    lastPollAt: -Infinity,
    // Per-post classification-failure counts, bounded per
    // classifyWithRetryLimit's own RETRY_TRACK_CAP; see that function's doc
    // comment for the give-up guard this backs.
    retryCounts: new Map(),
  };
  let inflight = null;

  const apiKey = () => String(process.env.DEEPSEEK_API_KEY || '').trim();
  const model = () =>
    String(process.env.DEEPSEEK_MODEL || '').trim() || 'deepseek-chat';
  const fixtureMode = () => process.env.GEV_CLAIMS_FIXTURE === '1';

  async function poll(signal) {
    const nowMs = now();
    const shapeCategories = loadShapeCategories({ sourceRoot });
    const [redditCandidates, blueskyCandidates] = await Promise.all([
      fetchRedditCandidates(fetchImpl, signal).catch(() => []),
      fetchBlueskyCandidates(fetchImpl, signal).catch(() => []),
    ]);
    const { fresh } = dedupeById(
      [...redditCandidates, ...blueskyCandidates],
      state.considered.map((entry) => entry.id),
    );
    if (fresh.length && classifierRateLimiter()('deepseek')) {
      try {
        const { classifiedById, gaveUp, failed } = await classifyWithRetryLimit(
          fresh,
          (batch) =>
            classifyBatch(batch, {
              fetchImpl,
              apiKey: apiKey(),
              model: model(),
              shapeCategories,
              signal,
              timeoutMs,
            }),
          state.retryCounts,
        );
        const fetchedAt = new Date(nowMs).toISOString();
        if (failed) {
          // A poisoned or transiently failing batch: only the posts that
          // have now exhausted MAX_CLASSIFY_ATTEMPTS are dropped (marked
          // considered without ever being classified); every other post in
          // `fresh` is left un-considered, same as before this guard
          // existed, so the next poll retries it.
          for (const id of gaveUp) state.considered.push({ id, fetchedAt });
        } else {
          for (const item of fresh) {
            state.considered.push({ id: item.id, fetchedAt });
            const classified = classifiedById.get(item.id) ?? null;
            const claim = validateClassified(
              { id: item.id, url: item.url, source: item.source, fetchedAt },
              classified,
              shapeCategories,
            );
            if (claim) state.claims.push(claim);
            else if (classified?.sighting === true)
              state.unplacedAt.push(nowMs);
          }
        }
      } catch (error) {
        // classifyWithRetryLimit never rejects for a classifier or network
        // failure (it resolves with failed: true instead); this is a
        // last-resort net for anything else going wrong in the block
        // above, so a bug here still never surfaces to the client.
        console.warn(
          '[claims-proxy] classifier call failed:',
          error?.message || error,
        );
      }
    }
    state.claims = evictWindow(state.claims, nowMs);
    state.considered = evictWindow(state.considered, nowMs, {
      cap: CONSIDERED_CAP,
    });
    state.unplacedAt = state.unplacedAt.filter(
      (at) => nowMs - at <= CLAIM_WINDOW_MS,
    );
    state.lastPollAt = nowMs;
  }

  /** On-demand fetch with a 2-minute cache: a request inside the cache window is served from memory; one after it triggers a single poll that concurrent requests join. */
  async function acquire(signal) {
    if (inflight) {
      await inflight;
      return;
    }
    if (now() - state.lastPollAt < pollIntervalMs) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    inflight = poll(controller.signal)
      .catch((error) => {
        console.warn('[claims-proxy] poll failed:', error?.message || error);
      })
      .finally(() => {
        clearTimeout(timer);
        inflight = null;
      });
    await inflight;
  }

  async function handler(req, res) {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    const json = (status, value) => {
      if (controller.signal.aborted) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== 'GET')
        return json(405, { error: 'method_not_allowed' });
      if (req.url !== '/' && req.url !== '')
        return json(400, { error: 'invalid_claims_query' });
      if (fixtureMode()) {
        const { claims, unplaced } = buildFixtureClaims(now());
        return json(200, { claims, status: 'ok', unplaced });
      }
      if (!apiKey())
        return json(200, { claims: [], status: 'no-key', unplaced: 0 });
      try {
        await acquire(controller.signal);
      } catch (error) {
        console.warn('[claims-proxy] acquire failed:', error?.message || error);
      }
      json(200, {
        claims: state.claims,
        status: 'ok',
        unplaced: state.unplacedAt.length,
      });
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'live-claims-proxy',
    configureServer({ middlewares }) {
      middlewares.use('/api/claims', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/claims', handler);
    },
  };
}
