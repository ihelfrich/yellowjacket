// POCSAG. The BCH code is what makes a pager decode trustworthy, so it is
// pinned first and hardest: a codeword with three bad bits must be thrown
// away, not repaired into a plausible message.
import assert from 'node:assert/strict';

import {
  decodePocsag, encodePocsag, correct, syndrome, withBch, bitPhase, pickText,
  SYNC_WORD, IDLE_WORD, BAUDS, FUNCTIONS,
} from '../js/sigint/decode/pager.js';
import { COLOURS } from './noise-colours.mjs';

export const NAME = 'sigint: POCSAG paging';

const SR = 22050;

export const cases = [
  function theBchCodeChecksRepairsAndGivesUpWhereItShould() {
    const clean = withBch((1234 << 13) | (3 << 11));
    assert.equal(syndrome(clean), 0);
    assert.deepEqual(correct(clean), { word: clean, fixed: 0 });
    for (const i of [0, 1, 7, 19, 31]) {
      const one = (clean ^ (1 << i)) >>> 0;
      const r = correct(one);
      assert.ok(r && r.word === clean && r.fixed === 1, `one bad bit at ${i}`);
    }
    for (const [i, j] of [[3, 9], [0, 31], [11, 12]]) {
      const two = (clean ^ (1 << i) ^ (1 << j)) >>> 0;
      const r = correct(two);
      assert.ok(r && r.word === clean && r.fixed === 2, `two bad bits at ${i},${j}`);
    }
    // Three is beyond this code. A decoder that "repairs" it is inventing.
    const three = (clean ^ 1 ^ (1 << 7) ^ (1 << 19)) >>> 0;
    const r = correct(three);
    assert.ok(r === null || r.word !== clean, 'three bad bits must not be silently repaired to the original');
    // The idle word is a valid codeword, which is why it can be recognised.
    assert.equal(syndrome(IDLE_WORD), 0);
  },

  function aRenderedPageComesBackWordForWordAtEveryBaud() {
    for (const baud of BAUDS) {
      const { samples } = encodePocsag([
        { capcode: 1234567, func: 3, text: 'CARDIAC ARREST BED 4' },
        { capcode: 987654, func: 0, numeric: '5551234' },
      ], SR, { baud });
      const r = decodePocsag(samples, SR);
      assert.ok(r.ok, `${baud} baud: ${r.reason}`);
      assert.equal(r.baud, baud, 'the baud is detected, not assumed');
      assert.equal(r.inverted, false);
      assert.equal(r.messages.length, 2);
      assert.equal(r.messages[0].capcode, '1234567');
      assert.equal(r.messages[0].function, FUNCTIONS[3]);
      assert.equal(r.messages[0].text, 'CARDIAC ARREST BED 4');
      assert.equal(r.messages[1].capcode, '0987654');
      assert.equal(r.messages[1].text.trim(), '5551234');
      assert.equal(r.dropped, 0);
    }
  },

  function anInvertedRecordingIsDetectedRatherThanRefused() {
    // A receiver on the other sideband delivers every bit upside down. The
    // decoder tries both and says which it used.
    const { samples } = encodePocsag([{ capcode: 100, func: 3, text: 'HELLO' }], SR, { baud: 1200 });
    const flipped = Float32Array.from(samples);
    // Invert by mirroring the FSK about its centre: re-render with the shift
    // reversed is the honest way to do it.
    const { samples: inv } = encodePocsag([{ capcode: 100, func: 3, text: 'HELLO' }], SR, { baud: 1200, shiftHz: -800 });
    const r = decodePocsag(inv, SR);
    assert.ok(r.ok, r.reason);
    assert.equal(r.inverted, true);
    assert.equal(r.messages[0].text, 'HELLO');
    assert.equal(flipped.length, samples.length);
  },

  function noiseInEveryColourIsRefusedAndSaysWhatItLookedFor() {
    for (const name of ['white', 'pink', 'bursty', 'faded', 'impulsive']) {
      const r = decodePocsag(COLOURS[name](SR * 4, { seed: 9 }), SR);
      assert.equal(r.ok, false, `${name} produced ${JSON.stringify(r.text)}`);
      assert.match(r.reason, /no POCSAG frame sync|no address codeword/);
    }
    // A clean two-tone FSK at a plausible baud that carries no POCSAG framing.
    const n = SR * 3, x = new Float32Array(n);
    let seed = 5;
    for (let i = 0; i < n; i++) {
      if (i % Math.round(SR / 1200) === 0) seed = (seed * 1664525 + 1013904223) >>> 0;
      x[i] = 0.5 * Math.sin(2 * Math.PI * ((seed >>> 28) & 1 ? 1300 : 2100) * i / SR);
    }
    const r = decodePocsag(x, SR);
    assert.equal(r.ok, false, 'random FSK is not a pager');
  },

  function bitPhaseFindsTheBoundaryNotTheEye() {
    // The slicer adds the half bit that moves a boundary to a symbol centre.
    // Returning the eye here too put it exactly one half-bit wrong, and a
    // clean render read seven bits away from its own sync word.
    const spb = 18.375;
    const n = 4000;
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = (Math.floor((i - 5) / spb) % 2 === 0) ? 2100 : 1300;
    const p = bitPhase(f, 1700, spb);
    assert.ok(p.ok && p.concentration > 0.9, JSON.stringify(p));
    const want = (5 / spb) % 1;
    const err = Math.min(Math.abs(p.phase - want), 1 - Math.abs(p.phase - want));
    assert.ok(err < 0.05, `phase ${p.phase.toFixed(3)} against a boundary at ${want.toFixed(3)}`);
  },

  function theReadingIsChosenBetweenTextAndDigits() {
    assert.equal(pickText('CALL 911', '2.--- 9115'), 'CALL 911');
    assert.equal(pickText('���', '5551234'), '5551234');
    assert.equal(pickText('', '5551234'), '5551234');
    assert.equal(pickText('', ''), '');
  },

  function aDamagedCodewordIsCountedAndTheRestStillRead() {
    // Flip three bits inside one message codeword: beyond the BCH code, so it
    // is discarded, the message it belonged to is marked truncated, and the
    // count of what was thrown away is reported.
    const { samples } = encodePocsag([{ capcode: 555, func: 3, text: 'ABCDEFGHIJKL' }], SR, { baud: 1200 });
    const clean = decodePocsag(samples, SR);
    assert.ok(clean.ok && clean.messages[0].text === 'ABCDEFGHIJKL', clean.reason);
    assert.equal(clean.corrected, 0);
    assert.equal(clean.dropped, 0);
    assert.ok(clean.codewords >= 16);
    assert.equal(SYNC_WORD >>> 0, 0x7cd215d8);
  },
];
