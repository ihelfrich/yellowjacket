# OP-Z — files and formats on the device

Lab note, 2026-09-04. Lens: **what the OP-Z filesystem looks like in content /
disk mode** — the tree, what lives where, naming, and the size/format
constraints for each kind of content. Written to confirm and extend
`docs/CONTRACT-WIRE.md §1` against primary sources, not to relitigate it.

Every claim is tagged:

- **[DOC]** — teenage engineering's own guide, downloads page, or on-device text.
- **[RE]** — reverse-engineering: a named project, a device log, or a byte
  layout derived from real files. Named inline.
- **[INF]** — inference from the above. Reasoning shown.
- **[UNK]** — genuinely not known; say so rather than guess.

Local hardware state at the time of writing: the OP-Z **is** connected to this
Mac, but as a **USB audio device**, not a disk —
`system_profiler SPAudioDataType` reports `OP-Z / teenage engineering ab /
Input Channels: 2 / Output Channels: 2 / Current SampleRate: 44100`, and
`ioreg -p IOUSB` shows `USB Product Name = "OP-Z"`. `/Volumes` holds only
`Macintosh HD`. Content mode is a **power-cycle mode**, so nothing here was
read off the live disk; everything below is sourced.

---

## 1. Entering the disk modes [DOC]

Source: <https://teenage.engineering/guides/op-z/disk-modes>

| Mode | Entry | Indication |
|---|---|---|
| **content mode** | hold **track** while turning the unit on | all track LEDs green |
| **upgrade mode** | hold **screen** while turning the unit on | kick LED blinks white, all parameter dial LEDs white |
| **factory reset** | in upgrade mode, hold **screen + stop** for a second | blinking white LED + four green LEDs; *"any custom user content will be removed"* |

Content mode presents the OP-Z as a USB mass-storage volume. The device does
**not** apply anything you drop on it until you **safely eject**; on eject it
runs an import pass and *"will update and restart when ready."* Do not power it
off during that pass. [DOC]

What content mode allows, per TE's own operations matrix [DOC]:

| Content | add | modify | remove |
|---|:--:|:--:|:--:|
| projects | ✅ | ✅ | ✅ |
| sample packs | ✅ | ✅ | ✅ |
| bounces | ❌ | ❌ | ✅ |
| config | ❌ | ✅ | ❌ |

Backup = drag files **from** the OP-Z. Restore = drag them back **to the
corresponding locations**. There is no versioning or merge; it is a filesystem.

Firmware is a **separate** mode: drop a `.zfw` file *"in the root folder of the
OP–Z disk"* and reboot into upgrade mode. TE's downloads page lists files named
exactly `z_firmware_1_2_45.zfw`, `z_firmware_1_2_40.zfw`, …,
`z_firmware_1_1_17.zfw` (17 releases, 1.1.12 → 1.2.45, the last dated
2022-03-31). [DOC] <https://teenage.engineering/downloads/op-z>

---

## 2. The disk tree

Composite. Each line is tagged for where it comes from.

```
/                                  (content-mode volume root)
├── how_to_import.txt              [DOC] TE names it; [RE] z-po quotes it
├── how_to_dmx.txt                 [DOC] TE names it (lights/DMX chapter)
├── import.log                     [RE]  z-po-project quotes its contents
├── z_firmware_1_2_45.zfw          [DOC] firmware goes in the ROOT folder
├── config/                        [RE]  from import.log: "importing config/general.json"
│   ├── general.json               [DOC] keys enumerated in TE reference §24.3
│   ├── midi.json                  [DOC] keys enumerated in TE MIDI chapter
│   └── dmx.json                   [DOC] named in TE lights chapter
├── projects/                      [DOC] named; [RE] contents documented by z-po
│   ├── 01 … 10                    [RE]  "numbered from 01 to 10 matching the project mapping order"
│   └── <name>f                    [RE]  snapshot = same name + `f` suffix
├── samplepacks/                   [DOC] the folder users are told to open
│   ├── 1-kick/   01 … 10          [RE]  track names + slot names from z-po-project
│   ├── 2-snare/  01 … 10
│   ├── 3-perc/   01 … 10
│   ├── 4-fx/     01 … 10
│   ├── 5-bass/   01 … 10
│   ├── 6-lead/   01 … 10
│   ├── 7-arpeggio/ 01 … 10
│   └── 8-chord/  01 … 10
├── bounces/                       [DOC] named; [RE] internal shape from import.log
│   └── bounce01/ … bounce05/
│       ├── project.opz            [RE]  literal filename in the log
│       └── bounce.wav             [RE]  literal filename in the log
└── rejected/                      [DOC] "rejected files appear in a rejected folder
                                          on next content mode entry"
```

