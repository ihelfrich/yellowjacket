import assert from 'node:assert/strict';

import {
  SOURCE_ID_RE,
  VALIDATION_LIMITS,
  addSource,
  addSourceAlias,
  createSourceDocument,
  createSourceRecord,
  removeSource,
  sourceEntryName,
  sourceReferences,
  validateSourceGraph,
  validateSourceRecord,
} from '../js/app/source-registry.js';
import {
  CanonicalPcm,
  canonicalSampleBytes,
  describeSamplePayload,
  hydrateCanonicalPcm,
  reachableAssetIds,
  validateAssetOwnership,
  validateAssetProvenance,
  validateSamplePayload,
} from '../js/app/sample-payload.js';
import {
  ProjectStore,
  allocateProjectId,
  createProject,
  hasCanonicalProjectState,
  registerAsset,
  registerPreparedAsset,
  resolveTrackSamples,
} from '../js/app/project-store.js';
import { applySnapshot, snapshotDoc } from '../js/app/persist.js';

const sourceId = (digit = 'a') => 'sha256:' + digit.repeat(64);

function documentDefaults() {
  return [{ id: 'gate', on: false, params: { threshold: -18 } }];
}

function sourceInput(id = sourceId(), overrides = {}) {
  return {
    id,
    displayName: 'dawn-marsh.wav',
    aliases: ['dawn-marsh.wav'],
    addedAt: 1788134400000,
    origin: { kind: 'file', url: null },
    payload: { byteLength: 18432000, mediaType: 'audio/wav', extension: 'wav' },
    audio: { sampleRate: 96000, channelCount: 2, frames: 28800000 },
    rights: {
      basis: 'original-recording', license: null, attribution: null, notes: null,
    },
    document: {
      words: [{ start: 0, end: 0.2, text: 'dawn' }],
      transcript: { gapCuts: [{ start: 0.2, end: 0.3 }] },
      chain: documentDefaults(),
      repairs: [{ id: 'repair-1' }],
      anchors: { bpm: 120, barOneTime: 0 },
    },
    ...overrides,
  };
}

function validRecord(id = sourceId(), overrides = {}) {
  const record = createSourceRecord(sourceInput(id, overrides));
  assert.ok(record, 'fixture must produce a valid source record');
  return record;
}

function emptyProject() {
  return { sources: {}, activeSourceId: null };
}

function graphIsInvalid(project, label) {
  assert.equal(validateSourceGraph(project).ok, false, label);
}

