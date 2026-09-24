/**
 * The corona chronometer: a radial time dial wrapped around the globe, with a
 * yearly histogram of reports as its corona. When the globe no longer fits on
 * screen it collapses to a band along the bottom edge. Plain DOM and SVG; the
 * layer feeds it the projected Earth disc each frame.
 */
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
};

export function createChronometer({
  container,
  from,
  to,
  onChange,
  onModeChange,
  labels = {},
}) {
  const years = to - from + 1;
  let hist = new Array(years).fill(0);
  let year = to;
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

  const panel = document.createElement('div');
  panel.className = 'uap-chrono-panel';
  panel.innerHTML = `
    <button type="button" class="uap-play" aria-pressed="false">${labels.play || 'Play'}</button>
    <div class="uap-slider" role="slider" tabindex="0" aria-label="${labels.year || 'Year'}"
      aria-valuemin="${from}" aria-valuemax="${to}" aria-valuenow="${year}"></div>
    <div class="uap-modes" role="radiogroup" aria-label="${labels.modes || 'Time filter'}">
      <button type="button" role="radio" data-mode="cumulative" aria-checked="true">Up to year</button>
      <button type="button" role="radio" data-mode="window" aria-checked="false">Around year</button>
      <button type="button" role="radio" data-mode="all" aria-checked="false">All years</button>
    </div>
    <p class="uap-readout" aria-live="polite"></p>`;
  root.appendChild(panel);
  container.appendChild(root);
  const slider = panel.querySelector('.uap-slider');
  const playBtn = panel.querySelector('.uap-play');
  const readout = panel.querySelector('.uap-readout');

  const angleOf = (y) =>
    -Math.PI / 2 + ((y - from + 0.5) / years) * Math.PI * 2;
  const yearFromAngle = (a) => {
    let f = (a + Math.PI / 2) / (Math.PI * 2);
    f -= Math.floor(f);
    return Math.min(to, Math.max(from, from + Math.floor(f * years)));
  };

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
      for (let i = 0; i < years; i++) {
        const y = from + i;
        const a = angleOf(y);
        const major = y % 10 === 0;
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
          t.textContent = String(y);
        }
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
      const x = (y) => left + ((y - from + 0.5) / years) * (right - left);
      el(
        'line',
        { x1: left, x2: right, y1: base, y2: base, class: 'ring' },
        gTicks,
      );
      for (let i = 0; i < years; i++) {
        const y = from + i;
        const major = y % 10 === 0;
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
          t.textContent = String(y);
        }
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
    needleText.textContent = mode === 'all' ? 'All' : String(year);
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
      mode === 'all' ? 'All years' : String(y),
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
    if (year >= to) setYear(from);
    playTimer = setInterval(
      () => (year >= to ? setPlaying(false) : setYear(year + 1)),
      reduced ? 900 : 450,
    );
  }

  const fromPointer = (e) => {
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    if (root.dataset.layout === 'ring')
      setYear(yearFromAngle(Math.atan2(py - layout.cy, px - layout.cx)));
    else setYear(from + ((px - 24) / (layout.width - 48)) * years - 0.5);
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
    const step = {
      ArrowRight: 1,
      ArrowUp: 1,
      ArrowLeft: -1,
      ArrowDown: -1,
      PageUp: 10,
      PageDown: -10,
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
    setVisible(on) {
      root.hidden = !on;
      if (!on) setPlaying(false);
    },
    destroy() {
      setPlaying(false);
      root.remove();
    },
  };
}
