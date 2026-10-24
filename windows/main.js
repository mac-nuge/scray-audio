'use strict';
const { app, BrowserWindow, Menu, ipcMain, nativeImage, shell, dialog, session, protocol, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { libraryUrl, isPlayerPage } = require('./policy');
const { OfflineStore, libraryId } = require('./offline-store');

protocol.registerSchemesAsPrivileged([
  { scheme: 'scray-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'scray-audio', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const home = app.isPackaged ? path.dirname(process.execPath) : __dirname;
const data = path.join(home, 'data');
try { fs.mkdirSync(data, { recursive: true }); }
catch {
  dialog.showErrorBox('Scray Audio needs a writable folder', 'Move the whole app folder somewhere you can write, such as Documents, then launch it again.');
  app.exit(1);
}
app.setPath('userData', data);
app.setPath('sessionData', path.join(data, 'browser'));
app.setAppUserModelId('com.scray.audio.windows');
const configFile = path.join(data, 'settings.json');
const setup = pathToFileURL(path.join(__dirname, 'setup.html')).href;
let config = {};
try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); config.server = libraryUrl(config.server); }
catch { config = {}; }
let win, store, playerURL;
const save = () => fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
const trusted = event => win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
const inSetup = event => trusted(event) && event.senderFrame.url === setup;
const isPlayer = value => isPlayerPage(value, playerURL);
const icon = name => nativeImage.createFromPath(path.join(__dirname, 'assets', name + '.png'));

function toolbar(state = {}) {
  if (!win || win.isDestroyed()) return;
  const button = (command, tooltip, name) => ({
    tooltip, icon: icon(name), flags: state.ready ? [] : ['disabled'],
    click: () => { if (isPlayer(win.webContents.getURL())) win.webContents.send('transport', command); },
  });
  win.setThumbarButtons([
    button('previous', 'Previous track', 'previous'),
    button('toggle', state.playing ? 'Pause' : 'Play', state.playing ? 'pause' : 'play'),
    button('next', 'Next track', 'next'),
  ]);
  win.setThumbnailToolTip(state.title || 'Scray Audio');
}

async function openLibrary() {
  toolbar();
  store?.cancelAll();
  if (store) await Promise.all(store.destinations.values());
  await store?.writes;
  const id = libraryId(config.server);
  playerURL = `scray-app://library-${id}/index.html`;
  const nextStore = new OfflineStore(path.join(home, 'Offline', id), {
    fetcher: (url, options) => net.fetch(url, options),
    progress: (key, received, total) => {
      if (store === nextStore && win && !win.isDestroyed() && isPlayer(win.webContents.getURL())) win.webContents.send('offline-progress', key, received, total);
    },
  });
  await nextStore.init();
  store = nextStore;
  await win.loadURL(playerURL);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(() => {
    const webFiles = new Set(['index.html', 'audio.js', 'audio.css', 'app.js', 'offline.js', 'navigation.js', 'gapless.js']);
    protocol.handle('scray-app', request => {
      const url = new URL(request.url);
      if (!playerURL || url.host !== new URL(playerURL).host || request.method !== 'GET') return new Response(null, { status: 403 });
      if (url.pathname === '/config.js') return new Response(`window.SCRAY_AUDIO_BOOT = ${JSON.stringify({
        server: config.server.replace(/\/$/, ''), version: require('./package.json').version,
        deviceName: 'Windows PC', appName: 'Scray Audio Windows', lockServer: true,
      })};`, { headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' } });
      const name = url.pathname.slice(1);
      if (!webFiles.has(name)) return new Response(null, { status: 404 });
      return net.fetch(pathToFileURL(path.join(__dirname, 'web', name)).href);
    });
    protocol.handle('scray-audio', request => store ? store.response(request) : new Response(null, { status: 404 }));
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    win = new BrowserWindow({
      width: 1200, height: 820, minWidth: 400, minHeight: 400,
      title: 'Scray Audio', icon: icon('app'), backgroundColor: '#0d0f12',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    const external = url => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); };
    win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
    const navigation = (event, url) => {
      if (url === setup || isPlayer(url)) return;
      event.preventDefault(); external(url);
    };
    win.webContents.on('will-navigate', navigation);
    win.webContents.on('will-redirect', navigation);
    win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) toolbar(); });
    win.once('ready-to-show', () => toolbar());
    win.on('close', () => store?.cancelAll());
    ipcMain.handle('settings', event => inSetup(event) ? config.server || 'https://macnguyen.com/audio/' : '');
    ipcMain.handle('configure', async (event, value) => {
      if (!inSetup(event)) return 'Unavailable';
      try { config.server = libraryUrl(value).replace(/index\.php$/, ''); save(); await openLibrary(); return ''; }
      catch (error) { return error.message; }
    });
    ipcMain.on('playback', (event, state) => {
      if (!trusted(event) || !isPlayer(event.senderFrame.url) || !state || typeof state !== 'object') return;
      toolbar({ playing: state.playing === true, ready: state.ready === true, title: typeof state.title === 'string' ? state.title.slice(0, 200) : '' });
    });
    ipcMain.handle('offline', (event, action, payload) => {
      if (!trusted(event) || !isPlayer(event.senderFrame.url) || !store) throw new Error('Offline access is only available to the bundled player');
      return store.handle(action, payload || {});
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'App', submenu: [
        { label: 'Open library', click: () => config.server ? openLibrary().catch(showError) : win.loadURL(setup) },
        { label: 'Change library address…', click: () => { store?.cancelAll(); win.loadURL(setup); } },
        { label: 'Open offline files folder', click: () => { if (store) shell.openPath(store.root); } },
        { type: 'separator' }, { role: 'quit' },
      ] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    ]));
    if (config.server) openLibrary().catch(showError); else win.loadURL(setup);
  }).catch(showError);
  app.on('window-all-closed', () => app.quit());
}
function showError(error) { dialog.showErrorBox('Scray Audio', error.message || String(error)); }
