// renderVoice: card + pitch + excitation + dynamics → samples at the truth
// rate, with metadata and a content-keyed cache. Closed-form paths render
// directly; the bank runs at 4× and is Kaiser-decimated. Deterministic: no
// timers, DOM, AudioContext or Math.random anywhere below this line.

import { resample } from '../dsp/resample.js';
import { FFT } from '../fft.js';
import { strike } from './excite/strike.js';
import { pluck } from './excite/pluck.js';
import { breath } from './excite/breath.js';
import { applyBody } from './body.js';

export const TRUTH_RATE = 96000;
export const OVERSAMPLE = 4;

const cache = new Map();
export function clearCache() { cache.clear(); }

/** FNV-1a, two lanes, over the canonical JSON of the inputs: a cache key, not a signature. */
export function voiceKey(inputs) {
  const s = JSON.stringify(inputs);
  let h1 = 0x811c9dc5, h2 = 0xcbf29ce4;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c * 31 + 7), 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** Peak, time from the peak until the envelope stays under −60 dB, and a magnitude spectral centroid over the peaks. */
export function describe(samples, sampleRate) {
  let peak = 0, at = 0;
  for (let i = 0; i < samples.length; i++) { const v = Math.abs(samples[i]); if (v > peak) { peak = v; at = i; } }
  const floor = peak * 1e-3, win = Math.max(1, Math.round(0.01 * sampleRate));
  let last = at;
  for (let i = at; i < samples.length; i += win) {
    let m = 0;
    for (let k = i; k < i + win && k < samples.length; k++) m = Math.max(m, Math.abs(samples[k]));
    if (m > floor) last = i;
  }
  const N = 1 << 15, re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N && i < samples.length; i++) re[i] = samples[i];
  new FFT(N).forward(re, im);
  const mag = new Float32Array(N / 2);
  let top = 0;
  for (let k = 1; k < N / 2; k++) { mag[k] = Math.hypot(re[k], im[k]); if (mag[k] > top) top = mag[k]; }
  let n = 0, d = 0;
  for (let k = 1; k < N / 2; k++) if (mag[k] > 0.01 * top) { n += mag[k] * k * sampleRate / N; d += mag[k]; }
  return { peak, decay60Sec: (last - at) / sampleRate, centroidHz: d > 0 ? n / d : 0 };
}

const EXCITATIONS = {
  strike: (card, o) => strike(card, o),
  pluck: (card, o) => pluck(card, o),
  breath: (card, o) => breath(card, { ...o, pressure: (o.pressure ?? 0.6) * (o.dynamics ?? 1) }),
};
// Driven excitations run the bank sample by sample and take the oversampled path.
const DRIVEN = new Set(['breath']);

/** Register another excitation; `driven` sends it through the oversampled bank path. */
export function registerExcitation(name, fn, { driven = true } = {}) {
  EXCITATIONS[name] = fn;
  if (driven) DRIVEN.add(name);
}

export function renderVoice({ card, pitchHz, excitation = 'strike', params = {}, dynamics = 1, seconds = 2, body = { kind: 'radiation' }, seed = 1 } = {}) {
  const inputs = { id: card.id, modes: card.modes, damping: card.damping, family: card.family, nonlinearity: card.nonlinearity || null, retune: card.retune || null, pitchHz, excitation, params, dynamics, seconds, body, seed };
  const key = voiceKey(inputs);
  if (cache.has(key)) return cache.get(key);
  const fn = EXCITATIONS[excitation];
  if (!fn) throw new Error('excitation not available: ' + excitation);
  const nonlinear = !!card.nonlinearity || DRIVEN.has(excitation);
  const rate = nonlinear ? TRUTH_RATE * OVERSAMPLE : TRUTH_RATE;
  const raw = fn(card, { ...params, pitchHz, velocity: dynamics, dynamics, seconds, sampleRate: rate, seed });
  const truthLen = Math.round(seconds * TRUTH_RATE);
  let truth;
  if (rate === TRUTH_RATE) truth = raw;
  else {
    const down = resample(raw, rate, TRUTH_RATE, { cutoffScale: 0.45 });
    truth = new Float32Array(truthLen);
    truth.set(down.subarray(0, Math.min(truthLen, down.length)));
  }
  const samples = body && body.kind ? applyBody(truth, TRUTH_RATE, { ...body, family: card.family.kind }) : truth;
  const result = {
    samples, sampleRate: TRUTH_RATE, key,
    meta: { ...describe(samples, TRUTH_RATE), used: { position: card.hits ? 'measured' : 'theory', path: nonlinear ? 'bank-4x' : 'closed-form' } },
  };
  cache.set(key, result);
  return result;
}
