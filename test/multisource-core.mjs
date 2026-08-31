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
