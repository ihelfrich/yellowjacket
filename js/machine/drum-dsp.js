// Deterministic factory-drum renderer. Creative synthesis happens once at a
// fixed 96 kHz truth rate; nonlinear stages run 4x and are Kaiser-decimated.
// The resulting PCM is what live playback, offline render, persistence, and
// hardware export all consume. No timer, DOM, AudioContext, or Math.random.

import { resample } from '../dsp/resample.js';
import { truePeakLinear } from '../dsp/truepeak.js';

export const DRUM_RATE = 96000;
export const DRUM_OVERSAMPLE = 4;
export const DRUM_INTERNAL_RATE = DRUM_RATE * DRUM_OVERSAMPLE;
export const DRUM_ENGINE_VERSION = 1;

const TAU = Math.PI * 2;
const MIN_SECONDS = 0.02;
const MAX_SECONDS = 4;
const DEFAULT_CEILING_DB = -12;
const FADE_IN_SEC = 0.0005;
const FADE_OUT_SEC = 0.003;

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));
}

function value(obj, key, fallback) {
  const x = Number(obj && obj[key]);
  return Number.isFinite(x) ? x : fallback;
}

function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

function linearToDb(x) {
  return x > 0 ? 20 * Math.log10(x) : -Infinity;
}

// Mulberry32 is compact, repeatable, and already used elsewhere in Yellowjacket.
function randomSource(seed) {
  let a = (Number(seed) >>> 0) || 0x594A4B54;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function decay(t, tau) {
  return Math.exp(-t / Math.max(1e-6, tau));
}

// RBJ biquads in transposed direct form II. Coefficients and state remain
// Float64 through the 384 kHz render; only the final asset becomes Float32.
class Biquad {
  constructor(type, frequency, q, sampleRate) {
    const f = clamp(frequency, 2, sampleRate * 0.475);
    const Q = clamp(q, 0.1, 24);
    const w = TAU * f / sampleRate;
    const c = Math.cos(w);
    const s = Math.sin(w);
    const alpha = s / (2 * Q);
    let b0;
    let b1;
    let b2;
    if (type === 'highpass') {
      b0 = (1 + c) / 2;
      b1 = -(1 + c);
      b2 = (1 + c) / 2;
    } else if (type === 'bandpass') {
      b0 = s / 2;
      b1 = 0;
      b2 = -s / 2;
    } else {
      b0 = (1 - c) / 2;
      b1 = 1 - c;
      b2 = (1 - c) / 2;
    }
    const a0 = 1 + alpha;
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - alpha) / a0;
    this.z1 = 0;
    this.z2 = 0;
  }

  tick(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

function square(phase) {
  return Math.sin(phase) >= 0 ? 1 : -1;
}

function modelKick(out, p, rand, rate) {
  const startHz = value(p, 'startHz', 185);
  const endHz = value(p, 'endHz', 48);
  const pitchTau = value(p, 'pitchTau', 0.024);
  const bodyTau = value(p, 'decay', 0.32);
  const attack = value(p, 'attack', 0.0012);
  const click = value(p, 'click', 0.05);
  const clickTau = value(p, 'clickTau', 0.004);
  const harmonic = value(p, 'harmonic', 0.08);
  let phase = value(p, 'phase', 0);
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const f = endHz + (startHz - endHz) * decay(t, pitchTau);
    phase += TAU * f / rate; // integrate instantaneous frequency; never sin(2πf(t)t)
    const amp = (1 - decay(t, attack)) * decay(t, bodyTau);
    const body = (Math.sin(phase) + harmonic * Math.sin(2 * phase)) * amp;
    const transient = (rand() * 2 - 1) * click * decay(t, clickTau);
    out[i] = body + transient;
  }
}

function modelSnare(out, p, rand, rate) {
  const shellHz = value(p, 'shellHz', 185);
  const shellTau = value(p, 'shellDecay', 0.11);
  const noiseTau = value(p, 'noiseDecay', 0.16);
  const noiseMix = value(p, 'noise', 0.72);
  const noiseFilter = new Biquad('bandpass', value(p, 'noiseHz', 2300), value(p, 'noiseQ', 0.65), rate);
  let p1 = 0;
  let p2 = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    p1 += TAU * shellHz / rate;
    p2 += TAU * shellHz * 1.62 / rate;
    const shell = (Math.sin(p1) + 0.42 * Math.sin(p2)) * decay(t, shellTau);
    const noise = noiseFilter.tick(rand() * 2 - 1) * decay(t, noiseTau);
    out[i] = shell * (1 - noiseMix) + noise * noiseMix;
  }
}

