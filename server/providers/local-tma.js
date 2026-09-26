import fs from 'node:fs';
import path from 'node:path';
import { defaultSourceRoot } from './common/source-root.js';

/** Path the browser-side layer requests the local TMA export from (see
 * src/layers/ancientSites/tmaLocal.js's TMA_LOCAL_URL). */
export const LOCAL_TMA_MOUNT_PATH = '/local-tma';

/** Repository-relative path to the git-ignored, never-bundled TMA export
 * (see anomaly-atlas-kit/docs/DATA_PIPELINE.md). */
export const LOCAL_TMA_FILE_PATH =
  'anomaly-atlas-kit/pipeline/local_data/normalised/tma-sites.jsonl';

/**
 * Dev-only middleware serving the local, git-ignored Modern Antiquarian
 * export at a fixed path. `localProviderPlugins()` (server/providers/local.js)
 * only registers this plugin when `PHENOMENA_LOCAL_TMA` is set, so the route
 * does not exist at all on a normal checkout; this module itself does not
 * re-check the flag, so a caller can exercise it directly (for example a
 * test standing up its own server instance).
 *
 * @param {{sourceRoot?: string}} [options]
 * @returns {import('vite').Plugin}
 */
export function localTmaProxy({ sourceRoot = defaultSourceRoot } = {}) {
  const filePath = path.join(sourceRoot, LOCAL_TMA_FILE_PATH);
  const installMiddleware = (server) => {
    server.middlewares.use(LOCAL_TMA_MOUNT_PATH, (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-store',
        });
        res.end('Method Not Allowed');
        return;
      }
      fs.readFile(filePath, 'utf8', (error, data) => {
        if (error) {
          res.writeHead(404, {
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-store',
          });
          res.end('Local TMA export not found on this machine');
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson',
          'Cache-Control': 'no-store',
        });
        res.end(data);
      });
    });
  };
  return {
    name: 'local-tma-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