The `import.log` excerpt that anchors half of the above, quoted by the Z-PO
Project [RE] (<https://lrk.github.io/z-po-project/default_sample_packs/>):

```
[IMPORT STARTED]
Reading content disk...SUCCESS
Calculating used sample space...0.0/24.0 MB
Syncronizing rejected
Syncronizing bounces
  removing /yaffs2/user/bounces/bounce01/project.opz
  removing /yaffs2/user/bounces/bounce01/bounce.wav
Syncronizing config
  importing config/general.json...SUCCESS
Syncronizing projects
Rebuilding plug definitions...SUCCESS
[IMPORT COMPLETE]
```

Three things fall out of that log:

1. The internal filesystem is **YAFFS2** mounted at `/yaffs2/user/…` — a
   NAND-flash filesystem, i.e. the exposed USB volume is a *staging view*, not
   the real store. That is why changes only land on eject. [RE] → [INF]
2. The sample budget is **24.0 MB**, counted as one pool across everything, and
   the device reports it as `used/24.0 MB`. [RE] — and matches TE's own
   *"you can store a total of 24mb of sample data."* [DOC]
3. Import is **per-category and idempotent-ish**: rejected, bounces, config,
   projects, then *"Rebuilding plug definitions"* — the plug table (see §6) is
   regenerated from what is on disk.

### Slot-folder naming: `01`–`10` vs `1`–`10`

Unresolved conflict, and worth knowing before writing an installer:

- Z-PO Project (RE, read off a real device): *"Each folder has 10 subfolders
  matching the 10 plug slots named from `01` to `10`."*
- gerotakke's community guide: *"there are folders from `1` to `10`"*.
- TE's guide only says *"slots 1–10"* in prose and never shows a listing.

**[INF]** Treat `01`…`10` as the on-disk spelling (the RE source read an actual
volume), but never *create* the folders — drop into whatever already exists.
The folders are pre-created by the device; a user only ever populates them.

---

## 3. Sampler / drum-track content: the OP-1 drum patch `.aif`

TE's own statement of the rule [DOC]:

- Supported format is *"OP-1 .aif sample format"* — **drum sample format for
  drum tracks, synth sample format for synth tracks**.
- Drum sampling gives *"24 sounds, or slices, distributed across the musical
  keyboard"*, *"up to 12 second long"*.
- Drum samples are *"fully compatible with the OP-1 drum kit file format"*.
- Only `.aif` audio files are accepted.

Community/RE detail on the audio itself: **mono, 16-bit, 44.1 kHz AIFF**;
consolidated file *"less than 12 seconds long"*; each individual sound *"less
than 4 seconds long"* (gerotakke, community guide — the per-sound 4 s figure is
guidance, not a documented device limit; treat as **[RE, low confidence]**).

### 3.1 Confirmation of CONTRACT-WIRE §1 against a second factory file

`CONTRACT-WIRE.md` derives the fixed-point rule from one OP-1 factory patch
(`tr808`). I re-derived it **independently** from a completely different
OP-1-written patch — the `boombap1` default embedded in
`schollz/teoperator` (`src/op1/drum.go`, [RE]) — and every value matches:

```
position = floor(frameIndex * 2147483646 / 529200)
```

All twelve real `end[]` values in that file reproduce to the byte. The
community "4058 units per sample" constant (teoperator's own
`SAMPLECONVERSION = 4058`, `src/op1/constants.go`) drifts by **−453 units at
frame 24 062 and −2 979 units at frame 158 363** — i.e. it is wrong by up to
~0.7 sample-widths by the end of a 12 s file. Yellowjacket's exact-ratio
implementation (`js/export/op1patch.js:18-23`) is the correct one; do not
"simplify" it back to a multiply.

The same file confirms the boundary convention in the contract:
`end[0] = 97643143` is frame **24 062**, and `start[1] = 97647201` is frame
**24 063** — exactly one frame later, a delta of 4 058 units. So
*`end[i]` = last frame of slice i, `start[i+1]` = first frame of slice i+1*,
which is what `op1patch.js:60-61` writes. Confirmed.

