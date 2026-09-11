// Morse (CW) read the way an operator reads it: find where the tone sits, watch
// its envelope, learn THIS sender's timing from the run lengths, and only then
// look anything up in the alphabet.
//
// Two facts set the shape of this file.
//
// One: no single filter bandwidth works across the speed range. Keying
// sidebands scale with speed, so the matched bandwidth does too. A 50 Hz noise
// bandwidth is roughly a 20 ms impulse response, which smears a 30 ms dit
// (40 wpm) into its neighbours; a 400 Hz bandwidth passes eight times the noise
// a 12 wpm signal needs. So the speed is measured first, from a wide envelope
// that has not smeared the run lengths it is measuring, and the filter is then
// chosen by measuring: eight bandwidths spanning 2/T to 30/T are each fitted to
// a timing model and the one whose run lengths cluster tightest is kept.
// `filterHz`, `filterReason` and `filterSweep` in the result say what was tried
// and what won, because the answer is not the same at every signal to noise —
// measured on one 20 wpm message it chose 400 Hz at +20 dB and 64 Hz at -4 dB.
//
// Two: the 1:3 dit/dah ratio is a specification, not an observation. Machine
// keying (M08, the Cuban numbers stations) holds it to a percent or two; a hand
// on a straight key does not, and the 1942 Signal Corps aptitude record is a
// hand. Assuming 1:3 and thresholding at 2 units is how a decoder produces
// fluent nonsense from a human fist. Here the run lengths are clustered and the
// ratio that comes out is reported (`dahDitRatio`, `spacing.ratios`) rather
// than assumed.
//
// Everything measured is public broadcast: these are open transmissions on
// shortwave that any receiver hears. Timing and alphabet, nothing else.
import { firLowpass } from '../../dsp/analytic.js';
import { FFT, hann, nextPow2 } from '../../fft.js';

// ITU-R M.1677-1. Punctuation and the prosigns that share a pattern with it are
// both listed: '.-.-.' is the plus sign and is also AR (end of message), and a
// decoder that silently picks one hides the other from the reader.
export const CW_ALPHABET = Object.freeze({
  '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E', '..-.': 'F',
  '--.': 'G', '....': 'H', '..': 'I', '.---': 'J', '-.-': 'K', '.-..': 'L',
  '--': 'M', '-.': 'N', '---': 'O', '.--.': 'P', '--.-': 'Q', '.-.': 'R',
  '...': 'S', '-': 'T', '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X',
  '-.--': 'Y', '--..': 'Z',
  '-----': '0', '.----': '1', '..---': '2', '...--': '3', '....-': '4',
  '.....': '5', '-....': '6', '--...': '7', '---..': '8', '----.': '9',
  '.-.-.-': '.', '--..--': ',', '---...': ':', '..--..': '?', '.----.': "'",
  '-....-': '-', '-..-.': '/', '-.--.': '(', '-.--.-': ')', '.-..-.': '"',
  '-...-': '=', '.-.-.': '+', '.--.-.': '@',
  '...---...': 'SOS',
  '...-.-': '<SK>', '-.-.-': '<CT>', '.-...': '<AS>', '...-.': '<SN>',
  '........': '<HH>',
  // Not in M.1677-1; in common amateur and commercial use, marked as such by
  // `nonItu` on the character record so a report can say where it came from.
  '-.-.--': '!', '..--.-': '_', '...-..-': '$',
});

// Where a pattern is both punctuation and a procedural signal, the reader gets
// told which other reading exists rather than having to know.
export const CW_PROSIGNS = Object.freeze({
  '.-.-.': 'AR', '-...-': 'BT', '-.--.': 'KN', '...-.-': 'SK', '-.-.-': 'CT',
  '.-...': 'AS', '...-.': 'SN', '........': 'HH', '...---...': 'SOS',
});

const NON_ITU = new Set(['-.-.--', '..--.-', '...-..-']);

/** PARIS: one dit is 1.2 s / wpm, by definition, at any speed. */
/**
 * Abbreviated numerals — "cut numbers". Every digit in Morse is five elements,
 * which is slow, so operators sending figure groups shorten them to a prefix:
 * 0 becomes a single dah, 1 becomes A, 9 becomes N. Military CW and numbers
 * stations both do it, and a decoder that only knows letters reads a page of
 * digits as nonsense.
 *
 * These are prefixes of the real thing, which is what makes the table checkable
 * rather than folklore: `-..` is the first three elements of 8 (`---..`)... no,
 * it is not, and that is worth saying plainly — the common set is conventional,
 * not derived, and only some of it is prefix-truncation. It is the set in
 * general use, and the fit fraction below is what decides whether a given
 * transmission is using it.
 */
export const CUT_NUMERALS = Object.freeze({
  '-': '0', '.-': '1', '..-': '2', '.--': '3', '...-': '4',
  '.': '5', '-...': '6', '--.': '7', '-..': '8', '-.': '9',
});

/**
 * Read a decoded character stream as abbreviated numerals, and say how well it
 * fits. A run of ordinary English will fit badly and must not be read this way,
 * so the reading is offered only above `minFit` and the unmapped patterns are
 * always returned: on the shelf's M08 recording 64 of 80 characters (80%) are
 * cut numerals and the other two patterns repeat in fixed positions, which is a
 * fact about that transmission worth showing rather than smoothing over.
 */
export function cutNumbers(chars, { minFit = 0.7 } = {}) {
  const list = Array.isArray(chars) ? chars.filter((c) => c && c.pattern) : [];
  if (!list.length) return { ok: false, fit: 0, text: '', unmapped: [], reason: 'no characters to read' };
  let mapped = 0;
  const unmapped = new Map();
  let text = '';
  for (const c of list) {
    const digit = CUT_NUMERALS[c.pattern];
    if (c.wordBreakBefore && text) text += ' ';
    if (digit) { mapped++; text += digit; }
    else {
      unmapped.set(c.pattern, (unmapped.get(c.pattern) || 0) + 1);
      text += '[' + (c.char || '?') + ']';
    }
  }
  const fit = mapped / list.length;
  return {
    ok: fit >= minFit,
    fit,
    text,
    unmapped: [...unmapped.entries()].map(([pattern, count]) => ({ pattern, count }))
      .sort((a, b) => b.count - a.count),
    reason: fit >= minFit ? undefined
      : `only ${(fit * 100).toFixed(0)}% of the characters are abbreviated numerals, so this is not a figure group`,
  };
}

export const ditSecondsFor = (wpm) => 1.2 / wpm;
export const wpmFor = (ditSeconds) => 1.2 / ditSeconds;

/**
 * Look one pattern up. Returns null for a pattern the alphabet does not hold,
 * which the decoder reports as an unread character rather than the nearest
 * plausible letter.
 */
export function morseToChar(pattern) {
  return Object.prototype.hasOwnProperty.call(CW_ALPHABET, pattern) ? CW_ALPHABET[pattern] : null;
}

const CHAR_TO_MORSE = (() => {
  const m = new Map();
  for (const [pat, ch] of Object.entries(CW_ALPHABET)) if (!m.has(ch)) m.set(ch, pat);
  m.set(' ', ' ');
  return m;
})();

export function charToMorse(ch) {
  return CHAR_TO_MORSE.get(String(ch).toUpperCase()) || null;
}

// ---------------------------------------------------------------- tone search

/**
 * Where the carrier beat note sits, by averaged periodogram. Returns the peak
 * frequency, the ratio of that bin to the median bin (a per-bin signal to noise
 * that is only meaningful alongside `binHz`, which is why both come back), and
 * the bin spacing used.
 */
export function findTone(x, sampleRate, { loHz = 200, hiHz = 2600, size = 4096, maxFrames = 240 } = {}) {
  const n = Math.min(nextPow2(size), 8192);
  if (x.length < n * 2) return { ok: false, reason: 'span shorter than two analysis frames' };
  const fft = new FFT(n, { precision: 'f64' });
  const w = hann(n);
  const hop = Math.max(n >> 1, Math.floor((x.length - n) / maxFrames) || 1);
  const acc = new Float64Array(n / 2);
  let frames = 0;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let s = 0; s + n <= x.length; s += hop) {
    for (let i = 0; i < n; i++) { re[i] = x[s + i] * w[i]; im[i] = 0; }
    fft.forward(re, im);
    for (let k = 0; k < n / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  if (!frames) return { ok: false, reason: 'no complete analysis frame' };
  for (let k = 0; k < acc.length; k++) acc[k] /= frames;
  const binHz = sampleRate / n;
  const k0 = Math.max(1, Math.round(loHz / binHz));
  const k1 = Math.min(acc.length - 2, Math.round(hiHz / binHz));
  if (k1 <= k0) return { ok: false, reason: 'search band empty at this sample rate' };
  let peak = k0;
  for (let k = k0; k <= k1; k++) if (acc[k] > acc[peak]) peak = k;
  // Quadratic interpolation on the log magnitudes: a hann-windowed tone that
  // falls between bins reads its true frequency to a small fraction of a bin.
  const lm = Math.log(acc[peak - 1] + 1e-30), cm = Math.log(acc[peak] + 1e-30), rm = Math.log(acc[peak + 1] + 1e-30);
  const denom = lm - 2 * cm + rm;
  const delta = denom !== 0 ? 0.5 * (lm - rm) / denom : 0;
  const sorted = Float64Array.from(acc.subarray(k0, k1 + 1)).sort();
  const floor = sorted[sorted.length >> 1] || 1e-30;
  return {
    ok: true,
    hz: (peak + Math.max(-1, Math.min(1, delta))) * binHz,
    binHz,
    snrDb: 10 * Math.log10(acc[peak] / floor),
    frames,
  };
}

// ------------------------------------------------------- baseband and envelope

// A cascade of decimating low-passes, not one long filter at the input rate.
// The narrow bandwidth a 15 wpm signal wants (about 30 Hz two-sided) needs a
// filter of order rate/transition; at 48 kHz that is thousands of taps run at
// the input rate. Mixing the tone to zero first and then throwing away four
// samples in five at each of a few cheap stages costs about 30 multiplies per
// input sample regardless of how narrow the final band is.
function decimateComplex(re, im, factor, stopDb = 60) {
  // Passband to 0.4 of the new Nyquist, stopband at the new Nyquist: the
  // transition is a tenth of the new rate, which fixes the order at ~36·factor
  // taps and so ~36 multiplies per input sample at any factor.
  const cutoff = 0.4 * 0.5 / factor;
  const taps = Math.max(15, Math.round(36 * factor) | 1);
  const h = firLowpass(taps, cutoff, stopDb);
  const m = h.length, d = (m - 1) >> 1, n = re.length;
  const out = Math.floor(n / factor);
  const oRe = new Float32Array(out), oIm = new Float32Array(out);
  for (let j = 0; j < out; j++) {
    const i = j * factor;
    let ar = 0, ai = 0;
    const k0 = Math.max(0, i + d - n + 1);
    const k1 = Math.min(m - 1, i + d);
    for (let k = k0; k <= k1; k++) { const t = i + d - k; ar += h[k] * re[t]; ai += h[k] * im[t]; }
    oRe[j] = ar; oIm[j] = ai;
  }
  return { re: oRe, im: oIm };
}

/**
 * The keying envelope: mix the tone to zero, low-pass at half the wanted noise
 * bandwidth, decimate to something a run-length measurement can work in.
 * `bandwidthHz` is the two-sided noise bandwidth of the result, which is the
 * number an operator would call the filter width.
 */
export function cwEnvelope(x, sampleRate, { toneHz, bandwidthHz, envRate = 800 }) {
  const cutoff = bandwidthHz / 2;
  const w = 2 * Math.PI * toneHz / sampleRate;
  let re = new Float32Array(x.length), im = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const c = Math.cos(w * i), s = Math.sin(w * i);
    re[i] = x[i] * c; im[i] = -x[i] * s;
  }
  let rate = sampleRate;
  // Decimate while the next rate still leaves four times the kept band, so the
  // final stage never has to reach across an aliased transition.
  while (rate / 4 >= Math.max(4 * cutoff, envRate)) {
    const d = decimateComplex(re, im, 4);
    re = d.re; im = d.im; rate /= 4;
  }
  while (rate / 2 >= Math.max(4 * cutoff, envRate)) {
    const d = decimateComplex(re, im, 2);
    re = d.re; im = d.im; rate /= 2;
  }
  // Final shaping to the requested bandwidth, now cheap: the order is set by
  // the transition as a fraction of THIS rate, not of the input rate.
  const trans = Math.max(cutoff * 0.6, rate / 200);
  const taps = Math.min(1023, Math.max(15, Math.round(3.62 * rate / trans) | 1));
  const h = firLowpass(taps, cutoff / rate, 60);
  const m = h.length, dly = (m - 1) >> 1, n = re.length;
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let ar = 0, ai = 0;
    const k0 = Math.max(0, i + dly - n + 1);
    const k1 = Math.min(m - 1, i + dly);
    for (let k = k0; k <= k1; k++) { const t = i + dly - k; ar += h[k] * re[t]; ai += h[k] * im[t]; }
    env[i] = Math.hypot(ar, ai);
  }
  return { env, envRate: rate, bandwidthHz, taps: m };
}

