# 2026-09-03 · Cyclic modulation: the analysis core, and what it cost to make it honest

`js/analysis/cyclic.js`. A spectrogram answers "what frequencies are present"
and cannot answer "what is repeating", because it integrates over exactly the
time structure that carries a symbol clock. This computes that second axis.

## The estimator
An analysis STFT, then a second FFT along time through each frequency bin's own
envelope. Each envelope is divided by its own mean, so the output is
**modulation depth**, not energy: a quiet band modulated 40% reads 0.4 exactly
as a loud one does, which is what makes a watermark hiding tens of dB under
programme audio comparable with the programme. Verified: a true 0.40 reads
0.392 with a short window, 0.338 with the default one.

Band amplitude comes from summed **power** per group, square-rooted, not from
mean magnitude. A tone off a bin centre leaks into its neighbours in a pattern
that rotates every frame, so a single magnitude ripples when nothing is
modulating; summed power puts the leakage back together and the square root
keeps the depth interpretation.

## Four ways it lied, and what each cost
1. **Near-silent bins.** Depth is a ratio to a bin's own mean, so DC and empty
   bands divided numeric noise by almost zero and reported depths in the
   millions. Gated at −80 dB relative to the loudest band.
2. **Bins with no modulation at all.** Their median floor sits at the numeric
   noise, so any ripple over it looked enormous. A peak must also *be* a
   modulation: `MIN_DEPTH` 0.005.
3. **The threshold was below the noise maximum.** Over ~130 000 cells of true
   random noise the ratio to a bin's median floor has median 1.00, p99 5.0,
   p99.9 6.6 and a **maximum of 9.3**. A threshold of 6 therefore found about a
   dozen clocks in silence: measured across twelve noise realisations, 6 gives
   144 false peaks, 9 gives 18, **12 gives none**.
4. **The window was too short.** A carrier off a bin centre folds into its own
   envelope at `|f mod frameRate|`. Swept over 27 carriers from 400 Hz to 4 kHz:
   a 2048-point window invents a clock for 6 of them, 4096 for none. Wider bin
   groups barely help (6 → 4 → 3), so it is the window that governs.

## The one real trade, measured
A window is a low-pass on the envelope. Depth surviving, against a true 0.40:

| alpha | 21 ms | 43 ms | 85 ms |
|---|---|---|---|
| 2 Hz | 0.348 | 0.347 | 0.345 |
| 7 Hz | 0.392 | 0.381 | 0.337 |
| 12.5 Hz | 0.361 | 0.328 | 0.224 |
| 20 Hz | 0.344 | 0.269 | 0.099 |
| 45 Hz | 0.267 | 0.073 | — |
| 90 Hz | 0.075 | — | — |

Half the depth survives at about `1.28 / windowSeconds`. So the window follows
the cyclic ceiling rather than being chosen, at **2.56 / alphaMax** — twice what
sensitivity alone asks, buying a clean plane. Raising `alphaMaxHz` shortens the
window and trades cleanliness back for reach. That dial is the user's, and both
ends of it are documented rather than hidden.

## A detector that was built and then removed
A separate "many weak bands share one clock" detector was the original
watermark idea. To catch the planted three-band case it had to accept three
bands at 6× their floors, and at that setting eight noise planes invented 3.5
clocks each. It could not be made both sensitive enough to matter and clean
enough to trust, and the ordinary profile detector finds the same watermark
with zero false positives. So the band count survives as an **attribute** of a
detected periodicity (`peak.bands`) and not as a detector. An uncalibrated
detector is worse than no detector.

## What it finds now, all with zero false positives
| planted signal | found |
|---|---|
| 40% AM at 7 Hz on a 1 kHz carrier | 7.03 Hz, depth 0.338, in the 1 kHz bin |
| on-off keying at 12.5 Hz (a Morse dot rate) | 12.4 Hz, with 25.1 Hz marked as its harmonic |
| two bands at 1200 and 2600 Hz, 18% modulated by a shared 9 Hz clock, under noise 4× their amplitude | 8.91 Hz, reported in 3 bands |
| steady tones at 27 carrier frequencies | nothing |
| white noise, twelve realisations | nothing |

## A note on testing a detector for hidden regularity
The first noise fixture used a linear congruential generator, and it planted an
even comb of false clocks about 4.5 Hz apart — its lattice structure *is* a
periodicity. Xorshift and a cryptographic source plant none. A detector for
hidden regularity cannot be tested with a regular "random" source.

## Not yet built
The bench surface (rendering the alpha-versus-f plane), segmentation driven by
these signatures, and the first decoder. The signature table for real modes
(RTTY, PSK31, SSTV, PPM-family watermarks) is being written by a separate
review, in 2026-09-03-cyclic-spectrum.md.

## Correction after adversarial review: the window sets the reach, not the hop
The review's central finding, and my own transfer table already contained the
evidence. The magnitude of a bin is its subband **lowpassed by the analysis
window**, so a modulation at alpha is transferred with that window's own
response: for Hann, half amplitude at one bin width and a hard null at two. The
hop only decides whether what survives is aliased.

So the ceiling I shipped was a claim the estimator could not honour. At 48 kHz
the default window is 85 ms, bin width 11.7 Hz, null at **23.4 Hz** — while the
stated ceiling was 30 Hz. The measured transfer agrees exactly: a sinusoidal
modulation at 30 Hz read 0.013 of a true 0.40.

Fixed by reporting rather than pretending. `usableAlphaHz` (one bin width),
`nullAlphaHz` (two), and `reachedCeiling` are returned, and the search is
clamped to the null. The estimator no longer claims to have looked at a band it
is deaf to.

One prediction of the review did **not** hold. It expected the 8 kHz shelf
captures to be unusable, reasoning from a fixed 2048-point window (256 ms, null
at 7.8 Hz) that would erase every keying rate. `fftSizeFor` is rate-aware and
picks 512 samples at 8 kHz (64 ms, null at 31.3 Hz), so keying at 8, 16 and
25 Hz is found at both 48 kHz and 8 kHz. Verified before changing anything.

Square keying is still found past the null, because its harmonics and sidebands
reach back into the passband; the null bounds sinusoidal modulation.

## Taken from the review, not yet built
The cross-band statistic should pool **phase** coherently rather than count
bands: `gamma(alpha) = |sum_c exp(2i*phi_c(alpha))|^2 / Nc^2`, whose null
distribution is closed-form (`Nc*gamma ~ Exp(1)`), claimed at 15-20 dB of
effective gain against a watermark buried under masking audio. That is the
principled version of the detector deleted above, and unlike the count it can
be calibrated from theory rather than by sweeping. It is the next thing to
build, before the bench surface.
