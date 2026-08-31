# Yellowjacket Audio I/O and Live Capture Design

**Status:** Design direction approved by Ian on 2026-08-31; this written
specification is awaiting final review before implementation planning.

**Base:** `ba25077d9e2880b94d3fb9b0df3203324010aefc`, after the Task 11
multi-source archive implementation and before live Task 12 wiring.

## Decision

Yellowjacket will add one global **AUDIO I/O** side sheet. It will make local
playback routing observable and adjustable, provide an explicit output test,
capture microphones and user-selected browser-tab/system audio, and turn every
successful recording into one or two ordinary content-addressed Yellowjacket
sources.

This is a web-first system. It preserves the static, local-only application:
audio never goes to a Yellowjacket server, no permission is requested at boot,
and no native driver is required. Browser limitations are shown as limitations;
the UI never reports a device, capture lane, rate, or successful playback that
has not been established.

The implementation is split because the observed failure contains two distinct
problems:

1. the existing player is hard-wired to the browser default destination and can
   report playback after a failed `AudioContext.resume()`; and
2. the application has no live input path at all. `AUDIO IN` currently means
   files and direct URLs, not a microphone, call, browser tab, or system mix.

The output reliability slice may land first. Live capture must use the Task 12
multi-source add transaction; it must never be bolted onto the legacy singular
`source.bin` path.

## Goals

- Let the user see, test, and adjust Yellowjacket's output device, app volume,
  and mute state without changing macOS volume.
- Make `PLAYING` mean that the shared output context is actually running and a
  valid sink route exists.
- Let the user select a microphone, see its actual reported settings and level,
  optionally monitor it, and record it without Yellowjacket-applied cleanup.
- Let Chromium users explicitly select a Google Meet, YouTube, or other tab and
  capture an audio track from it in real time.
- Record a microphone and tab together as two synchronized, provenance-distinct
  sources. Never pre-mix them and never invent remote-speaker identity.
- Preserve the samples Yellowjacket actually receives as deterministic
  32-bit-float WAV payloads, with exact recorded rate, channels, and frame count.
- Commit captured sources through the same hashing, deduplication, validation,
  payload ownership, activation, persistence, and history boundaries as files.
- Fail explicitly on permission denial, absent audio tracks, output interruption,
  device removal, recorder overrun, or storage exhaustion.
- Remain keyboard complete, screen-reader legible, and usable at 200% zoom.

## Non-goals and decomposition

- A normal web page cannot silently choose or capture another tab. Every
  display-capture request requires a fresh user gesture and browser chooser.
- An output-device selector does not inject Yellowjacket into Google Meet's
  microphone. To let call participants hear Yellowjacket, the user shares the
  Yellowjacket tab with tab audio. A virtual microphone requires a separate
  native/driver project.
- YouTube's IFrame API is a playback-control surface, not a raw PCM interface.
  Direct extraction remains the existing local `yt-dlp` command workflow. This
  specification adds real-time tab capture; an automated localhost extraction
  helper is a separate, installation-bearing project and will be considered
  only if measured tab-capture fidelity or duration is inadequate.
- This is not a long-form call recorder, meeting bot, speech diarizer, or consent
  recorder. The first release is a bounded high-fidelity source-capture path for
  sampling and production.
- No automatic echo cancellation, noise suppression, gain control, mastering,
  normalization, channel fold-down, or sample-rate claim is added. The browser
  may impose processing; Yellowjacket reports that fact when observable.
- No device identifier, device label, selected-tab title, or inferred tab URL is
  written into a project archive.

## Browser facts that bind the design

- `getDisplayMedia()` may return video without audio even when audio was
  requested, and the user agent must let the user choose the surface every time:
  <https://www.w3.org/TR/screen-capture/>.
- Chromium supports `AudioContext.setSinkId()`; this is feature-detected rather
  than assumed: <https://developer.chrome.com/blog/audiocontext-setsinkid>.
- Safari on macOS supports `HTMLMediaElement.setSinkId()` and reveals named
  speaker devices after capture permission, but does not provide a dependable
  `AudioContext.setSinkId()` contract:
  <https://webkit.org/blog/16574/webkit-features-in-safari-18-4/>.
- The media-output selection contract is permission- and secure-context-gated:
  <https://w3c.github.io/mediacapture-output/>.
