# Yellowjacket Output Reliability and Audio I/O Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a global AUDIO I/O side sheet whose output selector, test signal, app gain, mute, meter, and readiness state make Yellowjacket playback audible, adjustable, and truthful without changing system audio settings.

**Architecture:** Preserve the existing lazy playback `AudioContext` and stable `engine.master`, insert one output-gain/router tail beneath it, and make every live scheduler await verified output readiness before claiming playback. A pure device service owns browser device enumeration; a rendering-only view emits intents; one controller binds those intents to the engine and stores bounded origin-local preferences.

**Tech Stack:** Browser ES modules, Web Audio API, Media Capture and Streams device enumeration, `HTMLMediaElement.setSinkId()` fallback, native EventTarget/CustomEvent, Node's existing test harness, static GitHub Pages service worker.

**Spec:** `docs/superpowers/specs/2026-08-31-audio-io-live-capture-design.md`

## Global Constraints

- Execute in `/Users/ian/Developer/yellowjacket/.worktrees/audio-io` on a descendant of design commit `bc1696e65cd2f8b7907af12be03b7f6c9a46c99c`; never copy or reset the dirty multi-source worktree.
- Preserve the single lazy playback `AudioContext` and the identity of `engine.master`; replace only its tail connection.
- Capability order is system-default destination, direct `AudioContext.setSinkId()`, element bridge through `HTMLMediaElement.setSinkId()`, then truthful default-only mode.
- Runtime feature detection and successful returned operations are authoritative; browser-name checks never select a code path.
- At most one route has nonzero gain. A stale or failed route promise never makes an obsolete device audible.
- The bridge is stereo. Selected-sink hardware rate and bridge latency remain unknown unless independently measured.
- App output gain is within `[0, 1]`, smoothed, and excluded from captured PCM, offline renders, and exports.
- Opening the panel performs no sound, permission request, enumeration, or device change. TEST is the only test-signal gesture.
- This plan adds output control only. Microphone/tab recording belongs to `2026-08-31-live-browser-capture.md`.
- No production module touches browser globals at import time. Tests must be able to import every new ordinary ES module under Node.
- No new package dependency, server, native driver, virtual device, system-default mutation, or system-volume mutation is permitted.
- Keep `RESET OUTPUT` disabled in this slice. A closed context directs the user to autosave/reload until every context-bound consumer implements generation teardown.
- Test helpers named in snippets are real same-module fixtures, not placeholders: `fakeContext(options)` implements the full context/node/listener surface used by Engine; `rejectingPlaybackFixture()` returns `{togglePlay,engine,starts,states}` with self-checking idle state. Define and run fixture self-checks before dynamically importing the missing production export, so RED is never a `ReferenceError` or comment-only pass. Static production imports are forbidden in these RED modules until those self-checks finish.
- Every task ends with a full `npm test`; no task is committed with a known regression.

## File Structure

- Create `js/audio-output-router.js` — transactional route ownership, gain/mute, direct/bridge capability selection, and immutable state events.
- Create `js/app/audio-devices.js` — detached device snapshots, label-reveal probe, and `devicechange`.
- Create `js/app/audio-io-preferences.js` — exact bounded origin-local preference parsing and storage.
- Create `js/app/audio-io-ui.js` — rendering-only AUDIO I/O side sheet and intent events.
- Create `js/app/audio-io-controller.js` — output orchestration and view projection.
- Create `test/audio-output.mjs` — pure router, device, readiness, and view-model cases.
- Create `docs/CONTRACT-AUDIO-IO.md` — shipped output behavior, rates, fallbacks, and explicit capture boundary.
- Modify `js/audio-engine.js` — stable output tail, awaited readiness, safe test signal, and state accessors.
- Modify `js/meters.js` — throttled textual level callback while retaining the existing meter behavior.
- Modify `js/app/bench-controller.js` — await source-transport output readiness and report failure.
- Modify `js/machine/sequencer.js`, `js/machine/controller.js`, and `js/machine/cliprefs.js` — await readiness before live MACHINE scheduling/audition.
- Modify `js/studio/engine.js` and `js/studio/controller.js` — await readiness before live Studio graph/scheduling.
- Modify `js/loom/engine.js` and `js/loom/controller.js` — await readiness before live Loom graph/scheduling.
- Modify `js/app/repair-controller.js` — await readiness before live repair preview.
- Modify `js/main.js` — construct the service/view/controller, add the command, and expose diagnostic state.
- Modify `index.html` and `css/yj.css` — top-bar action, side-sheet host, semantic controls, responsive styling.
- Modify `test/run.mjs` — register the named output test groups.
- Modify `sw.js` and `docs/preload-snippet.html` — cache every new static module exactly once, commit the generated preload graph, and advance the current worker version once.
- Modify `docs/SMOKE.md` — physical-device Chrome/Safari acceptance journey.

---

### Task 1: Transactional AudioOutputRouter

**Files:**
- Create: `js/audio-output-router.js`
- Create: `test/audio-output.mjs`
- Modify: `test/run.mjs:96-105,4359-4432`

**Interfaces:**
- Consumes: an exact `AudioContext`, one context-owned input node, and an injected `createAudioElement()` factory.
- Produces:

