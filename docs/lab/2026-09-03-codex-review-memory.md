# Codex review of the memory plan (2026-09-03, `codex exec -s read-only`)

Independent second model, read-only, given the scout log and the budget code. Verbatim.

# Memory robustness review

## Verdict

Ship **native-rate decode first**, but define it as “decode at the verified source rate whenever known,” not yet “every file, never the context rate.” It removes the largest common-case waste, preserves the existing Float32 `AudioBuffer` contract, and the experiment demonstrated correct playback plus a shorter decode for the test file (`docs/lab/2026-09-03-memory-scout.md:55-70`).

Downstream code generally uses the buffer’s own rate: the engine exposes `buffer.sampleRate`, the rack renders at that rate, and clip extraction converts seconds using it (`js/audio-engine.js:119-125`, `js/dsp/chain.js:125-142`, `js/machine/controller.js:472-485`). I found no general downstream assumption that source rate equals context rate.

Do not ship the literal “every file” version until MP3/AAC probing exists: only WAV and FLAC are currently recognized (`js/dsp/native-rate.js:104-110`, `js/dsp/native-rate.js:165-170`). Over-budget files should be rejected or routed to windowed mode, not blindly decoded at the context rate.

Order afterward: OPFS spill; an explicitly labeled computed **estimate**; compact PCM behind a source-store abstraction; windowed archive mode; silent discard restore last. The readout is instrumentation, not a memory fix. Auto-restoring before reducing memory can recreate the original pressure and cause a discard loop.

## What each intervention breaks

### Native-rate `OfflineAudioContext`

Little downstream breakage: it still produces a Float32 `AudioBuffer`. Playback assigns that buffer to an `AudioBufferSourceNode`, with offsets expressed in seconds (`js/audio-engine.js:146-183`). Preview, render, repair, and machine slicing all use the source buffer’s rate (`js/dsp/preview.js:40-50`, `js/dsp/chain.js:125-142`, `js/app/repair-controller.js:84-110`, `js/machine/controller.js:472-485`).

The planner needs redesign. It attempts offline decoding only when `plan.rate > ctx.sampleRate`; all other inputs take context-rate decoding (`js/audio-engine.js:55-71`). Unknown containers produce `{sampleRate: null, channels: 0, seconds: 0}`, so their native rate cannot currently be selected (`js/dsp/native-rate.js:113-170`).

### Spill encoded bytes to OPFS

Replacing `R.sourceBytes` with `{size, hash, OPFS key/generation}` breaks these synchronous consumers:

- Load copies, hashes, and stores the bytes (`js/app/source-controller.js:81-95`, `js/app/source-controller.js:113-121`).
- Snapshot metadata derives the source size from the live buffer (`js/app/persist.js:159-166`).
- Autosave writes `R.sourceBytes`; portable export passes it synchronously into the ZIP builder (`js/app/persist-controller.js:165-189`, `js/app/persist-controller.js:201-212`, `js/app/project-bundle.js:241-249`).
- KEEP hands the bytes to the shelf store (`js/app/field-library.js:217-227`).
- LOOM and MACHINE use `sourceBytes.byteLength` in identity matching (`js/loom/controller.js:11-19`, `js/machine/controller.js:36-84`).

KEEP/export must become asynchronous readers, while source size remains ordinary metadata. The initial OPFS write must complete durably before the memory copy is dropped; the current 800 ms autosave debounce otherwise creates a loss window (`js/app/persist-controller.js:15`, `js/app/persist-controller.js:159-181`).

### Compact Int16/Int32 store with Float32 windows

This is an architectural change, not a typed-array substitution. The engine keeps a whole `AudioBuffer`, creates a whole Float32 mono array, and assigns the complete buffer to scheduled sources (`js/audio-engine.js:81-88`, `js/audio-engine.js:146-183`, `js/audio-engine.js:352-365`).

Preview and rack rendering call `getChannelData()` and create AudioBuffers (`js/dsp/preview.js:40-50`, `js/dsp/chain.js:29-110`, `js/dsp/chain.js:125-142`). Repair clones and mutates complete channels (`js/app/repair-controller.js:66-126`). Analysis, spectrogram, and harvest copy the complete mono array to workers (`js/app/source-controller.js:220-265`, `js/spectrogram.js:220-223`, `js/machine/controller.js:1022-1026`). Machine assignment slices full source channels (`js/machine/controller.js:549-575`).

Introduce a source-store interface—duration/rate, peaks, and `readChannels(t0,t1)`—then keep AudioBuffers only at playback/preview boundaries. Full rendering and analysis need chunked implementations or they will temporarily recreate the old footprint.

### Windowed HTTP Range loader

The existing contract is “complete encoded file in, complete buffer/mono/peaks out” (`js/audio-engine.js:43-88`, `js/app/source-controller.js:101-130`). Loading immediately starts whole-source spectrogram and analysis work (`js/app/source-controller.js:153-163`, `js/app/source-controller.js:220-265`), while transport schedules all kept segments against one buffer (`js/audio-engine.js:146-183`).

