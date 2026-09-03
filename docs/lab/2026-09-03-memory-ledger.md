# 2026-09-03 · Memory ledger — synthesis

Companion to `2026-09-03-memory-scout.md` (the question and four experiments) and the
seven notes under `ledger/` (one per subsystem, two research). This file adds nothing
the ledgers did not read; it reconciles their numbers, states what is live in the tree
now, and ranks what is left.

Units: MB = 10^6 bytes throughout (the scout's "39.9 MB WAV" is 39.9 MiB = 41.9 MB).
**Reference case "Traum"**: 218 s, 48 kHz, stereo, 16-bit WAV, 41 856 044 B encoded.
Decoded at the 96 kHz context (the tree the ledgers read): F = 20 928 000 frames,
one channel F·4 = 83.71 MB, one AudioBuffer F·C·4 = 167.42 MB. At its own 48 kHz
(the tree that is live now): F = 10 464 000, 41.86 / 83.71 MB.

**fact** = read in code at the cited line (or measured on this Mac); **inference** =
browser/GC/library behaviour not observable from the repo, or a layout size assumed.

## 0. What the ledgers read versus what is live

The subsystem ledgers were written 10:32–10:38 against commit `150a913`. Two commits and
one uncommitted batch landed after that, before this synthesis:

| when | change | ledger items it closes |
|---|---|---|
| `8e61f1f` (10:44) | decode at the file's own rate through an OfflineAudioContext; `planDecodeRate` returns a soft budget (768 MiB, warn) and a hard limit (2 GiB, refuse); `engine.load` throws `over-budget`; the engine no longer copies its input (`fallback()` instead) | engine §1 (halving A1–A3), §6 (overBudget ignored), the 3× encoded copy on the offline branch |
| `4c25009` (10:48) | `R.sourceBytes` is a `SourceHandle` whose bytes are released once autosave has written `source.bin` for the same generation; KEEP/PROJECT OUT read them back | engine §3 (A4 retained for the session) |
| uncommitted (10:52) — scout "Step 4", tests 47 groups / 310 cases | `Transcriber.dispose()` called after every job and on `source`/`source-clear`; MODELS labels show GPU/WASM sizes; old take nulled before a re-render; source loudness cached per generation+repairs; repair rebuild re-points at `R.original` before allocating; harvest worker retired per job; `fitted` map bounded to one key; spectrogram `_img` shrunk at `compute()` and `_dataTex` destroyed on `setData(null)` | transcription §7.1 + quick wins 1–2; rack quick wins 1 and 4; spectrogram quick wins 1 and 3 and leaks L1/L2; machine leak 1 and quick win 6 |

Line numbers below are the ledgers' (tree `150a913`) unless a row says "live". Files
touched since then: `js/audio-engine.js`, `js/dsp/native-rate.js`, `js/app/source-controller.js`,
`js/app/persist-controller.js`, `js/app/source-handle.js`, `js/app/bench-controller.js`,
`js/app/repair-controller.js`, `js/machine/controller.js`, `js/machine/sequencer.js`,
`js/spectrogram.js`, `js/render/spectrogram-gpu.js`, `js/transcribe.js`.

Headline, before the tables:

1. In the worst realistic session the audited tree held **≈ 1 576 MB of fact-resident
   bytes plus ≈ 253 MB inferred ≈ 1 829 MB**, and 60 % of it was WHISPER SMALL EN
   (586 MB of weights on the GPU plus a wasm heap that never shrinks, ≥ 353 MB).
2. With the three biggest quick wins — release the whisper worker, decode at native rate,
   spill the source bytes — the same session is **≈ 330 MB fact + ≈ 166 MB inferred ≈ 496 MB**.
   All three are in the tree now, so Table 2 is also the live tree.
3. The ~780 MB "reset" is over-determined. Steady state with SMALL and a lossless file
   exceeded 1.2 GB on the audited tree; and independently of the model, one full-rack
   RENDER at 96 kHz peaked at 1.3–1.9 GB inside the denoise stage and 1.0–1.3 GB inside
   loudnorm. Either alone crosses the line. The discard mechanism itself is still
   unreproduced (experiment E1).
4. What is left is transient, not resident: loudnorm and denoise scratch, the WAV export
   block, the idle loudness worker's copy, and — with SMALL — a 1.2–1.4 GB window while
   a transcription runs that only a dtype change can shrink.

## 1. Table 1 — resident set, audited tree (`150a913`), 96 kHz context

Session: Traum loaded, spectrogram drawn on the GPU path, transcribed with WHISPER SMALL
EN on WebGPU, HARVEST seated eight tracks, one RENDER, RACK tab visible with live
preview, playing. Steady state — transients are in §3.

| # | allocation | formula | MB | lives in | allocated → released; holder | cite |
|---|---|---|---|---|---|---|
| **Source** | | | | | | |
| 1 | decoded AudioBuffer | F·C·4 | 167.42 | renderer, PartitionAlloc (V8 external) | `engine.load` → next load / `clear` / `clearSource`; `engine._buffer`, `R.buffer` | audio-engine.js:71; source-controller.js:113 |
| 2 | mono mixdown | F·4 | 83.71 | renderer | with #1; `engine._mono`, `R.mono`, `R.peaks.mono`, waveMini/waveMain/waveRack `.mono` (references, never copied) | audio-engine.js:355; waveform.js:69 |
| 3 | peak pyramid | 8·(⌈F/64⌉+⌈F/512⌉+⌈F/4096⌉) | 2.98 | renderer | source-controller.js:121 → :189; `R.peaks`, each view's `_pyr` | peaks.js:31-52 |
| 4 | encoded source bytes | byteLength | 41.86 | renderer | `ab.slice(0)` at load → `clearSource` only; never dropped after the OPFS write | source-controller.js:85; persist-controller.js:180 |
| | *subtotal source* | | **295.98** | | | |
| **Spectrogram** | | | | | | |
| 5 | STFT matrix `_mags` (dB, f32) | cols·bins·4, cols = min(⌊(F−2048)/512⌋+1, 8000), bins 1024 | 32.77 | renderer | worker → transferred → `this._mags` until next `compute()`; kept on the GPU path for re-upload/demotion | spectrogram-worker.js:39; spectrogram.js:200 |
| 6 | GPU data texture `_dataTex` (r32float) | bins·cols·4 | 32.77 | GPU process (unified memory) | `setData` → replaced on next upload or `destroy()`; on the audited tree NOT on `setData(null)` | spectrogram-gpu.js:264-279 |
| 7 | 2D image canvas `_img` | cols·bins·4 | 0 (GPU path; 32.77 on the 2D path) | renderer/GPU | shrunk to 1×1 while GPU is live | spectrogram.js:407-414 |
| 8 | phosphor ping-pong (2 × rgba16float) | 2·w·h·8 at device px | 23.04 *inf.* (2400×600) | GPU process | while playing + 250 ms | spectrogram-gpu.js:454-458 |
| 9 | `#specGpu` swapchain | 2–3 × w·h·4 | ≈17 *inf.* | GPU process | for the page | spectrogram.js:330 |
| | *subtotal spectrogram* | | **65.54 fact + ≈40 inf.** | | | |
| **Waveform** | | | | | | |
| 10 | 3 views × (visible + offscreen) canvas | 2·w·h·4 per view | ≈23 *inf.* (dpr 2) | renderer/GPU | for the page; kept at last size while hidden | waveform.js:22, :166 |
| **Transcription (SMALL EN, WebGPU)** | | | | | | |
| 11 | model weights (encoder fp32 352.79 + decoder q4 233.42) | Σ file sizes (HF Hub API) | 586.21 | GPU process (GPUBuffers) | `pipeline()` on load → only on `asr.dispose()` for a different model; the worker is never terminated | whisper-worker.js:63-66, :104 |
| 12 | ORT wasm heap high-water mark | ≥ largest single file loaded (1×–3× *inf.*) | ≥ 352.79 | renderer (worker `WebAssembly.Memory`) | set at session creation; never shrinks (platform fact) | whisper-worker.js:104 |
| 13 | Kaiser kernel table (per source rate) | 81 921·8 | 0.66 | worker module | first resample → never (`kernelCache`) | resample.js:22, :41 |
| 14 | words + spans + transcript undo | n_words·~150 B + DOM + ≤100·2·n·8 | ≈0.2 | renderer | until next `setWords` | transcribe.js:200-244; transcript-ui.js:225, :361 |
| | *subtotal transcription* | | **939.86** | | | |
| **Machine after HARVEST (8 × 1.2 s stereo)** | | | | | | |
| 15 | track slices `track.sample.channels` | 8 × C·1.2·SR·4 | 7.37 | renderer | on harvest → user clear; also pinned by `historyPcm` for ≤ 60 undo docs | machine/controller.js:483; persist-controller.js:366 |
| 16 | sequencer forward AudioBuffers (mirror) | Σ C·n·4 | 7.37 | renderer | first trigger/prebake → `bumpTrack` | sequencer.js:133 |
| 17 | harvest worker FFT tables + isolate | FFT(2048)+FFT(16384)+hann | 0.16 (+ isolate *inf.*) | worker | first harvest → never on the audited tree | harvest.js:188 |
| 18 | analysis envelope cache + main copy | (⌊(F−1024)/512⌋+1)·4 ×2 + onsets | 0.33 | worker + renderer | per generation | analysis-worker.js:67; source-controller.js:242 |
| | *subtotal machine* | | **15.23** | | | |
| **Render (one RENDER)** | | | | | | |
| 19 | `R.renderedBuffer` | F·C·4 | 167.42 | renderer | render → next render / new source / clear; `engine._alt` while A/B='b'; stays resident when STALE; a flat rack without cuts returns the input buffer (chain.js:152-169), so a RENDER is not always a second buffer | bench-controller.js:610, :641 |
| 20 | `renderedMono` | F·4 | 83.71 | renderer | with #19; also waveMain ghost, waveRack ghost | bench-controller.js:613, :662, :520 |
| 21 | `renderedPeaks` | 0.1426·F | 2.98 | renderer | with #20 | bench-controller.js:614 |
| 22 | loudness worker's transferred copy | F·C·4 | 167.42 *inf. lifetime* | worker | per measure → unreachable after `done`, collected at the worker's next GC (never terminated) | bench-controller.js:309, :336-340; loudness-worker.js:19-24 |
| | *subtotal render* | | **254.12 fact + 167.42 inf.** | | | |
| **Live preview (RACK visible)** | | | | | | |
| 23 | ghost mono (13 s window; subarray keeps the whole array) | 13·SR·4 | 4.99 | renderer | per preview → replaced by the next | bench-controller.js:544-547; waveform.js:89 |
| 24 | ghost pyramid (12 s) | 0.1426·12·SR | 0.16 | renderer | with #23 | waveform.js:93 |
| **Everything else** | | | | | | |
| 25 | undo documents (JSON, no PCM) | ≤ 60 × 0.1–0.5 MB | ≈10 *inf.* (≤ 30) | renderer (V8 heap) | every `store.update` → rotate past 60 / `clearHistory` | project-store.js:225-227; persist.js:132-166 |
| 26 | idle worker isolates (analysis, harvest, loudness, whisper) | ~3 MB each *inf.* | ≈12 *inf.* | renderer | never terminated on the audited tree | source-controller.js:226; machine/controller.js:969; bench-controller.js:309; transcribe.js:100 |
| | **Total, fact rows** | | **1 575.9** | | | |
| | **Total, inferred rows** (8, 9, 10, 22, 25, 26) | | **≈ 252.7** | | | |
| | **Total** | | **≈ 1 829** | | | |

Where it sits: ≈ 659 MB of the total (rows 6, 8, 9, 11) is GPU-process memory on Apple
Silicon's unified pool; the renderer-attributed part is ≈ 1 170 MB. Whether Chrome's
discarder or macOS's pressure signal sees the GPU share is experiment E4.

## 2. Table 2 — the three biggest quick wins applied (= the live tree)

The three biggest by steady-state MB in this session: (a) release the whisper worker after
each job (−939.9), (b) decode at the file's own rate (−264.3: source, render, kit and ghost
rows all halve), (c) spill the encoded bytes to OPFS (−41.9). Uint8 quantisation of the
STFT matrix would beat (c) by 7 MB but is unshipped and medium-risk; (c) is shipped.
Only rows that change are annotated.

