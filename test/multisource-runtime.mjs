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

  function checkpointRestoresExactReferencesAndMalformedInstallsCannotMutate() {
    const a = new FixtureAudioBuffer({
      sampleRate: 48000,
      channels: [Float32Array.of(0.25, -0.5, 0.75, -1), Float32Array.of(0.5, -0.25, 1, -0.75)],
    });
    const monoA = Float32Array.of(0.375, -0.375, 0.875, -0.875);
    const reportA = { nativeRate: 96000, decodedRate: 48000, downgraded: true, reason: 'fixture fallback' };
    const b = new FixtureAudioBuffer({ sampleRate: 48000, channels: [Float32Array.of(1, 0, -1, 0.5)] });
    const monoB = Float32Array.of(1, 0, -1, 0.5);
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

    const before = engine.captureInstalled();
    assert.doesNotThrow(() => assert.equal(engine.install({ buffer: b }), false),
      'malformed prepared input is a no-throw failure');
    assert.equal(engine.buffer, before.buffer, 'malformed input cannot replace the buffer');
    assert.equal(engine.mono, before.mono, 'malformed input cannot replace mono');
    assert.equal(engine.decodeReport, before.decodeReport, 'malformed input cannot replace report');
    assert.equal(engine._position, before.position, 'malformed input cannot change transport');
    assert.equal(engine._lastCuts, before.lastCuts, 'malformed input cannot change cuts');
    assert.deepEqual(events, ['loaded'], 'malformed input emits nothing');
  },
];
