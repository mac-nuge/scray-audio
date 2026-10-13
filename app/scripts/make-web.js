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
const out = path.resolve(__dirname, '..', 'web');
const server = (process.env.AUDIO_SERVER || 'https://macnguyen.com/audio').replace(/\/+$/, '');
const version = (fs.existsSync(path.join(root, 'VERSION')) ? fs.readFileSync(path.join(root, 'VERSION'), 'utf8') : 'unknown').replace(/[\r\n]+/g, '').trim();

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

let html = fs.readFileSync(path.join(root, 'index.php'), 'utf8');
const body = html.indexOf('?>');
if (body < 0) { console.error('make-web: no ?> in index.php'); process.exit(1); }
html = html.slice(body + 2).replace(/^\s*\n/, '');
html = html.replace(/<\?=\s*\$v\('[^']*'\)\s*\?>/g, 'app');                          // ?v=app
html = html.replace(/<script src="\/scray\/[^"]*"><\/script>\s*/g, '');              // site-only scripts
html = html.replace('<script src="app.js', '<script src="config.js"></script>\n<script src="app.js');
html = html.replace('<title>Scray audio</title>', '<title>BBW Sounds</title>')
  .replace('scray<b>audio</b>', 'BBW <b>Sounds</b>');                                // the app's own name
if (/<\?/.test(html)) { console.error('make-web: PHP left in the page'); process.exit(1); }
if (!html.includes('config.js')) { console.error('make-web: could not place config.js'); process.exit(1); }

fs.writeFileSync(path.join(out, 'index.html'), html);
for (const f of ['audio.js', 'audio.css', 'offline.js', 'app.js']) fs.copyFileSync(path.join(root, f), path.join(out, f));
fs.writeFileSync(path.join(out, 'config.js'),
  `// Made by scripts/make-web.js - do not edit.\nwindow.SCRAY_AUDIO_BOOT = ${JSON.stringify({ server, version })};\n`);
console.log(`make-web: ${fs.readdirSync(out).join(', ')} (${version}, library ${server})`);
