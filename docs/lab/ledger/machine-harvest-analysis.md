# Ledger · machine-harvest-analysis

Audit of PCM and large-array allocations in the MACHINE / HARVEST / ANALYSIS
subsystem. Companion to `docs/lab/2026-09-03-memory-scout.md`. Read by line
ranges on 2026-09-03; no source edited, no tests run.

Legend: **[F]** = fact read in code (file:line cited). **[I]** = inference.

## Reference case ("Traum")

218 s, 48 kHz stereo, decoded at the 96 kHz context → F = 218 × 96 000 =
**20 928 000 frames**, C = 2. Float32 everywhere. F·4 = **83 712 000 B**
(83.7 MB). Every number below that says "Traum" uses these values.

Every rate in this subsystem inherits the DECODED rate: slices are cut at
`buf.sampleRate` (controller.js:474–483), the sequencer renders at
`max(44100, max track sample rate)` (sequencer.js:1425–1433), harvest and
analysis run on `R.mono` at `R.sampleRate`. So the scout's 2× upsample
multiplier propagates into every byte counted here. [F]

## Headline answers

1. **Workers receive a COPY that is then TRANSFERRED.** Both callers do
   `const copy = R.mono.slice(); worker.postMessage(payload, [copy.buffer])`
   (harvest: controller.js:1022–1026; analysis: source-controller.js:263–266).
   The copy exists so `R.mono` itself is not detached. Net: one extra F·4
   allocation (83.7 MB for Traum) per job, owned by the worker for the job's
   duration, then unreferenced. Neither worker retains mono after the job
   (harvest-worker.js:10–19 keeps nothing; analysis-worker.js:29 caches only
   `{envelope, onsets}`). [F]
2. **Undo snapshots do not copy PCM, but they do RETAIN it.** History docs are
   JSON built with `skipPcm = true` (persist.js:132–133, :151). The
   controller then parks every `track.sample` reference in a WeakMap keyed by
   that doc (persist-controller.js:355–367) so undo can re-attach audio. A
   sample cleared or replaced on a track therefore stays resident until every
   history entry referencing it has rolled off (`historyLimit = 60`,
   project-store.js:182, plus the redo stack). Bounded, by design, and easy to
   mistake for a leak in a heap snapshot. [F]
3. **The crate keeps nothing resident.** `put()` writes the sample's own
   ArrayBuffer to OPFS without a copy when it is a whole buffer
   (crate.js:169–176); `list()` reads only `index.json` (crate.js:151–153);
   `get()` reads one `.f32` into a fresh Float32Array that becomes the track's
   `channels[0]` (crate.js:155–162, controller.js:1078–1093). Crated
   instruments are mono: `pcm: track.sample.channels[0]` (controller.js:1062). [F]
4. **No PCM copy of the source is held by the machine.** Auditions play
   `engine.buffer` directly (cliprefs.js:95, :113); semantic-take events play
   `R.buffer` directly (controller.js:66–76 hands the reference through
   `bufferFor`, loom/schedule.js:24 sets `src.buffer = sourceBuffer`); the
   sequencer stores only the resolver, never the buffer (sequencer.js:106–121). [F]
5. **What the machine DOES hold is slices, up to three times over:** the
   Float32 slice in `track.sample.channels` (project state), a forward
   `AudioBuffer` of it in the sequencer cache, optionally a reversed one, plus
   one fitted `AudioBuffer` per distinct (reverse, fitSec, offset, slice) key,
   with no eviction until the track is bumped (sequencer.js:123–152). [F]

## Allocation ledger