| # | allocation | MB (96 kHz, Table 1) | MB after | note |
|---|---|---|---|---|
| 1 | decoded AudioBuffer | 167.42 | 83.71 | native 48 kHz via OfflineAudioContext (live: audio-engine.js:74-76) |
| 2 | mono | 83.71 | 41.86 | |
| 3 | pyramid | 2.98 | 1.49 | |
| 4 | encoded bytes | 41.86 | ≈0 | `SourceHandle.spill()` once `source.bin` is written (live: persist-controller.js:187); stays resident when `opfs` is null (Safari) |
| 5–6 | `_mags` + `_dataTex` | 65.54 | 65.54 | unchanged: cols is capped at 8000 for any clip > 85.4 s at 48 kHz |
| 8–10 | phosphor, swapchain, waveform canvases | ≈63 *inf.* | ≈63 *inf.* | layout-bound, rate-independent |
| 11–13 | SMALL weights, wasm HWM, kernel | 939.66 | 0 | worker terminated in `finally` after the job and on source change (live: bench-controller.js:24-36, :248); the model is back for the next job (§3) |
| 14 | words | 0.2 | 0.2 | |
| 15–16 | kit slices + sequencer mirrors | 14.75 | 7.37 | slices cut at `buf.sampleRate` |
| 17–18 | harvest tables, analysis cache | 0.49 | 0.49 | (harvest worker is retired per job on the live tree: −0.16 and its isolate) |
| 19–21 | rendered take + mono + peaks | 254.12 | 127.06 | |
| 22 | loudness worker idle copy | 167.42 *inf.* | 83.71 *inf.* | still never terminated |
| 23–24 | ghost mono + pyramid | 5.16 | 2.58 | |
| 25 | undo docs | ≈10 *inf.* | ≈10 *inf.* | |
| 26 | idle isolates | ≈12 *inf.* | ≈9 *inf.* | whisper's gone |
| | **Total, fact rows** | 1 575.9 | **330.3** | |
| | **Total, inferred rows** | ≈252.7 | **≈166.0** | |
| | **Total** | ≈1 829 | **≈ 496** | |

