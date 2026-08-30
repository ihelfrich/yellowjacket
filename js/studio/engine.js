// Polyphonic melodic instrument engine for the Studio surface. It deliberately
// connects to Engine.master so the sampler and Studio share one trusted output.

import { studioStepDuration, studioStepSeconds, chordNotes } from './model.js';

// STUDIO_BOUNCE_DEFAULT is the source-free rate: with no recording loaded there
// is no session rate to inherit, and 48 kHz is the right floor for synthesis.
// A loaded 96 or 192 kHz source raises it so the bounce matches the session
// rather than quietly downgrading it (docs/AUDIT-RESOLUTION.md section 2).
export const STUDIO_BOUNCE_DEFAULT = 48000;

export function bounceSampleRate(sessionRate) {
  const rate = Number(sessionRate);
  if (!Number.isFinite(rate) || rate <= STUDIO_BOUNCE_DEFAULT) return STUDIO_BOUNCE_DEFAULT;
  return Math.round(rate);
}

const LOOKAHEAD = 0.16;
const TICK_MS = 25;
const START_DELAY = 0.04;

function dbGain(db) { return Math.pow(10, Number(db || 0) / 20); }
function hz(note) { return 440 * Math.pow(2, (note - 69) / 12); }

function impulse(ctx, seconds = 2.4, decay = 2.7) {
  const length = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  let seed = 0x594a5354;
  const random = () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) data[i] = (random() * 2 - 1) * Math.pow(1 - i / length, decay);
  }
  return buffer;
}

function graphFor(ctx, destination, studio) {
  const master = ctx.createGain();
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -12;
  compressor.knee.value = 14;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.006;
  compressor.release.value = 0.18;
  master.gain.value = dbGain(studio.masterDb);
  master.connect(compressor).connect(destination);

  const verbIn = ctx.createGain();
  const convolver = ctx.createConvolver();
  const verbReturn = ctx.createGain();
  convolver.buffer = impulse(ctx);
  verbReturn.gain.value = 0.34;
  verbIn.connect(convolver).connect(verbReturn).connect(master);

  const delayIn = ctx.createGain();
  const delay = ctx.createDelay(2);
  const feedback = ctx.createGain();
  const delayReturn = ctx.createGain();
  delay.delayTime.value = studioStepSeconds(studio.bpm) * 3;
  feedback.gain.value = 0.36;
  delayReturn.gain.value = 0.38;
  delayIn.connect(delay);
  delay.connect(feedback).connect(delay);
  delay.connect(delayReturn).connect(master);

  const strips = studio.tracks.map(() => {
    const input = ctx.createGain();
    const gain = ctx.createGain();
    const pan = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : ctx.createGain();
    const verb = ctx.createGain();
    const echo = ctx.createGain();
    input.connect(gain).connect(pan).connect(master);
    input.connect(verb).connect(verbIn);
    input.connect(echo).connect(delayIn);
    return { input, gain, pan, verb, echo };
  });
  return { master, strips };
}

function syncGraph(graph, studio, at = 0) {
  const anySolo = studio.tracks.some((track) => track.solo);
  graph.master.gain.setValueAtTime(dbGain(studio.masterDb), at);
  for (let i = 0; i < graph.strips.length; i++) {
    const strip = graph.strips[i];
    const track = studio.tracks[i];
    const audible = !track.mute && (!anySolo || track.solo);
    strip.gain.gain.setValueAtTime(audible ? dbGain(track.gainDb) : 0, at);
    if (strip.pan.pan) strip.pan.pan.setValueAtTime(track.pan, at);
    strip.verb.gain.setValueAtTime(track.sendVerb, at);
    strip.echo.gain.setValueAtTime(track.sendDelay, at);
  }
}

