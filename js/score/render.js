// The offline renderer for a score: every note is one render of its card
// (cached per card, excitation, pitch, dynamic, length), placed at its time,
// levelled by the same rule as STUDIO (−6 dBFS × velocity), released at
// note-off when driven; each part is then RMS-normalised over its sounding
// samples (a bowed card sustains far louder than a strike), panned, and
// summed to stereo at the truth rate, then resampled to the score's rate.
// Deterministic; no DOM, no AudioContext. Progress by note. The same sum can
// be taken a block at a time (renderScoreBlocks) so a long piece never holds
// more than one block of audio.

import { renderVoice, TRUTH_RATE } from '../instrument/render.js';
import { resample } from '../dsp/resample.js';
import { cardVoiceLevel, SILENT_PEAK, dynamicsBucket, DRIVEN } from '../studio/card-voice.js';
import { cardFingerprint, canonicalJson } from './model.js';

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

/**
 * The cache is the piece's memory, not the audio: renderScoreBlocks holds one
 * block and one ring per part, so what is left resident is the distinct renders.
 * Measured over the four symphony movements — 182 / 52 / 87 / 115 distinct
 * renders costing 259 / 124 / 86 / 165 MB — a render averages 1.0–2.4 MB and a
 * 16 s driven one is 6.1 MB. No movement came near the old bound of 512
 * entries — the largest asked for 182 — so it never evicted anything and
 * movement 1 held all 259 MB it asked for; a count of entries did not bound
 * that number and was never observed to bound anything. 256 MB holds movements
 * 2, 3 and 4 entire and sheds only the coldest few of movement 1, and leaves
 * half a gigabyte of the ~780 MB where the tab resets for the rest of the tab.
 */
export const CACHE_BYTES = 256e6;

/** A render cache keyed like STUDIO's, over any render function (sync in node, a pool in the page). */
export class ScoreRenderCache {
  // The budget is bytes, in an options object. The second argument was once a
  // number of entries, and a stale `new ScoreRenderCache(fn, 512)` destructures
  // to `{}` — 256 MB where 512 entries was meant, read wrong and silently — so
  // anything but an options object is refused.
  constructor(render = null, options = {}) {
    if (options === null || typeof options !== 'object') throw new TypeError(`a render cache is bounded by { bytes }, not by ${JSON.stringify(options) ?? String(options)}`);
    const { bytes = CACHE_BYTES } = options;
    if (!(bytes > 0)) throw new TypeError(`a render cache's bytes is ${bytes}, not a budget`);
    this.render = render || ((inputs) => renderVoice(inputs));
    this.map = new Map(); this.bytes = bytes; this.used = 0;
  }
  // The fingerprint, not card.id: a retuned card keeps its id, so keying on the
  // id served the original card's samples for it (measured 0 difference where a
  // cold render differs by 5.4e-3). `params` is in it for the same reason one
  // field over: js/instrument/render.js spreads params into the excitation, so
  // two parts on one card differing only in { hardness: 0.05 } against
  // { hardness: 0.95 } collapsed onto one entry and the second part was struck
  // with the first part's mallet — measured one cache entry for renders that
  // are 2.812e-1 apart.
  key(card, excitation, hz, velocity, seconds, params = {}) { return `${cardFingerprint(card)}|${excitation}|${hz.toFixed(3)}|${dynamicsBucket(velocity)}|${renderSeconds(card, excitation, seconds)}|${canonicalJson(params || {})}`; }
  async get(card, excitation, hz, velocity, seconds, params = {}) {
    const key = this.key(card, excitation, hz, velocity, seconds, params);
    if (this.map.has(key)) { const v = this.map.get(key); this.map.delete(key); this.map.set(key, v); return v; }
    const v = await this.render({ card, pitchHz: hz, excitation, dynamics: dynamicsBucket(velocity), seconds: renderSeconds(card, excitation, seconds), params });
    const out = { samples: v.samples, sampleRate: v.sampleRate, peak: v.meta ? v.meta.peak : peakOf(v.samples), bytes: v.samples.length * 4 };
    this.map.set(key, out);
    this.used += out.bytes;
    // A Map iterates in insertion order and a hit re-inserts, so the front of it
    // is the least recently used. The last entry stays whatever it cost: a
    // single render larger than the whole budget is still the one being asked
    // for, and evicting it would only guarantee rendering it again.
    while (this.used > this.bytes && this.map.size > 1) {
      const cold = this.map.keys().next().value;
      this.used -= this.map.get(cold).bytes;
      this.map.delete(cold);
    }
    return out;
  }
}

function peakOf(x) { let p = 0; for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > p) p = v; } return p; }

