import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEEP_TIME_MAX_BCE,
  DEEP_TIME_MIN_BCE,
  DEEP_TIME_TICKS,
  TYPE_ERA_WINDOWS,
  typeEraWindow,
  sweepTypeInEraBand,
  heroInEraBand,
  formatBceYear,
  describeEraBand,
  deepTimeT,
  bceFromT,
} from './eras.js';

test('typeEraWindow returns a window for every known sweep type', () => {
  for (const type of Object.keys(TYPE_ERA_WINDOWS)) {
    const window = typeEraWindow(type);
    assert.ok(window, `expected a window for ${type}`);
    assert.ok(Number.isFinite(window.startBce));
    assert.ok(Number.isFinite(window.endBce));
    assert.ok(
      window.startBce > window.endBce,
      `${type} window should run from earlier to later`,
    );
  }
});

test('typeEraWindow returns null for an unrecognised type', () => {
  assert.equal(typeEraWindow('pyramid'), null);
  assert.equal(typeEraWindow(''), null);
  assert.equal(typeEraWindow(undefined), null);
});

test('sweepTypeInEraBand: all mode always includes, even an unknown type', () => {
  assert.equal(sweepTypeInEraBand('circle', 9999, 'all'), true);
  assert.equal(sweepTypeInEraBand('circle', -9999, 'all'), true);
  assert.equal(sweepTypeInEraBand('unknown-type', 0, 'all'), true);
});

test('sweepTypeInEraBand: an unrecognised type is never hidden by a heuristic it has none for', () => {
  assert.equal(sweepTypeInEraBand('unknown-type', 100, 'cumulative'), true);
  assert.equal(sweepTypeInEraBand('unknown-type', -5000, 'window'), true);
});

test('sweepTypeInEraBand: cumulative mode includes a type once the dial reaches its window start', () => {
  const { startBce } = TYPE_ERA_WINDOWS.megalith;
  assert.equal(sweepTypeInEraBand('megalith', startBce, 'cumulative'), true);
  assert.equal(
    sweepTypeInEraBand('megalith', startBce - 1, 'cumulative'),
    true,
  );
  assert.equal(
    sweepTypeInEraBand('megalith', startBce + 1, 'cumulative'),
    false,
  );
});

test('sweepTypeInEraBand: window mode is an overlap test against the type window, span-padded at both ends, inclusive at the edges', () => {
  const { startBce, endBce } = TYPE_ERA_WINDOWS.circle;
  // Just inside the window itself: always a match, regardless of span.
  assert.equal(sweepTypeInEraBand('circle', startBce - 1, 'window', 0), true);
  // The padded upper edge (startBce + span) and one past it.
  assert.equal(
    sweepTypeInEraBand('circle', startBce + 500, 'window', 500),
    true,
  );
  assert.equal(
    sweepTypeInEraBand('circle', startBce + 501, 'window', 500),
    false,
  );
  // The padded lower edge (endBce - span) and one past it.
  assert.equal(sweepTypeInEraBand('circle', endBce - 500, 'window', 500), true);
  assert.equal(
    sweepTypeInEraBand('circle', endBce - 501, 'window', 500),
    false,
  );
});

test('sweepTypeInEraBand: window mode matches a type whose window is wide relative to the span - "around 2500 BCE" must not hide a megalith (regression: the old distance-from-startBce expression hid it, since |5000 - 2500| = 2500 is well outside the default 500-year span, even though the type window runs to -1000)', () => {
  const { startBce, endBce } = TYPE_ERA_WINDOWS.megalith;
  assert.ok(
    2500 < startBce && 2500 > endBce,
    'sanity: 2500 BCE sits inside the megalith window',
  );
  assert.equal(sweepTypeInEraBand('megalith', 2500, 'window'), true);
});

test('heroInEraBand: an unknown (null) date only ever shows in all-years mode', () => {
  assert.equal(heroInEraBand(null, 0, 'all'), true);
  assert.equal(heroInEraBand(null, 0, 'cumulative'), false);
  assert.equal(heroInEraBand(null, 0, 'window'), false);
});

test('heroInEraBand: sign convention, a positive value is BCE and reads as the older end', () => {
  // Gobekli Tepe: 9500 (9500 BCE).
  assert.equal(heroInEraBand(9500, 9000, 'cumulative'), true);
  assert.equal(heroInEraBand(9500, 9800, 'cumulative'), false);
});

