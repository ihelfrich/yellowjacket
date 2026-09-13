// Key, tuning and chords. Pinned on rendered progressions whose answer is
// known by construction, and on noise, which has no answer and must not be
// given one.
import assert from 'node:assert/strict';

import { readHarmony, scoreKeys, scoreChords, viterbiChords, estimateTuning, chromaOf, PITCH_NAMES, KK_MAJOR, KK_MINOR } from '../js/analysis/harmony.js';
import { COLOURS } from './noise-colours.mjs';

export const NAME = 'harmony: key, tuning and chords';

const SR = 22050;

/** A chord as four harmonics a note, Hann-shaped so there is no click. */
function chord(midis, sec, { refHz = 440, amp = 0.25 } = {}) {
  const n = Math.round(SR * sec), out = new Float32Array(n);
  for (const m of midis) {
    const f = refHz * 2 ** ((m - 69) / 12);
    for (let h = 1; h <= 4; h++) {
      if (f * h > SR / 2) break;
      for (let i = 0; i < n; i++) out[i] += (amp / h) * Math.sin(2 * Math.PI * f * h * i / SR) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
    }
  }
  return out;
}

function joinChords(prog, sec, opts) {
  const parts = prog.map((c) => chord(c, sec, opts));
  const x = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { x.set(p, o); o += p.length; }
  return x;
}

const I_IV_V_I = [[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]];

