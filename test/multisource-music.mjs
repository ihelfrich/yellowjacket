import assert from 'node:assert/strict';

import {
  clipReferences,
  clipsForSource,
  createClipRef,
  extractClipAsset,
  planAssetReachability,
  planGeneratedClipReplacement,
  prepareClipAsset,
  prepareHarvestRun,
  replaceClipBounds,
  wordsToClip,
} from '../js/machine/cliprefs.js';
import { CrateStore, prepareCrateAsset } from '../js/app/crate.js';
import { validateAssetProvenance } from '../js/app/sample-payload.js';
import {
  createProject,
  registerPreparedAsset,
  resolveTrackSamples,
} from '../js/app/project-store.js';

const sourceId = (digit) => 'sha256:' + digit.repeat(64);

function projectWithSources(specs = [
  { id: sourceId('a'), sampleRate: 48000, channelCount: 2, frames: 48000 * 40 },
]) {
  const project = createProject([]);
  for (const spec of specs) {
    project.sources[spec.id] = {
      id: spec.id,
      displayName: spec.displayName || spec.id.slice(0, 12),
      audio: {
        sampleRate: spec.sampleRate,
        channelCount: spec.channelCount,
        frames: spec.frames,
      },
    };
  }
  project.activeSourceId = specs.length ? specs[0].id : null;
  return project;
}

function decodedBuffer(channels, sampleRate) {
  const buffer = new AudioBuffer({
    length: channels[0].length,
    numberOfChannels: channels.length,
    sampleRate,
  });
  channels.forEach((channel, index) => buffer.getChannelData(index).set(channel));
  return { buffer, mono: channels[0].slice(), decodeReport: { actualSampleRate: sampleRate } };
}

