/**
 * Deep-time domain logic for the ancient-sites register: the type-era
 * heuristic table the worldwide sweep is banded by, the deep-time dial's
 * fixed range and log-compressed position maths, and the era-band
 * membership tests both the sweep and the hero tier are filtered by.
 * Portable: no Cesium, no browser globals, so this stays unit-testable.
 *
 * `period_start_bce` sign convention (binding, phase 3 ruling): positive
 * for a BCE year, negative for a CE year, null for unknown. For example
 * Gobekli Tepe is 9500 (9500 BCE); a site dated 1200 CE is -1200.
 *
 * Honesty rule: the worldwide sweep carries no per-site dating (Wikidata's
 * inception coverage was 0.57% - see the phase 5b task 2 report, which
 * dropped the column). `sweepTypeInEraBand` below places a sweep row by
 * its TYPE's typical worldwide period only, never by anything about that
 * individual site, and this must never be shown as if it were the site's
 * own dating. `heroInEraBand` is the opposite case: the curated hero tier
 * keeps real per-site dates, so heroes are always filtered by their own
 * `period_start_bce`, never by a type heuristic - the two functions below
 * take deliberately different arguments (a type name vs. a date) so they
 * cannot be confused for one another at a call site.
 */

/** The deep-time dial's range: 10,000 BCE (oldest) to 1500 CE (newest),
 * where the chronometer hands off to the sky register's own 1940 start. */
export const DEEP_TIME_MAX_BCE = 10000;
export const DEEP_TIME_MIN_BCE = -1500;
const DEEP_TIME_SPAN = DEEP_TIME_MAX_BCE - DEEP_TIME_MIN_BCE;

/** Fixed milestone ticks for the dial's face, oldest to newest. Hand-picked
 * round calendar years, not derived from any per-site data, so no honesty
 * concern attaches to them the way it does to the type-era table below. */
export const DEEP_TIME_TICKS = Object.freeze([
  10000, 8000, 6000, 4000, 3000, 2000, 1000, 500, 0, -500, -1000, -1500,
]);

const DEFAULT_SPAN_BCE = 500;

/**
 * Typical worldwide period per sweep type, in `period_start_bce` units
 * (`startBce` is the earlier/larger value, `endBce` the later/smaller one).
 * These windows are typological, worldwide and deliberately broad: they
 * place a sweep site by what its TYPE usually is, never by anything about
 * that individual site. One line of archaeological basis each:
 * - circle: stone and earthen circles recur from the Neolithic into the
 *   Iron Age across separate circle-building traditions worldwide.
 * - megalith: megalithic monuments (dolmens, menhirs, chambered tombs)
 *   cluster in the Neolithic to Bronze Age, with some traditions reaching
 *   into later antiquity.
 * - mound: burial and platform mounds span the Neolithic through late
 *   antiquity across separate mound-building cultures.
 * - geoglyph: large ground-marked figures are documented from the Bronze
 *   Age into the early modern period.
 * - settlement: settlement sites in this sweep range from the Neolithic
 *   to the medieval period.
 */
export const TYPE_ERA_WINDOWS = Object.freeze({
  circle: Object.freeze({ startBce: 5000, endBce: -500 }),
  megalith: Object.freeze({ startBce: 5000, endBce: -1000 }),
  mound: Object.freeze({ startBce: 4000, endBce: -500 }),
  geoglyph: Object.freeze({ startBce: 1500, endBce: -1500 }),
  settlement: Object.freeze({ startBce: 9000, endBce: -1500 }),
});

/** A sweep type's era window, or null when the type carries no heuristic
 * (defensive: every type the shipped sweep uses has one today). */
export function typeEraWindow(typeName) {
  return TYPE_ERA_WINDOWS[typeName] ?? null;
}

/**
 * Whether a value on the `period_start_bce` timeline shows for the dial's
 * current position: at or before it (cumulative, "up to"), overlapping a
 * span-padded window (window, "around"), or always (all). Larger values are
 * earlier, so cumulative membership is `startBce >= bceValue`, mirroring
 * the sky chronometer's own `row.year <= year` with the timeline read
 * backwards.
 *
 * `startBce` and `endBce` bound the thing being tested (a type's typological
 * window, earlier to later) and window mode is an overlap test between that
 * bound and `[bceValue - spanBce, bceValue + spanBce]`: `bceValue` must not
 * sit past the padded earlier edge (`startBce + spanBce`) nor short of the
 * padded later edge (`endBce - spanBce`). A hero's own point date has no
 * separate "later" end, so its caller passes the same value for both
 * `startBce` and `endBce`, which collapses this to the point's own
 * distance-from-`bceValue` test.
 */
