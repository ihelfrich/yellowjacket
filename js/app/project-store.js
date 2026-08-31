// Project store: the serializable document, split from runtime handles.
// The document is what OPFS persistence will save; runtime holds AudioBuffers,
// decoded PCM, derived analysis, and generation tokens — never serialized.

import { createStudio } from '../studio/model.js';

// Canonical PCM verification is loaded only by the inactive prepared-asset
// route. Retain the owners we install so synchronous playback resolution can
// distinguish them from arbitrary values inserted into the public runtime map.
const verifiedAssetPcm = new WeakSet();

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
    chokeGroup: 0,         // 0 off; matching 1..4 tracks choke one another (e.g. hats)
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
    drums: { kitId: null, grooveId: null, variation: 0 },
    // A Semantic Take is a ninth, non-destructive performance lane. It holds
    // only a reference to an immutable Loom plan; source PCM stays in runtime.
    loomLane: {
      planId: null,
      enabled: true,
      gainDb: -9,
      pan: 0,
      repeatSteps: 16,
      startStep: 0,
    },
    tracks: Array.from({ length: 8 }, createTrack),
  };
}

export function createMachine() {
  const m = {
    activeScene: 0,
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
    drums: {
      get() { return this.scenes[this.activeScene].drums; },
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

export function createLoom() {
  return {
    weaveCount: 0,
    plan: null,             // compatibility alias for the active immutable plan
    activePlanId: null,
    plans: {},              // id -> immutable JSON-only source × gesture binding
  };
}

export function createProject(chainDefaults) {
  return {
    // No formatVersion here on purpose: the serialized format is stamped by
    // persist.js (FORMAT_VERSION, currently 2). A second version field on the
    // live object read 1 forever and invited a maintainer to bump the wrong one.
    fileName: null,
    words: null,
    transcript: { gapCuts: [] },
    chain: chainDefaults,
    activeSourceId: null,
    sources: {},
    allocators: { clip: 0, asset: 0 },
    clips: [],
    assets: {},            // id -> {id, kind, label, sampleRate, frames}; pcm lives on runtime refs
    machine: createMachine(),
    studio: createStudio(), // six polyphonic melodic parts; WebAudio lives in studio/engine.js
    wire: createWire(),
    loom: createLoom(),     // semantic source/MIDI provenance and render map
  };
}

function allocatedSuffixes(project, kind) {
  const prefix = kind === 'clip' ? 'c' : 'a';
  const ids = kind === 'clip'
    ? (Array.isArray(project.clips) ? project.clips.map((entry) => entry && entry.id) : null)
    : (project.assets && typeof project.assets === 'object' && !Array.isArray(project.assets)
      ? Object.keys(project.assets) : null);
  if (!ids) throw new RangeError(`Project ${kind} state is invalid`);
  let highest = 0;
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    const match = new RegExp(`^${prefix}([1-9][0-9]*)$`).exec(id);
    if (!match) continue;
    const suffix = Number(match[1]);
    if (!Number.isSafeInteger(suffix)) throw new RangeError(`Project ${kind} ID is unsafe`);
    highest = Math.max(highest, suffix);
  }
  return highest;
}

export function allocateProjectId(project, kind) {
  if (!project || typeof project !== 'object' || (kind !== 'clip' && kind !== 'asset')) {
    throw new RangeError('Project allocator is invalid');
  }
  const counters = project.allocators;
  const counter = counters && counters[kind];
  if (!Number.isSafeInteger(counter) || counter < 0 || counter >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`Project ${kind} counter is unsafe`);
  }
  if (counter < allocatedSuffixes(project, kind)) {
    throw new RangeError(`Project ${kind} counter is stale`);
  }
  const next = counter + 1;
  counters[kind] = next;
  return (kind === 'clip' ? 'c' : 'a') + next;
}

export function registerAsset(project, meta) {
  const id = allocateProjectId(project, 'asset');
  project.assets[id] = { ...meta, id };
  return id;
}

function jsonMetadata(meta) {
  if (!isJsonValue(meta) || Array.isArray(meta)) return null;
  try {
    const encoded = JSON.stringify(meta);
    return encoded == null ? null : JSON.parse(encoded);
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasExactKeys(value, allowed) {
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

function hasPcmBearingField(value) {
  if (Array.isArray(value)) return value.some(hasPcmBearingField);
  if (!isPlainObject(value)) return false;
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'channels' || key === 'bytes' || key === 'rawBytes' || key === 'pcm') return true;
    if (hasPcmBearingField(entry)) return true;
  }
  return false;
}

const PREPARED_ASSET_FIELDS = new Set([
  'kind', 'label', 'sampleRate', 'channelCount', 'frames', 'payload', 'role', 'provenance',
]);
const PROJECT_PROVENANCE_FIELDS = new Set([
  'kind', 'binding', 'sourceId', 'clipId', 'sourceSpan', 'extraction', 'transforms',
]);
const EXTERNAL_PROVENANCE_FIELDS = new Set(['kind', 'binding', 'descriptor', 'transforms']);
const PAYLOAD_FIELDS = new Set(['byteLength', 'sha256']);
const DESCRIPTOR_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

function validPreparedProvenanceShape(provenance) {
  if (!isPlainObject(provenance) || hasPcmBearingField(provenance)
      || typeof provenance.kind !== 'string' || !DESCRIPTOR_RE.test(provenance.kind)
      || !Array.isArray(provenance.transforms)) return false;
  if (provenance.binding === 'project') {
    return hasExactKeys(provenance, PROJECT_PROVENANCE_FIELDS);
  }
  return provenance.binding === 'external' && isPlainObject(provenance.descriptor)
    && hasExactKeys(provenance, EXTERNAL_PROVENANCE_FIELDS);
}

function isPreparedAssetMetadata(meta) {
  if (!isPlainObject(meta) || Object.keys(meta).some((key) => !PREPARED_ASSET_FIELDS.has(key))
      || typeof meta.kind !== 'string' || !DESCRIPTOR_RE.test(meta.kind)
      || typeof meta.label !== 'string' || !isPositiveSafeInteger(meta.sampleRate)
      || !isPositiveSafeInteger(meta.channelCount) || !isSafeInteger(meta.frames)
      || !isPlainObject(meta.payload) || !hasExactKeys(meta.payload, PAYLOAD_FIELDS)
      || !isSafeInteger(meta.payload.byteLength) || typeof meta.payload.sha256 !== 'string'
      || !SHA256_RE.test(meta.payload.sha256)) return false;
  if (meta.channelCount > Number.MAX_SAFE_INTEGER / 4 || meta.frames > Number.MAX_SAFE_INTEGER / meta.channelCount
      || meta.frames * meta.channelCount > Number.MAX_SAFE_INTEGER / 4
      || meta.payload.byteLength !== meta.frames * meta.channelCount * 4) return false;
  if (meta.role !== undefined && typeof meta.role !== 'string') return false;
  return meta.provenance === undefined || validPreparedProvenanceShape(meta.provenance);
}

export async function registerPreparedAsset(project, runtime, prepared) {
  if (!runtime || !(runtime.assetPcm instanceof Map) || !prepared || typeof prepared !== 'object') {
    throw new TypeError('Prepared asset runtime is invalid');
  }
  const meta = jsonMetadata(prepared.meta);
  if (!isPreparedAssetMetadata(meta)) throw new TypeError('Prepared asset metadata is invalid');
  // Raw bytes remain outside the project until this asynchronous digest check
  // has produced a private CanonicalPcm owner.
  const { CanonicalPcm, validateAssetProvenance } = await import('./sample-payload.js');
  if (meta.provenance && !validateAssetProvenance(project, { ...meta, id: 'a1' }).ok) {
    throw new TypeError('Prepared asset provenance is invalid');
  }
  const owner = await CanonicalPcm.fromVerified(meta, prepared.bytes);
  if (!owner) throw new TypeError('Prepared asset PCM is not verified');
  const id = allocateProjectId(project, 'asset');
  if (project.assets[id] || runtime.assetPcm.has(id)) {
    throw new RangeError(`Asset ${id} already has an owner`);
  }
  project.assets[id] = { ...meta, id };
  runtime.assetPcm.set(id, owner);
  verifiedAssetPcm.add(owner);
  return id;
}

export function resolveTrackSamples(project, runtime) {
  if (!project || !project.machine || !Array.isArray(project.machine.scenes)
      || !runtime || !(runtime.assetPcm instanceof Map)) return;
  for (const scene of project.machine.scenes) {
    if (!scene || !Array.isArray(scene.tracks)) continue;
    for (const track of scene.tracks) {
      if (!track) continue;
      const owner = runtime.assetPcm.get(track.sampleId);
      if (!verifiedAssetPcm.has(owner)) {
        track.sample = null;
        continue;
      }
      const asset = project.assets && project.assets[track.sampleId];
      track.sample = {
        ...owner.hydrate(),
        label: asset && asset.label,
        role: asset && asset.role,
      };
    }
  }
}

const HISTORY_LIMIT = 60;
const HISTORY_PCM_BUDGET = 256 * 1024 * 1024;
const HISTORY_TRIM_MESSAGE = 'UNDO HISTORY TRIMMED TO PROTECT AUDIO MEMORY';

function historyBound(value, fallback, allowZero = false) {
  const minimum = allowZero ? 0 : 1;
  return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

function legacyPcmByteLength(sample) {
  if (!sample || !Array.isArray(sample.channels)) return null;
  let bytes = 0;
  for (const channel of sample.channels) {
    if (!channel || !Number.isSafeInteger(channel.length) || channel.length < 0) return null;
    const channelBytes = Number.isSafeInteger(channel.byteLength)
      ? channel.byteLength : channel.length * Float32Array.BYTES_PER_ELEMENT;
    if (!Number.isSafeInteger(channelBytes) || channelBytes < 0
        || bytes > Number.MAX_SAFE_INTEGER - channelBytes) return null;
    bytes += channelBytes;
  }
  return bytes;
}

function historyReachableAssetIds(machine) {
  const ids = [];
  const seen = new Set();
  const scenes = Array.isArray(machine && machine.scenes)
    ? machine.scenes : [{ tracks: machine && machine.tracks }];
  for (const scene of scenes) {
    if (!Array.isArray(scene && scene.tracks)) continue;
    for (const track of scene.tracks) {
      const id = track && track.sampleId;
      if (typeof id === 'string' && id.length && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

export class ProjectStore extends EventTarget {
  constructor(chainDefaults, options = {}) {
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
      sourceHash: null,      // SHA-256 of encoded bytes; semantic-lineage identity
      assetPcm: new Map(),
      historyAssetPcm: new Map(),
      historyPcmBytes: 0,
      facadeEpoch: 0,
    };
    this.revision = 0;   // bumped per mutation; rides in the change event
    // Undo history: documents remain PCM-free, while explicit runtime maps own
    // the exact PCM objects needed to make every retained document playable.
    this._past = [];
    this._future = [];
    this._snapshot = null;   // injected by the controller (needs persist.js)
    this._beforeHistorySnapshot = null;
    this._historyAssetRefs = new Map();
    this._historyEntryOrder = new Map();
    this._nextHistoryEntryOrder = 0;
    this._applying = false;
    this.historyLimit = historyBound(options.historyLimit, HISTORY_LIMIT);
    this.historyPcmBudget = historyBound(options.historyPcmBudget, HISTORY_PCM_BUDGET, true);
  }

  // The controller supplies document IO so the store stays free of any
  // dependency on the persistence layer. The positional form remains during
  // the v2 transition for callers outside the inactive multi-source route.
  attachHistory(bridge, legacyApply) {
    const takeDocument = typeof bridge === 'function' ? bridge : bridge && bridge.takeDocument;
    const applyDocument = typeof bridge === 'function' ? legacyApply : bridge && bridge.applyDocument;
    if (typeof takeDocument !== 'function' || typeof applyDocument !== 'function') {
      throw new TypeError('History bridge is invalid');
    }
    this._snapshot = { takeDocument, applyDocument };
  }

  setBeforeHistorySnapshot(callback) {
    if (callback !== null && typeof callback !== 'function') {
      throw new TypeError('Before-history callback is invalid');
    }
    this._beforeHistorySnapshot = callback;
  }

  get canUndo() { return this._past.length > 0; }
  get canRedo() { return this._future.length > 0; }
  get undoDepth() { return this._past.length; }

  // A restored or freshly loaded session is a starting point, not something to
  // undo into. Public so callers stop reaching into the private arrays.
  clearHistory(reason = 'topology') {
    void reason;
    this._clearStack(this._past);
    this._clearStack(this._future);
  }

  undo() { return this._step(this._past, this._future); }
  redo() { return this._step(this._future, this._past); }

  _legacyOwner(assetId) {
    for (const scene of this.project.machine.scenes) {
      for (const track of scene.tracks) {
        if (track && track.sampleId === assetId && track.sample) {
          // Temporary v2 bridge. Task 9 removes new writes through track.sample.
          this.runtime.assetPcm.set(assetId, track.sample);
          return track.sample;
        }
      }
    }
    return null;
  }

  _ownerFor(assetId) {
    return this.runtime.assetPcm.get(assetId)
      || this.runtime.historyAssetPcm.get(assetId)
      || this._legacyOwner(assetId);
  }

  _ownerByteLength(owner) {
    if (owner && Number.isSafeInteger(owner.byteLength) && owner.byteLength >= 0) {
      return owner.byteLength;
    }
    return legacyPcmByteLength(owner);
  }

  _takeEntry(runBeforeHook) {
    if (runBeforeHook && this._beforeHistorySnapshot) this._beforeHistorySnapshot();
    const document = this._snapshot.takeDocument();
    const assetIds = historyReachableAssetIds(document && document.machine);
    let byteLength = 0;
    for (const assetId of assetIds) {
      const ownerBytes = this._ownerByteLength(this._ownerFor(assetId));
      if (ownerBytes !== null && byteLength <= Number.MAX_SAFE_INTEGER - ownerBytes) {
        byteLength += ownerBytes;
      }
    }
    const entry = { document, assetIds, byteLength };
    this._historyEntryOrder.set(entry, this._nextHistoryEntryOrder++);
    return entry;
  }

  _retainEntry(entry) {
    for (const assetId of entry.assetIds) {
      const retained = this.runtime.historyAssetPcm.get(assetId);
      const owner = retained || this._ownerFor(assetId);
      if (!owner) continue;
      if (!retained) {
        const byteLength = this._ownerByteLength(owner);
        if (byteLength === null) continue;
        this.runtime.historyAssetPcm.set(assetId, owner);
        this.runtime.historyPcmBytes += byteLength;
      }
      this._historyAssetRefs.set(assetId, (this._historyAssetRefs.get(assetId) || 0) + 1);
    }
  }

  _releaseEntry(entry) {
    for (const assetId of entry.assetIds) {
      const refs = this._historyAssetRefs.get(assetId);
      if (!refs) continue;
      if (refs > 1) {
        this._historyAssetRefs.set(assetId, refs - 1);
        continue;
      }
      this._historyAssetRefs.delete(assetId);
      const owner = this.runtime.historyAssetPcm.get(assetId);
      this.runtime.historyAssetPcm.delete(assetId);
      const byteLength = this._ownerByteLength(owner);
      if (byteLength !== null) {
        this.runtime.historyPcmBytes = Math.max(0, this.runtime.historyPcmBytes - byteLength);
      }
    }
    this._historyEntryOrder.delete(entry);
  }

  _clearStack(stack) {
    for (const entry of stack) this._releaseEntry(entry);
    stack.length = 0;
  }

  _trimHistory() {
    let trimmed = false;
    while (this._past.length + this._future.length > this.historyLimit
        || this.runtime.historyPcmBytes > this.historyPcmBudget) {
      const pastOrder = this._past.length
        ? this._historyEntryOrder.get(this._past[0]) : Infinity;
      const futureOrder = this._future.length
        ? this._historyEntryOrder.get(this._future[0]) : Infinity;
      const stack = pastOrder <= futureOrder ? this._past : this._future;
      if (!stack.length) break;
      this._releaseEntry(stack.shift());
      trimmed = true;
    }
    if (trimmed) {
      this.dispatchEvent(new CustomEvent('historytrim', {
        detail: { message: HISTORY_TRIM_MESSAGE },
      }));
    }
  }

  _ownersFor(entry) {
    const owners = new Map();
    for (const assetId of entry.assetIds) {
      const owner = this.runtime.assetPcm.get(assetId)
        || this.runtime.historyAssetPcm.get(assetId);
      if (!owner) return null;
      owners.set(assetId, owner);
    }
    return owners;
  }

  _playbackFor(entry, owners) {
    const pcmById = new Map();
    for (const [assetId, owner] of owners) {
      if (verifiedAssetPcm.has(owner)) {
        const asset = entry.document && entry.document.assets && entry.document.assets[assetId];
        pcmById.set(assetId, {
          ...owner.hydrate(),
          label: asset && asset.label,
          role: asset && asset.role,
        });
      } else {
        pcmById.set(assetId, owner);
      }
    }
    return pcmById;
  }

  _documentForActiveSource(document) {
    const activeSourceId = this.project.activeSourceId;
    if (!activeSourceId || !document || !document.sources || !document.sources[activeSourceId]) {
      return document;
    }
    return { ...document, activeSourceId };
  }

  _resolvePlaybackPointers(pcmById) {
    for (const scene of this.project.machine.scenes) {
      for (const track of scene.tracks) {
        if (!track) continue;
        track.sample = track.sampleId && pcmById.has(track.sampleId)
          ? pcmById.get(track.sampleId) : null;
      }
    }
  }

  _step(from, to) {
    if (!this._snapshot || !from.length) return false;
    const target = from[from.length - 1];
    // Preflight the complete target before taking another snapshot, popping a
    // stack, applying a document, or advancing revision.
    const owners = this._ownersFor(target);
    if (!owners) return false;
    const pcmById = this._playbackFor(target, owners);
    const now = this._takeEntry(false);
    const document = this._documentForActiveSource(target.document);
    this._applying = true;
    try {
      this._snapshot.applyDocument(document, pcmById);
    } finally {
      this._applying = false;
    }
    for (const [assetId, owner] of owners) this.runtime.assetPcm.set(assetId, owner);
    this._resolvePlaybackPointers(pcmById);

    from.pop();
    this._releaseEntry(target);
    this._retainEntry(now);
    to.push(now);
    const targetIds = new Set(target.assetIds);
    for (const assetId of now.assetIds) {
      if (!targetIds.has(assetId)) this.runtime.assetPcm.delete(assetId);
    }
    this._trimHistory();
    this.revision++;
    this.dispatchEvent(new CustomEvent('change', { detail: { kind: 'history', revision: this.revision } }));
    return true;
  }

  // Every mutation goes through here so autosave (later) can observe all of them.
  update(kind, fn, { history = 'record' } = {}) {
    if (history !== 'record' && history !== 'none') throw new TypeError('Unknown history mode');
    // Snapshot BEFORE the mutation, so undo lands on the prior state. Skipped
    // while an undo is itself being applied, and for pure-transport churn.
    if (history === 'record' && this._snapshot && !this._applying && kind !== 'history') {
      const entry = this._takeEntry(true);
      this._clearStack(this._future);
      this._retainEntry(entry);
      this._past.push(entry);
      this._trimHistory();
    }
    fn(this.project, this.runtime);
    this.revision++;
    this.dispatchEvent(new CustomEvent('change', { detail: { kind, revision: this.revision } }));
  }
}
