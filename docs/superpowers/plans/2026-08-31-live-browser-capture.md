# Yellowjacket High-Fidelity Browser Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record microphone and user-selected browser-tab audio as bounded deterministic float-WAV sources, preserve exact acquisition/rights provenance, and atomically add one or two synchronized lanes to Yellowjacket's multi-source project.

**Architecture:** A dedicated capture context feeds a bounded RecorderCore/AudioWorklet protocol; a worker-backed capture spool writes deterministic WAV lanes and yields private single-use payload owners. CaptureSession owns browser leases and finalization, while the Task-12 source session sequentially prepares payloads and atomically commits topology; manifest success clears the external capture journal.

**Tech Stack:** Browser ES modules, `getUserMedia()`, `getDisplayMedia()`, Web Audio `AudioWorklet`, transferable ArrayBuffers without SharedArrayBuffer, OPFS worker storage, deterministic RIFF/WAVE IEEE-float encoding, Web Crypto SHA-256, existing v3 project/archive contracts, Node test harness.

**Spec:** `docs/superpowers/specs/2026-08-31-audio-io-live-capture-design.md`

## Global Constraints

- Execute in `/Users/ian/Developer/yellowjacket/.worktrees/audio-io` after the output plan and its physical-output gate are green.
- Before Task 1, integrate the clean, reviewed Task-11 archive-fix commit. This plan was authored while that fix remained uncommitted in a separate dirty worktree; do not copy its files, reconstruct its patch, or begin the overlapping source/persistence edits from base `ba25077`.
- Tasks 1-4 may land behind inactive imports before multi-source activation. Tasks 5-9 require a clean reviewed descendant of multi-source Task 12 with public `FORMAT_VERSION === 3`, one live `SourceSession`, and manifest-last persistence. Never reconstruct uncommitted Task-11/12 work from another worktree.
- Capture enters only through `prepareEncodedSources()` and `commitEncodedSources()`. It never calls legacy `loadArrayBuffer()`, writes `source.bin`, or mutates runtime facade fields directly.
- Capture modules request no permission, enumerate nothing, construct no context/worker, and perform no storage I/O at import or page boot.
- The actual capture-context rate and observed channels/frames define the captured PCM. No native ADC, bit-perfect, physical-device-rate, or unmeasured latency claim is allowed.
- The high-fidelity path has no `MediaRecorder`, `ScriptProcessorNode`, SharedArrayBuffer, silent drop, zero-fill repair, normalization, resampling claim, or automatic channel remap.
- Recorder packets use channel-major planar float32 ownership, arbitrary render quanta, exact sequence/start-frame fields, and one-way transfer/recycle.
- A sequence gap, nonfinite sample, channel change, pool overrun, context interruption, hidden-page suspension, or storage corruption cannot create a normal source.
- OPFS capture limit is exactly `128 * 1024 * 1024` bytes per lane; memory fallback is exactly `32 * 1024 * 1024`; remaining project budget may lower either limit.
- Canonical WAV is a 56-byte RIFF/WAVE header, `fmt ` size 16/tag 3, exact `fact` frame count, one `data` chunk, 32-bit float little-endian interleave, and no metadata chunks.
- `yellowjacket-capture-v1` is a separate staging namespace. Capture staging names never enter `.yjkt`, `yellowjacket-v1`, or project exact-set validation.
- Every source record has required `captures`. Existing/noncaptured records use `captures:[]`; acquisition history has at most 16 exact entries sorted by `(startedAt, sessionId, lane)`.
- Identical payload bytes share one source ID. Per-lane `{lane,sourceId}` mappings and exact acquisition entries remain distinct; a seventeenth event fails atomically with `CAPTURE_HISTORY_FULL`.
- A two-lane take is one topology transaction. It may yield one or two unique source IDs, but it cannot commit only one requested lane or silently lose provenance.
- Mic monitor defaults off, is never persisted on, is disconnected before output fallback, routes through selected Yellowjacket output, and cannot alter recorder PCM.
- Display capture is always a fresh user-gesture chooser. Yellowjacket cannot preselect or infer a tab, URL, title, or remote speaker.
- A finalized capture journal clears only after the exact committed project revision's manifest is written and read back. `UNSAVED` leaves recovery state intact.
- No capture control is enabled in the production panel until schema, payload, Task-12 persistence, browser, accessibility, and physical fidelity gates are green.
- Every named test helper is implemented in its declaring test module before its case runs: `memoryCaptureStore()` supplies fault-injectable sink/journal/limits; `validTakeDraft()`, `finalizedAcquisitions()`, and `packet()` return exact valid plain data; session/batch/persistence/UI/display fixtures return all counters, tracks, contexts, stores, and controls asserted by their cases with no failure enabled by default. Each group begins with a fixture self-check, so RED is a missing/incorrect production seam rather than `ReferenceError`.

## File Structure

- Create `js/audio/capture-contract.js` — exact limits, packet/acquisition validation, budget arithmetic, and shared enums.
- Create `js/audio/recorder-core.js` — pure bounded quantum accumulator, sequence, finiteness, and transfer-pool ownership.
- Create `worklets/yj-recorder-worklet.js` — thin AudioWorklet adapter over RecorderCore.
- Create `js/audio/float-wav.js` — canonical float-WAV header/interleave/parser boundary.
- Create `js/audio/capture-spool-core.js` — pure journal/state/continuity logic over injected byte sinks.
- Create `js/audio/capture-spool.js` — main-thread worker proxy and private payload-owner capability.
- Create `workers/capture-spool-worker.js` — OPFS/memory worker adapter for the capture namespace.
- Create `js/audio/capture-session.js` — media leases, capture context/worklet, monitoring, state, and idempotent finalizer.
- Create `js/app/capture-rights.js` — pure consent/rights state and exact per-lane assertions.
- Create `js/app/source-capture-adapter.js` — finalized-take to Task-12 batch ingress.
- Create `test/audio-recorder.mjs`, `test/audio-spool.mjs`, and `test/audio-capture.mjs` — pure/mocked capture groups.
- Create `test/browser/audio-io-fixture.html`, `test/browser/audio-io-fixture.js`, and `test/fixtures/audio-capture-goldens.mjs` — explicit local manual harness and deterministic fixture values.
- Modify `js/app/source-registry.js`, `js/app/persist.js`, and existing multi-source fixtures — required exact capture-history schema and v2 migration.
- Modify `js/app/source-payload-store.js` — private prepared-adoption receipts with idempotent publish/rollback.
- Modify `js/app/source-session.js` — serialized prepared batch and atomic topology commit.
- Modify Task-12 `js/app/project-io.js` and `js/app/persist-controller.js` — revision-specific manifest receipt and journal retention/cleanup.
- Extend `js/app/audio-devices.js`, `js/app/audio-io-ui.js`, and `js/app/audio-io-controller.js` from the output plan — browser leases and live capture controls.
- Modify `js/main.js`, `js/app/source-controller.js`, `index.html`, `sw.js`, `docs/preload-snippet.html`, `docs/CONTRACT-AUDIO-IO.md`, `docs/CONTRACT-PERSIST.md`, `docs/CONTRACT-PROJECT.md`, and `docs/SMOKE.md` — composition, YouTube affordance, exact contracts, static packaging, and acceptance.
- Modify `test/run.mjs`, `test/multisource-core.mjs`, `test/multisource-runtime.mjs`, and `test/multisource-persist.mjs` — group registration and cross-boundary regressions.

---

### Task 1: Exact bounded capture-acquisition schema

**Files:**
- Modify: `js/app/source-registry.js:4-18,24-176,177-215`
- Modify: `js/app/persist.js:23-31,297-304,416-463,700-730,1270-1440`
- Modify: `test/multisource-core.mjs` source-record fixtures and cases
- Modify: `test/multisource-persist.mjs` v3/migration/bundle fixtures and cases
- Modify: `test/multisource-runtime.mjs` session source-record fixtures
- Modify: `docs/CONTRACT-PERSIST.md` source envelope
- Modify: `docs/CONTRACT-PROJECT.md` source identity/provenance

**Interfaces:**
- Consumes: existing source ID, rights, URL, date, exact-v3, and archive validation boundaries.
- Produces:

