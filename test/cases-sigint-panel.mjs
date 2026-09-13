// What the SIGINT panel prints. reportLines is pure, so the thing a person
// actually reads can be pinned without a browser.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { reportLines, quantities, wrap, surveyRows, taskOptions } from '../js/app/sigint-controller.js';
import { measure } from '../js/sigint/measure.js';
import { classifySegment } from '../js/sigint/classify.js';
import { white } from './noise-colours.mjs';

const RATE = 8000;

function keyedTone(seconds = 3, { hz = 1000, ditSec = 0.08, amp = 0.5, noise = 0.01 } = {}) {
  const n = Math.round(seconds * RATE);
  const x = new Float32Array(n);
  const w = white(n, { sigma: noise, seed: 4 });
  for (let i = 0; i < n; i++) {
    const on = Math.floor(i / (RATE * ditSec)) % 2 === 0;
    x[i] = (on ? amp : 0) * Math.cos(2 * Math.PI * hz * i / RATE) + w[i];
  }
  return x;
}

export const NAME = 'sigint panel';

export const cases = [
  function theSurveyRanksKeyedEmissionsFirst() {
    // Evidence rewards area. On M12 a sixteen-second splatter component with a
    // false-alarm exponent of -25189 outranked the 958-1034 Hz Morse channel
    // at -3271; on the Marine Electric recording four second-long bursts
    // outranked the keying. A keyed emission goes first whatever its exponent;
    // among keyed ones, and among continuous ones, evidence still orders.
    const result = {
      present: true,
      emissions: [
        { id: 'splatter', startSec: 1.3, endSec: 16.6, lowHz: 215, highHz: 1314, falseAlarmLog10: -25189, snrDb: 12, cells: 9000, keying: { keyed: false, contrastDb: 3.8, transitions: 87, onFraction: 0.38 } },
        { id: 'morse', startSec: 56.9, endSec: 59.4, lowHz: 958, highHz: 1034, falseAlarmLog10: -3271, snrDb: 14, cells: 300, keying: { keyed: true, contrastDb: 10.4, transitions: 20, onFraction: 0.69 } },
        { id: 'morse2', startSec: 20, endSec: 24, lowHz: 958, highHz: 1034, falseAlarmLog10: -8000, snrDb: 15, cells: 400, keying: { keyed: true, contrastDb: 11, transitions: 30, onFraction: 0.6 } },
        { id: 'hum', startSec: 0, endSec: 120, lowHz: 54, highHz: 118, falseAlarmLog10: -900, snrDb: 9, cells: 5000, keying: { keyed: false, contrastDb: 1, transitions: 2, onFraction: 0.9 } },
        { id: 'codec', startSec: 0, endSec: 120, lowHz: 4000, highHz: 6000, falseAlarmLog10: -99999, aboveContentEdge: true, keying: { keyed: true, contrastDb: 20, transitions: 50, onFraction: 0.5 } },
      ],
    };
    const { rows, setAside } = surveyRows(result);
    assert.deepEqual(rows.map((r) => r.id), ['morse2', 'morse', 'splatter', 'hum'], rows.map((r) => r.id).join(','));
    assert.equal(setAside.codec, 1, 'a codec ridge stays set aside however keyed it is');
    // Without keying fields the old order holds exactly.
    const bare = { present: true, emissions: result.emissions.slice(0, 4).map(({ keying, ...d }) => d) };
    assert.deepEqual(surveyRows(bare).rows.map((r) => r.id), ['splatter', 'morse2', 'morse', 'hum']);
  },

  async function everyMeasurementPrintsItsUnitAndItsUncertainty() {
    const m = measure(keyedTone(), RATE);
    const lines = reportLines({ measured: m }, { methods: false });
    const text = lines.join('\n');
    assert.match(text, /centre\s+1000\.\d+ Hz ± /, 'a centre frequency with a unit and a bar');
    assert.match(text, /SNR\s+\d+\.\d+ dB ± /);
    assert.match(text, /floor\s+-\d+\.\d+ dBFS\/Hz ± /);
    // Nothing may be printed as a bare number: every quantity carries its unit.
    for (const [label, q] of quantities(m)) {
      if (q.value == null) continue;
      assert.ok(q.unit, `${label} has no unit`);
      assert.ok(q.method, `${label} does not say how it was measured`);
    }
  },

  async function aRefusalPrintsItsReasonAndNotAnEmDash() {
    // This tone is one steady frequency, so there is no FSK shift to find. The
    // panel must say why rather than leaving a dash a reader will fill in.
    const m = measure(keyedTone(), RATE);
    const text = reportLines({ measured: m }, { methods: false }).join('\n');
    assert.match(text, /FSK shift\s+not established/);
    assert.match(text, /histogram has only one/, 'and the reason travels with it');
    assert.ok(!/FSK shift\s+—/.test(text), 'a refusal is not an em dash');
  },

  async function theEvidenceIsReadableAndCarriesItsWeight() {
    // A square-keyed tone genuinely IS a pulse train, so the classifier calls
    // that tie unclear and is right to. What is pinned here is the rendering:
    // the ranked hypotheses, and the evidence with the weight that carried it.
    const c = classifySegment(keyedTone(), RATE, null);
    const text = reportLines({ classified: c }, { methods: false }).join('\n');
    assert.match(text, /on-off keyed tone/, 'the ranking is shown, not only the verdict');
    assert.match(text, /for\s+\[\d\] /, 'evidence prints its weight and its claim');
    assert.ok(!/\[object Object\]/.test(text), 'and is not stringified objects');
    assert.match(text, /against\s+\[\d\] /, 'the contradicting evidence is shown too');
    assert.match(text, /verdict\s+\S/, 'and a verdict, even when it is that nothing is clear');
  },

  async function theRegionLineSaysWhereItCameFromAndWhatBand() {
    const banded = reportLines({ region: { from: 12, to: 20.5, lowHz: 900, highHz: 1100, how: 'emission 3' } }).join('\n');
    assert.match(banded, /region\s+: 0:12\.0 to 0:20\.5\s+\(8\.5 s\)\s+· 900–1100 Hz\s+· emission 3/);
    const wide = reportLines({ region: { from: 0, to: 120, how: 'first 120 s' } }).join('\n');
    assert.match(wide, /full band\s+· first 120 s/);
  },

  async function theSpectrogramStaysOnScreenInSigintAndCanBePointedAt() {
    const [html, main, spec] = await Promise.all([
      readFile(new URL('../index.html', import.meta.url), 'utf8'),
      readFile(new URL('../js/main.js', import.meta.url), 'utf8'),
      readFile(new URL('../js/spectrogram.js', import.meta.url), 'utf8'),
    ]);
    const a = html.indexOf('id="tab-signal"'), b = html.indexOf('</section>', a);
    const sec = html.slice(a, b);
    // The first SIGINT layout hid the spectrogram behind a text pane, which
    // contradicted its own reason for living on SIGNAL. Now only a rail swaps.
    assert.equal((sec.match(/data-sigrail="/g) || []).length, 2, 'two rails, one per state');
    assert.ok(!/class="yj-sigstate[" ]/.test(sec), 'no hidden pane wraps the spectrogram');
    assert.ok(sec.includes('id="specMain"') && sec.includes('id="sigintHost"'));
    assert.match(main, /rail\.hidden = rail\.dataset\.sigrail !== b\.dataset\.sigstate/, 'the band toggles rails');
    assert.match(spec, /setDetections\(list, selectedId = null\)/, 'the spectrogram draws a survey');
    assert.match(spec, /new CustomEvent\('detectionselect'/, 'and a click on one selects it');
    assert.match(spec, /_drawDetections\(g, w, h, dpr, c\);\n\s+this\._drawRuler/, 'drawn under the ruler, over the image');
  },

  async function aSurveyIsReadStrongestFirstWithCodecSetAside() {
    // The shape segment() actually returned on the shelf's M08 recording: six
    // full-length encoder ridges at −4 dB starting at 0:00, and the real
    // 30 dB Morse bursts later. Time order put the ridges first.
    const ridge = (lo) => ({ startSec: 0, endSec: 84.9, lowHz: lo, highHz: lo + 100, cells: 900, snrDb: -3.9, falseAlarmLog10: -349, confidence: 1, aboveContentEdge: true });
    // cells and evidence disagree on purpose: the widest burst is not the surest
    const burst = (t, cells, snr, fa) => ({ startSec: t, endSec: t + 3, lowHz: 150, highHz: 2800, cells, snrDb: snr, falseAlarmLog10: fa, confidence: 0.7, aboveContentEdge: false });
    const result = {
      present: true, reason: 'bursts', classifyOn: 'emissions', standingBands: [],
      emissions: [ridge(3499), ridge(4953), burst(45.7, 320, 29.6, -7.0e6), burst(5.4, 410, 29.9, -6.9e6), burst(55.7, 610, 31.2, -1.1e5), burst(2.1, 300, 29.4, -7.6e6)],
      components: [{ startSec: 0, endSec: 1, lowHz: 0, highHz: 1, cells: 99999 }],
    };
    const read = surveyRows(result);
    assert.deepEqual(read.rows.map((r) => r.startSec), [2.1, 45.7, 5.4, 55.7],
      'by evidence, most negative first — the widest burst (most cells) is not the surest, and no ridges');
    assert.deepEqual(read.rows.map((r) => r.k), [1, 2, 3, 4]);
    assert.equal(read.setAside.codec, 2, 'the two ridges are counted, not hidden');
    assert.ok(read.rows.every((r) => !r.aboveContentEdge));
    // classifyOn is obeyed even when it names the other list
    const other = surveyRows({ ...result, classifyOn: 'components' });
    assert.equal(other.rows.length, 1, 'the module said components, so components');
    // and the limit says what it dropped
    assert.equal(surveyRows(result, { limit: 2 }).setAside.beyondLimit, 2);
    assert.equal(surveyRows(null).rows.length, 0);
  },

  async function aSelfFlooredEmissionIsNotGivenAFakeSnr() {
    const result = { present: true, classifyOn: 'emissions', emissions: [
      { startSec: 1, endSec: 2, lowHz: 900, highHz: 1100, cells: 40, snrDb: null, selfFloored: true, aboveContentEdge: false },
    ] };
    const text = reportLines({ detections: surveyRows(result).rows, survey: surveyRows(result) }).join('\n');
    assert.match(text, /#1\s+0:01\.0–0:02\.0\s+900–1100 Hz\s+own floor/);
    assert.ok(!/SNR —/.test(text));
  },

  async function aSelectedEmissionIsRebasedToTheSliceTheWorkerSees() {
    const state = {
      region: { from: 13.0, to: 30.5, lowHz: 54, highHz: 2907 },
      selectedId: 'e1',
      detections: [{ id: 'e1', startSec: 13.0, endSec: 30.5, lowHz: 54, highHz: 2907 }],
    };
    const c = taskOptions('classify', {}, state);
    assert.equal(c.detection.startSec, 0, 'the slice starts at zero');
    assert.ok(Math.abs(c.detection.endSec - 17.5) < 1e-9, 'and ends where the slice ends');
    assert.equal(c.detection.lowHz, 54);
    // the band goes to measure and to the Morse tone search; no selection, no band
    assert.deepEqual(taskOptions('measure', {}, state), { lowHz: 54, highHz: 2907 });
    assert.deepEqual(taskOptions('decode', {}, state).cw, { searchLoHz: 54, searchHiHz: 2907 });
    assert.deepEqual(taskOptions('measure', {}, { region: { from: 0, to: 120 } }), {});
    assert.deepEqual(taskOptions('tdoa', { station: 'x' }, state), { station: 'x' });
  },

  async function theReportSaysWhatItCannotKnow() {
    const text = reportLines({}).join('\n');
    assert.match(text, /public broadcast/);
    assert.match(text, /nothing here knows the transmitter/,
      'the panel must not let a reader think this identifies anyone');
  },

  async function theScreenIsShorterThanTheCopiedReport() {
    // The method strings are the provenance and belong in what a person pastes
    // into a note; one line of each is enough to orient them on screen.
    const st = { measured: measure(keyedTone(), RATE) };
    const full = reportLines(st, { methods: true });
    const brief = reportLines(st, { methods: false });
    assert.ok(full.length > brief.length * 1.5,
      `full ${full.length} lines against brief ${brief.length}: the methods are not being carried`);
    assert.ok(brief.length < 45, `the panel prints ${brief.length} lines, which is too many to read`);
  },

  async function proseIsWrappedAndNeverLosesAWord() {
    const long = 'one two three four five six seven eight nine ten eleven twelve';
    const lines = wrap(long, 20);
    assert.ok(lines.every((l) => l.length <= 20), JSON.stringify(lines));
    assert.equal(lines.join(' '), long, 'wrapping must not drop or duplicate a word');
    assert.deepEqual(wrap('', 10), []);
  },
];