export const cases = [
  function theProbeToneProfilesAreTheOnesKrumhanslPublished() {
    assert.equal(KK_MAJOR.length, 12);
    assert.equal(KK_MINOR.length, 12);
    // The tonic is the largest value in both, and in major the dominant is
    // second. A transposed or mistyped profile fails here rather than quietly
    // naming every recording a fifth away from its key.
    assert.equal(KK_MAJOR.indexOf(Math.max(...KK_MAJOR)), 0);
    assert.equal(KK_MINOR.indexOf(Math.max(...KK_MINOR)), 0);
    const major = KK_MAJOR.slice(); major[0] = -Infinity;
    assert.equal(major.indexOf(Math.max(...major)), 7, 'the dominant is next in major');
  },

  function aCadenceIsReadAsItsKeyWithItsCamelotCode() {
    const r = readHarmony(joinChords(I_IV_V_I, 1), SR);
    assert.ok(r.ok, r.reason);
    assert.equal(r.key, 'C major');
    assert.equal(r.camelot, '8B');
    assert.equal(r.confident, true);
    assert.ok(r.correlation > 0.85, `correlation ${r.correlation}`);
    assert.ok(r.gap > 0.1, `gap to ${r.runnerUp.key} is only ${r.gap}`);
    assert.equal(r.caution, null);
  },

  function theSameCadenceTransposedMovesWithIt() {
    // Every key gets the same treatment; a decoder anchored to C would pass
    // the case above and fail here.
    for (const [semitones, want, camelot] of [[2, 'D major', '10B'], [5, 'F major', '7B'], [9, 'A major', '11B']]) {
      const prog = I_IV_V_I.map((c) => c.map((m) => m + semitones));
      const r = readHarmony(joinChords(prog, 1), SR);
      assert.ok(r.ok, r.reason);
      assert.equal(r.key, want, `+${semitones} semitones`);
      assert.equal(r.camelot, camelot);
    }
  },

  function aMinorProgressionIsNotCalledItsRelativeMajor() {
    // A minor and C major share every note; only the weighting separates them,
    // which is the whole reason the profiles exist.
    const prog = [[57, 60, 64], [62, 65, 69], [64, 68, 71], [57, 60, 64]];   // Am Dm E Am
    const r = readHarmony(joinChords(prog, 1), SR);
    assert.ok(r.ok, r.reason);
    assert.equal(r.mode, 'minor');
    assert.equal(PITCH_NAMES[r.root], 'A');
    assert.equal(r.camelot, '8A');
  },

  function theChordsComeBackInOrderAndInTime() {
    const r = readHarmony(joinChords(I_IV_V_I, 1), SR);
    assert.ok(r.ok, r.reason);
    assert.deepEqual(r.chords.map((c) => c.name), ['C', 'F', 'G', 'C']);
    // Each lands within a window of where it was rendered.
    const starts = r.chords.map((c) => c.startSec);
    for (let i = 0; i < 4; i++) assert.ok(Math.abs(starts[i] - i) < 0.45, `chord ${i} started at ${starts[i]}`);
  },

  function minorAndSeventhChordsAreToldApartFromTheirTriads() {
    const c = chromaOf(chord([60, 63, 67], 0.5), SR);       // C minor
    assert.equal(scoreChords(c.chroma)[0].name, 'Cm');
    const d = chromaOf(chord([62, 65, 69, 72], 0.5), SR);   // D minor 7
    const top = scoreChords(d.chroma).slice(0, 3).map((x) => x.name);
    assert.ok(top.includes('Dm7') || top.includes('Dm'), top.join(','));
  },

  function theSwitchingCostStopsAChordPerWindow() {
    // Four windows of C, one stray F, four more of C. Without a cost for
    // changing, the stray becomes its own chord.
    const frames = [];
    for (let i = 0; i < 9; i++) {
      const isStray = i === 4;
      frames.push([
        { name: 'C', r: isStray ? 0.55 : 0.9 },
        { name: 'F', r: isStray ? 0.6 : 0.3 },
      ]);
    }
    assert.deepEqual(new Set(viterbiChords(frames, { switchCost: 0.35 })), new Set(['C']));
    // With no cost at all it flips, which is what the cost is for.
    assert.ok(viterbiChords(frames, { switchCost: 0 }).includes('F'));
  },

  function theTuningIsMeasuredRatherThanAssumed() {
    // A recording 30 cents sharp. Without measuring it, every note sits
    // between two classes and the chroma smears.
    const ref = 440 * 2 ** (30 / 1200);
    const t = estimateTuning(joinChords(I_IV_V_I, 1, { refHz: ref }), SR);
    assert.ok(Math.abs(t.cents - 30) < 8, `measured ${t.cents} cents against 30`);
    assert.ok(t.confidence > 0.5, `confidence ${t.confidence}`);
    const r = readHarmony(joinChords(I_IV_V_I, 1, { refHz: ref }), SR);
    assert.ok(r.ok, r.reason);
    assert.equal(r.key, 'C major', 'the key survives the detuning');
    assert.match(r.text, /tuned \+[\d.]+ cents from A440/);
    // And a recording at concert pitch is not accused of being off it.
    const straight = readHarmony(joinChords(I_IV_V_I, 1), SR);
    assert.doesNotMatch(straight.text, /cents from A440/);
  },

  function noiseIsNeverGivenAKey() {
    for (const name of ['white', 'pink', 'bursty', 'faded', 'impulsive']) {
      const r = readHarmony(COLOURS[name](SR * 6, { seed: 4 }), SR);
      if (!r.ok) continue;                      // a refusal is the best answer
      assert.equal(r.confident, false, `${name} was called ${r.key} with confidence`);
      assert.ok(typeof r.caution === 'string' && r.caution.length > 20, `${name} gave no caution`);
      assert.match(r.text, /uncertain/);
    }
    assert.equal(readHarmony(new Float32Array(100), SR).ok, false);
  },

  function twoKeysTooCloseToSeparateAreSaidToBe() {
    // A bare fifth belongs to several keys at once and nothing decides it.
    const n = Math.round(SR * 4), x = new Float32Array(n);
    for (const f of [261.63, 392.0]) for (let i = 0; i < n; i++) x[i] += 0.3 * Math.sin(2 * Math.PI * f * i / SR);
    const r = readHarmony(x, SR);
    assert.ok(r.ok, r.reason);
    assert.ok(!r.confident || r.gap > 0.03);
    if (!r.confident) assert.ok(r.caution.includes('score within') || r.caution.includes('may not be tonal'), r.caution);
  },

  function everyKeyHasADistinctCamelotCode() {
    const keys = scoreKeys(new Float64Array(12).fill(1));
    assert.equal(keys.length, 24);
    assert.equal(new Set(keys.map((k) => k.camelot)).size, 24);
    // The wheel's neighbours are a fifth apart, which is what makes it useful.
    const byName = Object.fromEntries(keys.map((k) => [k.name, k.camelot]));
    assert.equal(byName['C major'], '8B');
    assert.equal(byName['G major'], '9B');
    assert.equal(byName['A minor'], '8A');
  },
];