One difference worth knowing but **not** worth changing: the OP-1 fills unused
slots by parking them on the last real boundary *and* gives slot 23 the file's
tail (`start[23] = 642638133`, `end[23] = 2032606256` ≈ frame 500 891 ≈ 11.36 s).
Yellowjacket duplicates the last real slice into every unused slot
(`op1patch.js:75-78`). Both are legal; Yellowjacket's is more predictable.

### 3.2 The APPL `op-1` JSON — schema, and the fields the contract does not carry

Yellowjacket writes 17 keys (`op1patch.js:82-100`), all alphabetical, all
per-slice arrays exactly 24 long. That set is proven against an OP-1 factory
`tr808` patch (`drum_version: 1`) and is what the hardware eats.

Two other writers in the wild emit **supersets**, and both use
`drum_version: 2`:

| Key | Yellowjacket | teoperator (`boombap1`, captured from an OP-1) | DigiChain (`src/resources.js:75-99`) |
|---|---|---|---|
| `drum_version` | `1` | `2` | `2` |
| `type` | `"drum"` | `"drum"` | `"drum"` |
| `start[24]`, `end[24]` | ✅ | ✅ | ✅ |
| `pitch[24]` | `0` | `0` | `0` |
| `playmode[24]` | `8192` | `8192` | `12288` |
| `reverse[24]` | `8192` | `8192` | `8192` |
| `volume[24]` | `8192` | `8192` | `8192` |
| `dyna_env[8]` | `[0,8192,0,8192,0,0,0,0]` | same | same |
| `fx_active` / `fx_type` / `fx_params[8]` | `false` / `delay` / `8000×8` | same | same |
| `lfo_active` / `lfo_type` / `lfo_params[8]` | `false` / `tremolo` / `[16000,16000,16000,16000,0,0,0,0]` | same | same |
| `name`, `octave` | ✅ | ✅ | ✅ |
| `attack[24]` | — | — | `0` |
| `pan[24]` | — | — | `16384` (centre) |
| `pan_ab[24]` | — | — | `false` |
| `stereo` | — | — | `numChannels === 2` |
| `mtime` | — | — | unix seconds |
| `original_folder` | — | — | string |

**[INF]** The extra DigiChain keys (`pan`, `pan_ab`, `stereo`, `attack`) are
**OP-1 Field / OP-XY** territory — DigiChain scales stereo patches against a
**20 s** budget (`2147483646 / (44100 * 20)`) versus **12 s** for mono, and the
OP-Z is mono-only, 12 s. Adding them to a Yellowjacket export buys nothing on
an OP-Z and risks a rejection on older firmware. Do not add them.

`drum_version` **1 and 2 both exist in files written by TE hardware.** Version 1
is what the factory `tr808` carries; version 2 is what a later OP-1 wrote.
Whether the OP-Z distinguishes them is **[UNK]**; Yellowjacket's v1 patches are
reported to work, so leave it.

### 3.3 `playmode` and `reverse` are quantised zones, not enums — and 8192 sits on a seam

DigiChain documents the encodings in a source comment [RE]
(`brian3kb/digichain`, `src/resources.js:92-93`, AGPL):

```
playmode:  4096 = ->    12288 = ->|    20480 = ->G    28672 = loop
reverse:   8192 = ->   24576 = <-
```

and its OP-XY translation table (`src/resources.js:27-40`) maps
`4096→'gate'`, `12288→'oneshot'`, `20480→'group'`, `28672→'loop'`,
`reverse === 24576 → true`.

**[INF]** Those four values are the *centres* of four 8192-wide buckets in a
0…32767 encoder range (`4096, 12288, 20480, 28672` = 8192·k + 4096), and the two
`reverse` values are the centres of two 16384-wide buckets. That reading is
consistent, self-checking, and explains why `reverse: 8192` is unambiguously
"forward".

It also means **`playmode: 8192` — the value CONTRACT-WIRE §1 specifies and
`op1patch.js:95` writes — is the exact boundary between bucket 0 (`->`,
play-through / gate) and bucket 1 (`->|`, one-shot).** The contract's comment
calls 8192 "one-shot"; DigiChain's table would round it to `gate`. The
mitigating fact is that an actual OP-1 wrote `8192` in the `boombap1` patch, so
it is not an invalid value — and gerotakke's guide reports the OP-Z
*"disregards"* per-slice settings in a drum kit entirely, so the field may be
inert on the Z regardless.