export const sourceRegistryCases = [
  function derivesPayloadPathsOnlyFromCanonicalSourceIds() {
    const digest = 'a'.repeat(64);
    assert.equal(sourceEntryName('sha256:' + digest), 'sources/' + digest + '.bin');
    for (const invalid of [
      'sha256:' + digest.toUpperCase(),
      'sha256:' + 'a'.repeat(63),
      'sha256:../' + 'a'.repeat(61),
      'md5:' + digest,
      'source.wav',
    ]) {
      assert.equal(SOURCE_ID_RE.test(invalid), false, invalid + ' is not a source ID');
      assert.equal(sourceEntryName(invalid), null, invalid + ' has no payload path');
    }
  },

  function createsIndependentSourceDocumentsFromRackDefaults() {
    const defaults = documentDefaults();
    const a = createSourceDocument(defaults);
    const b = createSourceDocument(defaults);
    a.chain[0].params.threshold = -6;
    a.words = [];
    a.transcript.gapCuts.push({ start: 1, end: 2 });
    a.repairs.push({ id: 'a' });
    a.anchors.bpm = 90;
    assert.equal(defaults[0].params.threshold, -18, 'source document never mutates rack defaults');
    assert.equal(b.chain[0].params.threshold, -18, 'rack entries are not shared between sources');
    assert.equal(b.words, null, 'word state is independent');
    assert.deepEqual(b.transcript.gapCuts, [], 'gap cuts are independent');
    assert.deepEqual(b.repairs, [], 'repairs are independent');
    assert.deepEqual(b.anchors, { bpm: null, barOneTime: null }, 'anchors are independent');
  },

  function normalizesAndRoundTripsTheCompleteSourceRecord() {
    const input = sourceInput();
    const record = createSourceRecord(input);
    assert.deepEqual(record, input, 'all provenance and source-document fields survive validation');
    assert.equal(validateSourceRecord(record).ok, true, 'the resulting record is valid');
    input.document.chain[0].params.threshold = 0;
    assert.equal(record.document.chain[0].params.threshold, -18, 'record owns its document');
  },

  function validatesRegistryIdentityPayloadAndActiveSourceInvariants() {
    const id = sourceId();
    const record = validRecord(id);
    assert.equal(validateSourceGraph(emptyProject()).ok, true, 'the only valid source-free graph is empty');
    graphIsInvalid({ sources: {}, activeSourceId: id }, 'empty source pool cannot have an active ID');
    graphIsInvalid({ sources: { [id]: record }, activeSourceId: null },
      'non-empty source pool must name an active source');
    graphIsInvalid({ sources: { ['sha256:' + 'b'.repeat(64)]: record }, activeSourceId: id },
      'source map key must equal its record ID');
    graphIsInvalid({
      sources: { [id]: { ...record, payload: { ...record.payload, byteLength: 0 } } }, activeSourceId: id,
    }, 'payload byte length must be positive');
    graphIsInvalid({
      sources: { [id]: { ...record, payload: { ...record.payload, byteLength: Number.MAX_SAFE_INTEGER + 1 } } },
      activeSourceId: id,
    }, 'payload byte length must be safe and within the per-source limit');
  },

  function addsOnceAndDeterministicallyDeduplicatesByDigest() {
    const project = emptyProject();
    const record = validRecord();
    assert.deepEqual(addSource(project, record), { kind: 'added', sourceId: record.id });
    assert.equal(project.activeSourceId, record.id, 'the first source becomes active');
    assert.deepEqual(addSource(project, validRecord(record.id)), {
      kind: 'duplicate', sourceId: record.id,
    });
    assert.deepEqual(Object.keys(project.sources), [record.id], 'duplicate never creates a second record');
  },

  function refusesThe257thSourceWithoutMutatingThePool() {
    const project = emptyProject();
    for (let i = 0; i < VALIDATION_LIMITS.sources; i++) {
      const id = 'sha256:' + i.toString(16).padStart(64, '0');
      assert.equal(addSource(project, validRecord(id)).kind, 'added');
    }
    const before = JSON.stringify(project);
    const overflow = validRecord('sha256:' + 'f'.repeat(64));
    assert.equal(addSource(project, overflow).kind, 'invalid');
    assert.equal(JSON.stringify(project), before, 'overflow cannot alter the existing pool');
  },

  function managesAliasesInStableBoundedOrderWithoutPartialMutation() {
    const project = emptyProject();
    const record = validRecord(sourceId('b'), { aliases: [] });
    addSource(project, record);
    assert.deepEqual(addSourceAlias(project, record.id, '  one.wav  '), {
      kind: 'added', sourceId: record.id,
    });
    assert.deepEqual(addSourceAlias(project, record.id, 'one.wav'), {
      kind: 'present', sourceId: record.id,
    });
    for (let i = 2; i <= VALIDATION_LIMITS.aliases; i++) {
      assert.equal(addSourceAlias(project, record.id, `a${i}.wav`).kind, 'added');
    }
    const before = JSON.stringify(project);
    assert.deepEqual(addSourceAlias(project, record.id, 'seventeenth.wav'), {
      kind: 'full', sourceId: record.id,
    });
    assert.equal(JSON.stringify(project), before, 'a full alias list is unchanged');
    assert.deepEqual(project.sources[record.id].aliases.slice(0, 2), ['one.wav', 'a2.wav']);
  },

  function rejectsImportedRecordsOutsideTheTrustBoundary() {
    const id = sourceId('c');
    const invalidInputs = [
      ['too many imported aliases', { aliases: Array.from({ length: 17 }, (_, i) => `a${i}`) }],
      ['too many duplicate imported aliases', { aliases: Array.from({ length: 17 }, () => 'same') }],
      ['name longer than 255 code points', { displayName: 'a'.repeat(256) }],
      ['name longer than 1024 UTF-8 bytes', { displayName: 'a'.repeat(1025) }],
      ['overlong origin URL', { origin: { kind: 'url', url: 'https://example.test/' + 'a'.repeat(5000) } }],
      ['credentialed origin URL', { origin: { kind: 'url', url: 'https://user:pass@example.test/a' } }],
      ['non-http origin URL', { origin: { kind: 'url', url: 'ftp://example.test/a' } }],
      ['overlong MIME token', { payload: { byteLength: 1, mediaType: 'audio/' + 'a'.repeat(122), extension: 'wav' } }],
      ['invalid extension token', { payload: { byteLength: 1, mediaType: null, extension: 'wav!' } }],
      ['overlong extension token', { payload: { byteLength: 1, mediaType: null, extension: 'a'.repeat(17) } }],
      ['overlong license', { rights: { basis: 'licensed', license: 'a'.repeat(2049), attribution: null, notes: null } }],
      ['overlong attribution', { rights: { basis: 'licensed', license: null, attribution: 'a'.repeat(2049), notes: null } }],
      ['overlong rights notes', { rights: { basis: 'licensed', license: null, attribution: null, notes: 'a'.repeat(8193) } }],
      ['invalid rights basis', { rights: { basis: 'claimed', license: null, attribution: null, notes: null } }],
      ['invalid timestamp', { addedAt: 8.64e15 + 1 }],
      ['unsafe audio integer', { audio: { sampleRate: Number.MAX_SAFE_INTEGER + 1, channelCount: 2, frames: 1 } }],
    ];
    for (const [label, overrides] of invalidInputs) {
      const raw = sourceInput(id, overrides);
      assert.equal(validateSourceRecord(raw).ok, false, label);
      assert.equal(createSourceRecord(raw), null, label + ' cannot construct a record');
    }
  },

  function normalizesHttpProvenanceWithoutDroppingPathOrQuery() {
    const rawUrl = 'https://example.test/a/b?take=1#discard-me';
    const record = validRecord(sourceId('d'), {
      origin: { kind: 'url', url: rawUrl },
    });
    assert.equal(record.origin.url, 'https://example.test/a/b?take=1');
    assert.equal(record.origin.url, new URL(record.origin.url).href,
      'stored URL is a canonical URL serialization');
    assert.equal(new URL(record.origin.url).hash, '', 'stored URL has no fragment');
    assert.equal(new URL(record.origin.url).username, '', 'stored URL has no credentials');
  },

  function reportsReferencesByCreativeObjectTypeAndRefusesRemoval() {
    const id = sourceId('e');
    const project = {
      sources: { [id]: validRecord(id) },
      activeSourceId: id,
      clips: [{ id: 'c1', sourceId: id }, { id: 'c2', sourceId: sourceId('f') }],
      assets: {
        a1: { id: 'a1', provenance: { binding: 'project', sourceId: id } },
        a2: { id: 'a2', provenance: { binding: 'external', sourceId: id } },
      },
      loom: {
        plans: {
          p1: { id: 'p1', source: { id } },
          p2: { id: 'p2', source: { sha256: id } },
          p3: { id: 'p3', source: { id: sourceId('f') } },
        },
      },
    };
    const expected = { clips: ['c1'], assets: ['a1'], plans: ['p1', 'p2'] };
    assert.deepEqual(sourceReferences(project, id), expected);
    const before = JSON.stringify(project);
    assert.deepEqual(removeSource(project, id), {
      kind: 'blocked', sourceId: id, references: expected,
    });
    assert.equal(JSON.stringify(project), before, 'blocked removal preserves all state');
  },

  function removesOnlyAnUnreferencedSourceAndPreservesUnrelatedGlobalState() {
    const id = sourceId('1');
    const activeId = sourceId('2');
    const project = {
      sources: { [id]: validRecord(id), [activeId]: validRecord(activeId) },
      activeSourceId: activeId,
      clips: [], assets: {}, loom: { plans: {} },
      machine: { sentinel: 'machine-state' }, studio: { sentinel: 'studio-state' }, wire: { sentinel: 'wire-state' },
    };
    assert.deepEqual(removeSource(project, id), { kind: 'removed', sourceId: id });
    assert.equal(project.sources[id], undefined);
    assert.equal(project.activeSourceId, activeId);
    assert.deepEqual(project.machine, { sentinel: 'machine-state' });
    assert.deepEqual(project.studio, { sentinel: 'studio-state' });
    assert.deepEqual(project.wire, { sentinel: 'wire-state' });
  },

  function leavesTheProjectByteEquivalentForInvalidMutations() {
    const project = emptyProject();
    const beforeAdd = JSON.stringify(project);
    assert.equal(addSource(project, sourceInput('sha256:bad')).kind, 'invalid');
    assert.equal(JSON.stringify(project), beforeAdd, 'invalid source add does not mutate');

    const record = validRecord(sourceId('3'));
    addSource(project, record);
    const beforeAlias = JSON.stringify(project);
    assert.equal(addSourceAlias(project, record.id, ' ').kind, 'invalid');
    assert.equal(JSON.stringify(project), beforeAlias, 'invalid alias add does not mutate');

    const beforeRemove = JSON.stringify(project);
    assert.equal(removeSource(project, 'sha256:bad').kind, 'invalid');
    assert.equal(JSON.stringify(project), beforeRemove, 'invalid removal does not mutate');
  },
];

const PCM_DIGEST = 'sha256:6c0dbe60b9153c728a69955c92c872a2a3223587da4a5dec8e03b8cd5bf39b40';
const PCM_BYTES = Uint8Array.from([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3f,
  0x00, 0x00, 0x00, 0xbf, 0x00, 0x00, 0x80, 0x3f,
]);

function pcmFixture() {
  return {
    sampleRate: 48000,
    channelCount: 2,
    frames: 2,
    channels: [Float32Array.of(0, 0.5), Float32Array.of(-0.5, 1)],
  };
}

function pcmMeta(overrides = {}) {
  return {
    sampleRate: 48000,
    channelCount: 2,
    frames: 2,
    payload: { byteLength: 16, sha256: PCM_DIGEST },
    ...overrides,
  };
}

function provenanceProject() {
  const id = sourceId('9');
  return {
    sources: {
      [id]: validRecord(id, { audio: { sampleRate: 48000, channelCount: 2, frames: 96000 } }),
    },
    clips: [{ id: 'c1', sourceId: id, start: 1.25, end: 1.75 }],
  };
}

function projectAsset(overrides = {}) {
  const project = provenanceProject();
  return {
    id: 'a1',
    kind: 'sample',
    label: 'reed snap',
    sampleRate: 48000,
    channelCount: 2,
    frames: 24000,
    payload: { byteLength: 192000, sha256: PCM_DIGEST },
    provenance: {
      kind: 'source-clip',
      binding: 'project',
      sourceId: Object.keys(project.sources)[0],
      clipId: 'c1',
      sourceSpan: { start: 1.25, end: 1.75 },
      extraction: {
        startFrame: 60000,
        endFrame: 84000,
        sampleRate: 48000,
        channelCount: 2,
        buffer: 'original',
      },
      transforms: [],
    },
    ...overrides,
  };
}

