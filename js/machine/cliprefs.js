// Yellowjacket MACHINE — ClipRef model + clip audition path (BEATMAP slice).
// ClipRefs are immutable spans into the ORIGINAL source timeline; edits create
// new ClipRefs. No PCM is ever copied here: audition plays the source buffer
// through offset/duration on an AudioBufferSourceNode.

const LABEL_MAX = 24;        // chars before the label is cut and ellipsized
const FADE = 0.003;          // s, equal-power fade at clip edges (click guard)
const CURVE_N = 32;          // samples per fade curve
const START_DELAY = 0.005;   // s, scheduling headroom so automation lands cleanly

let clipCounter = 0;

// Equal-power crossfade shape: sin/cos quarter-cycle, in^2 + out^2 = 1.
// Built once at unity: auditions play at unity, so there is no second shape.
const FADE_IN_UNIT = buildCurve(false);
const FADE_OUT_UNIT = buildCurve(true);

function buildCurve(out) {
  const c = new Float32Array(CURVE_N);
  for (let i = 0; i < CURVE_N; i++) {
    const x = (i / (CURVE_N - 1)) * (Math.PI / 2);
    c[i] = out ? Math.cos(x) : Math.sin(x);
  }
  return c;
}

function nextId() {
  clipCounter += 1;
  return 'c' + clipCounter;
}

// After a RESUME the counter restarts at zero while restored clips keep their
// saved ids; advance past them so a new clip cannot collide (clipdelete filters
// by id and would silently drop both).
export function advanceClipCounter(clips) {
  for (const clip of clips || []) {
    const m = /^c(\d+)$/.exec(clip && clip.id ? clip.id : '');
    if (m) clipCounter = Math.max(clipCounter, Number(m[1]));
  }
}

export function makeClip(start, end, tag, label) {
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  return { id: nextId(), start: a, end: b, tag, label };
}

export function wordsToClip(words, i0, i1) {
  const lo = Math.max(0, Math.min(i0, i1));
  const hi = Math.min(words.length - 1, Math.max(i0, i1));
  const parts = [];
  for (let i = lo; i <= hi; i++) parts.push(words[i].text);
  let label = parts.join(' ');
  if (label.length > LABEL_MAX) {
    label = label.slice(0, LABEL_MAX).replace(/\s+$/, '') + '…';
  }
  return makeClip(words[lo].start, words[hi].end, 'word', label);
}

export function snapToBeat(t, beats, toleranceSec = 0.08) {
  if (!beats || !beats.length) return t;
  let lo = 0;
  let hi = beats.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  let best = t;
  let bestDist = Infinity;
  if (lo < beats.length && Math.abs(beats[lo] - t) < bestDist) {
    bestDist = Math.abs(beats[lo] - t);
    best = beats[lo];
  }
  if (lo > 0 && Math.abs(beats[lo - 1] - t) < bestDist) {
    bestDist = Math.abs(beats[lo - 1] - t);
    best = beats[lo - 1];
  }
  return bestDist <= toleranceSec ? best : t;
}

export function clipsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

export class ClipAuditioner {
  // One-shot audition path riding the engine's context and master bus.
  // Does not own an AudioContext: before the engine's first user-gesture
  // play there is no context, and play() is a silent no-op.
  constructor(engine) {
    this._engine = engine;
    this._voice = null;   // { src, fadeGain, stopGain }
  }

  play(clip, { rate = 1 } = {}) {
    const ctx = this._engine.ctx;
    const master = this._engine.master;
    const buffer = this._engine.buffer;
    if (!clip || !ctx || !master || !buffer) return;

    this.stop();
    if (ctx.state === 'suspended') ctx.resume();

    const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
    const start = Math.min(Math.max(clip.start, 0), buffer.duration);
    const end = Math.min(Math.max(clip.end, 0), buffer.duration);
    const span = end - start;
    if (span <= 0) return;

    const outDur = span / r;   // output-time length; automation runs in output time
    const fade = Math.min(FADE, Math.max(outDur / 2 - 0.0002, 0));
    // Audition plays a clip at unity. Per-instrument level lives on the
    // track (gainDb); a ClipRef is a span, not a mix setting.

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = r;

    // Inner gain carries the scheduled edge fades; outer gain stays free of
    // automation so a manual stop ramp can never overlap a value curve
    // (setValueCurveAtTime rejects events inside its interval).
    const fadeGain = ctx.createGain();
    const stopGain = ctx.createGain();
    src.connect(fadeGain);
    fadeGain.connect(stopGain);
    stopGain.connect(master);

    const t0 = ctx.currentTime + START_DELAY;
    if (fade > 0) {
      fadeGain.gain.value = 0;
      fadeGain.gain.setValueCurveAtTime(FADE_IN_UNIT, t0, fade);
      fadeGain.gain.setValueCurveAtTime(FADE_OUT_UNIT, t0 + outDur - fade, fade);
    } else {
      fadeGain.gain.value = 1;
    }

    const voice = { src, fadeGain, stopGain };
    src.onended = () => {
      releaseVoice(voice);
      if (this._voice === voice) this._voice = null;
    };
    src.start(t0, start, span);
    this._voice = voice;
  }

  stop() {
    const voice = this._voice;
    this._voice = null;
    if (!voice) return;
    const ctx = this._engine.ctx;
    voice.src.onended = () => releaseVoice(voice);
    if (ctx && ctx.state !== 'closed') {
      const now = ctx.currentTime;
      voice.stopGain.gain.setValueCurveAtTime(FADE_OUT_UNIT, now, FADE);
      try { voice.src.stop(now + FADE + 0.001); } catch (e) { /* not started or already stopped */ }
    } else {
      try { voice.src.stop(); } catch (e) { /* not started or already stopped */ }
      releaseVoice(voice);
    }
  }
}

function releaseVoice(voice) {
  voice.src.onended = null;
  try { voice.src.disconnect(); } catch (e) { /* already disconnected */ }
  try { voice.fadeGain.disconnect(); } catch (e) { /* already disconnected */ }
  try { voice.stopGain.disconnect(); } catch (e) { /* already disconnected */ }
}
