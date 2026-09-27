import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SWEEP_TYPES,
  glyphUrlForType,
  typeForTmaCategory,
  glyphUrlForTmaCategory,
} from './glyphMap.js';

test('glyphUrlForType returns a glyph under the ancient-sites asset base for every sweep type', () => {
  for (const type of SWEEP_TYPES) {
    const url = glyphUrlForType(type);
    assert.match(url, /^\/ancient-sites\/glyphs\/[a-z-]+\.svg$/);
  }
});

test('glyphUrlForType maps megalith to trilith.svg (controller ruling, no megalith.svg shipped)', () => {
  assert.equal(
    glyphUrlForType('megalith'),
    '/ancient-sites/glyphs/trilith.svg',
  );
});

test('glyphUrlForType maps every other sweep type to its own same-named glyph', () => {
  assert.equal(glyphUrlForType('circle'), '/ancient-sites/glyphs/circle.svg');
  assert.equal(
    glyphUrlForType('geoglyph'),
    '/ancient-sites/glyphs/geoglyph.svg',
  );
  assert.equal(glyphUrlForType('mound'), '/ancient-sites/glyphs/mound.svg');
  assert.equal(
    glyphUrlForType('settlement'),
    '/ancient-sites/glyphs/settlement.svg',
  );
});

test('glyphUrlForType falls back sensibly for an unrecognised type', () => {
  const url = glyphUrlForType('pyramid');
  assert.match(url, /^\/ancient-sites\/glyphs\/[a-z-]+\.svg$/);
});

test('typeForTmaCategory maps real Modern Antiquarian categories to a sweep type', () => {
  assert.equal(typeForTmaCategory('Stone Circle'), 'circle');
  assert.equal(typeForTmaCategory('Timber Circle'), 'circle');
  assert.equal(typeForTmaCategory('Henge'), 'circle');
  assert.equal(typeForTmaCategory('Round Barrow(s)'), 'mound');
  assert.equal(typeForTmaCategory('Long Barrow'), 'mound');
  assert.equal(typeForTmaCategory('Cairn(s)'), 'mound');
  assert.equal(typeForTmaCategory('Hillfort'), 'settlement');
  assert.equal(
    typeForTmaCategory('Ancient Village / Settlement / Misc. Earthwork'),
    'settlement',
  );
  assert.equal(typeForTmaCategory('Standing Stone / Menhir'), 'megalith');
  assert.equal(typeForTmaCategory('Dolmen / Quoit / Cromlech'), 'megalith');
  assert.equal(typeForTmaCategory('Alignement'), 'megalith');
  assert.equal(typeForTmaCategory('Hill Figure'), 'geoglyph');
});

test('typeForTmaCategory is case-insensitive', () => {
  assert.equal(typeForTmaCategory('stone circle'), 'circle');
  assert.equal(typeForTmaCategory('STONE CIRCLE'), 'circle');
  assert.equal(typeForTmaCategory('HillFort'), 'settlement');
});

test('typeForTmaCategory falls back to a sensible default for an unknown category', () => {
  const fallback = typeForTmaCategory('Departement');
  assert.ok(SWEEP_TYPES.includes(fallback));
  assert.equal(typeForTmaCategory(''), fallback);
  assert.equal(typeForTmaCategory(undefined), fallback);
  assert.equal(typeForTmaCategory(null), fallback);
});

test('glyphUrlForTmaCategory composes the category mapper with the glyph URL lookup', () => {
  assert.equal(
    glyphUrlForTmaCategory('Stone Circle'),
    glyphUrlForType('circle'),
  );
  assert.equal(
    glyphUrlForTmaCategory('Standing Stone / Menhir'),
    glyphUrlForType('megalith'),
  );
});