```js
export const CAPTURE_HISTORY_LIMIT = 16;
export function validateCaptureAcquisition(value); // {ok,issues}
export function mergeCaptureAcquisitions(current, additions);
// -> {kind:'merged', captures} | {kind:'full'} | {kind:'conflict'}
```

The required source-record key becomes `captures`, always an array. Each entry is exact `{displayName,rights,capture}`; the nested capture descriptor uses the exact fields/enums in the approved spec.

- [ ] **Step 1: Add registry and v3 schema RED cases**

Use the existing source fixtures but make missing `captures` an explicit failure. Add this complete collision table:

```js
function acquisition(sessionId, lane, startedAt = 1000) {
  return {
    displayName: lane === 'microphone' ? 'Voice take' : 'Meet tab',
    rights: {
      basis: lane === 'microphone' ? 'original-recording' : 'permission',
      license: null, attribution: null, notes: null,
    },
    capture: {
      version: 1, sessionId, lane, startedAt, endedAt: startedAt + 1000,
      declaredUrl: null,
      requested: {
        sampleRate: null, channelCount: null, echoCancellation: false,
        noiseSuppression: false, autoGainControl: false,
      },
      reported: {
        sampleRate: 48000, channelCount: 1, echoCancellation: false,
        noiseSuppression: false, autoGainControl: false,
      },
      browserFamily: 'chromium', interruptions: 0, terminalReason: 'user-stop',
    },
  };
}

function identicalPayloadAcquisitionsRemainDistinctAndCanonical() {
  const mic = acquisition('cap:00000000000000000000000000000001', 'microphone');
  const tab = acquisition('cap:00000000000000000000000000000001', 'display-audio');
  const merged = mergeCaptureAcquisitions([], [tab, mic]);
  assert.equal(merged.kind, 'merged');
  assert.deepEqual(merged.captures.map((row) => row.capture.lane),
    ['display-audio', 'microphone']);
  assert.equal(Object.isFrozen(merged.captures[0]), true);
}
```

Add: ordinary source requires `captures:[]`; capture-origin source requires at least one entry; noncapture origin may acquire capture history without overwriting origin; exact replay is idempotent; same session/lane with differing metadata is conflict; unsorted imported history rejects; duplicate event keys reject; 16 entries accept; 17 reject; 16 plus exact replay accepts; 15 plus two new events rejects atomically; accessors/proxies/prototypes/unknown keys/forbidden device or UA fields reject without getter calls; invalid date order/URL/enums/nullable settings reject; v2 migration emits `captures:[]`; fixed-point and bundle round-trip preserve acquisition name and rights.

- [ ] **Step 2: Run full RED**

```bash
npm test
```

Expected: source-record fixtures fail because `captures` is absent and capture exports do not exist.

- [ ] **Step 3: Implement independent exact validators**

In `source-registry.js`, snapshot own data descriptors exactly once, reject accessors/proxies/nonplain data, and compare acquisition values after trusted detachment rather than object-key insertion order. Canonical comparator is:

```js
function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCaptureAcquisition(left, right) {
  return (left.capture.startedAt < right.capture.startedAt ? -1
      : left.capture.startedAt > right.capture.startedAt ? 1 : 0)
    || compareAscii(left.capture.sessionId, right.capture.sessionId)
    || compareAscii(left.capture.lane, right.capture.lane);
}
```

`persist.js` independently enforces the same grammar through exact `SOURCE_KEYS`; do not trust the registry validator across imported JSON. All source constructors/fixtures and v2 migration explicitly provide `captures:[]`. Keep public `FORMAT_VERSION === 2` until Task 12 switches it.

- [ ] **Step 4: Run focused/full GREEN**

```bash
node --input-type=module -e "import('./test/multisource-core.mjs').then(async m => { for (const f of m.sourceRegistryCases) await f(); })"
node --input-type=module -e "import('./test/multisource-persist.mjs').then(async m => { for (const group of [m.projectFormatCases,m.migrationCases,m.projectBundleV3Cases]) for (const f of group) await f(); })"
npm test
git diff --check
```

Expected: all existing and new schema, migration, fixed-point, and archive groups pass.

- [ ] **Step 5: Commit the schema amendment**

```bash
git add js/app/source-registry.js js/app/persist.js test/multisource-core.mjs test/multisource-persist.mjs test/multisource-runtime.mjs docs/CONTRACT-PERSIST.md docs/CONTRACT-PROJECT.md
git commit -m "Preserve exact capture acquisition history"
```

### Task 2: Bounded RecorderCore and canonical float WAV

**Files:**
- Create: `js/audio/capture-contract.js`
- Create: `js/audio/recorder-core.js`
- Create: `js/audio/float-wav.js`
- Create: `worklets/yj-recorder-worklet.js`
- Create: `test/audio-recorder.mjs`
- Create: `test/fixtures/audio-capture-goldens.mjs`
- Modify: `test/run.mjs:96-105,4359-4432`

**Interfaces:**

```js
export const CAPTURE_LIMIT_OPFS = 128 * 1024 * 1024;
export const CAPTURE_LIMIT_MEMORY = 32 * 1024 * 1024;
export const FLOAT_WAV_HEADER_BYTES = 56;
export function planCaptureBudget(input); // frozen exact frames/bytes/seconds
export function validateRecorderPacket(packet, expected); // frozen metadata
export function validateCaptureDraft(value);
export function finalizeCaptureAcquisition({ draft, sessionId, startedAt,
  endedAt, reported, browserFamily, interruptions, terminalReason });
export function normalizeCaptureError(error, phase);
export function classifyBrowserFamily(navigatorSnapshot);

export class RecorderCore {
  constructor({ generation, sessionId, lanes, sampleRate, blockFrames, buffersPerLane });
  push(inputs);              // -> frozen message list
  recycle({ generation, lane, slot, sequence, buffer });
  // reclaims the logical slot only after the exact validated worker receipt
  flush();                   // final partial chunks once
  fault(code);               // terminal once
}

export function createFloatWavHeader({ sampleRate, channelCount, frameCount });
export function interleavePlanarFloat32LE(planar, channelCount, frameCount);
export function parseCanonicalFloatWav(bytes);
```

- [ ] **Step 1: Write recorder/WAV RED cases**

```js
function canonicalStereoHeaderAndSamples() {
  const left = Float32Array.of(-1, -0, 0.5);
  const right = Float32Array.of(1, 0.25, -0.5);
  const body = interleavePlanarFloat32LE([left, right], 2, 3);
  const header = createFloatWavHeader({ sampleRate: 48000, channelCount: 2, frameCount: 3 });
  assert.equal(header.byteLength, 56);
  assert.equal(new TextDecoder().decode(header.slice(0, 4)), 'RIFF');
  assert.equal(new DataView(header.buffer).getUint16(20, true), 3);
  assert.equal(new DataView(header.buffer).getUint32(44, true), 3);
  const parsed = parseCanonicalFloatWav(new Uint8Array([...header, ...body]));
  assert.deepEqual(Array.from(parsed.channels[0]), Array.from(left));
  assert.deepEqual(Array.from(parsed.channels[1]), Array.from(right));
}
```

Add recorder cases for 64/128/256 and irregular quanta, mono/stereo planar layout, block boundary splits, exact sequence/start frame, partial flush once, wrong generation, wrong lane/slot/sequence, late recycle, transferred/detached ownership, pool exhaustion at first missing frame, nonfinite sample, channel change, replay, and post-terminal input. A slot remains unavailable after its chunk crosses the worklet boundary and becomes reusable only after a worker receipt with the same `{generation,lane,slot,sequence}` and a newly transferred full-size buffer; JavaScript object identity is never used across agents. Add WAV cases for checked RIFF/data/fact arithmetic, wrong tag/chunk order/padding, truncation, overflow, nonfinite input, exact little-endian bytes, and hard-coded SHA-256 goldens. Capture-draft cases accept only exact `{lane,displayName,rights,declaredUrl,requested}` metadata and forbid caller timing, reported settings, interruption count, terminal reason, device identity, or browser family. Finalization builds the exact acquisition from trusted clock/session/track state. Table-test normalized `NotAllowedError`, `NotFoundError`, `NotReadableError`, `OverconstrainedError`, `InvalidStateError`, `NO_AUDIO_TRACK`, `INPUT_ENDED`, `OUTPUT_LOST`, `CAPTURE_INCOMPLETE`, and `OUTPUT_NOT_READY`, while passing the original exception separately to diagnostics.

