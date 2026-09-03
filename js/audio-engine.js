// Yellowjacket — playback engine. Schedules one AudioBufferSourceNode per kept
// segment so playback skips cut ranges; time is reported on the original timeline.

import { probeContainer, planDecodeRate } from './dsp/native-rate.js';
import { bufferSecondsElapsed, realSecondsUntil, SPEED_FACTORS } from './dsp/varispeed.js';

const SCHEDULE_DELAY = 0.03;      // s, shared start offset so segments align
const MIN_SEG = 0.001;            // s, ignore slivers below this
const TIME_INTERVAL = 1000 / 32;  // ms, ~30fps cadence for 'time' events

export class Engine extends EventTarget {
  // events: 'time' {t}, 'state' {playing}, 'loaded' {}, 'ended' {}
  constructor() {
    super();
    this._ctx = null;
    this._master = null;
    // The transport: the context every source node that plays the recording
    // runs on, at the recording's own rate, so playback is a copy (unity
    // ratio) and the only resampler left is Chromium's sinc stage from that
    // context to the device. When the rates already match it IS the device
    // context (shared). MACHINE, STUDIO, and the MIDI clock stay on the device
    // context (engine.ctx). See docs/lab/2026-09-03-playback-rate-decision.md.
    this._transport = null;   // {ctx, master, rate, shared}
    this._deviceRate = 0;
    this.transportReport = null;   // {requested, got, shared, refused}
    this._buffer = null;
    this._mono = null;
    this._alt = null;
    this._position = 0;       // seconds on the active buffer's timeline
    this._playing = false;
    this._sources = [];
    this._segs = [];          // kept segments backing the current schedule
    this._lastCuts = [];      // last normalized cuts for the ORIGINAL buffer
    this._t0 = 0;             // ctx.currentTime corresponding to _editedStart
    this._editedStart = 0;
    this._totalKept = 0;
    this._gen = 0;            // invalidates stale onended callbacks
    this._raf = 0;
    this._lastEmit = 0;
    // Speed factor: 1, 2 or 4. Playback runs at 1/factor and every conversion
    // between real time and buffer time goes through varispeed.js so the
    // playhead neither races nor crawls.
    this._rate = 1;
  }

  // Files decode at their own rate (an OfflineAudioContext at that rate) and
  // play on a transport context opened at that same rate: no upsampling in
  // memory, no linear interpolation on the way out (E12, lab log). The device
  // context keeps its hardware rate for MACHINE and STUDIO. `decodeReport`
  // and `transportReport` record what happened so the caller can say so.
  // Decode at the file's own rate whenever the container states one (an
  // OfflineAudioContext at that rate; AudioBufferSourceNode resamples on
  // playback), so a 48 kHz file on a 96 kHz output is not doubled in memory.
  // The plan is enforced: a refused plan throws with code 'over-budget' and
  // the reason, and nothing is decoded. decodeAudioData detaches its input
  // even when it rejects, so the caller may pass `fallback`, a function that
  // returns a fresh copy of the bytes, for the one case where the offline
  // decode fails and the context has to try instead.
  async load(arrayBuffer, { fallback = null } = {}) {
    const ctx = this._ensureCtx();
    const probe = probeContainer(arrayBuffer);
    const plan = planDecodeRate({
      nativeRate: probe.sampleRate,
      seconds: probe.seconds,
      channels: probe.channels,
      contextRate: ctx.sampleRate,
      // The caller keeps these bytes for persistence and RESTORE, so they are
      // part of what the load costs even though decoding cannot shrink them.
      encodedBytes: arrayBuffer && arrayBuffer.byteLength ? arrayBuffer.byteLength : 0,
    });
    this.lastPlan = plan;
    if (plan.refused) {
      const error = new Error(plan.reason);
      error.code = 'over-budget';
      error.plan = plan;
      throw error;
    }
    let buffer = null;
    let offlineFailed = false;
    if (plan.rate !== ctx.sampleRate) {
      try {
        // Length is irrelevant to decodeAudioData; it only sizes a render.
        const offline = new OfflineAudioContext(Math.max(1, probe.channels || 2), 128, plan.rate);
        buffer = await offline.decodeAudioData(arrayBuffer);
      } catch (error) {
        buffer = null;
        offlineFailed = true;
      }
    }
    if (!buffer) {
      const bytes = offlineFailed ? (fallback ? fallback() : null) : arrayBuffer;
      if (!bytes) {
        const error = new Error('this browser could not decode the file at its own rate, and no copy was kept to retry');
        error.code = 'decode-failed';
        throw error;
      }
      buffer = await ctx.decodeAudioData(bytes);
    }
    this.decodeReport = {
      nativeRate: probe.sampleRate,
      decodedRate: buffer.sampleRate,
      downgraded: !!(probe.sampleRate && buffer.sampleRate < probe.sampleRate),
      // Only a failed native-rate decode can still upsample now; say so.
      upsampled: !!(probe.sampleRate && buffer.sampleRate > probe.sampleRate),
      overBudget: !!plan.overBudget,
      bytes: plan.bytes,
      reason: plan.reason || (offlineFailed
        ? 'this browser could not decode the file at its own rate, so it was decoded at the output rate' : null),
    };
    this._haltPlayback();
    this._buffer = buffer;
    this._mono = mixdownMono(buffer);
    this._alt = null;
    this._lastCuts = [];
    this._position = 0;
    this._rate = 1;
    await this._ensureTransport(buffer.sampleRate);
    this.dispatchEvent(new CustomEvent('loaded', { detail: {} }));
  }

