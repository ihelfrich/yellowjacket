// Role-aware time stretching. docs/CONTRACT-CONFORM.md section 1.
// Pure and worker-safe: no DOM, no Web Audio, no state carried between calls,
// so the same arguments always bake the same buffer.
//
// Two engines, chosen by the role HARVEST already assigned to the slice, so the
// stretcher never has to guess what kind of sound it is holding.
//
// PERCUSSIVE is WSOLA: 40 ms frames are copied whole and only their alignment
// moves, chosen by normalized cross-correlation against the tail already
// written, so an attack is never smeared across a join. On top of plain WSOLA
// the frame grid is anchored to detected onsets. That is not decoration: any
// frame-based stretcher places a transient sitting u samples into its analysis
// frame at c*ratio - u*(ratio-1), so at ratio 2 a lone click lands up to a full
// frame (40 ms) early and the +/- 10 ms similarity search cannot pull it back.
// Restarting the grid on each onset puts every attack on its exact output time
// and leaves WSOLA to stretch the decay between attacks, which is the only way
// this path meets the contract's own 5 ms click-placement acceptance test.
//
// TONAL is a phase vocoder with identity phase locking (Laroche and Dolson,
// "Improved Phase Vocoder Time-Scale Modification of Audio", IEEE Trans. Speech
// and Audio Processing 7(3), 1999, section IV-A): only spectral peaks integrate
// their own phase, and every bin inside a peak's region of influence takes that
// peak's phase rotation. Bins around a partial therefore stay in the phase
// relationship the analysis found, which is what removes the classic
// phase-vocoder chorus smear on held notes.

import { FFT, hann } from '../fft.js';
import { resample } from './resample.js';

export const STRETCH_MODES = ['auto', 'percussive', 'tonal', 'resample'];
export const MIN_RATIO = 0.25;
export const MAX_RATIO = 4;

const PERCUSSIVE_ROLES = ['KICK', 'SNARE', 'HAT'];

const FRAME_SEC = 0.040;         // WSOLA frame length
const SEARCH_SEC = 0.010;        // WSOLA similarity search, +/- this much
const COARSE_STRIDE = 4;         // search grid + correlation decimation; 1 = exhaustive
const ANCHOR_FADE_SEC = 0.002;   // cross-fade running into a transient anchor
const ONSET_BLOCK = 256;         // ~5.8 ms at 44.1 kHz
const ONSET_HISTORY = 8;         // ~46 ms of context behind each block
const ONSET_RISE = 8;            // 9 dB jump over that context
const ONSET_FLOOR_REL = 1e-4;    // and at least -40 dB from the loudest block
const FFT_SIZE = 2048;
const ANALYSIS_HOP = 512;        // contract hop; synthesis hop = round(this * ratio)
const MAX_SYNTH_HOP = FFT_SIZE / 2;
const PEAK_REL_FLOOR = 1e-5;     // peaks below this fraction of the frame max are noise
const NORM_FLOOR = 1e-9;
// Coverage below this fraction of the layout's steady state is a partially
// covered edge, not signal: dividing by it manufactures a full-scale burst.
const NORM_REL_FLOOR = 1e-3;
const TWO_PI = Math.PI * 2;

// role -> engine. Everything that is not a drum hit is treated as pitched,
// including CRASH (a cymbal is a long inharmonic tail, and WSOLA on a 3 s
// wash sounds like a stutter) and any role the caller does not recognise.
export function stretchMode(role) {
  const key = typeof role === 'string' ? role.toUpperCase() : '';
  return PERCUSSIVE_ROLES.indexOf(key) >= 0 ? 'percussive' : 'tonal';
}

