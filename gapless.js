/* Decode the current/next song and schedule their samples on one audio clock.
 * Ordinary media playback remains the fallback for unavailable CORS, unsupported
 * decoders, very large files, or slow downloads. No crossfade or silence trimming. */
(() => {
  'use strict';
  const MAX_BYTES = 64 * 1024 * 1024, MAX_PCM = 128 * 1024 * 1024;
  class GaplessPlayer extends EventTarget {
    constructor() {
      super();
      this.media = new Audio(); this.media.preload = 'auto';
      this.context = null; this.gain = null;
      this.current = null; this.upcoming = null; this.prepared = null;
      this.sequence = 0; this.prepareSequence = 0; this.request = null; this.nextRequest = null;
      this._paused = true; this._ended = false; this._volume = 1; this._muted = false;
      for (const name of ['play', 'pause', 'playing', 'ended', 'durationchange', 'loadedmetadata', 'timeupdate', 'seeking', 'error']) {
        this.media.addEventListener(name, () => { if (!this.current) this.emit(name); });
      }
      setInterval(() => { if (this.current && !this._paused) this.emit('timeupdate'); }, 200);
    }
    emit(name, detail) { this.dispatchEvent(detail ? new CustomEvent(name, { detail }) : new Event(name)); }
    unlock() {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return;
      if (!this.context) {
        this.context = new Context();
        this.gain = this.context.createGain(); this.gain.connect(this.context.destination); this.updateGain();
        if (navigator.audioSession) { try { navigator.audioSession.type = 'playback'; } catch {} }
      }
      this.context.resume().catch(() => {});
    }
    updateGain() { if (this.gain) this.gain.gain.value = this._muted ? 0 : this._volume; }
    get volume() { return this._volume; }
    set volume(value) { this._volume = Math.min(1, Math.max(0, value)); this.media.volume = this._volume; this.updateGain(); }
    get muted() { return this._muted; }
    set muted(value) { this._muted = !!value; this.media.muted = this._muted; this.updateGain(); }
    get playbackRate() { return 1; }
    get paused() { return this.current ? this._paused : this.media.paused; }
    get ended() { return this.current ? this._ended : this.media.ended; }
    get duration() { return this.current ? this.current.buffer.duration : this.media.duration; }
    get src() { return this.current ? this.current.url : this.media.src; }
    set src(url) { this.reset(); this.media.src = url; }
    get currentTime() {
      if (!this.current) return this.media.currentTime;
      const c = this.current;
      return Math.min(c.buffer.duration, c.offset + (this._paused ? 0 : Math.max(0, this.context.currentTime - c.start)));
    }
    set currentTime(value) {
      if (!this.current) { this.media.currentTime = value; return; }
      const wasPlaying = !this._paused;
      this.stopNode(this.current); this.cancelScheduled();
      this.current.offset = Math.max(0, Math.min(Number(value) || 0, this.duration));
      this._ended = false;
      this.emit('seeking');
      if (wasPlaying) { this.startNode(this.current, this.context.currentTime); this.schedule(); }
      this.emit('timeupdate');
    }
    stopNode(record) {
      if (record?.node) { record.node.onended = null; try { record.node.stop(); } catch {} record.node.disconnect(); record.node = null; }
    }
    cancelScheduled() { this.stopNode(this.upcoming); this.upcoming = null; }
    cancelNext() {
      this.prepareSequence++; this.nextRequest?.abort(); this.nextRequest = null;
      this.cancelScheduled(); this.prepared = null;
      this.emit('modechange');
    }
    reset() {
      this.sequence++; this.request?.abort(); this.request = null; this.cancelNext();
      this.stopNode(this.current); this.current = null; this.media.pause(); this._paused = true; this._ended = false;
      this.emit('pause');
    }
    removeAttribute(name) { if (name === 'src') { this.reset(); this.media.removeAttribute('src'); } }
    load() { this.media.load(); }
    async decode(url, track, controller) {
      if (!this.context || (track.size && track.size > MAX_BYTES) || (track.ms && track.ms > 12 * 60 * 1000)) throw new Error('Use streaming for large tracks');
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Use streaming');
        const chunks = []; let size = 0;
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Use streaming');
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Use streaming'); }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const buffer = await this.context.decodeAudioData(bytes.buffer);
        if (buffer.length * buffer.numberOfChannels * 4 > MAX_PCM) throw new Error('Use streaming for large tracks');
        return buffer;
      } finally { clearTimeout(timer); }
    }
    async setTrack(url, track) {
      const cached = this.prepared?.url === url ? this.prepared.buffer : null;
      this.reset();
      this.media.removeAttribute('src'); this.media.load();
      this.loading = true; this.emit('modechange');
      const sequence = this.sequence, controller = new AbortController(); this.request = controller;
      let buffer;
      try { buffer = cached || await this.decode(url, track, controller); } catch {}
      if (sequence !== this.sequence) throw new DOMException('Playback changed', 'AbortError');
      this.request = null;
      this.loading = false;
      if (buffer) {
        this.media.removeAttribute('src'); this.media.load();
        this.current = { url, buffer, offset: 0, start: 0, node: null };
        this.emit('loadedmetadata'); this.emit('durationchange');
      } else this.media.src = url;
      this.emit('modechange');
    }
    startNode(record, when) {
      const node = this.context.createBufferSource(); node.buffer = record.buffer;
      node.connect(this.gain); record.node = node; record.start = when;
      node.onended = () => {
        node.disconnect();
        if (this.current !== record || this._paused) return;
        if (this.upcoming) {
          this.current = this.upcoming; this.upcoming = null; this.prepared = null;
          this.emit('transition', this.current.token);
          this.emit('durationchange'); this.emit('timeupdate'); this.emit('playing');
        } else {
          record.offset = record.buffer.duration; record.node = null; this._paused = true; this._ended = true;
          this.emit('ended');
        }
      };
      node.start(when, record.offset);
    }
    async play() {
      if (!this.current) return this.media.play();
      await this.context.resume();
      if (!this._paused) return;
      if (this._ended) this.current.offset = 0;
      this._ended = false; this._paused = false;
      this.startNode(this.current, this.context.currentTime); this.schedule();
      this.emit('play'); this.emit('playing');
    }
    pause() {
      if (!this.current) { this.media.pause(); return; }
      if (this._paused) return;
      this.current.offset = this.currentTime; this._paused = true;
      this.stopNode(this.current); this.cancelScheduled(); this.emit('pause');
    }
    async prepare(url, track, token) {
      this.cancelNext();
      if (!this.current || !url) return;
      const sequence = this.prepareSequence, controller = new AbortController(); this.nextRequest = controller;
      let buffer;
      try { buffer = url === this.current.url ? this.current.buffer : await this.decode(url, track, controller); } catch { return; }
      if (sequence !== this.prepareSequence) return;
      this.nextRequest = null; this.prepared = { url, buffer, token };
      this.schedule();
    }
    schedule() {
      if (!this.current || !this.prepared || this._paused || this.upcoming) return;
      const end = this.current.start + this.current.buffer.duration - this.current.offset;
      if (end <= this.context.currentTime) return;
      this.upcoming = { ...this.prepared, offset: 0, start: end, node: null };
      this.startNode(this.upcoming, end);
      this.emit('modechange');
    }
  }
  window.ScrayGaplessPlayer = GaplessPlayer;
})();
