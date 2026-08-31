// Portable Yellowjacket projects. A .yjkt file is an ordinary ZIP archive
// using STORE entries so it can be written and read without a dependency,
// server, WASM codec, or build step. The archive is intentionally boring:
//
//   project.json          serializable document
//   source.bin            original encoded source, when the project has one
//   samples/<id>.f32      flat per-channel Float32 PCM, same as OPFS
//
// The ZIP reader is deliberately narrower than a general unzipper. It accepts
// STORE only, verifies every CRC, rejects path traversal and duplicate names,
// and caps both entry count and expanded bytes before callers touch project
// state. Exports from this module are pure and node-testable.

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const UTF8_FLAG = 0x0800;
const STORE = 0;
const MAX_ENTRIES = 1024;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 768 * 1024 * 1024;
const MAX_NAME_BYTES = 240;
const MAX_PROJECT_JSON_BYTES = 16 * 1024 * 1024;
const ZIP64_EXTRA_ID = 0x0001;
const ZIP64_U16 = 0xffff;
const ZIP64_U32 = 0xffffffff;
const V3_SAMPLE_ID = /^a([1-9][0-9]*)$/;
const SOURCE_ID = /^sha256:[0-9a-f]{64}$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;

let crcTable = null;

function table() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

export function crc32(input) {
  const bytes = bytesOf(input);
  const t = table();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = t[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return encoder.encode(value);
  throw new TypeError('bundle entry must be a string, ArrayBuffer, or typed array');
}

function safeName(name) {
  const s = String(name || '');
  if (!s || s.length > MAX_NAME_BYTES || s.includes('\0') || s.includes('\\')
    || s.startsWith('/') || s.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('unsafe project entry name: ' + JSON.stringify(s));
  }
  const encoded = encoder.encode(s);
  if (encoded.length > MAX_NAME_BYTES) throw new Error('project entry name is too long');
  return { text: s, bytes: encoded };
}

// Kept dependency-free because this transport module is part of the established
// preload graph. This is the same canonical mapping exposed by source-registry.
function sourceEntryName(sourceId) {
  return SOURCE_ID.test(sourceId) ? 'sources/' + sourceId.slice('sha256:'.length) + '.bin' : null;
}

function hasZip64Extra(view, start, length) {
  const end = start + length;
  let at = start;
  while (at < end) {
    if (at + 4 > end) throw new Error('project ZIP extra field is corrupt');
    const id = view.getUint16(at, true);
    const size = view.getUint16(at + 2, true);
    at += 4;
    if (at + size > end) throw new Error('project ZIP extra field is corrupt');
    if (id === ZIP64_EXTRA_ID) return true;
    at += size;
  }
  return false;
}

function exactMapEntries(value, label, copyValues = false) {
  try {
    mapSize.call(value); // Reject proxies before any caller-controlled property dispatch.
  } catch {
    throw new TypeError(label + ' must be an exact Map');
  }
  if (Object.getPrototypeOf(value) !== Map.prototype || Reflect.ownKeys(value).length !== 0) {
    throw new TypeError(label + ' must be an exact Map');
  }
  const out = [];
  try {
    Map.prototype.forEach.call(value, (entryValue, key) => {
      out.push([key, copyValues ? ownedBytes(entryValue, label) : entryValue]);
    });
  } catch {
    throw new TypeError(label + ' must be an exact Map');
  }
  return out;
}

function ownedBytes(value, label) {
  try {
    if (Object.getPrototypeOf(value) === Uint8Array.prototype) {
      return Uint8Array.prototype.slice.call(value);
    }
    if (Object.getPrototypeOf(value) === ArrayBuffer.prototype) {
      return new Uint8Array(ArrayBuffer.prototype.slice.call(value));
    }
  } catch {
    // Fall through to the stable boundary error below.
  }
  throw new TypeError(label + ' values must be exact byte arrays');
}

function exactStringArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(label + ' must be an Array');
  }
  const out = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') {
      throw new TypeError(label + ' must contain exact strings');
    }
    out.push(descriptor.value);
  }
  return out;
}

