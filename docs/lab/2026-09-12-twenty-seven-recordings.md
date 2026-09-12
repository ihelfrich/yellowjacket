# 2026-09-12 — Twenty-seven recordings, and what the bench gets wrong

The SIGINT side of this bench has been built one measurement at a time, and
each of those measurements was made on the recording that motivated it. This
note runs the whole chain — survey, classify, three decoders — over every
signal recording on the shelf at once, and writes down what it gets right, what
it gets wrong, and which of the wrong answers are the interesting ones.

Twenty-seven recordings, first 120 seconds of each, decoded at their own
sample rate rather than resampled. The survey picks the emission with the
strongest evidence (lowest false-alarm exponent) and everything downstream runs
on that emission's band and time span, so a wrong verdict is sometimes a wrong
choice of what to look at rather than a wrong reading of it.

## What it reads

Two recordings return a message, and both are checkable against something
outside the bench.

| recording | what came back | check |
|---|---|---|
| M08, 11435 kHz, Cuban numbers | `DTTAA DTRUA NRIWN` ×5 at 15.2 wpm | machine keying, 79 ms unit, gaps at 3.000 and 6.986 units |
| NDB 332 kHz, beacon | `GTN` at 9.7 wpm | the beacon's own three-letter identifier |

M08's characters also map to abbreviated numerals, which the panel offers as a
second reading rather than as the reading: 64 of its 80 characters fit, giving
`80011 80[R]21 9[R][I]39`. And the WWV/WWVH recording carries a separate result
that this sweep does not produce, the 13.24 ms arrival difference measured in
the two-stations note.

The rest refuse. Five of the twenty-seven are tagged as carrying Morse, so most
of those refusals are the only correct answer available. Two are not.

## The two it should have read

**M12 at 11435 kHz.** There is Morse in this recording and the bench does not
return it. The survey's strongest emission is a 15-second span at the start,
which is splatter; the keying is in a narrow channel around 1 kHz from about
20 seconds on. Handed that span directly the decoder now fits a 70.4 ms unit
with a 3.33 dah/dit and 1 : 3.0 : 11.7 spacing — Morse-shaped, at 17.1 wpm —
and then refuses, because 28% of its characters sit against a gap belonging to
no fitted class. That refusal is honest: the text it would have printed is
`792 7TPEEM 79UM TTT ...`, which is not a numbers transmission, it is a
numbers transmission with elements missing. The fault is upstream, in which
emission the survey ranks first.

**The Marine Electric distress call.** 678–872 Hz, 38.3–47.9 s, and an SOS is
about as unambiguous as Morse gets. It refuses, with a dah/dit ratio between 9
and 16 against a shape test that expects 2 to 6. That looked like the shape test
being too strict. It is not. There are two separate faults, and neither is the
window.

**One: the span the survey ranked first is not keying.** Dumping its run lengths
directly, that ten-second emission holds four marks of roughly 1.05, 1.13, 1.08
and 1.02 seconds separated by gaps of about 2.0, 0.9 and 2.2 seconds, plus a
handful of runs under 30 ms. There is no dit class in it at all; the ratio of 9
to 16 is a second-long burst divided by a glitch. The bench is right to refuse,
and the interesting question moves upstream to why this span outranked the
keying.

**Two: where the keying is, the gaps are too short for the dits.** Scanning the
whole recording in twelve-second windows, nothing decodes, but the failures
separate cleanly. Four consecutive windows from 64 s to 100 s refuse on
"intra-character gap 0.58 to 0.71 units", and their marks are properly Morse:
around 56–140 ms and 270–380 ms, a dit and a dah about three to one, near
11 wpm. Their gaps run 20–90 ms — shorter than their own dits, which Morse
never is.

Marks long and gaps short by the same amount is the signature of a delayed
falling edge, so it was tested rather than assumed. Rendering a clean 12 wpm
signal and putting a one-pole release on its envelope reproduces it exactly:

