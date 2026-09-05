# Skeptic pass — 53 surveyed OP-Z capabilities, 2026-09-04

Scoring role: adversarial. Every candidate scored 1-5 on **real** (is the technical
basis sound), **useful** (does it remove drudgery or open work for a working musician
and researcher), **safe** (5 = no device risk, 1 = could brick). Device was NOT mounted
during this pass; nothing was written to it, and nothing in this survey requires writing
to it unless explicitly scored down for that.

## What I independently verified (and what it changed)

**1. TE documents all ten `general.json` booleans, with descriptions.**
Fetched <https://teenage.engineering/guides/op-z/reference> directly. It says verbatim
"use the general.json file found in content mode to customize the OP-Z general
configuration" and then documents every one of the ten keys. Two consequences for the
"ten settings with no front-panel control" candidate:

- The framing "undocumented / TE never exposes these" is **wrong**. No front-panel
  control is true; undocumented is false. TE publishes them with prose descriptions.
- `disable_headphone_db_reduction` is documented as *"disable reducing outsignal level
  based on headphone impedance"*. That is **impedance-dependent gain compensation, not a
  safety limiter**. The candidate's "the firmware attenuates headphone output by default
  and the un-gate is a boolean" plus a "straightforward hearing-damage risk" is an
  invented dramatization of a documented user setting. Scored down hard on `real`.

**2. BLE MIDI to a Mac is documented by TE and demonstrated by named users.**
TE's product page carries "Bluetooth LE" and "wireless communication over ble"; TE's own
copy elsewhere states the OP-Z "is able to connect wirelessly to BLE MIDI capable devices
such as laptops, tablets, and phones". I then fetched op-forums thread 31340 ("Op-z
bluetooth 2026") and read the outcome directly: **Hopeeasy, 2026-01-13, "it works like a
charm!"** and **Kosta, 2026-01-14, "Everything works as expected. Hooray!"** — both after
being pointed at Audio MIDI Setup > Show MIDI Studio > Configure Bluetooth.

This settles a contradiction *inside the survey itself*. The silicon-lens entry claims the
GATT service is "UNPROVEN... no published confirmation either way" and that "nobody has
noticed", while the systems-lens entry cites the same thread correctly. **The silicon-lens
BLE entry's novelty claim is false**, and it duplicates a better-evidenced entry. The
capability is more real than that entry says; the entry is less trustworthy than it reads.

**3. `iFreilicht/opz_artnet_adapter` is real.** ESP8266-based Art-Net adapter for the
OP-Z, confirmed on GitHub. This strengthens the "DMX as a general byte-output port" entry.
It also exposes a **gap the survey does not connect**: the DMX -> Art-Net -> MQTT/Hue entry
laments that its chain needs "a DMX-to-Art-Net node in the middle", when another entry in
the same survey names a $5 device that *is* that node. Two findings in one document that
should have been composed and were not.

**4. Plug-ID blocker holds up.** README §3.4 documents 49 small IDs (0-151) matching the
RE'd engine enum plus 22 opaque 32-bit values, with `0x9be18872` recurring on the kick
track across 9 separate projects. The "cannot synthesise a reference to a user sample,
only copy one" conclusion is measured and is the sharpest real constraint in the format
lens. The template workaround that follows from it is the right engineering answer.

**5. Device scan updated mid-pass** with the drum note base (53, notes 53..76, passive
capture, span exactly 24) and — load-bearing for four candidates — **"The OP-Z is a
recordable audio input (device 'OP-Z', 2 ch, 44.1 kHz), so its output can be captured and
analysed programmatically."** That is no longer an inference; it is done on his machine.

## Cross-cutting criticisms

**Duplication inflates the count.** DMX appears as at least six separate "capabilities"
(knob5-8 lanes, physical actuation, standalone brain, Web MIDI to ch 15, systems-lens DMX
brain, general byte-output port, plus Art-Net/MQTT and 'off'-channel padding). They are
facets of one capability with one ceiling. BLE appears three times. Track-14 CC lanes and
the editable CC map are the same fact stated twice. A reader counting items will
overestimate how much is here.

**The "8-bit, 8-lane" framing is oversold everywhere except one entry.** Only the
"general-purpose byte-output port" entry states the honest limit plainly: knob1-4 are the
lights dials on page 1 and knob5-8 the same four on page 2, so there are **eight
independent continuous values for the whole track**, not 128 authored bytes. Entries that
describe a "16-step x 8-lane x 8-bit automation frame" without that caveat are describing
the same eight knobs in more flattering language. And external CC control is 7-bit against
an 8-bit channel — half resolution, with the scaling behaviour unknown.

