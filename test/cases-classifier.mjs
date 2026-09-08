// The family classifier is honest: every hypothesis is scored on every measured ratio, and an object with no model in the table is told so.
import assert from 'node:assert/strict';
import { classifyFamily, familyScores, UNKNOWN_DISTANCE, COVERAGE_PENALTY, MIN_VOTING_MODES, FAMILY_RATIOS } from '../js/instrument/card.js';

const modes = (hz) => hz.map((freqHz) => ({ freqHz, tauSec: 1, amp: 1, phase: 0 }));
const barDistance = (hz) => familyScores(modes(hz)).scores.find((s) => s.kind === 'bar').dist;
const close = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, what + ': ' + got);

// University of Iowa MIS orchestral bells, anechoic (docs/lab/2026-09-06-iowa-calibration.md)
const IOWA_A5 = [885, 2806, 5690, 7813];
const IOWA_CS5_BRASS = [557, 1822, 3961, 6134, 8973];
// Freesound 654156 (Zypce, CC0), a struck wine glass: docs/lab/cards/freesound-wineglass.json
const WINE_GLASS = [568.4, 3920.3, 5609.4, 9247.0, 11234.0, 11246.4];
// FDR, first fireside chat, one vowel: docs/lab/cards/fdr-vowel.json, the six lowest voting modes
const FDR_VOWEL = [206.5, 404.3, 619.6, 777.8, 972.7, 1168.9];

