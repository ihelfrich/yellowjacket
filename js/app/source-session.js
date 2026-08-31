import { validateSourceGraph, validateSourceRecord } from './source-registry.js';

const NOOP = () => {};
const COMMIT_HOOKS = [
  'beforeInstall',
  'afterInstall',
  'beforeFacadeHydrate',
  'beforeRegistryPatch',
  'beforeActivateEvent',
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonCopy(value) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError('source state is not JSON-safe');
  return JSON.parse(text);
}

function replaceArray(target, values) {
  target.splice(0, target.length, ...jsonCopy(values));
}

function normalizedDocument(document) {
  return {
    words: document.words === null ? null : jsonCopy(document.words),
    transcript: { gapCuts: jsonCopy(document.transcript.gapCuts) },
    chain: jsonCopy(document.chain),
    repairs: jsonCopy(document.repairs),
    anchors: jsonCopy(document.anchors),
  };
}

function facadeDocument(project, runtime, record) {
  return {
    words: project.words === null ? null : jsonCopy(project.words),
    transcript: {
      gapCuts: jsonCopy(project.transcript && Array.isArray(project.transcript.gapCuts)
        ? project.transcript.gapCuts : []),
    },
    chain: jsonCopy(Array.isArray(project.chain) ? project.chain : []),
    repairs: jsonCopy(Array.isArray(runtime.repairs) ? runtime.repairs : []),
    anchors: jsonCopy(record.document.anchors),
  };
}

function compatibleEntry(entries, used, saved) {
  if (!isObject(saved) || typeof saved.id !== 'string') return null;
  for (const entry of entries) {
    if (!used.has(entry) && isObject(entry) && entry.id === saved.id) {
      used.add(entry);
      return entry;
    }
  }
  return null;
}

function replaceObject(target, source, retained = {}) {
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key];
  }
  for (const [key, value] of Object.entries(source)) {
    if (retained[key]) {
      target[key] = retained[key];
      replaceObject(retained[key], value);
    } else {
      target[key] = jsonCopy(value);
    }
  }
}

function hydrateRackEntry(entry, saved) {
  const params = isObject(entry.params) && isObject(saved.params) ? entry.params : null;
  replaceObject(entry, saved, params ? { params } : {});
}

function hydrateChain(project, savedChain) {
  if (!Array.isArray(project.chain)) project.chain = [];
  const held = project.chain.slice();
  const used = new Set();
  const next = savedChain.map((saved) => {
    const entry = compatibleEntry(held, used, saved);
    if (!entry) return jsonCopy(saved);
    hydrateRackEntry(entry, saved);
    return entry;
  });
  project.chain.splice(0, project.chain.length, ...next);
}

function hydrateFacade(project, runtime, record, document, prepared) {
  project.fileName = record.displayName;
  if (Array.isArray(document.words)) {
    if (Array.isArray(project.words)) replaceArray(project.words, document.words);
    else project.words = jsonCopy(document.words);
  } else {
    project.words = null;
  }

  if (!isObject(project.transcript)) project.transcript = { gapCuts: [] };
  if (!Array.isArray(project.transcript.gapCuts)) project.transcript.gapCuts = [];
  replaceArray(project.transcript.gapCuts, document.transcript.gapCuts);
  hydrateChain(project, document.chain);
  if (!Array.isArray(runtime.repairs)) runtime.repairs = [];
  replaceArray(runtime.repairs, document.repairs);

  runtime.buffer = prepared.decoded.buffer;
  runtime.mono = prepared.decoded.mono;
  runtime.sampleRate = prepared.decoded.buffer.sampleRate;
  runtime.renderedBuffer = null;
  runtime.analysis = null;
  runtime.peaks = prepared.peaks;
  runtime.generation++;
  runtime.original = null;
  runtime.sourceBytes = prepared.bytes;
  runtime.sourceHash = prepared.sourceId;
}

function captureFacade(project) {
  return {
    fileName: project.fileName,
    wordsRef: project.words,
    words: jsonCopy(project.words),
    transcriptRef: project.transcript,
    gapCutsRef: project.transcript && project.transcript.gapCuts,
    gapCuts: jsonCopy(project.transcript && Array.isArray(project.transcript.gapCuts)
      ? project.transcript.gapCuts : []),
    chainRef: project.chain,
    chain: Array.isArray(project.chain) ? project.chain.map((entry) => ({
      entryRef: entry,
      paramsRef: isObject(entry) ? entry.params : null,
      value: jsonCopy(entry),
    })) : [],
  };
}

