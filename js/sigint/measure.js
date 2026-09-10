// The numbers a signals analyst writes down, each with what it is and how far
// it can be trusted.
//
// The material this serves is public shortwave — numbers stations, HF nets,
// time and navigation beacons, over-the-horizon radar. Every measurement here
// is of a broadcast that anyone with a receiver hears; nothing in this file
// intercepts anything or defeats any protection. It measures.
//
// The governing rule is that a confidently wrong number is worse than no
// number. Every quantity returned carries a unit, an uncertainty and the method
// that produced it, and a quantity the data cannot support comes back with
// `value: null` and a `reason` rather than a plausible default. Where an
// estimator has a known failure mode — the 99% bandwidth on a carrier-dominant
// signal, a drift fit across an FSK track, a symbol clock read off a coloured
// pedestal, a bimodality test that fires on unimodal data — the code detects the
// mode and says so in the returned object.

import { FFT, hann, nextPow2 } from '../fft.js';
import { firLowpass, instantaneousAmp, instantaneousFreq } from '../dsp/analytic.js';

// A low percentile of each bin's frames, not a mean and not a median.
//
// The estimator has to exclude the very signal it is measuring, and on this
// material the signal is present for most of the recording: a Morse hand keys
// near 1:1 but an idling teleprinter or a numbers station's tone is up for the
// whole minute. A mean is dragged up by every frame the signal occupies. A
// median survives only while the duty cycle is under 50%, which an idling
// teleprinter is not.
//
// The 20th percentile survives any duty cycle up to 80%. It costs precision:
// for the exponentially distributed periodogram of Gaussian noise the sample
// quantile has relative standard deviation sqrt(p / (F(1-p))), which at p=0.2
// is 0.5/sqrt(F) — 0.22 dB with 100 independent frames, 0.5 dB with 20. That
// number is computed and returned rather than assumed.
export const FLOOR_PERCENTILE = 0.20;

// A single periodogram bin of Gaussian noise is exponentially distributed, so
// its p-quantile sits at -ln(1-p) times its mean. Dividing by that converts the
// quantile back to the mean power the noise actually has. Exact for Gaussian
// noise; on real HF it overestimates nothing and underestimates the floor only
// where the band is full of other people's signals.
export const floorDebias = (p) => -Math.log(1 - p);

// A percentile over TIME cannot see a signal that never goes away. An
// unmodulated carrier is present in every frame, so its bin's 20th percentile
// is the carrier, the excess over floor is zero, and the SNR of a 40 dB carrier
// reads 0 dB. Measured directly: a 1 kHz tone at amplitude 0.5 in noise of
// sigma 0.01 came back with a peak only 2.3 dB above its own "floor".
//
// So the floor is estimated twice and the smaller is taken. The second estimate
// is a running median ACROSS FREQUENCY of the first, which is blind to any
// signal narrower than half the window and so recovers the floor underneath a
// continuous carrier. Between them they cover both failure directions: the
// temporal quantile handles a keyed signal that sits in one bin forever, the
// spectral median handles a continuous one. Taking the minimum of two noisy
// estimators biases the result low, and that bias is measured, not assumed.
export const FLOOR_WINDOW_HZ = 600;
// The minimum of two estimators is biased, and the bias was measured rather
// than modelled: 30 noise realisations at each of six durations from 2 to 16
// seconds (15 to 125 disjoint frames). Averaged over bins the minimum reads
// 0.93 to 0.97 of the true noise power (-0.31 to -0.13 dB); taken as a median
// over bins it reads 0.99 to 1.07 (-0.06 to +0.29 dB). It is not monotone in
// the frame count, because it depends both on the temporal quantile's variance
// and on how good the spectral median is, and a linear fit in either was worse
// than no fit at all — an earlier version divided by a constant 0.934 fitted to
// the mean, which pushed the REPORTED median 0.3 dB the other way.
//
// So it is not corrected. It is carried as a 0.3 dB systematic in the floor's
// uncertainty, which covers the whole measured envelope, and the direction
// depends on which summary you take. Re-derive with `floorIsUnbiasedOnNoise`.
export const FLOOR_SYSTEMATIC_DB = 0.3;

// ITU-R SM.328 defines the x-dB bandwidth with x = 26 dB for most services.
export const XDB_DOWN = 26;

// Quadratic interpolation through the peak bin and its two neighbours, on the
// LOG magnitude. Swept over 64 sub-bin offsets with a Hann window at N=1024:
// worst error 0.016 bins, mean 0.010. The same sweep interpolating on linear
// magnitude is 3.3x worse (worst 0.053 bins), which is why this works in dB.
export const PARABOLIC_BIAS_BINS = 0.016;

// Peak-to-LOCAL-floor ratio in the transition spectrum below which a symbol
// rate is not asserted. The floor has to be local: the modulus of a first
// difference has a strongly coloured spectrum, and against a floor taken as the
// median of the whole search span a pure tone in noise produced a confident
// "6.1 baud" at 195x. Against a local floor the same input reads a few x.
// Calibrated on noise: over 40 noise-only realisations of three seconds each,
// the maximum this ratio reached across all three channels was 4.33. 8 leaves
// most of a factor of two in hand and no synthesised keyed signal came close to
// failing it. See `symbolRateRefusesOnNoise`.
export const SYMBOL_MIN_RATIO = 8;

// The local floor is a median over neighbouring bins, and a median estimates
// the background only where the background is FLAT across the window. At the
// two edges of the searched span the old window was one-sided — at the lowest
// searched bin it took its median entirely from bins ABOVE the peak — and the
// spectrum of |first difference| of a noise envelope is not flat there. It is a
// falling pedestal.
//
// Measured, on three seconds of gated noise (test/noise-colours.mjs `bursty`,
// seed 4008, envelope channel): the transition spectrum reads 57.2 dB at the
// lowest searched bin, 51.8 at bin 20, 42.6 at bin 40, 33.4 at bin 130 and
// 26.8 by bin 1500. The one-sided median over bins 17..145 returned 36.1 dB —
// the pedestal's value somewhere near bin 80 — so the pedestal's own edge stood
// 21 dB above "its" floor and was reported as 4.15 Bd. Across 150 seeds of each
// of the five colours this happened on 49 of 150 gated-noise inputs, and every
// single false accept in all 750 sat within 8 bins of the bottom of the span.
//
// So the window is symmetric about the bin under test, and bins whose window
// cannot be made symmetric are not searched at all. For a background that is
// log-linear in bin number — which a 1/f pedestal is — the median of a
// symmetric set of cells is exactly the background at the centre, whatever the
// slope. That is the property the old window did not have.
//
// The guard is the line's own half-mainlobe: a Hann-windowed sinusoid is four
// bins wide null-to-null, so three bins either side keeps a real line out of
// its own floor estimate. See `localFloorIsSymmetricAboutTheBinUnderTest`.
export const SYMBOL_FLOOR_GUARD_BINS = 3;
// Cells per side. Nine each side is 18 in the floor's median at the very bottom
// of the span against 252 in mid-span; the relative SD of a median of 18
// exponential samples is about 17%, so the floor there is roughly +/- 1.4 dB
// noisier. That cost is paid where the alternative was a 21 dB bias.
export const SYMBOL_FLOOR_MIN_CELLS = 8;
// Bins 0-2 hold the residual of the mean removal and the Hann window's own
// leakage of it, so the floor's support starts at bin 3.
export const SYMBOL_FLOOR_LOW_BIN = 3;
// The full width of the floor's window, in bins. The magnitudes are computed
// half of this either side of the searched span so that the bins at its two
// edges have a window that can be made symmetric.
export const SYMBOL_FLOOR_WINDOW_BINS = 257;

// Is the periodicity a clock, or is it the envelope of impulsive noise?
//
// A crash train has genuine periodicity — atmospheric noise on the low bands is
// a Poisson series of decaying rings, and its envelope has structure a
// symbol-rate estimator is built to find. The two are separable in the
// waveform, before any of this analysis runs, because a symbol clock keys a
// carrier and a crash does not: the fourth moment of the waveform is 3 for
// anything Gaussian and enormous for a series of spikes.
//
// Measured with `describe()` from test/noise-colours.mjs, at 8 kHz over six
// seconds, seed 11: white 3.0, pink 3.0, faded 4.6, bursty 6.1, impulsive 34.1.
// Adding an emission pulls the figure DOWN — a sine on its own is 1.5 — so this
// fires exactly when the crashes dominate what is being measured, which is when
// the measurement is least trustworthy. A bar of 10 sits above every colour in
// that set except impulsive and a factor of 3.4 below impulsive itself.
//
// It is a WARNING and a cap on confidence, not a refusal. Measured cost of
// refusing instead: a 25 Bd on-off keyed carrier under crashes at amplitude 0.5
// is found in 11 of 20 seeds, and all 11 would have been thrown away. A real
// emission under atmospheric noise is a real emission. See
// `impulsiveMaterialIsFlaggedAndCapped`.
export const IMPULSIVE_KURTOSIS = 10;

// The gate for calling an instantaneous-frequency histogram bimodal is the
// depth of the valley between its two modes, NOT Ashman's D.
//
// D > 2 is the textbook bar for the separation of two FITTED mixture
// components. It is not a test that raw data is bimodal at all, and used as one
// it fires constantly: split a unimodal Gaussian at its own mean and the two
// halves have D = 2.66 by construction (measured here: 2.65 over 40 draws), a
// unimodal uniform gives 3.46. Every unimodal case in the smoke test cleared a
// D >= 2 gate. D is still reported, because it is what a reader expects to see,
// but the decision is the valley.
export const VALLEY_MIN_DEPTH = 0.5;

// The FSK shift comes back LOW, always, and by an amount that is NOT constant.
//
// It used to be carried as a flat 1.5% of the shift. That is wrong in the one
// direction that matters: it is too small exactly where the measurement is
// least trustworthy. Measured against 45.45 Bd / 170 Hz truth, 6 seeds a point,
// the error runs -0.13% where the two modes are sharp and -17.0% where they are
// not, and the flat 1.5% stopped covering the truth below about 26 dB of
// reported band SNR — after which it kept claiming 1.5% all the way down.
//
// The predictor is not the band SNR. Over a 1,440-point grid (shift 85, 170,
// 425, 850 Hz; rate 25, 45.45, 75, 100, 200, 300 Bd; twelve noise levels; five
// seeds each) the reported band SNR saturates near 28 dB, because the "floor"
// under a strong emission is that emission's own splatter, and at a reported
// 22 dB the bias ranged from -0.6% to -7.4%. What does predict it is the
// measurement's OWN geometry: w, the wider mode's interquartile sigma divided
// by the measured shift. Over that grid the bias never exceeded 2.0 x w, and
// the envelope below covers all 1,048 measurable points with 1.48x in hand.
//
// Two mechanisms, so two terms. The transition ramp is there at zero noise:
// band-limiting turns each frequency step into a short ramp and the samples on
// it drag both modes inward, worst where the modulation index is lowest —
// measured 3.03% at 170 Hz shift and 300 Bd with no noise added at all, which
// is what FSK_TRANSITION_FRACTION covers. Noise adds the second and larger
// term: the instantaneous frequency of a tone in noise is heavy-tailed, the
// split at the valley truncates each mode on its inner side, and the median of
// a truncated heavy tail moves inward by more the wider the mode is.
//
// Nothing is corrected. A correction fitted to synthesised CPFSK would be
// applied to material that is not synthesised CPFSK, and a wrong correction
// produces a confident wrong number — the failure this file exists to prevent.
// The bias is carried as an uncertainty that covers the measured worst case,
// its direction is stated, and above FSK_MAX_MODE_WIDTH the shift is refused
// outright rather than quoted with an envelope no grid has demonstrated.
// Re-derive all three with `fskShiftUncertaintyCoversItsOwnBias`.
export const FSK_TRANSITION_FRACTION = 0.045;
export const FSK_NOISE_BIAS_SLOPE = 1.5;
// At this width the systematic is already 37.5% of the shift. 95% of the
// measurable points on the calibration grid sit below it; the ones above have a
// mean band SNR of 14.8 dB and a bias reaching -26%.
export const FSK_MAX_MODE_WIDTH = 0.25;
export const ASHMAN_REFERENCE_UNIMODAL = 2.66;

// The bar for calling a region occupied at all, in dB of peak bin over that
// bin's own noise floor. Everything derived from the band — the symbol rate,
// the FSK shift — is withheld below it, because a number derived from a region
// the module has just called empty is a description of noise wearing the
// clothes of a measurement.
export const DETECTION_MIN_SNR_DB = 10;

// A noise floor measured inside a band the emission fills is not a noise
// floor; it is the emission. Both halves of the floor estimator fail together
// there — the temporal percentile because the duty cycle is high everywhere in
// the band, the spectral median because most of its window is signal — so
// taking the smaller of two wrong numbers does not help.
//
// The condition is detectable whenever the analysed band is narrower than the
// recording, because the rest of the spectrum is a reference: compare the 10th
// percentile ACROSS BINS of the in-band floor with the same percentile across
// every bin. Like for like, so on clean noise it is 0.00 dB by construction.
// Measured over 27 tight-band cases (FSK at 45.45 and 100 Bd, OOK at 30, 50
// and 90 Bd, a carrier and an AM carrier, at three noise levels), the floor's
// actual error never exceeded 1.55 times that excess, so twice it is carried
// as an uncertainty with 1.29x in hand at the worst point.
//
// This does NOT cover a band the emission fills with no quiet spectrum left to
// compare against — measured 3.7 dB of floor error on a 50 Bd OOK analysed
// over the whole 4 kHz band, and 9.7 dB on a 1500 Hz-wide FSK, both against a
// stated 0.43 dB. `bandFloorExcessDb` reads 0.00 there because there is no
// reference, and the number is wrong with a narrow bar. That is a known
// defect of this estimator, not a solved one.
export const FLOOR_EXCESS_COVERAGE = 2;

