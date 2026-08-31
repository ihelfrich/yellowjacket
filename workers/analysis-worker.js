// Yellowjacket — source analysis worker (module). Runs onset/envelope extraction
// and beat tracking off the main thread. The onset envelope is cached by the
// future source/algorithm key, with the singular generation cache retained for
// the live controller through Task 11.
//
// Protocol:
//   in:  { type:'analyze', mono: Float32Array (transfer; may be omitted on anchor
//          re-runs for a cached generation), sampleRate,
//          anchors: { bpm: number|null, barOneTime: number|null },
//          generation: string|number, job: number }
//   future in/out metadata: { sourceId, jobId, algorithmVersion }
//   out: { type:'progress', job, pct }   // at least 5 / 50 / 90 / 100
//   out: { type:'done', job, analysis }  // full project.analysis shape minus anchors
//   out: { type:'error', job, message }  // no cached envelope and no mono
//
// Every reply echoes supplied request metadata. Legacy `job`/`generation`
// remain accepted while future requests use the source-scoped tuple.

import { onsetAnalysis } from '../js/analysis/onsets.js';
import { trackBeats } from '../js/analysis/beattrack.js';
import {
  analysisTupleCacheKey,
  isAnalysisTupleSnapshot,
  NO_ANALYSIS_TUPLE,
  snapshotAnalysisTuple,
} from '../js/app/analysis-tuple.js';

const MIN_SAMPLES = 2048;   // below this there is no meaningful STFT frame to analyze
const ENVELOPE_HOP = 512;   // per contract: envelope hopSize 512 @ analysis rate
const BEATS_PER_BAR = 4;    // fixed this slice

// The live singular controller keeps its generation cache through Task 11.
// Future requests are isolated by source and algorithm so neither can hit this
// legacy slot or another source/version entry.
let legacyCache = null; // { generation, envelope, envelopeRate, onsets }
let tupleCache = null; // { key, envelope, envelopeRate, onsets }

self.onmessage = (e) => {
  const msg = e.data;
  const type = ownDataField(msg, 'type');
  if (!type.present || type.value !== 'analyze') return;

  const tuple = snapshotAnalysisTuple(msg);
  const reply = replyMetadata(msg, tuple);

  try {
    if (tuple !== NO_ANALYSIS_TUPLE && !isAnalysisTupleSnapshot(tuple)) {
      throw new TypeError('Analysis tuple is invalid');
    }
    const generationField = ownDataField(msg, 'generation');
    const generation = generationField.present ? generationField.value : null;
    const anchorsField = ownDataField(msg, 'anchors');
    const anchors = normalizeAnchors(anchorsField.present ? anchorsField.value : null);
    const monoField = ownDataField(msg, 'mono');
    const mono = monoField.present ? monoField.value : null;
    const hasMono = mono instanceof Float32Array;
    postProgress(reply, 5);

    let envelope;
    let envelopeRate;
    let onsets;

    const tupleKey = isAnalysisTupleSnapshot(tuple) ? analysisTupleCacheKey(tuple) : null;
    const cached = tupleKey !== null
      ? (tupleCache !== null && tupleCache.key === tupleKey ? tupleCache : null)
      : generation !== null && legacyCache !== null && legacyCache.generation === generation
        ? legacyCache : null;
    if (cached) {
      ({ envelope, envelopeRate, onsets } = cached);
    } else if (hasMono) {
      const sampleRateField = ownDataField(msg, 'sampleRate');
      const sampleRate = Number(sampleRateField.present ? sampleRateField.value : NaN);
      if (!Number.isFinite(sampleRate) || sampleRate <= 0 || mono.length < MIN_SAMPLES) {
        // Empty or too-short source: a valid, explicitly empty result, not a crash.
        envelope = new Float32Array(0);
        envelopeRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate / ENVELOPE_HOP : 0;
        onsets = new Float32Array(0);
      } else {
        const res = onsetAnalysis(mono, sampleRate);
        envelope = res.envelope;
        envelopeRate = res.envelopeRate;
        onsets = res.onsets;
      }
      const cacheValue = { envelope, envelopeRate, onsets };
      if (tupleKey !== null) tupleCache = { key: tupleKey, ...cacheValue };
      else legacyCache = generation !== null ? { generation, ...cacheValue } : null;
    } else {
      self.postMessage({
        type: 'error',
        ...reply,
        message: 'Analysis: no cached envelope for this generation and no mono provided'
      });
      return;
    }

    postProgress(reply, 50);

    if (envelope.length === 0) {
      postProgress(reply, 90);
      postProgress(reply, 100);
      self.postMessage({ type: 'done', ...reply, analysis: emptyAnalysis(envelopeRate) });
      return;
    }

    const { tempo, beats, downbeat, confidence } = trackBeats(envelope, envelopeRate, anchors);
    postProgress(reply, 90);

    const analysis = {
      onsets,
      envelope,
      envelopeRate,
      tempo,
      beats,
      downbeat,
      beatsPerBar: BEATS_PER_BAR,
      confidence
    };

    postProgress(reply, 100);
    // No transfer list on purpose: envelope and onsets stay cached in this worker
    // for anchor re-runs; structured clone copies them to the main thread.
    self.postMessage({ type: 'done', ...reply, analysis });
  } catch (err) {
    self.postMessage({
      type: 'error',
      ...reply,
      message: err && err.message ? err.message : String(err),
    });
  }
};

function ownDataField(value, key) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return { present: false, value: undefined };
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return { present: false, value: undefined };
    }
    return { present: true, value: descriptor.value };
  } catch {
    return { present: false, value: undefined };
  }
}

function replyMetadata(msg, tuple) {
  const job = ownDataField(msg, 'job');
  const reply = { job: job.present ? job.value : null };
  const generation = ownDataField(msg, 'generation');
  if (generation.present) reply.generation = generation.value;
  if (isAnalysisTupleSnapshot(tuple)) Object.assign(reply, tuple);
  return reply;
}

function postProgress(reply, pct) {
  self.postMessage({ type: 'progress', ...reply, pct });
}

function normalizeAnchors(anchors) {
  return {
    bpm: anchors && Number.isFinite(anchors.bpm) ? anchors.bpm : null,
    barOneTime: anchors && Number.isFinite(anchors.barOneTime) ? anchors.barOneTime : null
  };
}

function emptyAnalysis(envelopeRate) {
  return {
    onsets: new Float32Array(0),
    envelope: new Float32Array(0),
    envelopeRate,
    tempo: 0,
    beats: new Float32Array(0),
    downbeat: 0,
    beatsPerBar: BEATS_PER_BAR,
    confidence: 0
  };
}
