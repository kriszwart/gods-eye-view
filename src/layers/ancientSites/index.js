import * as Cesium from 'cesium';
import {
  ANCIENT_LAYER_ID,
  mapAnalystRecord,
  mapSweepAnalystRecord,
  createAncientOverlayEntry,
} from './model.js';
import { createAncientRenderer } from './rendering.js';
import { safeSourceUrl, safeImageUrl } from '../../sources/safeUrl.js';
import { createTmaLocalSource, TMA_ID_PREFIX } from './tmaLocal.js';
export * from './model.js';
export { normalizeAncientSites, normalizeAncientSitesV2 } from './records.js';
export { createAncientSource } from './source.js';

/**
 * Local-only Modern Antiquarian register (see tmaLocal.js): every reference
 * to it below sits behind this constant, folded to a literal `false` when
 * `PHENOMENA_LOCAL_TMA` is unset, so a production build can prove the whole
 * branch dead and drop it, its dossier text included.
 */
const LOCAL_TMA_ENABLED = import.meta.env?.PHENOMENA_LOCAL_TMA;

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * Curated ancient and disputed-archaeology sites, shown as a static gold
 * register with a dossier per site, plus a worldwide Wikidata sweep of tens
 * of thousands more. Implements the standard GEV layer contract, without the
 * anomalies layer's chronometer, atmosphere, tour or craft: this is a calm,
 * unmoving companion register with no year-dial coupling.
 *
 * The hero tier (curated, photographed, debated) is unclustered and always
 * addressable by id, exactly as before this layer carried the sweep. The
 * sweep never clusters by identity: `rendering.js` bands it by camera height
 * into grid clusters and singles, so ~81k sites do not become ~81k
 * primitives at once. A sweep site's dossier is compact — name, type,
 * country, a Wikidata link and a Wikipedia link when the sweep flagged one —
 * because the sweep carries no photo, debate or era column (see the phase
 * 5b task 2 report on the omitted `bce` column).
 *
 * A third, local-only register, The Modern Antiquarian (`tmaLocal.js`), can
 * add unclustered gold points with a compact dossier and record link when
 * `PHENOMENA_LOCAL_TMA` is set at build time. TMA's terms permit curation
 * and per-site links only, never bulk redistribution, so this register
 * never ships: see `LOCAL_TMA_ENABLED` above, `server/providers/local-tma.js`
 * for the dev server's own env gate, and DATA_SOURCES.md for the owner note.
 */
