// Persistence core, per docs/CONTRACT-PERSIST.md: pure serializeProject +
// applySnapshot (in-place restore) and the OpfsStore adapter. The pure pair is
// node-testable (scratch/test_persist.mjs); only OpfsStore touches the browser.
// Autosave scheduling and restore orchestration live in persist-controller.js.

import { normalizeVoice } from '../machine/compile.js';
import { applyStudioSnapshot, createStudio, studioHasContent } from '../studio/model.js';
import { canonicalLoomPlanId, reidentifyLoomPlan, sameLoomPlanContent } from '../loom/identity.js';
import {
  adoptVerifiedAssetPcmOwners,
  createProject,
  hasCanonicalProjectState,
  hasCompatibleProjectMutationState,
  installVerifiedAssetPcm,
} from './project-store.js';

export const FORMAT_VERSION = 2;
export const V3_FORMAT_VERSION = 3;

const DIR_NAME = 'yellowjacket-v1';
const MAX_STEPS = 64;
const SOURCE_ID_RE = /^sha256:[0-9a-f]{64}$/;
const V3_LIMITS = Object.freeze({
  projectJsonBytes: 16 * 1024 * 1024,
  sources: 256,
  clips: 65536,
  aliases: 16,
  sourceBytes: 250 * 1024 * 1024,
});

// A project can be real without a source recording: SYNTH and CRATE both make
// instruments directly. Keep this pure so the controller and test harness use
// the same definition when deciding whether there is anything worth saving.
export function projectHasContent(project, runtime = {}) {
  if (!project || typeof project !== 'object') return false;
  if (project.sources && typeof project.sources === 'object'
      && Object.keys(project.sources).length) return true;
  const source = runtime.sourceBytes || project.sourceBytes;
  if (source && ((Number(source.byteLength) || 0) > 0 || (Number(source.size) || 0) > 0)) return true;
  if (Array.isArray(project.words) && project.words.length) return true;
  if (Array.isArray(project.clips) && project.clips.length) return true;
  if (runtime.repairs && runtime.repairs.length) return true;
  if (project.repairs && project.repairs.length) return true;
  if (project.assets && Object.keys(project.assets).length) return true;
  if (studioHasContent(project.studio)) return true;
  if (project.loom && (project.loom.plan
    || (project.loom.plans && Object.keys(project.loom.plans).length))) return true;

  const machine = project.machine;
  const scenes = machine && Array.isArray(machine.scenes) ? machine.scenes : [];
  for (const scene of scenes) {
    const tracks = scene && Array.isArray(scene.tracks) ? scene.tracks : [];
    for (const track of tracks) {
      if (!track) continue;
      if (track.sampleId) return true;
      if (track.steps && Array.from(track.steps).some(Boolean)) return true;
      if (track.stepData && Object.keys(track.stepData).length) return true;
    }
  }
  const song = machine && machine.song;
  if (song && Array.isArray(song.chain) && song.chain.length) return true;
  const defaults = createProject(Array.isArray(project.chain) ? clone(project.chain) : []);
  if (machine && Array.isArray(machine.scenes) && Array.isArray(defaults.machine.scenes)) {
    for (let index = 0; index < Math.min(machine.scenes.length, defaults.machine.scenes.length); index++) {
      const scene = machine.scenes[index];
      const baseline = defaults.machine.scenes[index];
      if (!scene || !baseline) continue;
      for (const key of ['name', 'bpm', 'swing', 'seed']) if (scene[key] !== baseline[key]) return true;
      if (JSON.stringify(scene.drums) !== JSON.stringify(baseline.drums)
          || JSON.stringify(scene.loomLane) !== JSON.stringify(baseline.loomLane)) return true;
      const tracks = Array.isArray(scene.tracks) ? scene.tracks : [];
      for (let trackIndex = 0; trackIndex < Math.min(tracks.length, baseline.tracks.length); trackIndex++) {
        const track = tracks[trackIndex];
        const baseTrack = baseline.tracks[trackIndex];
        if (!track || !baseTrack) continue;
        for (const key of [
          'len', 'gainDb', 'pan', 'mute', 'solo', 'duckSource', 'duckDb', 'choke',
          'chokeGroup', 'sendVerb', 'sendDelay',
        ]) if (track[key] !== baseTrack[key]) return true;
        if (JSON.stringify(track.voice) !== JSON.stringify(baseTrack.voice)) return true;
      }
    }
    if (JSON.stringify(machine.space) !== JSON.stringify(defaults.machine.space)) return true;
  }
  if (project.wire && JSON.stringify(project.wire) !== JSON.stringify(defaults.wire)) return true;
  return !!(project.loom && Number.isSafeInteger(project.loom.weaveCount) && project.loom.weaveCount > 0);
}

export class FormatVersionError extends Error {
  constructor(version, expectedVersion = FORMAT_VERSION) {
    super('unsupported project formatVersion ' + String(version)
      + ' (this bench reads formatVersion ' + expectedVersion + ')');
    this.name = 'FormatVersionError';
    this.formatVersion = version;
    this.expectedVersion = expectedVersion;
  }
}

export class ProjectDataError extends Error {
  constructor(code, { path = null, kind = 'document', id = null, issues = undefined } = {}) {
    super(code);
    this.name = 'ProjectDataError';
    this.code = code;
    this.path = path;
    this.kind = kind;
    this.id = id;
    if (issues !== undefined) this.issues = issues;
  }
}

// Task 10 installs these as an inactive document layer. The public v2 aliases
// above remain binding until Task 12 performs the atomic controller switch.
export function snapshotDocV3(project, runtime) {
  void runtime;
  return projectDocumentV3(project, Date.now());
}
export function serializeProjectV3(project, runtime, options = {}) {
  const savedAt = options.savedAt === undefined ? Date.now() : options.savedAt;
  const json = projectDocumentV3(project, savedAt);
  if (!runtime || !(runtime.assetPcm instanceof Map)
      || Object.getPrototypeOf(runtime.assetPcm) !== Map.prototype) {
    throw new ProjectDataError('ASSET_OWNERSHIP', { kind: 'sample' });
  }
  const reachable = reachableIds(json.machine);
  const metadata = Object.keys(json.assets);
  const owners = Array.from(runtime.assetPcm.keys());
  if (!sameStringSet(reachable, metadata) || !sameStringSet(reachable, owners)) {
    throw new ProjectDataError('ASSET_OWNERSHIP', { kind: 'sample' });
  }
  const sampleFiles = reachable.slice().sort(compareAssetIds).map((id) => {
    const owner = runtime.assetPcm.get(id);
    let bytes;
    try {
      bytes = owner.copyBytes();
    } catch {
      throw new ProjectDataError('SAMPLE_PCM', { kind: 'sample', id });
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== json.assets[id].payload.byteLength) {
      throw new ProjectDataError('SAMPLE_BYTE_LENGTH', { kind: 'sample', id });
    }
    return {
      id,
      bytes: bytes.slice(),
      byteLength: bytes.byteLength,
      sha256: json.assets[id].payload.sha256,
    };
  });
  return { json, sourceIds: Object.keys(json.sources).sort(), sampleFiles };
}
export function validateProjectDocument(value) {
  const document = detachJsonDocument(value);
  if (!document) return { ok: false, issues: [{ code: 'JSON_SHAPE', path: '/' }] };
  return validateDetachedProjectDocument(document);
}
export async function preflightProjectPayloads(input) {
  return preflightPayloadsV3(input);
}
export function applySnapshotV3(json, options) { return applyProjectDocumentV3(json, options); }
export async function migrateV2Project(input) { return migrateLegacyV2(input); }

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
    chokeGroup: track.chokeGroup,
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
    drums: scene.drums ? clone(scene.drums) : null,
    loomLane: scene.loomLane ? clone(scene.loomLane) : null,
    tracks: scene.tracks.map(serializeTrack),
  };
}

function serializeTranscript(project) {
  const count = Array.isArray(project.words) ? project.words.length : 0;
  const source = project.transcript && Array.isArray(project.transcript.gapCuts)
    ? project.transcript.gapCuts : [];
  return { gapCuts: Array.from({ length: count }, (_, index) => !!source[index]) };
}

function compareAssetIds(left, right) {
  const a = /^a([1-9][0-9]*)$/.exec(left);
  const b = /^a([1-9][0-9]*)$/.exec(right);
  if (a && b) return Number(a[1]) - Number(b[1]);
  return String(left).localeCompare(String(right));
}

