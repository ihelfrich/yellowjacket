// Thirteen Cards, movement 4: "Sunshine (Rondo-finale)". A literal reading of
// docs/lab/symphony/design.json .movements[3]: every event is a closed-form
// function of bar and beat at 120 bpm (beat 0.5 s, bar 2 s, 105 bars = 210 s).
// Tuned by the Ory chord's own minima (period 1201 cents), centre 207.8 Hz.
// Pure; no randomness.

import { createScore, addPart, addNote } from '../model.js';

export const TITLE = 'Sunshine (Rondo-finale)';
export const SECONDS = 210;

// ---- time ------------------------------------------------------------------
const BEAT = 0.5, BAR = 2;
/** Bar b (1-based), beat y (1-based, may be fractional) → seconds. */
const at = (b, y = 1) => (b - 1) * BAR + (y - 1) * BEAT;
const RING = 4; // every struck/plucked note: seconds = 4 (rings by physics)
const OVERLAP = 0.1; // sustained notes overlap the next by 0.1 s

// ---- scale -----------------------------------------------------------------
export const O = [0, 296, 408, 503, 611, 700, 800, 808, 905, 967, 996, 1102];
export const PERIOD = 1201;
export const CENTRE = 207.8;
/** hz(k, root) = root * 2^((1201*floor(k/12) + O[k mod 12]) / 1200). */
export function hz(k, root = CENTRE) {
  const oct = Math.floor(k / 12), deg = ((k % 12) + 12) % 12;
  return root * Math.pow(2, (PERIOD * oct + O[deg]) / 1200);
}
const cents = (root, c) => root * Math.pow(2, c / 1200);

// Roots, as the design states them (the literal numbers, not re-derived).
const M = 415.6, M2 = 831.2;
const DOM = 311.3, DOM2 = 622.6, DOM4 = 1245.2;
const BASS = 103.9, BASS_DOM = 155.7;
const TICK = 1662.4, THUD = 182.0, PRESIDENT = 206.5;

// ---- motifs (fixed outputs of the design's quantisation rule) --------------
const MOTIF_F = { cents: [0, 408, 700, 967, 700, 408, 0, 700], beats: [1, 0.5, 0.5, 1, 1, 0.5, 0.5, 3] };
const A_F = { cents: [0, 408, 800, 1102, 800], beats: [1, 0.5, 0.5, 1, 1] };
const C_F = { cents: [1201, 905, 700, 503, 700, 1102, 1201], beats: [4, 4, 4, 4, 2, 2, 4] };
const D_F = [0, 503, 967, 1201, 967, 503];

/** Strike velocity rule: beat 1 → 1.0, other on-beats → 0.75, off-beats → 0.5. */
function strikeVelocity(t) {
  const beatsIntoBar = (t - Math.floor(t / BAR) * BAR) / BEAT;
  if (Math.abs(beatsIntoBar - Math.round(beatsIntoBar)) > 1e-9) return 0.5;
  return Math.round(beatsIntoBar) === 0 ? 1.0 : 0.75;
}

/** Play a struck motif at `root` from time t0. `velocity` = number | 'rule' | fn(i, t). */
function strikeMotif(part, motif, root, t0, velocity = 'rule') {
  let t = t0;
  motif.cents.forEach((c, i) => {
    const v = typeof velocity === 'function' ? velocity(i, t) : velocity === 'rule' ? strikeVelocity(t) : velocity;
    addNote(part, { t, hz: cents(root, c), velocity: v, seconds: RING });
    t += motif.beats[i] * BEAT;
  });
}

/** Play a sustained motif: seconds = beats*0.5 + 0.1 overlap. */
function sustainMotif(part, motif, root, t0, velocity) {
  let t = t0;
  motif.cents.forEach((c, i) => {
    addNote(part, { t, hz: cents(root, c), velocity, seconds: motif.beats[i] * BEAT + OVERLAP });
    t += motif.beats[i] * BEAT;
  });
}

