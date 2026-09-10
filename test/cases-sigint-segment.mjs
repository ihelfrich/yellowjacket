// Finding signals in a window, and saying what they are, pinned against
// material whose answer is known by construction.
//
// The case this file exists for is the first one. Otsu's method and k-means
// return a split for any input including pure noise, so the only way to know a
// detector is a detector is to give it nothing and require nothing back.
//
// "Nothing" used to mean one white Gaussian generator with the seed varied,
// and that is the one spectrum every clamp in the module was built around. It
// is also the one background no HF recording has. The refusal cases below use
// four: white, 1/f, white under a 0.4 Hz fade, and white carrying atmospheric
// crashes. Three of the four fired before the work this file pins — 1/f gave
// one confident 20-second detection per seed, fading gave eleven to fifteen
// full-band ones per seed at confidence 1.0000, crashes gave ten to thirteen —
// so the refusal was never a property of the module, only of the test.
import assert from 'node:assert/strict';

import {
  segment, spectrogram, noiseFloor, analysisBand, standingBands, mergeEmissions, impulsiveness,
  poissonCritical, gammaTailLog, gammaMeanThreshold, EXPECTED_FALSE_CELLS,
  CONFIDENCE_CAP_FULL_BAND, CONFIDENCE_CAP_FLOOR_FROM_NEIGHBOURS, CONFIDENCE_CAP_NONSTATIONARY,
  FULL_BAND_FRACTION, STANDING_STEP_DB, GROW_CELL_RATE,
} from '../js/sigint/segment.js';
import {
  extractFeatures, classify, classifySegment, modes, gridFit, gapFraction, periodicity,
  HYPOTHESES, MIN_SCORE, RAYLEIGH_DEPTH,
} from '../js/sigint/classify.js';
import { firBandpass, filter } from '../js/dsp/analytic.js';

const SR = 8000;

// A seeded xorshift through Box-Muller. Gaussian rather than a sum of
// uniforms, because the kurtosis case below tests against the Gaussian null
// and an Irwin-Hall sum carries a real excess kurtosis of -0.1 of its own.
function rng(seed) {
  let s = ((seed | 0) * 2654435761) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return (s + 0.5) / 4294967296; };
}
function noise(n, seed, amp = 0.05) {
  const r = rng(seed), x = new Float64Array(n);
  for (let i = 0; i < n; i += 2) {
    const u = Math.sqrt(-2 * Math.log(r())), v = 2 * Math.PI * r();
    x[i] = amp * u * Math.cos(v);
    if (i + 1 < n) x[i + 1] = amp * u * Math.sin(v);
  }
  return x;
}

/* ------------------------------------------------------------------ *
 * Four backgrounds, none of which is a signal.
 * ------------------------------------------------------------------ */

// 1/f, by Paul Kellet's economical filter. Measured through the module's own
// floor estimate at 8 kHz with 15.6 Hz bins: -46 dB at 63 Hz falling to -63 dB
// at 3 kHz, a 17 dB tilt across the analysed band.
function pinkNoise(n, seed, amp = 0.05) {
  const w = noise(n, seed, 1), x = new Float64Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const v = w[i];
    b0 = 0.99886 * b0 + v * 0.0555179;
    b1 = 0.99332 * b1 + v * 0.0750759;
    b2 = 0.96900 * b2 + v * 0.1538520;
    b3 = 0.86650 * b3 + v * 0.3104856;
    b4 = 0.55000 * b4 + v * 0.5329522;
    b5 = -0.7616 * b5 - v * 0.0168980;
    x[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + v * 0.5362) * amp * 0.11;
    b6 = v * 0.115926;
  }
  return x;
}

// White noise whose amplitude breathes at 0.4 Hz. This is what an HF path does
// to the receiver's own noise, and it is the background every signal on this
// shelf actually sits in. The 10th-to-90th spread of the module's own frame
// gain on this is 24 dB.
function fadingNoise(n, seed, { amp = 0.05, fadeHz = 0.4, depth = 0.95, rate = SR } = {}) {
  const x = noise(n, seed, amp);
  for (let i = 0; i < n; i++) x[i] *= 1 + depth * Math.cos((2 * Math.PI * fadeHz * i) / rate);
  return x;
}

// Atmospheric crashes: white noise plus short loud impulses at random times.
// Broadband and instantaneous, which is what makes them the hard case — a
// crash is shorter than the analysis window, so the window itself smears it
// into something that has a duration.
function impulsiveNoise(n, seed, { amp = 0.05, count = 40, gain = 30, lenSec = 0.002, rate = SR } = {}) {
  const x = noise(n, seed, amp), r = rng(seed ^ 0x5bd1);
  const len = Math.max(1, Math.round(lenSec * rate));
  for (let k = 0; k < count; k++) {
    const at = Math.floor(r() * (n - len));
    for (let i = 0; i < len; i++) x[at + i] += amp * gain * Math.exp(-3 * i / len) * (r() * 2 - 1);
  }
  return x;
}

const BACKGROUNDS = [
  ['white', (n, s) => noise(n, s)],
  ['1/f', (n, s) => pinkNoise(n, s)],
  ['white under a 0.4 Hz fade', (n, s) => fadingNoise(n, s)],
  ['white with atmospheric crashes', (n, s) => impulsiveNoise(n, s)],
];

/* ------------------------------------------------------------------ *
 * Emitters
 * ------------------------------------------------------------------ */

function addTone(x, hz, amp, t0, t1, rate = SR) {
  const a = Math.max(0, Math.round(t0 * rate)), b = Math.min(x.length, Math.round(t1 * rate));
  for (let i = a; i < b; i++) x[i] += amp * Math.cos((2 * Math.PI * hz * i) / rate);
  return x;
}

// A genuinely band-limited emitter: white noise through a 1023-tap Kaiser
// bandpass, scaled to sit `gainDb` over the RMS of a base noise of amplitude
// `base`. The tap count is load-bearing. A cascade of one-pole sections leaks
// 12 dB per octave, and at 35 dB up that is still over the floor across the
// whole band — measured, such a "600 to 1400 Hz emitter" put the floor at -7
// dB at 900 Hz and -15 dB at 3 kHz, which is a tilt in the background and not
// a rectangle in it, and it tests nothing this file means to test.
function bandEmitter(n, seed, { lowHz, highHz, gainDb = 35, base = 0.05, rate = SR, taps = 1023 } = {}) {
  const y = filter(noise(n, seed, 1), firBandpass(taps, lowHz / rate, highHz / rate, 80));
  const g = n >> 3;
  let s = 0, c = 0;
  for (let i = g; i < n - g; i++) { s += y[i] * y[i]; c += 1; }
  const scale = (base * Math.pow(10, gainDb / 20)) / (Math.sqrt(s / Math.max(1, c)) || 1);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = y[i] * scale;
  return out;
}

const MORSE = { A: '.-', C: '-.-.', D: '-..', E: '.', M: '--', N: '-.', O: '---', Q: '--.-', S: '...', T: '-', 1: '.----', 2: '..---', 3: '...--', 5: '.....' };
// On-off keyed carrier with a 5 ms raised edge, the way a keyer shapes one.
function morse(text, { rate = SR, hz = 900, wpm = 18, amp = 0.5, lead = 0.4, tail = 0.4 } = {}) {
  const dit = 1.2 / wpm, units = [];
  for (const ch of text.toUpperCase()) {
    if (ch === ' ') { units.push(['off', 4 * dit]); continue; }
    const code = MORSE[ch];
    if (!code) continue;
    for (let i = 0; i < code.length; i++) {
      units.push(['on', (code[i] === '.' ? 1 : 3) * dit]);
      units.push(['off', i < code.length - 1 ? dit : 3 * dit]);
    }
  }
  let total = lead + tail;
  for (const u of units) total += u[1];
  const x = new Float64Array(Math.round(total * rate));
  let t = lead;
  for (const [k, d] of units) {
    if (k === 'on') {
      const a = Math.round(t * rate), b = Math.round((t + d) * rate);
      for (let i = a; i < b; i++) {
        const env = Math.min(1, (i - a) / (0.005 * rate)) * Math.min(1, (b - i) / (0.005 * rate));
        x[i] += amp * env * Math.cos((2 * Math.PI * hz * i) / rate);
      }
    }
    t += d;
  }
  return { x, dit, ditRateHz: 1 / dit, durationSec: total };
}

