// Two stations on one channel, and the difference in when their marks arrive.
// Pinned against signals where the delay was put there on purpose.
import assert from 'node:assert/strict';

import { arrivalDifference, trend, toneEnvelope, boxcar, C_KM_MS, WWV_WWVH } from '../js/sigint/tdoa.js';

const RATE = 8000;
// A stand-in for the real pair, scaled down so a case runs in well under a
// second: the same tones and the same 200 Hz separation, shorter marks, shorter
// epochs. The estimator does not know the difference.
const PAIR = Object.freeze({
  name: 'TEST PAIR', burstSeconds: 0.3, epochSeconds: 2, baselineKm: 5430,
  a: { name: 'A', hz: 1000, place: 'first' },
  b: { name: 'B', hz: 1200, place: 'second' },
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function noise(n, sigma, seed) {
  const r = mulberry32(seed), out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const u = Math.max(1e-12, r()), v = r();
    out[i] = sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  return out;
}
function burst(x, atSec, hz, seconds, amp) {
  const from = Math.round(atSec * RATE), n = Math.round(seconds * RATE);
  for (let i = 0; i < n && from + i < x.length; i++) {
    // a few-millisecond raised edge, as a real keyed transmitter has
    const ramp = Math.min(1, Math.min(i, n - i) / (0.004 * RATE));
    x[from + i] += amp * ramp * Math.cos(2 * Math.PI * hz * i / RATE);
  }
}
/** `deltaAt(k)` gives the k-th epoch's injected difference, in milliseconds. */
function twoStations(epochs, deltaAt, { ampA = 1, ampB = 0.4, sigma = 0.02, seed = 7 } = {}) {
  const n = Math.round((epochs + 1) * PAIR.epochSeconds * RATE);
  const x = noise(n, sigma, seed);
  for (let k = 0; k < epochs; k++) {
    const t = 0.5 + k * PAIR.epochSeconds;
    burst(x, t, PAIR.a.hz, PAIR.burstSeconds, ampA);
    burst(x, t + deltaAt(k) / 1000, PAIR.b.hz, PAIR.burstSeconds, ampB);
  }
  return Float32Array.from(x);
}

export const NAME = 'sigint: arrival-time difference';

export const cases = [
  async function aKnownDelayComesBack() {
    for (const truth of [-9, 0, 4.5, 12]) {
      const x = twoStations(8, () => truth);
      const r = arrivalDifference(x, RATE, PAIR, { hopSeconds: 0.0005 });
      assert.equal(r.ok, true, `refused at ${truth} ms: ${r.reason}`);
      assert.ok(Math.abs(r.deltaMs - truth) < 1.0,
        `injected ${truth} ms, measured ${r.deltaMs.toFixed(2)} ms`);
      assert.ok(r.used >= 6, `used only ${r.used} epochs`);
      assert.equal(r.withinBound, true);
    }
  },

  async function aSteadyDelayIsCalledSteadyAndAMovingOneIsNot() {
    const steady = arrivalDifference(twoStations(10, () => 6), RATE, PAIR, { hopSeconds: 0.0005 });
    assert.equal(steady.stable, true, 'a constant delay must pass its own split-half test');
    assert.ok(!steady.driftSignificant, 'and must show no significant drift');

    // 1 ms per epoch: what a changing path does, and what an averaged single
    // number would hide.
    const moving = arrivalDifference(twoStations(10, (k) => 2 + k), RATE, PAIR, { hopSeconds: 0.0005 });
    assert.equal(moving.stable, false, 'a moving delay must fail its split-half test');
    assert.ok(moving.notes.some((n) => /moving/.test(n)), 'and must say so');
    assert.equal(moving.driftSignificant, true);
    assert.ok(Math.abs(moving.driftMsPerMinute - 30) < 10,
      `1 ms per 2 s epoch is 30 ms per minute; got ${moving.driftMsPerMinute.toFixed(1)}`);
    // The honest error widens to the spread when the halves disagree.
    assert.ok(moving.pathDifferenceErrorKm > moving.standardErrorMs * C_KM_MS,
      'an unstable measurement must not quote its standard error as the error');
  },

  async function noiseIsRefused() {
    // The whole point. Thirty seeds, no signal, no answer.
    let answered = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const x = Float32Array.from(noise(Math.round(9 * PAIR.epochSeconds * RATE), 0.05, seed));
      const r = arrivalDifference(x, RATE, PAIR, { hopSeconds: 0.001 });
      if (r.ok) answered++;
    }
    assert.equal(answered, 0, `answered on ${answered} of 30 noise-only inputs`);
  },

  async function oneStationAloneIsRefused() {
    const x = twoStations(8, () => 5, { ampB: 0 });
    const r = arrivalDifference(x, RATE, PAIR, { hopSeconds: 0.001 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /epochs carried both markers/);
    assert.ok(r.epochs.some((e) => !e.used && /no marker from B/.test(e.why)),
      'and must name the station that was missing');
  },

  async function markersTooCloseToTellApartAreRefusedBeforeAnythingIsMeasured() {
    const close = { ...PAIR, a: { name: 'A', hz: 1000 }, b: { name: 'B', hz: 1040 } };
    const r = arrivalDifference(twoStations(8, () => 5), RATE, close, { windowSeconds: 0.02 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /resolution widths/, 'the refusal must say why, in resolution widths');
    assert.deepEqual(r.epochs, [], 'and must refuse before spending the work');
  },

  async function aResultOutsideThePhysicalBoundIsNotAResult() {
    // 40 ms across a 5,430 km baseline is impossible: light does it in 18.1 ms.
    const x = twoStations(8, () => 40);
    const r = arrivalDifference(x, RATE, PAIR, { hopSeconds: 0.0005 });
    assert.equal(r.withinBound, false);
    assert.equal(r.ok, false, 'an impossible answer must not be reported as ok');
    assert.ok(r.notes.some((n) => /exceeds/.test(n) && /baseline/.test(n)));
  },

  async function theRealPairIsDescribedCorrectly() {
    assert.equal(WWV_WWVH.a.hz, 1000);
    assert.equal(WWV_WWVH.b.hz, 1200);
    assert.equal(WWV_WWVH.burstSeconds, 0.8);
    assert.equal(WWV_WWVH.epochSeconds, 60);
    // 5,430 km of baseline is 18.1 ms, and no path beats light.
    assert.ok(Math.abs(WWV_WWVH.baselineKm / C_KM_MS - 18.11) < 0.05);
  },

  async function theSupportingPiecesDoWhatTheySay() {
    const n = RATE;
    const x = new Float64Array(n);
    burst(x, 0.2, 1000, 0.3, 1);
    const e = toneEnvelope(Float32Array.from(x), RATE, 1000, { windowSeconds: 0.02, hopSeconds: 0.001 });
    assert.ok(Math.abs(e.fps - 1000) < 1e-9);
    const c = boxcar(e.env, e.fps, 0.3);
    let k = 0;
    for (let i = 1; i < c.length; i++) if (c[i] > c[k]) k = i;
    assert.ok(Math.abs(k / e.fps - 0.2) < 0.03, `matched filter peaked at ${(k / e.fps).toFixed(3)} s, not 0.200`);

    const t = trend([0, 1, 2, 3, 4], [1, 3, 5, 7, 9]);
    assert.ok(Math.abs(t.slope - 2) < 1e-9);
    assert.equal(t.significant, true);
    assert.equal(trend([0, 1], [1, 2]).slope, null, 'two points are not a trend');
  },
];
