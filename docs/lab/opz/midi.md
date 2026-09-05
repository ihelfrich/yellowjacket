# OP-Z MIDI implementation, in depth

Lab note, 2026-09-04. Lens: **MIDI implementation** — what the OP-Z sends and
receives, in both directions, at byte level where byte level exists.

Written for `docs/CONTRACT-WIRE.md` section 2. Where this note contradicts or
sharpens the contract, section 10 says so explicitly. Nothing here re-derives
the OP-1 drum patch format (contract section 1 is already byte-exact).

## 0. Confidence key, and how each fact was obtained

| Tag | Meaning |
|---|---|
| **DOC** | Published by teenage engineering. Page + section number given. |
| **MEAS** | Measured on this machine against Ian's OP-Z, 2026-09-04, over USB-C, via CoreMIDI (python-rtmidi under `uv run --no-project`). Reproducible; script in the appendix. |
| **RE** | Reverse-engineered by a named third-party project. Project named, not "the community". |
| **FORUM** | A forum post. Always hedged, always marked, never load-bearing. |
| **INF** | My inference from DOC/MEAS facts. The inference is shown, not hidden. |
| **UNKNOWN** | Nobody has published it and I could not measure it. Said plainly. |

**Device under test (MEAS).** The OP-Z was attached and powered during this
research. It enumerates as USB vendor `teenage engineering ab`, product `OP-Z`
(`ioreg`), and it answered a universal MIDI identity request with firmware
string `1.2.45` — the newest OS teenage engineering has published for the OP-Z
(1.2.45, 2022-03-31). So everything below is against current firmware, and the
OP-Z firmware line has been frozen for four years.

**Primary sources used.**
- <https://teenage.engineering/guides/op-z/midi> — sections 21.1–21.6. This is
  the closest thing TE publishes to a MIDI implementation chart. There is no
  separate PDF chart. Fetched and parsed from HTML rather than summarised.
- <https://teenage.engineering/guides/op-z/tracks> (11.x), `/tempo` (9.8),
  `/track` (5.x), `/parameter-pages` (4.3), `/project` (7.x), `/usb` (20.x),
  `/reference` (24.3), `/disk-modes` (22.x), `/app` (23.5, 23.9).
- <https://teenage.engineering/guides/op-z/modules/oplab> — ZM-1 electrical and
  MIDI specs.
- <https://teenage.engineering/downloads/op-z> — the OS changelog, 1.1.12
  (2018-11-13) through 1.2.45 (2022-03-31). This is the single most useful TE
  document for MIDI behaviour: the guide describes the surface, the changelog
  describes the edge cases.
- <https://teenage.engineering/guides/op-1> — the OP-1 field MIDI reference,
  used only as family comparison.

## 1. Track model and channel assignment

**The 16 tracks (DOC, `/tracks` 11.2), in track-button order:**

| # | Track | Group |
|---|---|---|
| 1 | KICK | drum |
| 2 | SNARE | drum |
| 3 | PERC | drum |
| 4 | SAMPLE | drum |
| 5 | BASS | synth |
| 6 | LEAD | synth |
| 7 | ARP | synth |
| 8 | CHORD | synth |
| 9 | FX1 | control |
| 10 | FX2 | control |
| 11 | TAPE | control |
| 12 | MASTER | control |
| 13 | PERFORM | control |
| 14 | MODULE | control |
| 15 | LIGHTS | control |
| 16 | MOTION | control |

Track 14 = MODULE is independently confirmed by the oplab guide ("the module
track (track 14) is dedicated for the external sequencing of cv"), which is
what pins the whole control-track ordering.

**Channel assignment (DOC).** "all 16 tracks can also send and receive midi,
each on its own channel" (`/tracks` 11.1). Per-track channel is set three ways:

- On device: hold **TEMPO + SCREEN** (the two index buttons), then hold a track
  button for ~1 s and turn the **green dial** → channel 1–16 for that track.
  (This shortcut arrived in 1.2.31, 2020-08-21; the settings combo moved to
  SCREEN+TEMPO in 1.2.38, 2021-06-03 — older tutorials give a different combo.)
- `midi.json` in content mode, key `track_channels`.
- The OP-Z app, MIDI setup page (`/app` 23.9).

**Default map: track N ↔ channel N (INF, well-supported).** TE never prints the
default table. Two independent supports: (a) the guide's "each on its own
channel"; (b) a real `midi.json` — `nickbec10/MIDI_Config_OP-Z_Moog_Sirin` (RE
artifact, fetched raw) — in which every track the author did *not* touch reads
in ascending order and only the two he deliberately remapped deviate:

