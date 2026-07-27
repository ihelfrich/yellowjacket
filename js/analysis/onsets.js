// Onset detection via spectral flux. Worker-safe, pure. Contract: docs/CONTRACT-MACHINE.md.

import { FFT, hann } from '../fft.js';

const FFT_SIZE = 1024;
const HOP = 512;

export function onsetAnalysis(mono, sampleRate) {
  const envelopeRate = sampleRate / HOP;
  if (!mono || mono.length < FFT_SIZE * 2 || !isFinite(sampleRate) || sampleRate <= 0) {
    return { envelope: new Float32Array(0), envelopeRate: envelopeRate || 0, onsets: new Float32Array(0) };
  }

  const fft = new FFT(FFT_SIZE);
  const win = hann(FFT_SIZE);
  const bins = FFT_SIZE / 2;
  const frames = Math.floor((mono.length - FFT_SIZE) / HOP) + 1;

  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const prevMag = new Float32Array(bins);
  const curMag = new Float32Array(bins);
  const flux = new Float32Array(frames);

  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = mono[off + i] * win[i];
      im[i] = 0;
    }
    fft.forward(re, im);
    let sum = 0;
    for (let b = 0; b < bins; b++) {
      // Log compression tames level dependence before differencing.
      const m = Math.log(1 + 10 * Math.hypot(re[b], im[b]));
      curMag[b] = m;
      const d = m - prevMag[b];
      if (d > 0) sum += d; // half-wave rectified positive flux
    }
    flux[f] = f === 0 ? 0 : sum;
    prevMag.set(curMag);
  }

  // Light 3-frame smoothing, [0.25 0.5 0.25]. A median here would erase
  // single-frame flux spikes, which is exactly what a sharp transient produces.
  const med = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const a = flux[Math.max(0, f - 1)];
    const b = flux[f];
    const c = flux[Math.min(frames - 1, f + 1)];
    med[f] = 0.25 * a + 0.5 * b + 0.25 * c;
  }

  // Subtract an 8-frame moving average, keep the positive residual.
  const envelope = new Float32Array(frames);
  const HALF = 4;
  let winSum = 0;
  let lo = 0;
  let hi = -1;
  for (let f = 0; f < frames; f++) {
    const wantLo = Math.max(0, f - HALF);
    const wantHi = Math.min(frames - 1, f + HALF - 1);
    while (hi < wantHi) { hi++; winSum += med[hi]; }
    while (lo < wantLo) { winSum -= med[lo]; lo++; }
    const mean = winSum / (hi - lo + 1);
    const v = med[f] - mean;
    envelope[f] = v > 0 ? v : 0;
  }

  // Peak picking: local max over +-3 frames, adaptive threshold from +-8 frames,
  // 30 ms minimum inter-onset gap.
  const minGapFrames = Math.max(1, Math.round(0.030 * envelopeRate));
  const onsetFrames = [];
  let lastPick = -Infinity;
  for (let f = 0; f < frames; f++) {
    const v = envelope[f];
    if (v <= 0) continue;
    let isMax = true;
    for (let k = Math.max(0, f - 3); k <= Math.min(frames - 1, f + 3); k++) {
      if (envelope[k] > v) { isMax = false; break; }
    }
    if (!isMax) continue;
    const a = Math.max(0, f - 8);
    const b = Math.min(frames - 1, f + 8);
    let mean = 0;
    for (let k = a; k <= b; k++) mean += envelope[k];
    mean /= (b - a + 1);
    let sd = 0;
    for (let k = a; k <= b; k++) { const d = envelope[k] - mean; sd += d * d; }
    sd = Math.sqrt(sd / (b - a + 1));
    if (v < mean + 0.3 * sd) continue;
    if (f - lastPick < minGapFrames) continue;
    lastPick = f;
    onsetFrames.push(f);
  }

  // Frame center convention: window midpoint.
  const centerOff = FFT_SIZE / (2 * sampleRate);
  const onsets = new Float32Array(onsetFrames.length);
  for (let i = 0; i < onsetFrames.length; i++) onsets[i] = onsetFrames[i] * HOP / sampleRate + centerOff;

  return { envelope, envelopeRate, onsets };
}
