// Finding signals in a window, and saying what they are, pinned against
// material whose answer is known by construction.
//
// The case this file exists for is the first one. Otsu's method and k-means
// return a split for any input including pure noise, so the only way to know a
// detector is a detector is to give it nothing and require nothing back.
//
// "NOTHING" IS NOT ONE THING, and every refusal in this file used to assume it
// was. The backgrounds below come from test/noise-colours.mjs — white, 1/f,
// Rayleigh fading, atmospheric crashes and a gated band — because a refusal
// measured on flat white Gaussian is a refusal measured on the one spectrum
// under which the analytic nulls these modules derive actually hold, and no HF
// recording has it. Measured over 150 windows per colour before the work this
// file pins, with the classifier handed a band it could not refuse: white was
// answered correctly 150 times out of 150, and 1/f was claimed as speech 17
// times, fading 117 times, crashes as a tone set 105 times, and a gated band
// as a keyed carrier 128 times. None of that was visible while the test used
// one generator.
//
// The three colours whose level is stationary — white, 1/f and fading — must
// produce no detections at all. The two that carry real events must not be
// silent about them: crashes and a gated band ARE events, they are simply not
// transmissions, and what is required there is that the module says so and
// claims no more than its caps allow. Both requirements are asserted below,
// and the second one is the harder of the two to keep honest.
import assert from 'node:assert/strict';

import {
  segment, spectrogram, noiseFloor, analysisBand, standingBands, mergeEmissions, impulsiveness,
  poissonCritical, gammaTailLog, gammaMeanThreshold, EXPECTED_FALSE_CELLS,
  CONFIDENCE_CAP_FULL_BAND, CONFIDENCE_CAP_FLOOR_FROM_NEIGHBOURS, CONFIDENCE_CAP_NONSTATIONARY,
  FULL_BAND_FRACTION, STANDING_STEP_DB, GROW_CELL_RATE,
  FLASH_SHARE, FLASH_EXCESS, FLASH_BIN_SHARE, SNR_SE_INFLATION, IMPULSIVE_Z,
  DEFAULT_MIN_DURATION_SEC, DEAD_BAND_DB, EDGE_STEP_DB } from '../js/sigint/segment.js';
import {
  extractFeatures, classify, classifySegment, modes, gridFit, gapFraction, periodicity,
  HYPOTHESES, MIN_SCORE, RAYLEIGH_DEPTH, LOCAL_BLOCK_SEC,
} from '../js/sigint/classify.js';
import { firBandpass, firLowpass, filter } from '../js/dsp/analytic.js';
import { COLOURS, describe, white, pink } from './noise-colours.mjs';

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
 * Five backgrounds, none of which is a signal.
 * ------------------------------------------------------------------ */

// From test/noise-colours.mjs, which is shared with the other SIGINT case
// files and checks each generator against the property it exists to have. The
// point of sharing it is that a construction bug in "pink" that quietly made
// it white would otherwise pass in every file at once and be visible in none.
const BACKGROUNDS = Object.entries(COLOURS).map(([name, gen]) => [name, (n, seed) => gen(n, { seed })]);
// The three whose LEVEL is stationary. These must produce nothing at all.
const STATIONARY = ['white', 'pink', 'faded'];
// The two that carry real events. A crash and a gated band are not
// transmissions, but they are not nothing either, and the requirement on them
// is different: see noiseAloneProducesNoDetections.
const EVENTFUL = ['impulsive', 'bursty'];

// Two local generators survive the move to the shared module, because two
// cases need a specific shape rather than a colour.
//
// The fade here is a DETERMINISTIC 0.4 Hz cosine of depth 0.95, not the shared
// Rayleigh one: the confidence and flash-guard cases below need a fade whose
// depth and rate are known exactly, so that a carrier's recall can be read
// against a stated fade rather than against a random envelope.
function fadingNoise(n, seed, { amp = 0.05, fadeHz = 0.4, depth = 0.95, rate = SR } = {}) {
  const x = noise(n, seed, amp);
  for (let i = 0; i < n; i++) x[i] *= 1 + depth * Math.cos((2 * Math.PI * fadeHz * i) / rate);
  return x;
}

// And these crashes are BROADBAND — white noise plus short loud impulses at
// random times — where the shared `impulsive` colour rings at one frequency
// per crash, the way an atmospheric does after a receiver's IF filter. The
// bridge and click cases below are about the broadband kind, and the
// difference matters: a ring is narrowband by construction, so the broadband
// guard in segment.js cannot see it, and the two are not interchangeable.
function impulsiveNoise(n, seed, { amp = 0.05, count = 40, gain = 30, lenSec = 0.002, rate = SR } = {}) {
  const x = noise(n, seed, amp), r = rng(seed ^ 0x5bd1);
  const len = Math.max(1, Math.round(lenSec * rate));
  for (let k = 0; k < count; k++) {
    const at = Math.floor(r() * (n - len));
    for (let i = 0; i < len; i++) x[at + i] += amp * gain * Math.exp(-3 * i / len) * (r() * 2 - 1);
  }
  return x;
}

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