export function createAncientSitesLayer({
  source,
  overlayHost,
  picking,
  render,
  assetBase = '/ancient-sites/',
  container,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Ancient sites require a snapshot source');
  let viewer = null;
  let renderer = null;
  let dossier = null;
  let heroRows = [];
  let sweepAccessor = null;
  let tmaRows = [];
  let totalCount = 0;
  let enabled = false;
  let loaded = false;
  let request = null;
  let lastUpdate = null;
  let lastError = null;
  let clickHandler = null;

  function openHeroDossier(id) {
    const row = heroRows.find((r) => r.id === id);
    if (!row || !dossier) return;
    const sourceUrl = safeSourceUrl(row.source_url);
    const wikipediaUrl = safeSourceUrl(row.wikipedia);
    const streetViewUrl = safeSourceUrl(
      `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${row.lat.toFixed(4)},${row.lon.toFixed(4)}`,
    );
    const credit = row.image_attribution;
    const attributed = !!(credit?.author && credit?.licence);
    const imageUrl = attributed ? safeImageUrl(row.image) : null;
    dossier.innerHTML = `
      <button type="button" class="uap-close" aria-label="Close site">Close</button>
      <h2>${escapeHtml(row.name)}</h2>
      <img class="uap-glyph" alt="" src="${assetBase}glyphs/${escapeHtml(row.glyph)}.svg">
      ${imageUrl ? `<img class="uap-photo" alt="${escapeHtml(row.name)}" loading="lazy" src="${escapeHtml(imageUrl)}">` : ''}
      ${imageUrl ? `<p class="uap-photo-credit">Photo: ${escapeHtml(credit.author)}, ${escapeHtml(credit.licence)}</p>` : ''}
      <dl>
        <dt>Period</dt><dd>${escapeHtml(row.period)}</dd>
        <dt>Country</dt><dd>${escapeHtml(row.country)}</dd>
        <dt>Type</dt><dd>${escapeHtml(row.type)}</dd>
      </dl>
      ${row.debated ? `<p class="uap-debated">Debated: ${escapeHtml(row.debated)}</p>` : ''}
      <p class="uap-summary">${escapeHtml(row.summary)}</p>
      ${
        sourceUrl || wikipediaUrl || streetViewUrl
          ? `<p class="uap-source">${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Open record</a>` : ''}${wikipediaUrl ? `<a href="${escapeHtml(wikipediaUrl)}" target="_blank" rel="noopener noreferrer">Wikipedia</a>` : ''}${streetViewUrl ? `<a href="${escapeHtml(streetViewUrl)}" target="_blank" rel="noopener noreferrer">Street view</a>` : ''}</p>`
          : ''
      }
      ${row.attribution ? `<p class="uap-attribution">${escapeHtml(row.attribution)}</p>` : ''}`;
    dossier.hidden = false;
    dossier.querySelector('.uap-close').focus();
  }

  /**
   * Compact dossier for a single worldwide-sweep site: no photo or debate
   * (hero-only), no era (the sweep ships no bce column). A Wikidata link is
   * always available (every sweep row carries a qid); the Wikipedia link
   * only appears when the sweep flagged an enwiki title for this row.
   */
  function openSweepDossier(index) {
    if (
      !dossier ||
      !sweepAccessor ||
      index < 0 ||
      index >= sweepAccessor.length
    )
      return;
    const name = sweepAccessor.name(index);
    const typeName = sweepAccessor.typeName(index);
    const countryName = sweepAccessor.countryName(index);
    const qid = sweepAccessor.qid(index);
    const wikiTitle = sweepAccessor.wikiTitle(index);
    const lat = sweepAccessor.lat(index);
    const lon = sweepAccessor.lon(index);
    const wikidataUrl = safeSourceUrl(`https://www.wikidata.org/wiki/${qid}`);
    const wikipediaUrl = wikiTitle
      ? safeSourceUrl(`https://en.wikipedia.org/wiki/${wikiTitle}`)
      : null;
    const streetViewUrl = safeSourceUrl(
      `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(4)},${lon.toFixed(4)}`,
    );
    dossier.innerHTML = `
      <button type="button" class="uap-close" aria-label="Close site">Close</button>
      <h2>${escapeHtml(name)}</h2>
      <dl>
        <dt>Type</dt><dd>${escapeHtml(typeName)}</dd>
        <dt>Country</dt><dd>${escapeHtml(countryName || 'Unrecorded')}</dd>
      </dl>
      ${
        wikidataUrl || wikipediaUrl || streetViewUrl
          ? `<p class="uap-source">${wikidataUrl ? `<a href="${escapeHtml(wikidataUrl)}" target="_blank" rel="noopener noreferrer">Wikidata</a>` : ''}${wikipediaUrl ? `<a href="${escapeHtml(wikipediaUrl)}" target="_blank" rel="noopener noreferrer">Wikipedia</a>` : ''}${streetViewUrl ? `<a href="${escapeHtml(streetViewUrl)}" target="_blank" rel="noopener noreferrer">Street view</a>` : ''}</p>`
          : ''
      }`;
    dossier.hidden = false;
    dossier.querySelector('.uap-close').focus();
  }

  /**
   * Compact dossier for a local-only Modern Antiquarian row: name, category
   * and its own record link, no photo or debate. Never reachable unless
   * `LOCAL_TMA_ENABLED` gated this register on at build time.
   */
  function openTmaDossier(id) {
    const row = tmaRows.find((r) => r.id === id);
    if (!row || !dossier) return;
    const sourceUrl = safeSourceUrl(row.url);
    dossier.innerHTML = `
      <button type="button" class="uap-close" aria-label="Close site">Close</button>
      <h2>${escapeHtml(row.name)}</h2>
      <dl>
        <dt>Category</dt><dd>${escapeHtml(row.category || 'Unrecorded')}</dd>
      </dl>
      ${sourceUrl ? `<p class="uap-source"><a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Open record</a></p>` : ''}
      <p class="uap-attribution">Source: The Modern Antiquarian. Local reference only, not included in the shared dataset.</p>`;
    dossier.hidden = false;
    dossier.querySelector('.uap-close').focus();
  }

  /** Clicking a badge flies the camera one band closer, centred on it. */
  async function flyToCluster(index) {
    const cluster = renderer?.getCluster(index);
    if (!cluster || !viewer) return;
    const targetHeight = renderer.nextBandTargetHeight();
    await new Promise((resolve) =>
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          cluster.lon,
          cluster.lat,
          targetHeight,
        ),
        duration: 1.5,
        complete: resolve,
        cancel: resolve,
      }),
    );
  }

  /** Pick-registry ownership test: `ancient:` and `ancient-cluster:` always;
   * `tma:` only when the local-only register is build-time enabled, so an
   * unset flag never registers interest in an id prefix it never emits. */
  function isOwnedPickId(pickedId) {
    if (!enabled || typeof pickedId !== 'string') return false;
    if (
      pickedId.startsWith('ancient:') ||
      pickedId.startsWith('ancient-cluster:')
    )
      return true;
    return LOCAL_TMA_ENABLED && pickedId.startsWith(TMA_ID_PREFIX);
  }

  function handlePick(picked) {
    if (!picked) return;
    if (picked.kind === 'hero') return openHeroDossier(picked.id);
    if (picked.kind === 'sweep') return openSweepDossier(picked.index);
    if (picked.kind === 'cluster') return void flyToCluster(picked.index);
    if (LOCAL_TMA_ENABLED && picked.kind === 'tma')
      return openTmaDossier(picked.id);
  }

  const layer = {
    id: ANCIENT_LAYER_ID,
    name: 'Ancient sites',
    icon: '△',
    source: 'Curated sample + Wikidata sweep',
    updateInterval: -1,

    init(v) {
      if (viewer) throw new Error('Ancient sites layer is already initialized');
      viewer = v;
      renderer = createAncientRenderer(viewer, { render });
      const host = container || viewer.container;
      dossier = document.createElement('aside');
      dossier.className = 'uap-dossier ancient';
      dossier.hidden = true;
      dossier.setAttribute('aria-label', 'Site dossier');
      dossier.addEventListener(
        'click',
        (e) => e.target.closest('.uap-close') && (dossier.hidden = true),
      );
      dossier.addEventListener(
        'keydown',
        (e) => e.key === 'Escape' && (dossier.hidden = true),
      );
      host.appendChild(dossier);
      overlayHost?.setVisible?.(ANCIENT_LAYER_ID, false);
      console.log('[Data:AncientSites] Initialized');
    },

    enable() {
      enabled = true;
      renderer?.apply({ visible: true });
      overlayHost?.setVisible?.(ANCIENT_LAYER_ID, true);
      if (!clickHandler) {
        clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        clickHandler.setInputAction(
          (e) => handlePick(renderer?.pick(e.position)),
          Cesium.ScreenSpaceEventType.LEFT_CLICK,
        );
      }
      picking?.registerPickOwner?.(ANCIENT_LAYER_ID, isOwnedPickId);
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      picking?.unregisterPickOwner?.(ANCIENT_LAYER_ID);
      if (dossier) dossier.hidden = true;
      clickHandler?.destroy();
      clickHandler = null;
      renderer?.apply({ visible: false });
      overlayHost?.setVisible?.(ANCIENT_LAYER_ID, false);
    },

    async update() {
      if (!enabled || !renderer) return false;
      // The register is static once fetched, so a loaded layer's update() on
      // a repeat enable is an idempotent success, not a failure.
      if (loaded) return true;
      request?.abort();
      const current = new AbortController();
      request = current;
      try {
        const next = await source.getSnapshot({ signal: current.signal });
        if (current.signal.aborted || request !== current || !enabled)
          return false;
        heroRows = next.heroes;
        sweepAccessor = next.sweep;
        totalCount = next.count;
        renderer.setHeroes(heroRows);
        renderer.setSweep(sweepAccessor);
        if (LOCAL_TMA_ENABLED) {
          // Best-effort: a missing or unreachable local file never fails the
          // public dataset's own load, since this register is a dev-only
          // owner convenience, not part of the layer's real contract.
          try {
            tmaRows = await createTmaLocalSource().getRows({
              signal: current.signal,
            });
          } catch (error) {
            tmaRows = [];
            console.warn(
              '[Data:AncientSites] Local TMA register unavailable:',
              error,
            );
          }
          if (current.signal.aborted || request !== current || !enabled)
            return false;
          renderer.setTma(tmaRows);
        }
        // Overlay labels stay hero-only: the sweep is far too dense for the
        // ambient-label lane, and its cluster badges already carry their own
        // Cesium-native count text (see rendering.js).
        overlayHost?.setEntries?.(
          ANCIENT_LAYER_ID,
          heroRows.map((r) =>
            createAncientOverlayEntry({
              id: r.id,
              position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 200),
              name: r.name,
            }),
          ),
          { moving: false },
        );
        loaded = true;
        lastUpdate = Date.now();
        lastError = null;
        console.log(
          `[Data:AncientSites] Loaded ${heroRows.length} hero sites and ${sweepAccessor.length} sweep sites (${totalCount} total)`,
        );
        return true;
      } catch (error) {
        if (current.signal.aborted) return false;
        lastError = error?.message || 'Ancient sites dataset unavailable';
        console.warn('[Data:AncientSites] Load error:', error);
        return false;
      } finally {
        if (request === current) request = null;
      }
    },

    destroy() {
      layer.disable();
      overlayHost?.clearSource?.(ANCIENT_LAYER_ID);
      renderer?.destroy();
      dossier?.remove();
      renderer = null;
      dossier = null;
      viewer = null;
      heroRows = [];
      sweepAccessor = null;
      tmaRows = [];
      totalCount = 0;
      loaded = false;
    },

    /** Analyst records, heroes first (richer dossiers) then sweep rows. */
    getAnalystRecords(maxCount = 2000) {
      if (!enabled) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const heroRecords = heroRows.slice(0, limit).map(mapAnalystRecord);
      if (heroRecords.length >= limit || !sweepAccessor) return heroRecords;
      const remaining = limit - heroRecords.length;
      const sweepRecords = [];
      for (
        let i = 0;
        i < sweepAccessor.length && sweepRecords.length < remaining;
        i += 1
      ) {
        sweepRecords.push(mapSweepAnalystRecord(sweepAccessor, i));
      }
      return [...heroRecords, ...sweepRecords];
    },

    getStats() {
      return { count: totalCount, lastUpdate, error: lastError };
    },

    /** Diagnostic hook (also used by qa): rendered primitive counts and the
     * camera band currently driving sweep clustering. */
    getRenderDiagnostics() {
      return renderer?.getDiagnostics() ?? null;
    },

    /** Voice and UI hook: fly to a hero site and open its dossier. */
    async focusSite(id) {
      const row = heroRows.find((r) => r.id === id);
      if (!row || !viewer) return;
      await new Promise((resolve) =>
        viewer.camera.flyToBoundingSphere(
          new Cesium.BoundingSphere(
            Cesium.Cartesian3.fromDegrees(row.lon, row.lat, 0),
            500,
          ),
          {
            offset: new Cesium.HeadingPitchRange(
              0,
              Cesium.Math.toRadians(-30),
              6000,
            ),
            duration: 2.5,
            complete: resolve,
            cancel: resolve,
          },
        ),
      );
      openHeroDossier(id);
    },
  };
  return layer;
}
