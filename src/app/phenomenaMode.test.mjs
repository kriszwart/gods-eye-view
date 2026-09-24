import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhenomenaMode } from './phenomenaMode.js';

test('enter disables everything but the kept registers and exit restores', () => {
  const enabled = new Set(['flights', 'anomalies', 'weather-radar']);
  const mode = createPhenomenaMode({
    layerIds: ['flights', 'anomalies', 'weather-radar', 'ancient-sites'],
    isEnabled: (id) => enabled.has(id),
    setEnabled: (id, on) => (on ? enabled.add(id) : enabled.delete(id)),
    keep: ['anomalies', 'ancient-sites'],
  });
  mode.enter();
  assert.deepEqual([...enabled].sort(), ['anomalies']);
  mode.exit();
  assert.deepEqual([...enabled].sort(), [
    'anomalies',
    'flights',
    'weather-radar',
  ]);
});
