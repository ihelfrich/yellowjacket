import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { onsetAnalysis } from '../js/analysis/onsets.js';
import { trackBeats } from '../js/analysis/beattrack.js';
import { kWeightingCoeffs, measureLoudness } from '../js/dsp/loudness.js';
import {
  compileRender,
  compileSong,
  compileWindow,
  normalizeVoice,
  patternLoopSteps,
  stepTime,
} from '../js/machine/compile.js';
import { resample } from '../js/dsp/resample.js';
import { truePeakDb } from '../js/dsp/truepeak.js';
import { createProject, registerAsset } from '../js/app/project-store.js';
import { serializeProject, applySnapshot, FORMAT_VERSION } from '../js/app/persist.js';
import { buildDrumPatch, parseDrumPatch, positionOf, PATCH_MAX_FRAMES } from '../js/export/op1patch.js';
import { planTicks, midiTimestampFor, ClockIn } from '../js/midi/clock.js';
import { parseMidiMessage } from '../js/midi/wire.js';
import { harvest, ROLE_QUOTAS, HARVEST_MAX_PICKS } from '../js/analysis/harvest.js';
import { nextId, addMeta, removeMeta, listFromIndex } from '../js/app/crate.js';
import { existsSync } from 'node:fs';

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

// ---------- persist roundtrip (CONTRACT-PERSIST) ----------

function persistChain() {
  return [
    { id: 'highpass', on: true, params: { freq: 80 } },
    { id: 'eq', on: false, params: { lowGain: 0, midGain: 0 } },
  ];
}

// A populated project + runtime pair: words, clips, chain edits, repairs,
// anchors, two sample assets with one ref shared across scenes.
function persistFixture() {
  const p = createProject(persistChain());
  const r = { repairs: [], analysis: null, sourceBytes: null };
  p.fileName = 'field-notes.mp3';
  p.words = [
    { text: 'hello', start: 0.1, end: 0.4, deleted: false, filler: false },
    { text: 'um', start: 0.6, end: 0.7, deleted: true, filler: true },
  ];
  p.clips.push({ id: 'c1', start: 0.1, end: 1.1, gain: 1, tag: 'word', label: 'hello' });
  p.chain[1].on = true;
  p.chain[1].params.lowGain = 3;
  r.repairs.push({ id: 'rp1', t0: 1.0, t1: 1.2, f0: 2000, f1: 8000, strength: 1, enabled: true, label: 'R1' });
  r.analysis = { tempo: 128.2, beats: [0.1], anchors: { bpm: 128, barOneTime: 0.46 } };
  r.sourceBytes = new ArrayBuffer(4321);
  const pcmA = { channels: [Float32Array.from([0.1, -0.2, 0.3]), Float32Array.from([0.05, 0, -0.5])], sampleRate: 44100, label: 'KICK' };
  const pcmB = { channels: [Float32Array.from([1, -1, 0.5, 0.25])], sampleRate: 48000, label: 'HAT' };
  const idA = registerAsset(p, { kind: 'sample', label: 'KICK', sampleRate: 44100, frames: 3 });
  const idB = registerAsset(p, { kind: 'sample', label: 'HAT', sampleRate: 48000, frames: 4 });
  const s0 = p.machine.scenes[0];
  s0.bpm = 174;
  s0.tracks[0].sampleId = idA;
  s0.tracks[0].sample = pcmA;
  s0.tracks[0].steps[4] = 1;
  s0.tracks[0].stepData[4] = { velocity: 0.5, futureKnob: 7 };
  s0.tracks[2].sampleId = idB;
  s0.tracks[2].sample = pcmB;
  const s1 = p.machine.scenes[1];
  s1.bpm = 96;
  s1.tracks[0].sampleId = idA;   // shared ref: must dedupe to one file
  s1.tracks[0].sample = pcmA;
  p.machine.activeScene = 1;
  p.wire.inId = 'port-a';
  p.wire.clockOut = true;
  p.wire.noteBase = 60;
  p.wire.mappings.fill = { kind: 'cc', channel: 0, num: 64 };
  p.wire.mappings.mute3 = { kind: 'note', channel: 9, num: 42 };
  s0.tracks[0].voice.start = 0.1;
  s0.tracks[0].voice.end = 0.9;
  s0.tracks[0].voice.pitch = -12;
  s0.tracks[0].voice.release = 240;
  s0.tracks[0].voice.reverse = true;
  s0.tracks[0].voice.lpf = 800;
  s0.tracks[0].voice.res = 2.5;
  s0.tracks[0].voice.hpf = 60;
  s0.tracks[0].voice.drive = 9;
  p.machine.song.chain.push({ scene: 0, reps: 2 }, { scene: 1, reps: 4 });
  p.machine.song.loop = false;
  return { p, r, idA, idB };
}