```js
export const SYSTEM_DEFAULT_OUTPUT = 'default';

export class AudioOutputRouter extends EventTarget {
  constructor(options);
  get state();
  async select(deviceId);       // -> frozen RouteState
  setVolume(value);             // 0..1
  setMuted(muted);              // boolean
  failClosed(code);             // latches safety mute; emits state
  clearSafetyMute();            // only after explicit verified readiness
  dispose();                    // idempotent
}

// RouteState:
// { requested, active, mechanism, status, volume, muted, safetyMuted, error }
// mechanism: 'context-default' | 'context-sink' | 'element-sink' | null
// status: 'ready' | 'switching' | 'suspended' | 'interrupted' | 'lost' |
//         'fault' | 'closed' | 'disposed'
```

- [ ] **Step 1: Write the failing router tests**

Add complete fake graph objects and named cases rather than patching browser globals:

```js
import assert from 'node:assert/strict';

function fakeNode(name, log) {
  return {
    name,
    gain: { value: 1, setTargetAtTime(value) { this.value = value; } },
    connect(target) { log.push(['connect', name, target.name]); return target; },
    disconnect(target) { log.push(['disconnect', name, target && target.name]); },
  };
}

function directFixture() {
  const log = [];
  const context = {
    currentTime: 0,
    destination: fakeNode('destination', log),
    createGain: () => fakeNode('gain-' + log.length, log),
    async setSinkId(id) { log.push(['sink', id]); },
  };
  return { log, context, input: fakeNode('input', log) };
}

function assertRouterFixtures() {
  const fixture = directFixture();
  assert.equal(fixture.context.destination.name, 'destination');
  assert.equal(typeof fixture.context.createGain, 'function');
  assert.equal(typeof fixture.input.connect, 'function');
}

assertRouterFixtures();
const { AudioOutputRouter, SYSTEM_DEFAULT_OUTPUT } =
  await import('../js/audio-output-router.js');

async function defaultRouteStartsReadyAndOwnsOneAudibleTail() {
  const fixture = directFixture();
  const router = new AudioOutputRouter({
    context: fixture.context,
    input: fixture.input,
    createAudioElement() { throw new Error('direct route must not create an element'); },
  });
  assert.equal((await router.select(SYSTEM_DEFAULT_OUTPUT)).active, SYSTEM_DEFAULT_OUTPUT);
  assert.equal(router.state.mechanism, 'context-default');
  const connects = fixture.log.filter(([kind]) => kind === 'connect');
  assert.equal(connects.length, 2);
  assert.equal(connects[0][1], 'input');
  assert.equal(connects[1][2], 'destination');
}
```

Define and use this deferred helper for the adversarial cases:

```js
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function newestIntentWinsAdversarialSinkPromises() {
  const fixture = directFixture();
  const a = deferred();
  const b = deferred();
  fixture.context.setSinkId = (id) => {
    fixture.log.push(['sink', id]);
    if (id === 'speaker-a') return a.promise;
    if (id === 'speaker-b') return b.promise;
    return Promise.resolve();
  };
  const router = new AudioOutputRouter({
    context: fixture.context,
    input: fixture.input,
    createAudioElement() { throw new Error('direct route only'); },
  });
  await router.select(SYSTEM_DEFAULT_OUTPUT);
  const selectingA = router.select('speaker-a');
  await Promise.resolve();
  const selectingB = router.select('speaker-b');
  a.resolve();
  await selectingA;
  b.reject(new DOMException('gone', 'NotFoundError'));
  await assert.rejects(selectingB, /gone/);
  assert.equal(router.state.active, SYSTEM_DEFAULT_OUTPUT);
  assert.equal(router.state.status, 'ready');
  assert.equal(fixture.log.filter((row) => row[0] === 'sink' && row[1] === '').length, 1,
    'default is explicitly restored after the stale direct-sink mutation');
}

async function elementBridgeMustPassSetSinkAndPlayBeforeCommit() {
  const fixture = directFixture();
  delete fixture.context.setSinkId;
  const sink = deferred();
  const playing = deferred();
  const streamDestination = fakeNode('stream-destination', fixture.log);
  streamDestination.stream = Object.freeze({ id: 'bridge-stream' });
  fixture.context.createMediaStreamDestination = () => streamDestination;
  const element = {
    name: 'bridge-element', srcObject: null,
    setSinkId(id) { fixture.log.push(['element-sink', id]); return sink.promise; },
    play() { fixture.log.push(['play']); return playing.promise; },
    pause() { fixture.log.push(['pause']); },
  };
  const router = new AudioOutputRouter({
    context: fixture.context,
    input: fixture.input,
    createAudioElement: () => element,
  });
  await router.select(SYSTEM_DEFAULT_OUTPUT);
  const selecting = router.select('speaker-a');
  await Promise.resolve();
  assert.equal(router.state.active, SYSTEM_DEFAULT_OUTPUT);
  sink.resolve();
  await Promise.resolve();
  assert.equal(router.state.active, SYSTEM_DEFAULT_OUTPUT);
  playing.resolve();
  assert.equal((await selecting).active, 'speaker-a');
  assert.equal(router.state.mechanism, 'element-sink');
  assert.equal(streamDestination.channelCount, 2);
  assert.equal(element.srcObject, streamDestination.stream);
}

export const audioOutputRouterCases = [
  defaultRouteStartsReadyAndOwnsOneAudibleTail,
  newestIntentWinsAdversarialSinkPromises,
  elementBridgeMustPassSetSinkAndPlayBeforeCommit,
];
```

