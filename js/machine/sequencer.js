import { encodeWav } from '../export.js';
import {
  compileRender,
  compileWindow,
  patternLoopSteps,
  stepTime,
} from './compile.js';

const TICK_MS = 25;
const LOOKAHEAD_SEC = 0.2;
const START_DELAY_SEC = 0.01;
const MIX_RAMP_SEC = 0.015;
const MIN_RENDER_RATE = 44100;

export class Sequencer extends EventTarget {
  constructor(engine) {
    super();
    this._engine = engine;
    this._machine = null;
    this._running = false;
    this._ctx = null;
    this._master = null;
    this._anchor = 0;
    this._scheduledUntil = 0;
    this._lastStep = -1;
    this._timer = 0;
    this._voices = new Set();
    this._strips = [];
    this._bufferCache = [];
  }

  setMachine(machine) {
    if (machine === this._machine) return;
    this._machine = machine || null;
    this._bufferCache = [];
  }

  trackBuffer(i) {
    const index = trackIndex(i);
    const ctx = this._engine && this._engine.ctx;
    const tracks = this._machine && this._machine.tracks;
    const track = index >= 0 && Array.isArray(tracks) ? tracks[index] : null;
    const sample = track && track.sample;
    if (!ctx || !sample) return null;

    const cached = this._bufferCache[index];
    if (cached && cached.ctx === ctx && cached.sample === sample) return cached.buffer;
    const buffer = createTrackBuffer(ctx, sample);
    this._bufferCache[index] = { ctx, sample, buffer };
    return buffer;
  }

  bumpTrack(i) {
    const index = trackIndex(i);
    if (index >= 0) this._bufferCache[index] = null;
  }

  start() {
    if (this._running) return;
    const ctx = this._engine && this._engine.ctx;
    const master = this._engine && this._engine.master;
    if (!ctx || !master || ctx.state === 'closed') {
      this._emitState(false);
      return;
    }

    resumeContext(ctx);
    this._ctx = ctx;
    this._master = master;
    this._anchor = ctx.currentTime + START_DELAY_SEC;
    this._scheduledUntil = 0;
    this._lastStep = -1;
    this._running = true;
    this._emitState(true);
    if (!this._running) return;
    this._tick();
    if (this._running) this._timer = setInterval(() => this._tick(), TICK_MS);
  }

  stop() {
    const wasRunning = this._running;
    this._running = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = 0;
    this._cancelVoices();
    this._resetStrips();
    this._scheduledUntil = 0;
    this._lastStep = -1;
    if (wasRunning) this._emitState(false);
  }

  trigger(i, when = 0) {
    const index = trackIndex(i);
    const ctx = this._engine && this._engine.ctx;
    const master = this._engine && this._engine.master;
    if (index < 0 || !ctx || !master || ctx.state === 'closed') return;

    const event = compileTrigger(this._machine, index);
    const buffer = event && this.trackBuffer(index);
    if (!event || !buffer) return;
    resumeContext(ctx);
    const requested = Number(when);
    const startAt = Number.isFinite(requested) && requested > 0
      ? Math.max(ctx.currentTime, requested)
      : ctx.currentTime;
    this._scheduleLiveEvent(event, startAt, buffer, ctx, master);
  }

  get running() {
    return this._running;
  }

  async renderWav(loops) {
    const compiled = compileRender(this._machine, loops);
    const sampleRate = renderSampleRate(this._machine);
    const length = Math.max(1, Math.ceil(compiled.totalSec * sampleRate));
    const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!OfflineCtx) throw new Error('OfflineAudioContext is not available');

