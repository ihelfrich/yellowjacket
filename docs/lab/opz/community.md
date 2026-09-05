# OP-Z — what is known beyond the official documentation

Research notes, 2026-09-04. Lens: the open-source / reverse-engineering ecosystem, and the
honest picture of what is actually hard about the OP-Z.

Companion to `docs/CONTRACT-WIRE.md` (the OP-1/OP-Z drum-patch byte contract and the Web MIDI
layer) and `docs/CONTRACT-DRUMS.md`. Nothing already settled in CONTRACT-WIRE is re-derived
here; where an outside source **corroborates** or **contradicts** a CONTRACT-WIRE claim, that
is said explicitly.

## How to read the confidence labels

- **DOCUMENTED** — stated by teenage engineering in the official OP-Z guide, downloads page,
  or on-device `how_to_*.txt` files.
- **SOURCE-READ** — I read the implementation or data file myself in this session (raw file
  fetched via `gh api` or raw.githubusercontent). Strongest non-official evidence: it is what
  a working tool actually does, not what someone remembers it doing.
- **REVERSE-ENGINEERED** — published by a named community project as a finding, not verified
  by me byte-for-byte.
- **FORUM** — a claim from a forum thread. Person-attributed where possible. Weakest.
- **INFERRED** — my inference from the above, flagged as such.
- **UNKNOWN** — no public source found. Said plainly rather than guessed.

---

## 0. The framing fact: the target is frozen