For the bridge case, construct a context without `setSinkId`, return a named
`createMediaStreamDestination()` node, and inject an element with deferred
`setSinkId()` and `play()`. Assert `active === 'default'` before both resolve,
then `active === 'speaker-a'`, `mechanism === 'element-sink'`, two explicit
channels, and a disconnected default route. Add table-driven rows for element
`setSinkId()` rejection, `play()` rejection, direct rollback rejection, rapid
A -> B -> default, duplicate same-device request, volume/mute bounds, frozen
detached state, `failClosed()` safety latch surviving a verified route switch,
explicit `clearSafetyMute()`, idempotent disposal, no surviving element
stream/node, and exact constructor-option accessors rejected without invoking
their getters. Proxy trap failures are caught and leave no connected route.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
node --input-type=module -e "import('./test/audio-output.mjs').then(async m => { for (const f of m.audioOutputRouterCases) await f(); })"
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `js/audio-output-router.js`.

- [ ] **Step 3: Implement the minimal router**

Use exactly one app-output gain followed by two private unity route gains. The router receives that app-output gain as `input`: `setVolume()`/`setMuted()` apply the single smoothed effective app gain `(muted ? 0 : volume)` to `input.gain`, while route gains are only an exclusive safety/crossfade switch (`0` or `1`). This makes `input` itself the post-app-gain/pre-route meter source and prevents double gain. Map `default` to `''` only at the Web API boundary. Serialize every direct-context mutation on one promise lane. Before the first mutation snapshot the verified active route; stale success remains at zero route gain; newest failure restores and verifies the snapshot or stays muted in `fault`.

The constructor and state boundary must follow this shape:

```js
const ROUTERS = new WeakMap();

export class AudioOutputRouter extends EventTarget {
  constructor(options) {
    super();
    const { context, input, createAudioElement } = snapshotRouterOptions(options);
    if (!context || !input || typeof input.connect !== 'function') {
      throw new TypeError('AudioOutputRouter requires a context-owned input');
    }
    ROUTERS.set(this, {
      context, input, createAudioElement,
      requested: SYSTEM_DEFAULT_OUTPUT,
      active: null,
      mechanism: null,
      status: 'switching',
      volume: 1,
      muted: false,
      safetyMuted: false,
      error: null,
      intent: 0,
      lane: Promise.resolve(),
      direct: null,
      bridge: null,
      disposed: false,
    });
  }

  get state() {
    const s = requireRouter(this);
    return Object.freeze({
      requested: s.requested, active: s.active, mechanism: s.mechanism,
      status: s.status, volume: s.volume, muted: s.muted,
      safetyMuted: s.safetyMuted, error: s.error,
    });
  }
}
```

Never feed the bridge element back through `createMediaElementSource()`. Configure `MediaStreamAudioDestinationNode.channelCount = 2`, `channelCountMode = 'explicit'`, and `channelInterpretation = 'speakers'`. The app-output input gain uses a 15 ms target ramp for volume/mute. Route gains also ramp over 15 ms, but only the committed route receives `safetyMuted ? 0 : 1`; all other routes remain zero. Selecting or verifying a route never clears `safetyMuted`; a successful selection while latched updates `active`/`mechanism` but remains in `lost` state. Only the Engine's explicit PLAY/TEST readiness path calls `clearSafetyMute()` after the route and running context are verified. Tests measure node gains and prove volume `0.5` produces exactly one `0.5` stage—not two `0.5` stages—and that the meter tap is after that stage but before the safety route gains.

- [ ] **Step 4: Run focused and full GREEN**

Run:

```bash
node --input-type=module -e "import('./test/audio-output.mjs').then(async m => { for (const f of m.audioOutputRouterCases) await f(); })"
npm test
git diff --check
```

Expected: all router cases and all existing groups pass; diff check emits nothing.

- [ ] **Step 5: Commit the router boundary**

```bash
git add js/audio-output-router.js test/audio-output.mjs test/run.mjs
git commit -m "Add transactional audio output routing"
```

### Task 2: Awaited Engine readiness, app gain, and test signal

**Files:**
- Modify: `js/audio-engine.js:10-28,195-220,313-320,449-456`
- Modify: `test/audio-output.mjs`
- Modify: `test/multisource-runtime.mjs:821-910`
- Modify: `test/run.mjs:915-945`

**Interfaces:**
- Consumes: `AudioOutputRouter` from Task 1.
- Produces:

```js
export class OutputNotReadyError extends Error {
  constructor(code, cause);
}

Engine.prototype.ensureOutputReady = async function () {}; // -> frozen RouteState
Engine.prototype.selectOutput = async function (deviceId) {}; // -> frozen RouteState
Engine.prototype.setOutputVolume = function (value) {};
Engine.prototype.setOutputMuted = function (muted) {};
Engine.prototype.handleOutputLoss = function (code = 'OUTPUT_LOST') {};
// synchronous -> frozen RouteState; invalidates readiness and latches safety mute
Engine.prototype.testOutput = async function () {}; // -> true after scheduled
Engine.prototype.outputState; // getter
Engine.prototype.outputGeneration; // getter
Engine.prototype.outputMeterSource; // getter: post-app-gain, pre-route node
Engine.prototype.readyContext; // guarded getter after ensureOutputReady()
Engine.prototype.configureOutputPreferences = function (preferences) {};
// stores requested output/volume/mute without creating a context
Engine.prototype.setOutputInterruptionHandler = function (handler) {};
```

- [ ] **Step 1: Add readiness RED cases**

Add cases that inject a fake `AudioContext` through a constructor option rather than changing global state:

```js
async function resumeRejectionNeverClaimsReadyOrPlaying() {
  const context = fakeContext({
    state: 'suspended',
    resume: () => Promise.reject(new DOMException('blocked', 'NotAllowedError')),
  });
  const engine = new Engine({ contextFactory: () => context });
  await assert.rejects(() => engine.ensureOutputReady(), (error) => (
    error.name === 'OutputNotReadyError' && error.code === 'OUTPUT_NOT_READY'
  ));
  assert.equal(engine.outputState.status, 'fault');
  assert.equal(engine.playing, false);
}
```

