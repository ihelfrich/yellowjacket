// In-band tone signalling: DTMF (ITU-T Q.23 generation, Q.24 detection) and the
// sequential selective-calling sets that HF and VHF nets page each other with,
// CCIR-1 and ZVEI-1.
//
// The whole difficulty is not detecting tones. It is refusing everything else.
// A Goertzel bank with a level threshold will find DTMF digits in speech all
// day — voiced speech has strong narrow peaks that sit exactly where the bank is
// looking — and this bench's shelf is half voice recordings, so a detector
// without the Q.24 acceptance gates would fill a report with digits that were
// never transmitted. The gates are:
//
//   frequency   the winning tone must beat probes 3.5% either side of it, which
//               accepts a tone 1.5% off nominal and rejects one 3.5% off, the
//               tolerance Q.24 asks for
//   twist       the two tones must be within 4 dB (high louder) or 8 dB (low
//               louder) of each other
//   purity      the two tones must hold most of the frame's energy, and each
//               must dominate the other three in its own group
//   harmonics   a sinusoid has no second harmonic; a vowel does
//   time        at least 40 ms of tone, at least 40 ms of gap between digits
//
// Every gate has a measured threshold and a count of what it rejected, in
// `rejected`, so a report can say why a recording produced no digits rather
// than leaving the reader to guess whether the detector ran.
//
// Nothing here is an interception: DTMF and selcall are open in-band signalling
// that any receiver tuned to the channel hears, and the tone tables are
// published in the ITU-T and CCIR recommendations named above.
import { goertzel } from '../../dsp/analytic.js';

// ITU-T Q.23, the eight tones and the sixteen keys they make.
export const DTMF_LOW = Object.freeze([697, 770, 852, 941]);
export const DTMF_HIGH = Object.freeze([1209, 1336, 1477, 1633]);
export const DTMF_KEYS = Object.freeze([
  Object.freeze(['1', '2', '3', 'A']),
  Object.freeze(['4', '5', '6', 'B']),
  Object.freeze(['7', '8', '9', 'C']),
  Object.freeze(['*', '0', '#', 'D']),
]);

/** The DTMF pair for one key, or null. */
export function dtmfPair(key) {
  for (let r = 0; r < 4; r++) {
    const c = DTMF_KEYS[r].indexOf(String(key).toUpperCase());
    if (c >= 0) return { lowHz: DTMF_LOW[r], highHz: DTMF_HIGH[c], row: r, col: c };
  }
  return null;
}

// CCIR-1 and ZVEI-1: one tone per digit, sent in sequence. Both reserve a
// repeat tone (E) for a digit that follows itself, because two identical tones
// back to back have no boundary a detector could find — which is also why the
// decoders below expand E rather than reporting it.
export const SELCALL_SETS = Object.freeze({
  CCIR1: Object.freeze({
    name: 'CCIR-1',
    toneMs: 100,
    repeat: 'E',
    tones: Object.freeze({
      0: 1981, 1: 1124, 2: 1197, 3: 1275, 4: 1358, 5: 1446, 6: 1540, 7: 1640,
      8: 1747, 9: 1860, A: 2400, B: 930, C: 2247, D: 991, E: 2110, F: 1055,
    }),
  }),
  ZVEI1: Object.freeze({
    name: 'ZVEI-1',
    toneMs: 70,
    repeat: 'E',
    tones: Object.freeze({
      0: 2400, 1: 1060, 2: 1160, 3: 1270, 4: 1400, 5: 1530, 6: 1670, 7: 1830,
      8: 2000, 9: 2200, A: 2800, B: 810, C: 970, D: 885, E: 2600, F: 680,
    }),
  }),
});

/**
 * The acceptance gates, all in one place and all overridable, because several
 * of them are national options in Q.24 rather than one worldwide number. The
 * twist limits below are the North American values (Telcordia TR-TSY-000181):
 * the high group may be up to 4 dB louder than the low group, the low group up
 * to 8 dB louder than the high. The durations are Q.24's own: a tone of 40 ms
 * or more must be accepted, one of 23 ms or less rejected, and a 40 ms pause
 * must separate two digits.
 */
export const Q24 = Object.freeze({
  frameMs: 25,               // 200 samples at 8 kHz: 40 Hz resolution, and the
                             // row tones are 73 Hz apart at the narrowest
  hopFraction: 0.25,         // a quarter-frame hop, so that a 40 ms pause — the
                             // shortest Q.24 says must split two digits — always
                             // contains one frame lying wholly inside it. At a
                             // half-frame hop a 40 ms gap sometimes did not, and
                             // two 5s 40 ms apart came back as one.
  guardFraction: 0.035,      // the offset Q.24 requires a detector to reject
  holdFraction: 0.015,       // the offset Q.24 requires a detector to accept
  minLevelDb: -50,           // frame mean-square, relative to full scale
  dominanceDb: 10,           // winner over the next tone in its own group; a
                             // clean tone measures 21 dB at this frame length
  forwardTwistDb: 4.5,       // high group louder than low. The extra half dB
  reverseTwistDb: 8.5,       // over Q.24's 4 and 8 is measurement headroom: each
                             // tone leaks a little into the other's probe, so a
                             // pair rendered at exactly 4.0 dB of twist measures
                             // 4.0 to 4.2 and a hard limit rejected 12 of 16.
  minFraction: 0.34,         // both tones' power over the frame's mean square;
                             // an ideal pair reads 0.50 exactly
  harmonicDb: 10,            // second harmonic below the fundamental
  minDurationMs: 40,
  minPauseMs: 40,
});