/**
 * Track the key-down level as it fades and divide it out.
 *
 * The reason this exists: a threshold fitted over a window of a few characters
 * assumes the carrier level is the same at both ends of that window, and on HF
 * it is not. Measured here — 'DE VVV TEST' at 18 wpm, no noise at all, keyed on
 * 700 Hz, multiplied by a 0.8 Hz fade 97% deep — the un-tracked slicer read
 * "T E I EV A E EST" for "DE VVV TEST" with a mean character confidence of
 * 0.905 and one character in ten marked. Nothing was wrong with the signal: the
 * elements in the fade nulls simply sat under a threshold set by the peaks.
 *
 * Structure, and why it is not a moving maximum. The fade above swings 30 dB in
 * 0.3 s, which is 125 dB/s at its steepest and 8 dB per element at 18 wpm; a
 * moving maximum wide enough to be sure of containing a mark (a word gap is
 * seven units of silence) is 0.6 s wide and over-estimates the level in the
 * steep stretch by tens of dB. What does work is a peak tracker whose fall is
 * bounded per unit and which is run in both directions, so the level at any
 * point is the lowest value consistent with decaying away from the nearest
 * mark on either side. It is computed on blocks of about 1.5 units rather than
 * per sample, which is what keeps it from chasing the edges of the elements it
 * is normalising — a gain that moved as fast as an element would move the
 * half-amplitude crossings and corrupt the run lengths this whole file reads.
 *
 * `floorMarginDb` is the safety catch, and it is the reason this cannot turn
 * noise into signal: the tracker is never allowed below the tracked noise level
 * plus that margin, so the gain is bounded and a fade null that takes the
 * signal under the noise stays under it instead of being amplified up to meet
 * the slicer. What it does NOT do is notice that those samples were lost — the
 * separation test in `keyStates` does not fire on them, because Otsu's split of
 * a Rayleigh envelope reports 10 dB between its two classes whether there is
 * keying under it or not. What catches a null that swallowed elements is the
 * boundary-doubt gate in `decodeCw`, downstream of here.
 *
 * The whole path is chosen by measurement rather than assumed: `decodeCw`
 * slices each bandwidth both with and without this tracker and keeps whichever
 * fits the run lengths tighter, so on a span it cannot help it is not used.
 */
export function fadeTrack(env, envRate, {
  unitSec, blockUnits = 1.5, dbPerUnit = 8, quantile = 0.9,
  floorQuantile = 0.1, floorMarginDb = 16, maxGainDb = 120,
} = {}) {
  const block = Math.max(4, Math.round(blockUnits * (unitSec > 0 ? unitSec : 0.06) * envRate));
  const nb = Math.floor(env.length / block);
  if (nb < 4) return null;
  const pk = new Float64Array(nb), qlo = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    const s = Float64Array.from(env.subarray(b * block, b * block + block)).sort();
    pk[b] = s[Math.floor(quantile * (block - 1))];
    // The quiet tenth of the same block. In Morse this is the silence between
    // elements and reads near zero; in a stretch of noise it reads the noise.
    // Taking it from the samples rather than from the block peaks is what makes
    // it a noise measurement and not a keying-density measurement — a tenth of
    // 1.5-unit blocks holding no mark at all is true of sparse Morse and false
    // of dense Morse, and the floor must not depend on which.
    qlo[b] = s[Math.floor(floorQuantile * (block - 1))];
  }
  const sorted = Float64Array.from(pk).sort();
  const top = sorted[nb - 1];
  if (!(top > 0)) return null;
  // The floor under the tracker is the local noise, tracked the same way the
  // key-down level is and for the same reason: on HF the noise fades with the
  // signal. A floor taken over a window of a couple of dozen units is set by
  // the loud part of the cycle and then sits above the signal in the null —
  // measured on 'DE VVV TEST' at 18 wpm under a 97% 0.8 Hz fade at +20 dB
  // carrier to noise, a windowed floor clamped the tracker through every null
  // and the span came back as "T E I EV A E EST" with mean confidence 0.88.
  //
  // So: per block, the quiet tenth of the envelope, which is the noise wherever
  // the block holds any gap at all; then a minimum tracker run in both
  // directions whose rise is bounded per unit, which bridges the blocks that
  // are all mark without letting one loud block raise the floor. It is the
  // mirror image of the level tracker below.
  const rise = Math.pow(10, dbPerUnit * blockUnits / 20);
  // A hard bound `maxGainDb` under the loudest block, which does two jobs. It
  // caps the gain, and it gives the minimum tracker somewhere to climb back
  // from: a stretch of true digital silence reads a quiet level of exactly
  // zero, and a bounded-rise minimum tracker started at zero can never leave
  // it, so the noise floor after such a stretch would stay at zero and the
  // level tracker would anchor on the first noise it met. The default is loose
  // — 120 dB, which is below the noise of any real recording — because on a
  // noiseless render the floor has nothing to measure and should not invent
  // one; the depth statistic below is trimmed rather than clamped for the same
  // reason.
  const hardFloor = top * Math.pow(10, -maxGainDb / 20);
  const fwdN = new Float64Array(nb), revN = new Float64Array(nb);
  fwdN[0] = qlo[0];
  for (let b = 1; b < nb; b++) fwdN[b] = Math.min(qlo[b], Math.max(fwdN[b - 1], hardFloor) * rise);
  revN[nb - 1] = qlo[nb - 1];
  for (let b = nb - 2; b >= 0; b--) revN[b] = Math.min(qlo[b], Math.max(revN[b + 1], hardFloor) * rise);
  const floors = new Float64Array(nb);
  const margin = Math.pow(10, floorMarginDb / 20);
  for (let b = 0; b < nb; b++) floors[b] = Math.max(Math.max(fwdN[b], revN[b]) * margin, hardFloor);
  // Only a block whose peak clears the floor may anchor the level tracker. A
  // block of nothing but noise has a 90th percentile 10.1 dB over its 10th —
  // that is a property of a Rayleigh envelope, not of this recording — so
  // without the test the tracker anchors on the noise in every gap, the
  // normalised gap comes back as loud as the normalised mark, and the fitted
  // timing collapses. Measured on 'DE VVV TEST' under a 97% fade at +20 dB, an
  // ungated tracker produced no Morse-shaped fit at any bandwidth at all.
  const anchored = new Float64Array(nb);
  for (let b = 0; b < nb; b++) anchored[b] = pk[b] > floors[b] ? pk[b] : 0;
  const decay = Math.pow(10, -dbPerUnit * blockUnits / 20);
  const fwd = new Float64Array(nb), rev = new Float64Array(nb), lvl = new Float64Array(nb);
  fwd[0] = anchored[0];
  for (let b = 1; b < nb; b++) fwd[b] = Math.max(anchored[b], fwd[b - 1] * decay);
  rev[nb - 1] = anchored[nb - 1];
  for (let b = nb - 2; b >= 0; b--) rev[b] = Math.max(anchored[b], rev[b + 1] * decay);
  // The depth is measured over the blocks that set the level themselves — the
  // ones whose own peak is the tracker's value there, which is to say the ones
  // that hold keying — and never over blocks the tracker is merely decaying
  // through or pinned to the floor in. Without that restriction the seven-unit
  // word gaps and the lead-in silence of a perfectly steady recording report
  // the tracker's own decay as a 50-70 dB fade.
  let atFloor = 0;
  const anchors = [];
  for (let b = 0; b < nb; b++) {
    const v = Math.min(fwd[b], rev[b]);
    lvl[b] = Math.max(floors[b], v);
    if (v <= floors[b]) { atFloor++; continue; }
    if (!(anchored[b] > 0) || v > anchored[b]) continue;
    anchors.push(lvl[b]);
  }
  // The 10th to 90th percentile of the anchors, not their full range: a block
  // that is nine parts silence to one part the ring-out of the last element is
  // still an anchor, sits 50 dB under the keying, and there are only ever a
  // handful of them. Measured on a steady 20 wpm render the full range called
  // that 54 dB of fade; the trimmed range calls it 0.
  anchors.sort((a, b) => a - b);
  const depthDb = anchors.length >= 5
    ? 20 * Math.log10(anchors[Math.floor(0.9 * (anchors.length - 1))]
      / Math.max(anchors[Math.floor(0.1 * (anchors.length - 1))], 1e-30))
    : 0;
  const out = new Float32Array(env.length);
  const half = block / 2;
  const logL = Float64Array.from(lvl, (v) => Math.log(v));
  for (let i = 0; i < env.length; i++) {
    const u = (i - half) / block;
    const b0 = Math.max(0, Math.min(nb - 1, Math.floor(u)));
    const b1 = Math.max(0, Math.min(nb - 1, b0 + 1));
    const t = Math.max(0, Math.min(1, u - b0));
    out[i] = env[i] / Math.exp(logL[b0] * (1 - t) + logL[b1] * t);
  }
  return {
    env: out,
    level: lvl,
    blockSamples: block,
    blocks: nb,
    // The peak-to-trough swing of the tracked key-down level: the fade depth,
    // measured rather than assumed, and worth reporting on its own.
    depthDb,
    anchors: anchors.length,
    floorFraction: atFloor / nb,
  };
}

