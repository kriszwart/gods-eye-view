// Wikidata and Commons enrichment for the curated ancient sites.
//   node src/adapters/wikidata-enrich.mjs
// Reads config/ancient-wikidata.json (site id -> Wikidata QID, hand
// curated and label-verified; see the task report), makes one batched
// wbgetentities call for every QID, then one Commons imageinfo call per
// site that carries a P18 image (polite: 1 s between calls, a browser-ish
// user agent), and writes image, image_attribution and wikipedia fields
// into public/ancient-sites/sites.v1.json in place.
//
// Licence rule: an image ships only when its Commons LicenseShortName is a
// free licence (CC0, CC BY*, CC BY-SA*, Public domain, PDM) and it carries
// a non-empty author. Otherwise image and image_attribution stay null.

import { readFile, writeFile } from 'node:fs/promises';
import { root, loadJson } from '../lib/cli.mjs';

const USER_AGENT = 'AnomalyAtlasPipeline/1.0 (contact: kris@zwartifydesign.com)';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const IMAGE_WIDTH = 640;
const DELAY_MS = 1000;

// Matches CC0, "CC BY 2.5", "CC BY-SA 4.0" (any case/spacing/dash), Public
// domain and PDM. Deliberately does not match variants that lack the "BY"
// component (e.g. "CC SA 1.0") or vague statements like "No restrictions".
const FREE_LICENCE_RE = /^(cc0|cc[\s-]?by(-sa)?[\s-]?[\d.]*|public domain|pdm|pd[\s-]?us)/i;

/** Strip HTML tags and decode the handful of entities Commons emits, textContent-style. */
export function stripHtml(html) {
  if (html == null) return '';
  const text = String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

/** True when a Commons LicenseShortName is a free licence we may ship. */
export function isFreeLicence(shortName) {
  return !!shortName && FREE_LICENCE_RE.test(String(shortName).trim());
}

/** Special:FilePath URL for a Commons file name, at the given width. */
export function filePathUrl(filename, width = IMAGE_WIDTH) {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}?width=${width}`;
}

/** The P18 (image) Commons file name from a wbgetentities entity, or null. */
export function imageFilename(entity) {
  return entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value ?? null;
}

/** The enwiki article URL from a wbgetentities entity's sitelinks, or null. */
export function wikipediaUrl(entity) {
  const title = entity?.sitelinks?.enwiki?.title;
  if (!title) return null;
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

/**
 * Licence and HTML-stripped author from a Commons imageinfo response
 * (`action=query&prop=imageinfo&iiprop=extmetadata`), or null when the
 * licence is not free, or when a free licence carries no usable author.
 */
export function attributionFromImageInfo(imageInfoResponse) {
  const pages = imageInfoResponse?.query?.pages ?? {};
  const page = Object.values(pages)[0];
  const meta = page?.imageinfo?.[0]?.extmetadata;
  if (!meta) return null;
  const licence = meta.LicenseShortName?.value ?? null;
  if (!isFreeLicence(licence)) return null;
  const author = stripHtml(meta.Artist?.value);
  if (!author) return null;
  return { licence, author };
}

/**
 * Merge one site's Wikidata entity and (when it has an image) Commons
 * imageinfo response into its record. Field order is stable: the site's
 * own fields first, then image, image_attribution, wikipedia, always in
 * that order regardless of whether image ended up null.
 */
export function enrichSite(site, entity, imageInfoResponse) {
  const filename = imageFilename(entity);
  const attribution = filename ? attributionFromImageInfo(imageInfoResponse) : null;
  return {
    ...site,
    image: attribution ? filePathUrl(filename) : null,
    image_attribution: attribution,
    wikipedia: wikipediaUrl(entity),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function fetchEntities(qids) {
  const url = `${WIKIDATA_API}?action=wbgetentities&ids=${qids.join('|')}&props=claims|sitelinks&format=json`;
  const data = await fetchJson(url);
  return data.entities ?? {};
}

async function fetchImageInfo(filename) {
  const url = `${COMMONS_API}?action=query&titles=${encodeURIComponent(`File:${filename}`)}&prop=imageinfo&iiprop=extmetadata&format=json`;
  return fetchJson(url);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const qidMap = await loadJson('config/ancient-wikidata.json');
  const sitesFile = root('../../public/ancient-sites/sites.v1.json');
  const dataset = JSON.parse(await readFile(sitesFile, 'utf8'));

  const qids = dataset.sites.map((s) => qidMap[s.id]).filter(Boolean);
  if (qids.length !== dataset.sites.length) {
    const missing = dataset.sites.filter((s) => !qidMap[s.id]).map((s) => s.id);
    throw new Error(`No Wikidata QID configured for: ${missing.join(', ')}`);
  }

  console.log(`Wikidata: fetching ${qids.length} entities in one call`);
  const entities = await fetchEntities(qids);

  const enriched = [];
  const notes = [];
  for (const site of dataset.sites) {
    const qid = qidMap[site.id];
    const entity = entities[qid];
    if (!entity) {
      notes.push(`${site.id}: QID ${qid} not found in wbgetentities response`);
      enriched.push({ ...site, image: null, image_attribution: null, wikipedia: null });
      continue;
    }
    const filename = imageFilename(entity);
    let imageInfoResponse = null;
    if (filename) {
      await sleep(DELAY_MS);
      imageInfoResponse = await fetchImageInfo(filename);
    } else {
      notes.push(`${site.id} (${qid}): no P18 image on the Wikidata item`);
    }
    const result = enrichSite(site, entity, imageInfoResponse);
    if (filename && !result.image) {
      const meta = Object.values(imageInfoResponse?.query?.pages ?? {})[0]?.imageinfo?.[0]?.extmetadata;
      const licence = meta?.LicenseShortName?.value ?? '(unknown)';
      const author = stripHtml(meta?.Artist?.value);
      notes.push(
        `${site.id} (${qid}): image "${filename}" excluded, licence="${licence}"${!isFreeLicence(licence) ? ' (not a free licence)' : author ? '' : ' (free licence but no author recorded)'}`,
      );
    }
    if (!result.wikipedia) notes.push(`${site.id} (${qid}): no enwiki sitelink`);
    enriched.push(result);
  }

  dataset.sites = enriched;
  await writeFile(sitesFile, JSON.stringify(dataset, null, 2) + '\n');

  console.log(`Wrote ${enriched.length} enriched sites to ${sitesFile}`);
  console.log(`Images shipped: ${enriched.filter((s) => s.image).length}/${enriched.length}`);
  for (const n of notes) console.log(`  note: ${n}`);
}