- The YouTube IFrame API exposes player control and state, not audio samples:
  <https://developers.google.com/youtube/iframe_api_reference>.

No branch uses a browser-name check as a capability decision. Runtime features
and the tracks actually returned are authoritative.

## User experience

### Global side sheet

A top-bar **AUDIO I/O** button and command-deck action open one side sheet. This
is global routing and capture state, not another bench. Closing the sheet does
not hide an active recording: a persistent top-bar indicator and STOP action
remain visible until finalization.

The sheet has three sections and a fixed capture footer.

### YELLOWJACKET OUTPUT

- Output selector: `SYSTEM DEFAULT` plus labelled devices the browser has
  actually exposed.
- `SHOW OUTPUT DEVICES` explains that Safari may require a temporary microphone
  permission to reveal speaker labels. Any probe stream is stopped immediately.
- `TEST` emits an explicit, short, safely levelled stereo test through the
  selected route. Opening the panel never makes sound.
- App volume is 0-100%, smoothed, and capped at unity gain. It cannot boost above
  0 dBFS. Mute is independent and click-free.
- Copy states that these controls affect Yellowjacket live playback and
  monitoring only, not macOS volume, captured PCM, offline renders, or exported
  audio.
- A pre-route output meter shows `NO SIGNAL`, peak dBFS, or `CLIPPING` so a user
  can distinguish an idle graph from a routing problem. It is diagnostic only:
  meter motion is never presented as proof that a physical device made sound.
- Status displays `READY`, `SUSPENDED`, `INTERRUPTED`, `OUTPUT LOST`, or `FAULT`,
  plus the playback-context rate and browser-reported latency when available.
  It never labels an `AudioContext.sampleRate` as the physical device rate when
  an element sink bridge is in use.
- `RESET OUTPUT` is available only while transport is stopped. It rebuilds the
  live context after a closed/faulted state and never touches decoded sources or
  project state. It is not enabled until every context-bound consumer handles
  the Engine's context-generation replacement event and discards its cached
  nodes, racks, and context-created buffers. Until then, the truthful recovery
  for a closed context is a reload after autosave.

If a selected device disappears during playback, Yellowjacket mutes and pauses
all live transports before falling back to `SYSTEM DEFAULT`. It does not resume
onto laptop speakers without another user action.
If microphone monitoring is armed, its monitor connection is disconnected
before any fallback and stays off; an otherwise healthy capture may continue.

### RECORD INPUTS

Two independent rows can be armed:

**MICROPHONE**

- `ENABLE MICROPHONE` is the only permission doorway.
- Once allowed, the row presents the exposed input devices, visual and textual
  dBFS metering, reported rate/channels/processing flags, `INCLUDE`, and
  `MONITOR`.
- Yellowjacket requests `echoCancellation:false`, `noiseSuppression:false`, and
  `autoGainControl:false`. The returned track settings are authoritative. If the
  browser forces or does not report processing, the row says so. Constraints
  are never relaxed silently: if the raw request is rejected, the user may
  explicitly retry with browser processing allowed.
- Monitor is off for every new session, is never persisted as on, warns the user
  to use headphones, routes through Yellowjacket's selected output, and has no
  effect on recorded gain.

**BROWSER TAB / SYSTEM AUDIO**

- `CHOOSE TAB` directly invokes the browser chooser from that click.
- Inline instruction says: “Choose the Meet or YouTube tab and enable Share tab
  audio.”
- Yellowjacket requires a live returned audio track. A video-only result is
  stopped and reported as `NO AUDIO — RETRY AND ENABLE SHARE TAB AUDIO`.
- Browser-required video is never rendered, inspected, encoded, or persisted.
  Its track remains unread and disabled for the life of the take because some
  browsers couple display audio to it; every display track is stopped during
  final cleanup. The UI says that video is neither viewed nor saved.
- The row exposes level, `INCLUDE`, and `STOP SHARING`. It has no additional
  monitor toggle because the selected tab already controls its local playback.
- When the capability or audio track is unavailable, the row remains visible
  with truthful alternatives: `USE MICROPHONE`, `OPEN A FILE`, and “Open
  Yellowjacket in Chrome.”

For a pasted YouTube URL, the existing URL surface offers `CAPTURE PLAYING TAB`
alongside the existing local best-audio command. The browser chooser still owns
surface selection; Yellowjacket cannot preselect the URL's tab.

