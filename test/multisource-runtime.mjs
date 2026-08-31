import assert from 'node:assert/strict';

import { Engine } from '../js/audio-engine.js';
import { ProjectStore } from '../js/app/project-store.js';
import { createSourceRecord } from '../js/app/source-registry.js';
import { SourceSession } from '../js/app/source-session.js';
import {
  MemorySourcePayloadStore,
  OpfsSourcePayloadStore,
  PayloadCorruptionError,
  PayloadUnavailableError,
  SourcePayloadRepository,
} from '../js/app/source-payload-store.js';

const PAYLOAD_A = Uint8Array.of(0, 1, 2, 3);
const PAYLOAD_B = Uint8Array.of(4, 5, 6, 7);
const SOURCE_A = 'sha256:054edec1d0211f624fed0cbca9d4f9400b0e491c43742af2c5b0abebf0c990d8';
const SOURCE_B = 'sha256:c6d44cf418f610e3fe9e1d9294ff43def81c6cdcad6cbb1820cff48d3aa4355d';

class FakeOpfsStore {
  constructor() {
    this.files = new Map();
    this.failWrites = false;
    this.failWriteNames = new Set();
    this.failReads = false;
  }

  async writeBytes(name, bytes) {
    if (this.failWrites || this.failWriteNames.has(name)) {
      const error = new Error('quota exhausted');
      error.name = 'QuotaExceededError';
      throw error;
    }
    this.files.set(name, new Uint8Array(bytes).slice());
  }

  async readBytes(name) {
    if (this.failReads) throw new Error('read failed');
    const bytes = this.files.get(name);
    return bytes ? bytes.slice().buffer : null;
  }

  async has(name) {
    return this.files.has(name);
  }

  async remove(name) {
    this.files.delete(name);
  }

  async listNames() {
    return [...this.files.keys()].sort();
  }
}

class GatedFakeOpfsStore extends FakeOpfsStore {
  constructor(gatedName) {
    super();
    this._gatedName = gatedName;
    this._entered = new Promise((resolve) => { this._enteredResolve = resolve; });
    this._release = new Promise((resolve) => { this._releaseResolve = resolve; });
    this._gateOpen = false;
  }

  async writeBytes(name, bytes) {
    if (name === this._gatedName && !this._gateOpen) {
      this._enteredResolve();
      await this._release;
    }
    return super.writeBytes(name, bytes);
  }

  async waitForWrite() {
    await this._entered;
  }

  releaseWrite() {
    this._gateOpen = true;
    this._releaseResolve();
  }
}

