// The Offline filter answers browse calls from a list of saved tracks (offline.js).
// With every track "saved", it must answer exactly as api.php does.
//   node tests/offline-parity.js http://127.0.0.1:8098/api.php
'use strict';
const { createLocal } = require('../offline.js');
const API = process.argv[2];
let bad = 0, n = 0;

async function srv(action, p) {
  const q = new URLSearchParams({ action, ...(p || {}) });
  const r = await fetch(`${API}?${q}`, { headers: { Cookie: 'scray_test_session=1' } });
  return r.json();
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const all = (await srv('tracks', { limit: 100000 })).tracks;
  const local = createLocal(() => all);
  async function eq(action, p, pick) {
    n++;
    const want = await srv(action, p), got = local(action, p);
    const w = pick ? pick(want) : want, g = pick ? pick(got) : got;
    if (!same(w, g)) { bad++; console.log(`  FAIL offline ${action} ${JSON.stringify(p || {})}\n    server: ${JSON.stringify(w).slice(0, 400)}\n    local:  ${JSON.stringify(g).slice(0, 400)}`); }
  }
  // every folder, found the way the page finds them
  const seen = [];
  const walk = async path => { seen.push(path); for (const f of (await srv('ls', { path })).folders) await walk(f.path); };
  await walk('');
  for (const path of seen) {
    await eq('ls', { path });
    await eq('tracks', { folder: path, order: 'path', limit: 100000 });
  }
  await eq('tracks', { limit: 100000 });
  await eq('tracks', { limit: 2 });
  await eq('tracks', { order: 'path', limit: 100000 });
  const artists = (await srv('artists')).artists;
  await eq('artists');
  await eq('albums');
  await eq('genres');
  for (const a of artists) {
    await eq('albums', { artist: a.name });
    await eq('tracks', { artist: a.name });
    for (const al of (await srv('albums', { artist: a.name })).albums) await eq('tracks', { artist: a.name, album: al.album });
  }
  for (const g of (await srv('genres')).genres) await eq('tracks', { genre: g.name });
  for (const q of ['second album', 'edith', 'Édith', 'café', 'the', 'a', 'compil', 'live', 'artist one', 'zzzz', '%', 'mp3 flac']) {
    await eq('tracks', { q });
    await eq('search', { q });
  }
  await eq('stats', {}, j => ({ t: j.tracks, a: j.artists, al: j.albums, g: j.genres, ms: j.ms }));
  console.log(`  ${bad ? 'FAIL' : 'ok  '} offline answers match the server (${n} comparisons over ${all.length} tracks)`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('  FAIL offline parity crashed: ' + e.stack); process.exit(1); });
