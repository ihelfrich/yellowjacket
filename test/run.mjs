import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { onsetAnalysis } from '../js/analysis/onsets.js';
import { trackBeats } from '../js/analysis/beattrack.js';
import { kWeightingCoeffs, measureLoudness } from '../js/dsp/loudness.js';
import {
  compileRender,
  compileWindow,
  patternLoopSteps,
  stepTime,
} from '../js/machine/compile.js';
import { resample } from '../js/dsp/resample.js';
import { truePeakDb } from '../js/dsp/truepeak.js';

// The buffer-kind DSP modules construct AudioBuffers; node has none.
if (typeof globalThis.AudioBuffer === 'undefined') {
  globalThis.AudioBuffer = class {
    constructor({ length, numberOfChannels, sampleRate }) {
      this.length = length;
      this.numberOfChannels = numberOfChannels;
      this.sampleRate = sampleRate;
      this._ch = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
    }
    getChannelData(c) { return this._ch[c]; }
  };
}
const { processLimiter } = await import('../js/dsp/limiter.js');
const { processLoudnorm } = await import('../js/dsp/loudnorm.js');

function goertzelPower(x, f, sr) {
  const c = 2 * Math.cos(2 * Math.PI * f / sr);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s0 = x[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / (x.length * x.length / 4);
}

const SAMPLE_RATE = 48000;
const BEAT_SAMPLE_RATE = 44100;

function close(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} +/- ${tolerance}, received ${actual}`,
  );
}

function tone(sampleRate, seconds, frequency, amplitude = 1, phase = 0) {
  const pcm = new Float32Array(Math.round(sampleRate * seconds));
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate + phase);
  }
  return pcm;
}

const loudnessCases = [
  function coefficientTable48k() {
    const actual = kWeightingCoeffs(48000);
    const expected = {
      b1: [1.535124860, -2.691696189, 1.198392811],
      a1: [1, -1.690659293, 0.732480774],
      b2: [1, -2, 1],
      a2: [1, -1.990047455, 0.990072250],
    };
    for (const key of Object.keys(expected)) {
      for (let i = 0; i < expected[key].length; i++) {
        close(actual[key][i], expected[key][i], 1e-4, `48 kHz ${key}[${i}]`);
      }
    }
  },
  function tone997HzMonoAndStereo() {
    const pcm = tone(48000, 4, 997);
    const mono = measureLoudness({ channels: [pcm], sampleRate: 48000 });
    const stereo = measureLoudness({ channels: [pcm, pcm], sampleRate: 48000 });
    close(mono.integrated, -3.010, 0.01, '997 Hz mono integrated');
    close(stereo.integrated, 0, 0.01, '997 Hz stereo integrated');
    close(mono.momentaryMax, -3.008871, 0.01, '997 Hz momentary');
    close(mono.shortTermMax, -3.010286, 0.01, '997 Hz short-term');
    close(mono.rmsDb, -3.010300, 0.01, '997 Hz RMS');
    close(mono.crestDb, 3.010300, 0.01, '997 Hz crest');
    assert.equal(mono.clippedSamples, 5464);
    close(mono.clippedPct, 2.845833, 1e-6, '997 Hz clipped percent');
  },
  function coefficientRedesign44100() {
    const actual = kWeightingCoeffs(44100);
    const expected = {
      b1: [1.530841230, -2.650979995, 1.169079080],
      a1: [1, -1.663655113, 0.712595428],
      b2: [1, -2, 1],
      a2: [1, -1.989169674, 0.989199036],
    };
    for (const key of Object.keys(expected)) {
      for (let i = 0; i < expected[key].length; i++) {
        close(actual[key][i], expected[key][i], 1e-4, `44.1 kHz ${key}[${i}]`);
      }
    }
    const result = measureLoudness({
      channels: [tone(44100, 4, 997)],
      sampleRate: 44100,
    });
    close(result.integrated, -3.010, 0.01, '44.1 kHz redesign loudness');
  },
  function silenceGating() {
    const result = measureLoudness({
      channels: [new Float32Array(48000)],
      sampleRate: 48000,
    });
    for (const key of [
      'integrated',
      'momentaryMax',
      'shortTermMax',
      'samplePeakDb',
      'truePeakDb',
      'rmsDb',
      'crestDb',
    ]) {
      assert.equal(result[key], -Infinity, `silence ${key}`);
    }
    assert.equal(result.dcOffset, 0);
    assert.equal(result.clippedSamples, 0);
    assert.equal(result.clippedPct, 0);
  },
  function gatedLoudQuietProgram() {
    const pcm = new Float32Array(48000 * 12);
    for (let i = 0; i < pcm.length; i++) {
      const amplitude = i < 48000 * 4 || i >= 48000 * 8 ? 0.5 : 0.05;
      pcm[i] = amplitude * Math.sin(2 * Math.PI * 997 * i / 48000);
    }
    const result = measureLoudness({ channels: [pcm], sampleRate: 48000 });
    close(result.integrated, -9.195185, 0.01, 'gated program integrated');
    close(result.momentaryMax, -9.029470, 0.01, 'gated program momentary');
    close(result.shortTermMax, -9.030886, 0.01, 'gated program short-term');
    close(result.samplePeakDb, -6.020600, 0.01, 'gated program sample peak');
    close(result.truePeakDb, -6.020600, 0.01, 'gated program true peak');
    close(result.rmsDb, -10.770152, 0.01, 'gated program RMS');
  },
  function intersamplePeakAnalytic() {
    // Deliberate golden change (TRUTH 1): estimator upgraded to the BS.1770-5
    // Annex 2 structure (48-tap 4-phase 4x FIR, js/dsp/truepeak.js). The fixture is
    // an fs/4 sine, amplitude 0.8, phase pi/4: analytic true peak is exactly
    // 20*log10(0.8) = -1.9382 dBTP while the sample peak sits 3.01 dB lower. The
    // old 8-tap estimator under-read at -2.115; the new one reads within 0.1 dB
    // and errs high, which is the correct failure direction for a peak detector.
    const pcm = tone(48000, 0.5, 12000, 0.8, Math.PI / 4);
    const result = measureLoudness({ channels: [pcm], sampleRate: 48000 });
    close(result.samplePeakDb, -4.948500, 0.01, 'intersample sample peak');
    close(result.truePeakDb, -1.9382, 0.1, 'BS.1770-5 Annex 2 intersample true peak');
  },
];

function clickPcm(seconds, times, accents = null) {
  const pcm = new Float32Array(Math.ceil(seconds * BEAT_SAMPLE_RATE));
  for (let click = 0; click < times.length; click++) {
    const start = Math.round(times[click] * BEAT_SAMPLE_RATE);
    const amplitude = accents ? accents[click] : 1;
    for (let i = 0; i < 192 && start + i < pcm.length; i++) {
      const bits = (i * 1103515245 + click * 12345) >>> 16;
      const noise = bits / 32768 * 2 - 1;
      pcm[start + i] += amplitude * noise * Math.exp(-i / 32);
    }
  }
  return pcm;
}

function seededNoise(seconds) {
  const pcm = new Float32Array(Math.ceil(seconds * BEAT_SAMPLE_RATE));
  let state = 0x12345678;
  for (let i = 0; i < pcm.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    pcm[i] = (state / 0x100000000 * 2 - 1) * 0.1;
  }
  return pcm;
}

function meanNearestError(beats, anchors) {
  const selected = Array.from(beats).filter(
    (beat) => beat >= anchors[0] - 0.05 && beat <= anchors.at(-1) + 0.05,
  );
  assert.ok(selected.length >= anchors.length - 1, 'beat grid retained the click train');
  let total = 0;
  for (const beat of selected) {
    let nearest = Infinity;
    for (const anchor of anchors) nearest = Math.min(nearest, Math.abs(beat - anchor));
    total += nearest;
  }
  return total / selected.length;
}

const beatTimes = Array.from({ length: 24 }, (_, index) => 0.5 + index * 0.5);
let straightBeatFixture;
let swingBeatFixture;

function straightFixture() {
  if (!straightBeatFixture) {
    const pcm = clickPcm(13, beatTimes);
    const analysis = onsetAnalysis(pcm, BEAT_SAMPLE_RATE);
    straightBeatFixture = {
      pcm,
      analysis,
      tracked: trackBeats(analysis.envelope, analysis.envelopeRate),
    };
  }
  return straightBeatFixture;
}

function swingFixture() {
  if (!swingBeatFixture) {
    const times = [];
    const accents = [];
    for (let beat = 0; beat < beatTimes.length; beat++) {
      times.push(beatTimes[beat], beatTimes[beat] + 1 / 3);
      accents.push(1, 0.32);
    }
    const analysis = onsetAnalysis(clickPcm(13, times, accents), BEAT_SAMPLE_RATE);
    swingBeatFixture = {
      analysis,
      tracked: trackBeats(analysis.envelope, analysis.envelopeRate),
    };
  }
  return swingBeatFixture;
}

const beatCases = [
  function tempoAndBeatAccuracy120() {
    const { tracked } = straightFixture();
    close(tracked.tempo, 120, 0.5, 'straight tempo');
    assert.ok(meanNearestError(tracked.beats, beatTimes) < 0.012, 'straight beat MAE');
    assert.ok(tracked.confidence > 0.85, 'straight confidence');
  },
  function swingRobustness() {
    const { tracked } = swingFixture();
    close(tracked.tempo, 120, 0.5, 'swing tempo');
    assert.ok(meanNearestError(tracked.beats, beatTimes) < 0.012, 'swing beat MAE');
    assert.ok(tracked.confidence > 0.85, 'swing confidence');
  },
  function tempoAndBarAnchors() {
    const { analysis } = straightFixture();
    const tracked = trackBeats(analysis.envelope, analysis.envelopeRate, {
      bpm: 123,
      barOneTime: 2.37,
    });
    assert.equal(tracked.tempo, 123);
    close(tracked.beats[tracked.downbeat], 2.37, 1e-6, 'bar-one anchor');
  },
  function noiseCollapse() {
    const analysis = onsetAnalysis(seededNoise(13), BEAT_SAMPLE_RATE);
    const tracked = trackBeats(analysis.envelope, analysis.envelopeRate);
    assert.equal(tracked.confidence, 0);
  },
  function silenceCollapse() {
    const analysis = onsetAnalysis(new Float32Array(BEAT_SAMPLE_RATE * 2), BEAT_SAMPLE_RATE);
    const tracked = trackBeats(analysis.envelope, analysis.envelopeRate);
    assert.equal(tracked.tempo, 0);
    assert.equal(tracked.beats.length, 0);
    assert.equal(tracked.confidence, 0);
  },
  function repeatIdentical() {
    const first = straightFixture();
    const secondAnalysis = onsetAnalysis(clickPcm(13, beatTimes), BEAT_SAMPLE_RATE);
    const secondTracked = trackBeats(secondAnalysis.envelope, secondAnalysis.envelopeRate);
    assert.deepEqual(secondAnalysis.envelope, first.analysis.envelope);
    assert.deepEqual(secondAnalysis.onsets, first.analysis.onsets);
    assert.deepEqual(secondTracked, first.tracked);
  },
];

function makeTrack(len, onSteps, overrides = {}) {
  const steps = new Uint8Array(64);
  for (const step of onSteps) steps[step] = 1;
  return {
    sample: { channels: [new Float32Array(1)], sampleRate: 44100, label: 'TEST' },
    steps,
    len,
    gainDb: 0,
    pan: 0,
    mute: false,
    solo: false,
    ...overrides,
  };
}

const patternCases = [
  function straightGrid() {
    let maximumError = 0;
    for (let step = 0; step <= 64; step++) {
      maximumError = Math.max(
        maximumError,
        Math.abs(stepTime(step, 120, 50) - step * 0.125),
      );
    }
    assert.ok(maximumError <= 1e-9);
  },
  function swingGrid() {
    const swingOddSec = stepTime(1, 120, 66);
    close(swingOddSec, 1 / 6, 1e-12, '66 swing odd step');
    close(swingOddSec / 0.25, 2 / 3, 1e-12, '66 swing ratio');
  },
  function polymeter() {
    assert.equal(patternLoopSteps([
      makeTrack(12, [0]),
      makeTrack(16, [0]),
    ]), 48);
  },
  function muteAndSolo() {
    const events = compileWindow({
      bpm: 120,
      swing: 50,
      tracks: [
        makeTrack(16, [0], { mute: true }),
        makeTrack(16, [0], { solo: true }),
        makeTrack(16, [0]),
      ],
    }, 0, 0.001).events;
    assert.deepEqual(events.map((event) => event.gain), [0, 1, 0]);
  },
  function adjacentWindowBoundary() {
    const machine = {
      bpm: 120,
      swing: 50,
      tracks: [makeTrack(16, [0, 1])],
    };
    const left = compileWindow(machine, 0, 0.125).events;
    const right = compileWindow(machine, 0.125, 0.25).events;
    const whole = compileWindow(machine, 0, 0.25).events;
    assert.deepEqual(left.concat(right), whole);
    assert.equal(left.filter((event) => event.tSec === 0.125).length, 0);
    assert.equal(right.filter((event) => event.tSec === 0.125).length, 1);
  },
  async function goldenRenderAndDeterminism() {
    const machine = {
      bpm: 120,
      swing: 66,
      tracks: [
        makeTrack(12, [0, 1, 7], { gainDb: -6, pan: -0.25 }),
        makeTrack(16, [0, 3, 8], { pan: 0.5 }),
      ],
    };
    const first = compileRender(machine, 1);
    const second = compileRender(machine, 1);
    const golden = JSON.parse(await readFile(
      new URL('./fixtures/pattern-events.json', import.meta.url),
      'utf8',
    ));
    assert.deepEqual(first, golden);
    assert.deepEqual(second, first);
  },
];

const truthCases = [
  function resampleAliasRejection() {
    // 12 kHz at 48k sits above the 16k Nyquist; after a clean resample it must
    // vanish, not fold to 4 kHz the way the old linear path did.
    const x = tone(48000, 1, 12000, 1);
    const y = resample(x, 48000, 16000);
    const alias = 10 * Math.log10(goertzelPower(y.subarray(1000, 15000), 4000, 16000) + 1e-30);
    assert.ok(alias < -70, `alias at 4 kHz: ${alias.toFixed(1)} dB, want < -70`);
  },
  function resamplePassbandAndTiming() {
    const p = tone(48000, 1, 1000, 1);
    const yp = resample(p, 48000, 16000);
    const pass = 10 * Math.log10(goertzelPower(yp.subarray(1000, 15000), 1000, 16000) + 1e-30);
    close(pass, 0, 0.05, 'resample 1 kHz passband');
    const imp = new Float32Array(48000);
    imp[24000] = 1;
    const yi = resample(imp, 48000, 16000);
    let pk = 0;
    let pki = 0;
    for (let i = 0; i < yi.length; i++) {
      const a = Math.abs(yi[i]);
      if (a > pk) { pk = a; pki = i; }
    }
    assert.equal(pki, 8000, 'impulse position preserved through resample');
  },
  function truePeakAnalytic() {
    // fs/4 sine at phase pi/4: sample peak 1/sqrt(2), true peak exactly 1.0.
    const x = tone(48000, 0.1, 12000, 1, Math.PI / 4);
    close(truePeakDb([x]), 0, 0.1, 'analytic intersample true peak');
  },
  async function limiterHoldsCeiling() {
    const sr = 48000;
    const buf = new AudioBuffer({ length: sr, numberOfChannels: 2, sampleRate: sr });
    for (let c = 0; c < 2; c++) {
      const x = buf.getChannelData(c);
      for (let i = 0; i < sr; i++) x[i] = 0.2 * Math.sin(2 * Math.PI * 220 * i / sr);
      for (let b = 0; b < 30; b++) {
        const at = 2000 + b * 1440;
        for (let k = 0; k < 48; k++) x[at + k] += 0.95 * Math.sin(2 * Math.PI * 6000 * k / sr);
      }
    }
    const out = await processLimiter(buf, { params: { ceiling: -1 } });
    const tp = truePeakDb([out.getChannelData(0), out.getChannelData(1)]);
    assert.ok(tp <= -0.9, `clustered-peak true peak ${tp.toFixed(3)} dBTP, ceiling -1`);
  },
  async function limiterReleaseMonotonic() {
    const sr = 48000;
    const buf = new AudioBuffer({ length: sr * 2, numberOfChannels: 1, sampleRate: sr });
    const x = buf.getChannelData(0);
    for (let i = 0; i < x.length; i++) x[i] = 0.2 * Math.sin(2 * Math.PI * 220 * i / sr);
    for (let k = 0; k < 480; k++) x[24000 + k] += 0.95 * Math.sin(2 * Math.PI * 6000 * k / sr);
    const out = await processLimiter(buf, { params: { ceiling: -1 } });
    const y = out.getChannelData(0);
    let prev = 0;
    for (let i = 27000; i < x.length; i++) {
      if (Math.abs(x[i]) <= 0.1) continue;
      const g = y[i] / x[i];
      assert.ok(g + 1e-4 >= prev, `release dipped at ${i}`);
      prev = g;
    }
    assert.ok(prev > 0.995, `release recovered to ${prev.toFixed(4)}`);
  },
  async function loudnormHitsTarget() {
    // Speech-like: bursts of modulated tone with silences, integrated well below target.
    const sr = 48000;
    const buf = new AudioBuffer({ length: sr * 8, numberOfChannels: 1, sampleRate: sr });
    const x = buf.getChannelData(0);
    for (let b = 0; b < 16; b++) {
      const at = Math.floor(b * sr * 0.5);
      for (let i = 0; i < sr * 0.35; i++) {
        const t = i / sr;
        x[at + i] = 0.28 * Math.sin(2 * Math.PI * 350 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
      }
    }
    const out = await processLoudnorm(buf, { params: { target: -16 } });
    const channels = [out.getChannelData(0)];
    const m = measureLoudness({ channels, sampleRate: sr });
    close(m.integrated, -16, 0.5, 'loudnorm delivered LUFS');
    assert.ok(m.truePeakDb <= -0.9, `loudnorm true peak ${m.truePeakDb.toFixed(2)} under ceiling`);
  },
];

function lockMachine(overrides = {}) {
  return {
    bpm: 120,
    swing: 50,
    activeScene: 0,
    scenes: [{ seed: 12345 }],
    ...overrides,
  };
}

const lockCases = [
  function seededProbabilityDeterministic() {
    const track = makeTrack(16, [0, 8]);
    track.stepData = { 0: { prob: 50 }, 8: { prob: 50 } };
    const machine = lockMachine({ tracks: [track] });
    const first = compileRender(machine, 25);
    const second = compileRender(machine, 25);
    assert.deepEqual(second, first, 'seeded probability renders identically');
    // 50 draws at 50%: statistically certain to be strictly between none and all.
    const fired = first.events.length;
    assert.ok(fired >= 10 && fired <= 40, 'prob 50 over 50 draws: ' + fired);
  },
  function probabilityExtremes() {
    const always = makeTrack(16, [0]);
    always.stepData = { 0: { prob: 100 } };
    const rare = makeTrack(16, [0]);
    rare.stepData = { 0: { prob: 1 } };
    const a = compileRender(lockMachine({ tracks: [always] }), 400).events.length;
    const r = compileRender(lockMachine({ tracks: [rare] }), 400).events.length;
    assert.equal(a, 400, 'prob 100 always fires');
    assert.ok(r <= 40, 'prob 1 fires rarely: ' + r + '/400');
    const half = makeTrack(16, [0]);
    half.stepData = { 0: { prob: 50 } };
    const h = compileRender(lockMachine({ tracks: [half] }), 400).events.length;
    assert.ok(h >= 140 && h <= 260, 'prob 50 over 400 cycles: ' + h);
  },
  function conditionsAndFill() {
    const track = makeTrack(16, [0]);
    track.stepData = { 0: { cond: { a: 3, b: 4 } } };
    const out = compileRender(lockMachine({ tracks: [track] }), 8);
    // patternLoopSteps stretches to 64 (16 * b), so 8 loops = 32 track cycles;
    // 3:4 fires on cycles 2, 6, 10, ... = 8 hits.
    assert.equal(out.events.length, 8, '3:4 over 32 cycles');
    for (const e of out.events) {
      const cycle = Math.round(e.tSec / 2);
      assert.equal((cycle - 2) % 4, 0, '3:4 fired on cycle ' + cycle);
    }
    const fillTrack = makeTrack(16, [0, 4]);
    fillTrack.stepData = { 0: { cond: 'fill' }, 4: { cond: 'notfill' } };
    const quiet = compileWindow(lockMachine({ tracks: [fillTrack] }), 0, 2, { fill: false }).events;
    const loud = compileWindow(lockMachine({ tracks: [fillTrack] }), 0, 2, { fill: true }).events;
    assert.deepEqual(quiet.map((e) => e.tSec), [0.5], 'notfill only when quiet');
    assert.deepEqual(loud.map((e) => e.tSec), [0], 'fill only when filling');
  },
  function componentsShapeTime() {
    const track = makeTrack(16, [0, 4]);
    track.stepData = {
      0: { ratchet: 3 },
      4: { nudge: 0.25, gate: 0.5, pitch: -12 },
    };
    const { events } = compileWindow(lockMachine({ tracks: [track] }), 0, 2);
    const ratchets = events.filter((e) => e.tSec < 0.2);
    assert.deepEqual(ratchets.map((e) => +(e.tSec * 24).toFixed(6)), [0, 1, 2],
      'ratchet x3 at exact thirds of the step');
    const nudged = events.find((e) => e.ratchetIndex === 0 && e.tSec > 0.2);
    close(nudged.tSec, 0.5 + 0.125 * 0.25, 1e-9, 'nudge +25%');
    close(nudged.durSec, 0.0625, 1e-9, 'gate 50% of a step');
    close(nudged.rate, 0.5, 1e-12, 'pitch -12 halves rate');
  },
  function velocityAndLocks() {
    const track = makeTrack(16, [0, 1], { gainDb: 0, pan: -1 });
    track.stepData = {
      0: { velocity: 0.5 },
      1: { gainDb: -6, pan: 1 },
    };
    const { events } = compileWindow(lockMachine({ tracks: [track] }), 0, 0.3);
    close(events[0].gain, 0.5, 1e-9, 'velocity scales gain');
    assert.equal(events[0].pan, -1, 'track pan without lock');
    close(events[1].gain, Math.pow(10, -6 / 20), 1e-9, 'gain lock overrides');
    assert.equal(events[1].pan, 1, 'pan lock overrides');
  },
  function duckRouting() {
    const kick = makeTrack(16, [0]);
    const bass = makeTrack(16, [8], { duckSource: 0, duckDb: 18 });
    const self = makeTrack(16, [0], { duckSource: 2 }); // self-duck must be ignored
    const { events, ducks } = compileWindow(
      lockMachine({ tracks: [kick, bass, self] }), 0, 2);
    assert.ok(events.length >= 2);
    assert.deepEqual(ducks, [{ tSec: 0, track: 1, depthDb: 18 }],
      'kick hit ducks the bass only, never itself');
  },
  function liveOfflineParity() {
    const track = makeTrack(16, [0, 3, 7, 12]);
    track.stepData = {
      0: { prob: 60, ratchet: 2 },
      3: { cond: { a: 1, b: 2 } },
      7: { nudge: -0.3, pitch: 5 },
      12: { velocity: 0.7, gate: 1.5 },
    };
    const machine = lockMachine({ tracks: [track] });
    const whole = compileRender(machine, 4);
    const stitched = { events: [], ducks: [] };
    const slice = 0.173; // deliberately ugly window size
    for (let t = 0; t < whole.totalSec; t += slice) {
      const w = compileWindow(machine, t, Math.min(t + slice, whole.totalSec));
      stitched.events.push(...w.events);
      stitched.ducks.push(...w.ducks);
    }
    assert.deepEqual(stitched.events, whole.events, 'stitched windows equal render');
  },
];

const { repairChannel } = await import('../workers/repair-worker.js');
import { FFT as RepairFFT, hann as repairHann } from '../js/fft.js';

function repairFixture() {
  const sr = 48000;
  const n = sr * 3;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / sr);
  let phase = 0;
  for (let i = sr; i < Math.floor(1.2 * sr); i++) {
    const t = (i - sr) / sr;
    phase += 2 * Math.PI * (2000 + 30000 * t) / sr;
    x[i] += 0.4 * Math.sin(phase);
  }
  return x;
}

function binDb(x, frame, bin) {
  const N = 4096;
  const fft = new RepairFFT(N);
  const win = repairHann(N);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let i = 0; i < N; i++) { re[i] = x[frame * 1024 + i] * win[i]; im[i] = 0; }
  fft.forward(re, im);
  return 20 * Math.log10(Math.hypot(re[bin], im[bin]) + 1e-12);
}

const REPAIR_REGION = { t0: 0.98, t1: 1.22, f0: 1800, f1: 8500, strength: 1 };

const repairCases = [
  function chirpRemovalAndTonePreservation() {
    const orig = repairFixture();
    const x = orig.slice();
    repairChannel(x, 48000, REPAIR_REGION);
    // frame 48 centers ~1.066 s; the chirp passes ~4 kHz there (bin 340)
    const dropDb = binDb(orig, 48, 340) - binDb(x, 48, 340);
    assert.ok(dropDb >= 20, 'chirp bin attenuation ' + dropDb.toFixed(1) + ' dB, want >= 20');
    // 440 Hz tone (bin ~37.5 -> probe 38) must survive inside the region
    const toneDelta = Math.abs(binDb(orig, 48, 38) - binDb(x, 48, 38));
    assert.ok(toneDelta < 0.5, '440 Hz tone moved ' + toneDelta.toFixed(2) + ' dB');
  },
  function strengthScalesInLogDomain() {
    const orig = repairFixture();
    const full = orig.slice();
    const half = orig.slice();
    repairChannel(full, 48000, REPAIR_REGION);
    repairChannel(half, 48000, { ...REPAIR_REGION, strength: 0.5 });
    const o = binDb(orig, 48, 340);
    const f = binDb(full, 48, 340);
    const h = binDb(half, 48, 340);
    const midpoint = (o + f) / 2;
    assert.ok(Math.abs(h - midpoint) < 3, 'strength 0.5 lands at the dB midpoint: ' + h.toFixed(1) + ' vs ' + midpoint.toFixed(1));
  },
  function editLocalityAndLength() {
    const orig = repairFixture();
    const x = orig.slice();
    repairChannel(x, 48000, REPAIR_REGION);
    assert.equal(x.length, orig.length, 'length preserved');
    let firstDiff = -1;
    let lastDiff = -1;
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== orig[i]) { if (firstDiff < 0) firstDiff = i; lastDiff = i; }
    }
    // region +- (time feather 4 frames * 1024 + window/2 + crossfade): stay within 150 ms
    assert.ok(firstDiff / 48000 > REPAIR_REGION.t0 - 0.15, 'edit starts near region: ' + (firstDiff / 48000).toFixed(3));
    assert.ok(lastDiff / 48000 < REPAIR_REGION.t1 + 0.15, 'edit ends near region: ' + (lastDiff / 48000).toFixed(3));
  },
  function repairDeterministic() {
    const a = repairFixture();
    const b = repairFixture();
    repairChannel(a, 48000, REPAIR_REGION);
    repairChannel(b, 48000, REPAIR_REGION);
    assert.deepEqual(a, b, 'two repairs bit-identical');
  },
];

const groups = [
  ['BS.1770', loudnessCases],
  ['beat tracking', beatCases],
  ['pattern compiler', patternCases],
  ['TRUTH 1 DSP', truthCases],
  ['LOCK compiler', lockCases],
  ['spectral repair', repairCases],
];

for (const [name, cases] of groups) {
  const started = performance.now();
  try {
    for (const testCase of cases) await testCase();
  } catch (error) {
    process.stderr.write(`not ok - ${name}\\n`);
    throw error;
  }
  const elapsed = performance.now() - started;
  process.stdout.write(`ok - ${name}: ${cases.length} cases (${elapsed.toFixed(1)} ms)\\n`);
}
