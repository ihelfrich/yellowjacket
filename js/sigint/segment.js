// "Where in this recording is there anything?" — a time-frequency detector for
// the SIGINT band of the bench.
//
// What it looks at is the AUDIO a receiver already produced. The shelf holds
// recordings of open shortwave broadcasts made by hobbyists and agencies; the
// RF modulation was stripped by whoever's receiver made the recording, so the
// frequencies below are audio-band frequencies, not the dial. Nothing here
// intercepts or unprotects anything — it measures what the recording contains.
//
// The whole module is built around one refusal. Otsu's method, k-means, and
// every other "split the histogram" rule return a split for any input, and a
// window that is pure noise between two transmissions is exactly the input
// they are worst on: they will halve the noise and hand back a detection. So
// the threshold here is not learned from the data at all. It comes from the
// null distribution, which for a periodogram is known in closed form: the
// power in an STFT cell of Gaussian noise, divided by the local mean, is
// Exp(1) exactly. Everything downstream — the seed threshold, the presence
// test, the per-detection false-alarm bound — is that one fact, applied.
//
// FOUR BACKGROUNDS, NOT ONE. That refusal held for white Gaussian noise and
// for nothing else, which is the one background no HF recording has. Measured
// over 100 windows of 20 s each, per background, before the work in this file
// and after it:
//
//                                       before          after
//   white                               0 detections    0
//   1/f                                 1 per window    0
//   white under a 0.4 Hz fade          11-15 per window 0
//   white with atmospheric crashes     10-13 per window 0
//
// The four failures were four different bugs, and each one is written up where
// it was fixed: a running median whose window was truncated at the band edge
// (runningMedian), a per-bin median taken over a level that was moving
// (noiseFloor and frameGain), a fade bridge that manufactured duration out of
// isolated crashes (bridgeTime), a minimum duration shorter than the analysis
// window itself (segment), and a component built entirely out of frames when
// the whole band jumped at once (FLASH_SHARE).
//
// WHAT IT STILL CANNOT DO, stated because a bench that hides this is worse
// than no bench. A continuous noise-like emitter wider than the 65-bin
// smoothing window becomes the floor it would have to stand above, and over
// one window that is genuinely indistinguishable from a change in the
// background over the same stretch of spectrum. It is not measured; it is
// reported, by standingBands(), with the size of the step and a plain
// statement that the module cannot say which it is. Above about 80% of the
// spectrum even that stops working, and the honest reading is then that the
// whole analysed band moved.
//
// The bench never hands over an hour: js/dsp/window-load.js offers 120, 300 or
// 600 seconds, and this works inside one of those. Measured cost on this
// machine (Apple silicon, node 24, mono, the defaults below): 1.06, 1.30 and
// 1.28 ms per window second at 8 kHz for those three spans, so the longest
// window costs 0.77 s. The floor is estimated twice — once roughly, to see the
// frame gain through, then again on gain-normalised power — which is most of
// why that is about twice what a single-pass floor cost. At 44.1 kHz it is
// 7.0 ms per window second, the FFT being eight times longer for the same
// 20 Hz bins, until the 8 M-cell cap starts decimating frames.
//
// Measured sensitivity, as the tone's own bin power over the background's
// power per bin, at the amplitude where a tone in white noise is found in half
// of twelve seeds (8 kHz, 15.6 Hz bins, defaults, tone on a bin centre):
//
//     0.3 s burst   +4 dB      2 s burst      -1 dB
//     1 s burst     +2 dB      5 s burst      -6 dB
//                              30 s carrier  -14 dB
//
// The last row is the reason there are two presence statistics rather than
// one. Nothing in a -14 dB carrier's window lights a single cell; it is found
// only by averaging its own bin over every frame. The first row is close to
// the floor of what the module will report at all: the analysis window is
// 64 ms long at these settings and nothing shorter than minDurationSec plus
// that window can be bounded, so the shortest reportable event at the defaults
// is 0.26 s rather than the 0.15 s minDurationSec asks for.

import { FFT, hann, nextPow2 } from '../fft.js';

// A 20 Hz bin resolves a keyed carrier's line and still leaves 31 frames per
// second at 50% overlap, which is enough time resolution to bound a Morse
// character but deliberately not enough to resolve one dit. Bounding is this
// module's job; timing is the decoder's.
export const DEFAULT_BIN_HZ = 20;
export const DEFAULT_OVERLAP = 0.5;
export const DEFAULT_MIN_DURATION_SEC = 0.15;
export const DEFAULT_BRIDGE_SEC = 0.3;
export const DEFAULT_MIN_HZ = 50;

// Family-wise false-alarm rate for the presence test, and the expected number
// of cells above the seed threshold under the null. One expected false cell
// per window is the point of the seed threshold: it makes a single hot cell
// unremarkable and a cluster of them impossible.
export const DEFAULT_ALPHA = 1e-3;
export const EXPECTED_FALSE_CELLS = 1;
// Per-cell rate for the grow mask of the hysteresis. 1% of cells pass on pure
// noise; at that density an 8-connected random field is far below its site
// percolation threshold (~0.407), so the clusters it makes are one to three
// cells and die on the minimum duration.
export const GROW_CELL_RATE = 0.01;

// The per-bin floor is a median over time, so it survives a signal that is on
// for up to half the window in that bin. The cross-frequency floor is a
// running median over 65 bins, so it survives a signal narrower than about
// half of 65 bins. A signal that is BOTH continuous and wider than that is
// indistinguishable from a change in the noise floor, which is what
// standingBands() reports and `floorSuspect` in the result summarises.
export const FLOOR_SMOOTH_BINS = 65;
const MEDIAN_OF_EXP1 = Math.LN2;               // the median of Exp(1) is ln 2

