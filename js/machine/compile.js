const DEFAULT_BPM = 120;
const DEFAULT_SWING = 50;
const DEFAULT_LOOP_STEPS = 16;
const MAX_LOOP_STEPS = 256;

export function stepTime(step, bpm, swing) {
  const g = Math.trunc(Number(step));
  if (!Number.isFinite(g)) return 0;
  const stepDur = 60 / normalizedBpm(bpm) / 4;
  const pair = Math.floor(g / 2);
  if (g % 2 === 0) return pair * stepDur * 2;
  return pair * stepDur * 2 + stepDur * 2 * swingRatio(swing);
}

export function patternLoopSteps(tracks) {
  let loop = 1;
  let found = false;
  for (const track of Array.isArray(tracks) ? tracks : []) {
    if (!track || !track.sample) continue;
    const len = trackLength(track);
    if (!hasPlayableStep(track.steps, len)) continue;
    found = true;
    loop = lcm(loop, len);
    if (loop >= MAX_LOOP_STEPS) return MAX_LOOP_STEPS;
  }
  return found ? loop : DEFAULT_LOOP_STEPS;
}

export function compileWindow(machine, fromSec, toSec) {
  const from = Number(fromSec);
  const to = Number(toSec);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];

  const bpm = normalizedBpm(machine && machine.bpm);
  const swing = normalizedSwing(machine && machine.swing);
  const tracks = machine && Array.isArray(machine.tracks) ? machine.tracks : [];
  const anySolo = tracks.some((track) => track && track.solo);
  const prepared = [];
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    const track = tracks[trackIndex];
    if (!track || !track.sample || !track.steps) continue;
    const gainDb = clamp(finiteOr(track.gainDb, 0), -24, 6);
    prepared.push({
      track: trackIndex,
      steps: track.steps,
      len: trackLength(track),
      gain: track.mute || (anySolo && !track.solo) ? 0 : Math.pow(10, gainDb / 20),
      pan: clamp(finiteOr(track.pan, 0), -1, 1),
    });
  }
  if (!prepared.length) return [];

  const events = [];
  const pairDur = 60 / bpm / 2;
  const oddOffset = pairDur * swingRatio(swing);
  const firstPair = Math.max(0, Math.floor(from / pairDur) - 1);
  const endPair = Math.max(firstPair, Math.ceil(to / pairDur));
  for (let pair = firstPair; pair < endPair; pair++) {
    const evenStep = pair * 2;
    const pairTime = pair * pairDur;
    appendStepEvents(events, prepared, evenStep, pairTime, from, to);
    appendStepEvents(events, prepared, evenStep + 1, pairTime + oddOffset, from, to);
  }
  return events;
}

export function compileRender(machine, loops) {
  const count = Math.max(0, Math.floor(finiteOr(loops, 0)));
  const loopSteps = patternLoopSteps(machine && machine.tracks);
  const stepDur = 60 / normalizedBpm(machine && machine.bpm) / 4;
  const loopSec = loopSteps * stepDur;
  const totalSec = loopSec * count;
  return {
    events: compileWindow(machine, 0, totalSec),
    loopSec,
    totalSec,
  };
}

function appendStepEvents(events, tracks, globalStep, tSec, fromSec, toSec) {
  if (tSec < fromSec || tSec >= toSec) return;
  for (const track of tracks) {
    if (track.steps[globalStep % track.len]) {
      events.push({
        tSec,
        track: track.track,
        gain: track.gain,
        pan: track.pan,
      });
    }
  }
}

function normalizedBpm(value) {
  const bpm = Number(value);
  return Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_BPM;
}

function normalizedSwing(value) {
  return clamp(finiteOr(value, DEFAULT_SWING), 50, 70);
}

function swingRatio(value) {
  const swing = normalizedSwing(value);
  // Grooveboxes label triplet swing as 66 even though its exact ratio is 2/3.
  return swing === 66 ? 2 / 3 : swing / 100;
}

function trackLength(track) {
  return clamp(Math.floor(finiteOr(track && track.len, DEFAULT_LOOP_STEPS)), 4, 64);
}

function hasPlayableStep(steps, len) {
  if (!steps) return false;
  const count = Math.min(len, steps.length >>> 0);
  for (let i = 0; i < count; i++) {
    if (steps[i]) return true;
  }
  return false;
}

function gcd(a, b) {
  while (b) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

function lcm(a, b) {
  return (a / gcd(a, b)) * b;
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
