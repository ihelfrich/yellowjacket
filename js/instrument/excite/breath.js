// Breath: a jet through a cubic pressure-to-flow law drives the bank, and the
// bank's output feeds back into the jet (Cook's blown-bottle family). The
// turbulence noise is the card's own residual print plus a seeded xorshift.
// Deterministic; no Math.random.

import { modesAt } from '../family.js';
import { residualSamples } from '../card.js';

// The jet's flow saturates at this drive swing; with the feedback drive of 24/amp₀ the
// sustained fundamental settles near a quarter of the card amplitude.
const SAT = 6;

export function breath(card, { pitchHz, pressure = 0.6, noise = 0.05, seconds = 2, sampleRate = 96000, feedback = 0.9, drive = null, seed = 1 } = {}) {
  const modes = modesAt(card, pitchHz, { position: null, hardness: 0.3 }).filter((m) => m.amp > 0);
  // Loop gain: each resonator peaks at amp/2 for unit drive once g is normalised below, so a
  // feedback drive of 24/amp₀ gives the fundamental a small-signal loop gain near 6 at moderate pressure and
  // just under 1 at very low pressure, which is the threshold below which a blown instrument does not speak —
  // enough to start from the turbulence and be limited by the jet's saturation, not by growth.
  const amp0 = modes.length ? modes[0].amp : 1;
  const fbDrive = drive ?? 24 / Math.max(1e-3, amp0);
  const n = Math.round(seconds * sampleRate), out = new Float32Array(n);
  // the object's own contact noise; spectral cards carry none, so they breathe on the seeded noise alone
  const stored = card.residual && card.residual.samples ? residualSamples(card) : new Float32Array(0);
  const print = stored.length ? stored : new Float32Array(1), printLen = print.length;
  // Gains are normalised by the FUNDAMENTAL's damping only, so every mode keeps
  // its physical peak (amp × decay time) relative to the others and the
  // fundamental wins the mode competition by its Q.
  const r0 = Math.exp(-1 / ((modes.length ? modes[0].tauSec : 1) * sampleRate));
  const state = modes.map((m) => {
    const w = 2 * Math.PI * m.freqHz / sampleRate, r = Math.exp(-1 / (m.tauSec * sampleRate));
    return { a1: 2 * r * Math.cos(w), r2: r * r, g: m.amp * Math.sin(w) * (1 - r0), y1: 0, y2: 0 };
  });
  const ramp = Math.max(1, Math.round(0.03 * sampleRate));
  // The jet feeds on the bank's VELOCITY, in phase with the force at resonance:
  // positive velocity feedback is negative damping, which is what makes a blown
  // resonator speak. Displacement feedback lags by 90° at the peak and cannot.
  // The derivative is normalised by the fundamental's angular rate so the loop
  // gain does not depend on the sample rate. The drive is DC-blocked (20 Hz).
  const dcK = 2 * Math.PI * 20 / sampleRate;
  const sin0 = Math.sin(2 * Math.PI * (modes.length ? modes[0].freqHz : pitchHz) / sampleRate) || 1e-6;
  let fb = 0, yPrev = 0, lpx = 0, s = (seed >>> 0) || 1;
  for (let i = 0; i < n; i++) {
    const p = pressure * Math.min(1, i / ramp);
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    const turb = noise * p * (print[i % printLen] * 0.7 + (((s >>> 0) / 4294967296) * 2 - 1) * 0.3);
    let u = p + fb;                            // positive feedback: the loop locks where the resonator peaks
    u = Math.max(-SAT, Math.min(SAT, u));
    const flow = (u - u * u * u / (3 * SAT * SAT)) + turb;  // jet flow: linear near rest, saturating at |u| = SAT
    lpx += (flow - lpx) * dcK;
    const x = p * (flow - lpx);                 // only the fluctuating flow excites the modes, in proportion to pressure
    let y = 0;
    for (const st of state) { const v = st.a1 * st.y1 - st.r2 * st.y2 + st.g * x; st.y2 = st.y1; st.y1 = v; y += v; }
    const vel = (y - yPrev) / sin0;
    yPrev = y;
    fb = feedback * Math.max(-SAT, Math.min(SAT, vel * fbDrive));
    out[i] = y;
  }
  return out;
}