export const samplePayloadCases = [
  async function serializesChannelMajorLittleEndianBytesAndLiteralDigest() {
    // Mutation caught: changing encoding order or relying on host-endian typed-array storage.
    const bytes = canonicalSampleBytes(pcmFixture());
    assert.deepEqual(Array.from(bytes), Array.from(PCM_BYTES), 'hand-derived channel-major bytes');
    const described = await describeSamplePayload(pcmFixture());
    assert.equal(described.sha256, PCM_DIGEST, 'independently supplied SHA-256 literal');
    assert.equal(described.byteLength, 16);
  },

  function preservesNegativeZeroAndVisibleSubarrayFrames() {
    // Mutation caught: normalizing -0 or copying a backing buffer instead of a typed-array view.
    assert.deepEqual(Array.from(canonicalSampleBytes({
      sampleRate: 1, channelCount: 1, frames: 1, channels: [Float32Array.of(-0)],
    })), [0, 0, 0, 0x80], '-0 retains the IEEE-754 sign bit');
    const source = Float32Array.of(9, 0.5, -0.5, 9);
    assert.deepEqual(Array.from(canonicalSampleBytes({
      sampleRate: 1, channelCount: 1, frames: 2, channels: [source.subarray(1, 3)],
    })), [0, 0, 0, 0x3f, 0, 0, 0, 0xbf], 'only visible frames are copied');
  },

  async function rejectsInvalidChannelsRatesAndUnsafePayloadArithmetic() {
    // Mutation caught: accepting malformed PCM or overflowing before the byte-length guard.
    const invalidSamples = [
      { ...pcmFixture(), channels: [Float32Array.of(0), Float32Array.of(0, 1)] },
      { ...pcmFixture(), channels: [] },
      { ...pcmFixture(), sampleRate: 0 },
      { ...pcmFixture(), sampleRate: Number.MAX_SAFE_INTEGER + 1 },
      { ...pcmFixture(), channels: [Float32Array.of(NaN, 0.5), Float32Array.of(-0.5, 1)] },
      { ...pcmFixture(), channels: [Float32Array.of(Infinity, 0.5), Float32Array.of(-0.5, 1)] },
    ];
    for (const sample of invalidSamples) assert.equal(canonicalSampleBytes(sample), null);
    const overflow = await validateSamplePayload(pcmMeta({
      frames: Number.MAX_SAFE_INTEGER,
      payload: { byteLength: 0, sha256: PCM_DIGEST },
    }), new Uint8Array());
    assert.deepEqual(overflow.ok, false, 'unsafe frame/channel byte multiplication rejects before hydrate');
  },

  async function verifiesBeforeHydrateAndKeepsCanonicalStoragePrivate() {
    // Mutation caught: public raw-byte hydration bypassing digest verification or sharing mutable storage.
    const tampered = PCM_BYTES.slice();
    tampered[0] = 1;
    const rejected = await validateSamplePayload(pcmMeta(), tampered);
    assert.equal(rejected.ok, false, 'same-length one-float tamper fails digest verification');
    assert.equal('sample' in rejected, false, 'failed verification exposes no partial hydration');
    assert.equal(await CanonicalPcm.fromVerified(pcmMeta(), tampered), null,
      'raw CanonicalPcm construction cannot bypass digest verification');
    assert.equal(await hydrateCanonicalPcm(pcmMeta(), tampered), null,
      'raw hydration cannot bypass digest verification');
    assert.throws(() => new CanonicalPcm(pcmMeta(), tampered), /verified CanonicalPcm/,
      'direct raw construction cannot bypass digest verification');

    const supplied = PCM_BYTES.slice();
    const canonical = await CanonicalPcm.fromVerified(pcmMeta(), supplied);
    assert.ok(canonical instanceof CanonicalPcm);
    supplied[0] = 1;
    const copied = canonical.copyBytes();
    copied[1] = 1;
    assert.deepEqual(Array.from(canonical.copyBytes()), Array.from(PCM_BYTES), 'owned bytes cannot be altered');
    const a = canonical.hydrate();
    const b = canonical.hydrate();
    a.channels[0][0] = 9;
    assert.equal(b.channels[0][0], 0, 'hydrations do not share channels');
    assert.equal(canonical.hydrate().channels[0][0], 0, 'playback cannot alter canonical PCM');
    assert.equal((await hydrateCanonicalPcm(pcmMeta(), PCM_BYTES)) instanceof CanonicalPcm, true);
  },

  async function rejectsNonStringDigestsAndDescriptorsWithoutThrowing() {
    // Mutation caught: passing Symbols into RegExp.test and throwing instead of returning an invalid result.
    const digest = await validateSamplePayload(pcmMeta({
      payload: { byteLength: 16, sha256: Symbol('digest') },
    }), PCM_BYTES);
    assert.deepEqual(digest.ok, false, 'a non-string digest is invalid, not exceptional');
    const project = provenanceProject();
    const asset = projectAsset();
    assert.equal(validateAssetProvenance(project, projectAsset({
      provenance: { ...asset.provenance, kind: Symbol('kind') },
    })).ok, false, 'a non-string provenance descriptor is invalid');
    assert.equal(validateAssetProvenance(project, projectAsset({
      provenance: {
        ...asset.provenance,
        transforms: [{ schemaVersion: 1, kind: Symbol('transform'), gain: 1 }],
      },
    })).ok, false, 'a non-string transform descriptor is invalid');
  },

  function deduplicatesReachableAssetsAndRejectsEveryOwnershipMismatch() {
    // Mutation caught: only reading the active scene or allowing missing/orphan metadata or payloads.
    const machine = {
      scenes: [
        { tracks: [{ sampleId: 'a1' }, { sampleId: 'a2' }] },
        { tracks: [{ sampleId: 'a2' }, { sampleId: 'a3' }] },
      ],
    };
    assert.deepEqual(reachableAssetIds(machine), ['a1', 'a2', 'a3']);
    const project = { machine, assets: { a1: {}, a2: {}, a3: {} } };
    assert.equal(validateAssetOwnership(project, new Set(['a1', 'a2', 'a3'])).ok, true);
    assert.equal(validateAssetOwnership({ ...project, assets: { a1: {}, a2: {} } },
      new Set(['a1', 'a2', 'a3'])).ok, false, 'reachable ID missing metadata');
    assert.equal(validateAssetOwnership({ ...project, assets: { a1: {}, a2: {}, a3: {}, a4: {} } },
      new Set(['a1', 'a2', 'a3'])).ok, false, 'orphan metadata');
    assert.equal(validateAssetOwnership(project, new Set(['a1', 'a2'])).ok, false,
      'reachable ID missing payload');
    assert.equal(validateAssetOwnership(project, new Set(['a1', 'a2', 'a3', 'a4'])).ok, false,
      'orphan payload');
  },

  function validatesExactProjectProvenanceAndBoundedTransformDescriptors() {
    // Mutation caught: accepting a source/clip/span/extraction mismatch or replaying unknown transforms.
    const project = provenanceProject();
    const asset = projectAsset();
    assert.deepEqual(validateAssetProvenance(project, asset), { ok: true, replayable: true });
    const mismatches = [
      { sourceId: sourceId('8') },
      { clipId: 'c2' },
      { sourceSpan: { start: 1.25, end: 1.5 } },
      { extraction: { ...asset.provenance.extraction, startFrame: 60001 } },
    ];
    for (const provenance of mismatches) {
      assert.equal(validateAssetProvenance(project, projectAsset({
        provenance: { ...asset.provenance, ...provenance },
      })).ok, false);
    }
    const external = projectAsset({ provenance: {
      binding: 'external', kind: 'field-capture', descriptor: { provider: 'archive', record: 'w-1' },
      transforms: [{ schemaVersion: 1, kind: 'linear-gain', gain: 2 }],
    } });
    assert.deepEqual(validateAssetProvenance(project, external), { ok: true, replayable: true });
    const unknown = projectAsset({ provenance: {
      binding: 'external', kind: 'field-capture', descriptor: { provider: 'archive' },
      transforms: [{ schemaVersion: 9, kind: 'future-pass', setting: true }],
    } });
    assert.deepEqual(validateAssetProvenance(project, unknown), { ok: true, replayable: false });
    const badGain = structuredClone(external);
    badGain.provenance.transforms[0].gain = 65;
    assert.equal(validateAssetProvenance(project, badGain).ok, false, 'gain is bounded and finite');
    const repairs = structuredClone(external);
    repairs.provenance.transforms = [{
      schemaVersion: 1, kind: 'spectral-repair-stack', repairs: [{
        id: 'rp1', t0: 1, t1: 1.2, f0: 200, f1: 400, strength: 0.6, enabled: true, label: 'tone',
      }],
    }];
    assert.deepEqual(validateAssetProvenance(project, repairs), { ok: true, replayable: true });
    repairs.provenance.transforms = Array.from({ length: 33 }, () => ({ schemaVersion: 1, kind: 'linear-gain', gain: 1 }));
    assert.equal(validateAssetProvenance(project, repairs).ok, false, 'transform count is bounded');
  },
];

