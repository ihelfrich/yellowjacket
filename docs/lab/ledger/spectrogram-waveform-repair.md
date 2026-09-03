# Ledger · spectrogram / waveform / repair

Scope: `js/spectrogram.js`, `workers/spectrogram-worker.js`, `js/render/spectrogram-gpu.js`,
`js/render/peaks.js`, `js/waveform.js`, `js/app/repair-controller.js`, `workers/repair-worker.js`,
`js/app/repair-panel.js`. Read by line range on 2026-09-03; no source edited; tests not run.

Reference case **Traum**: 218 s, 48 kHz stereo, decoded at a 96 kHz context.
F = 218 × 96,000 = **20,928,000 frames**, C = 2, SR = 96,000.
Base units: F·4 = 83,712,000 B (one mono); F·C·4 = 167,424,000 B (one AudioBuffer).

Labels: **[fact]** = read in code at the cited line. **[inference]** = follows from browser
semantics or an assumed layout size, not from a line in this repo.

---

## 1. Spectrogram (STFT matrix, worker, 2D image, GPU)

### 1.1 Worker input copy — `mono.slice()` (spectrogram.js:186)
- **Formula**: F·4. **Traum: 83,712,000 B.**
- **[fact]** Allocated on the main thread at `compute()` (line 186), then *transferred* to the
  worker (line 220–223, `[copy.buffer]`), so the main-thread copy is detached at once. The
  worker owns it for the life of the STFT.
- **[fact]** Released when the worker terminates: `finish()` (line 191–196) is called on
  'done', 'error', and 'messageerror'; a superseding `compute()` terminates any in-flight
  worker (line 156–159). Lifetime = duration of one STFT (seconds).
- **Scales with F.** This is the only spectrogram allocation that would halve under
  native-rate decoding.

### 1.2 Worker working set (spectrogram-worker.js:35–39; fft.js:7,14,15,66)
- FFT(2048): rev Uint32Array(2048) 8 KB; cos/sin Float32Array(1024) 4 KB each; hann 8 KB;
  re/im 8 KB each. ≈ 40 KB. **[fact]** Freed with the worker. Negligible.

### 1.3 Magnitude matrix `_mags` (worker line 39; held at spectrogram.js:200)
- **Formula**: cols × bins × 4, bins = fftSize/2 = 1024 (worker line 24), cols =
  min(floor((F−2048)/512)+1, maxCols=8000) (worker line 31–32; parameters from
  spectrogram.js:221).
- Traum: totalFrames = 40,872 → cols = **8000**. **32,768,000 B (31.25 MiB).**
- **[fact]** Transferred back, not copied (worker line 71, `[mags.buffer]`). Held by
  `this._mags` until the next `compute()` nulls it (spectrogram.js:165). Also nulled on
  `compute(null, 0)` (source clear, source-controller.js:195).
- **[fact] Rate-independent for any clip longer than 8000·512+2048 = 4,098,048 frames**
  (42.7 s at 96 kHz, 85.4 s at 48 kHz). For Traum the matrix is the same 32.77 MB whether
  decoded at 48 or 96 kHz — the column stride absorbs the extra frames (worker line 47).
- **[fact]** Kept resident even when the GPU path is live: `_pushGpuData()` re-uploads from
  it (line 641) and `_paintImage` falls back to it on GPU demotion (line 418, 731–741).
  No consumer outside spectrogram.js reads it (rg over js/ and workers/: none).

### 1.4 Full-resolution 2D image `_img` (spectrogram.js:85, 412–414) — 2D path only
- **Formula**: cols × bins × 4 canvas backing store. **Traum: 32,768,000 B.**
- Plus a transient `createImageData(cols, bins)` of the same size during `_paintImage`
  (line 416), garbage after `putImageData` (line 445). Repainted (new ImageData each time)
  on any palette-signature change (line 393–404), e.g. theme switch.
- **[inference]** Chrome may keep an 8000×1024 accelerated canvas as a GPU texture *and*
  a CPU mirror after `putImageData`; the resident cost may be up to 2× the formula.
