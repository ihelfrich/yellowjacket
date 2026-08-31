import assert from 'node:assert/strict';

import * as persist from '../js/app/persist.js';
import * as projectBundle from '../js/app/project-bundle.js';
import * as projectStore from '../js/app/project-store.js';
import { CanonicalPcm } from '../js/app/sample-payload.js';
import { createSourceRecord, VALIDATION_LIMITS } from '../js/app/source-registry.js';
import { reidentifyLoomPlan } from '../js/loom/identity.js';

const LEGACY_FORMAT_VERSION = persist.FORMAT_VERSION;
const rackDefaults = () => [{ id: 'gate', on: false, params: { threshold: -18, release: 0.2 } }];

function copy(value) {
  return structuredClone(value);
}

function pcmBytes(values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

async function shaId(bytes) {
  const view = bytes instanceof Uint8Array
    ? bytes : new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', view.slice());
  return 'sha256:' + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sourceRecord(bytes, sampleRate, index) {
  const id = await shaId(bytes);
  const displayName = `source-${index}.wav`;
  const record = createSourceRecord({
    id,
    displayName,
    aliases: [displayName],
    addedAt: 1788134400000 + index,
    origin: { kind: 'file', url: null },
    payload: { byteLength: bytes.byteLength, mediaType: 'audio/wav', extension: 'wav' },
    audio: { sampleRate, channelCount: index === 1 ? 1 : 2, frames: sampleRate * 2 },
    rights: { basis: 'unknown', license: null, attribution: null, notes: null },
    document: {
      words: [{ text: `stored-${index}`, start: 0, end: 0.01 }],
      transcript: { gapCuts: [false] },
      chain: [{ id: 'gate', on: index === 2, params: { threshold: -20 + index, release: 0.2 } }],
      repairs: [{ id: `repair-${index}`, enabled: true }],
      anchors: { bpm: 100 + index, barOneTime: index / 10 },
    },
  });
  assert.ok(record, 'source fixture is valid');
  return record;
}

async function assetMeta(id, kind, values, sampleRate, extras = {}) {
  const bytes = pcmBytes(values);
  const sha256 = await shaId(bytes);
  const frames = values.length;
  return {
    meta: {
      id, kind, label: kind.toUpperCase(), role: 'PERC', sampleRate,
      channelCount: 1, frames,
      payload: { byteLength: bytes.byteLength, sha256 },
      ...extras,
    },
    bytes,
  };
}

async function v3Fixture() {
  const sourceBytes = [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5, 6, 7), Uint8Array.of(8, 9, 10, 11, 12)];
  const rates = [44100, 48000, 96000];
  const records = [];
  for (let index = 0; index < sourceBytes.length; index++) {
    records.push(await sourceRecord(sourceBytes[index], rates[index], index + 1));
  }

  const project = projectStore.createProject(rackDefaults());
  for (const record of records) project.sources[record.id] = copy(record);
  project.activeSourceId = records[0].id;
  project.fileName = records[0].displayName;
  project.words = [{ text: 'active-only', start: 0, end: 0.01, deleted: false }];
  project.transcript.gapCuts.push(false);
  project.chain[0].on = true;
  project.chain[0].params.threshold = -9;
  const runtime = {
    repairs: [{ id: 'active-repair', enabled: true }],
    assetPcm: new Map(), historyAssetPcm: new Map(),
  };

  let projections = 0;
  const projectActiveFacade = () => {
    projections++;
    project.sources[project.activeSourceId].document = {
      words: copy(project.words),
      transcript: { gapCuts: copy(project.transcript.gapCuts) },
      chain: copy(project.chain),
      repairs: copy(runtime.repairs),
      anchors: copy(project.sources[project.activeSourceId].document.anchors),
    };
  };
  projectActiveFacade();

  for (let index = 0; index < 64; index++) {
    project.clips.push({
      id: `c${index + 1}`,
      sourceId: records[index % records.length].id,
      start: 0,
      end: index === 0 ? 0.01 : 0.02,
      tag: index % 2 ? 'texture' : 'transient',
      label: `clip-${index + 1}`,
      createdAt: null,
      features: { ordinal: index + 1 },
    });
  }
  project.allocators.clip = 64;

  const a1 = await assetMeta('a1', 'sample', Array.from({ length: 441 }, (_, i) => i / 1000), 44100, {
    provenance: {
      kind: 'source-clip', binding: 'project', sourceId: records[0].id, clipId: 'c1',
      sourceSpan: { start: 0, end: 0.01 },
      extraction: {
        startFrame: 0, endFrame: 441, sampleRate: 44100, channelCount: 1, buffer: 'original',
      },
      transforms: [],
    },
  });
  const a2 = await assetMeta('a2', 'synth', [0, 0.25, -0.25], 48000, { formula: 'sin(phase)' });
  const a3 = await assetMeta('a3', 'modal', [0.1, 0.2, 0.3, 0.4], 48000, {
    modes: [{ freqHz: 440, tauSec: 0.4, amp: 0.8, phase: 0, energyFrac: 1 }],
  });
  const a4 = await assetMeta('a4', 'factory-drum', [0.5, -0.5], 96000, {
    factoryKitId: 'factory-kit-v1', factoryVoiceId: 'kick', model: 'kick-v1',
    engineVersion: 1, seed: 7, params: { punch: 0.8 }, oversample: 4,
    metrics: { frames: 2, seconds: 2 / 96000 },
  });
  const assets = [a1, a2, a3, a4];
  for (const asset of assets) {
    project.assets[asset.meta.id] = copy(asset.meta);
    const owner = await CanonicalPcm.fromVerified(asset.meta, asset.bytes);
    assert.ok(owner, 'asset fixture owner is verified');
    runtime.assetPcm.set(asset.meta.id, owner);
  }
  project.allocators.asset = 4;
  project.machine.scenes[0].name = 'OPENING';
  project.machine.scenes[0].bpm = 123;
  project.machine.scenes[0].tracks[0].sampleId = 'a1';
  project.machine.scenes[0].tracks[1].sampleId = 'a2';
  project.machine.scenes[1].tracks[0].sampleId = 'a1';
  project.machine.scenes[1].tracks[2].sampleId = 'a3';
  project.machine.scenes[2].tracks[3].sampleId = 'a4';
  project.machine.scenes[0].tracks[0].steps[0] = 1;
  project.machine.scenes[0].tracks[0].stepData[0] = { velocity: 0.75, future: { x: 1 } };
  project.machine.song.chain.push({ scene: 0, reps: 2 });
  project.machine.space.delayFeedback = 0.5;

  project.studio.touched = true;
  project.studio.bpm = 126;
  project.studio.tracks[0].synth.cutoff = 1800;
  project.studio.tracks[0].steps[0] = { note: 48, chord: 'single', velocity: 0.8, gate: 0.9 };

  const plan = reidentifyLoomPlan({
    source: { sourceId: 'sha256:' + 'f'.repeat(64), online: false },
    events: [{ startSec: 0, durationSec: 0.1, gain: 1 }],
  });
  project.loom.weaveCount = 1;
  project.loom.plans[plan.id] = plan;
  project.loom.activePlanId = plan.id;
  project.loom.plan = plan;
  project.machine.scenes[0].loomLane.planId = plan.id;
  project.wire.inId = 'midi-in';
  project.wire.clockOut = true;
  project.wire.noteBase = 60;
  project.wire.mappings.fill = { kind: 'cc', ch: 0, num: 64 };

  return {
    project, runtime, records, sourceBytes,
    sourcePayloads: new Map(records.map((record, index) => [record.id, sourceBytes[index].slice()])),
    samplePayloads: new Map(assets.map((asset) => [asset.meta.id, asset.bytes.slice()])),
    projections: () => projections,
  };
}

function issueCodes(result) {
  return new Set((result.issues || []).map((issue) => issue.code));
}

function assertIssue(result, code) {
  assert.equal(result.ok, false, `${code} must reject`);
  assert.ok(issueCodes(result).has(code), `${code} must be stable and machine-readable`);
}

const bundleEncoder = new TextEncoder();

function archiveFixture() {
  const sourceIds = [
    'sha256:' + '3'.repeat(64),
    'sha256:' + '1'.repeat(64),
    'sha256:' + '2'.repeat(64),
  ];
  const sampleIds = ['a1', 'a2', 'a10'];
  const sourcePayloads = new Map([
    [sourceIds[0], Uint8Array.of(30, 31)],
    [sourceIds[1], Uint8Array.of(10)],
    [sourceIds[2], Uint8Array.of(20, 21, 22)],
  ]);
  const samplePayloads = new Map([
    ['a1', Uint8Array.of(1, 2, 3, 4)],
    ['a2', Uint8Array.of(5, 6, 7, 8)],
    ['a10', Uint8Array.of(9, 10, 11, 12)],
  ]);
  const assets = {};
  for (const id of sampleIds) {
    assets[id] = {
      id,
      payload: { byteLength: samplePayloads.get(id).byteLength, sha256: 'sha256:' + id.slice(1).padStart(64, '0') },
    };
  }
  const json = {
    formatVersion: 3,
    sources: Object.fromEntries(sourceIds.map((id) => [id, { id }])),
    assets,
    machine: {
      scenes: [
        { tracks: [{ sampleId: 'a10' }, { sampleId: 'a1' }] },
        { tracks: [{ sampleId: 'a2' }, { sampleId: 'a1' }] },
      ],
    },
  };
  const sampleFiles = sampleIds.map((id) => ({
    id,
    bytes: Uint8Array.of(255), // deliberately non-authoritative
    byteLength: assets[id].payload.byteLength,
    sha256: assets[id].payload.sha256,
  }));
  return { json, sourceIds, sampleIds, sourcePayloads, samplePayloads, serialized: { json, sourceIds: sourceIds.slice().sort(), sampleFiles } };
}

function entryMap(entries) {
  return new Map(entries.map(([name, value]) => [name,
    typeof value === 'string' ? bundleEncoder.encode(value) : new Uint8Array(value).slice()]));
}

function zipOffsets(zip) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.byteLength - 22;
  return { view, eocd, central: view.getUint32(eocd + 16, true) };
}

