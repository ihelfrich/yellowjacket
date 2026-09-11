// The two decoders that turn a keyed carrier or a pair of tones back into
// characters, against signals whose every element was generated here and is
// therefore known rather than believed.
//
// Where a number appears in an assertion it was measured first and the margin
// left around it is stated in the case, so a failure says how far the behaviour
// moved rather than only that it moved.
import assert from 'node:assert/strict';

import {
  decodeCw, renderCw, morseToChar, charToMorse, CW_ALPHABET, CW_PROSIGNS,
  findTone, cwEnvelope, keyStates, runLengths, clusterTiming, mergeShort,
  squelchIncoherent, timeWeightedMedian, morseShaped, wpmFor, ditSecondsFor,
  fadeTrack, elementConfidence, CUT_NUMERALS, cutNumbers } from '../js/sigint/decode/cw.js';
import {
  detectDtmf, renderDtmf, detectSelcall, renderSelcall, identifySelcall,
  renderVoiceLike, dtmfPair, measureToneHz, schemeFit,
  DTMF_LOW, DTMF_HIGH, SELCALL_SETS, Q24,
} from '../js/sigint/decode/tones.js';
// Refusal is tested on five colours of noise, not on one. Every analytic null
// these decoders lean on — two Goertzel arms iid exponential, a per-arm gain
// with no tilt to invent, a percentile floor flat across frequency — holds
// under white Gaussian and under nothing else. Real HF is pink, it fades, it
// crashes, and it comes in bursts. `describe` is asserted on below so a
// generator that quietly turned white cannot make these tests pass by default.
import { COLOURS, everyColour, describe } from './noise-colours.mjs';

const SR = 8000;

// Character error rate against the message that was sent, by edit distance.
function cer(got, want) {
  const m = got.length, n = want.length;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (got[i - 1] === want[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n] / Math.max(1, n);
}

// QSB. `depth` is the fraction of the carrier the null takes away, `fq` the
// fading rate. The fade multiplies the SIGNAL and the noise is added after it,
// which is the order a receiver sees: propagation fades the transmission, the
// receiver's own noise floor does not fade with it, so a deep null puts the
// signal under the noise instead of taking both down together.
const faded = (msg, {
  wpm = 18, toneHz = 700, depth = 0.97, fq = 0.8, snrDb = null, seed = 1, amplitude = 0.5,
} = {}) => {
  const s = renderCw(msg, { wpm, sampleRate: SR, toneHz, amplitude });
  const x = Float32Array.from(s.samples);
  for (let i = 0; i < x.length; i++) x[i] *= 1 - depth * 0.5 * (1 - Math.cos(2 * Math.PI * fq * i / SR));
  if (snrDb !== null) {
    let rng = (seed * 2654435761) >>> 0;
    const rand = () => { rng = (rng * 1664525 + 1013904223) >>> 0; return rng / 4294967296; };
    const sd = Math.sqrt((amplitude * amplitude / 2) / Math.pow(10, snrDb / 10));
    for (let i = 0; i < x.length; i++) {
      const u = Math.max(1e-12, rand()), v = rand();
      x[i] += sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
  }
  return x;
};

const noise = (seconds, seed = 1, amp = 0.3) => {
  let rng = seed >>> 0;
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    rng = (rng * 1664525 + 1013904223) >>> 0;
    const u = Math.max(1e-12, rng / 4294967296);
    rng = (rng * 1664525 + 1013904223) >>> 0;
    x[i] = amp * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * (rng / 4294967296));
  }
  return x;
};

// A list of steady tones, back to back, with the 2 ms edges a real encoder
// puts on them. Used to build sets that are NOT in either table.
const renderTones = (freqs, { toneMs = 100, amplitude = 0.4, leadMs = 40, tailMs = 40 } = {}) => {
  const tn = Math.round(toneMs * SR / 1000);
  const lead = Math.round(leadMs * SR / 1000);
  const total = lead + Math.round(tailMs * SR / 1000) + freqs.length * tn;
  const x = new Float32Array(total);
  const edge = Math.round(0.002 * SR);
  let pos = lead;
  for (const hz of freqs) {
    for (let i = 0; i < tn && pos + i < total; i++) {
      let a = 1;
      if (i < edge) a = 0.5 * (1 - Math.cos(Math.PI * i / edge));
      else if (i > tn - edge) a = 0.5 * (1 - Math.cos(Math.PI * (tn - i) / edge));
      x[pos + i] = a * amplitude * Math.sin(2 * Math.PI * hz * (pos + i) / SR);
    }
    pos += tn;
  }
  return x;
};

// The same list of tones, but each one swept across its own duration instead of
// held. A selcall tone is one frequency for its whole length; this is what a
// signal that is NOT that looks like — an MFSK symbol, a heterodyne walking
// through the band, an unstable oscillator — and it is what defeated the
// self-calibrated fit tolerance, because a tone that disagrees with its own
// first half looks to a half-window rule exactly like a tone that is hard to
// measure. `driftFraction` is the half-width of the sweep as a fraction of the
// nominal, so 0.008 sweeps +-0.8% across the tone. The phase is accumulated
// rather than computed from a fixed frequency, or the sweep would be a phase
// discontinuity at every sample and would splatter across the whole bank.
const renderDrifting = (freqs, { toneMs = 100, driftFraction = 0, amplitude = 0.4, leadMs = 40, tailMs = 40 } = {}) => {
  const tn = Math.round(toneMs * SR / 1000), lead = Math.round(leadMs * SR / 1000);
  const total = lead + Math.round(tailMs * SR / 1000) + freqs.length * tn;
  const x = new Float32Array(total);
  const edge = Math.round(0.002 * SR);
  let pos = lead, phase = 0;
  for (const hz of freqs) {
    for (let i = 0; i < tn && pos + i < total; i++) {
      let a = 1;
      if (i < edge) a = 0.5 * (1 - Math.cos(Math.PI * i / edge));
      else if (i > tn - edge) a = 0.5 * (1 - Math.cos(Math.PI * (tn - i) / edge));
      phase += 2 * Math.PI * hz * (1 + driftFraction * (2 * i / tn - 1)) / SR;
      x[pos + i] = a * amplitude * Math.sin(phase);
    }
    pos += tn;
  }
  return x;
};

// One continuous sweep across the selcall band, with no tone boundaries in it
// at all. Nothing in it is a selcall tone and every window of it is close to
// one, which is the case the tolerance ceiling exists for.
const chirp = (f0, f1, seconds, { amplitude = 0.4, leadMs = 40, tailMs = 40 } = {}) => {
  const n = Math.round(seconds * SR), lead = Math.round(leadMs * SR / 1000);
  const total = lead + n + Math.round(tailMs * SR / 1000);
  const x = new Float32Array(total);
  const edge = Math.round(0.002 * SR);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    phase += 2 * Math.PI * (f0 + (f1 - f0) * i / n) / SR;
    let a = 1;
    if (i < edge) a = 0.5 * (1 - Math.cos(Math.PI * i / edge));
    else if (i > n - edge) a = 0.5 * (1 - Math.cos(Math.PI * (n - i) / edge));
    x[lead + i] = a * amplitude * Math.sin(phase);
  }
  return x;
};

// Several tones sounding together for one burst, which is what the DTMF purity
// gates exist to turn away.
const renderChord = (parts, { ms = 120, leadMs = 30, tailMs = 30 } = {}) => {
  const dn = Math.round(ms * SR / 1000), lead = Math.round(leadMs * SR / 1000);
  const total = lead + dn + Math.round(tailMs * SR / 1000);
  const x = new Float32Array(total);
  const edge = Math.round(0.002 * SR);
  for (let i = 0; i < dn; i++) {
    let a = 1;
    if (i < edge) a = 0.5 * (1 - Math.cos(Math.PI * i / edge));
    else if (i > dn - edge) a = 0.5 * (1 - Math.cos(Math.PI * (dn - i) / edge));
    let v = 0;
    for (const [hz, amp] of parts) v += amp * Math.sin(2 * Math.PI * hz * (lead + i) / SR);
    x[lead + i] = a * v;
  }
  return x;
};

export const NAME = 'sigint: morse and tone decoding';