- **[fact]** When the GPU path is live the canvas is shrunk to 1×1 (line 407–410), so the
  2D bitmap costs nothing on the GPU path.
- **Lifetime / release**: `compute()` clears `_imgSig` (line 168) but does **not** resize
  `_img`; the bitmap is only reallocated by `_paintImage` after the *next* 'done'. On
  `compute(null, 0)` (source clear) `render()` → `_ensureImage()` returns at line 392
  (`!this.ready`), so the old 32.77 MB bitmap stays until another source computes.
  See Leak L1.

### 1.5 GPU data texture `_dataTex` (spectrogram-gpu.js:264–268) — GPU path only
- **Formula**: bins × layerRows × layers × 4, r32float, from `chunkLayout` (line 86–94):
  layerRows = min(cols, maxTextureDimension2D), layers = ceil(cols/layerRows).
  With maxDim ≥ 8000 (Apple Silicon reports 16384 **[inference]**): one layer, 1024 × 8000.
  **Traum: 32,768,000 B** (33,554,432 B if maxDim were 4096: 2 layers of 4096 rows).
- **[fact]** Uploaded per layer with `queue.writeTexture` straight from `_mags`
  (line 270–277), no JS staging copy. **[inference]** The browser's own staging buffer for
  writeTexture may transiently hold another 32.77 MB in the GPU process.
- **[fact]** On macOS unified memory this is system RAM, not a separate pool.
- **Lifetime**: replaced (old destroyed at line 279) on each successful `setData`;
  destroyed by `destroy()` (line 388–392) on GPU demotion or loss.
  **[fact]** `setData(null, …)` (the `!ready` branch at line 256–260) only flips
  `_hasData=false` and does **not** destroy `_dataTex` — see Leak L2.

### 1.6 Phosphor ping-pong targets (spectrogram-gpu.js:454–458) — GPU path, playback only
- **Formula**: 2 × w × h × 8 (rgba16float) at the `#specGpu` device-pixel size (line 412–413).
- **[inference]** example: a 1200×300 CSS canvas at dpr 2 → 2400×600 → 2 × 11,520,000 =
  **23,040,000 B**. Exact size depends on layout; not derivable from code.
- **[fact]** Created lazily when phosphor turns on (`_ensurePhosphor`, line 449), destroyed
  when it turns off (`setPhosphor(false)` → `_dropPhosphor`, line 323, 466–474) and on
  canvas resize (line 419). `_stopPhosphor` fires 250 ms after playback ticks stop
  (spectrogram.js:694–699). Lifetime = while playing + 250 ms.

### 1.7 Small GPU objects
- LUT texture 256×1 rgba8 = 1 KB (line 246–251); uniform buffer 48 B (line 242–245);
  `_uArr` 48 B. Negligible. **[fact]**

### 1.8 Visible canvases
- `specMain` 2D: w×h×4 at device px (spectrogram.js:330–331). `specGpu`: WebGPU swapchain,
  w×h×4 × 2–3 surfaces **[inference]**. Sizes are layout-dependent; e.g. 3200×800 device px
  → 10.24 MB per surface. `_composite` allocates nothing per frame (line 450–475) **[fact]**.
- Hidden tab: `_syncSize` returns before touching `canvas.width` when the rect is 0
  (line 328), so a canvas keeps its last backing store while hidden. Not a growth path.

---

## 2. Peak pyramids (render/peaks.js)

### 2.1 Formula (peaks.js:22–66)
- Three levels, blocks 64/512/4096, each level two Float32Arrays of ceil(n/block):
  bytes = 8·(⌈F/64⌉ + ⌈F/512⌉ + ⌈F/4096⌉) ≈ **0.1426·F**. The pyramid *references* mono
  (line 66, "referenced (never copied)").
- **Traum: 8·(327,000 + 40,875 + 5,110) = 2,983,880 B (2.98 MB).**

