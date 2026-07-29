// SPACE rack primitives per docs/CONTRACT-CONFORM.md section 4. Pure and
// node-testable: no DOM, no Web Audio, no imports. The plate impulse is
// generated rather than fetched, so the repo carries no binary assets and two
// runs produce bit-identical buffers.
//
// plateImpulse normalization: each channel is scaled by
//     g = sqrt(N / sum(x[i] * x[i]))
// over its FULL length N, predelay zeros included, so each returned channel has
// RMS exactly 1. Per-channel rather than pooled: the two channels are
// independent noise draws whose raw RMS differ by ~0.1%, equalising them
// centres the plate instead of inheriting a random L/R tilt, and per-channel
// unity implies pooled unity anyway. Two consequences the integrator must know:
// set convolver.normalize = false, or the ConvolverNode applies its own scaling
// and this normalization is thrown away; and RMS is a per-sample measure, so
// total impulse ENERGY grows with N and a longer or more pre-delayed plate
// convolves louder. Ride the return gain (verbMix) rather than assuming equal
// wet level across verbSec settings.

const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_BPM = 120;              // same fallback as machine/compile.js
const DEFAULT_SECONDS = 2;
const DEFAULT_DECAY = 0.7;

const SECONDS_MIN = 0.05;
const SECONDS_MAX = 10;
const PREDELAY_MAX_MS = 200;
const DECAY_MIN = 0.05;
const DECAY_MAX = 1;

const EARLY_MAX_SEC = 0.030;          // early-reflection window, plate-sized
const EARLY_FRACTION = 0.1;           // never more than a tenth of a short tail
const EARLY_TAPS = 14;
const PLATE_HF_OPEN = 14000;          // tail brightness at t = 0
const PLATE_HF_DAMPED = 4000;         // ... and at the end of the tail
const DAMPING_BLOCK = 64;             // samples per damping-coefficient refresh
const TAIL_FADE_SEC = 0.005;          // raised-cosine close, no end-of-IR click
const NYQUIST_MARGIN = 0.45;          // same headroom convention as dsp/resample.js
const DECIBEL_DECADES = 3;            // -60 dB is 3 decades of amplitude
const DENORMAL_FLOOR = 1e-38;         // float32 min normal; denormals stall convolvers

// Independent streams for L and R. mulberry32 walks a counter, so any two seeds
// name the same sequence at different offsets; these two sit 92,910,499 steps
// apart (35 minutes at 44.1 kHz), far past any impulse this module builds.
const SEED_LEFT = 0x59454c4c;         // 'YELL'
const SEED_RIGHT = 0x4f57424b;        // 'OWBK'

// mulberry32: counter plus avalanche finaliser, uniform in [0, 1). Same
// generator as js/export.js. Deliberately not an LCG: an LCG's low bits carry
// lattice periodicity that reads as a rhythm to an onset detector.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value, min, max, fallback) {
  const v = Number(value);
  if (!Number.isFinite(v)) return fallback;
  return v < min ? min : v > max ? max : v;
}

// One-pole lowpass coefficient for the delay feedback damping filter:
//     y[n] = (1 - a) * x[n] + a * y[n-1],   a = exp(-2 * pi * fc / fs)
// the impulse-invariant (RC) pole mapping, so the -3 dB point sits on fc for
// fc << fs and the pole never wraps past Nyquist. a rises toward 1 as fc falls,
// i.e. a is monotonically decreasing in hz, and stays inside (0, 1) for every
// accepted cutoff. Web Audio wiring without a worklet:
//     new IIRFilterNode(ctx, { feedforward: [1 - a], feedback: [1, -a] })
export function dampingCoeff(hz, sampleRate) {
  const sr = Number(sampleRate);
  if (!Number.isFinite(sr) || sr <= 0) return 0;    // fallback: filter transparent
  const fc = clamp(hz, 1, NYQUIST_MARGIN * sr, NYQUIST_MARGIN * sr);
  return Math.exp(-2 * Math.PI * fc / sr);
}

// Division length as a multiple of the quarter note. Dotted is 1.5x its
// straight value, triplet is 2/3x. A Map, not an object, so 'constructor' and
// friends miss cleanly instead of returning a prototype member.
const DIVISION_BEATS = new Map([
  ['1/4', 1],
  ['1/8', 1 / 2],
  ['1/8.', 3 / 4],      // 1.5 * 1/2
  ['1/8t', 1 / 3],      // (2/3) * 1/2
  ['1/16', 1 / 4],
  ['1/16t', 1 / 6],     // (2/3) * 1/4
]);

export const DELAY_DIVISIONS = [...DIVISION_BEATS.keys()];
export const DELAY_DIVISION_DEFAULT = '1/8';

// Delay time in seconds. Unknown division falls back to a straight eighth
// rather than throwing: a mistyped preset should still make a usable echo.
export function delayTimeFor(bpm, division) {
  const tempo = Number(bpm);
  const beat = 60 / (Number.isFinite(tempo) && tempo > 0 ? tempo : DEFAULT_BPM);
  const beats = DIVISION_BEATS.get(division);
  return beat * (beats === undefined ? DIVISION_BEATS.get(DELAY_DIVISION_DEFAULT) : beats);
}

