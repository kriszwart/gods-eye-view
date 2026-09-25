/**
 * The spotter panel: a live sky-check plate over whatever tracked sources
 * are currently enabled (flights, military aircraft, satellites, and so
 * on). DOM only, no Cesium: a thin, testable shell around the portable
 * `rankCandidates` function in `src/spotter/rank.js`.
 *
 * The panel recomputes on open and whenever "Use map centre" is pressed: it
 * asks `getObservation()` for the current map centre, `getCandidates()` for
 * whatever the tracked layers currently offer, then `rank()`s the two
 * together and shows the top six rows. Every candidate-derived string is
 * written via `textContent`, never interpolated into markup.
 */

/** Compact 16-point compass abbreviations for the bearing column. */
const COMPASS_ABBR = Object.freeze([
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
]);

/** One glyph per candidate kind, matching `src/spotter/rank.js`'s kinds. */
const KIND_GLYPHS = Object.freeze({
  aircraft: '✈', // ✈
  military: '⚔', // ⚔
  satellite: '◎', // ◎
  launch: '▲', // ▲
  lightning: '⚡', // ⚡
});

const ROW_LIMIT = 6;

const EMPTY_TEXT =
  'No match in tracked sources. Tracked sources do not cover everything.';
const NOTE_TEXT =
  'Live sources only. The spotter cannot answer about past sightings.';

/**
 * Compass point (16-point rose) matching a true bearing, abbreviated.
 * @param {number} bearing degrees, 0-360
 * @returns {string}
 */
function compassAbbr(bearing) {
  const index = Math.round(bearing / 22.5) % COMPASS_ABBR.length;
  return COMPASS_ABBR[index];
}

/**
 * Build the spotter panel and own its `.uap-spotter` plate.
 * @param {{
 *   getObservation: () => ({lat: number, lon: number}|null),
 *   getCandidates: () => Array<Object>,
 *   rank: (observation: Object, candidates: Array<Object>) => Array<Object>,
 *   container: HTMLElement,
 * }} deps
 * @returns {{toggle: () => boolean, close: () => void, isOpen: () => boolean, destroy: () => void}}
 */
export function createSpotter({
  getObservation,
  getCandidates,
  rank,
  container,
}) {
  const root = document.createElement('section');
  root.className = 'uap-spotter';
  root.hidden = true;
  root.setAttribute('aria-label', 'Spotter');

  const head = document.createElement('div');
  head.className = 'uap-spotter-head';
  const title = document.createElement('h2');
  title.textContent = 'Spotter';
  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'uap-spotter-refresh';
  refreshBtn.textContent = 'Use map centre';
  head.append(title, refreshBtn);

  const list = document.createElement('ul');
  list.className = 'uap-spotter-rows';
  list.hidden = true;

  const empty = document.createElement('p');
  empty.className = 'uap-spotter-empty';
  empty.textContent = EMPTY_TEXT;

  const note = document.createElement('p');
  note.className = 'uap-spotter-note';
  note.textContent = NOTE_TEXT;

  root.append(head, list, empty, note);
  (container || document.body).appendChild(root);

  /** Render up to six ranked rows, or the honest empty state. */
  function renderRows(rows) {
    list.replaceChildren();
    const top = (Array.isArray(rows) ? rows : []).slice(0, ROW_LIMIT);
    for (const row of top) {
      const item = document.createElement('li');
      item.className = 'uap-spotter-row';

      const glyph = document.createElement('span');
      glyph.className = 'uap-spotter-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = Object.hasOwn(KIND_GLYPHS, row.kind)
        ? KIND_GLYPHS[row.kind]
        : '•';

      const label = document.createElement('span');
      label.className = 'uap-spotter-label';
      label.textContent = String(row.label || row.id || '');

      const bearing = document.createElement('span');
      bearing.className = 'uap-spotter-bearing';
      bearing.textContent = Number.isFinite(row.bearingDeg)
        ? compassAbbr(row.bearingDeg)
        : '';

      const distance = document.createElement('span');
      distance.className = 'uap-spotter-distance';
      distance.textContent = Number.isFinite(row.distanceKm)
        ? `${Math.round(row.distanceKm)} km`
        : '';

      const why = document.createElement('p');
      why.className = 'uap-spotter-why';
      why.textContent = String(row.why || '');

      item.append(glyph, label, bearing, distance, why);
      list.appendChild(item);
    }
    const hasRows = top.length > 0;
    list.hidden = !hasRows;
    empty.hidden = hasRows;
  }

  /** Recompute the observation, candidates and ranking, then render. */
  function refresh() {
    const observation =
      typeof getObservation === 'function' ? getObservation() : null;
    if (
      !observation ||
      !Number.isFinite(observation.lat) ||
      !Number.isFinite(observation.lon)
    ) {
      renderRows([]);
      return;
    }
    const candidates =
      (typeof getCandidates === 'function' ? getCandidates() : []) || [];
    const rows =
      typeof rank === 'function' ? rank(observation, candidates) : [];
    renderRows(rows);
  }

  refreshBtn.addEventListener('click', refresh);

  return {
    /** Show or hide the plate, refreshing on open. Returns the new open state. */
    toggle() {
      root.hidden = !root.hidden;
      if (!root.hidden) refresh();
      return !root.hidden;
    },
    /**
     * Hide the plate unconditionally. Idempotent: safe to call whether or
     * not it is currently open, so the layer that hosts this panel can
     * always close it on the way out (disable/destroy) without checking
     * state first.
     */
    close() {
      root.hidden = true;
    },
    isOpen() {
      return !root.hidden;
    },
    destroy() {
      root.remove();
    },
  };
}