### 2.2 How many exist — **[fact]** three at most, none duplicated across views
1. **`R.peaks`** — built once per source (source-controller.js:121) and once per repair
   rebuild (repair-controller.js:127). Shared by every view of the source mono:
   waveMini (source-controller.js:129), waveMain (:130), waveRack (bench-controller.js:488
   via `syncPreviewBuffer`), sliceView (machine/controller.js:838; repair-controller.js:130).
   `WaveformView.setBuffer` only builds its own when the argument is null (waveform.js:72);
   the only null call is the clear path (source-controller.js:193–194) with null mono.
   Held by `store.runtime.peaks` until the next load/clear (source-controller.js:121, 190).
2. **`renderedPeaks`** — after RENDER (bench-controller.js:614) over `renderedMono`; 2.98 MB.
   Held in the bench closure until `resetForSource` (line 793) or the next render. Also
   referenced as `_ghostPyr` by waveMain during A/B (line 662) and waveRack after a fresh
   render (line 520). *(The 83.7 MB `renderedMono` itself belongs to the bench ledger.)*
3. **Rack-preview ghost pyramid** — `waveRack.setGhost(mono.subarray(skip), null, …)`
   (bench-controller.js:547) passes no pyramid, so waveform.js:93 builds one over the 12 s
   window: 1,152,000 frames → **164,256 B**. Plus the ghost mono it references: the
   `mixdownMono(out)` of the 13 s render window (bench:544; preview.js:7–8) =
   1,248,000 × 4 = **4,992,000 B** — the subarray shares that whole buffer.
   Both held by waveRack (`_ghostMono`, `_ghostPyr`, waveform.js:89,93) until the next
   preview replaces them or `setGhost(null)`.
   **Transient per preview [inference on render output size]**: `sliceAudioBuffer`
   (preview.js:46) 1,248,000 × 2 × 4 = 9,984,000 B + `renderChain` output of equal length
   9,984,000 B + mono 4,992,000 B ≈ **25 MB churn per preview**, retriggered (220 ms
   debounce, bench:495) on seek, rack change, and every store change of a PREVIEW kind
   (bench:463, 575–578), only while the RACK tab is visible (`previewVisible`, bench:527).

### 2.3 Per-view column arrays and offscreens (waveform.js)
- `_peaks` / `_ghostPeaks`: 2 × w Float32 each (line 186, 194) — tens of KB. **[fact]**
- Each of the 3 WaveformViews owns an offscreen canvas `_off` (line 22) sized to the
  visible canvas (line 166–167): 2 × w×h×4 per view. **[inference]** ≈ 10 MB for a
  3200×400 device-px main strip, ≈ 3 MB for the mini strip, similar to main for the rack.

### 2.4 Release on new source load — **[fact]**
- waveMini/waveMain: re-pointed synchronously (source-controller.js:129–130); waveMain's
  ghost cleared by `setAb('a')` → `showComparison` with `hasRender=false` (bench:793, 800,
  652–663).
- sliceView: via `machineReset` → machine/controller.js:838.
- waveRack: only through `syncPreviewBuffer` (bench:484–490), which runs on the next
  preview; 'source' and 'source-clear' are PREVIEW_KINDS (bench:463) so it fires within
  ~220 ms and `previewOnce` calls `syncPreviewBuffer` before the visibility check
  (bench:514). Old mono + pyramid + ghost are unreachable after that. Fine.

---

## 3. Repair (controller, worker, panel)

### 3.1 `R.original` capture (repair-controller.js:64–67)
- **[fact]** `{ buffer: R.buffer, mono: R.mono }` — references, zero bytes at capture.
- **[fact]** After the first rebuild with ≥1 enabled repair, `R.buffer`/`R.mono` are new
  objects, so the original pair is now *additional* residency:
  **Traum: 167,424,000 + 83,712,000 = 251,136,000 B** held for as long as the repair
  stack is non-empty. Released by `resetForSource` (line 253–261, `R.original = null`),
  called from source-controller.js:133 and :197. Identity restore (no enabled repairs,
  line 86–88) hands the same objects back to `R.buffer`/`R.mono`, so no double then.

