import test from 'node:test';
import assert from 'node:assert/strict';
import { YEAR_MIN, YEAR_MAX } from './model.js';
import { WAVES } from './waves.js';

test('WAVES is a non-empty array of well-shaped entries', () => {
  assert.ok(Array.isArray(WAVES));
  assert.ok(WAVES.length > 0);
  for (const wave of WAVES) {
    assert.equal(typeof wave.year, 'number');
    assert.equal(typeof wave.label, 'string');
    assert.ok(wave.label.length > 0);
    assert.equal(typeof wave.note, 'string');
    assert.ok(wave.note.length > 0);
    assert.equal(typeof wave.source_url, 'string');
  }
});

test('every year falls inside the sky dial domain, 1940 to 2026', () => {
  for (const wave of WAVES) {
    assert.ok(
      wave.year >= YEAR_MIN && wave.year <= YEAR_MAX,
      `${wave.year} outside ${YEAR_MIN}-${YEAR_MAX}`,
    );
  }
});

test('every source_url is an absolute https URL', () => {
  for (const wave of WAVES) {
    const url = new URL(wave.source_url);
    assert.equal(url.protocol, 'https:', wave.source_url);
  }
});

test('every note is 160 characters or fewer', () => {
  for (const wave of WAVES) {
    assert.ok(
      wave.note.length <= 160,
      `${wave.year} note is ${wave.note.length} characters: ${wave.note}`,
    );
  }
});

// Mechanical proxy only: proves the wording gestures at reports rather than
// silence, not that the phrasing never asserts an object was present. The
// reviewer verdicts each note's actual wording by hand (see
// PHENOMENA_DESIGN.md's honesty rule and the controller ruling in
// task-2-brief.md).
test('every note reads as reports/reported/reporting, the mechanical wording proxy', () => {
  for (const wave of WAVES) {
    assert.match(wave.note, /report/i, `${wave.year}: ${wave.note}`);
  }
});

test('no duplicate years', () => {
  const years = WAVES.map((wave) => wave.year);
  assert.equal(new Set(years).size, years.length);
});