// How long the background level is allowed to take to move: the width of the
// median in time that frameGain() runs over. It has to be short enough to
// follow a fade and long enough that a pulse train's own gaps are a minority
// of it. Measured on white noise under a 0.4 Hz fade of 0.95 depth, 20 seeds,
// as the mean normalised cell power (which must be 1) and the number of
// windows the presence test fired on (which must be none, since nothing is
// transmitting), against a 50 Hz pulse train at 15% duty:
//
//   1.00 s   mean 1.1246   fired on 20 of 20   train kept
//   0.50 s   mean 1.0324   fired on  4 of 20   train kept
//   0.25 s   mean 1.0015   fired on  0 of 20   train kept
//   0.12 s   mean 0.9989   fired on  0 of 20   train kept
//
// A three percent error in the floor is a three percent error at the MEAN and
// a factor of three at the tail the seed threshold lives in, which is why 0.5
// still fired on a fifth of the seeds while looking almost right. Below 0.25
// nothing further is bought. The cost is stated in frameGain(): a genuinely
// band-wide emitter that stays on for much longer than this is absorbed into
// the background, and that is the case the full-band guard reports.
export const DEFAULT_GAIN_SEC = 0.25;
// Above this 10th-to-90th spread in the frame gain the background is moving
// enough to be worth saying so, and to cap what any level taken against it can
// claim. Measured on white Gaussian noise the spread is 0.5-0.8 dB; on white
// noise under a 0.4 Hz fade of 0.95 depth it is 15 dB.
export const NONSTATIONARY_DB = 3;
// A step in the floor this large over a few bins is not a background. Measured
// step sizes over a 4-bin boundary: 1/f noise 5.1 dB at its steepest (the low
// edge of the analysed band) and 0.2 dB in mid band; a band-limited emitter
// 35 dB up steps 28-34 dB at each of its two edges.
export const STANDING_STEP_DB = 12;
// A detection wider than this fraction of the analysed band is not bounded in
// frequency by anything the module measured — it reaches both ends of what was
// looked at — so the background moving explains it as well as an emitter does.
export const FULL_BAND_FRACTION = 0.8;
// Contiguous time blocks a component's level is measured in separately, to get
// an error bar on snrDb that does not assume the cells are independent.
export const SNR_BLOCKS = 8;
// Blocks in FREQUENCY, kept at one. Splitting a component across its own band
// as well as its own time was tried and is wrong: a component's level really
// does vary from its centre bin to its edge bins, so the spread across
// frequency blocks measures the shape of the signal rather than the error in
// measuring it. Measured, the same split-half check as below: with four
// frequency blocks the bar came out ten to fifteen times too wide, median |z|
// 0.07 against the 1.0 a correct bar gives.
export const SNR_FREQ_BLOCKS = 1;
// How much the blocked standard error has to be widened to survive its own
// split-half test, and this number is measured rather than derived. Blocks
// inside one component see the variability inside that component; they cannot
// see the part that is common to all of them — the mask boundary, which cells
// were selected by a threshold on the very quantity being averaged, and the
// floor estimate itself. Split-half check on WHITE noise, a continuous 1500 Hz
// tone measured separately in the first and second half of the window,
// 12/24/48 s windows at four levels, 36 seeds each (432 pairs):
//
//   inflation 1.0   median |z| 1.16   95th 3.44   coverage at 2 SE  74.3%
//   inflation 1.6   median |z| 0.73   95th 2.15   coverage at 2 SE  93.1%
//   inflation 2.0   median |z| 0.58   95th 1.72   coverage at 2 SE  97.9%
//   inflation 2.5   median |z| 0.46   95th 1.38   coverage at 2 SE  99.8%
//
// That table is the reason this constant was 2, and it is the reason the bar
// then failed on the first background that was not white. Repeated on 1/f
// noise, 24 s windows at four amplitudes, 24 seeds each, at inflation 2:
// coverage of 63%, 54%, 58%, 58% against the 90% claimed, with a median |z|
// near 1.85 at every amplitude — the bar half the size it needed to be, and
// not a bias.
//
// WHERE THE MISSING VARIANCE IS, measured rather than guessed. The tone is
// deterministic and identical in both halves, so all of the disagreement is in
// the floor. The half-to-half standard deviation of snrDb at amplitude 0.15 is
// 0.079 dB on white and 0.283 dB on 1/f, against a bar of 0.108 dB in both.
// The floor at a bin is a running median over 65 neighbours, and the values in
// that window are spread by the background's own tilt as well as by their
// error: a wider spread is a lower density at the median, and the median of a
// tilted set has a correspondingly larger variance. So the floor's error, the
// one part of this that no arrangement of blocks INSIDE the component can see,
// is a function of the background's colour.
//
// Two things were tried and one of them works. Batch means at increasing batch
// size — the standard answer for a level that drifts on the window's own
// timescale, and 1/f drifts on every timescale — moved 1/f's 95th percentile
// from 4.38 to 3.71 and its coverage from 58% to 63%. It is not in the code,
// because it did not fix this and a guard that does not earn its place is a
// guard that rots. What is left is to widen, measured on 1/f at four
// amplitudes over 24 seeds:
//
//   inflation 3.2   coverage at 2 SE  88%, 83%, 83%, 83%
//   inflation 3.8   coverage at 2 SE  96%, 96%, 96%, 88%
//   inflation 4.4   coverage at 2 SE  96%, 96%, 96%, 96%
//
// THE COST, stated because it is real and it is paid on every reading. On
// white noise the bar is now about three times the half-to-half standard
// deviation it is estimating rather than 1.4 times it, so a level a reader
// could have been given to a tenth of a decibel is reported to three tenths.
// An uncertainty that is too wide is the safe direction and it is still a
// wrong number; if a later version can measure the floor's own error directly
// — the residual scatter about the smoothed floor after the tilt is taken out
// — this should come back down.
export const SNR_SE_INFLATION = 4.4;
// How many times a gap has to recur at the same length before the fade bridge
// will treat it as a duty cycle rather than as a boundary between two events.
// Two means three matching gaps in a row. Measured over 90 windows of white
// noise carrying atmospheric-style crashes (40 crashes at 30x, 12 at 20x and
// 80 at 15x, thirty seeds each): at 1 the bridge still manufactured 8
// detections, at 2 it manufactured none, and a 50 Hz and a 25 Hz pulse train
// survive at 2, 3 and 4 alike. See bridgeTime().
export const REGULAR_GAPS = 2;
// A bin standing this far over its own floor TIMES THE BAND'S OWN LEVEL AT
// THAT MOMENT is hot. Under the module's null that ratio is Exp(1), so a bin
// is hot with probability exp(-3) = 4.98% and the count of hot bins in a frame
// is Binomial at that rate.
//
// The denominator is the frame gain and not the window's median level, and
// that is the whole of the difference between this guard and the one it
// replaces. A carrier under a 0.4 Hz fade of 0.95 depth sees its band rise
// 3.8x in power at the peak of every fade, which cleared a fixed 3x ratio
// against the window median: measured, the old guard deleted a real 1500 Hz
// carrier at amplitude 0.30 in 5 of 24 fading seeds. The frame gain is a
// running median over 0.25 s, so it follows a 2.5 s fade and does not follow a
// 2 ms crash, which is exactly the distinction being asked for.
export const FLASH_RATIO = 3;
// The share of the bins OUTSIDE a component that have to be hot at once before
// that frame is a broadband event rather than an emission.
//
// Under the null the hot rate is 4.98% and the count is Binomial, so with 252
// bins the standard deviation of the share is 1.37% and this cut is fifteen of
// them. It is not set from that arithmetic, though, because the bins are not
// independent — the Hann main lobe spans three of them — and the measured tail
// is wider than Binomial says: over 7,488 frames each, the largest share any
// frame of white noise reached is 0.123 and of 1/f noise 0.163. It is set from
// the two measured distributions it has to sit between. On the other side, a
// real 1500 Hz carrier at amplitude 0.30 under a 0.4 Hz 0.95-depth fade — the
// signal the guard this replaces was deleting — reaches 0.159 across 12 seeds.
// So 0.25 clears the widest background by 1.5x and the signal it must not
// delete by 1.6x, and the crash frames of impulsive noise reach 0.94.
export const FLASH_BIN_SHARE = 0.25;
// Bins either side of a component excluded from that count as well, so a
// strong emitter's own window leakage is not read as the band jumping.
export const FLASH_GUARD_BINS = 3;
// Fewest outside bins that can carry the question. Below this the component
// covers so much of the analysed band that there is nothing left to ask about,
// and FULL_BAND_FRACTION's confidence cap is what remains.
export const FLASH_MIN_OUTSIDE_BINS = 20;
// The share of a component's cells that may sit in such frames before the
// component is a broadband event rather than an emission. Measured over 100
// windows of white noise carrying 40 crashes of 2 ms at thirty times the noise
// RMS, with every other guard in this file already in place: two components
// survived everything else, and they carried 0.453 and 0.647 of their cells in
// flash frames. Real tone bursts in the SAME crash-ridden background carried
// 0.000 at 0.4 s and amplitude 0.4, 0.000 at 0.8 s and 0.25, 0.126 at 2 s and
// 0.15, and 0.069 at 5 s and 0.08 — the crashes land inside a long detection's
// span too, which is why the cut is not tighter than this.
export const FLASH_SHARE = 0.25;
// And how many times the window's own rate of broadband frames that share has
// to be. A component whose cells sit in flash frames at the rate at which
// flash frames simply occur is not evidence of anything; one whose cells are
// concentrated there is.
//
// Measured over 20 windows of the crash-ridden background, at 1.25, 1.5 and 2:
// 139, 162 and 211 false components survive. Against that, a real 0.4 s tone
// at amplitude 0.4 in the same background survives as its own narrow component
// in 9, 9 and 9 of 12 seeds when the crashes are broadband clicks, and in 3, 3
// and 4 of 12 when they are damped rings — so one of twelve narrow bursts is
// lost between 2 and 1.5, and at 1.25 real bursts start going in numbers (the
// same bursts read share/base as high as 4.4 when a crash lands inside their
// own span). 1.5 is where that trade sits: measured over 30 windows of 20 s
// against the guard it replaces, it is better on both colours that guard was
// failing — 241 false components against 292 on crashes, 296 against 428 on a
// gated background, and on the gated one the number claiming more than 0.5
// confidence falls from 147 to 15 — and the burst it costs is still FOUND in
// all 12 seeds, as part of a wider detection rather than as its own.
export const FLASH_EXCESS = 1.5;
// Ceilings on what a detection may claim while a named alternative explanation
// is still live. These are bounds on a confidence, not probabilities of their
// own: the reported confidence is the smallest of the false-alarm confidence
// and whichever of these apply, and each one that binds is named in
// `confidenceNotes` so the reader can disagree with it.
export const CONFIDENCE_CAP_FULL_BAND = 0.3;
export const CONFIDENCE_CAP_FLOOR_FROM_NEIGHBOURS = 0.7;
export const CONFIDENCE_CAP_NONSTATIONARY = 0.8;
export const CONFIDENCE_CAP_DECIMATED = 0.9;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const finite = (n, fb = 0) => (Number.isFinite(n) ? n : fb);

/* ------------------------------------------------------------------ *
 * Null-distribution arithmetic. No fitted parameters live in here.
 * ------------------------------------------------------------------ */

/**
 * Smallest k with P(K >= k) <= alpha for K ~ Poisson(lambda). This is the
 * critical value of the presence test's count statistic: the count of cells
 * standing above the seed threshold, which under the null is Poisson with the
 * mean the seed threshold was chosen to produce.
 */
export function poissonCritical(lambda, alpha = DEFAULT_ALPHA) {
  const lam = Math.max(1e-9, finite(lambda, 1));
  const a = clamp(finite(alpha, DEFAULT_ALPHA), 1e-12, 0.5);
  let term = Math.exp(-lam), cdf = term, k = 0;
  while (1 - cdf > a && k < 10000) { k += 1; term *= lam / k; cdf += term; }
  return k + 1;
}

/**
 * The Chernoff tail bound for a Gamma(k, 1) variate, in natural log:
 *   ln P(X >= s) <= -k * (r - 1 - ln r),  r = s / k >= 1.
 * An upper bound, never an estimate, which is the direction that matters when
 * the number it produces is going to be called a confidence. Returns 0 (i.e.
 * probability 1) when the sum is at or below its own mean.
 */
export function gammaTailLog(k, s) {
  const kk = Math.max(1e-9, finite(k));
  const r = finite(s) / kk;
  if (!(r > 1)) return 0;
  return -kk * (r - 1 - Math.log(r));
}

/**
 * Invert the bound above: the smallest x > 1 with k*(x - 1 - ln x) >= target.
 * Used to set the threshold for the mean of `k` averaged cells, which is how
 * a carrier too weak to light up any single cell is still detected. Bisection
 * rather than Newton because the function is flat at x = 1 and the bracket is
 * cheap to widen.
 */
export function gammaMeanThreshold(k, targetLog) {
  const kk = Math.max(1, finite(k, 1));
  const L = Math.max(0, finite(targetLog));
  if (L === 0) return 1;
  let hi = 2;
  while (kk * (hi - 1 - Math.log(hi)) < L && hi < 1e9) hi *= 2;
  let lo = 1;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (kk * (mid - 1 - Math.log(mid)) < L) lo = mid; else hi = mid;
  }
  return hi;
}

function medianOf(values, from = 0, to = values.length) {
  const n = to - from;
  if (n <= 0) return 0;
  const copy = Float64Array.prototype.slice.call(values, from, to).sort();
  const h = n >> 1;
  return n % 2 ? copy[h] : 0.5 * (copy[h - 1] + copy[h]);
}

/**
 * Running median across frequency, over a window that stays SYMMETRIC about
 * its centre and shrinks at the ends.
 *
 * The symmetry is the whole point and it was not there before. The median of a
 * monotone function over a symmetric index window is that function at the
 * window's centre, so a running median tracks any amount of spectral tilt for
 * free — but only while the window is symmetric. Truncating it at the array
 * edge (`max(0, i - half)`) breaks that, and the bias is enormous on a tilted
 * background: measured on 1/f noise at 8 kHz with 15.6 Hz bins, the truncated
 * window put bin 4's floor 6.5 dB under the truth, every cell in bins 4-27 was
 * then measured against a floor two thirds too low, and pure 1/f noise with no
 * emitter in it came back as one confident 20-second detection at 63-440 Hz on
 * four seeds out of four. With the window kept symmetric the same four seeds
 * return nothing.
 *
 * 512 bins by a 65-wide sort is under a millisecond, so the naive form is kept
 * for being obviously correct.
 */
function runningMedian(values, width) {
  const n = values.length, half = Math.max(1, width >> 1);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.min(half, i, n - 1 - i);
    out[i] = medianOf(values, i - k, i + k + 1);
  }
  return out;
}

/**
 * Excess kurtosis of the waveform, and its z against the Gaussian null
 * (Var(g2) = 24/n for n iid normal samples). This exists to catch the one
 * signal the rest of the module is blind to.
 *
 * Both floors here are medians, and a wideband emitter that is on in every
 * frame raises every bin's median together — it becomes the floor. Measured:
 * a 15%-duty pulse train at five times the noise RMS is invisible at the 64 ms
 * default frame (presence test says "consistent with noise alone") and is one
 * clean detection at 8 ms, because at 8 ms it is no longer on in every frame.
 * Kurtosis is computed on the samples and so has no frame length to be fooled
 * by: that same train reads an excess kurtosis of about 16 against a standard
 * error of 0.012.
 *
 * It is a warning and not a presence gate on purpose. Real HF noise is
 * impulsive — atmospheric crashes are kurtotic and are not a transmission — so
 * a high z means "re-run with a shorter frame before believing the silence",
 * not "something is here".
 */
