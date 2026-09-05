# OP-Z — working reference for Yellowjacket

Synthesis of five research passes run 2026-09-04 against teenage engineering's own
guide (v.1.2.45), TE's OS changelog, named reverse-engineering projects, and Ian's
own OP-Z over USB. This file is the thing to read; the five lab notes below are the
evidence, and each carries the full citation trail.

| Lens | File | What it holds |
|---|---|---|
| TE's guide, all 24 chapters | [`guide.md`](guide.md) | structure, page colours, step components, CC map, engines |
| MIDI in depth + hardware measurement | [`midi.md`](midi.md) | port topology, measured clock histogram, note-base evidence, sysex, probe scripts |
| Files and formats | [`formats.md`](formats.md) | disk tree, `.aif` schemas, `.opz` byte layout, budget arithmetic |
| Community / open source | [`community.md`](community.md) | project inventory + licences, field semantics, firmware wall, the honest gripes |
| Where Yellowjacket can help | [`gaps.md`](gaps.md) | friction walk-through, ranked opportunities, cheapest way to close each unknown |
| **Ian's own device, content mode** | [`device-scan.md`](device-scan.md) | **read-only scan of the real disk** — settles a dozen open questions and opens one new disagreement |

**The device scan changes conclusions the five research passes reached, and it outranks them
where they conflict.** It was taken in content mode off Ian's own unit, so it is direct
evidence rather than published claim. What it settled: the `samplepacks` folder and slot names
(`01`…`10`, eight track folders — the Z-PO reading was right and the community guide wrong);
the project filenames (`project01..10[f].opz`) and their real size; `bounce.wav`'s format; that
a device-written synth patch really is **exactly** 264 600 frames; and the whole
`track_channels` map, read straight out of `config/midi.json`. What it opened: **the OP-Z
writes drum patches that differ from CONTRACT-WIRE's schema in six ways**, including
`drum_version: 3` and `playmode: 16384` — see §3.9 item 1, which is now the most important
entry in this file.

**Confidence key, used throughout.**

| Tag | Meaning |
|---|---|
| **DOC** | teenage engineering says it. Chapter/section given. |
| **MEAS** | Measured on this Mac against Ian's OP-Z, 2026-09-04. Reproducible. |
| **RE** | Reverse-engineered by a named project, source read. Project named, never "the community". |
| **FORUM** | A forum post. Always hedged, never load-bearing. |
| **INF** | Inference from the above. The inference is shown, not hidden. |
| **UNK** | Nobody has published it and it was not measured. Said plainly. |

**Device under test (MEAS).** USB vendor `teenage engineering ab`, product `OP-Z`.
Answers a universal identity request with firmware ASCII `1.2.45+` — TE's newest and
last published OS (2022-03-31). Exposes **one** CoreMIDI input and **one** output port,
both named literally `OP-Z`; all 16 tracks are multiplexed on that pair and separated
only by channel. Also a class-compliant **2-in / 2-out USB audio device at exactly
44 100 Hz** — the same rate the drum-patch format demands. That last fact is not in
TE's documentation anywhere and it is the most useful thing in these notes.

**The target is frozen.** Last firmware 1.2.45 (2022-03-31), 17 releases total; the
hardware was pulled from TE's store around March–April 2025, superseded by the OP-XY.
So the `.aif` contract cannot be broken by a future firmware — byte-exactness is a
permanent investment — and every quirk below is permanent behaviour, not a pending fix.

---

# 1. The instrument in one page

## 1.1 Hierarchy, exact counts [DOC, `interface-overview` §2]

| level | count |
|---|---|
| projects | 10 |
| patterns per project | 16 |
| tracks per pattern | 16 |
| steps per track | 16 |
| pattern chains per project | 14 (a chain may hold up to 32 patterns) |
| step components | 14 |
| mute groups per project | 10 |
| ticks per step | 24 |
| plug slots per track | 10 |
| presets per plug | 14 |

10 projects × 16 patterns = **160 addressable patterns** over MIDI.

## 1.2 The sixteen tracks [DOC, `tracks` §11]

| # | track | group | role |
|---|---|---|---|
| 1 | KICK | drum | 24-slice sample kit |
| 2 | SNARE | drum | 24-slice sample kit |
| 3 | PERC | drum | 24-slice sample kit |
| 4 | SAMPLE | drum | 24-slice sample kit |
| 5 | BASS | synth | **monophonic** — primary source for master key/mode analysis |
| 6 | LEAD | synth | 3-note poly |
| 7 | ARP | synth | mono in, arpeggiated; arp page replaces the LFO page |
| 8 | CHORD | synth | 4-note poly (6 with `generous_chords`, still 4 per step) |
| 9 | FX1 | control | send effect 1 |
| 10 | FX2 | control | send effect 2 |
| 11 | TAPE | control | always-recording buffer, beat repeat, tape stop |
| 12 | MASTER | control | transpose, key/mode, chord progression, master fx |
| 13 | PERFORM | control | punch-in effects across all tracks |
| 14 | MODULE | control | oplab / rumble / line; with no module, 16 free MIDI CCs |
| 15 | LIGHTS | control | DMX, up to 16 fixtures, 128 channels |
| 16 | MOTION | control | photomatic / motion visuals via the app |

The TE grid reads **column-wise**, which is what fixes PERFORM=13 / MODULE=14 rather
than the other way round. Track 14 = MODULE is independently pinned by the oplab guide.

Drum group: **2-note polyphony per step**, 24 slices across the keyboard = one **kit**;
four kits together = a **sample pack**.

## 1.3 Parameter pages — the real colour map [DOC-DOM, `parameter-pages` §4.3]

The page identity is the **LED colour**, and it is semantic, not positional: a track
with fewer pages omits the ones it lacks rather than renumbering. Green/blue/yellow/red
name the four **dials**, not the pages. (The colour swatches are runtime-injected SVG
and are invisible to text scraping — they were read out of the live DOM.)

| page colour | what it is | green dial | blue dial | yellow dial | red dial |
|---|---|---|---|---|---|
| **WHITE** `rgb(255,255,255)` | main / synth | param 1 | param 2 | filter cutoff | resonance |
| **GREEN** `rgb(33,186,69)` | envelope | attack | decay | sustain | release |
| **PURPLE** `rgb(162,86,179)` | LFO | depth | speed | target | shape |
| **AMBER** `rgb(250,180,19)` | send / mix | fx1 send | fx2 send | pan | level |

Per-track deviations, verbatim:

| track(s) | pages in shift order |
|---|---|
| **kick / snare / perc / sample** | WHITE: **pitch, reverse, filter, resonance** · GREEN · PURPLE · AMBER |
| **bass / lead / chord / module** | WHITE: param1, param2, filter, resonance · GREEN · PURPLE · AMBER |
| **arp** | WHITE · GREEN · **CYAN** `rgb(0,173,227)`: arp speed, pattern, style, range · AMBER |
| **fx1 / fx2** | WHITE · PURPLE only. Two pages, no envelope, no sends. |
| **tape** | WHITE: **speed, fine tune**, filter, resonance · AMBER. Two pages. |
| **master** | WHITE: **chorus, drive, filter, resonance**. One page. |
| **motion** | WHITE 1–4 · GREEN 5–8 · PURPLE 9–12 · AMBER 13–16 |
| **lights** | WHITE: color, alt color, pattern speed, intensity · AMBER 5–8 |

Note that on a drum track page 1 is **pitch / reverse / filter / resonance** — the same
two names the OP-1 drum patch carries as `pitch[]` and `reverse[]`. Page toggling is a
press-and-release of shift; **hold** shift + turn a dial is a *temporary* tweak that
reverts on release.

**LFO detail.** Depth centre = LFO disabled; right adds, left subtracts. Rate is
tempo-synced to the **left** of centre in the order `1/64, 1/32, 1/16, 1/8, 1/4, 1/2,
1/1, 2/1`; turning right gives a free non-synced rate. Eight destinations, colour-coded:
green=param1, blue=param2, amber=cutoff, red=resonance, orange=attack, purple=pitch,
cyan=pan, off-white=volume. Twelve shapes: first six free-running (sine, triangle,
square, saw, random, **gyro** — the accelerometer), last six note-triggered (bell,
triangle, square, saw, random, saw single).

## 1.4 Track-button parameters [DOC, `track` §5.2]

Hold **track** + a dial:

| dial | parameter | range |
|---|---|---|
| green | note length | 1/64 note → a whole bar; fully clockwise = **drone**. Affects default-length notes only. |
| blue | note style | drums: retrig / mono / gate / loop · synth: poly / mono / legato · master: latch / free |
| yellow | quantize | 0–100 %, live-recorded notes only |
| red | portamento | 0 (none) → 100 (very slow). On tape/module this dial is dry level instead. |

**Track length independence** is the OP-Z's signature and it lives here:

- **step count** — track + a step button. Each of the 16 tracks can have a different one.
- **step length** — track + shift + a value key. Multiplies each step's duration.
  Count 16 × length 4 = four bars; multiplier 9 makes the track 16× longer; higher
  multipliers **lower** per-note timing resolution. **Multiplier 0 makes the track
  trig-driven**: it advances one step per trig on the oplab module, or whenever a
  `jump` component fires with value 0 (`gate step`).
- Others: offset notes (track + −/+), select plug (track + black key, 10 slots), select
  preset (track + lit white key), randomize preset (track + rec), store preset (track +
  white key, 2 s, max 14), kill track notes (track + stop), link tracks.

## 1.5 Step editing [DOC, `general-operation` §3.4, `interface-overview` §2.10/2.12]

| operation | gesture |
|---|---|
| add note | press an empty step → places the last played note |
| edit step note | hold a lit step, press notes |
| **parameter lock** | **hold any step and turn any dial** |
| clear locks on one step | hold step + hold **stop** until all steps light |
| clear locks on the track | hold **rec + stop** |
| clear all triggers on the track | hold **track + stop** |
| note length per step | hold a lit step, press another step |
| **micro timing** | hold a step, press −/+ → ±1 tick of 24. LED goes purple; more purple = further from centre |
| **velocity** | hold a lit step and use the pitch-bend strip |
| subtractive record | hold **rec + −** removes held notes from active steps |

Recording modes: live (hold rec while running), step-by-step (hold rec while stopped),
parameter lock (rec + dial while running), record lock (rec + play while playing),
record arm (rec + play while stopped).

## 1.6 Step components — the full 14 × 10 chart [DOC, `step-components` §6]

