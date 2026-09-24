import { createAnomaliesLayer } from '../../layers/anomalies/index.js';
import { createAnomalySource } from '../../layers/anomalies/source.js';
import { overlayHost } from './overlayHost.js';
import {
  registerPickOwner,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';

/** Wire the bundled anomaly dataset to the application overlay host. */
export function createApplicationAnomalies(options = {}) {
  const base =
    options.assetBase || `${import.meta.env?.BASE_URL ?? '/'}anomalies/`;
  return createAnomaliesLayer({
    source: options.source || createAnomalySource({ baseUrl: base }),
    overlayHost,
    picking: { registerPickOwner, unregisterPickOwner },
    assetBase: base,
    ...options,
  });
}
