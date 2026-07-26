// Yellowjacket — whisper transcription worker (module worker).
// Pinned to 3.7.1, matching the official whisper-word-timestamps example. Do NOT bump to
// 4.0.0-4.2.0: their bundled onnxruntime-web has a QDQ fusion regression that fails session
// creation on these models' quantized decoders (onnxruntime#28306, transformers.js#1707).
// The fix ships in transformers.js >= 4.3.0; revisit the pin when that exists.
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1';

const TARGET_RATE = 16000;
const CHUNK_S = 30;
const STRIDE_S = CHUNK_S / 6; // transformers.js default stride = chunk/6 = 5s

let asr = null;
let device = null;
let loadedModel = null;
let busy = false;

// Per-file download state for aggregate progress. Files arrive in parallel.
const files = new Map();

function overallPct() {
  let loaded = 0;
  let total = 0;
  let pctSum = 0;
  let count = 0;
  let haveAllBytes = true;
  for (const f of files.values()) {
    count += 1;
    pctSum += f.progress || 0;
    if (f.total > 0) {
      loaded += f.loaded || 0;
      total += f.total;
    } else {
      haveAllBytes = false;
    }
  }
  if (count === 0) return 0;
  // Weight by bytes when every file reports a total; else average per-file pct.
  if (haveAllBytes && total > 0) return Math.min(100, (loaded / total) * 100);
  return Math.min(100, pctSum / count);
}

function onProgressInfo(info) {
  if (!info || !info.file) return;
  let f = files.get(info.file);
  if (!f) {
    f = { loaded: 0, total: 0, progress: 0 };
    files.set(info.file, f);
  }
  if (info.status === 'progress') {
    if (typeof info.loaded === 'number') f.loaded = info.loaded;
    if (typeof info.total === 'number') f.total = info.total;
    if (typeof info.progress === 'number') f.progress = info.progress;
  } else if (info.status === 'done') {
    f.progress = 100;
    if (f.total > 0) f.loaded = f.total;
  } else if (info.status !== 'initiate' && info.status !== 'download') {
    return; // non-file lifecycle statuses ('ready' etc.) carry no byte info
  }
  postMessage({ type: 'load-progress', pct: overallPct(), file: info.file });
}

function pipelineOptions(dev) {
  // Verified config for the onnx-community *_timestamped exports.
  if (dev === 'webgpu') {
    return {
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      device: 'webgpu',
      progress_callback: onProgressInfo,
    };
  }
  return { dtype: 'q8', device: 'wasm', progress_callback: onProgressInfo };
}

async function disposeAsr() {
  if (asr && typeof asr.dispose === 'function') {
    try {
      await asr.dispose();
    } catch (err) {
      // already torn down; nothing to release
    }
  }
  asr = null;
  device = null;
  loadedModel = null;
}

async function handleLoad(model) {
  if (asr && loadedModel === model) {
    postMessage({ type: 'ready', device });
    return;
  }
  await disposeAsr();
  files.clear();
  // Check navigator.gpu INSIDE the worker: Safari may not expose it in workers.
  const wantGpu = typeof navigator !== 'undefined' && !!navigator.gpu;
  if (wantGpu) {
    try {
      asr = await pipeline('automatic-speech-recognition', model, pipelineOptions('webgpu'));
      device = 'webgpu';
      // Warm-up pass compiles the WebGPU shaders so the first real run is not slow.
      // English-only (.en) models reject a language option outright.
      await asr(new Float32Array(TARGET_RATE), /\.en/.test(model) ? {} : { language: 'en' });
    } catch (err) {
      // Any webgpu failure (adapter, shader compile, warm-up): retry on wasm.
      await disposeAsr();
      files.clear();
    }
  }
  if (!asr) {
    asr = await pipeline('automatic-speech-recognition', model, pipelineOptions('wasm'));
    device = 'wasm';
  }
  loadedModel = model;
  postMessage({ type: 'ready', device });
}

async function handleTranscribe(mono, language) {
  if (!asr) {
    postMessage({ type: 'error', message: 'No model loaded.' });
    return;
  }
  const audio = mono instanceof Float32Array ? mono : new Float32Array(mono || 0);
  const duration = audio.length / TARGET_RATE;
  if (audio.length === 0) {
    postMessage({ type: 'result', words: [] });
    return;
  }
  // Each chunk advances ~ (chunk - 2*stride) seconds of fresh audio.
  const expectedChunks = Math.max(1, Math.ceil(duration / (CHUNK_S - 2 * STRIDE_S)));
  let chunksDone = 0;
  const options = {
    return_timestamps: 'word',
    chunk_length_s: CHUNK_S,
    // Best-effort per-chunk progress; ignored harmlessly if this build never calls it,
    // in which case the client falls back to its own estimate.
    chunk_callback: () => {
      chunksDone += 1;
      postMessage({
        type: 'transcribe-progress',
        pct: Math.min(99, (chunksDone / expectedChunks) * 100),
      });
    },
  };
  // .en models throw if a language is specified; only multilingual models take one.
  if (language && !/\.en/.test(loadedModel || '')) options.language = language;

  const output = await asr(audio, options);
  const chunks = (output && output.chunks) || [];
  const words = [];
  for (const c of chunks) {
    // Upstream chunk text carries a leading space: trim it.
    const text = (c && c.text != null ? String(c.text) : '').trim();
    if (!text) continue;
    const ts = c && Array.isArray(c.timestamp) ? c.timestamp : [null, null];
    words.push({
      text,
      start: typeof ts[0] === 'number' && isFinite(ts[0]) ? ts[0] : null,
      end: typeof ts[1] === 'number' && isFinite(ts[1]) ? ts[1] : null,
    });
  }
  // Final chunk's end timestamp may be null: substitute the audio duration.
  if (words.length && words[words.length - 1].end == null) {
    words[words.length - 1].end = duration;
  }
  postMessage({ type: 'result', words });
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (busy) {
    postMessage({ type: 'error', message: 'Worker busy — request dropped.' });
    return;
  }
  busy = true;
  try {
    if (msg.type === 'load') {
      await handleLoad(msg.model);
    } else if (msg.type === 'transcribe') {
      await handleTranscribe(msg.mono, msg.language);
    } else {
      postMessage({ type: 'error', message: 'Unknown message type: ' + String(msg.type) });
    }
  } catch (err) {
    postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  } finally {
    busy = false;
  }
};