| # | What | Where (file:line) | Formula | Traum bytes | Allocated | Released | Held by |
|---|------|-------------------|---------|-------------|-----------|----------|---------|
| A1 | Harvest mono copy | js/machine/controller.js:1022 | F·4 | 83 712 000 (transient) | on HARVEST click | end of worker job (local `msg.mono`, harvest-worker.js:14) | worker stack only |
| A2 | Analysis mono copy | js/app/source-controller.js:263 | F·4 | 83 712 000 (transient) | on load / re-analyze with mono | end of `onsetAnalysis` (analysis-worker.js:54–66) | worker stack only |
| A3 | Onset envelope (worker cache) | workers/analysis-worker.js:67 | (⌊(F−1024)/512⌋+1)·4 | 163 496 | per generation | replaced on next generation | module `cache` |
| A4 | Onset envelope + onsets + beats (main copy) | workers/analysis-worker.js:103 (structured clone, no transfer) → js/app/source-controller.js:242 | same as A3 + onsets·4 + beats·4 | ≈170 000 | on `done` | replaced on next `done`; `R.analysis` | `store.runtime.analysis` |
| A5 | onsetAnalysis scratch | js/analysis/onsets.js:19–23, :46, :55 | 3·frames·4 + 4·1024·4 + 2·512·4 | ≈502 000 (transient) | per analysis | return | — |
| A6 | trackBeats scratch | js/analysis/beattrack.js:25, :40, :66–67 | env F32 + score F32 + back I32 = 3·n·4 | ≈490 000 (transient) | per analysis | return | — |
| A7 | Harvest FFT tables (worker module scope) | js/analysis/harvest.js:188–189, :226, :316; js/fft.js:7,14,15,66 | FFT(2048)+FFT(16384)+hann(2048) | ≈155 648 | first harvest | never (worker never terminated, controller.js:957–969) | worker module |
| A8 | Harvest per-candidate scratch | js/analysis/harvest.js:229–231, :317–318 | 8 192 + 16 384 + 131 072 | ≈156 000 per candidate (transient) | per onset window | return | — |
| A9 | Harvest candidates / picks | js/analysis/harvest.js:560, :483 | ≈ n_onsets small objects; ≤ 24 picks | KBs | per harvest | picks cloned to main; candidates dropped | `P.clips[i].features` (controller.js:995) |
| A10 | Track slice (harvest-seated) | js/machine/controller.js:483 (`sliceForTrack`) | C·n·4, n ≤ 1.2 s·rate (MAX_WINDOW_SEC harvest.js:20) | 921 600 per track; 8 tracks = 7 372 800 | on harvest / assign | on `cleartrack` (controller.js:585) or replacement — but see A20 | `P.machine.tracks[i].sample.channels` |
| A11 | Track slice (manual ASSIGN) | js/machine/controller.js:564 | C·n·4, n ≤ 30 s·rate (MAX_TRACK_SAMPLE_SEC :21) | ≤ 23 040 000 per track; 8 tracks ≤ 184 320 000 | on assign | as A10 | same |
| A12 | Sequencer forward AudioBuffer | js/machine/sequencer.js:133 → :1140–1152 | C·n·4 (mirror of A10/A11) | = A10/A11 per track | first trigger / prebake after bump | `bumpTrack` (:211–214), `setMachine` with a new machine object (:100–104) | `_bufferCache[i].buffer` |
| A13 | Sequencer reversed AudioBuffer | js/machine/sequencer.js:150 | C·n·4 | = A10/A11 per track | first reversed trigger | as A12 | `_bufferCache[i].rbuffer` |
| A14 | Fitted AudioBuffer(s) | js/machine/sequencer.js:136–146 → :1108–1133 | C·round(fitSec·rate)·4 per key; fitSec = fitSteps·15/bpm, fitSteps ≤ 64 (compile.js:46) | e.g. 16 steps @120 BPM = 2 s → 1 536 000 per key | first trigger with fit, or `prebake` (:157–192) | **never evicted** until `bumpTrack`; BPM changes (controller.js:594–598) add keys without bumping | `_bufferCache[i].fitted` Map |
| A15 | Stretch scratch (per channel, per bake) | js/dsp/stretch.js:90 (sanitize copy n·4), :236 (WSOLA out), :320 (pad), :336–337 (acc+norm F64 2·rawLen·8), :439 (out); reversed adds `Float32Array.from(channel).reverse()` sequencer.js:1124 | ≈ n·4 (+n·4 reversed) + 16·outLen + 2·outLen·4 | 30 s slice fitted to 16 s @96k: ≈11.5 + 24.6 + 6.1 MB ≈ 42 MB (transient, main thread, synchronous) | during bake | return | — |
| A16 | Offline-render per-track buffers | js/machine/sequencer.js:312–325, :396–409, :605–621 (`buffers[]`, `cache` Map) | Σ tracks C·n·4 (+ fitted) built on the OfflineAudioContext | = A12(+A14) again | per FREEZE / PRINT / SONG render | render function return | local |
| A17 | Offline render + master limiter | js/machine/sequencer.js:296, :429–431, :1299–1315; js/dsp/limiter.js:38, :61, :72 | rendered 2·N·4 + limited 2·N·4 + peaks N·4 + gMin N·4 = 24·N; N = renderSec·max(44.1k, max sample rate) | 60 s @96k: 138 240 000 (+ WAV 4·N = 23 MB @16-bit) | per render | after `download` | local |
| A18 | Space-rack plate IR | js/machine/sequencer.js:1330–1333; js/dsp/space.js:177–192 | 2·(verbSec + pre)·ctxRate·4; verbSec ≤ 10 (space.js:25) | default 2.012 s @96k = 1 545 216; max 7 833 600 | live: first play / setting change; offline: per render | live rack replaced on sig change (:194–209); offline with render | `this._rack`; ConvolverNode internal copy [I] |
| A19 | Drive curves | js/machine/sequencer.js:52–68 | 2048·4 per distinct driveDb | 8 192 per key | first use | never | module `driveCurves` Map |
| A20 | Undo history PCM retention | js/app/persist-controller.js:355–367; js/app/project-store.js:182, :226 | references only (0 new bytes); keeps replaced/cleared samples alive | up to 60 docs × all samples referenced at that time | every `store.update` | when the doc leaves `_past`/`_future` | `historyPcm` WeakMap |
| A21 | Autosave sample serialization | js/app/persist.js:73–83, :151; js/app/persist-controller.js:171 | Σ referenced assets C·n·4, allocated on EVERY save even when `samplesWritten` will skip the write | = total kit bytes per debounce (transient) | per save | after write loop | local |
| A22 | Crate get (load instrument) | js/app/crate.js:159–161 → js/machine/controller.js:1093 | frames·4 (mono) | 1.2 s @96k = 460 800 | on LOAD | as A10 | `track.sample.channels[0]` |
| A23 | Crate put | js/app/crate.js:169–176 | 0 extra (whole buffer) or n·4 (subarray) | 0 | on CRATE | — | OPFS file only |
| A24 | Factory kit PCM cache | js/machine/kits.js:165, :188–213; js/machine/drum-dsp.js:373 | Σ voices seconds·96000·4 per kit; three kits (kits.js:30, :72, :114), voice seconds 0.09–0.9 | ≈1.3 MB per kit, ≈3.9 MB all three | first render of each kit | **never** (module CACHE) | `CACHE`; shared by reference into `track.sample` (kits.js:184) |
| A25 | Drum DSP internal | js/machine/drum-dsp.js:358 | seconds·384000·8 (Float64) + resample output | ≤ 2 764 800 per voice (transient) | per voice render | return | — |
| A26 | Modal fit | js/machine/controller.js:1258 (slice n·4), js/analysis/modal.js:242 (input), :263 (centered), :305 (residual), :302 (`synthModal` model), :67–68 re/im at nextPow2(4n) + FFT tables | 5·n·4 transient; residual n·4 retained; FFT ≈ 2·nextPow2(4n)·4 + tables | 1.2 s clip: 5 × 460 800 transient, residual 460 800 retained; FFT ≈ 8.4 MB transient | on FIT | residual retained until next fit; **never cleared on source load** | closure `modalFit` (controller.js:1246) |
| A27 | Synth PCM | js/machine/controller.js:1164; js/machine/synth.js:15, :214 | seconds·rate·4, seconds ≤ 8 | ≤ 3 072 000 | per formula edit | replaced on next formula; never on source load | closure `synthPcm` (controller.js:1129) |
| A28 | Loop export | js/machine/controller.js:407–413 | C·n·4 AudioBuffer + WAV 2·C·n | clip-sized (transient) | on export | after download | — |
| A29 | Kit print | js/machine/controller.js:123–128; js/machine/sequencer.js:487–531 | ≤ 12 s·rate·4 offline mono + `.slice()` + 44.1k resample, ×8 | ≤ 4.6 MB per voice (transient) | on PRINT KIT | after download | — |
| A30 | Preview / play scratch | js/machine/controller.js:1184–1185, :1266–1267 | pcm.length·4 AudioBuffer | ≤ 3 MB (transient) | per preview | when the source node ends [I] | Web Audio graph |

