// The primitives every radio measurement starts from, pinned against signals
// whose answers are known by construction.
import assert from 'node:assert/strict';

import {
  analytic, analyticFft, instantaneousAmp, instantaneousFreq, guardFor,
  goertzel, goertzelBank, kaiser, kaiserBeta, firLowpass, firBandpass, filter,
  shiftHz, firHilbert, HILBERT_TAPS,
} from '../js/dsp/analytic.js';

const SR = 48000;

function tone(hz, seconds = 1, rate = SR, amp = 1, phase = 0) {
  const n = Math.round(seconds * rate);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.cos(2 * Math.PI * hz * i / rate + phase);
  return x;
}

const stats = (a) => {
  let lo = Infinity, hi = -Infinity, sum = 0;
  for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; sum += v; }
  return { lo, hi, mean: sum / a.length, spread: hi - lo };
};

const inner = (a, g) => a.slice(g, a.length - g);

export const NAME = 'analytic signal';

export const cases = [
  async function aToneReadsBackItsOwnFrequencyAndAmplitude() {
    // 300 Hz is the low end of the voice band a shortwave receiver hands over;
    // 3 kHz is the top. The default tap count is chosen to hold both.
    for (const hz of [300, 1000, 3000]) {
      const x = tone(hz, 1);
      const z = analytic(x);
      const f = stats(inner(instantaneousFreq(z.re, z.im, SR), z.guard));
      const a = stats(inner(instantaneousAmp(z.re, z.im), z.guard));
      assert.ok(Math.abs(f.mean - hz) < 0.001, `${hz} Hz reads ${f.mean.toFixed(4)}`);
      assert.ok(f.spread < 0.15, `${hz} Hz jitter ${f.spread.toExponential(2)}`);
      assert.ok(Math.abs(a.mean - 1) < 0.001 && a.spread < 0.005, `${hz} Hz envelope ${JSON.stringify(a)}`);
    }
  },

  async function tooFewTapsFailNearDcAndTheDefaultDoesNot() {
    // The usable band of a Hilbert FIR starts around 2·rate/taps. This is the
    // measurement behind HILBERT_TAPS = 511 rather than 255.
    const x = tone(300, 0.5);
    const short = analytic(x, { taps: 255 });
    const long = analytic(x, { taps: 511 });
    const sShort = stats(inner(instantaneousFreq(short.re, short.im, SR), short.guard));
    const sLong = stats(inner(instantaneousFreq(long.re, long.im, SR), long.guard));
    assert.ok(sShort.spread > 5, `255 taps should be visibly wrong at 300 Hz, got ${sShort.spread.toExponential(2)}`);
    assert.ok(sLong.spread < 0.2, `511 taps should hold 300 Hz, got ${sLong.spread.toExponential(2)}`);
    assert.equal(HILBERT_TAPS, 511);
  },

  async function instantaneousFrequencyFollowsAChirp() {
    const n = SR;
    const f0 = 500, f1 = 2500;
    const x = new Float64Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const f = f0 + (f1 - f0) * (i / n);
      x[i] = Math.cos(phase);
      phase += 2 * Math.PI * f / SR;
    }
    const z = analytic(x);
    const f = instantaneousFreq(z.re, z.im, SR);
    const g = z.guard;
    // The sweep is linear, so the reading at any sample is the sweep's own value
    // there. Check three points rather than the mean, which a symmetric error
    // would hide.
    for (const frac of [0.25, 0.5, 0.75]) {
      const i = Math.round(n * frac);
      const want = f0 + (f1 - f0) * (i / n);
      assert.ok(Math.abs(f[i] - want) < 2, `at ${frac}: ${f[i].toFixed(1)} want ${want.toFixed(1)}`);
    }
    assert.ok(g > 0 && g < n / 4);
  },

  async function theEnvelopeRecoversAmplitudeModulation() {
    // 60 % modulation at 5 Hz on a 1 kHz carrier: the envelope must swing
    // between 0.4 and 1.6 and nowhere else.
    const n = SR;
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const m = 1 + 0.6 * Math.cos(2 * Math.PI * 5 * i / SR);
      x[i] = m * Math.cos(2 * Math.PI * 1000 * i / SR);
    }
    const z = analytic(x);
    const a = stats(inner(instantaneousAmp(z.re, z.im), z.guard));
    assert.ok(Math.abs(a.hi - 1.6) < 0.02, `peak ${a.hi.toFixed(3)}`);
    assert.ok(Math.abs(a.lo - 0.4) < 0.02, `trough ${a.lo.toFixed(3)}`);
  },

  async function frequencyShiftKeyingSeparatesIntoItsTwoTones() {
    // 170 Hz shift around 1500 Hz at 45.45 baud — RTTY's own numbers. The
    // instantaneous frequency should sit on one tone or the other, and the
    // measured shift should come back.
    const mark = 1585, space = 1415, baud = 45.45;
    const n = SR;
    const x = new Float64Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const symbol = Math.floor(i * baud / SR);
      const f = symbol % 2 ? mark : space;
      x[i] = Math.cos(phase);
      phase += 2 * Math.PI * f / SR;
    }
    const z = analytic(x);
    const f = inner(instantaneousFreq(z.re, z.im, SR), z.guard);
    // Sample well inside each symbol so the transitions are not counted.
    const per = SR / baud;
    const marks = [], spaces = [];
    for (let s = 2; s < baud - 2; s++) {
      const i = Math.round((s + 0.5) * per) - z.guard;
      if (i > 0 && i < f.length) (s % 2 ? marks : spaces).push(f[i]);
    }
    const mean = (a) => a.reduce((p, c) => p + c, 0) / a.length;
    assert.ok(Math.abs(mean(marks) - mark) < 2, `mark ${mean(marks).toFixed(1)}`);
    assert.ok(Math.abs(mean(spaces) - space) < 2, `space ${mean(spaces).toFixed(1)}`);
    assert.ok(Math.abs((mean(marks) - mean(spaces)) - 170) < 4, 'the 170 Hz shift comes back');
  },

  async function goertzelReadsOneToneAndIgnoresTheRest() {
    const x = tone(1000, 0.5);
    // A unit tone splits between its two conjugate halves, so one of them is
    // 0.25 of the power: -6.02 dB, directly comparable with an FFT magnitude.
    assert.ok(Math.abs(10 * Math.log10(goertzel(x, SR, 1000)) + 6.02) < 0.05);
    assert.ok(10 * Math.log10(goertzel(x, SR, 3000)) < -100, 'off-tone is nowhere');
    const bank = goertzelBank(x, SR, [500, 1000, 1500]);
    assert.equal(bank.length, 3);
    assert.ok(bank[1] > bank[0] * 1e6 && bank[1] > bank[2] * 1e6);
  },

  async function goertzelSeesTheStrongerOfTwoTonesInABank() {
    // What a DTMF or 8-FSK detector actually does: several candidate tones, one
    // present. -20 dB of the other tone must not change which one wins.
    const n = 4800;
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = Math.cos(2 * Math.PI * 1209 * i / SR) + 0.1 * Math.cos(2 * Math.PI * 1336 * i / SR);
    }
    const bank = goertzelBank(x, SR, [1209, 1336, 1477, 1633]);
    const best = bank.indexOf(Math.max(...bank));
    assert.equal(best, 0);
    assert.ok(10 * Math.log10(bank[1] / bank[0]) < -19, 'and the quieter tone reads about 20 dB down');
  },

  async function theBandDesignsMeetTheirOwnStopband() {
    const lp = firLowpass(255, 0.1, 80);
    let dc = 0;
    for (const v of lp) dc += v;
    assert.ok(Math.abs(dc - 1) < 1e-6, 'unity at DC');

    const bp = firBandpass(255, 900 / SR, 1100 / SR, 80);
    const inBand = stats(inner(filter(tone(1000, 0.5), bp), 2000));
    assert.ok(Math.abs(inBand.hi - 1) < 0.01, `in-band peak ${inBand.hi.toFixed(4)}`);
    const out = stats(inner(filter(tone(3000, 0.5), bp), 2000));
    assert.ok(20 * Math.log10(out.hi) < -75, `out-of-band ${(20 * Math.log10(out.hi)).toFixed(1)} dB`);
  },

  async function kaiserBetaFollowsKaisersFit() {
    assert.ok(Math.abs(kaiserBeta(80) - 0.1102 * (80 - 8.7)) < 1e-9);
    assert.equal(kaiserBeta(10), 0, 'below 21 dB a rectangular window already does it');
    const w = kaiser(101, kaiserBeta(80));
    assert.ok(Math.abs(w[50] - 1) < 1e-12, 'peak of 1 at the centre');
    assert.ok(Math.abs(w[0] - w[100]) < 1e-12, 'symmetric');
    assert.ok(w[0] < 0.01);
  },

  async function shiftingMovesAToneByExactlyWhatWasAsked() {
    const z = analytic(tone(1000, 0.5));
    for (const by of [-400, 250]) {
      const s = shiftHz(z.re, z.im, SR, by);
      const f = stats(inner(instantaneousFreq(s.re, s.im, SR), z.guard));
      assert.ok(Math.abs(f.mean - (1000 + by)) < 0.01, `shift ${by} -> ${f.mean.toFixed(3)}`);
    }
  },

  async function theFrequencyDomainAnalyticIsKeptButIsHonestlyWorse() {
    // Both paths agree on the envelope; only the FFT one carries the segment's
    // wrap-around into the phase. This pins the reason `analytic` is the FIR.
    const x = tone(1000, 1);
    const fir = analytic(x);
    const fft = analyticFft(x);
    const g = fir.guard;
    const ampFir = stats(inner(instantaneousAmp(fir.re, fir.im), g));
    const ampFft = stats(inner(instantaneousAmp(fft.re, fft.im), 4800));
    assert.ok(Math.abs(ampFir.mean - ampFft.mean) < 0.01, 'the envelope agrees');
    const fFir = stats(inner(instantaneousFreq(fir.re, fir.im, SR), g));
    const fFft = stats(inner(instantaneousFreq(fft.re, fft.im, SR), 4800));
    assert.ok(fFft.spread > 10 * fFir.spread,
      `the FFT path should be visibly noisier in phase: ${fFft.spread.toExponential(2)} against ${fFir.spread.toExponential(2)}`);
  },

  async function theHilbertKernelIsWhatItClaimsToBe() {
    const h = firHilbert(511);
    assert.equal(h.length, 511);
    const m = 255;
    assert.equal(h[m], 0, 'the centre tap of a type III is zero');
    for (let k = 2; k < 100; k += 2) assert.equal(h[m + k], 0, 'and so is every even tap');
    assert.ok(Math.abs(h[m + 1] + h[m - 1]) < 1e-12, 'antisymmetric');
    assert.ok(h[m + 1] > 0 && h[m - 1] < 0, 'h[k] = 2/(pi k), so the tap after the centre is positive');
  },
];