    const ctx = new OfflineCtx(2, length, sampleRate);
    const tracks = this._machine && Array.isArray(this._machine.tracks)
      ? this._machine.tracks
      : [];
    const buffers = new Array(tracks.length);
    const strips = [];
    for (const event of compiled.events) {
      if (buffers[event.track] === undefined) {
        const track = tracks[event.track];
        buffers[event.track] = createTrackBuffer(ctx, track && track.sample);
      }
      const buffer = buffers[event.track];
      if (!buffer) continue;
      const strip = ensureStrip(strips, event.track, ctx, ctx.destination);
      applyEventMix(strip, event, event.tSec, 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(strip.gainNode);
      src.start(event.tSec);
    }
    const rendered = await ctx.startRendering();
    return encodeWav(rendered, 16);
  }

  _tick() {
    if (!this._running) return;
    const ctx = this._ctx;
    if (!ctx || ctx.state === 'closed') {
      this.stop();
      return;
    }

    const patternNow = Math.max(0, ctx.currentTime - this._anchor);
    const fromSec = Math.max(this._scheduledUntil, patternNow);
    const toSec = Math.max(fromSec, ctx.currentTime + LOOKAHEAD_SEC - this._anchor);
    const events = compileWindow(this._machine, fromSec, toSec);
    for (const event of events) {
      const buffer = this.trackBuffer(event.track);
      if (!buffer) continue;
      this._scheduleLiveEvent(
        event,
        this._anchor + event.tSec,
        buffer,
        ctx,
        this._master
      );
    }
    this._scheduledUntil = toSec;
    this._emitSteps(patternNow);
  }

  _emitSteps(patternNow) {
    const step = stepAtTime(
      patternNow,
      this._machine && this._machine.bpm,
      this._machine && this._machine.swing
    );
    const loopSteps = patternLoopSteps(this._machine && this._machine.tracks);
    if (this._lastStep < 0 || step < this._lastStep) {
      this._emitStep(step, loopSteps);
    } else {
      for (let current = this._lastStep + 1; current <= step; current++) {
        this._emitStep(current, loopSteps);
      }
    }
    this._lastStep = step;
  }

  _emitStep(step, loopSteps) {
    this.dispatchEvent(new CustomEvent('step', {
      detail: { step, loopStep: step % loopSteps },
    }));
  }

  _emitState(running) {
    this.dispatchEvent(new CustomEvent('state', { detail: { running } }));
  }

  _scheduleLiveEvent(event, when, buffer, ctx, master) {
    const strip = ensureStrip(this._strips, event.track, ctx, master);
    applyEventMix(strip, event, when, this._anchor);
    const src = ctx.createBufferSource();
    const voice = { src };
    src.buffer = buffer;
    src.connect(strip.gainNode);
    src.onended = () => this._releaseVoice(voice);
    this._voices.add(voice);
    try {
      src.start(Math.max(ctx.currentTime, when));
    } catch (e) {
      this._releaseVoice(voice);
    }
  }

  _releaseVoice(voice) {
    if (!this._voices.delete(voice)) return;
    voice.src.onended = null;
    try { voice.src.disconnect(); } catch (e) { /* already disconnected */ }
  }

  _cancelVoices() {
    for (const voice of this._voices) {
      voice.src.onended = null;
      try { voice.src.stop(); } catch (e) { /* not started or already stopped */ }
      try { voice.src.disconnect(); } catch (e) { /* already disconnected */ }
    }
    this._voices.clear();
  }

  _resetStrips() {
    const now = this._ctx && this._ctx.state !== 'closed' ? this._ctx.currentTime : 0;
    for (const strip of this._strips) {
      if (!strip) continue;
      resetParam(strip.gainNode.gain, 1, now);
      resetParam(strip.panNode.pan, 0, now);
      strip.mixSet = false;
      strip.gainValue = 1;
      strip.panValue = 0;
      strip.lastMixTime = now;
    }
  }
}

function compileTrigger(machine, index) {
  const sourceTracks = machine && Array.isArray(machine.tracks) ? machine.tracks : [];
  const target = sourceTracks[index];
  if (!target) return null;
  const tracks = sourceTracks.map((track, trackNumber) => {
    if (!track) return track;
    const steps = new Uint8Array(4);
    if (trackNumber === index) steps[0] = 1;
    return { ...track, steps, len: 4 };
  });
  const events = compileWindow({ ...machine, tracks }, 0, Number.EPSILON);
  return events.length ? events[0] : null;
}

