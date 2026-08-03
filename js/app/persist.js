// Persistence core, per docs/CONTRACT-PERSIST.md: pure serializeProject +
// applySnapshot (in-place restore) and the OpfsStore adapter. The pure pair is
// node-testable (scratch/test_persist.mjs); only OpfsStore touches the browser.
// Autosave scheduling and restore orchestration live in persist-controller.js.

import { normalizeVoice } from '../machine/compile.js';

export const FORMAT_VERSION = 2;

const DIR_NAME = 'yellowjacket-v1';
const MAX_STEPS = 64;

export class FormatVersionError extends Error {
  constructor(version) {
    super('unsupported project formatVersion ' + String(version)
      + ' (this bench reads formatVersion ' + FORMAT_VERSION + ')');
    this.name = 'FormatVersionError';
    this.formatVersion = version;
  }
}

// JSON-safe deep copy; typed arrays become plain arrays. Copies every key it
// finds, so unknown stepData/repair fields ride through untouched (forward
// tolerance both directions).
function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = clone(value[i]);
    return out;
  }
  const out = {};
  for (const key of Object.keys(value)) out[key] = clone(value[key]);
  return out;
}

// samples/<assetId>.f32 layout: header-less per-channel concatenated Float32;
// channelCount/frames/sampleRate live in json.assets.
function sampleBytes(sample) {
  let total = 0;
  for (const ch of sample.channels) total += ch.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const ch of sample.channels) {
    out.set(ch, offset);
    offset += ch.length;
  }
  return out.buffer;
}

function serializeTrack(track) {
  const steps = new Array(MAX_STEPS).fill(0);
  const src = track.steps || [];
  const n = Math.min(MAX_STEPS, src.length);
  for (let i = 0; i < n; i++) steps[i] = src[i];
  return {
    sampleId: typeof track.sampleId === 'string' ? track.sampleId : null,
    voice: clone(track.voice || {}),
    steps,
    stepData: clone(track.stepData || {}),
    len: track.len,
    gainDb: track.gainDb,
    pan: track.pan,
    mute: !!track.mute,
    solo: !!track.solo,
    duckSource: track.duckSource,
    duckDb: track.duckDb,
    choke: !!track.choke,
    sendVerb: track.sendVerb,
    sendDelay: track.sendDelay,
  };
}

function serializeScene(scene) {
  return {
    id: scene.id,
    name: scene.name,
    bpm: scene.bpm,
    swing: scene.swing,
    seed: scene.seed,
    tracks: scene.tracks.map(serializeTrack),
  };
}

// Undo snapshots need the document only. Copying every referenced PCM buffer
// on each of the 29 mutation sites would cost megabytes per keystroke, so
// skipPcm builds the same JSON without touching sample audio.
export function snapshotDoc(project, runtime) {
  return serializeProject(project, runtime, true).json;
}

export function serializeProject(project, runtime, skipPcm = false) {
  const machine = project.machine;
  const assets = {};
  for (const id of Object.keys(project.assets || {})) assets[id] = clone(project.assets[id]);

  // PCM only for assets a track actually references, deduped: scenes share
  // sample refs by design, and one asset must become exactly one file.
  const sampleFiles = [];
  const seen = new Set();
  for (const scene of machine.scenes) {
    for (const track of scene.tracks) {
      const id = track.sampleId;
      if (!id || seen.has(id)) continue;
      if (!track.sample || !Array.isArray(track.sample.channels)) continue;
      seen.add(id);
      if (!skipPcm) sampleFiles.push({ id, bytes: sampleBytes(track.sample) });
      if (assets[id]) assets[id].channelCount = track.sample.channels.length;
    }
  }
  for (const id of Object.keys(assets)) {
    if (!Number.isFinite(assets[id].channelCount)) assets[id].channelCount = 1;
  }

  const src = runtime.sourceBytes;
  const anchors = runtime.analysis && runtime.analysis.anchors;
  const json = {
    formatVersion: FORMAT_VERSION,
    savedAt: Date.now(),
    fileName: project.fileName != null ? project.fileName : null,
    sourceBytes: src ? { size: src.byteLength } : null,
    words: clone(project.words),
    clips: clone(project.clips || []),
    chain: clone(project.chain || []),
    machine: {
      activeScene: machine.activeScene,
      scenes: machine.scenes.map(serializeScene),
      song: machine.song ? clone(machine.song) : null,
      space: machine.space ? clone(machine.space) : null,
    },
    assets,
    repairs: clone(runtime.repairs || []),
    anchors: anchors ? clone(anchors) : null,
    wire: project.wire ? clone(project.wire) : null,
  };
  return { json, sampleFiles };
}