Notes on the table:
- A10 vs A11: HARVEST windows are capped at 1.2 s (harvest.js:20), so a
  harvested kit is small (7.4 MB for eight stereo slices at 96k). The 30 s cap
  only bites on manual ASSIGN of a long clip. [F]
- A12–A14 are Web Audio `AudioBuffer`s created on the live context
  (`ctx.createBuffer`). They live in the renderer process alongside the JS
  heap; whether Chrome's task manager attributes them to "JavaScript memory"
  or to Blink is not something the code can tell you. [I]
- A17 is really the render lane's cost, but `masterLimit` and the offline
  contexts live in sequencer.js, and a 96 kHz kit forces a 96 kHz render.

## Lifetimes, in prose

**Per source load** (`store.update('source')`, source-controller.js:101–110):
`R.mono`/`R.buffer` are replaced upstream; `P.clips` is emptied in place; the
analysis worker's cached envelope is orphaned by the new generation id and
replaced on the next analysis (analysis-worker.js:67). `resetForSource`
(controller.js:837–843) only re-points the slice UI at the new mono
(slice-ui.js:95–99 stores the reference, no copy). **Nothing in this
subsystem frees on source load** — by design the kit (A10–A14, A24) is
document state and survives; incidentally `modalFit` (A26) and `synthPcm`
(A27) survive too, and their rate (`modalRate`, captured at fit time) may no
longer match the new context.

