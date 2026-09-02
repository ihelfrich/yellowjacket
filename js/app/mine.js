// MY SHELF: the visitor's own recordings, kept as the encoded file bytes in
// this browser's private origin storage (OPFS), next to the crate and the
// project store but in its own directory so neither DISCARD touches it.
// Nothing here is uploaded — there is no server — and the public SHELF stays
// public-domain only; anything a person owns the rights to use stays on the
// machine it was kept on. Layout mirrors crate.js: index.json {maxId, items}
// rewritten on every mutation, plus one <id>.bin holding the file exactly as
// it was loaded, so KEEP → OPEN is byte-identical (same SHA, same lineage).
// The index math is pure and node-tested; only MineStore touches OPFS.

export const MINE_DIR = 'yellowjacket-mine-v1';
const INDEX_NAME = 'index.json';

// ---------- pure index math ----------

function idNumber(id) {
  if (typeof id !== 'string' || id[0] !== 'm') return 0;
  const n = Number(id.slice(1));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function positive(n, fallback = 0) {
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function normalizeMineMeta(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  return {
    ...m,
    id: m.id,
    name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : 'RECORDING',
    bytes: Math.floor(positive(m.bytes)),
    hash: typeof m.hash === 'string' && m.hash ? m.hash : null,
    seconds: positive(m.seconds),
    rate: Math.floor(positive(m.rate)),
    channels: Math.floor(positive(m.channels)),
    addedAt: Number.isFinite(m.addedAt) ? m.addedAt : 0,
  };
}

// Anything read off disk is untrusted: drop malformed metas, and lift maxId
// past every id present so a hand-edited index cannot mint a duplicate.
export function normalizeMineIndex(index) {
  const src = index && typeof index === 'object' ? index : {};
  const raw = Array.isArray(src.items) ? src.items : [];
  const items = [];
  const seen = new Set();
  let maxId = Math.floor(positive(src.maxId));
  for (const meta of raw) {
    if (!meta || typeof meta !== 'object') continue;
    const n = idNumber(meta.id);
    if (!n || seen.has(meta.id)) continue;
    const norm = normalizeMineMeta(meta);
    if (!norm.bytes) continue;                   // a zero-byte keep is not a recording
    seen.add(meta.id);
    items.push(norm);
    if (n > maxId) maxId = n;
  }
  return { maxId, items };
}

export function nextMineId(index) {
  return 'm' + (normalizeMineIndex(index).maxId + 1);
}

export function addMine(index, meta) {
  const norm = normalizeMineIndex(index);
  const item = normalizeMineMeta(meta);
  const n = idNumber(item.id);
  if (!n || !item.bytes) throw new Error('addMine: meta needs an id and a byte count');
  const items = norm.items.filter((m) => m.id !== item.id);
  items.push(item);
  return { maxId: Math.max(norm.maxId, n), items };
}

export function removeMine(index, id) {
  const norm = normalizeMineIndex(index);
  return { maxId: norm.maxId, items: norm.items.filter((m) => m.id !== id) };
}

export function findMineByHash(index, hash) {
  if (!hash) return null;
  return normalizeMineIndex(index).items.find((m) => m.hash === hash) || null;
}

// Newest first: the thing you just kept is the thing you want next.
export function listMine(index) {
  return normalizeMineIndex(index).items
    .slice()
    .sort((a, b) => b.addedAt - a.addedAt || idNumber(b.id) - idNumber(a.id));
}

export function mineTotalBytes(index) {
  return normalizeMineIndex(index).items.reduce((sum, m) => sum + m.bytes, 0);
}

export function formatMineMeta(meta) {
  const m = normalizeMineMeta(meta);
  const s = Math.round(m.seconds);
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  const mb = m.bytes >= 1024 * 1024
    ? (m.bytes / (1024 * 1024)).toFixed(1) + ' MB'
    : Math.max(1, Math.round(m.bytes / 1024)) + ' KB';
  const rate = m.rate ? (m.rate % 1000 === 0 ? m.rate / 1000 + 'k' : (m.rate / 1000).toFixed(1) + 'k') : '';
  return [mm + ':' + ss, mb, rate].filter(Boolean).join(' · ');
}

// ---------- OPFS adapter ----------

export class MineStore {
  constructor(root, dir) {
    this._root = root;
    this._dir = dir;
    this._chain = Promise.resolve();
  }

  // null wherever the main-thread write path is missing (Safari before
  // createWritable): "no private shelf on this browser", never an error.
  static async open() {
    try {
      if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory) return null;
      if (typeof FileSystemFileHandle === 'undefined'
        || typeof FileSystemFileHandle.prototype.createWritable !== 'function') return null;
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(MINE_DIR, { create: true });
      return new MineStore(root, dir);
    } catch (e) {
      return null;
    }
  }

  // Mutations queue on one index file (see crate.js for why); reads do not.
  _mutate(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  put(spec) { return this._mutate(() => this._put(spec || {})); }
  remove(id) { return this._mutate(() => this._remove(id)); }

  async list() { return listMine(await this._readIndex()); }

  async get(id) {
    const index = await this._readIndex();
    const meta = index.items.find((m) => m.id === id);
    if (!meta) return null;
    const bytes = await this._readBytes(id + '.bin');
    if (bytes === null) return null;                 // orphaned meta from a torn write
    return { meta, bytes };
  }

  async estimate() {
    try {
      if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.estimate) return null;
      const e = await navigator.storage.estimate();
      return { usage: e.usage || 0, quota: e.quota || 0 };
    } catch (e) {
      return null;
    }
  }

  // Returns {id, duplicate}. The same bytes (by SHA) are never kept twice.
  async _put({ name, bytes, hash, seconds, rate, channels }) {
    const index = await this._readIndex();
    const dup = findMineByHash(index, hash);
    if (dup) return { id: dup.id, duplicate: true };
    if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength) throw new Error('MineStore.put: bytes required');
    const id = nextMineId(index);
    // Bytes land first: a crash between the writes leaves an orphan file,
    // which costs storage, where the reverse would leave a card that cannot open.
    await this._writeBytes(id + '.bin', bytes);
    const meta = normalizeMineMeta({ id, name, bytes: bytes.byteLength, hash, seconds, rate, channels, addedAt: Date.now() });
    await this._writeJson(INDEX_NAME, addMine(index, meta));
    return { id, duplicate: false };
  }

  async _remove(id) {
    const index = await this._readIndex();
    const next = removeMine(index, id);
    if (next.items.length === index.items.length) return false;
    await this._writeJson(INDEX_NAME, next);     // index first: the card goes before the bytes
    await this._removeFile(id + '.bin');
    return true;
  }

  async _readIndex() {
    const bytes = await this._readBytes(INDEX_NAME);
    if (bytes === null) return normalizeMineIndex(null);
    try {
      return normalizeMineIndex(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (e) {
      return normalizeMineIndex(null);            // a torn index must not brick the shelf
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
      if (!e || e.name !== 'NotFoundError') throw e;
    }
  }
}