function restoreFacade(project, checkpoint) {
  project.fileName = checkpoint.fileName;
  project.words = checkpoint.wordsRef;
  if (Array.isArray(checkpoint.wordsRef)) replaceArray(checkpoint.wordsRef, checkpoint.words);

  project.transcript = checkpoint.transcriptRef;
  if (isObject(checkpoint.transcriptRef)) {
    checkpoint.transcriptRef.gapCuts = checkpoint.gapCutsRef;
    if (Array.isArray(checkpoint.gapCutsRef)) replaceArray(checkpoint.gapCutsRef, checkpoint.gapCuts);
  }

  project.chain = checkpoint.chainRef;
  if (Array.isArray(checkpoint.chainRef)) {
    const entries = [];
    for (const saved of checkpoint.chain) {
      const retained = isObject(saved.entryRef) && isObject(saved.value)
        && isObject(saved.paramsRef) && isObject(saved.value.params)
        ? { params: saved.paramsRef } : {};
      if (isObject(saved.entryRef)) replaceObject(saved.entryRef, saved.value, retained);
      entries.push(saved.entryRef);
    }
    checkpoint.chainRef.splice(0, checkpoint.chainRef.length, ...entries);
  }
}

function captureRuntime(runtime) {
  return {
    keys: Object.keys(runtime),
    values: { ...runtime },
    repairsRef: runtime.repairs,
    repairs: jsonCopy(Array.isArray(runtime.repairs) ? runtime.repairs : []),
  };
}

function restoreRuntime(runtime, checkpoint) {
  const retainedKeys = new Set(checkpoint.keys);
  for (const key of Object.keys(runtime)) {
    if (!retainedKeys.has(key)) delete runtime[key];
  }
  for (const key of checkpoint.keys) runtime[key] = checkpoint.values[key];
  runtime.repairs = checkpoint.repairsRef;
  if (Array.isArray(checkpoint.repairsRef)) replaceArray(checkpoint.repairsRef, checkpoint.repairs);
}

function captureRegistry(project) {
  const entries = new Map();
  for (const [id, record] of Object.entries(project.sources)) {
    entries.set(id, {
      recordRef: record,
      keys: Object.keys(record),
      values: { ...record },
    });
  }
  return { sourcesRef: project.sources, entries };
}

function restoreRegistry(project, checkpoint) {
  project.sources = checkpoint.sourcesRef;
  for (const id of Object.keys(checkpoint.sourcesRef)) {
    if (!checkpoint.entries.has(id)) delete checkpoint.sourcesRef[id];
  }
  for (const [id, saved] of checkpoint.entries) {
    const record = saved.recordRef;
    for (const key of Object.keys(record)) {
      if (!saved.keys.includes(key)) delete record[key];
    }
    for (const key of saved.keys) record[key] = saved.values[key];
    checkpoint.sourcesRef[id] = record;
  }
}

function bufferDuration(buffer) {
  if (buffer && Number.isFinite(buffer.duration) && buffer.duration >= 0) return buffer.duration;
  if (buffer && Number.isFinite(buffer.length) && Number.isFinite(buffer.sampleRate) && buffer.sampleRate > 0) {
    return buffer.length / buffer.sampleRate;
  }
  return NaN;
}

function validateClipRefs(project, sourceId, decoded) {
  const duration = bufferDuration(decoded && decoded.buffer);
  if (!Number.isFinite(duration)) throw new TypeError('decoded source duration is invalid');
  for (const clip of Array.isArray(project.clips) ? project.clips : []) {
    if (!clip || clip.sourceId !== sourceId) continue;
    if (!Number.isFinite(clip.start) || !Number.isFinite(clip.end)
        || clip.start < 0 || clip.end <= clip.start || clip.end > duration) {
      throw new RangeError('target clip is outside decoded source duration');
    }
  }
}

function copyPayloadBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  throw new TypeError('source payload bytes are invalid');
}

async function sourceIdFor(bytes) {
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable');
  }
  const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
  return 'sha256:' + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isThenable(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function';
}

function callSynchronous(callback, name, argument) {
  const result = callback(argument);
  if (isThenable(result)) throw new TypeError(name + ' must be synchronous');
  return result;
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(name + ' must be a function');
  return value;
}

function eventCallback(listener) {
  if (typeof listener === 'function') return listener;
  if (listener && typeof listener.handleEvent === 'function') return (event) => listener.handleEvent(event);
  return null;
}

