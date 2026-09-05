# OP-Z — the official guide, end to end

**Lens:** structural map of the instrument from TE's own user guide.
**Primary source:** <https://teenage.engineering/guides/op-z>, guide version **v.1.2.45**,
fetched 2026-09-04. The guide is not one page — it is 24 chapters at
`/guides/op-z/<slug>`; every claim below is from one of those chapter pages unless
labelled otherwise. Local text extracts of all 25 fetched chapter pages are in
`/private/tmp/claude-501/-Users-ian/8dfb13e8-6a23-4778-85ed-48bf07c0301e/scratchpad/opz/*.txt`
(scratch — re-fetch rather than trust if this note outlives the session).

Evidence labels used throughout:
- **[DOC]** stated in TE's guide.
- **[DOC-DOM]** read out of the guide page's live DOM (colour swatches that the
  text extraction loses); still TE's own content, just not textual.
- **[INF]** my inference from two or more DOC facts. Flagged as such.
- **[UNK]** the guide does not say. Not guessed.

---

## 0. What this changes for Yellowjacket (read this first)

Four things in `docs/CONTRACT-WIRE.md` need attention. They are stated here once
and not repeated:

1. **`samplepacks/1-kick .. 4-fx` is wrong on two counts.** [DOC] Track 4 of the
   drum group is **sample**, not fx — FX1/FX2 are *control* tracks 9 and 10 and
   have no sample slots at all. And the guide says sound files go into **track
   folders 1–8** (not 1–4), each holding **10 slot sub-folders**, i.e. 80 slots,
   because tracks 5–8 take the synth format in the same tree. The guide never
   prints the literal folder names on disk. **[UNK]** — the authoritative naming
   is in `how_to_import.txt` on the content-mode disk, which Dr. Helfrich can
   read directly since the unit is connected.
2. **The 12 s / 44.1 kHz / 24-slot drum contract is confirmed** [DOC]: "a single
   audio file, up to 12 second long and fully compatible with the OP-1 drum kit
   file format", "24 different sounds across the musical keyboard". So
   `PATCH_SLOTS = 24` and `PATCH_MAX_FRAMES = 529200` are right against TE's own
   words, independent of the factory-file hex work.
