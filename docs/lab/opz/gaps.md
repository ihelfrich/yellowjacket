# OP-Z · what the device actually is, where the work is, and what Yellowjacket could take off the pile

Research pass 2026-09-04. Read-only throughout: nothing was written to the
device, and no device reboot was performed. Every claim below is tagged.

**[DOC]** teenage engineering's own guide, product page, or downloads page.
**[RE]** reverse-engineered by a named open-source project, source read.
**[LOCAL]** measured on this Mac with the OP-Z connected, 2026-09-04.
**[COMM]** community write-up or forum. Lowest confidence; called out inline.
**[INF]** my inference from the above, labelled as such.

Do not re-derive `docs/CONTRACT-WIRE.md` §1–2 from this file. That contract is
byte-verified and still correct; this file only *adds* to it.

---

## 1. The device, measured here

`ioreg -p IOUSB`: **[LOCAL]**

```
+-o OP-Z@01100000  IOUSBHostDevice
    "USB Product Name"  = "OP-Z"
    "USB Vendor Name"   = "teenage engineering ab"
```

`system_profiler SPAudioDataType`: **[LOCAL]**

```
OP-Z:
  Input Channels:    2
  Output Channels:   2
  Manufacturer:      teenage engineering ab
  Current SampleRate: 44100
  Transport:         USB
```

This is the single most useful fact in this document and it is not in TE's
guide. **The OP-Z is a class-compliant USB audio device in both directions at
exactly 44 100 Hz** — the same rate the drum-patch format demands. Core Audio
"Input Channels: 2" means the Mac can *capture the OP-Z's main output*; "Output
Channels: 2" is the sink the guide refers to when it lists `usb` as a sampling
input source. No cable, no re-digitisation, no rate conversion.

TE's own spec sheet says the analogue side is a "48kHz 24-bit dac", 115 dB
dynamic range, Blackfin 70x DSP **[DOC]**. The 48 kHz DAC and the 44.1 kHz USB
interface are not in conflict — the DAC rate is the output converter, the patch
format and the USB stream are 44.1.

Current OS: **OP-Z OS 1.2.45** **[DOC, downloads page]**. TE ships no sample-pack
tool of its own; the downloads page has firmware, the app (iOS/macOS/Android), a
quick-start PDF, and a knob STL. That absence is the whole opportunity.

## 2. The documented device contract

**Tracks** **[DOC, /guides/op-z/tracks]** — sixteen, fixed:

| # | track | # | track |
|---|-------|---|-------|
| 1 | KICK  | 9 | FX1 |
| 2 | SNARE | 10 | FX2 |
| 3 | PERC  | 11 | TAPE |
| 4 | SAMPLE| 12 | MASTER |
| 5 | BASS  | 13 | PERFORM |
| 6 | LEAD  | 14 | MODULE |
| 7 | ARP   | 15 | LIGHTS |
| 8 | CHORD | 16 | MOTION |

Tracks 1–4 are the drum group: "sample based and consist of 24 different sounds
across the musical keyboard. this is called a kit". Tracks 5–8 are the synth
group and take "an up to 6 second long chromatic sample".

**Keyboard** **[DOC, /guides/op-z/interface-overview]** — "OP-Z features a two
octave musical keyboard"; black keys double as value keys, white keys as
component keys; `–`/`+` transpose the keyboard and change the current octave.
Two octaves = 24 keys = the 24 slices, 1:1. **[INF, high confidence]**

**Sampling** **[DOC, /guides/op-z/sampling, /input-selection]**
- Sources: built-in microphone, headset microphone, **via usb**, or the line
  module. Selected with `shift`+1 / +2 / +3; `shift`+0 monitors the raw input.
- "the connected device needs to be a usb audio host in order for OP-Z to
  recognize it" — a Mac is one. Confirmed by §1.
- Enter sample mode: hold `stop` + `rec`. Hold `rec` to record from the active
  source, release to stop.
- Drum sampler: **up to 12 seconds**, 24 slices. Synth sampler: **up to 6
  seconds**, chromatic.
- On-device slice editing: green dial = start, blue = end, yellow = pitch, red =
  gain, for *the active slice only*. `shift`+note copies the active slice to the
  pressed key.
- "fully compatible with the OP-1 drum kit file format".

**Disk / content mode** **[DOC, /guides/op-z/disk-modes]**
- Enter: hold `track` while powering on. (Upgrade mode is `screen` + power.)
- `samplepacks/` holds **8 track folders × 10 slot subfolders = 80 pack slots**.
- **"you can store a total of 24mb of sample data"**.
- Accepted format: OP-1 `.aif`, drum variant for tracks 1–4, synth variant for
  5–8. Anything else lands in `rejected/` at the next content-mode entry.
