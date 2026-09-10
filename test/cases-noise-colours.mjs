// The noise the refusal tests are made of. A generator that quietly turns white
// would make every "it refuses on noise" test in this repository pass for the
// wrong reason, so each one is checked against the property it exists to have.
import assert from 'node:assert/strict';

import { COLOURS, everyColour, describe, kurtosis, levelSwingDb, white, pink, faded, impulsive, bursty, mulberry32 } from './noise-colours.mjs';

const RATE = 8000;
const N = RATE * 6;

export const NAME = 'noise colours';

export const cases = [
  async function whiteIsFlatAndGaussianAndSteady() {
    const d = describe(white(N, { seed: 11 }), RATE);
    assert.ok(Math.abs(d.tiltDbPerDecade) < 3, `tilt ${d.tiltDbPerDecade.toFixed(1)} dB/decade`);
    assert.ok(Math.abs(d.kurtosis - 3) < 0.4, `kurtosis ${d.kurtosis.toFixed(2)}, a Gaussian is 3`);
    assert.ok(d.swingDb < 1.5, `swing ${d.swingDb.toFixed(1)} dB`);
  },

  async function pinkFallsAtRoughlyTenDbPerDecade() {
    const d = describe(pink(N, { seed: 11 }), RATE);
    // 1/f power is −10 dB/decade by definition; Voss-McCartney approximates it
    // with a staircase, so a few dB either side is the generator, not a fault.
    assert.ok(d.tiltDbPerDecade < -7 && d.tiltDbPerDecade > -14,
      `tilt ${d.tiltDbPerDecade.toFixed(1)} dB/decade, wanted about −10`);
    assert.ok(Math.abs(d.kurtosis - 3) < 0.5, 'still Gaussian in amplitude');
  },

  async function fadedActuallyFades() {
    // This is the case that caught a broken generator: normalising the envelope
    // by an analytic filter gain instead of its measured mean produced 0.3 dB
    // of "fading", which is to say white noise wearing the name.
    const d = describe(faded(N, { seed: 11, rate: RATE }), RATE);
    assert.ok(d.swingDb > 5, `swing ${d.swingDb.toFixed(1)} dB — a fade this shallow is not a fade`);
    assert.ok(d.kurtosis > 3.5, `kurtosis ${d.kurtosis.toFixed(1)} — an envelope makes the tails heavy`);
    const shallow = describe(faded(N, { seed: 11, rate: RATE, depth: 0.2 }), RATE);
    assert.ok(shallow.swingDb < d.swingDb, 'and depth controls how deep');
  },

  async function impulsiveIsAllTails() {
    const d = describe(impulsive(N, { seed: 11, rate: RATE }), RATE);
    assert.ok(d.kurtosis > 12, `kurtosis ${d.kurtosis.toFixed(1)} — crashes should be far from Gaussian`);
    assert.ok(d.swingDb > 4, `swing ${d.swingDb.toFixed(1)} dB`);
    const calm = describe(impulsive(N, { seed: 11, rate: RATE, perSecond: 1, gain: 6 }), RATE);
    assert.ok(calm.kurtosis < d.kurtosis, 'and the crash rate controls it');
  },

  async function burstyHasStructureInTimeAndNoneInFrequency() {
    const d = describe(bursty(N, { seed: 11, rate: RATE }), RATE);
    assert.ok(Math.abs(d.tiltDbPerDecade) < 3, `tilt ${d.tiltDbPerDecade.toFixed(1)} — gating is not colouring`);
    assert.ok(d.swingDb > 3, `swing ${d.swingDb.toFixed(1)} dB — the gate must be visible`);
    assert.ok(d.kurtosis > 4, 'and it shows in the amplitude distribution');
  },

  async function everyColourIsDistinctFromWhite() {
    // The whole point of the module: a sweep must not be five copies of one
    // thing. Each non-white colour differs from white on at least one axis.
    const w = describe(white(N, { seed: 21 }), RATE);
    for (const { name, x } of everyColour(N, 21, { rate: RATE })) {
      if (name === 'white') continue;
      const d = describe(x, RATE);
      const differs = Math.abs(d.tiltDbPerDecade - w.tiltDbPerDecade) > 4
        || Math.abs(d.kurtosis - w.kurtosis) > 1
        || Math.abs(d.swingDb - w.swingDb) > 2;
      assert.ok(differs, `${name} is indistinguishable from white: ${JSON.stringify(d)}`);
    }
  },

  async function theGeneratorsAreDeterministicAndSeedsMatter() {
    for (const [name, gen] of Object.entries(COLOURS)) {
      const a = gen(4096, { seed: 5, rate: RATE });
      const b = gen(4096, { seed: 5, rate: RATE });
      assert.deepEqual(Array.from(a.slice(0, 64)), Array.from(b.slice(0, 64)), name + ' repeats on its seed');
      const c = gen(4096, { seed: 6, rate: RATE });
      assert.notDeepEqual(Array.from(a.slice(0, 64)), Array.from(c.slice(0, 64)), name + ' changes with its seed');
      assert.ok(a.every(Number.isFinite), name + ' produces finite samples');
    }
  },

  async function theMeasuringSticksThemselvesAreRight() {
    const r = mulberry32(3);
    const g = new Float32Array(1 << 15);
    for (let i = 0; i < g.length; i++) {
      const u = Math.max(1e-12, r()), v = r();
      g[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
    assert.ok(Math.abs(kurtosis(g) - 3) < 0.3, 'kurtosis of a Gaussian is 3');
    const flat = new Float32Array(8000).fill(0.1);
    assert.ok(levelSwingDb(flat, RATE) < 0.01, 'a constant has no swing');
  },
];
