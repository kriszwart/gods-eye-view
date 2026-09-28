/**
 * The corona chronometer: a radial time dial wrapped around the globe, with a
 * yearly histogram of reports as its corona. When the globe no longer fits on
 * screen it collapses to a band along the bottom edge. Plain DOM and SVG; the
 * layer feeds it the projected Earth disc each frame.
 */
import { WAVES } from './waves.js';
import { safeSourceUrl } from '../../sources/safeUrl.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
};

/**
 * `scale` swaps in a different value domain and layout for the same dial
 * widget (the deep-time dial): `{ initial, posOf(value), fromPos(pos),
 * values(), isMajor(value), format(value), step, pageStep, histogram }`.
 * `posOf` maps a domain value to a normalised [0,1] position (0 the dial's
 * oldest/starting value, 1 its newest/ending one); `fromPos` is its
 * approximate inverse for pointer interaction; `values()` lists every tick
 * to draw (the sky scale draws one per year, the deep-time scale a fixed
 * set of milestones); `histogram` says whether the yearly bar chart applies
 * (the worldwide sweep carries no per-site dating, so the deep-time dial
 * never draws one - see `src/layers/ancientSites/eras.js`). Omitted (the
 * only use before the deep-time dial), the calendar-year scale below
 * applies exactly as it always has.
 *
 * `labels` carries the matching swap for the widget's own copy: `year` and
 * `modes` (the slider's and the mode radiogroup's aria-labels) plus
 * `cumulative`, `window` and `all`, the three mode buttons' own visible
 * text and (for `all`) the slider's spoken `aria-valuetext`. Every field
 * defaults to the calendar-year wording ('Year', 'Time filter', 'Up to
 * year', 'Around year', 'All years'), so a caller that never sets `labels`
 * sees exactly the original sky-dial copy.
 */
