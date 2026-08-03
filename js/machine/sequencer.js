// Sequencer: turns compiler events into scheduled voices. LOCK rework: gain, pan,
// pitch, reverse, and gate are PER-VOICE nodes (a lock on one hit must never bend
// the tail of the previous hit — strip automation cannot do that), strips carry
// only the duck bus, and live and offline scheduling share one code path so a
// FREEZE is the performance.

import { encodeWav, encodeWavWithStats } from '../export.js';
import { stretchSamples } from '../dsp/stretch.js';
import { plateImpulse, delayTimeFor, dampingCoeff } from '../dsp/space.js';
import { processLimiter } from '../dsp/limiter.js';
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
// COLOR (CONTRACT-HARVEST 2): highpass Butterworth Q. THE Q TRAP (TRUTH 1):
// WebAudio lowpass/highpass BiquadFilterNode Q is IN dB, not a linear Q
// factor. Butterworth is 20*log10(1/sqrt(2)) = -3.0103 dB, NOT 0.7071.
const HPF_BUTTERWORTH_Q_DB = -3.0103;
const DRIVE_CURVE_POINTS = 2048;
const driveCurves = new Map();

// Tanh drive curve, k = 10^(driveDb/20), normalized by 1/tanh(k) so a
// unity-peak input stays unity (CONTRACT-HARVEST 2). Cached per driveDb;
// exported so the harness can pin the unity property without Web Audio.
export function driveCurve(driveDb) {
  let curve = driveCurves.get(driveDb);
  if (curve) return curve;
  const k = Math.pow(10, driveDb / 20);
  const norm = 1 / Math.tanh(k);
  curve = new Float32Array(DRIVE_CURVE_POINTS);
  for (let i = 0; i < DRIVE_CURVE_POINTS; i++) {
    const x = (i / (DRIVE_CURVE_POINTS - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) * norm;
  }
  driveCurves.set(driveDb, curve);
  return curve;
}

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
    this._rack = null;
  }

  setMachine(machine) {
    if (machine === this._machine) return;
    this._machine = machine || null;
    this._bufferCache = [];
  }

  trackBuffer(i, reversed = false, fitSec = null, offsetSec = 0, sliceSec = 0) {
    const index = trackIndex(i);
    const ctx = this._engine && this._engine.ctx;
    const tracks = this._machine && this._machine.tracks;
    const track = index >= 0 && Array.isArray(tracks) ? tracks[index] : null;
    const sample = track && track.sample;
    if (!ctx || !sample) return null;

    let cached = this._bufferCache[index];
    if (!cached || cached.ctx !== ctx || cached.sample !== sample) {
      cached = { ctx, sample, buffer: createTrackBuffer(ctx, sample, false), rbuffer: null, fitted: new Map() };
      this._bufferCache[index] = cached;
    }
    if (fitSec > 0) {
      const key = fitKey(reversed, fitSec, offsetSec, sliceSec);
      if (!cached.fitted.has(key)) {
        let baked = null;
        try {
          baked = createFittedBuffer(ctx, sample, reversed, fitSec, offsetSec, sliceSec);
        } catch (e) { baked = null; }
        cached.fitted.set(key, baked);
      }
      const fittedBuffer = cached.fitted.get(key);
      if (fittedBuffer) return fittedBuffer;
      // bake failed: fall through to the natural-speed buffer, never drop the voice
    }
    if (!reversed) return cached.buffer;
    if (!cached.rbuffer) cached.rbuffer = createTrackBuffer(ctx, sample, true);
    return cached.rbuffer;
  }

  // Bake every fitted buffer the current machine needs BEFORE transport starts.
  // Baking costs tens of milliseconds per slice, which is fine here and would
  // be a dropped audio frame inside the scheduler (CONTRACT-CONFORM 3).
  prebake(scenes) {
    const ctx = this._engine && this._engine.ctx;
    if (!ctx || !this._machine) return;
    const list = Array.isArray(scenes) && scenes.length
      ? scenes
      : [{ tracks: this._machine.tracks, bpm: this._machine.bpm }];
    for (const scene of list) {
      const tracks = scene && scene.tracks;
      if (!Array.isArray(tracks)) continue;
      const bpm = scene.bpm > 0 ? scene.bpm : 120;
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        const steps = track && track.voice ? track.voice.fitSteps : 0;
        if (!track || !track.sample || !(steps > 0)) continue;
        const fitSec = steps * (60 / bpm / 4);
        const v = track.voice;
        const bufSec = track.sample.channels[0]
          ? track.sample.channels[0].length / track.sample.sampleRate : 0;
        const trimmed = (v.start > 0 || v.end < 1) && bufSec > 0;
        const sliceSec = trimmed ? (v.end - v.start) * bufSec : 0;
        const fwdOffset = trimmed ? v.start * bufSec : 0;
        const revOffset = trimmed ? (1 - v.end) * bufSec : 0;
        // A step lock can flip reverse on a track whose voice is forward, so
        // both directions get baked whenever any lock asks for it.
        let anyReverseLock = false;
        const data = track.stepData || {};
        for (const key of Object.keys(data)) {
          if (data[key] && data[key].reverse) { anyReverseLock = true; break; }
        }
        this.trackBuffer(i, false, fitSec, fwdOffset, sliceSec);
        if (v.reverse || anyReverseLock) this.trackBuffer(i, true, fitSec, revOffset, sliceSec);
      }
    }
  }

  // One live rack per context/destination. Rebuilt when the space settings or
  // tempo change, since the plate impulse and delay time are baked from them.
  _liveRack(ctx, dest) {
    const space = (this._machine && this._machine.space) || {};
    const bpm = (this._machine && this._machine.bpm) || 120;
    const sig = [ctx.sampleRate, space.verbSec, space.verbDecay, space.verbMix,
      space.delayDivision, space.delayFeedback, space.delayMix, bpm].join('|');
    if (this._rack && this._rack.ctx === ctx && this._rack.dest === dest && this._rack.sig === sig) {
      return this._rack;
    }
    const rack = createSpaceRack(ctx, dest, space, bpm);
    rack.sig = sig;
    // Existing strips still feed the OLD rack's inputs, so their sends would
    // play into a graph nothing listens to. Rebuild them against the new one.
    if (this._rack) this.bumpStrips();
    this._rack = rack;
    return rack;
  }

  bumpTrack(i) {
    const index = trackIndex(i);
    if (index >= 0) this._bufferCache[index] = null;
  }

  // Send AMOUNTS are automated now, not baked, so they no longer need this.
  // What still does is a rack swap: the old strips' send nodes are wired to
  // the previous rack's inputs, and nothing downstream is listening to those.
  bumpStrips() {
    this._resetStrips();
    this._strips = [];
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
    this.prebake();   // fitted buffers cost tens of ms: never inside the scheduler
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
    // FREEZE prints the performance: if FILL was held, those hits are part
    // of what was heard (Codex finding 7, verified compile-side).
    const compiled = compileRender(this._machine, loops, { fill: !!this.fill });
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
      tracks,
      rack: createSpaceRack(ctx, ctx.destination, this._machine && this._machine.space,
        this._machine && this._machine.bpm),
      buffer: (index, reversed, fitSec, offsetSec, sliceSec) => {
        const key = (fitSec > 0 ? fitKey(reversed, fitSec, offsetSec, sliceSec) : (reversed ? 'r' : 'f'));
        if (!buffers[index]) buffers[index] = {};
        if (buffers[index][key] === undefined) {
          const track = tracks[index];
          const sample = track && track.sample;
          let baked = null;
          if (sample && fitSec > 0) {
            try {
              baked = createFittedBuffer(ctx, sample, reversed, fitSec, offsetSec, sliceSec);
            } catch (e) { baked = null; }
          }
          buffers[index][key] = baked || createTrackBuffer(ctx, sample, reversed);
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
      // scheduler.tracks / scheduler.rack, not the song render's locals: those
      // are a different function's scope and threw ReferenceError here, so any
      // project with a duck routing could not FREEZE at all.
      applyDuck(ensureStrip(strips, seg.track, ctx, ctx.destination,
        scheduler.tracks[seg.track], scheduler.rack, seg.tSec), seg.tSec, seg.depthDb);
    }
    const rendered = await ctx.startRendering();
    return encodeWav(await masterLimit(rendered), 16);
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
    this.prebake(this._machine && this._machine.scenes);
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
    const songRack = createSpaceRack(ctx, ctx.destination, this._machine && this._machine.space,
      this._machine && this._machine.bpm);
    const schedulers = compiled.sections.map((section) => {
      const scene = scenes[section.scene];
      const tracks = scene && Array.isArray(scene.tracks) ? scene.tracks : [];
      return {
        ctx,
        strips,
        dest: ctx.destination,
        tracks,
        rack: songRack,
        buffer: (index, reversed, fitSec, offsetSec, sliceSec) =>
        songBuffer(ctx, cache, tracks, index, reversed, fitSec, offsetSec, sliceSec),
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
      // `tracks` only exists inside the per-section map above, so it was out of
      // scope here and threw. Resolve the section this duck falls in and use
      // that section's tracks, which is what the duck actually applies to.
      let di = 0;
      while (di < compiled.sections.length - 1 && seg.tSec >= compiled.sections[di].endSec) di++;
      const dScene = scenes[compiled.sections[di].scene];
      const dTracks = dScene && Array.isArray(dScene.tracks) ? dScene.tracks : [];
      applyDuck(ensureStrip(strips, seg.track, ctx, ctx.destination,
        dTracks[seg.track], songRack, seg.tSec), seg.tSec, seg.depthDb);
    }
    const rendered = await ctx.startRendering();
    const mastered = await masterLimit(rendered);
    const { blob, stats } = encodeWavWithStats(mastered, bitDepth === 16 ? 16 : 24);
    return { bytes: await blob.arrayBuffer(), stats, totalSec: compiled.totalSec };
  }

  _songScheduler(ctx, master, scenes, sceneIndex, cache) {
    const scene = scenes[sceneIndex];
    const tracks = scene && Array.isArray(scene.tracks) ? scene.tracks : [];
    return {
      ctx,
      strips: this._strips,
      dest: master,
      tracks,
      rack: this._liveRack(ctx, master),
      buffer: (index, reversed, fitSec, offsetSec, sliceSec) =>
        songBuffer(ctx, cache, tracks, index, reversed, fitSec, offsetSec, sliceSec),
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
          ensureStrip(this._strips, ducks[d].track, this._ctx, this._master,
            this._machine && this._machine.tracks && this._machine.tracks[ducks[d].track],
            this._liveRack(this._ctx, this._master), this._songAnchor + at),
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
      rack: this._liveRack(ctx, this._master),
      buffer: (index, reversed, fitSec, offsetSec, sliceSec) =>
        this.trackBuffer(index, reversed, fitSec, offsetSec, sliceSec),
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
      applyDuck(ensureStrip(this._strips, seg.track, ctx, this._master,
        this._machine && this._machine.tracks && this._machine.tracks[seg.track],
        this._liveRack(ctx, this._master), this._anchor + seg.tSec),
      this._anchor + seg.tSec, seg.depthDb);
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
      disconnectColor(voice);
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
  const fitted = event.fitSec > 0;
  const buffer = scheduler.buffer(event.track, !!event.reverse, event.fitSec || null,
    event.offsetSec || 0, event.sliceSec || 0);
  if (!buffer || !(event.gain > 0)) return;
  const stripTracks = scheduler.machine && scheduler.machine.tracks;
  const strip = ensureStrip(scheduler.strips, event.track, ctx, scheduler.dest,
    scheduler.tracks ? scheduler.tracks[event.track] : (stripTracks && stripTracks[event.track]),
    scheduler.rack, when);
  const startAt = Math.max(ctx.currentTime || 0, when);

  const gainNode = ctx.createGain();
  const panNode = ctx.createStereoPanner();
  gainNode.connect(panNode);
  panNode.connect(strip.duckGain);
  panNode.pan.value = event.pan;

  const plan = planEnvelope(fitted ? { ...event, sliceSec: buffer.duration, rate: 1 } : event,
    buffer.duration);
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

  // COLOR chain (CONTRACT-HARVEST 2): src -> drive -> highpass -> lowpass ->
  // gain -> pan. Every OFF stage creates NO node, so a neutral event keeps
  // today's exact graph: src -> gain -> pan.
  let tail = src;
  const colorNodes = [];
  if (event.driveDb != null) {
    const shaper = ctx.createWaveShaper();
    shaper.curve = driveCurve(event.driveDb);
    tail.connect(shaper);
    tail = shaper;
    colorNodes.push(shaper);
  }
  if (event.hpfHz != null) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = event.hpfHz;
    hp.Q.value = HPF_BUTTERWORTH_Q_DB;   // dB, THE Q TRAP (TRUTH 1)
    tail.connect(hp);
    tail = hp;
    colorNodes.push(hp);
  }
  if (event.lpfHz != null) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = event.lpfHz;
    // Resonance maps through the same dB-domain Q (TRUTH 1): 20*log10(res).
    lp.Q.value = 20 * Math.log10(event.resQ > 0 ? event.resQ : 0.7);
    tail.connect(lp);
    tail = lp;
    colorNodes.push(lp);
  }
  tail.connect(gainNode);

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
  if (colorNodes.length) voice.colorNodes = colorNodes;
  if (scheduler.voices) {
    scheduler.voices.add(voice);
    src.onended = () => {
      if (!scheduler.voices.delete(voice)) return;
      src.onended = null;
      try { src.disconnect(); } catch (e) { /* fine */ }
      try { gainNode.disconnect(); } catch (e) { /* fine */ }
      try { panNode.disconnect(); } catch (e) { /* fine */ }
      disconnectColor(voice);
      if (scheduler.lastTrackVoice[event.track] === voice) {
        scheduler.lastTrackVoice[event.track] = null;
      }
    };
  }
  scheduler.lastTrackVoice[event.track] = voice;

  try {
    if (fitted && buffer.duration > 0) {
      // The fitted bake already IS the trimmed span stretched to fitSec, so
      // it plays whole from zero. Re-applying original-domain trim offsets
      // here is exactly the bug the bake fix removed.
      src.start(startAt);
    } else if (event.sliceSec != null) {
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

function disconnectColor(voice) {
  if (!voice.colorNodes) return;
  for (const node of voice.colorNodes) {
    try { node.disconnect(); } catch (e) { /* already disconnected */ }
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

// Baking a fitted buffer costs 37-61 ms for a 2 s slice (measured), so it can
// never happen on the audio path: prebake() runs it before transport starts and
// this returns the unstretched buffer if a bake is somehow missing.
// Key: sample identity + reverse + fitSec, so live and offline agree exactly.
function fitKey(reversed, fitSec, offsetSec, sliceSec) {
  return (reversed ? 'r' : 'f') + ':' + Math.round(fitSec * 10000)
    + ':' + Math.round((offsetSec || 0) * 10000)
    + ':' + Math.round((sliceSec || 0) * 10000);
}

// Bakes the TRIMMED span (not the whole sample) to fitSec, so the fitted
// buffer IS the slice and plays from offset 0. Stretching the whole sample and
// then applying original-domain trim offsets reads the wrong audio for the
// wrong duration: with start .25 / end .5 on a 4 s sample fitted to 2 s it
// played original seconds 2-4 for 1 s instead of 1-2 for 2 s (verified).
export function createFittedBuffer(ctx, sample, reversed, fitSec, offsetSec, sliceSec) {
  const rate = Math.round(Number(sample.sampleRate));
  const frames = sample.channels[0] ? sample.channels[0].length : 0;
  if (!frames || !(fitSec > 0) || !(rate > 0)) return null;
  // offsetSec/sliceSec are already in the domain of the buffer that will be
  // read: for reversed playback the compiler flips them to (1 - end) * bufSec.
  const from = Math.max(0, Math.min(frames - 1, Math.round((offsetSec || 0) * rate)));
  const span = sliceSec > 0
    ? Math.max(1, Math.min(frames - from, Math.round(sliceSec * rate)))
    : frames - from;
  const target = Math.max(1, Math.round(fitSec * rate));
  const ratio = target / span;
  const mode = 'auto';
  const role = sample.role;
  const out = [];
  for (const channel of sample.channels) {
    const whole = reversed ? Float32Array.from(channel).reverse() : channel;
    const src = (from === 0 && span === frames) ? whole : whole.subarray(from, from + span);
    out.push(stretchSamples(src, ratio, rate, { mode, role }));
  }
  const length = out[0] ? out[0].length : 0;
  if (!length) return null;
  const buffer = ctx.createBuffer(out.length, length, rate);
  for (let c = 0; c < out.length; c++) buffer.getChannelData(c).set(out[c]);
  return buffer;
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
function songBuffer(ctx, cache, tracks, index, reversed, fitSec, offsetSec, sliceSec) {
  const track = tracks[index];
  const sample = track && track.sample;
  if (!ctx || !sample) return null;
  let entry = cache.get(sample);
  if (!entry || entry.ctx !== ctx) {
    entry = { ctx, forward: createTrackBuffer(ctx, sample, false), reversed: null, fitted: new Map() };
    cache.set(sample, entry);
  }
  if (fitSec > 0) {
    const key = fitKey(reversed, fitSec, offsetSec, sliceSec);
    if (!entry.fitted.has(key)) {
      let baked = null;
      try {
        baked = createFittedBuffer(ctx, sample, reversed, fitSec, offsetSec, sliceSec);
      } catch (e) { baked = null; }
      entry.fitted.set(key, baked);
    }
    const fittedBuffer = entry.fitted.get(key);
    if (fittedBuffer) return fittedBuffer;
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

// SPACE rack (CONTRACT-CONFORM 4): one plate and one tempo-synced delay per
// context, fed from the per-track strips so a duck ducks the sends too, and
// so the cost is two gain nodes per track rather than per voice.
// Master stage for offline renders: the same lookahead true-peak limiter the
// RACK uses, at a -0.3 dBTP ceiling. Eight tracks plus sends sum well past
// unity, and a bench that reports true peak to 0.1 dB cannot ship clipped WAVs.
async function masterLimit(buffer) {
  try {
    return await processLimiter(buffer, { ceiling: -0.3 });
  } catch (e) {
    return buffer;   // never lose a render to the master stage
  }
}

function createSpaceRack(ctx, dest, space, bpm) {
  const s = space || {};
  const rack = { ctx, dest, verbIn: null, delayIn: null };
  try {
    const convolver = ctx.createConvolver();
    // MUST be false: ConvolverNode's own equal-power scaling would discard
    // the unity-RMS normalization plateImpulse applies (space agent hazard 1).
    convolver.normalize = false;
    const ir = plateImpulse(ctx.sampleRate, s.verbSec, s.verbDecay, 12);
    const irBuffer = ctx.createBuffer(2, ir.left.length, ctx.sampleRate);
    irBuffer.getChannelData(0).set(ir.left);
    irBuffer.getChannelData(1).set(ir.right);
    convolver.buffer = irBuffer;
    const verbIn = ctx.createGain();
    const verbOut = ctx.createGain();
    // plateImpulse normalizes to unity RMS PER SAMPLE, so convolving with it
    // multiplies level by roughly sqrt(N) for a noise-like tail. Trimming by
    // 1/sqrt(N) is what makes verbMix mean the same thing at every plate
    // length; a flat constant here clips the master (measured: 15% of samples
    // pinned at full scale before this fix).
    const verbNorm = 1 / Math.sqrt(Math.max(1, irBuffer.length));
    verbOut.gain.value = (s.verbMix != null ? s.verbMix : 0.9) * verbNorm;
    verbIn.connect(convolver);
    convolver.connect(verbOut);
    verbOut.connect(dest);
    rack.verbIn = verbIn;
  } catch (e) { /* no convolver: the dry path is unaffected */ }
  try {
    const delayTime = delayTimeFor(bpm, s.delayDivision);
    const delayIn = ctx.createGain();
    const delayNode = ctx.createDelay(Math.max(0.05, delayTime * 2 + 0.5));
    delayNode.delayTime.value = delayTime;
    const feedback = ctx.createGain();
    feedback.gain.value = Math.max(0, Math.min(0.9, s.delayFeedback != null ? s.delayFeedback : 0.38));
    const a = dampingCoeff(3200, ctx.sampleRate);
    const damp = ctx.createIIRFilter([1 - a, 0], [1, -a]);
    const delayOut = ctx.createGain();
    delayOut.gain.value = (s.delayMix != null ? s.delayMix : 0.8) * 0.5;
    delayIn.connect(delayNode);
    delayNode.connect(damp);
    damp.connect(feedback);
    feedback.connect(delayNode);   // damped feedback loop
    delayNode.connect(delayOut);
    delayOut.connect(dest);
    rack.delayIn = delayIn;
  } catch (e) { /* no delay: dry path unaffected */ }
  return rack;
}

// One send amount, scheduled rather than assigned. The node is created the
// first time a scene actually asks for the send, and every later change lands
// as an automation event at the time of the voice that wanted it.
function tuneSend(strip, nodeKey, amtKey, busIn, amt, when) {
  if (strip[amtKey] === amt) return;
  if (!strip[nodeKey]) {
    // Nothing to schedule and nothing to build: a track that has never sent
    // anywhere does not get a gain node it would only ever hold at zero.
    if (!busIn || !(amt > 0)) { strip[amtKey] = amt; return; }
    const send = strip.ctx.createGain();
    send.gain.value = 0;
    strip.duckGain.connect(send);
    send.connect(busIn);
    strip[nodeKey] = send;
  }
  try {
    strip[nodeKey].gain.setValueAtTime(amt, Math.max(0, when));
  } catch (e) { /* context closing */ }
  strip[amtKey] = amt;
}

// Sends are per-track AND per-scene, but one strip per track index is shared
// across every scene in a song. Baking the amounts in at creation let the
// first scene that played own the sends for the whole arrangement: a chorus
// with the snare 90% into the plate kept that send through a dry verse, live
// and in the printed WAV both. They are scheduled at `when` instead, so each
// section gets the sends its own scene asked for.
function ensureStrip(strips, index, ctx, dest, track, rack, when = 0) {
  const verbAmt = track && Number.isFinite(track.sendVerb) ? track.sendVerb : 0;
  const delayAmt = track && Number.isFinite(track.sendDelay) ? track.sendDelay : 0;
  const existing = strips[index];
  if (existing && existing.ctx === ctx && existing.dest === dest) {
    tuneSend(existing, 'verbSend', 'verbAmt', rack && rack.verbIn, verbAmt, when);
    tuneSend(existing, 'delaySend', 'delayAmt', rack && rack.delayIn, delayAmt, when);
    return existing;
  }
  if (existing) {
    try { existing.duckGain.disconnect(); } catch (e) { /* already disconnected */ }
  }
  const duckGain = ctx.createGain();
  duckGain.connect(dest);
  const strip = { ctx, dest, duckGain, verbAmt: 0, delayAmt: 0 };
  tuneSend(strip, 'verbSend', 'verbAmt', rack && rack.verbIn, verbAmt, when);
  tuneSend(strip, 'delaySend', 'delayAmt', rack && rack.delayIn, delayAmt, when);
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