Also assert: context is created synchronously before the first await; one concurrent readiness promise performs one resume; resume fulfillment with state still suspended rejects; WebKit `interrupted` is not ready; sink selection is awaited; a saved preference configures requested sink/gain/mute without constructing the context; an unavailable saved hint falls back to verified system default in the same explicit PLAY/TEST gesture and reports the reconciliation, while a failed explicit live selection preserves its prior verified route; `statechange` emits immutable `outputstate`; suspended/interrupted/closed states mute the route and synchronously invoke the one interruption handler before notification; `handleOutputLoss()` synchronously invalidates the readiness generation, calls the private router's `failClosed()` exactly once, returns its frozen state, and never selects a sink or edits persisted mute; test signal schedules left 440 Hz then right 660 Hz at exactly `10 ** (-24 / 20)` peak with 5 ms ramps and 0.4 s total duration; test failure schedules no oscillator; output gain/mute never changes offline rendering.

- [ ] **Step 2: Run focused RED**

```bash
node --input-type=module -e "import('./test/audio-output.mjs').then(async m => { for (const f of m.engineOutputCases) await f(); })"
```

Expected: FAIL because `Engine` has no injectable context factory or readiness methods.

- [ ] **Step 3: Integrate the stable output tail**

Change the constructor compatibly:

```js
constructor({
  contextFactory = defaultContextFactory,
  outputRouterFactory = (options) => new AudioOutputRouter(options),
  createAudioElement = defaultAudioElementFactory,
} = {})
```

In `_ensureCtx()` create exactly:

```js
this._ctx = this._contextFactory();
this._master = this._ctx.createGain();
this._outputGain = this._ctx.createGain();
this._master.connect(this._outputGain);
this._outputRouter = this._outputRouterFactory({
  context: this._ctx,
  input: this._outputGain,
  createAudioElement: this._createAudioElement,
});
```

`configureOutputPreferences()` validates and stores requested output, volume, and mute without constructing a context. `ensureOutputReady()` must create the context synchronously, apply those values, await `resume()` when needed, require `ctx.state === 'running'`, await the router's requested route, and coalesce concurrent callers. A persisted requested ID is only a hint: if its first application is unavailable, restore/verify system default during that same explicit readiness gesture and emit the reconciliation rather than suppressing playback. Explicit later selections retain transactional prior-route semantics. It dispatches `outputstate` and preserves the original exception as `cause`. Context `statechange` to suspended, interrupted, or closed first increments the output generation, mutes/fail-closes the route, and synchronously invokes the configured interruption handler. Retain the existing synchronous `wake()` behavior only through Task 3 so this commit stays compatible; mark it as a temporary internal compatibility path and do not add callers. `readyContext` throws unless the current context, route, and generation are verified.

`testOutput()` awaits readiness, then creates two oscillators, two gains, and a two-channel merger feeding `master`. It schedules all starts/stops before returning `true` and disconnects nodes from both `onended` callbacks.

- [ ] **Step 4: Run transaction, focused, and full GREEN**

```bash
node --input-type=module -e "import('./test/audio-output.mjs').then(async m => { for (const f of [...m.audioOutputRouterCases, ...m.engineOutputCases]) await f(); })"
npm test
git diff --check
```

Expected: output groups pass; existing decode/install/checkpoint and lifecycle groups remain green.

- [ ] **Step 5: Commit Engine readiness**

```bash
git add js/audio-engine.js test/audio-output.mjs test/multisource-runtime.mjs test/run.mjs
git commit -m "Make Yellowjacket output readiness explicit"
```

### Task 3: Gate every live scheduler on verified output

**Files:**
- Modify: `js/audio-engine.js:197-220`
- Modify: `js/app/bench-controller.js:88-104,472-483`
- Modify: `js/app/wire-controller.js` pad trigger handlers
- Modify: `js/machine/sequencer.js:210-282,520-552`
- Modify: `js/machine/controller.js:1168-1190,1248-1270`
- Modify: `js/machine/cliprefs.js:760-820`
- Modify: `js/studio/engine.js:160-216,248-262`
- Modify: `js/studio/controller.js` live play handlers
- Modify: `js/loom/engine.js:35-65`
- Modify: `js/loom/controller.js:500-580`
- Modify: `js/app/repair-controller.js:166-205`
- Modify: `js/main.js` transport-interruption composition and seek handlers
- Modify: `test/audio-output.mjs`
- Modify: `test/run.mjs:915-945`

**Interfaces:**
- Consumes: `await engine.ensureOutputReady()` from Task 2.
- Produces: every public live-play/audition method returns `Promise<boolean>`; the legacy `engine.wake()` is removed, and the guarded `engine.readyContext` getter returns the existing context only after verified readiness. `ctx.api.stopMachinePreviews()` and `ctx.api.stopRepairPreview()` are synchronous, idempotent stop boundaries for locally owned one-shot nodes; the existing auditioner/Studio/Loom/sequencer/source stops retain the same property.

- [ ] **Step 1: Add false-playing and call-site RED cases**

Create controller/scheduler fixtures around a shared rejecting Engine and assert no source, oscillator, timer, transport flag, button copy, or `state {playing:true}` occurs before readiness:

