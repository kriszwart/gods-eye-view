import { decadeBuckets } from './observatoryModel.js';
import { glyphUrlForType } from '../layers/ancientSites/glyphMap.js';

/**
 * The observatory plate: "the atlas at a glance", a layer-independent shell
 * plate summarising every register at once. DOM only, no Cesium: a thin,
 * testable shell over whatever fetch/getStats functions the caller injects,
 * mirroring src/app/spotter.js's own shape ({toggle, close, isOpen,
 * destroy}) and lifecycle (built lazily on first open, lives for as long as
 * the caller keeps it, destroyed on teardown). Unlike the spotter, most of
 * this plate's data is static shipped datasets rather than live tracked
 * candidates, so the caller's own fetch functions (see
 * src/ui/layerBindings.js) are expected to cache their first successful
 * result: this module calls them on every open and never caches on its own,
 * except the live claims register, whose window genuinely changes over time
 * and so is always read fresh.
 */

/** Sky status keys, in display order, with the same labels the sky
 * register's own status filter chips use (src/layers/anomalies/index.js's
 * STATUS_FILTERS), so the wording matches wherever a visitor has already
 * seen it. */
const STATUS_LABELS = Object.freeze([
  ['explained', 'Explained'],
  ['insufficient', 'Too little data'],
  ['unresolved', 'Unresolved'],
  ['contested', 'Contested'],
]);

/** Human labels for stats.json's bySource ids; an id outside this table
 * falls back to a capitalised copy of itself, so a future source (Blue
 * Book, PURSUE) shows up readably without needing this table updated
 * first. */
const SOURCE_LABELS = Object.freeze({ geipan: 'GEIPAN', sample: 'Sample' });

const FOOTER_TEXT = 'Counts reflect the shipped datasets and the live window.';
const SKY_UNAVAILABLE = 'Sky reports summary unavailable.';
const ANCIENT_UNAVAILABLE = 'Ancient sites summary unavailable.';
const LIVE_UNAVAILABLE = 'Live claims summary unavailable.';
const LIVE_KEYLESS = 'Classifier key not set';
const LIVE_EMPTY = 'No claims in the last 48 hours.';
const DECADES_UNAVAILABLE = 'Decade histogram unavailable.';

const SVG_NS = 'http://www.w3.org/2000/svg';

function sourceLabel(id) {
  return SOURCE_LABELS[id] || String(id).charAt(0).toUpperCase() + id.slice(1);
}

/** Locale-formatted integer, or a literal "?" when the value is not one -
 * an honest placeholder rather than a bare, misleading zero. */
function formatCount(value) {
  return Number.isFinite(value) ? value.toLocaleString('en-GB') : '?';
}

/**
 * Fill the gaps between a sparse bucket list's first and last decade with
 * zero-count entries, so the histogram's bars sit at an even, continuous
 * spacing instead of drifting together across a quiet decade. Presentation
 * only, kept out of observatoryModel.js's portable decadeBuckets: that
 * function reports only decades that actually occurred.
 * @param {Array<{decade: number, count: number}>} buckets
 * @returns {Array<{decade: number, count: number}>}
 */
function fillDecadeRange(buckets) {
  if (!buckets.length) return [];
  const byDecade = new Map(buckets.map((b) => [b.decade, b.count]));
  const min = buckets[0].decade;
  const max = buckets[buckets.length - 1].decade;
  const out = [];
  for (let decade = min; decade <= max; decade += 10) {
    out.push({ decade, count: byDecade.get(decade) || 0 });
  }
  return out;
}

/**
 * Build the small decade histogram: one ion bar per decade on a gold
 * baseline, with a two-digit decade label under each bar and an
 * `aria-label` spelling out every decade and count for assistive tech.
 * @param {Array<{decade: number, count: number}>} buckets Continuous
 *   (gap-filled) decade buckets.
 * @returns {SVGSVGElement}
 */
