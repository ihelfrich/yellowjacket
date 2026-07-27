// Yellowjacket — transcription front end. Owns the whisper worker, resampling,
// progress mapping, and word assembly. Times are seconds on the ORIGINAL buffer.

export const MODELS = [
  { id: 'onnx-community/whisper-tiny.en_timestamped',  label: 'WHISPER TINY EN · ~41 MB · fastest',  lang: 'en' },
  { id: 'onnx-community/whisper-base.en_timestamped',  label: 'WHISPER BASE EN · ~77 MB · default',  lang: 'en' },
  { id: 'onnx-community/whisper-small.en_timestamped', label: 'WHISPER SMALL EN · ~250 MB · best en', lang: 'en' },
  { id: 'onnx-community/whisper-base_timestamped',     label: 'WHISPER BASE · ~77 MB · 99 languages', lang: null },
  { id: 'onnx-community/whisper-small_timestamped',    label: 'WHISPER SMALL · ~250 MB · 99 languages', lang: null },
];

export const FILLERS = /^(um+|uh+|erm+|hmm+|mhm+|like|y'know|you know|i mean|sort of|kind of|basically|actually|literally|right)$/i;

// um/uh/erm/hmm/mhm are always fillers; the discourse words only count when
// flanked by gaps >= FLANK_GAP on both sides (cheap proxy for parenthetical use).
const HARD_FILLERS = /^(um+|uh+|erm+|hmm+|mhm+)$/i;
const FLANK_GAP = 0.12;
const MIN_WORD_DUR = 0.04;
const TARGET_RATE = 16000;

export function isFiller(word, prevGap, nextGap) {
  // Whisper words often carry punctuation ("um," / "Right."): strip the edges,
  // keep apostrophes for y'know.
  const w = String(word == null ? '' : word)
    .trim()
    .replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '');
  if (!w || !FILLERS.test(w)) return false;
  if (HARD_FILLERS.test(w)) return true;
  return prevGap >= FLANK_GAP && nextGap >= FLANK_GAP;
}

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

// Resampling to 16 kHz happens INSIDE the whisper worker now, through the Kaiser
// polyphase sinc in js/dsp/resample.js. The linear interpolation that used to live
// here was unfiltered decimation: everything above 8 kHz aliased into the speech
// bands the ASR reads (TRUTH 1, audit item 6).

export class Transcriber extends EventTarget {
  // events: 'progress' {stage: 'download'|'transcribe', pct, note}, 'ready', 'error' {message}
  constructor() {
    super();
    this._worker = null;
    this._device = null;
    this._modelLoaded = false;
    this._modelId = null;
    this._load = null; // pending loadModel {resolve, reject}
    this._job = null;  // pending transcribe {resolve, reject, duration}
    this._est = null;  // estimate interval id
    this._estStart = 0;
    this._estExpected = 1;
    this._realProgressSeen = false;
  }

  get device() {
    return this._device;
  }

  get modelLoaded() {
    return this._modelLoaded;
  }

  async loadModel(modelId, device) {
    // `device` is accepted for interface compatibility; the worker probes
    // navigator.gpu itself and falls back to wasm, per the worker protocol.
    void device;
    if (this._load) throw new Error('Model load already in progress.');
    if (this._job) throw new Error('Transcription in progress — wait for it to finish.');
    const w = this._ensureWorker();
    this._modelLoaded = false;
    this._modelId = modelId;
    return new Promise((resolve, reject) => {
      this._load = { resolve, reject };
      w.postMessage({ type: 'load', model: modelId });
    });
  }

  async transcribe(mono, sampleRate) {
    if (!this._modelLoaded) throw new Error('No model loaded.');
    if (this._job) throw new Error('Transcription already in progress.');
    if (this._load) throw new Error('Model still loading.');
    if (!mono || mono.length === 0 || !isNum(sampleRate) || sampleRate <= 0) return [];
    const duration = mono.length / sampleRate;
    const copy = mono.slice(); // the buffer gets transferred
    const language = this._language();
    const w = this._ensureWorker();
    return new Promise((resolve, reject) => {
      this._job = { resolve, reject, duration };
      this._startEstimate(duration);
      w.postMessage({ type: 'transcribe', mono: copy, sampleRate, language }, [copy.buffer]);
    });
  }

  _language() {
    const entry = MODELS.find((m) => m.id === this._modelId);
    if (entry) return entry.lang;
    return /\.en/.test(this._modelId || '') ? 'en' : null;
  }