export function impulsiveness(mono, { from = 0, to = 0, maxSamples = 400000 } = {}) {
  const end = to > from ? to : mono.length;
  const span = end - from;
  if (span < 64) return { excessKurtosis: 0, z: 0, samples: 0 };
  const stride = Math.max(1, Math.floor(span / maxSamples));
  let n = 0, mean = 0;
  for (let i = from; i < end; i += stride) { mean += mono[i]; n += 1; }
  mean /= n;
  let m2 = 0, m4 = 0;
  for (let i = from; i < end; i += stride) {
    const d = mono[i] - mean, d2 = d * d;
    m2 += d2; m4 += d2 * d2;
  }
  m2 /= n; m4 /= n;
  const g2 = m2 > 0 ? m4 / (m2 * m2) - 3 : 0;
  return { excessKurtosis: g2, z: g2 / Math.sqrt(24 / n), samples: n };
}

// Beyond this z the waveform is impulsive enough that a long frame may be
// hiding a pulsed emitter inside its own floor. Set at 10 rather than the
// Gaussian 3.09 because real shortwave noise is mildly impulsive on its own:
// measured on the quiet stretches of the shelf's HF captures, z runs 20-200,
// which is why this is a warning and never a detection.
export const IMPULSIVE_Z = 10;

/* ------------------------------------------------------------------ *
 * The spectrogram
 * ------------------------------------------------------------------ */

/**
 * Power spectrogram, Hann windowed, normalised so a unit-amplitude sine at a
 * bin centre reads 0.25 — the same convention as goertzel() in
 * js/dsp/analytic.js, so levels from the two are directly comparable.
 *
 * f32 twiddles: this path only ever forms ratios of powers to a local floor,
 * and the FFT's ~1e-7 relative error is 70 dB under the smallest threshold in
 * the module. Measurement precision is spent in js/dsp/analytic.js instead,
 * where phase is read.
 */
export function spectrogram(mono, sampleRate, {
  binHz = DEFAULT_BIN_HZ, overlap = DEFAULT_OVERLAP, fftSize = 0, hop = 0,
  startSec = 0, endSec = null, maxCells = 8e6,
} = {}) {
  const rate = finite(sampleRate);
  if (!mono || !mono.length || !(rate > 0)) return null;
  const from = clamp(Math.floor(finite(startSec) * rate), 0, mono.length);
  const to = endSec == null ? mono.length : clamp(Math.ceil(finite(endSec) * rate), 0, mono.length);
  const span = to - from;
  const n = fftSize || nextPow2(Math.max(64, Math.round(rate / Math.max(1, finite(binHz, DEFAULT_BIN_HZ)))));
  if (span < n * 8) return null;

  const bins = n >> 1;                                  // DC..Nyquist-1
  let h = Math.max(1, hop || Math.round(n * (1 - clamp(finite(overlap, DEFAULT_OVERLAP), 0, 0.9))));
  let frames = Math.floor((span - n) / h) + 1;
  let decimated = false;
  if (frames * bins > maxCells) {
    h = Math.ceil((frames * bins) / maxCells) * h;
    frames = Math.floor((span - n) / h) + 1;
    decimated = true;
  }
  if (frames < 8) return null;

  const w = hann(n);
  let sumW = 0;
  for (let i = 0; i < n; i++) sumW += w[i];
  const scale = 1 / (sumW * sumW);

  const fft = new FFT(n);
  const re = new Float32Array(n), im = new Float32Array(n);
  const power = new Float32Array(frames * bins);
  for (let t = 0; t < frames; t++) {
    const off = from + t * h;
    for (let i = 0; i < n; i++) { re[i] = mono[off + i] * w[i]; im[i] = 0; }
    fft.forward(re, im);
    const row = t * bins;
    // Both conjugate halves of a real signal's line are counted, which is what
    // makes the 0.25 convention hold.
    for (let b = 0; b < bins; b++) power[row + b] = (re[b] * re[b] + im[b] * im[b]) * 4 * scale;
  }
  return {
    power, frames, bins, fftSize: n, hop: h, sampleRate: rate,
    binHz: rate / n, frameRate: rate / h,
    // A frame's time is its centre, not its first sample.
    timeOf: (t) => (from + t * h + n / 2) / rate,
    freqOf: (b) => (b * rate) / n,
    startSec: from / rate, endSec: to / rate, decimated,
  };
}

/* ------------------------------------------------------------------ *
 * The noise floor
 * ------------------------------------------------------------------ */

/**
 * The background: how loud it is in each bin, and how that changed over the
 * window.
 *
 *  perBin  — the median over time of that bin's power AFTER the frame gain has
 *            been divided out, over ln 2 because the median of Exp(1) is ln 2.
 *            Unbiased for the noise mean while fewer than half the frames
 *            carry signal. Relative standard error 1.44/sqrt(frames): 1.5%
 *            over a 300 s window at 8 kHz.
 *  smooth  — a running median of `perBin` across 65 bins, over a window kept
 *            symmetric. Blind to anything narrower than about 32 bins, so a
 *            carrier does not raise it, and unbiased under any spectral tilt.
 *  gain    — a multiplier per frame; see frameGain().
 *
 * A bin whose own median sits more than 3x above its neighbours' is carrying
 * something for most of the window; the neighbours are then the better floor.
 * A bin more than 2x BELOW its neighbours is a real notch and keeps its own.
 *
 * The two stages below are one iteration and it is not optional. A first floor
 * is needed to see the frame gain at all, but a per-bin median taken over a
 * window whose level is swinging is the median of a MIXTURE of exponentials,
 * not the median of one, and that is a biased estimate of the noise mean by a
 * factor that depends on how deep the swing was. Measured on white noise under
 * a 0.4 Hz fade of 0.95 depth: after dividing out a gain estimated from the
 * one-stage floor, the mean normalised cell power was 1.50 instead of 1, the
 * 1% grow mask passed 5.3% of cells, and 71 to 95 cells per window stood over
 * a seed threshold that is supposed to pass one. Re-taking the per-bin median
 * on the gain-normalised power puts all three back: 1.00, 1.00%, 0 to 4.
 */
export function noiseFloor(spec, opts = {}) {
  const { smoothBins = FLOOR_SMOOTH_BINS } = opts;
  const { power, frames, bins } = spec;
  const perBin = new Float64Array(bins);
  const mean = new Float64Array(bins);
  const col = new Float64Array(frames);

  // Stage one: a floor good enough to see the frame gain through.
  const rough = new Float64Array(bins);
  for (let b = 0; b < bins; b++) {
    for (let t = 0; t < frames; t++) col[t] = power[t * bins + b];
    rough[b] = medianOf(col);
  }
  const roughSmooth = runningMedian(rough, smoothBins);
  for (let b = 0; b < bins; b++) {
    const s = roughSmooth[b] > 0 ? roughSmooth[b] : rough[b];
    rough[b] = (rough[b] < 0.5 * s ? rough[b] : s) / MEDIAN_OF_EXP1;
  }
  const roughBand = analysisBand(spec, { cutoffBin: bins - 1 }, opts);
  const gain = frameGain(spec, rough, roughBand, opts);

  // Stage two: the floor the rest of the module uses, and the trimmed mean the
  // line test uses, from the same sorted column so the pass is paid for once.
  //
  // The trimming is not tidying either. A single loud impulse puts one frame
  // thousands of times over the floor, and an untrimmed mean of 625 frames is
  // then sixteen times its own floor: measured, a 10 ms click made the line
  // test declare a standing carrier, which loosened the per-cell threshold in
  // those bins, which produced one 20-second detection out of a click. It
  // costs a continuous carrier 1% of its own strength, and the threshold is
  // unaffected because the statistic is a ratio to a running median of the
  // same trimmed quantity.
  const keep = Math.max(1, Math.floor(frames * 0.99));
  for (let b = 0; b < bins; b++) {
    for (let t = 0; t < frames; t++) col[t] = power[t * bins + b] / gain.gain[t];
    const sorted = Float64Array.prototype.slice.call(col).sort();
    perBin[b] = sorted[frames >> 1] / MEDIAN_OF_EXP1;
    let sum = 0;
    for (let t = 0; t < keep; t++) sum += sorted[t];
    mean[b] = sum / keep;
  }
  const smooth = runningMedian(perBin, smoothBins);
  const meanBase = runningMedian(mean, smoothBins);

  const floor = new Float64Array(bins);
  const occupied = new Uint8Array(bins);
  let occupiedCount = 0;
  for (let b = 0; b < bins; b++) {
    const s = smooth[b] > 0 ? smooth[b] : perBin[b];
    floor[b] = perBin[b] < 0.5 * s ? perBin[b] : s;
    if (perBin[b] > 3 * s) { occupied[b] = 1; occupiedCount += 1; }
  }

  // Two edges, and they are not the same edge.
  //
  // `cutoff` is where a lossy codec stopped coding. Measured on the shelf's
  // 44.1 kHz MP3s the brick wall is a 40 to 55 dB step (m08 -55 dB at 18 kHz,
  // g11 -51 dB at 19 kHz, the 1942 disc -71 dB at 16 kHz) while the highest
  // real shoulder inside the band is -22 dB, so 30 dB separates them cleanly.
  // Above the cutoff the "noise" is quantisation residue: it is near zero, so
  // any bin the encoder does write reads as an enormous excess over it. At
  // 1e-6 this scan missed every one of those cliffs and m08 reported a 43 dB
  // "emission" at 16.6-22 kHz that is entirely the encoder.
  //
  // `contentEdge` is where the RECORDING's own noise stops — the receiver's
  // audio passband. Above it the floor is a flat encoder plateau rather than
  // receiver noise, so it is where real signal can no longer be. Measured:
  // 2.5-3 kHz on the Cuban CW and Austrian voice captures, which is exactly
  // the audio bandwidth of an HF receiver.
  const mid = medianOf(floor);
  let cutoffBin = bins - 1;
  while (cutoffBin > 1 && smooth[cutoffBin] < 1e-3 * mid) cutoffBin -= 1;
  const plateauFrom = Math.max(1, cutoffBin - Math.floor(cutoffBin / 4));
  const plateau = medianOf(smooth, plateauFrom, cutoffBin + 1);
  let contentBin = cutoffBin;
  while (contentBin > 1 && !(smooth[contentBin] > 4 * plateau)) contentBin -= 1;
  if (contentBin <= 1) contentBin = cutoffBin;             // one plateau, no shoulder

  const band = analysisBand(spec, { cutoffBin }, opts);
  // The standing-band scan runs over every bin up to Nyquist unless the caller
  // pinned a ceiling, and NOT up to the codec cutoff, because both the cutoff
  // and the content edge are derived from this same floor and a wide standing
  // emitter moves them. Measured on a 42 dB rectangle at 600-3000 Hz in white
  // noise: more than half the bins are then inside the emitter, so the median
  // the cutoff scan compares against is the emitter's own level, the true
  // noise floor above 3 kHz reads as "below the codec cutoff", and cutoffBin
  // lands on the emitter's upper edge — putting the very edge that has to be
  // found onto the boundary of the search. Over the whole spectrum it is found
  // (625-3000 Hz, +42 dB) and a real codec cliff still cannot be mistaken for
  // one, because a cliff is a fall with no rise to pair with.
  const standing = standingBands(spec, floor, {
    binLo: band.binLo, binHi: finite(opts.maxHz, 0) > 0 ? band.binHi : bins - 1,
  }, opts);

  return {
    floor, perBin, smooth, mean, meanBase, occupied,
    occupiedFraction: occupiedCount / bins,
    cutoffBin, cutoffHz: spec.freqOf(cutoffBin),
    contentBin, contentEdgeHz: spec.freqOf(contentBin), plateau,
    binLo: band.binLo, binHi: band.binHi,
    gain: gain.gain, gainRangeDb: gain.rangeDb, nonStationary: gain.nonStationary,
    gainWindowSec: gain.windowSec,
    frameLevel: gain.frameLevel, frameLevelMid: gain.frameLevelMid,
    standingBands: standing,
    // True when so much of the band is continuously occupied that the "floor"
    // is partly the signal. Every level below is then relative to that.
    floorSuspect: occupiedCount / bins > 0.4 || standing.length > 0,
  };
}

