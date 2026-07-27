# Yellowjacket architecture and performance audit

**Decision:** refactor the composition layer and define the persistent/state schema before LOCK. Keep the audio engine, views, compiler, and vanilla-module model. The system does not need a framework or a general event bus; it needs explicit ownership, shared derived-data caches, and audio assets separated from pattern documents.

## 1. Structure

`main.js` is already a liability. Its 1,001 lines are not intrinsically excessive, but it simultaneously owns persistent state, transient UI state (`cuts`, A/B, selection, freshness), async generations, worker lifecycles, transport arbitration, DOM construction, and every mutation. OPFS autosave cannot reliably observe that scattered state, and LIVE/UNMIX will add more long-running jobs whose results can arrive after a source change.

Use four small pieces:

- `js/app/project-store.js`: `createProject()`, schema normalization/migrations, revision/dirty tracking, and `update(kind, fn)`. It extends `EventTarget` and emits one JSDoc-typed `change` event. Split the serializable document from runtime handles: `state.project` contains IDs/configuration; `state.runtime` contains `AudioBuffer`, mono PCM, workers, decoded asset cache, and current jobs.
- `js/app/source-controller.js`: file/URL ingest, generation/abort tokens, decode, spectrogram, beat analysis, transcription, and source replacement.
- `js/app/bench-controller.js`: transcript/cuts, rack, measurement, A/B, and exports.
- `js/machine/controller.js`: clips, assignment, scenes, machine transport, freeze/conform/live integration. `main.js` becomes a roughly 150-line composition root for view construction, tabs, status, and controller startup.

Do not introduce a global string-addressed bus. The existing view-local `CustomEvent` contracts are appropriately narrow; controllers should translate them into store updates. Migration is mechanical: first extract `createProject` and runtime state while preserving property names; then move the three contiguous wiring blocks without changing any existing export; finally route mutations through `store.update` so autosave sees them. Constructors receive DOM/view references, preserving the rule that imported modules have no top-level DOM side effects.

LOCK should extend, not replace, the current hot representation:

```js
project.assets[id] = { id, kind, label, sampleRate, channels, frames };
runtime.assetPcm[id] = null;         // decoded on demand; never serialized
machine = {
  activeScene: 0, pendingScene: null,
  scenes: Array(8),                 // scene 0 wraps today's pattern
  tracks: scenes[0].tracks,         // runtime alias consumed by current compiler
};
scene = { id, name, bpm, swing, seed, tracks: Array(8) };
track = {
  sampleId, sample: null,           // sample is runtime-resolved, never serialized
  steps: Uint8Array(64),            // keep the fast trigger mask and current contract
  stepData: {                       // sparse; keys are decimal step indices
    "7": {
      components: [{ type: "ratchet", count: 3 }],
      locks: { gainDb: -6, pan: 0.25, "filter.freq": 1200 },
      condition: { probability: 0.75, cycle: [1, 2], fill: false }
    }
  },
  len, gainDb, pan, mute, solo
};
```

Scenes deep-copy small pattern/config data but share `sampleId`; they never copy PCM. `machine.tracks` remains the active-scene alias, so `compileWindow` and `PatternView` keep working during migration. Add a scene seed now: probability and random components must use a pure PRNG keyed by seed/loop/track/step so live and offline compiles remain identical. Persist `steps` as a compact bitset and recreate `Uint8Array` on load.

Two contract drifts should be corrected immediately: `CONTRACT.md` pins Transformers 4.2.0 while the worker deliberately pins 3.7.1, and `CONTRACT-PATTERN.md` calls `setMachine` a full re-render although the implementation builds DOM once and syncs values in place. A versioned format cannot rest on contradictory specifications.

## 2. Performance

1. **Decoded-audio memory is a present 10-minute problem.** At 48 kHz stereo, the source `AudioBuffer` is 219.7 MiB and `project.mono` is another 109.9 MiB. Each spectrogram or first beat-analysis run adds a 109.9 MiB transferred copy. The retained spectrogram magnitudes and RGBA canvas are 31.25 MiB each; its paint briefly adds another 31.25 MiB. Three views independently build peak pyramids totaling about 11 MiB. The steady source view is therefore roughly 400 MiB before a render, track samples, or model; `renderedBuffer` adds another 220 MiB. Eight maximum stereo track samples add 88 MiB, and `Sequencer`'s cached `AudioBuffer`s can duplicate that. Keep Float32 for the active decoded source—Web Audio requires it—but store cold assets as PCM16 WAV and decode active-scene assets through an LRU budget.

2. **Loudness is the worst main-thread stall today.** `measureLoudness` allocates a `Float64Array(length + 1)`: 220 MiB at this scale. Its true-peak estimate performs three phases × eight taps × 57.6 million stereo samples, about 1.38 billion multiply-adds, synchronously. RENDER measures both before and after processing. Move measurement to a worker, calculate block energies with rolling 100 ms/400 ms/3 s accumulators instead of a full-length prefix, and use a fixed polyphase loop without per-sample clamping calls.

3. **Denoise will exhaust memory before WASM speed matters.** One 10-minute channel produces about 112,500 STFT frames; `magDb` alone is roughly 220 MiB. Input, padded signal, overlap-add output, window-sum buffer, and final output coexist, putting the worker near 700–800 MiB per channel. Redesign it as a two-pass, time-tiled worker: derive the small noise profile first, then process bounded overlapping tiles directly to the destination. This is mandatory before advertising long-file denoise.