// The inverse of the sample half of serializeProject: one asset's metadata plus
// its flat f32 file, back into the runtime {channels, sampleRate, label, role}
// shape a track holds. It lives here rather than inline in the restore loop so
// the harness can hold it to the round trip. It was inline, and it silently
// dropped `role`, which is the field that decides whether a fitted slice is
// stretched by WSOLA or by the phase vocoder: every restored drum came back
// tonal and smeared.
export function hydrateSample(meta, raw) {
  if (!meta || !raw) return null;
  const flat = raw instanceof Float32Array ? raw : new Float32Array(raw);
  const frames = Math.max(0, meta.frames | 0);
  const count = Math.max(1, meta.channelCount | 0);
  if (!frames || flat.length < frames * count) return null;
  const channels = [];
  for (let c = 0; c < count; c++) channels.push(flat.slice(c * frames, (c + 1) * frames));
  return { channels, sampleRate: meta.sampleRate, label: meta.label, role: meta.role };
}

function applyTrack(track, saved) {
  track.sampleId = typeof saved.sampleId === 'string' ? saved.sampleId : null;
  track.sample = null;   // PCM attaches after sample files load (RestorePlan)
  // Voice merges saved fields over the defaults, then hands the result to the
  // compiler's own normalizeVoice. This block used to re-implement all eleven
  // clamps by hand, and had already drifted: it truncated fitSteps with |0
  // where the compiler rounds, so a saved 2.6 played as 2 steps after a reload
  // and 3 before it. The ranges now have exactly one definition.
  if (saved.voice && typeof saved.voice === 'object' && track.voice) {
    Object.assign(track.voice, normalizeVoice({ ...track.voice, ...saved.voice }));
  }
  if (Number.isFinite(saved.sendVerb)) track.sendVerb = Math.max(0, Math.min(1, saved.sendVerb));
  if (Number.isFinite(saved.sendDelay)) track.sendDelay = Math.max(0, Math.min(1, saved.sendDelay));
  track.steps.fill(0);
  if (Array.isArray(saved.steps)) {
    const n = Math.min(MAX_STEPS, saved.steps.length);
    for (let i = 0; i < n; i++) track.steps[i] = saved.steps[i];
  }
  for (const key of Object.keys(track.stepData)) delete track.stepData[key];
  if (saved.stepData && typeof saved.stepData === 'object') {
    for (const key of Object.keys(saved.stepData)) {
      const step = Number(key);
      if (Number.isInteger(step) && step >= 0 && step < MAX_STEPS) {
        track.stepData[key] = clone(saved.stepData[key]);
      }
    }
  }
  if (Number.isFinite(saved.len)) track.len = saved.len | 0;
  if (Number.isFinite(saved.gainDb)) track.gainDb = saved.gainDb;
  if (Number.isFinite(saved.pan)) track.pan = saved.pan;
  if (typeof saved.mute === 'boolean') track.mute = saved.mute;
  if (typeof saved.solo === 'boolean') track.solo = saved.solo;
  if (Number.isFinite(saved.duckSource)) track.duckSource = saved.duckSource | 0;
  if (Number.isFinite(saved.duckDb)) track.duckDb = saved.duckDb;
  if (typeof saved.choke === 'boolean') track.choke = saved.choke;
}

function applyScene(scene, saved) {
  if (typeof saved.id === 'string') scene.id = saved.id;
  if (typeof saved.name === 'string') scene.name = saved.name;
  // Written on the scene directly: machine.bpm/swing are active-scene aliases
  // and must never be the write path here.
  if (Number.isFinite(saved.bpm)) scene.bpm = saved.bpm;
  if (Number.isFinite(saved.swing)) scene.swing = saved.swing;
  if (Number.isFinite(saved.seed)) scene.seed = saved.seed >>> 0;
  const savedTracks = Array.isArray(saved.tracks) ? saved.tracks : [];
  const n = Math.min(scene.tracks.length, savedTracks.length);
  for (let i = 0; i < n; i++) {
    if (savedTracks[i] && typeof savedTracks[i] === 'object') applyTrack(scene.tracks[i], savedTracks[i]);
  }
}

