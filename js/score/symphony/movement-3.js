// Thirteen Cards — III. Buzzer (Scherzo and Trio). docs/lab/symphony/design.json
// movements[2], realised literally: 168 bpm 3/4 (beat 0.357143 s, bar
// 1.071429 s, 140 bars = 150 s), the plastic-mallet A5 bell's own septimal
// pentatonic P = [0,362,549,818,971] on 442.5 Hz. Scherzo a–b–a' (Motif D in
// canon, a 24-note hemiola with the buzzer's YIELD 335.0 → 354.9, the Stamp),
// Trio (buzzer breath bursting every 2.143 s under Motif E in parallel neutral
// thirds, repeated with the sine two octaves up), retransition (the buzzer
// CLIMBs its own scale to 588.7 Hz and BEATs at 1.4 Hz against the WWV
// 587.3 Hz), da capo with the vowels as countermelody, coda of four Stamps,
// three drum strokes and one tick. No randomness: every event is a closed-form
// function of bar and beat.

import { createScore, addPart, addNote, addMarker } from '../model.js';

export const TITLE = 'Buzzer (Scherzo and Trio)';
export const SECONDS = 150;

// ---- time -----------------------------------------------------------------
const BEAT = 60 / 168;                // 0.357143 s
const BAR = 3 * BEAT;                 // 3/4 → 1.071429 s
const BARS = 140;                     // 150 s
const barStart = (b) => (b - 1) * BAR;                    // bars are 1-based
const at = (bar, beat) => barStart(bar) + (beat - 1) * BEAT; // beat is 1-based within the bar

// ---- pitch ----------------------------------------------------------------
const ROOT = 442.5;                   // the A5 card's 885.0 Hz one octave down
const ROOT_E = 221.25;                // Motif E root (hz_E), one octave under
const P = [0, 362, 549, 818, 971];    // cents, period 1200
const mod5 = (k) => ((k % 5) + 5) % 5;
const degreeHz = (root, k) => root * Math.pow(2, (1200 * Math.floor(k / 5) + P[mod5(k)]) / 1200);
/** hz(k) = 442.5 * 2^((1200*floor(k/5) + P[k mod 5]) / 1200) */
export function hz(k) { return degreeHz(ROOT, k); }
/** hz_E(k) = 221.25 * 2^((1200*floor(k/5) + P[k mod 5]) / 1200) */
export function hzE(k) { return degreeHz(ROOT_E, k); }
/** The buzzer's OWN scale: own(c) = 335.0 * 2^(c/1200). */
const OWN_ROOT = 335.0;
export function own(c) { return OWN_ROOT * Math.pow(2, c / 1200); }
const OWN_CENTS = [0, 307, 530, 704, 849, 976];   // 335.0, 400.0, 455.0, 503.1, 547.1, 588.7 Hz

const HOST = hz(-2);                  // 354.9 Hz — the buzzer's host degree (+100 cents from its own 335.0)
const THIRD = 1.2325;                 // the trio's fixed parallel neutral third (fdr * 1.2325)
const THUD_HZ = 182.0;
const TICK_HZ = 8 * ROOT;             // 3540.0 Hz
const WWV_BEAT_HZ = 587.3;            // the clock; BEATs at 1.4 Hz against own(976) = 588.7

// ---- material -------------------------------------------------------------
const MOTIF_D = [0, 2, 4, 5, 4, 2];   // one beat each, 2 bars
const D8 = [0, 4, 2, 5, 3, 1, 4, 2];  // hemiola row, 2-beat spacing
const MOTIF_E = { degrees: [0, 1, 2, 1, 0, -1, 0], beats: [2, 2, 2, 2, 1, 1, 2] };   // 12 beats = 4 bars
const A_OFFSETS = [0, 0, 2, 4];       // Motif D degree offsets across bars 1,3,5,7 (and 9,11,13,15)
const E_OFFSETS = [0, 1, 2, 0];       // Motif E degree offsets across the four 4-bar phrases

