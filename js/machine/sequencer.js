// Sequencer: turns compiler events into scheduled voices. LOCK rework: gain, pan,
// pitch, reverse, and gate are PER-VOICE nodes (a lock on one hit must never bend
// the tail of the previous hit — strip automation cannot do that), strips carry
// only the duck bus, and live and offline scheduling share one code path so a
// FREEZE is the performance.

import { encodeWav, encodeWavWithStats } from '../export.js';
import {
  compileRender,
  compileSong,
  compileWindow,
  patternLoopSteps,
  stepTime,
} from './compile.js';

const TICK_MS = 25;
const LOOKAHEAD_SEC = 0.2;
const START_DELAY_SEC = 0.01;
const MIN_RENDER_RATE = 44100;
// Voice envelope defaults (CONTRACT-SONG 1): used when an event carries no
// attackSec/releaseSec of its own.
const ATTACK_SEC = 0.003;
const RELEASE_SEC = 0.008;
const STOP_PAD_SEC = 0.005;
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
    this._songPlaying = false;
    this._song = null;
    this._songTimer = 0;
    this._songAnchor = 0;
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
    this.stopSong();   // pattern and song transports are exclusive (CONTRACT-SONG 2)
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

  // ---- song transport (CONTRACT-SONG 2): one precompiled stream feeds the
  // same lookahead pass and scheduleEvent path that pattern play uses. ----

  playSong() {
    if (this._songPlaying) return;
    this.stop();   // song and pattern transports are exclusive
    const ctx = this._engine && this._engine.ctx;
    const master = this._engine && this._engine.master;
    if (!ctx || !master || ctx.state === 'closed') return;
    const compiled = compileSong(this._machine, { fill: false });
    if (!compiled.sections.length || !(compiled.totalSec > 0)) return;

    resumeContext(ctx);
    this._ctx = ctx;
    this._master = master;
    const scenes = this._machine && Array.isArray(this._machine.scenes)
      ? this._machine.scenes
      : [];
    // Buffer cache keyed on the whole sample object: trim plays through
    // src.start offsets, never by baking new buffers.
    const cache = new Map();
    this._song = {
      compiled,
      schedulers: compiled.sections.map(
        (section) => this._songScheduler(ctx, master, scenes, section.scene, cache),
      ),
      until: 0,
      pass: 0,
      evPass: 0,
      evIdx: 0,
      evSec: 0,
      duckPass: 0,
      duckIdx: 0,
      posSection: -1,
      posRep: -1,
    };
    this._songAnchor = ctx.currentTime + START_DELAY_SEC;
    this._songPlaying = true;
    this._songTick();
    if (this._songPlaying) this._songTimer = setInterval(() => this._songTick(), TICK_MS);
  }

  stopSong() {
    const wasPlaying = this._songPlaying;
    this._songPlaying = false;
    if (this._songTimer) clearInterval(this._songTimer);
    this._songTimer = 0;
    this._song = null;
    if (wasPlaying) {
      this._cancelVoices();
      this._resetStrips();
    }
  }

  get songPlaying() {
    return this._songPlaying;
  }

  async renderSongWav(bitDepth = 24) {
    const compiled = compileSong(this._machine, { fill: false });
    const scenes = this._machine && Array.isArray(this._machine.scenes)
      ? this._machine.scenes
      : [];
    const sampleRate = songSampleRate(scenes, compiled.sections);
    const length = Math.max(1, Math.ceil(compiled.totalSec * sampleRate));
    const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!OfflineCtx) throw new Error('OfflineAudioContext is not available');

    const ctx = new OfflineCtx(2, length, sampleRate);
    const cache = new Map();
    const strips = [];
    const lastTrackVoice = [];
    const schedulers = compiled.sections.map((section) => {
      const scene = scenes[section.scene];
      const tracks = scene && Array.isArray(scene.tracks) ? scene.tracks : [];
      return {
        ctx,
        strips,
        dest: ctx.destination,
        buffer: (index, reversed) => songBuffer(ctx, cache, tracks, index, reversed),
        lastTrackVoice,
        machine: { tracks },
      };
    });
    let sec = 0;
    for (const event of compiled.events) {
      while (sec < compiled.sections.length - 1 && event.tSec >= compiled.sections[sec].endSec) sec++;
      scheduleEvent(schedulers[sec], event, event.tSec);
    }
    for (const seg of compiled.ducks) {
      applyDuck(ensureStrip(strips, seg.track, ctx, ctx.destination), seg.tSec, seg.depthDb);
    }
    const rendered = await ctx.startRendering();
    const { blob, stats } = encodeWavWithStats(rendered, bitDepth === 16 ? 16 : 24);
    return { bytes: await blob.arrayBuffer(), stats, totalSec: compiled.totalSec };
  }

  _songScheduler(ctx, master, scenes, sceneIndex, cache) {
    const scene = scenes[sceneIndex];
    const tracks = scene && Array.isArray(scene.tracks) ? scene.tracks : [];
    return {
      ctx,
      strips: this._strips,
      dest: master,
      buffer: (index, reversed) => songBuffer(ctx, cache, tracks, index, reversed),
      lastTrackVoice: this._lastTrackVoice,
      machine: { tracks },
      voices: this._voices,
      owner: this,
    };
  }

  _songTick() {
    if (!this._songPlaying || !this._song) return;
    const ctx = this._ctx;
    if (!ctx || ctx.state === 'closed') {
      this.stopSong();
      return;
    }
    const song = this._song;
    const total = song.compiled.totalSec;
    const loop = !!(this._machine && this._machine.song && this._machine.song.loop);
    const songNow = Math.max(0, ctx.currentTime - this._songAnchor);

    if (songNow >= (song.pass + 1) * total) {
      this._emitSongEnd();
      if (!loop) {
        this.stopSong();
        return;
      }
      // Re-anchor per pass: the precompiled stream replays one pass later.
      while ((song.pass + 1) * total <= songNow) song.pass++;
    }

    const from = Math.max(song.until, songNow);
    let to = ctx.currentTime + LOOKAHEAD_SEC - this._songAnchor;
    if (!loop) to = Math.min(to, (song.pass + 1) * total);
    if (to > from) {
      this._songSchedule(from, to);
      song.until = to;
    }
    this._emitSongPos(songNow - song.pass * total);
  }

  // Schedules the precompiled stream over the absolute song-time window
  // [from, to), wrapping passes when the song loops. Cursors persist across
  // ticks so each event schedules exactly once.
  _songSchedule(from, to) {
    const song = this._song;
    const { events, ducks, sections, totalSec } = song.compiled;

    let pass = song.evPass;
    let i = song.evIdx;
    let sec = song.evSec;
    while (pass * totalSec < to) {
      if (i >= events.length) {
        pass++;
        i = 0;
        sec = 0;
        continue;
      }
      const at = pass * totalSec + events[i].tSec;
      if (at >= to) break;
      if (at >= from) {
        while (sec < sections.length - 1 && events[i].tSec >= sections[sec].endSec) sec++;
        scheduleEvent(song.schedulers[sec], events[i], this._songAnchor + at);
      }
      i++;
    }
    song.evPass = pass;
    song.evIdx = i;
    song.evSec = sec;

    let duckPass = song.duckPass;
    let d = song.duckIdx;
    while (duckPass * totalSec < to) {
      if (d >= ducks.length) {
        duckPass++;
        d = 0;
        continue;
      }
      const at = duckPass * totalSec + ducks[d].tSec;
      if (at >= to) break;
      if (at >= from) {
        applyDuck(
          ensureStrip(this._strips, ducks[d].track, this._ctx, this._master),
          this._songAnchor + at,
          ducks[d].depthDb,
        );
      }
      d++;
    }
    song.duckPass = duckPass;
    song.duckIdx = d;
  }

  _emitSongPos(wrapped) {
    const song = this._song;
    if (!song) return;
    const sections = song.compiled.sections;
    let index = 0;
    while (index < sections.length - 1 && wrapped >= sections[index].endSec) index++;
    const section = sections[index];
    const rep = Math.max(0, Math.min(
      section.reps - 1,
      Math.floor((wrapped - section.startSec) / section.loopSec),
    ));
    if (index === song.posSection && rep === song.posRep) return;
    song.posSection = index;
    song.posRep = rep;
    this.dispatchEvent(new CustomEvent('songpos', { detail: { section: index, rep } }));
  }

  _emitSongEnd() {
    this.dispatchEvent(new CustomEvent('songend'));
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

// Pure envelope plan, seconds relative to voice start; exported so the
// harness can pin it without Web Audio. CONTRACT-SONG 1: attack ramp over
// attackSec, then a release ramp that ENDS at the effective wall end
// (min of gate wall and sliceSec/rate), clamped so it never starts before
// the attack peak. Every voice declicks at its end.
export function planEnvelope(event, bufferSec = Infinity) {
  const rate = event && event.rate > 0 ? event.rate : 1;
  const attackSec = event && event.attackSec != null ? event.attackSec : ATTACK_SEC;
  const releaseSec = event && event.releaseSec != null ? event.releaseSec : RELEASE_SEC;
  const spanSec = event && event.sliceSec != null ? event.sliceSec : bufferSec;
  let wallEnd = spanSec / rate;
  if (event && event.durSec != null) wallEnd = Math.min(wallEnd, event.durSec);
  if (!Number.isFinite(wallEnd)) {
    return { attackSec, releaseSec, releaseStartSec: null, releaseEndSec: null, stopSec: null };
  }
  const releaseStartSec = Math.max(attackSec, wallEnd - releaseSec);
  const releaseEndSec = Math.max(wallEnd, releaseStartSec);
  return { attackSec, releaseSec, releaseStartSec, releaseEndSec, stopSec: releaseEndSec + STOP_PAD_SEC };
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

  const plan = planEnvelope(event, buffer.duration);
  const g = gainNode.gain;
  g.setValueAtTime(0, startAt);
  g.linearRampToValueAtTime(event.gain, startAt + plan.attackSec);
  let stopAt = null;
  if (plan.releaseEndSec != null) {
    g.setValueAtTime(event.gain, startAt + plan.releaseStartSec);
    g.linearRampToValueAtTime(0, startAt + plan.releaseEndSec);
    stopAt = startAt + plan.stopSec;
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
    if (event.sliceSec != null) {
      // Trim plays through offset/duration (buffer-domain seconds); the
      // reversed buffer is the whole sample baked backwards, never re-sliced.
      src.start(startAt, Math.max(0, event.offsetSec || 0), event.sliceSec);
    } else {
      src.start(startAt);
    }
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

// Per-song buffer resolution: samples come from the section's own scene, and
// the forward/reversed AudioBuffers cache on the whole sample object.
function songBuffer(ctx, cache, tracks, index, reversed) {
  const track = tracks[index];
  const sample = track && track.sample;
  if (!ctx || !sample) return null;
  let entry = cache.get(sample);
  if (!entry || entry.ctx !== ctx) {
    entry = { ctx, forward: createTrackBuffer(ctx, sample, false), reversed: null };
    cache.set(sample, entry);
  }
  if (!reversed) return entry.forward;
  if (!entry.reversed) entry.reversed = createTrackBuffer(ctx, sample, true);
  return entry.reversed;
}

// Highest sample rate across every scene the chain visits (>= 44100).
function songSampleRate(scenes, sections) {
  let sampleRate = MIN_RENDER_RATE;
  for (const section of sections) {
    const scene = scenes[section.scene];
    const tracks = scene && Array.isArray(scene.tracks) ? scene.tracks : [];
    for (const track of tracks) {
      const rate = Number(track && track.sample && track.sample.sampleRate);
      if (Number.isFinite(rate) && rate > sampleRate) sampleRate = rate;
    }
  }
  return Math.round(sampleRate);
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
