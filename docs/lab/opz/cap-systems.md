# OP-Z as a system component — capability survey

**Lens:** the OP-Z inside a larger system, attached to a laptop and detached from one.
What roles it can play **right now, with no modification**, what each unlocks, and which
combinations exist that neither the OP-Z nor Yellowjacket can reach alone.

**Status: survey only. Nothing was written to the device, nothing will be.** Where a
capability would require a write — to the content disk, to `config/*.json`, or to
firmware — it is marked **[WRITE]** and left as a decision for Ian, not an action.
The device was **detached** during this pass (`system_profiler SPAudioDataType` and
`SPUSBDataType` both show no OP-Z), so nothing here is a fresh measurement; the MEAS
facts are carried from `device-scan.md` and `midi.md`.

**Reads:** [`README.md`](README.md), [`device-scan.md`](device-scan.md),
[`formats.md`](formats.md), [`midi.md`](midi.md), [`guide.md`](guide.md),
[`community.md`](community.md), [`gaps.md`](gaps.md). Those are established and are not
re-derived here. This file adds the systems layer and the primary sources behind it.

## Confidence key

| Tag | Meaning |
|---|---|
| **DOC** | teenage engineering says it, in its own guide, spec sheet, or changelog. |
| **FCC** | In the equipment-authorization filing. Regulator-facing, so hard to fudge. |
| **VENDOR** | A component supplier says it about its own part in this product. Interested party, but specific and checkable. |
| **MEAS** | Measured on this Mac against Ian's own OP-Z (carried from the prior passes). |
| **RE** | Reverse-engineered or demonstrated by a **named** project whose source was read. |
| **FORUM** | Forum reports. Named and dated where possible; never load-bearing alone. |
| **ARCH** | Architecturally possible — follows from hardware and protocol facts above, unproven in this configuration. |
| **SPEC** | Speculation. Said plainly, never dressed as fact. |
| **UNK** | Not published, not measured. |

---

# 0. The nine facts that constrain every role below

Everything in this document is a consequence of these. They are worth stating once,
because most of the interesting limits are not about what the OP-Z can do — they are
about what it cannot do *at the same time*.

1. **One USB-C port, and it is host XOR device.** The OP-Z is a USB device (to a
   computer) *and* a USB host (MIDI gear, DMX widgets plug straight in) — but it has
   exactly one connector. **DOC** (`/guides/op-z/usb`; product page lists "usb type c"
   for both roles). Consequence: *attached to the laptop* and *hosting a DMX interface*
   are mutually exclusive over the cable. This single fact kills more combinations than
   anything else, and it is also what makes the Bluetooth path (§7) valuable.
2. **Host mode supplies max 100 mA, out of a 740 mAh battery.** **DOC** (usb chapter;
   product page: "Li-Ion 740 mAh", "6 hour battery life", "1 year stand-by time", "user
   replaceable"). TE's own DMX page: *"connecting the dmx interface directly to you OP-Z
   is convenient but might deplete you battery faster than you want. in that case, use a
   powered hub."*
3. **Devices presenting as more than one MIDI device are not supported** in host mode.
   **DOC**. TE's tested-good list is short: OP-1 (direct), oplab (needs power,
   discontinued), Korg microKEY Air 25 (direct); hub Kingston Nucleum; DMX Enttec
   DMXUSB Pro (direct) and Pro Mk2 (needs power). Since 1.1.27 two MIDI devices work
   through a powered hub.
4. **The USB audio interface is 2-in / 2-out at exactly 44 100 Hz, class-compliant, both
   directions.** **MEAS** (`system_profiler SPAudioDataType`: Input Channels 2, Output
   Channels 2, Current SampleRate 44100, Transport USB). This is not in TE's
   documentation anywhere and it is the most useful single fact about the device as a
   system component. Two channels means **master mix only** — there are no stems.
5. **Content mode is a boot mode, not a concurrent one.** Mass storage requires holding
   **track** while powering on; the disk is a staging view of an internal YAFFS2 image,
   and *nothing takes effect until eject*, after which the device runs an import pass and
   restarts. **DOC** (`/guides/op-z/disk-modes`) + **MEAS** (`import.log`). So "USB stick"
   and "instrument" are two different boots of the same object.
6. **One MIDI port pair, all sixteen tracks multiplexed by channel.** **MEAS** — exactly
   one CoreMIDI input and one output, both named literally `OP-Z`. On Ian's unit
   `track_channels = [0,1,…,14,0]`, i.e. tracks 1–15 on channels 1–15 and **track 16
   folded back onto channel 1**, with `channel_one_to_active: true`. Channel 1 is
   therefore doubly ambiguous on this device.
7. **There is a 2.4 GHz radio, and it speaks MIDI.** **FCC** — grant Z23012A, 2018-11-08,
   equipment class Digital Transmission System, band 2402.0–2480.0 MHz, with internal
   photos, two test reports and an RF-exposure exhibit on file. **VENDOR** — Nordic
   nRF52832 SoC providing "MIDI over Bluetooth LE wireless connectivity"; the same SoC
   supervises the "low-power 12-bit hall-effect sensors which measure the position of the
   synthesizer's control knobs". **DOC** — pairing is via a pair button on the back.
8. **The analogue side and the USB side run at different rates and that is not a
   conflict.** DAC is 48 kHz / 24-bit, 115 dB dynamic range, Blackfin 70X DSP, Cirrus
   Logic audio co-processor **DOC** (product page); the USB stream and the patch format
   are 44.1 kHz. The USB path is the one that needs no resampling.
