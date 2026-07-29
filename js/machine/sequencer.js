// Sequencer: turns compiler events into scheduled voices. LOCK rework: gain, pan,
// pitch, reverse, and gate are PER-VOICE nodes (a lock on one hit must never bend
// the tail of the previous hit — strip automation cannot do that), strips carry
// only the duck bus, and live and offline scheduling share one code path so a
// FREEZE is the performance.

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
const MIN_RENDER_RATE = 44100;
const ATTACK_SEC = 0.003;
const RELEASE_SEC = 0.008;
const CHOKE_SEC = 0.003;
// Duck pump: dip in ~5 ms, hold ~60 ms, recover with a ~180 ms tail.
const DUCK_DIP_TC = 0.0017;
const DUCK_HOLD_SEC = 0.065;
const DUCK_RELEASE_TC = 0.06;

export class Sequencer extends EventTarget {
  constructor(engine) {
    super();
    this._engine = engine;
    this._machine = null;
    this._running = false;
    this.fill = false;
    this._ctx = null;
    this._master = null;
    this._anchor = 0;
    this._scheduledUntil = 0;
    this._lastStep = -1;
    this._timer = 0;
    this._voices = new Set();
    this._lastTrackVoice = [];   // per track, for choke
    this._strips = [];
    this._bufferCache = [];
  }

  setMachine(machine) {
    if (machine === this._machine) return;
    this._machine = machine || null;
    this._bufferCache = [];
  }

