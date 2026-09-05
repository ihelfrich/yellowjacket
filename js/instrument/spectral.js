// Spectral cards: instruments from sustained or pitched found sound — a vowel,
// a chord, a buzzer, a tone — which the modal fitter cannot card because
// nothing in them decays. A stationary segment is read as its spectral peaks
// (frequency, amplitude) plus a smoothed spectral envelope; decay times come
// from an ASSUMED constant Q, marked as such in the card, unless a release is
// supplied to measure them. Voiced material is read at its harmonics so the
// card's family is the source-filter one: a comb under a formant envelope.
//
// The result is a version-1 card like any other; family.js scales it, the
// excitations play it. What is measured and what is assumed is written down.

import { FFT, nextPow2 } from '../fft.js';
import { sha256HexSync } from '../loom/identity.js';
import { classifyFamily, CARD_VERSION } from './card.js';

/** Magnitude spectrum (Hann) of a segment, → { hz(k), mag: Float32Array, binHz } */
export function magnitudeSpectrum(samples, sampleRate, { size = null } = {}) {
  const N = size || Math.max(2048, nextPow2(samples.length));
  const re = new Float32Array(N), im = new Float32Array(N);
  const n = Math.min(samples.length, N);
  for (let i = 0; i < n; i++) re[i] = samples[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
  new FFT(N).forward(re, im);
  const mag = new Float32Array(N / 2);
  for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k], im[k]) * (4 / n); // Hann-normalised: a sinusoid of amplitude a reads a
  return { mag, binHz: sampleRate / N };
}

/** Smoothed spectral envelope in dB on a log-spaced grid, by peak-following over `bandwidthCents`. */
export function spectralEnvelope(mag, binHz, { fromHz = 40, toHz = 16000, points = 96, bandwidthCents = 300, minWidthHz = 0 } = {}) {
  const hz = [], db = [];
  for (let i = 0; i < points; i++) {
    const f = fromHz * Math.pow(toHz / fromHz, i / (points - 1));
    // the window must span at least one harmonic spacing, or a comb's envelope reads the floor between teeth
    const loHz = Math.min(f * Math.pow(2, -bandwidthCents / 2400), f - minWidthHz / 2), hiHz = Math.max(f * Math.pow(2, bandwidthCents / 2400), f + minWidthHz / 2);
    const lo = Math.max(1, Math.floor(loHz / binHz)), hi = Math.min(mag.length - 1, Math.ceil(hiHz / binHz));
    let m = 0;
    for (let k = lo; k <= hi; k++) if (mag[k] > m) m = mag[k];
    hz.push(f); db.push(20 * Math.log10(m + 1e-9));
  }
  return { hz, db };
}

export function envelopeAt(envelope, freqHz) {
  const { hz, db } = envelope;
  if (freqHz <= hz[0]) return db[0];
  if (freqHz >= hz[hz.length - 1]) return db[db.length - 1];
  let i = 1;
  while (hz[i] < freqHz) i++;
  const t = Math.log(freqHz / hz[i - 1]) / Math.log(hz[i] / hz[i - 1]);
  return db[i - 1] + t * (db[i] - db[i - 1]);
}

function pickPeaks(mag, binHz, { maxPeaks, floorDb, minHz, maxHz }) {
  let top = 0;
  for (let k = 1; k < mag.length; k++) if (mag[k] > top) top = mag[k];
  const floor = top * Math.pow(10, floorDb / 20);
  const peaks = [];
  for (let k = 2; k < mag.length - 2; k++) {
    const f = k * binHz;
    if (f < minHz || f > maxHz || mag[k] < floor) continue;
    if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1] && mag[k] > mag[k - 2] && mag[k] >= mag[k + 2]) {
      const a = mag[k - 1], b = mag[k], c = mag[k + 1], den = a - 2 * b + c;
      const shift = den !== 0 ? 0.5 * (a - c) / den : 0;
      peaks.push({ freqHz: (k + shift) * binHz, amp: b });
    }
  }
  return peaks.sort((a, b) => b.amp - a.amp).slice(0, maxPeaks).sort((a, b) => a.freqHz - b.freqHz);
}

/**
 * Build a spectral card from a stationary segment.
 * - `f0Hz`: read the segment at harmonics of f0 (voice, buzzer, tone) — the
 *   peaks nearest n·f0 within a quarter tone, amplitudes from the spectrum.
 * - `release`: optional samples of the sound's release; per-peak decay times
 *   are measured from it by heterodyne where the fit holds, else assumed.
 * - `assumedQ`: the constant Q used where nothing is measured (marked).
 */
