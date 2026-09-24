# Data pipeline

Raw files stay local (`pipeline/local_data/raw`, git-ignored). Only the built outputs in `public/anomalies/` ship.

## Sources (details and licences in config/sources.json)
| Source | Scale | Access | Method |
| --- | --- | --- | --- |
| Project Blue Book (NARA, NAID 597821) | 12,618 sightings, 701 unidentified | Bulk JSON metadata, then first page of each case | Vision extraction of record cards |
| GEIPAN (CNES) | 3,208 cases at April 2025 | CSV download | Parser |
| PURSUE (war.gov/UFO) | 6 releases, about 447 files | Manual browser download (site blocks bots) | PDF extraction |
| UK MoD files (TNA) | about 209 files, 52,000 pages | PDF download | PDF extraction, page ranges |
| NUFORC | | Only with written permission | Licensed parser, no narratives |
| The Modern Antiquarian | 17,392 sites | KML export, local only | no redistribution licence; curation and cross-checking only; per-site reference links allowed |

Kaggle, Maven Analytics and CORGIS UFO sets all derive from the same 2014 NUFORC scrape and are excluded.

## Flow
adapter, then extraction (Batch API) where needed, then ingest to `local_data/normalised/*.jsonl`, then `build-dataset.mjs` validates, redacts, links cross-source duplicates and writes `anomalies.v1.json`, `cases.v1.json` and `stats.json`.

## Extraction
- `src/extract/batch.mjs submit | status | fetch` against the Message Batches API: half the standard price, up to 100,000 requests or 256 MB per batch, most finish within an hour. Needs ANTHROPIC_API_KEY. Model via EXTRACT_MODEL (default claude-sonnet-5; try claude-haiku-4-5-20251001 on a sample to compare cost).
- Always start with `--limit 50` and check by hand.
- Low confidence or ambiguous places go to `*.review.jsonl`.

## Privacy and honesty
- No names, addresses, phone numbers or verbatim narratives; `redact.mjs` is the safety net after the prompt.
- Civilian locations rounded to about 1 km; precision stored per record.
- Each record keeps its source's own grade alongside the shared status.
- Summaries are our own neutral words, 280 characters or fewer.

## Commands
npm test, npm run sample, npm run geipan, npm run bluebook:index, npm run bluebook:requests, npm run batch submit <file>, npm run bluebook:ingest, npm run pursue:requests, npm run ukmod:requests, npm run build