const SOUNDING_FLOOR = 1e-4;

/**
 * A part's notes in time order. Both paths sum every note into one accumulator,
 * and float addition is not associative, so the order the notes are added in
 * decides the last bits: the block path can only add them in time order, and
 * the whole-buffer path added them in array order, so a part whose notes are
 * stored out of order rendered differently down the two paths (measured 2.980e-8
 * on a bell part written [2.51, 0.13, 1.44, 0.62] s — movement-4 has three such
 * notes, brass 231 and thud 88 and 210). Sorting is stable and an already-ordered
 * part is returned untouched, so no chronological score changes by one bit; the
 * copy leaves the caller's score alone.
 */
export function notesInTimeOrder(notes) {
  for (let i = 1; i < notes.length; i++) if (notes[i].t < notes[i - 1].t) return notes.slice().sort((a, b) => a.t - b.t);
  return notes;
}

/** RMS over samples above a floor (sounding samples), in dB; −Infinity when silent. */
export function soundingRmsDb(x, floor = SOUNDING_FLOOR) {
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
  const notes = notesInTimeOrder(part.notes);
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const r = await c.get(part.card, part.excitation, n.hz, n.velocity, n.seconds, part.params);
    if (!(r.peak > SILENT_PEAK)) { if (onNote) onNote(i + 1, notes.length, false); continue; }
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
    if (onNote) onNote(i + 1, notes.length, true);
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

// js/dsp/resample.js reaches 160 input samples each side of an output sample;
// a block padded with this much true signal on both sides resamples to the same
// numbers the whole buffer would give.
const RESAMPLE_PAD = 1024;

function gcd(a, b) { while (b) { const t = a % b; a = b; b = t; } return a; }

/**
 * One part's notes placed a block at a time. A note is rendered once, in the
 * block its attack falls in; whatever of it rings past the block end is held in
 * `carry` — as long as the longest render, never as long as the score — and
 * added to the front of the next block. So a note that straddles a boundary, or
 * one whose render outlasts a whole block, still costs one render and one tail.
 */
class PartVoice {
  constructor(part, samples, cache) {
    this.part = part; this.samples = samples; this.cache = cache;
    this.notes = notesInTimeOrder(part.notes);
    this.driven = DRIVEN.has(part.excitation);
    this.carry = new Float32Array(0);
  }
  /** Sum this part over absolute samples [from, from + len) into `out`. */
  async block(from, len, out, onNote = null) {
    const carry = this.carry;
    if (carry.length) {
      for (let i = 0, m = Math.min(len, carry.length); i < m; i++) out[i] += carry[i];
      if (carry.length > len) { carry.copyWithin(0, len); carry.fill(0, carry.length - len); }
      else carry.fill(0);
    }
    const rate = TRUTH_RATE, p = this.part, end = from + len;
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i];
      const start = Math.round(n.t * rate);
      if (start < from || start >= end) continue;
      const r = await this.cache.get(p.card, p.excitation, n.hz, n.velocity, n.seconds, p.params);
      if (onNote) onNote();
      if (!(r.peak > SILENT_PEAK)) continue;
      const level = cardVoiceLevel(r.peak, n.velocity);
      const full = this.driven ? Math.min(r.samples.length, Math.round((n.seconds + RELEASE_SECONDS) * rate)) : r.samples.length;
      const relStart = this.driven ? Math.round(n.seconds * rate) : full;
      const relLen = Math.max(1, full - relStart);
      const stop = Math.min(full, this.samples - start);
      if (start + stop > end) this.hold(start + stop - end);
      for (let k = 0; k < stop; k++) {
        let g = level;
        if (k >= relStart) g *= Math.max(0, 1 - (k - relStart) / relLen);
        const at = start + k - from;
        if (at < len) out[at] += r.samples[k] * g;
        else this.carry[at - len] += r.samples[k] * g;
      }
    }
  }
  hold(n) { if (this.carry.length >= n) return; const c = new Float32Array(n); c.set(this.carry); this.carry = c; }
}

/**
 * The same render as renderScore, taken in consecutive blocks: each finished
 * block goes to `onBlock({ left, right, startSample, sampleRate })` and is then
 * dropped, so what is live is one block and one ring per part rather than the
 * whole piece — the 784 s of Thirteen Cards is 1.1 GB of buffers rendered whole,
 * in a tab that resets past ~780 MB. → renderScore's metadata without the
 * buffers. A part's level is only knowable once the whole part is summed, so
 * every note is placed twice — once to measure, once to sum — and `onProgress`
 * counts both passes.
 */
