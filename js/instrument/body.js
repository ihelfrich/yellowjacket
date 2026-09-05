// Body and radiation: what sits between the resonator and the air. A short
// impulse response — generated plate, measured room, or a per-family
// radiation filter — convolved by FFT overlap-add. Part of the instrument.

import { FFT, nextPow2 } from '../fft.js';
import { plateImpulse } from '../dsp/space.js';

/** Linear convolution by FFT overlap-add; output length x + ir − 1. */
export function convolve(x, ir) {
  const outLen = x.length + ir.length - 1;
  const irLen = ir.length;
  const block = Math.max(256, nextPow2(irLen)), N = block * 2, fft = new FFT(N);
  const hre = new Float32Array(N), him = new Float32Array(N);
  hre.set(ir.subarray(0, Math.min(irLen, block)));
  fft.forward(hre, him);
  const out = new Float32Array(outLen);
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let start = 0; start < x.length; start += block) {
    re.fill(0); im.fill(0);
    const len = Math.min(block, x.length - start);
    for (let i = 0; i < len; i++) re[i] = x[start + i];
    fft.forward(re, im);
    for (let k = 0; k < N; k++) { const a = re[k], b = im[k]; re[k] = a * hre[k] - b * him[k]; im[k] = a * him[k] + b * hre[k]; }
    fft.inverse(re, im);
    for (let i = 0; i < N && start + i < outLen; i++) out[start + i] += re[i];
  }
  return out;
}

/**
 * A gentle per-family radiation curve as a 64-tap FIR: bars and plates gain a
 * high shelf above 3 kHz, membranes lose one and gain a low-mid bump, the
 * rest pass through.
 */
export function radiationFilter(family, sampleRate) {
  const taps = 64, h = new Float32Array(taps);
  const tilt = family === 'bar' || family === 'plate' || family === 'cantilever' ? 0.4 : family === 'membrane' ? -0.5 : 0;
  const fc = 3000 / sampleRate;
  for (let i = 0; i < taps; i++) {
    const n = i - taps / 2 + 0.5;
    const sinc = Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / taps);
    h[i] = -tilt * w * sinc; // shelf = (1 + tilt)·δ − tilt·lowpass: unity below 3 kHz, 1 + tilt above
  }
  h[taps / 2] += 1 + tilt;
  if (family === 'membrane') for (let i = 0; i < taps; i++) h[i] += 0.15 * Math.cos(2 * Math.PI * 200 * i / sampleRate) * Math.exp(-i / 20);
  return h;
}

export function applyBody(samples, sampleRate, { kind = 'radiation', family = 'unknown', ir = null, mix = 1 } = {}) {
  let impulse;
  if (kind === 'ir' && ir) impulse = ir instanceof Float32Array ? ir : Float32Array.from(ir);
  else if (kind === 'plate') {
    const { left, right } = plateImpulse(sampleRate, 0.25, 0.5, 0); // a stereo pair; the body is mono, so take the mid
    impulse = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) impulse[i] = 0.5 * (left[i] + right[i]);
  } else impulse = radiationFilter(family, sampleRate);
  const wet = convolve(samples, impulse);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < out.length; i++) out[i] = (1 - mix) * samples[i] + mix * wet[i];
  return out;
}