9. **The target is frozen.** Last firmware 1.2.45 (2022-03-31); hardware withdrawn from
   TE's store around March–April 2025. Nothing below will be fixed, added, or broken by a
   future release. Every limit here is permanent.

---

# 1. Role A — USB audio interface, 2 in / 2 out, 44.1 kHz

**Confidence: MEAS (the interface) + DOC (the input path) + RE (third-party proof).**
**Attached only.** Detached, this role does not exist — there is no USB host.

## What comes out

The Mac sees two input channels at 44 100 Hz: the OP-Z's **master bus**. Anything the
OP-Z makes — sixteen tracks summed, through master fx, tape, and the punch-in
performance track — arrives in the browser at exactly the rate the OP-1 patch format
demands. `getUserMedia({audio:{deviceId, echoCancellation:false, noiseSuppression:false,
autoGainControl:false}})` is the whole capture path; this is already ranked as
opportunity 10 in [`README.md`](README.md) and gaps §3.

**What it replaces:** an audio cable, an ADC, a rate converter, and a physical input on
some other interface. There is no analogue stage in this path at all.

**Limits, stated honestly:**

- **Two channels is the master mix.** No per-track stems, ever. Multitracking an OP-Z
  performance means capturing MIDI on 15 channels *and* the stereo master, then
  re-rendering — which is what the community Ableton templates do.
- **Whether the USB stream is a digital tap of the master bus or a re-digitised analogue
  signal is UNK.** It matters for any claim of bit-transparency. One loopback test
  settles it (§9, check 3).
- **Whether the raw-input monitor (`shift`+0) reaches the USB output is UNK.** If it
  does, the OP-Z's built-in mic becomes a USB microphone for the bench with no sampling
  step at all. If it does not, mic material has to go through the sampler first.
- **Chrome may not honour 44 100 Hz.** The device presents it; Chrome's own graph may
  resample. This is the standing gate on opportunity 10 and remains unchecked.

## What goes in

The Mac can also send two channels **to** the OP-Z, and the OP-Z has a documented
place to put them. **DOC**, `/guides/op-z/input-selection`: input sources are
`shift`+1 internal microphone, `shift`+2 headset, **`shift`+3 "incoming usb audio
signal, if a signal is detected over usb"**, `shift`+0 monitor raw input. The critical
sentence, verbatim: *"the connected device needs to be a usb audio host in order for
OP–Z to recognize it."* A Mac with the OP-Z plugged into it is exactly that.

And the incoming signal is not a dumb monitor path — TE: *"input signal settings include
filter, lfo, fx sends, pan and volume works just like on any instrument track"*, on
track 14 (module / I-O), sharing the bass/lead/chord parameter-page layout.

**What it replaces:** the entire content-mode round trip for getting audio *into* the
device — and with it the `.aif` contract, the `drum_version`/`playmode` disagreement, the
two reboots per attempt, and the silent `rejected/` folder. See combination C3, which is
the most valuable idea in this document.

**Third-party proof that this works with a non-TE host:** `xmacex/connect-opz`
(**RE**, GPL-3.0) runs `alsa_in` and `alsa_out` against a connected OP-Z and routes both
directions into Jack, using the OP-Z as the audio interface for a monome **norns**. That
is a Linux host, no TE software, bidirectional, in production use. It is the cleanest
existing evidence that role A is not Mac-specific or app-mediated.

---

# 2. Role B — 15-channel MIDI controller with a 16 × 16 CC matrix

**Confidence: DOC (the CC map) + MEAS (the matrix on his device) + RE (demonstrated in
Ableton).** **Attached over USB; also detached over BLE — see §7.**

The OP-Z sends note, CC, pitch bend, program change and clock, per track, on that
track's channel, whenever `outgoing_midi` and that track's `track_enable` are on.
Outgoing CC numbers come from `parameter_cc_out` — a **16 × 16 matrix**, one row per
track, one entry per dial parameter, read straight out of `config/midi.json` on his unit
(**MEAS**). Untouched rows read `[1,2,…,16]`, so **the outgoing defaults equal TE's
published incoming CC numbers** — meaning the map is knowable without a single LEARN
gesture, and CC 1–4 = white page, 5–8 = green, 9–12 = purple, 13–16 = amber mirrors the
device's own page model exactly.

That is **240 addressable controls** (15 usable channels × 16 CCs) plus 15 channels of
notes plus pitch bend, from a 212 mm slab with four encoders and 51 keys.

**What it replaces:** a dedicated control surface. A Push, a Launchkey, a nanoKONTROL.
And unlike those, it is also a sound source and a sequencer while it does it.

**Demonstrated, not theoretical:** `artaction/OP-Z_Controls_Ableton` (**RE**) ships an
Ableton session template and instrument racks that plug-and-play 8 instrument tracks and
effects in Live with OP-Z CCs mapped to comparable Live parameters; `artaction/Ableton2OP-Z`
does the reverse direction and is already cited in [`README.md`](README.md) §2.8 as the
best evidence for the drum note base. Both are the community's proof that the OP-Z is
usable as a general control surface for software that has never heard of it.

**Limits:**

- **Channel 1 is a trap on this specific device.** Track 16 is folded onto channel 1
  (`track_channels[15] = 0`) *and* `channel_one_to_active: true`, so incoming channel-1
  traffic follows whichever track the performer has selected. For deterministic control,
  use channels 2–15 and leave channel 1 alone.
- **The controls are not motorised and there is no display.** Encoder positions are read
  by hall-effect sensors (**VENDOR**, Nordic), so values are absolute *positions*, and
  there is no feedback path to show the host's value on the device. Any host-side
  parameter the OP-Z drives will jump on first touch unless the host implements
  takeover.