const persistCases = [
  function serializeShapeAndDedupe() {
    const { p, r, idA, idB } = persistFixture();
    const { json, sampleFiles } = serializeProject(p, r);
    assert.equal(json.formatVersion, FORMAT_VERSION, 'formatVersion');
    assert.deepEqual(json.sourceBytes, { size: 4321 }, 'sourceBytes size only');
    assert.equal(sampleFiles.length, 2, '3 refs dedupe to 2 files');
    const fileA = sampleFiles.find((f) => f.id === idA);
    assert.equal(fileA.bytes.byteLength, 2 * 3 * 4, 'per-channel f32 bytes');
    assert.equal(json.assets[idA].channelCount, 2, 'channelCount derived from PCM');
    assert.equal(json.assets[idB].channelCount, 1, 'mono channelCount');
    assert.ok(!Object.getOwnPropertyNames(json.machine).includes('tracks'), 'no aliased machine.tracks');
    assert.ok(!('sample' in json.machine.scenes[0].tracks[0]), 'runtime PCM never serialized');
  },
  function roundtripDeepEqual() {
    const { p, r } = persistFixture();
    const { json, sampleFiles } = serializeProject(p, r);
    const wire = JSON.parse(JSON.stringify(json));
    const p2 = createProject(persistChain());
    const r2 = { repairs: [], analysis: null, sourceBytes: null };
    const plan = applySnapshot(wire, { project: p2, runtime: r2 });
    for (const att of plan.sampleAttachments) {
      const meta = wire.assets[att.assetId];
      const file = sampleFiles.find((f) => f.id === att.assetId);
      const flat = new Float32Array(file.bytes);
      const channels = [];
      for (let c = 0; c < meta.channelCount; c++) channels.push(flat.slice(c * meta.frames, (c + 1) * meta.frames));
      p2.machine.scenes[att.sceneIndex].tracks[att.trackIndex].sample = { channels, sampleRate: meta.sampleRate, label: meta.label };
    }
    r2.sourceBytes = new ArrayBuffer(4321);
    r2.analysis = { anchors: plan.anchors };
    const round = serializeProject(p2, r2);
    const a = { ...round.json };
    const b = { ...wire };
    delete a.savedAt;
    delete b.savedAt;
    assert.deepEqual(a, b, 'serialize -> apply -> serialize is a fixed point');
    for (const f of sampleFiles) {
      const again = round.sampleFiles.find((x) => x.id === f.id);
      assert.deepEqual(new Uint8Array(again.bytes), new Uint8Array(f.bytes), 'f32 bytes bit-identical: ' + f.id);
    }
  },
  function applyMutatesInPlace() {
    const { p, r } = persistFixture();
    const { json } = serializeProject(p, r);
    const p2 = createProject(persistChain());
    const r2 = { repairs: [], analysis: null, sourceBytes: null };
    const refs = {
      machine: p2.machine,
      scenes: p2.machine.scenes,
      steps: p2.machine.scenes[0].tracks[0].steps,
      clips: p2.clips,
      chainEntry: p2.chain[1],
      chainParams: p2.chain[1].params,
      assets: p2.assets,
      repairs: r2.repairs,
    };
    applySnapshot(JSON.parse(JSON.stringify(json)), { project: p2, runtime: r2 });
    assert.equal(p2.machine, refs.machine, 'machine object kept (controllers hold refs)');
    assert.equal(p2.machine.scenes, refs.scenes, 'scenes array kept');
    assert.equal(p2.machine.scenes[0].tracks[0].steps, refs.steps, 'steps Uint8Array instance kept');
    assert.equal(p2.clips, refs.clips, 'clips array kept');
    assert.equal(p2.chain[1], refs.chainEntry, 'chain entry kept (rack UI closes over it)');
    assert.equal(p2.chain[1].params, refs.chainParams, 'chain params object kept');
    assert.equal(p2.assets, refs.assets, 'assets object kept');
    assert.equal(r2.repairs, refs.repairs, 'repairs array kept');
    assert.ok(p2.machine.scenes[0].tracks[0].steps instanceof Uint8Array, 'steps stay typed');
    assert.equal(p2.chain[1].params.lowGain, 3, 'chain params merged by id');
  },
  function sceneAliasSafety() {
    const { p, r } = persistFixture();
    const { json } = serializeProject(p, r);
    assert.equal(json.machine.scenes[0].bpm, 174, 'scene 0 bpm, not the active-scene alias');
    assert.equal(json.machine.scenes[1].bpm, 96, 'scene 1 bpm');
    const p2 = createProject(persistChain());
    applySnapshot(JSON.parse(JSON.stringify(json)), { project: p2, runtime: { repairs: [], analysis: null, sourceBytes: null } });
    assert.equal(p2.machine.activeScene, 1, 'activeScene restored');
    assert.equal(p2.machine.bpm, 96, 'bpm alias reads restored active scene');
    assert.equal(p2.machine.scenes[0].bpm, 174, 'inactive scene written directly');
    assert.ok(typeof Object.getOwnPropertyDescriptor(p2.machine, 'bpm').get === 'function', 'alias still an accessor');
  },
  function forwardToleranceAndClamps() {
    const { p, r } = persistFixture();
    const { json } = serializeProject(p, r);
    const wire = JSON.parse(JSON.stringify(json));
    wire.futureTopLevel = { note: 'newer bench, same version' };
    wire.machine.scenes[0].tracks[0].stepData['4'].anotherFutureKey = 'q';
    wire.machine.scenes[0].tracks[1].steps = new Array(100).fill(2);
    const p2 = createProject(persistChain());
    applySnapshot(wire, { project: p2, runtime: { repairs: [], analysis: null, sourceBytes: null } });
    assert.equal(p2.machine.scenes[0].tracks[0].stepData['4'].futureKnob, 7, 'unknown stepData key survives');
    assert.equal(p2.machine.scenes[0].tracks[0].stepData['4'].anotherFutureKey, 'q', 'wire-added key survives');
    assert.equal(p2.machine.scenes[0].tracks[1].steps.length, 64, 'oversized wire steps clamp to 64');
    assert.equal(p2.machine.scenes[0].tracks[1].steps[63], 2, 'clamped values land');
  },
  function versionGuardThrowsTyped() {
    const target = () => ({ project: createProject(persistChain()), runtime: { repairs: [], analysis: null, sourceBytes: null } });
    assert.throws(
      () => applySnapshot({ formatVersion: 3 }, target()),
      (err) => err.name === 'FormatVersionError' && err.formatVersion === 3,
      'newer formatVersion throws typed',
    );
    assert.throws(
      () => applySnapshot(null, target()),
      (err) => err.name === 'FormatVersionError',
      'null json throws typed',
    );
  },
];