// ------------------------------------------------------------- the tone bank

/**
 * Power at every frequency in `freqs`, plus the guard probes either side of
 * each and the frame's own mean square, for one frame. `goertzel` is normalised
 * so a unit tone reads 0.25 while its mean square is 0.5, which is why a single
 * pure tone shows a `fraction` of exactly 0.5 and a pure DTMF pair the same.
 */
export function toneFrame(x, sampleRate, start, length, freqs, guardFraction = Q24.guardFraction, holdFraction = Q24.holdFraction) {
  const p = new Float64Array(freqs.length);
  const gLo = new Float64Array(freqs.length);
  const gHi = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    // Three probes across the tolerance band, not one on the nominal. A
    // Goertzel of this length is 40 Hz wide, so a tone 1.5% high — 18 Hz on
    // 1209, which Q.24 says must be ACCEPTED — reads 3.1 dB down on the
    // nominal probe alone. Measured, that dropped the two-tone energy fraction
    // to 0.32 and the purity gate threw away every digit at exactly the offset
    // the recommendation requires a detector to tolerate.
    p[i] = Math.max(
      goertzel(x, sampleRate, freqs[i], { start, length }),
      goertzel(x, sampleRate, freqs[i] * (1 - holdFraction), { start, length }),
      goertzel(x, sampleRate, freqs[i] * (1 + holdFraction), { start, length }),
    );
    gLo[i] = goertzel(x, sampleRate, freqs[i] * (1 - guardFraction), { start, length });
    gHi[i] = goertzel(x, sampleRate, freqs[i] * (1 + guardFraction), { start, length });
  }
  let ms = 0;
  for (let i = 0; i < length; i++) { const v = x[start + i]; ms += v * v; }
  return { p, gLo, gHi, meanSquare: ms / length };
}

const db = (v) => 10 * Math.log10(Math.max(v, 1e-30));

function topTwo(p, from, to) {
  let a = from, b = -1;
  for (let i = from; i < to; i++) if (p[i] > p[a]) a = i;
  for (let i = from; i < to; i++) if (i !== a && (b < 0 || p[i] > p[b])) b = i;
  return { best: a, next: b };
}

// ------------------------------------------------------------------ DTMF

/**
 * Find DTMF digits in a span, with every Q.24 gate applied and counted.
 *
 * Returns the digits with their timing and the margins by which each passed,
 * and `rejected`, a count of how many frames each gate turned away. On a
 * recording with no signalling in it the digit list is empty and `rejected`
 * says which gate did the work — which is the difference between "no digits
 * were sent" and "the detector never ran".
 */