/** A measured number, with the two things that make it usable by someone else. */
function q(value, unit, uncertainty, method, extra) {
  return Object.assign({ value, unit, uncertainty, method }, extra || null);
}

/** A number the data cannot support. Never a default; always a reason. */
function unmeasured(unit, reason, extra) {
  return Object.assign({ value: null, unit, uncertainty: null, method: null, reason }, extra || null);
}

function quantileSorted(sorted, p) {
  const n = sorted.length;
  if (!n) return NaN;
  if (n === 1) return sorted[0];
  const pos = p * (n - 1);
  const i = Math.floor(pos);
  const frac = pos - i;
  return i + 1 < n ? sorted[i] * (1 - frac) + sorted[i + 1] * frac : sorted[n - 1];
}

function median(values) {
  const s = Float64Array.from(values).sort();
  return quantileSorted(s, 0.5);
}

/**
 * Short-time power spectra over a region, kept in RAW |X|^2 so that every ratio
 * taken downstream is scale-free, plus the window sums everything else derives
 * from.
 *
 * Frames overlap 50%, which the drift track needs. The noise floor does not use
 * every frame: adjacent 50%-overlapped Hann frames share half their samples, so
 * their periodograms are correlated and a quantile over them would be tighter
 * than its own sampling theory says. The floor uses the even-indexed frames
 * only, which are disjoint, and reports how many that was.
 */
export function spectrogram(mono, sampleRate, { startSec = 0, endSec = null, fftSize = null } = {}) {
  const rate = Number(sampleRate);
  if (!mono || !mono.length || !(rate > 0)) return null;
  // ~8 Hz bins: fine enough to resolve a 170 Hz teleprinter shift into 20 bins,
  // short enough that a 60 ms Morse dot is not spread over many frames.
  const size = fftSize || Math.min(8192, Math.max(256, nextPow2(Math.round(rate / 8))));
  const from = Math.max(0, Math.floor(Number(startSec) * rate));
  const to = Math.min(mono.length, endSec == null ? mono.length : Math.ceil(Number(endSec) * rate));
  const hop = size >> 1;
  const frames = Math.floor((to - from - size) / hop) + 1;
  if (frames < 4) return null;

  const bins = (size >> 1) + 1;
  const fft = new FFT(size, { precision: 'f64' });
  const win = hann(size);
  let W1 = 0, W2 = 0;
  for (let i = 0; i < size; i++) { W1 += win[i]; W2 += win[i] * win[i]; }

  const power = new Float64Array(frames * bins);
  const times = new Float64Array(frames);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let t = 0; t < frames; t++) {
    const at = from + t * hop;
    for (let i = 0; i < size; i++) re[i] = mono[at + i] * win[i];
    im.fill(0);
    fft.forward(re, im);
    const row = t * bins;
    for (let k = 0; k < bins; k++) power[row + k] = re[k] * re[k] + im[k] * im[k];
    times[t] = (at + size / 2) / rate;
  }
  return {
    power, times, frames, bins, fftSize: size, hop, rate,
    from, to,
    binHz: rate / size,
    // Equivalent noise bandwidth of one bin, in hertz: rate * W2 / W1^2.
    // 1.0 bins for a rectangular window, 1.5 for Hann. This is the divisor that
    // turns a per-bin power into a power density.
    enbwHz: rate * W2 / (W1 * W1),
    // A tone of amplitude A at a bin centre reads A^2/2 — its own mean power —
    // once multiplied by this. A full-scale sine therefore reads 0.5.
    ampScale: 2 / (W1 * W1),
    W1, W2,
    startSec: from / rate,
    seconds: (to - from) / rate,
  };
}

/** Per-bin p-quantile over the disjoint frames, debiased to the noise mean. */
export function temporalFloor(spec, p) {
  const { power, frames, bins } = spec;
  const disjoint = [];
  for (let t = 0; t < frames; t += 2) disjoint.push(t);
  const out = new Float64Array(bins);
  const scratch = new Float64Array(disjoint.length);
  const debias = floorDebias(p);
  for (let k = 0; k < bins; k++) {
    for (let i = 0; i < disjoint.length; i++) scratch[i] = power[disjoint[i] * bins + k];
    scratch.sort();
    out[k] = quantileSorted(scratch, p) / debias;
  }
  return { floor: out, frameCount: disjoint.length };
}

/** Running median across frequency: blind to anything narrower than the window. */
export function spectralFloor(values, windowBins) {
  const n = values.length;
  const half = Math.max(1, Math.floor(windowBins / 2));
  const out = new Float64Array(n);
  const scratch = new Float64Array(2 * half + 1);
  for (let k = 0; k < n; k++) {
    const lo = Math.max(0, k - half);
    const hi = Math.min(n - 1, k + half);
    const m = hi - lo + 1;
    for (let i = 0; i < m; i++) scratch[i] = values[lo + i];
    const view = scratch.subarray(0, m);
    view.sort();
    out[k] = quantileSorted(view, 0.5);
  }
  return out;
}

/**
 * Per-bin mean (signal plus noise) and per-bin noise floor, with the floor's
 * own sampling uncertainty in dB.
 */
export function binStats(spec, { floorPercentile = FLOOR_PERCENTILE, floorWindowHz = FLOOR_WINDOW_HZ } = {}) {
  const { power, frames, bins, binHz } = spec;
  const p = Math.min(0.45, Math.max(0.02, Number(floorPercentile) || FLOOR_PERCENTILE));
  const mean = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    let sum = 0;
    for (let t = 0; t < frames; t++) sum += power[t * bins + k];
    mean[k] = sum / frames;
  }
  const temporal = temporalFloor(spec, p);
  const windowBins = Math.max(5, Math.round(floorWindowHz / binHz) | 1);
  const spectral = spectralFloor(temporal.floor, windowBins);
  const floor = new Float64Array(bins);
  for (let k = 0; k < bins; k++) floor[k] = Math.min(temporal.floor[k], spectral[k]);

  const relSd = Math.sqrt(p / (temporal.frameCount * (1 - p)));
  return {
    mean, floor,
    floorTemporal: temporal.floor,
    floorSpectral: spectral,
    percentile: p, floorFrames: temporal.frameCount,
    windowBins, windowHz: windowBins * binHz,
    relSd,
    floorSdDb: Math.hypot(10 * Math.log10(1 + relSd), FLOOR_SYSTEMATIC_DB),
  };
}

/** Sub-bin peak position by quadratic interpolation on the log magnitude. */
function parabolic(getDb, k, loIdx, hiIdx) {
  if (k <= loIdx || k >= hiIdx) return 0;
  const a = getDb(k - 1), b = getDb(k), c = getDb(k + 1);
  const den = a - 2 * b + c;
  if (!(Math.abs(den) > 1e-12)) return 0;
  const d = 0.5 * (a - c) / den;
  return Math.abs(d) <= 1 ? d : 0;
}

function bandIndices(spec, lowHz, highHz) {
  const { binHz, bins } = spec;
  // Bins 0 and 1 hold the DC offset and its Hann leakage, which on a recording
  // made through any AC-coupled chain is an artefact and not a signal.
  const lo = Math.max(2, Math.ceil((lowHz == null ? 0 : lowHz) / binHz));
  const hi = Math.min(bins - 2, Math.floor((highHz == null ? spec.rate / 2 : highHz) / binHz));
  return { lo, hi };
}

/**
 * The two bandwidth definitions, both computed, with a verdict on which one to
 * believe for THIS signal.
 *
 * The x-dB definition (ITU-R SM.328, x = 26) is primary because the 99% power
 * definition collapses on carrier-dominant emissions, which is most of this
 * material: an unmodulated or lightly modulated AM carrier can hold well over
 * 99% of the in-band power in a single bin, so the 0.5% and 99.5% crossings
 * both land on that bin and the answer comes back near zero. `carrierFraction`
 * is the direct evidence for that verdict.
 *
 * The edges are the OUTERMOST bins at which the level is still within x dB of
 * the peak, which is what ITU-R SM.328 says and what an FSK emission requires:
 * walking outward from the peak and stopping at the first crossing lands in the
 * valley between the mark and space tones and reports a quarter of the truth.
 * The contiguous skirt is returned alongside, and the two differing is itself
 * reported as `splitEmission`.
 *
 * The x-dB definition has its own failure mode: the -26 dB point cannot be
 * found if the peak is less than 26 dB above the noise. When that happens
 * `dbDown` is reduced to what the SNR can support and `limitedByNoise` is set.
 */