export class SourceSession {
  constructor({
    store,
    engine,
    payloads,
    buildPeaks,
    scheduleAfterActivation,
    clock = Date.now,
    stopTransport = NOOP,
    stopAudition = NOOP,
    hooks = {},
  } = {}) {
    if (!store || !store.project || !store.runtime || typeof store.update !== 'function') {
      throw new TypeError('SourceSession requires a ProjectStore');
    }
    if (!engine || typeof engine.decode !== 'function' || typeof engine.install !== 'function'
        || typeof engine.captureInstalled !== 'function' || typeof engine.restoreInstalled !== 'function') {
      throw new TypeError('SourceSession requires a transactional engine');
    }
    if (!payloads || typeof payloads.get !== 'function') {
      throw new TypeError('SourceSession requires a payload store');
    }
    this.store = store;
    this.engine = engine;
    this.payloads = payloads;
    this.buildPeaks = requireFunction(buildPeaks, 'buildPeaks');
    this.scheduleAfterActivation = requireFunction(scheduleAfterActivation, 'scheduleAfterActivation');
    this.clock = requireFunction(clock, 'clock');
    this.stopTransport = requireFunction(stopTransport, 'stopTransport');
    this.stopAudition = requireFunction(stopAudition, 'stopAudition');
    this.hooks = { afterPrepare: NOOP };
    for (const name of COMMIT_HOOKS) this.hooks[name] = NOOP;
    for (const [name, callback] of Object.entries(hooks || {})) {
      if (!(name in this.hooks)) throw new TypeError('Unknown SourceSession hook: ' + name);
      this.hooks[name] = requireFunction(callback, name);
    }
    this._requestToken = 0;
    this._staged = null;
    this._listeners = new Map();
  }

  addEventListener(type, listener, options = {}) {
    const callback = eventCallback(listener);
    if (!callback) return;
    let listeners = this._listeners.get(type);
    if (!listeners) {
      listeners = [];
      this._listeners.set(type, listeners);
    }
    if (listeners.some((entry) => entry.listener === listener)) return;
    listeners.push({ listener, callback, once: !!(options && options.once) });
  }

  removeEventListener(type, listener) {
    const listeners = this._listeners.get(type);
    if (!listeners) return;
    this._listeners.set(type, listeners.filter((entry) => entry.listener !== listener));
  }

  _emit(type, detail) {
    const event = { type, detail, target: this, currentTarget: this };
    for (const entry of [...(this._listeners.get(type) || [])]) {
      try {
        entry.callback(event);
      } catch (error) {
        // Rendering/listener work observes a coherent commit and cannot roll it back.
      }
      if (entry.once) this.removeEventListener(type, entry.listener);
    }
  }

  projectActiveFacade() {
    const { project, runtime } = this.store;
    const activeId = project.activeSourceId;
    const record = activeId && project.sources && project.sources[activeId];
    if (!record || !validateSourceRecord(record).ok) return null;
    const document = facadeDocument(project, runtime, record);
    if (!validateSourceRecord({ ...record, document }).ok) return null;
    record.document = document;
    return document;
  }

  _beginRequest() {
    this._requestToken++;
    this._staged = null;
    return this._requestToken;
  }

  _current(token) {
    return token === this._requestToken;
  }

  _capture(sourceId, token) {
    const { project, runtime } = this.store;
    const graph = validateSourceGraph(project);
    if (!graph.ok) throw new TypeError('source graph is invalid: ' + graph.issues.join(', '));
    const targetRecord = project.sources[sourceId];
    if (!targetRecord || !validateSourceRecord(targetRecord).ok) {
      throw new TypeError('target source record is invalid');
    }
    const activeRecord = project.sources[project.activeSourceId];
    const priorProjection = facadeDocument(project, runtime, activeRecord);
    if (!validateSourceRecord({ ...activeRecord, document: priorProjection }).ok) {
      throw new TypeError('active facade cannot form a valid source document');
    }
    const targetDocument = sourceId === project.activeSourceId
      ? jsonCopy(priorProjection) : normalizedDocument(targetRecord.document);
    return {
      token,
      sourceId,
      previousSourceId: project.activeSourceId,
      targetRecordRef: targetRecord,
      targetRecordFingerprint: JSON.stringify(targetRecord),
      activeRecordRef: activeRecord,
      sourcesRef: project.sources,
      facadeBasis: JSON.stringify(priorProjection),
      priorProjection,
      targetDocument,
      facade: captureFacade(project),
      runtime: captureRuntime(runtime),
      registry: captureRegistry(project),
      engine: this.engine.captureInstalled(),
      revision: this.store.revision,
      facadeEpoch: runtime.facadeEpoch,
    };
  }

  _basisIsCurrent(prepared) {
    const { project, runtime } = this.store;
    if (!this._current(prepared.token)
        || this.store.revision !== prepared.revision
        || project.activeSourceId !== prepared.previousSourceId
        || runtime.facadeEpoch !== prepared.facadeEpoch
        || project.sources !== prepared.sourcesRef
        || project.sources[prepared.previousSourceId] !== prepared.activeRecordRef
        || project.sources[prepared.sourceId] !== prepared.targetRecordRef) return false;
    try {
      if (JSON.stringify(project.sources[prepared.sourceId]) !== prepared.targetRecordFingerprint) return false;
      return JSON.stringify(facadeDocument(project, runtime, prepared.activeRecordRef)) === prepared.facadeBasis;
    } catch (error) {
      return false;
    }
  }