export const sourcePayloadStoreCases = [
  async function payloadPutRejectsCallerIdThatDoesNotMatchItsBytes() {
    const repository = new SourcePayloadRepository();
    await assert.rejects(repository.put(SOURCE_B, PAYLOAD_A), /does not match/i,
      'the supplied source ID must be recomputed from imported bytes');
    assert.equal(await repository.has(SOURCE_A), false, 'a rejected import writes no alternate key');
  },

  async function payloadStoreOwnsIngressAndEgressBytesAndReusesExactReputs() {
    const repository = new SourcePayloadRepository();
    const caller = PAYLOAD_A.slice();
    assert.deepEqual(await repository.put(SOURCE_A, caller), { reused: false }, 'first import owns one copy');
    caller[0] = 99;
    const firstRead = await repository.get(SOURCE_A);
    assert.deepEqual(Array.from(firstRead), [0, 1, 2, 3], 'caller mutation cannot change stored bytes');
    firstRead[1] = 88;
    assert.deepEqual(Array.from(await repository.get(SOURCE_A)), [0, 1, 2, 3],
      'returned bytes are a new owner');
    assert.deepEqual(await repository.put(SOURCE_A, PAYLOAD_A.slice()), { reused: true },
      'an exact immutable re-put is idempotent');
  },

  async function durableSamePathMismatchIsCorruptionRatherThanACacheHit() {
    const opfs = new FakeOpfsStore();
    opfs.files.set('sources/054edec1d0211f624fed0cbca9d4f9400b0e491c43742af2c5b0abebf0c990d8.bin',
      Uint8Array.of(0, 1, 2));
    const durable = new OpfsSourcePayloadStore(opfs);
    await assert.rejects(durable.put(SOURCE_A, PAYLOAD_A), PayloadCorruptionError,
      'a pre-existing wrong-length same-name payload is corruption');
    await assert.rejects(durable.get(SOURCE_A), PayloadCorruptionError,
      'a corrupt durable payload never degrades into a missing cache entry');
  },

  async function payloadListsOnlyValidatedIdsInSortedOrder() {
    const memory = new MemorySourcePayloadStore();
    await memory.put(SOURCE_B, PAYLOAD_B);
    await memory.put(SOURCE_A, PAYLOAD_A);
    await assert.rejects(memory.put('sha256:' + 'A'.repeat(64), PAYLOAD_A), /invalid source ID/i,
      'unvalidated IDs never enter the payload index');
    assert.deepEqual(await memory.listIds(), [SOURCE_A, SOURCE_B], 'the public listing is sorted');
  },

  async function memoryOnlyRepositoryReportsSessionOnly() {
    const repository = new SourcePayloadRepository();
    await repository.put(SOURCE_A, PAYLOAD_A);
    assert.equal(repository.persistent, false, 'memory fallback never claims resume persistence');
  },

  async function attachingDurableFlushesHashesAndThenReleasesVerifiedMemoryCopies() {
    const memory = new MemorySourcePayloadStore();
    const repository = new SourcePayloadRepository(memory);
    await repository.put(SOURCE_A, PAYLOAD_A);
    const opfs = new FakeOpfsStore();
    const attached = await repository.attachDurable(new OpfsSourcePayloadStore(opfs));
    assert.deepEqual(attached, { persistent: true }, 'persistence is claimed only after the durable read-back');
    assert.equal(repository.persistent, true, 'the synchronous status reflects verified durable ownership');
    assert.equal(await memory.has(SOURCE_A), false, 'the sole memory copy releases only after verification');
    const returned = await repository.get(SOURCE_A);
    returned[0] = 77;
    assert.deepEqual(Array.from(await repository.get(SOURCE_A)), [0, 1, 2, 3],
      'durable reads remain byte-identical and independently owned');
  },

  async function quotaFailuresKeepMemoryBytesAndReportSessionOnly() {
    const attachMemory = new MemorySourcePayloadStore();
    const attachRepository = new SourcePayloadRepository(attachMemory);
    await attachRepository.put(SOURCE_A, PAYLOAD_A);
    const attachOpfs = new FakeOpfsStore();
    attachOpfs.failWrites = true;
    assert.deepEqual(await attachRepository.attachDurable(new OpfsSourcePayloadStore(attachOpfs)),
      { persistent: false, sessionOnly: true }, 'failed attachment is explicitly session-only');
    assert.equal(attachRepository.persistent, false, 'failed attachment never claims persistence');
    assert.deepEqual(Array.from(await attachRepository.get(SOURCE_A)), [0, 1, 2, 3],
      'attachment failure retains the only exact memory bytes');

    const putMemory = new MemorySourcePayloadStore();
    const putRepository = new SourcePayloadRepository(putMemory);
    const putOpfs = new FakeOpfsStore();
    const durable = new OpfsSourcePayloadStore(putOpfs);
    await putRepository.put(SOURCE_A, PAYLOAD_A);
    assert.deepEqual(await putRepository.attachDurable(durable), { persistent: true });
    putOpfs.failWrites = true;
    assert.deepEqual(await putRepository.put(SOURCE_B, PAYLOAD_B), { reused: false, sessionOnly: true },
      'a quota-limited put reports session-only');
    assert.equal(putRepository.persistent, false, 'a payload without a verified durable copy clears the claim');
    assert.deepEqual(Array.from(await putRepository.get(SOURCE_B)), [4, 5, 6, 7],
      'the quota-limited import retains its exact bytes for this session');
    putOpfs.failWrites = false;
    assert.deepEqual(await putRepository.attachDurable(durable), { persistent: true },
      'a later attachment retries every session-only payload');
    assert.deepEqual(await putRepository.listIds(), [SOURCE_A, SOURCE_B],
      'retrying persistence retains previously verified durable IDs');
  },

  async function payloadRemoveReportsWhetherItActuallyOwnedAnEntry() {
    const repository = new SourcePayloadRepository();
    assert.equal(await repository.remove(SOURCE_A), false, 'an absent payload is not reported as removed');
    await repository.put(SOURCE_A, PAYLOAD_A);
    assert.equal(await repository.remove(SOURCE_A), true, 'an owned payload reports its removal');
    assert.equal(await repository.has(SOURCE_A), false, 'removed bytes are no longer retrievable');
  },

  async function freshDurableRepositoryDiscoversOnlyVerifiedSourceEntries() {
    const opfs = new FakeOpfsStore();
    const writer = new OpfsSourcePayloadStore(opfs);
    await writer.put(SOURCE_A, PAYLOAD_A);
    opfs.files.set('sources/not-a-source.bin', Uint8Array.of(1));
    opfs.files.set('notes.txt', Uint8Array.of(2));
    const repository = new SourcePayloadRepository();
    assert.deepEqual(await repository.attachDurable(new OpfsSourcePayloadStore(opfs)), { persistent: true });
    assert.deepEqual(await repository.listIds(), [SOURCE_A], 'restart discovery excludes unrelated OPFS names');
    assert.deepEqual(Array.from(await repository.get(SOURCE_A)), [0, 1, 2, 3],
      'restart discovery adopts only bytes that hash to their source ID');
  },

  async function corruptDiscoveredDurableEntryFailsAttachmentWithoutPersistence() {
    const opfs = new FakeOpfsStore();
    opfs.files.set('sources/054edec1d0211f624fed0cbca9d4f9400b0e491c43742af2c5b0abebf0c990d8.bin',
      Uint8Array.of(0, 1, 2, 4));
    const repository = new SourcePayloadRepository();
    await assert.rejects(repository.attachDurable(new OpfsSourcePayloadStore(opfs)), PayloadCorruptionError,
      'a digest-named corrupt entry is an integrity failure, not an ignored name');
    assert.equal(repository.persistent, false, 'failed discovery cannot claim persistence');
  },

  async function attachingAndPuttingAreSerializedBeforePersistenceIsClaimed() {
    const memory = new MemorySourcePayloadStore();
    const repository = new SourcePayloadRepository(memory);
    await repository.put(SOURCE_A, PAYLOAD_A);
    const opfs = new GatedFakeOpfsStore('sources/054edec1d0211f624fed0cbca9d4f9400b0e491c43742af2c5b0abebf0c990d8.bin');
    const attaching = repository.attachDurable(new OpfsSourcePayloadStore(opfs));
    await opfs.waitForWrite();
    const putting = repository.put(SOURCE_B, PAYLOAD_B);
    assert.equal(repository.persistent, false, 'persistence clears while attachment is not yet verified');
    opfs.releaseWrite();
    assert.deepEqual(await attaching, { persistent: true });
    assert.deepEqual(await putting, { reused: false });
    assert.equal(repository.persistent, true, 'the queued put is durable before persistence returns true');
    assert.deepEqual(await repository.listIds(), [SOURCE_A, SOURCE_B], 'no memory-only race payload is omitted');
    assert.equal(await memory.has(SOURCE_B), false, 'the queued payload releases memory only after its durable verification');
  },

  async function postAttachmentReadFaultsClearPersistenceAndRemainTyped() {
    const memory = new MemorySourcePayloadStore();
    const repository = new SourcePayloadRepository(memory);
    await repository.put(SOURCE_A, PAYLOAD_A);
    const opfs = new FakeOpfsStore();
    await repository.attachDurable(new OpfsSourcePayloadStore(opfs));
    opfs.failReads = true;
    await assert.rejects(repository.get(SOURCE_A), PayloadUnavailableError,
      'a durable read exception is not reclassified as an absent payload');
    assert.equal(repository.persistent, false, 'a durable read exception clears the persistence claim first');
  },

  async function missingOrCorruptKnownDurablePayloadsClearPersistenceBeforeThrowing() {
    const missingMemory = new MemorySourcePayloadStore();
    const missingRepository = new SourcePayloadRepository(missingMemory);
    await missingRepository.put(SOURCE_A, PAYLOAD_A);
    const missingOpfs = new FakeOpfsStore();
    await missingRepository.attachDurable(new OpfsSourcePayloadStore(missingOpfs));
    missingOpfs.files.delete('sources/054edec1d0211f624fed0cbca9d4f9400b0e491c43742af2c5b0abebf0c990d8.bin');
    await assert.rejects(missingRepository.get(SOURCE_A), PayloadCorruptionError,
      'a known durable path that disappears is integrity loss');
    assert.equal(missingRepository.persistent, false, 'missing known bytes clear persistence');

    const corruptMemory = new MemorySourcePayloadStore();
    const corruptRepository = new SourcePayloadRepository(corruptMemory);
    await corruptRepository.put(SOURCE_A, PAYLOAD_A);
    const corruptOpfs = new FakeOpfsStore();
    await corruptRepository.attachDurable(new OpfsSourcePayloadStore(corruptOpfs));
    corruptOpfs.files.set('sources/054edec1d0211f624fed0cbca9d4f9400b0e491c43742af2c5b0abebf0c990d8.bin',
      Uint8Array.of(0, 1, 2, 4));
    await assert.rejects(corruptRepository.get(SOURCE_A), PayloadCorruptionError,
      'known durable corruption remains typed');
    assert.equal(corruptRepository.persistent, false, 'known corruption clears persistence');
  },

  async function distinctDurableReattachmentIsRejectedWithoutChangingOwnership() {
    const repository = new SourcePayloadRepository();
    await repository.put(SOURCE_A, PAYLOAD_A);
    const first = new OpfsSourcePayloadStore(new FakeOpfsStore());
    await repository.attachDurable(first);
    await assert.rejects(repository.attachDurable(new OpfsSourcePayloadStore(new FakeOpfsStore())), /different durable/i,
      'a second backend cannot silently orphan the first durable copy');
    assert.equal(repository.persistent, true, 'rejection preserves the established durable claim');
    assert.deepEqual(await repository.listIds(), [SOURCE_A], 'rejection preserves reachable payload ownership');
  },

  async function durableRemoveDistinguishesPresentAbsentAndLostKnownPayloads() {
    const emptyRepository = new SourcePayloadRepository();
    await emptyRepository.attachDurable(new OpfsSourcePayloadStore(new FakeOpfsStore()));
    assert.equal(await emptyRepository.remove(SOURCE_A), false, 'an absent durable payload is not reported as deleted');

    const repository = new SourcePayloadRepository();
    const opfs = new FakeOpfsStore();
    await repository.put(SOURCE_A, PAYLOAD_A);
    await repository.attachDurable(new OpfsSourcePayloadStore(opfs));
    assert.equal(await repository.remove(SOURCE_A), true, 'a present durable payload is removed');

    await repository.put(SOURCE_A, PAYLOAD_A);
    opfs.files.delete('sources/054edec1d0211f624fed0cbca9d4f9400b0e491c43742af2c5b0abebf0c990d8.bin');
    await assert.rejects(repository.remove(SOURCE_A), PayloadCorruptionError,
      'a tracked payload that vanished is not a successful delete');
    assert.equal(repository.persistent, false, 'lost known bytes clear persistence during remove');
  },

  async function durableInterfacesMustBeCompleteBeforeAttachment() {
    assert.throws(() => new OpfsSourcePayloadStore({ readBytes() {}, writeBytes() {} }), /requires/i,
      'the OPFS adapter rejects incomplete byte backends');
    const repository = new SourcePayloadRepository();
    await assert.rejects(repository.attachDurable({ put() {}, get() {} }), /complete interface/i,
      'repository attachment rejects a backend that cannot later list or remove');
  },

  async function partialInitialAttachmentBindsItsBackendUntilSameBackendRecovery() {
    const memory = new MemorySourcePayloadStore();
    const repository = new SourcePayloadRepository(memory);
    await repository.put(SOURCE_A, PAYLOAD_A);
    await repository.put(SOURCE_B, PAYLOAD_B);
    const firstOpfs = new FakeOpfsStore();
    firstOpfs.failWriteNames.add('sources/c6d44cf418f610e3fe9e1d9294ff43def81c6cdcad6cbb1820cff48d3aa4355d.bin');
    const first = new OpfsSourcePayloadStore(firstOpfs);
    assert.deepEqual(await repository.attachDurable(first), { persistent: false, sessionOnly: true },
      'a second-write failure leaves the initial attachment session-only');
    assert.equal(repository.persistent, false, 'a partial durable write never claims persistence');
    assert.equal(firstOpfs.files.has('sources/054edec1d0211f624fed0cbca9d4f9400b0e491c43742af2c5b0abebf0c990d8.bin'), true,
      'the first payload really reached the first backend');
    await assert.rejects(repository.attachDurable(new OpfsSourcePayloadStore(new FakeOpfsStore())), /different durable/i,
      'a partial initial backend cannot be abandoned for a second backend');
    firstOpfs.failWriteNames.clear();
    assert.deepEqual(await repository.attachDurable(first), { persistent: true },
      'the bound backend can retry the complete in-memory set');
    assert.deepEqual(await repository.listIds(), [SOURCE_A, SOURCE_B], 'same-backend retry retains both payloads');
    assert.deepEqual(Array.from(await repository.get(SOURCE_A)), [0, 1, 2, 3]);
    assert.deepEqual(Array.from(await repository.get(SOURCE_B)), [4, 5, 6, 7]);
  },

  async function adapterListingRejectsKnownDisappearanceBeforeFreshAttachment() {
    const opfs = new FakeOpfsStore();
    const durable = new OpfsSourcePayloadStore(opfs);
    await durable.put(SOURCE_A, PAYLOAD_A);
    opfs.files.delete('sources/054edec1d0211f624fed0cbca9d4f9400b0e491c43742af2c5b0abebf0c990d8.bin');
    await assert.rejects(durable.listIds(), PayloadCorruptionError,
      'the adapter does not omit a known source that vanished underneath it');
    const freshRepository = new SourcePayloadRepository();
    await assert.rejects(freshRepository.attachDurable(durable), PayloadCorruptionError,
      'fresh attachment through the same adapter propagates known disappearance');
    assert.equal(freshRepository.persistent, false, 'known disappearance cannot produce a persistent empty repository');
  },
];