function scheduleVoice(ctx, destination, track, note, when, duration, velocity, voices = null) {
  const synth = track.synth;
  const filter = ctx.createBiquadFilter();
  const amp = ctx.createGain();
  const osc1 = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const mix1 = ctx.createGain();
  const mix2 = ctx.createGain();
  const transposed = note + synth.transpose;
  const frequency = hz(transposed);
  const attack = Math.max(0.001, synth.attack);
  const decay = Math.max(0.005, synth.decay);
  const sustain = Math.max(0.0001, synth.sustain);
  const release = Math.max(0.01, synth.release);
  const peak = Math.max(0.0001, Math.min(1, velocity));
  const noteOff = when + Math.max(0.025, duration);
  const stopAt = noteOff + release + 0.04;
  const attackEnd = Math.min(noteOff, when + attack);
  const decayEnd = Math.min(noteOff, attackEnd + decay);

  osc1.type = synth.wave1;
  osc2.type = synth.wave2;
  osc1.frequency.setValueAtTime(frequency, when);
  osc2.frequency.setValueAtTime(frequency, when);
  osc2.detune.setValueAtTime(synth.detune, when);
  mix1.gain.value = 1 - synth.mix;
  mix2.gain.value = synth.mix;
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(Math.min(ctx.sampleRate * 0.45, synth.cutoff), when);
  filter.Q.setValueAtTime(synth.resonance, when);
  amp.gain.setValueAtTime(0.0001, when);
  amp.gain.exponentialRampToValueAtTime(peak, attackEnd);
  if (decayEnd > attackEnd) amp.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * sustain), decayEnd);
  amp.gain.setValueAtTime(Math.max(0.0001, peak * sustain), noteOff);
  amp.gain.exponentialRampToValueAtTime(0.0001, noteOff + release);

  osc1.connect(mix1).connect(filter);
  osc2.connect(mix2).connect(filter);
  filter.connect(amp).connect(destination);
  osc1.start(when); osc2.start(when);
  osc1.stop(stopAt); osc2.stop(stopAt);

  if (voices) {
    const voice = { osc1, osc2, amp, stopAt };
    voices.add(voice);
    osc1.onended = () => voices.delete(voice);
  }
}

export class StudioEngine extends EventTarget {
  constructor(engine) {
    super();
    this.engine = engine;
    this.studio = null;
    this.running = false;
    this._ctx = null;
    this._graph = null;
    this._timer = 0;
    this._nextStep = 0;
    this._nextWhen = 0;
    this._voices = new Set();
  }

  setStudio(studio) {
    this.studio = studio;
    if (this._graph && this._ctx) syncGraph(this._graph, studio, this._ctx.currentTime);
  }

  start() {
    if (this.running || !this.studio) return;
    const ctx = this.engine.wake();
    if (!ctx || !this.engine.master) return;
    this._ctx = ctx;
    this._graph = graphFor(ctx, this.engine.master, this.studio);
    syncGraph(this._graph, this.studio, ctx.currentTime);
    this._nextStep = 0;
    this._nextWhen = ctx.currentTime + START_DELAY;
    this.running = true;
    this.dispatchEvent(new CustomEvent('state', { detail: { playing: true } }));
    this._tick();
    this._timer = setInterval(() => this._tick(), TICK_MS);
  }

  stop() {
    const wasRunning = this.running;
    this.running = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = 0;
    const now = this._ctx ? this._ctx.currentTime : 0;
    for (const voice of this._voices) {
      try { voice.amp.gain.cancelScheduledValues(now); voice.amp.gain.setTargetAtTime(0.0001, now, 0.01); } catch (e) { /* closed graph */ }
      try { voice.osc1.stop(now + 0.05); voice.osc2.stop(now + 0.05); } catch (e) { /* already ended */ }
    }
    this._voices.clear();
    this._graph = null;
    if (wasRunning) this.dispatchEvent(new CustomEvent('state', { detail: { playing: false } }));
    this.dispatchEvent(new CustomEvent('step', { detail: { step: -1 } }));
  }

  toggle() { this.running ? this.stop() : this.start(); }

