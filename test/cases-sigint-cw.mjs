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
  fadeTrack, elementConfidence,
} from '../js/sigint/decode/cw.js';
import {
  detectDtmf, renderDtmf, detectSelcall, renderSelcall, identifySelcall,
  renderVoiceLike, dtmfPair, measureToneHz, schemeFit,
  DTMF_LOW, DTMF_HIGH, SELCALL_SETS, Q24,
} from '../js/sigint/decode/tones.js';

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

  async function refusesNoiseInsteadOfReadingIt() {
    const r = decodeCw(noise(6, 11), SR);
    assert.equal(r.ok, false, `noise decoded as "${r.text}"`);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 10, 'the refusal must say why');
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
    // muting everything would be circular. It declines and says so.
    const e = cwEnvelope(noise(3, 31), SR, { toneHz: 700, bandwidthHz: 300, envRate: 1000 });
    const k = keyStates(e.env, e.envRate, { windowSec: 1.5 });
    const sq = squelchIncoherent(k.state, e.envRate, { windowSec: 1 });
    assert.ok(sq.muted < 0.9, 'the squelch must not delete a whole span on its own reference');
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
    // A second voice, different pitch and vowels, in case the first was lucky.
    const v2 = renderVoiceLike({ sampleRate: SR, seconds: 4, seed: 9, f0: 190, vowels: [[520, 1190, 2390], [300, 2200, 3000], [660, 1720, 2410]] });
    assert.equal(detectDtmf(v2.samples, SR).digits.length, 0);
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
    const v = renderVoiceLike({ sampleRate: SR, seconds: 4, seed: 5 });
    for (const set of ['CCIR1', 'ZVEI1']) {
      const r = detectSelcall(v.samples, SR, { set });
      assert.equal(r.calls.length, 0, `${set} found ${JSON.stringify(r.sequences)} in speech`);
    }
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
    // the control, not a hypothetical.
    const untracked = decodeCw(x, SR, { agc: false, maxBoundaryDoubt: 1 });
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
    // The same fade with a receiver noise floor under it. Now the nulls are not
    // merely quiet, they are below the noise, and the elements keyed there were
    // never received at all — no amount of tracking recovers them. What must
    // not happen is a confident wrong message, and the gate that stops it is
    // the fraction of characters whose surrounding gaps do not fall into the
    // fitted classes: a lost dit widens the gap either side of it, and both
    // characters sharing that boundary carry the doubt.
    let refusedOrFlagged = 0;
    for (const snrDb of [30, 20]) {
      for (const seed of [1, 2, 3]) {
        const x = faded('DE VVV TEST', { wpm: 18, snrDb, seed });
        const r = decodeCw(x, SR);
        if (!r.ok || r.text === 'DE VVV TEST') { refusedOrFlagged++; continue; }
        // If it does return text it must at least not be confident about it.
        assert.ok(r.meanConfidence < 0.85,
          `+${snrDb} dB seed ${seed} returned "${r.text}" at confidence ${r.meanConfidence.toFixed(2)}`);
      }
    }
    assert.ok(refusedOrFlagged >= 4, `only ${refusedOrFlagged} of 6 buried-null spans were refused`);

    // With the gate disabled — which is the behaviour before it existed — the
    // same span comes back as a wrong message with `ok: true`.
    const x = faded('DE VVV TEST', { wpm: 18, snrDb: 20, seed: 1 });
    const ungated = decodeCw(x, SR, { maxBoundaryDoubt: 1 });
    assert.equal(ungated.ok, true);
    assert.notEqual(ungated.text, 'DE VVV TEST');
    assert.equal(decodeCw(x, SR).ok, false, 'the gate must refuse what the ungated read accepts');
  },

  async function theFadeTrackerCannotLiftNoiseIntoSignal() {
    // The tracker divides by a level it measures, so the question that decides
    // whether it is safe is what bounds that division. Fed nothing but noise,
    // the tracked level must stay at its floor rather than following the noise
    // up and handing the slicer a normalised signal that looks keyed.
    const e = cwEnvelope(noise(6, 17), SR, { toneHz: 700, bandwidthHz: 400, envRate: 2000 });
    const ft = fadeTrack(e.env, e.envRate, { unitSec: 0.06 });
    assert.ok(ft, 'six seconds is long enough to track');
    assert.ok(ft.anchors < ft.blocks * 0.25,
      `noise gave the tracker ${ft.anchors} anchors out of ${ft.blocks} blocks`);
    assert.ok(ft.depthDb < 12, `and ${ft.depthDb.toFixed(1)} dB of imaginary fade`);
    // And the decode over the same noise still refuses, tracker or no tracker.
    for (const seed of [11, 12, 13, 14]) {
      const r = decodeCw(noise(6, seed), SR);
      assert.equal(r.ok, false, `noise seed ${seed} decoded as "${r.text}"`);
    }
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
    const ungated = detectSelcall(x, SR, { set: 'ZVEI1', maxToneResidual: 1 });
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
];