'use strict';

function libraryUrl(value) {
  const url = new URL(String(value).trim());
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Use an HTTPS library address without a username or password.');
  }
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/') && !url.pathname.endsWith('.php')) url.pathname += '/';
  return url.href;
}

function isPlayerPage(value, player) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.protocol === 'scray-app:' && url.href === player;
  } catch { return false; }
}
module.exports = { libraryUrl, isPlayerPage };
