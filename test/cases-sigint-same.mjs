// SAME: the Emergency Alert System header, from the tones up. The arithmetic
// is pinned on synthesized transmissions; the shelf's NOAA test recording is
// what the decoder was built against and what the numbers in the comments
// come from.
import assert from 'node:assert/strict';

import {
  decodeSame, encodeSame, parseHeader, voteHeaders, activeRegions, softBits, UNKNOWN,
  BAUD, MARK_HZ, SPACE_HZ,
} from '../js/sigint/decode/same.js';
import { COLOURS } from './noise-colours.mjs';

export const NAME = 'sigint: SAME alert headers';

const HEADER = 'ZCZC-WXR-RWT-029095-029183+0030-2551200-KDMX/NWS-';

export const cases = [
  function theConstantsAreTheStandardsOwnRatios() {
    // Everything in SAME derives from 25 kHz: 25000/48 baud, 25000/12 mark,
    // 25000/16 space. A mistyped constant would decode nothing real.
    assert.ok(Math.abs(BAUD - 25000 / 48) < 1e-9);
    assert.ok(Math.abs(MARK_HZ - 25000 / 12) < 1e-9);
    assert.ok(Math.abs(SPACE_HZ - 25000 / 16) < 1e-9);
  },

  function aRenderedHeaderRoundTripsAtSeveralRates() {
    for (const rate of [8000, 11025, 22050, 44100, 48000]) {
      const x = encodeSame(HEADER, rate, { repeats: 3 });
      const r = decodeSame(x, rate);
      assert.ok(r.ok, `${rate} Hz: ${r.reason}`);
      assert.equal(r.text, HEADER, `${rate} Hz`);
      assert.equal(r.copies, 3);
      assert.equal(r.agreed, 3);
      assert.equal(r.at.headers.length, 3);
    }
  },

  function theFieldsReadOutInWords() {
    const h = parseHeader(HEADER);
    assert.equal(h.originator, 'WXR');
    assert.match(h.originatorText, /National Weather Service/);
    assert.equal(h.eventText, 'Required Weekly Test');
    assert.deepEqual(h.locations.map((l) => l.text), ['county 095 of Missouri', 'county 183 of Missouri']);
    assert.equal(h.purge.text, '30 min');
    assert.equal(h.issued.text, 'day 255 at 12:00 UTC');
    assert.equal(h.sender, 'KDMX/NWS');
    assert.equal(parseHeader('ZCZC-WXR-RWT-029095'), null, 'a truncated header does not parse');
    assert.equal(parseHeader('hello'), null);
    const whole = parseHeader('ZCZC-PEP-EAN-000000+0000-0011200-WHITEHSE-');
    assert.equal(whole.locations[0].text, 'all of the whole United States');
    assert.equal(whole.eventText, 'Emergency Action Notification');
    assert.equal(whole.purge.text, '0 min');
  },

  function threeCopiesOutvoteABitError() {
    // Each copy carries a different single-character error; the vote returns
    // the header none of them had. The originals are what the shelf produced.
    const a = 'ZCZC-WXR-BWT-029095-029183+0030-2551200-KDMX/NWS-';
    const b = 'ZCZC-WXR-RWT-029095-029183+0030-2551200-KDMX/NWS-';
    const c = 'ZCZC-WXR-RWT-029095-0%9183+0030-2551200-KDMX/NWS-';
    const v = voteHeaders([a, b, c]);
    assert.equal(v.text, HEADER);
    assert.deepEqual(v.disputed, [9, 21]);
    assert.equal(v.agreed, 1);
  },

  function aTruncatedCopyStillVotesWhereItReaches() {
    // A run of bit errors ends a copy early. It votes on what it has and the
    // rest comes from the copies that got further.
    const v = voteHeaders([HEADER.slice(0, 20), HEADER, HEADER.replace('KDMX', 'KDMY')]);
    assert.equal(v.text, HEADER);
    assert.ok(v.thin.length > 0, 'positions past the short copy are thin');
  },

  function theGrammarRefusesASymbolWhereADigitMustBe() {
    // Two copies, tied at a location digit: '%' against '5'. Weight alone is a
    // coin toss; the grammar says a location block is six digits.
    const bad = HEADER.replace('029095', '02%095');
    const v = voteHeaders([{ text: bad, conf: bad.split('').map(() => 9) }, { text: HEADER, conf: HEADER.split('').map(() => 1) }]);
    assert.equal(v.text, HEADER, 'the low-confidence digit beats the high-confidence symbol');
  },

  function theVocabularyBreaksALetterTie() {
    // Position 11 read P, T and U on the shelf recording. All letters, so the
    // grammar cannot help; only RWT is an event code.
    const v = voteHeaders([
      { text: HEADER.replace('RWT', 'RWP'), conf: HEADER.split('').map(() => 5) },
      { text: HEADER, conf: HEADER.split('').map(() => 1) },
      { text: HEADER.replace('RWT', 'RWU'), conf: HEADER.split('').map(() => 1) },
    ]);
    assert.equal(v.text, HEADER);
    assert.deepEqual(v.repaired, [11]);
    // But it never invents: a code no copy read is not produced.
    const none = voteHeaders([HEADER.replace('RWT', 'RWP'), HEADER.replace('RWT', 'RWQ')]);
    assert.notEqual(none.text, HEADER);
    assert.deepEqual(none.repaired, []);
  },

  function aPlaceholderNeverWinsAVote() {
    const v = voteHeaders([{ text: 'ZCZC-WXR-RWT-' + UNKNOWN + '29095-029183+0030-2551200-KDMX/NWS-', conf: null }, HEADER]);
    assert.equal(v.text, HEADER);
    assert.equal(v.unknown, 0);
  },

  function burstsAreFoundInsideALongerRecording() {
    // A minute of hiss with three header copies in the first ten seconds. The
    // bit clock has to be measured inside the bursts: measured over the whole
    // span on the shelf recording it concentrated at 0.008, which is noise.
    const rate = 22050;
    const bursts = encodeSame(HEADER, rate, { repeats: 3, amplitude: 0.4 });
    const x = COLOURS.white(rate * 60, { sigma: 0.02, seed: 4 });
    x.set(bursts, rate * 2);
    const { power } = softBits(x, rate);
    const regions = activeRegions(power, rate);
    assert.ok(regions.length >= 3 && regions.length <= 4, `expected the three bursts, found ${regions.length}`);
    const r = decodeSame(x, rate);
    assert.ok(r.ok, r.reason);
    assert.equal(r.text, HEADER);
    assert.ok(r.at.headers[0] > 1.5 && r.at.headers[0] < 2.5, `first copy at ${r.at.headers[0]} s`);
  },

  function aContinuousToneSpanIsOneRegion() {
    const rate = 22050;
    const x = encodeSame(HEADER, rate, { repeats: 1, gapSec: 0 });
    const { power } = softBits(x, rate);
    assert.equal(activeRegions(power, rate).length, 1);
  },

  function noiseAndVoiceShapedNoiseAreRefusedByName() {
    for (const [name, secs] of [['white', 6], ['pink', 6], ['bursty', 6], ['faded', 6], ['impulsive', 6]]) {
      const r = decodeSame(COLOURS[name](22050 * secs, { seed: 11 }), 22050);
      assert.equal(r.ok, false, `${name} decoded as ${JSON.stringify(r.text)}`);
      assert.match(r.reason, /bit clock|preamble|ZCZC/, `${name}: ${r.reason}`);
    }
    // A two-tone signal at the right frequencies but the wrong baud is not SAME.
    const rate = 22050, n = rate * 4, x = new Float32Array(n);
    for (let i = 0; i < n; i++) { const bit = Math.floor(i / (rate / 300)) % 2; x[i] = 0.5 * Math.sin(2 * Math.PI * (bit ? MARK_HZ : SPACE_HZ) * i / rate); }
    const wrong = decodeSame(x, rate);
    assert.equal(wrong.ok, false, 'a 300 baud two-tone signal is not SAME');
  },

  function theEndOfMessageIsCountedSeparately() {
    const rate = 22050;
    const head = encodeSame(HEADER, rate, { repeats: 3 });
    const eom = encodeSame('NNNN', rate, { repeats: 3 });
    const x = new Float32Array(head.length + rate * 3 + eom.length);
    x.set(head, 0); x.set(eom, head.length + rate * 3);
    const r = decodeSame(x, rate);
    assert.ok(r.ok, r.reason);
    assert.equal(r.endOfMessage, 3);
    assert.equal(r.at.eom.length, 3);
    assert.ok(r.at.eom[0] > r.at.headers[2]);
  },
];