**DOCUMENTED.** The last OP-Z firmware is **1.2.45, released 2022-03-31**
(<https://teenage.engineering/downloads/op-z>). Seventeen releases are listed; nothing after
1.2.45. That is **four and a half years of no firmware** as of this writing.

**REVERSE-ENGINEERED / press.** The OP-Z was **discontinued around March–April 2025** (removed
from teenage engineering's own store; widely reported, e.g. Matrixsynth "RIP teenage
engineering OP-Z", April 2025). Its successor is the **OP-XY**, announced 2024-11-14.

Consequences for a tool builder, and they are all good:

1. The `.aif` drum-patch contract in CONTRACT-WIRE **cannot be broken by a future firmware**.
   There will not be one. Byte-exactness is a permanent investment, not a moving target.
2. The install base is fixed and the tooling gap is permanent — no vendor is going to close it.
3. Anything Yellowjacket does for the OP-Z transfers partly to the OP-1 (same drum patch
   format) but **not** to the OP-XY, which uses a different sample/preset scheme.
4. Bug reports have nowhere to go. Every quirk in §7 is now permanent behaviour, not a
   pending fix. Design around them.

---

## 1. The project inventory

Metadata below (language, SPDX licence, stars, last push) was read from the GitHub API on
2026-09-04, not from README prose.

### 1a. Patch writers — the lane Yellowjacket is already in

| Project | Lang | Licence | Stars | Last push | What it is |
|---|---|---|---|---|---|
| [`schollz/teoperator`](https://github.com/schollz/teoperator) | Go | MIT | 170 | 2022-11-15 | The canonical one. CLI + web service (teoperator.com) that slices any audio into OP-1/OP-Z drum and synth patches with automatic transient-based key assignment. |
| [`AlexCharlton/op-patch-util`](https://github.com/AlexCharlton/op-patch-util) | Rust | **none** | 36 | **2026-03-03** | The most *technically precise* and the only actively maintained writer. Creates/edits drum and synth patches; `dump`/`set` round-trips the JSON so you can edit it with `jq`. |
| [`padenot/libop1`](https://github.com/padenot/libop1) | (GH says JS; README says C++ + libsndfile) | MIT | 13 | 2017-01-10 | Paul Adenot's original library + CLI. Adds start/end markers, fx/LFO params, normalisation; extracts the proprietary JSON. macOS/Linux only. Dormant since 2017. |
| [`hunjunior/OP-Z-Simple-Tool`](https://github.com/hunjunior/OP-Z-Simple-Tool) | JS (Electron) | MIT | 2 | 2020-05-29 | Minimal Electron GUI; carries a checked-in `JSON/drum_JSON_template.json`. Useful mainly as a *third independent witness* to the JSON key set (see §3c). |
| [`schollz/opkit`](https://github.com/schollz/opkit) | Go | **none** | 6 | 2022-11-19 | Narrow: packs postsolarpunk's Pulsar-23 library into kits. States the 12-second ceiling explicitly. |
| [`sowbug/op-1-tools`](https://github.com/sowbug/op-1-tools) | — | MIT | 11 | 2016-11-26 | Early OP-1 research repo. Historical. |

### 1b. Device / protocol reverse engineering — beyond patches

| Project | Lang | Licence | Stars | Last push | What it is |
|---|---|---|---|---|---|
| [`lrk/z-po-project`](https://github.com/lrk/z-po-project) ("Z-PO Project") | docs | Apache-2.0 | 82 | 2019-03-11 | **The `.opz` project-file format.** Wiki + blog. The single most substantial piece of OP-Z reverse engineering that exists. |
| [`MarkRdgOx/opzdoc`](https://github.com/MarkRdgOx/opzdoc) (a.k.a. `hyphz/opzdoc`) | docs | **none** | 44 | 2018-11-21 | **The sysex protocol**, file system, debug mode, button/context reference, OP-1 compatibility notes. |
| [`patriciogonzalezvivo/libopz`](https://github.com/patriciogonzalezvivo/libopz) | C++ | **NOASSERTION** (Prosperity + Patron) | 73 | 2023-01-16 | Working implementation of the above: loads/saves `.opz`, syncs live over MIDI sysex, exposes project/pattern/track/sound/step data. Terminal companion app. |
| [`nbw/opz`](https://github.com/nbw/opz) (`opzjs`) | JavaScript | MIT | 64 | 2021-05-14 | **Directly relevant to Yellowjacket.** Decodes OP-Z MIDI in Node *and the browser via Web MIDI*. Ships a declarative `opz.yml` mapping table. |
| [`ioma8/opz-firmware-notes`](https://github.com/ioma8/opz-firmware-notes) | docs | **none** | 0 | **2025-10-22** | Firmware image analysis. Ends in a wall (§6). |

### 1c. Adjacent utilities

| Project | Lang | Licence | Stars | Last push | What it is |
|---|---|---|---|---|---|
| [`BKLronin/underbridge`](https://github.com/BKLronin/underbridge) | Python | GPL-3.0 | 134 | 2025-07-25 | Multitrack "exporter": drives the OP-Z over `mido` while capturing its USB audio with `pyaudio`, writing one folder per track. **It is a real-time recorder, not a file exporter** — because no file route exists (§7.5). Highest-starred OP-Z-specific tool after teoperator. |
| [`romangarms/OP-1Z-Sample-Manager`](https://github.com/romangarms/OP-1Z-Sample-Manager) | Python (GH label says JS) | GPL-3.0 | 16 | **2026-07-11** | Desktop sample/project manager for OP-Z + OP-1 (non-Field). Actively maintained. Author's own framing: a blog post titled *"software to make the OP-Z usable"* (2025-10-12). |
| [`chrisdiana/OPZgo`](https://github.com/chrisdiana/OPZgo) | Python | none | 39 | 2020-07-02 | Backs the device up without a computer (Raspberry-Pi style). |
| [`robtruckr/OPZ_Bounce_Puller`](https://github.com/robtruckr/OPZ_Bounce_Puller) | — | — | — | — | Auto-pulls and clears `.wav` bounces off the device. |
| [`xmacex/connect-opz`](https://github.com/xmacex/connect-opz) | Lua | — | 36 | — | OP-Z as an audio device on monome norns. |
| [`op1hacks/op1repacker`](https://github.com/op1hacks/op1repacker) | Python | MIT | 319 | 2026-05-05 | **OP-1 only.** Unpack/modify/repack OP-1 firmware. Listed here to kill the assumption that it applies to the OP-Z — it does not (§6). |
| [`bnjreece/awesome-te`](https://github.com/bnjreece/awesome-te) | list | — | 30 | — | Curated index of TE reverse-engineering/mods. Good jumping-off point. |
| `teenageengineering/videolab`, `keijiro/VideolabTest`, Videolab-Creators-Group/* | C#/Unity | — | — | — | The videopak (visual) lane. Official Unity toolkit plus community paks. Out of scope for audio but it is where a lot of OP-Z community energy went. |

**Licence note that matters commercially.** `op-patch-util` and `opzdoc` carry **no licence at
all** — all rights reserved by default; reading them for facts is fine, copying code is not.
`libopz` is **Prosperity + Patron**, i.e. explicitly **non-commercial** — do not vendor it.
`underbridge` and `OP-1Z-Sample-Manager` are **GPL-3.0** — copyleft, incompatible with shipping
a closed browser bundle. The safe-to-reuse set is the MIT one: `teoperator`, `libop1`,
`OP-Z-Simple-Tool`, `nbw/opz`, `op1repacker`, `sowbug/op-1-tools`. Yellowjacket already
derived its writer independently, which was the right call.

---

## 2. What the community established that TE never documented — patch format

CONTRACT-WIRE already pins the chunk layout, the JSON key set, the fixed-point rule and the
12 s / 44.1 kHz / mono / 24-slot constraints. The following are **additions and
corroborations**, all read from source this session.

### 2a. Independent corroboration of the COMM extended-rate bytes — SOURCE-READ

`op-patch-util/src/chunks.rs` hard-codes the 80-bit IEEE extended sample rate as:

```rust
sample_rate: [64, 14, 172, 68, 0, 0, 0, 0, 0, 0], // 44100 Hz
```

`[64, 14, 172, 68]` = `0x40 0x0E 0xAC 0x44`. Byte-identical to CONTRACT-WIRE §1. Two
independent writers, same bytes. This is now corroborated, not merely asserted.

`chunks.rs` also declares `COMM`, `SSND`, `APPL`, the `op-1` signature — **and `COMT`**
(AIFF comments chunk). Real OP-1 files can carry a `COMT` chunk. Yellowjacket's
`parseDrumPatch` walks chunks generically, so it will skip it; worth a test fixture.

### 2b. Field semantics the official docs never state — SOURCE-READ

`op-patch-util/src/op1.rs` is the only place I found the OP-1/OP-Z drum JSON fields *typed and
annotated*. Directly from the struct definition:

```rust
Drum {
    name: String,        // "user"
    drum_version: u8,    // 1
    octave: u8,          // 0
    start: [u32; 24],
    end:   [u32; 24],
    pitch:    [i16; 24], // -24567/0/24567  512 per semitone; -48 to +48
    reverse:  [u16; 24], // 8192/16384
    volume:   [u16; 24], // 0/8192/16384
    playmode: [u16; 24], // 0/8192/16384
    dyna_env:   [u16; 8],  // 0-8182?
    lfo_params: [u16; 8],  // 0-16000?
    fx_params:  [u16; 8],  // 0-16000?
}
```

So, concretely:

- **`pitch[]` scale: 512 units per semitone**, range roughly ±24567 ≈ ±48 semitones. Confirmed
  by the implementation: `pitch[key-1] = semitones as i16 * 512`. CONTRACT-WIRE writes
  `pitch: [0 x24]` and never states the scale — this is the missing constant if Yellowjacket
  ever wants per-slot transposition (e.g. pitching the last real slice to fill unused slots,
  which is exactly what `op-patch-util drum -p` does).
- **`reverse[]`: 8192 = forward, 16384 = reverse.** Implementation:
  `reverse[key-1] = if rev { 16384 } else { 8192 }`.
- **`volume[]`: 0 = −inf, 8192 = unity, 16384 = maximum**, and the mapping is linear in a
  −1.0…+1.0 gain parameter: `volume[key-1] = (8192.0 * (gain + 1.0)) as u16`. (The README's
  dB annotations are internally inconsistent — the usage string says +1.0 is +12 dB, the
  worked example implies +6 dB. **Treat the dB figure as unverified**; the integer mapping is
  source-read and solid.)
- **`playmode[]`: 0 / 8192 / 16384** — three modes, of which CONTRACT-WIRE's 8192 (one-shot) is
  the middle. Which integer is which mode is **not** stated by any source I found. UNKNOWN.
- **`start[]`/`end[]` are `u32`**, consistent with the 0…2147483646 clamp.

### 2c. The synth (6 s) format, should Yellowjacket ever want tracks 5–8 — SOURCE-READ

CONTRACT-WIRE declares this out of scope. If that changes, the recipe exists:

```rust
Sampler {
    name: "user", synth_version: 2, octave: 0,
    base_freq: 440,
    adsr:  [64, 10746, 32767, 10000, 4000, 64, 4000, 4000],  // 0 - 32767
    knobs: [0, 0, 22501, 22501, 8192, 0, 6183, 8192],        // 0 - 32767
    lfo_active: false, lfo_type: Tremolo, lfo_params: [...],
    fx_active: false,  fx_type: Delay,   fx_params: [8000; 8],
}
```

and `op-patch-util/src/main.rs` sets the synth target length as
`let target_len = 44100 * 6 * 2; // Hz * seconds * 2 bytes` — 6.000 s exactly, vs the drum
`let max_len = 44100 * 12 * 2;` with the error string `"Samples cannot add up to more than 12
seconds"`. Both ceilings confirmed in one implementation.

**FORUM caveat, worth knowing before building it:** on op-forums, user *gero* states a synth
sample "has to be 6 seconds, otherwise there will be some sample bleed after it is sustained
longer" — i.e. the synth format may want *exactly* 6 s (padded), unlike drum patches which are
happy shorter. That is a forum claim, unverified, but it is consistent with `op-patch-util`
computing a fixed `target_len` rather than a maximum.

### 2d. Input validation the writers enforce — SOURCE-READ

`op-patch-util/src/main.rs`:

```rust
if header.sampling_rate != 44100 { Err("Sample must be encoded at 44100 Hz")?; }
...
data = drop_channels(&data, header.channel_count as usize);   // folds to channel 0
```

Note it **drops** extra channels (keeps ch 0) rather than summing. Yellowjacket folds to mono
properly per CONTRACT-DRUMS. Ours is better; just don't expect bit-identical output to
`op-patch-util` on stereo input.

---

## 3. The "don't care" fields: three writers, three different values

This is a genuinely useful finding and it **corroborates CONTRACT-WIRE's claim** that the OP-Z
reads only `start`/`end`/`pitch` from a drum patch.

| Field | CONTRACT-WIRE / Yellowjacket | `op-patch-util` (SOURCE-READ) | `OP-Z-Simple-Tool` template (SOURCE-READ) |
|---|---|---|---|
| `dyna_env` | `[0,8192,0,8192,0,0,0,0]` | `[0,8192,0,8192,0,0,0,0]` | `[0,0,0,0,0,0,0,0]` |
| `lfo_params` | `[16000,16000,16000,16000,0,0,0,0]` | `[16000,0,0,16000,0,0,0,0]` | `[16000 ×8]` |
| `fx_params` | `[8000 ×8]` | `[8000 ×8]` | `[8000 ×8]` |
| `playmode` | `[8192 ×24]` | `[8192 ×24]` | `[5119 ×24]` |
| `reverse` | `[8192 ×24]` | `[8192 ×24]` | `[12000 ×24]` |
| `volume` | `[8192 ×24]` | `[8192 ×24]` | `[8192 ×24]` |
| `lfo_type` / `fx_type` | `tremolo` / `delay` | `Tremolo` / `Delay` | `tremolo` / `delay` |

Reading:

- Yellowjacket's values match `op-patch-util` exactly on `dyna_env`, `playmode`, `reverse`,
  `volume`, `fx_params` — and CONTRACT-WIRE says they came from a factory hex dump. Two
  independent derivations landing on the same numbers is strong.
- `lfo_params` differs across all three and all three reportedly work. With `lfo_active:false`
  the field is inert. **Do not chase this.**
- `OP-Z-Simple-Tool`'s `playmode: 5119` and `reverse: 12000` are outliers with no stated
  provenance. They are almost certainly captured from some particular patch rather than
  derived. **INFERRED: not worth adopting.** But it is direct evidence that the OP-Z tolerates
  non-canonical values in those slots, which is the point.
- Every writer emits `drum_version: 1`, `type: "drum"`, `octave: 0`, all 24-long arrays, all
  keys present, alphabetical. No dissent anywhere. CONTRACT-WIRE is right.

---

## 4. The `.opz` project file format — Z-PO Project

**REVERSE-ENGINEERED** (lrk, published 2019-01 → 2019-03; wiki at
<https://github.com/lrk/z-po-project/wiki/Project-file-format>). Analysed against **firmware
1.1.17**. Author's own status: the format is "fully useable" with **about 48 bytes still
unidentified**. Independently *implemented* by `libopz`, which is the best evidence it is
substantially correct.

Nothing in Yellowjacket needs this today. It is here because it is the thing that would let a
browser tool read or write OP-Z *songs*, not just kits — and because it establishes the
device's internal model.

Header (little-endian throughout; the OP-Z runs an **Analog Devices Blackfin ADSP-BF703**):

| Offset | Size | Type | Field |
|---|---|---|---|
| 0 | 4 | u32 | file id, always `0x00000049` |
| 4 | 512 | — | 16 × pattern chain (32 B each, 0xFF padded) |
| 516 | 1 | u8 | drum level |
| 517 | 1 | u8 | synth level |
| 518 | 1 | u8 | punch level |
| 519 | 1 | u8 | master level |
| 520 | 1 | u8 | tempo (40–200 BPM) |
| 521 | 44 | — | unknown, usually 0x00 |
| 565 | 1 | u8 | swing (0–255) |
| 566 | 1 | u8 | metronome level |
| 567 | 1 | u8 | metronome sound |
| 568 | 4 | u32 | unknown, mostly `0x000000FF` |
| 572 | 342272 | — | 16 × pattern |

Pattern chunk = **21392 bytes**:

| Offset | Size | Field |
|---|---|---|
| 0 | 192 | 16 × track params (12 B each) |
| 192 | 7040 | 880 × note (8 B each) |
| 7232 | 13824 | 256 × step (54 B each) |
| 21056 | 288 | parameter values, 18 per track |
| 21344 | 40 | mute config |
| 21384 | 2 | tape send mapping |
| 21386 | 2 | master send mapping |
| 21388 | 1 | active mute group |
| 21389 | 3 | padding |

Note = 8 bytes: `i32 duration`, `u8 note` (C1 = 0, semitone steps), `u8 velocity` (default
100), `i8 micro-timing` (−23…+24 ticks), `u8 age` (always 0). Per-step note budget is
allocated per track and is **not uniform** — kick/snare/hh/sfx get 2 each, bass/lead/chord 4,
**arp 8**, fx1/fx2/tape 1, master 4, perform 6, module 6, lights 4, video 4 (55 total).

Step = 54 bytes: `u16 component bitmask`, 16 B component params, 18 B locked values, 18 B lock
mask. Step components (the OP-Z's "step components", its signature feature): multiply, sweep,
pulse/hold, tonality, trigger spark, component spark, parameter spark, jump, velocity, ramp up,
ramp down, random, glide — 13 used, bits 13–16 unused.

The 18 per-track parameters: param 1, param 2, envelope A/D/S/R, FX1 send, FX2 send, filter,
resonance, pan, volume, portamento, LFO P1–P4, note style.

`libopz` notes a real gap: it parses step components but **exposes no methods to read them
back out**, and it has **no write path** — you can read device state, not change it.

---

## 5. The MIDI picture — the part Yellowjacket actually touches

### 5a. Track ↔ channel map: SOURCE-READ, and it settles a question

CONTRACT-WIRE says "one MIDI channel per track (1–16, remappable)". Here is the actual default
table, read out of `nbw/opz`'s `opz.yml` (MIT), which keys off the full status byte:

| MIDI ch (1-based) | Status 0x9n | Track |
|---|---|---|
| 1 | 0x90 (144) | kick |
| 2 | 0x91 (145) | snare |
| 3 | 0x92 (146) | perc |
| 4 | 0x93 (147) | sample |
| 5 | 0x94 (148) | bass |
| 6 | 0x95 (149) | lead |
| 7 | 0x96 (150) | arp |
| 8 | 0x97 (151) | chord |
| 9 | 0x98 (152) | fx1 |
| 10 | 0x99 (153) | fx2 |
| 11 | 0x9A (154) | tape |
| 12 | 0x9B (155) | master |
| 13 | 0x9C (156) | perform |
| 14 | 0x9D (157) | module |
| 15 | 0x9E (158) | lights |
| 16 | 0x9F (159) | motion |

Same map for note-off (0x8n), CC/dials (0xBn) and pitch bend (0xEn).

**Corroborated FORUM-side:** on op-forums "OP-Z MIDI Implementation", a user's complaint is
precisely *"the only disappointment so far is that Channel 1 isn't active track, it's the Kick
track."* That is a user discovering the same table the hard way. It also explains why TE added
the **"channel one to active"** setting CONTRACT-WIRE already mentions.

**Observed inconsistency in `opz.yml` — flagged, not resolved.** In the CC/dial block, both
`189` and `190` map to `lights`; by the pattern of the note-on and pitch-bend blocks, `189`
(channel 14) should be `module`. **INFERRED: transcription bug in that file**, not a device
behaviour. Do not copy that row.

### 5b. Encoder/dial encoding — SOURCE-READ

`nbw/opz`'s `lib/index.js` decodes a dial CC number `d` as:

```js
dial:  (d - 1) % 4,          // which of the 4 encoders, 0-3
page:  Math.floor((d-1) / 4) // which parameter page, 0-3
```

So CC 1–4 = page 0, 5–8 = page 1, 9–12 = page 2, 13–16 = page 3, four encoders each. Page
colours: white, green, purple, yellow (arp's page 2 is blue instead of purple). **CC 23 is
mapped to `kill`.**

This **agrees exactly with TE's own CC table** (§5c): CC 1–2 = params 1–2, 3–4 = cutoff/res,
5–8 = ADSR, 9–12 = LFO, 13–14 = FX sends, 15–16 = pan/volume. Community RE and official docs
independently produce the same grid. High confidence.

### 5c. TE's own CC table — DOCUMENTED (<https://teenage.engineering/guides/op-z/midi>)

Absolute:

| CC | Parameter |
|---|---|
| 1–2 | parameter 1, parameter 2 |
| 3–4 | filter cutoff, resonance |
| 5–8 | envelope attack, decay, sustain, release |
| 9–12 | LFO depth, speed, target, shape |
| 13–14 | FX 1 send, FX 2 send |
| 15–16 | pan, volume |
| 17–18 | portamento, note style |

**CC 32–49** are the same parameters as *relative/incremental* controls (send value 1 or 127
for up/down). System: **CC 50/51** track gain (abs/rel), **52** reset track gains, **53** mute,
**54** audio mute, **55** mute group, **56** tempo, **57** swing, **60–63** track step count /
step length / quantize / note length, **102** UI (active track, parameter page), **103**
pattern selection. Program change, pitch bend, clock and song-position pointer are all handled.

FORUM detail worth having: **CC 61 set to value 10 ("gate") pauses a track**; CC 102 on the LFO
parameter page is reported glitchy. (op-forums, "OP-Z MIDI Implementation".)

MIDI settings are toggled on-device by **holding the two index buttons `tempo` + `screen`** and
pressing keys 1–8: 1 = channel-one-to-active, 2 = incoming MIDI, 3 = outgoing MIDI, 4 = MIDI
clock in, 5 = MIDI clock out, 6 = alt program change, 7 = MIDI echo, 8 = enable program change.
Per-track channel = hold the track button + turn the green encoder. (Changed location across
firmwares — see §7.2.)

Everything is also editable as **`config/midi.json` in content mode**, which multiple forum
posters say is far faster than the app. One documented `midi.json` switch: pattern activation
`true` → bank 1–16 / program 1–16 selects the active pattern; `false` → patterns 1–160 via
bank 1 / program 1–128 and bank 2 / program 1–32.

### 5d. The sysex protocol — REVERSE-ENGINEERED

From `hyphz/opzdoc` wiki "MIDI Protocol", implemented in `libopz`:

```
F0 00 20 76 01 <command> <data...> F7
   |________|  |
   TE mfr ID   device id (0x01)
```

- **7-bit packing is mandatory**: data is sent in groups where a leading byte carries the MSBs
  of the following seven bytes, LSB-first.
- Some payloads are **zlib**-compressed — recognisable by the `78 9C` signature, which appears
  as `78 1C` *after* 7-bit encoding.
- Known commands: `$00` master heartbeat (must be sent regularly for the device to keep
  talking), `$01` universal response, `$03` keyboard setting (octave, track), `$06` button
  states / encoder modes, `$0E` sound preset (engine, ADSR, FX, filter…), `$62` text commands
  (enters debug mode, controller mode, etc.).
- The official OP-Z app is built on Unity and uses `keijiro/MidiJack` for its MIDI transport.

**Status as of the public record (2022):** `patriciogonzalezvivo` reported decoding sound
properties, key events and volume, and asked publicly how to decompress the `$09` pattern
message — nobody in the thread answered. So live pattern read-back is **partially solved at
best**. `libopz` has **no write path at all**.

**Relevance to Yellowjacket:** none today, and there is a hard blocker anyway — CONTRACT-WIRE
correctly excludes sysex, and Chrome's Web MIDI gates sysex behind a *separate, stronger*
permission. Sending a heartbeat-driven proprietary protocol from a browser tab is a different
product. Noted so the option is understood, not so it gets built.

### 5e. What the OP-Z will NOT tell you over MIDI — REVERSE-ENGINEERED

`nbw/opz` README: track selection, play/stop, octave shift and the screen buttons **do not
transmit MIDI on their own**. Their state can often be inferred from the accompanying key or
dial traffic, but there is no direct message. Anything Yellowjacket wants to mirror from the
device's UI state has to be inferred or read over sysex.

### 5f. The drum note base is still UNKNOWN — and that is now a checked result

CONTRACT-WIRE says: "Its drum-track note base is UNDOCUMENTED: ship a LEARN capture, never
hardcode a guess." I went looking specifically to close this and **could not**:

- TE's MIDI guide gives the CC table but **no note table at all**.
- `nbw/opz` computes the note *name* as `n % 12` and returns the raw number — it deliberately
  does not assume a base.
- No forum thread, wiki page, or repo I found states the absolute note numbers.

**The one real lead — INFERRED, and it is only about the OP-1 keyboard layout, not the OP-Z's
MIDI base.** `op-patch-util`'s README worked example is `op-patch-util drum samples/*.wav -s7`
with the comment that the samples are "shifted over by 7 keys (`-s7`) to align with the C key".
Slot index + 7 ⇒ C, so **slot 0 sits 7 semitones below C, i.e. on F**, and the 24 slots run
**F … E across two octaves**. That matches the OP-1's physical keyboard, which starts on F.
So the *slice-to-key* layout is F-based. It does **not** tell you which MIDI note number the
OP-Z emits or accepts for slot 0.

**Verdict: CONTRACT-WIRE's LEARN-capture decision was correct and should not be revisited.**
Ian has the device connected — a single LEARN capture settles in ten seconds what the entire
public record does not contain. Worth writing the captured value into this file afterwards.

---

## 6. Firmware: a hard wall, unlike the OP-1

**REVERSE-ENGINEERED**, `ioma8/opz-firmware-notes` (`FIRMWARE_ANALYSIS.md`, 2025-10). The
firmware image `z_firmware_1_2_45.zfw` is **1,491,600 bytes**:

| Offset | Size | Content |
|---|---|---|
| 0x00 | 4 | flags/marker; byte 4 is a key **index** (0xFF) |
| 0x10 | 0x60 | reserved, zeroed |
| 0x70 | 16 | **AES IV** — `32 93 C5 8E E8 43 EF 3A 7B 0B 5E C8 5D E8 30 ED` |
| 0x80 | 4 (LE) | payload length `0x0016BE8F` = 1,490,575 |
| 0x300 | 0x100 | encrypted filename, decrypts to `firmware_bin_only_with_bootloader.zip` |
| 0x400 | … | encrypted archive |

**AES-256-CBC. The image stores only a key *index*, not the key.** Entropy 7.9998 bits/byte.
Attempts at XOR-mask recovery against known archive headers, and CTR/CBC/CFB/OFB/ECB trials,
all produced noise. The key lives in the device.

**So: there is no OP-Z equivalent of `op1repacker`.** The OP-1's firmware is unpacked, modded
and repacked routinely (319 stars, still maintained in 2026); the OP-Z's is not, and — with the
product discontinued and the key unreleased — will not be. Custom OP-Z firmware is off the
table. Anyone who tells you otherwise is talking about the OP-1.

Related **REVERSE-ENGINEERED** internals from the Z-PO Project: the OP-Z's internal storage is
**YAFFS2**, and files whose names begin with `~` are **de-duplication stubs** — the same sample
referenced from multiple packs is stored once. This matters if you ever inspect a raw image;
it does not affect the content-mode disk you write to.

---

## 7. The honest picture: what is actually hard about using an OP-Z

Grouped by whether it will bite a Yellowjacket user.

### 7.1 Sample import is a minefield — this one bites us directly

**DOCUMENTED** (<https://teenage.engineering/guides/op-z/disk-modes>):

- Content mode = **hold `track` while powering on**; all track LEDs go green; the device then
  mounts as a removable USB disk. (Upgrade mode = hold `screen` while powering on.)
- **Total sample storage: 24 MB.** For the whole device.
- Layout is `samplepacks/<track 1-8>/<slot 1-10>/` — **eight track folders, ten slot folders
  each**, i.e. **80 slots**, not the four drum folders CONTRACT-WIRE's prose implies. The
  Z-PO Project names the track folders as they appear:
  `1-kick 2-snare 3-perc 4-fx 5-bass 6-lead 7-arpeggio 8-chord`. Tracks 1–4 take 12 s drum
  patches; 5–8 take 6 s synth-sampler patches.
- Import happens **on eject** — the unit syncs and restarts itself.
- **Anything rejected reappears in a `rejected/` folder** the next time you enter content mode.
  This is the single most useful debugging affordance on the device and almost nobody mentions
  it in app copy. Yellowjacket's in-app instructions should.
- Permissions table: projects and sample packs can be added/modified/removed; **bounces can
  only be removed** (never added); **config can only be modified** (never added or removed).
- On-device `how_to_import.txt` and `how_to_dmx.txt` are the authoritative short reference.

**FORUM, and it is the number-one import gotcha:** *only one sample pack per slot folder will
be imported; any additional file in that folder is rejected.* Drop two `.aif` files in
`samplepacks/1-kick/1/` and you do not get two kits — you get a rejection. Yellowjacket's
PATCH export copy should say "one file per slot folder" in so many words.

**FORUM (op-forums "Sample file format issues"):** files that are correct 44.1 kHz / 16-bit /
mono AIFF but **lack the `APPL op-1` chunk simply do not appear** in content mode. There is no
error, they are just invisible. Users repeatedly hit this and concluded the device was broken.
The same thread shows gero's marker script refusing files with *"Sample already seems to
contain APPL chunk"* — so double-marking is also a failure mode. Yellowjacket's
`parseDrumPatch` is the right tool to sanity-check any user-supplied `.aif` before export
alongside it.

Same thread, a real confusion worth pre-empting: **AIFF vs AIFF-C**. Users assumed the "-C"
meant "compressed" and panicked. CONTRACT-WIRE already handles both (layout A `AIFC`/`sowt`
on read, layout B `AIFF` on write). Keep writing plain big-endian `AIFF`.

### 7.2 Documentation drift

Firmware moved controls between releases and the guide did not always keep up. The clearest
case: track mute/unmute moved from `shift` + step buttons to **hold `metronome` + the screen
box button**. A user in the op-forums MIDI thread lost a day to muted tracks silently
swallowing MIDI *notes* while clock still passed through — the tracks were disabled, not the
MIDI. Expect any instruction you read online to be firmware-dated.

### 7.3 MIDI out reliability — the recurring complaint

**FORUM, multiple independent reports** (modwiggler OP-Z thread, op-forums). Users report that
driving external gear from the OP-Z drops notes — *"half of the notes are randomly not
triggered"* — particularly when several MIDI channels are active at once, and that the device
is fussy about cables/adapters. Others report no trouble at all with different gear.

**Confidence: real but unquantified.** I found no controlled measurement, no TE
acknowledgement, and no fix in the 1.2.45 notes.

**Implication for Yellowjacket, and it is a good one:** this is about the OP-Z as *master*.
Yellowjacket's WIRE layer puts the browser in the master seat (CLOCK OUT, notes out) and treats
the OP-Z as a slave and as a note *source*. That is the more reliable direction of the link.
If Ian sees dropped notes during hardware validation, check the direction before blaming the
scheduler.

### 7.4 Clock and sync

**DOCUMENTED:** sending MIDI timing clock to the OP-Z **automatically puts it in external sync
mode**; confirm by holding `tempo` — four green LEDs. (CONTRACT-WIRE already has this.)
1.2.45's own release note lists **reduced BLE MIDI jitter** — i.e. BLE jitter was bad enough to
be a shipped fix. CONTRACT-WIRE's decision to exclude BLE entirely looks better for it.

### 7.5 There is no multitrack file export

**INFERRED from tool design, high confidence.** The OP-Z can bounce, but per-track stems are
not a file operation: `underbridge` (134 stars) drives the sequencer over `mido` while
capturing the OP-Z's USB audio through `pyaudio`, one track at a time, in real time. If a file
route existed, the most-starred stem tool would not be a tape recorder. `OPZ_Bounce_Puller`
exists purely to automate hauling `.wav` bounces off the disk, which is the other half of the
same complaint.

### 7.6 The general workflow complaint

The OP-Z has **no screen**. Everything not on the LEDs lives in the phone app, and the app is
the thing people complain about most — connection drops, and a hard dependency on a companion
device for parameter visibility. The best single-sentence summary of the community's position
is the title of the OP-1Z Sample Manager author's own blog post: *"software to make the OP-Z
usable"* (2025-10-12). Note that the app is still on the App Store and still receiving
updates despite the hardware being discontinued.

Hardware gripes that recur but are not our problem: battery not charging to full (some units
stop at ~10 of 16 bars), back-panel fit, and the battery being a user-replaceable but fiddly
job (iFixit has a guide).

---

## 8. What is genuinely unknown

Stated plainly rather than guessed at:

1. **The OP-Z's drum-track MIDI note base.** Nowhere in the public record. §5f. Resolve by
   LEARN capture on Ian's connected device and record the number here.
2. **Which `playmode` integer means which mode** (0 / 8192 / 16384). The values are known; the
   meanings are not.
3. **`dyna_env[]` semantics.** Every writer copies `[0,8192,0,8192,0,0,0,0]` without knowing
   what it means; `op-patch-util` annotates the range with a question mark.
4. **The `$09` sysex pattern message.** Known to be zlib after 7-bit unpacking; no public
   working decoder.
5. **~48 bytes of the `.opz` header/pattern structure**, by the Z-PO Project's own admission.
6. **The firmware AES-256 key.** Held in hardware, never published. §6.
7. **Whether the drum patch honours `volume`/`reverse`/`pitch` at all on the OP-Z** (as opposed
   to the OP-1). CONTRACT-WIRE asserts the OP-Z reads only start/end/pitch and everything else
   is cosmetic *there*. The three-writer divergence in §3 is consistent with that but does not
   prove it. **Cheap experiment available:** export the same kit twice, once with
   `reverse: [16384 ×24]`, and listen. Ian has the hardware.

---

## 9. Concrete implications for Yellowjacket

Nothing here overturns CONTRACT-WIRE. Six things it can absorb:

1. **Fix the folder claim in CONTRACT-WIRE §1.** It says "drop one .aif per slot folder under
   `samplepacks/1-kick .. 4-fx`". The disk actually exposes **eight** track folders each with
   **ten** slot subfolders (`1-kick 2-snare 3-perc 4-fx 5-bass 6-lead 7-arpeggio 8-chord`,
   slots `1`–`10`). The *drum* format only applies to 1–4, which is what the sentence means,
   but the path shape as written under-describes the disk. One-line correction.
2. **Add the two import failure modes to the PATCH export copy**: (a) one file per slot folder
   or it is rejected; (b) rejected files come back in a `rejected/` folder — check there first.
   Plus the 24 MB device total. These three sentences will prevent most support questions.
3. **`pitch[] = 512 per semitone`** is the missing constant if slot-filling or transposition is
   ever wanted. `reverse[]` 8192/16384 and `volume[] = 8192*(gain+1)` likewise. Free features
   on top of the writer that already exists.
4. **Add a `COMT` chunk fixture** to the `parseDrumPatch` tests — real OP-1 files carry one and
   `op-patch-util` declares it.
5. **The track↔channel map in §5a can ship as WIRE's default LEARN table** (ch 1 = kick …
   ch 8 = chord), so the panel opens pre-populated and LEARN only has to fix the note base.
   Cite `nbw/opz` (MIT). Do **not** copy the `189 → lights` row.
6. **When Ian validates on hardware**, three cheap captures worth recording back into this
   file: the drum note base; whether `reverse: 16384` audibly reverses on the OP-Z; and
   whether the export survives a full eject/import cycle without landing in `rejected/`.

Branding line from CONTRACT-WIRE stands and is what every credible project in §1 does.

---

## 10. Sources

Official (DOCUMENTED):
- <https://teenage.engineering/guides/op-z> — guide index
- <https://teenage.engineering/guides/op-z/midi> — CC table, settings combos, `midi.json`, clock
- <https://teenage.engineering/guides/op-z/disk-modes> — content/upgrade mode, 24 MB, `rejected/`
- <https://teenage.engineering/guides/op-z/sampling> — 12 s drum / 6 s synth, 24 slices
- <https://teenage.engineering/downloads/op-z> — firmware list, last = 1.2.45, 2022-03-31

Reverse engineering (REVERSE-ENGINEERED / SOURCE-READ):
- <https://github.com/lrk/z-po-project/wiki/Project-file-format> — `.opz` byte layout, fw 1.1.17
- <https://lrk.github.io/z-po-project/default_sample_packs/> — folder layout, YAFFS2, `~` dedup
- <https://github.com/hyphz/opzdoc/wiki/MIDI-Protocol> — sysex framing, 7-bit packing, zlib
- <https://github.com/MarkRdgOx/opzdoc/issues/1> — the `$09` pattern message, still unsolved
- <https://github.com/patriciogonzalezvivo/libopz> — C++ implementation of the above
- `AlexCharlton/op-patch-util` `src/op1.rs`, `src/chunks.rs`, `src/main.rs` — field semantics,
  COMM extended bytes, 6 s / 12 s ceilings (read directly this session)
- `nbw/opz` `opz.yml`, `lib/index.js` — track↔channel map, dial/page encoding (read directly)
- `hunjunior/OP-Z-Simple-Tool` `JSON/drum_JSON_template.json` (read directly)
- <https://github.com/ioma8/opz-firmware-notes> — AES-256-CBC firmware wall
- <https://github.com/schollz/teoperator>, <https://github.com/padenot/libop1>,
  <https://github.com/schollz/opkit>, <https://github.com/bnjreece/awesome-te>

Forum / community (FORUM — lower confidence, attributed above):
- <https://op-forums.com/t/sample-file-format-issues/7785> — APPL requirement, 6 s synth bleed
- <https://op-forums.com/t/op-z-midi-implementation/24575> — ch 1 = kick, CC 61 gate, CC 102
- <https://op-forums.com/t/op-z-midi-question/17885> — muted tracks swallow notes
- modwiggler OP-Z thread — dropped notes on MIDI out, battery charging
- <https://www.matrixsynth.com/2025/04/rip-teenage-engineering-op-z.html> — discontinuation
- <https://romangarms.com/portfolio/op-z-sample-manager-software-to-make-the-op-z-usable>
