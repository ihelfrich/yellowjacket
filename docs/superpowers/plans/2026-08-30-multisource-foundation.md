# Yellowjacket Multi-source Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved Phase 1 Source Pool and Clip Atlas foundation so one Yellowjacket project can retain, edit, clip, mix, resume, export, and re-import several exact audio sources without losing PCM fidelity or provenance.

**Architecture:** Keep global musical state separate from per-source bench documents. A content-addressed payload repository owns encoded sources, `SourceSession` is the sole transactional owner of the active decoded facade, MACHINE owns immutable digest-verified PCM assets, and version 3 persistence writes payloads before its manifest. Existing source-facing fields remain an in-place compatibility facade until every controller is routed through the session.

**Tech Stack:** Browser ES modules, Web Audio API, Web Crypto SHA-256, OPFS, dependency-free STORE ZIP, Web Workers, HTML/CSS, and the existing Node `node:assert/strict` harness.

**Spec:** `docs/superpowers/specs/2026-08-30-multisource-foundation-design.md`

## Global Constraints

- Work in an isolated git worktree created from `main` only after Dr. Helfrich chooses the execution mode. Do not implement on the current checkout.
- Preserve `/Users/ian/Developer/yellowjacket/CRO - Traum (Official Version) [8WQMBv2deYQ].wav` exactly as an unrelated untracked file. Never stage, rename, read, or delete it.
- Do not push, deploy, publish, or alter remote state. Local commits are allowed; each task below ends in one reviewable commit.
- Follow strict red-green-refactor. Each production change starts with a behavioral test that fails for the intended reason. Do not weaken or delete an existing assertion to obtain green.
- Keep the complete legacy harness green after every commit. Use `npm test`; there is no second unit-test runner.
- Tasks 1-11 build new contracts behind the existing single-source application. Do not route any public file/drop/demo/FIELD/URL action through `SourceSession`, expose a multi-source picker, or write a v3 manifest until Task 12 atomically activates source-qualified clips, initialization-time view refresh, exact v3 archive IO, and payload-first autosave together.
- Add focused test modules rather than continuing to enlarge the 4,000-line harness. Add each dynamic import only in the task that creates that test module; by the final state, after the existing `AudioBuffer` and `CustomEvent` shims in `test/run.mjs`, the harness imports:

  ```js
  const core = await import('./multisource-core.mjs');
  const runtime = await import('./multisource-runtime.mjs');
  const persist = await import('./multisource-persist.mjs');
  const music = await import('./multisource-music.mjs');
  const ui = await import('./multisource-ui.mjs');
  ```

  Append their named case arrays to `groups`; every case is an actual state/output assertion, not a mock-interaction assertion.
- Fault injection is allowed only at real asynchronous boundaries: decode, hashing/storage, manifest IO, workers, and view callbacks. Assert the real project, engine checkpoint, facade, event stream, and manifest state after every injected fault.
- Source IDs are always exact encoded-byte identities: `sha256:<64 lowercase hex>`. Asset digests use the same prefix. Never derive identity from filename, URL, duration, or decoded PCM.
- Do not use bitwise coercions for sizes, frames, rates, timestamps, or allocators. Validate finite safe integers before multiplication.
- Do not add an arranger, capture path, video demuxer, YouTube downloader, stem separator, drum pack, project merger, new DSP, or a quality/novelty claim in this phase.
- Preserve exact source bytes. Preserve all decoded channels and the decoded native sample rate when copying a clip. Do not normalize, resample, fold down, or encode during source switching.
- Keep source-free SYNTH and CRATE flows valid. `activeSourceId === null` if and only if `sources` is empty.
- Generate deterministic test audio; do not use the unrelated repository-root WAV. Temporary browser fixtures go under an ignored temporary directory and are removed or left untracked outside the repository.
- Update `sw.js` and bump its cache version only in the final release-gate task, after the rendered browser workflow passes.

## Target Interfaces

The tasks below converge on these public contracts. If implementation pressure reveals a mismatch, update this plan and the approved design together before changing the contract in code.

```js
// js/app/source-registry.js
export const SOURCE_ID_RE = /^sha256:[0-9a-f]{64}$/;
export const VALIDATION_LIMITS = Object.freeze({
  projectJsonBytes: 16 * 1024 * 1024,
  sources: 256,
  clips: 65536,
  aliases: 16,
  zipEntries: 1024,
  expandedBytes: 768 * 1024 * 1024,
  sourceBytes: 250 * 1024 * 1024,
});
export function createSourceDocument(chainDefaults);
export function createSourceRecord(input);
export function validateSourceRecord(record);
export function addSource(project, record);
export function addSourceAlias(project, sourceId, displayName);
export function sourceReferences(project, sourceId);
export function removeSource(project, sourceId);
export function sourceEntryName(sourceId);
export function validateSourceGraph(project);

// js/app/sample-payload.js
export class CanonicalPcm {
  static async fromVerified(meta, bytes);
  copyBytes();  // owned copy
  hydrate();    // synchronous fresh playback channels after verification
  get byteLength();
}
export function canonicalSampleBytes(sample);
export async function describeSamplePayload(sample);
export async function validateSamplePayload(meta, bytes);
export async function hydrateCanonicalPcm(meta, bytes);
export function reachableAssetIds(machine);
export function validateAssetOwnership(project, payloadIds);
export function validateAssetProvenance(project, asset);

// js/app/project-store.js
export function allocateProjectId(project, kind); // kind: 'clip' | 'asset'
export function registerPreparedAsset(project, runtime, prepared);
export function pruneUnreachableAssets(project, runtime);
export function resolveTrackSamples(project, runtime);
store.update(kind, mutate, { history: 'record' | 'none' } = {});
store.setBeforeHistorySnapshot(projectActiveFacade);
store.clearHistory(reason = 'topology');

// js/audio-engine.js
await engine.decode(arrayBuffer); // -> {buffer, mono, decodeReport}
engine.install(decoded);          // synchronous boolean, no throw
engine.captureInstalled();
engine.restoreInstalled(checkpoint); // synchronous boolean, no throw

// js/app/source-session.js
session.activeSourceId();
session.token();
session.isActive(token);
session.projectActiveFacade();
await session.prepareActivation(input);
session.commitActivation(prepared, options);
await session.add(input, { activate = true } = {});
await session.activate(sourceId);
await session.remove(sourceId);
await session.prepareProjectReplacement(input);
session.commitProjectReplacement(prepared);
```

---

### Task 1: Establish the source registry trust boundary

**Files:**

- Create: `js/app/source-registry.js`
- Create: `test/multisource-core.mjs`
- Modify: `test/run.mjs` after the environment shims and in the final `groups` array

- [ ] **Step 1: Write the failing source identity and validation cases**

  Add `sourceRegistryCases` covering:

  - `sourceEntryName('sha256:' + 'a'.repeat(64)) === 'sources/' + 'a'.repeat(64) + '.bin'`;
  - uppercase, short, traversal-like, and non-SHA IDs are rejected;
  - a valid record round-trips all `origin`, `payload`, `audio`, `rights`, and source-document fields;
  - every source-map key equals `record.id`, and the declared payload byte length is a positive safe integer within the per-source intake bound;
  - source-free is valid only for `{sources:{}, activeSourceId:null}`;
  - a non-empty pool requires a known active source;
  - two records with the same ID deterministically yield `duplicate`, not a second source;
  - a 257th distinct source returns `invalid` without changing the existing 256 records;
  - aliases are trimmed, de-duplicated in insertion order, and capped at 16; a seventeenth local alias returns `full` without mutation;
  - imported over-limit aliases; names beyond 255 code points or 1,024 UTF-8 bytes; URLs beyond 4,096 bytes; credentialed/non-HTTP URLs; MIME tokens beyond 127 lowercase ASCII bytes; extensions outside 1-16 lowercase alphanumerics; license/attribution beyond 2,048 bytes; rights notes beyond 8,192 bytes; invalid rights enum, timestamp, and safe-integer fields are invalid;
  - normalized HTTP(S) URLs discard fragments, retain path/query, contain no credentials, and equal `new URL(value).href`;
  - `sourceReferences()` reports clip IDs, project-bound asset IDs, and matching LOOM plan IDs separately;
  - `removeSource()` returns `blocked` with those IDs and otherwise returns `removed` without changing unrelated global state.

- [ ] **Step 2: Register the new group and prove it is red**

  ```bash
  npm test
  ```

  Expected: failure while importing `../js/app/source-registry.js`; no existing group should fail first.

- [ ] **Step 3: Implement the registry without browser dependencies**

  Implement the interfaces in `Target Interfaces`. Return structured outcomes rather than parsing thrown text:

  ```js
  { kind: 'added' | 'duplicate' | 'invalid', sourceId, issues? }
  { kind: 'added' | 'present' | 'full' | 'invalid', sourceId, issues? }
  { kind: 'removed' | 'blocked' | 'missing' | 'invalid', references?, issues? }
  ```

  Invalid operations must leave the supplied project byte-for-byte JSON equivalent. `createSourceDocument()` must deep-copy rack defaults and create independent `words`, `gapCuts`, `repairs`, and anchor state for every source.