```js
async function benchDoesNotClaimPlayingWhenResumeFails() {
  const { togglePlay, engine, starts, states } = rejectingPlaybackFixture();
  const result = await togglePlay();
  assert.equal(result, false);
  assert.equal(starts.length, 0);
  assert.deepEqual(states, []);
  assert.equal(engine.playing, false);
}
```

Add equivalent cases for source transport, wire-pad `trigger()`, Sequencer `start()`/`playSong()`, seek while playing, Studio, Loom, ClipAuditioner, generated sample preview, modal preview, and repair preview. Assert two rapid gestures cannot let an older readiness promise start after a newer stop intent. Machine synth/modal previews and repair previews retain each live `AudioBufferSourceNode` in a private `Set`, remove it on `ended`, and expose the exact synchronous stop methods above; tests start two overlapping nodes, stop them, and prove both sets drain even when one node's `stop()` throws. Drive fake context state through suspended, WebKit interrupted, and closed; assert the interruption callback invokes those stop methods and stops every other already-running transport before the immutable state event is observed.

- [ ] **Step 2: Run RED and perform the unsafe-call inventory**

```bash
node --input-type=module -e "import('./test/audio-output.mjs').then(async m => { for (const f of m.liveOutputGateCases) await f(); })"
rg -n '\.(wake|play|trigger|start|playSong|seek|preview|audition)\(' js/audio-engine.js js/app js/machine js/studio js/loom
```

Expected: focused failure shows current synchronous scheduling; inventory lists every migration target.

- [ ] **Step 3: Convert live entry points**

Use this exact ordering in each public start method; readiness rejection
propagates to the controller, which calls `statusFault` and restores idle copy:

```js
const request = ++this._startRequest;
const ready = await this.engine.ensureOutputReady();
if (request !== this._startRequest || ready.status !== 'ready') return false;
const ctx = this.engine.readyContext; // synchronous assertion; never resumes
// Build and schedule the complete graph synchronously here.
this._playing = true;
this.dispatchEvent(new CustomEvent('state', { detail: { playing: true } }));
return true;
```

STOP/pause increments the same request before tearing down nodes. Event handlers `await` the returned promise and leave stable button copy on failure. Remove `resumeContext()` and every ignored resume rejection from `audio-engine.js`. Update MACHINE kit copy from `DEVICE RATE` to `PLAYBACK CONTEXT RATE`; no UI derives selected hardware rate from `engine.ctx.sampleRate`.

In `main.js`, compose one synchronous interruption closure over every live stop
method and register it with `engine.setOutputInterruptionHandler()` before any
transport control is exposed. The explicit list includes source transport,
sequencer, ClipAuditioner, Studio, Loom, `ctx.api.stopMachinePreviews()`, and
`ctx.api.stopRepairPreview()`. Each stop runs in isolated try/catch; the closure
does not resume, select a sink, or schedule audio.

- [ ] **Step 4: Run full GREEN and prove no unsafe wake remains**

```bash
npm test
rg -n '\.wake\(\)' js
rg -n '\.(play|trigger|start|playSong|seek|preview|audition)\(' js/app js/machine js/studio js/loom
rg -n 'DEVICE RATE|resume\(\).*catch|resumeContext' js test
git diff --check
```

Expected: the wake search is empty; the inventory contains only audited methods with readiness tests; the final search has no unsafe copy/suppression; all test groups pass.

- [ ] **Step 5: Commit live readiness gating**

```bash
git add js/audio-engine.js js/app/bench-controller.js js/app/wire-controller.js js/machine/sequencer.js js/machine/controller.js js/machine/cliprefs.js js/studio/engine.js js/studio/controller.js js/loom/engine.js js/loom/controller.js js/app/repair-controller.js js/main.js test/audio-output.mjs test/run.mjs
git commit -m "Gate live audio on verified output"
```

### Task 4: AudioDeviceService and bounded local preferences

**Files:**
- Create: `js/app/audio-devices.js`
- Create: `js/app/audio-io-preferences.js`
- Modify: `test/audio-output.mjs`
- Modify: `test/run.mjs`

**Interfaces:**
- Consumes: injected `mediaDevices` and clock in tests; the production
  constructor resolves its default through a service-local lazy
  `defaultMediaDevices()` function. Injected storage exists only in the separate
  preference functions. Neither module knows the DOM, engine, project, or archive,
  and no caller outside `audio-devices.js` reads `navigator.mediaDevices`.
- Produces:

```js
export class AudioDeviceService extends EventTarget {
  constructor({ mediaDevices = defaultMediaDevices(), clock = Date.now,
    reportDiagnostic = () => {} } = {});
  get snapshot();
  async enumerate();
  async revealOutputLabels();
  reconcileOutputId(deviceId, { notFound = false } = {});
  dispose();
}

// event: 'deviceschange' with the frozen snapshot as detail
// snapshot: { outputs, inputs, outputLabelsAvailable, inputLabelsAvailable,
//             outputIdsAuthoritative, inputIdsAuthoritative,
//             permission, error, revision }
// output/input row: { deviceId, label, isDefault }

export const AUDIO_IO_PREFERENCES_KEY = 'yj.audio-io.v1';
export function defaultAudioIoPreferences();
export function parseAudioIoPreferences(value);
export function loadAudioIoPreferences(storage);
export function saveAudioIoPreferences(storage, preferences);
```

- [ ] **Step 1: Write device-service RED cases**

