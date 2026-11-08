import { FFT, hann } from '../fft.js';

// Full windows only; times denote window centres, never stretched image columns.
export function spectrumPlan(length, sampleRate, options = {}) {
  const { fftSize = 32768, lowHz = 20, highHz = 1000, offset = 0 } = options;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 ||
      !Number.isInteger(fftSize) || fftSize < 1024 || fftSize > 131072 || (fftSize & (fftSize - 1)))
    throw Error('Choose a valid sample rate and analysis window.');
  if (![lowHz, highHz, offset].every(Number.isFinite) || lowHz < 0 || highHz <= lowHz || highHz > sampleRate / 2 || offset < 0)
    throw Error('Frequency limits must be ordered and within the recording’s Nyquist frequency.');
  if (length < fftSize) throw Error('Passage is shorter than one analysis window. Select more time or a smaller window.');
  const hop = fftSize / 4, binHz = sampleRate / fftSize;
  const firstBin = Math.ceil(lowHz / binHz), lastBin = Math.floor(highHz / binHz);
  const bins = lastBin - firstBin + 1, cols = 1 + Math.floor((length - fftSize) / hop);
  if (bins < 1) throw Error('Band is narrower than a frequency bin. Widen it or use a larger window.');
  if (cols > 4096 || cols * bins > 8_000_000 || cols * fftSize > 100_000_000)
    throw Error('Passage exceeds the analysis budget. Shorten the time range or narrow the frequency band.');
  return { fftSize, hop, binHz, firstBin, bins, cols, sampleRate, offset,
    firstTime: offset + fftSize / (2 * sampleRate), stepTime: hop / sampleRate,
    windowSeconds: fftSize / sampleRate };
}

export function precisionSpectrum(samples, sampleRate, options) {
  const p = spectrumPlan(samples.length, sampleRate, options);
  const fft = new FFT(p.fftSize, { precision: 'f64' }), window = hann(p.fftSize);
  const re = new Float64Array(p.fftSize), im = new Float64Array(p.fftSize);
  const db = new Float32Array(p.cols * p.bins);
  const sum = window.reduce((a, b) => a + b, 0);
  for (let c = 0; c < p.cols; c++) {
    for (let i = 0; i < p.fftSize; i++) re[i] = samples[c * p.hop + i] * window[i];
    im.fill(0); fft.forward(re, im);
    for (let b = 0; b < p.bins; b++) {
      const k = p.firstBin + b;
      const scale = (k === 0 || k === p.fftSize / 2) ? 1 / sum : 2 / sum;
      db[c * p.bins + b] = 20 * Math.log10(Math.max(1e-15, Math.hypot(re[k], im[k]) * scale));
    }
  }
  return { ...p, db };
}

export function spectrumCell(result, time, hz) {
  const c = Math.max(0, Math.min(result.cols - 1, Math.round((time - result.firstTime) / result.stepTime)));
  const b = Math.max(0, Math.min(result.bins - 1, Math.round(hz / result.binHz) - result.firstBin));
  return { time: result.firstTime + c * result.stepTime, hz: (result.firstBin + b) * result.binHz,
    db: result.db[c * result.bins + b], c, b };
}
