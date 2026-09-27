import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { createBrowserViteConfig } from '../../build/vite.js';
import { localProviderPlugins } from '../providers/local.js';
import { apiNotFoundPlugin } from './api-not-found.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Load this checkout's configuration and attach its local provider middleware. */
export default defineConfig(({ command, mode }) => {
  const loaded = loadEnv(mode, root, '');
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return createBrowserViteConfig({
    plugins: [...localProviderPlugins(), apiNotFoundPlugin()],
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: process.env.CESIUM_ION_TOKEN,
    phenomenaLocalTma: process.env.PHENOMENA_LOCAL_TMA,
    host: process.env.HOST,
    port: process.env.PORT,
    // Unset for the controller-managed dev server, which keeps Vite's
    // ordinary node_modules/.vite. A throwaway qa server sets this to its
    // own directory so it never shares - or invalidates - that cache (see
    // scripts/qa-claims.mjs's startServer()).
    cacheDir: process.env.GEV_VITE_CACHE_DIR,
    command,
  });
});
