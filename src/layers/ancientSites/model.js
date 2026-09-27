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
 * sites carry no `period` (the sweep ships no era column, see
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

/**
 * Sibling overlay source for ambient sweep-name labels (task 3,
 * ancient-legibility): a separate source id from `ANCIENT_LAYER_ID` (the
 * hero labels above) rather than one shared list, so publishing the sweep's
 * names can never disturb the hero tier's own entry count - the hero
 * toggle-survival check pins that count exactly, and the boot camera can
 * land close enough to the ground (city level, `cellDeg === 0`) that a
 * shared list would make the sweep's own, filter-and-camera-dependent
 * label count leak into that fixed number. index.js owns this source's own
 * show/hide and clear lifecycle, mirroring the hero source's (see
 * index.js's init/enable/disable/destroy).
 */
export const ANCIENT_SWEEP_OVERLAY_SOURCE_ID = 'ancient-sites-sweep';

/** Cap on the closest band's view-bounded singles count at which ambient
 * sweep-name labels appear at all (task 3, ancient-legibility): a busier
 * screenful already reads through the glyph billboards alone (see
 * rendering.js), so labels stay absent above this threshold rather than
 * crowding the view - heroes are unaffected either way. */
export const ANCIENT_SWEEP_LABEL_CAP = 30;

/**
 * Overlay label entry for one worldwide-sweep site's name (task 3,
 * ancient-legibility): the same gold register and ambient-label paint lane
 * as `createAncientOverlayEntry` above, published to the sibling
 * `ANCIENT_SWEEP_OVERLAY_SOURCE_ID` source instead. Tuned smaller and
 * dimmer (`presentationScale`, `sourceAlpha` below default 1) and given a
 * lower `priority` than a hero label's 500, so a hero sharing the same
 * screen space always wins the collision arbiter - heroes stay visually
 * primary, sweep names are a quieter, secondary layer of legibility shown
 * only at the closest band with few enough singles on screen (see
 * rendering.js's `onSweepSinglesChange` and index.js's `syncSweepLabels`).
 * Names only, no dating claims: the sweep carries no per-site period.
 */
export function createAncientSweepOverlayEntry({ id, position, name }) {
  return {
    id: `ancient:sweep:${id}`,
    position,
    variant: 'label',
    title: String(name),
    accent: GOLD,
    priority: 200,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 10,
    verticalOnly: true,
    placement: 'above',
    presentationScale: 0.8,
    sourceAlpha: 0.72,
  };
}