// ---------- op1 patch (CONTRACT-WIRE) ----------

function sineSegment(frames, freq) {
  const s = new Float32Array(frames);
  for (let i = 0; i < frames; i++) s[i] = 0.5 * Math.sin(2 * Math.PI * freq * i / 44100);
  return { samples: s };
}

const op1Cases = [
  function fixedPointGoldens() {
    // Device rule proved against the OP-1 factory tr808 patch (CONTRACT-WIRE 1).
    assert.equal(positionOf(463363), 1880318338, 'factory end[23]');
    assert.equal(positionOf(14174), 57517825, 'factory end[0]');
    assert.equal(positionOf(14175), 57521883, 'factory start[1]');
    assert.equal(positionOf(529200), 2147483646, 'full 12 s hits the int32 ceiling');
    assert.equal(positionOf(0), 0, 'origin');
    assert.equal(positionOf(-5), 0, 'clamps below');
    assert.equal(positionOf(1e9), 2147483646, 'clamps above');
  },
  function buildParseRoundtrip() {
    const segs = [sineSegment(4410, 220), sineSegment(8820, 440), sineSegment(13230, 880)];
    const { bytes, report } = buildDrumPatch({ segments: segs, name: 'harness kit' });
    assert.equal(report.slices, 3, 'three slices');
    assert.equal(report.scaled, false, 'under budget');
    const parsed = parseDrumPatch(bytes);
    assert.equal(parsed.sampleRate, 44100, 'rate');
    assert.equal(parsed.channels, 1, 'mono');
    assert.equal(parsed.bitDepth, 16, '16-bit');
    assert.equal(parsed.frames, 4410 + 8820 + 13230, 'frames concatenate');
    const j = parsed.json;
    assert.equal(j.type, 'drum', 'type');
    assert.equal(j.drum_version, 1, 'drum_version');
    assert.equal(j.start.length, 24, '24 starts');
    assert.equal(j.end.length, 24, '24 ends');
    assert.equal(j.start[0], 0, 'slice 0 starts at origin');
    assert.equal(j.end[0], positionOf(4409), 'slice 0 end');
    assert.equal(j.start[1], positionOf(4410), 'slice 1 start');
    assert.equal(j.end[2], positionOf(4410 + 8820 + 13230 - 1), 'last real end');
    for (let s = 3; s < 24; s++) {
      assert.equal(j.start[s], j.start[2], 'slot ' + s + ' duplicates last start');
      assert.equal(j.end[s], j.end[2], 'slot ' + s + ' duplicates last end');
    }
    assert.equal(j.playmode[0], 8192, 'one-shot');
    assert.equal(j.volume[0], 8192, 'unity volume');
  },
  function byteLayout() {
    const { bytes } = buildDrumPatch({ segments: [sineSegment(4410, 330)], name: 'x' });
    const v = new DataView(bytes);
    const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    assert.equal(tag(0), 'FORM', 'FORM');
    assert.equal(v.getUint32(4), bytes.byteLength - 8, 'FORM size');
    assert.equal(tag(8), 'AIFF', 'AIFF form type');
    assert.equal(tag(12), 'COMM', 'COMM first');
    assert.equal(v.getUint32(16), 18, 'COMM size 18');
    assert.equal(v.getInt16(20), 1, 'mono');
    assert.equal(v.getInt16(26), 16, '16-bit');
    // 80-bit extended 44100: 40 0E AC 44 00...
    const ext = [0x40, 0x0E, 0xAC, 0x44, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 10; i++) assert.equal(v.getUint8(28 + i), ext[i], 'extended rate byte ' + i);
    assert.equal(tag(38), 'APPL', 'APPL after COMM');
    const applSize = v.getUint32(42);
    assert.equal(applSize % 2, 0, 'APPL size even');
    assert.equal(tag(46), 'op-1', 'op-1 signature');
    assert.equal(tag(46 + applSize), 'SSND', 'SSND after APPL');
    assert.equal(v.getUint32(50 + applSize), 8 + 2 * 4410, 'SSND size');
  },
  function overBudgetScales() {
    const long = Math.floor(PATCH_MAX_FRAMES * 0.7);
    const { report } = buildDrumPatch({ segments: [sineSegment(long, 110), sineSegment(long, 220)], name: 'big' });
    assert.equal(report.scaled, true, 'reports scaling');
    assert.ok(report.frames <= PATCH_MAX_FRAMES, 'fits the 12 s budget');
  },
  async function factoryPatchParses() {
    // Real TE factory content: local-only fixture, never committed.
    if (!existsSync(new URL('../test_factory_drum.aif', import.meta.url))) return;
    const buf = await readFile(new URL('../test_factory_drum.aif', import.meta.url));
    const parsed = parseDrumPatch(buf);
    assert.equal(parsed.frames, 463364, 'factory frames');
    assert.equal(parsed.json.name, 'tr808', 'factory name');
    assert.equal(parsed.json.end[23], 1880318338, 'factory end[23]');
    assert.equal(parsed.json.end[0], 57517825, 'factory end[0]');
  },
];