### 3.2 Rebuild working buffers (repair-controller.js:93–122)
- `out = new AudioBuffer(...)` full length: **F·C·4 = 167,424,000 B** (line 93–100), plus
  `mixdownMono(out)`: **F·4 = 83,712,000 B** (line 122; audio-engine.js:352–366).
  A fresh pair on *every* rebuild (toggle, remove, add, harmonics).
- **[fact]** The previous repaired pair stays referenced by `R.buffer`/`R.mono`,
  `engine._buffer`/`_mono` (audio-engine.js:115–116), and the four views until
  `engine.adoptBuffer` (line 126) and the `setBuffer`/`setSource` calls (line 128–130)
  re-point them; waveRack re-points on the next preview ('repairs' ∈ PREVIEW_KINDS).
- **[inference] Peak residency during the 2nd and later rebuilds**, before GC reclaims the
  prior pair: original 251.1 MB + previous repaired 251.1 MB + new 251.1 MB = **753.4 MB**,
  plus the spectrogram recompute that follows (line 134): +83.7 MB worker copy and a new
  32.8 MB `_mags` → **≈ 870 MB** transient. That is above the ~780 MB point at which the
  tab was observed to reset. Worth a direct measurement.
- Per repair span (line 106–109): C × (t1−t0 + 2·PAD_SEC)·SR·4 with PAD_SEC = 0.6 (line 9).
  Example, 2 s region: 2 × 307,200 × 4 = 2.46 MB; transferred to the worker (line 61–62)
  and back (repair-worker.js:245), zero-copy; written into `out` (line 118). Transient.
- `R.peaks` rebuilt (line 127): 2.98 MB, old one released once views re-point.
- Spectrogram recompute (line 134): items 1.1 and 1.3 again.

### 3.3 Repair worker (workers/repair-worker.js)
- Module-level: FFT(4096) tables ≈ 56 KB + hann 16 KB (line 17–18). **[fact]** The worker
  is created once (repair-controller.js:24–28) and never terminated; lives for the page.
- Per job, function-local (line 89–94, 193–194): specRe/specIm = editCount × 4096 × 4 each,
  editCount ≈ region frames at hop 1024 + 8 feather frames (line 86–88); patch/norm =
  patchLen × 4 each; meanBefore/After 2048 × 8 each. Example, 2 s region at 96 kHz:
  editCount ≈ 196 → 3.2 MB × 2 + 0.8 MB × 2 ≈ 8 MB, garbage after the job. Channels are
  edited in place and transferred back (line 236–245).

### 3.4 Preview audition (repair-controller.js:174–203)
- Spans as in 3.2 (transferred, transient). Audition buffer `ctx2.createBuffer(C, b−a, SR)`
  (line 197) covers region + 2 × PREVIEW_PAD_SEC (0.15 s): 2 s region → 2 × 220,800 × 4 =
  1.77 MB, held by the source node until playback ends. Transient. **[fact]**

### 3.5 Repair panel (js/app/repair-panel.js)
- DOM and small descriptor objects only (`_repairs`, `_rows`, `_selection`, line 45–52).
  No PCM, no typed arrays. **[fact]** Nothing to ledger.

---

## 4. What a new source load releases (this subsystem) — **[fact]** unless marked
| Item | Released? | Where |
|---|---|---|
| in-flight STFT worker + its 83.7 MB copy | yes, terminated | spectrogram.js:156–159 |
| `_mags` 32.8 MB | yes, nulled at once | spectrogram.js:165 |
| `_img` 32.8 MB bitmap (2D path) | **no** until the next paint; never on clear | spectrogram.js:392, 412–414 |
| GPU `_dataTex` 32.8 MB | **no** until the next successful upload; never on clear | spectrogram-gpu.js:256–260, 279 |
| `R.peaks` 3 MB | yes, replaced | source-controller.js:121, 190 |
| waveRack refs to old mono/peaks/ghost | yes, within ~220 ms | bench-controller.js:463, 484–490, 577 |
| `R.original` pair (251 MB when repairs active) | yes | repair-controller.js:253–261 via source-controller.js:133/197 |
| repair worker | kept (≈ 70 KB) | repair-controller.js:24–28 |

---

