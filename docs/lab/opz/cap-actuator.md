# Capability survey — the OP-Z as a general-purpose actuator and control bus

Lens: everything that leaves the OP-Z as **control** rather than audio. DMX first,
because TE shipped a real DMX controller in it; then CV/gate/trig, MIDI-as-transport,
and the visual path.

**Status of this document.** Survey only. Ian's OP-Z was read in content mode
(`/Volumes/OP-Z`, read-only, no eject-triggered import). **Nothing was written and
nothing here has been executed on the device.** Where a capability needs the device
modified, it says so in its own line, because the shipped `config/dmx.json` is a
16 × RGB default and almost every interesting DMX idea below requires replacing it.

Claim tags, used strictly:
- **[DOC]** — TE says so, in the guide, in an on-device file, or in the published changelog.
- **[RE]** — someone demonstrated it and is named.
- **[ARCH]** — follows from documented hardware/protocol facts; unproven in this combination.
- **[SPEC]** — speculation, called out as such.
- **[MEAS]** — measured on Ian's device this session.

---

## 0. The headline, stated once

TE describes the lights track as a way to make your light rig blink in time. What is
actually in the box is a **16-step, 8-bit, 8-lane parameter automation engine wired to
an industry-standard control bus**, running on battery, with no computer, and with an
open JSON file deciding what each lane means. The lights are TE's example, not the
mechanism's limit. Nothing about `knob5` says "colour" — TE gave it no name at all.

Two hard ceilings bound everything: **128 DMX channels** and **16 fixtures**. [DOC]

---

## 1. The DMX envelope, from the horse's mouth

### 1.1 What is on the device right now [MEAS]

`/Volumes/OP-Z/how_to_dmx.txt`, 6 671 bytes, dated 2022-04-15 — TE's own on-disk
reference, and it is more complete than the website chapter in one respect: it explains
the two-block structure of the config file.

> "OP-Z can transform sequencer data to DMX channel data and send it out using a USB
> DMX interface."

> "the second block ("config") of the config file is where you assign a profile to each
> of the 16 fixtures. OP-Z supports up to 16 fixtures. each of them corresponds to a LED
> on the DMX preview on your OP-Z."

`/Volumes/OP-Z/config/dmx.json`, 910 bytes, ships as:

```json
"profiles": [
  { "name": "rgb",                "channels": ["red","green","blue"] },
  { "name": "dimmer",             "channels": ["intensity"] },
  { "name": "movinghead_example", "channels": ["knob5","knob6","knob7","knob8",
                                               "red","green","blue","white","strobe"] }
],
"config": [ { "fixture": 1, "profile": "rgb" }, … × 16 ]
```

**Finding — `strobe` is an undocumented channel type.** [MEAS] TE ships `"strobe"` in its
own default `movinghead_example` profile, but `strobe` does **not** appear in the channel
table in `how_to_dmx.txt` or in the website's chapter 15.5. Either it is an undocumented
17th type, or the shipped example references a type the firmware silently ignores. Both
readings are consistent with the evidence; TE's docs do not resolve it. The example
profile is also not referenced by any of the 16 fixture entries, so nothing on Ian's
device currently exercises it.

### 1.2 The channel-type vocabulary — the whole of it [DOC, verbatim from the device]

| channel | range | description |
|---|---|---|
| `red` `green` `blue` `white` | 0–255 | colour components |
| `color` | 0–255 | colour wheel |
| `intensity` | 0–255 | intensity / dimmer |
| `fog` | **0, 255** | **"triggered by animation 14"** |
| `knob1`–`knob4` | 0–255 | green / blue / yellow / red dial, **page 1** |
| `knob5`–`knob8` | 0–255 | green / blue / yellow / red dial, **page 2** |
| `0`–`255` (literal) | 0–255 | custom fixed value |
| `on` | 255 | always on |
| `off` | 0 | always off |
| `strobe` | ? | **not in the table; present in TE's shipped example** [MEAS] |