```js
async function labelProbeStopsEveryTrackBeforeResolving() {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  const mediaDevices = {
    async getUserMedia() { return { getTracks: () => tracks }; },
    async enumerateDevices() {
      assert.equal(tracks[0].stopped, true, 'probe track is already stopped');
      return [{ kind: 'audiooutput', deviceId: 'speaker-a', label: 'Desk DAC' }];
    },
    addEventListener() {}, removeEventListener() {},
  };
  const service = new AudioDeviceService({ mediaDevices });
  assert.equal((await service.revealOutputLabels()).outputs[0].label, 'Desk DAC');
}
```

Also assert: default output exists without permission; the production no-argument constructor—not `main.js`—is the sole reader of `navigator.mediaDevices`, while importing the module performs no global read; a prototype-accessor-backed MediaDeviceInfo fake is read once per required field and becomes a detached plain row; duplicate IDs reject; labels are bounded; malformed/getter-throwing rows are caught without aborting the batch; a stale enumeration cannot overwrite a newer `devicechange`; a pre-permission/default-only snapshot has `outputIdsAuthoritative:false` and preserves a missing saved ID; even a successful probe remains nonauthoritative when the post-grant raw rows are absent or contain empty IDs/labels; a post-grant enumeration is authoritative for an input/output kind only when that kind has at least one real returned row and every returned row of that kind has a nonempty detached ID and label; only an authoritative absent ID or an explicit sink `NotFoundError` reconciles the saved output to default, never to another named output; probe rejection is recoverable; all late tracks stop; every successful or failed fresh enumeration emits exactly one `deviceschange`; persisted JSON accepts only exact versioned own-data `{version:1,outputId,micInputId,volume,muted,micConstraints}`; accessors, proxies, huge strings, nonfinite volume, labels, permissions, and monitor state are never persisted. The inactive microphone hint defaults to `default` and is preserved unchanged by output-only edits.

- [ ] **Step 2: Run focused RED**

```bash
node --input-type=module -e "import('./test/audio-output.mjs').then(async m => { for (const f of m.audioDeviceCases) await f(); })"
```

Expected: FAIL with missing `js/app/audio-devices.js`.

- [ ] **Step 3: Implement service and preferences**

Real `MediaDeviceInfo` fields are WebIDL prototype accessors. Read `kind`,
`deviceId`, and `label` exactly once each inside one try/catch, immediately detach
the primitive values, and never retain the platform row. A throwing or malformed
row is ignored; do not require own data descriptors from browser objects. Wrap
`getUserMedia()` in an outer promise so returned tracks are registered and
stopped before `revealOutputLabels()` resolves or rejects. Normalize browser
exceptions to data:

```js
{ code: 'NOT_ALLOWED' | 'NOT_FOUND' | 'NOT_READABLE' | 'ENUMERATION_FAILED', name, message }
```

Before publishing normalized failure data, call `reportDiagnostic(original,
{operation,code})` in isolated try/catch so the original exception remains
available to local diagnostics without entering persisted/view state.

`defaultMediaDevices()` is a non-exported function evaluated only by the
production no-argument constructor; it snapshots `globalThis.navigator` and
its `mediaDevices` field inside one try/catch and throws a normalized
`MEDIA_DEVICES_UNAVAILABLE` error when absent. The module performs no global
read at import time, and `main.js` constructs `new AudioDeviceService()` without
touching `navigator`. Test callers inject `mediaDevices` directly.
After a successful probe, compute each authority flag from the detached raw
post-grant enumeration, before adding a synthetic default row: the kind must
contain at least one row and every row of that kind must have a nonempty ID and
label. Probe success alone never grants authority.
`audio-io-preferences.js` accepts storage only as a function argument and uses
the exact shape `{version:1,outputId,micInputId,volume,muted,micConstraints}`.
It preserves the bounded future microphone ID hint and constraints while this
slice edits output fields.
`dispose()` removes the one `devicechange` listener and invalidates every
pending generation.

- [ ] **Step 4: Run focused/full GREEN and import-purity probe**

```bash
node --input-type=module -e "import('./test/audio-output.mjs').then(async m => { for (const f of m.audioDeviceCases) await f(); })"
node --input-type=module -e "Object.defineProperty(globalThis,'navigator',{get(){throw Error('navigator read')}}); await import('./js/app/audio-devices.js?purity=1')"
node --input-type=module -e "Object.defineProperty(globalThis,'localStorage',{get(){throw Error('storage read')}}); await import('./js/app/audio-io-preferences.js?purity=1')"
npm test
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 5: Commit the device boundary**

```bash
git add js/app/audio-devices.js js/app/audio-io-preferences.js test/audio-output.mjs test/run.mjs
git commit -m "Add safe browser audio device discovery"
```

### Task 5: Render and wire the output side sheet

**Files:**
- Create: `js/app/audio-io-ui.js`
- Create: `js/app/audio-io-controller.js`
- Modify: `index.html:13-95,100-123,450-510`
- Modify: `css/yj.css:77-140,740-790`
- Modify: `js/main.js:1-52,110-190,284-321,480-485`
- Modify: `sw.js:1-120`
- Modify: `docs/preload-snippet.html`
- Modify: `test/audio-output.mjs`
- Modify: `test/run.mjs`

**Interfaces:**
- Consumes: `Engine`, `AudioDeviceService`, and one host element.
- Produces:

```js
export function projectAudioOutputState({ engineState, deviceSnapshot, level });

export class AudioIoView extends EventTarget {
  constructor(host);
  setState(state);
  show(opener);
  hide();
  get visible();
}

export function initAudioIoController({ engine, devices, view,
  loadPreferences, savePreferences, pauseLiveTransports, disconnectMonitor,
  reportError });
