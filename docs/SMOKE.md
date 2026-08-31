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