test('heroInEraBand: sign convention, a negative value is CE and reads as the newer end', () => {
  // A site dated 1450 CE is period_start_bce -1450 per the binding convention.
  assert.equal(heroInEraBand(-1450, -1500, 'cumulative'), true);
  assert.equal(heroInEraBand(-1450, -1000, 'cumulative'), false);
});

test('heroInEraBand: window mode is span-bounded around the hero’s own date, inclusive at the edge', () => {
  assert.equal(heroInEraBand(3000, 3500, 'window', 500), true);
  assert.equal(heroInEraBand(3000, 3501, 'window', 500), false);
});

test('heroInEraBand never consults the sweep type table: it takes no type argument at all', () => {
  // A hero at a date the "megalith" heuristic would call implausibly recent
  // still shows once the dial reaches its own real date - the two functions
  // are entirely separate computations, never mixing a type heuristic into
  // an individually dated hero.
  const recentHeroDate = -1200; // 1200 CE
  assert.equal(
    heroInEraBand(recentHeroDate, recentHeroDate, 'cumulative'),
    true,
  );
});

test('formatBceYear renders the sign convention as sentence-case BCE/CE labels', () => {
  assert.equal(formatBceYear(9500), '9,500 BCE');
  assert.equal(formatBceYear(-1200), '1,200 CE');
  assert.equal(formatBceYear(1), '1 BCE');
});

test('formatBceYear never renders "0 CE": there is no year zero', () => {
  assert.equal(formatBceYear(0), '1 BCE');
  assert.equal(formatBceYear(-0.4), '1 BCE');
  assert.equal(formatBceYear(0.4), '1 BCE');
});

test('describeEraBand mirrors the sky chronometer’s readout, singular and plural', () => {
  assert.equal(
    describeEraBand(3000, 1, 'cumulative'),
    '1 site up to 3,000 BCE',
  );
  assert.equal(
    describeEraBand(3000, 2, 'cumulative'),
    '2 sites up to 3,000 BCE',
  );
  assert.equal(describeEraBand(-500, 12, 'window'), '12 sites around 500 CE');
  assert.equal(describeEraBand(0, 5, 'all'), '5 sites across all eras');
});

test('DEEP_TIME_TICKS lies within the dial range, ordered from oldest to newest', () => {
  assert.ok(DEEP_TIME_TICKS.length > 3);
  for (const tick of DEEP_TIME_TICKS) {
    assert.ok(tick <= DEEP_TIME_MAX_BCE);
    assert.ok(tick >= DEEP_TIME_MIN_BCE);
  }
  for (let i = 1; i < DEEP_TIME_TICKS.length; i += 1) {
    assert.ok(DEEP_TIME_TICKS[i] < DEEP_TIME_TICKS[i - 1]);
  }
});

test('deepTimeT maps the oldest end to 0 and the newest end to 1', () => {
  assert.equal(deepTimeT(DEEP_TIME_MAX_BCE), 0);
  assert.equal(deepTimeT(DEEP_TIME_MIN_BCE), 1);
});

test('deepTimeT is monotonic across the range', () => {
  const older = deepTimeT(8000);
  const newer = deepTimeT(-500);
  assert.ok(older < newer);
});

test('deepTimeT compresses the deep past and expands the near present', () => {
  // Equal 1,000-year steps should move the position much further near the
  // present end than deep in the past - that is the log compression.
  const deepStep = Math.abs(deepTimeT(9000) - deepTimeT(8000));
  const nearStep = Math.abs(deepTimeT(-500) - deepTimeT(-1500));
  assert.ok(nearStep > deepStep);
});

test('bceFromT inverts deepTimeT at the range boundaries', () => {
  assert.equal(bceFromT(0), DEEP_TIME_MAX_BCE);
  assert.equal(bceFromT(1), DEEP_TIME_MIN_BCE);
});

test('bceFromT round-trips deepTimeT to within a rounding year', () => {
  for (const value of [9000, 4000, 0, -800]) {
    const roundTripped = bceFromT(deepTimeT(value));
    assert.ok(
      Math.abs(roundTripped - value) <= 1,
      `expected ${roundTripped} close to ${value}`,
    );
  }
});
