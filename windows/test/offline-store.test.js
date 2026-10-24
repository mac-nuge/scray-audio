'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { OfflineStore, libraryId } = require('../offline-store');

async function fixture(t, options) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scray-offline-test-'));
  t.after(() => {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('scray-offline-test-')) throw new Error('Unexpected test cleanup path');
    return fs.rm(root, { recursive: true, force: true });
  });
  const store = new OfflineStore(root, options);
  await store.init(); return store;
}
test('downloads, persists metadata, restarts, serves seek ranges and removes files', async t => {
  const progress = [];
  const bytes = Buffer.from('0123456789');
  const store = await fixture(t, { fetcher: async () => new Response(bytes, { headers: { 'content-length': '10', 'content-type': 'audio/mpeg' } }), progress: (...args) => progress.push(args) });
  const rel = 'Music/CON/Long: title?.mp3';
  await store.download({ key: 't1', url: 'https://media.example/track', path: rel });
  await store.manifestWrite(JSON.stringify({ v: 1, tracks: [{ id: 1, path: rel }] }));
  const restarted = new OfflineStore(store.root); await restarted.init();
  assert.deepEqual(await restarted.offlineFiles(), [{ path: rel, size: 10 }]);
  assert.ok(progress.length);
  assert.equal((await restarted.storage()).used, 10);
  const url = 'scray-audio://local/' + rel.split('/').map(encodeURIComponent).join('/');
  const response = await restarted.response(new Request(url, { headers: { Range: 'bytes=3-6' } }));
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 3-6/10');
  assert.equal(await response.text(), '3456');
  assert.equal(await (await restarted.response(new Request(url, { headers: { Range: 'bytes=-2' } }))).text(), '89');
  assert.equal((await restarted.response(new Request(url, { headers: { Range: 'bytes=20-' } }))).status, 416);
  assert.equal((await restarted.response(new Request(url, { method: 'HEAD' }))).headers.get('content-length'), '10');
  await restarted.remove([rel]);
  assert.deepEqual(await restarted.offlineFiles(), []);
  assert.equal((await restarted.response(new Request(url))).status, 404);
});
test('unsafe paths and redirects cannot read/write outside storage', async t => {
  const store = await fixture(t, { fetcher: async () => new Response(null, { status: 302, headers: { location: 'file:///C:/secret' } }) });
  for (const rel of ['../secret', '/absolute', 'a/../secret', 'a\\secret', 'a//b', 'a\0b']) assert.throws(() => store.file(rel));
  assert.notEqual(store.file('Music/track.mp3'), store.file('Music/TRACK.mp3'));
  await assert.rejects(store.download({ key: 't1', url: 'https://example.com', path: 'ok.mp3' }), /HTTPS/);
  await assert.rejects(store.download({ key: 't1', url: 'file:///secret', path: 'ok.mp3' }), /HTTPS/);
  assert.deepEqual(await fs.readdir(store.files), []);
  assert.notEqual(libraryId('https://example.com/audio'), libraryId('https://example.com/staging'));
});
test('failed, truncated and cancelled downloads never become saved media', async t => {
  const store = await fixture(t, { fetcher: async () => new Response('short', { headers: { 'content-length': '100' } }) });
  await assert.rejects(store.download({ key: 't1', url: 'https://example.com', path: 'bad.mp3' }), /incomplete/);
  assert.deepEqual(await fs.readdir(store.files), []);
  store.fetcher = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled'))));
  const job = store.download({ key: 't2', url: 'https://example.com', path: 'cancel.mp3' });
  await store.handle('cancel', { key: 't2' });
  await assert.rejects(job, /cancelled/);
  assert.deepEqual(await fs.readdir(store.files), []);
});
test('concurrent manifest saves retain the newest complete snapshot', async t => {
  const store = await fixture(t);
  await Promise.all([1, 2, 3].map(id => store.manifestWrite(JSON.stringify({ v: 1, tracks: [{ id, path: 'a.mp3' }] }))));
  assert.equal(JSON.parse(await store.manifestRead()).tracks[0].id, 3);
});
test('simultaneous tracks share a single artwork download', async t => {
  let calls = 0;
  const store = await fixture(t, { fetcher: async () => {
    calls++; await new Promise(resolve => setTimeout(resolve, 20));
    return new Response('picture', { headers: { 'content-type': 'image/jpeg' } });
  } });
  await Promise.all([1, 2].map(id => store.download({ key: 'c' + id, url: 'https://example.com/cover', path: '.covers/album.jpg' })));
  assert.equal(calls, 1);
});