Export, repair, rack render, clip assignment, and semantic playback also require arbitrary full-timeline access. Range mode therefore needs explicit capability restrictions or a seekable chunk cache; it cannot masquerade as an ordinary loaded source.

### Computed memory readout

No functional path breaks, but an exact-looking number would be misleading. `decodedFootprintBytes()` counts decoded channels, mono, peaks, and one encoded copy (`js/dsp/native-rate.js:33-50`). It omits transient decode copies, render/repair buffers, worker copies, spectrogram CPU/GPU/canvas storage, Whisper/ONNX arenas, and browser overhead.

Display a lower-bound estimate by category, with external/unknown memory stated explicitly.

### Silent `document.wasDiscarded` restore

Boot deliberately offers a RESUME panel and waits; restore is wired to a click (`js/app/persist-controller.js:1-4`, `js/app/persist-controller.js:123-153`, `js/app/persist-controller.js:503-511`). Restore also assumes a button exists and mutates it (`js/app/persist-controller.js:403-408`, `js/app/persist-controller.js:482-488`).

First extract a UI-free restore transaction. Automatic restore should validate a complete generation, suppress autosaves while restoring, stop after a restore fault, and defer spectrogram/analysis. Otherwise it immediately reconstructs the footprint implicated in the discard.

## Budget bugs

1. **`overBudget` is not enforced.** The planner returns it for native-at/below-context files (`js/dsp/native-rate.js:196-207`), but `Engine.load()` never reads it and always decodes (`js/audio-engine.js:55-71`). The test checks only that the flag exists, not that loading is prevented (`test/run.mjs:3604-3614`).

2. **The fallback is not budgeted.** For a high-rate source, the planner tests native-rate memory and returns the context rate without checking whether that decode also exceeds 768 MiB (`js/dsp/native-rate.js:210-222`). Three hours of stereo at 48 kHz is about 5.9 GiB under the project’s own formula, yet 48 kHz is still returned and decoded.

3. **Unknown formats are effectively unbudgeted.** MP3/AAC receive zero duration and channels from `probeContainer`. Passing `channels: 0` is coerced to one channel; with zero seconds, the estimate becomes only the encoded byte count (`js/audio-engine.js:45-54`, `js/dsp/native-rate.js:43-49`, `js/dsp/native-rate.js:165-170`). A long compressed stereo file therefore looks cheap before a full decode.

4. **Peak load is undercounted.** `loadArrayBuffer()` holds `ab` and `sourceBytes = ab.slice(0)` (`js/app/source-controller.js:81-95`); native-rate decode creates another slice (`js/audio-engine.js:62-66`). The formula counts one encoded copy, so it estimates retained memory rather than admission-control peak memory (`js/dsp/native-rate.js:33-50`).

5. **Offline failure can become a silent downgrade.** If native-rate decode throws and context decode succeeds, `decodeReport.downgraded` becomes true while `reason` remains null (`js/audio-engine.js:55-80`). The UI reports a downgrade only when both are truthy, so it falls through to generic LOADED (`js/app/source-controller.js:136-149`).

## Experimental claims to narrow

- Experiment 1 establishes rate behavior and one-file timing, not measured resident-memory halving or a general 3× speedup: its memory counter could not see either AudioBuffer (`docs/lab/2026-09-03-memory-scout.md:55-70`). Describe the memory result as a footprint calculation.

- The Chrome-discard cause was not reproduced. `document.wasDiscarded === false` on a fresh load establishes API presence only—not that the reported reset was a discard or that system pressure caused it (`docs/lab/2026-09-03-memory-scout.md:71-76`).

- One successful arbitrary-range decode of one MP3 does not establish generic random access or “no WASM decoder needed.” VBR timing, bit reservoirs/frame alignment, server Range/CORS support, and exact seek continuity remain untested. “FLAC and WAV need header + range” is especially unproven: an arbitrary range is not automatically a valid stream/container (`docs/lab/2026-09-03-memory-scout.md:78-88`).

- OPFS timings demonstrate feasible I/O, not release of resident memory or crash-consistent replacement. “Usage after cleanup unchanged” cannot validate quota consumption (`docs/lab/2026-09-03-memory-scout.md:90-104`).

- Experiment 4 reports maximum error `6.1e-5` and then calls Int16 exact; those claims conflict (`docs/lab/2026-09-03-memory-scout.md:106-122`). Int32/24-in-32 also uses the same bytes as Float32; only packed 24-bit reduces storage. The microbenchmarks omit scheduling, GC, cache misses, window boundaries, full DSP allocation, and other codecs, so “costs nothing a user can feel” is too broad.

- Undo uncertainty is already answerable: snapshots use `serializeProject(..., true)`, omit sample PCM, and represent source audio only by byte count (`js/app/persist.js:129-166`, `js/app/project-store.js:176-180`). A render is also not always a second AudioBuffer: a flat rack without cuts returns the input object (`js/dsp/chain.js:152-169`).
hook: Stop
hook: Stop Completed
tokens used
111,527
The read-only sandbox blocked both file creation and shell redirection. Full requested Markdown follows.

