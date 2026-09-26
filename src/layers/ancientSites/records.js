/** v2 sweep columns; every one must be present and the same length. */
const SWEEP_COLUMNS = ['qid', 'name', 'lat', 'lon', 'type', 'country', 'wiki'];

/**
 * Decode ancient.sites.v2: a curated hero tier (the v1 shape, verbatim) plus
 * a worldwide sweep held as columnar arrays. Portable: no rendering engine,
 * no browser globals.
 *
 * The sweep is exposed as typed accessor functions over the raw columns
 * rather than materialised into ~81k row objects, so decoding is O(1) and a
 * consumer (clustering, rendering) pays only for the indices it visits.
 * `typeName`/`countryName` resolve a row's interned indices against the
 * document's `types[]`/`countries[]`, and `wikiTitle` returns the still
 * percent-encoded enwiki title segment, or `''` when the row has none.
 *
 * @param {object} json - Parsed `sites.v2.json` document.
 * @returns {{heroes: object[], sweep: {length:number, qid:(i:number)=>string,
 *   name:(i:number)=>string, lat:(i:number)=>number, lon:(i:number)=>number,
 *   typeName:(i:number)=>string, countryName:(i:number)=>string,
 *   wikiTitle:(i:number)=>string}, count:number}}
 */
export function normalizeAncientSitesV2(json) {
  if (json?.schema !== 'ancient.sites.v2')
    throw new TypeError('Unsupported ancient sites payload');
  const { heroes, types, countries, sites } = json;
  if (!Array.isArray(heroes))
    throw new TypeError('Ancient sites v2 requires heroes[]');
  if (!Array.isArray(types) || !types.length)
    throw new TypeError('Ancient sites v2 requires types[]');
  if (!Array.isArray(countries))
    throw new TypeError('Ancient sites v2 requires countries[]');
  if (!sites || typeof sites !== 'object')
    throw new TypeError('Ancient sites v2 requires a sites columnar block');
  for (const column of SWEEP_COLUMNS) {
    if (!Array.isArray(sites[column]))
      throw new TypeError(`Ancient sites v2 sweep column missing: ${column}`);
  }
  const length = sites.qid.length;
  for (const column of SWEEP_COLUMNS) {
    if (sites[column].length !== length)
      throw new TypeError(
        `Ancient sites v2 sweep column length mismatch: ${column}`,
      );
  }
  const normalizedHeroes = heroes.map((s) => {
    if (typeof s.id !== 'string' || !s.id)
      throw new TypeError('Hero site id missing');
    if (!(Math.abs(s.lat) <= 90) || !(Math.abs(s.lon) <= 180))
      throw new TypeError(`Bad coordinates on ${s.id}`);
    return { ...s };
  });
  const sweep = {
    length,
    qid: (i) => sites.qid[i],
    name: (i) => sites.name[i],
    lat: (i) => sites.lat[i],
    lon: (i) => sites.lon[i],
    typeName: (i) => types[sites.type[i]] ?? '',
    countryName: (i) => countries[sites.country[i]] ?? '',
    wikiTitle: (i) => sites.wiki[i] || '',
  };
  return {
    heroes: normalizedHeroes,
    sweep,
    count: Number.isFinite(json.count)
      ? json.count
      : normalizedHeroes.length + length,
  };
}