- `how_to_import.txt` and `how_to_dmx.txt` sit on the content disk.
- Content mode also exposes projects, bounces, and the MIDI/DMX config.
- "OP-Z will update and restart when ready… do not power off your device during
  this process." Import happens on eject.
- **[COMM]** "Only one sample pack per slot folder will be imported, any
  additional ones will be rejected", and failures are logged to `import.log`,
  readable in content mode. Two independent community sources; not in the guide.

**Projects** **[DOC, /guides/op-z/project]** — "each of the 10 projects holds 16
pattern". Auto-save by default. The guide says nothing about the on-disk project
file format.

**MIDI** **[DOC, /guides/op-z/midi]** — the full incoming table is CC-only:
absolute CC 1–18 (param1, param2, cutoff, resonance, A/D/S/R, LFO depth/speed/
target/shape, FX1 send, FX2 send, pan, volume, portamento, note style), the same
set as relative CC 32–49, system CC 50–57 (track gain, gain relative, reset
gains, mute, audio mute, mute group, tempo, swing), track CC 60–63 (step count,
step length, quantize, note length), pattern select CC 103 (0–15 select, 16 next,
17 previous), UI CC 102. `midi.json` in content mode carries
`channel_one_to_active`, `incoming_midi`, `outgoing_midi`, `timing_clock_in`,
`timing_clock_out`, `enable_program_change`, `alt_program_change`, `midi_echo`,
`track_enable`, `track_channels` (1–16), `parameter_cc_out` (0–255).
"sending a midi timing clock to your OP-Z will automatically put it into external
sync mode."

**There is no note-number row anywhere in that table.** Neither TE's guide nor
midi.guide's aggregated OP-Z page lists which MIDI notes fire the 24 drum slices.
CONTRACT-WIRE's "ship a LEARN capture, never hardcode a guess" is not caution —
it is the only correct design, and there is a second reason for it below.

**No display.** **[DOC, /hardware-overview, /app]** The unit has track LEDs, a
motion LED, a mic LED and a volume knob. The "screen" is the phone/Mac app, and
the app is documented as parameter view, Photomatic and Motion visuals — TE
documents **no waveform display and no sample-pack management** in it. Editing 24
slice boundaries on an OP-Z is done by ear, one slice at a time, with a coloured
dial and no picture.

## 3. The file formats

### Drum (tracks 1–4) — already byte-verified in CONTRACT-WIRE §1

Not repeated here. Two things that contract does not currently carry:

**Field ranges** **[RE, AlexCharlton/op-patch-util `src/op1.rs`]**, read at
`main` on 2026-09-04:

```rust
start:    [u32; 24]
end:      [u32; 24]
pitch:    [i16; 24]   // -24567/0/24567; 512 per semitone; -48 to +48
reverse:  [u16; 24]   // 8192 / 16384
volume:   [u16; 24]   // 0 / 8192 / 16384
playmode: [u16; 24]   // 0 / 8192 / 16384
dyna_env: [u16; 8]  lfo_params: [u16; 8]  fx_params: [u16; 8]
```

`js/export/op1patch.js` writes `pitch: 0 ×24` unconditionally. Per CONTRACT-WIRE,
**the OP-Z reads start/end/pitch and ignores the rest** — so `pitch` is one third
of everything the OP-Z actually honours, and the bench currently leaves it on the
floor. 512 units = 1 semitone, range ±48 semitones.

That same repo confirms the community `4058` constant is an approximation:
`starts[i] = sound_data.len() as u32 * 2029;  // Confusing magic number`
where `len` is in *bytes* (2 per frame), i.e. frames × 4058. Yellowjacket's exact
`floor(frame × 2147483646 / 529200)` (= 4057.9987…/frame) is the better rule.
Nothing here changes it.