export function createChronometer({
  container,
  from,
  to,
  onChange,
  onModeChange,
  labels = {},
  scale = null,
}) {
  const years = to - from + 1;
  let hist = new Array(years).fill(0);
  let year = scale ? scale.initial : to;
  let mode = 'cumulative';
  let layout = null;
  let playTimer = null;
  const reduced = globalThis.matchMedia?.(
    '(prefers-reduced-motion: reduce)',
  ).matches;

  const root = document.createElement('div');
  root.className = 'uap-chrono';
  root.dataset.layout = 'ring';
  const svg = el(
    'svg',
    { class: 'uap-chrono-svg', 'aria-hidden': 'true' },
    root,
  );
  const defs = el('defs', {}, svg);
  const grad = el(
    'linearGradient',
    { id: 'uap-spectrum', x1: '0', y1: '0', x2: '1', y2: '1' },
    defs,
  );
  el('stop', { offset: '0', 'stop-color': 'var(--uap-magenta)' }, grad);
  el('stop', { offset: '0.55', 'stop-color': 'var(--uap-violet)' }, grad);
  el('stop', { offset: '1', 'stop-color': 'var(--uap-ion)' }, grad);
  const gTicks = el('g', { class: 'ticks' }, svg);
  const gBars = el('g', { class: 'bars' }, svg);
  const needle = el('g', { class: 'needle' }, svg);
  const needleLine = el('line', {}, needle);
  const needleText = el('text', {}, needle);
  const hit = el('path', { class: 'hit' }, svg);

  // The three mode-button captions, and the "all" one's spoken
  // aria-valuetext below, follow the scale's own vocabulary (see this
  // factory's top-of-file doc comment on `labels`); the sky dial's default
  // wording is unchanged when a caller never sets these fields.
  const modeLabels = {
    cumulative: labels.cumulative || 'Up to year',
    window: labels.window || 'Around year',
    all: labels.all || 'All years',
  };
  const panel = document.createElement('div');
  panel.className = 'uap-chrono-panel';
  panel.innerHTML = `
    <button type="button" class="uap-play" aria-pressed="false">${labels.play || 'Play'}</button>
    <div class="uap-slider" role="slider" tabindex="0" aria-label="${labels.year || 'Year'}"
      aria-valuemin="${from}" aria-valuemax="${to}" aria-valuenow="${year}"></div>
    <div class="uap-modes" role="radiogroup" aria-label="${labels.modes || 'Time filter'}">
      <button type="button" role="radio" data-mode="cumulative" aria-checked="true">${modeLabels.cumulative}</button>
      <button type="button" role="radio" data-mode="window" aria-checked="false">${modeLabels.window}</button>
      <button type="button" role="radio" data-mode="all" aria-checked="false">${modeLabels.all}</button>
    </div>
    <p class="uap-readout" aria-live="polite"></p>`;
  root.appendChild(panel);

  // Documented report waves (waves.js), marked on the sky scale's corona
  // only: `scale` is null for the sky dial and an object for the deep-time
  // (era) dial, so this overlay and the note plate are never even created
  // for the deep-time dial, keeping its construction byte-equivalent to
  // before this landmark feature existed (guard on the scale identity).
  // Plain HTML, not SVG: the dial's `<svg>` carries aria-hidden="true"
  // (every meaningful control lives outside it, in `panel`), so a focusable,
  // announced mark has to live outside it too.
  const landmarksLayer = scale ? null : document.createElement('div');
  const landmarkPlate = scale ? null : document.createElement('div');
  if (landmarksLayer) {
    landmarksLayer.className = 'uap-landmarks';
    root.appendChild(landmarksLayer);
    landmarkPlate.className = 'uap-landmark-plate';
    landmarkPlate.hidden = true;
    landmarkPlate.innerHTML = `
      <p class="uap-landmark-label"></p>
      <p class="uap-landmark-note"></p>
      <a class="uap-landmark-link" target="_blank" rel="noopener noreferrer">Source</a>`;
    root.appendChild(landmarkPlate);
  }

  container.appendChild(root);
  const slider = panel.querySelector('.uap-slider');
  const playBtn = panel.querySelector('.uap-play');
  const readout = panel.querySelector('.uap-readout');

  /** Every tick value to draw: one per year for the calendar scale, or the
   * scale's own fixed milestone list. */
  const tickValues = () => {
    if (scale) return scale.values();
    const values = new Array(years);
    for (let i = 0; i < years; i++) values[i] = from + i;
    return values;
  };

  const angleOf = (y) =>
    -Math.PI / 2 +
    (scale ? scale.posOf(y) : (y - from + 0.5) / years) * Math.PI * 2;
  const yearFromAngle = (a) => {
    let f = (a + Math.PI / 2) / (Math.PI * 2);
    f -= Math.floor(f);
    return Math.min(
      to,
      Math.max(from, scale ? scale.fromPos(f) : from + Math.floor(f * years)),
    );
  };

  /** The wave currently shown in the note plate, or null: tracked so a
   * redraw (the dial relayouts every time the projected Earth disc moves)
   * can carry an open plate's position along with its mark rather than
   * leaving it stale. */
  let openWave = null;

  /** Fill and show the landmark note plate at a mark's own screen point (CSS
   * pixels within `root`, which both the svg and `landmarksLayer` fill
   * edge-to-edge, so the mark's own left/top double as the plate's anchor
   * with no extra conversion). No-op on the deep-time dial, where
   * `landmarkPlate` was never created. */
  function openLandmark(wave, point) {
    if (!landmarkPlate) return;
    openWave = wave;
    landmarkPlate.querySelector('.uap-landmark-label').textContent = wave.label;
    landmarkPlate.querySelector('.uap-landmark-note').textContent = wave.note;
    const link = landmarkPlate.querySelector('.uap-landmark-link');
    const safe = safeSourceUrl(wave.source_url);
    if (safe) {
      link.href = safe;
      link.hidden = false;
    } else {
      link.removeAttribute('href');
      link.hidden = true;
    }
    landmarkPlate.style.left = `${point.x}px`;
    landmarkPlate.style.top = `${point.y}px`;
    landmarkPlate.hidden = false;
  }

  function closeLandmark() {
    openWave = null;
    if (landmarkPlate) landmarkPlate.hidden = true;
  }

  /** One keyboard-reachable landmark mark per waves.js entry, built once (not
   * per draw()): a real `<button>`, natively focusable, so it needs no
   * explicit tabindex or role. Hover or focus opens the note plate, Escape
   * or blur closes it. Built once rather than replaced every draw() so an
   * open plate's own focus survives a relayout - replacing a focused
   * element fires blur, which would otherwise close the plate on every
   * redraw while the globe (and so the projected disc) is still moving. */
  const landmarkEntries = landmarksLayer
    ? WAVES.map((wave) => {
        const point = { x: 0, y: 0 };
        const mark = document.createElement('button');
        mark.type = 'button';
        mark.className = 'uap-landmark';
        mark.dataset.year = String(wave.year);
        mark.setAttribute('aria-label', `${wave.year}: ${wave.label}`);
        mark.addEventListener('mouseenter', () => openLandmark(wave, point));
        mark.addEventListener('mouseleave', closeLandmark);
        mark.addEventListener('focus', () => openLandmark(wave, point));
        mark.addEventListener('blur', closeLandmark);
        mark.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') closeLandmark();
        });
        landmarksLayer.appendChild(mark);
        return { wave, mark, point };
      })
    : [];

  /** Reposition every landmark mark from `pointFor(wave)` (CSS pixels within
   * `root`); if the note plate is currently open, carries it to the same
   * mark's fresh position rather than leaving it stale after a relayout. */
  function positionLandmarks(pointFor) {
    for (const entry of landmarkEntries) {
      const p = pointFor(entry.wave);
      entry.point.x = p.x;
      entry.point.y = p.y;
      entry.mark.style.left = `${p.x}px`;
      entry.mark.style.top = `${p.y}px`;
    }
    if (openWave) {
      const entry = landmarkEntries.find((e) => e.wave === openWave);
      if (entry) openLandmark(openWave, entry.point);
    }
  }

  function draw() {
    if (!layout) return;
    const { width, height } = layout;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    gTicks.replaceChildren();
    gBars.replaceChildren();
    const max = Math.max(1, ...hist);
    if (root.dataset.layout === 'ring') {
      const { cx, cy } = layout;
      const R = layout.r + 18;
      el('circle', { cx, cy, r: R, class: 'ring' }, gTicks);
      for (const y of tickValues()) {
        const a = angleOf(y);
        const major = scale ? scale.isMajor(y) : y % 10 === 0;
        const r0 = R - (major ? 7 : 3);
        el(
          'line',
          {
            x1: cx + Math.cos(a) * r0,
            y1: cy + Math.sin(a) * r0,
            x2: cx + Math.cos(a) * R,
            y2: cy + Math.sin(a) * R,
            class: major ? 'tick major' : 'tick',
          },
          gTicks,
        );
        if (major) {
          const t = el(
            'text',
            {
              x: cx + Math.cos(a) * (R - 18),
              y: cy + Math.sin(a) * (R - 18) + 3.5,
              'text-anchor': 'middle',
              class: 'label',
            },
            gTicks,
          );
          t.textContent = scale ? scale.format(y) : String(y);
        }
        if (!scale || scale.histogram) {
          const i = y - from;
          if (hist[i]) {
            const len = 4 + 34 * Math.sqrt(hist[i] / max);
            el(
              'line',
              {
                x1: cx + Math.cos(a) * (R + 3),
                y1: cy + Math.sin(a) * (R + 3),
                x2: cx + Math.cos(a) * (R + 3 + len),
                y2: cy + Math.sin(a) * (R + 3 + len),
                class: inRange(y) ? 'bar on' : 'bar',
              },
              gBars,
            );
          }
        }
      }
      // Documented report waves (waves.js): a small mark inside the tick
      // ring, in the gap between the major ticks' inner end (R-7) and the
      // labels (R-18), so it never collides with a tick, a label or the
      // histogram bars (which grow outward from R+3). Sky scale only:
      // `landmarksLayer` is null on the deep-time dial.
      if (landmarksLayer) {
        const lr = R - 12;
        positionLandmarks((wave) => {
          const wa = angleOf(wave.year);
          return { x: cx + Math.cos(wa) * lr, y: cy + Math.sin(wa) * lr };
        });
      }
      const a = angleOf(year);
      needleLine.setAttribute('x1', cx + Math.cos(a) * (R - 10));
      needleLine.setAttribute('y1', cy + Math.sin(a) * (R - 10));
      needleLine.setAttribute('x2', cx + Math.cos(a) * (R + 46));
      needleLine.setAttribute('y2', cy + Math.sin(a) * (R + 46));
      needleText.setAttribute('x', cx + Math.cos(a) * (R + 62));
      needleText.setAttribute('y', cy + Math.sin(a) * (R + 62) + 4);
      needleText.setAttribute('text-anchor', 'middle');
      hit.setAttribute(
        'd',
        `M ${cx - R - 20} ${cy} a ${R + 20} ${R + 20} 0 1 0 ${2 * (R + 20)} 0 a ${R + 20} ${R + 20} 0 1 0 ${-2 * (R + 20)} 0`,
      );
    } else {
      const left = 24;
      const right = width - 24;
      const base = height - 34;
      const x = (y) =>
        left +
        (scale ? scale.posOf(y) : (y - from + 0.5) / years) * (right - left);
      el(
        'line',
        { x1: left, x2: right, y1: base, y2: base, class: 'ring' },
        gTicks,
      );
      for (const y of tickValues()) {
        const major = scale ? scale.isMajor(y) : y % 10 === 0;
        el(
          'line',
          {
            x1: x(y),
            x2: x(y),
            y1: base,
            y2: base + (major ? 7 : 3),
            class: major ? 'tick major' : 'tick',
          },
          gTicks,
        );
        if (major) {
          const t = el(
            'text',
            { x: x(y), y: base + 20, 'text-anchor': 'middle', class: 'label' },
            gTicks,
          );
          t.textContent = scale ? scale.format(y) : String(y);
        }
        if (!scale || scale.histogram) {
          const i = y - from;
          if (hist[i])
            el(
              'line',
              {
                x1: x(y),
                x2: x(y),
                y1: base - 2,
                y2: base - 2 - (3 + 26 * Math.sqrt(hist[i] / max)),
                class: inRange(y) ? 'bar on' : 'bar',
              },
              gBars,
            );
        }
      }
      // Documented report waves (waves.js): a small mark in the band's own
      // gap between the tick ends (base+7) and the labels (base+20). Sky
      // scale only: `landmarksLayer` is null on the deep-time dial.
      if (landmarksLayer) {
        const ly = base + 13;
        positionLandmarks((wave) => ({ x: x(wave.year), y: ly }));
      }
      needleLine.setAttribute('x1', x(year));
      needleLine.setAttribute('x2', x(year));
      needleLine.setAttribute('y1', base + 8);
      needleLine.setAttribute('y2', base - 40);
      needleText.setAttribute('x', x(year));
      needleText.setAttribute('y', base - 46);
      needleText.setAttribute('text-anchor', 'middle');
      hit.setAttribute(
        'd',
        `M ${left} ${base - 44} H ${right} V ${base + 12} H ${left} Z`,
      );
    }
    needleText.textContent =
      mode === 'all' ? 'All' : scale ? scale.format(year) : String(year);
  }

  const inRange = (y) =>
    mode === 'all'
      ? true
      : mode === 'window'
        ? Math.abs(y - year) <= 2
        : y <= year;

  function setYear(next, { silent = false } = {}) {
    const y = Math.min(to, Math.max(from, Math.round(next)));
    if (y === year && !silent) return;
    year = y;
    slider.setAttribute('aria-valuenow', String(y));
    slider.setAttribute(
      'aria-valuetext',
      mode === 'all' ? modeLabels.all : scale ? scale.format(y) : String(y),
    );
    draw();
    if (!silent) onChange?.(y);
  }

  function setMode(next) {
    mode = next;
    for (const b of panel.querySelectorAll('[data-mode]'))
      b.setAttribute('aria-checked', String(b.dataset.mode === next));
    draw();
    onModeChange?.(next);
  }

  function setPlaying(on) {
    clearInterval(playTimer);
    playTimer = null;
    playBtn.setAttribute('aria-pressed', String(on));
    playBtn.textContent = on ? 'Pause' : 'Play';
    if (!on) return;
    const step = scale ? scale.step : 1;
    if (year >= to) setYear(from);
    playTimer = setInterval(
      () => (year >= to ? setPlaying(false) : setYear(year + step)),
      reduced ? 900 : 450,
    );
  }

  const fromPointer = (e) => {
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    if (root.dataset.layout === 'ring')
      setYear(yearFromAngle(Math.atan2(py - layout.cy, px - layout.cx)));
    else {
      const f = (px - 24) / (layout.width - 48);
      setYear(scale ? scale.fromPos(f) : from + f * years - 0.5);
    }
  };
  let dragging = false;
  hit.addEventListener('pointerdown', (e) => {
    dragging = true;
    hit.setPointerCapture(e.pointerId);
    setPlaying(false);
    fromPointer(e);
  });
  hit.addEventListener('pointermove', (e) => dragging && fromPointer(e));
  hit.addEventListener('pointerup', () => (dragging = false));
  hit.addEventListener('pointercancel', () => (dragging = false));
  slider.addEventListener('keydown', (e) => {
    const unit = scale ? scale.step : 1;
    const page = scale ? scale.pageStep : 10;
    const step = {
      ArrowRight: unit,
      ArrowUp: unit,
      ArrowLeft: -unit,
      ArrowDown: -unit,
      PageUp: page,
      PageDown: -page,
    }[e.key];
    if (step) setYear(year + step);
    else if (e.key === 'Home') setYear(from);
    else if (e.key === 'End') setYear(to);
    else return;
    e.preventDefault();
  });
  playBtn.addEventListener('click', () => setPlaying(!playTimer));
  panel.querySelector('.uap-modes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) setMode(b.dataset.mode);
  });

  return {
    setHistogram(next) {
      hist = next.slice(0, years);
      draw();
    },
    setReadout(text) {
      readout.textContent = text;
    },
    /**
     * Tint the readout with one status hue (explained, insufficient,
     * unresolved or contested), or clear it back to plain ink with `null`.
     * A caller-driven accent, never set by the dial itself, so a scale that
     * never calls it (the deep-time dial's era readout) stays untinted.
     */
    setReadoutTint(status) {
      readout.className = status
        ? `uap-readout uap-readout-${status}`
        : 'uap-readout';
    },
    setYear,
    /** Add a text button to the dial's panel (for example a guided tour). */
    addAction(label, fn) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => fn(b));
      panel.insertBefore(b, readout);
      return b;
    },
    /**
     * Add a case-and-site search box to the dial's panel: an input plus a
     * results list, debounced, keyboard-operable, register-tagged rows.
     * `onQuery` may return a promise (the shell's corpus can need a first
     * fetch): the pending debounce is always cancellable via `clear()` or a
     * fresh keystroke, and a stale resolution from a superseded query is
     * dropped rather than clobbering a newer render.
     * @param {{onQuery: (query: string) => (Array<Object>|Promise<Array<Object>>), onPick: (result: Object) => void}} handlers
     * @returns {{clear: () => void}}
     */
    addSearch({ onQuery, onPick } = {}) {
      const wrap = document.createElement('div');
      wrap.className = 'uap-search-wrap';
      const input = document.createElement('input');
      input.type = 'search';
      input.className = 'uap-search';
      input.placeholder = 'Search cases and sites';
      input.setAttribute('aria-label', 'Search cases and sites');
      input.autocomplete = 'off';
      const list = document.createElement('ul');
      list.className = 'uap-search-results';
      list.hidden = true;
      wrap.append(input, list);
      panel.insertBefore(wrap, readout);

      let items = [];
      let debounceTimer = null;
      let queryToken = 0;

      const clear = () => {
        clearTimeout(debounceTimer);
        debounceTimer = null;
        queryToken++;
        items = [];
        list.replaceChildren();
        list.hidden = true;
        input.value = '';
      };

      const render = (next) => {
        items = Array.isArray(next) ? next : [];
        list.replaceChildren();
        for (const item of items) {
          const row = document.createElement('li');
          row.className = item.register === 'ancient' ? 'ancient' : 'sky';
          row.tabIndex = 0;
          const title = document.createElement('span');
          title.className = 'uap-search-title';
          title.textContent = item.title || '';
          const tag = document.createElement('span');
          tag.className = 'uap-search-tag';
          tag.textContent = item.register === 'ancient' ? 'Ancient' : 'Sky';
          row.append(title, tag);
          row.addEventListener('click', () => onPick?.(item));
          row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onPick?.(item);
            }
          });
          list.appendChild(row);
        }
        list.hidden = items.length === 0;
      };

      input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        const query = input.value;
        debounceTimer = setTimeout(async () => {
          const token = ++queryToken;
          let results = [];
          // `onQuery`'s own synchronous search-call cost, timed separately
          // from the fixed 150ms debounce above it, so a qa gate (or a
          // future in-app readout) can read the corpus's actual per-query
          // latency straight off the DOM (task 3, atlas-instruments -
          // search now reaches the ~85k-record corpus, see
          // src/app/caseSearch.js's prefix-bucket index and the task
          // report's own measurements). A cold first call also carries the
          // shell's own corpus fetch and index build, so this is only a
          // steady-state figure once that lazy build has already run once.
          const queryStart = performance.now();
          try {
            results = (await onQuery?.(query)) || [];
          } catch (error) {
            console.warn('[UAP:Chronometer] Search query failed', error);
          }
          wrap.dataset.uapSearchLastMs = String(performance.now() - queryStart);
          // A newer query (a fresh keystroke, or Escape/clear) has since
          // superseded this one: never let a slow, stale response overwrite
          // whatever the panel is showing now.
          if (token === queryToken) render(results);
        }, 150);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (items[0]) onPick?.(items[0]);
        } else if (e.key === 'Escape') {
          clear();
        }
      });

      return { clear };
    },
    /** @param {{cx:number, cy:number, r:number, width:number, height:number}|null} disc */
    layout(disc, viewport) {
      const fits =
        disc &&
        disc.r > 40 &&
        disc.r * 2 + 150 < Math.min(viewport.width, viewport.height);
      root.dataset.layout = fits ? 'ring' : 'band';
      layout = fits ? disc : { ...viewport };
      draw();
    },
    get year() {
      return year;
    },
    get mode() {
      return mode;
    },
    /**
     * Show or hide the whole widget. Off does more than set the `hidden`
     * attribute: it detaches `root` from `container` outright, so a layer
     * that builds its chronometer once in `init()` and only ever toggles
     * visibility on enable/disable (the sky layer's own pattern) never
     * leaves a hidden `.uap-chrono`/`.uap-slider` sitting in the DOM for an
     * unqualified query elsewhere to find - see the ancient-sites layer's
     * own deep-time dial, which shares that DOM and must never coexist with
     * a stale sky one. Reattaching is a no-op when `root` is already
     * connected (for example the very first `setVisible(true)` right after
     * `createChronometer`, which already appended it).
     */
    setVisible(on) {
      if (on) {
        root.hidden = false;
        if (!root.isConnected) container.appendChild(root);
      } else {
        setPlaying(false);
        closeLandmark();
        root.hidden = true;
        root.remove();
      }
    },
    destroy() {
      setPlaying(false);
      closeLandmark();
      root.remove();
    },
  };
}
