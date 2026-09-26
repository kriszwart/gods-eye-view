/**
 * Local-only source for The Modern Antiquarian (TMA), a 17,392-row export of
 * megaliths and other ancient sites. TMA's terms permit curation and
 * per-site reference links only, never bulk redistribution (see
 * anomaly-atlas-kit/docs/DATA_PIPELINE.md), so this register never ships:
 * `local_data/` is git-ignored, the dev server only serves the file when
 * `PHENOMENA_LOCAL_TMA` is set (server/providers/local-tma.js), and
 * registering this module's output is gated on the matching
 * `import.meta.env.PHENOMENA_LOCAL_TMA` build-time define in
 * src/layers/ancientSites/index.js and rendering.js, so a flag-off build
 * excludes this module entirely. Portable: no Cesium, no browser globals
 * beyond fetch.
 */

/** Pick-registry id prefix for TMA rows, this register's own namespace
 * alongside `ancient:` and `ancient-cluster:` (see model.js). */
export const TMA_ID_PREFIX = 'tma:';

/** Dev-only path the local server middleware serves the jsonl at. */
export const TMA_LOCAL_URL = '/local-tma/tma-sites.jsonl';

const SITE_ID_PATTERN = /\/site\/(\d+)\//;

/** TMA's own numeric site id from its record URL, or a fallback keyed to the
 * row's position when a URL is missing or does not match (none do today,
 * but the raw export is not a contract). */
function tmaRowId(url, fallbackIndex) {
  const match = typeof url === 'string' ? url.match(SITE_ID_PATTERN) : null;
  return `${TMA_ID_PREFIX}${match ? match[1] : `row-${fallbackIndex}`}`;
}

/**
 * Decode one NDJSON document of TMA rows (`{name, category, lat, lon, url}`
 * per line) into validated rows. A line that fails to parse, or whose
 * coordinates are missing or out of range (the raw export carries a
 * handful of placeholder `lat: 100` rows for sites TMA has no fix for), is
 * skipped rather than failing the whole load: this is a raw scrape, not a
 * curated contract.
 *
 * @param {string} text - Raw NDJSON document text.
 * @returns {Array<{id:string, name:string, category:string, lat:number, lon:number, url:string}>}
 */
export function parseTmaJsonl(text) {
  if (typeof text !== 'string') throw new TypeError('TMA payload must be text');
  const rows = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let raw;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const { name, category, lat, lon, url } = raw || {};
    if (typeof name !== 'string' || !name) continue;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) continue;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) continue;
    rows.push({
      id: tmaRowId(url, i),
      name,
      category: typeof category === 'string' ? category : '',
      lat,
      lon,
      url: typeof url === 'string' ? url : '',
    });
  }
  return rows;
}

/**
 * Fetch-based source over the dev-only local TMA endpoint. Only ever called
 * from behind the layer's own build-time flag check; see the module doc
 * above.
 * @param {{url?: string}} [options]
 * @returns {{getRows(options?: {signal?: AbortSignal}): Promise<object[]>}}
 */
export function createTmaLocalSource({ url = TMA_LOCAL_URL } = {}) {
  return {
    async getRows({ signal } = {}) {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`TMA local fetch failed: ${res.status}`);
      return parseTmaJsonl(await res.text());
    },
  };
}