Six types are semantic (the firmware decides the value from the pattern/animation engine).
**Eight are not.** `knob1`–`knob8` are raw pass-throughs of the lights track's eight dials.
And on the lights track, TE's own parameter-page chart names only four of them:

> lights — WHITE page: colour, alt colour, pattern speed, intensity · **AMBER page: 5, 6, 7, 8** [DOC, `parameter-pages` 4.3]

`knob5`–`knob8` have **no assigned meaning on the device at all**. They exist solely to be
routed to DMX. That is TE handing you four unnamed 8-bit control lanes and walking away.

### 1.3 Addressing — implicit, contiguous, and the reason most rigs need a rewrite

There is **no address field anywhere in `dmx.json`.** [MEAS] Fixtures are packed in index
order, each consuming exactly as many channels as its profile declares:

```
fixture 1 → DMX 1 … n₁
fixture 2 → DMX n₁+1 … n₁+n₂       (etc.)
```

Corroborated on op-forums by **jflee**, who told another user that adding a second
RGB-dimmer as fixture 2 means "it receives starting on DMX channel 5". [RE]

Consequences, all of them practical:

- The shipped default (16 × `rgb`) occupies **DMX 1–48**, fixture *n* starting at 3(n−1)+1.
  Out of the box, without touching a single file, the OP-Z drives sixteen 3-channel RGB
  fixtures addressed 1, 4, 7 … 46. [MEAS + ARCH]
- **The highest reachable DMX address is 128.** A fixture patched at 200 is unreachable,
  full stop. [DOC]
- You cannot leave gaps — *unless* you spend them. **The `off` channel type is an address
  pad.** A profile of *k* `off` channels occupies *k* addresses and outputs zero, letting a
  fixture start wherever you need. It costs one of your 16 fixture slots and *k* of your
  128 channels. [ARCH — follows directly from the documented type list; not stated by TE.]
- No RDM, no auto-patch, no address discovery, even though the Enttec Pro is RDM-capable.
  [ARCH]

### 1.4 Universes and update rate

**One universe.** The 128-channel cap is the OP-Z's, not DMX's (a universe is 512). The
Pro Mk2's second universe is almost certainly unreachable — TE's config file has a single
flat channel space with no universe field. [ARCH; TE never says, and I found no test.]

Update rate — TE publishes **nothing**. What can be derived:

| stage | figure | tag |
|---|---|---|
| DMX512 slot time | 11 bits @ 250 kbit/s = **44 µs** | [DOC, USITT DMX512-A] |
| full 513-slot frame + break + MAB | ≈ **22.7 ms → ~44 Hz** ceiling | [ARCH, arithmetic] |
| Enttec Pro configured rate | **1–40 fps, or 0 = "fastest possible"** | [DOC, ENTTEC support] |
| Enttec Pro channel behaviour | *"All 512 DMX channels are output regardless of input size"* — so shrinking to 128 buys **no** speed | [DOC, ENTTEC] |
| OP-Z → widget send rate | **UNKNOWN** | — |
| OP-Z sequencer tick | **24 ticks/step**; at 120 BPM, 1/16 step = 125 ms → **5.2 ms/tick** | [DOC + arith] |

**The useful conclusion: the DMX frame (~25 ms) is roughly five times coarser than the
OP-Z's own micro-timing resolution (~5.2 ms).** Micro-timed light events quantise to the
DMX frame. For lights nobody will see it. For a servo or a valve, ±25 ms of jitter is the
number to design against. [ARCH]

### 1.5 The hardware, and the one adapter finding that matters

TE's tested list, verbatim from chapter 22 (usb): [DOC]

- **ENTTEC DMXusb Pro — direct, no external power.**
- ENTTEC DMXusb Pro Mk2 — needs external power.
- Powered hub: Kingston Nucleum.
- The OP-Z as USB host supplies **max 100 mA**, and *"some devices present themselves as
  more than one midi device, which currently is not supported."*

