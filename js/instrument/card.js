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
  cantilever: [1, 6.267, 17.55, 34.39, 56.84, 84.91],   // clamped-free
  membrane: [1, 1.594, 2.136, 2.296, 2.653, 2.918],     // ideal circular membrane
  plate: [1, 1.73, 2.33, 3.91, 4.11, 6.30],             // free circular plate, ν≈0.33
  bell: [1, 2, 2.4, 3, 4, 5],                           // hum, prime, tierce, quint, nominal, deciem
});
export const UNKNOWN_CONFIDENCE = 0.25;
export const UNKNOWN_DISTANCE = 0.03; // 3% mean log distance: not any family

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
  const sorted = modes.filter((m) => m.freqHz > 0).slice().sort((a, b) => a.freqHz - b.freqHz).slice(0, 6);
  if (sorted.length < 2) return { kind: 'unknown', confidence: 0, inharmonicity: 0, ratios: sorted.map(() => 1) };
  const f1 = sorted[0].freqHz;
  const ratios = sorted.map((m) => m.freqHz / f1);
  const scores = [];
  for (const [kind, ref] of Object.entries(FAMILY_RATIOS)) {
    if (kind === 'string') { const { B, err } = fitInharmonicity(ratios); scores.push({ kind, dist: err, B }); }
    else scores.push({ kind, dist: ratioDistance(ratios, ref), B: 0 });
  }
  scores.sort((a, b) => a.dist - b.dist);
  const best = scores[0], second = scores[1];
  const confidence = second.dist > 0 ? Math.max(0, 1 - best.dist / second.dist) : 0;
  const kind = confidence < UNKNOWN_CONFIDENCE || best.dist > UNKNOWN_DISTANCE ? 'unknown' : best.kind;
  return { kind, confidence, inharmonicity: kind === 'string' ? best.B : 0, ratios };
}

function residualPrint(residual, sampleRate) {
  const n = Math.min(residual.length, Math.round(0.1 * sampleRate));
  const out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(residual[i]));
  for (let i = 0; i < n; i++) out[i] = peak > 0 ? residual[i] / peak : 0;
  return { sampleRate, seconds: n / sampleRate, samples: Buffer.from(out.buffer, out.byteOffset, out.byteLength).toString('base64') };
}

export function residualSamples(card) {
  const buf = Buffer.from(card.residual.samples, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
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
  return card;
}