function modelClap(out, p, rand, rate) {
  const filter = new Biquad('bandpass', value(p, 'centerHz', 1500), value(p, 'q', 0.55), rate);
  const tailTau = value(p, 'tailDecay', 0.14);
  const spacing = value(p, 'spacing', 0.012);
  const burstTau = value(p, 'burstDecay', 0.005);
  const bursts = Math.round(clamp(value(p, 'bursts', 4), 2, 6));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    let env = 0.22 * decay(t, tailTau);
    for (let b = 0; b < bursts; b++) {
      const dt = t - b * spacing;
      if (dt >= 0) env += decay(dt, burstTau);
    }
    out[i] = filter.tick(rand() * 2 - 1) * env;
  }
}

const METAL_RATIOS = [1, 1.4471, 1.617, 1.9265, 2.5028, 2.6637];

function modelHat(out, p, rand, rate) {
  const base = value(p, 'baseHz', 540);
  const ampTau = value(p, 'decay', 0.075);
  const noiseMix = clamp(value(p, 'noise', 0.18), 0, 1);
  const phases = METAL_RATIOS.map((_, i) => i * 0.37);
  const hp = new Biquad('highpass', value(p, 'highpassHz', 6200), value(p, 'highpassQ', 0.65), rate);
  const bp = new Biquad('bandpass', value(p, 'metalHz', 10300), value(p, 'metalQ', 0.85), rate);
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    let metal = 0;
    for (let j = 0; j < phases.length; j++) {
      phases[j] += TAU * base * METAL_RATIOS[j] / rate;
      metal += square(phases[j]);
    }
    metal /= phases.length;
    const exciter = metal * (1 - noiseMix) + (rand() * 2 - 1) * noiseMix;
    out[i] = bp.tick(hp.tick(exciter)) * decay(t, ampTau);
  }
}

function modelTom(out, p, rand, rate) {
  const startHz = value(p, 'startHz', 178);
  const endHz = value(p, 'endHz', 106);
  const pitchTau = value(p, 'pitchTau', 0.055);
  const ampTau = value(p, 'decay', 0.28);
  const transient = value(p, 'transient', 0.035);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const f = endHz + (startHz - endHz) * decay(t, pitchTau);
    phase += TAU * f / rate;
    const tone = Math.sin(phase) + 0.18 * Math.sin(2.03 * phase);
    out[i] = tone * decay(t, ampTau) + (rand() * 2 - 1) * transient * decay(t, 0.004);
  }
}

function modelRim(out, p, rand, rate) {
  const f1 = value(p, 'f1', 520);
  const f2 = value(p, 'f2', 1760);
  const tau = value(p, 'decay', 0.035);
  const hp = new Biquad('highpass', value(p, 'highpassHz', 1800), 0.7, rate);
  let p1 = 0;
  let p2 = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    p1 += TAU * f1 / rate;
    p2 += TAU * f2 / rate;
    const stick = Math.sin(p1) * 0.55 + Math.sin(p2) * 0.45;
    out[i] = (stick + hp.tick(rand() * 2 - 1) * 0.18) * decay(t, tau);
  }
}

function modelCowbell(out, p, rand, rate) {
  const f1 = value(p, 'f1', 540);
  const f2 = value(p, 'f2', 800);
  const tau = value(p, 'decay', 0.19);
  const bp = new Biquad('bandpass', value(p, 'centerHz', 1180), value(p, 'q', 1.1), rate);
  let p1 = 0;
  let p2 = 0.5;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    p1 += TAU * f1 / rate;
    p2 += TAU * f2 / rate;
    out[i] = bp.tick(square(p1) * 0.56 + square(p2) * 0.44) * decay(t, tau);
  }
}

