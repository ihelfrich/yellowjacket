// Noise that is not white, for the tests that ask an estimator to refuse.
//
// Every refusal test written so far used flat white Gaussian from one
// generator, and that is the single colour under which the analytic nulls
// these modules derive actually hold: two Goertzel arms over white noise are
// iid exponential, a per-arm gain has no tilt to invent, and a percentile floor
// over frequency is flat. Real HF is none of those things. On the colours
// below, modules that refused 100% of white noise were measured answering
// between 2% and 62% of the time.
//
// The generators are deterministic in their seed and each one is checked by
// `describe()` against the property it exists to have, so a test that passes
// because the "pink" noise was accidentally white cannot go unnoticed.

/** Deterministic uniform PRNG. Same seed, same stream, on any machine. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  const u = Math.max(1e-12, rand()), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Flat Gaussian. The easy case, kept so the others can be compared with it. */
export function white(n, { sigma = 0.05, seed = 1 } = {}) {
  const r = mulberry32(seed), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = sigma * gaussian(r);
  return out;
}

/**
 * 1/f by Voss-McCartney: sixteen octave-spaced random holds summed, each
 * updated half as often as the last. Atmospheric noise on the low bands is
 * close to this, and a floor estimated flat across frequency mistakes its tilt
 * for a signal at the bottom of the band.
 */
export function pink(n, { sigma = 0.05, seed = 2, rows = 16 } = {}) {
  const r = mulberry32(seed), out = new Float32Array(n);
  const held = new Float64Array(rows);
  for (let i = 0; i < rows; i++) held[i] = gaussian(r);
  let running = held.reduce((p, c) => p + c, 0);
  for (let i = 0; i < n; i++) {
    // the lowest set bit says which row is due an update this sample
    const k = i === 0 ? 0 : Math.min(rows - 1, 31 - Math.clz32(i & -i));
    running -= held[k];
    held[k] = gaussian(r);
    running += held[k];
    out[i] = sigma * running / Math.sqrt(rows);
  }
  return out;
}

/**
 * Rayleigh fading: white noise under the envelope of a complex Gaussian
 * low-passed to a few hertz, which is what a multipath HF channel does to
 * anything travelling through it. The deep nulls are the point — an estimator
 * that calibrates a per-arm gain during one sees a tilt that is not there.
 */
export function faded(n, { sigma = 0.05, seed = 3, fadeHz = 0.4, rate = 8000, depth = 0.95 } = {}) {
  const r = mulberry32(seed), out = new Float32Array(n);
  // Two low-passed Gaussian processes as the quadrature components. Their
  // amplitude depends on the filter's own gain, so the envelope is built first
  // and scaled by its measured mean: normalising by an analytic gain instead
  // produced an envelope near zero, a constant output, and 0.3 dB of "fading".
  const a = 2 * Math.PI * fadeHz / rate;
  const k = a / (a + 1);
  const env = new Float64Array(n);
  let re = 0, im = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    re += k * (gaussian(r) - re);
    im += k * (gaussian(r) - im);
    env[i] = Math.hypot(re, im);
    sum += env[i];
  }
  const mean = sum / n || 1;
  for (let i = 0; i < n; i++) {
    // Rayleigh about a mean of 1, then squeezed into [1-depth, 1+something]
    const e = Math.min(2.5, env[i] / mean);
    out[i] = sigma * (1 - depth + depth * e) * gaussian(r);
  }
  return out;
}

/**
 * Atmospheric crashes: white noise plus decaying ringing bursts at Poisson
 * positions. A burst shorter than an analysis frame becomes its own noise floor
 * and hides itself, which is how impulsive noise gets reported as an emission.
 */
