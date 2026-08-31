// Soundscape split: how a recording's energy divides between the band engines
// occupy and the band birds occupy.
//
// NDSI, after Kasten, Gage, Fox & Joo 2012 (Ecological Informatics 12:50-67),
// following the reference implementation in the R package `soundecology`:
// a Welch power spectral density binned into 1 kHz bands, with
//   anthrophony = 1-2 kHz      (engines, rotors, road roar)
//   biophony    = 2-11 kHz     (most bird and insect voice)
//   NDSI = (biophony - anthrophony) / (biophony + anthrophony)   in [-1, +1]
// +1 is a recording with nothing in the machine band; -1 is the reverse.
//
// Two caveats, both deliberate and both stated in the UI rather than buried:
//
// 1. The two reference implementations disagree. `soundecology` (following
//    Kasten) puts biophony at 2-11 kHz; `seewave` stops at 8 kHz. This follows
//    soundecology. A number from one is not comparable with the other.
// 2. This measures THE RECORDING, not the ecosystem. Since 2021 the ecoacoustics
//    literature has been steadily withdrawing these indices as biodiversity
//    proxies — see Bradfer-Lawrence et al. 2023 (Methods Ecol. Evol.) and
//    "Acoustic indices fail to represent different facets of biodiversity"
//    (Ecological Indicators, 2024). Treat it as a standardised listening frame:
//    a repeatable way to ask how much of what you recorded was machinery.

import { FFT, hann } from '../fft.js';

export const NDSI_ANTHROPHONY_HZ = Object.freeze([1000, 2000]);
export const NDSI_BIOPHONY_HZ = Object.freeze([2000, 11000]);

const WINDOW = 1024;          // ~21 ms at 48 kHz; the soundecology default shape
const BIN_HZ = 1000;          // the index is defined on 1 kHz bins, not raw FFT bins

const EMPTY = Object.freeze({
  ndsi: 0, biophony: 0, anthrophony: 0, bandLimited: false, windows: 0,
});

/**
 * Welch PSD: Hann-windowed segments at 50% overlap, power averaged across them.
 * Returns the one-sided spectrum and the width of each FFT bin in Hz.
 */
export function welchPsd(mono, sampleRate, windowSize = WINDOW) {
  const n = mono ? mono.length : 0;
  if (!n || n < windowSize || !(sampleRate > 0)) return null;
  const fft = new FFT(windowSize);
  const win = hann(windowSize);
  const half = windowSize >> 1;
  const psd = new Float64Array(half);
  const re = new Float32Array(windowSize);
  const im = new Float32Array(windowSize);
  const hop = windowSize >> 1;
  let windows = 0;
  for (let start = 0; start + windowSize <= n; start += hop) {
    for (let i = 0; i < windowSize; i++) {
      re[i] = mono[start + i] * win[i];
      im[i] = 0;
    }
    fft.forward(re, im);
    for (let k = 0; k < half; k++) psd[k] += re[k] * re[k] + im[k] * im[k];
    windows++;
  }
  if (!windows) return null;
  for (let k = 0; k < half; k++) psd[k] /= windows;
  return { psd, binHz: sampleRate / windowSize, windows };
}

// Sum a frequency range after collapsing the spectrum onto 1 kHz bins, which is
// how the index is defined. Summing raw FFT bins instead gives a subtly
// different answer at the band edges.
function bandPower(psd, binHz, loHz, hiHz) {
  let total = 0;
  for (let kHz = loHz; kHz < hiHz; kHz += BIN_HZ) {
    const from = Math.round(kHz / binHz);
    const to = Math.min(psd.length, Math.round((kHz + BIN_HZ) / binHz));
    for (let k = from; k < to; k++) total += psd[k];
  }
  return total;
}

/**
 * Split a recording between the machine band and the voice band.
 * `bandLimited` is true when the sample rate cannot reach the 11 kHz biophony
 * ceiling, in which case the number is real but not comparable with a
 * full-bandwidth reading.
 */
export function ndsi(mono, sampleRate, opts = {}) {
  const spectrum = welchPsd(mono, sampleRate, opts.windowSize || WINDOW);
  if (!spectrum) return EMPTY;
  const { psd, binHz, windows } = spectrum;
  const nyquist = sampleRate / 2;
  const bioTop = Math.min(NDSI_BIOPHONY_HZ[1], Math.floor(nyquist / BIN_HZ) * BIN_HZ);
  const anthrophony = bandPower(psd, binHz, NDSI_ANTHROPHONY_HZ[0], NDSI_ANTHROPHONY_HZ[1]);
  const biophony = bioTop > NDSI_BIOPHONY_HZ[0]
    ? bandPower(psd, binHz, NDSI_BIOPHONY_HZ[0], bioTop) : 0;
  const total = biophony + anthrophony;
  const value = total > 0 ? (biophony - anthrophony) / total : 0;
  return {
    ndsi: Math.max(-1, Math.min(1, value)),
    biophony,
    anthrophony,
    bandLimited: bioTop < NDSI_BIOPHONY_HZ[1],
    windows,
  };
}
