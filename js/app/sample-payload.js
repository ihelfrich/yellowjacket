// Canonical PCM and asset-provenance trust boundary. This module deliberately
// owns no browser views, Web Audio objects, persistence handles, or transforms.

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const DESCRIPTOR_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_TRANSFORMS = 32;
const MAX_TRANSFORM_BYTES = 64 * 1024;
const textEncoder = new TextEncoder();

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function byteLengthFor(frames, channelCount) {
  if (!isSafeInteger(frames) || !isPositiveSafeInteger(channelCount)) return null;
  if (frames > Number.MAX_SAFE_INTEGER / channelCount) return null;
  const samples = frames * channelCount;
  if (samples > Number.MAX_SAFE_INTEGER / 4) return null;
  return samples * 4;
}

function copiedBytes(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
  return null;
}

function validSampleShape(sample) {
  if (!isObject(sample) || !isPositiveSafeInteger(sample.sampleRate)
      || !isPositiveSafeInteger(sample.channelCount) || !isSafeInteger(sample.frames)
      || !Array.isArray(sample.channels) || sample.channels.length !== sample.channelCount) {
    return null;
  }
  const byteLength = byteLengthFor(sample.frames, sample.channelCount);
  if (byteLength === null) return null;
  for (const channel of sample.channels) {
    if (!(Array.isArray(channel) || ArrayBuffer.isView(channel)) || channel.length !== sample.frames) return null;
    for (let frame = 0; frame < sample.frames; frame++) {
      const value = channel[frame];
      // Values outside Float32 range become infinity during serialization.
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) return null;
    }
  }
  return { byteLength };
}

function metaShape(meta) {
  if (!isObject(meta) || !isPositiveSafeInteger(meta.sampleRate)
      || !isPositiveSafeInteger(meta.channelCount) || !isSafeInteger(meta.frames)
      || !isObject(meta.payload) || !isSafeInteger(meta.payload.byteLength)
      || !SHA256_RE.test(meta.payload.sha256)) return null;
  const byteLength = byteLengthFor(meta.frames, meta.channelCount);
  if (byteLength === null || byteLength !== meta.payload.byteLength) return null;
  return { byteLength };
}

function bytesContainOnlyFiniteFloat32(bytes) {
  if (bytes.byteLength % 4) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < bytes.byteLength; offset += 4) {
    if (!Number.isFinite(view.getFloat32(offset, true))) return false;
  }
  return true;
}

function hashName(bytes) {
  return crypto.subtle.digest('SHA-256', bytes).then((digest) => {
    const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
    return 'sha256:' + hex;
  });
}

