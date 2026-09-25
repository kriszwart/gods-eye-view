/**
 * Solo the Phenomena registers: disable every other layer, remember the
 * exact prior set, and restore it on exit. Layers are hidden, not removed.
 *
 * Restore-set ruling: exit() restores every layer id that was enabled when
 * enter() ran, even a kept layer the user switched off by hand while the
 * mode was active. A kept id is never touched by enter() (it is not in the
 * set that gets disabled), but if the user disables it during the mode it
 * is still in the recorded `previous` set, so exit() turns it back on along
 * with everything else. In short: exit() restores the exact prior enabled
 * set, not "whatever enter() happened to disable".
 *
 * The optional `getStyle`/`setStyle` hooks apply the Spectral style for the
 * duration of the mode: enter() records the current style via `getStyle()`
 * then calls `setStyle('spectral')`; exit() calls `setStyle()` again with
 * the recorded style to restore it. Both hooks are optional and independent
 * of the layer bookkeeping above — when either is missing, style is left
 * alone and behaviour is unchanged from before they existed. A forced or
 * repeated exit() (no matching enter(), or exit() called twice) never calls
 * setStyle more than once per enter(), because exit() is a no-op whenever
 * the mode is not active.
 */
export function createPhenomenaMode({
  layerIds,
  isEnabled,
  setEnabled,
  keep,
  getStyle,
  setStyle,
}) {
  const kept = new Set(keep);
  const stylable =
    typeof getStyle === 'function' && typeof setStyle === 'function';
  let previous = null;
  let previousStyle = null;
  return {
    get active() {
      return previous !== null;
    },
    enter() {
      if (previous) return;
      previous = layerIds.filter((id) => isEnabled(id));
      for (const id of previous) if (!kept.has(id)) setEnabled(id, false);
      if (stylable) {
        previousStyle = getStyle();
        setStyle('spectral');
      }
    },
    exit() {
      if (!previous) return;
      for (const id of previous) if (!isEnabled(id)) setEnabled(id, true);
      previous = null;
      if (stylable) {
        setStyle(previousStyle);
        previousStyle = null;
      }
    },
  };
}