class FixtureAudioBuffer {
  constructor({ sampleRate, channels }) {
    this.sampleRate = sampleRate;
    this.numberOfChannels = channels.length;
    this.length = channels[0].length;
    this.duration = this.length / sampleRate;
    this._channels = channels;
  }

  getChannelData(channel) {
    return this._channels[channel];
  }
}

function wavBytes(rate = 48000) {
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  const tag = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 2, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  tag(36, 'data'); view.setUint32(40, 0, true);
  return bytes.buffer;
}

function prepared(buffer, mono, decodeReport) {
  return { buffer, mono, decodeReport };
}

function oneSecondChannel(...samples) {
  const channel = new Float32Array(48000);
  channel.set(samples);
  return channel;
}

function installedState(engine) {
  return {
    buffer: engine.buffer,
    mono: engine.mono,
    alt: engine._alt,
    position: engine._position,
    cuts: engine._lastCuts,
    decodeReport: engine.decodeReport,
    playing: engine.playing,
  };
}

function assertInstalledState(engine, expected, events, expectedEvents, label) {
  assert.equal(engine.buffer, expected.buffer, label + ' preserves buffer reference');
  assert.equal(engine.mono, expected.mono, label + ' preserves mono reference');
  assert.equal(engine._alt, expected.alt, label + ' preserves alt reference');
  assert.equal(engine._position, expected.position, label + ' preserves position');
  assert.equal(engine._lastCuts, expected.cuts, label + ' preserves cuts reference');
  assert.equal(engine.decodeReport, expected.decodeReport, label + ' preserves report reference');
  assert.equal(engine.playing, expected.playing, label + ' preserves playback state');
  assert.deepEqual(events, expectedEvents, label + ' emits nothing');
}

async function withFakeDecodeContext(decodedBuffers, run) {
  const priorWindow = globalThis.window;
  const priorOffline = globalThis.OfflineAudioContext;
  const inputs = [];
  class FakeAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.destination = {};
    }

    createGain() { return { connect() {} }; }

    async decodeAudioData(input) {
      inputs.push(input);
      return decodedBuffers.shift();
    }
  }
  globalThis.window = { AudioContext: FakeAudioContext };
  globalThis.OfflineAudioContext = class {
    constructor() { throw new Error('the 48 kHz fixture must use the live context'); }
  };
  try {
    await run(inputs);
  } finally {
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
    if (priorOffline === undefined) delete globalThis.OfflineAudioContext;
    else globalThis.OfflineAudioContext = priorOffline;
  }
}

