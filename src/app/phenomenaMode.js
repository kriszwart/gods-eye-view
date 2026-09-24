/**
 * Solo the Phenomena registers: disable every other layer, remember the
 * exact prior set, and restore it on exit. Layers are hidden, not removed.
 */
export function createPhenomenaMode({ layerIds, isEnabled, setEnabled, keep }) {
  const kept = new Set(keep);
  let previous = null;
  return {
    get active() {
      return previous !== null;
    },
    enter() {
      if (previous) return;
      previous = layerIds.filter((id) => isEnabled(id));
      for (const id of previous) if (!kept.has(id)) setEnabled(id, false);
    },
    exit() {
      if (!previous) return;
      for (const id of previous) if (!isEnabled(id)) setEnabled(id, true);
      previous = null;
    },
  };
}