  trackBuffer(i, reversed = false) {
    const index = trackIndex(i);
    const ctx = this._engine && this._engine.ctx;
    const tracks = this._machine && this._machine.tracks;
    const track = index >= 0 && Array.isArray(tracks) ? tracks[index] : null;
    const sample = track && track.sample;
    if (!ctx || !sample) return null;

    let cached = this._bufferCache[index];
    if (!cached || cached.ctx !== ctx || cached.sample !== sample) {
      cached = { ctx, sample, buffer: createTrackBuffer(ctx, sample, false), rbuffer: null };
      this._bufferCache[index] = cached;
    }
    if (!reversed) return cached.buffer;
    if (!cached.rbuffer) cached.rbuffer = createTrackBuffer(ctx, sample, true);
    return cached.rbuffer;
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

  trigger(i, when = 0, velocity = 1) {
    const index = trackIndex(i);
    const ctx = this._engine && this._engine.ctx;
    const master = this._engine && this._engine.master;
    if (index < 0 || !ctx || !master || ctx.state === 'closed') return;

    const event = compileTrigger(this._machine, index);
    if (!event) return;
    // MIDI pads carry velocity; keys always send 1. Linear amplitude scale
    // per CONTRACT-WIRE.md; zero-velocity hits were already dropped upstream.
    const v = Number(velocity);
    if (Number.isFinite(v) && v > 0 && v < 1) event.gain *= v;
    resumeContext(ctx);
    const requested = Number(when);
    const startAt = Number.isFinite(requested) && requested > 0
      ? Math.max(ctx.currentTime, requested)
      : ctx.currentTime;
    this._scheduleVoice(ctx, this._liveStrips(ctx, master), event, startAt, true);
  }

  get running() {
    return this._running;
  }

  async renderWav(loops) {
    const compiled = compileRender(this._machine, loops, { fill: false });
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
    const scheduler = {
      ctx,
      strips,
      dest: ctx.destination,
      buffer: (index, reversed) => {
        const key = reversed ? 'r' : 'f';
        if (!buffers[index]) buffers[index] = {};
        if (buffers[index][key] === undefined) {
          const track = tracks[index];
          buffers[index][key] = createTrackBuffer(ctx, track && track.sample, reversed);
        }
        return buffers[index][key];
      },
      lastTrackVoice: [],
      machine: this._machine,
    };
    for (const event of compiled.events) {
      scheduleEvent(scheduler, event, event.tSec);
    }
    for (const seg of compiled.ducks) {
      applyDuck(ensureStrip(strips, seg.track, ctx, ctx.destination), seg.tSec, seg.depthDb);
    }
    const rendered = await ctx.startRendering();
    return encodeWav(rendered, 16);
  }

  _liveStrips(ctx, master) {
    return {
      ctx,
      strips: this._strips,
      dest: master,
      buffer: (index, reversed) => this.trackBuffer(index, reversed),
      lastTrackVoice: this._lastTrackVoice,
      machine: this._machine,
      voices: this._voices,
      owner: this,
    };
  }

  _scheduleVoice(ctx, scheduler, event, when, oneShot = false) {
    scheduleEvent(scheduler, event, when, oneShot);
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
    const { events, ducks } = compileWindow(this._machine, fromSec, toSec, { fill: this.fill });
    const scheduler = this._liveStrips(ctx, this._master);
    for (const event of events) {
      scheduleEvent(scheduler, event, this._anchor + event.tSec);
    }
    for (const seg of ducks) {
      applyDuck(ensureStrip(this._strips, seg.track, ctx, this._master), this._anchor + seg.tSec, seg.depthDb);
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

  _cancelVoices() {
    for (const voice of this._voices) {
      voice.src.onended = null;
      try { voice.src.stop(); } catch (e) { /* not started or already stopped */ }
      try { voice.src.disconnect(); } catch (e) { /* already disconnected */ }
      try { voice.gainNode.disconnect(); } catch (e) { /* already disconnected */ }
      try { voice.panNode.disconnect(); } catch (e) { /* already disconnected */ }
    }
    this._voices.clear();
    this._lastTrackVoice = [];
  }

  _resetStrips() {
    const now = this._ctx && this._ctx.state !== 'closed' ? this._ctx.currentTime : 0;
    for (const strip of this._strips) {
      if (!strip) continue;
      try { strip.duckGain.gain.cancelScheduledValues(now); } catch (e) { /* fine */ }
      try { strip.duckGain.gain.setValueAtTime(1, now); } catch (e) { strip.duckGain.gain.value = 1; }
    }
  }
}

// One scheduling path for live and offline. scheduler: { ctx, strips, dest,
// buffer(index, reversed), lastTrackVoice, machine, voices?, owner? }.
function scheduleEvent(scheduler, event, when, oneShot = false) {
  const { ctx } = scheduler;
  const buffer = scheduler.buffer(event.track, !!event.reverse);
  if (!buffer || !(event.gain > 0)) return;
  const strip = ensureStrip(scheduler.strips, event.track, ctx, scheduler.dest);
  const startAt = Math.max(ctx.currentTime || 0, when);

  const gainNode = ctx.createGain();
  const panNode = ctx.createStereoPanner();
  gainNode.connect(panNode);
  panNode.connect(strip.duckGain);
  panNode.pan.value = event.pan;

  // Envelope: 3 ms attack; optional gate hold + 8 ms release.
  const g = gainNode.gain;
  g.setValueAtTime(0, startAt);
  g.linearRampToValueAtTime(event.gain, startAt + ATTACK_SEC);
  let stopAt = null;
  if (event.durSec != null) {
    const relStart = startAt + Math.max(ATTACK_SEC, event.durSec);
    g.setValueAtTime(event.gain, relStart);
    g.linearRampToValueAtTime(0, relStart + RELEASE_SEC);
    stopAt = relStart + RELEASE_SEC + 0.005;
  }

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = event.rate || 1;
  src.connect(gainNode);

  // Choke: a mono track fades its previous voice out as the new one lands.
  const tracks = scheduler.machine && scheduler.machine.tracks;
  const choke = !oneShot && tracks && tracks[event.track] && tracks[event.track].choke;
  if (choke) {
    const prev = scheduler.lastTrackVoice[event.track];
    if (prev && prev !== undefined) {
      try {
        prev.gainNode.gain.cancelScheduledValues(startAt);
        prev.gainNode.gain.setTargetAtTime(0, startAt, CHOKE_SEC / 3);
        prev.src.stop(startAt + CHOKE_SEC * 4);
      } catch (e) { /* voice already gone */ }
    }
  }

  const voice = { src, gainNode, panNode };
  if (scheduler.voices) {
    scheduler.voices.add(voice);
    src.onended = () => {
      if (!scheduler.voices.delete(voice)) return;
      src.onended = null;
      try { src.disconnect(); } catch (e) { /* fine */ }
      try { gainNode.disconnect(); } catch (e) { /* fine */ }
      try { panNode.disconnect(); } catch (e) { /* fine */ }
      if (scheduler.lastTrackVoice[event.track] === voice) {
        scheduler.lastTrackVoice[event.track] = null;
      }
    };
  }
  scheduler.lastTrackVoice[event.track] = voice;

  try {
    src.start(startAt);
    if (stopAt != null) src.stop(stopAt);
  } catch (e) {
    if (scheduler.voices) scheduler.voices.delete(voice);
  }
}

function applyDuck(strip, when, depthDb) {
  const depth = Math.pow(10, -Math.max(0, Math.min(24, depthDb)) / 20);
  const p = strip.duckGain.gain;
  const at = Math.max(0, when);
  try {
    p.cancelScheduledValues(at);
    p.setTargetAtTime(depth, at, DUCK_DIP_TC);
    p.setTargetAtTime(1, at + DUCK_HOLD_SEC, DUCK_RELEASE_TC);
  } catch (e) { /* context closing */ }
}

function compileTrigger(machine, index) {
  const sourceTracks = machine && Array.isArray(machine.tracks) ? machine.tracks : [];
  const target = sourceTracks[index];
  if (!target) return null;
  const tracks = sourceTracks.map((track, trackNumber) => {
    if (!track) return track;
    const steps = new Uint8Array(4);
    if (trackNumber === index) steps[0] = 1;
    // A pad hit ignores per-step data: it auditions the raw voice.
    return { ...track, steps, stepData: {}, len: 4 };
  });
  const { events } = compileWindow({ ...machine, tracks }, 0, Number.EPSILON);
  return events.length ? events[0] : null;
}

function createTrackBuffer(ctx, sample, reversed = false) {
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
      if (!source) continue;
      const dest = buffer.getChannelData(channel);
      if (!reversed) {
        dest.set(source.subarray(0, length));
      } else {
        const n = Math.min(source.length, length);
        for (let i = 0; i < n; i++) dest[i] = source[n - 1 - i];
      }
    }
    return buffer;
  } catch (e) {
    return null;
  }
}

function ensureStrip(strips, index, ctx, dest) {
  const existing = strips[index];
  if (existing && existing.ctx === ctx && existing.dest === dest) return existing;
  if (existing) {
    try { existing.duckGain.disconnect(); } catch (e) { /* already disconnected */ }
  }
  const duckGain = ctx.createGain();
  duckGain.connect(dest);
  const strip = { ctx, dest, duckGain };
  strips[index] = strip;
  return strip;
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