// Speech, by source and filter: jittered glottal pulses through three formant
// resonators, gated into syllables with pauses, with unvoiced stretches. It is
// a SYNTHETIC and is the reference on purpose — the recordings the speech
// numbers in classify.js were measured on are off the shelf on licence
// grounds, so nothing below is measured from a voice. What it is here for is
// one thing only: the refusal cases now require that no background is claimed
// as speech, and a refusal that also refuses speech is deafness rather than
// honesty, so something speech-shaped has to be on the other side of it.
function speechish(seconds, seed = 1, { rate = SR, amp = 0.35 } = {}) {
  const n = Math.round(seconds * rate), r = rng(seed);
  const src = new Float64Array(n);
  let t = 0;
  const plan = [];
  while (t < seconds) {
    const dur = 0.06 + r() * 0.18;
    plan.push({ t0: t, t1: t + dur, voiced: r() > 0.28 });
    t += dur + (r() < 0.18 ? 0.15 + r() * 0.35 : 0.01 + r() * 0.05);
  }
  let ph = 0;
  for (const p of plan) {
    const a = Math.round(p.t0 * rate), b = Math.min(n, Math.round(p.t1 * rate));
    const f0 = 95 + r() * 70;
    for (let i = a; i < b; i++) {
      if (!p.voiced) { src[i] += 0.25 * (r() * 2 - 1); continue; }
      ph += (f0 * (1 + 0.03 * (r() - 0.5))) / rate;
      if (ph >= 1) { ph -= 1; src[i] += 1; }
    }
  }
  const out = new Float64Array(n);
  for (const [hz, bw] of [[420, 80], [1600, 110], [2600, 160]]) {
    let y1 = 0, y2 = 0;
    const rr = Math.exp((-Math.PI * bw) / rate), th = (2 * Math.PI * hz) / rate;
    const a1 = 2 * rr * Math.cos(th), a2 = -rr * rr;
    for (let i = 0; i < n; i++) { const y = src[i] + a1 * y1 + a2 * y2; y2 = y1; y1 = y; out[i] += y; }
  }
  let e = 0;
  for (let i = 0; i < n; i++) e += out[i] * out[i];
  const g = amp / (Math.sqrt(e / n) || 1);
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
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
    // noise, and a detector that splits it is worse than no detector.
    //
    // Five colours, and two different requirements, because "nothing" means
    // two different things. A background whose LEVEL is stationary — white,
    // 1/f, or white under a Rayleigh fade — must produce nothing whatsoever. A
    // background carrying crashes or a gate carries real events, and the
    // requirement there is that whatever comes back is explained: every
    // component either spans the analysed band, or the window says the
    // waveform is impulsive, and none of them claims more than the caps allow.
    //
    // The counts below are measured over 30 windows of 20 s per colour, with
    // the old guards and the new: on crashes 292 components fell to 241, and
    // the 261 of the 292 that sat between half the analysed band and
    // FULL_BAND_FRACTION — where nothing was guarding them at all — fell to
    // 52. On a gated band 428 fell to 296 and the number claiming more than
    // 0.5 confidence fell from 147 to 15.
    for (const [name, gen] of BACKGROUNDS) {
      for (let seed = 1; seed <= 5; seed++) {
        const r = segment(gen(SR * 10, seed), SR);
        assert.equal(r.standingBands.length, 0, `${name} seed ${seed} invented a standing band`);
        if (STATIONARY.includes(name)) {
          assert.equal(r.components.length, 0, `${name} seed ${seed} invented ${r.components.length} components`);
          assert.equal(r.emissions.length, 0, `${name} seed ${seed} invented ${r.emissions.length} emissions`);
          continue;
        }
        assert.ok(EVENTFUL.includes(name), `${name} is in neither list`);
        assert.ok(r.components.length <= 12,
          `${name} seed ${seed} produced ${r.components.length} components out of a background`);
        for (const d of r.components) {
          assert.ok((d.confidence ?? 0) <= CONFIDENCE_CAP_NONSTATIONARY + 1e-12,
            `${name} seed ${seed}: a background produced confidence ${d.confidence}`);
          const explained = d.fullBand
            || r.warnings.some((w) => /waveform is impulsive/.test(w))
            || d.confidenceNotes.length > 0;
          assert.ok(explained,
            `${name} seed ${seed}: ${Math.round(d.lowHz)}-${Math.round(d.highHz)} Hz came back with nothing said about it`);
        }
      }
    }
    // On the stationary colours the two presence statistics are what they
    // claim to be. `present` is allowed to fire at its own alpha and does —
    // measured, white seed 5 — so the assertion is on the statistics, and the
    // refusal that matters is the one on components above.
    for (const name of ['white', 'pink']) {
      const gen = BACKGROUNDS.find(([n]) => n === name)[1];
      for (let seed = 1; seed <= 4; seed++) {
        const r = segment(gen(SR * 10, seed), SR);
        assert.equal(r.present, false, `${name} seed ${seed}: ${r.reason}`);
        assert.match(r.reason, /noise alone/);
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
    //
    // AND IT IS A LIMIT, NOT A PROPERTY. The null holds on the three colours
    // whose level is stationary and it does not hold on the other two, which
    // is pinned here rather than left to be discovered: measured over 6
    // windows each, the mean normalised cell power runs 0.995-1.007 on white,
    // 0.999-1.004 on 1/f and 1.107-1.179 under a Rayleigh fade, against
    // 9.0-12.4 on crashes and 9.0-23.6 on a gated band, where the 1% mask
    // passes 12.5% and 15.9% of cells. Nothing downstream of this may treat a
    // false-alarm rate on those two colours as calibrated, and the guards that
    // deal with them are behavioural rather than analytic for that reason.
    const growThreshold = -Math.log(GROW_CELL_RATE);
    const measure = (x) => {
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
      return { mean: sum / n, rate: grow / n };
    };
    for (const [name, gen] of BACKGROUNDS) {
      for (let seed = 1; seed <= 3; seed++) {
        const { mean, rate } = measure(gen(SR * 20, seed));
        if (STATIONARY.includes(name)) {
          assert.ok(mean > 0.94 && mean < 1.25,
            `${name} seed ${seed}: mean normalised cell power ${mean.toFixed(3)}, want 1`);
          assert.ok(rate < 0.035, `${name} seed ${seed}: grow mask passed ${(100 * rate).toFixed(2)}% of cells, designed for 1%`);
        } else {
          // Pinned as the known break. If one of these ever comes back inside
          // the stationary bounds, the generator has stopped being what it
          // claims to be and the refusal cases above are testing nothing.
          assert.ok(mean > 3, `${name} seed ${seed}: mean ${mean.toFixed(3)} — this colour is supposed to break the null`);
          assert.ok(rate > 0.05, `${name} seed ${seed}: grow rate ${(100 * rate).toFixed(2)}% — this colour is supposed to break the null`);
        }
      }
    }
    // And the generators are what they say they are, checked through the
    // shared module's own descriptor rather than taken on trust.
    const tilt = (name) => describe(COLOURS[name](SR * 6, { seed: 11 }), SR);
    assert.ok(tilt('pink').tiltDbPerDecade < -6, `1/f measured ${tilt('pink').tiltDbPerDecade.toFixed(1)} dB per decade of tilt`);
    assert.ok(Math.abs(tilt('white').tiltDbPerDecade) < 3, 'white must be flat');
    assert.ok(tilt('impulsive').kurtosis > 20, `crashes measured kurtosis ${tilt('impulsive').kurtosis.toFixed(1)}`);
    assert.ok(tilt('faded').swingDb > 6, `the fade measured ${tilt('faded').swingDb.toFixed(1)} dB of level swing`);

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

  async function theErrorBarOnSnrSurvivesItsOwnSplitHalfOnEveryColour() {
    // The standard the whole file is written to: a number that carries an
    // uncertainty has to agree with itself when the window is cut in two and
    // each half is measured separately, inside the two bars added in
    // quadrature, at least 90% of the time.
    //
    // It used to be checked on white noise alone, where it passed at 92-97%,
    // and it failed on the first background that was not white. Measured on
    // 1/f at four amplitudes over 24 seeds with SNR_SE_INFLATION at 2:
    // coverage of 63%, 54%, 58%, 58%, median |z| near 1.85 at every amplitude.
    // The tone is deterministic and identical in both halves, so all of that
    // disagreement is in the floor — the half-to-half standard deviation of
    // snrDb at amplitude 0.15 is 0.079 dB on white and 0.283 dB on 1/f against
    // a bar of 0.108 dB in both — and a floor over a tilted background is a
    // median of a wider spread, which is a median with a larger variance.
    //
    // The crash background is not in this list and that is the honest reason:
    // no isolated component survives the guards there for a level to be
    // measured on. It is the one colour where this claim is not made at all.
    // The fourth number is how wide the bar is allowed to be before it stops
    // being a measurement, and it is not the same on every colour. Under a
    // Rayleigh fade the carrier's own level moves between blocks by more than
    // the noise does, and it moves by the same proportion at every amplitude,
    // so the bar reads 3.6-4.0 dB there and does not shrink when the carrier
    // is made louder. That is the honest number — a level measured through a
    // deep fade IS only known to about four decibels — and pinning it at 3 the
    // way white noise allows would have been pinning a white-noise assumption.
    const cases = [['pink', 0.15, 24, 3], ['white', 0.15, 12, 3], ['faded', 0.30, 12, 6]];
    for (const [colour, amp, seeds, maxBar] of cases) {
      let pairs = 0, inside = 0, worst = 0;
      for (let seed = 300; seed < 300 + seeds; seed++) {
        const x = Float64Array.from(COLOURS[colour](SR * 24, { seed }));
        addTone(x, 1500, amp, 0, 24);
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
        assert.ok(a.snrDbSe < maxBar && b.snrDbSe < maxBar,
          `${colour} amp ${amp} seed ${seed}: bar ${a.snrDbSe.toFixed(2)}/${b.snrDbSe.toFixed(2)} dB is not a measurement`);
      }
      assert.ok(pairs >= seeds - 2, `${colour} amp ${amp}: only ${pairs} usable pairs of ${seeds}`);
      assert.ok(inside / pairs >= 0.9,
        `${colour} amp ${amp}: the halves agreed inside 2 SE in ${inside} of ${pairs}; worst z ${worst.toFixed(2)}`);
    }
    // The gated background is not in that list either, and the reason is worth
    // stating rather than hiding: a continuous carrier's excess over the floor
    // swings with the gate, so the bar reads 3.9 dB over a whole 24 s window and up
    // to 21 dB over one half of it. That is not a
    // failure of the estimator — the quantity really did move by that much —
    // but it means the number carries nothing, and a coverage figure computed
    // against a 21 dB bar would be a pass that meant nothing either.
    {
      const x = Float64Array.from(COLOURS.bursty(SR * 24, { seed: 300 }));
      addTone(x, 1500, 0.15, 0, 24);
      const d = segment(x, SR).emissions.find((q) => q.lowHz <= 1500 && q.highHz >= 1500);
      assert.ok(d && d.snrDbSe > 2,
        `a gated background is supposed to give a bar too wide to use; got ${d ? d.snrDbSe.toFixed(2) : 'no detection'}`);
    }
    // The widening is what buys that, and it is a cost as well as a fix: on
    // white noise the bar is now about three times the half-to-half standard
    // deviation it estimates rather than 1.4 times it. The constant is pinned
    // so the trade cannot be quietly reversed in either direction.
    assert.equal(SNR_SE_INFLATION, 4.4);
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

  async function theBroadbandGuardIsAskedAtEveryWidthAndOfTheBandOutsideTheComponent() {
    // Two things were wrong with the guard this pins, and they pulled in
    // opposite directions.
    //
    // IT COULD NOT BE ASKED ABOVE HALF THE BAND. The question was put to the
    // median across ALL the analysed bins, which only means anything for a
    // component too narrow to move that median, so it was asked only below
    // half the band while FULL_BAND_FRACTION's confidence cap starts at 0.8.
    // Between the two, nothing. Measured over 30 windows of the crash-ridden
    // colour: 292 components survived and 261 of them sat in that gap, at
    // confidence 0.80. Asking it of the bins OUTSIDE the component instead
    // makes it a fair question at any width, and the gap holds 52.
    //
    // IT DELETED REAL SIGNAL. See the case after this one.
    let inGap = 0, total = 0, asked = 0, notFullBand = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const r = segment(COLOURS.impulsive(SR * 10, { seed }), SR);
      const span = r.presence.binHi - r.presence.binLo + 1;
      for (const d of r.components) {
        total += 1;
        const share = (d.bins[1] - d.bins[0] + 1) / span;
        if (share >= 0.5 && share < FULL_BAND_FRACTION) inGap += 1;
        if (d.flashShare !== null) asked += 1;
        if (!d.fullBand) notFullBand += 1;
        // Whatever survived, the question was either put to it or could not be
        // put at all, and the answer is on the object rather than implied.
        assert.ok(d.flashShare === null || d.flashShare <= 1.0000001, `flashShare ${d.flashShare}`);
        if (d.flashShare !== null && !d.fullBand) {
          assert.ok(d.flashShare <= FLASH_SHARE || d.flashShare <= FLASH_EXCESS * d.flashBase,
            `a component with ${(100 * d.flashShare).toFixed(0)}% of its cells in broadband frames ` +
            `against a base rate of ${(100 * d.flashBase).toFixed(0)}% should not have survived`);
        }
      }
    }
    assert.ok(total > 0, 'the crash-ridden colour is supposed to produce something to guard');
    assert.ok(asked >= total * 0.5,
      `the question could only be put to ${asked} of ${total} components; it is meant to be askable at almost any width`);
    assert.ok(inGap <= total * 0.5,
      `${inGap} of ${total} components sit between half the band and ${FULL_BAND_FRACTION}, which is where the old gap was`);
    // And how many get through at all, which is what the bin share buys.
    // Measured over these same 6 windows: 26 components that do not span the
    // band at a quarter of the outside bins hot, 41 at a half.
    assert.ok(notFullBand <= 34,
      `${notFullBand} components that do not span the band survived; at a FLASH_BIN_SHARE of a half rather than ${FLASH_BIN_SHARE} it is 41`);
    // The hot-bin rate the guard rests on has an arithmetic null: a bin is hot
    // when it stands FLASH_RATIO over its own floor and gain, which under
    // Exp(1) happens with probability exp(-3) = 4.98%. Half the bins at once
    // is fifteen standard deviations of that, and the cut sits at a quarter.
    assert.ok(FLASH_BIN_SHARE > 5 * Math.exp(-3),
      `${FLASH_BIN_SHARE} is not far enough above the ${(100 * Math.exp(-3)).toFixed(1)}% a background gives on its own`);
    assert.ok(FLASH_EXCESS > 1, 'a share equal to the base rate is not evidence of anything');
  },

  async function theBroadbandGuardDoesNotDeleteAFadingCarrier() {
    // The opposite failure, and it was live. The guard's numerator used to be
    // the frame's band level against the WINDOW's median level, and a 0.95-deep
    // fade lifts the whole band 3.8x in power at every peak — so the peaks of
    // the fade were read as broadband events and the carrier under them was
    // thrown away with them. Measured: a 1500 Hz carrier at amplitude 0.30
    // under a 0.4 Hz 0.95-depth fade was lost in 5 of 24 seeds, and disabling
    // the guard alone recovered all five.
    //
    // The denominator is now the frame gain — a running median over 0.25 s,
    // which follows a 2.5 s fade and does not follow a 2 ms crash — and the
    // same carrier is found in 24 of 24 seeds at every amplitude from 0.05 to
    // 0.50. Six seeds are run here and the sweep is stated.
    //
    // A NOTE ON THE REPORT THAT PROMPTED THIS. The 5-of-24 figure did not
    // reproduce here: the module as it stood lost the carrier in 0 of 72 seeds
    // across three seed blocks at amplitude 0.30, because its own guard was
    // additionally restricted to components narrower than half the band. What
    // did reproduce is the mechanism, and it is pinned on the statistic rather
    // than on the outcome, which is the stronger place to pin it. The carrier's
    // own flashShare — the share of its cells in frames the guard calls
    // broadband — reads 0.000 in all 12 seeds with the frame gain as the
    // denominator and 0.323 to 0.350 with the window's median, against a
    // FLASH_SHARE of 0.25. With BOTH that and the base-rate factor reverted the
    // carrier is deleted in 24 of 24.
    for (const amp of [0.10, 0.30]) {
      for (let seed = 700; seed < 706; seed++) {
        const x = fadingNoise(SR * 20, seed);
        addTone(x, 1500, amp, 0, 20);
        const r = segment(x, SR);
        const d = r.emissions.find((q) => q.lowHz <= 1500 && q.highHz >= 1500);
        assert.ok(d, `a carrier at amplitude ${amp} under a 0.4 Hz fade was deleted, seed ${seed}`);
        const c = r.components.find((q) => q.lowHz <= 1500 && q.highHz >= 1500);
        assert.ok(c && c.flashShare !== null && c.flashShare < 0.1,
          `amplitude ${amp} seed ${seed}: the carrier read flashShare ${c ? c.flashShare : 'null'}; ` +
          'the peaks of a fade are not broadband events and the guard must not count them as such');
      }
    }
    // And the recall of the whole module, colour by colour, so that a later
    // guard cannot buy a refusal with signal. Measured over 24 seeds each at
    // amplitudes 0.006 to 0.30, a 20 s carrier in a 0.05 background is found in
    // 24 of 24 everywhere; at 0.004 it falls to 20 of 24 on white and 18 on a
    // Rayleigh fade, which is the detection floor and not a guard.
    //
    // WHAT IS FOUND IS NOT THE SAME THING ON EVERY COLOUR, and that is the
    // honest part. On white, 1/f and a fade the detection is a line 47 to
    // 234 Hz wide. On crashes and a gated band the carrier merges with the
    // events around it and comes back as a 1.8 to 3.9 kHz detection at
    // confidence 0.3 to 0.5 — found, but not isolated, and the object says so.
    for (const [name, gen] of BACKGROUNDS) {
      const wide = EVENTFUL.includes(name);
      for (let seed = 600; seed < 603; seed++) {
        const x = Float64Array.from(gen(SR * 10, seed));
        addTone(x, 1500, 0.02, 0, 10);
        const d = segment(x, SR).emissions.find((q) => q.lowHz <= 1500 && q.highHz >= 1500);
        assert.ok(d, `${name} seed ${seed}: a 20 dB carrier was not found at all`);
        if (!wide) {
          assert.ok(d.bandwidthHz < 400, `${name} seed ${seed}: bounded as ${Math.round(d.bandwidthHz)} Hz wide`);
        } else {
          assert.ok((d.confidence ?? 1) <= CONFIDENCE_CAP_NONSTATIONARY,
            `${name} seed ${seed}: a merged detection claimed ${d.confidence}`);
        }
      }
    }
  },

  async function nothingShorterThanTheAnalysisWindowIsClaimed() {
    // The duration floor is minDurationSec PLUS the analysis window, because
    // the window smears an instant over its own length before anything here
    // sees it. The second term had no test of its own: removing it left all
    // 29 cases in this file passing.
    //
    // Measured with it and without it, a 0.5-amplitude tone burst in white
    // noise over 12 seeds: a 130 ms burst is reported in 1 of 12 seeds with
    // the term and 12 of 12 without, and the shortest duration any component
    // reports falls from 0.256 s to 0.192 s — below the 0.214 s the defaults
    // are supposed to guarantee.
    // The window length is read off the module rather than assumed: at the
    // 20 Hz default bin and 8 kHz it is a 512-point transform, 64 ms.
    const probe = segment(noise(SR * 4, 1), SR);
    const shortest = DEFAULT_MIN_DURATION_SEC + probe.spec.fftSize / SR;
    let claimed = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const x = noise(SR * 12, seed);
      addTone(x, 1200, 0.5, 5, 5.13);
      for (const d of segment(x, SR).components) {
        assert.ok(d.durationSec >= shortest - 1e-9,
          `seed ${seed}: a ${d.durationSec.toFixed(3)} s component was reported where nothing under ${shortest.toFixed(3)} s can be bounded`);
        if (d.lowHz <= 1200 && d.highHz >= 1200) claimed += 1;
      }
    }
    assert.ok(claimed <= 2, `a 130 ms burst was claimed in ${claimed} of 12 seeds; it is shorter than anything this can bound`);
    // And the cost, which is real: at 220 ms the same burst is found every
    // time. The floor is a floor, not deafness.
    let found = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const x = noise(SR * 12, seed);
      addTone(x, 1200, 0.5, 5, 5.22);
      if (segment(x, SR).components.some((d) => d.lowHz <= 1200 && d.highHz >= 1200)) found += 1;
    }
    assert.equal(found, 12, `a 220 ms burst should be found every time; got ${found} of 12`);
  },

  async function anImpulsiveWaveformIsCaveatedWhetherOrNotAnythingWasFound() {
    // The caveat used to be attached only to silence. The windows that need it
    // are the ones where the crashes DID produce detections, and those got
    // nothing: measured over 30 windows of the ringing-crash colour, 292
    // components came back and not one of them, nor the window they came from,
    // said that a train of crashes would look the same.
    for (let seed = 1; seed <= 4; seed++) {
      const r = segment(COLOURS.impulsive(SR * 10, { seed }), SR);
      assert.ok(r.components.length > 0, `seed ${seed}: this colour is supposed to produce detections`);
      assert.ok(r.warnings.some((w) => /waveform is impulsive/.test(w)),
        `seed ${seed}: ${r.components.length} detections out of a crash train and no caveat: ${r.warnings.join(' | ')}`);
      assert.ok(r.warnings.some((w) => /crash is a damped ring/.test(w)),
        `seed ${seed}: the caveat has to say why the broadband guard cannot see it`);
      assert.ok(r.warnings.some((w) => /becomes its own floor/.test(w)),
        `seed ${seed}: and it has to say the other half too`);
      assert.ok(r.impulse.z > IMPULSIVE_Z);
    }
    // Silence still gets its own wording, which is a different statement.
    {
      const x = noise(SR * 10, 5);
      addTone(x, 1800, 1.2, 5, 5.01);              // 10 ms, very loud, no detection
      const r = segment(x, SR);
      assert.equal(r.components.length, 0);
      assert.ok(r.warnings.some((w) => /becomes its own floor/.test(w)), r.warnings.join(' | '));
    }
    // And it is a caveat rather than a cap, which is a measured decision. No
    // magnitude of excess kurtosis separates a crash train from a real short
    // transmission: 29 to 35 on the crash colour over 24 windows against 65 on
    // 30 s of white noise carrying one real 0.3 s tone at amplitude 1.0. A cap
    // keyed on it would have taken the real burst down with the crashes.
    const crashK = impulsiveness(COLOURS.impulsive(SR * 20, { seed: 1 })).excessKurtosis;
    const burst = addTone(noise(SR * 30, 21), 1500, 1.0, 10, 10.3);
    const burstK = impulsiveness(burst).excessKurtosis;
    assert.ok(burstK > crashK,
      `a real 0.3 s burst reads ${burstK.toFixed(1)} and a crash train ${crashK.toFixed(1)}; if that ever reverses, a cap becomes possible`);
    const d = segment(addTone(noise(SR * 30, 21), 1500, 0.15, 10, 12), SR).emissions[0];
    assert.ok(d.confidence > 0.999, `a clean burst must not be capped by its own impulsiveness, got ${d.confidence}`);
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
    // bands at all. This is the CLASSIFY button's own path, and it is the one
    // a person sees first.
    //
    // Measured over 150 windows per colour before the noise hypothesis was
    // rewritten: white came back `noise` 150 times out of 150, and the other
    // four came back as a named transmission 17, 117, 105 and 128 times. The
    // cause was structural rather than a threshold — every test the noise
    // hypothesis carried was a test for WHITE, STILL noise, so on a coloured,
    // fading, crash-ridden or gated background it scored below MIN_SCORE and
    // the ranking handed the window to whatever was next. After the rewrite,
    // 750 of 750 windows come back `noise` or `unclear`, with 748 of them
    // `noise` outright.
    // The seeds are not 1, 2, 3. Each one is the window at which some
    // hypothesis scored highest over the first 24 seeds of its colour, so that
    // the ceilings below are checked where they are nearest to being breached
    // rather than at an average window: impulsive 10 is where a tone set scores
    // best, impulsive 28 where speech does, bursty 1 where a keyed carrier
    // does, white 1 where a multi-carrier burst does, faded 2 and pink 3 where
    // speech does on those colours.
    const ADVERSARIAL = [['white', 1], ['pink', 3], ['pink', 19], ['faded', 2], ['impulsive', 1], ['impulsive', 10], ['impulsive', 28], ['bursty', 1]];
    // How high each hypothesis is allowed to climb on a background, measured
    // over 24 seeds per colour and written down with a margin. These are what
    // make the noise hypothesis's own tests load-bearing rather than decorative:
    // a tone set reaches 0.29 and reaches 0.53 if it stops having to survive
    // the band being divided by its own local level; speech reaches 0.50 and
    // 0.60 if its envelope test goes back to a bare depth, which Rayleigh
    // noise satisfies; a keyed carrier reaches 0.33 and 0.52 without the test
    // that there be a carrier at all.
    const CEILING = { 'ssb-voice': 0.55, mfsk: 0.40, 'ook-morse': 0.45, 'data-multicarrier': 0.45, 'pulsed-wide': 0.50, carrier: 0.40, 'am-tone': 0.40, fsk2: 0.40 };
    for (const [name, seed] of ADVERSARIAL) {
      const c = classifySegment(COLOURS[name](SR * 10, { seed }), SR, { startSec: 1, endSec: 9, lowHz: 300, highHz: 3000 });
      assert.ok(c.verdict === 'noise' || c.verdict === 'unclear', `${name} seed ${seed}: got ${c.verdict}: ${c.why}`);
      const self = c.ranked.find((h) => h.id === 'noise');
      // Noise must not merely survive the ranking, it must lead it. Measured
      // over 16 seeds per colour it scores 0.71 at worst; if the flatness test
      // goes back to asking about colour rather than structure, 1/f falls to
      // 0.57 and the answer becomes `unclear` instead of `noise`.
      assert.ok(self.score >= 0.65, `${name} seed ${seed}: noise itself only scored ${self.score.toFixed(2)}`);
      for (const h of c.ranked) {
        if (h.id === 'noise') continue;
        assert.ok(h.score <= self.score, `${name} seed ${seed}: ${h.id} at ${h.score.toFixed(2)} outranked noise at ${self.score.toFixed(2)}`);
        // The one exception, pinned rather than excused: a band of noise gated
        // on and off IS a wideband emitter switched at a steady rate by every
        // measurement in the module, and the gate here runs at 5.4 Hz. Both
        // hypotheses then score 1.00 and the answer is 'unclear', which is the
        // true answer — nothing here can say which it is.
        if (name === 'bursty' && h.id === 'pulsed-wide') {
          assert.ok(c.verdict === 'unclear' || h.score < self.score,
            `gated noise scored pulsed-wide at ${h.score.toFixed(2)} and it was claimed`);
          continue;
        }
        assert.ok(h.score <= CEILING[h.id], `${name} seed ${seed}: ${h.id} scored ${h.score.toFixed(2)}, ceiling ${CEILING[h.id]}`);
      }
    }
    const f = classifySegment(noise(SR * 10, 61), SR, { startSec: 1, endSec: 9, lowHz: 300, highHz: 3000 }).features;
    assert.ok(Math.abs(f.envDepth - RAYLEIGH_DEPTH) < 0.06,
      `envelope depth ${f.envDepth.toFixed(3)} against Rayleigh's ${RAYLEIGH_DEPTH}`);
    assert.equal(f.lineCount, 0, 'white noise has no lines');
    assert.ok(f.spectralFlatness > 0.9, `flatness ${f.spectralFlatness.toFixed(3)}`);
    assert.equal(f.envKeyed, false);
  },

  async function theNoiseHypothesisAsksAboutStructureAndNotAboutColour() {
    // The three features the rewritten noise hypothesis rests on, pinned
    // against every colour at once, because each replaced a test that was
    // really a test for whiteness.
    //
    //   spectralFlatness      is about COLOUR. 0.99 on white, 0.65 on 1/f —
    //                         which sat exactly on the old cut of 0.65.
    //   whitenedFlatness      is about STRUCTURE: the same spectrum divided by
    //                         the median of each bin's own neighbourhood.
    //   envDepth              is about the LEVEL as well as the noise: 0.65 on
    //                         white, 0.79 fading, 0.87 crashes, 0.96 gated.
    //   localEnvDepth         is Rayleigh's 0.648 inside a 50 ms block on all
    //                         five, because a quantile ratio is scale-free.
    //   tiltSwingOverNull     is how far the band's SHAPE moves frame to frame
    //                         against its own counting noise: about 1 on every
    //                         stationary background and 3 or more on speech.
    const rows = [];
    for (const [name, gen] of BACKGROUNDS) {
      const f = extractFeatures(gen(SR * 10, 77), SR, { startSec: 1, endSec: 9, lowHz: 300, highHz: 3000 });
      rows.push([name, f]);
      assert.ok(f.whitenedFlatness > 0.65,
        `${name}: whitenedFlatness ${f.whitenedFlatness.toFixed(3)} — a background has colour but no structure`);
      assert.ok(f.localEnvDepth > RAYLEIGH_DEPTH - 0.12,
        `${name}: localEnvDepth ${f.localEnvDepth.toFixed(3)} against Rayleigh's ${RAYLEIGH_DEPTH}`);
      assert.ok(f.carrierRatio < 0.05, `${name}: carrierRatio ${f.carrierRatio.toFixed(3)}`);
      if (STATIONARY.includes(name)) {
        assert.ok(f.tiltSwingOverNull < 1.6,
          `${name}: the band's shape moved ${f.tiltSwingOverNull.toFixed(2)} times its own counting noise`);
      }
    }
    // 1/f is the case that shows the two flatness numbers are different
    // questions, so it is asserted rather than left to the loop.
    const pink = rows.find(([n]) => n === 'pink')[1];
    assert.ok(pink.spectralFlatness < 0.72, `1/f measured flatness ${pink.spectralFlatness.toFixed(3)}; it is meant to be tilted`);
    assert.ok(pink.whitenedFlatness > 0.9, `1/f whitened to ${pink.whitenedFlatness.toFixed(3)}; the tilt should be gone`);
    // And the fading and gated colours are where envDepth and localEnvDepth
    // part company, which is the whole reason the second one exists.
    for (const name of ['faded', 'bursty']) {
      const f = rows.find(([n]) => n === name)[1];
      assert.ok(f.envDepth > 0.72, `${name}: envDepth ${f.envDepth.toFixed(3)} should be inflated by the level`);
      assert.ok(Math.abs(f.localEnvDepth - RAYLEIGH_DEPTH) < 0.09,
        `${name}: localEnvDepth ${f.localEnvDepth.toFixed(3)} should be Rayleigh's whatever the level did`);
    }
    assert.equal(LOCAL_BLOCK_SEC, 0.05);

    // And the line search's null, which is a statement about the mean of
    // `frames` Exp(1) draws and is only true if the level held still. Each
    // frame is divided by its own band level before the spectrum is averaged;
    // without that, a Rayleigh fade widens every bin's mean far beyond the
    // 1/sqrt(frames) the threshold assumes and manufactures lines out of
    // nothing — measured, 5 of 16 fading windows carried one, up to two per
    // window, against 0 of 16 with it.
    //
    // 1/f is not in this list and the reason is its own: the line search runs
    // at an alpha of 0.01 across the band, and on a tilted background a local
    // median over 200 Hz is not quite the local level, so 2 of 16 windows carry
    // one line with the normalisation as well as without. That is the search's
    // own false-alarm rate rather than the fade's, and the noise hypothesis
    // survives it — a single line costs two weights of thirteen.
    for (const name of ['white', 'faded', 'bursty']) {
      for (let seed = 1; seed <= 8; seed++) {
        const f = extractFeatures(COLOURS[name](SR * 10, { seed }), SR, { startSec: 1, endSec: 9, lowHz: 300, highHz: 3000 });
        assert.equal(f.lineCount, 0, `${name} seed ${seed} found ${f.lineCount} lines in a background`);
      }
    }

    // THE OTHER DIRECTION, and the reason the tilt test exists at all. A
    // refusal that also refuses speech is deafness. Synthesised speech has to
    // come back as speech, and it is separated from a fading background by
    // exactly one thing: the shape of the band moves.
    for (let seed = 1; seed <= 3; seed++) {
      const x = mix(speechish(10, seed), noise(SR * 10, 900 + seed, 0.01));
      const c = classifySegment(x, SR, { startSec: 1, endSec: 9, lowHz: 300, highHz: 3000 });
      assert.equal(c.verdict, 'ssb-voice', `speech seed ${seed}: ${c.verdict} — ${c.why}`);
      assert.ok(c.features.tiltSwingOverNull > 2,
        `speech seed ${seed}: shape moved only ${c.features.tiltSwingOverNull.toFixed(2)} times its counting noise`);
      // And speech is NOT separated from noise by the two features that would
      // have been the obvious guards, which is why neither is used as one.
      assert.ok(Math.abs(c.features.localEnvDepth - RAYLEIGH_DEPTH) < 0.09,
        `speech reads localEnvDepth ${c.features.localEnvDepth.toFixed(3)}, which is Rayleigh's — it cannot be a speech test`);
      assert.ok(c.features.whitenedFlatness > 0.6,
        `speech reads whitenedFlatness ${c.features.whitenedFlatness.toFixed(3)} — it cannot be a speech test either`);
    }
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
  async function aBandFarUnderTheReceiversOwnFloorIsCodecWhateverTheEdgeFinderSays() {
    // What an MP3 of a shortwave capture looks like decoded at 44.1 kHz: receiver
    // noise to ~3 kHz with a sharp edge, then a floor tens of dB lower with a
    // faint encoder ridge in it. The edge finder is decoder-dependent — the same
    // M08 file reads 17,000 Hz through Chrome's decoder and 2,885 Hz through
    // ffmpeg's — but the floor level cannot be talked into it.
    const rate = 44100, n = rate * 6;
    const seed = white(n, { sigma: 0.2, seed: 21 });
    const h = firLowpass(255, 3000 / rate, 80);
    const x = filter(seed, h);
    const quiet = white(n, { sigma: 0.2 * Math.pow(10, -55 / 20), seed: 22 });   // the codec's own floor
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      x[i] += quiet[i];
      if (t > 1.5 && t < 3.5) x[i] += 0.15 * Math.cos(2 * Math.PI * 1000 * i / rate);
      // a ridge 45 dB under the receiver band, keyed a little so it is not a pure line
      x[i] += 0.2 * Math.pow(10, -45 / 20) * (1 + 0.5 * Math.sin(2 * Math.PI * 7 * t)) * Math.cos(2 * Math.PI * 16000 * i / rate);
    }
    const res = segment(Float32Array.from(x), rate);
    const em = res.emissions;
    const real = em.filter((d) => d.lowHz < 2000 && d.highHz < 3500 && d.startSec < 3.5 && d.endSec > 1.5);
    // Everything the survey found above the receiver's edge, in whatever shape
    // it came back: on this synthetic the flat codec floor above 3 kHz comes
    // back as one component from the edge to Nyquist with the ridge inside it.
    const dead = em.filter((d) => d.lowHz > 3200);
    assert.ok(real.length >= 1, 'the burst in the receiver band is found: ' + JSON.stringify(em.map((d) => [Math.round(d.lowHz), Math.round(d.highHz)])));
    assert.ok(real.every((d) => !d.aboveContentEdge), 'and is air');
    assert.ok(real.every((d) => (d.floorBelowReceiverDb || 0) < 6),
      'a real emission sits on the receiver floor, not under it: ' + real.map((d) => (d.floorBelowReceiverDb || 0).toFixed(1)).join(', '));
    assert.ok(dead.length >= 1, 'something above the edge is detected at all (it is real energy, just not air): ' + JSON.stringify(em.map((d) => [Math.round(d.lowHz), Math.round(d.highHz)])));
    for (const d of dead) {
      assert.equal(d.aboveContentEdge, true, `${Math.round(d.lowHz)}-${Math.round(d.highHz)} Hz is codec (floor ${(d.floorBelowReceiverDb || 0).toFixed(0)} dB under the receiver)`);
      assert.ok(d.floorBelowReceiverDb >= DEAD_BAND_DB, `${Math.round(d.lowHz)}-${Math.round(d.highHz)} Hz reads ${d.floorBelowReceiverDb.toFixed(1)} dB under, bar ${DEAD_BAND_DB}`);
    }
  },
  async function theContentEdgeIsTheLargestCliffNotTheFirstStep() {
    // Chrome's decode of the M08 MP3 has two codec plateaus, about 14 dB apart
    // at 17 kHz, under a receiver band whose own edge is a 45 dB cliff near
    // 2.9 kHz. The first-step rule read 17,000 Hz; ffmpeg's decode of the same
    // file read 2,885. The biggest cliff is the receiver's under both.
    const rate = 44100, n = rate * 5;
    const receiver = filter(white(n, { sigma: 0.2, seed: 31 }), firLowpass(255, 2800 / rate, 80));
    const mid = filter(white(n, { sigma: 0.2 * Math.pow(10, -45 / 20), seed: 32 }), firLowpass(255, 17000 / rate, 80));
    const deep = white(n, { sigma: 0.2 * Math.pow(10, -59 / 20), seed: 33 });
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = receiver[i] + mid[i] + deep[i];
    const res = segment(x, rate);
    assert.ok(res.floor.contentEdgeHz > 2200 && res.floor.contentEdgeHz < 3600,
      `the edge is the receiver's, near 2.8 kHz, not the codec step at 17 kHz: read ${Math.round(res.floor.contentEdgeHz)} Hz`);
    // and with the first-step rule's own failure reconstructed: the 14 dB step
    // at 17 kHz must lose to the 45 dB one, which is what EDGE_STEP_DB decides
    assert.ok(EDGE_STEP_DB > 6 && EDGE_STEP_DB < 45, 'the bar sits between the codec step and the receiver cliff');
  },

  async function aWidebandTiltIsNotACliffSoTheEdgeStaysAtTheCutoff() {
    // A field recording at 96 kHz has receiver noise to the top with a gentle
    // tilt — no cliff to mistake for a passband edge. Pink noise is the
    // sharpest such tilt, 10 dB per decade, and it must not produce one.
    const rate = 96000, n = rate * 4;
    const x = pink(n, { sigma: 0.1, seed: 41 });
    const res = segment(x, rate);
    assert.ok(res.floor.contentEdgeHz > 0.6 * res.floor.cutoffHz,
      `a tilt read as a cliff: edge ${Math.round(res.floor.contentEdgeHz)} Hz against cutoff ${Math.round(res.floor.cutoffHz)}`);
    assert.equal(res.emissions.filter((d) => d.aboveContentEdge).length, 0, 'nothing in a tilt is codec');
  },
  async function mergingIsAnchoredToTheSeedAndNeverChains() {
    // The shape of M12 before the fix: 3 s Morse groups at 958-1044 Hz, a 16 s
    // splatter component at 215-1314 Hz over the first groups, and a
    // full-length hum at 54-118 Hz. Measured against the grown box, every
    // group folded into the splatter, the hum bridged the rest, and one 92-part
    // blob spanned 54-3079 Hz for two minutes and classified as speech.
    const c = (startSec, endSec, lowHz, highHz, fa, extra = {}) => ({
      startSec, endSec, lowHz, highHz, cells: 10, falseAlarmLog10: fa, snrDb: 15, confidence: 0.7,
      aboveContentEdge: false, floorBelowReceiverDb: 0, subBands: [[lowHz, highHz]], ...extra,
    });
    const groups = [5, 20, 35, 50].map((t) => c(t, t + 3, 958, 1044, -3000));
    const splatter = c(1.3, 16.6, 215, 1314, -25000);
    const hum = c(0, 120, 54, 118, -800);
    const out = mergeEmissions([hum, ...groups, splatter]);
    // the seed is the strongest, the splatter; a group inside it overlaps only
    // 20% of the seed's own extent and stays separate; the hum overlaps 100% of
    // the seed but the seed is 13% of the hum, so it stays separate too
    assert.equal(out.length, 6, 'nothing chains: ' + out.map((e) => `${Math.round(e.lowHz)}-${Math.round(e.highHz)}Hz ${e.startSec}-${e.endSec}s x${e.parts}`).join(' | '));
    assert.ok(out.every((e) => e.parts === 1));
    assert.ok(out.every((e) => Array.isArray(e.seedBand) && Array.isArray(e.seedTime)), 'each emission says what anchored it');
    // and the output is in time order, as before
    assert.deepEqual(out.map((e) => e.startSec), [0, 1.3, 5, 20, 35, 50]);
  },

  async function codecAndAirNeverMergeAndDepthIsTheShallowestPart() {
    const c = (lowHz, highHz, codec, under) => ({
      startSec: 0, endSec: 60, lowHz, highHz, cells: 10, falseAlarmLog10: -5000, snrDb: 12, confidence: 0.7,
      aboveContentEdge: codec, floorBelowReceiverDb: under, subBands: [[lowHz, highHz]],
    });
    // same time, 100 Hz apart: air with air merges, codec with codec merges, never across
    const out = mergeEmissions([c(900, 1000, false, 0), c(1100, 1200, false, 4), c(3500, 3600, true, 44), c(3700, 3800, true, 50)]);
    assert.equal(out.length, 2, out.map((e) => `${e.lowHz}-${e.highHz} codec=${e.aboveContentEdge}`).join(' | '));
    const air = out.find((e) => !e.aboveContentEdge), codec = out.find((e) => e.aboveContentEdge);
    assert.ok(air && codec);
    assert.equal(air.parts, 2);
    assert.equal(codec.parts, 2);
    // an emission is air if any part of it is, so its depth is the depth of
    // the part least under the receiver — the old max would have called the
    // air pair 4 dB under, and on M12 it called a real emission 57 dB under
    assert.equal(air.floorBelowReceiverDb, 0);
    assert.equal(codec.floorBelowReceiverDb, 44);
  },
];