/**
 * The bins the whole module works over: from `minHz` up to `maxHz` or the
 * codec cutoff, whichever is lower. Shared by the gain estimate, the presence
 * test and the mask, because a "full band" guard is only meaningful against
 * one definition of the band.
 */
export function analysisBand(spec, fl, { minHz = DEFAULT_MIN_HZ, maxHz = 0 } = {}) {
  const { bins, binHz } = spec;
  const binLo = clamp(Math.ceil(finite(minHz, DEFAULT_MIN_HZ) / binHz), 1, bins - 1);
  const binHi = clamp(maxHz > 0 ? Math.floor(maxHz / binHz) : fl.cutoffBin, binLo + 1, bins - 1);
  return { binLo, binHi, usableBins: binHi - binLo + 1, spanHz: (binHi - binLo + 1) * binHz };
}

/**
 * A time-varying multiplier on the per-bin floor, so the background is allowed
 * to be non-stationary as well as coloured.
 *
 * Every HF signal on this shelf sits in a background that breathes: the path
 * fades at a fraction of a hertz and the whole audio band moves with it,
 * because the fade is a gain on the receiver's own noise. The per-bin floor is
 * a median over the WHOLE window, so it lands somewhere in the middle of that
 * swing and every loud minute of it stands over the threshold. Measured: white
 * noise multiplied by 1 + 0.95*cos(2*pi*0.4t) — no emitter anywhere in it —
 * produced 11 to 15 detections per seed on four seeds out of four, most of
 * them spanning the entire 63-4000 Hz band, each with confidence 1.0000.
 *
 * The estimate is the median across bins of each frame's excess over the
 * per-bin floor. Under the null that median is a fixed multiple of the frame's
 * gain whatever the gain is, and it is a median, so it is unmoved by an
 * emitter occupying up to half the band. It is then run through a median over
 * ±`gainSec`/2 in time, and that window is what separates the two things a
 * per-frame level can mean:
 *
 *   a fade      0.05 to 1 Hz — period 1 s and up, so a 0.25 s median follows
 *               it closely enough that the residual is under half a percent
 *   a pulsed emitter  10 to 100 Hz — 2.5 to 25 periods inside the same 0.25 s
 *                     window, so at any duty under a half the median frame is
 *                     an off frame and the emitter does not enter the gain
 *
 * Two orders of magnitude separate the two, which is why one fixed window
 * serves both; see DEFAULT_GAIN_SEC for the sweep that set it. The array is
 * renormalised to a median of 1 so it changes the SHAPE of the floor over time
 * and not its overall calibration.
 *
 * WHAT THIS COSTS. A genuinely band-wide emitter that stays on for much longer
 * than `gainSec` is a change in the level of the whole band, which is what
 * this removes, so it is absorbed into the background and does not appear.
 * That is not a bug that can be fixed here: over one window a band-wide level
 * change and a band-wide emitter are the same observation. It is why a
 * detection reaching both ends of the analysed band is marked `fullBand` and
 * capped rather than believed, and why a band with edges inside the spectrum
 * is reported by standingBands() instead of being measured.
 */
export function frameGain(spec, floor, band, { gainSec = DEFAULT_GAIN_SEC } = {}) {
  const { power, frames, bins, frameRate } = spec;
  const ones = new Float64Array(frames).fill(1);
  const half = Math.round((finite(gainSec, DEFAULT_GAIN_SEC) / 2) * frameRate);
  const usable = band.binHi - band.binLo + 1;
  if (!(half >= 1) || frames < 32 || usable < 16) {
    return { gain: ones, rangeDb: 0, nonStationary: false, windowSec: 0, frameLevel: null, frameLevelMid: 0 };
  }
  const level = new Float64Array(frames);
  const row = new Float64Array(usable);
  for (let t = 0; t < frames; t++) {
    const off = t * bins;
    for (let b = 0; b < usable; b++) {
      const f = floor[band.binLo + b];
      row[b] = f > 0 ? power[off + band.binLo + b] / f : 0;
    }
    level[t] = medianOf(row);
  }
  const smoothed = runningMedian(level, 2 * half + 1);
  const mid = medianOf(smoothed) || 1;
  const gain = new Float64Array(frames);
  for (let t = 0; t < frames; t++) gain[t] = Math.max(1e-6, smoothed[t] / mid);
  const sorted = Float64Array.prototype.slice.call(gain).sort();
  const q = (p) => sorted[clamp(Math.round(p * (frames - 1)), 0, frames - 1)];
  const rangeDb = 10 * Math.log10(Math.max(1e-12, q(0.9)) / Math.max(1e-12, q(0.1)));
  return {
    gain, rangeDb, nonStationary: rangeDb > NONSTATIONARY_DB,
    windowSec: (2 * half + 1) / frameRate,
    // The per-frame band level before smoothing, and its own median. A frame
    // far over that median is a broadband event; see FLASH_RATIO.
    frameLevel: level, frameLevelMid: medianOf(level),
  };
}

/**
 * Runs of bins whose floor steps up and back down again by more than
 * `stepDb`, with ordinary background either side.
 *
 * This is the one case the module cannot measure and previously did not
 * mention. Both floors are medians, so a continuous emitter wider than the
 * 65-bin smoothing window becomes the floor it would have to stand above.
 * Measured, band-limited Gaussian noise 35 dB over the true floor:
 *
 *   600-3000 Hz, continuous   present = false, 0 detections, "noise alone"
 *   400-3600 Hz, continuous   present = false, 0 detections, "noise alone"
 *   600-1400 Hz, continuous   1 detection at 484-656 Hz — the emitter's own
 *                             lower skirt — reported as snrDb -4.8 dB with
 *                             confidence 1.0000
 *
 * A 35 dB emitter called noise, or called minus five decibels with perfect
 * confidence. `occupied`/`floorSuspect` never fired on any of them, because
 * they compare a bin with a 65-bin median that the same emitter raised.
 *
 * What a wide emitter cannot hide is its EDGES. A receiver's noise floor, 1/f
 * atmospherics and a receiver passband are all smooth in frequency; a band of
 * emission is a rectangle. The statistic is therefore a step — the ratio of
 * the median floor over the K bins above a boundary to the median over the K
 * bins below it — which is invariant to any smooth tilt, so 1/f (measured: 5.1
 * dB per 4-bin step at the low edge, 0.2 dB in mid band) is nowhere near it.
 *
 * The band this produces is not a detection. Nothing here can say whether a
 * band whose own floor is 34 dB up is an emitter or a change in the background
 * over that stretch of spectrum — over one window those are the same
 * observation. What it can say is that the level of anything inside it is not
 * measurable against the receiver's noise, which is why every detection
 * overlapping one comes back with `snrDb: null` rather than a number.
 */