export function bandwidths(spec, stats, { lo, hi }, { dbDown = XDB_DOWN, folds = 4 } = {}) {
  const { binHz } = spec;
  const { mean, floor } = stats;
  const excess = new Float64Array(hi - lo + 1);
  for (let k = lo; k <= hi; k++) excess[k - lo] = mean[k] - floor[k];

  let peak = 0;
  for (let i = 1; i < excess.length; i++) if (excess[i] > excess[peak]) peak = i;
  const peakExcess = excess[peak];
  const peakFloor = floor[lo + peak];
  if (!(peakExcess > 0)) {
    return { failed: 'no bin in the band rises above its own noise floor' };
  }
  const peakBinSnrDb = 10 * Math.log10(peakExcess / Math.max(peakFloor, 1e-300));

  // What the SNR can actually support. 3 dB of headroom over the floor is the
  // least at which a crossing is a crossing and not a coin toss.
  const affordable = peakBinSnrDb - 3;
  const usedDown = Math.min(dbDown, Math.max(3, affordable));
  const limitedByNoise = usedDown < dbDown - 1e-9;
  const level = peakExcess * Math.pow(10, -usedDown / 10);

  // Outermost bins still at or above the level, then a sub-bin crossing
  // interpolated in dB, which is where a filter skirt is straight.
  let outerLo = peak, outerHi = peak;
  for (let i = 0; i < excess.length; i++) {
    if (excess[i] < level) continue;
    if (i < outerLo) outerLo = i;
    if (i > outerHi) outerHi = i;
  }
  let contigLo = peak, contigHi = peak;
  while (contigLo - 1 >= 0 && excess[contigLo - 1] >= level) contigLo--;
  while (contigHi + 1 < excess.length && excess[contigHi + 1] >= level) contigHi++;

  const refine = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= excess.length) return { at: i, clipped: true };
    const dbIn = 10 * Math.log10(Math.max(excess[i], 1e-300));
    const dbOut = 10 * Math.log10(Math.max(excess[j], 1e-300));
    const dbLevel = 10 * Math.log10(level);
    const frac = dbIn === dbOut ? 0 : (dbIn - dbLevel) / (dbIn - dbOut);
    return { at: i + dir * Math.min(1, Math.max(0, frac)), clipped: false };
  };
  const left = refine(outerLo, -1);
  const right = refine(outerHi, 1);
  const xLowHz = (lo + left.at) * binHz;
  const xHighHz = (lo + right.at) * binHz;
  const splitEmission = outerLo < contigLo - 1 || outerHi > contigHi + 1;

  // 99% power, on the un-clamped excess. Clamping the negative bins at zero
  // would bias the total upward and hide exactly the random walk being asked
  // about here, so they are left in.
  const occupied = (col) => {
    let total = 0;
    for (let i = 0; i < col.length; i++) total += col[i];
    if (!(total > 0)) return null;
    const walk = (target) => {
      let acc = 0;
      for (let i = 0; i < col.length; i++) {
        const next = acc + col[i];
        if (next >= target) {
          const frac = col[i] === 0 ? 0 : (target - acc) / col[i];
          return i + Math.min(1, Math.max(0, frac));
        }
        acc = next;
      }
      return col.length - 1;
    };
    const a = walk(0.005 * total);
    const b = walk(0.995 * total);
    return { lowHz: (lo + a) * binHz, highHz: (lo + b) * binHz, width: (b - a) * binHz };
  };
  const occ = occupied(excess);

  // How unstable both answers are, measured rather than modelled: split the
  // frames into K interleaved folds (interleaved so a drifting signal does not
  // separate the folds by frequency), recompute on each, and take the scatter.
  // A fold holds 1/K of the frames, so its own spectrum is noisier by sqrt(K)
  // and the scatter across folds overstates the full-data uncertainty by the
  // same factor — hence the division inside `scatter`.
  const widthsOver = (keep) => {
    const col = new Float64Array(excess.length);
    let n = 0;
    for (let t = 0; t < spec.frames; t++) {
      if (!keep(t)) continue;
      n++;
      for (let k = lo; k <= hi; k++) col[k - lo] += spec.power[t * spec.bins + k];
    }
    if (!n) return null;
    for (let i = 0; i < col.length; i++) col[i] = col[i] / n - floor[lo + i];
    let fp = 0;
    for (let i = 1; i < col.length; i++) if (col[i] > col[fp]) fp = i;
    const flevel = col[fp] * Math.pow(10, -usedDown / 10);
    let a = fp, b = fp;
    for (let i = 0; i < col.length; i++) {
      if (col[i] < flevel) continue;
      if (i < a) a = i;
      if (i > b) b = i;
    }
    const fo = occupied(col);
    return { x: (b - a) * binHz, occ: fo ? fo.width : null };
  };
  const K = spec.frames >= 4 * folds ? folds : 2;
  const foldWidths = { x: [], occ: [] };
  if (spec.frames >= 2 * K) {
    for (let f = 0; f < K; f++) {
      const w = widthsOver((t) => t % K === f);
      if (!w) continue;
      foldWidths.x.push(w.x);
      if (w.occ != null) foldWidths.occ.push(w.occ);
    }
  }
  // The interleaved folds are not enough on their own, and a split-half test
  // says so. Interleaving is right for the reason above, but it means every
  // fold sees the same slow structure — the same fades, the same run of data
  // bits — so on anything but white noise the folds agree far better than two
  // independent looks at the emission would. Measured on a 50 Bd on-off keyed
  // carrier over six seconds: the fold scatter put the 99% width at +/- 13 Hz
  // while the two contiguous halves of the same recording read 156.7 and
  // 232.4 Hz. So both are computed and the larger is taken. Each half sees half
  // the frames, so its own SD is sqrt(2) times the full estimate's and the SD
  // of their difference is twice it: |a-b|/2 estimates the full-region SD.
  const mid = spec.frames >> 1;
  const halfA = spec.frames >= 8 ? widthsOver((t) => t < mid) : null;
  const halfB = spec.frames >= 8 ? widthsOver((t) => t >= mid) : null;
  const halfSpread = (a, b) => (a == null || b == null ? null : Math.abs(a - b) / 2);
  const xHalfSpread = halfA && halfB ? halfSpread(halfA.x, halfB.x) : null;
  const occHalfSpread = halfA && halfB ? halfSpread(halfA.occ, halfB.occ) : null;
  const scatter = (arr) => {
    if (arr.length < 2) return null;
    const m = arr.reduce((s, v) => s + v, 0) / arr.length;
    const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1);
    return Math.sqrt(v) / Math.sqrt(arr.length);
  };

  // How much of the in-band power sits in the peak and its own resolution
  // width. Above 0.5 the 99% definition has nothing left to integrate.
  const half = Math.max(1, Math.ceil(spec.enbwHz / binHz));
  let carrier = 0, total = 0;
  for (let i = 0; i < excess.length; i++) {
    total += excess[i];
    if (Math.abs(i - peak) <= half) carrier += excess[i];
  }
  // Only meaningful when the band holds more signal than it holds noise
  // residual. On a band that is all noise the total is a sum of zero-mean
  // residuals near zero and the ratio explodes — it reached 10.9 before this
  // guard, which is not a fraction of anything.
  const carrierFraction = total > 0 && carrier <= total ? carrier / total : null;
  const carrierDominant = carrierFraction != null && carrierFraction > 0.5;

  let trust, why;
  if (carrierDominant && limitedByNoise) {
    trust = 'neither';
    why = 'both definitions have failed here: the emission is carrier-dominant ('
      + (100 * carrierFraction).toFixed(1) + '% of in-band power within one resolution width of '
      + 'the peak), which collapses the 99% figure, AND the peak stands only '
      + peakBinSnrDb.toFixed(1) + ' dB above its noise floor, which puts the -' + XDB_DOWN
      + ' dB crossing below the noise. Neither number should be quoted as an occupied bandwidth';
  } else if (carrierDominant) {
    trust = 'xdb';
    why = 'carrier-dominant: ' + (100 * carrierFraction).toFixed(1) + '% of the in-band power '
      + 'lies within one resolution width of the peak, so the 0.5% and 99.5% crossings both '
      + 'land on the carrier and the 99% figure collapses toward zero';
  } else if (limitedByNoise) {
    trust = 'occupied99';
    why = 'the peak is only ' + peakBinSnrDb.toFixed(1) + ' dB above its own noise floor, so a -'
      + XDB_DOWN + ' dB crossing is below the noise; the x-dB figure here is a -'
      + usedDown.toFixed(1) + ' dB width and is a lower bound';
  } else {
    trust = 'xdb';
    why = 'both definitions are supported (carrier holds '
      + (carrierFraction == null ? 'n/a' : (100 * carrierFraction).toFixed(1) + '%')
      + ' of in-band power, peak is ' + peakBinSnrDb.toFixed(1) + ' dB above its floor); the '
      + 'x-dB figure is primary per ITU-R SM.328';
  }

  const occUnc = Math.max(scatter(foldWidths.occ) || 0, occHalfSpread || 0, binHz / 2);
  const xdbUnc = Math.hypot(Math.max(scatter(foldWidths.x) || 0, xHalfSpread || 0), binHz / 2);
  return {
    peakIndex: lo + peak, peakExcess, peakFloor, peakBinSnrDb,
    xdb: q(xHighHz - xLowHz, 'Hz', xdbUnc,
      'ITU-R SM.328 x-dB width at -' + usedDown.toFixed(1) + ' dB below the peak, taken between '
      + 'the OUTERMOST crossings of the noise-subtracted mean spectrum; uncertainty is the '
      + 'larger of the interleaved-fold scatter and half the disagreement between the two '
      + 'contiguous halves of the region, in quadrature with half a bin',
      {
        lowHz: xLowHz, highHz: xHighHz, dbDown: usedDown, requestedDbDown: dbDown,
        limitedByNoise,
        // The two terms the uncertainty is built from, reported so that which
        // one is carrying it is visible rather than inferred. `occupied99` has
        // reported them since it was written; the x-dB width did not, and the
        // half-spread term inside it was therefore defended by no test at all.
        // See `bothWidthsCarryTheirHalfSpread`.
        foldWidths: foldWidths.x.slice(),
        foldScatterHz: scatter(foldWidths.x),
        halfSpreadHz: xHalfSpread,
        clipped: left.clipped || right.clipped,
        contiguousLowHz: (lo + contigLo) * binHz,
        contiguousHighHz: (lo + contigHi) * binHz,
        // Two tones with a valley between them, or a second emission in the
        // region. The outermost definition covers both; this says it happened.
        splitEmission,
      }),
    occupied99: occ
      ? q(occ.width, 'Hz', occUnc,
        '99% power between the 0.5% and 99.5% points of the cumulative noise-subtracted '
        + 'spectrum; uncertainty is the larger of the interleaved-fold scatter and half the '
        + 'disagreement between the two contiguous halves of the region — both of which are '
        + 'the tail random walk, since the tails integrate a zero-mean noise residual and each '
        + 'crossing wanders — floored at half a bin',
        {
          lowHz: occ.lowHz, highHz: occ.highHz,
          foldWidths: foldWidths.occ.slice(),
          foldScatterHz: scatter(foldWidths.occ),
          halfSpreadHz: occHalfSpread,
          // The "tails random-walk on noise" problem as a number: the spread
          // as a fraction of the answer itself.
          walkFraction: occ.width > 0 ? occUnc / occ.width : null,
          // The caveat travels with the number, not only with its sibling.
          // On a carrier-dominant emission even this uncertainty is optimistic:
          // measured on a 50 Bd on-off keyed carrier (85.6% of in-band power in
          // the carrier), two contiguous halves of one six-second recording
          // read 156.7 and 232.4 Hz while each claimed +/- 5.7 and +/- 18.0.
          // The 99% crossings are walking on the splatter tails and no
          // sub-interval of the region predicts how far they will walk.
          collapsed: carrierDominant,
          caution: carrierDominant
            ? 'carrier-dominant (' + (100 * carrierFraction).toFixed(1) + '% of in-band power '
              + 'within one resolution width of the peak): the 0.5% and 99.5% crossings both '
              + 'sit on the splatter tails, this figure is unstable between halves of the same '
              + 'recording by far more than the uncertainty quoted here, and `trustworthy` '
              + 'nominates the x-dB width instead'
            : null,
        })
      : unmeasured('Hz', 'total noise-subtracted power in the band is not positive'),
    carrierFraction, trustworthy: trust, trustReason: why,
    excess, lo, hi,
  };
}

/** Least squares slope with the standard error of the slope. */
function ols(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) * (xs[i] - mx); sxy += (xs[i] - mx) * (ys[i] - my); }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let sse = 0, sst = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (intercept + slope * xs[i]);
    sse += r * r;
    sst += (ys[i] - my) * (ys[i] - my);
  }
  const s2 = sse / (n - 2);
  return {
    slope, intercept, n,
    se: Math.sqrt(s2 / sxx),
    residualSd: Math.sqrt(s2),
    r2: sst > 0 ? 1 - sse / sst : null,
  };
}

/**
 * The per-frame peak frequency track, and a line through it.
 *
 * Frames where the signal is not present are dropped rather than allowed to
 * contribute a noise peak; the count kept is returned so a reader can see how
 * much of the region actually carried the emission. A power-weighted centroid
 * track is fitted alongside as a cross-check, because a peak track on an FSK
 * signal hops between the two tones and its slope is then a property of the
 * data pattern rather than of the transmitter's oscillator.
 */
export function driftFit(spec, stats, { lo, hi }, { minFrameSnr = 6 } = {}) {
  const { power, frames, bins, binHz, times } = spec;
  const { floor } = stats;
  const ts = [], fs = [], cs = [];
  for (let t = 0; t < frames; t++) {
    const row = t * bins;
    let k = lo, best = -Infinity;
    let num = 0, den = 0;
    for (let i = lo; i <= hi; i++) {
      const ex = power[row + i] - floor[i];
      if (ex > best) { best = ex; k = i; }
      if (ex > 0) { num += i * ex; den += ex; }
    }
    if (!(best > minFrameSnr * floor[k]) || !(den > 0)) continue;
    const d = parabolic((i) => 10 * Math.log10(Math.max(power[row + i] - floor[i], 1e-300)), k, lo, hi);
    ts.push(times[t]);
    fs.push((k + d) * binHz);
    cs.push((num / den) * binHz);
  }
  const kept = ts.length;
  if (kept < 8) {
    return {
      track: unmeasured('Hz/s', 'only ' + kept + ' of ' + frames + ' frames carry a peak more '
        + 'than ' + minFrameSnr + 'x its noise floor; a slope needs at least 8'),
      framesUsed: kept, framesTotal: frames,
    };
  }
  const peakFit = ols(ts, fs);
  const centFit = ols(ts, cs);
  // The OLS standard error assumes independent residuals. These are not: the
  // frames overlap 50%, and the peak track wanders on a timescale of many
  // frames, so the residuals are strongly autocorrelated and the textbook SE
  // is far too small. Measured on a 2 Hz/s carrier over six seconds: the two
  // halves of the recording fitted 1.912 and 2.060 Hz/s while each claimed
  // +/- 0.007, a ten-sigma disagreement between two looks at one oscillator.
  //
  // So the region's own two halves are fitted as well and the larger estimate
  // is taken. Each half has half the frames over half the time base, so its
  // slope SD is about 2.8x the full fit's and the SD of the difference about
  // 4x it; |a-b|/2 is therefore a conservative estimate of the full-region SD,
  // by about a factor of two, which is the right direction to be wrong in for
  // a bar this badly understated. Reported separately so both are visible.
  const mid = kept >> 1;
  const fitA = kept >= 8 ? ols(ts.slice(0, mid), fs.slice(0, mid)) : null;
  const fitB = kept >= 8 ? ols(ts.slice(mid), fs.slice(mid)) : null;
  const halfSpread = fitA && fitB ? Math.abs(fitA.slope - fitB.slope) / 2 : null;
  const slopeSe = Math.max(peakFit.se, halfSpread || 0);
  const disagree = peakFit && centFit && peakFit.se > 0
    && Math.abs(peakFit.slope - centFit.slope) > 3 * Math.hypot(peakFit.se, centFit.se);
  return {
    framesUsed: kept, framesTotal: frames,
    track: q(peakFit.slope, 'Hz/s', slopeSe,
      'ordinary least squares on the parabolic-interpolated peak frequency of each frame, '
      + kept + ' of ' + frames + ' frames above threshold; uncertainty is the larger of the '
      + 'standard error of the slope and half the disagreement between fits to the two halves '
      + 'of the region, because the frames overlap and the residuals are autocorrelated, which '
      + 'the textbook standard error does not know',
      {
        r2: peakFit.r2,
        olsSeHzPerSec: peakFit.se,
        halfSpreadHzPerSec: halfSpread,
        halfSlopesHzPerSec: fitA && fitB ? [fitA.slope, fitB.slope] : null,
        residualSdHz: peakFit.residualSd,
        centroidSlope: centFit ? centFit.slope : null,
        centroidSe: centFit ? centFit.se : null,
        // A peak track that hops between two FSK tones has a residual SD near
        // half the shift and a slope that reflects the data, not the oscillator.
        tracksDisagree: !!disagree,
        caution: disagree
          ? 'the peak-frequency and centroid slopes differ by more than 3 combined standard '
            + 'errors, which is what an FSK or multi-tone emission does to a peak track; treat '
            + 'the peak slope as untrustworthy and read the centroid slope instead'
          : null,
      }),
    peakTrackHz: Float64Array.from(fs),
    peakTrackSec: Float64Array.from(ts),
  };
}