```json
"track_channels" : [ 0, 1, 2, 3, 4, 5, 6, 0, 8, 9, 10, 11, 12, 13, 14, 15 ],
```

(he moved track 8/CHORD onto track 1's channel to drive a Moog Sirin).

**`track_channels` is ZERO-BASED in the file** even though the guide's range
column says "1 – 16" (RE artifact vs DOC — a real discrepancy in TE's docs).
Index 0 in the array = track 1; value 0 = MIDI channel 1.

**"channel one to active" (DOC, `/midi` 21.3 key 1 / `midi.json`
`channel_one_to_active`).** "any incoming midi on channel 1 is redirected to
the currently active track." One documented exception, added in 1.2.12
(2019-11-05): *"disregard 'channel_one_to_active' setting when processing
incoming UI group CC messages"* — i.e. the UI CCs (102, see §3) are always
interpreted globally and are never re-aimed at the active track.

Consequence for a controller like Yellowjacket: if `channel_one_to_active` is
on, channel 1 is a *moving target* — it follows whatever track the performer
last selected. Anything that wants deterministic per-track addressing must use
channels 2–16, or require the user to turn the setting off. Whether the setting
is on or off by default is **UNKNOWN**; the one `midi.json` artifact I have has
it `false`, but that file is user-edited throughout.

## 2. Global MIDI settings — the two equivalent surfaces

**On device (DOC, `/midi` 21.3).** Hold **TEMPO + SCREEN**, keep holding, press:

| Key | Setting |
|---|---|
| 1 | channel one to active |
| 2 | incoming midi |
| 3 | outgoing midi |
| 4 | midi clock in |
| 5 | midi clock out |
| 6 | alt program change |
| 7 | midi echo (echo incoming midi back on same port) |
| 8 | enable program change (in/out) |
| track 1–16 | mute track (mutes *all* MIDI on that track) |
| track 1–16 held ~1 s + green dial | set that track's MIDI channel, 1–16 |

**In `midi.json`, content mode (DOC, `/midi` 21.4).** Enter content mode by
holding **TRACK** while powering on; all track LEDs go green; the OP-Z mounts
as a disk (`/disk-modes` 22.2). Keys and ranges:

| Key | Range | Notes |
|---|---|---|
| `channel_one_to_active` | true/false | |
| `incoming_midi` | true/false | |
| `outgoing_midi` | true/false | |
| `timing_clock_in` | true/false | **DOC: disabled by default** (`/tempo` 9.8) |
| `timing_clock_out` | true/false | |
| `enable_program_change` | true/false | persisted across reboots since 1.1.23 |
| `alt_program_change` | true/false | see §4 |
| `midi_echo` | true/false | echo on same port **+ midi through to other ports** |
| `track_enable` | true/false | array of 16 |
| `track_channels` | guide says 1–16; **file is 0–15** | array of 16 |
| `parameter_cc_out` | 0–255 | **16 × 16 array**: per track, per parameter |

The real shape of `parameter_cc_out` (RE artifact, same repo) is 16 rows of 16
values — one row per track, one entry per dial parameter — and the untouched
rows read `[1,2,3,...,16]`, i.e. **the outgoing CC defaults equal the incoming
CC numbers in TE's own table** (§3). Note the row is 16 long, not 18: the
portamento (17) and note style (18) CCs are not in `parameter_cc_out`.

The guide's stated range "0 – 255" for a MIDI CC number is nonsense on a
7-bit wire; treat 0–127 as the usable range and assume >127 means "unassigned"
(INF, unverified).

`general.json` (DOC, `/reference` 24.3) also lives in content mode and carries
`latch_notes_with_shift`, `generous_chords` (chord track polyphony 4 → 6, but
still 4 notes per *step*), `disable_param_page_reset`, etc. Nothing MIDI-wire
relevant, but it is the file that changes what an incoming note *does*.

## 3. The CC map (DOC, `/midi` 21.6 "incoming midi table")

Reproduced verbatim from the guide's tables. "Track/channel" is TE's own
column heading: for these rows the channel *is* the track selector.

**Parameters — absolute CC 1–18, relative CC 32–49, both on channels 1–16:**

| Parameter | Absolute CC (range 0–127) | Relative CC (range "1, 127") |
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

The relative range is printed as "1, 127" — standard two's-complement-style
relative encoding, 1 = increment, 127 = decrement (**INF**; TE does not spell
it out, and does not say whether values other than 1/127 give larger steps).

**These CC numbers are positional, not semantic.** CC 1–16 are exactly the four
parameter pages × four dials of `/parameter-pages` 4.3, in order
green→blue→yellow→red, page 1→4. What the parameter *means* depends on the
track type:

| Page | Dial | CC | drum tracks 1–4 | bass/lead/chord/module | arp | fx1/fx2 | tape |
|---|---|---|---|---|---|---|---|
| 1 | green | 1 | pitch | param 1 | param 1 | param 1 | speed |
| 1 | blue | 2 | reverse | param 2 | param 2 | param 2 | fine tune |
| 1 | yellow | 3 | filter | filter | filter | filter | filter |
| 1 | red | 4 | resonance | resonance | resonance | resonance | resonance |
| 2 | green–red | 5–8 | attack, decay, sustain, release | same | same | (page 2 = lfo) | — |
| 3 | green–red | 9–12 | lfo amount, speed, target, shape | same | **arp speed, pattern, style, range** | lfo amount/speed/target/shape | — |
| 4 | green–red | 13–16 | fx1 send, fx2 send, pan, level | same | same | — | — |

So a single CC number addresses a different knob per track. A generic "CC 3 =
cutoff" assumption holds across every track type; "CC 1 = pitch" holds only on
tracks 1–4.

Two live connections to Yellowjacket's patch writer: on a drum track, **CC 1 is
`pitch` and CC 2 is `reverse`** — the same two names that appear as 24-long
arrays in the OP-1 drum patch APPL JSON (`pitch[]`, `reverse[]`). Whether the
CC moves the whole track or only the last-played slice is **UNKNOWN**; the
patch stores it per slice, the dial is a track control.

**System CCs (any track unless noted):**

| Function | CC | Channel | Range |
|---|---|---|---|
| track gain | 50 | 1–16 | 0–127 |
| track gain (relative) | 51 | 1–16 | 1, 127 |
| reset track gains | 52 | any | any |
| mute | 53 | 1–16 | 0–1 |
| audio mute | 54 | 1–16 | 0–1 |
| mute group | 55 | any | 0–9 |
| tempo | 56 | any | 0–127 |
| swing | 57 | any | 0–127 |
| select pattern | 103 | 1–10 | 0–15 |
| next pattern | 103 | any | 16 |
| previous pattern | 103 | any | 17 |

`select pattern` decodes cleanly against `/project` 7.1: **10 projects × 16
patterns** = 160. Channel 1–10 picks the project, value 0–15 picks the pattern
(INF, but forced by the numbers). Note that CC 103 is overloaded: values 16 and
17 are next/previous regardless of channel.

CC 56 = tempo, 0–127 over the OP-Z's tempo range, is a coarse control; TE does
not publish the mapping from 0–127 to BPM (**UNKNOWN**).

**Track CCs:**

| Function | CC | Channel | Range |
|---|---|---|---|
| track step count | 60 | 1–16 | 1–16 |
| track step length | 61 | 1–16 | 1–16 |
| quantize | 62 | 1–16 | 0–127 |
| note length | 63 | 1–16 | 0–127 |

**UI CCs:**

| Function | CC | Channel | Range |
|---|---|---|---|
| active track | 102 | 0 | 0–15 |
| parameter page | 102 | 1 | 0–3 |

The UI rows are the only rows in TE's table with a 0 in the channel column, so
they are almost certainly 0-based channel indices — CC 102 on **MIDI channel 1**
selects the active track, on **MIDI channel 2** selects the parameter page
(INF). These are the "UI group CC messages" the 1.2.12 changelog exempts from
`channel_one_to_active`, which corroborates that they are channel-addressed.

**Not implemented (DOC, same table):** song position pointer — "not used";
active sense — "not used". This matters: the OP-Z cannot be told to continue
from a bar position. `0xFB` continue resumes from where *it* stopped.

## 4. Program change

DOC, `/midi` 21.3 key 6 + 21.4 `alt_program_change`, plus the 21.6 table:

- `enable_program_change` gates PC in **and** out.
- `alt_program_change` **true**: "use bank 1–16 / program 1–16 to set active
  pattern".
- `alt_program_change` **false**: "pattern 1–160 is activated with bank 1 /
  program 1–128 and bank 2 / program 1–32" — i.e. a flat 160-pattern address
  space across banks 1 and 2 (128 + 32 = 160 = 10 projects × 16 patterns).
  TE's own device-settings table writes "pattern 1–16" here and the
  `midi.json` table writes "pattern 1–160"; **160 is the arithmetically
  consistent one** and the 21.3 wording is a typo.
- The 21.6 table's rows are "program change | 1-10 | 0-15" and "program change |
  1, 2 | 0-127" — the first is the alt mode addressed by channel-as-project,
  the second is the flat mode addressed by bank (INF; TE's column headings blur
  bank and channel).
- Changelog: outgoing PC had the `alt_program_change` sense inverted until
  1.1.12; incoming PC handling was broken until 1.2.8 (2019-09-06); since
  1.2.14 (2019-11-15) an incoming PC **switches pattern immediately** instead
  of waiting for the next step. Bank select CC numbers (0 / 32) are not named
  by TE (**UNKNOWN**, though standard Bank Select MSB/LSB is the obvious guess).

## 5. Clock, transport, and external sync

**DOC.**
- `/midi` 21.2: "sending a midi timing clock to your OP-Z will automatically put
  it into external sync mode", indicated by four green LEDs showing the tempo
  when TEMPO is held. `/tempo` 9.8 gives a second indicator: track LEDs 1–16
  blinking green in groups of four — and, importantly, **"by default, incoming
  midi clock is disabled"**. So Yellowjacket's clock-out will do nothing to a
  factory-state OP-Z until the user enables MIDI clock in (TEMPO+SCREEN, key 4).
- Changelog 1.2.5 (2019-07-01): "send clock out if enabled even though midi out
  is disabled" — clock out and note out are independently gated.
- Changelog 1.1.23 (2019-02-22): "pass incoming midi start/continue/stop to
  other ports"; "improve midi continue behaviour (works better with OP-1)".
- Changelog 1.2.5: "don't loose clock sync when switching project via pattern
  change".
- Transport bytes are the standard `0xFA` start, `0xFB` continue, `0xFC` stop,
  `0xF8` clock at 24 ppqn; the OP-Z table lists start/stop/continue/clock as
  supported and song pointer/sense as not used.

**MEAS — the OP-Z's outgoing clock, characterised.** Three passive captures
(15 s, 20 s, 30 s) plus one 25 s histogram run, taken through CoreMIDI while
the device sat with clock-out enabled. In 90 s of listening the OP-Z sent
**nothing but `0xF8`** — no notes, no CC, no transport — so these numbers are
the clock alone.

```
n = 963 intervals (25 s window)
mean   25.4664 ms  -> 98.169 bpm
median 26.0987 ms  -> 95.790 bpm
histogram, 0.25 ms bins:
    0.00 ms     1
    9.00 ms     1
   24.50 ms    19
   24.75 ms   386   <- mode A
   26.00 ms   300   <- mode B
   26.25 ms   256   <- mode B
window-of-24 mean: min 97.96, max 105.12, mean 98.18 bpm
```

Read that carefully, because it inverts an intuition:

1. **The interval distribution is bimodal, not noisy.** Two tight modes ~1.35 ms
   apart. This is USB frame quantisation (full-speed USB delivers on 1 ms
   frames), not tempo drift. Nominal period at 98 bpm is 25.5102 ms — exactly
   between the two modes, and the mode weights (405 low : 556 high) recover it.
2. **Therefore the mean is right and the median is wrong.** Mean → 98.17 bpm
   (0.17% off nominal 98). Median → 95.79 bpm, a **2.4% error** — enough that
   an ADOPT button would snap to 96 instead of 98. CONTRACT-WIRE's
   "windowed mean of the last 24 accepted intervals" is correct as written and
   must not be "improved" into a median. I would have made that mistake without
   measuring it.
3. **The ±30% rejection band earns its keep and is correctly sized.** Only
   0.17% of intervals fell outside ±30% of the running estimate — the two
   pathological arrivals (0.00 ms and 9.00 ms, i.e. coalesced deliveries). But
   an *unfiltered* window-of-24 containing one of them read **105.12 bpm**, 7%
   high. Without the filter, roughly one window in forty is garbage; with it,
   none are. Both halves of the design are load-bearing.
4. **A 24-interval window is one full quarter note**, so the mode-ratio averages
   out inside a single window (measured window means ranged 97.96–98.18 bpm
   once the outlier window is excluded). Do not shorten the window.
5. Chromium's Web MIDI on macOS reads the same CoreMIDI receive timestamps
   python-rtmidi does, so this distribution is what `event.timeStamp` will
   show in the browser. The measurement transfers.

**MEAS caveat.** I could not determine whether the OP-Z emits clock while its
sequencer is *stopped*; clock was already flowing when I attached, and I did
not send transport to it. So: **do not assume incoming clock implies the master
is running** (UNKNOWN).

**The kill-note burst (contract §2).** Not reproducible passively — no notes
were emitted during any capture. TE's changelog corroborates the mechanism
without describing the wire bytes: 1.1.17 "hard kill active track notes on
double press TRACK+STOP", 1.2.12 "fix crash when killing notes (TRACK+STOP) on
tracks other than the first 8", and `/track` 5.9 documents TRACK+STOP as
"kill all active notes on the current track". Whether the burst is per-note
note-offs, note-ons at velocity 0, or CC 123 all-notes-off is **UNKNOWN**.
Keep the 50 ms suppression window; it is cheap and it is aimed at the right
event.

## 6. The drum-track note base — status: STILL NOT ESTABLISHED

The contract calls this UNDOCUMENTED. That is confirmed, and it is worse than
"TE forgot to write it down": TE's incoming MIDI table has **no note rows at
all**, and the OP-1 field's fuller MIDI reference — which does have a note row —
says only "note on | ch 1–16 | play synth/drum note | velocity 1–127". Across
the whole product family teenage engineering has never published which MIDI
note hits which drum slice.

**What is structurally certain (DOC):**
- A drum track holds **24 sounds** "across the musical keyboard" (`/tracks`
  11.3), and that is the same 24 as the 24 slots Yellowjacket writes into the
  OP-1 drum patch.
- The OP-Z keyboard is **two octaves = 24 keys**, split 14 white "component
  keys" + 10 black "value keys" (`/interface-overview` 2.9; the count of 10
  value keys is pinned twice more — `/project` 7.2 selects one of 10 projects
  with "value keys 1-0", and `/app` 23.5 says the configurator's slots
  "correspond to the 10 value keys").
- Therefore the mapping is **24 contiguous semitones, slot *i* ↔ base + *i***,
  and the only unknown is the single integer `base` (INF, but forced).

**Evidence on the value of `base`:**

| Source | Claim | Type / confidence |
|---|---|---|
| `artaction/Ableton2OP-Z`, "OP-Z Template _V04_ OP-Z send tracks.als" | Drum racks for OP-Z tracks 1–4 map exactly **24 contiguous notes, 52–75** | **RE artifact, medium-high.** I downloaded the .als, gunzipped it and read the `ReceivingNote` values directly: the set is {52…75}, 24 entries, no gaps. The set is invariant under Ableton's stored-vs-displayed note convention, so the range is unambiguous even though the storage convention is not. Weakness: a template author can pick a range that "looks right" without testing all 24. |
| op-forums #25892 (2024, OP-1 **field**) | "notes start at 53 and go to like 76" | FORUM, low. Hedged ("like"), and about a different device in the family. |
| op-forums #5470 (drum sampler) | "the drum sampler responds to notes 53-77 i believe" | FORUM, very low. Hedged, and 53–77 is 25 notes — arithmetically impossible for 24 slots, so at least one endpoint is wrong. |

**Verdict.** Base is 52 or 53, with the only artifact I could actually inspect
favouring **52** (E, in the C4=60 convention) and the two hedged forum posts
favouring 53. That is not good enough to hardcode into a patch-export tool
whose entire value proposition is that the file lands on the right pads.
**CONTRACT-WIRE's LEARN-don't-guess rule stands.** What this note adds is that
LEARN only needs to capture *one* note: the base. Everything else follows,
because the 24 slots are contiguous.

**Two further unknowns about the base:**
- Whether the OP-Z's transpose (−/+) buttons shift the *receive* window or only
  the local keyboard. Changelog 1.1.23 added "full octave range to drum tracks",
  which implies the drum keyboard is octave-shiftable — so the receive window
  may move under the user's feet (UNKNOWN, and worth a line of UI copy).
- Whether outgoing drum notes use the same base as incoming ones. Assume yes,
  verify once (INF).

**The 90-second experiment that settles it** (appendix A has the script). It is
Ian's to run because it makes the OP-Z audible; I did not run it unprompted.

## 7. USB versus the module

**USB (DOC `/usb` 20.x; MEAS).**
- OP-Z is a USB **device** (connect to a computer with the C-to-A cable; C-to-C
  is supported but "use a high quality cable") *and* a USB **host** (plug MIDI
  gear straight into the USB-C port). Host mode supplies max **100 mA**;
  anything hungrier needs a powered hub. TE's tested-and-guaranteed list is
  short: OP-1 (direct), oplab (needs external power, discontinued), Korg
  microKEY Air 25 (direct, USB only); powered hub: Kingston Nucleum.
- Devices that present as more than one MIDI device are **not supported**.
- Since 1.1.27 (2019-04-05) two MIDI devices work through a powered hub, and
  USB MIDI throughput was improved to "reduce risk of lost notes".
- USB charging can be disabled to kill ground noise (SCREEN + trigger-spark key).
- **MEAS:** over USB the OP-Z exposes exactly **one CoreMIDI input port and one
  output port, both named `OP-Z`**. There are no per-track virtual ports. All
  16 tracks are multiplexed onto that one port pair and are distinguished only
  by channel. Any Yellowjacket port-matching heuristic can match the literal
  string `OP-Z`.
- The same USB connection also carries 2-channel USB audio (1.2.5) and, in
  content mode, a mass-storage disk. Changelog 1.2.20 notes a bug where "content
  disk and midi port [did not appear] until removing / inserting usb cable
  (usb-a only)" — if the port is missing, re-plug before debugging code.

**oplab module ZM-1 (DOC, `/guides/op-z/modules/oplab`).**
- MIDI in and out on 3.5 mm jacks, **standard type A pinout (tip = sink, ring =
  source)**, stereo cable required, 5-pin DIN adapter included, explicitly "not
  compatible with some equipment which uses non-standard reverse pinout".
- "oplab module transmits **all** midi channels from OP-Z" — the DIN/TRS out is
  not a subset of the USB stream.
- The IN jack is switchable MIDI / TRIG; the OUT jack is switchable MIDI / TRIG
  / PO. TRIG in single-steps tracks armed with step-length multiplier 0
  (0–10 V, tip only). PO out syncs pocket operators (SY2/SY3).
- CV/gate is driven by **track 14 (module)**: tip = note CV 0…+5 V, ring = CV2
  −5…+5 V (green dial), gate tip = 0/+5 V, gate ring = CV3 (blue dial).
  Pro-tip from TE: "change the midi channel of any track on the OP-Z to 14 to
  send that channel's sequence out of oplab's cv output."
- MIDI in tolerates −10…+10 V; outputs are short-circuit tolerant.

**Other modules:** ZM-2 rumble (haptic) and ZM-4 line (line out) carry no MIDI.
With **no** module fitted, the module track "can act as a midi track with 16
independent midi CC values" (`/tracks` 11.10) — i.e. track 14 is the natural
"generic MIDI control" track.

**BLE MIDI** exists (the app pairs over Bluetooth; changelog 1.2.45 "reduced ble
midi jitter"). Out of scope for Yellowjacket by contract, and the OS surfaces
BLE as an ordinary port anyway.

## 8. Sysex

**MEAS — the OP-Z answers a universal identity request.** I sent
`F0 7E 7F 06 01 F7` (universal non-realtime, general information, identity
request; read-only, no state change) and got back one 33-byte reply:

```
F0 7E 7F 06 02 00 20 76 01 58 33 43 4C 41 54 4D 42
31 2E 32 2E 34 35 2B 00 00 00 00 00 00 00 06 F7
 |  |  |  |  |  \______/ |  \_______________/ \_____________/       |
 |  |  |  |  |  mfr ID   ?   8 ASCII bytes     "1.2.45+" + 7 zeros  ?
 |  |  |  |  identity reply (06 02)
 |  |  |  general information
 |  |  device 7F (all)
 |  universal non-realtime
 sysex start
```

- `00 20 76` is the manufacturer ID; this **empirically confirms** the ID that
  the reverse-engineering projects assume for teenage engineering.
- Bytes 18–24 are ASCII `1.2.45+` — the firmware version, matching TE's latest
  published OS. Trailing `00 × 7` then `06` before `F7`.
- The 8 ASCII bytes `58 33 43 4C 41 54 4D 42` = `X3CLATMB` are **UNKNOWN** —
  they do not decode as a family/member pair in the MMA layout and do not read
  as text in any obvious byte order. Probably a board or hardware revision code.
- Historical note: the changelog's 1.1.12 entry "occasional crash when
  recieving midi identity request on startup" says this path is old and once
  fragile. It is fine on 1.2.45.

**RE — the app protocol.** The OP-Z app talks to the device over a proprietary
sysex protocol, reverse-engineered by `hyphz/opzdoc` (wiki) and implemented by
`patriciogonzalezvivo/libopz` (also `nbw/opz`, `ayamflow/opz-parser`):

- Frame: `F0 00 20 76 01 <command> <data…> F7` (mfr `00 20 76`, device `01`).
- All payload is 7-bit packed: each 8-byte chunk's first byte carries the 8th
  bits of the following 7 bytes.
- Some payloads are zlib-compressed — signature `78 9c`, which appears as
  `78 1c` after the 7-bit packing.
- Known commands include a master heartbeat (`$00`, must be sent ~1/s or the
  device stops volunteering telemetry), button states (`$06`), sound preset
  (`$0E`), and file request (`$35`, fetches project data and config JSON).
- libopz reads project state this way: per-track plug/step_count/step_length/
  quantize/note_style/note_length, per-note duration/note/velocity/
  micro_adjustment/age, and the full per-track sound parameter set.

Confidence: **RE, medium-high** for the frame and packing (two independent
projects agree and one ships working code), **medium** for individual command
byte meanings.

Yellowjacket implication: none, by contract — no sysex in the permission
request. But this explains a symptom: while the OP-Z app is connected, the same
single MIDI port carries a heavy sysex/telemetry stream. A browser tool that
requested sysex access would be reading that firehose; without sysex access
Chrome filters it out, which is the behaviour we want.

## 9. Direction summary

**OP-Z as sound source / slave (receives):**
- note on/off per channel → plays the track bound to that channel; velocity is
  accepted (OP-1 field's chart says 1–127; the OP-Z changelog only ever mentions
  velocity for the arp track, so per-track velocity response is **UNKNOWN**).
- Polyphony ceilings (DOC `/tracks` 11.3–11.4): drum tracks **2 notes per step**;
  bass mono; lead 3; chord 4 (6 with `generous_chords`, still 4 per step); arp
  monophonic and arpeggiates notes on the same step.
- Note style per track (DOC `/track` 5.2) changes what a held note does: drums
  retrig / mono / gate / loop; synths poly / mono / legato. A drum kit exported
  from Yellowjacket will sound different under `gate` vs `retrig` — this is the
  same OP-1 `playmode` field the patch carries, and firmware 1.2.5's release
  note warns explicitly that the OP-Z used to ignore the patch's playmode and
  treat everything as RETRIG.
- CC per §3; program change per §4; pitch bend on channels 1–16; clock and
  transport per §5.
- Incoming notes can be **recorded into steps** (1.1.23 "allow programming steps
  with external controller"), so an external controller is a first-class input
  to the sequencer, not just a sound trigger.

**OP-Z as controller / master (sends):**
- Every track sends note + CC on its channel when `outgoing_midi` and that
  track's `track_enable` are on. Outgoing CC numbers are per-track,
  per-parameter, via `parameter_cc_out` (defaults = 1…16).
- Clock out is independently gated and keeps running with note-out disabled.
- Sends pitch bend (fixed in 1.2.38 to use the remapped channel).
- Sends program change when `enable_program_change` is on, in the sense set by
  `alt_program_change`.
- `midi_echo` turns it into a soft-thru box: echo on the same port **and**
  through to other ports; incoming transport is relayed to other ports (1.1.23).
  With a USB host device attached this makes the OP-Z a small hub — and a
  feedback risk if Yellowjacket echoes anything back.

## 10. What this changes for CONTRACT-WIRE

Nothing in the contract is falsified. Five things sharpen:

1. **Add the default channel map as an assumption, not a fact.** Track N ↔
   channel N is well-supported but not published. The WIRE panel's channel
   filter defaults to ALL, which is the right default and needs no change.
2. **"Channel one to active" deserves a UI line.** If the user has it on,
   channel 1 follows the selected track. Yellowjacket's clock and CC work is
   unaffected; note routing on channel 1 is not deterministic.
3. **Clock-in defaults to OFF on the OP-Z.** The panel's copy for CLOCK OUT
   should say so, or the first hardware test will look like a Yellowjacket bug.
   (TEMPO + SCREEN, key 4.)
4. **The ClockIn estimator is validated by measurement, and the median trap is
   real.** Keep the windowed *mean* over 24 accepted intervals and the ±30%
   rejection. Measured: mean 98.17 bpm vs median 95.79 bpm on the same data;
   unfiltered windows read up to 105 bpm. Consider adding this measured
   histogram to the contract as the justification, so nobody "simplifies" the
   estimator later.
5. **The drum note base stays LEARN-only**, but the contract can now say
   *why* it is one integer and not a table: 24 contiguous semitones, slot i ↔
   base + i, base is 52 or 53 and unproven. Also note that the OP-Z's transpose
   buttons may move the receive window.

Two small additions worth making:
- Port matching can key on the literal CoreMIDI name `OP-Z` (measured), single
  in/out pair, all tracks multiplexed by channel.
- Song position pointer is documented as "not used", so there is no point ever
  sending `0xF2`.

## 11. Open questions (honest list)

- The drum note base (§6). One LEARN capture or one run of appendix A settles it.
- Whether transpose shifts the drum *receive* window.
- Factory defaults for the eight boolean MIDI settings. Only `timing_clock_in`
  is documented as off by default.
- Whether the OP-Z emits clock while stopped.
- The exact wire form of the stop/kill note burst.
- Whether incoming velocity affects drum voices, or only the arp track.
- CC 56 tempo: the 0–127 → BPM mapping.
- Bank select CC numbers used by the non-alt program change mode.
- The `X3CLATMB` field in the identity reply.

## Appendix A — the drum note base probe (Ian runs this; it makes sound)

Two variants. Both need only the OP-Z on USB. **Variant 1 is passive and
silent** and should be tried first.

**Variant 1 — listen (silent).** Enable outgoing MIDI (TEMPO+SCREEN, key 3),
select track 1 (KICK), then play the keyboard bottom to top and read the note
numbers off the capture. The lowest note printed is the base.

```bash
uv run --no-project --with python-rtmidi python - <<'PY'
import rtmidi, time
mi = rtmidi.MidiIn(); mi.ignore_types(sysex=False, timing=True, active_sense=True)
mi.open_port(mi.get_ports().index('OP-Z'))
print('play the OP-Z keyboard low to high on a drum track; 30 s')
seen = {}
t0 = time.time()
while time.time() - t0 < 30:
    m = mi.get_message()
    if m and (m[0][0] & 0xF0) == 0x90 and m[0][2]:
        ch, n, v = (m[0][0] & 0x0F) + 1, m[0][1], m[0][2]
        if n not in seen:
            seen[n] = (ch, v); print('note %3d  ch %2d  vel %3d' % (n, ch, v))
    else:
        time.sleep(0.001)
lo = min(seen) if seen else None
print('lowest note seen:', lo, ' -> 24 slots span', lo, 'to', lo + 23 if lo else '?')
PY
```

**Variant 2 — sweep (audible).** Sends one note at a time across 40–90 on
channel 1 and waits; you listen for where the kit starts and stops responding.
Turn the OP-Z volume down first. Twenty-four consecutive notes will sound and
the rest will be silent; the first sounding note is the base.

```bash
uv run --no-project --with python-rtmidi python - <<'PY'
import rtmidi, time
mo = rtmidi.MidiOut(); mo.open_port(mo.get_ports().index('OP-Z'))
for n in range(40, 91):
    print('note', n, flush=True)
    mo.send_message([0x90, n, 100]); time.sleep(0.35)
    mo.send_message([0x80, n, 0]);   time.sleep(0.25)
PY
```

Requires `incoming_midi` on (TEMPO+SCREEN, key 2) and the kick track's channel
set to 1. If `channel_one_to_active` is on, whichever track is selected will
sound instead — turn it off or select track 1.

## Appendix B — reproducing the clock measurement

```bash
uv run --no-project --with python-rtmidi python - <<'PY'
import rtmidi, time, statistics as st, collections
mi = rtmidi.MidiIn(); mi.ignore_types(sysex=False, timing=False, active_sense=False)
mi.open_port(mi.get_ports().index('OP-Z'))
iv = []; t0 = time.time()
while time.time() - t0 < 25:
    m = mi.get_message()
    if m and m[0][0] == 0xF8: iv.append(m[1])
    elif not m: time.sleep(0.0002)
iv = iv[2:]
print('n=%d mean %.4f ms (%.3f bpm) median %.4f ms (%.3f bpm)'
      % (len(iv), st.mean(iv)*1000, 60/(st.mean(iv)*24),
         st.median(iv)*1000, 60/(st.median(iv)*24)))
h = collections.Counter(round(x*1000*4)/4 for x in iv)
for k in sorted(h): print('  %6.2f ms %5d' % (k, h[k]))
PY
```

Needs clock out enabled on the OP-Z (TEMPO+SCREEN, key 5).