export const cases = [

  // ------------------------------------------------------------------ alphabet

  async function alphabetRoundTripsAndRefusesTheUnknown() {
    for (const [pattern, ch] of Object.entries(CW_ALPHABET)) {
      assert.equal(morseToChar(pattern), ch, `${pattern} should read ${ch}`);
      assert.ok(/^[.-]+$/.test(pattern), `${pattern} is not made of dits and dahs`);
    }
    // Every letter and digit must be reachable in both directions.
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
      assert.equal(morseToChar(charToMorse(ch)), ch, `${ch} does not survive the round trip`);
    }
    // A pattern the recommendation does not define must come back as nothing,
    // not as the nearest letter.
    assert.equal(morseToChar('.-.-.-.-.-'), null);
    assert.equal(charToMorse('§'), null);
    // Patterns that are both punctuation and a prosign say so.
    assert.equal(morseToChar('-...-'), '=');
    assert.equal(CW_PROSIGNS['-...-'], 'BT');
    assert.equal(morseToChar('...---...'), 'SOS');
  },

  async function parisDefinesTheUnit() {
    // 1.2 s / wpm, exactly, at any speed.
    assert.equal(ditSecondsFor(20), 0.06);
    assert.ok(Math.abs(wpmFor(0.06) - 20) < 1e-9);
    assert.ok(Math.abs(wpmFor(ditSecondsFor(37)) - 37) < 1e-9);
  },

  // -------------------------------------------------------------- clean decode

  async function readsAKnownMessageAcrossTheSpeedRange() {
    const msg = 'CQ CQ DE W1AW K';
    for (const wpm of [8, 20, 35]) {
      const s = renderCw(msg, { wpm, sampleRate: SR, toneHz: 750 });
      const r = decodeCw(s.samples, SR);
      assert.ok(r.ok, `${wpm} wpm refused: ${r.reason}`);
      assert.equal(r.text, msg, `${wpm} wpm read "${r.text}"`);
      // Speed within 3%: measured error over 5 to 40 wpm was under 1%.
      assert.ok(Math.abs(r.wpmChar - wpm) / wpm < 0.03, `${wpm} wpm measured ${r.wpmChar.toFixed(1)}`);
      // Machine keying, so the ratio it finds must be the ratio that was sent.
      assert.ok(Math.abs(r.dahDitRatio - 3) < 0.15, `dah/dit came out ${r.dahDitRatio.toFixed(2)}`);
      // 1 : 3 : 7, recovered rather than assumed.
      const [a, b, c] = r.spacing.ratios;
      assert.ok(Math.abs(a - 1) < 0.15 && Math.abs(b - 3) < 0.3 && Math.abs(c - 7) < 0.7,
        `spacing came out ${r.spacing.ratios.map((v) => v.toFixed(2)).join(' : ')}`);
      assert.equal(r.chars.filter((ch) => ch.uncertain).length, 0, 'a clean signal should flag nothing');
    }
  },

  async function findsTheToneAndSaysHowUncertainItIs() {
    const s = renderCw('TEST', { wpm: 20, sampleRate: SR, toneHz: 823 });
    const t = findTone(s.samples, SR);
    assert.ok(t.ok);
    // The interpolated peak must land inside a bin of the truth.
    assert.ok(Math.abs(t.hz - 823) < t.binHz, `found ${t.hz.toFixed(1)} Hz, bin is ${t.binHz.toFixed(2)} Hz`);
    assert.ok(t.snrDb > 30, `a noiseless tone should stand well clear; got ${t.snrDb.toFixed(1)} dB`);
    // The bin width comes back because the SNR figure is meaningless without it.
    assert.ok(t.binHz > 0);
  },

  // ------------------------------------------- why the bandwidth is not fixed

  async function aFixedNarrowFilterSmearsFastKeying() {
    // The claim the decoder is built around: a bandwidth that suits 12 wpm
    // destroys 40 wpm. Measured here on the envelope itself, before any
    // decoding, so the failure is attributed to the filter and nothing else.
    const s = renderCw('PARIS PARIS PARIS', { wpm: 40, sampleRate: SR, toneHz: 700 });
    const truth = ditSecondsFor(40);
    const measure = (bandwidthHz) => {
      const e = cwEnvelope(s.samples, SR, { toneHz: 700, bandwidthHz, envRate: 2000 });
      const k = keyStates(e.env, e.envRate, { windowSec: 1.5 });
      const runs = mergeShort(runLengths(k.state, e.envRate), 0.25 * timeWeightedMedian(runLengths(k.state, e.envRate))).runs;
      return clusterTiming(runs);
    };
    const narrow = measure(50);
    const wide = measure(300);
    assert.ok(wide.ok, 'the wide pass should fit');
    // The wide pass gets the unit right; the narrow one does not, because a
    // 50 Hz noise bandwidth is a 20 ms impulse response and the dit is 30 ms.
    assert.ok(Math.abs(wide.ditSec - truth) / truth < 0.05,
      `300 Hz measured ${(wide.ditSec * 1000).toFixed(1)} ms against a true 30.0 ms`);
    const narrowErr = narrow.ok ? Math.abs(narrow.ditSec - truth) / truth : Infinity;
    assert.ok(narrowErr > 0.12,
      `50 Hz should mis-measure the unit by more than 12%; it was off by ${(narrowErr * 100).toFixed(1)}%`);
  },

  async function theChosenBandwidthNarrowsWhenTheNoiseRises() {
    // Same message, same speed, two noise levels. The filter is chosen by
    // measuring the fit at each candidate, so a clean signal should keep a wide
    // one (no smearing) and a buried one should buy processing gain.
    const msg = 'PARIS ABC DE VVV';
    const clean = decodeCw(renderCw(msg, { wpm: 20, sampleRate: SR, toneHz: 700, snrDb: 20, seed: 4 }).samples, SR);
    const buried = decodeCw(renderCw(msg, { wpm: 20, sampleRate: SR, toneHz: 700, snrDb: -4, seed: 4 }).samples, SR);
    assert.ok(clean.ok && buried.ok, 'both should decode');
    assert.equal(clean.text, msg);
    assert.equal(buried.text, msg);
    assert.ok(buried.filterHz < clean.filterHz / 1.5,
      `noise should force a narrower filter: ${clean.filterHz} Hz clean vs ${buried.filterHz} Hz buried`);
    assert.ok(clean.filterSweep.length >= 5, 'the sweep should try several bandwidths');
    assert.ok(clean.filterReason.includes('tightest-fitting'));
  },

  // --------------------------------------------------------- a human at a key

  async function readsAFistThatDoesNotHoldTheOneToThreeRatio() {
    // A straight key sends long dahs and wobbles. Assuming 1:3 and slicing at
    // two units is what turns a human fist into fluent nonsense.
    const msg = 'THE QUICK BROWN FOX 1234';
    const s = renderCw(msg, { wpm: 15, sampleRate: SR, toneHz: 600, dahUnits: 4, ditJitter: 0.2, seed: 7 });
    const r = decodeCw(s.samples, SR);
    assert.ok(r.ok, `refused: ${r.reason}`);
    assert.equal(r.text, msg);
    // It must REPORT four, not three: the ratio is measured, not assumed.
    assert.ok(Math.abs(r.dahDitRatio - 4) < 0.25, `reported dah/dit ${r.dahDitRatio.toFixed(2)} for a 4:1 fist`);
    // And the wobble must show in the scatter it reports for the mark classes.
    assert.ok(r.markScatter[0].logSd > 0.02, 'a jittered fist should not report zero scatter');
  },

  async function separatesCharacterSpeedFromThroughput() {
    // Farnsworth: characters at 18 wpm, gaps stretched so the message takes as
    // long as 8 wpm would. Reporting only one number hides half of that.
    const msg = 'THE QUICK BROWN FOX';
    const s = renderCw(msg, { wpm: 18, farnsworthWpm: 8, sampleRate: SR, toneHz: 600 });
    const r = decodeCw(s.samples, SR);
    assert.ok(r.ok, `refused: ${r.reason}`);
    assert.equal(r.text, msg);
    assert.ok(Math.abs(r.wpmChar - 18) < 0.6, `character speed ${r.wpmChar.toFixed(1)}`);
    assert.ok(Math.abs(r.wpmOverall - 8) < 0.4, `throughput ${r.wpmOverall.toFixed(1)}`);
    assert.equal(r.farnsworth, true);
    // A 16-unit character gap is legitimate Morse and must not be called
    // malformed just because the standard says three.
    assert.ok(r.timingPlausible, 'Farnsworth spacing must still be read as Morse');
    assert.ok(r.spacing.ratios[1] > 6, `stretched gaps should show: ${r.spacing.ratios[1].toFixed(1)} units`);
  },

  // -------------------------------------------------------------- uncertainty

  async function refusesAFistWhoseDahsAreNotDahs() {
    // A control first: clean keying must come back fully confident, or the
    // confidence figure means nothing.
    const clean = decodeCw(renderCw('EEE TTT EEE', { wpm: 20, sampleRate: SR, toneHz: 700 }).samples, SR);
    assert.ok(clean.ok && clean.chars.every((c) => c.confidence > 0.9), 'the control must be confident');

    // Now every dah sent at two units instead of three. The two mark classes
    // are then 1 and 2, under the 2:1 the shape test demands, and each element
    // sits near the boundary. Reading it would mean guessing every character,
    // so it must be refused and the reason must name the ratio.
    const r = decodeCw(renderCw('EAT EAT EAT EAT', { wpm: 20, sampleRate: SR, toneHz: 700, dahUnits: 2 }).samples, SR);
    assert.equal(r.ok, false, `a 2:1 fist was read as "${r.text}"`);
    assert.ok(/dah\/dit/.test(r.reason), `reason was "${r.reason}"`);
  },

  async function theNoiseColoursAreTheColoursTheyClaimToBe() {
    // The generator is the instrument here, so it is calibrated before it is
    // used. Measured at 8 kHz over 6 s at seed 11: white reads a tilt of
    // +1.1 dB/decade with kurtosis 3.0 and 0.4 dB of level swing; pink -11.3 /
    // 3.0 / 5.5; faded -1.7 / 4.6 / 8.0; impulsive +7.3 / 34.1 / 9.7; bursty
    // +0.2 / 6.1 / 4.8. A test that passed because the "pink" noise was
    // accidentally white would be worse than no test at all.
    const d = Object.fromEntries(everyColour(6 * SR, 11).map(({ name, x }) => [name, describe(x, SR)]));
    assert.ok(Math.abs(d.white.tiltDbPerDecade) < 4, `white tilts ${d.white.tiltDbPerDecade.toFixed(1)} dB/decade`);
    assert.ok(d.pink.tiltDbPerDecade < -6, `pink tilts only ${d.pink.tiltDbPerDecade.toFixed(1)} dB/decade`);
    assert.ok(d.faded.swingDb > 6, `faded swings only ${d.faded.swingDb.toFixed(1)} dB`);
    assert.ok(d.impulsive.kurtosis > 12, `impulsive has kurtosis ${d.impulsive.kurtosis.toFixed(1)}`);
    assert.ok(d.bursty.swingDb > 3 && d.bursty.kurtosis > 4,
      `bursty measures swing ${d.bursty.swingDb.toFixed(1)} dB, kurtosis ${d.bursty.kurtosis.toFixed(1)}`);
    // And white must be the flat one, or the comparison below means nothing.
    assert.ok(d.white.swingDb < 2 && Math.abs(d.white.kurtosis - 3) < 0.6,
      `white measures swing ${d.white.swingDb.toFixed(1)} dB, kurtosis ${d.white.kurtosis.toFixed(1)}`);
  },

  async function refusesEveryColourOfNoiseInsteadOfReadingIt() {
    // The measurement this case exists for, made over 150 seeds per colour at
    // two span lengths before anything was changed. At 6 s: white 0/150, pink
    // 0/150, faded 1/150, impulsive 0/150, bursty 7/150 — coming back as
    // "T T CME AE", "TETNATA", "TNMTNTTN TT ME". At 3 s, where fewer runs let
    // the classes fit tighter by chance, bursty gave 5/150 more: "T GANM",
    // "N TIT", "RO K". Three gates took all of them — the word-gap class
    // scattering more than the class below it, element confidence inside a
    // tracked fade, and a key-down / key-up contrast no better than a threshold
    // dropped into a noise envelope — and the sweep now measures 0/150 on all
    // five colours at both lengths, 1,500 spans with no answer in any of them.
    // The sweep here is smaller so the suite stays affordable; the seeds are
    // the first six of that run, and they include two that used to be read.
    const answered = [];
    for (const [name, gen] of Object.entries(COLOURS)) {
      for (let seed = 1000; seed < 1006; seed++) {
        const r = decodeCw(gen(3 * SR, { seed }), SR);
        if (r.ok) answered.push(`${name} seed ${seed}: "${r.text}"`);
        if (!r.ok) assert.ok(typeof r.reason === 'string' && r.reason.length > 10, `${name} refused without saying why`);
      }
    }
    assert.deepEqual(answered, [], `noise was decoded: ${answered.join(' | ')}`);
  },

  async function refusesASteadyUnkeyedCarrier() {
    const n = 6 * SR;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.4 * Math.cos(2 * Math.PI * 800 * i / SR);
    const r = decodeCw(x, SR);
    assert.equal(r.ok, false, 'an unmodulated carrier carries no characters');
  },

  async function refusesRatherThanInventingTextWhenBuried() {
    // Measured: exact at 0 dB carrier-to-noise in the full 4 kHz band, first
    // errors at -6 dB, refusal from -8 dB down. The contract being pinned here
    // is the direction of failure — silence, not fiction.
    const msg = 'PARIS ABC 123 DE VVV';
    for (let seed = 1; seed <= 3; seed++) {
      const s = renderCw(msg, { wpm: 20, sampleRate: SR, toneHz: 700, snrDb: -14, seed });
      const r = decodeCw(s.samples, SR);
      if (r.ok) {
        assert.ok(cer(r.text, msg) < 0.5, `seed ${seed} accepted a decode with ${(cer(r.text, msg) * 100).toFixed(0)}% error`);
      }
    }
    const clear = decodeCw(renderCw(msg, { wpm: 20, sampleRate: SR, toneHz: 700, snrDb: 0, seed: 2 }).samples, SR);
    assert.ok(clear.ok && clear.text === msg, `0 dB should still be exact; got "${clear.text}"`);
  },

  async function theShapeTestKnowsMorseTimingFromChoppedNoise() {
    assert.equal(morseShaped({ ok: true, dahDitRatio: 3.0, spaceRatios: [1.02, 3.05, 7.2] }).ok, true);
    // Farnsworth: gaps far longer than the standard, still Morse.
    assert.equal(morseShaped({ ok: true, dahDitRatio: 3.0, spaceRatios: [1.0, 16, 37] }).ok, true);
    // The measured signature of a slicer chopping elements in half.
    const broken = morseShaped({ ok: true, dahDitRatio: 3.2, spaceRatios: [0.73, 1.36, 4.53] });
    assert.equal(broken.ok, false);
    assert.equal(broken.bad.length, 2, `expected both gap ratios to be named: ${broken.bad.join(' / ')}`);
    assert.equal(morseShaped({ ok: true, dahDitRatio: 9.8, spaceRatios: [1.0, 3.0, 7.0] }).ok, false);
  },

  // ------------------------------------------------ silence that is not signal

  async function mutesTheStretchThatIsNotThisSignal() {
    // Morse, then a burst of noise at the same audio frequency: the level tells
    // you nothing (the noise is loud) but the run lengths do, because chatter is
    // an order of magnitude shorter than any element.
    const msg = 'CQ DE W1AW';
    const cw = renderCw(msg, { wpm: 20, sampleRate: SR, toneHz: 700, tailSec: 0.1 });
    const junk = noise(4, 21, 0.25);
    const x = new Float32Array(cw.samples.length + junk.length);
    x.set(cw.samples, 0);
    x.set(junk, cw.samples.length);
    const r = decodeCw(x, SR);
    assert.ok(r.ok, `refused: ${r.reason}`);
    assert.equal(r.text, msg, `read "${r.text}"`);
    assert.ok(r.warnings.some((w) => /muted/.test(w)), `no muting was reported: ${r.warnings.join(' | ')}`);
  },

  async function theSquelchLeavesASpanItCannotJudgeAlone() {
    // Fed nothing but chatter, the reference scale comes from the chatter, so
    // muting everything would be circular. It declines and says so — on every
    // colour, because the scale it compares against is the span's own and a
    // bursty or fading span is exactly where a scale drawn from the loud part
    // could delete the quiet part.
    for (const { name, x } of everyColour(3 * SR, 31)) {
      const e = cwEnvelope(x, SR, { toneHz: 700, bandwidthHz: 300, envRate: 1000 });
      const k = keyStates(e.env, e.envRate, { windowSec: 1.5 });
      const sq = squelchIncoherent(k.state, e.envRate, { windowSec: 1 });
      assert.ok(sq.muted < 0.9, `${name}: the squelch deleted ${(sq.muted * 100).toFixed(0)}% of a span on its own reference`);
    }
  },

  // ------------------------------------------------------------------- DTMF

  async function readsEveryDtmfKey() {
    const seq = '0123456789ABCD*#';
    const r = detectDtmf(renderDtmf(seq, { sampleRate: SR }).samples, SR);
    assert.ok(r.ok);
    assert.equal(r.sequence, seq, `read "${r.sequence}"`);
    for (const d of r.digits) {
      const pair = dtmfPair(d.digit);
      assert.equal(d.lowHz, pair.lowHz);
      assert.equal(d.highHz, pair.highHz);
      // An ideal pair puts exactly half the frame's mean square into the two
      // Goertzel bins, because a unit tone reads 0.25 against a mean square of 0.5.
      assert.ok(Math.abs(d.fraction - 0.5) < 0.06, `${d.digit} held ${d.fraction.toFixed(3)} of the frame`);
      assert.ok(d.confidence > 0.3, `${d.digit} came in at confidence ${d.confidence.toFixed(2)}`);
    }
    assert.equal(DTMF_LOW.length, 4);
    assert.equal(DTMF_HIGH.length, 4);
  },

  async function appliesTheQ24DurationAndPauseLimits() {
    // Q.24: a tone of 40 ms or more must be accepted, 23 ms or less rejected.
    assert.equal(detectDtmf(renderDtmf('5', { digitMs: 40, gapMs: 60 }).samples, SR).digits.length, 1);
    assert.equal(detectDtmf(renderDtmf('5', { digitMs: 80, gapMs: 60 }).samples, SR).digits.length, 1);
    const short = detectDtmf(renderDtmf('5', { digitMs: 20, gapMs: 60 }).samples, SR);
    assert.equal(short.digits.length, 0, 'a 20 ms tone is not a digit');
    // Q.24: a 40 ms pause separates two digits; a short break inside one does not.
    assert.equal(detectDtmf(renderDtmf('55', { digitMs: 80, gapMs: 40 }).samples, SR).sequence, '55');
    assert.equal(detectDtmf(renderDtmf('55', { digitMs: 80, gapMs: 15 }).samples, SR).sequence, '5');
  },

  async function appliesTheTwistLimits() {
    const seq = '0123456789ABCD*#';
    const at = (twistDb) => detectDtmf(renderDtmf(seq, { twistDb }).samples, SR).digits.length;
    assert.equal(at(0), 16, 'no twist must pass');
    assert.ok(at(3) >= 15, `3 dB of forward twist should pass; ${at(3)} of 16 did`);
    assert.ok(at(-7) >= 15, `7 dB of reverse twist should pass; ${at(-7)} of 16 did`);
    assert.equal(at(6), 0, 'forward twist past the limit must be refused');
    assert.equal(at(-11), 0, 'reverse twist past the limit must be refused');
    assert.equal(Q24.forwardTwistDb <= 5 && Q24.reverseTwistDb <= 9, true);
  },

  async function appliesTheQ24FrequencyTolerance() {
    const seq = '147*';
    const at = (detuneFraction) => detectDtmf(renderDtmf(seq, { detuneFraction }).samples, SR).digits.length;
    // Must accept 1.5% off nominal ...
    assert.equal(at(0.015), 4, 'a tone 1.5% off must still be a digit');
    // ... and must reject 3.5% off.
    assert.equal(at(0.035), 0, 'a tone 3.5% off is not a digit');
    assert.equal(at(-0.035), 0, 'and not on the low side either');
  },

  async function findsNoDigitsInSpeech() {
    // The gate that matters. A Goertzel bank with only a level threshold finds
    // digits in every vowel; run over four seconds of formant-shaped voicing
    // this must find none, and must say which gate did the refusing.
    const v = renderVoiceLike({ sampleRate: SR, seconds: 4, seed: 3 });
    const r = detectDtmf(v.samples, SR);
    assert.ok(r.ok);
    assert.equal(r.digits.length, 0, `speech produced "${r.sequence}"`);
    assert.ok(r.frames > 300, `only ${r.frames} frames were examined`);
    const worked = r.rejected.offFrequency + r.rejected.dominance + r.rejected.harmonic;
    assert.ok(worked > r.frames * 0.5,
      `the purity gates should be doing the work: ${JSON.stringify(r.rejected)}`);

    // One pitch is one sample of one. A glottal source at 130 Hz puts a
    // harmonic every 130 Hz, and whether one of them lands on a bank frequency
    // while another lands on the octave the harmonic gate is watching is a
    // property of that pitch and not of the detector. So the pitch is swept
    // across the speech range instead. Measured over f0 = 80 to 250 Hz in 5 Hz
    // steps x three vowel inventories x four seeds — 420 spans — the detector
    // produced a digit in 0 of them, and over 80 to 250 in 10 Hz steps x four
    // jitters (including a perfectly periodic source) x two seeds x two levels,
    // 0 of 288, with no run ever reaching the duration gate. The sweep below is
    // the coarse version of the first of those.
    const spoke = [];
    for (let f0 = 80; f0 <= 250; f0 += 20) {
      for (const seed of [3, 9]) {
        const s = renderVoiceLike({ sampleRate: SR, seconds: 2, seed, f0 });
        const d = detectDtmf(s.samples, SR);
        if (d.digits.length) spoke.push(`f0 ${f0} seed ${seed}: "${d.sequence}"`);
      }
    }
    assert.deepEqual(spoke, [], `speech produced digits: ${spoke.join(' | ')}`);
    // A second vowel inventory, in case the first was lucky.
    const v2 = renderVoiceLike({ sampleRate: SR, seconds: 4, seed: 9, f0: 190, vowels: [[520, 1190, 2390], [300, 2200, 3000], [660, 1720, 2410]] });
    assert.equal(detectDtmf(v2.samples, SR).digits.length, 0);
  },

  async function stillFindsRealSignalInEveryColour() {
    // The other side of every refusal above, and the reason it is a fix rather
    // than a mute button. The signal is rendered clean and the colour is added
    // at a level set to a stated carrier-to-noise ratio in the full audio band,
    // so the number means the same thing on every colour.
    //
    // Measured, taking "found" as the exact message in at least 3 of 4 seeds:
    // Morse at 20 wpm is read down to -3 dB in white, -6 dB in pink, 0 dB
    // against a Rayleigh-faded floor and +6 dB against impulsive crashes and
    // against gated noise. DTMF holds every digit to +6 dB in white, pink and
    // gated noise, +9 dB faded, +15 dB impulsive. A CCIR-1 call holds to +6 dB
    // in white and gated noise, +9 dB in pink and faded, +12 dB impulsive.
    // Impulsive noise costs the most everywhere, which is what a crash shorter
    // than an analysis frame does to any of these.
    //
    // The bar below is +12 dB, comfortably inside all of those, so this case
    // fails if a later gate starts refusing signal rather than noise.
    const rms = (v) => { let t = 0; for (const q of v) t += q * q; return Math.sqrt(t / v.length); };
    const mix = (clean, gen, snrDb, seed, carrierRms) => {
      const n = gen(clean.length, { seed, sigma: 0.05 });
      const k = (carrierRms / Math.pow(10, snrDb / 20)) / (rms(n) || 1e-12);
      return Float32Array.from(clean, (v, i) => v + k * n[i]);
    };
    const msg = 'PARIS ABC DE VVV';
    const cw = renderCw(msg, { wpm: 20, sampleRate: SR, toneHz: 700, amplitude: 0.5 }).samples;
    const dtmf = renderDtmf('19*', { sampleRate: SR, amplitude: 0.35 }).samples;
    const sel = renderSelcall('120079', { set: 'CCIR1', sampleRate: SR, amplitude: 0.4 }).samples;
    for (const [name, gen] of Object.entries(COLOURS)) {
      const r = decodeCw(mix(cw, gen, 12, 1, 0.5 / Math.SQRT2), SR);
      assert.ok(r.ok, `${name} at +12 dB refused a real signal: ${r.reason}`);
      assert.equal(r.text, msg, `${name} at +12 dB read "${r.text}"`);
      assert.equal(detectDtmf(mix(dtmf, gen, 15, 1, 0.35), SR).sequence, '19*',
        `${name} lost DTMF digits at +15 dB`);
      assert.equal(detectSelcall(mix(sel, gen, 12, 1, 0.4 / Math.SQRT2), SR, { set: 'CCIR1' }).sequences.join(''), '120079',
        `${name} lost the CCIR-1 call at +12 dB`);
    }
  },

  async function findsNoDigitsInAnyColourOfNoise() {
    // Measured over 150 seeds per colour on 6 s spans: 0 digits on white, pink,
    // Rayleigh-faded, impulsive and gated noise alike. The DTMF gates hold
    // across colour because none of them is a level test — the frequency,
    // twist, purity and harmonic gates all ask about the shape of one frame,
    // and a tilt or a fade or a crash changes the level rather than the shape.
    // It is recorded here so that a later loosening of any of them shows up.
    const spoke = [];
    for (const [name, gen] of Object.entries(COLOURS)) {
      for (let seed = 1000; seed < 1012; seed++) {
        const x = gen(3 * SR, { seed });
        const d = detectDtmf(x, SR);
        if (d.digits.length) spoke.push(`${name} ${seed}: "${d.sequence}"`);
        for (const set of ['CCIR1', 'ZVEI1']) {
          const q = detectSelcall(x, SR, { set });
          if (q.calls.length) spoke.push(`${name} ${seed} ${set}: ${JSON.stringify(q.sequences)}`);
        }
      }
    }
    assert.deepEqual(spoke, [], `noise produced signalling: ${spoke.join(' | ')}`);
    // And the detector must actually have run on all of it, not skipped it on
    // level: an empty digit list because nothing was loud enough would say
    // nothing about the gates that matter.
    const r = detectDtmf(COLOURS.pink(3 * SR, { seed: 1000 }), SR);
    assert.ok(r.frames > 200, `only ${r.frames} frames examined`);
    assert.ok(r.rejected.level < r.frames * 0.5,
      `the level gate did the work rather than the purity gates: ${JSON.stringify(r.rejected)}`);
  },

  async function dropsDigitsRatherThanInventingThemInNoise() {
    // Measured: exact to +6 dB, first losses at +4 dB, nothing at all by +2 dB.
    // What must never happen is a digit that was not sent.
    const seq = '19*';
    for (let seed = 1; seed <= 4; seed++) {
      const r = detectDtmf(renderDtmf(seq, { snrDb: 0, seed }).samples, SR);
      for (const d of r.digits) assert.ok(seq.includes(d.digit), `invented a ${d.digit} at 0 dB`);
    }
    assert.equal(detectDtmf(renderDtmf(seq, { snrDb: 12, seed: 5 }).samples, SR).sequence, seq);
    // The same question asked with noise that is not white. The digits are
    // rendered clean and the colour is added at a measured level, so what is
    // being tested is the gates and not the renderer's own noise model.
    for (const [name, gen] of Object.entries(COLOURS)) {
      const clean = renderDtmf(seq, { sampleRate: SR }).samples;
      const n = gen(clean.length, { seed: 7, sigma: 0.09 });
      const x = Float32Array.from(clean, (v, i) => v + n[i]);
      const r = detectDtmf(x, SR);
      for (const d of r.digits) assert.ok(seq.includes(d.digit), `${name} invented a ${d.digit}`);
    }
  },

  // ---------------------------------------------------------------- selcall

  async function readsCcirAndZveiSequencesAndExpandsTheRepeatTone() {
    for (const set of ['CCIR1', 'ZVEI1']) {
      for (const q of ['120079', '1122334455', 'ABCDF']) {
        const s = renderSelcall(q, { set, sampleRate: SR });
        const r = detectSelcall(s.samples, SR, { set });
        assert.ok(r.ok);
        assert.equal(r.sequences.join(''), q, `${set} read "${r.sequences.join('')}" for ${q}`);
        // A repeated digit must have gone out as the repeat tone and come back
        // as the digit: that round trip is the whole reason E exists.
        if (/(.)\1/.test(q)) assert.ok(s.sent.includes(SELCALL_SETS[set].repeat), `${set} did not use its repeat tone`);
        assert.ok(r.calls.every((b) => b.coverage > 0.85));
      }
    }
  },

  async function willNotSendTheRepeatToneAsData() {
    assert.throws(() => renderSelcall('12E4', { set: 'CCIR1' }), /repeat tone/);
  },

  async function willNotCallAKeyedCarrierASelcallSequence() {
    // CCIR-1's D is 991 Hz and the M08 numbers station's CW note is 997 Hz,
    // 0.6% away — inside any sane frequency tolerance. Morse keyed on that note
    // gives a detector a long run of perfectly good 'D' tones. What it does not
    // give is a contiguous tone sequence, and that is the difference.
    const cw = renderCw('CQ DE W1AW K', { wpm: 15, sampleRate: SR, toneHz: 991, amplitude: 0.4 });
    const r = detectSelcall(cw.samples, SR, { set: 'CCIR1' });
    assert.ok(r.ok);
    assert.ok(r.tones.length > 5, `the tones really are there: ${r.tones.length} found`);
    assert.equal(r.calls.length, 0, `keyed Morse was reported as ${JSON.stringify(r.sequences)}`);
    assert.ok(r.warnings.some((w) => /not contiguous/.test(w)), r.warnings.join(' | '));
  },

  async function findsNoSelcallInSpeech() {
    // Swept across the speech pitch range for the same reason the DTMF case is:
    // which harmonic of the glottal source lands on a table entry depends on
    // f0, so one pitch tests one accident. Measured over f0 = 80 to 250 Hz in
    // 10 Hz steps x three seeds x both sets — 108 spans — 0 calls.
    const found = [];
    for (let f0 = 80; f0 <= 250; f0 += 20) {
      for (const seed of [5, 9]) {
        const v = renderVoiceLike({ sampleRate: SR, seconds: 2, seed, f0 });
        for (const set of ['CCIR1', 'ZVEI1']) {
          const r = detectSelcall(v.samples, SR, { set });
          if (r.calls.length) found.push(`${set} f0 ${f0} seed ${seed}: ${JSON.stringify(r.sequences)}`);
        }
      }
    }
    assert.deepEqual(found, [], `speech produced calls: ${found.join(' | ')}`);
  },

  async function namesTheAlternativeSetsRatherThanPickingOneSilently() {
    const s = renderSelcall('90210', { set: 'ZVEI1', sampleRate: SR });
    const ranked = identifySelcall(s.samples, SR);
    assert.equal(ranked.length, Object.keys(SELCALL_SETS).length, 'every set must be reported on');
    assert.equal(ranked[0].set, 'ZVEI1', `ranked ${ranked.map((o) => o.set).join(' > ')}`);
    assert.deepEqual(ranked[0].sequences, ['90210']);
    // The loser is still in the list with its own reading, because a single-tone
    // sequence carries no header saying which table it came from.
    assert.ok(ranked[1].secondsHeld <= ranked[0].secondsHeld);
  },
  // ------------------------------------------------------------------ fading

  async function readsThroughADeepFadeInsteadOfInventingText() {
    // The defect this exists for, reproduced exactly: 'DE VVV TEST' at 18 wpm,
    // a 0.8 Hz fade 97% deep, no noise and no frequency change of any kind.
    // A slicer that fits one threshold over a window of a few characters reads
    // the elements in the peaks and loses the ones in the nulls, and the text
    // it assembles from what is left is wrong in a way nothing in the result
    // shows: measured, "T E I EV A E EST" with a mean character confidence of
    // 0.905 and one character in ten marked.
    const msg = 'DE VVV TEST';
    const x = faded(msg, { wpm: 18 });

    // The old behaviour, still reachable, and still exactly as bad — this is
    // the control, not a hypothetical. Every gate added since has to be turned
    // off by hand to see it, which is itself the record of what they catch.
    const ALL_OFF = {
      agc: false, maxBoundaryDoubt: 1, maxSpaceClassExcessSd: 99,
      fadeDoubtDepthDb: 999, minKeyingSnrDb: -99,
    };
    const untracked = decodeCw(x, SR, ALL_OFF);
    assert.notEqual(untracked.text, msg, 'the untracked slicer is supposed to fail here');
    assert.equal(untracked.ok, true, 'and to fail while saying it succeeded, which is the point');

    // Tracking the key-down level and dividing it out reads the message.
    const r = decodeCw(x, SR);
    assert.ok(r.ok, `refused: ${r.reason}`);
    assert.equal(r.text, msg, `read "${r.text}" through the fade`);
    assert.equal(r.agc, true, 'the tracked slicing should have won the comparison');
    assert.equal(r.chars.filter((c) => c.uncertain).length, 0, 'and should flag nothing');
    // The fade itself is reported, because a reader wants to know it was there.
    assert.ok(r.fadeDepthDb > 15, `the 30 dB fade should be visible: ${r.fadeDepthDb.toFixed(1)} dB`);
    // A signal that does not fade must not be told that it does.
    const steady = decodeCw(renderCw(msg, { wpm: 18, sampleRate: SR, toneHz: 700 }).samples, SR);
    assert.ok(steady.fadeDepthDb < 5, `a steady carrier reported ${steady.fadeDepthDb.toFixed(1)} dB of fade`);
    assert.equal(steady.agc, false, 'and the tracker must not win on a signal it cannot help');
    // Forced on, it still reads the steady signal — it is not chosen there
    // because it fits no better, not because it breaks anything.
    const forced = decodeCw(renderCw(msg, { wpm: 18, sampleRate: SR, toneHz: 700 }).samples, SR, { agc: 'always' });
    assert.ok(forced.ok && forced.text === msg, `forced tracking read ${JSON.stringify(forced.text)}`);
    assert.ok(forced.runScatter >= steady.runScatter, 'and fits no tighter than leaving it alone');
  },

  async function refusesAFadeThatTookTheSignalUnderTheNoise() {
    // The realistic fade, and the one the previous fix did not cover. A fade
    // applied to a whole recording takes the noise down with the signal and the
    // level tracker reads it straight back. Propagation does not work that way:
    // it fades the TRANSMISSION while the receiver's own noise floor stays
    // exactly where it is, so the signal-to-noise ratio moves through the fade
    // cycle and the elements keyed in the nulls were never received at all.
    // `faded` above builds that case — the fade multiplies the signal, the noise
    // is added afterwards.
    //
    // Measured over the whole 7 depths x 4 signal-to-noise ratios x 6 seeds
    // grid before the gates below existed: 168 spans, of which 29 came back
    // with `ok: true` and the wrong message — "T E I EV A E EST" for
    // "DE VVV TEST", "G VVV NST", "DE VVV TESTE" — at mean confidences up to
    // 0.95, and the boundary-doubt gate read 0% on nearly all of them. After:
    // 0 of 168 wrong, and 85 read exactly against 89 before — the price is
    // those 4, all of them at 13 dB of fade or more. The grid below is the
    // affordable corner of that one — 5 depths x 4 ratios x 2 seeds — on which
    // 18 of 40 read exactly, 22 are refused and none is confidently wrong.
    //
    // Where the boundary sits, measured on this grid: exact at every seed
    // through an 80% fade (13 dB) at +30 dB and better, and through a 99% fade
    // (26 dB) at +40 dB; the first refusals appear at 80% and +20 dB; from 90%
    // and +20 dB down every seed is refused.
    const msg = 'DE VVV TEST';
    let wrongAndConfident = 0, refused = 0, exact = 0;
    const bad = [];
    for (const depth of [0, 0.8, 0.9, 0.95, 0.99]) {
      for (const snrDb of [40, 30, 20, 10]) {
        for (const seed of [1, 2]) {
          const r = decodeCw(faded(msg, { wpm: 18, depth, snrDb, seed }), SR);
          if (!r.ok) { refused++; continue; }
          if (r.text === msg) { exact++; continue; }
          wrongAndConfident++;
          bad.push(`${(depth * 100).toFixed(0)}% at +${snrDb} dB seed ${seed}: "${r.text}" at ${r.meanConfidence.toFixed(2)}`);
        }
      }
    }
    assert.equal(wrongAndConfident, 0, `confident wrong reads: ${bad.join(' | ')}`);
    // And it must not have got there by refusing everything: the shallow and
    // strong end of the grid still reads.
    assert.ok(exact >= 16, `only ${exact} of ${exact + refused} spans were read at all`);

    // Each gate pinned by turning it off, because a guard no test defends rots.
    // First: the word-gap class that has become a mixture of real word gaps and
    // the gaps left where a character was swallowed.
    const mixture = faded(msg, { wpm: 18, depth: 0.97, snrDb: 10, seed: 1 });
    const mixOff = decodeCw(mixture, SR, { maxSpaceClassExcessSd: 99, fadeDoubtDepthDb: 999, minKeyingSnrDb: -99 });
    assert.equal(mixOff.ok, true, 'with the gates off this span is supposed to come back confident');
    assert.notEqual(mixOff.text, msg, `and wrong; it read "${mixOff.text}"`);
    const mixOn = decodeCw(mixture, SR, { fadeDoubtDepthDb: 999, minKeyingSnrDb: -99 });
    assert.equal(mixOn.ok, false, 'the space-class gate alone must refuse it');
    assert.ok(mixOn.mixedSpaceClass && mixOn.spaceExcessSd > 0.08,
      `excess scatter was ${mixOn.spaceExcessSd.toFixed(3)}`);
    assert.ok(/holding both word gaps/.test(mixOn.reason), mixOn.reason);

    // Second: elements read out of the weak half of a fade cycle. This span's
    // classes are tight — the gate above sees nothing wrong with it — and the
    // message is still wrong.
    const nulled = faded(msg, { wpm: 18, depth: 0.9, snrDb: 20, seed: 1 });
    const fadeOff = decodeCw(nulled, SR, { maxSpaceClassExcessSd: 99, fadeDoubtDepthDb: 999, minKeyingSnrDb: -99 });
    assert.equal(fadeOff.ok, true, 'with the gates off this span is supposed to come back confident');
    assert.notEqual(fadeOff.text, msg, `and wrong; it read "${fadeOff.text}"`);
    assert.ok(fadeOff.spaceExcessSd < 0.08,
      `this span is supposed to be the one the class-scatter gate cannot see: ${fadeOff.spaceExcessSd.toFixed(3)}`);
    const fadeOn = decodeCw(nulled, SR, { maxSpaceClassExcessSd: 99, minKeyingSnrDb: -99 });
    assert.equal(fadeOn.ok, false, 'the fade-confidence gate alone must refuse it');
    assert.ok(fadeOn.fadeDoubt && fadeOn.fadeDepthDb > 10 && fadeOn.meanConfidence < 0.955,
      `fade ${fadeOn.fadeDepthDb.toFixed(0)} dB at confidence ${fadeOn.meanConfidence.toFixed(3)}`);
    assert.ok(/went under the noise/.test(fadeOn.reason), fadeOn.reason);

    // And the gate must not fire on a fade the receiver heard all of: the same
    // 97% fade with no noise under it still reads, which is the case the level
    // tracker was built for.
    const noNoise = decodeCw(faded(msg, { wpm: 18, depth: 0.97 }), SR);
    assert.ok(noNoise.ok && noNoise.text === msg, `a noiseless 97% fade must still read: ${noNoise.reason || noNoise.text}`);
    assert.ok(noNoise.meanConfidence > 0.955,
      `and by a margin: ${noNoise.meanConfidence.toFixed(3)} against a bar of 0.955`);
  },

  async function aSloppySenderIsNotAMixedClass() {
    // The cost of the space-class gate, measured on the thing it could plausibly
    // hurt: a hand whose SPACING wobbles, which `ditJitter` could not render
    // because it only ever moved the elements and the gaps inside a character.
    // `gapJitter` moves the character and word gaps, which is what a straight
    // key actually does. Measured across five seeds: at +-10% every space class
    // scatters about 0.06 in log units and the message reads exactly; at +-20%
    // the top class reaches 0.118, still reads exactly, and still clears the
    // gate because what the gate reads is the EXCESS over the class below it
    // and a sloppy hand widens every class together.
    const msg = 'CQ CQ DE W1AW K';
    for (const gapJitter of [0.1, 0.2]) {
      for (const seed of [1, 2, 3]) {
        const r = decodeCw(renderCw(msg, { wpm: 18, sampleRate: SR, toneHz: 700, gapJitter, seed }).samples, SR);
        assert.ok(r.ok, `+-${gapJitter * 100}% spacing seed ${seed} refused: ${r.reason}`);
        assert.equal(r.text, msg, `+-${gapJitter * 100}% spacing seed ${seed} read "${r.text}"`);
        assert.equal(r.mixedSpaceClass, false, `excess scatter ${r.spaceExcessSd.toFixed(3)}`);
      }
    }
    // The gaps really are being jittered, or this measures nothing: at +-20%
    // the fitted space classes must be visibly wider than a machine's.
    const sloppy = decodeCw(renderCw(msg, { wpm: 18, sampleRate: SR, toneHz: 700, gapJitter: 0.2, seed: 1 }).samples, SR);
    const machine = decodeCw(renderCw(msg, { wpm: 18, sampleRate: SR, toneHz: 700 }).samples, SR);
    const widest = (r) => Math.max(...r.spacing.classes.map((c) => c.logSd));
    assert.ok(widest(sloppy) > 0.05, `a +-20% hand scattered only ${widest(sloppy).toFixed(3)}`);
    assert.ok(widest(machine) < 0.01, `a machine scattered ${widest(machine).toFixed(3)}`);
  },

  async function theFadeTrackerCannotLiftNoiseIntoSignal() {
    // The tracker divides by a level it measures, so the question that decides
    // whether it is safe is what bounds that division. Fed nothing but noise,
    // the tracked level must stay at its floor rather than following the noise
    // up and handing the slicer a normalised signal that looks keyed.
    // Asked on every colour, and the answer is not the same on every colour —
    // which is worth recording rather than asserting away. The bound is a
    // percentile floor: a block may anchor the level tracker only if its 90th
    // percentile clears its own 10th by 16 dB, and the reason 16 is enough is
    // that a Rayleigh envelope shows about 10 dB between its deciles whether
    // there is keying under it or not. That is a fact about white Gaussian
    // noise. Measured at 6 s, seed 17, the tracker anchors on 2% of blocks
    // under white and 8% under pink and invents 0.0 and 1.0 dB of fade — and
    // then 26% under Rayleigh-faded noise (7.3 dB), 39% under atmospheric
    // crashes (19.3 dB) and 70% under gated noise (4.4 dB). A crash lasting a
    // good fraction of a block raises that block's 90th percentile without
    // touching its 10th, so the anchoring test is not measuring what it was
    // derived to measure.
    //
    // So the strict bound is asserted where its argument holds, the measured
    // behaviour is pinned where it does not, and the invariant that actually
    // matters — no text out of any of it — is asserted separately below. The
    // cost of the inflated depth is real but small: it feeds the fade-
    // confidence gate, and disabling that gate recovers one span in a 5 colour
    // x 6 ratio x 4 seed recall grid, at +12 dB against impulsive noise.
    const tracked = {};
    for (const { name, x } of everyColour(6 * SR, 17)) {
      const e = cwEnvelope(x, SR, { toneHz: 700, bandwidthHz: 400, envRate: 2000 });
      const ft = fadeTrack(e.env, e.envRate, { unitSec: 0.06 });
      assert.ok(ft, `${name}: six seconds is long enough to track`);
      tracked[name] = { fraction: ft.anchors / ft.blocks, depthDb: ft.depthDb };
    }
    for (const name of ['white', 'pink']) {
      assert.ok(tracked[name].fraction < 0.25,
        `${name} gave the tracker ${(tracked[name].fraction * 100).toFixed(0)}% of its blocks as anchors`);
      assert.ok(tracked[name].depthDb < 12, `${name}: ${tracked[name].depthDb.toFixed(1)} dB of imaginary fade`);
    }
    assert.ok(tracked.impulsive.depthDb > 12,
      `impulsive noise is supposed to defeat this bound — it reported ${tracked.impulsive.depthDb.toFixed(1)} dB, `
      + 'so either the generator or the tracker has changed and the note above needs re-measuring');
    assert.ok(tracked.bursty.fraction > 0.5,
      `gated noise anchored only ${(tracked.bursty.fraction * 100).toFixed(0)}% of its blocks`);
    // And the decode over the same noise still refuses, tracker or no tracker —
    // on every colour, not only on the white one the tracker's null was
    // derived under. Rayleigh-faded noise has a level that moves like a fade
    // and gated noise has run-length structure by construction, which is why
    // those two are the colours that used to be read.
    for (const [name, gen] of Object.entries(COLOURS)) {
      for (let seed = 1010; seed < 1013; seed++) {
        const r = decodeCw(gen(4 * SR, { seed }), SR);
        assert.equal(r.ok, false, `${name} seed ${seed} decoded as "${r.text}"`);
      }
    }
  },

  async function keyingThatIsOnlyAThresholdSplitOfNoiseIsRefused() {
    // The gate that took the last of the coloured-noise false accepts, pinned
    // by turning it off. It is not a gate on looseness: a 40%-jitter hand fist
    // clusters its run lengths no better than these noise seeds do — 0.20 in
    // log units against 0.08 to 0.27 — and reads its message exactly. It is a
    // gate on contrast, and the reason the number is where it is comes from the
    // envelope's own distribution rather than from this recording: a Rayleigh
    // envelope shows about 10 dB between its upper and lower deciles whether
    // there is keying under it or not, so a key-down / key-up power ratio near
    // that has measured the noise and not a transmission.
    // Five of the 27 spans that answered when this gate alone was disabled —
    // 25 of them gated noise, 2 Rayleigh-faded, none white, pink or impulsive.
    const seeds = [['bursty', 1008, 3], ['bursty', 1021, 3], ['bursty', 1053, 3], ['bursty', 1042, 6], ['faded', 1010, 6]];
    const answered = [];
    for (const [name, seed, secs] of seeds) {
      const x = COLOURS[name](secs * SR, { seed });
      const off = decodeCw(x, SR, { minKeyingSnrDb: -99 });
      if (off.ok) answered.push(`${name} ${secs}s ${seed}: "${off.text}" at ${off.keyingSnrDb.toFixed(1)} dB, scatter ${off.runScatter.toFixed(3)}`);
      const on = decodeCw(x, SR);
      assert.equal(on.ok, false, `${name} ${secs}s seed ${seed} decoded as "${on.text}"`);
    }
    assert.equal(answered.length, seeds.length,
      `with the gate off every one of these seeds must come back as text, or the gate pins nothing: ${answered.join(' | ')}`);
    const said = decodeCw(COLOURS.bursty(3 * SR, { seed: 1008 }), SR).reason;
    assert.ok(/threshold split of a noise envelope/.test(said), said);

    // And what it costs, stated rather than hoped for. Over 373 spans that
    // decoded exactly across three messages, three speeds, +20 dB down to -8 dB
    // and three element jitters, the contrast ran 10.9 dB at worst with a
    // median of 14.9; the bar at 11.5 dB costs 4 of those 373, all of them
    // 40%-jittered fists at -4 dB and below. Both ends are pinned here.
    const msg = 'PARIS ABC 123 DE VVV';
    const weak = decodeCw(renderCw(msg, { wpm: 20, sampleRate: SR, toneHz: 700, snrDb: -4, seed: 4 }).samples, SR);
    assert.ok(weak.ok && weak.text === msg, `a clean signal at -4 dB must still read: ${weak.reason}`);
    assert.ok(weak.keyingSnrDb > 11.5,
      `and its contrast must clear the bar: ${weak.keyingSnrDb.toFixed(1)} dB`);
    const fist = decodeCw(renderCw('CQ CQ DE W1AW K', { wpm: 18, sampleRate: SR, toneHz: 700, ditJitter: 0.4, seed: 3 }).samples, SR);
    assert.ok(fist.ok && fist.text === 'CQ CQ DE W1AW K', `a 40% fist must still read: ${fist.reason}`);
    assert.ok(fist.runScatter > 0.12 && fist.keyingSnrDb > 20,
      `it survives on contrast, not on tightness: scatter ${fist.runScatter.toFixed(3)} at ${fist.keyingSnrDb.toFixed(1)} dB`);
  },

  // -------------------------------------------------------------- confidence

  async function aWideClassCannotProduceAConfidentElement() {
    // Two ways an element can be unreadable, and the number has to fall for
    // both. Position is the one the margin measure sees.
    const tight = [
      { logCentre: 0, logSd: 0.004, count: 50 },
      { logCentre: Math.log(3), logSd: 0.004, count: 50 },
    ];
    assert.ok(elementConfidence(1, tight, 0) > 0.99, 'a clean element at its own centre is certain');
    assert.ok(elementConfidence(Math.sqrt(3), tight, 0) < 0.05, 'one at the boundary is not');

    // Scale is the one it does not. These two classes are 1.7 apart in ratio
    // with a log scatter of 0.25 each — the loosest split the timing fit will
    // accept — so they genuinely overlap, and an element sitting exactly on a
    // centre still cannot be safely called. The margin term alone, which is
    // what this returned before, reports 1.0000 for it.
    const loose = [
      { logCentre: 0, logSd: 0.25, count: 50 },
      { logCentre: Math.log(1.7), logSd: 0.25, count: 50 },
    ];
    const marginOnly = 1;                       // |l - other| - |l - mine| == sep
    const got = elementConfidence(1, loose, 0);
    assert.ok(got < 0.95 && got > 0.8, `overlapping classes gave ${got.toFixed(4)}`);
    assert.ok(got < marginOnly, 'the posterior must cost something the margin does not');
  },

  async function confidenceFallsAsTheFistStopsClustering() {
    // Increasing jitter on a message that still decodes exactly: the text is
    // right every time, so any fall in confidence is about the timing and not
    // about the reading.
    const msg = 'THE QUICK BROWN FOX 1234';
    let last = 1.01;
    for (const ditJitter of [0, 0.15, 0.3, 0.4]) {
      const s = renderCw(msg, { wpm: 15, sampleRate: SR, toneHz: 600, ditJitter, seed: 7 });
      const r = decodeCw(s.samples, SR);
      assert.ok(r.ok, `${ditJitter} jitter refused: ${r.reason}`);
      assert.equal(r.text, msg, `${ditJitter} jitter read "${r.text}"`);
      assert.ok(r.meanConfidence < last,
        `confidence did not fall at ${ditJitter} jitter: ${r.meanConfidence.toFixed(3)} vs ${last.toFixed(3)}`);
      last = r.meanConfidence;
    }
    // Measured: 1.00, 0.82, 0.64, 0.51 over those four. The refusal gate must
    // not fire on any of them — a wobbly fist is legitimate Morse, its doubt
    // is in the elements and not in the boundaries between characters, and the
    // gate is on the boundaries for exactly that reason.
    assert.ok(last < 0.6, `the wobbliest fist still reported ${last.toFixed(3)}`);
    const wobbliest = decodeCw(renderCw(msg, { wpm: 15, sampleRate: SR, toneHz: 600, ditJitter: 0.4, seed: 7 }).samples, SR);
    assert.ok(wobbliest.ok && wobbliest.text === msg, `40% jitter: ${wobbliest.ok ? wobbliest.text : wobbliest.reason}`);
    assert.equal(wobbliest.boundaryDoubt, 0, 'element wobble is not boundary doubt');
  },

  // ------------------------------------------------------------- error bars

  async function theUnitsErrorBarSurvivesItsOwnSplitHalf() {
    // Every number this returns with an interval has to survive being measured
    // twice. The two halves of the span are fitted separately and both must
    // land inside the interval the whole span reports; where they do not, the
    // interval is widened until they do, and `splitHalf` says so.
    const spans = [
      ['clean 20 wpm', renderCw('PARIS ABC DE VVV', { wpm: 20, sampleRate: SR, toneHz: 700 }).samples],
      ['0 dB', renderCw('PARIS ABC 123 DE VVV', { wpm: 20, sampleRate: SR, toneHz: 700, snrDb: 0, seed: 2 }).samples],
      ['4:1 fist', renderCw('THE QUICK BROWN FOX 1234', { wpm: 15, sampleRate: SR, toneHz: 600, dahUnits: 4, ditJitter: 0.2, seed: 7 }).samples],
      ['farnsworth', renderCw('THE QUICK BROWN FOX', { wpm: 18, farnsworthWpm: 8, sampleRate: SR, toneHz: 600 }).samples],
      ['97% fade', faded('DE VVV TEST', { wpm: 18 })],
    ];
    for (const [name, x] of spans) {
      const r = decodeCw(x, SR);
      assert.ok(r.ok, `${name} refused: ${r.reason}`);
      const [lo, hi] = r.ditMsCi;
      // An interval of zero width is a lie of its own: the run lengths are
      // counted on the envelope's sample grid and cannot be sharper than that.
      assert.ok(hi > lo, `${name} reported a zero-width interval at ${r.ditMs.toFixed(2)} ms`);
      assert.ok(hi / lo < 1.15, `${name} reported a uselessly wide interval [${lo.toFixed(2)}, ${hi.toFixed(2)}]`);
      assert.ok(r.ditMs >= lo && r.ditMs <= hi);
      assert.equal(r.splitHalf.tested, true, `${name} could not be split`);
      assert.ok(r.splitHalf.ditMsFirst >= lo && r.splitHalf.ditMsFirst <= hi,
        `${name}: first half ${r.splitHalf.ditMsFirst.toFixed(2)} outside [${lo.toFixed(2)}, ${hi.toFixed(2)}]`);
      assert.ok(r.splitHalf.ditMsSecond >= lo && r.splitHalf.ditMsSecond <= hi,
        `${name}: second half ${r.splitHalf.ditMsSecond.toFixed(2)} outside [${lo.toFixed(2)}, ${hi.toFixed(2)}]`);
      // The speed interval is the unit interval, inverted, and must bracket it.
      assert.ok(r.wpmCi[0] < r.wpm && r.wpm < r.wpmCi[1], `${name} speed outside its own interval`);
    }
  },

  async function theUnitsIntervalCoversTheUnitThatWasActuallySent() {
    // Passing a split-half test is not the same as covering. The split-half
    // test asks whether the two halves of the span agree with each other, and
    // two halves of the same biased measurement agree perfectly. What settles
    // an interval is whether it contains the truth, and here the truth is known
    // by construction: 1.2 s / wpm, by the definition of PARIS.
    //
    // Measured over this 30-span grid before the interval was changed: it
    // covered 13. The error against the rendered unit ran to 0.0240 in log
    // units — a 2.4% bias at 28 wpm and 0 dB — while the fit's own standard
    // error ran 0.0003 to 0.0083, thirty times too small to reach it. What was
    // missing is that the answer depends on which filter the sweep chose, and
    // the sweep already measures that: every bandwidth that fitted Morse-shaped
    // timing is a defensible reading of the same span, and the scatter of their
    // units is what the choice is worth. With 1.25 times it in the interval,
    // coverage is 30 of 30 at a median width of x1.07 and a worst of x1.11.
    let covered = 0, tested = 0, worst = 0;
    const missed = [];
    for (const wpm of [12, 20, 28]) {
      for (const snrDb of [null, 20, 10, 6, 0]) {
        for (const seed of [1, 2]) {
          const s = renderCw('PARIS ABC 123 DE VVV TEST', { wpm, sampleRate: SR, toneHz: 700, snrDb, seed });
          const r = decodeCw(s.samples, SR);
          assert.ok(r.ok, `${wpm} wpm at ${snrDb} dB refused: ${r.reason}`);
          tested++;
          const truth = 1200 / wpm;
          const [lo, hi] = r.ditMsCi;
          worst = Math.max(worst, hi / lo);
          if (truth >= lo && truth <= hi) { covered++; continue; }
          missed.push(`${wpm} wpm ${snrDb} dB seed ${seed}: ${truth.toFixed(2)} outside [${lo.toFixed(2)}, ${hi.toFixed(2)}]`);
        }
      }
    }
    assert.equal(tested, 30, `the grid should be 30 spans, was ${tested}`);
    assert.ok(covered >= 27, `a 95% interval covered ${covered} of ${tested}: ${missed.join(' | ')}`);
    // An interval wide enough to cover everything by being useless is the other
    // failure. A 30 wpm signal is 40 ms a unit; x1.11 is +-2 ms.
    assert.ok(worst < 1.15, `the widest interval was x${worst.toFixed(3)}`);
    // And the reader is told which of the four candidate errors it rests on.
    const r = decodeCw(renderCw('PARIS ABC 123 DE VVV TEST', { wpm: 20, sampleRate: SR, toneHz: 700 }).samples, SR);
    assert.equal(r.splitHalf.ditSigmaFrom, 'filter choice',
      `a clean machine-keyed span should rest on the filter choice, not on ${r.splitHalf.ditSigmaFrom}`);
    assert.ok(r.splitHalf.ditSigmaLog > r.splitHalf.ditFitSigmaLog,
      'and the fit\'s own error bar should be the smaller of the two');
    // Turning that term off puts the coverage back where it was, which is what
    // pins it: the same clean span then reports an interval that excludes 60 ms.
    const shaped = r.filterSweep.filter((q) => q.shaped && q.ditMs);
    assert.ok(shaped.length > 1, `only ${shaped.length} bandwidths fitted Morse-shaped timing`);
    const spread = Math.max(...shaped.map((q) => q.ditMs)) / Math.min(...shaped.map((q) => q.ditMs));
    assert.ok(spread > 1.02, `the bandwidths' units spread only x${spread.toFixed(4)}, so the term is doing nothing`);
  },

  async function theSplitHalfWideningIsWhatItSaysItIs() {
    // The widening inside the unit estimate, pinned. A sender who changes speed
    // half way through is one measurement of two different things, and the two
    // halves then disagree by far more than the fit's own error bar — which is
    // exactly the case the split-half test exists for and the case no test
    // covered. Rendered here as 20 wpm followed by 16 wpm, back to back.
    const a = renderCw('PARIS ABC DE VVV', { wpm: 20, sampleRate: SR, toneHz: 700, tailSec: 0.05 });
    const b = renderCw('PARIS ABC DE VVV', { wpm: 16, sampleRate: SR, toneHz: 700, leadSec: 0.05 });
    const x = new Float32Array(a.samples.length + b.samples.length);
    x.set(a.samples, 0);
    x.set(b.samples, a.samples.length);
    const r = decodeCw(x, SR, { maxSpaceClassExcessSd: 99, fadeDoubtDepthDb: 999, minKeyingSnrDb: -99 });
    assert.equal(r.splitHalf.tested, true, 'the span must be long enough to split');
    // The two halves must actually measure different units, or this pins nothing.
    const ratio = r.splitHalf.ditMsSecond / r.splitHalf.ditMsFirst;
    assert.ok(ratio > 1.1, `the halves measured ${r.splitHalf.ditMsFirst.toFixed(1)} and `
      + `${r.splitHalf.ditMsSecond.toFixed(1)} ms, a ratio of ${ratio.toFixed(3)}`);
    assert.equal(r.splitHalf.ditWidened, true, 'and the interval must say it was widened');
    assert.equal(r.splitHalf.ditSigmaFrom, 'split-half',
      `the published sigma should come from the split-half test, not from ${r.splitHalf.ditSigmaFrom}`);
    assert.ok(r.splitHalf.ditSplitSigmaLog > r.splitHalf.ditFitSigmaLog * 5,
      `the split-half sigma ${r.splitHalf.ditSplitSigmaLog.toFixed(4)} should dwarf the fit's `
      + `${r.splitHalf.ditFitSigmaLog.toFixed(4)}`);
    // And the interval must be the wider one: both halves inside it.
    const [lo, hi] = r.ditMsCi;
    assert.ok(r.splitHalf.ditMsFirst >= lo && r.splitHalf.ditMsSecond <= hi,
      `[${lo.toFixed(1)}, ${hi.toFixed(1)}] does not contain both halves`);
    assert.ok(r.warnings.some((w) => /further apart than the fit's own error bar/.test(w)),
      `the widening must be reported: ${r.warnings.join(' | ')}`);
  },
  // ------------------------------------------- selcall: is it that scheme at all

  async function measuresEachTonesOwnFrequency() {
    // A Goertzel sweep across the tolerance band, parabolically interpolated.
    // Measured over six table frequencies and detunes from -3% to +3%.
    let worst = 0;
    for (const nominal of [680, 991, 1270, 1830, 2400, 2800]) {
      for (let d = -0.03; d <= 0.0301; d += 0.005) {
        const hz = nominal * (1 + d);
        const n = Math.round(0.07 * SR);
        const x = new Float32Array(n);
        for (let i = 0; i < n; i++) x[i] = 0.4 * Math.sin(2 * Math.PI * hz * i / SR);
        const got = measureToneHz(x, SR, 0, n, nominal);
        worst = Math.max(worst, Math.abs(got.hz - hz) / hz);
      }
    }
    assert.ok(worst < 0.0005, `worst frequency error was ${(worst * 100).toFixed(4)}%`);
  },

  async function reportsTheTransmittersFrequencyErrorNotTheTableValue() {
    // Six ZVEI-1 tones sent 1.5% high, which is what a transmitter with a
    // slightly wrong reference does. The call must still read, and the number
    // that comes back for each tone must be the one measured in that tone's own
    // window — the offset from nominal is the most useful output here and
    // reporting the table value instead throws it away.
    const t = SELCALL_SETS.ZVEI1.tones;
    const x = renderTones([t[1], t[2], t[3], t[4], t[5], t[6]].map((hz) => hz * 1.015));
    const r = detectSelcall(x, SR, { set: 'ZVEI1' });
    assert.equal(r.sequences.join(''), '123456', `read ${JSON.stringify(r.sequences)}`);
    for (const tone of r.calls[0].tones) {
      assert.ok(tone.nominalHz > 0 && tone.hz !== tone.nominalHz, 'hz must not be the table value');
      assert.ok(Math.abs(tone.offsetFraction - 0.015) < 0.001,
        `${tone.symbol} measured ${tone.hz.toFixed(1)} Hz against nominal ${tone.nominalHz}, `
        + `an offset of ${(tone.offsetFraction * 100).toFixed(2)}% rather than 1.50%`);
      assert.ok(Math.abs(tone.offsetHz - (tone.hz - tone.nominalHz)) < 1e-6);
    }
    // And the common error is reported once, as the transmitter's error.
    const fit = r.calls[0].fit;
    assert.ok(Math.abs(fit.offsetFraction - 0.015) < 0.0005, `common offset ${(fit.offsetFraction * 100).toFixed(3)}%`);
    assert.ok(fit.maxResidual < 0.001, `residuals after removing it: ${(fit.maxResidual * 100).toFixed(3)}%`);

    // On a nominally tuned sequence the measurement lands on the table value.
    const clean = detectSelcall(renderSelcall('123456', { set: 'ZVEI1', sampleRate: SR }).samples, SR, { set: 'ZVEI1' });
    for (const tone of clean.calls[0].tones) {
      assert.ok(Math.abs(tone.offsetFraction) < 0.001, `${tone.symbol} read ${(tone.offsetFraction * 100).toFixed(3)}% off a tone that is not`);
    }
  },

  async function refusesASixToneSetThatIsNotTheSchemeItResembles() {
    // Six tones, each inside ZVEI-1's own per-tone frequency tolerance of an
    // entry, but off in alternating directions. Each tone passes the gate that
    // asks about one tone; the SET cannot be ZVEI-1, because one transmitter
    // reading one table is off every entry by the same ratio. That second
    // question is the one the module was not asking, and it is why a six-tone
    // format that is not ZVEI-1 came back as ZVEI-1 calls with ok: true.
    const t = SELCALL_SETS.ZVEI1.tones;
    const impostor = [t[1] * 1.015, t[2] * 0.986, t[3] * 1.014, t[4] * 0.987, t[5] * 1.016, t[6] * 0.985];
    const x = renderTones(impostor);

    // Without the fit test — which is the behaviour before it existed — this is
    // a clean six-digit ZVEI-1 call.
    const ungated = detectSelcall(x, SR, { set: 'ZVEI1', maxToneResidual: 1, maxToneTolerance: 1 });
    assert.equal(ungated.sequences.join(''), '123456', 'the old behaviour is supposed to accept this');

    const r = detectSelcall(x, SR, { set: 'ZVEI1' });
    assert.equal(r.calls.length, 0, `reported ${JSON.stringify(r.sequences)}`);
    assert.equal(r.sequence, '', 'and must not spell anything at the top level either');
    // The refusal has to say what it measured, not just that it refused.
    const said = r.warnings.join(' | ');
    assert.ok(/are not ZVEI-1/.test(said), said);
    assert.ok(/1075/.test(said) && /1287/.test(said), `the measured frequencies must be named: ${said}`);
    assert.ok(r.bursts[0].fit.maxResidual > 0.01,
      `residual after a common error was ${(r.bursts[0].fit.maxResidual * 100).toFixed(2)}%`);

    // The gate must not cost a genuine sequence anything, anywhere inside the
    // per-tone frequency tolerance this detector already claims. Past about
    // 1.5% the tones are turned away by the guard probes, which is the older
    // gate doing its own job and not this one.
    for (const detune of [0, 0.012, -0.012]) {
      const genuine = renderTones([t[9], t[0], t[2], t[1], t[0]].map((hz) => hz * (1 + detune)));
      const g = detectSelcall(genuine, SR, { set: 'ZVEI1' });
      assert.equal(g.sequences.join(''), '90210', `${detune} detune read ${JSON.stringify(g.sequences)}`);
    }
  },

  async function saysWhatTheTonesAreWhenNoSchemeExplainsThem() {
    // Six tones on an equal-ratio ladder from 1000 Hz — a plausible six-tone
    // selective-call set, and not CCIR-1 or ZVEI-1. The honest answer is not a
    // sequence in a table it does not belong to; it is the frequencies.
    const ladder = [1000, 1122, 1260, 1414, 1587, 1782];
    const x = renderTones([0, 3, 1, 5, 2, 4, 0, 3, 1, 5, 2, 4].map((k) => ladder[k]), { toneMs: 350 });
    const ranked = identifySelcall(x, SR);
    assert.equal(ranked.explained, false, `a set claimed it: ${JSON.stringify(ranked.map((o) => o.sequences))}`);
    for (const o of ranked) assert.equal(o.calls, 0, `${o.set} reported ${o.calls} calls`);
    // What it did measure must be there, and must be the ladder.
    assert.ok(ranked.tones.length >= 3, `only ${ranked.tones.length} tones surveyed`);
    for (const want of [1000, 1122, 1260]) {
      assert.ok(ranked.tones.some((c) => Math.abs(c.hz / want - 1) < 0.005),
        `${want} Hz was sounded but is not in ${JSON.stringify(ranked.tones)}`);
    }
  },

  async function theSchemeFitSeparatesAnErrorFromAnImpostor() {
    // The arithmetic on its own, so the threshold has a unit test and not only
    // an end-to-end one. One oscillator 1.5% high: a large offset, no residual.
    const nominal = [1060, 1160, 1270, 1400, 1530, 1670];
    const shifted = schemeFit(nominal.map((v) => v * 1.015), nominal);
    assert.ok(Math.abs(shifted.offsetFraction - 0.015) < 1e-9);
    assert.ok(shifted.maxResidual < 1e-9, `residual ${shifted.maxResidual}`);
    // Alternating errors: no common offset explains them.
    const mixed = schemeFit(nominal.map((v, i) => v * (i % 2 ? 0.986 : 1.015)), nominal);
    assert.ok(Math.abs(mixed.offsetFraction) < 0.005, `claimed a ${(mixed.offsetFraction * 100).toFixed(2)}% common error`);
    assert.ok(mixed.maxResidual > 0.012, `residual ${(mixed.maxResidual * 100).toFixed(2)}%`);
    // Nothing to fit refuses rather than accepting: Infinity fails any tolerance.
    assert.equal(schemeFit([], []).n, 0);
    assert.equal(schemeFit([], []).maxResidual, Infinity);
  },

  async function theToneFitToleranceIsNeverTighterThanTheMeasurement() {
    // The acceptance band has to survive the same split-half test as any other
    // error bar here: each tone's frequency is measured over its first half and
    // its second, and half the disagreement is what one full-window measurement
    // is worth. A band narrower than that would refuse real signals for being
    // short or noisy. Measured on rendered CCIR-1 and ZVEI-1 down to +9 dB the
    // median tone repeats to 0.0013-0.018%, so the stated 0.4% floor is what
    // binds there and the self-calibration costs nothing; on a burst too short
    // or too noisy to measure, it is the one that binds.
    for (const set of ['CCIR1', 'ZVEI1']) {
      for (const snrDb of [null, 12]) {
        const s = renderSelcall('120079', { set, sampleRate: SR, snrDb, seed: 5 });
        const r = detectSelcall(s.samples, SR, { set });
        assert.equal(r.sequences.join(''), '120079', `${set} at ${snrDb} read ${JSON.stringify(r.sequences)}`);
        const fit = r.calls[0].fit;
        assert.ok(fit.tolerance >= 0.004 - 1e-12, 'the stated floor must hold');
        assert.ok(fit.tolerance >= 4 * fit.sigmaFraction - 1e-12,
          `tolerance ${fit.tolerance} under four times the measured scatter ${fit.sigmaFraction}`);
        assert.ok(fit.maxResidual < fit.tolerance,
          `${set}: residual ${(fit.maxResidual * 100).toFixed(3)}% against tolerance ${(fit.tolerance * 100).toFixed(3)}%`);
        // And every tone's own repeatability must be far inside the tolerance,
        // or the acceptance is being carried by the self-calibration alone.
        for (const tone of r.calls[0].tones) {
          assert.ok(tone.sigmaFraction < 0.01, `${tone.symbol} repeats to only ${(tone.sigmaFraction * 100).toFixed(3)}%`);
        }
      }
    }
  },

  async function theToneFitToleranceCannotBeOpenedByADriftingTone() {
    // The guard that widens the scheme-fit tolerance to four times the
    // measurement's own repeatability had no test, and it was the guard that
    // let an impostor through. Its input was half the disagreement between the
    // first and second halves of each tone, which is the error on the whole
    // only if the tone is at ONE frequency. A tone that sweeps while it sounds
    // disagrees with itself for a reason that is not noise, and the widening
    // then opens the acceptance band by a factor of four and swallows the very
    // thing the band exists to catch.
    //
    // Constructed here: the six-tone impostor set from the case above — each
    // tone inside ZVEI-1's per-tone tolerance of an entry but off in
    // alternating directions, which one transmitter reading one table cannot be
    // — with each tone additionally swept +-0.8% across its own 100 ms. That is
    // 12 Hz on a 1500 Hz tone, four hundred times the drift of any real
    // transmitter over a tenth of a second.
    const t = SELCALL_SETS.ZVEI1.tones;
    const nominal = [t[1], t[2], t[3], t[4], t[5], t[6]];
    const impostor = nominal.map((v, i) => v * (i % 2 ? 0.992 : 1.008));
    const x = renderDrifting(impostor, { driftFraction: 0.008 });

    // With the halves rule and no ceiling — which is what was there — this is a
    // clean six-digit ZVEI-1 call.
    const old = detectSelcall(x, SR, { set: 'ZVEI1', maxToneTolerance: 1, maxToneDrift: 99, maxToneResidual: 0.004 });
    // The old sigma is reconstructed from the same tone measurements, so the
    // control is the arithmetic that was there rather than a claim about it.
    const b0 = old.bursts.find((b) => b.tones.length >= 3);
    assert.ok(b0, 'the impostor must at least form a burst');
    const oldSigma = b0.tones.map((tone) => Math.abs(tone.driftFraction) / 2).sort((p, q) => p - q)[b0.tones.length >> 1];
    assert.ok(4 * oldSigma > b0.fit.maxResidual,
      `the old half-window rule must have opened the band past the residual: 4 x ${(oldSigma * 100).toFixed(3)}% `
      + `against ${(b0.fit.maxResidual * 100).toFixed(3)}%`);

    // Measured in thirds instead, the drift comes out as drift and the scatter
    // is what is left. The band stays at its stated floor and refuses.
    const r = detectSelcall(x, SR, { set: 'ZVEI1' });
    assert.equal(r.calls.length, 0, `reported ${JSON.stringify(r.sequences)}`);
    const b = r.bursts.find((q) => q.tones.length >= 3);
    assert.ok(b.fit.sigmaFraction * 4 < 0.004,
      `the trend-removed scatter still opens the band: 4 x ${(b.fit.sigmaFraction * 100).toFixed(4)}%`);
    assert.ok(Math.abs(b.fit.tolerance - 0.004) < 1e-9,
      `the tolerance should be the stated floor, was ${(b.fit.tolerance * 100).toFixed(3)}%`);
    assert.equal(b.fitsScheme, false, `residual ${(b.fit.maxResidual * 100).toFixed(3)}% inside the band`);

    // The drift is reported as its own measurement and refuses on its own, so a
    // set that IS the scheme but is drifting is not silently accepted either.
    const straight = renderDrifting(nominal, { driftFraction: 0.008 });
    const drifting = detectSelcall(straight, SR, { set: 'ZVEI1' });
    const db = drifting.bursts.find((q) => q.tones.length >= 3);
    assert.ok(db.fitsScheme, 'the frequencies themselves are ZVEI-1 here');
    assert.equal(db.steady, false, `drift measured ${(db.fit.driftFraction * 100).toFixed(3)}%`);
    assert.equal(drifting.calls.length, 0, `reported ${JSON.stringify(drifting.sequences)}`);
    assert.ok(drifting.warnings.some((w) => /drift/.test(w)), drifting.warnings.join(' | '));
    // With the drift gate off the same span is a call, which is what pins it.
    assert.equal(detectSelcall(straight, SR, { set: 'ZVEI1', maxToneDrift: 99 }).sequences.join(''), '123456');

    // And the ceiling on the widening, pinned on its own: a chirp across the
    // whole selcall band disagrees with itself by a percent or more, and
    // without a ceiling the tolerance it grants itself is measured at 3.8-4.7%,
    // which is wider than the gaps between the table entries themselves.
    const swept = chirp(900, 2300, 3);
    const capped = detectSelcall(swept, SR, { set: 'CCIR1' });
    for (const q of capped.bursts) {
      assert.ok(q.fit.tolerance <= 0.012 + 1e-9,
        `a chirp granted itself a tolerance of ${(q.fit.tolerance * 100).toFixed(2)}%`);
    }
    assert.equal(capped.calls.length, 0, `a chirp was read as ${JSON.stringify(capped.sequences)}`);
  },

  async function theToneGatesCostAGenuineSequenceNothing() {
    // The other half of every gate above: what it costs. Measured over both
    // sets x six signal-to-noise ratios from noiseless to +6 dB x three tone
    // lengths x three seeds — 108 spans — the ceiling and the drift gate change
    // nothing at all: 82 of 108 read exactly with them on and 82 with them off,
    // the 26 that do not being CCIR-1 tones sent at half their nominal length
    // (under the duration gate) and the +6 dB spans. The worst median scatter
    // any genuine burst reported is 0.044%, so four times it never reaches the
    // 0.4% floor, and the worst median drift is 0.145% against a limit of 0.4%.
    let read = 0, spans = 0, worstDrift = 0, worstSigma = 0;
    for (const set of ['CCIR1', 'ZVEI1']) {
      for (const snrDb of [null, 20, 12, 9]) {
        for (const seed of [1, 3]) {
          const s = renderSelcall('120079', { set, sampleRate: SR, snrDb, seed });
          const r = detectSelcall(s.samples, SR, { set });
          spans++;
          if (r.sequences.join('') === '120079') read++;
          for (const b of r.calls) {
            worstSigma = Math.max(worstSigma, b.fit.sigmaFraction);
            worstDrift = Math.max(worstDrift, b.fit.driftFraction);
          }
        }
      }
    }
    assert.equal(read, spans, `only ${read} of ${spans} genuine sequences were read`);
    assert.ok(4 * worstSigma < 0.004, `a genuine burst widened its own band: 4 x ${(worstSigma * 100).toFixed(4)}%`);
    assert.ok(worstDrift < 0.004, `a genuine burst drifted ${(worstDrift * 100).toFixed(4)}%`);
  },

  // ------------------------------------------------ the two unpinned DTMF gates

  async function theDominanceGateRefusesTwoRowsAtOnce() {
    // Two low-group tones sounding together with one high tone: 697 and 770 are
    // 2.9 dB apart, so neither dominates its group, which is what a vowel with
    // two strong low partials looks like and what this gate is for. Setting
    // `dominanceDb` to -99 turns the gate off and the same input becomes a
    // digit that was never sent, which is what pins it.
    const x = renderChord([[697, 0.35], [770, 0.25], [1336, 0.35]]);
    const strict = detectDtmf(x, SR);
    assert.equal(strict.digits.length, 0, `read "${strict.sequence}"`);
    assert.ok(strict.rejected.dominance > 10,
      `the dominance gate should have done the work: ${JSON.stringify(strict.rejected)}`);
    const loose = detectDtmf(x, SR, { dominanceDb: -99 });
    assert.equal(loose.sequence, '2', 'with the gate off this must become a digit, or it pins nothing');
    assert.equal(loose.rejected.dominance, 0);
  },

  async function theHarmonicGateRefusesAToneWithAnOctaveOnIt() {
    // 941 Hz with its own second harmonic at 1882 Hz, 2.9 dB down, plus a clean
    // 1209. A sinusoid has no second harmonic; a vowel and a distorted tone do.
    const x = renderChord([[941, 0.35], [1882, 0.25], [1209, 0.35]]);
    const strict = detectDtmf(x, SR);
    assert.equal(strict.digits.length, 0, `read "${strict.sequence}"`);
    assert.ok(strict.rejected.harmonic > 10,
      `the harmonic gate should have done the work: ${JSON.stringify(strict.rejected)}`);
    const loose = detectDtmf(x, SR, { harmonicDb: -99 });
    assert.equal(loose.sequence, '*', 'with the gate off this must become a digit, or it pins nothing');
    assert.equal(loose.rejected.harmonic, 0);
    // And the gate must still cost a real digit nothing.
    assert.equal(detectDtmf(renderDtmf('*', { sampleRate: SR }).samples, SR).sequence, '*');
  },
  async function abbreviatedNumeralsAreReadAndTheFitIsReported() {
    // The set, checked against itself: every value is a digit and every key is
    // a distinct Morse pattern short enough to be worth cutting to.
    const patterns = Object.keys(CUT_NUMERALS);
    assert.equal(new Set(Object.values(CUT_NUMERALS)).size, 10, 'all ten digits, once each');
    assert.equal(new Set(patterns).size, patterns.length);
    assert.ok(patterns.every((p) => p.length <= 4), 'a cut numeral is shorter than the five it replaces');

    // A figure group reads as digits.
    const figures = '-..,-,-,.-,.-'.split(',').map((pattern) => ({ pattern, char: '?' }));
    const read = cutNumbers(figures);
    assert.equal(read.ok, true);
    assert.equal(read.text, '80011');
    assert.equal(read.fit, 1);

    // Ordinary English does not, and must be refused rather than mangled into
    // a number. 'THE' is -, ...., . — two of which are cut numerals, so this
    // is exactly the case a fit threshold has to catch.
    const english = ['-', '....', '.', '.-.', '.', '..-.', '---', '.-.', '.'].map((pattern) => ({ pattern, char: '?' }));
    const bad = cutNumbers(english);
    assert.equal(bad.ok, false);
    assert.ok(bad.fit < 0.7, `fit ${bad.fit.toFixed(2)}`);
    assert.match(bad.reason, /abbreviated numerals/);

    // What does not map is always returned, counted, so a reader can see the
    // shape of the disagreement instead of a smoothed answer.
    const mixed = cutNumbers([...figures, { pattern: '.-.', char: 'R' }, { pattern: '.-.', char: 'R' }]);
    assert.deepEqual(mixed.unmapped, [{ pattern: '.-.', count: 2 }]);
    assert.match(mixed.text, /\[R\]/);
    assert.equal(cutNumbers([]).ok, false);
  },

  async function aWordBreakSeparatesGroups() {
    const chars = [
      { pattern: '-..', char: 'D' }, { pattern: '-', char: 'T' },
      { pattern: '.-', char: 'A', wordBreakBefore: true }, { pattern: '-.', char: 'N' },
    ];
    assert.equal(cutNumbers(chars).text, '80 19');
  },
];