- **Muted tracks swallow incoming notes**, not just outgoing audio (**FORUM**,
  corroborated by `track_enable` semantics). Clock still passes.
- **Track selection, play/stop, octave shift and screen buttons transmit nothing**
  (**RE**, `nbw/opz`). A host cannot mirror the device's UI state over ordinary MIDI.
- **Whether the 6-axis motion sensor transmits anything over MIDI is UNK.** The gyro
  appears only as an internal LFO shape in TE's documentation. If it does not transmit,
  the accelerometer is unavailable to a host — which removes an otherwise attractive
  expressive channel.
- **[WRITE-adjacent]** `outgoing_midi` state on Ian's unit is **UNK** — the scan captured
  five of the eight booleans and that was not one of them. Turning it on is a front-panel
  toggle (TEMPO+SCREEN, key 3) that persists into `config/midi.json`. Normal user action,
  fully reversible, but it *is* a change to device state.

---

# 3. Role C — MIDI clock master or slave

**Confidence: DOC + MEAS.** **Attached; also detached over BLE with a caveat (§7).**

Both directions are independently gated: `timing_clock_out` and `timing_clock_in`, keys
5 and 4 under TEMPO+SCREEN. **On Ian's unit both read `true`** (**MEAS**), which is
notable because incoming clock is **off by default from the factory** (**DOC**,
`/tempo` §9.8) and is the single most expensive OP-Z debugging trap there is.

**As master.** Standard `0xF8` at 24 ppqn, `0xFA/0xFB/0xFC` transport, tempo 40–200 BPM,
swing on the blue dial. Clock-out is independent of note-out, so the OP-Z can be a pure
clock source with every track silent. Measured over 90 s (**MEAS**): the interval
distribution is **bimodal, not noisy** — two tight modes ~1.35 ms apart straddling the
nominal period, which is USB 1 ms frame quantisation, and the mode weights recover the
nominal BPM exactly. A windowed *mean* over 24 intervals reads 98.17 BPM where a median
reads 95.79. That is why Yellowjacket's `ClockIn` uses a mean and a ±30 % rejection band,
and why nobody should ever "simplify" it.

**As slave.** Incoming clock auto-arms external sync; song position pointer and active
sense are documented as **not used**, so `0xFB` resumes from wherever the OP-Z itself
stopped and there is no point ever sending `0xF2`. Yellowjacket's `ClockOut` already
occupies this seat, and [`midi.md`](midi.md) §12 is explicit that browser-as-master is
the **more reliable direction**: driving external gear *from* the OP-Z has repeated
**FORUM** reports of dropped notes with several channels active, unquantified and never
acknowledged by TE.

**What it replaces (as master):** a hardware clock box for a modular or drum-machine rig.
Add the ZM-1 oplab module and the OP-Z gets TRS MIDI in/out (standard Type A pinout),
CV/gate on track 14 (tip = note CV 0…+5 V, ring = CV2 ±5 V, gate tip 0/+5 V), and a
pocket-operator sync mode — at which point it is a complete sequencer brain for a rig
with no computer in it at all. **The oplab is discontinued and it is unknown whether Ian
owns one**; without it, the OP-Z's only sync output is USB.

**Limits:**

- **Whether the OP-Z emits clock while its sequencer is stopped is UNK.** The measurement
  was taken with clock already flowing. Do not assume incoming clock implies a running
  master.
- **The stop burst.** The OP-Z emits a burst of kill-notes when stop is pressed; TE
  documents panic only as a *user* gesture, never as an automatic emission on `0xFC`.
  Yellowjacket's 50 ms suppression window after an incoming `0xFC` stands on its own
  observation, not on TE.
- **BLE clock is a different proposition** — see §7.

---

# 4. Role D — USB mass storage, as a carrier for arbitrary files

**Confidence: DOC + MEAS.** **Attached only, and only in content mode.**

**This role is real and nearly useless, and it is worth saying so plainly rather than
listing it as a feature.**

The facts: 34.6 MB volume (**MEAS**), of which 24 MB is the device's own sample budget
and 13.2 MB of that is already used, across 17 real files and 38 zero-byte
de-duplication stubs. Entering the mode requires holding **track** while powering on —
a reboot. Leaving it requires an eject, which triggers an **import pass** that
reads the disk, reassigns slots, renames files (`importing patch (1).aif...SUCCESS` then
`assigning perc/09/patch.aif`), rebuilds plug definitions, and restarts the device
(**MEAS**, `import.log`). Content it refuses reappears in `rejected/` **the next time
content mode is entered** — so a failed import is completely silent at eject time
(**DOC** + **MEAS**).

**What it replaces:** a USB stick, badly. Roughly 10 MB of usable free space, two reboots
per visit, and an import pass that actively rewrites the directory you just wrote to.

**Limits and one real risk:**

- **Foreign files are not a documented case.** TE documents what it *accepts* (OP-1 `.aif`
  drum and synth formats) and what happens to what it rejects. What the import pass does
  with a PDF or a tarball dropped in the root is **UNK** — plausibly ignored, plausibly
  moved to `rejected/`, plausibly deleted.
- **Undocumented content can crash the device or the app** (**RE**, Z-PO Project).
  Recovery is a factory reset from upgrade mode. That is a real cost for a role whose
  entire upside is 10 MB of the world's most inconvenient thumb drive.
- **Even a read-only visit ends in an import pass.** The prior scan was careful to note
  that it wrote nothing *and did not eject during the scan*. Any content-mode visit that
  ends normally ends with the device rewriting its own state.