**The adapter constraint is protocol-level, not price-level.** On op-forums, **guyken1**
reported the cheaper *Enttec Open DMX USB widget* failing and having to buy the *DMXusb
Pro* for it to work. [RE] That is diagnostic: Open DMX is raw FTDI bit-banging with no
protocol on top; the Pro speaks Enttec's framed widget API. So **OP-Z firmware contains an
FTDI USB-serial host driver and an Enttec-Pro-protocol writer.** [ARCH, strongly implied]

Open question worth 10 minutes if Ian ever owns another dongle: DMXKing's `ultraDMX Micro`
advertises full Enttec-Pro-API compatibility and is FTDI-based, so it *should* work — but
if TE gates on FTDI VID/PID, only Enttec's exact IDs pass. **Untested with OP-Z; I found no
report either way.** [SPEC]

### 1.6 Detached operation — yes, unambiguously

OP-Z (internal battery) + Enttec DMX USB Pro (bus-powered, direct) + DMX cable = a
**standalone lighting brain with no computer, no phone, no mains.** TE documents the direct
connection and only warns *"connecting the dmx interface directly to you OP-Z is convenient
but might deplete you battery faster than you want."* [DOC]

The on-device **DMX preview** ("each fixture corresponds to a LED on the DMX preview on your
OP-Z", and chapter 15.2 "toggle between fixture preview and step view") means you can
compose and audition a 16-fixture show on the device's own LEDs **with no DMX hardware
attached at all**. [DOC] That is the zero-cost, zero-risk rehearsal surface, and it is the
basis of the verification plan in §6.

---

## 2. What the sequencer can actually do to those channels

This is where the lens pays off, and it needs the `.opz` format, not the marketing.

### 2.1 Per-step parameter locks are 8-bit and they exist on the lights track

From the Z-PO Project's byte-level map of `.opz` (already carried in `README.md` §3.5,
independently reimplemented by `libopz`): each pattern holds `Steps[256]` at **54 bytes
each** — `u16` component bitmask, 16 B component params, **18 B lock values, 18 B lock
mask** — plus a 288-byte block of parameter values laid out **18 × 16**. [RE]

Read that carefully. 256 steps = **16 tracks × 16 steps**. 18 × 16 = **18 parameters ×
16 tracks**. The lights track is track 15 and is allocated exactly like every other track.
Two things fall out:

1. **Parameter values are one byte.** 0–255. That is a *native, lossless* match to a DMX
   channel — no scaling, no rounding. [RE + ARCH]
2. **Every step carries up to 18 one-byte parameter locks with an explicit mask.** So each
   of the 16 steps on the lights track can hold its own 8-bit value for each of
   `knob1`–`knob8`. [RE + ARCH]

The device gesture is documented and unrestricted by track type: **"add parameter lock —
hold any step and turn any dial"**, and live **"parameter lock: hold rec and turn a dial
while running."** [DOC, `general-operation` 3.4/3.6]

**So: 16 steps × 8 independent 8-bit lanes = a 128-byte automation frame per pattern, per
loop, addressable to arbitrary DMX channels via `dmx.json`.** With 16 patterns per project
and chains of up to 32 patterns, that is a real cue stack.

Also confirmed by the same byte map: the lights track owns **note slots 47–50** (four
simultaneous events per step) and the video track owns 51–54. [RE] Both are sequenced
tracks with per-step data in the project file, not app-side afterthoughts.

### 2.2 Track-time independence — polymetric actuation, free

Per-track and documented: **step count** (any of 1–16, independently per track), **step
length multiplier** (multiplier 4 → four bars; **multiplier 9 → 16× longer**; **multiplier
0 → trig-driven**), quantize, note length, note style. [DOC, `track` 5.2–5.3]

The lights track can therefore run a 7-step cycle at 16× the length of the drums. For a
lighting rig that is a nice odd-meter shimmer. For an actuator it is a **slow-loop
scheduler running alongside a fast one** — e.g. a fog burst every 4 bars against a strobe
lane on every 16th.

