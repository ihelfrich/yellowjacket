// A STUDIO step carries its own cents: what sounds, what survives a save, and
// what the roll prints — including two degrees of one card that share a semitone.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  applyCardInstrument, applyCustomScale, applyStudioSnapshot, clampCents, createStudio, dedupeScaleIntervals,
  generateStudioIdea, normalizeStep, restoreCustomScale, scaleCents, scaleIntervalsLabel, scaleNote, scaleSpec,
  stepCents, stepIsOnGrid, stepLabel, stepPitch, studioStepSeconds, SCALE_DEGREE_CENTS, STEP_CENTS_LIMIT,
} from '../js/studio/model.js';
import { StudioEngine } from '../js/studio/engine.js';
import { cardNoteKey } from '../js/studio/card-voice.js';
import { compileStudioScore } from '../js/studio/compile.js';
import { initStudioController } from '../js/studio/controller.js';
import { stepMatchesPalette } from '../js/studio/view.js';
import { cardScale, cardScaleIntervals, cardSummary, scaleLine } from '../js/app/instrument-controller.js';
import { createProject } from '../js/app/project-store.js';
import { serializeProject, applySnapshot } from '../js/app/persist.js';

const hz = (semitones) => 440 * Math.pow(2, (semitones - 69) / 12);

// Enough of a WebAudio graph for one bounce: every scheduled oscillator
// frequency is recorded, and card notes are answered from a stub cache that
// records the pitch it was asked for instead of running the physics.
function stubCtx(freqs) {
  const node = () => ({
    connect(to) { return to; }, disconnect() {}, start() {}, stop() {},
    gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {}, setTargetAtTime() {} },
    pan: { value: 0, setValueAtTime() {} },
    frequency: { value: 0, setValueAtTime() {} },
    detune: { value: 0, setValueAtTime() {} },
    delayTime: { value: 0 }, Q: { value: 0, setValueAtTime() {} },
    threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 },
    attack: { value: 0 }, release: { value: 0 },
    type: '', buffer: null, normalize: true,
  });
  const oscillator = () => {
    const n = node();
    n.frequency = { value: 0, setValueAtTime(v) { freqs.push(v); } };
    return n;
  };
  return {
    sampleRate: 48000, currentTime: 0, destination: node(),
    createGain: node, createStereoPanner: node, createBufferSource: node,
    createBiquadFilter: node, createConvolver: node, createDelay: node,
    createOscillator: oscillator, createDynamicsCompressor: node,
    createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
    startRendering: async () => null,
  };
}

// One part, one step, bounced: the frequencies that step asked for.
async function bounce(step, { card = null } = {}) {
  const studio = createStudio();
  for (const track of studio.tracks) { track.mute = true; track.steps.fill(null); }
  const track = studio.tracks[0];
  track.mute = false;
  track.synth.transpose = 0;
  track.steps[0] = step;
  studio.bars = 1;
  const midis = [];
  if (card) {
    applyCardInstrument(track, card, 'strike');
  }
  const freqs = [];
  const prev = globalThis.OfflineAudioContext;
  globalThis.OfflineAudioContext = function () { return stubCtx(freqs); };
  try {
    const engine = new StudioEngine({ wake: () => null, master: null });
    engine.cache = {
      has: () => true,
      render: (c, excitation, midi) => { midis.push(midi); return { samples: new Float32Array(8), sampleRate: 48000, peak: 0.5, seconds: 0.1 }; },
      buffer: () => null,
    };
    engine.setStudio(studio);
    await engine.render();
  } finally {
    globalThis.OfflineAudioContext = prev;
  }
  return { freqs, midis };
}

const CARDS_DIR = new URL('../docs/lab/cards/', import.meta.url);
const labCard = (file) => JSON.parse(readFileSync(new URL(file, CARDS_DIR), 'utf8'));
const labCards = () => readdirSync(CARDS_DIR).sort().map((file) => [file, labCard(file)]);
const brassBell = () => labCard('iowa-bells-brass-Cs5.json');
const buzz = () => labCard('uvb76-buzz.json');