// ------------------------------------------------------------ key up / key down

/**
 * The slicing level for one window: the key-up and key-down levels as the two
 * class means of a log-amplitude histogram, and a threshold derived from them.
 *
 * Class means rather than percentiles, because percentiles were tried and the
 * 1942 Signal Corps disc broke them. Shellac surface noise is impulsive, the
 * clicks are louder than the keyed tone, and taking the key-down level from the
 * 85th-98th percentile handed it to the crackle: the slicer then sat above the
 * Morse and the run lengths came back as 1-6 ms noise. A class mean is set by
 * the 40% of samples that are key-down, not by the 2% that are clicks.
 */
function sliceLevel(values, bins = 128) {
  const n = values.length;
  if (n < 8) return { thr: Infinity, separationDb: 0 };
  let top = 0;
  for (const v of values) if (v > top) top = v;
  if (!(top > 0)) return { thr: Infinity, separationDb: 0 };
  // Sixty dB below the loudest sample is the bottom of the histogram. Without
  // that clamp a clean recording's digital silence sits at log(0) and stretches
  // the range over hundreds of dB, leaving both real states in one bin.
  const hi = Math.log(top), lo = hi - 60 * Math.LN10 / 20;
  const scale = (bins - 1) / (hi - lo);
  const h = new Float64Array(bins);
  for (const v of values) {
    const b = Math.round((Math.log(Math.max(v, 1e-30)) - lo) * scale);
    h[b < 0 ? 0 : b]++;
  }
  // Otsu's split, used for the two class MEANS and not for the boundary it
  // returns. The boundary itself is the wrong level — measured on a noiseless
  // 20 wpm render it lands about 20 dB under the carrier, in the empty space
  // between the silence spike and the carrier lump, and reads a 180 ms dah as
  // 209 ms. The class means are what the levels below are built from.
  let sumAll = 0;
  for (let b = 0; b < bins; b++) sumAll += b * h[b];
  let wB = 0, sumB = 0, best = -1, cut = 0;
  for (let b = 0; b < bins; b++) {
    wB += h[b];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += b * h[b];
    const d = sumB / wB - (sumAll - sumB) / wF;
    const between = wB * wF * d * d;
    if (between > best) { best = between; cut = b; }
  }
  let sLo = 0, nLo = 0, sHi = 0, nHi = 0;
  for (let b = 0; b < bins; b++) {
    const c = lo + b / scale;
    if (b <= cut) { sLo += c * h[b]; nLo += h[b]; } else { sHi += c * h[b]; nHi += h[b]; }
  }
  if (!nLo || !nHi) return { thr: Infinity, separationDb: 0 };
  const low = Math.exp(sLo / nLo), high = Math.exp(sHi / nHi);
  // Half of the key-down level is the right slicing point for a symmetric
  // keying edge, because that is where the rise and fall cross at their own
  // midpoints. It is only wrong once the noise reaches a quarter of the
  // carrier, and there the geometric mean of the two levels — the equal-
  // variance log-normal decision point — takes over. `max` switches between
  // them at exactly the crossover.
  return {
    thr: Math.max(0.5 * high, Math.sqrt(low * high)),
    separationDb: 20 * Math.log10(high / low),
  };
}

/**
 * Key state over time, with the threshold re-measured in windows so that fading
 * does not turn into a run of dropped characters. A window whose two states are
 * closer than `minSeparationDb` holds no keying that can be read, and is
 * declared key-up rather than sliced down the middle of the noise — that is the
 * failure this function exists to detect.
 */
export function keyStates(env, envRate, { windowSec = 1.5, minSeparationDb = 6 } = {}) {
  const n = env.length;
  const W = Math.max(64, Math.round(windowSec * envRate));
  const step = Math.max(32, W >> 1);
  const centres = [], thrs = [], seps = [];
  const minSpan = Math.min(W, n) * 0.5;
  for (let s = 0; s < n; s += step) {
    const e = Math.min(n, s + W);
    // A ragged last window is worse than none: a stub containing only the tail
    // silence has no two states, is declared dead, and swallows the closing
    // characters. Measured on a 25 wpm render, that cost the final K.
    if (e - s < minSpan) break;
    const { thr, separationDb } = sliceLevel(env.subarray(s, e));
    centres.push((s + e) / 2);
    thrs.push(thr);
    seps.push(separationDb);
  }
  if (!centres.length) return { state: new Uint8Array(n), deadFraction: 1, medianSeparationDb: 0 };
  const state = new Uint8Array(n);
  let dead = 0, up = false, w = 0;
  for (let i = 0; i < n; i++) {
    while (w < centres.length - 2 && centres[w + 1] < i) w++;
    const a = centres[w], b = centres[Math.min(w + 1, centres.length - 1)];
    const t = b > a ? Math.max(0, Math.min(1, (i - a) / (b - a))) : 0;
    const sep = seps[w] * (1 - t) + seps[Math.min(w + 1, seps.length - 1)] * t;
    if (sep < minSeparationDb) { state[i] = 0; up = false; dead++; continue; }
    const thr = Math.exp(Math.log(thrs[w]) * (1 - t) + Math.log(thrs[Math.min(w + 1, thrs.length - 1)]) * t);
    // Hysteresis of +/-1.5 dB about the threshold: without it a fading signal
    // chatters at every crossing and the run lengths fill with 1-sample runs.
    const e = env[i];
    if (up) up = e > thr * 0.84; else up = e > thr * 1.19;
    state[i] = up ? 1 : 0;
  }
  const sorted = Float64Array.from(seps).sort();
  return { state, deadFraction: dead / n, medianSeparationDb: sorted[sorted.length >> 1] || 0 };
}

/**
 * The run length that half the elapsed time sits below. Weighting by time
 * rather than by count is what makes it robust to a slicer chattering on noise:
 * in the 85 s M08 capture, 3,300 noise runs averaging 8 ms outnumber the 350
 * real elements ten to one but hold 26 s against their 54 s, so the count
 * median is 8 ms and the time-weighted median is 237 ms — the real dah.
 */
export function timeWeightedMedian(runs) {
  if (!runs.length) return 0;
  const s = runs.slice().sort((a, b) => a.sec - b.sec);
  let total = 0;
  for (const r of s) total += r.sec;
  let acc = 0;
  for (const r of s) { acc += r.sec; if (acc >= total / 2) return r.sec; }
  return s[s.length - 1].sec;
}

/**
 * Mute the stretches where the slicer is running on something other than this
 * signal's keying. A level squelch cannot do this: in the M08 capture the
 * 25 seconds after the transmission ends still show 10 dB between the 20th and
 * 90th percentile of the envelope, which passes any level test, and produce
 * 3,300 runs of 6-11 ms. What separates them is scale — a window carrying this
 * signal has a time-weighted median run within a factor of a few of the whole
 * file's, and the noise windows measured 0.03 to 0.19 of it against 1.00 for
 * every keyed window. Only the fast side is muted: a window whose runs are
 * unusually long is a pause or a steady carrier and yields no characters
 * anyway, whereas muting it could throw away a real inter-word gap.
 */
export function squelchIncoherent(state, envRate, { windowSec = 2, minScale = 0.25 } = {}) {
  const runs = runLengths(state, envRate);
  // Key-down runs only. Gaps were included at first and that was wrong for a
  // measurable reason: under Farnsworth spacing the file's time is mostly gap
  // — 35-unit word gaps and 15-unit character gaps — so the reference scale
  // became a second and a half, and a window holding a dense character was
  // muted as chatter for having runs a tenth of that. Marks are dits and dahs
  // whatever the spacing, so their scale is the signal's and not the layout's.
  const marks = runs.filter((r) => r.on);
  const W = timeWeightedMedian(marks);
  const n = state.length;
  if (!(W > 0) || marks.length < 8) return { state, muted: 0, scale: W };
  const out = Uint8Array.from(state);
  const win = Math.max(1, Math.round(windowSec * envRate));
  let muted = 0, at = 0;
  const spans = [];
  for (let s = 0; s < n; s += win) {
    const e = Math.min(n, s + win);
    while (at < marks.length && marks[at].end * envRate <= s) at++;
    const local = [];
    for (let j = at; j < marks.length && marks[j].start * envRate < e; j++) local.push(marks[j]);
    if (local.length < 4) continue;
    // What fraction of this window's key-down time is held by marks that could
    // be elements at all — between a third and three times the file's own mark
    // scale. Comparing medians was tried first and mutes too bluntly: at the
    // boundary between a transmission and the noise after it, one window holds
    // both, the hundreds of tiny noise marks outweigh the handful of real ones,
    // and the median verdict takes the last character of the message with it.
    let good = 0, all = 0;
    for (const r of local) {
      all += r.sec;
      if (r.sec >= minScale * W && r.sec <= W / minScale) good += r.sec;
    }
    if (all > 0 && good / all < minScale) { spans.push([s, e]); muted += e - s; }
  }
  // Muting nearly everything means the reference scale itself came from the
  // noise, not from the signal; leaving the span alone and saying so is more
  // honest than deleting the recording.
  if (muted > 0.9 * n) return { state, muted: 0, scale: W, refused: true };
  for (const [s, e] of spans) for (let i = s; i < e; i++) out[i] = 0;
  return { state: out, muted: muted / n, scale: W };
}

