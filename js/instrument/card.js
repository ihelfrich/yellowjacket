// Instrument card: a recorded found sound written as the table of numbers it
// is, plus the laws fitted to that table. Pure; no DOM, no randomness.
// Format and reference sets: js/instrument/card-format.md.

import { fitModal } from '../analysis/modal.js';
import { sha256HexSync } from '../loom/identity.js';

export const CARD_VERSION = 1;

// Ratios of the lowest modes to the lowest, Fletcher & Rossing (see card-format.md).
export const FAMILY_RATIOS = Object.freeze({
  string: [1, 2, 3, 4, 5, 6],
  bar: [1, 2.756, 5.404, 8.933, 13.34, 18.64],          // free-free Euler-Bernoulli
  // Measured, not derived: University of Iowa MIS orchestral bells C5–B5 in an
  // anechoic chamber, 24 cards over two mallets (2026-09-06). A tuning arch
  // lowers the fundamental more than the overtones, so every ratio sits above
  // the free bar's, and by an amount that varies bar to bar (3.1–3.3, 6.2–7.2
  // across one octave). So `bar` is fitted with one parameter, `arch`: 0 is the
  // free bar, 1 is this set, and the model interpolates the log-ratios.
  tunedBar: [1, 3.23, 6.99, 10.51, 15.75],
  cantilever: [1, 6.267, 17.55, 34.39, 56.84, 84.91],   // clamped-free
  membrane: [1, 1.594, 2.136, 2.296, 2.653, 2.918],     // ideal circular membrane
  plate: [1, 1.73, 2.33, 3.91, 4.11, 6.30],             // free circular plate, ν≈0.33
  bell: [1, 2, 2.4, 3, 4, 5],                           // hum, prime, tierce, quint, nominal, deciem
});
export const UNKNOWN_CONFIDENCE = 0.25;
export const UNKNOWN_DISTANCE = 0.03; // 3% mean log distance: not any family
export const RATIO_GATE_DB = 40; // modes this far under the strongest do not vote on the family
export const RATIO_GATE_Q = 0.05; // nor do modes with under this share of the longest-ringing mode's Q (a 33 ms thump is not a pitch)

/** The modes that count for pitch and family: within RATIO_GATE_DB of the strongest and not a mere transient beside the longest-ringing mode. */
export function votingModes(modes) {
  let top = 0, qMax = 0;
  for (const m of modes) if (m.freqHz > 0) { top = Math.max(top, m.amp || 0); qMax = Math.max(qMax, modeQ(m)); }
  const gate = top * Math.pow(10, -RATIO_GATE_DB / 20);
  const loud = modes.filter((m) => m.freqHz > 0 && (m.amp || 0) >= gate);
  const ringing = loud.filter((m) => modeQ(m) >= RATIO_GATE_Q * qMax);
  return ringing.length ? ringing : loud;
}

// Base64 without Buffer: the same card must build in node (tests, CLI) and in the bench.
function bytesToBase64(u8) {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') { const b = Buffer.from(b64, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
  const s = atob(b64), u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

function linearFit(xs, ys) {
  const n = xs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  const den = n * sxx - sx * sx;
  const slope = den !== 0 ? (n * sxy - sx * sy) / den : 0;
  const intercept = (sy - slope * sx) / n;
  const mean = sy / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) { const p = intercept + slope * xs[i]; ssRes += (ys[i] - p) ** 2; ssTot += (ys[i] - mean) ** 2; }
  return { slope, intercept, r2: ssTot > 0 ? 1 - ssRes / ssTot : 1 };
}

/** Q of a mode from its decay: Q = π f τ. */
export function modeQ(mode) { return Math.PI * mode.freqHz * mode.tauSec; }

/** Constant-Q or power-law Q(f), whichever the modes earn. */
export function fitDampingLaw(modes) {
  const usable = modes.filter((m) => m.freqHz > 0 && m.tauSec > 0);
  if (usable.length < 2) {
    const q0 = usable.length ? modeQ(usable[0]) : 100;
    return { model: 'constant-q', q0, exponent: 0, r2: 0 };
  }
  const logF = usable.map((m) => Math.log(m.freqHz));
  const logQ = usable.map((m) => Math.log(modeQ(m)));
  const meanLogQ = logQ.reduce((a, b) => a + b, 0) / logQ.length;
  let ssTot = 0;
  for (const v of logQ) ssTot += (v - meanLogQ) ** 2;
  const constant = { model: 'constant-q', q0: Math.exp(meanLogQ), exponent: 0, r2: ssTot > 0 ? 0 : 1 };
  const fit = linearFit(logF, logQ);
  const power = { model: 'power', q0: Math.exp(fit.intercept), exponent: fit.slope, r2: fit.r2 };
  // the power law always fits at least as well; prefer constant Q unless the exponent earns it
  return Math.abs(power.exponent) > 0.1 && power.r2 > 0.5 ? power : constant;
}

export function qAt(damping, hz) {
  return damping.model === 'power' ? damping.q0 * Math.pow(hz, damping.exponent) : damping.q0;
}