function reachableIds(machine) {
  const ids = [];
  const seen = new Set();
  const scenes = machine && Array.isArray(machine.scenes) ? machine.scenes : [];
  for (const scene of scenes) {
    const tracks = scene && Array.isArray(scene.tracks) ? scene.tracks : [];
    for (const track of tracks) {
      const id = track && track.sampleId;
      if (typeof id === 'string' && id.length && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const set = new Set(left);
  return set.size === left.length && right.every((id) => set.has(id));
}

function projectDocumentV3(project, savedAt) {
  if (!hasCanonicalProjectState(project)) {
    throw new ProjectDataError('PROJECT_STATE', { path: '/' });
  }
  if (!Number.isSafeInteger(savedAt) || Math.abs(savedAt) > 8.64e15) {
    throw new ProjectDataError('SAVED_AT', { path: '/savedAt' });
  }
  const machine = project.machine;
  if (!machine || !Array.isArray(machine.scenes)) {
    throw new ProjectDataError('MACHINE', { path: '/machine' });
  }
  return {
    formatVersion: V3_FORMAT_VERSION,
    savedAt,
    activeSourceId: project.activeSourceId,
    allocators: clone(project.allocators),
    sources: clone(project.sources),
    clips: clone(project.clips),
    assets: clone(project.assets),
    machine: {
      activeScene: machine.activeScene,
      scenes: machine.scenes.map(serializeScene),
      song: machine.song ? clone(machine.song) : null,
      space: machine.space ? clone(machine.space) : null,
      drums: machine.drums ? clone(machine.drums) : null,
    },
    studio: clone(project.studio),
    loom: clone(project.loom),
    wire: clone(project.wire),
  };
}

const V3_ROOT_KEYS = new Set([
  'formatVersion', 'savedAt', 'activeSourceId', 'allocators', 'sources', 'clips',
  'assets', 'machine', 'studio', 'loom', 'wire',
]);
const SOURCE_KEYS = new Set([
  'id', 'displayName', 'aliases', 'addedAt', 'origin', 'payload', 'audio', 'rights', 'document',
]);
const SOURCE_DOCUMENT_KEYS = new Set(['words', 'transcript', 'chain', 'repairs', 'anchors']);
const CLIP_KEYS = new Set([
  'id', 'sourceId', 'start', 'end', 'tag', 'label', 'score', 'features', 'createdAt', 'generator',
]);
const ASSET_CORE_KEYS = new Set([
  'id', 'kind', 'label', 'role', 'sampleRate', 'channelCount', 'frames', 'payload', 'provenance',
]);
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const CLIP_ID_RE = /^c([1-9][0-9]*)$/;
const ASSET_ID_RE = /^a([1-9][0-9]*)$/;
const DESCRIPTOR_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const textEncoder = new TextEncoder();

function isPlain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  return isPlain(value) && Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function subsetKeys(value, allowed) {
  return isPlain(value) && Object.keys(value).every((key) => allowed.has(key));
}

function utf8AtMost(value, bytes, { nonempty = false } = {}) {
  return typeof value === 'string' && (!nonempty || value.length > 0)
    && textEncoder.encode(value).byteLength <= bytes;
}

function safeProduct(...values) {
  let product = 1;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || (value && product > Number.MAX_SAFE_INTEGER / value)) return null;
    product *= value;
  }
  return product;
}

function detachJsonDocument(value) {
  const seen = new Set();
  let nodes = 0;
  function visit(current, depth) {
    if (depth > 64 || ++nodes > 1_000_000) throw new TypeError();
    if (current === null || typeof current === 'boolean' || typeof current === 'string') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) throw new TypeError();
      return current;
    }
    if (!current || typeof current !== 'object' || ArrayBuffer.isView(current)
        || current instanceof ArrayBuffer || seen.has(current)) throw new TypeError();
    const prototype = Reflect.getPrototypeOf(current);
    if (Array.isArray(current)) {
      if (prototype !== Array.prototype) throw new TypeError();
    } else if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    seen.add(current);
    const keys = Reflect.ownKeys(current);
    if (keys.some((key) => typeof key !== 'string' || key === '__proto__')) throw new TypeError();
    const out = Array.isArray(current) ? new Array(current.length) : {};
    if (Array.isArray(current) && keys.filter((key) => key !== 'length').length !== current.length) throw new TypeError();
    for (const key of keys) {
      if (key === 'length' && Array.isArray(current)) continue;
      const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.enumerable !== true) throw new TypeError();
      Object.defineProperty(out, key, {
        value: visit(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true,
      });
    }
    seen.delete(current);
    return out;
  }
  try {
    const detached = visit(value, 0);
    // The platform clone rejects transparent Proxies, which ordinary
    // descriptor inspection cannot distinguish from their target.
    structuredClone(value);
    return detached;
  } catch {
    return null;
  }
}

function boundedJson(value, depth = 0, budget = { nodes: 0, bytes: 0 }) {
  if (depth > 32 || ++budget.nodes > 100_000) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value === 'string') {
    budget.bytes += textEncoder.encode(value).byteLength;
    return budget.bytes <= 128 * 1024;
  }
  if (Array.isArray(value)) return value.every((entry) => boundedJson(entry, depth + 1, budget));
  if (!isPlain(value)) return false;
  for (const [key, entry] of Object.entries(value)) {
    budget.bytes += textEncoder.encode(key).byteLength;
    if (budget.bytes > 128 * 1024 || !boundedJson(entry, depth + 1, budget)) return false;
  }
  return true;
}