/** Run-length encode a key state into alternating marks and spaces, in seconds. */
export function runLengths(state, envRate) {
  const runs = [];
  let i = 0;
  while (i < state.length) {
    const v = state[i];
    let j = i;
    while (j < state.length && state[j] === v) j++;
    runs.push({ on: v === 1, sec: (j - i) / envRate, start: i / envRate, end: j / envRate });
    i = j;
  }
  return runs;
}

// ------------------------------------------------------------------ clustering

// Lloyd on sorted log durations. One dimension and well-separated modes, so it
// lands on the same partition as the exact dynamic-programming solution while
// staying linear in the data — but only if it is seeded properly, and Morse is
// exactly the case where the obvious seeding fails. Intra-character gaps
// outnumber word gaps five or ten to one, so equal-count quantile seeds put two
// of three centres inside the same mode, one cluster starves, and the three
// space classes come back as two. Range seeds are added for that reason and the
// lower-error fit is kept.
function lloydLog(xs, k, seeds, iters = 80) {
  const n = xs.length;
  const c = Float64Array.from(seeds);
  const owner = new Int32Array(n);
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Math.abs(xs[i] - c[0]);
      for (let j = 1; j < k; j++) { const d = Math.abs(xs[i] - c[j]); if (d < bd) { bd = d; best = j; } }
      if (owner[i] !== best) { owner[i] = best; moved = true; }
    }
    const sum = new Float64Array(k), cnt = new Float64Array(k);
    for (let i = 0; i < n; i++) { sum[owner[i]] += xs[i]; cnt[owner[i]]++; }
    for (let j = 0; j < k; j++) {
      if (cnt[j]) { c[j] = sum[j] / cnt[j]; continue; }
      // A starved centre is moved to the worst-fitted point, the standard
      // repair; without it an unbalanced set silently returns fewer classes.
      let worst = 0, wd = -1;
      for (let i = 0; i < n; i++) { const d = Math.abs(xs[i] - c[owner[i]]); if (d > wd) { wd = d; worst = i; } }
      c[j] = xs[worst];
      moved = true;
    }
    if (!moved && it) break;
  }
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (xs[i] - c[owner[i]]) ** 2;
  return { c, owner, sse };
}

function kmeansLog(values, k) {
  const xs = Float64Array.from(values, (v) => Math.log(v)).sort();
  const n = xs.length;
  if (n === 0) return null;
  if (k >= n) k = Math.max(1, n);
  const byCount = [], byRange = [];
  const lo = xs[Math.floor(n * 0.02)], hi = xs[Math.min(n - 1, Math.ceil(n * 0.98))];
  for (let i = 0; i < k; i++) {
    byCount.push(xs[Math.min(n - 1, Math.floor((i + 0.5) * n / k))]);
    byRange.push(lo + (i + 0.5) * (hi - lo) / k);
  }
  const a = lloydLog(xs, k, byCount), b = lloydLog(xs, k, byRange);
  const { c, owner } = a.sse <= b.sse ? a : b;
  const cnt = new Float64Array(k), sq = new Float64Array(k);
  for (let i = 0; i < n; i++) { cnt[owner[i]]++; sq[owner[i]] += (xs[i] - c[owner[i]]) ** 2; }
  const groups = [];
  for (let j = 0; j < k; j++) {
    if (!cnt[j]) continue;
    groups.push({ centre: Math.exp(c[j]), logCentre: c[j], count: cnt[j], logSd: Math.sqrt(sq[j] / cnt[j]) });
  }
  groups.sort((a2, b2) => a2.logCentre - b2.logCentre);
  return groups;
}

/**
 * Absorb runs shorter than `floorSec` into their neighbours. A run a fraction
 * of an element long is the filter ringing or a fade crossing the slicer, not
 * a keyed element, and leaving them in poisons the clustering: four 2.4 ms
 * glitches in a 30 wpm render pulled the dit centre from 35 ms to 27 ms and
 * turned every intra-character gap into a character break. The count comes
 * back because this is a repair and the reader should be told it happened.
 */
export function mergeShort(runs, floorSec) {
  const kept = [];
  let merged = 0;
  const extend = (r) => {
    const last = kept[kept.length - 1];
    last.end = r.end;
    last.sec = last.end - last.start;
  };
  for (const r of runs) {
    if (r.sec < floorSec && kept.length) { extend(r); merged++; continue; }
    if (kept.length && kept[kept.length - 1].on === r.on) { extend(r); continue; }
    kept.push({ ...r });
  }
  return { runs: kept, merged };
}

function medianSec(runs) {
  if (!runs.length) return 0;
  const s = Float64Array.from(runs, (r) => r.sec).sort();
  return s[s.length >> 1];
}

// A split is real only if the centres are far apart relative to the scatter
// inside each class AND far apart in ratio. Machine keying gives tiny scatter
// and passes on either test; a hand fist gives large scatter and needs both.
function splitSupported(a, b, { minRatio = 1.7, minSeparations = 1.4, minShare = 0.04, total = 1 } = {}) {
  const ratio = b.centre / a.centre;
  const spread = a.logSd + b.logSd + 1e-6;
  const gaps = (b.logCentre - a.logCentre) / spread;
  const share = Math.min(a.count, b.count) / total;
  return { ok: ratio >= minRatio && gaps >= minSeparations && share >= minShare, ratio, gaps, share };
}

/**
 * Cluster mark durations into dits and dahs without assuming 1:3, and cluster
 * space durations into the three classes without assuming 1:3:7. `k` for the
 * spaces is chosen by whether each split is supported, so a message with no
 * word gaps reports two space classes instead of inventing a third.
 */
export function clusterTiming(runs) {
  const marks = runs.filter((r) => r.on).map((r) => r.sec);
  const spaces = runs.filter((r) => !r.on).map((r) => r.sec);
  if (marks.length < 6) return { ok: false, reason: `only ${marks.length} keyed runs` };

  let mk = kmeansLog(marks, 2);
  let markSplit = mk.length === 2 ? splitSupported(mk[0], mk[1], { total: marks.length }) : { ok: false, ratio: 1, gaps: 0, share: 0 };
  if (!markSplit.ok) mk = kmeansLog(marks, 1);

  const dit0 = mk[0].centre;
  // Interior spaces only: the run list may open or close with the silence
  // either side of the transmission, which is not an inter-word gap. Anything
  // under half a unit is not a space class either — it is a glitch that
  // survived merging, and letting it become class 0 shifts every other class
  // up one and reads each character as a separate letter.
  const interior = [];
  let shortSpaces = 0, longGaps = 0;
  for (let i = 1; i < runs.length - 1; i++) {
    if (runs[i].on) continue;
    if (runs[i].sec < 0.45 * dit0) { shortSpaces++; continue; }
    // A gap of sixty units or more is a pause between transmissions, not an
    // inter-word gap. Left in, one 25-second silence becomes the whole top
    // space class and every real word gap falls into the character class. The
    // cap was twenty units first and that was too tight: Farnsworth spacing at
    // 18 wpm characters and 8 wpm throughput puts its word gaps at 35 units,
    // and excluding them collapsed the three space classes to two and read
    // every character as its own word.
    if (runs[i].sec > 60 * dit0) { longGaps++; continue; }
    interior.push(runs[i].sec);
  }
  const pool = interior.length >= 4 ? interior : spaces;
  let sp = kmeansLog(pool, 3);
  if (sp && sp.length === 3) {
    const upper = splitSupported(sp[1], sp[2], { minRatio: 1.6, total: pool.length });
    if (!upper.ok) sp = kmeansLog(pool, 2);
  }
  if (sp && sp.length === 2) {
    const lower = splitSupported(sp[0], sp[1], { minRatio: 1.6, total: pool.length });
    if (!lower.ok) sp = kmeansLog(pool, 1);
  }

  const dit = mk[0].centre;
  const dah = mk.length === 2 ? mk[1].centre : null;
  return {
    ok: true,
    marks: mk,
    spaces: sp || [],
    shortSpaces,
    longGaps,
    ditSec: dit,
    dahSec: dah,
    dahDitRatio: dah ? dah / dit : null,
    markSplit,
    spaceRatios: (sp || []).map((g) => g.centre / dit),
    counts: { marks: marks.length, spaces: pool.length },
  };
}

/**
 * How safely one run length can be called a member of the class it was assigned
 * to. Two different things make that call unsafe and the number has to fall for
 * both, which is why this is a product of two terms.
 *
 * Position. An element halfway between two class centres could belong to
 * either. That is the margin term: 1 at its own centre, 0 at the midpoint,
 * measured as a fraction of the distance between the two centres.
 *
 * Scale. Classes whose scatter is comparable to the gap between them overlap,
 * and then even an element sitting exactly on a centre is not safely assigned.
 * The margin term cannot see this — it reports 1.00 for a centred element
 * however wide the class is — which is the defect this second term fixes. It is
 * the posterior under the fitted classes read as log-normals with their own
 * measured counts and scatters: two classes 1.7 apart in ratio with a log
 * scatter of 0.25 each, which is the loosest split `splitSupported` will still
 * accept, give a centred element 0.9049 where the margin term alone gives
 * exactly 1.0000.
 *
 * `sdFloor` keeps a machine-keyed class, whose measured scatter can be a few
 * parts in ten thousand, from making the posterior a step function.
 */
export function elementConfidence(sec, groups, index, { sdFloor = 0.02 } = {}) {
  if (groups.length < 2) return 0.5;
  const l = Math.log(sec);
  let other = index === 0 ? 1 : index - 1;
  for (let j = 0; j < groups.length; j++) {
    if (j === index) continue;
    if (Math.abs(l - groups[j].logCentre) < Math.abs(l - groups[other].logCentre)) other = j;
  }
  const sep = Math.abs(groups[other].logCentre - groups[index].logCentre);
  if (!(sep > 0)) return 0;
  const margin = Math.abs(l - groups[other].logCentre) - Math.abs(l - groups[index].logCentre);
  const position = Math.max(0, Math.min(1, margin / sep));
  let total = 0, mine = 0;
  for (let j = 0; j < groups.length; j++) {
    const sd = Math.max(groups[j].logSd, sdFloor);
    const z = (l - groups[j].logCentre) / sd;
    const d = (groups[j].count || 1) * Math.exp(-0.5 * z * z) / sd;
    total += d;
    if (j === index) mine = d;
  }
  const posterior = total > 0 ? mine / total : 0;
  return Math.max(0, Math.min(1, position * posterior));
}

function nearest(sec, groups) {
  const l = Math.log(sec);
  let best = 0, bd = Infinity;
  for (let j = 0; j < groups.length; j++) { const d = Math.abs(l - groups[j].logCentre); if (d < bd) { bd = d; best = j; } }
  return best;
}