### 2.3 The one real sequencing limitation, and the documented way round it

**Step components are audio tracks 1–8 only.** [DOC, `step-components` §6] No `pulse`, no
`random`, no `multiply`, and — critically — **none of the three `spark` trig-conditions**
on the lights track. You cannot say "fire this light cue on 1 of every 8 passes."

The workaround is documented in a different chapter: **link tracks** — "hold track + the
active track, then press more track buttons… playing the original triggers the linked."
[DOC, `track` 5.10] Link LIGHTS to KICK and the kick's `trigger spark`, `pulse` and
`random` components become the light track's trigger source. **Untested in this
combination.** [ARCH]

### 2.4 Fog: a documented, sequenced, physical actuator

`fog` is the only binary channel type, and TE binds it to a named sequencer event:
**"triggered by animation 14"**, where animations are the white piano keys on track 15.
[DOC] So a fog or haze machine's trigger channel is placed, copied, micro-timed and
pattern-chained exactly like a snare hit.

Unknowns TE does not address: whether `fog` follows the step's note length or emits a fixed
pulse, and what happens on pattern change mid-fog. [UNKNOWN — matters, because a fog channel
stuck at 255 keeps pumping.]

### 2.5 External control of the DMX lanes over MIDI — the biggest single finding

TE's incoming-MIDI table, fetched verbatim today from chapter 21.6: [DOC]

| parameter | absolute CC | track/channel | range |
|---|---|---|---|
| parameter 1 … parameter 18 | **1 … 18** | **1–16** | 0–127 |
| (relative equivalents) | 32 … 49 | 1–16 | 1, 127 |

and separately, `config/midi.json` on Ian's device: `track_channels` =
`[0,1,…,14,0]`, i.e. **track 15 (LIGHTS) listens on MIDI channel 15**. [MEAS]

TE states the range as tracks/channels **1–16 with no exclusion for control tracks.**
Composing the two documented tables:

> **CC 1–4 on MIDI channel 15 write the lights track's page-1 dials; CC 5–8 on channel 15
> write `knob5`–`knob8` — four dials with no on-device meaning whose only function is to
> land on whatever DMX channels `dmx.json` says.**

If that holds, **any MIDI source — including Yellowjacket in a browser tab over Web MIDI,
no sysex required — can write arbitrary values to arbitrary DMX channels, using the OP-Z as
a MIDI-to-DMX bridge.** [ARCH — both halves documented, the composition untested.]

The cost of going in this way is resolution: **MIDI CC is 7-bit (128 values), the parameter
byte and the DMX channel are 8-bit (256).** Whether the firmware scales ×2 or left-shifts is
unknown; either way external CC control is half the resolution of an on-device parameter
lock. [ARCH] On-device automation is the high-resolution path; MIDI is the flexible one.

Three more incoming CCs from the same table that our README did not carry, all on channels
1–16, all therefore applicable to track 15: **CC 60 track step count (1–16), CC 61 track
step length (1–16), CC 62 quantize, CC 63 note length.** [DOC] A computer can reshape the
lights track's time base live — including setting step length to trig-driven.

---

## 3. The other things that leave the device as control

### 3.1 ZM-1 oplab module — analogue actuation, and the best trigger in the box

TE's module guide, verbatim: [DOC]

- **CV out jack (TRS):** tip = **note CV, 0 to +5 V**, from notes on track 14. Ring =
  **CV 2, −5 to +5 V**, *"controlled by the **green dial** on OP–Z when on the module track."*
- **Gate out jack (TRS):** tip = **gate, 0 or +5 V**, high while a note is held. Ring =
  **CV 3, −5 to +5 V**, *"same as cv 2, but using the **blue dial**."*
- **TRIG out, 0/+5 V:** *"emits a short pulse suitable for triggering drum synths,
  arpeggiators, gate inputs, etc."* And the documented recipe: **"to make any a step output
  a trig pulse: select any audio track, hold shift, select step(s) 1-16, press jump, press
  value key 0."**
