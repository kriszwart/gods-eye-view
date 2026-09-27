import { createLiveClaimsLayer } from '../../layers/liveClaims/index.js';
import { createLiveClaimsSource } from '../../layers/liveClaims/source.js';
import {
  registerPickOwner,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import {
  holdContinuousRender,
  releaseContinuousRender,
  governorRequestRender,
} from '../../renderGovernor.js';

/** Wire the live claims register to the application's pick registry and
 * render governor. The layer builds its own source (GET /api/claims, a
 * relative URL): the server owns the DeepSeek key and the feeds entirely. */
export function createApplicationLiveClaims(options = {}) {
  return createLiveClaimsLayer({
    source: options.source || createLiveClaimsSource(),
    picking: { registerPickOwner, unregisterPickOwner },
    render: {
      holdContinuousRender,
      releaseContinuousRender,
      governorRequestRender,
    },
    ...options,
  });
}
