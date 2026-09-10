// "What kind of thing is it?" — evidence for and against each hypothesis about
// a detection from js/sigint/segment.js.
//
// What is being classified is the AUDIO STRUCTURE of a band, not a mode on the
// dial. These are recordings of open shortwave broadcasts and the receiver
// that made them already demodulated whatever was there, so "AM with carrier"
// below means a tone with symmetric sidebands in the audio, and "SSB voice"
// means speech-shaped audio with no dominant line. The names are what a
// listener would call the transmission; the measurements are of the recording.
//
// One limit is stated here rather than left to be discovered. A carrier
// modulated 90% deep falls 24 dB in its troughs, which every level statistic
// in this file reads as switching; `modulationTonality` is the one feature
// that still knows the difference — the swing is one sinusoid rather than a
// switch — and it is not enough to win. Deep AM is therefore reported as a
// keyed tone, with the sinusoid evidence sitting in `against` where a person
// can see it. Measured: 60% modulation is called AM, 90% and above is called
// keying. test/cases-sigint-segment.mjs pins both, the right answer and the
// wrong one, so the limit cannot drift unnoticed.
//
// The output is deliberately not a label. Every hypothesis comes back with the
// measurements that support it and the measurements that contradict it, so a
// person can look at `against` and disagree. `unclear` is a real answer and is
// reachable: when the leader does not clear MIN_SCORE, or does not beat the
// runner-up by MIN_MARGIN, nothing is claimed. On noise, `noise` wins outright
// and that is also a real answer rather than a failure.
//
// WHAT TO HAND THIS. The input is one entry from segment()'s `emissions`, and
// that is not interchangeable with one from its `components`. A two-tone shift
// is two components and one emission, and the strongest component alone
// classifies as a keyed carrier with every test of that hypothesis holding.
// segment() says `classifyOn: 'emissions'` in its own returned object for this
// reason.

import {
  analytic, instantaneousAmp, instantaneousFreq, firLowpass, filter, shiftHz,
} from '../dsp/analytic.js';
import { FFT, hann, nextPow2 } from '../fft.js';
import { spectrogram, gammaMeanThreshold } from './segment.js';

// Long enough to hold twenty Morse characters or a hundred FSK symbols, short
// enough that a 1023-tap FIR over it is milliseconds. Detections longer than
// this are analysed from their middle.
export const MAX_ANALYSIS_SEC = 6;
// The modulation search ceiling. 150 Hz reaches the 5-120 Hz repetition rate
// the pulsed-wideband hypothesis below looks for and every keying rate on the
// shelf; the Morse dit rate at 18 wpm is 15 Hz and 100 baud RTTY is 100.
export const MAX_MODULATION_HZ = 150;
// A hypothesis that only holds four of its seven tests has not earned a name.
// Measured on the shelf: at 0.3 the UVB-76 buzzer — a keyed tone complex with
// no hypothesis of its own here — was claimed as speech on a score of 0.33
// with three of seven tests against it. At 0.4 it comes back unclear, which is
// what it is.
export const MIN_SCORE = 0.4;
export const MIN_MARGIN = 0.12;

// The envelope of band-limited Gaussian noise is Rayleigh, whose 10th and 90th
// percentiles are 0.459 sigma and 2.146 sigma, so its depth statistic is
// (2.146 - 0.459) / (2.146 + 0.459) = 0.648 by construction. Measured on
// synthesised noise through the whole chain below: 0.64. Anything near this
// with no line is noise, whatever else it looks like.
export const RAYLEIGH_DEPTH = 0.648;
// Below 2% of modulation depth there is nothing a listener would hear and
// nothing a demodulator would lock to, whatever ratio it makes against a floor
// that is itself near zero.
export const MIN_MODULATION_DEPTH = 0.02;
// Speech puts more envelope energy at 2-8 Hz (the syllable rate) than above
// 12 Hz. Measured through the chain below: 8.2 on the UVB-76 buzzer's keying,
// 10.1 on Cuban CW, 1.8-2.6 on the voice passages of the Cuban and Austrian
// numbers stations, 1.25 on a mostly-silent 40 s voice message, and 0.96 on a
// digital burst. The cut sits between the quietest voice and the burst, and it
// is the only feature that separates a data burst from speech at all: both are
// wide, both are gapless, and both have a clock.
export const SYLLABIC_RATIO = 1.15;
// The block the envelope's depth is measured inside, short enough that a 0.4 Hz
// fade (2.5 s) and a 6 Hz gate (170 ms) are both approximately constant across
// one, long enough to hold enough independent envelope samples for a 10th and a
// 90th percentile: at 8 kHz a 50 ms block is 400 samples, and even a band only
// 200 Hz wide puts about 20 independent ones in it.
export const LOCAL_BLOCK_SEC = 0.05;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const finite = (n, fb = 0) => (Number.isFinite(n) ? n : fb);

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = clamp(p * (sorted.length - 1), 0, sorted.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

const sortedCopy = (a) => Float64Array.from(a).sort();

// Root-mean-square over a sliding window, by a running sum of squares. RMS
// rather than mean because it is the power that averages linearly.
function movingRms(x, width) {
  const n = x.length, half = width >> 1, out = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += x[i] * x[i];
    if (i >= width) sum -= x[i - width] * x[i - width];
    const j = i - half;
    if (j >= 0) out[j] = Math.sqrt(sum / Math.min(width, i + 1));
  }
  for (let j = Math.max(0, n - half); j < n; j++) out[j] = out[Math.max(0, n - half - 1)];
  return out;
}

/**
 * Modes of a distribution, by smoothed histogram, and the depth of the valley
 * between the two strongest.
 *
 * This is the bimodality statistic the FSK and on-off-keying hypotheses lean
 * on, and it is descriptive rather than tested: it has no closed-form null.
 * What makes it usable is that its value on the things it must reject was
 * measured rather than assumed. Through the chain below, valleyDepth reads
 * 0.00-0.06 on the log envelope of noise and 0.00-0.03 on the log envelope of
 * a steady tone (both unimodal, as they must be), and 0.75-0.99 on keyed
 * carriers. The predicates use 0.35 as the cut, well outside both.
 */
export function modes(values, { bins = 64, smoothWidth = 3, minHeight = 0.05, minSeparation = 3 } = {}) {
  const n = values.length;
  if (n < 32) return { peaks: [], valleyDepth: 0, valleyValue: 0, modeCount: 0 };
  const s = sortedCopy(values);
  const q1 = percentile(s, 0.01), q99 = percentile(s, 0.99);
  if (!(q99 > q1)) return { peaks: [{ value: q1, height: 1 }], valleyDepth: 0, valleyValue: q1, modeCount: 1 };
  // The range is padded by a tenth either side because the peak scan only
  // looks at interior bins. Without the padding a two-state signal — whose
  // whole point is that it lives at the two extremes — put both of its modes
  // in bin 0 and bin 63 and was reported as having none: a 200 Hz 2-FSK read
  // ifModeCount 0 and was ranked as multi-tone keying.
  const pad = (q99 - q1) * 0.1;
  const lo = q1 - pad, hi = q99 + pad;
  const h = new Float64Array(bins);
  const step = (hi - lo) / bins;
  for (let i = 0; i < n; i++) {
    const b = clamp(Math.floor((values[i] - lo) / step), 0, bins - 1);
    h[b] += 1;
  }
  const sm = new Float64Array(bins);
  for (let b = 0; b < bins; b++) {
    let sum = 0, cnt = 0;
    for (let k = -smoothWidth; k <= smoothWidth; k++) {
      const j = b + k;
      if (j < 0 || j >= bins) continue;
      sum += h[j]; cnt += 1;
    }
    sm[b] = sum / cnt;
  }
  let top = 0;
  for (let b = 0; b < bins; b++) if (sm[b] > top) top = sm[b];
  const peaks = [];
  for (let b = 1; b < bins - 1; b++) {
    if (sm[b] >= sm[b - 1] && sm[b] > sm[b + 1] && sm[b] >= minHeight * top) {
      peaks.push({ index: b, value: lo + (b + 0.5) * step, height: sm[b] });
    }
  }
  peaks.sort((a, b) => b.height - a.height);
  const kept = [];
  for (const p of peaks) {
    if (kept.some((q) => Math.abs(q.index - p.index) < minSeparation)) continue;
    kept.push(p);
  }
  if (kept.length < 2) {
    return { peaks: kept, valleyDepth: 0, valleyValue: kept.length ? kept[0].value : lo, modeCount: kept.length };
  }
  const [a, b] = [kept[0], kept[1]].sort((x, y) => x.index - y.index);
  let valley = Infinity, valleyIdx = a.index;
  for (let i = a.index; i <= b.index; i++) if (sm[i] < valley) { valley = sm[i]; valleyIdx = i; }
  const shallower = Math.min(a.height, b.height);
  return {
    peaks: kept,
    valleyDepth: shallower > 0 ? clamp(1 - valley / shallower, 0, 1) : 0,
    valleyValue: lo + (valleyIdx + 0.5) * step,
    separation: Math.abs(kept[0].value - kept[1].value),
    modeCount: kept.length,
  };
}