const RING = 4;                       // struck notes: the renderer rings by physics; pass the design's 4
const OVERLAP = 0.05;                 // vowel breath notes: seconds = beats*0.357143 + 0.05
const LILT = { 1: 1.0, 2: 0.5, 3: 0.75 };   // strike velocity by beat of the bar

// ---- events ---------------------------------------------------------------
// Every event is kept as { part, bar, beat, hz, velocity, seconds } until the
// end, so that "bars 33-46 = bars 1-14 verbatim" and the da capo are literal
// copies of the section-a/b event lists shifted by whole bars.
const ev = (part, bar, beat, pitch, velocity, seconds) => ({ part, bar, beat, hz: pitch, velocity, seconds });
const shift = (events, bars) => events.map((e) => ({ ...e, bar: e.bar + bars }));

/** Motif D on `part` from `startBar` beat 1, degrees + offset, lilt velocity (or a fixed one). */
function motifD(part, startBar, offset, { velocity = null, root = hz } = {}) {
  return MOTIF_D.map((deg, i) => {
    const bar = startBar + Math.floor(i / 3), beat = (i % 3) + 1;
    return ev(part, bar, beat, root(deg + offset), velocity == null ? LILT[beat] : velocity, RING);
  });
}

/** Motif E on fdr from `startBar` beat 1 with a degree offset; hiawatha a fixed 1.2325 above; optional wwv 4x. */
function motifE(startBar, offset, { withWwv = false } = {}) {
  const out = [];
  let beatIndex = 0;                  // beats after bar `startBar` beat 1
  MOTIF_E.degrees.forEach((deg, i) => {
    const bar = startBar + Math.floor(beatIndex / 3), beat = (beatIndex % 3) + 1;
    const len = MOTIF_E.beats[i] * BEAT + OVERLAP;
    const f = hzE(deg + offset);
    out.push(ev('fdr', bar, beat, f, 0.5, len));
    out.push(ev('hiawatha', bar, beat, f * THIRD, 0.5, len));
    if (withWwv) out.push(ev('wwv', bar, beat, f * 4, 0.25, len));   // root 885.0, 775-1551 Hz
    beatIndex += MOTIF_E.beats[i];
  });
  return out;
}

/** Stamp(x): strokes at bar x beat 1, bar x beat 2, bar x+1 beat 1; tick on the third stroke only. */
function stamp(x) {
  const out = [];
  const strokes = [[x, 1], [x, 2], [x + 1, 1]];
  strokes.forEach(([bar, beat], i) => {
    out.push(ev('plastic-A5', bar, beat, hz(0), 1.0, RING));       // 442.5
    out.push(ev('plastic-E5', bar, beat, hz(-5), 1.0, RING));      // 221.25
    out.push(ev('plastic-Cs5', bar, beat, hz(2), 1.0, RING));      // 607.6
    out.push(ev('thud', bar, beat, THUD_HZ, 1.0, RING));
    out.push(ev('buzzer-strike', bar, beat, HOST, 1.0, RING));     // 354.9
    if (i === 2) out.push(ev('commons', bar, beat, TICK_HZ, 0.5, RING));   // 3540.0
  });
  return out;
}

/** Section a as written for bars 1-16: Motif D on A5 at 1,3,5,7 and 9,11,13,15; E5 canon at 10,12,14,16 (offset -5); thud every beat 1. */
function sectionA() {
  const out = [];
  [1, 3, 5, 7].forEach((bar, i) => out.push(...motifD('plastic-A5', bar, A_OFFSETS[i])));
  [9, 11, 13, 15].forEach((bar, i) => {
    out.push(...motifD('plastic-A5', bar, A_OFFSETS[i]));
    out.push(...motifD('plastic-E5', bar + 1, A_OFFSETS[i] - 5));   // one bar later, one octave down
  });
  for (let bar = 1; bar <= 16; bar++) out.push(ev('thud', bar, 1, THUD_HZ, 0.5, RING));
  return out;
}

