# The frontier program

Synthesis, 2026-07-27. Six inputs: Codex 5.6 DSP audit and architecture audit (both in
this directory, both build-ready), and four research sweeps (browser DSP state of the
art, groovebox sound-design vocabulary, performance engineering, ecosystem design).
Where three independent sources point at the same build, this document says so. The
slice roadmap in VISION.md still governs; this program threads through it.

## Track 1 — Fix the truth (DSP correctness debts)

Codex's audit found nine places where our signal path falls short of the bench's own
honesty standard. The ones that matter most, cheapest first:

1. **Dither the 16-bit export.** We quantize hot signals raw. TPDF dither with
   Wannamaker F-weighted 9-tap error feedback costs 9 MACs per sample offline, the SoX
   coefficients are published, and essentially no browser tool ships noise-shaped
   dither. An afternoon of work that becomes a differentiator sentence in the README.
2. **Replace the Whisper resampler.** Our 48 to 16 kHz linear interpolation is
   unfiltered decimation in disguise: everything above 8 kHz aliases straight into the
   speech bands the ASR reads. Kaiser-windowed polyphase sinc (about 320 taps, 80 dB
   stopband) in a worker. This one likely improves transcription accuracy for free.
3. **True peak done right.** The current estimator is an 8-tap 3-phase interpolator
   wearing a 48-tap badge. Build the real BS.1770 4x polyphase FIR once and share it
   between metering and the limiter.
4. **Limiter rebuild.** Attack equal to lookahead cannot reach target in time; the
   per-sample emergency min adds corner distortion; one-pole release pumps on peak
   clusters. Windowed-minimum release shaping with hold, driven by oversampled peaks.
   Loudnorm then re-measures after limiting instead of promising a LUFS it changed.
5. **EQ decramping.** Vicanek 2016 matched biquads cost the same at runtime as what we
   have; only the coefficient math changes. Fix the fake Butterworth high-pass Q pair
   (0.541196 / 1.306563) in the same pass.
6. **Denoise, eventually.** The full fix is minima-controlled noise tracking with
   decision-directed Wiener gain, linked across channels, tiled in time (the current
   design would hold 700 MB per channel on a 10-minute file). Bigger job; schedule as
   its own slice when long-file repair becomes a headline use.
7. **Splices.** Zero-crossing search and correlation-normalized fades instead of the
   fixed 6 ms equal-power crossfade; return a splice map so caption timing stops
   drifting by one overlap per cut.

## Track 2 — Structure before LOCK (the architecture verdict)

Codex's position, and mine: main.js is already the liability, and LOCK's data (sparse
per-step locks, scenes, seeds) would force a rewrite mid-slice if we do not move first.
The refactor is mechanical and keeps every file-level contract:

- `js/app/project-store.js` (schema, revisions, one typed change event; serializable
  document split from runtime handles) plus three controllers: source, bench, machine.
  main.js shrinks to a ~150-line composition root. No framework, no string bus.
- The LOCK-ready data model lands now: assets registry, eight scenes wrapping today's
  pattern as scene zero, sparse `stepData` per step (components, locks, conditions),
  and a scene seed so probability locks compile identically live and offline.
- OPFS persistence exactly as specified in the architecture audit: immutable media,
  generation-addressed state JSON, manifest head pointer, debounced autosave, pure
  sequential migrations. Autosave only becomes possible once state lives in the store.
- The permanent test harness: `node test/run.mjs`, no dependencies, locking BS.1770,
  the beat tracker, and the pattern compiler against golden fixtures. Every future
  slice adds fixtures before it ships.

Also in this track, the measured performance debts: share one peak pyramid across the
three views that each scan 28.8 M samples today; move loudness measurement off the main
thread and kill its 220 MB prefix array; cache spectrogram, beatmap, and peaks by
source id. And the three loading quick wins with the best ratio in the whole program:
self-host the two fonts (case studies show ~0.5-1 s faster first paint), emit
modulepreload hints for the ~31-module graph, and add a small versioned service worker
for true offline and instant repeat loads.

**WASM policy, settled:** no wholesale ports. The bottlenecks are memory copies, not
arithmetic. One exception path: pffft compiled with SIMD128 behind the existing FFT
interface, runtime-detected with the JS radix-2 kept as permanent fallback, adopted
only after profiling shows FFT owns more than half of a worker stage. CONFORM's
signalsmith-stretch uses the official npm WASM build, never a self-compile (Apple
Clang 16 miscompiles its SIMD). WebGPU belongs in exactly one place: UNMIX's ONNX
inference. Refused: hand-rolled WGSL FFT (5-15 ms readback per round trip kills it),
Memory64, coi-serviceworker SharedArrayBuffer hacks, bundlers.

## Track 3 — The instrument frontier (sound design)