function buildHistogramSvg(buckets) {
  const width = 280;
  const height = 64;
  const barGap = 3;
  const labelHeight = 12;
  const plotHeight = height - labelHeight;
  const barWidth = (width - barGap * (buckets.length - 1)) / buckets.length;
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'uap-observatory-histogram');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute(
    'aria-label',
    `Sky reports by decade: ${buckets
      .map((b) => `${b.decade}s ${b.count}`)
      .join(', ')}`,
  );

  const baseline = document.createElementNS(SVG_NS, 'line');
  baseline.setAttribute('class', 'uap-observatory-baseline');
  baseline.setAttribute('x1', '0');
  baseline.setAttribute('x2', String(width));
  baseline.setAttribute('y1', String(plotHeight));
  baseline.setAttribute('y2', String(plotHeight));
  svg.appendChild(baseline);

  buckets.forEach((bucket, i) => {
    const barHeight = Math.max(
      bucket.count > 0 ? 1 : 0,
      (bucket.count / maxCount) * (plotHeight - 4),
    );
    const x = i * (barWidth + barGap);
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('class', 'uap-observatory-bar');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(plotHeight - barHeight));
    rect.setAttribute('width', String(barWidth));
    rect.setAttribute('height', String(barHeight));
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = `${bucket.decade}s: ${bucket.count}`;
    rect.appendChild(title);
    svg.appendChild(rect);

    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('class', 'uap-observatory-decade-label');
    label.setAttribute('x', String(x + barWidth / 2));
    label.setAttribute('y', String(height - 1));
    label.setAttribute('text-anchor', 'middle');
    label.textContent = String(bucket.decade % 100).padStart(2, '0');
    svg.appendChild(label);
  });

  return svg;
}

/**
 * Build the observatory plate and own its `.uap-observatory` root.
 * @param {{
 *   fetchSkyStats: () => Promise<{count: number, range?: [number, number],
 *     bySource?: Object<string, number>, byStatus?: Object<string, number>}|null>,
 *   fetchSkyYears: () => Promise<Array<number>>,
 *   fetchAncientStats: () => Promise<{count: number, types: Array<string>,
 *     countries: Array<string>}|null>,
 *   getLiveClaimsStats: () => ({count: number, status: string}|null),
 *   container: HTMLElement,
 *   onClose: () => void,
 * }} deps
 * @returns {{toggle: () => boolean, close: () => void, isOpen: () => boolean, destroy: () => void}}
 */