- **TRIG in, 0–10 V:** single-steps any track whose length multiplier is 0.
- **MIDI in/out** on 3.5 mm TRS Type A, **5-pin DIN adapter included**; MIDI out carries
  *"midi data from all tracks."*
- **PO out** — pocket-operator sync, 0/+5 V.
- *"all outputs are short-circuit tolerant."*
- Pro-tip TE prints itself: *"change the midi channel of any track on the OP–Z to 14 to send
  that channel's sequence out of oplab's cv output."* — so **any** track can be routed to CV.

Two of those are general-purpose actuator outputs in the plain sense:

- **CV 2 and CV 3 are two bipolar ±5 V DC outputs driven directly by two knobs**, therefore
  parameter-lockable per step at 8-bit resolution by §2.1. That is a programmable analogue
  voltage source: motor-driver setpoints, 0–5 V analogue inputs on lab and industrial gear,
  VCAs, LED drivers. [DOC for the electrical spec; ARCH for the p-lock composition.]
- **TRIG out is a per-step arbitrary digital pulse on any audio track**, set by a documented
  gesture, with the full step-component vocabulary (pulse, random, sparks) available because
  it lives on tracks 1–8. Solenoid, relay coil driver, camera trigger, counter input. [DOC]

Firmware behaviours from TE's own changelog that matter here: **"don't trigger gate step
component if track is muted"** and **"don't play trigger driven tracks when muted"**, plus
**"change trig driven tracks to play upon entering step instead of exiting"** (1.2.14,
2019-11-15). [DOC] So track mute suppresses trig output. Useful. **Not a safety interlock —
see §7.**

**Availability is the problem, not capability.** The ZM-1 is out of production: Sweetwater
lists it as *"no longer available… may be permanently out of stock or may be in the process
of being discontinued."* TE's own site still lists it as an OP-Z accessory. Secondary market
only, realistically. [DOC/press]

### 3.2 Track 14 with no module — 16 free MIDI CC lanes

*"With no module inserted it acts as a MIDI track with 16 independent MIDI CC values."*
[DOC, `tracks` 11.10] Combined with `midi.json`'s `parameter_cc_out` — a **16 × 16 matrix,
editable as plain JSON on the content disk**, one row per track, one CC number per dial
[MEAS] — the OP-Z is a sixteen-lane, sequenced, parameter-locked CC generator whose CC
numbers you choose. Point it at any MIDI-to-anything bridge (MIDI-to-DMX, MIDI-to-relay,
MIDI-to-CV, a Web MIDI page) and it is a general control surface. Changing the CC numbers
is a **config write** to `midi.json`; using the defaults is not.

### 3.3 MIDI out as a transport, USB and Bluetooth

USB-C MIDI out, and **Bluetooth LE** — the OP-Z's only radio, FCC ID **Z23012A**, Teenage
Engineering AB, granted **2018-11-08**, 2402–2480 MHz, conducted power **0.0018 W**
(≈ 2.6 dBm). [DOC, FCC] BLE MIDI is how the app pairs. Clock out at 24 ppqn, standard
transport bytes; `timing_clock_out` and per-track `track_enable` are JSON-editable. [MEAS]

The FCC exhibit set for Z23012A includes internal photos, external photos, two test reports,
block diagram and schematics — the usual teardown-grade material, if hardware detail is ever
needed. Not required for anything in this survey.

### 3.4 The visual path — videolab is a MIDI I/O engine wearing a video costume

Chain: OP-Z → **BLE MIDI** (or USB-C wired) → OP-Z app (iOS / macOS / Android) → Unity.
Track 16 sequences it: *"black keys make cuts between cameras. white keys apply various
effects while held. you can sequence these changes just like you sequences musical notes,"*
and *"the color dials on track 16 can also be used to tweak various properties."* [DOC]
Output can leave the phone as **HDMI** via a Lightning-to-HDMI adapter; *"photomatic and
motion will automatically render to the external display."* [DOC]

