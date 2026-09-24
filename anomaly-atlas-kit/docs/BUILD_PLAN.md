# Build plan

Each phase ends with its acceptance checks passing and a short note in CHANGELOG.md.

## Phase 0: baseline
- Fork bilawalsidhu/gods-eye-view, clone, create branch `anomaly-atlas`.
- Node 24.14.x, `npm install`, `npm run doctor`, `npm run dev` (http://localhost:4173).
- Record baseline results of `npm run build` and `npm test`.

Acceptance: the untouched fork boots keyless and its gates are green (or known failures are written down).

## Phase 1: the layer, with sample data
1. Copy `anomaly-atlas-kit/gev-overlay/src` and `public` into the fork. Apply `gev-overlay/registration.patch` (adds the layer to the catalogue and share token 3).
2. Declare the new modules in `scripts/package-boundaries.json`, following how earthquakes is declared. The check currently reports: "Package boundary application-components imports an unowned module: src/layers/anomalies/model.js".
3. Update the two registry tests that pin the exact layer list: "catalogs construct distinct layers and classification from their supplied source" and "production registry is exact, canonical, and rejects incomplete contracts".
4. Import `src/ui/styles/anomaly-atlas.css` where GEV imports its stylesheets, add the Google Fonts link for Martian Mono and IBM Plex Sans to index.html, and add `class="anomaly-atlas"` to `<html>`.
5. Clicks: the layer currently owns a ScreenSpaceEventHandler. If it fights GEV's own selection, route picks through `src/data/pickRegistry.js` and the entity context system instead.
6. Frames: hero craft request renders on every clock tick while visible. Replace that with a hold through `src/renderGovernor.js`.
7. Optional: hero case labels via `overlayHost.setEntries`, modelled on the earthquake labels.

Acceptance:
- The layer toggles from the panel and the 24 sample points appear.
- The chronometer wraps the globe when zoomed out and collapses to a bottom band when zoomed in. Drag and arrow keys change the year; Play steps through years.
- Hero craft animate at their locations; clicking a point or craft opens the dossier; Escape closes it.
- A share link with token 3 restores the layer.
- All gates green; screenshots at 1440 and 390 px.

## Phase 2a: Phenomena shell (see PHENOMENA_DESIGN.md)
- Rebrand product-facing strings to Phenomena: title, header wordmark, boot loader, welcome copy. Tagline "The unexplained, mapped". Internal ids do not move.
- Tune the overlay's globe upgrades on the live globe: atlas atmosphere and night side, arrival pulses, the hero-case tour and the legend. Screenshot each against stock GEV.
- Register Spectral, Radar and Infrared in STYLES with presets. Spectral is the atlas default. Infrared calls `layer.setInfrared(true)` so infrared-only craft appear.
- Apply DESIGN_SYSTEM.md across panels: hairline plates with registration corners instead of rounded glass, one accent per register, sentence case. Add the gold deep-time token.
- A "Phenomena mode" preset that hides unrelated layers by default without removing them.
- A legend explaining brightness, hue, the ion ring on hero cases and amber for contested claims.

Acceptance: the name appears in title, header and loader; side-by-side screenshots against stock GEV read as a different product; text contrast meets WCAG AA; reduced motion respected; focus always visible.

## Phase 2b: ancient sites sample (see PHENOMENA_DESIGN.md)
- New `ancient-sites` layer, share token 4, standard contract, portable modules, curated sample of about 20 documented sites in `public/ancient-sites/`.
- Gold register: static grounded markers and stone glyphs, no craft, no pulses, unaffected by the year dial. Dossier carries the debated line and a source link.
- Boundary declarations, registry test bumps, pick registry ownership (`ancient:` ids), overlay host labels.

Acceptance: sites toggle on and off; the year dial does not affect them; dossiers show debate and source; a token 4 share link restores the layer; gates green; the qa gate covers it.

## Phase 2c: spotter MVP (see PHENOMENA_DESIGN.md)
- Portable core `src/spotter/` (bearing, distance, ranking; unit tested) and app wiring `src/app/spotter.js` with the Spotter panel.
- Now-mode only: candidates from flights, military, satellites and Starlink, launches and lightning. Read-only over layer data. Honest fallback when nothing matches.

Acceptance: with fixture feeds a known aircraft ranks first with correct bearing and distance; an empty sky yields the honest fallback; gates green; qa-spotter passes.

## Phase 3: real data, structured sources
- GEIPAN: download the CSVs, run `node src/adapters/geipan.mjs --inspect`, correct `config/geipan-columns.json`, download GeoNames cities1000 (CC BY 4.0) into `pipeline/local_data/geonames/`, run the adapter, add the GEIPAN case URL pattern.
- Blue Book: download `catalog-export-597821.json`, run `npm run bluebook:index`, tighten field names from the keys it prints.
- Build the dataset, update DATA_SOURCES.md, add an in-app sources and credits panel.

Acceptance: at least 3,000 GEIPAN cases placed with grades A to D mapped; zero invalid records in the build; attribution visible in the app.

## Phase 4: extraction
- Blue Book record cards: `npm run bluebook:requests -- --limit 50`, submit with `npm run batch submit`, fetch, ingest, then check all 50 against the scans by hand. Tune the prompt, then run the full set.
- PURSUE: download release bundles in the browser, then requests, batch, ingest. Link videos to hero cases by hand (Director media packs cap assets at 8 MiB, so link out or trim).
- Replace the illustrative sample with verified hero cases, each with a primary source link.

Acceptance: at least 95% field accuracy on a random 100 Blue Book cards; review queue under 10%; a grep test proves no names in any summary.

## Phase 5: coverage
- UK MoD files: split PDFs into page ranges, extract, link duplicates across sources.
- Further national archives only where reuse terms are clear. NUFORC only with a written licence.

## Phase 5b: ancient sites sweep (see PHENOMENA_DESIGN.md)
- Full ancient-sites dataset from Wikidata (CC0) and UNESCO through the pipeline, replacing the curated sample.
- Deep-time dial mode for the chronometer.

## Phase 6: performance and release
- If frame time suffers, move points to a GPU point cloud (glTF POINTS with year attributes and a CustomShader) and pick with a CPU spatial index.
- Voice: filter by shape, year and source, fly to a case, play the dial (actionSchemas.js, server tools.js, gevActions.js).
- test:track, relevant qa gates, and the checks in docs/PERFORMANCE.md.