function preparedStereoSample() {
  const sample = pcmFixture();
  return describeSamplePayload(sample).then((payload) => ({
    meta: {
      kind: 'sample',
      label: 'STEREO',
      sampleRate: sample.sampleRate,
      channelCount: sample.channelCount,
      frames: sample.frames,
      payload: { byteLength: payload.byteLength, sha256: payload.sha256 },
    },
    sample,
    bytes: payload.bytes,
  }));
}

async function canonicalOwner(frames, value = 0.25) {
  const sample = {
    channels: [Float32Array.from({ length: frames }, (_, index) => value + index / 100)],
    sampleRate: 48000,
    channelCount: 1,
    frames,
  };
  const payload = await describeSamplePayload(sample);
  const trustStore = new ProjectStore([]);
  const id = await registerPreparedAsset(trustStore.project, trustStore.runtime, {
    meta: {
      kind: 'sample',
      label: 'TEST',
      sampleRate: sample.sampleRate,
      channelCount: sample.channelCount,
      frames: sample.frames,
      payload: { byteLength: payload.byteLength, sha256: payload.sha256 },
    },
    bytes: payload.bytes,
  });
  return trustStore.runtime.assetPcm.get(id);
}

function putCurrentAsset(store, id, owner) {
  const { project, runtime } = store;
  project.assets = {
    [id]: {
      id,
      kind: 'sample',
      label: id.toUpperCase(),
      sampleRate: 48000,
      channelCount: 1,
      frames: owner.byteLength / 4,
    },
  };
  for (const scene of project.machine.scenes) {
    for (const track of scene.tracks) {
      track.sampleId = null;
      track.sample = null;
    }
  }
  project.machine.tracks[0].sampleId = id;
  project.machine.tracks[0].sample = owner.hydrate();
  runtime.assetPcm.clear();
  runtime.assetPcm.set(id, owner);
}

function legacySample(values, label) {
  return {
    channels: [Float32Array.from(values)],
    sampleRate: 48000,
    label,
    role: 'KICK',
  };
}

function putLegacyAsset(store, id, sample, trackIndex = 0) {
  store.project.assets[id] = {
    id,
    kind: 'sample',
    label: sample.label,
    role: sample.role,
    sampleRate: sample.sampleRate,
    channelCount: sample.channels.length,
    frames: sample.channels[0].length,
  };
  store.project.machine.tracks[trackIndex].sampleId = id;
  store.project.machine.tracks[trackIndex].sample = sample;
}

function attachV2History(store, modern = true) {
  const takeDocument = () => snapshotDoc(store.project, store.runtime);
  const applyDocument = (document, pcmById = new Map()) => {
    applySnapshot(document, { project: store.project, runtime: store.runtime });
    for (const scene of store.project.machine.scenes) {
      for (const track of scene.tracks) {
        if (track.sampleId && pcmById.has(track.sampleId)) {
          track.sample = pcmById.get(track.sampleId);
        }
      }
    }
  };
  if (modern) store.attachHistory({ takeDocument, applyDocument });
  else store.attachHistory(takeDocument, applyDocument);
}

