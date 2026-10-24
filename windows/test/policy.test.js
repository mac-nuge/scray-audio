'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { libraryUrl, isPlayerPage } = require('../policy');

test('normalises library addresses and rejects unsafe schemes and embedded credentials', () => {
  assert.equal(libraryUrl(' https://example.com/audio?q=hi#/search/foo '), 'https://example.com/audio/');
  assert.equal(libraryUrl('https://example.com/audio/index.php'), 'https://example.com/audio/index.php');
  for (const value of ['http://example.com', 'file:///tmp/player', 'javascript:alert(1)', 'https://user:pass@example.com', 'bad']) {
    assert.throws(() => libraryUrl(value));
  }
});
test('only the selected local player may access offline storage or transport', () => {
  const base = 'scray-app://library-one/index.html';
  for (const value of [base, base + '#/f/Music']) assert.ok(isPlayerPage(value, base));
  for (const value of ['https://example.com/audio/', 'scray-app://library-two/index.html', 'scray-app://library-one/other.html', base + '?other=true', 'file:///index.html', 'not a URL']) assert.equal(isPlayerPage(value, base), false);
});
