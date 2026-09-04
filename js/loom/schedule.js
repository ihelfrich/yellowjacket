// One direct-source semantic voice path for Loom audition, Machine playback,
// and offline performance print. The event is already compiled; this module
// performs no musical decisions and never copies source PCM.

export const SEMANTIC_EDGE_FADE_SEC = 0.008;
export const SEMANTIC_RATE_MIN = 0.5;
export const SEMANTIC_RATE_MAX = 2;

// The pitch ratio a semantic event will actually play at. The excerpt builder
// and the scheduler must agree on it exactly, or the buffer's rate and the
// node's playbackRate stop cancelling and the pitch is wrong.
export function semanticRate(event) {
  // Guard the event before coercing: Number(null) is 0, which would clamp to
  // half speed and pitch a missing event down an octave instead of leaving it
  // alone. Only a real, finite rate is clamped.
  if (!event) return 1;
  const r = Number(event.rate);
  return Number.isFinite(r) ? Math.max(SEMANTIC_RATE_MIN, Math.min(SEMANTIC_RATE_MAX, r)) : 1;
}

function clamp(value, low, high, fallback = low) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(low, Math.min(high, number)) : fallback;
}

export function scheduleSemanticEvent({
  ctx, destination, sourceBuffer, event, when, voices = null, offsetSec = null,
} = {}) {
  if (!ctx || !destination || !sourceBuffer || !event) return null;
  // `offsetSec` overrides the event's own offset when the buffer is an
  // excerpt rather than the whole recording (js/loom/excerpt.js); everything
  // downstream is unchanged, so no event object is cloned per hit.
  const wanted = offsetSec == null ? event.sourceOffsetSec : offsetSec;
  const offset = clamp(wanted, 0, sourceBuffer.duration, 0);
  const requestedSpan = clamp(event.sourceSpanSec, 0, sourceBuffer.duration - offset, 0);
  if (!(requestedSpan > 0)) return null;
  const rate = semanticRate(event);
  const gainValue = clamp(event.gain, 0, 1, 0);
  if (!(gainValue > 0)) return null;
  const startAt = Math.max(Number(ctx.currentTime) || 0, Number(when) || 0);
  const naturalDuration = requestedSpan / rate;
  const requestedDuration = Number(event.outDurationSec);
  const outputDuration = Number.isFinite(requestedDuration) && requestedDuration > 0
    ? Math.min(naturalDuration, requestedDuration) : naturalDuration;
  if (!(outputDuration > 0)) return null;
  const sourceSpan = Math.min(requestedSpan, outputDuration * rate);
  const stopAt = startAt + outputDuration;

  const src = ctx.createBufferSource();
  const gainNode = ctx.createGain();
  const panNode = typeof ctx.createStereoPanner === 'function'
    ? ctx.createStereoPanner() : ctx.createGain();
  src.buffer = sourceBuffer;
  src.playbackRate.setValueAtTime(rate, startAt);
  if (panNode.pan) panNode.pan.setValueAtTime(clamp(event.pan, -1, 1, 0), startAt);
  const fade = Math.min(SEMANTIC_EDGE_FADE_SEC, outputDuration * 0.22);
  gainNode.gain.setValueAtTime(0.0001, startAt);
  gainNode.gain.linearRampToValueAtTime(gainValue, startAt + fade);
  gainNode.gain.setValueAtTime(gainValue, Math.max(startAt + fade, stopAt - fade));
  gainNode.gain.linearRampToValueAtTime(0.0001, stopAt);
  src.connect(gainNode).connect(panNode).connect(destination);

  // Aliases keep both existing owner cleanup paths compatible while the voice
  // itself has one canonical graph shape.
  const voice = {
    src, source: src, gainNode, gain: gainNode, panNode,
    eventId: event.eventId || event.id || null,
  };
  if (voices) voices.add(voice);
  src.onended = () => {
    if (voices) voices.delete(voice);
    src.onended = null;
    try { src.disconnect(); } catch (error) { /* already disconnected */ }
    try { gainNode.disconnect(); } catch (error) { /* already disconnected */ }
    try { panNode.disconnect(); } catch (error) { /* already disconnected */ }
  };
  try {
    src.start(startAt, offset, sourceSpan);
    src.stop(stopAt + 0.002);
  } catch (error) {
    if (voices) voices.delete(voice);
    return null;
  }
  return { voice, startAt, stopAt, outputDuration };
}
