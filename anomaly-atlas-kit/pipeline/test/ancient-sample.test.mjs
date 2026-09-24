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