- **[WRITE]** Anything in this role beyond looking is a write. Not done, not recommended.

**The defensible version of this role** is not "carrier for arbitrary files" — it is
**"readable filesystem"**: `config/midi.json` hands over the real channel map and CC
matrix instead of Yellowjacket assuming one; `config/general.json` exposes ten booleans
several of which have no front-panel control; `import.log` and `rejected/` explain
failures the front panel never mentions; and `bounces/bounceNN/bounce.wav` is plain RIFF
WAVE that the bench can already parse (§6, C5). That is opportunity 6 in
[`README.md`](README.md), it is read-only, and it is the only version of this role worth
building.

---

# 5. Role E — standalone battery sampler with a built-in microphone

**Confidence: DOC.** **Detached. This is the only role that is strictly better detached.**

- **Battery:** 6 hours, 740 mAh Li-Ion, user replaceable, ~1 year standby (**DOC**,
  product page; the standby figure is corroborated by **VENDOR** — Nordic attributes it
  to the nRF52832's low-power modes).
- **Microphone:** "integrated mems microphone" (**DOC**, product page), sited on the left
  next to the volume knob with its own LED (**DOC**, hardware overview). Selected with
  `shift`+1 on the I/O track.
- **Drum sampler (tracks 1–4):** one file **up to 12 s**, sliced into **24 sounds across
  the keyboard**, "fully compatible with the OP-1 drum kit file format" — which is TE
  confirming `PATCH_SLOTS = 24` and `PATCH_MAX_FRAMES = 529 200` in its own words.
- **Synth sampler (tracks 5–8):** **up to 6 s**, chromatic. Device-written synth patches
  measure **exactly 264 600 frames** (**MEAS**), so the 6 s is a hard requirement, not a
  ceiling.
- **Bounce:** project + rec renders a **10-second stereo WAV** of the current pattern plus
  a copy of the project. **Maximum 5**; a sixth flashes red. Format confirmed against real
  files: plain RIFF WAVE, PCM, stereo, 44 100 Hz, 16-bit (**MEAS**).
- **Expressive capture with no host:** 6-axis motion sensor (**DOC** + **VENDOR**), whose
  gyro is available as an LFO shape — TE's own pro-tip is LFO destination = filter, shape
  = gyro, then physically tilt the unit.

**What it replaces:** a field recorder — but only for material you intend to *play*, not
material you intend to archive. It is the only capture device in the room that also
sequences what it captured, sixteen tracks deep, on battery.

**Limits:**

- **Monitoring.** There is a built-in speaker, but TE's hardware overview mentions it only
  as the thing that "will play a startup sound" — and `general.json` carries a
  `disable_start_sound` boolean, which fits that reading. The documented audio output is
  the 3.5 mm 4-pole jack (headphones / headset / line out). Whether music is audible
  through the internal speaker at usable level is **UNK** and is a ten-second check.
- **The budget binds long before the slots do.** 8 folders × 10 slots = 80 slots, but 24 MB
  total: a full-length drum kit is ≈1.01 MB, so ≈23 full kits fit, not 80. On Ian's device
  ≈10.8 MB is actually free, and every "full" slot holding a `~` stub can take a real patch
  by displacing something that was never a file.
- **Five bounces, ten seconds each, current pattern only** — a chain still caps at 10 s.
  This is a sketchpad, not a session recorder.
- **Getting the material off requires content mode**, i.e. a reboot in and a reboot out
  with an import pass in between. There is no wireless file transfer; the BLE link is MIDI,
  not storage.

---

# 6. Role F — DMX brain

**Confidence: DOC + MEAS (`dmx.json` exists on his disk).** **Detached, or attached to a
DMX widget — never to a laptop at the same time.**

Track 15 (LIGHTS) sequences DMX through a **USB DMX interface plugged straight into the
USB-C port** — which puts the OP-Z in host mode and therefore takes the port. Up to 16
fixtures, **max 128 channels total**, value keys select one of 10 patterns, white keys
trigger effects and animations. `config/dmx.json` maps sequencer data to channels
(**MEAS** — the file is on his device): channel types red / green / blue / white / colour
wheel / intensity 0–255, fog 0|255 fired by animation 14, `knob1`–`knob4` = the four
dials on parameter page 1, `knob5`–`knob8` = the same four on page 2, plus literal fixed
values and `on`/`off`.

**The important structural point:** `knob1..knob8` mean the DMX rig is driven by the same
four encoders that drive the synth, on the same parameter pages, quantised to the same
sequencer. Lighting is not a separate program running alongside the music — it is a
seventeenth voice of the same instrument.

**What it replaces:** a lighting desk and its operator, for a small rig, with the light
cues locked to the music by construction rather than by a human following along.

**Limits:**

- **It costs the USB port.** Attached to a laptop, the OP-Z cannot host the DMX widget.
  See §8 for the exclusion table, and C7 for the one topology that escapes it.
- **It costs battery.** 100 mA from 740 mAh, and TE says so in the DMX chapter itself.
- **TE's compatibility list is short:** Enttec DMXUSB Pro direct; Pro Mk2 needs external
  power. Anything presenting as more than one device is unsupported.
- **`dmx.json` is hand-authored.** Fixture profiles are the user's problem, there is no
  library, and editing the file is **[WRITE]** — content mode, eject, import, reboot.
- **128 channels is a real ceiling** for anything past a handful of modern RGBW movers.

---

# 7. Role G — BLE MIDI peripheral (not in the original list, and it changes several answers)

**Confidence: FCC + VENDOR + DOC (existence and pairing); FORUM, named and dated
(pairing to a Mac); ARCH (Web MIDI reaching it).** **Detached — that is the point.**

The OP-Z has a certified 2.4 GHz radio (**FCC** Z23012A, Digital Transmission System,
2402.0–2480.0 MHz, granted 2018-11-08) driven by a Nordic nRF52832, and what it speaks
is **MIDI over Bluetooth LE** (**VENDOR**, Nordic's own release; **DOC**, TE's product
page lists "Bluetooth LE" and the app guide documents a pair button on the back).
Changelog 1.2.45 — the last firmware ever shipped — includes "reduced ble midi jitter",
which is TE confirming the link is real and imperfect in the same line.

**The part that matters for a laptop:** BLE MIDI on macOS is not an app-private channel.
Apple's Audio MIDI Setup pairs BLE MIDI peripherals directly (Window → Show MIDI Studio →
Configure Bluetooth), and once paired the device is an ordinary CoreMIDI endpoint
available to every application. Web MIDI is, in Chromium's own words, "a thin layer on
top of industry standard MIDI APIs such as CoreMIDI" — so a BLE-paired OP-Z should appear
to Chrome exactly like the USB one does.

