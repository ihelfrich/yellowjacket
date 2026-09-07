// Thirteen Cards — movement I, "Two Metals" (Allegro, sonata). 240 s, 96 bpm,
// 4/4, 96 bars. A literal, deterministic realisation of
// docs/lab/symphony/design.json movements[0]: every event is a closed-form
// function of bar and beat; no randomness. Pure.
//
// Reading choices (the design's rules conflict in exactly one place):
//  * A 1-beat canon of a five-note, four-beat motif puts its last note on beat 1
//    of the NEXT bar. Inside a canon section that is the texture (bar 9's tail
//    lands in bar 10). Where the next bar is one the design declares otherwise
//    silent — bar 13 ("All other parts silent"), block bar m=8 ("nothing else in
//    bar m=8"), bar 73 (thud and carillon only) — the spilled note is dropped so
//    the section boundary the critics checked stays clean. Bar 68's tail into
//    bar 69 is kept (bar 69 is still the canon texture). Five notes are dropped
//    in the whole movement.
//  * Where the design states a pitch as a number (557.3, 863.4, 668.9, 518.2,
//    431.7, 215.85, 278.65, 139.3, 334.5, 167.25, 787.1, 662.8, 2229.2) that
//    number is used verbatim; everything else is hz(k, root) from the scale.
//    hz(2, 557.3) = 863.45 and hz(7, 557.3) = 1726.9 are the design's 863.4 and
//    1726.8 to 0.1 cent; hz(2, 215.85) = 334.43 is its 334.5 to a third of a cent.
//  * Strike velocity by onset position is read from the absolute time, so a
//    canon note that lands on the next bar's beat 1 takes 1.0.
//  * The S2 roots are exactly the stated halves: 431.7 = 863.4/2 and
//    215.85 = 863.4/4; recap 278.65 = 557.3/2 and 139.3 = 278.65/2.

import { createScore, addPart, addNote } from '../model.js';

export const TITLE = 'Two Metals';
export const SECONDS = 240;
export const TEMPO_BPM = 96;

export const BEAT = 0.625;
export const BAR = 2.5;

/** The brass bell's own dissonance minima, cents; octave period 1200. */
export const SCALE = Object.freeze([0, 429, 758, 812, 1098]);

/** hz(k, root) = root * 2^((1200*floor(k/5) + S[k mod 5]) / 1200), k mod 5 non-negative. */
export function hz(k, root) {
  const q = Math.floor(k / 5);
  const r = k - 5 * q;
  return root * Math.pow(2, (1200 * q + SCALE[r]) / 1200);
}

// Roots, as the design states them.
const TONIC = 557.3;
const DOMINANT = 863.4;      // 557.3 * 2^(758/1200)
const ROOT_TWO = 668.9;      // 557.3 * 2^(316/1200)
const ROOT_THREE = 518.2;    // 557.3 * 2^(1074/1200) / 2

// Measured own pitches used in YIELDs, and the drum / tick.
const CARILLON_OWN = 787.1;
const E5_OWN = 662.8;
const THUD_HZ = 182.0;
const COMMONS_HZ = 2229.2;   // 4 * 557.3

// Motifs: degrees and beats.
const MOTIF_A = { degrees: [0, 1, 2, 4, 2], beats: [1, 0.5, 0.5, 1, 1] };
const MOTIF_A_RETRO = { degrees: [2, 4, 2, 1, 0], beats: [1, 0.5, 0.5, 1, 1] };
const MOTIF_B = { degrees: [4, 3, 2, 0], beats: [2, 2, 1, 3] };
const MOTIF_B_AUG = { degrees: [4, 3, 2, 0], beats: [4, 4, 2, 6] };
const A3 = { degrees: [0, 1, 2], beats: [1, 0.5, 0.5] };
const A3_INV = { degrees: [0, -1, -2], beats: [1, 0.5, 0.5] };

const S1_OFFSETS = [0, 2, 0, -1];

/** Bar b (1-based), beat y (1-based, may be fractional) → seconds. */
export function tAt(bar, beat = 1) { return (bar - 1) * BAR + (beat - 1) * BEAT; }