// returns { snapshot, refresh, dispose }
```

View events are exactly `outputselect {deviceId}`, `outputtest {}`, `outputvolume {value}`, `outputmute {muted}`, `revealoutputs {}`, `close {}`. The capture plan adds capture intents without changing these names.

- [ ] **Step 1: Add projection and intent RED cases**

```js
function outputProjectionNeverCallsContextRateDeviceRate() {
  const state = projectAudioOutputState({
    engineState: {
      requested: 'speaker-a', active: 'speaker-a', mechanism: 'element-sink',
      status: 'ready', volume: 0.75, muted: false, contextRate: 48000,
      baseLatency: 0.01, outputLatency: null,
    },
    deviceSnapshot: { outputs: [{ deviceId: 'speaker-a', label: 'Desk DAC', isDefault: false }] },
    level: { peakDb: -12.4, clipped: false },
  });
  assert.equal(state.rateLabel, 'PLAYBACK CONTEXT RATE · 48 KHZ');
  assert.equal(state.hardwareRateLabel, 'SELECTED DEVICE RATE · UNKNOWN');
  assert.equal(state.signalLabel, 'SIGNAL · -12.4 DBFS');
}
```

Add exact projections for suspended, WebKit interrupted, closed, switching, lost-with-muted-default-prepared, fault, muted, no signal, clipping, default-only fallback, label permission, test busy, measured `baseLatency`/`outputLatency` when finite, unknown latency otherwise, and reset-disabled reload guidance. Assert preference load occurs once without context creation/enumeration, initial volume/mute take effect on first readiness, a hidden/default-only device snapshot preserves a missing saved hint, an authoritative snapshot or explicit `NotFoundError` persists `default`, and successful changes save the exact record while preserving mic fields. In a minimal fake DOM, assert native labels/control names, focus return, Escape closes only while idle, no import/constructor permission or sound, and every emitted detail is frozen plain data.

- [ ] **Step 2: Run focused RED**

```bash
node --input-type=module -e "import('./test/audio-output.mjs').then(async m => { for (const f of m.audioIoViewCases) await f(); })"
```

Expected: FAIL with missing UI/controller exports.

- [ ] **Step 3: Implement the view and controller**

Add to the top bar:

```html
<button id="btnAudioIo" class="yj-btn" aria-haspopup="dialog" aria-controls="audioIoHost">AUDIO I/O</button>
```

Add before the status footer:

```html
<div id="audioIoHost" class="yj-audio-io" hidden></div>
```

The view builds a right-side `role="dialog" aria-modal="true" aria-labelledby="audioIoTitle"` with native `select`, `range`, checkbox, buttons, a labelled meter canvas, a throttled textual level, `role=status`, and `role=alert`. Backdrop/Escape closes only while idle; close restores the exact opener.

The controller serializes view intents. At construction it calls
`loadPreferences()` once, passes validated output/volume/mute values to
`engine.configureOutputPreferences()` without creating a context or enumerating,
and retains the preferred output as a hint until the first fresh device
snapshot. Successful select/volume/mute changes call `savePreferences()` while
preserving microphone fields; stale or failed selection never overwrites the
stored ID. It disables selection/test while switching, awaits engine operations,
publishes only fresh state, and reports errors without hiding the prior active
route. `pauseLiveTransports` and `disconnectMonitor` are synchronous no-throw
composition callbacks; the latter is initially a no-op closure and Task 7 of
the capture plan binds the live CaptureSession. Construct the controller in
`main.js` after Engine and views; add command-deck action:

```js
{ id: 'audio-io', group: 'OUTPUT', label: 'AUDIO I/O',
  note: 'Choose, test, and diagnose Yellowjacket playback',
  keywords: 'speaker headphones device volume mute silent',
  run: () => $('btnAudioIo').click() }