// ------------------------------------------------------------------- assembly

function assemble(runs, timing, { uncertainBelow = 0.6 } = {}) {
  const marks = timing.marks, spaces = timing.spaces;
  const chars = [];
  // Two kinds of doubt, kept apart because they mean different things. Element
  // doubt is the marks and the gaps inside a character not falling cleanly into
  // their classes, which is what a wobbly hand fist looks like and which does
  // not by itself put the letters in the wrong places. Boundary doubt is the
  // character and word gaps not falling into theirs, which is what a lost
  // element looks like: the dit goes and the gap either side of it swallows its
  // neighbours. Measured on a hand fist at 30% element jitter, every character
  // decodes correctly and none of them carries boundary doubt; measured on the
  // same message under a fade that buried its nulls, half of them do.
  let pattern = '', conf = 1, edge = 1, startSec = null, pendingWord = false, carry = 1;
  const push = (endSec) => {
    if (!pattern) return;
    const ch = morseToChar(pattern);
    const both = Math.min(conf, edge);
    chars.push({
      pattern,
      char: ch === null ? `<?${pattern}>` : ch,
      known: ch !== null,
      prosign: CW_PROSIGNS[pattern] || null,
      nonItu: NON_ITU.has(pattern),
      confidence: ch === null ? 0 : both,
      elementConfidence: conf,
      boundaryConfidence: edge,
      uncertain: ch === null || both < uncertainBelow,
      boundaryUncertain: edge < uncertainBelow,
      startSec, endSec,
      wordBreakBefore: pendingWord,
    });
    pattern = ''; conf = 1; edge = carry; startSec = null; pendingWord = false; carry = 1;
  };
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r.on) {
      if (startSec === null) startSec = r.start;
      const idx = marks.length > 1 ? nearest(r.sec, marks) : 0;
      pattern += (marks.length > 1 && idx === 1) ? '-' : (marks.length > 1 ? '.' : '?');
      conf = Math.min(conf, elementConfidence(r.sec, marks, idx));
    } else {
      if (i === 0 || i === runs.length - 1) continue;         // lead-in / tail silence
      if (!spaces.length) continue;
      const idx = nearest(r.sec, spaces);
      if (idx === 0) { conf = Math.min(conf, elementConfidence(r.sec, spaces, idx)); continue; }
      // The gap that ends a character is part of that character's evidence. If
      // it does not fall cleanly into a class, the boundary is in the wrong
      // place — which is exactly what a lost element looks like from here: the
      // dit vanishes and the gap either side of it swallows its neighbours.
      // Both characters that share the boundary carry the doubt.
      const gapConf = elementConfidence(r.sec, spaces, idx);
      edge = Math.min(edge, gapConf);
      const end = r.start;
      push(end);
      carry = gapConf;
      if (idx >= 2 || (spaces.length === 2 && idx === 1 && spaces[1].centre / spaces[0].centre > 4.5)) pendingWord = true;
    }
  }
  push(runs.length ? runs[runs.length - 1].start : 0);
  return chars;
}

const renderText = (chars) => chars.map((c) => (c.wordBreakBefore ? ' ' : '') + c.char).join('');
const renderMarked = (chars) => chars.map((c) => (c.wordBreakBefore ? ' ' : '') + (c.uncertain ? `[${c.char}]` : c.char)).join('');

// PARIS again, but counted off the decode rather than off the dit: dit 1, dah 3,
// gap inside a character 1, between characters 3, between words 7. Divided into
// the elapsed time this is the throughput, which is what differs from the
// character speed when a sender uses Farnsworth spacing.
function unitsOf(chars) {
  let u = 0;
  for (let i = 0; i < chars.length; i++) {
    const p = chars[i].pattern;
    for (const e of p) u += e === '-' ? 3 : 1;
    u += p.length - 1;
    if (i < chars.length - 1) u += chars[i + 1].wordBreakBefore ? 7 : 3;
  }
  return u;
}

/**
 * Whether a fitted timing model is Morse timing at all. An intra-character gap
 * and a dit are the same one unit by definition, and a character gap is three;
 * when the slicer starts chopping elements in half those ratios collapse
 * together long before the text looks obviously wrong.
 *
 * Calibrated over 521 renders (3 messages x 12/20/30 wpm x 0 and 20% jitter x
 * dah/dit 3 and 4 x +20 to -13 dB x 3 seeds), scored against the message that
 * was actually sent: 334 decodes with under 5% character error had the intra
 * gap in 1.00-1.23 units and the character gap in 2.99-3.38; 155 decodes with
 * over 30% error had the intra gap down to 0.51 and the character gap down to
 * 1.09. The bounds below flagged 100 of the 155 broken decodes and none of the
 * 334 good ones.
 *
 * No upper bound on the gaps: Farnsworth spacing is legitimate Morse with a
 * character gap of 16 units, and refusing to read it would be a bug.
 */
export function morseShaped(timing) {
  const bad = [];
  if (!timing || !timing.ok) return { ok: false, bad: ['no timing fitted'] };
  const sr = timing.spaceRatios;
  if (timing.dahDitRatio !== null && !(timing.dahDitRatio >= 2 && timing.dahDitRatio <= 6)) {
    bad.push(`dah/dit ${timing.dahDitRatio.toFixed(2)} (expect 2-6)`);
  }
  if (sr.length && !(sr[0] >= 0.9)) bad.push(`intra-character gap ${sr[0].toFixed(2)} units (expect 1)`);
  if (sr.length >= 2 && !(sr[1] >= 2.3)) bad.push(`character gap ${sr[1].toFixed(2)} units (expect 3 or more)`);
  return { ok: bad.length === 0, bad };
}

// ------------------------------------------------------------------- the decode

/**
 * Read Morse out of a real span of audio.
 *
 * Returns, always: what tone it locked to and how far above the noise floor it
 * was, the speed it measured, the ratios it actually found (not the ones the
 * standard specifies), the filter bandwidth it chose and why, the text, and a
 * confidence for every character. On failure it returns `ok:false` and a reason
 * rather than a plausible-looking string.
 */