/** Beat position 0..4 of an absolute time within its bar, rounded away from float dust. */
function beatPos(t) { return Math.round(((t / BEAT) % 4) * 1e6) / 1e6; }

/** Strike velocity by onset position: beat 1 → 1.0, beat 3 → 0.75, else 0.5. */
export function beatVelocity(t) {
  const p = beatPos(t);
  return p === 0 ? 1.0 : p === 2 ? 0.75 : 0.5;
}

/** A motif at offset o and root R, starting at bar/beat: [{ t, k, hz, beats }]. */
function motifEvents(motif, { bar, beat = 1, offset = 0, root, delayBeats = 0 }) {
  const out = [];
  let pos = beat + delayBeats;
  for (let i = 0; i < motif.degrees.length; i++) {
    const k = motif.degrees[i] + offset;
    out.push({ t: tAt(bar, pos), k, hz: hz(k, root), beats: motif.beats[i] });
    pos += motif.beats[i];
  }
  return out;
}

function strike(part, t, pitch, velocity) {
  addNote(part, { t, hz: pitch, velocity, seconds: 4 });
}

/** Strike every event; velocity by the beat rule unless a number or function is given. */
function strikeEvents(part, events, velocity = null) {
  events.forEach((e, i) => {
    const v = typeof velocity === 'function' ? velocity(e, i) : velocity != null ? velocity : beatVelocity(e.t);
    strike(part, e.t, e.hz, v);
  });
}

/** Bowed / breath: seconds = beats*0.625 + 0.2. */
function sustain(part, t, pitch, beats, velocity) {
  addNote(part, { t, hz: pitch, velocity, seconds: beats * BEAT + 0.2 });
}

function sustainEvents(part, events, velocity, pitchOf = (e) => e.hz) {
  for (const e of events) sustain(part, e.t, pitchOf(e), e.beats, velocity);
}

/** A stated hold of N seconds is one note of N seconds. */
function hold(part, t, pitch, seconds, velocity) {
  addNote(part, { t, hz: pitch, velocity, seconds });
}

/** E5 doubling fold rule: hz(k+5, 557.3) if <= 2100 Hz, else hz(k, 557.3). */
export function foldE5(k) {
  const up = hz(k + 5, TONIC);
  return up <= 2100 ? up : hz(k, TONIC);
}

/** Drop events whose onset is at or past `endT` (a section boundary the design declares silent). */
const before = (events, endT) => events.filter((e) => e.t < endT - 1e-9);

