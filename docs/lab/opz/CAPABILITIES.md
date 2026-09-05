# OP-Z capability map

**For Dr. Ian Helfrich · 2026-09-04 · survey only — nothing was written to the device.**

Five research lenses produced 53 capability candidates; two adversarial judges scored each
out of 15. This document reorganises them by **how hard they are to reach**, not by which
lens found them, and merges the duplicates the judges caught. 53 candidates collapse to
**51 distinct capabilities** (the BLE peripheral was surveyed twice, the DMX brain twice).

Ordering within each tier is by judges' score. Scores are shown as `[n/15]`.

Evidence labels are carried from the lenses and not softened:
**DOC** = Teenage Engineering says so · **MEAS** = measured on Ian's own unit ·
**RE** = someone demonstrated it, named · **ARCH** = follows from hardware/protocol facts
but unproven · **SPEC** = speculative · **UNK** = nobody knows.

> **The device was not mounted while this was written.** Every MEAS claim comes from
> `device-scan.md` (2026-09-03, read-only) or the passive MIDI/audio captures recorded there.
> No capability in Tiers 1 or 2 requires modifying the device in any way.

---

## Tier 1 — Supported today, no modification (18)

Things the OP-Z already does that are simply under-used. No software to write, no files to
change. Where an entry is untested, it says so.

