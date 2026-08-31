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

const MIN_SAMPLES = 2048;   // below this there is no meaningful STFT frame to analyze
const ENVELOPE_HOP = 512;   // per contract: envelope hopSize 512 @ analysis rate
const BEATS_PER_BAR = 4;    // fixed this slice

// The live singular controller keeps its generation cache through Task 11.
// Future requests are isolated by source and algorithm so neither can hit this
// legacy slot or another source/version entry.
let legacyCache = null; // { generation, envelope, envelopeRate, onsets }
let tupleCache = null; // { key, envelope, envelopeRate, onsets }
const IDENTIFIER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SOURCE_ID_RE = /^(?:sha256:[0-9a-f]{64}|[a-z0-9][a-z0-9._-]{0,63})$/;

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'analyze') return;

  const reply = replyMetadata(msg);
  const generation = msg.generation ?? null;
  const anchors = normalizeAnchors(msg.anchors);
  const hasMono = msg.mono instanceof Float32Array;
  const tuple = analysisTuple(msg);

  try {
    if (tuple.kind === 'invalid') throw new TypeError('Analysis tuple is invalid');
    postProgress(reply, 5);

    let envelope;
    let envelopeRate;
    let onsets;

    const cached = tuple.kind === 'tuple'
      ? (tupleCache !== null && tupleCache.key === tuple.key ? tupleCache : null)
      : generation !== null && legacyCache !== null && legacyCache.generation === generation
        ? legacyCache : null;
    if (cached) {
      ({ envelope, envelopeRate, onsets } = cached);
    } else if (hasMono) {
      const mono = msg.mono;
      const sampleRate = Number(msg.sampleRate);
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
      if (tuple.kind === 'tuple') tupleCache = { key: tuple.key, ...cacheValue };
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

function replyMetadata(msg) {
  const reply = { job: msg.job ?? null };
  for (const key of ['generation', 'sourceId', 'jobId', 'algorithmVersion']) {
    if (Object.hasOwn(msg, key)) reply[key] = msg[key];
  }
  return reply;
}

function analysisTuple(msg) {
  const supplied = ['sourceId', 'jobId', 'algorithmVersion'].some((key) => Object.hasOwn(msg, key));
  if (!supplied) return { kind: 'legacy' };
  if (typeof msg.sourceId !== 'string' || !SOURCE_ID_RE.test(msg.sourceId)
      || typeof msg.jobId !== 'string' || !IDENTIFIER_RE.test(msg.jobId)
      || typeof msg.algorithmVersion !== 'string' || !IDENTIFIER_RE.test(msg.algorithmVersion)) {
    return { kind: 'invalid' };
  }
  return { kind: 'tuple', key: msg.sourceId + ':' + msg.algorithmVersion };
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
