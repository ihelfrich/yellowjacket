// Yellowjacket — playback engine. Schedules one AudioBufferSourceNode per kept
// segment so playback skips cut ranges; time is reported on the original timeline.

import { probeContainer, planDecodeRate } from './dsp/native-rate.js';
import { AudioOutputRouter, SYSTEM_DEFAULT_OUTPUT } from './audio-output-router.js';

const SCHEDULE_DELAY = 0.03;      // s, shared start offset so segments align
const MIN_SEG = 0.001;            // s, ignore slivers below this
const TIME_INTERVAL = 1000 / 32;  // ms, ~30fps cadence for 'time' events
const TEST_SIGNAL_PEAK = 10 ** (-24 / 20);
const TEST_SIGNAL_RAMP = 0.005;
const TEST_SIGNAL_HALF = 0.2;

function defaultContextFactory() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  return new Ctx();
}

function defaultAudioElementFactory() {
  return document.createElement('audio');
}

function outputPreferences(preferences, current) {
  if (!preferences || typeof preferences !== 'object') {
    throw new TypeError('Audio output preferences must be an object');
  }
  const outputId = preferences.outputId === undefined ? current.outputId : preferences.outputId;
  const volume = preferences.volume === undefined ? current.volume : preferences.volume;
  const muted = preferences.muted === undefined ? current.muted : preferences.muted;
  if (typeof outputId !== 'string' || outputId.length === 0) {
    throw new TypeError('Audio outputId must be a non-empty string');
  }
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
    throw new RangeError('Audio output volume must be between 0 and 1');
  }
  if (typeof muted !== 'boolean') throw new TypeError('Audio output muted must be boolean');
  return { outputId, volume, muted };
}

