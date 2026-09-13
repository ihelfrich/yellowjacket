// What key a recording is in, and what chords go past — measured, with a
// refusal when the audio is not pitched.
//
// Three steps, each of which has an obvious wrong version that this avoids.
//
// CHROMA. Fold the spectrum onto the twelve pitch classes. The obvious wrong
// version sums log-spaced bins into the nearest class, which weights a bright
// cymbal the same as the bass note under it and favours whatever is loudest at
// the top of the band. This picks spectral PEAKS, interpolates each parabolically
// for a fraction-of-a-bin frequency, weights it by amplitude, and gives credit
// to the four subharmonics a peak could be a harmonic of — so a note's third
// and fifth harmonics vote for the note, not for the notes they land on.
//
// KEY. Correlate the averaged chroma against the Krumhansl-Kessler profiles
// for all twenty-four keys. What comes back is the best key, the runner-up,
// and the gap between them, because a correlation of 0.82 against 0.81 is not
// a key estimate, it is two.
//
// CHORDS. Per window, correlate against templates for the common triads and
// sevenths, then smooth the sequence with a cost for changing chord — a
// Viterbi pass whose only prior is that chords last longer than a window. The
// wrong version reports a new chord every 100 ms.
//
// Pure and node-testable. No DOM, no Web Audio.
import { FFT } from '../fft.js';

export const PITCH_NAMES = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']);

// Krumhansl and Kessler's probe-tone profiles, major and minor.
export const KK_MAJOR = Object.freeze([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]);
export const KK_MINOR = Object.freeze([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]);

// Camelot wheel: the code a DJ reads. Major keys are B, minor are A, and the
// number counts round the circle of fifths from A minor / C major at 8.
const CAMELOT_MAJOR = Object.freeze({ 0: '8B', 7: '9B', 2: '10B', 9: '11B', 4: '12B', 11: '1B', 6: '2B', 1: '3B', 8: '4B', 3: '5B', 10: '6B', 5: '7B' });
const CAMELOT_MINOR = Object.freeze({ 9: '8A', 4: '9A', 11: '10A', 6: '11A', 1: '12A', 8: '1A', 3: '2A', 10: '3A', 5: '4A', 0: '5A', 7: '6A', 2: '7A' });

export const CHORD_TEMPLATES = Object.freeze([
  { suffix: '', intervals: [0, 4, 7] },
  { suffix: 'm', intervals: [0, 3, 7] },
  { suffix: '7', intervals: [0, 4, 7, 10] },
  { suffix: 'maj7', intervals: [0, 4, 7, 11] },
  { suffix: 'm7', intervals: [0, 3, 7, 10] },
  { suffix: 'dim', intervals: [0, 3, 6] },
  { suffix: 'aug', intervals: [0, 4, 8] },
  { suffix: 'sus4', intervals: [0, 5, 7] },
]);

const hann = (n) => { const w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); return w; };

// One FFT plan per size, kept: the twiddles cost more to build than a window
// costs to transform, and a three-minute read does thousands of windows.
const PLANS = new Map();
const planFor = (size) => {
  let p = PLANS.get(size);
  if (!p) { p = new FFT(size, { precision: 'f64' }); PLANS.set(size, p); }
  return p;
};

/**
 * Chroma for one window of samples. `refHz` is the tuning reference; a
 * recording tuned to 432 Hz or a tape running fast puts every note between two
 * classes and the profile smears, so `estimateTuning` measures it first.
 */