export function detectDtmf(x, sampleRate, opts = {}) {
  const g = { ...Q24, ...opts };
  const freqs = DTMF_LOW.concat(DTMF_HIGH);
  const harm = freqs.map((f) => 2 * f);
  const n = Math.max(32, Math.round(g.frameMs * sampleRate / 1000));
  const hop = Math.max(1, Math.round(n * g.hopFraction));
  if (!x || x.length < n) return { ok: false, reason: 'span shorter than one frame', digits: [], rejected: {}, frames: 0 };
  const minLevel = Math.pow(10, g.minLevelDb / 10);

  const rejected = { level: 0, offFrequency: 0, dominance: 0, twist: 0, fraction: 0, harmonic: 0, tooShort: 0 };
  const marks = [];
  let frames = 0;
  for (let s = 0; s + n <= x.length; s += hop) {
    frames++;
    const f = toneFrame(x, sampleRate, s, n, freqs, g.guardFraction, g.holdFraction);
    if (f.meanSquare < minLevel) { rejected.level++; marks.push(null); continue; }
    const lo = topTwo(f.p, 0, 4), hiG = topTwo(f.p, 4, 8);
    // A tone 3.5% off nominal puts more power into the probe on that side than
    // into the nominal bin; one 1.5% off does not. That crossover is the
    // frequency tolerance, and it needs no threshold of its own.
    if (f.p[lo.best] <= f.gLo[lo.best] || f.p[lo.best] <= f.gHi[lo.best]
      || f.p[hiG.best] <= f.gLo[hiG.best] || f.p[hiG.best] <= f.gHi[hiG.best]) {
      rejected.offFrequency++; marks.push(null); continue;
    }
    const domLo = db(f.p[lo.best]) - db(f.p[lo.next]);
    const domHi = db(f.p[hiG.best]) - db(f.p[hiG.next]);
    if (domLo < g.dominanceDb || domHi < g.dominanceDb) { rejected.dominance++; marks.push(null); continue; }
    const twist = db(f.p[hiG.best]) - db(f.p[lo.best]);
    if (twist > g.forwardTwistDb || twist < -g.reverseTwistDb) { rejected.twist++; marks.push(null); continue; }
    const fraction = (f.p[lo.best] + f.p[hiG.best]) / f.meanSquare;
    if (fraction < g.minFraction) { rejected.fraction++; marks.push(null); continue; }
    // A sinusoid has no second harmonic. A vowel does, and it is usually within
    // 10 dB of the fundamental, which is what this gate is for. The measured
    // headroom on a real digit is smaller than the textbook infinity because
    // the other tone of the pair leaks into the harmonic bin: 2x697 is 58 Hz
    // from 1336, worth -13 dB at this frame length, so the threshold sits at 10.
    const h1 = goertzel(x, sampleRate, harm[lo.best], { start: s, length: n });
    const h2 = goertzel(x, sampleRate, harm[hiG.best], { start: s, length: n });
    const hLo = db(f.p[lo.best]) - db(h1), hHi = db(f.p[hiG.best]) - db(h2);
    if (hLo < g.harmonicDb || hHi < g.harmonicDb) { rejected.harmonic++; marks.push(null); continue; }
    marks.push({
      digit: DTMF_KEYS[lo.best][hiG.best - 4],
      lowHz: DTMF_LOW[lo.best], highHz: DTMF_HIGH[hiG.best - 4],
      twistDb: twist, levelDb: 10 * Math.log10(f.meanSquare),
      fraction, domLo, domHi, harmonicDb: Math.min(hLo, hHi),
      at: s / sampleRate,
    });
  }

  // Frames into digits: a run of frames agreeing on the same key, long enough
  // to be a digit, with a long enough gap before the next one. Both minima are
  // Q.24's, and a run that falls short is counted rather than dropped silently.
  const digits = [];
  let i = 0;
  const frameSec = n / sampleRate, hopSec = hop / sampleRate;
  while (i < marks.length) {
    if (!marks[i]) { i++; continue; }
    let j = i;
    while (j + 1 < marks.length && marks[j + 1] && marks[j + 1].digit === marks[i].digit) j++;
    const startSec = marks[i].at;
    const endSec = marks[j].at + frameSec;
    if ((endSec - startSec) * 1000 + 1e-9 < g.minDurationMs) { rejected.tooShort++; i = j + 1; continue; }
    const run = marks.slice(i, j + 1);
    const mean = (k) => run.reduce((t, m) => t + m[k], 0) / run.length;
    const prev = digits[digits.length - 1];
    // Half a frame of tolerance on the pause, because half a frame is the
    // resolution of the measurement. A run is bounded by whole frames, and the
    // frames at each end overlap the tone's ramps, so a pause rendered at
    // exactly the 40 ms Q.24 minimum measured 31.2 ms between the reported end
    // of one digit and the start of the next. Without the allowance two 5s a
    // legal 40 ms apart came back as one digit.
    const pauseFloor = g.minPauseMs - g.frameMs * 0.5;
    if (prev && prev.digit === marks[i].digit && (startSec - prev.endSec) * 1000 < pauseFloor) {
      // Not a second digit: the same one, briefly interrupted.
      prev.endSec = endSec;
      prev.frames += run.length;
    } else {
      digits.push({
        digit: marks[i].digit, startSec, endSec,
        lowHz: marks[i].lowHz, highHz: marks[i].highHz,
        twistDb: mean('twistDb'), levelDb: mean('levelDb'), fraction: mean('fraction'),
        dominanceDb: Math.min(mean('domLo'), mean('domHi')),
        harmonicDb: mean('harmonicDb'),
        frames: run.length,
        // How much room every gate had, as the tightest of them. 1 means each
        // gate was passed by a wide margin, 0 means one of them was scraped.
        confidence: Math.max(0, Math.min(1,
          Math.min(
            (Math.min(mean('domLo'), mean('domHi')) - g.dominanceDb) / 10,
            (mean('fraction') - g.minFraction) / 0.12,
            (mean('harmonicDb') - g.harmonicDb) / 10,
            (g.forwardTwistDb - mean('twistDb')) / 4.5,
            (mean('twistDb') + g.reverseTwistDb) / 8.5,
          ))),
      });
    }
    i = j + 1;
  }
  return {
    ok: true, digits, sequence: digits.map((d) => d.digit).join(''),
    rejected, frames, frameMs: frameSec * 1000, hopMs: hopSec * 1000, gates: g,
  };
}

// ---------------------------------------------------------------- selcall