export const engineTransactionCases = [
  async function decodeLeavesTheInstalledSourceAndTransportUntouchedUntilInstall() {
    const a = new FixtureAudioBuffer({
      sampleRate: 48000,
      channels: [Float32Array.of(0.25, -0.5, 0.75, -1), Float32Array.of(0.5, -0.25, 1, -0.75)],
    });
    const monoA = Float32Array.of(0.375, -0.375, 0.875, -0.875);
    const reportA = { nativeRate: 48000, decodedRate: 48000, downgraded: false, reason: null };
    const b = new FixtureAudioBuffer({
      sampleRate: 48000,
      channels: [Float32Array.of(1, 0, -1, 0.5), Float32Array.of(-1, 0.5, 1, -0.5)],
    });

    await withFakeDecodeContext([b], async (inputs) => {
      const engine = new Engine();
      const events = [];
      for (const type of ['state', 'loaded']) {
        engine.addEventListener(type, (event) => events.push([type, event.detail]));
      }
      assert.equal(engine.install(prepared(a, monoA, reportA)), true, 'fixture A installs');
      events.length = 0;
      engine._position = 0.75;
      engine._lastCuts = [{ start: 0.1, end: 0.2 }];
      engine._playing = true;
      const installedA = engine.captureInstalled();

      const decoded = await engine.decode(wavBytes());

      assert.equal(inputs.length, 1, 'decode reaches the supplied AudioContext once');
      assert.equal(decoded.buffer, b, 'decode returns B without installing it');
      assert.deepEqual(Array.from(decoded.mono), [0, 0.25, 0, 0], 'decode builds B mono data');
      assert.deepEqual(decoded.decodeReport, {
        nativeRate: 48000, decodedRate: 48000, downgraded: false, reason: null,
      }, 'decode returns B report data');
      assert.equal(engine.buffer, installedA.buffer, 'decode leaves A buffer installed');
      assert.equal(engine.mono, installedA.mono, 'decode leaves A mono installed');
      assert.equal(engine.decodeReport, installedA.decodeReport, 'decode leaves A report installed');
      assert.equal(engine._position, 0.75, 'decode leaves transport position intact');
      assert.equal(engine.playing, true, 'decode does not halt transport');
      assert.equal(engine._lastCuts, installedA.lastCuts, 'decode leaves the exact cuts object intact');
      assert.equal(events.length, 0, 'decode emits no transport or loaded events');

      assert.equal(engine.install(decoded), true, 'install accepts decoded B');
      assert.equal(engine.buffer, b, 'install commits B buffer');
      assert.equal(engine.mono, decoded.mono, 'install commits B mono');
      assert.equal(engine.decodeReport, decoded.decodeReport, 'install commits B report');
      assert.equal(engine._position, 0, 'install resets position');
      assert.equal(engine.playing, false, 'install halts transport');
      assert.deepEqual(engine._lastCuts, [], 'install clears cuts');
      assert.deepEqual(events.map(([type]) => type), ['state', 'loaded'],
        'install alone halts and announces the new source');
    });
  },

  function checkpointRestoresExactReferencesAndRejectsMalformedBoundariesAtomically() {
    const a = new FixtureAudioBuffer({
      sampleRate: 48000,
      channels: [oneSecondChannel(0.25, -0.5, 0.75, -1), oneSecondChannel(0.5, -0.25, 1, -0.75)],
    });
    const monoA = oneSecondChannel(0.375, -0.375, 0.875, -0.875);
    const reportA = { nativeRate: 48000, decodedRate: 48000, downgraded: false, reason: null };
    const b = new FixtureAudioBuffer({ sampleRate: 48000, channels: [oneSecondChannel(1, 0, -1, 0.5)] });
    const monoB = oneSecondChannel(1, 0, -1, 0.5);
    const reportB = { nativeRate: 48000, decodedRate: 48000, downgraded: false, reason: null };
    const engine = new Engine();
    const events = [];
    engine.addEventListener('loaded', () => events.push('loaded'));

    assert.equal(engine.install(prepared(a, monoA, reportA)), true, 'fixture A installs');
    events.length = 0;
    engine._position = 0.75;
    engine._lastCuts = [{ start: 0.1, end: 0.2 }];
    const checkpoint = engine.captureInstalled();
    assert.equal(engine.install(prepared(b, monoB, reportB)), true, 'fixture B installs');
    assert.doesNotThrow(() => assert.equal(engine.restoreInstalled(checkpoint), true),
      'restore is synchronous and no-throw');
    assert.equal(engine.buffer, a, 'restore returns the exact A buffer object');
    assert.equal(engine.mono, monoA, 'restore returns the exact A mono object');
    assert.equal(engine.decodeReport, reportA, 'restore returns the exact A report object');
    assert.equal(engine.currentTime, 0.75, 'restore returns A transport position');
    assert.equal(engine._lastCuts, checkpoint.lastCuts, 'restore returns the exact A cuts object');
    assert.deepEqual(events, ['loaded'], 'restore does not emit a second loaded event');

    const before = installedState(engine);
    const beforeEvents = [...events];
    const malformedPrepared = [
      ['missing mono and report', { buffer: b }],
      ['nonpositive native rate', prepared(b, monoB, { ...reportB, nativeRate: 0 })],
      ['decoded rate mismatches buffer', prepared(b, monoB, { ...reportB, decodedRate: 8 })],
    ];
    for (const [label, malformed] of malformedPrepared) {
      assert.doesNotThrow(() => assert.equal(engine.install(malformed), false),
        label + ' install is a no-throw failure');
      assertInstalledState(engine, before, events, beforeEvents, label + ' install');
    }

    const validCheckpoint = engine.captureInstalled();
    const malformedCheckpoints = [
      ['negative position', { ...validCheckpoint, position: -0.1 }],
      ['position outside active timeline', { ...validCheckpoint, position: 1.1 }],
      ['unordered cut bounds', { ...validCheckpoint, lastCuts: [{ start: 0.4, end: 0.2 }] }],
      ['cuts are not in timeline order', {
        ...validCheckpoint, lastCuts: [{ start: 0.4, end: 0.5 }, { start: 0.2, end: 0.3 }],
      }],
      ['out-of-range cut bounds', { ...validCheckpoint, lastCuts: [{ start: 0.2, end: 1.1 }] }],
      ['non-finite cut bound', { ...validCheckpoint, lastCuts: [{ start: 0.2, end: Infinity }] }],
      ['report mismatches buffer', { ...validCheckpoint, decodeReport: { ...reportA, decodedRate: 8 } }],
      ['source-free checkpoint carries a report', {
        buffer: null, mono: null, alt: null, position: 0, lastCuts: [], decodeReport: reportA,
      }],
    ];
    for (const [label, malformed] of malformedCheckpoints) {
      assert.doesNotThrow(() => assert.equal(engine.restoreInstalled(malformed), false),
        label + ' restore is a no-throw failure');
      assertInstalledState(engine, before, events, beforeEvents, label + ' restore');
    }

    const sourceFree = new Engine();
    const sourceFreeCheckpoint = sourceFree.captureInstalled();
    assert.deepEqual(sourceFreeCheckpoint, {
      buffer: null, mono: null, alt: null, position: 0, lastCuts: [], decodeReport: undefined,
    }, 'capture defines the source-free checkpoint shape');
    assert.doesNotThrow(() => assert.equal(sourceFree.restoreInstalled(sourceFreeCheckpoint), true),
      'the defined source-free checkpoint restores synchronously');
  },

  function checkpointCapturesTheLivePositionBeforeAnInstallCanHaltIt() {
    const a = new FixtureAudioBuffer({
      sampleRate: 48000,
      channels: [oneSecondChannel(0.25, -0.5, 0.75, -1)],
    });
    const b = new FixtureAudioBuffer({
      sampleRate: 48000,
      channels: [oneSecondChannel(1, 0, -1, 0.5)],
    });
    const report = { nativeRate: 48000, decodedRate: 48000, downgraded: false, reason: null };
    const engine = new Engine();
    assert.equal(engine.install(prepared(a, oneSecondChannel(0.25, -0.5, 0.75, -1), report)), true);
    engine._ctx = { currentTime: 10 };
    engine._position = 0.25;
    engine._playing = true;
    engine._t0 = 9.5;
    engine._editedStart = 0.25;
    engine._totalKept = 1;
    engine._segs = [{ start: 0, end: 1 }];
    const checkpoint = engine.captureInstalled();

    assert.equal(engine.currentTime, 0.75, 'fixture supplies a live transport clock');
    assert.equal(checkpoint.position, 0.75, 'checkpoint records the live transport position');
    assert.equal(engine.install(prepared(b, oneSecondChannel(1, 0, -1, 0.5), report)), true);
    assert.equal(engine.restoreInstalled(checkpoint), true);
    assert.equal(engine.playing, false, 'rollback restores a stopped transport');
    assert.equal(engine.currentTime, 0.75, 'rollback restores the checkpointed live position');
  },
];

const SESSION_CHAIN = [
  { id: 'gate', on: false, params: { threshold: -18, attack: 3 } },
  { id: 'limiter', on: true, params: { ceiling: -1 } },
];

function sessionDocument(label, threshold) {
  return {
    words: [{ start: 0, end: 0.25, text: label }],
    transcript: { gapCuts: [{ start: 0.25, end: 0.5, label }] },
    chain: [
      { id: 'gate', on: true, params: { threshold, attack: 8 } },
      { id: 'limiter', on: label === 'B', params: { ceiling: label === 'B' ? -2 : -1 } },
    ],
    repairs: [{ id: 'repair-' + label, gain: threshold }],
    anchors: { bpm: label === 'A' ? 96 : 132, barOneTime: label === 'A' ? 0.5 : 0.25 },
  };
}

function sessionRecord(id, displayName, document) {
  const record = createSourceRecord({
    id,
    displayName,
    aliases: [displayName],
    addedAt: displayName === 'a.wav' ? 1788134400000 : 1788134400001,
    origin: { kind: 'file', url: null },
    payload: { byteLength: 4, mediaType: 'audio/wav', extension: 'wav' },
    audio: { sampleRate: 4, channelCount: 1, frames: 16 },
    rights: { basis: 'original-recording', license: null, attribution: null, notes: null },
    document,
  });
  assert.ok(record, 'source-session fixture record must be valid');
  return record;
}

