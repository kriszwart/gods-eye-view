import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const data = JSON.parse(
  readFileSync(new URL('../../../public/ancient-sites/sites.v1.json', import.meta.url), 'utf8'),
);

test('ancient sample is valid, honest and attributed', () => {
  assert.equal(data.schema, 'ancient.sites.v1');
  assert.equal(data.count, data.sites.length);
  assert.ok(data.sites.length >= 20);
  for (const s of data.sites) {
    for (const key of ['id', 'name', 'lat', 'lon', 'country', 'period', 'type', 'summary', 'debated', 'source_url', 'attribution', 'glyph'])
      assert.ok(s[key] !== undefined && s[key] !== '', `${s.id ?? s.name} missing ${key}`);
    assert.ok(Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180);
    assert.ok(s.summary.length <= 280);
    assert.match(s.summary + s.debated, /^(?!.*ancient alien)/i);
  }
});

test('every site carries a Wikipedia link, and a free-licence Commons image when it has one', () => {
  for (const s of data.sites) {
    for (const key of ['image', 'image_attribution', 'wikipedia'])
      assert.ok(key in s, `${s.id} missing ${key} field`);

    assert.match(s.wikipedia, /^https:\/\/en\.wikipedia\.org\/wiki\/.+/, `${s.id} wikipedia is not an en.wikipedia.org URL`);

    if (s.image === null) {
      assert.equal(s.image_attribution, null, `${s.id} has a null image but non-null image_attribution`);
    } else {
      assert.match(s.image, /^https:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\/.+/, `${s.id} image is not a Commons Special:FilePath URL`);
      assert.ok(s.image_attribution, `${s.id} has an image but no image_attribution`);
      assert.ok(typeof s.image_attribution.licence === 'string' && s.image_attribution.licence.length > 0, `${s.id} image_attribution missing licence`);
      assert.ok(typeof s.image_attribution.author === 'string' && s.image_attribution.author.length > 0, `${s.id} image_attribution missing author`);
    }
  }
});
