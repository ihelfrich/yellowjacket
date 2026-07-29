// Project store: the serializable document, split from runtime handles.
// The document is what OPFS persistence will save; runtime holds AudioBuffers,
// decoded PCM, derived analysis, and generation tokens — never serialized.

let assetCounter = 0;

export function createVoice() {
  return {
    start: 0,              // 0..1 fraction into the sample, see CONTRACT-SONG.md
    end: 1,
    pitch: 0,              // semitones, -24..24; rate = 2^(pitch/12)
    attack: 3,             // ms
    release: 8,            // ms
    reverse: false,
    lpf: 20000,            // Hz; >= 18000 = off (CONTRACT-HARVEST color)
    res: 0.7,              // lowpass resonance 0.5..8
    hpf: 20,               // Hz; <= 25 = off
    drive: 0,              // dB 0..24; 0 = off
    fitSteps: 0,           // 0 = off; else stretch the slice to N steps (CONTRACT-CONFORM)
  };
}

export function createTrack() {
  return {
    sampleId: null,
    sample: null,          // runtime-resolved {channels, sampleRate, label}; never serialized
    voice: createVoice(),
    steps: new Uint8Array(64),
    stepData: {},          // sparse per-step locks/components/conditions, see CONTRACT-LOCK.md
    len: 16,
    gainDb: 0,
    pan: 0,
    mute: false,
    solo: false,
    duckSource: -1,        // -1 off; else index of the track whose hits duck this one
    duckDb: 12,
    choke: false,          // mono track: each hit fades the previous voice
    sendVerb: 0,           // 0..1 into the plate bus (CONTRACT-CONFORM space rack)
    sendDelay: 0,          // 0..1 into the tempo-synced delay bus
  };
}

export function createSpace() {
  return {
    verbSec: 1.8,
    verbDecay: 2.5,
    verbMix: 0.9,
    delayDivision: '1/8.',
    delayFeedback: 0.38,
    delayMix: 0.8,
  };
}

export function createScene(i) {
  return {
    id: 's' + i,
    name: 'SCENE ' + (i + 1),
    bpm: 120,
    swing: 50,
    // Deterministic per-scene seed so probability locks compile identically live and offline.
    seed: ((i + 1) * 0x9e3779b9) >>> 0,
    tracks: Array.from({ length: 8 }, createTrack),
  };
}

export function createMachine() {
  const m = {
    activeScene: 0,
    pendingScene: null,
    scenes: Array.from({ length: 8 }, (_, i) => createScene(i)),
    song: { chain: [], loop: true },   // patterns of patterns, see CONTRACT-SONG.md
    space: createSpace(),              // send rack, see CONTRACT-CONFORM.md
  };
  // Active-scene aliases keep compile.js and PatternView working unchanged: they read
  // machine.bpm / machine.swing / machine.tracks and never learn about scenes.
  Object.defineProperties(m, {
    tracks: {
      get() { return this.scenes[this.activeScene].tracks; },
      enumerable: false,
    },
    bpm: {
      get() { return this.scenes[this.activeScene].bpm; },
      set(v) { this.scenes[this.activeScene].bpm = v; },
      enumerable: false,
    },
    swing: {
      get() { return this.scenes[this.activeScene].swing; },
      set(v) { this.scenes[this.activeScene].swing = v; },
      enumerable: false,
    },
  });
  return m;
}

export function createWire() {
  return {
    inId: null,            // chosen MIDI port ids; rebind on hotplug, see CONTRACT-WIRE.md
    outId: null,
    clockOut: false,
    noteBase: 53,          // lowest note fires track 1; LEARN overwrites, never hardcode device maps
    mappings: {},          // action key ('mute1'..'mute8','scene1'..'scene8','fill') -> {kind,ch,num}
  };
}

export function createProject(chainDefaults) {
  return {
    formatVersion: 1,
    fileName: null,
    words: null,
    chain: chainDefaults,
    clips: [],
    assets: {},            // id -> {id, kind, label, sampleRate, frames}; pcm lives on runtime refs
    machine: createMachine(),
    wire: createWire(),
  };
}

export function registerAsset(project, meta) {
  // Restored projects carry ids this counter never minted; skip past them or a
  // new asset would collide with a restored one (two PCMs, one file on save).
  let id = 'a' + (++assetCounter);
  while (project.assets[id]) id = 'a' + (++assetCounter);
  project.assets[id] = { id, ...meta };
  return id;
}

export class ProjectStore extends EventTarget {
  constructor(chainDefaults) {
    super();
    this.project = createProject(chainDefaults);
    this.runtime = {
      buffer: null,          // decoded source AudioBuffer (edited when repairs active)
      mono: null,            // Float32Array mixdown
      sampleRate: 0,
      renderedBuffer: null,  // last bench render
      analysis: null,        // beatmap (derived cache)
      peaks: null,           // shared PeakPyramid (derived cache)
      generation: 0,         // bumped per loaded source; stale async jobs check and bail
      repairs: [],           // spectral repair stack, see CONTRACT-BRUSH.md
      original: null,        // {buffer, mono} captured before the first repair
      sourceBytes: null,     // encoded source as loaded, for persistence + restore
    };
    this.revision = 0;
    this.dirty = false;
  }

  // Every mutation goes through here so autosave (later) can observe all of them.
  update(kind, fn) {
    fn(this.project, this.runtime);
    this.revision++;
    this.dirty = true;
    this.dispatchEvent(new CustomEvent('change', { detail: { kind, revision: this.revision } }));
  }
}
