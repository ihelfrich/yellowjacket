// The portable score file: hertz and unbounded time survive a round trip through JSON.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScore, addPart, addNote, addMarker, scoreToJson, scoreFromJson, cardFingerprint, SCORE_FORMAT } from '../js/score/model.js';
import { retuneDelta, applyRetune } from '../js/instrument/tuning.js';
import * as movement3 from '../js/score/symphony/movement-3.js';

const card = (id) => JSON.parse(readFileSync(new URL('../docs/lab/cards/' + id + '.json', import.meta.url), 'utf8'));

// iowa-bells-brass-Cs5 is a real measured card that is NOT one of the ten found
// cards, so it exercises the embedded path.
function embeddedScore() {
  const score = createScore({ title: 'round trip', sampleRate: 44100 });
  const part = addPart(score, { id: 'brass', card: card('iowa-bells-brass-Cs5'), excitation: 'strike', pan: -0.35, rmsDb: -18.5, gainDb: 1.25, params: { spread: 0.5 } });
  addNote(part, { t: 0, hz: 554.365, velocity: 0.9, seconds: 1.5 });
  addNote(part, { t: 1.234567, hz: 831.609, velocity: 0.42, seconds: 0.75 });
  const quiet = addPart(score, { id: 'quiet', card: card('iowa-bells-brass-Cs5'), excitation: 'bow', pan: 1, rmsDb: null, gainDb: 0 });
  addNote(quiet, { t: 3, hz: 220.5, velocity: 0.05, seconds: 2 });
  return score;
}