function reachableSampleIds(machine) {
  const ids = [];
  const seen = new Set();
  const scenes = machine && Array.isArray(machine.scenes) ? machine.scenes : [];
  for (const scene of scenes) {
    const tracks = scene && Array.isArray(scene.tracks) ? scene.tracks : [];
    for (const track of tracks) {
      const id = track && track.sampleId;
      if (typeof id === 'string' && id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

function compareCanonicalSampleIds(left, right) {
  return Number(V3_SAMPLE_ID.exec(left)[1]) - Number(V3_SAMPLE_ID.exec(right)[1]);
}

function sameOrderedStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function exactMapFromBytes(value, label) {
  return new Map(exactMapEntries(value, label, true));
}

function dosStamp(date = new Date()) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const time = ((date.getHours() & 31) << 11)
    | ((date.getMinutes() & 63) << 5)
    | ((Math.floor(date.getSeconds() / 2)) & 31);
  const day = ((year - 1980) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  return { time, day };
}

function u16(view, offset, value) { view.setUint16(offset, value, true); }
function u32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

export function buildBundle(entries, opts = {}) {
  const source = entries instanceof Map ? Array.from(entries) : Array.from(entries || []);
  if (!source.length) throw new Error('a project bundle needs at least one entry');
  if (source.length > MAX_ENTRIES) throw new Error('too many project entries');

  const seen = new Set();
  let total = 0;
  const normalized = source.map((entry) => {
    const pair = Array.isArray(entry) ? entry : [entry.name, entry.bytes];
    const name = safeName(pair[0]);
    if (seen.has(name.text)) throw new Error('duplicate project entry: ' + name.text);
    seen.add(name.text);
    const bytes = bytesOf(pair[1]);
    if (bytes.length > MAX_ENTRY_BYTES) throw new Error(name.text + ' is too large');
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('project bundle is too large');
    return { name: name.bytes, bytes, crc: crc32(bytes), offset: 0 };
  });

  const localSize = normalized.reduce((n, e) => n + 30 + e.name.length + e.bytes.length, 0);
  const centralSize = normalized.reduce((n, e) => n + 46 + e.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  const stamp = dosStamp(opts.date instanceof Date ? opts.date : new Date());
  let at = 0;

  for (const entry of normalized) {
    entry.offset = at;
    u32(view, at, SIG_LOCAL);
    u16(view, at + 4, 20);
    u16(view, at + 6, UTF8_FLAG);
    u16(view, at + 8, STORE);
    u16(view, at + 10, stamp.time);
    u16(view, at + 12, stamp.day);
    u32(view, at + 14, entry.crc);
    u32(view, at + 18, entry.bytes.length);
    u32(view, at + 22, entry.bytes.length);
    u16(view, at + 26, entry.name.length);
    u16(view, at + 28, 0);
    out.set(entry.name, at + 30);
    out.set(entry.bytes, at + 30 + entry.name.length);
    at += 30 + entry.name.length + entry.bytes.length;
  }

  const centralOffset = at;
  for (const entry of normalized) {
    u32(view, at, SIG_CENTRAL);
    u16(view, at + 4, 20);
    u16(view, at + 6, 20);
    u16(view, at + 8, UTF8_FLAG);
    u16(view, at + 10, STORE);
    u16(view, at + 12, stamp.time);
    u16(view, at + 14, stamp.day);
    u32(view, at + 16, entry.crc);
    u32(view, at + 20, entry.bytes.length);
    u32(view, at + 24, entry.bytes.length);
    u16(view, at + 28, entry.name.length);
    u16(view, at + 30, 0);
    u16(view, at + 32, 0);
    u16(view, at + 34, 0);
    u16(view, at + 36, 0);
    u32(view, at + 38, 0);
    u32(view, at + 42, entry.offset);
    out.set(entry.name, at + 46);
    at += 46 + entry.name.length;
  }

  u32(view, at, SIG_EOCD);
  u16(view, at + 4, 0);
  u16(view, at + 6, 0);
  u16(view, at + 8, normalized.length);
  u16(view, at + 10, normalized.length);
  u32(view, at + 12, centralSize);
  u32(view, at + 16, centralOffset);
  u16(view, at + 20, 0);
  return out;
}

function findEocd(view) {
  const min = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let at = view.byteLength - 22; at >= min; at--) {
    if (view.getUint32(at, true) === SIG_EOCD) return at;
  }
  return -1;
}

export function readBundle(input) {
  const bytes = bytesOf(input);
  if (bytes.length < 22) throw new Error('not a Yellowjacket project bundle');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error('project bundle has no ZIP directory');
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const diskCount = view.getUint16(eocd + 8, true);
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const comment = view.getUint16(eocd + 20, true);
  if (disk === ZIP64_U16 || centralDisk === ZIP64_U16 || diskCount === ZIP64_U16
      || count === ZIP64_U16 || centralSize === ZIP64_U32 || centralOffset === ZIP64_U32) {
    throw new Error('ZIP64 project bundles are not supported');
  }
  if (disk || centralDisk) throw new Error('split ZIP projects are not supported');
  if (diskCount !== count) throw new Error('project ZIP directory entry counts disagree');
  if (!count || count > MAX_ENTRIES) throw new Error('project entry count is invalid');
  if (eocd + 22 + comment > bytes.length || centralOffset + centralSize > eocd) {
    throw new Error('project ZIP directory is truncated');
  }

  const entries = new Map();
  let at = centralOffset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== SIG_CENTRAL) {
      throw new Error('project ZIP directory is corrupt');
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const expectedCrc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const end = at + 46 + nameLen + extraLen + commentLen;
    if (end > bytes.length) throw new Error('project ZIP name is truncated');
    if (compressed === ZIP64_U32 || size === ZIP64_U32 || localOffset === ZIP64_U32
        || hasZip64Extra(view, at + 46 + nameLen, extraLen)) {
      throw new Error('ZIP64 project entries are not supported');
    }
    if (method !== STORE || compressed !== size) throw new Error('compressed project entries are not supported');
    if (flags & ~UTF8_FLAG) throw new Error('project entry uses unsupported ZIP flags');
    if (size > MAX_ENTRY_BYTES) throw new Error('project entry is too large');
    total += size;
    if (total > MAX_TOTAL_BYTES) throw new Error('expanded project is too large');

    let name;
    try { name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen)); }
    catch (e) { throw new Error('project entry name is not valid UTF-8'); }
    safeName(name);
    if (entries.has(name)) throw new Error('duplicate project entry: ' + name);

    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== SIG_LOCAL) {
      throw new Error('project entry has no local header: ' + name);
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localCrc = view.getUint32(localOffset + 14, true);
    const localCompressed = view.getUint32(localOffset + 18, true);
    const localSize = view.getUint32(localOffset + 22, true);
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataAt = localOffset + 30 + localNameLen + localExtraLen;
    if (localCompressed === ZIP64_U32 || localSize === ZIP64_U32) {
      throw new Error('ZIP64 project entries are not supported');
    }
    if (dataAt > bytes.length) throw new Error('project local entry header is truncated: ' + name);
    if (hasZip64Extra(view, localOffset + 30 + localNameLen, localExtraLen)) {
      throw new Error('ZIP64 project entries are not supported');
    }
    if (dataAt + size > bytes.length) throw new Error('project entry is truncated: ' + name);
    let localName;
    try { localName = decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLen)); }
    catch (e) { throw new Error('project local entry name is not valid UTF-8'); }
    if (localName !== name || localFlags !== flags || localMethod !== method
      || localCrc !== expectedCrc || localCompressed !== compressed || localSize !== size) {
      throw new Error('project entry headers disagree: ' + name);
    }
    const data = bytes.slice(dataAt, dataAt + size);
    if (crc32(data) !== expectedCrc) throw new Error('project entry failed its checksum: ' + name);
    entries.set(name, data);
    at = end;
  }
  if (at !== centralOffset + centralSize) throw new Error('project ZIP directory size does not match');
  return entries;
}

