// Thirteen Cards — II. Fireside (Adagio). docs/lab/symphony/design.json
// movements[1], realised literally: 48 bpm 3/4 (beat 1.25 s, bar 3.75 s,
// 48 bars = 180 s), the hiawatha reader's own scale H = [0,501,603,706,882,1176]
// on 250.5 Hz, a four-voice chorale whose alto and bass are a function of the
// soprano (the voicing rule), a B section that thins to glass + FDR ostinato
// under the soprano in augmentation, an A' with the carillon doubling the
// cantus an octave up, and a coda of two 15 s tonic breaths. No randomness:
// every event is a closed-form function of bar and beat.

import { createScore, addPart, addNote } from '../model.js';

export const TITLE = 'Fireside (Adagio)';
export const SECONDS = 180;

// ---- time -----------------------------------------------------------------
const BEAT = 1.25;                    // 48 bpm
const BAR = 3 * BEAT;                 // 3/4 → 3.75 s
const BARS = 48;                      // 180 s
const barStart = (b) => (b - 1) * BAR;           // bars are 1-based
const at = (b, beatIndex0) => barStart(b) + beatIndex0 * BEAT;   // beatIndex0 = beats after the bar start

// ---- pitch ----------------------------------------------------------------
const ROOT = 250.5;                   // hiawatha card's tonal centre
const H = [0, 501, 603, 706, 882, 1176];   // cents, period 1200
const mod6 = (k) => ((k % 6) + 6) % 6;     // non-negative residue
/** hz(k) = 250.5 * 2^((1200*floor(k/6) + H[k mod 6]) / 1200) */
export function hz(k) { return ROOT * Math.pow(2, (1200 * Math.floor(k / 6) + H[mod6(k)]) / 1200); }

// ---- material -------------------------------------------------------------
const MOTIF_C = { degrees: [6, 4, 3, 1, 3, 5, 6], beats: [2, 2, 2, 2, 1, 1, 2] };      // 12 beats = 4 bars = 15 s
const MOTIF_C_AUG = { degrees: MOTIF_C.degrees, beats: MOTIF_C.beats.map((b) => b * 2) }; // 24 beats = 8 bars = 30 s
const C3 = { degrees: [3, 5, 6], beats: [4, 2, 6] };                                     // cadence fragment, 12 beats = 4 bars
const OSTINATO = [0, 3, 1, 3];        // B-section bass degrees, one per bar, sounded an octave under

const OVERLAP = 0.3;                  // sustained notes: seconds = beats*1.25 + 0.3
const sustain = (beats) => beats * BEAT + OVERLAP;
const RING = 4;                       // struck notes: the renderer rings by physics; pass the design's 4

const THUD_HZ = 182.0;
const TICK_HZ = 8 * ROOT;             // 2004.0 Hz

// ---- voicing rule ---------------------------------------------------------
// alto = soprano degree − 2, folded down by octaves until hz ≤ 501 (its F1 494 within 24 cents);
// bass = soprano degree − 3, folded down until hz ≤ 265.
function fold(k, ceilingHz) { while (hz(k) > ceilingHz) k -= 6; return k; }
const altoDegree = (ks) => fold(ks - 2, 501);
const bassDegree = (ks) => fold(ks - 3, 265);

/**
 * One soprano statement of a motif starting at bar `bar` with a degree offset.
 * Returns the onsets [{ t, k, beats, beatOfBar }] so the voicing and the
 * carillon can follow them. `beatOfBar` is 1-based within the bar.
 */
function statement(motif, bar, offset) {
  const out = [];
  let beat = 0;
  motif.degrees.forEach((d, i) => {
    out.push({ t: at(bar, beat), k: d + offset, beats: motif.beats[i], beatOfBar: (beat % 3) + 1 });
    beat += motif.beats[i];
  });
  return out;
}

/**
 * A chorale section: soprano phrases of Motif C at `bars` with `offsets`;
 * alto and bass re-attacked at every beat-1 soprano onset, holding until the
 * next beat-1 onset; the final hold ends exactly at `terminusSec`.
 * `onCantus(onset)` is called for every soprano onset (A' hangs the carillon on it).
 */
function chorale({ wwv, hiawatha, fdr }, bars, offsets, terminusSec, onCantus) {
  const beatOneOnsets = [];
  bars.forEach((bar, i) => {
    for (const o of statement(MOTIF_C, bar, offsets[i])) {
      addNote(wwv, { t: o.t, hz: hz(o.k), velocity: 0.25, seconds: sustain(o.beats) });
      if (onCantus) onCantus(o);
      if (o.beatOfBar === 1) beatOneOnsets.push(o);       // notes 1, 4 and 6 of every phrase
    }
  });
  // Choice: a re-attacked hold is a sustained note, so it takes the +0.3 s
  // overlap like every other sustained note; the section's final hold is the
  // one the design pins to the bar end (60.0 / 150.0 s), so it gets no overlap.
  beatOneOnsets.forEach((o, i) => {
    const next = beatOneOnsets[i + 1];
    const seconds = next ? (next.t - o.t) + OVERLAP : terminusSec - o.t;
    addNote(hiawatha, { t: o.t, hz: hz(altoDegree(o.k)), velocity: 0.5, seconds });
    addNote(fdr, { t: o.t, hz: hz(bassDegree(o.k)), velocity: 0.5, seconds });
  });
}

