// Strike: a force pulse of Hertz contact time. Linear cards render in closed
// form through the damped-sinusoid synthesiser; cards with a nonlinearity law
// go through the bank so loud hits can bend.

import { synthModal } from '../../analysis/modal.js';
import { modesAt, contactTimeSec } from '../family.js';
import { runBank } from './bank.js';

export function strike(card, { pitchHz, position = null, hardness = 0.5, velocity = 1, seconds = 2, sampleRate = 96000 } = {}) {
  const modes = modesAt(card, pitchHz, { position, hardness }).map((m) => ({ ...m, amp: m.amp * velocity, phase: 0 }));
  if (!card.nonlinearity) return synthModal(modes, sampleRate, seconds);
  const n = Math.round(seconds * sampleRate), x = new Float32Array(n);
  const len = Math.max(1, Math.round(contactTimeSec(hardness) * sampleRate));
  for (let i = 0; i < len && i < n; i++) x[i] = Math.sin(Math.PI * i / len) * (2 / len); // unit-area half sine
  return runBank(modes, x, sampleRate, { nonlinearity: card.nonlinearity });
}