## 5. Leaks / retention past the natural release point
- **L1** spectrogram.js:392 + 408–414 — the 8000×1024 2D image canvas is only resized
  inside `_paintImage`; after `compute(null, 0)` (clear) `_ensureImage` returns early on
  `!ready`, so 32.77 MB of bitmap survives an empty bench indefinitely (2D path only).
  During a normal reload it survives for the length of the STFT.
- **L2** spectrogram-gpu.js:256–260 — `setData(null)` marks no data but leaves `_dataTex`
  allocated; 32.77 MB of r32float survives a clear until another upload or `destroy()`.
- Not leaks but worth knowing: `_mags` is duplicated CPU+GPU by design on the GPU path
  (1.3, 1.5); `R.original` doubles the decoded footprint by design while repairs exist (3.1).

---

## 6. Quick wins (ordered by MB saved for Traum)
1. **Make the previous repaired pair unreachable before allocating the next one**
   (repair-controller.js:93–122). Point `R.buffer`/`R.mono` and `engine` at
   `R.original` (or null the engine's alt) before `new AudioBuffer`, and re-point the
   views after. Cuts the rebuild peak by one pair: **≈ 251 MB** off the 753 MB spike.
   Risk: low–medium (audible gap if playing during rebuild; `adoptBuffer` already pauses,
   line 112–114). GC timing is still V8's, but large-ArrayBuffer external-memory pressure
   triggers collection when the old pair is unreachable **[inference]**.
2. **Quantize `_mags` to Uint8** (worker line 39, 61–65; spectrogram.js:418–441;
   spectrogram-gpu.js:266 → r8unorm). The 2D painter already collapses dB to a 256-entry
   LUT (LUT_SIZE, spectrogram.js:11), so a 0.35 dB step is lossless for the image; no other
   consumer reads dB values. Saves 24.6 MB CPU + 24.6 MB GPU (GPU path) = **≈ 49 MB**, or
   24.6 MB on the 2D path. Risk: medium (worker contract minDb/maxDb, transfer type, the
   bin-interpolation in `_paintImage` works on bytes but must not overflow).
3. **Free the stale image/texture at `compute()` start and on clear** — set
   `_img.width = _img.height = 1` next to `_mags = null` (spectrogram.js:165) and destroy
   `_dataTex` in the null branch of `setData` (spectrogram-gpu.js:256–260). Saves
   **32.8 MB** during every STFT and indefinitely after a clear. Risk: low.
4. **Phosphor targets at half resolution or rgba8unorm** (spectrogram-gpu.js:454–458).
   Saves ≈ 75 % of item 1.6 (≈ 17 MB on the example canvas) during playback. Risk: low
   (decay trails are already blurred by design); cosmetic check needed.
5. **Native-rate decode (the scout's proposal)** halves the two F-scaled items here:
   worker copy 83.7 → 41.9 MB, pyramid 2.98 → 1.49 MB; and halves 3.1/3.2 (251 → 126 MB
   per pair, rebuild peak 753 → 377 MB). Not a change in these files; listed so the
   dependency is visible. The STFT matrix and textures do not shrink (1.3).

---

## 7. Open questions
- Actual CSS sizes and DPR of `#specMain`, `#specGpu`, `#waveMini`, `#waveMain`,
  `#waveRack` on Ian's display: needed for exact canvas, swapchain, and phosphor bytes.
- Does Chrome keep a CPU mirror of the 8000×1024 accelerated canvas after `putImageData`
  (would double 1.4)? Measure with `performance.measureUserAgentSpecificMemory()` or the
  DevTools memory tab with and without the GPU path.
- Does `queue.writeTexture` stage the full 32.77 MB in the GPU process transiently?
- `device.limits.maxTextureDimension2D` on this Mac (affects layer count, not bytes).
- Confirm the rebuild peak (3.2) empirically: load Traum, add two repairs, toggle one,
  watch the tab's memory during the rebuild.
- Whether an AudioBuffer already acquired by a started `AudioBufferSourceNode` is
  copy-on-write duplicated by the browser if JS later writes into it — matters for any
  future "reuse one working buffer" variant of quick win 1.
