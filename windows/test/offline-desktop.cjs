'use strict';
const { app, BrowserWindow, ipcMain, protocol, net, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { OfflineStore } = require('../offline-store');
const root = path.join(__dirname, '..');
const testRoot = path.join(root, 'data', 'offline-integration-' + Date.now());
app.setPath('userData', testRoot);
protocol.registerSchemesAsPrivileged([
  { scheme: 'scray-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'scray-audio', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);
let win, store;
const timeout = setTimeout(() => { console.error('Offline integration timed out'); app.exit(1); }, 45000);
const evaluate = script => win.webContents.executeJavaScript(script, true);
async function until(script) {
  for (let i = 0; i < 150; i++) {
    if (await evaluate(script)) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Timed out: ' + script);
}
function wav() {
  const pcm = Buffer.alloc(8000 * 2 * 8), result = Buffer.alloc(44 + pcm.length);
  result.write('RIFF'); result.writeUInt32LE(36 + pcm.length, 4); result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(8000, 24); result.writeUInt32LE(16000, 28); result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34);
  result.write('data', 36); result.writeUInt32LE(pcm.length, 40); pcm.copy(result, 44); return result;
}
app.whenReady().then(async () => {
  store = new OfflineStore(path.join(testRoot, 'Offline'), {
    fetcher: async url => new Response(url.endsWith('cover') ? await fs.readFile(path.join(root, 'assets', 'app.png')) : wav(), { headers: { 'content-type': url.endsWith('cover') ? 'image/png' : 'audio/wav' } }),
    progress: (...values) => win.webContents.send('offline-progress', ...values),
  });
  await store.init();
  protocol.handle('scray-app', request => {
    const url = new URL(request.url);
    if (url.pathname === '/config.js') return new Response('window.SCRAY_AUDIO_BOOT = {server: "https://example.invalid/audio", deviceName: "Windows PC", lockServer: true};', { headers: { 'Content-Type': 'application/javascript' } });
    return net.fetch(pathToFileURL(path.join(root, 'web', url.pathname.slice(1))).href);
  });
  protocol.handle('scray-audio', request => store.response(request));
  // Every real internet request is blocked throughout this test.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (_details, callback) => callback({ cancel: true }));
  win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', event => { if (event.level >= 3 && !event.message.includes('ERR_BLOCKED_BY_CLIENT')) console.error(event.message); });
  ipcMain.handle('offline', (_event, action, payload) => store.handle(action, payload || {}));
  const states = [];
  ipcMain.on('playback', (_event, state) => states.push(state));
  await win.loadURL('scray-app://library-test/index.html');
  await until('window.ScrayOffline?.ready');
  assert.equal(await evaluate('ScrayOffline.available'), true);
  assert.equal(await evaluate('typeof require'), 'undefined');
  assert.equal(await evaluate('document.getElementById("navback").disabled'), true);
  await evaluate('location.hash = "#/artists"');
  await until('location.hash === "#/artists" && !document.getElementById("navback").disabled');
  await evaluate('location.hash = "#/albums"');
  await until('location.hash === "#/albums" && document.querySelector("#tabs a.on")?.dataset.tab === "albums"');
  await evaluate('document.getElementById("navback").click()');
  await until('location.hash === "#/artists" && !document.getElementById("navforward").disabled');
  await evaluate('document.getElementById("navforward").click()');
  await until('location.hash === "#/albums" && document.getElementById("navforward").disabled');
  await evaluate('history.back()');
  await until('location.hash === "#/artists" && !document.getElementById("navforward").disabled');
  await evaluate('location.hash = "#/genres"');
  await until('location.hash === "#/genres" && document.getElementById("navforward").disabled');
  await win.webContents.reload();
  await until('window.ScrayOffline?.ready && !document.getElementById("navback").disabled');
  await evaluate('document.getElementById("navback").click()');
  await until('location.hash === "#/artists"');
  console.log('PASS: view Back/Forward, native browser history, branching and reload');
  await evaluate(`sessionStorage.setItem('scrayAudio.signInLater', '1'); document.querySelector('.sa-veil')?.remove();
    window.testTrack = {id: 1, path: 'Music/Offline test.wav', folder: 'Music', title: 'Offline test', artist: 'Test artist', albumArtist: 'Test artist', album: 'Test album', genre: 'Test', no: 1, disc: 1, ms: 8000, cover: true};
    ScrayOffline.download([testTrack, {...testTrack, id: 2, title: 'Next test', path: 'Music/Second test.wav', no: 2}], {getUrl: async () => 'https://example.invalid/media', getCoverUrl: async () => 'https://example.invalid/cover'});`);
  await until('ScrayOffline.jobs().length === 2 && ScrayOffline.jobs().every(j => j.state === "done")');
  assert.equal((await store.offlineFiles()).length, 2);
  assert.equal(JSON.parse(await store.manifestRead()).tracks.find(t => t.id === 1).title, 'Offline test');
  await win.loadURL('scray-app://library-test/index.html#/f/Music');
  await until('window.ScrayOffline?.ready && document.querySelector(".trk")');
  assert.equal(await evaluate('ScrayOffline.count'), 2);
  assert.equal(await evaluate('ScrayOffline.local("search", {q: "Offline test"}).tracks.length'), 1);
  assert.equal(await evaluate('document.getElementById("offbtn").getAttribute("aria-pressed")'), 'true');
  await evaluate('document.querySelector(".trk").click()');
  await until('document.getElementById("bplay").textContent.includes("⏸")');
  assert.equal(await evaluate('document.getElementById("nptitle").textContent'), 'Offline test');
  await until('document.getElementById("playbackmode").textContent === "Gapless ready"');
  await until('document.querySelector("#npcover img")?.naturalWidth > 0');
  await evaluate('document.getElementById("seek").value = 500; document.getElementById("seek").dispatchEvent(new Event("input")); document.getElementById("seek").dispatchEvent(new Event("change"));');
  await until('document.getElementById("tcur").textContent === "0:04"');
  await evaluate('document.getElementById("seek").value = 990; document.getElementById("seek").dispatchEvent(new Event("change"));');
  await until('document.getElementById("nptitle").textContent === "Next test"');
  assert.equal(await evaluate('document.getElementById("bplay").textContent.includes("⏸")'), true);
  win.webContents.send('transport', 'toggle');
  await until('document.getElementById("bplay").textContent.includes("▶")');
  assert.ok(states.some(s => s.playing && s.ready));
  await evaluate('ScrayOffline.remove(ScrayOffline.all())');
  await new Promise(resolve => setTimeout(resolve, 600));
  await win.loadURL('scray-app://library-test/index.html');
  await until('window.ScrayOffline?.ready');
  assert.equal(await evaluate('ScrayOffline.count'), 0);
  assert.deepEqual(await store.offlineFiles(), []);
  console.log('PASS: offline download, artwork, index, reload, search, real gapless queue advance, seeking, desktop pause and removal with internet blocked');
  clearTimeout(timeout); win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