/**
 * Analytic signal restricted to a band, by zeroing the spectrum outside it.
 *
 * Zero-padded to twice the length so the circular convolution of the brick wall
 * does not wrap the end of the region onto its start. A brick wall rings, which
 * smears symbol transitions over roughly rate/bandwidth samples; for the
 * instantaneous-frequency histogram below that adds samples BETWEEN the two
 * modes, which lowers the measured separation. The bias is therefore
 * conservative — it can hide an FSK, it cannot invent one.
 */
export function bandAnalytic(mono, sampleRate, from, to, lowHz, highHz) {
  const n = to - from;
  if (n < 64) return null;
  const size = nextPow2(2 * n);
  const fft = new FFT(size, { precision: 'f64' });
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < n; i++) re[i] = mono[from + i];
  fft.forward(re, im);
  const df = sampleRate / size;
  const kLo = Math.max(1, Math.floor(lowHz / df));
  const kHi = Math.min((size >> 1) - 1, Math.ceil(highHz / df));
  for (let k = 0; k < size; k++) {
    if (k >= kLo && k <= kHi) { re[k] *= 2; im[k] *= 2; } else { re[k] = 0; im[k] = 0; }
  }
  fft.inverse(re, im);
  return {
    re: re.slice(0, n), im: im.slice(0, n),
    // The brick wall's impulse response is a sinc of width rate/bandwidth; that
    // many samples at each end are the filter filling, not signal.
    guard: Math.min(n >> 2, Math.ceil(sampleRate / Math.max(1, highHz - lowHz))),
  };
}

/**
 * FSK shift from the instantaneous-frequency histogram, or null.
 *
 * Only the loud 40% of samples by envelope are used. A keyed signal spends part
 * of its time with no carrier at all, and the instantaneous frequency of noise
 * is spread across the whole band — those samples would fill the valley whose
 * depth is the entire decision.
 */
export function fskShift(mono, sampleRate, { from, to, lowHz, highHz }, precomputed) {
  const z = precomputed || bandAnalytic(mono, sampleRate, from, to, lowHz, highHz);
  if (!z) return unmeasured('Hz', 'region shorter than 64 samples');
  const amp = instantaneousAmp(z.re, z.im);
  const freq = instantaneousFreq(z.re, z.im, sampleRate);
  const guard = z.guard;
  const usable = amp.length - 2 * guard;
  if (usable < 256) return unmeasured('Hz', 'fewer than 256 samples survive the filter guard');
  const gate = quantileSorted(Float64Array.from(amp.subarray(guard, amp.length - guard)).sort(), 0.6);
  // A continuous-phase FSK has a FLAT envelope, so the envelope gate alone does
  // not remove the samples taken while the frequency is on its way from one
  // tone to the other. Those land between the modes and pull the two means
  // together: on a synthesised 170 Hz shift the mean-based separation read
  // 166.4 Hz. Rejecting the fastest-moving third of the samples, and taking the
  // MEDIAN of each mode rather than its mean, removes both effects.
  const slew = new Float64Array(amp.length - 2 * guard);
  for (let i = guard; i < amp.length - guard; i++) slew[i - guard] = Math.abs(freq[i] - freq[i - 1]);
  const slewGate = quantileSorted(Float64Array.from(slew).sort(), 0.67);
  const kept = [];
  for (let i = guard; i < amp.length - guard; i++) {
    if (amp[i] >= gate && slew[i - guard] <= slewGate && freq[i] > lowHz && freq[i] < highHz) {
      kept.push(freq[i]);
    }
  }
  if (kept.length < 128) {
    return unmeasured('Hz', 'only ' + kept.length + ' samples survive the envelope gate and the band');
  }

  const NB = 128;
  const span = highHz - lowHz;
  const histBinHz = span / NB;
  const raw = new Float64Array(NB);
  for (const f of kept) raw[Math.min(NB - 1, Math.max(0, Math.floor((f - lowHz) / span * NB)))]++;
  // Three-bin smoothing: the decision below is about the DEPTH of a valley, and
  // an unsmoothed histogram's shot noise puts a spurious empty bin in the flank
  // of any unimodal distribution.
  const hist = new Float64Array(NB);
  for (let i = 0; i < NB; i++) {
    hist[i] = ((i > 0 ? raw[i - 1] : 0) + raw[i] + (i < NB - 1 ? raw[i + 1] : 0))
      / ((i > 0 ? 1 : 0) + 1 + (i < NB - 1 ? 1 : 0));
  }

  let m1 = 0;
  for (let i = 1; i < NB; i++) if (hist[i] > hist[m1]) m1 = i;
  // The second mode has to be a genuinely separate lump, so anything within
  // four histogram bins of the first is the same lump's own flank.
  let m2 = -1;
  for (let i = 0; i < NB; i++) {
    if (Math.abs(i - m1) < 4) continue;
    if (m2 < 0 || hist[i] > hist[m2]) m2 = i;
  }
  const stats0 = { samples: kept.length, histBinHz, modeAHz: lowHz + (m1 + 0.5) * histBinHz };
  if (m2 < 0 || !(hist[m2] > 0)) {
    return unmeasured('Hz', 'the instantaneous-frequency histogram has only one populated mode', stats0);
  }
  const a1 = Math.min(m1, m2), a2 = Math.max(m1, m2);
  let valley = Infinity, valleyAt = a1;
  for (let i = a1 + 1; i < a2; i++) if (hist[i] < valley) { valley = hist[i]; valleyAt = i; }
  if (!isFinite(valley)) valley = Math.min(hist[m1], hist[m2]);
  const smaller = Math.min(hist[m1], hist[m2]);
  // 1 means an empty valley between two clean spikes; 0 means the "second mode"
  // is just the shoulder of the first and there is no valley at all.
  // Clamped to [0, 1]: it is a fraction by construction, but when one "mode" is
  // a lone spike out in a tail the interior minimum can exceed it and the raw
  // expression goes negative. Those cases are rejected below anyway, for having
  // almost no samples on one side; a fraction outside its own range in the
  // returned diagnostics would just be noise for the reader.
  const valleyDepth = smaller > 0 ? Math.max(0, Math.min(1, 1 - valley / smaller)) : 0;
  const cut = lowHz + (valleyAt + 0.5) * histBinHz;

  const stat = (pred) => {
    const vals = [];
    let s = 0, s2 = 0;
    for (const f of kept) if (pred(f)) { vals.push(f); s += f; s2 += f * f; }
    const n = vals.length;
    const m = n ? s / n : NaN;
    const sorted = Float64Array.from(vals).sort();
    return {
      n, mean: m, centre: n ? quantileSorted(sorted, 0.5) : NaN,
      sd: n > 1 ? Math.sqrt(Math.max(0, s2 / n - m * m)) : NaN,
      // Half the interquartile range scaled to a Gaussian sigma: the scale of
      // the mode itself, not of the mode plus its transition tails.
      robustSd: n > 3 ? (quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25)) / 1.349 : NaN,
    };
  };
  const A = stat((f) => f <= cut);
  const B = stat((f) => f > cut);
  const massBalance = (A.n + B.n) > 0 ? Math.min(A.n, B.n) / (A.n + B.n) : 0;
  const ashmanD = A.n > 1 && B.n > 1
    ? Math.SQRT2 * Math.abs(B.mean - A.mean) / Math.sqrt(A.sd * A.sd + B.sd * B.sd) : NaN;
  const shiftHz = Math.abs(B.centre - A.centre);
  const separationHz = Math.abs(m2 - m1) * histBinHz;

  const stats = Object.assign(stats0, {
    valleyDepth, massBalance, ashmanD,
    ashmanReferenceForUnimodal: ASHMAN_REFERENCE_UNIMODAL,
    modeBHz: lowHz + (m2 + 0.5) * histBinHz,
    valleyHz: cut, modeSeparationHz: separationHz,
    lowerHz: A.centre, upperHz: B.centre,
    lowerMeanHz: A.mean, upperMeanHz: B.mean,
    lowerSdHz: A.robustSd, upperSdHz: B.robustSd,
    lowerCount: A.n, upperCount: B.n,
    meanBasedShiftHz: Math.abs(B.mean - A.mean),
  });

  if (!(A.n > 8 && B.n > 8)) {
    return unmeasured('Hz', 'one side of the valley holds fewer than 9 samples', stats);
  }
  const bimodal = valleyDepth >= VALLEY_MIN_DEPTH && massBalance >= 0.15 && separationHz >= 3 * histBinHz;
  if (!bimodal) {
    return unmeasured('Hz',
      'the instantaneous-frequency histogram is not bimodal: the valley between the two modes '
      + 'is ' + (100 * (1 - valleyDepth)).toFixed(0) + '% of the smaller mode (needs <= '
      + (100 * (1 - VALLEY_MIN_DEPTH)).toFixed(0) + '%), minority mass = '
      + massBalance.toFixed(3) + ' (needs >= 0.15), mode separation = '
      + separationHz.toFixed(1) + ' Hz (needs >= ' + (3 * histBinHz).toFixed(1) + ' Hz). '
      + 'Ashman D here is ' + (isFinite(ashmanD) ? ashmanD.toFixed(2) : 'n/a')
      + ', which is not the gate: a unimodal Gaussian split at its own mean gives D = '
      + ASHMAN_REFERENCE_UNIMODAL, stats);
  }
  // How wide each mode is against how far apart they are. This is the whole
  // uncertainty story below, so it is computed before anything is quoted.
  const modeWidth = Math.max(A.robustSd, B.robustSd) / shiftHz;
  if (!(modeWidth <= FSK_MAX_MODE_WIDTH)) {
    return unmeasured('Hz',
      'the two modes are ' + (100 * modeWidth).toFixed(0) + '% of the shift wide (the wider '
      + 'mode\'s interquartile sigma is ' + Math.max(A.robustSd, B.robustSd).toFixed(1)
      + ' Hz against a ' + shiftHz.toFixed(1) + ' Hz separation), above the '
      + (100 * FSK_MAX_MODE_WIDTH).toFixed(0) + '% bar. The estimate reads LOW by an amount '
      + 'that grows with this width, and past this bar the calibration grid measured it at '
      + 'up to -26% of the shift: the number would be wrong by more than the widths a '
      + 'reader is trying to tell apart. Narrow the region to the emission, take a longer '
      + 'stretch, or accept that the shift is not measurable here', stats);
  }
  // Instantaneous frequency is oversampled: a band-limited signal carries about
  // bandwidth x duration independent values, not rate x duration. Using the raw
  // sample count would understate this standard error by sqrt(rate/bandwidth),
  // which on an 8 kHz recording of a 300 Hz-wide signal is a factor of 5.2.
  const eff = Math.min(1, (highHz - lowHz) / sampleRate);
  const va = A.robustSd * A.robustSd / Math.max(1, A.n * eff);
  const vb = B.robustSd * B.robustSd / Math.max(1, B.n * eff);
  // pi/2 is the asymptotic penalty a median pays against a mean for Gaussian
  // data, and the price of not being pulled about by the transition tails.
  const se = Math.sqrt((Math.PI / 2) * (va + vb));
  // The systematic, as a function of THIS measurement's own mode width rather
  // than as a constant. See FSK_TRANSITION_FRACTION for the grid it came off.
  const systematicFraction = Math.max(FSK_TRANSITION_FRACTION, FSK_NOISE_BIAS_SLOPE * modeWidth);
  const systematic = systematicFraction * shiftHz;
  return q(shiftHz, 'Hz', Math.hypot(se, systematic),
    'separation of the two modes of the instantaneous-frequency histogram, split at the valley '
    + 'between them, each mode located by its MEDIAN and scaled by its interquartile range; '
    + 'uncertainty is the standard error of the difference of two medians (sample count '
    + 'reduced to bandwidth x duration independent values) in quadrature with a '
    + (100 * systematicFraction).toFixed(1) + '% systematic for the inward bias, which is the '
    + 'larger of a ' + (100 * FSK_TRANSITION_FRACTION).toFixed(1) + '% floor for transition '
    + 'smearing and ' + FSK_NOISE_BIAS_SLOPE + ' x the ' + (100 * modeWidth).toFixed(1)
    + '% mode width measured here',
    Object.assign(stats, {
      statisticalSeHz: se,
      systematicHz: systematic,
      systematicFraction,
      modeWidthFraction: modeWidth,
      modeWidthLimit: FSK_MAX_MODE_WIDTH,
      biasDirection: 'low',
      biasNote: 'the estimate is expected to be LOW, not symmetric about the truth, by up to '
        + 'the systematic quoted above. Two causes, both one-sided: band-limiting ramps each '
        + 'frequency step and the samples on the ramp pull the two modes toward each other '
        + '(present at zero noise, measured up to 3.0% at a low modulation index), and noise '
        + 'gives the instantaneous frequency heavy tails whose truncation at the valley moves '
        + 'each median inward (measured up to 26% of the shift). The systematic is not a '
        + 'constant and is not a correction: it tracks the mode width measured here, over a '
        + '1,440-point grid of shift, rate and noise level',
    }));
}

/**
 * A local floor for a coloured spectrum: median of a wide window around each
 * anchor, linearly interpolated between anchors.
 *
 * The modulus of a first difference does not have a flat spectrum, so a single
 * median over the whole search span is not a floor — it is an average of a
 * slope. Against one, a pure tone in noise produced a confident 6.1 baud at
 * 195x. A local floor tracks the pedestal and the same input reads a few x.
 */
