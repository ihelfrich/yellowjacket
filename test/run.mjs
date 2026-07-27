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
  function currentIntersamplePeakGolden() {
    // This deliberately locks the current 8-tap/3-phase estimator until TRUTH 1.
    const pcm = tone(48000, 0.5, 12000, 0.8, Math.PI / 4);
    const result = measureLoudness({ channels: [pcm], sampleRate: 48000 });
    close(result.samplePeakDb, -4.948500, 0.01, 'intersample sample peak');
    close(result.truePeakDb, -2.115303, 0.01, 'current intersample estimator');
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
    }, 0, 0.001);
    assert.deepEqual(events.map((event) => event.gain), [0, 1, 0]);
  },
  function adjacentWindowBoundary() {
    const machine = {
      bpm: 120,
      swing: 50,
      tracks: [makeTrack(16, [0, 1])],
    };
    const left = compileWindow(machine, 0, 0.125);
    const right = compileWindow(machine, 0.125, 0.25);
    const whole = compileWindow(machine, 0, 0.25);
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

const groups = [
  ['BS.1770', loudnessCases],
  ['beat tracking', beatCases],
  ['pattern compiler', patternCases],
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
