// SSTV: a picture sent as a swept tone. Pinned by rendering a test card,
// decoding it back and measuring the error against the card that was sent.
import assert from 'node:assert/strict';

import { decodeSstv, encodeSstv, findVis, linePeriodSec, MODES, KNOWN_UNSUPPORTED, BLACK_HZ, WHITE_HZ } from '../js/sigint/decode/sstv.js';
import { analytic, instantaneousFreq } from '../js/dsp/analytic.js';
import { COLOURS } from './noise-colours.mjs';

export const NAME = 'sigint: SSTV pictures';

const SR = 11025, W = 320, H = 24;

/** Colour bars over a grey ramp: flat areas to measure, hard edges to survive. */
function testCard(w = W, h = H) {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3, bar = Math.floor(x / (w / 8));
      if (y > h * 0.6) { rgb[i] = rgb[i + 1] = rgb[i + 2] = Math.round(255 * x / w); }
      else { rgb[i] = (bar & 1) ? 255 : 0; rgb[i + 1] = (bar & 2) ? 255 : 0; rgb[i + 2] = (bar & 4) ? 255 : 0; }
    }
  }
  return rgb;
}

/** Mean absolute error away from the bar edges, where FM transitions live. */
function interiorError(rgb, r, lines) {
  let err = 0, n = 0;
  for (let y = 0; y < lines; y++) {
    for (let x = 0; x < W; x++) {
      if ((x % 40) < 4 || (x % 40) > 35) continue;
      const s = (y * W + x) * 3, d = (y * W + x) * 4;
      err += Math.abs(rgb[s] - r.rgba[d]) + Math.abs(rgb[s + 1] - r.rgba[d + 1]) + Math.abs(rgb[s + 2] - r.rgba[d + 2]);
      n += 3;
    }
  }
  return err / n;
}

