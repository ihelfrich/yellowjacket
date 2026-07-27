// EQ (4 fixed-role bands) plus the standalone high-pass rack module.
// Both are kind:'nodes', built inside renderChain's OfflineAudioContext pass.
// Bands are IIRFilterNode sections whose coefficients are computed per
// sampleRate with the matched-filter method of Vicanek, "Matched Second Order
// Digital Filters" (2016): bilinear BiquadFilterNode shapes cramp toward
// Nyquist, matched coefficients track the analog prototypes there.
// BiquadFilterNode remains as the fallback when IIRFilterNode is unavailable.

const eqDefaults = {
  lsFreq: 200,
  lsGain: 0,
  p1Freq: 800,
  p1Gain: 0,
  p2Freq: 3000,
  p2Gain: 0,
  hsFreq: 8000,
  hsGain: 0
};

const highpassDefaults = {
  freq: 80
};

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function configValue(cfg, key, defaults) {
  const raw = cfg?.params?.[key] ?? cfg?.[key] ?? defaults[key];
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaults[key];
}

// Impulse-invariant pole pair for the prototype s^2 + 2*q*w0*s + w0^2,
// w0 in rad/sample (Vicanek 2016 eq 12).
function polePair(w0, q) {
  const e = Math.exp(-q * w0);
  const a1 = q <= 1
    ? -2 * e * Math.cos(Math.sqrt(1 - q * q) * w0)
    : -2 * e * Math.cosh(Math.sqrt(q * q - 1) * w0);
  return { a1, a2: e * e };
}

// phi0/phi1/phi2 basis for |H(z)|^2 on the unit circle (eq 26).
function phi(w) {
  const p1 = Math.sin(w / 2) ** 2;
  const p0 = 1 - p1;
  return { p0, p1, p2: 4 * p0 * p1 };
}

// Minimum-phase numerator [b0,b1,b2] from squared-response B0,B1,B2 (eq 29).
function numeratorFromSquares(B0, B1, B2) {
  const r0 = Math.sqrt(B0);
  const r1 = Math.sqrt(B1);
  const w = 0.5 * (r0 + r1);
  const b0 = 0.5 * (w + Math.sqrt(Math.max(w * w + B2, 0)));
  return [b0, 0.5 * (r0 - r1), -B2 / (4 * b0)];
}

// Matched peaking band: analog prototype eq 42, poles from eq 12 with
// q = 1/(2*sqrt(G)*Q), numerator solved per eqs 43-45. Unity at DC, exact
// gain G at f0, no cramping at Nyquist.
export function matchedPeaking(sampleRate, f0, gainDb, Q) {
  const rootG = Math.pow(10, gainDb / 40);
  const G2 = Math.pow(10, gainDb / 10);
  const w0 = 2 * Math.PI * f0 / sampleRate;
  const { a1, a2 } = polePair(w0, 1 / (2 * rootG * Q));
  const A0 = (1 + a1 + a2) ** 2;
  const A1 = (1 - a1 + a2) ** 2;
  const A2 = -4 * a2;
  const { p0, p1, p2 } = phi(w0);
  const R1 = (A0 * p0 + A1 * p1 + A2 * p2) * G2;
  const R2 = (-A0 + A1 + 4 * (p0 - p1) * A2) * G2;
  const B0 = A0;
  const B2 = (R1 - R2 * p1 - B0) / (4 * p1 * p1);
  const B1 = R2 + B0 + 4 * (p1 - p0) * B2;
  return { feedforward: numeratorFromSquares(B0, B1, B2), feedback: [1, a1, a2] };
}

// |H(i*x*w0)|^2 of the RBJ slope-1 shelf prototype (the shape BiquadFilterNode
// targets), A = 10^(dB/40), section quality 1/sqrt(2).
function shelfMag2(x, A, high) {
  const x2 = x * x;
  const inner = (A - x2) ** 2 + 2 * A * x2;
  const outer = (1 - A * x2) ** 2 + 2 * A * x2;
  return high ? (A * A * outer) / inner : (A * A * inner) / outer;
}

