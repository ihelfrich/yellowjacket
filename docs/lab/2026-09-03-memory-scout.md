# 2026-09-03 · Memory: why the tab resets, and where the bytes go

## The report
Ian: the tab "resets itself" once it passes roughly 780 MB, e.g. a lossless
file plus a larger Whisper model. Two distinct mechanisms fit that report:

1. **Our own ceiling.** `DECODE_BUDGET_BYTES = 768 MiB` (js/dsp/native-rate.js:27)
   governs only files whose native rate is ABOVE the context rate. A file at or
   below the context rate is decoded regardless (js/audio-engine.js:74:
   `if (!buffer) buffer = await ctx.decodeAudioData(arrayBuffer)`); the plan's
   `overBudget` flag for that branch is computed and then ignored by the caller.
2. **Chrome tab discard under system memory pressure.** On a Mac already deep
   into swap, Chrome evicts the renderer and reloads the page on return. That is
   the "reset". The only defence is a smaller footprint plus a restore that
   needs no click.

## Where the bytes go for one loaded file (Float32 everywhere)
Let F = frames at the DECODED rate, C = channels.
- decoded AudioBuffer: F·C·4 (js/audio-engine.js:81)
- mono mixdown: F·4 (js/audio-engine.js:82) — and a SECOND mono in runtime
  (`r.mono = engine.mono`, same reference; fine) plus `r.peaks` ≈ 0.14·F
- encoded source bytes: kept in memory for persistence and RESTORE
  (js/app/source-controller.js:85 `ab.slice(0)`); for WAV this equals the PCM
- after RENDER: a second full AudioBuffer (F·C·4) plus renderedMono (F·4) and
  its peaks (js/app/bench-controller.js:447–451)
- spectrogram: `_mags` column-major dB, cols·bins·4 on the CPU plus a full
  resolution canvas image cols·bins·4 (js/spectrogram.js:85–91), plus GPU
  textures (js/render/spectrogram-gpu.js)
- transcription: a 16 kHz mono copy (js/transcribe.js:19) plus the model in
  the worker (41 MB–250 MB on disk; several times that resident, dtype
  dependent) plus ONNX runtime arenas
- undo: `store.update()` snapshots project state before every mutation
  (js/app/project-store.js:222); whether snapshots carry large arrays is a
  question for the ledger

## The multiplier nobody asked for
Ian's output runs at 96 kHz (audiofmt max). `decodeAudioData` on the live
context yields the CONTEXT rate, so a 44.1 kHz or 48 kHz file is upsampled on
load: 2.18× or 2× the frames, with no added information ("LOADED · 48 kHz
SOURCE, UPSAMPLED TO 96 kHz TO MATCH THE OUTPUT"). Traum (218 s, 48 kHz,
stereo) becomes 167 MB decoded + 84 MB mono + 42 MB source ≈ 293 MB before a
single render, transcription, or spectrogram. Web Audio resamples an
AudioBufferSourceNode whose buffer rate differs from the context, so decoding
at the file's own rate via an OfflineAudioContext (the path already used for
files ABOVE the context rate) is sufficient for playback and halves the
resident size for the common case.

## Questions the ledger must answer (Understand phase)
- Exact allocation formulas and lifetimes per subsystem; which are releasable.
- Whether undo snapshots or the sequencer/machine keep PCM copies alive.
- Whether transcription and harvest copies are freed after use.
- What the Whisper worker holds resident per model and dtype.
- Whether anything holds the encoded bytes twice.

## Experiment 1 (2026-09-03, in-app Chromium, output at 96 kHz) — native-rate decode
Traum (42 MB WAV, 48 kHz stereo, 218 s) fetched once, decoded two ways:

| path | rate out | decode time | heap delta |
|---|---|---|---|
| `new OfflineAudioContext(2, frames, 48000).decodeAudioData` | 48 000 | 223 ms | 0 |
| live `AudioContext.decodeAudioData` (context at 96 kHz) | 96 000 | 651 ms | 0 |

- A 0.3 s excerpt of the 48 kHz buffer played through the 96 kHz context ran
  0.301 s: `AudioBufferSourceNode` resamples automatically. **Native-rate
  decode is sufficient for playback**, halves the resident buffer for 48 kHz
  sources on this machine, and is ~3× faster to decode.
