// Tuning: retune a card's modes to a target spectrum (stored as a delta, the
// physical card untouched), and read the scale a timbre is most consonant
// in from its own partials (W. Sethares, Tuning, Timbre, Spectrum, Scale, 1998).

const JUST = [1, 9 / 8, 5 / 4, 4 / 3, 3 / 2, 5 / 3, 15 / 8, 2, 9 / 4, 5 / 2, 8 / 3, 3, 10 / 3, 15 / 4, 4, 9 / 2, 5, 16 / 3, 6];

function targetRatios(target, count) {
  if (Array.isArray(target)) return target;
  if (target === 'harmonic') return Array.from({ length: Math.max(count, 24) }, (_, i) => i + 1);
  if (target === 'just') return JUST.slice(0, Math.max(count, JUST.length));
  throw new Error('unknown retune target ' + target);
}

/** Cents to move each mode so its ratio to the lowest matches the nearest target ratio. */
export function retuneDelta(card, target) {
  const f1 = card.modes[0].freqHz;
  const ratios = targetRatios(target, card.modes.length);
  const cents = card.modes.map((m) => {
    const r = m.freqHz / f1;
    let best = ratios[0];
    for (const t of ratios) if (Math.abs(Math.log(r / t)) < Math.abs(Math.log(r / best))) best = t;
    return 1200 * Math.log2(best / r);
  });
  return { target: Array.isArray(target) ? 'custom' : target, cents };
}

/** A new card with the delta applied; the input card is not modified. */
export function applyRetune(card, delta) {
  return {
    ...card,
    modes: card.modes.map((m, i) => ({ ...m, freqHz: m.freqHz * Math.pow(2, (delta.cents[i] || 0) / 1200) })),
    retune: delta,
  };
}

// Sethares' pairwise roughness of two partials
function roughness(f1, a1, f2, a2) {
  const fmin = Math.min(f1, f2), s = 0.24 / (0.021 * fmin + 19), x = Math.abs(f2 - f1);
  return a1 * a2 * (Math.exp(-3.5 * s * x) - Math.exp(-5.75 * s * x));
}

/** Total roughness of the timbre against itself transposed by each ratio. */
export function dissonanceCurve(modes, { steps = 600, maxRatio = 2.05 } = {}) {
  const parts = modes.filter((m) => m.freqHz > 0 && m.amp > 0);
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const ratio = Math.pow(maxRatio, i / steps);
    let d = 0;
    for (const a of parts) for (const b of parts) d += roughness(a.freqHz, a.amp, b.freqHz * ratio, b.amp);
    out.push({ ratio, cents: 1200 * Math.log2(ratio), roughness: d });
  }
  return out;
}

/** Local minima of the dissonance curve within (1, 2], the timbre's own scale. */
export function relatedScale(modes, opts = {}) {
  const curve = dissonanceCurve(modes, opts);
  const scale = [];
  for (let i = 1; i < curve.length - 1; i++) {
    if (curve[i].ratio <= 1.01 || curve[i].ratio > 2.005) continue;
    if (curve[i].roughness < curve[i - 1].roughness && curve[i].roughness <= curve[i + 1].roughness) scale.push({ ratio: curve[i].ratio, cents: curve[i].cents });
  }
  return scale;
}