class SessionAudioBuffer {
  constructor(label, duration = 4) {
    this.label = label;
    this.sampleRate = 4;
    this.numberOfChannels = 1;
    this.length = duration * this.sampleRate;
    this.duration = duration;
    this._channel = new Float32Array(this.length).fill(label === 'A' ? 0.25 : 0.5);
  }

  getChannelData(channel) {
    if (channel !== 0) throw new RangeError('fixture has one channel');
    return this._channel;
  }
}

function decodedSessionSource(label, duration = 4) {
  const buffer = new SessionAudioBuffer(label, duration);
  return {
    buffer,
    mono: buffer.getChannelData(0).slice(),
    decodeReport: { nativeRate: 4, decodedRate: 4, downgraded: false, reason: null },
  };
}

class CredibleSessionEngine {
  constructor() {
    this.sourceSpecs = new Map([
      [0, ['A', 4]],
      [4, ['B', 4]],
    ]);
    this.decodeCalls = [];
    this.installCalls = [];
    this.restoreCalls = [];
    this.decodeFault = null;
    this.installFault = null;
    this.installResult = true;
    this._gates = new Map();
    this.seed(decodedSessionSource('A'));
  }

  seed(source) {
    this.buffer = source.buffer;
    this.mono = source.mono;
    this.alt = { label: 'alt-' + source.buffer.label };
    this.position = 0.75;
    this.lastCuts = [{ start: 0.1, end: 0.2 }];
    this.decodeReport = source.decodeReport;
  }

  gateDecode(firstByte) {
    let enter;
    let release;
    const entered = new Promise((resolve) => { enter = resolve; });
    const waiting = new Promise((resolve) => { release = resolve; });
    this._gates.set(firstByte, { enter, release, entered, waiting });
    return { entered, release };
  }

  async decode(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    this.decodeCalls.push({ arrayBuffer, bytes: bytes.slice() });
    const gate = this._gates.get(bytes[0]);
    if (gate) {
      gate.enter();
      await gate.waiting;
      this._gates.delete(bytes[0]);
    }
    if (this.decodeFault) throw this.decodeFault;
    const spec = this.sourceSpecs.get(bytes[0]);
    if (!spec) throw new Error('fixture cannot decode payload');
    return decodedSessionSource(...spec);
  }

  install(source) {
    this.installCalls.push(source.buffer.label);
    if (this.installFault) throw this.installFault;
    if (!this.installResult) return false;
    this.buffer = source.buffer;
    this.mono = source.mono;
    this.alt = null;
    this.position = 0;
    this.lastCuts = [];
    this.decodeReport = source.decodeReport;
    return true;
  }

  captureInstalled() {
    return {
      buffer: this.buffer,
      mono: this.mono,
      alt: this.alt,
      position: this.position,
      lastCuts: this.lastCuts,
      decodeReport: this.decodeReport,
    };
  }

  restoreInstalled(checkpoint) {
    this.restoreCalls.push(checkpoint);
    this.buffer = checkpoint.buffer;
    this.mono = checkpoint.mono;
    this.alt = checkpoint.alt;
    this.position = checkpoint.position;
    this.lastCuts = checkpoint.lastCuts;
    this.decodeReport = checkpoint.decodeReport;
    return true;
  }
}

function replaceArray(target, values) {
  target.splice(0, target.length, ...structuredClone(values));
}

async function sourceSessionFixture(options = {}) {
  const store = new ProjectStore(structuredClone(SESSION_CHAIN), {
    historyLimit: 8,
    historyPcmBudget: 1024,
  });
  const documentA = sessionDocument('A', -12);
  const documentB = sessionDocument('B', -6);
  store.project.sources = {
    [SOURCE_A]: sessionRecord(SOURCE_A, 'a.wav', documentA),
    [SOURCE_B]: sessionRecord(SOURCE_B, 'b.wav', documentB),
  };
  store.project.activeSourceId = SOURCE_A;
  store.project.fileName = 'a.wav';
  store.project.words = structuredClone(documentA.words);
  replaceArray(store.project.transcript.gapCuts, documentA.transcript.gapCuts);
  for (const saved of documentA.chain) {
    const live = store.project.chain.find((entry) => entry.id === saved.id);
    live.on = saved.on;
    Object.assign(live.params, structuredClone(saved.params));
  }
  replaceArray(store.runtime.repairs, documentA.repairs);

  const engine = options.engine || new CredibleSessionEngine();
  store.runtime.buffer = engine.buffer;
  store.runtime.mono = engine.mono;
  store.runtime.sampleRate = engine.buffer.sampleRate;
  store.runtime.peaks = { label: 'peaks-A', mono: engine.mono };
  store.runtime.analysis = { label: 'analysis-A' };
  store.runtime.renderedBuffer = { label: 'rendered-A' };
  store.runtime.original = { buffer: engine.buffer, mono: engine.mono };
  store.runtime.sourceBytes = PAYLOAD_A.slice();
  store.runtime.sourceHash = SOURCE_A;
  store.runtime.generation = 7;

  const payloads = options.payloads || new MemorySourcePayloadStore();
  if (options.putA !== false) await payloads.put(SOURCE_A, PAYLOAD_A);
  if (options.putB !== false) await payloads.put(SOURCE_B, PAYLOAD_B);

  const scheduleCalls = [];
  const stopCalls = [];
  const session = new SourceSession({
    store,
    engine,
    payloads,
    buildPeaks: options.buildPeaks || ((mono) => ({ label: 'peaks-' + (mono[0] === 0.25 ? 'A' : 'B'), mono })),
    scheduleAfterActivation: options.scheduleAfterActivation || ((detail) => { scheduleCalls.push(detail); }),
    stopTransport: options.stopTransport || (() => { stopCalls.push('transport'); }),
    stopAudition: options.stopAudition || (() => { stopCalls.push('audition'); }),
    clock: options.clock || (() => 1788134400999),
    hooks: options.hooks,
  });
  const activationEvents = [];
  session.addEventListener('sourceactivated', (event) => activationEvents.push(event.detail));
  return { store, engine, payloads, session, scheduleCalls, stopCalls, activationEvents };
}

function activeState(fixture) {
  const { store, engine } = fixture;
  return {
    activeSourceId: store.project.activeSourceId,
    fileName: store.project.fileName,
    wordsRef: store.project.words,
    words: structuredClone(store.project.words),
    transcriptRef: store.project.transcript,
    gapCutsRef: store.project.transcript.gapCuts,
    gapCuts: structuredClone(store.project.transcript.gapCuts),
    chainRef: store.project.chain,
    chainEntries: store.project.chain.slice(),
    chainParams: store.project.chain.map((entry) => entry.params),
    chain: structuredClone(store.project.chain),
    repairsRef: store.runtime.repairs,
    repairs: structuredClone(store.runtime.repairs),
    runtime: { ...store.runtime },
    sourcesRef: store.project.sources,
    registryRecords: Object.fromEntries(Object.entries(store.project.sources)),
    registryFields: Object.fromEntries(Object.entries(store.project.sources).map(([id, record]) => [id, {
      aliases: record.aliases,
      origin: record.origin,
      payload: record.payload,
      audio: record.audio,
      rights: record.rights,
    }])),
    registryDocuments: Object.fromEntries(Object.entries(store.project.sources).map(([id, record]) => [id, record.document])),
    registry: structuredClone(store.project.sources),
    revision: store.revision,
    engine: engine.captureInstalled(),
    undoDepth: store.undoDepth,
    canRedo: store.canRedo,
  };
}

