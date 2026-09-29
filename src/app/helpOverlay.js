import { HONESTY_LINE } from '../layers/liveClaims/model.js';

/**
 * The ancient sites register's undated-sweep honesty line. The sweep bands
 * sites by their TYPE's typological era rather than any dating of the
 * individual site, and `src/layers/ancientSites/index.js` already says so
 * next to its own deep-time dial (`DEEP_TIME_HONESTY_LINE`), but that
 * constant is private to that (Cesium-touching) layer module - never
 * exported - so it cannot be imported here without pulling Cesium into this
 * plain shell overlay. Restated once, verbatim in spirit, rather than
 * imported; if the layer's own wording ever changes, this line should
 * change with it by hand.
 */
const ANCIENT_TYPOLOGICAL_LINE =
  "Undated sites are placed by their type's typical period, not their own dating.";

/**
 * The sky register's own "brightness and heat encode unexplainedness and
 * density, never credibility" honesty line. `src/layers/anomalies/index.js`
 * already states this in its own on-globe legend, but only inline inside a
 * template literal - never assigned to an exported constant - for the same
 * reason as the ancient line above: restated once here rather than
 * imported.
 */
const DENSITY_HONESTY_LINE = 'Heat shows report density, not credibility.';

/**
 * The keyboard map, in display order. Every row here is a control that
 * genuinely exists elsewhere in the app today (recon'd against
 * src/layers/anomalies/chronometer.js's own keydown handlers and its
 * `addSearch` input): the dial's arrow/Home/End keys only act while the
 * dial itself has focus, and the search field lives inside the sky
 * register's own dial panel (a plain `<input type="search">`, reached by
 * clicking it, or tabbing to it) rather than behind a shortcut of its own.
 */
const KEYBOARD_ROWS = Object.freeze([
  ['Arrow keys', "Step the dial's year by one, when the dial has focus."],
  ['Home / End', "Jump the dial to its scale's earliest or latest year."],
  ['Escape', 'Close whichever plate is open.'],
  [
    'Search cases and sites',
    'Click the search field in the dial panel, then type to search every register.',
  ],
  ['?', 'Open or close this overlay.'],
]);

/**
 * The globe's colour encoding, in display order. Wording follows
 * DESIGN_SYSTEM.md's "Encodings on the globe" section and the status labels
 * already shown on the Observatory plate's own status split
 * (src/app/observatory.js's `STATUS_LABELS`, itself a private constant
 * there and so restated rather than imported, same reasoning as the honesty
 * lines above).
 */
const READING_ROWS = Object.freeze([
  ['Brightness', 'How unexplained a case or site is.'],
  [
    'Hue',
    'Status: dim explained, violet too little data, magenta unresolved, amber contested.',
  ],
  ['Ion ring', 'A hero case with an animated craft.'],
  ['Gold', 'An ancient site.'],
  ['Ion', 'A live claim.'],
]);

/**
 * The three registers' own standing honesty lines, verbatim where a real
 * exported constant exists (live claims) and restated once above where it
 * does not (sky, ancient) - see this module's own top-of-file constants and
 * their doc comments for which is which.
 */
const HONESTY_LINES = Object.freeze([
  DENSITY_HONESTY_LINE,
  ANCIENT_TYPOLOGICAL_LINE,
  HONESTY_LINE,
]);

/**
 * Sources and credits live inside the sky register's own dial panel
 * ("Sources", next to the dial - see `src/layers/anomalies/index.js`'s
 * `creditsBtn = chrono.addAction('Sources', ...)`), built and owned
 * entirely by that layer module. `attachShellServices` (the one channel
 * this shell has into that module, wired in src/ui/layerBindings.js) never
 * exposes a way to open that plate programmatically - only
 * `togglePhenomenaMode`, `searchCases`, `focusResult`, `toggleSpotter` and
 * `closeSpotter` - and adding one only to serve this pointer button would
 * be a new cross-module channel for a single click, so this overlay states
 * where the plate lives instead of reaching for it.
 */
const SOURCES_POINTER_TEXT =
  'Sources and credits sits in the dial panel, under Sources, once sky events is on.';

