// ABX: the protocol and the statistics, with the arithmetic checked against
// values that can be worked out by hand.
//
// A listening test is the easiest place on this bench to fool yourself, in both
// directions: a short session that "proves" a difference, and a null result
// read as "they are identical". Both are pinned here.
import assert from 'node:assert/strict';

import {
  binomialTailAtChance, trialsNeeded, sequence, levelMatch, score, detectableAt,
} from '../js/abx/trial.js';

export const NAME = 'ABX listening test';

const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol,
  `${what}: ${a} is not within ${tol} of ${b}`);

export const cases = [
  function theBinomialTailMatchesValuesThatCanBeCountedByHand() {
    // A perfect score of n is one outcome out of 2^n.
    close(binomialTailAtChance(5, 5), 1 / 32, 1e-12, 'perfect 5');
    close(binomialTailAtChance(10, 10), 1 / 1024, 1e-12, 'perfect 10');
    close(binomialTailAtChance(16, 16), 1 / 65536, 1e-12, 'perfect 16');
    // Every outcome is at least zero correct.
    for (const n of [1, 5, 10, 33]) assert.equal(binomialTailAtChance(0, n), 1, `tail(0, ${n})`);
    // n = 5: P(X >= 3) = (10 + 5 + 1) / 32 = 1/2 exactly, by symmetry.
    close(binomialTailAtChance(3, 5), 0.5, 1e-12, 'three of five');
    // n = 10, k = 8: (45 + 10 + 1) / 1024.
    close(binomialTailAtChance(8, 10), 56 / 1024, 1e-12, 'eight of ten');
    // More correct than trials is impossible; fewer than none is everything.
    assert.equal(binomialTailAtChance(6, 5), 0);
    assert.equal(binomialTailAtChance(-1, 5), 1);
    // And it survives a length where a naive factorial would overflow.
    assert.ok(binomialTailAtChance(200, 200) > 0, '200 perfect trials must not underflow to zero');
    close(binomialTailAtChance(100, 200), 0.5282, 1e-3, 'half of two hundred');
  },

  function aSessionTooShortToProveAnythingSaysSoBeforeItStarts() {
    // 1/16 = 0.0625 > 0.05, 1/32 = 0.03125 <= 0.05.
    assert.equal(trialsNeeded(0.05), 5);
    // 1/64 = 0.0156 > 0.01, 1/128 = 0.0078 <= 0.01.
    assert.equal(trialsNeeded(0.01), 7);
    // Four perfect trials is not evidence at the usual bar, however confident
    // the listener is, and the result must say that rather than "not shown".
    const four = score(['A', 'B', 'A', 'B'], ['A', 'B', 'A', 'B']);
    assert.equal(four.correct, 4);
    assert.equal(four.significant, false);
    assert.equal(four.underpowered, true);
    assert.match(four.reason, /cannot reach p <= 0\.05 even with a perfect score/);
    // Five can.
    const five = score(['A', 'B', 'A', 'B', 'A'], ['A', 'B', 'A', 'B', 'A']);
    assert.equal(five.significant, true);
    assert.equal(five.underpowered, false);
    close(five.pValue, 1 / 32, 1e-12, 'perfect five p');
  },

  function aNullResultIsNeverReportedAsSameness() {
    // Ten trials, six correct. This is the result that gets misread.
    const out = score(
      ['A', 'B', 'A', 'B', 'A', 'A', 'B', 'A', 'B', 'B'],
      ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B'],
    );
    assert.equal(out.correct, 6);
    assert.equal(out.significant, false);
    assert.equal(out.underpowered, false);
    assert.equal(out.verdict, 'not shown');
    // The wording has to negate the claim, not avoid the word: "does not show
    // the two are identical" is the sentence that should be there, so what is
    // banned is an unhedged assertion of sameness.
    assert.doesNotMatch(out.reason, /\bno difference\b|\bsound the same\b|\bare the same\b/i,
      'the reason must not assert the two versions are the same');
    assert.match(out.reason, /does not show the two are identical/);
    // And it states the bound it is entitled to instead.
    assert.match(out.reason, /would usually have failed this session too/);
  },

  function theSessionLengthSaysWhatItCouldHaveCaught() {
    // Power, stated as the per-trial success rate this length catches 80% of
    // the time. Longer sessions catch smaller differences; that ordering is
    // the property worth pinning, and the numbers are the current values.
    assert.equal(detectableAt(4), 1, 'a session that cannot be significant catches nothing');
    const ten = detectableAt(10), thirty = detectableAt(30), hundred = detectableAt(100);
    assert.ok(ten > thirty && thirty > hundred, `power should improve with length: ${ten}, ${thirty}, ${hundred}`);
    close(ten, 0.92, 0.02, 'ten trials');
    close(thirty, 0.72, 0.02, 'thirty trials');
    assert.ok(hundred < 0.65, `a hundred trials should reach below 0.65: ${hundred}`);
  },

  function theHiddenSequenceIsBalancedAndReplayable() {
    for (const n of [5, 10, 11, 32]) {
      const s = sequence(n, 4);
      assert.equal(s.length, n);
      const a = s.filter((x) => x === 'A').length;
      // Balanced rather than independently random: an unbalanced session is one
      // where answering "A" every time beats chance for no reason.
      assert.ok(Math.abs(a - (n - a)) <= 1, `${n} trials split ${a}/${n - a}`);
    }
    // Replayable from the seed, and different seeds give different sessions.
    assert.deepEqual(sequence(16, 99), sequence(16, 99));
    assert.notDeepEqual(sequence(16, 99), sequence(16, 100));
    assert.throws(() => sequence(0), /at least one trial/);
    // No run long enough to ride: over a long session the longest run of one
    // letter should stay near what chance gives, not sit at ten in a row.
    const long = sequence(64, 12345);
    let run = 1, worst = 1;
    for (let i = 1; i < long.length; i++) {
      run = long[i] === long[i - 1] ? run + 1 : 1;
      if (run > worst) worst = run;
    }
    assert.ok(worst <= 8, `longest run was ${worst}, which a listener could ride`);
  },

  function levelIsMatchedBeforeAnythingIsBlinded() {
    // An ABX between a loud version and a quiet one measures the level.
    // B is 6 LU quieter, so it carries +6 dB; neither is near the ceiling.
    const m = levelMatch(-20, -26, -3, -9);
    assert.equal(m.ok, true);
    close(m.gainADb, 0, 1e-9, 'A untouched');
    close(m.gainBDb, 6, 1e-9, 'B matched');
    close(m.commonTrimDb, 0, 1e-9, 'no headroom needed');
  },

  function matchingNeverPushesEitherVersionIntoTheCeiling() {
    // Same 6 LU difference, but A already peaks at -0.5 dBTP, above the -1
    // ceiling. Both must come down by the same amount: trimming only the one
    // that is over would undo the loudness match it was just given.
    const m = levelMatch(-20, -26, -0.5, -9, { ceilingDb: -1 });
    assert.equal(m.ok, true);
    close(m.commonTrimDb, -0.5, 1e-9, 'common trim');
    close(m.gainADb, -0.5, 1e-9, 'A trimmed');
    close(m.gainBDb, 5.5, 1e-9, 'B matched and trimmed by the same amount');
    // The match is preserved exactly: the difference between the two gains is
    // still the loudness difference.
    close(m.gainBDb - m.gainADb, 6, 1e-12, 'match preserved through the trim');
    // And B's matched peak is what decides it when B is the louder one.
    const bLouder = levelMatch(-20, -26, -9, -0.5, { ceilingDb: -1 });
    close(bLouder.gainBDb - bLouder.gainADb, 6, 1e-12, 'match preserved');
    assert.ok(-0.5 + 6 + bLouder.gainADb <= -1 + 1e-9,
      "B's peak after matching must sit under the ceiling");
  },

  function aRackThatChangesLevelIsNotACandidateForBlindComparison() {
    const m = levelMatch(-20, -40, -3, -3);
    assert.equal(m.ok, false);
    assert.match(m.reason, /20\.0 LU/);
    assert.match(m.reason, /level change rather than a processing difference/);
    // And a version with no measurable loudness (silence) is refused by name.
    const silent = levelMatch(-20, -Infinity, -3, -Infinity);
    assert.equal(silent.ok, false);
    assert.match(silent.reason, /no measurable loudness/);
  },

  function scoringRefusesMoreAnswersThanTrials() {
    assert.throws(() => score(['A', 'B', 'A'], ['A', 'B']), /more answers than trials/);
    // A session in progress scores what it has.
    const partial = score(['A', 'B'], sequence(20, 3));
    assert.equal(partial.trials, 2);
    assert.equal(partial.underpowered, true);
  },
];