export function standingBands(spec, floor, band, { standingStepDb = STANDING_STEP_DB } = {}) {
  const lo = band.binLo;
  // The scan runs to the codec cutoff and NOT to the content edge, because the
  // content edge is derived from this same floor and a standing emitter moves
  // it: measured on a 42 dB band at 600-1400 Hz in otherwise white noise, the
  // content-edge scan put the recording's own noise as stopping at 1422 Hz —
  // the emitter's upper edge — so clamping here to the content edge put that
  // edge exactly on the scan boundary and the band could never be found.
  const hi = band.binHi;
  const usable = hi - lo + 1;
  const K = clamp(Math.round(usable / 64), 3, 16);
  const out = [];
  if (usable < 8 * K) return out;
  const T = Math.max(1, finite(standingStepDb, STANDING_STEP_DB));
  const step = new Float64Array(spec.bins);
  for (let b = lo + K; b <= hi - K; b++) {
    const below = medianOf(floor, b - K, b);
    const above = medianOf(floor, b + 1, b + 1 + K);
    step[b] = below > 0 && above > 0 ? 10 * Math.log10(above / below) : 0;
  }
  // Both edges must sit strictly inside the band with K bins of ordinary
  // background outside them. That margin is what keeps the receiver's own
  // audio passband — which also rises and falls — from being reported: its
  // edges are the edges of the analysed band, not features inside it.
  let b = lo + 2 * K;
  const last = hi - 2 * K;
  while (b <= last) {
    if (!(step[b] >= T)) { b += 1; continue; }
    let up = b;
    while (up + 1 <= last && step[up + 1] >= T) up += 1;
    let d = up + 1;
    while (d <= last && !(step[d] <= -T)) d += 1;
    if (d > last) break;
    let down = d;
    while (down + 1 <= last && step[down + 1] <= -T) down += 1;
    const b0 = up + 1, b1 = d;
    // Wide enough to be a band, and not so wide that it is the analysed band
    // itself. A receiver's audio passband also rises and falls, and it covers
    // essentially everything below the content edge; calling that a standing
    // emitter would be true of every HF recording and useful about none.
    if (b1 - b0 + 1 >= 2 * K && b1 - b0 + 1 <= FULL_BAND_FRACTION * usable) {
      const inside = medianOf(floor, b0, b1 + 1);
      const outLeft = medianOf(floor, Math.max(lo, b - 3 * K), b - K + 1);
      const outRight = medianOf(floor, down + K, Math.min(hi + 1, down + 3 * K));
      const ref = Math.max(outLeft, outRight);
      const stepDb = ref > 0 && inside > 0 ? 10 * Math.log10(inside / ref) : 0;
      if (stepDb >= T) {
        out.push({
          binLo: b0, binHi: b1,
          lowHz: spec.freqOf(b0), highHz: spec.freqOf(b1) + spec.binHz,
          stepDb, insidePower: inside, outsidePower: ref,
        });
      }
    }
    b = down + 1;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Is there anything here at all?
 * ------------------------------------------------------------------ */

/**
 * Two statistics against the same Exp(1) null, because they fail on opposite
 * signals and a bench that ran only one would be silently deaf to half the
 * shelf.
 *
 *  cells — K, the number of cells whose power exceeds `seedThreshold` times
 *          the local floor. The threshold is set so that E[K] = 1 under the
 *          null, which makes K ~ Poisson(1); the critical value is the Poisson
 *          upper tail at `alpha`. Powerful against bursts, deaf to a carrier
 *          buried under the noise.
 *  line  — max over bins of the time-averaged power divided by a running
 *          median of that same average across frequency. Averaging `frames`
 *          Exp(1) cells gives Gamma(frames, frames), whose spread is
 *          1/sqrt(frames); the threshold is the Chernoff bound on that tail at
 *          `alpha` spread over the bins tested. Powerful against a continuous
 *          carrier at a fraction of a dB, deaf to a short burst.
 *          Dividing by a running median of the SAME statistic is what makes
 *          this immune to the floor estimator's own bias — a bias common to
 *          all bins cancels — and to the spectral tilt of a real receiver.
 *
 * `present` is the OR of the two. When both fail, the honest answer is that
 * this window is noise, and the caller gets no detections.
 */
export function presenceTest(spec, fl, opts = {}) {
  const { alpha = DEFAULT_ALPHA } = opts;
  const { power, frames, bins } = spec;
  const { binLo, binHi } = analysisBand(spec, fl, opts);
  const usable = binHi - binLo + 1;
  const N = frames * usable;
  const a = clamp(finite(alpha, DEFAULT_ALPHA), 1e-12, 0.5);
  const gain = fl.gain && fl.gain.length === frames ? fl.gain : new Float64Array(frames).fill(1);

  const seedThreshold = Math.log(N / EXPECTED_FALSE_CELLS);
  let cellCount = 0;
  for (let t = 0; t < frames; t++) {
    const row = t * bins, g = gain[t];
    for (let b = binLo; b <= binHi; b++) {
      if (fl.floor[b] > 0 && power[row + b] > seedThreshold * fl.floor[b] * g) cellCount += 1;
    }
  }
  const cellCritical = poissonCritical(EXPECTED_FALSE_CELLS, a);

  const lineRatio = new Float64Array(bins);
  let lineMax = 0, lineBin = binLo;
  for (let b = binLo; b <= binHi; b++) {
    const base = fl.meanBase[b];
    const r = base > 0 ? fl.mean[b] / base : 0;
    lineRatio[b] = r;
    if (r > lineMax) { lineMax = r; lineBin = b; }
  }
  const lineCritical = gammaMeanThreshold(frames, Math.log(usable / a));

  const byCells = cellCount >= cellCritical;
  const byLine = lineMax >= lineCritical;
  const reason = byCells && byLine ? 'bursts and a standing line'
    : byCells ? 'cells above the floor'
      : byLine ? 'a standing line'
        : 'consistent with noise alone';
  return {
    present: byCells || byLine, reason,
    binLo, binHi, usableBins: usable, cells: N,
    seedThreshold, seedThresholdDb: 10 * Math.log10(seedThreshold),
    cellCount, cellCritical, byCells,
    lineRatio, lineMax, lineBin, lineHz: spec.freqOf(lineBin), lineCritical, byLine,
    alpha: a,
  };
}

/* ------------------------------------------------------------------ *
 * Mask, morphology, components
 * ------------------------------------------------------------------ */

// Union-find over the grid. Two passes, 8-connected.
function label(mask, frames, bins) {
  const lab = new Int32Array(frames * bins).fill(-1);
  const parent = [];
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  for (let t = 0; t < frames; t++) {
    for (let b = 0; b < bins; b++) {
      const i = t * bins + b;
      if (!mask[i]) continue;
      let best = -1;
      for (let dt = -1; dt <= 0; dt++) {
        for (let db = -1; db <= 1; db++) {
          if (dt === 0 && db >= 0) continue;
          const tt = t + dt, bb = b + db;
          if (tt < 0 || bb < 0 || bb >= bins) continue;
          const j = lab[tt * bins + bb];
          if (j < 0) continue;
          if (best < 0) { best = j; lab[i] = j; } else union(best, j);
        }
      }
      if (best < 0) { const id = parent.length; parent.push(id); lab[i] = id; }
    }
  }
  const remap = new Map();
  let count = 0;
  for (let i = 0; i < lab.length; i++) {
    if (lab[i] < 0) continue;
    const r = find(lab[i]);
    let id = remap.get(r);
    if (id === undefined) { id = count++; remap.set(r, id); }
    lab[i] = id;
  }
  return { lab, count };
}

/**
 * Fill runs of zeros between two ones along time within each bin. This is the
 * hysteresis that keeps a signal from shattering across a fade: HF fades are
 * seconds long at the edges and tenths in the middle, and a detection broken
 * into forty fragments is not a detection.
 *
 * A gap no longer than `gap` is bridged when EITHER of two things is true, and
 * the pair of them is what separates a transmission from a run of atmospheric
 * crashes:
 *
 *   it is no longer than the shorter run either side — a fade is shorter than
 *   the signal it interrupts, so a gap longer than what surrounds it is two
 *   events rather than one interrupted one; or
 *
 *   the same gap length has already recurred REGULAR_GAPS times — a gap that
 *   keeps coming back at the same length is a duty cycle, and a pulse train's
 *   runs are always shorter than its gaps so the first condition can never
 *   admit it.
 *
 * Both are needed and the measurements say so. Over 20 s of white noise
 * carrying atmospheric-style crashes 2 ms long, with nothing transmitting:
 *
 *   gap alone                      10 to 13 detections per seed, 0.2-0.8 s
 *   + run-length condition         0 in 36 windows, but a 50 Hz pulse train
 *                                  at 15% duty is lost with it
 *   + recurrence at one repeat     8 detections in 90 windows
 *   + recurrence at two repeats    0 in 90 windows, pulse train kept
 *
 * A Morse carrier is unaffected throughout: at 18 wpm a dah is three frames
 * and the inter-character gap is three frames, so the first condition admits
 * it exactly as before.
 */
function bridgeTime(mask, frames, bins, gap) {
  if (gap < 1) return;
  for (let b = 0; b < bins; b++) {
    let t = 0, lastEnd = -1, lastLen = 0, lastHole = -1, sameHole = 0;
    while (t < frames) {
      if (!mask[t * bins + b]) { t += 1; continue; }
      let e = t;
      while (e + 1 < frames && mask[(e + 1) * bins + b]) e += 1;
      const len = e - t + 1;
      const hole = lastEnd >= 0 ? t - lastEnd - 1 : Infinity;
      if (Number.isFinite(hole)) {
        sameHole = lastHole > 0 && Math.abs(hole - lastHole) <= Math.max(1, 0.25 * hole) ? sameHole + 1 : 0;
        lastHole = hole;
      }
      // A gap that keeps recurring at the same length is a duty cycle, whatever
      // the runs either side are worth. REGULAR_GAPS is how many times it has
      // to recur; see the comment above this function for the measurement that
      // sets it.
      const regular = sameHole >= REGULAR_GAPS;
      if (hole >= 1 && hole <= gap && (hole <= Math.min(lastLen, len) || regular)) {
        for (let f = lastEnd + 1; f < t; f++) mask[f * bins + b] = 1;
        lastLen += hole + len;                    // the joined run is one run
      } else lastLen = len;
      lastEnd = e;
      t = e + 1;
    }
  }
}

function bridgeFreq(mask, frames, bins, gap) {
  if (gap < 1) return;
  for (let t = 0; t < frames; t++) {
    const row = t * bins;
    let last = -1;
    for (let b = 0; b < bins; b++) {
      if (!mask[row + b]) continue;
      if (last >= 0 && b - last > 1 && b - last - 1 <= gap) {
        for (let f = last + 1; f < b; f++) mask[row + f] = 1;
      }
      last = b;
    }
  }
}

/* ------------------------------------------------------------------ *
 * The whole thing
 * ------------------------------------------------------------------ */

/**
 * What is in a window. Returns
 *   { present, reason, emissions, components, classifyOn, presence, floor,
 *     spec, warnings, costMs }
 * and empty lists whenever the presence test fails — which is the behaviour
 * the noise-only tests in test/cases-sigint-segment.mjs exist to pin.
 *
 * THERE ARE TWO LISTS AND ONLY ONE OF THEM IS AN ANSWER.
 *
 *   emissions   one entry per transmission. THIS IS THE LIST TO CLASSIFY,
 *               to decode, and to show a person. `classifyOn` in the returned
 *               object says so too, in the object, at runtime.
 *   components  the connected regions of the mask that each emission was built
 *               from. Diagnostic: use them to draw the mask or to argue with a
 *               boundary, never as the input to a decision.
 *
 * The field used to be called `detections` and there was nothing to say which
 * of the two a classifier wanted. That is not a naming quibble — it silently
 * changes the answer. Measured, a 425 Hz shift / 45.45 baud two-tone FSK in
 * noise, on three seeds out of three: the two tones are two components, and
 * the strongest component alone classifies as `ook-morse` with all seven of
 * that hypothesis's tests holding, while the emission that contains both of
 * them classifies as `fsk2` with all six of its tests holding. Same recording,
 * same classifier, confidently different answers, chosen by which list the
 * caller happened to reach for. Reading `.detections` now yields undefined,
 * which fails loudly, rather than yielding the wrong list quietly.
 *
 * Each entry carries:
 *   startSec, endSec, lowHz, highHz, centerHz, bandwidthHz, durationSec
 *   peakSnrDb   the strongest single cell's excess over the floor, or null
 *   snrDb       the whole component's excess power over the noise in the same
 *               time-frequency area — the number to quote, since a wide weak
 *               signal and a narrow strong one can share a peak. null when the
 *               floor it would be measured against is the signal's own.
 *   snrDbSe     one standard error on snrDb, from the spread of the level
 *               across SNR_BLOCKS contiguous time blocks. null when the
 *               component covers too few blocks to have a spread.
 *   dutyCycle   fraction of the component's bounding box that is masked
 *   falseAlarmLog10  log10 of an upper bound on the chance that noise alone
 *               made a component this large and this strong anywhere in the
 *               window. Chernoff on Gamma, times the number of cells, so it
 *               errs high.
 *   confidence  the smallest of (1 - that bound) and every cap in
 *               `confidenceNotes` that applies; null when the level is not
 *               measurable at all. Not a convenience: it is the only number
 *               here that goes DOWN when an alternative explanation is live,
 *               and `confidenceNotes` names each one that bound it.
 *   evidence    'cells' when the component contains a family-wise seed,
 *               'line' when it exists because that bin's time average stands
 *               above its neighbours, 'cells+line' when both.
 *   floorFromNeighbours  true when this bin's own median was itself elevated,
 *               so the floor came from adjacent bins.
 *   fullBand    true when it spans FULL_BAND_FRACTION of the analysed band.
 *   selfFloored true when it sits in a band whose own floor stands above the
 *               surrounding background — see standingBands().
 */
export function segment(mono, sampleRate, opts = {}) {
  const t0 = Date.now();
  const spec = spectrogram(mono, sampleRate, opts);
  if (!spec) return { present: false, reason: 'window too short to transform', components: [], emissions: [], classifyOn: 'emissions', warnings: [], spec: null, costMs: Date.now() - t0 };
  const fl = noiseFloor(spec, opts);
  const presence = presenceTest(spec, fl, opts);
  const impulse = impulsiveness(mono, {
    from: Math.floor(spec.startSec * spec.sampleRate), to: Math.ceil(spec.endSec * spec.sampleRate),
  });
  const warnings = [];
  if (fl.occupiedFraction > 0.4) {
    warnings.push(`${Math.round(fl.occupiedFraction * 100)}% of bins are occupied for most of the window; ` +
      'the floor is partly signal and every level is relative to it');
  }
  for (const s of fl.standingBands) {
    warnings.push(`the floor between ${Math.round(s.lowHz)} and ${Math.round(s.highHz)} Hz stands ${s.stepDb.toFixed(0)} dB ` +
      'above the background either side of it. Over one window a continuous noise-like emitter and a change in the ' +
      'background over that stretch are the same observation, so nothing here can say which it is, and no level ' +
      'inside that band is measurable against the receiver noise');
  }
  if (fl.nonStationary) {
    warnings.push(`the background level moved ${fl.gainRangeDb.toFixed(1)} dB across the window (10th to 90th percentile of the ` +
      `${fl.gainWindowSec.toFixed(2)} s frame gain); thresholds follow it, and every detection's confidence is capped at ${CONFIDENCE_CAP_NONSTATIONARY}`);
  }
  if (spec.decimated) warnings.push('frames were decimated to stay inside maxCells; time resolution is coarser than asked for');
  if (fl.contentBin < fl.cutoffBin) {
    warnings.push(`the recording's own noise stops at ${Math.round(fl.contentEdgeHz)} Hz and the codec at ` +
      `${Math.round(fl.cutoffHz)} Hz; detections marked aboveContentEdge are encoder behaviour, not air`);
  }
  const frameMs = (spec.fftSize / spec.sampleRate) * 1000;
  // A band whose own floor stands over the background is something, even
  // though nothing here can bound it in time or measure its level. Saying
  // "consistent with noise alone" next to a 42 dB rectangle would be a lie by
  // juxtaposition, so it counts as present and the reason says what it is.
  // The reason still contains the presence test's own verdict, because the two
  // statistics genuinely did fail and a reader should know that too.
  const standingOnly = !presence.present && fl.standingBands.length > 0;
  const base = {
    present: presence.present || standingOnly,
    reason: standingOnly
      ? `${fl.standingBands.length} band${fl.standingBands.length > 1 ? 's whose own floors stand' : ' whose own floor stands'} ` +
        `above the background; by the two presence statistics alone it is ${presence.reason}`
      : presence.reason,
    presence, floor: fl, spec, impulse, warnings,
    windowSec: spec.endSec - spec.startSec,
    standingBands: fl.standingBands,
    // Said in the object, not only in the doc comment, because the caller that
    // gets this wrong is the one that never read the doc comment.
    classifyOn: 'emissions',
  };
  // The caveat an impulsive waveform earns, said whether or not anything was
  // found. It used to be said only when nothing was found, which is exactly
  // backwards: silence needs it because a pulse train shorter than a frame
  // becomes its own floor and hides, but the windows that need it MORE are the
  // ones where the crashes DID produce detections and nothing said so.
  // Measured over 30 windows of noise carrying twelve ringing crashes a
  // second, with every other guard in this file in place: 241 components
  // survived, spanning a median 39% of the band for a median 0.45 s, and not
  // one of them carried any note saying a crash train would produce the same
  // thing. A crash is a damped ring, so it is narrowband by construction and
  // the broadband guard cannot see it.
  //
  // It is a caveat and not a cap, and that is a measured decision rather than
  // a soft one. A CAP would have to fire on a magnitude, and no magnitude
  // separates the two things: excess kurtosis over 24 windows reads 29 to 35
  // on a crash-ridden background and 65 on 30 s of white noise carrying one
  // real 0.3 s tone at amplitude 1.0, with a real 50 Hz pulsed emitter at 15
  // and an over-the-horizon synthetic at 10. A short transmission makes a
  // waveform impulsive exactly as a crash does. So the honest act is to say
  // that a crash train would produce these detections too, and to leave the
  // number alone.
  if (impulse.z > IMPULSIVE_Z) {
    // Both halves are said every time, because both are true every time and
    // the branch that used to choose between them chose on `present`, which is
    // not the same question as whether anything was bounded: a 10 ms click
    // makes a window present and produces no detections at all.
    warnings.push(`the waveform is impulsive (excess kurtosis ${impulse.excessKurtosis.toFixed(1)}, z ${impulse.z.toFixed(0)}) ` +
      `at a ${frameMs.toFixed(0)} ms frame. A pulse train shorter than the frame becomes its own floor and hides. ` +
      'A crash is a damped ring, so it is narrowband and the broadband guard cannot see it, and a train of them ' +
      'bridged together would produce detections like any reported here. Nothing measured says which this is — a ' +
      'short transmission makes a waveform impulsive too');
  }
  if (!presence.present) {
    return { ...base, components: [], emissions: [], costMs: Date.now() - t0 };
  }

  const { power, frames, bins } = spec;
  const { binLo, binHi, seedThreshold } = presence;
  const growThreshold = -Math.log(GROW_CELL_RATE);

  const lineBin = new Uint8Array(bins);
  for (let b = binLo; b <= binHi; b++) if (presence.lineRatio[b] >= presence.lineCritical) lineBin[b] = 1;

  const grow = new Uint8Array(frames * bins);
  const seed = new Uint8Array(frames * bins);
  const seedInBin = new Uint8Array(bins);
  // Every excess below is against floor[b] * gain[t]: the bin's own colour
  // times what the whole band's level was doing at that moment.
  const gain = fl.gain;
  for (let t = 0; t < frames; t++) {
    const row = t * bins, g = gain[t];
    for (let b = binLo; b <= binHi; b++) {
      const f = fl.floor[b] * g;
      if (!(f > 0)) continue;
      const e = power[row + b] / f;
      if (e > growThreshold) grow[row + b] = 1;
      if (e > seedThreshold) { seed[row + b] = 1; seedInBin[b] = 1; grow[row + b] = 1; }
    }
  }

  // A bin the line test confirmed but that has no cell of its own is a carrier
  // too weak to bound in time, and the honest reading of a standing line is
  // that it stands for the whole window. So the bin is filled rather than
  // thresholded more loosely.
  //
  // A loosened per-cell threshold was tried first and is the wrong shape. It
  // let about a fifth of noise frames through in every confirmed bin, and once
  // the fade bridge stitched runs shorter than 0.3 s together, a tone present
  // from 4 s to 14 s came back as one detection spanning the entire window,
  // gap and all. Where a bin has a family-wise seed the signal is strong
  // enough that the strict threshold resolves its timing anyway.
  for (let b = binLo; b <= binHi; b++) {
    if (!lineBin[b] || seedInBin[b]) continue;
    for (let t = 0; t < frames; t++) grow[t * bins + b] = 1;
  }

  // Hysteresis: keep only grown components that contain a family-wise seed or
  // sit in a bin the line test confirmed. On pure noise this discards about
  // 48,000 of the 48,001 clusters the 1% grow mask makes.
  const first = label(grow, frames, bins);
  const seeded = new Uint8Array(first.count);
  for (let i = 0; i < grow.length; i++) {
    if (!grow[i]) continue;
    if (seed[i] || lineBin[i % bins]) seeded[first.lab[i]] = 1;
  }
  const kept = new Uint8Array(frames * bins);
  for (let i = 0; i < grow.length; i++) if (grow[i] && seeded[first.lab[i]]) kept[i] = 1;

  const bridgeFrames = Math.max(0, Math.round(finite(opts.bridgeSec, DEFAULT_BRIDGE_SEC) * spec.frameRate));
  bridgeTime(kept, frames, bins, bridgeFrames);
  bridgeFreq(kept, frames, bins, Math.max(0, finite(opts.bridgeBins, 1)));

  const final = label(kept, frames, bins);
  // Two corrections to the obvious arithmetic, and both are about clicks.
  //
  // First, a component covering frames t0..t1 spans (t1 - t0) / frameRate
  // between the first and last frame CENTRE, so clearing `minDurationSec`
  // needs one frame more than `minDurationSec * frameRate`.
  //
  // Second, the analysis window is itself `fftSize / rate` long, so an
  // instantaneous event is smeared over that much time before anything here
  // sees it: at the defaults a 2 ms crash occupies two frames, which is 64 ms,
  // which used to satisfy a 0.15 s minimum. Nothing shorter than the window
  // can be told from an impulse, so the window length is added to whatever
  // duration the caller asks for and the module does not claim to bound
  // anything shorter than the sum.
  //
  // Measured on 20 s of white noise carrying 40 atmospheric-style crashes of
  // 2 ms each, four seeds: before, 10 to 13 confident detections per seed;
  // with the bridging run-length rule, 0 to 2; with this as well, zero on all
  // four.
  //
  // The cost is measured rather than asserted, as the in-bin signal-to-noise
  // ratio at which a tone burst in white noise is found in half of twelve
  // seeds, with and without this correction:
  //
  //     0.2 s burst   13.7 dB     against   5.4 dB
  //     0.3 s burst    4.1 dB     against   4.1 dB
  //     0.5 s burst    3.1 dB     against   3.1 dB
  //     1.0 s burst    1.6 dB     against   1.6 dB
  //
  // So it costs 8.3 dB on a burst shorter than the effective minimum and
  // nothing at all on anything longer, which is what a duration floor should
  // do. At the defaults the shortest reportable event is 0.26 s rather than
  // the 0.15 s minDurationSec asks for.
  const frameSec = spec.fftSize / spec.sampleRate;
  const minFrames = Math.max(2,
    Math.round((finite(opts.minDurationSec, DEFAULT_MIN_DURATION_SEC) + frameSec) * spec.frameRate) + 1);

  const acc = [];
  for (let i = 0; i < final.count; i++) {
    acc.push({ t0: Infinity, t1: -Infinity, b0: Infinity, b1: -Infinity, cells: 0, excess: 0, peak: 0, hasSeed: 0, hasLine: 0, elevated: 0, standing: 0, flashCells: 0 });
  }
  const standingBin = new Uint8Array(bins);
  for (const s of fl.standingBands) for (let b = s.binLo; b <= s.binHi; b++) standingBin[b] = 1;
  // Hot bins, and their running count along frequency in every frame.
  //
  // "The whole band jumped" used to be asked of the median across ALL the
  // analysed bins, which meant it could only be asked of a component narrower
  // than half of them — anything wider moves that median itself and the
  // question becomes circular. So a component between half the band and the
  // 80% at which FULL_BAND_FRACTION caps confidence was guarded by neither,
  // and confident false detections lived in the gap: measured over 30 windows
  // of noise carrying atmospheric crashes, 292 components survived, at
  // confidence 0.80, and every one of them spanned between 0.52 and 0.77 of
  // the band.
  //
  // Asking it of the bins OUTSIDE the component closes the gap, because then
  // the question is fair at any width. The prefix count is what makes it cheap:
  // the hot count either side of a component is two subtractions per frame.
  const hotCum = new Int32Array(frames * (bins + 1));
  for (let t = 0; t < frames; t++) {
    const row = t * bins, cum = t * (bins + 1), g = fl.gain[t];
    let run = 0;
    for (let b = 0; b < bins; b++) {
      hotCum[cum + b] = run;
      if (b >= binLo && b <= binHi) {
        const f = fl.floor[b] * g;
        if (f > 0 && power[row + b] > FLASH_RATIO * f) run += 1;
      }
    }
    hotCum[cum + bins] = run;
  }
  const hotBetween = (t, b0, b1) => hotCum[t * (bins + 1) + b1 + 1] - hotCum[t * (bins + 1) + b0];
  // Whether frame `t` is a broadband event as seen from OUTSIDE [b0, b1].
  const flashOutside = (t, b0, b1) => {
    const lo0 = binLo, lo1 = Math.min(binHi, b0 - 1 - FLASH_GUARD_BINS);
    const hi0 = Math.max(binLo, b1 + 1 + FLASH_GUARD_BINS), hi1 = binHi;
    let n = 0, h = 0;
    if (lo1 >= lo0) { n += lo1 - lo0 + 1; h += hotBetween(t, lo0, lo1); }
    if (hi1 >= hi0) { n += hi1 - hi0 + 1; h += hotBetween(t, hi0, hi1); }
    if (n < FLASH_MIN_OUTSIDE_BINS) return null;   // nothing left to ask
    return h > FLASH_BIN_SHARE * n;
  };
  for (let t = 0; t < frames; t++) {
    const row = t * bins, g = fl.gain[t];
    for (let b = binLo; b <= binHi; b++) {
      const i = row + b;
      if (!kept[i]) continue;
      const a = acc[final.lab[i]];
      const f = fl.floor[b] * g;
      const e = f > 0 ? power[i] / f : 0;
      if (t < a.t0) a.t0 = t; if (t > a.t1) a.t1 = t;
      if (b < a.b0) a.b0 = b; if (b > a.b1) a.b1 = b;
      a.cells += 1; a.excess += e;
      if (e > a.peak) a.peak = e;
      if (seed[i]) a.hasSeed = 1;
      if (lineBin[b]) a.hasLine = 1;
      if (fl.occupied[b]) a.elevated = 1;
      if (standingBin[b]) a.standing = 1;
    }
  }

  // Second pass over the same cells, now that every component's own extent is
  // known: how many of its cells arrived in frames when the band OUTSIDE it
  // jumped. `flashAsked` records whether the question could be put at all.
  // `flashBase` is the share of ALL the window's frames that are broadband
  // events as seen from outside this component, and it is what makes the share
  // below a statement about the component rather than about the window.
  //
  // Without it the guard deletes real signal wherever crashes are common. A
  // continuous carrier spanning a whole window in a band where a quarter of
  // the frames carry a crash has a quarter of ITS cells in crash frames too,
  // simply by lying underneath them; measured, a 1500 Hz carrier at amplitude
  // 0.30 — 25 dB in band — was found in 1 of 24 windows of crash-ridden noise.
  // A component that IS a crash has essentially all of its cells there. The
  // question is therefore whether the cells are concentrated in flash frames
  // beyond the rate at which flash frames simply happen.
  const flashAsked = new Uint8Array(acc.length);
  const flashBase = new Float64Array(acc.length);
  {
    const cache = new Int8Array(frames);
    for (let id = 0; id < acc.length; id++) {
      const a = acc[id];
      if (!a.cells) continue;
      cache.fill(-1);
      let asked = true, flashFrames = 0;
      for (let t = 0; t < frames; t++) {
        const v = flashOutside(t, a.b0, a.b1);
        if (v === null) { asked = false; break; }
        cache[t] = v ? 1 : 0;
        if (v) flashFrames += 1;
      }
      flashAsked[id] = asked ? 1 : 0;
      if (!asked) continue;
      flashBase[id] = flashFrames / frames;
      for (let t = a.t0; t <= a.t1; t++) {
        if (cache[t] !== 1) continue;
        const row = t * bins;
        for (let b = a.b0; b <= a.b1; b++) if (kept[row + b] && final.lab[row + b] === id) a.flashCells += 1;
      }
    }
  }

  // Second pass, for the error bar on snrDb. Each component's own frame span
  // is cut into SNR_BLOCKS contiguous blocks and the level is measured in each
  // separately; the spread of those block levels is what the uncertainty is
  // estimated from. Blocks rather than a closed form because the cells are not
  // independent — 50% window overlap correlates neighbouring frames and the
  // Hann main lobe correlates neighbouring bins — so an analytic standard
  // error would be confidently too small, which is the one direction that
  // matters here. A blocked estimate absorbs both correlations, and it also
  // absorbs a genuine change in the signal's own level across the detection,
  // which is the honest thing for it to do: a level that moved is a level that
  // is uncertain. test/cases-sigint-segment.mjs checks it against a split half.
  const CELLS_PER_BLOCK = SNR_BLOCKS * SNR_FREQ_BLOCKS;
  const blockCells = new Float64Array(final.count * CELLS_PER_BLOCK);
  const blockExcess = new Float64Array(final.count * CELLS_PER_BLOCK);
  for (let t = 0; t < frames; t++) {
    const row = t * bins, g = fl.gain[t];
    for (let b = binLo; b <= binHi; b++) {
      const i = row + b;
      if (!kept[i]) continue;
      const id = final.lab[i], a = acc[id];
      const kt = clamp(Math.floor(((t - a.t0) / (a.t1 - a.t0 + 1)) * SNR_BLOCKS), 0, SNR_BLOCKS - 1);
      const kf = clamp(Math.floor(((b - a.b0) / (a.b1 - a.b0 + 1)) * SNR_FREQ_BLOCKS), 0, SNR_FREQ_BLOCKS - 1);
      const f = fl.floor[b] * g;
      const k = id * CELLS_PER_BLOCK + kt * SNR_FREQ_BLOCKS + kf;
      blockCells[k] += 1;
      blockExcess[k] += f > 0 ? power[i] / f : 0;
    }
  }

  // A component must clear the same family-wise budget the presence test used.
  // Without this the loosened threshold inside a line-confirmed bin emits
  // components whose excess is exactly what noise would give — measured on a
  // 2 s tone at 20 dB in 30 s of noise, 28 detections of which 1 was real.
  const reportCut = Math.log10(presence.alpha);
  const bandSpanHz = (binHi - binLo + 1) * spec.binHz;

  const components = [];
  for (let id = 0; id < acc.length; id++) {
    const a = acc[id];
    if (!a.cells) continue;
    const durFrames = a.t1 - a.t0 + 1;
    if (durFrames < minFrames) continue;
    // Excess power above the floor, not total power: a component's cells each
    // carry one unit of noise by construction, so the signal is the surplus.
    const signal = Math.max(0, a.excess - a.cells);
    const logP = Math.min(0, gammaTailLog(a.cells, a.excess) + Math.log(presence.cells));
    if (logP / Math.LN10 > reportCut) continue;
    const box = durFrames * (a.b1 - a.b0 + 1);
    const bandwidthHz = spec.freqOf(a.b1) + spec.binHz - spec.freqOf(a.b0);
    const fullBand = bandwidthHz >= FULL_BAND_FRACTION * bandSpanHz;
    // A component whose cells arrived mostly in frames when the band OUTSIDE it
    // jumped is part of a broadband event and not an emission. Asking it of the
    // outside bins is what makes it a fair question at any width; when the
    // component leaves too few bins for the question, `flashAsked` is 0 and the
    // only thing left is FULL_BAND_FRACTION's cap on confidence.
    //
    // The two guards partition the width axis and no longer leave a gap
    // between them. Below FULL_BAND_FRACTION the question is put to the bins
    // outside the component; at or above it there are not enough outside bins
    // for the answer to mean anything and the full-band cap is what remains.
    // Measured, the cost of getting that boundary wrong in the other
    // direction: a 25 dB carrier in crash-ridden noise merges with the crashes
    // into one component spanning 87% of the band, and asking the flash
    // question of the 30 bins left above it — where the crashes, which ring
    // between 200 and 2800 Hz, mostly are not — deleted the carrier with it in
    // 23 of 24 seeds.
    const flashShare = a.cells ? a.flashCells / a.cells : 0;
    if (!fullBand && flashAsked[id] && flashShare > FLASH_SHARE && flashShare > FLASH_EXCESS * flashBase[id]) continue;
    const selfFloored = !!a.standing;

    // Block levels, in linear excess-over-floor units, then their spread.
    const levels = [];
    for (let k = 0; k < CELLS_PER_BLOCK; k++) {
      const c = blockCells[id * CELLS_PER_BLOCK + k];
      if (c < 4) continue;                       // too few cells to be a level
      levels.push(blockExcess[id * CELLS_PER_BLOCK + k] / c - 1);
    }
    const s = signal / a.cells;
    let snrDbSe = null, snrBlocks = levels.length;
    if (levels.length >= 3 && s > 0) {
      let m = 0; for (const v of levels) m += v; m /= levels.length;
      let v2 = 0; for (const v of levels) v2 += (v - m) * (v - m);
      const sd = Math.sqrt(v2 / (levels.length - 1));
      const seLinear = sd / Math.sqrt(levels.length);
      snrDbSe = SNR_SE_INFLATION * (10 / Math.LN10) * (seLinear / s);
    }

    const notes = [];
    let confidence = clamp(1 - Math.exp(logP), 0, 1);
    // Caps, not fudge factors. Each is a ceiling on what this detection may
    // claim while a named alternative explanation is still live; the reported
    // confidence is the smallest of them and the false-alarm confidence.
    if (fullBand) {
      confidence = Math.min(confidence, CONFIDENCE_CAP_FULL_BAND);
      notes.push(`spans ${Math.round((bandwidthHz / bandSpanHz) * 100)}% of the analysed band, so the background moving explains it as well as an emitter does`);
    }
    if (a.elevated) {
      confidence = Math.min(confidence, CONFIDENCE_CAP_FLOOR_FROM_NEIGHBOURS);
      notes.push('its own bins were elevated for most of the window, so the floor it stands over came from adjacent bins');
    }
    if (fl.nonStationary) {
      confidence = Math.min(confidence, CONFIDENCE_CAP_NONSTATIONARY);
      notes.push(`the background level moved ${fl.gainRangeDb.toFixed(1)} dB across the window`);
    }
    if (spec.decimated) {
      confidence = Math.min(confidence, CONFIDENCE_CAP_DECIMATED);
      notes.push('frames were decimated, so the time bounds are coarser than the frame length implies');
    }
    if (selfFloored) {
      confidence = null;
      notes.push('sits inside a band whose own floor stands above the surrounding background; neither its level nor its false-alarm rate is measurable against the receiver noise');
    }

    components.push({
      startSec: spec.timeOf(a.t0), endSec: spec.timeOf(a.t1),
      durationSec: spec.timeOf(a.t1) - spec.timeOf(a.t0) + 1 / spec.frameRate,
      lowHz: spec.freqOf(a.b0), highHz: spec.freqOf(a.b1) + spec.binHz,
      centerHz: spec.freqOf(a.b0) + bandwidthHz / 2,
      bandwidthHz,
      cells: a.cells, boxCells: box, dutyCycle: a.cells / box,
      // The share of this component's cells that arrived in frames when the
      // band outside it jumped, and null when the component left too few
      // outside bins for the question to be put at all. A survivor with a
      // share near FLASH_SHARE is one the guard nearly rejected.
      flashShare: flashAsked[id] ? flashShare : null,
      flashBase: flashAsked[id] ? flashBase[id] : null,
      // Both levels are excesses over floor[bin] * gain[frame]. When the bin's
      // floor is the signal's own — selfFloored — the number that survives is
      // the one that says what it is measured against, and snrDb is withheld.
      peakSnrDb: selfFloored ? null : 10 * Math.log10(Math.max(1e-12, a.peak)),
      snrDb: selfFloored ? null : 10 * Math.log10(Math.max(1e-12, s)),
      snrDbSe: selfFloored ? null : snrDbSe, snrBlocks,
      snrOverStandingFloorDb: selfFloored ? 10 * Math.log10(Math.max(1e-12, s)) : null,
      falseAlarmLog10: selfFloored ? null : logP / Math.LN10,
      confidence, confidenceNotes: notes,
      evidence: a.hasSeed && a.hasLine ? 'cells+line' : a.hasSeed ? 'cells' : 'line',
      floorFromNeighbours: !!a.elevated,
      fullBand, selfFloored,
      // Above the receiver's own noise band there is no receiver noise to
      // stand out from, so whatever is here is the codec, not the air.
      aboveContentEdge: a.b0 > fl.contentBin,
      bins: [a.b0, a.b1], frames: [a.t0, a.t1],
    });
  }
  components.sort((x, y) => x.startSec - y.startSec || x.lowHz - y.lowHz);

  const wide = components.filter((d) => d.fullBand);
  if (wide.length) {
    warnings.push(`${wide.length} detection${wide.length > 1 ? 's span' : ' spans'} essentially the whole analysed band ` +
      `(${Math.round(bandSpanHz)} Hz); a band-wide level change explains that as well as an emitter does, so their confidence is capped at ${CONFIDENCE_CAP_FULL_BAND}`);
  }

  // A pulse train shorter than a frame smears into a continuous band and both
  // floors absorb it. Measured: 3 ms pulses at 50 Hz over 400-3200 Hz are
  // invisible at the 64 ms default frame and one clean detection at 8 ms.
  if (!components.length) {
    warnings.push(`the window is not noise (${presence.reason}) but nothing bounded at a ${frameMs.toFixed(0)} ms frame; ` +
      'if the emitter is pulsed, re-run with a shorter frame (raise binHz)');
  }

  return { ...base, components, emissions: mergeEmissions(components, opts), costMs: Date.now() - t0 };
}

/**
 * One transmission can put energy in bands the detector must separate: a 2-FSK
 * pair 400 Hz apart is two components, and a classifier handed only the mark
 * tone will call it a keyed carrier. Detections that overlap in time and sit
 * within `mergeGapHz` of one another are the same emission, and this is the
 * list a classifier should be given.
 */
export function mergeEmissions(detections, { mergeGapHz = 500, mergeOverlap = 0.5 } = {}) {
  const out = [];
  for (const d of detections) {
    const hit = out.find((e) => {
      const lo = Math.max(e.startSec, d.startSec), hi = Math.min(e.endSec, d.endSec);
      const share = (hi - lo) / Math.max(1e-9, Math.min(e.endSec - e.startSec, d.endSec - d.startSec));
      if (!(share >= mergeOverlap)) return false;
      return d.lowHz - e.highHz <= mergeGapHz && e.lowHz - d.highHz <= mergeGapHz;
    });
    if (!hit) {
      out.push({
        startSec: d.startSec, endSec: d.endSec, lowHz: d.lowHz, highHz: d.highHz,
        parts: 1, cells: d.cells, boxCells: d.boxCells, peakSnrDb: d.peakSnrDb, snrDb: d.snrDb,
        snrDbSe: d.snrDbSe, snrBlocks: d.snrBlocks, snrOverStandingFloorDb: d.snrOverStandingFloorDb,
        falseAlarmLog10: d.falseAlarmLog10, confidence: d.confidence,
        confidenceNotes: (d.confidenceNotes || []).slice(),
        evidence: d.evidence, floorFromNeighbours: d.floorFromNeighbours,
        fullBand: d.fullBand, selfFloored: d.selfFloored,
        aboveContentEdge: d.aboveContentEdge,
        subBands: [[d.lowHz, d.highHz]],
      });
      continue;
    }
    hit.startSec = Math.min(hit.startSec, d.startSec);
    hit.endSec = Math.max(hit.endSec, d.endSec);
    hit.lowHz = Math.min(hit.lowHz, d.lowHz);
    hit.highHz = Math.max(hit.highHz, d.highHz);
    hit.parts += 1;
    hit.cells += d.cells;
    hit.boxCells = finite(hit.boxCells) + finite(d.boxCells);
    // null is not a number and Math.max would silently treat it as zero, which
    // is exactly how a withheld level becomes a reported one. Every merge of a
    // level below is explicit about the null case.
    hit.peakSnrDb = maxOrNull(hit.peakSnrDb, d.peakSnrDb);
    hit.snrDb = maxOrNull(hit.snrDb, d.snrDb);
    if (hit.snrDb != null && hit.snrDb === d.snrDb) { hit.snrDbSe = d.snrDbSe; hit.snrBlocks = d.snrBlocks; }
    if (hit.snrDb == null) { hit.snrDbSe = null; hit.snrBlocks = 0; }
    hit.snrOverStandingFloorDb = maxOrNull(hit.snrOverStandingFloorDb, d.snrOverStandingFloorDb);
    hit.falseAlarmLog10 = minOrNull(hit.falseAlarmLog10, d.falseAlarmLog10);
    // The weakest claim of the parts, not the strongest: an emission is no
    // better founded than the part of it whose explanation is least settled.
    hit.confidence = minOrNull(hit.confidence, d.confidence);
    for (const n of d.confidenceNotes || []) if (!hit.confidenceNotes.includes(n)) hit.confidenceNotes.push(n);
    hit.floorFromNeighbours = hit.floorFromNeighbours || d.floorFromNeighbours;
    hit.fullBand = hit.fullBand || d.fullBand;
    hit.selfFloored = hit.selfFloored || d.selfFloored;
    hit.aboveContentEdge = hit.aboveContentEdge && d.aboveContentEdge;
    if (hit.evidence !== d.evidence) hit.evidence = 'cells+line';
    hit.subBands.push([d.lowHz, d.highHz]);
  }
  for (const e of out) {
    e.durationSec = e.endSec - e.startSec;
    e.bandwidthHz = e.highHz - e.lowHz;
    e.centerHz = e.lowHz + e.bandwidthHz / 2;
    e.dutyCycle = e.boxCells > 0 ? e.cells / e.boxCells : 1;
    e.subBands.sort((a, b) => a[0] - b[0]);
  }
  return out;
}

// null means "withheld", and it propagates: an emission whose level could not
// be measured in one of its parts has not had its level measured.
function maxOrNull(a, b) {
  if (a == null || b == null) return null;
  return Math.max(a, b);
}
function minOrNull(a, b) {
  if (a == null || b == null) return null;
  return Math.min(a, b);
}
