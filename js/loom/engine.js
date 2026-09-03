// One-shot Loom audition renderer. The immutable source remains the only PCM;
// a weave is a set of timestamped offset/rate recipes into that buffer.

import { scheduleSemanticEvent } from './schedule.js';

const START_DELAY = 0.045;

export function loomHeadroomGain(plan, sourceDuration = Infinity) {
  const points = [];
  for (const event of plan && Array.isArray(plan.events) ? plan.events : []) {
    const origin = event.source || {};
    const start = Math.max(0, Number(origin.startSec) || 0);
    const end = Math.max(start, Math.min(sourceDuration, Number(origin.endSec) || start));
    const span = end - start;
    if (!(span > 0)) continue;
    const rate = Math.max(0.5, Math.min(2, Number(event.transform && event.transform.rate) || 1));
    const outStart = Math.max(0, Number(event.outStartSec) || 0);
    const velocity = Math.max(0.02, Math.min(0.92, Number(event.gesture && event.gesture.velocity) || 0.8));
    points.push({ at: outStart, delta: velocity, order: 1 });
    points.push({ at: outStart + span / rate, delta: -velocity, order: 0 });
  }
  points.sort((a, b) => a.at - b.at || a.order - b.order);
  let sum = 0;
  let peak = 0;
  for (const point of points) {
    sum += point.delta;
    peak = Math.max(peak, sum);
  }
  return Math.min(0.72, 0.9 / Math.max(1, peak));
}

export class LoomEngine extends EventTarget {
  constructor(engine) {
    super();
    this.engine = engine;
    this.playing = false;
    this._voices = new Set();
    this._timers = new Set();
    this._bus = null;
    this._token = 0;
  }

  play(plan) {
    this.stop();
    if (!plan || !Array.isArray(plan.events) || !plan.events.length) return false;
    const buffer = this.engine.buffer;
    const ctx = this.engine.wakeTransport ? this.engine.wakeTransport() : this.engine.wake();
    const master = this.engine.transport ? this.engine.transport.master : this.engine.master;
    if (!buffer || !ctx || !master) return false;
    const token = ++this._token;
    const anchor = ctx.currentTime + START_DELAY;
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(loomHeadroomGain(plan, buffer.duration), anchor);
    bus.connect(master);
    this._bus = bus;
    let endAt = anchor;
    this.playing = true;
    this.dispatchEvent(new CustomEvent('state', { detail: { playing: true } }));

    for (const event of plan.events) {
      const origin = event.source || {};
      const offset = Math.max(0, Math.min(buffer.duration, Number(origin.startSec) || 0));
      const end = Math.max(offset, Math.min(buffer.duration, Number(origin.endSec) || offset));
      const span = end - offset;
      if (!(span > 0)) continue;
      const rate = Math.max(0.5, Math.min(2, Number(event.transform && event.transform.rate) || 1));
      const when = anchor + Math.max(0, Number(event.outStartSec) || 0);
      const outputDuration = span / rate;
      const stopAt = when + outputDuration;
      endAt = Math.max(endAt, stopAt);

      const peak = Math.max(0.02, Math.min(0.92, Number(event.gesture && event.gesture.velocity) || 0.8));
      const voiceNumber = Number(event.transform && event.transform.voice) || 1;
      scheduleSemanticEvent({
        ctx,
        destination: bus,
        sourceBuffer: buffer,
        when,
        voices: this._voices,
        event: {
          eventId: event.id,
          sourceOffsetSec: offset,
          sourceSpanSec: span,
          rate,
          gain: peak,
          pan: ((voiceNumber - 1) % 4 - 1.5) * 0.16,
          outDurationSec: outputDuration,
        },
      });

      this._later(Math.max(0, (when - ctx.currentTime) * 1000), token, () => {
        this.dispatchEvent(new CustomEvent('event', { detail: { id: event.id } }));
      });
    }

    this._later(Math.max(0, (endAt - ctx.currentTime) * 1000 + 40), token, () => {
      if (this._bus === bus) this._bus = null;
      try { bus.disconnect(); } catch (error) { /* already disconnected */ }
      this.playing = false;
      this.dispatchEvent(new CustomEvent('event', { detail: { id: null } }));
      this.dispatchEvent(new CustomEvent('state', { detail: { playing: false } }));
    });
    return true;
  }

  stop() {
    const wasPlaying = this.playing;
    this._token++;
    for (const timer of this._timers) clearTimeout(timer);
    this._timers.clear();
    const ctx = this.engine.transport ? this.engine.transport.ctx : this.engine.ctx;
    const now = ctx ? ctx.currentTime : 0;
    for (const voice of this._voices) {
      try {
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setTargetAtTime(0.0001, now, 0.008);
        voice.source.stop(now + 0.045);
      } catch (error) { /* already ended */ }
    }
    this._voices.clear();
    const bus = this._bus;
    this._bus = null;
    if (bus) {
      try {
        bus.gain.cancelScheduledValues(now);
        bus.gain.setTargetAtTime(0.0001, now, 0.008);
        setTimeout(() => {
          try { bus.disconnect(); } catch (error) { /* already disconnected */ }
        }, 60);
      } catch (error) { /* context already closed */ }
    }
    this.playing = false;
    if (wasPlaying) {
      this.dispatchEvent(new CustomEvent('event', { detail: { id: null } }));
      this.dispatchEvent(new CustomEvent('state', { detail: { playing: false } }));
    }
  }

  _later(delay, token, fn) {
    const timer = setTimeout(() => {
      this._timers.delete(timer);
      if (token === this._token) fn();
    }, delay);
    this._timers.add(timer);
  }
}