// Mutates project/runtime IN PLACE: controllers hold references to the project,
// the machine, the scenes/tracks arrays, chain entries, clips, and repairs, so
// none of those objects are ever replaced, only their contents. Unknown
// top-level keys are ignored. Returns a RestorePlan (CONTRACT-PERSIST 3);
// note that both call sites currently discard it and re-derive what they need,
// so it is documentation and a test surface rather than a live dependency.
export function applySnapshot(json, { project, runtime }) {
  if (!json || typeof json !== 'object' || json.formatVersion !== FORMAT_VERSION) {
    throw new FormatVersionError(json && typeof json === 'object' ? json.formatVersion : json);
  }

  project.fileName = typeof json.fileName === 'string' ? json.fileName : null;

  if (Array.isArray(json.words)) {
    if (Array.isArray(project.words)) {
      project.words.length = 0;
      for (const word of json.words) project.words.push(clone(word));
    } else {
      project.words = json.words.map((word) => clone(word));
    }
  } else {
    project.words = null;
  }

  project.clips.length = 0;
  if (Array.isArray(json.clips)) {
    for (const clip of json.clips) project.clips.push(clone(clip));
  }

  // Chain entries are matched by id and merged: the rack UI closes over the
  // entry and params objects. Effects this bench does not know are skipped.
  if (Array.isArray(json.chain) && Array.isArray(project.chain)) {
    const byId = new Map(project.chain.map((fx) => [fx.id, fx]));
    for (const saved of json.chain) {
      const fx = saved && byId.get(saved.id);
      if (!fx) continue;
      if (typeof saved.on === 'boolean') fx.on = saved.on;
      if (saved.params && typeof saved.params === 'object') {
        for (const key of Object.keys(saved.params)) fx.params[key] = clone(saved.params[key]);
      }
    }
  }

  const machine = project.machine;
  const savedMachine = json.machine && typeof json.machine === 'object' ? json.machine : {};
  const savedScenes = Array.isArray(savedMachine.scenes) ? savedMachine.scenes : [];
  const nScenes = Math.min(machine.scenes.length, savedScenes.length);
  for (let i = 0; i < nScenes; i++) {
    if (savedScenes[i] && typeof savedScenes[i] === 'object') applyScene(machine.scenes[i], savedScenes[i]);
  }
  const active = savedMachine.activeScene;
  machine.activeScene = Number.isInteger(active) && active >= 0 && active < machine.scenes.length ? active : 0;

  // Song chain merges into the existing object; entries clamp to real scenes.
  if (machine.song) {
    machine.song.chain.length = 0;
    const savedSong = savedMachine.song;
    if (savedSong && typeof savedSong === 'object') {
      if (Array.isArray(savedSong.chain)) {
        for (const entry of savedSong.chain) {
          if (!entry || typeof entry !== 'object') continue;
          const scene = entry.scene | 0;
          if (scene < 0 || scene >= machine.scenes.length) continue;
          const reps = Math.max(1, Math.min(99, entry.reps | 0 || 1));
          machine.song.chain.push({ scene, reps });
        }
      }
      machine.song.loop = savedSong.loop !== false;
    }
  }

  // Space rack merges into the existing object (the bus graph closes over it).
  if (machine.space && savedMachine.space && typeof savedMachine.space === 'object') {
    const sp = machine.space;
    const sv = savedMachine.space;
    if (Number.isFinite(sv.verbSec)) sp.verbSec = Math.max(0.1, Math.min(8, sv.verbSec));
    if (Number.isFinite(sv.verbDecay)) sp.verbDecay = Math.max(0.5, Math.min(8, sv.verbDecay));
    if (Number.isFinite(sv.verbMix)) sp.verbMix = Math.max(0, Math.min(1, sv.verbMix));
    if (typeof sv.delayDivision === 'string') sp.delayDivision = sv.delayDivision;
    if (Number.isFinite(sv.delayFeedback)) sp.delayFeedback = Math.max(0, Math.min(0.95, sv.delayFeedback));
    if (Number.isFinite(sv.delayMix)) sp.delayMix = Math.max(0, Math.min(1, sv.delayMix));
  }

  for (const key of Object.keys(project.assets)) delete project.assets[key];
  if (json.assets && typeof json.assets === 'object') {
    for (const id of Object.keys(json.assets)) {
      const meta = clone(json.assets[id]);
      if (meta && typeof meta === 'object') {
        if (typeof meta.id !== 'string') meta.id = id;
        project.assets[id] = meta;
      }
    }
  }

  runtime.repairs.length = 0;
  if (Array.isArray(json.repairs)) {
    for (const repair of json.repairs) runtime.repairs.push(clone(repair));
  }

  // WIRE settings merge into the existing object (the controller closes over
  // it). Saves from before the WIRE slice simply lack the key: defaults stay.
  if (json.wire && typeof json.wire === 'object' && project.wire) {
    const w = project.wire;
    w.inId = typeof json.wire.inId === 'string' ? json.wire.inId : null;
    w.outId = typeof json.wire.outId === 'string' ? json.wire.outId : null;
    w.clockOut = json.wire.clockOut === true;
    if (Number.isFinite(json.wire.noteBase)) w.noteBase = Math.max(0, Math.min(119, json.wire.noteBase | 0));
    for (const key of Object.keys(w.mappings)) delete w.mappings[key];
    if (json.wire.mappings && typeof json.wire.mappings === 'object') {
      for (const key of Object.keys(json.wire.mappings)) {
        const m = json.wire.mappings[key];
        if (m && typeof m === 'object') w.mappings[key] = clone(m);
      }
    }
  }

  const sampleAttachments = [];
  for (let s = 0; s < machine.scenes.length; s++) {
    const tracks = machine.scenes[s].tracks;
    for (let t = 0; t < tracks.length; t++) {
      const id = tracks[t].sampleId;
      if (id && project.assets[id]) sampleAttachments.push({ sceneIndex: s, trackIndex: t, assetId: id });
    }
  }

  return {
    fileName: project.fileName,
    needsAnalysis: !!(json.sourceBytes && json.sourceBytes.size > 0),
    anchors: json.anchors != null ? clone(json.anchors) : null,
    sampleAttachments,
  };
}

