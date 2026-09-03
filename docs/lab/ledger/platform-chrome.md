# Platform facts: Chrome (first) and Safari (second) for the memory-robustness redesign

Ledger entry, 2026-09-03. Primary sources (Chromium/V8/WebKit source at `main`, web.dev, Chrome for Developers, MDN/BCD, spec text) plus on-machine probes run in Chrome 152 on this Mac (macOS 25.3, 24 GB RAM, `hardwareConcurrency` 18, `navigator.deviceMemory` reports 16). Confidence is per item: **high** = read in source or measured here; **medium** = documented but not verified here; **low** = inference.

Source snapshots used for the greps live in the session scratchpad (`scratchpad/src/`); the line numbers below refer to those `main` snapshots on 2026-09-03 and will drift.

---

## 1. Tab discard / reload on macOS, and `document.wasDiscarded`

**How Chrome hears about pressure on macOS (high).** `components/memory_pressure/system_memory_pressure_evaluator_mac.cc` creates a `DISPATCH_SOURCE_TYPE_MEMORYPRESSURE` source for `WARN | CRITICAL | NORMAL`, and also reads `sysctlbyname("kern.memorystatus_vm_pressure_level")`. Mapping: `DISPATCH_MEMORYPRESSURE_WARN` → `MEMORY_PRESSURE_LEVEL_MODERATE` (or NONE if `kSkipModerateMemoryPressureLevelMac`), `CRITICAL` → `MEMORY_PRESSURE_LEVEL_CRITICAL`. A second voter checks free disk every 5 s and votes CRITICAL when available disk < `kCriticalDiskSpaceThreshold` — a nearly-full disk produces "memory pressure" discards. The current vote is re-notified periodically (`kRenotifyVotePeriod`).
- https://chromium.googlesource.com/chromium/src/+/main/components/memory_pressure/system_memory_pressure_evaluator_mac.cc

**What acts on it (high).** `chrome/browser/performance_manager/policies/urgent_page_discarding_policy.cc`: on a CRITICAL event (`HandleMemoryPressureEvent`), non-ChromeOS builds call `PageDiscardingHelper::DiscardAPage(DiscardReason::URGENT)` — one page per event. Gated by `performance_manager::features::kUrgentPageDiscarding`, which is `FEATURE_ENABLED_BY_DEFAULT` (`components/performance_manager/features.cc:176`). An optional sustained-pressure path (`kSustainedPMUrgentDiscarding`) re-fires every 5 s while pressure persists.
- https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/performance_manager/policies/urgent_page_discarding_policy.cc
- https://chromium.googlesource.com/chromium/src/+/main/components/performance_manager/features.cc

**Who is protected (high; `discard_eligibility_policy.cc/.h`, `cannot_discard_reason.h`).** A page is *not* discarded if: visible; active tab; pinned; hidden for less than `kNonVisiblePagesUrgentProtectionTime` = **10 minutes** on desktop (`kRecentlyVisible`); **audible** (`IsAudible()`); within `kTabAudioProtectionTime` = **1 minute** of last being audible (`kRecentlyAudible`); picture-in-picture; PDF; not a web/internal URL; user opted out ("always keep active"); notifications permission granted; extension-protected; capturing video/audio/window/display or being mirrored; connected to Bluetooth/USB; DevTools open; updated title/favicon in background (`kBackgroundActivity`); had form interactions; had user edits; installed web app. `WillDiscardBePerceptible()` = audible ∨ PiP ∨ notifications-granted ∨ capturing ∨ devices.
- https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/performance_manager/policies/discard_eligibility_policy.cc
- https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/performance_manager/policies/discard_eligibility_policy.h
- https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/performance_manager/policies/cannot_discard_reason.h

Practical reading for an audio bench: **a tab that is currently playing (or played within the last minute) is exempt from urgent discard; a tab that is silently decoding or analysing is not.** A silent hidden tab that has been hidden > 10 min is a candidate the moment macOS reports CRITICAL.