function modelFmPerc(out, p, rand, rate) {
  const carrier = value(p, 'carrierHz', 210);
  const ratio = value(p, 'ratio', 2.713);
  const index = value(p, 'index', 5.5);
  const modTau = value(p, 'modDecay', 0.09);
  const ampTau = value(p, 'decay', 0.25);
  let pc = 0;
  let pm = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    pc += TAU * carrier / rate;
    pm += TAU * carrier * ratio / rate;
    out[i] = Math.sin(pc + index * decay(t, modTau) * Math.sin(pm)) * decay(t, ampTau);
  }
}

function modelCymbal(out, p, rand, rate) {
  const base = value(p, 'baseHz', 330);
  const fastTau = value(p, 'fastDecay', 0.22);
  const tailTau = value(p, 'tailDecay', 0.72);
  const phases = METAL_RATIOS.map((_, i) => i * 0.73);
  const hp = new Biquad('highpass', value(p, 'highpassHz', 4300), 0.62, rate);
  const bp = new Biquad('bandpass', value(p, 'metalHz', 8700), 0.7, rate);
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    let metal = 0;
    for (let j = 0; j < phases.length; j++) {
      phases[j] += TAU * base * METAL_RATIOS[j] / rate;
      metal += square(phases[j]);
    }
    metal = metal / phases.length * 0.78 + (rand() * 2 - 1) * 0.22;
    const env = 0.64 * decay(t, fastTau) + 0.36 * decay(t, tailTau);
    out[i] = bp.tick(hp.tick(metal)) * env;
  }
}

const MODELS = Object.freeze({
  kick: modelKick,
  snare: modelSnare,
  clap: modelClap,
  hat: modelHat,
  tom: modelTom,
  rim: modelRim,
  cowbell: modelCowbell,
  'fm-perc': modelFmPerc,
  cymbal: modelCymbal,
});

function filterInPlace(samples, type, frequency, q, rate) {
  if (!(frequency > 0)) return;
  const f = new Biquad(type, frequency, q, rate);
  for (let i = 0; i < samples.length; i++) samples[i] = f.tick(samples[i]);
}

function dcBlockInPlace(samples, rate, cutoff = 7) {
  const r = Math.exp(-TAU * cutoff / rate);
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = x - x1 + r * y1;
    samples[i] = y;
    x1 = x;
    y1 = y;
  }
}

// Saturation is deliberately performed before the 384 -> 96 kHz decimator,
// so harmonics created by the nonlinearity do not fold into the audible band.
function saturateInPlace(samples, driveDb, asymmetry = 0) {
  if (!(driveDb > 0)) return;
  const k = Math.max(1, dbToLinear(clamp(driveDb, 0, 30)));
  const bias = clamp(asymmetry, -0.25, 0.25);
  const zero = Math.tanh(k * bias);
  const norm = 1 / Math.max(1e-9, Math.tanh(k) - zero);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = (Math.tanh(k * (samples[i] + bias)) - zero) * norm;
  }
}

function fadeInOut(samples, sampleRate) {
  const n = samples.length;
  const fadeIn = Math.min(Math.round(FADE_IN_SEC * sampleRate), Math.floor(n / 2));
  const fadeOut = Math.min(Math.round(FADE_OUT_SEC * sampleRate), Math.floor(n / 2));
  for (let i = 0; i < fadeIn; i++) {
    samples[i] *= Math.sin((i / Math.max(1, fadeIn)) * Math.PI / 2);
  }
  for (let i = 0; i < fadeOut; i++) {
    samples[n - 1 - i] *= Math.sin((i / Math.max(1, fadeOut)) * Math.PI / 2);
  }
  if (n) samples[0] = 0;
  if (n > 1) samples[n - 1] = 0;
}