- [ ] **Step 4: Run the source cases and full regression gate**

  ```bash
  npm test
  git diff --check
  ```

  Expected: every legacy group and `source registry` pass.

- [ ] **Step 5: Commit the registry boundary**

  ```bash
  git add js/app/source-registry.js test/multisource-core.mjs test/run.mjs
  git commit -m "Add multi-source registry boundary"
  ```

### Task 2: Canonicalize and verify PCM payloads

**Files:**

- Create: `js/app/sample-payload.js`
- Modify: `test/multisource-core.mjs`

- [ ] **Step 1: Add failing byte-level PCM cases**

  Add `samplePayloadCases` with hand-derived fixtures. For channels `[[0, 0.5], [-0.5, 1]]`, assert the exact channel-major bytes:

  ```text
  00 00 00 00 00 00 00 3f 00 00 00 bf 00 00 80 3f
  ```

  and the literal SHA-256:

  ```text
  sha256:6c0dbe60b9153c728a69955c92c872a2a3223587da4a5dec8e03b8cd5bf39b40
  ```

  Also assert:

  - `-0` keeps its IEEE-754 sign bit;
  - subarray inputs copy only their visible frames;
  - unequal channel lengths, zero channels, non-positive/unsafe rates, NaN, and infinities reject;
  - a same-length one-float tamper fails digest verification before hydrate;
  - `await CanonicalPcm.fromVerified()` SHA-256-verifies and then copies raw input bytes, `copyBytes()` never exposes its private storage, and separate synchronous `hydrate()` calls cannot mutate one another or the canonical payload;
  - metadata multiplication overflow rejects before allocation;
  - reachable IDs are deduplicated across all scenes/tracks;
  - exact equality among reachable IDs, metadata keys, and payload IDs passes, while each missing/orphan permutation fails.

- [ ] **Step 2: Prove the payload contract is red**

  ```bash
  npm test
  ```

  Expected: missing `sample-payload.js` import or missing exported functions.

- [ ] **Step 3: Implement canonical encoding and validation**

  Write each float through `DataView.setFloat32(offset, value, true)`; never serialize a host-endian `Float32Array.buffer` directly. `validateSamplePayload()` must check shape, exact `frames * channelCount * 4`, finite decoded floats, and SHA-256 before returning `{ok:true, sample}`. It must return `{ok:false, issue}` without exposing partially hydrated PCM. Raw-byte construction is asynchronous: `await CanonicalPcm.fromVerified()` and `await hydrateCanonicalPcm()` hash-verify before any owner exists; only `.hydrate()` on that already-verified owner is synchronous. `CanonicalPcm` encapsulates a private copied payload and returns only copies/fresh hydrations, making persisted/history PCM authoritative even if playback holders mutate their arrays.

  `validateAssetProvenance()` must enforce exact source/clip/span/extraction relationships for `binding:'project'`, accept bounded `binding:'external'`, preserve unknown bounded descriptors as `replayable:false`, and validate `linear-gain` and `spectral-repair-stack` version 1 without executing either transform. Enforce at most 32 transforms and 64 KiB of serialized transform data; linear gain must be finite, positive, and no greater than 64.

- [ ] **Step 4: Verify the literal digest and regression suite**

  ```bash
  npm test
  git diff --check
  ```

  Expected: `sample payload` passes with the literal digest; all prior groups stay green.

- [ ] **Step 5: Commit the PCM trust boundary**

  ```bash
  git add js/app/sample-payload.js test/multisource-core.mjs
  git commit -m "Add canonical PCM payload verification"
  ```

### Task 3: Move IDs and current PCM ownership into `ProjectStore`

**Files:**

- Modify: `js/app/project-store.js:1-234`
- Modify: `test/multisource-core.mjs`
- Modify: `test/run.mjs` imports that assume the old `registerAsset` behavior

- [ ] **Step 1: Add failing live-model and allocator cases**

  Add `projectStoreV3Cases` asserting that a fresh project has:

  ```js
  {
    activeSourceId: null,
    sources: {},
    allocators: { clip: 0, asset: 0 },
    clips: [],
    assets: {},
  }
  ```

  while retaining the in-place compatibility facade `fileName`, `words`, `transcript`, and `chain`. Assert that allocation increments first, refuses stale/unsafe counters, never scans down or reuses deleted suffixes, and yields `c9`/`a14` from `{clip:8,asset:13}`. Assert that two new projects do not share counters.

  Add an immutable prepared asset test: registering a described stereo sample awaits raw-byte SHA-256 verification before creating `a1`, stores only JSON metadata in `project.assets.a1`, stores a `CanonicalPcm` owner under `runtime.assetPcm.get('a1')`, and refuses any attempt to rewrite `a1` with different bytes. Mutating the input arrays, returned byte copies, hydrated playback channels, or `track.sample` cannot change a later `copyBytes()` result or digest.

- [ ] **Step 2: Run red**

  ```bash
  npm test
  ```

  Expected: the new model fields/runtime maps and allocator functions are absent.

- [ ] **Step 3: Implement project-scoped allocation and runtime maps**

  Extend `createProject()` and `ProjectStore.runtime` with the v3 fields plus:

  ```js
  assetPcm: new Map(),
  historyAssetPcm: new Map(),
  historyPcmBytes: 0,
  facadeEpoch: 0,
  ```

  Remove the module-global `assetCounter`. Keep `registerAsset(project, meta)` as a compatibility wrapper that delegates to `allocateProjectId(project, 'asset')`; new source-derived routes must use `registerPreparedAsset(project, runtime, prepared)`. `assetPcm` stores encapsulated `CanonicalPcm` owners only after asynchronous raw-byte SHA-256 verification; their private bytes are copied and exposed only through copy/hydrate methods. Implement `resolveTrackSamples()` so `track.sample` is a disposable synchronous playback hydration from an already-verified `assetPcm` owner, never the owner.

  Change `ProjectStore.update()` to accept `{history:'record'|'none'}`. A no-history update still increments revision and emits one `change`; it neither creates an undo entry nor implicitly clears redo.

- [ ] **Step 4: Run green and inspect for remaining global asset allocation**

  ```bash
  npm test
  rg -n 'assetCounter|let clipCounter' js test
  git diff --check
  ```

  Expected: `assetCounter` has no matches; `clipCounter` remains only as the explicitly temporary legacy clip seam to be removed in Task 9.

- [ ] **Step 5: Commit the v3 live skeleton**

  ```bash
  git add js/app/project-store.js test/multisource-core.mjs test/run.mjs
  git commit -m "Move project IDs and PCM into project state"
  ```

### Task 4: Make undo and redo PCM-safe and memory-bounded

**Files:**

- Modify: `js/app/project-store.js:158-234`
- Modify: `js/app/persist-controller.js` around the current history bridge
- Modify: `test/multisource-core.mjs`

- [ ] **Step 1: Write failing history ownership cases**

  Construct `ProjectStore` with test-only bounds through constructor options:

  ```js
  new ProjectStore(chainDefaults, { historyLimit: 3, historyPcmBudget: 80 })
  ```

  Assert that:

  - history entries retain the exact PCM objects for their reachable asset IDs;
  - a shared asset is counted once even when several snapshots/tracks reference it;
  - exceeding count or byte budget evicts whole oldest snapshots plus newly unreachable PCM;
  - `historytrim` fires with `UNDO HISTORY TRIMMED TO PROTECT AUDIO MEMORY`;
  - `clearHistory('topology')` releases all history-only PCM but not current PCM;
  - a registered before-history hook runs synchronously exactly once before every `{history:'record'}` snapshot and never for `{history:'none'}`, undo/redo application, or transport-only work;
  - undo/redo preserves the currently active source when it still exists, restores that source's document into the facade, and never treats source navigation as creative history;
  - undo whose target names `a7` while neither current nor history maps contain `a7` returns `false` before popping a stack or mutating project/revision;
  - valid undo resolves all track pointers from PCM maps before emitting its `history` change.

- [ ] **Step 2: Prove the old WeakMap/count-only behavior fails**

  ```bash
  npm test
  ```

  Expected: byte-budget and preflight assertions fail.

- [ ] **Step 3: Implement store-owned history entries**

  Replace document-only stack values with:

  ```js
  { document, assetIds: [...reachableAssetIds], byteLength }
  ```

  Keep ref counts for `historyAssetPcm`; trim in oldest-entry order until both bounds hold. Change the injected contract to:

  ```js
  store.attachHistory({
    takeDocument: () => snapshotDoc(...),
    applyDocument: (document, pcmById) => applySnapshot(...),
  });
  store.setBeforeHistorySnapshot(() => session.projectActiveFacade());
  ```

  `setBeforeHistorySnapshot()` stores one synchronous callback and calls it immediately before `takeDocument()` for a recorded update. Task 12 registers the real session callback before public source edits are enabled. The store gathers/resolves PCM before calling `applyDocument`. During this transition only, it may adopt a reachable legacy `track.sample` into `assetPcm`; Task 9 removes all new writes through that fallback.

