import { createLiveClaimsLayer } from '../../layers/liveClaims/index.js';
import { createLiveClaimsSource } from '../../layers/liveClaims/source.js';
import { createAnomalySource } from '../../layers/anomalies/source.js';
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

/** Wire the live claims register to the application's pick registry and
 * render governor. The layer builds its own source (GET /api/claims, a
 * relative URL): the server owns the DeepSeek key and the feeds entirely.
 *
 * `anomalySource` reuses the anomalies layer's own portable source module
 * (a fresh instance, pointed at the same bundled `public/anomalies/`
 * dataset) purely so the claim dossier's nearby-cases block can fetch that
 * dataset read-only; it never touches the anomalies layer's own state. */
export function createApplicationLiveClaims(options = {}) {
  const anomaliesBase =
    options.anomaliesAssetBase ||
    `${import.meta.env?.BASE_URL ?? '/'}anomalies/`;
  return createLiveClaimsLayer({
    source: options.source || createLiveClaimsSource(),
    anomalySource:
      options.anomalySource || createAnomalySource({ baseUrl: anomaliesBase }),
    picking: { registerPickOwner, unregisterPickOwner },
    hoverPick: { installHoverPick, registerHoverClient, unregisterHoverClient },
    render: {
      holdContinuousRender,
      releaseContinuousRender,
      governorRequestRender,
    },
    ...options,
  });
}
