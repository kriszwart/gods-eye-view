import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHAPE_CATEGORIES,
  DEFAULT_SHAPE_CATEGORY,
  SHAPE_GLYPH_URLS,
  glyphUrlForShape,
} from './shapeGlyphs.js';

const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, '../../..');
const MANIFEST_PATH = path.join(
  REPO_ROOT,
  'public/anomalies/crafts/manifest.json',
);

function readManifestIds() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  return manifest.crafts.map((c) => c.id);
}

test('every manifest craft id maps to an existing glyph file on disk', () => {
  const ids = readManifestIds();
  assert.ok(ids.length > 0);
  for (const id of ids) {
    const url = glyphUrlForShape(id);
    const filePath = path.join(REPO_ROOT, 'public', url.replace(/^\//, ''));
    assert.ok(
      existsSync(filePath),
      `${url} (for manifest craft "${id}") does not exist on disk`,
    );
  }
});

test('SHAPE_CATEGORIES matches the manifest craft ids exactly', () => {
  const manifestIds = new Set(readManifestIds());
  assert.equal(SHAPE_CATEGORIES.length, manifestIds.size);
  for (const category of SHAPE_CATEGORIES)
    assert.ok(
      manifestIds.has(category),
      `${category} is in SHAPE_CATEGORIES but not the manifest`,
    );
  for (const id of manifestIds)
    assert.ok(
      SHAPE_CATEGORIES.includes(id),
      `${id} is in the manifest but not SHAPE_CATEGORIES`,
    );
});

test('glyphUrlForShape resolves every known category to its own same-named glyph', () => {
  for (const category of SHAPE_CATEGORIES)
    assert.equal(
      glyphUrlForShape(category),
      `/anomalies/glyphs/${category}.svg`,
    );
});

test('glyphUrlForShape falls back to the default shape for an unknown or missing category', () => {
  const fallback = SHAPE_GLYPH_URLS[DEFAULT_SHAPE_CATEGORY];
  assert.equal(glyphUrlForShape('not-a-real-shape'), fallback);
  assert.equal(glyphUrlForShape(''), fallback);
  assert.equal(glyphUrlForShape(null), fallback);
  assert.equal(glyphUrlForShape(undefined), fallback);
});

test('SHAPE_GLYPH_URLS agrees with glyphUrlForShape for every category, so the two can never drift apart', () => {
  for (const category of SHAPE_CATEGORIES)
    assert.equal(SHAPE_GLYPH_URLS[category], glyphUrlForShape(category));
});