- [ ] **Step 4: Delete the controller WeakMap and run green**

  Remove the history PCM `WeakMap`/capture block from `persist-controller.js` and use the new attachment contract.

  ```bash
  npm test
  rg -n 'WeakMap|historyPcm' js/app/persist-controller.js js/app/project-store.js
  git diff --check
  ```

  Expected: no controller-owned history PCM; store references are explicit and tested.

- [ ] **Step 5: Commit bounded history**

  ```bash
  git add js/app/project-store.js js/app/persist-controller.js test/multisource-core.mjs
  git commit -m "Bound undo PCM without dangling snapshots"
  ```

### Task 5: Split decoding from the engine commit point

**Files:**

- Modify: `js/audio-engine.js:10-104`
- Create: `test/multisource-runtime.mjs`
- Modify: `test/run.mjs`

- [ ] **Step 1: Add failing decode-isolation and rollback cases**

  Add `engineTransactionCases` using a fake decode context and `AudioBuffer` fixture. Capture the installed A buffer, transport position, cuts, `decodeReport`, and event list; then decode B. Assert decode returns B data but changes none of A's state and emits nothing. Assert `install(B)` is the only operation that halts, resets position/cuts, stores B, and emits one `loaded` event.

  Also assert that `captureInstalled()` followed by install B and `restoreInstalled(checkpoint)` restores the same A object references and report synchronously; malformed prepared input returns `false` without mutation or throw. Retain native-rate/offline fallback assertions already covered by the legacy suite.

- [ ] **Step 2: Run red**

  ```bash
  npm test
  ```

  Expected: `Engine.decode`, `install`, `captureInstalled`, and `restoreInstalled` are missing.

- [ ] **Step 3: Extract the existing decode path without changing its math**

  Move probe/plan/offline/native fallback and `mixdownMono()` into `decode()`. Return an immutable-by-convention object:

  ```js
  { buffer, mono, decodeReport: { nativeRate, decodedRate, downgraded, reason } }
  ```

  Implement `install()` and checkpoint/restore as short synchronous no-throw boundaries. Keep `load(arrayBuffer)` as exactly `decode()` then `install()` for legacy callers until Task 14 confirms no production source operation depends on it.

- [ ] **Step 4: Run full engine regression**

  ```bash
  npm test
  git diff --check
  ```

  Expected: native-rate and new transaction groups pass; no playback tests regress.

- [ ] **Step 5: Commit the engine seam**

  ```bash
  git add js/audio-engine.js test/multisource-runtime.mjs test/run.mjs
  git commit -m "Split audio decode from source install"
  ```

### Task 6: Add immutable source payload repositories

**Files:**

- Create: `js/app/source-payload-store.js`
- Modify: `test/multisource-runtime.mjs`

- [ ] **Step 1: Add failing memory, durable, and corruption cases**

  Add `sourcePayloadStoreCases` for:

  - `put()` recomputes the ID from bytes and rejects a mismatched caller ID;
  - first put writes one owned copy; a repeated identical put returns `{reused:true}`;
  - mutation of caller bytes or returned `get()` bytes cannot mutate stored bytes;
  - a same-path durable entry with different length or digest throws `PayloadCorruptionError`;
  - `listIds()` is sorted and contains only validated source IDs;
  - memory fallback reports `persistent === false`;
  - attaching a fake durable backend flushes and verifies memory payloads before reporting persistent;
  - after verified durable attachment, inactive payloads can be released from the memory tier and are read back from durable storage without byte drift;
  - attach/put quota failure retains the memory copy and reports session-only without falsely claiming durable save.

- [ ] **Step 2: Run red**

  ```bash
  npm test
  ```

  Expected: missing source payload store exports.

- [ ] **Step 3: Implement the adapters and repository facade**

  Export:

  ```js
  export class PayloadCorruptionError extends Error {}
  export class MemorySourcePayloadStore { /* interface methods */ }
  export class OpfsSourcePayloadStore { constructor(opfsStore) {} }
  export class SourcePayloadRepository {
    constructor(memory = new MemorySourcePayloadStore()) {}
    async attachDurable(durable) {}
    get persistent() {}
    put(sourceId, bytes) {}
    get(sourceId) {}
    has(sourceId) {}
    remove(sourceId) {}
    listIds() {}
  }
  ```

  `OpfsSourcePayloadStore` derives paths only through `sourceEntryName()` and verifies existing bytes before reuse. `SourcePayloadRepository` keeps exact imported bytes in memory only while no verified durable copy exists; after successful durable attachment it may release inactive memory copies and read them from OPFS. A durable failure never erases the sole memory copy.

- [ ] **Step 4: Run green**

  ```bash
  npm test
  git diff --check
  ```

- [ ] **Step 5: Commit payload ownership**

  ```bash
  git add js/app/source-payload-store.js test/multisource-runtime.mjs
  git commit -m "Add immutable source payload repositories"
  ```

### Task 7: Implement the prepared `SourceSession` transaction

**Files:**

- Create: `js/app/source-session.js`
- Modify: `js/app/project-store.js`
- Modify: `test/multisource-runtime.mjs`

- [ ] **Step 1: Write failing facade round-trip and activation-race cases**

  Add `sourceSessionCases` with a real `ProjectStore`, `MemorySourcePayloadStore`, fake engine, and deterministic peak builder. Cover:

  - projecting active A writes only `sources[A].document` and never Web Audio/cache fields;
  - hydrating B mutates held `words`, `gapCuts`, rack entry/params, and repairs containers in place;
  - A -> B -> edit B -> A restores both independent documents while global clips/MACHINE/STUDIO/LOOM/WIRE stay unchanged;
  - preparing B does not change A's facade, engine, project, events, revision, or manifest callback;
  - preparation checks every target ClipRef against the actual decoded buffer duration and rejects an out-of-range target without installing it;
  - after a successful switch only B remains installed/decoded, A is released, and at most one staged target coexists during preparation;
  - activation request 1 for A resolving after request 2 for B is quarantined; only B installs and emits;
  - injected failure before install, facade hydrate, registry patch, and active-ID write restores the complete checkpoint and emits no `sourceactivated`;
  - activation uses `{history:'none'}`, creates no undo entry, and preserves existing stacks;
  - `projectActiveFacade()` is exposed as a synchronous, idempotent callback suitable for the store's single before-history hook; a test registration projects exactly once for an edit snapshot, while activation never invokes that hook;
  - a decode/read/hash fault and every injected commit fault preserve the prior active ID/facade/engine and emit/schedule nothing.

- [ ] **Step 2: Prove the session API is red**

  ```bash
  npm test
  ```

  Expected: missing `source-session.js`.

- [ ] **Step 3: Implement facade projection and preparation**

  Construct with:

  ```js
  new SourceSession({
    store, engine, payloads, buildPeaks, scheduleAfterActivation,
    clock = Date.now,
    hooks: {
      afterPrepare, beforeInstall, afterInstall,
      beforeFacadeHydrate, beforeRegistryPatch, beforeActivateEvent,
    },
  });
  ```

  Hooks default to synchronous no-ops; tests may throw or defer only at the named boundary. `prepareActivation()` hashes/verifies bytes, decodes, validates target ClipRefs against that decoded buffer, clones/normalizes the source document, prebuilds peaks, and captures engine/facade/registry checkpoints without mutation.

- [ ] **Step 4: Implement synchronous commit and lifecycle operations**

  `commitActivation()` must stop transport/audition through injected callbacks, install prepared audio or the explicit empty facade, replace held containers in place, apply any prepared registry patch, set `activeSourceId` last, increment `facadeEpoch`, and emit one event. Analysis/spectrogram and manifest scheduling start only after that event. On any exception it restores every checkpoint synchronously and schedules nothing.

  Implement ordinary `activate(id)` over already-present registry/payload state. Do not register the session on the live store or construct it from `main.js` yet. Keep add, remove, and whole-project replacement orchestration internal/unreachable in this task; Task 12 completes those methods against the real v3 serializer/preflight, registers `projectActiveFacade()` as the store's before-history callback, and exposes the session only after the coupled persistence/UI refresh gate is green.

- [ ] **Step 5: Run green and inspect mutation ownership**

  ```bash
  npm test
  rg -n 'activeSourceId\s*=' js | head -n 80
  git diff --check
  ```

  Expected: only registry/session/migration preparation code writes the active ID; session tests and the full harness pass.

- [ ] **Step 6: Commit the transaction core**

  ```bash
  git add js/app/source-session.js js/app/project-store.js test/multisource-runtime.mjs
  git commit -m "Add transactional active source session"
  ```

### Task 8: Build source-scoped intake and job primitives behind the legacy UI

**Files:**