export function movement({ cards }) {
  const need = (id) => {
    const c = cards && cards[id];
    if (!c) throw new Error(`movement-1 needs card ${id}`);
    return c;
  };

  const score = createScore({ title: TITLE, sampleRate: 48000 });
  const brass = addPart(score, { id: 'brass', card: need('iowa-bells-brass-Cs5'), excitation: 'strike', pan: -0.35, rmsDb: -18 });
  const plasticCs5 = addPart(score, { id: 'plastic-Cs5', card: need('iowa-bells-plastic-ff-Cs5'), excitation: 'strike', pan: 0.35, rmsDb: -19 });
  const plasticE5 = addPart(score, { id: 'plastic-E5', card: need('iowa-bells-plastic-ff-E5'), excitation: 'strike', pan: 0.6, rmsDb: -21 });
  const plasticA5 = addPart(score, { id: 'plastic-A5', card: need('iowa-bells-plastic-ff-A5'), excitation: 'strike', pan: -0.6, rmsDb: -21 });
  const carillon = addPart(score, { id: 'carillon', card: need('carillon-bell'), excitation: 'strike', pan: -0.7, rmsDb: -20 });
  const glass = addPart(score, { id: 'glass', card: need('freesound-wineglass'), excitation: 'bow', pan: 0.5, rmsDb: -22 });
  const hiawatha = addPart(score, { id: 'hiawatha', card: need('hiawatha-vowel'), excitation: 'breath', pan: 0.2, rmsDb: -23 });
  const fdr = addPart(score, { id: 'fdr', card: need('fdr-vowel'), excitation: 'breath', pan: -0.2, rmsDb: -24 });
  const thud = addPart(score, { id: 'thud', card: need('opz-thud'), excitation: 'strike', pan: 0, rmsDb: -20 });
  const commons = addPart(score, { id: 'commons', card: need('commons-bell-15cm'), excitation: 'strike', pan: 0.8, rmsDb: -30 });

  const thudAt = (t, velocity) => strike(thud, t, THUD_HZ, velocity);

  // ---- Exposition: S1 bars 1-12 -----------------------------------------
  // Bars 1-8: Motif A (brass) / A' (plastic-Cs5) alternating with offsets [0,2,0,-1].
  for (let i = 0; i < 4; i++) {
    const o = S1_OFFSETS[i];
    strikeEvents(brass, motifEvents(MOTIF_A, { bar: 2 * i + 1, offset: o, root: TONIC }));
    strikeEvents(plasticCs5, motifEvents(MOTIF_A_RETRO, { bar: 2 * i + 2, offset: o, root: TONIC }));
  }
  // Bars 9-12: brass A every bar; plastic-Cs5 one beat later; E5 doubles brass by the fold rule at 0.5.
  for (let bar = 9; bar <= 12; bar++) {
    const lead = motifEvents(MOTIF_A, { bar, offset: 0, root: TONIC });
    strikeEvents(brass, lead);
    // Canon tail from bar 12 would land on bar 13 beat 1 (transition, "All other parts silent"): dropped.
    strikeEvents(plasticCs5, before(motifEvents(MOTIF_A, { bar, offset: 0, root: TONIC, delayBeats: 1 }), tAt(13)));
    for (const e of lead) strike(plasticE5, e.t, foldE5(e.k), 0.5);
  }

  // ---- Transition bars 13-16 --------------------------------------------
  for (let bar = 13; bar <= 16; bar++) for (let beat = 1; beat <= 4; beat++) thudAt(tAt(bar, beat), 0.5);
  strike(carillon, tAt(13, 1), CARILLON_OWN, 0.75);                 // own pitch
  strike(carillon, tAt(13, 3), DOMINANT, 0.75);                     // YIELD +160 cents
  [1, 2, 7].forEach((k, i) => {
    const bar = 14 + i;
    for (const beat of [1, 3]) strike(carillon, tAt(bar, beat), hz(k, TONIC), beatVelocity(tAt(bar, beat)));
  });

  // ---- S2 bars 17-28 (and, parameterised, recap bars 77-88) --------------
  function secondSubject({ startBar, glassRoot, hiawathaRoot, hiawathaPitch, hiawathaHoldHz, fdrPitch }) {
    // Three statements of Motif B, bars +0, +2, +4; hiawatha one beat late.
    for (let s = 0; s < 3; s++) {
      const bar = startBar + 2 * s;
      sustainEvents(glass, motifEvents(MOTIF_B, { bar, root: glassRoot }), 0.5);
      sustainEvents(hiawatha, motifEvents(MOTIF_B, { bar, root: hiawathaRoot, delayBeats: 1 }), 0.5, hiawathaPitch);
    }
    // Bars +6..+9: glass B augmented at 0.75; hiawatha holds its root for 10 s.
    sustainEvents(glass, motifEvents(MOTIF_B_AUG, { bar: startBar + 6, root: glassRoot }), 0.75);
    hold(hiawatha, tAt(startBar + 6), hiawathaRoot, 10, 0.5);
    // fdr enters bar +8 beat 1 holding for 10 s (through bar +11), velocity 0.25.
    hold(fdr, tAt(startBar + 8), fdrPitch, 10, 0.25);
    // Bars +10..+11: glass holds its root, hiawatha holds its 758-cent degree, 5 s each, 0.5.
    hold(glass, tAt(startBar + 10), glassRoot, 5, 0.5);
    hold(hiawatha, tAt(startBar + 10), hiawathaHoldHz, 5, 0.5);
  }

  const HALF_DOMINANT = DOMINANT / 2;         // 431.7
  const QUARTER_DOMINANT = DOMINANT / 4;      // 215.85
  secondSubject({
    startBar: 17,
    glassRoot: HALF_DOMINANT,
    hiawathaRoot: QUARTER_DOMINANT,           // an octave below the glass
    hiawathaPitch: (e) => e.hz,
    hiawathaHoldHz: 334.5,                    // stated; = hz(2, 215.85) to a third of a cent
    fdrPitch: QUARTER_DOMINANT,
  });

  // ---- Codetta bars 29-32 -----------------------------------------------
  strikeEvents(brass, motifEvents(MOTIF_A, { bar: 29, root: DOMINANT }));
  strikeEvents(plasticCs5, motifEvents(MOTIF_A_RETRO, { bar: 30, root: DOMINANT }));
  strikeEvents(brass, motifEvents(MOTIF_A, { bar: 31, root: DOMINANT }));
  strikeEvents(plasticCs5, motifEvents(MOTIF_A_RETRO, { bar: 32, root: DOMINANT }));
  for (let bar = 29; bar <= 32; bar++) for (const beat of [1, 3]) thudAt(tAt(bar, beat), 0.5);

  // ---- Development bars 33-56: three 8-bar blocks ------------------------
  const BLOCK_START = [33, 41, 49];
  const BLOCK_ROOT = [DOMINANT, ROOT_TWO, ROOT_THREE];
  const BLOCK_CANON_OFFSET = [-2, 0, 2];
  const climbVelocity = (e, i) => (i === 0 ? 0.75 : 0.5);
  for (let j = 0; j < 3; j++) {
    const B = BLOCK_START[j], R = BLOCK_ROOT[j];
    const bar = (m) => B + m - 1;
    // m=1: statement and inversion of A3.
    strikeEvents(brass, motifEvents(A3, { bar: bar(1), beat: 1, root: R }));
    strikeEvents(plasticCs5, motifEvents(A3_INV, { bar: bar(1), beat: 3, root: R }));
    // m=2: YIELD, velocity 0.75.
    if (j === 0 || j === 2) {
      strike(plasticE5, tAt(bar(2), 1), E5_OWN, 0.75);
      strike(plasticE5, tAt(bar(2), 3), hz(1, TONIC), 0.75);          // 714.0, +129 cents
    }
    if (j === 1 || j === 2) {
      strike(carillon, tAt(bar(2), 1), CARILLON_OWN, 0.75);
      strike(carillon, tAt(bar(2), 3), DOMINANT, 0.75);               // 863.4, +160 cents
    }
    // m=3,4: CLIMB — A3 every two beats, offsets 0,1,2,3, brass / plastic alternating.
    const climb = [[3, 1, brass], [3, 3, plasticCs5], [4, 1, brass], [4, 3, plasticCs5]];
    climb.forEach(([m, beat, part], offset) => {
      strikeEvents(part, motifEvents(A3, { bar: bar(m), beat, offset, root: R }), climbVelocity);
    });
    // m=5: brass Motif A; m=6: plastic-Cs5 A'.
    strikeEvents(brass, motifEvents(MOTIF_A, { bar: bar(5), root: R }));
    strikeEvents(plasticCs5, motifEvents(MOTIF_A_RETRO, { bar: bar(6), root: R }));
    // m=7: 1-beat canon at offset o_j; the tail into m=8 ("nothing else in bar m=8") is dropped.
    strikeEvents(brass, motifEvents(MOTIF_A, { bar: bar(7), offset: BLOCK_CANON_OFFSET[j], root: R }));
    strikeEvents(plasticCs5, before(motifEvents(MOTIF_A, { bar: bar(7), offset: BLOCK_CANON_OFFSET[j], root: R, delayBeats: 1 }), tAt(bar(8))));
    // m=8: tonic-and-octave punctuation with the thud.
    strike(plasticE5, tAt(bar(8), 1), hz(5, R), 1.0);
    strike(plasticA5, tAt(bar(8), 1), hz(0, R), 1.0);
    thudAt(tAt(bar(8), 1), 0.75);
    thudAt(tAt(bar(8), 3), 0.75);
    // Glass: B augmented at R/2 under bars m=1-4.
    sustainEvents(glass, motifEvents(MOTIF_B_AUG, { bar: bar(1), root: R / 2 }), 0.5);
  }

  // ---- Retransition bars 57-60 ------------------------------------------
  const RETRANS_THUD = [0.25, 0.5, 0.75, 1.0];
  for (let bar = 57; bar <= 60; bar++) {
    for (let e = 0; e < 8; e++) thudAt(tAt(bar) + e * (BEAT / 2), RETRANS_THUD[bar - 57]);
    strike(carillon, tAt(bar, 1), hz(7, TONIC), 1.0);                // 1726.8
  }
  hold(fdr, tAt(57), 167.25, 10, 0.75);                              // 758-cent degree of 107.9
  hold(hiawatha, tAt(57), 334.5, 10, 0.75);                          // 758-cent degree of 215.85

  // ---- Recapitulation: S1 bars 61-72 in the full canon texture -----------
  function canonBar(bar, motif, offset, dropAfterT = null) {
    const lead = motifEvents(motif, { bar, offset, root: TONIC });
    strikeEvents(brass, lead);
    let follow = motifEvents(motif, { bar, offset, root: TONIC, delayBeats: 1 });
    if (dropAfterT != null) follow = before(follow, dropAfterT);
    strikeEvents(plasticCs5, follow);
    for (const e of lead) strike(plasticE5, e.t, foldE5(e.k), 0.5);
  }
  for (let i = 0; i < 4; i++) {
    canonBar(61 + 2 * i, MOTIF_A, S1_OFFSETS[i]);
    canonBar(62 + 2 * i, MOTIF_A_RETRO, S1_OFFSETS[i]);
  }
  // Bars 69-72 exactly as bars 9-12; bar 72's canon tail into bar 73 (thud + carillon only) dropped.
  for (let bar = 69; bar <= 72; bar++) canonBar(bar, MOTIF_A, 0, bar === 72 ? tAt(73) : null);

  // ---- Transition bars 73-76 --------------------------------------------
  for (let bar = 73; bar <= 76; bar++) for (let beat = 1; beat <= 4; beat++) thudAt(tAt(bar, beat), 0.5);
  strike(carillon, tAt(73, 1), CARILLON_OWN, 0.75);
  strike(carillon, tAt(73, 3), DOMINANT, 0.75);                      // YIELD again
  [2, 1, 0].forEach((k, i) => {
    const bar = 74 + i;
    for (const beat of [1, 3]) strike(carillon, tAt(bar, beat), hz(k, TONIC), beatVelocity(tAt(bar, beat)));
  });

  // ---- S2 bars 77-88 at the tonic ---------------------------------------
  const HALF_TONIC = TONIC / 2;                // 278.65
  const foldHiawatha = (e) => (e.hz > 494 ? e.hz / 2 : e.hz);       // 525.3 → 262.7
  secondSubject({
    startBar: 77,
    glassRoot: HALF_TONIC,
    hiawathaRoot: HALF_TONIC,                  // unison with the glass, folded under 494 Hz
    hiawathaPitch: foldHiawatha,
    hiawathaHoldHz: 431.7,                     // stated; = hz(2, 278.65)
    fdrPitch: HALF_TONIC / 2,                  // 139.3
  });

  // ---- Coda bars 89-96 --------------------------------------------------
  const CODA_VEL = [1.0, 0.75, 0.5, 0.25];
  for (let n = 0; n < 4; n++) {
    const bar = 89 + 2 * n, t = tAt(bar, 1), v = CODA_VEL[n];
    strike(brass, t, TONIC, v);
    strike(plasticCs5, t, TONIC, v);
    strike(plasticE5, t, TONIC, v);
    strike(plasticA5, t, hz(5, TONIC), v);                            // 1114.6
  }
  for (const bar of [90, 92, 94]) strike(commons, tAt(bar, 3), COMMONS_HZ, 0.25);
  thudAt(tAt(96, 1), 1.0);                                            // 237.5 s, the last onset

  for (const p of score.parts) p.notes.sort((a, b) => a.t - b.t);
  return score;
}

export const FACTS = {
  seconds: 240,
  parts: 10,
  lastOnsetSec: 237.5,
  notes: { brass: 171, 'plastic-Cs5': 166, 'plastic-E5': 91, 'plastic-A5': 7, carillon: 24, glass: 46, hiawatha: 29, fdr: 3, thud: 79, commons: 3 },
};