  sync() {
    if (this._graph && this._ctx && this.studio) syncGraph(this._graph, this.studio, this._ctx.currentTime);
  }

  preview(trackIndex, note, chord = 'single', velocity = 0.85) {
    if (!this.studio) return;
    const ctx = this.engine.wake();
    if (!this._graph || this._ctx !== ctx) {
      this._ctx = ctx;
      this._graph = graphFor(ctx, this.engine.master, this.studio);
    }
    syncGraph(this._graph, this.studio, ctx.currentTime);
    const track = this.studio.tracks[trackIndex];
    if (!track) return;
    for (const pitch of chordNotes(note, chord)) {
      scheduleVoice(ctx, this._graph.strips[trackIndex].input, track, pitch, ctx.currentTime, 0.32, velocity, this._voices);
    }
  }

  _tick() {
    if (!this.running || !this._ctx || !this.studio) return;
    const total = this.studio.bars * 16;
    const horizon = this._ctx.currentTime + LOOKAHEAD;
    while (this._nextWhen < horizon) {
      const step = this._nextStep % total;
      this._scheduleStep(step, this._nextWhen);
      const announceIn = Math.max(0, (this._nextWhen - this._ctx.currentTime) * 1000);
      setTimeout(() => {
        if (this.running) this.dispatchEvent(new CustomEvent('step', { detail: { step } }));
      }, announceIn);
      this._nextWhen += studioStepDuration(this.studio.bpm, this.studio.swing, step);
      this._nextStep = (step + 1) % total;
    }
  }

  _scheduleStep(step, when) {
    const solo = this.studio.tracks.some((track) => track.solo);
    for (let i = 0; i < this.studio.tracks.length; i++) {
      const track = this.studio.tracks[i];
      if (track.mute || (solo && !track.solo)) continue;
      const event = track.steps[step];
      if (!event) continue;
      const duration = studioStepSeconds(this.studio.bpm) * event.gate;
      for (const note of chordNotes(event.note, event.chord)) {
        scheduleVoice(this._ctx, this._graph.strips[i].input, track, note, when, duration, event.velocity, this._voices);
      }
    }
    if (this.studio.metronome && step % 4 === 0) this._click(when, step % 16 === 0);
  }

  _click(when, downbeat) {
    const osc = this._ctx.createOscillator();
    const gain = this._ctx.createGain();
    osc.frequency.value = downbeat ? 1320 : 880;
    gain.gain.setValueAtTime(0.12, when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.025);
    osc.connect(gain).connect(this._graph.master);
    osc.start(when); osc.stop(when + 0.03);
  }

  async render() {
    if (!this.studio) throw new Error('No Studio project');
    const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!Offline) throw new Error('OfflineAudioContext is unavailable');
    const sampleRate = bounceSampleRate(this.sessionRate);
    const totalSteps = this.studio.bars * 16;
    const songSec = totalSteps * studioStepSeconds(this.studio.bpm);
    const ctx = new Offline(2, Math.ceil((songSec + 4) * sampleRate), sampleRate);
    const graph = graphFor(ctx, ctx.destination, this.studio);
    syncGraph(graph, this.studio, 0);
    let when = 0.05;
    const solo = this.studio.tracks.some((track) => track.solo);
    for (let step = 0; step < totalSteps; step++) {
      for (let i = 0; i < this.studio.tracks.length; i++) {
        const track = this.studio.tracks[i];
        if (track.mute || (solo && !track.solo)) continue;
        const event = track.steps[step];
        if (!event) continue;
        const duration = studioStepSeconds(this.studio.bpm) * event.gate;
        for (const note of chordNotes(event.note, event.chord)) {
          scheduleVoice(ctx, graph.strips[i].input, track, note, when, duration, event.velocity);
        }
      }
      when += studioStepDuration(this.studio.bpm, this.studio.swing, step);
    }
    return ctx.startRendering();
  }
}