Audio tracks **1–8 only**. Multiple components per step. Gesture: hold shift, select
steps (LEDs go green), press a white **component key**, then a **value key 1–0**.
Pressing an applied component quickly removes it. **shift + stop clears every component
on the track.**

| component | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 0 |
|---|---|---|---|---|---|---|---|---|---|---|
| **pulse** | count 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | random |
| **pulse hold** | count 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | random |
| **multiply** | ×1 | ×2 | ×3 | ×4 | ×5 | ×6 | ×7 | ×8 | broken chord | quantize |
| **velocity** | −4 | −3 | −2 | −1 | default | +1 | +2 | +3 | mute | random |
| **ramp up** | 2 steps/1 oct | 3/1 | 4/1 | 5/1 | 6/1 | 2 steps/3 oct | 3/3 | 4/3 | 5/3 | 6/3 |
| **ramp down** | 2/1 | 3/1 | 4/1 | 5/1 | 6/1 | 2/3 | 3/3 | 4/3 | 5/3 | 6/3 |
| **random** | 2/1 | 3/1 | 4/1 | 5/1 | 6/1 | 2/3 | 3/3 | 4/3 | 5/3 | 6/3 |
| **portamento** | glide 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | direct | random |
| **sweep** | filter up | filter down | synth up | synth down | pan | filter up long | filter down long | synth up long | synth down long | pan |
| **tonality** | ignore chord prog | transpose only | offset octave | offset fifth | offset third | chromatic up | chromatic down | quantize 1 | quantize 2 | quantize 3 |
| **jump** | to start | to 2/4 | to 3/4 | to 4/4 | forward | back | random | stay | align to global track | **gate step** |
| **parameter spark** | 1 | 1-2 | 1-2-3 | 1-2-3-4 | 1–5 | 1–6 | 1–7 | 1–8 | random | reset counter |
| **component spark** | 1 | 1-2 | 1-2-3 | 1-2-3-4 | 1–5 | 1–6 | 1–7 | 1–8 | random | reset counter |
| **trigger spark** | 1 | 1-2 | 1-2-3 | 1-2-3-4 | 1–5 | 1–6 | 1–7 | 1–8 | random | reset counter |

14 components = the 14 white keys. The three **spark** components are trig conditions:
the value selects which of eight cycles the step fires on.

## 1.7 Project, pattern, chain, bounce [DOC, `project` §7]

- **select project** — project + value key 1–0. While running, press **play first** to
  defer the switch to the end of the bar.
- **select pattern** — project + a pattern key 1–16. While running the switch is
  **instant and preserves the current step position on every track**.
- **chain** — project + play, then up to 32 patterns; 14 saved chains per project.
- **copy** — project + shift ×1 = pattern, ×2 = settings, ×3 = track, then destination.
- **clear** — project + stop (pattern), + shift (project). Release early to cancel.
- **bounce** — project + rec renders a **10-second** audio file of the current pattern
  (a chain still caps at 10 s) plus a copy of the project. **Max 5**; a sixth flashes red.
- **snapshot** — project + `+` stores one, project + `−` recalls it.
- **auto-save is on by default.** Manual save mode: hold project + track for a few
  seconds, or hold project while powering on.

## 1.8 Sampling on the device [DOC, `sampling` §17, `input-selection` §18]

Sources: built-in mic, headset mic, **USB**, or the ZM-4 line module. `shift`+1/2/3
selects; `shift`+0 monitors raw input. Enter sample mode with **stop + rec**; hold rec
to record. Input gain: hold play + a top track button (button 4 = 0 dB). Track toggles
a 440 Hz reference tone. Source LED: green = mic, orange = headset, red = mic enabled in
microphone mode.

**Drum sampler (tracks 1–4)** — one file, **up to 12 s**, sliced into **24 sounds
across the musical keyboard**, "fully compatible with the OP-1 drum kit file format".
Per active slice: green = start, blue = end, yellow = pitch, red = gain. Shift page:
yellow = direction (normal/reversed), red = playmode (**gate / trigger / loop**),
−/+ = pitch in half-note steps, shift + a note copies the active slice to that key.

**Synth sampler (tracks 5–8)** — **up to 6 s**, chromatic. Green start, blue end,
yellow pitch, red gain; shift page: green loop in, blue loop out, yellow direction.

That first paragraph is TE confirming `PATCH_SLOTS = 24` and `PATCH_MAX_FRAMES = 529200`
in its own words, independent of the factory-file hex work the contract rests on.

## 1.9 Engines, briefly [DOC, `reference` §24.1–24.2]

12 synth engines with their page-1 params: bow (tension, chorus), cluster (tone,
gravity), digital (octave, feedback), electric (cross mod, x mod), saw (envelope, tone),
shade (detune, drive), sample (crush, —), uranus (tone, feedback), volt (osc variation,
osc modulation), analog (osc mix, envelope amount), organ (osc algorithm, algorithm
tweak), ep (algorithm, tone). 6 fx: crush, delay, dist, rymd, reverb (piano keys set
predelay), chorus-80 (speed, depth) — the first four are all (amount, cutoff).

**Punch-in effects** [DOC, `punch-in-effects` §16], audio tracks 1–8, recorded to the
performance track; low octave = current track, high octave = current track group:
F duck, F# filter sweep, G loop 1, G# stereo, A loop 2, Bb pitch, B follow/echo,
C ramp up/fill 1, C# short, D ramp down/fill 2, **D#** long, E random. *TE's published
chart prints C# twice (for "short" and again for "long"); the rows are a strict
chromatic F→E run, so the second must be D#. Recorded as a TE typo, unconfirmed on
hardware.*

**Mixer** [DOC, §8]: hold mixer — green drum-group gain (1–4 as one), blue synth-group
gain (5–8), yellow punch (master compressor), red master. Track keys toggle mute, lit =
active. Holding mixer then pressing **shift** switches to **audio-only mute**: muted
tracks go red, stop feeding the master bus, but **keep sending MIDI and keep feeding the
fx and tape tracks**.

**Tempo** [DOC, §9]: BPM **40–200**, set by green dial, by typing digits on the value
keys (tempo + 1 + 2 + 0 = 120), or by tapping any white key. Swing on the blue dial,
50 % = none, **applied only to step-programmed and quantized live-recorded notes**.

**Panic** [DOC, `general-operation` §3.2]: stop while stopped = panic (ends all active
notes); stop twice = super panic (also clears audio buffers); track + stop = track
panic. TE documents panic only as a **user gesture** — see §3.9 item 5.

---

# 2. The MIDI map

## 2.1 Wire facts [MEAS + DOC]

- One input port, one output port, both named literally `OP-Z`. No per-track virtual
  ports. All 16 tracks multiplexed by channel. Yellowjacket can match the literal string.
- **Song position pointer and active sense are both "not used"** [DOC, §21.6]. The OP-Z
  cannot be told to continue from a bar position; `0xFB` resumes from where *it* stopped.
  There is never any point sending `0xF2`.
- Transport bytes are standard: `0xFA` start, `0xFB` continue, `0xFC` stop, `0xF8` clock
  at 24 ppqn.
- USB host mode supplies max **100 mA**; devices presenting as more than one MIDI device
  are **not supported**. TE-tested: OP-1 direct, oplab (needs power), Korg microKEY Air
  25; hub Kingston Nucleum; DMX Enttec DMXUSB Pro.
- Changelog 1.2.20 records a real bug where the content disk and MIDI port did not appear
  until the cable was re-plugged (USB-A only). **Re-plug before debugging code.**

## 2.2 Settings, and the three defaults that will look like Yellowjacket bugs

On device: hold **TEMPO + SCREEN** (both index buttons), then press a key. *This combo
moved in firmware 1.2.38 (2021-06-03) — most tutorials online give the old one.*

| key | setting | `midi.json` key |
|---|---|---|
| 1 | channel one to active | `channel_one_to_active` |
| 2 | incoming midi | `incoming_midi` |
| 3 | outgoing midi | `outgoing_midi` |
| 4 | **midi clock in** | `timing_clock_in` |
| 5 | midi clock out | `timing_clock_out` |
| 6 | alt program change | `alt_program_change` |
| 7 | midi echo | `midi_echo` |
| 8 | enable program change | `enable_program_change` |
| track 1–16 | mute track (mutes *all* MIDI on that track) | `track_enable` |
| track held ~1 s + green dial | that track's MIDI channel 1–16 | `track_channels` |

Three traps, each documented, each expensive to debug and cheap to state:

1. **Incoming MIDI clock is DISABLED by default** [DOC, `tempo` §9.8]. Yellowjacket's
   CLOCK OUT will do nothing to a factory-state OP-Z. When enabled, incoming clock
   auto-arms external sync — visible as track LEDs 1–16 blinking green in groups of four,
   or four green LEDs when TEMPO is held.
2. **`channel_one_to_active`** redirects any incoming channel-1 MIDI to the *currently
   selected* track. Channel 1 is a moving target that follows the performer. Deterministic
   per-track addressing needs channels 2–16, or the setting off. One documented exception,
   added 1.2.12: the UI group CCs (102) are always global and are never re-aimed.
3. **Muted tracks swallow incoming notes**, not just outgoing audio [FORUM, corroborated
   by the `track_enable` semantics]. Clock still passes; notes do not.

Factory default states for the eight booleans are **UNK** except `timing_clock_in` (off).

**But Ian's unit is not in the factory state, and that changes which traps apply.** Read
directly out of `config/midi.json` in content mode [MEAS]:

```
channel_one_to_active : true      <- trap 2 IS live on this device
timing_clock_in       : true      <- trap 1 is NOT live; CLOCK OUT will reach it
timing_clock_out      : true
enable_program_change : true
midi_echo             : false
```