export class OutputNotReadyError extends Error {
  constructor(code, cause) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'OutputNotReadyError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export class Engine extends EventTarget {
  // events: 'time' {t}, 'state' {playing}, 'loaded' {}, 'ended' {}
  constructor({
    contextFactory = defaultContextFactory,
    outputRouterFactory = (options) => new AudioOutputRouter(options),
    createAudioElement = defaultAudioElementFactory,
  } = {}) {
    super();
    this._contextFactory = contextFactory;
    this._outputRouterFactory = outputRouterFactory;
    this._createAudioElement = createAudioElement;
    this._ctx = null;
    this._master = null;
    this._outputGain = null;
    this._outputRouter = null;
    this._outputPreferences = { outputId: SYSTEM_DEFAULT_OUTPUT, volume: 1, muted: false };
    this._outputGeneration = 0;
    this._readyOutputGeneration = -1;
    this._outputReady = null;
    this._outputFault = null;
    this._outputReconciledFrom = null;
    this._outputInterruptionHandler = null;
    this._suppressOutputState = false;
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
  async decode(arrayBuffer) {
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
    let buffer = null;
    if (plan.rate > ctx.sampleRate && probe.seconds > 0) {
      try {
        const frames = Math.max(1, Math.ceil(plan.rate * probe.seconds));
        const offline = new OfflineAudioContext(
          Math.max(1, probe.channels || 2), frames, plan.rate,
        );
        // On a COPY, deliberately. decodeAudioData detaches its input even when
        // it rejects, so decoding the caller's buffer here would leave the
        // fallback below with zero bytes and turn a recoverable native-rate
        // failure into a file that will not load at all.
        buffer = await offline.decodeAudioData(arrayBuffer.slice(0));
      } catch (error) {
        buffer = null;   // fall through to the context decode below
      }
    }
    if (!buffer) buffer = await ctx.decodeAudioData(arrayBuffer);
    return {
      buffer,
      mono: mixdownMono(buffer),
      decodeReport: {
        nativeRate: probe.sampleRate,
        decodedRate: buffer.sampleRate,
        downgraded: !!(probe.sampleRate && buffer.sampleRate < probe.sampleRate),
        reason: plan.reason,
      },
    };
  }

  // Decoding may take long enough to race with source selection. Installing is
  // deliberately the short commit point: it either accepts one complete
  // prepared source or leaves the active transport untouched.
  install(prepared) {
    let source;
    try {
      source = {
        buffer: prepared.buffer,
        mono: prepared.mono,
        decodeReport: prepared.decodeReport,
      };
      if (!isPreparedSource(source)) return false;
    } catch (error) {
      return false;
    }
    this._haltPlayback();
    this._buffer = source.buffer;
    this._mono = source.mono;
    this.decodeReport = source.decodeReport;
    this._alt = null;
    this._lastCuts = [];
    this._position = 0;
    this.dispatchEvent(new CustomEvent('loaded', { detail: {} }));
    return true;
  }

  captureInstalled() {
    if (!this._buffer) {
      return {
        buffer: null,
        mono: null,
        alt: null,
        position: 0,
        lastCuts: [],
        decodeReport: undefined,
      };
    }
    return {
      buffer: this._buffer,
      mono: this._mono,
      alt: this._alt,
      position: this.currentTime,
      lastCuts: this._lastCuts,
      decodeReport: this.decodeReport,
    };
  }

  restoreInstalled(checkpoint) {
    try {
      const installed = {
        buffer: checkpoint.buffer,
        mono: checkpoint.mono,
        alt: checkpoint.alt,
        position: checkpoint.position,
        lastCuts: checkpoint.lastCuts,
        decodeReport: checkpoint.decodeReport,
      };
      if (!isInstalledCheckpoint(installed)) return false;
      this._haltPlayback();
      this._buffer = installed.buffer;
      this._mono = installed.mono;
      this._alt = installed.alt;
      this._position = installed.position;
      this._lastCuts = installed.lastCuts;
      this.decodeReport = installed.decodeReport;
      this._segs = [];
      this._totalKept = 0;
      return true;
    } catch (error) {
      return false;
    }
  }

  // Legacy callers still receive the old decode-and-replace operation until
  // source sessions own source switching.
  async load(arrayBuffer) {
    const prepared = await this.decode(arrayBuffer);
    this.install(prepared);
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
  get outputGeneration() { return this._outputGeneration; }
  get outputMeterSource() { return this._outputGain; }
  get outputState() {
    const route = this._outputRouter?.state;
    const state = route ? { ...route } : {
      requested: this._outputPreferences.outputId,
      active: null,
      mechanism: null,
      status: 'idle',
      volume: this._outputPreferences.volume,
      muted: this._outputPreferences.muted,
      safetyMuted: false,
      error: null,
    };
    if (this._outputFault) {
      state.status = 'fault';
      state.error = this._outputFault.code;
    }
    if (this._outputReconciledFrom) state.reconciledFrom = this._outputReconciledFrom;
    return Object.freeze(state);
  }

  get readyContext() {
    const route = this._outputRouter?.state;
    if (!this._ctx || this._ctx.state !== 'running' ||
        this._readyOutputGeneration !== this._outputGeneration ||
        route?.status !== 'ready' || !route.active) {
      throw new OutputNotReadyError('OUTPUT_NOT_READY');
    }
    return this._ctx;
  }

  configureOutputPreferences(preferences) {
    this._outputPreferences = outputPreferences(preferences, this._outputPreferences);
    if (this._outputRouter) this._applyOutputPreferences();
    return Object.freeze({ ...this._outputPreferences });
  }

  setOutputVolume(value) {
    this.configureOutputPreferences({ volume: value });
  }

  setOutputMuted(muted) {
    this.configureOutputPreferences({ muted });
  }

  setOutputInterruptionHandler(handler) {
    if (handler !== null && typeof handler !== 'function') {
      throw new TypeError('Audio output interruption handler must be a function or null');
    }
    this._outputInterruptionHandler = handler;
  }

  async ensureOutputReady() {
    const ctx = this._ensureCtx(); // Must happen synchronously in the user gesture.
    if (this._isOutputReady(ctx)) return this.outputState;
    if (this._outputReady) return this._outputReady;
    const generation = this._outputGeneration;
    const ready = this._completeOutputReadiness(ctx, generation);
    this._outputReady = ready;
    try {
      return await ready;
    } finally {
      if (this._outputReady === ready) this._outputReady = null;
    }
  }

  async selectOutput(deviceId) {
    if (typeof deviceId !== 'string' || deviceId.length === 0) {
      throw new TypeError('Audio output deviceId must be a non-empty string');
    }
    await this.ensureOutputReady();
    const generation = this._outputGeneration;
    try {
      const route = await this._outputRouter.select(deviceId);
      if (generation !== this._outputGeneration || this._ctx.state !== 'running') {
        throw new OutputNotReadyError('OUTPUT_NOT_READY');
      }
      this._outputPreferences = { ...this._outputPreferences, outputId: deviceId };
      this._outputFault = null;
      this._outputReconciledFrom = null;
      this._outputRouter.clearSafetyMute();
      this._readyOutputGeneration = generation;
      this._emitOutputState();
      return route.status === 'ready' ? this.outputState : Object.freeze({ ...this.outputState });
    } catch (error) {
      if (error instanceof OutputNotReadyError) throw error;
      throw new OutputNotReadyError('OUTPUT_NOT_READY', error);
    }
  }

  handleOutputLoss(code = 'OUTPUT_LOST') {
    this._outputGeneration++;
    this._readyOutputGeneration = -1;
    this._outputReady = null;
    this._outputFault = null;
    this._suppressOutputState = true;
    try {
      if (this._outputRouter) this._outputRouter.failClosed(code);
    } finally {
      this._suppressOutputState = false;
    }
    try {
      this._outputInterruptionHandler?.(code);
    } catch { /* an interruption handler cannot suppress fail-closed output */ }
    this._emitOutputState();
    return this.outputState;
  }

  async testOutput() {
    const route = await this.ensureOutputReady();
    if (route.status !== 'ready') throw new OutputNotReadyError('OUTPUT_NOT_READY');
    const ctx = this.readyContext;
    const merger = ctx.createChannelMerger(2);
    merger.connect(this._master);
    let remaining = 2;
    for (const [channel, frequency] of [[0, 440], [1, 660]]) {
      const start = ctx.currentTime + channel * TEST_SIGNAL_HALF;
      const stop = start + TEST_SIGNAL_HALF;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(TEST_SIGNAL_PEAK, start + TEST_SIGNAL_RAMP);
      gain.gain.setValueAtTime(TEST_SIGNAL_PEAK, stop - TEST_SIGNAL_RAMP);
      gain.gain.linearRampToValueAtTime(0, stop);
      oscillator.connect(gain);
      gain.connect(merger, 0, channel);
      oscillator.onended = () => {
        try { oscillator.disconnect(); } catch { /* disconnected already */ }
        try { gain.disconnect(); } catch { /* disconnected already */ }
        remaining--;
        if (remaining === 0) {
          try { merger.disconnect(this._master); } catch { /* disconnected already */ }
        }
      };
      oscillator.start(start);
      oscillator.stop(stop);
    }
    return true;
  }

  // Temporary internal compatibility path through Task 3. New callers must
  // await ensureOutputReady() instead, so resume and sink failures are visible.
  wake() {
    const ctx = this._ensureCtx();
    resumeContext(ctx);
    this._outputRouter.select(this._outputPreferences.outputId).catch(() => {});
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
      this._ctx = this._contextFactory();
      this._master = this._ctx.createGain();
      this._outputGain = this._ctx.createGain();
      this._master.connect(this._outputGain);
      this._outputRouter = this._outputRouterFactory({
        context: this._ctx,
        input: this._outputGain,
        createAudioElement: this._createAudioElement,
      });
      this._outputRouter.addEventListener('statechange', () => {
        if (!this._suppressOutputState) this._emitOutputState();
      });
      this._ctx.addEventListener?.('statechange', () => this._observeContextState());
      this._applyOutputPreferences();
    }
    return this._ctx;
  }

  _applyOutputPreferences() {
    this._outputRouter.setVolume(this._outputPreferences.volume);
    this._outputRouter.setMuted(this._outputPreferences.muted);
  }

  _isOutputReady(ctx) {
    return ctx?.state === 'running' && this._readyOutputGeneration === this._outputGeneration &&
      this._outputRouter?.state.status === 'ready';
  }

  async _completeOutputReadiness(ctx, generation) {
    try {
      this._applyOutputPreferences();
      if (ctx.state === 'suspended') await ctx.resume();
      if (ctx.state !== 'running' || generation !== this._outputGeneration) {
        throw new OutputNotReadyError('OUTPUT_NOT_READY');
      }
      const requested = this._outputPreferences.outputId;
      try {
        await this._outputRouter.select(requested);
      } catch (error) {
        if (this._readyOutputGeneration >= 0) throw error;
        await this._outputRouter.select(SYSTEM_DEFAULT_OUTPUT);
        this._outputPreferences = { ...this._outputPreferences, outputId: SYSTEM_DEFAULT_OUTPUT };
        this._outputReconciledFrom = requested;
      }
      if (ctx.state !== 'running' || generation !== this._outputGeneration) {
        throw new OutputNotReadyError('OUTPUT_NOT_READY');
      }
      const route = this._outputRouter.state;
      if (!route.active) throw new OutputNotReadyError('OUTPUT_NOT_READY');
      this._outputRouter.clearSafetyMute();
      this._outputFault = null;
      this._readyOutputGeneration = generation;
      this._emitOutputState();
      return this.outputState;
    } catch (error) {
      if (generation === this._outputGeneration) {
        this._readyOutputGeneration = -1;
        this._outputFault = error instanceof OutputNotReadyError ? error :
          new OutputNotReadyError('OUTPUT_NOT_READY', error);
        this._suppressOutputState = true;
        try { this._outputRouter.failClosed('OUTPUT_NOT_READY'); } finally { this._suppressOutputState = false; }
        this._emitOutputState();
      }
      if (error instanceof OutputNotReadyError) throw error;
      throw new OutputNotReadyError('OUTPUT_NOT_READY', error);
    }
  }

  _observeContextState() {
    const state = this._ctx?.state;
    if (state === 'suspended') this.handleOutputLoss('OUTPUT_SUSPENDED');
    else if (state === 'interrupted') this.handleOutputLoss('OUTPUT_INTERRUPTED');
    else if (state === 'closed') this.handleOutputLoss('OUTPUT_CLOSED');
  }

  _emitOutputState() {
    this.dispatchEvent(new CustomEvent('outputstate', { detail: this.outputState }));
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

function isAudioBufferLike(buffer) {
  return !!buffer
    && Number.isFinite(buffer.length) && buffer.length >= 0
    && Number.isFinite(buffer.sampleRate) && buffer.sampleRate > 0
    && Number.isFinite(buffer.numberOfChannels) && buffer.numberOfChannels > 0
    && typeof buffer.getChannelData === 'function';
}

function bufferDuration(buffer) {
  if (Number.isFinite(buffer.duration) && buffer.duration >= 0) return buffer.duration;
  return buffer.length / buffer.sampleRate;
}

function hasValidCuts(cuts, duration) {
  if (!Array.isArray(cuts)) return false;
  let previousEnd = 0;
  for (const cut of cuts) {
    if (!cut
      || !Number.isFinite(cut.start) || !Number.isFinite(cut.end)
      || cut.start < previousEnd || cut.end <= cut.start || cut.end > duration) return false;
    previousEnd = cut.end;
  }
  return true;
}

function isDecodeReport(report, buffer) {
  return !!report
    && (report.nativeRate === null || (Number.isFinite(report.nativeRate) && report.nativeRate > 0))
    && report.decodedRate === buffer.sampleRate
    && typeof report.downgraded === 'boolean'
    && (report.reason == null || typeof report.reason === 'string');
}

function isPreparedSource(prepared) {
  return !!prepared
    && isAudioBufferLike(prepared.buffer)
    && prepared.mono instanceof Float32Array
    && prepared.mono.length === prepared.buffer.length
    && isDecodeReport(prepared.decodeReport, prepared.buffer);
}

function isInstalledCheckpoint(checkpoint) {
  if (!checkpoint || !Number.isFinite(checkpoint.position) || !Array.isArray(checkpoint.lastCuts)) {
    return false;
  }
  if (checkpoint.buffer === null) {
    return checkpoint.mono === null && checkpoint.alt === null
      && checkpoint.position === 0 && checkpoint.lastCuts.length === 0
      && checkpoint.decodeReport === undefined;
  }
  return isPreparedSource(checkpoint)
    && (checkpoint.alt === null || isAudioBufferLike(checkpoint.alt))
    && checkpoint.position >= 0
    && checkpoint.position <= bufferDuration(checkpoint.alt || checkpoint.buffer)
    && hasValidCuts(checkpoint.lastCuts, bufferDuration(checkpoint.buffer));
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
