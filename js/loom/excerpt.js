// Semantic-lane excerpts. The MACHINE sequencer plays Semantic Take events
// from the loaded recording on the DEVICE context, because it shares the drum
// clock — so a 44.1 kHz recording on a 96 kHz device reaches Chromium's
// resampler. A whole-source device-rate copy would cost a second full buffer
// (167 MB for a three-minute file), so each event gets its own short excerpt,
// rate-matched once and cached.
//
// What this buys, measured (E12e, lab log): an unpitched event goes from a
// −26 dB image to the window floor; a pitched one gains 16 dB but stays
// interpolated, because a Semantic Take plays at 2^(semitones/12) and that
// ratio is never 1 on any context. Rate-matched, not interpolation-free.

// A little air each side so the edge fade in schedule.js has samples to work
// with and a rounded offset cannot fall outside the excerpt.
export const EXCERPT_PAD_SEC = 0.002;
export const EXCERPT_CACHE_SEC = 30;

// The pitch ratio is part of the key: the same event at another pitch is a
// different excerpt now that the pitch is baked into the buffer's rate.
export function excerptKey(sourceHash, planId, eventId, rate, pitchRatio = 1) {
  return [
    sourceHash || 'no-source', planId || 'no-plan', eventId || 'no-event',
    Math.round(rate) || 0, (Number(pitchRatio) || 1).toFixed(6),
  ].join('|');
}

// A buffer rate Web Audio will actually accept. Outside this the excerpt
// falls back to the context rate and the note is pitched the old way.
export const MIN_BUFFER_RATE = 3000;
export const MAX_BUFFER_RATE = 384000;

/**
 * The rate to build the excerpt at so that the pitch shift costs nothing.
 * A source node's real ratio is `playbackRate x (bufferRate / contextRate)`;
 * Chromium copies when that is 1 and interpolates linearly otherwise. Tag the
 * buffer at `contextRate / pitchRatio` and the two cancel exactly, so the
 * pitch shift is done by the Kaiser resampler that built the excerpt instead.
 * Measured: an unpitched note goes from a -26 dB image to the noise floor, and
 * a +4-semitone note from -42 dB to -66.6 dB, which is what a directly
 * generated tone measures (lab log, E12f).
 */
export function excerptRateFor(outRate, pitchRatio = 1) {
  const out = Math.round(Number(outRate));
  const r = Number(pitchRatio);
  if (!(out > 0)) return 0;
  if (!Number.isFinite(r) || r <= 0 || r === 1) return out;
  const target = Math.round(out / r);
  if (target < MIN_BUFFER_RATE || target > MAX_BUFFER_RATE) return out;
  return target;
}

/**
 * Cut [offset - pad, offset + span + pad] out of `channels` (Float32Arrays at
 * `sourceRate`) and hand back the window with the offset rebased into it,
 * built at `excerptRateFor(outRate, pitchRatio)` so the note's own pitch ratio
 * cancels against the buffer rate. Returns {channels, sampleRate, offsetSec,
 * seconds} or null when the event asks for nothing. `resampleFn(channel,
 * inRate, outRate)` does the rate match; equal rates never call it.
 *
 * `seconds` and `offsetSec` stay in SOURCE seconds, which is also the
 * excerpt's own buffer-time: resampling changes the frame count and the tag
 * together, so the duration is unchanged.
 */
export function cutExcerpt({ channels, sourceRate, offsetSec, spanSec, outRate, resampleFn, pad = EXCERPT_PAD_SEC, pitchRatio = 1 }) {
  const list = (channels || []).filter((c) => c && c.length);
  const inRate = Math.round(Number(sourceRate));
  const out = excerptRateFor(outRate, pitchRatio);
  const span = Number(spanSec);
  if (!list.length || !(inRate > 0) || !(out > 0) || !(span > 0)) return null;
  const frames = list[0].length;
  const from = Math.max(0, Math.floor((Number(offsetSec) - pad) * inRate));
  const to = Math.min(frames, Math.ceil((Number(offsetSec) + span + pad) * inRate));
  if (to <= from) return null;
  const cut = list.map((c) => c.subarray(from, to));
  const matched = inRate === out;
  const data = matched ? cut.map((c) => c.slice()) : cut.map((c) => resampleFn(c, inRate, out));
  const length = data[0] ? data[0].length : 0;
  if (!length) return null;
  return {
    channels: data,
    sampleRate: out,
    // Where the event's own start sits inside the excerpt.
    offsetSec: Math.max(0, Number(offsetSec) - from / inRate),
    seconds: length / out,
  };
}

// Least-recently-used by insertion order, bounded by total audio seconds
// rather than entry count: one long event should not evict a whole plan.
export class ExcerptCache {
  constructor(maxSeconds = EXCERPT_CACHE_SEC) {
    this.maxSeconds = maxSeconds;
    this._map = new Map();
    this._seconds = 0;
  }

  get size() { return this._map.size; }
  get seconds() { return this._seconds; }

  get(key) {
    const hit = this._map.get(key);
    if (!hit) return null;
    this._map.delete(key);          // reinsert: most recently used last
    this._map.set(key, hit);
    return hit;
  }

  set(key, excerpt) {
    if (!excerpt || !(excerpt.seconds > 0)) return excerpt;
    if (this._map.has(key)) this._seconds -= this._map.get(key).seconds;
    this._map.set(key, excerpt);
    this._seconds += excerpt.seconds;
    for (const k of this._map.keys()) {
      if (this._seconds <= this.maxSeconds || this._map.size <= 1) break;
      this._seconds -= this._map.get(k).seconds;
      this._map.delete(k);
    }
    return excerpt;
  }

  clear() { this._map.clear(); this._seconds = 0; }
}
