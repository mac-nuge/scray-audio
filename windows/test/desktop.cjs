'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');
app.setPath('userData', path.join(__dirname, '..', 'data', 'test'));
let win;
const reports = [];
const until = async predicate => {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Timed out waiting for playback update');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  ipcMain.on('playback', (_event, state) => reports.push(state));
  await win.loadFile(path.join(__dirname, 'player.html'));
  await until(() => reports.length);
  assert.equal(reports.at(-1).ready, false);
  await win.webContents.executeJavaScript("document.getElementById('nplike').hidden = false; document.getElementById('bplay').textContent = '⏸'; document.title = 'Track one – Artist';");
  await until(() => reports.at(-1).playing && reports.at(-1).ready && reports.at(-1).title === 'Track one – Artist');
  for (const command of ['previous', 'toggle', 'next', 'invalid']) win.webContents.send('transport', command);
  let commands;
  for (let i = 0; i < 50; i++) {
    commands = await win.webContents.executeJavaScript('window.commands');
    if (commands.length === 3) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.deepEqual(commands, ['bprev', 'bplay', 'bnext']);
  await win.webContents.executeJavaScript("document.getElementById('bplay').textContent = '▶';");
  await until(() => !reports.at(-1).playing);
  assert.equal(await win.webContents.executeJavaScript('typeof require'), 'undefined');
  assert.equal(await win.webContents.executeJavaScript('typeof process'), 'undefined');
  let configured;
  ipcMain.handle('settings', () => 'https://example.com/audio/');
  ipcMain.handle('configure', (_event, value) => { configured = value; return 'Example error'; });
  await win.loadFile(path.join(__dirname, '..', 'setup.html'));
  await win.webContents.executeJavaScript("document.querySelector('input').value = 'https://example.com/staging/'; document.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));");
  await until(() => configured);
  assert.equal(configured, 'https://example.com/staging/');
  console.log('PASS: sandboxed desktop transport, playback state, isolation and setup form');
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
