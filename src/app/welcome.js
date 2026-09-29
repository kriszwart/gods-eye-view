import { HONESTY_LINE } from '../layers/liveClaims/model.js';

/**
 * Durable "seen the welcome plate" flag, localStorage. Follows
 * src/firstRunExperience.js's own key convention (a `gev:` prefix, a
 * versioned suffix) even though this flag is simpler than that module's
 * pair: a single durable key, no session-only variant and no "don't show
 * this again" checkbox - a one-time introduction is not offered again once
 * seen on this browser, full stop, until the key is cleared.
 *
 * Exported (not just used internally by src/ui/layerBindings.js, which owns
 * the actual read/write - see its own doc comment) so
 * scripts/qa-anomalies.mjs, scripts/qa-claims.mjs and
 * scripts/qa-ancient-sites.mjs can pre-seed it for every check that is not
 * itself testing this plate, without importing layerBindings.js (and its
 * Cesium dependency) into a plain Node script.
 */
export const WELCOME_STORAGE_KEY = 'gev:atlas-welcome:v1';

/** Register descriptor rows for the plate's three-register summary, in the
 * same "sky, ancient, live" order and `data-register` vocabulary
 * src/app/observatory.js already uses for its own three sections, so a
 * visitor who opens both plates sees one consistent grouping. */
const REGISTERS = Object.freeze([
  Object.freeze({
    id: 'sky',
    label: 'Sky events',
    text: 'Every public sighting placed on a year dial from 1940 to today, each case sourced and graded.',
  }),
  Object.freeze({
    id: 'ancient',
    label: 'Ancient sites',
    text: 'Documented megaliths and anomalies worldwide, with what is genuinely debated stated plainly.',
  }),
  Object.freeze({
    id: 'live',
    label: 'Live claims',
    // Verbatim from the register's own model (src/layers/liveClaims/model.js),
    // imported rather than retyped, so this copy can never drift from the
    // words the live-claims dossier and status plate already show.
    text: HONESTY_LINE,
  }),
]);

const CHRONOMETER_LINE =
  'The ring around the globe is the sky events chronometer: drag it or use the arrow keys to change the year, and press play to step through hero cases.';

/**
 * Build the Phenomena welcome plate: a one-time atlas introduction. DOM
 * only, no Cesium and no storage access of its own - mirrors
 * src/app/observatory.js's shape and portability boundary. The caller
 * (src/ui/layerBindings.js) owns *when* this is built, shown and torn down,
 * and owns the localStorage decision of whether it is shown at all; this
 * module only ever builds and displays what it is told to, and every string
 * in it is static (there is nothing dynamic to escape).
 *
 * Every dismiss path that closes the plate on its own - Escape, the Close
 * button, and "Explore freely" - funnels through one idempotent `close()`,
 * which is the only place `onOpenChange(false)` fires. That mirrors
 * src/app/observatory.js's own fix-round lesson (fix 3, atlas-instruments):
 * without a single shared close path, a caller that reacts to closing (here,
 * remembering that the plate has been seen) can be told about some
 * dismissals and not others, leaving its own state out of step.
 * `onOpenChange(true)` fires once, from `open()`, for the same reason in the
 * other direction.
 *
 * "Take the hero tour" is deliberately NOT one of the self-closing paths:
 * starting the tour means enabling the anomalies layer first, which is
 * asynchronous, so only the caller knows when it is genuinely done and safe
 * to dismiss (see `_handleWelcomeTour` in src/ui/layerBindings.js). The
 * button only calls `onTakeTour`; the caller calls `close()` itself once
 * that work has actually started.
 *
 * @param {{
 *   container?: HTMLElement,
 *   onOpenChange?: (open: boolean) => void,
 *   onTakeTour?: () => void,
 *   onExploreFreely?: () => void,
 * }} [deps]
 * @returns {{open: () => void, close: () => void, isOpen: () => boolean, destroy: () => void}}
 */
export function createWelcome({
  container,
  onOpenChange,
  onTakeTour,
  onExploreFreely,
} = {}) {
  const root = document.createElement('section');
  root.className = 'uap-welcome';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Welcome to the atlas');
  root.tabIndex = -1;

  const head = document.createElement('div');
  head.className = 'uap-welcome-head';
  const title = document.createElement('h2');
  title.textContent = 'Phenomena';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'uap-close';
  closeBtn.textContent = 'Close';
  closeBtn.setAttribute('aria-label', 'Close welcome');
  head.append(title, closeBtn);

  const tagline = document.createElement('p');
  tagline.className = 'uap-welcome-tagline';
  tagline.textContent = 'The unexplained, mapped';

  const registerList = document.createElement('ul');
  registerList.className = 'uap-welcome-registers';
  for (const register of REGISTERS) {
    const item = document.createElement('li');
    item.className = 'uap-welcome-register';
    item.dataset.register = register.id;
    const chip = document.createElement('i');
    chip.className = 'uap-welcome-chip';
    chip.setAttribute('aria-hidden', 'true');
    const body = document.createElement('div');
    body.className = 'uap-welcome-register-body';
    const label = document.createElement('strong');
    label.textContent = register.label;
    const text = document.createElement('p');
    text.textContent = register.text;
    body.append(label, text);
    item.append(chip, body);
    registerList.appendChild(item);
  }

  const chronometerLine = document.createElement('p');
  chronometerLine.className = 'uap-welcome-chronometer';
  chronometerLine.textContent = CHRONOMETER_LINE;

  const tourBtn = document.createElement('button');
  tourBtn.type = 'button';
  tourBtn.className = 'uap-welcome-tour';
  tourBtn.textContent = 'Take the hero tour';

  const exploreBtn = document.createElement('button');
  exploreBtn.type = 'button';
  exploreBtn.className = 'uap-welcome-explore';
  exploreBtn.textContent = 'Explore freely';

  const actions = document.createElement('div');
  actions.className = 'uap-welcome-actions';
  actions.append(tourBtn, exploreBtn);

  root.append(head, tagline, registerList, chronometerLine, actions);

  /** The one shared close path every self-closing dismissal calls (Escape,
   * the Close button, Explore freely). Idempotent, like
   * src/app/observatory.js's own `close()`: safe to call from more than one
   * listener without firing `onOpenChange` twice for the same transition. */
  function close() {
    if (root.hidden) return;
    root.hidden = true;
    onOpenChange?.(false);
  }
  /** Idempotent in the other direction, for symmetry: calling `open()` on an
   * already-open plate must not re-fire `onOpenChange(true)`. */
  function open() {
    if (!root.hidden) return;
    root.hidden = false;
    tourBtn.focus();
    onOpenChange?.(true);
  }

  root.addEventListener('click', (e) => {
    if (e.target.closest('.uap-close')) close();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  exploreBtn.addEventListener('click', () => {
    onExploreFreely?.();
    close();
  });
  // Not self-closing - see the doc comment above.
  tourBtn.addEventListener('click', () => onTakeTour?.());

  (container || document.body).appendChild(root);

  return {
    open,
    close,
    isOpen: () => !root.hidden,
    /** Remove the plate outright rather than just hiding it: unlike
     * src/app/observatory.js's persistent plate (rebuilt lazily on the next
     * toggle), this one is genuinely one-shot - once dismissed, or on shell
     * teardown, there is nothing to reopen it. */
    destroy() {
      root.remove();
    },
  };
}
