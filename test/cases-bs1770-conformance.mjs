// BS.1770 conformance, from a fixture written to be read by more than one
// implementation.
//
// Every other test group in this suite checks this code against itself: a value
// is computed once, eyeballed, and pinned. That catches drift and cannot catch
// a mistake that was there from the first run. One was — `truePeakLinear` maxed
// over the interpolated phases and never over the input samples, so it reported
// peaks below the sample peak for as long as it existed, behind a test whose
// fixture happened to put the samples 3 dB off the crest.
//
// It was found by reading Nyquist's independent Swift implementation of the
// same annex (~/Developer/nyquist, TruePeak.swift), whose design note states
// the rule this file was missing. This group exists so that comparison is
// permanent rather than a thing someone once did.
//
// The rule for a case in test/fixtures/bs1770-conformance.json: the expected
// value must be derivable from the signal by hand. Anything whose answer is
// "whatever this code printed" belongs in a golden file, not here.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { kWeightingCoeffs, measureLoudness } from '../js/dsp/loudness.js';
import { truePeakDb } from '../js/dsp/truepeak.js';

const FIXTURE = JSON.parse(await readFile(
  new URL('./fixtures/bs1770-conformance.json', import.meta.url),
  'utf8',
));

const byId = (id) => {
  const c = FIXTURE.cases.find((x) => x.id === id);
  if (!c) throw new Error(`fixture case ${id} is missing`);
  return c;
};

/** Build a signal exactly as `signalSpec` in the fixture describes it. */
export function synthesize(spec) {
  const n = Math.round(spec.sampleRate * spec.seconds);
  const chans = [];
  for (let c = 0; c < (spec.channels || 1); c++) {
    const amp = spec.channelAmplitudes ? spec.channelAmplitudes[c] : (spec.amplitude ?? 1);
    const x = new Float32Array(n);
    if (spec.type === 'sine') {
      for (let i = 0; i < n; i++) {
        x[i] = amp * Math.sin(2 * Math.PI * spec.frequencyHz * i / spec.sampleRate + (spec.phaseRad || 0));
      }
    } else if (spec.type !== 'silence') {
      throw new Error(`unknown signal type ${spec.type}`);
    }
    if (spec.fadeSeconds) {
      const f = Math.round(spec.sampleRate * spec.fadeSeconds);
      for (let i = 0; i < f && i < n; i++) { const w = i / f; x[i] *= w; x[n - 1 - i] *= w; }
    }
    chans.push(x);
  }
  return { channels: chans, sampleRate: spec.sampleRate };
}

// The fixture's `coefficients` cases name the two biquads by role; this module
// returns them as flat arrays with a0 normalised to 1.
const asRoles = (c) => ({
  shelf: { b0: c.b1[0], b1: c.b1[1], b2: c.b1[2], a1: c.a1[1], a2: c.a1[2] },
  highPass: { b0: c.b2[0], b1: c.b2[1], b2: c.b2[2], a1: c.a2[1], a2: c.a2[2] },
});

const near = (actual, expected, tol, what) => assert.ok(
  Math.abs(actual - expected) <= tol,
  `${what}: ${actual} is not within ${tol} of ${expected}`,
);

export const NAME = 'BS.1770 conformance';

