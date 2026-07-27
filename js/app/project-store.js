// Project store: the serializable document, split from runtime handles.
// The document is what OPFS persistence will save; runtime holds AudioBuffers,
// decoded PCM, derived analysis, and generation tokens — never serialized.

let assetCounter = 0;

export function createTrack() {
  return {
    sampleId: null,
    sample: null,          // runtime-resolved {channels, sampleRate, label}; never serialized
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

export function createProject(chainDefaults) {
  return {
    formatVersion: 1,
    fileName: null,
    words: null,
    chain: chainDefaults,
    clips: [],
    assets: {},            // id -> {id, kind, label, sampleRate, frames}; pcm lives on runtime refs
    machine: createMachine(),
  };
}

export function registerAsset(project, meta) {
  const id = 'a' + (++assetCounter);
  project.assets[id] = { id, ...meta };
  return id;
}

export class ProjectStore extends EventTarget {
  constructor(chainDefaults) {
    super();
    this.project = createProject(chainDefaults);
    this.runtime = {
      buffer: null,          // decoded source AudioBuffer
      mono: null,            // Float32Array mixdown
      sampleRate: 0,
      renderedBuffer: null,  // last bench render
      analysis: null,        // beatmap (derived cache)
      peaks: null,           // shared PeakPyramid (derived cache)
      generation: 0,         // bumped per loaded source; stale async jobs check and bail
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
