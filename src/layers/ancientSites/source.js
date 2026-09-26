import { normalizeAncientSitesV2 } from './records.js';

/**
 * Fetch-based source over public/ancient-sites/sites.v2.json: the curated
 * hero tier plus the worldwide sweep. Portable.
 */
export function createAncientSource({ baseUrl = '/ancient-sites/' } = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const res = await fetch(`${baseUrl}sites.v2.json`, { signal });
      if (!res.ok) throw new Error(`Ancient sites fetch failed: ${res.status}`);
      return normalizeAncientSitesV2(await res.json());
    },
  };
}
