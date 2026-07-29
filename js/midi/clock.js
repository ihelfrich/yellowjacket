// MIDI clock master (ClockOut) and slave-tempo estimator (ClockIn) per
// CONTRACT-WIRE.md section 3. The scheduling core is pure and node-tested;
// ClockOut only glues it to an AudioContext and a MidiWire-shaped output.

const PPQN = 24; // MIDI beat clock: 24 ticks per quarter (0xF8)
const PASS_MS = 25; // lookahead pass interval
const HORIZON_SEC = 0.08; // short on purpose: tempo changes reach the wire
// within a pass; scheduled bytes cannot be recalled.
const CLOCK_WINDOW = 24; // ClockIn windowed mean over last 24 accepted intervals
const OUTLIER_FRAC = 0.3; // reject intervals outside +/-30% of the estimate

// Pure scheduling core. phase is the audio-context time (sec) of the next tick
// to emit; pass null on a fresh start and thread the returned phase between
// windows. The period accumulates from the previous tick and is never
// recomputed from bar arithmetic, so a bpm change never jumps phase.
export function planTicks(fromSec, toSec, bpm, phase) {
  const period = 60 / (bpm * PPQN);
  let next = phase == null ? fromSec : phase;
  // A stalled tab leaves the phase far behind the window. Emitting every tick
  // it missed sends hundreds of bytes stamped in the past, which arrive as one
  // burst and shove the slave instead of resuming (Codex finding 10: a 10 s
  // stall produced 484 ticks for an 80 ms window). Skip forward on the grid.
  if (period > 0 && next < fromSec) {
    next += Math.ceil((fromSec - next) / period) * period;
  }
  const ticks = [];
  while (next < toSec) {
    ticks.push(next);
    next += period;
  }
  return { ticks, phase: next };
}

// Audio-clock -> DOMHighResTimeStamp conversion (CONTRACT-WIRE.md section 2).
// The {contextTime, performanceTime} pair must be re-sampled every pass.
export function midiTimestampFor(tAudio, contextTime, performanceTime) {
  return performanceTime + (tAudio - contextTime) * 1000;
}

export class ClockOut {
  constructor() {
    this._ctx = null;
    this._out = null;
    this._machine = null;
    this._timer = 0;
    this._running = false;
    this._phase = null;
    this._pendingStart = false;
  }

  // out: anything with send(bytes, midiTs), normally the MidiWire.
  // machineRef: read for .bpm live each pass, never cached.
  start(ctx, out, machineRef) {
    this._teardown(false);
    this._ctx = ctx;
    this._out = out;
    this._machine = machineRef;
    this._timer = setInterval(() => this._pass(), PASS_MS);
  }

  stop() {
    this._teardown(true);
  }

  // Driven by the integrator from the machine transport: 0xFA immediately
  // before the first tick, 0xFC on stop, ticks only while running.
  setRunning(running) {
    const on = !!running;
    if (on === this._running) return;
    this._running = on;
    if (on) {
      this._phase = null;
      this._pendingStart = true;
      this._pass(); // do not wait up to 25 ms for the first tick
    } else {
      this._phase = null;
      this._pendingStart = false;
      // Immediate, unscheduled send: already-scheduled ticks cannot be
      // recalled, but the 80 ms horizon keeps that tail short.
      if (this._out) this._out.send([0xFC]);
    }
  }

  _teardown(sendStop) {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = 0;
    }
    if (sendStop && this._running && this._out) this._out.send([0xFC]);
    this._running = false;
    this._phase = null;
    this._pendingStart = false;
    this._ctx = null;
    this._out = null;
    this._machine = null;
  }

  _pass() {
    if (!this._running || !this._ctx || !this._out || !this._machine) return;
    const bpm = this._machine.bpm;
    if (!(bpm > 0)) return;
    const { contextTime, performanceTime } = this._now();
    const plan = planTicks(contextTime, contextTime + HORIZON_SEC, bpm, this._phase);
    this._phase = plan.phase;
    for (let i = 0; i < plan.ticks.length; i++) {
      const ts = midiTimestampFor(plan.ticks[i], contextTime, performanceTime);
      if (this._pendingStart) {
        // Same timestamp, sent first: Web MIDI preserves send order for
        // equal timestamps, so 0xFA lands immediately before the first tick.
        this._out.send([0xFA], ts);
        this._pendingStart = false;
      }
      this._out.send([0xF8], ts);
    }
  }

  _now() {
    if (typeof this._ctx.getOutputTimestamp === 'function') {
      const t = this._ctx.getOutputTimestamp();
      if (t && typeof t.contextTime === 'number') return t;
    }
    // Fallback where getOutputTimestamp is unimplemented: currentTime lags the
    // true output boundary but stays self-consistent across passes.
    return { contextTime: this._ctx.currentTime, performanceTime: performance.now() };
  }
}

// Interval estimator over incoming 0xF8 event.timeStamp deltas. Slave mode is
// display-and-adopt: the UI shows bpm, ADOPT snaps machine.bpm on user action,
// nothing auto-adopts and nothing chases per-tick (CONTRACT-WIRE.md section 2).
export class ClockIn {
  constructor() {
    this.reset();
  }

  // Call on transport messages or port change.
  reset() {
    this._last = null;
    this._intervals = [];
    this._streak = 0;
  }

  // One call per incoming 0xF8, with the event.timeStamp in ms.
  feed(timeStampMs) {
    if (this._last == null) {
      this._last = timeStampMs;
      return;
    }
    const interval = timeStampMs - this._last;
    this._last = timeStampMs;
    if (!(interval > 0)) {
      this._streak = 0;
      return;
    }
    const mean = this._mean();
    if (mean != null && Math.abs(interval - mean) > OUTLIER_FRAC * mean) {
      // Outlier: estimate untouched, stability streak broken.
      this._streak = 0;
      return;
    }
    this._intervals.push(interval);
    if (this._intervals.length > CLOCK_WINDOW) this._intervals.shift();
    this._streak += 1;
  }

  get bpm() {
    const mean = this._mean();
    return mean == null ? null : 60000 / (PPQN * mean);
  }

  get stable() {
    return this._streak >= CLOCK_WINDOW;
  }

  _mean() {
    const n = this._intervals.length;
    if (n === 0) return null;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += this._intervals[i];
    return sum / n;
  }
}