/** Section b as written for bars 17-32: the 24-note hemiola, thud on 1, buzzer stab on 3 (first stab own 335.0 when `yieldFirst`). */
function sectionB({ yieldFirst }) {
  const out = [];
  for (let n = 0; n < 24; n++) {
    const beatIndex = 2 * n;
    const bar = 17 + Math.floor(beatIndex / 3), beat = (beatIndex % 3) + 1;
    const d = D8[n % 8] + 5 * (Math.floor(n / 8) - 1);
    const part = n % 8 === 0 ? 'plastic-E5' : n % 8 === 3 ? 'plastic-Cs5' : 'plastic-A5';
    out.push(ev(part, bar, beat, hz(d), 0.75, RING));
  }
  for (let bar = 17; bar <= 32; bar++) {
    out.push(ev('thud', bar, 1, THUD_HZ, 0.5, RING));
    const stabHz = yieldFirst && bar === 17 ? own(0) : HOST;       // YIELD: 335.0 at bar 17, then 354.9
    out.push(ev('buzzer-strike', bar, 3, stabHz, 0.5, RING));
  }
  return out;
}

/** The whole movement as an event list in bars/beats. */
function events() {
  const out = [];
  const a = sectionA();

  // Scherzo: a (1-16), b (17-32), a' (33-48).
  out.push(...a);
  out.push(...sectionB({ yieldFirst: true }));
  // a': "bars 33-46 = bars 1-14 verbatim; Stamp(47)". Read as: every event whose
  // onset lies in bars 1-14, shifted by 32 bars. The E5 canon entry at bar 14
  // therefore keeps only its first three notes (its bar-15 tail is not copied),
  // so bar 47 carries the Stamp alone.
  out.push(...shift(a.filter((e) => e.bar <= 14), 32));
  out.push(...stamp(47));

  // Trio bars 49-80: buzzer breath at 354.9, 5 beats from beat 1 of every odd bar 49..79.
  // (Exact 5 beats = 1.786 s, the period 2.143 s the design states; the 0.05 s
  // overlap is the vowels' rule, not the bursts'.)
  for (let bar = 49; bar <= 79; bar += 2) out.push(ev('buzzer-breath', bar, 1, HOST, 0.5, 5 * BEAT));
  [49, 53, 57, 61].forEach((bar, i) => out.push(...motifE(bar, E_OFFSETS[i])));
  [65, 69, 73, 77].forEach((bar, i) => out.push(...motifE(bar, E_OFFSETS[i], { withWwv: true })));

  // Retransition bars 81-96: CLIMB → BEAT.
  const climbBars = [81, 83, 85, 87, 89, 91];
  const climbHz = [HOST, own(0), own(307), own(530), own(704), own(849)];   // 354.9, 335.0, 400.0, 455.0, 503.1, 547.1
  const climbBeats = [5, 4, 4, 3, 3, 2];
  climbBars.forEach((bar, i) => out.push(ev('buzzer-breath', bar, 1, climbHz[i], 0.5, climbBeats[i] * BEAT)));
  out.push(ev('buzzer-breath', 93, 1, own(976), 0.5, 12 * BEAT));           // 588.7 Hz, holds to bar 97 beat 1
  out.push(ev('wwv', 93, 1, WWV_BEAT_HZ, 0.25, 12 * BEAT));                 // 587.3 Hz: BEAT 1.4 Hz, six cycles
  for (let bar = 89; bar <= 96; bar++) out.push(ev('thud', bar, 1, THUD_HZ, 0.5, RING));
  [93, 95].forEach((bar) => [0, 2, 4].forEach((deg, i) => out.push(ev('plastic-A5', bar, i + 1, hz(deg), 0.5, RING))));   // pre-echo

  // Da capo: bars 97-112 = bars 1-16 (all of a, the E5 entry at 16 keeps its bar-17 tail as written),
  // plus the vowels' Motif E as countermelody; bars 113-128 = bars 17-32 with no second yield.
  out.push(...shift(a, 96));
  [97, 101, 105, 109].forEach((bar, i) => out.push(...motifE(bar, E_OFFSETS[i])));
  out.push(...shift(sectionB({ yieldFirst: false }), 96));

  // Coda bars 129-140.
  [129, 131, 133, 135].forEach((x) => out.push(...stamp(x)));
  [[137, 1.0], [138, 0.75], [139, 0.5]].forEach(([bar, v]) => out.push(ev('thud', bar, 1, THUD_HZ, v, RING)));
  out.push(ev('commons', 140, 1, TICK_HZ, 0.25, RING));                    // 148.93 s, alone

  return out;
}

