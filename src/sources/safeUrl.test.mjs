import test from 'node:test';
import assert from 'node:assert/strict';
import { safeSourceUrl } from './safeUrl.js';

test('safeSourceUrl accepts http and https URLs unchanged', () => {
  assert.equal(
    safeSourceUrl('https://example.com/case/1'),
    'https://example.com/case/1',
  );
  assert.equal(
    safeSourceUrl('http://example.com/case/1'),
    'http://example.com/case/1',
  );
});

test('safeSourceUrl rejects unsafe schemes, protocol-relative and non-URL values', () => {
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//example.com/case/1',
    'not a url',
    null,
    undefined,
    '  javascript:alert(1)',
  ])
    assert.equal(safeSourceUrl(value), null);
});
