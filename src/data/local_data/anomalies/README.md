# Anomaly atlas bundled dataset

The dataset the anomalies layer reads does not live in this directory. It
ships in `public/anomalies/` (`anomalies.v1.json`, `cases.v1.json`,
`stats.json`, plus `crafts/` and `glyphs/`) and is rebuilt from the
pipeline: from `anomaly-atlas-kit/pipeline/`, run
`node src/build-dataset.mjs --out ../../public/anomalies`. This file
records where that data comes from and on what terms, following the
convention of the other `src/data/local_data/*/README.md` notes.

## Current contents: an illustrative sample

**The 24 cases currently bundled are kit sample data, not verified
records.** Every record carries `source: 'sample'` and the attribution
"Kit sample cases; verify against primary sources". Dates, positions,
grades, explanations and summaries are plausible reconstructions of well
known public cases, written for layout and interaction work. None of it
may be presented as fact or published until each case has been checked
against its primary source. Phases 3 and 4 of
`anomaly-atlas-kit/docs/BUILD_PLAN.md` replace this sample with parsed
GEIPAN and Project Blue Book records and verified hero cases.

Known sample quirks:

- All 24 rows have the `hero` flag set, so every point carries a 3D craft
  and joins the tour. Real data reserves hero for a curated subset.
- `stats.json` counts all 24 records as needing review (`review: 24`) and
  omits the empty `insufficient` status from `byStatus`.

## Sources and licences

Licence details live in `anomaly-atlas-kit/pipeline/config/sources.json`
and every built record keeps its own `source`, licence grade and
attribution fields. In summary:

| Source | Terms |
| --- | --- |
| Sample (current) | Kit sample, not for publication until verified |
| Project Blue Book (NARA, NAID 597821) | US federal record, generally public domain; attribute NARA |
| GEIPAN (CNES) | Published open data; confirm the reuse notice on geipan.fr and attribute GEIPAN/CNES |
| PURSUE (US Department of War) | US government work, generally public domain; check files for third-party material |
| UK MoD files (TNA) | Crown copyright; Open Government Licence where TNA marks it so; attribute The National Archives |
| NUFORC | Proprietary; only with a written licence, stored alongside the data |

## Honesty rules

Per the project ground rules: no witness names, addresses or verbatim
narratives are ever stored; civilian locations are rounded to about 1 km
with the precision recorded per record; summaries are our own neutral
words; brightness in the app always encodes how unexplained a case is,
never importance; and the craft models are generic archetypes for
reported shape categories, never depictions of real objects.