| release τ | dit | dah/dit | intra-character gap | implied edge bias |
|---|---|---|---|---|
| none | 100 ms | 2.99 | 0.99 units | 0 ms |
| 10 ms | 107 ms | 2.87 | 0.87 units | 7 ms |
| 20 ms | 116 ms | 2.72 | 0.72 units | 16 ms |
| 40 ms | 136 ms | 2.46 | 0.47 units | 36 ms |

A slow decay — a receiver's AGC, or a transmitter's own envelope — displaces
every edge one way, so each mark grows by twice the bias and each gap shrinks by
twice the bias. The 0.72 row is the Marine Electric's 64–100 s windows almost
exactly.

That makes the correction algebraic rather than fitted. If a mark class and a
gap class are both supposed to be one unit, the bias is half their difference
and the unit is their mean. Nothing about that is tuned to this recording, which
is the property the merge-floor work above spent its whole budget trying to
have. It is not implemented yet, and implementing it is the single highest-value
thing left on this list.

## The merge floor, which is what changed today

The decoder had one rule for the shortest run it would treat as an element: a
quarter of the median run length. That is speed-free and correct exactly while
the median run is one unit long, which is true of Morse and false of Morse with
fast interference on top of it. M12 in a 100 Hz filter produces 5,262 runs with
a 3.6 ms median, so the floor falls to a millisecond, nothing is merged, and
the fitted "unit" is the interference: 4.8 ms, reported as 135 words per minute.

The rule stays, and a short ladder of absolute floors — 10, 20, 30, 45 ms — now
sits under it, reached only when the rule returns no fit or one too fast to be
keying. Three weaker designs were measured first and are worth recording
because each looked reasonable:

- **Every floor competes on scatter.** A floor large enough to swallow elements
  fits what is left more tightly than the truth. It turned `VVV` into `VVK`,
  read a deliberately 2:1 fist as Morse, and widened the unit interval to a
  factor of nine.
- **Escalate on any shape failure.** Milder, still wrong. A wobbly fist and a
  noise span both fit a plausible unit with the wrong shape, and a bigger floor
  is not what either of them needs.
- **A floor from the time-weighted median of the marks.** Rescues M12 and
  destroys the distress call, whose few long dashes lift that median above its
  own dits and leave three keyed runs.

The ladder carries its own risk, and it is not the one you would guess. A
single floor can cut a noise envelope into run lengths that fit: measured on
three seconds of bursty hiss, a 10 ms floor returned `RO KE` with 13 dB of
key-down contrast. The contrast is real — the bursts genuinely hold more power
than the gaps — so the gate that catches threshold splits of noise cannot see
it. What noise cannot do is answer twice. A fallback floor may now only stand
when a second floor lands within 15% of its unit, and that single rule removes
the whole class.

Cost, measured rather than assumed: the contrast gate's pinning case was
re-measured over sixty spans instead of edited to pass. Three spans answer when
that gate alone is disabled and all three are refused by it, where five did
before. The three that left are now refused earlier, by the two-floor agreement
rule — the same finding from the other side.

## What the classifier gets wrong

Seven verdicts are wrong and they fall into three kinds.

**Polytone read as something simpler.** XPA returns `fsk2` at full confidence
and XPA2 returns `am-tone`. Both are multi-tone Russian systems sending several
carriers at once; the classifier has no polytone class, so it names whichever
simple class the strongest pair of tones resembles. This is the honest failure
mode of a fixed class list, and the fix is a class, not a threshold.

**Tones read as voice.** X06 is six tones in a fixed rotation and comes back
`ssb-voice` at 0.9. The emission the survey handed it spans 54–2153 Hz, which
is a voice-shaped band, and the verdict is being driven by the bandwidth rather
than by what is in it. The selective-calling decoder, run on the same span,
refuses — the two disagree and the panel shows both, which is the right
behaviour, but the classifier should not be that confident.

**The buzzer read as nothing, or as a tone.** UVB-76 in its 2010 recording
comes back `noise` at 0.71 and in the 28-hour capture `am-tone` at 1.0. The
buzzer is a repeating 1.2-second tone burst, so `am-tone` is nearly right and
`noise` is not; the difference between the two recordings is which emission the
survey picked, not which signal it is.

