import { createAncientSitesLayer } from '../../layers/ancientSites/index.js';
import { createAncientSource } from '../../layers/ancientSites/source.js';
import { overlayHost } from './overlayHost.js';
import {
  registerPickOwner,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import { governorRequestRender } from '../../renderGovernor.js';

/** Wire the bundled ancient sites dataset to the application services. */
export function createApplicationAncientSites(options = {}) {
  const base =
    options.assetBase || `${import.meta.env?.BASE_URL ?? '/'}ancient-sites/`;
  return createAncientSitesLayer({
    source: options.source || createAncientSource({ baseUrl: base }),
    overlayHost,
    picking: { registerPickOwner, unregisterPickOwner },
    render: { governorRequestRender },
    assetBase: base,
    ...options,
  });
}
