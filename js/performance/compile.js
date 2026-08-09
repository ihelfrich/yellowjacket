// Yellowjacket semantic-performance compiler. This module is deliberately pure:
// it joins the existing Machine event stream to a scene-local Loom lane without
// knowing about DOM, Web Audio, source buffers, MIDI ports, or scheduler state.

import { compileRender, compileWindow, stepTime } from '../machine/compile.js';

const DEFAULT_REPEAT_STEPS = 16;
const DEFAULT_LANE_GAIN_DB = -9;
const DEFAULT_BPM = 120;
const DEFAULT_SWING = 50;
const MAX_REPEAT_STEPS = 256;
const MAX_START_STEP = 4096;
const NOMINAL_HEADROOM = 0.72;
const PEAK_BUDGET = 0.9;
const MIN_RATE = 0.5;
const MAX_RATE = 2;
const MIN_VELOCITY = 0.02;
const MAX_VELOCITY = 0.92;
const HEADROOM_SWEEP_CAP = 2048;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function bpmOf(scene) {
  const bpm = Number(scene && scene.bpm);
  return Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_BPM;
}

function swingOf(scene) {
  return clamp(finite(scene && scene.swing, DEFAULT_SWING), 50, 70);
}

function laneState(lane) {
  const repeatSteps = clamp(Math.round(finite(lane && lane.repeatSteps,
    DEFAULT_REPEAT_STEPS)), 1, MAX_REPEAT_STEPS);
  return {
    planId: lane && lane.planId != null ? String(lane.planId) : null,
    enabled: !!lane && lane.enabled !== false,
    gainDb: clamp(finite(lane && lane.gainDb, DEFAULT_LANE_GAIN_DB), -60, 6),
    pan: clamp(finite(lane && lane.pan, 0), -1, 1),
    repeatSteps,
    startStep: clamp(finite(lane && lane.startStep, 0), 0, MAX_START_STEP),
  };
}

// stepTime() is exact at integer boundaries, including Yellowjacket's special
// triplet value at swing 66. Linear interpolation inside one destination step
// leaves the contract ready for a later unquantized MIDI adapter.
function gridTime(gridStep, scene) {
  const position = Math.max(0, finite(gridStep));
  const whole = Math.floor(position);
  const fraction = position - whole;
  const bpm = bpmOf(scene);
  const swing = swingOf(scene);
  const at = stepTime(whole, bpm, swing);
  if (fraction === 0) return at;
  return at + (stepTime(whole + 1, bpm, swing) - at) * fraction;
}

function planIdOf(plan, lane) {
  if (lane.planId) return lane.planId;
  if (plan && plan.id != null) return String(plan.id);
  return 'loom-plan';
}

function preparedEvents(plan, lane) {
  const source = plan && Array.isArray(plan.events) ? plan.events : [];
  const out = [];
  const ids = new Map();
  for (let index = 0; index < source.length; index++) {
    const event = source[index];
    if (!event || typeof event !== 'object') continue;
    const origin = event.source;
    const startSec = finite(origin && origin.startSec, -1);
    const endSec = finite(origin && origin.endSec, -1);
    if (!origin || startSec < 0 || !(endSec > startSec)) continue;
    const rawGrid = event.gridStep != null ? Number(event.gridStep) : Number(event.stepIndex);
    if (!Number.isFinite(rawGrid) || rawGrid < 0 || rawGrid >= lane.repeatSteps) continue;
    const transform = event.transform && typeof event.transform === 'object'
      ? event.transform : {};
    const rate = clamp(finite(transform.rate, 1), MIN_RATE, MAX_RATE);
    const gesture = event.gesture && typeof event.gesture === 'object' ? event.gesture : {};
    const velocity = clamp(finite(gesture.velocity, 0.8), MIN_VELOCITY, MAX_VELOCITY);
    const eventId = event.id != null ? String(event.id) : 'event-' + String(index + 1);
    const duplicate = ids.get(eventId) || 0;
    ids.set(eventId, duplicate + 1);
    // A valid plan supplies unique stable ids. Keep their public form untouched,
    // but disambiguate malformed duplicates deterministically so occurrence ids
    // can still satisfy the scheduler's exactly-once contract.
    const eventKey = duplicate ? eventId + '#duplicate-' + duplicate : eventId;
    out.push({
      ordinal: index,
      eventId,
      eventKey,
      gridStep: rawGrid,
      source: { ...origin, startSec, endSec },
      gesture: { ...gesture },
      transform: { ...transform, rate },
      rate,
      velocity,
      durationSec: (endSec - startSec) / rate,
    });
  }
  return out;
}

