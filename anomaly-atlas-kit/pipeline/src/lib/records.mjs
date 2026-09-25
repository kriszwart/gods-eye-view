// Validation and output writers. The columnar app format is what the globe
// loads; keep it in step with gev-overlay/src/layers/anomalies/records.js.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { STATUSES } from './normalise.mjs';

export const APP_SCHEMA = 'anomaly.app.v1';
const PRECISION = { day: 0, month: 1, year: 2 };

export function validateRecord(r) {
  const errs = [];
  const need = (cond, msg) => cond || errs.push(msg);
  need(typeof r?.id === 'string' && /^[a-z0-9-]{6,120}$/.test(r.id), 'id');
  need(typeof r?.source === 'string', 'source');
  need(r?.date && typeof r.date.iso === 'string' && r.date.precision in PRECISION && Number.isInteger(r.date.days), 'date');
  const l = r?.location;
  need(l && Number.isFinite(l.lat) && Math.abs(l.lat) <= 90 && Number.isFinite(l.lon) && Math.abs(l.lon) <= 180, 'location');
  need(l && Number.isFinite(l.precision_km) && l.precision_km >= 0, 'location.precision_km');
  need(typeof r?.craft_id === 'string' && r.craft_id.length > 0, 'craft_id');
  need(r?.grade && STATUSES.includes(r.grade.status) && r.grade.score >= 0 && r.grade.score <= 1, 'grade');
  need(typeof r?.licence === 'string' && r.licence.length > 0, 'licence');
  need(typeof r?.attribution === 'string' && r.attribution.length > 0, 'attribution');
  if (r?.summary != null) need(String(r.summary).length <= 400, 'summary too long');
  return errs;
}

export async function readJsonl(file) {
  const text = await readFile(file, 'utf8');
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

export async function writeJsonl(file, rows) {
  await writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

/**
 * Read every `.jsonl` file in a normalised-data folder and concatenate their
 * rows. When `allow` is given (an array of source ids, matching the file's
 * basename without `.jsonl`), only files whose name is in that list are
 * read -- other pipelines can share this folder's naming convention for
 * their own outputs without being swept into an unrelated dataset.
 */
export async function readNormalised(dir, allow = null) {
  const out = [];
  const files = (await readdir(dir))
    .filter((n) => n.endsWith('.jsonl'))
    .filter((n) => !allow || allow.includes(n.slice(0, -'.jsonl'.length)))
    .sort();
  for (const f of files) out.push(...(await readJsonl(`${dir}/${f}`)));
  return out;
}

export function haversineKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(s));
}

/** Link likely duplicates across sources (within a day and 60 km) without deleting either. */
export function linkDuplicates(records) {
  const byDay = new Map();
  for (const r of records) {
    if (r.date.precision !== 'day') continue;
    const k = r.date.days;
    for (const d of [k - 1, k, k + 1]) {
      for (const o of byDay.get(d) || []) {
        if (o.source === r.source || haversineKm(o.location, r.location) > 60) continue;
        (o.related ||= []).push(r.id);
        (r.related ||= []).push(o.id);
      }
    }
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(r);
  }
  return records;
}

/** Columnar dataset for the globe: compact, fast to parse, no free text beyond hero titles. */
export function toAppDataset(records, { sources }) {
  const sorted = [...records].sort((a, b) => a.date.days - b.date.days || a.id.localeCompare(b.id));
  const srcIds = [...new Set(sorted.map((r) => r.source))];
  const crafts = [...new Set(sorted.map((r) => r.craft_id))].sort();
  const cols = { id: [], t: [], prec: [], lat: [], lon: [], km: [], src: [], craft: [], status: [], u: [], hero: [], title: [] };
  for (const r of sorted) {
    cols.id.push(r.id);
    cols.t.push(r.date.days);
    cols.prec.push(PRECISION[r.date.precision]);
    cols.lat.push(r.location.lat);
    cols.lon.push(r.location.lon);
    cols.km.push(r.location.precision_km);
    cols.src.push(srcIds.indexOf(r.source));
    cols.craft.push(crafts.indexOf(r.craft_id));
    cols.status.push(STATUSES.indexOf(r.grade.status));
    cols.u.push(Math.round(r.grade.score * 100));
    cols.hero.push(r.hero ? 1 : 0);
    cols.title.push(r.hero ? r.title || '' : '');
  }
  const years = sorted.map((r) => new Date(r.date.days * 86400000).getUTCFullYear());
  return {
    schema: APP_SCHEMA,
    generatedAt: new Date().toISOString(),
    count: sorted.length,
    range: years.length ? [years[0], years[years.length - 1]] : null,
    sources: srcIds.map((id) => ({ id, label: sources[id]?.label || id, attribution: sources[id]?.attribution || null, licence: sources[id]?.licence || null })),
    crafts,
    statuses: STATUSES,
    columns: cols,
  };
}

/** Dossier records for hero cases, loaded on demand by the detail card. */
export function toCases(records) {
  return records.filter((r) => r.hero).map((r) => ({
    id: r.id, title: r.title, date: r.date, location: r.location, craft_id: r.craft_id, shape_raw: r.shape_raw ?? null,
    grade: r.grade, explanation: r.explanation ?? null, summary: r.summary ?? null, source: r.source,
    source_ref: r.source_ref ?? null, source_url: r.source_url ?? null, source_note: r.source_note ?? null,
    attribution: r.attribution, media: r.media || [], tags: r.tags || [], related: r.related || [],
  }));
}

export const writeJson = (file, value) => writeFile(file, JSON.stringify(value));
