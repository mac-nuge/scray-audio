'use strict';
// Launch the real packaged app, verify its setup UI, and close it again.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const exe = path.join(root, 'dist', 'Scray-Audio-win32-x64', 'Scray-Audio.exe');
async function run() {
  const runRoot = fs.mkdtempSync(path.join(root, 'dist', 'smoke-app-'));
  const source = path.dirname(exe);
  fs.cpSync(source, runRoot, { recursive: true, filter: file => !['data', 'Offline'].some(name => file === path.join(source, name)) });
  const child = spawn(path.join(runRoot, 'Scray-Audio.exe'), ['--remote-debugging-port=19371'], { windowsHide: true, stdio: 'pipe' });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  let socket;
  try {
    let pages;
    for (let i = 0; i < 100; i++) {
      try { pages = await (await fetch('http://127.0.0.1:19371/json/list')).json(); if (pages.some(p => p.type === 'page')) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const page = pages?.find(p => p.type === 'page');
    assert.ok(page, 'Packaged app did not open a window: ' + stderr);
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    const calls = new Map();
    socket.onmessage = event => { const result = JSON.parse(event.data); if (calls.has(result.id)) { calls.get(result.id)(result); calls.delete(result.id); } };
    const send = (method, params = {}) => new Promise(resolve => { calls.set(++id, resolve); socket.send(JSON.stringify({ id, method, params })); });
    await send('Runtime.evaluate', { expression: "new Promise(resolve => { let n = 0; const timer = setInterval(() => { if (document.querySelector('input')?.value || n++ > 50) { clearInterval(timer); resolve(); } }, 100); })", awaitPromise: true });
    const result = await send('Runtime.evaluate', { expression: "JSON.stringify({title: document.title, heading: document.querySelector('h1')?.textContent, node: typeof require, value: document.querySelector('input')?.value})", returnByValue: true });
    const state = JSON.parse(result.result.result.value);
    assert.equal(state.heading, 'Scray Audio');
    assert.equal(state.node, 'undefined');
    assert.equal(state.value, 'https://macnguyen.com/audio/', stderr || 'Setup preload did not populate the library address');
    const screenshot = await send('Page.captureScreenshot');
    fs.writeFileSync(path.join(root, 'dist', 'setup-preview.png'), Buffer.from(screenshot.result.data, 'base64'));
    console.log('PASS: packaged executable opens setup with isolated renderer and configured default');
    await send('Network.enable');
    await send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
    await send('Runtime.evaluate', { expression: "document.querySelector('input').value = 'https://example.invalid/audio/'; document.querySelector('form').requestSubmit();" });
    let offlineState;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await send('Runtime.evaluate', { expression: "JSON.stringify({local: location.protocol, available: window.ScrayOffline?.available, ready: window.ScrayOffline?.ready, node: typeof require})", returnByValue: true });
      try { offlineState = JSON.parse(result.result.result.value); } catch {}
      if (offlineState?.ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(offlineState?.local, 'scray-app:');
    assert.equal(offlineState?.available, true);
    assert.equal(offlineState?.ready, true);
    assert.equal(offlineState?.node, 'undefined');
    await send('Runtime.evaluate', { expression: "new Promise(resolve => setTimeout(resolve, 800))", awaitPromise: true });
    await send('Runtime.evaluate', { expression: "sessionStorage.setItem('scrayAudio.signInLater', '1'); document.querySelector('.sa-veil')?.remove();" });
    const offlineScreenshot = await send('Page.captureScreenshot');
    fs.writeFileSync(path.join(root, 'dist', 'offline-preview.png'), Buffer.from(offlineScreenshot.result.data, 'base64'));
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const nav = await send('Runtime.evaluate', { expression: "JSON.stringify(['navback', 'navforward'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return {left:r.left, right:r.right, top:r.top, bottom:r.bottom}; }))", returnByValue: true });
    for (const bounds of JSON.parse(nav.result.result.value)) assert.ok(bounds.left >= 0 && bounds.right <= 390 && bounds.top >= 0 && bounds.bottom < 844);
    const mobileScreenshot = await send('Page.captureScreenshot');
    fs.writeFileSync(path.join(root, 'dist', 'mobile-preview.png'), Buffer.from(mobileScreenshot.result.data, 'base64'));
    console.log('PASS: packaged app loads its bundled player and native offline store with internet blocked');
    await send('Runtime.evaluate', { expression: 'window.close()' });
    if (child.exitCode === null) await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
  } finally {
    socket?.close();
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill(); await exited;
    }
    if (path.dirname(runRoot) !== path.join(root, 'dist') || !path.basename(runRoot).startsWith('smoke-app-')) throw new Error('Unexpected smoke cleanup path');
    fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