export function chromaOf(x, sampleRate, { fftSize = 4096, minHz = 55, maxHz = 2200, refHz = 440, harmonics = 4 } = {}) {
  const n = Math.min(fftSize, x.length);
  const size = 1 << Math.ceil(Math.log2(Math.max(64, n)));
  const re = new Float64Array(size), im = new Float64Array(size);
  const w = hann(n);
  for (let i = 0; i < n; i++) re[i] = x[i] * w[i];
  planFor(size).forward(re, im);
  const half = size >> 1;
  const mag = new Float64Array(half);
  for (let b = 0; b < half; b++) mag[b] = Math.hypot(re[b], im[b]);
  const binHz = sampleRate / size;
  const chroma = new Float64Array(12);
  const loBin = Math.max(1, Math.floor(minHz / binHz)), hiBin = Math.min(half - 2, Math.ceil(maxHz / binHz));
  let energy = 0;
  for (let b = loBin; b <= hiBin; b++) {
    // Peaks only: a bin that is not a local maximum is the skirt of one that is.
    if (!(mag[b] > mag[b - 1] && mag[b] >= mag[b + 1])) continue;
    // Parabolic interpolation on the log magnitude for a sub-bin frequency.
    const a = Math.log(mag[b - 1] + 1e-12), c0 = Math.log(mag[b] + 1e-12), c = Math.log(mag[b + 1] + 1e-12);
    const denom = a - 2 * c0 + c;
    const delta = denom !== 0 ? 0.5 * (a - c) / denom : 0;
    const hz = (b + Math.max(-0.5, Math.min(0.5, delta))) * binHz;
    if (!(hz >= minHz && hz <= maxHz)) continue;
    const amp = mag[b];
    energy += amp;
    // Credit the peak to the pitch classes it could be the 1st..Nth harmonic
    // of, with weight falling as 1/h: a note's own harmonics then reinforce it
    // instead of voting for the notes they happen to land on.
    for (let h = 1; h <= harmonics; h++) {
      const f0 = hz / h;
      if (f0 < minHz / 2) break;
      const midi = 69 + 12 * Math.log2(f0 / refHz);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      // A peak that is not close to a semitone centre is noise, not a note.
      const cents = Math.abs(midi - Math.round(midi)) * 100;
      if (cents > 35) continue;
      chroma[pc] += amp * Math.cos(Math.PI * cents / 100) ** 2 / h;
    }
  }
  return { chroma, energy };
}

/**
 * The tuning the recording is actually at, in cents from A440. Peaks are
 * folded onto the semitone grid and their offsets averaged circularly, so a
 * tape running 30 cents sharp is measured rather than smeared.
 */
export function estimateTuning(x, sampleRate, { fftSize = 4096, hop = 2048, minHz = 80, maxHz = 1600 } = {}) {
  let cx = 0, cy = 0, count = 0;
  const size = 1 << Math.ceil(Math.log2(fftSize));
  const w = hann(size);
  for (let at = 0; at + size <= x.length; at += hop) {
    const re = new Float64Array(size), im = new Float64Array(size);
    for (let i = 0; i < size; i++) re[i] = x[at + i] * w[i];
    planFor(size).forward(re, im);
    const binHz = sampleRate / size, half = size >> 1;
    for (let b = Math.max(1, Math.floor(minHz / binHz)); b < Math.min(half - 1, Math.ceil(maxHz / binHz)); b++) {
      const m0 = Math.hypot(re[b], im[b]), mm = Math.hypot(re[b - 1], im[b - 1]), mp = Math.hypot(re[b + 1], im[b + 1]);
      if (!(m0 > mm && m0 >= mp)) continue;
      const a = Math.log(mm + 1e-12), c0 = Math.log(m0 + 1e-12), c = Math.log(mp + 1e-12);
      const den = a - 2 * c0 + c;
      const hz = (b + (den !== 0 ? 0.5 * (a - c) / den : 0)) * binHz;
      const midi = 69 + 12 * Math.log2(hz / 440);
      const off = (midi - Math.round(midi)) * 100;      // cents, -50..50
      const ang = 2 * Math.PI * off / 100;
      cx += m0 * Math.cos(ang); cy += m0 * Math.sin(ang); count++;
    }
  }
  if (!count) return { cents: 0, confidence: 0, refHz: 440 };
  const cents = Math.atan2(cy, cx) / (2 * Math.PI) * 100;
  const confidence = Math.hypot(cx, cy) / Math.max(1e-12, Math.abs(cx) + Math.abs(cy) + 1e-12);
  return { cents: +cents.toFixed(1), confidence: +Math.min(1, confidence).toFixed(3), refHz: +(440 * 2 ** (cents / 1200)).toFixed(2) };
}