function sameJson(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object'
      || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.keys(left);
  const b = Object.keys(right);
  return a.length === b.length && a.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

function validSourceBase(source) {
  if (!utf8AtMost(source.displayName, 1024, { nonempty: true })
      || source.displayName !== source.displayName.trim()
      || Array.from(source.displayName).length > 255
      || !Array.isArray(source.aliases) || source.aliases.length > V3_LIMITS.aliases
      || new Set(source.aliases).size !== source.aliases.length
      || source.aliases.some((alias) => !utf8AtMost(alias, 1024, { nonempty: true })
        || alias !== alias.trim() || Array.from(alias).length > 255)
      || !Number.isSafeInteger(source.addedAt) || Math.abs(source.addedAt) > 8.64e15
      || !exactKeys(source.origin, new Set(['kind', 'url']))
      || !['file', 'url', 'demo', 'field', 'generated'].includes(source.origin.kind)
      || !exactKeys(source.payload, new Set(['byteLength', 'mediaType', 'extension']))
      || !Number.isSafeInteger(source.payload.byteLength) || source.payload.byteLength <= 0
      || source.payload.byteLength > V3_LIMITS.sourceBytes
      || !exactKeys(source.audio, new Set(['sampleRate', 'channelCount', 'frames']))
      || !Number.isSafeInteger(source.audio.sampleRate) || source.audio.sampleRate <= 0
      || !Number.isSafeInteger(source.audio.channelCount) || source.audio.channelCount <= 0
      || !Number.isSafeInteger(source.audio.frames) || source.audio.frames <= 0
      || !exactKeys(source.rights, new Set(['basis', 'license', 'attribution', 'notes']))
      || !['unknown', 'original-recording', 'public-domain', 'licensed', 'permission', 'fair-use-review']
        .includes(source.rights.basis)) return false;
  if (source.origin.kind === 'url') {
    try {
      const url = new URL(source.origin.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
          || url.hash || url.href !== source.origin.url || !utf8AtMost(source.origin.url, 4096)) return false;
    } catch { return false; }
  } else if (source.origin.url !== null) return false;
  if (!(source.payload.mediaType === null || (typeof source.payload.mediaType === 'string'
      && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(source.payload.mediaType)
      && utf8AtMost(source.payload.mediaType, 127)))) return false;
  if (!(source.payload.extension === null || (typeof source.payload.extension === 'string'
      && /^[a-z0-9]{1,16}$/.test(source.payload.extension)))) return false;
  for (const [key, limit] of [['license', 2048], ['attribution', 2048], ['notes', 8192]]) {
    if (!(source.rights[key] === null || utf8AtMost(source.rights[key], limit))) return false;
  }
  return true;
}

function validateSourceEnvelope(id, source) {
  if (!SOURCE_ID_RE.test(id) || !exactKeys(source, SOURCE_KEYS) || source.id !== id
      || !validSourceBase(source)) return false;
  const document = source.document;
  if (!exactKeys(document, SOURCE_DOCUMENT_KEYS)
      || !exactKeys(document.transcript, new Set(['gapCuts']))
      || !exactKeys(document.anchors, new Set(['bpm', 'barOneTime']))) return false;
  return (document.words === null || (Array.isArray(document.words) && boundedJson(document.words)))
    && Array.isArray(document.transcript.gapCuts) && boundedJson(document.transcript.gapCuts)
    && Array.isArray(document.chain) && boundedJson(document.chain)
    && Array.isArray(document.repairs) && boundedJson(document.repairs);
}

function validateClipRecord(clip, sources) {
  if (!subsetKeys(clip, CLIP_KEYS) || !exactKeys({
    id: clip.id, sourceId: clip.sourceId, start: clip.start, end: clip.end,
  }, new Set(['id', 'sourceId', 'start', 'end']))) return false;
  const match = typeof clip.id === 'string' && CLIP_ID_RE.exec(clip.id);
  if (!match || !Number.isSafeInteger(Number(match[1])) || !SOURCE_ID_RE.test(clip.sourceId)
      || !Object.hasOwn(sources, clip.sourceId) || !Number.isFinite(clip.start)
      || !Number.isFinite(clip.end) || clip.start < 0 || clip.end <= clip.start) return false;
  for (const key of ['tag', 'label']) if (clip[key] !== undefined && !utf8AtMost(clip[key], 1024)) return false;
  if (clip.score !== undefined && !Number.isFinite(clip.score)) return false;
  if (clip.features !== undefined && !boundedJson(clip.features)) return false;
  if (clip.createdAt !== undefined && !(clip.createdAt === null
      || (Number.isSafeInteger(clip.createdAt) && Math.abs(clip.createdAt) <= 8.64e15))) return false;
  if (clip.generator !== undefined && (!exactKeys(clip.generator, new Set(['kind', 'version', 'runId']))
      || !DESCRIPTOR_RE.test(clip.generator.kind) || !Number.isSafeInteger(clip.generator.version)
      || clip.generator.version <= 0 || !utf8AtMost(clip.generator.runId, 255, { nonempty: true }))) return false;
  return true;
}

function assetAllowedKeys(kind) {
  const fields = new Set(ASSET_CORE_KEYS);
  if (kind === 'synth') fields.add('formula');
  if (kind === 'modal') fields.add('modes');
  if (kind === 'factory-drum') {
    for (const key of [
      'factoryKitId', 'factoryVoiceId', 'model', 'engineVersion', 'seed', 'params', 'oversample', 'metrics',
    ]) fields.add(key);
  }
  return fields;
}

function validAssetVariant(asset) {
  if (asset.kind === 'sample') return true;
  if (asset.kind === 'synth') return utf8AtMost(asset.formula, 8192, { nonempty: true });
  if (asset.kind === 'modal') {
    return Array.isArray(asset.modes) && asset.modes.length <= 64 && asset.modes.every((mode) => (
      exactKeys(mode, new Set(['freqHz', 'tauSec', 'amp', 'phase', 'energyFrac']))
      && Number.isFinite(mode.freqHz) && mode.freqHz > 0
      && Number.isFinite(mode.tauSec) && mode.tauSec > 0
      && Number.isFinite(mode.amp) && Number.isFinite(mode.phase)
      && Number.isFinite(mode.energyFrac) && mode.energyFrac >= 0 && mode.energyFrac <= 1
    ));
  }
  // Descriptor-valid future kinds carry the exact core envelope only. Their
  // additional grammar can be introduced with the reader that understands it;
  // this reader must neither reject the core record nor admit unknown freight.
  if (asset.kind !== 'factory-drum') return true;
  if (!utf8AtMost(asset.factoryKitId, 256, { nonempty: true })
      || !utf8AtMost(asset.factoryVoiceId, 256, { nonempty: true })
      || !utf8AtMost(asset.model, 256, { nonempty: true })
      || !Number.isSafeInteger(asset.engineVersion) || asset.engineVersion <= 0
      || !Number.isSafeInteger(asset.seed) || asset.seed < 0 || asset.seed > 0xffffffff
      || !isPlain(asset.params) || Object.keys(asset.params).length > 64
      || Object.values(asset.params).some((value) => !Number.isFinite(value))
      || !Number.isSafeInteger(asset.oversample) || asset.oversample < 1 || asset.oversample > 64) return false;
  return asset.metrics === undefined || (exactKeys(asset.metrics, new Set(['frames', 'seconds']))
    && asset.metrics.frames === asset.frames && asset.metrics.seconds === asset.frames / asset.sampleRate);
}

function validTransforms(transforms) {
  if (!Array.isArray(transforms) || transforms.length > 32 || !boundedJson(transforms)) return false;
  return transforms.every((transform) => isPlain(transform)
    && Number.isSafeInteger(transform.schemaVersion) && transform.schemaVersion > 0
    && typeof transform.kind === 'string' && DESCRIPTOR_RE.test(transform.kind));
}

function validProvenance(document, asset) {
  const provenance = asset.provenance;
  if (provenance === undefined) return true;
  if (!isPlain(provenance) || !validTransforms(provenance.transforms)) return false;
  if (provenance.binding === 'external') {
    return exactKeys(provenance, new Set(['kind', 'binding', 'descriptor', 'transforms']))
      && DESCRIPTOR_RE.test(provenance.kind) && isPlain(provenance.descriptor)
      && boundedJson(provenance.descriptor);
  }
  if (!exactKeys(provenance, new Set([
    'kind', 'binding', 'sourceId', 'clipId', 'sourceSpan', 'extraction', 'transforms',
  ])) || provenance.kind !== 'source-clip' || provenance.binding !== 'project'
      || !exactKeys(provenance.sourceSpan, new Set(['start', 'end']))
      || !exactKeys(provenance.extraction, new Set([
        'startFrame', 'endFrame', 'sampleRate', 'channelCount', 'buffer',
      ]))) return false;
  const matches = Array.isArray(document.clips)
    ? document.clips.filter((clip) => clip && clip.id === provenance.clipId) : [];
  const source = isPlain(document.sources) ? document.sources[provenance.sourceId] : null;
  if (matches.length !== 1 || !isPlain(source) || !isPlain(source.audio)
      || matches[0].sourceId !== provenance.sourceId
      || matches[0].start !== provenance.sourceSpan.start || matches[0].end !== provenance.sourceSpan.end) return false;
  const startScaled = provenance.sourceSpan.start * source.audio.sampleRate;
  const endScaled = provenance.sourceSpan.end * source.audio.sampleRate;
  const cap = safeProduct(source.audio.sampleRate, 30);
  if (!Number.isFinite(startScaled) || !Number.isFinite(endScaled)
      || Math.abs(startScaled) > Number.MAX_SAFE_INTEGER || Math.abs(endScaled) > Number.MAX_SAFE_INTEGER
      || cap === null) return false;
  const startFrame = Math.floor(startScaled);
  const naturalEnd = Math.ceil(endScaled);
  if (startFrame > Number.MAX_SAFE_INTEGER - cap) return false;
  const endFrame = Math.min(naturalEnd, startFrame + cap);
  const extraction = provenance.extraction;
  if (startFrame < 0 || naturalEnd > source.audio.frames || extraction.startFrame !== startFrame
      || extraction.endFrame !== endFrame || extraction.sampleRate !== source.audio.sampleRate
      || extraction.channelCount !== source.audio.channelCount
      || !['original', 'repaired'].includes(extraction.buffer)
      || asset.sampleRate !== extraction.sampleRate || asset.channelCount !== extraction.channelCount
      || asset.frames !== endFrame - startFrame) return false;
  const spectral = provenance.transforms.filter((transform) => transform.kind === 'spectral-repair-stack');
  if (extraction.buffer === 'original') return spectral.length === 0;
  return spectral.length === 1 && provenance.transforms[0] === spectral[0]
    && spectral[0].schemaVersion === 1 && Array.isArray(spectral[0].repairs)
    && spectral[0].repairs.some((repair) => repair && repair.enabled === true);
}

function validateAssetRecord(document, id, asset) {
  const match = ASSET_ID_RE.exec(id);
  if (!match || !Number.isSafeInteger(Number(match[1])) || !subsetKeys(asset, assetAllowedKeys(asset && asset.kind))
      || asset.id !== id || typeof asset.kind !== 'string' || !DESCRIPTOR_RE.test(asset.kind)
      || !utf8AtMost(asset.label, 1024, { nonempty: true })
      || (asset.role !== undefined && !utf8AtMost(asset.role, 256))
      || !Number.isSafeInteger(asset.sampleRate) || asset.sampleRate <= 0
      || !Number.isSafeInteger(asset.channelCount) || asset.channelCount <= 0
      || !Number.isSafeInteger(asset.frames) || asset.frames < 0
      || !exactKeys(asset.payload, new Set(['byteLength', 'sha256']))
      || !Number.isSafeInteger(asset.payload.byteLength) || asset.payload.byteLength < 0
      || !SHA256_RE.test(asset.payload.sha256)) return false;
  const byteLength = safeProduct(asset.frames, asset.channelCount, 4);
  return byteLength !== null && byteLength === asset.payload.byteLength
    && validAssetVariant(asset) && validProvenance(document, asset)
    && textEncoder.encode(JSON.stringify(asset)).byteLength <= 128 * 1024;
}

function validTrack(track) {
  const keys = new Set([
    'sampleId', 'voice', 'steps', 'stepData', 'len', 'gainDb', 'pan', 'mute', 'solo',
    'duckSource', 'duckDb', 'choke', 'chokeGroup', 'sendVerb', 'sendDelay',
  ]);
  if (!exactKeys(track, keys) || !(track.sampleId === null || typeof track.sampleId === 'string')
      || !isPlain(track.voice) || !sameJson(track.voice, normalizeVoice(track.voice))
      || !Array.isArray(track.steps) || track.steps.length !== MAX_STEPS
      || track.steps.some((step) => !Number.isSafeInteger(step) || step < 0 || step > 255)
      || !isPlain(track.stepData) || !boundedJson(track.stepData)
      || Object.keys(track.stepData).some((key) => !/^(0|[1-5]?[0-9]|6[0-3])$/.test(key))
      || !Number.isSafeInteger(track.len) || track.len < 1 || track.len > 64
      || !Number.isFinite(track.gainDb) || track.gainDb < -48 || track.gainDb > 6
      || !Number.isFinite(track.pan) || track.pan < -1 || track.pan > 1
      || typeof track.mute !== 'boolean' || typeof track.solo !== 'boolean'
      || !Number.isSafeInteger(track.duckSource) || track.duckSource < -1 || track.duckSource > 7
      || !Number.isFinite(track.duckDb) || typeof track.choke !== 'boolean'
      || !Number.isSafeInteger(track.chokeGroup) || track.chokeGroup < 0 || track.chokeGroup > 4
      || !Number.isFinite(track.sendVerb) || track.sendVerb < 0 || track.sendVerb > 1
      || !Number.isFinite(track.sendDelay) || track.sendDelay < 0 || track.sendDelay > 1) return false;
  return true;
}

function validScene(scene) {
  if (!exactKeys(scene, new Set([
    'id', 'name', 'bpm', 'swing', 'seed', 'drums', 'loomLane', 'tracks',
  ])) || !utf8AtMost(scene.id, 256, { nonempty: true })
      || !utf8AtMost(scene.name, 1024, { nonempty: true })
      || !Number.isFinite(scene.bpm) || scene.bpm < 30 || scene.bpm > 300
      || !Number.isFinite(scene.swing) || scene.swing < 0 || scene.swing > 100
      || !Number.isSafeInteger(scene.seed) || scene.seed < 0 || scene.seed > 0xffffffff
      || !exactKeys(scene.drums, new Set(['kitId', 'grooveId', 'variation']))
      || !(scene.drums.kitId === null || typeof scene.drums.kitId === 'string')
      || !(scene.drums.grooveId === null || typeof scene.drums.grooveId === 'string')
      || !Number.isSafeInteger(scene.drums.variation) || scene.drums.variation < 0
      || !exactKeys(scene.loomLane, new Set([
        'planId', 'enabled', 'gainDb', 'pan', 'repeatSteps', 'startStep',
      ])) || !(scene.loomLane.planId === null || typeof scene.loomLane.planId === 'string')
      || typeof scene.loomLane.enabled !== 'boolean'
      || !Number.isFinite(scene.loomLane.gainDb) || scene.loomLane.gainDb < -48 || scene.loomLane.gainDb > 6
      || !Number.isFinite(scene.loomLane.pan) || scene.loomLane.pan < -1 || scene.loomLane.pan > 1
      || !Number.isSafeInteger(scene.loomLane.repeatSteps) || scene.loomLane.repeatSteps < 1
      || scene.loomLane.repeatSteps > 64 || !Number.isSafeInteger(scene.loomLane.startStep)
      || scene.loomLane.startStep < 0 || scene.loomLane.startStep > 63
      || !Array.isArray(scene.tracks) || scene.tracks.length !== 8 || !scene.tracks.every(validTrack)) return false;
  return true;
}

function validMachine(machine, loom) {
  if (!exactKeys(machine, new Set(['activeScene', 'scenes', 'song', 'space', 'drums']))
      || !Array.isArray(machine.scenes) || machine.scenes.length !== 8 || !machine.scenes.every(validScene)
      || !Number.isSafeInteger(machine.activeScene) || machine.activeScene < 0
      || machine.activeScene >= machine.scenes.length
      || !exactKeys(machine.song, new Set(['chain', 'loop'])) || !Array.isArray(machine.song.chain)
      || typeof machine.song.loop !== 'boolean'
      || machine.song.chain.some((entry) => !exactKeys(entry, new Set(['scene', 'reps']))
        || !Number.isSafeInteger(entry.scene) || entry.scene < 0 || entry.scene >= machine.scenes.length
        || !Number.isSafeInteger(entry.reps) || entry.reps < 1 || entry.reps > 99)
      || !exactKeys(machine.space, new Set([
        'verbSec', 'verbDecay', 'verbMix', 'delayDivision', 'delayFeedback', 'delayMix',
      ]))) return false;
  const space = machine.space;
  if (!Number.isFinite(space.verbSec) || space.verbSec < 0.1 || space.verbSec > 8
      || !Number.isFinite(space.verbDecay) || space.verbDecay < 0.5 || space.verbDecay > 8
      || !Number.isFinite(space.verbMix) || space.verbMix < 0 || space.verbMix > 1
      || typeof space.delayDivision !== 'string' || !Number.isFinite(space.delayFeedback)
      || space.delayFeedback < 0 || space.delayFeedback > 0.95
      || !Number.isFinite(space.delayMix) || space.delayMix < 0 || space.delayMix > 1
      || !sameJson(machine.drums, machine.scenes[machine.activeScene].drums)) return false;
  const planIds = new Set(Object.keys((loom && loom.plans) || {}));
  return machine.scenes.every((scene) => scene.loomLane.planId === null || planIds.has(scene.loomLane.planId));
}

function validStudio(studio) {
  if (!isPlain(studio)) return false;
  const normalized = createStudio();
  applyStudioSnapshot(normalized, studio);
  return sameJson(normalized, studio);
}

function validLoom(loom) {
  if (!exactKeys(loom, new Set(['weaveCount', 'plan', 'activePlanId', 'plans']))
      || !Number.isSafeInteger(loom.weaveCount) || loom.weaveCount < 0 || !isPlain(loom.plans)
      || !boundedJson(loom)) return false;
  for (const [id, plan] of Object.entries(loom.plans)) {
    if (!isPlain(plan) || plan.id !== id || plan.contentId !== id || canonicalLoomPlanId(plan) !== id) return false;
    if (Array.isArray(plan.events) && plan.events.some((event, index) => (
      !isPlain(event) || event.id !== id + '-event-' + (index + 1)
    ))) return false;
  }
  if (loom.activePlanId === null) return loom.plan === null;
  return typeof loom.activePlanId === 'string' && Object.hasOwn(loom.plans, loom.activePlanId)
    && isPlain(loom.plan) && sameJson(loom.plan, loom.plans[loom.activePlanId]);
}

function validWire(wire) {
  return exactKeys(wire, new Set(['inId', 'outId', 'clockOut', 'noteBase', 'mappings']))
    && (wire.inId === null || typeof wire.inId === 'string')
    && (wire.outId === null || typeof wire.outId === 'string')
    && typeof wire.clockOut === 'boolean'
    && Number.isSafeInteger(wire.noteBase) && wire.noteBase >= 0 && wire.noteBase <= 119
    && isPlain(wire.mappings) && boundedJson(wire.mappings);
}

function validateDetachedProjectDocument(document) {
  const issues = [];
  const seen = new Set();
  const add = (code, path) => {
    const key = code + '\0' + path;
    if (!seen.has(key)) { seen.add(key); issues.push({ code, path }); }
  };
  if (!exactKeys(document, V3_ROOT_KEYS)) add('JSON_SHAPE', '/');
  if (document.formatVersion !== V3_FORMAT_VERSION) add('FORMAT_VERSION', '/formatVersion');
  if (!Number.isSafeInteger(document.savedAt) || Math.abs(document.savedAt) > 8.64e15) add('JSON_SHAPE', '/savedAt');
  if (!isPlain(document.sources)) add('SOURCE_RECORD', '/sources');
  const sources = isPlain(document.sources) ? Object.entries(document.sources) : [];
  if (sources.length > V3_LIMITS.sources) add('SOURCE_LIMIT', '/sources');
  if ((sources.length === 0) !== (document.activeSourceId === null)
      || (sources.length && (!SOURCE_ID_RE.test(document.activeSourceId)
        || !Object.hasOwn(document.sources, document.activeSourceId)))) add('ACTIVE_SOURCE', '/activeSourceId');
  for (const [id, source] of sources) if (!validateSourceEnvelope(id, source)) add('SOURCE_RECORD', '/sources/' + id);

  if (!Array.isArray(document.clips)) add('CLIP_ID', '/clips');
  const clips = Array.isArray(document.clips) ? document.clips : [];
  if (clips.length > V3_LIMITS.clips) add('CLIP_LIMIT', '/clips');
  const clipIds = new Set();
  let highestClip = 0;
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    if (!validateClipRecord(clip, document.sources || {})) {
      const code = clip && SOURCE_ID_RE.test(clip.sourceId) && !(document.sources && Object.hasOwn(document.sources, clip.sourceId))
        ? 'CLIP_SOURCE' : 'CLIP_ID';
      add(code, '/clips/' + index);
    }
    if (clip && typeof clip.id === 'string') {
      if (clipIds.has(clip.id)) add('CLIP_DUPLICATE', '/clips/' + index + '/id');
      clipIds.add(clip.id);
      const match = CLIP_ID_RE.exec(clip.id);
      if (match) {
        const suffix = Number(match[1]);
        if (Number.isSafeInteger(suffix)) highestClip = Math.max(highestClip, suffix);
      }
    }
  }

  if (!exactKeys(document.allocators, new Set(['clip', 'asset']))
      || !Number.isSafeInteger(document.allocators.clip) || document.allocators.clip < highestClip
      || !Number.isSafeInteger(document.allocators.asset) || document.allocators.asset < 0) {
    add('ALLOCATOR_STALE', '/allocators');
  }
  if (!isPlain(document.assets)) add('ASSET_SHAPE', '/assets');
  const assets = isPlain(document.assets) ? Object.entries(document.assets) : [];
  let highestAsset = 0;
  for (const [id, asset] of assets) {
    if (!validateAssetRecord(document, id, asset)) {
      add(asset && asset.provenance !== undefined && !validProvenance(document, asset)
        ? 'PROVENANCE' : 'ASSET_SHAPE', '/assets/' + id);
    }
    const match = ASSET_ID_RE.exec(id);
    if (match) {
      const suffix = Number(match[1]);
      if (Number.isSafeInteger(suffix)) highestAsset = Math.max(highestAsset, suffix);
    }
  }
  if (document.allocators && Number.isSafeInteger(document.allocators.asset)
      && document.allocators.asset < highestAsset) add('ALLOCATOR_STALE', '/allocators/asset');

  if (!validLoom(document.loom)) add('LOOM', '/loom');
  if (!validMachine(document.machine, document.loom)) add('MACHINE', '/machine');
  if (!validStudio(document.studio)) add('STUDIO', '/studio');
  if (!validWire(document.wire)) add('WIRE', '/wire');
  const reachable = reachableIds(document.machine);
  if (!sameStringSet(reachable, assets.map(([id]) => id))) add('ASSET_OWNERSHIP', '/assets');
  return issues.length ? { ok: false, issues } : { ok: true };
}