- [ ] **Step 2: Run focused RED**

```bash
node --input-type=module -e "import('./test/audio-recorder.mjs').then(async m => { for (const group of [m.recorderCoreCases,m.floatWavCases]) for (const f of group) await f(); })"
```

Expected: FAIL with missing capture modules.

- [ ] **Step 3: Implement pure core and thin worklet**

RecorderCore preallocates a fixed pool per lane. Every `chunk` is exactly:

```js
{
  type: 'chunk', generation, sessionId, lane, slot, sequence, startFrame,
  frameCount, channelCount, sampleRate, buffer,
}
```

The buffer contains channel 0 frames followed by channel 1 frames. After transfer, the slot is unavailable until the exact buffer returns in `recycle`; no allocation fallback exists. `push()` accepts arbitrary equal-length input channels and copies only finite samples. `flush()` emits one partial block per lane and one `stopped` receipt.

The worklet adapter imports RecorderCore, responds to exact `configure/start/stop/recycle` messages, transfers each `chunk.buffer`, and registers only `yellowjacket-recorder-v1`. Its recycle message is exactly `{type:'recycle',generation,lane,slot,sequence,buffer}` with `buffer` in the transfer list. It contains no permission, storage, project, DOM, MediaRecorder, ScriptProcessor, or SharedArrayBuffer reference.

- [ ] **Step 4: Run focused/full GREEN and static worklet scan**

```bash
node --input-type=module -e "import('./test/audio-recorder.mjs').then(async m => { for (const group of [m.recorderCoreCases,m.floatWavCases]) for (const f of group) await f(); })"
rg -n 'MediaRecorder|ScriptProcessor|SharedArrayBuffer|navigator|document|localStorage' js/audio/recorder-core.js js/audio/float-wav.js worklets/yj-recorder-worklet.js
npm test
git diff --check
```

Expected: forbidden scan is empty and all groups pass.

- [ ] **Step 5: Commit deterministic recorder primitives**

```bash
git add js/audio/capture-contract.js js/audio/recorder-core.js js/audio/float-wav.js worklets/yj-recorder-worklet.js test/audio-recorder.mjs test/fixtures/audio-capture-goldens.mjs test/run.mjs
git commit -m "Add deterministic bounded PCM recording"
```

### Task 3: Crash-recoverable CaptureSpool and payload owners

**Files:**
- Create: `js/audio/capture-spool-core.js`
- Create: `js/audio/capture-spool.js`
- Create: `workers/capture-spool-worker.js`
- Create: `test/audio-spool.mjs`
- Modify: `test/run.mjs`

**Interfaces:**

```js
export class CaptureSpoolCore {
  constructor({ sink, journal, limits });
  async open(takeDraft);
  async append(packet);
  async finalize({ terminalReason, acquisitions });
  async materialize(lane);
  async markAdopting(metadata);
  async committed(revision);
  async discard();
  async recover();
}

export class CaptureSpool extends EventTarget {
  constructor({ workerFactory } = {});
  async open(takeDraft);
  async append(packet, transfer); // -> frozen RecycleReceipt
  async finalize({ terminalReason, acquisitions });
  finalizedTake(); // -> shared authentic FinalizedTake capability
  payloadOwner(lane); // frozen opaque handle
  async markAdopting(metadata);
  async committed(revision);
  async recover(); // -> frozen finalized/adopting summaries only
  async claimRecovered(takeId); // -> shared authentic FinalizedTake capability
  async discard();
  dispose();
}

export async function consumeCapturePayloadOwner(owner);
// -> { bytes: Uint8Array, ownershipTransfer: opaque } exactly once
export function claimCapturePayloadTransfer({ bytes, ownershipTransfer });
// synchronously consumes the spool-private brand, verifies exact view/range,
// transfers its ArrayBuffer, and returns the sole owned Uint8Array
export function consumeFinalizedCapture(handle);
// consumes exactly once either a live or recovered FinalizedTake issued by this
// module and returns frozen {acquisitions,payloadOwners,journalSettlement}
export async function markCaptureAdopting(journalSettlement, metadata);
export async function settleCaptureJournal(journalSettlement, revision);
// settlement is a spool-private stateful capability, never a path or spool ref
```

- [ ] **Step 1: Write spool/journal RED cases**

```js
async function manifestReceiptAloneClearsAnAdoptingJournal() {
  const io = memoryCaptureStore();
  const spool = new CaptureSpoolCore({ sink: io.sink, journal: io.journal, limits: io.limits });
  await spool.open(validTakeDraft());
  await spool.append(packet({ sequence: 0, startFrame: 0, frameCount: 3 }));
  await spool.finalize({
    terminalReason: 'user-stop', acquisitions: finalizedAcquisitions(),
  });
  await spool.markAdopting({
    revision: 42,
    sourceIds: ['sha256:' + 'a'.repeat(64)],
    lanes: [{ lane: 'microphone', sourceId: 'sha256:' + 'a'.repeat(64) }],
  });
  assert.equal((await spool.recover()).length, 1);
  await assert.rejects(() => spool.committed(41), /revision/);
  assert.equal((await spool.recover()).length, 1);
  await spool.committed(42);
  assert.deepEqual(await spool.recover(), []);
}
```

Add: exact `recording -> finalized -> adopting -> cleanup`; wrong-state rejection; duplicate/gap/overlap/rate/channel/size mismatch; failed write/flush/header patch/readback; exact OPFS/memory limits and project budget; one lane materialized at a time; owner frozen/branded/single-use after success or rejection; materialization returns an exact full-buffer Uint8Array plus a private transfer bound to that identity/range; forged/proxy/accessor owner or transfer rejects; `claimCapturePayloadTransfer()` accepts only that brand/view once and synchronously detaches the caller; worker late generation; idempotent discard; crash after each journal edge, including before and after atomic draft-to-final-acquisition replacement; finalized recovery includes exact detached label/acquisition/rights; incomplete/corrupt spool never becomes a source owner; heap/in-flight bytes plateau in a 100,000-packet synthetic run. `finalizedTake()` and `claimRecovered()` issue the same private capability brand; live and recovered handles each consume once, a summary is never a handle, and corrupt/incomplete journals cannot issue one. Consumption returns a distinct private `journalSettlement`; forged/cross-take/replayed settlement capabilities reject, `markCaptureAdopting()` performs only the exact finalized-to-adopting transition, and `settleCaptureJournal()` clears only that take after the exact saved revision. Test this complete transition for both live and recovered handles without exposing the CaptureSpool object or storage path. For every chunk, assert the complete executable round trip: worklet transfer detaches its buffer, main calls `CaptureSpool.append()`, the worker durably appends and returns `{generation,lane,slot,sequence,buffer}`, main validates the frozen receipt and transfers it to the worklet, and only then does RecorderCore reuse that slot. Wrong or duplicate receipts fault rather than aliasing a slot.

- [ ] **Step 2: Run focused RED**

```bash
node --input-type=module -e "import('./test/audio-spool.mjs').then(async m => { for (const f of m.captureSpoolCases) await f(); })"
```

Expected: FAIL with missing spool modules.

- [ ] **Step 3: Implement injected core, worker, and private brand**

The exact journal is plain data:

```js
{
  version: 1, takeId, generation, state,
  lanes: [{ lane, tempName, sampleRate, channelCount, frames, byteLength }],
  drafts: [{ lane, displayName, rights, declaredUrl, requested }],
  acquisitions: null | [{ displayName, rights, capture }],
  adopting: null | { revision, sourceIds, lanes: [{ lane, sourceId }] },
}
```

The real worker uses only a `yellowjacket-capture-v1` directory and exact filenames derived from validated take ID/lane. It writes after a reserved 56-byte header, interleaves via explicit little-endian DataView operations, flushes, patches/read-verifies header and lengths, and returns the transferred packet buffer only after durable append. The reply is exactly `{type:'recycle',generation,lane,slot,sequence,buffer}`; the main wrapper validates it against the one outstanding packet before forwarding it with a transfer list to the worklet. The recording journal contains drafts only. Finalization validates complete trusted acquisitions, patches/read-verifies every WAV, and atomically changes the journal to `finalized` with those acquisitions; a crash before that edge can never expose invented `endedAt` or terminal metadata. The main wrapper stores payload-owner, transfer, finalized-take, and journal-settlement authenticity in module-private WeakMaps whose state references an authentic spool/take/lane and exact full-buffer view/range. Only exported consuming functions may use those brands; none accepts a caller callback or path.

