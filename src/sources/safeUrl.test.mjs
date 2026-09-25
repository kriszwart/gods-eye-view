import test from 'node:test';
import assert from 'node:assert/strict';
import { safeSourceUrl, safeImageUrl } from './safeUrl.js';

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

test('safeImageUrl accepts the Wikimedia Special:FilePath shape on both allowed hosts', () => {
  const commons =
    'https://commons.wikimedia.org/wiki/Special:FilePath/G%C3%B6bekli%20Tepe%2C%20Urfa.jpg?width=640';
  assert.equal(safeImageUrl(commons), commons);
  const upload =
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Example.jpg/640px-Example.jpg';
  assert.equal(safeImageUrl(upload), upload);
});

test('safeImageUrl rejects http, other hosts, lookalike hosts, unsafe schemes and non-URL values', () => {
  for (const value of [
    'http://commons.wikimedia.org/wiki/Special:FilePath/Example.jpg',
    'https://evil.com/commons.wikimedia.org/Example.jpg',
    'https://commons.wikimedia.org.evil.com/wiki/Special:FilePath/Example.jpg',
    'https://example.com/image.jpg',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '//commons.wikimedia.org/wiki/Special:FilePath/Example.jpg',
    'not a url',
    null,
    undefined,
  ])
    assert.equal(safeImageUrl(value), null);
});