// Continuous-phase keying between a set of tones, one tone per symbol.
function toneKeyed(symbols, tones, { rate = SR, baud = 20, amp = 0.5, lead = 0.3, tail = 0.3 } = {}) {
  const spb = rate / baud;
  const n = Math.round((lead + tail) * rate + symbols.length * spb);
  const x = new Float64Array(n);
  const a0 = Math.round(lead * rate), a1 = n - Math.round(tail * rate);
  let ph = 0;
  for (let i = a0; i < a1; i++) {
    const s = symbols[Math.min(symbols.length - 1, Math.floor((i - a0) / spb))];
    ph += (2 * Math.PI * tones[s % tones.length]) / rate;
    x[i] += amp * Math.cos(ph);
  }
  return { x, durationSec: n / rate };
}
const prbs = (count) => {
  const bits = []; let q = 0x1f;
  for (let i = 0; i < count; i++) { q = ((q << 1) | (((q >> 4) ^ (q >> 2)) & 1)) & 0x1f; bits.push(q & 1); }
  return bits;
};

// Bursts of INDEPENDENT band-limited noise at a fixed pulse repetition rate.
function pulsedWide(seconds, { rate = SR, prf = 50, duty = 0.15, amp = 2.5, seed = 7 } = {}) {
  const n = Math.round(seconds * rate), raw = new Float64Array(n), r = rng(seed);
  const period = rate / prf, on = period * duty;
  for (let i = 0; i < n; i++) {
    if (i % period < on) {
      const u = Math.sqrt(-2 * Math.log(r())), v = 2 * Math.PI * r();
      raw[i] = amp * u * Math.cos(v);
    }
  }
  const y = new Float64Array(n);
  let lo = 0, hi = 0;
  for (let i = 0; i < n; i++) { lo += (raw[i] - lo) / 2; y[i] = lo; }
  for (let i = 0; i < n; i++) { hi += (y[i] - hi) / 8; y[i] -= hi; }
  return { x: y, prf, duty };
}

// The SAME swept pulse repeated at a fixed rate: a coherent pulsed emitter,
// which is the shape an over-the-horizon radar has in a receiver's audio.
// Its spectrum is a comb at the repetition rate rather than the flat band an
// incoherent burst train gives, and that difference used to cost the class the
// case. This is a SYNTHETIC and is the reference on purpose: the one real
// over-the-horizon recording this bench had has been withdrawn from the shelf
// on licence grounds, so no number in the pulsed cases below comes from field
// material. The repetition rates used, 10 to 50 Hz at 12% duty, are the range
// such emitters are documented to run at.
function othRadar(seconds, { rate = SR, prf = 10, duty = 0.12, amp = 1.5, f0 = 500, f1 = 3200 } = {}) {
  const n = Math.round(seconds * rate), x = new Float64Array(n);
  const period = rate / prf, on = Math.round(period * duty);
  for (let i = 0; i < n; i++) {
    const k = i % period;
    if (k >= on) continue;
    const u = k / on;
    const env = Math.min(1, u * 20) * Math.min(1, (1 - u) * 20);
    const t = k / rate, T = on / rate;
    x[i] = amp * env * Math.cos(2 * Math.PI * (f0 * t + ((f1 - f0) * t * t) / (2 * T)));
  }
  return x;
}

const mix = (a, b) => { const y = Float64Array.from(a); for (let i = 0; i < Math.min(y.length, b.length); i++) y[i] += b[i]; return y; };

// The band that carries a transmission, which is what a classifier is meant to
// be handed: segment() says `classifyOn: 'emissions'` and this obeys it.
function strongest(result) {
  assert.equal(result.classifyOn, 'emissions', 'segment() named a different list as authoritative');
  return result.emissions.filter((d) => !d.aboveContentEdge).sort((a, b) => b.cells - a.cells)[0] || null;
}

export const NAME = 'sigint segmentation and classification';