function localFloor(mag, first, last, {
  window = SYMBOL_FLOOR_WINDOW_BINS, stride = 64, guard = SYMBOL_FLOOR_GUARD_BINS,
  minCells = SYMBOL_FLOOR_MIN_CELLS, low = first, high = last,
} = {}) {
  const half = window >> 1;
  // Anchors are dense where the window is short. The window's reach is what
  // limits how fast the floor can follow the background, and at low bin numbers
  // the reach is small BECAUSE the background is changing fast there; a fixed
  // stride of 64 would interpolate the floor straight across the steepest part
  // of the pedestal. The stride is a quarter of the reach, so the floor is
  // sampled about four times per window everywhere.
  const anchors = [];
  for (let k = first; k <= last;) {
    anchors.push(k);
    const reach = Math.min(half, k - low, high - k);
    k += Math.max(2, Math.min(stride, reach >> 2));
  }
  if (anchors[anchors.length - 1] !== last) anchors.push(last);
  const cells = [];
  const vals = anchors.map((k) => {
    // Symmetric by construction: the same number of bins each side, with the
    // line's own mainlobe cut out of the middle.
    const d = Math.min(half, k - low, high - k);
    if (d < guard + minCells) return null;
    cells.length = 0;
    for (let i = k - d; i <= k - guard; i++) cells.push(mag[i]);
    for (let i = k + guard; i <= k + d; i++) cells.push(mag[i]);
    return median(cells) || 1e-300;
  });
  const flo = new Float64Array(last + 2);
  const supported = new Uint8Array(last + 2);
  for (let a = 0; a < anchors.length - 1; a++) {
    const k0 = anchors[a], k1 = anchors[a + 1];
    const v0 = vals[a], v1 = vals[a + 1];
    if (v0 == null || v1 == null) continue;
    // Interpolated in the LOG domain, because a 1/f pedestal is a straight
    // line there and a straight line in the linear domain sits above it.
    const l0 = Math.log(v0), l1 = Math.log(v1);
    for (let k = k0; k <= k1; k++) {
      const t = k1 === k0 ? 0 : (k - k0) / (k1 - k0);
      flo[k] = Math.exp(l0 * (1 - t) + l1 * t);
      supported[k] = 1;
    }
  }
  return { flo, supported };
}

/**
 * Do the channels' strongest lines stand in an integer relation to each other?
 *
 * Frequency, envelope and phase transitions of ONE emission all fall on the
 * same symbol lattice, so their peaks are multiples of one rate. When they are
 * not, the band contains more than one emission and the winner is a rate for
 * whichever of them happened to be loudest.
 */
function summaryDisagrees(results, alphaStep, ratioOf) {
  if (results.length < 2) return false;
  const top = results[0].index * alphaStep;
  const other = results[1].index * alphaStep;
  if (!(top > 0) || !(other > 0)) return false;
  const r = ratioOf(top, other);
  return Math.abs(r - Math.round(r)) > 0.06 * Math.round(r);
}

// The stopband the decimator's anti-alias filter is designed to.
export const ANTIALIAS_DB = 60;

/**
 * The decimation in front of the symbol-rate search, as numbers a test can
 * check rather than as arithmetic buried in the estimator.
 *
 * The search runs up to `top` baud, so the transition sequences are taken down
 * to about 6 x top and everything that could fold into [0, top] has to be gone
 * before the samples are dropped. What CAN fold into the searched span is
 * exactly the band [decRate - top, decRate + top], and its lower edge —
 * `firstAliasHz` — is the least attenuated point of it, because a windowed
 * sinc's stopband ripple decays with frequency. That edge is where a test of
 * this filter belongs; a pin deeper into the stopband passes on a filter that
 * is already failing at the edge. Measured with the filter replaced by the
 * block sum it used to be: a modulation whose line lands on `firstAliasHz`
 * comes back at 1085x its local floor, against 86x for a pin at 600 Hz.
 */
export function decimationDesign(rate, top, regionSamples = Infinity) {
  const L = Math.max(1, Math.floor(rate / (6 * top)));
  const decRate = rate / L;
  // Kaiser's own design rule: taps ~ (A - 8) / (2.285 * 2pi * df) for a
  // stopband A dB down across a transition of df cycles per sample. Passband
  // edge 1/(6L), stopband edge 1/(2L), so df = 1/(3L) and the cutoff sits at
  // 1/(3L) — which is decRate/3, two octaves above the top of the search.
  let taps = L === 1 ? 1
    : Math.ceil((ANTIALIAS_DB - 8) * 3 * L / (2.285 * 2 * Math.PI)) | 1;
  // The filter's own fill costs (taps-1) samples of the region. Capping it at a
  // quarter of the region keeps that under 25% at the price of a wider
  // transition band; on every rate and bandwidth in this bench the cap does not
  // bite (it would need a region shorter than about 11 x taps).
  const tapCap = Number.isFinite(regionSamples)
    ? Math.max(9, (regionSamples >> 2) | 1) : Infinity;
  if (taps > tapCap) taps = tapCap;
  return {
    L, decRate, taps, halfTaps: (taps - 1) >> 1,
    cutoff: 1 / (3 * L),
    passbandHz: top,
    stopbandHz: decRate / 2,
    // The lowest frequency that folds into [0, top], and so the weakest point
    // of the stopband that matters.
    firstAliasHz: decRate - top,
    capped: taps === tapCap,
  };
}

/**
 * The waveform's fourth standardised moment over the analysed region.
 *
 * 3 for anything Gaussian, 1.5 for a pure sine, and tens to hundreds for a
 * series of impulses. Computed on the RAW samples, before any band-limiting,
 * because the question it answers — is this material a crash train? — is about
 * the material and not about the band.
 */
export function waveformKurtosis(mono, from, to) {
  const a = Math.max(0, Math.min(mono.length, from | 0));
  const b = Math.max(a, Math.min(mono.length, to | 0));
  const n = b - a;
  if (n < 8) return null;
  let m = 0;
  for (let i = a; i < b; i++) m += mono[i];
  m /= n;
  let s2 = 0, s4 = 0;
  for (let i = a; i < b; i++) {
    const d = mono[i] - m;
    const d2 = d * d;
    s2 += d2; s4 += d2 * d2;
  }
  s2 /= n; s4 /= n;
  return s2 > 0 ? s4 / (s2 * s2) : null;
}

/** Peak-to-local-floor ratio near an index, and where the local peak sits. */
function ratioNear(res, at, span = 1) {
  let best = -1, idx = at;
  for (let i = Math.max(res.first, at - span); i <= Math.min(res.last, at + span); i++) {
    // A bin with no symmetric floor has no ratio. It is not evidence either
    // way, and counting it as zero is what keeps it from becoming evidence.
    if (!res.supported[i]) continue;
    const r = res.mag[i] / (res.flo[i] || 1e-300);
    if (r > best) { best = r; idx = i; }
  }
  return { ratio: best < 0 ? 0 : best, index: idx };
}

/**
 * How many of 2x, 3x, 4x stand clear of the local floor, counting only the
 * LEADING RUN.
 *
 * Contiguity is the whole point. A real impulse lattice at f radiates at 2f as
 * well as 3f; a line that has energy at 3f and 4f but a hole at 2f is not the
 * fundamental of anything. Measured on a real M08 Morse recording taken over
 * the whole audio band, a spurious 6.32 Bd line had a comb reading 17.2, 2.9,
 * 15.0, 5.3 — counted loosely that is two harmonics and looks convincing;
 * counted contiguously it is none. The same recording band-limited to the tone
 * gave 12.648 Bd with a comb of 16.3, 16.1, 15.5, 16.5.
 */
function harmonicsOf(res, fundamental) {
  let n = 0;
  for (const mult of [2, 3, 4]) {
    const at = Math.round(fundamental * mult);
    if (at > res.last - 1) break;
    if (ratioNear(res, at, 2).ratio < 4) break;
    n++;
  }
  return n;
}

/**
 * The fundamental behind the tallest line.
 *
 * The tallest line in a transition spectrum is very often a harmonic: measured
 * on synthesised FSK, an 11.3 baud stream peaked at 90.4 (8x), a 22.5 baud one
 * at 45.0 (2x), and 18 wpm Morse at 30.0 (2x). Reporting the peak reports the
 * wrong rate. So the divisors are walked from largest to smallest and the first
 * one that is BOTH a real line itself and carries a real comb of its own is
 * taken — the smallest frequency that explains the evidence, which is what a
 * fundamental is. Requiring two of its own harmonics is what stops noise at
 * peak/7 from being adopted.
 */
function fundamentalOf(res) {
  for (let d = 24; d >= 2; d--) {
    const cand = Math.round(res.index / d);
    if (cand < res.first + 1 || cand > res.last - 1) continue;
    if (Math.abs(cand * d - res.index) > 0.5 * d + 1) continue;
    const here = ratioNear(res, cand, 1);
    // 0.75 of the detection bar, not half of it: measured on synthesised FSK,
    // the full bar loses 4 detections in 20 across a wide SNR range while 0.5
    // and 0.75 lose none, and 0.75 rejects more weak sub-multiples.
    if (!(here.ratio >= SYMBOL_MIN_RATIO * 0.75)) continue;
    // The further down the comb the candidate sits, the more of that comb has
    // to be real: a 19th sub-multiple accepted on two harmonics would let
    // almost any low bin claim the emission. Measured need: an 11.3 Bd stream
    // peaked at its own 19th harmonic, which is why the range reaches 24.
    if (harmonicsOf(res, here.index) < (d > 6 ? 3 : 2)) continue;
    return here.index;
  }
  return res.index;
}

/**
 * Symbol rate from the spectrum of the transition instants.
 *
 * js/analysis/cyclic.js already computes a cyclic modulation spectrum and would
 * give this directly — but its analysis window is derived from the cyclic
 * ceiling and floored at MIN_FFT_SIZE = 256, so the highest alpha it can hear
 * is 2 x rate/256 = rate/128: 62.5 Hz on an 8 kHz recording. Half the material
 * here keys faster than that (45.45 and 50 baud fit; 75, 100 and 300 do not),
 * so this estimator works in the time domain instead, where the ceiling is set
 * by the sample rate rather than by a window. Where both are in range they
 * agree; see `agreesWithCyclicModule` in the test file.
 *
 * A keyed carrier changes SOMETHING at each symbol boundary — its frequency,
 * its envelope, or its phase — so the modulus of the first difference of each
 * of those is an impulse train on the symbol lattice. Random data makes it a
 * RANDOM SUBSET of that lattice, which still has discrete lines at multiples of
 * the symbol rate sitting on a pedestal. The line is what is searched for.
 *
 * Three channels are tried and the strongest wins, so the reported ratio is a
 * three-channel maximum and the bar it must clear was calibrated as one.
 */
