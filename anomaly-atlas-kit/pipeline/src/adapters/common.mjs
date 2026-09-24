// Shared request building and result mapping for the LLM-extracted sources.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { SYSTEM, INSTRUCTIONS } from '../extract/prompts.mjs';
import { parseDate, gradeFor, makeId, roundLocation, clampText, slugify } from '../lib/normalise.mjs';
import { parsePlace } from '../lib/gazetteer.mjs';
import { redactText } from '../lib/redact.mjs';

export const MODEL = process.env.EXTRACT_MODEL || 'claude-sonnet-5';

export function request(customId, source, content, maxTokens = 1500) {
  return {
    custom_id: customId.slice(0, 64),
    params: {
      model: MODEL,
      max_tokens: maxTokens,
      system: SYSTEM,
      messages: [{ role: 'user', content: [...content, { type: 'text', text: INSTRUCTIONS[source] }] }],
    },
  };
}

export async function walk(dir, exts) {
  const out = [];
  for (const name of await readdir(dir).catch(() => [])) {
    const p = path.join(dir, name);
    const s = await stat(p);
    if (s.isDirectory()) out.push(...(await walk(p, exts)));
    else if (exts.some((e) => name.toLowerCase().endsWith(e))) out.push({ path: p, bytes: s.size });
  }
  return out;
}

export async function pdfBlock(file) {
  return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: (await readFile(file)).toString('base64') } };
}

export const customIdFor = (prefix, rel) => `${prefix}-${slugify(rel)}`.slice(0, 64);

/** Turn one extracted incident into a normalised record (or null when it cannot be placed). */
export function incidentToRecord(inc, { source, ref, url, attribution, licence, gazetteer, matchShape, model, index = 0 }) {
  const date = parseDate(inc.date);
  if (!date) return { skipped: 'no date' };
  const hint = parsePlace(inc.place);
  const geo = gazetteer && hint.locality ? gazetteer.lookup(hint.locality, { country: hint.country || inc.country || undefined, admin1: hint.admin1 || undefined }) : null;
  if (!geo) return { skipped: 'no location', place: inc.place };
  const civilian = !['military', 'radar', 'pilot'].includes(inc.observer_type);
  const loc = roundLocation(geo.lat, geo.lon, { precisionKm: geo.precision_km, civilian });
  const summary = redactText(clampText(inc.summary, 280)).text;
  const status = source === 'bluebook' ? gradeFor('bluebook', inc.official_conclusion) : gradeFor(source, inc.status);
  return {
    record: {
      id: makeId(source, date.iso, geo.place, `${ref || ''}${index ? `-${index}` : ''}`),
      source, source_ref: ref || null, source_url: url || null, licence, attribution,
      title: clampText(`${geo.place}, ${date.iso}`, 120),
      date: { iso: date.iso, precision: date.precision, days: date.days },
      location: { ...loc, place: geo.place, country: geo.country, geocoder: geo.geocoder },
      shape_raw: clampText(inc.shape_raw, 120), craft_id: matchShape(inc.shape_raw),
      duration_s: Number.isFinite(inc.duration_s) ? inc.duration_s : null,
      objects: Number.isInteger(inc.objects) ? inc.objects : null,
      grade: status, explanation: clampText(inc.official_conclusion, 200), summary,
      media: [], tags: [inc.observer_type].filter(Boolean), hero: false,
      review: (inc.confidence ?? 0) < 0.7 || geo.ambiguous,
      extraction: { method: 'llm', model: model || MODEL, confidence: inc.confidence ?? null },
    },
  };
}
