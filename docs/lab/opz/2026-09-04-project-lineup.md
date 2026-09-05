# 2026-09-04 — The project lineup: three instruments, one answer

**Question.** Can a `.opz` project file be decoded well enough that the
decode *predicts the audio the device makes*, and can that prediction be
checked without asking the device anything, without writing to it, and
without a human in the loop?

**Answer.** Yes. Fifteen of Ian's project files were decoded, the device was
started over MIDI and recorded for twelve seconds, and the recording was
matched against every pattern in every file. The file the match picked runs
at the tempo the MIDI clock reports and the tempo the cyclic modulation
detector reads off the audio unprompted. Three independent instruments —
the file bytes, the clock wire, the modulation spectrum — agree.

What shipped: `js/export/opz-project.js` (decoder, event layout, grid,
inspector, SMF export), `scripts/opz-export.mjs` (CLI), 7 tests in
`test/run.mjs` (`op-z project`). Nothing was written to the device.

---

## 1. Setup

- Device: OP-Z, firmware 1.2.45, normal mode (not content mode), USB audio
  2-in/2-out 44.1 kHz, CoreMIDI source and destination `OP-Z`.
- Files: the 14 `projects/*.opz` plus `bounces/bounce01/project.opz` copied
  off the disk during the read-only scan of 2026-09-03 (scratchpad, not the
  repo — they are his content).
- Byte map: Z-PO's, as re-verified against these same files in
  `cap-project-format.md`. The decoder encodes the three facts that document
  found and the wiki lacks: empty note = `0xFF`, micro-timing ±96 = ±½ step,
  four-byte version trailer (7).
- Timing model (measured on the files, not documented anywhere): an empty
  note slot carries duration 2560 and real notes cluster on
  2048/2304/2560/2816/3328, so **2560 ticks = one step**, 10240 = one quarter.
  Step length multiplies the step. A track loops at `steps × stepLength`
  (polymetric), and a note whose step ≥ the track's step count is stored but
  never played.

## 2. What the clock said before anything else

The OP-Z emits MIDI clock continuously, playing or not: 630 ticks per 15 s
over a 735-second log, i.e. **42.0 ticks/s = 105.0 bpm**. Exactly three of
the fifteen files carry tempo 105 — `project02`, `project03f`, `project04`.
(104 would be 624 ticks per 15 s; the count was 630. `project09` at 104 is
excluded by the wire, not by taste.)

## 3. The recording

Send `0xFA` (Start), record USB audio 12 s, send `0xFC` (Stop), all-notes-off.
The device played (peak 0.82, RMS 0.12) and stopped (peak 0.0000 in a 2 s
check afterwards). It sent **zero note-ons** while playing — outgoing note
MIDI is off on this unit — so the audio is the only ground truth, which is
the harder and more interesting version of the test.

## 4. Three attempts at the match, two of which were wrong

Each pattern of each file becomes a hit vector on a 64-bin bar (¼-step
resolution) from `patternEvents`. Each bar of audio becomes an onset-strength
vector on the same grid. Start latency is unknown, so phase is searched.

| attempt | statistic | winner | tempo | why it was wrong |
|---|---|---|---|---|
| 1 | cosine similarity, one onset band | project10 p13 (bass on all 16 steps) | 128 | **density bias**: a dense template correlates with anything |
| 2 | Pearson, one band | bounce01 p4 (3 hits, on strong steps) | 128 | **multiple comparisons**: 96 patterns × 64 phases lets a sparse template land on three loud steps by chance |
| 3 | Pearson × 3 spectral bands, per-file phase, permutation null | **project02 p6** | **105** | — |

Attempt 3 is the multi-spectral one: onset strength in three bands
(20–200 Hz, 200–3000 Hz, 3–16 kHz) from a 512-point STFT at hop 128, matched
against track groups (kick+bass / snare+sample+lead+arp+chord / perc+sample).
Each file gets its own best phase; its score is the sum over five bars of its
best pattern's three-band Pearson. The null shuffles the audio bins within
each bar (same permutation across bands) and re-runs the whole max-over-
phases-and-patterns procedure, 30 times per file.

## 5. Result

```
rank  file                    bpm   score   null µ    z     phase  picks
   1  project02.opz           105    8.86    2.13   27.5   1036ms  p6 p6 p6 p6 p6
   2  project09.opz           104    9.27    3.06   24.3    464ms  p5 p5 p5 p5 p5
   3  project07.opz           151    6.88    2.16   22.2    464ms  p3 p2 p3 p2 p3
   ...
   7  project04.opz           105    7.62    2.62   19.5    750ms  p5 p5 p5 p5 p4
  14  project03f.opz          105    2.13    1.58    2.1   1679ms  p16 …
```