function pcmBytes(values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

function close(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} +/- ${tolerance}, received ${actual}`);
}

class MemoryCrate extends CrateStore {
  constructor() {
    super({}, {});
    this.index = { maxId: 0, items: [] };
    this.files = new Map();
  }

  async _readIndex() {
    return structuredClone(this.index);
  }

  async _writeJson(name, value) {
    assert.equal(name, 'index.json');
    this.index = structuredClone(value);
  }

  async _writeBytes(name, value) {
    const bytes = value instanceof Uint8Array
      ? value.slice()
      : new Uint8Array(value.buffer || value, value.byteOffset || 0, value.byteLength).slice();
    this.files.set(name, bytes);
  }

  async _readBytes(name) {
    const bytes = this.files.get(name);
    return bytes ? bytes.slice().buffer : null;
  }

  async _removeFile(name) {
    this.files.delete(name);
  }

  installLegacy(meta, values) {
    this.index = { maxId: Number(meta.id.slice(1)), items: [structuredClone(meta)] };
    this.files.set(meta.id + '.f32', pcmBytes(values));
  }
}

export const clipIdentityCases = [
  async function usesOneGlobalMonotoneAllocatorForManualHarvestAndReplacement() {
    // Mutation caught: source-local/hN allocation, suffix reuse, append-only replacement, or wrong slot.
    const a = sourceId('a');
    const project = projectWithSources([{ id: a, sampleRate: 100, channelCount: 2, frames: 1000 }]);
    project.allocators.clip = 7;
    project.clips.push({ id: 'c7', sourceId: a, start: 0, end: 0.1, label: 'deleted' });
    project.clips.splice(0, 1);

    const manual = createClipRef(project, { sourceId: a, start: 0, end: 0.2, label: 'manual' });
    assert.equal(manual.id, 'c8');
    const decoded = decodedBuffer([new Float32Array(1000), new Float32Array(1000)], 100);
    const run = await prepareHarvestRun(project, decoded, [
      { t0: 1, t1: 1.2, role: 'kick', label: 'kick 1', score: 0.8 },
      { t0: 2, t1: 2.2, role: 'snare', label: 'snare 1', score: 0.7 },
    ], { sourceId: a, runId: 'run-2', buffer: 'original', level: false });
    assert.deepEqual(run.clips.map((clip) => clip.id), ['c9', 'c10']);
    assert.equal(run.preparedAssets.length, 2);
    const slot = project.clips.indexOf(manual);
    const result = replaceClipBounds(project, manual.id, { start: 0.01, end: 0.21 });
    assert.equal(result.kind, 'replaced');
    assert.equal(result.clip.id, 'c11');
    assert.equal(project.clips[slot], result.clip, 'replacement occupies the original Atlas slot');
    assert.deepEqual(project.clips.map((clip) => clip.id), ['c11', 'c9', 'c10']);
    assert.equal(project.allocators.clip, 11);
    assert.equal(project.clips.some((clip) => /^h\d+$/.test(clip.id)), false);
  },

  function rejectsEveryInvalidCreationBeforeAllocationOrAtlasMutation() {
    // Mutation caught: allocating before source/span validation or silently using activeSourceId.
    const a = sourceId('a');
    const project = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    const atlas = project.clips;
    for (const input of [
      { start: 0, end: 1 },
      { sourceId: sourceId('b'), start: 0, end: 1 },
      { sourceId: a, start: -1, end: 1 },
      { sourceId: a, start: -0, end: 1 },
      { sourceId: a, start: 1, end: 1 },
      { sourceId: a, start: 0, end: Infinity },
    ]) {
      assert.throws(() => createClipRef(project, input));
      assert.equal(project.allocators.clip, 0);
      assert.strictEqual(project.clips, atlas);
      assert.deepEqual(project.clips, []);
    }
    const frozen = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    Object.freeze(frozen.clips);
    assert.throws(() => createClipRef(frozen, { sourceId: a, start: 0, end: 1 }));
    assert.equal(frozen.allocators.clip, 0, 'an Atlas that cannot append fails before allocation');
  },

  function finalizesAnnotationsOnceAndNeverBurnsAnIdOnAppendFailure() {
    // Mutation caught: validating a caller annotation once, then serializing it again after allocation.
    const a = sourceId('a');
    const project = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    let snapshots = 0;
    const features = {
      toJSON() {
        snapshots++;
        if (snapshots > 1) throw new Error('serialized twice');
        return [1, 2, 3];
      },
    };
    const clip = createClipRef(project, { sourceId: a, start: 0, end: 1, features });
    assert.equal(snapshots, 1);
    assert.deepEqual(clip.features, [1, 2, 3]);
    assert.equal(clip.id, 'c1');

    const blocked = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    Object.defineProperty(blocked.clips, 'length', { writable: false });
    assert.throws(() => createClipRef(blocked, { sourceId: a, start: 0, end: 1 }));
    assert.equal(blocked.allocators.clip, 0, 'non-writable length cannot burn c1');
    assert.deepEqual(Array.from(blocked.clips), []);
  },

  function requiresCanonicalMatchingSourceRecordsAndBoundedCreationDates() {
    // Mutation caught: treating any object under any source key as a known source, or accepting invalid Date values.
    const canonical = sourceId('a');
    const noncanonical = projectWithSources([{ id: 'source-a', sampleRate: 10, channelCount: 1, frames: 100 }]);
    assert.throws(() => createClipRef(noncanonical, { sourceId: 'source-a', start: 0, end: 1 }));
    assert.equal(noncanonical.allocators.clip, 0);

    const mismatched = projectWithSources([{ id: canonical, sampleRate: 10, channelCount: 1, frames: 100 }]);
    mismatched.sources[canonical].id = sourceId('b');
    assert.throws(() => createClipRef(mismatched, { sourceId: canonical, start: 0, end: 1 }));
    assert.equal(mismatched.allocators.clip, 0);

    const dates = projectWithSources([{ id: canonical, sampleRate: 10, channelCount: 1, frames: 100 }]);
    for (const createdAt of [8640000000000001, -8640000000000001]) {
      assert.throws(() => createClipRef(dates, { sourceId: canonical, start: 0, end: 1, createdAt }));
      assert.equal(dates.allocators.clip, 0);
    }
    assert.equal(createClipRef(dates, {
      sourceId: canonical, start: 0, end: 1, createdAt: null,
    }).createdAt, null);
  },

  function requiresAPlainSourceRecordWithAnOwnDataIdBeforeAllocation() {
    // Mutation caught: accepting an inherited/accessor ID which disappears or
    // changes when the source record crosses the JSON project boundary.
    const a = sourceId('a');
    const inherited = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    inherited.sources[a] = Object.assign(Object.create({ id: a }), {
      audio: { sampleRate: 10, channelCount: 1, frames: 100 },
    });
    assert.throws(() => createClipRef(inherited, { sourceId: a, start: 0, end: 1 }), /source/i);
    assert.equal(inherited.allocators.clip, 0);
    assert.deepEqual(inherited.clips, []);

    const accessor = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    let idReads = 0;
    const source = { audio: { sampleRate: 10, channelCount: 1, frames: 100 } };
    Object.defineProperty(source, 'id', {
      enumerable: true,
      get() {
        idReads++;
        return a;
      },
    });
    accessor.sources[a] = source;
    assert.throws(() => createClipRef(accessor, { sourceId: a, start: 0, end: 1 }), /source/i);
    assert.equal(idReads, 0, 'source qualification never invokes an ID accessor');
    assert.equal(accessor.allocators.clip, 0);
    assert.deepEqual(accessor.clips, []);
  },

  function rejectsSuccessfulNoOpAppendTrapsWithoutBurningAnId() {
    // Mutation caught: trusting a truthy Proxy set trap rather than proving
    // the exact own appended slot and final Array length.
    const a = sourceId('a');
    const project = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    const target = project.clips;
    project.clips = new Proxy(target, {
      set() { return true; },
    });
    assert.throws(() => createClipRef(project, { sourceId: a, start: 0, end: 1 }), /commit|Atlas/i);
    assert.equal(project.allocators.clip, 0, 'a successful no-op cannot burn c1');
    assert.deepEqual(target, [], 'a successful no-op cannot be reported as an appended clip');
  },

  function usesTheIntrinsicArrayAppendInsteadOfAnAtlasMethodOverride() {
    // Mutation caught: calling the caller-overridable atlas.push method rather
    // than the intrinsic Array operation at the commit boundary.
    const a = sourceId('a');
    const project = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    let overrideCalls = 0;
    project.clips.push = () => {
      overrideCalls++;
      return 1;
    };
    const clip = createClipRef(project, { sourceId: a, start: 0, end: 1 });
    assert.equal(overrideCalls, 0);
    assert.strictEqual(project.clips[0], clip);
    assert.equal(project.clips.length, 1);
    assert.equal(project.allocators.clip, 1);
  },

  function rejectsSuccessfulNoOpReplacementTrapsAndKeepsThePriorClip() {
    // Mutation caught: treating Reflect.set true as replacement success when
    // the exact own slot still contains the old ClipRef.
    const a = sourceId('a');
    const project = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    const original = createClipRef(project, { sourceId: a, start: 0, end: 1, label: 'prior' });
    const target = project.clips;
    project.clips = new Proxy(target, {
      set() { return true; },
    });
    assert.throws(() => replaceClipBounds(project, original.id, { start: 0, end: 2 }), /commit|Atlas/i);
    assert.equal(project.allocators.clip, 1, 'a successful no-op cannot burn c2');
    assert.strictEqual(target[0], original);
  },

  function rejectsACounterfeitReplacementDescriptorBeforeAllocation() {
    // Mutation caught: restoring a Proxy's counterfeit descriptor after a
    // failed write instead of preserving the already-observed prior ClipRef.
    const a = sourceId('a');
    const project = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    const original = createClipRef(project, { sourceId: a, start: 0, end: 1, label: 'prior' });
    const target = project.clips;
    const fake = { ...original, label: 'fake' };
    let writes = 0;
    project.clips = new Proxy(target, {
      getOwnPropertyDescriptor(array, property) {
        if (property === '0') {
          return { value: fake, writable: true, enumerable: true, configurable: true };
        }
        return Reflect.getOwnPropertyDescriptor(array, property);
      },
      set(array, property, value) {
        writes++;
        Reflect.set(array, property, value, array);
        throw new Error('replacement write fault');
      },
    });
    assert.throws(() => replaceClipBounds(project, original.id, { start: 0, end: 2 }));
    assert.equal(writes, 0, 'an unprovable rollback boundary rejects before issuing c2');
    assert.equal(project.allocators.clip, 1);
    assert.strictEqual(target[0], original, 'the exact prior ClipRef remains authoritative');
  },

  function rollsBackAProxyAppendOrReplacementTrapWithoutTouchingPriorAtlasState() {
    // Mutation caught: a trap throws after the underlying array write has already become visible.
    const a = sourceId('a');
    const appendProject = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    const appendTarget = appendProject.clips;
    let failLength = true;
    appendProject.clips = new Proxy(appendTarget, {
      set(target, property, value, receiver) {
        const result = Reflect.set(target, property, value, receiver);
        if (property === 'length' && failLength) {
          failLength = false;
          throw new Error('append commit fault');
        }
        return result;
      },
    });
    assert.throws(() => createClipRef(appendProject, { sourceId: a, start: 0, end: 1 }), /commit fault/);
    assert.equal(appendProject.allocators.clip, 0);
    assert.deepEqual(appendTarget, [], 'partially exposed appended element is removed');

    const replaceProject = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    const original = createClipRef(replaceProject, { sourceId: a, start: 0, end: 1, label: 'prior' });
    const replaceTarget = replaceProject.clips;
    let failSlot = true;
    replaceProject.clips = new Proxy(replaceTarget, {
      set(target, property, value, receiver) {
        const result = Reflect.set(target, property, value, receiver);
        if (property === '0' && failSlot) {
          failSlot = false;
          throw new Error('replace commit fault');
        }
        return result;
      },
    });
    assert.throws(() => replaceClipBounds(replaceProject, original.id, { start: 0, end: 2 }), /commit fault/);
    assert.equal(replaceProject.allocators.clip, 1);
    assert.strictEqual(replaceTarget[0], original, 'the exact prior ClipRef is restored');
  },

  function projectsAFilteredSourceViewWithoutReorderingTheAtlas() {
    // Mutation caught: sorting/filtering in place or treating malformed unrelated entries as matches.
    const a = sourceId('a');
    const b = sourceId('b');
    const project = projectWithSources([
      { id: a, sampleRate: 10, channelCount: 1, frames: 100 },
      { id: b, sampleRate: 10, channelCount: 1, frames: 100 },
    ]);
    const c1 = createClipRef(project, { sourceId: a, start: 0, end: 1 });
    createClipRef(project, { sourceId: b, start: 1, end: 2 });
    const c3 = createClipRef(project, { sourceId: a, start: 2, end: 3 });
    project.clips.push(null, { id: 'junk' });
    const atlas = project.clips.slice();
    const view = clipsForSource(project, a);
    assert.deepEqual(view, [c1, c3]);
    assert.notStrictEqual(view, project.clips);
    assert.deepEqual(project.clips, atlas);
  },

  function wordsDelegateToGlobalCreationAndRejectMalformedRangesWithoutAllocation() {
    // Mutation caught: calling legacy makeClip, dereferencing an empty range, or accepting malformed words.
    const a = sourceId('a');
    const project = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    const words = [
      { start: 1, end: 1.2, text: 'the' },
      { start: 1.3, end: 1.5, text: 'deliberately' },
      { start: 1.6, end: 2, text: 'longest-selection-label' },
    ];
    const clip = wordsToClip(project, a, words, 9, -2);
    assert.equal(clip.id, 'c1');
    assert.equal(clip.sourceId, a);
    assert.deepEqual({ start: clip.start, end: clip.end }, { start: 1, end: 2 });
    assert.equal(clip.label, 'the deliberately longest…');
    for (const bad of [[], [{ start: 0, text: 'missing end' }], [{ start: 0, end: 1, text: 7 }]]) {
      assert.throws(() => wordsToClip(project, a, bad, 0, 0));
      assert.equal(project.allocators.clip, 1);
    }
  },

  function reportsOnlyOrderedProjectBoundAssetReferencesAndBlocksBoundaryChanges() {
    // Mutation caught: counting external/coincidental clipIds or allocating before a block/no-op decision.
    const a = sourceId('a');
    const project = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    const clip = createClipRef(project, {
      sourceId: a, start: 1, end: 2, tag: 'tone', label: 'old', features: [1, 2], createdAt: 7,
    });
    project.assets = {
      key1: { id: 'a3', provenance: { kind: 'source-clip', binding: 'project', clipId: clip.id } },
      a4: { id: 'a4', provenance: { kind: 'source-clip', binding: 'external', clipId: clip.id } },
      a5: { id: 'a5', provenance: { kind: 'factory', binding: 'project', clipId: clip.id } },
      key2: { id: 'a3', provenance: { kind: 'source-clip', binding: 'project', clipId: clip.id } },
      a6: { provenance: { kind: 'source-clip', binding: 'project', clipId: clip.id } },
      a7: { id: 'bogus', provenance: { kind: 'source-clip', binding: 'project', clipId: clip.id } },
    };
    assert.deepEqual(clipReferences(project, clip.id), ['a3', 'a6', 'a7']);
    assert.deepEqual(replaceClipBounds(project, clip.id, { start: 1, end: 2 }), {
      kind: 'unchanged', clip,
    });
    assert.deepEqual(replaceClipBounds(project, clip.id, { start: 1, end: 2.5 }), {
      kind: 'blocked', clipId: clip.id, references: ['a3', 'a6', 'a7'],
    });
    assert.equal(project.allocators.clip, 1);
    assert.strictEqual(project.clips[0], clip);
    delete project.assets.key1;
    delete project.assets.key2;
    delete project.assets.a6;
    delete project.assets.a7;
    const original = structuredClone(clip);
    const result = replaceClipBounds(project, clip.id, { start: 1, end: 2.5 });
    assert.equal(result.kind, 'replaced');
    assert.equal(result.clip.id, 'c2');
    assert.deepEqual(clip, original, 'old identity and annotations are never mutated');
    assert.deepEqual(result.clip.features, [1, 2]);
    assert.notStrictEqual(result.clip.features, clip.features, 'replacement annotations are detached');
    assert.throws(() => replaceClipBounds(project, result.clip.id, { start: 3, end: 2 }));
    assert.equal(project.allocators.clip, 2);
  },

  async function harvestPrevalidatesTheWholeBatchBeforeAllocatingAnyClip() {
    // Mutation caught: allocating/appending an early valid pick before a later malformed pick is discovered.
    const a = sourceId('a');
    const project = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    const decoded = decodedBuffer([new Float32Array(100)], 10);
    await assert.rejects(() => prepareHarvestRun(project, decoded, [
      { t0: 0, t1: 1, role: 'kick', label: 'valid first' },
      { t0: 2, t1: 2, role: 'snare', label: 'invalid second' },
    ], { sourceId: a, runId: 'invalid-batch', buffer: 'original' }));
    assert.equal(project.allocators.clip, 0);
    assert.deepEqual(project.clips, []);
  },

  async function harvestCommitsEveryClipOrRollsBackTheWholeBatch() {
    // Mutation caught: the second append fails after the first clip and both ID allocations become visible.
    const a = sourceId('a');
    const project = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    const target = project.clips;
    let failed = false;
    project.clips = new Proxy(target, {
      set(array, property, value, receiver) {
        const result = Reflect.set(array, property, value, receiver);
        if (property === '1' && !failed) {
          failed = true;
          throw new Error('second append fault');
        }
        return result;
      },
    });
    await assert.rejects(() => prepareHarvestRun(project,
      decodedBuffer([new Float32Array(100)], 10), [
        { t0: 0, t1: 1, role: 'kick', label: 'one' },
        { t0: 2, t1: 3, role: 'snare', label: 'two' },
      ], { sourceId: a, runId: 'atomic-run', buffer: 'original' }), /second append fault/);
    assert.equal(project.allocators.clip, 0, 'the failed batch burns no suffixes');
    assert.deepEqual(target, [], 'the failed batch exposes no partial Atlas');
  },

  async function harvestRejectsSuccessfulNoOpAppendTrapsWithoutBurningTheBatch() {
    // Mutation caught: a whole run reporting c1/c2 even though a lying Proxy
    // silently dropped every intrinsic append write.
    const a = sourceId('a');
    const project = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    const target = project.clips;
    project.clips = new Proxy(target, {
      set() { return true; },
    });
    await assert.rejects(() => prepareHarvestRun(project,
      decodedBuffer([new Float32Array(100)], 10), [
        { t0: 0, t1: 1, role: 'kick', label: 'one' },
        { t0: 2, t1: 3, role: 'snare', label: 'two' },
      ], { sourceId: a, runId: 'no-op-run', buffer: 'original' }), /commit|Atlas/i);
    assert.equal(project.allocators.clip, 0, 'a dropped run burns neither c1 nor c2');
    assert.deepEqual(target, [], 'a dropped run exposes no Atlas suffix');
  },
];

export const assetProvenanceCases = [
  function sharedValidationEnforcesTruthfulBufferRepairCombinations() {
    // Mutation caught: treating transform validity and buffer truthfulness as independent checks.
    const a = sourceId('a');
    const project = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    project.clips.push({ id: 'c1', sourceId: a, start: 0, end: 1 });
    const enabledRepair = {
      id: 'r1', t0: 0, t1: 0.5, f0: 10, f1: 20, strength: 0.5, enabled: true, label: 'repair',
    };
    const disabledRepair = { ...enabledRepair, enabled: false };
    const spectral = (repairs = [enabledRepair]) => ({
      schemaVersion: 1, kind: 'spectral-repair-stack', repairs,
    });
    const gain = { schemaVersion: 1, kind: 'linear-gain', gain: 0.5 };
    const asset = (buffer, transforms) => ({
      kind: 'sample', label: 'clip', sampleRate: 10, channelCount: 1, frames: 10,
      payload: { byteLength: 40, sha256: 'sha256:' + '0'.repeat(64) },
      provenance: {
        kind: 'source-clip', binding: 'project', sourceId: a, clipId: 'c1',
        sourceSpan: { start: 0, end: 1 },
        extraction: { startFrame: 0, endFrame: 10, sampleRate: 10, channelCount: 1, buffer },
        transforms,
      },
    });
    assert.equal(validateAssetProvenance(project, asset('original', [])).ok, true);
    assert.equal(validateAssetProvenance(project, asset('original', [spectral()])).ok, false,
      'original cannot claim spectral repair');
    assert.equal(validateAssetProvenance(project, asset('repaired', [])).ok, false,
      'repaired requires one spectral stack');
    assert.equal(validateAssetProvenance(project, asset('repaired', [gain, spectral()])).ok, false,
      'the spectral stack must be first');
    assert.equal(validateAssetProvenance(project, asset('repaired', [spectral(), spectral()])).ok, false,
      'duplicate spectral stacks are invalid');
    assert.equal(validateAssetProvenance(project, asset('repaired', [spectral([disabledRepair])])).ok, false,
      'a repaired buffer requires at least one enabled repair');
    assert.equal(validateAssetProvenance(project, asset('repaired', [spectral(), gain])).ok, true);

    const wrongKind = asset('original', []);
    wrongKind.provenance.kind = 'not-source-clip';
    assert.equal(validateAssetProvenance(project, wrongKind).ok, false,
      'project-bound extraction has exactly the source-clip kind');
    const outerFreight = asset('original', []);
    outerFreight.provenance.freight = 'hidden';
    assert.equal(validateAssetProvenance(project, outerFreight).ok, false,
      'project-bound provenance rejects extra outer freight');
    const spanFreight = asset('original', []);
    spanFreight.provenance.sourceSpan.freight = 'hidden';
    assert.equal(validateAssetProvenance(project, spanFreight).ok, false,
      'sourceSpan is an exact two-field record');
    const extractionFreight = asset('original', []);
    extractionFreight.provenance.extraction.freight = 'hidden';
    assert.equal(validateAssetProvenance(project, extractionFreight).ok, false,
      'extraction is an exact five-field record');
  },

  function sharedValidationRequiresTheExactExternalEnvelope() {
    // Mutation caught: accepting external provenance that preparation can
    // return but canonical project registration must later reject.
    const asset = (provenance) => ({
      kind: 'sample', label: 'external', sampleRate: 10, channelCount: 1, frames: 2,
      payload: { byteLength: 8, sha256: 'sha256:' + '0'.repeat(64) },
      provenance,
    });
    const valid = {
      kind: 'field-capture', binding: 'external', descriptor: { provider: 'archive' }, transforms: [],
    };
    assert.deepEqual(validateAssetProvenance({}, asset(valid)), { ok: true, replayable: true });
    assert.equal(validateAssetProvenance({}, asset({
      kind: 'field-capture', binding: 'external', transforms: [],
    })).ok, false, 'external provenance requires a descriptor');
    assert.equal(validateAssetProvenance({}, asset({ ...valid, descriptor: [] })).ok, false,
      'the external descriptor is a bounded JSON object');
    assert.equal(validateAssetProvenance({}, asset({ ...valid, freight: true })).ok, false,
      'external provenance rejects outer freight');
    assert.equal(validateAssetProvenance({}, asset({
      ...valid, descriptor: { provider: 'archive', pcm: [0.25, -0.5] },
    })).ok, false, 'external metadata cannot smuggle a second PCM owner');
  },

  async function registrationRejectsNestedProjectProvenanceFreightBeforeAllocation() {
    // Mutation caught: project-store's outer allowlist delegating a permissive nested shape to shared validation.
    const a = sourceId('a');
    const project = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    const clip = createClipRef(project, { sourceId: a, start: 0, end: 1, label: 'clip' });
    const extraction = extractClipAsset(decodedBuffer([new Float32Array(100)], 10), clip);
    const prepared = await prepareClipAsset(project, clip, extraction, { buffer: 'original' });
    const poisoned = {
      ...prepared,
      meta: structuredClone(prepared.meta),
    };
    poisoned.meta.provenance.extraction.freight = { hidden: 'not allowed' };
    const runtime = { assetPcm: new Map() };
    await assert.rejects(() => registerPreparedAsset(project, runtime, poisoned), /provenance/i);
    assert.equal(project.allocators.asset, 0);
    assert.deepEqual(project.assets, {});
    assert.equal(runtime.assetPcm.size, 0);
  },

  function extractsExactOwnedHalfOpenFramesFromEveryNativeRateChannel() {
    // Mutation caught: rounding, inclusive end, mono fold-down, resampling, or retaining AudioBuffer views.
    const left = new Float32Array(60010);
    const right = new Float32Array(60010);
    for (let i = 0; i < left.length; i++) {
      left[i] = i;
      right[i] = -i;
    }
    const decoded = decodedBuffer([left, right], 48000);
    const clip = { id: 'c1', sourceId: sourceId('a'), start: 1.0001, end: 1.2501 };
    const result = extractClipAsset(decoded, clip);
    assert.deepEqual(result.extraction, {
      startFrame: 48004, endFrame: 60005, sampleRate: 48000, channelCount: 2,
    });
    assert.deepEqual({ sampleRate: result.sample.sampleRate, channelCount: result.sample.channelCount,
      frames: result.sample.frames }, { sampleRate: 48000, channelCount: 2, frames: 12001 });
    assert.equal(result.sample.channels[0][0], 48004);
    assert.equal(result.sample.channels[0][12000], 60004);
    assert.equal(result.sample.channels[1][0], -48004);
    decoded.buffer.getChannelData(0)[48004] = 0;
    assert.equal(result.sample.channels[0][0], 48004, 'source mutation cannot cross extraction boundary');
  },

  async function capsOnlyPcmAtThirtySecondsAndRejectsArbitraryProjectCaps() {
    // Mutation caught: changing sourceSpan, recording natural rather than actual end, or accepting shortened freight.
    const a = sourceId('a');
    const frames = 31 * 48000;
    const project = projectWithSources([{ id: a, sampleRate: 48000, channelCount: 1, frames }]);
    const clip = createClipRef(project, { sourceId: a, start: 0, end: 31, label: 'long' });
    const decoded = decodedBuffer([new Float32Array(frames)], 48000);
    const extraction = extractClipAsset(decoded, clip);
    assert.equal(extraction.sample.frames, 1440000);
    assert.equal(extraction.extraction.endFrame, 1440000);
    assert.deepEqual(extraction.sourceSpan, { start: 0, end: 31 });
    const prepared = await prepareClipAsset(project, clip, extraction, { buffer: 'original' });
    const runtime = { assetPcm: new Map() };
    assert.equal(await registerPreparedAsset(project, runtime, prepared), 'a1',
      'the exact default 30-second cap crosses project validation');

    const custom = extractClipAsset(decoded, clip, { maxSeconds: 5 });
    assert.equal(custom.sample.frames, 240000, 'custom extraction remains available detached');
    await assert.rejects(() => prepareClipAsset(project, clip, custom, { buffer: 'original' }));
    assert.equal(project.allocators.asset, 1, 'detached custom cap cannot consume a project asset ID');
  },

  async function canonicalRegistrationAndHydrationBreakEveryCallerAlias() {
    // Mutation caught: registering prepared.sample, sharing track hydrations, or rewriting an existing asset.
    const a = sourceId('a');
    const project = projectWithSources([{ id: a, sampleRate: 96000, channelCount: 2, frames: 200000 }]);
    const clip = createClipRef(project, { sourceId: a, start: 1.0001, end: 1.1251, label: 'stereo' });
    const left = Float32Array.from({ length: 200000 }, (_, i) => i / 200000);
    const right = Float32Array.from({ length: 200000 }, (_, i) => -i / 200000);
    const decoded = decodedBuffer([left, right], 96000);
    const extraction = extractClipAsset(decoded, clip);
    const first = extraction.sample.channels[0][0];
    decoded.buffer.getChannelData(0)[extraction.extraction.startFrame] = -0.9;
    assert.equal(extraction.sample.channels[0][0], first);

    const prepared = await prepareClipAsset(project, clip, extraction, {
      label: 'STEREO', role: 'TONE', buffer: 'original',
    });
    const preparedFirst = prepared.sample.channels[0][0];
    extraction.sample.channels[0][0] = 0.75;
    assert.equal(prepared.sample.channels[0][0], preparedFirst, 'preparation owns an extraction copy');
    const digest = prepared.meta.payload.sha256;
    const expectedBytes = prepared.bytes.slice();
    const runtime = { assetPcm: new Map() };
    const id = await registerPreparedAsset(project, runtime, prepared);
    assert.equal(id, 'a1');
    prepared.sample.channels[0][0] = -0.8;
    prepared.bytes.fill(0);
    assert.deepEqual(runtime.assetPcm.get(id).copyBytes(), expectedBytes);
    assert.equal(project.assets[id].payload.sha256, digest);
    assert.deepEqual(project.assets[id].provenance.sourceSpan, { start: 1.0001, end: 1.1251 });
    assert.equal(project.assets[id].provenance.extraction.sampleRate, 96000);
    assert.equal(project.assets[id].provenance.extraction.channelCount, 2);

    project.machine.scenes[0].tracks[0].sampleId = id;
    project.machine.scenes[1].tracks[0].sampleId = id;
    resolveTrackSamples(project, runtime);
    const one = project.machine.scenes[0].tracks[0].sample;
    const two = project.machine.scenes[1].tracks[0].sample;
    assert.equal(one.channelCount, 2);
    assert.notStrictEqual(one.channels[0], two.channels[0]);
    one.channels[0][0] = 42;
    assert.equal(two.channels[0][0], preparedFirst);
    assert.equal(runtime.assetPcm.get(id).hydrate().channels[0][0], preparedFirst);

    const secondPrepared = await prepareClipAsset(project, clip, extractClipAsset(decoded, clip), {
      buffer: 'original',
    });
    const secondId = await registerPreparedAsset(project, runtime, secondPrepared);
    assert.equal(secondId, 'a2', 'reprocessing mints rather than rewrites');
    assert.strictEqual(runtime.assetPcm.get(id).copyBytes().length, expectedBytes.length);
  },

  async function recordsTruthfulOriginalAndOrderedRepairedProvenanceSnapshots() {
    // Mutation caught: inferring repair from a stale stack, reordering it, or retaining caller objects.
    const a = sourceId('a');
    const project = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    const clip = createClipRef(project, { sourceId: a, start: 1, end: 2, label: 'clip' });
    const extraction = extractClipAsset(decodedBuffer([Float32Array.from({ length: 100 }, (_, i) => i / 100)], 10), clip);
    const stale = [{ id: 'stale', t0: 1, t1: 2, f0: 20, f1: 40, strength: 0.5,
      enabled: true, label: 'stale' }];
    const original = await prepareClipAsset(project, clip, extraction, {
      buffer: 'original', repairStack: stale,
    });
    assert.deepEqual(original.meta.provenance.transforms, []);
    assert.equal(original.meta.provenance.extraction.buffer, 'original');

    const repairs = [
      { id: 'z', t0: 1, t1: 1.2, f0: 100, f1: 200, strength: 0.6, enabled: true, label: 'first' },
      { id: 'a', t0: 1.3, t1: 1.5, f0: 300, f1: 400, strength: 0.4, enabled: false, label: 'second' },
    ];
    const repaired = await prepareClipAsset(project, clip, extraction, {
      buffer: 'repaired', repairStack: repairs,
      transforms: [{ schemaVersion: 1, kind: 'linear-gain', gain: 0.5 }],
    });
    assert.equal(repaired.meta.provenance.extraction.buffer, 'repaired');
    assert.deepEqual(repaired.meta.provenance.transforms, [
      { schemaVersion: 1, kind: 'spectral-repair-stack', repairs },
      { schemaVersion: 1, kind: 'linear-gain', gain: 0.5 },
    ]);
    repairs[0].label = 'mutated';
    assert.equal(repaired.meta.provenance.transforms[0].repairs[0].label, 'first');
    await assert.rejects(() => prepareClipAsset(project, clip, extraction, {
      buffer: 'original',
      transforms: [{ schemaVersion: 1, kind: 'spectral-repair-stack', repairs }],
    }), /repair|original/i, 'original PCM cannot carry a spectral-repair claim');
    await assert.rejects(() => prepareClipAsset(project, clip, extraction, {
      buffer: 'repaired', repairStack: [],
    }), /repair|stack/i, 'repaired PCM requires an enabled repair basis');
  },

  async function clipPreparationSnapshotsEveryInputBeforeItsFirstAwait() {
    // Mutation caught: hashing yields before metadata assembly, so caller-owned
    // clip, extraction metadata, or options cannot be reread afterward.
    const a = sourceId('a');
    const project = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    const clip = createClipRef(project, { sourceId: a, start: 0, end: 0.2, label: 'ORIGINAL' });
    const extraction = extractClipAsset(decodedBuffer([Float32Array.of(0.25, -0.5)], 10), clip);
    const options = { buffer: 'original', role: 'TONE' };
    const pending = prepareClipAsset(project, clip, extraction, options);
    clip.label = 'MUTATED';
    extraction.extraction.startFrame = 1;
    extraction.sourceSpan.end = 99;
    extraction.sample.channels[0][0] = 9;
    options.role = 'FX';
    options.label = 'MUTATED';
    const prepared = await pending;
    assert.equal(prepared.meta.label, 'ORIGINAL');
    assert.equal(prepared.meta.role, 'TONE');
    assert.deepEqual(prepared.meta.provenance.sourceSpan, { start: 0, end: 0.2 });
    assert.equal(prepared.meta.provenance.extraction.startFrame, 0);
    assert.deepEqual(Array.from(prepared.sample.channels[0]), [0.25, -0.5]);
  },

  async function harvestSnapshotsPicksAndRunOptionsBeforeItsFirstAwait() {
    // Mutation caught: a stateful pick getter and caller edits while the first
    // digest is pending cannot mix one run's labels, leveling, or buffer basis.
    const a = sourceId('a');
    const project = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    let roleReads = 0;
    const pick = {
      t0: 0,
      t1: 1,
      get role() {
        roleReads += 1;
        return roleReads === 1 ? 'TONE' : 'MUTATED';
      },
      label: 'ORIGINAL',
    };
    const options = {
      sourceId: a, runId: 'snapshot-run', buffer: 'original', level: false,
    };
    const pending = prepareHarvestRun(project,
      decodedBuffer([new Float32Array(100).fill(0.1)], 10), [pick], options);
    pick.label = 'MUTATED';
    options.level = true;
    options.buffer = 'repaired';
    options.repairStack = [{
      id: 'r1', t0: 0, t1: 1, f0: 10, f1: 20, strength: 0.5, enabled: true, label: 'late',
    }];
    const run = await pending;
    assert.equal(roleReads, 1, 'each pick field is finalized from one detached snapshot');
    assert.equal(run.clips[0].tag, 'TONE');
    assert.equal(run.clips[0].label, 'ORIGINAL');
    assert.equal(run.preparedAssets[0].meta.provenance.extraction.buffer, 'original');
    assert.deepEqual(run.preparedAssets[0].meta.provenance.transforms, []);
    assert.equal(run.preparedAssets[0].sample.channels[0][0], Math.fround(0.1));
  },

  async function harvestUsesOneBoundedMultichannelGainAndHashesTransformedPcm() {
    // Mutation caught: per-channel leveling, missing/duplicate unity transform, or hashing pre-gain samples.
    const a = sourceId('a');
    const project = projectWithSources([{ id: a, sampleRate: 10, channelCount: 2, frames: 100 }]);
    const left = new Float32Array(100).fill(0.1);
    const right = new Float32Array(100).fill(0.25);
    const run = await prepareHarvestRun(project, decodedBuffer([left, right], 10), [
      { t0: 0, t1: 1, role: 'tone', label: 'quiet', score: 1 },
    ], { sourceId: a, runId: 'gain-run', buffer: 'original' });
    const prepared = run.preparedAssets[0];
    const gain = prepared.meta.provenance.transforms[0].gain;
    close(gain, 2.0047489345090887, 1e-12, 'HARVEST gain');
    close(prepared.sample.channels[0][0], 0.1 * gain, 1e-6, 'left scaled by global gain');
    close(prepared.sample.channels[1][0], 0.5011872336272722, 1e-6, 'right reaches target');
    assert.notEqual(prepared.meta.payload.sha256,
      (await prepareClipAsset(project, run.clips[0], extractClipAsset(decodedBuffer([left, right], 10), run.clips[0]),
        { buffer: 'original' })).meta.payload.sha256, 'transformed PCM owns the recorded digest');

    const target = Math.pow(10, -6 / 20);
    const unityProject = projectWithSources([{ id: sourceId('b'), sampleRate: 10, channelCount: 2, frames: 100 }]);
    const unity = await prepareHarvestRun(unityProject,
      decodedBuffer([new Float32Array(100).fill(target), new Float32Array(100).fill(target / 2)], 10),
      [{ t0: 0, t1: 1, role: 'tone', label: 'unity', score: 1 }],
      { sourceId: sourceId('b'), runId: 'unity-run', buffer: 'original' });
    assert.deepEqual(unity.preparedAssets[0].meta.provenance.transforms, []);
  },

  function regenerationRemovesOnlyUnreferencedPriorSameGeneratorOutputs() {
    // Mutation caught: matching runId, deleting manual/other-source/version output, or deleting referenced clips.
    const a = sourceId('a');
    const b = sourceId('b');
    const gen = (kind, version, runId) => ({ kind, version, runId });
    const project = projectWithSources([
      { id: a, sampleRate: 10, channelCount: 1, frames: 100 },
      { id: b, sampleRate: 10, channelCount: 1, frames: 100 },
    ]);
    project.clips = [
      { id: 'c1', sourceId: a, start: 0, end: 1, generator: gen('harvest', 1, 'old') },
      { id: 'c2', sourceId: a, start: 1, end: 2, generator: gen('harvest', 1, 'old') },
      { id: 'c3', sourceId: a, start: 2, end: 3 },
      { id: 'c4', sourceId: b, start: 0, end: 1, generator: gen('harvest', 1, 'old') },
      { id: 'c5', sourceId: a, start: 3, end: 4, generator: gen('harvest', 2, 'old') },
      { id: 'c6', sourceId: a, start: 4, end: 5, generator: gen('other', 1, 'old') },
    ];
    project.assets.a1 = { id: 'a1', provenance: {
      kind: 'source-clip', binding: 'project', sourceId: a, clipId: 'c2',
    } };
    assert.deepEqual(planGeneratedClipReplacement(project, {
      sourceId: a, generator: gen('harvest', 1, 'new'),
    }), { removeClipIds: ['c1'] });
    assert.deepEqual(planGeneratedClipReplacement(project, {
      sourceId: a, generator: gen('harvest', 1, 'old'),
    }), { removeClipIds: [] }, 'repeating the same run never plans its own output for removal');
  },

  function reachabilityPlansOnlyFinalCurrentReferenceRemovalAcrossAllScenes() {
    // Mutation caught: inspecting only activeScene, counting duplicate IDs twice, mutating the machine, or touching history.
    const project = createProject([]);
    const machine = project.machine;
    machine.scenes[0].tracks[0].sampleId = 'a1';
    machine.scenes[0].tracks[1].sampleId = 'a1';
    machine.scenes[2].tracks[0].sampleId = 'a2';
    const before = structuredClone(machine.scenes.map((scene) => scene.tracks.map((track) => track.sampleId)));
    assert.deepEqual(planAssetReachability(machine, {
      sceneIndex: 0, trackIndex: 0, nextSampleId: 'a3',
    }), { beforeIds: ['a1', 'a2'], afterIds: ['a3', 'a1', 'a2'], removeCurrentIds: [] });
    machine.scenes[0].tracks[1].sampleId = null;
    const history = new Map([['a1', { bytes: 'history-owned' }]]);
    assert.deepEqual(planAssetReachability(machine, {
      sceneIndex: 0, trackIndex: 0, nextSampleId: null,
    }), { beforeIds: ['a1', 'a2'], afterIds: ['a2'], removeCurrentIds: ['a1'] });
    assert.equal(history.get('a1').bytes, 'history-owned');
    assert.equal(machine.scenes[0].tracks[0].sampleId, 'a1', 'planning is pure');
    assert.deepEqual(before[2][0], 'a2');
    assert.deepEqual(planAssetReachability(machine, {
      sceneIndex: 0, trackIndex: 0, nextSampleId: 'a1',
    }), { beforeIds: ['a1', 'a2'], afterIds: ['a1', 'a2'], removeCurrentIds: [] });
  },
];

export const crateAssetCases = [
  async function cratePreparationSnapshotsTheEntireItemBeforeItsFirstAwait() {
    // Mutation caught: sample is detached synchronously but meta/provenance are read after asynchronous hashing.
    const a = sourceId('a');
    const project = projectWithSources([{ id: a, sampleRate: 10, channelCount: 1, frames: 100 }]);
    project.clips.push({ id: 'c1', sourceId: a, start: 0, end: 0.2 });
    const item = {
      meta: {
        name: 'ORIGINAL', role: 'TONE', source: 'display-only.wav',
        provenance: {
          kind: 'source-clip', binding: 'project', sourceId: a, clipId: 'c1',
          sourceSpan: { start: 0, end: 0.2 },
          extraction: {
            startFrame: 0, endFrame: 2, sampleRate: 10, channelCount: 1, buffer: 'original',
          },
          transforms: [],
        },
      },
      sample: {
        sampleRate: 10, channelCount: 1, frames: 2, channels: [Float32Array.of(0.25, -0.5)],
      },
    };
    const pending = prepareCrateAsset(item, project);
    item.meta.name = 'MUTATED';
    item.meta.role = 'FX';
    item.meta.provenance.sourceSpan.end = 99;
    item.sample.channels[0][0] = 9;
    const prepared = await pending;
    assert.equal(prepared.meta.label, 'ORIGINAL');
    assert.equal(prepared.meta.role, 'TONE');
    assert.deepEqual(prepared.meta.provenance.descriptor.sourceClip.sourceSpan, { start: 0, end: 0.2 });
    assert.deepEqual(Array.from(prepared.sample.channels[0]), [0.25, -0.5]);
  },

  async function cratePreparationRejectsMalformedExternalProvenanceImmediately() {
    // Mutation caught: returning an object which only fails at the later
    // registerPreparedAsset trust boundary.
    const item = {
      meta: {
        name: 'MALFORMED',
        provenance: { kind: 'field-capture', binding: 'external', transforms: [] },
      },
      sample: {
        sampleRate: 10, channelCount: 1, frames: 2, channels: [Float32Array.of(0.25, -0.5)],
      },
    };
    await assert.rejects(() => prepareCrateAsset(item, projectWithSources([])), /provenance/i);
  },

  async function roundTripsStereoCanonicalPcmAndDeepImmutableMetadata() {
    // Mutation caught: host-endian/interleaved bytes, mono flattening, shallow voice/provenance, or post-put aliasing.
    const crate = new MemoryCrate();
    const provenance = {
      kind: 'source-clip', binding: 'project', sourceId: sourceId('a'), clipId: 'c1',
      sourceSpan: { start: 0, end: 3 / 96000 },
      extraction: { startFrame: 0, endFrame: 3, sampleRate: 96000, channelCount: 2, buffer: 'original' },
      transforms: [],
    };
    const voice = { envelope: { attack: 3 }, tags: ['bright'] };
    const sample = {
      sampleRate: 96000, channelCount: 2, frames: 3,
      channels: [Float32Array.of(0.25, -0.5, 0.75), Float32Array.of(-0.25, 0.5, -0.75)],
    };
    const pending = crate.put({ name: 'STEREO', role: 'TONE', source: 'display.wav', voice, provenance, sample });
    sample.channels[0][0] = 9;
    voice.envelope.attack = 99;
    provenance.sourceSpan.end = 99;
    const id = await pending;
    assert.equal(id, 'i1');
    const item = await crate.get(id);
    assert.deepEqual(Array.from(item.sample.channels[0]), [0.25, -0.5, 0.75]);
    assert.deepEqual(Array.from(item.sample.channels[1]), [-0.25, 0.5, -0.75]);
    assert.deepEqual({ sampleRate: item.meta.sampleRate, channelCount: item.meta.channelCount,
      frames: item.meta.frames, byteLength: item.meta.payload.byteLength },
    { sampleRate: 96000, channelCount: 2, frames: 3, byteLength: 24 });
    assert.equal(item.meta.voice.envelope.attack, 3);
    assert.equal(item.meta.provenance.sourceSpan.end, 3 / 96000);
    assert.equal(item.pcm, undefined, 'new stereo entries are never flattened');
    item.sample.channels[0][0] = 7;
    item.meta.voice.tags.push('mutated');
    const reread = await crate.get(id);
    assert.equal(reread.sample.channels[0][0], 0.25);
    assert.deepEqual(reread.meta.voice.tags, ['bright']);
  },

  async function rejectsNewEntryLengthDigestAndNonFiniteCorruption() {
    // Mutation caught: trusting index length/digest or exposing corrupt PCM as silence.
    const make = async () => {
      const crate = new MemoryCrate();
      const id = await crate.put({ sample: {
        sampleRate: 48000, channelCount: 1, frames: 2, channels: [Float32Array.of(0.25, -0.5)],
      } });
      return { crate, id };
    };
    {
      const { crate, id } = await make();
      crate.files.set(id + '.f32', crate.files.get(id + '.f32').slice(0, 4));
      await assert.rejects(() => crate.get(id), /length|byte/i);
    }
    {
      const { crate, id } = await make();
      crate.files.get(id + '.f32')[0] ^= 1;
      await assert.rejects(() => crate.get(id), /digest/i);
    }
    {
      const { crate, id } = await make();
      crate.files.set(id + '.f32', pcmBytes([NaN, -0.5]));
      await assert.rejects(() => crate.get(id), /pcm|finite/i);
    }
    {
      const { crate, id } = await make();
      crate.index.items[0].sampleRate = 0;
      await assert.rejects(() => crate.get(id), /rate|metadata|sample/i,
        'invalid stored metadata cannot be normalized into a different sample');
    }
  },

  async function readsLegacyMonoWithoutInventingProvenanceOrDigestMetadata() {
    // Mutation caught: rejecting v1 bytes, aliasing raw storage, or inventing source lineage.
    const crate = new MemoryCrate();
    crate.installLegacy({
      id: 'i7', name: 'OLD', role: 'KICK', source: 'old.wav', sampleRate: 44100,
      frames: 3, savedAt: 1,
    }, [0.125, -0.25, 0.5]);
    const item = await crate.get('i7');
    assert.equal(item.meta.provenance, undefined);
    assert.equal(item.meta.payload, undefined);
    assert.equal(item.sample.channelCount, 1);
    assert.deepEqual(Array.from(item.sample.channels[0]), [0.125, -0.25, 0.5]);
    assert.deepEqual(Array.from(item.pcm), [0.125, -0.25, 0.5]);
    item.pcm[0] = 9;
    assert.equal((await crate.get('i7')).pcm[0], 0.125);
    const prepared = await prepareCrateAsset(item, projectWithSources([]));
    assert.equal(prepared.meta.provenance, undefined);
    assert.match(prepared.meta.payload.sha256, /^sha256:[0-9a-f]{64}$/);
  },

  async function defaultsProjectSnapshotsToExternalAndRelinksOnlyExactExplicitMatches() {
    // Mutation caught: trusting display labels/source ID alone or silently preserving a dangling project binding.
    const a = sourceId('a');
    const project = projectWithSources([{ id: a, sampleRate: 96000, channelCount: 2, frames: 100 }]);
    project.clips.push({ id: 'c1', sourceId: a, start: 0, end: 3 / 96000 });
    const item = {
      meta: {
        name: 'STEREO', role: 'TONE', source: 'spoofed-local-name.wav',
        provenance: {
          kind: 'source-clip', binding: 'project', sourceId: a, clipId: 'c1',
          sourceSpan: { start: 0, end: 3 / 96000 },
          extraction: {
            startFrame: 0, endFrame: 3, sampleRate: 96000, channelCount: 2, buffer: 'original',
          },
          transforms: [],
        },
      },
      sample: {
        sampleRate: 96000, channelCount: 2, frames: 3,
        channels: [Float32Array.of(0, 0.25, 0.5), Float32Array.of(0, -0.25, -0.5)],
      },
    };
    const external = await prepareCrateAsset(item, project);
    assert.equal(external.meta.provenance.binding, 'external');
    assert.deepEqual(external.meta.provenance.descriptor.sourceClip, {
      sourceId: a, clipId: 'c1', sourceSpan: { start: 0, end: 3 / 96000 },
      extraction: { startFrame: 0, endFrame: 3, sampleRate: 96000, channelCount: 2, buffer: 'original' },
    });
    assert.deepEqual(project.clips, [{ id: 'c1', sourceId: a, start: 0, end: 3 / 96000 }]);

    const relinked = await prepareCrateAsset(item, project, { relink: true });
    assert.equal(relinked.meta.provenance.binding, 'project');
    assert.equal(relinked.meta.provenance.sourceId, a);

    const falseOriginal = structuredClone(item);
    falseOriginal.meta.provenance.transforms = [{
      schemaVersion: 1,
      kind: 'spectral-repair-stack',
      repairs: [{
        id: 'r1', t0: 0, t1: 2 / 96000, f0: 10, f1: 20,
        strength: 0.5, enabled: true, label: 'repair',
      }],
    }];
    assert.equal((await prepareCrateAsset(falseOriginal, project, { relink: true }))
      .meta.provenance.binding, 'external', 'false original provenance cannot relink');
    const falseRepaired = structuredClone(item);
    falseRepaired.meta.provenance.extraction.buffer = 'repaired';
    assert.equal((await prepareCrateAsset(falseRepaired, project, { relink: true }))
      .meta.provenance.binding, 'external', 'repaired provenance without a stack cannot relink');

    const mismatched = structuredClone(item);
    mismatched.meta.provenance.sourceSpan.end = 4 / 96000;
    const refused = await prepareCrateAsset(mismatched, project, { relink: true });
    assert.equal(refused.meta.provenance.binding, 'external');
    const absent = await prepareCrateAsset(item, projectWithSources([]), { relink: true });
    assert.equal(absent.meta.provenance.binding, 'external');
  },
];