**Proactive discard (Memory Saver, Chrome 108+) (medium; Chrome docs).** Discards tabs "unused in the background for some time"; three levels (Moderate/Balanced/Maximum). Help page lists what blocks deactivation: "Active audio or video (playback or calls)", "Screen share", "Page notifications", "Active downloads", "Partially filled forms", "Pinned tabs", "Connected devices (USB or Bluetooth)". Users can exempt sites; developers cannot.
- https://developer.chrome.com/blog/memory-and-energy-saver-mode
- https://support.google.com/chrome/answer/12929150

**`document.wasDiscarded` (high; Chrome 68+, Chrome-only per BCD — Safari/Firefox `false`).** Page Lifecycle: "no events fired" at discard; on the next navigation to the tab the page is reloaded from scratch and `document.wasDiscarded === true`. Chrome's guidance: persist state "periodically as the state changes" and on `visibilitychange` to hidden; `beforeunload`/`unload` are unreliable. Hidden pages that play audio, use WebRTC, update title/favicon, show alerts or push "won't be discarded unless under extreme resource constraints".
- https://developer.chrome.com/docs/web-platform/page-lifecycle-api
- https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Document.json (`wasDiscarded`: chrome 68, safari false, firefox false)

**Safari (high from WebKit source; user-facing behaviour medium).** WebKit's `MemoryPressureHandler` polls the process footprint every 30 s and kills the WebContent process when it exceeds a kill threshold: active (foreground) process on 64-bit = `(ramSize() > 16 GB ? 15 GB : 7 GB) + tabCount × 1 GB`; inactive process = `min(3 GB + tabCount × 1 GB, 0.9 × RAM)`. Before killing it calls `shrinkOrDie` (synchronous critical memory release; if still above threshold, `m_memoryKillCallback()`). Memory-usage policy tiers on macOS: Conservative at 0.33 × base, Strict at 0.5 × base. It also subscribes to `DISPATCH_MEMORYPRESSURE_{WARN,CRITICAL,PROC_LIMIT_WARN,PROC_LIMIT_CRITICAL}`. Safari then reloads the page ("This webpage was reloaded because it was using significant memory"); there is **no `wasDiscarded` equivalent** — detect via your own persisted "was-open" marker.
- https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WTF/wtf/MemoryPressureHandler.cpp (lines ~48–130, 186–200)
- https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WTF/wtf/cocoa/MemoryPressureHandlerCocoa.mm

---

## 2. Per-renderer memory limits in Chrome on macOS, and which error surfaces first

**V8 heap (high).** `kDefaultMaxHeapSize` = 4 GB on 64-bit; old generation = clamp(physical/2, 256 MB, 4 GB) (so 4 GB on any ≥ 8 GB machine); under pointer compression the allocator limit is the 4 GB cage (`kAllocatorLimitOnMaxOldGenerationSize = kPtrComprCageReservationSize`). Measured here: `performance.memory.jsHeapSizeLimit` = 4,395,630,592 B (≈ 4.09 GiB). Exceeding it → "Fatal JavaScript out of memory" → renderer crash ("Aw, Snap!"). This is JS objects and strings only — Float32Arrays do *not* live in it.
- https://chromium.googlesource.com/v8/v8/+/main/src/heap/heap.h (`kDefaultMaxHeapSize`, `kAllocatorLimitOnMaxOldGenerationSize`)
- https://chromium.googlesource.com/v8/v8/+/main/src/heap/heap.cc (`OldGenerationSizeFromPhysicalMemory`)
- https://v8.dev/blog/pointer-compression ("2-GB or 4-GB limit on the size of the V8 heap ... even on 64-bit")