// ---------- midi clock (CONTRACT-WIRE) ----------

const midiCases = [
  function parsesChannelVoiceAndRealtime() {
    assert.deepEqual(parseMidiMessage([0x90, 60, 100]), { type: 'noteon', channel: 0, note: 60, velocity: 100 }, 'noteon ch1');
    assert.deepEqual(parseMidiMessage([0x9F, 61, 0]), { type: 'noteoff', channel: 15, note: 61, velocity: 0 }, 'vel-0 is noteoff');
    assert.deepEqual(parseMidiMessage([0x80, 60, 64]), { type: 'noteoff', channel: 0, note: 60, velocity: 64 }, 'noteoff');
    assert.deepEqual(parseMidiMessage([0xB2, 53, 127]), { type: 'cc', channel: 2, num: 53, value: 127 }, 'cc');
    assert.deepEqual(parseMidiMessage([0xF8]), { type: 'clocktick' }, 'tick');
    assert.deepEqual(parseMidiMessage([0xFA]), { type: 'start' }, 'start');
    assert.deepEqual(parseMidiMessage([0xFC]), { type: 'stop' }, 'stop');
    assert.equal(parseMidiMessage([0xE0, 0, 64]), null, 'pitch bend ignored');
    assert.equal(parseMidiMessage([]), null, 'empty ignored');
  },
  function planTicksSpacingAndSeams() {
    const whole = planTicks(0, 1, 120, null);
    assert.equal(whole.ticks.length, 48, '48 ticks per second at 120');
    for (let i = 1; i < whole.ticks.length; i++) {
      close(whole.ticks[i] - whole.ticks[i - 1], 1 / 48, 1e-9, 'tick spacing');
    }
    const a = planTicks(0, 0.5, 120, null);
    const b = planTicks(0.5, 1, 120, a.phase);
    assert.deepEqual(a.ticks.concat(b.ticks), whole.ticks, 'window seam is exact');
  },
  function tempoChangeKeepsPhase() {
    const a = planTicks(0, 0.5, 120, null);
    const b = planTicks(0.5, 1, 174, a.phase);
    const all = a.ticks.concat(b.ticks);
    for (let i = 1; i < all.length; i++) assert.ok(all[i] > all[i - 1], 'monotonic across tempo change');
    assert.equal(b.ticks[0], a.phase, 'first new-tempo tick lands on carried phase');
    close(b.ticks[2] - b.ticks[1], 60 / (174 * 24), 1e-9, 'new spacing after seam');
  },
  function timestampConversion() {
    assert.equal(midiTimestampFor(1.5, 1.2, 5000), 5300, 'audio to DOMHighRes mapping');
  },
  function clockInConvergesAndGates() {
    const ci = new ClockIn();
    const period = 60000 / (120 * 24);
    let t = 1000;
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    for (let i = 0; i < 100; i++) { ci.feed(t); t += period + rand(); }
    assert.ok(Math.abs(ci.bpm - 120) < 0.5, 'converges near 120: ' + ci.bpm.toFixed(3));
    assert.equal(ci.stable, true, 'stable after a clean run');
    const before = ci.bpm;
    ci.feed(t + 40);   // 40 ms outlier
    assert.equal(ci.bpm, before, 'outlier leaves the estimate untouched');
    assert.equal(ci.stable, false, 'outlier breaks stability');
    ci.reset();
    assert.equal(ci.bpm, null, 'reset clears');
  },
];

