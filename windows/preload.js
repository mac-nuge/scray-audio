'use strict';
const { ipcRenderer, contextBridge } = require('electron');

// Only the locally bundled player gets the narrow offline interface.
if (location.protocol === 'scray-app:' && location.pathname === '/index.html') {
  const allowed = new Set(['state', 'pickFolder', 'manifestRead', 'manifestWrite', 'offlineFiles', 'storage', 'download', 'cancel', 'remove']);
  contextBridge.exposeInMainWorld('ScrayDesktop', {
    call: (action, payload) => {
      if (!allowed.has(action)) return Promise.reject(new Error('Unknown offline action'));
      return ipcRenderer.invoke('offline', action, payload);
    },
    onProgress: callback => {
      if (typeof callback !== 'function') return;
      const listener = (_event, key, received, total) => callback(key, received, total);
      ipcRenderer.on('offline-progress', listener);
      return () => ipcRenderer.removeListener('offline-progress', listener);
    },
  });
}

// This isolated preload exposes no Node or generic IPC API to web content.
window.addEventListener('DOMContentLoaded', () => {
  if (location.protocol === 'file:' && location.pathname.endsWith('/setup.html')) {
    const form = document.querySelector('form');
    ipcRenderer.invoke('settings').then(value => { form.elements.server.value = value; });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const error = await ipcRenderer.invoke('configure', form.elements.server.value);
      document.getElementById('error').textContent = error || '';
    });
    return;
  }
  const play = document.getElementById('bplay');
  const current = document.getElementById('nplike');
  const buttons = { previous: 'bprev', toggle: 'bplay', next: 'bnext' };
  if (!play || !current) return;
  ipcRenderer.on('transport', (_event, command) => {
    if (Object.hasOwn(buttons, command)) document.getElementById(buttons[command])?.click();
  });
  const publish = () => ipcRenderer.send('playback', {
    playing: play.textContent.includes('⏸'),
    ready: !current.hidden,
    title: document.title.slice(0, 200),
  });
  new MutationObserver(publish).observe(play, { childList: true, subtree: true, characterData: true });
  new MutationObserver(publish).observe(current, { attributes: true, attributeFilter: ['hidden', 'data-like'] });
  new MutationObserver(publish).observe(document.querySelector('title'), { childList: true, subtree: true, characterData: true });
  publish();
});
