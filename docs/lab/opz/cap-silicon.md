# cap-silicon — the hardware underneath the OP-Z, and what it could do that the firmware does not

Survey only. **Nothing here was written to Ian's device and nothing here proposes writing
to it.** Where a capability would require modifying the unit — firmware, config files, or
physical hardware — it is marked and the risk is stated.

Companion to `README.md` (instrument + formats), `midi.md`, `formats.md`, `community.md`,
`gaps.md`, and `device-scan.md` (read-only scan of Ian's unit, 2026-09-03). Facts already
established there are cited, not re-derived.

## Evidence tags

| tag | meaning |
|---|---|
| **DOC** | Teenage Engineering says so, in their own published material |
| **FCC** | In the public certification file for FCC ID `Z23012A` — a third party (SGS) measured it and TE signed off |
| **RE** | Someone demonstrated it and is named |
| **PHOTO** | Read by me directly off the FCC internal photographs (method in §1.2) |
| **ARCH** | Follows from hardware/protocol facts but is unproven on this device |
| **SPEC** | Speculation. Said plainly. |
| **MEAS** | Measured on Ian's Mac against Ian's OP-Z in an earlier pass (`README.md`, `device-scan.md`) |
| **UNK** | Nobody has published it and it was not measured |

---

# 1. The primary sources, and what they do and do not contain

## 1.1 The FCC filing

**FCC ID `Z23012A`** — Teenage Engineering AB, Virkesvägen 3A, Stockholm.
Filed 2018-11-08, i.e. six weeks before the product shipped.
<https://fccid.io/Z23012A>

- EUT name **"Portable Musical Instrument"**, model **`TE012AS001`**, trade mark OP-Z. [FCC]
- Test lab: SGS-CSTC Shenzhen, report **`SZEM180300231602`**, 53 pp., tested 2018-09-25→29,
  issued 2018-09-30, under **47 CFR Part 15 Subpart C §15.247**. [FCC]
- Contract manufacturer named in the report: **S&O Electronics (M) Sdn. Bhd., Lot 202,
  Bakar Arang Industrial Estate, Sungai Petani, Kedah, Malaysia.** [FCC] TE does not
  publish this anywhere.

**What the filing withholds.** Three exhibits exist as metadata only and are covered by
the confidentiality letter: **block diagram, schematics, operational description.** Those
are exactly the three documents that would answer most of the questions below. They are
permanently confidential; there is no route to them. [FCC]

## 1.2 Method for the internal photographs

The internal-photos exhibit is a 7-page PDF (2.2 MB, RC4-protected against copy, prints
fine). I extracted the embedded JPEGs: **11 unique photographs at 1048 × 698 px, 200 ppi**,
each of a component laid on a steel rule so absolute sizes are readable. I upscaled and
sharpened crops to read silkscreen.

**Honest limit: the 200 ppi is not enough to read chip part numbers.** A 7 mm BGA occupies
about 70 px. Package outlines, logos, silkscreen and connector pin counts are readable;
laser-etched part numbers are not. Do not treat any part number below as read — none was.

**Board inventory** [PHOTO]:

| photo | part | size | markings |
|---|---|---|---|
| p-001 / p-002 | keyboard flex PCB, front and back — runs the full width | ~200 mm | — |
| p-004 | the assembled plastic frame with both logic boards and shields fitted | ~215 mm | — |
| p-005 / p-007 | **DSP board**, top and bottom | ~40 × 25 mm | `OP-Z DSP BOARD REV: 5`, `PCB: 175-00004`, PCBA `830-000 2x` |
| p-008 | **encoder board** | ~75 mm long, L-shaped | `OP-Z ENCODER PCBA REV: 5`, `PCB: 175-00011`, `PCBA: 830-00020` |
| p-010 | a plain black plate — shield/stiffener | ~85 mm | — |
| p-011 | **module**, assembled, in its yellow shell | ~35 × 40 mm | four 3.5 mm jacks on one edge |
| p-013 / p-014 / p-016 | module PCB in and out of the shell, both faces | — | `Rev 3`, assembly `830-00018` |

The forum teardown (op-forums #20546, "OP-Z tear down") independently describes the same
topology: two logic boards joined by flex, processor board right, encoder board left,
keyboard permanently riveted to the shell. It contains **no part numbers at all**. [RE]

---

# 2. Compute

## 2.1 What TE publishes

Verbatim from TE's own OP-Z product page specification list [DOC,
<https://teenage.engineering/products/op-z>]:

- "analog devices blackfin 70X dsp"
- "cirrus logic audio co-processor"
- "1250 mmacs"
- "48kHz 24-bit dac"
- "115 dB dynamic range"
- "6 axis motion sensor"
- "integrated mems microphone"

This is the only public statement of the OP-Z's silicon and it is TE's own. It is also the
first time in this research programme that a hardware claim has a documented source rather
than a forum guess.

## 2.2 What "blackfin 70X" implies

The **Analog Devices ADSP-BF70x** family (Blackfin+ core) has published specifications
[DOC, Analog Devices]:

| property | ADSP-BF70x |
|---|---|
| core | Blackfin+, **up to 400 MHz**, dual 16-bit or single 32-bit MAC per cycle |
| ADI's headline figure | **800 MMACS** at <100 mW |
| L1 SRAM | 136 KB (64 I + 64 D + 8 scratch), parity-protected |
| L2 SRAM | **up to 1 MB on-chip, ECC-protected** |
| external memory | **SMC** (two banks, async SRAM/flash) **and DMC** — 16-bit DDR2 / LPDDR up to 200 MHz, *CSP-BGA packages only* |
| USB | **USB 2.0 HS OTG** |
| audio | 2 × SPORT with I²S |
| security | crypto accelerators, SPU/SMPU, **OTP memory, secure debug, secure boot** |
| secure boot ciphers | **AES-128 CBC** for confidentiality, **ECDSA-224** for authentication |

**Flag: TE's "1250 mmacs" exceeds ADI's own 800 MMACS headline for this family.** Three
readings, none confirmed: TE is quoting DSP + Cirrus co-processor together; TE is quoting a
peak figure ADI does not headline; or it is marketing arithmetic. Treat 1250 as a marketing
number, not an engineering one. [ARCH]

**The two flanking BGAs on the DSP board both carry what reads as the Micron logo**
[PHOTO — logo shape only, part numbers unreadable]. Given the BF70x has both an SMC and a
16-bit DDR2/LPDDR controller, and given the OP-Z runs a real filesystem (YAFFS2, §3), the
natural assignment is **one LPDDR/DDR2 SDRAM and one NAND flash**. That is an inference
from package count, vendor logo and SoC capability, not a reading. [ARCH]

The central device, which is the SoC, is **covered by a white serial label**
(`830-00210 / 1823 / 0216`) in the FCC photograph. It cannot be read even in principle from
this filing. [PHOTO]

## 2.3 The Cirrus co-processor

TE names it; nobody has identified the part. Cirrus Logic's relevant families are the CS47L
audio hubs (DSP + codec) and CS48L audio DSPs. **The specific part is UNK.** Do not guess it;
the "48 kHz 24-bit DAC, 115 dB dynamic range" line almost certainly describes this device's
converter, which matters in §4.

## 2.4 Internal bus names

The DSP board's board-to-board connectors are silkscreened, and the names are legible
[PHOTO]:

- **`PITCH`** — a ~12-way FFC, to the pressure-sensitive pitch-bend strip
- **`KEYS`** — a dense two-row board-to-board connector, to the keyboard flex
- **`HIGHWAY`** — a second dense two-row board-to-board connector
- a further FFC on the right edge, to the encoder board

**`HIGHWAY` is TE's own name for the OP-Z's internal main bus.** Everything that is not
keyboard or pitch strip — the long frame board, the I/O, and by elimination the module bay
— reaches the DSP board over it. This is the single most useful architectural fact in the
photographs and it does not appear anywhere in TE's documentation.

## 2.5 There is no Bluetooth on a Blackfin

The BF70x has no radio. The FCC report gives the radio's **"internal source: 32 MHz"** — a
reference crystal for a transceiver, separate from anything the Blackfin needs. So the OP-Z
carries a **discrete single-mode BLE controller** with its own crystal and its own stack,
talking to the Blackfin over a serial link. [ARCH, forced by FCC + the SoC's feature list]

Which controller: **UNK.** I could not locate it in the photographs and I will not name a
vendor I cannot see. The consequence that matters: **BLE MIDI on the OP-Z crosses two
processors and an internal serial link before it reaches the sequencer**, which is a
sufficient explanation for why TE shipped "reduced ble midi jitter" as a fix in the final
firmware (1.2.45) rather than at launch. [ARCH]

---

# 3. Storage

Established elsewhere, restated because §9 depends on it:

- Internal filesystem is **YAFFS2** — a NAND-flash filesystem. Files whose names begin `~`
  are **de-duplication stubs**: one stored sample referenced from several packs.
  [RE, Z-PO Project, via `community.md` §6]
- Ian's unit presents a **34.6 MB** content-mode volume with a **24.0 MB sample budget**,
  13.2 MB used, and **38 of the 55 sample entries are zero-byte placeholders** standing in
  for factory content held internally. [MEAS, `device-scan.md`]
- The content-mode disk is **not the flash**. It is a view the device synthesises on entry
  and reconciles on eject — `import.log` shows it recalculating space, assigning slots, and
  "rebuilding plug definitions". [MEAS + DOC]

**Therefore the 24 MB sample budget is a firmware policy, not a physical ceiling.** [ARCH]
YAFFS2 exists to manage NAND; the smallest NAND part anyone would put in a 2018 product is
an order of magnitude larger than 24 MB, and the device additionally holds the factory
sample library, ten projects, five bounces and the firmware itself. Nothing in the public
record states the flash size. **UNK, and unreachable without firmware access.**

---

# 4. The audio path, and the gap that is actually interesting

| layer | rate / depth | source |
|---|---|---|
| DAC | **48 kHz, 24-bit**, 115 dB dynamic range | DOC, TE product page |
| USB audio device | **2-in / 2-out at exactly 44 100 Hz**, class-compliant | MEAS, `README.md` §0 |
| bounces (`bounces/*/bounce.wav`) | RIFF WAVE, PCM, stereo, **44 100 Hz, 16-bit** | MEAS, `device-scan.md` |
| drum patches (`samplepacks/**/*.aif`) | AIFF, mono, **44 100 Hz, 16-bit** | MEAS, `device-scan.md` |
| synth patches | same container, exactly 264 600 frames = **6.000 s at 44.1 kHz** | MEAS, `device-scan.md` |

**Every surface a user or a tool can touch is 44.1 kHz / 16-bit. The converter is specified
at 48 kHz / 24-bit.** The 44.1 kHz figure is not documented by TE anywhere — it was measured
on Ian's Mac — and the 48 kHz figure is documented by TE and contradicted by everything
measurable.

Two readings, and I cannot separate them from outside:

1. The engine runs at 44.1 kHz throughout and the converter is simply a part that also
   supports 48 kHz — i.e. the codec's spec sheet, not the OP-Z's. [ARCH, more likely]
2. The internal mix bus is deeper and/or faster than the file and USB formats, and the
   44.1/16 boundary is only at the edges. Note that **16-bit sample files do not imply a
   16-bit mix bus** — a 24-bit DAC fed from a 24-bit summing bus is normal, and 115 dB of
   dynamic range is not reachable through a 16-bit output stage. [ARCH]

**Either way, no firmware-exposed path runs above 44.1 kHz.** For Yellowjacket the operative
fact is the one already in the README: resample to exactly 44 100 Hz, always, and the USB
audio device will match bit-for-bit. There is no hidden high-rate mode to find, and no
ultrasonic capability here — the ceiling is 24 kHz of bandwidth at best. Anything above
that has to be recorded elsewhere.

---

# 5. The radio

Measured by SGS on the certified unit [FCC, report SZEM180300231602 §4.1 and §7.3]:

| property | value |
|---|---|
| Bluetooth version | **V4.0, BT single mode — Bluetooth LE** |
| modulation | GFSK |
| channels | **40** (i.e. 37 data + 3 advertising — plain BLE) |
| operating frequency | 2402–2480 MHz |
| receiver category | 2 |
| antenna | **chip antenna, 3.3 dBi** |
| reference oscillator | 32 MHz |
| peak conducted output, measured | **+2.13 to +2.51 dBm** across low/mid/high channels |
| FCC grant, conducted | **0.0018 W** (= +2.55 dBm) |

**Estimated EIRP ≈ +5.8 dBm (≈ 3.8 mW).** [ARCH, conducted power + antenna gain] That is a
desk-scale link, not a room-scale one. Expect metres, degrading fast through a body or a
laptop lid.

**Documented discrepancy worth recording.** TE's own 2018-09-17 press release lists
**"bluetooth 5.0 LE"** [DOC, `teenage.engineering/_img/5b9fbec2655b1900048d7378_original.pdf`].
The certification report describes the tested unit as **V4.0 single-mode LE** [FCC]. The
current product page says only "Bluetooth LE" [DOC]. Three possibilities: the controller
supports 5.0 and was certified in a 4.0 profile; marketing overstated; or the design changed
between press release and certification. **The certified unit is a 4.0 single-mode LE
device. Prefer the tested figure over the press release** — note also that the same press
release claims the OP-Z "weighs in at just 850g", which is off by roughly a factor of five,
so it is not a careful document.

## 5.1 Does BLE MIDI work as a general transport?

What is established:

- The OP-Z has a **physical pair button on the back**, and the TE app connects to it as a
  BLE device. [DOC, `/guides/op-z/app`]
- The final firmware's release note is **"reduced ble midi jitter"** — a shipped fix, which
  means TE thinks of the link as *BLE MIDI*, not as a private protocol. [DOC, changelog, via
  `community.md`]
- macOS pairs standard BLE-MIDI peripherals in **Audio MIDI Setup → MIDI Studio → Configure
  Bluetooth**, after which they appear as ordinary CoreMIDI ports. [DOC, Apple]
- Chrome's Web MIDI enumerates CoreMIDI ports. A BLE-paired peripheral is therefore visible
  to a browser page **with no cable and no extra software**. [ARCH]

What is not established: **that the OP-Z advertises the standard BLE MIDI GATT service**
(`03B80E5A-EDE8-4B33-A751-6CE34EC4C700`) rather than a TE-private service the app alone
understands. Nobody has published a confirmation either way, and I found no forum report of
someone driving a DAW from an OP-Z over Bluetooth. **UNK.**

**Cheap, read-only, zero-write test.** Open Audio MIDI Setup, Configure Bluetooth, press the
OP-Z's pair button, and look. If `OP-Z` appears and connects, it speaks standard BLE MIDI and
Yellowjacket can reach it wirelessly today with no code change — Web MIDI will just see
another port. If it does not appear, the link is private to TE's app and BLE is a dead end
for us. This changes nothing on the device.

**The standing exclusion of BLE from CONTRACT-WIRE still looks correct for the clock path.**
BLE MIDI is packet-timestamped and bursty; TE had to ship a jitter fix; and a +5.8 dBm link
is not something to hang a sequencer clock on. The honest position is: BLE is plausible as a
*control* transport (patch pokes, CC nudges, a wireless keyboard), never as a *clock*
transport.

---

# 6. Power and the power path

| fact | value | source |
|---|---|---|
| cell | **Li-ion, 3.7 V, 740 mAh, 2.74 Wh** | FCC §4.1; DOC product page ("user replaceable Li-Ion 740 mAh") |
| physical size (community measurement) | 65 × 31 × 5 mm, proprietary contacts | RE, op-forums #20575 |
| TE service part | **110-00003**, sold by TE and via iFixit | DOC |
| charge input | **"supplied by DC 5V Type-C port"** | FCC §4.1 |
| bundled cable | **USB-C to USB-A** | DOC, press release |
| stated life | **6 hours play, 1 year stand-by** | DOC product page |
| charge indication | motion LED blinks green charging, solid green when full (unit off); battery level on track LEDs 1–16 via hold-screen | DOC hardware overview |
| USB host output budget | **max 100 mA** | DOC, via `README.md` §2.1 |

**No USB Power Delivery.** The FCC report describes the input as a flat 5 V and the shipped
cable is C-to-A, which cannot negotiate PD at all. The USB-C connector here is a connector,
not a PD sink. [ARCH, forced by both facts]

**Charging while running is supported and is audibly dirty.** TE documents a setting to
*disable USB charging "to reduce noise"* [DOC, hardware overview]. That is TE conceding that
the charge path couples into the analogue path. Directly relevant to Yellowjacket: a long
bench session with the OP-Z plugged into the Mac is a *charging* session, and if Ian is
listening critically or capturing over USB audio he should expect the charger to be in the
signal. Turning that setting off costs battery, not fidelity.

**The 100 mA USB-host budget is a battery-path limit, not a protocol limit.** A USB 2.0 host
would normally offer 500 mA; the OP-Z offers a fifth of that because VBUS has to be boosted
from a 3.7 V 740 mAh cell. This is why TE's compatibility note says the oplab "needs power"
when hosted over USB. [ARCH]

**Running with no battery: reported not to work.** One forum account reports a unit with a
dead cell "doesn't turn on" even on USB. [RE, single account, op-forums #20575 — low
confidence, plausible given the boost converter would have no source to start from.] Do not
plan around USB-only operation.

---

# 7. The module bay

This is the most under-documented part of the machine, and the FCC photographs are the best
public evidence that exists.

## 7.1 What is physically there

The certified unit shipped with a module fitted. From p-011 / p-013 / p-014 / p-016 [PHOTO]:

- A yellow shell about **35 × 40 mm**, with **four 3.5 mm jack sockets** protruding from one
  edge. This matches TE's own description of the OP-Z's back as **"four expansion ports, for
  use with a physical hardware module"** [DOC, hardware overview] — the four ports are the
  module's own sockets, not sockets on the OP-Z.
- The module PCB is marked **`Rev 3`**, assembly **`830-00018`**.
- It mates through **two blocks of spring-loaded pogo pins on the module**, meaning the
  OP-Z side is flat landing pads:

  | block | arrangement | contacts |
  |---|---|---|
  | left | 2 rows × 3 | **6** |
  | right | 2 rows × 4 | **8** |
  | | | **14 total** |

  Plus separate flat round pads adjacent to each block, which read as test points rather
  than contacts. The two blocks are physically separated by ~15 mm with components between
  them, which is consistent with — but does not prove — a deliberate split between a
  power/analogue group and a digital group.

**14 contacts is the count. The pinout is UNK.** Nobody has published one. I searched for a
DIY or third-party OP-Z module and found none — not on Hackaday, not on GitHub, not on
op-forums. This is a genuinely unexplored surface.

Identification of the photographed module: it has four jacks, and the only four-jack TE
module is the **oplab ZM-1**, whose first release was announced for "later this year" in the
September 2018 press release. So the certified unit almost certainly carried an oplab
pre-production sample. [ARCH — the jack count fits and nothing else does; the line module
ZM-4 has three jacks.]

## 7.2 The bay carries a digital bus, not just analogue breakout

The decisive evidence is that **the oplab module has its own firmware**:

- `z_oplab_firmware_1_1_1.zfw`, released 2019-12-17. [DOC,
  <https://teenage.engineering/downloads/op-z/oplab-module>]
- It is flashed **through the OP-Z**: upgrade mode, drop the file in the disk root, eject.
  Not over any port on the module itself.
- TE's warning: **"The OP-Z and module firmwares cannot be upgraded at the same time."**
- The 1.1.1 notes cite a *"rewritten communication protocol"* for MIDI reliability and
  *"reduced power draw"*.

From that: the module contains its own microcontroller with its own bootloader; the bay
carries **power, a bidirectional data link, and enough of a programming path to reflash a
downstream MCU**; and TE calls the OP-Z↔module link a "communication protocol" they can
rewrite. [ARCH, forced by the update mechanism]

Supporting electrical facts from TE's module guides [DOC]:

| signal | range |
|---|---|
| oplab CV 1 out | 0 to +5 V |
| oplab CV 2/3 out | −5 to +5 V |
| gate out | 0 / +5 V |
| MIDI out, trig out, PO out | 0 to +5 V (PO out on the line module: 0 to +3.3 V) |
| MIDI in, trig in | **−10 to +10 V tolerant** |
| line module out / in | 2.2 dBu (2.8 Vpp), in tolerating up to 13.2 dBu (10 Vpp) |

Two things follow. First, the module generates **±5 V rails locally** — the OP-Z runs off a
3.7 V cell, so the module is doing its own boost/inversion, which means the bay supplies a
raw rail and the module conditions it. Second, the **line module carries analogue audio in
and out at line level**, so the bay must also carry an analogue audio path (or the module
digitises and returns audio over the digital link — undetermined). [ARCH]

TE's standing warning, which applies to anything plugged into a module: **"never feed
phantom power into OP-Z as this will damage the electronics."** [DOC]

## 7.3 Could a custom module exist?

**Physically, yes; practically, no, and not without hardware Ian does not have.** [ARCH]

What would be required: a mechanical clone of the shell and pogo footprint; a pinout
recovered by probing a live bay; the OP-Z↔module protocol, which is undocumented and was
rewritten at least once; and a module-side bootloader that accepts a TE-format `.zfw`, which
is encrypted (§8). Every one of those is unsolved in public.

**Risk if attempted: high.** Probing an unpowered bay with a multimeter is survivable;
probing a live one, or presenting the wrong voltage on an unknown pin, puts a discontinued,
unrepairable, unobtainable device at risk. **Out of scope for a survey. Recommend not
touching it.**

---

# 8. Firmware: distribution, encryption, and the bricking risk

## 8.1 Distribution

- **17 releases**, 1.1.12 (2018-11-13) through **1.2.45 (2022-03-31)**, all still listed and
  downloadable. [DOC, <https://teenage.engineering/downloads/op-z>] Ian's unit is on 1.2.45
  [MEAS] — the last one. The target is frozen.
- Update procedure: hold **screen** while powering on (upgrade mode), drop
  `z_firmware_<a>_<b>_<c>.zfw` in the root of the disk, eject, wait. Done when the four dial
  LEDs are green. TE's instructions say to back up first and not to power off during the
  write. [DOC]

## 8.2 Encryption — a hard wall, and it is not the SoC's secure boot

Established by `ioma8/opz-firmware-notes` (2025-10), already summarised in `community.md` §6:
`z_firmware_1_2_45.zfw` is 1 491 600 bytes, AES-CBC, entropy 7.9998 bits/byte, header
carrying an **AES IV at 0x70 and a key *index* — not a key** — and an encrypted filename at
0x300 that decrypts to **`firmware_bin_only_with_bootloader.zip`**. Every recovery attempt
(XOR against known ZIP headers; CTR/CBC/CFB/OFB/ECB trials) produced noise. [RE]

**A new observation from this pass.** ioma8 concludes AES-**256**. The BF70x's *secure boot
ROM* is specified for AES-**128** CBC with ECDSA-224 [DOC, Analog Devices EE-366]. Those do
not match. The reading that reconciles them: the `.zfw` wrapper is **a TE application-layer
envelope decrypted by the already-running firmware or bootloader**, not the SoC's boot
format — which is exactly what you would expect for an update file that arrives over USB
mass storage rather than from the boot flash. Either way the key is inside the device, in
OTP or in a binary nobody can read. [ARCH]

**Consequence, stated plainly: custom OP-Z firmware is off the table.** There is no OP-Z
equivalent of `op1repacker`, there will not be one, the product is discontinued, and the key
will not be published. Anyone who claims otherwise is describing the OP-1.

## 8.3 Bricking risk — say this out loud

**The decrypted payload is named `firmware_bin_only_with_bootloader.zip`.** The update ships
the bootloader. An update that is interrupted while the bootloader region is being written
is the classic unrecoverable case: the part that would let you retry is the part that was
mid-erase.

The public record contains at least one user whose unit stopped booting after a firmware
update and content-mode eject: `trig 1` blinking white, encoders white, would only re-enter
upgrade mode, samples gone, no resolution posted in the thread. [RE, op-forums
"Tried to update Firmware, now my OP Z is basically a brick" #16062 — reporter Erlik_Khan;
one respondent suggested pressing play instead of ejecting; no confirmed fix.]

**Practical position for this project:**

- Ian's unit is already on the final firmware. **There is nothing to gain from a firmware
  operation and a discontinued, unobtainable device to lose.**
- Do not install firmware. Do not install module firmware.
- The dangerous window in *ordinary* use is not the firmware update — it is the **eject**,
  because import runs on eject and the device resynchronises and restarts itself. Every
  content-mode write costs two reboots through that window. That is already the standing
  guidance in `README.md` §3.1 and this lens does not soften it.

---

# 9. Capability inventory — hardware that the firmware does not expose

Ranked by how real the gap is.

### 9.1 A 24-bit / 48 kHz converter behind a 44.1 kHz / 16-bit wall
TE documents a 48 kHz 24-bit DAC at 115 dB. The USB audio device is 44 100 Hz [MEAS]; every
file format on the disk is 44.1/16 [MEAS]. **Unreachable — the gate is firmware and firmware
is closed.** Practical effect on Yellowjacket: none, except to settle that there is no hidden
high-rate mode worth hunting. Resample to exactly 44 100 Hz and stop looking.

### 9.2 More flash than the 24 MB budget admits
YAFFS2 + de-duplication stubs + a synthesised content view mean the 24 MB sample budget is a
policy number. The real NAND size is UNK but is certainly larger. **Unreachable without
firmware.** What *is* reachable, and is already in `device-scan.md`, is the finding that
**38 of the 55 occupied slots are zero-byte placeholders** — roughly 10.8 MB of the 24 MB is
free right now and "full" slots can be displaced without displacing any real file. That is a
policy gap Yellowjacket can exploit today with no modification at all.

### 9.3 A 6-axis IMU whose data never reaches a wire
Documented on board [DOC]. Exposed on the device as the **`gyro` LFO shape** and as
tilt-to-engage-mic [DOC, `input-selection` 18.4]. **There is no motion row anywhere in TE's
MIDI CC table** — motion cannot leave the device as MIDI, so Yellowjacket can never see it.
The app is the only consumer. Unreachable without firmware.

### 9.4 A settings surface with no front-panel control
`config/general.json` carries ten booleans, several with no UI [MEAS, `device-scan.md`],
including **`disable_headphone_db_reduction`** — i.e. the firmware attenuates headphone
output by default and the un-gate is a boolean in an editable JSON file. Also
`backlit_keys`, `generous_chords`, `disable_start_sound`, `disable_track_preview`,
`legacy_input_select`, `disable_microphone_mode`, `disable_param_page_reset`,
`latch_notes_with_shift`, `temp_param_add_fx_a`.
**This one is genuinely reachable** — TE's own content-mode permission table allows config
to be *modified* (not added or removed). **But it is a write to the device**, which is out of
scope by Ian's instruction, and defeating a headphone limiter carries a real hearing-damage
risk on top of the eject-cycle risk. Survey only; flagged, not recommended.

### 9.5 A module bay that is a digital bus with an unpublished pinout
14 pogo contacts in 2+ blocks [PHOTO, measured here]; modules carry their own MCU and their
own reflashable firmware [DOC]. A custom module is architecturally possible and practically
unreachable: no pinout, no protocol, encrypted module firmware, and a device that cannot be
replaced if it dies. **High risk. Do not probe.**

### 9.6 BLE MIDI as a cable-free transport into the browser
The radio is a plain 40-channel BLE 4.0 single-mode part; TE ships a pair button and fixed
"BLE MIDI jitter" in firmware; macOS turns a standard BLE-MIDI peripheral into an ordinary
CoreMIDI port; Chrome's Web MIDI sees CoreMIDI ports. If the OP-Z advertises the standard
BLE MIDI GATT service, **Yellowjacket already supports it and nobody has noticed** — no code,
no cable, no modification. **Untested. One read-only look in Audio MIDI Setup settles it.**
Constraints even if it works: ~+5.8 dBm EIRP (desk range) and packet jitter that TE
themselves had to reduce — control transport, never clock transport.

### 9.7 USB host mode, already exposed
Worth recording as *not* a gap. The BF70x's USB 2.0 HS OTG is used: TE documents the OP-Z
hosting an OP-1, an oplab, a Korg microKEY Air 25, a Kingston hub and an Enttec DMXUSB Pro
[DOC, via `README.md` §2.1]. **The binding constraint is the 100 mA supply**, which is a
battery/boost limit rather than a USB one. Devices presenting as more than one MIDI device
are not supported.

---

# 10. Dead ends — do not spend time here again

1. **Chip part numbers are not in the FCC filing.** 200 ppi photographs; the SoC is under a
   serial label. Only a physical teardown with a macro lens would read them, and the
   keyboard is riveted to the shell such that disassembly damages it [RE, op-forums #20546].
   Not worth it.
2. **The block diagram, schematics and operational description are permanently
   confidential** in the FCC filing. There is no route to them.
3. **The firmware AES key is not recoverable.** ioma8 already exhausted the cheap attacks.
   Product discontinued; key never published.
4. **There is no published OP-Z module pinout and no DIY module project.** Searched
   Hackaday, GitHub, op-forums, and general web. Nothing exists.
5. **The op-forums teardown thread contains no part numbers.** It is photographs and
   mechanical observations only.
6. **`apps.fcc.gov` attachment URLs return 403** to automated fetches; `fccid.io` mirrors the
   same PDFs and serves them.
7. **The press release is not a reliable spec source** — it claims Bluetooth 5.0 against a
   4.0 certification, and an 850 g weight for a ~200 g instrument.

---

# 11. Open questions, in the order they are cheap to answer

| # | question | cost | writes to device? |
|---|---|---|---|
| 1 | Does `OP-Z` appear in **Audio MIDI Setup → Configure Bluetooth** after pressing the pair button? Settles §9.6 outright. | 60 seconds | **no** |
| 2 | If it pairs: does the BLE port appear in Chrome's Web MIDI alongside the USB port, and what is the round-trip jitter versus USB? | one bench run | **no** |
| 3 | Does the USB audio device advertise any alternate setting other than 44 100 Hz? Read the audio-class descriptors (`system_profiler SPUSBDataType`, or a descriptor dump) with the OP-Z attached. Settles §4 reading (1) vs (2) at the USB boundary. | minutes | **no** |
| 4 | What is on the **`HIGHWAY`** connector? Unanswerable without a teardown. Leave it. | — | — |
| 5 | Module bay pinout. **Leave it.** Risk far exceeds value for a device that cannot be replaced. | — | — |

---

# 12. Sources

**Primary — certification**
- FCC ID Z23012A filing index — <https://fccid.io/Z23012A>
- Test report SGS-CSTC `SZEM180300231602`, 53 pp. — <https://fccid.io/Z23012A/Test-Report/Test-report-4064312>
- Internal photos, 7 pp. — <https://fccid.io/Z23012A/Internal-Photos/Internal-Photos-4064340>

**Primary — Teenage Engineering**
- Product specifications — <https://teenage.engineering/products/op-z>
- Hardware overview — <https://teenage.engineering/guides/op-z/hardware-overview>
- App / Bluetooth pairing — <https://teenage.engineering/guides/op-z/app>
- oplab module guide — <https://teenage.engineering/guides/op-z/modules/oplab>
- line module guide — <https://teenage.engineering/guides/op-z/modules/line>
- OP-Z firmware downloads (17 releases) — <https://teenage.engineering/downloads/op-z>
- oplab module firmware — <https://teenage.engineering/downloads/op-z/oplab-module>
- Press release, 2018-09-17 — <https://teenage.engineering/_img/5b9fbec2655b1900048d7378_original.pdf>
- Battery replacement part — <https://support.teenage.engineering/hc/en-us/articles/360023671533>

**Primary — Analog Devices**
- ADSP-BF70x series — <https://www.analog.com/en/lp/001/adsp-bf70xseries.html>
- EE-366, Secure Booting Guide for ADSP-BF70x — <https://www.analog.com/media/en/technical-documentation/application-notes/EE-366.pdf>

**Reverse engineering and community**
- `ioma8/opz-firmware-notes` — <https://github.com/ioma8/opz-firmware-notes>
- op-forums teardown #20546 — <https://op-forums.com/t/op-z-tear-down/20546>
- op-forums bricked-after-update #16062 — <https://op-forums.com/t/tried-to-update-firmware-now-my-op-z-is-basically-a-brick/16062>
- op-forums replacement battery #20575 — <https://op-forums.com/t/has-anyone-ever-found-a-suitable-op-z-replacement-battery/20575>
- iFixit OP-Z expansion module replacement — <https://www.ifixit.com/Guide/Teenage+Engineering+OP-Z+Expansion+Module+Replacement/129167>
- Apple, Bluetooth MIDI in Audio MIDI Setup — <https://support.apple.com/guide/audio-midi-setup/ams33f013765/mac>
