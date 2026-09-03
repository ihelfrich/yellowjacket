// Kaiser-windowed polyphase sinc resampler. Worker-safe, pure.
// Design: >= 80 dB stopband (Kaiser beta 7.857), passband to 0.9 * min(in, out)/2
// (7.2 kHz for any ->16k path), linear phase with the kernel centered on the exact
// fractional input position, so t_out == t_in and timestamps never shift.

const KAISER_BETA = 7.857;      // 0.1102 * (80 - 8.7), Kaiser's 80 dB formula
const HALF_WIDTH = 160;         // input samples each side => ~320 taps for ->16k
const PHASES = 512;             // kernel table resolution; linear interp between entries

// Modified Bessel I0 by power series; converges fast for beta < 20.
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

const kernelCache = new Map();

// Dense one-sided kernel table: H[i] = windowed sinc at t = i / PHASES input
// samples, for the given cutoff (cycles per input sample).
function kernelTable(cutoff) {
  const key = cutoff.toFixed(8);
  let table = kernelCache.get(key);
  if (table) return table;
  const n = HALF_WIDTH * PHASES + 1;
  table = new Float64Array(n);
  const i0b = besselI0(KAISER_BETA);
  for (let i = 0; i < n; i++) {
    const t = i / PHASES;
    const x = 2 * cutoff * t;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const r = t / HALF_WIDTH;                       // 0..1 across the kernel
    const win = besselI0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
    table[i] = 2 * cutoff * sinc * win;
  }
  kernelCache.set(key, table);
  return table;
}

// Cutoff as a fraction of the narrower rate. 0.45 (90 % of Nyquist) is the
// →16 kHz transcription design and stays the default. For PLAYBACK rate
// matching the transition band must sit above the audible edge: 0.4922 is
// 0.5 − Δf/2 for this kernel's transition width, and measured 48 k → 96 k it
// is 0.00 dB through 23 kHz with images ≤ −88 dB (lab: kaiser-cutoff.mjs).
export const PLAYBACK_CUTOFF_SCALE = 0.4922;

export function resample(input, inRate, outRate, { cutoffScale = 0.45 } = {}) {
  if (!input || !input.length) return new Float32Array(0);
  if (inRate === outRate) return input.slice();
  // Anti-alias below the narrower Nyquist, in cycles per INPUT sample.
  const cutoff = cutoffScale * Math.min(inRate, outRate) / inRate;
  const table = kernelTable(cutoff);
  const ratio = inRate / outRate;
  const outLen = Math.round(input.length * outRate / inRate);
  const out = new Float32Array(outLen);
  const n = input.length;

  for (let m = 0; m < outLen; m++) {
    const p = m * ratio;                            // exact input-time position
    const k0 = Math.max(0, Math.ceil(p - HALF_WIDTH));
    const k1 = Math.min(n - 1, Math.floor(p + HALF_WIDTH));
    let acc = 0;
    let wsum = 0;
    for (let k = k0; k <= k1; k++) {
      const d = Math.abs(k - p) * PHASES;
      let di = d | 0;
      if (di >= table.length - 1) di = table.length - 2; // kernel edge: clamp the interp pair
      const fr = d - di;
      const h = table[di] + (table[di + 1] - table[di]) * fr;
      acc += input[k] * h;
      wsum += h;
    }
    // Per-sample DC normalization: exact unity gain everywhere, including the
    // edges where the kernel is truncated. Interior wsum sits within ~1e-4 of 1,
    // so this is a droop fix, not a response change.
    out[m] = wsum !== 0 ? acc / wsum : 0;
  }
  return out;
}

export function resampleChannels(channels, inRate, outRate, opts) {
  return (channels || []).map((ch) => resample(ch, inRate, outRate, opts));
}