export function impulsive(n, { sigma = 0.03, seed = 4, perSecond = 12, rate = 8000, gain = 40 } = {}) {
  const r = mulberry32(seed), out = white(n, { sigma, seed: seed + 991 });
  const count = Math.max(1, Math.round(perSecond * n / rate));
  for (let c = 0; c < count; c++) {
    const at = Math.floor(r() * n);
    const ring = 200 + r() * 2600;
    const tau = 0.002 + r() * 0.006;
    const len = Math.min(n - at, Math.round(6 * tau * rate));
    const amp = sigma * gain * (0.4 + r());
    for (let i = 0; i < len; i++) {
      out[at + i] += amp * Math.exp(-i / (tau * rate)) * Math.cos(2 * Math.PI * ring * i / rate);
    }
  }
  return out;
}

/**
 * White noise gated on and off in bursts, the shape of a busy band where
 * something keys nearby. It has structure in time and none in frequency, which
 * is exactly what a symbol-rate estimator is looking for.
 */
export function bursty(n, { sigma = 0.05, seed = 5, rate = 8000, onHz = 6 } = {}) {
  const r = mulberry32(seed), out = new Float32Array(n);
  const period = Math.max(2, Math.round(rate / onHz));
  let on = true, next = Math.round(period * (0.3 + r()));
  for (let i = 0; i < n; i++) {
    if (i >= next) { on = !on; next = i + Math.round(period * (0.3 + r())); }
    out[i] = (on ? sigma : sigma * 0.05) * gaussian(r);
  }
  return out;
}

export const COLOURS = Object.freeze({ white, pink, faded, impulsive, bursty });

/** Every colour at one seed, for a test that wants to sweep them all. */
export function everyColour(n, seed, opts = {}) {
  return Object.entries(COLOURS).map(([name, gen]) => ({ name, x: gen(n, { ...opts, seed }) }));
}

// ---------- the checks that keep these honest ----------

function bandPower(x, rate, lo, hi) {
  // one Goertzel-ish sum per band edge is not enough; a coarse periodogram is
  let p = 0;
  const n = Math.min(x.length, 1 << 14);
  const step = Math.max(1, Math.round((hi - lo) / 24));
  for (let f = lo; f < hi; f += step) {
    let re = 0, im = 0;
    const w = 2 * Math.PI * f / rate;
    for (let i = 0; i < n; i++) { re += x[i] * Math.cos(w * i); im += x[i] * Math.sin(w * i); }
    p += (re * re + im * im) / (n * n);
  }
  return p;
}

/** Kurtosis, which is 3 for a Gaussian and much larger for crashes. */
export function kurtosis(x) {
  let m = 0;
  for (const v of x) m += v;
  m /= x.length;
  let s2 = 0, s4 = 0;
  for (const v of x) { const d = v - m; s2 += d * d; s4 += d * d * d * d; }
  s2 /= x.length; s4 /= x.length;
  return s2 ? s4 / (s2 * s2) : 0;
}

/** The swing in short-term level, in dB — how deep the fades go. */
export function levelSwingDb(x, rate, windowSec = 0.25) {
  const W = Math.max(8, Math.round(windowSec * rate));
  const levels = [];
  for (let at = 0; at + W <= x.length; at += W) {
    let s = 0;
    for (let i = 0; i < W; i++) s += x[at + i] * x[at + i];
    levels.push(Math.sqrt(s / W));
  }
  levels.sort((a, b) => a - b);
  const lo = levels[Math.floor(levels.length * 0.1)] || 1e-12;
  const hi = levels[Math.floor(levels.length * 0.9)] || 1e-12;
  return 20 * Math.log10(hi / lo);
}

/**
 * What each colour actually is, measured rather than asserted: the tilt across
 * the band in dB per decade, the kurtosis, and the level swing. A test can
 * assert on these so a generator that quietly turns white is caught.
 */
export function describe(x, rate = 8000) {
  const low = bandPower(x, rate, 100, 300);
  const high = bandPower(x, rate, 1000, 3000);
  const decades = Math.log10(2000 / 200);
  return {
    tiltDbPerDecade: 10 * Math.log10(high / low) / decades,
    kurtosis: kurtosis(x),
    swingDb: levelSwingDb(x, rate),
  };
}
