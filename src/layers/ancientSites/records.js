/** Decode ancient.sites.v1. Portable: no rendering engine, no browser globals. */
export function normalizeAncientSites(json) {
  if (json?.schema !== 'ancient.sites.v1' || !Array.isArray(json.sites))
    throw new TypeError('Unsupported ancient sites payload');
  return json.sites.map((s) => {
    if (typeof s.id !== 'string' || !s.id)
      throw new TypeError('Site id missing');
    if (!(Math.abs(s.lat) <= 90) || !(Math.abs(s.lon) <= 180))
      throw new TypeError(`Bad coordinates on ${s.id}`);
    return { ...s };
  });
}
