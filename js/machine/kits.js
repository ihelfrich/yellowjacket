// Three deterministic factory kits for MACHINE. This is data + pure planning:
// the existing controller/store/sequencer remain the only install/play paths.

import { DRUM_ENGINE_VERSION, DRUM_OVERSAMPLE, DRUM_RATE, renderFactoryVoice } from './drum-dsp.js';

const neutralVoice = () => ({
  start: 0, end: 1, pitch: 0, attack: 3, release: 8, reverse: false,
  lpf: 20000, res: 0.7, hpf: 20, drive: 0, fitSteps: 0,
});

function V(slot, name, role, model, seconds, seed, params, ceilingDb, gainDb, extra = {}) {
  return {
    slot, name, role, model, seconds, seed, params, ceilingDb,
    outputGainDb: extra.outputGainDb || 0,
    voice: { ...neutralVoice(), ...(extra.voice || {}) },
    mix: {
      gainDb, pan: 0, mute: false, solo: false, duckSource: -1, duckDb: 12,
      choke: false, chokeGroup: 0, sendVerb: 0, sendDelay: 0,
      ...(extra.mix || {}),
    },
  };
}

function G(id, name, lanes, locks = []) {
  return { id, name, lanes, locks };
}

const KITS = [
  {
    id: 'yj-808', name: 'YJ-808', note: 'Deep analog weight, metal hats, and tuned percussion.',
    sampleRate: DRUM_RATE, oversample: DRUM_OVERSAMPLE,
    bpm: 124, swing: 54,
    tracks: [
      V(0, '808 KICK', 'KICK', 'kick', 0.9, 80801,
        { startHz: 188, endHz: 47, pitchTau: 0.023, decay: 0.38, click: 0.045, harmonic: 0.065, saturation: 4.5 }, -9, -7),
      V(1, '808 SNARE', 'SNARE', 'snare', 0.42, 80802,
        { shellHz: 184, shellDecay: 0.12, noiseDecay: 0.17, noise: 0.68, noiseHz: 2150, saturation: 2.5 }, -11, -9),
      V(2, '808 CLAP', 'SNARE', 'clap', 0.38, 80803,
        { centerHz: 1450, q: 0.52, spacing: 0.0115, bursts: 4, tailDecay: 0.15, saturation: 2 }, -13, -11),
      V(3, '808 CLOSED HAT', 'HAT', 'hat', 0.13, 80804,
        { baseHz: 548, decay: 0.052, noise: 0.14, highpassHz: 6400, metalHz: 10800, saturation: 1.2 }, -17, -13,
        { mix: { choke: true, chokeGroup: 1 } }),
      V(4, '808 OPEN HAT', 'HAT', 'hat', 0.72, 80805,
        { baseHz: 548, decay: 0.31, noise: 0.16, highpassHz: 5900, metalHz: 9900, saturation: 1.2 }, -17, -13,
        { mix: { chokeGroup: 1 } }),
      V(5, '808 LOW TOM', 'TONE', 'tom', 0.58, 80806,
        { startHz: 142, endHz: 83, pitchTau: 0.065, decay: 0.31, transient: 0.025, saturation: 3 }, -12, -11),
      V(6, '808 RIM', 'TONE', 'rim', 0.16, 80807,
        { f1: 510, f2: 1710, decay: 0.032, highpassHz: 1750, saturation: 1.5 }, -15, -13),
      V(7, 'LONG 808', '808 BASS', 'kick', 1.72, 80808,
        { startHz: 76, endHz: 41.2, pitchTau: 0.055, decay: 0.92, attack: 0.0035,
          click: 0, harmonic: 0.15, saturation: 4.2, postLowpassHz: 7200 }, -10, -2,
        { outputGainDb: -12, voice: { attack: 4, release: 42 },
          mix: { choke: true, duckSource: 0, duckDb: 8 } }),
    ],
    grooves: [
      G('anchor', 'ANCHOR', ['x...x...x...x...', '....x.......x...', '........x.......', 'x.x.x.x.x.x.x.x.', '......x.........', '................', '..x.......x.....', 'x...x...x...x...'], [
        { track: 3, step: 14, patch: { ratchet: 2, velocity: 0.72 } },
        { track: 0, step: 15, patch: { velocity: 0.62, nudge: 0.12 } },
        { track: 7, step: 0, patch: { pitch: 0, gate: 3.5 } },
        { track: 7, step: 8, patch: { pitch: -5, gate: 3 } },
      ]),
      G('swerve', 'SWERVE', ['x.....x.x.....x.', '....x.......x...', '..x.......x.....', 'x.x.x.x.x.x.x.x.', '.......x.......x', '............x...', '...x......x.....', 'x.....x.x.....x.'], [
        { track: 3, step: 6, patch: { prob: 72 } },
        { track: 5, step: 12, patch: { pitch: -4, velocity: 0.7 } },
        { track: 7, step: 6, patch: { pitch: -7, gate: 2.5 } },
        { track: 7, step: 14, patch: { pitch: -5, gate: 3 } },
      ]),
    ],
  },
  {
    id: 'dust', name: 'DUST', note: 'Warm, compressed knock with frayed high-frequency edges.',
    sampleRate: DRUM_RATE, oversample: DRUM_OVERSAMPLE,
    bpm: 92, swing: 61,
    tracks: [
      V(0, 'DUST KICK', 'KICK', 'kick', 0.72, 41001,
        { startHz: 132, endHz: 54, pitchTau: 0.035, decay: 0.27, click: 0.025, harmonic: 0.15, postLowpassHz: 7200, saturation: 9, asymmetry: 0.025 }, -10, -7),
      V(1, 'DUST SNARE', 'SNARE', 'snare', 0.48, 41002,
        { shellHz: 154, shellDecay: 0.14, noiseDecay: 0.2, noise: 0.61, noiseHz: 1500, postLowpassHz: 8200, saturation: 7 }, -12, -9),
      V(2, 'DUST CLAP', 'SNARE', 'clap', 0.44, 41003,
        { centerHz: 1120, q: 0.58, spacing: 0.014, bursts: 3, tailDecay: 0.2, postLowpassHz: 7600, saturation: 6 }, -14, -11),
      V(3, 'DUST TICK', 'HAT', 'hat', 0.1, 41004,
        { baseHz: 430, decay: 0.035, noise: 0.35, highpassHz: 4800, metalHz: 7600, postLowpassHz: 12500, saturation: 4 }, -18, -13,
        { mix: { choke: true, chokeGroup: 1 } }),
      V(4, 'DUST AIR', 'HAT', 'hat', 0.63, 41005,
        { baseHz: 430, decay: 0.26, noise: 0.48, highpassHz: 4300, metalHz: 7000, postLowpassHz: 13000, saturation: 3 }, -18, -13,
        { mix: { chokeGroup: 1, sendVerb: 0.06 } }),
      V(5, 'DUST CONGA', 'TONE', 'tom', 0.46, 41006,
        { startHz: 248, endHz: 174, pitchTau: 0.045, decay: 0.22, transient: 0.018, saturation: 6 }, -13, -11),
      V(6, 'DUST STICK', 'TONE', 'rim', 0.14, 41007,
        { f1: 390, f2: 1210, decay: 0.045, highpassHz: 1100, postLowpassHz: 6900, saturation: 5 }, -16, -13),
      V(7, 'TAPE SUB', '808 BASS', 'kick', 1.48, 41008,
        { startHz: 69, endHz: 43.65, pitchTau: 0.07, decay: 0.78, attack: 0.004,
          click: 0, harmonic: 0.2, saturation: 7.5, asymmetry: 0.045,
          postLowpassHz: 5100 }, -11, -2,
        { outputGainDb: -14, voice: { attack: 5, release: 48 },
          mix: { choke: true, duckSource: 0, duckDb: 7 } }),
    ],
    grooves: [
      G('pocket', 'POCKET', ['x......xx.......', '....x.......x...', '..........x.....', 'x.x...x.x.x...x.', '..............x.', '......x.........', '..x.........x...', 'x.......x.......'], [
        { track: 0, step: 7, patch: { velocity: 0.58, nudge: 0.1 } },
        { track: 3, step: 15, patch: { prob: 68 } },
        { track: 7, step: 0, patch: { pitch: 0, gate: 3.8 } },
        { track: 7, step: 8, patch: { pitch: -5, gate: 3.2 } },
      ]),
      G('drag', 'DRAG', ['x.........x.....', '....x.......x...', '..............x.', 'x...x.xx..x.x.x.', '.......x........', '..x.........x...', '......x.........', 'x.........x.....'], [
        { track: 1, step: 12, patch: { nudge: 0.18 } },
        { track: 3, step: 7, patch: { ratchet: 3, velocity: 0.55 } },
        { track: 7, step: 10, patch: { pitch: -7, gate: 3.4 } },
      ]),
    ],
  },
  {
    id: 'volt', name: 'VOLT', note: 'Precise digital impact, FM percussion, and bright alloy tails.',
    sampleRate: DRUM_RATE, oversample: DRUM_OVERSAMPLE,
    bpm: 138, swing: 52,
    tracks: [
      V(0, 'VOLT KICK', 'KICK', 'kick', 0.62, 99001,
        { startHz: 240, endHz: 51, pitchTau: 0.016, decay: 0.24, click: 0.09, harmonic: 0.12, saturation: 5 }, -9, -7),
      V(1, 'VOLT SNARE', 'SNARE', 'snare', 0.34, 99002,
        { shellHz: 224, shellDecay: 0.075, noiseDecay: 0.11, noise: 0.8, noiseHz: 3300, saturation: 3 }, -11, -9),
      V(2, 'VOLT BURST', 'SNARE', 'clap', 0.27, 99003,
        { centerHz: 2600, q: 0.8, spacing: 0.008, bursts: 5, burstDecay: 0.0035, tailDecay: 0.08, saturation: 4 }, -13, -11),
      V(3, 'VOLT CLOSED', 'HAT', 'hat', 0.09, 99004,
        { baseHz: 710, decay: 0.026, noise: 0.08, highpassHz: 8200, metalHz: 14700, saturation: 2 }, -17, -13,
        { mix: { choke: true, chokeGroup: 1 } }),
      V(4, 'VOLT OPEN', 'HAT', 'hat', 0.54, 99005,
        { baseHz: 710, decay: 0.21, noise: 0.1, highpassHz: 7200, metalHz: 13200, saturation: 2 }, -17, -13,
        { mix: { chokeGroup: 1 } }),
      V(5, 'VOLT FM TOM', 'TONE', 'fm-perc', 0.48, 99006,
        { carrierHz: 174, ratio: 2.713, index: 6.2, modDecay: 0.075, decay: 0.22, saturation: 3 }, -12, -11),
      V(6, 'VOLT PING', 'TONE', 'fm-perc', 0.31, 99007,
        { carrierHz: 682, ratio: 3.17, index: 3.8, modDecay: 0.045, decay: 0.13, saturation: 2 }, -15, -13),
      V(7, 'VOLT SUB', '808 BASS', 'kick', 1.22, 99008,
        { startHz: 88, endHz: 49, pitchTau: 0.042, decay: 0.62, attack: 0.0028,
          click: 0.006, harmonic: 0.12, saturation: 3, postLowpassHz: 8900 }, -11, -2,
        { outputGainDb: -12, voice: { attack: 3, release: 34 },
          mix: { choke: true, duckSource: 0, duckDb: 9 } }),
    ],
    grooves: [
      G('drive', 'DRIVE', ['x...x...x.x...x.', '....x.......x...', '..x.........x...', 'x.x.x.x.x.x.x.x.', '.......x.......x', '......x.........', '..............x.', 'x.......x...x...'], [
        { track: 3, step: 10, patch: { ratchet: 2, velocity: 0.7 } },
        { track: 5, step: 6, patch: { pitch: 5, gate: 0.5 } },
        { track: 7, step: 8, patch: { pitch: 5, gate: 2.8 } },
        { track: 7, step: 12, patch: { pitch: -2, gate: 2.2 } },
      ]),
      G('fracture', 'FRACTURE', ['x.....x.x.x.....', '....x.......x...', '.........x.....x', 'x.xxx.x.x.xxx.x.', '.......x........', '..x........x....', '......x.......x.', 'x.......x.....x.'], [
        { track: 2, step: 15, patch: { ratchet: 4, velocity: 0.68 } },
        { track: 6, step: 14, patch: { prob: 62, pitch: 7 } },
        { track: 7, step: 8, patch: { pitch: -5, gate: 3 } },
        { track: 7, step: 14, patch: { pitch: 2, gate: 2.4 } },
      ]),
    ],
  },
];

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

