'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
app.setPath('userData', path.join(__dirname, '..', 'data', 'gapless-test'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL('about:blank');
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '..', '..', 'gapless.js'), 'utf8'));
  const result = await win.webContents.executeJavaScript(`(async () => {
    async function render(action) {
      const context = new OfflineAudioContext(1, 9600, 48000);
      const a = context.createBuffer(1, 4800, 48000), b = context.createBuffer(1, 4800, 48000);
      a.getChannelData(0).fill(.25); b.getChannelData(0).fill(.5);
      const player = new ScrayGaplessPlayer();
      player.context = context; player.gain = context.createGain(); player.gain.connect(context.destination);
      player.current = { buffer: a, url: 'a', offset: 0, start: 0, node: null };
      player._paused = false;
      player.startNode(player.current, 0);
      player.prepared = {buffer: b, url: 'b', token: {index: 1}};
      player.schedule();
      if (action === 'cancel') player.cancelNext();
      if (action === 'seek') player.currentTime = .05;
      const output = (await context.startRendering()).getChannelData(0);
      return {before: output[action === 'seek' ? 2399 : 4799], after: output[action === 'seek' ? 2400 : 4800], zeros: Array.from(output).filter(v => v === 0).length};
    }
    return {normal: await render('normal'), cancelled: await render('cancel'), seek: await render('seek')};
  })()`);
  assert.equal(result.normal.before, .25);
  assert.equal(result.normal.after, .5);
  assert.equal(result.normal.zeros, 0, 'The rendered transition must contain no inserted silence');
  assert.equal(result.cancelled.after, 0, 'Cancelled next track must not play');
  assert.equal(result.seek.before, .25);
  assert.equal(result.seek.after, .5, 'Seeking must reschedule the next track at the new endpoint');
  console.log('PASS: real rendered audio joins at the exact sample with no silence, cancellation prevents stale audio, seeking reschedules the join');
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
