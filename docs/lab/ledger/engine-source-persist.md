# Ledger · engine-source-persist (2026-09-03)

Scope: js/audio-engine.js, js/app/source-controller.js, js/app/persist.js,
js/app/persist-controller.js, js/app/project-store.js, js/app/project-bundle.js,
js/dsp/native-rate.js. Cross-references into repair/bench/field-library are
cited where they hold a pointer to something this subsystem allocated.

Method: code read by line range only; no test run; no edits. Every allocation
cites file:line. FACT = read in code (or Web Audio spec, marked "spec").
INFERENCE = browser-internal behaviour or size estimate not observable from JS.

Reference case "Traum": 218 s, 48 kHz, stereo, 16-bit WAV (42 MB encoded,
per the scout's Experiment 1). Context runs at 96 kHz, so the live-context
decode yields F96 = 218 × 96 000 = 20 928 000 frames, C = 2.
For comparison, F48 = 10 464 000.

## 1. Steady-state resident set after one load (FACT)

| # | allocation | formula | Traum bytes | allocated at | released at | held by |
|---|---|---|---|---|---|---|
| A1 | decoded AudioBuffer | F·C·4 | 167 424 000 (167.4 MB) | audio-engine.js:71 (`ctx.decodeAudioData`) or :66 (offline path) | next `engine.load` (:82 overwrite) / `engine.clear()` (:97) / `clearSource()` source-controller.js:182 | `engine._buffer` (:82), `R.buffer` (source-controller.js:113), `R.original.buffer` once a repair exists (repair-controller.js:68) |
| A2 | mono mixdown | F·4 | 83 712 000 (83.7 MB) | audio-engine.js:355 (`mixdownMono`, called :83) | same as A1 (:83 overwrite, :98, source-controller.js:183) | `engine._mono` (:83), `R.mono` (:114), `R.peaks.mono` (peaks.js:8 — reference, not copy), `waveMini.mono`/`waveMain.mono` (waveform.js:69 via source-controller.js:129-130), `waveRack`/`previewMono` (bench-controller.js:487-488), `R.original.mono` once a repair exists |
| A3 | peak pyramid | 2·4·F·(1/64+1/512+1/4096) ≈ 0.1426·F | 2 983 880 (2.98 MB) | peaks.js:31-32,51-52 via source-controller.js:121 | source-controller.js:189 (`r.peaks = null`), or overwrite at :121 | `R.peaks`, and each waveform view's `_pyr` (waveform.js:72) |
| A4 | encoded source bytes | byteLength of file | 41 856 044 (41.9 MB; WAV = PCM+44) | source-controller.js:85 (`ab.slice(0)`) | source-controller.js:187 (`r.sourceBytes = null`) or overwrite at :118; never after the OPFS write | `R.sourceBytes` (:118). Only size-readers elsewhere: loom/controller.js:12,135; machine/controller.js:42,69,82; persist.js:20-21,159-165 |
| — | **total** | | **295 975 924 ≈ 296.0 MB** | | | matches scout's 293 MB (scout rounded) |

Same file decoded at its native 48 kHz (the offline path, audio-engine.js:59-66,
taken today only when the file is ABOVE the context rate): A1 = 83.7 MB,
A2 = 41.9 MB, A3 = 1.49 MB, A4 = 41.9 MB → **168.9 MB. Native-rate decode
saves 127.1 MB for Traum** (43% of the load footprint). The scout's Experiment 1
established that an AudioBufferSourceNode resamples a 48 kHz buffer on a
96 kHz context correctly, so playback needs no change.

The AudioContext is created with no `sampleRate` option (audio-engine.js:264-268:
`new Ctx()`), so it takes the device rate — 96 kHz on this machine. FACT.

## 2. The decode path, step by step (source-controller.js:81-122 + audio-engine.js:43-91)

1. `ab` arrives from `file.arrayBuffer()` (:53), `resp.arrayBuffer()` (:70, :363),
   the streamed concatenation (:358-361), OPFS (`persist-controller.js:423`),
   the .yjkt parse (`persist-controller.js:256`), or MY SHELF (`field-library.js:251`).
2. `sourceBytes = ab.slice(0)` (:85) — **copy #2 of the encoded bytes**.
3. `sha256Hex(sourceBytes)` (:88) — `crypto.subtle.digest` over a view
   (fingerprint.js:15-16); no JS-visible copy. INFERENCE: the browser may copy
   into the crypto thread transiently.
4. `engine.load(ab)` (:95):
   - `probeContainer` (audio-engine.js:45) reads the header through a
     `Uint8Array` view (native-rate.js:53-59); no copy. WAV/FLAC only; MP3/AAC
     return `EMPTY_PROBE` (native-rate.js:167-170).
   - `planDecodeRate` (:46-54) — pure arithmetic.
   - Branch `plan.rate > ctx.sampleRate && probe.seconds > 0` (:56): only for
     files ABOVE the context rate. Then `arrayBuffer.slice(0)` (:66) is
     **copy #3**, consumed (detached) by the offline decode; `ab` survives
     intact but unreferenced after `load` returns → garbage.
   - Otherwise `ctx.decodeAudioData(arrayBuffer)` (:71). Spec: decodeAudioData
     detaches its input, so `ab` drops to 0 bytes here (the code relies on
     this at :62-65). After this line only `sourceBytes` holds the encoded
     file. FACT (spec + code comment); not measured in this build.
   - INFERENCE (browser internal): Chromium decodes to the file's own rate
     first and then resamples to the context rate, so during decode there is
     a transient F48·C·4 = 83.7 MB native PCM alongside the growing
     167.4 MB output. Not observable from JS (Experiment 1 showed the JS heap
     counter is blind to AudioBuffer storage).
   - `mixdownMono` (:83) allocates A2 and reads every channel via
     `getChannelData` (:358) — no channel copies.
5. `store.update('source', …)` (:101) — note this pushes an undo snapshot of
   the PREVIOUS document first (project-store.js:225-226). JSON only, see §4.
6. `buildPeakPyramid(r.mono)` (:121) allocates A3.
7. `spec.compute(R.mono, …)` (:155) and `runAnalysis` (:163) — other
   subsystems, but `runAnalysis` copies mono: `R.mono.slice()` (:260) is a
   **transient F·4 = 83.7 MB** transferred to the analysis worker (:262). The
   worker consumes it in `onsetAnalysis` (workers/analysis-worker.js:54-62)
   and caches only the envelope/onsets (:28-29, :67); the mono becomes
   unreachable when the message handler returns. INFERENCE: freed at the
   worker's next GC; not pinned.

Peak encoded-byte multiplicity during a load (FACT, from the copies above):
- openFile / loadDemo / OPFS restore / MY SHELF: 2× until the decode detaches
  `ab` → 1× (sourceBytes) after. Traum: 83.7 MB transient → 41.9 MB.
- loadFromUrl streaming (:344-361): `parts` chunks (1×) + `buf` (1×) +
  `sourceBytes` (1×) = **3× = 125.6 MB** until decode detaches `buf`; then
  `parts` (41.9 MB) stays reachable in the `try` frame until `loadArrayBuffer`
  resolves and `loadFromUrl` returns (:366). The decode, spectrogram kick-off
  and peaks all run inside that window. FACT that the binding is live;
  INFERENCE that V8 does not collect it early.
- .yjkt import (persist-controller.js:235 → project-bundle.js:232, :263 →
  source-controller.js:85): zip buffer (1×) + `readBundle` entry slice (1×,
  :232) + `parseProjectEntries` slice (1×, :263) + `sourceBytes` (1×) =
  **up to 4× = 167.4 MB** of encoded bytes transiently, plus the same 3×
  pattern for every `samples/*.f32` (:269). The :263/:269 slices are
  redundant: `Uint8Array.prototype.slice` at :232 already produced a
  standalone buffer of exactly that length (byteOffset 0).
- Files above the context rate (offline branch): `ab` + `sourceBytes` +
  `ab.slice(0)` = 3× until the offline decode detaches the slice.

## 3. Persistence: OPFS writes and what stays in memory (FACT)

- Autosave listens to every store change (persist-controller.js:153) with an
  800 ms debounce (:15, :162) and flushes on `visibilitychange`/`pagehide`
  (:289-300). `saveNow` (:165-197): `serializeProject(P, R)` (:171) builds
  JSON + per-sample f32 copies (persist.js:71-82, `sampleBytes` — machine
  samples only, never the source), then writes `source.bin` (:180) once per
  generation (`bytesGeneration`, :29, :177-182), then `project.json` (:189).
- `opfs.writeBytes` (persist.js:554-560) hands the live `ArrayBuffer` to
  `FileSystemWritableFileStream.write`. No JS copy. INFERENCE: Chromium
  copies it into a swap file in the browser process, committed on `close()`.
- **The encoded bytes ARE written to OPFS (`source.bin`) ~0.8 s after every
  load, and the in-memory copy (A4) is retained regardless.** After the write,
  the only readers of the bytes themselves are: `exportProject` (:211,
  `projectEntries` → project-bundle.js:246), `keepLoaded` in MY SHELF
  (field-library.js:226 → mine.js:173, a second OPFS directory
  `yellowjacket-mine-v1`, mine.js:11,125-126,198 — disk, not memory), and
  `saveNow` again only if the generation changed (:179). Everything else reads
  `byteLength` (loom/controller.js:12,135; machine/controller.js:42,69,82;
  persist.js:20-21,165). So A4 is droppable after the OPFS write resolves,
  provided export/keep re-read `source.bin` and the size survives as a number.
  Two couplings: `discard()` wipes the whole OPFS dir including `source.bin`
  (:500 → persist.js:599-606) while the session stays live, and Safari has no
  `createWritable` so `opfs` is null (persist.js:532-539) and the copy must
  stay.
- `project.json` carries `sourceBytes: { size }` only (persist.js:165). No PCM,
  no encoded bytes in the JSON. FACT.

## 4. Undo snapshots (FACT): JSON only, never PCM

- `store.update()` (project-store.js:222) calls `this._snapshot.take()` before
  every mutation except `'history'` (:225-226), capped at `historyLimit = 60`
  (:182, :227). `take` is `takeHistorySnapshot` (persist-controller.js:356-368,
  attached at :369).
- `takeHistorySnapshot` → `snapshotDoc` (persist.js:132-134) →
  `serializeProject(project, runtime, /*skipPcm*/ true)`: `sampleFiles` stays
  empty (persist.js:151), `sourceBytes` becomes `{ size }` (:165), and
  `runtime.buffer / mono / peaks / original / renderedBuffer` are never read.
  **No source PCM and no encoded bytes in any undo entry.**
- `clone` (persist.js:60) turns typed arrays into plain arrays
  (`Array.from`) — the 64 × `Uint8Array(64)` step grids become 4 096 boxed
  numbers per snapshot (~32 KB in V8) plus `words`, `clips`, `loom.plans`,
  `studio`, `repairs`. INFERENCE: 0.1–0.5 MB per snapshot; ≤ 60 deep → ≤ ~30 MB
  worst case, typically well under 10 MB. Not the 780 MB story.
- `historyPcm` (persist-controller.js:355-366) is a `WeakMap` from each
  snapshot doc to a `Map` of machine `track.sample` objects — **references,
  not copies** (:364-366). Consequence: a machine sample the user deletes from
  the kit stays resident until the last snapshot referencing it rotates out
  of the 60-deep history or `clearHistory()` runs (project-store.js:197;
  called on restore :466 and import :266, NOT on a plain `openFile`). Bounded,
  by design; source PCM is never in it.
- `_step` (project-store.js:205-219) takes one more snapshot for the redo
  side; same JSON-only shape.

## 5. Resume / restore after a reload (FACT)

Boot (persist-controller.js:123-156) only reads `project.json` and shows the
panel; nothing auto-loads. On RESUME (:403-490):
1. `opfs.readJson('project.json')` (:410).
2. `opfs.readBytes('source.bin')` (:423) → `file.arrayBuffer()`
   (persist.js:567): **1× encoded** (41.9 MB).
3. `ctx.api.loadArrayBuffer(bytes, …)` (:435) → `sourceBytes = bytes.slice(0)`
   (2×), then `ctx.decodeAudioData(bytes)` detaches `bytes` → back to 1×.
   Resident set after restore = §1, identical to a fresh load.
4. `applySnapshot` (:441) touches only `runtime.repairs` (persist.js:481-483);
   machine samples are re-read from `samples/<id>.f32` (:451) and
   `hydrateSample` (persist.js:194-203) copies each channel out of the flat
   file (`flat.slice`, :201) — 2× per sample transiently, 1× retained.
5. `store.clearHistory()` (:466), then `scheduleSave()` (:488).
6. **Redundant write:** `bytesGeneration` starts at −1 (:29) and nothing in
   `restore()` sets it, so the first autosave after a resume re-writes the
   41.9 MB `source.bin` it just read (:179-181). Disk churn, not RAM; on a
   machine already at 16/17 GB swap, avoidable churn.

`document.wasDiscarded` (scout Experiment 1) is not consulted anywhere in this
subsystem: after a Chrome tab discard the user sees the RESUME panel and must
click. FACT (rg: no `wasDiscarded` in js/).

## 6. The `overBudget` branch for files AT OR BELOW the context rate (FACT)

- `planDecodeRate` (native-rate.js:184-224): for `native <= contextRate`
  (:197-208) it computes the full retained footprint AT THE CONTEXT RATE
  (:198-199, `decodedFootprintBytes` :43-50 = A1+A2+A3+A4) and returns
  `{ rate: contextRate, downgraded: false, upsampled, overBudget: over,
  reason: over ? budgetReason(...) : null }`.
- `engine.load` (audio-engine.js:46-54) receives that plan. The only use of
  `plan` is `plan.rate > ctx.sampleRate` (:56 — false on this branch) and
  `reason: plan.reason` (:79). `plan.overBudget` is read nowhere in js/
  (rg: only definitions in native-rate.js; the one reader is test/run.mjs:3613).
- So the decode at :71 proceeds unconditionally at the context rate. The
  `reason` string is copied into `decodeReport`, but the status logic in
  source-controller.js:138-150 prints it only when `downgraded` is true
  (:138); on this branch `upsampled` wins (:140) and the user sees
  "LOADED · 48 kHz SOURCE, UPSAMPLED TO 96 kHz TO MATCH THE OUTPUT". **The
  budget is computed, exceeded, and silently ignored.**
- Where the line sits at 96 kHz stereo with a 16-bit 48 kHz WAV source:
  per second = 96 000 × (8 + 4 + 0.1426) + 192 000 ≈ 1.358 MB/s, so
  768 MiB (805.3 MB) is crossed at **≈ 593 s (9.9 min)**. Traum (218 s,
  296 MB) is under it; a 10-minute lossless file is over it and decodes
  anyway. At native 48 kHz the same budget reaches ≈ 1 039 s (17.3 min).
- There is no lower rate to fall back to on this branch, so the only honest
  behaviours are (a) decode at the file's native rate (halves the footprint)
  and (b) if still over budget, refuse with the message, or decode and warn.
  Today it is neither.

## 7. Other holders of this subsystem's PCM (cross-references, FACT)

- Repairs: `captureOriginal` (repair-controller.js:67-68) stores
  `{ buffer: R.buffer, mono: R.mono }` in `R.original`, then `rebuild`
  allocates a NEW same-length `AudioBuffer` (+ mono) as `R.buffer/R.mono`
  while any repair is enabled. Doubles A1+A2 (+251 MB for Traum at 96 kHz)
  until `resetForSource` (:255) on the next load. Ledger: repair subsystem.
- Bench A/B: `engine.setAltBuffer(R.renderedBuffer)` (bench-controller.js:641)
  — reference only; the rendered buffer itself is the bench's.
- Waveform views hold `mono` and the pyramid by reference (waveform.js:69,72);
  `clearSource` nulls them via `setBuffer(null, …)` (source-controller.js:192-193).
- Export: `serializeProject` (copies machine samples, persist.js:76) →
  `buildBundle` allocates the whole zip (`out`, project-bundle.js:101: source
  + samples + JSON) → `crc32` pass over the source → `download` wraps it in a
  `Blob` (export.js:226; INFERENCE: browser copies into blob storage), object
  URL revoked after 1 s (:235). Transient ≈ 2× encoded on top of A4.

## 8. Releasable?

| allocation | releasable now? | how |
|---|---|---|
| A1 decoded buffer at 96 kHz | half of it | decode at native rate via the offline path (§6, quick win 1) |
| A2 mono | half of it | follows A1 |
| A3 peaks | half of it | follows A2 |
| A4 encoded bytes | yes, after OPFS write | drop after `writeBytes` resolves for the live generation; export/keep re-read `source.bin`; keep when `opfs` is null; guard `discard()` (§3, quick win 2) |
| loadFromUrl `parts` | yes | `parts.length = 0` after :360 |
| import 3rd/4th copies | yes | pass the :232 slice's buffer through; skip :263/:269 slices when the view spans its buffer |
| undo docs | no need | JSON, bounded |
| `historyPcm` refs | by design | bounded by 60; `clearHistory` on source swap would shorten it |

## 9. Open questions

1. Chromium decodeAudioData internals: is the native-rate PCM materialised
   before resampling (transient +83.7 MB for Traum)? Not observable from JS;
   needs `chrome://tracing` or the task manager's per-tab memory.
2. Does this Chromium build detach `ab` on `ctx.decodeAudioData` (spec says
   yes; the code assumes it at audio-engine.js:62-65)? If it did not, `ab`
   would still be garbage after `load`, so the steady state is unchanged;
   only the transient differs.
3. For MP3/AAC/OGG sources `probeContainer` returns `EMPTY_PROBE`
   (native-rate.js:167-170) so native-rate decode has no rate to build an
   OfflineAudioContext with. Options: decode via the live context as today
   (upsampled), or add a minimal MP3/ADTS frame-header probe. Which sources
   dominate Ian's use (FIELD library is MP3; THE SHELF is lossless)?
4. Does `benchClear`/`benchReset` drop `previewMono`, `waveRack` and the
   rendered buffer on source swap (bench-controller.js:487-488)? Bench ledger.
5. Is the analysis worker's `msg.mono` collected promptly (worker heap,
   83.7 MB transient)? INFERENCE yes; unverified.
6. Should `openFile` call `store.clearHistory()` the way restore/import do,
   so a source swap does not keep 60 JSON docs (and, via `historyPcm`,
   previously deleted machine samples) alive?
7. After a tab discard, `document.wasDiscarded === true` could trigger a
   silent restore instead of the RESUME click; the restore path is already
   idempotent and validates before destroying (§5).