export function canonicalSampleBytes(sample) {
  const shape = validSampleShape(sample);
  if (!shape) return null;
  let bytes;
  try {
    bytes = new Uint8Array(shape.byteLength);
  } catch {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  for (const channel of sample.channels) {
    for (let frame = 0; frame < sample.frames; frame++, offset += 4) {
      view.setFloat32(offset, channel[frame], true);
    }
  }
  return bytes;
}

export async function describeSamplePayload(sample) {
  const bytes = canonicalSampleBytes(sample);
  if (!bytes) return null;
  return { bytes, byteLength: bytes.byteLength, sha256: await hashName(bytes) };
}

export class CanonicalPcm {
  #meta;
  #bytes;

  constructor(meta, bytes) {
    this.#meta = {
      sampleRate: meta.sampleRate,
      channelCount: meta.channelCount,
      frames: meta.frames,
    };
    this.#bytes = bytes.slice();
  }

  static fromVerified(meta, bytes) {
    const shape = metaShape(meta);
    if (!shape) return null;
    const copied = copiedBytes(bytes);
    if (!copied || copied.byteLength !== shape.byteLength || !bytesContainOnlyFiniteFloat32(copied)) {
      return null;
    }
    return new CanonicalPcm(meta, copied);
  }

  get byteLength() {
    return this.#bytes.byteLength;
  }

  copyBytes() {
    return this.#bytes.slice();
  }

  hydrate() {
    const channels = [];
    const view = new DataView(this.#bytes.buffer, this.#bytes.byteOffset, this.#bytes.byteLength);
    let offset = 0;
    for (let channel = 0; channel < this.#meta.channelCount; channel++) {
      const values = new Float32Array(this.#meta.frames);
      for (let frame = 0; frame < this.#meta.frames; frame++, offset += 4) {
        values[frame] = view.getFloat32(offset, true);
      }
      channels.push(values);
    }
    return { ...this.#meta, channels };
  }
}

export function hydrateCanonicalPcm(meta, bytes) {
  return CanonicalPcm.fromVerified(meta, bytes);
}

export async function validateSamplePayload(meta, bytes) {
  const shape = metaShape(meta);
  if (!shape) return { ok: false, issue: 'metadata' };
  const copied = copiedBytes(bytes);
  if (!copied || copied.byteLength !== shape.byteLength) return { ok: false, issue: 'byteLength' };
  if (!bytesContainOnlyFiniteFloat32(copied)) return { ok: false, issue: 'pcm' };
  let digest;
  try {
    digest = await hashName(copied);
  } catch {
    return { ok: false, issue: 'digest' };
  }
  if (digest !== meta.payload.sha256) return { ok: false, issue: 'digest' };
  const sample = CanonicalPcm.fromVerified(meta, copied);
  return sample ? { ok: true, sample } : { ok: false, issue: 'pcm' };
}

export function reachableAssetIds(machine) {
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

function idSet(value) {
  if (value instanceof Set) return new Set(value);
  if (value instanceof Map) return new Set(value.keys());
  if (Array.isArray(value)) return new Set(value);
  if (isObject(value)) return new Set(Object.keys(value));
  return null;
}

function sameIdSet(a, b) {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

export function validateAssetOwnership(project, payloadIds) {
  if (!isObject(project) || !isObject(project.assets)) return { ok: false, issue: 'assets' };
  const payload = idSet(payloadIds);
  if (!payload) return { ok: false, issue: 'payloadIds' };
  const reachable = new Set(reachableAssetIds(project.machine));
  const metadata = new Set(Object.keys(project.assets));
  if (!sameIdSet(reachable, metadata) || !sameIdSet(reachable, payload)) {
    return { ok: false, issue: 'ownership' };
  }
  return { ok: true };
}

function jsonValueIsBounded(value, depth = 0) {
  if (depth > 32 || value === null || typeof value === 'boolean') return depth <= 32;
  if (typeof value === 'string') return textEncoder.encode(value).byteLength <= MAX_TRANSFORM_BYTES;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => jsonValueIsBounded(entry, depth + 1));
  if (!isObject(value)) return false;
  return Object.entries(value).every(([key, entry]) => (
    textEncoder.encode(key).byteLength <= 256 && jsonValueIsBounded(entry, depth + 1)
  ));
}

function serializedBytes(value) {
  if (!jsonValueIsBounded(value)) return null;
  try {
    return textEncoder.encode(JSON.stringify(value));
  } catch {
    return null;
  }
}

function validKnownRepair(repair) {
  return isObject(repair) && typeof repair.id === 'string' && repair.id.length > 0
    && textEncoder.encode(repair.id).byteLength <= 255
    && Number.isFinite(repair.t0) && Number.isFinite(repair.t1) && repair.t0 >= 0 && repair.t1 > repair.t0
    && Number.isFinite(repair.f0) && Number.isFinite(repair.f1) && repair.f0 >= 0 && repair.f1 > repair.f0
    && Number.isFinite(repair.strength) && repair.strength > 0 && repair.strength <= 1
    && typeof repair.enabled === 'boolean'
    && typeof repair.label === 'string' && textEncoder.encode(repair.label).byteLength <= 1024;
}

function validateTransforms(transforms) {
  if (!Array.isArray(transforms) || transforms.length > MAX_TRANSFORMS) return null;
  const bytes = serializedBytes(transforms);
  if (!bytes || bytes.byteLength > MAX_TRANSFORM_BYTES) return null;
  let replayable = true;
  for (const transform of transforms) {
    if (!isObject(transform) || !DESCRIPTOR_RE.test(transform.kind) || !isPositiveSafeInteger(transform.schemaVersion)) {
      return null;
    }
    if (transform.kind === 'linear-gain' && transform.schemaVersion === 1) {
      if (!Number.isFinite(transform.gain) || transform.gain <= 0 || transform.gain > 64) return null;
    } else if (transform.kind === 'spectral-repair-stack' && transform.schemaVersion === 1) {
      if (!Array.isArray(transform.repairs) || !transform.repairs.every(validKnownRepair)) return null;
    } else {
      replayable = false;
    }
  }
  return { replayable };
}

function matchingProjectExtraction(project, asset, provenance) {
  if (!isObject(project) || !isObject(project.sources) || typeof provenance.sourceId !== 'string'
      || typeof provenance.clipId !== 'string') return false;
  const source = project.sources[provenance.sourceId];
  const clip = Array.isArray(project.clips) && project.clips.find((entry) => entry && entry.id === provenance.clipId);
  if (!source || !clip || clip.sourceId !== provenance.sourceId || !isObject(source.audio)
      || !isObject(provenance.sourceSpan) || !isObject(provenance.extraction)) return false;
  const { start, end } = provenance.sourceSpan;
  const extraction = provenance.extraction;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start
      || clip.start !== start || clip.end !== end
      || !isPositiveSafeInteger(source.audio.sampleRate) || !isPositiveSafeInteger(source.audio.channelCount)
      || !isSafeInteger(source.audio.frames)) return false;
  const scaledStart = start * source.audio.sampleRate;
  const scaledEnd = end * source.audio.sampleRate;
  if (!Number.isFinite(scaledStart) || !Number.isFinite(scaledEnd)
      || Math.abs(scaledStart) > Number.MAX_SAFE_INTEGER || Math.abs(scaledEnd) > Number.MAX_SAFE_INTEGER) return false;
  const startFrame = Math.floor(scaledStart);
  const endFrame = Math.ceil(scaledEnd);
  if (startFrame < 0 || endFrame > source.audio.frames || extraction.startFrame !== startFrame
      || extraction.endFrame !== endFrame || extraction.sampleRate !== source.audio.sampleRate
      || extraction.channelCount !== source.audio.channelCount
      || (extraction.buffer !== 'original' && extraction.buffer !== 'repaired')) return false;
  return isObject(asset) && asset.sampleRate === extraction.sampleRate
    && asset.channelCount === extraction.channelCount && asset.frames === endFrame - startFrame;
}

export function validateAssetProvenance(project, asset) {
  if (!isObject(asset) || !isObject(asset.provenance)) return { ok: false, issue: 'provenance' };
  const provenance = asset.provenance;
  if (!DESCRIPTOR_RE.test(provenance.kind) || (provenance.binding !== 'project' && provenance.binding !== 'external')) {
    return { ok: false, issue: 'provenance' };
  }
  const encoded = serializedBytes(provenance);
  if (!encoded || encoded.byteLength > MAX_TRANSFORM_BYTES) return { ok: false, issue: 'provenance' };
  if (provenance.binding === 'project' && !matchingProjectExtraction(project, asset, provenance)) {
    return { ok: false, issue: 'projectBinding' };
  }
  const transforms = validateTransforms(provenance.transforms);
  if (!transforms) return { ok: false, issue: 'transforms' };
  return { ok: true, replayable: transforms.replayable };
}
