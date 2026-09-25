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

test('enter applies spectral via the style hook and exit restores the prior style', () => {
  const enabled = new Set(['flights', 'anomalies']);
  let style = 'normal';
  const styleCalls = [];
  const mode = createPhenomenaMode({
    layerIds: ['flights', 'anomalies'],
    isEnabled: (id) => enabled.has(id),
    setEnabled: (id, on) => (on ? enabled.add(id) : enabled.delete(id)),
    keep: ['anomalies'],
    getStyle: () => style,
    setStyle: (name) => {
      styleCalls.push(name);
      style = name;
    },
  });
  mode.enter();
  assert.equal(style, 'spectral');
  assert.deepEqual(styleCalls, ['spectral']);
  mode.exit();
  assert.equal(style, 'normal');
  assert.deepEqual(styleCalls, ['spectral', 'normal']);
});

test('missing style hooks leave the mode working exactly as before', () => {
  const enabled = new Set(['flights', 'anomalies']);
  const mode = createPhenomenaMode({
    layerIds: ['flights', 'anomalies'],
    isEnabled: (id) => enabled.has(id),
    setEnabled: (id, on) => (on ? enabled.add(id) : enabled.delete(id)),
    keep: ['anomalies'],
  });
  mode.enter();
  assert.deepEqual([...enabled], ['anomalies']);
  mode.exit();
  assert.deepEqual([...enabled].sort(), ['anomalies', 'flights']);
});

test('exit() without a prior enter() never calls setStyle, and a forced exit restores the style exactly once', () => {
  const styleCalls = [];
  const mode = createPhenomenaMode({
    layerIds: ['flights'],
    isEnabled: () => true,
    setEnabled: () => {},
    keep: [],
    getStyle: () => 'normal',
    setStyle: (name) => styleCalls.push(name),
  });
  mode.exit();
  assert.deepEqual(styleCalls, []);
  mode.enter();
  mode.exit();
  mode.exit();
  assert.deepEqual(styleCalls, ['spectral', 'normal']);
});