// ---------- song compiler (CONTRACT-SONG) ----------

const { planEnvelope } = await import('../js/machine/sequencer.js');

function songMachine() {
  const mkTrack = (steps, extras = {}) => ({
    sample: { channels: [new Float32Array(4410)], sampleRate: 44100 },
    steps: Uint8Array.from(steps),
    stepData: {},
    len: 16,
    gainDb: 0, pan: 0, mute: false, solo: false,
    duckSource: -1, duckDb: 12, choke: false,
    ...extras,
  });
  const scene = (i, bpm, tracks) => ({ id: 's' + i, name: 'S' + i, bpm, swing: 50, seed: (i + 1) * 7919, tracks });
  const scenes = [
    scene(0, 120, [mkTrack([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])]),
    scene(1, 60, [mkTrack([1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0])]),
  ];
  const m = { activeScene: 0, scenes, song: { chain: [], loop: true } };
  Object.defineProperties(m, {
    tracks: { get() { return this.scenes[this.activeScene].tracks; } },
    bpm: { get() { return this.scenes[this.activeScene].bpm; } },
    swing: { get() { return this.scenes[this.activeScene].swing; } },
  });
  return m;
}

const songCases = [
  function voiceNeutralIsInvisible() {
    const a = songMachine();
    const b = songMachine();
    b.scenes[0].tracks[0].voice = normalizeVoice(null);
    const ea = compileRender(a, 2).events;
    const eb = compileRender(b, 2).events;
    assert.deepEqual(eb, ea, 'default voice compiles identically to no voice');
    for (const ev of ea) {
      assert.ok(!('offsetSec' in ev) && !('attackSec' in ev), 'neutral events carry no voice fields');
    }
  },
  function voicePitchAndTrim() {
    const m = songMachine();
    m.scenes[0].tracks[0].voice = { start: 0.25, end: 0.75, pitch: -12, attack: 3, release: 8, reverse: false };
    const ev = compileRender(m, 1).events[0];
    assert.equal(ev.rate, 0.5, 'pitch -12 halves the rate exactly');
    close(ev.offsetSec, 0.025, 1e-12, 'trim start offset (0.25 of 100 ms)');
    close(ev.sliceSec, 0.05, 1e-12, 'trim span');
    const mr = songMachine();
    mr.scenes[0].tracks[0].voice = { start: 0.25, end: 0.75, pitch: 0, attack: 3, release: 8, reverse: true };
    const evr = compileRender(mr, 1).events[0];
    assert.equal(evr.reverse, true, 'voice reverse');
    close(evr.offsetSec, 0.025, 1e-12, 'reversed offset = (1-end)*bufSec');
  },
  function compileSongSections() {
    const m = songMachine();
    m.song.chain.push({ scene: 0, reps: 4 }, { scene: 1, reps: 1 });
    const song = compileSong(m);
    assert.equal(song.sections.length, 2, 'two sections');
    assert.equal(song.sections[0].endSec, 8, 'A: 16 steps at 120 x4 = 8 s');
    assert.equal(song.sections[1].startSec, 8, 'B starts exactly at the boundary');
    assert.equal(song.sections[1].loopSec, 4, 'B: 16 steps at 60 = 4 s');
    assert.equal(song.totalSec, 12, 'total');
    const bEvents = song.events.filter((e) => e.tSec >= 8);
    close(bEvents[0].tSec, 8, 1e-12, 'B grid lands on the section start');
    close(bEvents[1].tSec, 10, 1e-9, 'B spacing uses scene B bpm');
  },
  function songParityAndDeterminism() {
    const m = songMachine();
    m.song.chain.push({ scene: 0, reps: 1 }, { scene: 0, reps: 1 });
    const song = compileSong(m);
    const twice = compileRender(m, 2);
    assert.deepEqual(song.events, twice.events, 'chain [Ax1,Ax1] equals render(A,2)');
    assert.deepEqual(compileSong(m), song, 'compiles are deterministic');
  },
  function envelopePlanShape() {
    // 100 ms slice at half rate = 200 ms wall; release ends AT the wall end.
    const p = planEnvelope({ rate: 0.5, sliceSec: 0.1, attackSec: 0.01, releaseSec: 0.05 });
    close(p.releaseEndSec, 0.2, 1e-12, 'release ends at wall end');
    close(p.releaseStartSec, 0.15, 1e-12, 'release starts releaseSec earlier');
    const gated = planEnvelope({ rate: 1, sliceSec: 0.5, durSec: 0.0625, attackSec: 0.003, releaseSec: 0.008 });
    close(gated.releaseEndSec, 0.0625, 1e-12, 'gate lock wins when shorter');
    const clamped = planEnvelope({ rate: 1, sliceSec: 0.004, attackSec: 0.003, releaseSec: 0.05 });
    assert.ok(clamped.releaseStartSec >= 0.003, 'release never starts before the attack peak');
  },
];

