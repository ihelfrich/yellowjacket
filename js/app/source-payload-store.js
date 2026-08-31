// Immutable, content-addressed encoded-source payload ownership. Storage bytes
// are always copied at the module boundary: callers never retain a mutable view
// of the repository's source of truth.

import { SOURCE_ID_RE, sourceEntryName } from './source-registry.js';

export class PayloadCorruptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PayloadCorruptionError';
  }
}

function requireSourceId(sourceId) {
  if (!SOURCE_ID_RE.test(sourceId)) throw new TypeError('invalid source ID');
  return sourceId;
}

function copyBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  throw new TypeError('payload bytes must be an ArrayBuffer or view');
}

function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function sourceIdFor(bytes) {
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return 'sha256:' + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function verifiedIngress(sourceId, value) {
  requireSourceId(sourceId);
  const bytes = copyBytes(value);
  if (await sourceIdFor(bytes) !== sourceId) {
    throw new TypeError('source ID does not match payload bytes');
  }
  return bytes;
}

async function verifiedStored(sourceId, value) {
  const bytes = copyBytes(value);
  if (await sourceIdFor(bytes) !== sourceId) {
    throw new PayloadCorruptionError('payload digest does not match durable source ID');
  }
  return bytes;
}

function corruptionForDifference(sourceId) {
  return new PayloadCorruptionError('payload at ' + sourceEntryName(sourceId) + ' differs from immutable source bytes');
}

export class MemorySourcePayloadStore {
  constructor() {
    this._entries = new Map();
  }

  async put(sourceId, value) {
    const bytes = await verifiedIngress(sourceId, value);
    const existing = this._entries.get(sourceId);
    if (existing) {
      if (!sameBytes(existing, bytes)) throw corruptionForDifference(sourceId);
      return { reused: true };
    }
    this._entries.set(sourceId, bytes);
    return { reused: false };
  }

  async get(sourceId) {
    requireSourceId(sourceId);
    const bytes = this._entries.get(sourceId);
    if (!bytes) return null;
    await verifiedStored(sourceId, bytes);
    return bytes.slice();
  }

  async has(sourceId) {
    return (await this.get(sourceId)) !== null;
  }

  async remove(sourceId) {
    requireSourceId(sourceId);
    return this._entries.delete(sourceId);
  }

  async listIds() {
    const ids = [...this._entries.keys()].sort();
    for (const sourceId of ids) await this.get(sourceId);
    return ids;
  }
}

export class OpfsSourcePayloadStore {
  constructor(opfsStore) {
    if (!opfsStore || typeof opfsStore.readBytes !== 'function' || typeof opfsStore.writeBytes !== 'function') {
      throw new TypeError('OpfsSourcePayloadStore requires an OpfsStore-like backend');
    }
    this._opfs = opfsStore;
    this._ids = new Set();
  }

  _name(sourceId) {
    requireSourceId(sourceId);
    // Keep path derivation centralized in the source registry validation boundary.
    return sourceEntryName(sourceId);
  }

  async put(sourceId, value) {
    const bytes = await verifiedIngress(sourceId, value);
    const name = this._name(sourceId);
    const existing = await this._opfs.readBytes(name);
    if (existing !== null) {
      const stored = await verifiedStored(sourceId, existing);
      if (!sameBytes(stored, bytes)) throw corruptionForDifference(sourceId);
      this._ids.add(sourceId);
      return { reused: true };
    }

    await this._opfs.writeBytes(name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const written = await this._opfs.readBytes(name);
    if (written === null) throw new PayloadCorruptionError('durable payload disappeared after write');
    const stored = await verifiedStored(sourceId, written);
    if (!sameBytes(stored, bytes)) throw corruptionForDifference(sourceId);
    this._ids.add(sourceId);
    return { reused: false };
  }

  async get(sourceId) {
    const name = this._name(sourceId);
    const value = await this._opfs.readBytes(name);
    if (value === null) return null;
    const bytes = await verifiedStored(sourceId, value);
    this._ids.add(sourceId);
    return bytes.slice();
  }

  async has(sourceId) {
    return (await this.get(sourceId)) !== null;
  }

  async remove(sourceId) {
    const name = this._name(sourceId);
    await this._opfs.remove(name);
    this._ids.delete(sourceId);
    return true;
  }

  async listIds() {
    const ids = [...this._ids].sort();
    const present = [];
    for (const sourceId of ids) {
      if (await this.get(sourceId)) present.push(sourceId);
    }
    return present;
  }
}

export class SourcePayloadRepository {
  constructor(memory = new MemorySourcePayloadStore()) {
    this.memory = memory;
    this._durable = null;
    this._durableIds = new Set();
    this._persistent = false;
  }

  get persistent() {
    return this._persistent;
  }

  async attachDurable(durable) {
    if (!durable || typeof durable.put !== 'function' || typeof durable.get !== 'function') {
      throw new TypeError('durable payload store must implement put() and get()');
    }
    const verified = new Set();
    let ids = [];
    try {
      // A retry after one quota-limited import must not forget payloads that
      // were verified before the failure. Stage those durable-only bytes back
      // into owned memory before asking a backend to prove the complete set.
      if (this._durable) {
        for (const sourceId of this._durableIds) {
          if (await this.memory.has(sourceId)) continue;
          const bytes = await this._durable.get(sourceId);
          if (bytes === null) throw new PayloadCorruptionError('verified durable payload disappeared');
          await this.memory.put(sourceId, bytes);
        }
      }
      ids = await this.memory.listIds();
      for (const sourceId of ids) {
        const bytes = await this.memory.get(sourceId);
        if (bytes === null) throw new PayloadCorruptionError('memory payload disappeared during durable attachment');
        await durable.put(sourceId, bytes);
        const readBack = await durable.get(sourceId);
        if (readBack === null) throw new PayloadCorruptionError('durable payload disappeared during attachment');
        const durableBytes = await verifiedStored(sourceId, readBack);
        if (!sameBytes(bytes, durableBytes)) throw corruptionForDifference(sourceId);
        verified.add(sourceId);
      }
    } catch (error) {
      this._persistent = false;
      if (error instanceof PayloadCorruptionError) throw error;
      return { persistent: false, sessionOnly: true };
    }

    this._durable = durable;
    this._durableIds = verified;
    for (const sourceId of ids) await this.memory.remove(sourceId);
    this._persistent = true;
    return { persistent: true };
  }

  async put(sourceId, value) {
    const bytes = await verifiedIngress(sourceId, value);
    const memoryResult = await this.memory.put(sourceId, bytes);
    if (!this._durable) return memoryResult;

    try {
      await this._durable.put(sourceId, bytes);
      const readBack = await this._durable.get(sourceId);
      if (readBack === null) throw new PayloadCorruptionError('durable payload disappeared after write');
      const durableBytes = await verifiedStored(sourceId, readBack);
      if (!sameBytes(bytes, durableBytes)) throw corruptionForDifference(sourceId);
      this._durableIds.add(sourceId);
    } catch (error) {
      this._persistent = false;
      if (error instanceof PayloadCorruptionError) throw error;
      return { ...memoryResult, sessionOnly: true };
    }

    if (!this._persistent) return { ...memoryResult, sessionOnly: true };
    await this.memory.remove(sourceId);
    return memoryResult;
  }

  async get(sourceId) {
    requireSourceId(sourceId);
    if (this._durable && this._durableIds.has(sourceId)) {
      try {
        const bytes = await this._durable.get(sourceId);
        if (bytes !== null) return copyBytes(bytes);
      } catch (error) {
        if (error instanceof PayloadCorruptionError) throw error;
      }
    }
    return this.memory.get(sourceId);
  }

  async has(sourceId) {
    return (await this.get(sourceId)) !== null;
  }

  async remove(sourceId) {
    requireSourceId(sourceId);
    let durableRemoved = false;
    if (this._durable && this._durableIds.has(sourceId)) {
      await this._durable.remove(sourceId);
      this._durableIds.delete(sourceId);
      durableRemoved = true;
    }
    const removed = await this.memory.remove(sourceId);
    if (this._durable) this._persistent = (await this.memory.listIds()).length === 0;
    return removed || durableRemoved;
  }

  async listIds() {
    const candidates = new Set(await this.memory.listIds());
    for (const sourceId of this._durableIds) candidates.add(sourceId);
    const ids = [...candidates].sort();
    const present = [];
    for (const sourceId of ids) {
      if (await this.get(sourceId) !== null) present.push(sourceId);
    }
    return present;
  }
}
