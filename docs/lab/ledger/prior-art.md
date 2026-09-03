# Prior art · how browser audio editors survive large or long files

Date: 2026-09-03. Companion to `../2026-09-03-memory-scout.md` (which established
that the bench holds Float32 everywhere: decoded buffer F·C·4, mono F·4, peaks,
plus the encoded source bytes, plus a second full buffer after RENDER).

## The question
Every serious browser editor faces the same wall: `decodeAudioData` produces one
Float32 `AudioBuffer` at the context rate, and the tab dies somewhere between
0.8 and 2 GB. What have others actually shipped to get past it, which of those
approaches work on a static GitHub Pages site with OPFS and a service worker
but no server, and what does each cost?

## Method
Web search plus primary sources: project docs, source on GitHub (AudioMass
cloned shallow; Ardour, Wavacity, Audacity, wavesurfer read raw), W3C issue
threads via `gh api`, MDN browser-compat JSON via curl. Nothing was executed or
benchmarked in this pass; every number below is quoted, not measured here.
Confidence tags: **HIGH** = read in the source/doc itself; **MED** = from a
search excerpt of the source, not the page (the page was 403/429/Anubis);
**LOW** = second-hand or inferred.

Yellowjacket facts used for the fit assessments (all HIGH, local grep):
- Decode is whole-file `decodeAudioData` on an `OfflineAudioContext` at native
  rate, falling back to the live context (`js/audio-engine.js:60–74`).
- Source bytes are already written to OPFS with `createWritable`
  (`js/app/persist.js:556–558`, `js/app/mine.js:199–201`), so a lazily readable
  `File` for every loaded source exists without new plumbing.
- No `AudioWorklet`, no `SharedArrayBuffer`, no `createSyncAccessHandle` anywhere
  in `js/` or `sw.js`. Seven lazily created Workers exist. RENDER uses
  `OfflineAudioContext` (`js/dsp/chain.js`).
- The site already ships a service worker (`sw.js`, v47) — relevant to the
  COOP/COEP question below.

---

## 1. What each system does

### wavesurfer.js (HIGH)
- Default backend is a plain `<audio>` element: "the browser streams and decodes
  the file progressively"; the `WebAudio` backend "fetches and decodes the entire
  file into an AudioBuffer" and, worse, **fetches large files twice** (once for
  peaks, once for playback). Recommended cure: MediaElement backend + the
  `peaks` + `duration` options, which skip client decoding entirely.
  https://wavesurfer.xyz/docs/core-concepts/
- `src/decoder.ts` is `new AudioContext({sampleRate})` → `decodeAudioData`; there
  is no chunking or partial decode anywhere.
  https://github.com/katspaugh/wavesurfer.js/blob/main/src/decoder.ts
- Issue #1763 (a three-hour file crashed the tab) produced PR #1767, merged
  2019-10-18: a `MediaElementWebAudio` backend — `<audio>` for playback,
  `createMediaElementSource` so filters/EQ still work. "Using HTML5 tag, the
  audio data are not decoded, so in case of a big audio file browser does not
  crash." https://github.com/katspaugh/wavesurfer.js/issues/1763
  https://github.com/katspaugh/wavesurfer.js/pull/1767
- Issue #999 asked for "remote peaks first, then local decode for zoom"; and
  discussion #2702 states the maintainers' position that the Web Audio decoder
  "is very memory intensive and cannot easily be done in chunks" (MED).
  https://github.com/katspaugh/wavesurfer.js/issues/999
  https://github.com/katspaugh/wavesurfer.js/discussions/2702
- Lesson: the library that most people copy solved large files by **not
  decoding** — precomputed peaks for the picture, the media element for sound.

### peaks.js + audiowaveform (BBC) (HIGH)
- Peaks are generated server-side by the C++ `audiowaveform` and shipped as
  `.dat`: 20-byte header (24 for v2) — version, flags (bit 0: 1 → 8-bit values,
  0 → 16-bit), sample rate, samples-per-pixel, length (min/max pairs per
  channel), channels — followed by interleaved min/max pairs. Size ≈ header +
  length × channels × 2 × bytes-per-value; one hour of 48 kHz stereo at 512
  samples/pixel, 16-bit ≈ 1.3 MB.
  https://github.com/bbc/audiowaveform/blob/master/doc/DataFormat.md
