// Pure helpers shared by every adapter: dates, grades, shapes, ids, rounding.

export const STATUSES = ['explained', 'insufficient', 'contested', 'unresolved'];

const MONTHS = {
  jan: 1, january: 1, janvier: 1, feb: 2, february: 2, fevrier: 2, mar: 3, march: 3, mars: 3,
  apr: 4, april: 4, avril: 4, may: 5, mai: 5, jun: 6, june: 6, juin: 6, jul: 7, july: 7, juillet: 7,
  aug: 8, august: 8, aout: 8, sep: 9, sept: 9, september: 9, septembre: 9, oct: 10, october: 10, octobre: 10,
  nov: 11, november: 11, novembre: 11, dec: 12, december: 12, decembre: 12,
};

export const stripAccents = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function dateOf(y, m, d, precision) {
  if (y < 1800 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  const mm = String(m).padStart(2, '0');
  const iso = precision === 'year' ? `${y}` : precision === 'month' ? `${y}-${mm}` : date.toISOString().slice(0, 10);
  return { iso, precision, year: y, days: Math.floor(date.getTime() / 86400000) };
}

/** Parse ISO, European day-first numeric dates, or month-name dates (EN/FR). */
export function parseDate(value) {
  const s = String(value ?? '').trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return dateOf(+m[1], +m[2], +m[3], 'day');
  if ((m = s.match(/^(\d{4})-(\d{2})$/))) return dateOf(+m[1], +m[2], 1, 'month');
  if ((m = s.match(/^(\d{4})$/))) return dateOf(+m[1], 1, 1, 'year');
  if ((m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})/))) return dateOf(+m[3], +m[2], +m[1], 'day');
  const words = stripAccents(s.toLowerCase()).replace(/[,.]/g, ' ').split(/\s+/).filter(Boolean);
  let y;
  let mo;
  let d;
  for (const w of words) {
    if (/^\d{4}$/.test(w)) y = +w;
    else if (/^\d{1,2}(st|nd|rd|th|er)?$/.test(w)) d = parseInt(w, 10);
    else if (MONTHS[w]) mo = MONTHS[w];
  }
  if (y && mo && d) return dateOf(y, mo, d, 'day');
  if (y && mo) return dateOf(y, mo, 1, 'month');
  if (y) return dateOf(y, 1, 1, 'year');
  return null;
}

/** Round coordinates so civilian reports never pinpoint a home (about 1 km at best). */
export function roundLocation(lat, lon, { precisionKm = 1, civilian = true } = {}) {
  const decimals = precisionKm >= 50 ? 1 : precisionKm >= 5 ? 2 : civilian ? 2 : 3;
  const f = 10 ** decimals;
  return { lat: Math.round(lat * f) / f, lon: Math.round(lon * f) / f, precision_km: Math.max(precisionKm, civilian ? 1 : 0.1) };
}

/** Build a matcher from config/shape-map.json: longest phrase wins, accents ignored. */
export function shapeMatcher(map) {
  const entries = Object.entries(map.terms)
    .map(([term, craft]) => [stripAccents(term.toLowerCase()), craft])
    .sort((a, b) => b[0].length - a[0].length)
    .map(([term, craft]) => [new RegExp(`(^|[^a-z])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[\\s-]+')}($|[^a-z])`), craft]);
  return (raw) => {
    const text = stripAccents(String(raw ?? '').toLowerCase());
    if (!text.trim()) return map.default;
    for (const [re, craft] of entries) if (re.test(text)) return craft;
    return map.default;
  };
}

const SCORE = { explained: 0.15, insufficient: 0.45, contested: 0.6, unresolved: 0.9 };

/** Map a source's own grading to a shared status and an "unexplained" score. */
export function gradeFor(scheme, value) {
  const v = String(value ?? '').trim();
  if (scheme === 'geipan') {
    const m = v.toUpperCase().match(/(?:^|[^A-Z])([ABCD])(?:$|[^A-Z])/);
    const g = m ? m[1] : '';
    const table = { A: ['explained', 0.05], B: ['explained', 0.2], C: ['insufficient', 0.45], D: ['unresolved', 0.95] };
    const [status, score] = table[g] || ['insufficient', 0.45];
    return { scheme, value: g || null, status, score };
  }
  if (scheme === 'bluebook') {
    if (/unidentified/i.test(v)) return { scheme, value: v, status: 'unresolved', score: 0.85 };
    if (/insufficient/i.test(v) || !v) return { scheme, value: v || null, status: 'insufficient', score: 0.45 };
    return { scheme, value: v, status: 'explained', score: /hoax|psycholog/i.test(v) ? 0.08 : 0.15 };
  }
  const status = STATUSES.includes(v) ? v : 'unresolved';
  return { scheme: scheme || null, value: v || null, status, score: SCORE[status] };
}

export const slugify = (s) =>
  stripAccents(String(s ?? '')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function makeId(source, dateIso, place, ref) {
  const parts = [source, dateIso, slugify(place).slice(0, 36)];
  if (ref) parts.push(slugify(ref).slice(0, 16));
  return parts.filter(Boolean).join('-').replace(/-+/g, '-').slice(0, 120);
}

export const clampText = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t || null;
};