/**
 * Build the help overlay: a static plate explaining the keyboard map, how
 * to read the globe's colour and motion encoding (including every
 * register's own standing honesty line, verbatim where one is exported),
 * and where sources and credits live. DOM only, no Cesium, nothing dynamic
 * to escape - mirrors src/app/observatory.js's shape ({toggle, close,
 * isOpen, destroy}) and its `onClose`-on-every-real-close-path lesson (fix
 * 3, atlas-instruments), except this module follows src/app/welcome.js's
 * own `onOpenChange(open: boolean)` naming instead, since the caller
 * (src/ui/layerBindings.js) needs to know about a genuine *open* here too:
 * the overlay can be opened by the "?" key without ever going through its
 * own standalone toggle button's click handler, so that button's own
 * `aria-pressed` can only be kept in sync by listening for both directions
 * here, not just the close side observatory.js's `onClose` covers.
 *
 * @param {{
 *   container?: HTMLElement,
 *   onOpenChange?: (open: boolean) => void,
 * }} [deps]
 * @returns {{toggle: () => boolean, close: () => void, isOpen: () => boolean, destroy: () => void}}
 */
export function createHelpOverlay({ container, onOpenChange } = {}) {
  const root = document.createElement('section');
  root.className = 'uap-help';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Help');
  root.tabIndex = -1;

  const head = document.createElement('div');
  head.className = 'uap-help-head';
  const title = document.createElement('h2');
  title.textContent = 'Help';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'uap-close';
  closeBtn.textContent = 'Close';
  closeBtn.setAttribute('aria-label', 'Close help');
  head.append(title, closeBtn);

  /** One definition-list section, built the same way for the keyboard map
   * and the encoding legend below: sentence-case dt/dd pairs. */
  function buildDefinitionList(rows) {
    const dl = document.createElement('dl');
    dl.className = 'uap-help-defs';
    for (const [term, description] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = description;
      dl.append(dt, dd);
    }
    return dl;
  }

  const keyboardSection = document.createElement('section');
  keyboardSection.className = 'uap-help-section';
  const keyboardHeading = document.createElement('h3');
  keyboardHeading.textContent = 'Keyboard';
  keyboardSection.append(keyboardHeading, buildDefinitionList(KEYBOARD_ROWS));

  const readingSection = document.createElement('section');
  readingSection.className = 'uap-help-section';
  const readingHeading = document.createElement('h3');
  readingHeading.textContent = 'Reading the atlas';
  const honestyList = document.createElement('ul');
  honestyList.className = 'uap-help-honesty';
  for (const line of HONESTY_LINES) {
    const li = document.createElement('li');
    li.textContent = line;
    honestyList.appendChild(li);
  }
  readingSection.append(
    readingHeading,
    buildDefinitionList(READING_ROWS),
    honestyList,
  );

  const sourcesSection = document.createElement('section');
  sourcesSection.className = 'uap-help-section';
  const sourcesHeading = document.createElement('h3');
  sourcesHeading.textContent = 'Sources';
  const sourcesText = document.createElement('p');
  sourcesText.className = 'uap-help-sources';
  sourcesText.textContent = SOURCES_POINTER_TEXT;
  sourcesSection.append(sourcesHeading, sourcesText);

  root.append(head, keyboardSection, readingSection, sourcesSection);

  /** The one shared close path every self-closing dismissal calls (Escape,
   * the Close button, the standalone toggle button's own `toggle()`),
   * mirroring welcome.js's and observatory.js's own idempotent close() -
   * see this module's doc comment for why `onOpenChange` (not `onClose`)
   * fires from here as well as from `open()` below. */
  function close() {
    if (root.hidden) return;
    root.hidden = true;
    onOpenChange?.(false);
  }
  function open() {
    if (!root.hidden) return;
    root.hidden = false;
    closeBtn.focus();
    onOpenChange?.(true);
  }

  root.addEventListener('click', (e) => {
    if (e.target.closest('.uap-close')) close();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  (container || document.body).appendChild(root);

  return {
    /** Show or hide the plate. Returns the new open state, the same
     * toggle() shape as observatory.js's own standalone toggle, so the
     * shell's "?" button and its document-level "?" keydown listener
     * (src/ui/layerBindings.js) can share one call. */
    toggle() {
      root.hidden ? open() : close();
      return !root.hidden;
    },
    close,
    isOpen: () => !root.hidden,
    destroy() {
      root.remove();
    },
  };
}
