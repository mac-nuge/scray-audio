/* Scray audio :: the iOS app's setup. Does nothing in a browser tab.
 *
 * The app's page is bundled and opened from the phone (file://), so it needs to be told where the
 * library lives and to sign in. It signs in the way Scray Native does (scray-device-key.js): the password
 * first, then - only if the server asks - the code from the authenticator app (or a recovery code), both
 * sent to Scray's api.php (device_pair). That hands back a key for this phone only, kept here and sent as
 * X-Scray-Key. Signing this phone out on twofactor.php stops it. The sheet's styles are in audio.css (.sa-*). */
(function () {
  'use strict';
  const boot = window.SCRAY_AUDIO_BOOT;           // set by config.js, which only the app has
  if (!boot) return;

  const LS = { key: 'scrayAudio.deviceKey', server: 'scrayAudio.server', name: 'scrayAudio.deviceName' };
  const SS_LATER = 'scrayAudio.signInLater';
  const KEY_RE = /^sd_[0-9a-f]{64}$/;
  const get = k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const set = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { /* fine */ } };
  const sget = k => { try { return sessionStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const sset = (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) { /* fine */ } };
  const base = s => String(s || '').trim().replace(/\/(api\.php)?\/?$/, '').replace(/\/$/, '');

  const A = window.SCRAY_AUDIO = {
    app: true,
    get server() { return base(boot.lockServer ? boot.server : get(LS.server) || boot.server); },
    get api() { return A.server + '/api.php'; },
    get key() { const k = get(LS.key); return KEY_RE.test(k) ? k : ''; },
    get name() { return get(LS.name); },
    sheet: null,
  };

  const pairUrl = () => new URL(A.server).origin + '/scray/api.php';

  /** Forget this phone's key - on the server too when it can be reached - then reload. */
  A.signOut = function () {
    const k = A.key;
    const done = () => { set(LS.key, ''); location.reload(); };
    if (!k) { done(); return; }
    fetch(pairUrl() + '?action=device_signout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Scray-Key': k }, body: '{}', cache: 'no-store' })
      .then(done, done);
  };

  function el(tag, attrs, text) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (text) e.textContent = text;
    return e;
  }

  /** The sign-in sheet. `why` is a line saying why it is asking. */
  A.signIn = function (why) {
    if (A.sheet) return;
    const veil = el('div', { class: 'sa-veil', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Sign in this phone' });
    const card = el('form', { class: 'sa-card', autocomplete: 'on' });
    const pw = el('input', { type: 'password', name: 'password', placeholder: 'Password', autocomplete: 'current-password' });
    const codeWrap = el('div', { class: 'sa-step', hidden: '' });
    const code = el('input', { type: 'text', name: 'code', class: 'sa-code', placeholder: '123456', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '16', autocapitalize: 'characters', spellcheck: 'false' });
    const alt = el('button', { type: 'button', class: 'sa-link' }, 'Use a recovery code instead');
    codeWrap.append(el('label', {}, 'Code from your authenticator app'), code, alt);
    const name = el('input', { type: 'text', name: 'name', maxlength: '60', autocomplete: 'off' });
    name.value = get(LS.name) || boot.deviceName || 'iPhone';
    const server = el('input', { type: 'url', placeholder: 'https://macnguyen.com/audio', autocapitalize: 'none', spellcheck: 'false' });
    server.value = A.server;
    const serverWrap = el('div', { class: 'sa-step', hidden: '' });
    serverWrap.append(el('label', {}, 'Library address'), server);
    const where = el('button', { type: 'button', class: 'sa-link' }, '');
    const paintWhere = () => { where.textContent = 'Library: ' + (A.server.replace(/^https?:\/\//, '') || 'not set') + ' · change'; };
    paintWhere();
    if (boot.lockServer) where.hidden = true;
    const err = el('div', { class: 'sa-err', 'aria-live': 'polite' });
    const later = el('button', { type: 'button', class: 'sa-later' }, 'Later');
    const go = el('button', { type: 'submit', class: 'sa-go' }, 'Sign in');
    const row = el('div', { class: 'sa-row' });
    row.append(later, go);
    card.append(el('h3', {}, 'Sign in this phone'),
      el('p', {}, why || 'Sign in to reach the library. Downloaded music plays without it.'),
      pw, codeWrap, el('label', {}, 'Name for this phone'), name, serverWrap, where, err, row);
    veil.append(card);
    document.body.append(veil);
    A.sheet = veil;
    const close = () => { veil.remove(); A.sheet = null; };
    // No library address yet: show the box straight away.
    if (!A.server) { serverWrap.hidden = false; where.hidden = true; }

    let busy = false;
    async function submit() {
      if (busy) return;
      if (!pw.value) { err.textContent = 'Type the password.'; pw.focus(); return; }
      try { new URL(server.value.trim()); } catch (x) { serverWrap.hidden = false; where.hidden = true; err.textContent = 'The library address should look like https://macnguyen.com/audio'; server.focus(); return; }
      busy = true; go.disabled = true; err.textContent = ''; err.className = 'sa-err';
      try {
        const r = await fetch(new URL(server.value.trim()).origin + '/scray/api.php?action=device_pair', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
          body: JSON.stringify({ password: pw.value, code: code.value.trim(), name: name.value.trim(), app: boot.appName || 'BBW Sounds' }),
        });
        const j = await r.json().catch(() => ({}));
        busy = false; go.disabled = false;
        if (r.status === 429 && j.retry_ms) { setTimeout(submit, j.retry_ms); return; }
        if (j.ok && KEY_RE.test(j.key || '')) {
          set(LS.key, j.key); set(LS.server, base(server.value)); set(LS.name, (j.device && j.device.name) || name.value.trim());
          err.className = 'sa-err sa-ok'; err.textContent = 'Signed in. Reloading…';
          setTimeout(() => location.reload(), 500);
          return;
        }
        if (j.need_code) {                                   // password was right; now the code
          const first = codeWrap.hidden;
          codeWrap.hidden = false;
          if (first) code.value = '';
          code.focus();
          err.textContent = first ? '' : (j.error || '');
          return;
        }
        err.textContent = j.error || `Could not sign in (HTTP ${r.status}).`;
        if (/password/i.test(j.error || '')) pw.select();
      } catch (x) {
        busy = false; go.disabled = false;
        err.textContent = 'Could not reach the server. Check the connection and try again.';
      }
    }
    card.addEventListener('submit', e => { e.preventDefault(); submit(); });
    pw.addEventListener('input', () => { if (!codeWrap.hidden) { codeWrap.hidden = true; code.value = ''; } err.textContent = ''; });
    code.addEventListener('input', () => { err.textContent = ''; if (/^\d{6}$/.test(code.value.replace(/\s+/g, ''))) submit(); });
    alt.addEventListener('click', () => { code.setAttribute('inputmode', 'text'); code.placeholder = 'XXXXX-XXXXX'; code.value = ''; alt.hidden = true; code.focus(); });
    where.addEventListener('click', () => { serverWrap.hidden = false; where.hidden = true; server.focus(); });
    later.addEventListener('click', () => { sset(SS_LATER, '1'); close(); });
    setTimeout(() => pw.focus(), 50);
  };

  // Not signed in: offer the sheet once the page is up (once per app start - "Later" holds it off).
  // The downloads still play.
  if (!A.key && !sget(SS_LATER)) document.addEventListener('DOMContentLoaded', () => setTimeout(() => {
    if (boot.lockServer && (!navigator.onLine || window.ScrayOffline?.count)) return;
    A.signIn();
  }, 600));
})();
