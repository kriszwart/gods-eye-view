# Integration notes (God's Eye View at 513dc87, 23 September 2026)

## What was verified in a sandbox
- With the overlay copied in and `registration.patch` applied: `npm ci` and the Vite production build pass, and `public/anomalies` lands in `dist/`.
- `check-import-directions` passes across 822 modules. The package-boundary check fails only because the new modules are not yet declared.
- Unit suite: 5,023 of 5,026 pass. The two failures are the registry tests that pin the exact layer list; the layer's own tests pass.
- All five shaders compile in WebGL2 with Cesium-style preludes.
- Not verified: behaviour on a live globe. The sandbox had no map imagery or browser session.

## Contracts the layer follows
- Layer object: id, name, icon, source, updateInterval, init, enable, disable, async update, destroy, getAnalystRecords, getStats. Earthquakes is the closest template.
- Catalogue: add the factory to the list in `src/app/constructCatalog.js`.
- Share state: `LAYER_STATE_REGISTRY` in `src/data/layerState.js`. Every letter plus 1 and 2 were taken; 3 is used for anomalies.
- Portable modules (source, records, model) must not import Cesium or touch browser globals.
- Styles: modules export `{ name, uniforms, fragmentShader }`; uniforms carry default, min, max and label. Time comes from `czm_frameNumber`.
- Voice: `src/voice/actionSchemas.js`, `server/providers/openai/tools.js`, `src/voice/gevActions.js`.

## Useful existing pieces
- `src/celestialRing.js` already projects the Earth's disc to the screen (`earthDiscScreenRadius`, `projectEarthDiscToViewport`). The chronometer computes its own disc; consider reusing these.
- `src/data/tr3bRegistry.js` is GEV's black-triangle Easter egg. A natural tie-in: show the `triangle` craft when a contact is converted.
- Director data packs (docs/DIRECTOR-DATA-PACKS.md) suit guided tours of hero cases with media.

## Layer API beyond the contract
`setYear(year)`, `setInfrared(on)`, `focusCase(id)` for voice and UI.

## Globe upgrades added in the overlay (24 September 2026, build verified)
- `atmosphere.js`: when the layer is on, a cooler, deeper sky, a void background, a lit night side and no moon. Everything is restored exactly on disable. Pass `atmosphere: false` to opt out.
- Arrival pulses: rings bloom at each report as the dial reaches its year (capped at 400 per year).
- Guided tour: "Tour hero cases" on the dial flies through hero cases in date order, sets the year and opens each dossier. Also `layer.playTour()` and `layer.stopTour()` for voice.
- Legend: what brightness, hue and the ion ring mean.
- Still to check on a live globe: tour camera distances, pulse density in busy years, and whether lighting suits Google 3D tiles at street level.