// ---------- harvest + crate (CONTRACT-HARVEST) ----------

// Seeded noise: an LCG once produced real lattice periodicity that the beat
// tracker correctly detected, so fixtures use mulberry32 everywhere.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function harvestScene() {
  const sr = 44100;
  const dur = 12;
  const x = new Float32Array(sr * dur);
  const rand = mulberry32(0x5eed);
  const mix = (at, samples) => {
    const o = Math.round(at * sr);
    for (let i = 0; i < samples.length && o + i < x.length; i++) x[o + i] += samples[i];
  };
  const kick = () => {
    const n = Math.round(0.16 * sr);
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = Math.sin(2 * Math.PI * 60 * i / sr) * Math.exp(-i / (0.035 * sr));
    return s;
  };
  const hat = () => {
    const n = Math.round(0.03 * sr);
    const s = new Float32Array(n);
    let hp = 0;
    for (let i = 0; i < n; i++) {
      const w = rand() * 2 - 1;
      hp = 0.85 * (hp + w);
      s[i] = hp * 0.5 * Math.exp(-i / (0.006 * sr));
    }
    return s;
  };
  const pad = (freq, secs) => {
    const n = Math.round(secs * sr);
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / (0.15 * sr)) * Math.min(1, (n - i) / (0.2 * sr));
      s[i] = 0.4 * env * (Math.sin(2 * Math.PI * freq * i / sr) + 0.3 * Math.sin(4 * Math.PI * freq * i / sr));
    }
    return s;
  };
  const onsets = [];
  for (let bar = 0; bar < 4; bar++) {
    const t = bar * 1.0;
    mix(t, kick()); onsets.push(t);
    mix(t + 0.5, hat()); onsets.push(t + 0.5);
  }
  // A held pad in a long gap: no flux peak, so only the seed sweep can find it.
  mix(5.0, pad(220, 2.2));
  mix(8.0, pad(110, 2.5));
  return { mono: x, sampleRate: sr, onsets };
}

