// Crate store, per docs/CONTRACT-HARVEST.md section 3: the persistent
// instrument library. It lives in its OWN OPFS directory, so a session DISCARD
// (which wipes the 'yellowjacket-v1' project directory) never touches crated
// instruments. Layout: index.json holding {maxId, items:[meta]} rewritten on
// every mutation, plus one <id>.f32 per instrument. The index math is pure and
// node-testable (scratch/test_crate.mjs); only CrateStore methods touch OPFS.
// Deliberately self-contained: it repeats the feature-detect and file helpers
// of js/app/persist.js OpfsStore instead of importing them, so the two stores
// stay independently replaceable and the crate has no project-format coupling.

export const CRATE_DIR = 'yellowjacket-crate-v1';

const INDEX_NAME = 'index.json';
const DEFAULT_RATE = 44100;
const DASH = '—';

function jsonCopy(value) {
  if (value === undefined) return undefined;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : JSON.parse(encoded);
  } catch {
    return null;
  }
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// ---------- pure index math (no OPFS, no DOM) ----------

// ids are 'i' + a counter persisted as index.maxId. maxId only ever rises, so a
// removed id is never minted again and a stale meta can never shadow a new one.
function idNumber(id) {
  if (typeof id !== 'string' || id[0] !== 'i') return 0;
  const n = Number(id.slice(1));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function secondsOf(meta) {
  const rate = Number.isFinite(meta.sampleRate) && meta.sampleRate > 0 ? meta.sampleRate : 0;
  const frames = Number.isFinite(meta.frames) && meta.frames > 0 ? meta.frames : 0;
  if (!rate || !frames) return 0;
  return Math.round((frames / rate) * 100) / 100;
}

function normalizeMeta(meta) {
  const detached = jsonCopy(meta);
  const source = detached && typeof detached === 'object' && !Array.isArray(detached) ? detached : {};
  // Unknown keys ride through (forward tolerance, as in persist.js clone).
  return {
    ...source,
    id: source.id,
    name: typeof source.name === 'string' && source.name ? source.name : 'INSTRUMENT',
    role: typeof source.role === 'string' && source.role ? source.role : DASH,
    source: typeof source.source === 'string' && source.source ? source.source : DASH,
    sampleRate: Object.prototype.hasOwnProperty.call(source, 'sampleRate')
      ? source.sampleRate : DEFAULT_RATE,
    frames: Object.prototype.hasOwnProperty.call(source, 'frames') ? source.frames : 0,
    savedAt: Number.isFinite(source.savedAt) ? source.savedAt : 0,
  };
}

// Anything read off disk is untrusted: drop malformed metas, and lift maxId past
// every id actually present so a hand-edited index cannot mint a duplicate.
function normalizeIndex(index) {
  const src = index && typeof index === 'object' ? index : {};
  const raw = Array.isArray(src.items) ? src.items : [];
  const items = [];
  const seen = new Set();
  let maxId = Number.isFinite(src.maxId) && src.maxId > 0 ? Math.floor(src.maxId) : 0;
  for (const meta of raw) {
    if (!meta || typeof meta !== 'object') continue;
    const n = idNumber(meta.id);
    if (!n || seen.has(meta.id)) continue;
    seen.add(meta.id);
    items.push(normalizeMeta(meta));
    if (n > maxId) maxId = n;
  }
  return { maxId, items };
}

export function nextId(index) {
  return 'i' + (normalizeIndex(index).maxId + 1);
}

// Returns a NEW index; the caller writes it back. An explicit meta.id replaces
// the meta already under that id (put mints its own, so this is the repair path).
export function addMeta(index, meta) {
  const base = normalizeIndex(index);
  const src = meta && typeof meta === 'object' ? meta : {};
  const id = idNumber(src.id) ? src.id : 'i' + (base.maxId + 1);
  const next = normalizeMeta({ ...src, id });
  return {
    maxId: Math.max(base.maxId, idNumber(id)),
    items: base.items.filter((m) => m.id !== id).concat([next]),
  };
}

// maxId survives removal on purpose: ids must not be recycled onto a stale .f32.
export function removeMeta(index, id) {
  const base = normalizeIndex(index);
  return { maxId: base.maxId, items: base.items.filter((m) => m.id !== id) };
}

// Contract list() shape, newest first. seconds is derived here rather than
// stored, so it can never drift from frames/sampleRate.
export function listFromIndex(index) {
  const items = normalizeIndex(index).items.slice();
  items.sort((a, b) => (b.savedAt - a.savedAt) || (idNumber(b.id) - idNumber(a.id)));
  return items.map((m) => ({
    id: m.id,
    name: m.name,
    role: m.role,
    source: m.source,
    seconds: secondsOf(m),
    sampleRate: m.sampleRate,
    savedAt: m.savedAt,
  }));
}

// ---------- OPFS adapter ----------

// open() returns null wherever the main-thread write path is missing (notably
// Safari before FileSystemFileHandle.createWritable), matching OpfsStore.open:
// callers treat null as "no crate on this browser", never as an error.
export class CrateStore {
  constructor(root, dir) {
    this._root = root;
    this._dir = dir;
    this._chain = Promise.resolve();
  }

  static async open() {
    try {
      if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory) return null;
      if (typeof FileSystemFileHandle === 'undefined'
        || typeof FileSystemFileHandle.prototype.createWritable !== 'function') return null;
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(CRATE_DIR, { create: true });
      return new CrateStore(root, dir);
    } catch (e) {
      return null;
    }
  }

  // ---------- public API ----------

  // Every mutation is read-modify-write on one index file, so they queue: two
  // overlapping put()s would both read the pre-write index, mint the same id,
  // and the loser's PCM would be overwritten. A rejected job still releases the
  // queue. Reads do not queue; they are a single file read.
  _mutate(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  put(spec) {
    let snapshot;
    try {
      snapshot = snapshotPutSpec(spec || {});
    } catch (error) {
      return Promise.reject(error);
    }
    return this._mutate(() => this._put(snapshot));
  }

  remove(id) {
    return this._mutate(() => this._remove(id));
  }

  async list() {
    return listFromIndex(await this._readIndex());
  }

  async get(id) {
    const index = await this._readIndex();
    const meta = index.items.find((m) => m.id === id);
    if (!meta) return null;
    const bytes = await this._readBytes(id + '.f32');
    if (bytes === null) return null;                  // meta without audio: orphaned by a torn write
    const stored = new Uint8Array(bytes);
    const hasChannelCount = Object.prototype.hasOwnProperty.call(meta, 'channelCount');
    const hasPayload = Object.prototype.hasOwnProperty.call(meta, 'payload');
    if (hasChannelCount || hasPayload) {
      if (!hasChannelCount || !hasPayload || !positiveSafeInteger(meta.sampleRate)
          || !positiveSafeInteger(meta.channelCount) || !safeInteger(meta.frames)
          || !meta.payload || typeof meta.payload !== 'object'
          || meta.payload.byteLength !== meta.frames * meta.channelCount * 4
          || stored.byteLength !== meta.payload.byteLength) {
        throw new TypeError('CRATE payload byte length is invalid');
      }
      const { validateSamplePayload } = await import('./sample-payload.js');
      const verified = await validateSamplePayload(meta, stored);
      if (!verified.ok) throw new TypeError(`CRATE payload ${verified.issue} is invalid`);
      const sample = verified.sample.hydrate();
      return {
        meta: { ...normalizeMeta(meta), seconds: secondsOf(meta) },
        sample,
        pcm: sample.channelCount === 1 ? sample.channels[0].slice() : undefined,
      };
    }
    if (!positiveSafeInteger(meta.sampleRate) || !safeInteger(meta.frames)
        || stored.byteLength !== meta.frames * 4) {
      throw new TypeError('CRATE legacy payload byte length is invalid');
    }
    const channel = new Float32Array(meta.frames);
    const view = new DataView(stored.buffer, stored.byteOffset, stored.byteLength);
    for (let frame = 0; frame < meta.frames; frame++) {
      const value = view.getFloat32(frame * 4, true);
      if (!Number.isFinite(value)) throw new TypeError('CRATE legacy PCM is invalid');
      channel[frame] = value;
    }
    return {
      meta: { ...normalizeMeta(meta), seconds: secondsOf(meta) },
      sample: { sampleRate: meta.sampleRate, channelCount: 1, frames: meta.frames, channels: [channel] },
      pcm: channel.slice(),
    };
  }

  // ---------- queued mutations ----------

  async _put({ name, role, source, voice, provenance, sample }) {
    const index = await this._readIndex();
    const id = nextId(index);
    const { describeSamplePayload } = await import('./sample-payload.js');
    const described = await describeSamplePayload(sample);
    if (!described) throw new TypeError('CRATE sample is invalid');
    // PCM lands first: a crash between the two writes leaves an orphan file,
    // which costs bytes, where the reverse would leave a meta with no audio.
    await this._writeBytes(id + '.f32', described.bytes.slice());
    const meta = normalizeMeta({
      id,
      name,
      role,
      source,
      voice,
      sampleRate: sample.sampleRate,
      channelCount: sample.channelCount,
      frames: sample.frames,
      payload: { byteLength: described.byteLength, sha256: described.sha256 },
      ...(provenance === undefined ? {} : { provenance }),
      savedAt: Date.now(),
    });
    await this._writeJson(INDEX_NAME, addMeta(index, meta));
    return id;
  }

  async _remove(id) {
    const index = await this._readIndex();
    const next = removeMeta(index, id);
    if (next.items.length === index.items.length) return false;
    // Index first: the meta is what list() shows, so drop it before the audio.
    await this._writeJson(INDEX_NAME, next);
    await this._removeFile(id + '.f32');
    return true;
  }

  // ---------- files (flat names only: the crate is one directory deep) ----------

  async _readIndex() {
    const bytes = await this._readBytes(INDEX_NAME);
    if (bytes === null) return normalizeIndex(null);
    try {
      return normalizeIndex(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (e) {
      // A torn index must not brick the crate; the .f32 files become orphans.
      return normalizeIndex(null);
    }
  }

  async _writeBytes(name, arrayBuffer) {
    const handle = await this._dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(arrayBuffer);
    await writable.close();
  }

  async _readBytes(name) {
    try {
      const handle = await this._dir.getFileHandle(name);
      const file = await handle.getFile();
      return await file.arrayBuffer();
    } catch (e) {
      if (e && e.name === 'NotFoundError') return null;
      throw e;
    }
  }

  async _writeJson(name, obj) {
    await this._writeBytes(name, new TextEncoder().encode(JSON.stringify(obj)));
  }

  async _removeFile(name) {
    try {
      await this._dir.removeEntry(name);
    } catch (e) {
      if (e && e.name === 'NotFoundError') return;
      throw e;
    }
  }
}

function copyChannel(source, frames) {
  if (!(Array.isArray(source) || ArrayBuffer.isView(source)) || source.length !== frames) {
    throw new TypeError('CRATE channel is invalid');
  }
  const channel = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) channel[frame] = source[frame];
  return channel;
}

function snapshotSample(spec) {
  if (spec.sample && typeof spec.sample === 'object') {
    const sample = spec.sample;
    if (!positiveSafeInteger(sample.sampleRate) || !positiveSafeInteger(sample.channelCount)
        || !safeInteger(sample.frames) || !Array.isArray(sample.channels)
        || sample.channels.length !== sample.channelCount) throw new TypeError('CRATE sample is invalid');
    return {
      sampleRate: sample.sampleRate,
      channelCount: sample.channelCount,
      frames: sample.frames,
      channels: sample.channels.map((channel) => copyChannel(channel, sample.frames)),
    };
  }
  if (Array.isArray(spec.channels)) {
    const frames = spec.frames === undefined ? (spec.channels[0] ? spec.channels[0].length : 0) : spec.frames;
    if (!positiveSafeInteger(spec.sampleRate) || !positiveSafeInteger(spec.channelCount)
        || spec.channelCount !== spec.channels.length || !safeInteger(frames)) {
      throw new TypeError('CRATE sample is invalid');
    }
    return {
      sampleRate: spec.sampleRate,
      channelCount: spec.channelCount,
      frames,
      channels: spec.channels.map((channel) => copyChannel(channel, frames)),
    };
  }
  const rate = Number.isFinite(spec.sampleRate) && spec.sampleRate > 0 ? Math.floor(spec.sampleRate) : DEFAULT_RATE;
  const pcm = spec.pcm instanceof Float32Array ? spec.pcm : Float32Array.from(spec.pcm || []);
  return {
    sampleRate: rate,
    channelCount: 1,
    frames: pcm.length,
    channels: [pcm.slice()],
  };
}

function snapshotPutSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new TypeError('CRATE item is invalid');
  const voice = spec.voice === undefined || spec.voice === null ? null : jsonCopy(spec.voice);
  const provenance = spec.provenance === undefined ? undefined : jsonCopy(spec.provenance);
  if ((spec.voice !== undefined && spec.voice !== null && voice === null)
      || (spec.provenance !== undefined && provenance === null)) {
    throw new TypeError('CRATE metadata is not JSON-safe');
  }
  return {
    name: spec.name,
    role: spec.role,
    source: spec.source,
    voice,
    provenance,
    sample: snapshotSample(spec),
  };
}

function sourceClipSnapshot(provenance) {
  if (!provenance || provenance.kind !== 'source-clip') return null;
  if (provenance.binding === 'project') {
    return jsonCopy({
      sourceId: provenance.sourceId,
      clipId: provenance.clipId,
      sourceSpan: provenance.sourceSpan,
      extraction: provenance.extraction,
    });
  }
  if (provenance.binding === 'external' && provenance.descriptor
      && provenance.descriptor.sourceClip) return jsonCopy(provenance.descriptor.sourceClip);
  return null;
}

function externalizedProvenance(provenance) {
  const copy = jsonCopy(provenance);
  if (!copy || typeof copy !== 'object' || !Array.isArray(copy.transforms)) {
    throw new TypeError('CRATE provenance is invalid');
  }
  if (copy.binding === 'external') return copy;
  const snapshot = sourceClipSnapshot(copy);
  return {
    kind: copy.kind,
    binding: 'external',
    descriptor: snapshot ? { sourceClip: snapshot } : { storedProvenance: copy },
    transforms: jsonCopy(copy.transforms),
  };
}

export async function prepareCrateAsset(item, project, { relink = false } = {}) {
  if (!item || typeof item !== 'object') {
    throw new TypeError('CRATE preparation is invalid');
  }
  const itemMeta = item.meta;
  const itemSample = item.sample;
  if (!itemMeta || typeof itemMeta !== 'object' || Array.isArray(itemMeta) || !itemSample) {
    throw new TypeError('CRATE preparation is invalid');
  }
  // Detach the entire stored item before hashing yields; metadata and PCM must
  // always come from one synchronous caller snapshot.
  const metaSnapshot = jsonCopy(itemMeta);
  if (!metaSnapshot || typeof metaSnapshot !== 'object' || Array.isArray(metaSnapshot)) {
    throw new TypeError('CRATE preparation is invalid');
  }
  const sample = snapshotSample({ sample: itemSample });
  const { describeSamplePayload, validateAssetProvenance } = await import('./sample-payload.js');
  const described = await describeSamplePayload(sample);
  if (!described) throw new TypeError('CRATE PCM is invalid');
  const meta = {
    kind: 'sample',
    label: typeof metaSnapshot.name === 'string' ? metaSnapshot.name : 'INSTRUMENT',
    sampleRate: sample.sampleRate,
    channelCount: sample.channelCount,
    frames: sample.frames,
    payload: { byteLength: described.byteLength, sha256: described.sha256 },
  };
  if (typeof metaSnapshot.role === 'string') meta.role = metaSnapshot.role;
  if (metaSnapshot.provenance !== undefined) {
    const stored = metaSnapshot.provenance;
    const snapshot = sourceClipSnapshot(stored);
    let provenance = externalizedProvenance(stored);
    if (relink && snapshot) {
      const matches = Array.isArray(project && project.clips)
        ? project.clips.filter((clip) => clip && clip.id === snapshot.clipId) : [];
      const candidate = {
        kind: 'source-clip',
        binding: 'project',
        sourceId: snapshot.sourceId,
        clipId: snapshot.clipId,
        sourceSpan: jsonCopy(snapshot.sourceSpan),
        extraction: jsonCopy(snapshot.extraction),
        transforms: jsonCopy(stored.transforms),
      };
      if (matches.length === 1 && matches[0].sourceId === snapshot.sourceId
          && matches[0].start === snapshot.sourceSpan.start && matches[0].end === snapshot.sourceSpan.end
          && validateAssetProvenance(project, { ...meta, provenance: candidate }).ok) {
        provenance = candidate;
      }
    }
    if (!validateAssetProvenance(project || {}, { ...meta, provenance }).ok) {
      throw new TypeError('CRATE provenance is invalid');
    }
    meta.provenance = jsonCopy(provenance);
  }
  return { meta, sample, bytes: described.bytes.slice() };
}