  // ---------- transport context ----------

  get transport() {
    if (this._transport) return this._transport;
    if (!this._ctx) return null;
    return { ctx: this._ctx, master: this._master, rate: this._ctx.sampleRate, shared: true };
  }
  get deviceRate() { return this._deviceRate; }

  // Like wake(), for the transport: the context sources play the recording on.
  wakeTransport() {
    const T = this.transport || (this._ensureCtx() && this.transport);
    resumeContext(T.ctx);
    return T.ctx;
  }

  _transportCtx() {
    return this._transport ? this._transport.ctx : this._ensureCtx();
  }

  async _ensureTransport(rate) {
    const ctx = this._ensureCtx();
    const want = Math.round(Number(rate)) || ctx.sampleRate;
    const cur = this._transport;
    if (want === ctx.sampleRate) {
      if (cur && !cur.shared) await this._closeTransport('rates now match');
      this._transport = { ctx, master: this._master, rate: ctx.sampleRate, shared: true };
      this.transportReport = { requested: want, got: ctx.sampleRate, shared: true, refused: false };
      this.dispatchEvent(new CustomEvent('transport', { detail: { ...this._transport, refused: false } }));
      return this._transport;
    }
    if (cur && !cur.shared && cur.rate === want && cur.ctx.state !== 'closed') return cur;
    if (cur && !cur.shared) await this._closeTransport('rate change');
    const Ctx = window.AudioContext || window.webkitAudioContext;
    let tctx = null;
    try {
      tctx = new Ctx({ sampleRate: want });
    } catch (error) {
      tctx = null;
    }
    if (!tctx || Math.round(tctx.sampleRate) !== want) {
      // The browser would not open a context at this rate: play on the device
      // context (Chromium then interpolates linearly), and say so.
      if (tctx) { try { await tctx.close(); } catch (e) { /* never opened */ } }
      this._transport = { ctx, master: this._master, rate: ctx.sampleRate, shared: true };
      this.transportReport = { requested: want, got: ctx.sampleRate, shared: true, refused: true };
      this.dispatchEvent(new CustomEvent('transport', { detail: { ...this._transport, refused: true } }));
      return this._transport;
    }
    const master = tctx.createGain();
    master.connect(tctx.destination);
    this._transport = { ctx: tctx, master, rate: want, shared: false };
    this.transportReport = { requested: want, got: want, shared: false, refused: false };
    this.dispatchEvent(new CustomEvent('transport', { detail: { ...this._transport, refused: false } }));
    return this._transport;
  }

