import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import {
  serializeProject, snapshotDoc, applySnapshot, hydrateSample, projectHasContent, FORMAT_VERSION,
} from '../js/app/persist.js';
import { ProjectStore, createSpace, createVoice } from '../js/app/project-store.js';
import { DEMO_TRACK, sourceReplacementNeedsConfirmation } from '../js/app/source-controller.js';
import { FIELD_RECORDINGS, fieldLicenseUrl } from '../js/app/field-library.js';
import {
  sniffSampleRate, planDecodeRate, probeContainer, decodedFootprintBytes,
} from '../js/dsp/native-rate.js';
import { parseSmf, smfToStudio } from '../js/midi/smf.js';
import { encodeWav, encodeWavWithStats } from '../js/export.js';
import { bounceSampleRate } from '../js/studio/engine.js';
import { Engine } from '../js/audio-engine.js';
import { deriveStages } from '../js/app/pipeline-ui.js';
import { renderFormula, compileFormula, SYNTH_PRESETS } from '../js/machine/synth.js';
import {
  DRUM_ENGINE_VERSION, DRUM_INTERNAL_RATE, DRUM_OVERSAMPLE, DRUM_RATE,
  renderFactoryVoice, supportedDrumModels,
} from '../js/machine/drum-dsp.js';
import {
  FACTORY_KITS, drumAssetId, getFactoryKit, grooveFor, kitInstallPlan,
  renderFactoryKit, starterGrooveForRoles,
} from '../js/machine/kits.js';
import { fitModal, synthModal } from '../js/analysis/modal.js';
import { buildDrumPatch, parseDrumPatch, positionOf, PATCH_MAX_FRAMES } from '../js/export/op1patch.js';
import { planTicks, midiTimestampFor, ClockIn } from '../js/midi/clock.js';
import { parseMidiMessage } from '../js/midi/wire.js';
import { ndsi } from '../js/analysis/soundscape.js';
import {
  harvest, ROLE_QUOTAS, HARVEST_MAX_PICKS, planKitAssignment, kitGainFor, peakOfChannels,
} from '../js/analysis/harvest.js';
import { project2d, standardize, axisLabel } from '../js/analysis/constellation.js';
import { stretchSamples, stretchMode } from '../js/dsp/stretch.js';
import { plateImpulse, delayTimeFor, dampingCoeff } from '../js/dsp/space.js';
import { nextId, addMeta, removeMeta, listFromIndex } from '../js/app/crate.js';
import {
  buildBundle, readBundle, projectEntries, parseProjectEntries, safeProjectName,
} from '../js/app/project-bundle.js';
import {
  applyInstrumentPreset, chordNotes, createStudio, noteName, normalizeStep,
  generateStudioIdea, scaleNote, studioStepDuration, studioStepSeconds, transformStudioBar,
} from '../js/studio/model.js';
import { studioMidiFile, variableLength } from '../js/studio/midi.js';
import { compileStudioScore } from '../js/studio/compile.js';
import {
  canonicalLoomPlanId, compileLoomPlan, demoMidiGesture, LOOM_TRANSCRIPT_MAX_VOICES,
  LOOM_TRANSCRIPT_MAX_WORDS, sourceMatchesPlan, spanMaterials, studioGesture,
  sameLoomPlanContent, traceLoomEvent, transcriptMaterials, TranscriptMaterialError,
} from '../js/loom/compile.js';
import { sha256HexSync } from '../js/loom/identity.js';
import { loomHeadroomGain } from '../js/loom/engine.js';
import { captureBarDuration, capturedMidiGesture } from '../js/loom/capture.js';
import {
  compileLoomWindow, compilePerformanceRender, compilePerformanceWindow,
} from '../js/performance/compile.js';
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
// Node 16 has EventTarget but not CustomEvent; the store dispatches one.
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class extends Event {
    constructor(type, opts = {}) {
      super(type, opts);
      this.detail = opts.detail;
    }
  };
}
const { sourceRegistryCases, samplePayloadCases, projectStoreV3Cases } = await import('./multisource-core.mjs');
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
  p.clips.push({ id: 'c1', start: 0.1, end: 1.1, tag: 'word', label: 'hello' });
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
  s0.tracks[0].voice.fitSteps = 16;
  s0.tracks[0].sendVerb = 0.45;
  s0.tracks[0].sendDelay = 0.2;
  p.machine.space.delayDivision = '1/16';
  p.machine.space.delayFeedback = 0.55;
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
  function sourceFreeInstrumentProjectsAreSavable() {
    const p = createProject(persistChain());
    const r = { repairs: [], analysis: null, sourceBytes: null, buffer: null };
    assert.equal(projectHasContent(p, r), false, 'an untouched source-free document is empty');
    const pcm = Float32Array.from([0, 0.5, -0.5, 0]);
    const id = registerAsset(p, {
      kind: 'synth', label: 'KICK', sampleRate: 44100, frames: pcm.length,
      role: 'KICK', formula: 'sin(t*tau*60)',
    });
    p.machine.tracks[0].sampleId = id;
    p.machine.tracks[0].sample = { channels: [pcm], sampleRate: 44100, label: 'KICK', role: 'KICK' };
    assert.equal(projectHasContent(p, r), true, 'a synth instrument makes the live project savable');
    const { json, sampleFiles } = serializeProject(p, r);
    assert.equal(json.sourceBytes, null, 'the save stays honestly source-free');
    assert.equal(sampleFiles.length, 1, 'its instrument PCM is still persisted');
    assert.equal(projectHasContent(json), true, 'the serialized project is offered on next boot');
  },
];

// ---------- trust + lifecycle shell ----------