function insertZipBytes(zip, at, inserted) {
  const out = new Uint8Array(zip.byteLength + inserted.byteLength);
  out.set(zip.subarray(0, at));
  out.set(inserted, at);
  out.set(zip.subarray(at), at + inserted.byteLength);
  return out;
}

function zipWithZip64Extra(where) {
  const base = projectBundle.buildBundle([['project.json', '{"formatVersion":2}']], {
    date: new Date(2026, 0, 1),
  });
  const before = zipOffsets(base);
  const extra = Uint8Array.of(0x01, 0x00, 0x00, 0x00);
  if (where === 'local') {
    const nameLen = before.view.getUint16(26, true);
    const out = insertZipBytes(base, 30 + nameLen, extra);
    const { view, eocd } = zipOffsets(out);
    view.setUint16(28, extra.byteLength, true);
    view.setUint32(eocd + 16, before.central + extra.byteLength, true);
    return out;
  }
  const centralNameLen = before.view.getUint16(before.central + 28, true);
  const out = insertZipBytes(base, before.central + 46 + centralNameLen, extra);
  const { view, eocd, central } = zipOffsets(out);
  view.setUint16(central + 30, extra.byteLength, true);
  view.setUint32(eocd + 12, before.view.getUint32(before.eocd + 12, true) + extra.byteLength, true);
  return out;
}

