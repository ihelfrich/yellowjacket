// Sequencer: turns compiler events into scheduled voices. LOCK rework: gain, pan,
// pitch, reverse, and gate are PER-VOICE nodes (a lock on one hit must never bend
// the tail of the previous hit — strip automation cannot do that), strips carry
// only the duck bus, and live and offline scheduling share one code path so a
// FREEZE replays the same compiled decisions. Its finite tail allocation and
// fail-closed offline master are explicit exceptions to device-output identity.

import { resample, PLAYBACK_CUTOFF_SCALE } from '../dsp/resample.js';
import { encodeWav, encodeWavWithStats } from '../export.js';
import { stretchSamples } from '../dsp/stretch.js';
import { plateImpulse, delayTimeFor, dampingCoeff } from '../dsp/space.js';
import { processLimiter } from '../dsp/limiter.js';
import { scheduleSemanticEvent, semanticRate } from '../loom/schedule.js';
import {
  compilePerformanceRender,
  compilePerformanceWindow,
} from '../performance/compile.js';
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
const LIMITER_CEILING_DBTP = -0.3;
// Delay feedback is mathematically infinite. Offline prints carry it until the
// next repeat would fall below this declared amplitude floor, rather than
// ending at an arbitrary fixed number of seconds.
export const RENDER_TAIL_FLOOR_DB = -80;
const RENDER_TAIL_FLOOR = Math.pow(10, RENDER_TAIL_FLOOR_DB / 20);
const PLATE_PREDELAY_SEC = 0.012;  // createSpaceRack() passes 12 ms
const SEMANTIC_STOP_PAD_SEC = 0.002;
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
    this._lastChokeVoice = [];   // cross-track groups (closed/open hats, etc.)
    this._strips = [];
    this._bufferCache = [];
    this._songPlaying = false;
    this._song = null;
    this._songTimer = 0;
    this._songAnchor = 0;
    this._rack = null;
    // Resolver functions are owned by the controller so the scheduler never
    // stores project state or source PCM. Plans are immutable JSON; the source
    // buffer is supplied only while its SHA-256 identity is online.
    this._performanceSources = null;
  }

  setMachine(machine) {
    if (machine === this._machine) return;
    this._machine = machine || null;
    this._bufferCache = [];
  }

  setPerformanceSources(resolver) {
    this._performanceSources = resolver || null;
  }

  _performancePlans() {
    const resolver = this._performanceSources;
    if (!resolver) return {};
    const plans = typeof resolver.plans === 'function' ? resolver.plans() : resolver.plans;
    return plans && typeof plans === 'object' ? plans : {};
  }

  _semanticSource(planId) {
    const resolver = this._performanceSources;
    if (!resolver || typeof resolver.bufferFor !== 'function') return null;
    return resolver.bufferFor(planId) || null;
  }

  // The live semantic voice, resolved against the context it will play on.
  // When the recording's rate already matches, that is the recording itself
  // (no copy, today's path). Otherwise the resolver hands back a short
  // rate-matched excerpt around this event and the offset rebased into it.
  // The excerpt's AudioBuffer is cached per context on the excerpt object.
  _semanticVoice(planId, event, ctx) {
    const buffer = this._semanticSource(planId);
    if (!buffer || !ctx) return null;
    const rate = Math.round(ctx.sampleRate);
    // Only an unpitched note on a matched rate can skip the excerpt: a pitched
    // one needs its ratio baked into the excerpt's own rate to stay a copy.
    if (Math.round(buffer.sampleRate) === rate && semanticRate(event) === 1) return { buffer, offsetSec: null };
    const resolver = this._performanceSources;
    if (!resolver || typeof resolver.excerptFor !== 'function') return { buffer, offsetSec: null };
    const excerpt = resolver.excerptFor(planId, event, rate);
    if (!excerpt || !excerpt.channels.length) return { buffer, offsetSec: null };
    if (!this._excerptBuffers) this._excerptBuffers = new WeakMap();
    let byCtx = this._excerptBuffers.get(excerpt);
    if (!byCtx) { byCtx = new Map(); this._excerptBuffers.set(excerpt, byCtx); }
    let baked = byCtx.get(ctx);
    if (!baked) {
      const length = excerpt.channels[0].length;
      baked = ctx.createBuffer(excerpt.channels.length, length, excerpt.sampleRate);
      for (let c = 0; c < excerpt.channels.length; c++) baked.getChannelData(c).set(excerpt.channels[c]);
      byCtx.set(ctx, baked);
    }
    return { buffer: baked, offsetSec: excerpt.offsetSec };
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
        // One fitted take per track: every tempo the user passed through used
        // to leave its own AudioBuffer in this map with no eviction.
        cached.fitted.clear();
        let baked = null;
        try {
          baked = createFittedBuffer(ctx, sample, reversed, fitSec, offsetSec, sliceSec, cached.buffer);
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
        if (!track || !track.sample) continue;
        // Rate-matching costs ~33 ms per mono-second at 2×: do it here, never
        // inside trigger() or the scheduler (CONTRACT-CONFORM 3).
        if (Math.round(Number(track.sample.sampleRate)) !== Math.round(ctx.sampleRate)) this.trackBuffer(i, false, 0);
        if (!(steps > 0)) continue;
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
    // Rebuild off the caller's stack, coalesced: rate-matching a slice is tens
    // of milliseconds and must never land inside trigger() or the scheduler.
    if (!this._prebakeTimer && typeof setTimeout === 'function') {
      this._prebakeTimer = setTimeout(() => {
        this._prebakeTimer = 0;
        try { this.prebake(); } catch (e) { /* a bad sample is reported at trigger time */ }
      }, 0);
    }
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
    const ctx = this._engine && typeof this._engine.wake === 'function'
      ? this._engine.wake()
      : this._engine && this._engine.ctx;
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
    const ctx = this._engine && typeof this._engine.wake === 'function'
      ? this._engine.wake()
      : this._engine && this._engine.ctx;
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
    // If FILL was held, those hits are part of the deterministic event stream.
    const compiled = compileRender(this._machine, loops, { fill: !!this.fill });
    const sampleRate = renderSampleRate(this._machine);
    const renderSec = renderDurationSec(this._machine, compiled);
    const length = Math.max(1, Math.ceil(renderSec * sampleRate));
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
              baked = createFittedBuffer(ctx, sample, reversed, fitSec, offsetSec, sliceSec, entry.forward);
            } catch (e) { baked = null; }
          }
          buffers[index][key] = baked || createTrackBuffer(ctx, sample, reversed);
        }
        return buffers[index][key];
      },
      lastTrackVoice: [],
      lastChokeVoice: [],
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
    const limited = await masterLimit(rendered);
    return encodeWav(limited.buffer, 16);
  }

  // PRINT TAKE is deliberately separate from FREEZE. FREEZE keeps its legacy
  // source-replacement behavior; this path prints the active scene's eight
  // Machine tracks plus its ninth semantic lane and returns a provenance map.
  async renderPerformance(loops = 1, bitDepth = 24) {
    const plans = this._performancePlans();
    const compiled = compilePerformanceRender(this._machine, plans, loops, {
      fill: !!this.fill,
    });
    const scene = this._machine && Array.isArray(this._machine.scenes)
      ? this._machine.scenes[this._machine.activeScene | 0]
      : this._machine;
    const lane = scene && scene.loomLane;
    const planId = lane && lane.planId != null ? String(lane.planId) : null;
    const resolver = this._performanceSources;
    const identity = resolver && typeof resolver.identityFor === 'function'
      ? { ...(resolver.identityFor(planId) || {}) } : {};
    const plan = planId && plans
      ? (plans instanceof Map ? (plans.get(planId) || null) : (plans[planId] || null))
      : null;
    const sourceBuffer = compiled.semanticEvents.length ? this._semanticSource(planId) : null;
    if (compiled.semanticEvents.length && !sourceBuffer) {
      throw new Error('the Semantic Take source is offline');
    }

    const sourceRate = sourceBuffer && Number(sourceBuffer.sampleRate);
    const sampleRate = Math.round(Math.max(
      renderSampleRate(this._machine),
      Number.isFinite(sourceRate) ? sourceRate : MIN_RENDER_RATE,
    ));
    const renderSec = renderDurationSec(this._machine, compiled);
    const length = Math.max(1, Math.ceil(renderSec * sampleRate));
    const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!OfflineCtx) throw new Error('OfflineAudioContext is not available');

    const ctx = new OfflineCtx(2, length, sampleRate);
    const tracks = this._machine && Array.isArray(this._machine.tracks)
      ? this._machine.tracks : [];
    const buffers = new Array(tracks.length);
    const strips = [];
    const rack = createSpaceRack(ctx, ctx.destination,
      this._machine && this._machine.space, this._machine && this._machine.bpm);
    const scheduler = {
      ctx,
      strips,
      dest: ctx.destination,
      tracks,
      rack,
      buffer: (index, reversed, fitSec, offsetSec, sliceSec) => {
        const key = fitSec > 0
          ? fitKey(reversed, fitSec, offsetSec, sliceSec)
          : (reversed ? 'r' : 'f');
        if (!buffers[index]) buffers[index] = {};
        if (buffers[index][key] === undefined) {
          const track = tracks[index];
          const sample = track && track.sample;
          let baked = null;
          if (sample && fitSec > 0) {
            try {
              baked = createFittedBuffer(ctx, sample, reversed, fitSec, offsetSec, sliceSec, entry.forward);
            } catch (error) { baked = null; }
          }
          buffers[index][key] = baked || createTrackBuffer(ctx, sample, reversed);
        }
        return buffers[index][key];
      },
      lastTrackVoice: [],
      lastChokeVoice: [],
      machine: this._machine,
    };

    for (const event of compiled.events) scheduleEvent(scheduler, event, event.tSec);
    for (const seg of compiled.ducks) {
      applyDuck(ensureStrip(strips, seg.track, ctx, ctx.destination,
        tracks[seg.track], rack, seg.tSec), seg.tSec, seg.depthDb);
    }
    for (const event of compiled.semanticEvents) {
      scheduleSemanticEvent({
        ctx,
        destination: ctx.destination,
        sourceBuffer,
        event,
        when: event.tSec,
      });
    }

    const rendered = await ctx.startRendering();
    const limited = await masterLimit(rendered);
    const mastered = limited.buffer;
    const bits = bitDepth === 16 ? 16 : 24;
    const { blob, stats } = encodeWavWithStats(mastered, bits);
    const lineage = {
      format: 'yellowjacket-semantic-performance',
      version: 1,
      renderedAt: new Date().toISOString(),
      audio: {
        sampleRate,
        bitDepth: bits,
        channels: 2,
        frames: mastered.length,
        durationSec: mastered.length / sampleRate,
        limiterApplied: limited.applied,
        limiterCeilingDbtp: limited.ceilingDbtp,
        samplePeakDbfs: stats && stats.peakDb,
        clippedSamples: stats && stats.clippedSamples,
      },
      performance: {
        sceneId: scene && scene.id != null ? String(scene.id) : null,
        sceneIndex: this._machine && Number.isFinite(this._machine.activeScene)
          ? this._machine.activeScene | 0 : 0,
        bpm: scene && scene.bpm,
        swing: scene && scene.swing,
        seed: scene && scene.seed,
        loops: Math.max(1, Math.min(64, Math.floor(Number(loops)) || 1)),
        machineDurationSec: compiled.machineTotalSec,
        renderDurationSec: mastered.length / sampleRate,
        tailDurationSec: Math.max(0, mastered.length / sampleRate - compiled.machineTotalSec),
      },
      semanticTake: plan ? {
        planId,
        compilerVersion: plan.compilerVersion || null,
        source: {
          sha256: identity.sha256 || (plan.source && plan.source.sha256) || null,
          name: identity.name || (plan.source && plan.source.name) || null,
          size: identity.size != null ? identity.size : (plan.source && plan.source.size),
        },
        gesture: plan.gesture || null,
        events: compiled.lineage,
      } : null,
    };
    return {
      bytes: await blob.arrayBuffer(),
      stats,
      lineage,
      totalSec: mastered.length / sampleRate,
      sampleRate,
    };
  }

  // Print one active Machine voice through the exact scheduling graph used by
  // pads/patterns: trim, tune, reverse, envelope, COLOR, and track gain. This
  // is the source-free hardware-patch seam; conversion to OP's 44.1 kHz format
  // happens once, after this graph, through the canonical Kaiser resampler.
  async renderTrackVoice(i) {
    const index = trackIndex(i);
    const tracks = this._machine && Array.isArray(this._machine.tracks)
      ? this._machine.tracks : [];
    const track = index >= 0 ? tracks[index] : null;
    const sample = track && track.sample;
    if (!sample) return null;
    const event = compileTrigger(this._machine, index);
    if (!event) return null;

    const rate = Math.max(MIN_RENDER_RATE, Math.round(Number(sample.sampleRate)) || MIN_RENDER_RATE);
    const naturalSec = sample.channels && sample.channels[0]
      ? sample.channels[0].length / rate : 0;
    let playSec = event.fitSec > 0 ? event.fitSec
      : (event.sliceSec != null ? event.sliceSec : naturalSec) / Math.max(0.001, event.rate || 1);
    if (event.durSec != null) playSec = Math.min(playSec, event.durSec);
    const release = event.releaseSec != null ? event.releaseSec : RELEASE_SEC;
    const seconds = Math.max(0.03, Math.min(12, playSec + release + STOP_PAD_SEC + 0.01));
    const length = Math.max(1, Math.ceil(seconds * rate));
    const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!OfflineCtx) throw new Error('OfflineAudioContext is not available');
    const ctx = new OfflineCtx(1, length, rate);
    const localTracks = tracks.map((item, n) => n === index
      ? { ...item, pan: 0, sendVerb: 0, sendDelay: 0 }
      : item);
    const scheduler = {
      ctx,
      strips: [],
      dest: ctx.destination,
      tracks: localTracks,
      rack: null,
      buffer: (_track, reversed, fitSec, offsetSec, sliceSec) => {
        if (fitSec > 0) {
          const fitted = createFittedBuffer(ctx, sample, reversed, fitSec, offsetSec, sliceSec, entry && entry.forward);
          if (fitted) return fitted;
        }
        return createTrackBuffer(ctx, sample, reversed);
      },
      lastTrackVoice: [],
      lastChokeVoice: [],
      machine: { tracks: localTracks },
    };
    event.pan = 0;
    scheduleEvent(scheduler, event, 0, true);
    return ctx.startRendering();
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
    const renderSec = renderDurationSec(this._machine, compiled);
    const length = Math.max(1, Math.ceil(renderSec * sampleRate));
    const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!OfflineCtx) throw new Error('OfflineAudioContext is not available');

    const ctx = new OfflineCtx(2, length, sampleRate);
    const cache = new Map();
    const strips = [];
    const lastTrackVoice = [];
    const lastChokeVoice = [];
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
        lastChokeVoice,
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
    const limited = await masterLimit(rendered);
    const mastered = limited.buffer;
    const { blob, stats } = encodeWavWithStats(mastered, bitDepth === 16 ? 16 : 24);
    const totalSec = mastered.length / sampleRate;
    return {
      bytes: await blob.arrayBuffer(),
      stats,
      totalSec,
      machineTotalSec: compiled.totalSec,
      tailSec: Math.max(0, totalSec - compiled.totalSec),
      limiter: { applied: limited.applied, ceilingDbtp: limited.ceilingDbtp },
    };
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
      lastChokeVoice: this._lastChokeVoice,
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
      lastChokeVoice: this._lastChokeVoice,
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
    const { events, ducks, semanticEvents } = compilePerformanceWindow(
      this._machine,
      this._performancePlans(),
      fromSec,
      toSec,
      { fill: this.fill },
    );
    const scheduler = this._liveStrips(ctx, this._master);
    for (const event of events) {
      scheduleEvent(scheduler, event, this._anchor + event.tSec);
    }
    for (const event of semanticEvents) {
      const voice = this._semanticVoice(event.planId, event, ctx);
      if (!voice) continue;
      scheduleSemanticEvent({
        ctx,
        destination: this._master,
        sourceBuffer: voice.buffer,
        event,
        offsetSec: voice.offsetSec,
        when: this._anchor + event.tSec,
        voices: this._voices,
      });
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
    this._lastChokeVoice = [];
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
    // Browser-native anti-aliasing for editable per-voice saturation. Factory
    // drum nonlinearities are already baked at 4x before their 96 kHz asset
    // boundary; this covers the user's subsequent DRIVE edits live/offline.
    shaper.oversample = '4x';
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

  // Choke: a mono track fades its own previous voice; a numbered group also
  // fades the most recent voice on any matching track (notably closed/open hats).
  const tracks = scheduler.machine && scheduler.machine.tracks;
  const track = tracks && tracks[event.track];
  // `choke` means monophonic by design, including pads, QWERTY, and incoming
  // MIDI. A manual 808 hit must not layer over its own tail while programmed
  // hits cut correctly.
  const choke = track && track.choke;
  const chokeGroup = track ? Math.max(0, Math.min(4, track.chokeGroup | 0)) : 0;
  const previous = new Set();
  if (choke && scheduler.lastTrackVoice[event.track]) {
    previous.add(scheduler.lastTrackVoice[event.track]);
  }
  if (chokeGroup && scheduler.lastChokeVoice && scheduler.lastChokeVoice[chokeGroup]) {
    previous.add(scheduler.lastChokeVoice[chokeGroup]);
  }
  for (const prev of previous) {
    if (prev) {
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
      if (chokeGroup && scheduler.lastChokeVoice
        && scheduler.lastChokeVoice[chokeGroup] === voice) {
        scheduler.lastChokeVoice[chokeGroup] = null;
      }
    };
  }
  scheduler.lastTrackVoice[event.track] = voice;
  if (chokeGroup && scheduler.lastChokeVoice) scheduler.lastChokeVoice[chokeGroup] = voice;

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
// `forward` is the rate-matched forward AudioBuffer for this (ctx, sample)
// when the sample's rate differs from the context's: the fit then reads
// channels already at the context rate instead of resampling twice.
export function createFittedBuffer(ctx, sample, reversed, fitSec, offsetSec, sliceSec, forward = null) {
  const nativeRate = Math.round(Number(sample.sampleRate));
  const useForward = !!(forward && forward.sampleRate && Math.round(forward.sampleRate) !== nativeRate);
  const rate = useForward ? Math.round(forward.sampleRate) : nativeRate;
  const channels = useForward
    ? Array.from({ length: forward.numberOfChannels }, (_, c) => forward.getChannelData(c))
    : sample.channels;
  const frames = channels[0] ? channels[0].length : 0;
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
  for (const channel of channels) {
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

// A track buffer is built AT THE CONTEXT'S RATE. A source node whose buffer
// rate differs from its context is resampled by Chromium with linear
// interpolation (E12: a 19 kHz tone in a 48 kHz slice on a 96 kHz device
// carries a 29 kHz image only 6 dB down), and the offline print at
// max(track rates) interpolated the same way. Rate-matching once here, with
// the repo's Kaiser at the playback cutoff, is a copy when the rates agree
// and −88 dB images when they do not. Reversal happens after resampling
// (linear phase: the order is immaterial).
export function createTrackBuffer(ctx, sample, reversed = false) {
  if (!sample || !sample.channels || !sample.channels.length) return null;
  const sampleRate = Math.round(Number(sample.sampleRate));
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  let length = 0;
  for (const channel of sample.channels) {
    if (channel && Number.isFinite(channel.length)) length = Math.max(length, channel.length);
  }
  if (!length) return null;
  const targetRate = ctx && Number.isFinite(ctx.sampleRate) && ctx.sampleRate > 0 ? Math.round(ctx.sampleRate) : sampleRate;
  const matched = targetRate === sampleRate;
  const outLength = matched ? length : Math.round(length * targetRate / sampleRate);

  try {
    const buffer = ctx.createBuffer(sample.channels.length, outLength, targetRate);
    for (let channel = 0; channel < sample.channels.length; channel++) {
      const source = sample.channels[channel];
      if (!source) continue;
      const dest = buffer.getChannelData(channel);
      const data = matched
        ? source.subarray(0, length)
        : resample(source.subarray(0, length), sampleRate, targetRate, { cutoffScale: PLAYBACK_CUTOFF_SCALE });
      if (!reversed) {
        dest.set(data.subarray(0, outLength));
      } else {
        const n = Math.min(data.length, outLength);
        for (let i = 0; i < n; i++) dest[i] = data[n - 1 - i];
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
        baked = createFittedBuffer(ctx, sample, reversed, fitSec, offsetSec, sliceSec, entry.forward);
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

function bounded(value, low, high, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(low, Math.min(high, number)) : fallback;
}

function trackSampleSeconds(track) {
  const sample = track && track.sample;
  const rate = Math.round(Number(sample && sample.sampleRate));
  if (!(rate > 0) || !sample || !Array.isArray(sample.channels)) return 0;
  let frames = 0;
  for (const channel of sample.channels) {
    if (channel && Number.isFinite(channel.length)) frames = Math.max(frames, channel.length);
  }
  return frames / rate;
}

function eventVoiceSeconds(event, track) {
  const sourceSec = trackSampleSeconds(track);
  if (!(sourceSec > 0)) return 0;
  const fitted = event && event.fitSec > 0;
  const bufferSec = fitted ? event.fitSec : sourceSec;
  // This mirrors scheduleEvent(): a fitted bake is already the requested wall
  // span, so its envelope is planned at unity rate over the baked duration.
  const envelopeEvent = fitted ? { ...event, sliceSec: bufferSec, rate: 1 } : event;
  const envelope = planEnvelope(envelopeEvent, bufferSec);
  return envelope.stopSec != null && Number.isFinite(envelope.stopSec)
    ? Math.max(0, envelope.stopSec) : 0;
}

function spaceTailSeconds(machine, track) {
  if (!track) return 0;
  const space = machine && machine.space || {};
  let tail = 0;
  const verbMix = bounded(space.verbMix, 0, 1, 0.9);
  if (Number(track.sendVerb) > 0 && verbMix > 0) {
    // Exact ConvolverNode impulse length used by createSpaceRack().
    tail = bounded(space.verbSec, 0.05, 10, 2) + PLATE_PREDELAY_SEC;
  }
  const delayMix = bounded(space.delayMix, 0, 1, 0.8);
  if (Number(track.sendDelay) > 0 && delayMix > 0) {
    const feedback = bounded(space.delayFeedback, 0, 0.9, 0.38);
    const repeats = feedback > 0
      ? Math.max(1, Math.ceil(Math.log(RENDER_TAIL_FLOOR) / Math.log(feedback)))
      : 1;
    tail = Math.max(tail,
      delayTimeFor(machine && machine.bpm, space.delayDivision) * repeats);
  }
  return tail;
}

/**
 * Allocation boundary for an offline Machine print. The musical grid still
 * ends at compiled.totalSec; this extends only already-started dry voices and
 * their enabled Space returns. Delay feedback ends below a declared -80 dB
 * amplitude floor. No new Machine or Loom occurrence is compiled into the tail.
 */
export function renderDurationSec(machine, compiled) {
  const base = Number(compiled && compiled.totalSec);
  let end = Number.isFinite(base) && base > 0 ? base : 0;
  const events = compiled && Array.isArray(compiled.events) ? compiled.events : [];
  const sections = compiled && Array.isArray(compiled.sections) ? compiled.sections : [];
  const scenes = machine && Array.isArray(machine.scenes) ? machine.scenes : [];
  let sectionIndex = 0;
  for (const event of events) {
    if (!event || !(event.gain > 0) || !Number.isFinite(event.tSec)) continue;
    let tracks = machine && Array.isArray(machine.tracks) ? machine.tracks : [];
    if (sections.length) {
      while (sectionIndex < sections.length - 1
        && event.tSec >= sections[sectionIndex].endSec) sectionIndex++;
      const section = sections[sectionIndex];
      const scene = section && scenes[section.scene];
      tracks = scene && Array.isArray(scene.tracks) ? scene.tracks : [];
    }
    const track = tracks[event.track];
    const voiceEnd = event.tSec + eventVoiceSeconds(event, track);
    end = Math.max(end, voiceEnd + spaceTailSeconds(machine, track));
  }
  const semanticEvents = compiled && Array.isArray(compiled.semanticEvents)
    ? compiled.semanticEvents : [];
  for (const event of semanticEvents) {
    if (event && Number.isFinite(event.outEndSec)) {
      end = Math.max(end, event.outEndSec + SEMANTIC_STOP_PAD_SEC);
    }
  }
  return end;
}

// SPACE rack (CONTRACT-CONFORM 4): one plate and one tempo-synced delay per
// context, fed from the per-track strips so a duck ducks the sends too, and
// so the cost is two gain nodes per track rather than per voice.
// Master stage for offline renders: the same lookahead true-peak limiter the
// RACK uses, at a -0.3 dBTP ceiling. Eight tracks plus sends sum well past
// unity, and a bench that reports true peak to 0.1 dB cannot ship clipped WAVs.
export async function masterLimit(buffer, processor = processLimiter) {
  if (!buffer || typeof processor !== 'function') {
    throw new Error('MASTER LIMITER FAILED · invalid render or processor');
  }
  let mastered;
  try {
    mastered = await processor(buffer, { ceiling: LIMITER_CEILING_DBTP });
  } catch (error) {
    throw new Error('MASTER LIMITER FAILED · ' + (error && error.message ? error.message : error));
  }
  if (!mastered || mastered.length !== buffer.length
    || mastered.numberOfChannels !== buffer.numberOfChannels
    || mastered.sampleRate !== buffer.sampleRate) {
    throw new Error('MASTER LIMITER FAILED · output format changed');
  }
  return Object.freeze({
    buffer: mastered,
    applied: true,
    ceilingDbtp: LIMITER_CEILING_DBTP,
  });
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
