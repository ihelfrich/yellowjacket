# Ledger · transcription (whisper worker, resampler, transcript UI)

Date 2026-09-03. Companion to `docs/lab/2026-09-03-memory-scout.md`.
Files audited: `js/transcribe.js` (245 lines), `workers/whisper-worker.js` (194),
`js/dsp/resample.js` (78), `js/transcript-ui.js` (515), plus the call site in
`js/app/bench-controller.js:191-226` and the runtime fields in
`js/app/source-controller.js:114-115`. Read as line ranges; source not edited; tests not run.

Reference case "Traum": 218 s, 48 kHz stereo, decoded at the 96 kHz context, so the
mono the bench hands to transcription has F = 218 × 96 000 = 20 928 000 frames
(`R.mono = engine.mono`, `R.sampleRate = engine.sampleRate`, source-controller.js:114-115;
the bench passes exactly those two at bench-controller.js:208).

Evidence classes used below:
- **fact** — read in this repo's code, or a file size returned by the HF Hub API on 2026-09-03.
- **inference** — follows from library architecture (transformers.js 3.7.1 and its bundled
  onnxruntime-web are CDN-loaded; whisper-worker.js:6; no copy exists on this machine, so
  nothing inside them was read) or from platform behaviour (WebAssembly.Memory has no shrink).

---

## 1. The data path, end to end (fact unless marked)

1. `btnTranscribe` click → `transcriber.loadModel(modelId)` only if the model changed or
   `!transcriber.modelLoaded` (bench-controller.js:200-202). The worker is created lazily on
   the first `loadModel`/`transcribe` (`_ensureWorker`, transcribe.js:100-112); a session that
   never transcribes never pays for the worker.
2. `Transcriber.transcribe(mono, sampleRate)` (transcribe.js:80-93):
   `const copy = mono.slice()` at :86 — a full Float32 copy of the context-rate mono — then
   `postMessage({...mono: copy...}, [copy.buffer])` at :91. The buffer is **transferred**, so the
   main-thread ArrayBuffer is detached in the same tick; the copy exists so `engine.mono`
   survives. Net main-thread residency after the call: zero. Net process residency: the
   same bytes now live in the worker.
3. Worker `handleTranscribe` (whisper-worker.js:116-167): `native` = the transferred array
   (:120); `audio = resample(native, inRate, 16000)` (:124) allocates a **second** array at
   16 kHz (resample.js:50 `new Float32Array(outLen)`); if `inRate === 16000` no copy is made
   (:124) — but the bench never sends 16 kHz because `R.sampleRate` is the context rate.
4. `asr(audio, {chunk_length_s: 30, return_timestamps: 'word', ...})` (:148). The whole
   16 kHz array is handed to the pipeline; the worker does no chunking of its own. The
   pipeline's chunk/stride (30 s / 5 s) is only *mirrored* in the worker for progress
   arithmetic (:11-12, :132).
5. Result: `words` (text + start/end) posted back (:166); no audio returns. Main thread
   `_assemble` (transcribe.js:200-244) builds the final word objects; bench stores them at
   `store.update('words', ...)` (bench-controller.js:210-216) and hands the same array to
   `TranscriptView.setWords` and `sliceView.setWords` (:218-219).
6. Nothing in transcribe.js, the worker, or the UI holds PCM after step 4 returns. The only
   PCM references are locals of `handleTranscribe` and the suspended `onmessage` frame.

---

## 2. Allocation table (Traum, F = 20.9 M frames)

