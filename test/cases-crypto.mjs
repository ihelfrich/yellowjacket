// Cryptanalysis. Two things are pinned here above all others: that the
// attacks solve what they can, and that they REFUSE what they cannot. A hill
// climber always returns a best key, so a solver without a null is a machine
// for producing confident nonsense, and each of these has been caught doing
// exactly that during its construction.
import assert from 'node:assert/strict';

import { score, letters, toText, indexOfCoincidence, MODEL, rng, zAgainstNull, verdictFor } from '../js/crypto/fitness.js';
import {
  solveCaesar, solveVigenere, solveSubstitution, solveTransposition, solveClassical,
  encipherCaesar, encipherVigenere, encipherSubstitution, encipherTransposition, keyLengthProfile,
} from '../js/crypto/classical.js';
import { Enigma, breakEnigma, searchRotors, weakSpans, ROTORS, REFLECTORS, WEHRMACHT } from '../js/crypto/enigma.js';
import { assess, kasiski, ic, repeatedGroups, alphabetOf, symbols, DIGITS } from '../js/crypto/randomness.js';

export const NAME = 'cryptanalysis';

const PT = 'THESHELFISACATALOGUENOTAHOSTANDEVERYENTRYNAMESITSCANONICALFILEONAPUBLICARCHIVEWHICHISWHATTHELICENCECHECKPOINTSATWHENEVERSOMEONEASKSWHERETHERECORDINGCAMEFROMANDTHATISWHYTHEBENCHKEEPSITSSOURCESHONEST';
const LONG = (() => {
  const base = 'THEBENCHMEASURESEVERYTHINGANDTHENREFUSESTOGUESSTHESHELFISACATALOGUENOTAHOSTANDEVERYENTRYNAMESITSCANONICALFILETHEBENCHKEEPSITSSOURCESHONESTBECAUSEABENCHTHATREADSCONFIDENTTRAFFICOUTOFHISSISWORSETHANONETHATREADSNOTHINGTHEBENCHMEASURESEVERYNUMBERANDTHEBENCHSTATESEVERYBOUND';
  return (base + base).slice(0, 700);
})();

const randomLetters = (n, seed) => { const r = rng(seed); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(65 + Math.floor(r() * 26)); return s; };
const randomDigits = (n, seed) => { const r = rng(seed); let s = ''; for (let i = 0; i < n; i++) s += String(Math.floor(r() * 10)); return s; };

