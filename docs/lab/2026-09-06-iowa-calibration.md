# 2026-09-06 — Calibrating the instrument engine on anechoic bars; the INSTRUMENT panel

Ian asked whether Earth Garden (a globe of Freesound field recordings) could
help. The site is ambiences only; the sources behind it are what mattered.
Probed key-free: archive.org holds 3,079 PD/CC0 audio items matching "bell,
glass, bowl, gong, one shot" but almost no lossless isolated strikes; Wikimedia
Commons a handful of PD struck bells (Ogg); Freesound CC0 hundreds of single
strikes behind an API key, previews open. The find was the **University of
Iowa Musical Instrument Samples**: anechoic chamber, 24-bit, every note at
pp/mf/ff, plastic and brass mallets, "may be used for any projects, without
restrictions". Not CC0, so cards only, never the shelf. Downloaded with Ian's
yes: three octaves of orchestral bells C5–B5 (plastic ff, plastic pp, brass),
one Commons bell, two Freesound previews.

## 1. What the anechoic bars measured

Probe scripts in the session scratchpad (`calib3.mjs`); cards for C#5, E5, A5
(plastic ff) and C#5 (brass) in `docs/lab/cards/iowa-bells-*.json`.

| quantity | measured | engine before | engine after |
|---|---|---|---|
| partial ratios, 24 cards, both mallets | 3.23 · 6.99 · 10.51 · 15.75 (medians); 3.1–3.3 and 6.2–7.2 across the octave | free bar 2.756 · 5.404 · 8.933 | `bar` carries an `arch` (0 free, 1 this set), fitted on the first two overtones |
| classification | ratios 1 : 3.2 : 7 : 10.5 read as "harmonics 1, 3, 7, 11" of a string at 0.98 | string wins on any near-integer set | a string needs half its comb present; loud cards: 13 of 24 read as bars, arch 0.54–1.12; the rest lack a fundamental within 40 dB and stay `unknown` |
| junk modes | lines at exactly 2·f0 at −51 to −59 dB (a preamp's second harmonic) and −60 dB fits become the "lowest mode" | every mode votes | modes under 40 dB below the strongest do not vote; `cardPitchHz` ignores them |
| transients | a wine glass over a table: the 33 ms thump at 350 Hz (Q 36, −27 dB) read as the pitch in the bench | the lowest loud mode is the pitch | modes with under 5 % of the longest ring's Q do not vote on pitch or family |
| room | 2–25 Hz rumble as loud as the notes, even in an anechoic chamber; the pp file sat under it | none | 40 Hz 4th-order high-pass before hit finding and carding (`hits.js`) |
| Q of the fundamental | 1,300–6,000, median 3,400 (ff), 4,400 (brass) | — | unchanged; the carillon's 2,400 is the same class |
| linearity | ff vs pp, 38–52 dB apart: fundamental shift 0.0 cents, 28 partials median 0.00 cents | 14 of 34 cards carried a "law" with r² up to 0.96 implying ≤ 8.9 cents: tracker drift | a law must move the pitch ≥ 12 cents over the hit's own range; 0 of 34 remain; the accepted synthetic law implies 111 |
| mallets | brass vs plastic, 71 partial pairs: within ±4 dB to 8 kHz, +3 dB above; lobe fit τc 0.24 ms for both, r² 0.00 | hardness 1 = 0.2 ms | unchanged: the hard end is where real hard mallets sit; the two mallets are not separable on this instrument |
| tuning | every note 9–10 cents sharp of A440 | — | A = 442 Hz, the instrument's own |

The second column is data; the fourth is the smallest change that makes the
engine agree with it. Each change has a test the data forced.

## 2. Hit finding, made shared

`js/instrument/hits.js` now holds `highpass`, `findHits`, and `bestHit`, used
by the CLI and the bench. The judge ranks distinct modes (within 2 % of a
lower mode counts once), the longest ring, and the residual: the Commons bell
had been carded from three 30 ms lines 20 Hz apart when a partial ringing
0.82 s was available.

## 3. INSTRUMENT panel (bench, SIGNAL rail)

`js/app/instrument-controller.js`. CARD THIS SOUND reads the loaded audio:
a ringing hit becomes a modal card; otherwise the longest steady voiced run
becomes a spectral card at its own f0; otherwise the loudest half second is
read as peaks. The panel prints the pitch, the family in words with its
confidence, mode count, Q range, what is assumed, what bends; a row per mode
(Hz, ratio, Q, level). HEAR renders the card with strike, pluck, bow or breath
at seven pitches through the engine at 96 kHz, normalised to −6 dBFS peak;
KEEP CARD saves the JSON. Freesound CC0 previews load by URL with no code
change (CORS and Range on their CDN, verified).

## 4. Honest limits

- A wine glass (1 : 6.9 : 9.9 : 16.3) reads as a tuned bar at low confidence:
  shells are not in the family table. The confidence now carries how many
  reference slots the measured modes actually fill.
- The pp octave at −49 dBFS yields one to four modes per note; the fitter is
  right to be conservative there.
- Iowa's terms are permissive but not CC0; the four cards here are derived
  instruments, and the recordings are not in the repo.

## 5. UX, from driving the bench myself

Each of these was hit while verifying the panel, so each is a real user path.

- **A link brought you here.** `?url=` now raises a panel at the top of the
  drop zone naming the file and its host with one LOAD IT button, focused on
  arrival; LOAD URL reads as primary whenever its field holds something.
  Fetching still takes the click.
- **The overlay's top was unreachable.** The drop zone centred content taller
  than the window with no scroll, so on a 720 px window the word, the link
  panel and RESUME sat 240 px above the fold. It scrolls now; the panel keeps
  its centre while it fits.
- **HEAR no longer says "play the source once first."** An audition is a
  click, and a click may start the audio context; the engine does it itself.
- **Carding reports progress.** "CARDING · 6 OF 12 HITS JUDGED" in the panel
  and status bar, with a paint between candidates, instead of a frozen button.

## 6. Cards in STUDIO

`js/studio/card-voice.js`. A STUDIO part may carry a card (`track.card =
{ card, excitation }`, preset `card`). The engine schedules a card note as one
render of the physics at that MIDI pitch and dynamic bucket (`renderVoice`,
96 kHz, four velocity buckets, note length in quarter seconds for bow and
breath), played once through the part's strip; a struck card rings as long as
the physics says, a driven one is released at note-off. Renders are cached per
key and warmed between paints whenever the notes change, so playback only
starts buffers it already has; the stereo bounce goes through the same path
offline. The chooser lists the part's card under each excitation, the synth
presets, and the lab's found cards fetched from `docs/lab/cards/` on first use.
The INSTRUMENT panel's → STUDIO puts the card just made on the selected part
and previews its own pitch. Snapshots, undo and `.yjkt` projects carry the
card. Verified in the bench: a Freesound wine glass carded on SIGNAL played
part 1 in STUDIO within one click.

The suite now imports every module under `js/`: a stray parenthesis in the
studio controller had shipped a bench that loaded nothing while sixty groups
stayed green, because the DOM-only modules were never imported by a test.

## 7. Off the main thread; the object's scale; the keyboard; the pads

- **Worker pool.** `workers/instrument-worker.js` + `js/instrument/pool.js`:
  renders and the carding itself run in up to four module workers; replies
  come back by job id, progress streams for the long jobs. Without Worker
  (node, the tests) the same pure functions run in place, so the two paths
  cannot disagree. Carding a 49 s recording that took twelve seconds of
  yielded main-thread time now returns in about two, with the page free.
  STUDIO warms card notes `pool.size` at a time; the INSTRUMENT panel's HEAR
  renders there too. `cardFromSource` moved to `js/instrument/from-source.js`
  so the worker can import it.
- **The object's own scale.** The panel prints the Sethares dissonance minima
  of the card's partials in cents (the wine glass: 234 · 338 · 696 · 866 ·
  1007 · 1203) and USE SCALE hands them to STUDIO snapped to semitones as a
  custom scale (`studio.customScale`, id `custom`, carried by snapshots and
  projects; IDEA writes in it).
- **Keys.** While STUDIO is up, A W S E D F T G Y H U J play the selected
  part from C, K O L P ; carry on, Z and X move the octave. A card part
  renders the note it lacks in a worker and plays it when it lands, and the
  octave around it warms behind.
- **→ PADS.** One render at the card's own pitch under the chosen excitation
  becomes a MACHINE track (`ctx.api.machineAddSample`, asset kind `card`).
- Names: a card is called after its file when the file has a name, else by
  its note and family (D5 TUNED BAR), because a Freesound preview is a number.