What does not shrink and why: the STFT matrix and its texture (65.5 MB) are bounded by
`maxCols = 8000`, not by F; the canvases are bounded by layout; the loudness worker's copy
and the undo documents are lifetime questions, not size questions.

## 3. Transient peaks — what actually crosses 780 MB

Steady state was never the whole story. These are the events that add a multiple of F on
top of the resident set; "audited" = Table 1 tree at 96 kHz, "live" = Table 2 tree at 48 kHz.
Resident base for the render rows: audited ≈ 1 317 MB fact (Table 1 without rows 19–24);
live ≈ 200 MB (rows 1–6, 15–18).

| event | above-base, audited (96 kHz) | peak, audited | above-base, live (48 kHz) | peak, live | after the remaining wins (§4) |
|---|---|---|---|---|---|
| RENDER, denoise stage (main input+output+result 418.5; worker 586.7 per channel, ×2 if channel 0's scratch is uncollected) | 1 005–1 592 | 2.3–2.9 GB | 503–796 | 703–996 | 200 + 209 + 167 = **≈ 577** |
| RENDER, loudnorm corrective pass (input + gained + limited1 + corrected + limited2 + 2·F·4) | 670 guaranteed / 1 004 lexical | 2.0–2.3 GB | 335 / 502 | 535–702 | 200 + 251 = **≈ 451** |
| RENDER, any other stage (input + output + scratch) | 335–502 | ≈1.7 GB | 167–251 | 367–451 | unchanged |
| re-RENDER (old take held through the pipeline) | +254 | | 0 (dropped first, live) | | — |
| first RENDER's `before` measurement copy | +167 transient | | +84 once per generation (cached, live) | | — |
| repair rebuild, 2nd+ (original + previous + new pair, + STFT recompute 117) | 753 + 117 | ≈2.2 GB | 251 + 75 (previous pair released first, live) | ≈ 526 | — |
| WAV export, 32-bit float (ArrayBuffer + Blob copy *inf.*) | +335 | | +167 | | +0 with streaming export |
| TRANSCRIBE with SMALL (weights 586 + wasm HWM ≥ 353 + native mono + 16 kHz + per-chunk ≈ 220) | +1 243 | | +1 201 | **≈ 1.4 GB during the job** | 586 → 322 MB weights with fp16 + q4f16 (E10 gates it) |
| .yjkt import (zip + readBundle slice + parseProjectEntries slice + sourceBytes) | 4× encoded = 167 | | 167 | | 3× = 126 |
| `loadFromUrl` streaming (parts + buf + sourceBytes) | 3× = 126 | | 126 | | 2× = 84 |
| analysis / harvest worker payload (`R.mono.slice()`, transferred) | +84 each | | +42 each | | +21 with decimation (only matters for > 48 kHz sources now) |

The two observations that matter: (i) on the audited tree a plain RENDER of Traum with
DENOISE or LOUDNORM in the rack was a 2 GB event whichever model was loaded, and a
transcription with SMALL was a 1.2 GB event before the render; (ii) on the live tree the
render peaks sit at 0.5–1.0 GB and the SMALL job still sits at 1.4 GB. The next MB come
from inside `js/dsp/`, not from the store.

## 4. Ranked interventions

Score = MB saved ÷ risk weight (low 1 · low-medium 1.5 · medium 2 · medium-high 3 · high 4).
MB is the 96 kHz reference figure the ledgers computed; the 48 kHz figure (live tree)
follows in parentheses where it differs. "peak" = transient during an operation;
"steady" = resident. Every entry names the test that proves it; none has been run here.

### 4A. Remaining

| rank | intervention | MB (96k → 48k) | kind | risk | score | files | proof |
|---|---|---|---|---|---|---|---|
| 1 | **Loudnorm: null `gained` after the first limiter, apply the corrective gain in place on `limited`, null it before the second limiter** | 335 guaranteed, 502 lexical (168 / 251) peak | quick win | low | 335 | js/dsp/loudnorm.js:63-84 | test/run.mjs loudnorm group: integrated LUFS and true peak of the fixture identical to 0.01 LU / 0.01 dB before and after; DevTools heap timeline on a loudnorm-only render of Traum shows peak-above-baseline ≤ 4 buffers |
| 2 | **Denoise worker: wssP as a function (constant 1.5 in the interior, per its own comment), divide in place into `outP` and transfer with byteOffset, drop `samples` after `padded`** | 251 per channel, 503 with GC lag (126 / 251) peak | quick win | low-medium | 167 | workers/denoise-worker.js:63-181; js/dsp/denoise.js:74-78 | denoise test group: max |diff| vs current output = 0 over the whole fixture including the first and last N_FFT samples; worker row in chrome://task-manager peaks ≤ 4 channel-units on a denoise-only render |
| 3 | **Terminate the loudness worker after each job** (or on an idle timer) | 167 *inf.* (84) — the transferred copy it holds until its next GC | quick win | low | 167 | js/app/bench-controller.js:309-341 | after MEASURE the worker row disappears from the task manager; a second MEASURE is within 150 ms of the first (spawn cost) |
| 4 | **Stream the WAV export to disk** via showSaveFilePicker + WritableStream, Blob path as fallback | 335 (167) peak for 32f | quick win | medium | 167 | js/export.js:71-171, :225-236; js/app/bench-controller.js:671-727 | sha256 of the streamed file equals the Blob path's for 16/24/32f on the fixture; the RangeError guard at bench-controller.js:707 becomes unreachable |
| 5 | **fp16 encoder on WebGPU** | 176 (small) / 41 (base) steady-during-job + download | quick win | medium | 88 | workers/whisper-worker.js:63-66 | transcription fixtures: word timings within the existing tolerance; warm-up output finite; fp32 retry path exercised by forcing a throw |
| 6 | **Cut the redundant encoded copies** — `parts.length = 0` after concatenation in `loadFromUrl`; pass `value.buffer` through in `parseProjectEntries` when the view spans it | 84 (2 × 41.9) peak | hygiene | low | 84 | js/app/source-controller.js:344-366; js/app/project-bundle.js:263, :269 | bundle round-trip test: parsed source has byteOffset 0 and equals the input bytes; a mocked streaming fetch asserts `parts.length === 0` before `loadArrayBuffer` resolves |
| 7 | **Null `native` / `msg.mono` before `await asr()`** in the whisper worker | 84 *inf.* (42) peak during inference, if V8 pins the frame | hygiene | low | 84 | workers/whisper-worker.js:120-148 | worker heap snapshot mid-job (E9) shows one live Float32Array (16 kHz), not two |
| 8 | **q4f16 decoder on WebGPU** (the fp32 token-embedding matrix is what shrinks) | 88 (small) / 55 (base) steady-during-job + download | quick win | medium-low | 58 | workers/whisper-worker.js:65 | same fixture check as rank 5; needs `shader-f16` |
| 9 | **Send 16 kHz slabs to the whisper worker** (30 s + 160-sample overlap) instead of the whole context-rate mono | 70 (28) peak | quick win | medium | 35 | js/transcribe.js:80-93; workers/whisper-worker.js:116-148; js/dsp/resample.js | resampled output from slabs equals whole-array resample to 1e-6 at every seam; words identical on fixtures |
| 10 | **Decimate mono to ≤ 48 kHz before the harvest/analysis `postMessage`** | 42 each (0 for ≤ 48 kHz sources now; matters for 96/192 kHz) peak | quick win | low-medium | 28 | js/machine/controller.js:1022; js/app/source-controller.js:263; js/analysis/harvest.js:52 | harvest/analysis fixtures: onset times within ±1 hop (10.7 ms), same picks; AC_FRAME back at its tuned 186 ms |
| 11 | **Quantise `_mags` to Uint8 (CPU) and r8unorm (GPU)** | 49 steady on the GPU path (24.6 on 2D) | quick win | medium | 25 | workers/spectrogram-worker.js:39, :61-65; js/spectrogram.js:418-441; js/render/spectrogram-gpu.js:266 | 2D canvas pixels identical to the f32 path on the fixture (the LUT is already 256 entries); GPU frame compared by screenshot diff |
| 12 | **Phosphor targets at half resolution or rgba8unorm** | 17 *inf.* while playing | quick win | low | 17 | js/render/spectrogram-gpu.js:454-458, :232, :352-360 | visual check of decay trails; texture bytes read from `_ensurePhosphor` sizes |
| 13 | **`store.clearHistory()` on `openFile`** (restore and import already do) | ≤ 30 docs + stale `historyPcm` sample refs (≈ 10 typical) | hygiene | low | 10 | js/app/source-controller.js:101-122; js/app/project-store.js:197 | after a source swap `store._past.length === 0`; a cleared machine sample is not reachable from `historyPcm` |
| 14 | **Skip `sampleBytes` for assets already in `samplesWritten`** | 7 per autosave (kit-sized) peak | hygiene | low | 7 | js/app/persist.js:73-83, :151; js/app/persist-controller.js:184-193 | serializeProject with a written-set argument allocates no f32 copies for written ids (count `sampleFiles`); OPFS contents unchanged |
| 15 | **Null `modalFit` / `synthPcm` in `resetForSource`** | ≤ 3.5 | hygiene | low | 3.5 | js/machine/controller.js:837-843, :1129, :1246 | after a source load both closures are null and `modalRate` cannot go stale |
| 16 | **Mono slices for harvest-seated drum tracks** (crate already persists `channels[0]` only) | 3.7 (kit) steady, halves rows 15–16 | quick win | medium | 1.8 | js/machine/controller.js:472-486 | audible check on stereo material; gate by role or opt-in |
| 17 | **Seed `bytesGeneration = R.generation` after a validated RESUME** | 0 RAM; −42 MB OPFS write per resume | hygiene | low | — | js/app/persist-controller.js:29, :435-488 | after RESUME the first autosave does not call `writeBytes('source.bin')` (spy); the size check at :427 still guards it |
| 18 | **Discard-aware restore**: checkpoint on `visibilitychange`→hidden; on load, `document.wasDiscarded` (Chrome) or an own "was open" marker (Safari) triggers the existing validated restore without the RESUME click | 0; resilience | correctness | low-medium | — | js/app/persist-controller.js:123-156, :403-490 | E1: after a forced discard the page returns with the same SHA and position and no click |
| 19 | **Model-aware budget**: subtract the loaded model's bytes (and the wasm HWM once measured) from `DECODE_BUDGET_BYTES`; tier by `navigator.deviceMemory` | 0; correctness | correctness | low | — | js/dsp/native-rate.js:27-32; js/audio-engine.js:46-66 | unit test: the same file is "heavy" with SMALL loaded and not without |
| 20 | **Structural: chunked decode → OPFS shards → worker-owned sync handles → SAB ring → AudioWorklet sink** (Ardour shape; MessagePort transfer as the no-isolation fallback) | 251 (125) steady — resident PCM becomes a 5–20 s ring — and removes the 536 M-sample per-channel ceiling | structural | high | 31 | new: worklet, reader worker, ring; js/audio-engine.js; js/loom/engine.js; sw.js (COOP/COEP) | E13 (isolation on the live site) then a 63-minute HM01 plays end-to-end with resident PCM < 20 MB and no dropouts in a 10-minute hidden-tab soak |
| 21 | **Structural: chunked RENDER to OPFS** (RACK stages on pages, Int16/Float32 written, no second full buffer) | 251 (125) steady + every §3 render peak | structural | high | 31 | js/dsp/chain.js; js/dsp/*.js; js/app/bench-controller.js | rendered file sha256 equals the OfflineAudioContext path's on the fixture for a nodes-free rack; nodes stages need a worklet-graph sink first |
| 22 | **Structural: Int16 (native-depth) pages, Float32 inflated per window** (Superpowered/Audacity model; Int32 or packed 24 for 24-bit FLAC) | 84 beyond native rate (125.6 → 41.9 for source PCM at 48 kHz) steady | structural | high | 21 | new page store; every DSP entry point | scout Experiment 4 already timed it (2 ms per 12 s window, 24 ms whole file); round-trip exact with symmetric ×32768 on 16-bit sources |
| 23 | **Persisted 8-bit peak pyramid next to `source.bin`** (BBC .dat shape) | 2.8 (pyramid) — its value is that the waveform stops needing `R.mono`, a prerequisite for 20 | structural | low | — | js/render/peaks.js; js/app/persist.js | drawn pixels identical to the f32 pyramid at all three zoom levels on the fixture |

Not listed on purpose: SharedArrayBuffer-based transfers for the single-shot worker
payloads (needs isolation; the payloads are transient); `driveCurves` (8 KB per key);
harvest-worker termination (shipped).

### 4B. Shipped this morning — still needs its proof

| rank | intervention | MB | risk | files (live) | proof outstanding |
|---|---|---|---|---|---|
| 24 | Release the whisper worker after each job and on source change | 940 (SMALL) / 330 (BASE) steady | low | js/transcribe.js:110-124; js/app/bench-controller.js:24-36, :248 | uncommitted test/run.mjs (+46) covers dispose; live: task-manager tab + GPU rows fall by ≥ the weights after RESULT; `dispose()` returns false mid-job, so a source swap during a job must still release afterwards (assert `releaseTranscriber('job done')` runs in `finally` on the error path too) |
| 25 | Native-rate decode + enforced budget | 264 steady in this session (127 load + 127 render + kit/ghost); halves every §3 row | medium-low | js/audio-engine.js:51-97; js/dsp/native-rate.js:354-404; js/app/source-controller.js:94-150 | 300 cases pass per the scout; missing: a test that pushes a 48 kHz buffer through `renderChain` on a 96 kHz context and checks output length = 10 464 000 at 48 000 Hz, and that the spectrogram's Nyquist label reads 24 kHz (E11); MP3/AAC/OGG now probe, so confirm one of each decodes at its own rate |
| 26 | Old take dropped before a re-render | 254 (127) peak | low | js/app/bench-controller.js:624-630 | assert `R.renderedBuffer === null` and `abState === 'a'` while `renderChain` is pending on a second RENDER (mock chain); scout live check passed (render → A/B → re-render) |
| 27 | Repair rebuild re-points at `R.original` before allocating | 251 (126) peak | low-medium | js/app/repair-controller.js:95-97 | E5: two repairs, toggle one, tab memory peaks at resident + 2 pairs, not 3; playback paused by `adoptBuffer` during the swap |
| 28 | Source loudness cached per generation + repairs | 167 (84) transient per render after the first | low | js/app/bench-controller.js:633-637 | spy: `measureViaWorker` called once for `R.buffer` across two renders; called again after a repair |
| 29 | Encoded bytes spilled to OPFS once written | 42 steady | medium | js/app/source-handle.js; js/app/persist-controller.js:179-187 | 304 cases pass, live KEEP/RESUME verified per the scout; missing: `opfs === null` keeps the bytes (Safari path), and `discard()` while live does not strand a spilled handle (`bytes()` after wipe must re-materialise or fail loudly) |
| 30 | Spectrogram image shrunk at `compute()`, texture destroyed on `setData(null)` | 33 during every STFT and after clear | low | js/spectrogram.js:171; js/render/spectrogram-gpu.js:259 | after `compute(null, 0)`: `_img.width === 1` and `gpu._dataTex === null` (stub device) |
| 31 | Harvest worker retired per job; `fitted` bounded to one key per track; MODELS labels | 0.16 + isolate; bounded growth; 0 | low | js/machine/controller.js:973-988; js/machine/sequencer.js:140; js/transcribe.js:4-14 | scout live check: HARVEST twice OK (24 slices); assert `harvestWorker === null` after done/error; after two BPM changes `cached.fitted.size === 1`; labels match the HF Hub API table in ledger/transcription.md §4 |

## 5. Leaks and double copies

"Leak" here means bytes reachable past their natural release point; "double copy" means the
same payload materialised twice at once. Status is against the live tree.

| # | what | evidence | status |
|---|---|---|---|
| L1 | Loudnorm holds up to five full buffers through its corrective pass: `const gained` (function scope, used once), `let limited` reassigned only after the second limiter returns, `const corrected` (block scope, used once), plus limiter scratch 2·F·4 | loudnorm.js:63-84; limiter.js:38, :61, :72 | **open** (rank 1) |
| L2 | Denoise worker keeps seven channel-sized arrays alive until `denoiseChannel` returns — `samples`, `padded`, `magDb` (2.0× channel), `outP`, `wssP`, `out` — although its own comment says wssP is constant 1.5 in the interior; channel 1 starts before channel 0's scratch is necessarily collected | denoise-worker.js:63, :75, :147-148, :174-181; denoise.js:66-83 | **open** (rank 2) |
| L3 | Loudness worker is created once, never terminated, and each job leaves a transferred F·C·4 copy in its heap until its own GC | bench-controller.js:309-311, :336-340; loudness-worker.js:19-24 | **open** (rank 3) |
| L4 | .yjkt import materialises the source (and every sample) three to four times: zip buffer, `readBundle` slice (already standalone, byteOffset 0), a redundant `parseProjectEntries` slice, then `sourceBytes` | project-bundle.js:232, :263, :269; persist-controller.js:235 | **open** (rank 6) |
| L5 | `loadFromUrl` keeps the chunk array `parts` reachable in its `try` frame across decode, peaks and spectrogram kick-off — 3× encoded at peak | source-controller.js:344-366 | **open** (rank 6) |
| L6 | Whisper worker holds the 96 kHz `native` array and the 16 kHz copy for the whole inference; `native` is dead after `resample()` but pinned by the suspended frames | whisper-worker.js:120-148, :172-181 | **open** (rank 7); halved by native-rate decode |
| L7 | Wasm linear memory never shrinks; a failed WebGPU attempt followed by the WASM fallback stacks both loads into one heap | whisper-worker.js:100-119; platform fact | **mitigated**: the heap dies with the worker after each job; still present during a job |
| L8 | `historyPcm` keeps every `track.sample` referenced by any of ≤ 60 undo docs (+ redo) alive by reference; a plain `openFile` never calls `clearHistory`, so a source swap carries the previous session's docs and deleted kit samples | persist-controller.js:355-367; project-store.js:182, :225-227; clearHistory callers at persist-controller.js:273, :473 only | **open** (rank 13); bounded |
| L9 | `bytesGeneration` starts at −1 and `restore()` never seeds it, so the first autosave after RESUME rewrites the 41.9 MB `source.bin` it just read | persist-controller.js:29, :179-181, :423-488 | **open** (rank 17); disk, not RAM |
| L10 | `serializeProject` builds a flat f32 copy of every referenced sample on every autosave before `samplesWritten` decides to skip the write | persist.js:73-83, :151; persist-controller.js:191-193 | **open** (rank 14) |
| L11 | `modalFit` (with a clip-length residual) and `synthPcm` survive source loads in controller closures with a stale rate | machine/controller.js:1129, :1246-1249, :1291-1297; `resetForSource` :837-843 touches neither | **open** (rank 15) |
| L12 | Analysis worker never terminated (holds ~0.3 MB and an isolate) | source-controller.js:226 | open; negligible |
| L13 | A stale render (rack edited after RENDER) stays fully resident — `markStale` only flips a flag — serving only A/B of a take the UI calls STALE | bench-controller.js:445-449, :259-262 | open by design (A/B); 254 → 127 MB with native rate |
| L14 | `R.original` doubles A1+A2 while any repair exists, until the next source load | repair-controller.js:66-68, :253-261 | by design (non-destructive stack); halved by native rate |
| L15 | `_mags` is held on the CPU while its copy sits in `_dataTex` on the GPU, for re-upload/demotion | spectrogram.js:418, :641 | by design; rank 11 halves both |
| L16 | `driveCurves` and `kernelCache` Maps grow per distinct key with no eviction | sequencer.js:52-68; resample.js:22, :41 | bounded (8 KB / 655 KB per key); kernelCache now dies with the worker |
| F1 | `overBudget` computed and ignored for files at or below the context rate; MP3/AAC probed to zero seconds | native-rate.js:197-208 (audited); audio-engine.js:56-71 (audited) | **fixed** `8e61f1f` |
| F2 | Encoded bytes retained for the session after the OPFS write | source-controller.js:85; persist-controller.js:180 (audited) | **fixed** `4c25009` |
| F3 | Three encoded copies at peak on the above-rate branch (`ab`, `sourceBytes`, `ab.slice(0)`) | audio-engine.js:66 (audited) | **fixed** `8e61f1f` (fallback pattern) |
| F4 | Whisper worker and model never released | transcribe.js (audited, no terminate); whisper-worker.js:180-186 | **fixed** (uncommitted) |
| F5 | 2D image canvas and GPU texture survive a source clear | spectrogram.js:392, :412-414; spectrogram-gpu.js:256-260 (audited) | **fixed** (uncommitted) |
| F6 | Old render held through a re-render | bench-controller.js:593-612 (audited) | **fixed** (uncommitted) |
| F7 | Repair rebuild holds three full pairs | repair-controller.js:93-122 (audited) | **fixed** (uncommitted) |
| F8 | Fitted AudioBuffers accumulate per BPM passed through | sequencer.js:136-146; controller.js:594-598 (audited) | **fixed** (uncommitted) |
| F9 | Harvest worker never terminated | machine/controller.js:957-969 (audited) | **fixed** (uncommitted) |

Cross-ledger reconciliations: the rack ledger's `renderedPeaks` figure (2 991 880) is an
arithmetic slip for 2 983 880 (327 000 + 40 875 + 5 110 blocks × 8 B); the scout's "16 kHz
mono copy (js/transcribe.js:19)" is made in the worker, and what the main thread makes is a
full context-rate copy (transcription ledger §10); the scout's "41–250 MB on disk" model
figures are the WASM q8 sizes, the WebGPU path fetches 120 / 206 / 586 MB.

## 6. Platform facts that constrain the design, and prior art worth adopting

### 6A. Platform (from ledger/platform-chrome.md; confidence as recorded there)

| fact | source | what it settles |
|---|---|---|
| Chrome on macOS maps `DISPATCH_MEMORYPRESSURE_CRITICAL` (and free disk below a threshold, polled every 5 s) to CRITICAL; `UrgentPageDiscardingPolicy` then discards one eligible page per event; `kUrgentPageDiscarding` is on by default | `components/memory_pressure/system_memory_pressure_evaluator_mac.cc`; `chrome/browser/performance_manager/policies/urgent_page_discarding_policy.cc`; `components/performance_manager/features.cc:176` (high) | The discard is a system-pressure event, not a per-tab ceiling; a nearly-full disk triggers it too. Design for sudden loss, not for a number |
| A page is exempt while audible and for 1 minute after; while hidden < 10 minutes on desktop; when pinned, active, PiP, capturing, with form edits, etc. | `discard_eligibility_policy.{cc,h}`; `cannot_discard_reason.h`; Chrome help 12929150 (high) | Playback protects the tab; silent decoding/analysis in a tab hidden > 10 min does not — the exact shape of "left it transcribing and came back" |
| `document.wasDiscarded` is Chrome 68+ and Chrome-only; no event fires at discard; persist on `visibilitychange`→hidden and periodically | developer.chrome.com page-lifecycle-api; BCD `api/Document.json` (high) | Rank 18: silent auto-restore on Chrome, an own marker on Safari |
| Safari polls the WebContent footprint every 30 s and kills it above `(RAM > 16 GB ? 15 GB : 7 GB) + 1 GB × tabs` (active) or `min(3 GB + 1 GB × tabs, 0.9 × RAM)` (inactive), with no script-visible signal | WebKit `Source/WTF/wtf/MemoryPressureHandler.cpp` (high) | Safari's ceiling is a hard kill; the same checkpoint discipline covers it |
| V8 heap capped at 4 GB (measured `jsHeapSizeLimit` 4 395 630 592); typed-array backing stores are not in it | `v8/src/heap/heap.h`; v8.dev pointer-compression; on-machine probe (high) | The JS-heap limit is irrelevant to PCM |
| No single ArrayBuffer above 2 145 386 496 B in Chrome (PartitionAlloc `MaxAllocationSize`), measured: +1 byte → RangeError; `createBuffer(1, 536 346 624, 48000)` succeeds, +1 → NotSupportedError | `partition_alloc_constants.h`; `gin/array_buffer.cc`; on-machine probe (high) | Hard shard ceiling 536 346 624 samples per channel (1.55 h @ 96 kHz); shard ≤ 2^27 samples and treat RangeError as a normal outcome |
| Failure order: RangeError (catchable) → NotSupportedError from createBuffer/decodeAudioData → renderer crash on V8-heap exhaustion or Blink-internal allocation failure ("Aw, Snap!", no OOM string on macOS) | blink-dev intent; `audio_buffer.cc`; `sad_tab.cc` (high) | Every large allocation goes through a try/catch that can spill or degrade; never let a Blink decode be the first thing to hit the wall |
| `performance.memory.usedJSHeapSize` includes external memory but is quantised into 100 buckets and refreshed at most every 20 minutes by default | `memory_info.cc` (high) | Not a monitor. Self-account: bytes = length × channels × 4 at the buffer's rate |
| AudioBuffer channels are DOMFloat32Arrays in PartitionAlloc inside the V8 sandbox, counted as V8 external memory; `getChannelData` does not copy | `audio_buffer.cc`; `array_buffer_contents.cc` (high) | Self-accounting is exact; large buffers trigger GCs but do not consume the heap |
| `decodeAudioData` detaches its input (Chrome 59+); FFmpeg decodes into packet buses, copied into one bus, sinc-resampled into a second if the rate differs, then memcpy'd into DOMFloat32Arrays — ≈ 2× decoded PCM transient at each of three stages; the same 2 GiB per-channel cap applies inside decode | `base_audio_context.cc`; `audio_bus.cc`; `audio_decoder.cc`; `audio_file_reader.cc` (high) | Budget 2× the decoded size per decode; never decode a file whose per-channel PCM at the target rate exceeds 536 M frames — decode windows |
| `AudioBufferSourceNode` resampling is linear interpolation in Chromium and WebKit; `decodeAudioData` uses a windowed sinc | `audio_buffer_source_handler.cc`; WebKit `AudioBufferSourceNode.cpp`; spec index.bs (high) | **Native-rate decode is memory-correct but audibly not free**: a 48 kHz buffer on a 96 kHz context is linearly interpolated at playback (imaging in the band this bench measures). Open the context at the file's rate, or resample once through an OfflineAudioContext decode. Scout Experiment 1 tested duration, not spectrum (E12) |
| `measureUserAgentSpecificMemory` needs `crossOriginIsolated`; GitHub Pages cannot set headers; `coi-serviceworker` injects COOP/COEP from a service worker at the cost of one first-visit reload; the bench already ships `sw.js` | web.dev monitor-total-page-memory-usage; community discussion 54257; gzuidhof/coi-serviceworker; on-machine probe (high) | Isolation is attainable and pays twice (memory API + SharedArrayBuffer); needs CORS/CORP discipline for every cross-origin fetch (archive.org SHELF fetches are already CORS-mode) |
| OPFS sync access handles (workers only, exclusive per file): measured 2.9 GB/s write, 4.4 GB/s read, 41 µs random 64 KiB reads; `estimate().quota` is reported as usage + 10 GiB regardless of headroom; the enforced quota is 60 % of disk | on-machine probe; `quota_manager_impl.cc` `CalculateReportedQuota` (high) | Spill bandwidth is free; the cost is copies and the one-handle-per-file lock; `QuotaExceededError` on write is the only real signal, `persist()` the only lever |
| Chrome's `decodeAudioData` decodes unaligned mid-stream MP3 slices (FFmpeg resync); Safari is strict — cut on frame sync words | on-machine probe; web-audio-api#2135; Phonograph (high Chrome / medium Safari) | Windowed MP3 loading needs no WASM decoder on Chrome; expect the first frame after a cut to be wrong (bit reservoir) |
| WebCodecs `AudioDecoder`: Chrome 94, Firefox 130, Safari 26; Chrome registers mp3/flac/opus/aac/vorbis/pcm | BCD `api/AudioDecoder.json`; W3C codec registry (medium-high) | The Chrome-first path for windowed decode with true seeking and no whole-file transient; feature-detect with `isConfigSupported` |
| SharedArrayBuffer only under isolation (Chrome 92+ desktop, Safari 15.2+); AudioWorklet Chrome 66 / Safari 14.1; Chrome's own guidance calls MessagePort streaming into a worklet suboptimal | BCD; Chrome audio-worklet-design-pattern; on-machine probe (high) | Rank 20's SAB path needs `coi-serviceworker`; the transferred-chunk MessagePort path is the fallback |
| `navigator.deviceMemory` reports 16 on this 24 GB Mac (Chrome-only, coarse) | on-machine probe (high) | A budget tier in Chrome only; assume a conservative tier on Safari |

### 6B. Prior art worth adopting (from ledger/prior-art.md)

| technique | who ships it | fit here | source |
|---|---|---|---|
| Native-rate decode on every branch, resample only at output | argued on the W3C list in 2014 (resampling bloat > int16 bloat); the bench now does it | shipped (`8e61f1f`); see the linear-interpolation caveat above | lists.w3.org public-audio 2014JanMar/0047 |
| Keep the compressed copy on disk, not in RAM; freeze/render-and-replace | Soundtrap (WAC 2017: Vorbis-encode large WAVs via emscripten to ease memory) | shipped (`4c25009`) | webaudioconf.com/posts/2017_EA_29 |
| Precomputed min/max peak pyramid, 8/16-bit, persisted beside the source | BBC audiowaveform `.dat` + peaks.js; wavesurfer `peaks`+`duration`; Audacity summary256/summary64k | rank 23: one Worker pass at import, ~0.16 MB for Traum at 256 spp 8-bit; makes the waveform independent of `R.mono` | github.com/bbc/audiowaveform/blob/master/doc/DataFormat.md; forum.audacityteam.org/t/…/61618 |
| Int16 (native-depth) resident PCM, Float32 on demand | Superpowered `Decoder`/`AudioInMemory` (16-bit PCM in linear memory); W3C #2396 priority-1 since 2021, unshipped; Firefox reportedly internal | rank 22; scout Experiment 4 measured the costs (2 ms per window); Int32/packed-24 for 24-bit FLAC | docs.superpowered.com decoder + audio-in-memory; github.com/WebAudio/web-audio-api/issues/2396 |
| Disk-streaming shape: non-realtime reader thread, ring sized in seconds (Ardour 5/10/20 s presets, 65 536-sample chunks; REAPER 1200 ms media buffer), refill when a chunk frees | Ardour `libs/ardour/disk_io.cc:96-140`, `disk_reader.cc:544`; REAPER config | rank 20: Worker + OPFS sync handle + SAB ring + worklet sink reproduces it; the browser cannot give thread priority or I/O inside the worklet | github.com/Ardour/ardour; ardour.org/transport_threading.html |
| Worker → SAB ring → AudioWorklet (ringbuf.js, audio-worklet-stream); fetch-stream-audio as the no-SAB scheduled-buffer variant; wasm-audio-decoders (mpg123 77 KiB, FLAC 67 KiB) or WebCodecs as the decoder; mediabunny `BlobSource` for lazy container reads | Chrome design-pattern article; padenot/ringbuf.js; ain1084/audio-worklet-stream; AnthumChris/fetch-stream-audio; eshaz/wasm-audio-decoders; mediabunny | every piece is public; nobody has published the OPFS-fed editor variant — the reader is the only new code | developer.chrome.com/blog/audio-worklet-design-pattern; github.com/padenot/ringbuf.js; mediabunny.dev/guide/reading-media-files |
| Lazy container access instead of copying into a heap (WORKERFS; mediabunny BlobSource) | ffmpeg.wasm 4 GB+ example; mediabunny | OPFS `getFile()` is already a `File`; WAV by byte range, FLAC via seektable, MP3 via frame sync | emscripten Filesystem-API; github.com/pavloshargan/ffmpeg-browser-4gb-plus |
| Media element + `MediaElementAudioSourceNode` from an OPFS blob URL | wavesurfer default backend; PR #1767 after a 3-hour file crashed the tab | a playback-only answer with zero resident PCM; loses sample-accurate transport and offline render; 96/192 kHz through `<audio>` unverified (E14) | wavesurfer.xyz/docs/core-concepts; github.com/katspaugh/wavesurfer.js/pull/1767 |
| Chunked offline render to disk instead of one OfflineAudioContext buffer | proposed in web-audio-api-v2#66, never shipped; WebCodecs Fundamentals' ~20 s batches | rank 21; requires the RACK chain to run outside the Web Audio graph for nodes stages | github.com/WebAudio/web-audio-api-v2/issues/66 |
| Discard-aware checkpointing | Chrome Page Lifecycle guidance | rank 18 | developer.chrome.com/docs/web-platform/page-lifecycle-api |

The prior-art finding that frames all of this: no shipping browser editor decodes a long
file in pieces for editing; those that survive long files either stop decoding (media
element + peaks) or accept the wall (AudioMass, Tone.js, Elementary). Rank 20 is
unoccupied ground assembled from maintained parts, not a design to copy.

## 7. Open questions that need an experiment

Each is phrased so that a single session in the in-app Chromium (or Safari where named)
settles it. Task-manager readings mean `chrome://task-manager` with the Memory footprint
and GPU memory columns, since `performance.memory` is quantised and 20-minute stale.

| # | question | method | pass / fail |
|---|---|---|---|
| E1 | Is the ~780 MB "reset" a Chrome urgent discard, and does the current RESUME path recover it without a click? | Load Traum, transcribe with SMALL, hide the tab, leave it silent > 10 min, then apply pressure (open a few heavy apps or a memory-pressure tool until macOS reports CRITICAL); return to the tab | **Pass**: `document.wasDiscarded === true`, the RESUME panel appears, and RESUME restores the same SHA and position. **Fail**: the tab is intact (the resets have another cause — look at "Aw, Snap!" crash logs instead) |
| E2 | Does V8's liveness analysis already drop `gained`/`corrected` in `processLoudnorm` at the awaits? | DevTools Memory → allocation timeline (or task manager) during a LOUDNORM-only render of Traum at 48 kHz | **Pass** (pinned): peak above baseline ≈ 502 MB → rank 1 saves 251. **Fail** (already dropped): ≈ 335 MB → rank 1 saves 84 (the `limited1` null) |
| E3 | Does the denoise worker's channel-0 scratch survive into channel 1? | Task-manager worker row peak during a DENOISE-only render at 48 kHz | **Pass**: peak ≤ 1.1 × 293 MB (single channel). **Fail**: ≈ 587 MB — rank 2 must also `postMessage` a "collect" barrier or split channels across two workers |
| E4 | Where does Chrome account WebGPU buffers on Apple Silicon, and does the discarder see them? | Load SMALL with nothing else; read the tab's Memory footprint and the GPU process's before and after | **Pass** (GPU process): tab row rises < 100 MB, GPU row ≈ +586 MB → model bytes count for system pressure but not the tab heuristic. **Fail**: tab row rises ≈ 586 MB |
| E5 | Repair rebuild peak on the live tree | Load Traum, add two repairs, toggle one; watch the tab row during the rebuild | **Pass**: peak ≤ resident + 2 pairs (≈ +251 MB at 48 kHz). **Fail**: 3 pairs (the re-point did not make the previous pair collectable in time) |
| E6 | What is the wasm heap high-water mark per model and device? | Add a debug `postMessage` of `WebAssembly.Memory.buffer.byteLength` after `ready` (or read it from the worker's DevTools context) for tiny/base/small on webgpu and wasm | Record the table. **Pass** for the ledger's estimate: HWM ≤ 3 × largest file. Any value above that changes rank 5/8's worth |
| E7 | Does `src.buffer = buffer` copy an AudioBuffer whose channels were exposed via `getChannelData` ("acquire the content")? | Build a nodes-stage OfflineAudioContext for Traum and watch the tab row before/after `startRendering` | **Pass** (shared): +1 buffer (destination only). **Fail**: +2 buffers — every nodes stage and every loom voice carries a hidden F·C·4 |
| E8 | Is the OfflineAudioContext destination allocated in full at construction? | Construct `new OfflineAudioContext(2, F, 48000)` without rendering; watch the tab row | **Pass**: +F·C·4 immediately. **Fail**: grows per render quantum |
| E9 | Does the whisper worker pin the 96 kHz `native` array through inference? | Worker heap snapshot mid-job (DevTools → worker context → Memory) | **Pass** (pinned): two live Float32Arrays → rank 7 saves 42–84 MB. **Fail**: one → rank 7 is a no-op |
| E10 | Do fp16 encoder and q4f16 decoder reproduce word timestamps? | Run the transcription fixtures with `pipelineOptions('webgpu')` set to fp16/q4f16; diff word start/end against the fp32/q4 output | **Pass**: every word within the fixture tolerance and all outputs finite. **Fail**: any NaN or a drift > tolerance → keep fp32 encoder, try q4f16 alone |
| E11 | Which consumers assumed `R.sampleRate === ctx.sampleRate`? | With a 48 kHz file on the 96 kHz context: RENDER, export, spectrogram, transcription, harvest, kit render | **Pass**: output length 10 464 000 at 48 000 Hz; spectrogram Nyquist label 24 kHz; harvest onsets match the 96 kHz-decoded run within ±1 hop; exported WAV header says 48 000. **Fail** on any: a consumer sizes by the context rate |
| E12 | Is native-rate playback through the 96 kHz context spectrally clean, given Chromium's linear-interpolation resampler? | Play a 20 kHz tone (and a 40 kHz tone from a 96 kHz file on a 48 kHz context, for the reverse case) through the bench; capture with the existing analyser at the output | **Pass**: no image above −80 dB relative. **Fail**: visible images → open the AudioContext at the file's rate (`new AudioContext({sampleRate})`) or resample once through an OfflineAudioContext decode |
| E13 | Can the live site become cross-origin isolated without breaking SHELF/FIELD? | Add the coi-serviceworker logic to `sw.js` on a branch; deploy to a preview | **Pass**: `crossOriginIsolated === true` after one reload, `performance.measureUserAgentSpecificMemory` defined, every SHELF/FIELD/MODEL fetch succeeds. **Fail**: any blocked subresource — list it and decide CORP vs dropping isolation |
| E14 | Does `<audio>` on a blob URL play 96/192 kHz WAV/FLAC without silent downsampling? | Load a 96 kHz file with a 40 kHz tone via `createObjectURL(getFile())` → `<audio>` → `createMediaElementSource` on a 96 kHz context; analyser | **Pass**: the 40 kHz line is present → the media-element route is viable for playback. **Fail**: absent → it is a ≤ 48 kHz playback route only |
| E15 | Exact canvas bytes on Ian's display | Read `getBoundingClientRect() × devicePixelRatio` for `#specMain`, `#specGpu`, `#waveMini`, `#waveMain`, `#waveRack`; compute w·h·4 (×2 for offscreens, ×2 surfaces for the swapchain, ×2×8 for phosphor) | Converts rows 8–10 from inferred to fact. **Pass** for this ledger's estimate: within ±20 % of 63 MB |
| E16 | Does the idle loudness worker hold its 84/167 MB copy until its next GC? | MEASURE once, wait 30 s, read the worker row | **Pass**: row falls to isolate size within 30 s → rank 3 is optional. **Fail**: still ≈ +84 MB → rank 3 |
| E17 | Where does a 167 MB export Blob live and does it count toward the tab? | Export 32f WAV; watch renderer vs browser process rows during and 2 s after | **Pass**: renderer peak ≤ baseline + 1× encoded → rank 4 matters only for the RangeError. **Fail**: +2× in the renderer → rank 4 matters for the reset |

## 8. Method notes

Every subsystem ledger read line ranges, ran no tests, edited nothing. The two research
ledgers cite primary sources (Chromium/V8/WebKit source at `main`, BCD, spec text) plus
on-machine probes in Chrome 152; where a claim came from a search excerpt rather than the
page it is marked MED/LOW there. This synthesis added one thing: a read of the 132-line
uncommitted diff and the two morning commits, to mark what is shipped. The ledgers' line
numbers therefore describe `150a913`; the "live" citations describe the working tree at
10:52. Nothing in §1–§3 is measured — the totals are footprint arithmetic from the cited
formulas, which is why §7 exists.