export const NAME = 'classifier honesty';
export const cases = [
  function theBarHypothesisIsScoredOnEveryMeasuredRatio() {
    // 1 : 3.23 : 6.99 is the tuned set itself, so the arch reaches it exactly
    const tuned = [600, 1938, 4194];
    assert.equal(classifyFamily(modes(tuned)).kind, 'bar');
    assert.ok(barDistance(tuned) < 0.001, 'an exact tuned bar is at no distance: ' + barDistance(tuned).toFixed(4));
    // two more partials at 12.5× and 17×, which no arch between the free bar
    // and the tuned set places. Fitting the arch on the first two overtones and
    // scoring it on those same three ratios left the distance at zero here.
    const withUnplaceable = [...tuned, 7500, 10200];
    assert.ok(barDistance(withUnplaceable) > 0.1, 'they cost the hypothesis: ' + barDistance(withUnplaceable).toFixed(4));
    assert.equal(classifyFamily(modes(withUnplaceable)).kind, 'unknown', JSON.stringify(classifyFamily(modes(withUnplaceable))));
  },
  function aRealOrchestralBellStillReadsAsATunedBar() {
    const a5 = classifyFamily(modes(IOWA_A5));
    assert.equal(a5.kind, 'bar', JSON.stringify(a5));
    assert.ok(a5.arch > 0.4 && a5.arch < 0.95, 'a shorter bar, a shallower arch: ' + a5.arch);
    const cs5 = classifyFamily(modes(IOWA_CS5_BRASS));
    assert.equal(cs5.kind, 'bar', JSON.stringify(cs5));
    assert.ok(cs5.arch > 0.8 && cs5.arch < 1.2, 'arch near the measured set: ' + cs5.arch);
    // A5's fourth partial sits at the free bar's 8.93 while its second and third
    // sit near arch 0.85, so one parameter cannot hold all four: it is the
    // costliest real bell in the set and it is what the gate has to clear.
    assert.ok(barDistance(IOWA_A5) > barDistance(IOWA_CS5_BRASS), 'A5 is the worse fit: ' + barDistance(IOWA_A5).toFixed(4));
    assert.ok(barDistance(IOWA_A5) < UNKNOWN_DISTANCE, 'and still inside the gate: ' + barDistance(IOWA_A5).toFixed(4));
  },
  function aShellIsNoKnownFamilyRatherThanAConfidentBar() {
    const glass = classifyFamily(modes(WINE_GLASS));
    assert.equal(glass.kind, 'unknown', JSON.stringify(glass));
    assert.equal(glass.arch, 0, 'and carries no arch to render from');
    assert.ok(barDistance(WINE_GLASS) > UNKNOWN_DISTANCE, 'the bar it once matched is out of reach: ' + barDistance(WINE_GLASS).toFixed(4));
    // a hemisphere: 1 : 1.7 : 2.4 : 3.2 is a shell, not a bar, a bell or a plate
    const bowl = classifyFamily(modes([420, 714, 1008, 1344]));
    assert.equal(bowl.kind, 'unknown', JSON.stringify(bowl));
  },
  function confidenceReadsTheFitAndTheMarginIsKeptSeparately() {
    // 1 : 3.26 : 7.69 sits 2.5 % from the nearest arch and twenty times that
    // from anything else. On the margin to the runner-up it printed 96 %.
    const stray = classifyFamily(modes([600, 1957.4, 4613]));
    assert.equal(stray.kind, 'bar', JSON.stringify(stray));
    assert.ok(stray.margin > 0.9, 'far from every other family: ' + stray.margin.toFixed(3));
    assert.ok(stray.confidence < 0.65, 'and no better than its fit: ' + stray.confidence.toFixed(3));
    // The margin and the fit order these two the opposite way round. A voiced
    // vowel's comb (hiawatha-vowel's ratios) sits at 0.011 and Iowa A5 at
    // 0.052, so A5 fits 4.7x worse — and carries the larger margin.
    const comb = classifyFamily(modes([200, 394.8, 593.6, 792.4, 988.8, 1187.8]));
    const a5 = classifyFamily(modes(IOWA_A5));
    assert.ok(a5.dist > 4 * comb.dist, 'A5 is much the worse fit: ' + a5.dist.toFixed(4) + ' against ' + comb.dist.toFixed(4));
    assert.ok(a5.margin > comb.margin, 'and had the larger margin: ' + a5.margin.toFixed(3) + ' against ' + comb.margin.toFixed(3));
    assert.ok(a5.confidence < comb.confidence, 'so the number the panel prints must now rank them the other way: ' + a5.confidence.toFixed(3) + ' against ' + comb.confidence.toFixed(3));
    // it is the distance on the gate's own scale, and nothing outside the gate
    // is reported as any kind of match
    for (const f of [stray, comb, a5]) assert.ok(Math.abs(f.confidence - (1 - f.dist / UNKNOWN_DISTANCE)) < 1e-12, 'confidence is the fit: ' + JSON.stringify(f.kind));
    assert.equal(classifyFamily(modes(WINE_GLASS)).confidence, 0, 'a shell matches nothing in the table and is told so');
  },
  function theGateSeparatesTheRealBellsFromTheObjectsWithNoModel() {
    const bells = [IOWA_A5, IOWA_CS5_BRASS].map(barDistance);
    const strangers = [WINE_GLASS, [787.1, 2512.6, 6342.0, 8101.5]].map(barDistance); // a carillon bell (aporee 59454)
    assert.ok(Math.max(...bells) < UNKNOWN_DISTANCE, 'every real bell inside: ' + bells.map((d) => d.toFixed(3)).join(' '));
    assert.ok(Math.min(...strangers) > UNKNOWN_DISTANCE, 'every stranger outside: ' + strangers.map((d) => d.toFixed(3)).join(' '));
    assert.ok(Math.min(...strangers) > 1.4 * Math.max(...bells), 'with room between them, not a knife edge');
    // The room is between the two populations, not around A5 itself: it clears
    // the gate by 0.0081 of 0.0600, and the fit does not degrade smoothly there.
    // A 2 % error on its second partial takes that partial out of the 5 % window
    // of every arch's slot, so coverage steps 1.00 -> 0.67 and the charged
    // distance jumps 0.052 -> 0.095, well past the gate, in one step.
    const a5Off = [885, 2806 * 1.02, 5690, 7813];
    assert.ok(barDistance(a5Off) > 1.7 * barDistance(IOWA_A5), 'a 2 % error is not a 2 % move: ' + barDistance(a5Off).toFixed(4));
    assert.equal(classifyFamily(modes(a5Off)).kind, 'unknown', 'and it leaves the gate');
  },
  function anUnnamedCardReportsNoConfidence() {
    // `confidence` says how well the ratios fit the family named beside it.
    // When no family is named there is nothing to be confident about, and the
    // three ways a card goes unnamed all have to say so.
    const octave = classifyFamily(modes([600, 1200, 1800]));
    assert.equal(octave.kind, 'string', 'a comb of three is named: ' + JSON.stringify(octave));
    const twoOfIt = classifyFamily(modes([600, 1200]));         // too little evidence to score
    const tied = classifyFamily(modes([600, 1200, 3000]));      // scored, but the margin gate refuses it
    const far = classifyFamily(modes(WINE_GLASS));              // scored, but past the distance gate
    for (const f of [twoOfIt, tied, far]) {
      assert.equal(f.kind, 'unknown', JSON.stringify(f));
      assert.equal(f.confidence, 0, 'and reports no confidence in the name it did not give: ' + JSON.stringify(f));
    }
    // it used to read the winner's fit whatever the gates said. 1 : 2 : 5 is
    // the case: the string reaches it at 0.0080 and the bell at 0.0100, which
    // is a margin of 0.200 and no verdict — and it came back `unknown (87%)`.
    assert.ok(tied.margin < 0.25, 'two families the ratios fit near enough alike: ' + tied.margin.toFixed(3));
    assert.ok(tied.dist < UNKNOWN_DISTANCE, 'well inside the distance gate: ' + tied.dist.toFixed(4));
    close(1 - tied.dist / UNKNOWN_DISTANCE, 0.867, 0.002, 'the fit the panel would have printed beside no family');
  },
  function twoVotingModesAreOneRatioAndNameNothing() {
    // The first ratio is 1 by construction, so two modes carry one informative
    // ratio — and the arch is a continuum: its second slot runs 2.670 (arch
    // −0.2) to 3.442 (arch 1.4), so any second partial across a ±14.5 % band
    // sits at no distance from some arch. All four of these read `bar` at
    // 99.3–100 %.
    const archSecond = (a) => Math.exp((1 - a) * Math.log(FAMILY_RATIOS.bar[1]) + a * Math.log(FAMILY_RATIOS.tunedBar[1]));
    assert.ok(Math.abs(archSecond(-0.2) - 2.670) < 0.001 && Math.abs(archSecond(1.4) - 3.442) < 0.001,
      'the band is the model\'s own: ' + archSecond(-0.2).toFixed(3) + ' to ' + archSecond(1.4).toFixed(3));
    for (const second of [1740, 1860, 1938, 1957.4]) {
      const f = classifyFamily(modes([600, second]));
      assert.equal(f.kind, 'unknown', JSON.stringify(f));
      assert.equal(f.confidence, 0, 'no fit is reported on evidence that could not refute it: ' + f.confidence);
      assert.equal(f.dist, null, 'because nothing was scored: ' + f.dist);
      assert.equal(familyScores(modes([600, second])).scores.length, 0);
      // the ratios are still recorded; it is the verdict that is withheld
      assert.equal(classifyFamily(modes([600, second])).ratios.length, 2);
    }
    close(classifyFamily(modes([600, 1938])).ratios[1], 3.23, 1e-9, 'and recorded as measured, not as 1');
    // A third mode is a second informative ratio, and the four separate: with
    // the tuned third partial at 6.99, 2.90 leaves the family altogether and
    // the rest are ordered by how well they fit it.
    assert.equal(MIN_VOTING_MODES, 3);
    const three = [1740, 1860, 1938, 1957.4].map((second) => classifyFamily(modes([600, second, 4194])));
    assert.equal(three[0].kind, 'unknown', 'no arch holds 2.90 and 6.99 together: ' + JSON.stringify(three[0]));
    assert.deepEqual(three.slice(1).map((f) => f.kind), ['bar', 'bar', 'bar']);
    const confs = three.slice(1).map((f) => +f.confidence.toFixed(3));
    assert.deepEqual(confs, [0.658, 1, 0.917], 'and the number now moves with the evidence: ' + confs.join(' '));
  },
  function theStringCombIsMeasuredTheWayEveryOtherFamilyIs() {
    // The string family used to measure its own coverage as
    // `indices.size / max(indices)` — distinct rounded harmonic numbers over
    // the largest — which asks which integer a ratio rounds to and never how
    // near it sits. Rounding cannot fail, so it scored 1.00 on anything.
    const retired = (rs) => { const ix = new Set(rs.map((r) => Math.max(1, Math.round(r)))); return ix.size / Math.max(...ix); };
    const ratios = (hz) => hz.map((f) => f / hz[0]);
    const stringOf = (hz) => familyScores(modes(hz)).scores.find((s) => s.kind === 'string');
    // a hemisphere 15 % and 20 % off a harmonic, and a vowel whose top three
    // partials are 4:5:6 of a different fundamental
    for (const hz of [[420, 714, 1008, 1344], FDR_VOWEL]) {
      assert.equal(retired(ratios(hz)), 1, 'the retired measure scored a full comb: ' + ratios(hz).map((r) => r.toFixed(2)).join(':'));
    }
    assert.equal(stringOf([420, 714, 1008, 1344]).coverage, 1 / 3, 'the shared measure asks how near, within 5 %');
    assert.equal(stringOf([420, 714, 1008, 1344]).dist, Infinity, 'and a third of a comb is not a string');
    const fdr = stringOf(FDR_VOWEL);
    assert.equal(fdr.coverage, 0.5, 'three of fdr-vowel\'s six harmonics are 5.7–5.9 % flat: ' + fdr.coverage);
    assert.ok(fdr.dist > UNKNOWN_DISTANCE, 'so it leaves the gate: ' + fdr.dist.toFixed(4));
    assert.equal(classifyFamily(modes(FDR_VOWEL)).kind, 'unknown', JSON.stringify(classifyFamily(modes(FDR_VOWEL))));
    // and that verdict does not rest on the 10 % slot headroom: without it
    // fdr-vowel's string coverage is 0.60 and the distance is still outside.
    const errOpt = (fdr.dist - COVERAGE_PENALTY * (1 - fdr.coverage)) * fdr.coverage;
    assert.ok(errOpt / 0.6 + COVERAGE_PENALTY * 0.4 > UNKNOWN_DISTANCE, 'at coverage 0.60: ' + (errOpt / 0.6 + COVERAGE_PENALTY * 0.4).toFixed(4));
    // a real comb is untouched: hiawatha-vowel's partials are within 1.3 %
    const hiawatha = stringOf([200, 394.8, 593.6, 792.4, 988.8, 1187.8]);
    assert.equal(hiawatha.coverage, 1, 'a comb still measures a comb');
    assert.ok(hiawatha.dist < UNKNOWN_DISTANCE, hiawatha.dist.toFixed(4));
  },
];