/**
 * Periodicity of a slowly varying sequence, in depth units: the sequence is
 * divided by its own mean and has that mean removed, so a sinusoidal
 * modulation of depth m reads m at its own rate. The floor is the median
 * across rates, because a periodogram of noise is exponential and its mean is
 * pulled about by its own tail while its median is not.
 *
 * js/analysis/cyclic.js does this over a whole STFT plane and is the right
 * tool when the target is a clock shared across separated bands. It is not
 * used here, for one specific reason stated in its own header: it derives its
 * envelopes from an STFT, so a carrier that does not sit on a bin centre leaks
 * into its own envelope and folds to |carrier mod frameRate|, inventing a
 * clock (6 of 27 swept carriers at a 2048-point window). The envelope here
 * comes from a Hilbert transform of an already down-converted band, which has
 * no frame to alias against.
 */
export function periodicity(seq, rate, { maxHz = MAX_MODULATION_HZ, threshold = 12, minDepth = MIN_MODULATION_DEPTH, limit = 6 } = {}) {
  const target = Math.max(4 * maxHz, 200);
  const block = Math.max(1, Math.floor(rate / target));
  const m = Math.floor(seq.length / block);
  if (m < 64) return { rateHz: 0, depth: 0, strength: 0, peaks: [], envRate: 0 };
  const envRate = rate / block;
  const dec = new Float64Array(m);
  let mean = 0;
  for (let i = 0; i < m; i++) {
    let sum = 0;
    for (let k = 0; k < block; k++) sum += seq[i * block + k];
    dec[i] = sum / block;
    mean += dec[i];
  }
  mean /= m;
  if (!(Math.abs(mean) > 1e-12)) return { rateHz: 0, depth: 0, strength: 0, peaks: [], envRate };
  const n = Math.min(8192, nextPow2(m) > m ? nextPow2(m) / 2 : nextPow2(m));
  if (n < 64) return { rateHz: 0, depth: 0, strength: 0, peaks: [], envRate };
  const w = hann(n);
  let wsum = 0;
  for (let i = 0; i < n; i++) wsum += w[i];
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = (dec[i] / mean - 1) * w[i];
  new FFT(n, { precision: 'f64' }).forward(re, im);
  const half = n >> 1;
  const scale = 2 / wsum;
  const mag = new Float64Array(half);
  for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]) * scale;
  const step = envRate / n;
  const first = Math.max(2, Math.ceil(0.5 / step));
  const last = Math.min(half - 2, Math.floor(maxHz / step));
  if (last <= first) return { rateHz: 0, depth: 0, strength: 0, peaks: [], envRate };
  const floor = percentile(sortedCopy(mag.subarray(first, last + 1)), 0.5) || 1e-12;
  const peaks = [];
  for (let i = first + 1; i < last; i++) {
    if (mag[i] < mag[i - 1] || mag[i] <= mag[i + 1]) continue;
    const strength = mag[i] / floor;
    // Both conditions, because either alone lies. A steady tone's envelope has
    // almost no structure, so its median floor is almost zero and a 0.3%
    // residue reads as 56x the floor; measured, that spurious peak was enough
    // to contradict the carrier hypothesis. And a loud broadband envelope can
    // carry 3% of depth everywhere without any of it being periodic.
    if (strength < threshold || mag[i] < minDepth) continue;
    peaks.push({ rateHz: i * step, depth: mag[i], strength });
  }
  peaks.sort((a, b) => b.strength - a.strength);
  const kept = peaks.slice(0, limit);
  const best = kept[0];
  // Where the modulation energy sits, rather than which single rate is
  // strongest. Speech is syllabic: its envelope energy piles up at 2-8 Hz and
  // falls away above 10. Keyed data does the opposite. One number for the
  // ratio, because a hypothesis that only asks "is there a clock" cannot tell
  // a voice from a burst — both have one.
  const bandMean = (a, b) => {
    const i0 = Math.max(first, Math.ceil(a / step)), i1 = Math.min(last, Math.floor(b / step));
    if (i1 <= i0) return 0;
    let sum = 0;
    for (let i = i0; i <= i1; i++) sum += mag[i];
    return sum / (i1 - i0 + 1);
  };
  const slow = bandMean(2, 8), fast = bandMean(12, 100);
  return {
    rateHz: best ? best.rateHz : 0, depth: best ? best.depth : 0, strength: best ? best.strength : 0,
    peaks: kept.slice().sort((a, b) => a.rateHz - b.rateHz), envRate, resolutionHz: step, floor,
    slowDepth: slow, fastDepth: fast, syllabicRatio: fast > 0 ? slow / fast : 0,
  };
}

/**
 * Does a set of spectral lines lie on an evenly spaced grid?
 *
 * Consecutive differences do not answer this. A 10-baud 8-FSK puts its eight
 * tones 100 Hz apart AND a keying sideband either side of each one, so the
 * consecutive differences are a mix of 100 and 10 and the regularity of the
 * true tone set reads 0.36 — measured, and it cost the classifier the case.
 * Voting instead: every pair proposes a spacing, and the spacing that puts the
 * most lines on its own grid wins. The 8-tone set then fits 8 of its lines at
 * 100 Hz whatever the sidebands do.
 */
export function gridFit(hz, { tolFraction = 0.10, minSpacingHz = 12 } = {}) {
  const n = hz.length;
  if (n < 3) return { spacingHz: 0, fitCount: n, fitFraction: n ? 1 : 0, baseHz: n ? hz[0] : 0, z: 0 };
  let best = { spacingHz: 0, fitCount: 0, fitFraction: 0, baseHz: hz[0], z: 0 };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = hz[j] - hz[i];
      if (d < minSpacingHz) continue;
      const tol = d * tolFraction;
      let count = 0;
      for (let k = 0; k < n; k++) {
        const off = Math.abs(hz[k] - hz[i]) / d;
        if (Math.abs(off - Math.round(off)) * d <= tol) count += 1;
      }
      if (count > best.fitCount || (count === best.fitCount && d < best.spacingHz)) {
        best = { spacingHz: d, fitCount: count, fitFraction: count / n, baseHz: hz[i] };
      }
    }
  }
  // How much of the fit is the search itself. A line lands within tolerance of
  // an arbitrary grid with probability 2 * tolFraction whatever it is doing, so
  // the count under a null of scattered lines is Binomial(n, 2 * tolFraction)
  // and the fit is only evidence to the extent it beats that. This is what the
  // whole vote is worth reporting for: at a 0.15 tolerance the harmonics of a
  // woman's voice on the UVB-76 recording fit a 51 Hz grid 15 lines deep and
  // the classifier called a spoken message a multi-carrier data burst.
  const p = Math.min(0.9, 2 * tolFraction);
  const expected = n * p;
  best.z = (best.fitCount - expected) / Math.sqrt(Math.max(1e-9, n * p * (1 - p)));
  best.expected = expected;
  return best;
}

/**
 * How much of the time an envelope spends between its two extremes.
 *
 * A signal that is switched on and off lives at two levels and passes through
 * the middle only during the transitions, so this is small. Anything with one
 * mode — noise, a steady tone, speech — fills the middle. It replaces a
 * histogram valley depth for the on-off-keying test because it needs no peak
 * finding and so cannot fail on the shape of a histogram bin.
 *
 * The reference value is exact rather than tuned: for the Rayleigh envelope of
 * band-limited noise the middle third of the 5th-to-95th-percentile range in
 * dB holds 0.359 of the distribution. Measured through the chain below: 0.36
 * on noise, 0.38 on a steady tone, 0.30 on speech, 0.04-0.09 on keyed carriers.
 */
export function gapFraction(db) {
  const s = sortedCopy(db);
  const lo = percentile(s, 0.05), hi = percentile(s, 0.95);
  if (!(hi > lo)) return { fraction: 1, spanDb: 0, loDb: lo, hiDb: hi };
  const a = lo + (hi - lo) / 3, b = lo + 2 * (hi - lo) / 3;
  let inside = 0;
  for (let i = 0; i < db.length; i++) if (db[i] > a && db[i] < b) inside += 1;
  return { fraction: inside / db.length, spanDb: hi - lo, loDb: lo, hiDb: hi, midDb: (lo + hi) / 2 };
}

