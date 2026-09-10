import assert from 'node:assert/strict';
import {
  measure, spectrogram, binStats, symbolRate, fskShift,
  FLOOR_PERCENTILE, FLOOR_SYSTEMATIC_DB, PARABOLIC_BIAS_BINS, SYMBOL_MIN_RATIO,
  FSK_TRANSITION_FRACTION, FSK_MAX_MODE_WIDTH,
  floorDebias,
} from '../js/sigint/measure.js';
import { firBandpass, filter } from '../js/dsp/analytic.js';
import {
  designate, formatBandwidth, roundedValueOf, K_FADING, K_NON_FADING,
} from '../js/sigint/designator.js';
import { analyseCyclic } from '../js/analysis/cyclic.js';

export const NAME = 'sigint measurement and emission designator';

const RATE = 8000;

// ---------------------------------------------------------------------------
// Signals whose answer is known because they were built that way. Everything
// asserted below is checked against the construction, not against a previous
// run of this code.
// ---------------------------------------------------------------------------

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(n, sigma, seed) {
  const r = rng(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const u = Math.max(1e-12, r()), v = r();
    const m = Math.sqrt(-2 * Math.log(u));
    out[i] = sigma * m * Math.cos(2 * Math.PI * v);
    if (i + 1 < n) out[i + 1] = sigma * m * Math.sin(2 * Math.PI * v);
  }
  return out;
}

function add(a, b) {
  const out = new Float32Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = (a[i] || 0) + (b[i] || 0);
  return out;
}

function tone(sec, hz, amp = 0.5, driftHzPerSec = 0) {
  const n = Math.round(RATE * sec);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += 2 * Math.PI * (hz + driftHzPerSec * (i / RATE)) / RATE;
    out[i] = amp * Math.sin(ph);
  }
  return out;
}

function randomBits(n, seed) {
  const r = rng(seed);
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = r() < 0.5 ? 0 : 1;
  return b;
}

/** Continuous-phase FSK: mark on a 1 bit, space on a 0. */
function fsk(bits, baud, markHz, spaceHz, amp = 0.4) {
  const spb = RATE / baud;
  const n = Math.ceil(bits.length * spb);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += 2 * Math.PI * (bits[Math.min(bits.length - 1, Math.floor(i / spb))] ? markHz : spaceHz) / RATE;
    out[i] = amp * Math.sin(ph);
  }
  return out;
}

/** An AM carrier with one modulating tone. */
function amCarrier(sec, carrierHz, modHz, depth, amp = 0.5) {
  const n = Math.round(RATE * sec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amp * (1 + depth * Math.sin(2 * Math.PI * modHz * i / RATE))
      * Math.sin(2 * Math.PI * carrierHz * i / RATE);
  }
  return out;
}

const MORSE = {
  A: '.-', C: '-.-.', D: '-..', E: '.', I: '..', K: '-.-', M: '--', N: '-.', O: '---',
  Q: '--.-', P: '.--.', R: '.-.', S: '...', T: '-', 0: '-----', 1: '.----', 2: '..---',
  3: '...--', 4: '....-', 5: '.....', 8: '---..',
};

/** Morse at a stated speed. One dot = 1.2/wpm seconds under the PARIS standard. */
function morse(text, wpm, hz, amp = 0.5) {
  const dot = 1.2 / wpm;
  const units = [];
  const up = text.toUpperCase();
  for (let i = 0; i < up.length; i++) {
    if (up[i] === ' ') { units.push([0, 4]); continue; }
    const code = MORSE[up[i]];
    if (!code) continue;
    for (let j = 0; j < code.length; j++) {
      units.push([1, code[j] === '.' ? 1 : 3]);
      if (j < code.length - 1) units.push([0, 1]);
    }
    if (i < up.length - 1 && up[i + 1] !== ' ') units.push([0, 3]);
  }
  let total = 0;
  for (const [, u] of units) total += u;
  const n = Math.ceil(total * dot * RATE) + 1;
  const out = new Float32Array(n);
  const edge = Math.max(1, Math.round(0.005 * RATE));    // a keyer's rise time
  let at = 0;
  for (const [on, u] of units) {
    const len = Math.round(u * dot * RATE);
    for (let i = 0; i < len && at + i < n; i++) {
      let env = on ? 1 : 0;
      if (on && i < edge) env = 0.5 * (1 - Math.cos(Math.PI * i / edge));
      else if (on && i > len - edge) env = 0.5 * (1 - Math.cos(Math.PI * (len - i) / edge));
      out[at + i] = amp * env * Math.sin(2 * Math.PI * hz * (at + i) / RATE);
    }
    at += len;
  }
  return out;
}

/** On-off keyed carrier at a stated baud: the simplest thing with a clock. */
function ook(sec, hz, baud, amp, seed) {
  const n = Math.round(RATE * sec);
  const out = new Float32Array(n);
  const spb = RATE / baud;
  const bits = randomBits(Math.ceil(n / spb) + 1, seed);
  for (let i = 0; i < n; i++) {
    out[i] = (bits[Math.floor(i / spb)] ? amp : 0) * Math.sin(2 * Math.PI * hz * i / RATE);
  }
  return out;
}

/**
 * A wideband emission: band-limited noise, on-off keyed. What a spread or
 * noise-like data emission looks like, and the shape that defeats a
 * single-bin detection — no one bin of it stands above a floor estimated
 * inside its own bandwidth.
 */
function widebandKeyed(sec, loHz, hiHz, baud, amp, seed) {
  const n = Math.round(RATE * sec);
  const bp = filter(gauss(n, 1, seed), firBandpass(255, loHz / RATE, hiHz / RATE, 70));
  const spb = RATE / baud;
  const bits = randomBits(Math.ceil(n / spb) + 1, seed + 5);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * bp[i] * (bits[Math.floor(i / spb)] ? 1 : 0);
  return out;
}

/**
 * One emission carrying two unrelated clocks: keyed at , and separately
 * chopped at  down to . An interrupted or badly faded link.
 */
function chopped(sec, baud, gate, shift, depth, seed) {
  const x = fsk(randomBits(Math.ceil(baud * sec) + 4, seed), baud,
    1500 + shift / 2, 1500 - shift / 2, 0.5);
  const spb = RATE / gate;
  const bits = randomBits(Math.ceil(x.length / spb) + 1, seed + 3);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * (bits[Math.floor(i / spb)] ? 1 : depth);
  return out;
}

/** A short transmission in a long silence: a burst station, or a fragment. */
function burst(sec, onSec, hz, amp, sigma, seed) {
  const n = Math.round(RATE * sec);
  const out = gauss(n, sigma, seed);
  const on = Math.round(onSec * RATE);
  for (let i = 0; i < on && i < n; i++) out[i] += amp * Math.sin(2 * Math.PI * hz * i / RATE);
  return out;
}

/**
 * A 1/f floor, which is what an empty HF band actually sounds like. White
 * noise is the easy case for a detector; coloured noise is the one that
 * produces false positives, so the refusal tests use both.
 */
function pinkNoise(n, sigma, seed) {
  const r = rng(seed);
  let b0 = 0, b1 = 0, b2 = 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.0990460;
    b1 = 0.96300 * b1 + w * 0.2965164;
    b2 = 0.57000 * b2 + w * 1.0526913;
    out[i] = sigma * (b0 + b1 + b2 + w * 0.1848) * 0.2;
  }
  return out;
}

const near = (got, want, tol, what) => assert.ok(
  Math.abs(got - want) <= tol,
  what + ': got ' + got + ', wanted ' + want + ' +/- ' + tol,
);

