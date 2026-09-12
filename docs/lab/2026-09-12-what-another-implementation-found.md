# 2026-09-12 — What a second implementation found, and what it is worth keeping

Nyquist and Yellowjacket both measure loudness and true peak to the same ITU
standard, in two languages, on the same machine. Neither had ever been run
against the other. Reading one against the other took an afternoon and found a
defect that had been in this repository since the meter was written.

This note records the defect, why the existing test could not see it, and the
two things built so the comparison does not have to be repeated by hand.

## The defect

`truePeakLinear` took its maximum over the four interpolated polyphase outputs
and never over the input samples. The samples are points on the reconstructed
waveform, so the maximum has to include them; without them the function could
report a peak below the sample peak, which no waveform goes below.

Measured on 0.5-amplitude tones whose crest lands exactly on a sample, at 44.1,
48, 96 and 192 kHz:

| tone, as a fraction of the sample rate | under-read |
|---|---|
| 0.05 | 0.006 dB |
| 0.20 | 0.107 dB |
| 0.25 | 0.168 dB |
| 0.45 | 0.590 dB |

Nyquist's TruePeak.swift states the rule in its header — "samples included so
TP >= sample peak". It is not a subtle point once written down. Nobody had
written it down here.

Two accidents limited the damage. `peakTrack`, which feeds the limiter, has
always started each sample's maximum at the sample itself. And
`truePeakChunked` in loudness.js seeds its running peak with the sample peak,
so every reported dBTP on the bench was correct. The one unguarded consumer is
the drum voice ceiling, where content at 96 kHz sits low in the band and the
error is nearer 0.03 dB than 0.6.

## Why the test could not see it

The fixture is a quarter-rate sine at phase pi/4. Its samples land at plus and
minus 0.707 of the crest, 3.01 dB below it, and never on it. In that
configuration the samples contribute nothing to the maximum, so omitting them
is free. The test was well designed for the intersample case and blind to the
ordinary one.

That is the general shape of the problem. Every test group in this suite checks
this code against itself: a value is computed once, eyeballed, and pinned. That
catches drift. It cannot catch a mistake present from the first run, because
the mistake is in the pin.

## What was kept

**A conformance fixture** at `test/fixtures/bs1770-conformance.json`, read by
`test/cases-bs1770-conformance.mjs`. Ten cases whose expected values are
derivable from the signal by hand: the published 48 kHz coefficient table, the
same filter redesigned at 44.1 kHz, the standard's calibration tone at four
rates, the gate on silence, a sample sitting on a crest, and the classic
quarter-rate intersample peak. Each carries a `why` explaining how its answer
is known without running code, and one test asserts every case has one.

That rule is the whole point. A golden file records what the code printed; a
conformance case records what the answer is. Only the second kind can fail for
the right reason.

The group was checked by putting the bug back. Two cases fail, naming the
44.1 kHz rate/2.22 tone reading 0.58 dB under its own sample peak and the 4x
under-read blowing its budget. A test that has never failed proves nothing.

The signal spec is written into the file — exact formulas, no library calls —
so Nyquist can read it from this path rather than vendoring a copy.

**A measured bound instead of a claim.** The module's header used to promise
"fs/4 intersample accuracy +0.063 dB" and that a peak detector "should err
high, never low". It does not err high, and no 4x detector does. Over rational
frequency ratios from 0.05 to 0.45 of the rate and 64 phases each, the worst
under-read is 0.199 dB at 0.40 of the rate. Raising the Kaiser beta makes it
worse, not better:

| design | worst under-read |
|---|---|
| 4x, 12 taps per phase, beta 5 | 0.163 dB |
| 4x, 12 taps, beta 6 (Nyquist's) | 0.174 dB |
| 4x, 12 taps, beta 7 (ours) | 0.199 dB |
| 4x, 12 taps, beta 8 | 0.241 dB |
| 4x, 24 taps, beta 9 | 0.168 dB |
| 8x, 12 taps, beta 7 | 0.197 dB |
| 8x, 24 taps, beta 9 | 0.110 dB |

The limit near Nyquist is the filter's roll-off, not the oversampling density:
8x with the same taps barely moves it. Halving the under-read costs four times
the work, which is not worth a tenth of a decibel, so the design stays and the
bound is written down. A reader who needs headroom at the top of the band takes
0.2 dB off the ceiling.

## The other direction

Nyquist's ABX had no counterpart here. The bench could compare two takes only
with the labels showing, which answers what the rack does and not whether it
can be heard. `js/abx/trial.js` and the BLIND A/B panel close that, and the
parts worth recording are the refusals rather than the test.

A session refuses in two different ways and says which. Four perfect trials is
one chance in sixteen, which cannot clear 0.05 however good the listener is, so
it reports "4 trials cannot reach p <= 0.05 even with a perfect score" rather
than "not shown" — and it says how many are needed before the session starts.
A null result reports what it is entitled to: "6 of 12 correct, p = 0.613. This
does not show the two are identical: a listener who heard the difference 87% of
the time would usually have failed this session too." The 87% is computed, not
decorative — it is the per-trial rate that session length catches four times in
five — and a test asserts the sentence never contains an unhedged claim of
sameness.

Two smaller decisions that were bought rather than assumed. The hidden sequence
is balanced rather than independently random, because in an unbalanced session
a listener who always answers "A" beats chance for no reason; driving the real
panel with twelve "A" answers scored exactly 6 of 12, which is that property
working. And the binomial tail was off by one in its first version, reading a
perfect five as 5 in 32 instead of 1 in 32. The hand-computed cases caught it
on the first run, which is the same argument as the rest of this note.

## Settled

- A test written from the implementation's own output can only catch drift.
  Where an external standard exists, at least one case should be derivable
  without running the code.
- When two implementations of one standard exist, reading them against each
  other is cheap and finds different things than testing either alone. This is
  the code version of the cross-model review rule already in force here.
- State bounds, not intentions. "Errs high, never low" was an intention. The
  0.199 dB is a bound, and a change that makes it worse now fails.
- A listening test's null result is a bound on the difference, never a claim
  that there is none.

## What this does not settle

Nothing here has been run against a reference meter from outside either
project. The 48 kHz coefficients come from the published table, and the
calibration tone from the standard's own definition, but the intersample
figures are self-consistent rather than externally checked. A commercial meter
or the EBU test set would be the next referee, and neither has been applied.