function copyPayloadBytes(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
  return null;
}

async function digestId(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
  return 'sha256:' + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function snapshotPayloadMap(value, expected) {
  try {
    if (!(value instanceof Map) || Object.getPrototypeOf(value) !== Map.prototype) return null;
    const entries = Array.from(Map.prototype.entries.call(value));
    if (entries.length !== expected.length) return null;
    const wanted = new Set(expected);
    if (entries.some(([key]) => typeof key !== 'string' || !wanted.has(key))) return null;
    return new Map(entries.map(([id, bytes]) => [id, copyPayloadBytes(bytes)]));
  } catch {
    return null;
  }
}

async function preflightPayloadsV3(input) {
  if (!input || typeof input !== 'object') throw new ProjectDataError('JSON_SHAPE');
  const document = detachJsonDocument(input.json);
  if (!document) throw new ProjectDataError('JSON_SHAPE');
  const validation = validateDetachedProjectDocument(document);
  if (!validation.ok) throw new ProjectDataError(validation.issues[0].code, { issues: validation.issues });
  const sourceIds = Object.keys(document.sources).sort();
  const assetIds = reachableIds(document.machine).slice().sort(compareAssetIds);
  const sourceInput = snapshotPayloadMap(input.sourcePayloads, sourceIds);
  if (!sourceInput) {
    throw new ProjectDataError('SOURCE_OWNERSHIP', { kind: 'source' });
  }
  const sampleInput = snapshotPayloadMap(input.samplePayloads, assetIds);
  if (!sampleInput) {
    throw new ProjectDataError('SAMPLE_OWNERSHIP', { kind: 'sample' });
  }
  const sourcePayloads = new Map();
  for (const id of sourceIds) {
    const bytes = sourceInput.get(id);
    if (!bytes || bytes.byteLength !== document.sources[id].payload.byteLength) {
      throw new ProjectDataError('SOURCE_BYTE_LENGTH', { kind: 'source', id });
    }
    if (await digestId(bytes) !== id) throw new ProjectDataError('SOURCE_DIGEST', { kind: 'source', id });
    sourcePayloads.set(id, bytes);
  }
  const samplePayloads = new Map();
  const assetPcm = new Map();
  const { validateSamplePayload } = await import('./sample-payload.js');
  for (const id of assetIds) {
    const bytes = sampleInput.get(id);
    if (!bytes || bytes.byteLength !== document.assets[id].payload.byteLength) {
      throw new ProjectDataError('SAMPLE_BYTE_LENGTH', { kind: 'sample', id });
    }
    const checked = await validateSamplePayload(document.assets[id], bytes);
    if (!checked.ok) {
      const code = checked.issue === 'byteLength' ? 'SAMPLE_BYTE_LENGTH'
        : checked.issue === 'pcm' ? 'SAMPLE_PCM' : 'SAMPLE_DIGEST';
      throw new ProjectDataError(code, { kind: 'sample', id });
    }
    samplePayloads.set(id, bytes);
    assetPcm.set(id, checked.sample);
  }
  await adoptVerifiedAssetPcmOwners(documentForOwnerAdoption(document), assetPcm);
  return { document, sourcePayloads, samplePayloads, assetPcm };
}

// Adoption requires an exact createProject owner. Use a temporary canonical
// project containing the detached document's ownership graph; live state is
// neither available nor mutated during payload preflight.
function documentForOwnerAdoption(document) {
  const project = createProject([]);
  project.machine = clone(document.machine);
  project.assets = clone(document.assets);
  return project;
}

function writableDataProperty(object, key) {
  const descriptor = object && Reflect.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    && descriptor.writable === true ? descriptor : null;
}

function mutableArray(value, length = null) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || !Object.isExtensible(value) || (length !== null && value.length !== length)) return false;
  const descriptor = writableDataProperty(value, 'length');
  if (!descriptor || descriptor.value !== value.length) return false;
  for (let index = 0; index < value.length; index++) {
    const slot = writableDataProperty(value, String(index));
    if (!slot || slot.configurable !== true || slot.value !== value[index]) return false;
  }
  return true;
}