export function projectEntries(serialized, sourceBytes = null) {
  if (!serialized || !serialized.json || !Array.isArray(serialized.sampleFiles)) {
    throw new TypeError('projectEntries needs serializeProject() output');
  }
  const entries = [['project.json', JSON.stringify(serialized.json)]];
  if (sourceBytes && sourceBytes.byteLength) entries.push(['source.bin', sourceBytes]);
  for (const file of serialized.sampleFiles) {
    if (!file || typeof file.id !== 'string') continue;
    entries.push(['samples/' + file.id + '.f32', file.bytes]);
  }
  return entries;
}

export function expectedProjectEntryNames(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('project.json must contain a project document');
  }
  if (json.formatVersion === 3) {
    if (!json.sources || Object.getPrototypeOf(json.sources) !== Object.prototype) {
      throw new Error('version 3 project sources are invalid');
    }
    const sourceNames = Object.keys(json.sources).map((id) => {
      const name = sourceEntryName(id);
      if (!name) throw new Error('version 3 project source ID is invalid');
      return name;
    }).sort();
    const sampleIds = reachableSampleIds(json.machine);
    for (const id of sampleIds) {
      const match = V3_SAMPLE_ID.exec(id);
      const suffix = match && Number(match[1]);
      if (!match || !Number.isSafeInteger(suffix)) {
        throw new Error('version 3 project sample ID is invalid: ' + String(id));
      }
    }
    sampleIds.sort(compareCanonicalSampleIds);
    return ['project.json', ...sourceNames, ...sampleIds.map((id) => 'samples/' + id + '.f32')];
  }
  if (json.formatVersion === 2) {
    const names = ['project.json'];
    if (json.sourceBytes !== null && json.sourceBytes !== undefined) names.push('source.bin');
    for (const id of reachableSampleIds(json.machine)) {
      if (typeof id !== 'string' || !id || id.includes('/') || id.includes('\\') || id.includes('\0')) {
        throw new Error('legacy project sample ID is invalid');
      }
      const name = 'samples/' + id + '.f32';
      safeName(name);
      names.push(name);
    }
    return names;
  }
  throw new Error('unsupported project formatVersion ' + String(json.formatVersion));
}

