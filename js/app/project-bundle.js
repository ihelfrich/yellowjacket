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

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

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
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const comment = view.getUint16(eocd + 20, true);
  if (disk || centralDisk) throw new Error('split ZIP projects are not supported');
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

export function parseProjectEntries(entries) {
  if (!(entries instanceof Map)) throw new TypeError('parseProjectEntries needs a Map');
  const doc = entries.get('project.json');
  if (!doc) throw new Error('project.json is missing');
  let json;
  try { json = JSON.parse(decoder.decode(doc)); }
  catch (e) { throw new Error('project.json is not valid JSON'); }
  const sourceEntry = entries.get('source.bin') || null;
  const source = sourceEntry
    ? sourceEntry.buffer.slice(sourceEntry.byteOffset, sourceEntry.byteOffset + sourceEntry.byteLength)
    : null;
  const samples = new Map();
  for (const [name, value] of entries) {
    const match = /^samples\/([^/]+)\.f32$/.exec(name);
    if (match) samples.set(match[1],
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
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