export function decodeCw(x, sampleRate, opts = {}) {
  const {
    toneHz = null,
    searchLoHz = 200, searchHiHz = 2600,
    minSeparationDb = 6,
    uncertainBelow = 0.6,
    wideBandwidthHz = 400,
    agc = true,
    fadeDbPerUnit = 8,
    maxBoundaryDoubt = 0.15,
    // The two gates for the fade that fades the TRANSMISSION while the
    // receiver's own noise floor stays where it is. See `mixedSpaceClass` and
    // `fadeDoubt` below; both are numbers so that a test can turn each off and
    // show that the span it was catching comes back as confident wrong text.
    maxSpaceClassExcessSd = 0.08,
    fadeDoubtDepthDb = 10,
    fadeMinConfidence = 0.955,
    // The contrast below which key-down and key-up are the same noise. See
    // `atTheNoiseSplit` below.
    minKeyingSnrDb = 11.5,
    // Absolute speed. This is a WARNING and deliberately not a gate: over 100
    // noise spans across five colours it fires 17 times, and disabling it
    // changes not one verdict, because the gates below already refuse all 17.
    // It earns its place by saying WHY — "the fitted unit implies 110 words per
    // minute" is a better thing for a reader to see than a statement about
    // gap-class scatter. A guard that changes no outcome is not a guard.
    minWpm = 4,
    maxWpm = 70,
    fadeOpts = {},
  } = opts;
  const warnings = [];
  if (!x || x.length < sampleRate * 0.5) return { ok: false, reason: 'span shorter than half a second' };

  const tone = toneHz
    ? { ok: true, hz: toneHz, binHz: 0, snrDb: NaN, frames: 0 }
    : findTone(x, sampleRate, { loHz: searchLoHz, hiHz: searchHiHz });
  if (!tone.ok) return { ok: false, reason: `no tone found: ${tone.reason}` };

  // One measurement at one bandwidth, all the way to a fitted timing model.
  //
  // The fade tracker is not applied on faith. Each bandwidth is sliced twice —
  // once on the envelope as it stands, once with the tracked key-down level
  // divided out — and the two are judged by the same log-scatter of the fitted
  // run-length classes that chooses the bandwidth itself. Both slicings share
  // one envelope, so the second costs a few percent rather than double: the
  // filtering is what the measurement spends its time on.
  //
  // Measured over twelve constructed spans, scatter with the tracker against
  // scatter without: 0.0074/0.0699 on a 97%-deep 0.8 Hz fade, 0.0062/0.0233 on
  // a 90% 0.25 Hz fade, 0.0070/0.0575 on a 90% fade at +10 dB — and, the other
  // way, 0.1219/0.0146 on ten characters followed by four seconds of loud noise
  // on the same note, where dividing by the tracked level lifts the noise into
  // the slicer. The criterion picks correctly in all twelve, which is why it is
  // a measurement and not a switch.
  const measure = (bandwidthHz, ditHint) => {
    // Twenty-odd envelope samples per unit is not enough: at 15 wpm that is a
    // 2 ms grid on a 78 ms dit, and the quantisation shows up directly in the
    // class scatter that the bandwidth is chosen by. 1 kHz floor costs nothing
    // — an 85 s capture is 85,000 envelope samples.
    const envRate = Math.max(1000, Math.min(4000, ditHint ? 48 / ditHint : 2000));
    const env = cwEnvelope(x, sampleRate, { toneHz: tone.hz, bandwidthHz, envRate });

    const slice = (values, fade) => {
      const key = keyStates(values, env.envRate, {
        windowSec: ditHint ? Math.max(0.8, 40 * ditHint) : 1.5,
        minSeparationDb,
      });
      const sq = squelchIncoherent(key.state, env.envRate, { windowSec: ditHint ? Math.max(1, 30 * ditHint) : 2 });
      const raw = runLengths(sq.state, env.envRate);
      // The median run in Morse is one unit long — intra-character gaps and
      // dits together outnumber everything else — so a quarter of the median is
      // a speed-free floor before there is any unit estimate to use.
      const floor = ditHint ? ditHint / 3 : 0.25 * medianSec(raw);
      const m = mergeShort(raw, floor);
      const timing = clusterTiming(m.runs);
      const out = {
        bandwidthHz, env, fade, sliced: values, key, runs: m.runs, timing, merged: m.merged,
        mutedFraction: sq.muted, scatter: Infinity, why: '',
      };
      if (!timing.ok) { out.why = `no keying at ${bandwidthHz.toFixed(0)} Hz (${timing.reason})`; return out; }
      if (!(timing.ditSec > 0.008 && timing.ditSec < 0.5)) {
        out.why = `run lengths at ${bandwidthHz.toFixed(0)} Hz imply a ${(timing.ditSec * 1000).toFixed(1)} ms unit, outside 2.4-150 wpm`;
        return out;
      }
      // Noise sliced at a threshold produces run lengths with no structure: two
      // mark classes a factor of three apart and several standard deviations
      // clear of each other is a property of keying, not of a threshold
      // crossing. That structural test, rather than an SNR number, is what
      // separates a decode from a hallucination here.
      if (!((timing.markSplit.ok || key.medianSeparationDb >= 20) && timing.spaces.length >= 2)) {
        out.why = `no dit/dah structure at ${bandwidthHz.toFixed(0)} Hz`;
        return out;
      }
      // How tightly the run lengths fall into their classes, in log units,
      // pooled over marks and spaces by class size. This is the whole selection
      // criterion below and it needs no reference: a filter too wide leaves
      // noise jitter on the edges, a filter too narrow moves the half-amplitude
      // crossings by its own rise time, and both show up here as scatter.
      let w = 0, sd = 0;
      for (const gr of timing.marks.concat(timing.spaces)) { w += gr.count; sd += gr.count * gr.logSd; }
      out.rawScatter = w ? sd / w : Infinity;
      // A bandwidth whose fit is not Morse-shaped is not a candidate at all,
      // however tightly its classes happen to cluster. Without this the sweep
      // could pick a filter so narrow that it smeared the intra-character gaps
      // into the dits: measured at -6 dB, that returned a correct decode with a
      // fitted 1 : 2.0 : 5.4 spacing, which any honest reader would distrust.
      const shape = morseShaped(timing);
      out.shape = shape;
      out.scatter = shape.ok ? out.rawScatter : Infinity;
      return out;
    };

    const fade = agc ? fadeTrack(env.env, env.envRate, {
      unitSec: ditHint || 0.06, dbPerUnit: fadeDbPerUnit, ...fadeOpts,
    }) : null;
    if (!fade) {
      const only = slice(env.env, null);
      only.agc = false;
      return only;
    }
    const tracked = slice(fade.env, fade);
    // `agc: 'always'` skips the comparison. It is here so that the two paths
    // can be measured against each other from outside, which is how the
    // thresholds in `fadeTrack` were set; the default is to choose.
    if (agc === 'always') { tracked.agc = true; return tracked; }
    const plain = slice(env.env, null);
    // Ties and near-ties go to the untracked slicing: dividing by a level that
    // is already flat can only add its own estimation noise, so the tracker has
    // to earn its place on every span.
    const pick = tracked.scatter < plain.scatter ? tracked : plain;
    pick.agc = pick === tracked;
    pick.agcCompare = {
      tracked: Number.isFinite(tracked.scatter) ? +tracked.scatter.toFixed(4) : null,
      plain: Number.isFinite(plain.scatter) ? +plain.scatter.toFixed(4) : null,
      depthDb: +fade.depthDb.toFixed(1),
    };
    pick.fade = fade;
    return pick;
  };

  // The first look has to be wide enough not to smear the run lengths it is
  // measuring — but wide costs noise bandwidth, and below about 0 dB carrier to
  // noise in 4 kHz a 400 Hz first look is slicing noise. So the start is walked
  // down by halves until one produces keying structure.
  let first = null;
  const tried = [];
  for (const start of [wideBandwidthHz, wideBandwidthHz / 2, wideBandwidthHz / 4, wideBandwidthHz / 8]) {
    first = measure(start, 0);
    tried.push(`${start.toFixed(0)} Hz: ${first.why || 'keying'}`);
    if (!first.why) break;
  }
  if (first.why) {
    return {
      ok: false,
      reason: `no readable keying on ${tone.hz.toFixed(0)} Hz — ${tried.join('; ')}`,
      tone,
      keyingSeparationDb: first.key ? first.key.medianSeparationDb : 0,
    };
  }
  if (first.bandwidthHz !== wideBandwidthHz) {
    warnings.push(`first look at ${wideBandwidthHz} Hz found no keying structure; started from ${first.bandwidthHz.toFixed(0)} Hz instead`);
  }

  // Now choose the filter by measuring, not by a formula. The textbook matched
  // width for on-off keying is a small multiple of the keying rate, but which
  // multiple depends on the signal: 4/T is right for a weak signal and wrong for
  // a clean one, where its 20 ms rise time on a 78 ms dit visibly moves the
  // element boundaries. Measured on the 85 s M08 capture, 4/T (51 Hz) fitted the
  // run lengths with a log scatter of 0.10-0.20 and lost the inter-word class
  // entirely, while 400 Hz fitted at 0.006 and recovered 1.02 : 3.05 : 7.23 —
  // so the sweep below tries the whole range and keeps whichever fits tightest.
  let best = first, sweep = [];
  for (let round = 0; round < 2; round++) {
    const T = best.timing.ditSec;
    const cands = [...new Set([2, 3, 4, 6, 9, 13, 20, 30].map(
      (k) => Math.round(Math.max(40, Math.min(1200, k / T))),
    ))];
    sweep = [];
    let pick = best;
    for (const b of cands) {
      const m = b === best.bandwidthHz ? best : measure(b, T);
      sweep.push({
        hz: b,
        scatter: Number.isFinite(m.rawScatter) ? +m.rawScatter.toFixed(4) : null,
        shaped: m.shape ? m.shape.ok : false,
        // The unit each bandwidth fitted. The spread of these across the
        // bandwidths that fitted Morse-shaped timing is how much the answer
        // depends on a choice the decoder made, which is a systematic error the
        // fit's own standard error cannot see and the interval below uses.
        ditMs: m.timing && m.timing.ok ? +(m.timing.ditSec * 1000).toFixed(3) : null,
        why: m.why || (m.shape && !m.shape.ok ? m.shape.bad.join(', ') : undefined),
      });
      if (m.scatter < pick.scatter) pick = m;
      if (!Number.isFinite(pick.scatter) && m.rawScatter < (pick.rawScatter ?? Infinity)) pick = m;
    }
    const settled = Math.abs(Math.log(pick.timing.ditSec / best.timing.ditSec)) < 0.12 && pick.bandwidthHz === best.bandwidthHz;
    best = pick;
    if (settled) break;
  }
  const fit = best;
  const { key, runs, timing, merged, mutedFraction } = fit;
  const narrow = fit.env;

  // The error bar on the unit, and the test that decides what it is worth.
  //
  // The fit's own answer is the standard error of the dit class mean in log
  // units, logSd/sqrt(n). That number believes the fit. What settles it is
  // measuring the two halves of the span separately: two independent estimates
  // of one quantity differ by sqrt(2) times each one's standard error, so half
  // the observed difference estimates that error without trusting the fit at
  // all. The interval below takes whichever is larger, so an error bar the
  // split-half test contradicts is widened rather than published.
  const splitAt = Math.floor(runs.length / 2);
  const halves = [clusterTiming(runs.slice(0, splitAt)), clusterTiming(runs.slice(splitAt))];
  const seOf = (g) => (g && g.count > 1 ? g.logSd / Math.sqrt(g.count) : Infinity);
  const bothHalves = halves[0].ok && halves[1].ok;
  const splitLogDit = bothHalves ? Math.abs(Math.log(halves[0].ditSec / halves[1].ditSec)) / 2 : null;
  const fitSeDit = seOf(timing.marks[0]);
  // A zero-width interval is its own kind of lie. Run lengths are counted on
  // the envelope's sample grid, so each edge is quantised by 1/envRate with a
  // standard deviation of q/sqrt(12) and each run carries two edges; that is
  // the resolution floor under any estimate made from this envelope, and no
  // amount of machine-perfect keying gets below it.
  const q = 1 / narrow.envRate;
  const quantSe = Math.sqrt(2) * (q / Math.sqrt(12)) / timing.ditSec
    / Math.sqrt(Math.max(1, timing.marks[0].count));
  // The term that actually decides whether the interval covers, and the one
  // that was missing: the answer depends on which filter the sweep chose, and
  // that dependence is a systematic error no amount of counting run lengths can
  // see. Every bandwidth in the sweep that fitted Morse-shaped timing is a
  // defensible reading of the same span, so the scatter of their units is what
  // the choice is worth. Measured over a 30-span grid (12/20/28 wpm x
  // noiseless/+20/+10/+6/0 dB x 2 seeds) against the unit that was actually
  // rendered: the fit's own standard error ran 0.0003-0.0083 in log units while
  // the true error ran 0.0000-0.0240, so the published interval covered 13 of
  // 30. The bandwidths' own scatter ran 0.009-0.021, and 1.25 times it covers
  // 30 of 30 at a median width of x1.07 and a worst of x1.11.
  const shapedDits = sweep.filter((e) => e.shaped && e.ditMs > 0).map((e) => Math.log(e.ditMs));
  let filterSpread = 0;
  if (shapedDits.length > 1) {
    const mean = shapedDits.reduce((a, b) => a + b, 0) / shapedDits.length;
    let ss = 0;
    for (const v of shapedDits) ss += (v - mean) ** 2;
    filterSpread = Math.sqrt(ss / (shapedDits.length - 1));
  }
  const sigmaDit = Math.max(
    Number.isFinite(fitSeDit) ? fitSeDit : 0, splitLogDit || 0, quantSe, 1.25 * filterSpread,
  );
  const ci = (v, sigma) => [v * Math.exp(-1.96 * sigma), v * Math.exp(1.96 * sigma)];
  const ditMsCi = ci(timing.ditSec * 1000, sigmaDit);

  let sigmaRatio = null, splitLogRatio = null;
  if (timing.dahDitRatio !== null) {
    const fitSeRatio = Math.hypot(
      Math.max(seOf(timing.marks[1]), quantSe * Math.sqrt(timing.marks[0].count / Math.max(1, timing.marks[1].count))),
      Math.max(fitSeDit, quantSe),
    );
    const r0 = bothHalves ? halves[0].dahDitRatio : null;
    const r1 = bothHalves ? halves[1].dahDitRatio : null;
    splitLogRatio = (r0 && r1) ? Math.abs(Math.log(r0 / r1)) / 2 : null;
    sigmaRatio = Math.max(Number.isFinite(fitSeRatio) ? fitSeRatio : 0, splitLogRatio || 0);
  }
  const splitHalf = {
    tested: bothHalves,
    reason: bothHalves ? undefined : `too few runs in one half (${halves[0].reason || 'ok'} / ${halves[1].reason || 'ok'})`,
    ditMsFirst: bothHalves ? halves[0].ditSec * 1000 : null,
    ditMsSecond: bothHalves ? halves[1].ditSec * 1000 : null,
    ditFitSigmaLog: Number.isFinite(fitSeDit) ? fitSeDit : null,
    ditSplitSigmaLog: splitLogDit,
    ditWidened: splitLogDit !== null && splitLogDit > fitSeDit,
    // Which of the four candidate sigmas the published interval is actually
    // made of, so a reader can see whether the fit, the split-half test, the
    // envelope's sample grid or the choice of filter is what it rests on.
    ditFilterSigmaLog: filterSpread ? 1.25 * filterSpread : null,
    ditSigmaLog: sigmaDit,
    ditSigmaFrom: sigmaDit === (splitLogDit || 0) ? 'split-half'
      : (sigmaDit === 1.25 * filterSpread ? 'filter choice'
        : (sigmaDit === quantSe ? 'envelope sample grid' : 'the fit')),
    ratioFirst: bothHalves ? halves[0].dahDitRatio : null,
    ratioSecond: bothHalves ? halves[1].dahDitRatio : null,
    ratioSplitSigmaLog: splitLogRatio,
  };
  if (fit.fade && fit.fade.depthDb > 10) {
    warnings.push(`the key-down level swings ${fit.fade.depthDb.toFixed(0)} dB across this span`
      + `${fit.agc ? ' and was tracked out before slicing' : ', and tracking it out fitted the run lengths no better than leaving it'}`);
  }
  if (splitHalf.ditWidened) {
    warnings.push(`the two halves of the span measure the unit at ${splitHalf.ditMsFirst.toFixed(1)} and `
      + `${splitHalf.ditMsSecond.toFixed(1)} ms, further apart than the fit's own error bar; `
      + `the reported interval is widened to match`);
  }
  if (merged) warnings.push(`${merged} sub-third-unit runs merged into their neighbours`);
  if (mutedFraction > 0.01) {
    warnings.push(`${(mutedFraction * 100).toFixed(0)}% of the span carried runs far too short to be this signal's keying and was muted`);
  }
  if (!timing.markSplit.ok) {
    warnings.push(`dit and dah are not separable (ratio ${timing.markSplit.ratio.toFixed(2)}, ${timing.markSplit.gaps.toFixed(1)} sd apart) — every element read as one class`);
  }
  if (timing.spaces.length < 2) warnings.push('space lengths form a single class — character boundaries are not resolvable');
  if (timing.spaces.length === 2) warnings.push('only two space classes found — no inter-word gaps in this span');
  if (key.deadFraction > 0.2) warnings.push(`${(key.deadFraction * 100).toFixed(0)}% of the span had under ${minSeparationDb} dB between key-up and key-down and was read as silence`);

  // The decision signal-to-noise the decoder actually ran on: mean power in the
  // key-down runs against mean power in the key-up runs, inside the matched
  // filter. This, not the spectral peak, is the number that predicts errors.
  let onP = 0, onN = 0, offP = 0, offN = 0;
  for (const r of runs) {
    const a = Math.round(r.start * narrow.envRate), b = Math.round(r.end * narrow.envRate);
    for (let i = a; i < b && i < narrow.env.length; i++) {
      const p = narrow.env[i] * narrow.env[i];
      if (r.on) { onP += p; onN++; } else { offP += p; offN++; }
    }
  }
  const keyingSnrDb = (onN && offN && offP > 0) ? 10 * Math.log10((onP / onN) / (offP / offN)) : NaN;

  // No bandwidth in the sweep produced Morse-shaped timing means the model
  // underneath the text is wrong, not merely uncertain. The read is still
  // returned — a human may want to look at it — but `ok` is false and every
  // character is marked, because a caller that prints `text` without checking
  // should get nothing it could mistake for a decode.
  const shape = morseShaped(timing);
  const timingPlausible = shape.ok;
  if (!timingPlausible) {
    warnings.push(`no bandwidth produced Morse-shaped timing — ${shape.bad.join(', ')}; every character is marked uncertain`);
  }

  const chars = assemble(runs, timing, { uncertainBelow });
  if (!timingPlausible) for (const c of chars) c.uncertain = true;
  // Characters whose BOUNDARY gaps do not fall into the fitted classes, as a
  // fraction. This is the gate, and it is boundary doubt rather than doubt of
  // any kind because the two populations separate on exactly that distinction.
  // Measured over 26 constructed spans: of the 14 that decoded exactly — clean
  // keying at three speeds, +20 and 0 dB, Farnsworth, a 4:1 hand fist, a hand
  // fist at 40% element jitter, a 97% fade, Morse followed by loud noise —
  // every single one carried 0% boundary doubt, while the wobbliest fists
  // carried up to 85% ELEMENT doubt and still read perfectly. Of the 12 that
  // came back wrong, 8 carried 20-66% boundary doubt. So the gate sits at 15%,
  // which every correct span clears by its whole margin and which costs the
  // hand fist nothing. It exists because the alternative — printing
  // "T E I EV A E EST" for "DE VVV TEST" with a mean confidence of 0.9 — is the
  // failure this capability is for.
  const doubtful = chars.filter((c) => c.boundaryUncertain).length;
  const boundaryDoubt = chars.length ? doubtful / chars.length : 0;
  const tooManyUncertain = timingPlausible && boundaryDoubt > maxBoundaryDoubt;
  if (tooManyUncertain) {
    warnings.push(`${doubtful} of ${chars.length} characters sit against a gap that does not fall into `
      + 'any fitted space class — elements are missing from this span, not merely uncertain');
  }

  const text = renderText(chars);
  const marked = renderMarked(chars);
  const known = chars.filter((c) => c.known).length;
  const meanConfidence = chars.length ? chars.reduce((s, c) => s + c.confidence, 0) / chars.length : 0;
  // ---- the fade that fades the transmission and not the noise under it
  //
  // A fade applied to a whole recording takes the noise down with the signal,
  // and the level tracker above reads it back perfectly. A real HF fade does
  // not: propagation fades the transmission while the receiver's own noise
  // floor stays where it is, so the nulls put elements UNDER the noise and they
  // are not received at all. Measured on 'DE VVV TEST' at 18 wpm under a 0.8 Hz
  // fade with an independent floor, 5 depths x 3 signal-to-noise ratios x 3
  // seeds: 16 of 45 spans came back with `ok: true` and the wrong message, and
  // the boundary-doubt gate above read 0% on 7 of them, because the gaps left
  // by a swallowed character land inside the fitted word-gap class instead of
  // outside every class. Two things separate those spans from every span that
  // decoded exactly, and both are measurements the fit already makes.
  //
  // One. The word-gap class stops being one class. A gap left where a character
  // was lost is 7 units plus whatever the character was, so the top space class
  // becomes a mixture of real word gaps and longer ones and its log scatter
  // jumps, while the character-gap class beneath it stays tight. Over 77
  // correct decodes — clean, 0 dB, Farnsworth, a 4:1 fist, +-25% spacing
  // jitter, a 97% fade with no noise — that excess scatter never exceeded
  // 0.048; over 19 wrong ones it reached 0.250, and 10 of them cleared 0.15.
  // The excess and not the scatter itself is the test, because a sloppy hand
  // widens every space class together: measured at +-20% gap jitter the top
  // class scatters 0.118 and the message still reads exactly.
  //
  // Two. Element doubt inside a fade means something it does not mean outside
  // one. A 40%-jitter hand fist reads perfectly at a mean confidence of 0.55
  // with no fade at all, so confidence alone is not a gate — applied to every
  // span it refuses a fifth of the correct decodes. Conditioned on the key-down
  // level having swung more than `fadeDoubtDepthDb` across the span it is a
  // different statistic. Measured over the 168-span depth x noise x seed grid
  // plus 24 unfaded controls, on the spans that survived every other gate: 29
  // came back wrong, their mean confidence topping out at 0.9528, while the 43
  // correct reads that carried a fade over 10 dB ran 0.8533 to 0.9927. The two
  // populations overlap, so the bar is set at the top of the wrong one: it
  // refuses all 29 and costs 4 of 163 correct reads, which are the four faded
  // spans below 0.955. Refusing 2.5% of what it could have read is the price of
  // no confident wrong message anywhere in the grid, and it is the right way
  // round: this returns `ok: false` and a reason, not a plausible sentence.
  const spaceClasses = timing.spaces;
  const spaceExcessSd = spaceClasses.length >= 2
    ? spaceClasses[spaceClasses.length - 1].logSd - spaceClasses[spaceClasses.length - 2].logSd
    : 0;
  const mixedSpaceClass = timingPlausible && spaceExcessSd > maxSpaceClassExcessSd;
  if (mixedSpaceClass) {
    warnings.push(`the longest space class scatters ${spaceExcessSd.toFixed(3)} in log units more than the `
      + 'class below it — it is holding two populations, which is what a gap left by a lost character does');
  }
  const fadeDepth = fit.fade ? fit.fade.depthDb : 0;
  const fadeDoubt = timingPlausible && fadeDepth > fadeDoubtDepthDb && meanConfidence < fadeMinConfidence;
  if (fadeDoubt) {
    warnings.push(`the key-down level swings ${fadeDepth.toFixed(0)} dB and the elements read out of it average `
      + `${meanConfidence.toFixed(2)} confidence — in a fade that is elements lost in the nulls, not a wobbly fist`);
  }
  const elementsLost = mixedSpaceClass || fadeDoubt;

  // ---- keying that is only a threshold split of a noise envelope
  //
  // The structural test above — two mark classes a factor of three apart and
  // several standard deviations clear of each other — is what keeps white
  // Gaussian noise from being read, and on white it works: 0 answers in 150
  // seeds. Coloured noise is a different question, because two of these
  // colours have in time exactly the structure that test looks for. Noise gated
  // on and off at 6 Hz has run lengths by construction; noise under a Rayleigh
  // envelope has a level that moves like a fade. Measured with every other gate
  // in place, over 150 seeds per colour at 3 s and at 6 s — 1,500 spans: those
  // two produced 27 confident decodes between them, 25 gated and 2 faded, and
  // came back as "T T CME AE", "TETNATA", "RO K", "TNMTNTTN TT ME". White, pink
  // and impulsive produced none.
  //
  // What every one of them has in common is not the scatter of the fitted
  // classes. A 40%-jitter hand fist has scatter of 0.20 in log units and reads
  // its message exactly, against 0.08-0.27 for the noise seeds that were read,
  // so refusing on looseness costs 48 of 373 correct decodes and is not a gate.
  // What they have in common is the contrast: the mean power inside the runs
  // called key-down against the mean power inside the runs called key-up. For
  // real keying that is the decision signal-to-noise ratio. For a threshold
  // dropped into a noise envelope it is a property of the envelope's own
  // distribution and nothing else — the same fact `fadeTrack` above rests on,
  // that a Rayleigh envelope shows about 10 dB between its own upper and lower
  // deciles whether there is keying under it or not. So a split that shows
  // roughly that much has measured the distribution, not a transmission.
  //
  // Measured: over 373 spans that decoded exactly — three messages x 12/20/30
  // wpm x +20 dB down to -8 dB carrier to noise in 4 kHz x 2 seeds x 0, 20% and
  // 40% element jitter, plus short spans — the contrast ran 10.9 dB at worst
  // with a median of 14.9 and a fifth percentile of 12.3. Over the 27 noise
  // seeds that survived every other gate it ran 11.4 dB at best. The bar sits
  // between them: it refuses all 27 and costs 4 of the 373, which are 40%-
  // jittered fists at -4 dB and below.
  const impliedWpm = wpmFor(timing.ditSec);
  const speedImplausible = timingPlausible && Number.isFinite(impliedWpm)
    && (impliedWpm < minWpm || impliedWpm > maxWpm);
  if (speedImplausible) {
    warnings.push(`the fitted unit implies ${impliedWpm.toFixed(1)} words per minute, which is outside `
      + `the ${minWpm} to ${maxWpm} anything sends at, so the runs being measured are not elements`);
  }
  const atTheNoiseSplit = timingPlausible && Number.isFinite(keyingSnrDb) && keyingSnrDb < minKeyingSnrDb;
  if (atTheNoiseSplit) {
    warnings.push(`the runs called key-down hold only ${keyingSnrDb.toFixed(1)} dB more power than the runs called `
      + 'key-up, which is about what a threshold dropped into a noise envelope gives on its own');
  }

  const wpmChar = wpmFor(timing.ditSec);
  const elapsed = chars.length ? (chars[chars.length - 1].endSec - chars[0].startSec) : 0;
  const wpmOverall = elapsed > 0 ? 1.2 * unitsOf(chars) / elapsed : NaN;

  return {
    ok: timingPlausible && !tooManyUncertain && !elementsLost && !atTheNoiseSplit,
    reason: !timingPlausible
      ? `fitted timing is not Morse-shaped: ${shape.bad.join(', ')}`
      : (tooManyUncertain
        ? `${(boundaryDoubt * 100).toFixed(0)}% of the characters sit against a gap of no fitted class, `
          + 'so elements are missing from this span'
        : (mixedSpaceClass
          ? `the longest space class scatters ${spaceExcessSd.toFixed(3)} more than the class below it, `
            + 'so it is holding both word gaps and gaps left where a character was lost'
          : (fadeDoubt
            ? `the key-down level swings ${fadeDepth.toFixed(0)} dB and what was read out of it averages `
              + `${meanConfidence.toFixed(2)} confidence, so elements went under the noise in the nulls`
            : (atTheNoiseSplit
              ? `the runs called key-down hold only ${keyingSnrDb.toFixed(1)} dB more power than the runs called `
                + 'key-up, which is a threshold split of a noise envelope rather than keying'
              : undefined)))),
    timingPlausible,
    boundaryDoubt,
    spaceExcessSd,
    mixedSpaceClass,
    fadeDoubt,
    atTheNoiseSplit,
    tone: { hz: tone.hz, snrDb: tone.snrDb, analysisBinHz: tone.binHz },
    filterHz: narrow.bandwidthHz,
    filterReason: `${(narrow.bandwidthHz * timing.ditSec).toFixed(1)} / (unit ${(timing.ditSec * 1000).toFixed(0)} ms), the tightest-fitting of ${sweep.length} bandwidths tried`,
    filterSweep: sweep,
    runScatter: +fit.scatter.toFixed(4),
    envRate: narrow.envRate,
    keyingSnrDb,
    keyingSeparationDb: key.medianSeparationDb,
    deadFraction: key.deadFraction,
    wpm: wpmChar,
    wpmChar,
    wpmOverall,
    // 95% intervals, widened wherever the split-half test says the fit's own
    // error bar is too small to be true. `splitHalf` carries both numbers so a
    // reader can see which one is being reported.
    ditMsCi,
    wpmCi: [1.2 / (ditMsCi[1] / 1000), 1.2 / (ditMsCi[0] / 1000)],
    dahDitRatioCi: sigmaRatio === null ? null : ci(timing.dahDitRatio, sigmaRatio),
    splitHalf,
    agc: fit.agc === true,
    agcCompare: fit.agcCompare || null,
    fadeDepthDb: fit.fade ? fit.fade.depthDb : null,
    farnsworth: Number.isFinite(wpmOverall) && wpmOverall < wpmChar * 0.85,
    ditMs: timing.ditSec * 1000,
    dahMs: timing.dahSec === null ? null : timing.dahSec * 1000,
    dahDitRatio: timing.dahDitRatio,
    markScatter: timing.marks.map((g) => ({ ms: g.centre * 1000, n: g.count, logSd: g.logSd })),
    spacing: {
      classes: timing.spaces.map((g) => ({ ms: g.centre * 1000, n: g.count, units: g.centre / timing.ditSec, logSd: g.logSd })),
      ratios: timing.spaceRatios,
    },
    text,
    marked,
    chars,
    meanConfidence,
    knownFraction: chars.length ? known / chars.length : 0,
    elements: runs.length,
    warnings,
  };
}