function createTrackBuffer(ctx, sample) {
  if (!sample || !sample.channels || !sample.channels.length) return null;
  const sampleRate = Math.round(Number(sample.sampleRate));
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  let length = 0;
  for (const channel of sample.channels) {
    if (channel && Number.isFinite(channel.length)) length = Math.max(length, channel.length);
  }
  if (!length) return null;

  try {
    const buffer = ctx.createBuffer(sample.channels.length, length, sampleRate);
    for (let channel = 0; channel < sample.channels.length; channel++) {
      const source = sample.channels[channel];
      if (source) buffer.getChannelData(channel).set(source.subarray(0, length));
    }
    return buffer;
  } catch (e) {
    return null;
  }
}

function ensureStrip(strips, index, ctx, master) {
  const existing = strips[index];
  if (existing && existing.ctx === ctx && existing.master === master) return existing;
  if (existing) {
    try { existing.gainNode.disconnect(); } catch (e) { /* already disconnected */ }
    try { existing.panNode.disconnect(); } catch (e) { /* already disconnected */ }
  }
  const gainNode = ctx.createGain();
  const panNode = ctx.createStereoPanner();
  gainNode.connect(panNode);
  panNode.connect(master);
  const strip = {
    ctx,
    master,
    gainNode,
    panNode,
    mixSet: false,
    gainValue: 1,
    panValue: 0,
    lastMixTime: 0,
  };
  strips[index] = strip;
  return strip;
}

function applyEventMix(strip, event, when, origin) {
  const gain = Math.max(0, Number(event.gain) || 0);
  const pan = Math.max(-1, Math.min(1, Number(event.pan) || 0));
  if (!strip.mixSet) {
    const at = Math.max(0, Math.min(when, origin));
    strip.gainNode.gain.setValueAtTime(gain, at);
    strip.panNode.pan.setValueAtTime(pan, at);
    strip.mixSet = true;
  } else if (when >= strip.lastMixTime) {
    rampParam(strip.gainNode.gain, strip.gainValue, gain, when, origin);
    rampParam(strip.panNode.pan, strip.panValue, pan, when, origin);
  } else {
    strip.gainNode.gain.setValueAtTime(gain, when);
    strip.panNode.pan.setValueAtTime(pan, when);
    return;
  }
  strip.gainValue = gain;
  strip.panValue = pan;
  strip.lastMixTime = when;
}

function rampParam(param, from, to, when, origin) {
  if (from === to) return;
  const start = Math.max(origin, when - MIX_RAMP_SEC);
  param.setValueAtTime(from, start);
  param.linearRampToValueAtTime(to, when);
}

function resetParam(param, value, when) {
  try { param.cancelScheduledValues(when); } catch (e) { /* unsupported context state */ }
  try { param.setValueAtTime(value, when); } catch (e) { param.value = value; }
}

function stepAtTime(tSec, bpm, swing) {
  const pairDur = stepTime(2, bpm, swing);
  const pair = Math.max(0, Math.floor(tSec / pairDur));
  const oddStep = pair * 2 + 1;
  return tSec >= stepTime(oddStep, bpm, swing) ? oddStep : pair * 2;
}

function renderSampleRate(machine) {
  let sampleRate = MIN_RENDER_RATE;
  const tracks = machine && Array.isArray(machine.tracks) ? machine.tracks : [];
  for (const track of tracks) {
    const rate = Number(track && track.sample && track.sample.sampleRate);
    if (Number.isFinite(rate) && rate > sampleRate) sampleRate = rate;
  }
  return Math.round(sampleRate);
}

function trackIndex(value) {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : -1;
}

function resumeContext(ctx) {
  if (ctx.state !== 'suspended') return;
  try {
    const resumed = ctx.resume();
    if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {});
  } catch (e) {
    // Scheduling remains valid if the browser keeps the context suspended.
  }
}
