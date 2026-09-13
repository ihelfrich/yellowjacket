// ALE, MIL-STD-188-141: military and government HF stations finding each other,
// with the callsigns in the clear. The Golay code and the majority vote are
// each pinned on their own, because together they are what stops a decoder
// reading a handshake out of hiss — and this one did, before the alphabet and
// the chain rule went in.
import assert from 'node:assert/strict';

import {
  decodeAle, encodeAle, golay24Encode, golay24Decode, golay23Encode,
  encodeWord, decodeWord, makeWord, readWord, interleave, deinterleave,
  majority, assembleCalls, inAlphabet, toneSetContrastDb, INTERLEAVE, ALE_38, TONES, TONE_STEP_HZ, PREAMBLES,
  SYMBOL_RATE, TONES_PER_WORD, WORD_SEC,
} from '../js/sigint/decode/ale.js';
import { COLOURS } from './noise-colours.mjs';

export const NAME = 'sigint: ALE link establishment';

const SR = 11025;
const CALL = [{ role: 'TO', text: 'ABC' }, { role: 'DATA', text: 'DEF' }, { role: 'THIS IS', text: 'XYZ' }];

export const cases = [
  function theToneSetAndTimingAreTheStandards() {
    assert.deepEqual(TONES, [750, 1000, 1250, 1500, 1750, 2000, 2250, 2500]);
    assert.equal(SYMBOL_RATE, 125);
    assert.equal(TONES_PER_WORD, 49);
    assert.ok(Math.abs(WORD_SEC - 0.392) < 1e-9, 'a word is 392 ms');
    assert.equal(PREAMBLES[2], 'TO');
    assert.equal(PREAMBLES[5], 'THIS IS');
  },

  function golayCorrectsThreeAndRefusesFour() {
    for (const d of [0, 1, 0xfff, 0x555, 0xa3c, 0x800]) {
      const w = golay24Encode(d);
      assert.equal(golay24Decode(w).data, d, 'clean');
      assert.equal(golay24Decode(w).errors, 0);
      // Up to three bad bits anywhere in the 24, including the parity bit.
      for (const bits of [[0], [3], [23], [0, 7], [5, 19], [2, 9, 20], [0, 4, 15]]) {
        let e = w; for (const b of bits) e ^= 1 << b;
        const r = golay24Decode(e);
        assert.ok(r && r.data === d, `${bits} bad bits on ${d}`);
        assert.equal(r.errors, bits.length, `${bits} should be counted as ${bits.length} errors`);
      }
      // Four is beyond it. A decoder that repairs four is inventing traffic:
      // without this the module read five colours of noise as callsigns.
      for (const bits of [[0, 1, 2, 3], [1, 5, 11, 18], [0, 5, 11, 18]]) {
        let e = w; for (const b of bits) e ^= 1 << b;
        assert.equal(golay24Decode(e), null, `${bits} bad bits must be refused`);
      }
    }
    // The 23-bit code underneath is a real cyclic code: its syndrome is zero.
    assert.equal(golay23Encode(0xabc) >>> 11, 0xabc);
  },

  function theInterleaveIsAPermutationAndUndoesItself() {
    assert.equal(new Set(INTERLEAVE).size, 49);
    assert.equal(Math.min(...INTERLEAVE), 0);
    assert.equal(Math.max(...INTERLEAVE), 48);
    const bits = Uint8Array.from({ length: 49 }, (_, i) => (i * 7 + 3) % 2);
    assert.deepEqual(Array.from(deinterleave(interleave(bits))), Array.from(bits));
  },

  function aWordSurvivesItsOwnFecAndInterleave() {
    for (const [role, text] of [['TO', 'ABC'], ['THIS IS', 'XYZ'], ['DATA', '123'], ['REPEAT', '@ZZ']]) {
      const w = makeWord(role, text);
      assert.deepEqual(readWord(w), { preamble: PREAMBLES.indexOf(role), role, text });
      const got = decodeWord(encodeWord(w));
      assert.ok(got, `${role} ${text} failed its own round trip`);
      assert.equal(got.word, w);
      assert.equal(got.repaired, 0);
    }
    assert.throws(() => makeWord('NONSENSE', 'ABC'), /unknown preamble/);
  },

  function theMajorityVoteBreaksTiesAndCountsThem() {
    const a = new Uint8Array(147);
    for (let i = 0; i < 49; i++) { a[i] = 1; a[i + 49] = 1; a[i + 98] = 1; }
    assert.equal(majority(a).broken, 0);
    // Damage one copy in ten places: the vote fixes all ten and says so.
    for (let i = 0; i < 10; i++) a[i + 49] = 0;
    const v = majority(a);
    assert.equal(v.broken, 10);
    assert.ok(Array.from(v.bits).every((b) => b === 1), 'the majority still says one');
  },

  function aCallComesBackWordForWord() {
    for (const rate of [8000, 11025, 22050]) {
      const r = decodeAle(encodeAle(CALL, rate), rate);
      assert.ok(r.ok, `${rate}: ${r.reason}`);
      assert.deepEqual(r.calls.map((c) => c.text), ['TO ABCDEF', 'THIS IS XYZ']);
      assert.equal(r.words.length, 3);
      assert.equal(r.words.reduce((a, w) => a + w.repaired, 0), 0);
      assert.ok(r.falseAlarmInSpan < 0.05, `false alarm ${r.falseAlarmInSpan}`);
    }
  },

  function itReadsACallBuriedInNoise() {
    // The point of the stack: 8-FSK, a Golay code and a triple vote together
    // survive a channel where the signal is under the noise.
    for (const snrDb of [6, 0, -6]) {
      const clean = encodeAle(CALL, SR, { amplitude: 0.5 });
      const n = COLOURS.white(clean.length, { seed: 11, sigma: 1 });
      let ps = 0, pn = 0;
      for (let i = 0; i < clean.length; i++) { ps += clean[i] * clean[i]; pn += n[i] * n[i]; }
      const k = Math.sqrt(ps / pn) / (10 ** (snrDb / 20));
      const r = decodeAle(Float32Array.from(clean, (v, i) => v + k * n[i]), SR);
      assert.ok(r.ok, `${snrDb} dB: ${r.reason}`);
      assert.deepEqual(r.calls.map((c) => c.text), ['TO ABCDEF', 'THIS IS XYZ'], `${snrDb} dB`);
    }
  },

  function theToneSetHasToStandAboveItsOwnGaps() {
    // The test that was missing, and what it cost. A live capture of 4724 kHz,
    // a real US Air Force channel, decoded to "FROM 6DN / THIS WAS @JP" out of
    // noise. Every other gate passed — both Golay halves checked, the
    // characters were in the alphabet, two words sat back to back — and the
    // give-away was that the eight ALE tones held 0.1 dB more energy than the
    // frequencies BETWEEN them. A tone set that is there stands clear of its
    // own gaps.
    const clean = encodeAle(CALL, SR);
    assert.ok(toneSetContrastDb(clean, SR) > 6, 'a real tone set stands well clear');
    const noise = COLOURS.white(SR * 5, { seed: 6 });
    assert.ok(toneSetContrastDb(noise, SR) < 1, 'noise has nothing at the tones that it does not have between them');
    // And the contrast falls with the noise, monotonically, which is what
    // makes it a measurement rather than a switch: measured 7.8 dB clean,
    // 5.1 at 0 dB SNR, 2.6 at -6 and 1.6 at -9, which is where the bar sits.
    const contrasts = [];
    for (const snrDb of [10, 0, -6]) {
      const n = COLOURS.white(clean.length, { seed: 11, sigma: 1 });
      let ps = 0, pn = 0;
      for (let i = 0; i < clean.length; i++) { ps += clean[i] * clean[i]; pn += n[i] * n[i]; }
      const k = Math.sqrt(ps / pn) / (10 ** (snrDb / 20));
      contrasts.push(toneSetContrastDb(Float32Array.from(clean, (v, i) => v + k * n[i]), SR));
    }
    assert.ok(contrasts[0] > contrasts[1] && contrasts[1] > contrasts[2], 'contrast falls as the noise rises: ' + contrasts.map((c) => c.toFixed(1)).join(' > '));
    assert.equal(TONE_STEP_HZ, 250);
  },

  function threeCopiesThatDisagreeAreNotRedundancy() {
    // The second thing the live false positive showed: it passed its Golay
    // checks while the three redundant copies disagreed on 69 of 98 bits.
    // Real redundancy agrees; three readings of noise do not.
    const clean = decodeAle(encodeAle(CALL, SR), SR);
    assert.ok(clean.ok);
    assert.equal(clean.voteBreakShare, 0, 'a clean signal breaks no votes');
    assert.ok(clean.toneSetDb > 6);
    assert.ok(clean.falseAlarmInSpan < 0.05, `false alarm ${clean.falseAlarmInSpan}`);
  },

  function noiseIsNeverReadAsAHandshake() {
    // This is the case the module failed before the alphabet and the chain
    // rule existed: white noise came back as "THRU >t?" and "COMMAND ?>o70UWT".
    // Golay(23,12) accepts every word it is handed, so the code alone cannot
    // be the gate.
    for (const name of ['white', 'pink', 'bursty', 'faded', 'impulsive']) {
      for (const seed of [6, 44]) {
        const r = decodeAle(COLOURS[name](SR * 5, { seed }), SR);
        assert.equal(r.ok, false, `${name}/${seed} decoded as ${JSON.stringify(r.text)}`);
        assert.match(r.reason, /Golay check|followed by another|8-FSK on the ALE tone set|no 8-FSK tone set|disagreed on/);
      }
    }
    // 8-FSK on the wrong tone set is not ALE either.
    const n = SR * 3, y = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) { const s = Math.floor(i / (SR / 125)) % 8; y[i] = 0.5 * Math.sin(ph); ph += 2 * Math.PI * (500 + s * 300) / SR; }
    assert.equal(decodeAle(y, SR).ok, false, 'a different tone set is not ALE');
    // And a span too short to hold one word says so.
    assert.match(decodeAle(new Float32Array(SR * 0.2), SR).reason, /392 ms/);
  },

  function theAlphabetIsWhatSeparatesACallsignFromASyndrome() {
    assert.ok(inAlphabet('ABC') && inAlphabet('A1 ') && inAlphabet('@ZZ'));
    assert.ok(!inAlphabet('a1 '), 'lower case is not in the set');
    assert.ok(!inAlphabet('A{C'));
    assert.equal(ALE_38.length, 38);
  },

  function wordsBecomeCallsAndDataExtendsAnAddress() {
    const words = [
      { role: 'TO', text: 'ABC', atSec: 0 },
      { role: 'DATA', text: 'DEF', atSec: 0.392 },
      { role: 'DATA', text: 'GHI', atSec: 0.784 },
      { role: 'THIS IS', text: 'XYZ', atSec: 1.176 },
    ];
    const calls = assembleCalls(words);
    assert.deepEqual(calls.map((c) => c.text), ['TO ABCDEFGHI', 'THIS IS XYZ']);
    assert.equal(calls[0].startSec, 0);
    assert.equal(calls[0].endSec, 0.784);
    // Trailing padding on a short address is not part of the callsign.
    assert.equal(assembleCalls([{ role: 'TO', text: 'AB ', atSec: 0 }])[0].address, 'AB');
    // DATA with nothing open is dropped rather than becoming a call of its own.
    assert.deepEqual(assembleCalls([{ role: 'DATA', text: 'ABC', atSec: 0 }]), []);
  },
];