| # | Allocation | Formula | Bytes (Traum) | Where | Allocated | Released | Holder |
|---|---|---|---|---|---|---|---|
| A1 | main-thread transfer copy | F · 4 | 83 712 000 | js/transcribe.js:86 | on `transcribe()` | detached at :91 in the same tick (ownership moves to worker) | none on main after :91 |
| A2 | worker `native` (the transferred A1) | F · 4 | 83 712 000 | workers/whisper-worker.js:120 | message receipt | when `handleTranscribe` returns (after the whole inference) — conservatively pinned by the suspended `onmessage` frame (:172-181) and the `native` local across `await asr(...)` (:148); V8's generator-liveness analysis *may* free it earlier (inference, unverified) | `msg.mono` / `native` locals |
| A3 | 16 kHz copy | (D · 16000) · 4 = F/6 · 4 | 13 952 000 | js/dsp/resample.js:50 | inside `resample()` | when `handleTranscribe` returns; held by `audio` (:124) for the duration of `asr()` | `audio` local; pipeline's per-chunk views (inference: subarray views, not copies) |
| A4 | Kaiser kernel table | (HALF_WIDTH·PHASES + 1) · 8 = 81 921 · 8 | 655 368 per distinct cutoff | js/dsp/resample.js:31, cached at :41 | first resample at a given input rate | **never** — module-level `kernelCache` Map (:22) in the worker's module scope; one entry per source rate (96k→16k cutoff 0.075; 48k 0.15; 44.1k 0.163) | `kernelCache` |
| A5 | WebGPU warm-up input | 16000 · 4 | 64 000 | workers/whisper-worker.js:106 | during `handleLoad` on webgpu | after the warm-up call | none |
| A6 | model weights — **default base.en, WebGPU path** (`encoder fp32` + `decoder_model_merged q4`, :63-70) | Σ file sizes | **206 188 009** download; resident ≥ that (see §4) | workers/whisper-worker.js:63-66, :104 | on `loadModel` | on next `loadModel` of a *different* model via `asr.dispose()` (:78-82) — but never returned to the OS (§4, §5) | module `asr` (:14) → ORT sessions |
| A6′ | model weights — small(.en), WebGPU | | **586 209 938** download | same | same | same | same |
| A6″ | model weights — WASM fallback (`q8`, :69) | | tiny 40.8 MB · base 76.9 MB · small 249.0 MB | same | same | same | same |
| A7 | ORT wasm-heap high-water mark from session creation | ≈ 1×–3× the largest single model file, transiently; never shrinks | base.en: ≥ 124 MB, plausibly ~250–370 MB; small: ≥ 353 MB, plausibly ~0.7–1.05 GB | inside the CDN library (not readable here) | on `loadModel` | **never** while the worker lives (WebAssembly.Memory cannot shrink; the worker is never terminated) | the worker's `WebAssembly.Memory` |
| A8 | per-chunk inference transients (log-mel 80×3000 fp32 = 0.96 MB; encoder attention scores heads·1500²·4 per layer: tiny 54 MB / base 72 MB / small 108 MB if unfused; cross-attn KV 2·L·1500·d·4: tiny 18.4 MB / base 36.9 MB / small 110.6 MB; self-attn KV ≤ 2·L·448·d·4) | see cell | base.en: order 100–150 MB peak per chunk, 11 chunks sequential | library | per chunk | per chunk (inference) — on WASM these land in the wasm heap and raise its HWM permanently; on WebGPU they land in ORT's GPU buffer pool, which retains freed buffers for reuse (inference) | ORT allocators |
| A9 | word objects | n_words · ~150 B + one `<span>` per word (transcript-ui.js:225-226 `_wordEls`, `_gapEls`) | ~0.1–0.3 MB for a few hundred words | js/transcribe.js:200-244; js/transcript-ui.js:223-226 | on result | on next `setWords` / file change | `store.project.words`, `TranscriptView._words`, `sliceView` |
| A10 | transcript undo snapshots | ≤ UNDO_CAP(100) · 2 · n_words · 8 B (`del`/`gap` boolean arrays, transcript-ui.js:361-364) | ≤ ~1 MB for 600 words | js/transcript-ui.js:356-366 | on each edit | oldest shifted at :365 | `TranscriptView._undo` |
| A11 | worker download-progress map | one small object per model file | < 1 KB | workers/whisper-worker.js:20 | on load | `files.clear()` on next load (:96, :114) | `files` |

Peak added by one Traum transcription with the default model on WebGPU, over and above the
bench's own buffers: A2 + A3 + A8 ≈ 84 + 14 + ~100–150 MB transient, on top of A6 + A7
(≥ 206 MB weights + wasm HWM) which persist for the tab's life. With **small** selected the
persistent part is ≥ 586 MB of weights plus a wasm HWM that plausibly approaches 1 GB. That
combination — a lossless file already resident plus "a larger Whisper model" — is a
sufficient explanation for the ~780 MB "reset" in the scout, without any bug.

---