- [ ] **Step 4: Run focused/full GREEN and import-purity checks**

```bash
node --input-type=module -e "import('./test/audio-spool.mjs').then(async m => { for (const f of m.captureSpoolCases) await f(); })"
node --input-type=module -e "Object.defineProperty(globalThis,'navigator',{get(){throw Error('navigator read')}}); await import('./js/audio/capture-spool.js?purity=1')"
node --check workers/capture-spool-worker.js
npm test
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 5: Commit capture staging**

```bash
git add js/audio/capture-spool-core.js js/audio/capture-spool.js workers/capture-spool-worker.js test/audio-spool.mjs test/run.mjs
git commit -m "Add recoverable capture spooling"
```

### Task 4: Browser media leases and CaptureSession state machine

**Files:**
- Modify: `js/app/audio-devices.js`
- Modify: `js/audio-engine.js`
- Create: `js/audio/capture-session.js`
- Create: `test/audio-capture.mjs`
- Modify: `test/run.mjs`

**Interfaces:**
- Consumes: output-plan Engine/router, AudioDeviceService, CaptureSpool, worklet URL, injected capture-context factory and page lifecycle.
- Produces:

```js
AudioDeviceService.prototype.acquireMicrophone = async function (options) {}; // MediaLease
AudioDeviceService.prototype.acquireDisplayAudio = async function (options) {}; // MediaLease
AudioDeviceService.prototype.stopLease = function (lease) {};
AudioDeviceService.prototype.reconcileInputId = function (
  deviceId, { notFound = false } = {},
) {};

Engine.prototype.attachMonitorStream = async function (stream) {}; // opaque handle
Engine.prototype.detachMonitorStream = function (handle) {};       // boolean

export class CaptureSession extends EventTarget {
  constructor({ devices, spoolFactory, captureContextFactory, workletUrl,
    playbackEngine, clock, randomBytes, browserFamily, pageLifecycle } = {});
  get state();
  snapshot();
  async acquireMicrophone(options);
  async acquireDisplayAudio(options);
  setIncluded(lane, included);
  async setMonitor(enabled);
  disconnectMonitor();          // synchronous, idempotent, -> wasConnected
  async start({ draftsByLane });
  async stop(reason = 'user-stop'); // -> FinalizedTake | PartialCapture
  async commitPartial();            // -> FinalizedTake
  async discardPartial();
  async cancel();
  async dispose();
}
// stop()/commitPartial() return the shared FinalizedTake issued by CaptureSpool;
// CaptureSession cannot mint or weaken that capability.

// event: 'capturestate', detail is the exact deep-frozen snapshot():
// { phase, sessionId, lanes, monitoring, startedAt, elapsedFrames,
//   budgetFrames, terminalReason, error, revision }
// phase: 'idle' | 'acquiring' | 'ready' | 'recording' | 'finalizing' |
//        'review-partial' | 'committed' | 'fault' | 'cancelled'
// error: null | { code, phase, message } (bounded public text; no raw cause)
// lane row:
// { lane, status, included, sampleRate, channelCount, frames,
//   muted, interruptions }
// event: 'capturelevel', deep-frozen detail:
// { lane, peakDb, rmsDb, clipped, frames, revision }
```

- [ ] **Step 1: Write lease/session RED cases**

```js
async function simultaneousTerminalSignalsFinalizeExactlyOnce() {
  const fixture = captureSessionFixture();
  await fixture.session.acquireMicrophone({ deviceId: 'default', allowProcessing: false });
  fixture.session.setIncluded('microphone', true);
  await fixture.session.start({ draftsByLane: fixture.drafts });
  await Promise.all([
    fixture.session.stop('user-stop'),
    fixture.micTrack.emitEnded(),
    fixture.captureContext.setState('suspended'),
    fixture.pageLifecycle.hide(),
  ]);
  assert.equal(fixture.spool.finalizeCalls, 1);
  assert.equal(fixture.trackStopCalls, 1);
  assert.equal(fixture.contextCloseCalls, 1);
}
```

Add: post-permission input snapshots extend the shared `AudioDeviceService.snapshot` as exact detached `{deviceId,label,isDefault}` rows, set `inputIdsAuthoritative:true`, and arrive through the same frozen `deviceschange` detail without discarding output rows; duplicate/malformed inputs reject; a hidden/default-only snapshot preserves the preferred mic, while authoritative absence or an explicit named-mic `NotFoundError` passed as `{notFound:true}` reconciles it to default without selecting another named input; raw mic constraints exact; relaxed processing only after explicit retry; returned settings authoritative; late/stale stream tracks stop; display video-only stops all and raises `NO_AUDIO_TRACK`; video stays unread/disabled until cleanup; one shared capture context/frame zero for two lanes; actual context rate stored; 1/2 channels accept and wider rejects; mute keeps frame continuity and increments interruptions; internal faults end at last contiguous frame without review/commit; clean external end enters `REVIEW_PARTIAL`; exact byte and duration boundaries finalize cleanly as `byte-limit`/`duration-limit`; monitor defaults off, `attachMonitorStream()` connects only the authorized stream to stable playback `master`, synchronous `disconnectMonitor()`/`detachMonitorStream()` are idempotent, and recorder PCM is identical on/off; selected output loss logs monitor detach before router fallback while healthy input capture continues; live finalization returns the spool-issued shared handle rather than a session-local brand; exactly 16 random bytes produce `cap:<32 lowercase hex>`; caller drafts cannot supply clock/result fields; safe clock order, one-read reported settings, browser-family classification, and final reason produce the acquisition; every state snapshot is frozen; all terminal paths clean exactly once. Assert `capturestate` fires once for each transition and at no more than 10 Hz for progress, while `capturelevel` fires at no more than 10 Hz per lane; external track end, mute/unmute, context interruption, page hide, and automatic byte/duration limits update frozen event detail without any UI intent. No event detail exposes streams, tracks, device IDs, paths, or raw exceptions.

- [ ] **Step 2: Run focused RED**

```bash
node --input-type=module -e "import('./test/audio-capture.mjs').then(async m => { for (const f of m.captureSessionCases) await f(); })"
```

Expected: missing CaptureSession and lease methods.

- [ ] **Step 3: Implement branded leases and capture state**

AudioDeviceService keeps lease authenticity in a private WeakMap. The outer acquisition promise registers every returned track before resolving; stale/cancelled requests stop immediately. Microphone constraints are:

```js
{
  audio: {
    deviceId: deviceId === 'default' ? undefined : { exact: deviceId },
    echoCancellation: allowProcessing ? undefined : false,
    noiseSuppression: allowProcessing ? undefined : false,
    autoGainControl: allowProcessing ? undefined : false,
  },
  video: false,
}
```

Display uses `{video:true,audio:true}` and validates a live audio track. Composition derives the bounded family enum once with `classifyBrowserFamily()` and discards the raw navigator snapshot; CaptureSession accepts only that enum. CaptureSession constructs the context only after leases exist and from the record gesture. For one lane it requests that track's valid reported rate; for two equal reported rates it requests the common rate; for differing or absent rates it omits the constructor rate. A `NotSupportedError` on an explicit rate retries once without it, and only the resulting `context.sampleRate` becomes captured-audio truth. It loads the worklet, connects each included track to distinct inputs, connects a zero-gain keepalive to the capture destination, and starts only after a worklet frame-zero acknowledgment. Monitoring awaits playback readiness, then `attachMonitorStream()` creates a playback-context source connected to stable `master`; no capture-context recorder node is reused. Its one private finalizer owns stop/ended/mute/context/page/spool convergence, derives completed acquisitions from drafts plus trusted state, and passes them atomically into spool finalization.

- [ ] **Step 4: Run focused/full GREEN and permission import-purity scan**

```bash
node --input-type=module -e "import('./test/audio-capture.mjs').then(async m => { for (const f of m.captureSessionCases) await f(); })"
node --input-type=module -e "for (const k of ['navigator','window','document']) Object.defineProperty(globalThis,k,{get(){throw Error(k+' read')}}); await import('./js/audio/capture-session.js?purity=1')"
npm test
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 5: Commit inactive browser capture state**

