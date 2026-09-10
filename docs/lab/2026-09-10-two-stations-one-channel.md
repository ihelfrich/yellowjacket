# 2026-09-10 — Two stations on one channel, and where the receiver was

A thirteen-minute recording of 5 MHz from February 2019 carries both NIST time
stations at once: WWV in Fort Collins and WWVH on Kauai. Both are keyed to the
same clock, so the difference in when their marks arrive is the difference in
how far they travelled. The recordist never said where they were. The recording
says something about it anyway.

This note records how that was measured, the three estimators that disagreed on
the way, and the one bound that decided which answers to keep.

## 1. The discriminator is free

WWV marks each minute with 800 ms of 1000 Hz and each second with 5 ms of the
same tone. WWVH uses 1200 Hz and 6 ms. That 200 Hz separation is the whole
reason a single-channel recording can be pulled apart at all.

First attempt used a 5 ms rectangular window, chosen because its first null sits
exactly 200 Hz from centre, so each station's tick should land in the other's
null. The fold of the 1200 Hz track then showed two humps 5 ms apart with a
notch between them, and the notch sat exactly on WWV's tick. That is not WWVH.
That is what a 1000 Hz burst looks like through a 1200 Hz detector whose window
only partly overlaps it: zero when the window contains the burst, non-zero on
either edge. The 1200 Hz track was reading WWV.

A 20 ms window fixes it — 50 Hz resolution, four resolution widths between the
tones — at the cost of smearing a 5 ms tick over 20 ms. That smear is identical
in both bands and this measurement is a difference of two smeared edges, so it
cancels. **Common-mode smear is free; common-mode leakage is not.**

## 2. WWVH is really there

Before measuring anything: average the magnitude spectrum of an 85 ms Hann
window at the top of each minute, and the same window thirty seconds later.

| | at the minute | 30 s later | rise |
|---|---|---|---|
| 1000 Hz | −30.7 dB | −67.1 dB | **36.4 dB** |
| 1200 Hz | −43.7 dB | −63.8 dB | **20.1 dB** |

A Hann window puts 1000 Hz leakage seventeen bins away far below −100 dB, so a
20 dB rise at 1200 Hz cannot be WWV. WWVH is present, about 13 dB down.

## 3. Three estimators, three answers

| estimator | Δt | spread |
|---|---|---|
| median fold of the second ticks | 13.25 ms | — |
| the 14 minute markers, peak-differenced | 16.30 ms | 5.9 ms |
| all 780 second ticks, peak-differenced | 9.18 ms | 6.0 ms |

Three numbers from one recording is not a result. Two faults were behind it.
The per-second estimator added the fold's phase offset to a difference that
already contained it — a double count worth 13 ms. And differencing two
independently located peaks throws away the shape of the burst: measured against
an injected 4.5 ms truth, that method came back 6.08 ms.

Correlating the two envelopes across the epoch, instead of subtracting two peak
positions, uses both edges and everything between them. On injected truths of
−9, 0, 4.5 and 12 ms it recovers all four inside 1 ms.

## 4. The bound is the referee

Fort Collins to Kekaha is 5,430 km, which light crosses in **18.1 ms**. No path,
ionospheric or otherwise, produces a larger arrival difference. So a per-epoch
value outside that is not a surprising result, it is a failed measurement, and
the module now drops it and says which epoch and why rather than letting a
median absorb it. Four of sixteen epochs went that way, including one at
−201.7 ms.

What survives:

```
arrival difference  13.24 ms   spread 3.39 ms over 8 epochs
path difference     3971 ± 359 km
bound               18.1 ms for this baseline · within it: true
```

Measured offline at 48 kHz and again inside the browser at the file's own
12 kHz, agreeing to 0.02 ms — which is the check that the estimator is not
reading its own resampling.

## 5. What this does not say

It does not give a position. One arrival difference gives a hyperbolic line of
position on the Earth, not a point, and the ionosphere adds path length the
geometry does not know about: the 3,971 km is a difference in **travelled**
distance, not in ground distance. Deriving a locus from it would need a hop
model, and this bench does not have one. What can be said is that 13.24 ms out
of a possible 18.1 ms puts the receiver well toward the Fort Collins end of the
baseline, which is where a continental-US listener would be.

The spread is not noise either. Per-epoch values run 8.4 to 16.0 ms across
thirteen minutes with no significant linear trend, which is what changing
propagation modes look like — one hop, two hops, and the dominant path changing
between them minute to minute. The module reports the spread rather than the
standard error whenever the two halves of a recording disagree by more than the
estimator's own resolution, because averaging a moving thing does not make it
stand still.

## 6. Settled

- A common-mode smear cancels in a difference; common-mode leakage does not.
  Choose the window to separate the tones, not to preserve the pulse.
- Correlate the envelopes; do not difference two peaks.
- Where physics bounds a measurement, apply the bound per sample and not only
  to the summary, and say which samples it rejected.
- A stability test needs a resolution floor. Three standard errors of a very
  precise estimator is finer than the estimator can resolve, and a constant
  6 ms delay was called unstable until that floor existed.

## 7. What would overturn it

A recording of the same pair from a known location. Everything above is
internally consistent and bounded, and nothing in it has been checked against a
receiver whose position was recorded. The 3,971 km is a measurement whose
accuracy is unknown, not a measurement known to be accurate.
