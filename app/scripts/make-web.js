#!/usr/bin/env node
// Makes app/web/ - the page the iOS app bundles - from the page in the repo root.
//
//   node scripts/make-web.js            (run from app/)
//
// index.php is the site's page: it checks the login and fills in cache-busting numbers. The app has no login
// to check (it signs in with a phone key, app.js), so this takes the HTML after the PHP, fills those numbers
// in, drops the two script tags that only exist on the site, and adds config.js (where the library is).
//
// AUDIO_SERVER sets the default library address (the sign-in sheet shows it and it can be changed there).
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const desktop = process.argv.includes('--windows');
const out = desktop ? path.join(root, 'windows', 'web') : path.resolve(__dirname, '..', 'web');
const server = (process.env.AUDIO_SERVER || 'https://macnguyen.com/audio').replace(/\/+$/, '');
const version = (fs.existsSync(path.join(root, 'VERSION')) ? fs.readFileSync(path.join(root, 'VERSION'), 'utf8') : 'unknown').replace(/[\r\n]+/g, '').trim();

// Only these two fixed, generated directories may be replaced.
if (![path.join(root, 'app', 'web'), path.join(root, 'windows', 'web')].includes(out)) throw new Error('Unexpected output path');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

let html = fs.readFileSync(path.join(root, 'index.php'), 'utf8');
const body = html.indexOf('?>');
if (body < 0) { console.error('make-web: no ?> in index.php'); process.exit(1); }
html = html.slice(body + 2).replace(/^\s*\n/, '');
html = html.replace(/<\?=\s*\$v\('[^']*'\)\s*\?>/g, 'app');                          // ?v=app
html = html.replace(/<script src="\/scray\/[^"]*"><\/script>\s*/g, '');              // site-only scripts
html = html.replace('<script src="app.js', '<script src="config.js"></script>\n<script src="app.js');
if (!desktop) html = html.replace('<title>Scray audio</title>', '<title>BBW Sounds</title>')
  .replace('scray<b>audio</b>', 'BBW <b>Sounds</b>');
if (desktop) {
  html = html.replace(/\bphone\b/g, 'computer');
  html = html.replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob: scray-audio:; media-src https: data: blob: scray-audio:; connect-src 'self' https: scray-audio:; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'">`);
}
if (/<\?/.test(html)) { console.error('make-web: PHP left in the page'); process.exit(1); }
if (!html.includes('config.js')) { console.error('make-web: could not place config.js'); process.exit(1); }

fs.writeFileSync(path.join(out, 'index.html'), html);
for (const f of ['audio.js', 'audio.css', 'offline.js', 'app.js', 'navigation.js', 'gapless.js']) {
  let content = fs.readFileSync(path.join(root, f), 'utf8');
  if (desktop) content = content.replace(/\bphone\b/g, 'computer');
  fs.writeFileSync(path.join(out, f), content);
}
fs.writeFileSync(path.join(out, 'config.js'),
  `// Made by scripts/make-web.js - do not edit.\nwindow.SCRAY_AUDIO_BOOT = ${JSON.stringify({ server, version })};\n`);
console.log(`make-web: ${fs.readdirSync(out).join(', ')} (${version}, library ${server})`);
