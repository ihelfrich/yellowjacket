// Yellowjacket — spectrogram STFT worker (module). Takes transferred mono audio,
// returns column-major magnitudes in dB clamped [-90, 0]. Frames stride evenly
// when the clip would exceed maxCols columns.

import { FFT, hann } from '../js/fft.js';

const FFT_SIZE_DEFAULT = 2048;
const HOP_DEFAULT = 512;
const MAX_COLS_DEFAULT = 8000;
const MIN_DB = -90;
const MAX_DB = 0;
const DB_PER_LN = 8.685889638065037; // 20 / ln(10)

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'compute') return;

  const mono = msg.mono instanceof Float32Array ? msg.mono : new Float32Array(0);
  let fftSize = msg.fftSize > 0 ? Math.floor(msg.fftSize) : FFT_SIZE_DEFAULT;
  if (fftSize < 2 || (fftSize & (fftSize - 1)) !== 0) fftSize = FFT_SIZE_DEFAULT;
  const hop = msg.hop > 0 ? Math.floor(msg.hop) : HOP_DEFAULT;
  const maxCols = msg.maxCols > 0 ? Math.floor(msg.maxCols) : MAX_COLS_DEFAULT;
  const bins = fftSize >> 1;
  const n = mono.length;

  if (!n) {
    self.postMessage({ type: 'done', mags: new Float32Array(0), cols: 0, bins, minDb: MIN_DB, maxDb: MAX_DB });
    return;
  }

  const totalFrames = n >= fftSize ? Math.floor((n - fftSize) / hop) + 1 : 1;
  const cols = Math.min(totalFrames, maxCols);

  const fft = new FFT(fftSize);
  const win = hann(fftSize);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const mags = new Float32Array(cols * bins);

  // 0 dBFS reference: peak bin of a full-scale sine = sum(window) / 2
  let winSum = 0;
  for (let i = 0; i < fftSize; i++) winSum += win[i];
  const norm = 2 / winSum;

  let nextPct = 5;
  for (let c = 0; c < cols; c++) {
    const frame = cols === totalFrames ? c : Math.floor((c * totalFrames) / cols);
    const start = frame * hop;
    const avail = Math.min(fftSize, n - start);
    for (let i = 0; i < avail; i++) re[i] = mono[start + i] * win[i];
    if (avail < fftSize) re.fill(0, avail);
    im.fill(0);
    fft.forward(re, im);

    const base = c * bins;
    for (let b = 0; b < bins; b++) {
      const m = Math.sqrt(re[b] * re[b] + im[b] * im[b]) * norm;
      let db = m > 0 ? DB_PER_LN * Math.log(m) : MIN_DB;
      if (db < MIN_DB) db = MIN_DB;
      else if (db > MAX_DB) db = MAX_DB;
      mags[base + b] = db;
    }

    const pct = ((c + 1) / cols) * 100;
    if (pct >= nextPct || c === cols - 1) {
      self.postMessage({ type: 'progress', pct: Math.min(100, Math.round(pct)) });
      nextPct = Math.floor(pct / 5) * 5 + 5;
    }
  }

  self.postMessage({ type: 'done', mags, cols, bins, minDb: MIN_DB, maxDb: MAX_DB }, [mags.buffer]);
};
