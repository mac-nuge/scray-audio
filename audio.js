/* Scray audio :: the page. Browse (folders, artists, albums, genres, search), play, shuffle, queue.
 * One file, no libraries. Talks to api.php with the session cookie - or, in the iOS app (app.js), with this phone's
 * key. offline.js keeps the tracks saved on the phone and answers for them in Offline mode. */
(function () {
  'use strict';

  const APP = window.SCRAY_AUDIO || null;                    // set by app.js inside the iOS app, else null
  const OFF = window.ScrayOffline && window.ScrayOffline.available ? window.ScrayOffline : null;
  const apiUrl = () => (APP ? APP.api : 'api.php');
  const authInit = () => (APP ? { credentials: 'omit', headers: APP.key ? { 'X-Scray-Key': APP.key } : {} } : { credentials: 'same-origin' });
  const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
  const QUEUE_SHOWN = 200;   // the queue panel draws this many upcoming tracks, however long the queue is

  // ---------------------------------------------------------------- helpers
  const $ = id => document.getElementById(id);
  const view = $('view');
  const enc = encodeURIComponent;
  // An album's page. The folder is part of the link so an album whose tracks carry different album-artist
  // tags (a compilation with no album-artist tag) still opens as one album.
  const albumHash = t => `#/album/${enc(t.albumArtist)}/${enc(t.album)}` + (t.folder ? `/${enc(t.folder)}` : '');

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

  // Search folding: lower case, accents off (as api.php's foldText). Every word has to match somewhere.
  const fold = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/\p{Mn}+/gu, '');
  const matches = (q, ...fields) => { const s = fold(fields.join(' ')); return fold(q).split(/\s+/).filter(Boolean).every(w => s.includes(w)); };

  let toastTimer = 0;
  function toast(msg, bad) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('bad', !!bad);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), bad ? 4500 : 2200);
  }

  const LOCAL_ACTIONS = new Set(['ls', 'tracks', 'artists', 'albums', 'genres', 'search', 'stats']);

  async function api(action, params) {
    if (OFF && offlineOn()) {                                   // Offline mode: what is saved on the phone
      const local = OFF.local(action, params);
      if (local) return local;
    }
    const q = new URLSearchParams({ action, ...(params || {}) });
    let r, j;
    try { r = await fetch(`${apiUrl()}?${q}`, authInit()); }
    catch (e) {
      if (OFF && LOCAL_ACTIONS.has(action) && OFF.count) { setOffline(true, 'Can’t reach the server - showing what’s saved on this phone'); return OFF.local(action, params); }
      throw new Error('can’t reach the server');
    }
    try { j = await r.json(); } catch (e) { throw new Error(`server answered ${r.status}`); }
    if (r.status === 401 && APP) {
      if (OFF && OFF.count && LOCAL_ACTIONS.has(action)) { setOffline(true, 'Not signed in - showing what’s saved on this phone'); return OFF.local(action, params); }
      APP.signIn('This phone isn’t signed in (or was signed out). Sign in to reach the library.');
    }
    if (!r.ok || !j.ok) throw new Error(j.error || `server answered ${r.status}`);
    if (OFF && offlineOn() && action === 'playlist') j.tracks = j.tracks.filter(t => OFF.has(t.id));
    return j;
  }

  // Covers. In a browser the <img> carries the session cookie; in the app it can't send the key, so ask for a signed link.
  const coverLinks = new Map();
  const artVer = new Map();                 // track id -> which cover, once you change one (so the old picture isn't reused)
  const coverQueue = [];
  let coverBusy = 0;
  function coverPump() {
    while (coverBusy < 6 && coverQueue.length) {
      const { id, img } = coverQueue.shift();
      if (!img.isConnected) continue;
      coverBusy++;
      api('cover_url', { t: id })
        .then(j => { coverLinks.set(id, { url: j.url, until: Date.now() + (j.expires_in || 600) * 1000 }); img.src = j.url; })
        .catch(() => img.remove())
        .finally(() => { coverBusy--; coverPump(); });
    }
  }
  const coverIO = 'IntersectionObserver' in window ? new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    coverIO.unobserve(e.target);
    coverQueue.push({ id: +e.target.dataset.cover, img: e.target });
    coverPump();
  }), { rootMargin: '400px' }) : null;
  function setCover(img, id) {
    const local = OFF && OFF.coverUrl(id);
    if (local) { img.src = local; return; }
    if (!APP) { img.src = `api.php?action=cover&t=${id}` + (artVer.has(id) ? `&v=${enc(artVer.get(id))}` : ''); return; }
    const c = coverLinks.get(id);
    if (c && c.until > Date.now()) { img.src = c.url; return; }
    img.dataset.cover = id;
    if (coverIO) coverIO.observe(img); else { coverQueue.push({ id, img }); coverPump(); }
  }

  function coverEl(trackId, cls) {
    const el = h('div', { class: 'cover ' + (cls || '') }, h('span', { text: '♪' }));
    if (trackId != null) {
      const img = h('img', { alt: '', loading: 'lazy', decoding: 'async' });
      img.addEventListener('error', () => img.remove());
      el.append(img);
      setCover(img, trackId);
    }
    return el;
  }

  // ----------------------------------------------------------------- player
  const audio = new window.ScrayGaplessPlayer();
  audio.preload = 'auto';
  const P = {
    queue: [], orig: [], idx: -1,
    shuffle: !!store.get('shuffle', false),
    repeat: store.get('repeat', 'off'),            // off | all | one
    urls: new Map(), seq: 0, readySeq: -1, prefetchKey: '', retried: null, errRun: 0, unlocked: false, seeking: false,
  };
  audio.volume = Math.min(1, Math.max(0, store.get('vol', 1)));
  $('vol').value = Math.round(audio.volume * 100);
  paintRange($('vol'));

  // iOS only lets an element play without a tap once it has been started by one.
  // Our real source arrives after a network round trip, so start the element on
  // the tap with a silent clip, then swap the real track in.
  function unlock() {
    audio.unlock();
    if (P.unlocked) return;
    P.unlocked = true;
    audio.src = SILENT;
    audio.play().catch(() => {});
  }

  async function getUrl(t, force) {
    const saved = OFF && OFF.localUrl(t);                       // saved on this phone: play that, whatever the network says
    if (saved) return saved;
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
    audio.cancelNext();
    P.retried = null;
    paintNow(t);
    try {
      const url = await getUrl(t);
      if (seq !== P.seq) return;
      await audio.setTrack(url, t);
      if (seq !== P.seq) return;
      if (at) audio.currentTime = at;
      if (play) await audio.play();
      P.readySeq = seq;
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

  function prefetchNext() {
    if (P.readySeq !== P.seq) return;
    const i = P.repeat === 'one' ? P.idx : P.idx + 1 < P.queue.length ? P.idx + 1 : P.repeat === 'all' ? 0 : -1;
    const n = P.queue[i], seq = P.seq;
    const key = `${seq}:${i}:${n?.id ?? ''}`;
    if (P.prefetchKey === key) return;
    P.prefetchKey = key;
    audio.cancelNext();
    if (n) getUrl(n).then(url => {
      if (P.seq === seq && P.prefetchKey === key) audio.prepare(url, n, { index: i, id: n.id });
    }).catch(() => {});
  }

  audio.addEventListener('transition', event => {
    const { index, id } = event.detail;
    if (P.queue[index]?.id !== id) return;
    P.idx = index; P.readySeq = ++P.seq; P.retried = null;
    paintNow(P.queue[index]); paintPlay(); prefetchNext();
  });
  audio.addEventListener('modechange', () => {
    const label = $('playbackmode');
    label.hidden = !P.queue[P.idx];
    label.textContent = audio.loading ? 'Preparing playback…' : audio.upcoming ? 'Gapless ready' : audio.current ? 'Buffered playback' : 'Streaming playback';
    label.title = audio.current ? 'Decoded tracks are scheduled together when the next track is ready. Silence in the recording is preserved.' : 'Streaming fallback: seamless transitions cannot be guaranteed for this file or connection.';
  });

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

  // Add a whole list (an album, a folder, a search) at the end of the queue. Nothing queued yet: it starts playing.
  function enqueueMany(list) {
    list = (list || []).filter(Boolean);
    if (!list.length) { toast('Nothing to add'); return; }
    if (!P.queue.length) { startQueue(list, 0); return; }
    P.orig.push(...list);
    P.queue.push(...list);
    toast(`Added ${plural(list.length, 'track')} to the queue`);
    renderQueue();
    prefetchNext();
  }
  const queueFrom = getTracks => async e => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (!P.queue.length) unlock();                       // it will start playing: keep the tap's permission
    try { enqueueMany(await getTracks()); } catch (err) { toast(err.message, true); }
  };

  // A tap on a track in an album or a folder: that track, then the rest of the album in order (shuffle goes off,
  // as the Play button does - a shuffle left on from "Shuffle all" would otherwise scatter the album).
  function playFrom(list, i) {
    setShuffle(false);
    startQueue(list, i);
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
    if (audio.src.startsWith('data:') || !audio.src || (!audio.current && linkStale(t, 120))) {
      await load(P.idx, { play: true, at: audio.src.startsWith('data:') ? 0 : audio.currentTime || 0 });
      return;
    }
    audio.play().catch(() => {});
  }

  // ---- Liked: a built-in playlist on the server; the hearts show what is in it (kept here too, for offline)
  const LIKED = { ids: new Set(store.get('liked', [])), id: store.get('likedId', 0) };
  function likedSet(ids, id) {
    LIKED.ids = new Set(ids);
    if (id) LIKED.id = id;
    store.set('liked', [...LIKED.ids]); store.set('likedId', LIKED.id);
    paintLikes();
  }
  async function loadLiked() {
    if (APP && !APP.key) return;                         // not signed in: keep what we had
    try { const j = await api('liked'); likedSet(j.ids, j.id); } catch (e) { /* offline: keep what we had */ }
  }
  async function like(list, on) {
    list = list.filter(Boolean);
    if (!list.length) return;
    const before = new Set(LIKED.ids);
    list.forEach(t => (on ? LIKED.ids.add(t.id) : LIKED.ids.delete(t.id)));
    paintLikes();                                        // show it now; put it back if the server says no
    try {
      const j = await apiPost('like', { track_ids: list.map(t => t.id), on });
      likedSet(j.ids, j.id);
      if (list.length > 1 || !on) toast(on ? `Added ${plural(list.length, 'track')} to Liked` : `Removed ${plural(list.length, 'track')} from Liked`);
      if (onPlaylist(LIKED.id)) refreshPlaylist(LIKED.id);
    } catch (e) { LIKED.ids = before; paintLikes(); toast(e.message, true); }
  }
  /** Heart for one track. */
  function likeBtn(t, cls) {
    const b = h('button', { class: (cls || 'lk'), type: 'button', dataset: { like: t.id },
      onclick: e => { e.preventDefault(); e.stopPropagation(); like([t], !LIKED.ids.has(t.id)); } });
    paintLike(b);
    return b;
  }
  function paintLike(b) {
    const on = LIKED.ids.has(+b.dataset.like);
    b.textContent = on ? '♥' : '♡';
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.title = on ? 'Remove from Liked' : 'Add to Liked';
    b.setAttribute('aria-label', b.title);
  }
  function paintLikes() { document.querySelectorAll('[data-like]').forEach(paintLike); }
  /** Heart for a whole list (an album, a folder): likes what isn't liked yet; all liked already: offers to take them out. */
  const likeAll = getTracks => async e => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    try {
      const list = await getTracks();
      if (!list.length) { toast('Nothing to like'); return; }
      const todo = list.filter(t => !LIKED.ids.has(t.id));
      if (todo.length) { like(todo, true); return; }
      const yes = list.length === 1 || await dialog({ title: `Remove ${plural(list.length, 'track')} from Liked?`, text: 'They are all in Liked already.', ok: 'Remove', danger: true });
      if (yes) like(list, false);
    } catch (err) { toast(err.message, true); }
  };

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
    heardReset(t);
    paintNowInfo(t);
    $('tdur').textContent = fmtMs(t.ms);
    $('tcur').textContent = '0:00';
    $('seek').value = 0; paintRange($('seek'));
    markNow();
    renderQueue();
    setMediaSession(t);
  }

  function paintNowInfo(t) {
    $('nptitle').textContent = t.title;
    const nl = $('nplike');
    nl.dataset.like = t.id; nl.hidden = false; paintLike(nl);
    const sub = $('npsub');
    sub.replaceChildren();
    if (t.artist) sub.append(h('a', { href: `#/artist/${enc(t.albumArtist || t.artist)}`, text: t.artist }));
    if (t.album) sub.append(' · ', h('a', { href: albumHash(t), text: t.album }));
    const cv = $('npcover');
    cv.replaceChildren(h('span', { text: '♪' }));
    if (t.cover) { const img = h('img', { alt: '' }); img.addEventListener('error', () => img.remove()); cv.append(img); setCover(img, t.id); }
    document.title = `${t.title} – ${t.artist || 'Scray audio'}`;
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
    armMediaSession();
    const meta = (src) => { navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: src ? [{ src, sizes: '512x512' }] : [] }); };
    if (!APP) { meta(t.cover ? new URL(`api.php?action=cover&t=${t.id}`, location.href).href : null); return; }
    meta(null);                                                  // the app: the lock screen gets the cover once its signed link is back
    if (t.cover) {
      const local = OFF && OFF.coverUrl(t.id);
      if (local) meta(local);
      else api('cover_url', { t: t.id }).then(j => { if (P.queue[P.idx] === t) meta(j.url); }).catch(() => {});
    }
  }
  // The lock screen's buttons. WebKit drops these when the page becomes "now playing" and again each time playback
  // restarts (first play, a new track), and then iOS shows its own -10s / +10s pair. So they are set again at each of
  // those moments, not just once at load. No seekbackward / seekforward: with those, iOS shows +/-10s instead of
  // previous / next.
  function armMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (e) { /* unsupported action */ } };
    set('play', () => togglePlay());
    set('pause', () => audio.pause());
    set('previoustrack', prev);
    set('nexttrack', () => next(false));
    set('seekbackward', null);
    set('seekforward', null);
    set('seekto', d => { if (d && d.seekTime != null) audio.currentTime = d.seekTime; });
  }
  armMediaSession();
  ['play', 'playing', 'loadedmetadata'].forEach(ev => audio.addEventListener(ev, armMediaSession));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) armMediaSession(); });
  window.addEventListener('pageshow', armMediaSession);

  // ------------------------------------------------------------ history
  // A play counts once it has really been heard: 30 s, or half of a shorter track (seeking doesn't count).
  // Plays go to the server (play_log), so the history is the same everywhere; one that can't be sent yet (offline)
  // waits on this device and goes later, with the time it happened. Each has its own uid, so none is counted twice.
  const H = { t: null, heard: 0, last: null, logged: false, pending: store.get('playsPending', []), sending: false, rows: [], total: 0, open: false };
  const deviceName = () => (APP ? (APP.name || 'iPhone') : /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone browser' : /Android/.test(navigator.userAgent) ? 'Android browser' : 'Computer');
  const uid = () => { const a = new Uint8Array(12); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, '0')).join(''); };
  function heardReset(t) { H.t = t; H.heard = 0; H.last = null; H.logged = false; }
  audio.addEventListener('timeupdate', () => {
    const t = H.t;
    if (!t || H.logged || audio.paused || audio.src.startsWith('data:')) return;
    const cur = audio.currentTime;
    if (H.last != null) { const d = cur - H.last; if (d > 0 && d < 1.5) H.heard += d; }
    H.last = cur;
    const dur = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (t.ms || 0) / 1000;
    if (H.heard >= Math.min(30, dur > 0 ? dur / 2 : 30)) { H.logged = true; logPlay(t); }
  });
  audio.addEventListener('seeking', () => { H.last = null; });
  audio.addEventListener('ended', () => { if (P.repeat === 'one') { H.heard = 0; H.last = null; H.logged = false; } });   // each repeat is a play

  function logPlay(t) {
    H.pending.push({ uid: uid(), track_id: t.id, at: new Date().toISOString(), device: deviceName(), t });
    if (H.pending.length > 5000) H.pending.splice(0, H.pending.length - 5000);
    store.set('playsPending', H.pending);
    sendPlays().then(() => { if (H.open) loadHistory(); });
    if (H.open) paintHistory();
  }
  async function sendPlays() {
    if (H.sending || !H.pending.length || (APP && !APP.key)) return;
    H.sending = true;
    try {
      while (H.pending.length) {
        const batch = H.pending.slice(0, 500);
        await apiPost('play_log', { plays: batch.map(({ t, ...p }) => p) });
        const sent = new Set(batch.map(p => p.uid));
        H.pending = H.pending.filter(p => !sent.has(p.uid));
        store.set('playsPending', H.pending);
      }
    } catch (e) { /* offline or signed out: they wait here and go next time */ }
    H.sending = false;
  }
  window.addEventListener('online', () => sendPlays());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sendPlays(); });
  setInterval(() => { if (H.pending.length) sendPlays(); }, 120000);

  const dayOf = iso => {
    const d = new Date(iso), today = new Date(); today.setHours(0, 0, 0, 0);
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const diff = Math.round((today - day) / 86400000);
    return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: diff < 7 ? 'long' : undefined, day: 'numeric', month: 'long', year: day.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  };
  const clockOf = iso => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  function setHistPanel(open) {
    H.open = open;
    $('histpanel').hidden = !open;
    $('bhist').setAttribute('aria-pressed', String(open));
    if (open) { $('queuepanel').hidden = true; $('bqueue').setAttribute('aria-pressed', 'false'); loadHistory(); }
  }
  async function loadHistory(more) {
    try {
      const j = await api('history', { offset: more ? H.rows.length : 0, limit: 100 });
      H.rows = more ? H.rows.concat(j.plays) : j.plays;
      H.total = j.total;
      H.err = '';
    } catch (e) { H.err = e.message; }
    paintHistory();
  }
  function paintHistory() {
    const list = $('hlist');
    const waiting = H.pending.slice().reverse().map(p => ({ id: 0, at: p.at, device: p.device, track: p.t, was: p.t, waiting: true }));
    const rows = waiting.concat(H.rows);
    $('hcount').textContent = H.total ? plural(H.total, 'play') : '';
    list.replaceChildren();
    if (H.err && !rows.length) { list.append(h('li', { class: 'more', text: `Couldn’t load the history: ${H.err}` })); return; }
    if (!rows.length) { list.append(h('li', { class: 'more', text: 'Nothing played yet. A track shows here once you’ve listened for 30 seconds.' })); return; }
    // what a tap plays: the history from there on, as a queue (only what is still in the library)
    const playable = rows.filter(r => r.track);
    const cur = P.queue[P.idx];
    let day = null;
    for (const r of rows) {
      const d = dayOf(r.at);
      if (d !== day) { day = d; list.append(h('li', { class: 'day', text: d })); }
      const t = r.track, was = r.was || {};
      const li = h('li', { class: 'pl' + (t ? '' : ' gone') + (cur && t && cur.id === t.id ? ' now' : ''), title: t ? null : 'No longer in the library' },
        h('span', { class: 'h-when', text: clockOf(r.at) }),
        h('span', { class: 'h-t' }, h('b', { text: t ? t.title : was.title }),
          h('i', { text: [t ? t.artist : was.artist, t ? t.album : was.album, r.device, r.waiting ? 'not sent yet' : '', t ? '' : 'no longer in the library'].filter(Boolean).join(' · ') })),
        t ? h('button', { class: 'h-m', title: 'More…', 'aria-label': 'More actions', 'aria-haspopup': 'menu', text: '⋯',
          onclick: e => { e.stopPropagation(); openHistMenu(r, { el: e.currentTarget, right: true }, e.currentTarget); } }) : null);
      if (t) {
        li.addEventListener('click', () => startQueue(playable.map(x => x.track), playable.indexOf(r)));
        li.addEventListener('contextmenu', e => { e.preventDefault(); openHistMenu(r, menuAt(e, li), li); });
      }
      list.append(li);
    }
    if (H.rows.length < H.total) list.append(h('li', { class: 'more' }, h('button', { type: 'button', text: 'Show more', onclick: () => loadHistory(true) })));
  }
  function openHistMenu(r, at, from) {
    const items = trackMenuItems(r.track, {});
    if (r.id) items.push({ sep: true }, { label: 'Remove from history', danger: true, onclick: async () => {
      try { await apiPost('history_remove', { ids: [r.id] }); loadHistory(); } catch (e) { toast(e.message, true); }
    } });
    openMenu(items, at, from);
  }
  $('bhist').addEventListener('click', () => setHistPanel(!H.open));
  $('hclose').addEventListener('click', () => setHistPanel(false));
  $('hclear').addEventListener('click', async () => {
    const yes = await dialog({ title: 'Clear the whole history?', text: 'Every play, on every device, is forgotten. Your tracks, playlists and Liked stay.', ok: 'Clear', danger: true });
    if (!yes) return;
    try { await apiPost('history_remove', { all: true }); H.pending = []; store.set('playsPending', []); loadHistory(); toast('History cleared'); } catch (e) { toast(e.message, true); }
  });

  // ------------------------------------------------------------ queue panel
  function renderQueue() {
    prefetchNext();
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
      list.append(h('li', {
        class: i === P.idx ? 'now' : '', onclick: () => load(i),
        oncontextmenu: e => { e.preventDefault(); openTrackMenu(t, {}, menuAt(e, e.currentTarget), e.currentTarget); },
      },
        h('span', { class: 'q-t' }, h('b', { text: t.title }), h('i', { text: [t.artist, t.album].filter(Boolean).join(' · ') })),
        h('button', { class: 'q-m', title: 'More…', 'aria-label': 'More actions', 'aria-haspopup': 'menu', text: '⋯', onclick: e => { e.stopPropagation(); openTrackMenu(t, {}, { el: e.currentTarget, right: true }, e.currentTarget); } }),
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
    if (!p.hidden) setHistPanel(false);
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
    prefetchNext();
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
    box.append(h('div', { class: 'thead' }, h('span', { text: '#' }), h('span', { text: 'Title' }),
      showArtist ? h('span', { text: 'Artist' }) : null, o.noAlbum ? null : h('span', { text: 'Album' }), h('span', { text: 'Time' }), h('span')));
    let disc = null;
    const multiDisc = o.discs && new Set(tracks.map(t => t.disc || 1)).size > 1;
    tracks.forEach((t, i) => {
      if (multiDisc && (t.disc || 1) !== disc) { disc = t.disc || 1; box.append(h('div', { class: 'disc', text: `Disc ${disc}` })); }
      const row = h('div', { class: 'trk' + (OFF && OFF.has(t.id) ? ' off' : ''), role: 'button', tabindex: '0', dataset: { id: t.id } },
        h('span', { class: 'num' }, h('span', { text: String(o.trackNumbers ? (t.no ?? i + 1) : i + 1) })),
        h('span', { class: 'ttl' }, h('span', { class: 't' }, OFF ? h('i', { class: 'offmark', title: 'Saved on this phone', text: '⤓' }) : null, t.title), h('span', { class: 'sub', text: (o.noAlbum ? [showArtist ? t.artist : ''] : [t.artist, t.album]).filter(Boolean).join(' · ') })),
        h('span', { class: 'art', text: t.artist }),
        h('span', { class: 'alb', text: t.album }),
        h('span', { class: 'dur', text: fmtMs(t.ms) }),
        h('span', { class: 'acts' },
          likeBtn(t),
          h('button', {
            class: 'add', title: 'Add to queue (Shift: play next)', 'aria-label': 'Add to queue', text: '+',
            onclick: e => { e.stopPropagation(); enqueue(t, e.shiftKey); },
          }),
          h('button', {
            class: 'dots', title: 'More: go to album or artist, add to a playlist… (or right-click)', 'aria-label': 'More actions', 'aria-haspopup': 'menu', text: '⋯',
            onclick: e => { e.stopPropagation(); openTrackMenu(t, { list: tracks, index: i, playlist: o.playlist, inOrder: o.inOrder }, { el: e.currentTarget, right: true }, e.currentTarget); },
          })));
      row.addEventListener('contextmenu', e => {
        e.preventDefault();
        const at = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { el: row };   // the keyboard's menu key has no pointer
        openTrackMenu(t, { list: tracks, index: i, playlist: o.playlist, inOrder: o.inOrder }, at, row);
      });
      const play = () => (o.inOrder ? playFrom(tracks, i) : startQueue(tracks, i));
      row.addEventListener('click', play);
      row.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); play(); } });
      box.append(row);
    });
    return box;
  }

  function albumCard(a) {
    const tracksOf = async () => (await api('tracks', { artist: a.artist, album: a.album })).tracks;
    return h('a', { class: 'card', href: `#/album/${enc(a.artist)}/${enc(a.album)}` },
      h('div', { class: 'cv' }, coverEl(a.art),
        h('span', { class: 'cbtns' },
          h('button', { class: 'cb', type: 'button', title: 'Add to queue', 'aria-label': `Add ${a.album} to the queue`, text: '+', onclick: queueFrom(tracksOf) }),
          h('button', { class: 'cb', type: 'button', title: 'Add to Liked', 'aria-label': `Like ${a.album}`, text: '♡', onclick: likeAll(tracksOf) })),
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

  function actions(getTracks, extra, o) {
    const run = async shuffle => {
      unlock();
      try { playList(await getTracks(), shuffle); } catch (e) { toast(e.message, true); }
    };
    return h('div', { class: 'bar' },
      h('button', { class: 'btn go', text: '▶ Play', onclick: () => run(false) }),
      h('button', { class: 'btn', text: '🔀 Shuffle', onclick: () => run(true) }),
      h('button', { class: 'btn', text: '＋ Queue', title: 'Add these to the end of the queue', onclick: queueFrom(getTracks) }),
      o && o.noLike ? null : h('button', { class: 'btn', text: '♡ Like', title: 'Add these to Liked (all liked already: take them out)', onclick: likeAll(getTracks) }),
      o && o.noPlaylist ? null : h('button', {
        class: 'btn', text: '＋ Playlist', title: 'Add these tracks to a playlist', 'aria-haspopup': 'menu',
        onclick: e => { const b = e.currentTarget; openPicker({ el: b }, b, async () => (await getTracks()).map(t => t.id)); },
      }),
      OFF && !(o && o.noOffline) ? h('button', {
        class: 'btn', text: '⤓ Offline', title: 'Save these tracks on this phone (or remove them)', 'aria-haspopup': 'menu',
        onclick: e => offlineMenu(getTracks, e.currentTarget),
      }) : null,
      extra);
  }

  // ----------------------------------------------- menus, dialogs, playlists
  // One floating menu (right-click on a track, the ⋯ button, the "＋ Playlist"
  // button). On a phone it is a sheet at the bottom. A click anywhere else, Escape
  // or a scroll closes it; arrow keys move, Enter picks.
  const menu = { el: null, back: null, at: null, from: null };

  function closeMenu() {
    if (!menu.el) return;
    menu.el.remove(); menu.back.remove();
    menu.el = menu.back = null;
    document.removeEventListener('keydown', menuKeys, true);
    window.removeEventListener('resize', closeMenu);
    if (menu.from && document.contains(menu.from)) { try { menu.from.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
    menu.from = null;
  }

  function menuKeys(e) {
    if (e.key === 'Tab') { closeMenu(); return; }
    e.stopPropagation();                       // the player's shortcuts must not fire behind the menu
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
    const btns = [...menu.el.querySelectorAll('.mi:not(:disabled)')];
    if (!btns.length) return;
    const i = btns.indexOf(document.activeElement);
    const go = k => { e.preventDefault(); btns[(k + btns.length) % btns.length].focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? -1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(-1);
  }

  function placeMenu() {
    const el = menu.el, a = menu.at || { x: 0, y: 0 };
    el.style.maxHeight = (innerHeight - 16) + 'px';
    const w = el.offsetWidth, hh = el.offsetHeight;
    let x, y;
    if (a.el) {
      const r = a.el.getBoundingClientRect();
      x = a.right ? r.right - w : r.left;
      y = r.bottom + 4;
      if (y + hh > innerHeight - 8) y = r.top - hh - 4;
    } else { x = a.x; y = a.y; }
    x = Math.max(8, Math.min(x, innerWidth - w - 8));
    y = Math.max(8, Math.min(y, innerHeight - hh - 8));
    el.style.left = x + 'px'; el.style.top = y + 'px';
  }

  /** items: {label, hint?, arrow?, danger?, disabled?, keep?, onclick} | {sep:true} | {head:'text'} */
  function paintMenu(items) {
    const el = menu.el;
    if (!el) return;
    el.replaceChildren(...items.map(it => {
      if (it.sep) return h('div', { class: 'msep', role: 'separator' });
      if (it.head) return h('div', { class: 'mhead', text: it.head });
      return h('button', {
        class: 'mi' + (it.danger ? ' danger' : ''), type: 'button', role: 'menuitem', disabled: it.disabled,
        onclick: e => { e.stopPropagation(); if (!it.keep) closeMenu(); if (it.onclick) it.onclick(); },
      }, h('span', { class: 'ml', text: it.label }), it.hint ? h('span', { class: 'mh', text: it.hint }) : null, it.arrow ? h('span', { class: 'ma', text: '›' }) : null);
    }));
    placeMenu();
    const first = el.querySelector('.mi:not(:disabled)');
    if (first) first.focus({ preventScroll: true });
  }

  function openMenu(items, at, from) {
    closeMenu();
    menu.back = h('div', { class: 'mback', onclick: closeMenu, oncontextmenu: e => { e.preventDefault(); closeMenu(); }, onwheel: closeMenu, ontouchmove: closeMenu });
    menu.el = h('div', { class: 'cmenu', role: 'menu' });
    menu.at = at; menu.from = from || null;
    document.body.append(menu.back, menu.el);
    document.addEventListener('keydown', menuKeys, true);
    window.addEventListener('resize', closeMenu);
    paintMenu(items);
  }

  /** A small modal: a title, optional text, optional text box. Resolves to the typed text (or true), or null if cancelled. */
  function dialog(o) {
    return new Promise(resolve => {
      const prev = document.activeElement;
      const input = o.value !== undefined ? h('input', { class: 'dinput', type: 'text', value: o.value, maxlength: '100', autocomplete: 'off', 'aria-label': o.title }) : null;
      const ok = h('button', { class: 'btn go' + (o.danger ? ' danger' : ''), type: 'submit', text: o.ok || 'OK' });
      const cancel = h('button', { class: 'btn', type: 'button', text: 'Cancel' });
      const box = h('form', { class: 'dbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title },
        h('h3', { text: o.title }), o.text ? h('p', { text: o.text }) : null, input, h('div', { class: 'dbtns' }, cancel, ok));
      const back = h('div', { class: 'dback' }, box);
      const done = v => {
        document.removeEventListener('keydown', keys, true);
        back.remove();
        if (prev && document.contains(prev)) { try { prev.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
        resolve(v);
      };
      const keys = e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); return; }
        if (e.key === 'Tab') {                     // keep the focus inside the box
          const f = [...box.querySelectorAll('input, button')];
          const i = f.indexOf(document.activeElement);
          e.preventDefault();
          f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
        }
        e.stopPropagation();
      };
      box.addEventListener('submit', e => { e.preventDefault(); done(input ? input.value : true); });
      cancel.addEventListener('click', () => done(null));
      back.addEventListener('mousedown', e => { if (e.target === back) done(null); });
      document.body.append(back);
      document.addEventListener('keydown', keys, true);
      (input || ok).focus();
      if (input) input.select();
    });
  }

  // ---- playlist actions (each toasts its own errors)
  const onPlaylist = id => location.hash === `#/playlist/${id}`;

  async function newPlaylist(getIds) {
    const name = await dialog({ title: 'New playlist', value: '', ok: 'Create' });
    if (name == null) return;
    try {
      const ids = getIds ? await getIds() : [];
      const j = await apiPost('playlist_create', { name, track_ids: ids });
      toast(j.added ? `Created “${j.name}” with ${plural(j.added, 'track')}` : `Created “${j.name}”`);
      if (location.hash === '#/playlists') route();
    } catch (e) { toast(e.message, true); }
  }

  async function addToPlaylist(pl, getIds) {
    try {
      const ids = await getIds();
      if (!ids.length) { toast('Nothing to add'); return; }
      const j = await apiPost('playlist_add', { id: pl.id, track_ids: ids });
      toast(`Added ${plural(j.added, 'track')} to “${pl.name}”`);
      if (pl.liked) loadLiked();
      if (onPlaylist(pl.id)) refreshPlaylist(pl.id);
    } catch (e) { toast(e.message, true); }
  }

  /** Fill the open menu with the playlists to choose from (and "New playlist…"). back = items to return to. */
  async function showPicker(getIds, back) {
    const head = [...(back ? [{ label: '‹ Back', keep: true, onclick: () => paintMenu(back) }] : []), { head: 'Add to playlist' }];
    paintMenu([...head, { label: 'Loading…', disabled: true }]);
    let pls;
    try { pls = (await api('playlists')).playlists; } catch (e) { closeMenu(); toast(e.message, true); return; }
    if (!menu.el) return;                                  // closed while we waited
    paintMenu([...head, { label: '＋ New playlist…', onclick: () => newPlaylist(getIds) }, ...(pls.length ? [{ sep: true }] : []),
      ...pls.map(p => ({ label: p.name, hint: String(p.tracks), onclick: () => addToPlaylist(p, getIds) }))]);
  }

  function openPicker(at, from, getIds) { openMenu([], at, from); showPicker(getIds, null); }

  async function renamePlaylist(p, after) {
    const name = await dialog({ title: 'Rename playlist', value: p.name, ok: 'Rename' });
    if (name == null || name === p.name) return;
    try { await apiPost('playlist_rename', { id: p.id, name }); toast('Renamed'); after(); } catch (e) { toast(e.message, true); }
  }

  async function deletePlaylist(p, after) {
    const yes = await dialog({ title: `Delete “${p.name}”?`, text: 'The tracks stay in your library; only the playlist goes.', ok: 'Delete', danger: true });
    if (!yes) return;
    try { await apiPost('playlist_delete', { id: p.id }); toast(`Deleted “${p.name}”`); after(); } catch (e) { toast(e.message, true); }
  }

  async function playlistOp(id, action, body, msg) {
    try { await apiPost(action, { id, ...body }); if (msg) toast(msg); } catch (e) { toast(e.message, true); }
    if (id === LIKED.id) loadLiked();
    if (onPlaylist(id)) refreshPlaylist(id);
  }

  // Same-genre radio uses the same library API online and the saved index offline.
  // Split explicit multi-value separators, but preserve names such as R&B and Pop/Rock.
  function genreKeys(value) {
    return [...new Set(String(value || '').split(/[;,|]+/).map(v => fold(v).trim().replace(/\s+/g, ' '))
      .filter(v => v && !['unknown', 'unknown genre', 'other', 'none', 'n/a', '(0)'].includes(v)))];
  }

  let similarRequest = 0;
  async function moreLikeThis(t) {
    const request = ++similarRequest, seq = P.seq;
    const keys = new Set(genreKeys(t.genre));
    if (!keys.size) { toast('This track has no genre. Add one in Edit details, then try again.', true); return; }
    unlock(); // Preserve the phone tap's playback permission before awaiting the library.
    toast('Finding music with the same genre…');
    try {
      const { genres } = await api('genres');
      const names = genres.filter(g => genreKeys(g.name).some(k => keys.has(k))).map(g => g.name);
      const found = new Map();
      let capped = false;
      for (const genre of names) {
        if (request !== similarRequest || seq !== P.seq) return;
        const result = await api('tracks', { genre, limit: 100000 });
        capped ||= !!result.capped;
        for (const track of result.tracks) {
          if (track.id !== t.id && genreKeys(track.genre).some(k => keys.has(k))) found.set(track.id, track);
        }
      }
      if (request !== similarRequest || seq !== P.seq) return;
      // A failed server request can switch the app to Offline during this search.
      if (offlineOn()) for (const id of found.keys()) { if (!OFF.has(id)) found.delete(id); }
      if (!found.size) { toast(offlineOn() ? 'No other saved tracks share this genre.' : 'No other tracks share this genre.', true); return; }
      playList([...found.values()], true);
      toast(`${plural(found.size, 'track')} matching ${t.genre}${capped ? ' (library result limit reached)' : ''}`);
    } catch (e) {
      if (request === similarRequest && seq === P.seq) toast(e.message, true);
    }
  }

  function trackMenuItems(t, ctx) {
    // Going to the page you are already on does nothing by itself: run the route again so it still answers.
    // Going somewhere closes the queue and Offline panels first, or on a phone they cover the page you went to.
    const go = hash => () => {
      $('queuepanel').hidden = true; $('bqueue').setAttribute('aria-pressed', 'false');
      setHistPanel(false);
      if (OFF && mode.panel) setDlPanel(false);
      if (location.hash === hash) route(); else location.hash = hash;
    };
    const known = v => v && v !== 'Unknown artist';
    const items = [];
    if (ctx.list) items.push({ label: 'Play', onclick: () => (ctx.inOrder ? playFrom(ctx.list, ctx.index) : startQueue(ctx.list, ctx.index)) });
    items.push({ label: 'Play next', onclick: () => enqueue(t, true) }, { label: 'Add to queue', onclick: () => enqueue(t, false) },
      { label: 'More like this', hint: t.genre || 'Same genre', onclick: () => moreLikeThis(t) }, { sep: true });
    if (t.album) items.push({ label: 'Go to album', hint: t.album, onclick: go(albumHash(t)) });
    if (known(t.albumArtist)) items.push({ label: 'Go to artist', hint: t.albumArtist, onclick: go(`#/artist/${enc(t.albumArtist)}`) });
    if (t.artist && t.artist !== t.albumArtist) items.push({ label: 'More by', hint: t.artist, onclick: go(`#/search/${enc(t.artist)}`) });
    items.push({ label: 'Edit details…', onclick: () => editTrack(t) });
    if (t.folder) items.push({ label: 'Show in folder', hint: t.folder.split('/').pop(), onclick: go(`#/f/${enc(t.folder)}`) });
    if (OFF && t.path) items.push({ sep: true }, OFF.has(t.id)
      ? { label: 'Remove from offline', onclick: () => removeOffline(async () => [t]) }
      : { label: 'Save offline', onclick: () => saveOffline(async () => [t]) });
    items.push({ sep: true });
    items.push(LIKED.ids.has(t.id) ? { label: 'Remove from Liked', onclick: () => like([t], false) } : { label: 'Add to Liked', onclick: () => like([t], true) });
    items.push({ label: 'Add to playlist', arrow: true, keep: true, onclick: () => showPicker(async () => [t.id], items) });
    if (ctx.playlist && t.entry) {
      const id = ctx.playlist.id, i = ctx.index, l = ctx.list;
      items.push({ sep: true });
      if (i > 0) items.push({ label: 'Move up', onclick: () => playlistOp(id, 'playlist_move', { entry: t.entry, before: l[i - 1].entry }) });
      if (i < l.length - 1) items.push({ label: 'Move down', onclick: () => playlistOp(id, 'playlist_move', { entry: t.entry, before: l[i + 2] ? l[i + 2].entry : 0 }) });
      items.push({ label: 'Remove from this playlist', danger: true, onclick: () => playlistOp(id, 'playlist_remove', { entries: [t.entry] }, `Removed “${t.title}”`) });
    }
    return items;
  }

  function openTrackMenu(t, ctx, at, from) { openMenu(trackMenuItems(t, ctx || {}), at, from); }

  // queue rows and the now-playing strip get the same menu
  function menuAt(e, el) { return e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { el }; }

  // ----------------------------------------------------- editing what tracks say
  // Edits live in the library's database on top of the files' own tags (api.php: edit, edit_reset, cover_*).
  // The files themselves are not touched.
  const needServer = () => { if (offlineOn()) { toast('Editing needs the library - turn Offline off first', true); return true; } return false; };

  /** Fresh details for tracks you just edited: the queue, the now-playing strip, saved copies and covers catch up. */
  function tracksChanged(list) {
    const byId = new Map(list.map(t => [t.id, t]));
    for (const arr of [P.queue, P.orig]) arr.forEach((t, i) => { const n = byId.get(t.id); if (n) arr[i] = { ...t, ...n }; });
    list.forEach(t => { artVer.set(t.id, t.coverv || ''); coverLinks.delete(t.id); });
    const cur = P.queue[P.idx];
    if (cur && byId.has(cur.id)) { paintNowInfo(cur); setMediaSession(cur); renderQueue(); }
    if (OFF && OFF.refresh) OFF.refresh(list, dlCtx).catch(() => {});
  }
  /** After an edit: stay on the page, or follow the album to its new name. */
  function afterEdit(list, wasHash) {
    tracksChanged(list);
    const t = list[0];
    const here = location.hash;
    if (t && here.startsWith('#/album/')) {
      const to = albumHash(t);
      if (to !== here && here === wasHash) { location.hash = to; return; }
    }
    const y = window.scrollY;
    route().then(() => window.scrollTo(0, y));
  }

  /** A larger dialog for forms. Returns { box, body, foot, close }. */
  function openSheet(title, cls) {
    const prev = document.activeElement;
    const body = h('div', { class: 'sbody' }), foot = h('div', { class: 'dbtns' });
    const box = h('div', { class: 'dbox sheet ' + (cls || ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'shead2' }, h('h3', { text: title }), h('button', { class: 'x', type: 'button', 'aria-label': 'Close', text: '×', onclick: () => close() })), body, foot);
    const back = h('div', { class: 'dback' }, box);
    const keys = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    function close() {
      document.removeEventListener('keydown', keys, true);
      back.remove();
      if (prev && document.contains(prev)) { try { prev.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
    }
    back.addEventListener('mousedown', e => { if (e.target === back) close(); });
    document.addEventListener('keydown', keys, true);
    document.body.append(back);
    return { box, body, foot, close };
  }
  const busy = (btn, on, label) => { btn.disabled = on; if (label) btn.textContent = label; };

  /** A picture from the phone or computer, made no bigger than 1400 px, as a JPEG data URL. */
  function pickPicture() {
    return new Promise((resolve, reject) => {
      const inp = h('input', { type: 'file', accept: 'image/*', style: 'display:none' });
      inp.addEventListener('change', () => {
        const f = inp.files && inp.files[0];
        inp.remove();
        if (!f) { resolve(null); return; }
        const url = URL.createObjectURL(f);
        const img = new Image();
        img.onload = () => {
          const k = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
          const c = document.createElement('canvas');
          c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          resolve(c.toDataURL('image/jpeg', 0.9));
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That picture couldn’t be read')); };
        img.src = url;
      });
      document.body.append(inp);
      inp.click();
    });
  }

  /** The cover row of a form: the picture, Upload…, and Back to the folder's when one was chosen. */
  function coverRow(ids, artId, custom, after) {
    const pic = h('div', { class: 'ecover' }, coverEl(artId));
    const up = h('button', { class: 'btn', type: 'button', text: 'Upload picture…' });
    const reset = custom ? h('button', { class: 'btn', type: 'button', text: 'Use the folder’s', title: 'Forget the chosen cover' }) : null;
    up.addEventListener('click', async () => {
      try {
        const data = await pickPicture();
        if (!data) return;
        busy(up, true, 'Uploading…');
        const j = await apiPost('cover_upload', { track_ids: ids, data });
        after(j.tracks); toast('Cover changed');
      } catch (e) { toast(e.message, true); busy(up, false, 'Upload picture…'); }
    });
    if (reset) reset.addEventListener('click', async () => {
      try { busy(reset, true); const j = await apiPost('edit_reset', { track_ids: ids, fields: ['cover'] }); after(j.tracks); toast('Back to the folder’s cover'); }
      catch (e) { toast(e.message, true); busy(reset, false); }
    });
    return h('div', { class: 'erow ecov' }, pic, h('div', { class: 'ecbtns' }, h('b', { text: 'Cover' }), up, reset));
  }

  const TRACK_FIELDS = [['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['album_artist', 'Album artist'],
    ['track_no', 'Track', 1], ['disc_no', 'Disc', 1], ['year', 'Year', 1], ['genre', 'Genre']];
  const VIEW_KEY = { title: 'title', artist: 'artist', album: 'album', album_artist: 'albumArtist', track_no: 'no', disc_no: 'disc', year: 'year', genre: 'genre' };

  async function editTrack(t) {
    if (needServer()) return;
    let info;
    try { info = await api('track_info', { id: t.id }); } catch (e) { toast(e.message, true); return; }
    const file = info.file || {}, edits = info.edits || {};
    const wasHash = location.hash;
    const sh = openSheet('Edit details');
    const fv = k => (file[k] == null ? '' : String(file[k]));
    const cur = k => (edits[k] ? String(edits[k].value ?? '') : fv(k));
    const inputs = {};
    const rows = TRACK_FIELDS.map(([k, label, num]) => {
      const inp = h('input', { class: 'dinput', type: num ? 'number' : 'text', inputmode: num ? 'numeric' : null, min: num ? '1' : null, value: cur(k),
        placeholder: k === 'album_artist' ? '(same as the artist)' : '', 'aria-label': label });
      inputs[k] = inp;
      const hint = h('span', { class: 'ehint' });
      const back = h('button', { class: 'eback', type: 'button', title: 'Back to what the file says', text: '↺' });
      const paint = () => { const diff = inp.value.trim() !== fv(k); hint.textContent = diff ? `File: ${fv(k) || '(empty)'}` : ''; back.hidden = !diff; };
      inp.addEventListener('input', paint);
      back.addEventListener('click', () => { inp.value = fv(k); paint(); inp.focus(); });
      paint();
      return h('label', { class: 'erow' + (num ? ' num' : '') }, h('span', { class: 'elab', text: label }), h('span', { class: 'ein' }, inp, back), hint);
    });
    const done = list => { info.track = list[0]; afterEdit(list, wasHash); sh.close(); };
    sh.body.append(h('p', { class: 'enote', text: t.path || '' }), h('div', { class: 'egrid' }, rows),
      coverRow([t.id], info.track.cover ? t.id : null, !!edits.cover, list => { afterEdit(list, wasHash); sh.close(); }),
      info.mb && info.mb.release ? h('p', { class: 'enote' }, 'Matched on MusicBrainz: ', h('a', { href: `https://musicbrainz.org/release/${info.mb.release}`, target: '_blank', rel: 'noopener', text: 'release' })) : null);
    const resetAll = h('button', { class: 'btn', type: 'button', text: 'Back to the file’s tags' });
    resetAll.hidden = !Object.keys(edits).some(k => k !== 'mb_release' && k !== 'mb_recording');
    const cancel = h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => sh.close() });
    const save = h('button', { class: 'btn go', type: 'button', text: 'Save' });
    sh.foot.append(resetAll, cancel, save);
    resetAll.addEventListener('click', async () => {
      try { busy(resetAll, true); done((await apiPost('edit_reset', { track_ids: [t.id] })).tracks); toast('Back to the file’s tags'); }
      catch (e) { toast(e.message, true); busy(resetAll, false); }
    });
    save.addEventListener('click', async () => {
      const set = {};
      for (const [k] of TRACK_FIELDS) {
        const v = inputs[k].value.trim();
        if (v === cur(k)) continue;                          // unchanged
        set[k] = v === fv(k) ? null : v;
      }
      if (!Object.keys(set).length) { sh.close(); return; }
      try { busy(save, true, 'Saving…'); done((await apiPost('edit', { items: [{ id: t.id, set }] })).tracks); toast('Saved'); }
      catch (e) { toast(e.message, true); busy(save, false, 'Save'); }
    });
    setTimeout(() => inputs.title.focus(), 30);
  }

  /** The value every track agrees on, or null when they differ. */
  const common = (tracks, k) => { const vs = new Set(tracks.map(t => String(t[VIEW_KEY[k]] ?? ''))); return vs.size === 1 ? [...vs][0] : null; };

  function editAlbum(tracks) {
    if (needServer()) return;
    const wasHash = location.hash;
    const sh = openSheet('Edit album', 'wide');
    const ALBUM = [['album', 'Album'], ['album_artist', 'Album artist'], ['year', 'Year', 1], ['genre', 'Genre']];
    const top = {};
    const head = ALBUM.map(([k, label, num]) => {
      const c = common(tracks, k);
      const inp = h('input', { class: 'dinput', type: num ? 'number' : 'text', min: num ? '1' : null, value: c ?? '', placeholder: c === null ? 'Mixed - leave empty to keep' : '', 'aria-label': label });
      top[k] = { inp, was: c ?? '' };
      return h('label', { class: 'erow' + (num ? ' num' : '') }, h('span', { class: 'elab', text: label }), h('span', { class: 'ein' }, inp));
    });
    const rowsIn = tracks.map(t => {
      const r = { t, no: h('input', { class: 'dinput n', type: 'number', min: '1', value: t.no ?? '', 'aria-label': 'Track number' }),
        disc: h('input', { class: 'dinput n', type: 'number', min: '1', value: t.disc ?? '', 'aria-label': 'Disc' }),
        title: h('input', { class: 'dinput', type: 'text', value: t.title, 'aria-label': 'Title' }),
        artist: h('input', { class: 'dinput', type: 'text', value: t.artist, 'aria-label': 'Artist' }) };
      return r;
    });
    const multi = tracks.some(t => (t.disc || 1) !== 1);
    const art = (tracks.find(t => t.cover) || {}).id;
    sh.body.append(h('div', { class: 'egrid' }, head),
      coverRow(tracks.map(t => t.id), art ?? null, tracks.some(t => t.coverv && t.coverv !== 'f'), list => { afterEdit(list, wasHash); sh.close(); }),
      h('div', { class: 'etracks' + (multi ? ' discs' : '') },
        h('div', { class: 'eth' }, h('span', { text: '#' }), multi ? h('span', { text: 'Disc' }) : null, h('span', { text: 'Title' }), h('span', { text: 'Artist' })),
        rowsIn.map(r => h('div', { class: 'etr' }, r.no, multi ? r.disc : null, r.title, r.artist))),
      h('p', { class: 'enote', text: 'Saved in the library, not in the files. “Back to the files’ tags” undoes it.' }));
    const reset = h('button', { class: 'btn', type: 'button', text: 'Back to the files’ tags' });
    reset.hidden = !tracks.some(t => t.edited);
    const cancel = h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => sh.close() });
    const save = h('button', { class: 'btn go', type: 'button', text: 'Save' });
    sh.foot.append(reset, cancel, save);
    reset.addEventListener('click', async () => {
      const yes = await dialog({ title: 'Undo every edit to this album?', text: 'Titles, numbers, names and the cover go back to what the files say.', ok: 'Undo edits', danger: true });
      if (!yes) return;
      try { busy(reset, true); const j = await apiPost('edit_reset', { track_ids: tracks.map(t => t.id) }); afterEdit(j.tracks, wasHash); sh.close(); toast('Back to the files’ tags'); }
      catch (e) { toast(e.message, true); busy(reset, false); }
    });
    save.addEventListener('click', async () => {
      const shared = {};
      for (const [k] of ALBUM) { const v = top[k].inp.value.trim(); if (v !== top[k].was && !(v === '' && common(tracks, k) === null)) shared[k] = v; }
      const items = [];
      for (const r of rowsIn) {
        const set = { ...shared };
        const t = r.t;
        if (r.no.value.trim() !== String(t.no ?? '')) set.track_no = r.no.value.trim();
        if (multi && r.disc.value.trim() !== String(t.disc ?? '')) set.disc_no = r.disc.value.trim();
        if (r.title.value.trim() !== t.title) set.title = r.title.value.trim();
        if (r.artist.value.trim() !== t.artist) set.artist = r.artist.value.trim();
        if (Object.keys(set).length) items.push({ id: t.id, set });
      }
      if (!items.length) { sh.close(); return; }
      try { busy(save, true, 'Saving…'); const j = await apiPost('edit', { items }); afterEdit(j.tracks, wasHash); sh.close(); toast(`Saved ${plural(items.length, 'track')}`); }
      catch (e) { toast(e.message, true); busy(save, false, 'Save'); }
    });
  }

  // ---- MusicBrainz: search, pick a release, see what would change, apply
  const titleCase = s => s.replace(/(^|[\s\-/])\p{Ll}/gu, m => m.toUpperCase());
  function mbPairs(ours, rel) {
    const theirs = rel.media.flatMap(m => m.tracks.map(t => ({ ...t, disc: m.disc })));
    if (ours.length === theirs.length) return ours.map((t, i) => [t, theirs[i]]);
    if (ours.every(t => t.no)) return ours.map(t => [t, theirs.find(x => x.no === t.no && x.disc === (t.disc || 1)) || null]);
    return ours.map((t, i) => [t, theirs[i] || null]);
  }

  function findOnMB(tracks) {
    if (needServer()) return;
    const wasHash = location.hash;
    const sh = openSheet('Find on MusicBrainz', 'wide');
    const a0 = common(tracks, 'album_artist'), al0 = common(tracks, 'album');
    const artist = h('input', { class: 'dinput', type: 'text', value: a0 && a0 !== 'Unknown artist' ? a0 : (common(tracks, 'artist') || ''), placeholder: 'Artist', 'aria-label': 'Artist' });
    const album = h('input', { class: 'dinput', type: 'text', value: al0 || '', placeholder: 'Album', 'aria-label': 'Album' });
    const go = h('button', { class: 'btn go', type: 'submit', text: 'Search' });
    const out = h('div', { class: 'mbres' });
    const form = h('form', { class: 'mbq' }, artist, album, go);
    sh.body.append(form, out);
    const cancel = h('button', { class: 'btn', type: 'button', text: 'Close', onclick: () => sh.close() });
    sh.foot.append(cancel);

    async function search() {
      if (!album.value.trim()) { album.focus(); return; }
      out.replaceChildren(h('div', { class: 'loading', text: 'Asking MusicBrainz…' }));
      try {
        const j = await api('mb_search', { artist: artist.value.trim(), album: album.value.trim() });
        if (!j.releases.length) { out.replaceChildren(h('div', { class: 'empty', text: 'Nothing found. Try fewer words, or check the spelling.' })); return; }
        out.replaceChildren(h('p', { class: 'enote', text: `Pick the release that matches yours (you have ${plural(tracks.length, 'track')}):` }),
          ...j.releases.map(r => h('button', { class: 'mbrel' + (r.tracks === tracks.length ? ' fit' : ''), type: 'button', onclick: () => pick(r) },
            h('b', { text: r.title }), h('span', { text: r.artist }),
            h('i', { text: [r.date, r.country, r.format, plural(r.tracks, 'track'), r.type, r.note].filter(Boolean).join(' · ') }))));
      } catch (e) { out.replaceChildren(h('div', { class: 'empty', text: e.message })); }
    }
    form.addEventListener('submit', e => { e.preventDefault(); search(); });

    async function pick(r) {
      out.replaceChildren(h('div', { class: 'loading', text: 'Reading the release…' }));
      let rel;
      try { rel = (await api('mb_release', { id: r.id })).release; } catch (e) { out.replaceChildren(h('div', { class: 'empty', text: e.message })); return; }
      form.hidden = true;
      const pairs = mbPairs(tracks, rel);
      const matched = pairs.filter(p => p[1]).length;
      const opt = (key, label, on, extra) => { const c = h('input', { type: 'checkbox', checked: on }); c.dataset.k = key; return h('label', { class: 'mbopt' }, c, ' ', label, extra || null); };
      const yearSel = h('select', { class: 'mbyear' },
        rel.firstYear && rel.firstYear !== rel.year ? h('option', { value: rel.firstYear, text: `${rel.firstYear} (first released)` }) : null,
        rel.year ? h('option', { value: rel.year, text: `${rel.year} (this release)` }) : null);
      const genre = rel.genres[0] ? titleCase(rel.genres[0]) : '';
      const opts = h('div', { class: 'mbopts' },
        opt('title', 'Track titles', true), opt('artist', 'Track artists', true), opt('no', 'Track and disc numbers', true),
        opt('album', `Album: “${rel.title}”`, true), opt('aa', `Album artist: ${rel.artist}`, true),
        rel.year ? opt('year', 'Year: ', true, yearSel) : null,
        genre ? opt('genre', `Genre: ${genre}`, true) : null,
        rel.cover ? opt('cover', 'Cover', true, h('img', { class: 'mbthumb', src: rel.coverThumb, alt: '' })) : h('span', { class: 'enote', text: 'No cover on the Cover Art Archive for this one.' }));
      const diff = (a, b) => (a === b ? h('span', { text: a || '—' }) : h('span', {}, h('s', { text: a || '—' }), ' → ', h('ins', { text: b })));
      const table = h('div', { class: 'mbtable' }, pairs.map(([t, m]) => h('div', { class: 'mbtr' + (m ? '' : ' none') },
        h('span', { class: 'n', text: m ? `${m.disc > 1 || rel.media.length > 1 ? m.disc + '.' : ''}${m.no}` : '–' }),
        h('span', { class: 'tt' }, m ? diff(t.title, m.title) : h('span', { text: `${t.title} - no match` }),
          m && m.artist && m.artist !== t.artist ? h('i', {}, diff(t.artist, m.artist)) : null),
        h('span', { class: 'len' + (m && m.ms && t.ms && Math.abs(m.ms - t.ms) > 10000 ? ' warn' : ''), title: 'Length: yours / MusicBrainz',
          text: m && m.ms ? `${fmtMs(t.ms)} / ${fmtMs(m.ms)}` : fmtMs(t.ms) }))));
      const warn = matched < tracks.length || rel.media.reduce((n, m) => n + m.tracks.length, 0) !== tracks.length
        ? h('p', { class: 'mbwarn', text: `The release has ${plural(rel.media.reduce((n, m) => n + m.tracks.length, 0), 'track')}, you have ${tracks.length}. Check the pairs below before applying.` }) : null;
      out.replaceChildren(...[h('p', { class: 'enote' }, h('b', { text: rel.title }), ` · ${rel.artist} · `, h('a', { href: `https://musicbrainz.org/release/${rel.id}`, target: '_blank', rel: 'noopener', text: 'open on MusicBrainz' })),
        warn, opts, table].filter(Boolean));
      const back = h('button', { class: 'btn', type: 'button', text: '‹ Other releases', onclick: () => { form.hidden = false; search(); sh.foot.replaceChildren(cancel); } });
      const apply = h('button', { class: 'btn go', type: 'button', text: 'Apply' });
      sh.foot.replaceChildren(back, cancel, apply);
      apply.addEventListener('click', async () => {
        const on = k => { const c = opts.querySelector(`input[data-k="${k}"]`); return !!(c && c.checked); };
        const items = pairs.filter(p => p[1]).map(([t, m]) => {
          const set = { mb_release: rel.id, mb_recording: m.recording || null };
          if (on('title')) set.title = m.title;
          if (on('artist') && m.artist) set.artist = m.artist;
          if (on('no')) { set.track_no = String(m.no); set.disc_no = rel.media.length > 1 ? String(m.disc) : ''; }
          if (on('album')) set.album = rel.title;
          if (on('aa')) set.album_artist = rel.artist;
          if (on('year')) set.year = String(yearSel.value);
          if (on('genre')) set.genre = genre;
          return { id: t.id, set };
        });
        if (!items.length) { toast('Nothing matched to apply', true); return; }
        try {
          busy(apply, true, 'Applying…');
          let list = (await apiPost('edit', { source: 'musicbrainz', items })).tracks;
          if (on('cover')) {
            try { list = (await apiPost('cover_mb', { track_ids: tracks.map(t => t.id), release: rel.id })).tracks; }
            catch (e) { toast('Details saved, but the cover: ' + e.message, true); }
          }
          afterEdit(list, wasHash); sh.close(); toast(`Updated ${plural(items.length, 'track')} from MusicBrainz`);
        } catch (e) { toast(e.message, true); busy(apply, false, 'Apply'); }
      });
    }
    if (album.value.trim()) search(); else setTimeout(() => album.focus(), 30);
  }

  // ---- writing the edits into the files themselves (the gateway does it, when it is allowed to)
  const FIELD_NAME = { title: 'Title', artist: 'Artist', album_artist: 'Album artist', album: 'Album', track_no: 'Track', disc_no: 'Disc', year: 'Year', genre: 'Genre' };
  const JOB_SAYS = { queued: 'waiting for the gateway', working: 'writing…', done: 'written', failed: 'failed' };

  function writeToFiles(tracks) {
    if (needServer()) return;
    const ids = tracks.map(t => t.id);
    const byId = new Map(tracks.map(t => [t.id, t]));
    const sh = openSheet('Write to the files', 'wide');
    const gw = h('div', { class: 'gw' });
    const list = h('div', { class: 'wlist' });
    sh.body.append(h('p', { class: 'enote', text: 'This puts your edits (and a chosen cover) into the music files on the Storage Box, so they are part of the files from now on. Each file is checked before it replaces the old one, and “Undo last write” puts the files and your edits back as they were.' }), gw, list);
    const undo = h('button', { class: 'btn', type: 'button', text: 'Undo last write' });
    const close = h('button', { class: 'btn', type: 'button', text: 'Close', onclick: () => { stop(); sh.close(); } });
    const go = h('button', { class: 'btn go', type: 'button', text: 'Write' });
    sh.foot.append(undo, close, go);
    let timer = 0, open = true, wasBusy = false;
    const stop = () => { open = false; clearTimeout(timer); };
    const x = sh.box.querySelector('.shead2 .x');
    if (x) x.addEventListener('click', stop);

    async function paint() {
      if (!open || !sh.box.isConnected) { stop(); return; }
      let j;
      try { j = await api('push_status', { ids: ids.join(',') }); } catch (e) { list.replaceChildren(h('div', { class: 'empty', text: e.message })); return; }
      const g = j.gateway;
      gw.className = 'gw ' + (g.can_write && g.online ? 'ok' : 'warn');
      gw.textContent = !g.online ? 'The gateway hasn’t checked in for a while, so nothing will be written until it does.'
        : !g.can_write ? 'The gateway isn’t allowed to write yet. On the gateway: update scray-audio-scan.py and add SCRAY_WRITE_TAGS=1 to /etc/scray/audio-scan.env. Until then, anything you ask for waits here.'
        : 'The gateway is set up to write.';
      const todo = j.tracks.filter(t => (Object.keys(t.changes).length || t.cover) && t.writable);
      const pending = j.tracks.filter(t => t.job && (t.job.state === 'queued' || t.job.state === 'working'));
      const rows = j.tracks.filter(t => Object.keys(t.changes).length || t.cover || t.job).map(t => {
        const tr = byId.get(t.id) || {};
        const what = Object.entries(t.changes).map(([k, v]) => h('span', { class: 'wch' }, `${FIELD_NAME[k] || k}: `, h('s', { text: t.now[k] == null || t.now[k] === '' ? '—' : String(t.now[k]) }), ' → ', h('ins', { text: v === '' ? '(removed)' : v })));
        if (t.cover) what.push(h('span', { class: 'wch', text: 'Cover: the chosen picture goes inside the file' }));
        const st = t.job ? h('span', { class: 'wst ' + t.job.state, text: (t.job.kind === 'undo' ? 'undo ' : '') + JOB_SAYS[t.job.state] + (t.job.error ? `: ${t.job.error}` : '') }) : null;
        return h('div', { class: 'wtr' }, h('b', { text: tr.title || t.path.split('/').pop() }),
          !t.writable && what.length ? h('span', { class: 'wst failed', text: `${t.ext} files can’t be written` }) : null,
          what.length ? h('div', { class: 'whats' }, what) : h('div', { class: 'enote', text: 'The file matches.' }), st);
      });
      list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'empty', text: 'Nothing to write: the files already say what you see.' })]));
      go.textContent = todo.length ? `Write ${plural(todo.length, 'file')}` : 'Write';
      go.disabled = !todo.length || pending.length > 0;
      const canUndo = j.tracks.filter(t => t.undo);
      undo.hidden = !canUndo.length;
      undo.disabled = pending.length > 0;
      if (pending.length) { wasBusy = true; timer = setTimeout(paint, 3000); }
      else if (wasBusy) { wasBusy = false; afterEditQuiet(); }
    }
    async function afterEditQuiet() {
      try { const j = await apiPost('tracks_by_id', { ids }); tracksChanged(j.tracks); } catch (e) { /* the page will catch up */ }
      const y = window.scrollY; route().then(() => window.scrollTo(0, y));
    }
    go.addEventListener('click', async () => {
      const n = go.textContent.replace(/^Write /, '');
      const yes = await dialog({ title: `Write ${n}?`, text: 'The files on the Storage Box are changed. You can undo it afterwards.', ok: 'Write' });
      if (!yes) return;
      try {
        busy(go, true);
        const j = await apiPost('push_request', { track_ids: ids });
        toast(j.queued ? `${plural(j.queued, 'file')} queued for the gateway` : 'Nothing to write');
        if (j.skipped && j.skipped.length) toast(`Skipped: ${j.skipped.join(', ')}`, true);
      } catch (e) { toast(e.message, true); }
      paint();
    });
    undo.addEventListener('click', async () => {
      const yes = await dialog({ title: 'Undo the last write?', text: 'The files go back to the tags they had, and your edits come back as they were.', ok: 'Undo', danger: true });
      if (!yes) return;
      try { busy(undo, true); const j = await apiPost('push_undo', { track_ids: ids }); toast(`${plural(j.queued, 'file')} queued to put back`); } catch (e) { toast(e.message, true); }
      busy(undo, false);
      paint();
    });
    paint();
  }

  // ------------------------------------------------------------------ views
  let viewSeq = 0;
  const show = (my, ...els) => { if (my === viewSeq) { view.replaceChildren(...els.filter(Boolean)); markNow(); } };

  function folderRow(f, showPath) {
    const tracksOf = async () => (await api('tracks', { folder: f.path, order: 'path', limit: 100000 })).tracks;
    const parent = f.path.slice(0, Math.max(0, f.path.length - f.name.length - 1));
    return h('a', { class: 'folder', href: `#/f/${enc(f.path)}` },
      h('span', { class: 'ic', text: '📁' }),
      h('span', { class: 'nm', title: f.path }, f.name, showPath && parent ? h('i', { class: 'fp', text: parent }) : null),
      h('span', { class: 'ct', text: plural(f.tracks, 'track') }),
      h('button', { class: 'pl', title: 'Add this folder to the queue', 'aria-label': `Add ${f.name} to the queue`, text: '+', onclick: queueFrom(tracksOf) }),
      h('button', {
        class: 'pl', title: 'Shuffle this folder', 'aria-label': `Shuffle ${f.name}`, text: '🔀',
        onclick: async e => { e.preventDefault(); e.stopPropagation(); unlock(); try { playList(await tracksOf(), true); } catch (err) { toast(err.message, true); } },
      }));
  }

  // ---- the search term, kept while you move between the tabs: each tab then shows what matches it
  let term = (() => { try { return sessionStorage.getItem('scrayAudio.q') || ''; } catch (e) { return ''; } })();
  function setTerm(q) {
    term = String(q || '').trim();
    try { sessionStorage.setItem('scrayAudio.q', term); } catch (e) { /* fine */ }
    if ($('search').value.trim() !== term) $('search').value = term;
    const tab = $('tabres');
    tab.hidden = !term;
    tab.href = '#/search/' + enc(term);
  }
  function clearTerm() {
    setTerm('');
    if (location.hash.startsWith('#/search/')) location.hash = '#/'; else route();
  }
  /** "3 albums match “x” · Show all" over a filtered tab. */
  const matchNote = (n, what) => h('div', { class: 'fnote' },
    n ? `${plural(n, what)} matching “${term}”` : `No ${what}s match “${term}”`, ' · ',
    h('button', { class: 'lnk', type: 'button', text: 'Show all', onclick: clearTerm }));

  async function viewFolderMatches(my) {
    const j = await api('search', { q: term });
    const f = j.folders || [];
    show(my, h('h1', { class: 'title', text: 'Folders' }), matchNote(f.length, 'folder'),
      f.length ? h('div', { class: 'folders' }, f.map(x => folderRow(x, true))) : null);
  }

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

    if (j.folders.length) out.push(h('div', { class: 'folders' }, j.folders.map(f => folderRow(f))));
    if (j.tracks.length) out.push(trackList(j.tracks, { trackNumbers: false, inOrder: true }));
    if (!j.total) {
      out.push(h('div', { class: 'empty', text: offlineOn() ? 'No saved music here yet. Go online and use Save offline on a track, album or folder.' : path ? 'Nothing in this folder.' : 'The library is empty. Run the scanner on the gateway (see the README), then reload.' }));
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
    let { artists } = await api('artists');
    if (term) artists = artists.filter(a => matches(term, a.name));
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
    out.push(h('h1', { class: 'title', text: 'Artists' }), term ? matchNote(artists.length, 'artist') : h('div', { class: 'subtitle', text: plural(artists.length, 'artist') }), term ? null : jump, list);
    if (!artists.length && !term) out.push(h('div', { class: 'empty', text: 'No artists yet.' }));
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
    if (term) {
      const hits = albums.filter(a => matches(term, a.album, a.artist));
      show(my, h('h1', { class: 'title', text: 'Albums' }), matchNote(hits.length, 'album'), hits.length ? h('div', { class: 'grid' }, hits.map(albumCard)) : null);
      return;
    }
    const grid = h('div', { class: 'grid' });
    const paint = q => grid.replaceChildren(...albums.filter(a => !q.trim() || matches(q, a.album, a.artist)).map(albumCard));
    const f = h('input', { class: 'filter', type: 'search', placeholder: 'Filter albums', 'aria-label': 'Filter albums', oninput: () => paint(f.value) });
    paint('');
    show(my, h('h1', { class: 'title', text: 'Albums' }), h('div', { class: 'bar' }, f, h('span', { class: 'meta', text: plural(albums.length, 'album') })), grid,
      albums.length ? null : h('div', { class: 'empty', text: 'No albums yet.' }));
  }

  async function viewAlbum(my, artist, album, folder) {
    // With a folder the album is "this album tag in this folder", whoever each track's album artist says it is.
    const { tracks } = await api('tracks', folder ? { album, folder, limit: 5000 } : { artist, album, limit: 5000 });
    if (!tracks.length) { show(my, h('div', { class: 'empty', text: 'Album not found.' })); return; }
    const ms = tracks.reduce((n, t) => n + (t.ms || 0), 0);
    const year = (tracks.find(t => t.year) || {}).year;
    const cov = tracks.find(t => t.cover);
    const aas = [...new Set(tracks.map(t => t.albumArtist))];
    const who = aas.length === 1 ? aas[0] : '';              // one album artist, or none to name
    show(my,
      h('div', { class: 'pagehead' }, coverEl(cov ? cov.id : null), h('div', {},
        h('h1', { class: 'title', text: album || '(no album)' }),
        h('div', { class: 'subtitle' }, who ? h('a', { href: `#/artist/${enc(who)}`, text: who }) : (folder ? 'Various artists' : h('a', { href: `#/artist/${enc(artist)}`, text: artist })), year ? ` · ${year}` : '', ` · ${plural(tracks.length, 'track')} · ${longTime(ms)}`))),
      actions(async () => tracks, h('span', { class: 'grp' },
        h('button', { class: 'btn', text: '✎ Edit', title: 'Edit the album and its tracks', onclick: () => editAlbum(tracks) }),
        h('button', { class: 'btn', text: '⌕ MusicBrainz', title: 'Look this album up on MusicBrainz and fix its details and cover', onclick: () => findOnMB(tracks) }),
        tracks.some(t => t.edited) ? h('button', { class: 'btn', text: '⇪ Write to files', title: 'Put these edits into the music files themselves', onclick: () => writeToFiles(tracks) }) : null)),
      trackList(tracks, { noAlbum: true, albumArtist: who || undefined, trackNumbers: true, discs: true, inOrder: true }));
  }

  // ---- playlists
  async function refreshPlaylist(id) {
    const y = window.scrollY, my = ++viewSeq;
    try { await viewPlaylist(my, id); window.scrollTo(0, y); } catch (e) { toast(e.message, true); }
  }

  function playlistRow(p) {
    const tracksOf = async () => (await api('playlist', { id: p.id })).tracks;
    const play = shuffle => async e => {
      e.preventDefault(); e.stopPropagation(); unlock();
      try { playList(await tracksOf(), shuffle); } catch (err) { toast(err.message, true); }
    };
    const row = h('a', { class: 'plrow' + (p.liked ? ' liked' : ''), href: `#/playlist/${p.id}` },
      p.liked && p.art == null ? h('div', { class: 'cover likedcv', text: '♥' }) : coverEl(p.art),
      h('span', { class: 'pn' }, h('b', { text: p.name }),
        h('i', { text: [plural(p.tracks, 'track'), p.ms ? longTime(p.ms) : '', p.missing ? `${p.missing} missing` : ''].filter(Boolean).join(' · ') })),
      h('button', { class: 'pl', title: 'Play', 'aria-label': `Play ${p.name}`, text: '▶', onclick: play(false) }),
      h('button', { class: 'pl', title: 'Shuffle', 'aria-label': `Shuffle ${p.name}`, text: '🔀', onclick: play(true) }),
      h('button', { class: 'pl', title: 'Add to queue', 'aria-label': `Add ${p.name} to the queue`, text: '+', onclick: queueFrom(tracksOf) }));
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      openMenu([
        { label: 'Play', onclick: () => { unlock(); tracksOf().then(l => playList(l, false)).catch(err => toast(err.message, true)); } },
        { label: 'Shuffle', onclick: () => { unlock(); tracksOf().then(l => playList(l, true)).catch(err => toast(err.message, true)); } },
        { label: 'Add to queue', onclick: () => queueFrom(tracksOf)() },
        ...(p.liked ? [] : [{ sep: true },
          { label: 'Rename…', onclick: () => renamePlaylist(p, route) },
          { label: 'Delete…', danger: true, onclick: () => deletePlaylist(p, route) }]),
      ], menuAt(e, row), row);
    });
    return row;
  }

  async function viewPlaylists(my) {
    let { playlists } = await api('playlists');
    const lk = playlists.find(p => p.liked);
    if (lk && lk.id !== LIKED.id) loadLiked();
    if (term) {
      playlists = playlists.filter(p => matches(term, p.name));
      show(my, h('h1', { class: 'title', text: 'Playlists' }), matchNote(playlists.length, 'playlist'),
        playlists.length ? h('div', { class: 'pls' }, playlists.map(playlistRow)) : null);
      return;
    }
    show(my,
      h('h1', { class: 'title', text: 'Playlists' }),
      h('div', { class: 'bar' }, h('button', { class: 'btn go', text: '＋ New playlist', onclick: () => newPlaylist(null) }),
        h('span', { class: 'meta', text: plural(playlists.length, 'playlist') })),
      playlists.length
        ? h('div', { class: 'pls' }, playlists.map(playlistRow))
        : h('div', { class: 'empty', text: 'No playlists yet. Make one with “＋ New playlist”, or use ⋯ on any track (or “＋ Playlist” on an album or folder) and choose Add to playlist.' }));
  }

  async function viewPlaylist(my, id) {
    const { playlist: p, tracks } = await api('playlist', { id });
    const meta = [plural(p.tracks, 'track'), p.ms ? longTime(p.ms) : ''].filter(Boolean).join(' · ');
    const after = () => { location.hash = '#/playlists'; };
    show(my,
      h('div', { class: 'pagehead' }, coverEl(p.art), h('div', {},
        h('h1', { class: 'title', text: p.name }),
        h('div', { class: 'subtitle', text: meta }))),
      actions(async () => tracks, p.liked ? null : h('span', { class: 'grp' },
        h('button', { class: 'btn', text: 'Rename', onclick: () => renamePlaylist(p, () => refreshPlaylist(p.id)) }),
        h('button', { class: 'btn danger', text: 'Delete', onclick: () => deletePlaylist(p, after) })), { noPlaylist: true, noLike: p.liked }),
      p.missing ? h('div', { class: 'note' }, `${plural(p.missing, 'track')} no longer in the library (moved or deleted) ${p.missing === 1 ? 'is' : 'are'} hidden. `,
        h('button', { class: 'lnk', text: 'Remove from this playlist', onclick: () => playlistOp(p.id, 'playlist_remove', { missing: true }, 'Cleared') })) : null,
      tracks.length ? trackList(tracks, { playlist: { id: p.id } })
        : h('div', { class: 'empty', text: p.liked ? 'Nothing liked yet. Tap ♡ on any track, album or folder.' : 'Empty. Use ⋯ on a track, or “＋ Playlist” on an album, folder or search, and add to this playlist.' }));
  }

  async function viewGenres(my) {
    let { genres } = await api('genres');
    if (term) genres = genres.filter(g => matches(term, g.name));
    show(my, h('h1', { class: 'title', text: 'Genres' }), term ? matchNote(genres.length, 'genre') : h('div', { class: 'subtitle', text: plural(genres.length, 'genre') }),
      h('div', { class: 'list', style: 'margin-top:14px' }, genres.map(g => h('a', { class: 'item', href: `#/genre/${enc(g.name)}` },
        h('span', { class: 'nm', text: g.name }), h('span', { class: 'ct', text: plural(g.tracks, 'track') })))),
      genres.length || term ? null : h('div', { class: 'empty', text: 'No genres tagged yet.' }));
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
    const folders = j.folders || [];
    if (!j.tracks.length && !j.artists.length && !j.albums.length && !folders.length) out.push(h('div', { class: 'empty', text: 'No matches.' }));
    if (folders.length) out.push(h('h2', { class: 'sec', text: 'Folders' }), h('div', { class: 'folders' }, folders.slice(0, 12).map(f => folderRow(f, true))),
      folders.length > 12 ? h('a', { class: 'more', href: '#/', text: `All ${plural(folders.length, 'folder')} ›` }) : null);
    if (j.artists.length) out.push(h('h2', { class: 'sec', text: 'Artists' }), h('div', { class: 'list' }, j.artists.map(a =>
      h('a', { class: 'item', href: `#/artist/${enc(a.name)}` }, h('span', { class: 'nm', text: a.name }), h('span', { class: 'ct', text: plural(a.tracks, 'track') })))));
    if (j.albums.length) out.push(h('h2', { class: 'sec', text: 'Albums' }), h('div', { class: 'grid' }, j.albums.map(albumCard)));
    if (j.tracks.length) out.push(h('h2', { class: 'sec', text: 'Tracks' }), actions(async () => j.tracks), trackList(j.tracks));
    show(my, ...out);
  }

  // ----------------------------------------------------------------- router
  const TABS = { f: 'folders', '': 'folders', artists: 'artists', artist: 'artists', albums: 'albums', album: 'albums', genres: 'genres', genre: 'genres', playlists: 'playlists', playlist: 'playlists', search: 'search' };
  // The tabs that list things: with a search term, each shows only what matches it.
  const listTab = () => { const k = location.hash.replace(/^#\/?/, '').split('/'); return (k[0] === '' && k.length === 1) || (k[0] === 'f' && !k[1]) || ['artists', 'albums', 'genres', 'playlists'].includes(k[0]) && k.length === 1; };

  async function route() {
    const my = ++viewSeq;
    const parts = (location.hash.replace(/^#\/?/, '')).split('/').map(s => { try { return decodeURIComponent(s); } catch (e) { return s; } });
    const kind = parts[0] || '';
    document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === TABS[kind]));
    if (kind === 'search') setTerm(parts[1] || ''); else setTerm(term);
    window.scrollTo(0, 0);
    view.replaceChildren(h('div', { class: 'loading', text: 'Loading…' }));
    try {
      switch (kind) {
        case '': case 'f': if (term && !(kind === 'f' && parts[1])) await viewFolderMatches(my); else await viewFolders(my, kind === 'f' ? (parts[1] || '') : ''); break;
        case 'artists': await viewArtists(my); break;
        case 'artist': await viewArtist(my, parts[1] || ''); break;
        case 'albums': await viewAlbums(my); break;
        case 'album': await viewAlbum(my, parts[1] || '', parts[2] || '', parts[3] || ''); break;
        case 'playlists': await viewPlaylists(my); break;
        case 'playlist': await viewPlaylist(my, parseInt(parts[1], 10) || 0); break;
        case 'genres': await viewGenres(my); break;
        case 'genre': await viewGenre(my, parts[1] || ''); break;
        case 'search': if (term) await viewSearch(my, term); else show(my, h('div', { class: 'empty', text: 'Type in the search box.' })); break;
        default: show(my, h('div', { class: 'empty', text: 'Page not found.' }));
      }
    } catch (e) {
      if (my !== viewSeq) return;
      view.replaceChildren(h('div', { class: 'empty' }, `Couldn’t load this: ${e.message}`, h('button', { text: 'Retry', onclick: route })));
    }
  }
  window.addEventListener('hashchange', route);

  // Phone: swipe left / right on the page to move between the tabs (Results when searching, Folders … Playlists).
  // Only a clear sideways swipe counts; it leaves alone anything that scrolls sideways or drags (the tab strip,
  // the letters, sliders), the menus and panels, and inputs.
  (() => {
    let x0 = 0, y0 = 0, t0 = 0, live = false;
    const SKIP = '#tabs, .jump, input, textarea, select, .cmenu, .mback, .dback, .sa-veil, #queuepanel, #histpanel, #dlpanel, #scanpanel, #player';
    const tabs = () => [...document.querySelectorAll('#tabs a')].filter(a => !a.hidden);
    document.addEventListener('touchstart', e => {
      live = e.touches.length === 1 && !(e.target.closest && e.target.closest(SKIP)) && !menu.el;
      if (!live) return;
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
    }, { passive: true });
    document.addEventListener('touchmove', e => { if (live && e.touches.length !== 1) live = false; }, { passive: true });
    document.addEventListener('touchend', e => {
      if (!live) return;
      live = false;
      const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
      if (Date.now() - t0 > 700 || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.5) return;
      const list = tabs(), cur = list.findIndex(a => a.classList.contains('on'));
      if (cur < 0) return;                                   // a page that isn't under a tab
      const next = list[cur + (dx < 0 ? 1 : -1)];
      if (!next) return;
      view.classList.remove('swl', 'swr'); void view.offsetWidth;
      view.classList.add(dx < 0 ? 'swl' : 'swr');
      location.hash = next.getAttribute('href');
      next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, { passive: true });
  })();

  // search box. The term stays as you move between the tabs (Artists, Albums, Genres, Playlists, Folders), and
  // each shows what matches it; "Results" has everything. Typing on one of those tabs filters it in place;
  // anywhere else it goes to Results. Emptying the box shows everything again.
  let searchTimer = 0;
  const go = q => {
    const was = term;
    setTerm(q);
    if (term === was && !location.hash.startsWith('#/search/')) return;
    const onSearch = location.hash.startsWith('#/search/');
    const k = location.hash.replace(/^#\/?/, '').split('/')[0];
    if (listTab() && k !== '' && k !== 'f') { route(); return; }      // Artists, Albums, Genres, Playlists: filter in place
    if (!term) { if (onSearch) location.hash = '#/'; else route(); return; }
    const target = '#/search/' + enc(term);
    if (onSearch) { window.ScrayNavigation.replace(target); route(); } else location.hash = target;
  };
  $('search').addEventListener('input', e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => go(e.target.value), 300); });
  $('searchform').addEventListener('submit', e => { e.preventDefault(); clearTimeout(searchTimer); go($('search').value); });
  $('search').addEventListener('keydown', e => { if (e.key === 'Escape' && term) { e.preventDefault(); clearTimeout(searchTimer); clearTerm(); } });


  // ------------------------------------------------------------- scan panel
  // The scanner runs on the gateway. The button leaves a request in api.php,
  // the gateway picks it up within ~30 s, and while it works it reports
  // progress that this panel reads every 2 s.
  const scan = { state: 'idle', timer: 0, open: false, prev: null, viewStale: false };
  const ACTIVE = new Set(['requested', 'starting', 'running']);

  async function apiPost(action, body) {
    let r, j;
    const ai = authInit();
    try { r = await fetch(`${apiUrl()}?action=${action}`, { method: 'POST', credentials: ai.credentials, headers: { 'Content-Type': 'application/json', ...ai.headers }, body: JSON.stringify(body || {}) }); }
    catch (e) { throw new Error('can’t reach the server'); }
    try { j = await r.json(); } catch (e) { throw new Error(`server answered ${r.status}`); }
    if (!r.ok || !j.ok) throw new Error(j.error || `server answered ${r.status}`);
    return j;
  }

  const clock = secs => {
    secs = Math.max(0, Math.round(secs || 0));
    return secs >= 60 ? `${Math.floor(secs / 60)} min ${String(secs % 60).padStart(2, '0')} s` : `${secs} s`;
  };
  const when = iso => iso ? iso.slice(0, 16).replace('T', ' ') + ' UTC' : '';

  function paintScan(st) {
    const sc = st.scan, active = ACTIVE.has(st.state);
    const files = sc ? (sc.files_seen || 0) : 0;
    const btn = $('scanbtn'), bar = $('scanbar');
    btn.classList.toggle('busy', active);
    btn.classList.toggle('bad', st.state === 'idle' && !!(sc && sc.stale));
    $('scanlabel').textContent = st.state === 'running' ? files.toLocaleString() : st.state === 'idle' ? '' : '…';
    btn.title = st.state === 'running' ? `Scanning: ${files.toLocaleString()} files so far` : 'Library scan';

    // message
    let msg;
    if (st.state === 'requested') msg = 'Scan asked for. Waiting for the scanner on the gateway to pick it up (it checks every 30 seconds)…';
    else if (st.state === 'starting') msg = 'The scanner has the request and is starting…';
    else if (st.state === 'running') {
      const exp = st.expected || 0;
      msg = `Scanning: ${files.toLocaleString()}${exp ? ` of about ${exp.toLocaleString()}` : ''} files · ${clock(sc.elapsed)}`;
    } else if (sc && sc.stale) msg = `The last scan stopped reporting ${clock(sc.beat_age)} ago and never finished (the scanner may have crashed). On the gateway: journalctl -u scray-audio-scan -n 50`;
    else if (sc && sc.finished_at) {
      msg = `Last scan finished ${when(sc.finished_at)}: ${plural(sc.files_seen || 0, 'file')} seen, ${plural(sc.tagged || 0, 'tag read')}`
        + (sc.pruned ? `, ${sc.pruned} removed` : '') + (sc.complete ? '' : ' (partial or incomplete: nothing removed)') + '.';
    } else msg = 'No scan has run yet.';
    if (st.state === 'idle' && sc && sc.note) msg += ` ${sc.note}.`;
    $('scanmsg').textContent = msg;

    // bar
    const determinate = st.state === 'running' && st.expected > 0;
    bar.classList.toggle('off', !active);
    bar.classList.toggle('indet', active && !determinate);
    const pct = determinate ? Math.min(99, Math.round(files / st.expected * 100)) : 0;
    bar.firstElementChild.style.width = determinate ? pct + '%' : '';
    if (determinate) bar.setAttribute('aria-valuenow', String(pct)); else bar.removeAttribute('aria-valuenow');

    // numbers
    const nums = $('scannums');
    nums.replaceChildren();
    const row = (k, v) => nums.append(h('div', {}, h('dt', { text: k }), h('dd', { text: v })));
    if (sc && (st.state === 'running' || (st.state === 'idle' && sc.finished_at && !sc.stale))) {
      row('Folders', (sc.folders || 0).toLocaleString());
      row('Files seen', files.toLocaleString());
      row('Tags read', (sc.tagged || 0).toLocaleString());
      row('Tag errors', (sc.errors || 0).toLocaleString());
    }
    row('Tracks in library', (st.tracks || 0).toLocaleString());

    // what the last scan found but didn't add, and what went in without its tags: by name, with why
    const lists = $('scanlists');
    const list = (o, title, open) => {
      if (!o || !o.total) return null;
      return h('details', { class: 'slist', open: open || null },
        h('summary', { text: `${title} (${o.total.toLocaleString()})` }),
        h('ul', {}, o.items.map(x => h('li', {}, h('b', { text: x.path + (x.kind === 'folder' ? '/' : '') }), h('i', { text: x.why || '' })))),
        o.total > o.items.length ? h('p', { class: 'smsg dim', text: `…and ${(o.total - o.items.length).toLocaleString()} more` }) : null);
    };
    if (st.state !== 'running') lists.replaceChildren(...[list(st.not_added, 'Not added', true), list(st.no_tags, 'Added, but its tags couldn’t be read')].filter(Boolean));

    // warning: nobody home
    const warn = $('scanwarn');
    const offline = (st.state === 'requested' || st.state === 'starting') && !st.worker_online;
    warn.hidden = !offline;
    if (offline) warn.textContent = st.worker_age == null
      ? 'The scanner has never checked in. On the gateway: systemctl enable --now scray-audio-scan-poll.timer'
      : `The scanner last checked in ${clock(st.worker_age)} ago. On the gateway: systemctl status scray-audio-scan-poll.timer`;

    $('scango').disabled = active;
    $('scango').textContent = active ? (st.state === 'running' ? 'Scanning…' : 'Requested…') : 'Scan library now';
    $('scanrefresh').hidden = !scan.viewStale;

    // finished while we were watching
    if (scan.prev && ACTIVE.has(scan.prev) && st.state === 'idle' && sc) {
      const bad = sc.stale || (sc.note || '').startsWith('stopped');
      toast(bad ? 'The scan stopped early - open the scan panel' : `Scan finished: ${plural(st.tracks, 'track')} in the library`, bad);
      scan.viewStale = true;
      $('scanrefresh').hidden = false;
    }
    scan.prev = st.state;
    scan.state = st.state;
  }

  // Every 2 s while the panel is open or a scan is active; once a minute otherwise
  // (so a nightly scan still shows up), and not at all while the tab is hidden.
  async function scanTick() {
    clearTimeout(scan.timer);
    let again = 60000;
    if (!document.hidden || ACTIVE.has(scan.state) || scan.open) {
      try {
        paintScan(await api('scan_status'));
        again = scan.open || ACTIVE.has(scan.state) ? 2000 : 60000;
      } catch (e) {
        if (scan.open) $('scanmsg').textContent = `Can’t read the scan status: ${e.message}`;
        again = scan.open ? 5000 : 60000;
      }
    }
    scan.timer = setTimeout(scanTick, again);
  }

  function setScanPanel(open) {
    scan.open = open;
    $('scanpanel').hidden = !open;
    $('scanbtn').setAttribute('aria-expanded', String(open));
    if (open) {
      $('scanpanel').style.top = ($('top').getBoundingClientRect().bottom + 6) + 'px';
      scanTick();
    }
  }
  $('scanbtn').addEventListener('click', () => setScanPanel(!scan.open));
  $('scanclose').addEventListener('click', () => { setScanPanel(false); $('scanbtn').focus(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && scan.open) setScanPanel(false); });
  $('scango').addEventListener('click', async () => {
    $('scango').disabled = true;
    try { paintScan(await apiPost('scan_request')); scanTick(); }
    catch (e) { toast(e.message, true); $('scango').disabled = false; }
  });
  $('scanrefresh').addEventListener('click', () => { scan.viewStale = false; $('scanrefresh').hidden = true; route(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scanTick(); });

  $('nplike').addEventListener('click', e => { e.stopPropagation(); const t = P.queue[P.idx]; if (t) like([t], !LIKED.ids.has(t.id)); });
  $('np').addEventListener('contextmenu', e => {
    const t = P.queue[P.idx];
    if (!t) return;
    e.preventDefault();
    openTrackMenu(t, {}, menuAt(e, $('np')), $('np'));
  });
  window.addEventListener('hashchange', closeMenu);

  // ------------------------------------------------------- offline (the app)
  // Tracks saved on the phone: a toggle that shows only those, save/remove buttons, and a panel for the downloads
  // in progress. Everything here is inert in a browser (OFF is null and the buttons stay hidden).
  const mode = { off: !!store.get('offline', false), panel: false };
  const offlineOn = () => !!(OFF && mode.off);
  const mb = b => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1e6)) + ' MB');

  function setOffline(on, why, rerender) {
    if (!OFF || mode.off === on) return;
    mode.off = on;
    store.set('offline', on);
    paintOffline();
    if (why) toast(why);
    if (rerender) route();
  }

  const dlCtx = OFF ? {
    getUrl: async t => (await api('url', { id: t.id })).url,
    getCoverUrl: async t => (await api('cover_url', { t: t.id })).url,
  } : null;

  async function saveOffline(getTracks) {
    try {
      const tracks = (await getTracks()).filter(t => t.path && !OFF.has(t.id));
      if (!tracks.length) { toast('Already saved on this phone'); return; }
      const bytes = tracks.reduce((a, t) => a + (t.size || 0), 0);
      let free = null;
      try { free = (await OFF.storage()).free; } catch (e) { /* unknown: carry on */ }
      if (free != null && bytes > free - 200e6) { toast(`Not enough space: ${plural(tracks.length, 'track')} need ${mb(bytes)} and ${mb(free)} is free`, true); return; }
      if (tracks.length > 1) {
        const ok = await dialog({ title: 'Save offline?', text: `${plural(tracks.length, 'track')}, about ${mb(bytes)}${free != null ? ` (${mb(free)} free on this phone)` : ''}.`, ok: 'Save' });
        if (!ok) return;
      }
      const n = await OFF.download(tracks, dlCtx);
      toast(n ? `Saving ${plural(n, 'track')}…` : 'Already on its way');
    } catch (e) { toast(e.message, true); }
  }

  async function removeOffline(getTracks) {
    try {
      const tracks = (await getTracks()).filter(t => OFF.has(t.id));
      if (!tracks.length) { toast('None of these are saved on this phone'); return; }
      if (tracks.length > 1 && !await dialog({ title: 'Remove from this phone?', text: `${plural(tracks.length, 'saved track')} will be deleted from this phone. They stay in the library.`, ok: 'Remove', danger: true })) return;
      await OFF.remove(tracks);
      toast(`Removed ${plural(tracks.length, 'track')} from this phone`);
      if (offlineOn()) route();
    } catch (e) { toast(e.message, true); }
  }

  function offlineMenu(getTracks, btn) {
    openMenu([
      { label: 'Save offline', onclick: () => saveOffline(getTracks) },
      { label: 'Remove from offline', danger: true, onclick: () => removeOffline(getTracks) },
    ], { el: btn }, btn);
  }

  function paintOffline() {
    if (!OFF) return;
    $('offbtn').hidden = false;
    $('offbtn').setAttribute('aria-pressed', String(mode.off));
    $('offbtn').classList.toggle('on', mode.off);
    $('offcount').textContent = OFF.count ? String(OFF.count) : '';
    const jobs = OFF.jobs(), live = OFF.active(), bad = jobs.filter(j => j.state === 'error').length;
    const byId = new Map(jobs.map(j => [j.track.id, j]));
    document.querySelectorAll('.trk[data-id]').forEach(r => {
      const id = +r.dataset.id, j = byId.get(id);
      r.classList.toggle('off', OFF.has(id));
      const busy = !!j && (j.state === 'queued' || j.state === 'active');
      r.classList.toggle('dl', busy);
      if (busy) r.style.setProperty('--p', j.total ? Math.min(100, j.received / j.total * 100) + '%' : '0%');
    });
    const b = $('dlbtn');
    b.hidden = !(live || bad || mode.panel || window.ScrayDesktop);
    b.classList.toggle('busy', live > 0);
    b.classList.toggle('bad', !live && bad > 0);
    $('dllabel').textContent = live ? String(live) : bad ? '!' : '';
    if (mode.panel) paintDl(jobs, live, bad);
  }

  let storageCheckedAt = 0;
  function paintDl(jobs, live, bad) {
    const list = jobs.filter(j => j.state !== 'cancelled');
    const done = list.filter(j => j.state === 'done').length;
    $('dlmsg').textContent = live ? `Saving ${plural(live, 'track')}…` : bad ? `${plural(bad, 'track')} failed` : 'Nothing downloading';
    if (APP) $('dlsign').textContent = APP.key ? `Sign out${APP.name ? ' (' + APP.name + ')' : ''}` : 'Sign in';
    $('dlfolder').textContent = OFF.folder ? `Saved in “${OFF.location || OFF.folder + '/Offline'}” · ${plural(OFF.count, 'track')}` : 'No folder chosen yet - you’ll be asked when you save something.';
    if (window.ScrayDesktop && Date.now() - storageCheckedAt > 2000) {
      storageCheckedAt = Date.now();
      let note = $('dlstorage');
      if (!note) { note = h('div', { id: 'dlstorage', class: 'smsg dim' }); $('dlfolder').after(note); }
      OFF.storage().then(s => { note.textContent = `${s.used ? mb(s.used) : '0 MB'} saved · ${mb(s.free)} free`; }).catch(() => { note.textContent = 'Storage information unavailable'; });
    }
    $('dllist').replaceChildren(...list.filter(j => j.state !== 'done').slice(0, 40).map(j => h('div', { class: 'dlrow' + (j.state === 'error' ? ' bad' : '') },
      h('span', { class: 'dn', text: j.track.title }),
      h('span', { class: 'ds', text: j.state === 'error' ? (j.error || 'failed') : j.state === 'queued' ? 'waiting' : j.total ? Math.round(Math.min(100, j.received / j.total * 100)) + '%' : '…' }),
      j.state === 'error' ? null : h('button', { type: 'button', 'aria-label': 'Cancel', text: '×', onclick: () => OFF.cancel(j.track.id) }))));
    if (done && !live) $('dlmsg').textContent += ` · ${done} done`;
    $('dlretry').hidden = !bad;
    $('dlcancel').hidden = !live;
  }

  function setDlPanel(open) {
    if (open) storageCheckedAt = 0;
    mode.panel = open;
    $('dlpanel').hidden = !open;
    $('dlbtn').setAttribute('aria-expanded', String(open));
    if (open) $('dlpanel').style.top = ($('top').getBoundingClientRect().bottom + 6) + 'px';
    paintOffline();
  }

  if (OFF) {
    if (window.ScrayDesktop) $('dlfolderbtn').hidden = true;
    $('offbtn').addEventListener('click', () => setOffline(!mode.off, '', true));
    $('dlbtn').addEventListener('click', () => setDlPanel(!mode.panel));
    $('dlclose').addEventListener('click', () => setDlPanel(false));
    $('dlcancel').addEventListener('click', () => OFF.cancelAll());
    $('dlretry').addEventListener('click', () => OFF.retryFailed(dlCtx));
    if (APP) {
      $('dlsign').hidden = false;
      $('dlsign').addEventListener('click', () => { if (!APP.key) { setDlPanel(false); APP.signIn(); } else dialog({ title: 'Sign this phone out?', text: 'It will need the password and a code to reach the library again. Saved music keeps playing.', ok: 'Sign out', danger: true }).then(yes => { if (yes) APP.signOut(); }); });
    }
    $('dlfolderbtn').addEventListener('click', () => OFF.pickFolder().then(() => paintOffline()).catch(e => toast(e.message, true)));
    OFF.onChange(paintOffline);
  }

  paintControls();
  paintPlay();
  // Saved tracks catch up with edits made since (another phone, the web page): once per start, when online.
  async function refreshSaved() {
    if (!OFF || !OFF.count || !OFF.refresh || (APP && !APP.key) || offlineOn()) return;
    const ids = OFF.all().map(t => t.id);
    try {
      for (let i = 0; i < ids.length; i += 2000) {
        const j = await apiPost('tracks_by_id', { ids: ids.slice(i, i + 2000) });
        await OFF.refresh(j.tracks, dlCtx);
      }
    } catch (e) { /* offline: next time */ }
  }
  if (APP && $('bulkmb')) $('bulkmb').remove();             // the bulk page is for a computer
  if (APP && $('mbbtn')) $('mbbtn').remove();
  const start = () => { paintOffline(); route(); scanTick(); loadLiked(); refreshSaved(); sendPlays(); };
  if (OFF) {
    OFF.init().then(() => { if ((APP && !APP.key && (OFF.count || window.ScrayDesktop)) || (window.ScrayDesktop && !navigator.onLine)) mode.off = true; }).catch(() => {}).finally(start);
  } else start();
})();