- Create: `js/app/source-intake.js`
- Modify: `workers/analysis-worker.js`
- Modify: `js/app/source-session.js` token helpers
- Modify: `test/multisource-runtime.mjs`
- Modify: `test/run.mjs` existing worker-protocol cases

- [ ] **Step 1: Add failing batch and stale-job cases**

  Add `sourceIntakeCases` and `analysisTokenCases` covering:

  - selecting `[audio, audio, audio]` processes sequentially and preserves ordered row results;
  - success, decode failure, success continues after the fault; cancellation between items commits nothing further and does not undo earlier items;
  - an audio selection mixed with `.yjkt` or MIDI rejects before any `arrayBuffer()` call;
  - the batch policy marks the first success for activation, later successes for registry-only commit, and a duplicate for alias-only handling without decode/write;
  - newline-separated HTTP(S) URLs normalize independently, retain path/query, reject credentials/non-HTTP, preserve the 250 MiB per-source cap, reject an addition whose known project payload would exceed 768 MiB, and report HTML/walled-host CORS guidance without invoking `yt-dlp`;
  - a successful URL source persists `origin.kind:'url'` plus the normalized URL, while file intake persists only the browser filename and never fabricates a local path;
  - rights default to `unknown`; demo/FIELD metadata prefills basis or attribution only when that catalog record explicitly supplies it;
  - every worker `progress`, `done` (including empty), and `error` reply echoes `{sourceId, jobId, algorithmVersion}`;
  - `session.isActive()` rejects A's late token after B activation even if job numbers collide; mismatched algorithm version/facade epoch also rejects;
  - analysis-version identifiers outside `[a-z0-9][a-z0-9._-]{0,63}` reject, while a well-formed unknown version invalidates only that cache;
  - no import of `source-intake.js` mutates DOM, reads files, starts a worker, or changes the live source controller.

- [ ] **Step 2: Run red**

  ```bash
  npm test
  ```

  Expected: the pure intake module is missing and the empty worker reply omits its complete tuple.

- [ ] **Step 3: Implement pure intake classification and sequencing**

  Export from `source-intake.js`:

  ```js
  export function classifySelection(files);
  export function normalizeDirectUrls(text);
  export async function processSourceBatch(items, { run, onResult, shouldCancel });
  ```

  The helpers return detached plans/results only. They do not import the live controller or session. Keep `.yjkt` and MIDI single-document behavior in the classifier and reject a mixed selection before reading anything. Task 12 is the first task allowed to route file picker, drop, demo, FIELD, or URL adapters through these helpers.

- [ ] **Step 4: Make the worker tuple-capable without switching live acceptance yet**

  Use:

  ```js
  { sourceId, jobId, algorithmVersion, facadeEpoch }
  ```

  as the eventual main-thread acceptance tuple. The worker request/reply contains the first three; main-thread state supplies the epoch. Make every worker reply echo supplied tuple fields, including empty/error paths. Preserve the current singular request compatibility through Task 11 so the live application still works; Task 12 removes that fallback, caches by `${sourceId}:${algorithmVersion}`, and gates analysis, spectrogram, and repair controller writes through `session.isActive()`.

- [ ] **Step 5: Run green and search for unscoped async state**

  ```bash
  npm test
  rg -n 'sourceId|jobId|algorithmVersion' js/app/source-intake.js js/app/source-session.js workers/analysis-worker.js
  git diff --check
  ```

  Expected: new primitives are source-scoped, while `source-controller.js`, `repair-controller.js`, `main.js`, existing controls, and the v2 persistence path are unchanged.

- [ ] **Step 6: Commit source-scoped intake and jobs**

  ```bash
  git add js/app/source-intake.js js/app/source-session.js workers/analysis-worker.js test/multisource-runtime.mjs test/run.mjs
  git commit -m "Add source-scoped intake and job primitives"
  ```

### Task 9: Build source-qualified clips and immutable PCM assets behind compatibility

**Files:**

- Modify: `js/machine/cliprefs.js:1-190`
- Modify: `js/app/crate.js`
- Create: `test/multisource-music.mjs`
- Modify: `test/run.mjs`

- [ ] **Step 1: Add failing global ClipRef and extraction cases**

  Add `clipIdentityCases` and `assetProvenanceCases` for:

  - allocator 7, delete `c7`, manual clip, two HARVEST clips, then boundary replacement yields `c8`, `c9`, `c10`, `c11`; no `hN` and no reuse;
  - creation without a known source rejects without incrementing;
  - source A projects `[c1,c3]` while the Atlas order remains `[c1,c2,c3]`;
  - renaming/retagging retains ID/source/span; a boundary edit creates a new ID and is blocked while a project-bound asset references the old clip;
  - at 48 kHz, two-channel clip `[1.0001,1.2501]` extracts frames `[48004,60005)`, length 12,001, with exact values from both fixture channels;
  - a 31-second 48 kHz clip caps at 1,440,000 frames while retaining source-span end 31 and recording the actual extraction end;
  - a prepared 96 kHz assignment has the same asset ID, both channels, sample rate, PCM digest, source ID, clip ID, span, and extraction frames after canonical encode/hydrate;
  - mutating the decoded source, an extraction input array, or a retained `track.sample` after assignment cannot change `runtime.assetPcm`, canonical bytes, or digest;
  - original extraction records `buffer:'original'` with no invented transform, while repaired extraction records `buffer:'repaired'` plus the exact ordered version-1 spectral repair stack that produced the persisted PCM;
  - HARVEST from peak `0.25` to `-6 dBFS` records gain near `2.004748`; transformed PCM peaks near `0.501187`; unity gain records no transform;
  - pure reachability planning identifies when clearing/replacing the final track reference must remove metadata/current PCM while retaining history bytes;
  - generated regeneration replaces only unreferenced same-source/same-generator clips;
  - CRATE retains multichannel canonical PCM and provenance; absent local source becomes `binding:'external'`; deliberate exact relink may become `project`; legacy mono CRATE entries remain readable without invented provenance.

- [ ] **Step 2: Add the music test module and run red**

  ```bash
  npm test
  ```

  Expected: source-qualified ClipRef/prepared-asset APIs and multichannel CRATE behavior are missing. Existing legacy UI tests remain green.

- [ ] **Step 3: Replace the clip model contracts**

  Export:

  ```js
  export function createClipRef(project, input);
  export function wordsToClip(project, sourceId, words, i0, i1);
  export function clipsForSource(project, sourceId);
  export function replaceClipBounds(project, oldId, nextBounds);
  export function clipReferences(project, clipId);
  export function extractClipAsset(decoded, clip, { maxSeconds = 30, transforms = [] } = {});
  ```

  Implement the new functions beside the legacy `makeClip`/`advanceClipCounter` route; do not switch SLICE, HARVEST, the current persistence controller, or public source intake yet. `extractClipAsset()` must allocate owned channel arrays and never return `subarray()` views into `AudioBuffer` storage. `registerPreparedAsset()` constructs a `CanonicalPcm` owner from verified copied bytes, stores that owner in `assetPcm`, and hydrates a separate playback sample for `track.sample`; no caller-held mutable view can alter authoritative PCM.

- [ ] **Step 4: Implement prepared provenance and multichannel CRATE without activating v3**

  Add pure preparation helpers that call `describeSamplePayload()` and produce immutable `{meta, sample, bytes}` without touching a track. Source-derived preparation records exact source provenance; generated/factory/legacy preparation preserves truthful existing lineage and never invents a source. Reprocessing always requests a new asset ID.

  Add the source-aware HARVEST planning helper that uses global `cN`, records `{kind, version, runId}`, adds `linear-gain` only when applied, and returns transformed authoritative PCM. Original/repaired extraction must set the truthful buffer selector; repaired extraction serializes the exact repair stack into ordered transform provenance. CRATE may safely switch now: store `channelCount`, frames/rate, payload digest, owned canonical channels, and an immutable provenance snapshot; its human `source` label remains display-only and legacy mono entries remain readable.

- [ ] **Step 5: Verify the inactive primitives and legacy regression**

  ```bash
  npm test
  rg -n 'subarray\(' js/machine/cliprefs.js js/app/sample-payload.js js/app/project-store.js
  rg -n 'createClipRef|extractClipAsset|describeSamplePayload|provenance' js/machine/cliprefs.js js/app/crate.js test/multisource-music.mjs
  git diff --check
  ```

  Expected: new multi-source paths own non-aliased PCM and pass exact provenance tests; the legacy single-source UI/controller and v2 writer are unchanged and remain green. Task 12 removes their compatibility routes in the same commit that activates v3 persistence.

- [ ] **Step 6: Commit provenance-exact musical objects**

  ```bash
  git add js/machine/cliprefs.js js/app/crate.js test/multisource-music.mjs test/run.mjs
  git commit -m "Add source-qualified clip and PCM primitives"
  ```

### Task 10: Project and migrate format version 3

**Files:**

- Modify: `js/app/persist.js:1-613`
- Create: `test/multisource-persist.mjs`
- Modify: `test/run.mjs`
- Modify: `docs/CONTRACT-PERSIST.md`