const harvestCases = [
  function findsAndClassifiesPlants() {
    const { mono, sampleRate, onsets } = harvestScene();
    const { picks } = harvest(mono, sampleRate, onsets);
    assert.ok(picks.length > 0, 'harvest returns picks');
    assert.ok(picks.length <= HARVEST_MAX_PICKS, 'never exceeds 24 picks');
    for (let i = 1; i < picks.length; i++) {
      assert.ok(picks[i].t0 >= picks[i - 1].t0, 'picks are timeline-ordered');
    }
    const roles = new Set(picks.map((p) => p.role));
    assert.ok(roles.size >= 2, 'more than one role is represented: ' + Array.from(roles).join(','));
    for (const pick of picks) {
      assert.ok(pick.t1 > pick.t0, 'span is well-formed');
      assert.ok(/^[A-Z]+ \d+$/.test(pick.label), 'label is role-numbered: ' + pick.label);
    }
  },
  function quotasAndSpread() {
    const { mono, sampleRate, onsets } = harvestScene();
    const { picks } = harvest(mono, sampleRate, onsets);
    const perRole = {};
    for (const p of picks) perRole[p.role] = (perRole[p.role] || 0) + 1;
    for (const role of Object.keys(perRole)) {
      assert.ok(perRole[role] <= ROLE_QUOTAS[role] || picks.length < HARVEST_MAX_PICKS,
        role + ' respects quota ' + ROLE_QUOTAS[role]);
    }
    // Material spread across the file, not clustered in the first bars.
    const span = picks[picks.length - 1].t0 - picks[0].t0;
    assert.ok(span > 3, 'picks spread across the track: ' + span.toFixed(2) + 's');
  },
  function seedSweepFindsSustainedMaterial() {
    // The pads sit in gaps with no onsets; only the seed sweep reaches them.
    const { mono, sampleRate, onsets } = harvestScene();
    const { picks } = harvest(mono, sampleRate, onsets);
    const late = picks.filter((p) => p.t0 >= 5 && p.t0 <= 10.5);
    assert.ok(late.length > 0, 'sustained pad region yields picks');
  },
  function degenerateInputs() {
    assert.deepEqual(harvest(null, 44100, [0]), { picks: [], candidates: [] }, 'null mono');
    assert.deepEqual(harvest(new Float32Array(64), 0, [0]), { picks: [], candidates: [] }, 'zero rate');
  },
  function deterministic() {
    const { mono, sampleRate, onsets } = harvestScene();
    assert.deepEqual(harvest(mono, sampleRate, onsets).picks, harvest(mono, sampleRate, onsets).picks,
      'same input, same picks');
  },
];

