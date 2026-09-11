# 2026-09-11 — A waterfall you point at, and what the survey got wrong on the way

The SIGINT state on the SIGNAL bench had contradicted its own reason for
living there. The design said a signals bench starts from a span of the
spectrogram already on screen; the first build hid that spectrogram behind a
text pane. Today only the rail swaps. The waveform and spectrogram stay, SURVEY
outlines what it found on the spectrogram, a click inside an outline selects it
as the region, a drag draws one, and MEASURE, CLASSIFY and DECODE work on that
region's time **and band**.

That is the design. The rest of this note is what running it on a real
recording found, because the first survey it drew was wrong three ways.

## 1. Time order buried the signal

`segment()` returns emissions in time order. The panel took the first forty. On
the shelf's M08 recording — one 997 Hz Morse tone at 45 dB — six full-length
ridges starting at 0:00 sorted to the top, and the real 30 dB bursts were rows
seven onward. Ranking by `cells` was worse: a 4 kHz-wide ridge at 11.7 dB
outranked a 3 s burst at 29 dB, because cells reward area.

The module's own evidence is `falseAlarmLog10`, the log probability that a
component is noise. On M08 the real bursts read −6.9 M and −7.6 M against
−114 k for the widest ridge. Most negative first. The panel now reads the
survey the way the module's own tests do: the list `classifyOn` names, with
`aboveContentEdge` set aside and said so.

## 2. The content edge was decoder-dependent

Those ridges sat at 3.5–10 kHz and 16.6–20.7 kHz on an MP3 of a shortwave
capture whose receiver passband ends near 2.9 kHz. The module flags anything
above the recording's *content edge* as codec — and put that edge at
**17,000 Hz** in the page, and at **2,885 Hz** under ffmpeg, for the same file.

Chrome's decoder leaves two codec plateaus, at roughly −124 and −110 dB. The
edge finder scanned down from the codec cutoff for the first bin to clear 6 dB
over the deep plateau, and the 14 dB step between the two plateaus at 17 kHz
cleared it long before the receiver's 45 dB shoulder at 2.9 kHz came into view.
ffmpeg's decode has no intermediate plateau, so its scan reached the shoulder.

The receiver's passband edge is the **largest** cliff in the floor, not the
first step from the top. `EDGE_STEP_DB = 15`, measured across a window of
±25 % of the frequency — bigger than any codec step, far smaller than the
receiver's. The window has to be proportional: a first draft used a fixed
300 Hz and read a "cliff" at 316 Hz in 96 kHz pink noise, because a
10 dB-per-decade tilt is a whole decade across 300 Hz near DC and nothing at
20 kHz. Proportional, the same tilt reads about 2 dB everywhere, and a
recording with no cliff of 15 dB keeps the old rule. Measured after:
**2,745 Hz** in the page, **2,713 Hz** under ffmpeg.

## 3. The floor does not lie about it either

A second, independent test, for whatever the edge finder misses: the ridges'
band floors sit **44–67 dB under the receiver's own noise**. No receiver's
audio output carries a signal 30 dB below its own floor, so a band that far
down is dead air to it and anything standing in it is the codec.
`DEAD_BAND_DB = 30`, compared against the band's 90th-percentile floor rather
than its median — two real bursts whose bands reach 2950 Hz against a 2885 Hz
edge read 23 and 25 dB "under" by the median, a hair from the bar, and 12 dB by
this. Measured margins: worst real emission 12.2 dB under, least codec ridge
44.1 dB under, both decoders. Twelve ridges set aside where one had been.

## 4. The classifier saw nothing

CLASSIFY on the strongest emission returned `unclear` in 0 ms. The worker is
handed a slice that starts at zero and the emission carried absolute times, so
it addressed samples past the end of the slice. Rebased, the same emission reads
`ook-morse` at 0.71. Pinned as a pure function, because a bug that costs 0 ms
is a bug that looks like an answer.

## 5. Settled

- The spectrogram is the SIGINT surface. Nothing on the left changes between
  SCOPE and SIGINT; only the rail does.
- Read a survey by the module's evidence, in the list it names, with what it
  set aside said out loud. Never by time, never by area.
- The content edge is the largest cliff. Decoders differ in their residue; the
  receiver's shoulder is the same in all of them.
- A band 30 dB under the receiver's own floor is not air, whatever the edge
  finder said.
- Anything handed to a worker on a slice is rebased to the slice.

## 6. What would overturn it

A receiver whose passband edge is under 15 dB — a very wideband front end into
a narrow codec — would leave the largest-cliff rule to the fallback. A
recording with genuine signal 30 dB under its own noise floor does not exist,
because that is what a noise floor is. The margins above are one file through
two decoders; the shelf's other 27 SIGNAL entries have not been surveyed this
way yet.