export const projectBundleV3Cases = [
  function exposesInactiveV3ArchiveContractsWithoutSwitchingLiveV2Aliases() {
    assert.equal(typeof projectBundle.projectEntriesV3, 'function');
    assert.equal(typeof projectBundle.expectedProjectEntryNames, 'function');
    assert.equal(typeof projectBundle.assertExactProjectEntrySet, 'function');
    assert.equal(typeof projectBundle.parseProjectEntries, 'function');
    assert.equal(typeof projectBundle.projectEntries, 'function');
    assert.equal(persist.FORMAT_VERSION, 2);
  },

  function writesThreeSourcesAndThreeSamplesInCanonicalOrderFromAuthoritativeMaps() {
    const fixture = archiveFixture();
    const entries = projectBundle.projectEntriesV3(fixture.serialized, fixture);
    assert.deepEqual(entries.map(([name]) => name), [
      'project.json',
      'sources/' + '1'.repeat(64) + '.bin',
      'sources/' + '2'.repeat(64) + '.bin',
      'sources/' + '3'.repeat(64) + '.bin',
      'samples/a1.f32', 'samples/a2.f32', 'samples/a10.f32',
    ]);
    assert.deepEqual(Array.from(entries.at(-1)[1]), [9, 10, 11, 12],
      'samplePayloads, not sampleFiles.bytes, supplies archive bytes');
    fixture.sourcePayloads.get(fixture.sourceIds[1])[0] = 99;
    fixture.samplePayloads.get('a10')[0] = 99;
    assert.deepEqual(Array.from(entries[1][1]), [10], 'writer owns one source-byte snapshot');
    assert.deepEqual(Array.from(entries.at(-1)[1]), [9, 10, 11, 12], 'writer owns one sample-byte snapshot');

    const parsed = projectBundle.parseProjectEntries(projectBundle.readBundle(
      projectBundle.buildBundle(entries, { date: new Date(2026, 0, 1) }),
    ));
    assert.deepEqual(parsed.json, fixture.json);
    assert.deepEqual([...parsed.sourcePayloads.keys()], fixture.sourceIds.slice().sort());
    assert.deepEqual([...parsed.samplePayloads.keys()], ['a1', 'a2', 'a10']);
  },

  function derivesManifestAllowlistAndRejectsEveryMissingExtraOrMismatchedPath() {
    const fixture = archiveFixture();
    const expected = projectBundle.expectedProjectEntryNames(fixture.json);
    assert.deepEqual(expected, [
      'project.json',
      'sources/' + '1'.repeat(64) + '.bin',
      'sources/' + '2'.repeat(64) + '.bin',
      'sources/' + '3'.repeat(64) + '.bin',
      'samples/a1.f32', 'samples/a2.f32', 'samples/a10.f32',
    ]);
    const canonical = entryMap(projectBundle.projectEntriesV3(fixture.serialized, fixture));
    projectBundle.assertExactProjectEntrySet(canonical, expected);
    const invalid = [
      (map) => map.set('source.bin', Uint8Array.of(1)),
      (map) => map.set('notes.txt', Uint8Array.of(1)),
      (map) => map.set('sources/' + '4'.repeat(64) + '.bin', Uint8Array.of(1)),
      (map) => map.set('samples/a3.f32', Uint8Array.of(1)),
      (map) => map.delete(expected[1]),
      (map) => { map.delete('samples/a1.f32'); map.set('samples/a01.f32', Uint8Array.of(1)); },
      (map) => { map.delete('samples/a2.f32'); map.set('samples/a0.f32', Uint8Array.of(1)); },
      (map) => { map.delete(expected[1]); map.set('sources/' + 'A'.repeat(64) + '.bin', Uint8Array.of(1)); },
    ];
    for (const mutate of invalid) {
      const entries = new Map([...canonical].map(([name, bytes]) => [name, bytes.slice()]));
      mutate(entries);
      assert.throws(() => projectBundle.parseProjectEntries(entries), /entry|archive|project/i);
    }
    const unknown = new Map(canonical);
    unknown.set('project.json', bundleEncoder.encode('{"formatVersion":4}'));
    assert.throws(() => projectBundle.parseProjectEntries(unknown), /formatVersion|version/i);
  },

  function requiresExactVanillaPayloadMapsAndExactSerializedSampleIndex() {
    const fixture = archiveFixture();
    const extraSource = new Map(fixture.sourcePayloads);
    extraSource.set('sha256:' + '4'.repeat(64), Uint8Array.of(4));
    assert.throws(() => projectBundle.projectEntriesV3(fixture.serialized, {
      sourcePayloads: extraSource, samplePayloads: fixture.samplePayloads,
    }), /source|key|payload/i);
    const missingSample = new Map(fixture.samplePayloads); missingSample.delete('a2');
    assert.throws(() => projectBundle.projectEntriesV3(fixture.serialized, {
      sourcePayloads: fixture.sourcePayloads, samplePayloads: missingSample,
    }), /sample|key|payload/i);
    let keyCoercions = 0;
    const hostileSourceKey = { toString() { keyCoercions++; throw new Error('source key coerced'); } };
    const wrongSourceKeys = new Map(fixture.sourcePayloads);
    wrongSourceKeys.delete(fixture.sourceIds[0]);
    wrongSourceKeys.set(hostileSourceKey, Uint8Array.of(1));
    assert.throws(() => projectBundle.projectEntriesV3(fixture.serialized, {
      sourcePayloads: wrongSourceKeys, samplePayloads: fixture.samplePayloads,
    }), /source|key|payload/i);
    assert.equal(keyCoercions, 0, 'non-string source keys reject without caller coercion');
    for (const mutate of [
      (serialized) => serialized.sampleFiles.reverse(),
      (serialized) => { serialized.sampleFiles[0].byteLength++; },
      (serialized) => { serialized.sampleFiles[0].sha256 = 'sha256:' + 'f'.repeat(64); },
      (serialized) => { serialized.sampleFiles[0].id = 'a01'; },
    ]) {
      const serialized = copy(fixture.serialized);
      mutate(serialized);
      assert.throws(() => projectBundle.projectEntriesV3(serialized, fixture), /sample|index|metadata|asset/i);
    }
    class MapSubclass extends Map {}
    assert.throws(() => projectBundle.projectEntriesV3(fixture.serialized, {
      sourcePayloads: new MapSubclass(fixture.sourcePayloads), samplePayloads: fixture.samplePayloads,
    }), /Map|payload/i);
    for (const property of ['get', 'keys', 'values', 'forEach', Symbol.iterator]) {
      let calls = 0;
      const shadowed = new Map(fixture.samplePayloads);
      Object.defineProperty(shadowed, property, { value() { calls++; throw new Error('caller dispatch ran'); } });
      assert.throws(() => projectBundle.projectEntriesV3(fixture.serialized, {
        sourcePayloads: fixture.sourcePayloads, samplePayloads: shadowed,
      }), /Map|payload/i, String(property));
      assert.equal(calls, 0, `${String(property)} is rejected without caller dispatch`);
    }
  },

  function preservesOnlyTheExactReachableV2MigrationShapeAndLegacySamplePaths() {
    const json = {
      formatVersion: 2,
      sourceBytes: { size: 3 },
      machine: { scenes: [{ tracks: [
        { sampleId: 'factory-drum-v1-kick' }, { sampleId: 'a9' }, { sampleId: 'factory-drum-v1-kick' },
      ] }] },
    };
    assert.deepEqual(projectBundle.expectedProjectEntryNames(json), [
      'project.json', 'source.bin', 'samples/factory-drum-v1-kick.f32', 'samples/a9.f32',
    ]);
    const entries = entryMap([
      ['samples/a9.f32', Uint8Array.of(9)],
      ['source.bin', Uint8Array.of(1, 2, 3)],
      ['project.json', JSON.stringify(json)],
      ['samples/factory-drum-v1-kick.f32', Uint8Array.of(4, 5)],
    ]);
    const parsed = projectBundle.parseProjectEntries(entries);
    assert.deepEqual(parsed.json, json);
    assert.ok(parsed.source instanceof ArrayBuffer);
    assert.ok(parsed.samples.get('factory-drum-v1-kick') instanceof ArrayBuffer);
    entries.set('samples/unreferenced.f32', Uint8Array.of(0));
    assert.throws(() => projectBundle.parseProjectEntries(entries), /entry|archive|project/i);

    const unsafe = copy(json); unsafe.machine.scenes[0].tracks[0].sampleId = '../private';
    assert.throws(() => projectBundle.expectedProjectEntryNames(unsafe), /sample|unsafe|invalid/i);
    const sourceFree = copy(json); sourceFree.sourceBytes = null;
    assert.equal(projectBundle.expectedProjectEntryNames(sourceFree).includes('source.bin'), false);
  },

  function rejectsOversizeManifestBeforeJsonParseAndCopiesEntryBytesOnce() {
    const originalParse = JSON.parse;
    let parses = 0;
    JSON.parse = (...args) => { parses++; return originalParse(...args); };
    try {
      const tooLarge = new Map([['project.json', new Uint8Array(16 * 1024 * 1024 + 1)]]);
      assert.throws(() => projectBundle.parseProjectEntries(tooLarge), /project\.json|large|16/i);
      assert.equal(parses, 0, 'oversize bytes never reach JSON.parse');
      const exact = new Map([['project.json', new Uint8Array(16 * 1024 * 1024)]]);
      assert.throws(() => projectBundle.parseProjectEntries(exact), /JSON/i);
      assert.equal(parses, 1, 'the inclusive 16 MiB boundary reaches JSON.parse');
    } finally {
      JSON.parse = originalParse;
    }

    const fixture = archiveFixture();
    const entries = entryMap(projectBundle.projectEntriesV3(fixture.serialized, fixture));
    const sourceName = 'sources/' + '1'.repeat(64) + '.bin';
    const sourceInput = entries.get(sourceName);
    const parsed = projectBundle.parseProjectEntries(entries);
    sourceInput[0] = 200;
    entries.clear();
    assert.deepEqual(Array.from(parsed.sourcePayloads.get(fixture.sourceIds[1])), [10]);
    parsed.sourcePayloads.get(fixture.sourceIds[1])[0] = 201;
    assert.notEqual(sourceInput[0], parsed.sourcePayloads.get(fixture.sourceIds[1])[0]);
    class MapSubclass extends Map {}
    assert.throws(() => projectBundle.parseProjectEntries(new MapSubclass()), /Map/i);
    assert.throws(() => projectBundle.parseProjectEntries(new Proxy(new Map(), {})), /Map/i);
  },

  function rejectsZip64SentinelsExtrasAndDirectoryCountDisagreementExplicitly() {
    const base = projectBundle.buildBundle([['project.json', '{"formatVersion":2}']], {
      date: new Date(2026, 0, 1),
    });
    for (const [offset, width] of [[10, 2], [12, 4], [16, 4]]) {
      const zip = base.slice();
      const { view, eocd } = zipOffsets(zip);
      if (width === 2) view.setUint16(eocd + offset, 0xffff, true);
      else view.setUint32(eocd + offset, 0xffffffff, true);
      assert.throws(() => projectBundle.readBundle(zip), /ZIP64/i);
    }
    for (const where of ['local', 'central']) {
      assert.throws(() => projectBundle.readBundle(zipWithZip64Extra(where)), /ZIP64/i, where);
    }
    const disagreement = base.slice();
    const { view, eocd } = zipOffsets(disagreement);
    view.setUint16(eocd + 8, 2, true);
    assert.throws(() => projectBundle.readBundle(disagreement), /count|directory/i);
  },

  function retainsStoreCrcPathFlagHeaderCountAndSizeTransportGates() {
    const make = () => projectBundle.buildBundle([['safe', Uint8Array.of(1, 2, 3)]], {
      date: new Date(2026, 0, 1),
    });
    const corrupt = make();
    corrupt[34] ^= 1;
    assert.throws(() => projectBundle.readBundle(corrupt), /checksum/);

    const traversal = make();
    const t = zipOffsets(traversal);
    traversal.set(bundleEncoder.encode('../x'), 30);
    traversal.set(bundleEncoder.encode('../x'), t.central + 46);
    assert.throws(() => projectBundle.readBundle(traversal), /unsafe/);

    for (const flag of [0x0001, 0x0008]) {
      const zip = make(); const { view, central } = zipOffsets(zip);
      view.setUint16(central + 8, 0x0800 | flag, true);
      assert.throws(() => projectBundle.readBundle(zip), /flags|encrypted|descriptor/i);
    }
    const compressed = make();
    zipOffsets(compressed).view.setUint16(zipOffsets(compressed).central + 10, 8, true);
    assert.throws(() => projectBundle.readBundle(compressed), /compressed/);
    const mismatch = make();
    zipOffsets(mismatch).view.setUint32(zipOffsets(mismatch).central + 16, 0, true);
    assert.throws(() => projectBundle.readBundle(mismatch), /headers disagree/);
    assert.throws(() => projectBundle.buildBundle(
      Array.from({ length: 1025 }, (_, index) => [`e${index}`, new Uint8Array()]),
    ), /too many/);
    const zero = make();
    const zeroLayout = zipOffsets(zero);
    zeroLayout.view.setUint16(zeroLayout.eocd + 8, 0, true);
    zeroLayout.view.setUint16(zeroLayout.eocd + 10, 0, true);
    assert.throws(() => projectBundle.readBundle(zero), /count/);
    const oversized = make();
    const oversizedLayout = zipOffsets(oversized);
    oversizedLayout.view.setUint32(oversizedLayout.central + 20, 512 * 1024 * 1024 + 1, true);
    oversizedLayout.view.setUint32(oversizedLayout.central + 24, 512 * 1024 * 1024 + 1, true);
    assert.throws(() => projectBundle.readBundle(oversized), /too large/);
  },
];