// ------------------------------------------------------------------- generator

/**
 * Render Morse to audio. Present so a decoder can be tested against a message
 * whose every element is known by construction, and so the bench can key a
 * known signal for calibration. `riseMs` shapes the edges — a hard-keyed
 * carrier has sidebands out to the sample rate and is not what a transmitter
 * puts on the air.
 */
export function renderCw(text, {
  wpm = 20, sampleRate = 8000, toneHz = 700, riseMs = 5, amplitude = 0.5,
  farnsworthWpm = null, leadSec = 0.3, tailSec = 0.3, snrDb = null, ditJitter = 0,
  dahUnits = 3, seed = 1, gapJitter = 0,
} = {}) {
  const unit = ditSecondsFor(wpm);
  let rng = seed >>> 0;
  const rand = () => { rng = (rng * 1664525 + 1013904223) >>> 0; return rng / 4294967296; };

  const segs = [];
  let units = 0, gapWeight = 0;
  const up = String(text).toUpperCase();
  for (let i = 0; i < up.length; i++) {
    const ch = up[i];
    if (ch === ' ') {
      const j = gapJitter ? 1 + (rand() * 2 - 1) * gapJitter : 1;
      segs.push({ on: false, sec: 7 * unit * j, gap: 7 }); units += 7; gapWeight += 7; continue;
    }
    const pat = charToMorse(ch);
    if (!pat) continue;
    for (let e = 0; e < pat.length; e++) {
      const jitter = ditJitter ? 1 + (rand() * 2 - 1) * ditJitter : 1;
      const u = pat[e] === '-' ? dahUnits : 1;
      segs.push({ on: true, sec: u * unit * jitter });
      units += u;
      if (e < pat.length - 1) {
        segs.push({ on: false, sec: unit * (ditJitter ? 1 + (rand() * 2 - 1) * ditJitter : 1) });
        units += 1;
      }
    }
    const next = up[i + 1];
    // `gapJitter` wobbles the character and word gaps the way a hand does.
    // `ditJitter` only ever moved the elements and the gaps INSIDE a character,
    // so a sender whose spacing is sloppy but whose elements are not could not
    // be rendered at all, and the cost of any gate that reads the scatter of
    // the fitted space classes could not be measured. It can now.
    if (next !== undefined && next !== ' ') {
      const j = gapJitter ? 1 + (rand() * 2 - 1) * gapJitter : 1;
      segs.push({ on: false, sec: 3 * unit * j, gap: 3 }); units += 3; gapWeight += 3;
    }
  }
  // Farnsworth: characters keyed at `wpm`, the gaps between them stretched
  // until the whole message takes the time `farnsworthWpm` implies. The extra
  // seconds are shared between the inter-character and inter-word gaps in the
  // 3:7 proportion, which is the ARRL method, so that a decoder reading this
  // back reports `wpmChar` = wpm and `wpmOverall` = farnsworthWpm.
  if (farnsworthWpm && farnsworthWpm < wpm && gapWeight > 0) {
    const extra = units * 1.2 * (1 / farnsworthWpm - 1 / wpm);
    for (const g of segs) if (g.gap) g.sec += extra * g.gap / gapWeight;
  }
  const total = leadSec + tailSec + segs.reduce((s, g) => s + g.sec, 0);
  const n = Math.round(total * sampleRate);
  const x = new Float32Array(n);
  const rise = Math.max(2, Math.round(riseMs * sampleRate / 1000));
  let pos = Math.round(leadSec * sampleRate);
  for (const g of segs) {
    const len = Math.round(g.sec * sampleRate);
    if (g.on) {
      // The raised cosine is centred ON each boundary, not held inside the
      // element, so the half-amplitude width equals the nominal length. Keeping
      // the ramps inside instead shortens every element by exactly `riseMs`,
      // which a decoder correctly reads back as a speed that is too high — 5 ms
      // of ramp on a 30 ms dit is 40 wpm measured as 50.
      const h = rise >> 1;
      for (let i = -h; i < len + h; i++) {
        const t = pos + i;
        if (t < 0 || t >= n) continue;
        let a = 1;
        if (i < h) a = 0.5 * (1 - Math.cos(Math.PI * (i + h) / rise));
        else if (i >= len - h) a = 0.5 * (1 - Math.cos(Math.PI * (len + h - i) / rise));
        x[t] += amplitude * a * Math.cos(2 * Math.PI * toneHz * t / sampleRate);
      }
    }
    pos += len;
  }
  if (snrDb !== null) {
    // Noise power set against the mean power of the keyed carrier while it is
    // on (amplitude^2/2), so `snrDb` is carrier-to-noise in the full audio
    // bandwidth of the rendered file, which is what a receiver would show.
    const sigP = amplitude * amplitude / 2;
    const sd = Math.sqrt(sigP / Math.pow(10, snrDb / 10));
    for (let i = 0; i < n; i++) {
      // Box-Muller from the same generator, so a rendered case is reproducible.
      const u = Math.max(1e-12, rand()), v = rand();
      x[i] += sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
  }
  return { samples: x, sampleRate, toneHz, wpm, unitSec: unit, seconds: total };
}