### Capture footer

The footer says `RECORD 1 SOURCE` or `RECORD 2 SOURCES`. Recording locks device,
lane, format, and rights controls. It displays elapsed time, remaining byte/time
budget, per-lane status, and a persistent red `STOP` button.

- YouTube normally records only the tab lane.
- A Meet workflow may include microphone and tab lanes. They become two sources
  with a shared capture-session identifier and aligned frame zero.
- A failed lane is never shown as captured. A two-lane commit is all-or-nothing.
- Escape closes the sheet only when idle. It never silently stops or discards a
  recording.

Before the first record action, a compact contextual rights step is required:

- Microphone: `ONLY ME` maps to `original-recording`; `OTHER PEOPLE MAY BE
  AUDIBLE` requires an explicit participant-consent assertion and maps to
  `permission`.
- Tab/captured media: `LIVE CALL` requires a participant-consent assertion;
  `PUBLISHED OR MEDIA AUDIO` defaults to `unknown` and allows the existing
  public-domain, licensed, permission, or fair-use-review bases plus bounded
  license, attribution, and notes.
- The sheet says: “This records your assertion; it is not legal clearance.”

## Architecture

```text
Bench / Machine / Studio / Loom / Audition
                    |
              stable engine.master
                    |
               outputGain
                    |
             AudioOutputRouter
              /             \
   AudioContext sink     MediaStreamDestination
       (direct)           -> hidden audio element
                                   -> selected sink

Mic MediaStream -------\
                        > CaptureSession -> RecorderWorklet -> owned chunks
Tab MediaStream -------/                         |
                                              CaptureSpool worker
                                                   |
                                    deterministic float32 WAV lane(s)
                                                   |
                                   SourceCaptureAdapter / SourceIngress
                                                   |
                              hash + decode + payload + source batch commit
                                                   |
                                       SourceSession activation + analysis
```

### AudioDeviceService

`AudioDeviceService` is the only module that touches `navigator.mediaDevices`,
`enumerateDevices`, `devicechange`, `getUserMedia`, or `getDisplayMedia`. It
returns frozen plain snapshots and normalized error codes. It does not know
about the DOM, project store, source registry, or audio engine.

It owns permission-scoped device enumeration and reconciles saved device-ID
hints. A stale ID becomes `default`; it is never substituted with another named
device. Every acquired track is registered before the acquiring promise
settles, so cancellation, a stale request, or a caller exception can stop it.

### AudioOutputRouter

The existing Engine keeps one stable lazy `AudioContext` and stable public
`master` bus. Every live engine already connects there. The router replaces only
the current `master -> ctx.destination` tail:

1. `SYSTEM DEFAULT` uses the direct destination with the least added latency.
2. If `AudioContext.setSinkId` exists, a named sink uses it directly.
3. Otherwise, if `HTMLMediaElement.setSinkId` exists, the router connects the
   output gain to one `MediaStreamAudioDestinationNode` and plays its stream
   through one hidden audio element assigned to that sink.
4. Otherwise, only `SYSTEM DEFAULT` is enabled.

Direct and bridge destinations are mutually exclusive. Route changes occur
under a short mute ramp. A bridge is configured off-air and must pass both
`setSinkId()` and `play()` before it can replace the current route. Context sink
mutations are serialized because their promises cannot be cancelled. A route
state records `{requested, active, mechanism, status}` and publishes `active`
only after the underlying operation succeeds. A failed selection preserves the
last working route; two audible connections are never live together.

The serializer snapshots the last working route before the first mutation. If
an older request succeeds after a newer intent exists, it remains muted and is
never published; the serializer immediately applies the newest intent. If that
newest intent fails after a direct-context sink was already mutated, the router
explicitly restores and verifies the snapshot before unmuting it. Failed
rollback leaves the graph muted in `FAULT` rather than guessing which physical
device is active.

The element bridge is explicitly stereo. Its destination and element use a
fixed two-channel speaker layout. A wider graph is rejected rather than called
multichannel output or silently advertised at the selected device's rate.

