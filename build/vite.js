import { applicationHtmlPlugin } from './application-html.js';
import cesium from 'vite-plugin-cesium';

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  publicDir,
  googleApiKey,
  cesiumToken,
  phenomenaLocalTma,
  host = 'localhost',
  port = 4173,
  command,
  cacheDir,
} = {}) {
  return {
    plugins: [cesium(), applicationHtmlPlugin(), ...plugins],
    ...(publicDir === undefined ? {} : { publicDir }),
    // A production build must not clean the dependency cache a running dev
    // server is still serving optimized module URLs from. An explicit
    // `cacheDir` (e.g. a throwaway qa dev server) always wins over that
    // default, so a short-lived server never shares - and cannot go stale
    // against - the long-running dev server's own node_modules/.vite.
    ...(cacheDir
      ? { cacheDir }
      : command === 'build'
        ? { cacheDir: 'node_modules/.vite-build' }
        : {}),
    optimizeDeps: {
      // First reached through the SDR worker or a dynamic import. Pre-bundle
      // them at startup so first use cannot invalidate already-transformed
      // URLs with Vite's "Outdated Optimize Dep" 504 response.
      include: [
        '@jtarrio/signals/demod/demodulator.js',
        '@jtarrio/signals/demod/modes.js',
        '@jtarrio/webrtlsdr/rtlsdr.js',
        'egm96-universal',
      ],
    },
    server: {
      host: host || 'localhost',
      port: parseInt(port, 10) || 4173,
      allowedHosts:
        host === '0.0.0.0' || host === '::'
          ? true
          : ['localhost', '127.0.0.1', '.local'],
      fs: {
        // Vite's dev server serves any file under the project root by
        // default (the friendly /local-tma/ route is a separate, Node-level
        // fs.readFile in server/providers/local-tma.js and is unaffected by
        // this deny list). Without this entry, the raw repository path and
        // its /@fs/<absolute-path> form both serve the git-ignored TMA
        // export regardless of PHENOMENA_LOCAL_TMA.
        deny: [
          '.env',
          '.env.*',
          '*.{crt,pem}',
          '**/.git/**',
          '**/ENVIRONMENT',
          '**/anomaly-atlas-kit/pipeline/local_data/**',
        ],
      },
      // These headers protect the document containing Provider Settings.
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
      // Always a literal string (never undefined), so an unset flag folds
      // to `""` and a flag-off build can statically prove every
      // `import.meta.env.PHENOMENA_LOCAL_TMA === '1'` guard dead (see
      // src/layers/ancientSites/tmaLocal.js and its callers). The raw value
      // is passed through unchanged (not normalised to '1'/''); the client
      // does the strict `=== '1'` comparison, so e.g. `=0` stays off too.
      'import.meta.env.PHENOMENA_LOCAL_TMA': JSON.stringify(
        phenomenaLocalTma || '',
      ),
    },
    build: { chunkSizeWarningLimit: 1500 },
  };
}
