# Yellowjacket — build contract, PERSIST slice

Extends `docs/CONTRACT.md` conventions (binding). Persistence owns the durable,
JSON-only project document and immutable source/sample payloads. Decoded source
buffers, hydrated playback arrays, analysis products, jobs, and browser handles
are runtime state and never enter the manifest.

## Activation boundary

**Tasks 10–11 keep the live `FORMAT_VERSION`, `serializeProject()`, and
`applySnapshot()` routes at version 2.** Task 10 installs version 3 only behind
explicitly named APIs; Task 11 does the same for archive semantics. Task 12
atomically switches all public persistence/archive routes to version 3. No Task
10 or Task 11 build may emit a partial version 3 manifest. After that switch,
version 2 is read-only and is accepted solely through `migrateV2Project()`.

## Version 3 storage layout

OPFS uses the existing `yellowjacket-v1` directory. OPFS and portable `.yjkt`
projects share this logical allowlist:

```text
project.json
sources/<64-lowercase-hex>.bin
samples/a[1-9][0-9]*.f32
```

The source suffix is the hex portion of its `sha256:<hex>` ID. Sample names use
the exact bounded grammar above, not merely a safe-looking pathname. Samples are
headerless, channel-major IEEE-754 Float32 written explicitly little-endian.
The manifest declares every allowed payload; unknown, missing, duplicate, or
unreferenced freight rejects before any live mutation.

Both raw-input boundaries size-check `project.json` before decoding or parsing:
OPFS in Task 10 and portable archives in Task 11. The maximum is exactly 16 MiB;
one byte more rejects before `JSON.parse` is called.

## Version 3 document and projection

The exact top-level keys are:

```js
{
  formatVersion: 3,
  savedAt,
  activeSourceId,                 // null iff sources is empty
  allocators: { clip, asset },    // greatest issued canonical suffix
  sources: { [sourceId]: SourceRecord },
  clips: [ClipRef],
  assets: { [assetId]: AssetRecord },
  machine,
  studio,
  loom,
  wire,
}
```

The active compatibility facade (`fileName`, `words`, `transcript`, `chain`,
repairs, and anchors) is projected exactly once into the active source document
by orchestration. It is never duplicated at the root. `snapshotDocV3()` and
`serializeProjectV3()` are pure, projection-free operations and require the
exact project, Clip Atlas, and allocator identities created together by
`createProject()`.

Source IDs are exact encoded-byte identities. Each source record and payload
must agree on ID, byte length, and SHA-256. Clip IDs are globally unique
canonical `cN` values, every clip names an existing source, and
`allocators.clip` is at least the greatest issued suffix. Allocation increments
the stored high-water before returning and never reuses an ID.

Current MACHINE references, asset keys, sample payload keys, and verified PCM
owner keys are exactly the same reachable set. Asset IDs are canonical `aN`
values and `allocators.asset` is at least the greatest issued suffix. Each
asset's checked byte length is `frames * channelCount * 4`; unsafe arithmetic,
non-finite PCM, and digest disagreement reject.

Every asset record has exact core keys: matching `id`, descriptor-valid `kind`,
UTF-8-bounded `label` and optional `role`, positive safe sample/channel rates,
nonnegative safe frames, exact payload metadata, and optional Task-9 provenance.
The exact variants are:

- `sample` and unknown descriptor-valid kinds: core keys only;
- `synth`: required `formula` of at most 8192 UTF-8 bytes;
- `modal`: at most 64 exact finite physical mode records
  `{freqHz,tauSec,amp,phase,energyFrac}`;
- `factory-drum`: bounded `factoryKitId`, `factoryVoiceId`, and `model`, positive
  `engineVersion`, uint32 `seed`, at most 64 flat finite numeric `params`,
  `oversample` in `1..64`, and optional exact metrics matching core frames/time.

Whole metadata is at most 128 KiB. Provenance is at most 32 transforms and 64
KiB. PCM-bearing fields, unknown variant keys, accessors, exotic prototypes,
cycles, typed buffers, negative zero, non-finite JSON, and unsafe products reject.
Project-bound provenance resolves the exact source, ClipRef, immutable span, and
extraction-frame rule. Bounded external provenance and offline LOOM lineage need
not name a local source.

## Explicit version 3 API

