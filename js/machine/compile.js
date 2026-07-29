// Pattern event compiler. The single source of musical truth: live playback and
// offline render both consume ONLY what this module emits, and every random choice
// is seeded (scene seed x cycle x track x step), so a FREEZE is the performance.

const DEFAULT_BPM = 120;
const DEFAULT_SWING = 50;
const DEFAULT_LOOP_STEPS = 16;
const MAX_LOOP_STEPS = 256;
// Voice defaults per CONTRACT-SONG 1; attack/release in ms, trim as fractions.
const VOICE_MIN_SPAN = 0.005;
const VOICE_DEFAULT_ATTACK_MS = 3;
const VOICE_DEFAULT_RELEASE_MS = 8;

// Fills defaults when the voice object or any field is missing, with the
// CONTRACT-SONG 1 clamps. Old saves and untouched tracks normalize to the
// neutral voice, which must compile byte-identically to pre-voice output.
export function normalizeVoice(voice) {
  const v = voice && typeof voice === 'object' ? voice : {};
  let start = clamp(finiteOr(v.start, 0), 0, 1);
  let end = clamp(finiteOr(v.end, 1), 0, 1);
  if (end - start < VOICE_MIN_SPAN) {
    end = Math.min(1, start + VOICE_MIN_SPAN);
    start = Math.max(0, end - VOICE_MIN_SPAN);
  }
  return {
    start,
    end,
    pitch: clamp(finiteOr(v.pitch, 0), -24, 24),
    attack: clamp(finiteOr(v.attack, VOICE_DEFAULT_ATTACK_MS), 1, 500),
    release: clamp(finiteOr(v.release, VOICE_DEFAULT_RELEASE_MS), 2, 2000),
    reverse: !!v.reverse,
  };
}

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
    const voice = normalizeVoice(track.voice);
    const bufSec = sampleSeconds(track.sample);
    prepared.push({
      track: trackIndex,
      steps: track.steps,
      data: track.stepData || {},
      len: trackLength(track),
      silent: !!track.mute || (anySolo && !track.solo),
      gain: Math.pow(10, gainDb / 20),
      pan: clamp(finiteOr(track.pan, 0), -1, 1),
      voicePitch: voice.pitch,
      voiceReverse: voice.reverse,
      // Trim in buffer-domain seconds; reversed playback reads the baked
      // reversed buffer, so its offset flips: (1 - end) * bufSec (CONTRACT-SONG 1).
      trim: (voice.start > 0 || voice.end < 1) && bufSec > 0 ? {
        forward: voice.start * bufSec,
        reversed: (1 - voice.end) * bufSec,
        sliceSec: (voice.end - voice.start) * bufSec,
      } : null,
      attackSec: voice.attack !== VOICE_DEFAULT_ATTACK_MS ? voice.attack / 1000 : null,
      releaseSec: voice.release !== VOICE_DEFAULT_RELEASE_MS ? voice.release / 1000 : null,
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
      // Lock pitch ADDS semitones to voice pitch; lock reverse XORs voice
      // reverse (CONTRACT-SONG 1). Neutral voice reproduces today's values.
      const rate = Math.pow(2, (pitch + p.voicePitch) / 12);
      const reverse = !!(sd && sd.reverse) !== p.voiceReverse;
      const gateFrac = sd && sd.gate ? clamp(finiteOr(sd.gate, 0), 0.05, 4) : 0;
      const durSec = gateFrac ? gateFrac * stepDur : null;
      const nudge = clamp(finiteOr(sd && sd.nudge, 0), -0.5, 0.5);
      const ratchet = clamp(Math.floor(finiteOr(sd && sd.ratchet, 1)), 1, 4);
      const base = Math.max(0, tNominal + nudge * stepDur);

      for (let k = 0; k < ratchet; k++) {
        const tSec = base + (k * stepDur) / ratchet;
        if (tSec < from || tSec >= to) continue;
        const event = { tSec, track: p.track, gain, pan, rate, reverse, durSec, ratchetIndex: k };
        // Voice fields are optional and neutral when absent, so a default
        // voice keeps the event shape identical to pre-voice output.
        if (p.trim) {
          event.offsetSec = reverse ? p.trim.reversed : p.trim.forward;
          event.sliceSec = p.trim.sliceSec;
        }
        if (p.attackSec !== null) event.attackSec = p.attackSec;
        if (p.releaseSec !== null) event.releaseSec = p.releaseSec;
        events.push(event);
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

// Song compiler (CONTRACT-SONG 2): each chain entry compiles through
// compileRender on a scene facade, so a song is literally patterns of
// patterns. Every entry's cycle counter restarts at 0: re-entering a scene
// later in the chain replays the same seeded rolls, deterministically.
export function compileSong(machine, opts = {}) {
  const scenes = machine && Array.isArray(machine.scenes) ? machine.scenes : [];
  const song = machine && machine.song;
  const chain = song && Array.isArray(song.chain) ? song.chain : [];
  const events = [];
  const ducks = [];
  const sections = [];
  let startSec = 0;
  for (const entry of chain) {
    const sceneIndex = clamp(Math.trunc(finiteOr(entry && entry.scene, 0)), 0, 7);
    const scene = scenes[sceneIndex];
    if (!scene) continue;
    const reps = clamp(Math.floor(finiteOr(entry && entry.reps, 1)), 1, 99);
    // Facade: compileRender sees a flat machine with this scene active; each
    // section uses its own scene's bpm/swing. FILL is compiled off for songs.
    const facade = {
      scenes,
      activeScene: sceneIndex,
      tracks: scene.tracks,
      bpm: scene.bpm,
      swing: scene.swing,
    };
    const part = compileRender(facade, reps, { ...opts, fill: false });
    for (const event of part.events) {
      event.tSec += startSec;
      events.push(event);
    }
    for (const seg of part.ducks) {
      seg.tSec += startSec;
      ducks.push(seg);
    }
    const endSec = startSec + part.totalSec;
    sections.push({ scene: sceneIndex, startSec, loopSec: part.loopSec, reps, endSec });
    startSec = endSec;
  }
  return { events, ducks, sections, totalSec: startSec };
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

// Duration matching the AudioBuffer the sequencer bakes: max channel length
// over the rounded sample rate.
function sampleSeconds(sample) {
  const sampleRate = Math.round(Number(sample && sample.sampleRate));
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return 0;
  let frames = 0;
  const channels = sample.channels || [];
  for (const channel of channels) {
    if (channel && Number.isFinite(channel.length)) frames = Math.max(frames, channel.length);
  }
  return frames / sampleRate;
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