**Per track replacement**: `track.sample` is overwritten (controller.js:531,
:574, :585, :1093, :1209, :1351) and `sequencer.bumpTrack(i)` nulls the cache
entry (sequencer.js:211–214). The old slice is then referenced only by
history docs (A20) and, for scene-inherited refs, by other scenes
(controller.js:718–722 shares references across scenes; persist.js:145–151
dedupes by asset id on save).

**Per worker job**: A1/A2 are allocated on the main thread, transferred,
consumed, and dropped with the worker's message scope. Peak during HARVEST on
Traum is therefore `R.mono` (83.7 MB, engine-owned) + A1 (83.7 MB) — and
HARVEST cannot overlap ANALYSIS because it requires `R.analysis.onsets`
(controller.js:960). [F]

**Per undo step**: `takeHistorySnapshot` runs on every `store.update` except
`history` (project-store.js:225–227). The doc is JSON without PCM; the WeakMap
entry holds references to every current `track.sample`. Cost per step is the
JSON doc (KBs) — but the retention effect (A20) means "clear track" does not
free the slice until ~60 later mutations. [F]

## Retained across source loads (the FOCUS question)

| Held | Bytes (Traum-derived) | Why | Releasable? |
|------|------------------------|-----|-------------|
| `track.sample.channels` ×8 (A10/A11) | 7.4 MB typical, ≤184 MB cap | kit is document state | Only by user clear; could be halved by decimating slices to the source's native rate |
| `_bufferCache` forward/reversed/fitted (A12–A14) | ≥ equal to A10/A11, plus fitted | play-path cache | Yes: evict on source load or on BPM change; rebuild is a `createBuffer` + `set` |
| Factory kit `CACHE` (A24) | ≈1.3 MB per kit rendered | avoid re-rendering 384 kHz DSP | Yes but small |
| `historyPcm` refs (A20) | up to all past samples | undo re-attach | Yes: drop `_past` on source load, or key by asset id with refcount |
| Analysis worker `cache` (A3) | 163 KB | anchor re-runs | trivial |
| Harvest worker module (A7) + idle isolate | ≈155 KB + isolate overhead [I] | never terminated | `terminate()` after job |
| `modalFit.residual` (A26), `synthPcm` (A27) | ≤ a few MB | closures | Yes: null on source load |

## Leaks (retention with no release path in normal use)

