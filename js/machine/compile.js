// Pattern event compiler. The single source of musical truth: live playback and
// offline render both consume ONLY what this module emits, and every random choice
// is seeded (scene seed x cycle x track x step), so a FREEZE is the performance.

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
    // A:B conditions repeat every b track-cycles, so the true pattern period
    // stretches to len * b for each conditioned step.
    const data = track.stepData || {};
    for (const key of Object.keys(data)) {
      const step = Number(key);
      if (!(step >= 0 && step < len) || !track.steps[step]) continue;
      const cond = data[key] && data[key].cond;
      if (cond && typeof cond === 'object' && Number.isFinite(cond.b) && cond.b > 1) {
        loop = lcm(loop, len * Math.min(8, Math.floor(cond.b)));
      }
      if (loop >= MAX_LOOP_STEPS) return MAX_LOOP_STEPS;
    }
    if (loop >= MAX_LOOP_STEPS) return MAX_LOOP_STEPS;
  }
  return found ? Math.min(loop, MAX_LOOP_STEPS) : DEFAULT_LOOP_STEPS;
}

// Seeded per-hit randomness: identical across live windows and offline render.
function rand01(seed, cycle, track, step) {
  let h = (seed ^ Math.imul(cycle + 1, 2654435761) ^ Math.imul(track + 1, 40503) ^ Math.imul(step + 1, 9973)) >>> 0;
  h = (h + 0x6d2b79f5) | 0;
  let t = Math.imul(h ^ (h >>> 15), 1 | h);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function compileWindow(machine, fromSec, toSec, opts = {}) {
  const from = Number(fromSec);
  const to = Number(toSec);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return { events: [], ducks: [] };
  }
  const fill = !!opts.fill;
  const bpm = normalizedBpm(machine && machine.bpm);
  const swing = normalizedSwing(machine && machine.swing);
  const seed = sceneSeed(machine);
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
      data: track.stepData || {},
      len: trackLength(track),
      silent: !!track.mute || (anySolo && !track.solo),
      gain: Math.pow(10, gainDb / 20),
      pan: clamp(finiteOr(track.pan, 0), -1, 1),
    });
  }
  // Duck routing: source track index -> [{ track, depthDb }]
  const duckTargets = new Map();
  for (let t = 0; t < tracks.length; t++) {
    const track = tracks[t];
    if (!track) continue;
    const src = Math.trunc(finiteOr(track.duckSource, -1));
    if (src >= 0 && src < tracks.length && src !== t) {
      if (!duckTargets.has(src)) duckTargets.set(src, []);
      duckTargets.get(src).push({ track: t, depthDb: clamp(finiteOr(track.duckDb, 12), 0, 24) });
    }
  }
  if (!prepared.length) return { events: [], ducks: [] };

  const events = [];
  const ducks = [];
  const stepDur = 60 / bpm / 4;
  const pairDur = stepDur * 2;
  const oddOffset = pairDur * swingRatio(swing);
  // Nudge (up to half a step each way) and ratchets never move a hit more than one
  // pair away from its nominal slot; scan wide, filter per hit.
  const firstPair = Math.max(0, Math.floor(from / pairDur) - 2);
  const endPair = Math.max(firstPair, Math.ceil(to / pairDur) + 1);

  for (let pair = firstPair; pair < endPair; pair++) {
    const pairTime = pair * pairDur;
    emitStep(pair * 2, pairTime);
    emitStep(pair * 2 + 1, pairTime + oddOffset);
  }
  events.sort((a, b) => a.tSec - b.tSec || a.track - b.track || a.ratchetIndex - b.ratchetIndex);
  ducks.sort((a, b) => a.tSec - b.tSec || a.track - b.track);
  return { events, ducks };

  function emitStep(globalStep, tNominal) {
    for (const p of prepared) {
      const localStep = globalStep % p.len;
      if (!p.steps[localStep]) continue;
      const sd = p.data[localStep];
      const cycle = Math.floor(globalStep / p.len);

      if (sd) {
        const cond = sd.cond;
        if (cond === 'fill' && !fill) continue;
        if (cond === 'notfill' && fill) continue;
        if (cond && typeof cond === 'object') {
          const b = clamp(Math.floor(finiteOr(cond.b, 1)), 1, 8);
          const a = clamp(Math.floor(finiteOr(cond.a, 1)), 1, b);
          if (b > 1 && cycle % b !== a - 1) continue;
        }
        const prob = clamp(finiteOr(sd.prob, 100), 1, 100);
        if (prob < 100 && rand01(seed, cycle, p.track, localStep) * 100 >= prob) continue;
      }

      const velocity = clamp(finiteOr(sd && sd.velocity, 1), 0.05, 1);
      const lockGain = sd && sd.gainDb !== undefined && sd.gainDb !== null
        ? Math.pow(10, clamp(finiteOr(sd.gainDb, 0), -24, 6) / 20) : null;
      const gain = p.silent ? 0 : (lockGain !== null ? lockGain : p.gain) * velocity;
      const pan = sd && sd.pan !== undefined && sd.pan !== null
        ? clamp(finiteOr(sd.pan, 0), -1, 1) : p.pan;
      const pitch = clamp(finiteOr(sd && sd.pitch, 0), -12, 12);
      const rate = Math.pow(2, pitch / 12);
      const reverse = !!(sd && sd.reverse);
      const gateFrac = sd && sd.gate ? clamp(finiteOr(sd.gate, 0), 0.05, 4) : 0;
      const durSec = gateFrac ? gateFrac * stepDur : null;
      const nudge = clamp(finiteOr(sd && sd.nudge, 0), -0.5, 0.5);
      const ratchet = clamp(Math.floor(finiteOr(sd && sd.ratchet, 1)), 1, 4);
      const base = Math.max(0, tNominal + nudge * stepDur);

      for (let k = 0; k < ratchet; k++) {
        const tSec = base + (k * stepDur) / ratchet;
        if (tSec < from || tSec >= to) continue;
        events.push({ tSec, track: p.track, gain, pan, rate, reverse, durSec, ratchetIndex: k });
        const targets = duckTargets.get(p.track);
        if (targets && gain > 0) {
          for (const target of targets) {
            ducks.push({ tSec, track: target.track, depthDb: target.depthDb });
          }
        }
      }
    }
  }
}

export function compileRender(machine, loops, opts = {}) {
  const count = Math.max(0, Math.floor(finiteOr(loops, 0)));
  const loopSteps = patternLoopSteps(machine && machine.tracks);
  const stepDur = 60 / normalizedBpm(machine && machine.bpm) / 4;
  const loopSec = loopSteps * stepDur;
  const totalSec = loopSec * count;
  const { events, ducks } = compileWindow(machine, 0, totalSec, opts);
  return { events, ducks, loopSec, totalSec };
}

function sceneSeed(machine) {
  if (machine && Array.isArray(machine.scenes)) {
    const scene = machine.scenes[machine.activeScene | 0];
    if (scene && Number.isFinite(scene.seed)) return scene.seed >>> 0;
  }
  return 0x9e3779b9;
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
