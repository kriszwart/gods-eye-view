// The Modern Antiquarian KML export to plain site rows.
//   node src/adapters/tma-kml.mjs path/to/modern-antiquarian-sites.kml
// TMA grants no bulk redistribution licence: the raw KML and this adapter's
// output stay in local_data, feeding curation and cross-checking only. Only
// two things may ever leave local_data: coordinates for the individually
// curated sites this feeds, with attribution, and each site's own per-site
// reference link (the source url).

import { readFile } from 'node:fs/promises';
import { writeJsonl } from '../lib/records.mjs';
import { root } from '../lib/cli.mjs';

/**
 * Parse a Modern Antiquarian KML export into plain site rows. The raw file
 * and its output stay in local_data: TMA grants no bulk redistribution
 * licence, so this feeds curation and cross-checking only.
 */
export function parseTmaKml(xml) {
  const rows = [];
  const folders = xml.split('<Folder>').slice(1);
  for (const folder of folders) {
    const category = (/<name>([^<]+?)\s*\(\d+\)<\/name>/.exec(folder) || [])[1] || '';
    for (const m of folder.matchAll(
      /<Placemark><name>([^<]+)<\/name><description><!\[CDATA\[.*?href="([^"]+)".*?<coordinates>([-\d.]+),([-\d.]+)/gs,
    )) {
      rows.push({
        name: decodeEntities(m[1]),
        category,
        lat: Number(m[4]),
        lon: Number(m[3]),
        url: m[2],
      });
    }
  }
  return rows;
}

const decodeEntities = (s) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node src/adapters/tma-kml.mjs path/to/modern-antiquarian-sites.kml');
    process.exit(1);
  }
  const rows = parseTmaKml(await readFile(file, 'utf8'));
  await writeJsonl(root('local_data/normalised/tma-sites.jsonl'), rows);
  console.log(`TMA: ${rows.length} sites written`);
}
