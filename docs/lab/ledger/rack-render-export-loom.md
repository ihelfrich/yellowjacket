# Ledger · rack-render-export-loom

Scope: js/dsp/chain.js, js/app/bench-controller.js (render, A/B, exportWav, live
preview, measureViaWorker), js/export.js, js/dsp/preview.js, js/loom/engine.js,
js/dsp/denoise.js + workers/denoise-worker.js, workers/loudness-worker.js +
js/dsp/loudness.js, js/dsp/loudnorm.js (+ limiter/deess/gate/peaks/varispeed
where the render path calls into them).

Reference case "Traum": 218 s, 48 kHz stereo, decoded at a 96 kHz context.
F = 218 × 96 000 = 20 928 000 frames, C = 2.
  one channel   F·4     =  83 712 000 B  (83.7 MB)
  one buffer    F·C·4   = 167 424 000 B  (167.4 MB)
All figures below are MB = 10^6 B. "fact" = read in the code at the cited
line; "inference" = engine/GC behaviour not visible in the code.

Baseline before RENDER (from the scout, not re-derived here): R.buffer 167.4 +
R.mono 83.7 + R.peaks 3.0 + sourceBytes 41.9 (WAV 16-bit) ≈ 296 MB.

---------------------------------------------------------------------------
## 1. Steady state after RENDER — the second full buffer

| what | formula | Traum | file:line | lifetime / holder |
|---|---|---|---|---|
| R.renderedBuffer | F·C·4 | 167.4 MB | bench-controller.js:610 | store.runtime.renderedBuffer; also engine._alt while A/B = 'b' (audio-engine.js:255 via :641). Released only by the next render overwriting it (:610), a new source (source-controller.js:116) or clearSource (:185). |
| renderedMono | F·4 | 83.7 MB | bench-controller.js:613 | module-local `renderedMono`; also referenced by waveMain (showComparison :652-663) and waveRack ghost (:520). Nulled in resetForSource (:791-793). |
| renderedPeaks | 0.1426·F (2 arrays × 4 B × (F/64 + F/512 + F/4096)) | 3.0 MB | bench-controller.js:614 → peaks.js:23-70 | module-local; nulled in resetForSource. Pyramid holds a reference to renderedMono (peaks.js:70 `mono: d`), not a copy. |

Total added by a fresh render: 254 MB (fact). Matches the scout.

Peaks pyramid detail (fact, peaks.js:21 BLOCKS = [64, 512, 4096]): level counts
327 000 / 40 875 / 5 110 blocks × (min + max) × 4 B = 2 991 880 B.

### Stale render is NOT released
markStale (bench-controller.js:445-449, duplicate at :259-262) flips
`renderFresh = false` and re-labels the LED. R.renderedBuffer, renderedMono and
renderedPeaks stay resident (fact). Export refuses the stale take (:677-680) and
preview stops drawing it (:518), but A/B still plays and draws it (:641, :652).
So the 254 MB is not dead — it is the audible "B" — but it serves only A/B once
stale.

### Re-render holds the OLD render for the whole new pipeline
The click handler (bench-controller.js:593-632) runs measure → renderChain →
assigns R.renderedBuffer at :610. Nothing nulls the previous render, mono or
peaks before renderChain starts, and engine._alt still points at the old render
if the user is on 'b' (fact). Peak during a re-render therefore carries the
previous 254 MB on top of everything in §2.

### Release on new source / clear — complete
- source-controller.js:116 `r.renderedBuffer = null` (load), :185 (clear).
- audio-engine.js:84 (load) and :99 (clear) `this._alt = null`.
- bench-controller.js resetForSource :789-793 nulls renderedMono/renderedPeaks
  and calls setAb('a') (:800) → engine.setAltBuffer(null).
- Views: waveMain/waveRack get the new mono via setBuffer (:487, :661) — the
  old ghost reference is replaced (waveRack.setGhost(null) at :488); waveMain's
  ghost is replaced on the next showComparison. Inference: no view retains the
  old renderedMono after resetForSource + the first redraw.
- Mid-render source swap: `if (gen !== R.generation) return;` (:609) drops the
  `rendered` local; GC-able. No leak (fact).

---------------------------------------------------------------------------
## 2. Inside renderChain — how many full copies at peak