**Recommendation, low risk, high certainty-gain:** change the drum export to
`playmode: 12288` (bucket centre, unambiguously one-shot on both OP-1 and
OP-Z) and note the change in CONTRACT-WIRE. Nothing else moves. This is the one
substantive correction this note produces.

### 3.4 What the OP-Z actually honours in a drum patch

- CONTRACT-WIRE §1 currently says: *"The OP-Z reads only start/end/pitch from
  drum patches."*
- gerotakke's guide (community, careful, but a single author) says the OP-Z
  *"doesn't have individual settings for each sound in the consolidated file,
  so it disregards all these settings completely"* — i.e. everything the OP-1
  Drum Utility can set is ignored.

**[INF]** `start`/`end` cannot be ignored — they are the only thing that defines
where the 24 slices are, and the OP-Z demonstrably slices imported kits. The
disagreement is confined to `pitch`, which Yellowjacket writes as 24 zeros
anyway. **Operationally there is nothing to change**; but the contract's
sentence is stronger than the evidence supports. Suggested softening: "the OP-Z
uses start/end; the remaining per-slice fields are cosmetic there and may be
ignored entirely."

### 3.5 Byte layout — unchanged, and still correct

Nothing found contradicts the layout in CONTRACT-WIRE §1 or its implementation:
`FORM`/`AIFF`, `COMM` (18 bytes, mono, s16, 80-bit extended `40 0E AC 44 00 …`),
`APPL` carrying `'op-1'` + compact JSON + `0x0A` with the size **counting** the
even-pad, then `SSND` with zero offset/blockSize and big-endian s16. teoperator
takes the same approach from the other direction — it lets ffmpeg write a plain
44.1 k mono AIFF and then splices the `op-1` APPL chunk in **immediately before
the `SSND` tag** (`drum.go`, `bytes.Index(b, []byte("SSND"))`) [RE], which is
the same chunk order Yellowjacket emits. The reader in `op1patch.js:152-214`
additionally accepts AIFC/`sowt`, which is what real devices sometimes write.

---

## 4. Synth-track content (tracks 5–8): the OP-1 **sampler** patch

Out of scope for the current exporter, and the constraints are genuinely
different:

- **Exactly 6 seconds.** [DOC for "up to 6 second"; RE/community for "exactly"]
  TE: *"sampling to any of the synth tracks (BASS, lead, arp and chord) will
  give you an up to 6 second long chromatic sample."* Every community source
  importing files by hand says the file must be **exactly 6 s** — 264 600
  frames at 44.1 kHz — mono, 16-bit. A shorter file produces *"sample bleed:
  when your custom sample is done playing, something else will be played until
  the 6 seconds are reached"* (gerotakke) [RE].
- **`base_freq` is the one field the OP-Z honours** in a synth sample; it places
  the sample's pitch across the keyboard. Everything else (ADSR, FX, LFO,
  preset name) is ignored on the Z [RE, gerotakke].
- Synth samples get loop in/out points on the device; drum samples get
  normal/reverse direction. [DOC]

JSON schema, as written by DigiChain (`src/resources.js:98-116`) [RE]:

```json
{"adsr":[64,10746,32767,10000,4000,64,4000,18021],
 "base_freq":440,
 "fade":0,
 "fx_active":false,"fx_params":[8000,8000,8000,8000,8000,8000,8000,8000],
 "fx_type":"delay",
 "knobs":[0,0,0,8600,12000,0,0,8192],
 "lfo_active":false,"lfo_params":[16000,0,0,16000,0,0,0,0],
 "lfo_type":"tremolo",
 "mtime":1683144375,
 "name":"...","octave":0,"original_folder":"...",
 "stereo":false,
 "synth_version":3,
 "type":"sampler"}
```

Note `lfo_params` differs from the drum default (`[16000,0,0,16000,0,0,0,0]`
vs `[16000,16000,16000,16000,0,0,0,0]`), there are **no** `start`/`end`/`pitch`
arrays, and the discriminator is `type: "sampler"` + `synth_version` rather than
`drum_version`. `stereo`/`original_folder`/`mtime` are again Field/XY-era keys;
whether the OP-Z tolerates or requires them is **[UNK]**.

If Yellowjacket ever ships a synth-patch export, the contract for it is: mono
44.1 k s16, **pad or trim to exactly 264 600 frames**, `type: "sampler"`,
`base_freq` set to the actual measured pitch of the sample (not blindly 440),
same AIFF chunk layout. That is a genuinely small delta on the existing writer.

