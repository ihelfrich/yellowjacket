// Cyclic modulation analysis: the periodic structure a spectrogram averages away.
//
// A spectrogram answers "what frequencies are present". It cannot answer "what
// is repeating", because it integrates over exactly the time structure that
// carries a symbol clock. Every man-made signal has one: a Morse dot rate, an
// RTTY baud, a syllabic rate in speech, a beat in music, the symbol clock of a
// psychoacoustic watermark. Those live on a second axis — the cyclic frequency
// alpha — and this module computes it.
//
// The estimator here is the MAGNITUDE-based cyclic modulation spectrum: an
// analysis STFT, then a second FFT along time through each frequency bin's own
// envelope. It is not the full Spectral Correlation Density (which correlates
// X(f + a/2) against the conjugate of X(f - a/2) and so keeps carrier phase);
// it costs a small fraction of it and, for audio that a receiver has already
// demodulated to baseband, it captures the envelope phenomena that matter. What
// it cannot see is written down in docs/lab/2026-09-03-cyclic-spectrum.md.
//
// Every bin's envelope is normalised by its own mean before the second FFT, so
// the output is MODULATION DEPTH, not energy: a quiet band modulated 40% reads
// 0.4 exactly as a loud one does. That is what makes bands of wildly different
// level comparable, which is the whole point when the target is a watermark
// hiding tens of dB under programme audio.

import { FFT, hann } from '../fft.js';

export const MIN_ALPHA_HZ = 0.5;

export const DEFAULT_MAX_BINS = 128;
export const DEFAULT_ALPHA_MAX_HZ = 30;
export const MIN_FFT_SIZE = 256;
export const MAX_FFT_SIZE = 8192;

// The analysis window is derived from the cyclic ceiling, not chosen, and the
// constant is measured rather than picked. Two effects pull against each other:
//
//   A window is a low-pass on the envelope. Against a true 40% modulation the
//   depth that survives falls to about half at 1.28 / windowSeconds: 60 Hz for
//   a 21 ms window, 30 Hz for 43 ms, 12.5 Hz for 85 ms. Short windows hear fast
//   clocks.
//
//   A window that is short in TIME is coarse in FREQUENCY, and a carrier that
//   does not sit on a bin centre then leaks into its own envelope and folds to
//   |carrier mod frameRate|, reporting a clock the recording does not have.
//   Swept over 27 carriers from 400 Hz to 4 kHz: a 2048-point window invents a
//   clock for 6 of them, 4096 for none. Wider bin groups barely help (6 -> 4 ->
//   3 at 2048); it is the window that governs.
//
// So the factor is 2.56, twice what sensitivity alone would ask, which buys a
// clean plane. The cost is stated rather than hidden: a window chosen this way
// has its null at 2 x its bin width, which is BELOW the ceiling the caller
// named. The analysis reports `usableAlphaHz` and `nullAlphaHz` and clamps
// itself to the latter, so it never claims to have searched a band it is deaf
// to. Confirmed against the measured transfer: at 48 kHz with an 85 ms window
// the null lands at 23.4 Hz, and a sinusoidal modulation there reads 0.013 of
// a true 0.40. Square keying is still found past it, because its harmonics and
// sidebands reach back down into the passband.
export const WINDOW_ALPHA_PRODUCT = 2.56;
export function fftSizeFor(sampleRate, alphaMaxHz) {
  const want = WINDOW_ALPHA_PRODUCT * sampleRate / Math.max(MIN_ALPHA_HZ, alphaMaxHz);
  let size = MIN_FFT_SIZE;
  while (size * 2 <= want && size < MAX_FFT_SIZE) size *= 2;
  return size;
}
// Below this the "modulation" is just the signal arriving and leaving; a
// window-length ramp is not a symbol clock.
// A bin this far below the loudest one carries nothing worth measuring. The
// gate is not tidiness: modulation depth is a RATIO to the bin's own mean, so
// a near-silent bin divides numeric noise by almost zero and reports a depth
// in the millions. DC is the usual offender. -80 dB relative to the loudest
// band is well below anything audible and far above the numeric floor.
export const MIN_BIN_LEVEL = 1e-4;
// A ratio to a floor is not enough on its own. An unmodulated band's floor
// sits at the numeric noise, so a ripple of 1e-7 divided by it looks
// enormous while being nothing at all. A peak must ALSO be a modulation
// somebody could hear or decode: 0.5% depth is far below any real symbol
// clock and far above arithmetic.
export const MIN_DEPTH = 0.005;
// Calibrated, not chosen. Over a plane of ~130,000 cells of true random noise
// the ratio to a bin's median floor has median 1.00, p99 5.0, p99.9 6.6 and a
// MAXIMUM of 9.3 — so a threshold of 6 sits below the noise maximum and finds
// about a dozen "clocks" in silence. Measured across twelve noise realisations
// at two window lengths: 6 gives 144 false peaks, 9 gives 18, 12 gives none.
// The planted signals clear it by three to six orders of magnitude.
export const DEFAULT_THRESHOLD = 12;
// How many bands carry a clock is reported as an ATTRIBUTE of a detected
// periodicity, at a weaker bar than detection uses, and deliberately not as a
// detector of its own. A separate "many weak bands" detector was built and
// then removed: to catch the planted three-band watermark it had to accept
// three bands at 6x, and measured over eight noise planes that setting invented
// 3.5 clocks each. It could not be made both sensitive enough to matter and
// clean enough to trust, and the profile detector finds the same watermark with
// none. An uncalibrated detector is worse than no detector.
export const SPREAD_THRESHOLD = 6;

