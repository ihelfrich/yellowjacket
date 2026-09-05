# Device scan — Ian's OP-Z, 2026-09-03, read-only

Scanned in content mode over USB. Nothing was written, nothing ejected during
the scan. 34.6 MB volume, 24 MB of it budgeted for samples (the device's own
`import.log` says so: `Calculating used sample space...13.2/24.0 MB`).

## Tree
```
bounces/bounce01..05/{bounce.wav, project.opz}
config/{dmx.json, general.json, midi.json, userPresets.dat}
projects/project01..10[f].opz
rejected/                      (empty)
samplepacks/{1-kick,2-snare,3-perc,4-fx,5-bass,6-lead,7-arpeggio,8-chord}/01..10/*.aif
how_to_dmx.txt, how_to_import.txt, import.log
```

## The slot count is misleading, and this matters
All four drum tracks report 10/10 slots filled. They are not.

**17 real files; 38 zero-byte placeholders.** Every `~`-prefixed name is a
0-byte stub standing in for factory content held internally — `~TeKicks.aif`,
`~CuckooKicks.aif`, `~AlainFX.aif` and so on. They occupy a slot in the
listing without occupying the sample budget.

So "the kit tracks are full" is a UI fact, not a storage fact. Roughly 10.8 MB
of the 24 MB sample budget is free, and any slot holding a placeholder can take
a real patch by displacing something that was never a file.

## Formats, confirmed against real files
| thing | fact |
|---|---|
| drum patch | classic big-endian AIFF, `COMM` + `APPL 'op-1'` + `SSND`, 1 ch, 16-bit, 44100 Hz |
| synth patch (tracks 5-8) | same container, `"type":"sampler"`, **exactly 264600 frames = 6.000 s** |
| largest drum patch seen | 498304 frames (11.3 s), under the 529200 (12 s) ceiling |
| project | `.opz`, fixed 342848 bytes, binary, magic `49 00 00 00` then `ff` fill |
| bounce | plain RIFF WAVE, PCM, **stereo**, 44100 Hz, 16-bit |
| presets | `config/userPresets.dat`, 351202 bytes, binary |

## Three places our CONTRACT-WIRE disagrees with the device's own files
Read out of `samplepacks/1-kick/10/patch.aif`, written by the OP-Z itself:

| field | CONTRACT-WIRE §1 says | the device writes |
|---|---|---|
| `drum_version` | `1` | **`3`** |
| `playmode` | `8192` ("one-shot") | **`16384`** |
| `dyna_env` | `[0,8192,0,8192,0,0,0,0]` | `[0,8192,0,**0**,0,0,0,0]` |
| `lfo_params` | `[16000,16000,16000,16000,0,0,0,0]` | `[0,0,0,0,0,0,0,0]` |
| JSON encoding | "compact (no spaces)" | has spaces: `{ "drum_version" : 3, ...` |
| schema | 16 keys listed | also carries **`"editable": true`**, undocumented here |

**Not yet a proven bug.** The contract's claim is that version 1 is what every
working third-party writer emits and that the device reads it; our writer's
golden check still passes and its tests are green. What is now established is
that version 1 is *not what the device itself produces*, and that at least one
field we hardcode (`playmode`) differs. Whether v1 patches still load correctly
on current firmware is a question that can only be answered by writing a patch
to the device and ejecting, which is out of scope until Ian says so.

## The MIDI map is readable, not guesswork
`config/midi.json`, verbatim structure:
- `track_channels`: `[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,0]` — tracks 1-15 on
  MIDI channels 1-15, track 16 folded back onto channel 1.
- `parameter_cc_out`: a 16x16 matrix of CC numbers per track (mostly 1..16;
  tracks 6 and 16 carry a `0` in the first position).
- `channel_one_to_active: true`, `enable_program_change: true`,
  `timing_clock_in/out: true`, `midi_echo: false`.

This means WIRE does not have to assume a channel map or make the user
configure one: in content mode the map can simply be read. (The drum-track
*note base* the contract calls UNDOCUMENTED is a separate question and is not
in this file.)

## Undocumented settings the device UI does not expose
`config/general.json` carries ten booleans, several of which have no front-panel
control: `backlit_keys`, `generous_chords`, `disable_start_sound`,
`disable_param_page_reset`, `disable_track_preview`, `latch_notes_with_shift`,
`legacy_input_select`, `disable_headphone_db_reduction`,
`disable_microphone_mode`, `temp_param_add_fx_a`.

## Import behaviour, from the device's own log
```
[IMPORT STARTED]
Reading content disk...SUCCESS
Calculating used sample space...13.2/24.0 MB
  importing patch (1).aif...SUCCESS. New used space 15266 kB
  assigning perc/09/patch.aif
Syncronizing rejected / config / projects / bounces
Rebuilding plug definitions...SUCCESS
[IMPORT COMPLETE]
```
Import runs on eject, reports per-file success, and reassigns slots itself.
`rejected/` is currently empty, which is where anything it refuses reappears.

## The drum note base — measured 2026-09-03, and where it stands

**Answer: base 53**, i.e. the 24 drum slots occupy notes 53..76. Research had
narrowed it to 52 or 53 and could not close it from documentation, because TE
publishes no note rows at all.

**Evidence 1 (good).** Passive capture over CoreMIDI while Ian played the
keyboard low to high with track 1 selected. Channel 1 carried 16 distinct
notes: `53 55 58 59 61 62 63 64 65 66 69 71 72 74 75 76`. Lowest 53, highest
76, **span exactly 24** — matching the 24 drum slots exactly. The OP-Z keyboard
is two octaves (24 semitones), so on a drum track it maps 1:1 onto the slots,
and the keyboard's base note IS the drum base.

**Evidence 2 (weak, contaminated).** An active sweep sending notes 40..90 into
the device while recording its USB audio output. Nearly every note produced
sound, so the active track was a PITCHED one, not a drum track — the sweep
measured a synth responding chromatically across at least 51 semitones. Its
"longest contiguous run starts at 53" is an artifact of two dropped recording
buffers at 52 and 76, not a measurement. Recorded here so nobody later mistakes
it for confirmation.

**Confidence: good, not airtight.** A clean confirmation would repeat the
passive capture with the kick track definitely selected and the sequencer
stopped, and check that 24 consecutive notes address 24 distinct slices.

## Two side findings from the same session
- **Clock and note output are independently gated**, confirmed empirically and
  matching TE changelog 1.2.5 ("send clock out if enabled even though midi out
  is disabled"). Across two captures totalling five minutes, 12,568 messages
  arrived and **every one was a clock tick**. A device that is plainly alive on
  the wire can still be sending no notes at all; anything that waits for notes
  must say which of the two gates is closed rather than reporting silence.
- **Tempo, free.** 630 clock ticks per 15 s = 42 ticks/s; at 24 per quarter
  that is ~105 bpm. Clock alone gives the tempo with no interaction.
- **The OP-Z is a recordable audio input** (device "OP-Z", 2 ch, 44.1 kHz), so
  its output can be captured and analysed programmatically. That is what made
  the active sweep possible at all, and it is the basis for any future
  automated probe of the device's behaviour.