// A cache that answers `has` for what it actually holds. The engine's live tick
// skips any card note the cache is missing, so a stub that always says yes
// hides the very failure a warm keyed on the wrong pitch causes.
function honestCache() {
  const map = new Map();
  const asked = [];
  const put = (card, excitation, midi, velocity, duration) => {
    map.set(cardNoteKey(card, excitation, midi, velocity, duration), true);
    return { samples: new Float32Array(8), sampleRate: 48000, peak: 0.5, seconds: 0.1 };
  };
  return {
    map, asked,
    has: (card, excitation, midi, velocity, duration) => map.has(cardNoteKey(card, excitation, midi, velocity, duration)),
    render: (card, excitation, midi, velocity, duration) => { asked.push(midi); return put(card, excitation, midi, velocity, duration); },
    renderAsync: async (pool, card, excitation, midi, velocity, duration) => put(card, excitation, midi, velocity, duration),
    buffer: () => null,
  };
}

// One card part carrying one step, and nothing else audible.
function cardStudio(step, { card = brassBell(), transpose = 0 } = {}) {
  const studio = createStudio();
  studio.bars = 1;
  for (const track of studio.tracks) { track.mute = true; track.steps.fill(null); }
  const track = studio.tracks[0];
  track.mute = false;
  track.synth.transpose = transpose;
  applyCardInstrument(track, card, 'strike');
  track.steps[0] = step;
  return studio;
}

// The Studio surface with nothing under it: enough store, engine and view for
// initStudioController to wire itself up, and every status line it wrote.
function studioBench(studio, cache) {
  const statuses = [];
  const store = new EventTarget();
  store.project = { studio, loom: null };
  store.runtime = { sampleRate: 48000 };
  store.update = (kind, fn) => { fn(store.project); store.dispatchEvent(new CustomEvent('change', { detail: { kind } })); };
  const studioEngine = new EventTarget();
  Object.assign(studioEngine, { running: false, engine: null, cache, setStudio() {}, start() {}, stop() {}, toggle() {}, preview() {} });
  const view = new EventTarget();
  Object.assign(view, { selectedTrack: 0, setStudio() {}, setPlaying() {}, setStep() {}, setImported() {} });
  const api = {};
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = { addEventListener() {} };
  try {
    initStudioController({ store, studioEngine, views: { studio: view }, status: (text) => statuses.push(text), statusFault: (text) => statuses.push('FAULT · ' + text), $: () => null, api });
  } finally {
    if (had) globalThis.window = prev; else delete globalThis.window;
  }
  return { statuses, view, api, store };
}

