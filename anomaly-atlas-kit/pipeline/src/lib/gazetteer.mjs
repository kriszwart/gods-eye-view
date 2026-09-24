// Offline geocoding against a GeoNames dump (CC BY 4.0, attribute GeoNames).
// Download cities1000.zip or cities5000.zip from download.geonames.org into
// local_data/geonames/ and unzip it. No API calls, fully reproducible.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { stripAccents } from './normalise.mjs';

export const placeKey = (s) => stripAccents(String(s ?? '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const US_STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
  washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC', 'd c': 'DC',
};

/** Split "Socorro, New Mexico" into a locality plus admin and country hints. */
export function parsePlace(text) {
  const parts = String(text ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const locality = parts[0] || '';
  const hints = parts.slice(1).map(placeKey);
  let country = null;
  let admin1 = null;
  for (const h of hints) {
    if (US_STATES[h]) {
      admin1 = US_STATES[h];
      country = 'US';
    } else if (/^[a-z]{2}$/.test(h) && Object.values(US_STATES).includes(h.toUpperCase())) {
      admin1 = h.toUpperCase();
      country = 'US';
    }
  }
  return { locality, country, admin1, hints };
}

function precisionFor(pop) {
  if (pop > 1_000_000) return 15;
  if (pop > 100_000) return 8;
  if (pop > 10_000) return 4;
  return 3;
}

export async function loadGazetteer(file, { altNamesMinPop = 15000 } = {}) {
  const byName = new Map();
  const add = (name, e) => {
    const k = placeKey(name);
    if (!k) return;
    const list = byName.get(k);
    if (!list) byName.set(k, [e]);
    else if (!list.includes(e)) list.push(e);
  };
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    const f = line.split('\t');
    if (f.length < 15) continue;
    const e = { name: f[1], lat: +f[4], lon: +f[5], cc: f[8], a1: f[10], a2: f[11], pop: +f[14] || 0 };
    add(f[1], e);
    add(f[2], e);
    if (e.pop >= altNamesMinPop) for (const alt of (f[3] || '').split(',')) if (alt && alt.length < 40) add(alt, e);
  }
  for (const list of byName.values()) list.sort((a, b) => b.pop - a.pop);
  return {
    size: byName.size,
    lookup(name, { country, admin1, admin2 } = {}) {
      let list = byName.get(placeKey(name)) || [];
      if (country) list = list.filter((e) => e.cc === country);
      if (admin1) list = list.filter((e) => e.a1 === admin1);
      if (admin2) list = list.filter((e) => e.a2 === admin2);
      const e = list[0];
      if (!e) return null;
      return { lat: e.lat, lon: e.lon, place: e.name, country: e.cc, precision_km: precisionFor(e.pop), geocoder: 'geonames', ambiguous: list.length > 1 };
    },
  };
}
