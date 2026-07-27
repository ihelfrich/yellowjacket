// True-peak estimation per BS.1770-5 Annex 2 structure: 4x oversampling through a
// 48-tap, 4-phase polyphase interpolation FIR (12 taps per phase). Kaiser-windowed
// sinc, beta 7: fs/4 intersample accuracy +0.063 dB with ~-50 dB image sidelobes
// (a peak detector should err high, never low). Verified against analytic
// intersample peaks in the test suite. Worker-safe, pure.

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

// Max absolute oversampled value across channels, without materializing 4x arrays.
export function truePeakLinear(channels) {
  const perPhase = TAPS / L;
  let peak = 0;
  for (const x of channels) {
    const n = x.length;
    for (let i = 0; i < n; i++) {
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
