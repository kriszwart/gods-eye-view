/**
 * Advance the boot sequence's status line and its corona ring together.
 *
 * The ring on `#loading-screen` (src/ui/styles/anomaly-atlas.css) reads real
 * progress from two custom properties, `--uap-boot-stage` and
 * `--uap-boot-total`, plus an `is-determinate` class; before the first known
 * stage lands it falls back to an indeterminate sweep. This is the only
 * writer of those properties, so the ring only ever reports a stage the boot
 * genuinely reached, never a guess.
 *
 * `loaderStatus` is the existing `.loader-status` element already threaded
 * through src/app/scene.js and src/app/controls.js; this extends that same
 * channel rather than replacing it; a caller who only wants the text can
 * keep assigning `loaderStatus.textContent` directly, as src/main.js's
 * error path still does.
 * @param {HTMLElement} loaderStatus the `.loader-status` element
 * @param {string} label the status line, in the atlas's own voice
 * @param {number} stage the 1-based stage this update represents
 * @param {number} total the total number of known boot stages
 */
export function setLoaderStage(loaderStatus, label, stage, total) {
  loaderStatus.textContent = label;
  const screen = loaderStatus.closest('#loading-screen');
  if (!screen) return;
  screen.style.setProperty('--uap-boot-stage', String(stage));
  screen.style.setProperty('--uap-boot-total', String(total));
  screen.classList.add('is-determinate');
}
