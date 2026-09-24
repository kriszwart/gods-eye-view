# Anomaly atlas kit

Everything Claude Code needs to turn a fork of God's Eye View (MIT) into a futurist UAP and UFO globe.

- craft-library/: 30 procedural craft archetypes. JSON in; animated GLB, SVG glyphs and a manifest out. `preview/atlas.html` is the specimen atlas.
- pipeline/: builds the dataset from Blue Book, GEIPAN, PURSUE and the UK MoD files, with an illustrative 24-case sample.
- gev-overlay/: the anomalies layer, corona chronometer, dossier, three styles, theme, built sample data and crafts, plus `registration.patch`.
- CLAUDE.md and docs/: the brief.

## Verified (24 September 2026)
- 30 GLBs: 0 errors, 0 warnings in the Khronos glTF validator.
- Atlas preview rendered in headless Chromium, both themes, all three modes.
- Pipeline: 8 tests pass; sample round-trips through the globe's decoder.
- Shaders: all five compile in WebGL2.
- In God's Eye View: production build passes with the layer registered; 5,023 of 5,026 unit tests pass; the remaining failures are the expected "declare the new layer" checks in Phase 1.

## Not yet verified
Live-globe behaviour, adapters against the real archive files, and batch extraction against the live API.

## Quick start
1. Fork and clone God's Eye View; install Node 24.14; `npm install`; `npm run doctor`; `npm run dev`.
2. Unzip this kit into the fork root as `anomaly-atlas-kit/` and copy `CLAUDE.md` to the root.
3. Start Claude Code with Chrome connected, use plan mode, paste docs/KICKOFF_PROMPT.md.