```bash
git add js/app/audio-devices.js js/audio-engine.js js/audio/capture-session.js test/audio-capture.mjs test/run.mjs
git commit -m "Add truthful browser capture sessions"
```

## Task-12 Activation Gate

Before executing Tasks 5-9, integrate the clean reviewed multi-source Task-12 commit and run:

```bash
node --input-type=module -e "const p=await import('./js/app/persist.js'); if(p.FORMAT_VERSION!==3) process.exit(1)"
node --input-type=module -e "const s=await import('./js/app/source-session.js'); for(const n of ['add','remove','prepareProjectReplacement','commitProjectReplacement']) if(typeof s.SourceSession.prototype[n]!=='function') process.exit(1)"
node --input-type=module -e "const io=await import('./js/app/project-io.js'); if(typeof io.commitManifest!=='function') process.exit(1)"
timeout 180 npm test
git status --short --branch
```

Expected: all three probes and all tests exit zero; tracked status is clean. If the gate fails, execute and review Task 12 from `docs/superpowers/plans/2026-08-30-multisource-foundation.md` before touching capture ingress or production UI.

### Task 5: Branded sequential payload adoption and atomic encoded-source batches

**Files:**
- Modify: `js/app/source-payload-store.js:1-385`
- Modify: `js/app/source-session.js:296-683` plus Task-12 add/remove methods
- Modify: `js/app/persist.js` pure candidate-source projection
- Create: `js/app/source-capture-adapter.js`
- Create: `js/app/capture-rights.js`
- Modify: `test/multisource-runtime.mjs` payload/session groups
- Modify: `test/multisource-persist.mjs` candidate v3 projection cases
- Modify: `test/audio-capture.mjs`
- Modify: `test/run.mjs`

**Interfaces:**

```js
SourcePayloadRepository.prototype.prepareOwnedAdoption = async function ({
  sourceId, bytes, ownershipTransfer,
}) {};
// -> opaque receipt consumed only by publishPreparedAdoption/rollbackPreparedAdoption
SourcePayloadRepository.prototype.preflightCandidateSources = async function ({
  sourceIds, receipts,
}) {}; // verifies every candidate ID has one exact current/staged payload

SourceSession.prototype.prepareEncodedSources = async function (items) {}; // opaque handle
SourceSession.prototype.commitEncodedSources = function (handle) {};
// -> {kind,sourceIds,lanes,activeSourceId,revision}

export function preflightSourceTopologyV3(project, runtime, {
  sources, activeSourceId, savedAt,
}); // -> frozen serializeProjectV3-compatible projection or throws

export function finalizeCaptureRights(input, includedLanes); // frozen map
export class SourceCaptureAdapter {
  constructor({ session, waitForManifestRevision });
  async prepare(finalizedTake);
  commit(handle);
  async settleManifest(result);
  async rollback(handle);
}
```

- [ ] **Step 1: Add adoption, batch, rights, and collision RED cases**

```js
async function identicalDualLanesWriteOnePayloadAndKeepTwoAcquisitions() {
  const fixture = encodedBatchFixture({ identicalLaneBytes: true });
  const handle = await fixture.session.prepareEncodedSources(fixture.items);
  const result = fixture.session.commitEncodedSources(handle);
  assert.equal(result.sourceIds.length, 1);
  assert.deepEqual(result.lanes, [
    { lane: 'microphone', sourceId: result.sourceIds[0] },
    { lane: 'display-audio', sourceId: result.sourceIds[0] },
  ]);
  assert.equal(fixture.payloadWrites, 1);
  assert.equal(fixture.project.sources[result.sourceIds[0]].captures.length, 2);
  assert.equal(fixture.historyClears, 1);
}
```

Add: forged/callback/proxy/accessor finalized handles, payload owners, bytes, and ownership transfers reject before traps; each finalized handle/owner/transfer is consumed once even on rejection; the transfer is branded to the exact returned byte view/range and claimed only by the exported spool claimant; lanes materialize/hash/parse/adopt sequentially with at most one encoded large view plus its required decoded PCM retained; canonical Float WAV parsing does not detach or mutate the encoded view; WAV envelope equals decoded/source audio; project byte/source/history limits; duplicate content avoids a second payload write but is still parsed and verified before acquisition merge; 16 plus exact replay succeeds; 15 plus two events fails all; prepare/commit race to 16 rechecks and fails atomically; acquisition conflict is corruption; payload/registry/engine/topology faults before commit restore project/facade/engine/history and remove only newly staged unreachable payload; a post-commit throwing observer is isolated, other observers run, committed state remains, and projection can retry; reused/project-owned payload survives rollback; stale/replayed opaque handles return false; first lane active; one revision/history clear/event; rights consent mappings and bounds. Build the complete candidate source registry and active ID during prepare, pass it through the production `preflightSourceTopologyV3()` projection/validator and repository-wide `preflightCandidateSources()`, and prove malformed existing sources, missing current/staged payloads, invalid v3 projection, and serializer failure all reject before graph, facade, engine, history, or published-payload mutation.

- [ ] **Step 2: Run focused RED**

```bash
node --input-type=module -e "import('./test/multisource-runtime.mjs').then(async m => { for (const group of [m.sourcePayloadStoreCases,m.sourceSessionCases]) for (const f of group) await f(); })"
node --input-type=module -e "import('./test/multisource-persist.mjs').then(async m => { for (const f of m.sourceTopologyPreflightCases) await f(); })"
node --input-type=module -e "import('./test/audio-capture.mjs').then(async m => { for (const group of [m.captureRightsCases,m.sourceCaptureAdapterCases]) for (const f of group) await f(); })"
```

Expected: prepared adoption and encoded batch methods are absent.

- [ ] **Step 3: Implement private receipts and one topology commit**

Repository receipt state belongs in a private WeakMap:

```js
{ sourceId, reused, newlyStaged, published: false, settled: false }
```

Only module functions may publish/rollback it; rollback consults the serialized topology lane and current graph before deleting. SourceCaptureAdapter calls the shared spool `consumeFinalizedCapture()` and therefore accepts live and recovered authentic handles through one boundary. It retains the returned private `journalSettlement` inside the adapter's own prepared-handle state, never passes it into SourceSession, and binds it to the exact successful commit-result object in a private WeakMap as `{journalSettlement,adoptingMarked:false,settled:false}` for later `settleManifest(result)`. Rollback before topology commit leaves the finalized journal recoverable and retires the adapter association without consuming settlement authority. SourceSession snapshots the complete items array/acquisition/rights before its first await, validates payload-owner brands, and processes one item at a time: consume it to `{bytes,ownershipTransfer}`, parse/verify it with the non-detaching `parseCanonicalFloatWav(bytes)`, hash that exact encoded view, then pass the still-exact full-buffer view and transfer to `prepareOwnedAdoption()`. Do not call the production `Engine.decode()` path here because it may detach its input. The repository imports and synchronously calls `claimCapturePayloadTransfer({bytes,ownershipTransfer})`; that function alone can validate the spool-private brand, exact view/range, and single use, and returns the transferred sole-owner view before the repository's first await. The repository re-verifies the digest and stages those uniquely owned bytes without a second full encoded copy. SourceSession retains no alias after the call and keeps decoded PCM/peaks only for the selected first lane plus small detached metadata/receipts for all lanes.

After all lanes are staged but before issuing the prepared handle, SourceSession constructs the full detached candidate `sources` graph and selected `activeSourceId`. `preflightSourceTopologyV3()` uses the same production v3 projection and `validateProjectDocument()` boundary as save, with the supplied source graph override, current exact asset owners, and a fixed injected `savedAt`; it returns a serialize-compatible projection only when the whole graph is valid. `preflightCandidateSources()` then verifies every projected source ID against either an existing exact payload or one of this preparation's authentic receipts and rechecks digest/length without publishing. Any failure rolls back only newly staged receipts. Commit rechecks the acquisition-history limit and candidate identity, uses one synchronous ProjectStore topology transaction and the existing activation rollback discipline, merges canonical capture history, publishes all records/receipts, activates the first lane's source, clears both history stacks once, and returns the committed revision. Tests assert the caller view is detached synchronously and cannot race the stored bytes.

SourceCaptureAdapter accepts only an authentic spool-issued FinalizedTake—whether returned by a live CaptureSession or `claimRecovered()`—constructs `origin:{kind:'capture',url:null}`, and never exposes a path or mutable bytes.