- [ ] **Step 1: Add failing v3 document and migration cases**

  Add `projectFormatCases` and `migrationCases`. Use three sources with decode metadata at 44,100, 48,000, and 96,000 Hz; distinct words/gap cuts/racks/repairs/anchors; 64 globally unique clips; a mixed MACHINE kit; populated STUDIO/LOOM/WIRE state; and digest-described PCM. Assert:

  - `serialize -> apply -> serialize`, excluding `savedAt`, is deep-equal;
  - `projectHasContent()` is true for any non-empty source pool, clip/asset, MACHINE/STUDIO/LOOM/WIRE content and false only for the genuinely empty source-free project;
  - the active working facade is projected once into its source document and is not duplicated at the top level;
  - `V3_FORMAT_VERSION === 3` and `applySnapshotV3()` rejects versions 2 and 4;
  - invalid active/null equivalence, duplicate clip IDs, stale allocators, over-limit counts, dangling clips, and malformed source records reject;
  - current track references, `assets` keys, and hydrated sample IDs must be exactly equal;
  - source/sample byte-length or digest mismatch rejects before `applySnapshotV3()`;
  - project-bound provenance resolves the exact clip/source/span/frame rule, while bounded external provenance and offline LOOM lineage remain valid;
  - applying a validated document mutates controller-held machine/scenes/tracks/steps, STUDIO, LOOM, WIRE, source documents, active facade, and rack parameter objects in place.

  For source-backed v2 migration, use legacy clips named `h1` and `c9` in that serialized order. Assert they become `c1` and `c2`, receive the hashed source ID, use `createdAt:null`, and set `allocators.clip = 2`. Preserve only MACHINE-reachable assets and hash canonical PCM. Preserve reachable canonical `aN` IDs; compute the full observed canonical high-water from every legacy asset key, sample-payload key, and track reference before pruning, then deterministically remap reachable noncanonical IDs in `reachableAssetIds(machine)` order above that high-water, rewriting every reference/key/owner and persisting the final greatest issued suffix. Canonicalize MACHINE/STUDIO/LOOM/WIRE once into a v3 fixed point without inventing provenance.

  For source-free v2 migration, assert `{sources:{}, activeSourceId:null}`, no fabricated source, the same reachable-asset rule, and otherwise exact musical state.

- [ ] **Step 2: Add the new dynamic import/group and run red**

  ```bash
  npm test
  ```

  Expected: the dedicated v3 projection/validation functions do not exist; the still-live v2 writer remains green.

- [ ] **Step 3: Implement explicit v3 projection and validation**

  Add these dedicated contracts without activating a v3 writer yet:

  ```js
  export const V3_FORMAT_VERSION = 3;
  export function projectHasContent(project, runtime = {});
  export function snapshotDocV3(project, runtime);
  export function serializeProjectV3(project, runtime, options = {});
  export function validateProjectDocument(json);
  export async function preflightProjectPayloads({ json, sourcePayloads, samplePayloads });
  export function applySnapshotV3(json, { project, runtime, assetPcm });
  export async function migrateV2Project({ json, sourceBytes, samplePayloads, decode });
  ```

  `serializeProjectV3()` returns `{json, sourceIds, sampleFiles}` where each sample file is `{id, bytes, byteLength, sha256}` and only current reachable assets appear. It never owns source bytes. Its caller must invoke `session.projectActiveFacade()` first. `applySnapshotV3()` is v3-only and assumes complete preflight; do not add an implicit dual-version branch. A valid v3 document is already a fixed point: validate canonical LOOM identities and every MACHINE/STUDIO/WIRE value up front, and perform no identity-changing normalization during apply.

  Add the focused fixed-ID owner seam in `project-store.js`: asynchronously adopt only genuine cryptographically verified `CanonicalPcm` owners after exact metadata/byte verification and post-await ownership rechecks; synchronously install an exact owner set without reallocating IDs, replacing the `runtime.assetPcm` Map, exposing canonical bytes to playback, or permitting partial installation. Both adoption and apply require the exact `createProject()` project/Clip Atlas/allocator association. Preflight/apply also prove that every container later mutated is writable before branding, playback, owner-map, or document mutation.

  Asset validation uses the exact bounded grammar: core matching ID/kind/label/optional role/rate/channel/frame/payload/provenance keys; core-only `sample` and unknown kinds; `synth` plus bounded formula; `modal` plus at most 64 exact physical mode records; and `factory-drum` plus bounded kit/voice/model/version/uint32 seed/flat finite params/oversample and optional exact matching metrics. Enforce 128 KiB total metadata and the existing 32-transform/64 KiB provenance bounds; reject PCM-bearing or unknown variant freight.

  Keep the currently exported v2 writer/reader and `FORMAT_VERSION = 2` unchanged for the live controller through Tasks 10 and 11. No intermediate build may write a partial v3 manifest. Task 12 atomically switches the public aliases to v3 only after archive and IO orchestration are ready, then removes the legacy write path while retaining only `migrateV2Project()` for reads.

  Validate `project.json` size before parse at the IO boundary. Replace all `|0`, `>>>0`, and unchecked multiplication in the new trust path with safe-integer guards. Retain unknown bounded forward-compatible fields only where the existing contracts explicitly permit them.

- [ ] **Step 4: Implement isolated v2 migration**

  Validate the legacy envelope before decoding. Hash `source.bin`, stage-decode it through the injected `decode`, construct a rights-unknown source record, relocate source bench fields, reissue clips in serialized order, canonicalize only reachable PCM, and return detached v3 payload maps. Preserve reachable canonical `aN` IDs, but remap reachable noncanonical IDs deterministically in reachability order above the full observed canonical high-water. Canonicalize legacy musical containers once into the native v3 fixed point. Never call legacy `applySnapshot()` as a migration shortcut and never overwrite the v2 input.

- [ ] **Step 5: Update the binding persistence contract and run green**

  Replace the v2/source.bin narrative in `docs/CONTRACT-PERSIST.md` with v3 source paths, active facade projection, monotone IDs, canonical PCM hashes, payload-first manifest order, bounded history ownership, and explicit read-only v2 migration. Note that the code activates this binding atomically in Task 12; Tasks 10-11 do not emit v3 state.

  ```bash
  npm test
  rg -n '\|0|>>>\s*0' js/app/persist.js js/app/source-registry.js js/app/sample-payload.js
  git diff --check
  ```

  Expected: any remaining bitwise operations are confined to CRC/audio algorithms, not trusted sizes or IDs.

- [ ] **Step 6: Commit the v3 document layer**

  ```bash
  git add js/app/persist.js test/multisource-persist.mjs test/run.mjs docs/CONTRACT-PERSIST.md
  git commit -m "Add version 3 project projection and migration"
  ```

### Task 11: Make portable project archives exact and allowlisted

**Files:**

- Modify: `js/app/project-bundle.js:14-283`
- Modify: `test/multisource-persist.mjs`
- Modify: `docs/CONTRACT-PROJECT.md`

- [ ] **Step 1: Add failing v3 archive-set cases**

  Add `projectBundleV3Cases` asserting:

  - a three-source/three-sample archive contains exactly `project.json`, three `sources/<digest>.bin`, and three `samples/aN.f32` entries;
  - entry ordering is deterministic: manifest, sorted sources, then numeric asset IDs;
  - v3 rejects legacy `source.bin`, `notes.txt`, an unreferenced source/sample, a missing expected entry, invalid sample grammar, and any path whose digest/ID does not match JSON;
  - v2 accepts its exact legacy `source.bin`/samples set only on the explicit migration path;
  - `project.json` over 16 MiB rejects before `JSON.parse` is called;
  - existing STORE, CRC, traversal, duplicate-name, encrypted/compressed, header-agreement, entry-count, and 768 MiB guards remain green.

- [ ] **Step 2: Run red**

  ```bash
  npm test
  ```

  Expected: current single `source.bin` mapping cannot satisfy v3 cases.

- [ ] **Step 3: Replace only the semantic mapping layer**

  Preserve generic `buildBundle()`/`readBundle()` transport code. Add the v3 semantic layer under explicit names while leaving the current v2 `projectEntries()` call intact until Task 12:

  ```js
  export function projectEntriesV3(serialized, { sourcePayloads, samplePayloads });
  export function parseProjectEntries(entries);
  export function expectedProjectEntryNames(json);
  export function assertExactProjectEntrySet(entries, expectedNames);
  ```

  `parseProjectEntries()` may identify v2 and v3 candidates, but it must validate the manifest version and exact expected set before returning payload maps. Use `sourceEntryName()` and strict `samples/a[1-9][0-9]*.f32`; no pathname is accepted merely because it looks safe. Task 12 changes the public `projectEntries()` export/callers to v3 and removes the v2 writer branch.

- [ ] **Step 4: Update the portable-project contract and run green**

  Update `docs/CONTRACT-PROJECT.md` with the v3 paths, exact allowlist, digest checks, source/clip/provenance graph, stage-decode-before-commit rule, and no-in-place v2 overwrite.

  ```bash
  npm test
  git diff --check
  ```

