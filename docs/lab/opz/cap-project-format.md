# Capability survey — the `.opz` project format and what a writer would unlock

**Lens:** how far reverse-engineering has actually got on the OP-Z project file, and what
generating projects programmatically would buy.
**Date:** 2026-09-04. **Status:** survey only. Nothing was written to the device.
**Method note:** the device was still mounted at `/Volumes/OP-Z`, so this lens did something
the earlier lenses could not — it **validated the published spec against Ian's own 15 project
files**, read-only. Files were copied to scratchpad once and all analysis ran on the copies.

Claim tags: **[DOC]** TE says so · **[RE]** someone demonstrated it, named · **[MEAS]** measured
here on Ian's device · **[ARCH]** follows from hardware/protocol facts, unproven ·
**[SPEC]** speculation, labelled as such.

---

## 0. The short version

The format is **more solved than the prior docs assume, and less writable than the one library
that claims to write it**.

1. The Z-PO byte map is **substantially correct** — I checked it field-by-field against 15 real
   files and every documented offset holds. [MEAS]
2. The Z-PO map is also **7 years and 2 firmware minor-versions stale** (written against
   1.1.17; current is 1.2.45), and the file has **changed since** in at least three ways I can
   demonstrate. [MEAS]
3. **`libopz` has a `saveAsOpz()` method and it is broken.** It writes the wrong magic number
   and the wrong length. I compiled its structs to confirm. There is, as of today, **no working
   `.opz` writer in existence**. [MEAS]
4. **TE explicitly sanctions replacing project files**, and documents the recovery path. This
   is a materially weaker risk story than `README.md` §"Do not build" assumes. [DOC]
5. The genuinely blocking unknown for a writer is **not the byte layout** — it is the
   **plug ID**, which for user samples is a 32-bit opaque identifier nobody has decoded.

---

## 1. State of the art — who has done what, and how stale it is