**This is corroborated by dated, named forum reports and it is recent.** op-forums thread
31340 ("Op-z bluetooth 2026"), January 2026: two users failed to pair via the macOS
Bluetooth settings pane — Kosta on a Mac Mini running macOS 26 ("only sees the OP-Z via
USB"), Hopeeasy on a 2013 MacBook Air on Big Sur. A third user, Victory, gave the correct
route — Audio MIDI Setup → MIDI Studio → Configure Bluetooth, then press the OP-Z's pair
button. Hopeeasy: *"it works like a charm"*. Kosta: *"everything works as expected"*,
adding that the control is "hidden behind the arrow in the upper right corner". **FORUM,
but three named users, one week, current macOS, with a specific and reproducible
procedure** — that is about as strong as a forum claim gets.

**What it unlocks:** the OP-Z stops needing the cable to be a controller. That frees the
USB-C port for host mode (see C7), removes the tether from the performance, and makes a
detached OP-Z a first-class input to a browser bench sitting across the room.

**Limits, and one of them is disqualifying for a specific use:**

- **Jitter.** BLE MIDI adds roughly **10–30 ms of jitter** on top of USB MIDI latency
  (cited by the WebMIDIcon project's BLE-MIDI documentation; consistent with BLE
  connection-interval behaviour). The OP-Z's *USB* clock is already bimodal at ±1.35 ms
  from USB frame quantisation (**MEAS**). **Conclusion: use BLE for notes and CC; do not
  use it as a clock reference.** Yellowjacket's `ClockIn` mean-over-24 estimator would
  survive it statistically, but a 30 ms jitter floor on a 25 ms tick period is not a
  sync source, it is a suggestion.
- **Whether the BLE endpoint carries the same CoreMIDI name `OP-Z`** — which Yellowjacket's
  port matcher keys on — is **UNK**. One pairing settles it.
- **Whether audio travels over BLE: it does not.** The radio is a MIDI transport. Detached
  audio still requires the headphone jack or a later content-mode harvest.
- **Pairing is a one-time host-side action**, not a device modification. Nothing is written
  to the OP-Z.

---

# 8. What cannot happen at the same time

This table is the most useful thing in this file. Most OP-Z system ideas die here, and
the two that survive are the interesting ones.

| A | B | Simultaneous? | Why |
|---|---|---|---|
| USB audio (either direction) | USB MIDI | **Yes** | Same cable, same enumeration. **MEAS** + **DOC** (1.2.5 added 2-ch USB audio alongside MIDI). |
| USB audio in (Mac → OP-Z) | USB audio out (OP-Z → Mac) | **Yes** | Class-compliant 2-in/2-out, full duplex. **MEAS**. |
| Attached to laptop | Hosting a DMX widget / keyboard | **No** | One USB-C port, host XOR device. **DOC**. |
| Attached to laptop | Content mode | **No, sequentially only** | Content mode is a separate boot; instrument functions are gone while it is mounted. **DOC**. |
| Content mode | Audio + MIDI | **No** | Same reason. Whether *any* MIDI port appears in content mode is **UNK** and is a listed open question. |
| BLE MIDI to laptop | Hosting a DMX widget on USB-C | **ARCH — yes** | The radio and the USB port are independent subsystems. Untested in this combination; this is C7 and it is the best idea in this document. |
| BLE MIDI to laptop | USB attached to the same laptop | Pointless, not impossible | Two endpoints for one instrument; would double every event unless one is muted. |
| Per-track audio stems over USB | — | **Never** | Two channels. Physically settled. |
| OP-Z hosting two MIDI devices | — | Only through a powered hub, since 1.1.27 | And nothing presenting as more than one MIDI device, ever. **DOC**. |

---

# 9. Combinations — what the pair can do that neither can alone

Ranked by value, with the unproven part of each named.

### C1 · Laptop does the DSP, OP-Z is the clock and the surface · attached · read-only
The oldest idea and still the best-supported one. Yellowjacket's `ClockIn` already
estimates BPM from the OP-Z's `0xF8` stream with a measurement-justified estimator;
`MidiWire` already parses note/CC/transport. Add the 16 × 16 `parameter_cc_out` map —
which is **readable from the device rather than guessable** — and the OP-Z becomes a
240-control surface for a browser that is doing all the heavy audio work.
**Unlocks:** the browser's DSP with hardware's ergonomics; four encoders and 51 keys with
no mouse.
**Unproven:** nothing structural. `outgoing_midi` state on his unit is **UNK**.
**Risk:** none — read-only, no device state change beyond a possible front-panel toggle.

### C2 · One performance, two engines, one clock · attached · read-only
The OP-Z sequences its own eight audio tracks *and* simultaneously transmits notes on 15
channels. So the same 16-step performance drives the OP-Z's own voices **and** whatever
the bench is running, from one transport, on one clock, with per-track mute deciding
which engine plays what. TE's audio-only mute (hold mixer + shift) is exactly the tool
for this: muted tracks **stop feeding the master bus but keep sending MIDI**.
**Unlocks:** a hybrid instrument where the split between hardware and software voices is
a live performance decision, not a routing decision.
**Unproven:** dropped-note reports when driving external gear from the OP-Z with several
channels active (**FORUM**, unquantified). Measure before relying on it.

### C3 · The digital sampling bridge — the loop closed without ever writing to the device · attached · read-only
**This is the most valuable idea in this survey.**
Yellowjacket renders a slice → the Mac's audio output is set to the OP-Z → the OP-Z's I/O
track sees it as `usb` input (`shift`+3) with filter, LFO, fx sends, pan and volume → the
device's **own sampler** records it into a drum or synth slot. The OP-Z writes its own
file, in its own format, with its own `drum_version` and `playmode`, into its own YAFFS2
image.
**What it eliminates, entirely:** the `.aif` byte contract, the `drum_version: 1` vs `3`
and `playmode: 8192` vs `16384` disagreement, the `APPL op-1` chunk that makes files
*invisible* when malformed, the two reboots per attempt, the silent `rejected/` folder,
the 24 MB budget arithmetic — and every write to the device. The bench never touches the
disk. Nothing can be corrupted by a bad export because there is no export.
**Precondition, and it is satisfied:** *"the connected device needs to be a usb audio host
in order for OP–Z to recognize it"* — a Mac with the OP-Z plugged in is the host.
**Limits:** 12 s drum / 6 s synth per capture, device-side gain staging (input gain =
hold play + a top track button, button 4 = 0 dB), and the slot has to be chosen on the
device. It is a *sampling* path, so it is real-time and once-through — it does not
replace batch export of a 24-slice kit, it replaces the *one-sample-at-a-time* case,
which is most cases.
**Risk:** a feedback loop if the OP-Z's output is simultaneously routed back into the
Mac's input and monitored. Real, avoidable, worth a UI warning.
**Unproven:** whether the OP-Z's sampler accepts USB input as cleanly as mic input; the
`shift`+3 path is documented but untested here.

### C4 · The OP-Z as outboard colour for the browser · attached · read-only
The same cable, four streams. Bench audio out → OP-Z I/O track (filter, LFO, fx sends,
pan, level, plus tape and master chorus/drive) → OP-Z master bus → back into the bench at
exactly 44 100 Hz with no resample and no analogue stage. A Blackfin DSP and a
115 dB-dynamic-range signal path become a processing insert for Web Audio.
**Unlocks:** hardware character on browser-generated material, in a loop, at the patch
format's native rate.
**Limits:** punch-in effects apply to **audio tracks 1–8 only**, so the USB input cannot
be punched; the master page offers only chorus, drive, filter, resonance. Latency of the
full round trip is **UNK** and would need measuring before anyone calls it an insert.

### C5 · Detached field capture, later harvested by the bench · detached then attached · read-only
The OP-Z goes out on battery with its MEMS mic, samples up to 12 s per drum slot and 6 s
per synth slot, sequences what it caught, and bounces up to five 10-second stereo takes.
Later, in content mode, the bench reads:
- `bounces/bounceNN/bounce.wav` — plain RIFF WAVE, stereo, 44 100 Hz, 16-bit. **Yellowjacket
  parses this today with zero new code.**
- `samplepacks/<track>/<slot>/patch.aif` — the device's own recordings, in the format
  `parseDrumPatch` already reads.
- `bounces/bounceNN/project.opz` — the project state that produced the take (readable;
  writing `.opz` is permanently out of scope).
**Unlocks:** a capture device whose output the bench can already open, and a workflow where
the "field" half needs no computer at all.
**Limits:** five bounces of ten seconds; harvest requires a content-mode boot cycle; the
device's sample budget is 24 MB total, so a long trip fills it.
**Risk:** the harvest visit ends in an import pass on eject. Reading is safe; the eject is
the device rewriting its own state.

### C6 · Wireless control surface for the bench · detached, BLE · ARCH
Pair once in Audio MIDI Setup, and the OP-Z becomes an ordinary CoreMIDI endpoint that
Chrome should enumerate like any other. The laptop stays on the desk; the instrument does
not.
**Unlocks:** performance ergonomics — and it frees the USB-C port, which is the whole
point of C7.
**Unproven:** that Chrome sees it, and that it carries the name `OP-Z` that Yellowjacket's
port matcher keys on. Both settled by one pairing and one look at the WIRE panel.
**Limit:** notes and CC only. Not clock — 10–30 ms of jitter.

### C7 · Battery-powered DMX brain on a wireless umbilical · detached, BLE + USB host · ARCH
The non-obvious one, and it exists only because §8's exclusion has exactly one escape.
The OP-Z hosts the Enttec widget on USB-C, runs the lighting rig from track 15 and the
same four encoders that drive the music, on battery — **and simultaneously exchanges MIDI
with the laptop over Bluetooth**, because the radio does not need the port. A laptop-side
bench can then follow, log, or extend the same performance that is driving the lights,
with no cable anywhere in the chain.
**Unproven:** the whole combination. Neither TE nor any community project documents BLE
MIDI and USB host mode running together. It is architecturally sound — separate
subsystems — and it is one evening's test.
**Limits:** 100 mA of DMX widget plus a BLE link, out of 740 mAh. TE already warns the
direct-DMX case shortens the battery. Budget accordingly, or use a powered hub and lose
the "no cables" claim.

### C8 · Browser drives song form on the hardware · attached · read-only
`enable_program_change: true` on his unit (**MEAS**). Incoming program change selects
patterns across all **160** (10 projects × 16 patterns) and, since 1.2.14, switches
**immediately** rather than waiting for the next step; CC 103 addresses project and
pattern in one message.
**Unlocks:** the bench arranges the set — the OP-Z is the sound module, the browser is the
arranger.
**Limits:** bank-select CC numbers for the non-alt mode are **UNK**; the `alt_program_change`
sense inverts the addressing scheme.

### C9 · The OP-Z as Yellowjacket's 44.1 kHz reference path · attached · read-only
A class-compliant device that runs at *exactly* the rate the patch format demands, in
both directions, gives the bench a physical loopback for validating its own converters —
send a known signal out, record it back, compare. It also settles, in one test, whether
the USB return is a digital tap or a re-digitised analogue path.
**Unlocks:** ground truth for the resampler, using hardware Ian already owns.

### C10 · OP-Z as the room's MIDI hub · attached to a rig, needs the oplab · DOC, hardware-gated
`midi_echo` makes the OP-Z a soft-thru box: echo on the same port **and** through to other
ports, with incoming transport relayed to other ports (1.1.23). With the ZM-1 oplab fitted
the OP-Z has TRS MIDI in and out *in addition to* USB, and TE states the module "transmits
all midi channels from OP-Z" — the DIN side is not a subset of the USB stream.
**Unlocks:** one box merging a laptop, a DIN rig, and its own sequencer on one clock.
**Gate:** requires the discontinued ZM-1. Whether Ian owns one is unknown.
**Risk:** `midi_echo` plus anything the bench echoes back is a feedback loop.

---

# 10. Dead ends — recorded so they are not re-derived

- **Per-track audio stems over USB.** Two channels. Not a limitation to work around, a
  fact to design around: capture MIDI on 15 channels and re-render.
- **The OP-Z as a general-purpose USB drive.** ~10 MB free, two reboots per visit, an
  import pass that rewrites what you wrote, undocumented handling of foreign files, and a
  documented crash-and-factory-reset failure mode for undocumented content. Use a stick.
- **BLE as a clock transport.** 10–30 ms of jitter against a 25 ms tick period.
- **Simultaneous USB host and USB device.** One connector. The BLE path (C7) is the only
  way around it and it does not use the connector at all.
- **Sysex as a control channel.** Already excluded by contract and the reasons hold: the
  `$09` pattern message is still undecoded after seven years, `libopz` is
  Prosperity-licensed (non-commercial) with no write path, and Chrome gates sysex behind a
  stronger permission. Bonus: without the sysex flag, Chrome filters out the app's
  telemetry firehose for free.
- **Writing `.opz` project files.** Permanently out of scope — 342 848 bytes of
  little-endian memory image, a published byte table that does not sum to the file size,
  ~48 undecoded bytes, no checksum, and a device that will accept a malformed one and
  crash.
- **Ableton Link.** TE's MIDI chapter and guide never mention it and the firmware is
  frozen at 1.2.45; the only community traffic is a feature request. Treat as absent
  (**INF** — absence of documentation, not a tested negative).
- **Driving external gear from the OP-Z as the primary direction.** Repeated **FORUM**
  reports of dropped notes with several channels active, no controlled measurement, no TE
  acknowledgement, no fix. Browser-as-master is the better-supported direction.
- **The internal speaker as a monitoring path.** TE describes it only as playing a startup
  sound. Assume headphones.

---

# 11. Cheap checks that would settle the unknowns

All read-only unless marked. Each is minutes, not hours.

| # | Question | How | Cost |
|---|---|---|---|
| 1 | Does Chrome enumerate the OP-Z as an audio **input**, and at 44 100 Hz or 48 000? | Attach, open the bench, list `getUserMedia` devices and read the actual sample rate | 2 min |
| 2 | Does the OP-Z accept the Mac's audio as a sample source? | Set Mac output = OP-Z, `shift`+3 on the I/O track, `shift`+0 to monitor | 5 min |
| 3 | Is the USB return a digital tap or a re-digitised analogue path? | Loopback a known file, record it back, compare | 10 min |
| 4 | Does the raw-input monitor (`shift`+0) reach the USB output? | Enable it, record the OP-Z input on the Mac, speak into the mic | 3 min |
| 5 | Does BLE pairing work, and what is the CoreMIDI port called? | Audio MIDI Setup → MIDI Studio → Configure Bluetooth → pair button on the back; then look at the WIRE panel | 5 min |
| 6 | Does BLE MIDI coexist with USB host mode? (**C7, the valuable one**) | Pair over BLE, plug a USB MIDI device or DMX widget into the USB-C port, watch both | 15 min |
| 7 | Does the internal speaker play music or only the startup sound? | Power on with nothing in the jack, press a key | 10 sec |
| 8 | Does the OP-Z emit clock while stopped? | Attach, stop the sequencer, watch for `0xF8` | 2 min |
| 9 | Does the motion sensor transmit anything over MIDI? | Attach, enable outgoing MIDI, tilt the unit, watch the monitor | 2 min |
| 10 | What is the round-trip latency Mac → OP-Z → Mac? | Impulse out, record in, measure the offset | 10 min |
| 11 | Is `outgoing_midi` on? | Read `config/midi.json` in content mode — or just play a key and watch | 2 min |

---

# 12. Where writes would be required — flagged, not done

Nothing in this survey required or performed a write. For the record, these are the
capabilities that would:

1. **[WRITE] Exporting a patch to the device.** Content mode, drop the `.aif`, eject,
   import, reboot. C3 exists specifically to avoid this.
2. **[WRITE] Editing `config/midi.json`, `general.json`, or `dmx.json`.** The only way to
   reach the ten `general.json` booleans that have no front-panel control, and the only
   way to author DMX fixture profiles.
3. **[WRITE, front panel] Toggling MIDI settings** (TEMPO+SCREEN + a key). Normal user
   action, fully reversible, persisted to `config/midi.json`. Roles B and C may need
   `outgoing_midi` or `timing_clock_in` on; on Ian's unit clock-in and clock-out are
   already `true`, and `outgoing_midi` is unknown.
4. **[WRITE] Firmware.** `.zfw` in the root, applied from upgrade mode. No reason to
   touch it — 1.2.45 is the last release that will ever exist.
5. **Note also:** any content-mode visit that ends in an eject triggers an import pass and
   a restart. Reading is safe; the exit is not free.

---

# Sources

**Primary — teenage engineering**
- <https://teenage.engineering/products/op-z> — spec sheet: Blackfin 70X DSP, Cirrus Logic
  audio co-processor, 48 kHz 24-bit DAC, 115 dB dynamic range, 6 h battery / 1 y standby /
  user-replaceable Li-Ion 740 mAh, usb type c (host and device), Bluetooth LE, 3.5 mm
  4-pole jack, 6-axis motion sensor, integrated MEMS microphone.
- <https://teenage.engineering/guides/op-z/input-selection> — input sources and the
  "must be a usb audio host" requirement.
- <https://teenage.engineering/guides/op-z/hardware-overview> — ports, speaker (startup
  sound), microphone location, battery, usb-c ("charging, file transfers and midi").