- [ ] **Step 5: Commit strict archives**

  ```bash
  git add js/app/project-bundle.js test/multisource-persist.mjs docs/CONTRACT-PROJECT.md
  git commit -m "Require exact multi-source project archives"
  ```

### Task 12: Commit manifests last and make restore/import transactional

**Files:**

- Create: `js/app/project-io.js`
- Create: `scripts/gen-multisource-fixtures.mjs`
- Modify: `js/app/persist-controller.js:1-520`
- Modify: `js/app/persist.js` `OpfsStore` methods
- Modify: `js/app/project-bundle.js` final public v3 aliases
- Modify: `js/app/source-payload-store.js`
- Modify: `js/app/source-session.js`
- Modify: `js/app/source-controller.js`
- Modify: `js/app/repair-controller.js`
- Modify: `js/app/bench-controller.js`
- Modify: `js/app/command-deck.js`
- Modify: `js/machine/cliprefs.js`
- Modify: `js/machine/slice-ui.js`
- Modify: `js/machine/cliplist-ui.js`
- Modify: `js/machine/controller.js`
- Modify: `js/loom/controller.js`
- Modify: `workers/analysis-worker.js`
- Modify: `js/main.js`
- Modify: `docs/CONTRACT-MACHINE.md`
- Modify: `docs/CONTRACT-HARVEST.md`
- Modify: `test/multisource-persist.mjs`
- Modify: `test/multisource-runtime.mjs`
- Modify: `test/multisource-music.mjs`
- Modify: `test/run.mjs` only if a new release-tooling group is needed for the fixture module

- [ ] **Step 1: Add failing manifest-order and prepared-import cases**

  Add `projectIoCases` with an in-memory storage adapter that logs every read/write/remove. Assert:

  - missing sources are written and read-verified before samples; samples before `project.json`;
  - an already-present immutable payload is re-verified, never blindly skipped or rewritten;
  - a source/sample write fault leaves the previous manifest and all old payloads untouched;
  - a manifest write fault after coherent live commit returns `UNSAVED`, retains the previous manifest/all possibly needed payloads, and calls garbage collection zero times;
  - retry success writes the new manifest before removing now-unreferenced payloads;
  - a newer queued revision supersedes stale save work without allowing two concurrent writers;
  - v2 OPFS migration writes and reads back the content-addressed source and v3 manifest before deleting `source.bin`;
  - malformed JSON/source/sample/path/hash/reference/provenance and active decode faults make prepared import fail with no project, facade, engine, history, event, or manifest mutation;
  - inactive sources are fully byte-length/SHA checked but not decoded; a declared active-source codec fault names that source and never substitutes another source;
  - a valid v3 or migrated-v2 package stages the declared active source, then `commitProjectReplacement()` changes the live session once and clears history;
  - a source-free package stages an explicit null facade without tearing down MACHINE/STUDIO/CRATE audio infrastructure;
  - export over the 768 MiB known expanded cap reports the exact estimate and refuses without truncation, resampling, or mutation;
  - the final public surface has `FORMAT_VERSION === 3`, `serializeProject()`/`applySnapshot()` v3-only, `projectEntries()` v3-only, and no callable v2 writer;
  - public import A then B, edit both facades, trigger an unrelated MACHINE edit, undo/redo, autosave, and portable export: both documents survive, B remains active, every history snapshot projected exactly once, and the archive is valid v3 rather than a lossy v2 fallback;
  - creating a clip immediately after first public Session import yields a known immutable `sourceId`; switching sources never creates a source-less clip;
  - every source-facing controller registers one listener during initialization; one activation refreshes Transcript, waveforms, rack/pipeline, repair, spectrogram, BEATMAP, source-filtered SLICE/list, LOOM, and command context exactly once;
  - if one view listener throws, the committed engine/project/facade remain coherent, every other listener still runs once, the fault is reported, no duplicate listener is installed, and the failed projection can be retried from committed state;
  - A's late analysis, spectrogram, repair rebuild, and repair preview cannot write after B activates;
  - duplicate add avoids decode/write; decode/quota/commit faults leave no live record; batch activation policy makes only the first success active;
  - every successful source add, removal, and whole-project replacement clears both undo and redo only after its topology commit; failed preparation or commit preserves both stacks;
  - referenced removal blocks with real counts; active removal uses production v3 `prepareNextManifest`, deterministic successor decode, and rollback; manifest-write failure leaves coherent `UNSAVED` state and defers GC;
  - every production MACHINE asset route owns canonical non-aliased PCM; mutating decoded source, extraction inputs, or `track.sample` cannot change its bytes/digest.
  - importing the fixture generator has zero IO side effects, while its pure plan and guarded CLI deterministically produce at least eight mono/stereo 44.1/48/96 kHz WAVs plus expected encoded hashes.

- [ ] **Step 2: Run red**

  ```bash
  npm test
  ```

  Expected: no manifest coordinator exists and current restore mutates via `loadArrayBuffer()` before applying its snapshot.

- [ ] **Step 3: Implement testable IO orchestration**

  Export from `js/app/project-io.js`:

  ```js
  export async function commitManifest({
    serialized, sourcePayloads, storage, collectGarbage,
  });
  export async function prepareProjectPackage({
    archiveBytes, decode,
  });
  export async function prepareStoredProject({
    storage, decode,
  });
  ```

  Both prepare functions must return detached `{document, sourcePayloads, assetPcm, decodedActive, migratedFrom}` only after exact preflight. They may not receive the live store or engine. `commitManifest()` writes/verifies immutable payloads, writes `project.json` last, and invokes `collectGarbage` only after successful manifest readback.

- [ ] **Step 4: Atomically activate v3 persistence and public source sessions**

  In the same implementation step, complete `SourceSession.add()`, `remove()`, `prepareProjectReplacement()`, and `commitProjectReplacement()` against the production v3 preflight, then construct exactly one session/repository in `main.js`. Register the store before-history hook and every source-facing controller listener before exposing existing file/drop/demo/FIELD/URL controls. Route those controls through `source-intake.js` and the session; keep `.yjkt`/MIDI single-document preflight. Add the session/repository to the existing `window.__yj` diagnostic handle for the immediate browser smoke. Do not expose the multi-picker/Source Pool visual until Task 13, but repeated existing additions must already be durably safe.

  Convert SLICE/clip-list/HARVEST and every MACHINE asset route to the Task-9 source-qualified/prepared APIs in this same step. Remove module-global/per-run clip IDs, assign `sourceId` on creation, filter active SLICE clips, reconcile restored allocators, own copied PCM, and retain exact provenance. Persistence/history read canonical asset bytes only through `CanonicalPcm.copyBytes()`, never from mutable `track.sample`. Gate analysis, spectrogram, repair rebuild/preview, and view writes with the complete source/job/version/epoch tuple; remove the singular worker fallback.

  Activate the binding MACHINE/HARVEST contract changes now: immutable project-global ClipRefs, reachability-owned canonical assets, multichannel extraction, generator replacement guards, ordered transform records, and CRATE external/project semantics.

  Implement `scripts/gen-multisource-fixtures.mjs` with named pure `planFixtures()`/`encodeFixture()` exports plus `main(argv)`, guarded by an explicit ESM `isMain` check. The default plan yields eight short, seeded/deterministic WAVs spanning the required rates/channels and a JSON expected-hash manifest; importing it performs no reads, writes, logging, or exit.

  `persist-controller.js` must:

  - atomically switch the public persistence aliases from the retained v2 compatibility writer to the tested v3 functions, then delete the v2 writer while keeping the explicit v2 migrator;
  - switch `projectEntries()` to the tested v3 implementation and retain legacy `source.bin` parsing only inside migration;
  - attach `OpfsSourcePayloadStore` to the shared repository after `OpfsStore.open()`;
  - project the active facade before snapshot/save/export;
  - expose `SAVED`, `UNSAVED`, and `SESSION ONLY` honestly;
  - prepare and stage-decode the whole package before the existing replacement confirmation;
  - pass the prepared package to the session's replacement commit;
  - clear history only after confirmed import/resume commits;
  - export exact payload maps without changing live state;
  - never call destructive `ctx.api.loadArrayBuffer()` or `clearSource()` during preflight;
  - leave old `source.bin` and payload garbage until a v3 manifest has committed and read back.

  The first production removal test must call the real v3 serializer/graph preflight, not an injected success stub. A failure before live commit leaves the old project/engine/manifest untouched; a manifest failure after live commit leaves `UNSAVED` and retries before GC.