export const NAME = 'score file';
export const cases = [
  async function embeddedCardRoundTripsExactly() {
    const score = embeddedScore();
    const json = JSON.parse(JSON.stringify(scoreToJson(score)));
    assert.equal(json.format, SCORE_FORMAT);
    assert.deepEqual(json.parts[0].card, card('iowa-bells-brass-Cs5'), 'a card off the found list is embedded whole');
    assert.deepEqual(scoreFromJson(json), score, 'the score comes back identical');
  },

  async function nonTwelveTetPitchesSurvive() {
    const score = createScore({ title: 'own scale' });
    const part = addPart(score, { id: 'buzzer', card: card('uvb76-buzz'), excitation: 'bow' });
    addNote(part, { t: 0, hz: 354.8637, velocity: 0.8, seconds: 1 });
    const back = scoreFromJson(scoreToJson(score), { cards: { 'uvb76-buzz': card('uvb76-buzz') } });
    assert.equal(back.parts[0].notes[0].hz, 354.864, 'hertz, not a semitone');
  },

  async function foundCardBecomesARefAndResolves() {
    const thud = card('opz-thud');
    const score = createScore({ title: 'ref' });
    addNote(addPart(score, { id: 'thud', card: thud, excitation: 'strike' }), { t: 0.5, hz: 182, velocity: 0.8, seconds: 0.25 });
    const json = scoreToJson(score);
    assert.deepEqual(json.parts[0].card, { ref: 'opz-thud' }, 'one of the ten found cards is a reference');
    assert.ok(JSON.stringify(json).length < 1000, 'a ref keeps the file small');
    const back = scoreFromJson(json, { cards: { 'opz-thud': thud } });
    assert.deepEqual(back.parts[0].card, thud);
    assert.throws(() => scoreFromJson(json), /opz-thud/, 'an unresolvable ref names the card');
  },

  async function markersAndPartFieldsSurvive() {
    const score = embeddedScore();
    addMarker(score, 2.5, 'Trio');
    const back = scoreFromJson(scoreToJson(score));
    assert.deepEqual(back.markers, [{ t: 2.5, label: 'Trio' }]);
    assert.equal(back.parts[0].gainDb, 1.25);
    assert.deepEqual(back.parts[0].params, { spread: 0.5 });
    assert.equal(back.parts[1].rmsDb, null, "null rmsDb is not replaced by the default level");
    assert.equal(back.parts[1].excitation, 'bow');
    assert.equal(back.parts[1].pan, 1);
  },

  async function roundingIsSixDecimalsOfTimeAndThreeOfHertz() {
    const score = createScore({ title: 'rounding' });
    addNote(addPart(score, { id: 'p', card: card('uvb76-buzz') }), { t: 1 / 3, hz: 1000 / 7, velocity: 1 / 3, seconds: 1 / 7 });
    const n = scoreToJson(score).parts[0].notes[0];
    assert.deepEqual(n, { t: 0.333333, hz: 142.857, velocity: 0.3333, seconds: 0.142857 });
  },

  async function aRetunedFoundCardIsEmbeddedNotReferenced() {
    // js/instrument/tuning.js applyRetune returns { ...card, modes: <shifted> }:
    // the same id, different measured pitches. Keyed on the id, a retuned
    // carillon bell serialised as { ref: 'carillon-bell' } and came back with
    // mode 2 at 2512.601 Hz where it left at 2623.810 — 75 cents, the exact loss
    // this format exists to prevent.
    const bell = card('carillon-bell');
    const tuned = applyRetune(bell, retuneDelta(bell, 'just'));
    assert.equal(tuned.id, bell.id, 'a retune keeps the id it was measured under');
    assert.notEqual(tuned.modes[1].freqHz, bell.modes[1].freqHz, 'and moves the pitches');
    assert.notEqual(cardFingerprint(tuned), cardFingerprint(bell), 'the sounding fingerprint is what changes');

    const plain = createScore({ title: 'as found' });
    addNote(addPart(plain, { id: 'bell', card: bell }), { t: 0, hz: 400, velocity: 0.8, seconds: 1 });
    assert.deepEqual(scoreToJson(plain).parts[0].card, { ref: 'carillon-bell' }, 'the card as measured is still a reference');

    const score = createScore({ title: 'retuned' });
    addNote(addPart(score, { id: 'bell', card: tuned }), { t: 0, hz: 400, velocity: 0.8, seconds: 1 });
    const json = JSON.parse(JSON.stringify(scoreToJson(score)));
    assert.equal(json.parts[0].card.ref, undefined, 'a retuned card is not a reference');
    assert.deepEqual(json.parts[0].card, tuned, 'it is embedded whole, delta and all');
    const back = scoreFromJson(json, { cards: { 'carillon-bell': bell } });
    assert.equal(back.parts[0].card.modes[1].freqHz, tuned.modes[1].freqHz, 'and comes back at the pitch it left at');
    assert.deepEqual(back.parts[0].card.retune, tuned.retune);
  },

  async function theFileDoesNotAliasTheLiveScore() {
    const score = embeddedScore();
    const json = scoreToJson(score);
    assert.notEqual(json.parts[0].card, score.parts[0].card, 'a plain JSON-safe object is not the live card');
    json.parts[0].card.modes[0].freqHz = 1;
    json.parts[0].card.family = 'edited';
    assert.notEqual(score.parts[0].card.modes[0].freqHz, 1, 'editing the file does not edit the score');
    assert.notEqual(score.parts[0].card.family, 'edited');
    assert.deepEqual(score.parts[0].card, card('iowa-bells-brass-Cs5'), 'the live card is what it was measured as');
    assert.notEqual(json.parts[0].notes[0], score.parts[0].notes[0]);
    assert.notEqual(json.parts[0].params, score.parts[0].params);
  },

  async function presentButUnusableValuesThrowByPartAndNote() {
    // The rule: a field the file leaves out may take the model's default, but a
    // field it carries must be a finite number. `velocity: null` read as 0.05
    // (near-silent) and a missing `seconds` as 0.5 are exactly the silent
    // substitutions the format's own contract says it does not make.
    const one = card('uvb76-buzz');
    const notes = (n) => ({ format: SCORE_FORMAT, parts: [{ id: 'p', card: one, notes: [n] }] });
    const part = (p) => ({ format: SCORE_FORMAT, parts: [{ id: 'p', card: one, notes: [], ...p }] });
    const good = { t: 0, hz: 400, velocity: 0.8, seconds: 1 };

    assert.throws(() => scoreFromJson(notes({ ...good, velocity: null })), /part p note 1 velocity is null, not a number/);
    assert.throws(() => scoreFromJson(notes({ ...good, seconds: undefined })), /part p note 1 seconds is missing/);
    assert.throws(() => scoreFromJson(notes({ ...good, t: undefined })), /part p note 1 t is missing/);
    assert.throws(() => scoreFromJson(notes({ ...good, t: null })), /part p note 1 t is null, not a number/);
    assert.throws(() => scoreFromJson(notes({ ...good, hz: '400' })), /part p note 1 hz is "400", not a number/);
    assert.throws(() => scoreFromJson(notes({ ...good, seconds: 0 / 0 })), /part p note 1 seconds is NaN, not a number/);
    assert.throws(() => scoreFromJson(notes({ ...good, t: Infinity })), /part p note 1 t is Infinity, not a number/);
    assert.throws(() => scoreFromJson(notes(null)), /part p note 1 is not an object/);
    assert.throws(() => scoreFromJson(notes({ ...good, t: -0.5 })), /part p note 1 t is -0.5, before the piece starts/);
    assert.throws(() => scoreFromJson(notes({ ...good, seconds: 0 })), /part p note 1 seconds is 0, not a length/);
    assert.throws(() => scoreFromJson(notes({ ...good, velocity: 2 })), /part p note 1 velocity is 2, outside 0.05..1/);
    assert.throws(() => scoreFromJson(part({ pan: 'x' })), /part p pan is "x", not a number/);
    assert.throws(() => scoreFromJson(part({ pan: 4 })), /part p pan is 4, outside −1..1/);
    assert.throws(() => scoreFromJson(part({ rmsDb: 'loud' })), /part p rmsDb is "loud", not a number/);
    assert.throws(() => scoreFromJson(part({ gainDb: null })), /part p gainDb is null, not a number/);
    assert.throws(() => scoreFromJson(part({ excitation: 'nope' })), /part p speaks "nope"/);
    assert.throws(() => scoreFromJson({ format: SCORE_FORMAT, parts: [], markers: [{ label: 'x' }] }), /marker 1 t is missing/);

    // and what the rule allows: an absent optional field still defaults, and a
    // null rmsDb still means "leave the physics' level".
    const soft = scoreFromJson(notes({ t: 0, hz: 400, seconds: 1 })).parts[0].notes[0];
    assert.equal(soft.velocity, 0.8, 'an absent velocity is the model default, not a throw');
    const level = scoreFromJson(part({ rmsDb: null })).parts[0];
    assert.equal(level.rmsDb, null);
    assert.equal(scoreFromJson(part({})).parts[0].rmsDb, -20, 'an absent rmsDb is the default level');
  },

  async function structuralGapsThrowByName() {
    assert.throws(() => scoreFromJson(null), /must be a JSON object/);
    assert.throws(() => scoreFromJson([]), /must be a JSON object/);
    assert.throws(() => scoreFromJson({ parts: [] }), /yj-score-1/, 'a missing format is refused');
    assert.throws(() => scoreFromJson({ format: 'yj-score-2', parts: [] }), /yj-score-2/);
    assert.throws(() => scoreFromJson({ format: SCORE_FORMAT }), /parts array/);
    assert.throws(() => scoreFromJson({ format: SCORE_FORMAT, parts: [{ id: 'lonely', notes: [] }] }), /part lonely has no card/);
    const one = card('uvb76-buzz');
    assert.throws(() => scoreFromJson({ format: SCORE_FORMAT, parts: [{ id: 'p', card: one, notes: [{ t: 0, seconds: 1 }] }] }), /part p note 1 has no hz/);
    // notes present but not a list threw a bare TypeError out of Array.forEach,
    // the one message in this function that named neither the part nor the field
    assert.throws(() => scoreFromJson({ format: SCORE_FORMAT, parts: [{ id: 'p', card: one, notes: 'oops' }] }), /part p notes is "oops", not an array/);
    assert.throws(() => scoreFromJson({ format: SCORE_FORMAT, parts: [{ id: 'p', card: one, notes: { t: 0 } }] }), /part p notes is \{"t":0\}, not an array/);
  },

  async function theScoresOwnRateIsANumberLikeEveryOtherNumberInTheFile() {
    // sampleRate went straight to createScore unchecked, and renderScore reads
    // `score.sampleRate || 48000`, so a file saying '48k' or null was written to
    // 48 k without a word — the substitution the per-note rule refuses, one
    // level up. Absent still means the model's default.
    for (const bad of ['48k', null, [48000]]) {
      assert.throws(() => scoreFromJson({ format: SCORE_FORMAT, sampleRate: bad, parts: [] }), /sampleRate is .*, not a number/, JSON.stringify(bad));
    }
    assert.throws(() => scoreFromJson({ format: SCORE_FORMAT, sampleRate: 0, parts: [] }), /sampleRate is 0, not a rate/);
    assert.throws(() => scoreFromJson({ format: SCORE_FORMAT, sampleRate: -48000, parts: [] }), /sampleRate is -48000, not a rate/);
    assert.equal(scoreFromJson({ format: SCORE_FORMAT, parts: [] }).sampleRate, 48000, 'a rate the file leaves out takes the default');
    assert.equal(scoreFromJson({ format: SCORE_FORMAT, sampleRate: 44100, parts: [] }).sampleRate, 44100);
  },

  async function aFingerprintFollowsTheCardItIsAskedAbout() {
    // The fingerprint was memoised in a WeakMap on the card object, so an
    // in-place edit — the shape applyRetune avoids and a hand edit does not —
    // kept answering for the card as it was first seen. That is the retuned-card
    // defect above with a step in front of it: the stale print still matches
    // FOUND_CARD_REFS, so the edited card serialises as { ref } and comes back
    // at the pitch it was measured at, not the pitch it was edited to.
    const thud = card('opz-thud');
    const before = cardFingerprint(thud);
    assert.equal(before, 'a79414c3928aff49', 'the print opz-thud is referenced under');
    thud.modes[0].freqHz *= 2;
    const after = cardFingerprint(thud);
    assert.notEqual(after, before, 'an octave up is a different sounding identity: ' + after);
    assert.equal(after, cardFingerprint(JSON.parse(JSON.stringify(thud))), 'and the same one a copy of the edited card has');
    const score = createScore({ title: 'edited in place' });
    addNote(addPart(score, { id: 'thud', card: thud }), { t: 0, hz: 200, velocity: 0.8, seconds: 0.5 });
    assert.equal(scoreToJson(score).parts[0].card.ref, undefined, 'so the edited card is embedded, not referenced back at 1x');
  },

  async function theCommandLineRendersBothDialectsToTheSameAudio() {
    // scripts/render-score.mjs reads two shapes: the tagged yj-score-1 file,
    // where a found card is { ref }, and the older untagged one, where a card is
    // a path relative to the file. One note of one card either way — the same
    // note, so the two WAVs must come out byte for byte the same.
    const dir = mkdtempSync(join(tmpdir(), 'yj-score-'));
    const script = fileURLToPath(new URL('../scripts/render-score.mjs', import.meta.url));
    const thud = card('opz-thud');
    const note = { t: 0.25, hz: 182.5, velocity: 0.7, seconds: 0.2 };

    const tagged = createScore({ title: 'cli tagged', sampleRate: 48000 });
    addNote(addPart(tagged, { id: 'thud', card: thud, excitation: 'strike', pan: -0.25, rmsDb: -20 }), note);
    const taggedJson = scoreToJson(tagged);
    assert.deepEqual(taggedJson.parts[0].card, { ref: 'opz-thud' }, 'the tagged file carries a reference, not a card');
    writeFileSync(join(dir, 'tagged.json'), JSON.stringify(taggedJson));

    writeFileSync(join(dir, 'legacy.json'), JSON.stringify({
      title: 'cli legacy', sampleRate: 48000,
      parts: [{ id: 'thud', card: fileURLToPath(new URL('../docs/lab/cards/opz-thud.json', import.meta.url)), excitation: 'strike', pan: -0.25, rmsDb: -20, notes: [note] }],
    }));

    // stdio 'pipe' on stderr as well: the negative cases below make the script
    // die on purpose, and execFileSync otherwise echoes each child's stack trace
    // into the suite's own stderr, so a fully passing run printed four fatal-looking
    // traces.
    const run = (name) => execFileSync(process.execPath, [script, join(dir, name + '.json'), join(dir, name + '.wav')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const taggedOut = run('tagged'), legacyOut = run('legacy');
    assert.match(taggedOut, /cli tagged: 1 parts, 1 notes, 0\.5 s/, taggedOut);
    assert.match(legacyOut, /cli legacy: 1 parts, 1 notes, 0\.5 s/, legacyOut);
    for (const out of [taggedOut, legacyOut]) {
      assert.match(out, /thud +measured -?\d+\.\d dB RMS · gain -?\d+\.\d dB/, out);
      assert.match(out, /\.wav · 4\.5 s · /, 'the note plus renderScore\'s four-second tail: ' + out);
    }

    const a = readFileSync(join(dir, 'tagged.wav')), b = readFileSync(join(dir, 'legacy.wav'));
    assert.equal(a.toString('latin1', 0, 4), 'RIFF');
    assert.equal(a.toString('latin1', 8, 12), 'WAVE');
    assert.equal(a.readUInt16LE(22), 2, 'stereo');
    assert.equal(a.readUInt32LE(24), 48000, "the score's own rate, not the truth rate");
    assert.equal(a.readUInt16LE(34), 24, '24-bit');
    // the note's end plus renderScore's four-second tail, at the score's rate
    const frames = Math.round((note.t + note.seconds + 4) * 48000);
    assert.equal(a.length, 44 + frames * 2 * 3, 'a 44-byte header plus ' + frames + ' stereo 24-bit frames: ' + a.length);
    assert.ok(a.equals(b), 'both dialects render the same note to the same samples');
    // and the audio is not silence
    let peak = 0;
    for (let i = 44; i + 3 <= a.length; i += 3) peak = Math.max(peak, Math.abs((a.readIntLE(i, 3)) / 8388608));
    assert.ok(peak > 0.01, 'the card actually sounded: peak ' + peak.toFixed(3));

    // A `midi` note is the one thing the untagged shape carries that yj-score-1
    // does not; it still reads, at the pitch hzOfMidi gives.
    writeFileSync(join(dir, 'midi-note.json'), JSON.stringify({
      title: 'cli midi', sampleRate: 48000,
      parts: [{ id: 'thud', card: fileURLToPath(new URL('../docs/lab/cards/opz-thud.json', import.meta.url)), excitation: 'strike', pan: -0.25, rmsDb: -20, notes: [{ t: 0.25, midi: 53.4, velocity: 0.7, seconds: 0.2 }] }],
    }));
    assert.match(run('midi-note'), /cli midi: 1 parts, 1 notes, 0\.5 s/);

    // Deleting a file's `format` key used to buy it a reader with no checks at
    // all: this file rendered without a word as strike, hard right and 0.05
    // velocity. Both dialects go through scoreFromJson now, so it is refused by
    // the same message either way.
    const corrupt = {
      title: 'cli corrupt', sampleRate: 48000,
      parts: [{ id: 'bell', card: fileURLToPath(new URL('../docs/lab/cards/opz-thud.json', import.meta.url)), excitation: 'nope', pan: 40, rmsDb: -20, notes: [{ t: 0, midi: 60, velocity: null }] }],
    };
    writeFileSync(join(dir, 'corrupt.json'), JSON.stringify(corrupt));
    assert.throws(() => run('corrupt'), (e) => /part bell speaks "nope"/.test(String(e.stderr)), 'the untagged shape is validated too');
    const clean = { ...corrupt.parts[0], excitation: 'strike', pan: 0, notes: [{ t: 0, midi: 60, velocity: 0.7, seconds: 0.2 }] };
    const each = [
      ['pan is 40', { ...clean, pan: 40 }],
      ['velocity is null', { ...clean, notes: [{ ...clean.notes[0], velocity: null }] }],
      ['seconds is missing', { ...clean, notes: [{ t: 0, midi: 60, velocity: 0.7 }] }],
    ];
    for (const [message, part] of each) {
      writeFileSync(join(dir, 'corrupt.json'), JSON.stringify({ ...corrupt, parts: [part] }));
      assert.throws(() => run('corrupt'), (e) => new RegExp(message).test(String(e.stderr)), message + ' — stderr said nothing about it');
    }
    // and the same file with nothing wrong with it still renders
    writeFileSync(join(dir, 'corrupt.json'), JSON.stringify({ ...corrupt, parts: [clean] }));
    assert.match(run('corrupt'), /cli corrupt: 1 parts, 1 notes/);
  },

  async function movementThreeSurvivesTheRoundTrip() {
    const ids = ['iowa-bells-plastic-ff-A5', 'iowa-bells-plastic-ff-E5', 'iowa-bells-plastic-ff-Cs5', 'uvb76-buzz', 'fdr-vowel', 'hiawatha-vowel', 'wwv-tone', 'opz-thud', 'commons-bell-15cm'];
    const cards = {};
    for (const id of ids) cards[id] = card(id);
    const score = movement3.movement({ cards });
    const back = scoreFromJson(JSON.parse(JSON.stringify(scoreToJson(score))), { cards });
    assert.equal(back.parts.length, movement3.FACTS.parts);
    const counted = Object.fromEntries(back.parts.map((p) => [p.id, p.notes.length]));
    assert.deepEqual(counted, movement3.FACTS.notes, 'every note of every part is carried');
    for (const p of score.parts) {
      const got = back.parts.find((q) => q.id === p.id);
      assert.equal(got.notes[0].t, Math.round(p.notes[0].t * 1e6) / 1e6, p.id + ' first onset');
      assert.equal(got.notes.at(-1).t, Math.round(p.notes.at(-1).t * 1e6) / 1e6, p.id + ' last onset');
    }
    assert.equal(back.markers.length, score.markers.length);
  },
  async function theLastTwoSilentSubstitutionsThrowToo() {
    const thud = card('opz-thud');
    const doc = (extra, part = {}) => ({
      format: SCORE_FORMAT, title: 't', sampleRate: 48000,
      parts: [{ id: 'p', card: thud, excitation: 'strike', notes: [{ t: 0, hz: 200, seconds: 0.2 }], ...part }],
      ...extra,
    });
    // A markers field that is present but unusable used to vanish silently.
    assert.throws(() => scoreFromJson(doc({ markers: 'oops' })), /markers is "oops", not an array/);
    assert.throws(() => scoreFromJson(doc({ markers: 42 })), /markers is 42, not an array/);
    // params reaches the physics untouched, so a null in one is garbage the
    // renderer would read as a number.
    assert.throws(() => scoreFromJson(doc({}, { params: { hardness: null } })), /params\.hardness is null, not a number/);
    assert.throws(() => scoreFromJson(doc({}, { params: { hardness: '0.9' } })), /params\.hardness is "0\.9", a number written as a string/);
    assert.throws(() => scoreFromJson(doc({}, { params: 'oops' })), /params is "oops", not an object/);
    // and what stays legal
    assert.equal(scoreFromJson(doc({}, { params: { hardness: 0.9, mode: 'soft', on: true } })).parts[0].params.hardness, 0.9);
    assert.deepEqual(scoreFromJson(doc({})).markers, []);
  },
];