const lifecycleCases = [
  function replacingOnlyPromptsWhenThereIsAnActiveSource() {
    assert.equal(sourceReplacementNeedsConfirmation(null), false);
    assert.equal(sourceReplacementNeedsConfirmation({ buffer: null }), false);
    assert.equal(sourceReplacementNeedsConfirmation({ buffer: {} }), true);
  },
  async function engineCanWakeWithoutLoadingASource() {
    const previousWindow = globalThis.window;
    let resumes = 0;
    class FakeAudioContext {
      constructor() { this.state = 'suspended'; this.destination = {}; }
      createGain() { return { connect() {} }; }
      resume() { resumes++; this.state = 'running'; return Promise.resolve(); }
    }
    globalThis.window = { AudioContext: FakeAudioContext };
    try {
      const engine = new Engine();
      const first = engine.wake();
      const second = engine.wake();
      assert.equal(first, second, 'wake reuses one context');
      assert.equal(engine.master != null, true, 'the source-free graph has a master output');
      assert.equal(resumes, 1, 'only a suspended context is resumed');
    } finally {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    }
  },
  function engineCanReturnToASourceFreeState() {
    const engine = new Engine();
    engine._buffer = { duration: 4 };
    engine._mono = new Float32Array([1, 2]);
    engine._alt = { duration: 3 };
    engine._position = 2;
    engine._lastCuts = [{ start: 1, end: 2 }];
    engine.clear();
    assert.equal(engine.buffer, null);
    assert.equal(engine.mono, null);
    assert.equal(engine.duration, 0);
    assert.equal(engine.currentTime, 0);
    assert.equal(engine._alt, null);
    assert.deepEqual(engine._lastCuts, []);
  },
  async function canonicalLicenseRequiresCommercialTermsForOrganizations() {
    const license = await readFile(new URL('../LICENSE', import.meta.url), 'utf8');
    const terms = await readFile(new URL('../LICENSE.md', import.meta.url), 'utf8');
    assert.match(license, /Business Source License 1\.1/);
    assert.doesNotMatch(license, /PolyForm Noncommercial License/);
    assert.doesNotMatch(license, /Permission is hereby granted, free of charge/);
    assert.match(terms, /Business Source License 1\.1/);
    assert.match(terms, /natural person may make Production Use/);
    assert.match(terms, /educational institution, research/);
    assert.match(terms, /require a separate commercial\s+license/);
    assert.match(terms, /Change License:\s+Apache License, Version 2\.0/);
    assert.doesNotMatch(terms, /Use by any charitable organization/);
  },
  async function bundledDemoIsDiscoverableAndOffline() {
    const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const worker = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
    const provenance = await readFile(new URL('../assets/demo/README.md', import.meta.url), 'utf8');
    assert.match(index, /id="btnLoadDemo"/);
    assert.match(index, /SPARKS/);
    assert.match(worker, /assets\/demo\/zane-little-sparks\.mp3/);
    assert.equal(existsSync(new URL('../' + DEMO_TRACK.path, import.meta.url)), true);
    assert.match(provenance, /CC0 1\.0 Universal/);
    assert.match(provenance, /bc025c6956d88245e7a1bf139ec3e69829fa09f0ec4461af5691e5d77428e27c/);
  },
  async function fieldLibraryIsWellFormedAndDiscoverable() {
    // Manifest integrity: every recording is a complete, uniquely-identified,
    // hand-license-checked archive.org stream. A malformed entry would render
    // a dead button on the drop zone with no console error to explain it.
    const ids = new Set();
    assert.ok(FIELD_RECORDINGS.length >= 8, 'a real shelf, not a stub');
    for (const rec of FIELD_RECORDINGS) {
      assert.ok(rec.id && !ids.has(rec.id), 'unique id: ' + rec.id);
      ids.add(rec.id);
      for (const key of ['title', 'place', 'kind', 'dur', 'url', 'source', 'license']) {
        assert.ok(rec[key], rec.id + ' has ' + key);
      }
      assert.match(rec.url, /^https:\/\/archive\.org\/download\//, rec.id + ' streams from archive.org');
      assert.match(rec.source, /^https:\/\/archive\.org\/details\//, rec.id + ' cites its item page');
      assert.ok(rec.url.slice('https://archive.org/download/'.length)
        .startsWith(rec.source.slice('https://archive.org/details/'.length) + '/'),
        rec.id + ' url lives under its source item');
      assert.match(rec.dur, /^\d+:\d\d$/, rec.id + ' duration reads as M:SS');
      assert.ok(fieldLicenseUrl(rec.license), rec.id + ' license tag resolves to a deed URL');
    }
    // Discoverable: the drop zone hosts it, the worker precaches the module.
    const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const worker = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
    assert.match(index, /id="fieldLibrary"/);
    assert.match(worker, /js\/app\/field-library\.js/);
  },
  async function fieldLibraryStaysReachableOnceAudioIsLoaded() {
    // The shelf lives inside #dropZone, which is hidden the moment a source
    // loads. Without a control in the persistent chrome the whole library
    // silently disappears for the rest of the session — which is exactly what
    // happened. The button must sit OUTSIDE the drop zone, not within it.
    const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const button = index.indexOf('id="btnField"');
    const dropZone = index.indexOf('id="dropZone"');
    assert.ok(button >= 0, 'a persistent FIELD control exists');
    assert.ok(dropZone >= 0, 'drop zone still exists');
    assert.ok(button < dropZone,
      'the FIELD control must live in the header, not inside the overlay it reopens');
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

const {
  planEnvelope,
  createFittedBuffer,
  masterLimit,
  renderDurationSec,
  RENDER_TAIL_FLOOR_DB,
  Sequencer,
} = await import('../js/machine/sequencer.js');

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

// ---------- clip lifecycle ----------
// Models the two rules the real code follows: setClips drops a selection whose
// id is absent (slice-ui.js), and the controller mutates project.clips in
// place. A resize is a replace, so ordering decides whether selection lives.
function clipHarness() {
  const state = { clips: [], selectedId: null };
  const setClips = () => {
    if (state.selectedId != null && !state.clips.some((c) => c.id === state.selectedId)) {
      state.selectedId = null;
    }
  };
  state.add = (clip) => { state.clips.push(clip); setClips(); };
  state.del = (id) => {
    const i = state.clips.findIndex((c) => c.id === id);
    if (i >= 0) state.clips.splice(i, 1);
    setClips();
  };
  return state;
}

const clipCases = [
  function resizeKeepsSelection() {
    // Dragging a clip edge used to clear the selection, so ASSIGN then refused
    // with "select a clip in SLICE first" while the user looked right at it.
    const s = clipHarness();
    const ref = s.clips;
    s.add({ id: 'r1', start: 1, end: 2 });
    s.selectedId = 'r1';
    s.selectedId = 'r2';
    s.add({ id: 'r2', start: 1, end: 2.5 });   // add BEFORE delete
    s.del('r1');
    assert.deepEqual(s.clips.map((c) => c.id), ['r2'], 'clip replaced');
    assert.equal(s.selectedId, 'r2', 'selection survives a resize');
    assert.equal(s.clips, ref, 'clips array identity is stable');
  },
  function deleteStillClearsSelection() {
    const s = clipHarness();
    s.add({ id: 'a1', start: 0, end: 1 });
    s.add({ id: 'a2', start: 2, end: 3 });
    s.selectedId = 'a1';
    s.del('a1');
    assert.equal(s.selectedId, null, 'deleting the selected clip clears selection');
    assert.deepEqual(s.clips.map((c) => c.id), ['a2'], 'the other clip is untouched');
  },
  function deletingAnotherClipKeepsSelection() {
    const s = clipHarness();
    s.add({ id: 'b1', start: 0, end: 1 });
    s.add({ id: 'b2', start: 2, end: 3 });
    s.selectedId = 'b2';
    s.del('b1');
    assert.equal(s.selectedId, 'b2', 'deleting a different clip leaves selection alone');
  },
];

const pipelineCases = [
  function anEmptyProjectHasNothingDone() {
    const st = new ProjectStore(persistChain());
    const stages = deriveStages(st.project, st.runtime);
    assert.deepEqual(stages.map((s) => s.key),
      ['source', 'slice', 'kit', 'pattern', 'song', 'out'], 'the flow in order');
    for (const s of stages) {
      assert.equal(s.done, false, s.key + ' is not done in an empty project');
      assert.ok(s.note && s.note.length, s.key + ' still says what to do');
      assert.ok(s.target && s.target.tab, s.key + ' knows where to jump');
    }
  },
  function stagesLightFromTheDocumentAndCountWhatIsThere() {
    const st = new ProjectStore(persistChain());
    const P = st.project;
    P.clips.push({ id: 'c1', start: 0, end: 1, tag: 'kick', label: 'K' });
    P.clips.push({ id: 'c2', start: 2, end: 3, tag: 'hat', label: 'H' });
    P.machine.tracks[0].sample = { channels: [new Float32Array(8)], sampleRate: 44100 };
    P.machine.tracks[0].steps[0] = 1;
    P.machine.tracks[0].steps[4] = 1;
    P.machine.song.chain.push({ scene: 0, reps: 4 });
    const by = {};
    for (const s of deriveStages(P, st.runtime)) by[s.key] = s;
    assert.equal(by.source.done, false, 'no audio means no source, whatever else exists');
    assert.equal(by.slice.done, true, 'clips light SLICE');
    assert.equal(by.slice.note, '2 CLIPS', 'and it counts them');
    assert.equal(by.kit.done, true, 'a loaded track lights KIT');
    assert.equal(by.kit.note, '1 OF 8 TRACKS', 'and says how far along');
    assert.equal(by.pattern.done, true, 'steps light PATTERN');
    assert.ok(/^2 STEPS/.test(by.pattern.note), 'plural is right: ' + by.pattern.note);
    assert.equal(by.song.note, '1 SECTION', 'singular is right too');
  },
  function stepsBeyondTrackLengthDoNotCount() {
    // A track only plays its first len steps, so the strip must not count
    // leftovers from a longer pattern the user shortened.
    const st = new ProjectStore(persistChain());
    const t = st.project.machine.tracks[0];
    t.len = 4;
    t.steps[0] = 1;
    t.steps[9] = 1;   // outside len: silent, so it is not a programmed step
    const by = {};
    for (const s of deriveStages(st.project, st.runtime)) by[s.key] = s;
    assert.ok(/^1 STEP /.test(by.pattern.note), 'counts only audible steps: ' + by.pattern.note);
  },
];

const constellationCases = [
  function standardizeHandlesMixedScalesAndConstants() {
    // Features span dB in the tens, ratios in [0,1] and Hz in the thousands, so
    // without standardising the centroid alone would dictate both axes.
    const rows = [[10, 0.2, 4000], [12, 0.9, 200], [11, 0.5, 9000]];
    const z = standardize(rows);
    for (let j = 0; j < 3; j++) {
      let mean = 0;
      for (const r of z) mean += r[j];
      close(mean / z.length, 0, 1e-9, 'column ' + j + ' centred');
    }
    const constant = standardize([[5, 1], [5, 2], [5, 3]]);
    for (const r of constant) assert.ok(Number.isFinite(r[0]), 'a constant column stays finite');
  },
  function twoClustersSeparate() {
    // Two obviously different timbres, four of each: the projection must put
    // them on opposite sides, which is the whole point of the map.
    const kicky = () => [14, -34, 0.85, 0.12, 0.02, 90, 0.03, 0.8];
    const hatty = () => [16, -40, 0.02, 0.10, 0.86, 9000, 0.55, 0.05];
    const jitter = (v, i) => v.map((x, j) => x * (1 + 0.01 * Math.sin(i * 7 + j)));
    const rows = [];
    for (let i = 0; i < 4; i++) rows.push(jitter(kicky(), i));
    for (let i = 0; i < 4; i++) rows.push(jitter(hatty(), i + 40));
    const out = project2d(rows);
    assert.equal(out.points.length, 8, 'a point per slice');
    const meanX = (from, to) => {
      let acc = 0;
      for (let i = from; i < to; i++) acc += out.points[i].x;
      return acc / (to - from);
    };
    const a = meanX(0, 4);
    const b = meanX(4, 8);
    assert.ok(Math.abs(a - b) > 0.8, 'the two families sit apart on the main axis: ' + a.toFixed(2) + ' vs ' + b.toFixed(2));
    assert.ok(out.explained > 0.5, 'two axes explain most of the variation: ' + out.explained.toFixed(2));
    for (const p of out.points) {
      assert.ok(p.x >= -1.0001 && p.x <= 1.0001, 'x inside the box');
      assert.ok(p.y >= -1.0001 && p.y <= 1.0001, 'y inside the box');
    }
  },
  function deterministicAndDegenerateSafe() {
    const rows = [[1, 2, 3, 4, 5, 6, 7, 8], [2, 1, 4, 3, 6, 5, 8, 7], [5, 5, 5, 5, 1, 1, 1, 1]];
    assert.deepEqual(project2d(rows).points, project2d(rows).points, 'same input, same map');
    assert.deepEqual(project2d([]).points, [], 'no slices, no points');
    assert.deepEqual(project2d([[1, 2, 3]]).points, [{ x: 0, y: 0 }], 'one slice sits at the origin');
    const identical = project2d([[1, 1], [1, 1], [1, 1]]);
    for (const p of identical.points) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'identical slices stay finite');
    }
  },
  function axisLabelsNameTheDominantFeature() {
    assert.equal(axisLabel([0, 0, 0, 0, 0, 0, 0, 0.9]), '+PITCHED', 'positive dominant feature');
    assert.equal(axisLabel([-0.9, 0.1]), '-ATTACK', 'negative dominant feature');
    assert.equal(axisLabel(null), '?', 'no vector, no claim');
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

// ---------- conform: stretch + space (CONTRACT-CONFORM) ----------

const conformCases = [
  function ratioOneIsIdentityAndLengthsAreExact() {
    // Identity at ratio 1 is what makes leaving CONFORM armed safe.
    const src = new Float32Array(8192);
    const rand = mulberry32(0xC0FFEE);
    for (let i = 0; i < src.length; i++) {
      src[i] = 0.4 * Math.sin(2 * Math.PI * 220 * i / 44100) + 0.1 * (rand() * 2 - 1);
    }
    for (const mode of ['auto', 'percussive', 'tonal', 'resample']) {
      const same = stretchSamples(src, 1, 44100, { mode });
      assert.deepEqual(same, src, 'ratio 1 is sample-identical: ' + mode);
      for (const ratio of [0.5, 1.5, 2]) {
        const out = stretchSamples(src, ratio, 44100, { mode });
        assert.equal(out.length, Math.round(src.length * ratio), 'exact length ' + mode + ' x' + ratio);
        for (let i = 0; i < out.length; i += 97) {
          assert.ok(Number.isFinite(out[i]), 'finite output ' + mode);
        }
      }
    }
  },
  function stretchNeverBlowsUpAmplitude() {
    // CONTRACT-CONFORM section 1 asked for this bound and the harness never
    // enforced it, which is how a phase-vocoder tail spike of 856x the input
    // peak reached production. The overshoot lived entirely in the final
    // synthesis hop, so the tail is checked separately and harder.
    const sr = 44100;
    const n = sr;
    const rand = mulberry32(0xBADA55);
    const src = new Float32Array(n);
    for (let i = 0; i < n; i++) src[i] = 0.5 * (rand() * 2 - 1);
    let inPeak = 0;
    for (let i = 0; i < n; i++) inPeak = Math.max(inPeak, Math.abs(src[i]));
    for (const mode of ['percussive', 'tonal', 'resample']) {
      for (const ratio of [0.5, 0.95, 1.25, 1.5, 1.85, 2.6]) {
        const out = stretchSamples(src, ratio, sr, { mode });
        let peak = 0;
        let tailPeak = 0;
        const tailFrom = Math.max(0, out.length - 2048);
        for (let i = 0; i < out.length; i++) {
          const a = Math.abs(out[i]);
          if (a > peak) peak = a;
          if (i >= tailFrom && a > tailPeak) tailPeak = a;
          assert.ok(Number.isFinite(out[i]), 'finite ' + mode + ' x' + ratio);
        }
        assert.ok(peak <= inPeak * 3,
          mode + ' x' + ratio + ' peak ' + (peak / inPeak).toFixed(2) + 'x input, want <= 3x');
        assert.ok(tailPeak <= inPeak * 3,
          mode + ' x' + ratio + ' TAIL peak ' + (tailPeak / inPeak).toFixed(2) + 'x input, want <= 3x');
      }
    }
  },
  function fittedSweepStaysBounded() {
    // The realistic CONFORM path: a harvested slice fitted across tempos.
    const sr = 44100;
    const n = Math.round(1.7 * sr);
    const rand = mulberry32(0x5A5A);
    const src = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      src[i] = 0.4 * Math.sin(2 * Math.PI * 110 * i / sr) + 0.1 * (rand() * 2 - 1);
    }
    let inPeak = 0;
    for (let i = 0; i < n; i++) inPeak = Math.max(inPeak, Math.abs(src[i]));
    let worst = 0;
    for (const bpm of [90, 100, 120, 140]) {
      for (const steps of [4, 8, 16, 22, 32]) {
        const fitSec = steps * (60 / bpm / 4);
        const out = stretchSamples(src, (fitSec * sr) / n, sr, { mode: 'auto', role: 'BASS' });
        let peak = 0;
        for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
        worst = Math.max(worst, peak / inPeak);
      }
    }
    assert.ok(worst <= 3, 'worst fitted overshoot ' + worst.toFixed(2) + 'x input peak, want <= 3x');
  },
  function roleChoosesTheEngine() {
    // The point of the slice: HARVEST already knows what the sound is.
    for (const role of ['KICK', 'SNARE', 'HAT']) {
      assert.equal(stretchMode(role), 'percussive', role + ' is percussive');
    }
    for (const role of ['BASS', 'TONE', 'VOX', 'FX', 'CRASH', 'NONSENSE', undefined]) {
      assert.equal(stretchMode(role), 'tonal', String(role) + ' is tonal');
    }
  },
  function tonalPathHoldsPitchWhereResampleDoesNot() {
    const sr = 44100;
    const n = sr;
    const src = new Float32Array(n);
    for (let i = 0; i < n; i++) src[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr);
    const stretched = stretchSamples(src, 2, sr, { mode: 'tonal' });
    const resampled = stretchSamples(src, 2, sr, { mode: 'resample' });
    const mid = (x) => x.subarray(Math.floor(x.length * 0.25), Math.floor(x.length * 0.75));
    const p440 = goertzelPower(mid(stretched), 440, sr);
    const p220 = goertzelPower(mid(stretched), 220, sr);
    assert.ok(p440 > p220 * 20, 'tonal stretch keeps 440 Hz dominant');
    const r440 = goertzelPower(mid(resampled), 440, sr);
    const r220 = goertzelPower(mid(resampled), 220, sr);
    assert.ok(r220 > r440 * 20, 'resample drops an octave, proving the modes differ');
  },
  function percussivePathKeepsTransientCount() {
    const sr = 44100;
    const n = sr;
    const src = new Float32Array(n);
    for (let k = 0; k < 8; k++) {
      const at = Math.round(k * sr / 8);
      for (let i = 0; i < 60; i++) src[at + i] = (1 - i / 60) * (i % 2 ? -1 : 1);
    }
    const out = stretchSamples(src, 2, sr, { mode: 'percussive' });
    assert.equal(out.length, 2 * n, 'length exact');
    // Count peaks over a threshold, with a hold so one click counts once.
    let clicks = 0;
    let hold = 0;
    for (let i = 0; i < out.length; i++) {
      if (hold > 0) { hold--; continue; }
      if (Math.abs(out[i]) > 0.5) { clicks++; hold = Math.round(sr * 0.05); }
    }
    assert.equal(clicks, 8, 'all 8 transients survive, none doubled: got ' + clicks);
  },
  function plateIsDeterministicAndDecays() {
    const sr = 44100;
    const a = plateImpulse(sr, 1.5, 0.7, 10);
    const b = plateImpulse(sr, 1.5, 0.7, 10);
    assert.deepEqual(a.left, b.left, 'plate is deterministic (left)');
    assert.deepEqual(a.right, b.right, 'plate is deterministic (right)');
    assert.equal(a.left.length, Math.round((1.5 + 0.01) * sr), 'length includes predelay');
    const pre = Math.round(0.01 * sr);
    for (let i = 0; i < pre; i++) assert.equal(a.left[i], 0, 'predelay is silent');
    const rms = (x, from, to) => {
      let acc = 0;
      for (let i = from; i < to; i++) acc += x[i] * x[i];
      return Math.sqrt(acc / (to - from));
    };
    const n = a.left.length;
    const t1 = rms(a.left, pre, pre + Math.floor((n - pre) / 3));
    const t2 = rms(a.left, pre + Math.floor((n - pre) / 3), pre + Math.floor(2 * (n - pre) / 3));
    const t3 = rms(a.left, pre + Math.floor(2 * (n - pre) / 3), n);
    assert.ok(t1 > t2 && t2 > t3, 'tail decays monotonically: ' + [t1, t2, t3].map((v) => v.toFixed(4)));
    for (let i = 0; i < n; i += 131) assert.ok(Number.isFinite(a.left[i]), 'finite impulse');
  },
  function fitBakesTheTrimmedSpanOnly() {
    // Regression for the fit+trim bug an adversarial review caught: stretching
    // the WHOLE sample and then applying original-domain trim offsets played
    // original seconds 2-4 for 1 s instead of 1-2 for 2 s. The bake now takes
    // the trimmed span, so the fitted buffer IS the slice.
    const sr = 44100;
    const frames = 4 * sr;
    const pcm = new Float32Array(frames);
    // Mark ONLY the region the trim selects, so region identity is checkable.
    for (let i = Math.round(0.25 * frames); i < Math.round(0.5 * frames); i++) pcm[i] = 1;
    const ctx = { createBuffer: (ch, len, rate) => new AudioBuffer({ numberOfChannels: ch, length: len, sampleRate: rate }) };
    const sample = { channels: [pcm], sampleRate: sr, role: 'TONE' };
    const fitSec = 2;
    const baked = createFittedBuffer(ctx, sample, false, fitSec, 0.25 * 4, 0.25 * 4);
    assert.ok(baked, 'a fitted buffer is produced');
    close(baked.length / sr, fitSec, 0.001, 'fitted buffer lasts exactly fitSec');
    const data = baked.getChannelData(0);
    let inside = 0;
    for (let i = 0; i < data.length; i += 37) if (Math.abs(data[i]) > 0.5) inside++;
    const sampled = Math.ceil(data.length / 37);
    assert.ok(inside > sampled * 0.9,
      'the fitted buffer holds the SELECTED region, not a neighbouring one: ' + inside + '/' + sampled);
  },
  function delayDivisionsAndDamping() {
    close(delayTimeFor(120, '1/4'), 0.5, 1e-12, 'quarter at 120');
    close(delayTimeFor(120, '1/8'), 0.25, 1e-12, 'eighth at 120');
    close(delayTimeFor(120, '1/8.'), 0.375, 1e-12, 'dotted eighth is 1.5x');
    close(delayTimeFor(120, '1/8t'), 1 / 6, 1e-12, 'triplet eighth is 2/3x');
    close(delayTimeFor(120, '1/16'), 0.125, 1e-12, 'sixteenth at 120');
    assert.ok(delayTimeFor(120, 'nonsense') > 0, 'unknown division falls back, never NaN');
    const lo = dampingCoeff(200, 48000);
    const hi = dampingCoeff(8000, 48000);
    assert.ok(lo > hi, 'damping coefficient falls as cutoff rises');
    assert.ok(lo > 0 && lo < 1 && hi > 0 && hi < 1, 'coefficient stays inside (0,1)');
  },
];

// ---------- undo history ----------
// Mirrors what persist-controller wires: snapshotDoc to take, applySnapshot to
// put, with PCM re-attached by asset id because applySnapshot nulls it.
function undoStore() {
  const st = new ProjectStore(persistChain());
  const P = st.project;
  const R = st.runtime;
  st.attachHistory(
    () => snapshotDoc(P, R),
    (doc) => {
      const pcm = new Map();
      for (const scene of P.machine.scenes) {
        for (const t of scene.tracks) if (t.sampleId && t.sample) pcm.set(t.sampleId, t.sample);
      }
      applySnapshot(doc, { project: P, runtime: R });
      for (const scene of P.machine.scenes) {
        for (const t of scene.tracks) {
          if (t.sampleId && !t.sample && pcm.has(t.sampleId)) t.sample = pcm.get(t.sampleId);
        }
      }
    },
  );
  return st;
}

const undoCases = [
  function clearHistoryIsPublicAndWorks() {
    // Production used to reach into store._past directly while these accessors
    // were tested and unused; both sides now go through the same interface.
    const st = undoStore();
    st.update('clips', (p) => { p.clips.push({ id: 'c1', start: 0, end: 1, tag: 'm', label: 'A' }); });
    assert.equal(st.canUndo, true, 'a step exists');
    assert.equal(st.undoDepth, 1, 'depth reports it');
    st.clearHistory();
    assert.equal(st.canUndo, false, 'cleared');
    assert.equal(st.canRedo, false, 'redo cleared too');
    assert.equal(st.undoDepth, 0, 'depth is zero');
  },
  function undoAndRedoWalkTheDocument() {
    const st = undoStore();
    const P = st.project;
    assert.equal(st.canUndo, false, 'nothing to undo at the start');
    st.update('clips', (p) => { p.clips.push({ id: 'c1', start: 0, end: 1, tag: 'manual', label: 'A' }); });
    st.update('clips', (p) => { p.clips.push({ id: 'c2', start: 2, end: 3, tag: 'manual', label: 'B' }); });
    assert.equal(P.clips.length, 2, 'two clips added');
    assert.equal(st.undo(), true, 'undo reports it moved');
    assert.equal(P.clips.length, 1, 'back to one clip');
    assert.equal(P.clips[0].id, 'c1', 'the right one survived');
    st.undo();
    assert.equal(P.clips.length, 0, 'back to none');
    assert.equal(st.canUndo, false, 'history exhausted');
    assert.equal(st.redo(), true, 'redo moves forward');
    assert.equal(P.clips.length, 1, 'redo restores one');
    st.redo();
    assert.equal(P.clips.length, 2, 'redo restores both');
  },
  function undoKeepsTheKitAudio() {
    // applySnapshot nulls track.sample by design. If undo did not re-attach the
    // PCM, undoing any edit would silently empty every loaded track.
    const st = undoStore();
    const P = st.project;
    const pcm = { channels: [Float32Array.from([0.1, -0.2, 0.3])], sampleRate: 44100, label: 'KICK', role: 'KICK' };
    st.update('assets', (p) => {
      p.assets.a1 = { id: 'a1', kind: 'sample', label: 'KICK', sampleRate: 44100, frames: 3 };
      p.machine.tracks[0].sampleId = 'a1';
      p.machine.tracks[0].sample = pcm;
    });
    st.update('pattern', (p) => { p.machine.tracks[0].steps[4] = 1; });
    assert.equal(P.machine.tracks[0].steps[4], 1, 'step is on');
    st.undo();
    assert.equal(P.machine.tracks[0].steps[4], 0, 'step undone');
    assert.ok(P.machine.tracks[0].sample, 'THE SAMPLE SURVIVED THE UNDO');
    assert.equal(P.machine.tracks[0].sample.channels[0].length, 3, 'and it is the same audio');
  },
  function aNewEditClearsRedo() {
    const st = undoStore();
    const P = st.project;
    st.update('clips', (p) => { p.clips.push({ id: 'c1', start: 0, end: 1, tag: 'm', label: 'A' }); });
    st.undo();
    assert.equal(st.canRedo, true, 'redo available after an undo');
    st.update('clips', (p) => { p.clips.push({ id: 'c9', start: 5, end: 6, tag: 'm', label: 'Z' }); });
    assert.equal(st.canRedo, false, 'a new edit drops the redo branch');
    assert.deepEqual(P.clips.map((c) => c.id), ['c9'], 'the new edit stands alone');
  },
  function historyIsBounded() {
    const st = undoStore();
    st.historyLimit = 5;
    for (let i = 0; i < 20; i++) {
      st.update('clips', (p) => { p.clips.push({ id: 'c' + i, start: i, end: i + 0.5, tag: 'm', label: 'x' }); });
    }
    assert.ok(st.undoDepth <= 5, 'history respects its limit: ' + st.undoDepth);
  },
];

// ---------- formula synthesis ----------

const synthCases = [
  function everyPresetRendersUsableAudio() {
    for (const p of SYNTH_PRESETS) {
      const x = renderFormula(p.formula, { sampleRate: 44100, seconds: p.seconds });
      assert.equal(x.length, Math.round(p.seconds * 44100), p.name + ' length');
      let peak = 0;
      for (let i = 0; i < x.length; i++) {
        assert.ok(Number.isFinite(x[i]), p.name + ' sample ' + i + ' is finite');
        peak = Math.max(peak, Math.abs(x[i]));
      }
      assert.ok(peak > 0.3 && peak <= 1, p.name + ' normalizes into range: peak ' + peak.toFixed(3));
      // Magnitude, not identity: the fade can yield -0 on a negative sample.
      assert.ok(Math.abs(x[0]) < 1e-9, p.name + ' starts at zero (no click)');
      assert.ok(Math.abs(x[x.length - 1]) < 1e-9, p.name + ' ends at zero (no click)');
    }
  },
  function theLanguageRejectsAnythingItDoesNotDefine() {
    // The formula is persisted and shared, so it must never be able to reach
    // page script. eval/new Function would; a parser with a fixed table cannot.
    const hostile = ['constructor', 'this', 'window', 'globalThis', 'process.exit(1)',
      'eval("1")', '(()=>1)()', '__proto__', 'require("fs")', 'fetch("/")'];
    for (const src of hostile) {
      assert.throws(() => compileFormula(src), /unknown|unexpected|bad number|expected/,
        'rejected: ' + src);
    }
  },
  function mathsIsActuallyCorrect() {
    // 8 kHz is the module's floor; anything lower is clamped up to it.
    const sr = 8000;
    const x = renderFormula('sin(tau*1*t)', { sampleRate: sr, seconds: 1, normalize: false });
    close(x[sr / 4], 1, 1e-6, 'sin peaks at t=0.25');
    close(x[(3 * sr) / 4], -1, 1e-6, 'and troughs at t=0.75');
    const e = renderFormula('env(t,0.5)', { sampleRate: sr, seconds: 1, normalize: false });
    close(e[sr / 2], Math.exp(-1), 1e-6, 'env is exp(-t/tau): one tau in');
    // Precedence and associativity, where a hand-rolled parser usually breaks.
    const prec = compileFormula('2+3*4');
    assert.equal(prec(0, 0, () => 0), 14, 'times binds tighter than plus');
    const rightAssoc = compileFormula('2^3^2');
    assert.equal(rightAssoc(0, 0, () => 0), 512, 'power is right associative');
    const unary = compileFormula('-2^2');
    assert.equal(unary(0, 0, () => 0), -4, 'unary minus applies after the power');
    const divZero = compileFormula('1/0');
    assert.equal(divZero(0, 0, () => 0), 0, 'divide by zero yields 0, never Infinity');
  },
  function renderIsDeterministicEvenWithNoise() {
    // Live playback and the offline render must agree, so noise must be seeded.
    const a = renderFormula('noise()*env(t,0.1)', { seconds: 0.2 });
    const b = renderFormula('noise()*env(t,0.1)', { seconds: 0.2 });
    assert.deepEqual(a, b, 'two renders of the same formula are identical');
  },
  function badInputFailsLoudlyAndSafely() {
    for (const src of ['', '1+', '(1', 'sin()', 'sin(1,2)', 'nope(1)', '1 2']) {
      assert.throws(() => compileFormula(src), Error, 'rejects: "' + src + '"');
    }
    // A formula that evaluates to nonsense still yields silence, not NaN audio.
    const x = renderFormula('log(0-1)', { seconds: 0.05 });
    for (let i = 0; i < x.length; i++) assert.ok(Number.isFinite(x[i]), 'no NaN reaches the buffer');
  },
];

// ---------- deterministic 96 kHz factory drums ----------

function dominantDrumFrequency(pcm, startSec, endSec, lo, hi) {
  const start = Math.max(0, Math.floor(startSec * DRUM_RATE));
  const end = Math.min(pcm.length, Math.ceil(endSec * DRUM_RATE));
  const window = pcm.subarray(start, end);
  let bestHz = lo;
  let bestPower = -Infinity;
  for (let hz = lo; hz <= hi; hz++) {
    const power = goertzelPower(window, hz, DRUM_RATE);
    if (power > bestPower) { bestPower = power; bestHz = hz; }
  }
  return bestHz;
}

function drumBandPower(pcm, fromHz, toHz, strideHz) {
  let power = 0;
  for (let hz = fromHz; hz <= toHz; hz += strideHz) {
    power += goertzelPower(pcm, hz, DRUM_RATE);
  }
  return power;
}

function installFactoryFixture(project, kitId = 'yj-808', grooveId = null, variation = 0, withAssets = false) {
  const kit = getFactoryKit(kitId);
  const selectedGroove = grooveId || kit.grooves[0].id;
  const plan = kitInstallPlan(kitId, { grooveId: selectedGroove, variation });
  const scene = project.machine.scenes[project.machine.activeScene];
  for (const item of plan.voices) {
    const track = scene.tracks[item.slot];
    track.sample = {
      channels: [item.pcm], sampleRate: item.sampleRate, label: item.name,
      role: item.role, factoryKitId: plan.kitId, engineVersion: item.engineVersion,
    };
    if (withAssets) {
      track.sampleId = registerAsset(project, {
        kind: 'factory-drum', label: item.name, role: item.role,
        sampleRate: item.sampleRate, frames: item.pcm.length, channelCount: 1,
        factoryKitId: plan.kitId, factoryVoiceId: item.assetId,
        engineVersion: item.engineVersion, model: item.model, seed: item.seed,
        params: { ...item.params }, oversample: DRUM_OVERSAMPLE,
      });
    }
    Object.assign(track.voice, createVoice(), item.voice);
    Object.assign(track, item.mix);
    track.steps.set(plan.tracks[item.slot].steps);
    for (const key of Object.keys(track.stepData)) delete track.stepData[key];
    for (const key of Object.keys(plan.tracks[item.slot].stepData)) {
      track.stepData[key] = JSON.parse(JSON.stringify(plan.tracks[item.slot].stepData[key]));
    }
    track.len = plan.tracks[item.slot].len;
  }
  Object.assign(project.machine.drums, {
    kitId: plan.kitId, grooveId: plan.grooveId, variation: plan.variation,
  });
  return plan;
}

const drumCases = [
  function catalogPinsThreeCompleteHighResolutionKits() {
    assert.equal(DRUM_RATE, 96000, 'factory PCM has one canonical truth rate');
    assert.equal(DRUM_OVERSAMPLE, 4, 'nonlinear synthesis runs four-times oversampled');
    assert.equal(DRUM_INTERNAL_RATE, 384000, 'the nonlinear render rate is 384 kHz');
    assert.equal(DRUM_ENGINE_VERSION, 1, 'asset provenance pins the DSP version');
    assert.equal(FACTORY_KITS.length, 3, 'three distinct factory kits ship');
    assert.equal(new Set(FACTORY_KITS.map((kit) => kit.id)).size, 3, 'kit ids are unique');
    assert.ok(getFactoryKit('yj-808'), 'the catalog includes an explicit 808 kit');
    assert.equal(getFactoryKit('not-a-kit'), null, 'unknown kits never silently fall back');
    const models = new Set(supportedDrumModels());
    const assetIds = new Set();
    for (const kit of FACTORY_KITS) {
      assert.equal(kit.sampleRate, DRUM_RATE, kit.id + ' rate');
      assert.equal(kit.oversample, DRUM_OVERSAMPLE, kit.id + ' oversampling');
      assert.equal(kit.tracks.length, 8, kit.id + ' has eight playable voices');
      assert.deepEqual(kit.tracks.map((item) => item.slot), [0, 1, 2, 3, 4, 5, 6, 7]);
      assert.equal(new Set(kit.tracks.map((item) => item.name)).size, 8, kit.id + ' voice names are unique');
      assert.ok(Object.isFrozen(kit) && Object.isFrozen(kit.tracks), kit.id + ' manifest is immutable');
      for (const item of kit.tracks) {
        assert.ok(models.has(item.model), kit.id + '/' + item.name + ' uses a supported model');
        assert.ok(Object.isFrozen(item.params) && Object.isFrozen(item.mix), 'nested factory data is immutable');
        assetIds.add(drumAssetId(kit.id, item.slot));
      }
      assert.ok(Array.isArray(kit.grooves) && kit.grooves.length >= 2, kit.id + ' has multiple grooves');
      for (const groove of kit.grooves) {
        assert.equal(groove.lanes.length, 8, kit.id + '/' + groove.id + ' covers every track');
        assert.ok(groove.lanes.every((lane) => lane.length === 16), 'every groove defines one repeating bar per lane');
      }
    }
    assert.equal(assetIds.size, 24, 'factory asset identities cannot collide across kits or slots');
    assert.equal(drumAssetId('', 0), null);
    assert.equal(drumAssetId('yj-808', 8), null);
  },
  function everyFactoryVoiceIsBitDeterministicFiniteAndCalibrated() {
    for (const kit of FACTORY_KITS) {
      for (const definition of kit.tracks) {
        const first = renderFactoryVoice(definition);
        const second = renderFactoryVoice(definition);
        const label = kit.id + '/' + definition.name;
        assert.equal(first.sampleRate, DRUM_RATE, label + ' rate');
        assert.equal(first.engineVersion, DRUM_ENGINE_VERSION, label + ' engine version');
        assert.equal(first.pcm.constructor, Float32Array, label + ' final storage is Float32');
        assert.equal(first.pcm.length, Math.round(definition.seconds * DRUM_RATE), label + ' exact frame count');
        assert.deepEqual(first.pcm, second.pcm, label + ' is sample-for-sample deterministic');
        let peak = 0;
        let sum = 0;
        let sumSq = 0;
        for (let i = 0; i < first.pcm.length; i++) {
          const sample = first.pcm[i];
          assert.ok(Number.isFinite(sample), label + ' frame ' + i + ' is finite');
          peak = Math.max(peak, Math.abs(sample));
          sum += sample;
          sumSq += sample * sample;
        }
        const rms = Math.sqrt(sumSq / first.pcm.length);
        const dc = sum / first.pcm.length;
        assert.ok(rms > 1e-4, label + ' is audible, not a silent success');
        const peakDb = 20 * Math.log10(peak);
        assert.ok(peakDb <= definition.ceilingDb + 0.05,
          label + ' sample peak ' + peakDb.toFixed(3) + ' dBFS respects its calibrated ceiling');
        assert.ok(first.metrics.truePeakDb <= definition.ceilingDb + 0.06,
          label + ' true peak ' + first.metrics.truePeakDb.toFixed(3) + ' dBTP <= ' + definition.ceilingDb);
        assert.ok(Math.abs(dc) <= rms * 0.08 + 1e-9,
          label + ' DC is bounded relative to program RMS: ' + dc);
        close(first.metrics.dc, dc, 1e-12, label + ' reported DC');
        assert.ok(Math.abs(first.pcm[0]) < 1e-12, label + ' begins at silence');
        assert.ok(Math.abs(first.pcm[first.pcm.length - 1]) < 1e-12, label + ' ends at silence');
        assert.ok(Number.isFinite(first.gainReductionDb) && first.gainReductionDb <= 0,
          label + ' ceiling is a one-way safety trim');
      }
    }
    assert.throws(() => renderFactoryVoice(FACTORY_KITS[0].tracks[0], { sampleRate: 48000 }), /96000/);
    assert.throws(() => renderFactoryVoice({ model: 'imaginary', seconds: 0.1 }), /unknown drum model/);
  },
  function rendered808KeepsItsPitchDropAndMetalBand() {
    const voices = renderFactoryKit('yj-808').voices;
    const kickEarly = dominantDrumFrequency(voices[0].pcm, 0.006, 0.040, 30, 240);
    const kickLate = dominantDrumFrequency(voices[0].pcm, 0.18, 0.34, 30, 120);
    assert.ok(kickEarly >= 90 && kickEarly <= 150, '808 kick attack is pitched high: ' + kickEarly + ' Hz');
    assert.ok(kickLate >= 40 && kickLate <= 60, '808 kick resolves into sub: ' + kickLate + ' Hz');
    assert.ok(kickEarly > kickLate * 1.7, 'the kick audibly falls rather than staying a static sine');
    const tomEarly = dominantDrumFrequency(voices[5].pcm, 0.01, 0.08, 30, 220);
    const tomLate = dominantDrumFrequency(voices[5].pcm, 0.25, 0.45, 30, 160);
    assert.ok(tomLate >= 75 && tomLate <= 92 && tomEarly > tomLate,
      '808 tom retains its shorter downward pitch gesture: ' + tomEarly + ' -> ' + tomLate + ' Hz');
    const closedHat = voices[3].pcm;
    const low = drumBandPower(closedHat, 200, 2000, 200);
    const high = drumBandPower(closedHat, 6000, 16000, 500);
    assert.ok(10 * Math.log10(high / low) > 15, 'closed hat energy lives in the metal band');
    assert.ok(voices[4].pcm.length > closedHat.length * 4, 'open hat has a genuinely longer tail');
  },
  function groovesAndInstallPlansNeverShareMutableState() {
    const kit = getFactoryKit('yj-808');
    const grooveId = kit.grooves[0].id;
    const base = grooveFor(kit.id, grooveId, 0);
    const first = grooveFor(kit.id, grooveId, 3);
    const second = grooveFor(kit.id, grooveId, 3);
    assert.deepEqual(first, second, 'the same variation is deterministic');
    assert.notEqual(first, second);
    for (let i = 0; i < 8; i++) {
      assert.notEqual(first[i], second[i], 'track documents are fresh');
      assert.notEqual(first[i].steps, second[i].steps, 'step arrays are fresh');
      assert.notEqual(first[i].stepData, second[i].stepData, 'lock maps are fresh');
      assert.equal(first[i].steps.length, 64);
    }
    for (let track = 0; track < 8; track++) {
      for (let step = 0; step < 64; step++) {
        if (base[track].steps[step]) assert.equal(first[track].steps[step], 1, 'variation retained programmed hit');
      }
    }
    first[0].steps[0] = 0;
    assert.equal(second[0].steps[0], 1, 'one take cannot mutate another');

    const renderedA = renderFactoryKit(kit.id);
    const renderedB = renderFactoryKit(kit.id);
    assert.notEqual(renderedA.voices, renderedB.voices, 'render wrappers are fresh');
    assert.notEqual(renderedA.voices[0].params, renderedB.voices[0].params);
    assert.notEqual(renderedA.voices[0].mix, renderedB.voices[0].mix);
    assert.equal(renderedA.voices[0].pcm, renderedB.voices[0].pcm,
      'only immutable canonical PCM is intentionally shared');
    const before = renderedB.voices[0].params.startHz;
    renderedA.voices[0].params.startHz = -1;
    assert.equal(renderFactoryKit(kit.id).voices[0].params.startHz, before, 'mutable wrapper cannot poison cache');

    assert.ok(renderedB.metrics.dryWorstCaseDb <= -6 + 1e-9, 'the factory dry sum retains 6 dB headroom');
    const soundsOnly = kitInstallPlan(kit.id);
    assert.equal(soundsOnly.grooveId, null, 'sounds-only load does not claim a groove');
    assert.equal(soundsOnly.tracks, null, 'sounds-only load cannot overwrite user steps');
    const planA = kitInstallPlan(kit.id, { grooveId, variation: 2 });
    const planB = kitInstallPlan(kit.id, { grooveId, variation: 2 });
    assert.deepEqual(planA, planB);
    assert.notEqual(planA.voices[0].params, planB.voices[0].params);
    assert.notEqual(planA.voices[0].voice, planB.voices[0].voice);
    assert.notEqual(planA.voices[0].mix, planB.voices[0].mix);
    assert.notEqual(planA.tracks[0].steps, planB.tracks[0].steps);
    assert.notEqual(planA.tracks[0].stepData, planB.tracks[0].stepData);
  },
  function installedFactoryGrooveKeepsCompilerLiveOfflineParity() {
    const project = createProject([]);
    installFactoryFixture(project, 'volt', 'fracture', 2, false);
    const machine = project.machine;
    const whole = compileRender(machine, 3);
    assert.ok(whole.events.length > 30, 'the starter groove compiles into a real performance');
    assert.ok(whole.events.some((event) => event.ratchetIndex > 0), 'factory locks include ratchets');
    assert.ok(whole.events.some((event) => event.rate !== 1), 'factory percussion locks include pitch movement');
    assert.ok(whole.events.every((event) => machine.tracks[event.track].sample.sampleRate === DRUM_RATE));
    const stitched = { events: [], ducks: [] };
    const slice = 0.137;
    for (let t = 0; t < whole.totalSec; t += slice) {
      const window = compileWindow(machine, t, Math.min(t + slice, whole.totalSec));
      stitched.events.push(...window.events);
      stitched.ducks.push(...window.ducks);
    }
    assert.deepEqual(stitched.events, whole.events, 'live lookahead windows equal offline factory render events');
    assert.deepEqual(stitched.ducks, whole.ducks, 'factory sidechain events have the same parity');
    assert.deepEqual(compileRender(machine, 3), whole, 'seeded factory groove recompiles identically');
  },
  function drumIdentityChokeGroupsAndPcmRoundTrip() {
    const project = createProject([]);
    installFactoryFixture(project, 'yj-808', 'anchor', 4, true);
    assert.equal(project.machine.tracks[3].chokeGroup, 1, 'closed hat joins group 1');
    assert.equal(project.machine.tracks[4].chokeGroup, 1, 'open hat joins group 1');
    assert.equal(projectHasContent(project, {}), true, 'a source-free factory kit is project content');
    const serialized = serializeProject(project, { repairs: [], sourceBytes: null });
    assert.equal(serialized.sampleFiles.length, 8, 'one mono PCM attachment per factory voice');
    assert.deepEqual(serialized.json.machine.drums, {
      kitId: 'yj-808', grooveId: 'anchor', variation: 4,
    });
    const restored = createProject([]);
    const drumsRef = restored.machine.drums;
    const restore = applySnapshot(serialized.json, { project: restored, runtime: { repairs: [] } });
    assert.equal(restored.machine.drums, drumsRef, 'restore mutates drum identity in place');
    assert.deepEqual(restored.machine.drums, project.machine.drums);
    assert.equal(restored.machine.tracks[3].chokeGroup, 1);
    assert.equal(restored.machine.tracks[4].chokeGroup, 1);
    assert.equal(restore.sampleAttachments.length, 8);
    for (const attachment of restore.sampleAttachments) {
      const meta = restored.assets[attachment.assetId];
      const file = serialized.sampleFiles.find((item) => item.id === attachment.assetId);
      const sample = hydrateSample(meta, new Float32Array(file.bytes));
      assert.equal(sample.sampleRate, DRUM_RATE);
      assert.equal(sample.channels.length, 1);
      assert.equal(sample.channels[0].length, meta.frames);
      restored.machine.scenes[attachment.sceneIndex].tracks[attachment.trackIndex].sample = sample;
    }
    assert.equal(restored.machine.tracks.every((track) => track.sample && track.sample.sampleRate === DRUM_RATE), true);

    const hostile = snapshotDoc(project, { repairs: [], sourceBytes: null });
    hostile.machine.scenes[0].tracks[0].chokeGroup = -99;
    hostile.machine.scenes[0].tracks[1].chokeGroup = 99;
    hostile.machine.scenes[0].tracks[2].chokeGroup = 2.9;
    hostile.machine.scenes[0].drums.variation = -10;
    const clamped = createProject([]);
    applySnapshot(hostile, { project: clamped, runtime: { repairs: [] } });
    assert.deepEqual(clamped.machine.scenes[0].tracks.slice(0, 3).map((track) => track.chokeGroup), [0, 4, 2]);
    assert.equal(clamped.machine.drums.variation, 0);
    const legacy = snapshotDoc(createProject([]), { repairs: [], sourceBytes: null });
    delete legacy.machine.drums;
    for (const scene of legacy.machine.scenes) delete scene.drums;
    const legacyTarget = createProject([]);
    Object.assign(legacyTarget.machine.drums, { kitId: 'stale', grooveId: 'stale', variation: 9 });
    applySnapshot(legacy, { project: legacyTarget, runtime: { repairs: [] } });
    assert.deepEqual(legacyTarget.machine.drums, { kitId: null, grooveId: null, variation: 0 });
  },
  function canonicalFactoryKitPrintsAsAnOpzPatch() {
    const rendered = renderFactoryKit('yj-808');
    const segments = rendered.voices.map((item) => ({
      samples: resample(item.pcm, item.sampleRate, 44100),
    }));
    const expectedFrames = segments.reduce((sum, item) => sum + item.samples.length, 0);
    const first = buildDrumPatch({ segments, name: 'yj-808' });
    const second = buildDrumPatch({ segments, name: 'yj-808' });
    assert.deepEqual(new Uint8Array(first.bytes), new Uint8Array(second.bytes), 'hardware patch bytes are deterministic');
    assert.equal(first.report.slices, 8);
    assert.equal(first.report.scaled, false, 'the designed kit fits the hardware twelve-second budget');
    const parsed = parseDrumPatch(first.bytes);
    assert.equal(parsed.sampleRate, 44100, 'OP-Z/OP-1 patch rate');
    assert.equal(parsed.frames, expectedFrames, 'all eight canonical voices reach the patch');
    assert.equal(parsed.json.type, 'drum');
    for (let i = 1; i < 8; i++) assert.ok(parsed.json.start[i] > parsed.json.start[i - 1], 'real slice ' + i + ' advances');
    for (let i = 8; i < 24; i++) {
      assert.equal(parsed.json.start[i], parsed.json.start[7], 'unused slot duplicates final start');
      assert.equal(parsed.json.end[i], parsed.json.end[7], 'unused slot duplicates final end');
    }
  },
];

// ---------- modal analysis ----------
// A struck resonant object in free vibration IS a sum of damped sinusoids, so
// a recorded hit can be described by a short table of numbers you can edit.

function damped(sampleRate, seconds, modes) {
  const n = Math.round(seconds * sampleRate);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let v = 0;
    for (const m of modes) v += m.amp * Math.exp(-t / m.tau) * Math.sin(2 * Math.PI * m.f * t + m.phase);
    x[i] = v;
  }
  return x;
}

const modalCases = [
  function recoversASingleModeAlmostExactly() {
    const sr = 44100;
    const truth = { f: 220, tau: 0.35, amp: 0.6, phase: 0.9 };
    const fit = fitModal(damped(sr, 1, [truth]), sr);
    assert.ok(fit.modes.length >= 1, 'found a mode');
    const m = fit.modes[0];
    close(m.freqHz, truth.f, 0.5, 'frequency');
    close(m.tauSec, truth.tau, truth.tau * 0.05, 'decay time within 5%');
    close(m.amp, truth.amp, truth.amp * 0.1, 'amplitude within 10%');
    assert.ok(fit.fitDb < -30, 'residual below -30 dB: ' + fit.fitDb.toFixed(1));
  },
  function separatesThreeInharmonicModes() {
    // Inharmonic on purpose: a real drum is not a harmonic series.
    const sr = 44100;
    const truth = [
      { f: 110, tau: 0.48, amp: 0.52, phase: 0.35 },
      { f: 271, tau: 0.24, amp: 0.31, phase: -1.1 },
      { f: 523, tau: 0.095, amp: 0.19, phase: 1.8 },
    ];
    const fit = fitModal(damped(sr, 1, truth), sr);
    for (const want of truth) {
      const got = fit.modes.find((m) => Math.abs(m.freqHz - want.f) < 2);
      assert.ok(got, 'found the ' + want.f + ' Hz mode');
      close(got.tauSec, want.tau, want.tau * 0.1, want.f + ' Hz decay');
    }
    assert.ok(fit.fitDb < -30, 'three-mode residual: ' + fit.fitDb.toFixed(1));
  },
  function survivesNoiseAndDegradesHonestly() {
    const sr = 44100;
    const truth = [{ f: 180, tau: 0.3, amp: 0.5, phase: 0 }];
    const clean = damped(sr, 1, truth);
    const rand = mulberry32(0x1234);
    const noisy = Float32Array.from(clean, (v) => v + (rand() * 2 - 1) * 0.016);
    const fit = fitModal(noisy, sr);
    const m = fit.modes.find((x) => Math.abs(x.freqHz - 180) < 2);
    assert.ok(m, 'the mode is still found under noise');
    // Pure noise is not modal and must not be described as if it were.
    const pure = Float32Array.from({ length: sr }, () => rand() * 2 - 1);
    const noiseFit = fitModal(pure, sr);
    assert.ok(noiseFit.modes.length <= 2,
      'white noise yields few or no confident modes, got ' + noiseFit.modes.length);
  },
  function resynthesisRoundTripsAndStaysBounded() {
    const sr = 44100;
    const truth = [{ f: 150, tau: 0.4, amp: 0.7, phase: 0.2 }];
    const src = damped(sr, 0.8, truth);
    const fit = fitModal(src, sr);
    const out = synthModal(fit.modes, sr, 0.8);
    assert.equal(out.length, Math.round(0.8 * sr), 'requested length');
    let inPeak = 0;
    let outPeak = 0;
    for (let i = 0; i < src.length; i++) inPeak = Math.max(inPeak, Math.abs(src[i]));
    for (let i = 0; i < out.length; i++) {
      assert.ok(Number.isFinite(out[i]), 'finite resynthesis');
      outPeak = Math.max(outPeak, Math.abs(out[i]));
    }
    assert.ok(outPeak <= inPeak * 1.5, 'resynthesis stays bounded: ' + (outPeak / inPeak).toFixed(3));
    assert.equal(fit.residual.length, src.length, 'residual matches the input length');
  },
  function degenerateInputsReturnNothingNotGarbage() {
    const sr = 44100;
    for (const [label, x] of [
      ['empty', new Float32Array(0)],
      ['zeros', new Float32Array(1000)],
      ['single', new Float32Array(1)],
      ['dc', Float32Array.from({ length: 1000 }, () => 0.5)],
    ]) {
      const fit = fitModal(x, sr);
      assert.ok(Array.isArray(fit.modes), label + ' returns a mode list');
      for (const m of fit.modes) {
        assert.ok(Number.isFinite(m.freqHz) && Number.isFinite(m.tauSec), label + ' modes are finite');
      }
    }
  },
];

// ---------- offline render paths ----------
// The harness never touched renderWav/renderSongWav, which is exactly how two
// out-of-scope references shipped: FREEZE and song export threw ReferenceError
// on any project with a sidechain duck, and only at the moment of printing.
// These drive both paths through a stub OfflineAudioContext.

function renderStubCtx(gainLog = [], channels = 2, length = 4410, sampleRate = 44100) {
  const nodes = () => {
    // Every scheduled gain value is recorded. The send amounts were assigned
    // once at strip creation and never scheduled again, which is how one
    // scene's reverb send survived into every later scene of a song.
    const events = [];
    return {
      connect() {}, disconnect() {},
      events,
      gain: { value: 1, setValueAtTime(v, t) { events.push([v, t]); }, linearRampToValueAtTime() {},
        setTargetAtTime() {}, cancelScheduledValues() {}, setValueCurveAtTime() {} },
      pan: { value: 0 },
      playbackRate: { value: 1 },
      frequency: { value: 0 }, Q: { value: 0 },
      start() {}, stop() {}, curve: null, type: '', buffer: null, normalize: true,
      delayTime: { value: 0 },
    };
  };
  const createGain = () => { const n = nodes(); gainLog.push(n); return n; };
  return {
    sampleRate,
    currentTime: 0,
    destination: nodes(),
    createGain, createStereoPanner: nodes, createBufferSource: nodes,
    createBiquadFilter: nodes, createWaveShaper: nodes, createConvolver: nodes,
    createDelay: nodes, createIIRFilter: nodes,
    createBuffer: (ch, len, rate) => new AudioBuffer({ numberOfChannels: ch, length: len, sampleRate: rate }),
    startRendering: async () => new AudioBuffer({ numberOfChannels: channels, length, sampleRate }),
  };
}

function duckedMachine() {
  const pcm = new Float32Array(4410);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(2 * Math.PI * 220 * i / 44100);
  const mk = (steps, extra = {}) => ({
    sample: { channels: [pcm], sampleRate: 44100, label: 'S' },
    steps: Uint8Array.from(steps), stepData: {}, len: 16,
    gainDb: 0, pan: 0, mute: false, solo: false,
    duckSource: -1, duckDb: 12, choke: false, sendVerb: 0, sendDelay: 0,
    voice: normalizeVoice(null), ...extra,
  });
  const scene = (i, tracks) => ({ id: 's' + i, name: 'S', bpm: 120, swing: 50, seed: 99 * (i + 1), tracks });
  // Track 1 is ducked BY track 0: this is the routing that broke both renders.
  const scenes = [
    scene(0, [mk([1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      mk([0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0], { duckSource: 0, duckDb: 9 })]),
    scene(1, [mk([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      mk([0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], { duckSource: 0, duckDb: 6 })]),
  ];
  const m = { activeScene: 0, scenes, song: { chain: [], loop: true }, space: createSpace() };
  Object.defineProperties(m, {
    tracks: { get() { return this.scenes[this.activeScene].tracks; } },
    bpm: { get() { return this.scenes[this.activeScene].bpm; }, set(v) { this.scenes[this.activeScene].bpm = v; } },
    swing: { get() { return this.scenes[this.activeScene].swing; } },
  });
  return m;
}

function stubSequencer(machine, gainLog = []) {
  const prevOffline = globalThis.OfflineAudioContext;
  globalThis.OfflineAudioContext = function (channels, length, sampleRate) {
    return renderStubCtx(gainLog, channels, length, sampleRate);
  };
  const seq = new Sequencer({ ctx: null, master: null });
  seq.setMachine(machine);
  return { seq, restore: () => { globalThis.OfflineAudioContext = prevOffline; } };
}

const renderCases = [
  function tailAllocationFinishesDryPlateDelayAndSemanticAudioOnly() {
    const m = duckedMachine();
    const track = m.tracks[0];
    track.sample = {
      channels: [new Float32Array(44100)], sampleRate: 44100, label: 'ONE SECOND',
    };
    const compiled = {
      totalSec: 2,
      events: [{ tSec: 1.875, track: 0, gain: 1, rate: 1 }],
    };

    track.sendVerb = 0;
    track.sendDelay = 0;
    close(renderDurationSec(m, compiled), 2.88, 1e-12,
      'dry voice release plus the scheduler stop pad');

    track.sendVerb = 1;
    m.space.verbMix = 1;
    m.space.verbSec = 0.4;
    close(renderDurationSec(m, compiled), 3.292, 1e-12,
      'enabled plate carries its exact 12 ms predelay and impulse length');

    track.sendVerb = 0;
    track.sendDelay = 1;
    m.space.delayMix = 1;
    m.space.delayFeedback = 0.5;
    m.space.delayDivision = '1/4';
    const repeats = Math.ceil(
      Math.log(10 ** (RENDER_TAIL_FLOOR_DB / 20)) / Math.log(m.space.delayFeedback),
    );
    close(renderDurationSec(m, compiled), 2.88 + 0.5 * repeats, 1e-12,
      'delay stops after its last repeat at or above the declared amplitude floor');

    close(renderDurationSec(m, {
      totalSec: 2.875,
      events: [],
      semanticEvents: [{ outEndSec: 2.875 }],
    }), 2.877, 1e-12, 'semantic scheduler stop pad is part of artifact duration');
  },
  function songTailPlannerResolvesTheEventSectionScene() {
    const m = duckedMachine();
    m.scenes[0].tracks[0].sample = {
      channels: [new Float32Array(4410)], sampleRate: 44100, label: 'SHORT',
    };
    m.scenes[1].tracks[0].sample = {
      channels: [new Float32Array(44100)], sampleRate: 44100, label: 'LONG',
    };
    const compiled = {
      totalSec: 4,
      sections: [
        { scene: 0, startSec: 0, endSec: 2 },
        { scene: 1, startSec: 2, endSec: 4 },
      ],
      events: [{ tSec: 3.875, track: 0, gain: 1, rate: 1 }],
    };
    close(renderDurationSec(m, compiled), 4.88, 1e-12,
      'song tail uses the long sample in scene two, not the active-scene alias');
  },
  async function limiterSuccessIsExplicitAndFailureIsFailClosed() {
    const input = new AudioBuffer({ numberOfChannels: 2, length: 32, sampleRate: 48000 });
    const result = await masterLimit(input, async (buffer, cfg) => {
      assert.equal(cfg.ceiling, -0.3, 'the declared ceiling reaches the processor');
      return buffer;
    });
    assert.equal(result.buffer, input);
    assert.equal(result.applied, true);
    assert.equal(result.ceilingDbtp, -0.3);
    assert.equal(Object.isFrozen(result), true, 'limiter evidence cannot be rewritten');

    await assert.rejects(
      masterLimit(input, async () => { throw new Error('processor unavailable'); }),
      /MASTER LIMITER FAILED.*processor unavailable/,
      'a processor error cannot fall through to an unlimited export',
    );
    await assert.rejects(
      masterLimit(input, async () => new AudioBuffer({
        numberOfChannels: 2, length: 16, sampleRate: 48000,
      })),
      /MASTER LIMITER FAILED.*output format changed/,
      'a malformed limiter result cannot be reported as mastered',
    );
  },
  async function generatedPreloadsMatchTheImportGraphAndIndex() {
    const generated = execFileSync(process.execPath, ['scripts/gen-preload.mjs'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    });
    const [snippet, index, serviceWorker] = await Promise.all([
      readFile(new URL('../docs/preload-snippet.html', import.meta.url), 'utf8'),
      readFile(new URL('../index.html', import.meta.url), 'utf8'),
      readFile(new URL('../sw.js', import.meta.url), 'utf8'),
    ]);
    assert.equal(snippet, generated,
      'docs/preload-snippet.html is the current generated static import graph');
    const hrefs = (html) => [...html.matchAll(/rel="modulepreload" href="([^"]+)"/g)]
      .map((match) => match[1]);
    assert.deepEqual(hrefs(index), hrefs(generated),
      'index modulepreloads exactly match the generated dependency order');
    const precachedModules = new Set(
      [...serviceWorker.matchAll(/['"](?:\.\/)?(js\/[^'"]+)['"]/g)]
        .map((match) => match[1]),
    );
    for (const href of hrefs(generated)) {
      assert.equal(precachedModules.has(href), true,
        `${href} is present in the versioned service-worker precache`);
    }
  },
  async function patternFreezeSurvivesADuckRouting() {
    const m = duckedMachine();
    const { seq, restore } = stubSequencer(m);
    try {
      const bytes = await seq.renderWav(2);
      assert.ok(bytes, 'FREEZE produced output with a duck configured');
    } finally { restore(); }
  },
  async function songRenderSurvivesADuckRoutingAcrossScenes() {
    const m = duckedMachine();
    m.song.chain.push({ scene: 0, reps: 1 }, { scene: 1, reps: 1 });
    const { seq, restore } = stubSequencer(m);
    try {
      const out = await seq.renderSongWav(24);
      assert.ok(out && out.bytes, 'song render produced output');
      assert.ok(out.totalSec > 0, 'song has a duration: ' + out.totalSec);
      assert.ok(out.totalSec >= out.machineTotalSec, 'artifact covers the complete musical grid');
      assert.deepEqual(out.limiter, { applied: true, ceilingDbtp: -0.3 },
        'song render reports a limiter only after it succeeds');
    } finally { restore(); }
  },
  async function rendersStillWorkWithNoDucksAtAll() {
    const m = duckedMachine();
    for (const scene of m.scenes) for (const t of scene.tracks) t.duckSource = -1;
    const { seq, restore } = stubSequencer(m);
    try {
      assert.ok(await seq.renderWav(1), 'FREEZE without ducks');
      m.song.chain.push({ scene: 0, reps: 1 });
      assert.ok((await seq.renderSongWav(24)).bytes, 'song render without ducks');
    } finally { restore(); }
  },
];

// ---------- scene sends, restore hydration, clamp parity, worker protocol ----------
// Everything below covers a fix from the 2026-08-03 refinement audit. Each one
// was invisible because nothing ran the path: the recurring failure mode here.

const sceneSendCases = [
  async function eachSceneGetsItsOwnVerbSend() {
    const m = duckedMachine();
    m.scenes[0].tracks[0].sendVerb = 0.9;
    m.scenes[1].tracks[0].sendVerb = 0.1;
    m.song.chain.push({ scene: 0, reps: 1 }, { scene: 1, reps: 1 });
    const gains = [];
    const { seq, restore } = stubSequencer(m, gains);
    try {
      await seq.renderSongWav(24);
      // One node carrying BOTH amounts is the send: voice gains ramp to 1 and
      // duck gains use setTargetAtTime, so neither can produce this pair.
      const send = gains.find((g) => g.events.some((e) => e[0] === 0.9)
        && g.events.some((e) => e[0] === 0.1));
      assert.ok(send, 'a send gain was automated to both scenes amounts');
      const at09 = send.events.find((e) => e[0] === 0.9)[1];
      const at01 = send.events.find((e) => e[0] === 0.1)[1];
      assert.ok(at01 > at09, 'the second scene amount lands later: '
        + at09.toFixed(3) + ' then ' + at01.toFixed(3));
    } finally { restore(); }
  },
  async function aSendSwitchedOnByALaterSceneStillArrives() {
    const m = duckedMachine();
    m.scenes[0].tracks[0].sendVerb = 0;      // dry verse: no send node exists yet
    m.scenes[1].tracks[0].sendVerb = 0.8;    // chorus turns it on
    m.song.chain.push({ scene: 0, reps: 1 }, { scene: 1, reps: 1 });
    const gains = [];
    const { seq, restore } = stubSequencer(m, gains);
    try {
      await seq.renderSongWav(24);
      const send = gains.find((g) => g.events.some((e) => e[0] === 0.8));
      assert.ok(send, 'the send node was built when the second scene asked for it');
    } finally { restore(); }
  },
  async function delaySendsFollowTheSceneToo() {
    const m = duckedMachine();
    m.scenes[0].tracks[1].sendDelay = 0.7;
    m.scenes[1].tracks[1].sendDelay = 0.2;
    m.song.chain.push({ scene: 0, reps: 1 }, { scene: 1, reps: 1 });
    const gains = [];
    const { seq, restore } = stubSequencer(m, gains);
    try {
      await seq.renderSongWav(24);
      const send = gains.find((g) => g.events.some((e) => e[0] === 0.7)
        && g.events.some((e) => e[0] === 0.2));
      assert.ok(send, 'the delay send was automated per scene as well');
    } finally { restore(); }
  },
];

const hydrateCases = [
  function hydrateSampleKeepsTheRole() {
    const frames = 8;
    const flat = new Float32Array(frames * 2);
    for (let i = 0; i < flat.length; i++) flat[i] = i / flat.length;
    const meta = { frames, channelCount: 2, sampleRate: 44100, label: 'KICK 01', role: 'KICK' };
    const s = hydrateSample(meta, flat);
    assert.equal(s.role, 'KICK', 'role survived hydration');
    assert.equal(s.channels.length, 2);
    assert.equal(s.channels[0].length, frames);
    assert.equal(s.sampleRate, 44100);
    assert.equal(s.label, 'KICK 01');
    assert.equal(s.channels[1][0], flat[frames], 'channel 2 starts at the right offset');
  },
  function aRestoredDrumStillStretchesPercussively() {
    // The whole point of carrying role: stretchMode decides WSOLA vs vocoder,
    // and an undefined role silently means vocoder.
    const meta = { frames: 4, channelCount: 1, sampleRate: 44100, label: 'S', role: 'SNARE' };
    const s = hydrateSample(meta, new Float32Array(4));
    assert.equal(stretchMode(s.role), 'percussive');
    assert.equal(stretchMode(undefined), 'tonal', 'and this is what it used to get');
  },
  function roleSurvivesTheFullSerializeRoundTrip() {
    const project = createProject([]);
    const pcm = new Float32Array(16);
    const id = registerAsset(project, {
      kind: 'sample', label: 'HAT', sampleRate: 44100, frames: 16, role: 'HAT',
    });
    const track = project.machine.scenes[0].tracks[0];
    track.sampleId = id;
    track.sample = { channels: [pcm], sampleRate: 44100, label: 'HAT', role: 'HAT' };
    const { json, sampleFiles } = serializeProject(project, { repairs: [], sourceBytes: null });
    assert.equal(json.assets[id].role, 'HAT', 'role is written to the save');
    const file = sampleFiles.find((f) => f.id === id);
    const back = hydrateSample(json.assets[id], new Float32Array(file.bytes.buffer || file.bytes));
    assert.equal(back.role, 'HAT', 'and comes back off disk');
  },
  function hydrateSampleRefusesShortOrMissingData() {
    assert.equal(hydrateSample(null, new Float32Array(4)), null);
    assert.equal(hydrateSample({ frames: 4, channelCount: 1 }, null), null);
    assert.equal(hydrateSample({ frames: 8, channelCount: 2 }, new Float32Array(4)), null,
      'a truncated sample file is refused, not sliced into empty channels');
  },
];

const clampParityCases = [
  function restoreAndTheCompilerAgreeOnFitSteps() {
    // These disagreed: |0 truncates, Math.round rounds, so 2.6 played as two
    // steps after a reload and three before it.
    for (const raw of [2.6, 0.4, 7.5, 63.9, -3, 999]) {
      const project = createProject([]);
      const doc = snapshotDoc(project, { repairs: [], sourceBytes: null });
      doc.machine.scenes[0].tracks[0].voice = { ...createVoice(), fitSteps: raw };
      applySnapshot(doc, { project, runtime: { repairs: [] } });
      const restored = project.machine.scenes[0].tracks[0].voice.fitSteps;
      const compiled = normalizeVoice({ fitSteps: raw }).fitSteps;
      assert.equal(restored, compiled, 'fitSteps ' + raw + ': restore ' + restored + ' vs compiler ' + compiled);
    }
  },
  function everyVoiceRangeAgreesAcrossRestoreAndCompile() {
    const wild = {
      start: -1, end: 40, pitch: 99, attack: 0.01, release: 9999,
      lpf: 1, res: 90, hpf: 5, drive: 100, fitSteps: 500,
    };
    const project = createProject([]);
    const doc = snapshotDoc(project, { repairs: [], sourceBytes: null });
    doc.machine.scenes[0].tracks[0].voice = { ...createVoice(), ...wild };
    applySnapshot(doc, { project, runtime: { repairs: [] } });
    const restored = project.machine.scenes[0].tracks[0].voice;
    const compiled = normalizeVoice({ ...createVoice(), ...wild });
    for (const key of Object.keys(wild)) {
      assert.equal(restored[key], compiled[key], key + ': restore ' + restored[key] + ' vs compiler ' + compiled[key]);
    }
  },
];

// Worker replies now echo the job they answer. Without it a caller could only
// assume the next message belonged to its most recent request, which is false
// whenever two jobs overlap: one promise took the other's result and the other
// never settled at all.
// The tag busts the ESM cache: these modules register self.onmessage at import
// time, so a module already imported by another suite (repair-worker is) would
// never see the stub, and a second call would reuse the first one's caches.
async function runWorkerModule(path, message, tag) {
  const sent = [];
  const prevSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  globalThis.self = { postMessage: (m) => sent.push(m), onmessage: null };
  try {
    await import(path + '?probe=' + tag);
    assert.equal(typeof globalThis.self.onmessage, 'function',
      path + ' registered a message handler');
    globalThis.self.onmessage({ data: message });
  } finally {
    if (prevSelf) Object.defineProperty(globalThis, 'self', prevSelf);
    else delete globalThis.self;
  }
  return sent;
}

const workerProtocolCases = [
  async function theLoudnessWorkerEchoesItsJob() {
    const mono = new Float32Array(48000);
    for (let i = 0; i < mono.length; i++) mono[i] = 0.2 * Math.sin(2 * Math.PI * 440 * i / 48000);
    const sent = await runWorkerModule('../workers/loudness-worker.js',
      { type: 'measure', job: 7, channels: [mono], sampleRate: 48000 }, 'loudness');
    assert.ok(sent.length, 'the worker replied');
    for (const msg of sent) assert.equal(msg.job, 7, msg.type + ' carried its job id');
    assert.ok(sent.some((m) => m.type === 'done'), 'and finished');
  },
  async function theRepairWorkerEchoesItsJob() {
    const ch = new Float32Array(4096);
    const sent = await runWorkerModule('../workers/repair-worker.js', {
      type: 'repair', job: 42, channels: [ch], sampleRate: 44100,
      regions: [{ t0: 0.01, t1: 0.02, f0: 200, f1: 400, strength: 1 }],
    }, 'repair');
    assert.ok(sent.length, 'the worker replied');
    for (const msg of sent) assert.equal(msg.job, 42, msg.type + ' carried its job id');
  },
  async function theAnalysisWorkerEchoesItsJobOnBothPaths() {
    const mono = new Float32Array(44100);
    for (let i = 0; i < mono.length; i++) mono[i] = Math.sin(2 * Math.PI * 110 * i / 44100);
    const ok = await runWorkerModule('../workers/analysis-worker.js', {
      type: 'analyze', job: 3, mono, sampleRate: 44100,
      anchors: { bpm: null, barOneTime: null }, generation: 5,
    }, 'analysis-ok');
    assert.ok(ok.length, 'the worker replied');
    for (const msg of ok) assert.equal(msg.job, 3, msg.type + ' carried its job id');
    // The error path too: no mono and nothing cached for this generation.
    const bad = await runWorkerModule('../workers/analysis-worker.js', {
      type: 'analyze', job: 9, sampleRate: 44100,
      anchors: { bpm: null, barOneTime: null }, generation: 404,
    }, 'analysis-miss');
    const err = bad.find((m) => m.type === 'error');
    assert.ok(err, 'a cache miss with no audio is an error');
    assert.equal(err.job, 9, 'and the error names its job');
  },
];

// ---------- portable .yjkt project bundles ----------

const bundleCases = [
  function storeZipRoundTripKeepsNamesAndBytes() {
    const source = new Uint8Array([0, 1, 2, 127, 128, 255]);
    const zip = buildBundle([
      ['project.json', '{"formatVersion":2}'],
      ['samples/a1.f32', source],
    ], { date: new Date(2026, 6, 28, 12, 0, 0) });
    const entries = readBundle(zip);
    assert.equal(new TextDecoder().decode(entries.get('project.json')), '{"formatVersion":2}');
    assert.deepEqual(Array.from(entries.get('samples/a1.f32')), Array.from(source));
  },
  function serializedProjectBecomesAPortableArchive() {
    const project = createProject([]);
    project.fileName = 'field interview.wav';
    const id = registerAsset(project, {
      kind: 'sample', label: 'VOICE', sampleRate: 48000, frames: 4, role: 'VOCAL',
    });
    const track = project.machine.scenes[0].tracks[0];
    track.sampleId = id;
    track.sample = {
      channels: [new Float32Array([0.25, -0.5, 0.75, -1])],
      sampleRate: 48000, label: 'VOICE', role: 'VOCAL',
    };
    const runtime = { repairs: [], sourceBytes: new Uint8Array([82, 73, 70, 70]).buffer };
    const serialized = serializeProject(project, runtime);
    const parsed = parseProjectEntries(readBundle(buildBundle(
      projectEntries(serialized, runtime.sourceBytes),
    )));
    assert.equal(parsed.json.fileName, 'field interview.wav');
    assert.equal(parsed.source.byteLength, 4);
    assert.ok(parsed.samples.has(id), 'sample PCM is carried in the project');
    const sample = hydrateSample(parsed.json.assets[id], parsed.samples.get(id));
    assert.deepEqual(Array.from(sample.channels[0]), [0.25, -0.5, 0.75, -1]);
  },
  function corruptEntryIsRefusedBeforeImport() {
    const zip = buildBundle([['project.json', '{"formatVersion":2}']]);
    const broken = zip.slice();
    const view = new DataView(broken.buffer);
    const nameLen = view.getUint16(26, true);
    const extraLen = view.getUint16(28, true);
    broken[30 + nameLen + extraLen] ^= 1;
    assert.throws(() => readBundle(broken), /checksum/);
  },
  function unsafeAndDuplicatePathsAreRefused() {
    assert.throws(() => buildBundle([['../source.bin', new Uint8Array(1)]]), /unsafe/);
    assert.throws(() => buildBundle([
      ['project.json', '{}'], ['project.json', '{}'],
    ]), /duplicate/);
  },
  function projectFilenamesArePortableAndBounded() {
    assert.equal(safeProjectName('My rough mix.wav'), 'My-rough-mix.yjkt');
    assert.equal(safeProjectName('../../'), 'yellowjacket-project.yjkt');
    assert.ok(safeProjectName('x'.repeat(200)).length <= 85);
  },
];

// ---------- multi-instrument Studio ----------

const studioCases = [
  function defaultRackHasSixIndependentPolyphonicParts() {
    const studio = createStudio();
    assert.equal(studio.tracks.length, 6);
    assert.ok(studio.tracks.every((track) => track.steps.length === 64));
    assert.equal(studio.tracks[0].preset, 'bass');
    assert.equal(studio.tracks[2].preset, 'pad');
    assert.notEqual(studio.tracks[0].synth, studio.tracks[1].synth, 'sound documents are not shared');
  },
  function chordsAndNoteNamesAreDeterministic() {
    assert.deepEqual(chordNotes(60, 'major'), [60, 64, 67]);
    assert.deepEqual(chordNotes(60, 'minor'), [60, 63, 67]);
    assert.deepEqual(chordNotes(60, 'seventh'), [60, 64, 67, 70]);
    assert.equal(noteName(60), 'C4');
    assert.equal(noteName(61), 'C#4');
  },
  function swingNeverChangesTheLengthOfAPair() {
    const straight = studioStepSeconds(123);
    for (const swing of [50, 57, 66, 75]) {
      close(studioStepDuration(123, swing, 0) + studioStepDuration(123, swing, 1), straight * 2, 1e-12, 'swing pair');
    }
  },
  function noteEventsClampAtTheDocumentBoundary() {
    assert.deepEqual(normalizeStep({ note: 999, chord: 'nope', velocity: -2, gate: 99 }), {
      note: 127, chord: 'single', velocity: 0.05, gate: 16,
    });
    assert.equal(normalizeStep(null), null);
  },
  function presetsReplaceSoundWithoutSharingPresetObjects() {
    const studio = createStudio();
    applyInstrumentPreset(studio.tracks[0], 'glass');
    assert.equal(studio.tracks[0].name, 'GLASS');
    assert.equal(studio.tracks[0].synth.detune, 1200);
    studio.tracks[0].synth.detune = 3;
    applyInstrumentPreset(studio.tracks[1], 'glass');
    assert.equal(studio.tracks[1].synth.detune, 1200);
  },
  function studioOnlyProjectsRoundTripAndCountAsContent() {
    const project = createProject([]);
    project.studio.touched = true;
    project.studio.bpm = 137;
    project.studio.bars = 3;
    project.studio.keyRoot = 9;
    project.studio.scale = 'dorian';
    project.studio.ideaSeed = 7654321;
    project.studio.tracks[1].steps[18] = { note: 54, chord: 'minor', velocity: 0.7, gate: 1.5 };
    project.studio.tracks[1].synth.cutoff = 777;
    assert.equal(projectHasContent(project, {}), true);
    const doc = snapshotDoc(project, { repairs: [], sourceBytes: null });
    const restored = createProject([]);
    applySnapshot(doc, { project: restored, runtime: { repairs: [] } });
    assert.equal(restored.studio.bpm, 137);
    assert.equal(restored.studio.bars, 3);
    assert.equal(restored.studio.keyRoot, 9);
    assert.equal(restored.studio.scale, 'dorian');
    assert.equal(restored.studio.ideaSeed, 7654321);
    assert.deepEqual(restored.studio.tracks[1].steps[18], { note: 54, chord: 'minor', velocity: 0.7, gate: 1.5 });
    assert.equal(restored.studio.tracks[1].synth.cutoff, 777);
  },
  function scaleMathStaysInKeyAcrossOctaves() {
    assert.equal(scaleNote(0, 'minor', 0, 4), 60);
    assert.equal(scaleNote(0, 'minor', 2, 4), 63);
    assert.equal(scaleNote(0, 'minor', 7, 4), 72);
    assert.equal(scaleNote(2, 'major', 4, 3), 57);
  },
  function ideaGeneratorIsDeterministicAndUsesEveryPart() {
    const a = createStudio(); const b = createStudio();
    generateStudioIdea(a, 12345); generateStudioIdea(b, 12345);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.equal(a.bars, 2);
    assert.ok(a.tracks.every((track) => track.steps.some(Boolean)), 'every instrument got a playable part');
    assert.ok(a.tracks.flatMap((track) => track.steps.filter(Boolean)).every((step) => step.note >= 0 && step.note <= 127));
  },
  function barTransformsRotateInvertAndDuplicateWithoutAliasing() {
    const studio = createStudio(); const track = studio.tracks[0];
    track.steps[0] = { note: 48, chord: 'single', velocity: 0.8, gate: 1 };
    track.steps[4] = { note: 55, chord: 'single', velocity: 0.8, gate: 1 };
    assert.equal(transformStudioBar(track, 0, 'right'), true);
    assert.equal(track.steps[1].note, 48);
    assert.equal(transformStudioBar(track, 0, 'invert'), true);
    assert.equal(track.steps[1].note, 55);
    assert.equal(transformStudioBar(track, 0, 'duplicate'), true);
    assert.deepEqual(track.steps[17], track.steps[1]);
    assert.notEqual(track.steps[17], track.steps[1]);
  },
  function midiVariableLengthsCoverBoundaryValues() {
    assert.deepEqual(variableLength(0), [0]);
    assert.deepEqual(variableLength(127), [127]);
    assert.deepEqual(variableLength(128), [0x81, 0]);
    assert.deepEqual(variableLength(16383), [0xff, 0x7f]);
  },
  function midiExportIsACompleteFormatZeroFile() {
    const studio = createStudio(); generateStudioIdea(studio, 7);
    const midi = studioMidiFile(studio);
    assert.equal(new TextDecoder().decode(midi.subarray(0, 4)), 'MThd');
    assert.equal(new DataView(midi.buffer).getUint16(8), 0, 'format zero');
    assert.equal(new DataView(midi.buffer).getUint16(10), 1, 'one merged track');
    assert.equal(new DataView(midi.buffer).getUint16(12), 480, '480 PPQ');
    assert.equal(new TextDecoder().decode(midi.subarray(14, 18)), 'MTrk');
    assert.ok(Array.from(midi).some((byte) => (byte & 0xf0) === 0x90), 'contains note-on events');
    assert.deepEqual(Array.from(midi.subarray(-4)), [0, 0xff, 0x2f, 0], 'ends with end-of-track');
  },
  function laterBarsDoNotCollapseOntoTrackLength() {
    const studio = createStudio(); studio.bars = 2; studio.tracks[0].length = 16;
    studio.tracks[0].steps[16] = { note: 60, chord: 'single', velocity: 0.8, gate: 1 };
    const bytes = Array.from(studioMidiFile(studio));
    assert.ok(bytes.some((byte, index) => byte === 0x90 && bytes[index + 1] === 48),
      'bar two note exported at the heard transposition instead of repeating bar one');
  },
];

// ---------- semantic MIDI Loom ----------

function sequentialTranscript(count) {
  return Array.from({ length: count }, (_, index) => ({
    text: 'w' + index,
    start: index,
    end: index + 1,
  }));
}

const loomCases = [
  function rawMidiCapturePreservesHumanTimingVelocityAndGate() {
    const bpm = 120;
    const swing = 60;
    const gesture = capturedMidiGesture([
      { note: 60, velocity: 96, channel: 2, startSec: 0, endSec: 0.19 },
      { note: 67, velocity: 127, channel: 2, startSec: 0.37, endSec: 0.81 },
    ], { bpm, swing, inputId: 'op-z', label: 'OP-Z' });
    assert.ok(gesture);
    assert.equal(gesture.kind, 'midi-capture');
    assert.equal(gesture.inputId, 'op-z');
    assert.equal(gesture.events.length, 2);
    close(gesture.events[1].rawStartSec, 0.37, 1e-12, 'raw onset survives');
    close(gesture.events[1].durationSec, 0.44, 1e-12, 'note-off becomes gate duration');
    close(gesture.events[0].velocity, 96 / 127, 1e-12, 'hardware velocity survives');
    assert.ok(gesture.events[1].gridStep % 1 !== 0,
      'as-played feel rides as a fractional Machine grid position');
    assert.equal(gesture.events[0].eventRef.surface, 'wire-midi');
    close(captureBarDuration(bpm, swing), stepTime(16, bpm, swing), 1e-12,
      'capture bar shares the Machine compiler clock');
  },
  function rawMidiCaptureIsContentAddressedAndBoundedToOneBar() {
    const notes = [
      { note: 48, velocity: 64, channel: 0, startSec: 0.1, endSec: 0.3 },
      { note: 50, velocity: 80, channel: 0, startSec: 99, endSec: 100 },
    ];
    const a = capturedMidiGesture(notes, { bpm: 100, swing: 55, inputId: 'midi-a' });
    const b = capturedMidiGesture(notes, { bpm: 100, swing: 55, inputId: 'midi-a' });
    assert.deepEqual(a, b, 'the same bar compiles to the same gesture and id');
    assert.equal(a.events.length, 1, 'onsets after the bar are dropped');
    assert.notEqual(capturedMidiGesture([
      { note: 49, velocity: 64, channel: 0, startSec: 0.1, endSec: 0.3 },
    ], { bpm: 100, swing: 55 }).id, a.id, 'musical content changes identity');
    assert.equal(capturedMidiGesture([], { bpm: 100, swing: 55 }), null);
  },
  function midiVelocityDomainNeverMistakesRawOneForFullScale() {
    const note = { note: 60, velocity: 1, channel: 0, startSec: 0, endSec: 0.1 };
    const wire = capturedMidiGesture([note], { bpm: 120, swing: 50 });
    const normalized = capturedMidiGesture([note], {
      bpm: 120, swing: 50, velocityDomain: 'normalized',
    });
    assert.equal(wire.velocityDomain, 'midi');
    close(wire.events[0].velocity, 1 / 127, 1e-15,
      'WIRE raw velocity 1 remains the quietest non-zero MIDI velocity');
    assert.equal(normalized.events[0].velocity, 1,
      'already-normalized callers must opt into their distinct domain');
    assert.notEqual(wire.id, normalized.id, 'the declared domain participates in capture identity');
    assert.throws(() => capturedMidiGesture([note], { velocityDomain: 'guess' }),
      /VELOCITY DOMAIN/);
  },
  function studioScoreCompilerMatchesHeardTransposeAndSwing() {
    const studio = createStudio();
    studio.bpm = 120; studio.swing = 62; studio.bars = 1;
    studio.tracks[0].steps[0] = { note: 60, chord: 'major', velocity: 0.7, gate: 1.5 };
    studio.tracks[0].steps[1] = { note: 62, chord: 'single', velocity: 0.8, gate: 1 };
    const score = compileStudioScore(studio, { trackIndex: 0 });
    assert.equal(score.length, 2);
    assert.deepEqual(score[0].heardNotes, [48, 52, 55], 'track transpose is part of the canonical score');
    close(score[1].startSec, studioStepDuration(120, 62, 0), 1e-12, 'swung logical start');
    close(score[0].durationSec, studioStepSeconds(120) * 1.5, 1e-12, 'gate uses straight sixteenth');
  },
  function transcriptMaterialKeepsExactWordOriginsAndSkipsCuts() {
    const words = [
      { text: 'anything', start: 1, end: 1.4 },
      { text: 'you', start: 1.5, end: 1.7, deleted: true },
      { text: 'say', start: 1.8, end: 2.1 },
    ];
    const material = transcriptMaterials(words, 0, 2, { id: 'src-1', name: 'voice.wav', size: 99 });
    assert.equal(material.length, 2);
    assert.equal(material[0].label, 'anything');
    assert.deepEqual(material.map((item) => item.origin.wordStart), [0, 2]);
    assert.deepEqual(material.map((item) => item.origin.wordEnd), [0, 2]);
    assert.equal(material[1].origin.sourceSize, 99);
  },
  function denseTranscriptSelectionBecomesEightBalancedStablePhrases() {
    const words = sequentialTranscript(16);
    const source = { id: 'sha256:dense', name: 'dense.wav', size: 1600 };
    const first = transcriptMaterials(words, 0, words.length - 1, source);
    const second = transcriptMaterials(words, words.length - 1, 0, source);
    assert.equal(first.length, LOOM_TRANSCRIPT_MAX_VOICES);
    assert.deepEqual(first, second, 'range direction cannot change phrase allocation or ids');
    assert.deepEqual(first.map((item) => [item.origin.wordStart, item.origin.wordEnd]), [
      [0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11], [12, 13], [14, 15],
    ], 'equal-duration words become equal-duration contiguous phrases');
    assert.equal(first[0].label, 'w0 w1');
    assert.deepEqual(first.map((item) => [item.origin.startSec, item.origin.endSec]), [
      [0, 2], [2, 4], [4, 6], [6, 8], [8, 10], [10, 12], [12, 14], [14, 16],
    ]);
    assert.equal(new Set(first.map((item) => item.id)).size, first.length,
      'grouped ids are stable and distinct');

    const durations = [4, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    let cursor = 0;
    const varied = durations.map((duration, index) => {
      const word = { text: 'v' + index, start: cursor, end: cursor + duration };
      cursor += duration;
      return word;
    });
    const balanced = transcriptMaterials(varied, 0, varied.length - 1, source);
    assert.deepEqual([balanced[0].origin.wordStart, balanced[0].origin.wordEnd], [0, 0],
      'the long word stays alone instead of following a count-only partition');
    assert.ok(balanced.slice(1).every((item) => item.origin.endSec - item.origin.startSec <= 2),
      'short words form the remaining duration-balanced phrases');
  },
  function deletedAndInvalidWordsAreHardGroupingBoundaries() {
    const words = sequentialTranscript(13);
    words[5].deleted = true;
    words[10].end = words[10].start;
    const material = transcriptMaterials(words, 0, 12, { id: 'src-cuts' });
    assert.equal(material.length, LOOM_TRANSCRIPT_MAX_VOICES);
    const expectedKept = [0, 1, 2, 3, 4, 6, 7, 8, 9, 11, 12];
    const represented = material.flatMap((item) => {
      assert.equal(item.origin.startSec, words[item.origin.wordStart].start);
      assert.equal(item.origin.endSec, words[item.origin.wordEnd].end);
      assert.ok(!(item.origin.wordStart < 5 && item.origin.wordEnd > 5),
        'a phrase never swallows the deleted word');
      assert.ok(!(item.origin.wordStart < 10 && item.origin.wordEnd > 10),
        'a phrase never swallows the invalid word');
      return Array.from(
        { length: item.origin.wordEnd - item.origin.wordStart + 1 },
        (_, offset) => item.origin.wordStart + offset,
      );
    });
    assert.deepEqual(represented, expectedKept, 'every kept word appears once and in order');
  },
  function thirtyTwoKeptWordsAreAcceptedWithoutOmission() {
    const words = sequentialTranscript(LOOM_TRANSCRIPT_MAX_WORDS);
    const first = transcriptMaterials(words, 0, words.length - 1, { id: 'src-max' });
    const second = transcriptMaterials(words, 0, words.length - 1, { id: 'src-max' });
    assert.equal(first.length, LOOM_TRANSCRIPT_MAX_VOICES);
    assert.deepEqual(first, second);
    const represented = first.flatMap((item) => Array.from(
      { length: item.origin.wordEnd - item.origin.wordStart + 1 },
      (_, offset) => item.origin.wordStart + offset,
    ));
    assert.deepEqual(represented, Array.from({ length: LOOM_TRANSCRIPT_MAX_WORDS }, (_, i) => i));
  },
  function moreThanThirtyTwoKeptWordsFailsExplicitlyInsteadOfTruncating() {
    const words = sequentialTranscript(LOOM_TRANSCRIPT_MAX_WORDS + 1);
    let fault = null;
    try {
      transcriptMaterials(words, 0, words.length - 1);
    } catch (error) {
      fault = error;
    }
    assert.ok(fault instanceof TranscriptMaterialError);
    assert.equal(fault.code, 'LOOM_TRANSCRIPT_WORD_LIMIT');
    assert.deepEqual(fault.details, {
      selectedCount: LOOM_TRANSCRIPT_MAX_WORDS + 1,
      maxWords: LOOM_TRANSCRIPT_MAX_WORDS,
    });
  },
  function moreThanEightDisjointKeptRunsFailsWithStructuredDetail() {
    const words = sequentialTranscript(17);
    for (let index = 1; index < words.length; index += 2) words[index].deleted = true;
    let fault = null;
    try {
      transcriptMaterials(words, 0, words.length - 1);
    } catch (error) {
      fault = error;
    }
    assert.ok(fault instanceof TranscriptMaterialError);
    assert.equal(fault.code, 'LOOM_TRANSCRIPT_TOO_DISJOINT');
    assert.deepEqual(fault.details, {
      selectedCount: 9,
      runCount: 9,
      maxVoices: LOOM_TRANSCRIPT_MAX_VOICES,
    });
  },
  function spanMaterialPartitionsWithoutInventingText() {
    const material = spanMaterials({ sourceId: 'src', sourceName: 'song.wav', startSec: 10, endSec: 14, segments: 4 });
    assert.deepEqual(material.map((item) => item.label), ['A', 'B', 'C', 'D']);
    assert.deepEqual(material.map((item) => [item.origin.startSec, item.origin.endSec]), [
      [10, 11], [11, 12], [12, 13], [13, 14],
    ]);
  },
  function demoGestureIsDeterministicAndMusicallySparse() {
    const first = demoMidiGesture(110, 56);
    const second = demoMidiGesture(110, 56);
    assert.deepEqual(first, second);
    assert.equal(first.events.length, 9);
    assert.deepEqual(first.events.map((event) => event.stepIndex), [0, 2, 4, 6, 8, 10, 11, 13, 14]);
  },
  function studioGesturePreservesLeadingRestsInsideTheChosenBar() {
    const studio = createStudio(); studio.bars = 2;
    studio.tracks[3].steps[20] = { note: 67, chord: 'single', velocity: 0.8, gate: 1 };
    const gesture = studioGesture(studio, 3, 1);
    assert.equal(gesture.events[0].stepIndex, 4);
    let expected = 0;
    for (let step = 16; step < 20; step++) expected += studioStepDuration(studio.bpm, studio.swing, step);
    close(gesture.events[0].startSec, expected, 1e-12, 'bar-local start retains four rests');
  },
  function studioGestureUsesTheTransposedNoteActuallyHeard() {
    const studio = createStudio();
    studio.tracks[0].steps[0] = { note: 60, chord: 'major', velocity: 0.8, gate: 1 };
    const gesture = studioGesture(studio, 0, 0);
    assert.equal(gesture.events[0].writtenNote, 60, 'written root remains available for provenance');
    assert.equal(gesture.events[0].rootNote, 48, 'Loom gesture follows the -12 instrument transpose');
    const plan = compileLoomPlan(spanMaterials({ startSec: 0, endSec: 1 }), gesture);
    assert.equal(plan.events[0].gesture.note, 48);
    assert.equal(plan.events[0].gesture.writtenNote, 60);
    assert.equal(plan.events[0].targets.studioNote, 48);
  },
  function weaveCyclesMaterialAndKeepsBothOrigins() {
    const material = spanMaterials({ sourceId: 'src', sourceName: 'voice.wav', sourceSize: 12, startSec: 2, endSec: 4, segments: 2 });
    const gesture = demoMidiGesture(120, 50);
    const plan = compileLoomPlan(material, gesture, { weaveNumber: 3 });
    assert.equal(plan.events.length, 9);
    assert.deepEqual(plan.events.slice(0, 4).map((event) => event.source.label), ['A', 'B', 'A', 'B']);
    assert.equal(plan.events[0].gesture.id, 'demo-midi-v1');
    assert.equal(plan.events[0].source.sourceId, 'src');
    assert.equal(plan.diagnostics.tracedCount, 9);
    assert.equal(traceLoomEvent(plan, plan.events[4].id), plan.events[4]);
  },
  function loomPlanIdentityIsCanonicalSha256OverMusicalContent() {
    assert.equal(sha256HexSync('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      'the synchronous digest matches the SHA-256 standard vector');
    const material = spanMaterials({
      sourceId: 'sha256:' + '1'.repeat(64), sourceName: 'voice.wav',
      sourceSize: 123, startSec: 0, endSec: 1, segments: 1,
    });
    const earlyGesture = demoMidiGesture(120, 50);
    const lateGesture = demoMidiGesture(120, 50);
    earlyGesture.events[0].gridStep = 0.125;
    lateGesture.events[0].gridStep = 0.875;
    const early = compileLoomPlan(material, earlyGesture, { weaveNumber: 1 });
    const sameMusic = compileLoomPlan(material, earlyGesture, { weaveNumber: 99 });
    const late = compileLoomPlan(material, lateGesture, { weaveNumber: 2 });
    assert.match(early.id, /^lp-sha256-[a-f0-9]{64}$/);
    assert.equal(early.contentId, early.id);
    assert.equal(canonicalLoomPlanId(early), early.id,
      'persisted identity recomputes from canonical owned content');
    assert.equal(early.id, sameMusic.id,
      'the operation counter is metadata, not part of the performance recipe');
    assert.equal(sameLoomPlanContent(early, sameMusic), true);
    assert.notEqual(early.id, late.id,
      'fractional as-played timing is output-affecting and changes identity');
    assert.equal(sameLoomPlanContent(early, late), false);
    assert.ok(early.events.every((event, index) =>
      event.id === early.id + '-event-' + (index + 1)),
    'event identity is derived deterministically from canonical plan identity');
  },
  function capturedNoteOffBoundsAudibleRenderAndLineage() {
    const material = spanMaterials({
      sourceId: 'sha256:' + '2'.repeat(64), sourceName: 'voice.wav',
      sourceSize: 48000, startSec: 0, endSec: 1, segments: 1,
    });
    const makePlan = (endSec) => compileLoomPlan(material, capturedMidiGesture([{
      note: 60, velocity: 64, channel: 0, startSec: 0, endSec,
    }], { bpm: 120, swing: 50, inputId: 'op-z' }));
    const short = makePlan(0.05);
    const long = makePlan(0.9);
    assert.notEqual(short.id, long.id, 'captured gate is canonical musical content');
    assert.equal(short.gesture.inputId, 'op-z', 'captured hardware identity reaches the plan');
    assert.equal(short.gesture.timing, 'as-played', 'capture timing domain reaches the plan');
    assert.equal(short.gesture.velocityDomain, 'midi', 'velocity domain reaches the plan');
    close(short.events[0].source.endSec, 0.05, 1e-12, 'short plan source boundary');
    close(long.events[0].source.endSec, 0.9, 1e-12, 'long plan source boundary');
    assert.equal(short.events[0].source.materialEndSec, 1,
      'the full selected material remains available for provenance');

    const project = createProject([]);
    const scene = project.machine.scenes[0];
    scene.bpm = 120;
    scene.swing = 50;
    const renderedEvent = (plan) => {
      scene.loomLane = {
        planId: plan.id, enabled: true, gainDb: -9, pan: 0,
        repeatSteps: 16, startStep: 0,
      };
      const render = compilePerformanceRender(project.machine, { [plan.id]: plan }, 1);
      assert.equal(render.semanticEvents.length, 1);
      return render.semanticEvents[0];
    };
    const shortEvent = renderedEvent(short);
    const longEvent = renderedEvent(long);
    close(shortEvent.sourceSpanSec, 0.05, 1e-12, 'live/offline compiler hears short gate');
    close(shortEvent.outDurationSec, 0.05, 1e-12, 'short output duration');
    close(shortEvent.trace.sourceEndSec, 0.05, 1e-12, 'short lineage boundary');
    close(longEvent.sourceSpanSec, 0.9, 1e-12, 'live/offline compiler hears long gate');
    close(longEvent.outDurationSec, 0.9, 1e-12, 'long output duration');
    close(longEvent.trace.sourceEndSec, 0.9, 1e-12, 'long lineage boundary');
  },
  function weavePitchContourIsBoundedToOneOctave() {
    const material = spanMaterials({ sourceId: 'src', startSec: 0, endSec: 1, segments: 1 });
    const gesture = demoMidiGesture();
    gesture.events[0].rootNote = 0;
    gesture.events[gesture.events.length - 1].rootNote = 127;
    const plan = compileLoomPlan(material, gesture);
    assert.ok(plan.events.every((event) => event.transform.semitones >= -12 && event.transform.semitones <= 12));
    assert.ok(plan.events.every((event) => event.transform.rate >= 0.5 && event.transform.rate <= 2));
  },
  function auditionHeadroomTracksWorstOverlap() {
    const material = spanMaterials({ startSec: 0, endSec: 3.599, segments: 4 });
    const plan = compileLoomPlan(material, demoMidiGesture(110, 56));
    const gain = loomHeadroomGain(plan, 160);
    assert.ok(gain < 0.25, 'the overlapping demo gets conservative mix-bus gain: ' + gain);
    const solo = compileLoomPlan(spanMaterials({ startSec: 0, endSec: 0.1, segments: 1 }), {
      id: 'one-note', label: 'ONE', channel: 0, bpm: 120, swing: 50, bars: 1,
      events: [{ eventRef: {}, trackIndex: 0, stepIndex: 0, startSec: 0, durationSec: 0.1,
        rootNote: 60, heardNotes: [60], velocity: 0.8, gate: 1, audible: true }],
    });
    close(loomHeadroomGain(solo, 1), 0.72, 1e-12, 'a single event keeps nominal headroom');
  },
  function hashlessPlansStayInspectableButCannotGoOnlineOrPrint() {
    const material = spanMaterials({ sourceId: 'src', sourceName: 'one.wav', sourceSize: 123, startSec: 0, endSec: 1 });
    const plan = compileLoomPlan(material, demoMidiGesture());
    assert.ok(plan.events.length > 0, 'legacy/hashless plan content remains inspectable');
    assert.equal(traceLoomEvent(plan, plan.events[0].id), plan.events[0]);
    assert.equal(sourceMatchesPlan(plan, { name: 'one.wav', size: 123 }), false,
      'filename and size are never treated as content identity');
    assert.equal(sourceMatchesPlan(plan, { name: 'two.wav', size: 123 }), false);
    assert.equal(sourceMatchesPlan(plan, { name: 'one.wav', size: 456 }), false);
    assert.equal(sourceMatchesPlan(plan, { hash: 'sha256:' + 'a'.repeat(64) }), false,
      'a runtime hash cannot make an unverified historical plan printable');
  },
  function shaIdentitySurvivesRenameAndRejectsDifferentBytes() {
    const hashA = 'sha256:' + 'a'.repeat(64);
    const hashB = 'sha256:' + 'b'.repeat(64);
    const plan = compileLoomPlan(spanMaterials({
      sourceId: hashA, sourceName: 'original.wav', sourceSize: 123,
      startSec: 0, endSec: 1,
    }), demoMidiGesture());
    assert.equal(sourceMatchesPlan(plan, {
      hash: hashA, name: 'renamed.wav', size: 999,
    }), true, 'content identity outranks display metadata');
    assert.equal(sourceMatchesPlan(plan, {
      hash: hashB, name: 'original.wav', size: 123,
    }), false, 'matching filename and size cannot impersonate different bytes');
  },
  function loomPlanPersistsWithoutPcmOrFormatBump() {
    const project = createProject([]);
    project.loom.weaveCount = 1;
    const plan = compileLoomPlan(
      spanMaterials({ sourceId: 'src', sourceName: 'voice.wav', startSec: 0, endSec: 1 }),
      demoMidiGesture(),
    );
    project.loom.plan = plan;
    project.loom.activePlanId = plan.id;
    project.loom.plans[plan.id] = plan;
    assert.equal(projectHasContent(project, {}), true);
    const doc = snapshotDoc(project, { repairs: [], sourceBytes: null });
    assert.equal(doc.formatVersion, FORMAT_VERSION);
    const restored = createProject([]);
    applySnapshot(doc, { project: restored, runtime: { repairs: [] } });
    assert.deepEqual(restored.loom, project.loom);
    assert.equal(sourceMatchesPlan(restored.loom.plan, {
      name: 'voice.wav', size: null,
    }), false, 'hashless plans survive restore only as offline inspectable recipes');
  },
  function persistenceRecomputesStalePlanAndEventIdsThenRemapsScenes() {
    const project = createProject([]);
    const plan = compileLoomPlan(spanMaterials({
      sourceId: 'sha256:' + '3'.repeat(64), sourceName: 'voice.wav',
      sourceSize: 48000, startSec: 0, endSec: 1, segments: 1,
    }), demoMidiGesture(120, 50));
    project.loom.plan = plan;
    project.loom.activePlanId = plan.id;
    project.loom.plans[plan.id] = plan;
    project.machine.scenes[0].loomLane.planId = plan.id;

    const doc = snapshotDoc(project, { repairs: [], sourceBytes: null });
    const saved = doc.loom.plans[plan.id];
    saved.events[0].gridStep = 0.375;
    doc.loom.plan = JSON.parse(JSON.stringify(saved));
    const staleEventId = saved.events[0].id;

    const restored = createProject([]);
    applySnapshot(doc, { project: restored, runtime: { repairs: [] } });
    const ids = Object.keys(restored.loom.plans);
    assert.equal(ids.length, 1);
    const restoredId = ids[0];
    const restoredPlan = restored.loom.plans[restoredId];
    assert.notEqual(restoredId, plan.id,
      'mutated musical content cannot retain a stale persisted identity');
    assert.equal(canonicalLoomPlanId(restoredPlan), restoredId);
    assert.equal(restored.loom.activePlanId, restoredId);
    assert.equal(restored.loom.plan, restoredPlan);
    assert.equal(restored.machine.scenes[0].loomLane.planId, restoredId,
      'scene references follow the verified canonical content');
    assert.notEqual(restoredPlan.events[0].id, staleEventId);
    assert.equal(restoredPlan.events[0].id, restoredId + '-event-1');
  },
  function loomCompilerRefusesMissingInputs() {
    assert.throws(() => compileLoomPlan([], demoMidiGesture()), /MATERIAL/);
    assert.throws(() => compileLoomPlan(spanMaterials({ startSec: 0, endSec: 1 }), null), /MIDI GESTURE/);
  },
];

// ---------- semantic performance compiler ----------

function performanceFixture() {
  const project = createProject([]);
  const scene = project.machine.scenes[0];
  scene.bpm = 120;
  scene.swing = 50;
  scene.loomLane = {
    planId: 'plan-a', enabled: true, gainDb: -9, pan: 0.15,
    repeatSteps: 16, startStep: 0,
  };
  const plan = {
    id: 'plan-a',
    events: [
      {
        id: 'word-one', gridStep: 0, stepIndex: 7, outStartSec: 99,
        source: {
          sourceId: 'sha256:source-a', sourceName: 'voice.wav', materialId: 'word-0',
          label: 'anything', startSec: 1, endSec: 1.25, wordStart: 0, wordEnd: 0,
        },
        gesture: {
          id: 'studio-bass-bar-1', label: 'STUDIO · BASS',
          eventRef: { surface: 'studio', trackId: 'bass', stepIndex: 0 },
          note: 48, velocity: 0.8, gate: 1,
        },
        transform: { kind: 'loom.bind', rate: 1, semitones: 0, voice: 1 },
      },
      {
        id: 'word-two', stepIndex: 4,
        source: {
          sourceId: 'sha256:source-a', sourceName: 'voice.wav', materialId: 'word-1',
          label: 'say', startSec: 2, endSec: 2.4, wordStart: 1, wordEnd: 1,
        },
        gesture: {
          id: 'studio-bass-bar-1', label: 'STUDIO · BASS',
          eventRef: { surface: 'studio', trackId: 'bass', stepIndex: 4 },
          note: 55, velocity: 0.7, gate: 0.8,
        },
        transform: { kind: 'loom.bind', rate: 2, semitones: 12, voice: 2 },
      },
    ],
  };
  return { project, machine: project.machine, scene, plan, plans: { 'plan-a': plan } };
}

const performanceCases = [
  function noLaneIsExactlyMachineNeutral() {
    const project = createProject([]);
    const track = project.machine.tracks[0];
    track.sample = { channels: [new Float32Array(32)], sampleRate: 48000, label: 'HIT' };
    track.steps[0] = 1;
    const expected = compileWindow(project.machine, 0, 1, { fill: true });
    const actual = compilePerformanceWindow(project.machine, {}, 0, 1, { fill: true });
    assert.deepEqual(actual.events, expected.events);
    assert.deepEqual(actual.ducks, expected.ducks);
    assert.deepEqual(actual.semanticEvents, []);
    assert.deepEqual(actual.lineage, []);
  },
  function halfOpenWindowsStitchWithoutAHitAtTheSeamTwice() {
    const { scene, plan } = performanceFixture();
    const whole = compileLoomWindow(plan, scene.loomLane, scene, 0, 1);
    const left = compileLoomWindow(plan, scene.loomLane, scene, 0, 0.5);
    const right = compileLoomWindow(plan, scene.loomLane, scene, 0.5, 1);
    assert.deepEqual([...left, ...right], whole);
    assert.equal(left.some((event) => event.tSec === 0.5), false);
    assert.equal(right.filter((event) => event.tSec === 0.5).length, 1);
    assert.equal(new Set(whole.map((event) => event.id)).size, whole.length);
  },
  function loomOnsetsRetargetToDestinationTempoAndSwing() {
    const { scene, plan } = performanceFixture();
    plan.events = [{ ...plan.events[0], id: 'odd-step', gridStep: 1, outStartSec: 42 }];
    scene.bpm = 120;
    scene.swing = 66;
    let event = compileLoomWindow(plan, scene.loomLane, scene, 0, 1)[0];
    close(event.tSec, 1 / 6, 1e-12, 'triplet swing destination step');
    scene.bpm = 60;
    scene.swing = 50;
    event = compileLoomWindow(plan, scene.loomLane, scene, 0, 1)[0];
    close(event.tSec, 0.25, 1e-12, 'destination tempo replaces Loom source seconds');
  },
  function laneRepeatsOnItsStepPeriodWithoutDrift() {
    const { scene, plan } = performanceFixture();
    plan.events = [plan.events[0]];
    const events = compileLoomWindow(plan, scene.loomLane, scene, 0, 4.01);
    assert.deepEqual(events.map((event) => event.tSec), [0, 2, 4]);
    assert.deepEqual(events.map((event) => event.cycle), [0, 1, 2]);
    assert.deepEqual(events.map((event) => event.id), [
      'plan-a:word-one:cycle-0', 'plan-a:word-one:cycle-1', 'plan-a:word-one:cycle-2',
    ]);
  },
  function objectAndMapRegistriesCompileDeterministically() {
    const { machine, plan, plans } = performanceFixture();
    const first = compilePerformanceWindow(machine, plans, 0, 3);
    const second = compilePerformanceWindow(machine, new Map([['plan-a', plan]]), 0, 3);
    assert.deepEqual(first, second);
    assert.deepEqual(compilePerformanceWindow(machine, plans, 0, 3), first);
  },
  function everySemanticEventCarriesCompleteLineage() {
    const { machine, plans } = performanceFixture();
    const compiled = compilePerformanceWindow(machine, plans, 0, 1);
    const event = compiled.semanticEvents[0];
    assert.equal(event.trace.planId, 'plan-a');
    assert.equal(event.trace.eventId, 'word-one');
    assert.equal(event.trace.sceneId, 's0');
    assert.equal(event.trace.source.sourceId, 'sha256:source-a');
    assert.equal(event.trace.source.wordStart, 0);
    assert.deepEqual(event.trace.gesture.eventRef,
      { surface: 'studio', trackId: 'bass', stepIndex: 0 });
    assert.equal(event.trace.transform.kind, 'loom.bind');
    assert.equal(event.trace.outStartSec, event.tSec);
    assert.equal(event.trace.outEndSec, event.outEndSec);
    assert.deepEqual(compiled.lineage[0], { id: event.id, ...event.trace });
  },
  function repeatedLongMaterialGetsOverlapSafeFiniteHeadroom() {
    const { scene, plan } = performanceFixture();
    scene.loomLane.repeatSteps = 4;
    scene.loomLane.gainDb = 6;
    plan.events = [{
      ...plan.events[0],
      source: { ...plan.events[0].source, startSec: 0, endSec: 4 },
      gesture: { ...plan.events[0].gesture, velocity: 0.92 },
    }];
    const events = compileLoomWindow(plan, scene.loomLane, scene, 0, 6);
    assert.ok(events.length > 8);
    assert.ok(events.every((event) => Number.isFinite(event.gain)
      && event.gain > 0 && event.headroomGain < 0.1));
    let worst = 0;
    for (const probe of events.map((event) => event.tSec + 1e-6)) {
      let sum = 0;
      for (const event of events) {
        if (event.tSec <= probe && event.outEndSec > probe) sum += event.gain;
      }
      worst = Math.max(worst, sum);
    }
    assert.ok(worst <= 0.900000000001, 'semantic bus peak ' + worst + ' stays within its budget');
  },
  function renderAndFullWindowShareTheExactSemanticStream() {
    const { machine, plans } = performanceFixture();
    const track = machine.tracks[0];
    track.sample = { channels: [new Float32Array(32)], sampleRate: 48000, label: 'HIT' };
    track.steps[0] = 1;
    const render = compilePerformanceRender(machine, plans, 2, { fill: false });
    const window = compilePerformanceWindow(machine, plans, 0, render.machineTotalSec, { fill: false });
    const machineOnly = compileRender(machine, 2, { fill: false });
    assert.deepEqual(render.semanticEvents, window.semanticEvents);
    assert.deepEqual(render.lineage, window.lineage);
    assert.deepEqual(render.events, machineOnly.events);
    assert.deepEqual(render.ducks, machineOnly.ducks);
    assert.equal(render.loopSec, machineOnly.loopSec);
    assert.equal(render.machineTotalSec, machineOnly.totalSec);
    assert.ok(render.totalSec >= render.machineTotalSec);
  },
  function semanticTailExtendsRenderWithoutStartingAnotherCycle() {
    const { machine, scene, plan, plans } = performanceFixture();
    plan.events = [{
      ...plan.events[0], id: 'last-step-word', gridStep: 15,
      source: { ...plan.events[0].source, startSec: 0, endSec: 1 },
      transform: { ...plan.events[0].transform, rate: 1 },
    }];
    scene.loomLane.repeatSteps = 16;
    const render = compilePerformanceRender(machine, plans, 1);
    assert.equal(render.loopSec, 2);
    assert.equal(render.machineTotalSec, 2);
    assert.equal(render.semanticEvents.length, 1, 'the cycle at the 2 s boundary is not compiled');
    close(render.semanticEvents[0].tSec, 1.875, 1e-12, 'last sixteenth starts inside Machine time');
    close(render.totalSec, 2.875, 1e-12, 'render allocation includes the complete source tail');
    close(render.lineage[0].outEndSec, render.totalSec, 1e-12, 'lineage and render tail agree');
  },
];

// ---------- native-rate decode (AUDIT-RESOLUTION 1) ----------

// Minimal RIFF/WAVE header. `extraChunk` inserts a chunk BEFORE 'fmt ' so the
// parser is forced to walk the chunk list rather than assume a fixed offset.
function wavBytes(rate, { extraChunk = null, channels = 1 } = {}) {
  const pre = extraChunk ? 8 + extraChunk.length : 0;
  const bytes = new Uint8Array(44 + pre);
  const dv = new DataView(bytes.buffer);
  const tag = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); dv.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE');
  let o = 12;
  if (extraChunk) {
    tag(o, 'LIST'); dv.setUint32(o + 4, extraChunk.length, true);
    bytes.set(extraChunk, o + 8);
    o += 8 + extraChunk.length;
  }
  tag(o, 'fmt '); dv.setUint32(o + 4, 16, true);
  dv.setUint16(o + 8, 1, true); dv.setUint16(o + 10, channels, true);
  dv.setUint32(o + 12, rate, true);
  dv.setUint32(o + 16, rate * channels * 2, true);
  dv.setUint16(o + 20, channels * 2, true); dv.setUint16(o + 22, 16, true);
  tag(o + 24, 'data'); dv.setUint32(o + 28, 0, true);
  return bytes;
}

// fLaC + STREAMINFO. Sample rate is 20 bits at bit offset 80 of the block body,
// which is byte 10 — the packing this test exists to pin down.
function flacBytes(rate) {
  const bytes = new Uint8Array(4 + 4 + 34);
  bytes.set([0x66, 0x4C, 0x61, 0x43], 0);      // 'fLaC'
  bytes[4] = 0x80;                              // last-block flag | type 0 STREAMINFO
  bytes[5] = 0; bytes[6] = 0; bytes[7] = 34;    // block length
  const b = 8;
  bytes[b + 10] = (rate >>> 12) & 0xFF;
  bytes[b + 11] = (rate >>> 4) & 0xFF;
  bytes[b + 12] = ((rate & 0x0F) << 4);
  return bytes;
}

const nativeRateCases = [
  function readsWavSampleRate() {
    assert.equal(sniffSampleRate(wavBytes(96000)), 96000);
    assert.equal(sniffSampleRate(wavBytes(192000)), 192000);
    assert.equal(sniffSampleRate(wavBytes(44100)), 44100);
  },
  function walksPastChunksBeforeFmt() {
    // A real-world WAV often carries LIST/bext before 'fmt '. Assuming offset 24
    // would read metadata bytes as a sample rate.
    const rate = sniffSampleRate(wavBytes(96000, { extraChunk: new Uint8Array(18).fill(0x41) }));
    assert.equal(rate, 96000);
  },
  function readsFlacSampleRate() {
    assert.equal(sniffSampleRate(flacBytes(96000)), 96000);
    assert.equal(sniffSampleRate(flacBytes(48000)), 48000);
  },
  function returnsNullForUnknownContainers() {
    // MP3 and friends top out at 48k, so the default context is already correct;
    // null is the signal to take that path rather than a wrong guess.
    assert.equal(sniffSampleRate(new Uint8Array([0xFF, 0xFB, 0x90, 0x00])), null, 'mp3 frame');
    assert.equal(sniffSampleRate(new Uint8Array(4)), null, 'garbage');
    assert.equal(sniffSampleRate(new Uint8Array(0)), null, 'empty');
    assert.equal(sniffSampleRate(wavBytes(96000).slice(0, 20)), null, 'truncated before fmt');
  },
  function rejectsImplausibleRates() {
    // A corrupt header must not push the decode context to an absurd rate.
    assert.equal(sniffSampleRate(wavBytes(3)), null, 'below the sane floor');
    assert.equal(sniffSampleRate(wavBytes(5000000)), null, 'above the sane ceiling');
  },
  function decodePlanKeepsNativeRateWithinMemoryBudget() {
    // 96 kHz stereo for 60 s is ~46 MB of float — comfortably decodable.
    const ok = planDecodeRate({ nativeRate: 96000, seconds: 60, channels: 2 });
    assert.equal(ok.rate, 96000);
    assert.equal(ok.downgraded, false);
  },
  async function exportReportsAllocationFailureInsteadOfDyingSilently() {
    // encodeWavWithStats allocates the whole file as one ArrayBuffer. Ten
    // minutes of 192 kHz stereo float is ~921 MB in a single allocation — only
    // possible since the 48 kHz decode cap was removed and 32-bit float added.
    // A RangeError inside a click handler leaves no status and no download, so
    // the button simply appears dead.
    const bench = await readFile(new URL('../js/app/bench-controller.js', import.meta.url), 'utf8');
    const start = bench.indexOf('function exportWav(');
    assert.ok(start >= 0, 'exportWav exists');
    const body = bench.slice(start, bench.indexOf('\n  }', start));
    assert.match(body, /try\s*\{/, 'the encode is guarded');
    assert.match(body, /catch/, 'and the failure is reported');
  },
  async function nativeDecodeAttemptLeavesTheFallbackSomethingToDecode() {
    // decodeAudioData detaches its input even when it REJECTS — verified in
    // Chrome: byteLength is 0 after an EncodingError. So attempting the
    // native-rate decode on the caller's ArrayBuffer destroys it, and the
    // `if (!buffer) buffer = await ctx.decodeAudioData(arrayBuffer)` fallback
    // is handed zero bytes and throws. A file that decodes fine at 48 kHz
    // would fail to load at all. The attempt must run on a copy.
    const engine = await readFile(new URL('../js/audio-engine.js', import.meta.url), 'utf8');
    const offlineDecode = engine.match(/offline\.decodeAudioData\(([^)]*)\)/);
    assert.ok(offlineDecode, 'the native-rate decode exists');
    assert.match(offlineDecode[1], /\.slice\(/,
      'native-rate decode must run on a copy, or the fallback gets detached bytes');
  },
  function footprintCountsEverythingALoadRetains() {
    // A load keeps FOUR allocations alive, not one: the decoded buffer, the mono
    // mixdown, the peak pyramid, and the encoded bytes held for persistence and
    // RESTORE. Budgeting only the decoded buffer under-counts by roughly half.
    const f = decodedFootprintBytes({ rate: 48000, seconds: 10, channels: 2, encodedBytes: 0 });
    const frames = 48000 * 10;
    const decoded = frames * 2 * 4;
    const mono = frames * 4;
    // 2 arrays x 4 bytes per block at 64/512/4096 samples.
    const peaks = frames * 8 * (1 / 64 + 1 / 512 + 1 / 4096);
    assert.ok(Math.abs(f - (decoded + mono + peaks)) < 1024, 'all three in-memory copies');
    assert.ok(f > decoded * 1.4, 'materially larger than the decoded buffer alone');
  },
  function footprintIncludesTheRetainedEncodedFile() {
    const without = decodedFootprintBytes({ rate: 48000, seconds: 10, channels: 2, encodedBytes: 0 });
    const with5MB = decodedFootprintBytes({ rate: 48000, seconds: 10, channels: 2, encodedBytes: 5e6 });
    assert.equal(with5MB - without, 5e6, 'sourceBytes is held for the life of the session');
  },
  function highResolutionLoadThatUsedToSlipThroughNowDowngrades() {
    // Ten minutes of 96 kHz 24-bit stereo. The decoded buffer alone is ~461 MB,
    // which passed the old check; the real retained footprint is over 1 GB.
    // This is the bug the audit's own fix introduced by removing the 48 kHz cap.
    const seconds = 600, rate = 96000, channels = 2;
    const encodedBytes = rate * seconds * channels * 3;   // 24-bit source
    const decodedOnly = rate * seconds * channels * 4;
    assert.ok(decodedOnly < 1024 * 1024 * 1024, 'the decoded buffer alone looks affordable');
    const plan = planDecodeRate({ nativeRate: rate, seconds, channels, encodedBytes, contextRate: 48000 });
    assert.equal(plan.downgraded, true, 'the true footprint does not fit');
    assert.equal(plan.rate, 48000);
    assert.match(plan.reason, /GB/, 'says how much it would have needed');
  },
  function aShortHighResolutionLoadIsStillKeptAtFullRate() {
    // The budget must not become so conservative that it defeats the feature.
    const plan = planDecodeRate({
      nativeRate: 192000, seconds: 120, channels: 2, encodedBytes: 192000 * 120 * 2 * 3, contextRate: 48000,
    });
    assert.equal(plan.downgraded, false, 'two minutes at 192 kHz still fits');
    assert.equal(plan.rate, 192000);
  },
  function decodePlanFallsBackWhenNativeRateWouldExhaustMemory() {
    // A 3-hour 192 kHz stereo file is ~8 GB decoded. Native rate must yield.
    const big = planDecodeRate({ nativeRate: 192000, seconds: 10800, channels: 2, contextRate: 48000 });
    assert.equal(big.downgraded, true);
    assert.equal(big.rate, 48000, 'falls back to the context rate');
    assert.ok(big.reason, 'says why, so the UI can tell the user');
  },
  function probesWavChannelsAndDuration() {
    // The memory budget needs real seconds, and both containers carry an exact
    // length — guessing from encoded byte count is wrong for FLAC by ~2x.
    const bytes = wavBytes(96000, { channels: 2 });
    const dv = new DataView(bytes.buffer);
    dv.setUint32(40, 96000 * 2 * 2 * 3, true);   // 3 seconds of stereo 16-bit
    const probe = probeContainer(bytes);
    assert.equal(probe.sampleRate, 96000);
    assert.equal(probe.channels, 2);
    assert.equal(Math.round(probe.seconds), 3);
  },
  function probesFlacChannelsAndDuration() {
    const bytes = flacBytes(96000);
    bytes[8 + 12] |= 0x02;                        // channels-1 = 1, so stereo
    const total = 96000 * 5;                      // 5 seconds
    bytes[8 + 13] = (bytes[8 + 13] & 0xF0) | ((total / 4294967296) & 0x0F);
    bytes[8 + 14] = (total >>> 24) & 0xFF;
    bytes[8 + 15] = (total >>> 16) & 0xFF;
    bytes[8 + 16] = (total >>> 8) & 0xFF;
    bytes[8 + 17] = total & 0xFF;
    const probe = probeContainer(bytes);
    assert.equal(probe.sampleRate, 96000);
    assert.equal(probe.channels, 2);
    assert.equal(Math.round(probe.seconds), 5);
  },
  function probeReturnsNullsForUnknownContainers() {
    const probe = probeContainer(new Uint8Array([0xFF, 0xFB, 0x90, 0x00]));
    assert.equal(probe.sampleRate, null);
    assert.equal(probe.seconds, 0, 'unknown length, so the budget cannot be computed');
  },
  function decodePlanUsesContextRateWhenNativeRateIsUnknown() {
    const unknown = planDecodeRate({ nativeRate: null, seconds: 60, channels: 2, contextRate: 48000 });
    assert.equal(unknown.rate, 48000);
    assert.equal(unknown.downgraded, false, 'not a downgrade — nothing better was known');
  },
];

// ---------- Standard MIDI File import (AUDIT-RESOLUTION 4) ----------

function vlq(value) {
  const out = [value & 0x7F];
  let v = value >>> 7;
  while (v > 0) { out.unshift((v & 0x7F) | 0x80); v >>>= 7; }
  return out;
}

function smfBytes({ format = 0, division = 480, tracks = [[]] } = {}) {
  const out = [];
  const push = (...b) => out.push(...b);
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
  const u32 = (n) => [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
  const u16 = (n) => [(n >>> 8) & 0xFF, n & 0xFF];
  push(...ascii('MThd'), ...u32(6), ...u16(format), ...u16(tracks.length), ...u16(division));
  for (const events of tracks) {
    const body = [...events, ...vlq(0), 0xFF, 0x2F, 0x00];
    push(...ascii('MTrk'), ...u32(body.length), ...body);
  }
  return new Uint8Array(out);
}

const smfCases = [
  function parsesHeaderAndOneNote() {
    const bytes = smfBytes({ division: 480, tracks: [[
      ...vlq(0), 0x90, 60, 100,
      ...vlq(480), 0x80, 60, 0,
    ]] });
    const song = parseSmf(bytes);
    assert.equal(song.division, 480);
    assert.equal(song.format, 0);
    assert.equal(song.tracks.length, 1);
    const notes = song.tracks[0].notes;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].note, 60);
    assert.equal(notes[0].velocity, 100);
    assert.equal(notes[0].startTicks, 0);
    assert.equal(notes[0].durationTicks, 480, 'note-off closes the note');
  },
  function treatsZeroVelocityNoteOnAsNoteOff() {
    // The single most common real-world encoding, and the one a naive parser
    // turns into a note that never ends.
    const bytes = smfBytes({ tracks: [[
      ...vlq(0), 0x90, 64, 90,
      ...vlq(240), 0x90, 64, 0,
    ]] });
    const notes = parseSmf(bytes).tracks[0].notes;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].durationTicks, 240);
  },
  function honoursRunningStatus() {
    // Status byte omitted on repeat — legal, ubiquitous, and silently
    // misparsed as data by anything that does not implement it.
    const bytes = smfBytes({ tracks: [[
      ...vlq(0), 0x90, 60, 100,
      ...vlq(0), 62, 100,
      ...vlq(480), 0x80, 60, 0,
      ...vlq(0), 62, 0,
    ]] });
    const notes = parseSmf(bytes).tracks[0].notes;
    assert.equal(notes.length, 2, 'both notes recovered without a repeated status byte');
    assert.deepEqual(notes.map((n) => n.note).sort((a, b) => a - b), [60, 62]);
  },
  function readsTempoAndSkipsSysex() {
    const bytes = smfBytes({ tracks: [[
      ...vlq(0), 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20,   // 500000 us/qn = 120 bpm
      ...vlq(0), 0xF0, ...vlq(3), 0x7E, 0x7F, 0xF7,     // sysex, must not derail
      ...vlq(0), 0x90, 60, 100,
      ...vlq(96), 0x80, 60, 0,
    ]] });
    const song = parseSmf(bytes);
    assert.equal(Math.round(song.bpm), 120);
    assert.equal(song.tracks[0].notes.length, 1, 'sysex skipped by declared length');
  },
  function defaultsToOneTwentyBpmWithNoTempoMeta() {
    const song = parseSmf(smfBytes({ tracks: [[...vlq(0), 0x90, 60, 100, ...vlq(48), 0x80, 60, 0]] }));
    assert.equal(song.bpm, 120);
  },
  function keepsMultipleTracksSeparate() {
    const track = (note) => [...vlq(0), 0x90, note, 100, ...vlq(480), 0x80, note, 0];
    const song = parseSmf(smfBytes({ format: 1, tracks: [track(60), track(67)] }));
    assert.equal(song.tracks.length, 2);
    assert.equal(song.tracks[0].notes[0].note, 60);
    assert.equal(song.tracks[1].notes[0].note, 67);
  },
  function rejectsNonMidiBytes() {
    assert.throws(() => parseSmf(new Uint8Array([1, 2, 3, 4])), /MThd/i);
    assert.throws(() => parseSmf(new Uint8Array(0)), /MThd/i);
  },
  function quantizesOntoStudioSixteenths() {
    // 480 ticks per quarter means one sixteenth is 120 ticks. A note at tick 240
    // is the third sixteenth, i.e. step index 2.
    const bytes = smfBytes({ division: 480, tracks: [[
      ...vlq(240), 0x90, 60, 127,
      ...vlq(120), 0x80, 60, 0,
    ]] });
    const studio = smfToStudio(parseSmf(bytes));
    const steps = studio.tracks[0].steps;
    assert.equal(steps[2].note, 60, 'lands on step 2');
    assert.equal(steps[0], null);
    assert.ok(steps[2].velocity > 0.9, 'velocity 127 maps near 1.0');
  },
  function clampsToSixTracksAndSixtyFourSteps() {
    const track = (note) => [...vlq(0), 0x90, note, 100, ...vlq(120), 0x80, note, 0];
    const song = parseSmf(smfBytes({ format: 1, tracks: [60, 61, 62, 63, 64, 65, 66, 67].map(track) }));
    const studio = smfToStudio(song);
    assert.equal(studio.tracks.length, 6, 'STUDIO has six parts');
    for (const t of studio.tracks) assert.equal(t.steps.length, 64, 'four bars of sixteenths');
  },
  function dropsNotesBeyondFourBars() {
    // Bar five starts at tick 480*4*4 = 7680; nothing there can be represented.
    const bytes = smfBytes({ division: 480, tracks: [[
      ...vlq(7680), 0x90, 60, 100,
      ...vlq(120), 0x80, 60, 0,
    ]] });
    const studio = smfToStudio(parseSmf(bytes));
    assert.ok(studio.tracks[0].steps.every((s) => s === null), 'past the window, so not silently folded back');
    assert.ok(studio.dropped > 0, 'reports what would not fit');
  },
  function carriesTempoIntoStudioBpm() {
    const bytes = smfBytes({ tracks: [[
      ...vlq(0), 0xFF, 0x51, 0x03, 0x09, 0x27, 0xC0,   // 600000 us/qn = 100 bpm
      ...vlq(0), 0x90, 60, 100, ...vlq(120), 0x80, 60, 0,
    ]] });
    assert.equal(Math.round(smfToStudio(parseSmf(bytes)).bpm), 100);
  },
  function producesStepsStudioAccepts() {
    // The real contract: whatever comes out must survive the model's own
    // normalizer unchanged, or it cannot be loaded into a project.
    const bytes = smfBytes({ tracks: [[...vlq(0), 0x90, 60, 100, ...vlq(240), 0x80, 60, 0]] });
    const step = smfToStudio(parseSmf(bytes)).tracks[0].steps[0];
    assert.deepEqual(normalizeStep(step), step, 'round-trips through normalizeStep');
  },
];

// ---------- output resolution (AUDIT-RESOLUTION 2 and 3) ----------

// A buffer shaped like an AudioBuffer, including a sample above full scale —
// the case that separates float export from integer export.
function fakeBuffer(channels, sampleRate = 96000) {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate,
    getChannelData: (i) => channels[i],
  };
}

async function wavHeader(blob) {
  const dv = new DataView(await blob.arrayBuffer());
  const ascii = (o, n) => String.fromCharCode(...Array.from({ length: n }, (_, i) => dv.getUint8(o + i)));
  return {
    dv,
    riff: ascii(0, 4),
    wave: ascii(8, 4),
    fmtSize: dv.getUint32(16, true),
    formatCode: dv.getUint16(20, true),
    channels: dv.getUint16(22, true),
    sampleRate: dv.getUint32(24, true),
    bits: dv.getUint16(34, true),
  };
}

// Walks the chunk list rather than assuming 'data' sits at 36, because the
// float header legally carries cbSize and a 'fact' chunk ahead of it.
async function wavSamples(blob) {
  const dv = new DataView(await blob.arrayBuffer());
  const ascii = (o, n) => String.fromCharCode(...Array.from({ length: n }, (_, i) => dv.getUint8(o + i)));
  const bits = dv.getUint16(34, true);
  let at = 12;
  while (at + 8 <= dv.byteLength) {
    const id = ascii(at, 4);
    const size = dv.getUint32(at + 4, true);
    if (id === 'data') {
      const out = [];
      for (let o = at + 8; o + bits / 8 <= at + 8 + size; o += bits / 8) {
        out.push(bits === 32 ? dv.getFloat32(o, true) : dv.getInt16(o, true) / 0x7FFF);
      }
      return out;
    }
    at += 8 + size + (size % 2);
  }
  return [];
}

const wavExportCases = [
  async function writesIeeeFloatFormatCodeForThirtyTwoBit() {
    // Format code 1 means integer PCM. A 32-bit stream tagged 1 is read as
    // garbage by every DAW, so the code itself is the load-bearing assertion.
    const buf = fakeBuffer([Float32Array.from([0, 0.5, -0.5])]);
    const head = await wavHeader(encodeWav(buf, 32));
    assert.equal(head.formatCode, 3, 'WAVE_FORMAT_IEEE_FLOAT');
    assert.equal(head.bits, 32);
    assert.equal(head.riff, 'RIFF');
    assert.equal(head.wave, 'WAVE');
  },
  async function floatHeaderCarriesCbSizeAndFactChunk() {
    // Non-PCM formats require cbSize; the fact chunk carries the frame count.
    const buf = fakeBuffer([Float32Array.from([0, 0.25])]);
    const head = await wavHeader(encodeWav(buf, 32));
    assert.equal(head.fmtSize, 18, 'fmt grows by cbSize for non-PCM');
    const dv = head.dv;
    const ascii = (o, n) => String.fromCharCode(...Array.from({ length: n }, (_, i) => dv.getUint8(o + i)));
    assert.equal(ascii(38, 4), 'fact', 'fact chunk follows fmt');
    assert.equal(dv.getUint32(46, true), 2, 'fact states the frame count');
  },
  async function floatKeepsSamplesAboveFullScale() {
    // The reason float export exists: an over survives instead of being
    // flattened to 1.0, so a hot bounce can still be pulled back down.
    const buf = fakeBuffer([Float32Array.from([1.5, -1.25, 0.5])]);
    const got = await wavSamples(encodeWav(buf, 32));
    assert.equal(got[0], 1.5, 'over preserved exactly');
    assert.equal(got[1], -1.25);
    assert.equal(got[2], 0.5);
  },
  async function integerExportStillClampsOvers() {
    const buf = fakeBuffer([Float32Array.from([1.5, -1.25])]);
    const got = await wavSamples(encodeWav(buf, 16));
    assert.ok(got[0] <= 1.0001, '16-bit still clamps');
    assert.ok(got[1] >= -1.0001);
  },
  async function floatExportNeverDithers() {
    // Dither exists to decorrelate quantization error. Float has none to hide.
    const buf = fakeBuffer([Float32Array.from([0.1, 0.2, 0.3])]);
    const { stats } = encodeWavWithStats(buf, 32);
    assert.equal(stats.dither, 'none');
  },
  async function floatExportStillReportsOvers() {
    const buf = fakeBuffer([Float32Array.from([1.5, 0.2])]);
    const { stats } = encodeWavWithStats(buf, 32);
    assert.equal(stats.clippedSamples, 1, 'counted, even though not clamped');
  },
  async function exportPreservesTheSourceSampleRate() {
    // A 192 kHz session must not be written out as 48 kHz.
    const buf = fakeBuffer([Float32Array.from([0, 0.1])], 192000);
    assert.equal((await wavHeader(encodeWav(buf, 32))).sampleRate, 192000);
    assert.equal((await wavHeader(encodeWav(buf, 24))).sampleRate, 192000);
  },
  function studioBounceFollowsTheSessionRate() {
    // Hardcoding 48000 threw away a 96 kHz session on the way out.
    assert.equal(bounceSampleRate(96000), 96000);
    assert.equal(bounceSampleRate(192000), 192000);
  },
  function studioBounceFallsBackWhenNoSourceIsLoaded() {
    // STUDIO works with no recording at all; 48 kHz stays the source-free default.
    assert.equal(bounceSampleRate(0), 48000);
    assert.equal(bounceSampleRate(null), 48000);
    assert.equal(bounceSampleRate(undefined), 48000);
  },
  function studioBounceNeverGoesBelowTheDefault() {
    // A 22 kHz voice memo should not drag the instrument bounce down with it.
    assert.equal(bounceSampleRate(22050), 48000);
  },
];

// ---------- update safety ----------
//
// The seven Workers are fetched lazily by `new Worker()` at first use, so they
// resolve through whatever service worker controls the page AT THAT MOMENT, not
// the one that served its modules. skipWaiting + clients.claim therefore hands a
// running page a NEWER worker than its own code, while the activate handler
// deletes the cache that page was still reading from. A bench holding an
// unsaved session must never be reconfigured underneath itself.

const updateSafetyCases = [
  async function serviceWorkerDoesNotSeizeAlreadyOpenPages() {
    const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
    // Isolate the install listener alone: the message listener that follows it
    // legitimately calls skipWaiting, so slicing to 'activate' would swallow it.
    const start = sw.indexOf("self.addEventListener('install'");
    assert.ok(start >= 0, 'install listener exists');
    const next = sw.indexOf('self.addEventListener(', start + 20);
    const install = sw.slice(start, next < 0 ? sw.length : next);
    assert.doesNotMatch(install, /skipWaiting/,
      'install must not take over pages running the previous build');
    assert.doesNotMatch(sw, /clients\.claim\(\)/,
      'claiming an open page swaps its lazily-fetched workers mid-session');
    // Every skipWaiting CALL must be the request-driven one. Matching on the
    // parentheses keeps prose about skipWaiting from counting as a call.
    const calls = sw.match(/skipWaiting\s*\(/g) || [];
    assert.equal(calls.length, 1, 'exactly one skipWaiting call, in the message handler');
  },
  async function precacheBypassesTheHttpCache() {
    // cache.addAll() issues ordinary fetches, which the browser may satisfy from
    // its own HTTP cache — pinning a PREVIOUS build's file into the NEW version's
    // cache, permanently, until someone bumps VERSION again. Observed live: v37
    // shipped a corrected css/yj.css, curl saw one rule, and the browser saw the
    // superseded two-rule copy. Requesting with cache:'reload' forces the network.
    const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
    const install = sw.slice(sw.indexOf("self.addEventListener('install'"));
    const body = install.slice(0, install.indexOf('self.addEventListener(', 20));
    assert.match(body, /cache:\s*'reload'/, 'precache must bypass the HTTP cache');
  },
  async function serviceWorkerStillActivatesOnUserRequest() {
    // Waiting forever is not the goal: the page offers a reload, and this is
    // the channel that honours it.
    const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
    assert.match(sw, /addEventListener\('message'/, 'listens for the page');
    assert.match(sw, /SKIP_WAITING/, 'honours an explicit request to take over');
    assert.match(sw, /self\.skipWaiting\(\)/, 'skipWaiting still exists, but only on request');
  },
  async function oldCachesSurviveUntilTheOldPagesAreGone() {
    // The delete sweep runs in activate, which — without skipWaiting — cannot
    // run while a page from the previous version is still open.
    const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
    const activate = sw.slice(sw.indexOf("addEventListener('activate'"));
    assert.match(activate, /caches\.delete/, 'still cleans up, just not underneath a live page');
  },
  async function thePageOffersAnUpdateInsteadOfApplyingItSilently() {
    const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    assert.match(index, /updatefound/, 'notices a new build');
    assert.match(index, /controllerchange/, 'reloads only once the new worker is in charge');
    assert.match(index, /SKIP_WAITING/, 'the reload affordance asks the worker to take over');
    // An unsaved audio session must not be discarded by an automatic reload.
    assert.doesNotMatch(index, /updatefound[\s\S]{0,400}location\.reload\(\)/,
      'no reload without the user asking for it');
  },
];

// ---------- auto-kit assignment ----------
//
// HARVEST labels and scores 24 slices by role and then leaves all eight tracks
// empty, so a harvested source is not playable until eight separate manual
// assignments have been made. Driving the real app end to end on a field
// recording is what surfaced it: the kit said KICK 3 SNARE 3 TONE 13 and every
// track still read EMPTY.

const clip = (id, tag, score, start = 0) => ({ id, tag, score, start, end: start + 0.2 });

const autoKitCases = [
  function fillsOneTrackPerRoleInPlayingOrder() {
    const clips = [
      clip('a', 'snare', 0.5), clip('b', 'kick', 0.5), clip('c', 'hat', 0.5), clip('d', 'bass', 0.5),
    ];
    const plan = planKitAssignment(clips, 8);
    assert.equal(plan.length, 8, 'one slot per machine track');
    assert.equal(plan[0], 'b', 'kick first');
    assert.equal(plan[1], 'a', 'then snare');
    assert.equal(plan[2], 'c', 'then hat');
    assert.equal(plan[3], 'd', 'then bass');
  },
  function picksTheBestScoringClipWithinARole() {
    const clips = [clip('weak', 'kick', 0.1), clip('strong', 'kick', 0.9), clip('mid', 'kick', 0.5)];
    assert.equal(planKitAssignment(clips, 8)[0], 'strong');
  },
  function neverAssignsTheSameClipTwice() {
    // A source with one usable slice must not fill all eight tracks with it.
    const plan = planKitAssignment([clip('only', 'kick', 0.9)], 8);
    assert.equal(plan.filter((id) => id === 'only').length, 1);
    assert.equal(plan.filter(Boolean).length, 1);
  },
  function backfillsEmptyRolesFromWhateverIsLeft() {
    // The frog recording produced no HAT and no CRASH but thirteen TONE slices.
    // Leaving those tracks empty would waste most of the harvest.
    const clips = [
      clip('k', 'kick', 0.9), clip('t1', 'tone', 0.8), clip('t2', 'tone', 0.7),
      clip('t3', 'tone', 0.6), clip('t4', 'tone', 0.5),
    ];
    const plan = planKitAssignment(clips, 8);
    assert.equal(plan.filter(Boolean).length, 5, 'every usable slice placed');
    assert.equal(new Set(plan.filter(Boolean)).size, 5, 'and each placed once');
  },
  function leavesTrailingSlotsEmptyRatherThanRepeating() {
    const plan = planKitAssignment([clip('a', 'kick', 0.5), clip('b', 'snare', 0.5)], 8);
    assert.equal(plan.filter(Boolean).length, 2);
    assert.equal(plan[7], null);
  },
  function survivesAnEmptyOrJunkHarvest() {
    assert.deepEqual(planKitAssignment([], 8), Array(8).fill(null));
    assert.deepEqual(planKitAssignment(null, 8), Array(8).fill(null));
    const junk = planKitAssignment([{ id: 'x' }, null, { tag: 'kick' }], 8);
    assert.equal(junk.filter(Boolean).length, 1, 'a clip without an id cannot be placed');
  },
  function respectsTracksThatAlreadyHoldASound() {
    // Re-harvesting must not silently destroy a kit the user has built.
    const clips = [clip('k', 'kick', 0.9), clip('s', 'snare', 0.8)];
    const plan = planKitAssignment(clips, 8, [true, false, false, false, false, false, false, false]);
    assert.equal(plan[0], null, 'occupied track untouched');
    assert.equal(plan[1], 'k', 'best pick goes to the first free track');
    assert.equal(plan[2], 's');
  },
];

// ---------- kit levelling ----------
//
// Measured on the live site: a frog-chorus kit rendered at -23.7 dBFS peak.
// Field recordings sit low and uneven, so a harvested kit arrives too quiet to
// play against anything. track.gainDb cannot fix it — the compiler clamps it to
// +6 dB — so the seated slice itself is brought up, with a bounded boost so
// near-silence is not amplified into noise.

const dbToPeak = (db) => Math.pow(10, db / 20);
const peakToDb = (p) => 20 * Math.log10(p);

const kitLevelCases = [
  function liftsAQuietSliceTowardTheTarget() {
    const g = kitGainFor(dbToPeak(-30), { targetDb: -6, maxBoostDb: 18 });
    assert.ok(Math.abs(peakToDb(g) - 18) < 0.01, 'boost capped at 18 dB');
    assert.ok(Math.abs(peakToDb(dbToPeak(-30) * g) - -12) < 0.01, 'lands at -12, not -6');
  },
  function reachesTheTargetWhenTheBoostFits() {
    const g = kitGainFor(dbToPeak(-14), { targetDb: -6, maxBoostDb: 18 });
    assert.ok(Math.abs(peakToDb(dbToPeak(-14) * g) - -6) < 0.01);
  },
  function attenuatesAHotSliceWithoutLimit() {
    // Pulling a loud slice down cannot raise a noise floor, so it is uncapped:
    // eight tracks summing at full scale would clip the mix.
    const g = kitGainFor(dbToPeak(-1), { targetDb: -6, maxBoostDb: 18 });
    assert.ok(g < 1, 'attenuates');
    assert.ok(Math.abs(peakToDb(dbToPeak(-1) * g) - -6) < 0.01);
  },
  function leavesSilenceAlone() {
    // A digitally silent slice has no peak to normalise against; scaling it by
    // anything is still silence, and dividing by it would be a fault.
    assert.equal(kitGainFor(0), 1);
    assert.equal(kitGainFor(-1), 1, 'a negative peak is nonsense, not a signal');
    assert.equal(kitGainFor(NaN), 1);
  },
  function neverPushesASliceAboveTheTarget() {
    for (const db of [-60, -40, -24, -12, -6, -3, -0.5]) {
      const p = dbToPeak(db);
      const out = peakToDb(p * kitGainFor(p, { targetDb: -6, maxBoostDb: 18 }));
      assert.ok(out <= -6 + 0.01, db + ' dBFS stays at or below the target');
    }
  },
  function measuresPeakAcrossEveryChannel() {
    // A slice can be quiet on the left and loud on the right; normalising per
    // channel would shift the stereo image.
    const left = Float32Array.from([0.1, -0.1]);
    const right = Float32Array.from([0.8, -0.2]);
    assert.ok(Math.abs(peakOfChannels([left, right]) - 0.8) < 1e-6);
    assert.equal(peakOfChannels([]), 0);
    assert.equal(peakOfChannels(null), 0);
  },
];

// ---------- starter groove for a harvested kit ----------
//
// HARVEST seats eight tracks and reports READY TO PLAY, but the pattern is
// empty, so pressing RUN produces silence. Measured on the live site right
// after a harvest: stepsOn was 0. The factory grooves in kits.js are keyed to
// hand-authored lanes per factory kit; a harvested kit only knows its roles.

const grooveCases = [
  function putsTheKickOnBeatsOneAndThreeOfEveryBar() {
    const g = starterGrooveForRoles(['KICK']);
    assert.equal(g[0].length, 64, 'four bars of sixteenths');
    for (let bar = 0; bar < 4; bar++) {
      assert.equal(g[0][bar * 16 + 0], 1, 'bar ' + bar + ' beat 1');
      assert.equal(g[0][bar * 16 + 8], 1, 'bar ' + bar + ' beat 3');
      assert.equal(g[0][bar * 16 + 1], 0, 'nothing on the sixteenth after the downbeat');
    }
  },
  function putsTheSnareOnTheBackbeats() {
    const g = starterGrooveForRoles(['SNARE']);
    for (let bar = 0; bar < 4; bar++) {
      assert.equal(g[0][bar * 16 + 4], 1, 'beat 2');
      assert.equal(g[0][bar * 16 + 12], 1, 'beat 4');
      assert.equal(g[0][bar * 16 + 0], 0, 'not on the downbeat');
    }
  },
  function offsetsRepeatedRolesSoTheyInterlock() {
    // A frog harvest seats several TONE tracks. Identical lanes would just
    // stack them into one louder hit instead of making a pattern.
    const g = starterGrooveForRoles(['TONE', 'TONE', 'TONE']);
    assert.notDeepEqual(Array.from(g[0]), Array.from(g[1]), 'second tone differs');
    assert.notDeepEqual(Array.from(g[1]), Array.from(g[2]), 'third tone differs');
  },
  function givesAnEmptyLaneToAnUnknownRole() {
    const g = starterGrooveForRoles(['', null, 'NONSENSE']);
    for (const lane of g) assert.equal(Array.from(lane).some(Boolean), false);
  },
  function isDeterministic() {
    const roles = ['KICK', 'SNARE', 'BASS', 'TONE', 'VOX', 'FX', 'TONE', 'TONE'];
    assert.deepEqual(
      starterGrooveForRoles(roles).map((l) => Array.from(l)),
      starterGrooveForRoles(roles).map((l) => Array.from(l)),
    );
  },
  function makesRealNoiseForTheRolesAFrogHarvestActuallyYields() {
    // The exact kit the live run produced. If this groove is silent, READY TO
    // PLAY is still a lie.
    const g = starterGrooveForRoles(['KICK', 'SNARE', 'BASS', 'TONE', 'VOX', 'FX', 'TONE', 'TONE']);
    const total = g.reduce((n, lane) => n + Array.from(lane).filter(Boolean).length, 0);
    assert.ok(total >= 16, 'a groove worth hearing, got ' + total + ' hits');
    assert.ok(g.filter((lane) => Array.from(lane).some(Boolean)).length >= 4,
      'several tracks participate');
  },
];

// ---------- soundscape: biophony against anthrophony ----------
//
// NDSI (Kasten et al. 2012, Ecol. Inform. 12:50-67) as implemented by the R
// package `soundecology`: a Welch PSD binned into 1 kHz bands, anthrophony
// taken as 1-2 kHz and biophony as 2-11 kHz, then
//   NDSI = (biophony - anthrophony) / (biophony + anthrophony)
// bounded to [-1, +1]. Note the two reference implementations disagree on the
// biophony ceiling (`seewave` stops at 8 kHz); this follows soundecology.
//
// It measures THE RECORDING, not the ecosystem. The ecology literature has been
// withdrawing these indices' authority as biodiversity proxies since 2021, so
// the claim here is deliberately narrow: how the energy splits between the band
// engines occupy and the band birds occupy.

function toneAt(freq, rate, secs, amp = 0.7) {
  const n = Math.floor(rate * secs);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * freq * i / rate);
  return out;
}

function mixTones(freqs, rate, secs, amp = 0.5) {
  const n = Math.floor(rate * secs);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const f of freqs) v += amp * Math.sin(2 * Math.PI * f * i / rate);
    out[i] = v / freqs.length;
  }
  return out;
}

const soundscapeCases = [
  function aToneInTheEngineBandReadsAsAnthrophony() {
    const r = ndsi(toneAt(1500, 48000, 1.0), 48000);
    assert.ok(r.ndsi < -0.9, 'expected near -1, got ' + r.ndsi);
    assert.ok(r.anthrophony > r.biophony);
  },
  function aToneInTheBirdBandReadsAsBiophony() {
    const r = ndsi(toneAt(5000, 48000, 1.0), 48000);
    assert.ok(r.ndsi > 0.9, 'expected near +1, got ' + r.ndsi);
    assert.ok(r.biophony > r.anthrophony);
  },
  function anEvenSplitSitsNearZero() {
    const r = ndsi(mixTones([1500, 5000], 48000, 1.0), 48000);
    assert.ok(Math.abs(r.ndsi) < 0.35, 'expected near 0, got ' + r.ndsi);
  },
  function energyOutsideBothBandsIsIgnored() {
    // 200 Hz is below anthrophony and 16 kHz is above biophony. Neither should
    // move the index, or a rumbling truck would read as birdsong.
    const bare = ndsi(toneAt(5000, 48000, 1.0), 48000);
    const withOutOfBand = ndsi(mixTones([5000, 200, 16000], 48000, 1.0), 48000);
    assert.ok(Math.abs(bare.ndsi - withOutOfBand.ndsi) < 0.1,
      'out-of-band energy shifted the index: ' + bare.ndsi + ' vs ' + withOutOfBand.ndsi);
  },
  function silenceIsZeroRatherThanNaN() {
    const r = ndsi(new Float32Array(48000), 48000);
    assert.equal(Number.isFinite(r.ndsi), true);
    assert.equal(r.ndsi, 0);
    assert.equal(r.biophony, 0);
  },
  function refusesInputItCannotMeasure() {
    assert.equal(ndsi(null, 48000).ndsi, 0);
    assert.equal(ndsi(new Float32Array(4), 48000).ndsi, 0, 'shorter than one window');
    assert.equal(ndsi(toneAt(5000, 48000, 1.0), 0).ndsi, 0, 'no sample rate');
  },
  function staysWithinItsDefinedRange() {
    for (const f of [1100, 1900, 2100, 6000, 10500]) {
      const v = ndsi(toneAt(f, 48000, 0.5), 48000).ndsi;
      assert.ok(v >= -1 && v <= 1, f + ' Hz produced ' + v);
    }
  },
  function reportsWhenTheRateCannotCoverTheBiophonyBand() {
    // At 16 kHz the Nyquist limit is 8 kHz, so the 2-11 kHz band is clipped and
    // the number is not comparable with a 48 kHz reading. Say so rather than
    // returning a confident wrong answer.
    const ok = ndsi(toneAt(5000, 48000, 0.5), 48000);
    assert.equal(ok.bandLimited, false);
    const clipped = ndsi(toneAt(5000, 16000, 0.5), 16000);
    assert.equal(clipped.bandLimited, true, 'Nyquist below the biophony ceiling');
  },
];

const groups = [
  ['source registry', sourceRegistryCases],
  ['sample payload', samplePayloadCases],
  ['project store v3', projectStoreV3Cases],
  ['soundscape', soundscapeCases],
  ['starter groove', grooveCases],
  ['kit levelling', kitLevelCases],
  ['auto kit', autoKitCases],
  ['update safety', updateSafetyCases],
  ['wav export', wavExportCases],
  ['native rate', nativeRateCases],
  ['midi file import', smfCases],
  ['BS.1770', loudnessCases],
  ['beat tracking', beatCases],
  ['pattern compiler', patternCases],
  ['TRUTH 1 DSP', truthCases],
  ['LOCK compiler', lockCases],
  ['spectral repair', repairCases],
  ['persist roundtrip', persistCases],
  ['trust lifecycle', lifecycleCases],
  ['op1 patch', op1Cases],
  ['midi clock', midiCases],
  ['song compiler', songCases],
  ['harvest', harvestCases],
  ['pipeline', pipelineCases],
  ['synth', synthCases],
  ['factory drums', drumCases],
  ['modal', modalCases],
  ['offline render', renderCases],
  ['scene sends', sceneSendCases],
  ['restore hydration', hydrateCases],
  ['voice clamp parity', clampParityCases],
  ['worker protocol', workerProtocolCases],
  ['project bundle', bundleCases],
  ['instrument studio', studioCases],
  ['semantic MIDI loom', loomCases],
  ['semantic performance', performanceCases],
  ['constellation', constellationCases],
  ['crate index', crateCases],
  ['clip lifecycle', clipCases],
  ['undo history', undoCases],
  ['conform', conformCases],
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