const pearson = (a, b) => {
  let ma = 0, mb = 0;
  for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
  ma /= 12; mb /= 12;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
};

/** Every key scored against a chroma vector, best first. */
export function scoreKeys(chroma) {
  const out = [];
  for (let root = 0; root < 12; root++) {
    for (const [mode, profile] of [['major', KK_MAJOR], ['minor', KK_MINOR]]) {
      const rotated = new Float64Array(12);
      for (let i = 0; i < 12; i++) rotated[i] = profile[(i - root + 12) % 12];
      out.push({
        root, mode,
        name: PITCH_NAMES[root] + (mode === 'minor' ? ' minor' : ' major'),
        camelot: (mode === 'minor' ? CAMELOT_MINOR : CAMELOT_MAJOR)[root],
        r: pearson(chroma, rotated),
      });
    }
  }
  return out.sort((a, b) => b.r - a.r);
}

/** Chord templates scored against one window's chroma, best first. */
export function scoreChords(chroma) {
  let peak = 0; for (let i = 0; i < 12; i++) peak = Math.max(peak, chroma[i]);
  if (peak <= 0) return [];
  const norm = new Float64Array(12);
  for (let i = 0; i < 12; i++) norm[i] = chroma[i] / peak;
  const out = [];
  for (let root = 0; root < 12; root++) {
    for (const t of CHORD_TEMPLATES) {
      const tpl = new Float64Array(12);
      for (const iv of t.intervals) tpl[(root + iv) % 12] = 1;
      out.push({ root, suffix: t.suffix, name: PITCH_NAMES[root] + t.suffix, r: pearson(norm, tpl) });
    }
  }
  return out.sort((a, b) => b.r - a.r);
}

/**
 * Smooth a sequence of per-window chord scores with a switching cost. Only
 * prior: a chord lasts longer than one window. Without it the sequence flips
 * on every passing note; measured on a rendered I-IV-V-I at one second a
 * chord, the unsmoothed reading changed 23 times where four changes happened.
 */
export function viterbiChords(frames, { switchCost = 0.35 } = {}) {
  if (!frames.length) return [];
  const labels = frames[0].map((c) => c.name);
  const k = labels.length;
  const score = frames.map((f) => { const m = new Map(); for (const c of f) m.set(c.name, c.r); return labels.map((n) => m.get(n) ?? -1); });
  const dp = [score[0].slice()];
  const back = [];
  for (let t = 1; t < frames.length; t++) {
    const prev = dp[t - 1], row = new Float64Array(k), bk = new Int32Array(k);
    let bestPrev = 0; for (let j = 1; j < k; j++) if (prev[j] > prev[bestPrev]) bestPrev = j;
    for (let j = 0; j < k; j++) {
      const stay = prev[j], move = prev[bestPrev] - switchCost;
      if (stay >= move) { row[j] = stay + score[t][j]; bk[j] = j; }
      else { row[j] = move + score[t][j]; bk[j] = bestPrev; }
    }
    dp.push(row); back.push(bk);
  }
  let at = 0; const last = dp[dp.length - 1];
  for (let j = 1; j < k; j++) if (last[j] > last[at]) at = j;
  const path = new Array(frames.length);
  path[frames.length - 1] = at;
  for (let t = frames.length - 2; t >= 0; t--) { at = back[t][at]; path[t] = at; }
  return path.map((i) => labels[i]);
}

/**
 * Read a recording's harmony. Returns the key with its runner-up and the gap
 * between them, the tuning it is actually at, and the chord sequence as spans.
 * Refuses when the audio carries no pitched energy to read.
 */