export const cases = [
  function theFixtureSaysWhyEveryValueIsKnown() {
    // The property that makes this file worth having. A case without a `why`
    // is a golden wearing a conformance case's clothes.
    assert.ok(FIXTURE.cases.length >= 8, 'the fixture should carry the whole set');
    for (const c of FIXTURE.cases) {
      assert.ok(typeof c.why === 'string' && c.why.length > 40,
        `case ${c.id} does not say why its expected value is known`);
      assert.ok(typeof c.what === 'string' && c.what.length > 5, `case ${c.id} has no description`);
    }
  },

  function kWeightingMatchesThePublishedTableAt48k() {
    const c = byId('kweighting-48k');
    const got = asRoles(kWeightingCoeffs(c.sampleRate));
    for (const role of ['shelf', 'highPass']) {
      for (const k of Object.keys(c.expect[role])) {
        near(got[role][k], c.expect[role][k], c.tolerance, `${c.id} ${role}.${k}`);
      }
    }
  },

  function kWeightingIsRedesignedAtOtherRates() {
    const c = byId('kweighting-44k1');
    const got = asRoles(kWeightingCoeffs(c.sampleRate));
    for (const role of ['shelf', 'highPass']) {
      for (const k of Object.keys(c.expect[role])) {
        near(got[role][k], c.expect[role][k], c.tolerance, `${c.id} ${role}.${k}`);
      }
    }
    // The failure this guards against is hardcoding the published table, which
    // shows up as 44.1 kHz returning the 48 kHz numbers.
    const at48 = asRoles(kWeightingCoeffs(48000));
    assert.ok(Math.abs(got.shelf.b0 - at48.shelf.b0) > 1e-4,
      'the 44.1 kHz shelf is identical to the 48 kHz one, so the filter was not redesigned');
  },

  function theCalibrationToneReadsWhatTheStandardSays() {
    for (const id of ['calibration-997-mono', 'calibration-997-stereo',
      'calibration-997-44k1', 'calibration-997-96k']) {
      const c = byId(id);
      const m = measureLoudness(synthesize(c.signal));
      near(m.integrated, c.expect.integratedLufs, c.tolerance.integratedLufs, `${id} integrated`);
      if (c.expect.samplePeakDb !== undefined) {
        near(m.samplePeakDb, c.expect.samplePeakDb, c.tolerance.samplePeakDb, `${id} sample peak`);
      }
    }
  },

  function silenceHasNoLoudnessToReport() {
    const c = byId('gate-silence');
    const m = measureLoudness(synthesize(c.signal));
    assert.ok(m.integrated === null || m.integrated === -Infinity || Number.isNaN(m.integrated),
      `silence reported an integrated loudness of ${m.integrated}`);
  },

  function aTruePeakIsNeverBelowTheSamplePeak() {
    // The case that was missing. Each divisor divides the rate exactly and the
    // phase puts sample 0 on the crest, so the analytic peak IS the amplitude
    // and any under-read is visible.
    const c = byId('truepeak-sample-on-crest');
    let worst = Infinity, where = '';
    for (const rate of c.sampleRates) {
      for (const den of c.rateDivisors) {
        const { channels } = synthesize({
          type: 'sine', sampleRate: rate, seconds: c.seconds,
          frequencyHz: rate / den, amplitude: c.amplitude, phaseRad: c.phaseRad, channels: 1,
        });
        const tp = truePeakDb(channels);
        if (tp < worst) { worst = tp; where = `${rate} Hz at rate/${den}`; }
      }
    }
    assert.ok(worst >= c.expect.atLeastDb - c.tolerance.atLeastDb,
      `${where}: true peak ${worst.toFixed(4)} dB is under the sample peak `
      + `${c.expect.atLeastDb.toFixed(4)} dB, which the waveform never goes below`);
  },

  function theIntersamplePeakIsFoundBetweenTheSamples() {
    const c = byId('truepeak-intersample-quarter-rate');
    const { channels } = synthesize(c.signal);
    const m = measureLoudness({ channels, sampleRate: c.signal.sampleRate });
    near(m.truePeakDb, c.expect.truePeakDb, c.tolerance.truePeakDb, `${c.id} true peak`);
    near(m.samplePeakDb, c.expect.samplePeakDb, c.tolerance.samplePeakDb, `${c.id} sample peak`);
    assert.ok(m.truePeakDb > m.samplePeakDb + 2.5,
      'a sample-peak meter would pass the line above; this one has to find the peak between them');
  },

  function theFourTimesUnderReadStaysInsideItsBudget() {
    // A bound, not a conformance value: 4x oversampling cannot resolve the top
    // of the band and every compliant meter under-reads there. What is pinned
    // is that it does not get worse.
    const c = byId('truepeak-4x-under-read-budget');
    const truth = 20 * Math.log10(c.amplitude);
    let worst = 0, where = '';
    for (const [num, den] of c.ratios) {
      for (let k = 0; k < c.phaseCount; k++) {
        const { channels } = synthesize({
          type: 'sine', sampleRate: c.sampleRate, seconds: c.seconds,
          frequencyHz: c.sampleRate * num / den, amplitude: c.amplitude,
          phaseRad: 2 * Math.PI * k / c.phaseCount, channels: 1,
        });
        const err = truePeakDb(channels) - truth;
        if (err < worst) { worst = err; where = `${(num / den).toFixed(2)} of the rate, phase ${k}/${c.phaseCount}`; }
      }
    }
    assert.ok(-worst <= c.expect.worstUnderReadDb,
      `worst under-read ${(-worst).toFixed(3)} dB at ${where}, over a budget of ${c.expect.worstUnderReadDb} dB`);
  },
];
