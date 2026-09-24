import { normalizeAncientSites } from './records.js';

/** Fetch-based source over public/ancient-sites/. Portable. */
export function createAncientSource({ baseUrl = '/ancient-sites/' } = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const res = await fetch(`${baseUrl}sites.v1.json`, { signal });
      if (!res.ok) throw new Error(`Ancient sites fetch failed: ${res.status}`);
      return normalizeAncientSites(await res.json());
    },
  };
}
