# OP-Z — unconventional uses of the signal path and storage

Survey only. **Nothing here was written to Ian's device and nothing is proposed to be
written without a separate decision.** Where an idea requires modifying the unit — a file
on the content-mode volume, a config edit, a firmware notion — it is called out as
MODIFICATION REQUIRED and the risk is stated.

Companion to [`README.md`](README.md) and [`device-scan.md`](device-scan.md); those two are
the established base and are not re-derived here.

## Confidence labels used below

| Tag | Meaning |
|---|---|
| **DOC** | teenage engineering states it. Page named. |
| **RE** | Someone demonstrated it. Project or author named. |
| **MEAS** | Measured on Ian's own unit, 2026-09-03/04 (device-scan / midi.md). |
| **ARCH** | Follows from a hardware or protocol fact, but nobody has shown it working. |
| **SPEC** | Speculation. Said plainly. |
| **UNK** | Nobody has published it and it was not measured. |

And a second axis, because the brief asks for it:

**REAL** = it does something a reasonable alternative does not do, or does it cheaper.
**TOY** = it works, and it is strictly worse than the obvious alternative. Clever, not useful.

---

## 0. The three hard walls that bound everything below

1. **Firmware is closed permanently.** `z_firmware_1_2_45.zfw` is AES-256-CBC with the key
   held in the device and only a key *index* in the image; entropy 7.9998 bits/byte
   (**RE**, `ioma8/opz-firmware-notes`, 2025-10; summarised in `community.md` §6). The
   OP-1's `op1repacker` has no OP-Z equivalent and will not get one — TE pulled the
   product in 2025 and 1.2.45 (2022-03-31) is the last OS. **Every idea below therefore
   has to live in three places and only three: sample files, config JSON, and the wire
   protocols.** Anything requiring a firmware change is dead on arrival, not merely hard.

2. **USB is one port with one role at a time.** DMX out requires the OP-Z to act as USB
   *host* to a DMX interface ("plugged straight into the usb-c port"; the OP-Z supplies
   **max 100 mA**, so a powered hub is advised) [DOC, `/guides/op-z/lights`, `/usb`].
   Connected to the Mac it is a USB *device* (MIDI + 2-in/2-out class-compliant audio at
   44 100 Hz, **MEAS**). **INF, high confidence:** you cannot drive DMX and be attached to
   Yellowjacket at the same time. Any design that assumes both at once is wrong.

3. **The content-mode volume is not a free-for-all.** TE's own permissions table:
   projects and sample packs may be added/modified/removed; **bounces may only be
   removed**; **config may only be modified** (never added, never removed)
   [DOC, `/guides/op-z/disk-modes`]. Import runs on eject, rebuilds plug definitions, and
   dumps anything it refuses into `rejected/` — which was **empty** on Ian's unit
   (**MEAS**). That folder is the safety net for every write idea below.

---

## (a) The sampler as an arbitrary data carrier

### The physical basis, stated exactly

- 24.0 MB user sample pool, one shared budget across 8 track folders × 10 slots = 80 slots
  (**MEAS**: the device's own `import.log` prints `13.2/24.0 MB`; 10.8 MB free, because
  38 of the 55 listed files are 0-byte stubs).
- Drum patch: big-endian AIFF, mono, 16-bit, 44 100 Hz, ceiling 529 200 frames (12.000 s).
  Synth patch: identical container, **exactly** 264 600 frames (6.000 s) as the device
  writes it. Both carry an `APPL 'op-1'` JSON chunk (**MEAS**).
- The drum patch is **24 independently addressable regions** of one file — `start[]`/`end[]`
  arrays in the JSON, one per key across two octaves (**DOC** `/sampling` + **MEAS**).
- The device is a **class-compliant USB audio device at exactly 44 100 Hz** (**MEAS**) —
  the same rate the patch format demands. No sample-rate conversion anywhere in a
  host↔device audio round trip.
- **project + rec renders a 10-second bounce** to `bounces/bounceNN/bounce.wav`, plain
  stereo RIFF/PCM 44.1 kHz 16-bit, retrievable as a *file* in content mode. Max 5
  (**DOC** `/project` §7; **MEAS** on the format).