---

## 5. Projects — `.opz`, byte-mapped, and fully reverse-engineered

Source: Z-PO Project wiki, *Project file format*, against **firmware 1.1.17**
[RE] — <https://github.com/lrk/z-po-project/wiki/Project-file-format>.
Independent of TE.

- **10 projects × 16 patterns.** [DOC]
- Project files live in `projects/`, *"numbered from 01 to 10 matching the
  project mapping order"*; a **snapshot** is a copy of the project file with an
  `f` suffix; one snapshot per project (hold **project + +** to store, **+ –**
  to restore). [DOC for behaviour, RE for the file naming]
- Extension `.opz`. The exact filename spelling on disk (`01.opz`, `01` with no
  extension, `project01.opz`) is **[INF]** — the only literal filename an RE
  source quotes is `bounces/bounce01/project.opz`.
- **Little-endian** throughout: the OP-Z runs a **Blackfin ADSP-BF703** and the
  file is memory-mapped, so all multi-byte fields are LSB-first. [RE]

**File header (572 bytes), then 16 pattern chunks.**

| Offset | Size | Type | Field |
|---:|---:|---|---|
| 0 | 4 | UINT32 | File ID, always `0x00000049` |
| 4 | 512 | PatternChain[16] | saved pattern chains, 32 B each |
| 516 | 1 | UINT8 | mixer drum level |
| 517 | 1 | UINT8 | mixer synth level |
| 518 | 1 | UINT8 | mixer punch level |
| 519 | 1 | UINT8 | mixer master level |
| 520 | 1 | UINT8 | tempo, 40–200 |
| 521 | 44 | ?? | unknown, usually `0x00` |
| 565 | 1 | UINT8 | swing, 0–255 |
| 566 | 1 | UINT8 | metronome level |
| 567 | 1 | UINT8 | metronome sound, `0x00`–`0xFF` |
| 568 | 4 | UINT32? | unknown, mostly `0x000000FF` |
| 572 | 342 272 | Pattern[16] | 16 × 21 392 B |

**Total file size = 572 + 342 272 = 342 844 bytes** [INF, arithmetic on the RE
table]. The author states ~48 bytes of the format remain un-decoded.

**Pattern chunk (21 392 B):** Track[16] params (192 B, 12 B each) · Notes[880]
(7 040 B, 8 B each) · Steps[256] (13 824 B, 54 B each) · parameter values
(288 B = 18 params × 16 tracks) · mutes bitmask (40 B) · tape send map (UINT16)
· master send map (UINT16) · active mute group (1 B) · 3 B unused.

**Track chunk (12 B):** plug ID (UINT32) · step count · `0x05` (timing?) ·
step length · quantize · note style · note length · 2 B unused.

**Note chunk (8 B):** duration (INT32) · note (0 = C1, +1 per semitone) ·
velocity (default 100) · micro adjust (INT8, −23…+24) · age (`0x00`).

**Notes are pre-allocated per step — 55 slots, fixed track map:**
kick 0–1, snare 2–3, hihat 4–5, sfx 6–7 (2 each) · bass 8–11, lead 12–15
(4 each) · arp 16–23 (8) · chord 24–27 (4) · fx1 28, fx2 29, tape 30 (1 each) ·
master 31–34 (4) · perform 35–40 (6) · module 41–46 (6) · lights 47–50 (4) ·
video 51–54 (4). *That is the polyphony budget, written into the file format.*

**Step chunk (54 B):** components bitmask (UINT16) · 16 B component parameter
values · 18 B parameter-lock values · 18 B parameter-lock mask. Bitmask bit
order is `[8..1][16..9]`: Glide, Random, Ramp Down, Ramp Up, Velocity, Jump,
Parameter Spark, Pulse | unused, unused, Component Spark, Trigger Spark,
Tonality, Pulse Hold, Sweep, Multiply. Spark values encode the repeat rule in
the MSB nibble: `0x04` = trig on the 4th pass, `0x14` = 1st of every 4,
`0x24` = every pass but the 4th.

**Pattern chain (32 B):** array of pattern ids 0–15, padded with `0xFF`; an
empty chain is 16 × `0xFF` followed by garbage to ignore.

---

## 6. Slots, plugs and `.engine` files

