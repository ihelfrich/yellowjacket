// Cards as STUDIO instruments. A found-instrument card plays every note by the
// engine's physics — renderVoice at 96 kHz for that pitch, that mallet, that
// dynamic — never by shifting one sample up and down. Renders are cached per
// (card, excitation, note, dynamics bucket, length bucket) so a bar that
// repeats costs one render; the cache hands each audio context its own
// AudioBuffer of a render, made once. Pure apart from the AudioBuffer helper.

import { renderVoice } from '../instrument/render.js';
import { chordNotes, studioStepSeconds, CARD_EXCITATIONS } from './model.js';

export const DRIVEN = new Set(['bow', 'breath']);
export const DYNAMICS_STEPS = 4;   // velocity buckets 0.25 · 0.5 · 0.75 · 1
export const STRUCK_SECONDS = 2.5; // a strike or pluck rings on its own
export const DRIVEN_TAIL = 0.5;    // bow and breath render the note plus a tail
export const MAX_SECONDS = 4;
export const CACHE_LIMIT = 256;

export function midiHz(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }
export function dynamicsBucket(velocity) { return Math.max(1, Math.min(DYNAMICS_STEPS, Math.ceil(velocity * DYNAMICS_STEPS))) / DYNAMICS_STEPS; }
export function noteSeconds(excitation, duration) {
  return DRIVEN.has(excitation) ? Math.min(MAX_SECONDS, Math.ceil((duration + DRIVEN_TAIL) * 4) / 4) : STRUCK_SECONDS;
}
export function cardNoteKey(card, excitation, midi, velocity, duration) {
  return `${card.id}|${excitation}|${midi}|${dynamicsBucket(velocity)}|${noteSeconds(excitation, duration)}`;
}

export class CardVoiceCache {
  constructor(limit = CACHE_LIMIT) { this.limit = limit; this.map = new Map(); this.buffers = new WeakMap(); }
  has(card, excitation, midi, velocity, duration) { return this.map.has(cardNoteKey(card, excitation, midi, velocity, duration)); }
  /** → { samples, sampleRate, peak, seconds }, rendered once per key, most recent kept. */
  render(card, excitation, midi, velocity, duration) {
    const key = cardNoteKey(card, excitation, midi, velocity, duration);
    if (this.map.has(key)) { const v = this.map.get(key); this.map.delete(key); this.map.set(key, v); return v; }
    const exc = CARD_EXCITATIONS.includes(excitation) ? excitation : 'strike';
    const v = renderVoice({ card, pitchHz: midiHz(midi), excitation: exc, dynamics: dynamicsBucket(velocity), seconds: noteSeconds(exc, duration) });
    const out = { samples: v.samples, sampleRate: v.sampleRate, peak: v.meta.peak, seconds: v.samples.length / v.sampleRate };
    this.map.set(key, out);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
    return out;
  }
  /** The same render through a pool (a worker), stored under the same key; a sync render already present wins. */
  async renderAsync(pool, card, excitation, midi, velocity, duration) {
    const key = cardNoteKey(card, excitation, midi, velocity, duration);
    if (this.map.has(key)) return this.map.get(key);
    const exc = CARD_EXCITATIONS.includes(excitation) ? excitation : 'strike';
    const v = await pool.render({ card, pitchHz: midiHz(midi), excitation: exc, dynamics: dynamicsBucket(velocity), seconds: noteSeconds(exc, duration) });
    if (this.map.has(key)) return this.map.get(key);
    const out = { samples: v.samples, sampleRate: v.sampleRate, peak: v.meta.peak, seconds: v.samples.length / v.sampleRate };
    this.map.set(key, out);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
    return out;
  }
  /** An AudioBuffer of a render for this context; the context resamples 96 kHz on playback. */
  buffer(ctx, rendered) {
    let per = this.buffers.get(ctx);
    if (!per) { per = new Map(); this.buffers.set(ctx, per); }
    let b = per.get(rendered);
    if (!b) { b = ctx.createBuffer(1, rendered.samples.length, rendered.sampleRate); b.getChannelData(0).set(rendered.samples); per.set(rendered, b); }
    return b;
  }
  clear() { this.map.clear(); this.buffers = new WeakMap(); }
  get size() { return this.map.size; }
}

/** The distinct notes a card track will play: [{ midi, velocity, duration }], one per render key. */
export function trackNotes(studio, track) {
  if (!track || !track.card || !track.card.card) return [];
  const { card, excitation } = track.card;
  const transpose = track.synth && Number.isFinite(track.synth.transpose) ? track.synth.transpose : 0;
  const seen = new Map();
  const total = Math.min(track.steps.length, studio.bars * 16);
  for (let step = 0; step < total; step++) {
    const event = track.steps[step];
    if (!event) continue;
    const duration = studioStepSeconds(studio.bpm) * event.gate;
    for (const note of chordNotes(event.note, event.chord)) {
      const midi = note + transpose;
      const key = cardNoteKey(card, excitation, midi, event.velocity, duration);
      if (!seen.has(key)) seen.set(key, { midi, velocity: event.velocity, duration });
    }
  }
  return [...seen.values()];
}

/**
 * Render every note a card track will play. With a `pool` the renders run in
 * its workers, `pool.size` at a time; without one they run here, yielding
 * between notes. → count
 */
export async function warmCardTrack(cache, studio, track, { pool = null, yieldFn = null, onProgress = null } = {}) {
  const notes = trackNotes(studio, track);
  const { card, excitation } = track.card;
  const todo = notes.filter((n) => !cache.has(card, excitation, n.midi, n.velocity, n.duration));
  let done = notes.length - todo.length;
  if (pool) {
    const width = Math.max(1, pool.size || 1);
    for (let i = 0; i < todo.length; i += width) {
      await Promise.all(todo.slice(i, i + width).map((n) => cache.renderAsync(pool, card, excitation, n.midi, n.velocity, n.duration).then(() => { done++; if (onProgress) onProgress(done, notes.length); })));
    }
    return notes.length;
  }
  for (let i = 0; i < todo.length; i++) {
    const n = todo[i];
    cache.render(card, excitation, n.midi, n.velocity, n.duration);
    done++;
    if (onProgress) onProgress(done, notes.length);
    if (yieldFn && i + 1 < todo.length) await yieldFn();
  }
  return notes.length;
}
