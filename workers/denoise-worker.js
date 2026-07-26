// Denoise worker — stationary spectral gating per the noisereduce recipe
// (github.com/timsainb/noisereduce). One channel per message.
//
// Protocol:
//   in:  { type:'process', samples: Float32Array (transfer), sampleRate, strength, floorDb }
//   out: { type:'progress', pct }                 // 0..100
//   out: { type:'done', samples: Float32Array (transfer) }
//   out: { type:'error', message }

import { FFT, hann } from '../js/fft.js';

const N_FFT = 1024;
const HOP = 256;
const BINS = N_FFT / 2 + 1;

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'process') return;
  try {
    const out = denoiseChannel(
      msg.samples,
      Number(msg.sampleRate),
      Number(msg.strength),
      Number(msg.floorDb)
    );
    self.postMessage({ type: 'done', samples: out }, [out.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function denoiseChannel(samples, sampleRate, strength, floorDb) {
  const len = samples.length;
  if (len === 0) return new Float32Array(0);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('Denoise: invalid sample rate');
  }
  const prop = clamp(Number.isFinite(strength) ? strength : 0.85, 0, 1);
  const floorLin = 10 ** (clamp(Number.isFinite(floorDb) ? floorDb : -60, -80, -20) / 20);

  let lastPct = -1;
  const progress = (pct) => {
    const p = clamp(pct, 0, 100);
    if (p - lastPct >= 1 || p >= 100) {
      lastPct = p;
      self.postMessage({ type: 'progress', pct: p });
    }
  };
  progress(0);

  const fft = new FFT(N_FFT);
  const win = hann(N_FFT);
  const nFrames = Math.max(1, Math.ceil(len / HOP));
  const re = new Float32Array(N_FFT);
  const im = new Float32Array(N_FFT);

  // Pass A: magnitude spectrogram in dB + per-frame RMS.
  const magDb = new Float32Array(nFrames * BINS);
  const frameRms = new Float32Array(nFrames);
  const tick = Math.max(1, Math.floor(nFrames / 60));
  for (let t = 0; t < nFrames; t++) {
    const pos = t * HOP;
    let sq = 0;
    for (let k = 0; k < N_FFT; k++) {
      const s = pos + k < len ? samples[pos + k] : 0;
      sq += s * s;
      re[k] = s * win[k];
      im[k] = 0;
    }
    frameRms[t] = Math.sqrt(sq / N_FFT);
    fft.forward(re, im);
    const row = t * BINS;
    for (let f = 0; f < BINS; f++) {
      const mag = Math.hypot(re[f], im[f]);
      magDb[row + f] = 20 * Math.log10(mag + 1e-12);
    }
    if (t % tick === 0) progress((t / nFrames) * 45);
  }

  // Noise profile: quietest 15% of frames by RMS, at least ~0.5 s worth.
  const order = new Uint32Array(nFrames);
  for (let t = 0; t < nFrames; t++) order[t] = t;
  const sorted = Array.from(order).sort((a, b) => frameRms[a] - frameRms[b]);
  const minProfile = Math.ceil((0.5 * sampleRate) / HOP);
  const nProfile = Math.min(nFrames, Math.max(Math.ceil(0.15 * nFrames), minProfile));

  const mean = new Float64Array(BINS);
  const sumSq = new Float64Array(BINS);
  for (let i = 0; i < nProfile; i++) {
    const row = sorted[i] * BINS;
    for (let f = 0; f < BINS; f++) {
      const v = magDb[row + f];
      mean[f] += v;
      sumSq[f] += v * v;
    }
  }
  const thresh = new Float32Array(BINS);
  for (let f = 0; f < BINS; f++) {
    const m = mean[f] / nProfile;
    const variance = Math.max(0, sumSq[f] / nProfile - m * m);
    // Per-bin threshold: mean + 1.5 * std, all in dB.
    thresh[f] = m + 1.5 * Math.sqrt(variance);
  }

  // Binary mask, written over magDb in place.
  for (let t = 0; t < nFrames; t++) {
    const row = t * BINS;
    for (let f = 0; f < BINS; f++) {
      magDb[row + f] = magDb[row + f] > thresh[f] ? 1 : 0;
    }
  }
  progress(47);

  // Smooth the MASK (not the audio): separable box blur,
  // ~500 Hz wide in frequency, ~50 ms wide in time.
  const freqRadius = Math.floor(Math.round((500 * N_FFT) / sampleRate) / 2);
  const timeRadius = Math.floor(Math.round((0.05 * sampleRate) / HOP) / 2);
  boxBlurFreq(magDb, nFrames, freqRadius);
  progress(51);
  boxBlurTime(magDb, nFrames, timeRadius);
  progress(55);

  // Mask -> gain: 1 - prop * (1 - mask), floored.
  for (let i = 0; i < magDb.length; i++) {
    const g = 1 - prop * (1 - magDb[i]);
    magDb[i] = Math.min(1, Math.max(g, floorLin));
  }

  // Pass B: re-analyze, apply gain, Hann-windowed overlap-add resynthesis.
  const out = new Float32Array(len);
  const wss = new Float32Array(len);
  for (let t = 0; t < nFrames; t++) {
    const pos = t * HOP;
    for (let k = 0; k < N_FFT; k++) {
      const s = pos + k < len ? samples[pos + k] : 0;
      re[k] = s * win[k];
      im[k] = 0;
    }
    fft.forward(re, im);
    const row = t * BINS;
    for (let f = 0; f < BINS; f++) {
      const g = magDb[row + f];
      re[f] *= g;
      im[f] *= g;
      if (f > 0 && f < N_FFT / 2) {
        re[N_FFT - f] *= g;
        im[N_FFT - f] *= g;
      }
    }
    fft.inverse(re, im);
    const stop = Math.min(N_FFT, len - pos);
    for (let k = 0; k < stop; k++) {
      out[pos + k] += re[k] * win[k];
      wss[pos + k] += win[k] * win[k];
    }
    if (t % tick === 0) progress(55 + (t / nFrames) * 44);
  }

  // Analysis + synthesis Hann at hop N/4 overlap-add to a constant 1.5 in the
  // interior; wss holds exactly that (and the true partial sums at the edges).
  for (let i = 0; i < len; i++) {
    out[i] = wss[i] > 1e-8 ? out[i] / wss[i] : 0;
  }

  progress(100);
  return out;
}

function boxBlurFreq(mask, nFrames, radius) {
  if (radius < 1) return;
  const prefix = new Float64Array(BINS + 1);
  for (let t = 0; t < nFrames; t++) {
    const row = t * BINS;
    for (let f = 0; f < BINS; f++) prefix[f + 1] = prefix[f] + mask[row + f];
    for (let f = 0; f < BINS; f++) {
      const lo = Math.max(0, f - radius);
      const hi = Math.min(BINS - 1, f + radius);
      mask[row + f] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
    }
  }
}

function boxBlurTime(mask, nFrames, radius) {
  if (radius < 1) return;
  const prefix = new Float64Array(nFrames + 1);
  for (let f = 0; f < BINS; f++) {
    for (let t = 0; t < nFrames; t++) prefix[t + 1] = prefix[t] + mask[t * BINS + f];
    for (let t = 0; t < nFrames; t++) {
      const lo = Math.max(0, t - radius);
      const hi = Math.min(nFrames - 1, t + radius);
      mask[t * BINS + f] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
    }
  }
}
