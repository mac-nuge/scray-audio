/* Scray audio :: the iOS app's setup. Does nothing in a browser tab.
 *
 * The app's page is bundled and opened from the phone (file://), so it needs to be told where the
 * library lives and to sign in. It signs in the way Scray's other apps do: the password and an
 * authenticator code go to Scray's api.php (device_pair), which hands back a key for this phone only.
 * The key is kept here and sent as X-Scray-Key. Signing this phone out on twofactor.php stops it. */
(function () {
  'use strict';
  const boot = window.SCRAY_AUDIO_BOOT;           // set by config.js, which only the app has
  if (!boot) return;

  const LS = { key: 'scrayAudio.deviceKey', server: 'scrayAudio.server', name: 'scrayAudio.deviceName' };
  const KEY_RE = /^sd_[0-9a-f]{64}$/;
  const get = k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const set = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { /* fine */ } };
  const base = s => String(s || '').trim().replace(/\/(api\.php)?\/?$/, '').replace(/\/$/, '');

  const A = window.SCRAY_AUDIO = {
    app: true,
    get server() { return base(get(LS.server) || boot.server); },
    get api() { return A.server + '/api.php'; },
    get key() { const k = get(LS.key); return KEY_RE.test(k) ? k : ''; },
    signOut() { set(LS.key, ''); },
    sheet: null,
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
    const veil = el('div', { class: 'sa-veil', role: 'dialog', 'aria-modal': 'true' });
    const card = el('form', { class: 'sa-card', autocomplete: 'on' });
    const server = el('input', { type: 'url', placeholder: 'https://macnguyen.com/audio', autocapitalize: 'none', spellcheck: 'false' });
    server.value = A.server;
    const pw = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
    const code = el('input', { type: 'text', class: 'sa-code', placeholder: 'Authenticator code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '16' });
    const name = el('input', { type: 'text', maxlength: '60', autocomplete: 'off' });
    name.value = get(LS.name) || 'iPhone';
    const err = el('div', { class: 'sa-err', 'aria-live': 'polite' });
    const later = el('button', { type: 'button', class: 'sa-later' }, 'Later');
    const go = el('button', { type: 'submit', class: 'sa-go' }, 'Sign in');
    card.append(el('h3', {}, 'Sign in this phone'),
      el('p', {}, why || 'Scray audio needs this phone signed in to reach the library. Downloaded music plays without it.'),
      el('label', {}, 'Library address'), server, el('label', {}, 'Password'), pw,
      el('label', {}, 'Code from your authenticator app'), code, el('label', {}, 'Name for this phone'), name, err,
      el('div', { class: 'sa-row' }));
    card.lastChild.append(later, go);
    veil.append(card);
    document.body.append(veil);
    A.sheet = veil;
    const close = () => { veil.remove(); A.sheet = null; };
    later.addEventListener('click', close);
    let busy = false;
    card.addEventListener('submit', async e => {
      e.preventDefault();
      if (busy) return;
      if (!pw.value) { err.textContent = 'Type the password.'; return; }
      let origin;
      try { origin = new URL(server.value.trim()).origin; } catch (x) { err.textContent = 'The library address should look like https://macnguyen.com/audio'; return; }
      busy = true; go.disabled = true; err.textContent = '';
      try {
        const r = await fetch(origin + '/scray/api.php?action=device_pair', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
          body: JSON.stringify({ password: pw.value, code: code.value.trim(), name: name.value.trim(), app: 'BBW Sounds' }),
        });
        const j = await r.json().catch(() => ({}));
        if (j.ok && KEY_RE.test(j.key || '')) {
          set(LS.key, j.key); set(LS.server, base(server.value)); set(LS.name, name.value.trim());
          err.textContent = 'Signed in. Reloading…';
          setTimeout(() => location.reload(), 500);
          return;
        }
        err.textContent = j.error || (j.need_code ? 'Type the code from your authenticator app.' : `Could not sign in (HTTP ${r.status}).`);
      } catch (x) { err.textContent = 'Could not reach the server. Check the connection and try again.'; }
      busy = false; go.disabled = false;
    });
    setTimeout(() => pw.focus(), 50);
  };

  // Not signed in: offer the sheet once the page is up. The downloads still play.
  if (!A.key) document.addEventListener('DOMContentLoaded', () => setTimeout(() => A.signIn(), 600));
})();