4. **Repeated analysis is measurable and avoidable.** `waveMini`, `waveMain`, and `SliceView` each scan all 28.8 million samples to build the same pyramid on the main thread. Build one immutable `PeakPyramid` per source and share it. Spectrogram work is capped at 8,000 FFT columns, so its CPU cost stops growing with duration, but it still recopies the whole mono buffer and recomputes after every reopen. Beat onset analysis is uncapped (about 56,000 1024-point FFTs). Persist all three derived products by source ID and algorithm version; the current sequential spectrogram-then-beat policy is otherwise correct.

5. **Pattern DOM and sequencer GC are not current bottlenecks.** `PatternView` creates its tree once. `setMachine` does at most 128 cell syncs plus mixer controls, but `main.js` calls it for every slider input and several handlers then sync the same cell again. Stop the full sync for local intents; expose targeted row/cell updates and reserve `setMachine` for scene/load changes. `compileWindow` allocates roughly eight prepared objects plus a small event array 40 times per second—hundreds, not millions, of objects per second. Leave it alone until LOCK profiling proves GC pauses; native source-node creation per hit is unavoidable.

6. **Startup is secondary.** The initial graph is 24 local modules and about 262 KiB uncompressed, with only three dependency levels; workers are lazy. The external Google Fonts stylesheet/weights are the larger cold waterfall and the only non-model network dependency. Keep modules unbundled. Self-host two variable fonts later for reliable offline startup; do not add a build pipeline to save a few local HTTP/2 requests.

## 3. WASM/SIMD

Do not port the FFT, beat tracker, or denoise wholesale now. Workers already isolate JS CPU, beat tracking is small, and no `SharedArrayBuffer` means WASM adds a JS-to-linear-memory copy while remaining single-threaded. A claimed 2–4× arithmetic gain does not fix the 110 MiB worker copies, repeated source scans, 220 MiB loudness prefix, or denoise's full time-frequency matrix.

CONFORM already justifies a prebuilt WASM artifact for Signalsmith. Establish loading, SIMD feature detection, and scalar fallback there. After the tiled denoise/shared-cache work, benchmark worker stages on 10-minute fixtures. Only if FFT still owns over half a stage and a small C SIMD kernel is at least 2× end-to-end should it replace `fft.js`; keep the JS implementation as fallback. AssemblyScript adds a second language without a numerical-library advantage. UNMIX is a separate ONNX/WebGPU system; a single-threaded WASM FFT will not make its model fallback acceptable.

## 4. OPFS persistence design

Use immutable media and generation-addressed JSON:

```text
/yellowjacket/projects/<uuid>/
  manifest.json
  state/00000042.json
  media/source/<asset-id>.<original-ext>
  media/samples/<asset-id>.wav
  media/renders/<asset-id>.wav
  media/stems/<asset-id>.wav
  cache/<source-id>/peaks-v1.bin
  cache/<source-id>/spectrogram-v1.bin
  cache/<source-id>/beatmap-v1.bin
```

`manifest.json` contains `formatVersion`, project UUID/name, created/updated times, head revision, and asset metadata. A state JSON contains words/deletion and gap-cut flags, rack config, clips, eight scenes, asset references, and selected source—never PCM, `AudioBuffer`, worker state, or derived arrays. Keep imported source bytes exactly as received; generated sources/renders are PCM24 WAV. Pad samples, conform cache, and stems are cold PCM16 WAV; decode only the source and active scene. Binary caches have a tiny header containing source ID, sample rate, dimensions, and algorithm version and are always disposable.

On every mutation, debounce autosave for 1.5 seconds with a 10-second maximum during continuous gestures; save immediately after media creation and on `visibilitychange`/`pagehide`. Write immutable media first, then `state/<next>.json`, close it, and finally replace the small manifest head pointer. A crash therefore leaves the prior revision valid; retain the last two states and garbage-collect unreferenced assets only after a successful head update. Use `navigator.locks` per UUID, request persistent storage from a user gesture, and refuse writes that exceed `navigator.storage.estimate()` budget.

Migrations are pure sequential functions keyed by `formatVersion`; migrate JSON only, never rewrite media. Unknown newer versions open read-only. Cache versions are independent, so DSP/analysis changes invalidate a file rather than migrate it. This format accommodates LOCK metadata, CONFORM products, LIVE resamples, and UNMIX stems without another layout change.

## 5. Testing

Replace `scratch/test_pattern.mjs` with `test/run.mjs` plus `test/fixtures/*.json`. Add a dependency-free `package.json` containing only `"type": "module"` so the one command is `node test/run.mjs`; no runner or build step is required. The runner imports production modules directly, executes named async test functions, prints one line per group, and exits nonzero on the first `node:assert/strict` failure.

Lock three suites: (1) BS.1770 48 kHz coefficients at `1e-4`, silence, a generated tone, a gated loud/quiet program, and an intersample-peak vector whose golden values were produced once by pyloudnorm/ffmpeg; (2) deterministic click/envelope fixtures for 120 BPM accuracy, beat mean error, anchors, low-confidence behavior, and repeat-identical results; (3) the current straight/swing/polymeter/mute/solo/window-boundary compiler cases, plus JSON golden event lists and live/offline equality. Generated PCM keeps the repository small; committed golden numbers make external tools unnecessary at test time. Every future schema migration and LOCK component adds a fixture before shipping.