- [ ] **Step 5: Prove the old unsafe paths are gone and run green**

  ```bash
  npm test
  rg -n 'bytesGeneration|samplesWritten|source\.bin' js/app/persist-controller.js js/app/project-io.js
  rg -n 'clipCounter|advanceClipCounter|\bh[0-9]|makeClip\(' js test
  rg -n 'files\[0\]|engine\.load\(|P\.clips\.length\s*=\s*0|machineReset\(' js/app/source-controller.js js/machine js/main.js
  rg -n 'runtime\.generation|R\.generation' js/app/source-controller.js js/app/repair-controller.js workers/analysis-worker.js
  git diff --check
  ```

  Expected: `source.bin` appears only in explicit v2 migration; global clip IDs, destructive public source switches, unscoped job acceptance, generation/sample-write caches, and partial-v2 multi-source saves are gone.

- [ ] **Step 6: Browser-smoke the atomic activation before committing**

  Generate two or more deterministic fixtures into a `mktemp -d` directory with `scripts/gen-multisource-fixtures.mjs`. Start `python3 -m http.server 0 --bind 127.0.0.1` in a PTY, read the assigned port from its startup line, probe that exact origin, and open it in the in-app browser. Through the existing single-file/drop controls: add A, carve a clip and edit its bench; add B, carve/edit B; switch A/B through `window.__yj`; trigger a MACHINE edit plus undo/redo; wait for autosave; export and parse the archive. Verify every source-facing view refreshes, each clip has the correct source, and the archive contains both sources/documents as valid v3. Stop the PTY server with Ctrl-C after the smoke. A failure returns to the relevant red-green step; do not commit or defer it to Task 15.

- [ ] **Step 7: Commit atomic durable activation**

  ```bash
  git add js/app/project-io.js scripts/gen-multisource-fixtures.mjs js/app/persist-controller.js js/app/persist.js js/app/project-bundle.js js/app/source-payload-store.js js/app/source-session.js js/app/source-controller.js js/app/repair-controller.js js/app/bench-controller.js js/app/command-deck.js js/machine/cliprefs.js js/machine/slice-ui.js js/machine/cliplist-ui.js js/machine/controller.js js/loom/controller.js workers/analysis-worker.js js/main.js docs/CONTRACT-MACHINE.md docs/CONTRACT-HARVEST.md test/multisource-persist.mjs test/multisource-runtime.mjs test/multisource-music.mjs test/run.mjs
  git commit -m "Activate durable multi-source sessions"
  ```

### Task 13: Add the Source Pool and Clip Atlas surfaces

**Files:**

- Create: `js/app/source-pool-ui.js`
- Create: `js/machine/clip-atlas-ui.js`
- Create: `test/multisource-ui.mjs`
- Modify: `test/run.mjs`
- Modify: `index.html`
- Modify: `css/yj.css`
- Modify: `js/main.js`
- Modify: `js/app/source-controller.js`
- Modify: `js/machine/controller.js`

- [ ] **Step 1: Add failing pure projection cases**

  Add `sourcePoolProjectionCases` and `clipAtlasProjectionCases` asserting:

  - Source Pool rows sort by `(addedAt, sourceId)`, expose active/name/duration/channels/rate/short digest/rights/status, and distinguish `HASHING`, `DECODING`, `READY`, `SAVED`, `SESSION ONLY`, `DUPLICATE`, CORS, quota, corruption, and decode faults;
  - renaming changes only `displayName` (and the active `fileName` facade projection), while alias order, source ID, origin, payload, documents, clips, and assets remain unchanged;
  - no row reaches `READY` until hashing, successful decode, payload-store completion, and coherent live registry commit have all occurred;
  - eight batch items retain individual status plus `5 ADDED · 1 DUPLICATE · 2 FAILED`-style summary;
  - Atlas source/tag-role/text filters compose and do not mutate clips;
  - selected `c2` remains selected when filtering hides it; no visible row is selected in its place;
  - 65,536 clips return an exact `total` but at most 200 visible rows per page/window;
  - source name, label, duration, and source time are derived without changing immutable identity;
  - offline/fault clips remain visible and actionable state is explicit.

- [ ] **Step 2: Add the UI test module and run red**

  ```bash
  npm test
  ```

  Expected: missing projection/view modules.

- [ ] **Step 3: Implement rendering-only views and intent events**

  Export:

  ```js
  export function sourcePoolRows(project, statusById, batchState);
  export class SourcePoolView extends EventTarget {
    setState(state) {}
  }
  export function filterClipAtlas(clips, sources, filters, page);
  export class ClipAtlasView extends EventTarget {
    setState(state) {}
  }
  ```

  Views own local filter/selection/render state but import no store, engine, OPFS, or session. Emit exactly:

  ```text
  sourceaddfiles sourceaddurls sourceactivate sourcerename sourcerights sourceremove
  atlasselect atlasopen atlasaudition atlasassign atlasrename atlasretag atlasdelete
  ```

  The controller validates/executes each intent and supplies a fresh projection.

- [ ] **Step 4: Add accessible navigation and restrained styling**

  In `index.html`, add a persistent `SOURCE POOL` main tab/panel with `sourcePoolHost`, set the audio file input to `multiple`, expose `ADD FILES` plus a one-URL-per-line `ADD URLS` control, and add `ATLAS` as a MACHINE substate with `clipAtlasHost`. Keep SLICE's existing rail labeled `ACTIVE SOURCE CLIPS`. Add semantic buttons, labels, focus states, row status text, rights controls, filters, and paged/windowed clip results; do not render tens of thousands of hidden DOM rows.

  In `main.js`, reuse the single shared payload repository and `SourceSession` activated in Task 12, add both views to `VIEW_SPECS`, and wire their controllers once. Retain them in the existing `window.__yj` diagnostic handle so rendered QA can inspect identity/state and substitute a faulting storage boundary without adding production-only test flags. Ordinary additions do not show replacement confirmation. Cross-source Atlas open/audition must `await session.activate(clip.sourceId)` before navigating/playing; failure keeps selection and marks the row faulty.

- [ ] **Step 5: Run Node and static composition checks**

  ```bash
  npm test
  node scripts/gen-preload.mjs > /tmp/yj-preload-snippet.html
  rg -n 'source-pool-ui|clip-atlas-ui|source-session|source-payload-store|sample-payload|source-registry' /tmp/yj-preload-snippet.html
  git diff --check
  ```

  Expected: pure UI groups pass and all new static imports appear in the generated preload graph. Do not edit `sw.js` yet.

- [ ] **Step 6: Commit the two navigation surfaces**

  ```bash
  git add js/app/source-pool-ui.js js/machine/clip-atlas-ui.js test/multisource-ui.mjs test/run.mjs index.html css/yj.css js/main.js js/app/source-controller.js js/machine/controller.js
  git commit -m "Add Source Pool and Clip Atlas"
  ```

### Task 14: Remove the final singular-source escape hatches and document the boundary

**Files:**

- Modify: `js/app/bench-controller.js`
- Modify: `js/app/repair-controller.js`
- Modify: `js/app/source-controller.js`
- Modify: `js/app/command-deck.js`
- Modify: `js/loom/controller.js`
- Modify: `js/machine/controller.js`
- Modify: `js/main.js`
- Modify: `README.md`
- Modify: `docs/SMOKE.md`
- Modify: `test/multisource-runtime.mjs`

- [ ] **Step 1: Add failing escape-hatch and entry-point cases**

  Extend runtime cases/static contract checks to reject any remaining production source-navigation write through `runtime.sourceBytes`, `runtime.sourceHash`, `engine.load()`, global clip clearing, or `machineReset()`. Keep the Task-12 one-event refresh assertions as regression coverage, including an injected view callback fault that must not roll back coherent audio/project state.

  Assert source switch does not call `benchReset`, `machineReset`, clear global clips, clear LOOM plans, alter MACHINE/STUDIO/WIRE, or create history. Import/removal still clear history at their explicit topology boundary. Assert command context names the active source or an honest source-free instrument state.

  Assert each activation reports the actual decoded rate/channel state and preserves the existing native-rate downgrade reason; the UI must never imply a higher-fidelity decode than the engine report establishes.

- [ ] **Step 2: Run red**

  ```bash
  npm test
  ```

  Expected: at least the deliberately retained compatibility fields/wrappers are still reachable from production and fail the new escape-hatch assertion.

- [ ] **Step 3: Consolidate facade consumers around the already-live session**

  Audit the initialization-time listeners registered in Task 12 and ensure no activation adds another. New source-aware work receives a source ID or calls `session.activeSourceId()`. Keep only documented top-level facade reads needed by stable legacy views; all writes project/hydrate through the session.

  Replace LOOM/current-source identity reads with the active source ID. Keep existing offline LOOM semantics. Adapt demo, FIELD, single file, direct URL, MIDI, `.yjkt`, SYNTH, and CRATE entry points to their new APIs without changing their established user-facing purpose.

- [ ] **Step 4: Remove obsolete singular storage and destructive switches**

  Remove production reliance on `runtime.sourceBytes`, `runtime.sourceHash`, destructive `engine.load()` calls, direct `P.clips.length = 0` during source navigation, and source-switch `machineReset()`. The `Engine.load()` compatibility wrapper may remain for isolated legacy tests but no production source operation may call it.

  Update README and `docs/SMOKE.md` to describe multi-file/direct-CORS import, lawful local-rip guidance, exact source retention, Source Pool/Atlas/MACHINE workflow, session-only mode, and the explicit absence of YouTube downloading or unsupported DSP claims.