function cyclePeriodBounds(scene, lane, gridStep = 0) {
  const base = lane.startStep + gridStep;
  let minimum = Infinity;
  let maximum = 0;
  // Odd repeat lengths alternate swing phase. Four differences cover both
  // parities as well as fractional grid positions.
  for (let cycle = 0; cycle < 4; cycle++) {
    const a = gridTime(base + cycle * lane.repeatSteps, scene);
    const b = gridTime(base + (cycle + 1) * lane.repeatSteps, scene);
    const span = b - a;
    if (span > 0) {
      minimum = Math.min(minimum, span);
      maximum = Math.max(maximum, span);
    }
  }
  const fallback = lane.repeatSteps * (60 / bpmOf(scene) / 4);
  return {
    minimum: Number.isFinite(minimum) ? minimum : fallback,
    maximum: maximum > 0 ? maximum : fallback,
  };
}

// Peak simultaneous velocity in the indefinitely repeating lane. A bounded
// sweep gives the exact value for ordinary word/clip material. Pathologically
// long spans use a conservative analytic upper bound rather than allocating an
// unbounded point list.
function overlapPeak(events, lane, scene) {
  if (!events.length) return 0;
  let maxDuration = 0;
  let minimumPeriod = Infinity;
  for (const event of events) {
    maxDuration = Math.max(maxDuration, event.durationSec);
    minimumPeriod = Math.min(minimumPeriod,
      cyclePeriodBounds(scene, lane, event.gridStep).minimum);
  }
  if (!(minimumPeriod > 0)) return events.reduce((sum, event) => sum + event.velocity, 0);
  const warmCycles = Math.max(2, Math.ceil(maxDuration / minimumPeriod) + 3);
  if (warmCycles > HEADROOM_SWEEP_CAP) {
    return events.reduce((sum, event) => sum
      + event.velocity * (Math.ceil(event.durationSec / minimumPeriod) + 1), 0);
  }

  const points = [];
  // Two more cycles expose the steady-state interval after every possible tail
  // has entered the sum; odd repeat lengths need both swing phases.
  const cycles = warmCycles + (lane.repeatSteps % 2 ? 2 : 1);
  for (let cycle = 0; cycle <= cycles; cycle++) {
    for (const event of events) {
      const at = gridTime(lane.startStep + event.gridStep
        + cycle * lane.repeatSteps, scene);
      points.push({ at, delta: event.velocity, order: 1 });
      points.push({ at: at + event.durationSec, delta: -event.velocity, order: 0 });
    }
  }
  points.sort((a, b) => a.at - b.at || a.order - b.order);
  let active = 0;
  let peak = 0;
  for (const point of points) {
    active += point.delta;
    peak = Math.max(peak, active);
  }
  return peak;
}

function traceFor(event, planId, scene, cycle, tSec) {
  const outEndSec = tSec + event.durationSec;
  const sceneId = scene && scene.id != null ? String(scene.id) : null;
  return {
    planId,
    eventId: event.eventId,
    eventKey: event.eventKey,
    cycle,
    sceneId,
    gridStep: event.gridStep,
    outStartSec: tSec,
    outEndSec,
    sourceStartSec: event.source.startSec,
    sourceEndSec: event.source.endSec,
    source: { ...event.source },
    gesture: { ...event.gesture },
    transform: { ...event.transform },
  };
}

function compareEvents(a, b) {
  if (a.tSec !== b.tSec) return a.tSec - b.tSec;
  // Code-unit ordering, not localeCompare: compilation must not depend on the
  // user's locale or the ICU build bundled with a particular browser.
  if (a.eventKey < b.eventKey) return -1;
  if (a.eventKey > b.eventKey) return 1;
  if (a.cycle !== b.cycle) return a.cycle - b.cycle;
  return a.ordinal - b.ordinal;
}

/**
 * Compile one immutable Loom plan against a destination Machine scene.
 * Starts are grid-retargeted to the scene BPM/swing and repeated on the lane's
 * step period. Only onsets in the half-open [fromSec,toSec) window are emitted.
 */