export function assertExactProjectEntrySet(entries, expectedNames) {
  const actual = exactMapEntries(entries, 'project entries').map(([name]) => name);
  const expected = exactStringArray(expectedNames, 'expected project entry names');
  const expectedSet = new Set(expected);
  if (expectedSet.size !== expected.length || actual.some((name) => typeof name !== 'string')
      || actual.length !== expected.length || actual.some((name) => !expectedSet.has(name))) {
    throw new Error('project archive entry set does not match project.json');
  }
  return true;
}

function exactSampleFileIndex(serialized, json, expectedSampleIds) {
  if (!Array.isArray(serialized.sampleFiles)
      || Object.getPrototypeOf(serialized.sampleFiles) !== Array.prototype
      || serialized.sampleFiles.length !== expectedSampleIds.length) {
    throw new TypeError('serialized sample index is invalid');
  }
  for (let index = 0; index < expectedSampleIds.length; index++) {
    const slot = Object.getOwnPropertyDescriptor(serialized.sampleFiles, String(index));
    const file = slot && Object.hasOwn(slot, 'value') ? slot.value : null;
    if (!file || Object.getPrototypeOf(file) !== Object.prototype) {
      throw new TypeError('serialized sample index is invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(file);
    const keys = Object.keys(descriptors).sort();
    if (!sameOrderedStrings(keys, ['byteLength', 'bytes', 'id', 'sha256'])
        || !Object.hasOwn(descriptors.id, 'value') || !Object.hasOwn(descriptors.byteLength, 'value')
        || !Object.hasOwn(descriptors.sha256, 'value')) {
      throw new TypeError('serialized sample metadata is invalid');
    }
    const id = descriptors.id.value;
    const meta = json.assets && json.assets[id];
    if (id !== expectedSampleIds[index] || !meta || !meta.payload
        || descriptors.byteLength.value !== meta.payload.byteLength
        || descriptors.sha256.value !== meta.payload.sha256) {
      throw new Error('serialized sample metadata does not match project assets');
    }
  }
}

export function projectEntriesV3(serialized, { sourcePayloads, samplePayloads } = {}) {
  // Copy all externally held bytes before inspecting the manifest. Subsequent
  // validation and archive construction operate only on these owned snapshots.
  const sources = exactMapFromBytes(sourcePayloads, 'sourcePayloads');
  const samples = exactMapFromBytes(samplePayloads, 'samplePayloads');
  if (!serialized || typeof serialized !== 'object' || Array.isArray(serialized)
      || !serialized.json || serialized.json.formatVersion !== 3) {
    throw new TypeError('projectEntriesV3 needs serializeProjectV3() output');
  }
  const expectedNames = expectedProjectEntryNames(serialized.json);
  const expectedSourceIds = Object.keys(serialized.json.sources).sort();
  const sourceIds = exactStringArray(serialized.sourceIds, 'serialized source IDs');
  if (!sameOrderedStrings(sourceIds, expectedSourceIds)) {
    throw new Error('serialized source index does not match project sources');
  }
  const expectedSampleIds = expectedNames.filter((name) => name.startsWith('samples/'))
    .map((name) => name.slice('samples/'.length, -'.f32'.length));
  exactSampleFileIndex(serialized, serialized.json, expectedSampleIds);

  const actualSourceIds = Array.from(Map.prototype.keys.call(sources));
  if (!actualSourceIds.every((id) => typeof id === 'string' && SOURCE_ID.test(id))) {
    throw new Error('source payload keys are invalid');
  }
  actualSourceIds.sort();
  const actualSampleIds = Array.from(Map.prototype.keys.call(samples));
  if (!actualSampleIds.every((id) => typeof id === 'string' && V3_SAMPLE_ID.test(id))) {
    throw new Error('sample payload keys are invalid');
  }
  actualSampleIds.sort(compareCanonicalSampleIds);
  if (!sameOrderedStrings(actualSourceIds, expectedSourceIds)) {
    throw new Error('source payload keys do not match project sources');
  }
  if (!sameOrderedStrings(actualSampleIds, expectedSampleIds)) {
    throw new Error('sample payload keys do not match project samples');
  }

  const entries = [['project.json', JSON.stringify(serialized.json)]];
  for (const id of expectedSourceIds) {
    entries.push([sourceEntryName(id), Map.prototype.get.call(sources, id)]);
  }
  for (const id of expectedSampleIds) {
    entries.push(['samples/' + id + '.f32', Map.prototype.get.call(samples, id)]);
  }
  return entries;
}

export function parseProjectEntries(entries) {
  const snapshot = exactMapFromBytes(entries, 'project entries');
  if (!Map.prototype.has.call(snapshot, 'project.json')) throw new Error('project.json is missing');
  const doc = Map.prototype.get.call(snapshot, 'project.json');
  if (doc.byteLength > MAX_PROJECT_JSON_BYTES) throw new Error('project.json exceeds the 16 MiB limit');
  let json;
  try { json = JSON.parse(decoder.decode(doc)); }
  catch (e) { throw new Error('project.json is not valid JSON'); }
  const expectedNames = expectedProjectEntryNames(json);
  assertExactProjectEntrySet(snapshot, expectedNames);
  if (json.formatVersion === 3) {
    const sourcePayloads = new Map();
    for (const id of Object.keys(json.sources).sort()) {
      sourcePayloads.set(id, Map.prototype.get.call(snapshot, sourceEntryName(id)));
    }
    const samplePayloads = new Map();
    for (const name of expectedNames) {
      const match = /^samples\/(a[1-9][0-9]*)\.f32$/.exec(name);
      if (match) samplePayloads.set(match[1], Map.prototype.get.call(snapshot, name));
    }
    return { json, sourcePayloads, samplePayloads };
  }
  const sourceEntry = Map.prototype.get.call(snapshot, 'source.bin') || null;
  const source = sourceEntry ? sourceEntry.buffer.slice(
    sourceEntry.byteOffset, sourceEntry.byteOffset + sourceEntry.byteLength,
  ) : null;
  const samples = new Map();
  for (const id of reachableSampleIds(json.machine)) {
    const value = Map.prototype.get.call(snapshot, 'samples/' + id + '.f32');
    samples.set(id, value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return { json, source, samples };
}

export function safeProjectName(fileName) {
  const cleaned = String(fileName || 'yellowjacket-project')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  const base = /[a-z0-9]/i.test(cleaned) ? cleaned : 'yellowjacket-project';
  return base + '.yjkt';
}