- peaks.js takes `dataUri` (.dat or .json) or decodes in-browser, and caches a
  waveform per zoom level. https://github.com/bbc/peaks.js/blob/master/doc/API.md
- "Server-side" is incidental: the computation is one pass of min/max over
  fixed windows. It can run in a Worker at import and be persisted next to the
  source bytes in OPFS, after which the PCM is never needed for drawing again.
  The bench already keeps `r.peaks ≈ 0.14·F` bytes (memory-scout); an 8-bit
  audiowaveform-style pyramid at 256 spp is F/128 bytes per channel.

### AudioMass (HIGH, source read)
- One `AudioBuffer`, decoded by an embedded, modified wavesurfer
  (`src/dist/wavesurfer.js:3999` `this.offlineAc.decodeAudioData`). Every edit
  materialises new buffers via `getChannelData` copies
  (`src/engine.js:2065–2251`), effects render through `OfflineAudioContext`
  (`src/multitrack.js:3807, 4051`), and an undo stack keeps states. WASM is
  used only for codecs and denoise (`libflac.wasm`, `lz4-block-codec.wasm`,
  `rnn_denoise.wasm`). No size guard exists (`rg -i "too large|memory"` over
  engine/app/local/modal → nothing).
  https://github.com/pkalogiros/AudioMass
- So AudioMass is the same model the bench has today — Float32 everywhere,
  offline renders for effects — and it does not solve the wall; it accepts it.

### Soundtrap (HIGH — WAC 2017 paper)
- Standard Web Audio nodes; they "freeze finished tracks" to cut runtime CPU,
  push some processing server-side, and "use libvorbis through emscripten to
  encode large WAV files to ease memory requirements". Open problems listed:
  latency, "streaming efficiency, disk usage". Performance characteristics are
  auto-detected and the graph is modified per device.
  https://webaudioconf.com/posts/2017_EA_29/
- Lesson: hold the compressed form, not the PCM; render-and-freeze is the
  memory strategy for multitrack. The server half is unavailable to us.