export const projectFormatCases = [
  function keepsV3InactiveBehindExplicitNamedContracts() {
    assert.equal(persist.V3_FORMAT_VERSION, 3);
    assert.equal(LEGACY_FORMAT_VERSION, 2, 'the live writer remains v2 through Task 11');
    assert.equal(typeof persist.snapshotDocV3, 'function');
    assert.equal(typeof persist.serializeProjectV3, 'function');
    assert.equal(typeof persist.validateProjectDocument, 'function');
    assert.equal(typeof persist.preflightProjectPayloads, 'function');
    assert.equal(typeof persist.applySnapshotV3, 'function');
    assert.equal(typeof persist.migrateV2Project, 'function');
    assert.equal(typeof persist.ProjectDataError, 'function');
    const project = projectStore.createProject(rackDefaults());
    assert.equal(persist.serializeProject(project, { repairs: [], sourceBytes: null }).json.formatVersion, 2);
  },

  async function projectsOnceRoundTripsAndAppliesEveryHeldContainerInPlace() {
    const fixture = await v3Fixture();
    const serialized = persist.serializeProjectV3(fixture.project, fixture.runtime, { savedAt: 1788134400999 });
    assert.equal(fixture.projections(), 1, 'serialization performs no hidden facade projection');
    assert.deepEqual(serialized.sourceIds, fixture.records.map((record) => record.id).sort());
    assert.deepEqual(serialized.sampleFiles.map((file) => file.id), ['a1', 'a2', 'a3', 'a4']);
    for (const legacy of ['fileName', 'sourceBytes', 'words', 'transcript', 'chain', 'repairs', 'anchors']) {
      assert.equal(Object.hasOwn(serialized.json, legacy), false, `${legacy} is source-scoped, not duplicated`);
    }
    assert.equal(fixture.project.sources[fixture.project.activeSourceId].document.words[0].text, 'active-only');

    const prepared = await persist.preflightProjectPayloads({
      json: serialized.json,
      sourcePayloads: fixture.sourcePayloads,
      samplePayloads: fixture.samplePayloads,
    });
    const target = projectStore.createProject(rackDefaults());
    for (const record of fixture.records) target.sources[record.id] = copy(record);
    target.activeSourceId = fixture.records[0].id;
    const runtime = { repairs: [], assetPcm: new Map([['old', {}]]), historyAssetPcm: new Map() };
    const refs = {
      project: target, sources: target.sources, source: target.sources[fixture.records[0].id],
      sourceDocument: target.sources[fixture.records[0].id].document,
      machine: target.machine, scenes: target.machine.scenes,
      track: target.machine.scenes[0].tracks[0], steps: target.machine.scenes[0].tracks[0].steps,
      stepData: target.machine.scenes[0].tracks[0].stepData,
      studio: target.studio, studioTrack: target.studio.tracks[0],
      synth: target.studio.tracks[0].synth, studioSteps: target.studio.tracks[0].steps,
      loom: target.loom, plans: target.loom.plans,
      wire: target.wire, mappings: target.wire.mappings,
      clips: target.clips, assets: target.assets, chain: target.chain,
      rack: target.chain[0], params: target.chain[0].params,
      repairs: runtime.repairs, assetPcm: runtime.assetPcm,
    };
    persist.applySnapshotV3(prepared.document, { project: target, runtime, assetPcm: prepared.assetPcm });
    for (const [name, ref] of Object.entries(refs)) {
      const direct = {
        sources: target.sources, machine: target.machine, scenes: target.machine.scenes,
        studio: target.studio, loom: target.loom, plans: target.loom.plans,
        wire: target.wire, mappings: target.wire.mappings,
        clips: target.clips, assets: target.assets, chain: target.chain,
      };
      const actual = name === 'project' ? target
        : name === 'sourceDocument' ? target.sources[fixture.records[0].id].document
          : name === 'source' ? target.sources[fixture.records[0].id]
            : name === 'track' ? target.machine.scenes[0].tracks[0]
              : name === 'steps' ? target.machine.scenes[0].tracks[0].steps
                : name === 'stepData' ? target.machine.scenes[0].tracks[0].stepData
                  : name === 'studioTrack' ? target.studio.tracks[0]
                    : name === 'synth' ? target.studio.tracks[0].synth
                      : name === 'studioSteps' ? target.studio.tracks[0].steps
                        : name === 'rack' ? target.chain[0]
                          : name === 'params' ? target.chain[0].params
                            : name === 'repairs' ? runtime.repairs
                              : name === 'assetPcm' ? runtime.assetPcm : direct[name];
      assert.strictEqual(actual, ref, `${name} identity is preserved`);
    }
    assert.notStrictEqual(target.machine.scenes[0].tracks[0].sample, prepared.assetPcm.get('a1'));
    assert.notStrictEqual(target.machine.scenes[0].tracks[0].sample,
      target.machine.scenes[1].tracks[0].sample, 'shared owners hydrate fresh playback copies');

    const again = persist.serializeProjectV3(target, runtime, { savedAt: serialized.json.savedAt });
    assert.deepEqual(again.json, serialized.json, 'serialize -> preflight -> apply -> serialize is fixed');
    assert.deepEqual(again.sampleFiles.map((file) => file.bytes), serialized.sampleFiles.map((file) => file.bytes));
    assert.equal(projectStore.hasCanonicalProjectState(target), true, 'apply preserves exact project ownership');
    assert.equal(projectStore.allocateProjectId(target, 'clip'), 'c65', 'native apply leaves clip allocation usable');
    assert.equal(projectStore.allocateProjectId(target, 'asset'), 'a5', 'native apply leaves asset allocation usable');
  },

  async function rejectsNoncanonicalProjectionAndApplyTargetsBeforeAnyTrapOrMutation() {
    const fixture = await v3Fixture();
    const serialized = persist.serializeProjectV3(fixture.project, fixture.runtime, { savedAt: 1788134400999 });
    const prepared = await persist.preflightProjectPayloads({
      json: serialized.json, sourcePayloads: fixture.sourcePayloads, samplePayloads: fixture.samplePayloads,
    });
    assert.throws(() => persist.serializeProjectV3({ ...fixture.project }, fixture.runtime), /canonical|project/i);
    assert.throws(() => persist.snapshotDocV3(new Proxy(fixture.project, {}), fixture.runtime), /canonical|project/i);

    for (const kind of ['clips', 'allocators', 'both', 'accessor']) {
      const target = projectStore.createProject(rackDefaults());
      const foreign = projectStore.createProject(rackDefaults());
      let traps = 0;
      if (kind === 'clips' || kind === 'both') target.clips = foreign.clips;
      if (kind === 'allocators' || kind === 'both') target.allocators = foreign.allocators;
      if (kind === 'accessor') {
        const original = target.clips;
        Object.defineProperty(target, 'clips', {
          configurable: true, enumerable: true,
          get() { traps++; return original; },
        });
      }
      const runtime = { repairs: [], assetPcm: new Map([['sentinel', {}]]) };
      const beforeRuntime = [...runtime.assetPcm];
      assert.throws(() => persist.applySnapshotV3(prepared.document, {
        project: target, runtime, assetPcm: prepared.assetPcm,
      }), /canonical|compatible|project/i, kind);
      assert.deepEqual([...runtime.assetPcm], beforeRuntime, `${kind} mutates no owner map`);
      if (kind === 'accessor') assert.equal(traps, 0, 'canonical ownership rejects before hostile getter access');
    }
  },

  async function rejectsFrozenOwnedContainersBeforeAnyDocumentOrOwnerMutation() {
    const fixture = await v3Fixture();
    const serialized = persist.serializeProjectV3(fixture.project, fixture.runtime, { savedAt: 1788134400999 });
    const prepared = await persist.preflightProjectPayloads({
      json: serialized.json, sourcePayloads: fixture.sourcePayloads, samplePayloads: fixture.samplePayloads,
    });
    for (const freeze of ['clips', 'clipCounter', 'assetCounter']) {
      const target = projectStore.createProject(rackDefaults());
      target.fileName = 'UNCHANGED';
      target.words = [{ text: 'unchanged' }];
      if (freeze === 'clips') Object.freeze(target.clips);
      else Object.defineProperty(target.allocators, freeze === 'clipCounter' ? 'clip' : 'asset', {
        value: 0, writable: false, enumerable: true, configurable: true,
      });
      const runtime = { repairs: [{ id: 'unchanged' }], assetPcm: new Map([['sentinel', {}]]) };
      const before = {
        fileName: target.fileName, words: copy(target.words), sources: copy(target.sources),
        machine: copy(target.machine), studio: copy(target.studio), loom: copy(target.loom), wire: copy(target.wire),
        repairs: copy(runtime.repairs), owners: [...runtime.assetPcm],
      };
      assert.throws(() => persist.applySnapshotV3(prepared.document, {
        project: target, runtime, assetPcm: prepared.assetPcm,
      }), /compatible|writable|project/i, freeze);
      assert.deepEqual({
        fileName: target.fileName, words: target.words, sources: target.sources,
        machine: target.machine, studio: target.studio, loom: target.loom, wire: target.wire,
        repairs: runtime.repairs, owners: [...runtime.assetPcm],
      }, before, `${freeze} rejects atomically`);
    }

    const lateTarget = projectStore.createProject(rackDefaults());
    const lateRuntime = { repairs: [], assetPcm: new Map() };
    persist.applySnapshotV3(prepared.document, {
      project: lateTarget, runtime: lateRuntime, assetPcm: prepared.assetPcm,
    });
    const activeId = lateTarget.activeSourceId;
    lateTarget.sources[activeId].displayName = 'UNCHANGED.wav';
    lateTarget.fileName = 'UNCHANGED.wav';
    Object.freeze(lateTarget.assets.a1);
    const beforeOwners = [...lateRuntime.assetPcm];
    assert.throws(() => persist.applySnapshotV3(prepared.document, {
      project: lateTarget, runtime: lateRuntime, assetPcm: prepared.assetPcm,
    }), /compatible|writable|project/i, 'late asset metadata');
    assert.equal(lateTarget.sources[activeId].displayName, 'UNCHANGED.wav');
    assert.equal(lateTarget.fileName, 'UNCHANGED.wav');
    assert.deepEqual([...lateRuntime.assetPcm], beforeOwners);
  },

  async function validatesGraphGrammarCanonicalityAndSafeArithmetic() {
    const fixture = await v3Fixture();
    const base = persist.serializeProjectV3(fixture.project, fixture.runtime, { savedAt: 1788134400999 }).json;
    assert.deepEqual(persist.validateProjectDocument(base), { ok: true });
    const cases = [
      ['ACTIVE_SOURCE', (json) => { json.activeSourceId = null; }],
      ['CLIP_DUPLICATE', (json) => { json.clips.push(copy(json.clips[0])); }],
      ['ALLOCATOR_STALE', (json) => { json.allocators.clip = 1; }],
      ['CLIP_SOURCE', (json) => { json.clips[0].sourceId = 'sha256:' + 'e'.repeat(64); }],
      ['SOURCE_RECORD', (json) => { json.sources[json.activeSourceId].addedAt = null; }],
      ['ASSET_OWNERSHIP', (json) => {
        for (const scene of json.machine.scenes) {
          for (const track of scene.tracks) if (track.sampleId === 'a1') track.sampleId = null;
        }
      }],
      ['ASSET_SHAPE', (json) => { json.assets.a2.frames = Number.MAX_SAFE_INTEGER; }],
      ['PROVENANCE', (json) => { json.assets.a1.provenance.sourceId = json.activeSourceId.replace(/.$/, '0'); }],
      ['LOOM', (json) => { json.loom.plans[json.loom.activePlanId].id = 'stale'; }],
      ['WIRE', (json) => { json.wire.noteBase = 120; }],
      ['ASSET_SHAPE', (json) => { json.assets.a2.unknownFreight = true; }],
    ];
    for (const [code, mutate] of cases) {
      const json = copy(base);
      mutate(json);
      assertIssue(persist.validateProjectDocument(json), code);
    }

    const clipOverflow = copy(base);
    clipOverflow.clips = Array.from({ length: VALIDATION_LIMITS.clips + 1 }, (_, index) => ({
      ...copy(base.clips[0]), id: `c${index + 1}`,
    }));
    clipOverflow.allocators.clip = clipOverflow.clips.length;
    assertIssue(persist.validateProjectDocument(clipOverflow), 'CLIP_LIMIT');

    let getterReads = 0;
    const getter = copy(base);
    Object.defineProperty(getter, 'savedAt', { enumerable: true, get() { getterReads++; return 1; } });
    assertIssue(persist.validateProjectDocument(getter), 'JSON_SHAPE');
    assert.equal(getterReads, 0, 'accessors are rejected without invocation');
    assertIssue(persist.validateProjectDocument(new Proxy(base, {})), 'JSON_SHAPE');
    const nonFinite = copy(base); nonFinite.machine.scenes[0].bpm = NaN;
    assertIssue(persist.validateProjectDocument(nonFinite), 'JSON_SHAPE');
  },

  async function preflightsExactOwnedPayloadsAndRejectsBeforeLiveMutation() {
    const fixture = await v3Fixture();
    const json = persist.serializeProjectV3(fixture.project, fixture.runtime, { savedAt: 1788134400999 }).json;
    const prepared = await persist.preflightProjectPayloads({
      json, sourcePayloads: fixture.sourcePayloads, samplePayloads: fixture.samplePayloads,
    });
    json.savedAt = 1;
    fixture.sourcePayloads.values().next().value[0] ^= 0xff;
    fixture.samplePayloads.get('a1')[0] ^= 0xff;
    assert.equal(prepared.document.savedAt, 1788134400999, 'document is detached once');
    assert.notDeepEqual(prepared.sourcePayloads.values().next().value,
      fixture.sourcePayloads.values().next().value, 'source bytes are owned');
    assert.notDeepEqual(prepared.samplePayloads.get('a1'), fixture.samplePayloads.get('a1'), 'sample bytes are owned');

    const intrinsic = await v3Fixture();
    const intrinsicJson = persist.serializeProjectV3(intrinsic.project, intrinsic.runtime, {
      savedAt: 1788134400999,
    }).json;
    let hostileReads = 0;
    for (const payloads of [intrinsic.sourcePayloads, intrinsic.samplePayloads]) {
      Object.defineProperty(payloads, 'get', {
        configurable: true,
        get() { hostileReads++; throw new Error('hostile Map method ran'); },
      });
    }
    await persist.preflightProjectPayloads({
      json: intrinsicJson,
      sourcePayloads: intrinsic.sourcePayloads,
      samplePayloads: intrinsic.samplePayloads,
    });
    assert.equal(hostileReads, 0, 'payload Maps are copied intrinsically once before validation awaits');

    const missing = new Map(prepared.sourcePayloads); missing.delete(prepared.document.activeSourceId);
    await assert.rejects(
      persist.preflightProjectPayloads({ json: prepared.document, sourcePayloads: missing, samplePayloads: prepared.samplePayloads }),
      (error) => error instanceof persist.ProjectDataError && error.code === 'SOURCE_OWNERSHIP'
        && error.kind === 'source',
    );
    const badDigest = new Map([...prepared.sourcePayloads].map(([id, bytes]) => [id, bytes.slice()]));
    const sourceId = prepared.document.activeSourceId;
    badDigest.get(sourceId)[0] ^= 1;
    await assert.rejects(
      persist.preflightProjectPayloads({ json: prepared.document, sourcePayloads: badDigest, samplePayloads: prepared.samplePayloads }),
      (error) => error instanceof persist.ProjectDataError && error.code === 'SOURCE_DIGEST' && error.id === sourceId,
    );
    const badSample = new Map([...prepared.samplePayloads].map(([id, bytes]) => [id, bytes.slice()]));
    badSample.get('a1')[0] ^= 1;
    await assert.rejects(
      persist.preflightProjectPayloads({ json: prepared.document, sourcePayloads: prepared.sourcePayloads, samplePayloads: badSample }),
      (error) => error instanceof persist.ProjectDataError && error.code === 'SAMPLE_DIGEST' && error.id === 'a1',
    );

    for (const version of [2, 4]) {
      const target = projectStore.createProject(rackDefaults());
      const before = persist.serializeProject(target, { repairs: [], sourceBytes: null }).json;
      assert.throws(() => persist.applySnapshotV3({ ...prepared.document, formatVersion: version }, {
        project: target, runtime: { repairs: [], assetPcm: new Map() }, assetPcm: prepared.assetPcm,
      }), (error) => error instanceof persist.FormatVersionError && error.expectedVersion === 3);
      assert.deepEqual(persist.serializeProject(target, { repairs: [], sourceBytes: null }).json.machine, before.machine);
    }
  },

  async function rejectsForgedOrPartiallyInvalidFixedIdOwnersWithoutMutation() {
    const hostile = await v3Fixture();
    let reads = 0;
    const priorLabel = hostile.project.assets.a1.label;
    Object.defineProperty(hostile.project.assets.a1, 'label', {
      enumerable: true, configurable: true,
      get() { reads++; return priorLabel; },
    });
    await assert.rejects(
      projectStore.adoptVerifiedAssetPcmOwners(hostile.project, hostile.runtime.assetPcm),
      /invalid|compatible/i,
    );
    assert.equal(reads, 0, 'adoption rejects asset accessors without invoking them');

    const fixture = await v3Fixture();
    const beforeMap = fixture.runtime.assetPcm;
    const beforeEntries = [...beforeMap];
    const beforeSamples = fixture.project.machine.scenes.flatMap((scene) => scene.tracks.map((track) => track.sample));
    await projectStore.adoptVerifiedAssetPcmOwners(fixture.project, fixture.runtime.assetPcm);
    const real = fixture.runtime.assetPcm.get('a2');
    const forged = Object.create(Object.getPrototypeOf(real));
    assert.equal(forged instanceof CanonicalPcm, true, 'the attack defeats instanceof-only authentication');
    const owners = new Map(fixture.runtime.assetPcm);
    owners.set('a2', forged);
    assert.throws(() => projectStore.installVerifiedAssetPcm(fixture.project, fixture.runtime, owners));
    assert.strictEqual(fixture.runtime.assetPcm, beforeMap, 'map identity is retained on failure');
    assert.deepEqual([...fixture.runtime.assetPcm], beforeEntries, 'one bad owner installs no partial set');
    assert.deepEqual(fixture.project.machine.scenes.flatMap((scene) => scene.tracks.map((track) => track.sample)),
      beforeSamples, 'owner failure hydrates no track');
  },

  function detectsContentAcrossEveryV3SurfaceWithoutCountingDefaults() {
    const blank = projectStore.createProject(rackDefaults());
    const runtime = { repairs: [], assetPcm: new Map() };
    assert.equal(persist.projectHasContent(blank, runtime), false);
    const mutations = [
      (p) => { p.sources['sha256:' + 'a'.repeat(64)] = {}; p.activeSourceId = 'sha256:' + 'a'.repeat(64); },
      (p) => { p.clips.push({ id: 'c1' }); },
      (p) => { p.assets.a1 = { id: 'a1' }; },
      (p) => { p.machine.scenes[0].name = 'EDITED'; },
      (p) => { p.studio.touched = true; },
      (p) => { p.loom.weaveCount = 1; },
      (p) => { p.wire.noteBase = 61; },
    ];
    for (const mutate of mutations) {
      const project = projectStore.createProject(rackDefaults());
      mutate(project);
      assert.equal(persist.projectHasContent(project, runtime), true);
    }
  },

  async function guardsOpfsProjectJsonBeforeParsing() {
    class BytesStore extends persist.OpfsStore {
      constructor(bytes) { super({}, {}); this.bytes = bytes; }
      async readBytes() { return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength); }
    }
    const exact = new Uint8Array(VALIDATION_LIMITS.projectJsonBytes).fill(0x20);
    exact[0] = 0x7b; exact[exact.length - 1] = 0x7d;
    assert.deepEqual(await new BytesStore(exact).readJson('project.json'), {});
    const over = new Uint8Array(VALIDATION_LIMITS.projectJsonBytes + 1).fill(0x20);
    over[0] = 0x7b; over[over.length - 1] = 0x7d;
    const original = JSON.parse;
    let parses = 0;
    JSON.parse = (...args) => { parses++; return original(...args); };
    try {
      await assert.rejects(new BytesStore(over).readJson('project.json'),
        (error) => error instanceof persist.ProjectDataError && error.code === 'PROJECT_JSON_TOO_LARGE');
      assert.equal(parses, 0, 'one byte over rejects before JSON.parse');
    } finally {
      JSON.parse = original;
    }
  },

  async function returnsStableIssuesForMalformedProvenanceGraphs() {
    const fixture = await v3Fixture();
    const json = persist.serializeProjectV3(fixture.project, fixture.runtime, {
      savedAt: 1788134400999,
    }).json;
    json.clips = {};
    let result;
    assert.doesNotThrow(() => { result = persist.validateProjectDocument(json); });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === 'CLIP_ID'));
    assert.ok(result.issues.some((issue) => issue.code === 'PROVENANCE'));
  },

  async function returnsStableIssuesForMalformedReferencedSources() {
    const fixture = await v3Fixture();
    const base = persist.serializeProjectV3(fixture.project, fixture.runtime, {
      savedAt: 1788134400999,
    }).json;
    const thrown = [];
    for (const [name, malformed] of [
      ['empty object', {}],
      ['array', []],
      ['null audio', { audio: null }],
    ]) {
      const json = copy(base);
      json.sources[json.activeSourceId] = malformed;
      let result;
      try {
        result = persist.validateProjectDocument(json);
      } catch (error) {
        thrown.push([name, error && error.message]);
        continue;
      }
      assert.equal(result.ok, false, name);
      assert.ok(result.issues.some((issue) => issue.code === 'SOURCE_RECORD'), name);
      assert.ok(result.issues.some((issue) => issue.code === 'PROVENANCE'), name);
    }
    assert.deepEqual(thrown, [], 'malformed referenced sources never throw');
  },

  async function acceptsUnknownCoreOnlyAssetKindsWithoutFreight() {
    const fixture = await v3Fixture();
    const json = persist.serializeProjectV3(fixture.project, fixture.runtime, {
      savedAt: 1788134400999,
    }).json;
    json.assets.a2.kind = 'custom-model-v1';
    delete json.assets.a2.formula;
    assert.deepEqual(persist.validateProjectDocument(json), { ok: true });

    const freight = copy(json);
    freight.assets.a2.hiddenModel = { weights: [1, 2, 3] };
    assertIssue(persist.validateProjectDocument(freight), 'ASSET_SHAPE');
    const pcm = copy(json);
    pcm.assets.a2.pcm = [0, 1];
    assertIssue(persist.validateProjectDocument(pcm), 'ASSET_SHAPE');
  },

  function rejectsPoisonedHeldStepArraysBeforeAnyApplyMutation() {
    const source = projectStore.createProject(rackDefaults());
    source.machine.scenes[0].name = 'NEW';
    const json = persist.serializeProjectV3(source, { assetPcm: new Map() }, {
      savedAt: 1788134400999,
    }).json;
    const target = projectStore.createProject(rackDefaults());
    target.machine.scenes[0].name = 'OLD';
    const steps = target.machine.scenes[0].tracks[0].steps;
    let poisonCalls = 0;
    Object.defineProperty(steps, 'set', {
      configurable: true,
      value() { poisonCalls++; throw new Error('poisoned steps.set'); },
    });
    const runtime = { repairs: [], assetPcm: new Map() };
    assert.throws(() => persist.applySnapshotV3(json, {
      project: target, runtime, assetPcm: new Map(),
    }));
    assert.equal(poisonCalls, 0, 'prevalidation never invokes the poisoned method');
    assert.equal(target.machine.scenes[0].name, 'OLD');
    assert.deepEqual([...runtime.assetPcm], []);
  },
];