renderChain (chain.js:150-207) holds exactly two full buffers of its own:
`buffer` (the parameter = R.buffer, :150) and `buf` (the current stage input,
:190). `buf = await stage(...)` (:194-201) drops the previous stage's input
once the stage returns; nothing else references intermediate outputs (fact).
So per stage: input + output + that stage's scratch, on top of the baseline.

Stage order for a full rack (chain.js:13-23 REGISTRY, kinds from each
descriptor): [highpass+dehum] nodes → denoise buffer → deess buffer → eq nodes
→ gate buffer → compressor nodes → limiter buffer → loudnorm buffer = 8 stages
(cuts add a splice stage first, chain.js:178). Consecutive nodes-kind effects
share one OfflineAudioContext pass (chain.js:181-188).

| stage | allocations (fact unless marked) | Traum, above baseline |
|---|---|---|
| splice (chain.js:87-91) | out = outLength·C·4 (≤ F·C·4). Input is R.buffer itself. | ≤ 167.4 |
| nodes (chain.js:125-143) | OfflineAudioContext(C, F, sr) destination = F·C·4. Inference: Chrome allocates the destination up front. Inference/open: the spec's "acquire the content" step may copy the source AudioBuffer when its channel data has been exposed via getChannelData (it has — mixdownMono); Chrome is believed to share, WebKit may copy → possibly +F·C·4. | input 167.4 (0 when input is R.buffer) + 167.4 out (+167.4 if copy) |
| denoise (denoise.js:52-85) | output AudioBuffer F·C·4 allocated BEFORE any channel runs (:61). Per channel: `input` copy F·4 (:74) made on main then transferred (main side detached, memory moves to worker); `result` F·4 transferred back and alive until `.set()` returns (:78). Worker peak per channel, all alive at the `out` allocation (denoise-worker.js:177): samples 83.71 + padded (F+1536)·4 = 83.72 (:63) + magDb nFrames·513·4 = 167.76 (:75, nFrames = 81 753) + frameRms 0.33 (:76) + outP 83.72 (:147) + wssP 83.72 (:148) + out 83.71 (:177) = **586.7 MB per channel** ≈ 7.0 × channel. Worker is created per process call and terminated in `finally` (:66, :83); channel 1 starts after channel 0's `done`, so channel 0's scratch is garbage but not necessarily collected (inference: worst case two channels' scratch overlap ≈ 1.17 GB in the worker). | main: input 167.4 + output 167.4 + result 83.7 = 418.5; worker: 586.7 (guaranteed) to 1173 (if GC lags). **Total ≈ 1005–1592 MB** |
| deess (deess.js:52-74) | output F·C·4 (:64) + bands: one F·4 per channel (:73) = F·C·4 | input 167.4 + 167.4 + 167.4 = 502 |
| eq nodes | as nodes above | 335 |
| gate (gate.js:24-45) | output F·C·4 (:34) only | 335 |
| compressor nodes | as nodes above | 335 |
| limiter (limiter.js:32-80) | output F·C·4 (:38) + peaks F·4 (:61) + gMin F·4 (:72) + deque 2×482×4 B (:75-76) | 167.4 + 167.4 + 83.7 + 83.7 = 502 |
| loudnorm (loudnorm.js:53-92) | measureLoudness(input): no F-sized scratch (see §5). `gained` F·C·4 (:26-30 via :63). processLimiter(gained) → `limited` F·C·4 + limiter scratch 2·F·4. measureLoudness(limited). If |miss| > 0.05 LU (:77): `corrected` F·C·4 (:78), processLimiter(corrected) → new F·C·4 + 2·F·4 scratch, then `limited` reassigned (:79) — the first `limited` is alive until the second limiter RETURNS. Lexically, `const gained` (function scope) and `const corrected` (block scope) are both still in scope during the second limiter (fact). Inference: V8's generator liveness analysis may drop them at the await since neither is used afterwards — unverified. | guaranteed: input 167.4 + limited1 167.4 + limited2 167.4 + scratch 167.4 = 670; lexical worst: + gained 167.4 + corrected 167.4 = **1004** |
| post-render (bench-controller.js:610-615) | renderedBuffer + mono + peaks (§1) + measure copy F·C·4 transient (§5) | 254 steady + 167.4 transient |

Peak of a first, full-rack render at 96 kHz: baseline 296 + 1005 (denoise) or
+1004 (loudnorm worst) ≈ **1.3 GB**; re-render adds the old 254 MB. Either
heavy stage alone crosses the ~780 MB figure in the scout. At the file's own
48 kHz every entry halves (F is 10.46 M), which is the scout's multiplier.

Not a copy: `slowedBuffer` (varispeed.js:33-51) returns a view object whose
getChannelData delegates to the source (fact) — export at 1/2 or 1/4 speed
costs nothing extra.

---------------------------------------------------------------------------
## 3. Export

exportWav (bench-controller.js:671-727):
- `buf` = R.renderedBuffer (already resident) or, with no render and cuts,
  spliceCuts(R.buffer, cuts) → a transient ≤ F·C·4 (:681-683, chain.js:87).
- encodeWavWithStats (export.js:71): one ArrayBuffer of headerSize + F·C·bits/8.
  Traum: 16-bit 83.7 MB · 24-bit 125.6 MB · 32-bit float 167.4 MB (fact).
- `new Blob([ab])` (export.js:163). Inference: Chrome's Blob constructor copies
  the bytes into blob storage; `ab` stays alive until the function returns, so
  the peak inside encode is 2 × encoded size (335 MB for float). After return
  only the Blob survives (`ab`, `dv`, `chans` are locals). Whether a Blob of
  this size is counted in the renderer or paged to the browser process/disk is
  an open question (§7).
- download (export.js:225-236): object URL revoked after 1 s (:235); the Blob is
  otherwise unreferenced once download returns. Lifetime = ~1 s + GC (fact for
  the reference, inference for GC). The browser's download keeps its own copy.
- RangeError guard (bench-controller.js:707-718) catches the single-block
  failure and reports MB; it does not reduce the allocation.

---------------------------------------------------------------------------
## 4. Live preview slices

previewOnce (bench-controller.js:508-556):
- sliceAudioBuffer (preview.js:43-54): (12 s span + 1 s preroll) = 13 s ×
  96 kHz × C × 4 = 9.98 MB new AudioBuffer (copyToChannel from subarray, fact).
- renderChain(slice, [], chain): per stage a new 13-s buffer (≈10 MB) plus that
  stage's scratch scaled to 1 248 000 frames; with DENOISE on, a fresh Worker is
  spawned and terminated per preview (denoise.js:66/:83) holding ≈ 7 × 5.0 =
  35 MB per channel while it runs.
- mixdownMono(out) 4.99 MB (:545); `mono.subarray(skip)` is handed to
  waveRack.setGhost (:547) — the view keeps the whole 4.99 MB alive until the
  next preview replaces the ghost, or setGhost(null) (:511-512, :519, :528, :550).
- previewMono = R.mono (:487) is a reference, not a copy (fact).
- Cadence: 220 ms debounce (:494), 80 ms after seek (:559); one run at a time,
  a change mid-run schedules one more (:501-507). Bounded: ≈ 10–50 MB transient,
  5 MB held. Not a memory problem; it is a Worker-spawn churn problem.

---------------------------------------------------------------------------
## 5. Loudness worker copies

measureViaWorker (bench-controller.js:308-341):
- One persistent Worker for the page's life (:309-311); never terminated (fact).
- Per call: `buf.getChannelData(c).slice()` per channel (:336) = F·C·4 = 167.4 MB
  allocated on the MAIN thread, then transferred (:340) so the main-side arrays
  detach and the memory lives in the worker until `message.channels` is
  unreachable after `done` (loudness-worker.js:19-24).
- RENDER calls it twice (before at :607 on R.buffer, after at :615 on the
  render); MEASURE once (:346). The `before` copy is made and its job awaited
  BEFORE renderChain starts, so it does not overlap the pipeline (fact).
- measureLoudness itself streams (loudness.js:169-284): the K-weighting is
  inlined (:229-236), subBlockSums is Float64 × F/(0.1·sr) = 2180 × 8 B (:211),
  momentaryEnergies 2177 × 8 B (:255), true peak walks 262 144-sample slabs via
  subarray views (:150-167) and truePeakLinear allocates nothing (truepeak.js:76-96).
  applyBiquad (loudness.js:56-71, F·4 output) is NOT on the measure path.
  Fact: the worker's only large object is the transferred copy.
- Inference: an idle dedicated worker may hold the 167 MB until its own next
  GC; page-side code cannot force it. measureJobs entries for a job whose
  worker died would persist (tiny).

Loudnorm's two measureLoudness calls (loudnorm.js:55, :74) run on the MAIN
thread synchronously (no worker, no yield) — a UI-blocking cost, not a memory one.

---------------------------------------------------------------------------
## 6. Loom

LoomEngine (loom/engine.js:31-146) holds no PCM: play() schedules
AudioBufferSourceNodes against `this.engine.buffer` (:46, :81) and keeps only
node/timer handles in `_voices` / `_timers` / `_bus` (:36-40), all cleared in
stop() (:109-137). Fact: zero additional bytes. Same open question as the nodes
stages about whether the engine copies a buffer whose channel data has been
exposed (Chrome: believed shared).

---------------------------------------------------------------------------
## 7. Quick wins (this subsystem only)

1. **Drop the old render before re-rendering** — bench-controller.js:593-612.
   Null R.renderedBuffer / renderedMono / renderedPeaks, setAb('a') and hide the
   A/B toggle at the top of the click handler. Saves 254 MB of peak on every
   re-render at 96 kHz (127 MB at 48 kHz). Risk: low — the toggle is re-shown at
   :622 anyway; a stale-mid-render source swap already resets via generation.
2. **Denoise worker: 7 → 4 channel-units** — workers/denoise-worker.js.
   (a) wssP (:148) is constant 1.5 in the interior by the code's own comment
   (:174-177); compute it only within N_FFT of each edge → −83.7 MB/ch.
   (b) Divide in place into outP and transfer outP.buffer with byteOffset/len
   instead of allocating `out` (:177) → −83.7 MB/ch. (c) Stop referencing
   `samples` after building `padded` (:63-69) so the transferred input is
   collectable → −83.7 MB/ch. Worker peak 586.7 → 335 MB per channel. Risk:
   low-medium; numerically identical output; needs the denoise tests re-run.
   Bigger but riskier: store the mask (magDb, 167.8 MB/ch, :75) as Uint8/Float16
   → −84 to −126 MB/ch.
3. **Loudnorm: release dead buffers and correct in place** — loudnorm.js:63-84.
   Make `gained`/`corrected` `let` and null them right after processLimiter
   returns; apply the corrective gain in place on `limited` (loudnorm owns it —
   it is the limiter's fresh output) instead of allocating `corrected`. Worst
   case 1004 → 502 MB above baseline (input + limited1 + limited2 + scratch;
   limited1 can be nulled before the second limiter if the in-place gain is used).
   Risk: low.
4. **Cache the "before" loudness per source generation** — bench-controller.js:607.
   R.buffer does not change between renders (repairs aside; key on R.generation
   + repairs length). Saves one 167.4 MB copy + a full measurement per render.
   Risk: low.
5. **Stream the WAV to disk** — export.js:71,163. showSaveFilePicker +
   WritableStream writes ~8 MB chunks with no whole-file ArrayBuffer and no Blob:
   −335 MB peak for a float export at 96 kHz. Chromium-only; keep the Blob path
   as fallback. Risk: medium.
6. (Out of this subsystem, largest lever) decode at the file's own rate — halves
   every row above.

---------------------------------------------------------------------------
## 8. Open questions

1. Does V8's generator liveness analysis release `gained` / `corrected` in
   processLoudnorm at the await? Decides 670 vs 1004 MB for the loudnorm stage.
   Testable with a DevTools heap timeline during a loudnorm-only render.
2. Does Chrome copy an AudioBuffer's channels on `src.buffer = buffer` when
   getChannelData has already exposed them (spec "acquire the content")? If yes,
   every nodes stage and every loom voice adds a hidden F·C·4.
3. Where does a 167 MB Blob live — renderer heap, browser-process blob storage,
   or disk-backed — and does it count toward whatever kills the tab at ~780 MB?
4. Does the idle loudness worker release its 167 MB transferred copy promptly
   after `done`, or hold it to its next GC? Same for the denoise worker between
   channel 0 and channel 1 (586 vs 1173 MB).
5. Does Chrome allocate an OfflineAudioContext destination in full at
   construction (assumed) — measurable by constructing one without rendering.
6. Does test/run.mjs cover denoise-worker numerics closely enough to protect
   quick win 2 (wssP constant, in-place division)?