/**
 * The frequency of one tone, measured over the tone's own window rather than
 * read back off the table it was matched to.
 *
 * This is the number a signals person actually wants out of a selcall
 * detection: the difference between it and the nominal is the transmitter's
 * frequency error, and reporting the nominal instead — which is what this
 * module did — throws away the one measurement the detection produced.
 *
 * A Goertzel is a single-bin DFT, so its magnitude against frequency traces the
 * window's own transform, which near the peak is close to a parabola in log
 * magnitude. A coarse sweep across the tolerance band brackets the peak (three
 * probes alone cannot, for a tone 3% off), then one parabolic interpolation
 * finds it. Measured against rendered tones detuned from -3% to +3% in 0.25%
 * steps over 70 ms windows, the worst error is 0.0068% of the tone.
 */
export function measureToneHz(x, sampleRate, start, length, nominalHz, { spanFraction = 0.045, steps = 37 } = {}) {
  const lo = nominalHz * (1 - spanFraction);
  const step = nominalHz * 2 * spanFraction / (steps - 1);
  const p = new Float64Array(steps);
  let best = 0;
  for (let i = 0; i < steps; i++) {
    p[i] = goertzel(x, sampleRate, lo + i * step, { start, length });
    if (p[i] > p[best]) best = i;
  }
  if (best === 0 || best === steps - 1) return { hz: lo + best * step, atEdge: true };
  const a = Math.log(p[best - 1] + 1e-30), b = Math.log(p[best] + 1e-30), c = Math.log(p[best + 1] + 1e-30);
  const den = a - 2 * b + c;
  const d = den !== 0 ? 0.5 * (a - c) / den : 0;
  return { hz: lo + (best + Math.max(-1, Math.min(1, d))) * step, atEdge: false };
}

const medianOf = (xs) => {
  if (!xs.length) return 0;
  const s = Float64Array.from(xs).sort();
  return s.length % 2 ? s[s.length >> 1] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2]);
};

/**
 * Whether a run of measured tone frequencies can have come from one scheme's
 * table at all.
 *
 * Every gate above this one asks about a single tone: is it near enough to some
 * entry to be that entry. Six tones each within the per-tone tolerance of some
 * entry is not the same claim as "this is that scheme", and the difference is
 * what let a six-tone set that is not ZVEI-1 be reported as twelve ZVEI-1
 * calls. One transmitter generates its whole sequence from one oscillator, so a
 * real sequence's tones are all off nominal by the SAME ratio — that is a
 * frequency error, it is a useful measurement, and it must be accepted. Tones
 * off by different ratios in different directions cannot be one oscillator
 * reading one table, however close each one is on its own.
 *
 * So: the common ratio is taken as the median of measured/nominal, and what is
 * left after removing it is the residual. `scale` is the transmitter's error,
 * `residuals` are what refuses.
 */
export function schemeFit(measured, nominal) {
  const n = Math.min(measured.length, nominal.length);
  if (!n) return { n: 0, scale: 1, offsetFraction: 0, residuals: [], maxResidual: Infinity, rmsResidual: Infinity };
  const logs = [];
  for (let i = 0; i < n; i++) logs.push(Math.log(measured[i] / nominal[i]));
  const k = medianOf(logs);
  const residuals = logs.map((v) => Math.exp(v - k) - 1);
  let sq = 0, mx = 0;
  for (const r of residuals) { sq += r * r; if (Math.abs(r) > mx) mx = Math.abs(r); }
  return {
    n,
    scale: Math.exp(k),
    offsetFraction: Math.exp(k) - 1,
    residuals,
    maxResidual: mx,
    rmsResidual: Math.sqrt(sq / n),
  };
}


/**
 * Sequential single-tone selective calling: CCIR-1 or ZVEI-1. The gates are the
 * DTMF ones minus twist, which needs two tones to mean anything, and with the
 * guard probes tightened because these sets pack their tones 6.5% apart rather
 * than DTMF's 10% — a 3.5% guard on a CCIR tone lands nearly on its neighbour.
 */