export const FACTORY_KITS = deepFreeze(KITS);
const BY_ID = new Map(FACTORY_KITS.map((kit) => [kit.id, kit]));
const CACHE = new Map();

export function getFactoryKit(id) {
  return BY_ID.get(String(id || '').toLowerCase()) || null;
}

export function drumAssetId(kitId, slot) {
  const kit = getFactoryKit(kitId);
  const n = Number(slot);
  if (!kit || !Number.isInteger(n) || n < 0 || n > 7) return null;
  return 'factory-drum-v' + DRUM_ENGINE_VERSION + '-' + kit.id + '-' + n;
}

function cloneVoice(v) {
  return {
    ...v,
    params: { ...v.params }, voice: { ...v.voice }, mix: { ...v.mix },
    // Canonical PCM is immutable-by-contract. Sharing it avoids an unnecessary
    // multi-megabyte copy every time a cached kit is installed or previewed.
    pcm: v.pcm, metrics: v.metrics,
  };
}

export function renderFactoryKit(id) {
  const kit = getFactoryKit(id);
  if (!kit) throw new RangeError('unknown factory kit "' + id + '"');
  let cached = CACHE.get(kit.id);
  if (!cached) {
    const voices = kit.tracks.map((def) => {
      const rendered = renderFactoryVoice(def);
      return {
        slot: def.slot, name: def.name, role: def.role,
        pcm: rendered.pcm, sampleRate: rendered.sampleRate,
        engineVersion: rendered.engineVersion, model: rendered.model,
        seed: rendered.seed, params: rendered.params,
        voice: { ...def.voice }, mix: { ...def.mix }, metrics: rendered.metrics,
      };
    });
    // Guaranteed conservative dry summing budget. This is a one-way trim of
    // mix gains, never per-sample normalization or a hidden limiter.
    let worst = 0;
    for (const v of voices) worst += Math.pow(10, v.metrics.truePeakDb / 20) * Math.pow(10, v.mix.gainDb / 20);
    const ceiling = Math.pow(10, -6 / 20);
    const trimDb = worst > ceiling ? 20 * Math.log10(ceiling / worst) : 0;
    if (trimDb < 0) for (const v of voices) v.mix.gainDb += trimDb;
    cached = { voices, metrics: Object.freeze({ dryWorstCaseDb: 20 * Math.log10(Math.min(worst, ceiling)), trimDb }) };
    CACHE.set(kit.id, cached);
  }
  return { kit, voices: cached.voices.map(cloneVoice), metrics: cached.metrics };
}