async function legacyFixture({ withSource }) {
  const project = projectStore.createProject(rackDefaults());
  project.fileName = withSource ? null : 'source-free';
  if (withSource) {
    project.words = [{ text: 'legacy', start: 0, end: 0.2 }];
    project.transcript.gapCuts.push(false);
    project.clips.push(
      { id: 'h1', start: 0, end: 0.01, tag: 'one', label: 'first' },
      { id: 'c9', start: 0.02, end: 0.03, tag: 'two', label: 'second' },
    );
  }
  project.assets.a9 = { id: 'a9', kind: 'sample', label: 'KEEP', sampleRate: 44100, frames: 2 };
  project.assets['factory-drum-v1-kick'] = {
    id: 'factory-drum-v1-kick', kind: 'factory-drum', label: 'FACTORY', sampleRate: 48000, frames: 2,
    factoryKitId: 'factory-kit-v1', factoryVoiceId: 'kick', model: 'kick-v1', engineVersion: 1,
    seed: 1, params: { punch: 0.5 }, oversample: 4,
  };
  project.assets.a99 = { id: 'a99', kind: 'sample', label: 'PRUNED', sampleRate: 44100, frames: 1 };
  project.machine.scenes[0].tracks[0].sampleId = 'a9';
  project.machine.scenes[0].tracks[0].sample = { channels: [Float32Array.of(0.1, -0.1)], sampleRate: 44100 };
  project.machine.scenes[1].tracks[1].sampleId = 'factory-drum-v1-kick';
  project.machine.scenes[1].tracks[1].sample = { channels: [Float32Array.of(0.2, -0.2)], sampleRate: 48000 };
  project.studio.touched = true;
  project.wire.noteBase = 61;
  const runtime = {
    repairs: withSource ? [{ id: 'legacy-repair' }] : [], analysis: { anchors: { bpm: 99, barOneTime: 0.1 } },
    sourceBytes: withSource ? Uint8Array.of(3, 1, 4, 1, 5).buffer : null,
  };
  const serialized = persist.serializeProject(project, runtime);
  serialized.json.savedAt = 1788134400123;
  return {
    json: serialized.json,
    sourceBytes: withSource ? new Uint8Array(runtime.sourceBytes) : null,
    samplePayloads: new Map(serialized.sampleFiles.map((file) => [file.id, new Uint8Array(file.bytes)])),
  };
}