**Per-step parameter locks on track 15 are an untested composition, repeated as if settled.**
It rests on the Z-PO byte map allocating track 15 identically to audio tracks. Plausible;
unverified. At least three entries inherit this assumption without re-flagging it.

**"Architecturally possible" is doing heavy lifting.** Roughly half the survey is ARCH.
That label is honest and consistently applied — genuine credit — but a reader should not
treat an ARCH entry as a plan. The two that matter (C3 sampling bridge, raw-input
monitoring) are both settleable in under an hour with no writes, and both should be tested
before anything is built on them.

**Module-dependent entries are gated on procurement, not engineering.** Four entries
depend on the ZM-1 oplab, which is discontinued and scarce, and the survey does not
establish whether Ian owns one. Their `useful` scores reflect that.

## The five that survive the pass

1. **C3 digital sampling bridge** — deletes the entire `.aif` byte contract, the
   `drum_version` 1-vs-3 and `playmode` 8192-vs-16384 disagreement, the silent
   missing-APPL-chunk failure, the invisible `rejected/` folder, the 24 MB arithmetic and
   two reboots per attempt, by letting the device write its own file. It converts the only
   WRITES-TO-DEVICE item on the README opportunity list into a read-only one.
2. **Cyclostationary ground-truth source** — the only entry aimed at the researcher rather
   than the musician. Typed-in exact alpha, LFO ladder endpoints matching `cyclic.js`'s own
   MIN_ALPHA_HZ 0.5 / DEFAULT_ALPHA_MAX_HZ 30 band, read-only, one afternoon.
3. **Identity round-trip harness** — the honest measure of whether the `.opz` format is
   understood, and the gate every writer idea must pass. Never leaves the laptop.
4. **`.opz` -> MIDI export** — the single largest drudgery removal: a sketch leaves the
   device as editable notes instead of a stereo bounce. Strictly better than `underbridge`.
5. **Raw external input into Yellowjacket over USB audio** — if the raw-monitor path
   reaches the master bus, the 12 s capture ceiling stops mattering entirely. Two-minute
   read-only test; large payoff; correctly framed as a hypothesis.

## The ones to close

- **Sysex pattern injection** — `$09` undecoded seven years on, only implementation is
  non-commercially licensed with no write path, needs a 1 Hz heartbeat, Chrome gates it
  behind a stronger permission, and a live memory write has no "delete the file" recovery.
  The survey's own "keep it closed" is correct; CONTRACT-WIRE's exclusion stands.
- **Firmware anything** — AES envelope, key in the device, product discontinued, payload
  contains the bootloader, and a named forum reporter (Erlik_Khan, op-forums #16062) has a
  unit that stopped booting after an update with no fix posted. Ian is already on 1.2.45,
  the last release. There is nothing to gain.
- **`.opz` steganography** — auto-save is on by default and the device rewrites projects,
  so the payload is not even stable; "unidentified" bytes are not "unused" bytes; and
  `rejected/` does not apply to projects. Worst risk-to-reward in the survey.
- **Module-bay pinout recovery** — probing a live bay on a discontinued, unrepairable,
  unobtainable device. Survey value only, as the entry itself says.
- **Sampler-as-data-carrier, OP-Z-as-measurement-instrument, CC-as-data-channel** — all
  three are correctly self-rated TOY, and their own arithmetic is the refutation (~293 bit/s
  against ~2.8e8 bits per disk mount; uncalibrated mic with no published spec anywhere;
  ~1.5 kbit/s at 1.35 ms quantisation). Credit for killing them in the same breath as
  raising them.

## Honesty audit of the survey itself

Good: the DOCUMENTED / REVERSE-ENGINEERED / MEASURED / ARCH / SPECULATIVE labelling is
applied consistently and mostly correctly; negative results are recorded rather than
buried; several entries argue against themselves; the format-lens entries carry real
verification counts (15/15 files, 3,840 track chunks, 3,625 of 3,657 notes) rather than
adjectives.

Bad: one entry (the silicon BLE one) claims novelty that its own sibling entry disproves;
one entry (general.json) invents a hazard TE's documentation contradicts; the DMX ceiling
is stated honestly exactly once and softened everywhere else; and no entry composes the
survey's own Art-Net adapter finding with its own Art-Net-dependent bridge finding.