- <https://teenage.engineering/guides/op-z/disk-modes> — content and upgrade mode entry,
  accepted formats, `rejected/`, eject semantics.
- <https://teenage.engineering/guides/op-z/lights> — DMX, 128-channel ceiling, `dmx.json`,
  the battery warning.
- <https://teenage.engineering/guides/op-z/app> — bluetooth pairing, USB alternatives,
  what the app does over the link.
- TE `/guides/op-z/usb`, `/tempo`, `/tracks`, `/midi`, `/sampling` — as already cited in
  [`guide.md`](guide.md) and [`midi.md`](midi.md).

**Primary — regulator**
- <https://fccid.io/Z23012A> — OP-Z equipment authorization, granted 2018-11-08. Digital
  Transmission System, 2402.0–2480.0 MHz. Exhibits: internal photos, external photos, two
  test reports, RF exposure info, test setup photos, users manual.

**Vendor**
- <https://www.nordicsemi.com/News/2018/11/Teenage-Engineering-employs-nRF52832-SoC-to-link-device-and-iOS-partner-app>
  — nRF52832, "MIDI over Bluetooth LE wireless connectivity", ~1 year standby, 6-axis
  motion sensor, 12-bit hall-effect knob sensing.

**Named open-source / demonstrated**
- <https://github.com/xmacex/connect-opz> — GPL-3.0. OP-Z as the USB audio interface for a
  monome norns via `alsa_in`/`alsa_out` into Jack. Proof of role A against a non-TE host.