Among the three files the clock allows, project02 wins by 8 z-units over
project04 and by 25 over project03f. The same pattern (6) is picked in all
five bars — a single pattern looping, not a chain. Bar 1, audio against the
file (X strong, x weak onset; x file hit):

```
LOW  kick+bass    xXxxXxxxxxxXXxxx   xx..x.x.....x..x   r=0.55
MID  snare+synth  X.XxXXXxXxxxXxXx   x.xxxxx.xxxxx.x.   r=0.66
HIGH perc         X.X.X.X.X.X.X.X.   x.xxxxx.x.x.x.x.   r=0.71
```

The file says pattern 6 of project02 is:

```
kick    xx..x.x.....x...   5 notes   53, 60
snare   ...x..x.x..x..x.   5 notes   70, 73
perc    x.xxxxx.x.x.x.x.  12 notes   56, 60, 67
sample  ......x.......x.   2 notes   54
bass    x..............x   2 notes   43
lead    x.x.x.x.x.x.x.x.   8 notes   55, 62, 67, 68
arp     x....xx..x.xx...   8 notes
chord   xxx.xx..xxx.xx..  10 notes   (step length 2)
master  x.......x.......   2 notes   (step length 4)
module  xxxxxxxxxxxxxxxx  16 notes   60
```

The cyclic detector (`js/analysis/cyclic.js`), given the same audio and told
nothing:

```
1.758 Hz = 105.5 bpm   x83    82 bands   <- BEAT
3.516 Hz = 210.9 bpm   x155  128 bands   harmonic  <- 8ths
7.031 Hz = 421.9 bpm   x72   112 bands   harmonic  <- 16ths
13.945 Hz              x111  112 bands   <- 32nds
2.578 Hz = 1.5 × beat  x30    34 bands   (a 3-against-2 element)
```

105.5 is the alpha bin nearest 105.0 (bin width 60/1024 = 0.0586 Hz, 3.5 bpm
at this alpha). This is the detector's first reading of real hardware; it
had only ever seen synthetic signals.

**Cross-check that fell out for free.** Drum-track notes in the files sit in
53–76 (kick 53/60, snare 70/73, perc 56/60/67, sample 54) — the same base 53
the MIDI capture measured on 2026-09-03 (`device-scan.md` §note base). The
file decode and the wire measurement were made independently and agree.

## 6. What is and is not claimed

- **Claimed:** among all 96 candidate patterns in 15 files, the best
  explanation of the recorded audio is project02 pattern 6, and it is also
  the only top candidate consistent with the clock's tempo. The verdict is a
  ranking under a tempo prior, not a proof.
- **Not claimed:** the z-scores as p-values. The within-bar permutation null
  destroys the 8th-note grid every real pattern shares, so every file's z is
  inflated (14–27). The ranking is the evidence; the absolute z is not.
- **Open:** whether the live project state equals the saved file. The device
  writes the file on entering content mode; anything edited since the
  2026-09-03 scan would not be in the copy. The user can settle it in two
  seconds by holding **project** and reading which LED is lit, and
  **pattern** for the pattern.
- **Failed on my side, recorded so it is not repeated:** the first "silence
  floor" probe read 0.25 — it was reading the wrong input, not a playing
  device; a 20-s pinned-device recording read 0.000. Attempts 1 and 2 above.

## 7. Reproduce

```
# decode + MIDI (files copied off the device; never the mounted volume)
node scripts/opz-export.mjs ~/path/to/project02.opz --out /tmp/opz-midi
# the lineup is `docs/lab/opz/lineup3.mjs` (run from a directory holding `opz/*.opz`); it needs
# opz-play.f32 + opz-play.json from the Start/record/Stop capture.
```

## 8. Next

- Wire the decoder into the bench: drop a `.opz`, get the grid and a `.mid`
  per pattern. It is the first OP-Z tool that reads the file instead of
  recording the device track by track (underbridge does the latter because
  it cannot read the file).
- Replace the permutation null with a *pattern* null (other files' patterns
  at the same tempo) so the z means something.
- Use micro-timing and velocity in the match; today's template is binary.
- Ask the device to play each of its patterns in turn (program change is
  enabled on this unit) and build a full audio-vs-file confusion matrix.
