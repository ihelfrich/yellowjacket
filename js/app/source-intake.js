import { VALIDATION_LIMITS } from './source-registry.js';

const AUDIO_EXTENSIONS = new Set([
  'aac', 'aif', 'aiff', 'alac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'wave', 'webm',
]);
const MIDI_EXTENSIONS = new Set(['mid', 'midi']);
const RIGHTS_BASES = new Set([
  'unknown', 'original-recording', 'public-domain', 'licensed', 'permission', 'fair-use-review',
]);
const UNKNOWN_RIGHTS = Object.freeze({
  basis: 'unknown',
  license: null,
  attribution: null,
  notes: null,
});

function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

function extensionOf(file) {
  const name = file && typeof file.name === 'string' ? file.name : '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function rightsCopy() {
  return { ...UNKNOWN_RIGHTS };
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function arrayIndex(key, length) {
  if (key === '') return null;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key
    ? index : null;
}

function canonicalPlainData(value, ancestors = new Set()) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'boolean' || type === 'string') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number');
    return value;
  }
  if (type !== 'object') throw new TypeError('unsupported plain-data value');
  if (ancestors.has(value)) throw new TypeError('cyclic plain data');

  const isArray = Array.isArray(value);
  if (!isArray) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('non-plain object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key === 'symbol')) throw new TypeError('symbol property');

  ancestors.add(value);
  try {
    if (isArray) {
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
          || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
        throw new TypeError('invalid array length');
      }
      const copy = new Array(lengthDescriptor.value);
      for (const key of keys) {
        if (key === 'length') continue;
        const index = arrayIndex(key, lengthDescriptor.value);
        const descriptor = descriptors[key];
        if (index === null || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          throw new TypeError('non-data array property');
        }
        copy[index] = canonicalPlainData(descriptor.value, ancestors);
      }
      return copy;
    }

    const copy = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new TypeError('accessor property');
      }
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: canonicalPlainData(descriptor.value, ancestors),
      });
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalizePlainData(value) {
  try {
    return { ok: true, value: canonicalPlainData(value) };
  } catch {
    return { ok: false };
  }
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

function observeResult(observer, authoritative) {
  let outcome;
  try {
    const snapshot = canonicalizePlainData(authoritative);
    if (!snapshot.ok) return;
    outcome = observer(deepFreeze(snapshot.value));
  } catch {
    return;
  }
  try {
    Promise.resolve(outcome).catch(() => {});
  } catch {
    // A hostile thenable cannot become a batch failure or an unhandled rejection.
  }
}

function nonPlainResultFailure() {
  return deepFreeze({
    kind: 'failed',
    status: 'FAILED',
    code: 'NON_PLAIN_RESULT',
    message: 'Source result must be JSON-safe plain data',
  });
}

function thrownRunFailure(item, error) {
  const itemSnapshot = canonicalizePlainData(item);
  let message;
  try {
    message = error && typeof error.message === 'string' ? error.message : String(error);
  } catch {
    message = 'Source transaction failed';
  }
  return {
    kind: 'failed',
    status: 'FAILED',
    ...(itemSnapshot.ok ? { item: itemSnapshot.value } : {}),
    message,
  };
}

function fileItem(file) {
  return {
    kind: 'file',
    file,
    displayName: typeof file.name === 'string' ? file.name : '',
    origin: { kind: 'file', url: null },
  };
}

function fileKind(file) {
  const extension = extensionOf(file);
  if (extension === 'yjkt') return 'project';
  if (MIDI_EXTENSIONS.has(extension)) return 'midi';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (file && typeof file.type === 'string' && file.type.toLowerCase().startsWith('audio/')) return 'audio';
  return 'document';
}

export function classifySelection(files) {
  const selected = files == null ? [] : Array.from(files);
  if (selected.length === 0) return { kind: 'rejected', code: 'EMPTY_SELECTION' };

  const kinds = selected.map(fileKind);
  const documents = kinds.filter((kind) => kind !== 'audio');
  if (documents.length > 0) {
    if (selected.length === 1 && documents[0] === 'project') {
      return { kind: 'project', file: selected[0] };
    }
    if (selected.length === 1 && documents[0] === 'midi') {
      return { kind: 'midi', file: selected[0] };
    }
    return {
      kind: 'rejected',
      code: documents.length > 1 ? 'MULTIPLE_DOCUMENT_SELECTION' : 'MIXED_DOCUMENT_SELECTION',
    };
  }

  return { kind: 'audio-batch', items: selected.map(fileItem) };
}

export function normalizeDirectUrls(text) {
  const items = [];
  const errors = [];
  const lines = String(text ?? '').split(/\r\n?|\n/);
  let nonblank = 0;

  for (let index = 0; index < lines.length; index++) {
    const value = lines[index].trim();
    if (!value) continue;
    nonblank++;
    if (utf8Bytes(value) > 4096) {
      errors.push({ line: index + 1, value, code: 'URL_TOO_LONG' });
      continue;
    }

    let url;
    try {
      url = new URL(value);
    } catch {
      errors.push({ line: index + 1, value, code: 'INVALID_URL' });
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.push({ line: index + 1, value, code: 'NON_HTTP_URL' });
      continue;
    }
    if (url.username || url.password) {
      errors.push({ line: index + 1, value, code: 'CREDENTIALS' });
      continue;
    }
    url.hash = '';
    const href = url.href;
    if (utf8Bytes(href) > 4096) {
      errors.push({ line: index + 1, value, code: 'URL_TOO_LONG' });
      continue;
    }
    items.push({
      kind: 'url',
      url: href,
      origin: { kind: 'url', url: href },
    });
  }

  if (nonblank === 0) errors.push({ line: null, value: '', code: 'EMPTY_URLS' });
  return { kind: 'url-batch', items, errors };
}

export async function processSourceBatch(items, {
  run,
  onResult = () => {},
  shouldCancel = () => false,
} = {}) {
  if (typeof run !== 'function') throw new TypeError('run must be a function');
  if (typeof onResult !== 'function') throw new TypeError('onResult must be a function');
  if (typeof shouldCancel !== 'function') throw new TypeError('shouldCancel must be a function');

  const results = [];
  let hasActivatedAddition = false;
  let cancelled = false;
  for (const item of Array.from(items || [])) {
    if (shouldCancel()) {
      cancelled = true;
      break;
    }
    let result;
    try {
      result = await run(item, {
        activation: hasActivatedAddition ? 'registry-only' : 'activate',
      });
    } catch (error) {
      result = thrownRunFailure(item, error);
    }
    const canonical = canonicalizePlainData(result);
    const authoritative = canonical.ok ? canonical.value : nonPlainResultFailure();
    results.push(authoritative);
    if (authoritative && authoritative.kind === 'added') hasActivatedAddition = true;
    observeResult(onResult, authoritative);
  }
  return { results, cancelled };
}

export function validateKnownPayloadAddition({ sourceBytes, knownProjectBytes } = {}) {
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0
      || !Number.isSafeInteger(knownProjectBytes) || knownProjectBytes < 0) {
    return { kind: 'unknown', code: 'UNKNOWN_PAYLOAD_SIZE' };
  }
  if (sourceBytes > VALIDATION_LIMITS.sourceBytes) {
    return { kind: 'failure', code: 'SOURCE_TOO_LARGE', sourceBytes };
  }
  const projectBytes = sourceBytes + knownProjectBytes;
  if (!Number.isSafeInteger(projectBytes) || projectBytes > VALIDATION_LIMITS.expandedBytes) {
    return { kind: 'failure', code: 'PROJECT_CAP', projectBytes };
  }
  return { kind: 'ok', sourceBytes, projectBytes };
}

