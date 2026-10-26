// Exercise the production menu action with controlled library replies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../audio.js'), 'utf8');
function player(tracks, offline = false) {
  const played = [], messages = [], calls = [];
  const context = vm.createContext({
    P: { seq: 0, queue: [], idx: -1 }, fold: s => s.toLowerCase().normalize('NFD').replace(/\p{Mn}+/gu, ''),
    shuffled: list => list.slice().reverse(), store: { set() {} }, paintControls() {}, renderQueue() {},
    OFF: { has: id => tracks.some(t => t.id === id) },
    unlock() {}, toast: text => messages.push(text), offlineOn: () => offline,
    plural: n => `${n} tracks`, playList: (list, shuffle) => played.push({ list, shuffle }),
    api: async (action, params) => {
      calls.push(action);
      return action === 'genres' ? { genres: [...new Set(tracks.map(t => t.genre))].map(name => ({ name })) }
        : { tracks: tracks.filter(t => t.genre === params.genre) };
    },
  });
  vm.runInContext(source.slice(source.indexOf('  function genreKeys('), source.indexOf('  function trackMenuItems(')), context);
  return { context, played, messages, calls };
}
test('matches whole genres, normalizes case and spacing, deduplicates, excludes seed and unrelated music', async () => {
  const p = player([{ id: 1, genre: 'Rock' }, { id: 2, genre: ' rock ' }, { id: 3, genre: 'Jazz; ROCK' },
    { id: 3, genre: 'ROCK' }, { id: 4, genre: 'Hard Rock' }, { id: 5, genre: 'Pop/Rock' }, { id: 6, genre: 'Jazz' }]);
  await p.context.moreLikeThis({ id: 1, genre: 'Rock' });
  assert.deepEqual(Array.from(p.played[0].list, t => t.id), [2, 3]);
  assert.equal(p.played[0].shuffle, true);
});
test('missing genre and no offline matches preserve the queue', async () => {
  const p = player([{ id: 1, genre: 'R&B' }], true);
  await p.context.moreLikeThis({ id: 1, genre: 'Unknown' });
  assert.equal(p.calls.length, 0);
  await p.context.moreLikeThis({ id: 1, genre: 'R&B' });
  assert.equal(p.played.length, 0);
  assert.match(p.messages.at(-1), /No other saved/);
});
test('a newer playback choice cancels an outstanding recommendation', async () => {
  const p = player([]);
  p.context.api = async () => { p.context.P.seq++; return { genres: [{ name: 'Rock' }] }; };
  await p.context.moreLikeThis({ id: 1, genre: 'Rock' });
  assert.equal(p.played.length, 0);
});
test('offline queue contains only saved matching tracks', async () => {
  const p = player([{ id: 2, genre: 'Soul' }, { id: 3, genre: 'Jazz' }], true);
  await p.context.moreLikeThis({ id: 1, genre: 'Soul' });
  assert.deepEqual(Array.from(p.played[0].list, t => t.id), [2]);
});
test('server failure preserves queue and reports error', async () => {
  const p = player([]);
  p.context.api = async () => { throw new Error('Unavailable'); };
  await p.context.moreLikeThis({ id: 1, genre: 'Rock' });
  assert.equal(p.played.length, 0);
  assert.equal(p.messages.at(-1), 'Unavailable');
});
test('keeps current source and replaces upcoming tracks without starting playback', async () => {
  const p = player([{ id: 1, genre: 'Rock' }, { id: 2, genre: 'Rock' }, { id: 3, genre: 'Rock' }]);
  const current = { id: 2, genre: 'Rock' };
  Object.assign(p.context.P, { queue: [{ id: 9 }, current, { id: 8 }], idx: 1 });
  p.context.unlock = () => { throw new Error('Must not touch active playback'); };
  await p.context.moreLikeThis({ id: 1, genre: 'Rock' });
  assert.equal(p.played.length, 0);
  assert.equal(p.context.P.queue[0], current);
  assert.deepEqual(Array.from(p.context.P.queue, t => t.id), [2, 3]);
  assert.deepEqual(Array.from(p.context.P.orig, t => t.id), [2, 3]);
  assert.equal(p.context.P.idx, 0);
  assert.equal(p.context.P.seq, 0);
});