export const migrationCases = [
  async function migratesSourceBackedV2DeterministicallyAndRemapsFactoryIds() {
    const legacy = await legacyFixture({ withSource: true });
    const beforeJson = copy(legacy.json);
    const beforeSource = legacy.sourceBytes.slice();
    const beforeSamples = new Map([...legacy.samplePayloads].map(([id, bytes]) => [id, bytes.slice()]));
    let decodes = 0;
    const migrated = await persist.migrateV2Project({
      ...legacy,
      decode: async (buffer) => {
        decodes++;
        assert.notStrictEqual(buffer, legacy.sourceBytes.buffer, 'decode receives a detached exact copy');
        return {
          buffer: { sampleRate: 44100, numberOfChannels: 1, length: 88200 },
          mono: new Float32Array(88200), decodeReport: { actualSampleRate: 44100 },
        };
      },
    });
    assert.equal(decodes, 1);
    assert.equal(migrated.migratedFrom, 2);
    const sourceId = await shaId(legacy.sourceBytes);
    assert.deepEqual(migrated.document.clips.map((clip) => [clip.id, clip.sourceId, clip.createdAt]), [
      ['c1', sourceId, null], ['c2', sourceId, null],
    ]);
    assert.equal(migrated.document.allocators.clip, 2);
    assert.equal(migrated.document.allocators.asset, 100, 'pruned a99 remains in the high-water calculation');
    assert.deepEqual(Object.keys(migrated.document.assets), ['a9', 'a100']);
    assert.equal(migrated.document.machine.scenes[1].tracks[1].sampleId, 'a100');
    assert.equal(Object.values(migrated.document.assets).some((asset) => asset.provenance), false,
      'migration never invents provenance');
    const target = projectStore.createProject(rackDefaults());
    const runtime = { repairs: [], assetPcm: new Map() };
    persist.applySnapshotV3(migrated.document, { project: target, runtime, assetPcm: migrated.assetPcm });
    assert.equal(projectStore.allocateProjectId(target, 'clip'), 'c3');
    assert.equal(projectStore.allocateProjectId(target, 'asset'), 'a101');
    persist.applySnapshotV3(migrated.document, { project: target, runtime, assetPcm: migrated.assetPcm });
    assert.equal(projectStore.allocateProjectId(target, 'clip'), 'c3', 'reapply retains migrated clip high-water');
    assert.equal(projectStore.allocateProjectId(target, 'asset'), 'a101', 'reapply retains remapped asset high-water');
    assert.deepEqual(legacy.json, beforeJson); assert.deepEqual(legacy.sourceBytes, beforeSource);
    assert.deepEqual(legacy.samplePayloads, beforeSamples, 'migration never aliases or overwrites v2 payloads');
  },

  async function migratesSourceFreeV2WithoutFabricatingSourceOrCallingDecode() {
    const legacy = await legacyFixture({ withSource: false });
    let decodes = 0;
    const migrated = await persist.migrateV2Project({
      ...legacy,
      decode: async () => { decodes++; throw new Error('must not decode'); },
    });
    assert.equal(decodes, 0);
    assert.deepEqual(migrated.document.sources, {});
    assert.equal(migrated.document.activeSourceId, null);
    assert.equal(migrated.decodedActive, null);
    assert.equal(migrated.document.studio.touched, true);
    assert.equal(migrated.document.wire.noteBase, 61);
    assert.deepEqual(Object.keys(migrated.document.assets), ['a9', 'a100']);
  },

  async function rejectsInvalidV2EnvelopeAndSourceFreeClipsBeforeDecode() {
    const backed = await legacyFixture({ withSource: true });
    let decodes = 0;
    const missing = new Map(backed.samplePayloads); missing.delete('a9');
    await assert.rejects(persist.migrateV2Project({
      ...backed, samplePayloads: missing,
      decode: async () => { decodes++; return null; },
    }), (error) => error instanceof persist.ProjectDataError && error.kind === 'migration');
    assert.equal(decodes, 0, 'cheap envelope/payload faults precede decode');

    const sourceFree = await legacyFixture({ withSource: false });
    sourceFree.json.clips = [{ id: 'h1', start: 0, end: 1 }];
    await assert.rejects(persist.migrateV2Project({
      ...sourceFree,
      decode: async () => { decodes++; return null; },
    }), (error) => error instanceof persist.ProjectDataError && error.code === 'MIGRATION_SOURCELESS_CLIP');
    assert.equal(decodes, 0);
  },

  async function snapshotsDecodeBeforeTheFirstMigrationYield() {
    const legacy = await legacyFixture({ withSource: true });
    let reads = 0;
    let firstCalls = 0;
    let replacementCalls = 0;
    const request = {
      json: legacy.json,
      sourceBytes: legacy.sourceBytes,
      samplePayloads: legacy.samplePayloads,
    };
    Object.defineProperty(request, 'decode', {
      enumerable: true,
      get() {
        reads++;
        if (reads === 1) return async () => {
          firstCalls++;
          return {
            buffer: { sampleRate: 44100, numberOfChannels: 1, length: 88200 },
            mono: new Float32Array(88200), decodeReport: { actualSampleRate: 44100 },
          };
        };
        return async () => { replacementCalls++; throw new Error('late decode replacement ran'); };
      },
    });
    const migrated = await persist.migrateV2Project(request);
    assert.equal(migrated.document.formatVersion, persist.V3_FORMAT_VERSION);
    assert.equal(reads, 1, 'migration reads the injected boundary once before awaiting');
    assert.equal(firstCalls, 1);
    assert.equal(replacementCalls, 0);
  },

  async function canonicalizesLegacyPcmLittleEndianAndFallsBackFromInvalidFileNames() {
    const invalidNames = ['../private/source.wav', 'x'.repeat(256), '\u0000source.wav'];
    for (const invalidName of invalidNames) {
      const legacy = await legacyFixture({ withSource: true });
      legacy.json.fileName = invalidName;
      const migrated = await persist.migrateV2Project({
        ...legacy,
        decode: async () => ({
          buffer: { sampleRate: 44100, numberOfChannels: 1, length: 88200 },
          mono: new Float32Array(88200), decodeReport: { actualSampleRate: 44100 },
        }),
      });
      const source = migrated.document.sources[migrated.document.activeSourceId];
      assert.equal(source.displayName, 'source.bin');
      assert.deepEqual(source.aliases, ['source.bin']);
    }

    const legacy = await legacyFixture({ withSource: false });
    const migrated = await persist.migrateV2Project({
      ...legacy,
      decode: async () => { throw new Error('source-free migration must not decode'); },
    });
    const bytes = migrated.samplePayloads.get('a9');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(view.getFloat32(0, true), Math.fround(0.1));
    assert.equal(view.getFloat32(4, true), Math.fround(-0.1));
    assert.equal(migrated.document.assets.a9.payload.sha256, await shaId(bytes));
  },
];