export function symbolRate(mono, sampleRate, {
  from, to, lowHz, highHz, emissionBandwidthHz = null, minBaud = 4, maxBaud = null,
} = {}, precomputed) {
  const rate = Number(sampleRate);
  // A physical ceiling, not a preference. Keying at R baud puts sidebands out
  // to about R/2 either side of the carrier, so an emission W hertz wide cannot
  // be carrying a symbol rate above about W/2 — and if the estimator is allowed
  // to search above that it will find something. This is what stopped a pure
  // 1 kHz carrier 18.6 Hz wide from being reported as 14.5 baud at 56x.
  const emissionHz = emissionBandwidthHz == null ? (highHz - lowHz) / 3 : emissionBandwidthHz;
  const supportable = emissionHz / 2;
  const top = Math.min(maxBaud || 600, rate / 8, supportable);
  if (!(top >= 2 * minBaud)) {
    return unmeasured('Bd', 'the emission is only ' + emissionHz.toFixed(1) + ' Hz wide, so it '
      + 'cannot carry a symbol rate above about ' + supportable.toFixed(1) + ' Bd; there is no '
      + 'span left to search above the ' + minBaud + ' Bd floor',
      { emissionBandwidthHz: emissionHz, supportableBaud: supportable });
  }
  const z = precomputed || bandAnalytic(mono, rate, from, to, lowHz, highHz);
  if (!z) return unmeasured('Bd', 'region shorter than 64 samples');
  const amp = instantaneousAmp(z.re, z.im);
  const freq = instantaneousFreq(z.re, z.im, rate);
  const guard = Math.max(1, z.guard);
  const n = amp.length - 2 * guard;
  if (n < 8 * rate / minBaud) {
    return unmeasured('Bd', 'the region holds fewer than eight symbol periods at '
      + minBaud + ' Bd, the lowest rate searched');
  }

  // Down to about 6x the fastest rate searched — through a filter, not a boxcar.
  //
  // What this replaced was a block sum: a boxcar decimator with no anti-alias
  // filter. A boxcar is a poor lowpass — its first sidelobe is 13 dB down and
  // its skirt falls at 6 dB/octave — so any periodicity above decRate/2 folded
  // into the searched band and was reported as a symbol rate that is not there.
  // Measured before this filter existed: a 1500 Hz carrier with 80% amplitude
  // modulation at 300 Hz, searched over 4 to 100 Bd with decRate = 615.4 Hz,
  // came back 15.406 Bd at 91x its local floor with three harmonics and a
  // confidence of 'strong'. The line is the envelope's own 600 Hz component
  // folded about decRate; its 1200 Hz second harmonic folds onto twice the
  // same alias, which is where the "harmonics" came from. Nothing keys at 15
  // baud in that recording. See `symbolRateDoesNotAliasAFastPeriodicity`.
  //
  // So each transition sequence is lowpassed by a Kaiser-windowed sinc and
  // then sampled every L-th point. Passband to `top`, the fastest rate
  // searched; stopband from decRate/2 = 3 x top. Everything that can fold into
  // [0, top] lies above decRate - top = 5 x top and is therefore in the
  // stopband. The convolution is evaluated ONLY at the kept positions, so it
  // costs taps/L multiply-accumulates per input sample and does not grow with
  // L; `filter` from js/dsp/analytic.js computes all `n` outputs and would do
  // L times the work to be thrown away.
  const design = decimationDesign(rate, top, n);
  const { L, decRate, taps, halfTaps } = design;
  const h = L === 1 ? null : firLowpass(taps, design.cutoff, ANTIALIAS_DB);
  const m = L === 1 ? n : Math.floor((n - 1 - 2 * halfTaps) / L) + 1;
  if (m < 64) return unmeasured('Bd', 'fewer than 64 decimated samples in the region');

  // The per-sample transition magnitudes, at the full sample rate, before any
  // decimation touches them.
  const tf = new Float64Array(n), ta = new Float64Array(n), tp = new Float64Array(n);
  let ampMean = 0;
  for (let i = 0; i < n; i++) ampMean += amp[guard + i];
  ampMean = ampMean / n || 1;
  for (let i = 0; i < n; i++) {
    const k = guard + i;
    tf[i] = Math.abs(freq[k] - freq[k - 1]);
    ta[i] = Math.abs(amp[k] - amp[k - 1]) / ampMean;
    // Phase only: the complex step with the envelope divided out, which is
    // what a PSK transition moves and an unmodulated carrier does not.
    const ar = amp[k] || 1e-12, br = amp[k - 1] || 1e-12;
    tp[i] = Math.hypot(z.re[k] / ar - z.re[k - 1] / br, z.im[k] / ar - z.im[k - 1] / br);
  }
  const decimate = (x) => {
    if (L === 1) return x;
    const out = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      let acc = 0;
      const base = j * L + 2 * halfTaps;
      for (let t = 0; t < taps; t++) acc += h[t] * x[base - t];
      out[j] = acc;
    }
    return out;
  };
  const chans = {
    frequency: decimate(tf),
    envelope: decimate(ta),
    phase: decimate(tp),
  };

  const size = nextPow2(m);
  const fft = new FFT(size, { precision: 'f64' });
  const win = hann(m);
  const alphaStep = decRate / size;
  const first = Math.max(2, Math.ceil(minBaud / alphaStep));
  const last = Math.min((size >> 1) - 2, Math.floor(top / alphaStep));
  if (last <= first + 16) return unmeasured('Bd', 'the searched rate span covers too few bins');

  // The line search itself, over any span of one channel. Returned separately
  // so the two halves of the region can be searched the same way.
  const search = (x, offset, count, fftLen) => {
    const engine = fftLen === size ? fft : new FFT(fftLen, { precision: 'f64' });
    const w2 = fftLen === size ? win : hann(count);
    const step = (rate / L) / fftLen;
    const f0 = Math.max(2, Math.ceil(minBaud / step));
    const f1 = Math.min((fftLen >> 1) - 2, Math.floor(top / step));
    if (f1 <= f0 + 8) return null;
    let mean = 0;
    for (let i = 0; i < count; i++) mean += x[offset + i];
    mean /= count;
    const re = new Float64Array(fftLen);
    const im = new Float64Array(fftLen);
    for (let i = 0; i < count; i++) re[i] = (x[offset + i] - mean) * w2[i];
    engine.forward(re, im);
    // The magnitudes are computed WIDER than the searched span, because the
    // floor under the lowest searched bin has to come from bins on both sides
    // of it and the bins below f0 are perfectly good spectrum — they are simply
    // slower than the slowest rate anyone asked about.
    const reach = (SYMBOL_FLOOR_WINDOW_BINS >> 1) + 1;
    const magLow = Math.max(SYMBOL_FLOOR_LOW_BIN, f0 - reach);
    const magHigh = Math.min((fftLen >> 1) - 1, f1 + reach);
    const mag = new Float64Array(magHigh + 2);
    for (let k = magLow; k <= magHigh; k++) mag[k] = Math.hypot(re[k], im[k]);
    const { flo, supported } = localFloor(mag, f0, f1, { low: magLow, high: magHigh });
    let k = -1, best = -1;
    for (let i = f0; i <= f1; i++) {
      if (!supported[i]) continue;
      const r = mag[i] / (flo[i] || 1e-300);
      if (r > best) { best = r; k = i; }
    }
    // Every bin of the span was too close to an edge for a symmetric floor.
    if (k < 0) return null;
    const res = { index: k, ratio: best, mag, flo, supported, step, first: f0, last: f1 };
    res.fundamental = fundamentalOf(res);
    return res;
  };

  const results = [];
  for (const name of Object.keys(chans)) {
    const found = search(chans[name], 0, m, size);
    if (found) results.push(Object.assign({ channel: name }, found));
  }
  if (!results.length) return unmeasured('Bd', 'the searched rate span covers too few bins');
  results.sort((a, b) => b.ratio - a.ratio);
  const w = results[0];
  const searched = [first * alphaStep, last * alphaStep];
  const summary = results.map((r) => ({
    channel: r.channel, hz: r.index * alphaStep, ratio: r.ratio,
  }));

  if (!(w.ratio >= SYMBOL_MIN_RATIO)) {
    return unmeasured('Bd',
      'the strongest line in the transition spectrum is only ' + w.ratio.toFixed(1)
      + 'x its own local floor, below the calibrated bar of ' + SYMBOL_MIN_RATIO,
      { channels: summary, searchedHz: searched, alphaStep });
  }

  const fundamental = w.fundamental;
  const dFund = parabolic((i) => 20 * Math.log10(Math.max(w.mag[i], 1e-300)), fundamental, first, last);
  const hz = (fundamental + dFund) * alphaStep;
  const harmonics = harmonicsOf(w, fundamental);
  // The whole comb, so a reader can see which line was picked out of it.
  const comb = [];
  for (let mult = 1; mult <= 4; mult++) {
    const at = Math.round(fundamental * mult);
    if (at > w.last - 1) break;
    const r = ratioNear(w, at, 2);
    comb.push({ multiple: mult, hz: r.index * alphaStep, ratio: r.ratio });
  }
  const divided = fundamental !== w.index;

  // Two channels that peak at frequencies with no integer relation are two
  // different things in the same band, not two views of one emission.
  const ratioOf = (a, b) => (a > b ? a / b : b / a);
  const disagreeing = summaryDisagrees(results, alphaStep, ratioOf);

  // Clock or crash train? The discriminant is the waveform's own fourth moment,
  // measured before any of this analysis touched it. See IMPULSIVE_KURTOSIS.
  const kurtosis = waveformKurtosis(mono, from, to);
  const impulsiveMaterial = kurtosis != null && kurtosis > IMPULSIVE_KURTOSIS;

  // A real symbol clock is in both halves of the region at the same rate. An
  // artefact of band-limited noise is in neither half twice. This is what
  // separates a clock from a coincidence, and it is also where the honest part
  // of the uncertainty comes from.
  const halfLen = m >> 1;
  const halfFft = nextPow2(halfLen);
  const h1 = search(chans[w.channel], 0, halfLen, halfFft);
  const h2 = search(chans[w.channel], m - halfLen, halfLen, halfFft);
  // Each half is checked against the WHOLE region's comb, not against its own
  // resolved fundamental. Half the data is half the evidence, and the two
  // halves routinely settle on different members of the same comb — a 25 Bd
  // OOK gave 12.5 in one half and 50 in the other while the whole region gave
  // 25. What has to reproduce is the comb, so each half's line must sit on an
  // integer multiple of the fundamental, to within 2% or three of its own bins.
  const onComb = (h) => {
    if (!h || !(h.ratio >= SYMBOL_MIN_RATIO / 2)) return null;
    const raw = h.index * h.step;
    const mult = Math.round(raw / hz);
    if (mult < 1) return null;
    const tol = Math.max(0.02 * raw, 3 * h.step);
    if (Math.abs(raw - mult * hz) > tol) return null;
    return { hz: raw, ratio: h.ratio, multipleOfFundamental: mult, impliedFundamental: raw / mult };
  };
  const halves = [onComb(h1), onComb(h2)];
  if (!halves[0] || !halves[1]) {
    const said = (h) => (h ? (h.index * h.step).toFixed(2) + ' Bd at ' + h.ratio.toFixed(1) + 'x' : 'nothing');
    return unmeasured('Bd',
      'a line at ' + hz.toFixed(2) + ' Bd stands ' + w.ratio.toFixed(1) + 'x above its local '
      + 'floor over the whole region, but the two halves of the region do not reproduce its '
      + 'comb (' + said(h1) + ' vs ' + said(h2) + '), so it is not a symbol clock',
      { channels: summary, searchedHz: searched, alphaStep, wholeRegionHz: hz });
  }
  const halfSpread = Math.abs(halves[0].impliedFundamental - halves[1].impliedFundamental) / 2;

  // Does the line survive when the rectifier is taken out of the path?
  //
  // The three transition channels are the MODULUS of a first difference, and a
  // modulus is a rectifier. Rectifying a sinusoid at F produces harmonics at
  // 2F, 4F, 6F ... without end, decaying only as 1/(4j^2-1), and they are
  // produced on the existing sample grid — so every one of them above rate/2
  // folds straight back into the baseband BEFORE the decimator's anti-alias
  // filter is reached. No amount of stopband attenuation touches this: the
  // filter sits downstream of the fold. Raising ANTIALIAS_DB from 60 to 110
  // was measured to change none of the cases below by a single bin.
  //
  // Measured, sweeping a 1500 Hz carrier amplitude-modulated at every integer
  // rate from 200 to 380 Hz (543 searches, no keying anywhere in any of them):
  // 13 came back at 'good' or 'strong'. A 240 Hz modulation was reported as
  // 159.96 Bd at 3870x its local floor with two harmonics and a confidence of
  // 'strong'; 288 Hz as 63.99 Bd at 3579x with three. Every reported rate
  // matched |2 x modHz x j - k x rate| for integer j, k to the second decimal,
  // which is what identifies the mechanism: 2 x 240 x 17 = 8160, and 8160 -
  // 8000 = 160.
  //
  // The square of the same difference has no such series. Squaring a sinusoid
  // at F gives DC and 2F and nothing else, so a squared channel is band-limited
  // to twice the bandwidth of what went into it and cannot fold at all (while
  // the analysis band is under rate/4, which is where the guarantee holds). A
  // real symbol clock is an impulse train on the symbol lattice either way, so
  // its comb is in both. A rectification fold is in the modulus alone.
  //
  // The veto is applied to the ENVELOPE channel only, and that restriction is
  // measured rather than assumed. Over 73 real keyed detections on the envelope
  // channel — 25 and 60 Bd on-off keying and 45.45 and 100 Bd FSK, at four
  // amplitudes, in all five colours of test/noise-colours.mjs — the squared
  // channel's ratio at the same line never fell below 8.21, while the AM tones
  // above sit at a median of 2.2. On the FREQUENCY channel the statistic
  // carries no information at all: squaring amplifies the heavy tail of
  // instantaneous-frequency noise, so a real 45.45 Bd teleprinter standing
  // 14.8x in the modulus stands 2.8x in the square, and the AM tones stand 19x
  // to 32x — the separation is not merely weaker there, it is inverted. So the
  // frequency and phase channels are NOT covered by this guard, and a fold that
  // wins on one of them would still be reported.
  //
  // The test is RELATIVE, not absolute, and that was measured rather than
  // chosen. For a real clock the squared channel reads essentially the same
  // peak-to-floor ratio as the modulus channel: over the 73 real detections the
  // ratio of the two ran 0.75 to 1.23 with a median of 1.04. For a fold it
  // reads a small fraction — over 144 folds it never exceeded 0.250, and the
  // 240 Hz tone reported at 159.96 Bd stood 3870x in the modulus against 5.2x
  // in the square, a ratio of 0.0013. At 0.4 the bar has 1.9x in hand below the
  // worst real case and 1.6x above the worst fold.
  //
  // An absolute floor on the squared ratio was tried alongside this and then
  // removed: over the same 144 folds it caught nothing the relative test did
  // not, and no test could be made to fail by deleting it.
  const SQUARED_MIN_FRACTION = 0.4;
  let sqRatio = null;
  if (w.channel === 'envelope') {
    const squared = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const k = guard + i;
      const d = (amp[k] - amp[k - 1]) / ampMean;
      squared[i] = d * d;
    }
    const sq = search(decimate(squared), 0, m, size);
    sqRatio = sq ? ratioNear(sq, fundamental, 2).ratio : 0;
    const survives = sqRatio >= SQUARED_MIN_FRACTION * w.ratio;
    if (!survives) {
      return unmeasured('Bd',
        'a line at ' + hz.toFixed(2) + ' Bd stands ' + w.ratio.toFixed(1) + 'x above its local '
        + 'floor in the modulus of the envelope first difference, but only ' + sqRatio.toFixed(1)
        + 'x in the SQUARE of the same difference, which is band-limited and cannot alias. A '
        + 'symbol clock is an impulse train in both and reads about the same ratio in each; a '
        + 'line that lives only in the modulus is a harmonic of something faster, folded about '
        + 'the sample rate by the rectifier itself',
        {
          channels: summary, searchedHz: searched, alphaStep, wholeRegionHz: hz,
          squaredChannelRatio: sqRatio, modulusChannelRatio: w.ratio,
          squaredMinFraction: SQUARED_MIN_FRACTION,
        });
    }
  }


  // Each half sees half the data, so its own SD is sqrt(2) times the full
  // estimate's and the SD of their difference is twice it: |h1-h2|/2 estimates
  // the full-region SD directly. It is a one-degree-of-freedom estimate and can
  // come out at zero by luck, so it is floored at half an alpha bin.
  const unc = Math.max(alphaStep / 2, halfSpread);
  return q(hz, 'Bd', unc,
    'strongest discrete line, against a local median floor, in the spectrum of |first '
    + 'difference| of the ' + w.channel + ' of the band-limited analytic signal; sub-bin by '
    + 'parabolic interpolation, confirmed independently in both halves of the region. '
    + 'Uncertainty is the largest of half an alpha bin, half the disagreement between the two '
    + 'halves, and a line-width term scaling as 1/sqrt(peak-to-floor)',
    {
      confidence: {
        ratio: w.ratio,
        threshold: SYMBOL_MIN_RATIO,
        harmonicsFound: harmonics,
        comb,
        // Measured on a real M08 Morse transmission: given the whole audio band
        // the estimator returned 6.325 Bd and given a band around the tone
        // 12.648 Bd, and BOTH lines are really there. A dot plus its
        // inter-element space is two dot units long, so on-off keyed Morse puts
        // a genuine line at half the dot rate. Which line is the symbol rate is
        // not decidable from the spectrum, so it is not decided here.
        mayBeASubHarmonic: divided || comb.length > 1,
        subHarmonicNote: divided || comb.length > 1
          ? 'this is the lowest line carrying a full comb; the emission\'s symbol rate may be '
            + 'an integer multiple of it. On-off keyed Morse genuinely radiates a line at half '
            + 'the dot rate, because a dot plus its inter-element space is a two-unit period.'
          : null,
        channelsDisagree: disagreeing,
        channelsDisagreeNote: disagreeing
          ? 'the transition channels peak at frequencies with no integer relation, which means '
            + 'the band holds more than one thing. Narrow the region to the emission and measure '
            + 'again before believing this rate.'
          : null,
        // Clock, or the envelope of impulsive noise? The reader is told which
        // kind of material this was, measured on the raw waveform before any
        // of the analysis touched it. It is not a cap on the level: a Poisson
        // crash train has a FLAT expected spectrum and cannot manufacture a
        // harmonic comb, so a full comb under crashes is still a full comb.
        // Nothing measured here justified demoting one, and a guard that
        // cannot be made to fire is a guard that rots.
        // How the same line stands in the SQUARE of the envelope difference,
        // which cannot alias. Null on the frequency and phase channels, where
        // the statistic was measured to carry no information.
        squaredChannelRatio: sqRatio,
        waveformKurtosis: kurtosis,
        impulsiveMaterial,
        impulsiveNote: impulsiveMaterial
          ? 'the waveform\'s kurtosis is ' + kurtosis.toFixed(1) + ', against 3.0 for anything '
            + 'Gaussian and 1.5 for a pure sine: this material is a series of impulses, which '
            + 'is what atmospheric noise on the low bands is. A crash train carries periodicity '
            + 'of its own, so check that this rate belongs to the emission and not to the '
            + 'static before quoting it.'
          : null,
        // Where in the searched span the line sits, and a warning when it sits
        // at the bottom of it. This is where a line has to be told apart from
        // the pedestal it stands on rather than from a flat floor, and it is
        // where every false accept measured on noise lived: over 750 noise-only
        // inputs across five colours, all 85 that were given a rate sat within
        // 8 bins of the lowest searched bin. See SYMBOL_FLOOR_GUARD_BINS.
        binsAboveSlowestSearched: fundamental - first,
        atBottomOfSearchedSpan: fundamental < 2 * first,
        bottomOfSpanNote: fundamental < 2 * first
          ? 'this line sits within an octave of ' + (first * alphaStep).toFixed(2) + ' Bd, the '
            + 'slowest rate searched, where the transition spectrum is a falling pedestal rather '
            + 'than a flat floor and a line has to be told apart from the shoulder it stands on. '
            + 'Search from a higher minBaud, or over a narrower band, before quoting a rate here.'
          : null,
        halves,
        halfSpreadBd: halfSpread,
        // A rate the module itself knows is contradicted between channels
        // cannot be 'strong', however tall its line is. Harmonic count and
        // peak-to-floor ratio measure how CLEAN a line is; they say nothing
        // about whether it belongs to the emission being measured. When the
        // channels peak at frequencies with no integer relation the band holds
        // more than one thing and the winner is whichever was loudest, so the
        // level is capped at 'marginal' — which is the level `designate` in
        // js/sigint/designator.js already carries forward as a warning.
        level: disagreeing ? 'marginal'
          : harmonics >= 2 && w.ratio >= 2 * SYMBOL_MIN_RATIO ? 'strong'
            : harmonics >= 1 ? 'good' : 'marginal',
        levelCappedByChannelDisagreement: disagreeing,
        // A single line with no harmonics is NOT evidence of keying. An AM
        // carrier modulated by a 400 Hz sine puts one clean line at 400 Hz in
        // exactly this spectrum (measured: 400.00 at 32x, no harmonics) and it
        // is a modulating tone, not a symbol clock. Square keying rings at 2x
        // and 3x; a sinusoid does not. This is the difference, and it cannot be
        // decided from the rate alone.
        analogueToneIndistinguishable: harmonics === 0,
        caution: harmonics === 0
          ? 'no harmonic support: a single line is equally consistent with an analogue '
            + 'modulating tone as with a symbol clock, and this number should not be used as a '
            + 'baud rate without a classification from elsewhere'
          : null,
      },
      channel: w.channel,
      alphaStep,
      searchedHz: searched,
      channels: summary,
    });
}

