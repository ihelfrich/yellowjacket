# SMOKE — the journeys worth driving by hand

The node suite covers pure functions well and has never caught a user-visible
defect in this project. Everything that actually reached a user — a field
library nobody could open, a kit that could not be played, a status line
promising a beat that was not there — was found by driving the real app.

These are those journeys, with the numbers they produced on 2026-08-30 so a
later run can tell "changed" from "broken". Run them against the deployed site,
not a dev server, and reload once after a deploy before believing anything (the
previous service worker serves the old build until then).

## 1. Found sound to music, in three clicks

FIELD → *Spring Peepers, Dark* → HARVEST → FREEZE → WAV 32F.

| checkpoint | expected |
|---|---|
| load | `48.0k · 08:28`, about 10 s including the archive.org stream |
| HARVEST | `24 SLICES ACROSS 381S · SNARE 3 TONE 13 VOX 2 KICK 3 BASS 1 FX 2` |
| seating | `8 ON TRACKS · 8 LEVELLED · GROOVE ON 8 · PRESS RUN` |
| pattern | non-zero steps lit **without touching the grid** |
| FREEZE | bench source becomes ~2 s |
| export | ~-7 dBFS peak, ~-24 RMS, no samples over full scale |

A second source exercises different paths and is worth alternating with:
*Nightingale* yields `TONE 4 SNARE 8 CRASH 1 KICK 3 HAT 4 FX 2 VOX 2` and only
**5** of 8 slices need levelling, which is the evidence that levelling is not
blindly boosting everything. *A Small Brook* yields only `SNARE 3 TONE 18 HAT 3`
— no kick at all — so it exercises role backfill and the duplicate-role rotation.

## 2. High resolution survives persistence

Load a 192 kHz WAV → wait ~6 s for autosave → reload → RESUME → WAV 32F.

Expect `192.0k` before *and after* the resume, and the exported file still 192 kHz.
Reporting the rate is not enough: measure the content. A 30 kHz tone authored 6 dB
below a 440 Hz tone came back at -10.5 vs -4.4 dBFS, against a -82 dBFS control at
20 kHz where nothing was written.

## 3. A harvested kit survives persistence

Harvest, note the eight track labels and the lit step count, reload, RESUME.
Labels and step count must match exactly. Then FREEZE and export: peak must be
in the -3 to -8 dBFS range. If it comes back near **-24**, the levelling was lost
somewhere in the asset round trip and the samples are being re-cut from source.

## 4. Semantic take, with its lineage

LOOM → DEMO REGION → WEAVE → ARM TO SCENE → PRINT 24-BIT.

Expect `9/9 EVENTS TRACED`, then `SEMANTIC TAKE ARMED`, then a **ZIP containing
two entries**: the WAV and its `.yjmap.json`. A ZIP with only the WAV means the
lineage map stopped being written.

## Worst cases worth re-running before changing levelling

All eight harvested tracks fired on the same step and frozen: **-1.4 dBFS peak,
zero samples over full scale.** Per-slice normalisation does not bound the sum,
so this looks unsafe on paper; it is not, because harvested slices are
uncorrelated and their peaks do not align. Reproduce this before lowering
`KIT_TARGET_DB` — the obvious "fix" would make every kit quieter for a problem
that does not occur.

## Automation notes

Driving this from a script rather than by hand has two traps that look like
product bugs and are not:

- `confirmSourceReplacement()` calls `window.confirm()`. Headless contexts
  auto-dismiss it to **false**, so loading a second source silently reports
  `SOURCE KEPT` and the previous audio stays on the bench.
- Chrome's ES-module cache is shared across tabs and survives both
  `location.reload(true)` and opening a new tab. Serving from a **different
  port** is the only reliable way to get a clean module graph locally.

## 5. Soundscape split discriminates

MEASURE on a FIELD recording fills the SOUNDSCAPE SPLIT bar. Readings taken
2026-08-31 — the point is the *spread*, not any single figure. If these collapse
toward one another the index has stopped measuring anything.

| recording | NDSI | voice band |
|---|---|---|
| Nightingale, midnight (pure birdsong) | **+0.95** | 97% |
| Spring peepers, dark | **+0.91** | 95% |
| Sevilla street marathon | **-0.29** | 35% |
| Berlin songbirds vs rush hour | **-0.41** | 30% |

The Berlin recording is the interesting one: its own title says songbirds
against traffic, and it lands between the pure-nature and pure-city readings but
on the city side, which is what a 4 a.m. rush-hour roar under birdsong should do.

## 6. The shelf streams lossless originals at their real rate

SHELF (header) → LOSSLESS → MUSIC → *Society Blues · 1921*.

| checkpoint | expected |
|---|---|
| chips | FIELD · VOICE · SCORE · MUSIC · ODD, plus a blue LIGHT/LOSSLESS switch |
| card badge, LOSSLESS | `96k · 24-bit`, `63.6 MB` — read from the FLAC header, not archive metadata |
| load | status shows fetch %, then `96.0k · 03:12` on a 96 kHz output (or the offline native-rate path on a 48 kHz one) |
| decode report | `nativeRate 96000, decodedRate 96000, upsampled false` |
| VOICE → *Hiawatha's Childhood* | 4:52 of read speech — the first stock source the TRANSCRIPT bench has ever had |
| reload | the LIGHT/LOSSLESS choice persists (`localStorage yj-shelf-lossless`) |

Honesty check that belongs here, measured in the live app with a 32k Hann
window and 250 Hz Goertzel steps: **Cicada Orni** (96 kHz FLAC) has **-114 dBFS**
above 24 kHz, and **Kid Ory 1921** (96 kHz / 24-bit transfer) has **-110 dBFS**
there, with its real energy at 0.25-2 kHz (-65) and a steep roll-off — a 1921
acoustic recording physically tops out near 5 kHz. Both badges are factual and
neither file is ultrasonic material. The gain on LOSSLESS is 24-bit and no codec
artifacts, not bandwidth. Do not promote either as hi-res *content*; the
spectrogram is the authority on what a container actually holds. Nothing on
archive.org with an open licence and genuine energy above 24 kHz was found in
a 130-item sweep on 2026-09-01 — that material has to be recorded.

## 7. SPEED prints the same samples under a slower clock

Drop a 96 kHz file whose only content sits at 26–34 kHz (the generator in
`test/run.mjs`'s varispeed block makes one) → SPEED to **¼×** → PLAY → WAV 32F.

| checkpoint | expected |
|---|---|
| SPEED button | cycles `1× → ½× → ¼×`, lit blue when not 1× |
| status at ¼× | `¼× SPEED · 24 kHz CLOCK · ABOVE 12 kHz IN THE SOURCE IS NOW AUDIBLE` |
| playhead | buffer-seconds ÷ real-seconds = **0.25** (measured 0.493 / 2.00) |
| export name | `…bench.quarter-speed.32.wav` |
| export header | **24000 Hz**, frame count **identical** to the source (553,920 for 5.77 s) |
| the payoff | the note authored at 26 kHz reads **−10.9 dBFS at 6.5 kHz**; 3 kHz control −93 |
| back at 1× | export has no suffix and a 96000 Hz header |

Nothing is resampled: the printed file is bit-exact, only the header rate
changes. That is why the frame count must match the source exactly — a
mismatch means something started interpolating.
