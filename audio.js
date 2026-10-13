/* Scray audio :: the page. Browse (folders, artists, albums, genres, search), play, shuffle, queue.
 * One file, no libraries. Talks to api.php with the session cookie. */
(function () {
  'use strict';

  const API = 'api.php';
  const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
  const QUEUE_SHOWN = 200;   // the queue panel draws this many upcoming tracks, however long the queue is

  // ---------------------------------------------------------------- helpers
  const $ = id => document.getElementById(id);
  const view = $('view');
  const enc = encodeURIComponent;

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }

  const store = {
    get(k, d) { try { const v = localStorage.getItem('scrayAudio.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('scrayAudio.' + k, JSON.stringify(v)); } catch (e) { /* private window: fine */ } },
  };

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const hh = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return hh ? `${hh}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  const fmtMs = ms => ms == null ? '' : fmt(ms / 1000);
  function longTime(ms) {
    const min = Math.round(ms / 60000);
    return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
  }
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

  function rand(n) { const a = new Uint32Array(1); crypto.getRandomValues(a); return Math.floor(a[0] / 4294967296 * n); }
  function shuffled(arr) {
    const r = arr.slice();
    for (let i = r.length - 1; i > 0; i--) { const j = rand(i + 1); [r[i], r[j]] = [r[j], r[i]]; }
    return r;
  }

  let toastTimer = 0;
  function toast(msg, bad) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('bad', !!bad);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), bad ? 4500 : 2200);
  }

  async function api(action, params) {
    const q = new URLSearchParams({ action, ...(params || {}) });
    let r, j;
    try { r = await fetch(`${API}?${q}`, { credentials: 'same-origin' }); }
    catch (e) { throw new Error('can’t reach the server'); }
    try { j = await r.json(); } catch (e) { throw new Error(`server answered ${r.status}`); }
    if (!r.ok || !j.ok) throw new Error(j.error || `server answered ${r.status}`);
    return j;
  }

  function coverEl(trackId, cls) {
    const el = h('div', { class: 'cover ' + (cls || '') }, h('span', { text: '♪' }));
    if (trackId != null) {
      const img = h('img', { src: `${API}?action=cover&t=${trackId}`, alt: '', loading: 'lazy', decoding: 'async' });
      img.addEventListener('error', () => img.remove());
      el.append(img);
    }
    return el;
  }

  // ----------------------------------------------------------------- player
  const audio = new Audio();
  audio.preload = 'auto';
  const P = {
    queue: [], orig: [], idx: -1,
    shuffle: !!store.get('shuffle', false),
    repeat: store.get('repeat', 'off'),            // off | all | one
    urls: new Map(), seq: 0, retried: null, errRun: 0, unlocked: false, seeking: false,
  };
  audio.volume = Math.min(1, Math.max(0, store.get('vol', 1)));
  $('vol').value = Math.round(audio.volume * 100);
  paintRange($('vol'));

  // iOS only lets an element play without a tap once it has been started by one.
  // Our real source arrives after a network round trip, so start the element on
  // the tap with a silent clip, then swap the real track in.
  function unlock() {
    if (P.unlocked) return;
    P.unlocked = true;
    audio.src = SILENT;
    audio.play().catch(() => {});
  }

  async function getUrl(t, force) {
    const c = P.urls.get(t.id);
    if (!force && c && Date.now() - c.at < (c.ttl - 300) * 1000) return c.url;
    const j = await api('url', { id: t.id });
    P.urls.set(t.id, { url: j.url, at: Date.now(), ttl: j.expires_in || 3600 });
    if (P.urls.size > 80) P.urls.delete(P.urls.keys().next().value);
    return j.url;
  }
  const linkStale = (t, margin) => { const c = P.urls.get(t.id); return !c || Date.now() - c.at > (c.ttl - margin) * 1000; };

  async function load(i, opts) {
    const { play = true, at = 0 } = opts || {};
    const t = P.queue[i];
    if (!t) return;
    P.idx = i;
    const seq = ++P.seq;
    P.retried = null;
    paintNow(t);
    try {
      const url = await getUrl(t);
      if (seq !== P.seq) return;
      audio.src = url;
      if (at) audio.currentTime = at;
      if (play) await audio.play();
    } catch (e) {
      if (seq !== P.seq) return;
      if (e && e.name === 'NotAllowedError') { toast('Tap play to start'); return; }
      if (e && e.name === 'AbortError') return;
      toast(`Can’t play “${t.title}”: ${e.message || e}`, true);
      skipAfterError(t);
      return;
    }
    prefetchNext();
  }

  function prefetchNext() {   // sign the next link now so the change of track doesn't wait on the server
    const n = P.queue[P.idx + 1];
    if (n && linkStale(n, 600)) getUrl(n).catch(() => {});
  }

  function skipAfterError(t) {
    if (++P.errRun >= 3) { toast('Several tracks in a row failed - stopping', true); return; }
    setTimeout(() => { if (P.queue[P.idx] === t) next(true); }, 1200);
  }

  audio.addEventListener('error', async () => {
    const t = P.queue[P.idx];
    if (!t || audio.src === SILENT || audio.src.startsWith('data:')) return;
    if (P.retried !== t.id) {            // first failure is usually an expired link: sign a new one and carry on
      P.retried = t.id;
      const at = audio.currentTime || 0;
      try {
        audio.src = await getUrl(t, true);
        if (at) audio.currentTime = at;
        await audio.play();
        return;
      } catch (e) { /* fall through */ }
    }
    toast(`Can’t play “${t.title}”`, true);
    skipAfterError(t);
  });

  audio.addEventListener('playing', () => { P.errRun = 0; });
  audio.addEventListener('play', paintPlay);
  audio.addEventListener('pause', paintPlay);
  audio.addEventListener('ended', () => { if (!audio.src.startsWith('data:')) next(true); });   // not the silent unlock clip
  audio.addEventListener('durationchange', paintTime);
  audio.addEventListener('timeupdate', paintTime);

  function startQueue(list, i) {
    if (!list.length) return;
    unlock();
    P.orig = list.slice();
    if (P.shuffle) {
      const first = list[i];
      P.queue = [first, ...shuffled(list.filter((_, k) => k !== i))];
      P.idx = 0;
    } else {
      P.queue = list.slice();
    }
    load(P.shuffle ? 0 : i);
    renderQueue();
  }

  function playList(list, shuffle) {   // Play / Shuffle buttons: a fresh queue, in order or not
    if (!list.length) { toast('Nothing to play here'); return; }
    setShuffle(shuffle);
    startQueue(list, shuffle ? rand(list.length) : 0);
  }

  function setShuffle(on) {
    on = !!on;
    if (on === P.shuffle) return;
    P.shuffle = on;
    store.set('shuffle', on);
    const cur = P.queue[P.idx];
    if (cur && P.queue.length) {
      if (on) {
        P.queue = [cur, ...shuffled(P.queue.filter((_, k) => k !== P.idx))];
        P.idx = 0;
      } else {
        P.queue = P.orig.slice();
        let k = P.queue.findIndex(t => t.id === cur.id);
        if (k < 0) { P.queue.push(cur); k = P.queue.length - 1; }
        P.idx = k;
      }
    }
    paintControls();
    renderQueue();
  }

  function enqueue(t, playNext) {
    if (!P.queue.length) { startQueue([t], 0); return; }
    P.orig.push(t);
    if (playNext) P.queue.splice(P.idx + 1, 0, t); else P.queue.push(t);
    toast(playNext ? `Playing next: ${t.title}` : `Added: ${t.title}`);
    renderQueue();
    prefetchNext();
  }

  function next(auto) {
    if (!P.queue.length) return;
    if (auto && P.repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
    let i = P.idx + 1;
    if (i >= P.queue.length) {
      if (P.repeat === 'all') i = 0;
      else { if (auto) { audio.pause(); paintPlay(); } return; }
    }
    load(i);
  }

  function prev() {
    if (!P.queue.length) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (P.idx > 0) load(P.idx - 1);
    else if (P.repeat === 'all') load(P.queue.length - 1);
    else audio.currentTime = 0;
  }

  async function togglePlay() {
    if (P.idx < 0) { shuffleAll(); return; }
    unlock();
    if (!audio.paused) { audio.pause(); return; }
    const t = P.queue[P.idx];
    if (audio.src.startsWith('data:') || !audio.src || linkStale(t, 120)) {
      await load(P.idx, { play: true, at: audio.src.startsWith('data:') ? 0 : audio.currentTime || 0 });
      return;
    }
    audio.play().catch(() => {});
  }

  function seekBy(sec) {
    if (P.idx < 0) return;
    const d = audio.duration;
    audio.currentTime = Math.max(0, Math.min(isFinite(d) ? d - 0.5 : 1e9, audio.currentTime + sec));
  }

  async function shuffleAll() {
    const btn = $('shuffleall');
    btn.disabled = true;
    try {
      const j = await api('tracks', { limit: 100000 });
      if (!j.tracks.length) { toast('The library is empty - has the scanner run?', true); return; }
      toast(`Shuffling ${plural(j.tracks.length, 'track')}`);
      playList(j.tracks, true);
    } catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; }
  }

  // ------------------------------------------------------------ player UI
  function paintRange(el) { el.style.setProperty('--fill', (el.value - el.min) / (el.max - el.min) * 100 + '%'); }

  function paintNow(t) {
    $('nptitle').textContent = t.title;
    const sub = $('npsub');
    sub.replaceChildren();
    if (t.artist) sub.append(h('a', { href: `#/artist/${enc(t.albumArtist || t.artist)}`, text: t.artist }));
    if (t.album) sub.append(' · ', h('a', { href: `#/album/${enc(t.albumArtist)}/${enc(t.album)}`, text: t.album }));
    const cv = $('npcover');
    cv.replaceChildren(h('span', { text: '♪' }));
    if (t.cover) { const img = h('img', { src: `${API}?action=cover&t=${t.id}`, alt: '' }); img.addEventListener('error', () => img.remove()); cv.append(img); }
    document.title = `${t.title} – ${t.artist || 'Scray audio'}`;
    $('tdur').textContent = fmtMs(t.ms);
    $('tcur').textContent = '0:00';
    $('seek').value = 0; paintRange($('seek'));
    markNow();
    renderQueue();
    setMediaSession(t);
  }

  function paintPlay() {
    const playing = !audio.paused && !audio.ended;
    $('bplay').textContent = playing ? '⏸' : '▶';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }

  function paintControls() {
    const s = $('bshuffle'), r = $('brepeat');
    s.setAttribute('aria-pressed', String(P.shuffle));
    r.setAttribute('aria-pressed', String(P.repeat !== 'off'));
    r.dataset.mode = P.repeat;
    r.title = `Repeat: ${P.repeat}`;
  }

  let lastPos = 0;
  function paintTime() {
    const t = P.queue[P.idx];
    const dur = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (t && t.ms ? t.ms / 1000 : 0);
    if (!P.seeking) {
      $('tcur').textContent = fmt(audio.currentTime);
      $('seek').value = dur ? Math.min(1000, audio.currentTime / dur * 1000) : 0;
      paintRange($('seek'));
    }
    if (dur) $('tdur').textContent = fmt(dur);
    const now = Date.now();
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && dur && now - lastPos > 1000) {
      lastPos = now;
      try { navigator.mediaSession.setPositionState({ duration: dur, position: Math.min(audio.currentTime, dur), playbackRate: 1 }); } catch (e) { /* not supported */ }
    }
  }

  function markNow() {
    const cur = P.queue[P.idx];
    document.querySelectorAll('.trk.now').forEach(el => el.classList.remove('now'));
    if (cur) document.querySelectorAll(`.trk[data-id="${cur.id}"]`).forEach(el => el.classList.add('now'));
  }

  function setMediaSession(t) {
    if (!('mediaSession' in navigator)) return;
    const abs = new URL(`${API}?action=cover&t=${t.id}`, location.href).href;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album,
      artwork: t.cover ? [{ src: abs, sizes: '512x512' }] : [],
    });
  }
  if ('mediaSession' in navigator) {
    const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (e) { /* unsupported action */ } };
    set('play', () => togglePlay());
    set('pause', () => audio.pause());
    set('previoustrack', prev);
    set('nexttrack', () => next(false));
    set('seekbackward', d => seekBy(-((d && d.seekOffset) || 10)));
    set('seekforward', d => seekBy((d && d.seekOffset) || 10));
    set('seekto', d => { if (d && d.seekTime != null) audio.currentTime = d.seekTime; });
  }

  // ------------------------------------------------------------ queue panel
  function renderQueue() {
    const n = P.queue.length;
    $('qn').textContent = n ? String(n) : '';
    const panel = $('queuepanel');
    if (panel.hidden) return;
    $('qcount').textContent = n ? `${plural(n, 'track')}${P.shuffle ? ' · shuffled' : ''}` : '';
    const list = $('qlist');
    list.replaceChildren();
    if (!n) { list.append(h('li', { class: 'more', text: 'Nothing queued' })); return; }
    const from = Math.max(0, P.idx - 3), to = Math.min(n, Math.max(P.idx, 0) + QUEUE_SHOWN);
    for (let i = from; i < to; i++) {
      const t = P.queue[i];
      list.append(h('li', { class: i === P.idx ? 'now' : '', onclick: () => load(i) },
        h('span', { class: 'q-t' }, h('b', { text: t.title }), h('i', { text: [t.artist, t.album].filter(Boolean).join(' · ') })),
        h('button', { class: 'q-x', title: 'Remove', 'aria-label': 'Remove from queue', text: '×', onclick: e => { e.stopPropagation(); removeFromQueue(i); } })));
    }
    if (to < n) list.append(h('li', { class: 'more', text: `…and ${(n - to).toLocaleString()} more` }));
    const cur = list.querySelector('.now');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function removeFromQueue(i) {
    const [t] = P.queue.splice(i, 1);
    const k = P.orig.findIndex(x => x.id === t.id);
    if (k >= 0) P.orig.splice(k, 1);
    if (i < P.idx) P.idx--;
    else if (i === P.idx) {
      if (P.queue[i]) load(i);                 // the next track slid into this place
      else { audio.pause(); audio.removeAttribute('src'); audio.load(); P.idx = P.queue.length - 1; if (P.idx >= 0) paintNow(P.queue[P.idx]); }
    }
    renderQueue();
  }

  $('bqueue').addEventListener('click', () => {
    const p = $('queuepanel');
    p.hidden = !p.hidden;
    $('bqueue').setAttribute('aria-pressed', String(!p.hidden));
    renderQueue();
  });
  $('qclose').addEventListener('click', () => { $('queuepanel').hidden = true; $('bqueue').setAttribute('aria-pressed', 'false'); });
  $('qclear').addEventListener('click', () => {
    const cur = P.queue[P.idx];
    P.queue = cur ? [cur] : []; P.orig = P.queue.slice(); P.idx = cur ? 0 : -1;
    renderQueue();
  });

  // ------------------------------------------------------------ player wiring
  $('bplay').addEventListener('click', togglePlay);
  $('bnext').addEventListener('click', () => { unlock(); next(false); });
  $('bprev').addEventListener('click', () => { unlock(); prev(); });
  $('bshuffle').addEventListener('click', () => setShuffle(!P.shuffle));
  $('brepeat').addEventListener('click', () => {
    P.repeat = { off: 'all', all: 'one', one: 'off' }[P.repeat] || 'off';
    store.set('repeat', P.repeat);
    paintControls();
    toast(`Repeat: ${P.repeat}`);
  });
  $('shuffleall').addEventListener('click', () => { unlock(); shuffleAll(); });
  const seek = $('seek');
  seek.addEventListener('input', () => {
    P.seeking = true;
    const t = P.queue[P.idx];
    const dur = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (t && t.ms ? t.ms / 1000 : 0);
    $('tcur').textContent = fmt(seek.value / 1000 * dur);
    paintRange(seek);
  });
  seek.addEventListener('change', () => {
    const t = P.queue[P.idx];
    const dur = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (t && t.ms ? t.ms / 1000 : 0);
    if (dur) audio.currentTime = seek.value / 1000 * dur;
    P.seeking = false;
  });
  $('vol').addEventListener('input', e => {
    audio.volume = e.target.value / 100;
    store.set('vol', audio.volume);
    paintRange(e.target);
  });

  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const k = e.key.toLowerCase();
    if (k === ' ' && tag !== 'button' && tag !== 'a') { e.preventDefault(); togglePlay(); }
    else if (k === 'n') next(false);
    else if (k === 'p') prev();
    else if (k === 's') setShuffle(!P.shuffle);
    else if (k === 'l' || k === 'arrowright') seekBy(10);
    else if (k === 'j' || k === 'arrowleft') seekBy(-10);
    else if (k === 'm') audio.muted = !audio.muted;
    else if (k === '/') { e.preventDefault(); $('search').focus(); }
  });

  // ------------------------------------------------------------------ lists
  function trackList(tracks, o) {
    o = o || {};
    const aa = o.albumArtist;
    const showArtist = !aa || tracks.some(t => t.artist && t.artist !== aa);
    const box = h('div', { class: 'tracks' + (o.noAlbum ? ' noalb' : '') + (showArtist ? '' : ' noart') });
    box.append(h('div', { class: 'thead' }, h('span', { text: '#' }), h('span', { text: 'Title' }), h('span', { text: 'Artist' }), h('span', { text: 'Album' }), h('span', { text: 'Time' }), h('span')));
    let disc = null;
    const multiDisc = o.discs && new Set(tracks.map(t => t.disc || 1)).size > 1;
    tracks.forEach((t, i) => {
      if (multiDisc && (t.disc || 1) !== disc) { disc = t.disc || 1; box.append(h('div', { class: 'disc', text: `Disc ${disc}` })); }
      const row = h('div', { class: 'trk', role: 'button', tabindex: '0', dataset: { id: t.id } },
        h('span', { class: 'num' }, h('span', { text: String(o.trackNumbers ? (t.no ?? i + 1) : i + 1) })),
        h('span', { class: 'ttl' }, h('span', { class: 't', text: t.title }), h('span', { class: 'sub', text: (o.noAlbum ? [showArtist ? t.artist : ''] : [t.artist, t.album]).filter(Boolean).join(' · ') })),
        h('span', { class: 'art', text: t.artist }),
        h('span', { class: 'alb', text: t.album }),
        h('span', { class: 'dur', text: fmtMs(t.ms) }),
        h('button', {
          class: 'add', title: 'Add to queue (Shift: play next)', 'aria-label': 'Add to queue', text: '+',
          onclick: e => { e.stopPropagation(); enqueue(t, e.shiftKey); },
        }));
      row.addEventListener('click', () => startQueue(tracks, i));
      row.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); startQueue(tracks, i); } });
      box.append(row);
    });
    return box;
  }

  function albumCard(a) {
    return h('a', { class: 'card', href: `#/album/${enc(a.artist)}/${enc(a.album)}` },
      h('div', { class: 'cv' }, coverEl(a.art),
        h('button', {
          class: 'play', title: 'Play album', 'aria-label': `Play ${a.album}`, text: '▶',
          onclick: async e => {
            e.preventDefault(); e.stopPropagation(); unlock();
            try { playList((await api('tracks', { artist: a.artist, album: a.album })).tracks, false); } catch (err) { toast(err.message, true); }
          },
        })),
      h('div', { class: 'cn', text: a.album || '(no album)' }),
      h('div', { class: 'cs', text: [a.artist, a.year].filter(Boolean).join(' · ') }));
  }

  function actions(getTracks, extra) {
    const run = async shuffle => {
      unlock();
      try { playList(await getTracks(), shuffle); } catch (e) { toast(e.message, true); }
    };
    return h('div', { class: 'bar' },
      h('button', { class: 'btn go', text: '▶ Play', onclick: () => run(false) }),
      h('button', { class: 'btn', text: '🔀 Shuffle', onclick: () => run(true) }),
      extra);
  }

  // ------------------------------------------------------------------ views
  let viewSeq = 0;
  const show = (my, ...els) => { if (my === viewSeq) { view.replaceChildren(...els); markNow(); } };

  async function viewFolders(my, path) {
    const [j, st] = await Promise.all([api('ls', { path }), path ? null : api('stats').catch(() => null)]);
    const segs = path ? path.split('/') : [];
    const crumbs = h('div', { class: 'crumbs' }, segs.length ? h('a', { href: '#/', text: 'Library' }) : h('span', { class: 'here', text: 'Library' }));
    segs.forEach((s, i) => {
      crumbs.append(h('span', { class: 'sep', text: '›' }));
      const p = segs.slice(0, i + 1).join('/');
      crumbs.append(i === segs.length - 1 ? h('span', { class: 'here', text: s }) : h('a', { href: `#/f/${enc(p)}`, text: s }));
    });
    const folderTracks = () => api('tracks', { folder: path, order: 'path', limit: 100000 }).then(r => r.tracks);
    const head = h('div', { class: 'pagehead small' }, j.art != null ? coverEl(j.art) : null, h('div', {}, crumbs,
      h('div', { class: 'subtitle', text: j.total ? plural(j.total, 'track') + (j.folders.length ? ` in ${plural(j.folders.length, 'folder')}` : '') : '' })));
    const out = [head];
    if (j.total) out.push(actions(j.folders.length ? folderTracks : async () => j.tracks));

    if (j.folders.length) {
      out.push(h('div', { class: 'folders' }, j.folders.map(f => h('a', { class: 'folder', href: `#/f/${enc(f.path)}` },
        h('span', { class: 'ic', text: '📁' }), h('span', { class: 'nm', text: f.name, title: f.name }),
        h('span', { class: 'ct', text: plural(f.tracks, 'track') }),
        h('button', {
          class: 'pl', title: 'Shuffle this folder', 'aria-label': `Shuffle ${f.name}`, text: '🔀',
          onclick: async e => { e.preventDefault(); e.stopPropagation(); unlock(); try { playList((await api('tracks', { folder: f.path, order: 'path', limit: 100000 })).tracks, true); } catch (err) { toast(err.message, true); } },
        })))));
    }
    if (j.tracks.length) out.push(trackList(j.tracks, { trackNumbers: false }));
    if (!j.total) {
      out.push(h('div', { class: 'empty', text: path ? 'Nothing in this folder.' : 'The library is empty. Run the scanner on the gateway (see the README), then reload.' }));
    }
    if (st) out.push(h('p', { class: 'subtitle', style: 'margin-top:28px' },
      `${plural(st.tracks, 'track')} · ${plural(st.albums, 'album')} · ${plural(st.artists, 'artist')} · ${longTime(st.ms)}`,
      st.scan && st.scan.finished_at ? ` · last scan ${st.scan.finished_at.slice(0, 16).replace('T', ' ')} UTC` : '',
      st.untagged ? ` · ${plural(st.untagged, 'file')} waiting for tags` : ''));
    show(my, ...out);
  }

  const firstLetter = s => {
    const c = s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^(the|a|an) /i, '').charAt(0).toUpperCase();
    return /[A-Z]/.test(c) ? c : '#';
  };

  async function viewArtists(my) {
    const { artists } = await api('artists');
    const out = [];
    const jump = h('div', { class: 'jump' });
    const list = h('div');
    let letter = null, grid = null;
    const seen = [];
    for (const a of artists) {
      const l = firstLetter(a.name);
      if (l !== letter) {
        letter = l; seen.push(l);
        list.append(h('div', { class: 'letter', id: 'L-' + l, text: l }));
        grid = h('div', { class: 'list' });
        list.append(grid);
      }
      grid.append(h('a', { class: 'item', href: `#/artist/${enc(a.name)}` }, h('span', { class: 'nm', text: a.name, title: a.name }), h('span', { class: 'ct', text: plural(a.albums, 'album') })));
    }
    seen.forEach(l => jump.append(h('a', { href: 'javascript:void(0)', text: l, onclick: e => { e.preventDefault(); document.getElementById('L-' + l).scrollIntoView({ block: 'start' }); window.scrollBy(0, -100); } })));
    out.push(h('h1', { class: 'title', text: 'Artists' }), h('div', { class: 'subtitle', text: plural(artists.length, 'artist') }), jump, list);
    if (!artists.length) out.push(h('div', { class: 'empty', text: 'No artists yet.' }));
    show(my, ...out);
  }

  async function viewArtist(my, name) {
    const { albums } = await api('albums', { artist: name });
    const real = albums.filter(a => a.album);
    const loose = albums.find(a => !a.album);
    const art = (albums.find(a => a.art != null) || {}).art;
    const tracks = albums.reduce((n, a) => n + a.tracks, 0);
    const out = [
      h('div', { class: 'pagehead' }, coverEl(art), h('div', {}, h('h1', { class: 'title', text: name }),
        h('div', { class: 'subtitle', text: `${plural(real.length, 'album')} · ${plural(tracks, 'track')}` }))),
      actions(() => api('tracks', { artist: name, limit: 100000 }).then(r => r.tracks)),
    ];
    if (real.length) out.push(h('div', { class: 'grid' }, real.map(albumCard)));
    if (loose) out.push(h('h2', { class: 'sec', text: 'Tracks with no album' }), h('div', { class: 'grid' }, albumCard(loose)));
    if (!albums.length) out.push(h('div', { class: 'empty', text: 'Nothing found for this artist.' }));
    show(my, ...out);
  }

  async function viewAlbums(my) {
    const { albums } = await api('albums');
    const grid = h('div', { class: 'grid' });
    const paint = q => {
      q = q.trim().toLowerCase();
      grid.replaceChildren(...albums.filter(a => !q || (a.album + ' ' + a.artist).toLowerCase().includes(q)).map(albumCard));
    };
    const f = h('input', { class: 'filter', type: 'search', placeholder: 'Filter albums', 'aria-label': 'Filter albums', oninput: () => paint(f.value) });
    paint('');
    show(my, h('h1', { class: 'title', text: 'Albums' }), h('div', { class: 'bar' }, f, h('span', { class: 'meta', text: plural(albums.length, 'album') })), grid,
      albums.length ? null : h('div', { class: 'empty', text: 'No albums yet.' }));
  }

  async function viewAlbum(my, artist, album) {
    const { tracks } = await api('tracks', { artist, album, limit: 5000 });
    if (!tracks.length) { show(my, h('div', { class: 'empty', text: 'Album not found.' })); return; }
    const ms = tracks.reduce((n, t) => n + (t.ms || 0), 0);
    const year = (tracks.find(t => t.year) || {}).year;
    const cov = tracks.find(t => t.cover);
    show(my,
      h('div', { class: 'pagehead' }, coverEl(cov ? cov.id : null), h('div', {},
        h('h1', { class: 'title', text: album || '(no album)' }),
        h('div', { class: 'subtitle' }, h('a', { href: `#/artist/${enc(artist)}`, text: artist }), year ? ` · ${year}` : '', ` · ${plural(tracks.length, 'track')} · ${longTime(ms)}`))),
      actions(async () => tracks),
      trackList(tracks, { noAlbum: true, albumArtist: artist, trackNumbers: true, discs: true }));
  }

  async function viewGenres(my) {
    const { genres } = await api('genres');
    show(my, h('h1', { class: 'title', text: 'Genres' }), h('div', { class: 'subtitle', text: plural(genres.length, 'genre') }),
      h('div', { class: 'list', style: 'margin-top:14px' }, genres.map(g => h('a', { class: 'item', href: `#/genre/${enc(g.name)}` },
        h('span', { class: 'nm', text: g.name }), h('span', { class: 'ct', text: plural(g.tracks, 'track') })))),
      genres.length ? null : h('div', { class: 'empty', text: 'No genres tagged yet.' }));
  }

  async function viewGenre(my, genre) {
    const j = await api('tracks', { genre, limit: 5000 });
    show(my, h('h1', { class: 'title', text: genre }),
      h('div', { class: 'subtitle', text: plural(j.tracks.length, 'track') + (j.capped ? ' (first 5,000)' : '') }),
      actions(async () => j.tracks), trackList(j.tracks));
  }

  async function viewSearch(my, q) {
    const j = await api('search', { q });
    const out = [h('h1', { class: 'title', text: `“${q}”` })];
    if (!j.tracks.length && !j.artists.length && !j.albums.length) out.push(h('div', { class: 'empty', text: 'No matches.' }));
    if (j.artists.length) out.push(h('h2', { class: 'sec', text: 'Artists' }), h('div', { class: 'list' }, j.artists.map(a =>
      h('a', { class: 'item', href: `#/artist/${enc(a.name)}` }, h('span', { class: 'nm', text: a.name }), h('span', { class: 'ct', text: plural(a.tracks, 'track') })))));
    if (j.albums.length) out.push(h('h2', { class: 'sec', text: 'Albums' }), h('div', { class: 'grid' }, j.albums.map(albumCard)));
    if (j.tracks.length) out.push(h('h2', { class: 'sec', text: 'Tracks' }), actions(async () => j.tracks), trackList(j.tracks));
    show(my, ...out);
  }

  // ----------------------------------------------------------------- router
  const TABS = { f: 'folders', '': 'folders', artists: 'artists', artist: 'artists', albums: 'albums', album: 'albums', genres: 'genres', genre: 'genres', search: '' };

  async function route() {
    const my = ++viewSeq;
    const parts = (location.hash.replace(/^#\/?/, '')).split('/').map(s => { try { return decodeURIComponent(s); } catch (e) { return s; } });
    const kind = parts[0] || '';
    document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === TABS[kind]));
    if (kind !== 'search' && $('search').value) $('search').value = '';
    window.scrollTo(0, 0);
    view.replaceChildren(h('div', { class: 'loading', text: 'Loading…' }));
    try {
      switch (kind) {
        case '': case 'f': await viewFolders(my, kind === 'f' ? (parts[1] || '') : ''); break;
        case 'artists': await viewArtists(my); break;
        case 'artist': await viewArtist(my, parts[1] || ''); break;
        case 'albums': await viewAlbums(my); break;
        case 'album': await viewAlbum(my, parts[1] || '', parts[2] || ''); break;
        case 'genres': await viewGenres(my); break;
        case 'genre': await viewGenre(my, parts[1] || ''); break;
        case 'search': $('search').value = parts[1] || ''; await viewSearch(my, parts[1] || ''); break;
        default: show(my, h('div', { class: 'empty', text: 'Page not found.' }));
      }
    } catch (e) {
      if (my !== viewSeq) return;
      view.replaceChildren(h('div', { class: 'empty' }, `Couldn’t load this: ${e.message}`, h('button', { text: 'Retry', onclick: route })));
    }
  }
  window.addEventListener('hashchange', route);

  // search box: type to search, Enter to go now, empty to go back
  let searchTimer = 0;
  const go = q => {
    q = q.trim();
    const onSearch = location.hash.startsWith('#/search/');
    if (!q) { if (onSearch) location.hash = '#/'; return; }
    const target = '#/search/' + enc(q);
    if (onSearch) { history.replaceState(null, '', target); route(); } else location.hash = target;
  };
  $('search').addEventListener('input', e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => go(e.target.value), 300); });
  $('searchform').addEventListener('submit', e => { e.preventDefault(); clearTimeout(searchTimer); go($('search').value); });

  paintControls();
  paintPlay();
  route();
})();
