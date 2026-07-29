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
  // Unknown keys ride through (forward tolerance, as in persist.js clone).
  return {
    ...meta,
    id: meta.id,
    name: typeof meta.name === 'string' && meta.name ? meta.name : 'INSTRUMENT',
    role: typeof meta.role === 'string' && meta.role ? meta.role : DASH,
    source: typeof meta.source === 'string' && meta.source ? meta.source : DASH,
    sampleRate: Number.isFinite(meta.sampleRate) && meta.sampleRate > 0 ? meta.sampleRate : DEFAULT_RATE,
    frames: Number.isFinite(meta.frames) && meta.frames > 0 ? Math.floor(meta.frames) : 0,
    savedAt: Number.isFinite(meta.savedAt) ? meta.savedAt : 0,
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
    return this._mutate(() => this._put(spec || {}));
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
    return { meta: { ...meta, seconds: secondsOf(meta) }, pcm: new Float32Array(bytes) };
  }

  // ---------- queued mutations ----------

  async _put({ name, role, source, voice, sampleRate, pcm }) {
    const index = await this._readIndex();
    const id = nextId(index);
    const data = pcm instanceof Float32Array ? pcm : Float32Array.from(pcm || []);
    // A subarray view shares a larger buffer: copy so the file is only the PCM.
    const bytes = (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength)
      ? data.buffer
      : data.slice().buffer;
    // PCM lands first: a crash between the two writes leaves an orphan file,
    // which costs bytes, where the reverse would leave a meta with no audio.
    await this._writeBytes(id + '.f32', bytes);
    const meta = normalizeMeta({
      id,
      name,
      role,
      source,
      // voice is flat scalars (project-store createVoice), so this is a real copy.
      voice: voice && typeof voice === 'object' ? { ...voice } : null,
      sampleRate,
      frames: data.length,
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