function ratioDistance(measured, reference) {
  // each measured ratio to its nearest reference ratio, mean |log| distance
  let sum = 0;
  for (const r of measured) {
    let best = Infinity;
    for (const ref of reference) best = Math.min(best, Math.abs(Math.log(r / ref)));
    sum += best;
  }
  return sum / measured.length;
}

/** Bar with a tuning arch: log-ratios interpolated between the free bar (arch 0) and the measured tuned set (arch 1), extrapolated a little either way. */
function archRatios(arch) {
  return FAMILY_RATIOS.bar.map((r, i) => Math.exp((1 - arch) * Math.log(r) + arch * Math.log(FAMILY_RATIOS.tunedBar[i] ?? r)));
}
function fitArch(ratios) {
  let best = { arch: 0, err: Infinity };
  for (let arch = -0.2; arch <= 1.4; arch += 0.02) {
    const err = ratioDistance(ratios, archRatios(arch));
    if (err < best.err) best = { arch: Math.round(arch * 100) / 100, err };
  }
  return best;
}

function fitInharmonicity(ratios) {
  // f_n / (n f_1) = sqrt(1 + B n^2) with the lowest mode as n = 1
  let best = { B: 0, err: Infinity };
  for (let B = 0; B <= 0.02; B += 0.00005) {
    let err = 0;
    for (const r of ratios) {
      const n = Math.max(1, Math.round(r));
      err += Math.abs(Math.log(r / (n * Math.sqrt((1 + B * n * n) / (1 + B)))));
    }
    if (err < best.err) best = { B, err: err / ratios.length };
  }
  return best;
}

/** Family from the ratios of the lowest six modes to the lowest. */
export function classifyFamily(modes) {
  // Only voting modes count: a −55 dB line at exactly 2·f0 (a preamp's second
  // harmonic on the Iowa bells), a junk fit at −60 dB, or a 33 ms thump under
  // a wine glass would otherwise become the "lowest mode" and the ratio set.
  const sorted = votingModes(modes).slice().sort((a, b) => a.freqHz - b.freqHz).slice(0, 6);
  if (sorted.length < 2) return { kind: 'unknown', confidence: 0, inharmonicity: 0, arch: 0, ratios: sorted.map(() => 1) };
  const f1 = sorted[0].freqHz;
  const ratios = sorted.map((m) => m.freqHz / f1);
  const scores = [];
  for (const [kind, ref] of Object.entries(FAMILY_RATIOS)) {
    if (kind === 'tunedBar') continue; // the arch end of `bar`, not a family of its own
    if (kind === 'bar') {
      // The arch is read from the first two overtones. Above them a real bar's
      // ratios also fall with its thickness (A5 on the Iowa set: 3.17 · 6.43 ·
      // 8.83 against C#5's 3.27 · 7.11 · 11.0), which one parameter cannot carry.
      const { arch, err } = fitArch(ratios.slice(0, 3));
      scores.push({ kind, dist: err, B: 0, arch });
      continue;
    }
    if (kind === 'string') {
      // A string is a comb: its lowest modes are consecutive harmonics. Ratios
      // like 1 : 3.2 : 7 : 10.5 fit "harmonics 1, 3, 7, 11" numerically and are
      // a bar, so the string hypothesis needs at least half its comb present.
      const { B, err } = fitInharmonicity(ratios);
      const indices = new Set(ratios.map((r) => Math.max(1, Math.round(r))));
      const coverage = indices.size / Math.max(...indices);
      scores.push({ kind, dist: coverage >= 0.5 ? err : Infinity, B, arch: 0 });
    }
    else scores.push({ kind, dist: ratioDistance(ratios, ref), B: 0, arch: 0 });
  }
  scores.sort((a, b) => a.dist - b.dist);
  const best = scores[0], second = scores[1];
  let confidence = second.dist > 0 ? Math.max(0, 1 - best.dist / second.dist) : 0;
  const kind = confidence < UNKNOWN_CONFIDENCE || best.dist > UNKNOWN_DISTANCE ? 'unknown' : best.kind;
  // Nearest-reference matching lets a measured ratio skip reference slots: a
  // wine glass at 1 : 6.9 : 9.9 matches a tuned bar's third and fourth modes
  // with its second missing, as does a bar card whose second partial the fitter
  // dropped. The label stays; the confidence carries the share of reference
  // slots (below the highest measured ratio) that a measured mode occupies.
  if (kind !== 'unknown' && kind !== 'string') {
    const ref = kind === 'bar' ? archRatios(best.arch) : FAMILY_RATIOS[kind];
    const topRatio = ratios[ratios.length - 1] * 1.1;
    const slots = ref.filter((r) => r <= topRatio);
    const matched = slots.filter((r) => ratios.some((m) => Math.abs(Math.log(m / r)) <= 0.05)).length;
    confidence *= slots.length ? matched / slots.length : 1;
  }
  return { kind, confidence, inharmonicity: kind === 'string' ? best.B : 0, arch: kind === 'bar' ? best.arch : 0, ratios };
}

