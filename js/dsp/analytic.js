// The primitives a measurement on a radio signal starts from: the analytic
// signal, the instantaneous amplitude and frequency that fall out of it, a
// single-tone power detector, and windowed-sinc band design.
//
// The analytic signal is built with an FIR Hilbert transformer rather than in
// the frequency domain, and that choice was measured rather than assumed. A
// whole-span FFT Hilbert is exact arithmetic on a segment that is not periodic,
// so the wrap-around step at the join contaminates the phase everywhere, decaying
// only as 1/distance: on a 1 kHz tone at 48 kHz the instantaneous frequency still
// wanders 0.86 Hz at 4,800 samples from the edge and 0.32 Hz at 12,000. A
// 511-tap Kaiser Hilbert holds 0.04 Hz across 300 Hz to 3 kHz, is local, and
// costs 23 ms per second of audio. `analyticFft` is kept for envelope work,
// where the same error is irrelevant, and says so.
import { FFT, nextPow2 } from '../fft.js';

// 511 taps at 48 kHz: usable from about 190 Hz, 0.04 Hz of frequency jitter
// across the voice band, 23 ms of work per second of audio.
export const HILBERT_TAPS = 511;

/**
 * The Hilbert transformer: a type-III FIR whose response is +/-90 degrees across
 * its passband. Odd length only, so the delay it introduces is a whole (taps-1)/2
 * samples and the real part is just the input delayed by the same amount.
 * Its accuracy falls off near DC and near Nyquist; the usable band runs roughly
 * from 2·rate/taps upward, which is why 511 is the default at audio rates.
 * Measured spread of the instantaneous frequency of a pure tone: 255 taps holds
 * 0.07 Hz at 1 kHz but 39 Hz at 300 Hz; 511 taps holds 0.10 Hz at 300 Hz.
 */
export function firHilbert(taps = HILBERT_TAPS, stopDb = 80) {
  const n = taps % 2 ? taps : taps + 1;
  const w = kaiser(n, kaiserBeta(stopDb));
  const h = new Float64Array(n);
  const m = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const k = i - m;
    h[i] = (k === 0 || k % 2 === 0) ? 0 : (2 / (Math.PI * k)) * w[i];
  }
  return h;
}

/**
 * The analytic signal of a real span: z[n] = x[n] + i·H{x}[n], by FIR.
 * The first and last `guardFor(taps)` samples are the filter filling and
 * emptying and are not signal — every caller that reads phase must skip them.
 */
export function analytic(x, { taps = HILBERT_TAPS, stopDb = 80 } = {}) {
  const h = firHilbert(taps, stopDb);
  const re = new Float64Array(x.length);
  re.set(x);
  return { re, im: filter(x, h), taps: h.length, guard: guardFor(h.length) };
}

/** Samples at each end of an `analytic` result that are filter fill, not signal. */
export function guardFor(taps = HILBERT_TAPS) { return taps + 1; }

/**
 * The whole-span frequency-domain analytic signal. Use it for the envelope,
 * where its error does not matter; do not read instantaneous frequency from it
 * without the guard above, and even then expect the 1/distance edge error
 * described at the top of this file.
 */
export function analyticFft(x) {
  const n = x.length;
  const size = nextPow2(Math.max(2, n));
  const fft = new FFT(size, { precision: 'f64' });
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(x);
  fft.forward(re, im);
  // Bin 0 and, when the length is even, bin size/2 are their own conjugates and
  // are left alone; the positive half doubles and the negative half goes to zero.
  const half = size >> 1;
  for (let i = 1; i < half; i++) { re[i] *= 2; im[i] *= 2; }
  for (let i = half + 1; i < size; i++) { re[i] = 0; im[i] = 0; }
  fft.inverse(re, im);
  return { re: re.slice(0, n), im: im.slice(0, n) };
}

/** |z[n]|, the envelope. */
export function instantaneousAmp(re, im) {
  const out = new Float32Array(re.length);
  for (let i = 0; i < re.length; i++) out[i] = Math.hypot(re[i], im[i]);
  return out;
}

/**
 * Instantaneous frequency in hertz, from the phase advance between neighbours:
 * f[n] = arg(z[n] · conj(z[n-1])) · rate / 2π. Taking the argument of the
 * product rather than differencing two arguments is what makes this immune to
 * wrapping — there is no unwrap step to go wrong. out[0] repeats out[1].
 * Unambiguous to +/- rate/2; a signal above that folds, like any sampled thing.
 */
export function instantaneousFreq(re, im, sampleRate) {
  const n = re.length;
  const out = new Float32Array(n);
  const k = sampleRate / (2 * Math.PI);
  for (let i = 1; i < n; i++) {
    const pr = re[i] * re[i - 1] + im[i] * im[i - 1];
    const pi = im[i] * re[i - 1] - re[i] * im[i - 1];
    out[i] = Math.atan2(pi, pr) * k;
  }
  if (n > 1) out[0] = out[1];
  return out;
}

