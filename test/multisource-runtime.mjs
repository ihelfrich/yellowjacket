import assert from 'node:assert/strict';

import { Engine } from '../js/audio-engine.js';

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