### 1.1 USB audio interface — 2 in / 2 out at exactly 44 100 Hz `[14.5]`
**What.** The Mac sees the OP-Z's master bus as two input channels at 44 100 Hz — no cable,
no ADC, no rate conversion — and can send two channels back, which TE documents as a
first-class input source on track 14 (`shift`+3, "usb") with filter, LFO, fx sends, pan and
volume "just like on any instrument track".
**What it takes.** Plug it in. Already done: `device-scan.md` records the OP-Z as a
recordable audio input on his machine, and an active sweep was captured through it.
**Attached.** **Confidence: MEAS + DOC + RE** — measured here; TE-documented on the input
side; `xmacex/connect-opz` (GPL-3.0) runs `alsa_in`/`alsa_out` against an OP-Z as the audio
interface for a monome norns, proving it against a non-TE host.
**Honest limits.** Two channels means master mix only — **never per-track stems**. Whether
Chrome honours 44 100 rather than resampling to 48 000 is an open gate (Unknown #1).
Whether the USB return is a digital tap or a re-digitised analogue path is UNK. Feedback is
possible if OP-Z output is routed back while its input is monitored.

### 1.2 The 24 MB sample budget is a policy, and a third of the slots are fictional `[13.5]`
**What.** All four drum tracks report 10/10 slots filled. They are not. 38 of 55 occupied
sample entries are **zero-byte placeholders** (`~TeKicks.aif`, `~CuckooKicks.aif`) standing
in for factory content held internally. They occupy a listing slot without occupying the
budget. ~10.8 MB of the 24 MB is free right now, and any placeholder slot can be displaced
without displacing a real file.
**What it takes.** Nothing — it changes the arithmetic on every kit import.
**Attached** (content mode). **Confidence: MEAS**, high (13.2/24.0 MB from the device's own
`import.log`; 17 real files vs 38 stubs counted).
**Honest limit.** The accompanying claim that the underlying NAND is far larger is
**ARCH and unusable** — the part numbers are unreadable at 200 ppi and exploiting it would
need firmware modification. Ignore that half; keep the placeholder arithmetic.

### 1.3 There is no path above 44.1 kHz — resample to exactly 44 100, always `[13.5]`
**What.** TE documents a 48 kHz 24-bit DAC at 115 dB dynamic range. Every surface a tool can
touch is 44.1: the USB audio device measured at exactly 44 100 Hz, bounces at 44.1/16 stereo
WAV, patches at 44.1/16 AIFF. There is no firmware-exposed high-rate mode to hunt, and no
ultrasonic capability here at all (24 kHz of bandwidth at best).
**What it takes.** One operational rule, applied on every export.
**Attached.** **Confidence: high** that no exposed path exceeds 44.1.
**Note.** The source entry flagged this `needsModification: true`; both judges called that a
contradiction of its own body, and they are right — there is nothing to modify. Whether the
internal mix bus is deeper than the file formats is genuinely unresolved (115 dB is not
reachable through a 16-bit output stage), but it is unreachable either way. One cheap
read-only check remains: dump the USB audio-class descriptors and see whether any alternate
rate is advertised.

### 1.4 Charging while running is supported and is audibly dirty `[13.5]`
**What.** A 3.7 V / 740 mAh / 2.74 Wh cell charged from a flat 5 V on the USB-C port — no
Power Delivery (the FCC report states plain 5 V; the bundled C-to-A cable cannot negotiate
PD at all). TE ships a setting to disable USB charging **"to reduce noise"**, which is TE
conceding the charge path couples into the analogue path.
**What it takes.** Know it, and flip the setting at the start of a long bench session.
**Attached.** **Confidence: high** — FCC test report §4.1 + TE hardware overview.
**Honest limit.** One forum account reports a unit with a dead cell will not power on from
USB alone. Do not plan around USB-only operation on that evidence, but do not dismiss it.

### 1.5 MIDI clock master or slave `[13.5]`
**What.** Standard 24 ppqn `0xF8` with `0xFA`/`0xFB`/`0xFC` transport, 40–200 BPM, with
clock-out gated **independently** of note-out — so it can be a pure clock source with every
track silent.
**What it takes.** Nothing; already characterised.
**Both** (USB reliably; **not** BLE — see 1.7). **Confidence: DOC + MEAS.** A 90 s passive
capture (n=963) found a bimodal interval distribution with modes ~1.35 ms apart from USB
frame quantisation, where the **mean** recovers nominal BPM exactly and a **median** is 2.4%
wrong. That measurement is why Yellowjacket's `ClockIn` uses a windowed mean with a ±30%
rejection band.
**Honest limits.** On Ian's unit `timing_clock_in` and `timing_clock_out` are both already
`true` (MEAS), so the usual factory trap — incoming clock off by default — does not apply to
him but will to anyone else. Whether the OP-Z emits clock while its sequencer is **stopped**
is UNK; the measurement was taken with clock already flowing. Driving external gear *from*
the OP-Z has repeated unquantified forum reports of dropped notes with several channels
active — **keep the browser in the master seat.**

### 1.6 Standalone battery-powered sampler with built-in MEMS microphone `[13.5]`
**What.** Six hours on a 740 mAh user-replaceable cell; integrated MEMS mic; drum sampler
taking one file up to 12 s sliced into 24 sounds; synth sampler up to 6 s chromatic; plus
bounce (project+rec) rendering 10 s of stereo 44.1/16 WAV with a copy of the project, max 5.
The gyro is available as an LFO shape. It is the only capture device in the room that also
sequences what it captured.
**Detached** — the one role that is strictly better detached.
**Confidence: DOC + MEAS** — device-written synth patches measure exactly 264 600 frames;
`bounce.wav` confirmed stereo RIFF WAVE 44.1/16; largest drum patch on disk 498 304 frames.
**Honest limits.** 24 MB total means about **23 full-length kits, not the 80 the slot count
implies**. Five bounces of ten seconds, current pattern only. Whether music is audible
through the built-in speaker at usable level is UNK — TE describes it only as playing a
startup sound; assume headphones. Retrieval requires a content-mode boot cycle.

### 1.7 BLE MIDI peripheral `[13.5]` *(merged: surveyed twice)*
**What.** A certified 2.4 GHz radio speaking MIDI over Bluetooth LE. On macOS it pairs
through Audio MIDI Setup → Show MIDI Studio → Configure Bluetooth, after which it is an
ordinary CoreMIDI endpoint available to every app. The radio does not need the connector, so
the USB-C port stays free.
**What it takes.** Pair it. Pairing is a host-side action and writes nothing to the OP-Z.
**Detached.** **Confidence: FCC + VENDOR + DOC for existence; RE/forum for Mac pairing.**
FCC grant Z23012A (2018-11-08); Nordic nRF52832; TE changelog 1.2.45 "reduced ble midi
jitter"; op-forums 31340, January 2026 — **Hopeeasy "it works like a charm"**, **Kosta
"Everything works as expected"**, both on current macOS after being given the Audio MIDI
Setup route.
**Merge note.** The silicon lens surveyed this separately `[12]` and claimed the standard
GATT service was unproven and "nobody has noticed". **That novelty claim is false** — TE's
own copy says the OP-Z connects to "BLE MIDI capable devices such as laptops", and the
forum thread above settles it. Both judges flagged the contradiction.
**Disqualifying limit.** BLE MIDI adds roughly 10–30 ms of jitter against a 25 ms tick
period at 98 BPM. **Notes and CC only — never a clock reference.** The CONTRACT-WIRE
exclusion of BLE from the clock path stands. Audio does not travel over the radio.
Whether Chrome's Web MIDI enumerates it, and under what CoreMIDI name, is Unknown #3.

### 1.8 USB host mode at a 100 mA budget `[13]`
**What.** Recorded as a **non-gap**. The BF70x's USB OTG controller is genuinely used: TE
documents the OP-Z hosting an OP-1, an oplab, a Korg microKEY Air 25, a Kingston hub and an
Enttec DMXUSB Pro. The binding constraint is the 100 mA supply — a battery/boost-converter
limit, not a USB one, since VBUS is boosted from a 3.7 V cell.
**Attached** (to other gear, not the Mac). **Confidence: high** for the documented
behaviour; medium for the boost-converter explanation, which is inference.
**Honest limit.** Anything drawing more than 100 mA needs its own supply. Devices presenting
as more than one MIDI device are not supported.

### 1.9 Standalone computer-free DMX control brain, on the factory `dmx.json` `[13]` *(merged)*
**What.** OP-Z on internal battery + a bus-powered Enttec DMX USB Pro + a DMX cable = a
complete lighting brain with no computer, no phone, no mains. The shipped `dmx.json` is
16 × `rgb` occupying DMX 1–48, fixture *n* starting at 3(*n*−1)+1 — **sixteen 3-channel RGB
fixtures with no file changes whatsoever**. The on-device DMX preview renders all 16 fixtures
on the OP-Z's own LEDs with **no interface attached**, so a show can be composed and
auditioned with zero hardware.
**Detached.** **Confidence: DOC** (TE guide ch. 22 tested-device list: "ENTTEC DMXusb Pro,
direct, no external power") **+ MEAS** (`config/dmx.json` present on Ian's disk).
**Honest limits.** Consumes the USB-C port entirely (host XOR device), so it excludes laptop
attachment over the cable. TE warns direct connection "might deplete you battery faster".
The Pro **Mk2** needs a powered hub, which kills the battery-only story. Anything past
16 × RGB is a `dmx.json` write → Tier 3.

### 1.10 15-channel MIDI control surface with a readable 16×16 CC matrix `[12.5]`
**What.** Note, CC, pitch bend and program change per track on that track's channel — 240
addressable controls plus notes, from four encoders and 51 keys. The outgoing map is **not
guesswork**: `parameter_cc_out` is a 16×16 array in `config/midi.json` whose untouched rows
read `[1..16]`, identical to TE's published incoming CC numbers.
**What it takes.** Turn on `outgoing_midi` — a **front-panel toggle** (TEMPO+SCREEN key 3)
that persists to `midi.json`. That is a reversible device state change made on the device
itself, not a file write, which is why this sits in Tier 1. Its current state on Ian's unit
is UNK.
**Both.** **Confidence: DOC + MEAS + RE** (`artaction/OP-Z_Controls_Ableton`).
**Honest limits.** No display and no motorised feedback, so host values jump on first touch.
Channel 1 is doubly ambiguous on his device (track 16 folded onto channel 1 **and**
`channel_one_to_active: true`) — **use channels 2–15**. Muted tracks swallow incoming notes.
Track select, play/stop, octave and screen buttons transmit nothing. A nanoKONTROL is a
better controller; the valuable part here is that the map is *readable* rather than assumed.

### 1.11 Bounce as a rendering oracle for the engines `[12]`
**What.** `project` + `rec` renders 10 s of the current pattern to
`bounces/bounceNN/bounce.wav` — plain stereo RIFF/PCM 44.1/16, an internal digital render
that never crosses a DAC. Paired with MIDI-addressable engines, that is a route to
ground-truth renders of the 12 synth engines and 6 effects under controlled sweeps — raw
material for modelling them, or a reference library that outlives discontinued hardware.
**Both.** **Confidence: high** — mechanism and format both established.
**Honest limits.** Five slots of ten seconds, and **the master chain including the "punch"
compressor is baked into every render**. A slow, contaminated harvester: fine for a
reference library, weak for modelling. The write is device-initiated (a button press).

### 1.12 Track 14 with no module as sixteen MIDI CC lanes, at default CC numbers `[11.5]`
**What.** TE: "with no module inserted it acts as a MIDI track with 16 independent MIDI CC
values." Sequenced, parameter-lockable CC out of a 16-track sequencer.
**Detached** as a source. **Confidence: DOC.**
**Honest limit.** Usable with **no modification at all** at the default numbers; renumbering
is a `midi.json` write (Tier 3, §3.1) and is the same underlying fact as that entry. Both
judges called this the most generic item in the survey — the CC numbers are the only thing
that makes it special.

### 1.13 Link LIGHTS to an audio track to borrow its step components `[11]` — untested
**What.** Step components (pulse, multiply, random, the three spark trig-conditions) are
audio tracks 1–8 **only**, flatly stated by TE. So the lights track structurally cannot say
"fire this cue on 1 of every 8 passes". But "link tracks" is documented separately: hold
track + the active track, then press more track buttons; "playing the original triggers the
linked". Link LIGHTS to KICK and the kick's probability and ratcheting become the light
track's trigger source.
**Detached.** **Confidence: ARCH** — both halves DOC, the composition untested, and TE never
suggests linking a control track to an audio one. Triggering a linked track is not obviously
the same as conferring components on it. **Cheap to settle on-device with the DMX preview
and no hardware.**

### 1.14–1.16 The oplab (ZM-1) cluster — one gate, and it is procurement
Three real capabilities, all blocked on the same discontinued module. **Nothing in this
corpus records whether Ian owns a ZM-1.** Establish that before treating any of them as
actionable. Sweetwater lists it as no longer available; secondary market realistically.

| | capability | score | basis | note |
|---|---|---|---|---|
| 1.14 | **TRIG out as a per-step arbitrary pulse generator** — 0/+5 V, "suitable for triggering drum synths, arpeggiators, gate inputs"; TE prints the exact recipe (select audio track, hold shift, select steps, press jump, value key 0). Full step-component vocabulary applies: probability and ratcheting. | `[11]` | DOC | relay coil, solenoid, camera trigger, counter input |
| 1.15 | **Trig-driven tracks** — step-length multiplier 0 advances a track exactly one step per external trigger, so 16 tracks become 16 independently clocked 1–16 state machines. | `[10]` | DOC, undemonstrated | timing is ±1.35 ms (USB frame quantisation) — useless for sub-ms determinism |
| 1.16 | **CV2 / CV3 as bipolar ±5 V knob-driven analogue outs** — CV jack ring = CV2 (green dial), gate jack ring = CV3 (blue dial). The only analogue path out. TE's pro-tip: set any track's MIDI channel to 14 to route its sequence to CV. | `[9.5]` | DOC | **bipolar** — feeding −5 V into a 0–5 V input is a fault condition for *the other gear* |

TE warns explicitly that "the voltage coming from oplab module's cv or gate could damage a
line input or line output stage". Track mute suppresses trig pulses — that is a behaviour,
**not a safety interlock**.

### 1.17 USB mass storage — real, and nearly useless as a *carrier* `[10]`
**What.** A 34.6 MB volume with ~10 MB free, reachable only by holding `track` while
powering on, and left only by an eject that triggers an import pass. As a thumb drive it is
worse than a thumb drive in every dimension. **The defensible framing is "readable
filesystem", not "carrier"**: `config/midi.json` hands over the true channel map and CC
matrix, `config/general.json` exposes ten booleans, `import.log` and `rejected/` explain
failures the front panel never mentions, and `bounces/*/bounce.wav` is plain RIFF the bench
already parses.
**Attached, content mode only** — mutually exclusive with being an instrument.
**Confidence: DOC + MEAS**; the negative verdict on "carrier" is inference, stated as such.
**Honest risk — the highest of any routine activity here.** What the import pass does with
foreign files (a PDF, a tarball) is **UNK** — plausibly ignored, plausibly moved to
`rejected/`, plausibly deleted. Undocumented content is RE-reported to crash the device or
app, with recovery by factory reset from upgrade mode. And **even a read-only visit ends in
an import pass and a restart on eject: reading is safe, the exit is not free.**

### 1.18 Audio-rate control signals from the main jack — PO sync with no module `[9.5]`
**What.** AC coupling does not block pulses. A short click sample panned hard left on a drum
track, sequenced at the right subdivision, drives a Pocket Operator's SYNC IN (click on the
left channel, 2 PPQN) or any audio-rate trigger input, straight out of the 3.5 mm jack with
no expansion module.
**Either.** **Confidence: medium** — the mechanism is sound; the levels are unspecified and
load-dependent. TE's own line module publishes "po out: 0 to +3.3 V", which suggests TE never
considered the main jack the sync path. A Korg SYNC IN wanting ~5 V is likely marginal;
expect to need a booster or to be lucky.
**Risk.** Do not connect the jack to anything supplying phantom power — TE's verbatim warning
for the line module is that it "could destroy the sockets", and the main unit deserves the
same caution on a discontinued device.

---

## Tier 2 — Reachable with software we would write, no device modification (13)

Everything here runs on the laptop, or on files copied off the disk, or on the audio and MIDI
streams. **None of it writes to the device.**

### 2.1 Project inspector — read tempo, notes, steps, mixer, chains `[14.5]`
**What.** Parse a copied `.opz` and display the whole musical state: tempo, swing, mixer
levels, per-pattern track config, step counts, every note with pitch/velocity/duration/
micro-timing, mutes, pattern chains.
**What it takes.** A parser. The byte map is public and now independently checked.
**Detached. Confidence: high.** RE (lrk/z-po-project wiki, fw 1.1.17) and independently
implemented by `libopz` — then **re-verified MEASURED against Ian's own 15 files**: tempo
inside the documented 40–200 window in **15/15**; step count inside 1–16 across all **3 840**
track chunks; velocity exactly 100 in **3 625 of 3 657** real notes; the age byte `0x00` in
**211 200 of 211 200**.
**Why it matters.** The device has no display and no project naming. "What is actually in
project07" is a question the hardware makes you ask constantly and cannot answer.
**Risk: none.** Runs on a file copied off the disk.

### 2.2 `.opz` → MIDI export `[14.5]`
**What.** Emit a standard MIDI file from a project. Every field MIDI needs is present and
verified: note pitch, velocity, duration, micro-timing offset, per-track step count and step
length, and project tempo for the header.
**What it takes.** The parser above plus a MIDI writer. No new research.
**Detached. Confidence: ARCH, high** — follows directly from the verified note chunk and
header.
**Why it matters.** A sketch leaves the device as **editable notes instead of a baked stereo
bounce**. This is strictly better than `underbridge`, the only actively-maintained OP-Z tool,
which records audio track-by-track *precisely because it cannot read the file*. Every owner
wants this; nobody has built it.
**Risk: none.**

### 2.3 The OP-Z as a ground-truth cyclostationary source for Yellowjacket's cyclic detector `[14.5]`
**What.** The tempo-synced LFO ladder (1/64…2/1) at a keypad-typed BPM (40–200) puts a known,
exactly-quantised symbol clock into the audio. At 120 BPM that ladder is
0.5, 1, 2, 4, 8, 16, 32 Hz — **endpoint for endpoint the working band of
`js/analysis/cyclic.js`**, which I re-checked in the source today: `MIN_ALPHA_HZ = 0.5`,
`DEFAULT_ALPHA_MAX_HZ = 30`, and it reports `usableAlphaHz` / `nullAlphaHz` exactly as the
lens claimed. So the OP-Z is a calibration generator with a **typed-in alpha**: set it, read
it back off the cyclic plane, and check the detector's own clamps behave as its comments
claim at 44.1 kHz.
**What it takes.** An afternoon. Probe generated on the Mac, fed back via `shift`+3; capture
over USB audio.
**Attached. Confidence: high** — every input is DOC or MEAS; only the experimental outcome is
open, which is the point.
**Secondary measurements nobody has published.** Envelope-domain transparency of the sampler;
what the master "punch" compressor does to modulation depth; tape-track wow/flutter as
alpha-axis smear.
**Risk: none.** Read-only. This is the only entry in the survey aimed at the researcher
rather than the musician, and it becomes a rig you re-run every time you touch the detector.

### 2.4 Identity round-trip harness — the gate on every writer idea `[14]`
**What.** Read a project, re-serialise it, assert the output is **byte-identical** to the
input.
**Why it matters.** That single test is the honest measure of whether the format is
understood, and it is worth more than further reading. **A writer that cannot reproduce its
own input must never be pointed at the device.**
**Detached. Confidence: ARCH, high** — all structure verified, and three previously-unknown
details (version trailer, empty-note signature, micro-timing scale) are now pinned and would
otherwise have made this fail silently.
**Risk: none — it writes only to the laptop. This is the safety gate, not a risk.**
**Note.** Build this only if you intend to go down the Tier 3 writer path. On its own it is
infrastructure you construct once and never consciously open again.

### 2.5 The digital sampling bridge — closing the sample loop without writing to the device `[14]`
**What.** Yellowjacket renders a slice → the Mac's audio output is set to the OP-Z → the
OP-Z's I/O track sees it as usb input (`shift`+3) with filter/LFO/fx sends/pan/volume → and
**the device's own sampler records it into a slot**, writing its own file, in its own format,
with its own `drum_version` and `playmode`, into its own YAFFS2 image.
**What this deletes.** The entire `.aif` byte contract; the `drum_version` 1-vs-3 and
`playmode` 8192-vs-16384 disagreement recorded in `device-scan.md`; the `APPL 'op-1'` chunk
that makes malformed files invisible with no error; the two reboots per attempt; the silent
`rejected/` folder; the 24 MB budget arithmetic — **and every write to the device.** The
bench never touches the disk, so nothing can be corrupted by a bad export because there is no
export.
**Attached. Confidence: DOC for every link; ARCH for the chain as a whole.** I re-fetched
TE's input-selection page today and confirm verbatim: *"usb audio - hold shift and press 3 to
toggle the incoming usb audio signal, if a signal is detected over usb. note: the connected
device needs to be a usb audio host in order for OP–Z to recognize it"* and *"the filter,
lfo, fx sends, pan and volume works just like on any instrument track."* A Mac with the OP-Z
plugged in is exactly that host, and the 2-out side is MEAS at 44 100 Hz.
**Honest limits.** It is a **real-time, once-through** sampling path, so it replaces the
one-sample-at-a-time case rather than batch export of a 24-slice kit. Slot choice happens on
the device. Feedback loop if the OP-Z's output is simultaneously routed back and monitored —
worth a UI warning. The chain is documented but **untested here**.
**Risk: low, and that is the entire argument** — it is specifically the low-risk alternative
to the write path.

### 2.6 Semantic project differ `[13.5]`
**What.** Diff two `.opz` files and report changed bytes as **named fields** rather than
offsets. Already built and run during the survey: `project03` vs its snapshot gives **603
differing bytes in 98 runs**, each localised to e.g. `pat0/track_params (track 1, field 10)`
or `pat0/notes note#12`.
**Detached. Confidence: high** — ARCH, and demonstrated working on Ian's snapshot pairs.
**Its second job is larger than its first.** It is the entire methodology for decoding what
remains unknown: change one thing on the device, snapshot, diff, and the changed offset names
itself. **Risk: none.**

### 2.7 Version control and archival of projects `[13.5]`
**What.** Ten projects at ~342 KB each, committed to git.
**Why it is more than tidiness.** The device's own undo is **depth-1** — one snapshot slot
per project, and TE documents that "any previous snapshot will be overwritten". A git history
is therefore a genuine capability gain over the hardware.
**Detached. Confidence: high** (DOC + MEAS file sizes). **Risk: none.**
**Honest limit.** Until the differ exists this is `cp` plus `git commit`; its value is largely
borrowed from §2.6.

### 2.8 Raw external input monitored straight into Yellowjacket over USB audio `[13]`
**What.** The 12-second capture ceiling is a **sampling** limit, not a **monitoring** limit.
The i/o track's external input path has filter, LFO, fx sends, pan and volume and feeds the
master bus — and the master bus is what the host sees on the two USB audio inputs. If
raw-input monitoring (`shift`+0) reaches that stream, `getUserMedia` gets **unlimited-length**
OP-Z mic/line audio with no import, no eject and no file.
**Attached. Confidence: ARCH, untested.** The general capture path is proven on his machine;
whether the *raw input* is in that stream is the one open question.
**Sharpened today.** TE's verbatim text is *"hold shift and press 0 to monitor the raw input
signal. the OP–Z main out signal is muted in speaker / headphones."* TE says **nothing about
the USB stream**. That narrows the unknown rather than settling it — see Unknown #2.
**Risk: none to the device.** Hearing risk only, from TE's own warning that the raw input
"can be a lot louder than your synth sound".

### 2.9 Yellowjacket → Web MIDI → CC 1–8 on channel 15 → arbitrary DMX values `[12.5]`
**What.** TE's incoming-MIDI table gives absolute CC 1–18 on tracks/channels 1–16 with **no
exclusion for control tracks**. Ian's `midi.json` has `track_channels [0,1,…,14,0]`, putting
LIGHTS (track 15) on MIDI channel 15. Composing the two documented tables: CC 1–4 on channel
15 writes the lights track's page-1 dials, CC 5–8 the four nameless page-2 dials. Any MIDI
source — Yellowjacket in a browser tab, plain Web MIDI, no sysex — becomes a MIDI-to-DMX
bridge. Bonus from the same table: CC 60 step count, CC 61 step length, CC 62 quantize,
CC 63 note length, on channels 1–16.
**Attached. Confidence: ARCH** — both source tables DOC, the composition untested.
**This is the cheapest test in the survey and the one to run first.** It needs **no DMX
hardware and no writes at all**: send CC on channel 15 and watch the OP-Z's own on-device DMX
preview LEDs respond. If CC 5–8 move the preview, §1.9 and §3.3 are both confirmed in one
gesture.
**Known cost.** MIDI CC is 7-bit (128 values) while the parameter byte and DMX channel are
8-bit (256) — **half the resolution** of an on-device parameter lock, and whether the
firmware scales ×2 or left-shifts is UNK.

### 2.10 Bounce-plus-project paired dataset `[12.5]`
**What.** Each of the 5 bounces ships as `bounce.wav` **alongside** `project.opz` — rendered
audio paired with the exact project state that produced it. A labelled dataset for free.
**Detached. Confidence: high** (DOC + MEAS on disk). **Risk: none.**
**Honest limit.** Five ten-second pairs is a small dataset, and the master chain including the
punch compressor is baked into every render, which limits what it can validate.

### 2.11 Differential decoding of the remaining unknown fields `[12.5]`
**What.** Name the 44 unknown header bytes at offset 521 and the residual step-component
semantics by observation: change one thing on the device, snapshot, diff. Leads already
observed: bytes `00 ff 7f` at 521 in project01, `a0` at 529 in three files, and pattern-chain
slot 15 changing between every project and its snapshot.
**Attached** (the device is used normally and only read). **Confidence: high** for the method;
the tooling is demonstrated. **Risk: none — no file is written by us.**
**Honest limit.** Diminishing returns. None of the named leads is load-bearing for anything
else on this list. Pure research that changes no session.

### 2.12 Measuring the OP-Z's PRNG (rather than using it) `[10.5]`
**What.** Randomness is everywhere in the UI — random values on pulse and multiply, velocity,
ramp, the random component, portamento, the three spark trig conditions, LFO random shapes,
randomize-preset. **Nobody has published how good it is.** Sequence a track with random
velocity, capture the MIDI, and run serial correlation, period search, spectral test, and
specifically an **alpha-domain sweep** — a short-period LCG will show as a spike on the cyclic
axis in the tool Ian already has. Recovering a repeat period would be a genuine RE result
about a device whose firmware nobody can open.
**Attached, passive capture. Confidence: high** that it is cheap and read-only; open on what
it finds. **Risk: none.**
**The inverse must be stated plainly.** As an entropy **source** this is a toy: an unaudited
black box, and using it for anything that matters would be trusting the one property you
cannot verify by using it. This is a curiosity result you write up once and never reopen.

### 2.13 videolab on macOS as an MIT-licensed bidirectional MIDI transform engine `[10.5]`
**What.** `teenageengineering/videolab` is not a video library — it is a Klak node graph with
MIDI **input and output** nodes ("to control MIDI devices from videolab use the Knob Out, Note
Out and Sequencer Out nodes"), plus clock at 24 ppqn, Unity Animator-driven automation curves,
and the macOS IAC driver. On a Mac that is a documented MIT-licensed modulation brain.
**Attached. Confidence: DOC** for Mac-side use (repo read directly: MIT, 781 stars, last push
2023-10-30); **SPEC** for whether a videopak inside TE's iOS app routes MIDI-out to CoreMIDI.
**Verdict: skip.** Unity 2018.4.29 is mandatory for app-targeted videopaks — an eight-year-old
toolchain — to get MIDI transforms that are **thirty lines of JS in a bench Ian already
owns**. No device risk; poor trade.

---

## Tier 3 — Requires writing to the device (10)

Everything here changes a file on the content disk. **All of it is out of scope by
instruction**; it is mapped so the cost is known, not recommended.

**The shared cost of every entry in this tier.** Content mode is entered by holding `track`
while powering on and left by an eject that runs an import pass — the device recalculates
space, reassigns slots, rebuilds plug definitions and **restarts**. So every write costs two
reboots through that window. Config files are **modify-only** (never added or removed), and a
malformed file is only discovered *after* unplugging. **Back up `midi.json`, `dmx.json` and
`general.json` before touching any of them.**

| # | capability | score | what exactly is written | risk, honestly |
|---|---|---|---|---|
| 3.1 | **Editable outgoing CC map** — `parameter_cc_out` (16×16) and `track_channels` are plain JSON, so the device's entire outgoing control-surface identity is editable data: its dials can emit exactly the CC numbers and channels a target expects, with no translator. | `[10]` | `config/midi.json` | Arbitrary remaps are **UNTESTED**. A bad map means controls silently address the wrong things until corrected — recoverable, confusing while broken. TE documents the range as "0–255" **on a 7-bit wire**; assume 0–127 usable. Same underlying fact as §1.12. |
| 3.2 | **Algorithmic project generation from a hand-configured template** — Euclidean rhythms, generative variation, transposition, retrograde, by taking an existing project as a template, **never touching its track chunks**, and rewriting only the note and step arrays. | `[10]` | a `.opz` in `projects/` | The template trick is the right engineering answer: it sidesteps the plug-ID blocker entirely and leaves every field we do not fully understand **byte-identical to a file the device itself wrote**. Still a project write. **Gate it behind §2.4.** |
| 3.3 | **knob5–knob8 as four unnamed 8-bit control lanes on DMX** — TE's parameter-page chart names only page 1 (colour, alt colour, pattern speed, intensity) and lists page 2 as literally "5, 6, 7, 8". Four dials with no on-device meaning, whose only function is to land on whatever DMX channel `dmx.json` says. | `[9.5]` | `config/dmx.json` | Per-step parameter locks on **track 15 specifically are untested** — it rests on the Z-PO map allocating track 15 like an audio track. "Nameless" means no on-device meaning, not free general-purpose lanes. The 128-channel cap has an undocumented overflow behaviour, likely silent truncation. |
| 3.4 | **DMX/LIGHTS as a general byte-output port to arbitrary hardware** — DMX512 is a commodity 8-bit actuator bus at ~44 Hz, and DMX-to-0–10 V decoders and relay packs are off-the-shelf. **`iFreilicht/opz_artnet_adapter` (CC0) puts an FTDI232 impersonating an ENTTEC Pro in front of an ESP-01 and the OP-Z drives it happily** — a $5 microcontroller can stand in for a lighting interface. | `[10]` | `config/dmx.json` | **The only DMX entry that states the honest ceiling:** knob1–4 are the page-1 dials and knob5–8 the same four on page 2, so there are **eight independent continuous values for the whole track**, not 128 authored bytes — plus the per-step colour/intensity/pattern stream and fog. Every other DMX entry softens this. |
| 3.5 | **MIDI file into an OP-Z pattern (writer)** — import a DAW or notation phrase by rewriting the note array. The note chunk is fully understood and verified, including the empty-slot signature a naive writer would get wrong. | `[9]` | a `.opz` in `projects/` | **The gap between "we can parse it" and "the device will load it" is exactly where this format burns people — no `.opz` writer has ever existed to prove acceptance.** `libopz`'s `saveAsOpz()` is broken (wrong magic, wrong length, confirmed by compiling its structs). TE documents recovery (remove the file, a default empty project replaces it), so a bad write costs one backed-up project. **Unproven tail risk:** firmware parses projects at startup and a malformed one faults, needing a factory reset from upgrade mode. |
| 3.6 | **The ten `general.json` booleans** — `backlit_keys`, `generous_chords`, `disable_start_sound`, `disable_track_preview`, `disable_param_page_reset`, `latch_notes_with_shift`, `legacy_input_select`, `disable_headphone_db_reduction`, `disable_microphone_mode`, `temp_param_add_fx_a`. Several have no front-panel control. | `[8]` | `config/general.json` | **Two corrections to the source entry, both from the skeptic pass, and they matter.** (a) The "undocumented" framing is **false** — TE's reference page documents all ten with prose. No front-panel control is true; undocumented is not. (b) `disable_headphone_db_reduction` is documented as *"disable reducing outsignal level based on headphone impedance"* — **impedance gain compensation, not a safety limiter**. The source entry's "hearing-damage risk" was an invented dramatisation of a documented user setting. `backlit_keys` is the only one worth wanting, and it is a set-once change. |
| 3.7 | **DMX as a physical-actuation bus** — relay packs, dimmer packs, 0–10 V converters, fog, motors. TE's own `fog` channel type (the only binary type, 0 or 255, "triggered by animation 14") is TE admitting the track already drives non-luminous hardware, and animations are white piano keys on track 15, so a haze cue is placed, copied, micro-timed and pattern-chained exactly like a snare hit. | `[8]` | `config/dmx.json` | **Stated plainly: do NOT drive pyrotechnics from this.** No interlock, no arm/disarm, no watchdog, no error reporting, no confirmed frame rate, firmware last touched 2022-03-31. Track mute suppressing output is a behaviour, not a safety system. Fog fine; anything with stored energy, heat, or a moving mass that can trap needs a hardware interlock the OP-Z cannot reach. The **fog channel's release semantics are undocumented** — a channel stuck at 255 keeps a hazer pumping. Bench-LED it first. |
| 3.8 | **`off` channels as DMX address padding** — `dmx.json` has no address field; fixtures pack contiguously in index order (corroborated by jflee on op-forums). So you cannot leave gaps. But the documented `off` type occupies an address and outputs zero, so *k* `off` channels form an address pad. | `[8]` | `config/dmx.json` | A workaround for a niche addressing problem inside an already-niche capability, and it **spends both hard ceilings at once** (one of 16 fixture slots, *k* of 128 channels). |
| 3.9 | **Full DAW round-trip** (project → MIDI → DAW → MIDI → project). | `[8]` | a `.opz` | Note-level and arrangement-level round-tripping is unblocked; **sound assignment is not** — the plug ID blocks it (§5.4). Every return trip loses the thing that made the sketch sound like anything. Inherits every unproven assumption of §3.5. |
| 3.10 | **DMX → Art-Net node → MQTT / Hue / IP devices** — `lukasklinger/ArtNet_MQTT_Bridge` and `sinedied/dmx-hue` are real named projects, but both consume Art-Net over IP, not raw DMX512. | `[7]` | `config/dmx.json` | Four boxes to blink a smart bulb, and last on effort-to-payoff. **The survey failed to compose its own findings here:** §3.4's `opz_artnet_adapter`, verified real, *is* precisely the missing DMX-to-Art-Net middle box this entry laments needing. Even so, the payoff is a party trick. |

---

## Tier 4 — Requires firmware or hardware modification (2)

**Neither should be attempted.** Both are recorded so the questions are closed rather than
rediscovered.

### 4.1 Firmware is a closed wall, and the update ships the bootloader `[11.5]`
**What is known.** `z_firmware_1_2_45.zfw` is AES-CBC encrypted at 7.9998 bits/byte entropy,
storing an IV at 0x70 and a key **index** but no key; the encrypted filename decrypts to
`firmware_bin_only_with_bootloader.zip`. **Custom OP-Z firmware is off the table permanently**
— the product is discontinued and the key lives in the device.
**Confidence: high on the wall.** RE: `ioma8/opz-firmware-notes` (2025-10) — offsets, IV
location, key index, failed XOR/CTR/CBC/CFB/OFB/ECB recovery. One reconciliation is my
inference and labelled as such: ioma8 concludes AES-256 while the ADSP-BF70x secure boot ROM
is specified for AES-128 CBC with ECDSA-224; the reading that reconciles them is that the
`.zfw` is a TE **application-layer envelope** decrypted by the running firmware, not the SoC's
boot format.
**Has anyone bricked one? Yes.** op-forums #16062, reporter **Erlik_Khan**: unit stopped
booting after an update, trig 1 blinking white, would only re-enter upgrade mode, samples
gone, **no fix posted**.
**Risk, plainly.** A failed firmware write can permanently brick a device that is
discontinued, unrepairable and unobtainable, and **because the payload contains the
bootloader, the recovery path is the thing being overwritten**. Ian's unit is already on
1.2.45, the last release. There is nothing to gain and everything to lose.
**Do not install firmware, and do not install module firmware.**

### 4.2 The module bay is a digital bus with an unpublished 14-contact pinout `[5.5]`
**What is known.** Read off the FCC internal photographs (ID Z23012A): the module mates
through two blocks of spring-loaded pogo pins — 2×3 left, 2×4 right, **14 contacts** — so the
OP-Z side is flat landing pads. The bay is not an analogue breakout: the oplab module has its
own `.zfw` firmware flashed *through* the OP-Z's upgrade mode, whose release notes cite a
"rewritten communication protocol". So the bay carries power, a bidirectional data link, and
enough of a programming path to reflash a downstream MCU. An analogue path is present too.
**Confidence.** High for the contact count and the firmware-through-the-bay fact — but the
contact count is **the surveyor's own upscaled photo reading with no corroboration**, and
**the pinout and protocol are entirely UNKNOWN**. No published pinout, no DIY module project
anywhere (Hackaday, GitHub, op-forums all searched).
**Has anyone done it? No.**
**Risk: high — the one place in this survey where the answer is "do not proceed".** Recovering
a pinout means probing a live bay on a discontinued, unrepairable, unobtainable device, with
modules carrying ±5 V rails. Survey value only.

---

## Tier 5 — Speculative, blocked, or dead ends (8)

Recorded so nobody spends an afternoon rediscovering them.

### 5.1 The 6-axis IMU's data never reaches any wire `[12]` — documented absence
TE documents a 6-axis motion sensor, exposed on the device as the "gyro" LFO shape and as
tilt-to-engage-microphone. **There is no motion row anywhere in TE's MIDI CC table.** Motion
data cannot leave the OP-Z as MIDI, so Yellowjacket can never see it; the TE app is the only
consumer. A correctly argued absence, worth exactly the afternoon it saves. Reaching it would
require firmware modification, i.e. Tier 4, i.e. never.

### 5.2 MIDI CC out of the device as a *data channel* `[11]` — TOY, killed by its own arithmetic
Track 14 with no module gives 16 independent CC values, but those are **knob values, not
per-step payload**. At the 200 BPM ceiling with 16th steps that is 13.3 steps/s; even assuming
all 16 CCs change every step it is **~1.5 kbit/s with ~1.35 ms timing quantisation** — worse
than sending the bytes from the computer on every axis. The reusable thing in this
neighbourhood is the CC **map** (§1.12, §3.1), not the CC stream.

### 5.3 The OP-Z as a portable measurement instrument `[9.5]` — TOY
The load-bearing fact is the good one: **no published spec exists for the OP-Z's own mic or
its own 3.5 mm jack** — no sensitivity, impedance, level or frequency response, from TE or
anyone, and the FCC filing lists block diagram, schematics and operational description as
**metadata only, no files**, so the usual FCC route to internals is closed. Against a $20
class-compliant interface and a calibrated capsule it offers an uncalibrated mic, a 12 s/6 s
ceiling, **one** documented gain anchor (hold play + track button 4 = 0 dB), and retrieval by
reboot. **It measures nothing absolutely.** Its only unique property is being pocketable and
shaped like a toy — an ethnographic property, not a metrological one. §2.8 is the version of
this that is actually real.

### 5.4 From-scratch project authoring referencing Ian's own samples `[9.5]` — BLOCKED
**The sharpest constraint in the format lens, and it is measured, not argued.** Plug IDs are
bimodal: 49 small IDs (0–151) matching the RE'd engine enumeration, plus **22 opaque 32-bit
values** — e.g. `0x9be18872` recurring on the kick track across **9 separate projects**. The
large ones are stable identifiers for user sample plugs and **nobody has decoded their
derivation; no source addresses it at all.** A program can author notes, steps, tempo, chains,
mutes and sound parameters freely — it **cannot invent a reference to one of Ian's samples,
only copy one from an existing file.** High confidence that it is blocked; low confidence as
to the derivation. This is why §3.2's template approach is the right engineering answer.

### 5.5 BLE-plus-USB-host topology — the escape from the one-port exclusion `[9]` — unproven
The organising finding of the systems lens is an **exclusion table**: the OP-Z has one USB-C
port that is host XOR device, and content mode is a boot mode rather than a concurrent one, so
most system ideas die on **simultaneity, not capability**. This is the one combination that
escapes it — host the Enttec widget on USB-C and run lights from track 15 on battery, while
exchanging MIDI with the laptop over Bluetooth, because the radio does not need the connector.
**Architecturally sound** (radio and USB are separate subsystems) but **neither TE nor any
community project documents BLE MIDI and USB host mode running together**, on a device whose
host stack already refuses multi-endpoint gear. Power is the binding constraint: 100 mA of
widget plus a BLE link out of 740 mAh. It is a performance topology, not work — it only pays
for someone simultaneously running lights and wanting laptop telemetry. One evening settles it
and nothing about testing it writes to the device.

### 5.6 Sampler as an arbitrary data carrier `[7.5]` — TOY, refuted by its own arithmetic
Encode a payload, write a `.aif`, import, trigger, recapture, demodulate. The substrate is
real (24 MB pooled, 24 addressable slices, all at exactly the 44 100 Hz the USB path runs at,
so no resampling anywhere). **One content-mode mount moves ~2.8 × 10⁸ bits. Slice-as-symbol
signalling gives ~293 bit/s.** Six orders of magnitude worse than mounting the disk you can
already mount — and it costs a write to find that out.

### 5.7 Steganography in the `.opz` project blob `[4.5]` — do not
Projects are a fixed 342 848 bytes with ~48 bytes still unidentified after the most
substantial RE effort that exists on this format. **Worst risk-to-reward in the survey, with
no purpose stated at all.** It rests on "unidentified" meaning "unused", which does not
follow; **auto-save is on by default and the device rewrites projects**, so the payload is not
even stable; there is no independent writer to cross-check against; and the benign `rejected/`
recovery path covers **samples, not projects**.

### 5.8 Live pattern injection over sysex `[4]` — keep closed
The sysex `$09` pattern message is zlib-compressed with the signature 7-bit-mangled from
`78 9c` to `78 1c`. Decompression is understood; the payload is presumed to be the pattern
chunk. **Still undecoded seven years on** — `patriciogonzalezvivo` asked publicly how to
decompress it in 2022 and the thread was never answered. The only implementation is
non-commercially licensed with no write path, it needs a 1 Hz heartbeat, and **a live memory
write has no "delete the file" recovery** — so it is *higher* risk than file writing, not
lower. It buys nothing the file path does not already do. CONTRACT-WIRE's sysex exclusion
stands.

---

## If you only do three things

Chosen for payoff-to-risk. All three are read-only with respect to the device, so payoff
dominates the ranking.

**1. Build the project inspector and ship `.opz` → MIDI export on top of it.** `[14.5 / 14.5]`
One parser, two capabilities, zero risk, entirely on copied files. The byte map is verified
against 15 of his own projects at stated hit rates, so this is implementation rather than
research. It answers the question a display-less, name-less device forces on you constantly
("what is in project07"), and it gets a sketch off the device **as editable notes instead of a
baked stereo bounce** — the workflow every OP-Z owner wants and nobody has built. Strictly
better than `underbridge`, which records audio track-by-track precisely because it cannot read
the file.

**2. Test the sampling bridge, then use it instead of ever writing a `.aif`.** `[14]`
First spend ten minutes on the precondition: play audio out of the Mac into the OP-Z, press
`shift`+3, and confirm the device sees it and can sample it. If it holds — and every link is
documented — then letting **the device write its own file** deletes the entire `.aif` byte
contract, the `drum_version` 1-vs-3 and `playmode` 8192-vs-16384 disagreement that
`device-scan.md` found, the invisible missing-`APPL`-chunk failure mode, the silent
`rejected/` folder, the 24 MB arithmetic, and both reboots per attempt. It converts the only
WRITES-TO-DEVICE item on the README opportunity list into a read-only one. The trade is that
it is real-time and once-through, so it replaces one-sample-at-a-time work rather than batch
kit export. **Take that trade.**

**3. Stand up the cyclostationary calibration rig.** `[14.5]`
One afternoon, read-only, and it is the only item that improves Yellowjacket's own instrument
rather than the music workflow. A typed BPM plus the documented LFO sync ladder puts an
exactly-known alpha into the audio that lands endpoint-for-endpoint inside `cyclic.js`'s own
0.5–30 Hz band — which I re-confirmed in the source today. It becomes a rig you re-run every
time you touch the detector, not a one-off demo, and the secondary measurements (sampler
envelope-domain transparency, what "punch" does to modulation depth, tape wow/flutter as
alpha-axis smear) are genuinely unpublished.

**Explicitly not in the three.** The identity round-trip harness `[14]` is the correct first
build *if* you intend to write projects — and it is the honest measure of whether the format
is understood — but none of the three above needs it, so it stays a gate rather than a task.

---

## What is genuinely UNKNOWN, and the experiment that would settle it

Ordered by how much each unblocks. Every one of #1–#4 is read-only and cheap.

| # | unknown | why it matters | the experiment |
|---|---|---|---|
| 1 | **Does Chrome honour 44 100 Hz, or resample to 48 000?** | The standing gate on **all** USB-audio work — §1.1, §2.3, §2.5, §2.8 all inherit it. | `navigator.mediaDevices.enumerateDevices()` plus an `AudioContext` `sampleRate` check in the bench. Minutes. |
| 2 | **Does the `shift`+0 raw monitor reach the USB audio stream?** | If yes, the 12 s capture ceiling **stops being a monitoring ceiling** and the OP-Z becomes an unlimited-length field input with filter, LFO and fx on the path (§2.8). | Press `shift`+0 with a signal on the input and record the USB stream. Two minutes, no writes. TE's text confirms only that main out is muted **in speaker/headphones** and says nothing about USB, so this is genuinely open. |
| 3 | **Does Chrome's Web MIDI enumerate the BLE-paired OP-Z, and under what CoreMIDI name?** | Yellowjacket's port matcher keys on the name. If it differs, wireless notes/CC work but the bench will not see them (§1.7). | Pair via Audio MIDI Setup, open the WIRE panel, read the port list. |
| 4 | **Do CC 5–8 on MIDI channel 15 move the on-device DMX preview LEDs?** | Settles §2.9 and §1.9 **in one gesture, with no DMX hardware and no writes** — the cheapest high-yield test in the survey. | Send the CCs from a browser tab; watch the LEDs. |
| 5 | **Does a `drum_version: 1` patch still load on firmware 1.2.45?** | The device writes version 3 and `playmode` 16384; our contract hardcodes 1 and 8192. Not yet a proven bug — but not verified either. | **Requires a WRITE.** Drop a Yellowjacket export in a slot, eject, check `rejected/` and the pads. Out of scope until Ian says so. §2.5 makes this question moot. |
| 6 | **Does the OP-Z emit MIDI clock while its sequencer is stopped?** | Anything that waits for a running master needs to know. Clock was already flowing when the device was attached, so it was never tested. | Stop the sequencer, keep capturing. |
| 7 | **Do per-step parameter locks work on track 15 (LIGHTS)?** | Three Tier-3 DMX entries silently inherit this assumption. It rests only on the Z-PO map allocating track 15 like an audio track — plausible, unverified. | P-lock a lights dial, watch the preview across steps. |
| 8 | **Is the USB audio return a digital tap or a re-digitised analogue path?** | Decides whether §2.3's transparency measurements are measuring the sampler or the whole analogue chain. | Null-test a known file through the loop against itself. |
| 9 | **Does Ian own a ZM-1 oplab?** | Not an experiment — a procurement fact **nowhere in this corpus** — but it gates §1.14–§1.16 entirely. Discontinued and scarce. | Look in the drawer. |
| 10 | **The derivation of the opaque 32-bit plug IDs.** | The single blocker on from-scratch authoring (§5.4). No source addresses it. | Sample something new, snapshot before and after, diff (§2.6). The one unknown here where the differ is genuinely the right instrument. |

Additional standing unknowns are recorded in `README.md` §4.1 and §4.2 and are not repeated
here — including the `dyna_env[]` semantics every writer copies without understanding, what
the `"editable"` key does, the `config/userPresets.dat` byte format (351 202 B, no published
source anywhere), and ~48 bytes of the `.opz` structure by the Z-PO Project's own admission.

---

## Two corrections carried forward from the adversarial passes

Recorded because both were **errors in the survey itself**, not in the device:

1. **`general.json` is documented, and the headphone hazard was invented.** TE's reference
   page documents all ten booleans with prose. `disable_headphone_db_reduction` is
   *"disable reducing outsignal level based on headphone impedance"* — impedance gain
   compensation, **not** a safety limiter. The "firmware attenuates by default / hearing-damage
   risk" framing was a dramatisation of a documented user setting.
2. **The BLE novelty claim was false.** One lens claimed the standard GATT service was unproven
   and "nobody has noticed", while another lens in the same directory cited the op-forums
   thread that settles it. Named users confirmed macOS pairing in January 2026.

Both judges also noted that **duplication inflates the apparent count** — DMX appeared as eight
entries with one gate, BLE as three, and the CC map as two. They are merged above, and the
DMX ceiling (**eight independent continuous values for the whole track**, stated honestly in
exactly one source entry and softened in the rest) is stated once, plainly, in §3.4.
