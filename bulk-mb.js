/* Scray audio :: bulk MusicBrainz (bulk-mb.php).
 *
 * The run lives on the server (api.php mb_bulk_*): the gateway takes a step every poll, one album at a time. When the
 * gateway hasn't taken one for a while (not updated yet, or offline) and this tab is open, the tab takes the steps
 * itself, so a run still moves. This page shows the progress, the results, and the albums set aside for you. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const enc = encodeURIComponent;
  const S = { view: 'all', q: '', rows: [], total: 0, sel: null, status: null, driving: false, offset: 0 };
  const STATE_NAME = { matched: 'matched', review: 'to review', none: 'not found', skipped: 'skipped', error: 'error', pending: 'waiting', working: 'looking…', undone: 'undone' };
  const GATEWAY_GRACE = 90;               // seconds without a gateway step before this tab takes over

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }
  let toastT = 0;
  function toast(msg, bad) {
    const t = $('toast');
    t.textContent = msg; t.className = 'toast on' + (bad ? ' bad' : '');
    clearTimeout(toastT); toastT = setTimeout(() => { t.className = 'toast'; }, bad ? 6000 : 3000);
  }
  async function api(action, params) {
    const r = await fetch(`api.php?${new URLSearchParams({ action, ...(params || {}) })}`, { credentials: 'same-origin', cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || `server answered ${r.status}`);
    return j;
  }
  async function post(action, body) {
    const r = await fetch(`api.php?action=${action}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || `server answered ${r.status}`);
    return j;
  }
  const n0 = x => (x || 0).toLocaleString();
  const clock = s => { s = Math.max(0, Math.round(s || 0)); const hh = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return hh ? `${hh} h ${m} min` : m ? `${m} min` : `${s} s`; };
  const ago = iso => iso ? clock((Date.now() - Date.parse(iso)) / 1000) + ' ago' : '';

  // ------------------------------------------------------------ status
  function paintStatus(s) {
    S.status = s;
    const c = s.counts || {}, rc = s.run_counts || {}, run = s.run;
    const all = Object.values(c).reduce((a, b) => a + b, 0);
    const tile = (v, label, cls, view) => h('div', { class: 'tile ' + (cls || ''), title: view ? 'Show these' : null, onclick: view ? () => setView(view) : null }, h('b', { text: n0(v) }), h('span', { text: label }));
    $('tiles').replaceChildren(
      tile(all, 'ALBUMS', '', 'all'), tile(c.matched, 'MATCHED', 'good', 'matched'), tile(c.review, 'TO REVIEW', '', 'review'),
      tile(c.none, 'NOT FOUND', 'soft', 'none'), tile(c.skipped, 'SKIPPED', 'mark', 'skipped'), tile(c.error, 'ERRORS', 'bad', 'error'),
      tile((c.pending || 0) + (c.working || 0), 'WAITING', 'soft', 'pending'), tile(s.no_album, 'NO ALBUM TAG', 'soft'));
    const st = run ? run.state : 'none';
    const gwRecent = run && run.last_step_by === 'gateway' && s.step_age != null && s.step_age < GATEWAY_GRACE;
    const mode = $('mode');
    mode.className = 'mode' + (st === 'running' ? ' live' : '');
    mode.textContent = st === 'running' ? (gwRecent ? 'RUNNING ON THE GATEWAY' : S.driving ? 'RUNNING IN THIS TAB' : 'RUNNING') :
      st === 'paused' ? 'PAUSED' : st === 'done' ? 'DONE' : st === 'stopped' ? 'STOPPED' : 'IDLE';
    $('startBtn').disabled = st === 'running';
    $('pauseBtn').disabled = !(st === 'running' || st === 'paused');
    $('pauseBtn').textContent = st === 'paused' ? 'Resume' : 'Pause';
    $('stopBtn').disabled = !(st === 'running' || st === 'paused');
    const total = run ? run.total : 0, left = (rc.pending || 0) + (rc.working || 0), done = Math.max(0, total - left);
    $('progress').classList.toggle('on', !!run && total > 0);
    $('fill').style.width = total ? (done / total * 100).toFixed(1) + '%' : '0';
    const eta = $('eta');
    eta.classList.toggle('on', !!run);
    if (run) {
      const opts = run.opts || {};
      const cell = (v, label, cls) => h('div', { class: cls || '' }, h('b', { text: v }), h('span', { text: label }));
      eta.replaceChildren(
        cell(`${n0(done)} / ${n0(total)}`, 'THIS RUN'),
        cell(`${n0(rc.matched)} · ${n0(rc.review)} · ${n0(rc.none)}`, 'MATCHED · TO REVIEW · NOT FOUND'),
        cell(s.rate ? `${s.rate}/min` : '—', 'RATE'),
        cell(st === 'running' && s.eta != null ? clock(s.eta) : '—', 'TIME LEFT'),
        cell(run.started_at ? clock(((run.finished_at ? Date.parse(run.finished_at) : Date.now()) - Date.parse(run.started_at)) / 1000) : '—', 'ELAPSED'),
        cell(s.current ? `${s.current.album}  ·  ${s.current.folder}` : '—', 'NOW'));
      $('meta').replaceChildren(`run ${run.id} · ${opts.mode === 'best' ? 'best match' : 'original release'}${opts.write ? ' · writing to files' : ''} · `,
        st === 'running' && !gwRecent && !S.driving ? h('span', { class: 'err', text: 'waiting for the gateway…' }) :
          h('span', { class: st === 'done' ? 'ok' : '', text: st === 'running' ? (run.last_step_at ? 'last step ' + ago(run.last_step_at) : 'starting') : st }));
    } else {
      $('meta').textContent = s.gateway && s.gateway.online ? 'idle · the gateway is online' : 'idle';
    }
    maybeDrive(s);
  }
  async function refreshStatus() {
    try { paintStatus(await api('mb_bulk_status')); } catch (e) { $('meta').replaceChildren(h('span', { class: 'err', text: e.message })); }
  }

  // The tab takes steps when the gateway hasn't for a while.
  function maybeDrive(s) {
    const run = s.run;
    const quiet = s.step_age == null || s.step_age > GATEWAY_GRACE || (run && run.last_step_by === 'page');
    if (!run || run.state !== 'running' || !quiet || S.driving) return;
    S.driving = true;
    (async () => {
      try {
        while (S.driving) {
          const j = await post('mb_bulk_step', {});
          if (j.idle) break;
          if (j.busy) await new Promise(r => setTimeout(r, 5000));
          const st = await api('mb_bulk_status');
          paintStatus(st);
          if (st.run && st.run.last_step_by === 'gateway' && st.step_age != null && st.step_age < 5) break;   // the gateway is back
          if (!S.view || S.offset === 0) loadRows(true);
        }
      } catch (e) { toast(e.message, true); }
      S.driving = false;
      refreshStatus(); loadRows(true);
    })();
  }

  // ------------------------------------------------------------ the list
  function setView(v) {
    S.view = v; S.offset = 0;
    document.querySelectorAll('#seg button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    loadRows();
  }
  async function loadRows(quiet) {
    try {
      const j = await api('mb_bulk_list', { state: S.view, q: S.q, offset: 0 });
      if (S.offset > 0 && quiet) return;                     // you are reading further down: leave it
      S.rows = j.rows; S.total = j.total; S.offset = 0;
      paintRows();
      if (S.sel) { const r = S.rows.find(x => x.id === S.sel.id); if (r && quiet && JSON.stringify(r) !== JSON.stringify(S.sel)) openDrawer(r); }
    } catch (e) { if (!quiet) toast(e.message, true); }
  }
  async function loadMore() {
    try {
      const j = await api('mb_bulk_list', { state: S.view, q: S.q, offset: S.rows.length });
      S.rows = S.rows.concat(j.rows); S.offset = S.rows.length; paintRows();
    } catch (e) { toast(e.message, true); }
  }
  function result(r) {
    if (r.state === 'matched' || r.state === 'undone') {
      return h('span', {}, h('b', { text: r.release_title || '' }), r.release_artist ? ` · ${r.release_artist}` : '', r.release_year ? ` · ${r.release_year}` : '',
        r.has_cover ? ' · cover' : '', r.reason ? ` - ${r.reason}` : '');
    }
    return r.reason || '';
  }
  function paintRows() {
    const box = $('results');
    $('rowMeta').textContent = S.total ? `${n0(S.rows.length)} of ${n0(S.total)}` : '';
    if (!S.rows.length) { box.replaceChildren(h('div', { class: 'empty', text: S.status && S.status.run ? 'Nothing here.' : 'Start a run: every album is looked up on MusicBrainz, one at a time. It runs on the server, so you can close this tab and come back.' })); return; }
    const y = box.scrollTop;
    const table = h('table', {}, h('thead', {}, h('tr', {}, ['', 'ALBUM', 'ARTIST', 'TRACKS', 'RESULT', 'WHEN'].map(t => h('th', { text: t })))),
      h('tbody', {}, S.rows.map(r => h('tr', { class: S.sel && S.sel.id === r.id ? 'sel' : '', onclick: () => openDrawer(r) },
        h('td', {}, h('span', { class: 'pill ' + r.state, text: STATE_NAME[r.state] || r.state })),
        h('td', { title: r.folder, text: r.album }),
        h('td', { text: r.artist || '—' }),
        h('td', { class: 'num', text: r.tracks }),
        h('td', { class: 'why' }, result(r)),
        h('td', { text: r.updated_at ? ago(r.updated_at) : '' })))));
    box.replaceChildren(...[table, S.rows.length < S.total ? h('button', { class: 'ghost more', type: 'button', text: 'Load more', onclick: loadMore }) : null].filter(Boolean));
    box.scrollTop = y;
  }

  // ------------------------------------------------------------ one album
  function candRow(c, r) {
    return h('div', { class: 'cand' + (c.tracks === r.tracks ? ' fit' : '') },
      h('div', { class: 'ct' }, h('b', { text: c.title }), h('span', { text: c.artist }),
        h('i', { text: [c.date, c.country, c.format, c.tracks ? `${c.tracks} tracks` : '', c.type, c.note, c.score ? `score ${c.score}` : ''].filter(Boolean).join(' · ') })),
      h('a', { href: `https://musicbrainz.org/release/${c.id}`, target: '_blank', rel: 'noopener', text: '↗', title: 'Open on MusicBrainz' }),
      h('button', { class: 'go', type: 'button', text: 'Use this', onclick: e => pick(r, c, e.currentTarget) }));
  }
  async function pick(r, c, btn) {
    btn.disabled = true; btn.textContent = 'Applying…';
    try {
      const j = await post('mb_bulk_pick', { id: r.id, release: c.id, write: $('optWrite').checked });
      toast(`“${c.title}” applied to ${j.tracks} tracks${j.cover ? ', with its cover' : ''}`);
      await loadRows(); refreshStatus();
      const nr = S.rows.find(x => x.id === r.id); if (nr) openDrawer(nr); else closeDrawer();
    } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Use this'; }
  }
  async function act(r, action, msg) {
    try { await post(action, { id: r.id }); toast(msg); await loadRows(); refreshStatus(); const nr = S.rows.find(x => x.id === r.id); if (nr) openDrawer(nr); else closeDrawer(); }
    catch (e) { toast(e.message, true); }
  }
  function closeDrawer() { S.sel = null; $('drawer').className = 'drawer'; $('drawer').replaceChildren(); paintRows(); }
  function openDrawer(r) {
    S.sel = r;
    const d = $('drawer');
    d.className = 'drawer on';
    const cands = r.candidates || [];
    const album = h('input', { type: 'text', value: r.album, placeholder: 'Album', 'aria-label': 'Album' });
    const artist = h('input', { type: 'text', value: r.artist || '', placeholder: 'Artist', 'aria-label': 'Artist' });
    const found = h('div');
    const form = h('form', { class: 'srch' }, album, artist, h('button', { class: 'ghost', type: 'submit', text: 'Search' }));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      found.replaceChildren(h('div', { class: 'sub', text: 'Asking MusicBrainz…' }));
      try {
        const j = await api('mb_search', { album: album.value.trim(), artist: artist.value.trim() });
        found.replaceChildren(...(j.releases.length ? j.releases.map(c => candRow(c, r)) : [h('div', { class: 'sub', text: 'Nothing found.' })]));
      } catch (err) { found.replaceChildren(h('div', { class: 'sub', text: err.message })); }
    });
    const btns = h('div', { class: 'dbtns' },
      r.state !== 'skipped' && r.state !== 'matched' ? h('button', { class: 'ghost', type: 'button', text: 'Skip', onclick: () => act(r, 'mb_bulk_skip', 'Skipped') }) : null,
      r.state !== 'pending' && r.state !== 'working' ? h('button', { class: 'ghost', type: 'button', text: 'Try again', title: 'Back in the queue: the next run (or this one, if it is going) looks it up again', onclick: () => act(r, 'mb_bulk_retry', 'Queued again') }) : null,
      r.state === 'matched' ? h('button', { class: 'stop', type: 'button', text: 'Undo', title: 'Take off what MusicBrainz put on (your own edits stay)', onclick: () => act(r, 'mb_bulk_undo', 'Undone') }) : null,
      h('a', { class: 'ghost', href: `index.php#/f/${enc(r.folder)}`, target: '_blank', rel: 'noopener', text: 'Open in the library ↗' }),
      r.release_id ? h('a', { class: 'ghost', href: `https://musicbrainz.org/release/${r.release_id}`, target: '_blank', rel: 'noopener', text: 'Release on MusicBrainz ↗' }) : null);
    d.replaceChildren(...[
      h('button', { class: 'x', type: 'button', 'aria-label': 'Close', text: '×', onclick: closeDrawer }),
      h('h2', { text: r.album }), h('div', { class: 'sub', text: `${r.folder} · ${r.tracks} tracks${r.artist ? ' · ' + r.artist : ''}` }),
      h('div', { class: 'why' }, h('span', { class: 'pill ' + r.state, text: STATE_NAME[r.state] || r.state }), ' ', result(r)),
      btns,
      cands.length ? [h('h3', { text: r.state === 'matched' ? 'OTHER RELEASES IT CONSIDERED' : 'CANDIDATES (GREEN: SAME TRACK COUNT AS YOURS)' }), cands.map(c => candRow(c, r))] : null,
      h('h3', { text: 'SEARCH MUSICBRAINZ' }), form, found].flat(Infinity).filter(Boolean));
    paintRows();
  }

  // ------------------------------------------------------------ controls
  $('startBtn').addEventListener('click', async () => {
    try {
      const j = await post('mb_bulk_start', { mode: $('optMode').value, retry: $('optRetry').checked, redo: $('optRedo').checked, write: $('optWrite').checked });
      toast(j.queued ? `${n0(j.queued)} albums to look up` : 'Nothing new to look up (tick “try again” or “redo” for the rest)');
      refreshStatus(); loadRows(true);
    } catch (e) { toast(e.message, true); }
  });
  $('pauseBtn').addEventListener('click', async () => {
    const st = S.status && S.status.run ? S.status.run.state : '';
    try { await post('mb_bulk_control', { do: st === 'paused' ? 'resume' : 'pause' }); S.driving = false; refreshStatus(); } catch (e) { toast(e.message, true); }
  });
  $('stopBtn').addEventListener('click', async () => {
    if (!confirm('Stop this run? What is done stays done; the rest waits for the next run.')) return;
    try { await post('mb_bulk_control', { do: 'stop' }); S.driving = false; refreshStatus(); } catch (e) { toast(e.message, true); }
  });
  document.querySelectorAll('#seg button').forEach(b => b.addEventListener('click', () => setView(b.dataset.v)));
  let qT = 0;
  $('filter').addEventListener('input', e => { clearTimeout(qT); qT = setTimeout(() => { S.q = e.target.value.trim(); S.offset = 0; loadRows(); }, 250); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.sel) closeDrawer(); });

  // ------------------------------------------------------------ keep up
  refreshStatus(); loadRows();
  (function tick() {
    const running = S.status && S.status.run && S.status.run.state === 'running';
    setTimeout(() => { refreshStatus().then(() => { if (running && !S.driving) loadRows(true); }).finally(tick); }, running ? 2500 : 10000);
  })();
})();
