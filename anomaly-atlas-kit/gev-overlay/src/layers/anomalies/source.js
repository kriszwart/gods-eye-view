import { normalizeAnomalySnapshot } from './records.js';

/**
 * Portable source for the bundled dataset (public/anomalies/). Swap baseUrl to
 * serve the data from elsewhere. Cases are fetched once, on first dossier open.
 */
export function createAnomalySource({
  baseUrl = '/anomalies/',
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  let cases = null;
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(`${baseUrl}anomalies.v1.json`, { signal });
      if (!response.ok) throw new Error(`Anomalies HTTP ${response.status}`);
      const rows = normalizeAnomalySnapshot(await response.json());
      signal?.throwIfAborted();
      if (!rows) throw new Error('Malformed anomaly dataset');
      return rows;
    },
    async getCases({ signal } = {}) {
      if (cases) return cases;
      const response = await fetchImpl(`${baseUrl}cases.v1.json`, { signal });
      if (!response.ok) throw new Error(`Cases HTTP ${response.status}`);
      const body = await response.json();
      cases = new Map((body.cases || []).map((c) => [c.id, c]));
      return cases;
    },
  };
}
