// Live preview of the rack: the blue you would get from RENDER, drawn before
// you render. A short window after the playhead is cut from the source, run
// through the rack as it stands, and painted as the ghost over that window.
// The window math, the chain filter, and the readout are pure and node-tested;
// bench-controller does the scheduling and the drawing.

export const PREVIEW_SPAN_SEC = 12;
export const PREVIEW_PREROLL_SEC = 1;
// Loudnorm's gain is a whole-file measurement; a twelve-second window would
// invent a different one, so it is left to RENDER and the readout says so.
export const PREVIEW_DEFERRED = Object.freeze(['loudnorm']);

function finite(n, fallback = 0) {
  return Number.isFinite(n) ? n : fallback;
}

// {startSec, endSec, prerollSec, renderStartSec} or null without a duration.
// Near the end the window slides back so it is always the full span (a
// preview of the last half-second tells you nothing about the rack); the
// pre-roll lets compressors and gates settle and is dropped before drawing.
export function previewWindow({ playheadSec, durationSec, spanSec = PREVIEW_SPAN_SEC, prerollSec = PREVIEW_PREROLL_SEC } = {}) {
  const duration = finite(durationSec);
  if (!(duration > 0)) return null;
  const span = Math.min(Math.max(0.05, finite(spanSec, PREVIEW_SPAN_SEC)), duration);
  let start = Math.max(0, Math.min(duration, finite(playheadSec)));
  if (start + span > duration) start = duration - span;
  const preroll = Math.min(Math.max(0, finite(prerollSec, PREVIEW_PREROLL_SEC)), start);
  return { startSec: start, endSec: start + span, prerollSec: preroll, renderStartSec: start - preroll };
}

// Enabled modules minus the deferred ones. `flat` means nothing to preview;
// `deferred` lists what RENDER will add that the preview cannot show.
export function previewChain(chain) {
  const on = (Array.isArray(chain) ? chain : []).filter((c) => c && c.on && typeof c.id === 'string');
  const deferred = on.filter((c) => PREVIEW_DEFERRED.includes(c.id)).map((c) => c.id);
  const kept = on.filter((c) => !PREVIEW_DEFERRED.includes(c.id));
  return { chain: kept, deferred, flat: kept.length === 0 };
}

// A copy of [startSec, endSec) as a new AudioBuffer at the source rate.
// The constructor is injectable so the slice math is testable without a DOM.
export function sliceAudioBuffer(buffer, startSec, endSec, AudioBufferCtor = globalThis.AudioBuffer) {
  const sr = buffer.sampleRate;
  const a = Math.max(0, Math.min(buffer.length, Math.round(finite(startSec) * sr)));
  const b = Math.max(a, Math.min(buffer.length, Math.round(finite(endSec) * sr)));
  const out = new AudioBufferCtor({ numberOfChannels: buffer.numberOfChannels, length: Math.max(1, b - a), sampleRate: sr });
  if (b > a) {
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      out.copyToChannel(buffer.getChannelData(ch).subarray(a, b), ch, 0);
    }
  }
  return out;
}

function clock(sec) {
  const s = Math.max(0, Math.round(sec));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

export function describePreview({ window, ms, deferred = [], cuts = false } = {}) {
  if (!window) return 'NOTHING TO PREVIEW';
  const span = (window.endSec - window.startSec).toFixed(1) + 'S';
  let out = 'PREVIEW ≈ RENDER · ' + span + ' FROM ' + clock(window.startSec) + ' · ' + Math.max(1, Math.round(finite(ms))) + ' MS';
  if (deferred.length) out += ' · ' + deferred.map((id) => id.toUpperCase()).join(' + ') + ' APPLIES AT RENDER';
  if (cuts) out += ' · CUTS APPLY AT RENDER';
  return out;
}