// OPFS adapter under 'yellowjacket-v1'. Names are at most one directory deep
// ('samples/a1.f32'); the subdirectory is created on write. open() returns null
// wherever the main-thread write path is missing — notably Safari before
// FileSystemFileHandle.createWritable (the sync-access-handle fallback is
// deliberately out of this slice; the bench just does not persist there).
export class OpfsStore {
  constructor(root, dir) {
    this._root = root;
    this._dir = dir;
  }

  static async open() {
    try {
      if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory) return null;
      if (typeof FileSystemFileHandle === 'undefined'
        || typeof FileSystemFileHandle.prototype.createWritable !== 'function') return null;
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(DIR_NAME, { create: true });
      return new OpfsStore(root, dir);
    } catch (e) {
      return null;
    }
  }

  async _locate(name, create) {
    const parts = String(name).split('/');
    if (parts.length === 1 && parts[0]) return { dir: this._dir, base: parts[0] };
    if (parts.length === 2 && parts[0] && parts[1]) {
      const sub = await this._dir.getDirectoryHandle(parts[0], { create });
      return { dir: sub, base: parts[1] };
    }
    throw new Error('OpfsStore: bad name "' + name + '" (at most one "/", no empty segments)');
  }

  async writeBytes(name, arrayBuffer) {
    const { dir, base } = await this._locate(name, true);
    const handle = await dir.getFileHandle(base, { create: true });
    const writable = await handle.createWritable();
    await writable.write(arrayBuffer);
    await writable.close();
  }

  async readBytes(name) {
    try {
      const { dir, base } = await this._locate(name, false);
      const handle = await dir.getFileHandle(base);
      const file = await handle.getFile();
      return await file.arrayBuffer();
    } catch (e) {
      if (e && e.name === 'NotFoundError') return null;
      throw e;
    }
  }

  async writeJson(name, obj) {
    await this.writeBytes(name, new TextEncoder().encode(JSON.stringify(obj)));
  }

  async readJson(name) {
    const bytes = await this.readBytes(name);
    if (bytes === null) return null;
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  async has(name) {
    try {
      const { dir, base } = await this._locate(name, false);
      await dir.getFileHandle(base);
      return true;
    } catch (e) {
      if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return false;
      throw e;
    }
  }

  async remove(name) {
    try {
      const { dir, base } = await this._locate(name, false);
      await dir.removeEntry(base);
    } catch (e) {
      if (e && e.name === 'NotFoundError') return;
      throw e;
    }
  }

  async wipe() {
    try {
      await this._root.removeEntry(DIR_NAME, { recursive: true });
    } catch (e) {
      if (!e || e.name !== 'NotFoundError') throw e;
    }
    this._dir = await this._root.getDirectoryHandle(DIR_NAME, { create: true });
  }
}