/**
 * Power at one frequency over a span, by Goertzel: the cost of a single DFT bin
 * without computing the other size-1. Returns power normalised so a unit-
 * amplitude tone at exactly `hz` reads 0.25 (the amplitude-squared of each of
 * its two conjugate halves), which makes 10·log10 of it directly comparable
 * with an FFT magnitude spectrum of the same span.
 */
export function goertzel(x, sampleRate, hz, { start = 0, length = 0 } = {}) {
  const n = length || (x.length - start);
  if (n <= 0) return 0;
  const w = 2 * Math.PI * hz / sampleRate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const s = x[start + i] + coeff * s1 - s2;
    s2 = s1; s1 = s;
  }
  const real = s1 - s2 * Math.cos(w);
  const imag = s2 * Math.sin(w);
  return (real * real + imag * imag) / (n * n);
}

/** Goertzel at several frequencies over the same span, in one pass each. */
export function goertzelBank(x, sampleRate, freqs, opts = {}) {
  const out = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) out[i] = goertzel(x, sampleRate, freqs[i], opts);
  return out;
}

/** Kaiser beta for a stopband attenuation in dB (Kaiser's own empirical fit). */
export function kaiserBeta(stopDb) {
  if (stopDb > 50) return 0.1102 * (stopDb - 8.7);
  if (stopDb >= 21) return 0.5842 * Math.pow(stopDb - 21, 0.4) + 0.07886 * (stopDb - 21);
  return 0;
}

// Zeroth-order modified Bessel function of the first kind, by its series. The
// terms fall like (x/2)^2k/(k!)^2, so 30 of them cover every beta used here.
function besselI0(x) {
  let sum = 1, term = 1;
  for (let k = 1; k < 32; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

/** A Kaiser window of `n` points. */
export function kaiser(n, beta) {
  const w = new Float64Array(n);
  const denom = besselI0(beta);
  const m = n - 1;
  for (let i = 0; i < n; i++) {
    const r = (2 * i - m) / m;
    w[i] = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / denom;
  }
  return w;
}

/**
 * Kaiser-windowed sinc low-pass. `cutoff` is a fraction of the sample rate
 * (0.5 is Nyquist). Odd `taps` only: an even-length linear-phase low-pass has a
 * half-sample delay, and every caller here wants an integer group delay it can
 * simply trim.
 */
export function firLowpass(taps, cutoff, stopDb = 80) {
  const n = taps % 2 ? taps : taps + 1;
  const w = kaiser(n, kaiserBeta(stopDb));
  const h = new Float32Array(n);
  const m = (n - 1) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = i - m;
    const s = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
    h[i] = s * w[i];
    sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum;   // unity at DC
  return h;
}

/**
 * Kaiser-windowed sinc band-pass, as the difference of two low-passes. Both
 * edges are fractions of the sample rate. The result is normalised to unity at
 * the band centre, so a tone inside the band comes out at its own amplitude.
 */
export function firBandpass(taps, low, high, stopDb = 80) {
  const n = taps % 2 ? taps : taps + 1;
  const hi = firLowpass(n, high, stopDb);
  const lo = firLowpass(n, low, stopDb);
  const h = new Float32Array(n);
  for (let i = 0; i < n; i++) h[i] = hi[i] - lo[i];
  const centre = (low + high) / 2;
  const m = (n - 1) / 2;
  let gr = 0, gi = 0;
  for (let i = 0; i < n; i++) {
    const a = -2 * Math.PI * centre * (i - m);
    gr += h[i] * Math.cos(a);
    gi += h[i] * Math.sin(a);
  }
  const gain = Math.hypot(gr, gi) || 1;
  for (let i = 0; i < n; i++) h[i] /= gain;
  return h;
}

/**
 * Convolve and trim the filter's own group delay, so the output lines up sample
 * for sample with the input and is the same length. The first and last (taps-1)/2
 * samples are the filter filling and emptying and are not signal.
 */
export function filter(x, h) {
  const n = x.length, m = h.length, d = (m - 1) >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const k0 = Math.max(0, i + d - n + 1);
    const k1 = Math.min(m - 1, i + d);
    for (let k = k0; k <= k1; k++) acc += h[k] * x[i + d - k];
    out[i] = acc;
  }
  return out;
}

/**
 * Move a complex signal along the frequency axis by `hz` — the beat-frequency
 * oscillator every receiver has. Mutates nothing; returns a new pair. A real
 * signal must be made analytic first, or its negative half folds back on top of
 * the part you wanted.
 */
export function shiftHz(re, im, sampleRate, hz) {
  const n = re.length;
  const outRe = new Float32Array(n);
  const outIm = new Float32Array(n);
  const w = 2 * Math.PI * hz / sampleRate;
  for (let i = 0; i < n; i++) {
    const c = Math.cos(w * i), s = Math.sin(w * i);
    outRe[i] = re[i] * c - im[i] * s;
    outIm[i] = re[i] * s + im[i] * c;
  }
  return { re: outRe, im: outIm };
}