export const cases = [
  // --- the noise floor -----------------------------------------------------

  async function floorIsUnbiasedOnNoise() {
    // White noise of variance s^2 has a one-sided power density of 2*s^2/rate.
    // Referenced to a full-scale sine (mean power 0.5) that is a number the
    // test knows without running the estimator.
    const sigma = 0.01;
    const want = 10 * Math.log10((2 * sigma * sigma / RATE) / 0.5);
    const errs = [];
    for (let s = 0; s < 6; s++) {
      const m = measure(gauss(RATE * 3, sigma, 500 + s), RATE, {});
      errs.push(m.noiseFloor.value - want);
      assert.equal(m.noiseFloor.unit, 'dBFS/Hz');
      assert.ok(m.noiseFloor.uncertainty > 0);
    }
    const bias = errs.reduce((a, b) => a + b, 0) / errs.length;
    near(bias, 0, FLOOR_SYSTEMATIC_DB + 0.05, 'noise floor bias over 6 realisations');
    // And the debias factor is the exponential quantile-to-mean relation, not
    // a fitted constant.
    near(floorDebias(FLOOR_PERCENTILE), -Math.log(1 - 0.2), 1e-12, 'exponential debias');
    // The systematic of taking a minimum of two estimators is carried, not
    // corrected: whatever the residual bias is, the stated uncertainty covers it.
    const m0 = measure(gauss(RATE * 3, sigma, 500), RATE, {});
    assert.ok(m0.noiseFloor.uncertainty >= FLOOR_SYSTEMATIC_DB,
      'the floor uncertainty must include the ' + FLOOR_SYSTEMATIC_DB + ' dB systematic');
    assert.ok(Math.abs(bias) <= m0.noiseFloor.uncertainty * 1.2,
      'measured bias ' + bias.toFixed(3) + ' dB exceeds the uncertainty claimed for it');
  },

  async function floorSeesUnderneathAContinuousCarrier() {
    // The regression that matters: a percentile over TIME cannot exclude a
    // carrier that is present in every frame. Before the spectral half of the
    // floor existed, this signal reported a peak 2.3 dB above its own "floor".
    const sigma = 0.01;
    const x = add(tone(3, 1000, 0.5), gauss(RATE * 3, sigma, 21));
    const m = measure(x, RATE, {});
    assert.ok(m.bandwidth.peakBinSnrDb > 45,
      'a 0.5-amplitude carrier in sigma=0.01 noise must stand far above its floor, got '
      + m.bandwidth.peakBinSnrDb.toFixed(1) + ' dB');
    const want = 10 * Math.log10((2 * sigma * sigma / RATE) / 0.5);
    near(m.noiseFloor.value, want, 0.6, 'floor under a continuous carrier');

    // The temporal half on its own is the thing that fails; check that it does,
    // so this test still means something if the two halves are ever separated.
    const spec = spectrogram(x, RATE, {});
    const stats = binStats(spec, {});
    const peak = m.bandwidth.peakBinSnrDb;
    const k = Math.round(m.centre.value / spec.binHz);
    const temporalOnly = 10 * Math.log10(
      Math.max(stats.mean[k] - stats.floorTemporal[k], 1e-300) / stats.floorTemporal[k],
    );
    assert.ok(temporalOnly < peak - 30,
      'the temporal-percentile floor alone should be swallowed by the carrier: it gave '
      + temporalOnly.toFixed(1) + ' dB against the combined floor\'s ' + peak.toFixed(1));
  },

  async function snrMatchesItsOwnDefinition() {
    // Parseval fixes the answer: for a Hann-windowed frame the one-sided energy
    // of a tone of amplitude A is N*A^2*W2/4 and each noise bin holds s^2*W2,
    // so the ratio over nb bins is N*A^2/(4*nb*s^2), with no free constant.
    const A = 0.5, sigma = 0.01;
    const m = measure(add(tone(3, 1000, A), gauss(RATE * 3, sigma, 33)), RATE, {});
    const nb = Math.round(m.snr.independentBins * m.analysis.enbwHz / m.analysis.binHz);
    const want = 10 * Math.log10(m.analysis.fftSize * A * A / (4 * nb * sigma * sigma));
    near(m.snr.value, want, 1.0, 'SNR against its Parseval expectation');
    assert.equal(m.snr.unit, 'dB');
    assert.ok(m.snr.uncertainty > 0 && m.snr.uncertainty < 1);
  },

  async function detectionRefusesToCallNoiseASignal() {
    const noise = measure(gauss(RATE * 3, 0.01, 44), RATE, {});
    assert.equal(noise.detection.present, false);
    assert.match(noise.detection.reason, /there is nothing here/);
    const sig = measure(add(tone(3, 1200, 0.2), gauss(RATE * 3, 0.01, 45)), RATE, {});
    assert.equal(sig.detection.present, true);
  },

  // --- centre, offset, drift ----------------------------------------------

  async function centreFrequencyIsExactOffBin() {
    // 1000.5 Hz at 7.8125 Hz bins sits 0.064 of a bin from a centre, which is
    // where an uninterpolated peak is worst.
    const m = measure(add(tone(3, 1000.5, 0.5), gauss(RATE * 3, 0.005, 55)), RATE, { expectedHz: 1000 });
    near(m.centre.value, 1000.5, 0.2, 'interpolated centre');
    assert.ok(m.centre.uncertainty > 0);
    near(m.carrierOffset.value, 0.5, 0.2, 'carrier offset from a declared 1000 Hz');
    assert.equal(m.carrierOffset.expectedHz, 1000);
  },

  async function carrierOffsetIsNullWithoutADeclaredFrequency() {
    const m = measure(add(tone(3, 1000, 0.5), gauss(RATE * 3, 0.005, 56)), RATE, {});
    assert.equal(m.carrierOffset.value, null);
    assert.match(m.carrierOffset.reason, /no expected frequency was declared/);
  },

  async function parabolicInterpolationIsWithinItsStatedBias() {
    // The claim in the module is 0.016 bins worst case over a swept sub-bin
    // offset. Sweep it and hold the code to that number.
    let worst = 0;
    for (let i = 0; i < 8; i++) {
      const hz = 1000 + i * (RATE / 1024) / 8;
      const m = measure(add(tone(2, hz, 0.5), gauss(RATE * 2, 0.0005, 60 + i)), RATE, { fftSize: 1024 });
      worst = Math.max(worst, Math.abs(m.centre.value - hz) / m.analysis.binHz);
    }
    assert.ok(worst <= PARABOLIC_BIAS_BINS * 1.5,
      'swept interpolation error ' + worst.toFixed(4) + ' bins exceeds the stated '
      + PARABOLIC_BIAS_BINS);
  },

  async function driftRecoversAKnownSlope() {
    const m = measure(add(tone(4, 1234.5, 0.5, 3), gauss(RATE * 4, 0.008, 70)), RATE, {});
    assert.equal(m.drift.unit, 'Hz/s');
    near(m.drift.value, 3, Math.max(0.15, 3 * m.drift.uncertainty), 'drift slope');
    assert.ok(m.drift.r2 > 0.99, 'a linear drift should fit, r2 = ' + m.drift.r2);
    assert.ok(m.driftFrames.used > m.driftFrames.total * 0.9);

    const flat = measure(add(tone(4, 1234.5, 0.5), gauss(RATE * 4, 0.008, 71)), RATE, {});
    assert.ok(Math.abs(flat.drift.value) < 3 * flat.drift.uncertainty + 0.05,
      'a stationary carrier should not drift: ' + flat.drift.value + ' +/- ' + flat.drift.uncertainty);
  },

  async function driftRefusesWhenTheSignalIsAbsent() {
    const m = measure(gauss(RATE * 3, 0.01, 72), RATE, { lowHz: 3000, highHz: 3900 });
    if (m.drift.value === null) assert.match(m.drift.reason, /frames carry a peak/);
    else assert.ok(m.drift.uncertainty > Math.abs(m.drift.value) / 3,
      'a slope fitted to noise must carry an uncertainty that admits it');
  },

  // --- bandwidth -----------------------------------------------------------

  async function occupied99CollapsesOnACarrierDominantSignal() {
    // A 1500 Hz carrier with 14% modulation at 1200 Hz. The sidebands are at
    // -23 dB, comfortably inside a -26 dB window, but they hold only 0.98% of
    // the power — under the 1% the 99% definition throws away. So the x-dB
    // answer spans the sidebands and the 99% answer collapses onto the carrier.
    const m = measure(add(amCarrier(4, 1500, 1200, 0.14), gauss(RATE * 4, 0.0015, 80)), RATE, {});
    assert.ok(m.bandwidth.carrierFraction > 0.95,
      'carrier fraction ' + m.bandwidth.carrierFraction);
    near(m.bandwidth.xdb.value, 2400, 120, 'x-dB width spans both sidebands');
    assert.ok(m.bandwidth.occupied99.value < 200,
      'the 99% figure should have collapsed onto the carrier, got '
      + m.bandwidth.occupied99.value);
    assert.equal(m.bandwidth.trustworthy, 'xdb');
    assert.match(m.bandwidth.reason, /carrier-dominant/);
    assert.equal(m.bandwidth.xdb.splitEmission, true);
  },

  async function xdbSpansBothTonesOfAnFskEmission() {
    // Walking outward from the peak and stopping at the first crossing lands in
    // the valley between mark and space and reports a quarter of the truth. The
    // outermost crossing is the ITU definition and the right answer.
    const m = measure(add(fsk(randomBits(220, 3), 45.45, 1445, 1275), gauss(RATE * 5, 0.006, 90)), RATE, {});
    assert.ok(m.bandwidth.xdb.value > 200,
      'x-dB width must span the 170 Hz shift plus skirts, got ' + m.bandwidth.xdb.value);
    assert.ok(m.bandwidth.xdb.highHz - m.bandwidth.xdb.contiguousHighHz >= 0);
    near(m.bandwidth.occupied99.value, 250, 80, '99% width of a 45.45 Bd / 170 Hz teleprinter');
  },

  async function xdbAdmitsWhenTheSnrCannotSupportIt() {
    const m = measure(add(tone(4, 1500, 0.004), gauss(RATE * 4, 0.02, 100)), RATE, {});
    assert.equal(m.bandwidth.xdb.limitedByNoise, true);
    assert.ok(m.bandwidth.xdb.dbDown < 26,
      'the -26 dB point is below the noise; dbDown should have been reduced');
    assert.notEqual(m.bandwidth.trustworthy, 'xdb',
      'an x-dB width measured at a reduced dbDown is a lower bound, not the primary answer');
    assert.match(m.bandwidth.reason, /dB above its (own )?noise floor/);
    // carrierFraction is a fraction or it is null; on a band that is mostly
    // noise the denominator is a sum of zero-mean residuals and the ratio used
    // to come back as 10.9.
    assert.ok(m.bandwidth.carrierFraction == null
      || (m.bandwidth.carrierFraction >= 0 && m.bandwidth.carrierFraction <= 1),
      'carrierFraction was ' + m.bandwidth.carrierFraction);
  },

  async function occupied99TailsRandomWalkAndSayHowFar() {
    // The brief's specific worry: the cumulative tails integrate a zero-mean
    // noise residual, so each crossing wanders. On a weak wideband FSK the
    // interleaved folds disagree by more than the answer itself.
    const m = measure(add(fsk(randomBits(420, 3), 100, 1700, 1300, 0.03), gauss(RATE * 4.3, 0.02, 110)), RATE, {});
    const o = m.bandwidth.occupied99;
    assert.equal(o.foldWidths.length, 4);
    assert.ok(o.walkFraction > 0.05,
      'a weak wideband signal must show the tails wandering; walkFraction = ' + o.walkFraction);
    assert.ok(o.uncertainty > 0);
    const spread = Math.max(...o.foldWidths) - Math.min(...o.foldWidths);
    assert.ok(spread > 0.3 * o.value,
      'the folds should disagree substantially here, spread ' + spread.toFixed(0)
      + ' on a width of ' + o.value.toFixed(0));
  },

  // --- symbol rate ---------------------------------------------------------

  async function symbolRateFindsATeleprinterRate() {
    const m = measure(add(fsk(randomBits(300, 7), 45.45, 1600, 1200), gauss(RATE * 6.7, 0.006, 120)), RATE, {});
    assert.equal(m.symbolRate.unit, 'Bd');
    near(m.symbolRate.value, 45.45, Math.max(0.1, 3 * m.symbolRate.uncertainty), 'RTTY baud');
    assert.ok(m.symbolRate.confidence.ratio >= SYMBOL_MIN_RATIO);
    assert.ok(m.symbolRate.confidence.harmonicsFound >= 1);
    assert.equal(m.symbolRate.confidence.analogueToneIndistinguishable, false);
  },

  async function symbolRateFindsAMorseDotRate() {
    // 20 words per minute is 0.8333*20 = 16.667 dots per second by construction.
    const sig = morse('CQ CQ DE M08 M08 K 12345 CQ DE M08', 20, 800);
    const m = measure(add(sig, gauss(sig.length, 0.005, 130)), RATE, {});
    near(m.symbolRate.value, 16.6667, Math.max(0.1, 3 * m.symbolRate.uncertainty), 'Morse dot rate');
    assert.ok(m.symbolRate.confidence.harmonicsFound >= 1,
      'square keying rings at 2x and 3x; that is what tells it from a tone');
  },

  async function symbolRateRecoversTheFundamentalNotAHarmonic() {
    // Measured before the comb resolver went in: a 22.5 Bd stream peaked at
    // 45.0 (2x) and an 11.3 Bd one at 90.4 (8x). Reporting the peak reports the
    // wrong rate.
    for (const baud of [11.3, 22.5]) {
      const secs = 200 / baud;
      const x = add(fsk(randomBits(Math.round(baud * secs), 9), baud, 1700, 1300),
        gauss(RATE * (secs + 0.5), 0.005, 140));
      const m = measure(x, RATE, {});
      near(m.symbolRate.value, baud, Math.max(0.1, 3 * m.symbolRate.uncertainty),
        baud + ' Bd fundamental');
    }
  },

  async function symbolRateRefusesOnNoise() {
    // The bar of SYMBOL_MIN_RATIO is calibrated here rather than asserted:
    // this records what noise actually reaches.
    let worst = 0;
    for (let s = 0; s < 10; s++) {
      const m = measure(gauss(RATE * 3, 0.01, 200 + s), RATE, { lowHz: 500, highHz: 3500 });
      assert.equal(m.symbolRate.value, null, 'noise produced a symbol rate on seed ' + s);
      const chans = m.symbolRate.channels || [];
      for (const c of chans) worst = Math.max(worst, c.ratio);
    }
    assert.ok(worst < SYMBOL_MIN_RATIO,
      'the three-channel maximum on noise reached ' + worst.toFixed(2)
      + ', at or above the bar of ' + SYMBOL_MIN_RATIO + ' — recalibrate it');
  },

  async function symbolRateRefusesOnAPureCarrier() {
    // Not a threshold, a physical impossibility: keying at R baud needs about
    // R/2 hertz of bandwidth either side, so an 18 Hz-wide emission cannot be
    // carrying tens of bauds however tall the line looks.
    const m = measure(add(tone(3, 1000, 0.5), gauss(RATE * 3, 0.01, 210)), RATE, {});
    assert.equal(m.symbolRate.value, null);
    assert.match(m.symbolRate.reason, /Hz wide|local floor/);
  },

  async function symbolRateFlagsAnAnalogueToneAsIndistinguishable() {
    // An AM carrier modulated by a 400 Hz sine puts one clean line at 400 Hz in
    // the transition spectrum. It is real, and it is not a symbol clock. The
    // difference is the absence of harmonics, and the module must say so rather
    // than call 400 Bd.
    const m = measure(add(amCarrier(5, 1500, 400, 0.3), gauss(RATE * 5, 0.004, 220)), RATE, {});
    assert.notEqual(m.symbolRate.value, null, 'the line is genuinely there');
    near(m.symbolRate.value, 400, 5, 'the modulating tone frequency');
    assert.equal(m.symbolRate.confidence.harmonicsFound, 0);
    assert.equal(m.symbolRate.confidence.analogueToneIndistinguishable, true);
    assert.match(m.symbolRate.confidence.caution, /analogue/);
    assert.equal(m.symbolRate.confidence.level, 'marginal');
  },

  async function harmonicSupportIsCountedContiguously() {
    // A real impulse lattice at f radiates at 2f as well as 3f. A line with
    // energy at 3f and 4f but a hole at 2f is not a fundamental, and counting
    // harmonics loosely made a spurious 6.32 Bd line on a real M08 recording
    // look like it had two of them.
    const sig = morse('CQ CQ DE M08 M08 K 12345 CQ DE M08', 20, 800);
    const m = measure(add(sig, gauss(sig.length, 0.005, 600)), RATE, {});
    const comb = m.symbolRate.confidence.comb;
    // The comb reaches only as far as the search ceiling, which is set by the
    // emission's own bandwidth: a 98 Hz-wide Morse signal cannot carry more
    // than about 49 Bd, so 3 x 16.67 is outside the range that was searched.
    assert.ok(comb.length >= 2, 'the comb should reach at least 2x, got ' + comb.length);
    assert.equal(comb[0].multiple, 1);
    // Counted contiguously, so every harmonic reported present must be, and
    // each must actually clear the bar.
    for (let i = 1; i <= m.symbolRate.confidence.harmonicsFound; i++) {
      assert.ok(comb[i].ratio >= 4,
        'harmonic ' + comb[i].multiple + 'x was counted at only ' + comb[i].ratio.toFixed(1) + 'x');
    }
    assert.ok('mayBeASubHarmonic' in m.symbolRate.confidence);
  },

  async function bothBandwidthDefinitionsCanFailAtOnce() {
    // A weak narrow carrier: carrier-dominant, so the 99% figure collapses, AND
    // too close to the noise for a -26 dB crossing. Neither number is an
    // occupied bandwidth and the module has to say so rather than pick one.
    const m = measure(add(tone(4, 1500, 0.012), gauss(RATE * 4, 0.02, 610)), RATE,
      { lowHz: 1200, highHz: 1800 });
    assert.equal(m.bandwidth.xdb.limitedByNoise, true);
    assert.ok(m.bandwidth.carrierFraction > 0.5);
    assert.equal(m.bandwidth.trustworthy, 'neither');
    assert.match(m.bandwidth.reason, /both definitions have failed/);
  },

  async function designatorCarriesForwardAMarginalMeasurement() {
    // An AM carrier with a 400 Hz modulating tone measures as a 400 Bd "symbol
    // rate" with no harmonic support. Handing that to the designator must not
    // produce a confident answer with no trace of the doubt.
    const m = measure(add(amCarrier(5, 1500, 400, 0.3), gauss(RATE * 5, 0.004, 620)), RATE, {});
    assert.equal(m.symbolRate.confidence.level, 'marginal');
    const d = designate('A1A', { measurement: m });
    assert.ok(d.designator, 'it still computes, because the caller declared the class');
    const flag = d.assumptions.find((a) => a.name === 'symbolRateIsMarginal');
    assert.ok(flag, 'the marginal warning did not travel with the designator');
    assert.match(flag.why, /analogue modulating tone|marginal/);
  },

  async function symbolRateHalvesMustAgree() {
    const m = measure(add(ook(6, 1200, 25, 0.4, 230), gauss(RATE * 6, 0.005, 231)), RATE, {});
    near(m.symbolRate.value, 25, Math.max(0.1, 3 * m.symbolRate.uncertainty), 'OOK baud');
    const halves = m.symbolRate.confidence.halves;
    assert.equal(halves.length, 2);
    for (const h of halves) {
      // A half may legitimately settle on a different member of the same comb
      // than the whole region does — this signal gives 12.5 in one half and 50
      // in the other. What must reproduce is the comb, so the test is on the
      // fundamental each half implies, not on the line it happened to pick.
      assert.ok(h.multipleOfFundamental >= 1);
      near(h.impliedFundamental, 25, 1.0, 'fundamental implied by a half-region line');
    }
  },

  async function symbolRateAgreesWithTheCyclicModule() {
    // An independent estimator, written for a different purpose, on a rate that
    // is inside the reach its own window allows (2 x rate/256 = 62.5 Hz here).
    const y = add(ook(8, 1000, 12.5, 0.5, 240), gauss(RATE * 8, 0.004, 241));
    const mine = measure(y, RATE, {});
    near(mine.symbolRate.value, 12.5, Math.max(0.1, 3 * mine.symbolRate.uncertainty), 'OOK 12.5 Bd');
    const c = analyseCyclic({ mono: y, sampleRate: RATE, alphaMaxHz: 40 });
    assert.ok(c && c.peaks.length, 'the cyclic module found nothing at all');
    const hit = c.peaks.some((p) => Math.abs(p.alphaHz - 12.5) < 0.6);
    assert.ok(hit, 'cyclic.js peaks ' + c.peaks.map((p) => p.alphaHz.toFixed(2)).join(',')
      + ' contain no line at the 12.5 Bd this module reports');
  },

  // --- FSK shift -----------------------------------------------------------

  async function fskShiftMeasuresAKnownSeparation() {
    for (const shift of [170, 425]) {
      const c = 1500;
      const x = add(fsk(randomBits(300, 5), 50, c + shift / 2, c - shift / 2),
        gauss(RATE * 6.5, 0.005, 250));
      const v = measure(x, RATE, {}).fskShift;
      assert.equal(v.unit, 'Hz');
      near(v.value, shift, Math.max(1, 2 * v.uncertainty), shift + ' Hz shift');
      assert.equal(v.biasDirection, 'low');
      assert.ok(v.value < shift, 'the transition-smearing bias is one-sided and low');
      assert.ok(v.valleyDepth >= 0.5 && v.massBalance >= 0.15);
    }
  },

  async function fskShiftGivesTheEmissionCentreNotJustAPeak() {
    const c = 1500, shift = 400;
    const m = measure(add(fsk(randomBits(300, 5), 50, c + shift / 2, c - shift / 2),
      gauss(RATE * 6.5, 0.005, 260)), RATE, {});
    near(m.centre.emissionCentreHz, c, 5, 'midpoint of the two tones');
    assert.match(m.centre.note, /stronger of two FSK tones/);
  },

  async function fskShiftIsNullOnAnythingUnimodal() {
    for (const [label, x] of [
      ['pure tone', add(tone(4, 1400, 0.4), gauss(RATE * 4, 0.01, 270))],
      ['noise', gauss(RATE * 4, 0.02, 271)],
      ['AM tone', add(amCarrier(4, 1500, 400, 0.5, 0.4), gauss(RATE * 4, 0.01, 272))],
    ]) {
      const v = measure(x, RATE, {}).fskShift;
      assert.equal(v.value, null, label + ' produced an FSK shift of ' + v.value);
      assert.ok(typeof v.reason === 'string' && v.reason.length > 20, label + ' gave no reason');
    }
  },

  async function ashmanDAloneWouldHaveFiredOnUnimodalData() {
    // Why the gate is the valley and not Ashman's D. An Otsu-style split of a
    // unimodal distribution produces D near 2.7 by construction, which clears
    // the textbook D > 2 bar every time.
    //
    // The estimator is called directly here, because through  this
    // input never reaches the bimodality test at all: the detection now
    // withholds every derived quantity on a region it has called empty, which
    // is checked below and is a different claim from this one.
    const noise = gauss(RATE * 5, 0.02, 280);
    const v = fskShift(noise, RATE, { from: 0, to: noise.length, lowHz: 300, highHz: 3700 });
    assert.equal(v.value, null);
    assert.ok(isFinite(v.ashmanD), 'this case should reach the full statistics');
    assert.ok(v.ashmanD >= 2,
      'the point of this test is that D = ' + v.ashmanD + ' would have passed a D > 2 gate');
    assert.ok(v.valleyDepth < 0.5, 'while the valley says there is no valley');
    assert.match(v.reason, /Ashman D here is/);
    // And through  the same noise is refused one stage earlier.
    const m = measure(noise, RATE, {});
    assert.equal(m.fskShift.value, null);
    assert.equal(m.fskShift.withheldOnDetection, true);
  },

  // --- refusal: the standard every estimator here is held to ----------------
  //
  // For each estimator there must exist an input for which it says "I cannot
  // tell", and that input must be realistic material rather than a constant.
  // A bench that reports 45.45 baud about hiss is worse than one that reports
  // nothing, because a reader will believe it.

  async function derivedQuantitiesAreWithheldWhenTheDetectionSaysAbsent() {
    // The regression this whole group exists to catch. The detection used to be
    // computed AFTER the symbol rate and the FSK shift, so the object could say
    // `present: false` and, in the same breath, assert a rate. Measured on
    // three seconds of constant DC before the gate: peak-to-floor 6.0 dB,
    // `present: false`, symbolRate = 4.509 Bd +/- 0.122 at confidence 'strong'.
    // There is no symbol rate in a constant.
    const m = measure(new Float32Array(RATE * 3).fill(0.25), RATE, {});
    assert.equal(m.ok, true, 'a constant is analysable; it just holds nothing');
    assert.equal(m.detection.present, false, 'constant DC is not an emission');
    assert.equal(m.detection.derivedQuantitiesWithheld, true);
    assert.deepEqual(m.detection.withheld, ['symbolRate', 'fskShift']);
    for (const name of ['symbolRate', 'fskShift']) {
      assert.equal(m[name].value, null,
        name + ' must not be asserted on a region the module has called empty');
      assert.equal(m[name].withheldOnDetection, true);
      assert.match(m[name].reason, /below the 10 dB detection bar/);
      assert.equal(m[name].method, null, name + ' must not claim a method it did not run');
    }

    // Not one lucky draw: noise, over seeds.
    for (let s = 0; s < 6; s++) {
      const n = measure(gauss(RATE * 3, 0.01, 600 + s), RATE, {});
      assert.equal(n.detection.present, false, 'seed ' + s + ' is noise');
      assert.equal(n.symbolRate.value, null, 'seed ' + s + ' symbol rate');
      assert.equal(n.fskShift.value, null, 'seed ' + s + ' FSK shift');
    }

    // And the gate is a gate, not a wall: a real emission still measures.
    const good = measure(add(ook(4, 1200, 50, 0.4, 3), gauss(RATE * 4, 0.01, 11)), RATE,
      { lowHz: 900, highHz: 1500 });
    assert.equal(good.detection.present, true);
    assert.equal(good.detection.derivedQuantitiesWithheld, false);
    near(good.symbolRate.value, 50, 1, 'a real 50 Bd clock still measures');
  },

  async function aWidebandEmissionIsStillDetectedWhenNoSingleBinIs() {
    // The gate must not be blunt. An emission wider than the window the
    // spectral floor is a median over sits inside its own floor estimate, so no
    // single bin stands clear of it: measured on the HM01 recording at 9.0 dB
    // peak-to-floor while the transition spectrum held a 120 Bd line at 29x.
    // So the detection carries a second statistic — the peak against a floor
    // taken from the bins OUTSIDE the emission's own skirt.
    const x = add(widebandKeyed(4, 900, 3100, 30, 0.5, 41), gauss(RATE * 4, 0.0015, 43));
    const m = measure(x, RATE, {});
    assert.ok(m.detection.peakBinSnrDb < 10,
      'the single-bin test should fail on a 2.2 kHz-wide emission, got '
      + m.detection.peakBinSnrDb.toFixed(1) + ' dB');
    assert.ok(m.detection.peakOutOfSkirtSnrDb > 25,
      'against a floor from outside the skirt it is unmistakable, got '
      + m.detection.peakOutOfSkirtSnrDb);
    assert.equal(m.detection.present, true);
    assert.equal(m.detection.detectedOnWideEmissionTest, true);
    assert.equal(m.detection.derivedQuantitiesWithheld, false);

    // The second statistic cannot rescue an empty region, which is the point of
    // it. A region with nothing in it has no skirt to be outside of: the -x dB
    // crossing never happens and the "emission" runs to the band edge. Before
    // that closure requirement, constant DC scored 9.2 dB on this statistic —
    // near enough to the 10 dB bar to be luck rather than a decision.
    for (const [what, empty] of [
      ['constant DC', new Float32Array(RATE * 3).fill(0.25)],
      ['white noise', gauss(RATE * 3, 0.01, 500)],
      ['white noise, another seed', gauss(RATE * 3, 0.01, 507)],
    ]) {
      const e = measure(empty, RATE, {});
      assert.equal(e.detection.peakOutOfSkirtSnrDb, null,
        what + ' must not get a wide-emission score at all');
      assert.equal(e.detection.present, false, what);
    }
  },

  async function symbolRateDoesNotAliasAFastPeriodicity() {
    // The decimator used to be a block sum — a boxcar with no anti-alias filter
    // in front of it — so anything periodic above decRate/2 folded into the
    // searched band and came back as a rate that is not there.
    //
    // 80% amplitude modulation at 300 Hz on a 1500 Hz carrier, searched over
    // 4 to 100 Bd with the decimated rate at 615.4 Hz. The envelope's own
    // first-difference line sits at 600 Hz, folds to |600 - 615.4| = 15.4, and
    // was reported as 15.406 Bd at 91x its local floor with three harmonics and
    // a confidence of 'strong' — the 1200 Hz second harmonic folds onto twice
    // the same alias, which is where the "harmonics" came from.
    const noise = gauss(RATE * 4, 0.004, 7);
    for (const [modHz, alias] of [[300, 15.4], [280, 55.4], [150, 15.4]]) {
      const x = add(amCarrier(4, 1500, modHz, 0.8), noise);
      const r = symbolRate(x, RATE, { from: 0, to: x.length, lowHz: 1200, highHz: 1800 });
      if (r.value != null) {
        assert.ok(Math.abs(r.value - alias) > 2,
          'a ' + modHz + ' Hz modulation must not be reported as ' + r.value.toFixed(2)
          + ' Bd, which is its own line folded about the decimation rate');
      }
      assert.equal(r.value, null,
        'nothing in a ' + modHz + ' Hz amplitude modulation keys at a rate this search can '
        + 'reach, so the honest answer is none: got ' + r.value);
    }

    // And the filter has not simply deafened the estimator: the same signal
    // with its line BELOW the fold point is still found, and found exactly.
    for (const [modHz, want] of [[20, 40], [30, 60], [45, 90]]) {
      const x = add(amCarrier(4, 1500, modHz, 0.8), noise);
      const r = symbolRate(x, RATE, { from: 0, to: x.length, lowHz: 1200, highHz: 1800 });
      assert.ok(r.value != null, modHz + ' Hz modulation should still produce its own line');
      near(r.value, want, 0.5, 'the un-aliased line at twice the modulation rate');
      assert.ok(r.confidence.ratio > 100, 'and it is not marginal: ' + r.confidence.ratio);
    }
  },

  async function fskShiftUncertaintyCoversItsOwnBias() {
    // The systematic used to be a flat 1.5% of the shift. It is not flat. On
    // 45.45 Bd / 170 Hz truth the error ran -0.13% where the modes are sharp
    // and -17.0% where they are not, while the stated bar never moved off 1.5%
    // — too small in exactly the place the measurement is least trustworthy.
    //
    // What predicts it is not the reported band SNR (which saturates near 28 dB
    // because the floor under a strong emission is that emission's own
    // splatter) but the measurement's own mode width. Here the claim is only
    // that the bar covers the truth, which is the claim that matters.
    let n = 0, inside = 0, worst = 0, widest = 0, narrowest = Infinity;
    for (const shift of [170, 425]) {
      for (const baud of [45.45, 100]) {
        for (const sigma of [0.002, 0.02, 0.06, 0.12]) {
          for (let s = 0; s < 2; s++) {
            const bits = randomBits(Math.ceil(baud * 4) + 4, 700 + s * 13 + shift);
            const x = add(fsk(bits, baud, 1500 + shift / 2, 1500 - shift / 2, 0.4),
              gauss(RATE * 4, sigma, 800 + s * 29 + baud));
            const half = Math.max(500, shift * 1.6);
            const m = measure(x, RATE, { lowHz: 1500 - half, highHz: 1500 + half });
            if (!m.ok || m.fskShift.value == null) continue;
            const f = m.fskShift;
            n++;
            const z = Math.abs(f.value - shift) / f.uncertainty;
            if (z <= 1) inside++;
            if (z > worst) worst = z;
            const frac = f.systematicFraction;
            if (frac > widest) widest = frac;
            if (frac < narrowest) narrowest = frac;
            assert.equal(f.biasDirection, 'low');
            assert.ok(f.value <= shift * 1.01,
              'the bias is one-sided LOW; ' + f.value.toFixed(1) + ' against a truth of ' + shift);
          }
        }
      }
    }
    assert.ok(n >= 20, 'only ' + n + ' points survived to be checked');
    assert.equal(inside, n,
      'the truth fell outside the stated bar on ' + (n - inside) + ' of ' + n
      + ' points; worst was ' + worst.toFixed(2) + ' sigma');
    // And the bar is not a constant wearing a new name.
    assert.ok(widest > 4 * narrowest,
      'the systematic must track the measurement: it ran ' + (100 * narrowest).toFixed(1)
      + '% to ' + (100 * widest).toFixed(1) + '%');
    assert.ok(narrowest >= FSK_TRANSITION_FRACTION - 1e-12,
      'and never below the transition-smearing floor measured at zero noise');
  },

  async function fskShiftRefusesWhenItsOwnModesAreTooBroad() {
    // Past FSK_MAX_MODE_WIDTH the inward bias reached -26% of the shift on the
    // calibration grid — wrong by more than the difference between the shifts a
    // reader is trying to tell apart. An 85 Hz shift at 25 Bd under heavy noise
    // reaches it on realistic material.
    let refused = 0, measured = 0;
    for (const sigma of [0.18, 0.26]) {
      for (let s = 0; s < 3; s++) {
        const bits = randomBits(Math.ceil(25 * 4) + 4, 3000 + s * 17);
        const x = add(fsk(bits, 25, 1542.5, 1457.5, 0.4), gauss(RATE * 4, sigma, 6000 + s * 31));
        const m = measure(x, RATE, { lowHz: 1000, highHz: 2000 });
        if (!m.ok) continue;
        const f = m.fskShift;
        if (f.value == null && /% of the shift wide/.test(f.reason)) refused++;
        else if (f.value != null) measured++;
      }
    }
    assert.ok(refused >= 1,
      'the mode-width refusal must be reachable on realistic material, not dead code');
    // Sanity that the same estimator still answers when the modes are sharp.
    const clean = measure(add(fsk(randomBits(200, 9), 45.45, 1585, 1415, 0.4),
      gauss(RATE * 4, 0.004, 31)), RATE, { lowHz: 1100, highHz: 1900 });
    assert.ok(clean.fskShift.value != null, 'a clean 170 Hz shift must still measure');
    assert.ok(clean.fskShift.modeWidthFraction < FSK_MAX_MODE_WIDTH);
  },

  async function symbolRateLevelIsCappedWhenTheChannelsDisagree() {
    // `channelsDisagree` means the three transition channels peak at
    // frequencies with no integer relation, which means the band holds more
    // than one thing and the winner is a rate for whichever was loudest. The
    // confidence used to be computed from harmonic count and peak-to-floor
    // ratio alone and never consulted it, so a rate the module itself knew was
    // contradicted could still come back 'good' or 'strong'.
    //
    // One emission with two independent clocks: a teleprinter keyed at 50 Bd
    // whose carrier is separately chopped at 19 Bd, which is what an
    // interrupted or badly faded link looks like. 50/19 is not an integer.
    const x = add(chopped(5, 50, 19, 170, 0, 9), gauss(RATE * 5, 0.002, 21));
    const r = symbolRate(x, RATE, { from: 0, to: x.length, lowHz: 1250, highHz: 1750,
      emissionBandwidthHz: 300 });
    assert.ok(r.value != null, 'this construction should still produce a line');
    const c = r.confidence;
    assert.equal(c.channelsDisagree, true,
      'two unrelated clocks in one band is what this case is for; channels were '
      + JSON.stringify(r.channels));
    // What the old rule would have said, recomputed from the numbers the object
    // still reports: harmonic count and ratio alone.
    const uncapped = c.harmonicsFound >= 2 && c.ratio >= 2 * SYMBOL_MIN_RATIO ? 'strong'
      : c.harmonicsFound >= 1 ? 'good' : 'marginal';
    assert.notEqual(uncapped, 'marginal',
      'this case only pins the fix if the old rule would have been confident; it said '
      + uncapped + ' on ' + c.harmonicsFound + ' harmonics at ' + c.ratio.toFixed(1) + 'x');
    assert.equal(c.level, 'marginal',
      'a rate contradicted between channels cannot be reported ' + c.level);
    assert.equal(c.levelCappedByChannelDisagreement, true);

    // The invariant, over every case in this file that produces a rate at all:
    // disagreement and confidence never coexist.
    const corpus = [
      add(ook(4, 1200, 50, 0.4, 3), gauss(RATE * 4, 0.01, 11)),
      add(fsk(randomBits(200, 3), 45.45, 1585, 1415, 0.4), gauss(RATE * 4, 0.006, 13)),
      add(chopped(5, 45.45, 13, 170, 0.1, 9), gauss(RATE * 5, 0.002, 23)),
      add(chopped(5, 50, 13, 170, 0.1, 9), gauss(RATE * 5, 0.002, 25)),
      x,
    ];
    for (const s of corpus) {
      const g = symbolRate(s, RATE, { from: 0, to: s.length, lowHz: 1050, highHz: 1900,
        emissionBandwidthHz: 400 });
      if (g.value == null) continue;
      if (g.confidence.channelsDisagree) {
        assert.equal(g.confidence.level, 'marginal',
          'disagreeing channels reported at ' + g.confidence.level);
      }
    }
  },

  async function noiseAloneNeverProducesAMeasurement() {
    // The false-accept rate, measured rather than asserted, on three kinds of
    // material that hold no emission: white noise, a 1/f band floor (which is
    // what an empty HF band actually looks like), and a DC offset with a little
    // noise on it. 40 seeds of each.
    let n = 0, baud = 0, shift = 0, present = 0;
    for (let s = 0; s < 40; s++) {
      const inputs = [
        gauss(RATE * 3, 0.01, 900 + s),
        pinkNoise(RATE * 3, 0.05, 1300 + s),
        add(new Float32Array(RATE * 3).fill(0.2), gauss(RATE * 3, 0.001 * (1 + s % 5), 1700 + s)),
      ];
      for (const x of inputs) {
        const m = measure(x, RATE, {});
        n++;
        if (!m.ok) continue;
        if (m.detection.present) present++;
        if (m.symbolRate.value != null) baud++;
        if (m.fskShift.value != null) shift++;
      }
    }
    assert.equal(baud, 0, baud + ' of ' + n + ' noise-only inputs were given a symbol rate');
    assert.equal(shift, 0, shift + ' of ' + n + ' noise-only inputs were given an FSK shift');
    // The detection stage itself is allowed to be marginal on coloured noise —
    // a 1/f floor genuinely has a slope, and its lowest bins genuinely stand
    // above the median. Measured here: about 1 in 12 of these inputs clears the
    // 10 dB bar. What must never happen is a derived NUMBER coming out of one,
    // and that is what the two assertions above check.
    assert.ok(present <= n / 6,
      present + ' of ' + n + ' noise-only inputs were called occupied');
  },

  async function everyErrorBarSurvivesASplitHalfTest() {
    // An error bar that its own data can disprove is a lie. Every quantity that
    // carries one is measured on the first half of the region and on the second
    // half separately; the two must agree inside their own bars. Systematic
    // terms are common to both halves and cancel out of the difference, so this
    // is a one-sided test: it catches bars that are too narrow, not bars that
    // are too wide.
    const signals = [
      ['drifting carrier', add(tone(6, 1234.5, 0.5, 2), gauss(RATE * 6, 0.008, 61)), {}],
      ['45.45 Bd teleprinter',
        add(fsk(randomBits(300, 3), 45.45, 1585, 1415, 0.4), gauss(RATE * 6.6, 0.006, 63)),
        { lowHz: 1100, highHz: 1900 }],
      ['50 Bd on-off keying',
        add(ook(6, 1200, 50, 0.4, 3), gauss(RATE * 6, 0.01, 65)), { lowHz: 900, highHz: 1500 }],
    ];
    const paths = [
      ['noiseFloor', (m) => m.noiseFloor],
      ['snr', (m) => m.snr],
      ['centre', (m) => m.centre],
      ['bandwidth.xdb', (m) => m.bandwidth.xdb],
      ['bandwidth.occupied99', (m) => m.bandwidth.occupied99],
      ['drift', (m) => m.drift],
      ['symbolRate', (m) => m.symbolRate],
      ['fskShift', (m) => m.fskShift],
    ];
    let compared = 0, excused = 0;
    for (const [what, x, region] of signals) {
      const sec = x.length / RATE;
      const a = measure(x, RATE, Object.assign({}, region, { startSec: 0, endSec: sec / 2 }));
      const b = measure(x, RATE, Object.assign({}, region, { startSec: sec / 2, endSec: sec }));
      assert.ok(a.ok && b.ok, what + ': both halves must be analysable');
      for (const [name, get] of paths) {
        const qa = get(a), qb = get(b);
        if (!qa || !qb || qa.value == null || qb.value == null) continue;
        // Two exemptions, and both are properties of the signal rather than
        // excuses for the estimator.
        //
        // A drifting emission is SUPPOSED to sit at a different frequency in
        // each half — the slope is what has to reproduce, not the centre — so
        // `centre` is exempt exactly when the measured drift accounts for the
        // move, and is held to the test otherwise.
        // The drift must be a MEASUREMENT, not just a large point estimate: a
        // teleprinter's peak track hops between its two tones and fits a slope
        // of -10.8 Hz/s with an uncertainty of 92.9, which explains nothing and
        // exempts nothing.
        if (name === 'centre' && a.drift.value != null
          && Math.abs(a.drift.value) > 3 * a.drift.uncertainty
          && Math.abs(a.drift.value) * (sec / 2) > 2 * Math.hypot(qa.uncertainty, qb.uncertainty)) {
          excused++;
          continue;
        }
        // And the 99% width is exempt where the module has already disowned it.
        // On a carrier-dominant emission both crossings sit on the splatter
        // tails: measured on a 50 Bd on-off keyed carrier, halves of one
        // recording read 156.7 and 232.4 Hz against bars of 5.7 and 18.0. The
        // module reports `trustworthy: 'xdb'` and a reason for that case, and
        // that verdict is asserted here rather than the bar.
        if (name === 'bandwidth.occupied99'
          && (qa.collapsed === true || a.bandwidth.trustworthy === 'neither')) {
          assert.ok(a.bandwidth.reason && a.bandwidth.reason.length > 20,
            what + ': the module disowned occupied99 without saying why');
          assert.ok(qa.caution || a.bandwidth.trustworthy === 'neither',
            what + ': occupied99 was disowned but not flagged on the quantity itself');
          assert.notEqual(a.bandwidth.trustworthy, 'occupied99',
            what + ': a collapsed 99% width must not be the nominated definition');
          excused++;
          continue;
        }
        compared++;
        const bar = Math.hypot(qa.uncertainty, qb.uncertainty);
        assert.ok(bar > 0, what + ' ' + name + ' claims a zero-width bar');
        assert.ok(Math.abs(qa.value - qb.value) <= 2 * bar,
          what + ' ' + name + ': halves disagree by '
          + Math.abs(qa.value - qb.value).toPrecision(3) + ' ' + qa.unit
          + ' against a combined bar of ' + bar.toPrecision(3)
          + ' (' + qa.value.toPrecision(6) + ' vs ' + qb.value.toPrecision(6) + ')');
      }
    }
    assert.ok(compared >= 14,
      'only ' + compared + ' quantities were reachable to compare (' + excused + ' exempt)');
    assert.ok(excused <= 3, excused + ' quantities claimed an exemption; that is too many');
  },

  async function everyEstimatorHasAnInputItRefuses() {
    // The standard, stated as a test. Realistic material, not a constant: an
    // empty band, a pure carrier, an analogue-modulated carrier, a keyed
    // carrier, a teleprinter, and a wideband emission. Each estimator must
    // refuse on at least one of them and answer on at least one.
    const corpus = [
      ['empty band', gauss(RATE * 4, 0.01, 71), {}],
      ['quiet slice of an empty band', gauss(RATE * 4, 0.01, 72), { lowHz: 3000, highHz: 3900 }],
      ['a short burst in a long silence', burst(4, 0.3, 1500, 0.5, 0.01, 83), { lowHz: 1200, highHz: 1800 }],
      // One second of an empty 900 Hz slice. Nothing exotic — it is what a
      // tuning sweep looks like — and it is where the drift fit runs out of
      // frames that carry a peak at all and says so instead of fitting one.
      ['a one-second look at a quiet slice', gauss(RATE, 0.01, 85), { lowHz: 3000, highHz: 3900 }],
      ['pure carrier', add(tone(4, 1000, 0.5), gauss(RATE * 4, 0.01, 73)), {}],
      ['AM carrier', add(amCarrier(4, 1500, 400, 0.6), gauss(RATE * 4, 0.004, 75)), {}],
      ['on-off keying', add(ook(4, 1200, 50, 0.4, 3), gauss(RATE * 4, 0.01, 77)),
        { lowHz: 900, highHz: 1500 }],
      ['teleprinter', add(fsk(randomBits(200, 3), 45.45, 1585, 1415, 0.4),
        gauss(RATE * 4.4, 0.006, 79)), { lowHz: 1100, highHz: 1900 }],
      ['wideband keyed', add(widebandKeyed(4, 900, 3100, 30, 0.5, 41),
        gauss(RATE * 4, 0.0015, 81)), {}],
    ];
    // A corpus of six that reaches every refusal path would be a corpus chosen
    // to reach them; this one is chosen to be ordinary, which is the point.
    assert.equal(corpus.length, 9);
    const estimators = [
      ['symbolRate', (m) => m.symbolRate],
      ['fskShift', (m) => m.fskShift],
      ['drift', (m) => m.drift],
      ['carrierOffset', (m) => m.carrierOffset],
    ];
    const refusedOn = {}, answeredOn = {};
    for (const [what, x, region] of corpus) {
      const m = measure(x, RATE, region);
      if (!m.ok) continue;
      for (const [name, get] of estimators) {
        const v = get(m);
        if (!v) continue;
        if (v.value == null) {
          assert.equal(typeof v.reason, 'string', name + ' refused ' + what + ' without a reason');
          assert.ok(v.reason.length > 15, name + ' gave an unusable reason: ' + v.reason);
          (refusedOn[name] = refusedOn[name] || []).push(what);
        } else {
          (answeredOn[name] = answeredOn[name] || []).push(what);
        }
      }
    }
    for (const [name] of estimators) {
      assert.ok(refusedOn[name] && refusedOn[name].length,
        name + ' never said "I cannot tell" on any of ' + corpus.length
        + ' realistic inputs, so it has no refusal path a reader can rely on');
    }
    // The bandwidth, the centre and the SNR cannot be withheld the same way,
    // because the detection verdict is computed FROM them. So the second half
    // of the contract: on a region called empty, each of them carries the
    // verdict, and the number cannot be lifted out of the object without it.
    const empty = measure(gauss(RATE * 3, 0.01, 87), RATE, {});
    assert.equal(empty.detection.present, false);
    let carried = 0;
    for (const q of [empty.snr, empty.centre, empty.bandwidth.xdb,
      empty.bandwidth.occupied99, empty.drift]) {
      if (!q || q.value == null) continue;
      carried++;
      assert.equal(q.measuredOnAnAbsentDetection, true,
        'a quantity measured on an absent detection must say so');
      assert.match(q.detectionCaveat, /detection bar/);
    }
    assert.ok(carried >= 3, 'only ' + carried + ' unwithheld quantities were reachable');
    for (const name of ['symbolRate', 'fskShift', 'drift']) {
      assert.ok(answeredOn[name] && answeredOn[name].length,
        name + ' refused everything, which is not a working estimator either');
    }
  },

  // --- the designator ------------------------------------------------------

  async function bandwidthFieldMatchesEveryItuExample() {
    const pairs = [
      [0.002, 'H002'], [0.1, 'H100'], [25.3, '25H3'], [400, '400H'], [2400, '2K40'],
      [6000, '6K00'], [12500, '12K5'], [180400, '180K'], [180500, '181K'],
      [1.25e6, '1M25'], [2e6, '2M00'], [10e6, '10M0'], [202e6, '202M'], [5.65e9, '5G65'],
    ];
    for (const [hz, want] of pairs) {
      assert.equal(formatBandwidth(hz), want, hz + ' Hz should format as ' + want);
    }
    // Rounding must be applied before the decade is chosen.
    assert.equal(formatBandwidth(999.6), '1K00');
    assert.equal(formatBandwidth(9.996), '10H0');
    assert.equal(formatBandwidth(0), null);
    assert.equal(formatBandwidth(0.0004), null);
    assert.equal(roundedValueOf('249H'), 249);
    assert.equal(roundedValueOf('2K40'), 2400);
    assert.equal(roundedValueOf('H002'), 0.002);
  },

  async function rttyDesignatorIsExactly249HF1B() {
    // ITU-R SM.1138, F1B: Bn = 2M + 2DK with M = B/2, D = shift/2, K = 1.2.
    // 45.45 baud and a 170 Hz shift give M = 22.725, D = 85 and
    // Bn = 45.45 + 204 = 249.45 Hz.
    const r = designate('F1B', { baud: 45.45, shiftHz: 170 });
    assert.equal(r.designator, '249HF1B');
    near(r.bandwidth.value, 249.45, 1e-9, 'Bn');
    assert.equal(r.bandwidth.formatted, '249H');
    assert.equal(r.symbols.modulation, 'F');
    assert.equal(r.symbols.signal, '1');
    assert.equal(r.symbols.information, 'B');
    assert.equal(r.assumptions.find((a) => a.name === 'K').value, 1.2);
    assert.match(r.caveat, /assertion/);
  },

  async function morseDesignatorUsesTheStatedWordLengthAndPathFactor() {
    // PARIS: 20 wpm is 16.667 dots per second, K = 5 on a fading circuit,
    // Bn = 83.33 Hz.
    const paris = designate('A1A', { wpm: 20 });
    assert.equal(paris.designator, '83H3A1A');
    near(paris.bandwidth.value, 20 * 50 / 60 * K_FADING, 1e-9, 'Bn under PARIS');
    assert.equal(paris.assumptions.find((a) => a.name === 'K').value, K_FADING);
    assert.equal(paris.assumptions.find((a) => a.name === 'unitsPerWord').value, 50);

    // A non-fading circuit is K = 3 and a different answer entirely.
    const nonFading = designate('A1A', { wpm: 20, fading: false });
    assert.equal(nonFading.designator, '50H0A1A');
    assert.equal(nonFading.assumptions.find((a) => a.name === 'K').value, K_NON_FADING);

    // And the recommendation's own worked example, which uses a 48-unit word:
    // "B = 20 bauds (25 words per minute)", K = 5, Bn = 100 Hz.
    const itu = designate('A1A', { wpm: 25, unitsPerWord: 48 });
    assert.equal(itu.designator, '100HA1A');
    near(itu.bandwidth.value, 100, 1e-9, 'the ITU A1A example');
  },

  async function otherClassesComputeTheirOwnFormulas() {
    assert.equal(designate('A3E', { maxModulationHz: 3000 }).designator, '6K00A3E');
    assert.equal(designate('J3E', { maxModulationHz: 3100, minModulationHz: 300 }).designator, '2K80J3E');
    assert.equal(designate('F3E', { maxModulationHz: 3000, deviationHz: 5000 }).designator, '16K0F3E');
    assert.equal(designate('A2A', { wpm: 20, maxModulationHz: 1000 }).designator, '2K08A2A');
  },

  async function designatorRefusesWithoutAClassification() {
    for (const c of [null, 'unknown', '', 'Z9Z']) {
      const r = designate(c, { baud: 45.45, shiftHz: 170 });
      assert.equal(r.designator, null, String(c) + ' produced a designator');
      assert.ok(r.refused && r.refused.reason.length > 20);
    }
    assert.match(designate('unknown').refused.reason, /classification is unknown/);
  },

  async function designatorRefusesWhenAnInputIsMissing() {
    const r = designate('F1B', { baud: 50 });
    assert.equal(r.designator, null);
    assert.deepEqual(r.refused.missing, ['shiftHz']);
    assert.match(r.refused.formula, /2M \+ 2DK/);
    // And it repeats why the measurement could not supply it.
    const m = measure(add(tone(3, 1000, 0.5), gauss(RATE * 3, 0.01, 300)), RATE, {});
    const r2 = designate('F1B', { measurement: m });
    assert.equal(r2.designator, null);
    assert.ok(r2.refused.missing.includes('baud') && r2.refused.missing.includes('shiftHz'));
    assert.match(r2.refused.reason, /neither declared nor measurable/);
  },

  async function designatorCarriesTheMeasurementUncertaintyThrough() {
    const r = designate('F1B', {
      measurement: {
        symbolRate: { value: 45.45, uncertainty: 0.2, method: 'test' },
        fskShift: { value: 170, uncertainty: 2.5, method: 'test' },
      },
    });
    assert.equal(r.designator, '249HF1B');
    // Bn = B + shift*K, so the uncertainty is sqrt(0.2^2 + (1.2*2.5)^2).
    near(r.bandwidth.uncertainty, Math.hypot(0.2, 1.2 * 2.5), 1e-9, 'propagated uncertainty');
    assert.equal(r.bandwidth.contributions.length, 2);
    assert.equal(r.inputs.find((i) => i.name === 'baud').source, 'measured symbol rate');
  },

  async function designatorEndToEndFromASynthesisedTeleprinter() {
    const m = measure(add(fsk(randomBits(300, 7), 45.45, 1585, 1415), gauss(RATE * 6.7, 0.005, 310)), RATE, {});
    const r = designate('F1B', { measurement: m });
    assert.ok(r.designator, 'end-to-end produced no designator: '
      + JSON.stringify(r.refused || {}));
    // The truth is 249.45 Hz; the measured shift runs about 1% low by the
    // documented transition-smearing bias, so allow a few hertz.
    near(r.bandwidth.value, 249.45, 6, 'end-to-end necessary bandwidth');
    assert.match(r.designator, /^24[3-9]HF1B$/);
    assert.ok(r.bandwidth.uncertainty > 0, 'the measured inputs carry uncertainty');
  },

  // --- the contract every returned number is held to ------------------------

  async function everyQuantityCarriesUnitAndMethodOrReason() {
    const cases = [
      measure(add(tone(3, 1000, 0.4), gauss(RATE * 3, 0.01, 400)), RATE, { expectedHz: 999 }),
      measure(add(fsk(randomBits(200, 3), 50, 1600, 1300), gauss(RATE * 4.5, 0.006, 401)), RATE, {}),
      measure(gauss(RATE * 3, 0.01, 402), RATE, {}),
    ];
    let checked = 0;
    const walk = (o, path) => {
      if (!o || typeof o !== 'object' || ArrayBuffer.isView(o)) return;
      if ('value' in o && 'unit' in o) {
        checked++;
        if (o.value === null) {
          assert.equal(typeof o.reason, 'string', path + ' is null without a reason');
          assert.ok(o.reason.length > 15, path + ' has a reason too short to act on: ' + o.reason);
        } else {
          assert.equal(typeof o.method, 'string', path + ' has a value but no method');
          assert.ok(typeof o.unit === 'string' && o.unit.length, path + ' has no unit');
          assert.ok('uncertainty' in o, path + ' has no uncertainty field');
        }
      }
      for (const k of Object.keys(o)) walk(o[k], path + '.' + k);
    };
    for (const m of cases) walk(m, 'measure');
    assert.ok(checked >= 20, 'only ' + checked + ' quantities were reachable to check');
  },

  async function shortOrEmptyRegionsAreRefusedNotGuessed() {
    assert.equal(measure(new Float32Array(100), RATE, {}).ok, false);
    assert.equal(measure(null, RATE, {}).ok, false);
    const narrow = measure(gauss(RATE * 2, 0.01, 500), RATE, { lowHz: 1000, highHz: 1005 });
    assert.equal(narrow.ok, false);
    assert.match(narrow.reason, /fewer than three analysis bins/);
  },

  async function estimatorsCanBeCalledOnTheirOwn() {
    // The pieces are exported so a caller can measure one thing without paying
    // for all of them; check they work standalone.
    const x = add(fsk(randomBits(250, 3), 50, 1600, 1300), gauss(RATE * 5.5, 0.005, 510));
    const opts = { from: 0, to: x.length, lowHz: 1100, highHz: 1800 };
    const s = symbolRate(x, RATE, Object.assign({ emissionBandwidthHz: 420 }, opts));
    near(s.value, 50, Math.max(0.2, 3 * s.uncertainty), 'standalone symbol rate');
    const f = fskShift(x, RATE, opts);
    near(f.value, 300, Math.max(3, 2 * f.uncertainty), 'standalone FSK shift');
  },
];
