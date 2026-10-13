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
    if (!APP) { img.src = `api.php?action=cover&t=${id}`; return; }
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
    if (n && !(OFF && OFF.has(n.id)) && linkStale(n, 600)) getUrl(n).catch(() => {});
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
    if (t.cover) { const img = h('img', { alt: '' }); img.addEventListener('error', () => img.remove()); cv.append(img); setCover(img, t.id); }
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
    const meta = (src) => { navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: src ? [{ src, sizes: '512x512' }] : [] }); };
    if (!APP) { meta(t.cover ? new URL(`api.php?action=cover&t=${t.id}`, location.href).href : null); return; }
    meta(null);                                                  // the app: the lock screen gets the cover once its signed link is back
    if (t.cover) {
      const local = OFF && OFF.coverUrl(t.id);
      if (local) meta(local);
      else api('cover_url', { t: t.id }).then(j => { if (P.queue[P.idx] === t) meta(j.url); }).catch(() => {});
    }
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
          h('button', {
            class: 'add', title: 'Add to queue (Shift: play next)', 'aria-label': 'Add to queue', text: '+',
            onclick: e => { e.stopPropagation(); enqueue(t, e.shiftKey); },
          }),
          h('button', {
            class: 'dots', title: 'More: go to album or artist, add to a playlist… (or right-click)', 'aria-label': 'More actions', 'aria-haspopup': 'menu', text: '⋯',
            onclick: e => { e.stopPropagation(); openTrackMenu(t, { list: tracks, index: i, playlist: o.playlist }, { el: e.currentTarget, right: true }, e.currentTarget); },
          })));
      row.addEventListener('contextmenu', e => {
        e.preventDefault();
        const at = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { el: row };   // the keyboard's menu key has no pointer
        openTrackMenu(t, { list: tracks, index: i, playlist: o.playlist }, at, row);
      });
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

  function actions(getTracks, extra, o) {
    const run = async shuffle => {
      unlock();
      try { playList(await getTracks(), shuffle); } catch (e) { toast(e.message, true); }
    };
    return h('div', { class: 'bar' },
      h('button', { class: 'btn go', text: '▶ Play', onclick: () => run(false) }),
      h('button', { class: 'btn', text: '🔀 Shuffle', onclick: () => run(true) }),
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
    if (onPlaylist(id)) refreshPlaylist(id);
  }

  function trackMenuItems(t, ctx) {
    const go = hash => () => { location.hash = hash; };
    const items = [];
    if (ctx.list) items.push({ label: 'Play', onclick: () => startQueue(ctx.list, ctx.index) });
    items.push({ label: 'Play next', onclick: () => enqueue(t, true) }, { label: 'Add to queue', onclick: () => enqueue(t, false) }, { sep: true });
    if (t.album && t.albumArtist) items.push({ label: 'Go to album', hint: t.album, onclick: go(`#/album/${enc(t.albumArtist)}/${enc(t.album)}`) });
    if (t.albumArtist) items.push({ label: 'Go to artist', hint: t.albumArtist, onclick: go(`#/artist/${enc(t.albumArtist)}`) });
    if (t.artist && t.artist !== t.albumArtist) items.push({ label: 'More by', hint: t.artist, onclick: go(`#/search/${enc(t.artist)}`) });
    if (t.folder) items.push({ label: 'Show in folder', hint: t.folder.split('/').pop(), onclick: go(`#/f/${enc(t.folder)}`) });
    if (OFF && t.path) items.push({ sep: true }, OFF.has(t.id)
      ? { label: 'Remove from offline', onclick: () => removeOffline(async () => [t]) }
      : { label: 'Save offline', onclick: () => saveOffline(async () => [t]) });
    items.push({ sep: true });
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

  // ------------------------------------------------------------------ views
  let viewSeq = 0;
  const show = (my, ...els) => { if (my === viewSeq) { view.replaceChildren(...els.filter(Boolean)); markNow(); } };

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
    const row = h('a', { class: 'plrow', href: `#/playlist/${p.id}` },
      coverEl(p.art),
      h('span', { class: 'pn' }, h('b', { text: p.name }),
        h('i', { text: [plural(p.tracks, 'track'), p.ms ? longTime(p.ms) : '', p.missing ? `${p.missing} missing` : ''].filter(Boolean).join(' · ') })),
      h('button', { class: 'pl', title: 'Play', 'aria-label': `Play ${p.name}`, text: '▶', onclick: play(false) }),
      h('button', { class: 'pl', title: 'Shuffle', 'aria-label': `Shuffle ${p.name}`, text: '🔀', onclick: play(true) }));
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      openMenu([
        { label: 'Play', onclick: () => { unlock(); tracksOf().then(l => playList(l, false)).catch(err => toast(err.message, true)); } },
        { label: 'Shuffle', onclick: () => { unlock(); tracksOf().then(l => playList(l, true)).catch(err => toast(err.message, true)); } },
        { sep: true },
        { label: 'Rename…', onclick: () => renamePlaylist(p, route) },
        { label: 'Delete…', danger: true, onclick: () => deletePlaylist(p, route) },
      ], menuAt(e, row), row);
    });
    return row;
  }

  async function viewPlaylists(my) {
    const { playlists } = await api('playlists');
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
      actions(async () => tracks, h('span', { class: 'grp' },
        h('button', { class: 'btn', text: 'Rename', onclick: () => renamePlaylist(p, () => refreshPlaylist(p.id)) }),
        h('button', { class: 'btn danger', text: 'Delete', onclick: () => deletePlaylist(p, after) })), { noPlaylist: true }),
      p.missing ? h('div', { class: 'note' }, `${plural(p.missing, 'track')} no longer in the library (moved or deleted) ${p.missing === 1 ? 'is' : 'are'} hidden. `,
        h('button', { class: 'lnk', text: 'Remove from this playlist', onclick: () => playlistOp(p.id, 'playlist_remove', { missing: true }, 'Cleared') })) : null,
      tracks.length ? trackList(tracks, { playlist: { id: p.id } })
        : h('div', { class: 'empty', text: 'Empty. Use ⋯ on a track, or “＋ Playlist” on an album, folder or search, and add to this playlist.' }));
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
  const TABS = { f: 'folders', '': 'folders', artists: 'artists', artist: 'artists', albums: 'albums', album: 'albums', genres: 'genres', genre: 'genres', playlists: 'playlists', playlist: 'playlists', search: '' };

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
        case 'playlists': await viewPlaylists(my); break;
        case 'playlist': await viewPlaylist(my, parseInt(parts[1], 10) || 0); break;
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
    b.hidden = !(live || bad || mode.panel);
    b.classList.toggle('busy', live > 0);
    b.classList.toggle('bad', !live && bad > 0);
    $('dllabel').textContent = live ? String(live) : bad ? '!' : '';
    if (mode.panel) paintDl(jobs, live, bad);
  }

  function paintDl(jobs, live, bad) {
    const list = jobs.filter(j => j.state !== 'cancelled');
    const done = list.filter(j => j.state === 'done').length;
    $('dlmsg').textContent = live ? `Saving ${plural(live, 'track')}…` : bad ? `${plural(bad, 'track')} failed` : 'Nothing downloading';
    $('dlfolder').textContent = OFF.folder ? `Saved in “${OFF.folder}/Offline” · ${plural(OFF.count, 'track')}` : 'No folder chosen yet - you’ll be asked when you save something.';
    $('dllist').replaceChildren(...list.filter(j => j.state !== 'done').slice(0, 40).map(j => h('div', { class: 'dlrow' + (j.state === 'error' ? ' bad' : '') },
      h('span', { class: 'dn', text: j.track.title }),
      h('span', { class: 'ds', text: j.state === 'error' ? (j.error || 'failed') : j.state === 'queued' ? 'waiting' : j.total ? Math.round(Math.min(100, j.received / j.total * 100)) + '%' : '…' }),
      j.state === 'error' ? null : h('button', { type: 'button', 'aria-label': 'Cancel', text: '×', onclick: () => OFF.cancel(j.track.id) }))));
    if (done && !live) $('dlmsg').textContent += ` · ${done} done`;
    $('dlretry').hidden = !bad;
    $('dlcancel').hidden = !live;
  }

  function setDlPanel(open) {
    mode.panel = open;
    $('dlpanel').hidden = !open;
    $('dlbtn').setAttribute('aria-expanded', String(open));
    if (open) $('dlpanel').style.top = ($('top').getBoundingClientRect().bottom + 6) + 'px';
    paintOffline();
  }

  if (OFF) {
    $('offbtn').addEventListener('click', () => setOffline(!mode.off, '', true));
    $('dlbtn').addEventListener('click', () => setDlPanel(!mode.panel));
    $('dlclose').addEventListener('click', () => setDlPanel(false));
    $('dlcancel').addEventListener('click', () => OFF.cancelAll());
    $('dlretry').addEventListener('click', () => OFF.retryFailed(dlCtx));
    $('dlfolderbtn').addEventListener('click', () => OFF.pickFolder().then(() => paintOffline()).catch(e => toast(e.message, true)));
    OFF.onChange(paintOffline);
  }

  paintControls();
  paintPlay();
  const start = () => { paintOffline(); route(); scanTick(); };
  if (OFF) {
    OFF.init().then(() => { if (APP && !APP.key && OFF.count) mode.off = true; }).catch(() => {}).finally(start);
  } else start();
})();