/* ------------------------------------------------------------------ *
 * Features
 * ------------------------------------------------------------------ */

/**
 * Everything the hypotheses below are allowed to look at, measured once.
 *
 * Two passes over the same slice: a fine-frequency average spectrum for the
 * things that live on the frequency axis (lines, their spacing, sideband
 * symmetry, flatness, occupied bandwidth), and a down-converted complex
 * baseband for the things that live on the time axis (envelope depth, its
 * bimodality, duty cycle, keying rate, instantaneous frequency).
 *
 * The down-converter is a real one: analytic signal, shift the band centre to
 * DC, low-pass. Its transition width is bounded by the tap cap, so a band
 * narrower than about `sampleRate * 4.5 / 1023` cannot be isolated exactly and
 * `notes` says so rather than the number quietly being wrong.
 */
/**
 * Harmonics of a periodicity's strongest rate that are themselves peaks. A rate
 * whose interval jitters loses these; a clock keeps them.
 */
export function harmonicsOf(p, { tolerance = 0.06, upTo = 5, maxHz = MAX_MODULATION_HZ } = {}) {
  if (!p || !p.rateHz || !Array.isArray(p.peaks)) return { found: 0, reachable: 0 };
  // Only harmonics inside the search band can be found, and at a 50 Hz pulse
  // rate against a 120 Hz ceiling that is exactly one of them. Counting found
  // without counting reachable made a real pulse train fail its own test.
  const reachable = Math.max(0, Math.min(upTo, Math.floor(maxHz / p.rateHz)) - 1);
  let found = 0;
  for (let k = 2; k <= reachable + 1; k++) {
    const want = p.rateHz * k;
    if (p.peaks.some((q) => Math.abs(q.rateHz - want) <= tolerance * want)) found++;
  }
  return { found, reachable };
}