export function adapterFailureGuidance(code) {
  const localFileMessage = 'Import a lawfully obtained local file instead.';
  if (code === 'WALLED_HOST' || code === 'HTML_RESPONSE' || code === 'CORS_BLOCKED') {
    return { code, message: localFileMessage };
  }
  if (code === 'HTTP_STATUS') return { code, message: 'The server did not return a successful response.' };
  if (code === 'SOURCE_TOO_LARGE') return { code, message: 'The source exceeds the per-source intake limit.' };
  if (code === 'PROJECT_CAP') return { code, message: 'The known project payload would exceed its limit.' };
  return { code: 'UNKNOWN_ADAPTER_FAILURE', message: 'The source could not be imported.' };
}

export function catalogIntakeMetadata(kind, catalog = {}) {
  if (kind !== 'demo' && kind !== 'field') throw new TypeError('catalog intake kind must be demo or field');
  const supplied = isPlainObject(catalog)
    && Object.prototype.hasOwnProperty.call(catalog, 'rights')
    && isPlainObject(catalog.rights) ? catalog.rights : null;
  const rights = rightsCopy();
  if (supplied && Object.prototype.hasOwnProperty.call(supplied, 'basis')
      && RIGHTS_BASES.has(supplied.basis)) rights.basis = supplied.basis;
  if (supplied && Object.prototype.hasOwnProperty.call(supplied, 'attribution')
      && typeof supplied.attribution === 'string') rights.attribution = supplied.attribution;
  return { origin: { kind, url: null }, rights };
}