export function stretchSamples(samples, ratio, sampleRate, opts) {
  const input = sanitize(samples);
  const r = clampRatio(ratio);
  const outLen = Math.round(input.length * r);
  if (outLen <= 0) return new Float32Array(0);
  // Ratio 1 is bit-for-bit passthrough on every mode: that is what makes
  // leaving CONFORM switched on safe.
  if (r === 1) return input;
  const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100;
  const options = opts || {};
  let mode = STRETCH_MODES.indexOf(options.mode) >= 0 ? options.mode : 'auto';
  if (mode === 'auto') mode = stretchMode(options.role);
  if (mode === 'resample') return finalize(rateChange(input, r), outLen);
  if (mode === 'percussive') return finalize(wsola(input, r, sr, outLen), outLen);
  return finalize(phaseVocoder(input, r, outLen), outLen);
}

// NaN and non-numbers mean "no fit was asked for", which is ratio 1. Infinities
// clamp like any other out-of-range number.
function clampRatio(ratio) {
  if (typeof ratio !== 'number' || Number.isNaN(ratio)) return 1;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

// Always returns a fresh Float32Array with finite values, so a damaged buffer
// cannot leak a NaN into the machine's audio graph through any path.
function sanitize(samples) {
  const n = samples && samples.length > 0 ? samples.length | 0 : 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    if (Number.isFinite(v)) out[i] = v;
  }
  return out;
}

// One pass that enforces the contract's exact output length (pad or trim the
// last partial frame) and guarantees finite output on every engine.
function finalize(raw, outLen) {
  const out = new Float32Array(outLen);
  const n = Math.min(outLen, raw.length);
  for (let i = 0; i < n; i++) {
    const v = raw[i];
    if (Number.isFinite(v)) out[i] = v;
  }
  return out;
}

// The honest escape hatch: a plain rate change, so pitch moves with length.
// resample() only reads the ratio of the two rates, so passing 1 -> r makes its
// own output length exactly round(input.length * r).
function rateChange(input, r) {
  return resample(input, 1, r);
}

// --- WSOLA ------------------------------------------------------------------

// Normalized cross-correlation between the candidate source window and the tail
// already written. stride > 1 samples both windows sparsely for the coarse pass.
function correlate(input, src, tail, tailAt, len, stride) {
  let dot = 0;
  let ea = 0;
  let eb = 0;
  for (let i = 0; i < len; i += stride) {
    const a = tail[tailAt + i];
    const b = input[src + i];
    dot += a * b;
    ea += a * a;
    eb += b * b;
  }
  const denom = Math.sqrt(ea * eb);
  return denom > 1e-20 ? dot / denom : 0;
}

// Coarse grid at COARSE_STRIDE, then full resolution within one grid cell of the
// winner. Offset 0 is the incumbent and ties keep it, so silence and any other
// flat correlation surface leave the nominal time map alone.
function bestOffset(input, nominal, tail, tailAt, len, lo, hi) {
  let best = 0;
  let score = correlate(input, nominal, tail, tailAt, len, COARSE_STRIDE);
  for (let d = lo; d <= hi; d += COARSE_STRIDE) {
    if (d === 0) continue;
    const s = correlate(input, nominal + d, tail, tailAt, len, COARSE_STRIDE);
    if (s > score) {
      score = s;
      best = d;
    }
  }
  if (COARSE_STRIDE === 1) return best;
  let fine = best;
  let fineScore = correlate(input, nominal + best, tail, tailAt, len, 1);
  for (let d = best - COARSE_STRIDE; d <= best + COARSE_STRIDE; d++) {
    if (d === best || d < lo || d > hi) continue;
    const s = correlate(input, nominal + d, tail, tailAt, len, 1);
    if (s > fineScore) {
      fineScore = s;
      fine = d;
    }
  }
  return fine;
}