So the CLOCK OUT hardware validation in CONTRACT-WIRE §4 should pass on this unit as-is — and
the copy in opportunity 4 is for *other people's* devices, not his. Conversely `channel one to
active` is **on**, so channel 1 on this device is already a moving target that follows the
selected track.

## 2.3 Incoming CC map — parameters [DOC, `midi` §21.6]

Every row: absolute CC on channel = track, range 0–127; paired relative CC where the
value is **1 = increment, 127 = decrement**.

| parameter | abs CC | rel CC | page |
|---|---|---|---|
| parameter 1 | 1 | 32 | WHITE |
| parameter 2 | 2 | 33 | WHITE |
| filter cutoff | 3 | 34 | WHITE |
| filter resonance | 4 | 35 | WHITE |
| envelope attack | 5 | 36 | GREEN |
| envelope decay | 6 | 37 | GREEN |
| envelope sustain | 7 | 38 | GREEN |
| envelope release | 8 | 39 | GREEN |
| lfo depth | 9 | 40 | PURPLE |
| lfo speed | 10 | 41 | PURPLE |
| lfo target | 11 | 42 | PURPLE |
| lfo shape | 12 | 43 | PURPLE |
| fx 1 send | 13 | 44 | AMBER |
| fx 2 send | 14 | 45 | AMBER |
| pan | 15 | 46 | AMBER |
| volume | 16 | 47 | AMBER |
| portamento | 17 | 48 | (track button) |
| note style | 18 | 49 | (track button) |

**The CC order IS the page order** [INF, forced by two DOC tables lining up exactly]:
CC 1–4 = white, 5–8 = green, 9–12 = purple, 13–16 = amber, green→blue→yellow→red within
each. `nbw/opz` independently decodes `dial = (cc-1) % 4, page = floor((cc-1)/4)` [RE],
which is the same grid arrived at from the other direction. High confidence.

**CC numbers are positional, not semantic.** What a CC *means* depends on the track:

| CC | drum 1–4 | bass/lead/chord/module | arp | fx1/fx2 | tape |
|---|---|---|---|---|---|
| 1 | **pitch** | param 1 | param 1 | param 1 | speed |
| 2 | **reverse** | param 2 | param 2 | param 2 | fine tune |
| 3 | filter | filter | filter | filter | filter |
| 4 | resonance | resonance | resonance | resonance | resonance |
| 5–8 | ADSR | ADSR | ADSR | *(page 2 = LFO)* | — |
| 9–12 | LFO d/s/t/shape | same | **arp speed / pattern / style / range** | — | — |
| 13–16 | fx1, fx2, pan, level | same | same | — | fx1, fx2, pan, level |

"CC 3 = cutoff" holds everywhere. "CC 1 = pitch" holds only on tracks 1–4.

## 2.4 Incoming CC map — system, track, UI [DOC, §21.6]

| function | CC | channel | range |
|---|---|---|---|
| track gain | 50 | 1–16 | 0–127 |
| track gain (relative) | 51 | 1–16 | 1, 127 |
| reset track gains | 52 | any | any |
| mute | 53 | 1–16 | 0–1 |
| audio mute | 54 | 1–16 | 0–1 |
| mute group | 55 | any | 0–9 |
| tempo | 56 | any | 0–127 (**0–127 → BPM mapping is UNK**) |
| swing | 57 | any | 0–127 |
| track step count | 60 | 1–16 | 1–16 |
| track step length | 61 | 1–16 | 1–16 |
| quantize | 62 | 1–16 | 0–127 |
| note length | 63 | 1–16 | 0–127 |
| **active track** | 102 | "0" | 0–15 |
| **parameter page** | 102 | "1" | 0–3 |
| select pattern | 103 | 1–10 (= project) | 0–15 |
| next pattern | 103 | any | 16 |
| previous pattern | 103 | any | 17 |

Two readings worth stating:

- **`parameter page, range 0–3` is TE confirming a hard maximum of four pages**,
  addressed globally for the active track rather than per track.
- **CC 102's channel column reads "0" and "1"**, which are not legal 1-based MIDI
  channels. The two research passes split here: one says UNK, the other infers channels 1
  and 2 from the fact that these are the only rows in the whole table with a 0. Treat as
  **INF, unverified** — measure before shipping anything that uses CC 102. A forum report
  also calls CC 102 glitchy on the LFO page. Leaving CC 102 out of a v1 costs nothing.
- **CC 103 addresses project and pattern in one message** — channel 1–10 = project,
  value 0–15 = pattern. Same 160-pattern space as program change.

## 2.5 Track ↔ MIDI channel

**The default map** [RE from `nbw/opz`'s MIT-licensed `opz.yml`, corroborated FORUM-side
by a user complaining "Channel 1 isn't active track, it's the Kick track"]:

| ch | track | ch | track |
|---|---|---|---|
| 1 | KICK | 9 | FX1 |
| 2 | SNARE | 10 | FX2 |
| 3 | PERC | 11 | TAPE |
| 4 | SAMPLE | 12 | MASTER |
| 5 | BASS | 13 | PERFORM |
| 6 | LEAD | 14 | MODULE |
| 7 | ARP | 15 | LIGHTS |
| 8 | CHORD | 16 | MOTION |

Same map for note-off (`0x8n`), CC (`0xBn`) and pitch bend (`0xEn`).

**TE never prints the default table.** Second support [RE]: a real user `midi.json`
(`nickbec10/MIDI_Config_OP-Z_Moog_Sirin`) reads
`"track_channels": [0,1,2,3,4,5,6,0,8,9,10,11,12,13,14,15]` — every track the author did
not touch is in ascending order; only the one he deliberately remapped deviates. So the
identity map is **INF, well-supported**, not DOC. Also note that file is **zero-based**
(0 = MIDI channel 1) although TE's table gives the range as "1 – 16".

Do not copy `opz.yml`'s CC row `189 → lights`; by the pattern of every other block, 189
(channel 14) should be `module`. That is a transcription bug in their file.

**And the map does not have to be assumed at all — it can be read.** `config/midi.json` on
Ian's device reads [MEAS]:

```
track_channels  : [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,0]
parameter_cc_out: 16 x 16 matrix, mostly 1..16 (tracks 6 and 16 carry a 0 in slot 1)
```

Three readings. (a) The array is unambiguously **zero-based** — 0 = MIDI channel 1 — despite
TE's "1 – 16". (b) Tracks 1–15 sit on channels 1–15, i.e. the identity map, which is the
strongest support yet for it being the factory default. (c) **Track 16 (MOTION) is folded back
onto channel 1**, where it collides with KICK *and* with `channel_one_to_active`. Whether that
is a factory quirk or a prior edit is unknown, but a WIRE panel that reads this file gets the
truth instead of guessing — and gets to warn about the collision.

## 2.6 Program change and pattern addressing [DOC §21.3/21.4/21.6]

- `alt_program_change` **on**: bank 1–16 / program 1–16 sets the active pattern.
- `alt_program_change` **off**: the flat 160-pattern space via bank 1 / program 1–128
  plus bank 2 / program 1–32.
- TE's device-settings table writes "pattern 1–16" here and its `midi.json` table writes
  "pattern 1–160". 128 + 32 = 160 = 10 × 16, so the `midi.json` wording is the correct
  one and §21.3 is a typo.
- **Bank Select CC numbers are never named by TE** (standard 0/32 is the obvious guess,
  UNK).
- Changelog: outgoing PC had the alt sense inverted until 1.1.12; incoming PC handling
  was broken until 1.2.8; since 1.2.14 an incoming PC switches pattern **immediately**
  rather than at the next step.

## 2.7 Clock — measured, and the median trap

90 s of passive capture (25 s histogram window, n = 963 intervals) through CoreMIDI:

```
mean   25.4664 ms  ->  98.169 bpm
median 26.0987 ms  ->  95.790 bpm
histogram, 0.25 ms bins:
    0.00 ms     1        <- coalesced arrival
    9.00 ms     1        <- coalesced arrival
   24.50 ms    19
   24.75 ms   386        <- mode A
   26.00 ms   300        <- mode B
   26.25 ms   256        <- mode B