// Matched shelf: impulse-invariant poles of the shelf prototype (pole pair at
// w0*A^(-/+1/2), q = 1/(2*(1/sqrt2)) = sqrt(1/2)), then B0,B1,B2 fixed by
// matching |H|^2 at DC, f0 and Nyquist — the Vicanek 2016 section 4 scheme
// with eq 29 recovering the numerator.
export function matchedShelf(sampleRate, f0, gainDb, high) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * f0 / sampleRate;
  // Cap keeps the mapped pole pair meaningful at degenerate sample rates.
  const wp = Math.min(high ? w0 * Math.sqrt(A) : w0 / Math.sqrt(A), Math.PI * 0.98);
  const { a1, a2 } = polePair(wp, Math.SQRT1_2);
  const A0 = (1 + a1 + a2) ** 2;
  const A1 = (1 - a1 + a2) ** 2;
  const A2 = -4 * a2;
  const { p0, p1, p2 } = phi(w0);
  const B0 = A0 * shelfMag2(0, A, high);
  const B1 = A1 * shelfMag2(Math.PI / w0, A, high);
  const R1 = (A0 * p0 + A1 * p1 + A2 * p2) * shelfMag2(1, A, high);
  const B2 = (R1 - B0 * p0 - B1 * p1) / p2;
  return { feedforward: numeratorFromSquares(B0, B1, B2), feedback: [1, a1, a2] };
}

// True 4th-order Butterworth pole-pair Qs: 1/(2cos(pi/8)), 1/(2cos(3pi/8)).
// Two 0.707 sections are NOT Butterworth (double -3 dB dip at the corner).
export const BUTTERWORTH4_Q = [0.541196, 1.306563];

// RBJ bilinear high-pass sections at the Butterworth Qs; the corner sits well
// below Nyquist so bilinear warp is negligible and the -3.01 dB point exact.
export function butterworthHighpass(sampleRate, f0) {
  const w0 = 2 * Math.PI * f0 / sampleRate;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / 2;
  return BUTTERWORTH4_Q.map((q) => {
    const a0 = 1 + alpha / q;
    const b0 = (1 + cw) / (2 * a0);
    return {
      feedforward: [b0, -2 * b0, b0],
      feedback: [1, -2 * cw / a0, (1 - alpha / q) / a0]
    };
  });
}

function eqParams(sampleRate, cfg) {
  const cap = (f) => Math.min(f, sampleRate * 0.475);
  return {
    lsFreq: cap(clamp(configValue(cfg, 'lsFreq', eqDefaults), 60, 500)),
    lsGain: clamp(configValue(cfg, 'lsGain', eqDefaults), -12, 12),
    p1Freq: cap(clamp(configValue(cfg, 'p1Freq', eqDefaults), 200, 2000)),
    p1Gain: clamp(configValue(cfg, 'p1Gain', eqDefaults), -12, 12),
    p2Freq: cap(clamp(configValue(cfg, 'p2Freq', eqDefaults), 1000, 8000)),
    p2Gain: clamp(configValue(cfg, 'p2Gain', eqDefaults), -12, 12),
    hsFreq: cap(clamp(configValue(cfg, 'hsFreq', eqDefaults), 4000, 12000)),
    hsGain: clamp(configValue(cfg, 'hsGain', eqDefaults), -12, 12)
  };
}

function buildEqBiquad(ctx, p) {
  const ls = ctx.createBiquadFilter();
  ls.type = 'lowshelf';
  ls.frequency.value = p.lsFreq;
  ls.gain.value = p.lsGain;

  const p1 = ctx.createBiquadFilter();
  p1.type = 'peaking';
  p1.frequency.value = p.p1Freq;
  p1.gain.value = p.p1Gain;
  p1.Q.value = 1.0;

  const p2 = ctx.createBiquadFilter();
  p2.type = 'peaking';
  p2.frequency.value = p.p2Freq;
  p2.gain.value = p.p2Gain;
  p2.Q.value = 1.0;

  const hs = ctx.createBiquadFilter();
  hs.type = 'highshelf';
  hs.frequency.value = p.hsFreq;
  hs.gain.value = p.hsGain;

  ls.connect(p1);
  p1.connect(p2);
  p2.connect(hs);
  return { input: ls, output: hs };
}