### Idea a1 — audio-as-data through the device. TOY, and the number says why.

The loop is: encode payload → write a `.aif` → import → trigger it from the sequencer →
recapture over USB audio (or off `bounce.wav`) → demodulate.

It works in principle. It is also **about six orders of magnitude worse than the
alternative**, which is that the same volume is *already a USB mass-storage disk*. One
content-mode mount moves ~2.8 × 10⁸ bits. Playing slices as symbols moves, generously:
24 slices = 4.58 bits/trigger; 4 drum tracks × 2-note polyphony × 8 steps/s at 120 bpm =
64 triggers/s ≈ **293 bits/s**, and that is before any error coding. Even a full-bandwidth
FSK carrier in the audio — `ggerganov/ggwave` (MIT, FSK, 6 tones in a 4.5 kHz band,
dF = 46.875 Hz, **8–16 bytes/s typical, 128 bps ceiling**) — lands in the same range.

So: encoding data as audio to move it through a device you can already mount is a party
trick. **Verdict: TOY as a data channel.** No modification is worth doing for this.

### Idea a2 — the same hardware, reframed: the OP-Z as a *channel under test*. REAL.

This is the version worth Ian's time, and it is the one his own tooling was built for.

`js/analysis/cyclic.js` recovers a **symbol clock (the cyclic frequency α)** from an
envelope, normalised per-bin to modulation depth so a quiet band and a loud one compare
directly. Its working band is `MIN_ALPHA_HZ = 0.5` to `DEFAULT_ALPHA_MAX_HZ = 30`.

Now put the OP-Z's documented numbers next to that band:

- LFO rate is **tempo-synced** in the order 1/64, 1/32, 1/16, 1/8, 1/4, 1/2, 1/1, 2/1 to
  the left of centre; free-running to the right (**DOC** `/parameter-pages`).
- Tempo is **40–200 bpm**, settable by *typing the digits* on the value keys
  (`tempo + 1 + 2 + 0 = 120`) — so it is exact, not dialled (**DOC** `/tempo`).

At 120 bpm the synced LFO ladder is **0.5, 1, 2, 4, 8, 16, 32 Hz** — the cyclic detector's
band almost exactly, endpoint for endpoint. The OP-Z is therefore a **cyclostationary
signal generator with a known, typed-in, exactly-quantised α**. That makes it a ground-truth
calibration source for `cyclic.js`: set α by keypad, read α off the plane, check the
detector reports the number you typed, and check the reported `usableAlphaHz` /
`nullAlphaHz` clamps behave as the module's own comments claim at 44.1 kHz.

The same rig then measures things nobody has published:

- **Envelope-domain transparency of the sampler.** Play a known-α probe through a drum
  slice at unity pitch, dry, and see what α survives.
- **What the master chain does to modulation depth.** The mixer's yellow dial is a
  **master compressor** ("punch", **DOC** `/mixer`) and MASTER always carries chorus/drive/
  filter/resonance (**DOC**). A compressor is an envelope-domain nonlinearity; it should
  show up as α-harmonic generation and depth compression. That is a *measurement*, and the
  detector is the right instrument for it.
- **Tape-track wow/flutter** as α-axis smear on a fixed-α probe.

Every step of this is **read-only over USB audio** if the probe is generated on the Mac and
fed in as the USB audio source (`shift + 3` selects incoming USB audio, **DOC**
`/input-selection`). Nothing is written to the device at all. **Verdict: REAL, zero risk,
and it is the one idea in this document that uses both things Ian already owns.**

### Idea a3 — steganography in the `.opz` project blob. TOY, and genuinely risky.

Projects are a fixed **342 848 bytes**, magic `49 00 00 00` then `ff` fill (**MEAS**), and
the Z-PO Project reports **~48 bytes still unidentified** (**RE**, `lrk/z-po-project`,
Apache-2.0). Tempting; don't. Auto-save is on by default and the device rewrites projects,
`libopz` has **no write path at all** to cross-check against, and the failure mode of a
malformed project is not a rejection into `rejected/` (that path is for samples) but a
project the device may or may not parse. **MODIFICATION REQUIRED. Verdict: TOY, and the
worst risk-to-reward ratio in this file.**