export function detectSelcall(x, sampleRate, opts = {}) {
  const setName = opts.set || 'CCIR1';
  const set = SELCALL_SETS[setName];
  if (!set) return { ok: false, reason: `unknown selcall set ${setName}`, tones: [] };
  const g = {
    guardFraction: 0.025,
    holdFraction: 0.010,
    minLevelDb: Q24.minLevelDb,
    dominanceDb: 8,
    minFraction: 0.30,
    harmonicDb: 10,
    minDurationFraction: 0.6,
    // A real sequence is continuous tone; measured, a keyed CW carrier sitting
    // on a table frequency covered 51% of the span its 'tones' were spread over.
    minCoverage: 0.85,
    minTones: 3,
    // How far a tone may sit from its table entry AFTER a common frequency
    // error has been divided out. Measured on rendered CCIR-1 and ZVEI-1
    // sequences the residual never exceeds 0.069%, at any detune from -3% to
    // +3% and down to +12 dB of noise; the value here is set six times clear of
    // that, and a six-tone set that is not this scheme measures 1.56%.
    maxToneResidual: 0.004,
    ...opts,
  };
  const symbols = Object.keys(set.tones);
  const freqs = symbols.map((s) => set.tones[s]);
  const frameMs = Math.max(12, set.toneMs / 3);
  const n = Math.max(32, Math.round(frameMs * sampleRate / 1000));
  const hop = Math.max(1, n >> 1);
  if (!x || x.length < n) return { ok: false, reason: 'span shorter than one frame', tones: [] };
  const minLevel = Math.pow(10, g.minLevelDb / 10);
  const rejected = { level: 0, offFrequency: 0, dominance: 0, fraction: 0, harmonic: 0, tooShort: 0 };

  const marks = [];
  let frames = 0;
  for (let s = 0; s + n <= x.length; s += hop) {
    frames++;
    const f = toneFrame(x, sampleRate, s, n, freqs, g.guardFraction, g.holdFraction);
    if (f.meanSquare < minLevel) { rejected.level++; marks.push(null); continue; }
    const { best, next } = topTwo(f.p, 0, freqs.length);
    if (f.p[best] <= f.gLo[best] || f.p[best] <= f.gHi[best]) { rejected.offFrequency++; marks.push(null); continue; }
    const dom = db(f.p[best]) - db(f.p[next]);
    if (dom < g.dominanceDb) { rejected.dominance++; marks.push(null); continue; }
    const fraction = f.p[best] / f.meanSquare;
    if (fraction < g.minFraction) { rejected.fraction++; marks.push(null); continue; }
    const h = goertzel(x, sampleRate, 2 * freqs[best], { start: s, length: n });
    const hDb = db(f.p[best]) - db(h);
    if (hDb < g.harmonicDb) { rejected.harmonic++; marks.push(null); continue; }
    marks.push({ symbol: symbols[best], hz: freqs[best], dom, fraction, harmonicDb: hDb, levelDb: 10 * Math.log10(f.meanSquare), at: s / sampleRate });
  }

  const frameSec = n / sampleRate;
  const minSec = set.toneMs * g.minDurationFraction / 1000;
  const tones = [];
  let i = 0;
  while (i < marks.length) {
    if (!marks[i]) { i++; continue; }
    let j = i;
    while (j + 1 < marks.length && marks[j + 1] && marks[j + 1].symbol === marks[i].symbol) j++;
    const startSec = marks[i].at, endSec = marks[j].at + frameSec;
    if (endSec - startSec < minSec) { rejected.tooShort++; i = j + 1; continue; }
    const run = marks.slice(i, j + 1);
    const mean = (k) => run.reduce((t, m) => t + m[k], 0) / run.length;
    // Measured in this tone's own window, over the whole run rather than one
    // frame of it, because the run is what the tone occupied. `hz` is that
    // measurement; `nominalHz` is the table entry it was matched to. The
    // difference between them is the transmitter's frequency error, which is
    // the most useful number this function produces and which the module used
    // to throw away by reporting the table value as though it had measured it.
    const a0 = Math.round(startSec * sampleRate);
    const a1 = Math.min(x.length, Math.round(endSec * sampleRate));
    const meas = measureToneHz(x, sampleRate, a0, a1 - a0, marks[i].hz);
    // What that measurement is worth, measured rather than assumed: the same
    // frequency taken from the first half of the tone and from the second. Two
    // independent estimates of one quantity differ by sqrt(2) times each one's
    // own error, and each half-length estimate is worth sqrt(2) less than the
    // whole, so half the disagreement estimates the error on the whole. The fit
    // tolerance below is never allowed under this, so a short or noisy burst
    // widens its own acceptance instead of being refused for being hard to
    // measure. Measured on rendered CCIR-1 and ZVEI-1 down to +9 dB, the median
    // tone gives 0.0013-0.018% and the worst single tone 0.23%.
    const mid = (a0 + a1) >> 1;
    const fA = measureToneHz(x, sampleRate, a0, mid - a0, marks[i].hz).hz;
    const fB = measureToneHz(x, sampleRate, mid, a1 - mid, marks[i].hz).hz;
    tones.push({
      symbol: marks[i].symbol,
      hz: meas.hz,
      nominalHz: marks[i].hz,
      offsetHz: meas.hz - marks[i].hz,
      offsetFraction: meas.hz / marks[i].hz - 1,
      sigmaFraction: Math.abs(fA / fB - 1) / 2,
      startSec, endSec,
      dominanceDb: mean('dom'), fraction: mean('fraction'), harmonicDb: mean('harmonicDb'),
      levelDb: mean('levelDb'), frames: run.length,
      confidence: Math.max(0, Math.min(1, Math.min(
        (mean('dom') - g.dominanceDb) / 10,
        (mean('fraction') - g.minFraction) / 0.15,
        (mean('harmonicDb') - g.harmonicDb) / 10,
      ))),
    });
    i = j + 1;
  }
  const expand = (raw) => {
    // The repeat tone stands for "the digit before this one, again". Expanding
    // it is the decode; leaving it as E would be transcribing the line code.
    let out = '';
    for (let k = 0; k < raw.length; k++) {
      out += raw[k] === set.repeat && k > 0 ? out[out.length - 1] : raw[k];
    }
    return out;
  };

  // Tones alone are not a call. A selective-calling sequence is a handful of
  // tones sent back to back with no silence between them; a keyed carrier that
  // happens to sit on one of the table frequencies is not, and this is not
  // hypothetical — the M08 capture's 997 Hz CW note is 0.6% from CCIR-1's D at
  // 991 Hz, and a tone-at-a-time detector read 174 Ds out of its 85 seconds.
  // What separates them is that the Ds covered barely half the span they were
  // spread over, because Morse has gaps in it, while a real sequence covers
  // essentially all of its own. So the tones are grouped into bursts and each
  // burst is reported with the fraction of itself it actually fills.
  const bursts = [];
  for (const t of tones) {
    const b = bursts[bursts.length - 1];
    if (b && t.startSec - b.endSec < set.toneMs * 1.5 / 1000) {
      b.endSec = t.endSec; b.tones.push(t);
    } else {
      bursts.push({ startSec: t.startSec, endSec: t.endSec, tones: [t] });
    }
  }
  for (const b of bursts) {
    let held = 0;
    for (const t of b.tones) held += t.endSec - t.startSec;
    b.coverage = (b.endSec - b.startSec) > 0 ? held / (b.endSec - b.startSec) : 0;
    b.raw = b.tones.map((t) => t.symbol).join('');
    b.sequence = expand(b.raw);
    b.distinct = new Set(b.raw).size;
    b.contiguous = b.coverage >= g.minCoverage;
    // Can these tones have come from this table at all? Each one passing the
    // per-tone frequency gate is a claim about one tone; this is the claim
    // about the set, and it is the one that was missing.
    b.fit = schemeFit(b.tones.map((t) => t.hz), b.tones.map((t) => t.nominalHz));
    // The tolerance is the stated one or four times what the measurement is
    // actually repeatable to on THIS burst, whichever is larger. An acceptance
    // band tighter than the measurement's own scatter refuses real signals for
    // being noisy, which is a different lie from the one this gate exists to
    // stop but a lie all the same.
    b.fit.sigmaFraction = medianOf(b.tones.map((t) => t.sigmaFraction));
    b.fit.tolerance = Math.max(g.maxToneResidual, 4 * b.fit.sigmaFraction);
    b.fitsScheme = b.fit.maxResidual <= b.fit.tolerance;
    b.isSequence = b.contiguous && b.tones.length >= g.minTones && b.fitsScheme;
  }
  const calls = bursts.filter((b) => b.isSequence);
  const warnings = [];
  const loose = bursts.filter((b) => !b.contiguous);
  if (loose.length) {
    warnings.push(`${loose.length} tone group(s) rejected as not contiguous: `
      + `${loose.map((b) => `${b.tones.length} tones covering ${(b.coverage * 100).toFixed(0)}% of ${(b.endSec - b.startSec).toFixed(1)} s`).join('; ')}`);
  }
  const short = bursts.filter((b) => b.contiguous && b.tones.length < g.minTones);
  if (short.length) warnings.push(`${short.length} tone group(s) shorter than ${g.minTones} tones, too short to be a call`);
  const misfit = bursts.filter((b) => b.contiguous && b.tones.length >= g.minTones && !b.fitsScheme);
  for (const b of misfit) {
    warnings.push(`${b.tones.length} contiguous tones are not ${set.name}: after allowing a common `
      + `${(b.fit.offsetFraction * 100).toFixed(2)}% frequency error the individual tones are still off `
      + `their table entries by up to ${(b.fit.maxResidual * 100).toFixed(2)}% against a tolerance of `
      + `${(b.fit.tolerance * 100).toFixed(2)}%, which one transmitter reading one table cannot be — `
      + `they measure at `
      + `${b.tones.map((t) => `${t.hz.toFixed(1)} Hz (nearest ${set.name} entry ${t.nominalHz})`).join(', ')}`);
  }

  const raw = calls.map((b) => b.raw).join('');
  return {
    ok: true, set: set.name, tones, bursts, calls,
    // `raw` and `sequence` are what the accepted CALLS say, not what every tone
    // that happened to land near a table entry says. Reading them off the loose
    // tones is how a caller who prints `sequence` gets a call that was never
    // sent: on a six-tone set that is not this scheme at all, the loose tones
    // still spell something.
    raw, sequence: expand(raw),
    sequences: calls.map((b) => b.sequence),
    // Every tone the detector accepted, measured, whether or not it turned out
    // to be part of a call. This is the honest output for a recording that is
    // not any known scheme: here is what the tones actually are.
    measuredHz: tones.map((t) => +t.hz.toFixed(1)),
    fit: schemeFit(tones.map((t) => t.hz), tones.map((t) => t.nominalHz)),
    warnings, rejected, frames, frameMs: frameSec * 1000, gates: g,
  };
}