## 3. The 16 kHz copy — direct answers

- **Where is it made?** In the worker, not on the main thread: resample.js:50, called from
  whisper-worker.js:124. The scout's citation "js/transcribe.js:19" points at the
  `TARGET_RATE` constant only; the linear main-thread resampler it remembers was removed
  (comment at transcribe.js:37-40).
- **Transferred or copied?** The *context-rate* mono is copied once on the main thread
  (A1, :86) and transferred (:91) — so the worker receives 83.7 MB for Traum, six times the
  16 kHz payload, and then makes the 14 MB 16 kHz array itself (A3). Two PCM arrays live in
  the worker during a job: 97.7 MB for Traum.
- **Freed after?** Yes, in the sense that no module-level reference survives
  `handleTranscribe`: module state is exactly `asr, device, loadedModel, busy, files`
  (whisper-worker.js:14-20) plus `kernelCache` (resample.js:22). Both PCM arrays become
  garbage when the function returns. The open question is *when during* the job A2 dies:
  `native` is unused after :124, but it sits in a frame suspended at :148 and in
  `event.data.mono` in the frame suspended at :181. Conservative reading: both PCM arrays
  live for the entire inference (fact: no explicit release; inference: V8 may drop dead
  registers in suspended frames).
- **Upsampling multiplier.** Because the bench sends the *context-rate* mono, Traum's
  transfer is 2× what a 48 kHz decode would send (41.9 MB), and the polyphase filter does
  ~1.12 G multiply-adds (3.49 M outputs × ~321 taps in input samples) instead of ~0.56 G. The
  scout's "decode at native rate" fix halves A1/A2 automatically; no change here is needed
  for that.

---

## 4. The model: dtype per device, download vs resident

**Device selection (fact).** The worker probes `navigator.gpu` inside itself
(whisper-worker.js:98) and tries WebGPU first; any failure at pipeline creation or warm-up
falls back to WASM (:100-119). Chrome on macOS exposes WebGPU in dedicated workers, so on
Ian's machine the WebGPU config is the live one.

**dtype per device (fact, whisper-worker.js:63-70):**
- webgpu → `{ encoder_model: 'fp32', decoder_model_merged: 'q4' }`
- wasm  → `'q8'` for both

transformers.js maps these to file suffixes `encoder_model.onnx`, `decoder_model_merged_q4.onnx`
and `*_quantized.onnx` respectively (inference from transformers.js's dtype→suffix table; the
HF repos carry exactly those files).

**Download bytes per model, HF Hub API, 2026-09-03 (fact):**

| model | label in MODELS (transcribe.js:5-9) | WebGPU: encoder fp32 + decoder q4 | WASM: q8 + q8 | alt WebGPU: encoder fp16 + decoder q4f16 |
|---|---|---|---|---|
| tiny.en_timestamped | "~41 MB" | 32 894 434 + 86 803 045 = **119 697 479** | 10 097 112 + 30 729 881 = 40 826 993 | 16 477 869 + 46 018 154 = 62 496 023 |
| base.en_timestamped (default) | "~77 MB" | 82 451 730 + 123 736 279 = **206 188 009** | 23 159 173 + 53 712 196 = 76 871 369 | 41 270 731 + 68 540 820 = 109 811 551 |
| small.en_timestamped | "~250 MB" | 352 791 798 + 233 418 140 = **586 209 938** | 92 240 508 + 156 794 981 = 249 035 489 | 176 483 570 + 145 776 485 = 322 260 055 |
| base_timestamped | "~77 MB" | 82 451 730 + 123 738 327 = 206 190 057 | 23 159 167 + 53 712 708 = 76 871 875 | (same shape as base.en) |
| small_timestamped | "~250 MB" | 352 791 798 + 233 421 212 = 586 213 010 | 92 240 498 + 156 795 750 = 249 036 248 | (same shape as small.en) |