// ---- the movement ----------------------------------------------------------
export function movement({ cards }) {
  const card = (id) => { const c = cards[id]; if (!c) throw new Error('movement 4 needs card ' + id); return c; };
  const score = createScore({ title: TITLE, sampleRate: 48000 });

  // One part per (card, excitation) role; pan and rmsDb from the design.
  const ory = addPart(score, { id: 'ory', card: card('ory-chord'), excitation: 'breath', pan: 0, rmsDb: -27 });
  const brass = addPart(score, { id: 'brass', card: card('iowa-bells-brass-Cs5'), excitation: 'strike', pan: -0.3, rmsDb: -18 });
  const plasticE5 = addPart(score, { id: 'plastic-E5', card: card('iowa-bells-plastic-ff-E5'), excitation: 'strike', pan: 0.3, rmsDb: -20 });
  const plasticCs5 = addPart(score, { id: 'plastic-Cs5', card: card('iowa-bells-plastic-ff-Cs5'), excitation: 'strike', pan: 0.5, rmsDb: -20 });
  const plasticA5 = addPart(score, { id: 'plastic-A5', card: card('iowa-bells-plastic-ff-A5'), excitation: 'strike', pan: -0.5, rmsDb: -20 });
  const carillon = addPart(score, { id: 'carillon', card: card('carillon-bell'), excitation: 'strike', pan: -0.7, rmsDb: -22 });
  const wwv = addPart(score, { id: 'wwv', card: card('wwv-tone'), excitation: 'bow', pan: 0, rmsDb: -27 });
  const hiawatha = addPart(score, { id: 'hiawatha', card: card('hiawatha-vowel'), excitation: 'breath', pan: 0.3, rmsDb: -23 });
  const fdr = addPart(score, { id: 'fdr', card: card('fdr-vowel'), excitation: 'breath', pan: -0.3, rmsDb: -23 });
  const glass = addPart(score, { id: 'glass', card: card('freesound-wineglass'), excitation: 'bow', pan: 0.6, rmsDb: -24 });
  const buzzerBreath = addPart(score, { id: 'buzzer-breath', card: card('uvb76-buzz'), excitation: 'breath', pan: -0.2, rmsDb: -26 });
  const buzzerPluck = addPart(score, { id: 'buzzer-pluck', card: card('uvb76-buzz'), excitation: 'pluck', pan: -0.2, rmsDb: -24 });
  const thud = addPart(score, { id: 'thud', card: card('opz-thud'), excitation: 'strike', pan: 0, rmsDb: -20 });
  const commons = addPart(score, { id: 'commons', card: card('commons-bell-15cm'), excitation: 'strike', pan: 0.8, rmsDb: -32 });

  const strike = (part, t, hzValue, velocity) => addNote(part, { t, hz: hzValue, velocity, seconds: RING });
  const tick = (b, velocity) => strike(commons, at(b, 1), TICK, velocity);
  const kick = (t, velocity) => strike(thud, t, THUD, velocity);

  // Bed: one note per 2-bar unit at hz(c, 207.8), velocity 0.5. Choice: the
  // part's "4 s notes overlapping 0.1 s" → seconds 4.1; stated 8 s notes → 8.
  const bed = (firstBar, chords, { seconds = 4 + OVERLAP, velocity = 0.5, unitBars = 2 } = {}) =>
    chords.forEach((c, i) => addNote(ory, { t: at(firstBar + unitBars * i, 1), hz: hz(c), velocity, seconds }));

  // Stamp(bar, beat): four bells at root M plus thud, all at `velocity`.
  const stamp = (b, y, velocity = 1.0) => {
    const t = at(b, y);
    strike(brass, t, M, velocity);
    strike(plasticCs5, t, cents(M, 408), velocity);   // 526.1
    strike(plasticE5, t, cents(M, 700), velocity);    // 622.6
    strike(plasticA5, t, cents(M, 967), velocity);    // 726.5
    kick(t, velocity);                                // the only thud in its beat
  };

  // Thud rules by bar.
  const thudRefrain = (b) => { kick(at(b, 1), 0.75); kick(at(b, 3), 0.5); };
  const thudLubDub = (b) => { kick(at(b, 1), 0.5); kick(at(b, 1) + 0.25, 0.25); };
  for (let b = 1; b <= 8; b++) thudRefrain(b);
  for (const [lo, hi] of [[9, 20], [33, 40], [57, 64], [81, 88]]) for (let b = lo; b <= hi; b++) thudRefrain(b);
  for (let b = 21; b <= 30; b++) kick(at(b, 1), 0.5);
  for (let b = 41; b <= 56; b++) thudLubDub(b);
  for (let b = 65; b <= 78; b++) for (let y = 1; y <= 4; y++) kick(at(b, y), 0.5);
  for (let b = 89; b <= 96; b++) { kick(at(b, 1), 1.0); kick(at(b, 3), 0.75); }
  for (let b = 101; b <= 104; b++) thudLubDub(b);
  // (bars 31-32, 79-80, 97-100: Stamp strokes only; bar 105 below.)

  // A refrain's shared texture: brass Motif F at M every 2 bars (velocity rule),
  // plus optional plastic-E5 double at 2M (same rule) and plastic-Cs5 at M (0.5).
  const refrainF = (bars, { double = false, cs5 = false } = {}) => {
    for (const b of bars) {
      strikeMotif(brass, MOTIF_F, M, at(b, 1), 'rule');
      if (double) strikeMotif(plasticE5, MOTIF_F, M2, at(b, 1), 'rule');
      if (cs5) strikeMotif(plasticCs5, MOTIF_F, M, at(b, 1), 0.5);
    }
  };

  // ---- Intro, bars 1-8 -----------------------------------------------------
  tick(1, 0.5);
  addNote(buzzerBreath, { t: at(1, 1), hz: DOM, velocity: 0.5, seconds: 8 });
  addNote(buzzerBreath, { t: at(5, 1), hz: DOM, velocity: 0.5, seconds: 8 });
  bed(5, [0, 0]); // bed enters bar 5 at c = 0 (units 5-6, 7-8)

  // ---- R1, bars 9-20 -------------------------------------------------------
  tick(9, 0.5);
  strikeMotif(brass, MOTIF_F, M, at(9, 1), 'rule');
  strikeMotif(brass, MOTIF_F, M, at(11, 1), 'rule');
  strikeMotif(brass, MOTIF_F, DOM2, at(13, 1), 'rule');
  strikeMotif(brass, MOTIF_F, M, at(15, 1), 'rule');
  refrainF([17, 19], { double: true });
  for (let b = 17; b <= 20; b++) strikeMotif(carillon, A_F, M2, at(b, 1), 0.75);
  bed(9, [0, 0, 5, 0, 3, 0]);

  // ---- Episode 1 (I recalled), bars 21-30, Stamps 31-32 --------------------
  // Choice: plastic-Cs5's canon voice takes its stated dynamic 0.75 flat; brass
  // follows the velocity rule.
  [0, 700, 0, 408, 700].forEach((c, u) => {
    for (const b of [21 + 2 * u, 22 + 2 * u]) {
      strikeMotif(brass, A_F, cents(M, c), at(b, 1), 'rule');
      strikeMotif(plasticCs5, A_F, cents(M, c), at(b, 1) + BEAT, 0.75);
    }
  });
  stamp(31, 1, 1.0);
  stamp(32, 1, 0.5);

  // ---- R2, bars 33-40 ------------------------------------------------------
  tick(33, 0.5);
  refrainF([33, 35, 37, 39], { double: true });
  bed(33, [0, 0, 5, 0]);

  // ---- Episode 2 (II recalled), bars 41-56 ---------------------------------
  for (const b of [41, 47]) {
    sustainMotif(wwv, C_F, M, at(b, 1), 0.25);
    sustainMotif(hiawatha, C_F, CENTRE, at(b, 1), 0.5);
  }
  const EP2 = [0, 3, 5, 0, 6, 3, 5, 0];
  bed(41, EP2);
  EP2.slice(0, 6).forEach((c, u) => addNote(fdr, { t: at(41 + 2 * u, 1), hz: hz(c, BASS), velocity: 0.5, seconds: 4 + OVERLAP }));
  addNote(glass, { t: at(53, 1), hz: M, velocity: 0.5, seconds: 4 });
  addNote(glass, { t: at(55, 1), hz: M, velocity: 0.75, seconds: 4 });
  addNote(hiawatha, { t: at(53, 1), hz: M, velocity: 0.5, seconds: 8 });
  addNote(fdr, { t: at(53, 1), hz: BASS, velocity: 0.5, seconds: 8 });

  // ---- R3, bars 57-64 ------------------------------------------------------
  tick(57, 0.5);
  refrainF([57, 59, 61, 63], { double: true, cs5: true });
  bed(57, [0, 0, 5, 0]);

  // ---- Episode 3 (III recalled), bars 65-78, Stamps 79-80 ------------------
  // Choice: the stated formula 2M*2^(D_f/1200) governs; it gives 1111.4 Hz for
  // the 503-cent degree where the design's prose lists 1112.3 (a 1.4-cent slip).
  for (let n = 0; n < 18; n++) {
    const t = at(65, 1) + 3 * n * BEAT;
    strike(n % 2 === 0 ? plasticA5 : plasticCs5, t, cents(M2, D_F[n % 6]), 0.75);
  }
  for (let b = 65; b <= 78; b++) { strike(buzzerPluck, at(b, 1), BASS_DOM, 0.5); strike(buzzerPluck, at(b, 3), BASS_DOM, 0.5); }
  stamp(79, 1); stamp(79, 2); stamp(80, 1);
  tick(80, 0.5);

  // ---- R4, bars 81-88 ------------------------------------------------------
  tick(81, 0.5);
  refrainF([81, 83, 85, 87], { double: true, cs5: true });
  for (let b = 81; b <= 88; b++) strikeMotif(carillon, A_F, M2, at(b, 1), 0.75);
  addNote(buzzerBreath, { t: at(85, 1), hz: DOM, velocity: 0.5, seconds: 8 });
  bed(81, [0, 0, 5, 0]);

  // ---- Stretto, bars 89-96 -------------------------------------------------
  // Choice: the stretto rule (first note 1.0, rest 0.75) governs every entry,
  // including the carillon's, over the part's summary "stretto 1.0".
  const ENTRIES = [[brass, M], [plasticCs5, DOM2], [plasticE5, M2], [plasticA5, DOM], [carillon, DOM4]];
  for (let e = 0; e < 16; e++) {
    const [part, root] = ENTRIES[e % 5];
    strikeMotif(part, MOTIF_F, root, at(89, 1) + 2 * e * BEAT, (i) => (i === 0 ? 1.0 : 0.75));
  }
  bed(89, [0, 0], { seconds: 8, unitBars: 4 });

  // ---- Stamps, bars 97-100 -------------------------------------------------
  for (let b = 97; b <= 100; b++) {
    tick(b, 0.5);
    [1.0, 0.5, 0.75, 0.5].forEach((v, i) => stamp(b, i + 1, v));
  }
  bed(97, [0, 0]);

  // ---- BEAT, bars 101-104: the band's G# against the President's ----------
  addNote(ory, { t: at(101, 1), hz: CENTRE, velocity: 0.25, seconds: 8 });
  addNote(fdr, { t: at(101, 1), hz: PRESIDENT, velocity: 0.25, seconds: 8 });

  // ---- Bar 105 (208 s): one thud, one tick; ends at 210 s ------------------
  kick(at(105, 1), 1.0);
  tick(105, 0.25);

  return score;
}

// Measured by the check script (scratchpad/symphony/check-4.mjs).
export const FACTS = {
  seconds: 210,
  parts: 14,
  lastOnsetSec: 208,
  notes: { ory: 33, brass: 247, 'plastic-E5': 157, 'plastic-Cs5': 168, 'plastic-A5': 54, carillon: 84, wwv: 14, hiawatha: 15, fdr: 8, glass: 2, 'buzzer-breath': 3, 'buzzer-pluck': 28, thud: 232, commons: 11 },
};
