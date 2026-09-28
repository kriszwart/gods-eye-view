import test from 'node:test';
import assert from 'node:assert/strict';
import { PALETTE, STATUS_HUE, statusHue } from './model.js';

test('STATUS_HUE carries exactly the four statuses the chronometer filters and legend name', () => {
  assert.deepEqual(Object.keys(STATUS_HUE).sort(), [
    'contested',
    'explained',
    'insufficient',
    'unresolved',
  ]);
});

test('statusHue matches the readout tint and legend mapping (dim/violet/magenta/amber)', () => {
  assert.equal(statusHue('explained'), PALETTE.dim);
  assert.equal(statusHue('insufficient'), PALETTE.violet);
  assert.equal(statusHue('unresolved'), PALETTE.magenta);
  assert.equal(statusHue('contested'), PALETTE.amber);
});

test('statusHue falls back to the systemic default status (unresolved/magenta) for an unrecognised status', () => {
  assert.equal(statusHue('not-a-real-status'), PALETTE.magenta);
  assert.equal(statusHue(''), PALETTE.magenta);
  assert.equal(statusHue(undefined), PALETTE.magenta);
  assert.equal(statusHue(null), PALETTE.magenta);
});
