'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');

function relativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 8192 || value.includes('\\') || /[\x00-\x1f]/.test(value) || value.startsWith('/')) throw new Error('Invalid library path');
  if (value.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid library path');
  return value;
}
const hash = value => createHash('sha256').update(value).digest('hex');
const libraryId = server => hash(server.replace(/\/+$/, '')).slice(0, 24);
const types = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.webm': 'audio/webm', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

class OfflineStore {
  constructor(root, { fetcher = fetch, progress = () => {} } = {}) {
    this.root = path.resolve(root);
    this.files = path.join(this.root, 'files');
    this.fetcher = fetcher;
    this.progress = progress;
    this.jobs = new Map();
    this.destinations = new Map();
    this.writes = Promise.resolve();
  }
  async init() {
    await fs.mkdir(this.files, { recursive: true });
    // Refuse manually substituted junctions/symlinks in the storage path.
    let current = this.files;
    while (true) {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Offline storage cannot use symbolic links or junctions');
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    // Interrupted transfers are never considered saved music.
    for (const name of await fs.readdir(this.files)) if (/^[a-f0-9-]+\.part$/.test(name)) await fs.unlink(path.join(this.files, name));
  }
  file(rel) {
    relativePath(rel);
    // Hash the full library path: Windows-reserved names, long names, case-only
    // differences and characters such as ':' cannot collide or escape this folder.
    const ext = path.posix.extname(rel).toLowerCase();
    return path.join(this.files, hash(rel) + (/^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ''));
  }
  async regular(file) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Not a regular saved file');
    return stat;
  }
  async manifestRead() {
    const file = path.join(this.root, 'manifest.json');
    try { await this.regular(file); return await fs.readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  manifestWrite(text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 64 * 1024 * 1024) throw new Error('Invalid offline index');
    const manifest = JSON.parse(text);
    if (manifest.v !== 1 || !Array.isArray(manifest.tracks)) throw new Error('Invalid offline index');
    for (const track of manifest.tracks) relativePath(track.path);
    const write = async () => {
      const temp = path.join(this.root, randomUUID() + '.tmp');
      try {
        await fs.writeFile(temp, text, { flag: 'wx' });
        await fs.rename(temp, path.join(this.root, 'manifest.json'));
      } finally { await fs.unlink(temp).catch(() => {}); }
      return true;
    };
    const result = this.writes.then(write);
    this.writes = result.catch(() => {});
    return result;
  }
  async offlineFiles() {
    const manifest = JSON.parse(await this.manifestRead() || '{"tracks":[]}');
    const files = [];
    for (const track of manifest.tracks) {
      try { const stat = await this.regular(this.file(track.path)); files.push({ path: track.path, size: stat.size }); } catch {}
    }
    return files;
  }
  async storage() {
    const stats = await fs.statfs(this.root);
    let used = 0;
    for (const name of await fs.readdir(this.files)) {
      try { used += (await this.regular(path.join(this.files, name))).size; } catch {}
    }
    return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize, used };
  }
  async download({ key, url, path: rel }) {
    if (typeof key !== 'string' || !/^[tc]\d+$/.test(key)) throw new Error('Invalid download key');
    const destination = this.file(rel);
    if (this.jobs.has(key)) throw new Error('Already downloading');
    if (this.destinations.has(destination)) {
      const error = await this.destinations.get(destination);
      if (error) throw error;
      return true;
    }
    const controller = new AbortController();
    let complete, failure;
    this.jobs.set(key, controller);
    this.destinations.set(destination, new Promise(resolve => { complete = resolve; }));
    const temp = path.join(this.files, randomUUID() + '.part');
    let handle;
    const timeout = setTimeout(() => controller.abort(new Error('Download timed out')), 30 * 60 * 1000);
    try {
      let response;
      for (let redirects = 0; redirects <= 5; redirects++) {
        const target = new URL(url);
        if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Download links must use HTTPS');
        response = await this.fetcher(target.href, { signal: controller.signal, redirect: 'manual', credentials: 'omit' });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        await response.body?.cancel();
        if (redirects === 5 || !response.headers.get('location')) throw new Error('Invalid download redirect');
        url = new URL(response.headers.get('location'), target).href;
      }
      if (response.status !== 200 || !response.body) throw new Error(`Download failed (HTTP ${response.status})`);
      if (/text\/html|application\/json/i.test(response.headers.get('content-type') || '')) throw new Error('The server returned a page instead of a media file');
      handle = await fs.open(temp, 'wx');
      const total = Number(response.headers.get('content-length')) || 0;
      let received = 0, last = 0;
      for await (const chunk of response.body) {
        controller.signal.throwIfAborted();
        let offset = 0;
        while (offset < chunk.length) offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten;
        received += chunk.length;
        if (Date.now() - last > 200) { this.progress(key, received, total); last = Date.now(); }
      }
      controller.signal.throwIfAborted();
      if (!received || (total && !response.headers.get('content-encoding') && total !== received)) throw new Error('Download was incomplete');
      await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temp, destination);
      this.progress(key, received, total || received);
      return true;
    } catch (error) {
      failure = controller.signal.aborted ? new Error('Download cancelled or timed out') : error;
      throw failure;
    } finally {
      clearTimeout(timeout);
      await handle?.close().catch(() => {});
      await fs.unlink(temp).catch(() => {});
      this.jobs.delete(key); this.destinations.delete(destination);
      complete(failure);
    }
  }
  async remove(paths) {
    if (!Array.isArray(paths) || paths.length > 100000) throw new Error('Invalid file list');
    const files = paths.map(rel => this.file(rel));
    if (files.some(file => this.destinations.has(file))) throw new Error('Cancel the download before removing this file');
    for (const file of files) {
      try { await this.regular(file); await fs.unlink(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return true;
  }
  async handle(action, payload = {}) {
    switch (action) {
      case 'state': case 'pickFolder': return { folder: 'Scray Audio', location: this.root };
      case 'manifestRead': return this.manifestRead();
      case 'manifestWrite': return this.manifestWrite(payload.text);
      case 'offlineFiles': return this.offlineFiles();
      case 'storage': return this.storage();
      case 'download': return this.download(payload);
      case 'cancel': this.jobs.get(payload.key)?.abort(); return true;
      case 'remove': return this.remove(payload.paths);
      default: throw new Error('Unknown offline action');
    }
  }
  cancelAll() { for (const controller of this.jobs.values()) controller.abort(); }
  async response(request) {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'local' || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 403 });
      const rel = relativePath(decodeURIComponent(url.pathname.slice(1)));
      const file = this.file(rel), stat = await this.regular(file);
      const headers = { 'Content-Type': types[path.extname(rel).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
      let start = 0, end = stat.size - 1, status = 200;
      const range = request.headers.get('range');
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${stat.size}` } });
        start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
        if (start > end || start >= stat.size) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${stat.size}` } });
        status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      }
      headers['Content-Length'] = String(Math.max(0, end - start + 1));
      const body = request.method === 'HEAD' || !stat.size ? null : Readable.toWeb(require('node:fs').createReadStream(file, { start, end }));
      return new Response(body, { status, headers });
    } catch { return new Response(null, { status: 404 }); }
  }
}
module.exports = { OfflineStore, relativePath, libraryId };
