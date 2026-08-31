import assert from 'node:assert/strict';

import { Engine } from '../js/audio-engine.js';
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
    this.failReads = false;
  }

  async writeBytes(name, bytes) {
    if (this.failWrites) {
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