The engine gains an awaited `ensureOutputReady()` state machine. No controller
sets a playing/running flag, schedules user-visible playback, or changes button
copy until readiness resolves. A generation token prevents a late resume or
sink promise from starting a superseded request. Rejection is reported, not
swallowed. Existing synchronous graph access remains available only after a
successful readiness handle has been obtained.

`statechange` observes standard and WebKit-interrupted states. A closed context
is not reused. A supported reset stops every live transport, detaches the
router, increments `contextGeneration`, and requires Machine, Studio, Loom,
audition, metering, and monitoring to acknowledge cache teardown before a new
context becomes available.

### CaptureSession

`CaptureSession` is a separate, explicit state machine:

```text
IDLE -> ACQUIRING -> READY -> RECORDING -> FINALIZING -> COMMITTED
          |           |          |             |
          +-----------+----------+-------------+-> FAULT / CANCELLED
                                                |
                                                +-> REVIEW_PARTIAL
                                                       |       |
                                                       v       v
                                                   COMMITTED  CANCELLED
```

It owns at most one microphone stream, one display-audio stream, one dedicated
capture `AudioContext`, and one recorder worklet. It never owns the project or
mutates a source record.

The capture context requests the best supported rate consistent with the
returned track settings. Its actual `sampleRate` is the recorded rate. For a
two-lane session, both tracks enter distinct worklet inputs in the same context,
so they share the same rendering clock and frame zero. Browser resampling into
that common context is possible and is reported; no “native rate” claim is made.

The first implementation supports one or two channels per lane. It does not
upmix, fold down, or silently truncate a wider track. A channel-count change
during recording is a fault.

Microphone preview metering uses the capture graph. Optional monitoring creates
a separate source from the same authorized stream in the playback context and
connects it through the output router. It never enters the recorder path.

Track `ended`, `mute`, and `unmute` events are observed. User-ended sharing
stops/finalizes the recording. Observable track-mute intervals remain
time-preserving silence and increment the persisted interruption count. A
capture-context suspension/interruption, page hide that suspends rendering,
worklet chunk gap, sequence error, non-finite sample, channel change, or pool
overrun ends the take at the last contiguous frame. It is never resumed and
presented as one continuous clean source.

User stop and a clean automatic byte/duration limit are normal terminal
reasons. A track end or input loss with valid contiguous PCM enters
`REVIEW_PARTIAL`; the user may commit or discard it, and a committed source
records that terminal reason. Internal sequence, non-finite, overrun, or storage
corruption can never enter the normal source graph.

All exits stop every track, disconnect nodes, release message ports, close the
capture context, and retire or journal temporary storage. Simultaneous STOP,
track end, context-state change, and page-hide events converge on one idempotent
finalizer and one terminal reason.

### RecorderWorklet and CaptureSpool

The recorder worklet receives float PCM and emits monotonically sequenced,
transfer-owned channel blocks. Each buffer is channel-major planar float32
(`channel 0` frames, then `channel 1` frames), so layout does not depend on a
structured-clone array graph. It handles arbitrary render-quantum lengths and
never assumes 128 frames. Every message carries the capture/session generation,
lane, sequence, start frame, frame count, channel count, actual rate, and owned
buffer. No `SharedArrayBuffer`, `ScriptProcessorNode`, or `MediaRecorder`
fallback is presented as the high-fidelity path. A bounded pool covers
main-thread and worker jitter. Once transferred, the producer never reads or
reuses a detached buffer; reuse requires an explicit returned-buffer
acknowledgment. If the pool is exhausted, recording stops with the first missing
frame instead of dropping samples invisibly.

The main thread transfers each owned block immediately to a dedicated spool
worker. The worker writes one temporary OPFS lane file beginning after a reserved
WAV header, checks frame/sequence continuity, and returns buffers to the pool.
The worklet remains connected to an explicitly zero-gain keep-alive tail when
monitoring is off; this keeps rendering active without creating an audible
route. The worker interleaves channels with explicit little-endian `DataView`
writes. On finalization it patches one canonical RIFF/WAVE layout: `fmt ` size
16 with format tag 3 (IEEE float), actual channels/rate, 32 bits per sample,
one `fact` chunk containing the exact frame count, then one `data` chunk. The
fixed header is 56 bytes; RIFF and data lengths use checked unsigned 32-bit
arithmetic. It flushes and exposes one lane at a time for hashing and ingress.
No timestamps, device labels, `LIST` chunks, padding chunks, or other
nondeterministic metadata enter the WAV.