1. **Fitted-buffer accumulation** — sequencer.js:136–146. `fitted` is a Map
   keyed by `fitKey(reversed, fitSec, offsetSec, sliceSec)` (:1095–1101).
   fitSec is derived from BPM (compile.js:139), and the BPM handler
   (controller.js:594–598) updates the store without `bumpTrack`, so every
   distinct tempo the user passes through leaves a fitted `AudioBuffer` in the
   map for each fitted track. [F: no eviction code] [I: growth rate depends on
   how the BPM control quantizes.] Each entry is C·fitSec·rate·4 (1.5 MB for
   2 s stereo at 96k).
2. **`modalFit` / `synthPcm` closures** — controller.js:1246, :1129. Never
   nulled on source load; small but rate-stale.
3. **`driveCurves`** — sequencer.js:52. 8 KB per distinct driveDb; unbounded
   if driveDb is continuous. [F: no eviction] [I: practical size depends on UI
   quantization.]
4. **Idle workers** — controller.js:957, source-controller.js:226. Neither is
   ever terminated. They hold no PCM; the cost is the isolate. [I on size.]

Not leaks, but worth knowing: A20 (undo retention) and A24 (kit cache) are
bounded and intentional.

## Quick wins (this subsystem only)

1. **Decode at native rate upstream** — zero changes here, halves A1, A2,
   A10–A17 and the render rate for a 48 kHz file. Listed because every
   number in this ledger is a consequence of it (controller.js:474–483 cut at
   `buf.sampleRate`; sequencer.js:1425–1433 render at max sample rate).
   Saving on Traum: 83.7 MB per worker job transient; ~50% of all kit bytes.
2. **Send decimated mono to the workers** — harvest.js:52 documents AC_FRAME
   as "186 ms at 44.1 kHz"; at 96 kHz it is 85 ms, and SPEC_SIZE 2048 is a
   21 ms window. Decimating to ≤ 48 kHz before `postMessage` (controller.js:
   1022, source-controller.js:263) halves A1/A2 (−41.9 MB each on Traum) and
   restores the windows the constants were tuned for. Risk: low-to-medium —
   onset times are returned in seconds so nothing downstream changes, but
   feature values shift slightly; the beatmap contract says hop 512 "at
   analysis rate" (analysis-worker.js:25) so the contract already allows it.
3. **Evict the sequencer cache on source load and BPM change** —
   sequencer.js:136–146, controller.js:594–598. Add `bumpTrack` for fitted
   tracks in the BPM handler, or bound `fitted` to the current key. Saving:
   the accumulated fitted set (1.5 MB per 2 s stereo key per track at 96k).
   Risk: low; `prebake` rebuilds before transport starts.
4. **Mono slices for harvest-seated tracks** — controller.js:481–484. The
   crate already keeps only `channels[0]` (controller.js:1062), so persistence
   accepts mono. Halves A10, A12, A13, A14, A16. Risk: medium — audible for
   stereo material; make it a role-based or opt-in choice.
5. **Skip `sampleBytes` for assets already written** — persist.js:151 builds
   the flat copy before persist-controller.js:184 decides to skip the write.
   Saving: total kit bytes of transient churn per autosave. Risk: low.
6. **Terminate the harvest worker after each job** — controller.js:957–969.
   Harvest is rare and the worker caches nothing useful. Risk: none beyond a
   ~100 ms spawn on the next HARVEST. [I on spawn cost.]

## Open questions

- Does Chrome count `AudioBuffer` storage (A12–A14, A16–A18) in the figure
  Ian sees when the tab resets? The code cannot say; a `performance.memory`
  vs task-manager comparison with a loaded kit would.
- `ConvolverNode` almost certainly keeps a partitioned-FFT copy of the plate
  IR (A18) at 2–3× the IR bytes; unverifiable from JS.
- Is `P.machine.tracks` a getter onto the active scene (so `_bufferCache`,
  keyed by track index, follows scene switches), or a fixed array? Not read.
  It decides whether `prebake(scenes)` (sequencer.js:157–192) thrashes the
  per-index cache across scenes.
- The BPM floor. fitSec = fitSteps·15/bpm with fitSteps ≤ 64; no bpm clamp
  was found in compile.js by grep, so the worst-case fitted buffer size is
  unbounded on paper.
- Harvest feature quality at 96 kHz (quick win 2) — a quality question, not a
  memory one, but it changes whether decimation is a free win or a tuning job.
