# Practitioner scoring pass — 53 OP-Z capability candidates

Scored 2026-09-04 from the perspective of someone who makes music and records in
the field and would have to live with each of these. Grounding read, not
re-derived: `README.md`, `device-scan.md`, and the five lens files in this
directory. Nothing was written to the device by this pass; the device was not
touched at all.

`useful` is weighted hard by **would I reach for this more than once**. Anything
that is a single impressive gesture and then never opened again is scored down
regardless of how well sourced it is.

## The seven I would actually live with

| # | candidate | why it survives |
|---|---|---|
| 33 | USB audio 2-in/2-out at exactly 44 100 Hz | every session, no cable, no ADC, no resample |
| 35 | MIDI clock master/slave | every jam; the measured bimodal clock is already characterised |
| 21 | Project inspector | the device has no display and no naming — "what is in project07" is a daily question |
| 23 | `.opz` → MIDI export | the workflow every OP-Z owner wants, nobody has built, and every field it needs is verified |
| 40 | C3 digital sampling bridge | deletes the entire write path, the `drum_version` disagreement, and both reboots |
| 8 | charging-while-running is audibly dirty | acted on at the start of every bench session |
| 2 | 24 MB is policy, 38 of 55 slots are fictional | hit on every single kit import |

## Two problems in the candidate set itself

**#1 and #39 are the same capability, scored twice, and they disagree.** #1 says
the standard-GATT question is "untested" and that "nobody has noticed"; #39
cites op-forums 31340 (Jan 2026) where Kosta and Hopeeasy both confirm pairing
on current macOS via Audio MIDI Setup after Victory gave the route — and that
route only pairs peripherals advertising the standard BLE-MIDI service. #1's
confidence line is stale relative to `cap-systems.md` in this same directory.
Scored #39 higher on `real` accordingly. The remaining genuine unknown is
narrower than either states: whether Chrome's Web MIDI enumerates the paired
endpoint and under what CoreMIDI name (`README.md` §4.1 item 11).

**#3 is flagged `needsModification: true` for a capability it correctly argues
is unreachable.** There is nothing to modify; the metadata contradicts the body.

## Cluster gates that outrank individual scores

- **DMX (10, 11, 12, 13, 16, 20, 38, 43) — eight entries, one gate.** All of it
  needs an Enttec widget and a reason to care about lighting. #13 is the only
  member testable tonight with no hardware and no writes: send CC on channel 15
  and watch the on-device preview LEDs. Run that before scoring any of the other
  seven as actionable. #43 is the most honest of them — it corrects the
  "128 authored bytes" reading down to **eight** independent continuous values.
- **oplab (14, 15, 44) — one gate, and it is procurement.** ZM-1 is
  discontinued and whether Ian owns one is not recorded anywhere in this corpus.
  Establish that first; all three are capability-real and availability-blocked.
- **Project writing (28, 29, 30, 31, 32, 53).** #26 (identity round-trip) is the
  gate on all of them and is the correct thing to build first. #31 is honestly
  blocked by the opaque 32-bit plug ID; #32 and #53 should stay closed.

## Harshest calls, stated plainly

- **49 (measure the PRNG), 50 (sampler as data carrier), 52 (CC as a data
  channel), 51 (portable measurement instrument), 18 (videolab).** All work.
  All are done exactly once. #18 additionally costs an eight-year-old Unity
  toolchain to get MIDI transforms that are thirty lines of JS in the bench.
- **53 (steganography in `.opz`)** is the worst risk-to-reward item here: auto-save
  rewrites projects, there is no independent writer to cross-check against, and
  the benign `rejected/` recovery path covers samples, not projects.
- **5 (module-bay pinout)** and **9 (firmware)** are correctly self-flagged. Both
  put an unobtainable, unrepairable device at risk for nothing that improves a
  session. #9's payload contains the bootloader, so the recovery path is the
  thing being overwritten, and the unit is already on the last release.
- **4 (headphone limiter defeat)** is real and reachable and I still would not do
  it: a content write through the eject/import window, for a hearing-damage
  affordance. `backlit_keys` is the only thing in that file I would actually
  want, and it is a set-once change.

## Cheapest things that settle the most

1. #13 — CC on channel 15, watch the preview LEDs. No hardware, no writes.
   Settles #10 and #13 in one gesture.
2. #39 — pair over BLE, then look at the WIRE panel for the port name.
3. #46 — press shift+0 and see whether raw input appears in the USB audio stream.
   If it does, the 12 s ceiling stops being a monitoring ceiling.
4. #42 — set a known LFO rate at a typed BPM and read it back off the cyclic
   plane. Validates `js/analysis/cyclic.js` against a source with a typed-in alpha.