export const cases = [
  async function noiseAloneProducesNoDetections() {
    // The whole module is here for this. A window between two transmissions is
    // noise, and a detector that splits it is worse than no detector. Four
    // backgrounds, because a refusal that holds only for the white Gaussian
    // case is a refusal that holds for no recording anyone has.
    for (const [name, gen] of BACKGROUNDS) {
      for (let seed = 1; seed <= 6; seed++) {
        const r = segment(gen(SR * 20, seed), SR);
        assert.equal(r.components.length, 0, `${name} seed ${seed} invented ${r.components.length} components`);
        assert.equal(r.emissions.length, 0, `${name} seed ${seed} invented ${r.emissions.length} emissions`);
        assert.equal(r.standingBands.length, 0, `${name} seed ${seed} invented a standing band`);
      }
    }
    // Only the crashes are allowed to say something is here at all: they ARE
    // events, they are simply not transmissions, and the module's own click
    // case pins the same distinction.
    for (const [name, gen] of BACKGROUNDS.slice(0, 3)) {
      for (let seed = 1; seed <= 6; seed++) {
        const r = segment(gen(SR * 20, seed), SR);
        assert.equal(r.present, false, `${name} seed ${seed}: ${r.reason}`);
        assert.match(r.reason, /noise alone/);
        // Both statistics, not just the OR of them.
        assert.ok(r.presence.cellCount < r.presence.cellCritical,
          `${name} seed ${seed}: ${r.presence.cellCount} cells over threshold, critical ${r.presence.cellCritical}`);
        assert.ok(r.presence.lineMax < r.presence.lineCritical,
          `${name} seed ${seed}: line ${r.presence.lineMax.toFixed(4)} over critical ${r.presence.lineCritical.toFixed(4)}`);
      }
    }
  },

  async function theNullHoldsOnAColouredAndMovingBackground() {
    // The refusal above is only worth anything if the distribution it rests on
    // is actually the distribution. Every threshold in the module is a
    // statement about power / (per-bin floor * frame gain) being Exp(1), so
    // that is what is measured here directly: its mean must be 1, and the 1%
    // grow mask must pass 1% of cells.
    //
    // This is the case that catches the two bugs the refusal test could not.
    // Before the running median was made symmetric, 1/f read a mean of 1.00 in
    // mid band and a floor 6.5 dB low at the bottom of it; before the per-bin
    // median was re-taken on gain-normalised power, the fading background read
    // a mean of 1.50 and a grow rate of 5.3%.
    const growThreshold = -Math.log(GROW_CELL_RATE);
    for (const [name, gen] of BACKGROUNDS) {
      for (let seed = 1; seed <= 3; seed++) {
        const x = gen(SR * 20, seed);
        const spec = spectrogram(x, SR);
        const fl = noiseFloor(spec);
        const band = analysisBand(spec, fl, {});
        let sum = 0, n = 0, grow = 0;
        for (let t = 0; t < spec.frames; t++) {
          const row = t * spec.bins, g = fl.gain[t];
          for (let b = band.binLo; b <= band.binHi; b++) {
            const e = spec.power[row + b] / (fl.floor[b] * g);
            sum += e; n += 1;
            if (e > growThreshold) grow += 1;
          }
        }
        const mean = sum / n, rate = grow / n;
        // The crashes really do add power — 13% of it — and the mean is
        // allowed to say so. What must not happen is the 1% mask opening up.
        const meanCap = name === 'white with atmospheric crashes' ? 1.25 : 1.06;
        assert.ok(mean > 0.94 && mean < meanCap,
          `${name} seed ${seed}: mean normalised cell power ${mean.toFixed(3)}, want 1`);
        assert.ok(rate < 0.035, `${name} seed ${seed}: grow mask passed ${(100 * rate).toFixed(2)}% of cells, designed for 1%`);
      }
    }
    // And the fade is seen rather than absorbed silently.
    const faded = segment(fadingNoise(SR * 20, 5), SR);
    assert.equal(faded.floor.nonStationary, true);
    assert.ok(faded.floor.gainRangeDb > 15, `frame gain spread ${faded.floor.gainRangeDb.toFixed(1)} dB on a 0.95-depth fade`);
    assert.ok(faded.warnings.some((w) => /background level moved/.test(w)), faded.warnings.join(' | '));
    // A still background must not raise the same flag.
    const still = segment(noise(SR * 20, 5), SR);
    assert.equal(still.floor.nonStationary, false);
    assert.ok(still.floor.gainRangeDb < 1.5, `frame gain spread ${still.floor.gainRangeDb.toFixed(2)} dB on stationary noise`);
  },

  async function theThresholdComesFromTheNullAndNotFromTheData() {
    // Seed threshold = ln(N / expected false cells), so the expected count of
    // cells above it is exactly EXPECTED_FALSE_CELLS whatever the recording is.
    const r = segment(noise(SR * 20, 11), SR);
    const { cells, seedThreshold, cellCritical } = r.presence;
    assert.ok(Math.abs(seedThreshold - Math.log(cells / EXPECTED_FALSE_CELLS)) < 1e-9);
    assert.ok(Math.abs(cells * Math.exp(-seedThreshold) - EXPECTED_FALSE_CELLS) < 1e-6);
    // Poisson(1) upper tail at 1e-3 is 6: P(K>=6) = 5.9e-4, P(K>=5) = 3.7e-3.
    assert.equal(poissonCritical(1, 1e-3), 6);
    assert.equal(cellCritical, 6);
    // And the threshold moves with the size of the plane, not with the signal.
    const wide = segment(noise(SR * 40, 12), SR);
    assert.ok(wide.presence.seedThreshold > seedThreshold);
  },

  async function theChernoffBoundIsABoundAndItsInverseInvertsIt() {
    // ln P(Gamma(k,1) >= s) <= -k(r - 1 - ln r). At or below the mean it must
    // return probability 1 rather than something optimistic.
    assert.equal(gammaTailLog(100, 100), 0);
    assert.equal(gammaTailLog(100, 50), 0);
    assert.ok(gammaTailLog(100, 200) < -25);
    for (const k of [16, 512, 9000]) {
      for (const target of [3, 12, 30]) {
        const x = gammaMeanThreshold(k, target);
        assert.ok(x > 1, `k=${k} target=${target} gave ${x}`);
        // Solving k(x-1-ln x) = target means the tail bound at k*x is -target.
        assert.ok(Math.abs(gammaTailLog(k, k * x) + target) < 1e-6,
          `k=${k} target=${target}: bound ${gammaTailLog(k, k * x)}`);
      }
    }
    // More averaging, a tighter threshold: 9000 cells cannot be 5% high.
    assert.ok(gammaMeanThreshold(9000, 12) < gammaMeanThreshold(512, 12));
  },

  async function oneListIsTheAnswerAndTheObjectSaysWhichOne() {
    // segment() returns two lists and the choice between them changes the
    // verdict, so the object has to say which one is the answer and the other
    // name has to be gone rather than merely deprecated.
    const f = toneKeyed(prbs(500), [1000, 1425], { baud: 45.45, amp: 0.5 });
    for (const seed of [65, 101, 102]) {
      const x = mix(noise(f.x.length, seed), f.x);
      const r = segment(x, SR);
      assert.equal(r.classifyOn, 'emissions');
      assert.equal(r.detections, undefined, 'the ambiguous name must be gone, not aliased');
      assert.ok(Array.isArray(r.components) && Array.isArray(r.emissions));

      // The demonstration. A 425 Hz shift is two components; the emission is
      // both of them. Handed the strongest component alone the classifier
      // calls it a keyed carrier, and it is confident about it.
      const byComponent = r.components.filter((d) => !d.aboveContentEdge).sort((a, b) => b.cells - a.cells)[0];
      const byEmission = strongest(r);
      assert.equal(r.components.length, 2, `seed ${seed}: expected the two tones as two components`);
      assert.equal(r.emissions.length, 1, `seed ${seed}: expected one emission`);
      assert.equal(classifySegment(x, SR, byComponent).verdict, 'ook-morse',
        `seed ${seed}: the wrong list is supposed to give the wrong answer, or this case has stopped demonstrating anything`);
      const right = classifySegment(x, SR, byEmission);
      assert.equal(right.verdict, 'fsk2', `seed ${seed}: ${right.why}`);
      assert.ok(Math.abs(right.features.ifShiftHz - 425) < 45, `shift read ${right.features.ifShiftHz.toFixed(0)} Hz, sent 425`);
      // The emission still carries the parts, so a caller that wants to argue
      // with the boundary can.
      assert.equal(byEmission.parts, 2);
      assert.equal(byEmission.subBands.length, 2);
    }
  },

  async function aToneIsBoundedInTimeAndInFrequency() {
    const x = addTone(noise(SR * 30, 21), 1500, 0.15, 10, 12);
    const r = segment(x, SR);
    assert.equal(r.present, true);
    assert.equal(r.emissions.length, 1, `expected one emission, got ${r.emissions.length}`);
    const d = r.emissions[0];
    assert.ok(Math.abs(d.startSec - 10) < 0.5, `start ${d.startSec.toFixed(2)}`);
    assert.ok(Math.abs(d.endSec - 12) < 0.5, `end ${d.endSec.toFixed(2)}`);
    assert.ok(d.lowHz <= 1500 && d.highHz >= 1500, `band ${d.lowHz}-${d.highHz}`);
    assert.ok(d.bandwidthHz < 400, `a tone should not read 400 Hz wide, got ${d.bandwidthHz}`);
    assert.ok(d.peakSnrDb > 15, `peak ${d.peakSnrDb.toFixed(1)} dB`);
    assert.ok(d.falseAlarmLog10 < -50, `log10 p ${d.falseAlarmLog10.toFixed(1)}`);
    assert.equal(d.aboveContentEdge, false);
    assert.equal(d.fullBand, false);
    assert.equal(d.selfFloored, false);
  },

  async function confidenceIsCappedByWhateverElseWouldExplainIt() {
    // Three mutants used to survive this whole file, and the plainest of them
    // was `confidence: 1`. It survived because the report cut throws away
    // anything with a false-alarm bound above alpha = 1e-3, so every surviving
    // detection had confidence >= 0.999 by construction and the number carried
    // no information at all. It now goes DOWN when a named alternative
    // explanation is live, and each case below pins one of them.

    // Clean: a strong short tone in a still background. Nothing else explains
    // it, so nothing caps it and there is nothing to say.
    {
      const d = segment(addTone(noise(SR * 30, 21), 1500, 0.15, 10, 12), SR).emissions[0];
      assert.ok(d.confidence > 0.999, `a clean tone should be confident, got ${d.confidence}`);
      assert.deepEqual(d.confidenceNotes, [], `nothing should have capped this: ${d.confidenceNotes.join(' | ')}`);
    }

    // LOW, one: the whole analysed band at once. A band-wide level change
    // explains that as well as an emitter does, so it may not claim more than
    // the cap however small its false-alarm bound is.
    {
      const p = pulsedWide(12, { prf: 50, duty: 0.15, amp: 2.5 });
      const x = mix(noise(p.x.length, 27), p.x);
      const r = segment(x, SR, { binHz: 250, bridgeSec: 0.03, minDurationSec: 0.05 });
      const d = strongest(r);
      assert.equal(d.fullBand, true, `bandwidth ${d.bandwidthHz.toFixed(0)} Hz should span the analysed band`);
      assert.equal(d.confidence, CONFIDENCE_CAP_FULL_BAND,
        `a full-band detection must read exactly the cap, got ${d.confidence}`);
      assert.ok(d.falseAlarmLog10 < -100, 'and the raw bound really is tiny, which is the point');
      assert.ok(d.confidenceNotes.some((n) => /analysed band/.test(n)), d.confidenceNotes.join(' | '));
      assert.ok(r.warnings.some((w) => /whole analysed band/.test(w)), r.warnings.join(' | '));
    }

    // LOW, two: a carrier that is on for the whole window sets its own bin's
    // median, so the level it stands over came from its neighbours and it may
    // not claim better than that cap. Measured: a 30 s carrier at amplitude
    // 0.05 reads 16.2 dB and 0.7, at 0.3 reads 31.8 dB and 0.7, at 1.0 reads
    // 42.3 dB and 0.7. The level goes up; the confidence does not.
    {
      const x = addTone(noise(SR * 30, 22), 1500, 0.05, 0, 30);
      const d = segment(x, SR).emissions.find((q) => q.lowHz <= 1500 && q.highHz >= 1500);
      assert.equal(d.floorFromNeighbours, true);
      assert.ok(d.snrDb > 12, `this one is meant to be strong; ${d.snrDb.toFixed(1)} dB is not`);
      assert.equal(d.confidence, CONFIDENCE_CAP_FLOOR_FROM_NEIGHBOURS, `got ${d.confidence}`);
      assert.ok(d.confidenceNotes.some((n) => /adjacent bins/.test(n)), d.confidenceNotes.join(' | '));
    }

    // LOW, three: a background that moved. Every level in the window is taken
    // against a floor that was itself following something.
    {
      const x = mix(fadingNoise(SR * 30, 31), (() => {
        const t = new Float64Array(SR * 30);
        return addTone(t, 1500, 0.6, 8, 14);
      })());
      const r = segment(x, SR);
      assert.equal(r.floor.nonStationary, true);
      const d = strongest(r);
      assert.ok(d, 'a 0.6-amplitude tone inside a fade is still a detection');
      assert.ok(d.confidence <= CONFIDENCE_CAP_NONSTATIONARY + 1e-12,
        `a moving background caps confidence at ${CONFIDENCE_CAP_NONSTATIONARY}, got ${d.confidence}`);
      assert.ok(d.confidenceNotes.some((n) => /background level moved/.test(n)), d.confidenceNotes.join(' | '));
    }

    // WITHHELD: no number at all where none is measurable. Covered in full by
    // aBandThatSetItsOwnFloorIsReportedRatherThanMeasured; pinned here too
    // because this is the case the mutant made a confident 1.0000.
    {
      const n = SR * 20;
      const x = mix(noise(n, 91, 0.05), bandEmitter(n, 92, { lowHz: 600, highHz: 1400, gainDb: 30 }));
      for (let i = 0; i < n; i++) x[i] += 2.0 * Math.cos((2 * Math.PI * 1000 * i) / SR);
      const d = segment(x, SR).emissions[0];
      assert.equal(d.selfFloored, true);
      assert.equal(d.confidence, null, `withheld means null, got ${d.confidence}`);
    }
  },

  async function theErrorBarOnSnrSurvivesItsOwnSplitHalf() {
    // The standard the whole file is written to: a number that carries an
    // uncertainty has to agree with itself when the window is cut in two and
    // each half is measured separately. Twenty-four seconds of a continuous
    // tone, measured over the first twelve and the second twelve, must agree
    // inside the two bars added in quadrature.
    //
    // This fails outright without the widening in SNR_SE_INFLATION: the
    // blocked spread alone puts 77% of pairs inside two standard errors where
    // 95% is wanted, and the failures are in the tail rather than the middle.
    for (const amp of [0.06, 0.15, 0.4]) {
      let pairs = 0, inside = 0, worst = 0;
      for (let seed = 300; seed < 324; seed++) {
        const x = addTone(noise(SR * 24, seed), 1500, amp, 0, 24);
        const h = x.length >> 1;
        const at = (part) => segment(part, SR).emissions.find((d) => d.lowHz <= 1500 && d.highHz >= 1500);
        const a = at(x.subarray(0, h)), b = at(x.subarray(h));
        if (!a || !b || a.snrDbSe == null || b.snrDbSe == null) continue;
        const z = Math.abs(a.snrDb - b.snrDb) / Math.hypot(a.snrDbSe, b.snrDbSe);
        pairs += 1;
        if (z <= 2) inside += 1;
        if (z > worst) worst = z;
        // Both halves must actually be measuring the same thing, or the check
        // above would be passing on a bar that is simply enormous.
        assert.ok(a.snrDbSe < 3 && b.snrDbSe < 3, `amp ${amp} seed ${seed}: bar ${a.snrDbSe.toFixed(2)}/${b.snrDbSe.toFixed(2)} dB is not a measurement`);
      }
      assert.ok(pairs >= 20, `amp ${amp}: only ${pairs} usable pairs`);
      assert.ok(inside / pairs >= 0.9,
        `amp ${amp}: the halves agreed inside 2 SE in ${inside} of ${pairs}; worst z ${worst.toFixed(2)}`);
    }
    // And the bar is attached to the number rather than being an option.
    const d = segment(addTone(noise(SR * 30, 21), 1500, 0.15, 10, 12), SR).emissions[0];
    assert.ok(Number.isFinite(d.snrDbSe) && d.snrDbSe > 0, `snrDbSe ${d.snrDbSe}`);
    assert.ok(d.snrBlocks >= 3, `${d.snrBlocks} blocks is too few for a spread`);
  },

  async function aBandThatSetItsOwnFloorIsReportedRatherThanMeasured() {
    // The module's floors are medians, so a continuous emitter wider than the
    // 65-bin smoothing window becomes the floor it would have to stand above.
    // Measured before this guard, on band-limited Gaussian noise 35 dB over
    // the true floor: 600-3000 Hz and 400-3600 Hz came back present = false
    // with the reason "consistent with noise alone", and a 600-1400 Hz band
    // came back as one detection at 484-656 Hz — the emitter's own skirt —
    // reported as snrDb -4.8 dB with confidence 1.0000.
    const n = SR * 20;
    for (const [lowHz, highHz, wantStepDb] of [[600, 1400, 40], [600, 3000, 34]]) {
      const x = mix(noise(n, 91, 0.05), bandEmitter(n, 92, { lowHz, highHz, gainDb: 35 }));
      const r = segment(x, SR);
      assert.equal(r.standingBands.length, 1, `${lowHz}-${highHz}: ${r.standingBands.length} standing bands`);
      const s = r.standingBands[0];
      assert.ok(Math.abs(s.lowHz - lowHz) < 120 && Math.abs(s.highHz - highHz) < 120,
        `read ${s.lowHz.toFixed(0)}-${s.highHz.toFixed(0)} Hz, built ${lowHz}-${highHz}`);
      assert.ok(s.stepDb > wantStepDb, `step ${s.stepDb.toFixed(1)} dB`);
      // A 35 dB emitter may not be called noise, whatever the two presence
      // statistics did.
      assert.equal(r.present, true, r.reason);
      assert.match(r.reason, /stands\b/);
      assert.ok(r.warnings.some((w) => /same observation/.test(w)), r.warnings.join(' | '));
    }

    // A real signal inside such a band keeps its bounds and loses its level.
    {
      const x = mix(noise(n, 91, 0.05), bandEmitter(n, 92, { lowHz: 600, highHz: 1400, gainDb: 30 }));
      for (let i = 0; i < n; i++) x[i] += 2.0 * Math.cos((2 * Math.PI * 1000 * i) / SR);
      const d = segment(x, SR).emissions[0];
      assert.ok(d.lowHz <= 1000 && d.highHz >= 1000, `band ${d.lowHz.toFixed(0)}-${d.highHz.toFixed(0)}`);
      assert.equal(d.selfFloored, true);
      assert.equal(d.snrDb, null, 'no signal-to-noise number, because there is no noise to measure against');
      assert.equal(d.peakSnrDb, null);
      assert.equal(d.confidence, null);
      assert.equal(d.falseAlarmLog10, null);
      // The number that IS measurable is reported under a name that says what
      // it is measured against.
      assert.ok(d.snrOverStandingFloorDb > 5, `over the standing floor: ${d.snrOverStandingFloorDb}`);
    }

    // The limit, stated as a test so it cannot be forgotten: a band wider than
    // FULL_BAND_FRACTION of the spectrum is not reported as standing, because
    // at that width it is the spectrum. 400-3600 Hz of a 0-4000 Hz analysis is
    // 80% and falls outside.
    {
      const x = mix(noise(n, 91, 0.05), bandEmitter(n, 92, { lowHz: 400, highHz: 3600, gainDb: 35 }));
      assert.equal(segment(x, SR).standingBands.length, 0);
      assert.ok(FULL_BAND_FRACTION < 0.85);
    }

    // And it does not fire on any background. This is the direction that
    // matters: a standing-band report is a strong claim.
    for (const [name, gen] of BACKGROUNDS) {
      for (let seed = 1; seed <= 6; seed++) {
        const spec = spectrogram(gen(SR * 20, seed), SR);
        const fl = noiseFloor(spec);
        const band = analysisBand(spec, fl, {});
        assert.equal(standingBands(spec, fl.floor, { binLo: band.binLo, binHi: spec.bins - 1 }).length, 0,
          `${name} seed ${seed} produced a standing band`);
      }
    }
    assert.equal(STANDING_STEP_DB, 12);
  },

  async function aCarrierTooWeakForAnyOneCellIsStillFoundByTheLineTest() {
    // The two statistics fail on opposite signals, which is why there are two.
    // A continuous carrier a fraction of a decibel over the floor lights no
    // cell and still moves the time-averaged spectrum of its own bin.
    const x = addTone(noise(SR * 30, 22), 1500, 0.006, 0, 30);
    const r = segment(x, SR);
    assert.equal(r.present, true, r.reason);
    assert.equal(r.presence.byLine, true, 'the line test should carry this one');
    assert.ok(Math.abs(r.presence.lineHz - 1500) < 40, `line at ${r.presence.lineHz.toFixed(0)} Hz`);
    const d = r.emissions.find((q) => q.lowHz <= 1500 && q.highHz >= 1500);
    assert.ok(d, 'no detection at the carrier');
    assert.ok(d.snrDb < 6, `this carrier is meant to be weak; ${d.snrDb.toFixed(1)} dB is not`);
    assert.ok(d.durationSec > 25, `a continuous carrier should span the window, got ${d.durationSec.toFixed(1)} s`);
    assert.match(d.evidence, /line/, 'the line test is what put this one here');
  },

  async function aFadeIsBridgedButASilenceIsNot() {
    const gapped = (gapSec) => {
      const x = noise(SR * 20, 23);
      addTone(x, 1200, 0.2, 4, 9);
      addTone(x, 1200, 0.2, 9 + gapSec, 14 + gapSec);
      return segment(x, SR, { bridgeSec: 0.3 }).components.filter((d) => d.lowHz <= 1200 && d.highHz >= 1200);
    };
    const bridged = gapped(0.15);
    assert.equal(bridged.length, 1, `a 0.15 s fade should not shatter a detection, got ${bridged.length}`);
    const split = gapped(2);
    assert.equal(split.length, 2, `a 2 s silence is two transmissions, got ${split.length}`);
  },

  async function theBridgeWillNotManufactureDurationOutOfCrashes() {
    // A crash is shorter than the analysis window, so the window hands it a
    // duration whatever the crash did. Two crashes a fifth of a second apart
    // then get stitched into one 0.4 s "transmission" by the same hysteresis
    // that exists to survive a fade. Measured over 90 windows of white noise
    // carrying crashes at three severities: the plain gap rule manufactured 50
    // detections, and the rule below manufactures none.
    let made = 0;
    for (let seed = 1; seed <= 10; seed++) {
      for (const [count, gain] of [[40, 30], [12, 20], [80, 15]]) {
        made += segment(impulsiveNoise(SR * 20, seed * 7919 + count, { count, gain }), SR).components.length;
      }
    }
    // Seeds 24 and 25 are the two of the first hundred that got past every
    // other guard in the module; they are named so the last one cannot be
    // removed without this failing. Their components carried 0.45 and 0.65 of
    // their cells in frames when the whole band jumped at once.
    for (const seed of [24, 25]) {
      made += segment(impulsiveNoise(SR * 20, seed), SR).components.length;
    }
    assert.equal(made, 0, `${made} detections manufactured out of crashes`);

    // And a real burst in the SAME crash-ridden background is still found, at
    // four lengths, or the guard above would just be deafness.
    for (const [amp, dur, wantSnr] of [[0.4, 0.4, 25], [0.25, 0.8, 24], [0.15, 2.0, 20], [0.08, 5.0, 15]]) {
      const x = impulsiveNoise(SR * 20, 5);
      addTone(x, 1500, amp, 8, 8 + dur);
      const d = segment(x, SR).components.find((q) => q.lowHz <= 1500 && q.highHz >= 1500);
      assert.ok(d, `a ${dur} s burst at amplitude ${amp} was lost among the crashes`);
      assert.ok(Math.abs(d.durationSec - dur) < 0.25, `${dur} s burst bounded as ${d.durationSec.toFixed(2)} s`);
      assert.ok(d.snrDb > wantSnr, `${dur} s burst read ${d.snrDb.toFixed(1)} dB`);
    }

    // And the rule that does it must not also throw away a pulse train, whose
    // runs are always shorter than its own gaps. This is what the recurrence
    // exception is for: a gap that keeps coming back at the same length is a
    // duty cycle.
    const p = pulsedWide(12, { prf: 50, duty: 0.15, amp: 2.5 });
    const kept = segment(mix(noise(p.x.length, 67), p.x), SR, { binHz: 250, bridgeSec: 0.03, minDurationSec: 0.05 });
    const d = strongest(kept);
    assert.ok(d, 'the pulse train must survive the rule that rejects the crashes');
    assert.ok(d.durationSec > 10, `the train should read as one long emission, got ${d.durationSec.toFixed(2)} s`);
  },

  async function aClickIsTooShortToBeATransmission() {
    const x = noise(SR * 20, 24);
    addTone(x, 1800, 1.2, 10, 10.01);            // 10 ms, very loud
    const r = segment(x, SR, { minDurationSec: 0.15 });
    assert.equal(r.present, true, 'a loud click is certainly not noise');
    assert.equal(r.components.length, 0, 'but it is not a transmission either');
    // The stated cost of that: the analysis window is itself 64 ms long, so
    // nothing shorter than minDurationSec PLUS the window can be claimed, and
    // at the defaults the shortest reportable event is 0.26 s.
    const bounded = segment(addTone(noise(SR * 20, 24), 1800, 0.5, 10, 10.4), SR);
    assert.equal(bounded.components.length, 1, 'a 0.4 s burst is still bounded');
  },

  async function theCodecCliffAndTheContentEdgeAreDifferentEdges() {
    // A receiver's own noise stops at its audio bandwidth; a codec's coded
    // band stops higher, and between the two lies a plateau where any ratio is
    // the encoder rather than the air.
    const n = SR * 20;
    const wide = noise(n, 25, 0.05);              // full-band "receiver" noise
    const x = new Float64Array(n);
    // Crude 1.5 kHz low-pass, then a floor 45 dB down above it standing in for
    // an encoder's residue, and nothing at all above 3 kHz.
    let acc = 0;
    const residue = noise(n, 26, 0.05 * Math.pow(10, -45 / 20));
    for (let i = 0; i < n; i++) { acc += (wide[i] - acc) / 3; x[i] = acc + residue[i]; }
    const spec = spectrogram(x, SR);
    const fl = noiseFloor(spec);
    assert.ok(fl.contentEdgeHz < fl.cutoffHz + 1, 'the content edge is at or below the codec cutoff');
    assert.ok(fl.contentEdgeHz > 700 && fl.contentEdgeHz < 2600,
      `content edge ${fl.contentEdgeHz.toFixed(0)} Hz, expected near the 1.5 kHz roll-off`);
    // A codec cliff is a fall with no rise to pair with, so it is not a
    // standing band however large the step is.
    assert.equal(segment(x, SR).standingBands.length, 0);
  },

  async function aPulsedEmitterHidesInsideALongFrameAndTheWarningSaysSo() {
    // Both floors are medians, so a wideband emitter on in every frame becomes
    // the floor. The fix is a shorter frame; the safeguard is that kurtosis is
    // computed on samples and has no frame to be fooled by.
    const p = pulsedWide(15, { prf: 50, duty: 0.15, amp: 2.5 });
    const x = mix(noise(p.x.length, 27), p.x);
    const long = segment(x, SR, { binHz: 20 });
    assert.equal(long.components.length, 0, 'this is the documented blind spot, not a passing case');
    assert.ok(long.impulse.z > 100, `kurtosis z ${long.impulse.z.toFixed(0)} should be far off Gaussian`);
    assert.ok(long.warnings.some((w) => /impulsive/.test(w)), `warnings: ${long.warnings.join(' | ')}`);
    // Pure Gaussian noise must not raise the same flag.
    assert.ok(Math.abs(impulsiveness(noise(SR * 15, 28)).z) < 10);
    // And at a frame shorter than the pulse spacing it is one clean detection.
    const short = segment(x, SR, { binHz: 250, bridgeSec: 0.03, minDurationSec: 0.05 });
    assert.ok(short.components.length >= 1, 'a 8 ms frame should find it');
    const d = short.components.sort((a, b) => b.cells - a.cells)[0];
    assert.ok(d.bandwidthHz > 1500, `pulsed wideband, got ${d.bandwidthHz.toFixed(0)} Hz`);
  },

  async function emissionsMergeTheTwoTonesOfAKeyedPair() {
    // Two components overlapping in time and 400 Hz apart are one transmission.
    const parts = [
      { startSec: 1, endSec: 5, lowHz: 780, highHz: 830, cells: 40, boxCells: 60, snrDb: 12, peakSnrDb: 18, falseAlarmLog10: -80, confidence: 1, confidenceNotes: [], evidence: 'cells', dutyCycle: 0.4 },
      { startSec: 1.1, endSec: 5.1, lowHz: 1180, highHz: 1230, cells: 44, boxCells: 60, snrDb: 13, peakSnrDb: 19, falseAlarmLog10: -90, confidence: 1, confidenceNotes: [], evidence: 'cells', dutyCycle: 0.6 },
      { startSec: 40, endSec: 44, lowHz: 800, highHz: 830, cells: 30, boxCells: 60, snrDb: 9, peakSnrDb: 15, falseAlarmLog10: -40, confidence: 1, confidenceNotes: [], evidence: 'cells', dutyCycle: 0.5 },
    ];
    const merged = mergeEmissions(parts);
    assert.equal(merged.length, 2, 'the overlapping pair is one emission, the later burst another');
    assert.equal(merged[0].parts, 2);
    assert.ok(Math.abs(merged[0].lowHz - 780) < 1e-9 && Math.abs(merged[0].highHz - 1230) < 1e-9);
    assert.equal(merged[0].subBands.length, 2, 'the two tones are still separately available');
    // A gap wider than mergeGapHz keeps them apart.
    assert.equal(mergeEmissions(parts, { mergeGapHz: 100 }).length, 3);

    // A withheld level must propagate rather than being quietly maximised
    // against a number. Math.max(null, 12) is 12, which is exactly how a level
    // that was refused becomes a level that was reported.
    const withOne = mergeEmissions([
      { ...parts[0], snrDb: null, peakSnrDb: null, confidence: null, falseAlarmLog10: null, selfFloored: true },
      parts[1],
    ]);
    assert.equal(withOne.length, 1);
    assert.equal(withOne[0].snrDb, null);
    assert.equal(withOne[0].peakSnrDb, null);
    assert.equal(withOne[0].confidence, null);
    assert.equal(withOne[0].selfFloored, true);
    // And an emission is no better founded than its least settled part.
    const capped = mergeEmissions([{ ...parts[0], confidence: 0.3 }, { ...parts[1], confidence: 1 }]);
    assert.equal(capped[0].confidence, 0.3);
  },

  async function modesFindsStatesThatSitAtTheEdgesOfTheirOwnRange() {
    // Regression. The histogram range was the 1st to 99th percentile and the
    // peak scan skipped the end bins, so a two-state distribution — which by
    // definition lives at the extremes — reported no modes at all, and a
    // 200 Hz two-tone shift was ranked as multi-tone keying.
    const v = new Float64Array(4000);
    for (let i = 0; i < v.length; i++) v[i] = (i % 2 ? 1000 : 1200) + Math.sin(i) * 2;
    const m = modes(v);
    assert.equal(m.modeCount, 2, `expected two modes, got ${m.modeCount}`);
    assert.ok(m.valleyDepth > 0.9, `valley ${m.valleyDepth.toFixed(2)}`);
    assert.ok(Math.abs(m.separation - 200) < 20, `separation ${m.separation.toFixed(1)} Hz`);
    // A single population has no valley. Its smoothed histogram can still
    // carry a second bump in a tail, which is why the valley depth and not the
    // mode count is what the predicates use.
    const one = modes(noise(20000, 31, 1));
    assert.ok(one.valleyDepth < 0.2, `one population gave a valley of ${one.valleyDepth.toFixed(2)}`);
  },

  async function gapFractionSeparatesAKeyedEnvelopeFromAContinuousOne() {
    // The middle third of the 5th-to-95th-percentile range of a Rayleigh
    // envelope holds 0.359 of it by construction. A two-state envelope crosses
    // that middle only during transitions.
    const rayleigh = new Float64Array(20000);
    const r = rng(41);
    for (let i = 0; i < rayleigh.length; i++) {
      const a = Math.sqrt(-2 * Math.log(r())), b = 2 * Math.PI * r();
      rayleigh[i] = 20 * Math.log10(Math.hypot(a * Math.cos(b), a * Math.sin(b)));
    }
    const cont = gapFraction(rayleigh);
    assert.ok(Math.abs(cont.fraction - 0.359) < 0.05, `noise gave ${cont.fraction.toFixed(3)}, theory says 0.359`);
    const keyed = new Float64Array(20000);
    for (let i = 0; i < keyed.length; i++) keyed[i] = (i % 800 < 400 ? 0 : -30) + Math.sin(i) * 0.5;
    const k = gapFraction(keyed);
    assert.ok(k.fraction < 0.05, `a keyed envelope gave ${k.fraction.toFixed(3)}`);
    assert.ok(Math.abs(k.spanDb - 30) < 2, `span ${k.spanDb.toFixed(1)} dB`);
  },

  async function gridFitSurvivesTheSidebandsThatDefeatConsecutiveDifferences() {
    // Eight tones 100 Hz apart, each with a keying sideband 10 Hz either side.
    // Consecutive differences are then a mix of 10 and 90 and report a spacing
    // of 10; the vote finds the 100 Hz set the tones actually lie on.
    const hz = [];
    for (let k = 0; k < 8; k++) { hz.push(900 + k * 100 - 10, 900 + k * 100, 900 + k * 100 + 10); }
    const g = gridFit(hz);
    assert.ok(Math.abs(g.spacingHz - 100) < 6, `spacing ${g.spacingHz}`);
    assert.ok(g.fitCount >= 8, `only ${g.fitCount} of ${hz.length} lines on the grid`);
    assert.ok(g.z > 4, `grid z ${g.z.toFixed(1)} is within what the search finds by chance`);
    // Scattered lines must not produce a confident grid.
    const rr = rng(51);
    const scattered = Array.from({ length: 12 }, () => 400 + rr() * 3000).sort((a, b) => a - b);
    assert.ok(gridFit(scattered).z < 4, 'a chance fit must not read as a tone set');
  },

  async function periodicityRefusesAModulationTooShallowToHear() {
    // A steady tone's envelope has almost no structure, so its median floor is
    // almost zero and a 0.3% residue reads as many times the floor. Regression:
    // that spurious peak used to contradict the unmodulated-carrier hypothesis.
    const flat = new Float64Array(SR * 2).fill(1);
    for (let i = 0; i < flat.length; i++) flat[i] += 0.001 * Math.cos((2 * Math.PI * 7 * i) / SR);
    assert.equal(periodicity(flat, SR).rateHz, 0, 'a 0.1% wobble is not modulation');
    const real = new Float64Array(SR * 2);
    for (let i = 0; i < real.length; i++) real[i] = 1 + 0.4 * Math.cos((2 * Math.PI * 7 * i) / SR);
    const p = periodicity(real, SR);
    assert.ok(Math.abs(p.rateHz - 7) < 0.5, `rate ${p.rateHz.toFixed(2)} Hz`);
    assert.ok(Math.abs(p.depth - 0.4) < 0.05, `depth ${p.depth.toFixed(3)}, should read the 0.40 it was given`);
    assert.ok(p.syllabicRatio > 3, 'a 7 Hz modulation is in the syllabic band');
  },

  async function noiseIsClassifiedAsNoiseAndNotAsSomething() {
    // Forced past the segmenter, which would not have offered any of these
    // bands at all. All four backgrounds, because the classifier has the same
    // duty of refusal as the segmenter and had only ever been shown one.
    for (const [name, gen] of BACKGROUNDS) {
      const x = gen(SR * 10, 61);
      const c = classifySegment(x, SR, { startSec: 1, endSec: 9, lowHz: 300, highHz: 3000 });
      assert.ok(c.verdict === 'noise' || c.verdict === 'unclear', `${name}: got ${c.verdict}: ${c.why}`);
      for (const h of c.ranked) {
        if (h.id === 'noise' || h.id === 'unclear') continue;
        assert.ok(h.score < 0.6, `${name}: ${h.id} scored ${h.score.toFixed(2)} on a background`);
      }
    }
    const f = classifySegment(noise(SR * 10, 61), SR, { startSec: 1, endSec: 9, lowHz: 300, highHz: 3000 }).features;
    assert.ok(Math.abs(f.envDepth - RAYLEIGH_DEPTH) < 0.06,
      `envelope depth ${f.envDepth.toFixed(3)} against Rayleigh's ${RAYLEIGH_DEPTH}`);
    assert.equal(f.lineCount, 0, 'white noise has no lines');
    assert.ok(f.spectralFlatness > 0.9, `flatness ${f.spectralFlatness.toFixed(3)}`);
    assert.equal(f.envKeyed, false);
  },

  async function aSteadyToneAndAnAmplitudeModulatedToneAreToldApart() {
    {
      const x = addTone(noise(SR * 10, 62), 1200, 0.3, 1, 9);
      const c = classifySegment(x, SR, strongest(segment(x, SR)));
      assert.equal(c.verdict, 'carrier', `${c.verdict}: ${c.why}`);
      assert.ok(c.features.carrierRatio > 0.9, `carrier ratio ${c.features.carrierRatio.toFixed(3)}`);
      assert.equal(c.features.envKeyed, false);
    }
    {
      const x = noise(SR * 10, 63);
      for (let i = 0; i < x.length; i++) {
        x[i] += 0.3 * (1 + 0.6 * Math.cos((2 * Math.PI * 7 * i) / SR)) * Math.cos((2 * Math.PI * 1200 * i) / SR);
      }
      const c = classifySegment(x, SR, strongest(segment(x, SR)));
      assert.equal(c.verdict, 'am-tone', `${c.verdict}: ${c.why}`);
      assert.ok(Math.abs(c.features.envRateHz - 7) < 1, `modulation rate ${c.features.envRateHz.toFixed(2)} Hz`);
      assert.ok(c.features.sidebandSymmetry > 0.6, `symmetry ${c.features.sidebandSymmetry.toFixed(2)}`);
    }
  },

  async function keyedAndShiftedCarriersAreToldApart() {
    {
      const m = morse('CQ DE 123 555', { wpm: 18, amp: 0.5 });
      const x = mix(noise(m.x.length, 64), m.x);
      const c = classifySegment(x, SR, strongest(segment(x, SR)));
      assert.equal(c.verdict, 'ook-morse', `${c.verdict}: ${c.why}`);
      assert.equal(c.features.envKeyed, true);
      assert.ok(c.features.dutyCycle > 0.2 && c.features.dutyCycle < 0.8, `duty ${c.features.dutyCycle.toFixed(2)}`);
      assert.ok(c.features.envSpanDb > 20, `on-to-off span ${c.features.envSpanDb.toFixed(1)} dB`);
    }
    {
      // 200 Hz shift, pseudo-random bits so the keying is not itself a tone.
      const f = toneKeyed(prbs(400), [1000, 1200], { baud: 45.45, amp: 0.5 });
      const x = mix(noise(f.x.length, 65), f.x);
      const c = classifySegment(x, SR, strongest(segment(x, SR)));
      assert.equal(c.verdict, 'fsk2', `${c.verdict}: ${c.why}`);
      assert.equal(c.features.ifStateCount, 2, `${c.features.ifStateCount} frequency states`);
      assert.ok(Math.abs(c.features.ifShiftHz - 200) < 25, `shift read ${c.features.ifShiftHz.toFixed(1)} Hz, sent 200`);
    }
  },

  async function aToneSetAndAPulsedEmitterAreToldApart() {
    {
      const tones = [900, 1000, 1100, 1200, 1300, 1400, 1500, 1600];
      const syms = Array.from({ length: 160 }, (_, i) => (i * 5 + 3) % 8);
      const f = toneKeyed(syms, tones, { baud: 10, amp: 0.5 });
      const x = mix(noise(f.x.length, 66), f.x);
      const c = classifySegment(x, SR, strongest(segment(x, SR)));
      assert.equal(c.verdict, 'mfsk', `${c.verdict}: ${c.why}`);
      assert.ok(Math.abs(c.features.lineSpacingHz - 100) < 12, `tone spacing read ${c.features.lineSpacingHz.toFixed(1)} Hz, sent 100`);
      assert.ok(c.features.lineGridCount >= 6, `${c.features.lineGridCount} tones on the grid, sent 8`);
      assert.ok(c.features.ifStateCount >= 3, 'more than two frequency states');
      // A tone set's envelope is not a train, so the comb veto must not touch it.
      assert.equal(c.features.pulsedEnvelope, false);
    }
    {
      const p = pulsedWide(12, { prf: 50, duty: 0.15, amp: 2.5 });
      const x = mix(noise(p.x.length, 67), p.x);
      const r = segment(x, SR, { binHz: 250, bridgeSec: 0.03, minDurationSec: 0.05 });
      const c = classifySegment(x, SR, strongest(r));
      assert.equal(c.verdict, 'pulsed-wide', `${c.verdict}: ${c.why}`);
      assert.ok(Math.abs(c.features.envRateHz - 50) < 3, `pulse rate read ${c.features.envRateHz.toFixed(1)} Hz, sent 50`);
      assert.ok(c.features.dutyCycle < 0.5, `duty ${c.features.dutyCycle.toFixed(2)}, sent 0.15`);
      assert.ok(c.features.spectralFlatness > 0.5, `flatness ${c.features.spectralFlatness.toFixed(2)}`);
    }
  },

  async function aCoherentPulsedEmitterIsRecognisedAndItsCombIsNotATonesSet() {
    // The class used to hold only for an INCOHERENT burst train. A real
    // over-the-horizon radar repeats the same sweep, which puts a comb in the
    // spectrum instead of a flat band, and the flatness test at weight 2 then
    // half-rejected it while the comb fed the tone-set hypotheses. Measured
    // before the change, handed the emitter's own span: 0.45 at 10 Hz PRF —
    // five hundredths above the score at which nothing is claimed — with mfsk
    // second, and unclear at 25 and 50 Hz where mfsk or data-multicarrier tied
    // or led.
    //
    // The reference below is a synthetic. The one real recording is off the
    // shelf on licence grounds, so nothing here is measured from field
    // material and the class is not claimed to have been checked against any.
    const span = { startSec: 1, endSec: 11, lowHz: 300, highHz: 3600 };
    for (const prf of [10, 25, 50]) {
      const x = mix(noise(SR * 12, 67), othRadar(12, { prf, duty: 0.12 }));
      const c = classifySegment(x, SR, span);
      assert.equal(c.verdict, 'pulsed-wide', `${prf} Hz PRF: ${c.verdict} — ${c.why}`);
      assert.ok(Math.abs(c.features.envRateHz - prf) < 0.5 + 0.02 * prf,
        `${prf} Hz PRF read as ${c.features.envRateHz.toFixed(2)} Hz`);
      assert.ok(c.features.dutyCycle < 0.4, `${prf} Hz PRF duty ${c.features.dutyCycle.toFixed(2)}, sent 0.12`);
      // The comb is recognised as the switching's own, so the tone-set
      // hypotheses lose a test rather than gaining one from it.
      assert.equal(c.features.pulsedEnvelope, true);
      const mfsk = c.ranked.find((h) => h.id === 'mfsk');
      assert.ok(mfsk.against.some((a) => /switched envelope/.test(a.claim)),
        `${prf} Hz PRF: the comb veto should be visible in mfsk's evidence against`);
      const top = c.ranked[0], next = c.ranked[1];
      assert.ok(top.score - next.score > 0.3,
        `${prf} Hz PRF: ${top.id} ${top.score.toFixed(2)} barely beats ${next.id} ${next.score.toFixed(2)}`);
    }
    // What it actually recognises is a switched wideband train, coherent or
    // not, and the flatness evidence says which kind this one was.
    const coherent = classifySegment(mix(noise(SR * 12, 67), othRadar(12, { prf: 25 })), SR, span);
    const pw = coherent.ranked.find((h) => h.id === 'pulsed-wide');
    assert.ok(pw.against.some((a) => /noise-like inside/.test(a.claim)),
      'a repeated sweep is not noise-like inside and the report has to say so');
    const p = pulsedWide(12, { prf: 50, duty: 0.15, amp: 2.5 });
    const incoherent = classifySegment(mix(noise(p.x.length, 67), p.x), SR, span);
    assert.equal(incoherent.verdict, 'pulsed-wide');
    assert.equal(incoherent.ranked.find((h) => h.id === 'pulsed-wide').against.length, 0,
      'an incoherent train holds every test');
  },

  async function cannotTellIsReachableAndSaysWhy() {
    // Nothing measured: no hypothesis may be claimed.
    const empty = classify(null);
    assert.equal(empty.verdict, 'unclear');
    // Both gates, on a signal the classifier is otherwise sure about, so what
    // is being tested is the refusal and not the features.
    const x = addTone(noise(SR * 8, 69), 1300, 0.3, 0.5, 7.5);
    const f = extractFeatures(x, SR, strongest(segment(x, SR)));
    assert.equal(classify(f).verdict, 'carrier');
    const weak = classify(f, { minScore: 1.01 });
    assert.equal(weak.verdict, 'unclear');
    assert.match(weak.why, /scores above/);
    const close = classify(f, { minMargin: 2 });
    assert.equal(close.verdict, 'unclear');
    assert.match(close.why, /within/);
    assert.equal(close.ranked.length, HYPOTHESES.length);
    assert.ok(close.ranked[0].score >= MIN_SCORE, 'the leader is still reported, it is just not claimed');
  },

  async function deepAmplitudeModulationIsReportedAsKeyingAndThatIsAKnownLimit() {
    // Not a passing grade: a pinned failure. A 90% modulated carrier falls
    // 24 dB in its troughs and every level statistic here reads that as
    // switching. modulationTonality is the one feature that still knows the
    // difference, and at three weights it is not enough to win. The test
    // exists so the boundary cannot move without someone noticing.
    const am = (depth, seed) => {
      const x = noise(SR * 10, seed);
      for (let i = 0; i < x.length; i++) {
        x[i] += 0.3 * (1 + depth * Math.cos((2 * Math.PI * 7 * i) / SR)) * Math.cos((2 * Math.PI * 1200 * i) / SR);
      }
      return classifySegment(x, SR, strongest(segment(x, SR)));
    };
    const shallow = am(0.6, 72);
    assert.equal(shallow.verdict, 'am-tone', `60% modulation: ${shallow.verdict}`);
    assert.ok(shallow.features.modulationTonality > 0.85);
    const deep = am(0.95, 73);
    assert.equal(deep.verdict, 'ook-morse', `95% modulation is the known miss; got ${deep.verdict}`);
    assert.ok(deep.features.modulationTonality > 0.85, 'and the evidence against it is measured, not lost');
    const tonal = deep.ranked.find((h) => h.id === 'ook-morse').against.map((a) => a.claim).join(' ');
    assert.match(tonal, /sinusoid/, 'the contradicting evidence must be visible in `against`');
  },

  async function everyHypothesisAccountsForEveryOneOfItsTests() {
    // The output has to be arguable: each test lands in `for`, in `against`, or
    // in `untested` because its feature could not be measured, and nothing is
    // silently dropped. A hypothesis is never rewarded for a missing feature.
    const x = addTone(noise(SR * 8, 68), 1400, 0.3, 0.5, 7.5);
    const c = classifySegment(x, SR, strongest(segment(x, SR)));
    assert.equal(c.ranked.length, HYPOTHESES.length);
    for (const h of c.ranked) {
      const spec = HYPOTHESES.find((q) => q.id === h.id);
      assert.equal(h.for.length + h.against.length + h.untested.length, spec.tests.length, `${h.id} lost a test`);
      const weighed = h.for.concat(h.against).reduce((a, b) => a + b.weight, 0);
      assert.equal(weighed, h.measurable, `${h.id}: measurable weight does not match the tests weighed`);
      assert.ok(h.score >= -1 && h.score <= 1, `${h.id} scored ${h.score}`);
      for (const e of h.for.concat(h.against)) assert.ok(typeof e.claim === 'string' && e.claim.length > 8);
    }
    assert.equal(c.ranked[0].id, 'carrier');
    assert.ok(c.ranked[0].against.length === 0 || c.ranked[0].score < 1);
  },

  async function detectionCostStaysInsideAWindow() {
    // js/dsp/window-load.js offers 120, 300 or 600 seconds. The floor is now
    // two-stage — a rough per-bin median to see the frame gain through, then
    // the calibrated one on gain-normalised power — so the sorting pass is
    // paid twice. The bound here is loose enough to survive a slower machine
    // and tight enough to catch an accidental quadratic.
    const x = noise(SR * 120, 71);
    const t0 = Date.now();
    const r = segment(x, SR);
    const perSec = (Date.now() - t0) / 120;
    assert.ok(perSec < 12, `${perSec.toFixed(2)} ms per window second`);
    assert.equal(r.spec.frames * r.spec.bins < 8e6, true);
    assert.equal(r.spec.decimated, false, 'a 120 s window at 8 kHz should not need decimating');
  },
];