Three sources converged on the same shape. Codex proposed per-track filter plus drive;
the DSP sweep found ADAA plus 2x oversampling is now the shipping standard for exactly
that (first-order formula published, half-sample delay documented); the device sweep
found that character lives in two or three master lo-fi media simulations plus
momentary gestures, and everything else is commodity. So the build list is:

1. **Expressive voice + LOCK grammar** (Codex proposal 1): compiler events grow
   velocity, start/duration, rate, reverse, envelope, choke; sidechain duck compiles
   as gain segments from another track's events, deterministic by construction. This
   IS the LOCK slice's engine half.
2. **Per-track TPT SVF filter with ADAA-tanh drive at 2x** (Zavalishin SVF, about 10
   ops per sample, stable under modulation; reimplement from equations, the reference
   code is license-poisoned). Budget honestly: full drive on four tracks, freeze past
   that.
3. **One character block, three media**: vinyl (wow/flutter fractional delay, crackle,
   bandlimit), cassette (hiss, saturation, wobble), crush (rate/bit reduction with
   proper pre-filtering and dither). Seeded noise so bounce equals live. Doubles as
   LIVE punch-in material.
4. **One send rack**: ConvolverNode is the right reverb on a no-COOP/COEP site (the
   browser threads the tail for free, which our own worklet never could); two-node
   equal-power crossfade covers the IR-swap glitch. Algorithmic IR generator as the
   license-clean default library, user WAV IRs accepted, OpenAIR linked with per-file
   licenses stated, EchoThief never redistributed. Plus one tempo-synced ping-pong
   delay behind the same send.
5. **Granular clip mode and spectral hold** (Codex proposals 5 and 7) belong to the
   LIVE slice; freeze/blur are near-free on our existing STFT plumbing.

## Track 4 — The ecosystem (capped at two new repos)

The sprawl rule from the research: Chrome Music Lab died as frozen one-offs; norns
thrives on one JSON catalog. So: sharing, presets, demos, and the learn track live in
the main repo; exactly two satellite repos, both cheap to keep alive.

1. **URL-fragment pattern sharing + demo gallery** (in-repo, days): machine state is
   kilobytes of JSON; gzip-base64url in the hash, Strudel-style. `.yjkt` zip (state
   JSON plus source audio) for full-project trading. A demos/ catalog the app lists.
2. **RACK preset catalog** (in-repo, days): named repair chains ("podcast voice",
   "vinyl rip", "phone memo rescue") as JSON, URL-shareable, community additions as
   PRs against one catalog file.
3. **yellowjacket-signals** (repo one): CC0 test corpus synthesized fresh to the EBU
   tech 3341/3342 recipes. Never re-host SQAM or the EBU/ITU sets (their licenses
   forbid it); link them with licenses stated. Feeds the test harness directly.
4. **yellowjacket-export** (repo two, experimental): OP-1/OP-Z drum .aif writers with
   slice metadata from our beat grid (documented format, stable prior art in digichain
   and op1.fun) for all browsers; EP-133 WebMIDI SysEx push behind capability
   detection, labeled experimental because the protocol is reverse-engineered and TE
   firmware can break it. No WebMIDI on Safari, ever, per current evidence.
5. **yellowjacket-dsp on npm**: publish as an extraction, not a product (the niche is
   real but small: the best incumbent loudness package moves ~2k downloads a month;
   AGPL-and-stale essentia.js moves 57k, which is the demand signal). After the
   signals corpus exists, versioned with the app, no independent roadmap.
6. **docs/learn**: one excellent short track, deep-linking live bench states via the
   share format, never screenshots. Highest ceiling, biggest treadmill; last.

## The program, sequenced

Merged with VISION's remaining slices, the order that retires the most risk per week:

1. **STRUCTURE** — store/controllers refactor, LOCK-ready data model, test harness,
   loading quick wins, shared caches. (Everything after stands on this.)
2. **TRUTH 1** — dither, Whisper resampler, true-peak FIR, limiter, EQ decramp. Small,
   audible, and they defend the "numbers worth trusting" identity.
3. **LOCK** — on the new model: locks, components, conditions, scenes, plus the
   expressive voice and compiled sidechain. The out-sequence-the-hardware release.
4. **CHARACTER** — filter+drive, the media block, the send rack. The machine grows a
   sound. OPFS persistence ships here too (projects now worth saving).
5. **CONFORM** — signalsmith-stretch as the derived-asset service, formant modes.
6. **LIVE** — worklet tape, punch FX, granular, spectral hold, gesture record.
7. **TRUTH 2 + UNMIX** — the denoise rebuild, then stems via ONNX WebGPU.
8. **ECOSYSTEM** — sharing and presets can interleave anywhere after STRUCTURE; the
   satellite repos follow the test harness; learn follows sharing.