- <https://github.com/artaction/OP-Z_Controls_Ableton> — Ableton template + instrument
  racks; OP-Z CCs mapped to Live parameters across 8 instrument tracks.
- <https://github.com/artaction/Ableton2OP-Z> — the reverse direction; already load-bearing
  in [`README.md`](README.md) §2.8 for the drum note range.
- `nbw/opz` (MIT), `lrk/z-po-project` (Apache-2.0), `hyphz/opzdoc`,
  `patriciogonzalezvivo/libopz` (Prosperity, non-commercial),
  `AlexCharlton/op-patch-util` — inventoried with licences in [`community.md`](community.md).

**Forum — named and dated**
- <https://op-forums.com/t/op-z-bluetooth-2026/31340> — Jan 2026. Kosta, Hopeeasy, Victory:
  BLE MIDI pairs to macOS through Audio MIDI Setup → MIDI Studio → Configure Bluetooth,
  not through the system Bluetooth pane.

**Platform**
- <https://support.apple.com/guide/audio-midi-setup/set-up-bluetooth-midi-devices-ams33f013765/mac>
  — Apple's BLE MIDI pairing procedure; once connected the device is available to every app.
- Chromium "Intent to Implement: Web MIDI API" — Web MIDI is a thin layer over CoreMIDI.
- <https://docs.dt.in.th/webmidicon/connect/BLE-MIDI.html> — BLE MIDI adds ~10–30 ms of
  jitter over USB MIDI.
- <https://cdn.enttec.com/pdf/assets/70304/70304_DMX_USB_PRO_API.pdf> — DMX USB Pro widget
  API v1.44 over an FTDI virtual COM port. Relevant only if a browser-side DMX path via
  Web Serial is ever wanted; no named browser implementation was found (**ARCH**).

**Local, carried forward**
- [`device-scan.md`](device-scan.md) — the read-only scan of Ian's own device.
- [`README.md`](README.md), [`midi.md`](midi.md), [`formats.md`](formats.md),
  [`gaps.md`](gaps.md), [`guide.md`](guide.md), [`community.md`](community.md).