function hashText(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rand(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A starter groove for a kit that has roles but no authored lanes — i.e. one
// HARVEST just seated. Without it, HARVEST reports READY TO PLAY and RUN plays
// silence, because seating samples does not write any steps.
//
// Lanes are given at sixteenth resolution within one bar and repeat across all
// four. Kick and snare carry the pulse; everything tonal is deliberately sparse,
// because harvested material is long and washy compared with a drum machine.
const ROLE_LANES = Object.freeze({
  kick:  [0, 8],
  snare: [4, 12],
  hat:   [2, 6, 10, 14],
  bass:  [0, 10],
  tone:  [6, 14],
  vox:   [12],
  fx:    [7],
  crash: [0],
});

// A role that appears on more than one track (a frog harvest seats several
// TONE slices) is rotated rather than duplicated, so the copies interlock
// instead of stacking into one louder hit.
const ROLE_ROTATION = 3;

/**
 * Steps for each track from its role alone. Returns one Uint8Array(64) per
 * entry in `roles`; an unrecognised role gets a silent lane rather than a guess.
 */
export function starterGrooveForRoles(roles, opts = {}) {
  const stepsPerBar = Math.max(1, Math.trunc(opts.stepsPerBar) || 16);
  const bars = Math.max(1, Math.trunc(opts.bars) || 4);
  const total = stepsPerBar * bars;
  const list = Array.isArray(roles) ? roles : [];
  const seen = new Map();
  return list.map((role) => {
    const lane = new Uint8Array(total);
    const key = typeof role === 'string' ? role.toLowerCase() : '';
    const hits = ROLE_LANES[key];
    if (!hits) return lane;
    const nth = seen.get(key) || 0;
    seen.set(key, nth + 1);
    const shift = nth * ROLE_ROTATION;
    for (let bar = 0; bar < bars; bar++) {
      for (const hit of hits) {
        lane[bar * stepsPerBar + ((hit + shift) % stepsPerBar)] = 1;
      }
    }
    return lane;
  });
}

export function grooveFor(kitId, grooveId, variation = 0) {
  const kit = getFactoryKit(kitId);
  if (!kit) throw new RangeError('unknown factory kit "' + kitId + '"');
  const groove = kit.grooves.find((g) => g.id === grooveId);
  if (!groove) throw new RangeError('unknown groove "' + grooveId + '" for ' + kit.id);
  const out = Array.from({ length: 8 }, () => ({ len: 64, steps: new Uint8Array(64), stepData: {} }));
  for (let track = 0; track < 8; track++) {
    const lane = groove.lanes[track] || '................';
    for (let bar = 0; bar < 4; bar++) {
      for (let step = 0; step < 16; step++) if (lane[step] === 'x') out[track].steps[bar * 16 + step] = 1;
    }
  }
  for (const lock of groove.locks || []) {
    for (let bar = 0; bar < 4; bar++) {
      const step = bar * 16 + lock.step;
      if (out[lock.track].steps[step]) out[lock.track].stepData[step] = { ...lock.patch };
    }
  }
  const v = Math.max(0, Math.trunc(Number(variation) || 0));
  if (v) {
    const random = rand(hashText(kit.id + ':' + groove.id + ':' + v));
    for (let track = 0; track < 8; track++) {
      for (let step = 0; step < 64; step++) {
        if (!out[track].steps[step]) continue;
        const patch = out[track].stepData[step] || (out[track].stepData[step] = {});
        if (patch.velocity == null) patch.velocity = 0.78 + random() * 0.2;
        if (track >= 2 && random() < 0.3) patch.nudge = (random() - 0.5) * 0.12;
      }
    }
    // A deterministic final-bar ornament makes variations musically distinct.
    const track = 2 + (v % 6);
    const step = 48 + ((v * 5 + Math.floor(random() * 8)) % 16);
    out[track].steps[step] = 1;
    out[track].stepData[step] = { velocity: 0.6 + random() * 0.3, prob: 72 };
  }
  return out;
}

export function kitInstallPlan(kitId, opts = {}) {
  const rendered = renderFactoryKit(kitId);
  const grooveId = opts.grooveId == null ? null : String(opts.grooveId);
  return {
    kitId: rendered.kit.id,
    name: rendered.kit.name,
    bpm: rendered.kit.bpm,
    swing: rendered.kit.swing,
    sampleRate: DRUM_RATE,
    grooveId,
    variation: Math.max(0, Math.trunc(Number(opts.variation) || 0)),
    tracks: grooveId ? grooveFor(rendered.kit.id, grooveId, opts.variation) : null,
    voices: rendered.voices.map((v) => ({ ...v, assetId: drumAssetId(rendered.kit.id, v.slot) })),
    metrics: rendered.metrics,
  };
}