/**
 * Try every selcall set and return them ranked by how much of the span they
 * explain. A single-tone sequence carries no header saying which table it came
 * from, so the honest answer names the alternatives and how well each fitted
 * rather than picking one silently.
 */
export function identifySelcall(x, sampleRate, opts = {}) {
  const out = [];
  for (const key of Object.keys(SELCALL_SETS)) {
    const r = detectSelcall(x, sampleRate, { ...opts, set: key });
    if (!r.ok) continue;
    let held = 0;
    for (const b of r.calls) held += b.endSec - b.startSec;
    out.push({
      set: key, name: r.set, calls: r.calls.length, tones: r.tones.length,
      secondsHeld: held, sequences: r.sequences,
      // How well the tones this set matched actually fit its table once a
      // common frequency error is removed. A set that explains a lot of the
      // span with a bad fit has not explained it.
      maxResidual: r.fit.maxResidual,
      offsetFraction: r.fit.offsetFraction,
      measuredHz: r.measuredHz,
      result: r,
    });
  }
  out.sort((a, b) => b.secondsHeld - a.secondsHeld);
  // What the tones measure at, with no table in the answer. Frequencies within
  // 0.5% of each other are one tone seen more than once. This is what a
  // recording that is not any known scheme should return: not a sequence in a
  // scheme it does not belong to, but the six numbers themselves.
  const seen = [];
  for (const o of out) {
    for (const hz of o.measuredHz) {
      const near = seen.find((c) => Math.abs(c.hz / hz - 1) < 0.005);
      if (near) { near.n++; near.sum += hz; near.hz = near.sum / near.n; continue; }
      seen.push({ hz, sum: hz, n: 1 });
    }
  }
  seen.sort((a, b) => a.hz - b.hz);
  out.tones = seen.map((c) => ({ hz: +c.hz.toFixed(1), windows: c.n }));
  out.explained = out.some((o) => o.calls > 0);
  return out;
}