// ---- score ----------------------------------------------------------------
/** cards: { [cardId]: cardObject } preloaded by the caller. → score */
export function movement({ cards }) {
  const need = (id) => { const c = cards && cards[id]; if (!c) throw new Error('movement 3 needs card ' + id); return c; };
  const score = createScore({ title: 'III. ' + TITLE, sampleRate: 48000 });
  const parts = {
    'plastic-A5':    addPart(score, { id: 'plastic-A5',    card: need('iowa-bells-plastic-ff-A5'),  excitation: 'strike', pan: 0.4,  rmsDb: -18 }),
    'plastic-E5':    addPart(score, { id: 'plastic-E5',    card: need('iowa-bells-plastic-ff-E5'),  excitation: 'strike', pan: -0.4, rmsDb: -19 }),
    'plastic-Cs5':   addPart(score, { id: 'plastic-Cs5',   card: need('iowa-bells-plastic-ff-Cs5'), excitation: 'strike', pan: 0,    rmsDb: -19 }),
    'buzzer-strike': addPart(score, { id: 'buzzer-strike', card: need('uvb76-buzz'),                excitation: 'strike', pan: -0.2, rmsDb: -24 }),
    'buzzer-breath': addPart(score, { id: 'buzzer-breath', card: need('uvb76-buzz'),                excitation: 'breath', pan: -0.2, rmsDb: -24 }),
    'fdr':           addPart(score, { id: 'fdr',           card: need('fdr-vowel'),                 excitation: 'breath', pan: -0.3, rmsDb: -22 }),
    'hiawatha':      addPart(score, { id: 'hiawatha',      card: need('hiawatha-vowel'),            excitation: 'breath', pan: 0.3,  rmsDb: -23 }),
    'wwv':           addPart(score, { id: 'wwv',           card: need('wwv-tone'),                  excitation: 'bow',    pan: 0,    rmsDb: -28 }),
    'thud':          addPart(score, { id: 'thud',          card: need('opz-thud'),                  excitation: 'strike', pan: 0,    rmsDb: -20 }),
    'commons':       addPart(score, { id: 'commons',       card: need('commons-bell-15cm'),         excitation: 'strike', pan: 0.7,  rmsDb: -32 }),
  };

  const all = events().sort((p, q) => (p.bar - q.bar) || (p.beat - q.beat));
  for (const e of all) {
    if (e.bar < 1 || e.bar > BARS) throw new Error('movement 3: bar out of range ' + e.bar);
    addNote(parts[e.part], { t: at(e.bar, e.beat), hz: e.hz, velocity: e.velocity, seconds: e.seconds });
  }

  addMarker(score, barStart(1), 'Scherzo a');
  addMarker(score, barStart(17), 'Scherzo b (hemiola, YIELD)');
  addMarker(score, barStart(33), "Scherzo a'");
  addMarker(score, barStart(49), 'Trio');
  addMarker(score, barStart(65), 'Trio (sine two octaves up)');
  addMarker(score, barStart(81), 'Retransition (CLIMB)');
  addMarker(score, barStart(93), 'BEAT 588.7 / 587.3');
  addMarker(score, barStart(97), 'Da capo a');
  addMarker(score, barStart(113), 'Da capo b');
  addMarker(score, barStart(129), 'Coda');
  return score;
}

// Measured by the check script (scratchpad/symphony/check-3.mjs).
export const FACTS = {
  seconds: 150,
  parts: 10,
  lastOnsetSec: 148.93,
  notes: { 'plastic-A5': 195, 'plastic-E5': 84, 'plastic-Cs5': 21, 'buzzer-strike': 47, 'buzzer-breath': 23, fdr: 84, hiawatha: 84, wwv: 29, thud: 104, commons: 6 },
};