window-of-24 mean: min 97.96, max 105.12, mean 98.18 bpm
```

**The distribution is bimodal, not noisy.** Two tight modes ~1.35 ms apart straddling the
nominal 25.5102 ms period of 98 bpm — this is USB 1 ms frame quantisation, and the mode
weights recover the nominal period exactly. Three consequences, all of which validate
CONTRACT-WIRE §3's ClockIn design as written:

1. **The mean is right and a median would be wrong.** On the same data the mean reads
   98.17 bpm (0.17 % off) and the median reads 95.79 bpm — a 2.4 % error, enough for
   ADOPT to snap to 96 instead of 98. Do not "simplify" the windowed mean into a median.
2. **The ±30 % rejection band earns its keep.** Only 0.17 % of intervals fell outside it,
   but an *unfiltered* window-of-24 containing one coalesced arrival read **105.12 bpm**,
   7 % high — roughly one window in forty would be garbage.
3. **24 intervals = one quarter note**, exactly long enough for the mode ratio to average
   out. Do not shorten the window.

Chromium's Web MIDI on macOS reads the same CoreMIDI receive timestamps, so this
distribution is what `event.timeStamp` will show in the browser. The measurement transfers.

**Caveat [UNK]:** clock was already flowing when the device was attached and no transport
was sent to it, so whether the OP-Z emits clock while its sequencer is *stopped* is
unknown. Do not assume incoming clock implies a running master.

## 2.8 The drum note base — state of play

**Status: still not established, but the shape of the answer is now fixed.**

What is certain [DOC]: a drum track holds **24 sounds across the musical keyboard**, and
the keyboard is **exactly two octaves = 24 keys** (14 white component keys + 10 black
value keys; the count of 10 is pinned three separate ways). Therefore the mapping is
**24 contiguous semitones, slot *i* ↔ base + *i***, and the only unknown is one integer.

TE has never published it. Its incoming MIDI table has **no note rows at all**, and the
OP-1 field's fuller reference says only "note on | ch 1-16 | play synth/drum note |
velocity 1-127". Neither does midi.guide's aggregated OP-Z page.

| source | claim | confidence |
|---|---|---|
| `artaction/Ableton2OP-Z` "OP-Z Template _V04" | drum-rack `ReceivingNote` values are exactly 24 contiguous notes, **52–75**, no gaps (`.als` downloaded, gunzipped, read directly) | **RE artifact, medium-high** — but a template author can pick a range that looks right without testing |
| op-forums #25892 (OP-1 **field**) | "notes start at 53 and go to like 76" | FORUM, low — hedged, different device |
| op-forums #5470 | "the drum sampler responds to notes 53-77 i believe" | FORUM, very low — 53–77 is 25 notes, arithmetically impossible for 24 slots |
| `op-patch-util` README | slot 0 sits 7 semitones below C, i.e. on **F**, so slots run F…E over two octaves | RE, but this is the **OP-1 keyboard layout**, not the OP-Z's MIDI base |

**Verdict: base is 52 or 53; the only artifact that could be inspected favours 52.** Not
good enough to hardcode into a tool whose whole value proposition is that the file lands
on the right pads. **CONTRACT-WIRE's "ship a LEARN capture, never hardcode a guess" is
correct and should not be revisited.** What the research adds is that LEARN only ever
needs to capture *one* note, and two further wrinkles:

- **The base may move under the user's feet.** The −/+ buttons transpose the keyboard and
  change the octave, and changelog 1.1.23 added "full octave range to drum tracks". Whether
  they shift the *receive* window or only the local keyboard is **UNK**. Design LEARN to
  be re-runnable, and verify that 24 consecutive notes land on 24 distinct slices.
- Whether **outgoing** drum notes use the same base as incoming ones is **UNK** (assume
  yes; one capture verifies).

The probe scripts are in [`midi.md`](midi.md) Appendix A. Variant 1 is **passive and
silent** — enable outgoing MIDI, select track 1, play the keyboard bottom to top, read the
lowest note. Thirty seconds, and it settles what the entire public record does not contain.

## 2.9 Sysex — real, partially decoded, and correctly excluded

**MEAS.** The OP-Z answers a universal identity request (`F0 7E 7F 06 01 F7`) with 33
bytes: `F0 7E 7F 06 02 00 20 76 01 58 33 43 4C 41 54 4D 42 31 2E 32 2E 34 35 2B 00×7 06 F7`.
Manufacturer ID `00 20 76` (teenage engineering) is thereby **empirically confirmed**;
ASCII `1.2.45+` is the firmware. The eight bytes `X3CLATMB` decode as nothing recognisable
— probably a board revision code [UNK].

**RE** (`hyphz/opzdoc` wiki, implemented by `patriciogonzalezvivo/libopz`, also `nbw/opz`,
`ayamflow/opz-parser`): frame `F0 00 20 76 01 <command> <data> F7`; all payload is 7-bit
packed (each 8-byte chunk's first byte carries the 8th bits of the following seven); some
payloads are zlib, recognisable by `78 9c` appearing as `78 1c` after packing. Known
commands: `$00` master heartbeat (must be sent ~1/s or telemetry stops), `$01` universal
response, `$03` keyboard setting, `$06` button states, `$0E` sound preset, `$35` file
request, `$62` text/debug commands. The official app is Unity + `keijiro/MidiJack`.

**Keep it excluded.** The `$09` pattern message is still publicly undecoded seven years
on; `libopz` has no write path at all and is **Prosperity-licensed (non-commercial)**;
Chrome gates sysex behind a separate, stronger permission than the one CONTRACT-WIRE
requests. Practical upside of the exclusion: while the OP-Z app is connected, the same
single port carries a heavy telemetry firehose, and Chrome without the sysex flag filters
it out for free.

## 2.10 What the OP-Z will *not* tell you over MIDI [RE, `nbw/opz`]

Track selection, play/stop, octave shift and the screen buttons **do not transmit MIDI on
their own**. Their state can sometimes be inferred from accompanying key or dial traffic,
but there is no direct message. Anything a host wants to mirror from the device's UI state
must be inferred, or read over sysex.

## 2.11 oplab module ZM-1 [DOC, `guides/op-z/modules/oplab`]

MIDI in/out on 3.5 mm, **standard Type A pinout (tip = sink, ring = source)**, stereo
cable required, 5-pin DIN adapter included, explicitly incompatible with reverse-pinout
gear. "**oplab module transmits all midi channels from OP-Z**" — the TRS out is not a
subset of the USB stream. IN is switchable MIDI/TRIG (0–10 V, single-steps tracks armed
with step-length multiplier 0); OUT is switchable MIDI/TRIG/PO (pocket-operator SY2/SY3).
CV/gate is driven by **track 14**: tip = note CV 0…+5 V, ring = CV2 −5…+5 V (green dial);
gate tip 0/+5 V, gate ring = CV3 (blue dial). MIDI in tolerates −10…+10 V. TE's own
pro-tip: set any track's MIDI channel to 14 to route it out of oplab's CV output.

## 2.12 Direction: which way the link is reliable

**FORUM, multiple independent reports** (modwiggler, op-forums): driving external gear
*from* the OP-Z drops notes — "half of the notes are randomly not triggered" — especially
with several channels active, and the device is fussy about cables. Others report no
trouble. No controlled measurement, no TE acknowledgement, no fix in 1.2.45. Real but
unquantified; do not present it to a user as established.

The useful part: that is about the OP-Z as **master**. Yellowjacket's WIRE layer puts the
browser in the master seat and treats the OP-Z as slave and note source, which is the more
reliable direction. If dropped notes show up during hardware validation, check the
direction before blaming the scheduler.

---

# 3. Files and formats, cross-checked against `js/export/op1patch.js`

## 3.1 The content-mode disk

**Entry:** hold **track** while powering on (all track LEDs green) → mounts as removable
USB mass storage. Upgrade mode is **screen** + power. Factory reset is upgrade mode +
screen + stop for a second.

**Import happens on eject.** "Any changes you do to the files on the OP-Z disk are
reflected on the unit after you eject", after which the unit resynchronises and restarts.
Do not power off during that pass. Every validation cycle therefore costs two reboots.

**The tree, measured on Ian's unit** [MEAS, `device-scan.md`] — 34.6 MB volume, 24 MB of it
budgeted for samples:

```
/                                  (content-mode volume root)
├── how_to_import.txt              TE's authoritative import rules
├── how_to_dmx.txt
├── import.log                     per-file import report, written on eject
├── config/
│   ├── general.json  midi.json  dmx.json
│   └── userPresets.dat            351 202 B, binary, in NO published source
├── projects/  project01.opz … project10.opz, plus project<nn>f.opz snapshots
├── samplepacks/
│   ├── 1-kick/  2-snare/  3-perc/  4-fx/
│   ├── 5-bass/  6-lead/  7-arpeggio/  8-chord/
│   └── each with slot subfolders 01 … 10, holding *.aif
├── bounces/ bounce01 … bounce05/{bounce.wav, project.opz}
└── rejected/                      (empty on this device)
```

Firmware (`z_firmware_<a>_<b>_<c>.zfw`) is dropped in this **root** and applied from upgrade
mode [DOC]. That settles three previously-open naming questions: the slot folders are
**`01`…`10`** (Z-PO was right, the community guide's `1`…`10` was wrong), projects are
`project01.opz` (not bare `01`), and snapshots take the `f` suffix on the project name.
`config/userPresets.dat` appears in no published source at all.

**Content-mode permissions** [DOC]:

| type | add | modify | remove |
|---|:--:|:--:|:--:|
| projects | yes | yes | yes |
| sample packs | yes | yes | yes |
| bounces | **no** | **no** | yes |
| config | **no** | yes | **no** |

Note the folder names read `4-fx` even though TE's current guide calls track 4 **SAMPLE**.
Two research passes reached opposite conclusions on this. The resolution is that the disk
names are **legacy internal names**, and the `.opz` project format corroborates it — its
fixed note-slot map reads `kick / snare / hihat / sfx` for tracks 1–4. So
CONTRACT-WIRE's `4-fx` spelling is probably right; what is wrong is the **count and
depth** (4 folders, no slot level → actually 8 folders × 10 slots = 80).

The internal store is **YAFFS2** (`import.log` paths read `/yaffs2/user/...`), so the USB
volume in content mode is a **staging view**. That is why nothing takes effect until eject
and why the device restarts to apply. A slot folder holds exactly one item — a sample
`.aif` or a sound-engine `.engine` — and files prefixed `~` are the device's own
**de-duplication stubs** (zero-byte pointers into the internal image). An empty file there
is normal, not corrupt.

**"The kit tracks are full" is a UI fact, not a storage fact** [MEAS]. On Ian's device all
four drum tracks report 10/10 slots filled, but the scan found **17 real files and 38
zero-byte `~` placeholders** (`~TeKicks.aif`, `~CuckooKicks.aif`, `~AlainFX.aif`, …). The
placeholders occupy a slot in the listing without occupying the sample budget: `import.log`
reports `13.2/24.0 MB` used, so roughly **10.8 MB is free**, and any slot holding a
placeholder can take a real patch by displacing something that was never a file. Any budget
planner must count real bytes, not slots.

## 3.2 The drum patch — CONTRACT-WIRE §1 confirmed twice over

Nothing found contradicts the byte layout in the contract or its implementation. Three
independent corroborations were added:

1. **The fixed-point rule reproduces against a second, unrelated factory file.**
   `position = floor(frame * 2147483646 / 529200)` reproduces all twelve real `end[]`
   values in teoperator's embedded OP-1-written `boombap1` patch, byte for byte. The
   community 4058-per-sample constant drifts by **−453 units at frame 24 062** and
   **−2 979 at frame 158 363**. `op1patch.js:18-23` is right; do not simplify it to a
   multiply. (`op-patch-util` writes `len_bytes * 2029` with the source comment
   "Confusing magic number" — the same approximation.)
2. **The slice-boundary convention is confirmed.** In that file `end[0] = 97643143` is
   frame 24 062 and `start[1] = 97647201` is frame 24 063 — exactly one frame apart.
   `end[i]` = last frame of slice *i*; `start[i+1]` = first frame of slice *i+1*, which is
   what `op1patch.js:60-61` writes.
3. **The 80-bit extended rate bytes are byte-identical in a third writer.**
   `op-patch-util/src/chunks.rs` hard-codes `[64, 14, 172, 68, 0,0,0,0,0,0]` =
   `40 0E AC 44 00 …`. Two independent writers, same bytes.

TE's own words also now confirm the ceilings from the top down: "up to 12 second long and
fully compatible with the OP-1 drum kit file format", "24 different sounds".
`op-patch-util/src/main.rs` carries `let max_len = 44100 * 12 * 2` for drums and
`let target_len = 44100 * 6 * 2` for synth.

Two harmless divergences, recorded so they are not mistaken for bugs:

- **Unused-slot fill.** A real OP-1 parks unused slots on the last real boundary but gives
  slot 23 the file's tail (`start[23]=642638133, end[23]=2032606256` ≈ 11.36 s).
  `op1patch.js:75-78` duplicates the last real slice into every unused slot. Both are
  legal; Yellowjacket's is more predictable.
- **`drum_version`.** Yellowjacket writes 1; teoperator's captured OP-1 file and DigiChain
  write 2. **Both exist in files written by TE hardware.** Whether the OP-Z distinguishes
  them is UNK; v1 patches are reported to work.

## 3.3 The APPL `op-1` JSON — field semantics nobody official states

`AlexCharlton/op-patch-util/src/op1.rs` is the only place these fields are typed and
annotated [RE, source-read]:

| field | type | encoding |
|---|---|---|
| `start[24]`, `end[24]` | `u32` | the fixed-point rule; clamp 0…2147483646 |
| `pitch[24]` | `i16` | **512 units per semitone**, ±24567 ≈ ±48 semitones. Implementation: `pitch[k] = semitones * 512` |
| `reverse[24]` | `u16` | **8192 = forward, 16384 = reverse** |
| `volume[24]` | `u16` | 0 = −inf, **8192 = unity**, 16384 = max; `volume[k] = 8192 * (gain + 1.0)` for gain in −1…+1 |
| `playmode[24]` | `u16` | 0 / 8192 / 16384 — three modes, **which is which is stated nowhere** |
| `dyna_env[8]`, `lfo_params[8]`, `fx_params[8]` | `u16` | ranges annotated with a literal question mark by the author |

`pitch[]` is the interesting one: CONTRACT-WIRE says the OP-Z reads start/end/**pitch**,
and `op1patch.js` writes 24 zeros into it. That is a third of the honoured surface left on
the floor, and the missing constant (512/semitone) is now sourced.

**The "don't care" fields: four writers, four different value sets — and the fourth is the
OP-Z itself.** The last column was read out of `samplepacks/1-kick/10/patch.aif` on Ian's
device, a file the OP-Z wrote [MEAS].

| field | Yellowjacket / CONTRACT-WIRE | `op-patch-util` | `OP-Z-Simple-Tool` | **the OP-Z itself** |
|---|---|---|---|---|
| `drum_version` | `1` | `1` | `1` | **`3`** |
| `dyna_env` | `[0,8192,0,8192,0,0,0,0]` | same | `[0×8]` | **`[0,8192,0,0,0,0,0,0]`** |
| `lfo_params` | `[16000,16000,16000,16000,0,0,0,0]` | `[16000,0,0,16000,0,0,0,0]` | `[16000×8]` | **`[0×8]`** |
| `fx_params` | `[8000×8]` | same | same | — |
| `playmode` | `[8192×24]` | same | `[5119×24]` | **`[16384×24]`** |
| `reverse` | `[8192×24]` | same | `[12000×24]` | — |
| `volume` | `[8192×24]` | same | same | — |
| whitespace | compact, no spaces | compact | compact | **spaced**: `{ "drum_version" : 3, …` |
| extra keys | — | — | — | **`"editable": true`** |

Read carefully, because two conclusions fall out and they point in opposite directions.

- **The third-party writers agree with each other and with the factory hex dump.**
  Yellowjacket's values match `op-patch-util` on five of six, derived independently.
  `OP-Z-Simple-Tool`'s outliers have no provenance but are direct evidence the OP-Z
  **tolerates** non-canonical values in those slots. Every third-party writer emits
  `type:"drum"`, `octave:0`, `drum_version:1`, all 24-long arrays, all keys, alphabetical, and
  they are all reported to import.
- **The OP-Z does not write any of that.** It writes `drum_version: 3` — a version no
  published source mentions — with an undocumented `"editable"` key, whitespace inside the
  JSON, and different filler values. This does **not** prove v1 patches fail: the contract's
  claim is that v1 is what working third-party writers emit and the device reads, and the
  golden checks still pass. What it establishes is that **v1 is not what the device itself
  produces**, and that at least one field Yellowjacket hardcodes differs. Two useful
  side-effects: the device's own file has spaces in the JSON, so **"compact" is Yellowjacket's
  self-imposed constraint and not a device requirement** — the parser tolerates whitespace;
  and a round-trip import path will encounter `drum_version: 3` and `"editable"` in the wild,
  so `parseDrumPatch` must not assume the v1 key set.

**This also resolves the `playmode` argument, against the change the formats pass
recommended.** The device writes **16384**. Under `op-patch-util`'s three-value scheme
(`0 / 8192 / 16384`) that is a legitimate centre; under DigiChain's four-bucket table
(`4096 / 12288 / 20480 / 28672`) 16384 is itself a seam. So the three-value scheme is the one
that applies to OP-1-family drum patches, DigiChain's table describes the OP-1 Field / OP-XY
generation, and **8192 is a valid middle value, not a coin flip.** Do not change the constant
to 12288 — 12288 does not appear in the three-value scheme at all. See §3.9 item 6.

**Do not add** `pan`, `pan_ab`, `stereo`, `attack`, `mtime`, `original_folder`. Those are
OP-1 Field / OP-XY keys — DigiChain scales stereo patches against a **20 s** budget
(`2147483646/(44100*20)`) versus 12 s mono. They buy nothing on an OP-Z.

`op-patch-util/src/chunks.rs` also declares **`COMT`** (AIFF comments). Real OP-1 files can
carry one. `parseDrumPatch` walks chunks generically so it should skip it, but there is no
test proving that.

## 3.4 The synth patch (tracks 5–8) — out of scope today, small delta if wanted

- **Exactly 6 s = 264 600 frames**, mono s16 44.1 kHz — **now confirmed against a
  device-written file** [MEAS]: every synth patch on Ian's disk measures exactly 264 600
  frames. TE says only "up to 6 second"; every hand-import source says the file must be
  exactly 6 s, and a shorter file produces **"sample bleed"** — leftover audio plays until 6 s
  elapse. `op-patch-util` computes a fixed `target_len` and truncates when longer but does
  **not** pad when shorter. Yellowjacket must pad.
- Discriminator is `type:"sampler"` + `synth_version` (2 in `op-patch-util`, 3 in
  DigiChain), with `adsr[8]`, `base_freq`, `fade`, `knobs[8]`, `fx_*`, `lfo_*`. **No**
  `start`/`end`/`pitch` arrays. `lfo_params` defaults differ from the drum type
  (`[16000,0,0,16000,0,0,0,0]`).
- **`base_freq` is reportedly the only field the OP-Z honours** in a synth sample; because
  it defaults to 440, a source not tuned to A maps to the wrong notes. A bench that can
  detect the fundamental and write `base_freq` to match removes that tax entirely — which
  is the actual reason to build this.

## 3.5 The `.opz` project file [RE, Z-PO Project, firmware 1.1.17]

Little-endian memory image (Blackfin ADSP-BF703). **572-byte header** — `u32` file id
`0x00000049` at 0 (**confirmed on disk as the magic `49 00 00 00`** [MEAS]); 16 × 32 B pattern
chains at 4; mixer drum/synth/punch/master levels at 516–519; tempo (40–200) at 520; swing at
565; metronome level/sound at 566–567 — then **16 pattern chunks of 21 392 B each**.

**Real files measure 342 848 bytes** [MEAS]; the Z-PO byte table sums to 342 844 [INF]. Four
bytes are unaccounted for — consistent with the author's own statement that ~48 bytes remain
unidentified, and a reminder that the arithmetic total in the published table is not the file
size. Anyone parsing an `.opz` should read the real length, not compute it.

Pattern = Track[16] params (192 B, 12 B each: plug ID `u32`, step count, `0x05`, step
length, quantize, note style, note length) + Notes[880] (7 040 B, 8 B each: `i32`
duration, note with C1=0, velocity default 100, micro adjust −23…+24, age) + Steps[256]
(13 824 B, 54 B each: `u16` component bitmask, 16 B component params, 18 B lock values,
18 B lock mask) + 288 B parameter values (18 × 16) + 40 B mute config + tape/master send
maps + active mute group.

**Per-step polyphony is baked into the file format** — 55 fixed note slots: kick 0–1,
snare 2–3, hihat 4–5, sfx 6–7 (2 each); bass 8–11, lead 12–15 (4); **arp 16–23 (8)**;
chord 24–27 (4); fx1 28, fx2 29, tape 30 (1); master 31–34; perform 35–40 (6); module
41–46 (6); lights 47–50; video 51–54.

A project's Track chunk stores a **plug ID, not a filename** — so moving a sample between
slots changes what a saved project plays.

The author states **~48 bytes remain unidentified**. `libopz` implements the format
independently, which is the best evidence it is substantially right — but `libopz` has no
write path and exposes no accessor for parsed step components.

## 3.6 Config files [DOC, `reference` §24.3 / `midi` §21.4 / `lights` §15.5]

**`general.json`** — booleans, defaults undocumented: `backlit_keys`,
`disable_headphone_db_reduction`, `disable_microphone_mode`, `disable_param_page_reset`,
`disable_start_sound`, `disable_track_preview`, `generous_chords`,
`latch_notes_with_shift`, `temp_param_add_fx_a`, `legacy_input_select`.

**`midi.json`** — the eight booleans of §2.2 plus `track_enable` (16 booleans),
`track_channels` (16 entries, **zero-based in the real file** despite TE's "1 – 16"), and
`parameter_cc_out` (a **16 × 16** array — one row per track, one entry per dial parameter,
not 18; untouched rows read `[1,2,…,16]`, i.e. **outgoing CC defaults equal TE's incoming
CC numbers**). TE's stated range "0 – 255" for `parameter_cc_out` is impossible on a
7-bit wire; assume 0–127 usable and >127 = unassigned [INF].

**`dmx.json`** — max 128 channels; types red/green/blue/white/colour-wheel/intensity
0–255, fog 0|255 (fired by animation 14), `knob1`–`knob4` = the four dials on page 1,
`knob5`–`knob8` = the same four on page 2, literal fixed value, `on`=255, `off`=0.

## 3.7 The arithmetic nobody does

| quantity | value |
|---|---|
| total user sample space | **24.0 MB**, one shared pool (the device prints `used/24.0 MB` during import) |
| sample slots | 8 track folders × 10 slots = **80** |
| items per slot folder | **exactly one**; extras are rejected |
| full-length drum patch | 529 200 × 2 = **1 058 400 B ≈ 1.01 MB** + ~700 B headers |
| 6 s synth patch | 264 600 × 2 = **529 200 B ≈ 0.50 MB** |
| **kits that actually fit** | **≈ 23 full-length drum kits**, or ≈ 47 synth samples |
| average per slot if all 80 are filled | 25 165 824 / 80 = 314 572 B = **3.57 seconds**, not 12 |

**The byte budget binds long before the slot count does.** Filling all 80 slots at full
length would need ≈ 60 MB. Any copy that implies "80 kits" is wrong; the honest number is
"about 23 full-length kits, fewer if you use the synth tracks". Whether "24mb" means MiB
or MB, and whether it counts file bytes or PCM bytes, is **UNK** — the difference is 23
patches versus 22.

**Measured on Ian's device** [MEAS]: exposed volume 34.6 MB, of which 24 MB is the sample
budget; `import.log` reports **13.2 / 24.0 MB used** across 17 real files plus 38 zero-byte
placeholders; the largest drum patch on the disk is 498 304 frames (11.3 s), comfortably under
the 529 200 ceiling. `import.log` also reports a per-file result and the space after each
import (`importing patch (1).aif...SUCCESS. New used space 15266 kB`), which is a better
progress signal than anything the front panel offers.

## 3.8 How the device fails

- **Rejection is a folder, not an error.** Rejected files appear in `rejected/` on the
  **next** content-mode entry — so a failed import is completely silent at eject time.
  This is the single most useful debugging affordance on the device and almost no tool
  mentions it.
- **More than one file in a slot folder:** one imports, the rest are rejected [DOC].
- **A correct 44.1 / 16-bit / mono AIFF that lacks the `APPL op-1` chunk simply does not
  appear** in content mode, with no error at all [FORUM, consistent across posters]. Users
  repeatedly conclude the device is broken. Double-marking also fails.
- **Malformed content is sometimes accepted and plays wrong** rather than being rejected
  (short synth samples → sample bleed) [FORUM, single careful observer, who reports never
  having seen `rejected/` populate].
- **"Import is keyed on filename" is now doubtful.** A FORUM report (single observer) says
  re-importing a changed file under the same name may be skipped. But the device's own
  `import.log` shows it **renames on import**: `importing patch (1).aif...SUCCESS` followed by
  `assigning perc/09/patch.aif` — the source name is discarded and the file becomes
  `patch.aif` inside the assigned slot [MEAS]. That undercuts filename-keyed dedup as an
  explanation. Treat the forum claim as unconfirmed; a unique export filename is still cheap
  insurance but is no longer a priority.
- **Undocumented content can crash the device or the app** [RE, Z-PO]. Recovery: back up
  in content mode, then factory reset from upgrade mode.
- There is no checksum, no manifest, and no user-visible report other than `import.log`
  after the fact.

## 3.9 Where the code and the research disagree

Nothing in CONTRACT-WIRE is **falsified**. Nine things need correcting, softening, or
re-labelling. Ordered by how likely each is to cost someone real time.

**1 · The OP-Z writes drum patches that do not match CONTRACT-WIRE's schema — in six ways.**
`CONTRACT-WIRE.md` §1, `op1patch.js:82-100`. Read out of `samplepacks/1-kick/10/patch.aif` on
Ian's device, a file the OP-Z itself wrote [MEAS]: `drum_version` is **3**, not 1;
`playmode` is **16384**, not 8192; `dyna_env` is `[0,8192,0,0,…]`, not `[0,8192,0,8192,…]`;
`lfo_params` is all zeros; the JSON **has whitespace** (`{ "drum_version" : 3, …`); and it
carries an undocumented key **`"editable": true`**.

This is **not yet a proven bug**. The contract's claim is that v1 is what every working
third-party writer emits and that the device reads it; the golden checks still pass and the
suite is green. What is now established is that **v1 is not what the device produces**, and
that a field Yellowjacket hardcodes differs from the device's own. Three consequences:

- The only way to settle whether v1 still loads on 1.2.45 is to write a patch to the device
  and eject — which is a **write** and is out of scope until Ian says so. Until then, treat
  "the OP-Z reads v1" as inherited, not verified against current firmware.
- **"Compact JSON, no spaces" is Yellowjacket's self-imposed constraint, not a device
  requirement.** The device's own parser demonstrably tolerates whitespace, because it emits
  it. Keeping the compact form is fine and deterministic; asserting it is required is not.
- **An import path must not assume the v1 key set.** `parseDrumPatch` will meet
  `drum_version: 3` and `"editable"` in the wild the moment it reads a device-recorded kit,
  which is exactly the precondition for opportunity 1. It currently `JSON.parse`s whatever is
  there and returns it, so it should survive — but nothing tests that.

**2 · `samplepacks/1-kick .. 4-fx` under-describes the disk — and the names are now settled.**
`CONTRACT-WIRE.md` §1. The real tree is **8 track folders × 10 slot subfolders = 80 slots**,
`1-kick 2-snare 3-perc 4-fx 5-bass 6-lead 7-arpeggio 8-chord`, each with slot folders
**`01`…`10`** [MEAS — this closes the `01` vs `1` conflict in favour of Z-PO, and confirms
`4-fx` despite the guide calling track 4 SAMPLE]. Tracks 5–8 take the synth format in the same
tree. The drum format really does only apply to 1–4, which is what the contract sentence
means, but as written it will read as wrong to anyone holding the device. Never *create* those
folders, only populate them.

**3 · "The OP-Z reads only start/end/pitch" is both too strong and too weak.**
`CONTRACT-WIRE.md` §1. Too strong on `pitch`: nothing sourced supports it, and a careful
community source says the OP-Z "disregards" per-slice settings entirely. Too weak on
`playmode`: TE's own **changelog 1.2.5** says the OP-Z *used to ignore* the patch's
playmode and treat everything as retrig — which implies that since 1.2.5 it **does** honour
it, and that an exported kit will sound different under `gate` versus `retrig`. `start`/
`end` cannot be ignored; they define the slices. Suggested wording: *"the OP-Z uses
start/end; playmode is honoured since firmware 1.2.5; the remaining per-slice fields are
cosmetic there and may be ignored entirely."* No behaviour change — Yellowjacket writes 24
zeros for `pitch` either way — but the contract forbids re-deriving its facts, so an
inaccurate one is expensive later.

**4 · "Sending a clock stream to an OP-Z automatically puts it into external sync mode" is
true and incomplete.** `CONTRACT-WIRE.md` §2 and §4. **Incoming MIDI clock is disabled by
default** [DOC, `tempo` §9.8]. The §4 hardware-validation line "confirm OP-Z external sync
follows CLOCK OUT" will fail on a factory-state device for a reason that looks exactly
like a Yellowjacket bug. The precondition is TEMPO+SCREEN then key 4, or `timing_clock_in`
in `midi.json`; success is visible as track LEDs 1–16 blinking green in groups of four.
**Ian's own unit already has `timing_clock_in: true`** [MEAS], so his validation pass is not
blocked — this is a correction for the contract and for other people's devices.

**5 · The kill-note burst has no TE source.** `CONTRACT-WIRE.md` §2 and
`js/midi/wire.js:6-8` both assert "OP-Z emits a burst of notes ('kill' messages) when stop
is pressed". TE documents panic and track-panic **only as user gestures** and never
documents any outbound emission on `0xFC`; 90 s of passive capture produced no notes at
all. The underlying mechanism is real and documented (`track` §5.9 TRACK+STOP kills active
notes; changelog 1.1.17 "hard kill active track notes on double press TRACK+STOP"; 1.2.12
"fix crash when killing notes on tracks other than the first 8"), but its **wire form is
UNK** — per-note note-offs, note-ons at velocity 0, or CC 123 all-notes-off. Keep the 50 ms
suppression; it is cheap and correctly aimed. Relabel it as Yellowjacket's own observation
rather than implying TE says it. **And note the hole:** `wire.js:_handleMessage` returns CC
events *before* the suppression check, so if the burst turns out to be CC 123 it will pass
straight through — and a LEARN capture in progress could bind to it.

**6 · `playmode: 8192` — a change was recommended, and the device scan overturns it.**
`op1patch.js:95`, `CONTRACT-WIRE.md` §1, `test/run.mjs:1298`. The formats research pass
recommended moving 8192 → 12288, on the strength of DigiChain's four 8192-wide buckets
(`4096 = gate, 12288 = oneshot, 20480 = group, 28672 = loop`), under which 8192 sits exactly
on a seam and rounds to `gate` rather than `oneshot`. **Do not make that change.**
`op-patch-util` documents **three** values (`0 / 8192 / 16384`); a real OP-1 wrote 8192 into
teoperator's captured `boombap1`; and the OP-Z's own patch on Ian's disk writes **16384**
[MEAS] — a legitimate centre in the three-value scheme and *itself* a seam under DigiChain's
four-bucket table. So the three-value scheme is the one that applies to OP-1-family drum
patches, DigiChain's table describes the later Field / OP-XY generation, and **12288 is not a
value in the applicable encoding at all**. 8192 stays.

What remains open is *which* of the three modes 8192 is: TE's UI names gate / trigger / loop
and no source maps them to integers, and the device's own default is 16384. Settle it
empirically if it ever matters — set each slice to a different playmode on the device, pull
the `.aif` back in content mode, and read the values through the existing `parseDrumPatch`.
The same round trip settles `reverse[]` (8192 forward / 16384 reverse per `op-patch-util`;
`op1patch.js` writes 8192, which every scheme agrees is forward — that one is fine).

**7 · Exported patch filenames are not unique — but the reason to care has weakened.**
`js/app/wire-controller.js:62` (`<stem>-kit.aif`) and `js/machine/controller.js:159`
(`<stem>-op-kit.aif`). The FORUM claim was that the device keys imports on filename, so a
second export of the same session could silently fail to re-import. The device's own
`import.log` shows it **renames on import** (`importing patch (1).aif` → `assigning
perc/09/patch.aif`) [MEAS], which undercuts that mechanism. A content-hash discriminator is
still cheap insurance and makes the user's own Downloads folder legible, but it is no longer a
correctness fix.

**8 · The in-app export copy stops three steps short.** `index.html:357` reads "Drop it into
a content-mode slot folder." The real procedure is: content mode (hold track while powering
on) → `samplepacks/1-kick`…`4-fx` → one slot folder `01`…`10` → **exactly one file** → eject →
wait for the restart → **check `rejected/` on the next content-mode boot**. A budget line
("≈1.0 MB of the OP-Z's 24 MB — about 23 full-length kits") is cheap, true, and prevents the
"80 slots means 80 kits" mental model — which is doubly wrong on a real device, where most
occupied slots hold zero-byte placeholders rather than files.

**9 · `js/loom/compile.js:412` labels a raw MIDI channel as an OP-Z channel.**
`opzChannel: gesture.channel + 1`, surfaced in `js/loom/view.js:348,399` as "OP-Z CH nn".
That silently asserts the default track↔channel identity map, which TE never publishes and
the user can remap on the device or in `midi.json`. Display-only today, so the cost is a
misleading readout rather than wrong output — but the label is a claim, and the map is
**INF**, not **DOC**. On Ian's actual device the assertion is wrong for one track:
`track_channels` folds **track 16 onto channel 1** [MEAS], so a "CH 01" readout is ambiguous
between KICK and MOTION there.

**Confirmed with no change needed:** the fixed-point rule and the exact-ratio implementation
(now against a *second* factory file); the `end`/`start` frame convention; the 24-slot fill;
the AIFF chunk order and the APPL even-pad accounting; the 80-bit extended rate bytes; the
44.1 / mono / s16 / ≤529 200 constraints; `PATCH_SLOTS = 24` and `PATCH_MAX_FRAMES = 529200`
against TE's own words; the windowed-mean ClockIn estimator and its ±30 % band (now
validated by measurement, see §2.7); and the decision to exclude sysex and BLE.

---

# 4. What is genuinely unknown

Stated plainly rather than guessed at. Grouped by whether Ian's connected device can settle
it.

## 4.0 Closed by the device scan

These were open across the five research passes and are now answered [MEAS]: the
`samplepacks` folder and slot names (`01`…`10`, eight track folders); project filenames
(`project01.opz`, snapshots `project<nn>f.opz`) and their real size (**342 848 B**, four more
than the published byte table sums to); `bounce.wav`'s format (plain RIFF WAVE PCM, **stereo**,
44.1 kHz, 16-bit); that a device-written synth patch really is **exactly** 264 600 frames; the
whole `track_channels` map and this device's MIDI settings; the existence of
`config/userPresets.dat` (351 202 B, binary, in no published source); and — negatively —
that the OP-Z writes `drum_version: 3` with a `"editable"` key and spaced JSON, which no
source anywhere had recorded.

## 4.1 Still open, settleable by one hardware session

| # | unknown | cheapest test |
|---|---|---|
| 1 | **The drum-track MIDI note base** (52 or 53). One RE artifact against two hedged forum posts. Not in the scanned config files. | Passive LEARN or [`midi.md`](midi.md) Appendix A variant 1 — **silent**, 30 s |
| 2 | Whether the −/+ transpose buttons shift the drum **receive** window or only the local keyboard | LEARN, press +, LEARN again |
| 3 | Whether outgoing drum notes use the same base as incoming ones | one capture |
| 4 | **What `how_to_import.txt` says** — TE's authoritative import rules, on the disk and still unquoted | it is already accessible; read it on the next scan |
| 5 | Whether device-recorded packs appear as readable `.aif` under `samplepacks/<track>/<slot>/` — the precondition for opportunity 1 | the scan found real `.aif` files there, but whether they are *device-recorded* or factory content is not yet distinguished; sample something new and look |
| 6 | **Whether a `drum_version: 1` patch still loads on firmware 1.2.45** | **requires a WRITE** — drop a Yellowjacket export in a slot, eject, check `rejected/` and the pads |
| 7 | The `playmode[]` / `reverse[]` mode→integer mapping (values known: 0 / 8192 / 16384) | set each slice to a different mode on device, pull the `.aif` back, read via `parseDrumPatch` |
| 8 | Whether the OP-Z honours `pitch[]` well enough for the low-res 24 s trick | print one low-res and one normal kit of the same material, listen for octave error and aliasing |
| 9 | Whether a **short** synth patch is rejected or merely bleeds | two files, one short one exact, one content-mode visit, read `rejected/` |
| 10 | Whether Chrome enumerates the OP-Z as an audio **input**, and at what rate | `navigator.mediaDevices.enumerateDevices()` in the bench |
| 11 | Whether the OP-Z presents a USB-MIDI port to Chrome alongside the audio interface | open the WIRE panel and look |
| 12 | Whether `track_channels[15] = 0` (track 16 on channel 1) is a factory quirk or a prior edit | compare against a factory-reset unit, or just treat the file as authoritative |

## 4.2 Not settleable here

- **Whether the OP-Z emits MIDI clock while its sequencer is stopped.** Clock was already
  flowing when the device was attached. Do not assume incoming clock implies a running master.
- **The exact wire form of the stop/kill burst** — note-offs, note-ons at velocity 0, or
  CC 123.
- **CC 102's channel column** ("0" and "1"): zero-based index or literal channels 1 and 2.
- **CC 56 tempo:** TE never publishes the 0–127 → BPM mapping.
- **Bank Select CC numbers** for the non-alt program change mode (standard 0/32 is a guess).
- **Factory defaults for the eight boolean MIDI settings.** Only `timing_clock_in` is
  documented as off. The one available `midi.json` artifact is user-edited throughout.
- **Whether the factory default really is track N ↔ channel N.** Well-supported, never stated.
- **Whether incoming velocity affects drum voices at all**, or only the arp track — the only
  track TE's changelog ever mentions velocity for.
- **Whether drum-track CC 1 (`pitch`) and CC 2 (`reverse`) act on the whole track or only the
  last-played slice.** The patch stores both per slice; the dial is a track control.
- **The relative-CC encoding** beyond "1 = up, 127 = down".
- **`dyna_env[]` semantics.** Every writer copies `[0,8192,0,8192,0,0,0,0]` without knowing.
- **Whether the OP-Z validates `drum_version`**, and how 1, 2 and 3 differ. Version 3 is what
  the device writes; 1 and 2 both exist in files written by TE hardware; third-party writers
  emit 1. Nobody has published what the version number changes.
- **What the `"editable"` key does**, and whether omitting it matters.
- **Total internal storage.** The exposed content volume is 34.6 MB with a 24 MB sample
  budget; projects, bounces, `userPresets.dat` and firmware evidently live outside that.
- **The `config/userPresets.dat` byte format** — 351 202 B, binary, no published source.
- **The `.engine` file byte format** — entirely undocumented, and the on-disk copies are
  tilde stubs anyway.
- **The `$09` sysex pattern message.** zlib after 7-bit unpacking; the public request for a
  decoder (2022) was never answered.
- **~48 bytes of the `.opz` structure**, by the Z-PO Project's own admission.
- **The firmware AES-256 key.** `z_firmware_1_2_45.zfw` is AES-256-CBC with an IV at 0x70 and
  a key *index* — the key lives in the device. Entropy 7.9998 bits/byte; XOR and
  CTR/CBC/CFB/OFB/ECB trials all produced noise. **There is no OP-Z equivalent of
  `op1repacker`, and with the product discontinued there will not be.** Anyone claiming
  otherwise is talking about the OP-1.
- **`X3CLATMB`** — eight ASCII bytes in the identity reply, probably a board revision code.

## 4.3 TE's own documentation contradicts itself in four places

Recorded so they are not mistaken for research errors: `alt_program_change` off gives
"pattern 1–16" in one table and "pattern 1–160" in another (160 is the arithmetically
consistent one); the punch-in chart prints `C#` twice, where the second must be `D#`; USB
charging is disabled by "screen + trigger spark" in the USB chapter and "screen + the
rightmost piano key e2" in hardware-overview, unreconciled; `track_channels` is documented
as 1–16 but is zero-based in the real file, and `parameter_cc_out` is documented as 0–255 on
a 7-bit wire.

---

# 5. Ranked opportunities

Ordered by drudgery removed per unit of work. **"Writes to device"** is called out
explicitly. Everything not so marked is read-only, or produces a file the user places
themselves. Entering content mode reboots and remounts the device — it writes nothing, but
it is a device state change.

The friction being attacked, walked end to end: getting audio in at all (the alternative to a
computer is the built-in mic); slicing 24 boundaries blind, by ear, on a device with **no
display** and an app that shows **no waveform**, with no zero-crossing snap and no undo; no
naming or provenance (a pack is `samplepacks/3/7/`, and the JSON `name` never appears in any
device UI); an invisible byte budget; a one-way trip (to change one slice you rebuild the kit
from sources that may only ever have existed inside that `.aif`); two reboots per validation
cycle; blind per-slice tuning; and a synth format that demands a file exactly 6 s long and
tuned to A.

### 1 · Kit import — read an OP-Z/OP-1 `.aif` back into the bench · read-only
**Removes:** the worst piece of OP-Z drudgery — blind slice editing and the one-way trip.
Change one boundary with a waveform and a zero-crossing, keep the other 23, re-print.
**What it takes:** `parseDrumPatch` already exists at `js/export/op1patch.js:152-215`, already
reads layout A (AIFC/`sowt`, which real devices write) and layout B, folds multi-channel to
mono, and is documented in its own source as "later an import path". `start[]`/`end[]` invert
through `positionOf` into frame indices, so 24 clips land on the timeline with boundaries
intact. The work is UI plus wiring, not parsing. The device scan confirms real `.aif` files do
sit in `samplepacks/<track>/<slot>/`, so the format side of the precondition holds.
**Gate:** the parser must survive what the device actually writes — `drum_version: 3`, the
undocumented `"editable"` key, and whitespace inside the JSON (§3.9 item 1). It should already,
since it `JSON.parse`s whatever is present, but nothing tests it. Add a v3 fixture first.

### 2 · Whole-disk pack builder + 24 MB byte-budget planner · read-only, emits a ZIP
**Removes:** the guess-eject-reject-reboot loop, and the "80 slots means 80 kits" mental
model — which the scan shows is wrong in a second, worse way: **the device reports slots full
when they hold zero-byte placeholders.** All four drum tracks read 10/10 on Ian's unit, but
38 of the 55 entries are `~` stubs standing in for factory content held internally. They cost
a slot and zero bytes, and any of them can be displaced by a real patch. Meanwhile 10.8 MB of
the 24 MB budget is free. Nothing on the device tells you any of that.
**What it takes:** a grid of all 80 slots that distinguishes **real file / placeholder /
empty**, live bytes against the 24 MB ceiling counting real files only, per-slot seconds, one
`.aif` per slot folder (honouring the one-pack-per-folder rule), emitted as one ZIP shaped
like `samplepacks/<track>/<01..10>/`. Pure arithmetic plus a UI grid plus a ZIP writer over
the exporter that already exists; the folder and slot names are now confirmed, so the tree can
be emitted correctly without guessing. **Note:** writing straight onto the mounted volume via
the File System Access API is possible in Chrome and **would be a write to the device** — keep
it behind the ZIP until Ian asks.

### 3 · Settle the note base, then ship a re-runnable 24-note LEARN · read-only
**Removes:** the single unknown that gates every MIDI feature, and a class of silent
drift. The research narrows the answer to one integer (24 contiguous semitones, slot *i* =
base + *i*, base 52 or 53); one 30-second **silent** capture converts it to a verified default
that LEARN merely overrides.
**What it takes:** run [`midi.md`](midi.md) Appendix A variant 1; write the number back into
this file. Then extend LEARN from a single base to a 24-note map with a sanity check that 24
consecutive notes hit 24 distinct slices — because the −/+ transpose buttons may move the
receive window, and a base captured once will silently drift the moment the user changes
octave.

### 4 · Three lines of honest copy in the WIRE panel · read-only
**Removes:** the three most likely "Yellowjacket is broken" reports, each of which is a
documented OP-Z default that makes correct behaviour look like a bug. (a) Incoming MIDI clock
is **off by default** — CLOCK OUT does nothing until TEMPO+SCREEN key 4. (b) If "channel one
to active" is on, channel 1 follows the selected track and note routing on it is
non-deterministic. (c) The settings combo **moved in firmware 1.2.38**, so most tutorials
online give the wrong keys.
**What it takes:** copy changes only. Near-zero effort, and each one is expensive to debug and
cheap to state.

### 5 · Drive OP-Z parameters over the documented CC map · read-only
**Removes:** every trip to the device to turn a dial, and it needs **zero** reverse
engineering — TE publishes the whole incoming table.
**What it takes:** additive work in `js/midi/wire.js` plus a UI table: 18 per-track parameters
with paired absolute (0–127) and relative (1/127) CCs on channel = track, plus tempo (56),
swing (57), mute (53), audio mute (54), mute group (55), step count (60), step length (61),
quantize (62), note length (63), track gain (50/51), pattern select (103). Because CC 1–4 =
white / 5–8 = green / 9–12 = purple / 13–16 = amber, a Yellowjacket panel can mirror the
device's own page model exactly. Leave CC 102 out of v1 (its channel column is unresolved).
The same table lets LEARN label incoming CCs by name — "CC 3 · filter cutoff" — for free, and
the OP-Z's own outgoing defaults are identical (`parameter_cc_out` rows default to 1…16).

### 6 · Read the device's own config instead of assuming it · read-only
**Removes:** every guess and every configuration screen in the MIDI story. `config/midi.json`
on the content disk carries the whole truth — `track_channels` (the real per-track channel
map), `parameter_cc_out` (the real outgoing CC matrix), and all eight booleans. A WIRE panel
that can read a mounted content-mode volume never has to assume the identity map, never has to
ask the user which channel the kick is on, and can **warn** about the two states that break
routing: `channel_one_to_active: true` (channel 1 follows the selected track) and a collision
like Ian's `track_channels[15] = 0` (MOTION folded onto KICK's channel).
**What it takes:** a directory picker plus a JSON read — no protocol work, no new permissions,
no writes. It pairs naturally with opportunity 9, which wants the same picker to read
`import.log` and `rejected/`.

### 7 · Export copy and the `rejected/` pointer · read-only
**Removes:** most of the support questions the OP-Z community has been asking for seven years.
**What it takes:** extend the copy at `index.html:357` to the full procedure (§3.9 item 8) —
now with confirmed folder and slot names — and add a budget line using the `report.frames` the
writer already returns. A content-hash discriminator on the download filename is still worth
having for the user's Downloads folder, but the device renames on import, so it is
housekeeping rather than a correctness fix (§3.9 item 7).

### 8 · Per-slice `pitch[]` and tune-to-key · read-only
**Removes:** 24 blind turns of the yellow dial on a device with no display.
**What it takes:** one new argument through `buildDrumPatch` plus a UI column. `pitch` is one
of the three fields the OP-Z reads and the exporter hardcodes it to zero; the missing constant
is now sourced (**512 units per semitone, ±48**). HARVEST already labels roles and the bench
already estimates spectra, so "tune every TONE/BASS slice to the scene key" is one pass over
data that already exists. The same argument unlocks the slot-filling trick `op-patch-util`
does (pitch the real slices to fill unused keys) instead of duplicating the last slice.

### 9 · Pre-flight validator and rejection explainer · read-only
**Removes:** two reboots per wrong guess. Drop any `.aif` in and get the verdict the device
only gives after a full cycle: rate ≠ 44 100, not mono, > 529 200 frames, > 24 slots,
malformed or missing `APPL op-1` (the failure that makes files *invisible* with no error),
more than one pack in a slot folder.
**What it takes:** `parseDrumPatch` already does the reading; this is a rules layer plus a
directory picker to read the device's own `import.log` and `rejected/` when the user points
the bench at a mounted content-mode volume.

### 10 · Capture the OP-Z's output over USB at exactly 44.1 kHz · read-only
**Removes:** the built-in mic as the only easy input, and closes a loop the OP-Z cannot close
by itself: jam → harvest → kit → device.
**What it takes:** `getUserMedia({audio:{deviceId, echoCancellation:false,
noiseSuppression:false, autoGainControl:false}})` on the OP-Z input. Measured locally: the
device presents **2 input channels at 44 100 Hz** — the exact rate the patch format demands,
so no cable, no analogue stage, no resample. HARVEST then classifies it into a labelled
eight-voice kit and the existing PATCH path prints it back. **Gate:** confirm Chrome
enumerates it as an input and does not force 48 kHz through its own graph (§4.1 #10).

### 11 · Correct CONTRACT-WIRE · read-only
**Removes:** future re-derivation of facts the contract explicitly forbids re-deriving — which
means an inaccurate one compounds.
**What it takes:** the nine edits in §3.9, plus folding the measured clock histogram into §2
as the *justification* for the windowed mean (so nobody "simplifies" it into a median later),
plus one scope line recording that **`.opz` project writing is out of scope permanently**
(342 848 bytes of little-endian memory image whose published byte table does not even sum to
the real file size, ~48 undecoded bytes, no checksum, and a device that will accept a malformed
one and crash — reading one to display is defensible, writing one is not).

### 12 · Synth-track patches for tracks 5–8 · read-only
**Removes:** the "your sample must be tuned to A" tax, and doubles the exporter's reach from
four tracks to eight.
**What it takes:** a small delta on an already-correct writer — same AIFF chunk layout, pad or
trim to exactly 264 600 frames, swap the APPL JSON for `type:"sampler"` + `synth_version`, and
set `base_freq` from a detected fundamental rather than a hardcoded 440. The device scan
**confirms the exact-6-s requirement against a device-written file** (every synth patch on the
disk measures 264 600 frames), which was the biggest open question — so pad, never truncate to
a shorter file. **Still ranked here rather than higher because the JSON schema is RE plus a
single community write-up rather than byte-verified**, and because the device-written drum
patches show the OP-Z's own schema differs from the third-party one; read a real synth patch
off the disk and round-trip against it before shipping.

### 13 · Low-res 24 s / half-byte mode · read-only
**Removes:** half the byte cost of every pack — which, per §3.7, is the constraint that
actually binds on a 24 MB device.
**What it takes:** an optional `lowRes` flag that decimates 2:1 and writes
`pitch[i] = 12 * -512 = -6144` so the device plays it an octave down at the original speed.
Two independent tools ship this (`op-patch-util --low-res`, DigiChain's octave-pitch
size reduction), so the mechanism is real. **`op-patch-util` decimates by dropping every other
sample with no anti-alias filter; Yellowjacket already owns a Kaiser-windowed sinc converter
and would be the only tool doing this cleanly.** Must be hardware-validated before shipping as
anything but opt-in.

### 14 · Small test-suite hardening · read-only
Three cheap fixtures for `parseDrumPatch`: a **`drum_version: 3` patch as the device actually
writes it** (spaced JSON, `"editable": true`, `playmode: 16384`) — the one an import path will
meet first and the one nothing currently covers; a `COMT` chunk (real OP-1 files carry one and
`op-patch-util` declares the constant; the parser walks chunks generically so it should skip
it, but nothing proves that); and a synth `type: "sampler"` patch. Real files for all three are
sitting on the device.

### 15 · Push audio into the OP-Z's sampler over USB · **WRITES TO THE DEVICE**
`AudioContext.setSinkId()` to the OP-Z output while the user holds `rec` makes the device
sample the bench directly, with no content mode and no reboot. It is the only path that gets
audio onto the OP-Z without the disk. **Ranked last deliberately: it creates a sample pack on
the device and consumes the 24 MB budget.** Do not build it in a read-only phase.

## Do not build

- **A sysex path.** The protocol is only partially reverse-engineered (`$09` still undecoded
  seven years on), it needs a continuously-sent heartbeat, the only working implementation is
  non-commercially licensed, and Chrome gates sysex behind a separate stronger permission.
  CONTRACT-WIRE's exclusion is well founded; this is a note to keep it closed.
- **An `.opz` project writer.** See opportunity 11.
- **Anything expecting custom firmware.** AES-256, key held in the device, product
  discontinued. §4.2.
- **The newer OP-1 Field / OP-XY JSON keys.** §3.3.

## Licence landscape, since some of this is commercial

Read from the GitHub API on 2026-09-04, not from README prose. **No licence at all** (all
rights reserved — read for facts, never copy code): `op-patch-util`, `opzdoc`, `opkit`,
`opz-firmware-notes`. **Non-commercial** (Prosperity + Patron): `libopz`. **GPL-3.0**
(copyleft, incompatible with a closed browser bundle): `underbridge`, `OP-1Z-Sample-Manager`.
**AGPL:** `digichain`. **Safe MIT set:** `teoperator`, `libop1`, `OP-Z-Simple-Tool`,
`nbw/opz`, `op1repacker`, `sowbug/op-1-tools`. Yellowjacket derived its writer independently,
which was the right call. If the track↔channel table ships as a default, cite `nbw/opz` (MIT).

## Closest prior art

`brian3kb/digichain` already imports OP-1/Field/OP-Z drum kits and slices them, exports chains,
and does octave-pitch size reduction. `joseph-holland/op-patchstudio` is a React PWA with a
24-slot drum tool, waveform editing with snap-to-zero-crossing, recording, Web MIDI and OP-1
preset import — but it has pivoted to the OP-XY. `schollz/teoperator` does automatic
transient-based splice detection. **None of them harvest a recording into role-labelled
voices, conform to tempo, or carry provenance** — which is where Yellowjacket is actually
different, and it is the axis worth pressing.

---

*Branding line from CONTRACT-WIRE stands and is what every credible project in this space
does: body copy may say "works with the teenage engineering OP-Z"; TE marks never appear in
tool names, headings or logos; the README and page footer carry "not affiliated with teenage
engineering."*

## 5. Lab notes and code that came out of this reference

- `2026-09-04-project-lineup.md` — the `.opz` decoder verified against the
  device's own audio: fifteen files, a MIDI-Start recording, a multi-band
  match, the clock and the cyclic detector agreeing at 105 bpm.
- `js/export/opz-project.js` — decoder, event layout, grid, inspector, SMF
  export; `scripts/opz-export.mjs` — CLI; tests under `op-z project`.
- `CAPABILITIES.md` — the five-lens capability survey, tiered.
