# Anomaly atlas (fork of God's Eye View)

We are turning God's Eye View into a futurist atlas of UAP and UFO reports: every public case on the globe, a radial time dial around the Earth, animated craft for hero cases, and case dossiers with honest sourcing.

Read before planning:
@anomaly-atlas-kit/docs/BUILD_PLAN.md
@anomaly-atlas-kit/docs/INTEGRATION_NOTES.md
@anomaly-atlas-kit/docs/DESIGN_SYSTEM.md
@anomaly-atlas-kit/docs/DATA_PIPELINE.md

docs/CURRENT-STATE.md is God's Eye View's authoritative runtime reference. It is long: search it for the feature you are touching rather than reading it whole.

## Ground rules
- Work phase by phase from BUILD_PLAN.md. Plan first, then build. One commit per task.
- Keep the repo's gates green: npm run build, npm test, npm run check:boundaries, and npm run test:track with the dev server up. Name the qa-*.mjs gate you ran.
- Node 24.14.x. Keys live in .env and are never committed.
- British English in all copy, comments and docs. No em dashes anywhere. Sentence case; no all-caps labels.
- Data honesty: no NUFORC data without a written licence. Never store witness names, addresses or verbatim narratives. Round civilian locations to about 1 km. Every record keeps its source, licence and attribution.
- The craft are generic archetypes for reported shape categories, never presented as depictions of real objects.
- Check every visual change in Chrome (claude --chrome) at 1440 and 390 px wide, light and dark.
- Match GEV style: 2 spaces, single quotes, semicolons, JSDoc on exports, and the standard layer contract.

## Where things are
- Kit: anomaly-atlas-kit/ (craft-library, pipeline, gev-overlay)
- Layer: src/layers/anomalies/ (records.js, source.js and model.js stay portable: no Cesium, no window, no document)
- Wiring: src/app/layers/anomalies.js, src/app/constructCatalog.js, src/data/layerState.js (share token 3)
- Styles: src/styles/spectral.js, radar.js, infrared.js, registered in STYLES in src/ui/visualPresets.js
- Theme: src/ui/styles/anomaly-atlas.css
- Data, crafts and glyphs: public/anomalies/

## Commands
- Craft library: cd anomaly-atlas-kit/craft-library && npm install && npm run build && npm run validate && npm run preview
- Pipeline tests and sample: cd anomaly-atlas-kit/pipeline && npm test && npm run sample
- Rebuild app data: from pipeline/, node src/build-dataset.mjs --out ../../public/anomalies