Capture staging uses a separate `yellowjacket-capture-v1` OPFS namespace, never
the exact project payload namespace. A small exact journal records take ID,
generation, lane files, format, state (`recording`, `finalized`, or `adopting`),
verified frame counts, and the bounded detached label, capture, and rights
metadata needed to recover a finalized take without inventing provenance.
Commit order is finalized spool, exact-byte digest, verified payload adoption,
project manifest commit, then journal cleanup. On boot, a finalized take may be
offered for recovery; an incomplete or invalid spool is never treated as a
project source and can be discarded without changing a project. No staging
filename is accepted by `.yjkt` export or the project-store exact-set validator.

The browser-capture limit is exactly 128 * 1024 * 1024 bytes per lane and never
exceeds the remaining project budget. The UI derives the exact remaining
duration from the actual rate, channels, format, and header. This bounded
sampling limit keeps the one-shot Web Crypto digest and source adoption below
the existing 250 MiB general-source ceiling. If OPFS is unavailable, a visible
limit of exactly 32 * 1024 * 1024 bytes per lane applies. Long-form recording is
outside this release.

Finalization materializes and releases only one lane at a time. The next lane is
not materialized while ingress still owns the previous bytes.

### SourceCaptureAdapter and atomic ingress

The capture subsystem returns detached immutable metadata plus a private,
single-use canonical-WAV ownership capability. `SourceCaptureAdapter` converts
it to the source-ingress contract. It never exposes a staging path, calls legacy
`loadArrayBuffer()`, or mutates `runtime` fields.

The Task 12 ingress seam must support a prepared batch:

```js
prepareEncodedSources([{ payloadOwner, displayName, origin, capture, rights }])
  -> opaquePreparedBatch

commitEncodedSources(opaquePreparedBatch)
  -> { kind, sourceIds, activeSourceId }
```

Preparation, with no observable project mutation:

1. synchronously snapshots the complete batch metadata and brands every opaque
   payload owner before invoking asynchronous work;
2. enforces per-lane and remaining-project byte limits;
3. consumes one payload owner at a time, materializing at most one complete WAV
   in memory, computing its SHA-256, decoding and verifying rate, channels,
   frames, and duration, then adopting or deduplicating its payload before the
   next lane is materialized;
4. retains only detached source metadata and private rollback capabilities once
   each large byte view has been released;
5. creates exact source records and identifies duplicates;
6. prebuilds activation state and peaks for the first selected lane; and
7. validates the complete resulting source graph and persistence projection.

`payloadOwner` is an internal branded capability, not a caller-supplied object
with callbacks. It yields ownership once and cannot be replayed, forged, read
through a public staging path, or mutated while preparation awaits. A newly
adopted payload remains unreachable staging until topology commit and is
deleted on rollback unless it was already owned by the project or deduplicated
against an existing source.

Commit is one topology transaction. It publishes the prepared payload
ownership, adds or aliases all records, activates the first included source,
and clears undo/redo exactly once after success. Any fault removes only newly
staged payloads and leaves sources, active facade, engine, history, and existing
payloads unchanged. A two-lane session cannot leave one committed lane.

### Source provenance amendment

Capture must not masquerade as `file`, `url`, or `generated`. Before v3 becomes
the live format, its exact source schema gains a required `capture` member. Every
non-captured source serializes `capture:null`. Captured sources use
`origin:{kind:'capture', url:null}` and this exact versioned descriptor:

```js
{
  version: 1,
  sessionId: 'cap:<32 lowercase hex>',
  lane: 'microphone' | 'display-audio',
  startedAt: <integer Date milliseconds>,
  endedAt: <integer Date milliseconds>,
  declaredUrl: null | <normalized user-supplied HTTP(S) URL>,
  requested: {
    sampleRate: null | <positive integer>,
    channelCount: null | 1 | 2,
    echoCancellation: null | <boolean>,
    noiseSuppression: null | <boolean>,
    autoGainControl: null | <boolean>
  },
  reported: {
    sampleRate: null | <positive integer>,
    channelCount: null | 1 | 2,
    echoCancellation: null | <boolean>,
    noiseSuppression: null | <boolean>,
    autoGainControl: null | <boolean>
  },
  browserFamily: 'chromium' | 'webkit' | 'gecko' | 'other',
  interruptions: <nonnegative safe integer>,
  terminalReason: 'user-stop' | 'track-ended' | 'input-lost' |
                  'duration-limit' | 'byte-limit'
}
```