### BandLab (LOW) / Audiotool (MED) / Descript (absent)
- The only technical statement on BandLab in the literature is Buffa et al.,
  WAM-studio (WWW '23 Companion): "BandLab is supposed to have a core written
  in C++, and relies also on AudioWorklet." Audiotool "runs in AudioWorklet
  node(s)" (a port of its Flash engine). Quoted via search excerpt; the ACM page
  returns 403 and the HAL PDF is behind Anubis.
  https://dl.acm.org/doi/10.1145/3543873.3587987 ·
  https://inria.hal.science/hal-04335612v1
- Descript: three targeted searches found no public engineering source on how
  its web editor holds audio. Recorded as **not knowable from public material**.

### Chrome Music Lab (HIGH)
- Web Audio / Tone.js experiments; short loops and synthesis. No long-file
  handling to learn from. https://github.com/googlecreativelab/chrome-music-lab

### Tone.js (HIGH)
- `Player`/`ToneAudioBuffer` load whole files into `AudioBuffer`s; issue #984
  (large files miss their scheduled start) got pooling advice, not streaming;
  issue #620 documents buffers not being freed. No streaming path exists.
  https://github.com/Tonejs/Tone.js/issues/984

### ffmpeg.wasm and Emscripten filesystems (HIGH)
- WASM32 linear memory tops out at 4 GB (`-s MAXIMUM_MEMORY=4GB`, Chrome M83+;
  the 2→4 GB step required V8 to move all TypedArray indices/lengths off 31-bit
  Smis to 64-bit). https://v8.dev/blog/4gb-wasm-memory
- ffmpeg.wasm's practical ceiling is ~2 GB because input, working set and
  output all live in MEMFS; "Array buffer allocation error" past that.
  https://github.com/ffmpegwasm/ffmpeg.wasm/discussions/755
- Escape hatch: **WORKERFS** — "read-only access to File and Blob objects
  inside a worker without copying the entire data into memory". One example
  trims 5 GB+ inputs (32 GB in, ≤4 GB per output segment).
  https://emscripten.org/docs/api_reference/Filesystem-API.html ·
  https://github.com/pavloshargan/ffmpeg-browser-4gb-plus
- Lesson transfers to any WASM decoder: never copy the file into the heap;
  feed it.

### Wavacity (Audacity 3.0.0 in WASM) (MED)
- File import is a JS `showFileDialog` bridged by `EM_ASM`
  (`src/widgets/FileDialog/wasm/FileDialogPrivate.cpp:76`); no OPFS/IDBFS/
  WORKERFS references in the indexed repo, so it runs on MEMFS by elimination
  (not confirmed). Its author acknowledges large files are slow. The
  interesting part is what it inherits from Audacity: audio lives in
  **sample blocks in native format** (`sampleformat` int16/int24/float) with
  **`summary256` and `summary64k`** (min/max/rms per 256 and 65 536 samples)
  stored beside each block (`sampleblocks` columns: sampleformat, summin,
  summax, sumrms, summary256, summary64k, samples; blocks ≤ ~1 MB ≈ 5 s mono).
  That is the desktop reference for "native depth + multi-resolution summary".
  https://github.com/ahilss/wavacity ·
  https://forum.audacityteam.org/t/request-aup3-and-or-sqlite-documentation/61618 ·
  https://sqlite.org/forum/info/496b68a88a88e5c0

### REAPER and Ardour — the disk-streaming reference (HIGH for Ardour source)
- REAPER: media buffer default **1200 ms** (0–6000), render-ahead
  ("anticipative FX") **200 ms** (0–1200); Frankel described the reader keeping
  ~600 ms ahead of the playhead with worker threads refilling. (MED: config
  reference and search excerpt of the Gearspace Q&A; the wiki serves a bot
  page.) https://mespotin.uber.space/Ultraschall/Reaper_Config_Variables.html ·
  https://gearspace.com/board/q-a-with-justin-frankel-designer-of-reaper-/119731-buffers-latency-reaper.html
- Ardour: a non-realtime **butler** thread owns disk I/O; each `DiskReader`
  holds a `PlaybackBuffer` ring and asks for the butler when
  `write_space() >= _chunk_samples` (`libs/ardour/disk_reader.cc:544`; chunk
  default 65 536 samples, `:151`). Presets in `libs/ardour/disk_io.cc:96–140`:
  Small 65 536-sample chunks / 5 s buffered, Medium 262 144 / 10 s, Large
  524 288 / 20 s. Manual: "longer settings reduce the risk of buffer under-runs
  but consume more memory." https://ardour.org/transport_threading.html ·
  https://github.com/Ardour/ardour/blob/master/libs/ardour/disk_io.cc ·
  https://manual.ardour.org/preferences-and-session-properties/preferences-dialog/
- What the browser cannot copy: a realtime-priority thread that touches the
  disk; `mmap`; any I/O from inside `AudioWorkletGlobalScope` (no fetch, no
  OPFS, no sync handles). What it can copy: the *shape* — a reader in a Worker
  with a sync OPFS handle, a ring buffer sized in seconds (5–20 s), refill when
  a chunk of space frees, and the worklet as a pure sink.

### Superpowered Web SDK (HIGH)
- `Decoder` outputs **16-bit signed integer PCM**; `AudioInMemory` is a
  linear-memory structure holding 16-bit PCM (self-contained block or chained
  buffer tables, appendable during progressive download); `downloadAndDecode`
  runs in its own Worker; `AdvancedAudioPlayer` reads from memory and converts
  during playback. This is the commercial existence proof for **Int16 resident,
  Float32 on demand** in a browser.
  https://docs.superpowered.com/reference/latest/decoder/?lang=js ·
  https://docs.superpowered.com/reference/latest/audio-in-memory/

### Elementary (HIGH)
- Virtual file system maps name → `Float32Array | Float32Array[]` living in
  the worklet; entries immutable, `pruneVirtualFileSystem()` reclaims. Float32
  resident, no streaming, no size guidance.
  https://www.elementary.audio/docs/guides/Virtual_File_System ·
  https://www.elementary.audio/docs/packages/web-renderer

### Standards track — Int16 AudioBuffers and streaming offline renders (HIGH)
- `WebAudio/web-audio-api#2396` "Storing AudioBuffers in native sample bit
  depth", open since 2014-01-15, 31 comments, still open. Timeline: 2015-06
  chair: implementations *may already* store compressed and expand to float on
  read; 2020-06 padenot: WebCodecs "does not help if the decoded audio assets
  need to be present in memory at all time", halving memory "make[s] a nice
  difference"; **2020-10-01 minutes: "Firefox already does this internally and
  transparently"**; 2021-05-20 raised to priority-1 — `decodeAudioData` would
  return int16 buffers for mp3/aac, a ctor with bit depth; 2021-07-15: an
  `AudioBuffer` ctor taking format + buffer, "inflated to float32 as needed";
  2021-07-22 "straw man required". Nothing has shipped.
  https://github.com/WebAudio/web-audio-api/issues/2396
- 2014 list thread: Chris Wilson's point that resampling to the context rate
  is the bigger bloat (>4×) than int16→float32 (2×) — exactly the bench's
  96 kHz multiplier. https://lists.w3.org/Archives/Public/public-audio/2014JanMar/0047.html
- `web-audio-api-v2#66`: `OfflineAudioContext.startRendering` must allocate the
  whole output up front (4 h × 48 kHz × 4 ch > 11 GB); proposals were a
  ReadableStream, `dataavailable` events, a Blob, or "bypass with
  AudioWorklet". Nothing shipped. The bench's RENDER path has this ceiling.
  https://github.com/WebAudio/web-audio-api-v2/issues/66
- WebCodecs `AudioData.copyTo` accepts a target `format` (`s16`, `s16-planar`,
  `f32-planar`, …), so a decoder can deliver Int16 planes without a Float32
  intermediate (padenot's 2021-07-15 note; w3c/webcodecs#232). MED on exact
  browser coverage of the conversion.

---

## 2. The specific pattern: chunked WASM decode → AudioWorklet

Every piece exists in public code; nobody has published the OPFS-fed variant.

- **Design pattern (Chrome, Hongchan Choi):** AudioWorklet + SharedArrayBuffer
  + Worker. The Worker does the heavy work (a decoder), the worklet is an
  "audio sink" pulling from shared memory with Atomics; a ring buffer bridges
  the 128-frame `process()` quantum and the decoder's block size.
  https://developer.chrome.com/blog/audio-worklet-design-pattern/
- **ringbuf.js (padenot):** wait-free SPSC ring over SAB, `audioqueue`
  helper, documented use "decoding audio codecs in a web worker and sending
  PCM to an AudioWorklet". Requires COOP/COEP.
  https://github.com/padenot/ringbuf.js/
- **audio-worklet-stream (ain1084):** worker-based filler at a 20 ms interval
  × 5 chunks ≈ 4800 frames at 48 kHz; SAB required for the worker strategy.
  https://github.com/ain1084/audio-worklet-stream
- **fetch-stream-audio + opus-stream-decoder (AnthumChris):** fetch → Worker
  → WASM libopusfile in chunks (Float32 L/R at 48 kHz) → scheduled
  `AudioBufferSourceNode`s. Works without SAB; playback jitter is bounded by
  scheduling, not by shared memory.
  https://github.com/AnthumChris/fetch-stream-audio ·
  https://github.com/AnthumChris/opus-stream-decoder/
- **wasm-audio-decoders (eshaz):** mpg123 77 KiB, FLAC 67 KiB, Ogg Opus,
  Opus, Ogg Vorbis, AAC. `decode(chunk)` → `{channelData: Float32Array[],
  samplesDecoded, sampleRate}`, partial frames buffered across calls, `reset()`,
  `*WebWorker` classes. This is the FLAC/MP3 decoder to use when WebCodecs is
  absent. https://github.com/eshaz/wasm-audio-decoders
- **@audio/decode (audiojs):** 25+ codecs, chunked API
  (`const dec = await decode.mp3(); dec(chunk)`), runs inside an AudioWorklet
  if the WASM is initialised first. https://github.com/audiojs/audio-decode
- **mediabunny:** `BlobSource` reads a `File` lazily with an 8 MiB cache;
  `AudioBufferSink.buffers(start, end)` / `AudioSampleSink` iterate a time range
  and pre-decode a little ahead; PCM/WAV decoders are built in (no WebCodecs
  needed), FLAC/MP3/AAC/Opus/Vorbis go through `AudioDecoder`.
  https://mediabunny.dev/guide/reading-media-files ·
  https://mediabunny.dev/guide/media-sinks ·
  https://mediabunny.dev/guide/supported-formats-and-codecs
- **WebCodecs Fundamentals:** bound memory by batching ~1000 encoded chunks
  (~20 s) at a time; demux with mediabunny.
  https://webcodecsfundamentals.org/audio/decoding-encoding/
- **Emscripten Wasm Audio Worklets:** `-sAUDIO_WORKLET -sWASM_WORKERS`; the
  worklet has no fetch, so `-sSINGLE_FILE` or a custom `instantiateWasm`.
  https://emscripten.org/docs/api_reference/wasm_audio_worklets.html
- **OPFS side:** `createSyncAccessHandle` is Worker-only and synchronous; used
  in the wild to stream 100–1000 MB MP3 downloads straight to disk.
  https://dbushell.com/2023/10/02/storage-apis-downloading-files-for-offline-access/ ·
  https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle

Browser floor (MDN BCD, HIGH): `AudioDecoder` Chrome 94 / Firefox 130 /
Safari 26; `createSyncAccessHandle` Chrome 102 / Firefox 111 / Safari 15.2;
`SharedArrayBuffer` Chrome 68 / Firefox 79 / Safari 15.2 — but only under
cross-origin isolation.

**GitHub Pages and COOP/COEP.** Pages cannot set headers. `coi-serviceworker`
injects `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` from a service worker at the cost
of one reload on first visit; every cross-origin subresource then needs CORP
or must be fetched in CORS mode. The bench already owns `sw.js`, so the
injection can live there instead of a second worker; SHELF pulls from
archive.org are CORS-mode (verified in the Sep 1 shelf work), which `require-corp`
allows; `<audio>` elements would need `crossorigin`. `COEP: credentialless` is
the softer option where supported. https://github.com/gzuidhof/coi-serviceworker
If isolation is declined, the fallback is transferable chunks over
`MessagePort` to the worklet or fetch-stream-audio's scheduled buffers — both
work without SAB and cost a few ms of jitter.

---

## 3. The media-element route (the one wavesurfer took)
The bench already has each source as an OPFS `File`
(`js/app/persist.js:556`). `URL.createObjectURL(await handle.getFile())` on an
`<audio>` streams it with the browser's own decoder and zero resident PCM;
`createMediaElementSource` puts it through the RACK. Chrome's Web Audio FAQ and
MDN both say `AudioBuffer` is for short assets and long material belongs on a
media element. Limits: no sample-accurate seek/loop, the element resamples to
the context rate, no offline render, and high-rate (96–192 kHz) WAV/FLAC
playback through `<audio>` is unverified here. It is a playback answer only.
https://developer.chrome.com/blog/web-audio-faq

---

## 4. Techniques, fit, cost

| Technique | Who ships it | Fits static site + OPFS? | Cost |
|---|---|---|---|
| Precomputed peak pyramid (min/max per window, 8- or 16-bit), persisted | BBC audiowaveform/peaks.js, wavesurfer `peaks`, Audacity summary256/64k | Yes — compute once in a Worker at import, write to OPFS beside the source | F/128 B per channel at 8-bit/256 spp; one extra pass at import; view code must draw from pyramid, never `getChannelData` |
| Media element playback + `MediaElementAudioSourceNode` | wavesurfer default and `MediaElementWebAudio` backend | Yes — blob URL from the OPFS file | ~0 resident PCM; loses sample-accurate transport, offline render, native-rate guarantees |
| Int16 (native-depth) resident PCM, Float32 on demand | Superpowered `AudioInMemory`; Audacity sample blocks; Firefox internally (per WG minutes); W3C priority-1 but unshipped | Yes — app-level: decode into `Int16Array` pages (WebCodecs `copyTo` `s16-planar`, or convert from wasm-audio-decoders' Float32 per chunk) | Halves PCM (2 B/frame/ch); 32-bit-float WAV sources lose their depth unless kept as `Float32` pages; every DSP entry point needs a page→Float32 adaptor |
| Native-rate decode, resample only at the output | 2014 WG discussion (resampling is the larger bloat); the bench already does this on one branch | Yes — already in `js/audio-engine.js`; the `overBudget` flag on the ≤ context-rate branch is ignored (memory-scout) | Free; removes the 2–2.18× upsample multiplier |
| Chunked WASM/WebCodecs decode in a Worker → ring buffer → AudioWorklet sink | Chrome design pattern, ringbuf.js, audio-worklet-stream, fetch-stream-audio, icecast-metadata-player | Yes, with COOP/COEP via the existing service worker (coi-serviceworker technique); MessagePort transfer as the no-SAB fallback | Worklet + Worker + reader code; 5–20 s ring (Ardour presets) per source ≈ 1–8 MB; one reload on first visit if COI is enabled; archive.org fetches must stay CORS-mode |
| Lazy file access (WORKERFS / mediabunny `BlobSource`) instead of copying into the heap | ffmpeg.wasm 4 GB+ example; mediabunny | Yes — OPFS `getFile()` is a `File` | Zero copy of the container; random access by byte range (WAV trivial; FLAC via seektable; MP3 via frame sync — mediabunny does all three) |
| Freeze/render-and-replace, keep compressed copies | Soundtrap; AudioMass undo stack (negative example) | Yes — the bench's FREEZE already replaces the source | Encode cost; the encoded copy should live in OPFS, not RAM (memory-scout: `ab.slice(0)` retained) |
| Chunked offline render to OPFS instead of `OfflineAudioContext` | Proposed in web-audio-api-v2#66 ("bypass with AudioWorklet"); WebCodecs Fundamentals' 20 s batches | Yes — Worker-side DSP on pages, write Int16/Float32 to OPFS | Requires the RACK chain to be runnable outside the Web Audio graph, or a worklet-graph render with a sink that writes; removes the second full buffer after RENDER |

Not fitting: server-side peaks or transcoding (Soundtrap, BBC) — no server;
a 4 GB WASM heap as the primary store (ffmpeg.wasm) — it is the same wall in
a different address space; Tone.js/Elementary style Float32 VFS — that is the
current design.

---

## 5. Findings worth carrying forward
1. No shipping browser editor decodes a long file in pieces for *editing*.
   Those that survive long files either stop decoding (media element + peaks)
   or accept the wall (AudioMass, Tone.js, Elementary). The chunked path exists
   only as streaming-player infrastructure (ringbuf.js, wasm-audio-decoders,
   mediabunny). Building it for an editor is unoccupied ground, not a solved
   problem to copy. (HIGH)
2. Int16 residency is legitimate: a commercial SDK does it, the WG raised it to
   priority-1, and Firefox reportedly does it silently; the spec never
   delivered an API, so it has to be done at app level. (HIGH on the record,
   MED on the Firefox claim — it is a minute, not a code citation.)
3. For the bench's own example (Traum, 218 s, 48 kHz stereo, currently ≈293 MB
   resident before any render), native-rate Int16 pages would be ≈42 MB, a
   256-spp 8-bit pyramid ≈0.16 MB, and the source bytes belong on OPFS, not in
   RAM. Streaming would reduce resident PCM to the ring (seconds). Arithmetic
   from memory-scout's formulas, not measured. (MED)
4. The disk-streaming shape is fully specified by Ardour's source: seconds of
   read-ahead, refill on a chunk of free space, a non-realtime reader thread.
   Worker + OPFS sync handle + SAB ring + worklet sink reproduces it; the only
   thing the browser cannot give is thread priority. (HIGH)
5. COOP/COEP on GitHub Pages is a solved nuisance (service-worker injection),
   and the bench already owns the service worker; the cost is one reload on
   first visit and discipline about cross-origin fetches. (HIGH)
6. `OfflineAudioContext` renders have the same ceiling as decode
   (web-audio-api-v2#66) — any memory plan that fixes load but leaves RENDER
   allocating a second full Float32 buffer only moves the wall. (HIGH)

## Open questions this note does not settle
- Whether `<audio>` in Chrome plays 96/192 kHz WAV/FLAC from a blob URL without
  silently downsampling — needs a spectrum check on the live site.
- Whether the RACK chain can be evaluated outside the Web Audio graph (needed
  for a chunked render); memory-scout lists this among the ledger's questions.
- The exact TypedArray ceiling in current V8 (indices are 64-bit since 2020,
  limits were "equalized" in 2022; the number was not retrieved and was
  deliberately not probed on this swap-bound Mac). A paged store makes the
  question moot.
- Whether WebCodecs `AudioDecoder` FLAC support is present in Firefox/Safari
  builds the bench targets — `AudioDecoder.isConfigSupported({codec:'flac'})`
  at runtime, with `@wasm-audio-decoders/flac` as the fallback.

## What would overturn this
A public post-mortem from BandLab or Descript describing a different store;
or a measurement showing the media-element route already meets the bench's
transport needs, which would make the worklet path unnecessary for playback.