- [ ] **Step 4: Run focused/full GREEN and ownership scans**

```bash
node --input-type=module -e "import('./test/multisource-runtime.mjs').then(async m => { for (const group of [m.sourcePayloadStoreCases,m.sourceSessionCases]) for (const f of group) await f(); })"
node --input-type=module -e "import('./test/multisource-persist.mjs').then(async m => { for (const f of m.sourceTopologyPreflightCases) await f(); })"
node --input-type=module -e "import('./test/audio-capture.mjs').then(async m => { for (const group of [m.captureRightsCases,m.sourceCaptureAdapterCases]) for (const f of group) await f(); })"
npm test
rg -n 'loadArrayBuffer|source\.bin|runtime\.(buffer|sourceBytes)\s*=' js/app/source-capture-adapter.js js/audio js/app/source-session.js
git diff --check
```

Expected: forbidden capture paths are absent and all tests pass.

- [ ] **Step 5: Commit atomic capture ingress**

```bash
git add js/app/source-payload-store.js js/app/source-session.js js/app/persist.js js/app/source-capture-adapter.js js/app/capture-rights.js test/multisource-runtime.mjs test/multisource-persist.mjs test/audio-capture.mjs test/run.mjs
git commit -m "Add atomic captured-source ingress"
```

### Task 6: Bind capture journals to manifest-last persistence

**Files:**
- Modify: `js/app/project-io.js` Task-12 manifest coordinator
- Modify: `js/app/persist-controller.js` Task-12 save/retry state
- Modify: `js/app/source-capture-adapter.js`
- Modify: `js/audio/capture-spool.js`
- Modify: `test/multisource-persist.mjs`
- Modify: `test/audio-spool.mjs`
- Modify: `test/audio-capture.mjs`
- Modify: `test/run.mjs`

**Interfaces:**
- Consumes: Task-12 `commitManifest()` and Task-5 `{revision}` result.
- Produces:

```js
// persist controller API
ctx.api.waitForManifestRevision = async function (revision) {};
// -> {kind:'saved',requestedRevision,persistedRevision,document}
//  | {kind:'unsaved',requestedRevision,error}
```

- [ ] **Step 1: Add manifest/journal RED cases**

```js
async function manifestFailureKeepsLiveCaptureAndRecoveryJournal() {
  const fixture = capturePersistenceFixture({ failManifestWrite: true });
  const result = await fixture.commitTwoLaneCapture();
  const settled = await fixture.adapter.settleManifest(result);
  assert.equal(settled.kind, 'unsaved');
  assert.equal(fixture.project.revision, result.revision);
  assert.equal(fixture.journal.state, 'adopting');
  assert.equal(fixture.oldManifestIntact, true);
  assert.equal(fixture.garbageCollectCalls, 0);
}
```

Add: all source payload writes/readbacks precede `project.json`; manifest readback precedes exact-revision saved receipt; stale/other revision cannot clear journal; call `settleManifest(result)` once to receive `unsaved`, then again with a successful retry and prove `markCaptureAdopting()` ran exactly once while cleanup ran exactly once; forged, cross-take, replayed, or result-mismatched journal-settlement capability rejects; live and recovered FinalizedTake handles both carry settlement through the adapter's private prepared/result state; app crash after live commit recovers adopting journal; recovery sees source IDs already in manifest and clears rather than duplicates; source-free/ordinary saves remain unchanged; two concurrent captures serialize; v3 archive export/reopen preserves bytes plus capture histories; malformed capture history fails before hash/decode/live mutation.

- [ ] **Step 2: Run focused RED**

```bash
node --input-type=module -e "import('./test/multisource-persist.mjs').then(async m => { for (const f of m.projectIoCases) await f(); })"
node --input-type=module -e "import('./test/audio-spool.mjs').then(async m => { for (const f of m.capturePersistenceCases) await f(); })"
```

Expected: no revision-wait API and capture journal clears too early or never.

- [ ] **Step 3: Implement exact revision receipts**

The persistence coordinator records a waiter before scheduling the save. It resolves `saved` only after `project.json` write and byte-for-byte readback for a coherent `persistedRevision >= requestedRevision`. Save failure resolves `unsaved`, preserves all possibly referenced payloads, old manifest, and journal, and performs no garbage collection. Retry for the same/newer coherent revision resolves all satisfied waiters in requested-revision order.

After topology commit, SourceCaptureAdapter retrieves the exact result-bound private settlement state. On its first `settleManifest(result)` call only, it calls `markCaptureAdopting(journalSettlement,{revision,sourceIds,lanes})` and flips `adoptingMarked` after success. Every call then awaits `waitForManifestRevision(revision)`. It calls `settleCaptureJournal(journalSettlement,requestedRevision)` and flips `settled` only for `saved` after `persistedRevision >= requestedRevision` and the read-back manifest contains every exact lane mapping and matching `(sessionId,lane)` acquisition event from the journal. It never needs a public CaptureSpool reference. `unsaved` or an incomplete read-back is returned to the panel with the live project intact and retains the marked association for a later retry; a successful settlement consumes it, and later calls return the same frozen saved receipt without reusing either capability.

- [ ] **Step 4: Run focused/full GREEN**

```bash
node --input-type=module -e "import('./test/multisource-persist.mjs').then(async m => { for (const f of m.projectIoCases) await f(); })"
node --input-type=module -e "import('./test/audio-spool.mjs').then(async m => { for (const f of m.capturePersistenceCases) await f(); })"
npm test
git diff --check
```

Expected: all manifest order/retry/recovery tests and the full harness pass.

- [ ] **Step 5: Commit durable capture adoption**

```bash
git add js/app/project-io.js js/app/persist-controller.js js/app/source-capture-adapter.js js/audio/capture-spool.js test/multisource-persist.mjs test/audio-spool.mjs test/audio-capture.mjs test/run.mjs
git commit -m "Tie captured sources to durable manifest receipts"
```

### Task 7: Microphone recording, rights preflight, and persistent recording footer

**Files:**
- Modify: `js/app/audio-io-ui.js`
- Modify: `js/app/audio-io-controller.js`
- Modify: `js/main.js:1-190,480-485`
- Modify: `index.html:13-95,100-125,450-510`
- Modify: `css/yj.css` Audio I/O responsive section
- Modify: `sw.js:1-120`
- Modify: `docs/preload-snippet.html`
- Modify: `test/audio-capture.mjs`
- Create: `test/audio-io-shell.mjs`
- Modify: `test/run.mjs`

**Interfaces:**
- Consumes: CaptureSession, capture rights, SourceCaptureAdapter, output panel view/controller, and manifest receipt.
- Produces: mic row, rights step, `RECORD 1 SOURCE`, elapsed/budget footer, persistent top-bar STOP, and one-source atomic capture flow behind the final validation flag.

```js
export function projectAudioCaptureState({ sessionState, rightsState,
  budgetState, persistenceState });

// Task-7 composition extends the existing optional controller arguments:
// { captureSession, sourceCaptureAdapter, captureEnabled: false }
```

- [ ] **Step 1: Add view-model/controller RED cases**

```js
function monitorDefaultsOffAndRecordRequiresRights() {
  const model = projectAudioCaptureState(captureUiFixture({
    micReady: true, micIncluded: true, monitor: false, rightsValid: false,
  }));
  assert.equal(model.microphone.monitorChecked, false);
  assert.equal(model.footer.recordLabel, 'RECORD 1 SOURCE');
  assert.equal(model.footer.recordEnabled, false);
  assert.match(model.rights.message, /not legal clearance/i);
}
```

Add: production composition keeps `captureEnabled:false` and displays `CAPTURE VALIDATION PENDING`; injected enabled composition exercises enable/select/raw retry; a successful mic selection saves only `micInputId` and requested `micConstraints` while preserving output fields, never labels/permission/monitor state; hidden/default-only input snapshots preserve the hint, while authoritative absence or the selected named mic's explicit `NotFoundError` reconciles and persists `default`; reported settings and dBFS text; monitor headphones warning; volume/monitor independence; ONLY ME mapping; OTHER PEOPLE consent gate; byte/time budget from actual rate/channels/header; controls lock while recording; Escape cannot stop/discard; sheet close leaves persistent STOP; track/permission/storage/partial/UNSAVED states use text; one failed lane never says captured; focus/status/alert/reduced-motion/200% rules; source adapter called once; saved and unsaved receipts displayed honestly. Without dispatching a view intent, drive `deviceschange`, `capturestate`, and `capturelevel` for track end, mute/interruption, elapsed/budget, automatic limit, and input removal; assert the controller rerenders the exact newest revision, ignores stale revisions, and announces terminal/fault text once. View intent details are exact frozen data: `enablemicrophone {}`, `microphoneselect {deviceId}`, `retryprocessedmic {}`, `include {lane,included}`, `monitor {enabled}`, `rightschange {lane,value}`, `record {}`, `stop {}`, `commitpartial {}`, and `discardpartial {}`.

