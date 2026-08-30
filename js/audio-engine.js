// Yellowjacket — playback engine. Schedules one AudioBufferSourceNode per kept
// segment so playback skips cut ranges; time is reported on the original timeline.

import { probeContainer, planDecodeRate } from './dsp/native-rate.js';

const SCHEDULE_DELAY = 0.03;      // s, shared start offset so segments align
const MIN_SEG = 0.001;            // s, ignore slivers below this
const TIME_INTERVAL = 1000 / 32;  // ms, ~30fps cadence for 'time' events

export class Engine extends EventTarget {
  // events: 'time' {t}, 'state' {playing}, 'loaded' {}, 'ended' {}
  constructor() {
    super();
    this._ctx = null;
    this._master = null;
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
  }

  // decodeAudioData resamples to the context's rate, so a 96 or 192 kHz file
  // would arrive already halved or quartered. When the container states a
  // higher rate than the hardware context, decode through an
  // OfflineAudioContext built at the file's own rate instead and keep every
  // sample; playback resamples on the way out, which costs nothing here.
  // `decodeReport` records what happened so the caller can say so out loud.
  async load(arrayBuffer) {
    const ctx = this._ensureCtx();
    const probe = probeContainer(arrayBuffer);
    const plan = planDecodeRate({
      nativeRate: probe.sampleRate,
      seconds: probe.seconds,
      channels: probe.channels,
      contextRate: ctx.sampleRate,
    });
    let buffer = null;
    if (plan.rate > ctx.sampleRate && probe.seconds > 0) {
      try {
        const frames = Math.max(1, Math.ceil(plan.rate * probe.seconds));
        const offline = new OfflineAudioContext(
          Math.max(1, probe.channels || 2), frames, plan.rate,
        );
        buffer = await offline.decodeAudioData(arrayBuffer);
      } catch (error) {
        buffer = null;   // fall through to the context decode below
      }
    }
    if (!buffer) buffer = await ctx.decodeAudioData(arrayBuffer);
    this.decodeReport = {
      nativeRate: probe.sampleRate,
      decodedRate: buffer.sampleRate,
      downgraded: !!(probe.sampleRate && buffer.sampleRate < probe.sampleRate),
      reason: plan.reason,
    };
    this._haltPlayback();
    this._buffer = buffer;
    this._mono = mixdownMono(buffer);
    this._alt = null;
    this._lastCuts = [];
    this._position = 0;
    this.dispatchEvent(new CustomEvent('loaded', { detail: {} }));
  }

  // Return the bench to a true source-free state. SYNTH and CRATE can still
  // use the existing AudioContext/master graph; only source transport is
  // cleared. Portable .yjkt imports need this when a synth-only project
  // replaces a session that previously had a recording loaded.
  clear() {
    this._haltPlayback();
    this._buffer = null;
    this._mono = null;
    this._alt = null;
    this._lastCuts = [];
    this._position = 0;
    this._segs = [];
    this._totalKept = 0;
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
    const elapsed = Math.max(0, this._ctx.currentTime - this._t0);
    const edited = Math.min(this._editedStart + elapsed, this._totalKept);
    return originalOf(edited, this._segs);
  }

  play(cuts = [], from = null) {
    const buf = this._activeBuffer();
    if (!buf || buf.duration <= 0) return;
    const ctx = this.wake();

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
      src.connect(this._master);
      src.start(t0 + editedOf(segStart, segs) - editedStart, segStart, len);
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
