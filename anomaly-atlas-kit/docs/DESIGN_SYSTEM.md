# Design system: a post-human observatory

God's Eye View reads as a military console ("Apple meets Blade Runner": cyan accent, rounded glass panels, Inter and JetBrains Mono). The atlas is a calm scientific instrument built by someone who has watched the sky for a century. Precise, luminous, unhurried.

## Principles
1. Instrument, not interface. Tick marks, scales and units; no decoration.
2. One luminous signal. The UI is monochrome ink on a void; only anomalies carry colour.
3. Circles over boxes. The corona chronometer is the signature element. Panels are hairline plates with registration corners, not rounded cards.
4. Motion is data. Craft loops and the dial move; nothing else animates on its own.
5. Honest encoding. Brightness always means "how unexplained", never importance.

## Tokens
| Token | Dark (void) | Light (clean room) |
| --- | --- | --- |
| Background | #070812 | #EEF0F5 |
| Ink | #D9DCE6 | #0B0E17 |
| Dim | #7C8195 | #5A6072 |
| Hairline | rgba(217,220,230,.16) | rgba(11,14,23,.14) |
| Magenta | #FF2E9A | #D1127F |
| Violet | #7B5CFF | #5B3FE0 |
| Ion | #3FE0FF | #0A93B8 |
| Amber (contested) | #FFB547 | #B7700A |
| Gold (deep time, ancient sites) | #D8B36A | #8A6A2F |

Type: Martian Mono (variable width: extended for titles and years, condensed for data) and IBM Plex Sans for dossier text. Sentence case throughout.

## Encodings on the globe
- Brightness and size: how unexplained (GEIPAN D and Blue Book "unidentified" brightest).
- Hue: grey explained, violet thin data, magenta unresolved, amber contested.
- Ion ring: curated hero case with a 3D craft.
- Current year loud, earlier years faded.

## Components
- Corona chronometer: 1940 to 2026 round the globe, yearly histogram as its corona, ion needle, three filters (up to year, around year, all years). Collapses to a bottom band when zoomed in. Keyboard slider semantics.
- Dossier: hairline plate, glyph, when, where (with precision), reported as, outcome, source link, neutral summary.
- Styles: Spectral (world monochrome, spectrum kept), Radar (edges, sweep, range rings), Infrared (heat ramp in the atlas palette; reveals infrared-only craft).
- Craft: thin-film sheen at grazing angles; flat craft framed from below, as ground witnesses see them.

## Quality floor
AA contrast, visible focus, reduced motion respected, usable at 390 px, both themes.