function assertActiveState(fixture, expected, label) {
  const { store, engine, activationEvents, scheduleCalls } = fixture;
  assert.equal(store.project.activeSourceId, expected.activeSourceId, label + ' active ID');
  assert.equal(store.project.fileName, expected.fileName, label + ' file name');
  assert.equal(store.project.words, expected.wordsRef, label + ' words identity');
  assert.deepEqual(store.project.words, expected.words, label + ' words value');
  assert.equal(store.project.transcript, expected.transcriptRef, label + ' transcript identity');
  assert.equal(store.project.transcript.gapCuts, expected.gapCutsRef, label + ' gap identity');
  assert.deepEqual(store.project.transcript.gapCuts, expected.gapCuts, label + ' gap value');
  assert.equal(store.project.chain, expected.chainRef, label + ' chain identity');
  assert.deepEqual(store.project.chain, expected.chain, label + ' chain value');
  for (let index = 0; index < expected.chainEntries.length; index++) {
    assert.equal(store.project.chain[index], expected.chainEntries[index], label + ' rack identity ' + index);
    assert.equal(store.project.chain[index].params, expected.chainParams[index], label + ' params identity ' + index);
  }
  assert.equal(store.runtime.repairs, expected.repairsRef, label + ' repairs identity');
  assert.deepEqual(store.runtime.repairs, expected.repairs, label + ' repairs value');
  for (const [key, value] of Object.entries(expected.runtime)) {
    if (key !== 'repairs') assert.equal(store.runtime[key], value, label + ' runtime ' + key);
  }
  assert.deepEqual(store.project.sources, expected.registry, label + ' registry value');
  assert.equal(store.project.sources, expected.sourcesRef, label + ' sources map identity');
  for (const [id, document] of Object.entries(expected.registryDocuments)) {
    assert.equal(store.project.sources[id], expected.registryRecords[id], label + ' registry record identity ' + id);
    assert.equal(store.project.sources[id].document, document, label + ' registry document identity ' + id);
    for (const [key, value] of Object.entries(expected.registryFields[id])) {
      assert.equal(store.project.sources[id][key], value, label + ' registry ' + key + ' identity ' + id);
    }
  }
  assert.equal(store.revision, expected.revision, label + ' revision');
  assert.equal(store.undoDepth, expected.undoDepth, label + ' undo depth');
  assert.equal(store.canRedo, expected.canRedo, label + ' redo state');
  const installed = engine.captureInstalled();
  for (const key of Object.keys(expected.engine)) {
    assert.equal(installed[key], expected.engine[key], label + ' engine ' + key + ' reference');
  }
  assert.deepEqual(activationEvents, [], label + ' emits no activation');
  assert.deepEqual(scheduleCalls, [], label + ' schedules nothing');
}

function globalState(store) {
  return {
    clipsRef: store.project.clips,
    clips: structuredClone(store.project.clips),
    assetsRef: store.project.assets,
    assets: structuredClone(store.project.assets),
    machineRef: store.project.machine,
    machine: structuredClone(store.project.machine),
    studioRef: store.project.studio,
    studio: structuredClone(store.project.studio),
    loomRef: store.project.loom,
    loom: structuredClone(store.project.loom),
    wireRef: store.project.wire,
    wire: structuredClone(store.project.wire),
  };
}

function assertGlobalState(store, expected, label) {
  for (const key of ['clips', 'assets', 'machine', 'studio', 'loom', 'wire']) {
    assert.equal(store.project[key], expected[key + 'Ref'], label + ' preserves ' + key + ' identity');
    assert.deepEqual(store.project[key], expected[key], label + ' preserves ' + key + ' value');
  }
}

function attachSmallHistory(store) {
  store.attachHistory({
    takeDocument: () => ({ clips: structuredClone(store.project.clips) }),
    applyDocument: (document) => replaceArray(store.project.clips, document.clips),
  });
}