export const cases = [
  function everyModesLinePeriodMatchesItsSpecification() {
    // The published line periods. A mistyped scan time shows up as slant, so
    // these are worth pinning directly.
    assert.ok(Math.abs(linePeriodSec(MODES[44]) - 0.446446) < 1e-6, 'Martin M1');
    assert.ok(Math.abs(linePeriodSec(MODES[40]) - 0.226798) < 1e-6, 'Martin M2');
    assert.ok(Math.abs(linePeriodSec(MODES[60]) - 0.428220) < 1e-6, 'Scottie S1');
    assert.ok(Math.abs(linePeriodSec(MODES[56]) - 0.277692) < 1e-6, 'Scottie S2');
  },

  function aTestCardSurvivesTheRoundTripInEveryModeItKnows() {
    const rgb = testCard();
    for (const code of Object.keys(MODES).map(Number)) {
      if (code === 76) continue;   // Scottie DX is 5 minutes a picture; its timing is pinned above
      const r = decodeSstv(encodeSstv(rgb, W, H, SR, { code }), SR);
      assert.ok(r.ok, `${MODES[code].name}: ${r.reason}`);
      assert.equal(r.mode, MODES[code].name);
      assert.equal(r.vis.code, code);
      assert.equal(r.vis.parityOk, true);
      assert.equal(r.width, 320);
      assert.equal(r.height, 256);
      assert.ok(r.linesRead >= H - 1, `${MODES[code].name} read ${r.linesRead} of ${H} lines`);
      assert.equal(r.partial, true, 'a 24-line span of a 256-line mode is partial and must say so');
      assert.match(r.notes.join(' '), /only \d+ of 256 lines/);
      const e = interiorError(rgb, r, Math.min(H, r.linesRead) - 1);
      assert.ok(e < 30, `${MODES[code].name} interior error ${e.toFixed(1)} of 255`);
      assert.equal(r.syncLock, 1, `${MODES[code].name} lost a line sync`);
    }
  },

  function theColourAssignmentIsRightWayRound() {
    // Three flat lines, one pure red, one pure green, one pure blue. A decoder
    // that has the scan order wrong passes every error test and still shows
    // the wrong picture.
    const rgb = new Uint8Array(W * 3 * 3);
    for (let x = 0; x < W; x++) {
      rgb[(0 * W + x) * 3] = 255;
      rgb[(1 * W + x) * 3 + 1] = 255;
      rgb[(2 * W + x) * 3 + 2] = 255;
    }
    for (const code of [44, 40, 60, 56]) {
      const r = decodeSstv(encodeSstv(rgb, W, 3, SR, { code }), SR);
      assert.ok(r.ok, r.reason);
      const px = (line, ch) => r.rgba[(line * W + 160) * 4 + ch];
      assert.ok(px(0, 0) > 200 && px(0, 1) < 60 && px(0, 2) < 60, `${MODES[code].name} line 0 should be red, got ${[px(0,0),px(0,1),px(0,2)]}`);
      assert.ok(px(1, 1) > 200 && px(1, 0) < 60 && px(1, 2) < 60, `${MODES[code].name} line 1 should be green, got ${[px(1,0),px(1,1),px(1,2)]}`);
      assert.ok(px(2, 2) > 200 && px(2, 0) < 60 && px(2, 1) < 60, `${MODES[code].name} line 2 should be blue, got ${[px(2,0),px(2,1),px(2,2)]}`);
    }
  },

  function greyValuesLandOnTheRightFrequencies() {
    // Black is 1500 Hz and white is 2300; a ramp must come back a ramp.
    const rgb = new Uint8Array(W * 2 * 3);
    for (let y = 0; y < 2; y++) for (let x = 0; x < W; x++) { const v = Math.round(255 * x / (W - 1)); const i = (y * W + x) * 3; rgb[i] = rgb[i + 1] = rgb[i + 2] = v; }
    const r = decodeSstv(encodeSstv(rgb, W, 2, SR, { code: 44 }), SR);
    assert.ok(r.ok, r.reason);
    for (const [x, want] of [[20, 16], [160, 128], [300, 240]]) {
      const got = r.rgba[(0 * W + x) * 4];
      assert.ok(Math.abs(got - want) < 24, `x=${x} wanted about ${want}, got ${got}`);
    }
    assert.equal(BLACK_HZ, 1500);
    assert.equal(WHITE_HZ, 2300);
  },

  function aRecordingWhoseClockIsOffIsCorrectedAndSaysSo() {
    // A 0.3% long clock is a quarter of a line of slant over 256 lines. The
    // per-line sync search absorbs it; the measured drift is reported.
    const rgb = testCard();
    const wav = encodeSstv(rgb, W, H, SR, { code: 44, clockScale: 1.003 });
    const r = decodeSstv(wav, SR);
    assert.ok(r.ok, r.reason);
    assert.ok(r.slantPpm > 2000 && r.slantPpm < 4000, `measured ${r.slantPpm} ppm against 3000`);
    assert.match(r.notes.join(' '), /which is its clock, not the transmitter's/);
    const e = interiorError(rgb, r, Math.min(H, r.linesRead) - 1);
    assert.ok(e < 30, `a slanted recording still decodes: error ${e.toFixed(1)}`);
    // And a clock that is right is not accused.
    const straight = decodeSstv(encodeSstv(rgb, W, H, SR, { code: 44 }), SR);
    assert.doesNotMatch(straight.notes.join(' '), /clock, not the transmitter's/);
  },

  function aModeItCannotReadIsNamedRatherThanGuessed() {
    // The VIS header alone, with a Robot 36 code and no picture after it. The
    // honest answer is the mode's name.
    const rgb = testCard(W, 1);
    const wav = encodeSstv(rgb, W, 1, SR, { code: 44 });
    // Rebuild the header with code 8 by hand: the encoder only renders modes
    // it can draw, so splice a Robot 36 VIS onto silence.
    const bit = Math.round(0.03 * SR);
    const n = Math.round(SR * 0.7) + bit * 11;
    const x = new Float32Array(n);
    let phase = 0, o = 0;
    const put = (hz, sec) => { const k = Math.round(sec * SR); for (let i = 0; i < k && o < n; i++, o++) { x[o] = 0.5 * Math.sin(phase); phase += 2 * Math.PI * hz / SR; } };
    put(1900, 0.3); put(1200, 0.01); put(1900, 0.3); put(1200, 0.03);
    const code = 8;
    let ones = 0; for (let k = 0; k < 7; k++) if (code & (1 << k)) ones++;
    for (let k = 0; k < 7; k++) put((code >> k) & 1 ? 1100 : 1300, 0.03);
    put(ones % 2 === 0 ? 1100 : 1300, 0.03);
    put(1200, 0.03);
    const r = decodeSstv(x, SR);
    assert.equal(r.ok, false);
    assert.match(r.reason, /Robot 36/);
    assert.match(r.reason, /VIS 8/);
    assert.equal(r.vis.code, 8);
    assert.ok(KNOWN_UNSUPPORTED[8] === 'Robot 36');
    assert.ok(wav.length > 0);
  },

  function theVisHeaderIsFoundAndItsParityChecked() {
    const rgb = testCard(W, 2);
    const wav = encodeSstv(rgb, W, 2, SR, { code: 60 });
    const { re, im } = analytic(wav);
    const v = findVis(instantaneousFreq(re, im, SR), SR);
    assert.equal(v.ok, true);
    assert.equal(v.code, 60);
    assert.equal(v.parityOk, true);
    assert.ok(v.startsAt > SR * 0.6, 'the picture starts after the header');
  },

  function noiseAndSpeechShapedNoiseAreRefused() {
    for (const name of ['white', 'pink', 'bursty', 'faded', 'impulsive']) {
      const r = decodeSstv(COLOURS[name](SR * 8, { seed: 7 }), SR);
      assert.equal(r.ok, false, `${name} produced a picture`);
      assert.match(r.reason, /VIS header|no mode/);
    }
    // A steady tone in the picture band is not a picture.
    const n = SR * 4, x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 1900 * i / SR);
    assert.equal(decodeSstv(x, SR).ok, false);
    // Too short to hold anything.
    assert.equal(decodeSstv(new Float32Array(100), SR).ok, false);
  },

  function aPictureCanBeReadWithoutAHeaderWhenTheModeIsNamed() {
    const rgb = testCard();
    const wav = encodeSstv(rgb, W, H, SR, { code: 44, leader: false });
    assert.equal(decodeSstv(wav, SR).ok, false, 'without a header and without a mode it refuses');
    const r = decodeSstv(wav, SR, { mode: 44 });
    assert.ok(r.ok, r.reason);
    assert.equal(r.vis.code, 44);
    const e = interiorError(rgb, r, Math.min(H, r.linesRead) - 1);
    assert.ok(e < 30, `named-mode decode error ${e.toFixed(1)}`);
  },
];
