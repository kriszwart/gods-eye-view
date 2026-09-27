import { normalizeClaimsSnapshot } from './records.js';

/**
 * Portable source for the live claims register. Fetches the app's own
 * GET /api/claims endpoint (a relative URL): the server owns the DeepSeek
 * key, the feeds and the classifier entirely; the client never sees any of
 * that, and there is no key handling here at all. The endpoint always
 * responds even without a key, via `{status: 'no-key'}` (see
 * server/providers/claims.js).
 */
export function createLiveClaimsSource({
  baseUrl = '/api/claims',
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(baseUrl, { signal });
      if (!response.ok) throw new Error(`Live claims HTTP ${response.status}`);
      const body = await response.json();
      signal?.throwIfAborted();
      const snapshot = normalizeClaimsSnapshot(body);
      if (!snapshot) throw new Error('Malformed live claims response');
      return snapshot;
    },
  };
}
