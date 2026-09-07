// The offline renderer for a score: every note is one render of its card
// (cached per card, excitation, pitch, dynamic, length), placed at its time,
// levelled by the same rule as STUDIO (−6 dBFS × velocity), released at
// note-off when driven; each part is then RMS-normalised over its sounding
// samples (a bowed card sustains far louder than a strike), panned, and
// summed to stereo at the truth rate, then resampled to the score's rate.
// Deterministic; no DOM, no AudioContext. Progress by note.

import { renderVoice, TRUTH_RATE } from '../instrument/render.js';
import { resample } from '../dsp/resample.js';
import { cardVoiceLevel, SILENT_PEAK, dynamicsBucket, DRIVEN } from '../studio/card-voice.js';

export const DRIVEN_MAX_SECONDS = 16;
export const STRUCK_MAX_SECONDS = 4;
export const RELEASE_SECONDS = 0.08;

/** The render length for a note: struck by the card's ring, driven by the note plus a tail. */
export function renderSeconds(card, excitation, seconds) {
  if (DRIVEN.has(excitation)) return Math.min(DRIVEN_MAX_SECONDS, Math.ceil((seconds + 0.5) * 4) / 4);
  let tau = 0;
  for (const m of card.modes) if (m.tauSec > tau) tau = m.tauSec;
  return Math.max(1, Math.min(STRUCK_MAX_SECONDS, Math.ceil(3 * tau * 4) / 4));
}

/** A render cache keyed like STUDIO's, over any render function (sync in node, a pool in the page). */
export class ScoreRenderCache {
  constructor(render = null, limit = 512) { this.render = render || ((inputs) => renderVoice(inputs)); this.map = new Map(); this.limit = limit; }
  key(card, excitation, hz, velocity, seconds) { return `${card.id}|${excitation}|${hz.toFixed(3)}|${dynamicsBucket(velocity)}|${renderSeconds(card, excitation, seconds)}`; }
  async get(card, excitation, hz, velocity, seconds, params = {}) {
    const key = this.key(card, excitation, hz, velocity, seconds);
    if (this.map.has(key)) { const v = this.map.get(key); this.map.delete(key); this.map.set(key, v); return v; }
    const v = await this.render({ card, pitchHz: hz, excitation, dynamics: dynamicsBucket(velocity), seconds: renderSeconds(card, excitation, seconds), params });
    const out = { samples: v.samples, sampleRate: v.sampleRate, peak: v.meta ? v.meta.peak : peakOf(v.samples) };
    this.map.set(key, out);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
    return out;
  }
}

function peakOf(x) { let p = 0; for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > p) p = v; } return p; }

/** RMS over samples above a floor (sounding samples), in dB; −Infinity when silent. */
export function soundingRmsDb(x, floor = 1e-4) {
  let s = 0, n = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i]; if (Math.abs(v) > floor) { s += v * v; n++; } }
  return n ? 10 * Math.log10(s / n) : -Infinity;
}

/**
 * Render one part to a mono buffer at TRUTH_RATE. Notes are placed at their
 * times; driven notes are released over RELEASE_SECONDS at note-off.
 */
export async function renderPart(part, totalSeconds, { cache = null, onNote = null } = {}) {
  const rate = TRUTH_RATE;
  const c = cache || new ScoreRenderCache();
  const out = new Float32Array(Math.ceil(totalSeconds * rate));
  const driven = DRIVEN.has(part.excitation);
  for (let i = 0; i < part.notes.length; i++) {
    const n = part.notes[i];
    const r = await c.get(part.card, part.excitation, n.hz, n.velocity, n.seconds, part.params);
    if (!(r.peak > SILENT_PEAK)) { if (onNote) onNote(i + 1, part.notes.length, false); continue; }
    const level = cardVoiceLevel(r.peak, n.velocity);
    const start = Math.round(n.t * rate);
    const len = driven ? Math.min(r.samples.length, Math.round((n.seconds + RELEASE_SECONDS) * rate)) : r.samples.length;
    const relStart = driven ? Math.round(n.seconds * rate) : len;
    const relLen = Math.max(1, len - relStart);
    for (let k = 0; k < len; k++) {
      const at = start + k;
      if (at >= out.length) break;
      let g = level;
      if (k >= relStart) g *= Math.max(0, 1 - (k - relStart) / relLen);
      out[at] += r.samples[k] * g;
    }
    if (onNote) onNote(i + 1, part.notes.length, true);
  }
  return out;
}

/** Equal-power pan gains for −1..1. */
export function panGains(pan) { const a = (Math.max(-1, Math.min(1, pan)) + 1) * Math.PI / 4; return { left: Math.cos(a), right: Math.sin(a) }; }

/**
 * Render a whole score → { left, right, sampleRate, parts: [{ id, rmsDb, gain }] }.
 * Each part is normalised to its `rmsDb` over sounding samples (null keeps
 * the physics' level), then `gainDb`, then panned and summed. Nothing is
 * limited here; mastering is a separate step.
 */
export async function renderScore(score, { cache = null, onProgress = null, tail = 4 } = {}) {
  const rate = TRUTH_RATE;
  let total = 0;
  for (const p of score.parts) for (const n of p.notes) total = Math.max(total, n.t + n.seconds);
  total += tail;
  const N = Math.ceil(total * rate);
  const L = new Float32Array(N), R = new Float32Array(N);
  const report = [];
  const c = cache || new ScoreRenderCache();
  let done = 0;
  const all = score.parts.reduce((s, p) => s + p.notes.length, 0);
  for (const part of score.parts) {
    const mono = await renderPart(part, total, { cache: c, onNote: () => { done++; if (onProgress) onProgress(done, all, part.id); } });
    const measured = soundingRmsDb(mono);
    let gain = Math.pow(10, (part.gainDb || 0) / 20);
    if (part.rmsDb != null && Number.isFinite(measured)) gain *= Math.pow(10, (part.rmsDb - measured) / 20);
    const { left, right } = panGains(part.pan || 0);
    for (let i = 0; i < N; i++) { const v = mono[i] * gain; L[i] += v * left; R[i] += v * right; }
    report.push({ id: part.id, rmsDb: measured, gain });
  }
  const outRate = score.sampleRate || 48000;
  const left = outRate === rate ? L : resample(L, rate, outRate, { cutoffScale: 0.45 });
  const right = outRate === rate ? R : resample(R, rate, outRate, { cutoffScale: 0.45 });
  return { left, right, sampleRate: outRate, parts: report };
}