function mutablePlain(value) {
  if (!isPlain(value) || !Object.isExtensible(value)) return false;
  return Object.keys(value).every((key) => {
    const descriptor = writableDataProperty(value, key);
    return descriptor && descriptor.configurable === true;
  });
}

function compatibleStepArray(value) {
  try {
    return value instanceof Uint8Array
      && Object.getPrototypeOf(value) === Uint8Array.prototype
      && value.length === MAX_STEPS
      && Reflect.getOwnPropertyDescriptor(value, 'set') === undefined;
  } catch {
    return false;
  }
}

function mutableRack(value) {
  return mutableArray(value) && value.every((entry) => (
    mutablePlain(entry) && mutablePlain(entry.params)
  ));
}

function mutableSourceDocument(value) {
  return mutablePlain(value)
    && (value.words === null || mutableArray(value.words))
    && mutablePlain(value.transcript) && mutableArray(value.transcript.gapCuts)
    && mutableRack(value.chain) && mutableArray(value.repairs) && mutablePlain(value.anchors);
}

function assertApplyCompatibility(project, runtime, document) {
  if (!hasCompatibleProjectMutationState(project)) {
    throw new ProjectDataError('PROJECT_TARGET', { path: '/' });
  }
  for (const key of [
    'fileName', 'words', 'transcript', 'chain', 'activeSourceId', 'sources', 'clips',
    'allocators', 'assets', 'machine', 'studio', 'wire', 'loom',
  ]) if (!writableDataProperty(project, key)) throw new ProjectDataError('PROJECT_TARGET', { path: '/' + key });
  if (!mutablePlain(project.sources) || !mutablePlain(project.assets)
      || !mutableArray(project.clips) || !mutablePlain(project.allocators)
      || (project.words !== null && !mutableArray(project.words))
      || !mutablePlain(project.transcript) || !mutableArray(project.transcript.gapCuts)
      || !mutableRack(project.chain)
      || !mutablePlain(project.machine) || !mutableArray(project.machine.scenes, document.machine.scenes.length)
      || !mutablePlain(project.machine.song) || !mutableArray(project.machine.song.chain)
      || !mutablePlain(project.machine.space)) throw new ProjectDataError('PROJECT_TARGET');
  for (let sceneIndex = 0; sceneIndex < project.machine.scenes.length; sceneIndex++) {
    const scene = project.machine.scenes[sceneIndex];
    if (!mutablePlain(scene) || !mutablePlain(scene.drums) || !mutablePlain(scene.loomLane)
        || !mutableArray(scene.tracks, document.machine.scenes[sceneIndex].tracks.length)) {
      throw new ProjectDataError('PROJECT_TARGET', { path: `/machine/scenes/${sceneIndex}` });
    }
    for (let trackIndex = 0; trackIndex < scene.tracks.length; trackIndex++) {
      const track = scene.tracks[trackIndex];
      if (!mutablePlain(track) || !compatibleStepArray(track.steps) || !mutablePlain(track.stepData)
          || !mutablePlain(track.voice) || !writableDataProperty(track, 'sample')) {
        throw new ProjectDataError('PROJECT_TARGET', { path: `/machine/scenes/${sceneIndex}/tracks/${trackIndex}` });
      }
    }
  }
  if (!mutablePlain(project.studio) || !mutableArray(project.studio.tracks, document.studio.tracks.length)) {
    throw new ProjectDataError('PROJECT_TARGET', { path: '/studio' });
  }
  for (let index = 0; index < project.studio.tracks.length; index++) {
    const track = project.studio.tracks[index];
    if (!mutablePlain(track) || !mutablePlain(track.synth) || !mutableArray(track.steps, document.studio.tracks[index].steps.length)) {
      throw new ProjectDataError('PROJECT_TARGET', { path: `/studio/tracks/${index}` });
    }
  }
  if (!mutablePlain(project.loom) || !mutablePlain(project.loom.plans)
      || !mutablePlain(project.wire) || !mutablePlain(project.wire.mappings)
      || !runtime || !mutableArray(runtime.repairs)
      || !(runtime.assetPcm instanceof Map) || Object.getPrototypeOf(runtime.assetPcm) !== Map.prototype) {
    throw new ProjectDataError('PROJECT_TARGET');
  }
  for (const [id, record] of Object.entries(project.sources)) {
    if (Object.hasOwn(document.sources, id)
        && (!mutablePlain(record) || !mutableSourceDocument(record.document))) {
      throw new ProjectDataError('PROJECT_TARGET', { path: '/sources/' + id });
    }
  }
  for (const [id, asset] of Object.entries(project.assets)) {
    if (Object.hasOwn(document.assets, id) && !mutablePlain(asset)) {
      throw new ProjectDataError('PROJECT_TARGET', { path: '/assets/' + id });
    }
  }
  for (const [id, plan] of Object.entries(project.loom.plans)) {
    if (Object.hasOwn(document.loom.plans, id) && !mutablePlain(plan)) {
      throw new ProjectDataError('PROJECT_TARGET', { path: '/loom/plans/' + id });
    }
  }
}

function replaceArrayValues(target, source) {
  target.splice(0, target.length, ...source.map((value) => clone(value)));
}

function replacePlainValues(target, source, retained = {}) {
  for (const key of Object.keys(target)) if (!Object.hasOwn(source, key)) delete target[key];
  for (const [key, value] of Object.entries(source)) {
    if (retained[key]) {
      target[key] = retained[key];
      if (Array.isArray(retained[key]) && Array.isArray(value)) replaceArrayValues(retained[key], value);
      else replacePlainValues(retained[key], value);
    } else target[key] = clone(value);
  }
}

function applyRack(target, source) {
  const prior = target.slice();
  const used = new Set();
  const next = source.map((saved) => {
    const existing = prior.find((entry) => !used.has(entry) && isPlain(entry) && entry.id === saved.id);
    if (!existing) return clone(saved);
    used.add(existing);
    const params = isPlain(existing.params) && isPlain(saved.params) ? existing.params : null;
    replacePlainValues(existing, saved, params ? { params } : {});
    return existing;
  });
  target.splice(0, target.length, ...next);
}

function applySourceDocument(target, source) {
  if (Array.isArray(source.words) && Array.isArray(target.words)) replaceArrayValues(target.words, source.words);
  else target.words = clone(source.words);
  if (!isPlain(target.transcript)) target.transcript = { gapCuts: [] };
  if (!Array.isArray(target.transcript.gapCuts)) target.transcript.gapCuts = [];
  replaceArrayValues(target.transcript.gapCuts, source.transcript.gapCuts);
  if (!Array.isArray(target.chain)) target.chain = [];
  applyRack(target.chain, source.chain);
  if (!Array.isArray(target.repairs)) target.repairs = [];
  replaceArrayValues(target.repairs, source.repairs);
  if (!isPlain(target.anchors)) target.anchors = {};
  replacePlainValues(target.anchors, source.anchors);
  for (const key of Object.keys(target)) if (!SOURCE_DOCUMENT_KEYS.has(key)) delete target[key];
}

function applySources(project, sourceMap) {
  for (const id of Object.keys(project.sources)) if (!Object.hasOwn(sourceMap, id)) delete project.sources[id];
  for (const [id, saved] of Object.entries(sourceMap)) {
    const existing = project.sources[id];
    if (!isPlain(existing)) {
      project.sources[id] = clone(saved);
      continue;
    }
    const document = isPlain(existing.document) ? existing.document : {};
    replacePlainValues(existing, saved, { document });
    applySourceDocument(document, saved.document);
  }
}

function applyTrackV3(track, saved) {
  track.sampleId = saved.sampleId;
  replacePlainValues(track.voice, saved.voice);
  Uint8Array.prototype.set.call(track.steps, saved.steps);
  replacePlainValues(track.stepData, saved.stepData);
  for (const key of [
    'len', 'gainDb', 'pan', 'mute', 'solo', 'duckSource', 'duckDb', 'choke',
    'chokeGroup', 'sendVerb', 'sendDelay',
  ]) track[key] = saved[key];
}