`teenageengineering/videolab` — **MIT licensed**, 781 stars, last push **2023-10-30**. The
wiki (read directly from the wiki repo today) shows what it really is: a **Klak node graph
with MIDI input *and output* nodes.** [DOC]

> "To control MIDI devices from videolab use the **Knob Out, Note Out and Sequencer Out**
> nodes." — `MIDI-output.md`

Plus `Knob Input` / `Note Input` / `Sequencer Input` (clock at 24 ppqn) / `Videolab Input`
(OP-Z-exclusive events), Unity Animator-driven automation curves, and on macOS the IAC
driver for inter-app MIDI. So on a Mac, videolab is a **fully documented, MIT-licensed,
bidirectional MIDI transform engine** — OP-Z in, arbitrary curves and logic, MIDI out.

Two constraints, both documented, both real:

- *"Content exported for OP-Z can rely **only on scripts included in videolab**."* [DOC] A
  videopak is an AssetBundle; you cannot ship new C# into TE's app. You get videolab's node
  set, which does include the MIDI-out nodes — but whether the iOS app routes a videopak's
  MIDI out to CoreMIDI is **unverified**. [SPEC]
- **Unity 2018.4.29.** [DOC] For an app-targeted videopak that version is not negotiable.
  For Mac-side use outside the app, any Unity works.

---

## 4. Ranked: furthest beyond TE's stated intent while remaining fully supported

Ranked by distance-from-intent × still-inside-the-supported-envelope. "Modification"
below means **writing to Ian's device** — a config file at minimum.

**1 — `knob5`–`knob8` as four unnamed 8-bit control lanes on DMX.**
TE gave four dials no name, no on-device function, and a documented route to any DMX
channel, at 8-bit per-step resolution. Nothing about them is about light. Furthest from
stated intent, entirely inside the documented envelope. *Needs a `dmx.json` write.*

**2 — DMX as a physical-actuation bus: relay packs, dimmer packs, 0–10 V converters,
motors, valves, fog.** DMX512 addresses far more than fixtures, and the OP-Z neither knows
nor cares what is on the wire. A DMX relay pack behind the Enttec Pro turns any of the 128
channels into a contact closure; a DMX-to-0/10 V decoder turns one into an analogue
setpoint. `fog` is TE's own admission that the track already drives non-luminous hardware.
[ARCH — standard commodity DMX gear, no OP-Z change beyond the config.] *Needs a `dmx.json`
write for anything but 16 × RGB.*

**3 — The OP-Z as a standalone, battery-powered, computer-free control brain.**
TE frames this as convenience. It is architecturally the whole thing: a 16-pattern cue
stack with 32-pattern chains, snapshots, per-track polymeter and 8-bit automation, running
off a lithium cell into an industry-standard bus. *No modification at all* if the default
16 × RGB patch happens to suit — which for a first test rig, it does.

**4 — Yellowjacket → Web MIDI → CC 1–8 on channel 15 → DMX.** Turns the OP-Z into a
MIDI-to-DMX bridge driven from a browser tab, no sysex, no app, no drivers. Costs half the
resolution (7-bit in, 8-bit out). Cleanly beyond intent; both halves documented, the
composition untested. *No modification — this is the one to test first.*

**5 — oplab TRIG out as a per-step arbitrary pulse generator.** Documented gesture, on
audio tracks 1–8, so the full step-component vocabulary applies — probability, ratcheting,
1-in-8 conditions. A general-purpose programmable pulse source that happens to live in a
synthesiser. *No modification; needs the discontinued ZM-1.*

**6 — oplab CV 2 / CV 3 as two knob-driven, per-step-lockable ±5 V outputs.** The only
analogue path out of the device, and the two bipolar rails are exactly the general-purpose
ones. *No modification; needs the ZM-1.*