**The 24-second low-res mode** **[RE, two independent implementations]**
op-patch-util 1.1.0 added `drum --low-res`: "Halve the sample rate, but pitch up
the result by an octave. This effectively doubles the total available sample
length to 24 seconds, at the expense of a lower-resolution." Implementation:
decimate the PCM 2:1 and set every `pitch[i] = 12 * -512 = -6144`, so the device
plays the half-length data an octave down, back at the original pitch and speed.
DigiChain independently ships the same idea ("Pitch up all exported files by 1, 2
or 3 octaves to reduce the file-sizes") and explicitly supports OP-Z kits. Two
tools, same trick, so the mechanism is real; **whether an OP-Z honours it has not
been verified on hardware here.** op-patch-util's decimation is a raw
drop-every-other-sample with no anti-alias filter; Yellowjacket already owns a
Kaiser-windowed sinc converter and would beat it outright.

### Synth (tracks 5–8) — out of scope today, and worth having

**[RE, op-patch-util `src/op1.rs` + `src/main.rs`]** the APPL JSON is a second
type, `"type":"sampler"`:

```rust
name: String, synth_version: 2, octave: 0, base_freq: 440,
adsr:  [u16; 8]  // default [64, 10746, 32767, 10000, 4000, 64, 4000, 4000]
knobs: [u16; 8]  // default [0, 0, 22501, 22501, 8192, 0, 6183, 8192]
lfo_active/lfo_type/lfo_params, fx_active/fx_type/fx_params as in drum
```

Length: `let target_len = 44100 * 6 * 2;` — 6 s of mono 16-bit at 44.1 kHz =
**264 600 frames / 529 200 bytes**. op-patch-util truncates when longer and does
*not* pad when shorter. **[COMM, gerotakke.de "OP-Z synth sample hack"]** says
the OP-Z wants the file **exactly** 6 s, mono, 16-bit, 44.1 kHz, and that because
`base_freq` is 440 the source must be tuned to A or it maps to the wrong notes.
Community source, single author — but it is the only write-up of the synth
variant and it agrees with the Rust code on every number that overlaps. Treat
"exactly 6 s" as likely-true and pad to 264 600 frames; treat `base_freq` as
settable, which is the interesting part (see opportunity 7).

### What the format cannot express

Mono only, 16-bit only, 44 100 Hz only, 24 slices, one contiguous PCM run.
There is no per-slice gain the OP-Z reads, no stereo, no loop points in the drum
variant. Anything you want the OP-Z to hear must be *baked into the samples*.

## 4. The arithmetic nobody does, and the constraint it exposes

One full-length drum patch:
`529 200 frames × 2 B = 1 058 400 B ≈ 1.009 MiB` of PCM, plus ~700 B of headers.

The device has **80 pack slots** and **24 MB of sample storage**.

- 24 MiB / 1.009 MiB ≈ **23 full-length drum patches**. Twenty-three, out of
  eighty slots. The slot count is decorative; the byte budget binds.
- To fill all 80 slots you get `25 165 824 / 80 = 314 572 B` per slot =
  **157 286 frames = 3.57 seconds average**, not 12.
- A 6 s synth patch costs 529 200 B; 24 MiB / that ≈ 47 of them.
- In low-res mode the same 12 s of material costs half the bytes — i.e. the
  trick is not really about reaching 24 s, it is about **doubling how many packs
  fit on the device**.

Whether TE means MiB or MB, and whether the budget counts file bytes or PCM
bytes, is **unknown**. The difference is 23 patches vs 22.

The device's only feedback on all of this is: reboot into content mode, drag
files, eject, wait for the restart, reboot into content mode again, and look in
`rejected/`. That is the loop the bench can collapse.

## 5. Where the friction actually is

Walked end to end, from the docs above:

1. **Getting audio in.** On-device sampling is 12 s from a mic, a headset, USB,
   or a line module. Anything with fidelity ambitions goes through a computer,
   because the alternative is the built-in mic.
2. **Slicing is blind.** 24 slice boundaries, set one at a time, by ear, on a
   device with no display, with an app that shows no waveform. There is no
   zero-crossing snap, no undo, no way to see that slice 14 starts 6 ms late.
3. **Naming and provenance do not exist.** A pack is `samplepacks/3/7/`. The
   `name` field is 24 ASCII characters inside the JSON and the device UI never
   shows it. Six months later, slot 3/7 is a mystery.
4. **The budget is invisible until eject.** See §4. There is no meter.
5. **The round trip is one-way.** A kit you sampled on the device can be copied
   off in content mode, but to change one slice you must rebuild the kit — and
   the sources may only ever have existed inside that .aif.
6. **Every content-mode visit costs two reboots** and an "update and restart"
   cycle you are told not to interrupt.
7. **Tuning.** Slices are pitched with the yellow dial, blind, per slice, and the
   `pitch` field that would let a tool do it in one pass is the one field most
   writers leave at zero — including Yellowjacket.
8. **Synth tracks 5–8 need a file that is exactly 6 s and tuned to A**, which no
   recording ever is.

## 6. Ranked opportunities

Ordered by drudgery removed per unit of work. "Writes to device" is called out
explicitly; everything else is read-only or produces a file the user places.

### 1. Kit import — read an OP-Z/OP-1 `.aif` back into the bench · READ-ONLY
`parseDrumPatch()` already exists in `js/export/op1patch.js` and is documented
there as "Test-only by design… later an import path". It already reads layout A
(AIFC/`sowt`, which is what real devices write) and layout B, folds multi-channel
to mono, and returns `{json, frames, sampleRate, pcm}`. The `start[]`/`end[]`
arrays invert through `positionOf` to frame indices, so 24 clips fall straight
out onto the bench timeline with their boundaries intact.
Removes friction 5 and 2 outright: edit a slice boundary with a waveform and a
zero-crossing, keep the other 23, re-print. This is the highest ratio of value to
new code in the whole list — the hard part is written and tested.
*Needs first:* confirmation that device-recorded packs appear as readable `.aif`
under `samplepacks/<track>/<slot>/` (§7).

### 2. Whole-disk pack builder + byte-budget planner · READ-ONLY (emits a .zip)
Lay out all 80 slots as a grid, assign kits to slots, show live bytes against the
24 MB ceiling and per-slot seconds, then emit a `samplepacks/` tree as one ZIP
with exactly one `.aif` per slot folder (the "one pack per slot folder" rule).
Kills friction 4 and 6: one content-mode visit instead of a guess-eject-reject
loop, and the rejection is predicted before the reboot rather than discovered
after it.
*Note:* writing the files onto the mounted OP-Z volume directly (File System
Access API, `showDirectoryPicker`) is possible in Chrome and **would be a write
to the device** — keep it behind the ZIP until Ian asks for it.

### 3. Capture the OP-Z's output over USB at 44.1 kHz · READ-ONLY
§1 proves the port exists. `getUserMedia({audio:{deviceId, echoCancellation:false,
noiseSuppression:false, autoGainControl:false, sampleRate:44100}})` records the
device's own output at exactly the patch rate — no resample, no analogue stage,
no cable. Then HARVEST classifies it into a labelled eight-voice kit and the
existing PATCH path prints it back. That closes the loop the OP-Z cannot close by
itself: jam → harvest → kit → device.
This is also the answer to friction 1: the bench becomes the good input, and the
built-in mic stops being the only option.
*Needs first:* confirm Chrome enumerates the OP-Z as an input and does not force
48 kHz (§7).

### 4. Low-res 24 s mode, done properly · READ-ONLY
Add an optional per-slice `pitch[]` to `buildDrumPatch` and a `lowRes` flag that
decimates 2:1 through the existing Kaiser converter (not by dropping samples) and
writes `pitch[i] = -6144`. Doubles the time budget *and* halves the byte cost —
which, per §4, is the constraint that actually binds. Two independent tools do
this; Yellowjacket would be the only one doing it without aliasing.
*Must be validated on hardware before it ships as anything but an opt-in.*

### 5. Per-slice pitch and tune-to-key · READ-ONLY
`pitch` is one of the three fields the OP-Z reads and the bench writes 0 into it.
512 units per semitone, ±48. HARVEST already labels roles and the bench already
estimates spectra, so "tune every TONE/BASS slice to the scene key" is one pass
over data that already exists, replacing 24 blind turns of the yellow dial.

### 6. Pre-flight validator and rejection explainer · READ-ONLY
Drop any `.aif` in and get the verdict the device only gives after two reboots:
rate ≠ 44 100, not mono, > 529 200 frames, > 24 slots, malformed APPL, more than
one pack in a slot folder. Extend it to read the device's own `import.log` and
`rejected/` when the user points the bench at a content-mode volume. `preflight`
already exists as a concept on this machine; this is the hardware dialect of it.

### 7. Synth-track patches for tracks 5–8 · READ-ONLY
Doubles the exporter's reach from 4 tracks to 8. Requirements are known: `"type":
"sampler"`, `synth_version: 2`, mono s16 44.1 kHz padded to exactly 264 600
frames, and `base_freq`. The bench can **detect the fundamental and write
`base_freq` to match**, which removes the "your sample must be in A" tax the
community write-up documents. Lower rank only because the JSON schema is [RE]
plus [COMM] rather than byte-verified, and it needs hardware validation.

### 8. MIDI: 24-pad LEARN and clock-conformed slices · READ-ONLY
Two additions to what CONTRACT-WIRE already specifies. First, LEARN should
capture a **24-note map**, not a single base, and must be re-runnable — because
the OP-Z's `–`/`+` transpose the keyboard, the absolute note for slice 0 is not a
constant, it is a session state. Any hardcoded base is wrong half the time by
construction. Second: the OP-Z enters external sync the moment it receives clock,
so CONFORM can stretch slices to the tempo the bench is already broadcasting, and
the printed kit lines up with the device's sequencer with no arithmetic.

### 9. Push audio into the OP-Z's sampler over USB · **WRITES TO THE DEVICE**
`AudioContext.setSinkId()` to the OP-Z output, user holds `rec`, and the device
samples the bench directly — no content mode, no reboot. It is the only path that
gets audio onto the OP-Z without the disk. **It creates a sample pack on the
device and consumes the 24 MB budget.** Listed for completeness; do not build it
in the read-only phase.

## 7. Unknowns, and the cheapest way to close each

All read-only except where noted. Entering content mode reboots the device and
remounts it; it writes nothing, but it is a device state change.

1. **Which MIDI notes fire the 24 slices, and whether they follow the octave
   transpose.** Not in TE's guide, not in midi.guide. → Connect Web MIDI, LEARN,
   press the lowest drum key, then press `+` and repeat. Ten seconds, and it
   settles whether LEARN must be re-runnable.
2. **Does the OP-Z honour `pitch[]` well enough for low-res 24 s?** → Print one
   low-res kit, one normal kit of the same material, listen for octave error and
   aliasing.
3. **Does a synth patch have to be exactly 264 600 frames?** → Two files, one
   short and one exact, one content-mode visit, read `rejected/`.
4. **Is "24mb" MiB or MB, and does it count file bytes or PCM bytes?** → Fill the
   disk with known-size patches until one is rejected. Answers §4 exactly.
5. **Do device-recorded packs appear as readable `.aif` in `samplepacks/`?**
   This is the precondition for opportunity 1. → Sample something on the device,
   enter content mode, look.
6. **What does `how_to_import.txt` say?** It is TE's authoritative statement on
   import rules and it is sitting on the device unread. → One content-mode visit.
7. **Does Chrome enumerate the OP-Z as an audio input, and at what rate?** →
   `navigator.mediaDevices.enumerateDevices()` in the bench. Blocks opportunity 3.
8. **Does the OP-Z present a USB-MIDI port to Chrome alongside the audio
   interface?** `ioreg` confirms one USB device; the interface classes were not
   enumerated. → Open the WIRE panel and look at the port list.
9. **What rate does the OP-Z's own sampler record at?** The DAC is 48 kHz/24-bit,
   the format and the USB interface are 44.1/16. Unknown, and it decides whether
   a device-recorded slice survives a round trip unresampled.

## Sources

Primary (teenage engineering): the OP-Z guide sections
[sampling](https://teenage.engineering/guides/op-z/sampling),
[disk modes](https://teenage.engineering/guides/op-z/disk-modes),
[midi](https://teenage.engineering/guides/op-z/midi),
[tracks](https://teenage.engineering/guides/op-z/tracks),
[project](https://teenage.engineering/guides/op-z/project),
[input selection](https://teenage.engineering/guides/op-z/input-selection),
[usb](https://teenage.engineering/guides/op-z/usb),
[hardware overview](https://teenage.engineering/guides/op-z/hardware-overview),
[app](https://teenage.engineering/guides/op-z/app),
[interface overview](https://teenage.engineering/guides/op-z/interface-overview);
the [OP-Z product page](https://teenage.engineering/products/op-z);
[downloads](https://teenage.engineering/downloads);
the [OP-1 drum mode guide](https://teenage.engineering/guides/op-1/original/drum-mode).

Reverse-engineering (source read): [AlexCharlton/op-patch-util](https://github.com/AlexCharlton/op-patch-util)
`src/op1.rs`, `src/main.rs`; [brian3kb/digichain](https://github.com/brian3kb/digichain);
[joseph-holland/op-patchstudio](https://github.com/joseph-holland/op-patchstudio)
(now OP-XY-focused; the closest browser-tool prior art);
[schollz/teoperator](https://github.com/schollz/teoperator).

Community, lower confidence, flagged inline: [gerotakke.de OP-Z synth sample hack](https://gerotakke.de/op-z-sample/);
[Z-PO Project](https://lrk.github.io/z-po-project/default_sample_packs/);
[midi.guide OP-Z](https://midi.guide/d/teenage-engineering/op-z/).

Local measurement: `ioreg -p IOUSB -w0 -l`, `system_profiler SPAudioDataType`,
this Mac, 2026-09-04.