// ---- the movement ---------------------------------------------------------
export function movement({ cards }) {
  const score = createScore({ title: TITLE, sampleRate: 48000 });
  const need = (id) => { const c = cards[id]; if (!c) throw new Error('movement 2 needs card ' + id); return c; };

  const wwv      = addPart(score, { id: 'wwv',      card: need('wwv-tone'),            excitation: 'bow',    pan: 0,    rmsDb: -26 });
  const hiawatha = addPart(score, { id: 'hiawatha', card: need('hiawatha-vowel'),      excitation: 'breath', pan: 0.3,  rmsDb: -22 });
  const fdr      = addPart(score, { id: 'fdr',      card: need('fdr-vowel'),           excitation: 'breath', pan: -0.3, rmsDb: -22 });
  const glass    = addPart(score, { id: 'glass',    card: need('freesound-wineglass'), excitation: 'bow',    pan: -0.6, rmsDb: -24 });
  const carillon = addPart(score, { id: 'carillon', card: need('carillon-bell'),       excitation: 'strike', pan: -0.5, rmsDb: -28 });
  const thud     = addPart(score, { id: 'thud',     card: need('opz-thud'),            excitation: 'strike', pan: 0,    rmsDb: -22 });
  const commons  = addPart(score, { id: 'commons',  card: need('commons-bell-15cm'),   excitation: 'strike', pan: 0.8,  rmsDb: -32 });
  const voices = { wwv, hiawatha, fdr };

  // The minute: one tick at 0, 60, 120 s.
  for (const t of [0, 60, 120]) addNote(commons, { t, hz: TICK_HZ, velocity: 0.25, seconds: RING });

  // A, bars 1-16 (0-60 s): four phrases of Motif C at bars 1, 5, 9, 13, offsets [0,0,3,0].
  chorale(voices, [1, 5, 9, 13], [0, 0, 3, 0], barStart(17), null);

  // B, bars 17-28 (60-105 s).
  for (const o of statement(MOTIF_C_AUG, 17, 0)) addNote(wwv, { t: o.t, hz: hz(o.k), velocity: 0.25, seconds: sustain(o.beats) });
  for (const o of statement(C3, 25, 1)) addNote(wwv, { t: o.t, hz: hz(o.k), velocity: 0.25, seconds: sustain(o.beats) });
  for (const bar of [17, 21, 25]) addNote(glass, { t: barStart(bar), hz: hz(0), velocity: 0.75, seconds: 15 });
  for (let bar = 17; bar <= 28; bar++) addNote(fdr, { t: barStart(bar), hz: hz(OSTINATO[(bar - 17) % 4]) / 2, velocity: 0.5, seconds: BAR + OVERLAP });
  // hiawatha silent in B.

  // Heartbeat, bars 17-46: lub at beat 1 (0.5), dub 0.625 s later (0.25). Last pair 168.75 / 169.375 s.
  for (let bar = 17; bar <= 46; bar++) {
    addNote(thud, { t: barStart(bar), hz: THUD_HZ, velocity: 0.5, seconds: RING });
    addNote(thud, { t: barStart(bar) + 0.625, hz: THUD_HZ, velocity: 0.25, seconds: RING });
  }

  // A', bars 29-40 (105-150 s): three phrases at bars 29, 33, 37, offsets [0,3,0];
  // the carillon strikes 2*hz(k_s) at every soprano onset. Glass silent.
  chorale(voices, [29, 33, 37], [0, 3, 0], barStart(41), (o) => {
    addNote(carillon, { t: o.t, hz: 2 * hz(o.k), velocity: 0.25, seconds: RING });
  });

  // Coda, bars 41-48 (150-180 s): the tonic chord in two 15 s breaths at bars 41 and 45,
  // pressure 0.5 then 0.25; the voices alone after the heartbeat stops.
  [[41, 0.5], [45, 0.25]].forEach(([bar, velocity]) => {
    const t = barStart(bar);
    addNote(fdr,      { t, hz: hz(-6), velocity, seconds: 15 });   // 125.25
    addNote(hiawatha, { t, hz: hz(0),  velocity, seconds: 15 });   // 250.5
    addNote(wwv,      { t, hz: hz(6),  velocity, seconds: 15 });   // 501.0
    addNote(glass,    { t, hz: hz(3),  velocity, seconds: 15 });   // 376.6
  });

  return score;
}

// Measured by the check script (scratchpad/symphony/check-2.mjs).
export const FACTS = {
  seconds: 180,
  parts: 7,
  lastOnsetSec: 169.375,
  notes: { wwv: 61, hiawatha: 23, fdr: 35, glass: 5, carillon: 21, thud: 60, commons: 3 },
};

export const BAR_SECONDS = BAR;
export const BEAT_SECONDS = BEAT;
export const BAR_COUNT = BARS;
