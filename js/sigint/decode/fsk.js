// Non-coherent FSK front end: find the tones, find the symbol rate, find the
// symbol phase, then hand out one soft decision per symbol with a number
// attached to it saying how much to trust it.
//
// Everything here measures a broadcast that any receiver hears — numbers
// stations, HF nets, beacons. Nothing is decrypted; a decoded ITA2 character
// is the same character the transmitter put on the air in the clear.
//
// The front end is N-tone from the start rather than 2-tone with an N-tone
// patch bolted on, because the polytone material this bench exists for (XPA,
// XPA2 and their relatives) is 6- or 8-ary MFSK, and a 2-FSK mode is just the
// N = 2 case of the same Goertzel bank.

import {
  analytic, guardFor, instantaneousAmp, instantaneousFreq, goertzel,
} from '../../dsp/analytic.js';
import { FFT, hann, nextPow2 } from '../../fft.js';

/** Default audio passband to hunt tones in. Below 200 Hz is receiver rumble
 *  and above 3500 Hz is past the IF filter on any HF set. */
export const DEFAULT_LOW_HZ = 200;
export const DEFAULT_HIGH_HZ = 3500;

/** Most per-arm AGC correction allowed, as a POWER ratio: 20 dB. The evidence
 *  for this number is in the table beside the clamp in `toneTrace`. */
export const AGC_CLAMP_DB = 20;
const AGC_CLAMP = Math.pow(10, AGC_CLAMP_DB / 10);

/** How likely the arm separation has to be under noise before `fskDemod` will
 *  call a region empty. One test, so the bar is the single-test one: 1e-9 is
 *  about z = 6. Measured over 24 noise seeds the largest |z| reached was 1.3. */
const MAX_ABSENCE_P = 1e-9;

// ---------------------------------------------------------------------------
// Tone estimation
// ---------------------------------------------------------------------------

function median(values) {
  if (!values.length) return 0;
  const a = Float64Array.from(values).sort();
  const h = a.length >> 1;
  return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const a = Float64Array.from(values).sort();
  const idx = Math.min(a.length - 1, Math.max(0, (a.length - 1) * p));
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

/**
 * Average power spectrum by Welch, used as the second opinion on where the
 * tones are. Returns {mag, binHz, size} with `mag` in linear power.
 */
export function powerSpectrum(x, sampleRate, { size = 0, overlap = 0.5 } = {}) {
  const n = x.length;
  let fftSize = size || nextPow2(Math.min(8192, Math.max(1024, n >> 3)));
  if (fftSize > n) fftSize = nextPow2(n) > n ? nextPow2(n) / 2 : nextPow2(n);
  fftSize = Math.max(256, fftSize);
  if (fftSize > n) return { mag: new Float64Array(0), binHz: 0, size: 0, frames: 0 };
  const hop = Math.max(1, Math.round(fftSize * (1 - overlap)));
  const frames = Math.floor((n - fftSize) / hop) + 1;
  const fft = new FFT(fftSize, { precision: 'f64' });
  const win = hann(fftSize);
  // Coherent gain of the window, so a unit tone on a bin centre reads 1.0 in
  // amplitude and 0.25 in the two-sided power convention analytic.js uses.
  let wsum = 0;
  for (let i = 0; i < fftSize; i++) wsum += win[i];
  const half = fftSize >> 1;
  const mag = new Float64Array(half);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let f = 0; f < frames; f++) {
    const at = f * hop;
    for (let i = 0; i < fftSize; i++) re[i] = x[at + i] * win[i];
    im.fill(0);
    fft.forward(re, im);
    for (let k = 0; k < half; k++) mag[k] += (re[k] * re[k] + im[k] * im[k]) / (wsum * wsum);
  }
  for (let k = 0; k < half; k++) mag[k] /= frames;
  return { mag, binHz: sampleRate / fftSize, size: fftSize, frames };
}

function pickPeaks(values, { minRel, minCount, floorRatio }) {
  const n = values.length;
  let peak = 0;
  for (let i = 0; i < n; i++) if (values[i] > peak) peak = values[i];
  if (peak <= 0) return [];
  // Background from the upper quartile of ALL bins, not the median of the
  // occupied ones: a clean carrier occupies a single bin, and taking the
  // median of what is occupied would then set the background equal to the peak
  // and reject it. A smeared histogram fills its quartiles and the background
  // rises with it, which is the case this guard is actually for.
  const floor = percentile(values, 0.75);
  const cut = Math.max(peak * minRel, floor * floorRatio);
  const found = [];
  for (let i = 1; i < n - 1; i++) {
    if (values[i] < cut) continue;
    if (values[i] < values[i - 1] || values[i] < values[i + 1]) continue;
    if (values[i] === values[i + 1] && values[i] === values[i - 1]) continue;
    // Centroid over the peak's own shoulders, which locates a mode that sits
    // between two bins far better than the bin index does.
    let num = 0, den = 0;
    for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) {
      const w = Math.max(0, values[k] - floor);
      num += k * w; den += w;
    }
    found.push({ index: den > 0 ? num / den : i, height: values[i] });
  }
  found.sort((a, b) => b.height - a.height);
  // Merge peaks that landed on the same mode from both shoulders.
  const kept = [];
  for (const p of found) {
    if (kept.some((q) => Math.abs(q.index - p.index) < 2)) continue;
    kept.push(p);
    if (kept.length >= minCount) break;
  }
  kept.sort((a, b) => a.index - b.index);
  return kept;
}

/**
 * Fit an equally spaced grid to a set of tones.
 *
 * The spacing is found the same way the symbol rate is: lines on a grid of d
 * concentrate mod d, so |mean(exp(i2*pi*f/d))| peaks there. That beats taking
 * the smallest observed gap as the step, which is what an earlier version did
 * and which one mismeasured line or one modulation sideband is enough to
 * destroy. Every divisor of a true spacing concentrates too, so the answer is
 * the LARGEST spacing that still gives every line its own slot.
 *
 * Returns the fitted grid, the slots it implies, and the worst line's distance
 * from it — never a spacing without that residual.
 */
export function gridFit(tones, toleranceHz) {
  if (!tones || tones.length < 2) return null;
  const f = Float64Array.from(tones).sort();
  const span = f[f.length - 1] - f[0];
  const tol = Math.max(1e-6, toleranceHz);
  const dMin = Math.max(2 * tol, span / 200);
  const dMax = span * 1.02;   // two lines one spacing apart is a legitimate grid
  if (!(dMax > dMin)) return { tones, spacingHz: null, regular: false, residualHz: null, slots: tones.length };

  const score = (d) => {
    let cr = 0, ci = 0;
    for (let i = 0; i < f.length; i++) {
      const a = 2 * Math.PI * f[i] / d;
      cr += Math.cos(a); ci += Math.sin(a);
    }
    return Math.hypot(cr, ci) / f.length;
  };
  const du = 1 / (4 * span);
  const cands = [];
  for (let u = 1 / dMax; u <= 1 / dMin; u += du) cands.push({ d: 1 / u, r: score(1 / u) });
  if (!cands.length) return { tones, spacingHz: null, regular: false, residualHz: null, slots: tones.length };
  let best = cands[0];
  for (const c of cands) if (c.r > best.r) best = c;

  const evaluate = (d0) => {
    // Local refinement, then the residual and the slot assignment.
    let bd = d0, br = score(d0);
    for (let u = 1 / d0 - du; u <= 1 / d0 + du; u += du / 40) {
      const r = score(1 / u);
      if (r > br) { br = r; bd = 1 / u; }
    }
    const slotsUsed = new Set();
    let residual = 0, collision = false;
    for (let i = 0; i < f.length; i++) {
      const k = Math.round((f[i] - f[0]) / bd);
      if (slotsUsed.has(k)) collision = true;
      slotsUsed.add(k);
      residual = Math.max(residual, Math.abs(f[i] - f[0] - k * bd));
    }
    const maxSlot = Math.max(...slotsUsed);
    return { d: bd, r: br, residual, collision, slots: maxSlot + 1 };
  };

  const near = cands.filter((c) => c.r >= best.r * 0.9).sort((a, b) => b.d - a.d);
  let fit = null;
  for (const c of near) {
    const e = evaluate(c.d);
    if (e.collision) continue;
    if (e.residual > Math.max(tol, e.d * 0.06)) continue;
    fit = e;
    break;
  }
  if (!fit) {
    const e = evaluate(best.d);
    return { tones, spacingHz: e.d, regular: false, residualHz: e.residual, slots: tones.length };
  }
  return {
    tones, spacingHz: fit.d, regular: true, residualHz: fit.residual, slots: fit.slots,
  };
}

/**
 * Where are the tones? Two independent estimates, and their disagreement is
 * reported rather than hidden.
 *
 * Method A, the instantaneous-frequency histogram: an MFSK signal sits on one
 * frequency at a time, so the histogram of instantaneous frequency has a sharp
 * mode per tone. Samples are gated on envelope (a fade contributes noise, not
 * frequency) and on steadiness (the sweep through a transition otherwise
 * smears a floor between the modes).
 *
 * Method B, the averaged power spectrum: robust to a signal that never settles,
 * but it cannot tell a set of MFSK tones from a set of simultaneous carriers.
 *
 * Returns tones from A when A works, with `agreementHz` saying how far B was.
 *
 * `settleHz` is how far the frequency may wander inside the smoothing window
 * and still count as settled. It is an absolute width on purpose: tying it to
 * the histogram bin would mean that asking for finer bins silently rejected
 * most of a real signal, which fades and drifts whatever resolution is asked
 * for.
 */