---

## (b) The microphone as a sensor; the device as a measurement instrument

### What is actually established

- Inputs: **built-in mic**, **headset mic**, **USB audio**, or the **ZM-4 line module**;
  `shift + 0` monitors the raw input, and TE warns "**this signal can be a lot louder than
  your synth sound**" (**DOC**, verbatim, `/input-selection`).
- The 3.5 mm jack is **4-pin** — stereo out *and* headset mic in on one connector
  (Sound on Sound's review and TE's "headphones, headset or line out"). So there is an
  analog input path that needs no module.
- **Input gain has exactly one documented reference point:** hold play + a top track button
  1–16, and "**button 4 (sample track) = 0 dB**" (**DOC** `/sampling`). That single anchor is
  the whole calibration story.
- A **440 Hz test tone** is built in (track toggles it in sample mode, **DOC**).
- There is a motion sensor: the LFO `gyro` shape is a documented waveform, and
  `general.json` carries `disable_microphone_mode` = "stop engaging the mic when the unit is
  tilted" (**DOC** `/reference` §24.3; **MEAS** — the key is present on Ian's unit).

### What is NOT established, and I am not going to pretend otherwise

- **No published spec exists for the OP-Z's own mic or its own 3.5 mm jack** — no
  sensitivity, no impedance, no level, no frequency response. TE publishes electrical specs
  for the *modules* only (§d). The FCC filing (**Z23012A**, granted 2018-11-08) lists
  "Block Diagram", "Schematics" and "Operational Description" as **metadata only, no files**,
  so the usual FCC route to internals is closed here. Internal photos exist; they are photos.
- **Whether the accelerometer can be read off-device is UNK.** The gyro exists and modulates
  audio internally. `nbw/opz` states plainly that track selection, play/stop, octave shift
  and screen buttons **do not transmit MIDI at all** (**RE**) — motion is not in any published
  CC or sysex map. Search results that appear to show "gyro" in videolab refer to
  **videolab's iOS host device sensors**, not the OP-Z's; TE's videolab wiki does not
  document what the OP-Z itself sends. Do not let anyone tell you the OP-Z's accelerometer
  is readable — nobody has shown it.

### Idea b1 — the OP-Z as a field measurement instrument. TOY.

Against a $20 class-compliant USB interface and a calibrated capsule, the OP-Z offers: an
uncalibrated mic, a 12 s (drum) / 6 s (synth) capture ceiling, one documented 0 dB gain
point and 15 undocumented ones, and retrieval that requires **rebooting into content mode**.
It measures nothing absolutely and retrieves nothing conveniently. **Verdict: TOY.** The
only thing it uniquely is, is pocketable, silent, battery-powered and shaped like a toy —
which is an *ethnographic* property, not a metrological one.

### Idea b2 — the OP-Z as a live front end into Yellowjacket. REAL, and cheap to test.

The 12 s ceiling is a *sampling* ceiling, not a *monitoring* one. The external input path
has filter, LFO, fx sends, pan and volume "just like on any instrument track" (**DOC**
`/tracks` 11.10) and feeds the master bus — and the master bus is what the host sees on the
OP-Z's **2 USB audio inputs at 44 100 Hz** (**MEAS**). If raw-input monitoring reaches that
stream, then `getUserMedia` in Yellowjacket gets **unlimited-length** OP-Z mic/line audio
with no import, no eject, no file.

**ARCH, untested, and it is a two-minute read-only test:** select the OP-Z as the input
device in Yellowjacket, hit `shift + 0` on the i/o track, and look at the spectrogram.
`BKLronin/underbridge` (GPL-3.0) already proves the general capture path works — it drives
the OP-Z over `mido` while recording its USB audio with `pyaudio`, one folder per track —
so the only open question is whether the *raw input* is in that stream. **Verdict: REAL if
it passes, and it costs nothing to find out.** Note the licence: underbridge is GPL-3.0,
do not vendor it into a closed bundle; read it, don't copy it.

### Idea b3 — an external sensor into the headset mic pin. TOY, and there is a hazard.