/**
 * Everything, on one region.
 *
 * `region` takes {startSec, endSec, lowHz, highHz, expectedHz, fftSize,
 * minBaud, maxBaud, floorPercentile}. `expectedHz` is the frequency the
 * operator believes the emission to be on; without it the carrier offset is not
 * a number that can be computed, and it comes back null rather than as an
 * offset from something arbitrary.
 */
export function measure(mono, sampleRate, region = {}) {
  const rate = Number(sampleRate);
  const spec = spectrogram(mono, rate, region);
  if (!spec) return { ok: false, reason: 'the region is shorter than four analysis frames' };
  const band = bandIndices(spec, region.lowHz, region.highHz);
  if (band.hi <= band.lo + 2) {
    return { ok: false, reason: 'the requested band spans fewer than three analysis bins' };
  }

  // Two passes. The spectral half of the floor is blind only to signals
  // narrower than half its window, and the window that is right depends on the
  // bandwidth, which is not known until the floor is. So: a default window, a
  // provisional bandwidth, then a window sized to it.
  let stats = binStats(spec, region);
  let bw = bandwidths(spec, stats, band, region);
  if (!bw.failed && region.floorWindowHz == null) {
    const want = Math.min(rate / 3, Math.max(FLOOR_WINDOW_HZ, 4 * bw.xdb.value));
    if (Math.abs(want - stats.windowHz) > 0.25 * stats.windowHz) {
      stats = binStats(spec, Object.assign({}, region, { floorWindowHz: want }));
      bw = bandwidths(spec, stats, band, region);
    }
  }
  if (bw.failed) {
    return {
      ok: false, reason: bw.failed,
      analysis: analysisOf(spec, stats, band),
      noiseFloor: noiseFloorOf(spec, stats, band, floorExcessOf(spec, stats, band)),
    };
  }

  // How far the in-band floor sits above the quietest part of the recording.
  const bandFloorExcessDb = floorExcessOf(spec, stats, band);
  const binHz = spec.binHz;
  const peakK = bw.peakIndex;
  const dbAt = (i) => 10 * Math.log10(Math.max(stats.mean[i] - stats.floor[i], 1e-300));
  const centreHz = (peakK + parabolic(dbAt, peakK, band.lo, band.hi)) * binHz;

  // Signal and noise are integrated over the SAME bins, so the raw-|X|^2 scale
  // cancels and the ratio is exact whatever the recording's absolute level.
  const skirtLo = Math.max(band.lo, Math.floor(bw.xdb.lowHz / binHz));
  const skirtHi = Math.min(band.hi, Math.ceil(bw.xdb.highHz / binHz));
  let sigP = 0, noiP = 0;
  for (let k = skirtLo; k <= skirtHi; k++) {
    sigP += Math.max(0, stats.mean[k] - stats.floor[k]);
    noiP += stats.floor[k];
  }
  const snrDb = noiP > 0 ? 10 * Math.log10(Math.max(sigP, 1e-300) / noiP) : null;
  // Independent bins in the integration: the resolution width is wider than the
  // bin spacing, so neighbouring bins are correlated and counting all of them
  // would overstate how much the integration has averaged away.
  const indep = Math.max(1, (skirtHi - skirtLo + 1) * binHz / spec.enbwHz);
  // The spectral half of the floor is a median over `windowBins`; a signal
  // wider than half that window is inside its own floor estimate, and every
  // ratio taken against that floor is then a lower bound.
  const floorContaminated = bw.xdb.value > 0.5 * stats.windowHz;
  // The floor sits in BOTH halves of this ratio — it is subtracted from the
  // numerator and is the whole denominator — so its systematic does not cancel
  // and cannot be left out. Propagated numerically by moving the floor the
  // measured 0.3 dB each way and taking half the spread. Without this the
  // reported uncertainty on a real HF recording came out at 0.02 dB, which is
  // not a number anyone should have believed.
  const snrAtFloorScale = (g) => {
    let sp = 0, np = 0;
    for (let k = skirtLo; k <= skirtHi; k++) {
      sp += Math.max(0, stats.mean[k] - stats.floor[k] * g);
      np += stats.floor[k] * g;
    }
    return np > 0 ? 10 * Math.log10(Math.max(sp, 1e-300) / np) : null;
  };
  const g = Math.pow(10, FLOOR_SYSTEMATIC_DB / 10);
  const hiSnr = snrAtFloorScale(1 / g), loSnr = snrAtFloorScale(g);
  const floorSystematicDb = hiSnr == null || loSnr == null ? FLOOR_SYSTEMATIC_DB
    : Math.abs(hiSnr - loSnr) / 2;
  // The floor is subtracted from the numerator and IS the denominator, so a
  // floor that reads X dB high drags the SNR about X dB low. The band-excess
  // term therefore enters here at the same size it enters the floor.
  const snrSdDb = Math.hypot(
    10 * Math.log10(1 + stats.relSd / Math.sqrt(indep)),
    floorSystematicDb,
    FLOOR_EXCESS_COVERAGE * bandFloorExcessDb,
  );
  const drift = driftFit(spec, stats, band, region);
  let centreSe = null;
  if (drift.peakTrackHz && drift.peakTrackHz.length >= 4) {
    const arr = drift.peakTrackHz;
    let m = 0;
    for (let i = 0; i < arr.length; i++) m += arr[i];
    m /= arr.length;
    let v = 0;
    for (let i = 0; i < arr.length; i++) v += (arr[i] - m) * (arr[i] - m);
    centreSe = Math.sqrt(v / (arr.length - 1)) / Math.sqrt(arr.length);
  }
  const centreUnc = Math.hypot(PARABOLIC_BIAS_BINS * binHz, centreSe == null ? binHz / 2 : centreSe);

  const skirtWidth = Math.max(bw.xdb.value, 2 * binHz);
  const padded = {
    lowHz: Math.max(0, bw.xdb.lowHz - skirtWidth),
    highHz: Math.min(rate / 2, bw.xdb.highHz + skirtWidth),
  };

  // The detection gate, and it comes BEFORE anything is derived from the band.
  //
  // The first question in the workflow is whether there is anything here at
  // all. 10 dB in one resolution cell is about where an operator stops calling
  // it a lump in the noise.
  //
  // This used to sit at the bottom of the function, after the symbol rate and
  // the FSK shift had already been computed and returned. It meant the object
  // could report `present: false` and, in the same breath, a symbol rate with
  // a confidence of 'strong'. Measured on three seconds of constant DC at 8
  // kHz: peak-to-floor 6.0 dB, `present: false`, and `symbolRate` = 4.509 Bd
  // +/- 0.122 at level 'strong'. There is no symbol rate in a constant. A
  // reader who saw that number would have believed it, which is the whole
  // failure this file exists to avoid, so the derived quantities are now
  // withheld rather than computed. See `derivedQuantitiesAreWithheldWhenAbsent`.
  //
  // A single bin is the wrong test for an emission wider than the floor's own
  // window, because such an emission is inside its own floor estimate: on the
  // HM01 recording over the whole audio band the peak stood 9.0 dB above "its"
  // floor while the transition spectrum held a 120 Bd line at 29x with a full
  // comb. So a second statistic runs alongside, against a floor taken from the
  // bins of the band that lie OUTSIDE the emission's own skirt.
  //
  // That second statistic cannot rescue an empty region, which is the point of
  // it. An empty region has no skirt — the -x dB crossing never happens, so the
  // "emission" fills the whole band and there are no outside bins to take a
  // floor from. Measured: three seconds of constant DC and five seeds of white
  // noise all leave zero bins outside the skirt, so the wide test is not
  // available and the verdict stands at absent. An earlier version of this gate
  // simply trusted `floorMayBeContaminated` instead, which is true for every
  // one of those inputs and let all of them through.
  //
  // Two conditions, and the second is what keeps a DC offset out. The skirt
  // must close on BOTH sides strictly inside the analysed band — an emission,
  // not a slope running off the edge — and enough of the band must be left
  // outside it to take a floor from. Measured on three seconds of constant DC:
  // the peak is the Hann leakage in the lowest admitted bin, the skirt starts
  // at the band edge, and the wide statistic reads 9.2 dB, which is close
  // enough to the 10 dB bar to be luck rather than a decision. With the
  // closure requirement the statistic is not offered at all.
  const bandBins = band.hi - band.lo + 1;
  const skirtClosed = skirtLo > band.lo && skirtHi < band.hi;
  const outside = [];
  if (skirtClosed) {
    for (let k = band.lo; k <= band.hi; k++) {
      if (k < skirtLo || k > skirtHi) outside.push(stats.floor[k]);
    }
  }
  let wideSnrDb = null;
  if (outside.length >= Math.max(8, 0.2 * bandBins)) {
    const outFloor = median(outside);
    if (outFloor > 0) {
      wideSnrDb = 10 * Math.log10(
        Math.max(stats.mean[peakK] - outFloor, 1e-300) / outFloor,
      );
    }
  }
  const wideDetects = wideSnrDb != null && wideSnrDb >= DETECTION_MIN_SNR_DB;
  const present = bw.peakBinSnrDb >= DETECTION_MIN_SNR_DB || wideDetects;
  const derivable = present;
  const absentReason = 'the strongest bin in the band stands only '
    + bw.peakBinSnrDb.toFixed(1) + ' dB above its own noise floor, below the '
    + DETECTION_MIN_SNR_DB + ' dB detection bar, so this region has been judged to hold no '
    + 'emission and nothing has been derived from it. A number here would be a description of '
    + 'the noise, not of a signal';
  const withheldExtra = {
    withheldOnDetection: true,
    peakBinSnrDb: bw.peakBinSnrDb,
    detectionThresholdDb: DETECTION_MIN_SNR_DB,
  };
  let shift, baud;
  if (!derivable) {
    shift = unmeasured('Hz', absentReason, Object.assign({}, withheldExtra));
    baud = unmeasured('Bd', absentReason, Object.assign({}, withheldExtra));
  } else {
    const z = bandAnalytic(mono, rate, spec.from, spec.to, padded.lowHz, padded.highHz);
    shift = fskShift(mono, rate, { from: spec.from, to: spec.to, ...padded }, z);
    baud = symbolRate(mono, rate, {
      from: spec.from, to: spec.to, ...padded,
      emissionBandwidthHz: bw.xdb.value,
      minBaud: region.minBaud, maxBaud: region.maxBaud,
    }, z);
    if (bw.peakBinSnrDb < DETECTION_MIN_SNR_DB) {
      const caveat = 'the strongest single bin stands only ' + bw.peakBinSnrDb.toFixed(1)
        + ' dB above its own floor; this region was called occupied on the wide-emission test '
        + 'instead (' + wideSnrDb.toFixed(1) + ' dB above a floor taken from the '
        + outside.length + ' bins outside the emission skirt), because the emission is wider '
        + 'than half the ' + stats.windowHz.toFixed(0) + ' Hz window the spectral floor is a '
        + 'median over and is therefore partly inside its own floor estimate';
      shift.detectedOnWideEmissionTest = true;
      shift.detectionCaveat = caveat;
      baud.detectedOnWideEmissionTest = true;
      baud.detectionCaveat = caveat;
    }
  }

  const expected = region.expectedHz == null ? null : Number(region.expectedHz);
  const out = {
    ok: true,
    detection: {
      present,
      peakBinSnrDb: bw.peakBinSnrDb,
      thresholdDb: DETECTION_MIN_SNR_DB,
      // The wide-emission statistic: the peak against a floor taken from the
      // bins outside the emission's own skirt. null when the emission fills
      // the band, which is what an empty region looks like.
      peakOutOfSkirtSnrDb: wideSnrDb,
      binsOutsideSkirt: outside.length,
      skirtClosedInsideBand: skirtClosed,
      detectedOnWideEmissionTest: wideDetects && bw.peakBinSnrDb < DETECTION_MIN_SNR_DB,
      // What was NOT computed because of the verdict above.
      derivedQuantitiesWithheld: !derivable,
      withheld: derivable ? [] : ['symbolRate', 'fskShift'],
      // A single bin is the wrong test for a wide emission. Measured on the
      // HM01 recording over the whole audio band: peak-to-floor 9.0 dB, so
      // "absent", while the transition spectrum held a 120 Bd line at 29x with
      // a full comb. The emission was wider than the floor's own window, so it
      // was inside its own floor estimate. That case is flagged rather than
      // resolved, because widening the window would break the opposite case.
      floorMayBeContaminated: floorContaminated,
      reason: (present
        ? 'the strongest bin stands ' + bw.peakBinSnrDb.toFixed(1) + ' dB above its own noise floor'
        : 'the strongest bin stands only ' + bw.peakBinSnrDb.toFixed(1) + ' dB above its own '
          + 'noise floor; on a NARROWBAND emission that means there is nothing here')
        + (floorContaminated
          ? '. But the emission is wider than half the ' + stats.windowHz.toFixed(0) + ' Hz '
            + 'window the spectral floor is a median over, so it is partly inside its own floor '
            + 'estimate and this verdict is unreliable in the "absent" direction — narrow the '
            + 'region to one emission and measure again'
          : ''),
    },
    analysis: analysisOf(spec, stats, band),
    noiseFloor: noiseFloorOf(spec, stats, band, bandFloorExcessDb),
    snr: snrDb == null
      ? unmeasured('dB', 'the integrated noise power in the band is not positive')
      : q(snrDb, 'dB', snrSdDb,
        'ratio of noise-subtracted power to floor power, both integrated over the x-dB skirt ('
        + bw.xdb.lowHz.toFixed(1) + ' to ' + bw.xdb.highHz.toFixed(1) + ' Hz); uncertainty is '
        + 'the floor quantile sampling error reduced by the ' + indep.toFixed(1)
        + ' independent bins integrated, in quadrature with '
        + floorSystematicDb.toFixed(2) + ' dB from moving the noise floor by its own '
        + FLOOR_SYSTEMATIC_DB + ' dB systematic',
        {
          inBandwidthHz: bw.xdb.value, independentBins: indep,
          floorSystematicDb,
          floorMayBeContaminated: floorContaminated,
          caution: floorContaminated
            ? 'the emission is wider than half the ' + stats.windowHz.toFixed(0) + ' Hz window '
              + 'the spectral floor is a median over, so part of the signal is inside its own '
              + 'floor estimate and this SNR is a lower bound'
            : null,
        }),
    centre: q(centreHz, 'Hz', centreUnc,
      'parabolic interpolation on the log magnitude of the noise-subtracted mean spectrum; '
      + 'uncertainty is the ' + PARABOLIC_BIAS_BINS + '-bin interpolation bias (measured over a '
      + 'swept sub-bin offset) in quadrature with the standard error of the per-frame peak',
      {
        binHz, interpolationBiasHz: PARABOLIC_BIAS_BINS * binHz, frameScatterSeHz: centreSe,
        // For a two-tone emission the spectral peak is one of the tones, not
        // the middle of the emission. The midpoint is the number a log wants.
        emissionCentreHz: shift.value == null ? null : (shift.lowerHz + shift.upperHz) / 2,
        note: shift.value == null ? null
          : 'this is the stronger of two FSK tones; `emissionCentreHz` is the midpoint',
      }),
    carrierOffset: expected == null
      ? unmeasured('Hz', 'no expected frequency was declared, so there is nothing to offset from')
      : q(centreHz - expected, 'Hz', centreUnc,
        'measured centre minus the declared expected frequency of ' + expected + ' Hz',
        { expectedHz: expected }),
    bandwidth: {
      xdb: bw.xdb,
      occupied99: bw.occupied99,
      trustworthy: bw.trustworthy,
      reason: bw.trustReason,
      carrierFraction: bw.carrierFraction,
      peakBinSnrDb: bw.peakBinSnrDb,
    },
    drift: drift.track,
    driftFrames: { used: drift.framesUsed, total: drift.framesTotal },
    symbolRate: baud,
    fskShift: shift,
  };

  // The quantities that cannot be withheld, because the detection is computed
  // FROM them, still have to say what the verdict was. A bandwidth, a centre
  // frequency and an SNR are all defined relative to an emission; on a region
  // called empty they are the width, position and prominence of a noise
  // excursion. Measured on three seconds of white noise: an x-dB bandwidth of
  // 3954 Hz with a stated uncertainty, a centre frequency, and an SNR. None of
  // those is withheld — a reader debugging a missed detection needs to see
  // them — but each now carries the verdict with it, so the number cannot be
  // lifted out of the object and quoted without it.
  if (!present) {
    for (const qty of [out.snr, out.centre, out.carrierOffset, out.drift,
      out.bandwidth.xdb, out.bandwidth.occupied99]) {
      if (!qty || qty.value == null) continue;
      qty.measuredOnAnAbsentDetection = true;
      qty.detectionCaveat = absentReason;
    }
  }
  return out;
}

