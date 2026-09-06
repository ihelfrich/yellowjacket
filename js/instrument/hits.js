// Finding the hit in a recording: the transient worth carding, judged by the
// physics rather than by loudness. Shared by the CLI and the bench panel.
// Pure DSP: no DOM, no AudioContext, no Math.random.

import { buildCard } from './card.js';

/**
 * Two passes of a 2nd-order Butterworth high-pass at `fc` (4th order overall,
 * −3 dB near 1.25·fc, −72 dB at fc/8). Anechoic-chamber and room rumble at
 * 2–25 Hz measured as loud as the notes on the Iowa bells and set the fitter's
 * reference level; nothing carded here lives below 40 Hz.
 */
export function highpass(x, sampleRate, fc = 40) {
  const w = Math.tan(Math.PI * fc / sampleRate), k = w * w, a0 = 1 + Math.SQRT2 * w + k;
  const b0 = 1 / a0, b1 = -2 / a0, b2 = 1 / a0, a1 = 2 * (k - 1) / a0, a2 = (1 - Math.SQRT2 * w + k) / a0;
  let y = x;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(y.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) { const v = b0 * y[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = y[i]; y2 = y1; y1 = v; out[i] = v; }
    y = out;
  }
  return y;
}

/**
 * Candidate hits: { start, end, jump, ring, score }, best first. Onset = an
 * energy jump of ~13 dB in 5 ms; end = the envelope 40 dB down, the next
 * onset, or `maxSeconds`. Rings under 80 ms are not rings.
 */
export function findHits(mono, sampleRate, { maxSeconds = 3 } = {}) {
  const hop = Math.round(0.005 * sampleRate), frames = Math.floor(mono.length / hop), e = new Float32Array(frames);
  for (let f = 0; f < frames; f++) { let s = 0; for (let i = 0; i < hop; i++) s += mono[f * hop + i] ** 2; e[f] = Math.log(1e-9 + s / hop); }
  const hits = [];
  for (let f = 4; f < frames - 40; f++) {
    const jump = e[f] - Math.max(e[f - 1], e[f - 2], e[f - 3]);
    if (jump < 1.5) continue; // ~6.5 dB in 5 ms; bells over a crowd do not jump 13 dB
    let ring = 0;
    while (f + ring < frames && e[f + ring] > e[f] - 9.2 && ring * hop / sampleRate < maxSeconds) {
      if (ring > 2 && e[f + ring] - Math.max(e[f + ring - 1], e[f + ring - 2]) > 3) break; // the next onset
      ring++;
    }
    if (ring * hop / sampleRate < 0.08) continue;
    hits.push({ start: f * hop / sampleRate, end: Math.min(mono.length / sampleRate, (f + ring + 4) * hop / sampleRate), jump, ring: ring * hop / sampleRate, score: jump + 2 * Math.log(1 + ring) });
    f += Math.max(1, Math.min(ring, 20));
  }
  return hits.sort((a, b) => b.score - a.score);
}

/** The fit level a card reports in its source note, in dB (0 when absent). */
export function cardFitDb(card) { return Number((card.source.note.match(/fit (-?[\d.]+) dB/) || [0, 0])[1]); }

/**
 * Card the best `tries` candidates and keep the one the physics likes: three
 * or more modes first, then more modes, then the lower residual. Returns
 * { hit, card, tried: [{ start, end, modes, fitDb }] } or null with no hit.
 */
export function bestHit(mono, sampleRate, { tries = 12, maxSeconds = 2.5, name = 'try', license = '', note = '' } = {}) {
  const hits = findHits(mono, sampleRate).slice(0, tries);
  if (!hits.length) return null;
  let best = null;
  const tried = [];
  for (const h of hits) {
    const j = judge(mono, sampleRate, h, { maxSeconds, name, license, note });
    tried.push(j.entry);
    if (!best || j.rank > best.rank) best = j;
  }
  return { hit: best.hit, card: best.card, tried };
}

/**
 * The same judge for a page that must stay responsive: `onProgress(done, total,
 * entry)` after each candidate and `await yieldFn()` between them.
 */
export async function bestHitAsync(mono, sampleRate, { tries = 12, maxSeconds = 2.5, name = 'try', license = '', note = '', onProgress = null, yieldFn = null } = {}) {
  const hits = findHits(mono, sampleRate).slice(0, tries);
  if (!hits.length) return null;
  let best = null;
  const tried = [];
  for (let i = 0; i < hits.length; i++) {
    const j = judge(mono, sampleRate, hits[i], { maxSeconds, name, license, note });
    tried.push(j.entry);
    if (!best || j.rank > best.rank) best = j;
    if (onProgress) onProgress(i + 1, hits.length, j.entry);
    if (yieldFn && i + 1 < hits.length) await yieldFn();
  }
  return { hit: best.hit, card: best.card, tried };
}

function judge(mono, sampleRate, h, { maxSeconds, name, license, note }) {
  const end = Math.min(h.end, h.start + maxSeconds);
  const slice = mono.subarray(Math.round(h.start * sampleRate), Math.round(end * sampleRate));
  const card = buildCard(slice, sampleRate, { name, license, note: `${note ? note + ' ' : ''}from ${h.start.toFixed(3)}–${end.toFixed(3)} s.` });
  const fitDb = cardFitDb(card);
  // Modes within 2% of a lower one are one mode the fitter split (a beating
  // pair or a noisy segment), so they count once here; a long ring counts for
  // the object, since a bell partial that lasts a second outranks three
  // 30 ms lines. The card itself keeps every fitted mode.
  let distinct = 0, prev = 0, maxTau = 0;
  for (const m of card.modes) { if (!prev || m.freqHz / prev > 1.02) distinct++; prev = m.freqHz; maxTau = Math.max(maxTau, m.tauSec); }
  const rank = (distinct >= 3 ? 100 : 0) + distinct + 2 * Math.log10(1 + 10 * maxTau) - fitDb / 3;
  return { hit: { ...h, end }, card, rank, entry: { start: h.start, end, modes: card.modes.length, distinct, maxTau, fitDb, kind: card.family.kind } };
}