export async function renderScoreBlocks(score, { blockSeconds = 10, cache = null, onBlock = null, onProgress = null, tail = 4 } = {}) {
  const rate = TRUTH_RATE;
  let total = 0;
  for (const p of score.parts) for (const n of p.notes) total = Math.max(total, n.t + n.seconds);
  total += tail;
  const N = Math.ceil(total * rate);
  const outRate = score.sampleRate || 48000;
  // Blocks start on whole output samples — `step` truth samples is the shortest
  // run that lands on one — so the blocks resample to the whole-buffer result.
  const step = rate / gcd(rate, outRate);
  const pad = outRate === rate ? 0 : Math.ceil(RESAMPLE_PAD / step) * step;
  const B = Math.max(step, pad, Math.ceil(Math.round(blockSeconds * rate) / step) * step);
  const blockLen = Math.min(B, N);
  const totalOut = Math.round(N * outRate / rate);

  const c = cache || new ScoreRenderCache();
  const all = score.parts.reduce((s, p) => s + p.notes.length, 0) * 2;
  let done = 0;
  const tick = (id) => () => { done++; if (onProgress) onProgress(done, all, id); };
  const mono = new Float32Array(blockLen);
  const report = [], pans = [];
  for (const part of score.parts) {
    const voice = new PartVoice(part, N, c);
    let sum = 0, count = 0;
    for (let at = 0; at < N; at += B) {
      const len = Math.min(B, N - at);
      mono.fill(0, 0, len);
      await voice.block(at, len, mono, tick(part.id));
      for (let i = 0; i < len; i++) { const v = mono[i]; if (Math.abs(v) > SOUNDING_FLOOR) { sum += v * v; count++; } }
    }
    const measured = count ? 10 * Math.log10(sum / count) : -Infinity;
    let gain = Math.pow(10, (part.gainDb || 0) / 20);
    if (part.rmsDb != null && Number.isFinite(measured)) gain *= Math.pow(10, (part.rmsDb - measured) / 20);
    report.push({ id: part.id, rmsDb: measured, gain });
    pans.push(panGains(part.pan || 0));
  }

  // Resampling is one block behind the sum: a block is only handed on once the
  // next one exists to pad its right edge (the left edge keeps the previous
  // block's last `pad` samples).
  const win = onBlock && pad ? [new Float32Array(pad + blockLen + pad), new Float32Array(pad + blockLen + pad)] : null;
  let held = -1, heldLen = 0, lead = 0;
  const emit = async (rightPad) => {
    const winLen = lead + heldLen + rightPad;
    const from = lead * outRate / rate;
    const o0 = held * outRate / rate;
    const o1 = held + heldLen >= N ? totalOut : (held + heldLen) * outRate / rate;
    const l = resample(win[0].subarray(0, winLen), rate, outRate, { cutoffScale: 0.45 });
    const r = resample(win[1].subarray(0, winLen), rate, outRate, { cutoffScale: 0.45 });
    await onBlock({ left: l.slice(from, from + o1 - o0), right: r.slice(from, from + o1 - o0), startSample: o0, sampleRate: outRate });
  };
  const push = async (l, r, at, len) => {
    if (!onBlock) return;
    if (!pad) { await onBlock({ left: l.slice(0, len), right: r.slice(0, len), startSample: at, sampleRate: outRate }); return; }
    if (held >= 0) {
      const rightPad = Math.min(pad, len);
      win[0].set(l.subarray(0, rightPad), lead + heldLen); win[1].set(r.subarray(0, rightPad), lead + heldLen);
      await emit(rightPad);
      const end = lead + heldLen;
      win[0].copyWithin(0, end - pad, end); win[1].copyWithin(0, end - pad, end);
      lead = pad;
    }
    win[0].set(l.subarray(0, len), lead); win[1].set(r.subarray(0, len), lead);
    held = at; heldLen = len;
  };

  const voices = score.parts.map((p) => new PartVoice(p, N, c));
  const bl = new Float32Array(blockLen), br = new Float32Array(blockLen);
  for (let at = 0; at < N; at += B) {
    const len = Math.min(B, N - at);
    bl.fill(0, 0, len); br.fill(0, 0, len);
    for (let j = 0; j < voices.length; j++) {
      mono.fill(0, 0, len);
      await voices[j].block(at, len, mono, tick(score.parts[j].id));
      const gain = report[j].gain, { left, right } = pans[j];
      for (let i = 0; i < len; i++) { const v = mono[i] * gain; bl[i] += v * left; br[i] += v * right; }
    }
    await push(bl, br, at, len);
  }
  if (held >= 0) await emit(0);
  return { sampleRate: outRate, parts: report };
}