export function extractFeatures(mono, sampleRate, detection, opts = {}) {
  const rate = finite(sampleRate);
  const notes = [];
  const d = detection || {};
  const startSec = finite(d.startSec, 0);
  const endSec = finite(d.endSec, startSec + MAX_ANALYSIS_SEC);
  const maxSec = finite(opts.maxAnalysisSec, MAX_ANALYSIS_SEC);
  const durationSec = endSec - startSec;
  let from = startSec, to = endSec;
  if (durationSec > maxSec) {
    const mid = (startSec + endSec) / 2;
    from = mid - maxSec / 2; to = mid + maxSec / 2;
    notes.push(`analysed ${maxSec.toFixed(1)} s from the middle of a ${durationSec.toFixed(1)} s detection`);
  }
  const i0 = clamp(Math.floor(from * rate), 0, mono.length);
  const i1 = clamp(Math.ceil(to * rate), 0, mono.length);
  const slice = mono.subarray ? mono.subarray(i0, i1) : mono.slice(i0, i1);
  if (slice.length < 2048) return null;

  const lowHz = clamp(finite(d.lowHz, 0), 0, rate / 2);
  const highHz = clamp(finite(d.highHz, rate / 2), lowHz + rate / 512, rate / 2);

  /* --- frequency axis --- */
  // 5 Hz bins resolve a tone set's spacing, but a 5 Hz bin at 44.1 kHz is a
  // 16384-point transform that needs three seconds of audio to average over.
  // Short detections get the finest resolution that fits instead of nothing at
  // all: measured, a fixed 5 Hz gave up entirely on every speech burst in the
  // Austrian numbers capture, all of which run one to three seconds.
  const fineBinHz = finite(opts.fineBinHz, 5);
  let fineN = nextPow2(Math.max(256, Math.round(rate / fineBinHz)));
  while (fineN > 256 && slice.length < fineN * 8) fineN >>= 1;
  const spec = spectrogram(slice, rate, { fftSize: fineN, overlap: 0.5 });
  if (!spec) return null;
  if (spec.binHz > fineBinHz * 1.6) {
    notes.push(`only ${(slice.length / rate).toFixed(1)} s to analyse, so the spectrum is ${spec.binHz.toFixed(1)} Hz per bin rather than ${fineBinHz}; tone spacings below about ${(3 * spec.binHz).toFixed(0)} Hz cannot be resolved`);
  }
  const avg = new Float64Array(spec.bins);
  for (let t = 0; t < spec.frames; t++) {
    const row = t * spec.bins;
    for (let b = 0; b < spec.bins; b++) avg[b] += spec.power[row + b];
  }
  for (let b = 0; b < spec.bins; b++) avg[b] /= spec.frames;

  const bLo = clamp(Math.floor(lowHz / spec.binHz), 1, spec.bins - 2);
  const bHi = clamp(Math.ceil(highHz / spec.binHz), bLo + 1, spec.bins - 1);

  // What the whole band's level was doing, frame by frame, as a factor on the
  // window's typical level. The line test below is a statement about the mean
  // of `frames` Exp(1) draws, and that is only true if the level held still:
  // measured on white noise under a 0.4 Hz fade, the raw mean spectrum carried
  // one or two "lines" per window because the fade widens every bin's mean far
  // beyond the 1/sqrt(frames) the threshold assumes. Dividing each frame by
  // its own band level puts the null back. A narrowband emitter cannot move a
  // median taken across hundreds of bins, so this leaves a carrier alone; a
  // band-wide one moves it, and then the level really is common-mode and
  // dividing it out is the right thing anyway.
  const frameLevel = new Float64Array(spec.frames);
  {
    const rowBuf = new Float64Array(bHi - bLo + 1);
    for (let t = 0; t < spec.frames; t++) {
      const row = t * spec.bins;
      for (let b = bLo; b <= bHi; b++) rowBuf[b - bLo] = spec.power[row + b];
      frameLevel[t] = percentile(sortedCopy(rowBuf), 0.5);
    }
  }
  const frameMid = percentile(sortedCopy(frameLevel), 0.5) || 1e-20;
  const frameGain = new Float64Array(spec.frames);
  for (let t = 0; t < spec.frames; t++) frameGain[t] = Math.max(1e-6, frameLevel[t] / frameMid);
  // The mean spectrum on gain-normalised power, which is what the line test
  // below runs on.
  //
  // A MEDIAN over frames was tried alongside it, on the reasoning that a crash
  // puts its ringing into the mean of every bin it rang in and into the median
  // of none. It is a true statement — measured on crash-ridden noise, 9 to 24
  // lines in the mean and 0 to 2 in the median — and it changed no verdict on
  // any colour at any seed, so it is not here. The per-bin sort it needed was
  // the most expensive thing in this function.
  const avgN = new Float64Array(spec.bins);
  for (let b = bLo; b <= bHi; b++) {
    let sum = 0;
    for (let t = 0; t < spec.frames; t++) sum += spec.power[t * spec.bins + b] / frameGain[t];
    avgN[b] = sum / spec.frames;
  }

  // How far the band's own SHAPE moves from frame to frame: the difference in
  // dB between the mean power in its upper and lower half, spread 10th to 90th
  // percentile across frames. The level cancels in the ratio, so a fade, a gate
  // and a tilt all read nothing and only a change of shape registers. This is
  // the one thing a talker has and a background does not.
  //
  // Measured on its own frame, not the fine one. The fine spectrum is 5 Hz per
  // bin, which at 8 kHz is a 256 ms frame — longer than a phoneme, so it
  // averages the shape change away: on the same synthesised speech the swing
  // read 11.7 dB at a 32 ms frame and 2.9 dB at 256 ms, and two of five voice
  // windows came back unclear because of it.
  //
  // Reported against its own null rather than in dB, because the null depends
  // on how many bins are in each half. With B bins per half the half-means are
  // Gamma(B)/B, so the tilt has standard deviation (10/ln10)*sqrt(2/B) dB and a
  // 10-90 spread of 2*1.2816 of that. Measured on white noise the spread runs
  // 1.41x that bound, which is what 50% frame overlap and the Hann main lobe
  // leaving about half as many independent bins as there are bins predicts, so
  // the null used here carries that factor. Measured over 30 windows per
  // colour at a 32 ms frame: white 1.07, 1/f 1.16, fading 1.05, gated 1.07 —
  // every stationary background inside 1.2 — against 3.1 to 3.6 on synthesised
  // speech, 6.7 on an 18 wpm Morse carrier and 7.2 on atmospheric crashes,
  // which move the shape because they are broadband events.
  let tiltSwingDb = NaN, tiltSwingOverNull = NaN;
  {
    const tiltN = Math.max(128, nextPow2(Math.round(rate * 0.032)));
    const tspec = slice.length >= tiltN * 8 ? spectrogram(slice, rate, { fftSize: tiltN, overlap: 0.5 }) : null;
    const tLo = tspec ? clamp(Math.floor(lowHz / tspec.binHz), 1, tspec.bins - 2) : 0;
    const tHi = tspec ? clamp(Math.ceil(highHz / tspec.binHz), tLo + 1, tspec.bins - 1) : 0;
    const mid = (tLo + tHi) >> 1;
    const perHalf = Math.min(mid - tLo, tHi - mid + 1);
    if (tspec && perHalf >= 8) {
      const tilt = new Float64Array(tspec.frames);
      for (let t = 0; t < tspec.frames; t++) {
        const row = t * tspec.bins;
        let lo = 0, hi = 0;
        for (let b = tLo; b < mid; b++) lo += tspec.power[row + b];
        for (let b = mid; b <= tHi; b++) hi += tspec.power[row + b];
        const a = hi / (tHi - mid + 1), c = lo / (mid - tLo);
        tilt[t] = 10 * Math.log10(Math.max(1e-20, a) / Math.max(1e-20, c));
      }
      const st = sortedCopy(tilt);
      tiltSwingDb = percentile(st, 0.9) - percentile(st, 0.1);
      const nullDb = 1.41 * 2 * 1.2816 * (10 / Math.LN10) * Math.sqrt(2 / perHalf);
      tiltSwingOverNull = tiltSwingDb / nullDb;
    } else notes.push('too few bins either side of the band centre to say whether its shape changes over time');
  }
  let total = 0, logSum = 0, count = 0, peakBin = bLo, peakVal = 0;
  for (let b = bLo; b <= bHi; b++) {
    const v = Math.max(1e-20, avg[b]);
    total += v; logSum += Math.log(v); count += 1;
    if (v > peakVal) { peakVal = v; peakBin = b; }
  }
  const spectralFlatness = count ? Math.exp(logSum / count) / (total / count) : 1;
  const carrierRatio = total > 0
    ? (avg[peakBin] + (avg[peakBin - 1] || 0) + (avg[peakBin + 1] || 0)) / total : 0;

  // Narrowest contiguous span holding 99% of the band's power. A wide
  // detection made by a strong signal's window leakage still reports the
  // bandwidth that actually carries it.
  let occLo = bLo, occHi = bHi, best = bHi - bLo + 1, acc = 0, left = bLo;
  for (let right = bLo; right <= bHi; right++) {
    acc += Math.max(1e-20, avg[right]);
    while (acc - Math.max(1e-20, avg[left]) >= 0.99 * total && left < right) { acc -= Math.max(1e-20, avg[left]); left += 1; }
    if (acc >= 0.99 * total && right - left + 1 < best) { best = right - left + 1; occLo = left; occHi = right; }
  }
  const occupied99Hz = (occHi - occLo + 1) * spec.binHz;

  // Discrete lines: local maxima standing above a running local level by the
  // Chernoff threshold for the mean of `frames` averaged periodogram cells.
  // The same null the segmenter's line test uses, applied inside one band.
  const localWidth = Math.max(9, Math.round(200 / spec.binHz) | 1);
  const lineCut = gammaMeanThreshold(spec.frames, Math.log((bHi - bLo + 1) / 0.01));
  const localOf = (arr, b) => {
    const a = Math.max(bLo, b - localWidth), c = Math.min(bHi, b + localWidth);
    return percentile(sortedCopy(arr.subarray(a, c + 1)), 0.5) || 1e-20;
  };
  const lines = [];
  const localLevel = new Float64Array(spec.bins);
  for (let b = bLo; b <= bHi; b++) localLevel[b] = localOf(avgN, b);
  for (let b = bLo + 1; b < bHi; b++) {
    if (avgN[b] < avgN[b - 1] || avgN[b] <= avgN[b + 1]) continue;
    if (avgN[b] / localLevel[b] < lineCut) continue;
    lines.push({ hz: b * spec.binHz, level: avg[b], over: avgN[b] / localLevel[b] });
  }
  lines.sort((a, b) => b.level - a.level);

  // Flatness AFTER the band's own tilt is divided out. Raw spectralFlatness
  // answers "is this white", which is a question about the colour of the
  // background and not about whether anything is transmitting: measured over
  // 24 windows of 1/f noise it reads 0.65, at the exact edge of the cut the
  // noise hypothesis used to draw, while white noise reads 0.98. Dividing each
  // bin by the median of its own 200 Hz neighbourhood removes any tilt smooth
  // on that scale and leaves the peaks, which is the thing actually being
  // asked about.
  let wLog = 0, wSum = 0, wN = 0;
  for (let b = bLo; b <= bHi; b++) {
    const r = Math.max(1e-20, avgN[b]) / localLevel[b];
    wLog += Math.log(r); wSum += r; wN += 1;
  }
  const whitenedFlatness = wN ? Math.exp(wLog / wN) / (wSum / wN) : 1;

  // Keying puts a sideband either side of every tone. Cutting at 13 dB below
  // the strongest line keeps a tone set (whose members are comparable) and
  // drops the sidebands that would otherwise be counted as tones.
  const topLevel = lines.length ? lines[0].level : 0;
  const strongLines = lines.filter((l) => l.level > topLevel * 0.05).slice(0, 24).sort((a, b) => a.hz - b.hz);
  // A tone set whose spacing is a thirtieth of its own bandwidth is ninety
  // tones, which is not the shape any of the hypotheses below describe; below
  // that the vote is fitting the noise between the lines.
  const grid = gridFit(strongLines.map((l) => l.hz), { minSpacingHz: Math.max(12, occupied99Hz / 30) });
  const lineSpacingHz = grid.spacingHz;
  const lineSpacingRegularity = strongLines.length >= 3 ? grid.fitFraction : 0;
  const lineGridCount = grid.fitCount;
  const lineGridZ = grid.z;

  // Sideband symmetry about the strongest line: an amplitude-modulated tone
  // puts equal power at +offset and -offset, a single-sideband transmission
  // does not, and noise correlates with nothing.
  let sidebandSymmetry = 0;
  {
    const reach = Math.min(peakBin - bLo, bHi - peakBin);
    if (reach >= 6) {
      const xs = [], ys = [];
      for (let k = 2; k <= reach; k++) { xs.push(Math.log(Math.max(1e-20, avg[peakBin + k]))); ys.push(Math.log(Math.max(1e-20, avg[peakBin - k]))); }
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < xs.length; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
      sidebandSymmetry = sxx > 0 && syy > 0 ? clamp(sxy / Math.sqrt(sxx * syy), -1, 1) : 0;
    } else notes.push('band too narrow either side of its peak to test sideband symmetry');
  }

  /* --- time axis --- */
  const centerHz = (occLo + occHi + 1) * 0.5 * spec.binHz;
  const halfBw = Math.max(occupied99Hz / 2 + 40, 60);
  const z = analytic(slice);
  const shifted = shiftHz(z.re, z.im, rate, -centerHz);
  const cutoff = clamp(halfBw / rate, 1e-4, 0.45);
  // 4.5 / transition is the Kaiser tap count for a 60 dB stop band; the cap is
  // what bounds the cost of this call, and exceeding it is reported.
  let taps = Math.ceil(4.5 / cutoff) | 1;
  if (taps > 1023) { taps = 1023; notes.push(`band narrower than the ${(rate * 4.5 / 1023).toFixed(0)} Hz the tap cap can isolate; neighbours leak into the envelope`); }
  if (taps < 31) taps = 31;
  const lp = firLowpass(taps, cutoff, 60);
  const bre = filter(shifted.re, lp), bim = filter(shifted.im, lp);
  const guard = Math.max(z.guard, (taps - 1) >> 1);
  const g0 = Math.min(guard, Math.max(0, bre.length >> 2));
  const inRe = bre.subarray(g0, bre.length - g0);
  const inIm = bim.subarray(g0, bim.length - g0);
  if (inRe.length < 1024) return null;

  const env = instantaneousAmp(inRe, inIm);
  const envSorted = sortedCopy(env);
  const p10 = percentile(envSorted, 0.10), p90 = percentile(envSorted, 0.90);
  const envDepth = p10 + p90 > 0 ? (p90 - p10) / (p90 + p10) : 0;
  const envDb = new Float64Array(env.length);
  for (let i = 0; i < env.length; i++) envDb[i] = 20 * Math.log10(Math.max(1e-12, env[i]));
  const envModes = modes(envDb);

  // The two-state test runs on a SMOOTHED envelope, and this is not cosmetic.
  // A wideband pulsed emitter's on-state is itself noise, so its envelope is
  // Rayleigh inside every pulse and spans 34 dB while it is on; measured, the
  // raw envelope of a 15%-duty pulse train filled its own middle third exactly
  // as noise does (0.374) and the duty cycle came back as 1.00. Averaging over
  // a quarter-period of the fastest modulation being searched for removes the
  // Rayleigh fluctuation and leaves the pulse structure, and the same train
  // then reads two states and its true duty. A narrowband keyed carrier is
  // already smooth at this scale and is unaffected.
  const smoothN = Math.max(1, Math.round(rate / (4 * finite(opts.maxHz, MAX_MODULATION_HZ))));
  const envSmooth = smoothN > 1 ? movingRms(env, smoothN) : env;
  const smoothDb = new Float64Array(envSmooth.length);
  for (let i = 0; i < envSmooth.length; i++) smoothDb[i] = 20 * Math.log10(Math.max(1e-12, envSmooth[i]));
  const gap = gapFraction(smoothDb);

  // Duty cycle: the fraction of the band's time above the midpoint of its own
  // 5th-to-95th-percentile range, computed only when the envelope is actually
  // two-state. A continuous signal is on all the time by definition and saying
  // so is more honest than splitting its jitter down the middle.
  //
  // The stated limit: above about 95% duty the 95th percentile is itself the
  // on state and this reads 1.0 rather than 0.97.
  // Both conditions. A tone set played through one low-pass gives each tone a
  // slightly different gain, so an 8-FSK's envelope sits at eight discrete
  // levels inside a 2.8 dB span and its middle third is empty — measured, it
  // read as keyed with a duty cycle of 0.75 and cost the tone-set hypothesis a
  // test. Six decibels is the smallest span in which "on" and "off" mean
  // anything.
  const envKeyed = gap.fraction < 0.22 && gap.spanDb > 6;
  let dutyCycle = 1, dutySource = 'the envelope has one state; a continuous signal is on all the time';
  if (envKeyed) {
    let above = 0;
    for (let i = 0; i < smoothDb.length; i++) if (smoothDb[i] > gap.midDb) above += 1;
    dutyCycle = above / smoothDb.length;
    dutySource = `fraction above ${gap.midDb.toFixed(1)} dB, the midpoint of a two-state envelope spanning ${gap.spanDb.toFixed(1)} dB`;
  }

  const envRate = periodicity(env, rate, opts);

  // The envelope depth measured INSIDE short blocks, and the median of that
  // over the loudest half of them.
  //
  // envDepth above is taken over the whole slice, so anything that moves the
  // level slowly — a fade, a gate, the tilt of a coloured background — enters
  // it and it stops being a statement about the noise. Rayleigh's 0.648 is a
  // ratio of two quantiles of the SAME distribution, so it is scale-free: it
  // holds inside every block of noise however the level wanders between them.
  // Measured over 24 windows per colour: whole-slice envDepth reads 0.65 white,
  // 0.65 1/f, 0.79 fading, 0.87 impulsive, 0.96 gated, while this reads
  // 0.64-0.66 on all five. The loudest half is taken because that is where a
  // signal would be: a keyed carrier's quiet blocks are noise and would drag a
  // plain median back to 0.648, which is the one way this could be fooled.
  const blockN = Math.max(64, Math.round(rate * LOCAL_BLOCK_SEC));
  const blockDepth = [], blockLevel = [];
  for (let at = 0; at + blockN <= env.length; at += blockN) {
    const b = sortedCopy(env.subarray(at, at + blockN));
    const lo = percentile(b, 0.10), hi = percentile(b, 0.90);
    blockDepth.push(lo + hi > 0 ? (hi - lo) / (hi + lo) : 0);
    blockLevel.push(percentile(b, 0.5));
  }
  let localEnvDepth = NaN;
  if (blockDepth.length >= 4) {
    const order = blockLevel.map((v, i) => i).sort((a, b) => blockLevel[b] - blockLevel[a]);
    const loud = order.slice(0, Math.max(2, order.length >> 1)).map((i) => blockDepth[i]);
    localEnvDepth = percentile(Float64Array.from(loud).sort(), 0.5);
  } else notes.push(`the slice is shorter than four ${(LOCAL_BLOCK_SEC * 1000).toFixed(0)} ms blocks, so the envelope depth could not be measured free of the level's own drift`);

  // Instantaneous frequency, read only where the envelope says there is a
  // signal to read it from. Reading phase through a gap returns the noise's
  // phase, which is uniform and would smear any real shift into nothing.
  const gate = gap.fraction < 0.22 ? Math.pow(10, gap.midDb / 20) : percentile(envSorted, 0.25);
  const ifAll = instantaneousFreq(inRe, inIm, rate);
  const gated = [];
  for (let i = 1; i < ifAll.length; i++) if (env[i] > gate) gated.push(ifAll[i] + centerHz);
  const ifArr = Float64Array.from(gated);
  let ifSpreadHz = 0, ifModes = { peaks: [], valleyDepth: 0, modeCount: 0 }, ifShiftHz = 0, ifStateCount = 0;
  if (ifArr.length > 256) {
    const s = sortedCopy(ifArr);
    ifSpreadHz = percentile(s, 0.9) - percentile(s, 0.1);
    ifModes = modes(ifArr);
    // Every transition between two keyed tones sweeps through the frequencies
    // in between and leaves a small bump there. Counting states at a quarter
    // of the tallest mode rather than a twentieth is what separates a 2-FSK
    // (measured: 7 modes, 2 states) from a genuine tone set.
    ifStateCount = modes(ifArr, { minHeight: 0.25 }).modeCount;
    if (ifModes.modeCount >= 2) ifShiftHz = Math.abs(ifModes.peaks[0].value - ifModes.peaks[1].value);
  } else notes.push('too little of the band was above its own envelope gate to read instantaneous frequency');
  const ifRate = ifArr.length > 1024 ? periodicity(ifArr, rate, opts) : { rateHz: 0, strength: 0, peaks: [] };

  const symbolRateHz = ifRate.strength > envRate.strength ? ifRate.rateHz : envRate.rateHz;
  const symbolRateFrom = ifRate.strength > envRate.strength ? 'instantaneous frequency' : 'envelope';

  return {
    startSec: from, endSec: to, durationSec: to - from, analysedSec: (i1 - i0) / rate,
    lowHz, highHz, centerHz, bandwidthHz: highHz - lowHz, occupied99Hz,
    snrDb: finite(d.snrDb, NaN), peakSnrDb: finite(d.peakSnrDb, NaN), maskDuty: finite(d.dutyCycle, NaN),
    spectralFlatness, whitenedFlatness, tiltSwingDb, tiltSwingOverNull, carrierRatio, sidebandSymmetry,
    lineCount: strongLines.length, lines: strongLines, lineSpacingHz, lineSpacingRegularity,
    lineGridCount, lineGridZ, lineCut,
    envDepth, localEnvDepth, envValleyDepth: envModes.valleyDepth, envModeCount: envModes.modeCount,
    envModeSeparationDb: envModes.separation || 0,
    envGapFraction: gap.fraction, envSpanDb: gap.spanDb, envKeyed,
    dutyCycle, dutySource,
    envRateHz: envRate.rateHz, envRateStrength: envRate.strength, envRateDepth: envRate.depth,
    // How many harmonics of the strongest repetition rate stand above the
    // floor. This is what separates a pulsed emitter from noise that happens
    // to be switching: a radar's trigger is crystal-controlled, so its pulse
    // train has a comb at 2R, 3R, 4R; jitter in the interval kills the higher
    // harmonics first. Measured on gated white noise with random gate lengths
    // at a 20 Hz mean rate, which every other pulsed-wideband test accepts:
    // 0 harmonics, against 3 for a square fixed-interval train at the same rate
    // and 1 for a band-limited one, which is what a real emitter looks like —
    // so the bar is one harmonic, not two. `reachable` says how many fit below
    // MAX_MODULATION_HZ at all: at a 50 Hz repetition rate only 100 and 150 do.
    envRateHarmonics: harmonicsOf(envRate).found,
    envRateHarmonicsReachable: harmonicsOf(envRate).reachable,

    // Anything switched on and off at rate R has its spectrum convolved with a
    // comb of spacing R, so a grid of evenly spaced lines is not evidence of a
    // tone set when the envelope is a low-duty train: the grid is the
    // switching's own and carries no information about tones. Measured on a
    // synthetic repeated sweep at 25 Hz PRF, the grid vote fitted 18 of 24
    // lines to a 1273 Hz spacing at z = 6.7 — a confident tone set that is
    // entirely an alias of the 25 Hz pulse comb. The tone-set hypotheses below
    // therefore each carry a test that this is false.
    pulsedEnvelope: envKeyed && dutyCycle < 0.6 && envRate.strength >= 12 && envRate.rateHz >= 5,
    // How much of the envelope's whole swing is accounted for by its single
    // strongest rate. A sinusoidally modulated carrier is one rate and reads
    // about 1.0; keying spreads its energy over harmonics and unrelated rates
    // and reads about 0.6. Measured: 1.01 at 60% AM, 1.05 at 90% AM, 0.64 on
    // an 18 wpm Morse carrier. It is the only feature that separates deep AM
    // from on-off keying, which otherwise look alike by every level statistic
    // there is — a 90% modulated carrier really does fall 20 dB.
    modulationTonality: envDepth > 0.02 ? envRate.depth / envDepth : 0,
    syllabicRatio: finite(envRate.syllabicRatio, 0),
    ifSpreadHz, ifValleyDepth: ifModes.valleyDepth, ifModeCount: ifModes.modeCount, ifStateCount, ifShiftHz,
    ifRateHz: ifRate.rateHz, ifRateStrength: ifRate.strength,
    symbolRateHz, symbolRateFrom,
    bandwidthOverRate: symbolRateHz > 0 ? occupied99Hz / symbolRateHz : Infinity,
    aboveContentEdge: !!d.aboveContentEdge,
    notes,
  };
}

