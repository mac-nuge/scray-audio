'use strict';
// Draw simple transport symbols directly; no image library or downloaded assets.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const dir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(dir, { recursive: true });
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const body = Buffer.concat([Buffer.from(type), bytes]);
  const head = Buffer.alloc(4), tail = Buffer.alloc(4);
  head.writeUInt32BE(bytes.length); tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const color = pixel(x / size, y / size);
    for (let c = 0; c < 4; c++) raw[y * (size * 4 + 1) + 1 + x * 4 + c] = color[c];
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
for (const name of ['play', 'pause', 'previous', 'next', 'app']) {
  const bytes = png(name === 'app' ? 256 : 32, (x, y) => {
    let solid;
    if (name === 'app') {
      solid = [0.25, 0.42, 0.59, 0.76].some((p, i) => Math.abs(x - p) < 0.045 && Math.abs(y - 0.5) < [0.15, 0.29, 0.22, 0.12][i]);
      return solid ? [57, 195, 209, 255] : [13, 15, 18, 255];
    }
    if (name === 'previous') x = 1 - x;
    if (name === 'pause') solid = y > 0.2 && y < 0.8 && ((x > 0.25 && x < 0.42) || (x > 0.58 && x < 0.75));
    else solid = (x > 0.23 && x < 0.76 && Math.abs(y - 0.5) < (0.76 - x) * 0.65) || (name !== 'play' && x > 0.76 && x < 0.86 && y > 0.2 && y < 0.8);
    return solid ? [57, 195, 209, 255] : [0, 0, 0, 0];
  });
  fs.writeFileSync(path.join(dir, name + '.png'), bytes);
  if (name === 'app') {
    const ico = Buffer.alloc(22);
    ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
    ico.writeUInt32LE(bytes.length, 14); ico.writeUInt32LE(22, 18);
    fs.writeFileSync(path.join(dir, 'app.ico'), Buffer.concat([ico, bytes]));
  }
}