// One plate channel: predelay silence, an early-reflection cluster, then the
// dense damped-noise tail under an exponential envelope.
function renderPlate(total, pre, tail, sampleRate, decay, seed) {
  const out = new Float32Array(total);
  if (tail <= 0) return out;
  const rand = mulberry32(seed);
  const tailSec = tail / sampleRate;

  // Early diffusion: discrete taps, one per equal slot of the early window with
  // a random position inside its slot (stratified, so no audible clumping) and a
  // random sign. Amplitude falls across the window; the first bounces are loudest.
  const earlyLen = Math.max(1, Math.round(Math.min(EARLY_MAX_SEC, tailSec * EARLY_FRACTION) * sampleRate));
  const early = new Float32Array(earlyLen);
  for (let k = 0; k < EARLY_TAPS; k++) {
    const slot = (k + rand()) / EARLY_TAPS;
    const idx = Math.min(earlyLen - 1, Math.floor(slot * earlyLen));
    early[idx] += (rand() < 0.5 ? -1 : 1) * (1 - 0.6 * slot);
  }

  // Envelope: 10^(-3t / rt60), i.e. 60 dB down at rt60 = decay * tail length.
  // Stepped multiplicatively, so no transcendental runs per sample.
  const rt60 = Math.max(1e-4, tailSec * decay);
  const envStep = Math.pow(10, -DECIBEL_DECADES / (rt60 * sampleRate));
  let env = 1;

  // Tail brightness sweeps geometrically from open to damped, the frequency-
  // dependent decay that makes a plate read as a plate and not as white noise.
  // The coefficient is refreshed once per DAMPING_BLOCK samples (1.3 ms at
  // 48 kHz) instead of per sample: a 14 kHz to 4 kHz glide over seconds is a
  // sub-millisecond staircase either way, and it keeps exp() out of the hot loop.
  const fOpen = Math.min(PLATE_HF_OPEN, NYQUIST_MARGIN * sampleRate);
  const fDamped = Math.min(PLATE_HF_DAMPED, fOpen);
  const blocks = Math.ceil(tail / DAMPING_BLOCK);
  const fcStep = Math.pow(fDamped / fOpen, 1 / Math.max(1, blocks - 1));
  let fc = fOpen;
  let lp = 0;

  const fadeLen = Math.min(tail, Math.max(1, Math.round(TAIL_FADE_SEC * sampleRate)));
  const fadeStart = tail - fadeLen;

  for (let start = 0; start < tail; start += DAMPING_BLOCK) {
    const stop = Math.min(tail, start + DAMPING_BLOCK);
    const a = dampingCoeff(fc, sampleRate);
    const b = 1 - a;
    fc *= fcStep;
    for (let j = start; j < stop; j++) {
      lp = b * (rand() * 2 - 1) + a * lp;
      // Dense tail thickens behind the early taps rather than starting at full density.
      let s = j < earlyLen ? lp * ((j + 1) / earlyLen) + early[j] : lp;
      s *= env;
      env *= envStep;
      if (j >= fadeStart) s *= 0.5 * (1 + Math.cos(Math.PI * (j - fadeStart) / fadeLen));
      out[pre + j] = s;
    }
  }
  return out;
}

function normalizeRms(channel) {
  let sum = 0;
  for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
  if (!(sum > 0)) return;
  const gain = Math.sqrt(channel.length / sum);
  for (let i = 0; i < channel.length; i++) {
    const v = channel[i] * gain;
    channel[i] = v > DENORMAL_FLOOR || v < -DENORMAL_FLOOR ? v : 0;
  }
}

// Stereo plate impulse for a ConvolverNode. Length is
// round((seconds + predelayMs/1000) * sampleRate) on the CLAMPED arguments:
// seconds 0.05..10, predelayMs 0..200, decay 0.05..1 (the fraction of the tail
// at which the envelope has fallen 60 dB).
export function plateImpulse(sampleRate, seconds, decay, predelayMs) {
  const sr = clamp(sampleRate, 3000, 384000, DEFAULT_SAMPLE_RATE);   // Web Audio's legal rate range
  const sec = clamp(seconds, SECONDS_MIN, SECONDS_MAX, DEFAULT_SECONDS);
  const preMs = clamp(predelayMs, 0, PREDELAY_MAX_MS, 0);
  const dec = clamp(decay, DECAY_MIN, DECAY_MAX, DEFAULT_DECAY);

  const total = Math.round((sec + preMs / 1000) * sr);
  const pre = Math.min(total, Math.round((preMs / 1000) * sr));
  const tail = total - pre;

  const left = renderPlate(total, pre, tail, sr, dec, SEED_LEFT);
  const right = renderPlate(total, pre, tail, sr, dec, SEED_RIGHT);
  normalizeRms(left);
  normalizeRms(right);
  return { left, right };
}