const settle = async (turns = 20) => { for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

// One live tick of the sequencer against a real engine: the card pitches it
// actually asked the cache to render. The graph is built off a preview on a
// synth part, so nothing but the tick touches the card.
function liveTick(studio, cache) {
  const ctx = stubCtx([]);
  const engine = new StudioEngine({ wake: () => ctx, master: ctx.destination });
  engine.cache = cache;
  engine.setStudio(studio);
  engine.preview(1, 60, 'single', 0.5);
  const before = cache.asked.length;
  engine._scheduleStep(0, 0);
  return cache.asked.slice(before);
}

export const NAME = 'studio cents';
export const cases = [
  async function centsMoveTheSoundingFrequency() {
    const { freqs } = await bounce(normalizeStep({ note: 64, chord: 'single', velocity: 0.8, gate: 1, cents: 38 }));
    assert.ok(freqs.length >= 2, 'two oscillators per voice: ' + freqs.length);
    for (const f of freqs) assert.equal(f, hz(64.38), 'note 64 + 38 cents');
    assert.ok(Math.abs(freqs[0] / hz(64) - Math.pow(2, 38 / 1200)) < 1e-12, 'exactly 38 cents above E4');
  },
  async function absentOrZeroCentsIsTheOldFrequencyToTheBit() {
    const plain = await bounce(normalizeStep({ note: 64, chord: 'single', velocity: 0.8, gate: 1 }));
    const zero = await bounce(normalizeStep({ note: 64, chord: 'single', velocity: 0.8, gate: 1, cents: 0 }));
    assert.deepEqual(plain.freqs, zero.freqs);
    for (const f of plain.freqs) assert.equal(f, hz(64), 'bit-identical to 440 * 2 ** ((64 - 69) / 12)');
  },
  async function everyChordToneCarriesTheSameDeparture() {
    const { freqs } = await bounce(normalizeStep({ note: 60, chord: 'major', velocity: 0.8, gate: 1, cents: -20 }));
    const asked = [...new Set(freqs)].sort((a, b) => a - b);
    assert.deepEqual(asked, [hz(59.8), hz(63.8), hz(66.8)], 'the triad moves with its root');
  },
  async function aCardNoteIsRenderedAtItsExactPitch() {
    const card = brassBell();
    const off = await bounce(normalizeStep({ note: 64, chord: 'single', velocity: 0.8, gate: 1, cents: 38 }), { card });
    assert.deepEqual(off.midis, [64.38], 'the card physics is asked for the pitch that sounds');
    const plain = await bounce(normalizeStep({ note: 64, chord: 'single', velocity: 0.8, gate: 1 }), { card });
    assert.deepEqual(plain.midis, [64], 'and for the bare note when there are no cents');
  },
  function twoDegreesOfTheBrassBellStayDistinct() {
    const intervals = cardScaleIntervals(brassBell());
    const shared = intervals.filter((v) => Math.round(v) === 8);
    assert.equal(shared.length, 2, 'two measured degrees round onto semitone 8: ' + JSON.stringify(intervals));
    assert.ok(Math.abs(shared[0] - shared[1]) > 0.5, 'and they are half a semitone apart');
    const studio = createStudio();
    applyCustomScale(studio, intervals, 'BRASS');
    const spec = scaleSpec(studio);
    const degrees = intervals.map((v, i) => i);
    const pitches = degrees.map((d) => scaleNote(0, spec, d, 4) + scaleCents(spec, d) / 100);
    assert.equal(new Set(pitches).size, intervals.length, 'every degree sounds its own pitch: ' + JSON.stringify(pitches));
    const columns = degrees.map((d) => scaleNote(0, spec, d, 4));
    assert.ok(new Set(columns).size < columns.length, 'while two of them still share a key column');
  },
  function anIdeaOnAMeasuredScalePlaysItsCents() {
    const studio = createStudio();
    applyCustomScale(studio, cardScaleIntervals(brassBell()), 'BRASS');
    generateStudioIdea(studio, 0x1234);
    const steps = studio.tracks.flatMap((track) => track.steps.filter(Boolean));
    assert.ok(steps.length > 0, 'the idea wrote notes');
    assert.ok(steps.some((step) => stepCents(step) !== 0), 'and some of them are off the grid');
    const twelve = createStudio();
    generateStudioIdea(twelve, 0x1234);
    for (const step of twelve.tracks.flatMap((track) => track.steps.filter(Boolean))) {
      assert.ok(!Object.prototype.hasOwnProperty.call(step, 'cents'), 'a named scale writes no cents at all');
    }
  },
  function theRollPrintsTheDeparture() {
    assert.equal(stepLabel({ note: 76, chord: 'single', cents: 38 }), 'E5 +38');
    assert.equal(stepLabel({ note: 76, chord: 'single', cents: -41.92 }), 'E5 -42');
    assert.equal(stepLabel({ note: 76, chord: 'single', cents: 1 }), 'E5', 'a cent is not a departure');
    assert.equal(stepLabel({ note: 76, chord: 'major', cents: 38 }), 'E5 +38 MAJOR');
    assert.equal(stepLabel({ note: 76, chord: 'single' }), 'E5');
    assert.equal(stepLabel(null), '—');
  },
  function centsSurviveSaveAndReload() {
    const project = createProject([]);
    const runtime = { repairs: [], analysis: null, sourceBytes: null };
    project.studio.tracks[0].steps[0] = normalizeStep({ note: 64, chord: 'single', velocity: 0.8, gate: 1, cents: -41.92 });
    project.studio.touched = true;
    const { json } = serializeProject(project, runtime);
    const back = createProject([]);
    applySnapshot(JSON.parse(JSON.stringify(json)), { project: back, runtime: { repairs: [], analysis: null, sourceBytes: null } });
    assert.equal(back.studio.tracks[0].steps[0].cents, -41.92);
    assert.equal(stepPitch(back.studio.tracks[0].steps[0]), stepPitch(project.studio.tracks[0].steps[0]));
  },
  function theScaleStatusLineReadsInCents() {
    const bench = studioBench(createStudio(), honestCache());
    bench.api.studioSetScale(cardScaleIntervals(brassBell()), 'BRASS');
    assert.equal(bench.statuses[bench.statuses.length - 1], 'STUDIO · SCALE BRASS · 0 429 758 812 1098 CENTS',
      'the bench reads whole cents, not raw semitone floats: ' + JSON.stringify(bench.statuses));
    assert.equal(scaleIntervalsLabel([0, 4.287482986285187]), '0 429 CENTS');
    assert.equal(scaleIntervalsLabel([]), '', 'and says nothing about an empty scale');
  },
  async function theWarmFillsThePitchTheLiveTickAsksFor() {
    const step = normalizeStep({ note: 76, chord: 'single', velocity: 0.8, gate: 1, cents: 38 });
    const studio = cardStudio(step);
    const cache = honestCache();
    studioBench(studio, cache).view.dispatchEvent(new CustomEvent('play'));
    await settle();
    const { card, excitation } = studio.tracks[0].card;
    const duration = studioStepSeconds(studio.bpm) * step.gate;
    assert.ok(cache.has(card, excitation, 76.38, step.velocity, duration), 'the warm rendered the pitch that sounds');
    assert.ok(!cache.has(card, excitation, 76, step.velocity, duration), 'and not the twelve-tone column it is written in');
    assert.equal(cache.map.size, 1, 'one render for one note');
    assert.deepEqual(liveTick(studio, cache), [76.38], 'so the live tick finds it and plays it');
  },
  function anUnwarmedCardNoteIsSkippedNotPlayedFlat() {
    const step = normalizeStep({ note: 76, chord: 'single', velocity: 0.8, gate: 1, cents: 38 });
    const studio = cardStudio(step);
    assert.deepEqual(liveTick(studio, honestCache()), [],
      'the liveOnly skip is reachable: nothing warmed, nothing rendered on the audio thread');
  },
  function nearIdenticalDegreesFoldOntoTheLowerOne() {
    assert.equal(SCALE_DEGREE_CENTS, 5, 'above the 2.07-cent sampling grid of the dissonance curve, under the pitch JND');
    assert.deepEqual(dedupeScaleIntervals([3.065, 3.10642, 5.302]), [0, 3.065, 5.302],
      'two minima 4.1 cents apart are one degree, and the survivor keeps its measured value');
    assert.deepEqual(dedupeScaleIntervals([0.03, 7]), [0, 7], 'a degree inside the tolerance of the root is the root');
    const brass = cardScaleIntervals(brassBell());
    assert.equal(brass.filter((v) => Math.round(v) === 8).length, 2,
      'the Iowa brass bell still holds two degrees inside semitone 8: ' + JSON.stringify(brass));
    const raw = cardScale(buzz()).filter((c) => { const column = Math.round(c / 100); return column > 0 && column < 12; });
    const kept = cardScaleIntervals(buzz());
    assert.equal(raw.length + 1, 20, 'uvb76-buzz measures 19 minima inside the octave, plus the root');
    assert.equal(kept.length, 19, 'exactly one pair folds; the other 18 gaps are wider than the tolerance');
    for (let i = 1; i < kept.length; i++) {
      assert.ok((kept[i] - kept[i - 1]) * 100 >= SCALE_DEGREE_CENTS, 'no two surviving degrees are inside it: ' + JSON.stringify(kept));
    }
  },
  function clickingARetunedStepReplacesItInsteadOfClearingIt() {
    assert.equal(stepMatchesPalette({ note: 76, chord: 'single' }, 76, 'single'), true, 'a second click on the same note clears it');
    assert.equal(stepMatchesPalette(normalizeStep({ note: 76, chord: 'single', cents: 38 }), 76, 'single'), false,
      'a step 38 cents off the grid is not the palette note');
    assert.equal(stepMatchesPalette({ note: 76, chord: 'major' }, 76, 'single'), false);
    assert.equal(stepMatchesPalette(null, 76, 'single'), false);
  },
  function theCanonicalScoreCarriesTheCentsThrough() {
    const step = normalizeStep({ note: 76, chord: 'major', velocity: 0.8, gate: 1, cents: 38 });
    const score = compileStudioScore(cardStudio(step, { transpose: -12 }), { trackIndex: 0 });
    assert.equal(score.length, 1);
    const event = score[0];
    assert.equal(event.cents, 38);
    assert.ok(Math.abs(event.rootPitch - 76.38) < 1e-9, 'the pitch the step sounds, unrounded');
    assert.equal(event.rootNote, 76, 'beside the column it is written in');
    assert.deepEqual(event.heardNotes, [64, 68, 71], 'every MIDI and OP-Z target downstream still reads whole notes');
    assert.equal(event.heardPitches.length, 3);
    event.heardPitches.forEach((pitch, i) => assert.ok(Math.abs(pitch - (64.38 + [0, 4, 7][i])) < 1e-9,
      'and every chord tone carries the departure: ' + JSON.stringify(event.heardPitches)));
  },
  function aCentsThatIsNotANumberIsNoCentsAtAll() {
    assert.equal(clampCents(NaN), 0, 'no measurement, so no departure');
    assert.equal(clampCents(Infinity), 0, 'and not STEP_CENTS_LIMIT, which would invent a semitone');
    assert.equal(clampCents(-Infinity), 0);
    assert.equal(clampCents(undefined), 0);
    assert.equal(clampCents('38'), 38, 'a numeric string is still a measurement');
    assert.equal(clampCents(9999), STEP_CENTS_LIMIT, 'a finite one is clamped');
    for (const cents of [NaN, Infinity, -Infinity]) {
      const step = normalizeStep({ note: 60, chord: 'single', cents });
      assert.ok(!Object.prototype.hasOwnProperty.call(step, 'cents'), 'the step keeps no cents key: ' + cents);
      assert.equal(stepPitch(step), 60);
    }
  },
  function theSavedFileItselfCarriesTheCents() {
    const project = createProject([]);
    const step = normalizeStep({ note: 76, chord: 'major', velocity: 0.8, gate: 1, cents: 38 });
    project.studio.tracks[2].steps[5] = step;
    project.studio.touched = true;
    const { json } = serializeProject(project, { repairs: [], analysis: null, sourceBytes: null });
    const text = JSON.stringify(json);
    assert.ok(text.includes('"cents":38'), 'persist.js writes the cents into the file: ' + text.slice(0, 200));
    const back = createProject([]);
    applySnapshot(JSON.parse(text), { project: back, runtime: { repairs: [], analysis: null, sourceBytes: null } });
    assert.deepEqual(back.studio.tracks[2].steps[5], step, 'and reads back the same step');
  },
  function aProjectSavedBeforeCentsExistedReloadsUnchanged() {
    const old = { note: 60, chord: 'single', velocity: 0.82, gate: 0.9 };
    const step = normalizeStep(old);
    assert.deepEqual(step, old, 'no key is added to a twelve-tone step');
    assert.equal(stepPitch(step), 60);
    assert.equal(stepCents(step), 0);
    assert.equal(stepCents({ note: 60, cents: 'loud' }), 0, 'a junk cents is none');
    assert.equal(normalizeStep({ note: 60, cents: 9999 }).cents, STEP_CENTS_LIMIT, 'and a wild one is clamped');
    assert.equal(normalizeStep({ note: 60, cents: -9999 }).cents, -STEP_CENTS_LIMIT);
  },
  function thePanelPrintsEveryDegreeTheScaleActuallyHas() {
    const collapsed = [];
    for (const [file, card] of labCards()) {
      const degrees = cardScaleIntervals(card);
      if (new Set(degrees.map((v) => Math.round(v))).size < degrees.length) collapsed.push(file);
      const line = scaleLine(card);
      if (!line) { assert.equal(cardScale(card).length, 0, file + ' has minima but no line'); continue; }
      const printed = line.split(' snaps to ')[1].split(' ');
      assert.equal(printed.length, degrees.length, file + ' prints ' + printed.length + ' of ' + degrees.length + ' degrees');
      assert.equal(new Set(printed).size, printed.length,
        file + ' prints ' + printed.length + ' degrees as ' + new Set(printed).size + ' numbers: ' + printed.join(' '));
    }
    assert.deepEqual(collapsed, ['fdr-vowel.json', 'iowa-bells-brass-Cs5.json', 'ory-chord.json', 'uvb76-buzz.json'],
      'four of the fifteen cards hold two degrees inside one semitone, so a rounded list would hide 14 of them');
    assert.equal(scaleLine(brassBell()), 'ITS OWN SCALE · 429 · 758 · 812 · 1098 cents · snaps to 0 429 758 812 1098',
      'the two degrees inside semitone 8 print as 758 and 812, not as 8 and 8');
    assert.equal(scaleLine({ modes: [{ freqHz: 200, amp: 1, tauSec: 1 }] }), '', 'one partial has no scale and no line');
  },
  function aSavedScaleIsRestoredExactlyAsItWasSaved() {
    const measured = cardScaleIntervals(brassBell());
    assert.ok(measured.some((v) => v > 0 && !Number.isInteger(v)), 'the scale carries fractional cents: ' + JSON.stringify(measured));
    const studio = applyCustomScale(createStudio(), measured, 'BRASS');
    const back = applyStudioSnapshot(createStudio(), JSON.parse(JSON.stringify(studio)));
    assert.equal(back.scale, 'custom');
    assert.deepEqual(back.customScale, studio.customScale, 'every degree comes back to the last bit');
    assert.equal(back.customScale.intervals[1], measured[1]);
    // Load validates a project file, which is untrusted input, but does not put
    // the scale back through the card intake: that window and that fold judge a
    // fresh measurement, and doing it twice deletes degrees a project already has.
    const saved = { scale: 'custom', customScale: { name: 'wide', intervals: [0, 0.4, 3.02, 3.06, 7, 11.6] } };
    const wide = applyStudioSnapshot(createStudio(), JSON.parse(JSON.stringify(saved)));
    assert.deepEqual(wide.customScale.intervals, [0, 0.4, 3.02, 3.06, 7, 11.6]);
    assert.equal(wide.customScale.name, 'WIDE');
    assert.deepEqual(applyCustomScale(createStudio(), saved.customScale.intervals, 'X').customScale.intervals, [0, 3.02, 7],
      'which is what intake does to them, and what load did until now');
    const junk = restoreCustomScale(createStudio(), { name: 'junk', intervals: [7, 'x', NaN, Infinity, -3, 0, 7, 1e9] });
    assert.deepEqual(junk.customScale.intervals, [0, 7], 'a corrupt file still cannot reach the engine');
    assert.equal(junk.customScale.name, 'JUNK');
    const legacy = applyStudioSnapshot(createStudio(), { scale: 'custom', customScale: { name: 'WINE GLASS', intervals: [0, 3, 7, 10] } });
    assert.deepEqual(legacy.customScale.intervals, [0, 3, 7, 10], 'the integer scales every released version wrote are unchanged');
  },
  function theRollsLabelAndItsClickAgreeOnEveryMeasuredDegree() {
    let silentButOffGrid = 0;
    for (const [file, card] of labCards()) {
      const intervals = cardScaleIntervals(card);
      if (intervals.length < 2) continue;
      const spec = scaleSpec(applyCustomScale(createStudio(), intervals, 'X'));
      for (let degree = 0; degree < intervals.length; degree++) {
        const step = normalizeStep({ note: scaleNote(0, spec, degree, 4), chord: 'single', cents: scaleCents(spec, degree) });
        const prints = / [+-]\d+$/.test(stepLabel(step));
        assert.equal(prints, !stepMatchesPalette(step, step.note, 'single'),
          file + ' degree ' + degree + ' prints "' + stepLabel(step) + '" but clicking it would ' + (prints ? 'clear' : 'replace') + ' it');
        if (!prints && stepCents(step) !== 0) silentButOffGrid++;
      }
    }
    assert.equal(silentButOffGrid, 4,
      'four of the 69 measured degrees sound off the grid by less than the roll prints — the case the two rules used to disagree on');
    const hair = normalizeStep({ note: 76, chord: 'single', cents: 1 });
    assert.equal(stepLabel(hair), 'E5', 'a cent is not a departure the roll prints');
    assert.equal(stepMatchesPalette(hair, 76, 'single'), true, 'so a second click on it clears it, as the label promises');
    assert.equal(stepCents(hair), 1, 'and the measurement is still on the step until then');
    assert.equal(stepIsOnGrid(normalizeStep({ note: 76, chord: 'single', cents: 2 })), false, 'two cents is where the roll starts printing');
    assert.equal(stepMatchesPalette(normalizeStep({ note: 76, chord: 'single', cents: 2 }), 76, 'single'), false);
  },
  function theFamilyPercentSaysWhatItMeasures() {
    const summary = cardSummary(brassBell());
    assert.match(summary, / \(fit \d+%\)/, 'the number is a fit to the family named, not certainty about the name: ' + summary);
    assert.ok(!/[a-z] \(\d+%\)/.test(summary), 'and it is never printed bare: ' + summary);
    const unknown = cardSummary({ ...brassBell(), family: { kind: 'unknown', confidence: 0, margin: 0 } });
    assert.ok(unknown.includes('no known family') && !unknown.includes('fit'), 'no family, no fit: ' + unknown);
  },
];