export const sourceSessionCases = [
  async function activeFacadeProjectionReplacesOnlyTheValidDocumentWithJsonSafeSourceFields() {
    const fixture = await sourceSessionFixture();
    const { store, session } = fixture;
    store.project.words.push({ start: 1, end: 1.25, text: 'live-only' });
    store.project.transcript.gapCuts.push({ start: 1.25, end: 1.5 });
    store.project.chain[0].params.threshold = -3;
    store.runtime.repairs.push({ id: 'repair-live' });
    const global = globalState(store);
    const inactiveDocument = store.project.sources[SOURCE_B].document;
    const activeRecord = store.project.sources[SOURCE_A];
    const recordRef = activeRecord;
    const runtime = { ...store.runtime };
    const revision = store.revision;
    const epoch = store.runtime.facadeEpoch;

    const projected = session.projectActiveFacade();

    assert.equal(store.project.sources[SOURCE_A], recordRef, 'projection retains the active record');
    assert.equal(store.project.sources[SOURCE_B].document, inactiveDocument, 'projection leaves inactive B untouched');
    assert.equal(store.project.sources[SOURCE_A].document, projected, 'projection returns the installed document');
    assert.deepEqual(Object.keys(projected).sort(), ['anchors', 'chain', 'repairs', 'transcript', 'words']);
    assert.deepEqual(projected.words, store.project.words);
    assert.deepEqual(projected.transcript, { gapCuts: store.project.transcript.gapCuts });
    assert.deepEqual(projected.chain, store.project.chain);
    assert.deepEqual(projected.repairs, store.runtime.repairs);
    assert.deepEqual(projected.anchors, { bpm: 96, barOneTime: 0.5 }, 'record-only anchors survive projection');
    const json = JSON.stringify(projected);
    for (const forbidden of ['fileName', 'buffer', 'mono', 'peaks', 'sourceBytes', 'sourceHash', 'generation']) {
      assert.equal(json.includes('"' + forbidden + '"'), false, forbidden + ' never enters a source document');
    }
    assert.equal(store.project.fileName, 'a.wav', 'display name remains facade-only');
    for (const [key, value] of Object.entries(runtime)) assert.equal(store.runtime[key], value, 'runtime ' + key + ' is untouched');
    assert.equal(store.revision, revision, 'projection does not advance revision');
    assert.equal(store.runtime.facadeEpoch, epoch, 'projection does not advance facade epoch');
    assertGlobalState(store, global, 'projection');

    const firstValue = structuredClone(projected);
    const projectedAgain = session.projectActiveFacade();
    assert.deepEqual(projectedAgain, firstValue, 'a repeated projection is value-idempotent');
    assert.equal(store.revision, revision, 'idempotence does not dispatch through the store');
    assert.deepEqual(fixture.activationEvents, []);
    assert.deepEqual(fixture.scheduleCalls, []);

    const validDocument = store.project.sources[SOURCE_A].document;
    store.project.words = { invalid: true };
    assert.equal(session.projectActiveFacade(), null, 'an invalid facade cannot replace a valid source document');
    assert.equal(store.project.sources[SOURCE_A].document, validDocument, 'invalid projection leaves the record untouched');
    await assert.rejects(session.activate(SOURCE_B), /active facade/i,
      'activation cannot persist an invalid prior-active facade');
    assert.equal(store.project.activeSourceId, SOURCE_A);
    assert.equal(store.project.sources[SOURCE_A].document, validDocument);
    assert.equal(fixture.engine.installCalls.length, 0);
  },

  async function activationHydratesHeldContainersAndRoundTripsIndependentEditedDocuments() {
    const fixture = await sourceSessionFixture();
    const { store, engine, session, activationEvents, scheduleCalls } = fixture;
    store.project.words[0].text = 'A-live';
    store.project.chain[0].params.threshold = -9;
    const held = {
      words: store.project.words,
      transcript: store.project.transcript,
      gaps: store.project.transcript.gapCuts,
      chain: store.project.chain,
      gate: store.project.chain[0],
      gateParams: store.project.chain[0].params,
      limiter: store.project.chain[1],
      limiterParams: store.project.chain[1].params,
      repairs: store.runtime.repairs,
    };
    store.project.clips.push({ id: 'c-global', sourceId: SOURCE_A, start: 0.5, end: 1 });
    store.project.assets.sentinel = { id: 'sentinel', kind: 'sample' };
    const global = globalState(store);

    assert.equal(await session.activate(SOURCE_B), true);
    assert.equal(store.project.words, held.words, 'words array is hydrated in place');
    assert.equal(store.project.transcript, held.transcript, 'transcript object is hydrated in place');
    assert.equal(store.project.transcript.gapCuts, held.gaps, 'gap cuts are hydrated in place');
    assert.equal(store.project.chain, held.chain, 'rack array is hydrated in place');
    assert.equal(store.project.chain[0], held.gate, 'compatible gate entry is hydrated in place');
    assert.equal(store.project.chain[0].params, held.gateParams, 'compatible gate params are hydrated in place');
    assert.equal(store.project.chain[1], held.limiter, 'compatible limiter entry is hydrated in place');
    assert.equal(store.project.chain[1].params, held.limiterParams, 'compatible limiter params are hydrated in place');
    assert.equal(store.runtime.repairs, held.repairs, 'repairs are hydrated in place');
    assert.equal(store.project.fileName, 'b.wav', 'display name comes from B record');
    assert.deepEqual(store.project.words, sessionDocument('B', -6).words);
    assert.equal(engine.buffer.label, 'B');
    assertGlobalState(store, global, 'A to B');

    store.update('source-edit', (project, runtime) => {
      project.words[0].text = 'B-edited';
      project.transcript.gapCuts.push({ start: 2, end: 2.25 });
      project.chain[0].params.threshold = -4;
      runtime.repairs.push({ id: 'repair-B-edit' });
    });
    assert.equal(await session.activate(SOURCE_A), true);
    assert.equal(store.project.words[0].text, 'A-live', 'A restores its projected live edit');
    assert.equal(store.project.chain[0].params.threshold, -9, 'A rack edit is independent');
    assert.equal(await session.activate(SOURCE_B), true);
    assert.equal(store.project.words[0].text, 'B-edited', 'B restores its later edit');
    assert.equal(store.project.chain[0].params.threshold, -4, 'B rack edit round-trips');
    assert.equal(store.runtime.repairs.at(-1).id, 'repair-B-edit', 'B repair edit round-trips');
    assert.equal(engine.buffer.label, 'B', 'only the final active source remains installed');
    assert.deepEqual(engine.installCalls, ['B', 'A', 'B']);
    assert.equal(session._staged, null, 'no decoded target remains staged after commit');
    assert.equal(activationEvents.length, 3, 'each coherent switch emits one event');
    assert.equal(scheduleCalls.length, 3, 'each coherent switch schedules once');
    assertGlobalState(store, global, 'round trip');
  },

  async function prepareIsReadOnlyChecksDecodedClipBoundsAndKeepsOnlyOneStagedTarget() {
    const fixture = await sourceSessionFixture();
    const { store, engine, session } = fixture;
    const beforeProject = structuredClone(store.project);
    const beforeRuntime = { ...store.runtime };
    const beforeEngine = engine.captureInstalled();
    const beforeRevision = store.revision;
    let historyHookCalls = 0;
    store.setBeforeHistorySnapshot(() => { historyHookCalls++; });
    store.project.clips.push({ id: 'c-b', sourceId: SOURCE_B, start: 0.25, end: 3.75 });
    beforeProject.clips.push({ id: 'c-b', sourceId: SOURCE_B, start: 0.25, end: 3.75 });

    const preparedB = await session.prepareActivation(SOURCE_B);

    assert.equal(preparedB.sourceId, SOURCE_B);
    assert.equal(preparedB.decoded.buffer.label, 'B');
    assert.equal(preparedB.peaks.label, 'peaks-B');
    assert.equal(session._staged, preparedB, 'the prepared target is the sole staged decoded source');
    assert.deepEqual(store.project, beforeProject, 'preparation mutates no project state');
    for (const [key, value] of Object.entries(beforeRuntime)) assert.equal(store.runtime[key], value, 'runtime ' + key + ' is untouched');
    const installed = engine.captureInstalled();
    for (const key of Object.keys(beforeEngine)) assert.equal(installed[key], beforeEngine[key], 'engine ' + key + ' is untouched');
    assert.equal(engine.installCalls.length, 0, 'decode never installs');
    assert.equal(store.revision, beforeRevision, 'prepare does not advance revision');
    assert.equal(historyHookCalls, 0, 'prepare does not project through the history hook');
    assert.deepEqual(fixture.activationEvents, []);
    assert.deepEqual(fixture.scheduleCalls, []);

    const preparedA = await session.prepareActivation(SOURCE_A);
    assert.equal(session._staged, preparedA, 'a newer prepare releases the prior staged target');
    assert.equal(preparedA.sourceId, SOURCE_A);

    store.project.clips.push({ id: 'c-b-invalid', sourceId: SOURCE_B, start: 3.5, end: 4.5 });
    const engineBeforeFault = engine.captureInstalled();
    await assert.rejects(session.prepareActivation(SOURCE_B), /clip.*duration|range/i,
      'actual decoded duration rejects an out-of-range target ClipRef');
    assert.equal(session._staged, null, 'rejected decoded data is quarantined');
    assert.equal(engine.installCalls.length, 0, 'invalid clips reject before install');
    for (const key of Object.keys(engineBeforeFault)) {
      assert.equal(engine.captureInstalled()[key], engineBeforeFault[key], 'clip fault preserves engine ' + key);
    }
  },

  async function payloadReadLengthHashAndDecodeFaultsLeaveTheActiveSessionUntouched() {
    const cases = [
      ['missing payload', async () => sourceSessionFixture({ putB: false }), /payload.*unavailable|missing/i],
      ['read fault', async () => {
        class ReadFaultStore extends MemorySourcePayloadStore {
          async get(id) {
            if (id === SOURCE_B) throw new Error('read fault');
            return super.get(id);
          }
        }
        return sourceSessionFixture({ payloads: new ReadFaultStore() });
      }, /read fault/i],
      ['hash fault', async () => {
        class HashFaultStore extends MemorySourcePayloadStore {
          async get(id) {
            if (id === SOURCE_B) return PAYLOAD_A.slice();
            return super.get(id);
          }
        }
        return sourceSessionFixture({ payloads: new HashFaultStore() });
      }, /digest|hash|source ID/i],
      ['decode fault', async () => {
        const engine = new CredibleSessionEngine();
        engine.decodeFault = new Error('decode fault');
        return sourceSessionFixture({ engine });
      }, /decode fault/i],
    ];
    for (const [label, makeFixture, pattern] of cases) {
      const fixture = await makeFixture();
      const before = activeState(fixture);
      await assert.rejects(fixture.session.activate(SOURCE_B), pattern, label);
      assertActiveState(fixture, before, label);
      assert.equal(fixture.engine.installCalls.length, 0, label + ' installs nothing');
      assert.equal(fixture.session._staged, null, label + ' retains no staged decode');
    }

    const lengthFixture = await sourceSessionFixture();
    lengthFixture.store.project.sources[SOURCE_B].payload.byteLength = 3;
    const lengthBefore = activeState(lengthFixture);
    await assert.rejects(lengthFixture.session.activate(SOURCE_B), /byte length/i);
    assertActiveState(lengthFixture, lengthBefore, 'byte-length fault');
  },

  async function aLateFirstRequestIsQuarantinedAfterTheNewerBRequestCommits() {
    const fixture = await sourceSessionFixture();
    const { store, engine, session, activationEvents, scheduleCalls } = fixture;
    const gate = engine.gateDecode(0);
    const lateA = session.activate(SOURCE_A);
    await gate.entered;
    const newerB = session.activate(SOURCE_B);
    assert.equal(await newerB, true, 'the newer request commits');
    gate.release();
    assert.equal(await lateA, false, 'the late request is stale rather than installed');
    assert.equal(store.project.activeSourceId, SOURCE_B);
    assert.equal(engine.buffer.label, 'B');
    assert.deepEqual(engine.installCalls, ['B'], 'only B installs');
    assert.deepEqual(activationEvents.map((detail) => detail.sourceId), [SOURCE_B], 'only B emits');
    assert.deepEqual(scheduleCalls.map((detail) => detail.sourceId), [SOURCE_B], 'only B schedules');
    assert.equal(session._staged, null, 'late A is released');
  },

  async function revisionAndDirectFacadeRacesDuringDecodeCannotOverwriteNewerActiveEdits() {
    const revisionFixture = await sourceSessionFixture();
    const revisionGate = revisionFixture.engine.gateDecode(4);
    const revisionRace = revisionFixture.session.activate(SOURCE_B);
    await revisionGate.entered;
    revisionFixture.store.update('source-edit', (project) => { project.words[0].text = 'A-newer'; });
    const racedRevision = revisionFixture.store.revision;
    revisionGate.release();
    assert.equal(await revisionRace, false, 'a changed revision aborts the prepared activation');
    assert.equal(revisionFixture.store.project.words[0].text, 'A-newer', 'the newer edit survives');
    assert.equal(revisionFixture.store.revision, racedRevision, 'aborting does not add a revision');
    assert.equal(revisionFixture.store.project.activeSourceId, SOURCE_A);
    assert.equal(revisionFixture.engine.buffer.label, 'A');
    assert.deepEqual(revisionFixture.activationEvents, []);
    assert.deepEqual(revisionFixture.scheduleCalls, []);

    const facadeFixture = await sourceSessionFixture();
    const facadeGate = facadeFixture.engine.gateDecode(4);
    const facadeRace = facadeFixture.session.activate(SOURCE_B);
    await facadeGate.entered;
    facadeFixture.store.project.words[0].text = 'A-direct-newer';
    facadeGate.release();
    assert.equal(await facadeRace, false, 'a changed active facade basis aborts even without a revision');
    assert.equal(facadeFixture.store.project.words[0].text, 'A-direct-newer');
    assert.equal(facadeFixture.engine.buffer.label, 'A');
    assert.deepEqual(facadeFixture.activationEvents, []);
    assert.deepEqual(facadeFixture.scheduleCalls, []);
  },

  async function everyCommitBoundaryFaultRollsBackFacadeRegistryRuntimeAndExactEngineReferences() {
    const hookNames = [
      'beforeInstall',
      'afterInstall',
      'beforeFacadeHydrate',
      'beforeRegistryPatch',
      'beforeActivateEvent',
    ];
    for (const hookName of hookNames) {
      const fault = new Error(hookName + ' fault');
      const fixture = await sourceSessionFixture({ hooks: { [hookName]: () => { throw fault; } } });
      const before = activeState(fixture);
      await assert.rejects(fixture.session.activate(SOURCE_B), fault, hookName);
      assertActiveState(fixture, before, hookName);
      const restoredCheckpoint = fixture.engine.restoreCalls.at(-1);
      for (const key of Object.keys(before.engine)) {
        assert.equal(restoredCheckpoint[key], before.engine[key], hookName + ' restores exact engine ' + key);
      }
      assert.equal(fixture.session._staged, null, hookName + ' releases staged B');
    }

    for (const callbackName of ['stopTransport', 'stopAudition']) {
      const fault = new Error(callbackName + ' fault');
      const fixture = await sourceSessionFixture({ [callbackName]: () => { throw fault; } });
      const before = activeState(fixture);
      await assert.rejects(fixture.session.activate(SOURCE_B), fault, callbackName);
      assertActiveState(fixture, before, callbackName);
    }

    const falseInstall = await sourceSessionFixture();
    falseInstall.engine.installResult = false;
    const falseBefore = activeState(falseInstall);
    await assert.rejects(falseInstall.session.activate(SOURCE_B), /install/i);
    assertActiveState(falseInstall, falseBefore, 'false install');

    const throwInstall = await sourceSessionFixture();
    throwInstall.engine.installFault = new Error('install throw');
    const throwBefore = activeState(throwInstall);
    await assert.rejects(throwInstall.session.activate(SOURCE_B), /install throw/i);
    assertActiveState(throwInstall, throwBefore, 'throwing install');

    const clockFault = await sourceSessionFixture({ clock: () => { throw new Error('clock fault'); } });
    const clockBefore = activeState(clockFault);
    await assert.rejects(clockFault.session.activate(SOURCE_B), /clock fault/i);
    assertActiveState(clockFault, clockBefore, 'clock fault before activation event');
  },

  async function afterPrepareIsTheOnlyAwaitableHookAndItsFaultNeverEntersCommit() {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fixture = await sourceSessionFixture({ hooks: { afterPrepare: () => gate } });
    const before = activeState(fixture);
    const activation = fixture.session.activate(SOURCE_B);
    await Promise.resolve();
    assert.equal(fixture.engine.installCalls.length, 0, 'an awaited afterPrepare gate precedes commit');
    release();
    assert.equal(await activation, true);

    const fault = new Error('afterPrepare fault');
    const failed = await sourceSessionFixture({ hooks: { afterPrepare: async () => { throw fault; } } });
    const failedBefore = activeState(failed);
    await assert.rejects(failed.session.activate(SOURCE_B), fault);
    assertActiveState(failed, failedBefore, 'afterPrepare fault');
    assert.equal(failed.engine.restoreCalls.length, 0, 'a prepare fault never enters rollback/install');

    const asyncCommitHook = await sourceSessionFixture({
      hooks: { beforeInstall: () => Promise.resolve() },
    });
    const asyncBefore = activeState(asyncCommitHook);
    await assert.rejects(asyncCommitHook.session.activate(SOURCE_B), /synchronous/i,
      'commit hooks cannot quietly defer work past the transaction');
    assertActiveState(asyncCommitHook, asyncBefore, 'async commit hook');
  },

  async function successfulActivationEmitsOnceThenSchedulesAndPreservesUndoRedoStacks() {
    const order = [];
    const fixture = await sourceSessionFixture({
      scheduleAfterActivation: (detail) => {
        order.push('schedule:' + detail.sourceId);
        throw new Error('scheduler render fault');
      },
    });
    const { store, session } = fixture;
    attachSmallHistory(store);
    store.update('clips', (project) => project.clips.push({ id: 'history-1' }));
    store.update('clips', (project) => project.clips.push({ id: 'history-2' }));
    assert.equal(store.undo(), true);
    const undoDepth = store.undoDepth;
    const canRedo = store.canRedo;
    const revision = store.revision;
    let projected = 0;
    store.setBeforeHistorySnapshot(() => {
      projected++;
      session.projectActiveFacade();
    });
    session.addEventListener('sourceactivated', (event) => {
      order.push('event:' + event.detail.sourceId);
      assert.equal(store.project.activeSourceId, SOURCE_B, 'listener sees the coherent target ID');
      assert.equal(store.project.fileName, 'b.wav', 'listener sees the coherent target facade');
      assert.equal(fixture.engine.buffer.label, 'B', 'listener sees the coherent engine');
      throw new Error('listener render fault');
    });

    assert.equal(await session.activate(SOURCE_B), true, 'listener/scheduler render faults do not undo a commit');
    assert.equal(store.revision, revision + 1, 'activation has one final revision boundary');
    assert.equal(store.undoDepth, undoDepth, 'activation adds no undo entry');
    assert.equal(store.canRedo, canRedo, 'activation preserves the redo stack');
    assert.equal(projected, 0, 'activation does not invoke the before-history projection');
    assert.deepEqual(order, ['event:' + SOURCE_B, 'schedule:' + SOURCE_B], 'event precedes derived scheduling');
    assert.equal(fixture.activationEvents.length, 1, 'one session event is emitted');

    store.project.words[0].text = 'B-before-history';
    store.update('clips', (project) => project.clips.push({ id: 'history-3' }));
    assert.equal(projected, 1, 'one creative edit invokes the registered callback exactly once');
    assert.equal(store.project.sources[SOURCE_B].document.words[0].text, 'B-before-history',
      'the callback projects the active facade before the snapshot');
  },
];
