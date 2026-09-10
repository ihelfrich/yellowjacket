// What the SIGINT panel prints. reportLines is pure, so the thing a person
// actually reads can be pinned without a browser.
import assert from 'node:assert/strict';

import { reportLines, quantities, wrap } from '../js/app/sigint-controller.js';
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
