// Yellowjacket — source analysis worker (module). Runs onset/envelope extraction
// and beat tracking off the main thread. The onset envelope is cached per source
// generation id, so anchor-only re-runs (same generation) skip the expensive
// onsetAnalysis pass and go straight to trackBeats.
//
// Protocol:
//   in:  { type:'analyze', mono: Float32Array (transfer; may be omitted on anchor
//          re-runs for a cached generation), sampleRate,
//          anchors: { bpm: number|null, barOneTime: number|null },
//          generation: string|number, job: number }
//   out: { type:'progress', job, pct }   // at least 5 / 50 / 90 / 100
//   out: { type:'done', job, analysis }  // full project.analysis shape minus anchors
//   out: { type:'error', job, message }  // no cached envelope for generation and no mono
//
// Every reply echoes `job`. The request carried a generation and the replies
// dropped it, so the caller could only ask "is the CURRENT generation still
// current", which is true even when the answer in hand was computed for the
// previous file. A slow analysis finishing after a new file loaded was
// installed as the new file's beatmap.

import { onsetAnalysis } from '../js/analysis/onsets.js';
import { trackBeats } from '../js/analysis/beattrack.js';

const MIN_SAMPLES = 2048;   // below this there is no meaningful STFT frame to analyze
const ENVELOPE_HOP = 512;   // per contract: envelope hopSize 512 @ analysis rate
const BEATS_PER_BAR = 4;    // fixed this slice

// Single-entry cache: the bench holds one source at a time.
let cache = null; // { generation, envelope, envelopeRate, onsets }

let currentJob = null;   // the job progress messages belong to

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'analyze') return;

  const job = msg.job ?? null;
  currentJob = job;
  const generation = msg.generation ?? null;
  const anchors = normalizeAnchors(msg.anchors);
  const hasMono = msg.mono instanceof Float32Array;

  try {
    postProgress(5);

    let envelope;
    let envelopeRate;
    let onsets;

    const hit = generation !== null && cache !== null && cache.generation === generation;
    if (hit) {
      ({ envelope, envelopeRate, onsets } = cache);
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
      cache = generation !== null ? { generation, envelope, envelopeRate, onsets } : null;
    } else {
      self.postMessage({
        type: 'error',
        job,
        message: 'Analysis: no cached envelope for this generation and no mono provided'
      });
      return;
    }

    postProgress(50);

    if (envelope.length === 0) {
      postProgress(90);
      postProgress(100);
      self.postMessage({ type: 'done', analysis: emptyAnalysis(envelopeRate) });
      return;
    }

    const { tempo, beats, downbeat, confidence } = trackBeats(envelope, envelopeRate, anchors);
    postProgress(90);

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

    postProgress(100);
    // No transfer list on purpose: envelope and onsets stay cached in this worker
    // for anchor re-runs; structured clone copies them to the main thread.
    self.postMessage({ type: 'done', job, analysis });
  } catch (err) {
    self.postMessage({ type: 'error', job, message: err && err.message ? err.message : String(err) });
  }
};

function postProgress(pct) {
  self.postMessage({ type: 'progress', job: currentJob, pct });
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