  async _prepareActivation(sourceId, token) {
    const prepared = this._capture(sourceId, token);
    try {
      const payload = await this.payloads.get(sourceId);
      if (!this._current(token)) return null;
      if (payload === null) throw new Error('source payload is unavailable');
      const bytes = copyPayloadBytes(payload);
      if (bytes.byteLength !== prepared.targetRecordRef.payload.byteLength) {
        throw new RangeError('source payload byte length does not match its record');
      }

      const actualId = await sourceIdFor(bytes);
      if (!this._current(token)) return null;
      if (actualId !== sourceId) throw new TypeError('source payload digest does not match its source ID');

      const decodeInput = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const decoded = await this.engine.decode(decodeInput);
      if (!this._current(token)) return null;
      validateClipRefs(this.store.project, sourceId, decoded);

      const peaks = await this.buildPeaks(decoded.mono);
      if (!this._current(token)) return null;
      Object.assign(prepared, { bytes, decoded, peaks });

      await this.hooks.afterPrepare(prepared);
      if (!this._current(token)) return null;
      if (!this._basisIsCurrent(prepared)) return null;
      this._staged = prepared;
      return prepared;
    } catch (error) {
      if (this._current(token)) this._staged = null;
      throw error;
    }
  }

  prepareActivation(sourceId) {
    const token = this._beginRequest();
    return this._prepareActivation(sourceId, token);
  }

  async activate(sourceId) {
    const token = this._beginRequest();
    const prepared = await this._prepareActivation(sourceId, token);
    if (!prepared || !this._current(token)) return false;
    return this.commitActivation(prepared);
  }

  commitActivation(prepared) {
    if (!prepared || prepared !== this._staged || !this._basisIsCurrent(prepared)) {
      if (prepared === this._staged) this._staged = null;
      return false;
    }

    let activatedAt;
    try {
      this.store.update('source-navigation', (project, runtime) => {
        if (!this._basisIsCurrent(prepared)) throw new Error('prepared activation became stale');
        callSynchronous(this.stopTransport, 'stopTransport', prepared);
        callSynchronous(this.stopAudition, 'stopAudition', prepared);
        callSynchronous(this.hooks.beforeInstall, 'beforeInstall', prepared);
        if (this.engine.install(prepared.decoded) !== true) throw new Error('source install failed');
        callSynchronous(this.hooks.afterInstall, 'afterInstall', prepared);
        callSynchronous(this.hooks.beforeFacadeHydrate, 'beforeFacadeHydrate', prepared);

        const targetRecord = project.sources[prepared.sourceId];
        hydrateFacade(project, runtime, targetRecord, prepared.targetDocument, prepared);
        callSynchronous(this.hooks.beforeRegistryPatch, 'beforeRegistryPatch', prepared);

        if (prepared.previousSourceId === prepared.sourceId) {
          targetRecord.document = prepared.priorProjection;
        } else {
          project.sources[prepared.previousSourceId].document = prepared.priorProjection;
          targetRecord.document = prepared.targetDocument;
        }
        project.activeSourceId = prepared.sourceId;
        runtime.facadeEpoch++;
        activatedAt = callSynchronous(this.clock, 'clock', prepared);
        callSynchronous(this.hooks.beforeActivateEvent, 'beforeActivateEvent', prepared);
      }, { history: 'none' });
    } catch (error) {
      const rollbackErrors = [];
      try {
        if (this.engine.restoreInstalled(prepared.engine) !== true) {
          rollbackErrors.push(new Error('engine restore failed'));
        }
      } catch (restoreError) {
        rollbackErrors.push(restoreError);
      }
      try { restoreFacade(this.store.project, prepared.facade); } catch (restoreError) { rollbackErrors.push(restoreError); }
      try { restoreRuntime(this.store.runtime, prepared.runtime); } catch (restoreError) { rollbackErrors.push(restoreError); }
      try { restoreRegistry(this.store.project, prepared.registry); } catch (restoreError) { rollbackErrors.push(restoreError); }
      this.store.project.activeSourceId = prepared.previousSourceId;
      this.store.runtime.facadeEpoch = prepared.facadeEpoch;
      this.store.revision = prepared.revision;
      this._staged = null;
      if (rollbackErrors.length) {
        throw new AggregateError([error, ...rollbackErrors], 'source activation rollback failed');
      }
      throw error;
    }

    this._staged = null;
    const detail = {
      sourceId: prepared.sourceId,
      previousSourceId: prepared.previousSourceId,
      facadeEpoch: this.store.runtime.facadeEpoch,
      revision: this.store.revision,
      activatedAt,
    };
    this._emit('sourceactivated', detail);
    try {
      this.scheduleAfterActivation(detail);
    } catch (error) {
      // Scheduling/rendering faults cannot fracture an already coherent commit.
    }
    return true;
  }
}
