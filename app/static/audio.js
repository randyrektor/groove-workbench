// Playback: the song and the drum stem as sample-accurate loops, plus a small drum synth
// scheduled on the same audio clock, so what you see on the grid is what you hear.

function noise(seed) {
  let s = seed >>> 0;
  return () => { s = (1103515245 * s + 12345) >>> 0; return (s / 0xffffffff) * 2 - 1; };
}

function render(sr, seconds, fn) {
  const n = Math.floor(sr * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(i / sr, i);
  return out;
}

function tom(sr, f0) {
  let ph = 0;
  return render(sr, 0.32, (t) => {
    const f = f0 * (1 + 0.6 * Math.exp(-t * 30));
    ph += (2 * Math.PI * f) / sr;
    return Math.exp(-t * 11) * Math.sin(ph) * 0.9;
  });
}

function noisy(sr, seconds, decay, hp, seed, tone = 0, toneAmt = 0) {
  const rnd = noise(seed);
  let prev = 0, prev2 = 0;
  return render(sr, seconds, (t) => {
    const x = rnd();
    let y = x;
    if (hp >= 1) { y = x - prev; }
    if (hp >= 2) { const z = y - prev2; prev2 = y; y = z * 0.7; }
    prev = x;
    const body = tone ? Math.sin(2 * Math.PI * tone * t) * Math.exp(-t * 22) * toneAmt : 0;
    return Math.exp(-t * decay) * y * 0.5 + body;
  });
}

function metal(sr, seconds, decay, seed) {
  const freqs = [3140, 4170, 5230, 6790, 8120, 9460];
  const rnd = noise(seed);
  let prev = 0;
  return render(sr, seconds, (t) => {
    let s = 0;
    for (const f of freqs) s += Math.sign(Math.sin(2 * Math.PI * f * t));
    const x = rnd(); const n = x - prev; prev = x;
    return Math.exp(-t * decay) * (s / freqs.length * 0.22 + n * 0.25) + Math.exp(-t * 60) * n * 0.3;
  });
}

function buildKit(ctx) {
  const sr = ctx.sampleRate;
  const raw = {};
  let ph = 0;
  raw[36] = render(sr, 0.3, (t) => {
    const f = 46 + 110 * Math.exp(-t * 26);
    ph += (2 * Math.PI * f) / sr;
    return Math.exp(-t * 13) * Math.sin(ph) + Math.exp(-t * 260) * Math.sin(2 * Math.PI * 1900 * t) * 0.3;
  });
  raw[38] = noisy(sr, 0.22, 20, 1, 7, 190, 0.5);
  raw[37] = render(sr, 0.06, (t) => Math.exp(-t * 90) * (Math.sin(2 * Math.PI * 1750 * t) * 0.7 + Math.sin(2 * Math.PI * 530 * t) * 0.4));
  raw[42] = noisy(sr, 0.06, 70, 2, 11);
  raw[46] = noisy(sr, 0.4, 9, 2, 13);
  raw[51] = metal(sr, 0.7, 5, 17);
  raw[49] = noisy(sr, 1.4, 3.2, 2, 19);
  raw[50] = tom(sr, 190);
  raw[47] = tom(sr, 140);
  raw[43] = tom(sr, 95);
  raw[54] = noisy(sr, 0.12, 30, 2, 23);
  raw[82] = noisy(sr, 0.09, 38, 2, 29);
  raw.click = render(sr, 0.03, (t) => Math.exp(-t * 160) * Math.sin(2 * Math.PI * 1500 * t));
  raw.clickHi = render(sr, 0.03, (t) => Math.exp(-t * 160) * Math.sin(2 * Math.PI * 2200 * t));
  const kit = {};
  for (const [key, data] of Object.entries(raw)) {
    const buf = ctx.createBuffer(1, data.length, sr);
    buf.copyToChannel(data, 0);
    kit[key] = buf;
  }
  return kit;
}

export class Engine {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.bus = {};
    for (const name of ['song', 'drums', 'midi', 'click']) {
      this.bus[name] = this.ctx.createGain();
      this.bus[name].connect(this.master);
    }
    this.kit = buildKit(this.ctx);
    this.buffers = {};
    this.samples = {};
    this.mode = null;       // null | 'song' | 'loop'
    this.sources = [];
    this.cursor = 0;        // song time the playhead rests at
    this.onstop = null;
    this._timer = null;
  }

  async decode(arrayBuffer) { return this.ctx.decodeAudioData(arrayBuffer); }
  setBuffer(name, buf) { this.buffers[name] = buf; }
  setGain(name, value) { this.bus[name].gain.setTargetAtTime(value, this.ctx.currentTime, 0.01); }

  // Real samples for a drum: one buffer, or several ordered quiet to loud.
  setSamples(pitch, buffers) { this.samples[pitch] = buffers; }

  hit(pitch, vel = 100, when = 0, bus = 'midi') {
    const layers = this.samples[pitch];
    let buf = this.kit[pitch], gain = Math.pow(vel / 127, 1.6) * 0.9;
    if (layers && layers.length > 1) {
      // A velocity set already carries its own loudness: pick the layer, leave the level alone.
      buf = layers[Math.max(0, Math.min(layers.length - 1, Math.ceil((vel / 127) * layers.length) - 1))];
      gain = 0.9;
    } else if (layers && layers.length) buf = layers[0];
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.buffer = buf;
    src.connect(g).connect(this.bus[bus]);
    src.start(when);
  }

  _start(offset, loop) {
    this.ctx.resume();
    const at = this.ctx.currentTime + 0.06;
    for (const name of ['song', 'drums']) {
      const buf = this.buffers[name];
      if (!buf) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      if (loop) { src.loop = true; src.loopStart = loop.start; src.loopEnd = loop.start + loop.len; }
      src.connect(this.bus[name]);
      src.start(at, Math.max(0, offset));
      this.sources.push(src);
    }
    return at;
  }

  _halt() {
    for (const src of this.sources) { try { src.onended = null; src.stop(); } catch (e) { /* already stopped */ } }
    this.sources = [];
    clearInterval(this._timer);
    this._timer = null;
  }

  playSong(offset) {
    this._halt();
    const at = this._start(offset, null);
    this.mode = 'song';
    this._t0 = at; this._offset = offset;
    const first = this.sources[0];
    if (first) first.onended = () => { if (this.mode === 'song') this.stop(true); };
  }

  // loop: { start, len, notes: () => [{sec, p, v}], beats: () => [{sec, accent}] }
  // from: song time inside the loop to start at (default: the top of the loop).
  playLoop(loop, from) {
    this._halt();
    const offset = from != null && from >= loop.start && from < loop.start + loop.len ? from : loop.start;
    const real = this._start(offset, loop);
    this.mode = 'loop';
    this._loop = loop;
    this._t0 = real - (offset - loop.start);  // when this pass of the loop would have begun
    this._sched = real;
    const tick = () => {
      const now = this.ctx.currentTime;
      const horizon = now + 0.14;
      const from = Math.max(this._sched, now);
      const lp = this._loop, at = this._t0, len = lp.len;
      const k0 = Math.floor((from - at) / len) - 1;
      const k1 = Math.floor((horizon - at) / len);
      const notes = lp.notes();
      const beats = lp.beats();
      for (let k = Math.max(0, k0); k <= k1 + 1; k++) {
        const base = at + k * len;
        for (const n of notes) {
          const t = base + n.sec;
          if (t >= from && t < horizon) this.hit(n.p, n.v, t);
        }
        for (const b of beats) {
          const t = base + b.sec;
          if (t >= from && t < horizon) this.hit(b.accent ? 'clickHi' : 'click', 100, t, 'click');
        }
      }
      this._sched = horizon;
    };
    tick();
    this._timer = setInterval(tick, 25);
  }

  // Change the loop while it plays, without starting over. If the playhead is left outside
  // the new loop, it picks up just before the new end (when the end moved in) or from the top.
  updateLoop(loop) {
    if (this.mode !== 'loop') return;
    const now = this.ctx.currentTime, old = this._loop;
    const pos = old.start + ((((now - this._t0) % old.len) + old.len) % old.len);
    const end = loop.start + loop.len;
    if (pos < loop.start || pos >= end - 0.05) {
      this.playLoop(loop, pos >= end - 0.05 ? Math.max(loop.start, end - 2) : loop.start);
      return;
    }
    for (const src of this.sources) { src.loopStart = loop.start; src.loopEnd = end; }
    this._loop = loop;
    this._t0 = now - (pos - loop.start);
  }

  stop(ended = false) {
    if (!this.mode) return;
    const pos = this.position();
    this._halt();
    if (this.mode === 'song') this.cursor = ended ? 0 : pos;
    this.mode = null;
    if (this.onstop) this.onstop();
  }

  // Song time of what is coming out of the speakers right now.
  position() {
    if (!this.mode) return this.cursor;
    const lat = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    const run = Math.max(0, this.ctx.currentTime - lat - this._t0);
    if (this.mode === 'song') return this._offset + run;
    return this._loop.start + (run % this._loop.len);
  }
}