export function createObservatory({
  fetchSkyStats,
  fetchSkyYears,
  fetchAncientStats,
  getLiveClaimsStats,
  container,
  onClose,
} = {}) {
  const root = document.createElement('section');
  root.className = 'uap-observatory';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Observatory');
  root.tabIndex = -1;

  const head = document.createElement('div');
  head.className = 'uap-observatory-head';
  const title = document.createElement('h2');
  title.textContent = 'Observatory';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'uap-close';
  closeBtn.textContent = 'Close';
  closeBtn.setAttribute('aria-label', 'Close observatory');
  head.append(title, closeBtn);

  const body = document.createElement('div');
  body.className = 'uap-observatory-body';
  const skySection = document.createElement('section');
  skySection.className = 'uap-observatory-section';
  skySection.dataset.register = 'sky';
  const ancientSection = document.createElement('section');
  ancientSection.className = 'uap-observatory-section';
  ancientSection.dataset.register = 'ancient';
  const liveSection = document.createElement('section');
  liveSection.className = 'uap-observatory-section';
  liveSection.dataset.register = 'live';
  const decadeSection = document.createElement('section');
  decadeSection.className = 'uap-observatory-section uap-observatory-decades';
  body.append(skySection, ancientSection, liveSection, decadeSection);

  const footer = document.createElement('p');
  footer.className = 'uap-observatory-footer';
  footer.textContent = FOOTER_TEXT;

  root.append(head, body, footer);

  /** Render the "sky reports" section from a stats.json-shaped object, or
   * an honest unavailable line when the fetch failed. */
  function renderSky(stats) {
    skySection.replaceChildren();
    const h3 = document.createElement('h3');
    h3.textContent = 'Sky reports';
    skySection.appendChild(h3);
    if (!stats || !Number.isFinite(stats.count)) {
      const p = document.createElement('p');
      p.className = 'uap-observatory-unavailable';
      p.textContent = SKY_UNAVAILABLE;
      skySection.appendChild(p);
      return;
    }
    const count = document.createElement('p');
    count.className = 'uap-observatory-count';
    count.dataset.count = String(stats.count);
    const [from, to] = Array.isArray(stats.range) ? stats.range : [];
    count.textContent =
      Number.isFinite(from) && Number.isFinite(to)
        ? `${formatCount(stats.count)} reports, ${from} to ${to}`
        : `${formatCount(stats.count)} reports`;
    skySection.appendChild(count);

    const statusList = document.createElement('ul');
    statusList.className = 'uap-observatory-status';
    for (const [key, label] of STATUS_LABELS) {
      const value = stats.byStatus?.[key];
      if (!Number.isFinite(value)) continue;
      const li = document.createElement('li');
      li.className = `uap-observatory-status-${key}`;
      li.dataset.status = key;
      li.dataset.count = String(value);
      const labelSpan = document.createElement('span');
      labelSpan.textContent = label;
      const valueSpan = document.createElement('b');
      valueSpan.textContent = formatCount(value);
      li.append(labelSpan, valueSpan);
      statusList.appendChild(li);
    }
    skySection.appendChild(statusList);

    const sourceEntries = Object.entries(stats.bySource || {});
    if (sourceEntries.length) {
      const source = document.createElement('p');
      source.className = 'uap-observatory-source';
      source.textContent = `By source: ${sourceEntries
        .map(([id, value]) => `${sourceLabel(id)} ${formatCount(value)}`)
        .join(', ')}`;
      skySection.appendChild(source);
    }
  }

  /** Render the "ancient sites" section from the sites.v2.json header
   * fields, or an honest unavailable line when the fetch failed. */
  function renderAncient(stats) {
    ancientSection.replaceChildren();
    const h3 = document.createElement('h3');
    h3.textContent = 'Ancient sites';
    ancientSection.appendChild(h3);
    if (!stats || !Number.isFinite(stats.count)) {
      const p = document.createElement('p');
      p.className = 'uap-observatory-unavailable';
      p.textContent = ANCIENT_UNAVAILABLE;
      ancientSection.appendChild(p);
      return;
    }
    const count = document.createElement('p');
    count.className = 'uap-observatory-count';
    count.dataset.count = String(stats.count);
    count.textContent = `${formatCount(stats.count)} documented sites`;
    ancientSection.appendChild(count);

    const types = Array.isArray(stats.types) ? stats.types : [];
    if (types.length) {
      const typeList = document.createElement('ul');
      typeList.className = 'uap-observatory-types';
      for (const type of types) {
        const li = document.createElement('li');
        const icon = document.createElement('i');
        icon.className = 'uap-glyph-icon';
        icon.setAttribute('aria-hidden', 'true');
        // glyphUrlForType only ever resolves to one of the five shipped
        // glyph asset paths (falling back to a default for anything
        // outside that set), so this URL is never attacker- or
        // dataset-controlled markup, safe to hand straight to a style
        // property.
        const url = glyphUrlForType(type);
        icon.style.setProperty('-webkit-mask-image', `url('${url}')`);
        icon.style.setProperty('mask-image', `url('${url}')`);
        // Minor 9a (fix wave, atlas-instruments): the type row used to
        // print the shipped glyph's own filename (an internal asset name,
        // for example "trilith") alongside its label - a visitor reads the
        // type name, not our file layout, so only the label appears now.
        const label = document.createElement('span');
        label.textContent =
          String(type).charAt(0).toUpperCase() + String(type).slice(1);
        li.append(icon, label);
        typeList.appendChild(li);
      }
      ancientSection.appendChild(typeList);
    }

    const countries = Array.isArray(stats.countries) ? stats.countries : [];
    const countriesP = document.createElement('p');
    countriesP.className = 'uap-observatory-countries';
    countriesP.dataset.count = String(countries.length);
    countriesP.textContent = `${formatCount(countries.length)} countries covered`;
    ancientSection.appendChild(countriesP);
  }

  /** Render the "live claims" section from getStats()'s shape: the keyless
   * message when unconfigured, an honest empty state, or the current
   * window count. Never shows a bare zero as if it were a real reading. */
  function renderLive(stats) {
    liveSection.replaceChildren();
    const h3 = document.createElement('h3');
    h3.textContent = 'Live claims';
    liveSection.appendChild(h3);
    const p = document.createElement('p');
    p.className = 'uap-observatory-live';
    if (!stats) {
      p.textContent = LIVE_UNAVAILABLE;
    } else if (stats.status === 'no-key') {
      p.textContent = LIVE_KEYLESS;
    } else if (!Number.isFinite(stats.count) || stats.count === 0) {
      p.textContent = LIVE_EMPTY;
    } else {
      p.dataset.count = String(stats.count);
      p.textContent = `${formatCount(stats.count)} claim${stats.count === 1 ? '' : 's'} in the last 48 hours.`;
    }
    liveSection.appendChild(p);
  }

  /** Render the decade histogram from a plain list of report years. */
  function renderDecades(years) {
    decadeSection.replaceChildren();
    const h3 = document.createElement('h3');
    h3.textContent = 'Decades';
    decadeSection.appendChild(h3);
    const buckets = fillDecadeRange(decadeBuckets(years));
    if (!buckets.length) {
      const p = document.createElement('p');
      p.className = 'uap-observatory-unavailable';
      p.textContent = DECADES_UNAVAILABLE;
      decadeSection.appendChild(p);
      return;
    }
    decadeSection.appendChild(buildHistogramSvg(buckets));
  }

  /** Recompute every section. Live claims are read fresh (a synchronous
   * call); the three fetch-backed sections resolve and render
   * independently, so a slow ancient-sites fetch never holds up the sky
   * or live sections from appearing. */
  function refresh() {
    renderLive(
      typeof getLiveClaimsStats === 'function' ? getLiveClaimsStats() : null,
    );
    Promise.resolve(
      typeof fetchSkyStats === 'function' ? fetchSkyStats() : null,
    )
      .then(renderSky)
      .catch(() => renderSky(null));
    Promise.resolve(
      typeof fetchAncientStats === 'function' ? fetchAncientStats() : null,
    )
      .then(renderAncient)
      .catch(() => renderAncient(null));
    Promise.resolve(typeof fetchSkyYears === 'function' ? fetchSkyYears() : [])
      .then(renderDecades)
      .catch(() => renderDecades([]));
  }

  /** Hide the plate and tell the caller a close actually happened, from
   * every path that can close it: the Escape key, the Close button, and
   * the standalone toggle button's own `toggle()`/`close()` calls below.
   * Guarded on the plate already being open, so calling this on an
   * already-closed plate (its documented idempotent case, still relied on
   * by a shell rewire that closes it unconditionally on every connect,
   * whether or not it was open) stays a true no-op and never re-fires
   * `onClose` - fix 3, atlas-instruments: without a shared close path, the
   * Escape and Close-button routes never told the shell the plate had
   * shut, so its persistent toggle button was left reading
   * aria-pressed="true" after either one. */
  function close() {
    if (root.hidden) return;
    root.hidden = true;
    onClose?.();
  }
  function open() {
    root.hidden = false;
    closeBtn.focus();
    refresh();
  }

  root.addEventListener('click', (e) => {
    if (e.target.closest('.uap-close')) close();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  (container || document.body).appendChild(root);

  return {
    /** Show or hide the plate, refreshing every section on open. Returns
     * the new open state. */
    toggle() {
      root.hidden ? open() : close();
      return !root.hidden;
    },
    /** Hide the plate unconditionally. Idempotent, like the spotter's own
     * close(): safe for the shell to call whether or not it is currently
     * open, so a layer rewire or teardown never has to check state first
     * before making sure this plate is not left orphaned open. */
    close,
    isOpen() {
      return !root.hidden;
    },
    destroy() {
      root.remove();
    },
  };
}