export function buildEq(ctx, cfg = {}) {
  const p = eqParams(ctx.sampleRate, cfg);
  if (typeof ctx.createIIRFilter !== 'function') return buildEqBiquad(ctx, p);
  const nodes = [
    matchedShelf(ctx.sampleRate, p.lsFreq, p.lsGain, false),
    matchedPeaking(ctx.sampleRate, p.p1Freq, p.p1Gain, 1.0),
    matchedPeaking(ctx.sampleRate, p.p2Freq, p.p2Gain, 1.0),
    matchedShelf(ctx.sampleRate, p.hsFreq, p.hsGain, true)
  ].map((c) => ctx.createIIRFilter(c.feedforward, c.feedback));
  for (let i = 1; i < nodes.length; i++) nodes[i - 1].connect(nodes[i]);
  return { input: nodes[0], output: nodes[nodes.length - 1] };
}

function buildHighpassBiquad(ctx, freq) {
  // BiquadFilterNode interprets lowpass/highpass Q in dB (WebAudio spec),
  // so the Butterworth section Qs go in as 20*log10(Q).
  const [qa, qb] = BUTTERWORTH4_Q;
  const a = ctx.createBiquadFilter();
  a.type = 'highpass';
  a.frequency.value = freq;
  a.Q.value = 20 * Math.log10(qa);

  const b = ctx.createBiquadFilter();
  b.type = 'highpass';
  b.frequency.value = freq;
  b.Q.value = 20 * Math.log10(qb);

  a.connect(b);
  return { input: a, output: b };
}

export function buildHighpass(ctx, cfg = {}) {
  const freq = Math.min(
    clamp(configValue(cfg, 'freq', highpassDefaults), 20, 300),
    ctx.sampleRate * 0.475
  );
  if (typeof ctx.createIIRFilter !== 'function') return buildHighpassBiquad(ctx, freq);
  const [a, b] = butterworthHighpass(ctx.sampleRate, freq)
    .map((c) => ctx.createIIRFilter(c.feedforward, c.feedback));
  a.connect(b);
  return { input: a, output: b };
}

export const eq = {
  id: 'eq',
  title: 'EQ',
  tagline: 'Four bands, fixed Q. Shape the voice.',
  kind: 'nodes',
  defaults: eqDefaults,
  params: [
    { key: 'lsFreq', label: 'LOW SHELF', unit: 'Hz', min: 60, max: 500, step: 5, def: 200 },
    { key: 'lsGain', label: 'LS GAIN', unit: 'dB', min: -12, max: 12, step: 0.5, def: 0 },
    { key: 'p1Freq', label: 'PEAK 1', unit: 'Hz', min: 200, max: 2000, step: 10, def: 800 },
    { key: 'p1Gain', label: 'P1 GAIN', unit: 'dB', min: -12, max: 12, step: 0.5, def: 0 },
    { key: 'p2Freq', label: 'PEAK 2', unit: 'Hz', min: 1000, max: 8000, step: 50, def: 3000 },
    { key: 'p2Gain', label: 'P2 GAIN', unit: 'dB', min: -12, max: 12, step: 0.5, def: 0 },
    { key: 'hsFreq', label: 'HIGH SHELF', unit: 'Hz', min: 4000, max: 12000, step: 100, def: 8000 },
    { key: 'hsGain', label: 'HS GAIN', unit: 'dB', min: -12, max: 12, step: 0.5, def: 0 }
  ],
  build: buildEq
};

export const highpassDesc = {
  id: 'highpass',
  title: 'HIGH-PASS',
  tagline: 'Rumble and desk thumps. Cut at the corner.',
  kind: 'nodes',
  defaults: highpassDefaults,
  params: [
    { key: 'freq', label: 'CORNER', unit: 'Hz', min: 20, max: 300, step: 5, def: 80 }
  ],
  build: buildHighpass
};

export default eq;

export { eq as descriptor };
