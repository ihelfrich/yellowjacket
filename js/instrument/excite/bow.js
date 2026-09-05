// Bow: stick-slip friction on the mode bank (after McIntyre, Schumacher and
// Woodhouse). The string's velocity at the bow point is read off the bank;
// the friction force follows a curve in the relative velocity — a static peak
// and a falling sliding branch — so the string sticks to the bow, is carried,
// breaks free, and is caught again. The falling branch is what injects energy
// (force rising with string velocity is negative damping); stable sustain,
// crescendo with force and misbehaviour at too little or too much force are
// consequences of the curve, not settings. Deterministic.

import { modesAt, modeShape } from '../family.js';

const MU_STATIC = 0.8, MU_DYNAMIC = 0.3, V0 = 0.1;
// Force scale: with each resonator normalised to peak at amp/2 per unit force,
// the loop gain at a typical relative velocity is about 0.14 × force × 1/amp₀;
// bowed at 0.12 of the length the fundamental couples through shape² ≈ 0.135, so this
// scale puts force = 0.3 near a loop gain of 2 and force = 0.6 near 4, after the hair filter below.
const FORCE_SCALE = 200;

function friction(vRel) { // signed coefficient: static peak at rest, falling with sliding speed
  const s = Math.sign(vRel) || 1, a = Math.abs(vRel);
  return s * (MU_DYNAMIC + (MU_STATIC - MU_DYNAMIC) * V0 / (V0 + a));
}

export function bow(card, { pitchHz, force = 0.3, speed = 0.2, position = 0.12, seconds = 2, sampleRate = 96000 } = {}) {
  const modes = modesAt(card, pitchHz, { position: null, hardness: 1 }).filter((m) => m.amp > 0);
  const n = Math.round(seconds * sampleRate), out = new Float32Array(n);
  const family = card.family.kind === 'unknown' ? 'string' : card.family.kind;
  const amp0 = modes.length ? modes[0].amp : 1;
  const sin0 = Math.sin(2 * Math.PI * (modes.length ? modes[0].freqHz : pitchHz) / sampleRate) || 1e-6;
  // Gains are normalised by the FUNDAMENTAL's damping only, so each mode keeps
  // its physical peak (amp × decay time) relative to the others: the fundamental
  // wins the mode competition by its Q, as it does on a real string.
  const r0 = Math.exp(-1 / ((modes.length ? modes[0].tauSec : 1) * sampleRate));
  const state = modes.map((m, i) => {
    const w = 2 * Math.PI * m.freqHz / sampleRate, r = Math.exp(-1 / (m.tauSec * sampleRate));
    const shape = Math.max(1e-3, modeShape(family, i, position));
    return { a1: 2 * r * Math.cos(w), r2: r * r, g: m.amp * Math.sin(w) * (1 - r0) * shape, shape, y1: 0, y2: 0 };
  });
  const ramp = Math.max(1, Math.round(0.05 * sampleRate));
  const F = force * FORCE_SCALE / Math.max(1e-3, amp0);
  // Bow hair is compliant and a bow has width: the string velocity the hair
  // actually feels is low-passed, here by a one-pole at 1.2 × the fundamental.
  // Without it velocity feedback (∝ ω) hands the note to a higher mode.
  const hairK = 1 - Math.exp(-2 * Math.PI * 1.2 * (modes.length ? modes[0].freqHz : pitchHz) / sampleRate);
  let vString = 0, vHair = 0;
  for (let i = 0; i < n; i++) {
    const on = Math.min(1, i / ramp);
    const vRel = speed * on - vString;
    const x = F * on * friction(vRel);              // friction force at the bow point
    let y = 0, v = 0;
    for (const st of state) {
      const yi = st.a1 * st.y1 - st.r2 * st.y2 + st.g * x;
      v += (yi - st.y1) * st.shape;                 // velocity at the bow point, mode by mode
      st.y2 = st.y1; st.y1 = yi; y += yi;
    }
    vHair += (v / sin0 - vHair) * hairK;             // normalised so a unit-amplitude mode reads as unit velocity
    vString = vHair;
    out[i] = y;
  }
  return out;
}

/** Force range in which a 1 s note at 16 kHz holds a steady level (±10 % over its second half). */
export function stableForceRange(card, { pitchHz = 220 } = {}) {
  const sr = 16000, forces = [0.05, 0.1, 0.2, 0.3, 0.45, 0.6, 0.8, 1.0];
  const ok = [];
  for (const f of forces) {
    const y = bow(card, { pitchHz, force: f, seconds: 1, sampleRate: sr });
    const rms = (a, b) => { let s = 0, c = 0; for (let i = Math.round(a * sr); i < Math.round(b * sr); i++) { s += y[i] * y[i]; c++; } return Math.sqrt(s / c); };
    const r1 = rms(0.5, 0.75), r2 = rms(0.75, 1.0);
    if (r1 > 0.02 && Math.abs(r1 - r2) / r1 < 0.1) ok.push(f);
  }
  return ok.length ? { min: Math.min(...ok), max: Math.max(...ok) } : { min: 0, max: 0 };
}
