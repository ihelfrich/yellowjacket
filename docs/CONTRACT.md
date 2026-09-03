# Yellowjacket — module contract (build agents: follow this EXACTLY)

Yellowjacket is a fully client-side audio bench hosted as static files on GitHub Pages
(https://ihelfrich.github.io/yellowjacket/). No build step. Plain ES modules loaded from
`index.html` via `<script type="module" src="js/main.js">`. No frameworks. No npm. The ONLY
external dependency is `@huggingface/transformers` pulled from a CDN inside the whisper worker.
Everything else is hand-rolled vanilla JS. Target: evergreen Chrome/Edge/Firefox/Safari.
GitHub Pages CANNOT set COOP/COEP headers, so there is NO SharedArrayBuffer and NO
multi-threaded WASM. Design for single-threaded WASM fallback + WebGPU when available.

Repo root: /Users/ian/Projects/yellowjacket/

## Global conventions
- ES2020 modules, `export` named symbols exactly as specified below.
- No semicolon wars: use semicolons. 2-space indent. camelCase.
- Every module is import-safe in a Worker context only if listed as worker-safe.
- All audio math on `Float32Array` mono unless stated. Stereo kept as AudioBuffer.
- Events: classes that emit extend `EventTarget`, use `CustomEvent` with `detail`.
- No console.log left in final code (console.warn/error for real faults is fine).
- Comments: sparse, only for non-obvious math (cite the formula source inline, e.g. "BS.1770-4 K-weighting").

## State shape (owned by main.js, passed to views)
```js
// The single project object. main.js owns it; views read it and emit intents.
project = {
  fileName: string,
  buffer: AudioBuffer|null,        // original decoded audio, untouched
  mono: Float32Array|null,         // mixed-down mono copy for analysis/transcription
  sampleRate: number,
  words: Word[]|null,              // transcript; null = not transcribed yet
  chain: EffectConfig[],           // ordered DSP rack config
  renderedBuffer: AudioBuffer|null // last render result (cuts + chain applied)
}
Word = { text: string, start: number, end: number, deleted: bool, filler: bool, gapAfter: number }
// times in seconds against the ORIGINAL buffer. gapAfter = silence gap to next word (sec).
Cut = { start: number, end: number }   // seconds, original timeline, non-overlapping, sorted
EffectConfig = { id: string, on: bool, params: {..} }  // params per-module, see dsp section
```

## File-by-file interfaces

### js/fft.js  (worker-safe)
```js
export class FFT {
  constructor(size)              // size = power of 2
  forward(re: Float32Array, im: Float32Array): void  // in-place radix-2
  inverse(re, im): void          // in-place, includes 1/N scaling
}
export function hann(n): Float32Array          // cached ok
export function nextPow2(n): number
```

### js/audio-engine.js
```js
export class Engine extends EventTarget {
  // events: 'time' {t}, 'state' {playing}, 'loaded' {}, 'ended' {}
  async load(arrayBuffer, fileName): Promise<void>   // decodeAudioData; builds .buffer, .mono
  buffer, mono, sampleRate, duration                 // getters
  play(cuts = [], from = null)   // schedules segments SKIPPING cut ranges; from = seconds
  pause()
  seek(t)                        // seconds, original timeline
  get currentTime()              // seconds, original timeline (maps through cuts while playing)
  get playing()
  setAltBuffer(audioBuffer|null) // A/B: when set, play() uses THIS buffer verbatim
                                 // (no cuts — it is already rendered) and currentTime runs on
                                 // the alt buffer's own timeline. null returns to original.
  get ctx()                      // the AudioContext (lazy-created; may be null before first play)
  get master()                   // master GainNode all sources route through (for metering)
}
```
Segment scheduling: build [{start,end}] of KEPT ranges from cuts, schedule one
AudioBufferSourceNode per segment with ctx.currentTime offsets. 'time' event fires ~30fps
via requestAnimationFrame while playing, detail.t in ORIGINAL timeline seconds (i.e. it jumps
over cuts). AudioContext created lazily on first user gesture (browser autoplay policy).
All sources connect through this.master (GainNode) -> ctx.destination. 'ended' fires when
the last scheduled segment finishes on its own.

### js/render/peaks.js  (worker-safe, pure)
```js
export function buildPeakPyramid(mono: Float32Array): PeakPyramid
// { mono, length, levels: [{block: 64|512|4096, min: Float32Array, max: Float32Array}] }
// one immutable pyramid per source; layout documented in the module header
export function queryPeaks(pyramid, startSample, endSample, columns, outMin, outMax): void
// fills per-column min/max; coarsest level with >= 1 block per column, direct
// sample scan below the level-0 block size; allocation-free with out arrays
```

### js/waveform.js
```js
export class WaveformView extends EventTarget {
  // events: 'seek' {t}, 'select' {start, end} (null when cleared),
  //         'view' {start, end} (fires after any zoom/pan so siblings can sync)
  constructor(canvas)
  setBuffer(mono: Float32Array, sampleRate, pyramid?)  // pyramid: shared PeakPyramid
                                 // built from this same mono; absent = build own
  setCuts(cuts: Cut[])           // draw cut ranges as hazard-striped dimmed zones
  setPlayhead(t)                 // cheap, no full redraw (layered canvas or overlay draw)
  setSelection(sel|null)
  setView(startSec, endSec)      // zoom window
  get view()
  render()
}
```
Peaks: min/max per pixel column via render/peaks.js queryPeaks, cached per zoom level. Drag = select
range; click = seek; wheel/trackpad = zoom around cursor; shift+drag = pan. DPR-aware
(devicePixelRatio). Colors from CSS custom properties read at render time
(getComputedStyle(document.documentElement).getPropertyValue(...)): waveform body
--yj-wave, playhead --yj-yellow, selection --yj-select-fill, cuts --yj-cut-fill.

### workers/spectrogram-worker.js  (classic worker, no imports — inline the FFT or importScripts NOT allowed with modules; make it a MODULE worker: `new Worker(url, {type:'module'})` and import fft.js)
Protocol (postMessage):
```js
// in:  { type:'compute', mono: Float32Array (transfer), sampleRate, fftSize: 2048, hop: 512, maxCols: number }
// out: { type:'progress', pct }        // 0..100
// out: { type:'done', mags: Float32Array (transfer), cols, bins, minDb, maxDb }
//       mags = column-major magnitude in dB, cols*bins, bins = fftSize/2, clamped [-90, 0]
```
If mono is longer than maxCols*hop samples, stride frames evenly so cols <= maxCols (cap ~8000).

### js/spectrogram.js
```js
export class SpectrogramView extends EventTarget {
  // events: 'seek' {t}
  constructor(canvas)
  async compute(mono, sampleRate)   // spawns worker, emits nothing; returns when done
  setPlayhead(t)
  setView(startSec, endSec)         // sync with waveform zoom
  render()
  get ready()
}
```
Render: map dB -> colormap LUT (256 entries) built from CSS vars: 0.0 -> --yj-bg,
mid -> deep amber (--yj-amber territory), high -> --yj-yellow, hottest -> --yj-hot
then bone white at the very top (iZotope RX runs an amber/gold heat ramp on charcoal;
ours runs hotter into chartreuse). Log-frequency Y axis
(20Hz..sr/2), draw from a cached full-res ImageData/offscreen, then drawImage the visible
window. Frequency ruler labels at 50/100/200/500/1k/2k/5k/10k.

### workers/whisper-worker.js (module worker)
VERIFIED specifics (do not deviate):
- Import: `import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1';`
  Pinned 3.7.1 deliberately: every 4.x release to date fails session creation on the
  onnx-community *_timestamped quantized decoders (ORT QDQ/MatMulNBits regression,
  transformers.js#1707). Bump only when a 4.x release demonstrably loads them.
- Models are the onnx-community *_timestamped family (alignment_heads exported for
  return_timestamps:'word'). Plain Xenova/onnx-community whisper exports DO NOT work for word timestamps.
- Device config per the official whisper-word-timestamps example:
  webgpu -> { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, device: 'webgpu' }
  wasm   -> { dtype: 'q8', device: 'wasm' }
- Check `navigator.gpu` INSIDE the worker (Safari may not expose it in workers); also wrap
  pipeline creation in try/catch and retry with wasm on any webgpu failure.
- After load on webgpu, warm up: `await asr(new Float32Array(16000), { language: 'en' });`
- Transcribe call: `asr(audio, { language, return_timestamps: 'word', chunk_length_s: 30 })`
  (stride defaults to chunk/6 = 5s; do not pass chunk_length_s <= stride).
- Output shape: { text, chunks: [{ text: ' word' (leading space!), timestamp: [start, end] }] }
  — trim word text; final chunk's end timestamp may be null: substitute audio duration.
- GitHub Pages cannot set COOP/COEP: WASM runs single-threaded silently. That is fine.
Protocol:
```js
// in:  { type:'load', model: string }
// out: { type:'load-progress', pct, file }        // use progress_callback; files arrive in parallel — aggregate by loaded/total bytes when available
// out: { type:'ready', device }                    // actual device used after fallback
// in:  { type:'transcribe', mono: Float32Array (16kHz! resample BEFORE sending), language: 'en'|null }
// out: { type:'transcribe-progress', pct }         // from chunk callback if feasible, else coarse
// out: { type:'result', words: [{text,start,end}] }
// out: { type:'error', message }
```

MODELS export in transcribe.js (label sizes are the actual downloads: WebGPU = fp32 encoder + q4 decoder, WASM = q8 + q8; measured against the HF Hub API on 2026-09-03 — see docs/lab/ledger/transcription.md §4):

```js
export const MODELS = [
  { id: 'onnx-community/whisper-tiny.en_timestamped',  label: 'WHISPER TINY EN · 120 MB GPU / 41 MB WASM · fastest',  lang: 'en' },
  { id: 'onnx-community/whisper-base.en_timestamped',  label: 'WHISPER BASE EN · 206 MB GPU / 77 MB WASM · default',  lang: 'en' },
  { id: 'onnx-community/whisper-small.en_timestamped', label: 'WHISPER SMALL EN · 586 MB GPU / 249 MB WASM · best en', lang: 'en' },
  { id: 'onnx-community/whisper-base_timestamped',     label: 'WHISPER BASE · 206 MB GPU / 77 MB WASM · 99 languages', lang: null },
  { id: 'onnx-community/whisper-small_timestamped',    label: 'WHISPER SMALL · 586 MB GPU / 249 MB WASM · 99 languages', lang: null },
];
```
The worker is released after every job and whenever the source changes (Transcriber.dispose()); the next TRANSCRIBE reloads from the Cache API.
// default selection: whisper-base.en_timestamped. Pass language:'en' for .en models, null otherwise.
```
Known upstream behavior: Whisper often SKIPS "um"/"uh" entirely (trained on clean text).
Filler counts will be conservative. This is why dead-air detection is gap/energy based.

### js/transcribe.js
```js
export class Transcriber extends EventTarget {
  // events: 'progress' {stage: 'download'|'transcribe', pct, note}, 'ready', 'error' {message}
  async loadModel(modelId, device)
  async transcribe(mono: Float32Array, sampleRate): Promise<Word[]>
  // resamples to 16k mono internally (linear interp fine), fills deleted:false,
  // filler: FILLERS regex match, gapAfter computed from next word start
}
export const MODELS = [ /* {id, label, size, lang} — from research */ ]
export const FILLERS = /^(um+|uh+|erm+|hmm+|mhm+|like|y'know|you know|i mean|sort of|kind of|basically|actually|literally|right)$/i
// filler flag: single-word matches of um/uh/erm always; the discourse words (like, actually,
// literally, basically, right) only flagged when flanked by gaps >= 0.12s on both sides
// (cheap proxy for parenthetical use). Keep this logic in ONE exported function:
export function isFiller(word, prevGap, nextGap): bool
```

### js/transcript-ui.js
```js
export class TranscriptView extends EventTarget {
  // events: 'wordclick' {index, t}, 'selectrange' {start, end},  'edited' {}  (deleted flags changed)
  constructor(container: HTMLElement)
  setWords(words: Word[])          // renders tokens; stores live reference (mutates .deleted)
  setActiveTime(t)                 // highlight current word during playback (binary search)
  deleteSelection() / restoreSelection()
  markFillersDeleted()             // all filler:true -> deleted:true
  markDeadAir(threshold = 1.0)     // returns count; marks synthetic gap-cuts (see below)
  getCuts(padding = 0.04): Cut[]   // merged, sorted cut ranges from deleted words + dead air,
                                   // padded edges, clamped to word boundaries of kept neighbors
  getText(includeDeleted = false)
}
```
Rendering: each word a <span class="yj-word" data-i>. filler -> .is-filler, deleted ->
.is-cut, active -> .is-now. Click seeks; click-drag or shift+click selects a range; Delete/
Backspace key deletes selection; ctrl/cmd+Z undo (simple stack of deleted-flag snapshots).
Dead air: gaps > threshold between words become cut candidates rendered as a pill token
"␣ 2.4s" between words with class .yj-gap (also .is-cut when marked).

### js/dsp/chain.js
```js
export const REGISTRY = [ /* imported module descriptors in canonical rack order */ ]
// descriptor: { id, title, tagline, kind: 'nodes'|'buffer', defaults: {..},
//               params: [{key, label, unit, min, max, step, def}],
//               build?: (ctx, cfg) => {input: AudioNode, output: AudioNode},   // kind:'nodes'
//               process?: async (buffer: AudioBuffer, cfg, onProgress) => AudioBuffer }  // kind:'buffer'
export async function renderChain(buffer, cuts, chain, onProgress): Promise<AudioBuffer>
export function spliceCuts(buffer: AudioBuffer, cuts: Cut[]): AudioBuffer
// spliceCuts is the canonical cut-splicer (6ms equal-power crossfades); renderChain uses it,
// main.js also imports it directly for cut-only exports.
// 1. splice out cuts (copy kept segments with 6ms equal-power crossfades at joins)
// 2. for each enabled effect in chain order:
//    - consecutive 'nodes' effects batched into ONE OfflineAudioContext pass
//    - 'buffer' effects run as async passes
// 3. returns final AudioBuffer (same channel count as input)
```
Rack order (canonical): highpass, dehum, denoise, deess, eq, gate, compressor, limiter, loudnorm.

### js/dsp/eq.js — kind 'nodes'. 4 bands: low shelf (freq,gain), 2x peaking (freq,gain,Q), high shelf (freq,gain), plus highpassDesc (4th-order Butterworth, pole Qs 0.541196/1.306563). Vicanek-2016 matched IIRFilterNode sections computed per sample rate (decramped near Nyquist), BiquadFilterNode fallback when createIIRFilter is absent. Exports matchedPeaking/matchedShelf/butterworthHighpass for tests.
### js/dsp/compressor.js — kind 'nodes'. DynamicsCompressorNode: threshold, ratio, attack, release, knee + makeup GainNode (auto-makeup = -threshold * (1-1/ratio) * 0.6 when auto:true).
### js/dsp/gate.js — kind 'buffer'. Soft gate: envelope follower (attack 2ms, release from params), gain = smoothstep between floor and 1 across [threshold-6dB, threshold]. Params: threshold dB, release ms, floor dB.
### js/dsp/dehum.js — kind 'nodes'. Base 50 or 60Hz + N harmonics (default 4) of notch biquads, Q 30.
### js/dsp/deess.js — kind 'buffer'. Split band 4.5-9kHz (biquad bandpass on a copy), envelope, when band exceeds threshold apply reduction to band and subtract; simple broadband-minus-band recombine. Params: threshold dB, reduction dB.
### js/dsp/denoise.js — kind 'buffer', worker-backed (workers/denoise-worker.js, module worker importing fft.js). Spectral gating per the VERIFIED noisereduce recipe (github.com/timsainb/noisereduce):
- STFT: n_fft 1024, hop 256 (75% overlap), Hann analysis window. With single-Hann + hop N/4, overlapped windows sum to a constant 1.5: divide the overlap-add output by 1.5.
- Noise profile: frames ranked by RMS, quietest 15% (at least ~0.5s worth; if the clip is too short use all frames) -> per-bin mean and std of magnitude IN dB.
- Threshold per bin: thresh_dB[f] = mean_dB[f] + 1.5 * std_dB[f].
- Binary mask: 1 where frame magnitude dB > thresh, else 0. Smooth the mask (NOT the audio) with a box blur ~500 Hz wide in frequency (bins = round(500 * nfft / sr)) and ~50 ms in time (frames = round(0.05 * sr / hop)).
- Apply gain[f,t] = 1 - prop * (1 - smoothedMask[f,t]), where prop = params.strength (0..1, def 0.85; 1.0 = full attenuation sounds robotic, default should not be 1).
- Also floor the gain at 10^(floorDb/20).
- Overlap-add resynthesis, per-channel. Params: strength 0..1 step 0.05 def 0.85, floorDb -80..-20 step 1 def -60.
### js/dsp/limiter.js — kind 'buffer'. Lookahead 5ms brickwall at ceiling dBFS: gain envelope = min over lookahead window of ceiling/|peak|, smoothed with 5ms attack / 60ms release one-pole. Params: ceiling (-3..0 dBFS).
### js/dsp/loudnorm.js — kind 'buffer'. Uses loudness.js: measure integrated LUFS, compute static gain to hit target, apply, re-limit at -1 dBTP-ish via limiter pass. Params: target (-24..-9, def -16).

### js/dsp/loudness.js  (worker-safe, pure functions)
VERIFIED reference numbers (ITU-R BS.1770-5 + pyloudnorm 'DeMan'):
- 48 kHz stage-1 shelf: b = [1.53512485958697, -2.69169618940638, 1.19839281085285],
  a = [1, -1.69065929318241, 0.73248077421585]. Stage-2 RLB high-pass: b = [1, -2, 1],
  a = [1, -1.99004745483398, 0.99007225036621]. Any arbitrary-rate redesign MUST reproduce
  these at 48 kHz within 1e-4.
- Arbitrary sample rate via De Man parametrization: shelf G = 3.99984385397 dB,
  Q = 0.7071752369554193, fc = 1681.9744509555319 Hz; high-pass Q = 0.5003270373253953,
  fc = 38.13547087613982 Hz.
- Block loudness l_j = -0.691 + 10*log10(sum_i G_i * z_ij), z = mean square of K-weighted
  samples per 400 ms block, 75% overlap (100 ms hop). Stereo channel weights 1.0/1.0.
- Gating: absolute -70 LKFS; relative = (loudness over abs-gated blocks) - 10 LU; integrated
  over blocks passing both. Momentary = 400 ms sliding, short-term = 3 s sliding, both ungated.
- True peak (BS.1770-5 Annex 2): attenuate 12.04 dB, 4x oversample (48-tap 4-phase FIR),
  abs, 20log10 + 12.04. Linear-interp oversampling is acceptable if labeled estimate.
```js
export function kWeightingCoeffs(sampleRate): {b1,a1,b2,a2}   // BS.1770-4 two-stage, bilinear-redesigned for arbitrary sr
export function measureLoudness(buffer or {channels: Float32Array[], sampleRate}): {
  integrated,        // LUFS, gated per BS.1770-4 (-70 abs, -10 rel)
  momentaryMax, shortTermMax,   // LUFS
  samplePeakDb, truePeakDb,     // truePeak via 4x linear-phase-ish oversample (polyphase linear interp acceptable, label it "est.")
  rmsDb, crestDb, dcOffset, clippedSamples, clippedPct
}
```

### js/export.js
```js
export function encodeWav(buffer: AudioBuffer, bitDepth: 16|24): Blob
export function toSrt(words, {skipDeleted}) / toVtt(words, opts) / toTxT? -> toTxt(words, opts): string
// caption grouping: <= 42 chars per line, <= 2 lines, break at gaps/punctuation, retime
// against EDITED timeline when skipDeleted (subtract cut durations before each word)
export function editedTime(t, cuts): number   // original->edited timeline mapping
export function download(blob|string, filename, mime)
```

### js/meters.js
```js
export class LevelMeter {   // canvas peak+RMS bar, silkscreen ticks at 0,-6,-12,-24,-48
  constructor(canvas); connect(audioContext, node); start(); stop(); // AnalyserNode based
  onclip = null;            // called once per new clip event (|sample| >= 0.999)
}
```
Ballistics (IEC 60268-18 digital peak meter, verified convention): INSTANT attack,
release ~20 dB per 1.7 s. Peak-hold tick holds 1.5 s then decays. RMS bar drawn behind
peak bar in --yj-amber; peak bar --yj-yellow; above -6 dB segment tinted --yj-hot;
tick labels 9px mono --yj-ink-dim. Wrong ballistics is the #1 tell of a toy meter —
use exact time constants: gain per frame = Math.pow(10, (-20/20) * dt/1.7).

### js/main.js — owns project state, tab switching, drag-drop + file input, wires every view,
runs transcription, computes cuts (transcript.getCuts()), render + A/B (original vs rendered
playback toggle), status line ("TRANSCRIBING · 42%" style), export menu, keyboard shortcuts
(space = play/pause, F = mark fillers, R = render). All user-visible copy in a single
`const COPY = {...}` object at the top for voice control.

### index.html + css/yj.css — layout per DESIGN.md (separate doc). Semantic, no inline styles,
CSS custom properties for the entire palette, all labels ALL-CAPS microtype except transcript
words and prose.

## Testing hooks
Each module must be loadable standalone with zero side effects at import time (no DOM
access at top level except views taking elements in constructors). main.js is the only
file that touches document at load.