export const cases = [
  // ------------------------------------------------------------- the model

  function theModelSeparatesEnglishFromEnglishShuffled() {
    // The fitness function is built from this repository's own prose, so the
    // test that matters is whether it generalises: it has to rank text it has
    // never seen above the same letters in a different order.
    const unseen = letters('IT WAS THE BEST OF TIMES IT WAS THE WORST OF TIMES WE HAD EVERYTHING BEFORE US WE HAD NOTHING BEFORE US WE WERE ALL GOING DIRECT TO HEAVEN');
    const shuffledCodes = Uint8Array.from(unseen);
    const r = rng(4);
    for (let i = shuffledCodes.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = shuffledCodes[i]; shuffledCodes[i] = shuffledCodes[j]; shuffledCodes[j] = t; }
    const english = score(unseen), shuffled = score(shuffledCodes), noise = score(letters(randomLetters(unseen.length, 9)));
    assert.ok(english > shuffled + 1.0, `English ${english.toFixed(2)} must beat its own shuffle ${shuffled.toFixed(2)} by a wide margin`);
    assert.ok(shuffled > noise - 1.5, 'a shuffle keeps the letter frequencies, so it sits between English and uniform noise');
    assert.ok(MODEL.letters > 500000, `the corpus is ${MODEL.letters} letters`);
    assert.ok(MODEL.trigramsSeen > 5000, `${MODEL.trigramsSeen} of 17,576 trigrams observed`);
  },

  function aZScoreNeedsMoreThanOneNullRun() {
    // One sample has no spread, and a z from it is zero however good the
    // answer — which reads as "not solved" for a perfect decrypt.
    const one = zAgainstNull(5, [1]);
    assert.ok(Number.isNaN(one.z));
    assert.match(one.note, /at least two null runs/);
    assert.equal(verdictFor(NaN).confident, false);
    assert.match(verdictFor(NaN).text, /at least two null runs/);
    const many = zAgainstNull(5, [1, 1.2, 0.9, 1.1]);
    assert.ok(many.z > 10);
    assert.equal(verdictFor(many.z).confident, true);
  },

  // -------------------------------------------------------- classical work

  function everyClassicalCipherIsSolvedExactly() {
    const cases = [
      ['caesar', encipherCaesar(PT, 7)],
      ['vigenere', encipherVigenere(PT, 'YELLOWJACKET')],
      ['substitution', encipherSubstitution(PT, 'QWERTYUIOPASDFGHJKLZXCVBNM')],
      ['transposition', encipherTransposition(PT, [3, 0, 4, 1, 5, 2])],
    ];
    for (const [name, ct] of cases) {
      const r = solveClassical(ct);
      assert.ok(r.ok, `${name}: ${r.reason}`);
      assert.equal(r.best.plaintext, PT.replace(/[^A-Z]/g, ''), `${name} did not recover the plaintext`);
      assert.ok(r.best.z > 8, `${name} solved at only z ${r.best.z}`);
    }
  },

  function theVigenereKeyComesBackLetterForLetter() {
    for (const key of ['YELLOWJACKET', 'RADIO', 'QQ']) {
      const r = solveVigenere(encipherVigenere(PT, key));
      assert.ok(r.ok, `${key}: z ${r.z}`);
      // A key of QQ has period 1, and reporting Q is the better answer.
      const want = key === 'QQ' ? 'Q' : key;
      assert.equal(r.key, want, `key ${key} came back as ${r.key}`);
      assert.equal(r.plaintext, PT.replace(/[^A-Z]/g, ''));
    }
  },

  function theKeyLengthShowsInTheIndexOfCoincidence() {
    const profile = keyLengthProfile(letters(encipherVigenere(LONG, 'YELLOWJ')));
    const seven = profile.find((p) => p.length === 7);
    const six = profile.find((p) => p.length === 6);
    assert.ok(seven.ic > six.ic + 0.008, `period 7 (${seven.ic}) should stand above 6 (${six.ic})`);
    assert.ok(seven.ic > 0.055, 'a column of a periodic cipher looks like English');
  },

  function nothingIsSolvedOutOfRandomLetters() {
    // Every solver here was caught doing this during construction. The Caesar
    // null was the other twenty-five shifts, which makes the best of
    // twenty-six look significant by construction; and the Vigenere null ran a
    // weaker search than the attack, which put 200 random letters at z 7.3.
    for (const seed of [9, 21, 404]) {
      for (const n of [200, 600]) {
        const noise = randomLetters(n, seed);
        const r = solveClassical(noise);
        assert.equal(r.ok, false, `${n} random letters (seed ${seed}) "solved" as ${r.best && r.best.cipher} at z ${r.best && r.best.z}`);
        // The measurement behind SOLVED_Z: the worst a wrong key reaches here
        // is 4, every genuine solution above is past 8, and the bar is 5.
        for (const entry of r.ranked) assert.ok(entry.z < 5, `${entry.cipher} reached z ${entry.z} on noise`);
      }
    }
  },

  function theRankingIsByEnglishNotByZ() {
    // A z compares a key against other keys for the SAME cipher. It is not
    // comparable across ciphers, and treating it as though it were produced a
    // real wrong answer: on a Vigenere message the transposition solver
    // reached z 9.8 against the Vigenere solver's 9.4, because its own null
    // happened to have a tighter spread — while its "plaintext" scored -5.13,
    // which is shuffled-letters territory.
    const ct = encipherVigenere('THEBENCHMEASURESEVERYTHINGANDTHENREFUSESTOGUESSABENCHTHATREADSCONFIDENTTRAFFICOUTOFHISSISWORSETHANONETHATREADSNOTHINGATALL', 'RADIO');
    const r = solveClassical(ct);
    assert.equal(r.best.cipher, 'vigenere', `ranked ${JSON.stringify(r.ranked)}`);
    assert.equal(r.best.key, 'RADIO');
    assert.ok(r.best.plaintext.startsWith('THEBENCHMEASURES'));
    const trans = r.ranked.find((x) => x.cipher === 'transposition');
    assert.ok(trans.z > 5, 'the transposition solver still beats its own null');
    assert.equal(trans.ok, false, 'but its output is not English, so it is not a solution');
    assert.ok(trans.score < r.englishBar, `${trans.score} must be under the English bar ${r.englishBar}`);
  },

  function aMessageTooShortToBreakSaysSo() {
    assert.match(solveSubstitution('ABCDEFGHIJ').reason, /too few/);
    assert.match(solveVigenere('ABCDEFGH').reason, /too few/);
    assert.match(solveTransposition('ABCDEFGH').reason, /too few/);
    assert.match(solveCaesar('ABC').reason, /too few/);
  },

  // ------------------------------------------------------------- Enigma

  function theMachineMatchesKnownEnigmaBehaviour() {
    // The standard test vector: rotors I II III, reflector B, rings AAA,
    // positions AAA, no plugboard. Twenty-five A's must come out exactly this.
    const m = new Enigma({ rotors: ['I', 'II', 'III'], reflector: 'B', rings: [0, 0, 0], positions: [0, 0, 0] });
    assert.equal(m.encode('A'.repeat(25)), 'BDZGOWCXLTKSBTMCDLPBMUQOF');
    // It is its own inverse, and no letter is ever itself — the property that
    // gave Bletchley its cribs.
    const setting = { rotors: ['IV', 'II', 'V'], reflector: 'B', rings: [3, 7, 11], positions: [5, 9, 21], plugboard: 'AB CD EF GH IJ' };
    const ct = new Enigma(setting).encode(PT);
    assert.equal(new Enigma(setting).encode(ct), PT);
    for (let i = 0; i < PT.length; i++) assert.notEqual(PT[i], ct[i], `letter ${i} encoded to itself`);
    // The double step: from ADU the middle wheel moves twice in a row.
    const d = new Enigma({ rotors: ['I', 'II', 'III'], reflector: 'B', positions: [0, 3, 20] });
    const seen = [];
    for (let i = 0; i < 4; i++) { d.encodeCode(0); seen.push(Array.from(d.positions, (v) => String.fromCharCode(65 + v)).join('')); }
    assert.deepEqual(seen, ['ADV', 'AEW', 'BFX', 'BFY']);
    assert.equal(Object.keys(ROTORS).length, 8);
    assert.equal(Object.keys(REFLECTORS).length, 2);
    // A letter may take only one plug.
    assert.throws(() => new Enigma({ plugboard: 'AB AC' }), /only one plug/);
  },

  function theIndexOfCoincidenceFindsTheRotorsThroughThePlugboard() {
    // The reason the machine falls: a plugboard is a substitution, and a
    // substitution does not change how often two letters match. So the right
    // rotor order and start positions lift the index of coincidence even
    // while every plug is still unknown.
    const ct = new Enigma({ rotors: ['II', 'V', 'III'], reflector: 'B', positions: [7, 19, 2], plugboard: 'AR GK OX' }).encode(LONG.slice(0, 300));
    const top = searchRotors(letters(ct), { set: ['I', 'II', 'III', 'V'], keep: 5 });
    assert.deepEqual(top[0].rotors, ['II', 'V', 'III'], 'the right wheels should win the sweep');
    assert.deepEqual(top[0].positions, [7, 19, 2]);
    // Measured: with three plugs on 300 letters the winner sits at 0.0602 and
    // the runner-up at 0.0564. The margin is small because the plugboard costs
    // the index of coincidence some of its lift, which is exactly why the
    // search keeps several candidates and lets the trigram model choose.
    assert.ok(top[0].ic > top[1].ic + 0.002, `the winner ${top[0].ic.toFixed(4)} must stand clear of ${top[1].ic.toFixed(4)}`);
  },

  function aMessageWithoutAPlugboardIsBrokenExactly() {
    const pt = LONG.slice(0, 200);
    const ct = new Enigma({ rotors: ['II', 'V', 'III'], reflector: 'B', positions: [7, 19, 2] }).encode(pt);
    const r = breakEnigma(ct, { set: ['I', 'II', 'III', 'V'], maxPlugs: 0, nulls: 2, keep: 5 });
    assert.ok(r.ok, r.reason || `z ${r.z}`);
    assert.equal(r.plaintext, pt);
    assert.deepEqual(r.setting.rotors, ['II', 'V', 'III']);
    assert.equal(r.setting.positions, 'HTC');
    assert.equal(r.setting.plugboard, '');
    assert.ok(r.z > 10, `z ${r.z}`);
    assert.equal(r.weakSpans.length, 0, 'a clean decrypt has no unreadable stretch');
    assert.equal(r.caution, null);
  },

  function thePlugboardIsRecoveredOnePairAtATime() {
    const pt = LONG.slice(0, 360);
    const ct = new Enigma({ rotors: ['II', 'V', 'III'], reflector: 'B', positions: [7, 19, 2], plugboard: 'AR GK OX' }).encode(pt);
    const r = breakEnigma(ct, { set: ['I', 'II', 'III', 'V'], maxPlugs: 5, nulls: 2, keep: 20 });
    assert.ok(r.ok, r.reason || `z ${r.z}`);
    assert.equal(r.plaintext, pt);
    const pairs = r.setting.plugboard.split(' ').filter(Boolean).map((p) => p.split('').sort().join('')).sort();
    assert.deepEqual(pairs, ['AR', 'GK', 'KO'.split('').sort().join('') === 'KO' ? 'OX' : 'OX'].sort(), `plugboard ${r.setting.plugboard}`);
  },

  function aPartlyWrongDecryptSaysWhichLettersAreWrong() {
    // A middle ring setting one step off gives a machine identical to the
    // truth until the middle rotor turns over, then wrong until it
    // re-synchronises: the message comes back mostly right with a corrupted
    // stretch, which is the worst kind of wrong to hand over silently.
    // Measured on a 360-letter message with five plugs, one such run cost 25
    // letters from position 125 and the rest was exact.
    const pt = LONG.slice(0, 300);
    const damaged = pt.slice(0, 120) + randomLetters(40, 31) + pt.slice(160);
    const spans = weakSpans(letters(damaged));
    assert.ok(spans.length >= 1, 'the corrupted stretch must be found');
    const hit = spans.find((s) => s.at <= 130 && s.at + s.length >= 140);
    assert.ok(hit, `spans ${JSON.stringify(spans)} should cover the damage at 120-160`);
    // And a correct decrypt is not accused of anything.
    assert.equal(weakSpans(letters(pt)).length, 0);
  },

  function enigmaRefusesWhatItCannotBreak() {
    // Random letters are not an Enigma message, and 200 of them must not come
    // back as one.
    const r = breakEnigma(randomLetters(200, 77), { set: ['I', 'II', 'III'], maxPlugs: 0, nulls: 2, keep: 3 });
    assert.equal(r.ok, false, `noise "broke" at z ${r.z}: ${r.plaintext.slice(0, 40)}`);
    // And a message too short to separate rotor orders says so rather than
    // returning the best of a million wrong answers.
    assert.match(breakEnigma('SHORT').reason, /too few/);
  },

  // ---------------------------------------------------- is it breakable at all

  function aOneTimePadIsCalledUnbreakableAndSaysWhy() {
    for (const seed of [42, 3, 77, 1234]) {
      const a = assess(randomDigits(500, seed));
      assert.ok(a.ok, a.reason);
      assert.equal(a.breakable, false, `pad seed ${seed} was called breakable: ${a.findings.map((f) => f.test).join(',')}`);
      assert.match(a.verdict, /no unique solution|equally consistent/);
      // And it does not overclaim: it says what it would have caught.
      assert.match(a.verdict, /What this does NOT say/);
      assert.ok(a.sensitivity.icDetectableShift > 0);
    }
    // Letters too.
    assert.equal(assess(randomLetters(600, 5)).breakable, false);
  },

  function aRepeatingKeyIsCaughtAndItsPeriodNamed() {
    for (const [key, period] of [['YELLOWJ', 7], ['RADIOS', 6], ['AB', 2]]) {
      const a = assess(encipherVigenere(LONG, key));
      assert.equal(a.breakable, true, `${key} was not caught`);
      const kas = a.findings.find((f) => f.test === 'Kasiski');
      assert.ok(kas, `${key}: no Kasiski finding`);
      assert.equal(a.kasiski.topFactors[0].factor, period, `${key}: period read as ${a.kasiski.topFactors[0].factor}`);
    }
  },

  function aReusedCodeGroupIsCaught() {
    // A code book reuses its groups; a pad never repeats one.
    const r = rng(7);
    const book = Array.from({ length: 12 }, () => Array.from({ length: 5 }, () => Math.floor(r() * 10)).join(''));
    let coded = '';
    for (let i = 0; i < 100; i++) coded += book[Math.floor(r() * book.length)];
    const a = assess(coded);
    assert.equal(a.breakable, true);
    const groups = a.findings.find((f) => f.test === 'repeated groups');
    assert.ok(groups, a.findings.map((f) => f.test).join(','));
    assert.match(groups.means, /a code book reuses its groups/);
  },

  function theKasiskiTestHasItsOwnNull() {
    // Three-digit strings repeat constantly in 500 digits by chance — a
    // thousand possibilities against 125,000 pairs of positions — so a test
    // without a null marks every pad breakable, which this one did.
    const pad = symbols(randomDigits(500, 42), DIGITS);
    const k = kasiski(pad, { k: 10 });
    assert.ok(k.minLength >= 5, `three-digit repeats are worthless here; the shortest useful length is ${k.minLength}`);
    assert.ok(k.expectedByChance < 1, `expected ${k.expectedByChance} repeats by chance`);
    assert.ok(k.repeats <= 2, `${k.repeats} repeats in a pad`);
  },

  function shortMessagesAreRefusedRatherThanJudged() {
    const a = assess('12345678901234567890');
    assert.equal(a.ok, false);
    assert.match(a.reason, /too few to test/);
    assert.equal(assess('').ok, false);
    assert.equal(alphabetOf('12345').name, 'digits');
    assert.equal(alphabetOf('ABCDE').name, 'letters');
    assert.equal(alphabetOf('!!!'), null);
  },

  function theIndexOfCoincidenceCarriesItsOwnErrorBar() {
    // The point of reporting the standard error: on a short message an IC that
    // looks wrong is not.
    const short = ic(symbols(randomDigits(60, 3), DIGITS), 10);
    const long = ic(symbols(randomDigits(2000, 3), DIGITS), 10);
    assert.ok(short.se > long.se * 3, `${short.se} against ${long.se}: a short message knows less`);
    assert.ok(Math.abs(long.z) < 4, `a pad should not be far from its expectation: z ${long.z}`);
    const plain = ic(letters(LONG), 26);
    assert.ok(plain.z > 20, `English is far above uniform: z ${plain.z}`);
  },
];
