// One card, a whole family: the mode table at any pitch, struck anywhere,
// with any mallet, by the object's own laws rather than by shifting audio.

import { qAt } from './card.js';

export function cardPitchHz(card) { return card.modes.length ? card.modes[0].freqHz : 440; }

/** Hertz contact time from hardness 0 (8 ms, felt) to 1 (0.2 ms, steel), log-mapped. */
export function contactTimeSec(hardness) {
  const h = Math.max(0, Math.min(1, hardness));
  return 0.008 * Math.pow(0.025, h);
}

/**
 * Weight a mode receives from a force pulse of contact time tauC: the lobe
 * envelope of a half-sine's spectrum, 1 at DC and falling 12 dB per octave
 * above 1/(2 tauC). The exact half-sine spectrum has nulls that would make
 * hardness non-monotonic; real contacts are not exact half-sines, and the
 * envelope is what the ensemble of them shares.
 */
export function halfSineWeight(freqHz, tauC) {
  const x = 2 * freqHz * tauC;
  return 1 / (1 + x * x);
}

const FREE_BAR_BETA = [4.730, 7.853, 10.996, 14.137, 17.279, 20.420];
const BESSEL_ZEROS = [2.405, 5.520, 8.654];

function j0(x) {
  let term = 1, sum = 1;
  for (let k = 1; k < 40; k++) { term *= -(x * x) / (4 * k * k); sum += term; if (Math.abs(term) < 1e-12) break; }
  return sum;
}

function freeBarShape(n, p) {
  const b = FREE_BAR_BETA[n] ?? (2 * n + 3) * Math.PI / 2, x = b * p;
  const sigma = (Math.cosh(b) - Math.cos(b)) / (Math.sinh(b) - Math.sin(b));
  const phi = Math.cosh(x) + Math.cos(x) - sigma * (Math.sinh(x) + Math.sin(x));
  const end = 2; // free-free beam shapes are ±2 at the free ends when normalised this way
  return Math.min(1, Math.abs(phi) / end);
}

/**
 * Mode-shape magnitude at position p in [0, 1] for mode `index` (0 = lowest).
 * Strings: |sin((n+1)πp)|. Bars: free-free beam shapes. Membranes and plates:
 * J0 at the axisymmetric modes (indices 0, 3, 5 in the reference set), 1
 * elsewhere, p read as normalised radius. Unknown: 1.
 */
export function modeShape(family, index, p) {
  const pos = Math.max(0, Math.min(1, p));
  switch (family) {
    case 'string': return Math.abs(Math.sin((index + 1) * Math.PI * pos));
    case 'bar': case 'cantilever': return freeBarShape(index, pos);
    case 'membrane': case 'plate': { const k = [0, 3, 5].indexOf(index); return k < 0 ? 1 : Math.abs(j0(BESSEL_ZEROS[k] * pos)); }
    default: return 1;
  }
}

/**
 * The card's modes at `pitchHz`: frequencies by the family's scaling law,
 * decays from the damping law, amplitudes weighted by strike position and
 * mallet hardness. `weight` records position×hardness for the metadata.
 */
export function modesAt(card, pitchHz, { position = null, hardness = 0.5 } = {}) {
  const f1 = cardPitchHz(card), scale = pitchHz / f1;
  const tauC = contactTimeSec(hardness);
  const B = card.family.inharmonicity || 0;
  return card.modes.map((m, index) => {
    let freqHz;
    if (card.family.kind === 'string' && B > 0) {
      const n = Math.max(1, Math.round(m.freqHz / f1));
      const B2 = B * scale * scale;
      freqHz = n * pitchHz * Math.sqrt((1 + B2 * n * n) / (1 + B2));
    } else freqHz = m.freqHz * scale;
    const tauSec = qAt(card.damping, freqHz) / (Math.PI * freqHz);
    const shape = position === null ? 1 : modeShape(card.family.kind, index, position);
    const weight = shape * halfSineWeight(freqHz, tauC);
    return { freqHz, tauSec, amp: m.amp * weight, phase: m.phase, index, weight };
  });
}