- [ ] **Step 2: Run focused RED**

```bash
node --input-type=module -e "import('./test/audio-capture.mjs').then(async m => { for (const f of m.microphoneUiCases) await f(); })"
node --input-type=module -e "import('./test/audio-io-shell.mjs').then(async m => { for (const f of m.audioIoShellCases) await f(); })"
```

Expected: capture controls/projections are absent.

- [ ] **Step 3: Extend the existing panel without a second surface**

Add the MICROPHONE row, contextual rights section, and fixed footer to the existing AudioIoView. Emit the exact intents/details above. Controller construction remains side-effect-free; each permission/record action invokes the service/session directly in the originating click stack. When acquiring the selected nondefault mic rejects with `NotFoundError`, call `reconcileInputId(savedId,{notFound:true})`, persist `default`, and report the retryable loss without silently opening another input. Subscribe exactly once to `deviceschange`, `capturestate`, and `capturelevel`; render only monotonically fresh revisions and remove every listener on dispose. Promise-driven prepare/commit/manifest transitions update the same controller projection directly, so no persistence promise can leave stale recording copy. `main.js` binds the output controller's existing `disconnectMonitor` closure to synchronous `captureSession.disconnectMonitor()` before any capture state becomes reachable. It supplies `captureEnabled:false`, so production controls remain disabled through Tasks 7 and 8 even though injected enabled controller tests exercise the complete flow.

Add a persistent top-bar host:

```html
<div id="audioCaptureIndicator" role="status" hidden>
  <span id="audioCaptureElapsed">00:00</span>
  <button id="btnAudioCaptureStop" class="yj-btn yj-btn-danger">STOP RECORDING</button>
</div>
```

On successful finalization, prepare/commit through SourceCaptureAdapter, show source ID/status, and await the manifest receipt without freezing the UI. On `UNSAVED`, keep the journal and offer retry/save; never call the action a failure to record if the live graph commit is coherent.

Add every newly reachable ordinary capture module to `sw.js` `PRECACHE`
exactly once, advance the current `yj-vNN` worker version once, and regenerate
`docs/preload-snippet.html`; synchronize the generated modulepreload block into
`index.html`. Worklet and worker URLs remain unreachable lazy assets and are
added explicitly by Task 9.

- [ ] **Step 4: Run focused/full GREEN and disabled-production assertions**

```bash
node --input-type=module -e "import('./test/audio-capture.mjs').then(async m => { for (const f of m.microphoneUiCases) await f(); })"
node --input-type=module -e "import('./test/audio-io-shell.mjs').then(async m => { for (const f of m.audioIoShellCases) await f(); })"
node scripts/gen-preload.mjs > docs/preload-snippet.html
npm test
git diff --check
```

Expected: mocked enabled flows pass, production composition remains visibly disabled, all ordinary static modules are preloaded/precached, and no worklet/worker request can occur. Real microphone smoke is intentionally deferred to Task 9, which flips the flag only after complete lazy-asset packaging.

- [ ] **Step 5: Commit microphone capture UI**

```bash
git add js/app/audio-io-ui.js js/app/audio-io-controller.js js/main.js index.html css/yj.css sw.js docs/preload-snippet.html test/audio-capture.mjs test/audio-io-shell.mjs test/run.mjs
git commit -m "Add high fidelity microphone capture"
```

### Task 8: Browser-tab capture, YouTube affordance, and synchronized dual lanes

**Files:**
- Modify: `js/app/audio-io-ui.js`
- Modify: `js/app/audio-io-controller.js`
- Modify: `js/audio/capture-session.js`
- Modify: `js/app/source-controller.js` URL guidance/action
- Modify: `js/main.js` exact URL-action bridge
- Modify: `test/audio-capture.mjs`
- Modify: `test/audio-io-shell.mjs`
- Modify: `test/run.mjs`

**Interfaces:**
- Consumes: display MediaLease, dual-lane CaptureSession, batch adapter, and existing local best-audio command.
- Produces: `CHOOSE TAB`, no-audio retry, Safari fallback, published/live-call rights, YouTube `CAPTURE PLAYING TAB`, and one atomic two-lane capture.

```js
// Additional exact AudioIoView events:
// 'choosetab' {}, 'stopsharing' {}, 'declaredurlchange' {value}
// Existing 'include' and 'rightschange' carry lane-specific display data.
audioIoController.openForTabCapture = function (declaredUrl) {};
// Shows/prefills the panel only; never invokes getDisplayMedia itself.
audioIoController.chooseTab = async function () {};
audioIoController.stopSharing = async function () {};
CaptureSession.prototype.releaseLane = async function (lane) {};
```

- [ ] **Step 1: Add display/dual-lane/YouTube RED cases**

```js
async function videoOnlyChooserResultStopsEverythingAndExplainsRetry() {
  const fixture = displayCaptureFixture({ audioTracks: 0, videoTracks: 1 });
  await assert.rejects(() => fixture.controller.chooseTab(), (error) => error.code === 'NO_AUDIO_TRACK');
  assert.equal(fixture.videoTracks[0].stopped, true);
  assert.equal(fixture.view.state.display.status, 'NO AUDIO');
  assert.match(fixture.view.state.display.message, /enable Share tab audio/i);
}
```

Add: chooser invoked directly from the `choosetab` click handler; `openForTabCapture()` only opens/prefills and therefore cannot lose transient activation; no URL/tab preselection; `stopsharing` calls `releaseLane('display-audio')`; video unread/unpersisted; Safari/missing capability still shows mic/file/Chrome alternatives; published media defaults rights unknown; live call requires consent; optional declared URL only from pasted value; YouTube retains local `yt-dlp` command and adds capture action through `main.js`'s exact controller reference; dual lanes share context/session/time/rate/frame zero and identical final frame count; distinct bytes yield two source IDs; identical bytes yield one write, one unique source ID, two lane mappings/history entries, and `2 LANES · 1 UNIQUE SOURCE`; either lane prepare/commit fault leaves neither; lane end partial review; tab sharing stops on cleanup.

- [ ] **Step 2: Run focused RED**

```bash
node --input-type=module -e "import('./test/audio-capture.mjs').then(async m => { for (const f of m.displayCaptureCases) await f(); })"
node --input-type=module -e "import('./test/audio-io-shell.mjs').then(async m => { for (const f of m.youtubeCaptureSurfaceCases) await f(); })"
```

Expected: display intents and YouTube capture affordance are absent.

- [ ] **Step 3: Implement truthful display capture and atomic lane UI**

Add BROWSER TAB / SYSTEM AUDIO row with `CHOOSE TAB`, level, INCLUDE, STOP SHARING, and no monitor toggle. The inline instruction is exactly “Choose the Meet or YouTube tab and enable Share tab audio.” Keep returned video disabled/unread until all display tracks stop in final cleanup. `releaseLane()` stops and removes an acquired lane while READY; if called during RECORDING, it converges on the one whole-session external-end finalizer and `REVIEW_PARTIAL` rather than silently shortening one lane.

For a normalized YouTube URL, retain the existing local extraction command and expose `CAPTURE PLAYING TAB`; `source-controller.js` calls the exact `audioIoController.openForTabCapture(normalizedUrl)` reference injected by `main.js`. That method only shows the panel and prefills `declaredUrl`; the later `CHOOSE TAB` click remains the sole `getDisplayMedia()` gesture. On missing display audio, show `USE MICROPHONE`, `OPEN A FILE`, and `Open Yellowjacket in Chrome` without browser sniffing.

Dual-lane start creates one session and one worklet frame-zero acknowledgment. Footer says `RECORD 2 SOURCES`; final result reports lane count separately from unique content count.