So the labels are the **WASM** figures (`docs/CONTRACT.md:169` even says "approx WASM-q8 /
WebGPU downloads" and then lists only the WASM numbers). On the path Chrome actually takes,
the default model is 2.7× the label and *small is 2.35× the label — 586 MB*. A user reading
"~250 MB" and picking SMALL on a machine already in swap is the scout's report.

**Why the "q4" decoder is bigger than the q8 one (strong inference from arithmetic).**
transformers.js's q4 export quantises only MatMul weights (MatMulNBits); everything else
stays fp32, including the tied token-embedding / lm_head matrix: vocab 51 864 × d_model × 4 B
= 79.7 MB (tiny, d=384), 106.2 MB (base, 512), 159.3 MB (small, 768). Those are 92 %, 86 %
and 68 % of the respective `decoder_model_merged_q4.onnx` files. `q4f16` halves exactly that
part (68.5 vs 123.7 MB for base). The q8 file quantises the embedding too, hence 53.7 MB.

**Resident vs download (inference — library internals not readable here).**
- ORT-web creates a session from a `Uint8Array` by copying it into the wasm linear memory
  (`_malloc` + `HEAPU8.set`) and calling `OrtCreateSession` on that pointer; the protobuf
  parse then holds tensor data in the ModelProto, and session initialisation copies
  initializers into ORT's allocator before the proto is dropped. Transient peak inside the
  wasm heap is therefore between 1× and 3× the file being loaded (encoder and decoder are
  loaded as separate sessions, so the peak is set by the larger file: 124 MB for base.en,
  353 MB for small).
- **WebAssembly.Memory never shrinks** (platform fact). Freed pages are reused by the wasm
  allocator but stay committed and counted against the renderer. So after loading small on
  WebGPU the worker's wasm heap sits at a high-water mark plausibly between 0.35 and 1.05 GB
  even though the weights themselves now live in GPU buffers.
- On **WebGPU**, steady-state weights ≈ download bytes, as `GPUBuffer`s (fp32 stays fp32; q4
  stays packed 4-bit for MatMulNBits; embeddings fp32). On Apple Silicon these are unified
  memory, attributed to Chrome's GPU process rather than the tab — which matters for *which*
  process the OS pressures and whether the tab-discard heuristic sees it (open question).
- On **WASM**, steady-state weights ≈ download bytes inside the wasm heap (int8 stays int8
  under MLAS kernels; if the QDQ fusion the header comment worries about (:2-5) were to fail
  and fall back to DequantizeLinear, they would inflate to fp32 — 4×). Plus A8's per-chunk
  transients raise the HWM permanently on this path.
- The JS-side `Uint8Array` of each downloaded file (another 1× download) lives until the
  session is created, then becomes garbage; transformers.js also writes it to the Cache API
  (disk, not RAM).

**Warm-up (fact, :103-106):** on WebGPU a 1 s zero buffer is run once so shader compilation
happens at load, not on the first real chunk. Shader modules and pipelines are then cached by
ORT for the worker's life (inference).

---

## 5. Worker lifetime; what is kept between runs

- **Created:** lazily, first `loadModel`/`transcribe` (transcribe.js:100-112).
- **Terminated:** **never.** `transcribe.js` contains no `terminate`, no `dispose`, no unload
  message; the only `terminate()` calls in `js/` are the spectrogram worker
  (js/spectrogram.js:157,195) and the denoise worker (js/dsp/denoise.js:83). The worker
  protocol (whisper-worker.js:172-193) knows only `load` and `transcribe`; there is no
  `unload`. The single `Transcriber` instance is constructed at js/main.js:121 and passed
  into every controller (:172, :527); it lives for the page.
- **Model unloaded:** only as a side effect of loading a *different* model
  (`disposeAsr()`, whisper-worker.js:78-88, called at :95 and on webgpu failure at :112).
  `asr.dispose()` releases ORT sessions (GPU buffers on WebGPU; heap blocks on WASM), but the
  wasm heap's committed size does not fall.
- **Kept between runs (fact):** `asr` (pipeline: two ORT sessions, tokenizer, feature
  extractor), `device`, `loadedModel`, `busy`, `files` (whisper-worker.js:14-20), and
  `kernelCache` (resample.js:22). **Kept by the platform (inference):** the wasm heap HWM,
  ORT's GPU buffer free-list, compiled shader pipelines.
- **Failure paths worth noting:**
  - If the WebGPU attempt fails *after* the fp32/q4 files were pulled into the wasm heap
    (e.g. warm-up throws, :106), `disposeAsr()` frees them but the heap HWM already includes
    them; the q8 fallback then loads on top. Peak = both configurations (inference).
  - `Transcriber._fault` (transcribe.js:158-171) rejects the pending promise but leaves
    `_worker` in place. After a worker `error` event the next click reuses a possibly broken
    worker rather than recreating it. Not a memory leak, a robustness gap.
  - A stale-generation result (bench-controller.js:209) is dropped on the main thread, but
    the worker still runs the job to completion, holding A2 + A3 for a file the user no
    longer has open. Bounded by one job.

---

## 6. Chunking / streaming strategy for long files

- **No streaming of audio to the worker.** The entire mono is copied and transferred in one
  message (transcribe.js:86-91); the worker resamples the entire array before inference
  (whisper-worker.js:124). Memory in the worker is therefore linear in duration at
  4·F + 4·F/6 bytes, on top of whatever the bench holds.
- **Chunking is transformers.js's**, via `chunk_length_s: 30` (:135) with the library's
  default stride 5 s (mirrored at :12). The pipeline walks the 16 kHz array in 30 s windows
  (inference: `subarray` views, so no additional PCM copies), runs the encoder + decoder per
  window sequentially, and merges the word-level timestamps across overlaps. Traum → 11
  windows (:132 arithmetic).
- **No streaming of results.** Words are posted once at the end (:166). Progress during
  inference comes from `chunk_callback` (:139-145) if the library honours it, else from the
  wall-clock estimate in `Transcriber._startEstimate` (transcribe.js:174-193).
- Consequence for very long files: a 2 h file at 96 kHz would transfer 2.76 GB and allocate a
  460 MB 16 kHz copy before inference began. The bench would already have died on the
  decode, so transcription is not the binding constraint — but it multiplies whatever the
  bench already holds by ~1.17 during a job.

---

## 7. Leaks / never-released (with evidence)

1. **Model + ORT arenas + wasm HWM are never returned.** Evidence: no `terminate` in
   transcribe.js; no unload message type in whisper-worker.js:180-186; `Transcriber` has no
   dispose method (transcribe.js:41-245 read in full). Not growth-per-run — a plateau that
   persists from the first transcription to page unload. For SMALL on WebGPU that plateau is
   ≥ 586 MB plus the heap HWM.
2. **Wasm heap high-water mark from session creation** (inference on ORT-web + platform
   fact that wasm memory cannot shrink). Set at `pipeline(...)` (whisper-worker.js:104, :117)
   and raised again by the failed-webgpu-then-wasm sequence (:100-119). Only a
   `worker.terminate()` releases it.
3. **`kernelCache` (resample.js:22, :41)** — unbounded Map keyed by cutoff string; in practice
   one 655 KB `Float64Array` per distinct source rate. Bounded growth, not a leak; listed for
   completeness.
4. **Transient double PCM during a job (A2 + A3)** — 97.7 MB for Traum. Released, but its
   release time depends on V8 keeping or dropping `native` across the `await` (open
   question). If the suspended frame pins it, the 96 kHz array is dead weight for the whole
   inference.

No unbounded per-run growth was found in this subsystem's own code. Growth inside the CDN
library (ORT GPU buffer pool, KV-cache disposal per chunk) could not be read and is listed
under open questions.

---

## 8. Quick wins

1. **Terminate the worker after a job (or after N minutes idle), and on file change.**
   Add `Transcriber.dispose()` that calls `this._worker.terminate()`, nulls `_worker`, and
   resets `_modelLoaded/_modelId/_device`; bench-controller.js:200 already reloads when
   `!transcriber.modelLoaded`, so the next click transparently reloads from the Cache API
   (disk, no network). Saving: everything in A6/A7/A8 — ≥ 206 MB (default) / ≥ 586 MB
   (small) plus the wasm HWM. Cost: a few seconds of reload on the next transcribe. Risk:
   low; the protocol already handles a fresh worker. Files: js/transcribe.js (new method,
   ~15 lines), js/app/bench-controller.js:208-226 (call after result; also on `R.generation`
   change), optionally js/app/source-controller.js:183 (file cleared).
2. **Fix the MODELS labels to the WebGPU download sizes (120 / 206 / 586 MB) or make them
   device-aware after `ready`.** Zero bytes saved directly, but it stops a user picking
   "small ~250 MB" that is actually 586 MB. Risk: none. Files: js/transcribe.js:4-10,
   docs/CONTRACT.md:169-176.
3. **Use `q4f16` for the decoder on WebGPU** (keep encoder fp32). Saving: 55.2 MB (base),
   40.8 MB (tiny), 87.6 MB (small) of download and roughly the same in resident weights —
   it is the fp32 embedding matrix that shrinks. Risk: medium-low — needs `shader-f16`
   (available in Chrome on Apple Silicon) and a check that word timestamps from the
   `alignment_heads` cross-attention are unchanged on the test fixtures; the worker header
   says the current config was "verified", so this is a re-verification, not a redesign.
   Files: workers/whisper-worker.js:65.
4. **Also switch the encoder to fp16 on WebGPU.** Further saving: 41.2 MB (base), 16.4 MB
   (tiny), 176.3 MB (small); total for small vs today: 586 → 322 MB. Risk: medium — fp16
   encoders have produced NaN/garbage on some ORT-web builds with Whisper; must be verified
   on this pinned 3.7.1 build before shipping. Files: workers/whisper-worker.js:64-65.
5. **Send 16 kHz, not context-rate, to the worker.** Either resample in segments (send the
   mono in ~30 s slabs with a 160-sample overlap on each side — HALF_WIDTH — and let the
   worker append into one 16 kHz array, freeing each slab), or resample on the main thread
   before transfer (cost: ~1–3 s of main-thread jank for Traum at 96 kHz). Saving: A2 drops
   from 83.7 MB to ≤ a slab (~12 MB) — ~70 MB of transient per job. Risk: medium (seam
   handling in the polyphase filter; the current per-sample `wsum` normalisation at
   resample.js:73-74 hides edge truncation, so slab boundaries need the overlap done
   right). The scout's decode-at-native-rate fix already halves this for free; do that
   first and re-measure before touching the resampler.

---

## 9. Open questions

1. Does V8 release `native` (A2, 83.7 MB) once `audio` exists, or does the suspended
   `handleTranscribe`/`onmessage` frame pin it for the entire inference? Measure with a heap
   snapshot of the worker mid-job.
2. What is the actual wasm-heap high-water mark after loading each model on WebGPU and on
   WASM under the pinned transformers.js 3.7.1 / its bundled onnxruntime-web? Read
   `WebAssembly.Memory.buffer.byteLength` from inside the worker after `ready`.
3. Does ORT-web's JSEP free the CPU-side initializer copies after uploading to GPU, or do
   weights exist twice (heap + GPU) on the WebGPU path?
4. Where does Chrome account WebGPU buffers on Apple Silicon (GPU process vs renderer), and
   does the tab-discard heuristic count them? This decides whether the model or the bench's
   own Float32 buffers is what the discarder sees.
5. Are per-chunk cross-attention KV tensors and encoder attention scores disposed at chunk
   end in transformers.js 3.7.1, or do they persist until the next generate() overwrites
   them? (A8 sizes computed above are per-chunk upper bounds.)
6. Does fp16 encoder + q4f16 decoder reproduce word timestamps on the `_timestamped`
   exports within the test fixtures' tolerance? Gates wins 3–4.
7. Does the 3.7.1 pipeline honour `chunk_callback`? Affects only the progress bar, not memory.

---

## 10. Corrections to the scout

- "a 16 kHz mono copy (js/transcribe.js:19)": the copy is made in the worker
  (js/dsp/resample.js:50 via workers/whisper-worker.js:124). What the main thread makes is
  a full context-rate copy (js/transcribe.js:86) that is transferred, so the worker holds
  both the 96 kHz and the 16 kHz arrays during a job — 97.7 MB for Traum, not 14 MB.
- "the model in the worker (41 MB–250 MB on disk)": those are the WASM q8 figures. On the
  WebGPU path Chrome takes on this Mac the downloads are 120 / 206 / 586 MB (HF Hub API,
  2026-09-03), and the larger q4 decoders are mostly an fp32 embedding matrix.
- "several times that resident, dtype dependent": on WebGPU the weights are about 1× the
  download (fp32 and 4-bit are stored as shipped); the multiplier is the wasm heap's
  high-water mark from session creation, which never comes down because the worker is never
  terminated.