**7 — `off` channels as address padding.** A small trick that unlocks rigs the addressing
model otherwise forbids. Purely derived from the documented type list. *Needs a `dmx.json`
write.*

**8 — Link LIGHTS to an audio track to borrow its step components.** Recovers probability
and ratcheting for lighting/actuation cues that the lights track structurally cannot have.
*No modification; untested.*

**9 — videolab on macOS as an MIT-licensed MIDI transform layer.** OP-Z in, Unity animation
curves and node logic, MIDI back out — a scriptable modulation brain that TE built for
graphics. *No device modification; needs Unity.*

**10 — Track 14 as sixteen re-numberable CC lanes into any MIDI-to-X bridge.** Most generic
of all, and the least interesting precisely because the CC numbers are the only thing that
makes it special. *Needs a `midi.json` write to renumber; usable as-is otherwise.*

**11 — DMX → Art-Net node → MQTT / Hue / IP.** `lukasklinger/ArtNet_MQTT_Bridge` and
`sinedied/dmx-hue` are real, but they consume Art-Net over IP, not raw DMX — so the chain
needs a DMX-to-Art-Net node in the middle. Four boxes to blink a smart bulb. Possible,
ranked last on effort-to-payoff. [ARCH]

---

## 5. Dead ends — do not spend time here

- **No Art-Net, no sACN, no Ethernet, no wireless DMX.** The OP-Z speaks the Enttec widget
  protocol over USB and nothing else. Every IP lighting protocol needs an external node.
- **No second universe.** 128 channels, one flat space, no universe field in `dmx.json`.
  The Pro Mk2's second port is almost certainly unreachable.
- **Cheap FTDI dongles do not work.** Open DMX USB was reported failing by **guyken1**; the
  Pro's framed protocol is the requirement. Do not buy on price. [RE]
- **No step components on the lights track.** Tracks 1–8 only, stated flatly by TE. Link
  tracks or nothing.
- **Firmware is frozen.** The full published OP-Z changelog runs **1.1.12 (2018-11-13) to
  1.2.45 (2022-03-31)** and the string "dmx" appears **nowhere in it** [MEAS, fetched and
  grepped today]. The DMX subsystem shipped in 2018 and has never been revised. No bug in
  it is going to be fixed; design around it, not for a future firmware.
- **Videopaks cannot carry new code.** *"Content exported for OP-Z can rely only on scripts
  included in videolab."* Fork videolab or accept its node set.
- **Sysex is a separate world.** `libopz`'s protocol work has no write path, needs a
  constant heartbeat, and Chrome gates sysex behind a stronger Web MIDI permission. Already
  excluded by CONTRACT-WIRE; nothing in this lens changes that.
- **The OP-Z will not power a Pro Mk2.** 100 mA host budget. Mk2 needs a powered hub, which
  kills the battery-only story.

---

## 6. Verification plan that writes nothing to the device

Ordered by cost. Every step here is read-only or MIDI-only; **none writes a file, and none
requires a DMX interface until step 4.**

1. **Confirm the lights track has a second parameter page and that its four dials are
   nameless.** On-device, hold track 15, cycle pages. Pure observation. Settles §1.2.
2. **Watch the on-device DMX preview respond to the dials.** Chapter 15.2's fixture preview
   is on the OP-Z's own LEDs, no interface attached. Turn `knob1`–`knob4`, see the LEDs move.
3. **The big one — send CC on MIDI channel 15 from Yellowjacket and watch the preview.**
   CC 1–4 should move the named parameters; CC 5–8 should move the nameless ones. This
   settles the §2.5 claim, the whole MIDI-to-DMX bridge idea, and the 7-bit/8-bit scaling
   question, **with no DMX hardware and no writes**. If it works, capability #4 is real.
4. **Only then**, if a DMX interface ever appears: the shipped 16 × RGB default drives
   sixteen 3-channel fixtures at addresses 1, 4, 7 … 46 with no file changes at all.