/* ------------------------------------------------------------------ *
 * Hypotheses
 * ------------------------------------------------------------------ */

// Each test is a predicate over the features with the weight it carries and a
// plain statement of what it is asserting. A test that holds goes in `for`; a
// test that fails goes in `against`; a test whose feature could not be
// measured goes in neither and its weight leaves the denominator, so a
// hypothesis is never rewarded for a measurement that was not taken.
const ok = (f) => Number.isFinite(f);

export const HYPOTHESES = Object.freeze([
  {
    id: 'carrier',
    label: 'unmodulated carrier (a steady tone)',
    tests: [
      { w: 3, why: 'nearly all the band power is in one line', hold: (f) => f.carrierRatio > 0.6, has: (f) => ok(f.carrierRatio) },
      { w: 2, why: 'the envelope is flat', hold: (f) => f.envDepth < 0.15, has: (f) => ok(f.envDepth) },
      { w: 2, why: 'the envelope has one state, so nothing is being keyed', hold: (f) => !f.envKeyed, has: (f) => ok(f.envGapFraction) },
      { w: 2, why: 'no modulation rate stands above the floor', hold: (f) => f.envRateStrength < 12 && f.ifRateStrength < 12, has: (f) => ok(f.envRateStrength) },
      { w: 1, why: 'the instantaneous frequency sits still', hold: (f) => f.ifSpreadHz < 12, has: (f) => f.ifSpreadHz > 0 },
      { w: 1, why: 'the occupied bandwidth is a line, not a band', hold: (f) => f.occupied99Hz < 80, has: (f) => ok(f.occupied99Hz) },
    ],
  },
  {
    id: 'am-tone',
    label: 'amplitude-modulated tone (AM with carrier)',
    tests: [
      { w: 3, why: 'a dominant line with power on both sides of it', hold: (f) => f.carrierRatio > 0.2 && f.carrierRatio < 0.95, has: (f) => ok(f.carrierRatio) },
      { w: 3, why: 'the sidebands are symmetric about the carrier', hold: (f) => f.sidebandSymmetry > 0.45, has: (f) => f.sidebandSymmetry !== 0 },
      { w: 2, why: 'the envelope varies without switching off', hold: (f) => f.envDepth > 0.12 && f.envSpanDb < 20, has: (f) => ok(f.envDepth) },
      { w: 2, why: 'the carrier never falls to the noise floor', hold: (f) => f.envSpanDb < 20, has: (f) => f.envSpanDb > 0 },
      { w: 3, why: 'the modulation is one sinusoid rather than a switch', hold: (f) => f.modulationTonality > 0.85, has: (f) => f.modulationTonality > 0 },
      { w: 2, why: 'one modulation rate stands clear of the floor', hold: (f) => f.envRateStrength >= 12, has: (f) => ok(f.envRateStrength) },
      { w: 1, why: 'the carrier stays on', hold: (f) => f.dutyCycle > 0.85, has: (f) => ok(f.dutyCycle) },
    ],
  },
  {
    id: 'ook-morse',
    label: 'on-off keyed tone (Morse, or any keyed carrier)',
    tests: [
      { w: 3, why: 'the envelope is two-state: it is on, or it is off, and rarely between', hold: (f) => f.envKeyed, has: (f) => ok(f.envGapFraction) },
      { w: 2, why: 'the off state reaches down toward the noise', hold: (f) => f.envSpanDb > 15, has: (f) => f.envSpanDb > 0 },
      { w: 3, why: 'the keying is a switch, not one sinusoid', hold: (f) => f.modulationTonality < 0.85, has: (f) => f.modulationTonality > 0 },
      { w: 2, why: 'it is on for part of the time, not all of it', hold: (f) => f.dutyCycle > 0.15 && f.dutyCycle < 0.88, has: (f) => ok(f.dutyCycle) },
      { w: 2, why: 'what is keyed holds still: one tone, or a fixed harmonic comb', hold: (f) => f.ifSpreadHz < 60 || (f.lineGridCount >= 3 && f.lineSpacingRegularity > 0.6), has: (f) => f.ifSpreadHz > 0 },
      { w: 2, why: 'a keying rate stands clear of the floor', hold: (f) => f.envRateStrength >= 12 && f.envRateHz > 0.5 && f.envRateHz < 60, has: (f) => ok(f.envRateStrength) },
      { w: 2, why: 'one carrier, not a tone set', hold: (f) => f.lineGridCount < 3 || f.carrierRatio > 0.4, has: (f) => ok(f.lineCount) },
      // Nothing here used to require that there be a carrier at all. White
      // noise gated on and off at 6 Hz has a two-state envelope spanning
      // 30 dB, a clean rate in the keying band and a switch rather than a
      // sinusoid — every test above holds — and was claimed as a keyed carrier
      // in 17 of 24 windows on a score of 0.75. It has no carrier: measured
      // carrierRatio 0.006 against 0.83 for an 18 wpm Morse tone.
      { w: 3, why: 'there is a carrier to key: one line carries the band, or the band is a line', hold: (f) => f.carrierRatio > 0.15 || f.occupied99Hz < 400, has: (f) => ok(f.carrierRatio) },
      { w: 2, why: 'what is keyed is a signal rather than a burst of noise: its envelope is shallower than Rayleigh inside a block', hold: (f) => f.localEnvDepth < RAYLEIGH_DEPTH - 0.12, has: (f) => ok(f.localEnvDepth) },
    ],
  },
  {
    id: 'fsk2',
    label: 'two-tone frequency-shift keying',
    tests: [
      { w: 3, why: 'the instantaneous frequency has exactly two states', hold: (f) => f.ifStateCount === 2 && f.ifValleyDepth > 0.35, has: (f) => f.ifModeCount > 0 },
      { w: 2, why: 'the frequency moves while the envelope stays on', hold: (f) => !f.envKeyed && f.dutyCycle > 0.8, has: (f) => ok(f.envGapFraction) },
      { w: 2, why: 'the spread of the instantaneous frequency is the shift itself', hold: (f) => f.ifShiftHz > 0 && Math.abs(f.ifSpreadHz - f.ifShiftHz) < 0.5 * f.ifShiftHz, has: (f) => f.ifShiftHz > 0 },
      { w: 2, why: 'a symbol rate stands clear of the floor', hold: (f) => f.ifRateStrength >= 12 || f.envRateStrength >= 12, has: (f) => ok(f.ifRateStrength) },
      { w: 2, why: 'two tones, not more', hold: (f) => f.ifStateCount === 2, has: (f) => f.ifStateCount > 0 },
      { w: 1, why: 'the shift is a plausible HF one (20 Hz to 1 kHz)', hold: (f) => f.ifShiftHz > 20 && f.ifShiftHz < 1000, has: (f) => f.ifShiftHz > 0 },
    ],
  },
  {
    id: 'mfsk',
    label: 'multi-tone keying (MFSK or polytone)',
    tests: [
      { w: 3, why: 'three or more lines lie on one evenly spaced grid, more than the search would find by chance', hold: (f) => f.lineGridCount >= 3 && f.lineSpacingRegularity > 0.6 && f.lineGridZ > 3, has: (f) => ok(f.lineCount) },
      { w: 3, why: 'the instantaneous frequency visits more than two values', hold: (f) => f.ifStateCount >= 3, has: (f) => f.ifStateCount > 0 },
      { w: 2, why: 'the frequency moves while the envelope stays on', hold: (f) => !f.envKeyed && f.dutyCycle > 0.7, has: (f) => ok(f.envGapFraction) },
      { w: 2, why: 'the band is several tone spacings wide', hold: (f) => f.lineSpacingHz > 0 && f.occupied99Hz > 2.5 * f.lineSpacingHz, has: (f) => f.lineSpacingHz > 0 },
      { w: 1, why: 'the band is many symbol rates wide, as a tone set is', hold: (f) => f.bandwidthOverRate > 4, has: (f) => Number.isFinite(f.bandwidthOverRate) },
      { w: 2, why: 'the line grid is a tone set, not the comb a switched envelope makes on its own', hold: (f) => !f.pulsedEnvelope, has: (f) => ok(f.lineCount) && ok(f.envRateStrength) },
      // Crashes ring, and the ringing of forty crashes at random frequencies
      // fits a grid: measured, 14 of 24 windows of crash-ridden noise were
      // claimed as a tone set on a score of 0.67. A tone set survives having
      // the band divided by its own local level and a band of noise does not
      // — 0.21 against 0.87-0.92 — and its envelope inside a block is a
      // signal's rather than noise's.
      { w: 2, why: 'the tones survive dividing the band by its own local level; a band of noise flattens to nothing', hold: (f) => f.whitenedFlatness < 0.6, has: (f) => ok(f.whitenedFlatness) },
      { w: 2, why: 'the envelope inside a block is a signal\'s, not the Rayleigh of noise', hold: (f) => f.localEnvDepth < RAYLEIGH_DEPTH - 0.12, has: (f) => ok(f.localEnvDepth) },
    ],
  },
  {
    id: 'ssb-voice',
    label: 'speech (SSB or AM voice)',
    tests: [
      { w: 3, why: 'no single line dominates', hold: (f) => f.carrierRatio < 0.2, has: (f) => ok(f.carrierRatio) },
      { w: 3, why: 'a speech-width band, roughly 300 Hz to 3 kHz', hold: (f) => f.occupied99Hz > 700 && f.occupied99Hz < 4000, has: (f) => ok(f.occupied99Hz) },
      // "the envelope swings widely" used to be envDepth > 0.5 alone, and the
      // envelope of band-limited noise is Rayleigh, whose depth is 0.648. So
      // this test held on every window of nothing that was ever put to it. A
      // syllable is a swing LARGER than the noise inside the band has of its
      // own: measured, synthesised speech reads 0.98 against 0.66 inside a
      // block, and every background reads within 0.15 of its own block depth.
      { w: 2, why: 'the envelope swings more widely than the Rayleigh fluctuation inside a block, which is what a syllable is', hold: (f) => f.envDepth > 0.5 && f.envDepth > f.localEnvDepth + 0.15, has: (f) => ok(f.envDepth) && ok(f.localEnvDepth) },
      { w: 2, why: 'the envelope is not switched; syllables slide', hold: (f) => !f.envKeyed, has: (f) => ok(f.envGapFraction) },
      { w: 2, why: 'the envelope energy is syllabic: more at 2-8 Hz than above 12', hold: (f) => f.syllabicRatio > SYLLABIC_RATIO, has: (f) => f.syllabicRatio > 0 },
      // Everything else this hypothesis asks is true of any wide band with no
      // line in it, which is what a window of noise is. This is the test that
      // is about speech: a talker moves through phonemes and the shape of the
      // band moves with them, while a background only changes its level.
      // Measured 6.4-11.6 dB on synthesised speech against 1.4-2.4 on all four
      // stationary backgrounds.
      { w: 3, why: 'the shape of the band moves from frame to frame by more than twice what its own counting noise gives, as a talker moving through phonemes does and a background does not', hold: (f) => f.tiltSwingOverNull > 2, has: (f) => ok(f.tiltSwingOverNull) },
      { w: 2, why: 'no steady clock; speech is not periodic', hold: (f) => f.envRateStrength < 25 && f.ifRateStrength < 25, has: (f) => ok(f.envRateStrength) },
      { w: 2, why: 'the spectrum is neither a line nor flat noise', hold: (f) => f.spectralFlatness > 0.03 && f.spectralFlatness < 0.6, has: (f) => ok(f.spectralFlatness) },
      { w: 1, why: 'no regular tone set', hold: (f) => f.lineGridCount < 3, has: (f) => ok(f.lineCount) },
    ],
  },
  {
    // WHAT THIS RECOGNISES, stated because it used to claim more than it did:
    // a wide band that is switched on and off at a steady rate between 5 and
    // 120 Hz with a low duty cycle. That is the shape an over-the-horizon
    // radar has in a receiver's audio, and it is also the shape of any other
    // pulsed wideband emitter — this cannot tell you which, and the name is
    // the family, not an identification.
    //
    // Two kinds of pulse train exist and only one of them used to pass. If the
    // pulses are independent bursts of noise, the band between them is flat.
    // If they are the SAME waveform repeated — which a real radar's sweep is,
    // because coherence is the point of it — the spectrum is a comb spaced at
    // the repetition rate and is nothing like flat. The old fourth test
    // required flatness above 0.4 at weight 2 and so half-rejected every
    // coherent emitter. Measured on a synthetic repeated linear sweep, 500 to
    // 3200 Hz, 12% duty, in noise: flatness 0.62 at 10 Hz PRF, 0.13 at 25 Hz,
    // 0.05 at 50 Hz, against 0.82 for an incoherent burst train at the same
    // rate. It is kept at weight 1 because a flat band IS evidence, and when
    // it fails it lands in `against` where it reads as what it is — this one
    // is a repeated waveform, not a noise burst.
    //
    // The rate window was 10 to 100 Hz and is 5 to 120. The old lower edge was
    // a hard boundary sitting exactly on the classic 10 Hz over-the-horizon
    // rate: the same synthetic at 10 Hz PRF measured 9.92 Hz and failed the
    // test on 0.08 Hz, which cost it three weights and dropped it to 0.45,
    // five hundredths above the score at which nothing is claimed at all.
    //
    // The reference is that synthetic and not a recording. The one real
    // over-the-horizon capture this bench had has been withdrawn from the
    // shelf on licence grounds, so there is no measured field example behind
    // any number in this block.
    //
    // The stated limit: this classifies a SPAN that contains many pulses. At a
    // low repetition rate the segmenter bounds each pulse separately — 21
    // components for 12 s at 10 Hz — and one 60 ms pulse carries too little to
    // measure anything from. Give segment() a `bridgeSec` longer than the gap
    // between pulses, or hand the classifier the band's whole span.
    id: 'pulsed-wide',
    label: 'pulsed wideband emitter (over-the-horizon radar and the like)',
    tests: [
      { w: 3, why: 'a wide band, not a line', hold: (f) => f.occupied99Hz > 1500, has: (f) => ok(f.occupied99Hz) },
      { w: 3, why: 'one strong repetition rate between 5 and 120 Hz', hold: (f) => f.envRateStrength >= 12 && f.envRateHz >= 5 && f.envRateHz <= 120, has: (f) => ok(f.envRateStrength) },
      { w: 2, why: 'on for a small fraction of the time', hold: (f) => f.dutyCycle < 0.6, has: (f) => ok(f.dutyCycle) },
      { w: 2, why: 'the envelope switches, and the off state falls away toward the noise', hold: (f) => f.envKeyed && f.envSpanDb > 15, has: (f) => f.envSpanDb > 0 },
      { w: 1, why: 'the band is noise-like inside rather than a repeated waveform', hold: (f) => f.spectralFlatness > 0.4, has: (f) => ok(f.spectralFlatness) },
      { w: 3, why: 'the repetition keeps time: harmonics of the rate survive, which a jittered gate loses', hold: (f) => f.envRateHarmonics >= 1, has: (f) => f.envRateHarmonicsReachable >= 1 },
    ],
  },
  {
    id: 'data-multicarrier',
    label: 'multi-carrier data burst (many tones at once)',
    tests: [
      { w: 3, why: 'six or more lines on one evenly spaced grid, more than the search would find by chance', hold: (f) => f.lineGridCount >= 6 && f.lineSpacingRegularity > 0.6 && f.lineGridZ > 4, has: (f) => ok(f.lineCount) },
      { w: 3, why: 'the instantaneous frequency has no small set of states, because the tones sound together rather than in turn', hold: (f) => f.ifStateCount <= 1, has: (f) => ok(f.ifStateCount) },
      { w: 2, why: 'the envelope is nearly constant and never switched', hold: (f) => !f.envKeyed && f.envSpanDb < 14, has: (f) => f.envSpanDb > 0 },
      { w: 2, why: 'it runs continuously through the burst', hold: (f) => f.dutyCycle > 0.85, has: (f) => ok(f.dutyCycle) },
      { w: 2, why: 'the envelope energy is not syllabic, so it is not speech', hold: (f) => f.syllabicRatio < SYLLABIC_RATIO, has: (f) => f.syllabicRatio > 0 },
      { w: 1, why: 'the band is many tone spacings wide', hold: (f) => f.lineSpacingHz > 0 && f.occupied99Hz > 4 * f.lineSpacingHz, has: (f) => f.lineSpacingHz > 0 },
      { w: 2, why: 'the line grid is a tone set, not the comb a switched envelope makes on its own', hold: (f) => !f.pulsedEnvelope, has: (f) => ok(f.lineCount) && ok(f.envRateStrength) },
      { w: 2, why: 'the tones survive dividing the band by its own local level; a band of noise flattens to nothing', hold: (f) => f.whitenedFlatness < 0.6, has: (f) => ok(f.whitenedFlatness) },
    ],
  },
  {
    // WHAT WENT WRONG HERE, stated because the old version of this block is
    // the reason the module answered confidently on nothing.
    //
    // Every test this hypothesis used to carry was a test for WHITE, STILL
    // noise: a flat spectrum, an envelope depth equal to Rayleigh's over the
    // whole slice, one envelope state, no rate anywhere. Real HF has none of
    // those. 1/f noise is not flat (0.65 measured, exactly on the old cut);
    // noise under a 0.4 Hz fade has an envelope depth of 0.79 and a rate at
    // the fade; noise gated at 6 Hz has a depth of 0.96, two states and a
    // strong rate; noise carrying atmospheric crashes has nine to twenty-four
    // discrete lines, which are the crashes ringing. So on four of the five
    // colours this hypothesis scored below MIN_SCORE and the ranking handed
    // the window to whatever was next. Measured over 24 windows per colour
    // before this rewrite: 19 of 24 fading windows were claimed as speech, 17
    // of 24 gated ones as a keyed carrier, 14 of 24 crash-ridden ones as a
    // tone set.
    //
    // The tests below are the same question asked scale-free. Dividing each
    // bin by the median of its neighbourhood removes any tilt; taking the
    // envelope's depth inside a 50 ms block removes anything the level does
    // between blocks; a Rayleigh depth is a ratio of two quantiles of one
    // distribution and so does not care what the level is. What is left is
    // the only thing that actually separates noise from a transmission: a
    // transmission puts structure INSIDE the band, and noise of every colour
    // does not.
    //
    // The one-sided Rayleigh test is deliberate. Impulses make an envelope
    // deeper than Rayleigh, never shallower — measured 0.92 on crashes — so
    // "at least as deep as noise" holds on all five colours while every
    // transmission measured here reads 0.03 to 0.36. A band-limited NOISE
    // emitter reads 0.63 and is called noise by this, which is the honest
    // answer: nothing in the audio says a noise-like band is a transmission,
    // and segment() reports it as a standing band for exactly that reason.
    id: 'noise',
    label: 'noise — nothing is transmitting here',
    tests: [
      { w: 3, why: 'no peak survives dividing each bin by the median of its own neighbourhood, so the band has colour but no structure', hold: (f) => f.whitenedFlatness > 0.65, has: (f) => ok(f.whitenedFlatness) },
      { w: 3, why: `inside a ${(LOCAL_BLOCK_SEC * 1000).toFixed(0)} ms block the envelope is at least as deep as Rayleigh's ${RAYLEIGH_DEPTH.toFixed(2)}, whatever the level does between blocks`, hold: (f) => f.localEnvDepth > RAYLEIGH_DEPTH - 0.12, has: (f) => ok(f.localEnvDepth) },
      { w: 2, why: 'no single line carries the band', hold: (f) => f.carrierRatio < 0.05, has: (f) => ok(f.carrierRatio) },
      { w: 2, why: 'no discrete line stands above the local level', hold: (f) => f.lineCount === 0, has: (f) => ok(f.lineCount) },
      { w: 1, why: 'the instantaneous frequency wanders across the whole band', hold: (f) => f.ifSpreadHz > 0.2 * f.occupied99Hz, has: (f) => f.ifSpreadHz > 0 },
      // The one thing a background does not have is a clock. A slow level
      // change is not one: measured over 750 windows, 150 per colour, the
      // fastest rate any of the five ever put above the periodicity floor was
      // 5.41 Hz, and white, 1/f and crash-ridden noise never cleared the floor
      // at all — only the fading and the gated backgrounds did, and both of
      // those are the level moving. An incoherent train of NOISE bursts is
      // noise in every other statistic here — flat, no line, Rayleigh inside a
      // block — and this is the only test that separates it from a background,
      // so it carries three weights: without it a 50 Hz burst train and a
      // window of nothing scored 1.00 apiece and the answer was 'unclear'.
      //
      // The floor is 7 Hz and not the 5 the pulsed-wideband hypothesis uses.
      // That is a measured gap and a stated cost: 5.41 Hz is the fastest a
      // background reached and 9.92 Hz the slowest emitter this bench carries
      // (a 10 Hz over-the-horizon synthetic, which reads low), so 7 leaves 1.3x
      // on one side and 1.4x on the other. Below 7 Hz this hypothesis holds
      // alongside pulsed-wide and the two tie, which comes back as 'unclear' —
      // a genuine pulsed emitter running slower than 7 Hz will not be named.
      { w: 3, why: 'nothing is switching the band at the 7-120 Hz rate a pulsed emitter runs at; a background changes its level, it does not keep time', hold: (f) => !(f.envRateStrength >= 12 && f.envRateHz >= 7 && f.envRateHz <= 120), has: (f) => ok(f.envRateStrength) },
    ],
  },
]);