export function estimateTones(x, sampleRate, {
  lowHz = DEFAULT_LOW_HZ, highHz = DEFAULT_HIGH_HZ,
  binHz = 4, maxTones = 16, minRel = 0.06, floorRatio = 6,
  envelopeGate = 0.35, steady = true, settleHz = 25, minToneGapHz = 10,
} = {}) {
  const warnings = [];
  if (!x || x.length < 1024) {
    return { ok: false, tones: [], reason: 'region too short to estimate tones', warnings };
  }
  const g = guardFor();
  if (x.length <= 4 * g) {
    return { ok: false, tones: [], reason: 'region shorter than the Hilbert filter fill', warnings };
  }
  const { re, im } = analytic(x);
  const amp = instantaneousAmp(re, im);
  const freq = instantaneousFreq(re, im, sampleRate);

  // Smooth over half a millisecond before histogramming. Instantaneous
  // frequency of a noisy tone rattles sample to sample even while the tone is
  // perfectly steady; the average over a short window is the tone, and the
  // spread within that window is the evidence that it was steady.
  const span = Math.max(2, Math.round(sampleRate / 2000));
  const from = g, to = x.length - g;
  const ampRef = percentile(amp.slice(from, to), 0.6);
  const gate = ampRef * envelopeGate;

  const bins = Math.max(4, Math.ceil((highHz - lowHz) / binHz));
  const hist = new Float64Array(bins);
  let settled = 0, considered = 0;
  for (let i = from; i + span < to; i++) {
    if (amp[i] < gate) continue;
    considered++;
    let sum = 0, lo = Infinity, hi = -Infinity;
    for (let k = 0; k < span; k++) {
      const v = freq[i + k];
      sum += v; if (v < lo) lo = v; if (v > hi) hi = v;
    }
    const mean = sum / span;
    if (steady && hi - lo > settleHz) continue;
    if (mean < lowHz || mean >= highHz) continue;
    settled++;
    const b = Math.floor((mean - lowHz) / binHz);
    // Weight by power: a loud settled sample is more evidence than a quiet one.
    hist[b] += amp[i] * amp[i];
  }

  const settledFraction = considered ? settled / considered : 0;
  if (settled < 200) {
    return {
      ok: false, tones: [], settledFraction, warnings,
      reason: 'no steady frequency anywhere in the region — this is noise, speech, or a signal that never holds a tone',
    };
  }

  const peaks = pickPeaks(hist, { minRel, minCount: maxTones, floorRatio });
  const tones = peaks.map((p) => lowHz + (p.index + 0.5) * binHz);
  const weights = peaks.map((p) => p.height);

  // Method B, for the cross-check.
  const spec = powerSpectrum(x, sampleRate);
  let tonesSpectral = [];
  if (spec.size) {
    const kLow = Math.floor(lowHz / spec.binHz), kHigh = Math.ceil(highHz / spec.binHz);
    const band = spec.mag.slice(kLow, Math.min(spec.mag.length, kHigh));
    const sp = pickPeaks(band, { minRel: 0.02, minCount: maxTones, floorRatio: 4 });
    tonesSpectral = sp.map((p) => (kLow + p.index) * spec.binHz);
  }
  let agreementHz = null;
  if (tones.length && tonesSpectral.length) {
    agreementHz = 0;
    for (const t of tones) {
      let best = Infinity;
      for (const s of tonesSpectral) best = Math.min(best, Math.abs(s - t));
      if (best > agreementHz) agreementHz = best;
    }
    if (agreementHz > Math.max(3 * binHz, 2 * spec.binHz)) {
      warnings.push(`the frequency histogram and the power spectrum disagree by up to ${agreementHz.toFixed(1)} Hz; treat the tone set as provisional`);
    }
  }

  if (tones.length < 2 && tonesSpectral.length >= 3) {
    // The histogram needs the signal to HOLD a tone. On the XPA body — 10 baud
    // symbols on a 40 Hz grid, fading, through an mp3 — only 8 to 16% of
    // samples settle and no mode clears the background. The averaged spectrum
    // still shows the comb, so it is used, and the result says so: a comb in
    // an average spectrum cannot tell a sequence of tones from a set of
    // simultaneous carriers, which is the one thing the histogram could.
    const strong = spec.size ? (() => {
      const kLow = Math.floor(lowHz / spec.binHz), kHigh = Math.ceil(highHz / spec.binHz);
      const band = spec.mag.slice(kLow, Math.min(spec.mag.length, kHigh));
      const found = pickPeaks(band, { minRel: 0.05, minCount: maxTones * 2, floorRatio: 3 })
        .map((pk) => ({ hz: (kLow + pk.index) * spec.binHz, h: pk.height }))
        .sort((a, b) => a.hz - b.hz);
      // Two MFSK tones cannot be closer than the symbol rate, so lines within
      // `minToneGapHz` of each other are one tone's modulation sidebands, not
      // two tones. Keep the strongest of each cluster; its position is the one
      // the carrier is actually at.
      const merged = [];
      for (const pk of found) {
        const last = merged[merged.length - 1];
        if (last && pk.hz - last.hz < minToneGapHz) {
          if (pk.h > last.h) merged[merged.length - 1] = pk;
          continue;
        }
        merged.push(pk);
      }
      return merged;
    })() : [];
    const fit = gridFit(strong.map((pk) => pk.hz), Math.max(binHz, 2 * (spec.binHz || 1)));
    if (fit && fit.tones.length >= 3) {
      warnings.push('tones came from the averaged spectrum, not from the instantaneous frequency: nothing in this region holds a steady tone long enough to histogram, so these lines may be simultaneous carriers rather than an FSK alphabet');
      return {
        ok: true, method: 'spectrum', tones: fit.tones,
        // Line heights, so a caller picking "the two strongest" gets the two
        // strongest and not the two lowest.
        weights: fit.tones.map((hz) => {
          const near = strong.reduce((a, b) => (Math.abs(b.hz - hz) < Math.abs(a.hz - hz) ? b : a), strong[0]);
          return near.h;
        }),
        tonesSpectral, agreementHz: null,
        spacingHz: fit.spacingHz, regular: fit.regular, gridResidualHz: fit.residualHz,
        gridSlots: fit.slots, settledFraction, binHz,
        histogram: hist, histLowHz: lowHz, warnings, reason: null,
      };
    }
  }

  if (tones.length < 2) {
    return {
      ok: false, tones, tonesSpectral, agreementHz, settledFraction, warnings,
      histogram: hist, histLowHz: lowHz, binHz,
      reason: tones.length === 1
        ? `only one steady frequency (${tones[0].toFixed(1)} Hz) — a carrier or a tone, not FSK`
        : 'no steady frequency found',
    };
  }

  const fitted = gridFit(tones, binHz) || {};
  const gridHz = fitted.spacingHz || 0;
  const gridResidualHz = fitted.residualHz || 0;
  const regular = !!fitted.regular;
  const slots = regular ? fitted.slots : tones.length;
  const missing = regular ? slots - tones.length : 0;
  if (missing > 0) {
    warnings.push(`${missing} of ${slots} grid slots carried no symbol in this region; the alphabet is wider than the tones listed`);
  }

  return {
    ok: true,
    method: 'histogram',
    tones,
    weights,
    tonesSpectral,
    agreementHz,
    spacingHz: regular ? gridHz : null,
    regular,
    gridResidualHz: regular ? gridResidualHz : null,
    gridSlots: regular ? slots : null,
    settledFraction,
    binHz,
    histogram: hist,
    histLowHz: lowHz,
    warnings,
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// The Goertzel bank
// ---------------------------------------------------------------------------

/**
 * The highest per-arm SNR a bank of these tones with this window can report.
 *
 * A Goertzel over N samples is a rectangular window, so a unit tone at f0 still
 * reads (sin(pi*N*df/fs) / (N*sin(pi*df/fs)))^2 of its power in an arm df away.
 * That leakage is indistinguishable from noise in that arm, so it sets a floor
 * under the apparent noise and a ceiling over the apparent SNR.
 */
export function leakageCeilingDb(tones, sampleRate, win) {
  let worst = 0;
  for (let j = 0; j < tones.length; j++) {
    for (let k = 0; k < tones.length; k++) {
      if (j === k) continue;
      const df = Math.abs(tones[j] - tones[k]);
      const a = Math.PI * win * df / sampleRate;
      const b = Math.PI * df / sampleRate;
      const d = Math.abs(Math.sin(b)) < 1e-12 ? 1 : Math.sin(a) / (win * Math.sin(b));
      if (d * d > worst) worst = d * d;
    }
  }
  return worst > 0 ? -10 * Math.log10(worst) : Infinity;
}

/**
 * One Goertzel per tone over a sliding window of exactly one symbol, stepped
 * `oversample` times per symbol.
 *
 * Per-arm AGC: each arm is scaled so that its level WHEN IT WINS matches the
 * other arms'. A receiver's audio filter is not flat across a 1 kHz tone
 * spread and HF fading is frequency-selective, so without this an arm sitting
 * a few dB low loses decisions it should win. Normalising on the winning level
 * rather than the mean level is what keeps the correction independent of how
 * often each tone is actually used.
 *
 * Time of step s is the CENTRE of its window, which is the instant its
 * decision refers to.
 */
export function toneTrace(x, sampleRate, {
  tones, baud, oversample = 8, start = 0, length = 0, agc = true,
} = {}) {
  const warnings = [];
  if (!tones || tones.length < 2) throw new Error('toneTrace needs at least two tone frequencies');
  if (!(baud > 0)) throw new Error('toneTrace needs a positive baud');
  const n = length || (x.length - start);
  const win = Math.max(4, Math.round(sampleRate / baud));
  const step = Math.max(1, Math.round(win / oversample));
  const steps = Math.floor((n - win) / step) + 1;
  if (steps < 4) {
    return { steps: 0, warnings: ['region shorter than four symbol windows'], tones, baud, win, step };
  }
  const T = tones.length;
  const raw = new Float64Array(steps * T);
  for (let s = 0; s < steps; s++) {
    const at = start + s * step;
    for (let j = 0; j < T; j++) raw[s * T + j] = goertzel(x, sampleRate, tones[j], { start: at, length: win });
  }

  // Pass one: learn each arm's FULL-WINDOW level.
  //
  // Calibrating on every winning step is wrong, and the way it is wrong is not
  // small. A Goertzel window is one symbol wide, so an arm only ever reads its
  // true level when the window lies entirely inside one of its own runs. An arm
  // whose runs are a single symbol long reaches that for one step out of
  // `oversample` and reads low everywhere else, so its median winning level
  // sits well under the others' through no fault of the channel. Measured on a
  // 1500/1700 pair at 50 baud carrying the repeating pattern 0111 — both tones
  // at identical amplitude — the old rule handed the short-run arm a gain of
  // 1.389 and the long-run arm 0.781, a 5.0 dB tilt invented out of the
  // modulation. That moved every arm crossing by 0.093 symbol in the direction
  // that lengthens the short run, and `estimateBaud` then locked to 337.5 baud
  // against a true 50. With the level read from interior steps only, the gains
  // come back 1.000/1.000 and the rate reads 50.000.
  const gains = new Float64Array(T).fill(1);
  if (agc) {
    const rawWinner = new Int16Array(steps);
    for (let s = 0; s < steps; s++) {
      let best = -1, bi = 0;
      for (let j = 0; j < T; j++) { const v = raw[s * T + j]; if (v > best) { best = v; bi = j; } }
      rawWinner[s] = bi;
    }
    // Interior: the whole window sits inside one run, so no other tone is in it.
    const half = Math.ceil(oversample / 2);
    const wins = Array.from({ length: T }, () => []);
    // `held` is "did this arm ever take the lead", counted over every step, and
    // is what separates a dead arm from one that is merely never interior. On a
    // region shorter than two windows the interior loop cannot run at all, and
    // counting held inside it would report every arm as dead.
    const held = new Int32Array(T);
    for (let s = 0; s < steps; s++) held[rawWinner[s]]++;
    for (let s = half; s < steps - half; s++) {
      const bi = rawWinner[s];
      let interior = true;
      for (let k = s - half; k <= s + half; k++) if (rawWinner[k] !== bi) { interior = false; break; }
      if (interior) wins[bi].push(raw[s * T + bi]);
    }
    const levels = wins.map((w) => (w.length ? median(w) : 0));
    const ref = median(levels.filter((v) => v > 0));
    // An arm has to hold the lead for a full window often enough for its level
    // to mean anything. Measured on the XPA body: a grid slot used for 1.8% of
    // symbols produced a median winning level at the noise, and the uncorrected
    // rule handed it a gain of 81 — after which it won decisions it had no
    // business winning.
    const minWins = Math.max(8, Math.round(steps * 0.01));
    for (let j = 0; j < T; j++) {
      if (!held[j]) {
        warnings.push(`tone ${tones[j].toFixed(1)} Hz never won a step; its gain is left at 1 and it may be an unused slot or a dead arm`);
        continue;
      }
      if (wins[j].length < minWins) {
        warnings.push(`tone ${tones[j].toFixed(1)} Hz held the lead for a full symbol window on only ${wins[j].length} of ${steps} steps, too few to calibrate its level; its gain is left at 1`);
        continue;
      }
      if (levels[j] > 0 && ref > 0) {
        const g = ref / levels[j];
        // These are POWER ratios — a Goertzel returns power — so the clamp and
        // the warning are both in power dB. An earlier version clamped at a
        // factor of 10 while calling it "+/- 20 dB", which is a +/- 10 dB power
        // clamp: half the stated range.
        //
        // AGC_CLAMP_DB is where the evidence puts it. Measured on four tones at
        // 50 baud, arm 3 attenuated, 20 dB of broadband noise, against a true
        // arm-3 share of 25.0% of steps (share of steps that arm wins):
        //   attenuation   wanted    +/-10 dB    +/-20 dB    unclamped
        //     10 dB       10.0 dB    27.2%       27.2%       27.2%
        //     20 dB       20.0 dB    16.6%       32.5%       32.5%
        //     26 dB       26.0 dB    14.1%       27.9%       43.0%
        //     30 dB       29.9 dB    12.7%       24.5%       49.8%
        // Unclamped, an arm 30 dB down takes half of every decision. Clamped at
        // 10 dB the correction is cut off below a tilt a receiver really can
        // produce and the arm loses steps it should win. 20 dB of power
        // correction is the setting that tracks the truth across the range.
        gains[j] = Math.min(AGC_CLAMP, Math.max(1 / AGC_CLAMP, g));
        if (g !== gains[j]) warnings.push(`tone ${tones[j].toFixed(1)} Hz wanted ${(10 * Math.log10(g)).toFixed(0)} dB of gain correction and was clamped to ${(10 * Math.log10(gains[j])).toFixed(0)} dB`);
      }
    }
  }

  const power = new Float64Array(steps * T);
  const norm = new Float64Array(steps * T);
  const winner = new Int16Array(steps);
  const margin = new Float32Array(steps);
  const snrs = [];
  for (let s = 0; s < steps; s++) {
    let sum = 0, best = -1, second = -1, bi = 0;
    for (let j = 0; j < T; j++) {
      const v = raw[s * T + j] * gains[j];
      power[s * T + j] = v;
      sum += v;
      if (v > best) { second = best; best = v; bi = j; }
      else if (v > second) second = v;
    }
    winner[s] = bi;
    margin[s] = best + second > 0 ? (best - second) / (best + second) : 0;
    if (sum > 0) for (let j = 0; j < T; j++) norm[s * T + j] = power[s * T + j] / sum;
    const losers = (sum - best) / (T - 1);
    if (losers > 0) snrs.push(best / losers);
  }
  // Per-arm SNR: the winning tone's power over the mean of the losing tones',
  // both read through the same symbol-rate-wide Goertzel. This is NOT the
  // operator's 3 kHz SNR; it is higher by 10*log10(3000/baud) when the noise
  // is white, which is 18.2 dB at 45.45 baud.
  const armSnrDb = snrs.length ? 10 * Math.log10(Math.max(1e-12, median(snrs) - 1)) : null;
  // ...and how well that median is pinned. A median's standard error is
  // 1.2533 * sd / sqrt(n), and for a distribution this skewed the sd is read
  // from the interquartile range (IQR / 1.349) after the dB transform, which is
  // where the skew mostly goes away. n is the number of INDEPENDENT windows,
  // steps / oversample, not the number of steps: consecutive windows overlap by
  // all but one step and are not separate evidence.
  const toDb = (r) => 10 * Math.log10(Math.max(1e-12, r - 1));
  let armSnrSeDb = null, armSnrSplitHalf = null;
  if (snrs.length >= 8) {
    const iqrDb = toDb(percentile(snrs, 0.75)) - toDb(percentile(snrs, 0.25));
    const nEff = Math.max(1, snrs.length / Math.max(1, oversample));
    armSnrSeDb = 1.2533 * Math.abs(iqrDb / 1.349) / Math.sqrt(nEff);
    const halfAt = snrs.length >> 1;
    const a = snrs.slice(0, halfAt), b = snrs.slice(halfAt);
    if (a.length >= 4 && b.length >= 4) {
      const dbA = toDb(median(a)), dbB = toDb(median(b));
      armSnrSplitHalf = {
        firstDb: dbA, secondDb: dbB, differenceDb: Math.abs(dbA - dbB),
        // Each half's own error is sqrt(2) times the whole's, so two
        // independent halves differ by about 2 * se. Two of those is the bar.
        agrees: Math.abs(dbA - dbB) <= 4 * Math.max(armSnrSeDb, 1e-9),
      };
      // A bar the halves walk straight through is not a bar.
      if (!armSnrSplitHalf.agrees) {
        armSnrSeDb = Math.abs(dbA - dbB) / 2;
        warnings.push(`the two halves of this region read ${dbA.toFixed(1)} and ${dbB.toFixed(1)} dB per-arm SNR, further apart than the quartile-based error bar allowed; the bar has been widened to +/-${armSnrSeDb.toFixed(1)} dB`);
      }
    }
  }
  // ...and it cannot read higher than the leakage of the WINNING tone into the
  // losing arms, because the Goertzel window is rectangular and its skirt does
  // not stop at the next tone. Measured on a synthetic 2125/2295 pair at 45.45
  // baud in 8 kHz: the estimate saturates near 22 dB however clean the signal
  // is, which is the -24.1 dB Dirichlet sidelobe at that tone spacing and
  // window length showing through. Reported so a caller never reads the
  // ceiling as a measurement of the signal.
  const ceiling = leakageCeilingDb(tones, sampleRate, win);
  if (armSnrDb != null && armSnrDb > ceiling - 3) {
    warnings.push(`per-arm SNR ${armSnrDb.toFixed(1)} dB is within 3 dB of this bank's ${ceiling.toFixed(1)} dB leakage ceiling; the true SNR is at least this and is not measurable from the tone arms alone`);
  }

  return {
    steps, tones, baud, win, step, start, oversample,
    stepSec: step / sampleRate,
    sampleRate,
    raw, power, norm, winner, margin, gains,
    armSnrDb, armSnrSeDb, armSnrSplitHalf,
    armSnrCeilingDb: ceiling,
    referenceNoiseBwHz: baud,
    timeAt: (s) => (start + s * step + win / 2) / sampleRate,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Is there anything there at all?
// ---------------------------------------------------------------------------

/**
 * What a bank of T arms reads when it is fed nothing but noise.
 *
 * A Goertzel over white noise returns a power that is exponentially
 * distributed, so the T arm powers are iid Exp(1) and the normalised vector is
 * Dirichlet(1,...,1) — uniform over the simplex. The per-step margin
 * (best - second) / (best + second) therefore has a distribution that depends
 * on T and on nothing else: no signal level, no tone spacing, no sample rate.
 *
 * For T = 2 it is exact and needs no simulation: p0/(p0+p1) is Uniform(0,1) for
 * two iid exponentials, so the margin is |2U - 1|, mean 1/2 and variance 1/12.
 * Measured against that: six 8-second regions of white noise through a
 * 2125/2295 bank at 45.45 baud read 0.485, 0.507, 0.496, 0.496, 0.485, 0.501.
 *
 * For T > 2 there is no comparable one-liner, so it is simulated once per T
 * with a fixed seed and cached. The generator is the same LCG used elsewhere in
 * this repository, so the numbers are identical in every run and in every
 * browser.
 */
/** Numerical Recipes' rational-Chebyshev erfc; relative error under 1.2e-7. */
function erfc(x) {
  const z = Math.abs(x), t = 2 / (2 + z);
  const y = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196
    + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398
    + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? y : 2 - y;
}

/** log of the upper-tail normal probability at z. The asymptotic series takes
 *  over past z = 6, where erfc has run out of relative precision. */
export function logNormalUpperTail(z) {
  if (z <= 6) return Math.log(Math.max(Number.MIN_VALUE, 0.5 * erfc(z / Math.SQRT2)));
  const c = 1 - 1 / (z * z) + 3 / (z * z * z * z);
  return -0.5 * z * z - Math.log(z) - 0.5 * Math.log(2 * Math.PI) + Math.log(c);
}

const nullMarginCache = new Map();
/**
 * The margin's null, optionally conditioned on the arms' own noise scales.
 *
 * Called with one argument this is the flat case above: T arms of iid Exp(1).
 * That is the ONLY case in which the numbers it returns are the numbers noise
 * actually produces, and the flat case is rarer than it looks — see
 * `armNoiseScales` for what breaks it and how often.
 *
 * `scales` is a vector of per-arm noise means. The margin is scale-invariant
 * under a scaling COMMON to every arm, so an envelope cancels and only the
 * ratios matter; the vector is normalised to mean 1 on the way in and the
 * cache is keyed on the rounded ratios.
 */
export function nullMargin(T, scales = null) {
  let key = `${T}`;
  let lam = null;
  if (scales && scales.length === T) {
    let m = 0;
    for (let j = 0; j < T; j++) m += scales[j];
    m = m > 0 ? m / T : 1;
    lam = new Float64Array(T);
    let flat = true;
    for (let j = 0; j < T; j++) {
      lam[j] = Math.max(1e-6, scales[j] / m);
      if (Math.abs(lam[j] - 1) > 5e-4) flat = false;
    }
    if (!flat) key = `${T}|` + Array.from(lam, (v) => v.toFixed(3)).join(',');
    else lam = null;
  }
  if (lam === null && T === 2) return { mean: 0.5, sd: Math.sqrt(1 / 12) };
  if (nullMarginCache.has(key)) return nullMarginCache.get(key);
  let seed = 20260907 >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed + 0.5) / 4294967296; };
  const draws = 40000;
  let sum = 0, sum2 = 0;
  for (let i = 0; i < draws; i++) {
    let best = -1, second = -1;
    for (let j = 0; j < T; j++) {
      const v = (lam ? lam[j] : 1) * -Math.log(rnd());   // Exp(lambda_j)
      if (v > best) { second = best; best = v; } else if (v > second) second = v;
    }
    const m = best + second > 0 ? (best - second) / (best + second) : 0;
    sum += m; sum2 += m * m;
  }
  const mean = sum / draws;
  const out = { mean, sd: Math.sqrt(Math.max(0, sum2 / draws - mean * mean)) };
  // Every distinct scale vector is its own entry and a long run would grow
  // this without bound. The flat entries are the ones worth keeping.
  if (nullMarginCache.size > 512) {
    for (const k of nullMarginCache.keys()) if (k.includes('|')) nullMarginCache.delete(k);
  }
  nullMarginCache.set(key, out);
  return out;
}

/**
 * How far a window's total power may stand above the region's median before it
 * is treated as an atmospheric crash rather than as evidence, in dB.
 *
 * A crash is a short narrowband ring, and in every instantaneous sense it looks
 * like a signal: one arm enormous, the rest at the floor, a decision margin of
 * 1.00. What separates it from a symbol is that it is over in a window or two.
 * Blanking it is what an HF receiver's noise blanker does, and it is exactly
 * free under the null: for T arms of iid exponential power the normalised
 * vector is Dirichlet and INDEPENDENT of the total, so discarding windows on
 * the strength of their total cannot shift the margin's distribution.
 *
 * Measured over 30 eight-second regions per colour through an 8-arm bank at 50
 * baud, as the window total's excursion above the region median:
 *                p99      p99.9    windows over 12 dB
 *   white        3.2 dB   4.0 dB   0.00%
 *   pink         3.7      4.7      0.00%
 *   faded        8.2      9.7      0.01%
 *   bursty       7.5      8.4      1.61%
 *   impulsive   26.5     29.7     18.67%
 * ...and on real RTTY through Rayleigh fading at no noise, 0, -6 and -12 dB:
 * p99.9 of 0.1, 2.9, 4.8 and 7.2 dB, and 0.00% over 12 dB at every one. So 12
 * dB sits above everything a signal or an ordinary channel produces and below
 * where the crashes live.
 */
export const CRASH_BLANK_DB = 12;
const CRASH_BLANK_RATIO = Math.pow(10, CRASH_BLANK_DB / 10);

/** The most an arm's quiet level may depart from the median arm's and still be
 *  read as the band's noise rather than as the bank hearing itself, in dB.
 *  The table beside its use is the evidence for 12. */
const BAND_TILT_LIMIT_DB = 12;

/**
 * What level of NOISE each arm is sitting on, so the margin's null can be the
 * one THESE arms produce rather than a flat one.
 *
 * This is the number every refusal test in this repository was missing, and
 * missing it is what let these modules answer confidently on noise that was
 * not white. The per-step margin is invariant to a scaling common to all arms
 * — a fading or gating envelope cancels exactly — but not to a scaling that
 * differs BETWEEN arms, and two ordinary things produce one.
 *
 * The first is the per-arm AGC above. Its gains are estimated from the data,
 * and on noise alone it estimates something. Measured over 60 eight-second
 * regions through a 4-arm bank at 100 baud, as the spread between its largest
 * and smallest gain: 0.8 dB on white, 0.7 on pink, 1.9 on Rayleigh-faded, 9.7
 * on impulsive, 10.1 on gated. Against the flat null a 10 dB spread carries
 * the mean margin from the 0.302 four arms of noise give to 0.512 — 27
 * flat-null standard errors of nothing at all. That is why `fskDemod`, told
 * exactly where the tones were, accepted 97 of 100 static regions and 50 of
 * 100 gated ones through that bank.
 *
 * The second is the band's own tilt. With the AGC switched off entirely, pink
 * noise through that same 1200-1800 Hz bank still reads 0.321 against 0.302:
 * the low arm simply has more noise in it than the high arm. Across the
 * 1200-2600 Hz bank the 8-ary alphabet uses — better than an octave — the tilt
 * measures 4.7 dB, and conditioning on the gains alone and ignoring it left 49
 * of 150 pink regions accepted there.
 *
 * So the scale for arm j is the gain this code APPLIED to it — exact, not
 * estimated — times the band level measured under it. Those are separated on
 * purpose, and the separation is what the raw-winner selection below is for.
 */
export function armNoiseScales(trace, { keep = null, minSamples = 0 } = {}) {
  const T = trace.tones.length;
  const out = new Float64Array(T).fill(1);
  const why = [];
  if (!trace.steps) return { scales: out, measured: [], why };
  const use = keep || Array.from({ length: trace.steps }, (_, i) => i);
  if (use.length < 8) return { scales: out, measured: [], why: ['too few windows to read an arm noise level'] };

  // Which arm led each surviving window, read BEFORE the AGC.
  //
  // Before, not after, and the difference is the whole estimator. The AGC's
  // gains are a multiplier this code applied, so the null can be conditioned on
  // them exactly; what it cannot know without measuring is the band's own tilt,
  // and that has to be read off the raw arms. Selecting the quiet windows on
  // the GAINED powers ties the two together: a boosted arm wins more, so the
  // windows in which it is quiet are a deeper selection into its own lower
  // tail, its level reads low, and the tilt the AGC introduced is estimated
  // away rather than accounted for. Measured over 150 gated-noise regions
  // through a 2-arm bank, selecting on the gained arms accepted 47 of them;
  // selecting on the raw arms and multiplying the measured tilt back by the
  // known gains accepted none.
  const winner = new Int16Array(use.length);
  for (let i = 0; i < use.length; i++) {
    let best = -1, bi = 0;
    for (let j = 0; j < T; j++) { const v = trace.raw[use[i] * T + j]; if (v > best) { best = v; bi = j; } }
    winner[i] = bi;
  }
  // ...and the band is read only where the arm is INTERIOR-losing, by the same
  // rule the AGC uses on the winning side and for the same reason. A Goertzel
  // window is one symbol wide, so an arm reads the band under it only when the
  // whole window lies inside a run belonging to somebody else.
  //
  // Reading it off the arm's lower tail instead does not work, and the way it
  // fails is not small. RTTY's space runs are a single bit long, so the mark
  // arm's window is nearly always straddling one and its low readings are the
  // mark tone leaking into itself. Measured on a two-frame '$' off a noiseless
  // recording, a plain 10th-percentile read of each arm called that 11.9 dB of
  // arm-to-arm noise tilt and took the separation from z = 8.5 to z = 3.1 — a
  // real transmission deleted by a number invented out of its own modulation.
  // The interior rule reads 0.07 dB on the same recording, because a window
  // centred inside a one-bit space run is exactly inside it: half the
  // oversample either side is half a window, which is the width that makes
  // this work at all.
  const half = Math.max(1, Math.ceil(trace.oversample / 2));
  const quiet = Array.from({ length: T }, () => []);
  for (let i = half; i < use.length - half; i++) {
    for (let j = 0; j < T; j++) {
      let clean = true;
      for (let k = i - half; k <= i + half && clean; k++) if (winner[k] === j) clean = false;
      if (clean) quiet[j].push(trace.raw[use[i] * T + j]);
    }
  }
  const need = minSamples || Math.max(8, Math.round(use.length * 0.01));
  const raw = new Float64Array(T);
  for (let j = 0; j < T; j++) {
    if (quiet[j].length >= need) raw[j] = median(quiet[j]);
    else why.push(`tone ${trace.tones[j].toFixed(1)} Hz was never clear of the decisions for a whole window (${quiet[j].length} of ${use.length}); the band's noise under it is unmeasured and its arm is conditioned on the gain it was given alone`);
  }
  // ...and a level is only the BAND's if it could be the band's. A channel does
  // not change by 12 dB between two tones a few hundred hertz apart; what does
  // is a bank reading its own skirts on a recording that has no noise in it.
  // Measured as each arm's departure from the median arm, over 60 eight-second
  // regions per colour and three bank widths, the largest any real noise
  // produced was 8.3 dB (gated noise through a 2-arm bank); a NOISELESS 4-FSK
  // stream on bin-centred tones produced 193 dB, because the arms that are not
  // transmitting read numerical dust. Taken for noise that put a perfectly
  // clean signal 31281 standard errors BELOW chance and refused it.
  const seen = Array.from(raw).filter((v) => v > 0);
  const ref = seen.length ? median(seen) : 0;
  const level = new Float64Array(T);
  let known = 0;
  for (let j = 0; j < T; j++) {
    if (!(raw[j] > 0) || !(ref > 0)) continue;
    const dev = 10 * Math.log10(raw[j] / ref);
    if (Math.abs(dev) > BAND_TILT_LIMIT_DB) {
      why.push(`tone ${trace.tones[j].toFixed(1)} Hz reads ${dev.toFixed(0)} dB from the other arms when it is quiet, which is not a band tilt but this bank hearing itself; its arm is conditioned on the gain it was given alone`);
      continue;
    }
    level[j] = raw[j]; known++;
  }
  // An arm whose floor could not be measured keeps the AGC's own gain as its
  // scale: that gain is a multiplier this code APPLIED, not an estimate, so
  // conditioning the null on it is exact even when nothing else is known.
  const base = known ? median(Array.from(level).filter((v) => v > 0)) : 0;
  for (let j = 0; j < T; j++) {
    const band = level[j] > 0 && base > 0 ? level[j] / base : 1;
    out[j] = band * trace.gains[j];
  }
  let m = 0;
  for (let j = 0; j < T; j++) m += out[j];
  m = m > 0 ? m / T : 1;
  for (let j = 0; j < T; j++) out[j] = Math.max(1e-6, out[j] / m);
  return { scales: out, measured: Array.from(level), why };
}


/**
 * How far the arm decisions stand above what noise alone would produce.
 *
 * This is the test that a signal is present at all, and it is deliberately not
 * a test on the decoded output: a decoder that judges itself by whether its own
 * text looks plausible will always find that it does. Thirty of the thirty-two
 * ITA2 codes are assigned, so noise decodes to assigned characters as often as
 * traffic does.
 *
 * The effective sample size is the number of INDEPENDENT windows, not the
 * number of steps: the trace is stepped `oversample` times per symbol and
 * consecutive windows share all but one step of their samples. Non-overlapping
 * windows of white noise are independent, so nEff = steps / oversample.
 */
/**
 * `blankCrashes` and `conditionOnArmNoise` are here so a test can run this
 * with either guard switched off and measure what it is worth; nothing in
 * normal use should pass them. Both defend a false-accept rate, and the
 * measurements are in test/cases-sigint-fsk.mjs.
 */
export function armSeparation(trace, { blankCrashes = true, conditionOnArmNoise = true } = {}) {
  if (!trace || !trace.steps) {
    // logP is 0 — p = 1 — rather than absent. A caller that reads it as a
    // number gets "no evidence at all", which is the truth here; leaving it
    // undefined made `presence.logP > Math.log(MAX_ABSENCE_P)` false and
    // turned an unmeasurable region into an accepted one.
    return { ok: false, separation: 0, chance: 0, z: 0, nEff: 0, logP: 0, reason: 'no steps to measure' };
  }
  const T = trace.tones.length;
  // Blank the crashes first. `total` is per-window power summed over the arms;
  // windows more than CRASH_BLANK_DB above the region's median of it are
  // atmospheric and are not evidence about anything. See the constant for the
  // table this threshold comes from, and for why the null does not move.
  const total = new Float64Array(trace.steps);
  for (let s = 0; s < trace.steps; s++) {
    let v = 0;
    for (let j = 0; j < T; j++) v += trace.power[s * T + j];
    total[s] = v;
  }
  const medTotal = median(total);
  const bar = blankCrashes && medTotal > 0 ? medTotal * CRASH_BLANK_RATIO : Infinity;
  const keep = [];
  for (let s = 0; s < trace.steps; s++) if (total[s] <= bar) keep.push(s);
  const blanked = trace.steps - keep.length;
  if (keep.length < 4) {
    // Unreachable while the bar is a multiple of the MEDIAN total, which by
    // construction leaves at least half the windows standing; kept as a floor
    // so a future bar that is not median-based cannot fall through it.
    return { ok: false, separation: 0, chance: 0, z: 0, nEff: 0, logP: 0, blanked, reason: 'every window in this region is a crash' };
  }
  let sum = 0;
  for (const s of keep) sum += trace.margin[s];
  const separation = sum / keep.length;
  // The null is conditioned on the arms' own noise scales rather than assumed
  // flat. On white noise the scales come back within a per cent of each other
  // and this is the flat null to three decimals; on the colours real HF
  // actually has, it is the difference between refusing and typing.
  const noise = conditionOnArmNoise
    ? armNoiseScales(trace, { keep })
    : { scales: new Float64Array(T).fill(1), measured: [], why: ['the arm-noise conditioning was switched off by the caller'] };
  const scales = noise.scales;
  const flat = nullMargin(T);
  const { mean, sd } = nullMargin(T, scales);
  const nEff = Math.max(1, keep.length / Math.max(1, trace.oversample));
  const se = sd / Math.sqrt(nEff);
  const z = se > 0 ? (separation - mean) / se : 0;
  let tiltDb = 0;
  for (let j = 0; j < T; j++) for (let k = 0; k < T; k++) {
    tiltDb = Math.max(tiltDb, 10 * Math.log10(scales[j] / scales[k]));
  }
  // The mean of nEff independent margins is normal by the central limit
  // theorem well before nEff reaches the few hundred a usable region gives, so
  // the tail is the normal one. Kept as a log: a clean region reaches z = 23,
  // whose tail is 1e-118 and does not survive being written as a number.
  return {
    ok: true, separation, chance: mean, chanceSd: sd, nEff, se, z,
    scales: Array.from(scales), armTiltDb: tiltDb, flatChance: flat.mean,
    blanked, blankedFraction: blanked / trace.steps, windowsUsed: keep.length,
    unmeasuredArms: noise.why,
    logP: logNormalUpperTail(z),
  };
}

/**
 * Instants at which the winning tone changed, refined to a fraction of a step
 * by interpolating where the two arms' normalised powers crossed. Seconds,
 * measured from sample 0 of `x`.
 */
export function transitions(trace, { smooth = 3, minDwell = null } = {}) {
  const out = [];
  if (!trace.steps) return out;
  const T = trace.tones.length;
  // Mode-filter the winner over a few steps first. On a real recording two
  // arms of a close-spaced bank swap the lead for a step at a time whenever
  // noise happens to favour one, and each swap is a pair of transitions a
  // millisecond apart. Left in, those pairs dominate the gap statistics and
  // put the shortest observed gap two orders of magnitude below the symbol.
  let winner = trace.winner;
  if (smooth > 1 && trace.steps > smooth) {
    const half = smooth >> 1;
    const filtered = new Int16Array(trace.steps);
    const tally = new Int32Array(T);
    for (let s = 0; s < trace.steps; s++) {
      tally.fill(0);
      for (let k = -half; k <= half; k++) {
        const i = Math.min(trace.steps - 1, Math.max(0, s + k));
        tally[trace.winner[i]]++;
      }
      let best = -1, bi = trace.winner[s];
      for (let j = 0; j < T; j++) if (tally[j] > best) { best = tally[j]; bi = j; }
      // A tie keeps the unfiltered decision rather than the lowest index.
      filtered[s] = tally[trace.winner[s]] === best ? trace.winner[s] : bi;
    }
    winner = filtered;
  }
  // A symbol boundary has a whole symbol on each side of it. An excursion
  // through a third arm partway through a symbol does not, so runs shorter
  // than a quarter of the analysis window are dropped and their neighbours
  // allowed to meet. On the XPA2 body this cut the transition count from 9.5
  // per second to 7.2 against a symbol rate of 7.8, which is what an 11-tone
  // alphabet should give, and lifted the grid concentration from 0.50 to 0.90.
  const dwell = minDwell == null ? Math.max(1, Math.floor(trace.oversample / 4)) : minDwell;
  const runs = [];
  for (let s = 0; s < trace.steps; s++) {
    if (runs.length && runs[runs.length - 1].arm === winner[s]) runs[runs.length - 1].end = s;
    else runs.push({ arm: winner[s], start: s, end: s });
  }
  const kept = [];
  for (const r of runs) {
    if (r.end - r.start + 1 < dwell && kept.length) {
      // Too short to be a symbol: give its steps to whichever side it touches.
      kept[kept.length - 1].end = r.end;
      continue;
    }
    if (kept.length && kept[kept.length - 1].arm === r.arm) kept[kept.length - 1].end = r.end;
    else kept.push({ ...r });
  }
  for (let i = 1; i < kept.length; i++) {
    const a = kept[i - 1].arm, b = kept[i].arm;
    // The boundary is where THESE two arms crossed, which is not necessarily
    // where the winner last changed: a third arm can hold the lead for a step
    // or two in the middle of the transition, and taking the end of that
    // excursion instead would put every such boundary late. Search back from
    // the start of the new run to the last crossing of a against b.
    const lo = Math.max(1, kept[i - 1].start + 1);
    let s = Math.max(1, kept[i].start);
    const d = (k) => trace.norm[k * T + a] - trace.norm[k * T + b];
    while (s > lo && !(d(s - 1) > 0 && d(s) <= 0)) s--;
    const d0 = d(s - 1), d1 = d(s);
    const frac = (d0 - d1) !== 0 ? d0 / (d0 - d1) : 0.5;
    const f = Math.min(1, Math.max(0, frac));
    out.push(trace.timeAt(s - 1) + f * trace.stepSec);
  }
  return out;
}

function concentration(times, f) {
  let cr = 0, ci = 0;
  const k = 2 * Math.PI * f;
  for (let i = 0; i < times.length; i++) {
    const a = k * times[i];
    cr += Math.cos(a); ci += Math.sin(a);
  }
  return { r: Math.hypot(cr, ci) / times.length, phase: Math.atan2(ci, cr) };
}

/**
 * Symbol rate from the transition instants alone.
 *
 * If transitions fall on a grid of period T then they concentrate mod T, and
 * the concentration |mean(exp(i2*pi*t/T))| is a line spectrum of the transition
 * train. Every harmonic of the true rate concentrates just as hard — a set of
 * points on a grid of T is also on a grid of T/2 — so the rule that picks the
 * answer is: the LOWEST rate whose concentration is within 5% of the best, and
 * never a period longer than the transitions actually allow, since two
 * transitions cannot be closer than one symbol.
 *
 * Returns the runners-up so an ambiguity is visible rather than resolved
 * silently in the caller's favour.
 */
export function estimateBaud(times, {
  minBaud = 10, maxBaud = 600, minConcentration = 0, maxP = 1e-3, coarseSec = 6,
  requireHalvesAgree = true,
} = {}) {
  // maxP is the Bonferroni'd Rayleigh tail over the whole scan, and it behaves
  // like one: measured over 200 eight-second regions of each of five noise
  // colours through 2- and 4-arm banks, a bar of 1e-2 accepted between 0 and 4
  // of every 200 — 0.5% to 2.0%, which is the bar doing exactly what it says.
  // The bar is 1e-3 because 1% of noise answering with a confident symbol rate
  // is not a rate estimator, and every accepted noise region in that sweep sat
  // between 1e-3 and 1e-2. On real material there is room to spare: the XPA2
  // body reaches 0.47 concentration over hundreds of transitions, whose tail is
  // past 1e-30.
  if (!times || times.length < 6) {
    return { ok: false, baud: null, reason: `only ${times ? times.length : 0} transitions; need at least 6` };
  }
  const intervals = [];
  for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);
  const shortest = percentile(intervals, 0.05);

  const span = times[times.length - 1] - times[0];
  const coarseEnd = times[0] + Math.min(span, coarseSec);
  const coarseTimes = times.filter((t) => t <= coarseEnd);
  const coarseSpan = Math.max(1e-3, coarseTimes[coarseTimes.length - 1] - coarseTimes[0]);
  const dF = 1 / (4 * coarseSpan);
  const scan = [];
  for (let f = minBaud; f <= maxBaud; f += dF) {
    scan.push({ f, r: concentration(coarseTimes, f).r });
  }
  if (!scan.length) return { ok: false, baud: null, reason: 'nothing to scan' };
  let best = scan[0];
  for (const c of scan) if (c.r > best.r) best = c;

  // Refine on the full span, which is where the resolution is.
  const refine = (f0) => {
    let bf = f0, br = concentration(times, f0).r;
    const width = dF * 2;
    for (let f = f0 - width; f <= f0 + width; f += dF / 60) {
      if (f < minBaud * 0.98) continue;
      const r = concentration(times, f).r;
      if (r > br) { br = r; bf = f; }
    }
    return { f: bf, r: br };
  };

  // The fundamental, if there is one, is the peak DIVIDED by an integer: a set
  // of points on a grid of T also sits on a grid of T/2, so every harmonic of
  // the true rate scores as well as the true rate does. Only integer
  // submultiples are considered — an earlier version took the lowest rate
  // within 5% of the peak whatever it was, and on the XPA2 body, where the
  // peak only reaches R = 0.47, that let noise at 5/6 and 2/3 of the rate win.
  //
  // How far down to look is set by the transitions themselves: two of them
  // cannot be closer together than one symbol, so no admissible period is
  // longer than the shortest gap actually observed. That floor is what makes a
  // wide divisor search safe. An earlier version capped the divisor at 6 with
  // no floor, which is neither: on a random 8-FSK stream at 50 baud the coarse
  // peak lands near 500 and 500/6 = 83, so the fundamental was unreachable and
  // the estimator returned 100.000 baud for a 50 baud signal with R = 1.0000 at
  // both. With the floor in place the same stream reads 50.000.
  const gapFloorBaud = shortest > 0 ? 0.87 / shortest : minBaud;
  const top = refine(best.f);
  let chosen = top;
  const kMax = Math.max(2, Math.floor(top.f / Math.max(minBaud, gapFloorBaud)));
  for (let k = 2; k <= kMax; k++) {
    const f = top.f / k;
    if (f < minBaud || f < gapFloorBaud) break;
    const rr = refine(f);
    if (rr.r >= top.r * 0.95) chosen = rr;
  }
  // Other peaks in the scan, so a caller can see what else was close.
  const alternates = [];
  const peaks = scan.filter((c, i) => i > 0 && i < scan.length - 1 && c.r >= scan[i - 1].r && c.r >= scan[i + 1].r)
    .sort((a, b) => b.r - a.r);
  for (const c of peaks) {
    if (alternates.length >= 3) break;
    if (Math.abs(c.f - chosen.f) < dF * 2) continue;
    if (alternates.some((a) => Math.abs(a.baud - c.f) < dF * 2)) continue;
    alternates.push({ baud: c.f, concentration: c.r });
  }

  // What this measures is the TRANSITION grid, which equals the symbol rate
  // only when every symbol boundary is a possible transition. RTTY's 1.5 stop
  // bits put its character frames on half-bit offsets, so its transitions lie
  // on a grid at twice its baud and this returns that. The submultiples are
  // reported with their own concentration so a mode decoder that knows its
  // framing can pick the one that frames, which is the only evidence that
  // separates them.
  const submultiples = [];
  for (const k of [2, 3, 4]) {
    const f = chosen.f / k;
    if (f < minBaud) break;
    submultiples.push({ baud: f, divisor: k, concentration: concentration(times, f).r });
  }

  // Two transitions cannot be closer than one symbol, so gaps shorter than the
  // period this chose are evidence of spurious transitions rather than of a
  // faster signal — the rate is still the rate, but it was measured through a
  // noisier decision than the caller may assume.
  const period = 1 / chosen.f;
  let short = 0;
  for (const g of intervals) if (g < period * 0.9) short++;
  const spuriousGapFraction = intervals.length ? short / intervals.length : 0;

  // Whether the concentration is real, by the Rayleigh test for circular
  // uniformity: under no periodicity, n*R^2 is exponential, so the chance of
  // this height arising anywhere in a scan of this many grid points is
  // points * exp(-n*R^2). A bare threshold on R does not work on real HF
  // material — the XPA2 body's rate is sharp to a hundredth of a baud and
  // still only reaches R = 0.47, because a transition detector on a fading
  // signal scatters each instant by a fifth of a symbol.
  const z2 = times.length * chosen.r * chosen.r;
  const rayleighP = Math.min(1, scan.length * Math.exp(-z2));
  const gridOk = rayleighP <= maxP && chosen.r >= minConcentration;

  // --- how wide is this number? ------------------------------------------
  //
  // Transitions sit at (k + phi)/f plus a jitter. A wrapped-normal cluster of
  // concentration R has jitter sigma = sqrt(-2 ln R) / (2 pi f) seconds, and
  // fitting a rate to n instants spread over a span is a straight-line fit
  // whose slope error is sigma / sqrt(Stt) in seconds per symbol index. So
  //   se(f) = f * sigma / sqrt(Stt),   Stt = sum (t_i - tbar)^2.
  // The lever arm is the span, which is why a long region measures a rate far
  // better than a short one at the same jitter.
  const jitterSec = chosen.r > 0 && chosen.r < 1
    ? Math.sqrt(-2 * Math.log(chosen.r)) / (2 * Math.PI * chosen.f) : 0;
  let tbar = 0;
  for (const t of times) tbar += t;
  tbar /= times.length;
  let stt = 0;
  for (const t of times) stt += (t - tbar) * (t - tbar);
  const seAnalytic = stt > 0 ? chosen.f * jitterSec / Math.sqrt(stt) : Infinity;

  // ...and whether that width is honest, by measuring the two halves against
  // each other. Halving n and the span cuts Stt by about 8, so each half's own
  // error is about sqrt(8) = 2.83 times the whole region's, and the difference
  // between two independent halves is about sqrt(2) * 2.83 = 4 times it. So
  // |f1 - f2| / 4 is a one-draw estimate of se from the data alone, owing
  // nothing to the jitter model. The bar reported is the LARGER of the two:
  // a model bar that the halves disagree past is not a bar, it is a claim.
  const mid = times[0] + (times[times.length - 1] - times[0]) / 2;
  const firstHalf = times.filter((t) => t <= mid);
  const secondHalf = times.filter((t) => t > mid);
  let splitHalf = null;
  if (firstHalf.length >= 6 && secondHalf.length >= 6) {
    const refineOn = (ts, f0) => {
      let bf = f0, br = concentration(ts, f0).r;
      for (let f = f0 - dF; f <= f0 + dF; f += dF / 60) {
        const r = concentration(ts, f).r;
        if (r > br) { br = r; bf = f; }
      }
      return bf;
    };
    const f1 = refineOn(firstHalf, chosen.f);
    const f2 = refineOn(secondHalf, chosen.f);
    splitHalf = {
      baudFirst: f1, baudSecond: f2, difference: Math.abs(f1 - f2),
      impliedSe: Math.abs(f1 - f2) / 4,
      agrees: Math.abs(f1 - f2) <= 4 * 2 * Math.max(seAnalytic, dF / 120),
    };
  }
  // A zero error bar is a lie as surely as a too-narrow one: on a synthetic
  // signal R comes back at exactly 1 and the jitter model says the rate is
  // known perfectly, when in fact the refiner steps by dF/60 and cannot resolve
  // finer than half of that.
  const resolutionFloor = dF / 120;
  const baudSe = Math.max(
    Number.isFinite(seAnalytic) ? seAnalytic : 0,
    splitHalf ? splitHalf.impliedSe : 0,
    resolutionFloor,
  );

  // --- does the transition set actually name a SYMBOL rate? ---------------
  //
  // It names a transition grid. The symbol rate is an integer multiple of that
  // grid, and which multiple is not always knowable: a stream sending 0011
  // repeatedly at 50 baud puts its transitions in exactly the places a stream
  // sending 01 at 25 baud does, to the last sample. Nothing in the instants
  // separates them. What separates a real message from a test pattern is
  // entropy — traffic puts two transitions one symbol apart constantly, and a
  // repeating pattern's gap sequence repeats.
  const units = intervals.map((g) => g * chosen.f);
  const rounded = units.map((u) => Math.round(u));
  let unitGaps = 0;
  for (const u of units) if (Math.abs(u - 1) < 0.25) unitGaps++;
  const unitGapFraction = units.length ? unitGaps / units.length : 0;
  // Smallest period the gap sequence repeats at, if it repeats at least four
  // times over. A repeating gap train carries no entropy and cannot pin a rate.
  let gapPeriod = null;
  for (let period = 1; period <= Math.floor(rounded.length / 4); period++) {
    let same = true;
    for (let i = period; i < rounded.length && same; i++) if (rounded[i] !== rounded[i - period]) same = false;
    if (same) { gapPeriod = period; break; }
  }
  // A rate is only NAMED when the two halves of the region measure the same
  // one. On noise the concentration peak is a fluke of whichever half happened
  // to carry it: measured over the same sweep, four white-noise regions through
  // a 4-arm bank came back with a named symbol rate near 300 baud at
  // concentrations of 0.12, and the halves disagreed on three of the four.
  const halvesAgree = !requireHalvesAgree || (splitHalf ? splitHalf.agrees : false);
  const ambiguous = gapPeriod !== null || unitGapFraction < 0.02 || !halvesAgree;
  const consistentWith = [];
  if (ambiguous) {
    for (let m = 1; m * chosen.f <= maxBaud && consistentWith.length < 6; m++) consistentWith.push(m * chosen.f);
  }
  const ambiguityReason = !ambiguous ? null
    : !halvesAgree
      ? (splitHalf
        ? `the two halves of this region measure ${splitHalf.baudFirst.toFixed(3)} and ${splitHalf.baudSecond.toFixed(3)} baud, further apart than the transitions can account for, so the grid rate is a property of one half and not of the region`
        : 'there are too few transitions to measure this rate in each half of the region separately, so nothing here says the grid is the same throughout')
      : gapPeriod !== null
      ? `the gaps between transitions repeat every ${gapPeriod} of them, so this is a fixed pattern and not traffic: its transitions are identical to those of a stream at any integer multiple of ${chosen.f.toFixed(3)} baud sending a correspondingly stretched pattern, and nothing in the instants says which`
      : `no two transitions anywhere in this region are one symbol apart at ${chosen.f.toFixed(3)} baud (${(unitGapFraction * 100).toFixed(1)}% of gaps), so the symbol rate may be any integer multiple of the grid measured here`;

  const ok = gridOk;
  return {
    ok,
    // The transition GRID rate. This is what the instants measure.
    baud: chosen.f,
    baudSe,
    // The SYMBOL rate, and null when the transition set cannot determine it.
    // A caller that wants to print "N baud" wants this one.
    symbolRate: ok && !ambiguous ? chosen.f : null,
    symbolRateAtLeast: ok ? chosen.f : null,
    ambiguous,
    consistentWith,
    unitGapFraction,
    gapPeriod,
    splitHalf,
    concentration: chosen.r,
    transitionCount: times.length,
    shortestGapSec: shortest,
    searchFloorBaud: minBaud,
    spuriousGapFraction,
    rayleighP,
    scanPoints: scan.length,
    alternates,
    submultiples,
    reason: ok ? (ambiguous ? ambiguityReason : null)
      : `transitions do not fall on a regular grid: the best period holds only ${(chosen.r * 100).toFixed(0)}% of ${times.length} transitions, which a scan of ${scan.length} candidate rates would find by chance with probability ${rayleighP.toExponential(1)}; this is not a fixed-rate FSK stream, or the tone set is wrong`,
    warnings: [
      ...(ambiguous && ok ? [`symbol rate is not determined by these transitions: ${ambiguityReason}`] : []),
      ...(splitHalf && !splitHalf.agrees ? [`the two halves of this region measure ${splitHalf.baudFirst.toFixed(3)} and ${splitHalf.baudSecond.toFixed(3)} baud, further apart than the model error bar allows; the bar reported has been widened to ${baudSe.toFixed(4)} baud to cover it`] : []),
      ...(spuriousGapFraction > 0.2
        ? [`${(spuriousGapFraction * 100).toFixed(0)}% of gaps between transitions are shorter than one symbol at ${chosen.f.toFixed(2)} baud; the tone decisions are flickering and the rate rests on the transitions that are real`]
        : []),
    ],
  };
}

/**
 * Symbol phase from the transition instants: transitions land on symbol
 * boundaries, so the best instant to sample is half a symbol after the phase
 * they cluster at. The concentration of that cluster is the timing quality.
 *
 * A second pass regresses the leftover timing error on time, which turns a
 * clock that is slightly off into a measured parts-per-million rather than a
 * decode that quietly falls apart halfway through.
 */
export function recoverTiming(times, baud) {
  if (!times || times.length < 3) {
    return { ok: false, phase: 0, concentration: 0, baud, reason: 'fewer than three transitions; symbol phase is unrecoverable' };
  }
  const { r, phase } = concentration(times, baud);
  const phi = phase / (2 * Math.PI);
  const T = 1 / baud;
  // Residual of each transition against the grid it should be on.
  const res = [], ts = [];
  for (const t of times) {
    const k = Math.round(t / T - phi);
    const e = t - (k + phi) * T;
    if (Math.abs(e) < T * 0.45) { res.push(e); ts.push(t); }
  }
  let ppm = 0, baudRefined = baud;
  if (res.length >= 6) {
    let mt = 0, me = 0;
    for (let i = 0; i < res.length; i++) { mt += ts[i]; me += res[i]; }
    mt /= res.length; me /= res.length;
    let num = 0, den = 0;
    for (let i = 0; i < res.length; i++) { num += (ts[i] - mt) * (res[i] - me); den += (ts[i] - mt) ** 2; }
    const slope = den > 0 ? num / den : 0;
    // A residual growing at `slope` seconds per second means the true symbol
    // period is longer by that fraction.
    baudRefined = baud / (1 + slope);
    ppm = slope * 1e6;
  }
  return {
    ok: r >= 0.5,
    phase: phi - Math.floor(phi),
    concentration: r,
    baud, baudRefined, clockErrorPpm: ppm,
    reason: r >= 0.5 ? null : `transition instants are spread across the symbol (concentration ${r.toFixed(2)}); symbol timing is a guess`,
  };
}

/**
 * The whole front end: tones in (or estimated), symbols out, each with a soft
 * margin. Symbols are read by a fresh Goertzel centred on the recovered
 * sampling instant rather than by reusing the nearest trace step, because the
 * trace is stepped for timing recovery and the symbol read wants to be exact.
 */
export function fskDemod(x, sampleRate, {
  tones = null, baud = null, oversample = 8, start = 0, length = 0,
  agc = true, refineClock = true,
} = {}) {
  const warnings = [];
  let toneSet = tones;
  let toneEstimate = null;
  if (!toneSet) {
    toneEstimate = estimateTones(x.subarray ? x.subarray(start, length ? start + length : x.length) : x, sampleRate);
    warnings.push(...toneEstimate.warnings);
    if (!toneEstimate.ok) {
      return { ok: false, symbols: null, reason: toneEstimate.reason, toneEstimate, warnings };
    }
    toneSet = toneEstimate.tones;
  }

  let rate = baud;
  let baudEstimate = null;
  if (!rate) {
    // The probe window is set by the TONES, not by a guess at the rate: two
    // tones a gap apart need about 1/gap seconds to be told apart, and that is
    // also the symbol period of an orthogonal MFSK signal on that spacing, so
    // it is both the shortest usable window and the longest one that does not
    // smear the transition instants the rate is measured from. Guessing a slow
    // rate instead (a long window) is what makes a blind estimate come back at
    // a harmonic.
    let gap = Infinity;
    for (let i = 1; i < toneSet.length; i++) gap = Math.min(gap, Math.abs(toneSet[i] - toneSet[i - 1]));
    // The spacing is a LOWER bound on the symbol period, not an estimate of it:
    // orthogonality only requires spacing >= 1/T, and real designs sit above
    // that — the XPA body measures 40.0 Hz spacing at 10.000 baud (4/T) and
    // the XPA2 body 15.6 Hz at 7.8125 baud (2/T). So the probe window is swept
    // from the spacing downwards and the pass with the most significant grid
    // is kept, rather than the first one being trusted.
    let est = null, probeBaud = 0, lastFail = null;
    for (const divisor of [1, 2, 4, 8]) {
      const win = Math.max(8, Math.round(divisor * sampleRate / gap));
      const tryBaud = sampleRate / win;
      const probe = toneTrace(x, sampleRate, { tones: toneSet, baud: tryBaud, oversample: 16, start, length, agc });
      if (!probe.steps) break;
      const e = estimateBaud(transitions(probe), {});
      if (!e.ok) { lastFail = e; continue; }
      if (!est || e.rayleighP < est.rayleighP) { est = e; probeBaud = tryBaud; }
    }
    if (!est) {
      return { ok: false, symbols: null, reason: (lastFail && lastFail.reason) || 'no symbol rate found at any probe window', baudEstimate: lastFail, toneEstimate, warnings };
    }
    // One more pass with the window set to the rate just measured, where the
    // transition instants are as sharp as this signal allows.
    if (Math.abs(est.baud - probeBaud) / probeBaud > 0.02) {
      const probe = toneTrace(x, sampleRate, { tones: toneSet, baud: est.baud, oversample: 16, start, length, agc });
      if (probe.steps) {
        const e = estimateBaud(transitions(probe), {});
        if (e.ok && e.rayleighP <= est.rayleighP) est = e;
      }
    }
    baudEstimate = est;
    rate = est.baud;
  }

  let trace = toneTrace(x, sampleRate, { tones: toneSet, baud: rate, oversample, start, length, agc });
  if (!trace.steps) return { ok: false, symbols: null, reason: trace.warnings[0] || 'region too short', warnings };
  warnings.push(...trace.warnings);
  let timing = recoverTiming(transitions(trace), rate);
  if (refineClock && timing.ok && Math.abs(timing.clockErrorPpm) > 200) {
    rate = timing.baudRefined;
    trace = toneTrace(x, sampleRate, { tones: toneSet, baud: rate, oversample, start, length, agc });
    timing = recoverTiming(transitions(trace), rate);
    warnings.push(`symbol clock refined to ${rate.toFixed(4)} baud from the transition grid`);
  }

  const T = toneSet.length;
  const win = Math.max(4, Math.round(sampleRate / rate));
  const period = sampleRate / rate;
  const first = start + (timing.phase + 0.5) * period;
  const region = length || (x.length - start);
  const count = Math.max(0, Math.floor((region - win / 2 - (first - start)) / period) + 1);
  const symbols = new Int16Array(count);
  const soft = new Float32Array(count);
  const level = new Float64Array(count);
  const times = new Float64Array(count);
  const p = new Float64Array(T);
  let snrSum = [];
  for (let m = 0; m < count; m++) {
    const centre = first + m * period;
    const at = Math.round(centre - win / 2);
    if (at < 0 || at + win > x.length) { symbols[m] = -1; continue; }
    let best = -1, second = -1, bi = 0, sum = 0;
    for (let j = 0; j < T; j++) {
      const v = goertzel(x, sampleRate, toneSet[j], { start: at, length: win }) * trace.gains[j];
      p[j] = v; sum += v;
      if (v > best) { second = best; best = v; bi = j; }
      else if (v > second) second = v;
    }
    symbols[m] = bi;
    soft[m] = best + second > 0 ? (best - second) / (best + second) : 0;
    level[m] = best;
    times[m] = centre / sampleRate;
    const losers = (sum - best) / (T - 1);
    if (losers > 0) snrSum.push(best / losers);
  }
  const armSnrDb = snrSum.length ? 10 * Math.log10(Math.max(1e-12, median(snrSum) - 1)) : null;
  const quality = count ? Array.from(soft).reduce((a, b) => a + b, 0) / count : 0;

  // Is there a signal in these arms at all?
  //
  // Without this, a bank told where the tones are and how fast the symbols run
  // returns symbols for anything. Measured on eight seconds of white noise
  // through a 2125/2295 pair at 45.45 baud: ok, 363 symbols, no warnings, and
  // describeFsk reporting "2-FSK at 45.450 baud ... per-arm SNR 2.6 dB".
  //
  // The old guard here compared the mean soft margin against a fixed 0.3, which
  // is not a threshold at all: two arms of pure noise average EXACTLY 0.5, so
  // 0.3 could never fire on a 2-FSK bank however empty the band was, while on
  // an 8-tone bank, where chance is 0.211, it fired on perfectly good signals.
  // The level to beat depends on the number of arms and on nothing else.
  const presence = armSeparation(trace);
  // The level chance gives on THESE arms, which is the flat null only when the
  // arms carry the same amount of noise as each other.
  const chanceQuality = presence.ok ? presence.chance : nullMargin(T).mean;
  if (presence.logP > Math.log(MAX_ABSENCE_P)) {
    return {
      ok: false, symbols: null, count: 0,
      tones: toneSet, baud: rate, order: T,
      quality, presence, timing, armSnrDb, trace, toneEstimate, baudEstimate,
      reason: `no FSK signal in these arms: the mean decision margin is ${presence.separation.toFixed(3)} against the ${chanceQuality.toFixed(3)} that ${T} arms of pure noise give at the ${(presence.armTiltDb || 0).toFixed(1)} dB of arm-to-arm noise tilt this region carries, ${presence.z.toFixed(1)} standard errors over ${Math.round(presence.nEff)} independent symbol windows, which chance beats with probability ${Math.exp(presence.logP).toExponential(1)}`,
      warnings,
    };
  }
  if (quality < chanceQuality + (1 - chanceQuality) * 0.35) {
    warnings.push(`mean soft margin ${quality.toFixed(2)} against the ${chanceQuality.toFixed(2)} that ${T} arms of noise alone would give — the decisions are close to coin flips and the symbols should not be read as data`);
  }

  return {
    ok: true,
    symbols, soft, level, times, count,
    presence,
    tones: toneSet, baud: rate, order: T,
    bitsPerSymbol: Math.log2(T),
    timing, armSnrDb, quality,
    toneEstimate, baudEstimate,
    trace,
    warnings,
  };
}

/** Convenience for a caller that wants a name for what it is looking at. */
export function describeFsk(result) {
  if (!result || !result.ok) return `no FSK: ${result ? result.reason : 'nothing measured'}`;
  const t = result.tones.map((v) => v.toFixed(1)).join(' / ');
  const snr = result.armSnrDb == null ? 'unknown' : `${result.armSnrDb.toFixed(1)} dB`;
  return `${result.order}-FSK at ${result.baud.toFixed(3)} baud, tones ${t} Hz, `
    + `per-arm SNR ${snr} in a ${result.baud.toFixed(1)} Hz bandwidth, `
    + `mean soft margin ${result.quality.toFixed(2)} over ${result.count} symbols`;
}