export function spectralCard(samples, sampleRate, {
  name = 'untitled', license = '', note = '', f0Hz = null, maxPeaks = 24, floorDb = -50,
  minHz = 30, maxHz = 12000, assumedQ = 150, release = null, releaseMinR2 = 0.6,
} = {}) {
  const { mag, binHz } = magnitudeSpectrum(samples, sampleRate);
  const envelope = spectralEnvelope(mag, binHz, { toHz: Math.min(16000, sampleRate / 2), minWidthHz: f0Hz ? 1.2 * f0Hz : 0 });
  let peaks;
  if (f0Hz) {
    peaks = [];
    for (let n = 1; n * f0Hz < Math.min(maxHz, sampleRate / 2); n++) {
      const target = n * f0Hz, lo = Math.floor(target * Math.pow(2, -1 / 24) / binHz), hi = Math.ceil(target * Math.pow(2, 1 / 24) / binHz);
      let best = -1, m = 0;
      for (let k = Math.max(1, lo); k <= Math.min(mag.length - 1, hi); k++) if (mag[k] > m) { m = mag[k]; best = k; }
      if (best > 0) peaks.push({ freqHz: best * binHz, amp: m });
      if (peaks.length >= maxPeaks) break;
    }
    let top = 0; for (const p of peaks) top = Math.max(top, p.amp);
    peaks = peaks.filter((p) => p.amp >= top * Math.pow(10, floorDb / 20));
  } else peaks = pickPeaks(mag, binHz, { maxPeaks, floorDb, minHz, maxHz });

  const measured = new Map();
  if (release && release.length > 0.02 * sampleRate) {
    for (const [i, p] of peaks.entries()) {
      const tau = releaseTau(release, sampleRate, p.freqHz, releaseMinR2);
      if (tau) measured.set(i, tau);
    }
  }
  // A card's absolute level is arbitrary (a distant microphone is not a quiet
  // object): the strongest partial is set to 0.5 and the rest keep their ratios.
  let top = 0;
  for (const p of peaks) top = Math.max(top, p.amp);
  const norm = top > 0 ? 0.5 / top : 1;
  const modes = peaks.map((p, i) => ({
    freqHz: p.freqHz, amp: p.amp * norm, phase: 0,
    tauSec: measured.get(i) ?? assumedQ / (Math.PI * p.freqHz),
  }));
  // With a known f0 the formant envelope is the line through the harmonic
  // peaks themselves (the harmonic envelope), which a windowed maximum only
  // smears; without one it is the peak-following envelope above.
  const formantEnvelope = f0Hz && modes.length >= 2
    ? { hz: [modes[0].freqHz / 2, ...modes.map((m) => m.freqHz), modes[modes.length - 1].freqHz * 2], db: [20 * Math.log10(modes[0].amp) - 12, ...modes.map((m) => 20 * Math.log10(m.amp + 1e-9)), 20 * Math.log10(modes[modes.length - 1].amp + 1e-9) - 12] }
    : envelope;
  const family = classifyFamily(modes);
  if (f0Hz && family.kind === 'unknown') { family.kind = 'string'; family.note = 'read at harmonics of f0; treated as a comb'; }
  const card = {
    version: CARD_VERSION,
    id: sha256HexSync(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)).slice(0, 16),
    source: { name, sampleRate, seconds: samples.length / sampleRate, license, note: `${note ? note + ' ' : ''}spectral card${f0Hz ? ' at harmonics of ' + f0Hz.toFixed(1) + ' Hz' : ''}; ${measured.size} of ${modes.length} decays measured from a release, the rest assumed Q ${assumedQ}.` },
    modes,
    damping: { model: 'constant-q', q0: assumedQ, exponent: 0, r2: 0, assumed: measured.size < modes.length },
    family,
    envelope: formantEnvelope,
    residual: { sampleRate, seconds: 0, samples: '' },
    spectral: true,
  };
  return card;
}

// decay time of one partial across a release, by heterodyne amplitude in 10 ms frames
function releaseTau(samples, sampleRate, freqHz, minR2) {
  const frame = Math.round(0.01 * sampleRate), w = 2 * Math.PI * freqHz / sampleRate;
  const xs = [], ys = [];
  for (let start = 0; start + frame <= samples.length; start += frame) {
    let re = 0, im = 0;
    for (let i = 0; i < frame; i++) { const v = samples[start + i], a = w * (start + i); re += v * Math.cos(a); im -= v * Math.sin(a); }
    const amp = Math.hypot(re, im) / frame;
    if (amp > 1e-6) { xs.push((start + frame / 2) / sampleRate); ys.push(Math.log(amp)); }
  }
  if (xs.length < 4) return null;
  const n = xs.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx), intercept = (sy - slope * sx) / n;
  let ssRes = 0, ssTot = 0; const mean = sy / n;
  for (let i = 0; i < n; i++) { ssRes += (ys[i] - (intercept + slope * xs[i])) ** 2; ssTot += (ys[i] - mean) ** 2; }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return slope < 0 && r2 >= minR2 ? -1 / slope : null;
}