- [ ] **Step 4: Run focused/full GREEN with production capture still disabled**

```bash
node --input-type=module -e "import('./test/audio-capture.mjs').then(async m => { for (const f of m.displayCaptureCases) await f(); })"
node --input-type=module -e "import('./test/audio-io-shell.mjs').then(async m => { for (const f of m.youtubeCaptureSurfaceCases) await f(); })"
npm test
git diff --check
```

Expected: injected enabled fixtures prove chooser, YouTube, Meet, and dual-lane behavior; production composition remains `captureEnabled:false`. The real Chrome/Safari smoke runs only in Task 9 after the complete lazy dependency closure is cached.

- [ ] **Step 5: Commit display and dual-lane capture**

```bash
git add js/app/audio-io-ui.js js/app/audio-io-controller.js js/audio/capture-session.js js/app/source-controller.js js/main.js test/audio-capture.mjs test/audio-io-shell.mjs test/run.mjs
git commit -m "Add browser tab and dual lane capture"
```

### Task 9: Static packaging, recovery UI, fidelity, accessibility, and release gate

**Files:**
- Create: `test/browser/audio-io-fixture.html`
- Create: `test/browser/audio-io-fixture.js`
- Modify: `js/app/audio-io-ui.js`
- Modify: `js/app/audio-io-controller.js`
- Modify: `js/audio/capture-spool.js`
- Modify: `js/main.js`
- Modify: `scripts/gen-preload.mjs`
- Modify: `index.html:13-95`
- Modify: `css/yj.css`
- Modify: `sw.js:1-120`
- Modify: `docs/preload-snippet.html`
- Modify: `docs/CONTRACT-AUDIO-IO.md`
- Modify: `docs/CONTRACT-PERSIST.md`
- Modify: `docs/CONTRACT-PROJECT.md`
- Modify: `docs/SMOKE.md`
- Modify: `test/audio-io-shell.mjs`
- Modify: `test/run.mjs`

**Interfaces:**
- Consumes: complete output/capture stack.
- Produces: exact offline static graph, finalized-take recovery/discard UI, measured browser/device evidence, and release-ready contracts.

```js
// scripts/gen-preload.mjs remains import-pure and keeps main.js as CLI default.
export async function collectStaticModuleGraph({ roots }); // sorted relative paths
```

- [ ] **Step 1: Add release/static/recovery RED cases**

```js
async function everyLazyCaptureAssetIsPrecachedExactlyOnce() {
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  const paths = await collectStaticModuleGraph({ roots: [
    'worklets/yj-recorder-worklet.js', 'workers/capture-spool-worker.js',
  ] });
  assert.deepEqual(paths, [
    'js/audio/capture-contract.js', 'js/audio/capture-spool-core.js',
    'js/audio/float-wav.js', 'js/audio/recorder-core.js',
    'workers/capture-spool-worker.js', 'worklets/yj-recorder-worklet.js',
  ]);
  for (const path of paths) {
    assert.equal(sw.split(path).length - 1, 1, path + ' precache count');
  }
}
```

Add: production `captureEnabled` flips from false to true only in this task; all statically imported modules appear once in generated preloads and service-worker precache; the exact worklet/worker entry and dependency paths above appear once; version increments once; recovery UI offers finalized valid takes and discard, never incomplete/corrupt. For an adopting entry whose exact manifest revision, lane mappings, source IDs, and acquisition events are present, recovery calls `committed()` and clears without reimport. For a finalized entry—or an adopting entry whose requested manifest is absent—recovery calls `claimRecovered(takeId)`, passes that shared authentic handle through the same SourceCaptureAdapter prepare/commit/manifest path as a live take, and consumes it once; failed retry leaves the journal recoverable. Imported modules remain pure; no staging path/source.bin/device label/tab title/full UA in bundle/project JSON; keyboard order/focus/status/alert/stable STOP/reduced motion/200% source assertions.

- [ ] **Step 2: Run release RED**

```bash
node --input-type=module -e "import('./test/audio-io-shell.mjs').then(async m => { for (const f of m.audioIoReleaseCases) await f(); })"
node scripts/gen-preload.mjs > /tmp/yj-audio-capture-preload.html
```

Expected: missing lazy precache entries, fixture, and recovery surface.

- [ ] **Step 3: Finish packaging, contracts, fixture, and recovery surface**

Keep the generator CLI's default main-root output byte-compatible, but export its pure graph collector so tests can root it at the worklet and worker. Add all main-graph modules to `docs/preload-snippet.html` and synchronize the generated block into `index.html`. Add the complete computed worklet/worker dependency closure above to `PRECACHE`, and increment current `yj-vNN` once. Set production `captureEnabled:true` only after these files and recovery bindings are present. The panel/controller enumerate finalized journals on explicit panel open, offer recover/discard without exposing paths, and keep incomplete/corrupt entries unavailable. Recovery never fabricates a CaptureSession result: it obtains the shared FinalizedTake from `CaptureSpool.claimRecovered()` and hands it to SourceCaptureAdapter. It verifies an existing adopting manifest against exact revision, lane mappings, source IDs, and acquisition events before cleanup; otherwise it reruns the normal adapter path and retains the journal on any failure. The localhost fixture has explicit buttons for output test, deterministic injected capture, forced route-promise order, worklet counters, five-minute dual-lane budget/high-water telemetry, recovery, and discard; it creates no media/storage/context at boot.

Contracts bind exact state/protocol/schema/caps/history/manifest rules. `docs/SMOKE.md` evidence fields are date, exact browser build, route mechanism, context rate, returned capture settings, lanes, frames, gaps, pool high-water, main-thread chunk-handler latency distribution, process/browser CPU during the active-call interval, byte count, terminal reason, archive result, and human-heard result. Project evidence excludes identifiers/labels/tab titles.

- [ ] **Step 4: Run automated final gates**

```bash
node --check js/audio/capture-contract.js
node --check js/audio/recorder-core.js
node --check js/audio/float-wav.js
node --check js/audio/capture-spool-core.js
node --check js/audio/capture-spool.js
node --check js/audio/capture-session.js
node --check js/app/source-capture-adapter.js
node --check workers/capture-spool-worker.js
node --check worklets/yj-recorder-worklet.js
node scripts/gen-preload.mjs > docs/preload-snippet.html
timeout 180 npm test
git diff --check
git status --short
```

Expected: all commands pass and tracked scope contains only declared files.

- [ ] **Step 5: Run measured real-browser and real-device acceptance**

Start a localhost server in a PTY:

```bash
python3 -m http.server 0 --bind 127.0.0.1
```

Complete every Chrome/Safari row in the approved spec, including built-in mic, a USB interface at 48/96 kHz when available, default/nondefault output, Bluetooth profile truth, output unplug during monitored capture, permission revoke/input unplug, background/sleep/wake, long capture, reload recovery, quota exhaustion, two-tab contention, YouTube, and Meet+mic. For deterministic same-rate injection require exact frame count and sample error `<= 1e-6`; record any resampling separately. Five minutes of dual 48 kHz capture must have identical final lane frame counts, zero sequence gaps/overruns, bounded heap/in-flight bytes, recorded main-thread handler-latency distribution, and measured browser/process CPU over the capture interval. Stop the server with Ctrl-C.

Expected: measured evidence is appended to `docs/SMOKE.md`; a failed row remains a documented release blocker rather than being waived by unit tests.

- [ ] **Step 6: Commit the release-complete capture slice**

```bash
git add test/browser/audio-io-fixture.html test/browser/audio-io-fixture.js js/app/audio-io-ui.js js/app/audio-io-controller.js js/audio/capture-spool.js js/main.js scripts/gen-preload.mjs index.html css/yj.css sw.js docs/preload-snippet.html docs/CONTRACT-AUDIO-IO.md docs/CONTRACT-PERSIST.md docs/CONTRACT-PROJECT.md docs/SMOKE.md test/audio-io-shell.mjs test/run.mjs
git commit -m "Finish high fidelity browser capture"
```

## Plan Completion Gate

After the final commit, rerun:

```bash
timeout 180 npm test
git diff --check
git status --short --branch
```

Then repeat the physical route, mic, YouTube, Meet dual-lane, save/reopen, and five-minute continuity rows against the exact committed HEAD. Internal meters, clocks, green Node tests, or successful permission prompts do not prove real sound input/output or capture fidelity.