5. **Parameter-lock resolution check** — p-lock `knob5` across 16 steps at adjacent values
   and look for 256 distinct levels vs 128. Confirms the 8-bit claim from §2.1.

Everything past step 5 — custom fixture profiles, `off` padding, renumbered CCs — requires
Ian's explicit go-ahead to modify `config/dmx.json` or `config/midi.json` on the device.
Content mode permits config **modify** but not add or remove [DOC], and import runs on
eject, so a bad JSON edit is discovered only after unplugging. Back up both files first.

---

## 7. Risk, stated plainly

- **Pyrotechnics: no.** DMX addresses pyro controllers, and the question invited the topic,
  so the honest answer is on the record: do not drive pyro from this. The OP-Z has no
  interlock, no arm/disarm, no watchdog, no confirmed frame rate, no error reporting, and a
  firmware last touched in March 2022. Track mute suppressing trig pulses is a *behaviour*,
  not a safety system. Fog and haze are fine; anything with stored energy, heat, or a moving
  mass that can trap needs a hardware interlock that the OP-Z cannot reach.
- **Electrical.** TE's own module warning is blunt: *"the voltage coming from oplab module's
  cv or gate could damage a line input or line output stage."* CV 2/3 are **bipolar** — −5 V
  into a 0–5 V-only input is a fault, not a low value. Outputs are short-circuit tolerant;
  inputs are not the same claim.
- **The 128-channel wall is silent.** TE documents the cap but not the failure mode. A
  profile set summing past 128 has undefined behaviour — likely truncation. Count channels
  before writing.
- **Undefined `fog` duration.** A binary channel with unspecified release semantics driving
  a machine that heats glycol is the one place in this survey where an unknown has a physical
  consequence. Establish the behaviour on a bench LED before it drives a hazer.
- **Every `dmx.json` capability needs a device write.** Nothing above has been written.
  The config-write step is the boundary between this survey and doing.

---

## 8. Sources

Primary, on-device (read-only, this session):
`/Volumes/OP-Z/how_to_dmx.txt` · `/Volumes/OP-Z/config/dmx.json` ·
`/Volumes/OP-Z/config/midi.json`

TE, fetched today:
- <https://teenage.engineering/guides/op-z/lights> — ch. 15, channel-type table, 128-channel cap
- <https://teenage.engineering/guides/op-z/usb> — 100 mA host budget, tested DMX interfaces
- <https://teenage.engineering/guides/op-z/midi> — ch. 21.6 incoming MIDI table (CC 1–18, 60–63)
- <https://teenage.engineering/guides/op-z/app> — ch. 23, photomatic / motion / HDMI out
- <https://teenage.engineering/guides/op-z/modules/oplab> — ZM-1 electrical spec, trig recipe
- <https://teenage.engineering/downloads/op-z> — full OS changelog 1.1.12 → 1.2.45; contains no "dmx"

Vendor / regulatory:
- <https://support.enttec.com/support/solutions/articles/101000395678-latency-on-usb-to-dmx-product> — 1–40 fps, all 512 channels always output
- <https://www.enttec.com/tips-and-tricks/how-to-control-dmx-lights-with-your-op-z-multimedia-synth-sequencer/> (live page now redirects to support; read via Wayback) — TE-collaborated OP-Z DMX guide; Tom Dixon / Coal Office install
- <https://fccid.io/Z23012A> — FCC grant, BLE 2402–2480 MHz, 2018-11-08, full exhibit list

Community, named:
- op-forums **jflee**, <https://op-forums.com/t/dmx-on-op-z-dmx-json-question/8099> — sequential DMX addressing
- op-forums **guyken1**, same thread — Open DMX USB fails, DMXusb Pro works
- Z-PO Project `.opz` byte map, via `README.md` §3.5 — 54-byte step record, 18 one-byte lock values
- `teenageengineering/videolab` (MIT) + its wiki — Klak MIDI in/out nodes, videopak script restriction, Unity 2018.4.29