// Time-domain onset detector, only precise enough to anchor attacks: block
// energy against the running level of the blocks just behind it, refined to the
// sample where the rise actually starts. Missing an onset costs a little smear,
// inventing one costs a 2 ms cross-fade, so the threshold sits deliberately high.
function detectOnsets(input, minGap) {
  const n = input.length;
  const blocks = Math.floor(n / ONSET_BLOCK);
  if (blocks < ONSET_HISTORY + 2) return [];
  const energy = new Float64Array(blocks);
  let loudest = 0;
  for (let b = 0; b < blocks; b++) {
    const at = b * ONSET_BLOCK;
    let e = 0;
    for (let i = 0; i < ONSET_BLOCK; i++) {
      const v = input[at + i];
      e += v * v;
    }
    e /= ONSET_BLOCK;
    energy[b] = e;
    if (e > loudest) loudest = e;
  }
  if (loudest <= 0) return [];
  const floor = loudest * ONSET_FLOOR_REL;
  const onsets = [];
  let last = -minGap;
  for (let b = ONSET_HISTORY; b < blocks; b++) {
    if (energy[b] < floor) continue;
    let context = 0;
    for (let h = 1; h <= ONSET_HISTORY; h++) context += energy[b - h];
    context /= ONSET_HISTORY;
    if (energy[b] < context * ONSET_RISE) continue;
    const at = b * ONSET_BLOCK;
    let localPeak = 0;
    for (let i = 0; i < ONSET_BLOCK; i++) {
      const v = Math.abs(input[at + i]);
      if (v > localPeak) localPeak = v;
    }
    let pos = at;
    for (let i = Math.max(-at, -32); i < ONSET_BLOCK; i++) {
      if (Math.abs(input[at + i]) >= localPeak * 0.25) {
        pos = at + i;
        break;
      }
    }
    pos = Math.max(0, pos - 2);
    if (pos - last < minGap) continue;
    onsets.push(pos);
    last = pos;
  }
  return onsets;
}

function wsola(input, ratio, sampleRate, outLen) {
  const n = input.length;
  const frame = Math.max(16, Math.round(FRAME_SEC * sampleRate));
  const search = Math.max(1, Math.round(SEARCH_SEC * sampleRate));
  // Below one frame plus the search window there is nothing to align against.
  if (n < frame + 2 * search) return rateChange(input, ratio);
  const hs = frame >> 1;                     // 50% overlap: the raised-cosine
  const overlap = frame - hs;                // cross-fade pair sums to exactly 1
  const maxPos = n - frame;
  const fadeIn = new Float32Array(overlap);
  for (let i = 0; i < overlap; i++) {
    fadeIn[i] = 0.5 - 0.5 * Math.cos((Math.PI * i) / (overlap - 1));
  }
  const anchorFade = Math.max(1, Math.round(ANCHOR_FADE_SEC * sampleRate));
  // Anchor 0 is the head of the slice; every detected attack after it restarts
  // the frame grid at its exact output time, round(onset * ratio).
  const anchors = [0];
  for (const o of detectOnsets(input, frame)) {
    if (o >= frame && o <= maxPos) anchors.push(o);
  }
  const out = new Float32Array(outLen + frame);

  for (let a = 0; a < anchors.length; a++) {
    const o = anchors[a];
    const q = a === 0 ? 0 : Math.round(o * ratio);
    if (q >= outLen) break;
    const nextOnset = a + 1 < anchors.length ? anchors[a + 1] : n;
    const segEnd = a + 1 < anchors.length ? Math.min(outLen, Math.round(nextOnset * ratio)) : outLen;
    // A segment never reads past the attack that ends it, or the frames filling
    // one decay would paste the next hit in early as a pre-echo. Onsets are at
    // least one frame apart, so this limit always leaves a whole frame to read.
    const limit = Math.min(maxPos, nextOnset - frame);
    // Run into the anchor with a short cross-fade taken from the input's own
    // pre-attack, then hard-copy the attack itself so nothing softens it.
    const fade = Math.min(anchorFade, q, o);
    for (let i = 0; i < fade; i++) {
      const w = (i + 1) / (fade + 1);
      const at = q - fade + i;
      out[at] = out[at] * (1 - w) + input[o - fade + i] * w;
    }
    const copy = Math.min(frame, n - o);
    for (let i = 0; i < copy; i++) out[q + i] = input[o + i];
    for (let i = copy; i < frame; i++) out[q + i] = 0;

    for (let ps = q + hs; ps < segEnd; ps += hs) {
      // Analysis position read straight off this segment's synthesis grid, so
      // the time map is exact per frame and alignment never accumulates drift.
      const nominal = Math.min(limit, Math.max(o, o + Math.round((ps - q) / ratio)));
      const lo = Math.max(-search, o - nominal);
      const hi = Math.min(search, limit - nominal);
      const src = nominal + bestOffset(input, nominal, out, ps, overlap, lo, hi);
      for (let i = 0; i < overlap; i++) {
        const w = fadeIn[i];
        out[ps + i] = out[ps + i] * (1 - w) + input[src + i] * w;
      }
      out.set(input.subarray(src + overlap, src + frame), ps + overlap);
    }
  }
  return out;
}

