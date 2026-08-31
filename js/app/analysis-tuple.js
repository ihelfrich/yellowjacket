import { SOURCE_ID_RE } from './source-registry.js';

export const ANALYSIS_DESCRIPTOR_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const NO_ANALYSIS_TUPLE = Object.freeze({ kind: 'legacy' });
export const INVALID_ANALYSIS_TUPLE = Object.freeze({ kind: 'invalid', issue: 'analysis tuple' });
const INVALID_SOURCE_ID = Object.freeze({ kind: 'invalid', issue: 'sourceId' });
const INVALID_JOB_ID = Object.freeze({ kind: 'invalid', issue: 'jobId' });
const INVALID_ALGORITHM_VERSION = Object.freeze({ kind: 'invalid', issue: 'algorithmVersion' });
const TUPLE_SNAPSHOTS = new WeakSet();

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function snapshotAnalysisTuple(value) {
  if (!isObject(value)) return INVALID_ANALYSIS_TUPLE;
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return INVALID_ANALYSIS_TUPLE;
  }
  const fields = ['sourceId', 'jobId', 'algorithmVersion'];
  const present = fields.filter((field) => Object.prototype.hasOwnProperty.call(descriptors, field));
  if (present.length === 0) return NO_ANALYSIS_TUPLE;
  if (present.length !== fields.length) return INVALID_ANALYSIS_TUPLE;
  if (!Object.prototype.hasOwnProperty.call(descriptors.sourceId, 'value')) return INVALID_SOURCE_ID;
  if (!Object.prototype.hasOwnProperty.call(descriptors.jobId, 'value')) return INVALID_JOB_ID;
  if (!Object.prototype.hasOwnProperty.call(descriptors.algorithmVersion, 'value')) {
    return INVALID_ALGORITHM_VERSION;
  }

  const sourceId = descriptors.sourceId.value;
  const jobId = descriptors.jobId.value;
  const algorithmVersion = descriptors.algorithmVersion.value;
  if (typeof sourceId !== 'string' || !SOURCE_ID_RE.test(sourceId)) return INVALID_SOURCE_ID;
  if (typeof jobId !== 'string' || !ANALYSIS_DESCRIPTOR_RE.test(jobId)) return INVALID_JOB_ID;
  if (typeof algorithmVersion !== 'string' || !ANALYSIS_DESCRIPTOR_RE.test(algorithmVersion)) {
    return INVALID_ALGORITHM_VERSION;
  }
  const snapshot = Object.freeze({ sourceId, jobId, algorithmVersion });
  TUPLE_SNAPSHOTS.add(snapshot);
  return snapshot;
}

export function isAnalysisTupleSnapshot(value) {
  return isObject(value) && TUPLE_SNAPSHOTS.has(value);
}

export function requireAnalysisTupleSnapshot(value) {
  const snapshot = snapshotAnalysisTuple(value);
  if (!isAnalysisTupleSnapshot(snapshot)) throw new TypeError((snapshot.issue || 'analysis tuple') + ' is invalid');
  return snapshot;
}

export function analysisTupleCacheKey(snapshot) {
  if (!isAnalysisTupleSnapshot(snapshot)) throw new TypeError('analysis tuple snapshot is invalid');
  return snapshot.sourceId + ':' + snapshot.algorithmVersion;
}
