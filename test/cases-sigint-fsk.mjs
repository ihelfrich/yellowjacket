// The FSK front end and the RTTY decoder, checked against signals whose answer
// is fixed before they are generated: a stated tone set, a stated symbol rate,
// a stated string of text. A decoder is only known to decode when the thing it
// produced was written down first.
import assert from 'node:assert/strict';

import {
  estimateTones, estimateBaud, toneTrace, transitions, recoverTiming,
  fskDemod, describeFsk, powerSpectrum, leakageCeilingDb, gridFit,
  armSeparation, nullMargin, AGC_CLAMP_DB,
} from '../js/sigint/decode/fsk.js';
import { decodeRtty, encodeIta2, BAUD, SHIFT_HZ, AFSK_PAIRS } from '../js/sigint/decode/rtty.js';

const SR = 8000;   // what an HF receiver's audio actually carries

// --- synthesis -------------------------------------------------------------
// Continuous phase, because a real AFSK keyer does not restart the oscillator
// at a symbol boundary and a discontinuity would hand the decoder a transition
// edge it has not earned.

function fromSegments(segments, { rate, baud, amp = 1, leadSec = 0, tailSec = 0 }) {
  const spb = rate / baud;
  let bits = 0;
  const bounds = [0];
  for (const s of segments) { bits += s.bits; bounds.push(Math.round(bits * spb)); }
  const lead = Math.round(leadSec * rate), tail = Math.round(tailSec * rate);
  const n = lead + bounds[bounds.length - 1] + tail;
  const x = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    let hz = 0;
    const k = i - lead;
    if (k >= 0 && k < bounds[bounds.length - 1]) {
      let seg = 0;
      while (seg < segments.length - 1 && k >= bounds[seg + 1]) seg++;
      hz = segments[seg].hz;
    } else {
      hz = segments[0].hz;   // idle on the first tone, as a keyer does
    }
    phase += 2 * Math.PI * hz / rate;
    x[i] = amp * Math.cos(phase);
  }
  return x;
}

/** RTTY frames: 1 start bit (space), 5 data bits first-bit-first, 1.5 stop
 *  bits (mark), preceded by an idle mark run. */
function synthRtty(text, {
  rate = SR, baud = BAUD, mark = AFSK_PAIRS.high.mark, space = AFSK_PAIRS.high.space,
  variant = 'ita2', idleBits = 12, leadSec = 0.05, amp = 1,
} = {}) {
  const codes = encodeIta2(text, { variant });
  const segs = [{ hz: mark, bits: idleBits }];
  for (const c of codes) {
    segs.push({ hz: space, bits: 1 });
    for (let k = 0; k < 5; k++) segs.push({ hz: (c >> k) & 1 ? mark : space, bits: 1 });
    segs.push({ hz: mark, bits: 1.5 });
  }
  segs.push({ hz: mark, bits: 6 });
  return fromSegments(segs, { rate, baud, amp, leadSec, tailSec: 0.05 });
}

function synthMfsk(symbols, tones, { rate = SR, baud = 100, amp = 1, leadSec = 0 } = {}) {
  const segs = symbols.map((s) => ({ hz: tones[s], bits: 1 }));
  return fromSegments(segs, { rate, baud, amp, leadSec, tailSec: 0 });
}

// Box-Muller with a fixed generator, so a failure is reproducible.
function noiseInto(x, sigma, seed = 1) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  for (let i = 0; i < x.length; i += 2) {
    const r = Math.sqrt(-2 * Math.log(rnd())), t = 2 * Math.PI * rnd();
    x[i] += sigma * r * Math.cos(t);
    if (i + 1 < x.length) x[i + 1] += sigma * r * Math.sin(t);
  }
  return x;
}

/** Noise sigma for a stated SNR, with signal power taken as amp^2/2 for a
 *  constant-envelope tone. The SNR is over the WHOLE band the file carries
 *  (rate/2 Hz); at 8 kHz that is 4 kHz, so a figure quoted here is 1.25 dB
 *  below the same signal's SNR in the operator's 3 kHz reference. */
const sigmaFor = (snrDb, amp = 1) => Math.sqrt((amp * amp / 2) / Math.pow(10, snrDb / 10));

const lcg = (seed) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };

/** Audio for a run of RTTY characters given as literal 5-bit strings in
 *  TRANSMISSION order (bit 1 first), framed by hand: one space start bit, the
 *  five data bits, then 1.5 mark stop bits. Nothing here consults the decoder's
 *  own tables, which is the point. */
function synthFramedBits(bitStrings, {
  rate = SR, baud = BAUD, mark = AFSK_PAIRS.high.mark, space = AFSK_PAIRS.high.space,
} = {}) {
  const segs = [{ hz: mark, bits: 12 }];
  for (const b of bitStrings) {
    if (!/^[01]{5}$/.test(b)) throw new Error(`'${b}' is not five bits`);
    segs.push({ hz: space, bits: 1 });
    for (const c of b) segs.push({ hz: c === '1' ? mark : space, bits: 1 });
    segs.push({ hz: mark, bits: 1.5 });
  }
  segs.push({ hz: mark, bits: 6 });
  return fromSegments(segs, { rate, baud, amp: 1, leadSec: 0.05, tailSec: 0.05 });
}

function decodeFramedBits(bitStrings, opts = {}) {
  const r = decodeRtty(synthFramedBits(bitStrings), SR,
    { markHz: AFSK_PAIRS.high.mark, spaceHz: AFSK_PAIRS.high.space, ...opts });
  if (!r.ok) throw new Error(`hand-written bit stream was refused: ${r.reason}`);
  return r.text;
}

/** The same, but before `text` folds CR and CR LF into a single newline. The
 *  standard assigns CR and LF to different codes and the table has to be
 *  checked against that, not against the line endings a reader is handed. */
function decodeFramedChars(bitStrings, opts = {}) {
  const r = decodeRtty(synthFramedBits(bitStrings), SR,
    { markHz: AFSK_PAIRS.high.mark, spaceHz: AFSK_PAIRS.high.space, ...opts });
  if (!r.ok) throw new Error(`hand-written bit stream was refused: ${r.reason}`);
  return r.chars.map((c) => c.char).join('');
}

export const NAME = 'sigint: FSK front end and RTTY';

