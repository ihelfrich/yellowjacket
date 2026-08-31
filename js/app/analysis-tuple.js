import { SOURCE_ID_RE } from './source-registry.js';

export const ANALYSIS_DESCRIPTOR_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return isObject(value) && Object.prototype.hasOwnProperty.call(value, key);
}

export function hasOwnAnalysisTupleField(value) {
  return ['sourceId', 'jobId', 'algorithmVersion'].some((key) => hasOwn(value, key));
}

export function analysisTupleIssue(value) {
  if (!hasOwn(value, 'sourceId') || typeof value.sourceId !== 'string'
      || !SOURCE_ID_RE.test(value.sourceId)) return 'sourceId';
  if (!hasOwn(value, 'jobId') || typeof value.jobId !== 'string'
      || !ANALYSIS_DESCRIPTOR_RE.test(value.jobId)) return 'jobId';
  if (!hasOwn(value, 'algorithmVersion') || typeof value.algorithmVersion !== 'string'
      || !ANALYSIS_DESCRIPTOR_RE.test(value.algorithmVersion)) return 'algorithmVersion';
  return null;
}

export function isAnalysisTuple(value) {
  return analysisTupleIssue(value) === null;
}

export function requireAnalysisTuple(value) {
  const issue = analysisTupleIssue(value);
  if (issue) throw new TypeError(issue + ' is invalid');
  return {
    sourceId: value.sourceId,
    jobId: value.jobId,
    algorithmVersion: value.algorithmVersion,
  };
}

export function analysisTupleCacheKey(value) {
  const tuple = requireAnalysisTuple(value);
  return tuple.sourceId + ':' + tuple.algorithmVersion;
}