export const projectStoreV3Cases = [
  function startsWithV3DocumentStateAndTheCompatibilityFacade() {
    // Mutation caught: a new project loses the serializable v3 roots or breaks
    // the legacy callers that retain the original chain array by reference.
    const chain = [{ id: 'gate', on: false, params: {} }];
    const project = createProject(chain);
    assert.deepEqual({
      activeSourceId: project.activeSourceId,
      sources: project.sources,
      allocators: project.allocators,
      clips: project.clips,
      assets: project.assets,
    }, {
      activeSourceId: null,
      sources: {},
      allocators: { clip: 0, asset: 0 },
      clips: [],
      assets: {},
    });
    assert.equal(project.fileName, null);
    assert.equal(project.words, null);
    assert.deepEqual(project.transcript, { gapCuts: [] });
    assert.strictEqual(project.chain, chain, 'legacy chain facade remains in place');
  },

  function recognizesOnlyTheExactProjectAndPreservesOwnedContainersAcrossV2Restore() {
    // Mutation caught: keying trust by a globally branded container instead
    // of the exact createProject object and both of its original containers.
    const project = createProject([]);
    const atlas = project.clips;
    const allocators = project.allocators;
    assert.equal(hasCanonicalProjectState(project), true);
    assert.equal(hasCanonicalProjectState(new Proxy(project, {})), false);
    assert.equal(hasCanonicalProjectState({ ...project }), false);
    const json = snapshotDoc(project, { sourceBytes: null, repairs: [], analysis: null });
    json.clips = [{ id: 'c1', sourceId: sourceId('a'), start: 0, end: 1 }];
    applySnapshot(json, {
      project,
      runtime: { sourceBytes: null, repairs: [], analysis: null },
    });
    assert.strictEqual(project.clips, atlas);
    assert.strictEqual(project.allocators, allocators);
    assert.equal(hasCanonicalProjectState(project), true);
    assert.equal(project.clips[0].id, 'c1');
  },

  function rejectsCrossProjectAndReplacementContainerOwnershipBeforeAllocation() {
    // Mutation caught: treating any globally branded Atlas or plausible
    // allocator object as belonging to whichever project currently points at it.
    const first = createProject([]);
    const second = createProject([]);
    const firstAtlas = first.clips;
    const firstAllocators = first.allocators;
    const secondAtlas = second.clips;
    const secondAllocators = second.allocators;

    second.clips = firstAtlas;
    assert.equal(hasCanonicalProjectState(second), false);
    assert.throws(() => allocateProjectId(second, 'clip'), /project|allocator|canonical/i);
    assert.equal(firstAllocators.clip, 0);
    second.clips = secondAtlas;

    second.allocators = firstAllocators;
    assert.equal(hasCanonicalProjectState(second), false);
    assert.throws(() => allocateProjectId(second, 'clip'), /project|allocator|canonical/i);
    assert.equal(firstAllocators.clip, 0);

    second.clips = firstAtlas;
    assert.throws(() => allocateProjectId(second, 'clip'), /project|allocator|canonical/i);
    assert.equal(firstAllocators.clip, 0);
    assert.deepEqual(firstAtlas, []);

    second.clips = [];
    second.allocators = { clip: 0, asset: 0 };
    assert.equal(hasCanonicalProjectState(second), false);
    assert.throws(() => allocateProjectId(second, 'clip'), /project|allocator|canonical/i);
    assert.strictEqual(first.clips, firstAtlas);
    assert.strictEqual(first.allocators, firstAllocators);
    assert.strictEqual(secondAtlas.length, 0);
    assert.strictEqual(secondAllocators.clip, 0);
  },

  function allocatesProjectLocalIdsMonotonicallyWithoutScanningOrReuse() {
    // Mutation caught: returning the current counter, repairing a stale counter
    // by scanning state, or relying on a module-global allocator.
    const project = createProject([]);
    project.allocators.clip = 8;
    project.allocators.asset = 13;
    assert.equal(allocateProjectId(project, 'clip'), 'c9');
    assert.equal(registerAsset(project, { kind: 'sample' }), 'a14');
    project.clips.push({ id: 'c9' });
    delete project.assets.a14;
    project.clips.length = 0;
    assert.equal(allocateProjectId(project, 'clip'), 'c10', 'a deleted suffix is never reused');
    assert.equal(registerAsset(project, { kind: 'sample' }), 'a15', 'asset allocation never scans down');

    const staleClip = createProject([]);
    staleClip.allocators.clip = 3;
    staleClip.clips.push({ id: 'c4' });
    assert.throws(() => allocateProjectId(staleClip, 'clip'), RangeError, 'stale clip counter is refused');
    const staleAsset = createProject([]);
    staleAsset.allocators.asset = 3;
    staleAsset.assets.a4 = {};
    assert.throws(() => allocateProjectId(staleAsset, 'asset'), RangeError, 'stale asset counter is refused');
    const unsafe = createProject([]);
    unsafe.allocators.asset = Number.MAX_SAFE_INTEGER;
    assert.throws(() => allocateProjectId(unsafe, 'asset'), RangeError, 'unsafe counter is refused');

    const first = createProject([]);
    const second = createProject([]);
    assert.equal(allocateProjectId(first, 'asset'), 'a1');
    assert.equal(allocateProjectId(second, 'asset'), 'a1', 'projects do not share allocation state');
  },

  function rejectsAllocatorProxyCounterfeitCommitAndRollbackBeforeAnyTrap() {
    // Mutation caught: trusting a Proxy that fabricates descriptor/read
    // postconditions for a dropped commit or a dropped rollback.
    const commitProject = createProject([]);
    const commitCounters = commitProject.allocators;
    let reported = 0;
    let commitWrites = 0;
    commitProject.allocators = new Proxy(commitCounters, {
      get(target, property, receiver) {
        if (property === 'clip') return reported;
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === 'clip') {
          return { value: reported, writable: true, enumerable: true, configurable: true };
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      set(target, property, value) {
        commitWrites++;
        if (property === 'clip') reported = value;
        return true;
      },
    });
    assert.throws(() => allocateProjectId(commitProject, 'clip'), /project|allocator|canonical/i);
    assert.equal(commitWrites, 0, 'a counterfeit commit boundary is never entered');
    assert.equal(commitCounters.clip, 0);

    const rollbackProject = createProject([]);
    const rollbackCounters = rollbackProject.allocators;
    let counterfeitingRollback = false;
    let rollbackWrites = 0;
    rollbackProject.allocators = new Proxy(rollbackCounters, {
      get(target, property, receiver) {
        if (property === 'clip' && counterfeitingRollback) return 0;
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === 'clip' && counterfeitingRollback) {
          return { value: 0, writable: true, enumerable: true, configurable: true };
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      set(target, property, value) {
        rollbackWrites++;
        Reflect.set(target, property, value, target);
        counterfeitingRollback = true;
        throw new Error('allocator write fault');
      },
      defineProperty() {
        return true;
      },
    });
    assert.throws(() => allocateProjectId(rollbackProject, 'clip'), /project|allocator|canonical/i);
    assert.equal(rollbackWrites, 0, 'a counterfeit rollback boundary is never entered');
    assert.equal(rollbackCounters.clip, 0, 'the authoritative counter remains unchanged');
    assert.deepEqual(rollbackProject.clips, []);

    const assetProject = createProject([]);
    const assetCounters = assetProject.allocators;
    assetProject.allocators = new Proxy(assetCounters, {});
    assert.throws(() => registerAsset(assetProject, { kind: 'sample' }), /project|allocator|canonical/i);
    assert.equal(assetCounters.asset, 0);
    assert.deepEqual(assetProject.assets, {}, 'asset metadata never commits through a foreign allocator');
  },

  function legacyAssetMetadataCannotOverrideTheAllocatedRecordId() {
    // Mutation caught: spreading caller metadata over the allocated identity,
    // leaving an a1 map key whose record claims to be a999.
    const project = createProject([]);
    assert.equal(registerAsset(project, { id: 'a999', kind: 'sample' }), 'a1');
    assert.equal(project.assets.a1.id, 'a1', 'record identity always equals its project key');
    assert.equal(project.assets.a999, undefined, 'caller metadata cannot claim another asset slot');
  },

  async function ownsOnlyVerifiedPreparedPcmAndHydratesDisposableTrackSamples() {
    // Mutation caught: accepting raw/unverified bytes, retaining caller/playback
    // storage, or allowing a stale allocator to replace existing PCM ownership.
    const store = new ProjectStore([]);
    const prepared = await preparedStereoSample();
    const pending = registerPreparedAsset(store.project, store.runtime, prepared);
    assert.equal(store.project.assets.a1, undefined, 'no metadata exists before SHA-256 verification');
    assert.equal(store.runtime.assetPcm.has('a1'), false, 'no owner exists before SHA-256 verification');
    const id = await pending;
    assert.equal(id, 'a1');
    assert.deepEqual(store.project.assets.a1, { id: 'a1', ...prepared.meta }, 'only JSON metadata is stored');
    assert.ok(store.runtime.assetPcm.get(id) instanceof CanonicalPcm, 'runtime owns a verified CanonicalPcm');
    assert.equal(JSON.stringify(store.project.assets.a1).includes('channels'), false, 'PCM is never serialized into metadata');

    const owner = store.runtime.assetPcm.get(id);
    const originalBytes = owner.copyBytes();
    prepared.sample.channels[0][0] = 99;
    prepared.bytes[0] = 1;
    const returnedBytes = owner.copyBytes();
    returnedBytes[1] = 1;
    store.project.machine.tracks[0].sampleId = id;
    resolveTrackSamples(store.project, store.runtime);
    const track = store.project.machine.tracks[0];
    assert.notStrictEqual(track.sample, owner, 'track receives a playback hydration, never the owner');
    track.sample.channels[0][0] = -99;
    const later = owner.copyBytes();
    assert.deepEqual(Array.from(later), Array.from(originalBytes), 'mutable inputs and playback cannot alter owned bytes');
    const digest = await describeSamplePayload(owner.hydrate());
    assert.equal(digest.sha256, store.project.assets.a1.payload.sha256, 'later hydration retains the verified digest');

    const replacement = await preparedStereoSample();
    replacement.sample.channels[0][0] = 0.25;
    const replacementDescription = await describeSamplePayload(replacement.sample);
    replacement.meta.payload = {
      byteLength: replacementDescription.byteLength,
      sha256: replacementDescription.sha256,
    };
    replacement.bytes = replacementDescription.bytes;
    store.project.allocators.asset = 0;
    await assert.rejects(registerPreparedAsset(store.project, store.runtime, replacement), RangeError,
      'a stale allocator cannot rewrite a1 with different bytes');
    assert.deepEqual(Array.from(owner.copyBytes()), Array.from(originalBytes), 'the original owner remains authoritative');
  },

  async function rejectsPcmBearingOrUnknownPreparedMetadataWithoutMutation() {
    // Mutation caught: accepting JSON-shaped raw ownership into the serializable
    // asset document, even though only the verified owner may hold PCM bytes.
    const rejectedFields = [
      ['channels', { channels: [[0, 0.5], [-0.5, 1]] }],
      ['raw bytes', { bytes: [0, 0, 0, 0] }],
      ['raw bytes alias', { rawBytes: [0, 0, 0, 0] }],
      ['ownership', { ownership: { owner: 'untrusted' } }],
    ];
    for (const [label, extra] of rejectedFields) {
      const store = new ProjectStore([]);
      const prepared = await preparedStereoSample();
      Object.assign(prepared.meta, extra);
      await assert.rejects(registerPreparedAsset(store.project, store.runtime, prepared), TypeError, label);
      assert.equal(store.project.allocators.asset, 0, label + ' leaves allocation unchanged');
      assert.deepEqual(store.project.assets, {}, label + ' leaves metadata empty');
      assert.equal(store.runtime.assetPcm.size, 0, label + ' installs no owner');
    }
  },

  async function validatesPreparedMetadataAndProvenanceBeforeOwnershipMutation() {
    // Mutation caught: treating a JSON-compatible nested provenance object as
    // safe metadata even when it carries PCM-like values or unsupported freight.
    const external = () => ({
      kind: 'field-capture',
      binding: 'external',
      descriptor: { provider: 'archive', record: 'w-1' },
      transforms: [{ schemaVersion: 9, kind: 'future-pass', setting: true }],
    });
    const invalid = [
      ['provenance channels', (meta) => { meta.provenance = { ...external(), channels: [[0, 0.5], [-0.5, 1]] }; }],
      ['unknown provenance field', (meta) => { meta.provenance = { ...external(), ownership: { owner: 'untrusted' } }; }],
      ['payload extra', (meta) => { meta.payload.extra = true; }],
      ['object label', (meta) => { meta.label = { value: 'STEREO' }; }],
      ['object role', (meta) => { meta.role = { value: 'KICK' }; }],
      ['unsafe sample rate', (meta) => { meta.sampleRate = Number.MAX_SAFE_INTEGER + 1; }],
      ['invalid channel count', (meta) => { meta.channelCount = 0; }],
      ['invalid frame count', (meta) => { meta.frames = -1; }],
      ['malformed provenance', (meta) => { meta.provenance = { kind: 'field-capture', binding: 'external', transforms: [] }; }],
    ];
    for (const [label, mutate] of invalid) {
      const store = new ProjectStore([]);
      const prepared = await preparedStereoSample();
      mutate(prepared.meta);
      await assert.rejects(registerPreparedAsset(store.project, store.runtime, prepared), TypeError, label);
      assert.equal(store.project.allocators.asset, 0, label + ' leaves allocation unchanged');
      assert.deepEqual(store.project.assets, {}, label + ' leaves metadata empty');
      assert.equal(store.runtime.assetPcm.size, 0, label + ' installs no owner');
    }

    const store = new ProjectStore([]);
    const prepared = await preparedStereoSample();
    prepared.meta.provenance = {
      ...external(),
      descriptor: { provider: 'archive', record: 'w-1', offsets: [1, 2, 3] },
    };
    assert.equal(await registerPreparedAsset(store.project, store.runtime, prepared), 'a1');
    assert.deepEqual(store.project.assets.a1.provenance, prepared.meta.provenance,
      'a bounded external descriptor and unknown transform remain truthful metadata');
    assert.equal(store.runtime.assetPcm.size, 1, 'the valid record installs one verified owner');
  },

  async function historyOwnsExactReachablePcmAndCountsSharedAssetsOnce() {
    // Mutation caught: leaving PCM in the controller WeakMap, counting the same
    // asset once per track/snapshot, or retaining a playback hydration instead
    // of the exact canonical owner.
    const store = new ProjectStore([], { historyLimit: 3, historyPcmBudget: 80 });
    attachV2History(store, false);
    const owner = await canonicalOwner(8);
    putCurrentAsset(store, 'a1', owner);
    store.project.machine.tracks[1].sampleId = 'a1';
    store.project.machine.tracks[1].sample = owner.hydrate();

    store.update('pattern', (project) => { project.machine.tracks[0].steps[0] = 1; });
    store.update('pattern', (project) => { project.machine.tracks[0].steps[1] = 1; });

    assert.strictEqual(store.runtime.historyAssetPcm.get('a1'), owner,
      'history retains the exact canonical owner');
    assert.equal(store.runtime.historyPcmBytes, 32,
      'one asset shared by tracks and snapshots is charged once');
    assert.equal(store.undoDepth, 2, 'both documents remain independently undoable');
  },

  async function trimsWholeOldestSnapshotsByByteAndCountWithRefcounts() {
    // Mutation caught: count-only trimming, per-entry double charging, dropping
    // a still-referenced owner, or trimming a document without its PCM.
    const store = new ProjectStore([], { historyLimit: 3, historyPcmBudget: 80 });
    attachV2History(store, false);
    const owners = {
      a1: await canonicalOwner(6, 0.01),  // 24 bytes
      a2: await canonicalOwner(8, 0.02),  // 32 bytes
      a3: await canonicalOwner(10, 0.03), // 40 bytes
      a4: await canonicalOwner(2, 0.04),  // 8 bytes
    };
    const trims = [];
    store.addEventListener('historytrim', (event) => trims.push(event.detail.message));
    putCurrentAsset(store, 'a1', owners.a1);
    store.update('assets', () => { putCurrentAsset(store, 'a2', owners.a2); });
    store.update('assets', () => { putCurrentAsset(store, 'a3', owners.a3); });
    store.update('assets', () => { putCurrentAsset(store, 'a4', owners.a4); });

    assert.equal(store.undoDepth, 2, 'the byte budget evicts the whole a1 snapshot');
    assert.equal(store.runtime.historyPcmBytes, 72, 'only a2 and a3 remain history-owned');
    assert.equal(store.runtime.historyAssetPcm.has('a1'), false, 'newly unreachable a1 PCM is released');
    assert.strictEqual(store.runtime.historyAssetPcm.get('a2'), owners.a2);
    assert.strictEqual(store.runtime.historyAssetPcm.get('a3'), owners.a3);

    store.update('pattern', (project) => { project.machine.tracks[0].steps[0] = 1; });
    assert.equal(store.undoDepth, 3, 'an exactly-on-budget third snapshot is retained');
    assert.equal(store.runtime.historyPcmBytes, 80);
    store.update('pattern', (project) => { project.machine.tracks[0].steps[1] = 1; });
    assert.equal(store.undoDepth, 3, 'count overflow evicts exactly one oldest snapshot');
    assert.equal(store.runtime.historyAssetPcm.has('a2'), false,
      'a2 is released only after its last retained snapshot is evicted');
    assert.strictEqual(store.runtime.historyAssetPcm.get('a4'), owners.a4,
      'the shared a4 owner survives eviction of one referring snapshot');
    assert.deepEqual(trims, [
      'UNDO HISTORY TRIMMED TO PROTECT AUDIO MEMORY',
      'UNDO HISTORY TRIMMED TO PROTECT AUDIO MEMORY',
    ]);
  },

  async function byteTrimChoosesTheOldestSnapshotAcrossUndoAndRedoStacks() {
    // Mutation caught: always trimming _past first even after a full undo makes
    // an older retained entry live at the front of _future.
    const store = new ProjectStore([], { historyLimit: 3, historyPcmBudget: 80 });
    attachV2History(store);
    const owners = {
      a1: await canonicalOwner(6, 0.11),
      a2: await canonicalOwner(6, 0.12),
      a3: await canonicalOwner(6, 0.13),
      a4: await canonicalOwner(6, 0.14),
    };
    putCurrentAsset(store, 'a1', owners.a1);
    store.update('assets', () => { putCurrentAsset(store, 'a2', owners.a2); });
    store.update('assets', () => { putCurrentAsset(store, 'a3', owners.a3); });
    store.update('assets', () => { putCurrentAsset(store, 'a4', owners.a4); });
    assert.equal(store.undo(), true);
    assert.equal(store.undo(), true);
    assert.equal(store.undo(), true);
    store.historyPcmBudget = 48;

    assert.equal(store.redo(), true);
    assert.equal(store.canUndo, true, 'the newly created past entry is not the oldest');
    assert.strictEqual(store.runtime.historyAssetPcm.get('a1'), owners.a1,
      'the newest retained snapshot remains undoable');
    assert.equal(store.runtime.historyAssetPcm.has('a4'), false,
      'the oldest future snapshot and its newly unreachable PCM are evicted first');
  },

  async function clearHistoryReleasesOnlyHistoryOwnedPcm() {
    // Mutation caught: clearing stack arrays without releasing retained PCM, or
    // clearing the current asset map along with session-local history.
    const store = new ProjectStore([], { historyLimit: 3, historyPcmBudget: 80 });
    attachV2History(store);
    const oldOwner = await canonicalOwner(6, 0.1);
    const currentOwner = await canonicalOwner(8, 0.2);
    putCurrentAsset(store, 'a1', oldOwner);
    store.update('assets', () => { putCurrentAsset(store, 'a2', currentOwner); });
    assert.strictEqual(store.runtime.historyAssetPcm.get('a1'), oldOwner);

    store.clearHistory('topology');

    assert.equal(store.canUndo, false);
    assert.equal(store.canRedo, false);
    assert.equal(store.runtime.historyAssetPcm.size, 0, 'all history-only owners are released');
    assert.equal(store.runtime.historyPcmBytes, 0);
    assert.strictEqual(store.runtime.assetPcm.get('a2'), currentOwner, 'current PCM remains owned');
  },

  function beforeHistoryHookIsSynchronousAndOnlyRunsForRecordedUpdates() {
    // Mutation caught: projecting after takeDocument, projecting twice, or
    // projecting for navigation/transport and undo/redo application.
    const store = new ProjectStore([], { historyLimit: 3, historyPcmBudget: 80 });
    const order = [];
    store.attachHistory({
      takeDocument: () => {
        order.push('take:' + store.project.clips.length);
        return { machine: { scenes: [] }, clips: structuredClone(store.project.clips) };
      },
      applyDocument: (document) => {
        order.push('apply');
        store.project.clips.length = 0;
        store.project.clips.push(...structuredClone(document.clips));
      },
    });
    store.setBeforeHistorySnapshot(() => { order.push('before'); });

    store.update('clips', (project) => {
      order.push('mutate');
      project.clips.push({ id: 'c1' });
    });
    assert.deepEqual(order, ['before', 'take:0', 'mutate']);
    order.length = 0;
    store.update('source-navigation', () => { order.push('navigate'); }, { history: 'none' });
    store.update('transport', () => { order.push('transport'); }, { history: 'none' });
    assert.deepEqual(order, ['navigate', 'transport'], 'no-history work never invokes the hook');
    order.length = 0;
    assert.equal(store.undo(), true);
    assert.deepEqual(order, ['take:1', 'apply'], 'undo captures/applies without invoking the hook');
    order.length = 0;
    assert.equal(store.redo(), true);
    assert.deepEqual(order, ['take:0', 'apply'], 'redo captures/applies without invoking the hook');
  },

  function undoPreservesActiveSourceAndRestoresItsFacadeDocument() {
    // Mutation caught: recording navigation as history, applying a snapshot's
    // stale active ID, or hydrating the wrong source document into the facade.
    const a = sourceId('a');
    const b = sourceId('b');
    const store = new ProjectStore([], { historyLimit: 3, historyPcmBudget: 80 });
    store.project.sources = {
      [a]: { document: { words: ['A0'] } },
      [b]: { document: { words: ['B0'] } },
    };
    store.project.activeSourceId = a;
    store.project.words = ['A0'];
    store.attachHistory({
      takeDocument: () => ({
        machine: { scenes: [] },
        activeSourceId: store.project.activeSourceId,
        sources: structuredClone(store.project.sources),
      }),
      applyDocument: (document) => {
        store.project.sources = structuredClone(document.sources);
        store.project.activeSourceId = document.activeSourceId;
        store.project.words = structuredClone(document.sources[document.activeSourceId].document.words);
      },
    });
    store.update('source-edit', (project) => {
      project.sources[a].document.words = ['A1'];
      project.words = ['A1'];
    });
    store.update('source-navigation', (project) => {
      project.activeSourceId = b;
      project.words = ['B0'];
    }, { history: 'none' });
    store.update('source-edit', (project) => {
      project.sources[b].document.words = ['B1'];
      project.words = ['B1'];
    });
    const depthAfterEdits = store.undoDepth;
    store.update('source-navigation', (project) => {
      project.activeSourceId = a;
      project.words = ['A1'];
    }, { history: 'none' });
    assert.equal(store.undoDepth, depthAfterEdits, 'navigation creates no creative history');

    assert.equal(store.undo(), true);
    assert.equal(store.project.activeSourceId, a, 'the currently active source survives undo');
    assert.deepEqual(store.project.words, ['A1'], 'that source\'s restored document hydrates the facade');
    assert.deepEqual(store.project.sources[b].document.words, ['B0'], 'the creative edit to B is undone');
    assert.equal(store.redo(), true);
    assert.equal(store.project.activeSourceId, a, 'the currently active source survives redo');
    assert.deepEqual(store.project.words, ['A1']);
    assert.deepEqual(store.project.sources[b].document.words, ['B1']);
  },

  function missingHistoryPcmAbortsUndoBeforeAnyMutation() {
    // Mutation caught: popping first and discovering dangling PCM only after
    // applySnapshot has mutated the document and revision.
    const store = new ProjectStore([], { historyLimit: 3, historyPcmBudget: 80 });
    attachV2History(store);
    store.project.assets.a7 = {
      id: 'a7', kind: 'sample', label: 'MISSING', sampleRate: 48000, channelCount: 1, frames: 2,
    };
    store.project.machine.tracks[0].sampleId = 'a7';
    store.project.machine.tracks[0].sample = null;
    store.update('pattern', (project) => { project.machine.tracks[0].steps[3] = 1; });
    const documentBefore = snapshotDoc(store.project, store.runtime);
    delete documentBefore.savedAt;
    const revisionBefore = store.revision;
    const depthBefore = store.undoDepth;
    let changes = 0;
    store.addEventListener('change', () => { changes++; });

    assert.equal(store.undo(), false, 'a dangling target is refused');
    assert.equal(store.undoDepth, depthBefore, 'the undo entry is not popped');
    assert.equal(store.revision, revisionBefore, 'revision is unchanged');
    const documentAfter = snapshotDoc(store.project, store.runtime);
    delete documentAfter.savedAt;
    assert.deepEqual(documentAfter, documentBefore, 'the project is unchanged');
    assert.equal(changes, 0, 'no false history change is emitted');
  },

  async function validUndoResolvesPlaybackBeforeTheHistoryEvent() {
    // Mutation caught: applying the document before gathering PCM, passing the
    // canonical owner into a mutable track, or emitting history before every
    // restored pointer is playable.
    const store = new ProjectStore([], { historyLimit: 3, historyPcmBudget: 80 });
    const owner = await canonicalOwner(8, 0.3);
    putCurrentAsset(store, 'a1', owner);
    let appliedPcm = null;
    store.attachHistory({
      takeDocument: () => snapshotDoc(store.project, store.runtime),
      applyDocument: (document, pcmById) => {
        appliedPcm = pcmById;
        applySnapshot(document, { project: store.project, runtime: store.runtime });
      },
    });
    store.update('pattern', (project) => { project.machine.tracks[0].steps[6] = 1; });
    let playableAtEvent = false;
    store.addEventListener('change', (event) => {
      if (event.detail.kind !== 'history') return;
      const track = store.project.machine.tracks[0];
      playableAtEvent = !!track.sample && track.sample.channels[0].length === 8;
    });

    assert.equal(store.undo(), true);
    assert.ok(appliedPcm instanceof Map, 'PCM is gathered before applyDocument');
    assert.notStrictEqual(appliedPcm.get('a1'), owner, 'the owner is never installed as mutable playback');
    assert.equal(playableAtEvent, true, 'every track pointer resolves before the history event');
    assert.strictEqual(store.runtime.assetPcm.get('a1'), owner, 'current ownership remains canonical');
  },

  async function legacyAdoptionDetachesOwnerAndPlaybackFromCallerArrays() {
    // Mutation caught: adopting the exact mutable track.sample object or one of
    // its caller-held channel arrays as current/history ownership.
    const store = new ProjectStore([], { historyLimit: 3, historyPcmBudget: 80 });
    attachV2History(store);
    const callerSample = legacySample([0.125, -0.25, 0.5, -0.5], 'OLD');
    const callerChannel = callerSample.channels[0];
    putLegacyAsset(store, 'a1', callerSample);

    store.update('pattern', (project) => { project.machine.tracks[0].steps[0] = 1; });
    const owner = store.runtime.assetPcm.get('a1');
    const retained = store.runtime.historyAssetPcm.get('a1');
    const playback = store.project.machine.tracks[0].sample;
    assert.notStrictEqual(owner, callerSample, 'current ownership is detached from legacy playback');
    assert.strictEqual(retained, owner, 'history retains the detached owner');
    assert.notStrictEqual(playback, callerSample, 'current playback is rehydrated from the owner');
    assert.notStrictEqual(playback.channels[0], callerChannel, 'current playback channels are fresh');

    callerChannel[0] = 0.99;
    callerSample.channels = [Float32Array.from([0.8, 0.8, 0.8, 0.8])];
    assert.deepEqual(Array.from(owner.hydrate().channels[0]), [0.125, -0.25, 0.5, -0.5]);
    assert.deepEqual(Array.from(playback.channels[0]), [0.125, -0.25, 0.5, -0.5]);
    assert.equal(store.undo(), true);
    assert.deepEqual(Array.from(store.project.machine.tracks[0].sample.channels[0]), [0.125, -0.25, 0.5, -0.5]);

    const verifiedStore = new ProjectStore([], { historyLimit: 3, historyPcmBudget: 80 });
    attachV2History(verifiedStore);
    const verified = await canonicalOwner(4, 0.25);
    putCurrentAsset(verifiedStore, 'a1', verified);
    verifiedStore.update('assets', (project) => {
      project.machine.tracks[0].sample = legacySample([-0.125, -0.25, -0.5, -0.75], 'REJECT');
    });
    assert.strictEqual(verifiedStore.runtime.assetPcm.get('a1'), verified,
      'a legacy replacement cannot supersede verified ownership');
    assert.deepEqual(Array.from(verifiedStore.project.machine.tracks[0].sample.channels[0]),
      Array.from(verified.hydrate().channels[0]), 'playback returns to verified authority');
  },

  function sameIdLegacyVersionsUndoAndRedoTheirOwnDetachedPcm() {
    // Mutation caught: resolving an entry through the current id map instead of
    // the PCM version captured for that specific history document.
    const store = new ProjectStore([], { historyLimit: 3, historyPcmBudget: 80 });
    attachV2History(store);
    putLegacyAsset(store, 'a1', legacySample([0.125, 0.25, 0.5, 0.75], 'VERSION'));
    store.update('pattern', (project) => {
      project.machine.tracks[0].steps[0] = 1;
      project.machine.tracks[0].sample = legacySample([-0.125, -0.25, -0.5, -0.75], 'VERSION');
    });
    store.update('pattern', (project) => { project.machine.tracks[0].steps[1] = 1; });

    assert.equal(store.undo(), true);
    const firstNewPlayback = store.project.machine.tracks[0].sample.channels[0];
    assert.deepEqual(Array.from(firstNewPlayback), [-0.125, -0.25, -0.5, -0.75],
      'the newer entry restores its own PCM version');
    firstNewPlayback[0] = 0.77;
    assert.equal(store.undo(), true);
    assert.deepEqual(Array.from(store.project.machine.tracks[0].sample.channels[0]), [0.125, 0.25, 0.5, 0.75],
      'the older entry restores the prior PCM version');
    assert.equal(store.redo(), true);
    const secondNewPlayback = store.project.machine.tracks[0].sample.channels[0];
    assert.deepEqual(Array.from(secondNewPlayback), [-0.125, -0.25, -0.5, -0.75]);
    assert.notStrictEqual(secondNewPlayback, firstNewPlayback, 'redo hydrates fresh playback channels');
  },

  function topologyClearDropsUnreachableAdoptedOwnerAndKeepsReachableOwner() {
    // Mutation caught: leaving an adopted owner pinned in current PCM after its
    // last track is removed, or clearing a different still-reachable owner.
    const store = new ProjectStore([], { historyLimit: 3, historyPcmBudget: 80 });
    attachV2History(store);
    putLegacyAsset(store, 'a1', legacySample([0.125, 0.25, 0.5, 0.75], 'REMOVE'), 0);
    putLegacyAsset(store, 'a2', legacySample([-0.125, -0.25, -0.5, -0.75], 'KEEP'), 1);
    store.update('pattern', (project) => { project.machine.tracks[0].steps[0] = 1; });
    const reachableOwner = store.runtime.assetPcm.get('a2');
    store.update('assets', (project) => {
      project.machine.tracks[0].sampleId = null;
      project.machine.tracks[0].sample = null;
      delete project.assets.a1;
    });

    store.clearHistory('topology');

    assert.equal(store.runtime.historyAssetPcm.size, 0);
    assert.equal(store.runtime.historyPcmBytes, 0);
    assert.equal(store.runtime.assetPcm.has('a1'), false, 'unreachable adopted current owner is released');
    assert.strictEqual(store.runtime.assetPcm.get('a2'), reachableOwner,
      'the reachable current owner is preserved');
    assert.deepEqual(Array.from(store.project.machine.tracks[1].sample.channels[0]), [-0.125, -0.25, -0.5, -0.75]);
  },

  function sharedLegacyOwnerIsChargedOnceAndEntryShapeStaysMinimal() {
    // Mutation caught: copying per track/snapshot, double-charging identical
    // owner identity, or adding ownership fields to the history entry object.
    const store = new ProjectStore([], { historyLimit: 3, historyPcmBudget: 80 });
    attachV2History(store);
    const sample = legacySample([0.1, 0.2, 0.3, 0.4], 'SHARED');
    putLegacyAsset(store, 'a1', sample, 0);
    putLegacyAsset(store, 'a1', sample, 1);
    store.update('pattern', (project) => { project.machine.tracks[0].steps[0] = 1; });
    store.update('pattern', (project) => { project.machine.tracks[0].steps[1] = 1; });

    assert.equal(store.runtime.historyPcmBytes, 16, 'one detached owner is charged once');
    assert.equal(store.undoDepth, 2);
    for (const entry of store._past) {
      assert.deepEqual(Object.keys(entry).sort(), ['assetIds', 'byteLength', 'document']);
      assert.equal(entry.byteLength, 16);
    }
  },

  function noHistoryUpdatesNotifyWithoutChangingUndoOrRedo() {
    // Mutation caught: treating a no-history update as a normal edit and
    // silently erasing the user\'s redo branch.
    const store = new ProjectStore([]);
    store.attachHistory(() => ({ revision: store.revision }), () => {});
    store.update('recorded', () => {});
    store.undo();
    let changes = 0;
    store.addEventListener('change', () => { changes++; });
    store.update('runtime-only', () => {}, { history: 'none' });
    assert.equal(store.revision, 3, 'record, undo, and no-history update each advance revision');
    assert.equal(changes, 1, 'the no-history update emits exactly one change');
    assert.equal(store.canUndo, false, 'no-history update adds no undo entry');
    assert.equal(store.canRedo, true, 'no-history update preserves the redo branch');
  },
];