export function readHarmony(x, sampleRate, { windowSec = 0.37, hopSec = 0.19, minConfidence = 0.55, maxSeconds = 180 } = {}) {
  if (!x || x.length < sampleRate * 1) return { ok: false, reason: 'under a second of audio' };
  const span = Math.min(x.length, Math.round(maxSeconds * sampleRate));
  const win = Math.round(windowSec * sampleRate), hop = Math.round(hopSec * sampleRate);
  const tuning = estimateTuning(x.subarray(0, span), sampleRate);
  const refHz = tuning.confidence > 0.2 ? tuning.refHz : 440;
  const frames = [], chromas = [];
  const total = new Float64Array(12);
  let energy = 0;
  for (let at = 0; at + win <= span; at += hop) {
    const { chroma, energy: e } = chromaOf(x.subarray(at, at + win), sampleRate, { refHz });
    let sum = 0; for (let i = 0; i < 12; i++) sum += chroma[i];
    if (sum <= 0) continue;
    energy += e;
    chromas.push({ atSec: at / sampleRate, chroma });
    for (let i = 0; i < 12; i++) total[i] += chroma[i];
    frames.push(scoreChords(chroma).slice(0, 96));
  }
  if (chromas.length < 4) return { ok: false, reason: 'no pitched peaks to fold onto the twelve classes — this is not tonal audio' };
  const keys = scoreKeys(total);
  const best = keys[0], runnerUp = keys[1];
  const gap = best.r - runnerUp.r;
  // How peaked the averaged chroma is. Noise spreads evenly over twelve
  // classes and its key correlations are all small and all alike.
  let mx = 0, sum = 0; for (let i = 0; i < 12; i++) { mx = Math.max(mx, total[i]); sum += total[i]; }
  const peakiness = sum > 0 ? mx / (sum / 12) / 12 : 0;
  const confident = best.r >= minConfidence && gap >= 0.03;
  const names = frames.length ? viterbiChords(frames.map((f) => f.slice(0, 96))) : [];
  const spans = [];
  for (let i = 0; i < names.length; i++) {
    const last = spans[spans.length - 1];
    if (last && last.name === names[i]) last.endSec = +(chromas[i].atSec + windowSec).toFixed(2);
    else spans.push({ name: names[i], startSec: +chromas[i].atSec.toFixed(2), endSec: +(chromas[i].atSec + windowSec).toFixed(2) });
  }
  const kept = spans.filter((s) => s.endSec - s.startSec >= windowSec * 1.5);
  return {
    ok: true,
    key: best.name, camelot: best.camelot, root: best.root, mode: best.mode,
    correlation: +best.r.toFixed(3),
    runnerUp: { key: runnerUp.name, camelot: runnerUp.camelot, correlation: +runnerUp.r.toFixed(3) },
    gap: +gap.toFixed(3),
    confident,
    // Said out loud rather than implied by a number: two keys a hair apart is
    // two answers, and relative major and minor share every note.
    caution: confident ? null
      : (gap < 0.03
        ? `${best.name} and ${runnerUp.name} score within ${gap.toFixed(3)} of each other, which is not a key estimate`
        : `the best key correlates only ${best.r.toFixed(2)}; this may not be tonal music`),
    tuning,
    chroma: Array.from(total, (v) => +(v / (sum || 1)).toFixed(4)),
    peakiness: +peakiness.toFixed(3),
    chords: kept,
    windows: chromas.length,
    text: `${best.name} (${best.camelot})`
      + (confident ? '' : ' — uncertain')
      + (Math.abs(tuning.cents) >= 12 ? ` · tuned ${tuning.cents > 0 ? '+' : ''}${tuning.cents} cents from A440` : '')
      + (kept.length ? ` · ${kept.length} chord${kept.length === 1 ? '' : 's'}: ${kept.slice(0, 8).map((s) => s.name).join(' ')}${kept.length > 8 ? ' …' : ''}` : ''),
  };
}