  // Close a non-shared transport. 'transportchange' fires synchronously with
  // the old context so consumers drop their nodes while the graph is valid;
  // close() is awaited with a timeout (Safari caps hardware contexts at four,
  // so the old one must go before a new one opens).
  async _closeTransport(reason) {
    const cur = this._transport;
    this._transport = null;
    if (!cur || cur.shared) return;
    this._haltPlayback();
    this.dispatchEvent(new CustomEvent('transportchange', { detail: { from: cur.ctx, reason } }));
    let closing;
    try { closing = cur.ctx.close(); } catch (e) { closing = Promise.resolve(); }
    await Promise.race([Promise.resolve(closing).catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
  }

  // Return the bench to a true source-free state. SYNTH and CRATE can still
  // use the existing AudioContext/master graph; only source transport is
  // cleared. Portable .yjkt imports need this when a synth-only project
  // replaces a session that previously had a recording loaded.
  clear() {
    this._haltPlayback();
    if (this._transport && !this._transport.shared) this._closeTransport('clear');
    this._transport = null;
    this._buffer = null;
    this._mono = null;
    this._alt = null;
    this._lastCuts = [];
    this._position = 0;
    this._segs = [];
    this._totalKept = 0;
    this._rate = 1;
    this.dispatchEvent(new CustomEvent('time', { detail: { t: 0 } }));
    this.dispatchEvent(new CustomEvent('loaded', { detail: {} }));
  }

  // Swap the playable audio without a decode. Only for length-identical
  // replacements (spectral repair): position, cuts, and alt semantics all hold.
  adoptBuffer(audioBuffer, mono = null) {
    if (!audioBuffer) return;
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this._buffer = audioBuffer;
    this._mono = mono || mixdownMono(audioBuffer);
    if (this._ctx) this._ensureTransport(audioBuffer.sampleRate);   // same rate: a no-op
  }

  get buffer() { return this._buffer; }
  get mono() { return this._mono; }
  get sampleRate() { return this._buffer ? this._buffer.sampleRate : 0; }
  get duration() {
    const b = this._activeBuffer();
    return b ? b.duration : 0;
  }
  get playing() { return this._playing; }
  get ctx() { return this._ctx; }
  get master() { return this._master; }

  // AudioContext creation has to happen inside a user gesture. MACHINE can
  // create sound without a source file (SYNTH / CRATE), so `play()` cannot be
  // the only doorway into the audio graph.
  wake() {
    const ctx = this._ensureCtx();
    resumeContext(ctx);
    return ctx;
  }

  get currentTime() {
    if (!this._playing || !this._ctx) return this._position;
    const elapsed = Math.max(0, this._transportCtx().currentTime - this._t0);
    const edited = Math.min(this._editedStart + bufferSecondsElapsed(elapsed, this._rate), this._totalKept);
    return originalOf(edited, this._segs);
  }

  play(cuts = [], from = null) {
    const buf = this._activeBuffer();
    if (!buf || buf.duration <= 0) return;
    this.wake();
    const T = this.transport;
    const ctx = T.ctx;
    resumeContext(ctx);

    // Alt buffer plays verbatim: it is already rendered, cuts do not apply.
    if (!this._alt) this._lastCuts = normalizeCuts(cuts, buf.duration);
    const segs = keptSegments(buf.duration, this._alt ? [] : this._lastCuts);
    if (!segs.length) return;

    const wasPlaying = this._playing;
    this._gen++;
    this._stopSources();
    this._stopTick();

    let startPos = from == null ? this._position : from;
    if (!Number.isFinite(startPos)) startPos = 0;
    startPos = Math.min(Math.max(startPos, 0), buf.duration);

    const total = editedOf(buf.duration, segs);
    let editedStart = editedOf(startPos, segs);
    if (editedStart >= total - MIN_SEG) editedStart = 0;  // at the end: restart
    startPos = originalOf(editedStart, segs);             // snap out of cut ranges

    const t0 = ctx.currentTime + SCHEDULE_DELAY;
    const gen = this._gen;
    let last = null;
    for (const seg of segs) {
      const segStart = Math.max(seg.start, startPos);
      const len = seg.end - segStart;
      if (len < MIN_SEG) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = 1 / this._rate;
      src.connect(T.master);
      // offset and duration are in buffer time; only the START moment is real time.
      src.start(t0 + realSecondsUntil(editedOf(segStart, segs) - editedStart, this._rate), segStart, len);
      this._sources.push(src);
      last = src;
    }
    if (!last) {
      if (wasPlaying) {
        this._playing = false;
        this.dispatchEvent(new CustomEvent('state', { detail: { playing: false } }));
      }
      return;
    }
    last.onended = () => {
      if (gen === this._gen) this._onNaturalEnd();
    };

    this._segs = segs;
    this._t0 = t0;
    this._editedStart = editedStart;
    this._totalKept = total;
    this._position = startPos;
    this._playing = true;
    if (!wasPlaying) this.dispatchEvent(new CustomEvent('state', { detail: { playing: true } }));
    this._startTick();
  }

  get rate() { return this._rate; }

  // Change speed without losing the place. If playing, reschedule from the
  // current buffer position so the new rate takes effect immediately.
  setRate(factor) {
    const f = SPEED_FACTORS.includes(factor) ? factor : 1;
    if (f === this._rate) return;
    const wasPlaying = this._playing;
    const pos = wasPlaying ? this.currentTime : this._position;
    this._rate = f;
    if (wasPlaying) this.play(this._lastCuts, pos);
    else this._position = pos;
  }

  pause() {
    if (!this._playing) return;
    this._position = this.currentTime;
    this._haltPlayback();
  }

  seek(t) {
    const buf = this._activeBuffer();
    if (!buf) return;
    let target = Number(t);
    if (!Number.isFinite(target)) target = 0;
    target = Math.min(Math.max(target, 0), buf.duration);
    if (this._playing) {
      this.play(this._lastCuts, target);   // restart scheduling from the new position
    } else {
      this._position = target;
      this.dispatchEvent(new CustomEvent('time', { detail: { t: target } }));
    }
  }

  setAltBuffer(audioBuffer) {
    const next = audioBuffer || null;
    if (next === this._alt) return;
    if (this._playing) this.pause();
    // Map the stored position across timelines so A/B keeps the listening spot.
    const origDur = this._buffer ? this._buffer.duration : 0;
    const segs = keptSegments(origDur, this._lastCuts);
    if (next && !this._alt) {
      this._position = Math.min(editedOf(this._position, segs), next.duration);
    } else if (!next && this._alt) {
      this._position = originalOf(this._position, segs);
    } else if (next) {
      this._position = Math.min(this._position, next.duration);
    }
    this._alt = next;
    if (next && this._ctx) this._ensureTransport(next.sampleRate);   // renders are at the source rate: a no-op
  }

  _activeBuffer() {
    return this._alt || this._buffer;
  }

  _ensureCtx() {
    if (!this._ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this._ctx = new Ctx();
      this._master = this._ctx.createGain();
      this._master.connect(this._ctx.destination);
      // A hint-free context runs at the hardware rate; the decode planner is
      // always fed this rate, never a transport's.
      this._deviceRate = this._ctx.sampleRate;
    }
    return this._ctx;
  }

  _haltPlayback() {
    this._gen++;
    this._stopSources();
    this._stopTick();
    if (this._playing) {
      this._playing = false;
      this.dispatchEvent(new CustomEvent('state', { detail: { playing: false } }));
    }
  }

  _onNaturalEnd() {
    this._gen++;
    this._stopSources();
    this._stopTick();
    this._playing = false;
    this._position = this._segs.length ? this._segs[this._segs.length - 1].end : 0;
    this.dispatchEvent(new CustomEvent('time', { detail: { t: this._position } }));
    this.dispatchEvent(new CustomEvent('ended', { detail: {} }));
    this.dispatchEvent(new CustomEvent('state', { detail: { playing: false } }));
  }

  _stopSources() {
    for (const src of this._sources) {
      src.onended = null;
      try { src.stop(); } catch (e) { /* already stopped */ }
      try { src.disconnect(); } catch (e) { /* already disconnected */ }
    }
    this._sources = [];
  }

  _startTick() {
    this._stopTick();
    this._lastEmit = 0;
    const step = () => {
      if (!this._playing) {
        this._raf = 0;
        return;
      }
      const now = performance.now();
      if (now - this._lastEmit >= TIME_INTERVAL) {
        this._lastEmit = now;
        this.dispatchEvent(new CustomEvent('time', { detail: { t: this.currentTime } }));
      }
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
    // rAF stalls in hidden tabs; a coarse interval keeps 'time' flowing there.
    this._tickTimer = setInterval(() => {
      if (!this._playing) return;
      const now = performance.now();
      if (now - this._lastEmit >= 240) {
        this._lastEmit = now;
        this.dispatchEvent(new CustomEvent('time', { detail: { t: this.currentTime } }));
      }
    }, 250);
  }

  _stopTick() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    if (this._tickTimer) clearInterval(this._tickTimer);
    this._tickTimer = 0;
  }
}

// A suspended context returns a promise that can reject (autoplay policy), and
// an ignored rejection here is an unhandled one plus a transport that looks
// like it is playing and is silent. The sequencer already did this; the bench
// did not, for the same failure.
function resumeContext(ctx) {
  if (!ctx || ctx.state !== 'suspended') return;
  try {
    const resumed = ctx.resume();
    if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {});
  } catch (e) { /* stays suspended: scheduling is still valid */ }
}

// Exported because the repair path needs the identical mixdown: it had its own
// copy, and the analysis/spectrogram mono would have quietly stopped matching
// the post-repair mono the first time either one changed its channel weighting.
export function mixdownMono(buffer) {
  const n = buffer.length;
  const ch = buffer.numberOfChannels;
  const out = new Float32Array(n);
  if (!n || !ch) return out;
  for (let c = 0; c < ch; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += data[i];
  }
  if (ch > 1) {
    const g = 1 / ch;
    for (let i = 0; i < n; i++) out[i] *= g;
  }
  return out;
}

function normalizeCuts(cuts, duration) {
  const merged = [];
  const sorted = (cuts || [])
    .map((c) => ({
      start: Math.min(Math.max(c.start, 0), duration),
      end: Math.min(Math.max(c.end, 0), duration),
    }))
    .filter((c) => c.end - c.start > MIN_SEG)
    .sort((a, b) => a.start - b.start);
  for (const c of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && c.start <= prev.end + MIN_SEG) prev.end = Math.max(prev.end, c.end);
    else merged.push(c);
  }
  return merged;
}

function keptSegments(duration, cuts) {
  const segs = [];
  let pos = 0;
  for (const c of cuts) {
    if (c.start - pos > MIN_SEG) segs.push({ start: pos, end: c.start });
    pos = Math.max(pos, c.end);
  }
  if (duration - pos > MIN_SEG) segs.push({ start: pos, end: duration });
  return segs;
}

// original-timeline seconds -> edited (kept-only) seconds
function editedOf(t, segs) {
  let acc = 0;
  for (const s of segs) {
    if (t <= s.start) break;
    acc += Math.min(t, s.end) - s.start;
  }
  return acc;
}

// edited seconds -> original-timeline seconds
function originalOf(et, segs) {
  let acc = 0;
  for (const s of segs) {
    const len = s.end - s.start;
    if (et < acc + len) return s.start + (et - acc);
    acc += len;
  }
  return segs.length ? segs[segs.length - 1].end : 0;
}