Electrically possible; you would be building a bias-powered electret-style front end into an
input with no published spec. TE's own warning for the line module is verbatim: "**never
connect the 3.5mm sockets on line module to any phantom power such as coming from a
mic-input on a sound cards or a mixer as this could destroy the sockets**"
(**DOC** `/guides/op-z/modules/line`). Treat the main unit's jack at least as conservatively.
**Verdict: TOY, plus a real risk of destroying a discontinued device's socket.**

---

## (c) The sequencer as a general-purpose timed event engine

This is the strongest section in the file, and one finding in it is genuinely new to me.

### The DMX path is not a lighting feature; it is a general byte-output port

- LIGHTS (track 15) drives DMX through a USB DMX interface on the OP-Z's own port; up to
  **16 fixtures**, **max 128 channels**, mapped by `config/dmx.json` (**DOC** `/lights`;
  **MEAS** — the file is on Ian's unit). Channel types: `red green blue white color
  intensity fog knob1..knob8`, a literal fixed 0–255, `on`, `off`.
- DMX512 itself is a general 512 × 8-bit output bus refreshing at **~44 Hz** at full
  universe (ENTTEC's own explainer: break 88 µs + MAB 8 µs + 513 slots × 44 µs ≈ 22.7 ms).
- Off-the-shelf **DMX → 0–10 V decoders** and DMX relay/dimmer packs are commodity items.
  So the far end of the OP-Z's lighting track can be a motor driver, a valve, a heater, a
  relay bank — anything that takes 0–10 V or a contact closure.

**And now the finding that makes it general:** `iFreilicht/opz_artnet_adapter` (**RE**,
CC0-1.0) puts an **FTDI232 that impersonates an "ENTTEC DMX USB Pro"** in front of an
**ESP-01 WiFi module**, and the OP-Z drives it happily. That is a demonstration that the
OP-Z's DMX output is *just the Enttec Pro serial protocol over USB* and that a five-dollar
microcontroller can stand in for a lighting interface. **The OP-Z's LIGHTS track is
therefore an arbitrary-payload output to arbitrary hardware, and someone has already
proved it.** `open-fixture-library`'s OP-Z plugin (exports `/config/dmx.json`) is the
tooling for writing the profiles.

**The honest limit, which nobody states clearly:** it is *not* 128 independent bytes.
`knob1..knob4` are the LIGHTS track's four dials on page 1 and `knob5..knob8` the same four
on page 2 — **eight independent continuous values for the entire track**, fanned out across
up to 128 channels, plus the sequencer's per-step colour/intensity/pattern stream and `fog`
fired by animation 14. So the real shape is **8 continuous 8-bit controls + a 16-step
trigger/colour stream at ~44 Hz**, not a 128-byte frame you author.

**MODIFICATION REQUIRED** — `dmx.json` is a config file, and config may only be *modified*,
never added or removed. That is a write to Ian's device and is out of scope until he says
otherwise. **Verdict: REAL.** Of everything in this survey, this is the capability that
does something no reasonable alternative does at this size and price.

### Trig-driven tracks: the sequencer as an externally clocked state machine

Step-length **multiplier 0 makes a track trig-driven** — it advances exactly one step per
trigger received on the oplab module, or whenever a `jump` component fires with value 0
(**DOC** `/track` 5.3–5.10). Each of the 16 tracks holds its own step count and its own
multiplier. So: 16 independent 1–16-state machines, each advanceable by an external
electrical event, each able to emit MIDI on its own channel and drive DMX.

**Verdict: REAL as a concept, gated by hardware.** It needs the **ZM-1 oplab module**, which
is discontinued, needs external power, and is scarce on the used market. Risk is procurement,
not engineering.

### Timing: what the measurement actually says

The outgoing clock was characterised on Ian's own unit (**MEAS**, midi.md): the inter-message
interval distribution is **bimodal, not noisy** — two tight modes about **1.35 ms** apart,
which is USB full-speed frame quantisation, against a 25.51 ms nominal period at 98 bpm.
There were also pathological arrivals at 0.00 ms and 9.00 ms (coalesced deliveries).

**So: the OP-Z is a musically excellent and metrologically mediocre event clock.** Do not
build anything that needs sub-millisecond determinism on it. Anything that tolerates
±1.5 ms and occasional coalescing is fine. Also note `timing_clock_in` is **disabled by
default** (**DOC** `/tempo` 9.8) — a factory-state unit ignores clock you send it.

---

## (d) The audio output as a control-voltage-like source

### What is documented, and it is the modules, not the unit

TE publishes electrical specs for the **modules only**. Verbatim:

| ZM-1 oplab | value |
|---|---|
| CV out | 0 to +5 V |
| CV 2 / 3 out | −5 to +5 V |
| gate out | 0 to +5 V |
| trig in | −10 to +10 V |
| midi in | −10 to +10 V |
| MIDI TRS pinout | "tip = sink, ring = source", stereo cable required |

| ZM-4 line | value |
|---|---|
| line out | **2.2 dBu (2.8 V peak-to-peak)** |
| line in | 2.2 dBu nominal, **max 13.2 dBu (10 V peak-to-peak)** |
| po out | 0 to +3.3 V |
| trig out | 0 to +5 V |
| midi out | 0 to +5 V |

CV is driven by **track 14**; "module track (track 14) is dedicated for the external
sequencing of cv", and "**oplab module transmits all midi channels from OP–Z**" — the TRS
out is not a subset of the USB stream (**DOC**, both `/modules/oplab`).

### Is the OP-Z's own headphone jack DC-coupled? Almost certainly not.

**No published spec exists** — not from TE, not in the FCC filing (schematics are metadata
only), not in any teardown I can find. What can be said:

- `general.json` carries `disable_headphone_db_reduction` — "stop reducing output level
  based on **headphone impedance**" (**DOC** `/reference` §24.3; **MEAS** — present on Ian's
  unit). That is a headphone driver with load sensing and *deliberately load-dependent gain*.
- **ARCH, high confidence:** a headphone amplifier of this class is AC-coupled, and a
  load-dependent output level is disqualifying for anything voltage-referenced regardless.
  A sample carrying a DC offset will not produce a DC output.
- **Therefore: 1 V/oct pitch CV out of the main jack is not available.** Anyone claiming
  otherwise should be asked for a scope trace. Use oplab for CV; that is what it is for.

### What the main jack *can* do: audio-rate control. REAL, and narrow.

AC coupling does not stop **pulses**. Pocket Operator sync is exactly that: the click on the
**left** channel, **2 PPQN**, ~1 V typical from a PO itself, tolerant to 5 Vpp, with the
impulse working between roughly **3–67 ms** (secondary sources: soundtech, spongefile — treat
the exact numbers as FORUM-grade, the *shape* as settled). So a short click sample panned
hard left on a drum track, sequenced at the right subdivision, syncs a PO from the main jack
with no module at all. The same trick drives anything with an audio-rate trigger input —
envelope followers, sample-and-holds, drum-machine trigger ins.

**Honest caveats:** a Korg SYNC IN wants ~5 V pulses and the OP-Z's jack is unspecified and
load-dependent — expect to need a booster or to be lucky. `po out` on the line module is
specified at 0 to +3.3 V, which tells you TE did not consider the main jack the sync path.

**Verdict: REAL but narrow.** Audio-rate triggers yes; pitch CV no; anything needing a stable
absolute voltage no.

---

## (e) MIDI CC streams as a data channel

### Out of the device: TOY.

The MODULE track (14) "**acts as a MIDI track with 16 independent MIDI CC values**" when no
module is inserted (**DOC** `/tracks` 11.10). Those 16 are the four dials across four
parameter pages — knob values, not per-step payload. Realistic rate: the sequencer changes
values at step boundaries; at the 200 bpm ceiling with 16th steps that is 13.3 steps/s.
Even generously assuming all 16 CCs change every step, that is ~1.5 kbit/s, and timing is
quantised at **~1.35 ms** by USB frames (**MEAS**). Against "send the bytes from the
computer", it is worse on every axis. **Verdict: TOY.**

### Into the device: not novel. That is just WIRE doing its job.

### The genuinely useful thing in this area is the CC *map*, not the CC *stream*. REAL.

`config/midi.json` exposes `parameter_cc_out` as a **16 × 16 matrix** — one row per track,
one entry per dial parameter — read straight off Ian's unit (**MEAS**). Untouched rows read
`[1,2,…,16]`, i.e. outgoing CC defaults equal TE's incoming CC numbers. `track_channels`
is `[0,1,…,14,0]` and is likewise just sitting there in JSON.

That means **the OP-Z's entire outgoing control-surface identity is editable data**. You can
make its dials emit exactly the CC numbers some non-musical target expects, on channels you
choose, without touching firmware and without a translator in the middle. As a way of
turning a discontinued groovebox into a bespoke control surface for a rig that does not
speak music, that is real.

Two cautions. TE's stated range "0 – 255" for `parameter_cc_out` is **impossible on a 7-bit
wire**; assume 0–127 usable and >127 = unassigned (**INF**). And this is **MODIFICATION
REQUIRED** — `midi.json` is config, modify-only, and a bad map is a device whose controls
silently address the wrong things until you fix the file.

---

## (f) The device as a physical random or entropy source

### The sequencer's "random" is not entropy. TOY.

Randomness is everywhere in the UI: `random` values on **pulse**, **multiply** (quantize),
**velocity**, **ramp up/down**, the dedicated **random** component, **portamento**, the three
**spark** trig conditions, LFO random shapes (free-running and note-triggered), and
`track + rec` = randomize preset (**DOC** `/step-components` §6, `/parameter-pages`, `/track`).

But: this is an embedded device with closed firmware. **UNK** what the generator is —
nobody has looked, and nobody can, because the image is AES-256 with an on-device key.
**ARCH:** it is a small software PRNG, very likely a LCG or xorshift, seeded from something
cheap. Using it as an entropy source would be trusting an unaudited black box for the one
property you cannot verify by using it. **Verdict: TOY. Do not use it for anything that
matters.**

### The ADC noise floor is real physics — and the OP-Z is a bad place to harvest it. TOY.

Thermal noise in a mic preamp is a genuine entropy source, and LSB extraction with von
Neumann debiasing is the standard recipe. But you get the identical physics from any audio
interface, with a published noise spec, without a 12 s capture ceiling and a reboot to
retrieve. The OP-Z adds nothing except the risk that some undocumented AGC or dither in the
path is *structuring* the noise you are treating as free. **Verdict: TOY.**

### The version that is actually worth doing: *measure* the randomness. REAL, read-only.

Nobody has published how good the OP-Z's `random` is. It is cheap to find out and requires
zero writes: sequence a track with random velocity (or the random component), capture the
MIDI stream over Web MIDI for a long run, and run the resulting byte sequence through the
standard battery — serial correlation, period search, spectral test, and specifically a
**cyclic/α-domain sweep**, because a short-period LCG will show up as a spike on the α axis
in exactly the tooling Ian already has. Recovering a repeat period would be a genuine,
publishable-in-a-blog-post reverse-engineering result about a device whose firmware nobody
can open.

**Verdict: REAL as an experiment, TOY as a source.** That distinction is the whole answer to
this sub-lens.

---

## Two more that the brief did not ask for but belong here

### The bounce as a rendering oracle. REAL, small.

`project + rec` renders 10 s of the current pattern to a **file** — an internal digital
render at 44.1/16 that never crosses a DAC. Five slots. Combined with the fact that engines,
plugs and presets are all addressable over MIDI, that is a way to harvest ground-truth
renders of the device's 12 synth engines and 6 effects under controlled parameter sweeps —
the raw material for modelling or emulating them, or simply for a reference library that
outlives the discontinued hardware. Note the asymmetry: **bounces can only be removed** from
the host side, never added, so this is a device-initiated write only (pressing project + rec
is a user action on the unit; nothing is written *by us*).

### YAFFS2 de-duplication is why the slot arithmetic lies. Useful to know, not exploitable.

Internal storage is **YAFFS2**, and names beginning `~` are **de-duplication stubs** — one
stored copy referenced from several packs (**RE**, Z-PO Project). That is the mechanism
behind the 38 zero-byte files on Ian's unit and behind "all four drum tracks report 10/10
slots full" while 10.8 MB of the budget is free. **SPEC, and I would not chase it:** whether
identical user samples across slots also de-duplicate against the 24 MB budget is untested,
and the import path recalculates used space itself.

---

## Risk register — what each idea would actually cost

| Idea | Writes to device? | Worst realistic outcome |
|---|---|---|
| a2 cyclic calibration / channel characterisation | **No** | none — USB audio in, nothing written |
| b2 live front end into Yellowjacket | **No** | none — it either appears in the stream or it doesn't |
| f3 measuring the PRNG | **No** | none — passive MIDI capture |
| Bounce as rendering oracle | device-initiated only | consumes 1 of 5 bounce slots |
| a1 audio-as-data | **Yes** — sample file | rejection into `rejected/`; the safe failure mode |
| c1 DMX as actuator bus | **Yes** — `config/dmx.json` | config is modify-only; a bad profile means wrong channels until fixed. Also needs hardware the OP-Z hosts on 100 mA |
| e3 custom CC map | **Yes** — `config/midi.json` | controls silently address the wrong CCs until the file is fixed |
| a3 `.opz` steganography | **Yes** — project blob | a project the device may not parse; ~48 bytes are still unidentified and auto-save rewrites projects. **Don't** |
| b3 sensor into the headset pin | no file write | TE's own warning: a destroyed socket on a discontinued device |

## Sources

- teenage engineering guides: [`/lights`](https://teenage.engineering/guides/op-z/lights),
  [`/input-selection`](https://teenage.engineering/guides/op-z/input-selection),
  [`/hardware-overview`](https://teenage.engineering/guides/op-z/hardware-overview),
  [`/modules/oplab`](https://teenage.engineering/guides/op-z/modules/oplab),
  [`/modules/line`](https://teenage.engineering/guides/op-z/modules/line)
- FCC ID [Z23012A](https://fccid.io/Z23012A) — granted 2018-11-08, DTS 2402–2480 MHz,
  0.0018 W conducted; **block diagram / schematics / operational description are metadata
  only, no files**
- [`iFreilicht/opz_artnet_adapter`](https://github.com/iFreilicht/opz_artnet_adapter) — CC0-1.0,
  FTDI232 impersonating an ENTTEC DMX USB Pro + ESP-01
- [Open Fixture Library OP-Z plugin](https://open-fixture-library.org/about/plugins/op-z) —
  exports `/config/dmx.json`
- [ENTTEC, "What is DMX512?"](https://support.enttec.com/dmx/dmx-basics/what-is-dmx512) — ~44 Hz
  full-universe refresh
- [`ggerganov/ggwave`](https://github.com/ggerganov/ggwave) — MIT, FSK data-over-sound, 8–16 B/s
  typical
- [`BKLronin/underbridge`](https://github.com/BKLronin/underbridge) — GPL-3.0, `mido` + `pyaudio`
  USB-audio capture of the OP-Z
- [`ioma8/opz-firmware-notes`](https://github.com/ioma8/opz-firmware-notes),
  [`lrk/z-po-project`](https://github.com/lrk/z-po-project),
  [`nbw/opz`](https://github.com/nbw/opz),
  [`patriciogonzalezvivo/libopz`](https://github.com/patriciogonzalezvivo/libopz)
- [teenageengineering/videolab wiki](https://github.com/teenageengineering/videolab/wiki/MIDI-input)
  — does **not** document OP-Z motion data reaching the host
- Pocket Operator sync (secondary, FORUM-grade on exact numbers):
  [soundtech](https://www.soundtech.co.uk/musicians-blog/pocket-operator-sync-modes.html),
  [spongefile](https://www.spongefile.com/pocket-operator-sync-modes-explained/)
- Sound on Sound OP-Z review (4-pin 3.5 mm jack, headphone/line out)
- Local, and outranking published claims where they conflict:
  [`device-scan.md`](device-scan.md), [`midi.md`](midi.md), [`community.md`](community.md),
  and `/Users/ian/Developer/yellowjacket/js/analysis/cyclic.js`