function applyMachineV3(machine, saved) {
  for (let index = 0; index < machine.scenes.length; index++) {
    const scene = machine.scenes[index];
    const next = saved.scenes[index];
    for (const key of ['id', 'name', 'bpm', 'swing', 'seed']) scene[key] = next[key];
    replacePlainValues(scene.drums, next.drums);
    replacePlainValues(scene.loomLane, next.loomLane);
    for (let track = 0; track < scene.tracks.length; track++) applyTrackV3(scene.tracks[track], next.tracks[track]);
  }
  machine.activeScene = saved.activeScene;
  replaceArrayValues(machine.song.chain, saved.song.chain);
  machine.song.loop = saved.song.loop;
  replacePlainValues(machine.space, saved.space);
}

function applyStudioV3(studio, saved) {
  for (const key of [
    'touched', 'bpm', 'swing', 'bars', 'masterDb', 'metronome', 'keyRoot', 'scale', 'ideaSeed',
  ]) studio[key] = saved[key];
  for (let index = 0; index < studio.tracks.length; index++) {
    const track = studio.tracks[index];
    const next = saved.tracks[index];
    for (const key of [
      'id', 'name', 'preset', 'gainDb', 'pan', 'mute', 'solo', 'sendVerb', 'sendDelay', 'length',
    ]) track[key] = next[key];
    replacePlainValues(track.synth, next.synth);
    replaceArrayValues(track.steps, next.steps);
  }
}

function applyLoomV3(loom, saved) {
  loom.weaveCount = saved.weaveCount;
  for (const id of Object.keys(loom.plans)) if (!Object.hasOwn(saved.plans, id)) delete loom.plans[id];
  for (const [id, plan] of Object.entries(saved.plans)) {
    if (isPlain(loom.plans[id])) replacePlainValues(loom.plans[id], plan);
    else loom.plans[id] = clone(plan);
  }
  loom.activePlanId = saved.activePlanId;
  loom.plan = saved.activePlanId === null ? null : loom.plans[saved.activePlanId];
}

function applyWireV3(wire, saved) {
  for (const key of ['inId', 'outId', 'clockOut', 'noteBase']) wire[key] = saved[key];
  replacePlainValues(wire.mappings, saved.mappings);
}

function applyAssets(project, assets) {
  for (const id of Object.keys(project.assets)) if (!Object.hasOwn(assets, id)) delete project.assets[id];
  for (const [id, meta] of Object.entries(assets)) {
    if (isPlain(project.assets[id])) replacePlainValues(project.assets[id], meta);
    else project.assets[id] = clone(meta);
  }
}

function applyDocumentV3(document, project, runtime) {
  applySources(project, document.sources);
  project.activeSourceId = document.activeSourceId;
  project.allocators.clip = document.allocators.clip;
  project.allocators.asset = document.allocators.asset;
  replaceArrayValues(project.clips, document.clips);
  applyAssets(project, document.assets);
  applyMachineV3(project.machine, document.machine);
  applyStudioV3(project.studio, document.studio);
  applyLoomV3(project.loom, document.loom);
  applyWireV3(project.wire, document.wire);

  const active = document.activeSourceId && project.sources[document.activeSourceId];
  if (!active) {
    project.fileName = null;
    project.words = null;
    if (!isPlain(project.transcript)) project.transcript = { gapCuts: [] };
    if (!Array.isArray(project.transcript.gapCuts)) project.transcript.gapCuts = [];
    project.transcript.gapCuts.length = 0;
    applyRack(project.chain, []);
    runtime.repairs.length = 0;
  } else {
    const source = active.document;
    project.fileName = active.displayName;
    if (Array.isArray(source.words) && Array.isArray(project.words)) replaceArrayValues(project.words, source.words);
    else project.words = clone(source.words);
    if (!isPlain(project.transcript)) project.transcript = { gapCuts: [] };
    if (!Array.isArray(project.transcript.gapCuts)) project.transcript.gapCuts = [];
    replaceArrayValues(project.transcript.gapCuts, source.transcript.gapCuts);
    applyRack(project.chain, source.chain);
    replaceArrayValues(runtime.repairs, source.repairs);
  }
}

function applyProjectDocumentV3(json, { project, runtime, assetPcm } = {}) {
  const version = json && typeof json === 'object' ? json.formatVersion : json;
  if (version !== V3_FORMAT_VERSION) throw new FormatVersionError(version, V3_FORMAT_VERSION);
  const document = detachJsonDocument(json);
  if (!document) throw new ProjectDataError('JSON_SHAPE');
  const validation = validateDetachedProjectDocument(document);
  if (!validation.ok) throw new ProjectDataError(validation.issues[0].code, { issues: validation.issues });
  assertApplyCompatibility(project, runtime, document);

  // Exercise the complete mutation and owner install against isolated exact
  // containers first. No live object changes until every operation succeeds.
  const stagedProject = createProject(clone(document.sources[document.activeSourceId]?.document.chain || []));
  const stagedRuntime = { repairs: [], assetPcm: new Map() };
  assertApplyCompatibility(stagedProject, stagedRuntime, document);
  applyDocumentV3(document, stagedProject, stagedRuntime);
  installVerifiedAssetPcm(stagedProject, stagedRuntime, assetPcm);
  assertApplyCompatibility(project, runtime, document);

  applyDocumentV3(document, project, runtime);
  installVerifiedAssetPcm(project, runtime, assetPcm);
  if (!hasCompatibleProjectMutationState(project)) throw new ProjectDataError('PROJECT_TARGET');
}

const V2_ROOT_KEYS = new Set([
  'formatVersion', 'savedAt', 'fileName', 'sourceBytes', 'words', 'transcript', 'clips',
  'chain', 'machine', 'studio', 'loom', 'assets', 'repairs', 'anchors', 'wire',
]);

function migrationFault(code, options = {}) {
  return new ProjectDataError(code, { ...options, kind: 'migration' });
}

function legacyAssetHighWater(json, samplePayloads, reachable) {
  let highest = 0;
  for (const id of [
    ...Object.keys(json.assets || {}), ...Array.from(Map.prototype.keys.call(samplePayloads)), ...reachable,
  ]) {
    const match = typeof id === 'string' && ASSET_ID_RE.exec(id);
    if (!match) continue;
    const suffix = Number(match[1]);
    if (!Number.isSafeInteger(suffix)) throw migrationFault('MIGRATION_ASSET_ID', { id });
    highest = Math.max(highest, suffix);
  }
  return highest;
}

const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function canonicalLegacyFloat32Bytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength % 4) return null;
  const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const canonical = new Uint8Array(bytes.byteLength);
  const output = new DataView(canonical.buffer);
  for (let offset = 0; offset < bytes.byteLength; offset += 4) {
    const value = input.getFloat32(offset, HOST_LITTLE_ENDIAN);
    if (!Number.isFinite(value)) return null;
    output.setFloat32(offset, value, true);
  }
  return canonical;
}

function legacyDisplayName(value) {
  if (typeof value !== 'string') return 'source.bin';
  const candidate = value.trim();
  if (!candidate || candidate === '.' || candidate === '..'
      || /[\/\\\u0000-\u001f\u007f]/.test(candidate)
      || Array.from(candidate).length > 255 || textEncoder.encode(candidate).byteLength > 1024) {
    return 'source.bin';
  }
  return candidate;
}

function canonicalizeLegacyLoom(value, machine) {
  const saved = isPlain(value) ? value : {};
  const aliases = new Map();
  const plans = {};
  const install = (plan, fallback) => {
    if (!isPlain(plan)) return null;
    const canonical = reidentifyLoomPlan(clone(plan));
    if (!canonical) return null;
    if (plans[canonical.id] && !sameLoomPlanContent(plans[canonical.id], canonical)) {
      throw migrationFault('MIGRATION_LOOM');
    }
    plans[canonical.id] = canonical;
    if (typeof fallback === 'string') aliases.set(fallback, canonical.id);
    if (typeof plan.id === 'string') aliases.set(plan.id, canonical.id);
    return canonical.id;
  };
  if (isPlain(saved.plans)) for (const [id, plan] of Object.entries(saved.plans)) install(plan, id);
  let active = typeof saved.activePlanId === 'string' ? saved.activePlanId : null;
  if (isPlain(saved.plan)) {
    const legacy = typeof saved.plan.id === 'string' ? saved.plan.id : 'loom-legacy-plan';
    install(saved.plan, legacy);
    if (!active) active = legacy;
  }
  active = active ? (aliases.get(active) || (plans[active] ? active : null)) : null;
  for (const scene of machine.scenes) {
    const id = scene.loomLane.planId;
    if (typeof id === 'string') scene.loomLane.planId = aliases.get(id) || (plans[id] ? id : null);
  }
  return {
    weaveCount: Number.isSafeInteger(saved.weaveCount) && saved.weaveCount >= 0 ? saved.weaveCount : 0,
    plan: active ? plans[active] : null,
    activePlanId: active,
    plans,
  };
}

function canonicalizeLegacyStudio(value) {
  const studio = createStudio();
  if (isPlain(value)) applyStudioSnapshot(studio, value);
  return studio;
}

function canonicalizeLegacyWire(value) {
  const wire = createProject([]).wire;
  if (!isPlain(value)) return wire;
  wire.inId = typeof value.inId === 'string' ? value.inId : null;
  wire.outId = typeof value.outId === 'string' ? value.outId : null;
  wire.clockOut = value.clockOut === true;
  if (Number.isFinite(value.noteBase)) wire.noteBase = Math.max(0, Math.min(119, Math.trunc(value.noteBase)));
  if (isPlain(value.mappings) && boundedJson(value.mappings)) wire.mappings = clone(value.mappings);
  return wire;
}

function canonicalizeLegacyMachine(value, remap) {
  const defaults = createProject([]).machine;
  if (!isPlain(value) || !Array.isArray(value.scenes) || value.scenes.length !== defaults.scenes.length) {
    throw migrationFault('MIGRATION_MACHINE');
  }
  // Version 2 writes the same fixed-point shape used by v3. Clone first, then
  // rewrite only asset identities; validation below rejects noncanonical data.
  const machine = clone(value);
  for (const scene of machine.scenes) {
    if (!scene || !Array.isArray(scene.tracks)) throw migrationFault('MIGRATION_MACHINE');
    for (const track of scene.tracks) {
      if (track && typeof track.sampleId === 'string' && remap.has(track.sampleId)) {
        track.sampleId = remap.get(track.sampleId);
      }
    }
  }
  return machine;
}