function withinBand(startBce, endBce, bceValue, mode, spanBce) {
  if (mode === 'all' || bceValue == null) return true;
  if (mode === 'window')
    return bceValue <= startBce + spanBce && bceValue >= endBce - spanBce;
  return startBce >= bceValue;
}

/**
 * Whether a worldwide-sweep row of the given TYPE shows for the dial's
 * current position. Reads only the type's typological window, never
 * anything about the individual site - see the honesty rule above.
 * An unrecognised type is never hidden by a heuristic it has no window
 * for. Window mode overlaps the dial's span-padded position against the
 * type's FULL window (`startBce` to `endBce`), not just its earlier end, so
 * "around 2500 BCE" correctly includes a type such as megalith whose window
 * (5000 to -1000) spans well past any single span around that one date.
 */
export function sweepTypeInEraBand(
  typeName,
  bceValue,
  mode = 'cumulative',
  spanBce = DEFAULT_SPAN_BCE,
) {
  const eraWindow = typeEraWindow(typeName);
  if (!eraWindow) return true;
  return withinBand(
    eraWindow.startBce,
    eraWindow.endBce,
    bceValue,
    mode,
    spanBce,
  );
}

/**
 * Whether a hero site shows for the dial's current position, using its
 * OWN `period_start_bce` - heroes always filter by their real date, never
 * a type heuristic (see the honesty rule above; note this function takes
 * no type argument at all). A null (unknown) date can only be honestly
 * placed in "all eras" mode. Window mode stays a plain distance-from-date
 * test (the hero has one date, not a window), which falls out of
 * `withinBand` by passing the same value as both its `startBce` and
 * `endBce` arguments.
 */
export function heroInEraBand(
  periodStartBce,
  bceValue,
  mode = 'cumulative',
  spanBce = DEFAULT_SPAN_BCE,
) {
  if (periodStartBce == null) return mode === 'all';
  return withinBand(periodStartBce, periodStartBce, bceValue, mode, spanBce);
}

/** Sentence-case BCE/CE label for a `period_start_bce` value, for the
 * deep-time dial's ticks, needle and readout. There is no year zero on this
 * timeline, so a value that rounds to 0 (the boundary the sign convention
 * itself has no side for) reads as "1 BCE" rather than the nonsensical
 * "0 CE". */
export function formatBceYear(bceValue) {
  const n = Math.round(Number(bceValue));
  if (n === 0) return '1 BCE';
  return n > 0
    ? `${n.toLocaleString('en-GB')} BCE`
    : `${Math.abs(n).toLocaleString('en-GB')} CE`;
}

/** Plain-language readout for the deep-time dial, mirroring the sky
 * chronometer's `describeYear` in sentence case. */
export function describeEraBand(bceValue, count, mode) {
  const n = count === 1 ? '1 site' : `${count.toLocaleString('en-GB')} sites`;
  const label = formatBceYear(bceValue);
  if (mode === 'all') return `${n} across all eras`;
  if (mode === 'window') return `${n} around ${label}`;
  return `${n} up to ${label}`;
}

/**
 * Normalised dial position for a `period_start_bce` value: 0 at the oldest
 * end (10,000 BCE), 1 at the newest (1500 CE) - matching the sky
 * chronometer's own "oldest at the start, newest at the end" convention.
 *
 * Log-compressed toward the present: the mapping runs on years-before-the-
 * dial's-newest-end through `Math.log1p`, so equal steps of dial position
 * pack many more calendar years together deep in the past than they do
 * near the present. The deep past compresses into a short arc; the last
 * couple of millennia, where the dial hands off to the sky chronometer's
 * own 1940 start, get proportionally more of the dial to spread out in.
 */
export function deepTimeT(bceValue) {
  const clamped = Math.min(
    DEEP_TIME_MAX_BCE,
    Math.max(DEEP_TIME_MIN_BCE, bceValue),
  );
  const yearsBeforePresent = clamped - DEEP_TIME_MIN_BCE; // 0..DEEP_TIME_SPAN
  const fractionFromPresent =
    Math.log1p(yearsBeforePresent) / Math.log1p(DEEP_TIME_SPAN); // 0 at newest, 1 at oldest
  return 1 - fractionFromPresent;
}

/** Inverse of `deepTimeT`: the `period_start_bce` value at a normalised
 * dial position (0 oldest, 1 newest), for pointer-drag interaction. */
export function bceFromT(t) {
  const clampedT = Math.min(1, Math.max(0, t));
  const fractionFromPresent = 1 - clampedT;
  const yearsBeforePresent = Math.expm1(
    fractionFromPresent * Math.log1p(DEEP_TIME_SPAN),
  );
  return Math.round(DEEP_TIME_MIN_BCE + yearsBeforePresent);
}