- [ ] **Step 5: Audit the escape hatches and run green**

  ```bash
  npm test
  rg -n 'sourceBytes|sourceHash|engine\.load\(|P\.clips\.length\s*=\s*0|machineReset\(' js
  rg -n 'activeSourceId|sourceactivated' js/app js/machine js/loom | head -n 240
  git diff --check
  ```

  Expected: first search has no production source-navigation matches; remaining compatibility occurrences are documented migration/test seams.

- [ ] **Step 6: Commit full facade integration**

  ```bash
  git add js/app/bench-controller.js js/app/repair-controller.js js/app/source-controller.js js/app/command-deck.js js/loom/controller.js js/machine/controller.js js/main.js README.md docs/SMOKE.md test/multisource-runtime.mjs
  git commit -m "Route the bench through active source sessions"
  ```

### Task 15: Prove the real workflow, then cut the offline cache release

**Files:**

- Modify: `scripts/gen-multisource-fixtures.mjs` only if acceptance exposes a fixture gap
- Create: `scripts/audit-yjkt.mjs`
- Create: `docs/verification/2026-08-30-multisource-foundation.md`
- Modify: `docs/preload-snippet.html`
- Modify: `index.html` modulepreloads
- Modify: `sw.js`
- Modify: `test/run.mjs` service-worker/preload assertions

- [ ] **Step 1: Add failing archive-auditor and release-tooling cases**

  Extend `test/run.mjs` with a `release tooling` group that imports the already-tested named pure fixture helpers from Task 12 and the new auditor helpers. Reassert that importing either module reads no CLI arguments, writes no file, prints nothing, and never exits. Retain the Task-12 fixture-plan assertions for eight distinguishable mono/stereo fixtures spanning 44.1/48/96 kHz and deterministic expected hashes. Build a small valid v3 archive in memory and assert the auditor recomputes every source/sample digest/byte length and returns deterministic `{formatVersion, activeSourceId, sources, clips, assets, hashes, byteLengths}` without mutating input bytes. Add tampered-source and tampered-sample rejection cases.

  ```bash
  npm test
  ```

  Expected: failure because `scripts/audit-yjkt.mjs` is missing; the Task-12 fixture generator remains green and no service-worker assertion changes yet.

- [ ] **Step 2: Implement read-only archive auditing and exercise deterministic fixtures**

  Use the Task-12 `scripts/gen-multisource-fixtures.mjs --out <directory>` CLI unchanged unless the acceptance cases reveal a concrete fixture gap; if one appears, first add its failing pure-function case and preserve the existing seeded byte-for-byte outputs. Implement `scripts/audit-yjkt.mjs <archive>` through the production parser/preflight. It exports named pure functions plus `main(argv)` and uses an explicit ESM `isMain` guard, so module import has zero IO side effects. It recomputes every source/sample digest and byte length, prints the deterministic JSON summary above, never trusts names as identity, and never mutates an archive.

  ```bash
  fixture_dir="$(mktemp -d /tmp/yj-multisource.XXXXXX)"
  node scripts/gen-multisource-fixtures.mjs --out "$fixture_dir"
  find "$fixture_dir" -maxdepth 1 -type f -print | sort
  ```

  Expected: eight audio files plus one expected-values manifest; nothing under the repository root is touched.

- [ ] **Step 3: Run the now-green automated gate before browser work**

  ```bash
  npm test
  git diff --check
  git status --short
  ```

  Expected: all old and new groups pass. Only intended implementation/docs changes and the pre-existing unrelated WAV appear.

- [ ] **Step 4: Drive the rendered application on a fresh local origin**

  Start the static app in a PTY with an OS-assigned free port, read the exact port from the startup line, probe it, record the origin, and then inspect it with the in-app browser. Do not deploy. The PTY keeps the server non-blocking and gives one scoped process to stop with Ctrl-C after QA.

  ```bash
  python3 -m http.server 0 --bind 127.0.0.1
  ```

  Use the existing `window.__yj` diagnostic handle to inspect hashes/tokens and substitute faulting decode/storage boundaries where a real quota/corrupt codec cannot be induced safely; restore the real dependency after each case. Drive and record all ten approved browser workflows:

  1. batch the eight fixtures and verify per-row outcomes/rates/channels/hashes;
  2. edit distinct transcript, gap cuts, rack, repairs, and anchors on A/B/C and switch repeatedly;
  3. carve/search/filter/audition at least 64 clips, including inactive-source audition;
  4. assign clips from three sources to one MACHINE kit and record PCM hashes before/after switches;
  5. reload/RESUME, export `.yjkt`, audit it, re-import it, and compare source/sample hashes plus MACHINE/STUDIO/LOOM/WIRE/provenance;
  6. inject a middle-item decode failure and verify earlier/later success isolation;
  7. race two activations and a late analysis reply and verify only the final source renders;
  8. inject quota/write failure and verify no ghost manifest source;
  9. test referenced removal, unreferenced manifest-fault/retry/GC order, corrupt-successor abort, and true final-source removal;
  10. disable OPFS, verify `SESSION ONLY`, continue multi-source work, and export while the tab owns payloads.

  Also rerun source-free SYNTH/CRATE, demo, FIELD, direct URL, MIDI, and invalid-project regression journeys. Inspect the rendered Source Pool/Atlas, browser console, audible MACHINE playback, and exported bytes; unit tests alone are not acceptance.

  After deterministic fixtures pass, perform the creative proof with at least three lawfully controlled or catalog-attributed nature recordings: annotate rights, carve distinct elements, assign a cross-source MACHINE kit, program and audition a coherent groove, switch away and back, and confirm the kit remains sample-identical. This proves a real sampling workflow; it is not a claim that Phase 1 already contains the later arranger or a chart-ready song pipeline.

- [ ] **Step 5: Write evidence before changing the service worker**

  In `docs/verification/2026-08-30-multisource-foundation.md`, record the commit, browser/version, fixture manifest, actual source and asset hashes, test command/output summary, each workflow result, any injected fault, screenshots or artifact paths, and a clear pass/fail for every definition-of-done item. Do not mark a workflow passed without observed evidence.

- [ ] **Step 6: Add the failing cache-release assertions, then cut one cache version**

  Only after Step 4 passes, extend the existing service-worker/conform group so it requires every new production module in the generated preload graph and `PRECACHE`, and requires the cache version to be greater than `yj-v45`. Add a check over shipped UI copy (`index.html`, `README.md`, and user-visible JS strings) that no Phase 1 surface executes `yt-dlp` or claims capture, stems, arranger, “higher quality,” or “novel” without benchmark context. The existing lawful local-rip guidance/link remains allowed.

  ```bash
  npm test
  ```

  Expected: release-integrity cases fail on missing precache entries and `yj-v45`.

  Then use `scripts/gen-preload.mjs` to derive the exact module list, update `docs/preload-snippet.html` and the `index.html` preload block, add every new runtime module to `sw.js` `PRECACHE`, and bump `VERSION` once from `yj-v45` to `yj-v46`. If browser acceptance fails, leave the cache version unchanged and fix through a new red-green cycle first.

- [ ] **Step 7: Run the final automated and offline checks**

  ```bash
  npm test
  node scripts/gen-preload.mjs > /tmp/yj-preload-final.html
  diff -u docs/preload-snippet.html /tmp/yj-preload-final.html
  git diff --check
  git status --short --branch
  ```

  Reopen the app on another fresh port, verify install/offline reload with `yj-v46`, and inspect Source Pool, Atlas, active bench, MACHINE playback, and RESUME once more. If the generated preload snippet differs, update the checked-in snippet/index consistently and repeat the gate.

- [ ] **Step 8: Commit the verified release gate**

  ```bash
  git add scripts/gen-multisource-fixtures.mjs scripts/audit-yjkt.mjs docs/verification/2026-08-30-multisource-foundation.md docs/preload-snippet.html index.html sw.js test/run.mjs
  git commit -m "Verify and cache the multi-source foundation"
  ```

- [ ] **Step 9: Produce the implementation handoff without pushing**

  ```bash
  git log --oneline --decorate -n 20
  git status --short --branch
  ```

  Report exact automated counts, rendered workflow evidence, source/sample hash preservation, any remaining known limitation, commits created, and the absence of push/deploy. The work is complete only if the definition of done in the approved spec is fully evidenced.

## Execution Handoff

After this plan is committed, choose one execution mode:

1. **Subagent-Driven (recommended):** create an isolated worktree, then use `superpowers:subagent-driven-development` task by task with specification and quality reviews between commits.
2. **Inline Execution:** create an isolated worktree, then use `superpowers:executing-plans` in this task with the same red-green and verification checkpoints.

Selecting either option authorizes creation of the isolated Yellowjacket feature worktree. It does not authorize push, deployment, publication, or touching the unrelated WAV.