function sampleMetrics(pcm, truePeak) {
  let peak = 0;
  let sumSq = 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const x = pcm[i];
    const a = Math.abs(x);
    if (a > peak) peak = a;
    sumSq += x * x;
    sum += x;
  }
  const rms = pcm.length ? Math.sqrt(sumSq / pcm.length) : 0;
  return Object.freeze({
    frames: pcm.length,
    seconds: pcm.length / DRUM_RATE,
    peakDb: linearToDb(peak),
    rmsDb: linearToDb(rms),
    truePeakDb: linearToDb(truePeak),
    dc: pcm.length ? sum / pcm.length : 0,
  });
}

/**
 * Render one immutable factory voice definition to canonical 96 kHz mono PCM.
 * `sampleRate` is accepted only as an assertion; factory identity never follows
 * a loaded source or the user's output device.
 */
export function renderFactoryVoice(def, opts = {}) {
  if (!def || typeof def !== 'object') throw new TypeError('factory voice definition required');
  const sampleRate = opts.sampleRate == null ? DRUM_RATE : Math.round(Number(opts.sampleRate));
  if (sampleRate !== DRUM_RATE) throw new RangeError('factory drums render at exactly 96000 Hz');
  const model = String(def.model || '');
  const render = MODELS[model];
  if (!render) throw new RangeError('unknown drum model "' + model + '"');

  const seconds = clamp(value(def, 'seconds', 0.25), MIN_SECONDS, MAX_SECONDS);
  const outFrames = Math.max(2, Math.round(seconds * DRUM_RATE));
  const internalFrames = outFrames * DRUM_OVERSAMPLE;
  const internal = new Float64Array(internalFrames);
  const params = def.params && typeof def.params === 'object' ? def.params : {};
  const rand = randomSource(def.seed);
  render(internal, params, rand, DRUM_INTERNAL_RATE);

  // Fixed filters are part of the baked voice, not browser-specific WebAudio.
  const highpassHz = value(params, 'postHighpassHz', 0);
  const lowpassHz = value(params, 'postLowpassHz', 0);
  if (highpassHz > 0) filterInPlace(internal, 'highpass', highpassHz, value(params, 'postHighpassQ', 0.707), DRUM_INTERNAL_RATE);
  if (lowpassHz > 0) filterInPlace(internal, 'lowpass', lowpassHz, value(params, 'postLowpassQ', 0.707), DRUM_INTERNAL_RATE);
  dcBlockInPlace(internal, DRUM_INTERNAL_RATE, value(params, 'dcBlockHz', 7));
  saturateInPlace(internal, value(params, 'saturation', 0), value(params, 'asymmetry', 0));

  const pcm = resample(internal, DRUM_INTERNAL_RATE, DRUM_RATE);
  // `internalFrames` is exactly 4x, but pin length in case the shared resampler
  // changes its rounding rule later.
  if (pcm.length !== outFrames) throw new Error('drum decimator returned the wrong frame count');

  const outputGain = dbToLinear(clamp(value(def, 'outputGainDb', 0), -48, 12));
  for (let i = 0; i < pcm.length; i++) pcm[i] *= outputGain;
  fadeInOut(pcm, DRUM_RATE);

  // A ceiling is a one-way safety rail, never normalization: quiet designs stay
  // quiet and relationships encoded by outputGainDb remain intact.
  const ceilingDb = clamp(value(def, 'ceilingDb', DEFAULT_CEILING_DB), -30, -3);
  const ceiling = dbToLinear(ceilingDb);
  let truePeak = truePeakLinear([pcm]);
  let gainReductionDb = 0;
  if (truePeak > ceiling && truePeak > 0) {
    const trim = ceiling / truePeak;
    for (let i = 0; i < pcm.length; i++) pcm[i] *= trim;
    gainReductionDb = linearToDb(trim);
    truePeak = truePeakLinear([pcm]);
  }
  const metrics = sampleMetrics(pcm, truePeak);

  return {
    pcm,
    sampleRate: DRUM_RATE,
    engineVersion: DRUM_ENGINE_VERSION,
    model,
    seed: Number(def.seed) >>> 0,
    params: { ...params },
    ceilingDb,
    gainReductionDb,
    metrics,
  };
}

export function supportedDrumModels() {
  return Object.freeze(Object.keys(MODELS));
}
