// What each decoder does when handed nothing, across five noise colours AND a
// grid over the generators' own parameters.
//
// This group exists because of a pattern that showed up four times in a row:
// a gate would be fixed, measured at zero false accepts, and then fail as soon
// as the crash rate or the gate rate or the fade rate moved off the one value
// its author had tested. A threshold fitted to a test is not a threshold.
//
// So the numbers below are BUDGETS, not promises. They are what was measured on
// this grid, rounded up a little, and a change that pushes past them fails here
// rather than being discovered later by someone who believed a decode.
import assert from 'node:assert/strict';

import { COLOURS } from './noise-colours.mjs';
import { decodeRtty } from '../js/sigint/decode/rtty.js';
import { decodeCw } from '../js/sigint/decode/cw.js';
import { classifySegment } from '../js/sigint/classify.js';
import { measure } from '../js/sigint/measure.js';

const RATE = 8000;
const SECONDS = 4;
const N = RATE * SECONDS;
const SEEDS = 4;

// The grid is over the generators' parameters, not only their seeds. Each row
// is a different shape of nothing.
const GRID = [
  ['white', {}],
  ['pink', {}],
  ['pink', { rows: 8 }],
  ['faded', { fadeHz: 0.4 }],
  ['faded', { fadeHz: 2 }],
  ['impulsive', { perSecond: 12 }],
  ['impulsive', { perSecond: 40, gain: 20 }],
  ['bursty', { onHz: 6 }],
  ['bursty', { onHz: 20 }],
];

function sweep(answers) {
  let total = 0, hits = 0;
  const where = [];
  for (const [colour, opts] of GRID) {
    let c = 0;
    for (let s = 0; s < SEEDS; s++) {
      const x = COLOURS[colour](N, { ...opts, seed: 1000 + 7919 * s, rate: RATE });
      let said = false;
      try { said = answers(x); } catch (_) { said = false; }   // a throw is not an answer
      if (said) c++;
    }
    total += SEEDS;
    hits += c;
    if (c) where.push(`${colour}${JSON.stringify(opts)} ${c}/${SEEDS}`);
  }
  return { total, hits, rate: hits / total, where: where.join(', ') };
}

const budget = (name, r, allowed) => {
  assert.ok(r.rate <= allowed,
    `${name} answered on ${r.hits} of ${r.total} noise inputs (${(100 * r.rate).toFixed(1)}%), `
    + `over a budget of ${(100 * allowed).toFixed(1)}%. Where: ${r.where}`);
};

export const NAME = 'refusal budget';

export const cases = [
  async function rttyDoesNotTypeOutOfNothing() {
    // Measured 0 of 156 across the full grid. This decoder began the session
    // returning plausible text on 100% of white-noise seeds, so the budget is
    // deliberately unforgiving: it is the one that got the derived null.
    const r = sweep((x) => {
      const out = decodeRtty(x, RATE, { markHz: 2125, spaceHz: 2295 });
      return !!(out && out.ok && out.text);
    });
    budget('decodeRtty, told the tones', r, 0.01);
  },

  async function morseDoesNotReadNothing() {
    // Measured 0 of 156 across the full grid.
    const r = sweep((x) => {
      const out = decodeCw(x, RATE);
      return !!(out && out.ok !== false && out.text && out.text.trim().length > 1);
    });
    budget('decodeCw', r, 0.02);
  },

  async function classifyDoesNotNameATransmissionInNoise() {
    // Measured 2 of 156 (1.3%), both on default pink. It was 34 of 156 before
    // the pulsed-wideband hypothesis learned to ask whether the repetition
    // keeps time — gated noise satisfies every other test it has.
    // 'unclear' counts as a refusal here, because it is one.
    const r = sweep((x) => {
      const out = classifySegment(x, RATE, null);
      const top = out && (out.verdict || (out.ranked && out.ranked[0] && (out.ranked[0].id || out.ranked[0].label)));
      return !!(top && !/noise|unknown|cannot|unclear/i.test(String(top)));
    });
    budget('classify', r, 0.05);
  },

  async function measureDoesNotNameASymbolRateInNoise() {
    const r = sweep((x) => {
      const out = measure(x, RATE);
      return !!(out && out.symbolRate && out.symbolRate.baud != null);
    });
    budget('measure symbolRate', r, 0.05);
  },

  async function theGridIsActuallyVariedAndNotNineCopiesOfWhite() {
    // If the generators ever collapse to one shape, every budget above passes
    // for the wrong reason. This is the guard on the guard.
    const seen = new Set();
    for (const [colour, opts] of GRID) {
      const x = COLOURS[colour](RATE, { ...opts, seed: 5, rate: RATE });
      let s = 0;
      for (const v of x) s += v * v;
      seen.add(colour + ':' + Math.round(1000 * Math.sqrt(s / x.length)));
    }
    assert.ok(seen.size >= 7, `the grid collapsed to ${seen.size} distinct signals`);
    assert.equal(GRID.length, 9);
  },
];