```

Expose `audioIoController` and a frozen `getAudioIoDiagnostics()` snapshot in `window.__yj` for smoke diagnostics. Do not expose the device service, media streams, raw device lists/labels, storage, or private route handles.

Subscribe exactly once to the service's `deviceschange`; reconcile the stored
output only from a fresh snapshot whose `outputIdsAuthoritative` is true. A
default-only snapshot keeps the saved ID as an unavailable hint; an explicit
`NotFoundError` from that ID is separately authoritative and reconciles it.
Add the five new ordinary modules to
`index.html`'s modulepreload block and `sw.js` `PRECACHE` exactly once, advance
the current `yj-vNN` worker version once, and regenerate
`docs/preload-snippet.html` from `scripts/gen-preload.mjs`. Synchronize that
generated block into `index.html`; updating only the documentation artifact is
not sufficient.

- [ ] **Step 4: Run focused/full GREEN and static composition checks**

```bash
node --input-type=module -e "import('./test/audio-output.mjs').then(async m => { for (const f of m.audioIoViewCases) await f(); })"
node scripts/gen-preload.mjs > docs/preload-snippet.html
npm test
rg -n 'audio-output-router|audio-devices|audio-io-preferences|audio-io-ui|audio-io-controller' docs/preload-snippet.html
git diff --check
```

Expected: all new modules appear once in the generated graph and all tests pass.

- [ ] **Step 5: Commit the visible output panel**

```bash
git add js/app/audio-io-ui.js js/app/audio-io-controller.js index.html css/yj.css js/main.js sw.js docs/preload-snippet.html test/audio-output.mjs test/run.mjs
git commit -m "Add the Audio I/O output panel"
```

### Task 6: Meter text, device loss, packaging verification, and physical acceptance

**Files:**
- Modify: `js/meters.js:1-182`
- Modify: `js/app/audio-io-controller.js`
- Modify: `js/audio-engine.js`
- Modify: `js/main.js`
- Modify: `test/audio-output.mjs`
- Modify: `test/run.mjs`
- Create: `docs/CONTRACT-AUDIO-IO.md`
- Modify: `docs/SMOKE.md`

**Interfaces:**
- Consumes: shipped view/controller/router boundaries.
- Produces: throttled `{peakDb,rmsDb,clipped}` output meter snapshots, explicit output-loss pause/fail-closed behavior, and a complete static/offline deployment set.

- [ ] **Step 1: Add terminal output and packaging RED cases**

Add cases for: textual level callback at no more than 10 Hz; callback never aria-live per frame; selected device disappearance calls synchronous monitor disconnect, then pauses every registered live transport (including machine synth/modal and repair one-shots), then public `engine.handleOutputLoss()`, then asynchronously selects and verifies system default while a safety mute remains latched; controller code never reads the private router; no sound resumes until a later explicit PLAY or TEST gesture clears that latch; monitor-off loss follows the same ordering; one throwing pause callback cannot skip the others; `dispose()` leaves no analyser, route, element, stream, listener, oscillator, or timer.

Add a static resource assertion:

```js
async function audioOutputModulesArePreloadedAndPrecachedExactlyOnce() {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  for (const path of ['js/audio-output-router.js', 'js/app/audio-devices.js',
    'js/app/audio-io-preferences.js', 'js/app/audio-io-ui.js',
    'js/app/audio-io-controller.js']) {
    assert.equal(html.split(path).length - 1, 1, path + ' preload count');
    assert.equal(sw.split(path).length - 1, 1, path + ' precache count');
  }
}
```

- [ ] **Step 2: Run focused RED**

```bash
node --input-type=module -e "import('./test/audio-output.mjs').then(async m => { for (const f of m.audioOutputReleaseCases) await f(); })"
```

Expected: the meter callback and loss behavior are absent.

- [ ] **Step 3: Complete diagnostics and verify static packaging**

Extend `LevelMeter` with `onlevel = null` and emit at most every 100 ms after finite conversion:

```js
if (this.onlevel && now - this._lastLevelEmit >= 100) {
  this._lastLevelEmit = now;
  this.onlevel(Object.freeze({ peakDb, rmsDb, clipped }));
}
```

The output controller owns a dedicated post-app-gain/pre-route meter tap and
disconnects it on dispose. `main.js` composes one synchronous
`pauseLiveTransports()` over source, MACHINE, Studio, Loom, audition, and repair
preview stops. Device loss synchronously disconnects monitoring first, invokes
every stop in isolated try/catch blocks, then calls the public synchronous
`engine.handleOutputLoss('OUTPUT_LOST')`; neither controller nor
composition code reaches into the private router. It may
prepare and verify `SYSTEM DEFAULT` asynchronously, but a separate safety mute
stays latched until the next explicit PLAY or TEST gesture; fallback itself
does not make sound.
Verify that Task 5's `index.html`, `sw.js`, and generated
`docs/preload-snippet.html` entries remain exact and complete; this task does
not perform a second worker-version increment.

`docs/CONTRACT-AUDIO-IO.md` must bind the public states, route capability order, stereo bridge, app-vs-system gain boundary, rate terminology, no automatic sound/permission, fail-closed behavior, and the explicit absence of recording until the companion capture plan lands. `docs/SMOKE.md` gets the Chrome/Safari physical matrix from the approved spec.

- [ ] **Step 4: Run automated release gates**

```bash
node --check js/audio-output-router.js
node --check js/app/audio-devices.js
node --check js/app/audio-io-preferences.js
node --check js/app/audio-io-ui.js
node --check js/app/audio-io-controller.js
node --check js/audio-engine.js
node scripts/gen-preload.mjs > /tmp/yj-audio-output-preload.html
cmp /tmp/yj-audio-output-preload.html docs/preload-snippet.html
npm test
git diff --check
git status --short
```

Expected: all tests/checks pass; status contains only this task's declared files.

- [ ] **Step 5: Run the required real-device smoke**

Start an ephemeral localhost server in a PTY:

```bash
python3 -m http.server 0 --bind 127.0.0.1
```

In Chrome 151: verify default TEST before mic permission; reveal named outputs; select/test a nondefault output; change app gain/mute; rapidly request A -> B -> default; reject a route; unplug the active output; confirm a person hears only the committed route and never two devices. In Safari 26.3: verify default output, label reveal, element-bridge named output only when exposed, and truthful default-only fallback. In both: confirm `PLAYBACK CONTEXT RATE`, keyboard/VoiceOver, 200% zoom, reduced motion, and no system-volume change. Stop the server with Ctrl-C.

Expected: every `docs/SMOKE.md` output row is recorded with browser build, physical devices, observed route mechanism, and pass/fail evidence. Any failure returns to the relevant RED/GREEN step.

- [ ] **Step 6: Commit the independently shippable output slice**

```bash
git add js/meters.js js/app/audio-io-controller.js js/audio-engine.js js/main.js test/audio-output.mjs test/run.mjs docs/CONTRACT-AUDIO-IO.md docs/SMOKE.md
git commit -m "Finish reliable adjustable audio output"
```

## Plan Completion Gate

Before calling this plan complete, run:

```bash
timeout 180 npm test
git diff --check
git status --short --branch
```

Then repeat the physical Chrome/Safari smoke from Task 6 against the exact committed HEAD. Passing Node tests without heard output through the selected physical route is not completion evidence.