| Project | What it does | Last commit | Licence | Bearing on a writer |
|---|---|---|---|---|
| [lrk/z-po-project](https://github.com/lrk/z-po-project/wiki/Project-file-format) | **The** byte map. Header + pattern/track/note/step chunks | **2019-03-11** | — (wiki prose) | The spec everything else derives from. Against fw **1.1.17** |
| [patriciogonzalezvivo/libopz](https://github.com/patriciogonzalezvivo/libopz) | C++ parser + sysex telemetry. `loadOpz`, `saveAsTxt`, `saveAsOpz` | **2023-01-16** | Prosperity/Patron (**non-commercial**) | Only independent implementation. Its writer is broken (§4) |
| [hyphz/opzdoc](https://github.com/hyphz/opzdoc/wiki/MIDI-Protocol) (MarkRdgOx) | Sysex/MIDI protocol wiki | **2018-11-21** | none (all rights reserved) | Sysex `$09` pattern message is zlib'd; payload undecoded |
| [BKLronin/underbridge](https://github.com/BKLronin/underbridge) | Multitrack **audio** exporter | 2025-07-25 | GPL-3.0 | **Does not touch the format.** Mutes tracks over MIDI and records audio |
| [nbw/opz](https://github.com/nbw/opz) | MIDI *stream* parser | — | MIT | Live MIDI only, not files |

**The load-bearing observation:** the two repos that actually understand the file are dead
(2019 and 2023), and the only actively-maintained OP-Z tool in the ecosystem (underbridge)
deliberately routes around the format entirely — it reconstructs your song by muting tracks and
recording audio, which is what you do when you *cannot* read the project. [MEAS, repo metadata
read from the GitHub API 2026-09-04]

**Firmware gap.** Z-PO documented **1.1.17**. TE's current and final-listed release is
**1.2.45 (2022.03.31)**. [DOC, teenage.engineering/downloads/op-z] Nothing in the community has
re-validated the byte map against any 1.2.x firmware. This document is, as far as I can find,
the first time that has been done.

### 1.1 The OP-Z app does **not** read or write project files

The brief assumed TE's own client exercises the format. It does not. TE's app guide describes
the app as an external screen, a multi-touch controller, a 3D visualiser, and a **plug
configurator** whose "commit" *"transfer[s] to the OP-Z"* over BLE/USB — a live wire transfer of
slot configuration, not a project file. [DOC, TE OP-Z guide §23.1–23.5] There is no
project-file import/export anywhere in the app's documented surface. **Correct the premise:
the `.opz` file is exercised by exactly one piece of software, the device firmware itself.**

---

## 2. What is known — and now verified on Ian's device

Everything in this section was checked against the 14 files in `/Volumes/OP-Z/projects/` plus
`bounces/bounce01/project.opz`.

### 2.1 The header holds, exactly as documented

| Field | Z-PO says | Measured across 15 files |
|---|---|---|
| `0` u32 file ID | always `0x00000049` | **`0x49` in 15/15** ✅ |
| `516–519` mixer drum/synth/punch/master | u8 each | full 0–255 spread, plausible ✅ |
| `520` tempo | u8, **40–200** | observed **72, 88, 98, 104, 105, 120, 125, 128, 135, 151** — **15/15 inside 40–200** ✅ |
| `565` swing | u8 0–255 | 6–254 ✅ |
| `566/567` metronome level/sound | u8 | plausible ✅ |
| `568` u32 unknown | "mostly `0x000000FF`" | `ff000000` LE = **255** in 14/15; one file `0` ✅ |

The tempo result is the strongest single confirmation in this document. Fifteen independent
byte samples all landing inside a 161-wide window out of 256 is not what a misaligned offset
produces. [MEAS]

### 2.2 The pattern/track/note structure holds

- **Track chunk stride = 12 B, byte 5 ≈ `0x05`.** Z-PO flags byte 5 as *"seem to be 0x05,
  maybe some kind of timing"*. Measured across 3,840 track chunks: `0x05` dominates every file
  (254/256 in project01). ✅ [MEAS]
- **Step count at track-chunk byte 4.** Across all 3,840 samples: **min 1, max 16, never
  outside**. A wrong offset would show 0–255. ✅ [MEAS]
- **Note chunk = 8 B, velocity default 100, age always 0.** Measured: velocity is exactly 100
  in **3,625 of 3,657** real notes; the `age` byte is `0x00` in **211,200 of 211,200**. ✅ [MEAS]
- **55 notes per step, fixed per-track offsets.** `libopz` independently implements
  `getNoteIdOffset = step*55 + offset[track]` with the table
  `{0,2,4,6,8,12,16,24,28,29,30,31,35,41,47,51}` — byte-identical to the Z-PO allocation. Two
  independent sources agreeing is the best corroboration available. [RE ×2]
- **Step chunk = 54 B.** 61,272 of 61,440 step-component bitmasks are `0x0000`. Step components
  are *rare in real use* — only 168 steps across 15 projects use any. ✅ [MEAS]

---

## 3. Four things that are new here

These are not in the Z-PO wiki, not in `libopz`, and not in the existing Yellowjacket docs.

### 3.1 The file is **not** a fixed 342,848 bytes — there is a format version trailer

`README.md` §3.5 records the open question: real files measure 342,848 but the Z-PO table sums
to 342,844, and *"four bytes are unaccounted for."* **Resolved.** [MEAS]

Ian's device holds files of **both** sizes:

| Size | Files | Dates |
|---|---|---|
| 342,844 | `project05f.opz`, `bounces/bounce01/project.opz` | **Oct 2020** and earlier |
| 342,848 | the other 13 | **Dec 2021 – Jan 2025** |

Aligning the tails shows the newer files are byte-for-byte the older structure **plus four
appended bytes**: at offset 342,844, `07 00 00 00` = little-endian **u32 = 7**, identical in all
13. [MEAS]

```
572 + 16 × 21392 = 342844          ← Z-PO's total, and the OLD file size, exactly
342844 + 4       = 342848          ← every modern file
```

**INFERRED, high confidence:** this is a **project format version field**, value 7, appended by
a firmware revision between Oct 2020 and Dec 2021. TE's changelog puts three content-mode
releases squarely in that window — **1.2.38 (2021.06.03), 1.2.39 (2021.06.08) and 1.2.40
(2021.06.18)**, the last of which reads *"fix content mode bug that could cause corrupt samples
and patterns on import."* [DOC] The version field most plausibly arrived in that cluster.

*This is the single most important fact for a writer.* A generated file that omits the trailer
is a **format-version-6 file offered to firmware that stamps 7**.

### 3.2 An empty note slot is not zeroed — it has a specific 8-byte signature

Of 211,200 note slots, 207,543 are empty, and empty is encoded as:

```
00 0a 00 00   ff   64   00   00
duration=2560 note=0xFF vel=100 micro=0 age=0
```

**`note == 0xFF` is the empty marker** — Z-PO's table does not mention it at all, and its note
field is documented only as *"0-based value for C1"*. A writer that zero-fills unused note slots
is writing 880 notes of `note 0, velocity 0, duration 0` per pattern, not silence. [MEAS]

(A second empty variant, `duration=655360`, appears 1,984 times — [SPEC] a per-track default
for long-envelope tracks. Not investigated.)

### 3.3 Micro-timing is stored at 4× the documented resolution

Z-PO: micro adjustment is an `int8`, range **−23…+24 ticks**. Measured on real notes: range
**−96…+94**, clustering hard on **multiples of 8** (0, ±8, ±16, ±32). [MEAS]

−96/4 = −24 and +94/4 ≈ +23.5, i.e. the byte stores the documented UI range **multiplied by
about 4**. TE's changelog for **1.2.26 (2020.03.27)** reads *"micro timing resolution
enhancement for extended tracks"* [DOC] — an independent, dated explanation for exactly this.
**INFERRED, high confidence: the field was rescaled after Z-PO documented it.** A writer using
the published −23…+24 range would place notes at a quarter of the intended offset.

### 3.4 Plug IDs are bimodal — and the large ones are the writer's real blocker

Across all 3,840 track chunks: **49 distinct small IDs (0–151)**, matching the RE'd engine/plug
enumeration, **plus 22 distinct large 32-bit values**. [MEAS]

```
2615249010  0x9be18872   kick track,  in 9 different projects
3630199931  0xd860747b   lead/chord,  in 5 projects
 487375616  0x1d0cc300   lead track,  in 5 projects
```

These are **stable across projects** — the same value recurs on the same track role in nine
separate files — so they are identifiers, not noise. [MEAS]

**INFERRED:** factory engines are referenced by a small enum; **user sample plugs are referenced
by an opaque 32-bit identifier**, plausibly a content or name hash the firmware derives at
import. [SPEC as to the derivation — nobody has decoded it, and I did not attempt to.]

**Consequence, and it is the hard one:** a program can freely author *notes, steps, tempo,
pattern chains, mutes and sound parameters*. It **cannot invent a reference to one of Ian's own
samples.** It can only copy a plug ID out of an existing project. This is a much sharper
constraint than "48 bytes remain unknown" suggests, and it is not mentioned in any source I found.

---

## 4. `libopz`'s writer does not work — verified by compilation

This corrects `community.md` §4 ("no write path") in one direction and refutes the library's own
roadmap in the other. `saveAsOpz` **exists**:

```cpp
bool opz_project::saveAsOpz(const std::string& _filename){
    std::ofstream out_file(_filename,std::ofstream::binary);
    char header[] = {0x00, 0x00, 0x00, 0x00};
    out_file.write(header, 4);
    out_file.write((char*)&m_project, sizeof(opz_project));
    out_file.close();
    return true;
}
```

Two defects, both fatal:

1. **Wrong magic.** It writes `00 00 00 00` where every real file has `49 00 00 00`. The one
   field Z-PO calls *"always the same number"* is the one field this gets wrong.
2. **Wrong length.** It takes the address of `m_project` (type `opz_project_data`) but the size
   of `opz_project` — the enclosing **class**, which has virtual methods and therefore a vtable
   pointer. I compiled the struct definitions to check rather than assume:

```
opz_project_data    = 342840   (+4 file id = 342844)
class opz_project   = 342848   <- what saveAsOpz passes as the WRITE LENGTH
saveAsOpz file size = 4 + 342848 = 342852
overread past m_project = 8 bytes
```

The emitted file is **342,852 bytes** — neither 342,844 nor 342,848 — with 8 bytes of adjacent
heap on the end. [MEAS, `clang++ -std=c++11`]

**`loadOpz` has the mirror bug**, and modern files trigger it:

```cpp
memcpy( (char*)&m_project, &buffer[4], sizeof(char) * size );
```

With a 342,848-byte input it reads `buffer[4 … 342852]` — **4 bytes past the allocation** — and
writes 342,848 bytes into a 342,840-byte member — **8 bytes of heap overflow**. Reading one of
Ian's current project files with `libopz` is undefined behaviour. [MEAS]

The 342,848 coincidence is why this was never caught: `sizeof(class opz_project)` accidentally
equals the modern file size, for entirely unrelated reasons (vtable + alignment).

**So: nothing in the wild writes a valid `.opz`.** A writer would be first, not a port.

---

## 5. What a **reader** unlocks — available today, zero device risk

Everything here runs on a file copied off the disk. No writes, no eject, no firmware contact.

- **Project inspector.** Tempo, swing, mixer levels, per-pattern track config, step counts,
  every note, mutes, pattern chains. All verified above. **Works now.**
- **Diff two projects and get named fields back.** I built and ran this. Diffing a project
  against its own snapshot maps every changed byte to a semantic location:

  ```
  project03.opz vs project03f.opz: 603 differing bytes, 98 runs
       484-500   HEADER+484            (pattern chain 15)
       516-520   HEADER+516            (mixer + tempo)
       594       pat0/track_params (track 1, field 10)
       861-882   pat0/notes note#12
  ```
  [MEAS] This is the **entire decoding methodology for the remaining unknowns, and it requires
  no writing at all**: change one thing on the device, snapshot, diff, and the changed offset
  names itself. The 44 unknown header bytes at 521 and the residual step-component semantics
  are all reachable this way.
- **`.opz` → MIDI export.** Notes carry pitch, velocity, duration, micro-timing; tracks carry
  step count and length; the header carries tempo. Everything a MIDI file needs is present.
  **Architecturally straightforward.** This is strictly better than underbridge's approach
  (which records audio because it cannot read the file) and it is what would let Ian get an
  OP-Z sketch into a DAW as *notes* rather than as a stereo bounce.
- **Version control and archival.** Ten projects × 342 KB. Commit the directory; `git diff`
  becomes meaningful the moment the diff tool above exists. The device has **one** snapshot slot
  per project and *"any previous snapshot will be overwritten"* [DOC] — so the device's own
  undo is depth-1. A git-backed history is a real capability gain over the hardware.
- **Bounce pairing.** Every bounce ships with `project.opz` alongside `bounce.wav` [DOC/MEAS] —
  so each of the 5 bounces is a *rendered audio file plus the exact project state that made it*.
  That is a labelled dataset for free.

---

## 6. What a **writer** would unlock

Ordered by (value ÷ risk), and honest about which are blocked.

| # | Capability | Blocked on? |
|---|---|---|
| 1 | **Round-trip: read → edit → write back.** Change tempo, swing, mutes, mixer levels, step counts, note data | Nothing structural. All fields verified |
| 2 | **MIDI file → OP-Z pattern.** Import a DAW/notation phrase into a pattern | Nothing structural. Note chunk fully understood |
| 3 | **Algorithmic composition off-device.** Euclidean rhythms, generative variations, transposed/retrograde copies of an existing pattern | Nothing structural |
| 4 | **Diff/merge/variation generation.** Fork a project, mutate a pattern, keep both | Nothing structural |
| 5 | **Full DAW round-trip** (project → MIDI → DAW → MIDI → project) | Nothing structural for notes; **§3.4 for sounds** |
| 6 | **Author a project from scratch that uses Ian's own samples** | **BLOCKED — §3.4.** Cannot synthesise a user-sample plug ID |

The pattern in that table is the useful finding: **note-level and arrangement-level authoring is
unblocked; sound-assignment authoring is blocked.** The workaround is exact and cheap — set up
the plugs by hand on the device once, save the project, and thereafter treat that file as a
**template whose track chunks you never touch** and whose note/step arrays you rewrite freely.
That single move converts capability 6 from blocked to available, and it is how I would build
this. [ARCH]

**Why the target is unusually stable for a writer.** TE's last OP-Z firmware is **1.2.45,
dated 2022.03.31** — over four years old. [DOC] A format that has not moved in four years and
has no maintainer shipping changes is about as safe a reverse-engineering target as exists.
The usual argument against investing in an RE'd format (it will change under you) does not
apply here.

---

## 7. Risk — stated honestly

### 7.1 The risk is lower than the existing docs assume

`README.md` §"Do not build" says an `.opz` writer is out of scope permanently, on the grounds of
"342,844 bytes of little-endian memory image, ~48 undecoded bytes, no checksum, and a device
that will accept a malformed one and crash." Three of those four premises are now weaker:

- **TE explicitly permits it.** `how_to_import.txt`, on Ian's own device, carries a
  capability matrix: [DOC]

  ```
  | TYPE            |  ADD   | MODIFY | REMOVE |
  | projects        |  yes   |  yes   |  yes   |
  ```

  and the projects section: *"you can backup, replace or remove your work. files are named
  'project01.opz' to 'project10.opz', anything else will be rejected. **if you remove a project
  it will be replaced by a default empty project**."*

  Replacing project files is a **documented, first-class content-mode operation**, not an
  exploit. Compare the sample path, where the failure mode (a missing `APPL op-1` chunk makes a
  file silently invisible) is *undocumented*.
- **The recovery path is documented, per-slot, and free.** Delete the file → default empty
  project. Combined with an off-device backup of all ten, the worst realistic outcome of a bad
  write is *losing one project you already have a copy of*. [DOC]
- **The byte count is now right** and the "48 unknown bytes" figure shrinks by four (§3.1).

### 7.2 The risks that remain, and they are real

- **Auto-save is on by default.** *"any changes to a project is automatically saved and there is
  no need to save manually."* [DOC] The device is continuously writing projects. Any
  read-modify-write must happen entirely inside a content-mode session, and a hand-edit on the
  device between your read and your write is silently lost. There is a manual-save toggle
  (hold `project` + `track`) which is the correct hygiene for this work. [DOC]
- **Import validation appears to be filename-level, not content-level.** TE says wrong
  *filenames* are rejected. Nothing in TE's text says a **malformed 342,848-byte
  `project04.opz` would be rejected** — and `rejected/` is documented as the sample-rejection
  mechanism. **[SPEC]** the device probably memory-maps the file and trusts it.
- **Firmware has had import-corruption bugs.** 1.2.40's release note is literally *"fix content
  mode bug that could cause corrupt samples and patterns on import."* [DOC] The import path is
  not a hardened parser; it is a path TE has already had to patch for data corruption.
- **The tail risk is a boot loop, not a brick.** [SPEC] If the firmware parses projects at
  startup and a malformed one faults, the device could fail to boot. Z-PO records that
  undocumented content *"can crash the device or the app"*, with recovery being backup plus
  **factory reset from upgrade mode** [RE] — so it is recoverable, but recovery costs the
  device's contents, not just the one project.
- **The version trailer is an unknown-consequence field.** Writing `7` when the firmware wants
  something else, or omitting it, is untested by anyone. [MEAS that it exists; **[SPEC]** as to
  what the firmware does with it.]

### 7.3 The safe experimental ladder, if he ever wants it

Nothing below is proposed for now — it is written down so the sequence is not re-derived.

1. **Back up all ten projects and both `how_to_*.txt` off-device.** (Effectively already done —
   they are in scratchpad.) Zero risk.
2. **Build the reader and the differ.** Zero risk, and §5 shows they carry most of the value.
3. **Decode by observation, not by writing.** Change one parameter on the device, snapshot,
   diff. This is how the 44 unknown header bytes get named. Zero risk.
4. **Identity round-trip.** Read `project07.opz`, re-serialise it, and check the output is
   **byte-identical** to the input. This is the whole test. A writer that cannot reproduce its
   input exactly must never be pointed at the device. Zero risk — it never leaves the laptop.
5. **Only then**, and only against a project slot he does not care about, with all ten backed
   up: change one byte (tempo), write, eject, observe. Recovery is a file copy.

Step 4 is the gate. It is also completely achievable today — and it is the honest test of
whether the format is understood, far better than any amount of further reading.

---

## 8. Open questions this lens did not close

- What the 22 large plug IDs actually are — hash of filename? of content? a device-local
  allocation counter? Decidable by importing a known sample and diffing, which requires writing.
- What the 44 header bytes at 521 hold. Reachable by §7.3 step 3, no writing. (Observed non-zero
  values: `00 ff 7f` at 521 in project01, `a0` at 529 in three files.) [MEAS]
- Whether the device validates project contents at all on import. **[SPEC]** — untestable
  without writing.
- The exact firmware that introduced the version-7 trailer. Narrowed to Oct 2020 – Dec 2021,
  most likely the 1.2.38–1.2.40 cluster of June 2021. [MEAS + DOC changelog]
- Whether step-component semantics survived the 1.1.17 → 1.2.45 gap unchanged. Only 168
  populated steps exist in Ian's whole corpus, which is a thin sample.
- The sysex `$09` pattern message: zlib-compressed with the signature 7-bit-mangled from
  `78 9c` to `78 1c` [RE, opzdoc wiki]. Decompressing it is understood; the payload inside is
  presumably the same pattern chunk. This is a **live** write channel that bypasses files
  entirely — and it is more dangerous than file writing, not less, because there is no
  "delete the file" recovery.

---

## 9. Sources

- <https://github.com/lrk/z-po-project/wiki/Project-file-format> — the byte map, fw 1.1.17
- <https://lrk.github.io/z-po-project/project-file-format-wip/> — author's status post, 2019-01-20
- <https://github.com/patriciogonzalezvivo/libopz> — `include/libopz/opz_project.h`, `src/opz_project.cpp`
- <https://github.com/hyphz/opzdoc/wiki/MIDI-Protocol> — sysex, zlib signature mangling
- <https://github.com/BKLronin/underbridge> — audio-path multitrack exporter, GPL-3.0
- <https://teenage.engineering/downloads/op-z> — firmware changelog, 1.2.26 / 1.2.38–40 / 1.2.45
- TE OP-Z guide, `app` and `project` chapters (local copies in scratchpad)
- `/Volumes/OP-Z/how_to_import.txt` — the ADD/MODIFY/REMOVE matrix and the projects section
- Ian's 15 project files, read-only, 2026-09-04
