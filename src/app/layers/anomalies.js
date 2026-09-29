import { createAnomaliesLayer } from '../../layers/anomalies/index.js';
import { createAnomalySource } from '../../layers/anomalies/source.js';
import { overlayHost } from './overlayHost.js';
import {
  registerPickOwner,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import {
  installHoverPick,
  registerHoverClient,
  unregisterHoverClient,
} from '../../ui/hoverPick.js';
import {
  holdContinuousRender,
  releaseContinuousRender,
  governorRequestRender,
} from '../../renderGovernor.js';

/** Wire the bundled anomaly dataset to the application overlay host. */
export function createApplicationAnomalies(options = {}) {
  const base =
    options.assetBase || `${import.meta.env?.BASE_URL ?? '/'}anomalies/`;
  const layer = createAnomaliesLayer({
    source: options.source || createAnomalySource({ baseUrl: base }),
    overlayHost,
    picking: { registerPickOwner, unregisterPickOwner },
    hoverPick: { installHoverPick, registerHoverClient, unregisterHoverClient },
    render: {
      holdContinuousRender,
      releaseContinuousRender,
      governorRequestRender,
    },
    assetBase: base,
    ...options,
  });
  // The infrared style is a document-level attribute, not layer state, so
  // watch it and forward it to the layer's infrared-only craft. Guarded for
  // the unit test environment, which constructs the catalogue without a DOM.
  const hasDom =
    typeof document !== 'undefined' && typeof MutationObserver !== 'undefined';
  const syncInfrared = () =>
    layer.setInfrared(document.documentElement.dataset.gevStyle === 'infrared');
  const observer = hasDom ? new MutationObserver(syncInfrared) : null;
  if (observer) {
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-gev-style'],
    });
    syncInfrared();
    // The style can change while the layer is off, so re-apply on init and enable.
    for (const method of ['init', 'enable']) {
      const original = layer[method];
      layer[method] = (...args) => {
        const result = original.apply(layer, args);
        syncInfrared();
        return result;
      };
    }
  }
  const destroy = layer.destroy;
  layer.destroy = (...args) => {
    observer?.disconnect();
    return destroy.apply(layer, args);
  };
  return layer;
}