- `performance.memory.usedJSHeapSize` did not move for either decode (44 MB
  before and after ~250 MB of channel data). **The JS heap counter is blind to
  AudioBuffer storage**, so any in-app memory meter must be computed from the
  footprint formulas, not read from the browser.
- `performance.measureUserAgentSpecificMemory` is undefined here: the page is
  not cross-origin isolated (`crossOriginIsolated === false`), and GitHub Pages
  cannot set COOP/COEP. `document.wasDiscarded` exists (false on a fresh load)
  — the signal for a silent auto-restore after a tab discard.
- `navigator.deviceMemory` reports 16 (GB, capped by the API at 8 in some
  builds; here 16).

## Experiment 2 (2026-09-03) — windowed decode of a long archive MP3
WWV 1991 MP3 (10.7 MB, 13:10). A 1 MiB `Range` fetch starting at 40% of the
file (no ID3 header, no frame alignment) returned 206 with CORS and decoded via
`OfflineAudioContext.decodeAudioData` to 77.7 s of stereo 44.1 kHz audio in
187 ms, peak 0.66 (real signal, not silence). The first 1 MiB decoded to
73.7 s. **A windowed loader for long captures needs no WASM decoder for MP3**:
fetch a byte range, decode, place it at offset ≈ bytes/avg-bitrate (refined
from the head slice or the archive's stated length). FLAC and WAV need their
headers, so a window there is header + range, which is also a plain fetch.
This unlocks the 63-minute HM01, the 91-minute Marine Electric SOS, and the
87-minute Voyager launch commentary at a few minutes per load.

## Experiment 3 (2026-09-03) — OPFS as a spill for the encoded source
Main-thread OPFS (`createWritable`), Traum's 39.9 MB WAV:

| operation | time |
|---|---|
| write 39.9 MB | 40 ms |
| read back whole (`File.arrayBuffer`) | 14 ms |
| read a 2 MB slice from the middle (`Blob.slice`) | 2 ms |
| decode the read-back bytes at 48 kHz | 58 ms |

Quota reported: 4 GB; usage after cleanup unchanged. **The encoded source
bytes do not need to live in memory.** Persisting them to OPFS on load costs
tens of milliseconds and a later RESTORE, KEEP, or export reads them back in
the same. The only in-memory reason left is the SHA-256 already computed at
load, which is a 64-character string.

## Experiment 4 (2026-09-03) — compact backing store: Int16 with on-demand Float32
Traum at 48 kHz (10.47 M frames × 2):

| operation | time | size |
|---|---|---|
| Float32 pair → interleaved Int16 | 36 ms | 79.9 MB → 39.9 MB |
| 12 s window → fresh AudioBuffer | 2 ms | — |
| whole file back to Float32 (a full render's input) | 24 ms | — |
| mono mixdown straight from Int16 | 14 ms | — |
| max round-trip error against the decoded float (16-bit source) | 6.1e-5 | — |

**A compact store costs nothing a user can feel**: windows for playback,
preview, and audition are single-digit milliseconds; a full-file DSP stage
pays ~25 ms once. The depth must follow the source: Int16 is exact for 16-bit
material, but a 24-bit FLAC needs Int32 (or a 24-in-32 pack) to stay
lossless — the badge promise on the SHELF. So the store's element type is a
property of the load, not a global setting.

## Corrections after cross-model review (Codex, 2026-09-03)
See 2026-09-03-codex-review-memory.md. Accepted:
- Experiment 1 measured rate and time, not memory: the halving is a footprint
  calculation (frames × channels × 4), not an observed number.
- The tab-discard cause is inferred, not reproduced. `wasDiscarded` presence
  proves only that the signal exists.
- One mid-file MP3 range decoding is one data point: VBR timing, frame
  alignment, and seek continuity are untested; FLAC/WAV "header + range" is a
  hypothesis, not a result.
- Experiment 4's 6.1e-5 error came from asymmetric scaling (×32767 on the
  positive side); with symmetric ×32768 a 16-bit source round-trips exactly.
  Int32 costs the same bytes as Float32; only packed 24-bit saves space for
  24-bit sources.
- Undo snapshots omit PCM (js/app/persist.js:129-166) — question closed.
- A flat rack without cuts returns the input buffer (js/dsp/chain.js:152-169),
  so RENDER is not always a second buffer.
- Five budget bugs are real and take priority over any new architecture:
  overBudget unenforced (engine.load ignores it); the context-rate fallback
  is itself unbudgeted; MP3/AAC probe to zero seconds so the estimate is only
  the encoded size; peak load holds three encoded copies; a failed offline
  decode reports a downgrade with no reason.

## Step 1 shipped locally — container probes for MP3, MP4/M4A, Ogg (Vorbis, Opus)
Codex's point: native-rate decode is only as good as the probe, and only WAV
and FLAC were read. `probeContainer` now reads MPEG frame headers with
Xing/Info/VBRI frame counts (CBR fallback), ISO BMFF `moov/trak/mdia` for the
first `soun` track (moov-at-end handled), and Ogg identification headers with
the last page's granule. Unknown containers now budget at a 64 kbps floor
(`assumedSeconds`) so a long file the probe cannot read errs long, not free.
Real-file check (node, byte heads from archive.org unless noted):

| file | probe | truth |
|---|---|---|
| UVB-76 .ogg (whole) | 8 000 Hz · 2 ch · 160.04 s | 160.04 s |
| VOA newscast .mp3 (256 KB head) | 44 100 Hz · 1 ch · 298.06 s | 298.06 s |
| HM01 .mp3 (256 KB head) | 8 000 Hz · 2 ch · 174.31 s | 174.14 s |
| Sparks demo .mp3 (local) | 44 100 Hz · 2 ch · 160.84 s | 160.836 s |
| Traum .wav (local) | 48 000 Hz · 2 ch · 218.05 s | 218.047 s |

Tests: +8 cases (container probes group).

## Step 2 shipped locally — decode at the file's own rate; soft budget warns, hard limit refuses
`planDecodeRate` redesigned (js/dsp/native-rate.js): a file at or below the
context rate is decoded at its own rate through an OfflineAudioContext (never
upsampled); above the soft budget (768 MiB) it still loads and the status
warns; above the hard limit (2 GiB) the load is refused with the reason, and
`engine.load` enforces the plan (throws `over-budget`) instead of ignoring the
flag. High-rate files still downgrade to the context rate when native is over
the soft budget, and refuse only when even that is over the hard limit. The
engine no longer copies the input: the caller supplies `fallback()` for the one
case where the offline decode fails, so peak encoded copies drop from three to
two (Codex bug 4). A failed offline decode now carries a reason (bug 5).
Live check (fresh origin, 96 kHz output): Traum decodes at 48 000 Hz,
planned footprint 161 MB (was ~320), plays at 1×, preview/HARVEST/QUICK TAKE
unaffected. Tests: 45 groups / 300 cases.

## Step 3 shipped locally — the encoded source leaves memory once it is on disk
`js/app/source-handle.js`: `R.sourceBytes` is now a `SourceHandle` — `size`,
`hash`, `byteLength` (for the identity readers in LOOM and MACHINE) — whose
bytes are released the moment autosave has written `source.bin` to OPFS for
the same generation (`handle.spill(reader)` in persist-controller's flush).
KEEP and PROJECT OUT read the bytes back through `await handle.bytes()`,
which checks the size on the way in. Live: Traum resident 41.9 MB at load →
spilled 500 ms later → read back in 20 ms → KEEP works → reload → RESUME
restores from `source.bin` (same SHA, 48 kHz) → spills again. Without OPFS
writes (Safari) the bytes simply stay resident. Tests: 46 groups / 304 cases.

## Step 4 shipped locally — seven hygiene fixes from the ledger
From docs/lab/ledger/*.md (subsystem readers), all low risk, pinned in tests:
1. **Transcriber released after every job and on source change**
   (`Transcriber.dispose()`): the resident model was the ledger's largest single
   allocation — 206 MB for BASE on WebGPU, 586 MB for SMALL — and it lived until
   the tab died. The next TRANSCRIBE reloads from the Cache API in seconds.
2. **Model labels tell the truth**: the old "~250 MB" was the WASM figure; on
   WebGPU (the path Chrome takes here) SMALL downloads 586 MB. Labels now show
   both.
3. **Re-render drops the previous take first** (buffer, mono, peaks) instead
   of holding it through the new pipeline: −127 MB peak at 48 kHz, −254 at 96.
4. **Source loudness measured once per generation**, not per render (one
   full-buffer copy and a worker measurement saved per RENDER).
5. **Sequencer keeps one fitted take per track** — every tempo visited used
   to leave an AudioBuffer in a map with no eviction.
6. **HARVEST worker retired after each job** (spawns again in ~100 ms).
7. **Spectrogram frees the stale 2D image and the GPU texture** when data is
   cleared (32.8 MB during every STFT, indefinitely after a clear); **repair
   rebuild** points the runtime at the original before allocating, so the
   previous repaired pair is collectable (−126 MB peak at 48 kHz).
Live (fresh origin): render → A/B → re-render OK; HARVEST twice OK (24 slices
both times); `dispose()` idle → MODEL RELEASED. Tests: 47 groups / 310 cases.

## Visual pass shipped (steps 1–15 of docs/lab/2026-09-03-visual-plan.md; step 11 left for Ian)
Everything in the plan except the credit-row decision (11, owner's call).
Live checks on fresh origins: off modules 46 px with ordinals; LED busy →
on → stale (solid amber); bar labels B1 B9 B17 …; pipeline seams, legible
notes, YOU ARE HERE on TRANSCRIPT/SLICE/PATTERN; status 11 px live region;
RESUME above the demo button; tab underbar crawls and the SLICE stage reads
`MAPPING BEATS · 50%` then `HARVESTING` then `24 CLIPS`; header in two
seamed groups with no scrollbar at 800 px; sounding readout BENCH → MACHINE,
and the bench reaching its end no longer flips STOP to PLAY while the
machine runs; one focus rule; reduced-motion keeps busy legible.

## Step 5 shipped locally — windowed loads for long captures
`js/dsp/window-load.js` (pure, tested): byte range for [start, start+span)
of a long MP3 from its average bitrate (exact for CBR, ≈ for VBR, said so
in the name), clamped to the file. `loadFromUrl(url, name, {range})` sends a
`Range` header and refuses a 200 (whole file) where a 206 was asked for.
Shelf cards with `long: {seconds, bytes}` open a window row (start mm:ss ·
2/5/10 min · LOAD WINDOW): the hour of HM01, the 91-minute Marine Electric
SOS traffic, the 87-minute Voyager launch commentary. A mid-stream slice
has no container signature, so `probeContainer` now scans for TWO agreeing
MPEG frame headers (random data fakes a sync word every few hundred bytes)
— the real slice probes as 32 kHz mono. Live: ≈ 20:00 + 2:00 of HM01 loads
in ~1 s (1.2 MB fetched), 120.0 s at 32 000 Hz, spectrogram at the file's
rate. Tests: 49 groups / 322 cases.

## Step 6 shipped locally — the ledger's remaining low-risk rows
From docs/lab/2026-09-03-memory-ledger.md §4A (ranks 2, 3, 6, 7, 13, 17):
- **Denoise worker 7 → 4 channel-units**: the transferred input is released
  once padded; the overlap-add weights become a HOP-length table (the sum of
  win² repeats every hop wherever the caller reads — proven by a test against
  the full per-sample sum); the output is divided in place and returned as a
  view of the padded buffer, transferred whole. Output identical; a
  DENOISE-only render of the demo: RENDER OK · 5.2 s, no NaN, −1.7 dB energy.
- **Loudness worker retired after each job** (MEASURE twice: 1.0 s each).
- **loadFromUrl drops its streamed chunks before decode**; **.yjkt import**
  passes an entry's own buffer through instead of copying it.
- **Whisper worker releases the context-rate array** once resampled.
- **A new source clears the undo stack** (and the sample refs it held).
- **RESUME seeds the written generation**, so the first autosave after a
  resume does not rewrite the 42 MB it just read.
Left for their own steps: streaming WAV export (rank 4), fp16/q4f16 whisper
(5, 8 — need the timestamp fixture, E10), 16 kHz slabs (9), Uint8 mags (11),
model-aware budget (19), discard-aware auto-restore (18), and the three
structural items (20–22). Tests: 49 groups / 325 cases.