Every descriptor is an exact own-data plain object. `sessionId` is generated
from 16 bytes of `crypto.getRandomValues()` before acquisition. Date values are
safe integers within the JavaScript Date epoch and `endedAt >= startedAt`.
`terminalReason` is the session-level reason, so both lanes of one take use the
same reason even when only one track triggered it. Two committed lanes have the
same session ID, start/end values, actual audio rate, and frame count; requested
and reported fields remain lane-specific.

The normal source `audio` envelope remains authoritative for decoded payload
rate, channels, and frames. `terminalReason` records how a graph-eligible take
ended; internal recorder/storage corruption is deliberately absent because it
cannot create a source. `declaredUrl` is stored only when the user supplied it;
Yellowjacket never guesses the selected tab's URL or title. Raw device IDs,
device labels, full user-agent strings, and permission state are forbidden from
the archive.

Because v3 is not yet the live format, this is an amendment to v3 rather than a
new format version. V2 migration and all existing source creators emit
`capture:null`. V3 validators, projection, migration, archive semantics, size
bounds, tests, and contracts change together before Task 12 exposes v3.

## Local preferences

One versioned, bounded `localStorage` record may contain:

- preferred microphone device ID hint;
- preferred output device ID hint;
- app output volume and mute; and
- requested microphone processing constraints.

Invalid or accessor-bearing data is ignored. Device labels, tab selections,
permission state, active streams, and monitor-on state are never stored. The
record is local to the origin and is excluded from autosave and `.yjkt` files.

## Error and recovery contract

Media errors are normalized for the UI without hiding the original exception
from diagnostic logs:

- `NotAllowedError`: permission denied or chooser cancelled;
- `NotFoundError`: requested device unavailable;
- `NotReadableError`: device busy or operating-system capture failure;
- `OverconstrainedError`: requested fidelity constraints unavailable;
- `InvalidStateError`: capture was not initiated by a valid user gesture;
- returned video with no audio: explicit `NO_AUDIO_TRACK`;
- track ended/device removed: `INPUT_ENDED` or `OUTPUT_LOST`;
- recorder sequence/pool/storage fault: `CAPTURE_INCOMPLETE`; and
- resume/sink failure: `OUTPUT_NOT_READY`.

Permission denial is recoverable and does not disable file workflows. Retrying
always starts a new request token. A late success from a cancelled request is
stopped and cannot change the selected device or project.

If recording has valid contiguous PCM before an external track ends, STOP may
finalize it after telling the user why it ended. Internal overrun/corruption is
never silently accepted; the temporary bytes may be offered as a clearly marked
partial WAV download, but are not added to the source graph.

## Accessibility

- Use native labelled selects, buttons, checkboxes, and range controls.
- Every color state has text. Meters include throttled textual dBFS and clip
  readings; the canvas is not the sole representation.
- Start, stop, route, and permission transitions use a restrained `role=status`;
  faults use `role=alert`. Per-frame meter changes are never aria-live.
- Focus returns to the opener when the sheet closes. The recording footer stays
  keyboard reachable, and button names remain stable while active.
- The sheet works at 200% zoom and honors reduced motion.
- No sound, permission prompt, device enumeration, or sharing chooser occurs at
  module import or page boot.

## Verification

### Pure and mocked-browser tests

- Output readiness waits for resume and sink success; rejection never changes a
  transport to playing.
- Direct and element-bridge routes are mutually exclusive and roll back without
  double sound.
- Rapid A -> B -> default route intent with sink and `play()` promises resolving
  in adversarial order leaves exactly the newest successful route audible;
  output loss while monitoring is armed fails closed rather than leaking to the
  system speakers.
- Volume/mute smoothing affects live playback and monitoring only, never capture
  or offline bytes.
- Device snapshots are detached, IDs reconcile safely, and `devicechange`
  cannot substitute a different named device.
- Permission cancellation, stale promises, missing audio tracks, track end, and
  every cleanup path stop all acquired tracks.
- Capture chunks are ordered, owned, bounded, and rejected on gap, duplicate,
  overrun, changing channel count, truncated write, or failed flush.
