# 2026-09-07 — Thirteen Cards: a symphony for found instruments, rendered by the bench

Ian's brief, a week ago: real acoustics, found sounds moulded into beautiful
instruments, a true symphony. Tonight the pieces existed to attempt it: the
cards (measured objects), the engine (their physics), the score model (parts
of notes in hertz), the offline renderer (every note a render of its card),
and the mastering. What was missing was a composition that could be argued
from the objects. This note records how it was made and what was measured.
The MP3 and the WAVs are in the session scratchpad; the MIDI sheet, the
design and the modules are in the repository.

## 1. Material

Thirteen cards, all measured today or earlier this week (`docs/lab/cards/`):
four bars of one instrument (three Iowa orchestral bells, anechoic, and a
wine glass), two vowels (Roosevelt's first fireside chat, a LibriVox reader
of Longfellow), a 1921 band chord (Kid Ory), a time signal's tone (WWV), a
Russian buzzer (UVB-76), a carillon, a handbell, a kick drum. Each card
carries its own consonant scale: the dissonance minima of its partials, in
cents, measured, not chosen.

## 2. Design, by a panel

Three designers, each from a different angle (physics-first, form-first,
material-first), wrote a complete four-movement design with closed-form rules
against the inventory and the engine's limits. Nine critics (acousticians,
composers, implementers) scored them; all three recomputed the designs'
arithmetic and found it correct to the tenth of a hertz. Form-first won
narrowly (30.3 / 29.7 / 28.3 of 40) and the synthesis grafted the losers'
best ideas: YIELD (a card sounds once at its own measured pitch, then at the
nearest degree of the host's scale, so the interval heard is the measured
disagreement between two objects: carillon 160 cents, E5 bell 129, buzzer
100), CLIMB stopping at BEAT (the buzzer walks its own scale to 588.7 Hz and
meets WWV's 587.3 Hz, beating at 1.4 Hz; the President's 206.5 Hz meets the
band's 207.8 Hz, beating at 1.3 Hz, to end the piece), and excitation by
measured decay. The design is `docs/lab/symphony/design.json`.

| movement | tuned by | scale (cents, measured) | tempo | length |
|---|---|---|---|---|
| I · Two Metals (sonata) | Iowa brass bell, 557.3 Hz | 0 429 758 812 1098 | 96 | 4:00 |
| II · Fireside (adagio) | the reader, 250.5 Hz | 0 501 603 706 882 1176 | 48 | 3:00 |
| III · Buzzer (scherzo, trio) | Iowa A5 bell, 442.5 Hz | 0 362 549 818 971 | 168 | 2:30 |
| IV · Sunshine (rondo) | the 1921 chord, 207.8 Hz | 0 296 408 503 611 700 800 808 905 967 996 1102 | 120 | 3:30 |

Every pitch in the piece is a card's own pitch, a degree of a card's own
scale at a stated root, or one of those halved or doubled. No twelve-tone
equal temperament is assumed anywhere; the finale's scale is what a 1921
band actually played, eleven of twelve degrees within 12 cents of it.

## 3. Build, by contract

`docs/lab/symphony/CONTRACT.md` fixes the module shape. One agent per
movement implemented its rules literally into `js/score/symphony/`, then an
independent verifier rebuilt the checks from the design and compared: every
named pitch at every named bar, section boundaries, counts, velocities,
holds. All four verdicts were clean; the notes were low-severity, mostly the
design's prose rounding a number the rules compute (525.3 for 525.41). The
suite pins each module's determinism, length, parts, note counts and last
onset.

| | parts | notes | last onset |
|---|---|---|---|
| I | 10 | 619 | 237.5 s |
| II | 7 | 208 | 169.4 s |
| III | 10 | 677 | 148.9 s |
| IV | 14 | 1056 | 208.0 s |

## 4. Render and measurement

`scripts/compose-symphony.mjs` rendered the four movements by the physics in
90 s of machine time (28, 27, 12, 23 s) for 13 minutes of music, every note
one cached render of its card at its pitch, dynamic and length, parts
RMS-normalised over their sounding samples, then mastered each movement to
−15 LUFS / −1 dBTP with the RACK's loudnorm and joined them with two seconds
of silence. The normalisation did large work, as the FIRESIDE lesson said it
would: in IV the wine glass came down 13 dB and the President's vowel up
10 dB to sit where the design put them.

What the numbers caught before anyone listened: the sum of normalised parts
passed full scale in three movements (raw peaks +0.9, +4.7, +2.8 dBFS; 19,
2,809 and 487 samples clamped by the 24-bit write in I, III, IV) before the
limiter ever saw them. The assembler now scales the raw sum to −3 dBFS
before writing; the master re-levels. After the fix:

| | length | integrated | true peak | crest | 10 s RMS range | last sound | clipped |
|---|---|---|---|---|---|---|---|
| I | 241.5 s | −15.0 LUFS | −1.0 dBTP | 17.0 dB | −23.3 … −14.5 dBFS | 238.7 s | 0 |
| II | 180.0 s | −15.0 | −1.0 | 14.5 | −19.1 … −13.0 | 180.0 s | 0 |
| III | 152.9 s | −15.1 | −1.0 | 16.9 | −24.2 … −13.2 | 151.1 s | 0 |
| IV | 212.0 s | −15.0 | −1.0 | 16.9 | −25.2 … −13.8 | 210.5 s | 0 |
| whole | 792.4 s (13:12) | −15.1 | −1.0 | 16.3 | −26.4 … −12.7 | 790.9 s | 0 |

The movements run a second or two past their designed lengths because the
last struck notes ring by physics (a bell at 237.5 s in I rings 1.2 s). The
MIDI sheet (`docs/lab/symphony/movement-N.mid`) rounds pitches to semitones
and says in each track name how far the part's just pitches depart. The
mastered piece is `thirteen-cards.mp3` (and `.wav`) at the repository root,
served locally and never committed; the bench loads it by URL.

## 5. Not yet, and honestly

- Nobody has listened. The measurements say it is balanced, in range and
  not broken; they do not say it is good.
- The vowels are spectral cards with assumed decays; the chord card is a
  chord, not a horn; the two single-mode cards are ticks by construction.
- No reverb: the objects' own decays are the room. Breath notes end at
  note-off with the stated overlaps.
- The MIDI sheet rounds every pitch to the nearest semitone; the score's
  hertz are the truth, and the sheet says by how much each part departs.
