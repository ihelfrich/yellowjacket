// The WWV/WWVH time code: a recording that says when it was made. Pinned on
// rendered frames; the three shelf recordings it was built against are in the
// comments and the lab note, not in the suite, because they are not in the
// repository.
import assert from 'node:assert/strict';

import {
  decodeTimeCode, encodeTimeCode, decodeMinute, calendar, secondsGrid, symbolFor,
  MARKER_SECONDS, FIXED_ZERO_SECONDS,
} from '../js/sigint/decode/timecode.js';
import { COLOURS } from './noise-colours.mjs';

export const NAME = 'sigint: WWV time code';

const SR = 8000;
const WWV1991 = { hour: 2, minute: 18, dayOfYear: 341, year2: 91, dut1: -0.1 };

export const cases = [
  function threeMinutesReadBackAsTheTimeTheyEncode() {
    const x = encodeTimeCode({ ...WWV1991, minutes: 3, sampleRate: SR, noiseSigma: 0.02, lead: 5 });
    const r = decodeTimeCode(x, SR);
    assert.ok(r.ok, r.reason);
    assert.equal(r.utc, '02:18');
    assert.equal(r.dayOfYear, 341);
    assert.equal(r.year2, 91);
    assert.equal(r.date.iso, '1991-12-07');
    assert.equal(r.dut1, -0.1);
    assert.equal(r.fitted, 3);
    assert.deepEqual(r.outliers, []);
    assert.match(r.text, /^1991-12-07 · 02:18 UTC at 5\.0 s/);
    for (const m of r.minutes) { assert.equal(m.markersOk, 6); assert.equal(m.fixedZerosOk, m.fixedZerosKnown); assert.equal(m.known, 59); }
  },

  function theMinutesRunAcrossTheHour() {
    const x = encodeTimeCode({ hour: 23, minute: 58, dayOfYear: 365, year2: 19, minutes: 4, sampleRate: SR });
    const r = decodeTimeCode(x, SR);
    assert.ok(r.ok, r.reason);
    assert.equal(r.utc, '23:58');
    assert.deepEqual(r.minutes.map((m) => m.utc), ['23:58', '23:59', '00:00', '00:01']);
    assert.equal(r.fitted, 4);
  },

  function aRecordingWhoseClockRunsLongStillReads() {
    // The shelf's WWVH capture from 2015 has seconds of 1011 ms — its sample
    // clock, not the station's. On a grid assumed to be exactly one second
    // only 31% of its pulses landed and it was refused.
    const x = encodeTimeCode({ hour: 4, minute: 58, dayOfYear: 75, year2: 15, dut1: -0.5, minutes: 3, sampleRate: SR, periodSec: 1.011 });
    const r = decodeTimeCode(x, SR);
    assert.ok(r.ok, r.reason);
    assert.equal(r.utc, '04:58');
    assert.equal(r.date.iso, '2015-03-16');
    assert.equal(r.dut1, -0.5);
    assert.ok(Math.abs(r.grid.periodSec - 1.011) < 0.0005, `period ${r.grid.periodSec}`);
    assert.ok(r.grid.clockErrorPpm > 10000 && r.grid.clockErrorPpm < 12000, `ppm ${r.grid.clockErrorPpm}`);
    assert.match(r.text, /its clock is 1\.1% off, not the station's/);
    // And a clock that is right is not accused of anything.
    const good = decodeTimeCode(encodeTimeCode({ ...WWV1991, minutes: 2, sampleRate: SR }), SR);
    assert.doesNotMatch(good.text, /clock is/);
  },

  function aMinuteWithABitErrorIsAnOutlierNotTheAnswer() {
    // Two minutes; the first has its hours-tens pulse dropped, so it reads
    // 04:50 instead of 14:50. On the shelf's 2019 capture exactly that
    // happened, and taking the first clean minute believed 04:50. The fit
    // across minutes does not.
    const x = encodeTimeCode({ hour: 14, minute: 50, dayOfYear: 37, year2: 19, minutes: 3, sampleRate: SR, drop: [25] });
    const r = decodeTimeCode(x, SR);
    assert.ok(r.ok, r.reason);
    assert.equal(r.minutes[0].utc, '04:50', 'the damaged minute reads wrong on its own');
    assert.equal(r.utc, '14:50', 'the fitted start is right');
    assert.deepEqual(r.outliers, [{ index: 0, read: '04:50', expected: '14:50' }]);
    assert.equal(r.fitted, 2);
    assert.match(r.text, /2 of 3 minutes fit one running clock, 1 carry bit errors/);
  },

  function twoStationsThirteenMillisecondsApartStillRead() {
    // WWV and WWVH on one channel: the second copy 13 ms later and 13 dB down,
    // which is the shelf's 5 MHz capture. The envelope is the sum and the
    // widths smear by the delay, which is far inside a class.
    const x = encodeTimeCode({ hour: 14, minute: 50, dayOfYear: 37, year2: 19, minutes: 2, sampleRate: SR, secondStation: { delaySec: 0.013, dbDown: 13 } });
    const r = decodeTimeCode(x, SR);
    assert.ok(r.ok, r.reason);
    assert.equal(r.utc, '14:50');
    assert.equal(r.fitted, 2);
  },

  function droppedPulsesAreReportedNotInvented() {
    const x = encodeTimeCode({ ...WWV1991, minutes: 2, sampleRate: SR, drop: [42, 44, 61 + 8] });
    const r = decodeTimeCode(x, SR);
    assert.ok(r.ok, r.reason);
    assert.equal(r.minutes[0].known, 57);
    assert.equal(r.minutes[1].known, 58);
    assert.equal(r.utc, '02:18', 'dropped fixed zeros change nothing that was read');
  },

  function noiseAndASteadyToneAreRefusedByName() {
    for (const name of ['white', 'pink', 'bursty']) {
      const r = decodeTimeCode(COLOURS[name](SR * 70, { seed: 5 }), SR);
      assert.equal(r.ok, false, `${name} read as ${r.text}`);
      assert.match(r.reason, /subcarrier|grid|frame|minute/, `${name}: ${r.reason}`);
    }
    // A steady 100 Hz tone is the subcarrier with nothing keyed on it.
    const n = SR * 70, x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 100 * i / SR);
    const steady = decodeTimeCode(x, SR);
    assert.equal(steady.ok, false);
    assert.match(steady.reason, /no keyed 100 Hz subcarrier/);
    // Under a minute cannot frame.
    const short = decodeTimeCode(encodeTimeCode({ ...WWV1991, minutes: 1, sampleRate: SR }).subarray(0, SR * 50), SR);
    assert.equal(short.ok, false);
    assert.match(short.reason, /full minute/);
  },

  function theCalendarKnowsItsWindowAndLeapYears() {
    assert.equal(calendar(91, 341).iso, '1991-12-07');
    assert.equal(calendar(19, 37).iso, '2019-02-06');
    assert.equal(calendar(15, 75).iso, '2015-03-16');
    assert.equal(calendar(0, 366).iso, '2000-12-31', '2000 is a leap year');
    assert.equal(calendar(1, 366), null, '2001 is not');
    assert.equal(calendar(70, 1).iso, '1970-01-01', 'the window starts at 1970');
    assert.equal(calendar(69, 1).iso, '2069-01-01', 'and wraps below it');
    assert.equal(calendar(91, 0), null);
  },

  function aMinuteDecodesFromItsSymbolsAlone() {
    // The layout, by hand: 14:50, day 37, year 19, DUT1 -0.1.
    const sec = new Map();
    for (let s = 1; s < 60; s++) sec.set(s, '0');
    for (const s of MARKER_SECONDS) sec.set(s, 'P');
    sec.set(15, '1'); sec.set(17, '1');          // minutes tens 10 + 40
    sec.set(22, '1'); sec.set(25, '1');          // hours 4 + 10
    sec.set(30, '1'); sec.set(31, '1'); sec.set(32, '1'); sec.set(35, '1'); sec.set(36, '1');   // day 7 + 30
    sec.set(51, '1'); sec.set(4, '1'); sec.set(7, '1');   // year tens 1, units 1 + 8
    sec.set(56, '1');                             // DUT1 0.1, sign bit 0 = negative
    const m = decodeMinute(sec);
    assert.equal(m.utc, '14:50');
    assert.equal(m.dayOfYear, 37);
    assert.equal(m.year2, 19);
    assert.equal(m.dut1, -0.1);
    assert.equal(m.markersOk, 6);
    assert.equal(m.fixedZerosOk, FIXED_ZERO_SECONDS.length);
    assert.equal(m.plausible, true);
    assert.equal(m.hole, true);
  },

  function widthsClassifyAgainstTheStandardWithTheWindowRemoved() {
    const w = 0.04;
    assert.equal(symbolFor(0.170 + w, w), '0');
    assert.equal(symbolFor(0.470 + w, w), '1');
    assert.equal(symbolFor(0.770 + w, w), 'P');
    // Right on the boundary it goes to the longer class: a marker read a
    // little short is still a marker more often than a one read long.
    assert.equal(symbolFor(0.61 + w, w), '1');
    assert.equal(symbolFor(0.63 + w, w), 'P');
  },

  function theGridIsMeasuredNotAssumed() {
    const runs = [];
    for (let k = 0; k < 40; k++) runs.push({ start: 0.3 + k * 1.002, sec: 0.2 });
    const g = secondsGrid(runs);
    assert.ok(g.ok);
    assert.ok(Math.abs(g.periodSec - 1.002) < 1e-4, `period ${g.periodSec}`);
    assert.ok(Math.abs(g.phase - 0.3) < 0.01, `phase ${g.phase}`);
    assert.equal(g.clockErrorPpm, 2000);
    // Pulses at random times are not a grid.
    let seed = 3; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const noise = []; for (let k = 0; k < 40; k++) noise.push({ start: rnd() * 40, sec: 0.2 });
    noise.sort((a, b) => a.start - b.start);
    assert.equal(secondsGrid(noise).ok, false);
  },
];