function analysisOf(spec, stats, band) {
  return {
    startSec: spec.startSec, seconds: spec.seconds,
    fftSize: spec.fftSize, frames: spec.frames, hop: spec.hop,
    binHz: spec.binHz, enbwHz: spec.enbwHz,
    bandHz: [band.lo * spec.binHz, band.hi * spec.binHz],
    floorPercentile: stats.percentile,
    floorFrames: stats.floorFrames,
    floorWindowHz: stats.windowHz,
  };
}

/**
 * The in-band floor against the quietest part of the whole recording, in dB.
 *
 * Like for like — the same across-bin percentile on both sides — so a clean
 * band reads 0.00 and only a band that is genuinely louder than the rest of
 * the spectrum reads anything. Returns 0 when the band IS the spectrum, which
 * is exactly the case this cannot see; see FLOOR_EXCESS_COVERAGE.
 */
function floorExcessOf(spec, stats, band) {
  const inBand = [], all = [];
  for (let k = 2; k < spec.bins - 1; k++) {
    all.push(stats.floor[k]);
    if (k >= band.lo && k <= band.hi) inBand.push(stats.floor[k]);
  }
  if (inBand.length < 8 || all.length - inBand.length < 8) return 0;
  const p = (arr) => quantileSorted(Float64Array.from(arr).sort(), 0.10);
  const a = p(inBand), b = p(all);
  if (!(a > 0) || !(b > 0)) return 0;
  return Math.max(0, 10 * Math.log10(a / b));
}

function noiseFloorOf(spec, stats, band, bandFloorExcessDb = 0) {
  // Median over the band of the per-bin floor, converted to a power density and
  // referenced to a full-scale sine (whose mean power is 0.5). A recording of
  // unknown absolute gain makes this a relative number, which is why it is
  // labelled dBFS and not dBm.
  const vals = [];
  for (let k = band.lo; k <= band.hi; k++) vals.push(stats.floor[k]);
  const med = median(vals);
  const psd = med * spec.ampScale / spec.enbwHz;
  const unc = Math.hypot(stats.floorSdDb, FLOOR_EXCESS_COVERAGE * bandFloorExcessDb);
  return q(10 * Math.log10(psd / 0.5), 'dBFS/Hz', unc,
    'the smaller of two estimates per bin — the ' + (100 * stats.percentile).toFixed(0)
    + 'th percentile of the frame powers, debiased by dividing by '
    + floorDebias(stats.percentile).toFixed(4) + ' (the exponential quantile-to-mean factor), '
    + 'and a ' + stats.windowHz.toFixed(0) + ' Hz running median of that across frequency — '
    + 'then divided by the ' + spec.enbwHz.toFixed(2) + ' Hz equivalent noise bandwidth of one '
    + 'bin and referenced to a full-scale sine. Uncertainty is the quantile sampling SD over '
    + stats.floorFrames + ' disjoint frames, in quadrature with the measured '
    + FLOOR_SYSTEMATIC_DB + ' dB systematic of taking a minimum of two estimators and '
    + (FLOOR_EXCESS_COVERAGE * bandFloorExcessDb).toFixed(2) + ' dB for how far this band\'s '
    + 'floor sits above the quietest part of the recording',
    {
      perBinDbfs: 10 * Math.log10(med * spec.ampScale / 0.5),
      bandFloorExcessDb,
      bandIsOccupied: bandFloorExcessDb > 1,
      occupiedBandNote: bandFloorExcessDb > 1
        ? 'the 10th percentile of this band\'s per-bin floor sits ' + bandFloorExcessDb.toFixed(1)
          + ' dB above the same percentile over the whole recording, which means the emission '
          + 'is in the floor estimate and this number is an UPPER BOUND on the noise, not a '
          + 'measurement of it. Measure the floor on a quiet slice of the band instead'
        : null,
      binHz: spec.binHz,
      relativeSd: stats.relSd,
      windowHz: stats.windowHz,
      percentileWhy: 'a low percentile over time, not a mean and not a median: the mean is '
        + 'dragged up by the signal it is meant to exclude, and a median only survives a duty '
        + 'cycle below 50%, which an idling teleprinter or a steady carrier is not. The '
        + 'running median across frequency is the second half, because no percentile over TIME '
        + 'can see past a carrier that never goes away',
    });
}