Two more are simply `unclear`, which is the classifier declining rather than
failing: the 1942 Signal Corps code test (18–45 Hz transfer rumble and no
keyed tone at all — the decoder has always been right to refuse this one) and
the SAME weather test tone.

## Standing

- 79 test groups, 746 cases, zero failures.
- One recording on the list is still missing. The JJY item is valid and its
  audio is a 708 KB file, but archive.org is not reachable from this machine
  right now — the TLS connection fails outright rather than returning an error
  page. It is a fetch problem, not a licence problem.
- The Morse decoder's refusals are now dominated by two causes worth separate
  work, and neither is a threshold that wants loosening. The survey ranks the
  wrong emission first on both M12 and the distress call. And where there is
  readable keying under a slow envelope, the gaps are shortened by the same
  amount the marks are lengthened, which is measurable and removable.

---

# 2026-09-12, later — the edge-bias correction, and what it refused to fix

The correction described above is implemented. It is not what fixed the Marine
Electric, and the way it declined is the useful part of this entry.

## The estimator, and the test it has to pass

The bias comes out of two classes that are both supposed to be one unit: the
dit measures `u + d`, the intra-character gap measures `u - d`, so the bias is
half their difference and the unit is their mean. Every falling edge then moves
back by `d`; rising edges are untouched, which is the physical claim a release
makes.

Two classes produced that number, so every other class can refute it. A dah
must measure `3u + d`, a character gap `3u - d`, a word gap `7u - d`, and none
of those went into the estimate. On injected biases the model holds and the
correction returns the truth:

| injected release | uncorrected | corrected |
|---|---|---|
| 10 ms | 107 ms unit, 2.87 dah/dit | 100 ms, 3.00 |
| 20 ms | 116 ms unit, 2.72 dah/dit | 100 ms, 3.00 |
| 30 ms | — | 100 ms, 3.00, then refused on key-up power |
| none | 101 ms, 2.98 | not corrected at all |

The last row matters as much as the others. A correction that is always on is
not a measurement, and the decoder reports the bias it removed so a reader
knows the run lengths were touched.

## What it refused

On the Marine Electric's 64–100 s windows — the ones whose gaps are shorter
than their dits — the model is refuted outright by the class it did not use:

| window | fitted unit | bias | dah observed | dah predicted |
|---|---|---|---|---|
| 64–76 s | 47 ms | 4 ms | 402 ms | 145 ms |
| 80–92 s | 68 ms | 14 ms | 391 ms | 219 ms |
| 88–100 s | 52 ms | 12 ms | 328 ms | 167 ms |

The dashes are five to eight times the dits, not three. So the earlier entry
above was half right and should be read with this correction: those windows do
have gaps shorter than their dits, and that part matches a release, but the
whole distribution does not. Something else is going on in that recording, and
a two-class fit that happened to look like a known fault would have printed a
message out of it. The correction declined on all three windows, and the
decoder still refuses.

That is the outcome to want. The estimator was built from a synthetic fault
that reproduces cleanly, tested against the recording that motivated it, and
told the recording did not have that fault.

## Two other things this shook out

A guard added earlier the same day — reject a merge floor larger than 0.6 of
the unit it fitted, on the grounds that it must be merging elements — was
applying to the speed-free floor as well as the imposed ones. It is a quarter
of the span's own median run, so a large ratio there is a fact about the signal
rather than a choice made against it. Gating it threw away the right answer on
M12: three bandwidths fitting a 79–81 ms unit were rejected in favour of a
168 ms fit at 83% boundary doubt. The guard now applies only to imposed floors,
and M12 fits 79.0 ms at 15.2 wpm — the same unit the fallback ladder finds
independently. It still refuses, on missing elements.

And the correction was at first allowed to improve the number that selects
among candidates. Removing a bias mechanically tightens the classes, so a
corrected candidate outranked an uncorrected one for having been repaired
rather than for fitting better: it flipped the fade tracker on a 40%-jitter
fist that reads perfectly without it, and the fade-doubt gate then refused a
correct decode. Selection now uses the scatter measured before the correction.
The correction changes the verdict, never the ranking.

79 groups, 748 cases, zero failures.