**ArrayBuffer / typed array backing stores (high, measured).** Allocated off-heap by `gin::ArrayBufferAllocator` → PartitionAlloc "ArrayBuffer" partition, placed inside the V8 sandbox (1 TB reservation on macOS 64-bit), with `AllocFlags::kReturnNull`, so a failed allocation becomes a script-visible `RangeError: Array buffer allocation failed` rather than a crash. V8's own ceiling with the sandbox is `kMaxSafeBufferSizeForSandbox` = 32 GB − 1 (beyond that: `RangeError: Invalid array buffer length`). **But PartitionAlloc refuses any single allocation ≥ `MaxAllocationSize()` = 2^31 − kSuperPageSize = 2,145,386,496 bytes** — "Intentionally set to less than 2GiB ... a security choice in Chrome". Measured on this Mac: `new ArrayBuffer(2145386496)` OK, `+1` → RangeError; 2 GiB … 31 GiB → "Array buffer allocation failed"; 32 GiB → "Invalid array buffer length".
- https://chromium.googlesource.com/chromium/src/+/main/gin/array_buffer.cc
- https://chromium.googlesource.com/chromium/src/+/main/base/allocator/partition_allocator/src/partition_alloc/partition_alloc_constants.h (`MaxAllocationSize`, ~line 460)
- https://chromium.googlesource.com/v8/v8/+/main/include/v8-internal.h (`kSandboxSizeLog2 = 40`, `kMaxSafeBufferSizeForSandbox = 32ULL * GB - 1`)
- https://chromium.googlesource.com/v8/v8/+/main/src/objects/js-array-buffer.h (`kMaxByteLength`)
- https://groups.google.com/a/chromium.org/g/blink-dev/c/pZ9kld0LehA (intent: throw RangeError instead of crashing)

Consequence for audio: one Float32Array holds at most **536,346,624 samples**. `createBuffer(1, 536346624, 48000)` succeeds; `536346625` → `NotSupportedError: createBuffer(...) failed` (measured). Per channel that is 3.10 h @ 48 kHz, 1.55 h @ 96 kHz, 46.6 min @ 192 kHz, 23.3 min @ 384 kHz. Stereo at the cap succeeds (channels are separate arrays).

**Total memory (medium/high).** There is no Chrome-imposed per-renderer RSS cap on macOS; totals are bounded by the OS (overcommit + compressor + swap) and, indirectly, by V8's external-memory GC heuristics (backing-store bytes are added to V8's external memory accounter). On this machine the risk is not a Chrome limit but system pressure: macOS reports CRITICAL → Chrome discards *other* eligible tabs; if PartitionAlloc cannot obtain pages the renderer dies with an OOM crash. The sad tab is shown for `TERMINATION_STATUS_OOM`; the "Out of Memory" wording exists only on Windows (`sad_tab.cc`: "Only Windows has OOM sad tab strings"), so on macOS it is a plain "Aw, Snap!".
- https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/sad_tab.cc
- https://chromium.googlesource.com/v8/v8/+/main/src/heap/array-buffer-sweeper.cc (`external_memory_accounter_.Increase`)

**Order of failure (high).** (1) `RangeError: Array buffer allocation failed` for a single buffer > 2,145,386,496 B or when the allocator cannot get memory — recoverable, catch it; (2) `NotSupportedError` from `createBuffer` / rejected `decodeAudioData` when a channel array cannot be created; (3) renderer crash ("Aw, Snap!") when the 4 GB V8 heap limit is hit or when a Blink-internal (non-script) allocation fails — not recoverable. Design so that (1)/(2) are the only ones you ever see.

**`performance.memory` (high).** Chrome-only, deprecated. `usedJSHeapSize` = V8 `used_heap_size()` + `external_memory()` (so ArrayBuffer/AudioBuffer bytes *are* included), but values are quantized into 100 exponential buckets between ~10 MB and ~4 GB and, in the default bucketized mode, **refreshed at most once every 20 minutes** (50 ms only with `--enable-precise-memory-info`). Useless for live monitoring; `jsHeapSizeLimit` is the one stable number.
- https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/timing/memory_info.cc
- https://developer.mozilla.org/en-US/docs/Web/API/Performance/memory

