/**
 * Pure encodings for the ancient-sites layer. Portable: no rendering
 * engine and no browser globals, so this module stays unit-testable.
 */
export const ANCIENT_LAYER_ID = 'ancient-sites';
export const GOLD = '#D8B36A';

/** Analyst record for the voice and analyst surfaces. */
export function mapAnalystRecord(row) {
  return {
    id: row.id,
    name: row.name,
    lat: row.lat,
    lon: row.lon,
    type: row.type,
    period: row.period,
  };
}

/**
 * Analyst record for a worldwide-sweep site. `sweep` is the typed accessor
 * returned by `normalizeAncientSitesV2`; `index` selects the row. Sweep
 * sites carry no `period` (the sweep ships no era column — see
 * `anomaly-atlas-kit/docs/DATA_PIPELINE.md` and the phase 5b task 2 report)
 * and no dossier photo or debate, unlike the curated hero tier.
 */
export function mapSweepAnalystRecord(sweep, index) {
  return {
    id: `sweep:${sweep.qid(index)}`,
    name: sweep.name(index),
    lat: sweep.lat(index),
    lon: sweep.lon(index),
    type: sweep.typeName(index),
    country: sweep.countryName(index),
  };
}

/** Overlay label entry on the shared ambient-label lane, gold register. */
export function createAncientOverlayEntry({ id, position, name }) {
  return {
    id: `ancient:${id}`,
    position,
    variant: 'label',
    title: String(name),
    accent: GOLD,
    priority: 500,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
