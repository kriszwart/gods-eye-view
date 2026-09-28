import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHAPE_CATEGORIES,
  SHAPE_GLYPH_URLS,
} from '../layers/anomalies/shapeGlyphs.js';
import { buildCraftPreview } from './craftPreview.js';

test("buildCraftPreview returns a plate with the shape's own shipped glyph and the passed-in hue", () => {
  const html = buildCraftPreview({ shape: 'tic-tac', hue: '#3fe0ff' });
  assert.match(html, /class="uap-craft-preview"/);
  assert.match(html, /--uap-preview-accent: #3fe0ff/);
  assert.match(html, /class="uap-craft-preview-glyph"/);
  assert.match(
    html,
    new RegExp(`src="${SHAPE_GLYPH_URLS['tic-tac'].replace(/\//g, '\\/')}"`),
  );
  assert.match(html, /loading="lazy"/);
});

test('buildCraftPreview sets a sentence-case, hyphen-free alt text', () => {
  const html = buildCraftPreview({ shape: 'domed-disc', hue: '#ff2e9a' });
  assert.match(html, /alt="Domed disc"/);
});

test('every shipped shape category resolves to its own glyph URL in the preview', () => {
  for (const shape of SHAPE_CATEGORIES) {
    const html = buildCraftPreview({ shape, hue: '#7c8195' });
    assert.match(
      html,
      new RegExp(`src="${SHAPE_GLYPH_URLS[shape].replace(/\//g, '\\/')}"`),
    );
  }
});

test('buildCraftPreview returns an empty string for a null shape (no preview, no orb fallback)', () => {
  assert.equal(buildCraftPreview({ shape: null, hue: '#3fe0ff' }), '');
});

test('buildCraftPreview returns an empty string for an undefined shape', () => {
  assert.equal(buildCraftPreview({ shape: undefined, hue: '#3fe0ff' }), '');
});

test('buildCraftPreview returns an empty string for a shape outside SHAPE_GLYPH_URLS', () => {
  assert.equal(
    buildCraftPreview({ shape: 'not-a-real-shape', hue: '#3fe0ff' }),
    '',
  );
});

test('buildCraftPreview escapes an untrusted hue value', () => {
  const html = buildCraftPreview({
    shape: 'orb',
    hue: '"><script>alert(1)</script>',
  });
  assert.doesNotMatch(html, /<script>/);
});