3. **Synth-track sample limit is 6 s** [DOC] ("an up to 6 second long chromatic
   sample"), matching the contract's out-of-scope note.
4. **The drum-track note base is still undocumented** [UNK] — the contract's
   "ship a LEARN capture, never hardcode a guess" holds. But two DOC facts
   narrow it: the keyboard is **two octaves = 24 keys**, and a drum kit is
   **24 slices "distributed across the musical keyboard"**. **[INF]** slice
   index = incoming note − base, one slice per key, base shifting with the
   transpose/octave buttons. So LEARN needs to capture a base *and* Yellowjacket
   should expect it to move when the user presses − / +.

Genuinely new capability the guide hands us: **a complete incoming-MIDI CC map**
(section 8). Yellowjacket's WIRE layer can drive every OP-Z track parameter by
CC, absolute or relative, without any reverse engineering. That is a real
addition to `js/midi/wire.js`, not a refinement.

---

## 1. Architecture: the hierarchy TE prints

[DOC, `interface-overview`]

| level | count |
|---|---|
| projects | **10** |
| patterns per project | **16** |
| tracks per pattern | **16** |
| steps per track | **16** |
| pattern chains per project | **14** |
| step components | **14** |
| mute groups per project | **10** |
| ticks per step | **24** |

16 tracks = **8 audio + 8 control**. All 16 sequence identically and all 16
send and receive MIDI, each on its own channel. [DOC, `tracks` 11.1]

---

## 2. The sixteen tracks

[DOC, `tracks` 11.2] The overview grid, in device order:

| # | track | group | role |
|---|---|---|---|
| 1 | KICK | drum | sample kit |
| 2 | SNARE | drum | sample kit |
| 3 | PERC | drum | sample kit |
| 4 | SAMPLE | drum | sample kit |
| 5 | BASS | synth | mono |
| 6 | LEAD | synth | 3-note poly |
| 7 | ARP | synth | arpeggiator, mono input |
| 8 | CHORD | synth | 4-note poly |
| 9 | FX1 | control | send effect 1 |
| 10 | FX2 | control | send effect 2 |
| 11 | TAPE | control | audio buffer / beat repeat |
| 12 | MASTER | control | transpose + chord progression + master fx |
| 13 | PERFORM | control | punch-in effects on all tracks |
| 14 | MODULE | control | expansion module / 16 MIDI CCs / audio I/O |
| 15 | LIGHTS | control | DMX |
| 16 | MOTION | control | visuals (photomatic / motion, via app) |

Note the ordering: the TE grid reads **column-wise** (drum group, synth group,
then two columns of control tracks), so PERFORM is 13 and MODULE 14 while
LIGHTS is 15 and MOTION 16.

### 2.1 Drum group, tracks 1–4 [DOC, `tracks` 11.3]
- **Two-note polyphony per step**, per track.
- All four are sample based: **24 sounds ("slices") across the musical
  keyboard** = one **kit**, "compatible with the OP-1 drum kit file format".
- **Four kits together is called a sample pack.**
- Loaded via the app or content mode.

### 2.2 Synth group, tracks 5–8 [DOC, `tracks` 11.4]
- Any of the synth engines, **or** OP-1-format sample sounds.
- **bass** — monophonic, one note per step. *"the main source for the master
  track transpose analysis."*
- **lead** — polyphony **3**.
- **arp** — arpeggiator; monophonic; notes placed on the same step are
  arpeggiated. Has a dedicated arp page **replacing** the LFO page.
- **chord** — polyphony **4**. `general.json: generous_chords` raises track
  polyphony 4 → 6 but **not** notes per step, which stays 4. [DOC, `reference` 24.3]
- Parameter pages are identical for bass / lead / chord: synth, envelope, lfo,
  send. Arp swaps lfo → arp.

### 2.3 FX1 / FX2, tracks 9–10 [DOC, `tracks` 11.6]
- One send effect assigned per track. Assign: hold **track** + a lit black key;
  the current effect blinks. Additional effects and their arrangement come from
  the app **configurator**.
- Hold **shift** on an fx track to audition — it plays the previously selected
  drum/synth track through the current fx settings.
- Hold **shift** + a track button to edit *that* track's send level: single
  press toggles on/off, **hold one second** to edit with the green dial.

### 2.4 Tape, track 11 [DOC, `tape`]
- An audio buffer **constantly recording while in playback**; beat-repeat and
  tape tricks.
- **White keys** choose where in the buffer playback begins.
- **Black keys** choose loop length, **1 shortest → 0 longest**.
- Pitch bend on the tape track = live tape-stop.

### 2.5 Master, track 12 [DOC, `master`]
- OP-Z **automatically analyses notes on bass, lead, arp, chord** to detect key
  and mode of the active pattern; **bass is the primary source**.
- Piano keys transpose / change key and mode. Choose which tracks follow by
  holding **shift** + track buttons (lit LED = included). Transpose buttons
  change the octave, shown on the value keys.
- Program chords onto the master track like notes to get progressions.
  **Playback speed**: hold **track + shift** and pick a value key — *4 gives a
  four-bar loop* (available since **OS 1.2.12**). Lower speed = longer sequence.
- **Note styles: latch and free** (hold track, blue dial). *latch* quantizes to
  even steps with no micro timing and holds programmed notes to end of bar;
  *free* has micro timing and no latching.

### 2.6 Performance, track 13 [DOC, `tracks` 11.9]
- Applies punch-in effects to **all tracks at once**. Hold track + perform.
- Hold piano keys to add effects; record / copy / delete them exactly like notes.
- This is where punch-in effects recorded from any audio track land. [DOC, `punch-in-effects` 16.2]

### 2.7 Module, track 14 [DOC, `tracks` 11.10, `input-selection`]
- Interfaces with **ZM–1 oplab**, **ZM–2 rumble**, **ZM–4 line** (sold separately).
- **With no module inserted it acts as a MIDI track with 16 independent MIDI CC
  values.**
- Also carries audio I/O input selection. The external input path has filter,
  LFO, fx sends, pan and volume "just like on any instrument track", and shares
  the bass/lead/chord parameter-page layout.
- Source select on the I/O track: **shift + 1** internal mic, **shift + 2**
  headset, **shift + 3** USB audio, **shift + 0** monitor raw input (main out is
  muted; the guide warns this can be much louder than the synth).

### 2.8 Lights, track 15 [DOC, `lights`]
- DMX over a **USB DMX interface** plugged straight into the USB-C port (a
  powered hub is advised — the OP-Z supplies max 100 mA [DOC, `usb`]).
- Up to **16 fixtures**; value keys pick one of **10 patterns**; white keys
  trigger effects/animations.
- `dmx.json` in content mode maps sequencer data to channels. **Max 128
  channels total.** Channel types, all `0–255` unless noted:
  `red, green, blue, white, color` (colour wheel), `intensity`,
  `fog` (0 or 255, triggered by **animation 14**), `knob1..knob4` = green/blue/
  yellow/red dial on **page 1**, `knob5..knob8` = the same four dials on
  **page 2**, a literal `0–255` custom fixed value, `on` = 255, `off` = 0.

### 2.9 Motion, track 16 [DOC, `tracks` 11.12, `app`]
- Visual sequencing through the app: **photomatic** (photos/video) or **motion**
  (2D/3D Unity graphics via the free **videolab** toolkit).
- A photomatic camera roll = **24 image slots**, played from the piano keys on
  track 16. **10 rolls** available; shift + black keys 1–10 switches roll.
  Videos max **10 seconds**. Formats: png, jpg, mp4, mov, gif (iOS/macOS only).
- Motion: black keys cut between cameras, white keys apply held effects.

---

## 3. Parameter pages — the actual colour map

This is the part the guide's text does not carry: the "led color" column of the
4.3 reference chart is rendered as SVG swatches injected at runtime. Read out of
the live DOM [DOC-DOM]:

**Page identity is semantic, not positional.** The LED colour tells you *which
kind* of page you are on, and tracks with fewer pages simply omit the ones they
do not have. The four page colours are:

| page colour | what the page is | green dial | blue dial | yellow dial | red dial |
|---|---|---|---|---|---|
| **WHITE** `rgb(255,255,255)` | main / synth | param 1 | param 2 | filter (cutoff) | resonance |
| **GREEN** `rgb(33,186,69)` | envelope | attack | decay | sustain | release |
| **PURPLE** `rgb(162,86,179)` | LFO | lfo amount (depth) | lfo speed | lfo target | lfo shape |
| **AMBER** `rgb(250,180,19)` | send / mix | fx1 send | fx2 send | pan | level |

Per-track deviations, verbatim from the chart:

| track(s) | pages, in shift order |
|---|---|
| **kick / snare / perc / sample** | WHITE: **pitch, reverse, filter, resonance** · GREEN: attack, decay, sustain, release · PURPLE: lfo amount, lfo speed, lfo target, lfo shape · AMBER: fx1 send, fx2 send, pan, level |
| **bass / lead / chord / module** | WHITE: param 1, param 2, filter, resonance · GREEN: ADSR · PURPLE: LFO · AMBER: sends |
| **arp** | WHITE: param 1, param 2, filter, resonance · GREEN: ADSR · **CYAN** `rgb(0,173,227)`: **arp speed, arp pattern, arp style, arp range** · AMBER: sends |
| **fx1 / fx2** | WHITE: param 1, param 2, filter, resonance · PURPLE: LFO. **Two pages only** — no envelope, no sends. |
| **tape** | WHITE: **speed, fine tune, filter, resonance** · AMBER: fx1 send, fx2 send, pan, level. **Two pages.** |
| **master** | WHITE: **chorus, drive, filter, resonance**. **One page.** |
| **motion** | WHITE: 1,2,3,4 · GREEN: 5,6,7,8 · PURPLE: 9,10,11,12 · AMBER: 13,14,15,16 (16 numbered controls) |
| **lights** | WHITE: **color, alt color, pattern speed, intensity** · AMBER: 5,6,7,8 |

Note the drum tracks' page-1 green dial is **pitch** and blue is **reverse** —
not param1/param2. And note the drum page-4 red dial is **level**, matching CC16
"volume" in the MIDI table.

Toggle pages with a **press-and-release of shift**. [DOC, `parameter-pages` 4.2]
The parameter LED next to each dial shows the value three ways: a gradual
min–max brightness ramp; the same with a **green neutral state at 50 %**; or
discrete colour segments for toggled values. [DOC, `interface-overview` 2.3]

Pro-tip TE prints and that matters for a MIDI layer: **hold** shift + turn a
dial = *temporary* tweak that reverts on release. Distinct from press-release.

### 3.1 LFO detail [DOC + DOC-DOM, `parameter-pages` 4.4]

- **depth** — middle position = LFO **disabled**. Right adds to the target, left
  subtracts. For bipolar LFO signals the depth direction sets which way it
  goes first.
- **rate** — tempo-synced to the **left** of centre, in this order outward:
  `1/64, 1/32, 1/16, 1/8, 1/4, 1/2, 1/1, 2/1`. Turning **right** of centre gives
  a **free, non-tempo-synced** rate.
- **destination** — cycles eight targets, each with its own LED colour:

  | colour | destination |
  |---|---|
  | green | parameter 1 |
  | blue | parameter 2 |
  | amber | filter cutoff |
  | red | filter resonance |
  | orange | attack |
  | purple | pitch |
  | cyan | pan |
  | off-white | volume |

- **shape** — twelve values. **First six are free-running**, last six **restart
  on every note**:

  | # | free | triggered |
  |---|---|---|
  | 1 | sine | bell |
  | 2 | triangle | triangle |
  | 3 | square | square |
  | 4 | saw | saw |
  | 5 | random | random |
  | 6 | **gyro** | saw (single) |

  `gyro` is the accelerometer shape — TE's own pro-tip is to set LFO destination
  to filter, shape to gyro, and physically tilt the unit. [DOC, `input-selection` 18.4]

---

## 4. Track-level parameters (hold **track** + dial)

[DOC, `track` 5.2]

| dial | parameter | range / values |
|---|---|---|
| green | **note length** | **1/64 note → a whole bar**; fully clockwise = **drone**. Affects only notes at default length. |
| blue | **note style** | drums: `retrig, mono, gate, loop` · synth: `poly, mono, legato` · master: `latch, free` |
| yellow | **quantize** | **0–100 %**, applied to live-recorded notes, per track |
| red | **portamento** | **0 = none → 100 = very slow** glide |
| red (tape / module only) | **dry level** | — |

Other **track**-button functions [DOC, `track` 5.3–5.10]:

- **step count** — hold track, press a step button; the track loops across the
  first N steps. **Each of the 16 tracks can have a different step count.**
  This is the pattern-length / track-length independence.
- **step length** — hold **track + shift**, press a value key. Multiplies each
  step's duration, changing that track's playback speed. Step count 16 ×
  length 4 = four bars. **Multiplier 9 makes the track 16× longer.**
  **Multiplier 0 makes the track trig-driven** — it advances one step per trig
  received on the oplab module, or whenever a **jump** step component fires with
  value 0. Increasing step length **lowers timing resolution** for each note.
- **offset notes** — track + −/+ shifts every note on the track one step.
- **select plug** — track + black (value) keys; a lit slot holds a plug
  (sample kit, synth engine, effect). **10 slots.**
- **select preset** — track + a lit **white** piano key.
- **randomize preset** — track + **rec**.
- **store preset** — track + a white key held **two seconds**. **Max 14 presets
  per plug** (14 white keys across two octaves).
- **kill track notes** — track + stop while playing; silences long-release and
  drone notes without stopping playback.
- **link tracks** — hold track + the active track, then press more track
  buttons. Original goes solid white, linked ones blink; playing the original
  triggers the linked. Re-selecting the original unlinks.

---

## 5. Steps: notes, velocity, locks, micro timing

[DOC, `general-operation` 3.4]

| operation | gesture |
|---|---|
| add note | press an empty step → places the **last played note** |
| clear step | press a lit (red) step |
| copy step | press and hold any step → copies to memory |
| paste step | with something in memory, press an empty step |
| edit step note | hold a lit step, press notes |
| **add parameter lock** | **hold any step and turn any dial** |
| clear locks on one step | hold the step + hold **stop** until all steps light (release early to abort) |
| clear locks on the whole track | hold **rec + stop** until all steps light |
| clear all triggers on the track | hold **track + stop** until all steps light |
| note length per step | hold a lit step, press another step |
| **micro timing** | hold a step, press **−/+** → ±1 tick. **24 ticks per step.** LED goes purple; more purple = further from centre |
| preview step | hold a lit step while stopped (also copies it) |
| **velocity** | hold a lit step and use the **pitch bend** strip |

Recording modes [DOC, `general-operation` 3.6]:
- **live**: hold rec while running.
- **step by step**: hold rec while stopped, play the keyboard.
- **parameter lock**: hold rec and turn a dial while running.
- **record lock**: rec + play while playing — latches record on. Release with
  play or stop.
- **record arm**: rec + play while *stopped* — the next note starts record lock.
- **subtractive**: hold **rec + −** → held notes are *removed* from active steps.

---

## 6. Step components

[DOC, `step-components`]

Applicable to **audio tracks 1–8 only**. Each step can carry **multiple**
components. Gesture: hold **shift**, select steps (their LEDs go **green**),
keep holding shift, press the white **component key**, then a **value key 1–0**.
Release shift. Pressing an applied component quickly **removes** it. Momentarily
holding a component key re-opens its setting. **Clear all components on the
current track: shift + stop.**

Full reference chart, verbatim (columns = value keys 1…0):

| component | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 0 |
|---|---|---|---|---|---|---|---|---|---|---|
| **pulse** | count 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | random |
| **pulse hold** | count 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | random |
| **multiply** | ×1 | ×2 | ×3 | ×4 | ×5 | ×6 | ×7 | ×8 | broken chord | quantize |
| **velocity** | −4 | −3 | −2 | −1 | default | +1 | +2 | +3 | mute | random |
| **ramp up** | 2 steps 1 oct | 3/1 | 4/1 | 5/1 | 6/1 | 2 steps 3 oct | 3/3 | 4/3 | 5/3 | 6/3 |
| **ramp down** | 2 steps 1 oct | 3/1 | 4/1 | 5/1 | 6/1 | 2 steps 3 oct | 3/3 | 4/3 | 5/3 | 6/3 |
| **random** | 2 steps 1 oct | 3/1 | 4/1 | 5/1 | 6/1 | 2 steps 3 oct | 3/3 | 4/3 | 5/3 | 6/3 |
| **portamento** | glide 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | direct | random |
| **sweep** | filter up | filter down | synth up | synth down | pan | filter up long | filter down long | synth up long | synth down long | pan |
| **tonality** | ignore chord progression | transpose only | offset octave | offset fifth | offset third | chromatic up | chromatic down | quantize 1 | quantize 2 | quantize 3 |
| **jump** | jump to start | jump to 2/4 | jump to 3/4 | jump to 4/4 | jump forward | jump back | jump to random | stay | align to global track | gate step |
| **parameter spark** | 1 | 1 2 | 1 2 3 | 1 2 3 4 | 1–5 | 1–6 | 1–7 | 1–8 | random | reset counter |
| **component spark** | 1 | 1 2 | 1 2 3 | 1 2 3 4 | 1–5 | 1–6 | 1–7 | 1–8 | random | reset counter |
| **trigger spark** | 1 | 1 2 | 1 2 3 | 1 2 3 4 | 1–5 | 1–6 | 1–7 | 1–8 | random | reset counter |

That is **14 components** = the 14 white keys, matching the hierarchy table.
The three **spark** components are trig-condition style: the value selects which
cycles out of eight the step fires on (setting 9 = random, 0 = reset counter).
TE's pro-tip: combine the three sparks with the note-based components.

Note the interaction with §4: **jump** with value 0 (`gate step`) is what
advances a track whose **step length multiplier is 0** (trig-driven mode).

---

## 7. Project, pattern, chain, bounce

[DOC, `project`]

- **select project**: hold project + value key **1–0** (10 projects). While
  playing, press **play first** to defer the switch to the end of the bar.
- **select pattern**: hold project + a pattern key **1–16**. If running, the
  switch is **instant and keeps the current step position on every track**.
- **chain**: hold project + **play** to enter chain mode; still holding project,
  select **up to 32 patterns**. Save a chain by holding project + a white piano
  key (**14 chains per project**).
- **copy pattern**: project + shift ×1, then destination pattern. Multiple
  destinations while still holding project.
- **copy settings**: project + shift ×2, then destination.
- **copy track**: project + shift ×3, then destination **track 1–16**.
- **copy project**: project + any value key = save active project to that slot.
- **clear pattern**: project + stop, hold until the bar fills. **Clear project**:
  project + stop + shift. Release early to cancel.
- **bounce**: project + **rec** renders a **10-second** audio file of the current
  pattern to disk with a copy of the project. **Max 5 bounces**; a sixth flashes
  a red LED. An active pattern chain bounces, still capped at 10 s. Retrieved
  through content mode.
- **snapshot**: project + **+** stores (overwriting any previous), project + **−**
  recalls (overwriting anything since).
- **saving**: **auto-save is the default.** Manual save mode: hold project +
  track for a few seconds, or hold project while powering on. Manual save =
  project + hold the destination slot.

---

## 8. MIDI

[DOC, `midi`] — the highest-value chapter for Yellowjacket.

### 8.1 Settings (hold **tempo + screen**, then press a key)

| key | setting | effect |
|---|---|---|
| 1 | channel one to active | incoming ch-1 is redirected to the active track |
| 2 | incoming midi | enable |
| 3 | outgoing midi | enable |
| 4 | **midi clock in** | enable incoming clock |
| 5 | midi clock out | enable outgoing clock |
| 6 | alt program change | on: bank 1–16 / program 1–16 selects pattern. off: bank 1 / program 1–128 + bank 2 / program 1–32 |
| 7 | midi echo | echo incoming MIDI back on the same port |
| 8 | enable program change | program change in/out |
| track 1–16 | mute track | mutes all MIDI on that track |
| track 1–16 held 1 s + green dial | **set midi channel** | channel **1–16** per track |

**Incoming MIDI clock is disabled by default.** [DOC, `tempo` 9.8] This is a
real gotcha for the WIRE slice: sending 0xF8 to a factory-state OP-Z does
nothing until key 4 is enabled. When it *is* enabled, clock in auto-arms
external sync, indicated by **track LEDs 1–16 blinking green in groups of four**.

### 8.2 `midi.json` (content mode)

`channel_one_to_active`, `incoming_midi`, `outgoing_midi`, `timing_clock_in`,
`timing_clock_out`, `enable_program_change`, `alt_program_change`, `midi_echo`
(also enables MIDI-through to other ports), `track_enable` — all `true/false`;
`track_channels` `1–16`; **`parameter_cc_out` `0–255`, set per parameter per
track.**

### 8.3 Incoming MIDI table — parameters

Every row: **absolute CC** on channel = track, range 0–127; **relative CC** on
the same channel, where the value is **1 (increment) or 127 (decrement)**.

| parameter | abs CC | rel CC |
|---|---|---|
| parameter 1 | 1 | 32 |
| parameter 2 | 2 | 33 |
| filter cutoff | 3 | 34 |
| filter resonance | 4 | 35 |
| envelope attack | 5 | 36 |
| envelope decay | 6 | 37 |
| envelope sustain | 7 | 38 |
| envelope release | 8 | 39 |
| lfo depth | 9 | 40 |
| lfo speed | 10 | 41 |
| lfo target | 11 | 42 |
| lfo shape | 12 | 43 |
| fx 1 send | 13 | 44 |
| fx 2 send | 14 | 45 |
| pan | 15 | 46 |
| volume | 16 | 47 |
| portamento | 17 | 48 |
| note style | 18 | 49 |

The CC order **is** the page order: 1–4 = white page, 5–8 = green page,
9–12 = purple page, 13–16 = amber page. Portamento and note style (CC 17/18)
are the track-button parameters from §4, reachable over MIDI without the hold.

### 8.4 Incoming MIDI table — system, track, UI

| name | CC | channel | range |
|---|---|---|---|
| track gain | 50 | 1–16 | 0–127 |
| track gain (relative) | 51 | 1–16 | 1, 127 |
| reset track gains | 52 | any | any |
| mute | 53 | 1–16 | 0–1 |
| audio mute | 54 | 1–16 | 0–1 |
| mute group | 55 | any | 0–9 |
| tempo | 56 | any | 0–127 |
| swing | 57 | any | 0–127 |
| track step count | 60 | 1–16 | 1–16 |
| track step length | 61 | 1–16 | 1–16 |
| quantize | 62 | 1–16 | 0–127 |
| note length | 63 | 1–16 | 0–127 |
| **active track** | **102** | **0** | 0–15 |
| **parameter page** | **102** | **1** | **0–3** |
| select pattern | 103 | 1–10 | 0–15 |
| next pattern | 103 | any | 16 |
| previous pattern | 103 | any | 17 |

Real time: **start, stop, continue, clock** (no CC — the standard 0xFA / 0xFC /
0xFB / 0xF8 bytes), **program change** on channel 1–10 value 0–15 or channel
1–2 value 0–127, **pitch bend** on channels 1–16. **Song pointer: not used.
Active sense: not used.**

Two things to flag:
- **"parameter page 0–3" is TE confirming four pages max**, indexed 0–3, and it
  is addressed on **one channel** — so the page index is global to the active
  track, not per track.
- The **channel column reads "0" and "1" for CC 102**, which is not a legal MIDI
  channel number in 1-based terms. [UNK] whether TE means channels 1 and 2 or is
  printing a zero-based index. Do not hardcode; determine by experiment on the
  connected unit before shipping anything that uses CC 102.
- **`select pattern` on channels 1–10 = the ten projects**, value 0–15 = the
  pattern. So CC 103 addresses project *and* pattern in one message.
- Guide internal inconsistency: the on-device table says alt_program_change off
  gives "pattern 1–16" via bank 1/prog 1–128 + bank 2/prog 1–32, while
  `midi.json` says "pattern **1–160**". 160 = 10 projects × 16 patterns, and
  128 + 32 = 160, so **the `midi.json` wording is the correct one** and the
  device table has a typo.

### 8.5 USB [DOC, `usb`]
- USB-C is MIDI, data transfer and charging. Included cable is **C to A**; a
  C-to-C cable must be high quality.
- The OP-Z is also a **USB host** — plug MIDI devices straight in. It supplies
  **max 100 mA**; anything hungrier needs a powered hub.
- **Devices presenting more than one MIDI device are not supported.**
- Tested-good: **OP–1** (direct), **oplab** (needs power, discontinued),
  **Korg microKEY Air 25** (direct, USB only); hub **Kingston Nucleum**;
  adapters **Apple C-to-A**, **Aukey C-to-A**; DMX **Enttec DMXUSB Pro** (direct)
  and **Pro Mk2** (needs power).
- **USB noise**: disable USB charging with **screen + trigger spark** (yellow
  LEDs confirm) — or `screen` + the rightmost piano key **e2**, per
  `hardware-overview` 1.2. [DOC, both places; two gestures for the same thing,
  the guide does not reconcile them]

---

## 9. Sampling on the device

[DOC, `sampling`]

Sources: **built-in microphone** (default when nothing else is selected),
**headset mic**, **USB**, or the **ZM–4 line module**. You can sample to any of
the **eight** instrument tracks.

| action | gesture |
|---|---|
| create user sample pack | hold **track** + an **empty** slot 1–0 |
| remove user sample pack | hold **track** + an existing user slot **for three seconds** |
| enter sample mode | hold **stop + rec** |
| exit sample mode | **stop** |
| preview input | **play** toggles |
| test tone | **track** toggles a **440 Hz** tone (middle A, tuning reference) |
| test tone volume | hold **track** + green dial |
| **input gain** | hold **play** + a top track button **1–16**. **Button 4 (sample track) = 0 dB.** |
| record | hold **rec**, release to stop |
| select source manually | hold **play** + **1–3** |

Source LED, left side of the unit: **green = microphone active, orange =
headset active**. [DOC] (`microphone` adds: **red** when the mic is enabled by
press-and-hold in microphone mode.)

### 9.1 Drum sampler (tracks 1–4)
One audio file, **up to 12 s**, sliced into **24 sounds across the keyboard**,
"fully compatible with the OP-1 drum kit file format".

Primary page, per **active slice**:

| dial | parameter |
|---|---|
| green | sample **start** |
| blue | sample **end** |
| yellow | sample **pitch** |
| red | sample **gain** |

Secondary page (press **shift**, yellow LEDs):

| control | parameter | values |
|---|---|---|
| yellow dial | **direction** | normal / reversed |
| red dial | **playmode** | **gate / trigger / loop** |
| **− / +** | pitch in **half-note steps** | — |
| shift + a note | **copy slice** from the active note position to the pressed one | — |

This maps 1:1 onto the AIFF `APPL op-1` JSON that `js/export/op1patch.js`
already writes: `start[]`, `end[]`, `pitch[]`, `volume[]`, `reverse[]`,
`playmode[]`. **[INF]** the three device playmodes (gate / trigger / loop) are
what the `playmode[]` field encodes; the contract's `8192 = one-shot` is
presumably *trigger*, but the guide never states the numeric encoding. [UNK]
Do not infer the other two values without a hardware capture.

### 9.2 Synth sampler (tracks 5–8)
**Up to 6 s**, chromatic (playable melodically across the keyboard).

Primary page: green **start**, blue **end**, yellow **pitch**, red **gain**.
Secondary page (shift, yellow LEDs): green **loop in**, blue **loop out**,
yellow **direction** (normal/reversed). **− / +** = pitch in half-note steps.

---

## 10. Content mode, disk layout, config files

[DOC, `disk-modes`]

- **Content mode**: hold **track** while powering on. All track LEDs green.
  Mounts as a removable USB disk.
- **Upgrade mode**: hold **screen** while powering on. Kick LED blinks white,
  all parameter LEDs white. Firmware update = drop the file on the disk and
  eject. **Factory reset**: in upgrade mode, hold **screen + stop** for a
  second; done when you see a blinking white LED and four green LEDs.
- Eject is load-bearing: **"any changes you do to the files on the OP-Z disk are
  reflected on the unit after you eject"**, and the unit then resynchronises and
  restarts. You can also eject by pressing **play** in boot mode.
- **Import format is the OP-1 `.aif` sample format** — drum format for tracks
  1–4, synth format for 5–8. Sources TE names: export from an OP-1, build with
  the **OP-1 drum utility**, or download packs.
- Layout: open the **`samplepacks`** folder → **track folders 1–8**, each with
  **ten slot sub-folders 1–10**. **Only one sample pack per slot folder is
  imported; extras are rejected.**
- **Total sample storage: 24 MB.**
- Rejected content reappears in a **`rejected`** folder on the disk next time
  content mode is entered.
- Content-mode permissions:

  | type | add | modify | remove |
  |---|---|---|---|
  | projects | yes | yes | yes |
  | sample packs | yes | yes | yes |
  | bounces | no | no | yes |
  | config | no | yes | no |

- On-disk reference files TE points to: **`how_to_import.txt`** and
  **`how_to_dmx.txt`**. Config files: **`general.json`**, **`midi.json`**,
  **`dmx.json`**.

### 10.1 `general.json` [DOC, `reference` 24.3]
All `true / false`:

| setting | effect |
|---|---|
| `backlit_keys` | all keys dimly lit for dark environments |
| `disable_headphone_db_reduction` | stop reducing output level based on headphone impedance |
| `disable_microphone_mode` | stop engaging the mic when the unit is tilted |
| `disable_param_page_reset` | do **not** reset to page 1 when switching tracks |
| `disable_start_sound` | no power-on sound |
| `disable_track_preview` | no preview sound when selecting a track |
| `generous_chords` | chord track polyphony 4 → 6 (notes **per step** stay 4) |
| `latch_notes_with_shift` | press notes, press shift, release notes to latch |
| `temp_param_add_fx_a` | temporary (shift + knob) tweaks build a slight fx A send |
| `legacy_input_select` | input selection by holding **screen** as an alternative to shift on the i/o track |

---

## 11. Engines

[DOC + DOC-DOM, `reference` 24.1–24.2] Name / description / **param 1** (green
dial, page 1) / **param 2** (blue dial, page 1):

**12 synth engines**

| engine | description | param 1 | param 2 |
|---|---|---|---|
| bow | string synthesis | tension | chorus |
| cluster | clustered oscillators | tone | gravity |
| digital | digital raw engine | octave | feedback |
| electric | complex and transforming | cross mod | x mod |
| saw | filtered waves | envelope | tone |
| shade | smooth piano | detune | drive |
| sample | PCM sample player | crush | *(blank in the chart)* |
| uranus | clean bass | tone | feedback |
| volt | multi oscillator electric synthesis | oscillator variation | oscillator modulation |
| analog | saw, sub, noise with filter envelope | oscillator mix | envelope amount |
| organ | 8 different fm organ algorithms | oscillator algorithm | algorithm tweak |
| ep | 8 different fm piano algorithms | algorithm | tone |

**6 fx engines**

| engine | type | param 1 | param 2 |
|---|---|---|---|
| crush | vector semilinear crusher | amount | cutoff |
| delay | basic digital delay | amount | cutoff |
| dist | overdrive distortion | amount | cutoff |
| rymd | digital reverb | amount | cutoff |
| reverb | clean reverb with light modulation; **piano keys set predelay time** | decay | tone |
| chorus-80 | oldschool chorus | speed | depth |

---

## 12. Punch-in effects

[DOC, `punch-in-effects`] Applies to **audio tracks 1–8**; recordable to the
**performance** track. Gesture: hold **shift** + hold a piano key. **The low
octave affects the current track; the high octave affects the current track
group** (drum group or synth group). Hold **rec** as well, or use record lock,
to capture them.

| key | effect |
|---|---|
| F | duck |
| F# | filter sweep |
| G | loop 1 |
| G# | stereo |
| A | loop 2 |
| Bb | pitch |
| B | follow / echo |
| C | ramp up / fill 1 |
| C# | short |
| D | ramp down / fill 2 |
| **D#** | long |
| E | random |

TE's caption: *"table of punch-in effects, their white keys and black key
settings"* — so the **white** keys (F, G, A, B, C, D, E) are the effects and the
**black** keys (F#, G#, Bb, C#, D#) are settings/modifiers applied to them.

**Guide erratum:** the published chart prints **`C#` twice** — once against
"short" and once against "long". The rows are a strict chromatic run F→E, and
the slot between D and E is D#, so the second one should read **D#**. Recorded
as a TE typo, not as a device behaviour. Verify on hardware before relying on it.

---

## 13. Mixer, tempo, transport, misc

**Mixer** (hold mixer) [DOC, `mixer`]: green **drum group gain** (tracks 1–4 as
one), blue **synth group gain** (5–8), yellow **punch** (master compressor),
red **master** gain. Track keys 1–16 toggle mute; **lit = active**. Mute groups
1–0, **10 per project, the active group stored per pattern**. **Audio-only
mute**: while holding mixer press **shift** (shift lights red) — muted tracks go
red and stop sending audio to the master bus but **keep sending MIDI and keep
feeding the fx and tape tracks**. The two mute types can be mixed and stored per
group.

**Tempo** (hold tempo) [DOC, `tempo`]: green **bpm**, blue **swing**, yellow
**metronome sound**, red **metronome level**. **bpm 40–200**, settable by dial,
by typing digits on the value keys (tempo + 1 + 2 + 0 = 120), or by tapping any
white key. **Nudge**: tempo + momentary −/+ while running. **Lock**: tempo +
shift (toggles). **Swing: 50 % = none.** *Swing applies only to step-programmed
and quantized live-recorded notes* — free live-recorded notes are not swung.
Metronome sounds: **click, swedish, english, german, japanese, italian**; turn
the red dial fully counterclockwise to switch it off.

**Transport / panic** [DOC, `general-operation` 3.2]: play starts from the start
of the pattern and restarts if pressed while running. Stop pauses. **Stop while
stopped = panic** (ends all active notes). **Stop twice while stopped = super
panic** (also clears all audio buffers). Track panic = track + stop; track super
panic = track + stop twice.

> This is the mechanism behind the contract's "kill-note burst after stop".
> The guide documents panic as a *user* action, not as an automatic emission on
> 0xFC. **[UNK]** — TE never documents an outbound note burst on stop. The 50 ms
> suppression window in `wire.js` stands on Yellowjacket's own observation, not
> on the guide; label it that way in the contract rather than implying TE says it.

**Screen** [DOC, `screen`]: hold to show battery (track LEDs 1–16). With the app,
hold screen + turn dials to navigate app pages. Also fires photomatic's camera.
**Index lock**: triple-click any index button to pin the interface at that
screen; press any index button to exit. [DOC, `interface-overview` 2.1]

**Keyboard** [DOC, `interface-overview` 2.9]: **two octaves**. Black keys = the
**value keys**; white keys = the **component keys**. Transpose −/+ changes octave,
shown on the value keys.

**Pitch bend** [DOC, 2.12]: a pressure strip; bends the active audio track, and
also works on **tape** and **master**. Holding a lit step + pitch bend edits that
step's **velocity**.

---

## 14. Open questions — things the guide does not answer

1. **Drum-track MIDI note base.** [UNK] Not printed anywhere. LEARN stays.
2. **The literal `samplepacks` folder names on the content disk.** [UNK]
   `how_to_import.txt` on the disk is the source; the connected unit can settle
   it in one content-mode boot.
3. **`playmode[]` numeric encoding** for gate / trigger / loop in the OP-1 drum
   JSON. [UNK] The guide names the three modes but no values.
4. **CC 102's channel column ("0" and "1").** [UNK] Zero-based index or literal
   channels 1 and 2 — must be measured.
5. **Default track → MIDI channel assignment.** The table says channel 1–16
   addresses track 1–16, and channels are user-settable; whether the factory
   default is the identity map is **[INF] almost certainly yes** but never
   stated outright.
6. **Whether the OP-Z emits anything on receiving 0xFC.** [UNK] — see §13.
7. **What "reverse" on the drum page-1 blue dial does numerically** (the
   contract writes `reverse: 8192` for forward). [UNK] Guide gives the
   normal/reversed toggle, no encoding.