// Where a carrier's leakage folds to, when it folds at all. Predicting it from
// a REPORTED peak is not possible here — bins are grouped, so a group centre is
// hundreds of hertz away from the carrier and the fold is a modulo of it — but
// the relation is what sets WINDOW_ALPHA_PRODUCT above, and it is exported so a
// caller checking a specific known carrier can ask.
export function carrierAliasHz(carrierHz, frameRate) {
  if (!(frameRate > 0)) return 0;
  const folded = Math.abs(Number(carrierHz)) % frameRate;
  return Math.min(folded, frameRate - folded);
}

function largestPow2AtMost(n) {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

/**
 * Envelope of each frequency bin over time: an analysis STFT whose hop is set
 * by the cyclic frequency you want to reach, not by what looks good on screen.
 *
 * `frameRate` (1 / hop) must be at least twice `alphaMaxHz`, so the hop is
 * derived from it rather than guessed. Adjacent bins are averaged in groups to
 * hold `maxBins`, which both bounds memory and lowers the variance of the
 * estimate.
 *
 * Returns {env, frames, bins, frameRate, binHz, group, startSec} where `env` is
 * frames x bins, row-major, holding linear magnitude.
 */
export function envelopeMatrix({
  mono, sampleRate, startSec = 0, endSec = null,
  fftSize = null, alphaMaxHz = DEFAULT_ALPHA_MAX_HZ, maxBins = DEFAULT_MAX_BINS,
}) {
  const rate = Number(sampleRate);
  if (!mono || !mono.length || !(rate > 0)) return null;
  fftSize = fftSize || fftSizeFor(rate, alphaMaxHz);
  const from = Math.max(0, Math.floor(Number(startSec) * rate));
  const to = Math.min(mono.length, endSec == null ? mono.length : Math.ceil(Number(endSec) * rate));
  if (to - from < fftSize * 2) return null;

  // Hop from the cyclic ceiling: frameRate = rate / hop >= 2 * alphaMax.
  const hop = Math.max(1, Math.floor(rate / (2 * Math.max(MIN_ALPHA_HZ, alphaMaxHz))));
  const frameRate = rate / hop;
  const available = Math.floor((to - from - fftSize) / hop) + 1;
  const frames = largestPow2AtMost(available);          // the time FFT wants a power of two
  if (frames < 16) return null;

  const half = fftSize >> 1;
  const group = Math.max(1, Math.ceil(half / maxBins));
  const bins = Math.ceil(half / group);
  const fft = new FFT(fftSize);
  const win = hann(fftSize);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const env = new Float32Array(frames * bins);

  for (let t = 0; t < frames; t++) {
    const at = from + t * hop;
    for (let i = 0; i < fftSize; i++) re[i] = mono[at + i] * win[i];
    im.fill(0);
    fft.forward(re, im);
    const row = t * bins;
    for (let b = 0; b < bins; b++) {
      const lo = b * group;
      const hi = Math.min(half, lo + group);
      // Band amplitude as the root of summed POWER, not the mean of
      // magnitudes. A tone that does not sit on a bin centre leaks into its
      // neighbours in a pattern that rotates with each frame's phase, so a
      // single magnitude ripples even when nothing is modulating. Summed
      // power is that leakage put back together; the square root keeps the
      // result an amplitude, so a modulation of depth m still reads m.
      let power = 0;
      for (let k = lo; k < hi; k++) power += re[k] * re[k] + im[k] * im[k];
      env[row + b] = Math.sqrt(power);
    }
  }
  // What this window can actually reach, which is NOT what the caller asked
  // for. The magnitude of a bin is its subband lowpassed BY THE ANALYSIS
  // WINDOW, so a modulation at alpha is transferred with the window's own
  // response: for Hann, half amplitude at one bin width and a hard null at
  // two. The hop only decides whether what survives is aliased. Asking for a
  // ceiling above the null does not reach it, so the reach is reported and
  // the analysis is clamped to it rather than searching a dead band.
  const df = rate / fftSize;
  return {
    env, frames, bins, frameRate, group, fftSize,
    binWidthHz: df,
    usableAlphaHz: df,        // about half the depth survives here
    nullAlphaHz: 2 * df,      // and none survives here
    binHz: rate / fftSize * group,
    startSec: from / rate,
    seconds: (frames * hop) / rate,
  };
}

/**
 * The second FFT: through each bin's envelope, along time.
 *
 * Each envelope is divided by its own mean and has that mean removed, so a
 * sinusoidal amplitude modulation of depth m reads m at its own alpha whatever
 * the band's absolute level. A Hann window is applied and the transform scaled
 * by 2/sum(w), which makes that reading exact rather than proportional.
 *
 * Returns {mod, alphaBins, bins, alphaHz(i), maxAlphaHz} with `mod` alphaBins x
 * bins, row-major, in modulation depth (1.0 = 100% modulation).
 */
export function modulationSpectrum(envelope, { alphaMaxHz = DEFAULT_ALPHA_MAX_HZ } = {}) {
  if (!envelope || !envelope.frames || !envelope.bins) return null;
  const { env, frames, bins, frameRate } = envelope;
  const fft = new FFT(frames);
  const win = hann(frames);
  let wsum = 0;
  for (let i = 0; i < frames; i++) wsum += win[i];
  const scale = 2 / (wsum || 1);

  const alphaStep = frameRate / frames;
  // Clamped by the window's null as well as by aliasing: past 2 x the bin
  // width the estimator is deaf, and reporting peaks from there would be
  // reporting noise from a band it cannot hear.
  const ceiling = Math.min(
    frameRate / 2,
    envelope.nullAlphaHz || Infinity,
    Math.max(MIN_ALPHA_HZ, alphaMaxHz),
  );
  const alphaBins = Math.max(1, Math.min(frames >> 1, Math.ceil(ceiling / alphaStep) + 1));
  const mod = new Float32Array(alphaBins * bins);
  const re = new Float32Array(frames);
  const im = new Float32Array(frames);

  // Level first, so silence is excluded rather than normalised into nonsense.
  const means = new Float32Array(bins);
  let loudest = 0;
  for (let b = 0; b < bins; b++) {
    let mean = 0;
    for (let t = 0; t < frames; t++) mean += env[t * bins + b];
    means[b] = mean / frames;
    if (means[b] > loudest) loudest = means[b];
  }
  const gate = loudest * MIN_BIN_LEVEL;
  const active = new Uint8Array(bins);

  for (let b = 0; b < bins; b++) {
    const mean = means[b];
    if (!(mean > 0) || mean < gate) {        // silence has no modulation depth
      for (let a = 0; a < alphaBins; a++) mod[a * bins + b] = 0;
      continue;
    }
    active[b] = 1;
    for (let t = 0; t < frames; t++) re[t] = ((env[t * bins + b] / mean) - 1) * win[t];
    im.fill(0);
    fft.forward(re, im);
    for (let a = 0; a < alphaBins; a++) {
      mod[a * bins + b] = Math.hypot(re[a], im[a]) * scale;
    }
  }
  return {
    mod, alphaBins, bins, means, active,
    activeBins: active.reduce((n, v) => n + v, 0),
    alphaStep,
    requestedAlphaHz: alphaMaxHz,
    usableAlphaHz: envelope.usableAlphaHz,
    nullAlphaHz: envelope.nullAlphaHz,
    reachedCeiling: alphaMaxHz > (envelope.nullAlphaHz || Infinity),
    maxAlphaHz: (alphaBins - 1) * alphaStep,
    alphaHz: (i) => i * alphaStep,
    binHz: envelope.binHz,
  };
}

/**
 * A robust per-bin noise floor: the median modulation depth across alpha.
 * A periodogram of noise is exponentially distributed, so its mean is pulled
 * about by its own tail; the median is not, which is what makes a threshold in
 * multiples of it mean the same thing in a quiet band and a busy one.
 */
export function binFloors(spectrum, { skipBelowHz = MIN_ALPHA_HZ } = {}) {
  const { mod, alphaBins, bins, alphaStep, active } = spectrum;
  const first = Math.max(1, Math.ceil(skipBelowHz / alphaStep));
  const floors = new Float32Array(bins);
  const scratch = new Float32Array(Math.max(1, alphaBins - first));
  for (let b = 0; b < bins; b++) {
    if (active && !active[b]) { floors[b] = 0; continue; }
    let n = 0;
    for (let a = first; a < alphaBins; a++) scratch[n++] = mod[a * bins + b];
    if (!n) { floors[b] = 0; continue; }
    const slice = scratch.subarray(0, n).slice().sort();
    floors[b] = slice[n >> 1] || 0;
  }
  return floors;
}

/**
 * How far above its own floor each cell stands, and two reductions over f:
 *  - `profile`: the strongest bin at each alpha. Peaks are periodicities present.
 *  - `spread`:  how many bins stand above the threshold at that alpha.
 *
 * `spread` is the one that finds a watermark. A signal that hides by spreading
 * itself thinly across several separated bands is weak everywhere and so never
 * wins `profile`, but it is the only thing that puts the SAME clock in many
 * bands at once.
 */
export function alphaProfile(spectrum, floors, {
  threshold = DEFAULT_THRESHOLD, spreadThreshold = SPREAD_THRESHOLD, minDepth = MIN_DEPTH,
} = {}) {
  const { mod, alphaBins, bins } = spectrum;
  const profile = new Float32Array(alphaBins);
  const spread = new Uint16Array(alphaBins);
  const peakBin = new Int32Array(alphaBins);
  for (let a = 0; a < alphaBins; a++) {
    let best = 0;
    let bestBin = -1;
    let count = 0;
    for (let b = 0; b < bins; b++) {
      const floor = floors[b];
      if (!(floor > 0)) continue;
      const depth = mod[a * bins + b];
      if (depth < minDepth) continue;        // not a clock, whatever the ratio
      const ratio = depth / floor;
      if (ratio > best) { best = ratio; bestBin = b; }
      if (ratio >= spreadThreshold) count++;
    }
    profile[a] = best;
    spread[a] = count;
    peakBin[a] = bestBin;
  }
  return { profile, spread, peakBin };
}

/**
 * Local maxima in a reduction over alpha, as periodicities worth naming.
 * `minSeparationHz` keeps one broad ridge from being reported many times, and
 * harmonics are marked rather than dropped: a square-wave keying at 12.5 Hz
 * genuinely has energy at 25 and 37.5, and that pattern is itself the evidence
 * that the modulation is switching rather than sinusoidal.
 */
export function findPeriodicities(values, spectrum, {
  threshold = DEFAULT_THRESHOLD, minSeparationHz = 0.75, limit = 12, skipBelowHz = MIN_ALPHA_HZ,
} = {}) {
  const { alphaStep, alphaBins } = spectrum;
  const first = Math.max(1, Math.ceil(skipBelowHz / alphaStep));
  const found = [];
  for (let a = first + 1; a < alphaBins - 1; a++) {
    const v = values[a];
    if (!(v >= threshold)) continue;
    // >= not >, because `spread` is an integer count and a real shared clock
    // routinely sits on a plateau. A strict maximum silently rejected them.
    if (v < values[a - 1] || v < values[a + 1]) continue;
    found.push({ alphaHz: a * alphaStep, strength: v, index: a });
  }
  found.sort((x, y) => y.strength - x.strength);
  const kept = [];
  for (const cand of found) {
    if (kept.some((k) => Math.abs(k.alphaHz - cand.alphaHz) < minSeparationHz)) continue;
    kept.push(cand);
    if (kept.length >= limit) break;
  }
  const fundamental = kept.length ? Math.min(...kept.map((k) => k.alphaHz)) : 0;
  for (const k of kept) {
    const ratio = fundamental > 0 ? k.alphaHz / fundamental : 1;
    const near = Math.round(ratio);
    k.harmonicOf = near >= 2 && Math.abs(ratio - near) < 0.06 ? fundamental : null;
  }
  return kept.sort((x, y) => x.alphaHz - y.alphaHz);
}

/**
 * One call: envelope, modulation spectrum, floors, reductions, periodicities.
 * Returns null when the window is too short to say anything.
 */
export function analyseCyclic(opts) {
  const envelope = envelopeMatrix(opts);
  if (!envelope) return null;
  const spectrum = modulationSpectrum(envelope, opts);
  if (!spectrum) return null;
  const floors = binFloors(spectrum);
  const { profile, spread, peakBin } = alphaProfile(spectrum, floors, opts);
  const withBands = (peaks) => {
    for (const peak of peaks) peak.bands = spread[peak.index] || 0;
    return peaks;
  };
  return {
    envelope, spectrum, floors, profile, spread, peakBin,
    peaks: withBands(findPeriodicities(profile, spectrum, opts)),
    // The spread reduction gets its own peak list, with a threshold in BINS
    // rather than in multiples of a floor: this is the watermark detector.
    // No second peak list: `bands` on each peak above says how many carried it.
  };
}