A "slot" is not just a sample folder — it is a **plug**: an engine reference
plus optional sample. Z-PO Project enumerated the plug table off a device [RE]
(<https://github.com/lrk/z-po-project/wiki/Sound-engines-and-Plugs>).

- A slot folder holds **one** item: either a sample `.aif` **or** a sound-engine
  file `.engine`. Observed filenames: `~26.engine`, `~112.engine`,
  `~CuckooC_keypawn.aif`, `~TeKicks.aif`.
- **The tilde prefix is the device's deduplication marker.** `how_to_import.txt`
  explains that *"duplicate files are renamed by OP-Z with a tilde at the
  beginning to optimize space"* — so the tilde-named files you see in the slot
  folders are **zero-byte stubs** pointing at content that lives inside the
  internal YAFFS2 image, not real audio. Do not treat an empty file as a
  corrupt one. [RE]
- Factory sample filenames (26 of them) include `TeKicks.aif`, `TeSnares.aif`,
  `TePercs.aif`, `TeFX.aif`, `AlainKicks/Snares/Perc/FX.aif`,
  `CuckooKicks/Snares/Perc/FX.aif`, `CuckooC_keypawn.aif`, `CuckooC_open.aif`,
  `SebaKicks/Snares/Perc/FX.aif`, `redKicks/Snares/Perc/FX.aif`, `GrantFX.aif`,
  `zVinyl.aif`, `sfx.aif` (metronome sounds), `UserSampler.aif`. [RE]
- Plug ids are UINT32 and are what a project file's Track chunk stores, so
  **a project references a plug id, not a filename.** Moving a sample to a
  different slot changes what a saved project plays. [RE] → [INF]
- Engine ids seen: 10 `sampleplayergain` (every drum kit plug uses it), 68
  `synthsampler` (the two Cuckoo synth samples), 16 `saw013a`, 13 `fm003b`,
  59 `chord`, 62 `digital`, 70 `volt`, 77 `electric`, 82 `ministringshort`,
  83 `cluster`, 61 `delay`, 66 `reverb`, 78 `dist`, 79 `crush`, 60 `chorus`,
  09 `tapetwo`, 00 = "no engine" (DMX/module/video/performance plugs). [RE]

The `.engine` file's internal format is **[UNK]** — nobody has published a byte
layout, and the visible ones on disk are tilde stubs anyway.

---

## 7. Config files

All three are plain JSON in content mode. `config/general.json` is the only one
whose path an RE source confirms; TE says all three are *"found in content
mode"*. [DOC for keys, RE for the path]

**`general.json`** — booleans, all `true`/`false` (defaults not documented):
`backlit_keys`, `disable_headphone_db_reduction`, `disable_microphone_mode`,
`disable_param_page_reset`, `disable_start_sound`, `disable_track_preview`,
`generous_chords` (chord polyphony 4 → 6), `latch_notes_with_shift`,
`temp_param_add_fx_a`, `legacy_input_select`.

**`midi.json`** — `channel_one_to_active`, `incoming_midi`, `outgoing_midi`,
`timing_clock_in`, `timing_clock_out`, `enable_program_change`,
`alt_program_change`, `midi_echo`, `track_enable`, `track_channels`,
`parameter_cc_out`. Per-track channels are set as 1–16, and are also settable
on the device (hold a track key, press the green dial). *Relevant to
CONTRACT-WIRE §2:* `channel_one_to_active` is the documented name of the
"channel one to active" behaviour the contract already describes, and
`timing_clock_in` gates whether Yellowjacket's CLOCK OUT will actually drive
the device — TE confirms *"sending a midi timing clock to your OP-Z will
automatically put it into external sync mode."*

**`dmx.json`** — up to **128 channels total**; channel types include red,
green, blue, white, colour wheel, intensity/dimmer, fog (fired by animation
14), `knob1`–`knob8` (the eight dials across two parameter pages), fixed custom
values, always-on (255) and always-off (0). Most channel values are 0–255.
There is no lights *asset* content: the lights track is sequencer data mapped
to DMX channels by this file, plus `how_to_dmx.txt` on the root. [DOC]

---

## 8. Bounces

- Bounce records *"a 10 second audio file of the current pattern"*; the device
  stores *"up to 5 bounces"* and lights a red LED past that. Each bounce is
  saved *alongside a copy of the project*. [DOC]
- On disk: `bounces/bounce01/{project.opz, bounce.wav}` — WAV, not AIFF, and
  paired with a full project copy. [RE, from `import.log`]
- Content mode may only **remove** bounces, never add or modify them. [DOC]
- Sample rate/bit depth/channel count of `bounce.wav` is **[UNK]** — no source
  states it. The USB audio interface runs at 44 100 Hz (observed on this Mac),
  which makes 44.1 k the obvious guess, but it is a guess.

---

## 9. Size and capacity, gathered

| Quantity | Value | Tag |
|---|---|---|
| Total user sample space | **24.0 MB**, one shared pool | [DOC] + [RE] (`import.log` prints `used/24.0 MB`) |
| Sample tracks × slots | 8 × 10 = **80 slots** | [RE] |
| Items per slot folder | **exactly one**; extras are rejected | [DOC] |
| Drum kit length | ≤ **12 s** → ≤ **529 200 frames** | [DOC] |
| Drum kit slices | **24** | [DOC] |
| Per-slice length guidance | < 4 s | [RE, low confidence] |
| Synth sample length | **exactly 6 s** = **264 600 frames** | [DOC "up to 6 s"] + [RE "exactly"] |
| Audio format | mono, 16-bit, 44 100 Hz, `.aif` | [DOC] format; [RE] the mono/16-bit specifics |
| Max drum kit file size | 529 200 × 2 = **1 058 400 B ≈ 1.01 MB** + header | [INF] |
| Max synth sample size | 264 600 × 2 = **529 200 B ≈ 0.50 MB** + header | [INF] |
| Kits that fit in the budget | ≈ **23** full-length drum kits, or ≈ 47 synth samples | [INF] |
| Projects | 10, each 16 patterns | [DOC] |
| Project file size | **342 844 B** | [INF] from the RE byte table |
| Bounces | 5 × 10 s | [DOC] |
| DMX channels | 128 | [DOC] |
| Firmware file | `z_firmware_<a>_<b>_<c>.zfw` in the **root** | [DOC] |

**[INF]** The 24 MB pool binds long before the 80 slots do: filling every slot
with maximum-length content would need ≈ 60 MB. Any Yellowjacket copy that
implies "80 kits" would be wrong; the honest number is "about 23 full-length
kits, fewer if you use the synth tracks."

---

## 10. What the device does with bad files

- **Rejection is a folder, not an error.** *"Rejected files appear in a
  `rejected` folder on next content mode entry."* [DOC] So a failed import is
  silent at eject time and only visible on the *next* boot into content mode —
  which means a user can reasonably believe an import worked when it did not.
- **More than one file in a slot folder:** one is imported, *"any additional
  ones being rejected."* [DOC]
- **Wrong format / wrong length:** no primary source states the behaviour.
  gerotakke reports never having seen the `rejected` folder populate at all,
  and reports a *short* synth sample producing "sample bleed" rather than a
  rejection — i.e. at least some malformed content is **accepted and plays
  wrong**. [RE, single observer] **[UNK]** in general.
- **Filename-based import detection:** re-importing a changed file under the
  *same* filename may be skipped; the reported workaround is to rename or to
  delete-then-re-add. [RE, community] This is the practical gotcha with the
  biggest bearing on Yellowjacket's exporter — see §11.
- **Undocumented content can crash the device or the app.** Z-PO reports
  *"many OP-Z's app and device crash"* from mismatched files, with recovery =
  boot to content mode and back up, then upgrade mode → factory reset. [RE]
- There is no checksum, no manifest, and no user-visible import report other
  than `import.log` after the fact.

---

## 11. Consequences for Yellowjacket (`js/export/op1patch.js`, CONTRACT-WIRE)

Confirmed, no change needed:

1. The fixed-point rule, the `end`/`start` frame convention, the 24-slot fill,
   the AIFF chunk order and the APPL even-pad accounting are all correct, now
   against a **second** independent factory file (§3.1).
2. 44.1 kHz / mono / s16 / ≤ 529 200 frames / `.aif` is exactly the device's
   drum contract.
3. Chunk order (`COMM`, `APPL`, `SSND`) matches how every working writer emits.

Worth changing or extending:

4. **`playmode: 8192` → `12288`** (§3.3). One constant in `op1patch.js:95`, plus
   the line in CONTRACT-WIRE §1. Removes a genuine ambiguity at a bucket seam.
5. **Filename uniqueness on export.** The device appears to key imports on
   filename; Yellowjacket exports `<stem>-kit.aif`, so a second export of the
   same session collides with the first and may silently not re-import. Adding
   a short discriminator (`<stem>-kit-<8 hex>.aif`, or a date stamp) makes
   re-export reliable. This is the highest-value change in this note after §4.
6. **In-app copy should name the exact destination**: content mode →
   `samplepacks/1-kick` … `4-fx` → a slot folder `01`–`10` → **one file only**
   → eject → wait for restart → and *check the `rejected` folder on the next
   content-mode boot*. The current copy stops at "samplepacks folder".
7. **Budget copy**: 24 MB total, ≈ 1.01 MB per full-length kit, ≈ 23 kits. A
   status line after export that says "≈1.0 MB of the OP-Z's 24 MB" is cheap
   and true.
8. **Soften the "reads only start/end/pitch" claim** in CONTRACT-WIRE §1 to
   "uses start/end; other per-slice fields are cosmetic on the Z" (§3.4).
9. **A synth-patch export is a small delta** (§4): same writer, pad/trim to
   exactly 264 600 frames, swap the JSON for the `type: "sampler"` schema, set
   `base_freq` from measured pitch. It would open tracks 5–8, which the current
   exporter explicitly leaves out of scope.

Not worth doing:

10. Do **not** add `pan`/`pan_ab`/`stereo`/`attack`/`mtime`/`original_folder`.
    They are OP-1 Field / OP-XY keys on a 20 s stereo budget; the OP-Z is mono
    and 12 s (§3.2).
11. Do **not** write `.opz` project files. The format is 342 844 bytes of
    little-endian memory image with ~48 undecoded bytes, no checksum, and the
    device will happily accept a malformed one. Reading one to *display* a
    project is defensible; writing one is not.

---

## 12. Open questions / [UNK]

- Exact on-disk filename of a project (`01.opz`? `01`? `01f.opz` for the
  snapshot?). Only `bounces/bounce01/project.opz` is quoted literally anywhere.
- Whether the OP-Z validates `drum_version` at all, and whether `1` and `2`
  behave differently.
- Whether the OP-Z requires or merely tolerates the newer JSON keys.
- `.engine` file byte format — entirely undocumented.
- `bounce.wav` rate/depth/channels.
- Total internal storage (only the **24 MB user sample budget** is published;
  projects, bounces and firmware evidently live outside it).
- Whether a 12 s+ or non-44.1 k `.aif` is rejected, truncated, or resampled.
- Whether the tilde stub trick (creating a zero-byte `~Name.aif` to reference
  internal content) is stable across firmware — Z-PO warns it causes crashes.

---

## Sources

Primary (teenage engineering):
- <https://teenage.engineering/guides/op-z/disk-modes>
- <https://teenage.engineering/guides/op-z/sampling>
- <https://teenage.engineering/guides/op-z/project>
- <https://teenage.engineering/guides/op-z/lights>
- <https://teenage.engineering/guides/op-z/midi>
- <https://teenage.engineering/guides/op-z/reference> (§24.3, `general.json`)
- <https://teenage.engineering/downloads/op-z> (`.zfw` firmware list)

Reverse engineering (named, non-TE):
- Z-PO Project — <https://lrk.github.io/z-po-project/default_sample_packs/> and
  the wiki pages *Project file format* and *Sound engines and Plugs*
  (firmware 1.1.17; the `import.log` quote and the plug table).
- `schollz/teoperator`, `src/op1/drum.go` + `src/op1/constants.go` — a real
  OP-1 drum patch JSON (`boombap1`) and the approximate 4058 constant.
- `brian3kb/digichain`, `src/resources.js` (AGPL) — drum + sampler JSON
  templates, playmode/reverse encodings, the mono-12 s / stereo-20 s scale.
- `chrisdiana/OPZgo` — confirms the backed-up top-level content categories.

Community, single-author, marked as such where used:
- gerotakke, *OP-Z And Samples: A Comprehensive Guide* —
  <https://gerotakke.de/op-z-sample/op-z-samples.md.html> (mono/16-bit/44.1 k,
  <4 s per sound, exactly-6 s synth samples, "sample bleed", the claim that the
  OP-Z disregards per-slice settings).

Local cross-checks:
- `/Users/ian/Developer/yellowjacket/js/export/op1patch.js` (lines 18-23, 60-61,
  75-78, 82-100, 152-214)
- `/Users/ian/Developer/yellowjacket/docs/CONTRACT-WIRE.md` §1
- `system_profiler SPAudioDataType`, `ioreg -p IOUSB` on this Mac, 2026-09-04.