// --- phase vocoder ----------------------------------------------------------

function princarg(x) {
  return x - TWO_PI * Math.round(x / TWO_PI);
}

// Whole-sample symmetric reflection, used to extend the input past both ends so
// the first and last output samples get full overlap-add coverage. Zero padding
// would ramp the edges down instead, which on a bar-locked bass slice is worse
// than the reflection.
function reflectIndex(i, n) {
  if (n === 1) return 0;
  const period = 2 * n - 2;
  let m = i % period;
  if (m < 0) m += period;
  return m < n ? m : period - m;
}

function phaseVocoder(input, ratio, outLen) {
  const n = input.length;
  const N = FFT_SIZE;
  if (n < N) return rateChange(input, ratio);
  const half = N >> 1;
  // Synthesis hop is round(512 * ratio) as specified, capped at N/2: past 50%
  // overlap the Hann-squared overlap-add envelope develops nulls and the
  // normalization below would divide by nothing.
  const hs = Math.min(MAX_SYNTH_HOP, Math.max(1, Math.round(ANALYSIS_HOP * ratio)));
  const win = hann(N);
  const fft = new FFT(N);

  const headFrames = Math.ceil((N - hs) / hs);
  // The budget must be symmetric. headFrames are prepended so output sample 0
  // sits under full overlap-add coverage; without the SAME allowance at the
  // end, the last hop is covered by one decaying window while the WOLA divisor
  // still assumes steady state. Measured before this fix: the divisor fell to
  // 7.2e-9 against a steady state of 1.58, so the residual was multiplied by
  // 1.4e8 and a -6 dBFS noise buffer ended at +52.6 dBFS (856x input peak) in
  // its final synthesis hop. 100% of realistic CONFORM fits overshot.
  const bodyFrames = Math.max(1, Math.ceil((outLen - N) / hs) + 1) + headFrames;
  const total = headFrames + bodyFrames;
  const headPad = Math.ceil((headFrames * hs) / ratio) + 1;
  const tailPad = N + 1;

  const pad = new Float32Array(headPad + n + tailPad);
  pad.set(input, headPad);
  for (let i = 0; i < headPad; i++) pad[i] = input[reflectIndex(i - headPad, n)];
  for (let i = 0; i < tailPad; i++) pad[headPad + n + i] = input[reflectIndex(n + i, n)];

  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const mag = new Float64Array(half + 1);
  const anaPhase = new Float64Array(half + 1);
  const prevPhase = new Float64Array(half + 1);
  const synPhase = new Float64Array(half + 1);
  const advance = new Float64Array(half + 1);
  const owner = new Int32Array(half + 1);
  const peaks = new Int32Array(half + 1);

  const rawLen = (total - 1) * hs + N;
  const acc = new Float64Array(rawLen);
  const norm = new Float64Array(rawLen);
  let prevPa = 0;

  for (let k = 0; k < total; k++) {
    // Analysis position derived from the synthesis grid rather than a fixed
    // integer analysis hop: the time map stays exact at any ratio, and the
    // phase math below uses the actual per-frame hop it produces.
    const pa = Math.min(n, Math.max(-headPad, Math.round(((k - headFrames) * hs) / ratio)));
    const base = pa + headPad;
    for (let j = 0; j < N; j++) {
      re[j] = pad[base + j] * win[j];
      im[j] = 0;
    }
    fft.forward(re, im);
    let maxMag = 0;
    for (let b = 0; b <= half; b++) {
      const xr = re[b];
      const xi = im[b];
      const m = Math.sqrt(xr * xr + xi * xi);
      mag[b] = m;
      anaPhase[b] = Math.atan2(xi, xr);
      if (m > maxMag) maxMag = m;
    }

    if (k === 0) {
      for (let b = 0; b <= half; b++) synPhase[b] = anaPhase[b];
    } else {
      const hopA = Math.max(1, pa - prevPa);
      const scale = hs / hopA;
      for (let b = 0; b <= half; b++) {
        const expected = (TWO_PI * b * hopA) / N;
        const dev = princarg(anaPhase[b] - prevPhase[b] - expected);
        advance[b] = (expected + dev) * scale;    // true frequency, retimed
      }

      // Spectral peaks: strictly larger than its two neighbours either side.
      const floor = maxMag * PEAK_REL_FLOOR;
      let peakCount = 0;
      for (let b = 2; b <= half - 2; b++) {
        const m = mag[b];
        if (m > floor && m > mag[b - 1] && m > mag[b - 2] && m > mag[b + 1] && m > mag[b + 2]) {
          peaks[peakCount++] = b;
        }
      }
      // Region of influence: every bin belongs to the nearer of the two peaks
      // that bracket it.
      owner.fill(-1);
      for (let i = 0; i < peakCount; i++) {
        const p = peaks[i];
        const lo = i === 0 ? 0 : ((peaks[i - 1] + p) >> 1) + 1;
        const hi = i === peakCount - 1 ? half : (p + peaks[i + 1]) >> 1;
        for (let b = lo; b <= hi; b++) owner[b] = p;
      }
      // Peaks integrate; their regions are rotated by the peak's rotation.
      // This is the identity locking of Laroche and Dolson 1999 IV-A.
      for (let i = 0; i < peakCount; i++) {
        const p = peaks[i];
        synPhase[p] = princarg(synPhase[p] + advance[p]);
      }
      for (let b = 0; b <= half; b++) {
        const p = owner[b];
        if (p < 0) synPhase[b] = princarg(synPhase[b] + advance[b]);
        else if (p !== b) synPhase[b] = princarg(anaPhase[b] + (synPhase[p] - anaPhase[p]));
      }
    }

    prevPa = pa;
    for (let b = 0; b <= half; b++) prevPhase[b] = anaPhase[b];

    for (let b = 0; b <= half; b++) {
      const m = mag[b];
      const p = synPhase[b];
      re[b] = m * Math.cos(p);
      im[b] = m * Math.sin(p);
    }
    im[0] = 0;
    im[half] = 0;
    for (let b = 1; b < half; b++) {
      re[N - b] = re[b];
      im[N - b] = -im[b];
    }
    fft.inverse(re, im);

    const at = k * hs;
    for (let j = 0; j < N; j++) {
      const w = win[j];
      acc[at + j] += re[j] * w;
      norm[at + j] += w * w;
    }
  }

  // Weighted overlap-add: dividing by the accumulated analysis*synthesis window
  // energy is exact for unmodified frames at any hop, so gain does not depend on
  // the ratio.
  const offset = headFrames * hs;
  // Steady-state coverage for this layout, sampled where overlap is complete.
  let normPeak = 0;
  for (let i = 0; i < outLen; i++) {
    const d = norm[offset + i];
    if (d > normPeak) normPeak = d;
  }
  const normGuard = Math.max(NORM_FLOOR, normPeak * NORM_REL_FLOOR);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const d = norm[offset + i];
    // Relative guard: an absolute floor lets a divisor of 7e-9 through while
    // steady state is ~1.6, which is exactly how the tail spike escaped.
    out[i] = d > normGuard ? acc[offset + i] / d : 0;
  }
  return out;
}
