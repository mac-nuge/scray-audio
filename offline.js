/* Scray audio :: offline. Saves tracks on the phone (iOS app only), lists what is saved, and answers
 * the browse calls from that list when the page is in Offline mode.
 *
 * Three parts, in this order:
 *   1. createLocal(list) - the server's ls / tracks / artists / albums / genres / search / stats,
 *      worked out from a list of tracks in the page. tests/offline-parity.js checks it gives the
 *      same answers as api.php, so the Offline filter looks exactly like the library does.
 *   2. The bridge to the app (webkit.messageHandlers.scrayAudio). Not there in a browser: then
 *      ScrayOffline.available is false and the page hides everything offline.
 *   3. The store and the download queue. The list of saved tracks is kept in a small file in the
 *      Offline folder (manifestRead / manifestWrite), so it survives the app being reinstalled.
 *
 * Files live where Scray Native keeps its downloads: <the folder you picked>/Offline/<the track's
 * library path>. Album covers go in Offline/.covers/. */
(function (root) {
  'use strict';

  // ------------------------------------------------------------ 1. local browse
  const nocase = s => String(s).replace(/[A-Z]/g, c => c.toLowerCase());          // SQLite's NOCASE is ASCII only
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const num = x => (x == null ? -Infinity : x);                                    // SQLite sorts NULL first
  const fold = s => String(s).toLowerCase().normalize('NFD').replace(/\p{Mn}+/gu, '');
  const sortKey = s => String(s).toLowerCase().replace(/^(the|a|an) /, '');
  const fname = t => t.path.slice(t.path.lastIndexOf('/') + 1);
  const cleanPath = p => String(p || '').split('/').filter(Boolean).join('/');

  function natcase(a, b) {                                                          // PHP's strnatcasecmp, near enough
    const re = /(\d+)|(\D+)/g;
    const A = nocase(a).match(re) || [], B = nocase(b).match(re) || [];
    for (let i = 0; i < Math.min(A.length, B.length); i++) {
      const x = A[i], y = B[i];
      if (/^\d/.test(x) && /^\d/.test(y)) {
        const xs = x.replace(/^0+/, ''), ys = y.replace(/^0+/, '');
        if (xs.length !== ys.length) return xs.length < ys.length ? -1 : 1;
        if (xs !== ys) return xs < ys ? -1 : 1;
      } else if (x !== y) return x < y ? -1 : 1;
    }
    return cmp(A.length, B.length);
  }

  function sortTracks(rows) {                                                       // disc, track no., then file name
    const numbered = rows.length > 0 && rows.every(t => t.no != null);
    return rows.slice().sort((a, b) => {
      if (numbered) {
        const c = (a.disc | 0) - (b.disc | 0) || (a.no | 0) - (b.no | 0);
        if (c) return c;
      }
      return natcase(fname(a), fname(b));
    });
  }

  function createLocal(list) {
    const rows = () => list().slice().sort((a, b) => a.id - b.id);                  // id order = the server's row order
    const firstCover = ts => { const t = ts.find(x => x.cover); return t ? t.id : null; };

    function filtered(p) {
      let r = rows();
      if (p.folder != null && cleanPath(p.folder) !== '') {
        const f = cleanPath(p.folder);
        r = r.filter(t => t.folder === f || t.folder.startsWith(f + '/'));
      }
      if (p.artist != null) r = r.filter(t => t.albumArtist === String(p.artist));
      if (p.album != null) r = r.filter(t => t.album === String(p.album));
      if (p.genre != null) r = r.filter(t => t.genre === String(p.genre));
      const q = String(p.q == null ? '' : p.q).trim();
      if (q) {
        const words = fold(q).split(/\s+/);
        r = r.filter(t => { const s = fold([t.title, t.artist, t.albumArtist, t.album, t.path].join(' ')); return words.every(w => s.includes(w)); });
      }
      return r;
    }

    function group(r, keyOf) {
      const m = new Map();
      for (const t of r) { const k = keyOf(t); if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
      return m;
    }
    const albumRow = ts => {
      const y = ts.reduce((m, t) => (t.year != null && (m == null || t.year > m) ? t.year : m), null);
      return { artist: ts[0].albumArtist, album: ts[0].album, year: y, tracks: ts.length, ms: ts.reduce((s, t) => s + (t.ms || 0), 0), art: firstCover(ts) };
    };
    const sortAlbums = a => a.sort((x, y) => cmp(sortKey(x.artist), sortKey(y.artist)) || num(x.year) - num(y.year) || cmp(sortKey(x.album), sortKey(y.album)));
    const albumsOf = r => [...group(r, t => t.albumArtist + '\u0000' + t.album).values()].map(albumRow);

    const A = {
      ls(p) {
        const path = cleanPath(p.path), prefix = path ? path + '/' : '';
        const all = rows();
        const here = sortTracks(all.filter(t => t.folder === path));
        const seg = new Map();
        for (const t of all) {
          if (t.folder === path || !t.folder.startsWith(prefix)) continue;
          const rest = t.folder.slice(prefix.length), i = rest.indexOf('/'), name = i < 0 ? rest : rest.slice(0, i);
          if (name) seg.set(name, (seg.get(name) || 0) + 1);
        }
        const folders = [...seg.keys()].sort(natcase).map(name => ({ name, path: prefix + name, tracks: seg.get(name) }));
        return { ok: true, path, folders, tracks: here, art: firstCover(all.filter(t => t.folder === path)), total: here.length + [...seg.values()].reduce((a, b) => a + b, 0) };
      },
      tracks(p) {
        const limit = Math.max(1, Math.min(100000, parseInt(p.limit, 10) || 5000));
        let r = filtered(p);
        if (p.order === 'path') r.sort((a, b) => cmp(nocase(a.folder), nocase(b.folder)) || cmp(nocase(fname(a)), nocase(fname(b))));
        else r.sort((a, b) => cmp(nocase(a.albumArtist), nocase(b.albumArtist)) || cmp(nocase(a.album), nocase(b.album)) ||
          num(a.disc) - num(b.disc) || num(a.no) - num(b.no) || cmp(nocase(fname(a)), nocase(fname(b))));
        r = r.slice(0, limit);
        if (p.album != null && (p.artist != null || p.folder != null)) r = sortTracks(r);
        return { ok: true, tracks: r, capped: r.length >= limit };
      },
      artists() {
        const out = [...group(rows(), t => t.albumArtist).entries()].map(([name, ts]) => ({
          name, albums: new Set(ts.map(t => t.album)).size, tracks: ts.length, art: firstCover(ts) }));
        out.sort((a, b) => cmp(sortKey(a.name), sortKey(b.name)));
        return { ok: true, artists: out };
      },
      albums(p) {
        const r = p.artist != null ? rows().filter(t => t.albumArtist === String(p.artist)) : rows().filter(t => t.album !== '');
        return { ok: true, albums: sortAlbums(albumsOf(r)) };
      },
      genres() {
        const out = [...group(rows().filter(t => t.genre !== ''), t => t.genre).entries()].map(([name, ts]) => ({ name, tracks: ts.length }));
        out.sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()));
        return { ok: true, genres: out };
      },
      search(p) {
        const q = String(p.q == null ? '' : p.q).trim();
        if (!q) return { ok: true, tracks: [], artists: [], albums: [], folders: [] };
        const tracks = filtered(p).sort((a, b) => cmp(nocase(a.albumArtist), nocase(b.albumArtist)) || cmp(nocase(a.album), nocase(b.album)) ||
          num(a.disc) - num(b.disc) || num(a.no) - num(b.no)).slice(0, 300);
        const fq = fold(q);
        const byArtist = [...group(rows(), t => t.albumArtist).entries()].sort((a, b) => cmp(a[0], b[0]));
        const artists = byArtist.filter(([n]) => fold(n).includes(fq)).slice(0, 30).map(([name, ts]) => ({ name, tracks: ts.length }));
        const albums = sortByGroupKey(albumsOf(rows().filter(t => t.album !== ''))).filter(a => fold(a.album).includes(fq)).slice(0, 40)
          .map(a => ({ artist: a.artist, album: a.album, year: a.year, tracks: a.tracks, art: a.art }));
        return { ok: true, tracks, artists, albums, folders: searchFolders(q) };
      },
      stats() {
        const r = rows();
        return { ok: true, tracks: r.length, artists: new Set(r.map(t => t.albumArtist)).size,
          albums: new Set(r.map(t => t.albumArtist + '\u001f' + t.album)).size, genres: new Set(r.filter(t => t.genre).map(t => t.genre)).size,
          ms: r.reduce((s, t) => s + (t.ms || 0), 0), untagged: 0, scan: null, offline: true };
      },
    };
    // api.php searchFolders(): folders whose path has every word, top-most only, with the tracks under each
    function searchFolders(q) {
      const words = fold(q.trim()).split(/\s+/).filter(Boolean);
      if (!words.length) return [];
      const count = new Map();
      for (const t of rows()) {
        const segs = t.folder.split('/');
        for (let i = 1; i <= segs.length; i++) {
          const f = segs.slice(0, i).join('/');
          if (f) count.set(f, (count.get(f) || 0) + 1);
        }
      }
      const hit = f => { const s = fold(f); return words.every(w => s.includes(w)); };
      const out = [];
      for (const [f, n] of count) {
        if (!hit(f)) continue;
        const i = f.lastIndexOf('/'), parent = i < 0 ? '' : f.slice(0, i);
        if (parent && count.has(parent) && hit(parent)) continue;
        out.push({ name: i < 0 ? f : f.slice(i + 1), path: f, tracks: n });
      }
      return out.sort((a, b) => natcase(a.path, b.path)).slice(0, 100);
    }
    function sortByGroupKey(a) { return a.sort((x, y) => cmp(x.artist, y.artist) || cmp(x.album, y.album)); }   // GROUP BY order: binary
    return (action, params) => (A[action] ? A[action](params || {}) : null);
  }

  if (typeof module !== 'undefined' && module.exports) { module.exports = { createLocal, natcase, fold }; }
  if (!root || !root.document) return;

  // ------------------------------------------------------------ 2. the bridge
  const handler = root.webkit && root.webkit.messageHandlers && root.webkit.messageHandlers.scrayAudio;
  const pending = {};
  root._saResolve = (id, v) => { const p = pending[id]; if (p) { delete pending[id]; p.res(v); } };
  root._saReject = (id, e) => { const p = pending[id]; if (p) { delete pending[id]; p.rej(new Error(e || 'failed')); } };
  const call = (action, payload) => new Promise((res, rej) => {
    const id = Math.random().toString(36).slice(2);
    pending[id] = { res, rej };
    handler.postMessage({ id, action, payload: payload || null });
  });

  // ------------------------------------------------------------ 3. store and queue
  const COVER_DIR = '.covers/';
  const S = { tracks: new Map(), folder: null, ready: false, jobs: new Map(), listeners: new Set(), saveTimer: 0, tick: 0, running: 0 };
  const MAX_AT_ONCE = 3;                                                            // ⚙️ downloads running together
  // A cover chosen in the library (coverv not 'f') gets its own name, so changing it fetches the new picture.
  const coverName = (folder, v) => (folder || '_').replace(/[\/\\:]/g, '~') + (v && v !== 'f' ? '@' + v : '') + '.jpg';
  const urlFor = rel => 'scray-audio://local/' + rel.split('/').map(encodeURIComponent).join('/');

  function changed(now) {
    if (now) { clearTimeout(S.tick); S.tick = 0; S.listeners.forEach(f => { try { f(); } catch (e) { /* a listener's problem */ } }); return; }
    if (!S.tick) S.tick = setTimeout(() => changed(true), 250);                      // progress arrives often; paint a few times a second
  }
  function saveSoon() {
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(() => {
      const text = JSON.stringify({ v: 1, tracks: [...S.tracks.values()] });
      call('manifestWrite', { text }).catch(() => {});
    }, 400);
  }

  async function init() {
    if (!handler) return;
    try {
      const st = await call('state');
      S.folder = st && st.folder || null;
      if (S.folder) {
        const text = await call('manifestRead');
        let m = null;
        try { m = text ? JSON.parse(text) : null; } catch (e) { m = null; }
        const files = new Map(((await call('offlineFiles')) || []).map(f => [f.path, f.size]));
        for (const t of (m && m.tracks) || []) if (files.has(t.path)) S.tracks.set(t.id, t);   // a file deleted in Files drops out
        if (m && m.tracks && S.tracks.size !== m.tracks.length) saveSoon();
      }
    } catch (e) { /* an old build without these: stay empty */ }
    S.ready = true;
    changed(true);
  }

  async function ensureFolder() {
    if (S.folder) return true;
    const r = await call('pickFolder');
    S.folder = r && r.folder || null;
    if (S.folder) await init();
    changed(true);
    return !!S.folder;
  }

  async function runJob(j, ctx) {
    const t = j.track;
    j.state = 'active'; changed();
    try {
      await call('download', { key: 't' + t.id, url: await ctx.getUrl(t), path: t.path });
      const entry = { ...t };
      if (t.cover) {
        const cf = coverName(t.folder, t.coverv);
        const have = [...S.tracks.values()].some(x => x.cf === cf);
        if (!have && ctx.getCoverUrl) {
          try { await call('download', { key: 'c' + t.id, url: await ctx.getCoverUrl(t), path: COVER_DIR + cf }); entry.cf = cf; } catch (e) { /* no cover is fine */ }
        } else if (have) entry.cf = cf;
      }
      S.tracks.set(t.id, entry);
      j.state = 'done'; saveSoon();
    } catch (e) {
      j.state = e && /cancel/i.test(e.message) ? 'cancelled' : 'error';
      j.error = e && e.message || 'failed';
    }
    changed(true);
  }

  function pump(ctx) {
    for (const j of S.jobs.values()) {
      if (S.running >= MAX_AT_ONCE) break;
      if (j.state !== 'queued') continue;
      S.running++;
      runJob(j, ctx).finally(() => { S.running--; pump(ctx); });
    }
    // finished jobs fall off the list a little later so the panel can show "done"
    setTimeout(() => { for (const [k, j] of S.jobs) if (j.state === 'done' || j.state === 'cancelled') S.jobs.delete(k); changed(true); }, 4000);
  }

  root._saProgress = (key, received, total) => {                                    // called by the app
    const j = S.jobs.get(+String(key).slice(1));
    if (j && key[0] === 't') { j.received = received; j.total = total; changed(); }
  };

  root.ScrayOffline = {
    available: !!handler,
    init,
    get ready() { return S.ready; },
    get folder() { return S.folder; },
    get count() { return S.tracks.size; },
    has: id => S.tracks.has(id),
    all: () => [...S.tracks.values()],
    local: createLocal(() => [...S.tracks.values()]),
    localUrl: t => (S.tracks.has(t.id) ? urlFor(S.tracks.get(t.id).path) : null),
    coverUrl: id => { const t = S.tracks.get(id); return t && t.cf ? urlFor(COVER_DIR + t.cf) : null; },
    onChange: f => { S.listeners.add(f); return () => S.listeners.delete(f); },
    jobs: () => [...S.jobs.values()],
    active: () => [...S.jobs.values()].filter(j => j.state === 'queued' || j.state === 'active').length,
    storage: () => call('storage'),
    pickFolder: ensureFolder,
    /** Queue tracks (not already saved). ctx: { getUrl(t), getCoverUrl(t) } give the signed links. */
    async download(tracks, ctx) {
      if (!await ensureFolder()) throw new Error('Choose a folder to keep the files in');
      let n = 0;
      for (const t of tracks) {
        if (!t.path || S.tracks.has(t.id)) continue;
        const old = S.jobs.get(t.id);
        if (old && (old.state === 'queued' || old.state === 'active')) continue;
        S.jobs.set(t.id, { track: t, state: 'queued', received: 0, total: t.size || 0 });
        n++;
      }
      changed(true);
      pump(ctx);
      return n;
    },
    async remove(tracks) {
      const gone = tracks.filter(t => S.tracks.has(t.id));
      if (!gone.length) return 0;
      const entries = gone.map(t => S.tracks.get(t.id));          // what is saved (it has the cover's name; the caller's track does not)
      const paths = entries.map(t => t.path);
      gone.forEach(t => S.tracks.delete(t.id));
      const left = new Set([...S.tracks.values()].map(t => t.cf).filter(Boolean));
      const orphan = [...new Set(entries.map(t => t.cf).filter(cf => cf && !left.has(cf)))].map(cf => COVER_DIR + cf);
      saveSoon(); changed(true);
      await call('remove', { paths: paths.concat(orphan) }).catch(() => {});
      return gone.length;
    },
    /**
     * Newer details from the library for saved tracks (an edit, a new cover): the saved copy takes them on.
     * The music file stays as it is; a changed cover is fetched, and a cover no longer used is removed.
     */
    async refresh(fresh, ctx) {
      let n = 0;
      const want = [], dropped = new Set();
      for (const t of fresh || []) {
        const old = S.tracks.get(t.id);
        if (!old || old.path !== t.path) continue;
        const cf = t.cover ? coverName(t.folder, t.coverv) : null;
        const next = { ...old, ...t, cf: old.cf };
        if ((cf || null) !== (old.cf || null)) {
          if (old.cf) dropped.add(old.cf);
          next.cf = null;
          if (cf) want.push([next, cf]);
        }
        const keys = ['title', 'artist', 'albumArtist', 'album', 'no', 'disc', 'year', 'genre', 'coverv', 'cover', 'edited', 'cf'];
        if (keys.some(k => (next[k] ?? null) !== (old[k] ?? null))) { S.tracks.set(t.id, next); n++; }
      }
      for (const [entry, cf] of want) {
        const have = [...S.tracks.values()].some(x => x !== entry && x.cf === cf);
        if (have) { entry.cf = cf; continue; }
        if (!ctx || !ctx.getCoverUrl) continue;
        try { await call('download', { key: 'c' + entry.id, url: await ctx.getCoverUrl(entry), path: COVER_DIR + cf }); entry.cf = cf; } catch (e) { /* no cover is fine */ }
      }
      if (n) {
        const used = new Set([...S.tracks.values()].map(t => t.cf).filter(Boolean));
        const orphan = [...dropped].filter(cf => !used.has(cf)).map(cf => COVER_DIR + cf);
        if (orphan.length) call('remove', { paths: orphan }).catch(() => {});
        saveSoon(); changed(true);
      }
      return n;
    },
    cancel(id) { const j = S.jobs.get(id); if (j && (j.state === 'queued' || j.state === 'active')) { if (j.state === 'queued') { j.state = 'cancelled'; changed(true); } else call('cancel', { key: 't' + id }).catch(() => {}); } },
    cancelAll() { for (const id of S.jobs.keys()) this.cancel(id); },
    retryFailed(ctx) { for (const j of S.jobs.values()) if (j.state === 'error') j.state = 'queued'; changed(true); pump(ctx); },
    clearFailed() { for (const [k, j] of S.jobs) if (j.state === 'error') S.jobs.delete(k); changed(true); },
  };
})(typeof window !== 'undefined' ? window : null);