---

## 3. How AudioBuffer channel data is accounted; decodeAudioData copies

**Accounting (high).** `AudioBuffer` holds one `DOMFloat32Array` per channel (`audio_buffer.cc`: `channels_`), created via `DOMFloat32Array::CreateOrNull` / `CreateUninitializedOrNull`. Those are ordinary ArrayBuffer backing stores: PartitionAlloc ArrayBuffer partition inside the V8 sandbox, registered with V8 as a `BackingStore` and counted as V8 *external* memory — not V8 heap, not Oilpan. `getChannelData()` returns the same array (no copy); `copyFromChannel` copies.
- https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webaudio/audio_buffer.cc
- https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/typed_arrays/array_buffer/array_buffer_contents.cc (`v8::ArrayBuffer::NewBackingStore`, `Partitions::ArrayBufferPartition()`)

**decodeAudioData path in Chromium (high; read in source).**
1. Main thread (`base_audio_context.cc` ~360–430): the input `ArrayBuffer` is **transferred/detached** (spec; shipped Chrome 59) — the compressed bytes move, they are not copied. Already-detached input → `DataCloneError`.
2. Worker pool: `AudioBus::CreateBusFromInMemoryAudioFile` → `content/renderer/media/audio_decoder.cc`: FFmpeg via `media::AudioFileReader` over an `InMemoryUrlProtocol`; `reader->Read()` fills a `std::vector<std::unique_ptr<AudioBus>>` of decoded packets (≈ full PCM at the *file's* rate), then a single `WebAudioBus` is allocated and every packet is copied in. Peak here ≈ **2 × PCM(file rate)** plus the compressed input.
3. If file rate ≠ context rate: `AudioBus::TryCreateBySampleRateConverting` uses `media::SincResampler` → a second bus at the context rate (peak ≈ PCM(file) + PCM(context)).
4. Back on the main thread: `AudioBuffer::CreateFromAudioBus` → `AudioBuffer(AudioBus*)` allocates the channel `DOMFloat32Array`s and **memcpy**s each channel (`copy_from`) — peak ≈ 2 × PCM(context) until the bus is released after the callback.

So the transient is about **2× the decoded PCM size, three times in succession**, never 3×; the compressed input is freed only when the last reference to the transferred contents drops. Every intermediate (`AudioFloatArray` → `Partitions::BufferTryAlignedZeroedMalloc`) is PartitionAlloc too, so the **same 2,145,386,496-byte per-channel ceiling applies to decoding** — a file whose per-channel PCM exceeds 536,346,624 frames at the *context* rate cannot be decoded by `decodeAudioData` at all.
- https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webaudio/base_audio_context.cc
- https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/platform/audio/audio_bus.cc
- https://chromium.googlesource.com/chromium/src/+/main/content/renderer/media/audio_decoder.cc
- https://chromium.googlesource.com/chromium/src/+/main/media/filters/audio_file_reader.cc
- https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/platform/audio/audio_array.h
- https://chromestatus.com/feature/5539919174828032 (detach shipped in 59)

Sizing rule: an AudioBuffer costs `length × channels × 4` bytes (padenot's perf notes agree), at the **context** rate, not the file rate.

---

## 4. `performance.measureUserAgentSpecificMemory`; GitHub Pages headers; alternatives

**Requirements (high).** Chrome 89+, Chromium only (BCD: Safari/Firefox `false`). Requires `self.crossOriginIsolated === true`, i.e. the *document* response carries `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`, Chrome 96+). Returns `{bytes, breakdown[]}` with per-realm attribution (URL/container) and implementation-defined `types` (JS, DOM, Shared, …); includes dedicated workers, excludes shared/service workers; async so the UA can fold it into GC; an estimate, not exact. web.dev recommends Poisson-timed sampling. Observed here on non-isolated `example.com`: `typeof performance.measureUserAgentSpecificMemory === 'undefined'`.
- https://web.dev/articles/monitor-total-page-memory-usage
- https://github.com/WICG/performance-measure-memory
- https://web.dev/articles/coop-coep

**GitHub Pages (high).** Cannot set response headers: GitHub staff, community discussion #54257 — "We don't support this feature today" (May 2023), "not an area that is being prioritized" (Jul 2024). Workaround: **`coi-serviceworker`** — a service worker that adds COOP/COEP to responses; Chrome honours SW-set headers (Thomas Steiner, Mar 2025). Mechanics/caveats from the README: reloads the page on first visit; must be a separate, same-origin file (not bundled, not from a CDN); HTTPS or localhost; `coepCredentialless` option with retry to `require-corp`. Under `require-corp`, every cross-origin subresource needs CORS/CORP; jsDelivr sets CORS headers, arbitrary hosts may not. Isolation also unlocks `SharedArrayBuffer` (section 8), so it pays twice.
- https://github.com/orgs/community/discussions/54257
- https://blog.tomayac.com/2025/03/08/setting-coop-coep-headers-on-static-hosting-like-github-pages/
- https://github.com/gzuidhof/coi-serviceworker

**Alternatives.** `performance.memory`: see section 2 (20-minute quantized refresh — not a monitor). `navigator.deviceMemory`: Chrome 63+, Chrome-only, coarse power-of-two, clamped; observed **16** on this 24 GB Mac (docs describing an 8 GB clamp are stale). Best available signal is **self-accounting**: sum the bytes of every buffer you own (you know them exactly) and treat `deviceMemory` × a fraction as the budget; use `measureUserAgentSpecificMemory` only as a cross-check when isolated.
- https://developer.mozilla.org/en-US/docs/Web/API/Navigator/deviceMemory
- https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Navigator.json

---

## 5. OPFS as spill: sync access handles, throughput, quota

**API (high).** `FileSystemFileHandle.createSyncAccessHandle()` — Chrome 102+, Safari 15.2+, Firefox 111+; **dedicated workers only**; exclusive lock per file; `read/write/flush/truncate/getSize/close` are synchronous in all current browsers (older Safari had promise-returning close/flush/getSize/truncate).
- https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle
- https://web.dev/articles/origin-private-file-system
- https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/FileSystemSyncAccessHandle.json

**Throughput measured here (high; Chrome 152, blob worker on `example.com`, internal SSD).** Sequential write via `write(chunk, {at})` in 8 MiB chunks: 512 MiB in 174 ms (**≈ 2.9 GB/s**), 1 GiB in 355 ms (2.9 GB/s); `flush()` 2 ms; sequential read 512 MiB in 117 ms (**≈ 4.4 GB/s**); 1000 random 64 KiB positional reads in 41 ms (≈ 41 µs each). Independent blog figure: 100 MB write ≈ 90 ms vs IndexedDB ≈ 850 ms. Spill bandwidth is therefore far above decode speed; the cost that matters is the copy into/out of a typed array, not the disk.
- https://renderlog.in/blog/origin-private-file-system-opfs/

**Quota (high for Chrome source; observed value here).** Chrome: pool = 80% of the profile's disk, per-storage-key quota = 75% of pool (= 60% of disk), `should_remain_available` = min(2 GB, 10%), `must_remain_available` = min(1 GB, 1%); LRU eviction across origins when the pool is exceeded. **However `navigator.storage.estimate().quota` on this machine reported exactly 10 GiB + usage** (baseline 10,737,418,240 B; after writing 1 GiB: 11,811,160,236 B = 10 GiB + 1,073,741,996 B usage) with 906 GiB free — so `estimate()` is a floor, not the ceiling. See addendum below for the mechanism.
- https://chromium.googlesource.com/chromium/src/+/main/storage/browser/quota/quota_settings.cc
- https://chromium.googlesource.com/chromium/src/+/main/storage/browser/quota/quota_features.cc
- https://web.dev/articles/storage-for-the-web

Safari 17+: per-origin up to 60% of disk (browser), overall 80%, no prompts, `estimate()` supported (Safari 17), LRU eviction under pressure/inactivity, excludes origins with open pages or persisted storage; File System (OPFS) is covered. Safari's 7-day script-writable-storage deletion (ITP, since 13.1) still applies to sites without user interaction. `navigator.storage.persist()`: Chrome 55+, Safari 15.2+ (Chrome grants silently by heuristics, never prompts).
- https://webkit.org/blog/14403/updates-to-storage-policy/

---

## 6. Partial / seekable decoding

**`decodeAudioData` on a mid-stream MP3 slice — Chrome says yes (high, measured).** Chromium decodes with FFmpeg over an in-memory protocol; the mp3 demuxer resyncs on frame headers. Measured (Chrome 152, 1.27 MB 128 kbps CBR test file): unaligned mid-file slices of 20 KB and 200 KB (+7/+13 byte offsets), a 150 KB tail, a 100 KB head, and a slice prefixed with 1 KB of junk all decoded successfully, with durations matching the bitrate (200 KB → 12.49 s). Caveats: partial first/last frames are dropped; the first decoded frame after a cut can be wrong because of the bit reservoir; no gapless (Xing/LAME) trimming on slices; the result is resampled to the context rate; each call still goes through the ~2× PCM transient of section 3. The spec and MDN say "complete file" — this is Chrome behaviour, not a guarantee. Firefox is stricter (fails without ID3); Safari uses CoreAudio and is strict about malformed input; Phonograph.js decoded *frame-aligned* MP3 chunks on iOS Safari with `decodeAudioData` — so for Safari, cut on frame sync words (0xFFE…), and prepend nothing.
- https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData
- https://github.com/WebAudio/web-audio-api/issues/2135
- https://github.com/Rich-Harris/phonograph
- https://bugnet.io/blog/fix-webaudio-decodeaudiodata-rejects-mp3-on-safari

**WASM decoders (medium; READMEs).** `mpg123-decoder` (77 KiB): `decode(Uint8Array)`, `decodeFrame`, `decodeFrames`, `reset()`, `MPEGDecoderWebWorker`; output `{channelData: Float32Array[], samplesDecoded, sampleRate}` — chunk feeding is the design, seek = start at any frame header after `reset()`. `@wasm-audio-decoders/flac` (67 KiB) FLAC/Ogg-FLAC → PCM, worker variant. `libflac.js`: chunk-by-chunk `decodeChunk()` streaming decode (libFLAC stream decoder), SEEKTABLE exposed, WASM and asm.js builds, worker-friendly; output per-channel typed arrays at native bit depth. `ffmpeg.wasm`: 2 GB WASM hard limit, multi-thread core needs `SharedArrayBuffer` (cross-origin isolation); single-thread core does not; too heavy for this job.
- https://github.com/eshaz/wasm-audio-decoders
- https://github.com/eshaz/wasm-audio-decoders/blob/master/src/mpg123-decoder/README.md
- https://github.com/mmig/libflac.js
- https://ffmpegwasm.netlify.app/docs/faq ; https://ffmpegwasm.netlify.app/docs/getting-started/usage

**WebCodecs `AudioDecoder` (medium/high).** BCD: Chrome 94, Firefox 130, **Safari 26**; available in dedicated workers; secure context. Chrome registers mp3, flac, opus, aac, vorbis, pcm; Safari 26 is AAC-centric (mp3/flac support unverified). You supply `EncodedAudioChunk`s with timestamps, so you need a JS frame parser (e.g. `codec-parser`), but you get true seeking, streaming, no whole-file transient, and `AudioData.copyTo` into planar f32. Best Chrome-first path for "decode a window on demand"; feature-detect with `AudioDecoder.isConfigSupported`.
- https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/AudioDecoder.json
- https://www.w3.org/TR/webcodecs-codec-registry/

---

## 7. AudioBufferSourceNode with a buffer at a different sampleRate

**Spec (high).** "Resampling of the buffer may be performed arbitrarily by the UA" (index.bs ~5773); the buffer's rate enters `computedPlaybackRate` as `buffer.sampleRate / context.sampleRate`. Contexts must accept 3000–768000 Hz; `AudioContext({sampleRate})` is Chrome 74+/Safari 14.1+; `decodeAudioData` "MUST resample" to the context rate.
- https://raw.githubusercontent.com/WebAudio/web-audio-api/main/index.bs

**Chromium and WebKit implementation (high).** `AudioBufferSourceHandler::ProcessInterpolatedPath` is **linear interpolation** (`sample_rate_factor = buffer.sampleRate / context.sampleRate` folded into the playback rate; comment: "linear interpolation aliasing"). WebKit is the same code (`computeSampleUsingLinearInterpolation`). Firefox uses a higher-quality resampler with latency (padenot). Linear interpolation means aliasing/imaging for any content with energy near Nyquist — precisely the ultrasonic material this bench cares about, and it gets worse when `playbackRate ≠ 1`.
- https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webaudio/audio_buffer_source_handler.cc
- https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/webaudio/AudioBufferSourceNode.cpp
- https://padenot.github.io/web-audio-perf/

**Contrast and the usable trick (high).** `decodeAudioData` resamples with `media::SincResampler` (windowed-sinc, high quality). So: (a) never play a buffer whose rate differs from the context; (b) create the `AudioContext` at the file's rate so nothing is resampled in JS land — **Chromium's own `media::SincResampler` then converts to the device rate** (in the audio service's `AudioOutputResampler` on desktop, Blink's `AudioDestination` otherwise; 64 taps at cutoff 0.92 when the request is >= 96 frames, else 32 taps at 0.90). An earlier revision of this line credited CoreAudio; the conversion happens before CoreAudio sees it; (c) if you need PCM at a different rate, wrap it as WAV and `decodeAudioData` it in an `OfflineAudioContext` at the target rate — that is a free, native, off-main-thread sinc resampler.

---

## 8. SharedArrayBuffer + AudioWorklet for streaming from a worker-owned store

**Availability (high).** SAB: Chrome 68 (desktop requires cross-origin isolation since Chrome 92), Safari 15.2 (also requires isolation), Firefox 79. Observed here on non-isolated `example.com`: `typeof SharedArrayBuffer === 'undefined'`. AudioWorkletNode: Chrome 66, Safari 14.1, Firefox 76. On GitHub Pages SAB therefore exists only behind `coi-serviceworker` (section 4).
- https://raw.githubusercontent.com/mdn/browser-compat-data/main/javascript/builtins/SharedArrayBuffer.json
- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer

**Pattern with SAB (high; Chrome design-pattern article, ringbuf.js).** Worker owns the store (OPFS reads + RAM cache), writes PCM into a SAB-backed SPSC ring buffer; the `AudioWorkletProcessor` reads 128-frame quanta with `Atomics` for the indices; no allocation in `process()`. Chrome's article: MessagePort messaging "is suboptimal for real-time audio processing because of repetitive memory allocation and messaging latency"; use "Int32Array backed by a SAB" for state. `ringbuf.js` (padenot) is the reference implementation (wait-free SPSC, `AudioQueue` helper).
- https://developer.chrome.com/blog/audio-worklet-design-pattern
- https://github.com/padenot/ringbuf.js/

**Pattern without SAB (medium; inference from transfer semantics).** `MessagePort` is Transferable, so a `MessageChannel` port created in the worker can be handed to the processor through `node.port.postMessage(port, [port])`; thereafter the worker posts transferred `Float32Array` chunks (zero-copy move, but each chunk is a fresh allocation) straight to the worklet without touching the main thread; recycle chunks by posting them back. Keep 2–3 chunks of lookahead; expect occasional glitches under main-thread jank to be absent (the main thread is not involved) but GC-related ones possible. Verify empirically in Chrome and Safari before relying on it.

---

## Safari-second summary

AudioWorklet 14.1; `AudioContext({sampleRate})` 14.1; OPFS sync handles 15.2; SAB 15.2 (isolated only); `storage.persist` 15.2; `storage.estimate` 17; WebCodecs `AudioDecoder` 26; no `wasDiscarded`, no `deviceMemory`, no `performance.memory`, no `measureUserAgentSpecificMemory`. JSC ArrayBuffer ceiling: `MAX_ARRAY_BUFFER_SIZE = 1 << 34` (16 GiB) on 64-bit (`Source/JavaScriptCore/runtime/PageCount.h`) — larger than Chrome's 2 GiB, but the process kill thresholds above (7–15 GB + 1 GB/tab) are the real bound. Safari reloads killed pages with no signal to script other than the reload itself.
- https://raw.githubusercontent.com/WebKit/WebKit/main/Source/JavaScriptCore/runtime/PageCount.h

---

## What this settles for the redesign (inference, marked)

1. **Hard shard ceiling**: no Float32Array/AudioBuffer channel above 536,346,624 samples in Chrome; shard well below it (e.g. ≤ 2^27 samples = 512 MiB) so allocations stay off the direct-map edge.
2. **Discard is a hidden-and-silent-tab problem**: while playing you are protected (plus 1 min); the dangerous window is a hidden tab doing silent work for > 10 min. Checkpoint state on `visibilitychange` and periodically; on load check `document.wasDiscarded` (Chrome) or your own marker (Safari).
3. **Budget by self-accounting**, with `deviceMemory` as the tier; `measureUserAgentSpecificMemory` is a cross-check only once the site is isolated via `coi-serviceworker`, which also buys SAB.
4. **OPFS spill is bandwidth-free** (GB/s) — the design cost is copies and the per-file exclusive lock, not I/O; keep one sync handle per shard file per worker.
5. **Decode windows, don't decode files**: WebCodecs on Chrome (seekable, no transient), `decodeAudioData` on frame-aligned slices as the Safari fallback, WASM decoders for FLAC.
6. **Match rates**: open the context at the file's rate; use `decodeAudioData`-at-rate as the resampler; never let `AudioBufferSourceNode` resample — measured, its resampler is linear, and at a 48 k buffer on a 96 k context a 19 kHz tone carries a 29 kHz image only 5.8 dB down (E12). Shipped as the transport context (sw v64) and, for SLOW, as a retuned transport clock so the ratio stays exactly 1 (v64). One resampler remains in the monitoring path: Chromium's `media::SincResampler` from the transport to the device, which is unobservable from an `OfflineAudioContext` — hardware loopback is the only way to measure it and no loopback device is installed on this machine.

## Addendum: reported-quota cap
**Mechanism (high; read in source).** `storage/browser/quota/quota_manager_impl.cc`, `CalculateReportedQuota()` (~line 138): when the clamped total disk space is at least 10 GB the value handed to `navigator.storage.estimate()` is **`usage + 10 GB`**, otherwise `usage + total disk space rounded up to whole GiB` — a fingerprinting mitigation so the page cannot learn the disk size. It is applied in `GetUsageAndReportedQuotaWithBreakdown` / `GetBucketUsageAndReportedQuota`, i.e. only to what is *reported*; the enforced per-origin quota is still the 60%-of-disk figure from `quota_settings.cc`. Reading for the redesign: `estimate().quota - estimate().usage` is always about 10 GiB on any real Mac and says nothing about headroom; treat a `QuotaExceededError` from a sync-handle `write()` as the real signal, and `persist()` as the only lever against eviction.
- https://chromium.googlesource.com/chromium/src/+/main/storage/browser/quota/quota_manager_impl.cc (`CalculateReportedQuota`)
