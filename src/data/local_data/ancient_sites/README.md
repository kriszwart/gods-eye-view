# Ancient sites bundled dataset

The dataset the ancient sites register reads does not live in this
directory. It ships in `public/ancient-sites/` (`sites.v1.json`) and, for
now, is authored by hand rather than built by a pipeline script. This file
records where that data comes from and on what terms, following the
convention of the other `src/data/local_data/*/README.md` notes.

## Current contents: a curated sample, needs review

**The 20 sites currently bundled are a hand-curated sample, not a
systematic survey.** They were chosen to cover a spread of types (temple,
circle, mound, megalith, geoglyph, settlement, underwater), periods and
continents, and each carries its own `source_url` and `attribution`. The
selection itself is illustrative: it is not exhaustive, not weighted by
significance, and has not been cross-checked field by field against every
listed source. Treat every summary, debate note and coordinate as
needing review before this data is presented as authoritative, and widen
the sample deliberately rather than treat 20 as representative of "ancient
sites" generally.

## Sources and licences

| Source | Terms |
| --- | --- |
| UNESCO World Heritage Centre (whc.unesco.org) | Published reference pages; linked per site, attributed as "UNESCO World Heritage listing" |
| The Modern Antiquarian (TMA) | Coordinates only, for the six British and European sites so marked; see below |
| National and institutional pages (Ohio History Connection, Encyclopaedia Britannica) | Linked per site as the best available primary or survey source where no UNESCO listing exists |
| Academic surveys (e.g. published site reports) | Linked per site for sites without an institutional page, attributed to the named author and paper |

## The Modern Antiquarian position

Coordinates for the British and European sites bundled from TMA
(Stonehenge, Avebury, Newgrange, Callanish, the Menec alignment at Carnac
and Ggantija) come from `anomaly-atlas-kit/pipeline/local_data/normalised/tma-sites.jsonl`,
itself built by `src/adapters/tma-kml.mjs` from a TMA KML export held only
in `local_data/raw` (git-ignored, never shipped). TMA grants no bulk
redistribution licence for its site database. Per the adapter's own
comment: only two things are allowed to leave `local_data`: coordinates
for these six individually curated sites, with attribution, and each
site's own per-site reference link, i.e. the individual TMA page a
record's `source_url` may point to. Nothing else about a site
(descriptions, visitor notes, imagery) may be derived from TMA. Where a
site marked "Coordinates: The Modern
Antiquarian" also carries a UNESCO listing, `source_url` and `unesco`
point at the UNESCO page rather than TMA, because it is the stronger
primary source; the TMA attribution stays because the coordinates
themselves were taken from TMA's survey.

## Honesty rules

Per the project ground rules: `summary` is our own neutral words, 280
characters or fewer, covering what the site is, when it dates from and
what has been found there, with no speculation. `debated` names the
genuine scholarly debate at each site, construction method, purpose or
dating, and is never framed as an "ancient alien" explanation; a schema
test enforces this. Sites are public monuments, so coordinates are
recorded exactly with no rounding, unlike the anomalies dataset's
civilian locations. Every record keeps its own source, attribution and,
where one exists, its UNESCO reference.