```js
export const V3_FORMAT_VERSION = 3;
export function projectHasContent(project, runtime = {}): boolean;
export function snapshotDocV3(project, runtime): object;
export function serializeProjectV3(project, runtime, options = {}): {
  json, sourceIds, sampleFiles: [{ id, bytes, byteLength, sha256 }]
};
export function validateProjectDocument(json): { ok:true } | { ok:false, issues };
export async function preflightProjectPayloads({
  json, sourcePayloads, samplePayloads
}): { document, sourcePayloads, samplePayloads, assetPcm };
export function applySnapshotV3(
  json, { project, runtime, assetPcm }
): void;
export async function migrateV2Project({
  json, sourceBytes, samplePayloads, decode
});
export class ProjectDataError extends Error { code; path; kind; id; issues; }
```

Preflight snapshots hostile JSON and payload inputs once. It rejects accessors,
proxies, non-plain/cyclic JSON, non-exact Map key sets, byte-length faults, and
digest faults; returns detached owned byte Maps; and creates genuine verified
`CanonicalPcm` owners. Fixed-ID adoption re-verifies owner private-field
intrinsics, metadata, and bytes. Async adoption rechecks exact project, MACHINE,
asset, allocator, Clip Atlas, and owner-map identities after every yield.

`applySnapshotV3()` is synchronous and version-3-only. A valid document is
already a serialize/apply fixed point: apply performs no LOOM ID remapping or
other identity-changing normalization. Before its first live mutation it checks
the exact `createProject()` ownership association, every container it will
mutate for writability, and the complete fixed-ID owner installation against
isolated canonical containers. It reconciles sources, clips, assets, allocators,
MACHINE, STUDIO, LOOM, WIRE, active facade, repairs, and fresh playback
hydrations in place. Controller-held object, array, typed-array, allocator, and
runtime Map identities survive. Any fault leaves document state, PCM owners,
playback attachments, and branding unchanged.

## Commit, history, and garbage collection

Autosave is a single-flight, payload-first queue:

1. project the active facade exactly once and build the version 3 document;
2. write and verify missing immutable source payloads;
3. write and verify missing reachable canonical sample payloads;
4. write `project.json` last;
5. only after manifest readback, collect payloads absent from that manifest.

An interrupted write may leave recoverable orphan payloads, never a committed
manifest naming absent bytes. Unknown-format manifests are not applied.

Undo/redo snapshots contain JSON plus separately retained verified PCM owners.
History ownership is bounded by both 60 snapshots and 256 MiB of history-only
PCM. Eviction removes oldest snapshots and PCM that becomes unreachable
together; it never leaves a restorable snapshot without bytes. Current owners
remain in `runtime.assetPcm`, history-only owners remain in
`runtime.historyAssetPcm`, and serialization excludes history-only owners.
Playback always receives a fresh hydration copy, so mutations to decoded source,
extraction input, or `track.sample` cannot change canonical/history bytes or hash.

## Read-only version 2 migration

Migration validates the exact legacy envelope and complete legacy sample set
before decode. For a source-backed project it copies and hashes `source.bin`,
snapshots the injected decode function before awaiting it, stage-decodes a
detached copy, and constructs one rights-unknown source. The display name is a
validated legacy filename or deterministic `source.bin`; `addedAt` is the valid
legacy `savedAt`; aliases are `[displayName]`. A source-free project is valid
only with an empty legacy clip array and never fabricates a source.

Legacy clips are reissued as `c1..cN` in serialized order with `createdAt:null`.
Only MACHINE-reachable legacy assets survive. Before pruning, migration computes
the canonical asset high-water from every valid `aN` asset key, payload key, and
track reference, including unreachable IDs. Reachable canonical `aN` IDs are
preserved. Reachable noncanonical legacy IDs are deterministically remapped in
`reachableAssetIds(machine)` order to successive `aN` IDs above that complete
high-water; MACHINE references, asset keys/record IDs, payload keys, and owner
keys all follow the remap. The final issued suffix is persisted.

Legacy host-endian PCM is rewritten as canonical little-endian bytes before
hashing. Migration performs the one deterministic MACHINE/STUDIO/LOOM/WIRE
canonicalization needed to create a v3 fixed point, including LOOM ID/lane
remapping, while preserving musical and provenance content. It never invents
provenance, invokes legacy `applySnapshot()`, aliases input, or overwrites/deletes
version 2 data. OPFS removes `source.bin` only after all new payloads and the v3
manifest have committed and read back successfully.