const crateCases = [
  function indexMathRoundtrips() {
    let index = { maxId: 0, items: [] };
    const id1 = nextId(index);
    index = addMeta(index, { id: id1, name: 'KICK', role: 'KICK', source: 'a.wav', sampleRate: 44100, seconds: 0.3 });
    const id2 = nextId(index);
    index = addMeta(index, { id: id2, name: 'VOX', role: 'VOX', source: 'b.wav', sampleRate: 48000, seconds: 1.1 });
    assert.notEqual(id1, id2, 'ids are unique');
    assert.equal(index.items.length, 2, 'both metas present');
    const listed = listFromIndex(index);
    assert.equal(listed.length, 2, 'list returns both');
    index = removeMeta(index, id1);
    assert.equal(index.items.length, 1, 'removal drops one');
    assert.equal(index.items[0].id, id2, 'the right one survives');
    // Ids never recycle after a removal: a stale <id>.f32 must not be reused.
    const id3 = nextId(index);
    assert.notEqual(id3, id1, 'ids do not recycle');
    assert.notEqual(id3, id2, 'ids stay unique after removal');
  },
  function crossSourceInstrumentsCoexist() {
    let index = { maxId: 0, items: [] };
    for (const src of ['deadmau5.wav', 'fred-again.wav', 'deadmau5.wav']) {
      const id = nextId(index);
      index = addMeta(index, { id, name: 'INST', role: 'TONE', source: src, sampleRate: 44100, seconds: 0.5 });
    }
    const sources = new Set(listFromIndex(index).map((m) => m.source));
    assert.equal(sources.size, 2, 'instruments from two different songs live side by side');
    assert.equal(listFromIndex(index).length, 3, 'all three kept');
  },
];

const groups = [
  ['BS.1770', loudnessCases],
  ['beat tracking', beatCases],
  ['pattern compiler', patternCases],
  ['TRUTH 1 DSP', truthCases],
  ['LOCK compiler', lockCases],
  ['spectral repair', repairCases],
  ['persist roundtrip', persistCases],
  ['op1 patch', op1Cases],
  ['midi clock', midiCases],
  ['song compiler', songCases],
  ['harvest', harvestCases],
  ['crate index', crateCases],
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