/** The lowest mode that counts (see `votingModes`). */
export function fundamentalMode(modes) {
  let f = null;
  for (const m of votingModes(modes)) if (!f || m.freqHz < f.freqHz) f = m;
  return f;
}

function residualPrint(residual, sampleRate) {
  const n = Math.min(residual.length, Math.round(0.1 * sampleRate));
  const out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(residual[i]));
  for (let i = 0; i < n; i++) out[i] = peak > 0 ? residual[i] / peak : 0;
  return { sampleRate, seconds: n / sampleRate, samples: bytesToBase64(new Uint8Array(out.buffer, out.byteOffset, out.byteLength)) };
}

export function residualSamples(card) {
  const buf = base64ToBytes(card.residual.samples);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Heterodyne one mode: per frame, the complex mean of x·e^{-iωt} gives the
 * mode's amplitude and phase; the phase advance between frames gives its
 * instantaneous frequency. Frames of `frameSec`, hop half a frame.
 */
export function trackMode(samples, sampleRate, freqHz, { frameSec = 0.02 } = {}) {
  const frame = Math.max(8, Math.round(frameSec * sampleRate)), hop = Math.max(1, frame >> 1);
  const w = 2 * Math.PI * freqHz / sampleRate;
  const times = [], amps = [], freqs = [];
  let prevPhase = null, prevT = 0;
  for (let start = 0; start + frame <= samples.length; start += hop) {
    let re = 0, im = 0;
    for (let i = 0; i < frame; i++) {
      const win = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / frame);
      const v = samples[start + i] * win, ang = w * (start + i);
      re += v * Math.cos(ang); im -= v * Math.sin(ang);
    }
    // Hann window sums to frame/2; a sinusoid of amplitude a gives |mean| = a/2
    const amp = Math.hypot(re, im) * (2 / (0.5 * frame)), ph = Math.atan2(im, re), t = (start + frame / 2) / sampleRate;
    if (prevPhase !== null) {
      let d = ph - prevPhase;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      freqs.push(freqHz + d / (2 * Math.PI * (t - prevT))); amps.push(amp); times.push(t);
    }
    prevPhase = ph; prevT = t;
  }
  return { times, amps, freqs };
}

/** Per-mode frequency-versus-amplitude slope over the decay, kept only when it explains the drift. */
export function fitNonlinearity(samples, sampleRate, modes, { minR2 = 0.6, minHzPerAmp = 1, minCents = 12 } = {}) {
  const out = [];
  modes.forEach((m, index) => {
    const tr = trackMode(samples, sampleRate, m.freqHz);
    const peak = Math.max(0, ...tr.amps);
    const xs = [], ys = [];
    for (let i = 0; i < tr.amps.length; i++) if (tr.amps[i] > 0.05 * peak && tr.amps[i] < 0.95 * peak) { xs.push(tr.amps[i]); ys.push(tr.freqs[i]); }
    if (xs.length < 6) return;
    const fit = linearFit(xs, ys);
    // The law must move the pitch by a musical amount over the hit's own
    // amplitude range. On anechoic steel bars, linear to 0.0 cents between pp
    // and ff, weak modes still produced slopes with r² up to 0.96 that implied
    // at most 8.9 cents: tracker drift, not physics. 12 cents clears them.
    const impliedCents = Math.abs(1200 * Math.log2((m.freqHz + fit.slope * (Math.max(...xs) - Math.min(...xs))) / m.freqHz));
    if (fit.r2 >= minR2 && Math.abs(fit.slope) >= minHzPerAmp && impliedCents >= minCents) out.push({ mode: index, hzPerAmp: fit.slope, r2: fit.r2, cents: impliedCents });
  });
  return out;
}

/**
 * Build a card from a mono recording of one hit. Options: name, license,
 * note, maxModes (16), floorDb (-60). The nonlinearity law is attached only
 * when the hit's own decay supports it (`fitNonlinearity`).
 */
export function buildCard(samples, sampleRate, { name = 'untitled', license = '', note = '', maxModes = 16, floorDb = -60 } = {}) {
  const fit = fitModal(samples, sampleRate, { maxModes, floorDb });
  const modes = fit.modes
    .filter((m) => m.tauSec > 0 && m.amp > 0)
    .map((m) => ({ freqHz: m.freqHz, tauSec: m.tauSec, amp: m.amp, phase: m.phase }))
    .sort((a, b) => a.freqHz - b.freqHz);
  const dropped = fit.modes.length - modes.length;
  const card = {
    version: CARD_VERSION,
    id: sha256HexSync(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)).slice(0, 16),
    source: {
      name, sampleRate, seconds: samples.length / sampleRate, license,
      note: `${note ? note + ' ' : ''}${dropped ? dropped + ' modes dropped. ' : ''}fit ${fit.fitDb.toFixed(1)} dB.`,
    },
    modes,
    damping: fitDampingLaw(modes),
    family: classifyFamily(modes),
    residual: residualPrint(fit.residual, sampleRate),
  };
  const law = fitNonlinearity(samples, sampleRate, modes);
  if (law.length) card.nonlinearity = law;
  return card;
}