async function migrateLegacyV2(input) {
  if (!input || typeof input !== 'object') throw migrationFault('MIGRATION_ENVELOPE');
  const decode = input.decode;
  const json = detachJsonDocument(input.json);
  if (!json || !exactKeys(json, V2_ROOT_KEYS) || json.formatVersion !== FORMAT_VERSION
      || !Number.isSafeInteger(json.savedAt) || Math.abs(json.savedAt) > 8.64e15
      || !Array.isArray(json.clips) || !isPlain(json.assets) || !isPlain(json.machine)) {
    throw migrationFault('MIGRATION_ENVELOPE');
  }
  const backed = json.sourceBytes !== null;
  if (backed) {
    if (!exactKeys(json.sourceBytes, new Set(['size'])) || !Number.isSafeInteger(json.sourceBytes.size)
        || json.sourceBytes.size <= 0 || typeof decode !== 'function') {
      throw migrationFault('MIGRATION_SOURCE');
    }
  } else if (input.sourceBytes !== null && input.sourceBytes !== undefined) {
    throw migrationFault('MIGRATION_SOURCE');
  }
  if (!backed && json.clips.length) throw migrationFault('MIGRATION_SOURCELESS_CLIP');
  const reachable = reachableIds(json.machine);
  const legacySamples = snapshotPayloadMap(input.samplePayloads, reachable);
  if (!legacySamples) {
    throw migrationFault('MIGRATION_SAMPLE_OWNERSHIP');
  }
  const sampleCopies = new Map();
  for (const id of reachable) {
    const meta = json.assets[id];
    if (!isPlain(meta) || meta.id !== id || !Number.isSafeInteger(meta.frames) || meta.frames < 0
        || !Number.isSafeInteger(meta.sampleRate) || meta.sampleRate <= 0
        || !Number.isSafeInteger(meta.channelCount) || meta.channelCount <= 0) {
      throw migrationFault('MIGRATION_ASSET', { id });
    }
    const expected = safeProduct(meta.frames, meta.channelCount, 4);
    const bytes = legacySamples.get(id);
    if (expected === null || !bytes || bytes.byteLength !== expected) {
      throw migrationFault('SAMPLE_BYTE_LENGTH', { id });
    }
    const canonical = canonicalLegacyFloat32Bytes(bytes);
    if (!canonical) throw migrationFault('SAMPLE_PCM', { id });
    sampleCopies.set(id, canonical);
  }
  for (const [id, meta] of Object.entries(json.assets)) {
    if (!isPlain(meta) || meta.id !== id) throw migrationFault('MIGRATION_ASSET_ID', { id });
  }
  let highWater = legacyAssetHighWater(json, legacySamples, reachable);
  const remap = new Map();
  for (const id of reachable) {
    const match = ASSET_ID_RE.exec(id);
    if (match && Number.isSafeInteger(Number(match[1]))) remap.set(id, id);
    else remap.set(id, 'a' + (++highWater));
  }

  let sourcePayload = null;
  let sourceId = null;
  let decodedActive = null;
  if (backed) {
    sourcePayload = copyPayloadBytes(input.sourceBytes);
    if (!sourcePayload || sourcePayload.byteLength !== json.sourceBytes.size) {
      throw migrationFault('SOURCE_BYTE_LENGTH');
    }
    sourceId = await digestId(sourcePayload);
    const decodeBuffer = sourcePayload.slice().buffer;
    try {
      decodedActive = await decode(decodeBuffer);
    } catch (error) {
      throw migrationFault('MIGRATION_DECODE');
    }
    const buffer = decodedActive && decodedActive.buffer;
    if (!buffer || !Number.isSafeInteger(buffer.sampleRate) || buffer.sampleRate <= 0
        || !Number.isSafeInteger(buffer.numberOfChannels) || buffer.numberOfChannels <= 0
        || !Number.isSafeInteger(buffer.length) || buffer.length <= 0) {
      throw migrationFault('MIGRATION_DECODE');
    }
  }

  const machine = canonicalizeLegacyMachine(json.machine, remap);
  const loom = canonicalizeLegacyLoom(json.loom, machine);
  const studio = canonicalizeLegacyStudio(json.studio);
  const wire = canonicalizeLegacyWire(json.wire);
  const assets = {};
  const samplePayloads = new Map();
  const { validateSamplePayload } = await import('./sample-payload.js');
  for (const oldId of reachable) {
    const id = remap.get(oldId);
    const prior = clone(json.assets[oldId]);
    if (prior.provenance && prior.provenance.binding === 'project') {
      throw migrationFault('MIGRATION_PROVENANCE', { id: oldId });
    }
    delete prior.payload;
    const bytes = sampleCopies.get(oldId);
    const meta = {
      ...prior,
      id,
      channelCount: prior.channelCount,
      payload: { byteLength: bytes.byteLength, sha256: await digestId(bytes) },
    };
    if (!validateAssetRecord({ clips: [], sources: {} }, id, meta)) {
      throw migrationFault('MIGRATION_ASSET', { id: oldId });
    }
    const checked = await validateSamplePayload(meta, bytes);
    if (!checked.ok) throw migrationFault('MIGRATION_ASSET', { id: oldId });
    assets[id] = meta;
    samplePayloads.set(id, bytes.slice());
  }

  const sources = {};
  const sourcePayloads = new Map();
  let activeSourceId = null;
  let clips = [];
  if (backed) {
    const displayName = legacyDisplayName(json.fileName);
    const suffix = /\.([a-z0-9]{1,16})$/.exec(displayName.toLowerCase());
    const record = {
      id: sourceId,
      displayName,
      aliases: [displayName],
      addedAt: json.savedAt,
      origin: { kind: 'file', url: null },
      payload: { byteLength: sourcePayload.byteLength, mediaType: null, extension: suffix ? suffix[1] : null },
      audio: {
        sampleRate: decodedActive.buffer.sampleRate,
        channelCount: decodedActive.buffer.numberOfChannels,
        frames: decodedActive.buffer.length,
      },
      rights: { basis: 'unknown', license: null, attribution: null, notes: null },
      document: {
        words: json.words === null ? null : clone(json.words),
        transcript: { gapCuts: clone(isPlain(json.transcript) && Array.isArray(json.transcript.gapCuts)
          ? json.transcript.gapCuts : []) },
        chain: clone(Array.isArray(json.chain) ? json.chain : []),
        repairs: clone(Array.isArray(json.repairs) ? json.repairs : []),
        anchors: clone(isPlain(json.anchors) ? json.anchors : { bpm: null, barOneTime: null }),
      },
    };
    if (!validateSourceEnvelope(sourceId, record)) throw migrationFault('MIGRATION_SOURCE_RECORD');
    sources[sourceId] = record;
    sourcePayloads.set(sourceId, sourcePayload.slice());
    activeSourceId = sourceId;
    clips = json.clips.map((legacy, index) => {
      if (!isPlain(legacy) || !Number.isFinite(legacy.start) || !Number.isFinite(legacy.end)
          || legacy.start < 0 || legacy.end <= legacy.start) throw migrationFault('MIGRATION_CLIP');
      const clip = { ...clone(legacy), id: 'c' + (index + 1), sourceId, createdAt: null };
      if (!validateClipRecord(clip, sources)) throw migrationFault('MIGRATION_CLIP');
      return clip;
    });
  }

  const document = {
    formatVersion: V3_FORMAT_VERSION,
    savedAt: json.savedAt,
    activeSourceId,
    allocators: { clip: clips.length, asset: highWater },
    sources,
    clips,
    assets,
    machine,
    studio,
    loom,
    wire,
  };
  const validation = validateDetachedProjectDocument(document);
  if (!validation.ok) throw migrationFault(validation.issues[0].code, { issues: validation.issues });
  try {
    const prepared = await preflightPayloadsV3({ document, json: document, sourcePayloads, samplePayloads });
    return { ...prepared, decodedActive, migratedFrom: FORMAT_VERSION };
  } catch (error) {
    if (error instanceof ProjectDataError) throw migrationFault(error.code, { id: error.id, issues: error.issues });
    throw error;
  }
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
    transcript: serializeTranscript(project),
    clips: clone(project.clips || []),
    chain: clone(project.chain || []),
    machine: {
      activeScene: machine.activeScene,
      scenes: machine.scenes.map(serializeScene),
      song: machine.song ? clone(machine.song) : null,
      space: machine.space ? clone(machine.space) : null,
      drums: machine.drums ? clone(machine.drums) : null,
    },
    studio: project.studio ? clone(project.studio) : null,
    loom: project.loom ? clone(project.loom) : null,
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
const UINT32_RANGE = 0x100000000;
const INT32_LIMIT = 0x80000000;

function legacyUint32(value) {
  const remainder = Math.trunc(value) % UINT32_RANGE;
  return remainder < 0 ? remainder + UINT32_RANGE : remainder;
}

function legacyInt32(value) {
  const unsigned = legacyUint32(value);
  return unsigned >= INT32_LIMIT ? unsigned - UINT32_RANGE : unsigned;
}

export function hydrateSample(meta, raw) {
  if (!meta || !raw) return null;
  const flat = raw instanceof Float32Array ? raw : new Float32Array(raw);
  const frames = Math.max(0, legacyInt32(meta.frames));
  const count = Math.max(1, legacyInt32(meta.channelCount));
  const length = safeProduct(frames, count);
  if (!frames || length === null || flat.length < length) return null;
  const channels = [];
  let offset = 0;
  for (let c = 0; c < count; c++) {
    channels.push(flat.slice(offset, offset + frames));
    offset += frames;
  }
  return { channels, sampleRate: meta.sampleRate, label: meta.label, role: meta.role };
}

function applyTrack(track, saved) {
  track.sampleId = typeof saved.sampleId === 'string' ? saved.sampleId : null;
  track.sample = null;   // PCM attaches after sample files load (RestorePlan)
  // Voice merges saved fields over the defaults, then hands the result to the
  // compiler's own normalizeVoice. This block used to re-implement all eleven
  // clamps by hand, and had already drifted: it used bitwise truncation for fitSteps
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
  if (Number.isFinite(saved.len)) track.len = legacyInt32(saved.len);
  if (Number.isFinite(saved.gainDb)) track.gainDb = saved.gainDb;
  if (Number.isFinite(saved.pan)) track.pan = saved.pan;
  if (typeof saved.mute === 'boolean') track.mute = saved.mute;
  if (typeof saved.solo === 'boolean') track.solo = saved.solo;
  if (Number.isFinite(saved.duckSource)) track.duckSource = legacyInt32(saved.duckSource);
  if (Number.isFinite(saved.duckDb)) track.duckDb = saved.duckDb;
  if (typeof saved.choke === 'boolean') track.choke = saved.choke;
  if (Number.isFinite(saved.chokeGroup)) {
    track.chokeGroup = Math.max(0, Math.min(4, legacyInt32(saved.chokeGroup)));
  }
}

function applyScene(scene, saved) {
  if (typeof saved.id === 'string') scene.id = saved.id;
  if (typeof saved.name === 'string') scene.name = saved.name;
  // Written on the scene directly: machine.bpm/swing are active-scene aliases
  // and must never be the write path here.
  if (Number.isFinite(saved.bpm)) scene.bpm = saved.bpm;
  if (Number.isFinite(saved.swing)) scene.swing = saved.swing;
  if (Number.isFinite(saved.seed)) scene.seed = legacyUint32(saved.seed);
  if (scene.drums) {
    scene.drums.kitId = null;
    scene.drums.grooveId = null;
    scene.drums.variation = 0;
    if (saved.drums && typeof saved.drums === 'object') {
      scene.drums.kitId = typeof saved.drums.kitId === 'string' ? saved.drums.kitId : null;
      scene.drums.grooveId = typeof saved.drums.grooveId === 'string' ? saved.drums.grooveId : null;
      if (Number.isFinite(saved.drums.variation)) {
        scene.drums.variation = Math.max(0, legacyInt32(saved.drums.variation));
      }
    }
  }
  if (scene.loomLane) {
    const lane = saved.loomLane && typeof saved.loomLane === 'object' ? saved.loomLane : {};
    scene.loomLane.planId = typeof lane.planId === 'string' ? lane.planId : null;
    scene.loomLane.enabled = lane.enabled !== false;
    scene.loomLane.gainDb = Number.isFinite(lane.gainDb)
      ? Math.max(-48, Math.min(6, lane.gainDb)) : -9;
    scene.loomLane.pan = Number.isFinite(lane.pan)
      ? Math.max(-1, Math.min(1, lane.pan)) : 0;
    scene.loomLane.repeatSteps = Number.isFinite(lane.repeatSteps)
      ? Math.max(1, Math.min(64, legacyInt32(lane.repeatSteps))) : 16;
    scene.loomLane.startStep = Number.isFinite(lane.startStep)
      ? Math.max(0, Math.min(63, legacyInt32(lane.startStep))) : 0;
  }
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

  if (!project.transcript || typeof project.transcript !== 'object') {
    project.transcript = { gapCuts: [] };
  }
  if (!Array.isArray(project.transcript.gapCuts)) project.transcript.gapCuts = [];
  project.transcript.gapCuts.length = 0;
  const savedGaps = json.transcript && Array.isArray(json.transcript.gapCuts)
    ? json.transcript.gapCuts : [];
  const gapCount = Array.isArray(project.words) ? project.words.length : 0;
  for (let i = 0; i < gapCount; i++) project.transcript.gapCuts.push(!!savedGaps[i]);

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
          const scene = legacyInt32(entry.scene);
          if (scene < 0 || scene >= machine.scenes.length) continue;
          const reps = Math.max(1, Math.min(99, legacyInt32(entry.reps) || 1));
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

  // Factory-kit identity is lightweight UI provenance. The actual PCM remains
  // ordinary persisted assets, so old projects and custom kits need no special
  // restore path.
  if (machine.drums && !(savedScenes[machine.activeScene]
    && savedScenes[machine.activeScene].drums)) {
    const savedDrums = savedMachine.drums;
    if (savedDrums && typeof savedDrums === 'object') {
      machine.drums.kitId = typeof savedDrums.kitId === 'string' ? savedDrums.kitId : null;
      machine.drums.grooveId = typeof savedDrums.grooveId === 'string' ? savedDrums.grooveId : null;
      if (Number.isFinite(savedDrums.variation)) {
        machine.drums.variation = Math.max(0, legacyInt32(savedDrums.variation));
      }
    }
  }

  // Studio is optional in formatVersion 2 so projects from the sampler-only
  // era open with a fresh instrument rack. Existing objects stay in place for
  // the controller and audio engine.
  if (project.studio && json.studio && typeof json.studio === 'object') {
    applyStudioSnapshot(project.studio, json.studio);
  }

  // LOOM is optional in formatVersion 2. It is JSON-only and deliberately
  // mutates in place because its controller holds the live project object.
  if (project.loom) {
    project.loom.weaveCount = 0;
    project.loom.plan = null;
    project.loom.activePlanId = null;
    if (!project.loom.plans || typeof project.loom.plans !== 'object') project.loom.plans = {};
    for (const id of Object.keys(project.loom.plans)) delete project.loom.plans[id];
    const planAliases = new Map();
    const bindPlanAlias = (alias, canonicalId) => {
      if (typeof alias !== 'string') return;
      const existing = planAliases.get(alias);
      if (existing && existing !== canonicalId) {
        throw new Error('LOOM PLAN ALIAS COLLISION · PROJECT WAS NOT TRUSTED');
      }
      planAliases.set(alias, canonicalId);
    };
    if (json.loom && typeof json.loom === 'object') {
      const installPlan = (savedPlan, fallbackId) => {
        if (!savedPlan || typeof savedPlan !== 'object') return null;
        const staleId = typeof savedPlan.id === 'string' ? savedPlan.id : null;
        const plan = reidentifyLoomPlan(clone(savedPlan));
        if (!plan) return null;
        const existing = project.loom.plans[plan.id];
        if (existing && !sameLoomPlanContent(existing, plan)) {
          throw new Error('LOOM PLAN ID COLLISION · PROJECT WAS NOT TRUSTED');
        }
        if (!existing) project.loom.plans[plan.id] = plan;
        bindPlanAlias(fallbackId, plan.id);
        bindPlanAlias(staleId, plan.id);
        return project.loom.plans[plan.id];
      };
      if (Number.isFinite(json.loom.weaveCount)) {
        project.loom.weaveCount = Math.max(0, legacyInt32(json.loom.weaveCount));
      }
      if (json.loom.plans && typeof json.loom.plans === 'object') {
        for (const id of Object.keys(json.loom.plans)) {
          const savedPlan = json.loom.plans[id];
          installPlan(savedPlan, id);
        }
      }
      let activeId = typeof json.loom.activePlanId === 'string'
        ? json.loom.activePlanId : null;
      if (json.loom.plan && typeof json.loom.plan === 'object') {
        const legacyId = typeof json.loom.plan.id === 'string'
          ? json.loom.plan.id : 'loom-legacy-plan';
        installPlan(json.loom.plan, legacyId);
        if (!activeId) activeId = legacyId;
      }
      const canonicalActiveId = activeId
        ? (planAliases.get(activeId) || (project.loom.plans[activeId] ? activeId : null))
        : null;
      if (canonicalActiveId && project.loom.plans[canonicalActiveId]) {
        project.loom.activePlanId = canonicalActiveId;
        project.loom.plan = project.loom.plans[canonicalActiveId];
      }
    }
    // Scene lanes were restored before the registry. Rewrite every persisted
    // reference through the canonical-id map; a dangling/forged reference is
    // quarantined instead of being allowed to name unrelated content. This
    // also clears stale lane references when an old document has no Loom block.
    for (const scene of machine.scenes) {
      const lane = scene && scene.loomLane;
      if (!lane || typeof lane.planId !== 'string') continue;
      const canonicalId = planAliases.get(lane.planId)
        || (project.loom.plans[lane.planId] ? lane.planId : null);
      lane.planId = canonicalId;
    }
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
  // Format v2 has no persisted allocators, but the current legacy assignment
  // path already uses project-local asset IDs. Lift only a valid live counter
  // above restored aN keys; allocation itself still rejects stale documents.
  if (project.allocators && Number.isSafeInteger(project.allocators.asset)
      && project.allocators.asset >= 0) {
    let highest = 0;
    for (const id of Object.keys(project.assets)) {
      const match = /^a([1-9][0-9]*)$/.exec(id);
      if (!match) continue;
      const suffix = Number(match[1]);
      if (Number.isSafeInteger(suffix)) highest = Math.max(highest, suffix);
    }
    project.allocators.asset = Math.max(project.allocators.asset, highest);
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
    if (Number.isFinite(json.wire.noteBase)) {
      w.noteBase = Math.max(0, Math.min(119, legacyInt32(json.wire.noteBase)));
    }
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
    if (name === 'project.json' && bytes.byteLength > V3_LIMITS.projectJsonBytes) {
      throw new ProjectDataError('PROJECT_JSON_TOO_LARGE', { path: '/project.json' });
    }
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

  // Read-only inventory for one directory level. Callers remain responsible for
  // validating names and file contents before adopting an entry.
  async listNames() {
    const names = [];
    for await (const [name, handle] of this._dir.entries()) {
      if (handle.kind === 'file') {
        names.push(name);
      } else if (handle.kind === 'directory') {
        for await (const [child, childHandle] of handle.entries()) {
          if (childHandle.kind === 'file') names.push(name + '/' + child);
        }
      }
    }
    return names.sort();
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