- Worklet quanta of 64, 128, and 256 frames; partial final blocks; transfer
  detachment; stalled buffer returns; late generations; and simultaneous STOP,
  track end, context interruption, and page hide all preserve exact ownership
  and finalize once.
- Deterministic mono/stereo WAV fixtures round-trip exact float samples, rate,
  channels, frame count, and digest.
- Dual-lane fixtures have identical sample rate, frame count, session ID, and
  frame zero while preserving distinct PCM and provenance.
- Exact capture schema, rights, bounds, v2 migration `capture:null`, v3 fixed
  point, bundle round-trip, and hostile JSON validation all pass.
- Prepared two-source commit is atomic under payload, registry, activation,
  persistence, and observer faults; duplicates do not duplicate bytes.
- Recovery tests crash after each journal edge: partial spool, finalized spool,
  payload adoption before manifest, manifest before journal cleanup, and
  two-lane rollback after the first payload. Long synthetic takes keep heap and
  in-flight bytes below a fixed plateau independent of recording duration.
- Production media modules remain import-pure and perform no permission or IO at
  import time.

### Real-browser acceptance

**Chrome 151 or later on the current macOS machine**

- System-default output test works before microphone permission.
- A named output can be selected, tested, switched, removed, and recovered.
- Microphone permission, device selection, textual/visual meter, monitor, and
  recording work with processing requested off and actual settings displayed.
- A YouTube tab chosen with Share tab audio becomes one audible, editable source.
- A Meet tab plus microphone becomes two synchronized sources with distinct
  rights/provenance and a shared session ID.
- Returning from the chooser without audio produces the actionable retry state.
- Five minutes of dual 48 kHz capture under an active call has zero recorder
  sequence gaps or pool overruns and remains within the shown byte budget.

**Safari 26.3 or later on the current macOS machine**

- System-default output works.
- A named output uses the element bridge only when runtime support and permission
  expose it; otherwise the panel visibly remains on system default.
- Microphone selection, meter, monitor, and recording work.
- Tab audio is never claimed without a returned audio track; unavailable capture
  shows Chrome, microphone, and file alternatives.

**Both browsers**

- A real person hears the output test through the selected physical route; the
  playback clock or internal meter alone is not accepted as proof.
- Existing `DEVICE RATE` copy is replaced with `PLAYBACK CONTEXT RATE`; selected
  sink hardware rate and element-bridge latency remain `UNKNOWN` unless measured
  independently.
- Unplugging the selected output during playback pauses before default-speaker
  fallback.
- Captured PCM does not change with the app volume or monitor state.
- Save, reload, archive export, archive parse, and re-open preserve both captured
  bytes and exact capture/rights provenance.
- Keyboard-only, VoiceOver, 200% zoom, reduced-motion, denial/retry, and stop-
  sharing flows pass.

### Fidelity acceptance

- A deterministic injected same-rate float stream is captured within `1e-6`
  sample error and with exact frame count. Any browser resampling case is
  measured separately and labelled rather than called bit-perfect.
- No capture has a hidden discontinuity, non-finite sample, normalization,
  channel remap, or unreported processing flag.
- Output route selection does not change offline renders, exported bytes, source
  identity, or the recorder's PCM.
- Benchmarks report actual capture context rate, channel count, block-pool high-
  water mark, sequence gaps, main-thread handler latency, and CPU during the
  active-call smoke. A missed gate is recorded, not waived by green unit tests.

## Landing order

1. Finish and review the existing Task 11 archive fix without mixing it into
   this branch.
2. Land output readiness, `AudioDeviceService`, `AudioOutputRouter`, settings UI,
   app volume/mute, test signal, and device-loss recovery.
3. Amend the not-yet-live v3 source schema with exact capture provenance and add
   the atomic prepared-source batch ingress required by Task 12.
4. Land the recorder worklet, spool worker, microphone lane, deterministic WAV,
   and SourceCaptureAdapter.
5. Land display-audio capture, YouTube/Meet affordances, and dual-lane alignment.
6. Complete real Chrome/Safari device tests, active-call capture, archive round-
   trip, accessibility checks, service-worker/preload updates, and the measured
   fidelity report before deployment.

No capture control is shipped enabled until its persistence and browser
acceptance rows are green.