// ------------------------------------------------------------------ generators

function noiseAdder(seed) {
  let rng = seed >>> 0;
  return () => { rng = (rng * 1664525 + 1013904223) >>> 0; return rng / 4294967296; };
}

/**
 * Render a DTMF string to audio, per Q.23. `twistDb` puts the high group that
 * many dB above the low group, so a test can walk a detector up to its twist
 * limit and past it.
 */
export function renderDtmf(keys, {
  sampleRate = 8000, digitMs = 80, gapMs = 60, amplitude = 0.35, twistDb = 0,
  snrDb = null, seed = 1, leadMs = 30, tailMs = 30, detuneFraction = 0,
} = {}) {
  const list = String(keys).toUpperCase().split('');
  const dn = Math.round(digitMs * sampleRate / 1000);
  const gn = Math.round(gapMs * sampleRate / 1000);
  const lead = Math.round(leadMs * sampleRate / 1000);
  const total = lead + Math.round(tailMs * sampleRate / 1000) + list.length * (dn + gn);
  const x = new Float32Array(total);
  const aHi = amplitude * Math.pow(10, twistDb / 20);
  let pos = lead;
  for (const k of list) {
    const pair = dtmfPair(k);
    if (!pair) { pos += dn + gn; continue; }
    const fl = pair.lowHz * (1 + detuneFraction), fh = pair.highHz * (1 + detuneFraction);
    // A 2 ms raised-cosine edge on each end: a hard-gated tone splatters across
    // the whole bank and would be rejected by the dominance gate it is meant
    // to be testing.
    const edge = Math.max(1, Math.round(0.002 * sampleRate));
    for (let i = 0; i < dn && pos + i < total; i++) {
      let a = 1;
      if (i < edge) a = 0.5 * (1 - Math.cos(Math.PI * i / edge));
      else if (i > dn - edge) a = 0.5 * (1 - Math.cos(Math.PI * (dn - i) / edge));
      const t = 2 * Math.PI * (pos + i) / sampleRate;
      x[pos + i] = a * (amplitude * Math.sin(t * fl) + aHi * Math.sin(t * fh));
    }
    pos += dn + gn;
  }
  if (snrDb !== null) {
    const rand = noiseAdder(seed);
    const sigP = (amplitude * amplitude + aHi * aHi) / 2;
    const sd = Math.sqrt(sigP / Math.pow(10, snrDb / 10));
    for (let i = 0; i < total; i++) {
      const u = Math.max(1e-12, rand()), v = rand();
      x[i] += sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
  }
  return { samples: x, sampleRate, seconds: total / sampleRate };
}

/**
 * Render a selcall sequence. Runs of the same digit are sent as the set's
 * repeat tone, which is what a real encoder does and what the decoder above
 * has to undo.
 */
export function renderSelcall(sequence, {
  set = 'CCIR1', sampleRate = 8000, amplitude = 0.4, toneMs = null,
  gapMs = 0, snrDb = null, seed = 1, leadMs = 40, tailMs = 40,
} = {}) {
  const s = SELCALL_SETS[set];
  if (!s) throw new Error(`unknown selcall set ${set}`);
  const ms = toneMs || s.toneMs;
  const symbols = String(sequence).toUpperCase().split('');
  // The repeat tone is reserved by the protocol: a receiver reads it as "the
  // previous digit again", so it cannot also carry itself as data. Sending it
  // would make the round trip lie about what the decoder got wrong.
  if (symbols.includes(s.repeat)) throw new Error(`${s.name} reserves ${s.repeat} as the repeat tone; it cannot be sent as data`);
  const sent = [];
  for (let i = 0; i < symbols.length; i++) {
    sent.push(i > 0 && symbols[i] === symbols[i - 1] ? s.repeat : symbols[i]);
  }
  const tn = Math.round(ms * sampleRate / 1000);
  const gn = Math.round(gapMs * sampleRate / 1000);
  const lead = Math.round(leadMs * sampleRate / 1000);
  const total = lead + Math.round(tailMs * sampleRate / 1000) + sent.length * (tn + gn);
  const x = new Float32Array(total);
  const edge = Math.max(1, Math.round(0.002 * sampleRate));
  let pos = lead;
  for (const sym of sent) {
    const hz = s.tones[sym];
    if (hz) {
      for (let i = 0; i < tn && pos + i < total; i++) {
        let a = 1;
        if (i < edge) a = 0.5 * (1 - Math.cos(Math.PI * i / edge));
        else if (i > tn - edge) a = 0.5 * (1 - Math.cos(Math.PI * (tn - i) / edge));
        x[pos + i] = a * amplitude * Math.sin(2 * Math.PI * hz * (pos + i) / sampleRate);
      }
    }
    pos += tn + gn;
  }
  if (snrDb !== null) {
    const rand = noiseAdder(seed);
    const sd = Math.sqrt((amplitude * amplitude / 2) / Math.pow(10, snrDb / 10));
    for (let i = 0; i < total; i++) {
      const u = Math.max(1e-12, rand()), v = rand();
      x[i] += sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
  }
  return { samples: x, sampleRate, sent: sent.join(''), seconds: total / sampleRate };
}

/**
 * A voice-like signal for testing rejection: a glottal pulse train at a drifting
 * pitch, shaped by three resonators whose centre frequencies walk between vowel
 * targets, with pauses. It is not speech, but it has what makes speech dangerous
 * to a tone detector — narrow, strong, slowly moving spectral peaks in the same
 * band as the DTMF tones, and a harmonic series under them.
 */
export function renderVoiceLike({
  sampleRate = 8000, seconds = 4, seed = 3, amplitude = 0.3,
  vowels = [[700, 1220, 2600], [400, 2000, 2550], [310, 870, 2250], [640, 1190, 2390]],
  f0 = 130, jitter = 0.06,
} = {}) {
  const rand = noiseAdder(seed);
  const n = Math.round(seconds * sampleRate);
  const src = new Float64Array(n);
  // Glottal excitation: an impulse train whose period wobbles, plus breath.
  let next = 0, period = sampleRate / f0;
  for (let i = 0; i < n; i++) {
    if (i >= next) { src[i] = 1; period = sampleRate / (f0 * (1 + (rand() * 2 - 1) * jitter)); next = i + period; }
    src[i] += 0.02 * (rand() * 2 - 1);
  }
  const out = new Float32Array(n);
  const held = Math.round(0.22 * sampleRate);
  for (let v = 0; v < 3; v++) {
    // One two-pole resonator per formant, retuned every 220 ms and swept
    // between targets so nothing sits still long enough to look like a tone.
    let y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const seg = Math.floor(i / held);
      const t = (i % held) / held;
      const a = vowels[seg % vowels.length][v], b = vowels[(seg + 1) % vowels.length][v];
      const fc = a + (b - a) * t;
      const bw = 90 + 40 * v;
      const r = Math.exp(-Math.PI * bw / sampleRate);
      const c1 = 2 * r * Math.cos(2 * Math.PI * fc / sampleRate), c2 = -r * r;
      const y = src[i] * (1 - r) + c1 * y1 + c2 * y2;
      y2 = y1; y1 = y;
      // Syllable envelope, so the detector also sees onsets and gaps.
      const env = Math.max(0, Math.sin(Math.PI * (i % Math.round(0.34 * sampleRate)) / Math.round(0.34 * sampleRate)));
      out[i] += y * env / (v + 1);
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) if (Math.abs(out[i]) > peak) peak = Math.abs(out[i]);
  if (peak > 0) for (let i = 0; i < n; i++) out[i] *= amplitude / peak;
  return { samples: out, sampleRate, seconds: n / sampleRate };
}
