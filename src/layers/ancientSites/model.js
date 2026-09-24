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