  _ensureWorker() {
    if (this._worker) return this._worker;
    const w = new Worker(new URL('../workers/whisper-worker.js', import.meta.url), { type: 'module' });
    w.addEventListener('message', (e) => this._onMessage(e.data || {}));
    w.addEventListener('error', (e) => {
      this._fault(e && e.message ? e.message : 'Whisper worker failed — see console.');
    });
    w.addEventListener('messageerror', () => {
      this._fault('Whisper worker sent an unreadable message.');
    });
    this._worker = w;
    return w;
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'load-progress': {
        const pct = Math.max(0, Math.min(100, isNum(msg.pct) ? msg.pct : 0));
        const note = msg.file ? String(msg.file).split('/').pop() : undefined;
        this.dispatchEvent(new CustomEvent('progress', { detail: { stage: 'download', pct, note } }));
        break;
      }
      case 'ready': {
        this._device = msg.device || 'wasm';
        this._modelLoaded = true;
        if (this._load) {
          const p = this._load;
          this._load = null;
          p.resolve();
        }
        this.dispatchEvent(new CustomEvent('ready', { detail: { device: this._device } }));
        break;
      }
      case 'transcribe-progress': {
        // Real per-chunk signal from the worker: retire the estimate.
        this._realProgressSeen = true;
        this._stopEstimate();
        const pct = Math.max(0, Math.min(100, isNum(msg.pct) ? msg.pct : 0));
        this.dispatchEvent(new CustomEvent('progress', { detail: { stage: 'transcribe', pct } }));
        break;
      }
      case 'result': {
        this._stopEstimate();
        const job = this._job;
        this._job = null;
        if (job) job.resolve(this._assemble(msg.words || [], job.duration));
        break;
      }
      case 'error': {
        this._fault(msg.message || 'Transcription fault.');
        break;
      }
      default:
        break;
    }
  }

  _fault(message) {
    this._stopEstimate();
    if (this._load) {
      const p = this._load;
      this._load = null;
      p.reject(new Error(message));
    }
    if (this._job) {
      const p = this._job;
      this._job = null;
      p.reject(new Error(message));
    }
    this.dispatchEvent(new CustomEvent('error', { detail: { message } }));
  }

  _startEstimate(duration) {
    this._realProgressSeen = false;
    this._estStart = performance.now();
    // Rough wall-clock guess: WebGPU runs far faster than real time, WASM near it.
    const rate = this._device === 'webgpu' ? 0.08 : 0.9;
    this._estExpected = Math.max(3, duration * rate);
    this._est = setInterval(() => {
      if (this._realProgressSeen) {
        this._stopEstimate();
        return;
      }
      const elapsed = (performance.now() - this._estStart) / 1000;
      const pct = Math.min(95, (elapsed / this._estExpected) * 100);
      this.dispatchEvent(new CustomEvent('progress', {
        detail: { stage: 'transcribe', pct, note: 'ESTIMATE' },
      }));
    }, 400);
  }

  _stopEstimate() {
    if (this._est != null) {
      clearInterval(this._est);
      this._est = null;
    }
  }

  _assemble(raw, duration) {
    const resolved = [];
    for (const r of raw) {
      const text = String(r && r.text != null ? r.text : '').trim();
      if (!text) continue;
      resolved.push({
        text,
        start: isNum(r.start) ? r.start : null,
        end: isNum(r.end) ? r.end : null,
      });
    }
    const n = resolved.length;
    for (let i = 0; i < n; i++) {
      const w = resolved[i];
      if (w.start == null) w.start = i > 0 ? resolved[i - 1].end : 0;
      w.start = Math.max(0, Math.min(w.start, duration));
      if (w.end == null) {
        const next = i + 1 < n ? resolved[i + 1] : null;
        w.end = next && next.start != null ? next.start : duration;
      }
      w.end = Math.min(w.end, duration);
      if (w.end - w.start < MIN_WORD_DUR) {
        w.end = w.start + MIN_WORD_DUR;
        if (w.end > duration) {
          // Clip shorter than the minimum near the tail: keep inside the buffer.
          w.end = duration;
          w.start = Math.max(0, w.end - MIN_WORD_DUR);
        }
      }
    }
    const words = [];
    for (let i = 0; i < n; i++) {
      const w = resolved[i];
      const next = i + 1 < n ? resolved[i + 1] : null;
      // Last word: gap to end of audio (trailing silence is real dead air).
      const gapAfter = Math.max(0, (next ? next.start : duration) - w.end);
      words.push({ text: w.text, start: w.start, end: w.end, deleted: false, filler: false, gapAfter });
    }
    for (let i = 0; i < n; i++) {
      const prevGap = i === 0 ? words[0].start : words[i - 1].gapAfter;
      const nextGap = words[i].gapAfter;
      words[i].filler = isFiller(words[i].text, prevGap, nextGap);
    }
    return words;
  }
}