export const cases = [

  // --- tone estimation -----------------------------------------------------

  async function findsTheTwoRttyTonesWithoutBeingTold() {
    const x = synthRtty('CQ CQ DE TEST', {});
    const est = estimateTones(x, SR);
    assert.equal(est.ok, true, est.reason || '');
    assert.equal(est.tones.length, 2, `expected 2 tones, got ${est.tones.map((t) => t.toFixed(1))}`);
    assert.ok(Math.abs(est.tones[0] - 2125) < 4, `mark tone read ${est.tones[0].toFixed(1)}`);
    assert.ok(Math.abs(est.tones[1] - 2295) < 4, `space tone read ${est.tones[1].toFixed(1)}`);
    assert.ok(Math.abs(est.spacingHz - 170) < 5, `shift read ${est.spacingHz}`);
  },

  async function refusesToCallASingleCarrierFsk() {
    const n = SR * 2;
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.cos(2 * Math.PI * 1500 * i / SR);
    const est = estimateTones(x, SR);
    assert.equal(est.ok, false);
    assert.match(est.reason, /one steady frequency/);
    assert.ok(Math.abs(est.tones[0] - 1500) < 4, `carrier read ${est.tones[0]}`);
  },

  async function refusesToFindTonesInNoise() {
    const x = new Float64Array(SR * 2);
    noiseInto(x, 1, 7);
    const est = estimateTones(x, SR);
    assert.equal(est.ok, false, `claimed tones ${JSON.stringify(est.tones)}`);
    assert.ok(est.reason.length > 10);
  },

  async function findsAnEightToneGridAndItsSpacing() {
    const tones = [];
    for (let i = 0; i < 8; i++) tones.push(1000 + i * 250);
    const rnd = lcg(11);
    const symbols = Array.from({ length: 400 }, () => Math.floor(rnd() * 8));
    const x = synthMfsk(symbols, tones, { baud: 40 });
    const est = estimateTones(x, SR);
    assert.equal(est.ok, true, est.reason || '');
    assert.equal(est.tones.length, 8, `found ${est.tones.length}: ${est.tones.map((t) => t.toFixed(0))}`);
    assert.equal(est.regular, true);
    assert.ok(Math.abs(est.spacingHz - 250) < 5, `spacing read ${est.spacingHz.toFixed(1)}`);
    for (let i = 0; i < 8; i++) {
      assert.ok(Math.abs(est.tones[i] - tones[i]) < 5, `tone ${i} read ${est.tones[i].toFixed(1)} not ${tones[i]}`);
    }
  },

  async function namesTheGridSlotsNoSymbolVisited() {
    // Six of an eight-tone alphabet appear. The grid is still recoverable, and
    // the gap must be reported rather than passed off as a six-tone mode.
    const tones = [1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750];
    const used = [0, 1, 2, 3, 6, 7];
    const rnd = lcg(5);
    const symbols = Array.from({ length: 300 }, () => used[Math.floor(rnd() * used.length)]);
    const x = synthMfsk(symbols, tones, { baud: 40 });
    const est = estimateTones(x, SR);
    assert.equal(est.ok, true, est.reason || '');
    assert.equal(est.tones.length, 6);
    assert.equal(est.gridSlots, 8, `grid inferred ${est.gridSlots} slots`);
    assert.match(est.warnings.join(' '), /grid slots carried no symbol/);
  },

  // --- symbol rate ---------------------------------------------------------

  async function measuresTheSymbolRateOfAnMfskStream() {
    const tones = [1200, 1400, 1600, 1800];
    const rnd = lcg(3);
    const symbols = Array.from({ length: 600 }, () => Math.floor(rnd() * 4));
    const x = synthMfsk(symbols, tones, { baud: 62.5 });
    const trace = toneTrace(x, SR, { tones, baud: 62.5, oversample: 16 });
    const est = estimateBaud(transitions(trace), {});
    assert.equal(est.ok, true, est.reason || '');
    assert.ok(Math.abs(est.baud - 62.5) / 62.5 < 0.005, `read ${est.baud.toFixed(3)} baud`);
    assert.ok(est.concentration > 0.9, `concentration ${est.concentration.toFixed(3)}`);
  },

  async function doesNotReturnAHarmonicOfTheSymbolRate() {
    // Every harmonic of the true rate concentrates just as hard; the answer
    // must be the fundamental, which is what the shortest-gap floor enforces.
    const tones = [1500, 1700];
    const rnd = lcg(9);
    const symbols = Array.from({ length: 800 }, () => (rnd() < 0.5 ? 0 : 1));
    const x = synthMfsk(symbols, tones, { baud: 45.45 });
    const trace = toneTrace(x, SR, { tones, baud: 45.45, oversample: 16 });
    const est = estimateBaud(transitions(trace), {});
    assert.equal(est.ok, true, est.reason || '');
    assert.ok(Math.abs(est.baud - 45.45) < 0.3, `read ${est.baud.toFixed(3)} baud, not 45.45`);
  },

  async function saysSoWhenTransitionsAreNotOnAGrid() {
    // Transitions at random instants: there is no symbol rate to find, and the
    // estimator has to say that rather than return the best of a bad scan.
    const rnd = lcg(21);
    const times = [];
    let t = 0;
    for (let i = 0; i < 200; i++) { t += 0.02 + rnd() * 0.06; times.push(t); }
    const est = estimateBaud(times, {});
    assert.equal(est.ok, false, `claimed ${est.baud} baud at concentration ${est.concentration}`);
    assert.match(est.reason, /not fall on a regular grid/);
  },

  async function refusesWithTooFewTransitions() {
    const est = estimateBaud([0.1, 0.2, 0.3]);
    assert.equal(est.ok, false);
    assert.match(est.reason, /transitions/);
  },

  // --- the bank ------------------------------------------------------------

  async function perArmAgcRescuesAToneTheReceiverAttenuated() {
    // One arm 10 dB down, as an audio filter's skirt leaves it. Without the
    // per-arm correction that arm loses decisions it should win.
    const tones = [1000, 1250, 1500, 1750];
    const rnd = lcg(13);
    const symbols = Array.from({ length: 240 }, () => Math.floor(rnd() * 4));
    const baud = 50;
    const segs = symbols.map((s) => ({ hz: tones[s], bits: 1, amp: s === 3 ? 0.316 : 1 }));
    // Rebuild with a per-symbol amplitude, which fromSegments does not carry.
    const spb = SR / baud;
    const n = Math.round(segs.length * spb);
    const x = new Float64Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const seg = segs[Math.min(segs.length - 1, Math.floor(i / spb))];
      phase += 2 * Math.PI * seg.hz / SR;
      x[i] = seg.amp * Math.cos(phase);
    }
    const withAgc = fskDemod(x, SR, { tones, baud, agc: true });
    const without = fskDemod(x, SR, { tones, baud, agc: false });
    const errs = (r) => {
      let e = 0, c = 0;
      for (let m = 0; m < r.count; m++) {
        const idx = Math.round((r.times[m] * SR) / spb - 0.5);
        if (idx < 1 || idx >= symbols.length - 1) continue;
        c++; if (r.symbols[m] !== symbols[idx]) e++;
      }
      return c ? e / c : 1;
    };
    const a = errs(withAgc), b = errs(without);
    assert.ok(a < 0.01, `with AGC the symbol error rate was ${(a * 100).toFixed(1)}%`);
    assert.ok(a <= b, `AGC made it worse: ${(a * 100).toFixed(1)}% vs ${(b * 100).toFixed(1)}%`);
    assert.ok(withAgc.trace.gains[3] > 2, `arm 3 gain ${withAgc.trace.gains[3].toFixed(2)} did not correct a 10 dB loss`);
  },

  async function fourFskRecoversAKnownSymbolSequence() {
    const tones = [1200, 1400, 1600, 1800];
    const rnd = lcg(17);
    const symbols = Array.from({ length: 500 }, () => Math.floor(rnd() * 4));
    const x = synthMfsk(symbols, tones, { baud: 100 });
    const r = fskDemod(x, SR, { tones, baud: 100 });
    assert.equal(r.ok, true, r.reason || '');
    assert.equal(r.order, 4);
    assert.equal(r.bitsPerSymbol, 2);
    // The first and last symbol windows straddle the region edge; compare the
    // interior, aligned by the recovered sampling instants.
    let errs = 0, counted = 0;
    for (let m = 1; m < r.count - 1; m++) {
      const idx = Math.floor(r.times[m] * 100);
      if (idx < 0 || idx >= symbols.length) continue;
      counted++; if (r.symbols[m] !== symbols[idx]) errs++;
    }
    assert.ok(counted > 400, `only ${counted} symbols compared`);
    assert.equal(errs, 0, `${errs} of ${counted} symbols wrong`);
    assert.ok(r.quality > 0.9, `mean soft margin ${r.quality.toFixed(3)}`);
  },

  async function eightFskRecoversAKnownSymbolSequence() {
    const tones = [];
    for (let i = 0; i < 8; i++) tones.push(1000 + i * 200);
    const rnd = lcg(23);
    const symbols = Array.from({ length: 400 }, () => Math.floor(rnd() * 8));
    const x = synthMfsk(symbols, tones, { baud: 50 });
    const r = fskDemod(x, SR, { tones, baud: 50 });
    assert.equal(r.ok, true, r.reason || '');
    assert.equal(r.order, 8);
    let errs = 0, counted = 0;
    for (let m = 1; m < r.count - 1; m++) {
      const idx = Math.floor(r.times[m] * 50);
      if (idx < 0 || idx >= symbols.length) continue;
      counted++; if (r.symbols[m] !== symbols[idx]) errs++;
    }
    assert.ok(counted > 300, `only ${counted} symbols compared`);
    assert.equal(errs, 0, `${errs} of ${counted} symbols wrong`);
    assert.match(describeFsk(r), /^8-FSK at 50\.000 baud/);
  },

  async function blindDemodFindsBothTonesAndRateOnItsOwn() {
    const tones = [1300, 1500, 1700, 1900];
    const rnd = lcg(29);
    const symbols = Array.from({ length: 500 }, () => Math.floor(rnd() * 4));
    const x = synthMfsk(symbols, tones, { baud: 75 });
    const r = fskDemod(x, SR, {});
    assert.equal(r.ok, true, r.reason || '');
    assert.equal(r.order, 4, `found ${r.order} tones: ${r.tones.map((t) => t.toFixed(0))}`);
    assert.ok(Math.abs(r.baud - 75) / 75 < 0.01, `measured ${r.baud.toFixed(3)} baud`);
    for (let i = 0; i < 4; i++) assert.ok(Math.abs(r.tones[i] - tones[i]) < 6);
  },

  async function refusesToDemodulateNoise() {
    const x = new Float64Array(SR * 2);
    noiseInto(x, 1, 31);
    const r = fskDemod(x, SR, {});
    assert.equal(r.ok, false);
    assert.ok(r.reason && r.reason.length > 10, r.reason);
  },

  // --- RTTY ----------------------------------------------------------------

  async function decodesRttyExactlyAtTheRealParameters() {
    const msg = 'CQ CQ DE VVV THE QUICK BROWN FOX';
    const x = synthRtty(msg, {});
    const r = decodeRtty(x, SR, { markHz: 2125, spaceHz: 2295 });
    assert.equal(r.ok, true, r.reason || '');
    assert.equal(r.text, msg, `got '${r.text}'`);
    assert.equal(r.polarity, 'normal');
    assert.ok(Math.abs(r.shiftHz - 170) < 1);
    assert.match(r.convention, /mark = 2125\.0 Hz/);
  },

  async function findsTonesPolarityAndTextWithNothingToldButTheBaud() {
    const msg = 'RYRYRY DE OK1ABC PSE K';
    const x = synthRtty(msg, {});
    const r = decodeRtty(x, SR, {});
    assert.equal(r.ok, true, r.reason || '');
    assert.equal(r.text, msg, `got '${r.text}'`);
    assert.ok(Math.abs(r.markHz - 2125) < 5, `mark read ${r.markHz.toFixed(1)}`);
    assert.ok(Math.abs(r.spaceHz - 2295) < 5, `space read ${r.spaceHz.toFixed(1)}`);
  },

  async function detectsReversedPolarityRatherThanInvertingTheText() {
    // Mark on the HIGHER audio tone, which is what upper-sideband reception of
    // an ordinary RTTY signal gives.
    const msg = 'REVERSE SHIFT TEST DE WX';
    const x = synthRtty(msg, { mark: 2295, space: 2125 });
    const r = decodeRtty(x, SR, {});
    assert.equal(r.ok, true, r.reason || '');
    assert.equal(r.polarity, 'reverse', `chose ${r.polarity}, margin ${r.polarityMargin}`);
    assert.equal(r.text, msg, `got '${r.text}'`);
    assert.ok(r.polarityMargin > 1.25, `polarity margin only ${r.polarityMargin}`);
    assert.match(r.convention, /higher audio tone/);
  },

  async function forcingTheWrongPolarityProducesGarbageNotSilence() {
    // The failure has to be visible: the wrong sense frames far fewer
    // characters, and the result says so instead of returning plausible text.
    const msg = 'THIS IS A TEST OF POLARITY';
    const x = synthRtty(msg, {});
    const wrong = decodeRtty(x, SR, { markHz: 2295, spaceHz: 2125, polarity: 'reverse' });
    assert.notEqual(wrong.text, msg);
    const right = decodeRtty(x, SR, { markHz: 2125, spaceHz: 2295 });
    // Measured on this signal: the inverted sense still frames a fair number of
    // characters, because five arbitrary data bits land on a valid stop often
    // enough. Framing count alone is a 1.4:1 discriminator here, which is why
    // the automatic choice weights it by how much of the result is assigned
    // characters rather than shift churn.
    assert.ok(right.frames > wrong.frames, `wrong polarity framed ${wrong.frames} against ${right.frames} right`);
    assert.ok(right.score > wrong.score + 0.3, `scores ${right.score.toFixed(2)} against ${wrong.score.toFixed(2)}`);
  },

  async function decodesFromAnArbitraryStartNotOnASymbolBoundary() {
    const msg = 'TIMING RECOVERY DE PHASE';
    const full = synthRtty(msg, { leadSec: 0.2 });
    // Cut 37 samples in, which at 45.45 baud is 0.21 of a bit: nothing lines up.
    const cut = full.slice(1637);
    const r = decodeRtty(cut, SR, { markHz: 2125, spaceHz: 2295 });
    assert.equal(r.ok, true, r.reason || '');
    assert.ok(r.text.includes('RECOVERY DE PHASE'), `got '${r.text}'`);
  },

  async function unshiftOnSpaceIsAFlagAndItCorruptsDigitGroups() {
    // Two figures groups separated by a space, which is exactly the traffic
    // the convention breaks: the space silently returns the shift to letters.
    const msg = '12345 67890';
    const x = synthRtty(msg, {});
    const off = decodeRtty(x, SR, { markHz: 2125, spaceHz: 2295, unshiftOnSpace: false });
    const on = decodeRtty(x, SR, { markHz: 2125, spaceHz: 2295, unshiftOnSpace: true });
    assert.equal(off.text, msg, `with the convention off: '${off.text}'`);
    assert.notEqual(on.text, msg);
    assert.equal(on.text, '12345 YUIOP', `with the convention on: '${on.text}'`);
  },

  async function theTwoFiguresTablesDifferWhereTheyAreDocumentedTo() {
    // The digits are identical in ITA2 and USTTY, which is why a numbers
    // transmission reads the same in both; the punctuation is not.
    //
    // Eight of the character, not one: a two-frame burst does not carry enough
    // evidence to pass the presence gate and is refused, which is the subject
    // of `refusesTwoCharactersAsTooLittleEvidence` below.
    const x = synthRtty('$$$$$$$$', { variant: 'us' });
    const us = decodeRtty(x, SR, { markHz: 2125, spaceHz: 2295, variant: 'us' });
    const ita2 = decodeRtty(x, SR, { markHz: 2125, spaceHz: 2295, variant: 'ita2' });
    assert.equal(us.text, '$$$$$$$$');
    assert.equal(ita2.text, '', `ITA2 has no character on that code, got '${ita2.text}'`);
    const digits = synthRtty('90210', {});
    for (const v of ['ita2', 'us']) {
      const r = decodeRtty(digits, SR, { markHz: 2125, spaceHz: 2295, variant: v });
      assert.equal(r.text, '90210', `${v} read '${r.text}'`);
    }
  },

  async function survivesTheLowAfskPairToo() {
    const msg = 'LOW TONES 1275 1445';
    const x = synthRtty(msg, { mark: AFSK_PAIRS.low.mark, space: AFSK_PAIRS.low.space });
    const r = decodeRtty(x, SR, {});
    assert.equal(r.text, msg, `got '${r.text}'`);
    assert.ok(Math.abs(r.markHz - 1275) < 5);
  },

  async function decodesExactlyAtSixDbSnr() {
    const msg = 'NOISE FLOOR TEST DE RTTY';
    const x = synthRtty(msg, {});
    noiseInto(x, sigmaFor(6), 101);
    const r = decodeRtty(x, SR, { markHz: 2125, spaceHz: 2295 });
    assert.equal(r.text, msg, `at 6 dB in 4 kHz: '${r.text}'`);
    assert.ok(r.armSnrDb > 6, `per-arm SNR read ${r.armSnrDb} dB; it should exceed the broadband figure`);
  },

  async function degradesIntoWarningsRatherThanConfidentGarbage() {
    // Far below where it works. What matters is that the numbers attached to
    // the result say it failed: the soft margin collapses and the framing
    // success rate falls, so a caller can tell.
    const msg = 'NOISE FLOOR TEST DE RTTY';
    const clean = synthRtty(msg, {});
    const dirty = Float64Array.from(clean);
    noiseInto(dirty, sigmaFor(-12), 103);
    const good = decodeRtty(clean, SR, { markHz: 2125, spaceHz: 2295 });
    const bad = decodeRtty(dirty, SR, { markHz: 2125, spaceHz: 2295 });
    assert.notEqual(bad.text, msg);
    assert.ok(bad.frameSuccess < good.frameSuccess * 0.8,
      `framing held up at -12 dB: ${bad.frameSuccess.toFixed(2)} against ${good.frameSuccess.toFixed(2)}`);
    assert.ok(bad.bitMargin < good.bitMargin * 0.6,
      `bit margin held up at -12 dB: ${bad.bitMargin.toFixed(2)} against ${good.bitMargin.toFixed(2)}`);
  },

  async function measuresAnOffNominalSymbolRateInsteadOfAssumingIt() {
    // A transmitter 1.5% fast. Told to measure, it must report the rate it
    // found and say it is not the one it was handed.
    const msg = 'CLOCK ERROR TEST';
    const x = synthRtty(msg, { baud: 46.14 });
    const r = decodeRtty(x, SR, { markHz: 2125, spaceHz: 2295, estimateBaudFromSignal: true });
    assert.ok(Math.abs(r.baud - 46.14) < 0.4, `measured ${r.baud.toFixed(3)} baud, not 46.14`);
    assert.match(r.warnings.join(' '), /measured .* baud, not the 45.45 assumed/);
    assert.equal(r.text, msg, `got '${r.text}'`);
  },

  async function reportsWhenTheShiftIsNotWhatWasExpected() {
    const x = synthRtty('WIDE SHIFT', { mark: 1500, space: 2350 });
    const r = decodeRtty(x, SR, {});
    assert.match(r.warnings.join(' '), /is not the 170 Hz expected/);
    assert.ok(Math.abs(r.shiftHz - 850) < 6, `shift read ${r.shiftHz.toFixed(1)}`);
    assert.equal(r.text, 'WIDE SHIFT', `got '${r.text}'`);
  },

  async function encodeIta2RoundTripsThroughTheDecodersOwnTables() {
    const codes = encodeIta2('AB 12');
    assert.deepEqual(codes, [3, 25, 4, 27, 23, 19]);
    assert.throws(() => encodeIta2('~'), /no ITA2 code/);
  },

  async function powerSpectrumReadsAUnitToneAtMinusSixDb() {
    // The cross-check path has to agree with analytic.js's Goertzel scaling, or
    // the two tone estimates are not comparable.
    const n = SR * 2;
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.cos(2 * Math.PI * 1000 * i / SR);
    const spec = powerSpectrum(x, SR, { size: 1024 });
    const k = Math.round(1000 / spec.binHz);
    assert.ok(Math.abs(10 * Math.log10(spec.mag[k]) + 6.02) < 0.3,
      `unit tone read ${(10 * Math.log10(spec.mag[k])).toFixed(2)} dB, not -6.02`);
  },

  async function perArmSnrStopsAtItsOwnLeakageCeilingAndSaysSo() {
    // A rectangular Goertzel window leaks the winning tone into every other
    // arm, so the losing arms can never read cleaner than that. On a noiseless
    // 2125/2295 pair at 45.45 baud in 8 kHz the ceiling is 24.1 dB, and the
    // estimate must stop there with a warning rather than report the infinite
    // SNR the signal actually has.
    const x = synthRtty('CEILING TEST', {});
    const trace = toneTrace(x, SR, { tones: [2125, 2295], baud: BAUD, oversample: 8 });
    const ceiling = leakageCeilingDb([2125, 2295], SR, trace.win);
    assert.ok(Math.abs(ceiling - 24.14) < 0.2, `ceiling computed as ${ceiling.toFixed(2)} dB`);
    assert.ok(trace.armSnrDb < ceiling, `read ${trace.armSnrDb.toFixed(1)} dB above its own ${ceiling.toFixed(1)} dB ceiling`);
    assert.ok(trace.armSnrDb > ceiling - 4, `read ${trace.armSnrDb.toFixed(1)} dB on a noiseless signal`);
    assert.match(trace.warnings.join(' '), /leakage ceiling/);
  },

  async function agcRefusesToCalibrateAnArmItHasNoEvidenceFor() {
    // A tone used for 1% of symbols has no reliable winning level, and an
    // uncorrected ratio hands it a gain of tens. Measured on the XPA body: a
    // slot used 1.8% of the time asked for a gain of 81.
    const tones = [1200, 1400, 1600, 1800];
    const rnd = lcg(41);
    const symbols = Array.from({ length: 400 }, () => (rnd() < 0.01 ? 3 : Math.floor(rnd() * 3)));
    const x = synthMfsk(symbols, tones, { baud: 50 });
    const trace = toneTrace(x, SR, { tones, baud: 50, oversample: 8 });
    assert.equal(trace.gains[3], 1, `rare arm was given a gain of ${trace.gains[3].toFixed(1)}`);
    assert.match(trace.warnings.join(' '), /1800\.0 Hz (never won|held the lead for a full symbol window on only)/);
    for (let j = 0; j < 3; j++) assert.ok(trace.gains[j] > 0.5 && trace.gains[j] < 2);
  },

  async function gridFitSurvivesAMissingSlotAndAnOutlyingLine() {
    // Nine lines on a 40 Hz grid with two slots empty, plus a marker tone two
    // slots below the comb: exactly the shape of the XPA body's spectrum.
    const lines = [677.7, 757.8, 797.8, 837.8, 877.9, 917.9, 957.9, 997.9, 1038.0, 1078.0, 1118.0, 1197.3];
    const fit = gridFit(lines, 4);
    assert.equal(fit.regular, true);
    assert.ok(Math.abs(fit.spacingHz - 40) < 0.3, `spacing fitted at ${fit.spacingHz.toFixed(2)} Hz`);
    assert.equal(fit.slots, 14, `grid inferred ${fit.slots} slots`);
    assert.ok(fit.residualHz < 1, `worst line ${fit.residualHz.toFixed(2)} Hz off the grid`);
    // A fine enough grid fits ANY set of lines, so `regular` alone is not
    // evidence of an alphabet — the slot count is. Irregular lines only fit a
    // grid with far more slots than there are lines, and that ratio is what
    // separates a real MFSK comb from four unrelated carriers.
    const irregular = gridFit([1000, 1041, 1097, 1130], 2);
    assert.ok(irregular.slots > 12, `four unrelated lines fitted ${irregular.slots} slots`);
    assert.ok(fit.slots / fit.tones.length < 1.3, 'a real comb fills most of its grid');
    assert.equal(gridFit([1500], 4), null);
  },


  // --- is anything there at all? -------------------------------------------
  //
  // The four cases below are the ones this capability exists for. Before them,
  // `decodeRtty` given eight seconds of white noise and told markHz = 2125,
  // spaceHz = 2295 returned ok: true, zero warnings, and strings like
  // 'EKDXHR...' on five seeds out of five. A teleprinter decoder that types out
  // of hiss is worse than no decoder, because a person will believe it.

  async function refusesToTypeTextOutOfHiss() {
    // Twenty-four independent regions of white noise, each told exactly where
    // the tones are. Not one may come back as a decode.
    const accepted = [];
    for (let seed = 1; seed <= 24; seed++) {
      const x = new Float64Array(SR * 8);
      noiseInto(x, 1, seed);
      const r = decodeRtty(x, SR, { markHz: 2125, spaceHz: 2295 });
      if (r.ok) accepted.push(`seed ${seed}: '${r.text.slice(0, 24)}'`);
      assert.equal(r.text, '', `seed ${seed} returned text from noise: '${r.text}'`);
      assert.ok(r.reason && /no RTTY signal/.test(r.reason), `seed ${seed} gave no reason: ${r.reason}`);
      // The refusal has to be legible, not just a flag.
      assert.ok(r.presence.failed.length > 0, `seed ${seed} refused without saying which test failed`);
    }
    assert.deepEqual(accepted, [], `${accepted.length} of 24 noise seeds were accepted as RTTY: ${accepted.join(' | ')}`);
  },

  async function theNullEachPresenceTestAssumesIsTheOneNoiseActuallyProduces() {
    // A threshold is only a false-accept rate if the null it is set against is
    // the real one. Both nulls here are derived, not fitted: two Goertzel arms
    // over white noise are iid Exp(1), so the normalised pair is Uniform(0,1)
    // and the margin |2U - 1| has mean 1/2; and the stop bit sits 6.5 symbol
    // widths from the start edge, further than the one-symbol window reaches,
    // so it is a fair coin. Both are checked here against what noise does.
    assert.equal(nullMargin(2).mean, 0.5);
    assert.ok(Math.abs(nullMargin(2).sd - Math.sqrt(1 / 12)) < 1e-12);
    const seps = [], stops = [];
    for (let seed = 101; seed <= 124; seed++) {
      const x = new Float64Array(SR * 8);
      noiseInto(x, 1, seed);
      const r = decodeRtty(x, SR, { markHz: 2125, spaceHz: 2295 });
      seps.push(r.presence.separation);
      stops.push(r.presence.stopRate);
    }
    const mean = (a) => a.reduce((p, c) => p + c, 0) / a.length;
    // Measured over these 24 seeds: separation 0.497, stop rate 0.470.
    assert.ok(Math.abs(mean(seps) - 0.5) < 0.02,
      `arm separation on noise averaged ${mean(seps).toFixed(4)}, not the 0.5 the null claims`);
    assert.ok(Math.abs(mean(stops) - 0.5) < 0.06,
      `stop bit on noise passed at ${mean(stops).toFixed(4)}, not the 0.5 the null claims`);
    // ...and the standardised separation really is standard: |z| under 4 on
    // every one of them, against a gate that asks for a joint 1e-9.
    for (let seed = 101; seed <= 124; seed++) {
      const x = new Float64Array(SR * 8);
      noiseInto(x, 1, seed);
      const r = decodeRtty(x, SR, { markHz: 2125, spaceHz: 2295 });
      assert.ok(Math.abs(r.presence.separationZ) < 4,
        `noise seed ${seed} reached z = ${r.presence.separationZ.toFixed(2)}`);
    }
  },

  async function saysHowFarDownItStillReadsAndWhereItStops() {
    // What the gate costs, on the record. Measured over ten noise seeds per
    // point on this message: exact text 10/10 at -3 dB and 8/10 at -6 dB;
    // signal still declared present 10/10 down to -12 dB; refused on all ten
    // by -18 dB. The three points asserted here are the unambiguous ones.
    const msg = 'CQ CQ DE VVV THE QUICK BROWN FOX RYRYRYRY DE TEST TEST';
    const at = (snrDb, seed) => {
      const x = synthRtty(msg, {});
      noiseInto(x, sigmaFor(snrDb), seed);
      return decodeRtty(x, SR, { markHz: 2125, spaceHz: 2295 });
    };
    for (let seed = 1; seed <= 4; seed++) {
      const good = at(-3, seed * 97 + 3);
      assert.equal(good.ok, true, `-3 dB seed ${seed}: ${good.reason}`);
      assert.equal(good.text, msg, `-3 dB seed ${seed} read '${good.text}'`);

      // Present but not readable. The gate answers "is there a teleprinter
      // here", not "is this text right", and the difference has to be visible
      // in the warnings rather than left for the reader to guess.
      const weak = at(-12, seed * 97 + 3);
      assert.equal(weak.ok, true, `-12 dB seed ${seed} refused a signal that is really there: ${weak.reason}`);
      assert.notEqual(weak.text, msg);
      assert.match(weak.warnings.join(' '), /characters are being lost|framing is slipping/,
        `-12 dB seed ${seed} returned wrong text with no warning`);

      const gone = at(-18, seed * 97 + 3);
      assert.equal(gone.ok, false, `-18 dB seed ${seed} claimed '${gone.text}'`);
      assert.equal(gone.text, '');
    }
  },

  async function refusesEveryOtherSteadyThingThatIsNotRtty() {
    // Noise is the easy case. These are the ones a bench actually meets: a
    // carrier, a pair of carriers, something drifting, and — the dangerous one
    // — real RTTY read at the wrong tone pair or the wrong rate, which frames
    // dozens of characters and used to hand back every one of them.
    const msg = 'CQ CQ DE VVV THE QUICK BROWN FOX RYRYRYRY DE TEST TEST';
    const tone = (hz, sec = 8) => {
      const x = new Float64Array(SR * sec);
      for (let i = 0; i < x.length; i++) x[i] = Math.cos(2 * Math.PI * hz * i / SR);
      return x;
    };
    const cases = [];
    cases.push(['a steady carrier on the mark tone', tone(2125), {}]);
    {
      const x = new Float64Array(SR * 8);
      for (let i = 0; i < x.length; i++) {
        x[i] = Math.cos(2 * Math.PI * 2125 * i / SR) + Math.cos(2 * Math.PI * 2295 * i / SR + 1);
      }
      cases.push(['both tones sounding at once', x, {}]);
    }
    {
      const x = new Float64Array(SR * 8);
      let phase = 0;
      for (let i = 0; i < x.length; i++) {
        phase += 2 * Math.PI * (2000 + 400 * Math.sin(2 * Math.PI * 0.7 * i / SR)) / SR;
        x[i] = Math.cos(phase);
      }
      cases.push(['a tone drifting across the pair', x, {}]);
    }
    cases.push(['real RTTY, receiver on the wrong pair', synthRtty(msg, { mark: 1275, space: 1445 }), {}]);
    cases.push(['real RTTY, decoded at 100 baud', synthRtty(msg, {}), { baud: 100 }]);
    {
      const x = new Float64Array(SR * 8);
      for (let i = 0; i < x.length; i++) x[i] = 0.8 * Math.cos(2 * Math.PI * 2125 * i / SR);
      noiseInto(x, 0.5, 3);
      cases.push(['a carrier in noise', x, {}]);
    }
    for (const [name, x, extra] of cases) {
      const r = decodeRtty(x, SR, { markHz: 2125, spaceHz: 2295, ...extra });
      assert.equal(r.ok, false, `${name} was decoded as RTTY: '${r.text}'`);
      assert.equal(r.text, '', `${name} returned text: '${r.text}'`);
    }
  },

  async function refusesTwoCharactersAsTooLittleEvidence() {
    // A two-frame burst off a NOISELESS recording. The arms separate perfectly
    // — z is over 8 — and it is still refused, because two characters cannot
    // carry a frame clock and the stop bit cannot beat a coin more than four to
    // one in two tosses. This is the reachable "I cannot tell": it is not a
    // degenerate input, it is a short transmission.
    const x = synthRtty('$', { variant: 'us' });
    const r = decodeRtty(x, SR, { markHz: 2125, spaceHz: 2295, variant: 'us' });
    assert.equal(r.ok, false, `two characters were decoded as '${r.text}'`);
    assert.equal(r.text, '');
    assert.ok(r.presence.separationZ > 5,
      `the arms should separate cleanly on a noiseless signal; z = ${r.presence.separationZ.toFixed(1)}`);
    assert.equal(r.frames, 2);
    // The characters are still there to look at; they are just not a decode.
    assert.equal(r.rejectedText, '$');
    // ...and eight of the same character is enough.
    const longer = decodeRtty(synthRtty('$$$$$$$$', { variant: 'us' }), SR,
      { markHz: 2125, spaceHz: 2295, variant: 'us' });
    assert.equal(longer.ok, true, longer.reason || '');
    assert.equal(longer.text, '$$$$$$$$');
  },

  // --- the symbol rate, and what it can and cannot know --------------------

  async function fskDemodRefusesNoiseEvenWhenToldExactlyWhereTheTonesAre() {
    // The N-ary path had the same hole as the RTTY one. Told the tones and the
    // rate, eight seconds of white noise came back ok with 363 symbols, no
    // warnings, and `describeFsk` announcing "2-FSK at 45.450 baud, tones
    // 2125.0 / 2295.0 Hz, per-arm SNR 2.6 dB".
    //
    // The guard that was supposed to catch this compared the mean soft margin
    // against a fixed 0.3. Two arms of pure noise average EXACTLY 0.5, so the
    // test could never fire on a 2-FSK bank however empty the band; on eight
    // arms, where chance is 0.211, it fired on good signals instead. The level
    // to beat is a function of the arm count and nothing else.
    assert.ok(Math.abs(nullMargin(2).mean - 0.5) < 1e-12);
    assert.ok(Math.abs(nullMargin(8).mean - 0.211) < 0.01,
      `eight arms of noise average ${nullMargin(8).mean.toFixed(3)}`);
    for (const [order, tones, baud] of [
      [2, [2125, 2295], BAUD],
      [8, [1200, 1400, 1600, 1800, 2000, 2200, 2400, 2600], 50],
    ]) {
      for (let seed = 1; seed <= 6; seed++) {
        const x = new Float64Array(SR * 8);
        noiseInto(x, 1, seed);
        const r = fskDemod(x, SR, { tones, baud });
        assert.equal(r.ok, false, `${order}-arm bank, seed ${seed}: claimed ${r.count} symbols out of noise`);
        assert.equal(r.symbols, null);
        assert.match(r.reason, /no FSK signal in these arms/);
        assert.match(describeFsk(r), /^no FSK:/);
      }
    }
    // ...and it still demodulates a real stream that sits well down in noise.
    const rnd = lcg(31);
    const tones = [1200, 1400, 1600, 1800];
    const symbols = Array.from({ length: 500 }, () => Math.floor(rnd() * 4));
    const y = synthMfsk(symbols, tones, { baud: 100 });
    noiseInto(y, sigmaFor(-3), 77);
    const good = fskDemod(y, SR, { tones, baud: 100 });
    assert.equal(good.ok, true, good.reason || '');
    assert.ok(good.presence.z > 20, `a real signal at -3 dB reached only z = ${good.presence.z.toFixed(1)}`);
  },

  async function theAgcDoesNotInventATiltOutOfShortRuns() {
    // Both tones at IDENTICAL amplitude, carrying the repeating pattern 0111 at
    // 50 baud. Arm 0's runs are one symbol long, so its window is never full
    // and its median winning level reads low through no fault of the channel.
    // Calibrating on every winning step handed it a gain of 1.389 against
    // 0.781 for the long-run arm — a 5.0 dB tilt invented out of the
    // modulation — which moved every crossing by 0.093 symbol and made
    // `estimateBaud` return 337.500 baud for a 50 baud signal.
    const tones = [1500, 1700];
    const pattern = [0, 1, 1, 1];
    const symbols = [];
    while (symbols.length < 600) symbols.push(...pattern);
    const x = synthMfsk(symbols, tones, { baud: 50 });
    const trace = toneTrace(x, SR, { tones, baud: 50, oversample: 16, agc: true });
    assert.ok(Math.abs(trace.gains[0] - 1) < 0.02 && Math.abs(trace.gains[1] - 1) < 0.02,
      `equal-amplitude tones were given gains ${trace.gains[0].toFixed(3)} and ${trace.gains[1].toFixed(3)}`);
    // The edges themselves, against where the keyer actually put them.
    const times = transitions(trace);
    const expected = [];
    for (let i = 1; i < symbols.length; i++) if (symbols[i] !== symbols[i - 1]) expected.push(i / 50);
    let worst = 0;
    for (let i = 0; i < Math.min(60, times.length); i++) {
      worst = Math.max(worst, Math.abs(times[i] - expected[i]) * 50);
    }
    assert.ok(worst < 0.02, `worst edge sat ${worst.toFixed(4)} symbols off the true boundary`);
    const est = estimateBaud(times, {});
    assert.ok(Math.abs(est.baud - 50) < 0.1, `read ${est.baud.toFixed(3)} baud from a 50 baud signal`);
  },

  async function aRepeatingPatternHasNoKnowableSymbolRate() {
    // 0011 at 50 baud puts its transitions in exactly the places 01 at 25 baud
    // does, to the last sample. Nothing in the instants separates them, so the
    // transition grid is measurable and the SYMBOL rate is not. Saying 25 baud
    // with a Rayleigh p of 1e-126 is a lie about which question was answered.
    const tones = [1500, 1700];
    const symbols = [];
    while (symbols.length < 600) symbols.push(0, 0, 1, 1);
    const x = synthMfsk(symbols, tones, { baud: 50 });
    const est = estimateBaud(transitions(toneTrace(x, SR, { tones, baud: 50, oversample: 16 })), {});
    assert.equal(est.ok, true, est.reason || '');
    assert.ok(Math.abs(est.baud - 25) < 0.1, `transition grid read ${est.baud.toFixed(3)}`);
    assert.equal(est.symbolRate, null, `claimed a symbol rate of ${est.symbolRate}`);
    assert.equal(est.ambiguous, true);
    assert.equal(est.gapPeriod, 1, `gap sequence period read ${est.gapPeriod}`);
    assert.ok(est.consistentWith.length >= 3, 'the rates it is equally consistent with must be listed');
    assert.ok(Math.abs(est.consistentWith[1] - 50) < 0.2,
      `the true 50 baud should be among them: ${est.consistentWith.map((v) => v.toFixed(1))}`);
    assert.match(est.reason, /fixed pattern and not traffic/);
    assert.match(est.warnings.join(' '), /symbol rate is not determined/);

    // ...while an ordinary message, which puts two transitions one symbol apart
    // constantly, does name its rate.
    const rnd = lcg(3);
    const random = Array.from({ length: 600 }, () => Math.floor(rnd() * 2));
    const y = synthMfsk(random, tones, { baud: 50 });
    const good = estimateBaud(transitions(toneTrace(y, SR, { tones, baud: 50, oversample: 16 })), {});
    assert.equal(good.ambiguous, false, good.reason || '');
    assert.ok(Math.abs(good.symbolRate - 50) < 0.1, `read ${good.symbolRate} baud`);
  },

  async function findsTheFundamentalOfAnEightToneStreamNotItsDouble() {
    // The coarse scan on a dense 8-FSK transition train peaks near 500 Hz, and
    // a divisor search capped at 6 cannot reach 50 from there: 500/6 is 83. The
    // estimator returned 100.000 baud for a 50 baud signal, with R = 1.0000 at
    // both. Two transitions cannot be closer than one symbol, so the shortest
    // observed gap is the floor that makes a wider divisor search safe.
    const tones = [];
    for (let i = 0; i < 8; i++) tones.push(1200 + i * 200);
    const rnd = lcg(23);
    const symbols = Array.from({ length: 800 }, () => Math.floor(rnd() * 8));
    const x = synthMfsk(symbols, tones, { baud: 50 });
    const est = estimateBaud(transitions(toneTrace(x, SR, { tones, baud: 50, oversample: 16 })), {});
    assert.equal(est.ok, true, est.reason || '');
    assert.ok(Math.abs(est.baud - 50) < 0.2, `read ${est.baud.toFixed(3)} baud, not 50`);
    assert.ok(Math.abs(est.symbolRate - 50) < 0.2, `symbol rate read ${est.symbolRate}`);
  },

  // --- error bars that survive being checked -------------------------------

  async function theBaudErrorBarSurvivesItsOwnSplitHalf() {
    // A number with a bar on it is a claim about what a second look would find.
    // So the estimator takes a second look: it measures the first half of the
    // region and the second half separately and requires them to agree inside
    // the bar, widening the bar when they do not.
    const tones = [1500, 1700];
    for (const [seed, baud, snrDb] of [[3, 50, null], [7, 45.45, 10], [11, 100, 6]]) {
      const rnd = lcg(seed);
      const symbols = Array.from({ length: 900 }, () => Math.floor(rnd() * 2));
      const x = synthMfsk(symbols, tones, { baud });
      if (snrDb != null) noiseInto(x, sigmaFor(snrDb), seed * 13);
      const est = estimateBaud(transitions(toneTrace(x, SR, { tones, baud, oversample: 16 })), {});
      assert.equal(est.ok, true, est.reason || '');
      assert.ok(est.baudSe > 0, 'a bar of zero is not a bar');
      assert.ok(est.splitHalf, 'the split-half check must actually run');
      // The two halves agree inside the bar the estimator reports...
      assert.ok(est.splitHalf.difference <= 8 * est.baudSe + 1e-12,
        `halves read ${est.splitHalf.baudFirst.toFixed(4)} and ${est.splitHalf.baudSecond.toFixed(4)} baud `
        + `(${est.splitHalf.difference.toFixed(5)} apart) against a bar of ${est.baudSe.toFixed(5)}`);
      // ...and the truth is inside it too, which a bar that only agreed with
      // itself would not guarantee.
      assert.ok(Math.abs(est.baud - baud) < Math.max(6 * est.baudSe, 0.05),
        `read ${est.baud.toFixed(4)} +/- ${est.baudSe.toFixed(5)} against a true ${baud}`);
    }
  },

  async function thePerArmSnrCarriesABarThatSurvivesSplitHalf() {
    const msg = 'CQ CQ DE VVV THE QUICK BROWN FOX RYRYRYRY DE TEST TEST';
    for (const snrDb of [12, 6, 0]) {
      const x = synthRtty(msg, {});
      noiseInto(x, sigmaFor(snrDb), 401);
      const trace = toneTrace(x, SR, { tones: [2125, 2295], baud: BAUD, oversample: 8 });
      assert.ok(trace.armSnrSeDb > 0, `no error bar on a ${snrDb} dB signal`);
      assert.ok(trace.armSnrSplitHalf, 'the split-half check must actually run');
      assert.ok(trace.armSnrSplitHalf.differenceDb <= 4 * trace.armSnrSeDb + 1e-9,
        `halves read ${trace.armSnrSplitHalf.firstDb.toFixed(2)} and ${trace.armSnrSplitHalf.secondDb.toFixed(2)} dB `
        + `against a bar of +/-${trace.armSnrSeDb.toFixed(2)} dB`);
    }
  },

  // --- the AGC clamp -------------------------------------------------------

  async function theAgcClampIsLoadBearingAndIsStatedInPowerDb() {
    // A Goertzel returns POWER, so the gain it asks for is a power ratio and
    // the clamp is in power dB. An earlier version clamped the ratio at 10 —
    // ten in power is 10 dB — while its comment and its warning both called it
    // 20 dB, so it cut off legitimate correction at half the stated tilt.
    assert.equal(AGC_CLAMP_DB, 20);
    const tones = [1200, 1400, 1600, 1800];
    const rnd = lcg(13);
    const symbols = Array.from({ length: 400 }, () => Math.floor(rnd() * 4));
    // Arm 3 attenuated by 26 dB in amplitude, with broadband noise present.
    const atten = Math.pow(10, -26 / 20);
    const spb = SR / 50;
    const n = Math.round(symbols.length * spb);
    const x = new Float64Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const sym = symbols[Math.min(symbols.length - 1, Math.floor(i / spb))];
      phase += 2 * Math.PI * tones[sym] / SR;
      x[i] = (sym === 3 ? atten : 1) * Math.cos(phase);
    }
    noiseInto(x, sigmaFor(20), 9);
    const trace = toneTrace(x, SR, { tones, baud: 50, oversample: 8 });
    // The clamp engaged, and says so in power dB.
    assert.ok(Math.abs(trace.gains[3] - Math.pow(10, AGC_CLAMP_DB / 10)) < 1e-6,
      `arm 3 was given a gain of ${trace.gains[3].toFixed(1)}, not the ${Math.pow(10, AGC_CLAMP_DB / 10)} the clamp allows`);
    assert.match(trace.warnings.join(' '), /1800\.0 Hz wanted 26 dB of gain correction and was clamped to 20 dB/);
    // ...and it is doing work. The symbols were drawn uniformly from four
    // tones, so arm 3 should win about a quarter of the steps. Measured:
    // 27.9% with the clamp, 43.0% without it — unclamped the arm is handed a
    // gain of about 400 and starts taking decisions from the other three.
    let wins = 0;
    for (let s = 0; s < trace.steps; s++) if (trace.winner[s] === 3) wins++;
    const share = wins / trace.steps;
    assert.ok(share > 0.2 && share < 0.33,
      `arm 3 won ${(share * 100).toFixed(1)}% of steps against a true share of 25%`);
  },

  // --- the character tables, pinned to the standard ------------------------

  async function ita2LettersMatchTheStandardBitPatternsNotJustTheirOwnInverse() {
    // Round-tripping through `encodeIta2` proves nothing about the table: it
    // encodes with the same array it decodes with, so swapping X and V leaves
    // every such test passing. These are the bit patterns as ITA2 states them,
    // written out here in transmission order (bit 1 first) and independent of
    // anything in the decoder.
    const STANDARD = {
      A: '11000', B: '10011', C: '01110', D: '10010', E: '10000', F: '10110',
      G: '01011', H: '00101', I: '01100', J: '11010', K: '11110', L: '01001',
      M: '00111', N: '00110', O: '00011', P: '01101', Q: '11101', R: '01010',
      S: '10100', T: '00001', U: '11100', V: '01111', W: '11001', X: '10111',
      Y: '10101', Z: '10001',
      ' ': '00100', '\r': '00010', '\n': '01000',
    };
    // Bit 1 is sent first and is the least significant bit of the code index.
    const codeOf = (bits) => bits.split('').reduce((acc, b, i) => acc | (b === '1' ? 1 << i : 0), 0);
    assert.equal(codeOf('11000'), 3, 'A is 11000, which is code 3');
    assert.equal(codeOf('00001'), 16, 'T is 00001, which is code 16');

    // Drive the real decoder one character at a time and check it produces the
    // character the standard assigns to that pattern. Going through the audio
    // path pins the bit ORDER as well as the table.
    for (const [ch, bits] of Object.entries(STANDARD)) {
      const code = codeOf(bits);
      const got = decodeFramedChars(Array.from({ length: 10 }, () => bits));
      const name = (c) => (c === '\r' ? 'CR' : c === '\n' ? 'LF' : c === ' ' ? 'SP' : c);
      assert.equal(got, ch.repeat(10),
        `ITA2 ${bits} (code ${code}) is ${name(ch)}, decoder said ${name(got[0])}`);
    }
    // CR and LF really are distinct codes, whatever `text` does with them
    // afterwards: 00010 is CR at code 8 and 01000 is LF at code 2, and reading
    // them the other way round is a whole-transmission error that a
    // round-trip test through the decoder's own table could never catch.
    assert.equal(codeOf('00010'), 8);
    assert.equal(codeOf('01000'), 2);
    assert.equal(decodeFramedChars(Array.from({ length: 10 }, () => '00010')), '\r'.repeat(10));
    assert.equal(decodeFramedChars(Array.from({ length: 10 }, () => '01000')), '\n'.repeat(10));
    // The two shift codes, which have no printable character of their own.
    assert.equal(codeOf('11111'), 31, 'LTRS is 11111');
    assert.equal(codeOf('11011'), 27, 'FIGS is 11011');
    // X and V are the pair an accidental swap is easiest to miss and hardest
    // to notice in running text, so they get named here.
    assert.equal(codeOf('10111'), 29);
    assert.equal(codeOf('01111'), 30);
  },

  async function decodesAHandWrittenIta2BitStreamWithoutTheEncodersHelp() {
    // RYRY is the standard RTTY test pattern because R and Y alternate every
    // bit. Written out from the specification rather than produced by
    // `encodeIta2`, so this asserts the whole chain — framing, bit order,
    // table — against the document and not against itself.
    const R = '01010', Y = '10101';
    const bits = [];
    for (let i = 0; i < 6; i++) bits.push(R, Y);
    assert.equal(decodeFramedBits(bits), 'RYRYRYRYRYRY');
    // 'CQ': C is 01110, Q is 11101.
    assert.equal(decodeFramedBits(['01110', '11101', '00100', '01110', '11101',
      '00100', '10010', '10000', '00100', '01010', '10101']), 'CQ CQ DE RY');
  },

  async function timingRecoverySaysWhenItCannot() {
    const t = recoverTiming([0.1, 0.2], 45.45);
    assert.equal(t.ok, false);
    assert.match(t.reason, /unrecoverable/);
  },
];
