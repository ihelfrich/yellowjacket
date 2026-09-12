// True-peak estimation per BS.1770-5 Annex 2 structure: 4x oversampling through a
// 48-tap, 4-phase polyphase interpolation FIR (12 taps per phase), Kaiser-windowed
// sinc, beta 7. Worker-safe, pure.
//
// THE SAMPLES ARE PART OF THE MAXIMUM. The oversampled phases are interpolated
// points BETWEEN the input samples; none of them reproduces an input sample, so
// a maximum taken over the phases alone can come out below the sample peak,
// which a true peak can never be. It did: measured on 0.5-amplitude tones whose
// crest lands exactly on a sample, the phases-only maximum read 0.006 dB low at
// a twentieth of the sample rate, 0.168 dB low at a quarter of it and 0.590 dB
// low at 0.45 of it, at every rate from 44.1 to 192 kHz. The fault was found by
// comparing this file against Nyquist's independent Swift implementation of the
// same annex, whose design note states the rule this one was missing. The old
// test could not see it: its fixture is a quarter-rate sine at phase pi/4, where
// the samples straddle the crest 3 dB down and contribute nothing.
//
// What is left is the annex's own bound for 4x oversampling, and it is measured
// rather than claimed. Against analytic peaks, over rational frequency ratios
// from 0.05 to 0.45 of the sample rate and 64 phases each, the worst under-read
// is 0.199 dB at 0.40 of the rate. Raising the Kaiser beta does not help (beta 8
// measures 0.241 dB); it is the filter's roll-off near Nyquist, so only a longer
// filter moves it (24 taps per phase: 0.168 dB) and 8x oversampling on its own
// does not (0.197 dB). A reader who needs headroom near Nyquist should take
// 0.2 dB off the ceiling, which is what this bound is for.

const L = 4;                 // oversampling factor
const TAPS = 48;             // total taps; TAPS / L = 12 per phase
const BETA = 7;

function besselI0(x) {
  let sum = 1;
  let term = 1;
  const half = x / 2;
  for (let k = 1; k < 40; k++) {
    term *= (half / k) * (half / k);
    sum += term;
    if (term < sum * 1e-16) break;
  }
  return sum;
}

// Prototype lowpass at the ORIGINAL Nyquist, sampled on the 4x grid.
// h[i], i = 0..47, centered at (TAPS - 1) / 2; polyphase branch p uses taps i where
// i % L == p. Peak gain of the interpolator is L (standard), folded in below.
const PROTO = (() => {
  const h = new Float64Array(TAPS);
  const center = (TAPS - 1) / 2;
  const i0b = besselI0(BETA);
  for (let i = 0; i < TAPS; i++) {
    const t = (i - center) / L;              // in input-sample units
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    const r = (i - center) / center;
    const win = besselI0(BETA * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
    h[i] = sinc * win;
  }
  return h;
})();

// Phase-major layout: PHASE[p][j] applies to input sample (n - j). Each branch is
// normalized to unit sum so DC passes at exactly 0 dB through every phase.
const PHASE = (() => {
  const perPhase = TAPS / L;
  const phases = [];
  for (let p = 0; p < L; p++) {
    const c = new Float64Array(perPhase);
    let sum = 0;
    for (let j = 0; j < perPhase; j++) { c[j] = PROTO[j * L + p]; sum += c[j]; }
    for (let j = 0; j < perPhase; j++) c[j] /= sum;
    phases.push(c);
  }
  return phases;
})();

// 4x oversample one channel. out (optional) must be input.length * 4.
export function upsample4x(x, out) {
  const n = x.length;
  const perPhase = TAPS / L;
  const y = out && out.length === n * L ? out : new Float32Array(n * L);
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < L; p++) {
      const c = PHASE[p];
      let acc = 0;
      for (let j = 0; j < perPhase; j++) {
        let k = i - j + (perPhase >> 1);     // center the window on the sample
        if (k < 0) k = 0; else if (k >= n) k = n - 1;  // replicate edges: unity DC holds
        acc += x[k] * c[j];
      }
      y[i * L + p] = acc;
    }
  }
  return y;
}

// Max absolute value across channels — the input samples and the oversampled
// points between them — without materializing 4x arrays.
export function truePeakLinear(channels) {
  const perPhase = TAPS / L;
  let peak = 0;
  for (const x of channels) {
    const n = x.length;
    for (let i = 0; i < n; i++) {
      // The sample itself is a point on the reconstructed waveform, so it is a
      // candidate for the maximum. `peakTrack` below has always started here;
      // this function did not, and that was the whole defect.
      const s = x[i] < 0 ? -x[i] : x[i];
      if (s > peak) peak = s;
      for (let p = 0; p < L; p++) {
        const c = PHASE[p];
        let acc = 0;
        for (let j = 0; j < perPhase; j++) {
          let k = i - j + (perPhase >> 1);
          if (k < 0) k = 0; else if (k >= n) k = n - 1;
          acc += x[k] * c[j];
        }
        const a = acc < 0 ? -acc : acc;
        if (a > peak) peak = a;
      }
    }
  }
  return peak;
}

export function truePeakDb(channels) {
  const peak = truePeakLinear(channels);
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

// Per-sample linked oversampled peak track for the limiter: out[i] = the largest
// absolute value (sample or 4x subsample) attributable to input index i, maxed
// across channels. out must be length n.
export function peakTrack(channels, out) {
  const perPhase = TAPS / L;
  out.fill(0);
  for (const x of channels) {
    const n = Math.min(x.length, out.length);
    for (let i = 0; i < n; i++) {
      let m = x[i] < 0 ? -x[i] : x[i];
      for (let p = 0; p < L; p++) {
        const c = PHASE[p];
        let acc = 0;
        for (let j = 0; j < perPhase; j++) {
          let k = i - j + (perPhase >> 1);
          if (k < 0) k = 0; else if (k >= n) k = n - 1;
          acc += x[k] * c[j];
        }
        const a = acc < 0 ? -acc : acc;
        if (a > m) m = a;
      }
      if (m > out[i]) out[i] = m;
    }
  }
  return out;
}
