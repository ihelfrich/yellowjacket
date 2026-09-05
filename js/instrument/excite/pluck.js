// Pluck: an initial triangular displacement at position p gives mode n an
// amplitude ∝ sin(nπp)/n². Closed form.

import { synthModal } from '../../analysis/modal.js';
import { modesAt } from '../family.js';

export function pluckWeights(count, position) {
  const p = Math.max(0.001, Math.min(0.999, position));
  const w = [];
  for (let n = 1; n <= count; n++) w.push(Math.abs(Math.sin(n * Math.PI * p)) / (n * n));
  const max = Math.max(...w) || 1;
  return w.map((v) => v / max);
}

export function pluck(card, { pitchHz, position = 0.2, velocity = 1, seconds = 2, sampleRate = 96000 } = {}) {
  const base = modesAt(card, pitchHz, { position: null, hardness: 1 });
  const w = pluckWeights(base.length, position);
  const modes = base.map((m, i) => ({ ...m, amp: m.amp * w[i] * velocity, phase: Math.PI / 2 })); // displacement starts at its extreme
  return synthModal(modes, sampleRate, seconds);
}