export function compileLoomWindow(plan, laneInput, scene, fromSec, toSec) {
  const from = Number(fromSec);
  const to = Number(toSec);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const lane = laneState(laneInput);
  if (!plan || !lane.enabled) return [];
  const prepared = preparedEvents(plan, lane);
  if (!prepared.length) return [];

  const planId = planIdOf(plan, lane);
  const laneGain = Math.pow(10, lane.gainDb / 20);
  const peak = overlapPeak(prepared, lane, scene);
  // Include lane trim in the safety calculation: even a +6 dB lane cannot make
  // the sum of its concurrently active source envelopes exceed PEAK_BUDGET.
  const headroomGain = Math.min(NOMINAL_HEADROOM,
    PEAK_BUDGET / Math.max(1, peak * laneGain));
  const semanticEvents = [];

  for (const event of prepared) {
    const firstGrid = lane.startStep + event.gridStep;
    const firstTime = gridTime(firstGrid, scene);
    const periods = cyclePeriodBounds(scene, lane, event.gridStep);
    // These bounds deliberately over-scan by two cycles. The exact gridTime
    // filter below is authoritative and keeps seams duplicate-free.
    const firstCycle = Math.max(0,
      Math.floor((from - firstTime) / periods.maximum) - 2);
    const lastCycle = Math.max(firstCycle,
      Math.ceil((to - firstTime) / periods.minimum) + 2);
    for (let cycle = firstCycle; cycle <= lastCycle; cycle++) {
      const tSec = gridTime(firstGrid + cycle * lane.repeatSteps, scene);
      if (tSec < from || tSec >= to) continue;
      const trace = traceFor(event, planId, scene, cycle, tSec);
      semanticEvents.push({
        kind: 'loom',
        id: planId + ':' + event.eventKey + ':cycle-' + cycle,
        planId,
        eventId: event.eventId,
        eventKey: event.eventKey,
        ordinal: event.ordinal,
        cycle,
        tSec,
        outEndSec: trace.outEndSec,
        sourceOffsetSec: event.source.startSec,
        sourceSpanSec: event.source.endSec - event.source.startSec,
        rate: event.rate,
        gain: laneGain * headroomGain * event.velocity,
        pan: lane.pan,
        outDurationSec: event.durationSec,
        headroomGain,
        trace,
      });
    }
  }
  semanticEvents.sort(compareEvents);
  return semanticEvents;
}

function activeScene(machine) {
  if (machine && Array.isArray(machine.scenes)) {
    return machine.scenes[machine.activeScene | 0] || null;
  }
  return machine || null;
}

function planFromRegistry(plans, id) {
  if (id == null || plans == null) return null;
  if (plans instanceof Map) return plans.get(id) || plans.get(String(id)) || null;
  if (typeof plans === 'object') return plans[id] || plans[String(id)] || null;
  return null;
}

function lineageOf(events) {
  return events.map((event) => ({ id: event.id, ...event.trace }));
}

/** Compose the existing Machine compiler with the active scene's Loom lane. */
export function compilePerformanceWindow(machine, plans, fromSec, toSec, opts = {}) {
  const compiled = compileWindow(machine, fromSec, toSec, opts);
  const scene = activeScene(machine);
  const lane = scene && scene.loomLane;
  const normalizedLane = laneState(lane);
  const plan = normalizedLane.enabled
    ? planFromRegistry(plans, normalizedLane.planId) : null;
  const semanticEvents = compileLoomWindow(plan, lane, scene, fromSec, toSec);
  return {
    events: compiled.events,
    ducks: compiled.ducks,
    semanticEvents,
    lineage: lineageOf(semanticEvents),
  };
}

/** Compile a complete Machine render and the matching semantic event/lineage map. */
export function compilePerformanceRender(machine, plans, loops, opts = {}) {
  const compiled = compileRender(machine, loops, opts);
  const scene = activeScene(machine);
  const lane = scene && scene.loomLane;
  const normalizedLane = laneState(lane);
  const plan = normalizedLane.enabled
    ? planFromRegistry(plans, normalizedLane.planId) : null;
  const semanticEvents = compileLoomWindow(plan, lane, scene, 0, compiled.totalSec);
  // The Machine loop defines when new events stop, but a word/source span that
  // begins before that boundary must be allowed to finish. Keep both durations
  // explicit so an offline renderer can allocate the tail without accidentally
  // compiling another Loom cycle into it.
  const semanticEndSec = semanticEvents.reduce((end, event) =>
    Math.max(end, event.outEndSec), 0);
  return {
    events: compiled.events,
    ducks: compiled.ducks,
    semanticEvents,
    lineage: lineageOf(semanticEvents),
    loopSec: compiled.loopSec,
    machineTotalSec: compiled.totalSec,
    totalSec: Math.max(compiled.totalSec, semanticEndSec),
  };
}