/**
 * Score every hypothesis against one feature set and rank them.
 *
 * A score is (weight held - weight failed) / weight measurable, so it runs
 * -1 to +1 and a hypothesis with untestable features is neither helped nor
 * hurt by them. `verdict` is the leader's id only when it clears MIN_SCORE and
 * beats the runner-up by MIN_MARGIN; otherwise it is 'unclear', with the two
 * contenders named in `why`.
 */
export function classify(features, opts = {}) {
  if (!features) return { verdict: 'unclear', why: 'no features could be measured', ranked: [], features: null };
  const minScore = finite(opts.minScore, MIN_SCORE);
  const minMargin = finite(opts.minMargin, MIN_MARGIN);
  const ranked = HYPOTHESES.map((h) => {
    const forEv = [], againstEv = [], untested = [];
    let held = 0, failed = 0, measurable = 0;
    for (const t of h.tests) {
      let has = false;
      try { has = !!t.has(features); } catch { has = false; }
      if (!has) { untested.push(t.why); continue; }
      measurable += t.w;
      let pass = false;
      try { pass = !!t.hold(features); } catch { pass = false; }
      if (pass) { held += t.w; forEv.push({ weight: t.w, claim: t.why }); }
      else { failed += t.w; againstEv.push({ weight: t.w, claim: t.why }); }
    }
    return {
      id: h.id, label: h.label,
      score: measurable > 0 ? (held - failed) / measurable : 0,
      support: held, contradiction: failed, measurable,
      for: forEv, against: againstEv, untested,
    };
  }).sort((a, b) => b.score - a.score);

  const top = ranked[0], next = ranked[1];
  let verdict = top.id, why = `${top.label}: ${top.for.length} of ${top.for.length + top.against.length} tests hold`;
  if (top.score < minScore) {
    verdict = 'unclear';
    why = `nothing scores above ${minScore}; the closest is ${top.label} at ${top.score.toFixed(2)}`;
  } else if (next && top.score - next.score < minMargin) {
    verdict = 'unclear';
    why = `${top.label} (${top.score.toFixed(2)}) and ${next.label} (${next.score.toFixed(2)}) are within ${minMargin} of each other`;
  }
  return { verdict, why, ranked, top, features, notes: features.notes || [] };
}

/** Features and verdict in one call, for a detection from segment(). */
export function classifySegment(mono, sampleRate, detection, opts = {}) {
  const f = extractFeatures(mono, sampleRate, detection, opts);
  return classify(f, opts);
}
