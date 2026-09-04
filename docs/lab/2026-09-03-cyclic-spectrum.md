# 2026-09-03 · Cyclic modulation: the estimator, its signatures, and what it cannot see

Three reviewers judged this as a *proposal*. It is not one: the estimator ships.
`js/analysis/cyclic.js` (355 lines) is written, exported and covered by seven
passing cases in `test/run.mjs:5562-5706`. Nothing outside the test file imports
it — `rg -l cyclic` returns `test/run.mjs`, `js/analysis/cyclic.js` and one
unrelated hit in `docs/CONTRACT-PATTERN.md`. So the open question is not "build
which estimator" but **"is the built estimator correct, and what does it say".**

Everything below with a number attached was measured today against the shipped
code, not derived on paper. Where measurement contradicts the brief, the
reviewers, or the module's own comments, the measurement wins and the
contradiction is named.

---

## 0. Three corrections before anything else

The brief and all three reviews share a premise that is **false for this
estimator**, and it invalidates the headline arithmetic on both sides.

### 0.1 The alpha ceiling law is neither the brief's nor the reviewers'

The brief says the hop sets the ceiling (2.5 ms hop → 400 Hz frame rate → 200 Hz
alpha). All three reviewers correct this to the analysis window and derive a
Hann *magnitude* law: −6.02 dB at α = df, hard null at α = 2·df. That derivation
is right for the estimator they assumed. It is not this estimator.

`cyclic.js:161-163` does not take a bin magnitude. It sums **power** across a
group of bins and takes the square root:

```
let power = 0;
for (let k = lo; k < hi; k++) power += re[k] * re[k] + im[k] * im[k];
env[row + b] = Math.sqrt(power);
```

A magnitude-like quantity built from a power-like sum has a transfer between the
Hann law and the Hann-squared law. Measured, on the shipped code, 1 kHz carrier
at 40 % depth, `alphaMaxHz` 30 (N = 4096, df = 11.72 Hz), depth read in the
carrier's own channel:

| α Hz | 3 | 5 | 7 | 10 | 13 | 16 | 19 | 22 | 25 | 28 |
|---|---|---|---|---|---|---|---|---|---|---|
| u = α/df | 0.26 | 0.43 | 0.60 | 0.85 | 1.11 | 1.37 | 1.62 | 1.88 | 2.13 | 2.39 |
| **measured depth/m** | **0.95** | **0.86** | **0.74** | **0.67** | **0.57** | **0.43** | **0.29** | **0.17** | **0.11** | **0.06** |
| Hann magnitude (reviewers) | 0.96 | 0.89 | 0.79 | 0.61 | 0.44 | 0.27 | 0.13 | 0.03 | 0.02 | 0.02 |
| Hann² band power | 0.97 | 0.93 | 0.87 | 0.75 | 0.63 | 0.46 | 0.31 | 0.21 | 0.14 | 0.07 |

The measured curve is −3 dB at **u ≈ 0.72** (the Hann magnitude figure) but its
tail dies at **u = 3**, not u = 2 (the Hann² figure). There is no null at 2·df:
the reviewers' claim that α = 2·df is "a hard null" is wrong here by roughly
15 dB, and the module's own comment at `cyclic.js:36-40` ("falls to about half at
1.28 / windowSeconds") is right — measured 0.51 at u = 1.28.

**The law to write down:** usable to u ≈ 1.4 (−7 dB), dead past u ≈ 2.2 (−19 dB).
Since `fftSizeFor` (`cyclic.js:52-59`) sets N ≈ 2.56·fs/α_max, u = 2.56·α/α_max, so

> **usable α ≈ 0.55 × the displayed ceiling.**

At the default `alphaMaxHz` 30 the plane is drawn to 30 Hz and is trustworthy to
about **16 Hz**. That is the single most important number in this document and it
is currently nowhere in the UI or the code.

### 0.2 The dominant defect is aliasing, and nobody flagged it

`cyclic.js:131` sets `hop = floor(rate / (2 * alphaMaxHz))`, so the frame rate is
**exactly** 2·α_max and the alpha-Nyquist is α_max with *zero* guard band. The
window's stopband is nowhere near deep enough to cover that. Measured, 60 %
modulation, `alphaMaxHz` 30 (frame rate 60 Hz):

| true modulation | reported α | strength (× floor) |
|---|---|---|
| 40 Hz | **20.04 Hz** | 839 313 |
| 70 Hz | **9.96 Hz** | 606 489 |
| 100 Hz | **20.04 Hz** | 788 294 |

Every one is a confident, enormous, entirely fabricated clock at a frequency the
recording does not contain. `|40−60| = 20`, `70−60 = 10`, `|100−120| = 20`.

This is not a corner case; it fires on ordinary material, because every keyed or
switched signal has harmonics above the ceiling. The 20 WPM dot train reports
spurious lines at **6.68 Hz** and **9.96 Hz** with band counts of 103 and 104 —
those are the 4th and 3rd harmonics of the 8.33 Hz keying cycle folded back
(66.7 → 6.7, 50 → 10). PSK31 idle reports 26.25 Hz and 57.54 Hz alongside its real
31.29 Hz line; both are folded harmonics. At 8 kHz the dot train fabricates 1.82
and 10.16 Hz the same way.

**Fix, measured:** `hop = floor(rate / (4 * alphaMaxHz))`. Re-run of the 40 Hz
case with the frame rate at 120 Hz reports **39.96 Hz**, correctly. Cost is 2×
the stage-1 FFTs. Draw the plane to α_max and keep the top half of the computed
alpha axis as an unrendered guard band.

### 0.3 The 8 kHz shelf is *not* nulled — reviewers 2 and 3 are wrong

Both reviewers built an alarm on "N = 2048 at 8 kHz nulls everything above
7.8 Hz, so Morse is invisible on `m08-2009` and `uvb76-2010`". That assumes a
fixed window. `fftSizeFor` is rate-adaptive (`cyclic.js:53-59`), so df tracks the
sample rate and u is rate-invariant:

| rate | α_max | N | df Hz | channel Hz | frame rate |
|---|---|---|---|---|---|
| 48 000 | 30 | 4096 | 11.72 | 187.50 | 60.0 |
| 44 100 | 30 | 2048 | 21.53 | 172.27 | 60.0 |
| 8 000 | 30 | 512 | 15.63 | **31.25** | 60.2 |
| 8 000 | 60 | 256 | 31.25 | 31.25 | 121.2 |

The 8 kHz material is in fact the *better* case: the channel is 31.25 Hz wide
instead of 187.5 Hz, so a 170 Hz RTTY shift is resolved there and is not at
48 kHz. A 20 WPM dot train at 8 kHz reports its 8.34 Hz keying cycle at strength
440 199. Nothing is nulled.

Note the exact invariant, worth keeping: **channel width = fs / (2 · maxBins)**,
independent of the window. Frequency resolution is set by `maxBins` alone
(`cyclic.js:28,138,168`); alpha reach is set by the window alone. That clean
separation is the best structural property the module has.

---

## 1. The estimator to implement

Stages, as built. Stage 1 `envelopeMatrix` (`cyclic.js:119-172`), stage 2
`modulationSpectrum` (`cyclic.js:185-238`), floor `binFloors` (`cyclic.js:243-258`),
reduction `alphaProfile` (`cyclic.js:269-293`), naming `findPeriodicities`
(`cyclic.js:303-331`).

### 1.1 Parameters

| parameter | value | why |
|---|---|---|
| `alphaMaxHz` | user-facing; presets 5 / 30 / 60 / 120 | The one knob. Everything else is derived from it. Presets in Hz, never in samples, so the same preset means the same thing at 8 kHz and 48 kHz. |
| window N | `2.56 · fs / alphaMaxHz`, clamped [256, 8192] (`cyclic.js:52-59`) | 2.56 is a **false-positive** constant, not a sensitivity one: the module's comment (`cyclic.js:41-47`) records that a 2048-point window at 48 kHz invents a clock for 6 of 27 swept carriers and 4096 for none. Keep it, and pay for it by labelling the usable ceiling at 0.55·α_max. |
| usable α | **0.55 × alphaMaxHz** (−7 dB point) | Measured §0.1. The displayed ceiling is ~2× beyond the trustworthy one. This must be drawn, not just documented. |
| hop | **`fs / (4 · alphaMaxHz)`** — change from the shipped `fs / (2 · alphaMaxHz)` (`cyclic.js:131`) | Zero guard band is the cause of the fabricated lines in §0.2. 4× gives one octave of margin and the fabricated 20 Hz line becomes a correct 40 Hz line. |
| `maxBins` | 128 default; **512 when α_max ≥ 60** | Channel = fs/(2·maxBins) = 187.5 Hz at 48 kHz/128. A 170 Hz FSK shift does not fit in that, so mark and space land in one channel and their alternation cancels as a constant envelope. 512 gives 46.9 Hz channels and resolves it. |
| grouping | sum of power over `group` bins, then sqrt (`cyclic.js:161-163`) | Keep. It is what makes the transfer die at 3·df instead of 2·df. But it does **not** flatten the carrier-position ripple — measured across `maxBins` 128 → 1024 the ripple is unchanged (1.122, 1.122, 1.122, 1.124), so reviewer 1's "group by 4 to flatten it" mitigation is measurably false. |
| per-bin pre-transform | `(env/mean − 1)`, Hann, scaled `2/Σw` (`cyclic.js:220`) | Makes the reading modulation **depth**, dimensionless, so a 10 % modulation reads 0.1 on a loud channel and a quiet one. This is the correct answer to "how do I make bands comparable" and it is already right. |
| level gate | `MIN_BIN_LEVEL = 1e-4` relative to the loudest channel (`cyclic.js:66`) | Depth is a ratio to the channel's own mean; a near-silent channel divides noise by nearly zero. Also the MP3-band case: everything above ~16 kHz is zeroed by the codec, and `field-library.js:195-199` serves MP3 by default. |
| depth gate | `MIN_DEPTH = 0.005` (`cyclic.js:72`) | A ratio to a floor is not enough on its own: an unmodulated channel's floor sits at numeric noise. A peak must also be a modulation something could decode. |
| floor | median of depth across α, per channel (`cyclic.js:241-258`) | A periodogram of noise is exponential, so its mean is dragged by its own tail; the median is not. Robust, and it does not let a real line raise the floor it is tested against. |
| threshold | `DEFAULT_THRESHOLD = 12` × floor (`cyclic.js:79`) | Calibrated, not chosen: across twelve noise realisations at two window lengths, 6 gives 144 false peaks, 9 gives 18, 12 gives none. Keep. |
| `bands` | count of channels ≥ `SPREAD_THRESHOLD = 6` × floor (`cyclic.js:88,287`), attached to a detected peak (`cyclic.js:345`) | The watermark discriminator, and correctly demoted from a detector to an attribute: the comment at `cyclic.js:80-87` records that a standalone spread detector had to drop to 3 bands at 6× to catch the planted watermark and then invented 3.5 clocks per noise plane. |
| selection length | Δα = frame rate / frames, and `frames = largestPow2AtMost(available)` (`cyclic.js:134`) | **Defect:** the power-of-two truncation discards up to half the selection. Measured at α_max 30: a 60 s selection uses 34.1 s, a 120 s selection uses 68.3 s. Δα is up to 2× worse than the selection implies. Fix by zero-padding to the next power of two instead of truncating to the previous one. |

### 1.2 Sensitivity, measured

One band amplitude-modulated at 7 Hz, tone 20 dB under broadband noise, 16 s:

| depth m | 0.5 | 0.3 | 0.2 | **0.1** | 0.05 | 0.03 |
|---|---|---|---|---|---|---|
| strength (× floor) | 72.3 | 44.2 | 29.7 | **15.8** | 0 | 0 |

**The single-band detection floor is ~10 % modulation depth at 16 s.** Below
that the peak does not clear 12× and is not reported at all. Longer selections
help as √frames; the PPM case below shows a 40 s → 90 s selection roughly
doubling strength (54 → 101).

### 1.3 Carrier position is a real and large error term

The depth reading depends on where the carrier sits inside an FFT bin (period
df). Sweeping the carrier across one 187.5 Hz channel in 12.5 Hz steps:

- at α = 7 Hz (u = 0.60): depth/m runs 0.82 – 1.12. Quantitative to ±15 %.
- at α = 20 Hz (u = 1.71): depth/m runs **0.26 – 1.75**. A factor of 6.6, −11.6 to +4.9 dB.

So depth is a *measurement* below u ≈ 0.6 and an *indication* above u ≈ 1.3.
Grouping does not fix it (§1.1). State it in the readout rather than pretending
the number is calibrated across the whole plane.

---

## 2. Signature table

All rows measured today against the shipped `analyseCyclic`, 48 kHz unless
noted. `bands` is the attached band count; `@` is the channel centre in Hz.

| signal | expected α (Hz) | where in f | measured | distinguisher |
|---|---|---|---|---|
| **Static / noise** | none | — | no clock (10 s xorshift) | The negative control. Note the module's own warning at `test/run.mjs:5578-5581`: an LCG plants a false comb ~4.5 Hz apart. A detector for hidden regularity cannot be tested with a regular "random" source. |
| **Tonal carrier** | none | — | no clock at 1490, 1000, 1031.25, 937.5, 2600 Hz | A steady tone has no envelope. If one appears, the window is too short and the carrier is leaking into its own envelope — that is what `WINDOW_ALPHA_PRODUCT` 2.56 buys. |
| **Morse, machine-sent dot train, 12–25 WPM** | element rate = WPM/1.2 → 10.0 / 12.5 / 16.67 / 20.83 Hz; **the on-off cycle is half that**: 5.0 / 6.25 / 8.33 / 10.4 Hz | carrier channel carries the half-rate; the **element rate appears in the wideband splatter channels** | 20 WPM: 8.32 Hz ×30 385 @750 Hz (b=1) **and** 16.64 Hz ×66 735 @6563 Hz (b=105) | The two-line signature is diagnostic and was not predicted by any reviewer: keying edges spray broadband clicks at every transition, i.e. at the element rate, while the carrier's own channel sees the on-off cycle at half that. A wideband line at exactly 2× a narrowband line = hard keying. |
| **Morse, hand/text-sent, 12–25 WPM** | **no element line** | 750 Hz carrier channel | 20 WPM text: 0.82 / 2.23 / 3.05 / 4.57 Hz, all ×16–54; 12 WPM: 1.64 / 2.70 / 3.52 Hz | Reviewer 3 is right and the brief is wrong. Real Morse is a variable-length code; the envelope autocorrelation carries word and character rhythm (0.8–5 Hz), not a spike at the dot rate. Strengths are 3 orders of magnitude below the dot train. **Do not promise a Morse line.** The `m08-2009` (machine) vs `marine-electric-sos` (hand) contrast is the demo. |
| **RTTY 45.45 baud** | **6.06 Hz = baud/7.5** (Baudot framing: 1 start + 5 data + 1.5 stop), *not* 45.45 | mark/space channels, 2125/2295 Hz | framed: **6.09 Hz** ×18 b=3 @2297 Hz, 2nd harmonic 12.13 Hz; unframed random bits: **nothing** | The whole reviewer panel predicted α = 45.45. Measured: balanced random NRZ has a continuous envelope spectrum and no baud line at all. The line comes from the *framing*, and it is weak (×18 against a threshold of 12). Requires `maxBins` 512 at 48 kHz or the 170 Hz shift falls inside one channel. |
| **RTTY 50 baud** | **6.67 Hz = 50/7.5** | 2109–2297 Hz | **6.68 Hz** ×15 b=128, harmonic 13.30 Hz | Same mechanism. 45.45 vs 50 baud are separated by 0.6 Hz, so Δα ≤ 0.2 Hz → ≥ 20 s of frames after the power-of-two truncation, i.e. a ≥ 40 s selection. |
| **PSK31 (31.25 baud)** | 31.25 Hz **when idling**; nothing when sending data | all channels (the amplitude dip is broadband) | idle: **31.29 Hz ×1 690 629 b=128**; random data: 31.29 Hz ×15 b=128 | PSK31 idle is continuous phase reversals, and each reversal takes the envelope to zero — a 100 %-modulated broadband line, the strongest thing in this whole table. With data it is ~5 orders of magnitude weaker. Needs α_max 60 (so N = 2048, u = 1.33). Its harmonics alias badly (§0.2). |
| **SSTV / WEFAX** | WEFAX 120 lpm → **2.000 Hz**; 90 lpm → 1.5 Hz; SSTV Martin M1 → 2.240 Hz; Scottie S1 → 2.336 Hz | the sync-pulse channel, 1200–1500 Hz, plus the video band 1500–2300 Hz | WEFAX: **1.99 Hz ×23 943 b=34** @2438 Hz with a full harmonic comb (3.98/5.98/8.03/10.02/12.01, all marked harmonics); Martin M1: 2.23 Hz ×34 b=3 | A strong low-α fundamental **with a long harmonic comb** and a moderate band count (b≈34) = a line-scan raster. Separating M1 (2.240) from WEFAX (2.000) needs Δα ≤ 0.1 Hz → ≥ 20 s of frames. |
| **Speech** | syllabic **4–6 Hz**, broad not sharp | every channel (b = 128) | 4.5 Hz synthetic: **4.45 Hz ×68 b=128**, harmonic at 9.02 Hz | Full band count with a *broad* peak and low strength. The contrast against a watermark is the band count's location, not its size: speech lights all 128 channels including 10–20 kHz where nothing could be hidden. |
| **Music** | beat = BPM/60 → **2.0 Hz at 120 BPM**, with a harmonic comb | all channels, strongest at low f | 120 BPM: **1.99 Hz ×1936 b=128** @0 Hz, comb at 3.98/5.98/7.97/9.96/11.95 | Same all-band signature as speech but sharper and stronger, concentrated at low f. This range (1.0–3.3 Hz) is exactly what `js/analysis/beattrack.js:44-51` already covers — see §5.3. |
| **PPM-family watermark** (Nielsen CBET) | **comb at multiples of 1/4.8 s = 0.2083 Hz**, symbol rate 2.5 Hz = the 12th multiple | ~10 channels between 1 and 3 kHz | −20 dB, 40 s: 0.63 (3×) ×54, 1.45 (7×) ×24, 2.30 (11×) ×13, 3.75 (18×) ×15 — **every one at b=10**; 90 s: ×101/×46/×23/×28; −30 dB, 40 s: one peak ×19 | **`bands` = 10 is the signature**, and it is what distinguishes a watermark from everything else in this table. Not the peak height. The comb spacing (message repetition) is sharper and more falsifiable than the 2.5 Hz symbol rate. Needs α_max 5–10 (so the comb is not crushed) and ≥ 60 s. |
| **Ultrasonic beacon** | symbol/OOK rate, typically 5–50 Hz | 18–20 kHz, **two or three channels only** | 19 kHz OOK at 10 Hz: **9.96 Hz ×63 b=2 @18938 Hz** | b = 2 with the energy above 18 kHz. The killer caveat: this band survives only in the `hi` FLAC variants. MP3 zeroes above ~16 kHz and `field-library.js:195-199` + `readPref()` default the shelf to `light` MP3 — so the channel is gated dead by `MIN_BIN_LEVEL` and the beacon cannot exist. Refuse the readout on a `light` variant rather than reporting "no beacon". |

### 2.1 The false-positive row that matters

A coherent gain ripple applied to **every** channel — the MP3 bit-reservoir /
block-switch artifact the reviewers warned about — mimics a watermark clock
exactly. Measured, at 13.89 Hz (MPEG-2.5 frame rate at 8 kHz):

| ripple depth | 1 % | 2 % | 5 % | 10 % | 20 % |
|---|---|---|---|---|---|
| detected | no | no | ×22, b=3 | ×45, b=33 | ×82, b=127 |

So the codec risk is real but bounded: **below ~2 % band-gain ripple it is
invisible to this estimator**, and when it does fire it fires with a band count
that climbs toward *all* channels — including bands where no watermark could
hide. That is the discriminator: a PPM watermark gives b≈10 confined to
1–3 kHz; a codec artifact gives b→128 spanning the whole spectrum. Label the
known frame rates on the α axis (MP3 at 44.1 k: 38.28 Hz frame / 76.56 Hz
granule; MPEG-2 LSF at 22.05 k: 38.28; MPEG-2.5 at 8 / 11.025 k: 13.89 / 19.14;
AAC at 44.1 k: 43.07) so a hit there reads as *codec*, not *discovery*.

---

## 3. What the magnitude estimator cannot see, and what it costs here

1. **Anything carried in phase alone.** MSK, GMSK, continuous-phase FSK, and a
   hard-limited PSK with no amplitude notch produce a flat envelope and a blank
   plane. *Cost here:* small but not zero. The FSK cases on the shelf are saved
   by an accident — observed through a channel narrower than the shift, each tone
   is gated on and off, so the envelope does modulate. That rescue fails at
   48 kHz with `maxBins` 128, where the 187.5 Hz channel swallows a 170 Hz shift
   whole. *Recovery:* the STFT is already complex at `cyclic.js:150`. A second
   per-bin series — unwrapped Δarg between frames — runs through the identical
   stage-2 machinery for one `atan2` per bin per frame. The repo already has the
   pattern for a phase-continuous demodulate at `js/analysis/modal.js:118-159`.

2. **Conjugate cyclic features at α = 2·f_c.** The BPSK squaring line lives in
   the conjugate SCD. *Cost here: none.* On receiver-demodulated audio the
   "carrier" is an audio subcarrier at 800–2000 Hz, so the line would land at
   1.6–4 kHz — two orders of magnitude off an axis that tops out at 120 Hz — and
   the subcarrier is already a visible stripe on `js/spectrogram.js`. If it is
   ever wanted, it is two FFTs of the raw selection (square, look for a line
   where the PSD shows none), not a plane.

3. **Signed α.** `sqrt(power)` is real, so its transform is conjugate-symmetric
   and +α and −α are indistinguishable. *Cost:* one thing only — sweep direction,
   which is diagnostic for SSTV/WEFAX mode identification. Free to recover if
   the complex series of (1) is ever built.

4. **Which f a feature sits at, below channel resolution.** The plane says
   "the 2109 Hz channel", not "2125 Hz". *Cost:* low, and it is the price of the
   `maxBins` invariant that makes cross-band comparison cheap. Recover with a
   narrow second pass on one channel when a cell is flagged.

5. **Coherent-vs-noise discrimination.** The estimator cannot tell a real 1 kHz
   WWV tone from a narrowband QRM ridge of equal power. *Cost:* occasional, and
   **already solved elsewhere in the repo** — `js/analysis/modal.js:195-203`
   computes `|Σz| / Σ|z|` over a heterodyned envelope, which is exactly that
   test. Wire it as a click-a-stripe readout on the spectrogram; do not build it
   into this plane.

6. **Noise-like (DSSS) watermarks.** An additive spread watermark 20–25 dB under
   programme audio has no envelope signature and no chip-rate handle inside one
   channel. *Cost:* this is stated goal (b) and the honest answer is that neither
   this estimator nor a browser-side FAM can do it. The watermarks actually
   likely to be met in broadcast audio are **tonal** (CBET/PPM, Kantar), and for
   those this estimator is not a compromise — it is the correct detector, because
   the signature is an amplitude periodicity shared across separated bands, which
   is precisely what `bands` measures. Split the claim in the UI the way
   `js/analysis/soundscape.js:12-23` already splits the NDSI's caveats: state the
   scope rather than burying it.

7. **What it invents.** Listed here because it costs more than anything in 1–6:
   aliased harmonics (§0.2), and depth readings that swing 6.6× with carrier
   position above u ≈ 1.3 (§1.3).

---

## 4. The honest novelty claim

**The mathematics has no novelty whatever.** "STFT, then FFT along time through
each bin" has been independently named in at least five literatures: the
modulation spectrogram (Greenberg & Kingsbury 1997; Atlas & Shamma 2003), SRMR
for speech quality, fluctuation patterns / rhythm patterns in MIR (Pampalk 2001;
Lidy & Rauber 2005), the modulation power spectrum in bioacoustics (Singh &
Theunissen 2003), and — the name this module should use — the **cyclic
modulation spectrum** (Antoni, *MSSP* 2007), where it is explicitly introduced as
the cheap alternative to the SCD. The α-profile of a broadband envelope is the
Fourier tempogram (`librosa.feature.fourier_tempogram`). Shipping
implementations exist in MATLAB, Python and R.

**Two naming corrections a knowledgeable reader will make in the first
paragraph, both free to fix:**

- The surface is **not** a cyclic spectrum and does not establish
  cyclostationarity in Gardner's sense. It is a second-order statistic of the
  envelope; it detects periodic amplitude modulation. Call it the *modulation
  spectrum (α × f)* or *cyclic modulation spectrum*. The module header at
  `cyclic.js:1-22` already gets this nearly right; the word "cyclostationary"
  should not appear in the UI.
- "Spectral coherence" already means the *normalised SCD* in this literature.
  The `bands` statistic is a count. Call it **band support**, never coherence.

**What is defensible, in this exact shape:** *an interactive α × f modulation
surface computed entirely client-side in a browser, over an operator-selected
region of ordinary audio, with a band-support statistic, aimed at symbol-clock
and watermark discovery in radio and broadcast captures.* Every ingredient is
standard; the assembly and the target application appear to be unshipped.
That is a modest tool claim, and it survives.

**Do not write:** "a new way to see cyclostationary structure", "novel cyclic
modulation spectrum", "first to apply cyclostationary analysis to audio".

**Two claims I could not verify from here and which must be checked before any
public copy is written** (no network access was used for this note):

- IQEngine, a browser-based client-side RF tool, reportedly merged a
  "Cyclostationary processing tab" (PR #939, 2024-09-15). If that runs in the
  browser it kills the unqualified "no one renders a cyclic surface in a browser"
  claim. Ten minutes at iqengine.org settles it.
- The Tempogram Vamp plugin (Bussey, QMUL) reportedly puts an interactive
  α-versus-time surface inside Sonic Visualiser and Audacity today. That is not
  an α × f surface, so it does not kill the claim above, but it narrows it.

**On the SCD rejection:** the framing "cheap variant vs full SCD" is a false
dichotomy in one respect worth recording. Antoni, Xin & Hamzaoui (*MSSP* 92,
2017) compute the phase-coherent spectral correlation **from the same STFT this
module already has**, with no uncertainty-principle wall. Spooner's objection is
that it only wins when α_max is a small fraction of fs — about 4 %. Here α_max
≤ 120 Hz out of 48 kHz is 0.25 %. The premise that justifies the shortcut is
exactly the regime where the "expensive" option is cheap. Build the cheap one
first — it is built — and record that the upgrade is a cross-bin product away,
not a rewrite. Also, restate the cost argument correctly: in a browser the SCD's
binding constraint is its **output size** (order 10⁷ complex points, tens of MB
before rendering), not its flop count. "Roughly 1 % of the cost" invites a
benchmark argument that does not need having.

---

## 5. The bench surface

### 5.1 What is rendered

Three coupled panes over one operator-chosen selection.

- **The α × f plane.** α on **x**, log-spaced from 0.05 Hz to α_max; f on **y**,
  log, same mapping and same channel order as the spectrogram so the two panes
  align by eye. Cell value = depth ÷ that channel's floor (the same ratio
  `alphaProfile` reduces at `cyclic.js:286-288`), painted through the existing
  byte-LUT path.
- **The α profile**, directly beneath and x-aligned: `profile[]`, the strongest
  channel at each α, with the 12× threshold drawn as a horizontal rule and
  `findPeriodicities` results labelled.
- **A band-support strip**: `spread[]` at each α, 0–128. This is the watermark
  readout and it needs its own lane because its shape (b≈10 confined vs b→128
  spanning) is the discriminator, not its height.

Three fixed overlays: the **transfer curve** `depth/m` vs α from §0.1 drawn
across the plane so the roll-off is visible and the usable ceiling at 0.55·α_max
is a drawn line, not a footnote; the **labelled artifact rates** (codec frame
rates, 50/60/100/120 Hz mains, 1.000 Hz WWV); and a **Δα readout** stating the
resolution *and the seconds actually used*, since `largestPow2AtMost` can discard
half the selection (§1.1).

### 5.2 Do not reuse the display STFT or `SpectrogramView`

Four independent blockers in the display path, all cited:

- `workers/spectrogram-worker.js:48` picks frames as
  `Math.floor((c * totalFrames) / cols)` — a **non-uniform** decimation with up to
  one hop of jitter once the clip exceeds `maxCols` 8000. Uniform sampling in t
  is the entire premise of an FFT along time; that jitter smears every α line.
- `workers/spectrogram-worker.js:60` quantises dB to one byte, 0.35 dB per step
  (`js/render/spectrogram-quant.js:5-6`). A watermark tone 20 dB under its band
  moves a bin ~0.4 dB — one step.
- `workers/spectrogram-worker.js:11` clamps at MIN_DB −90, a hard nonlinearity
  that reports exactly zero modulation for quiet bins.
- `js/spectrogram.js:224` posts `fftSize: 2048, hop: 512` — fixed, unrelated to
  any α target.

`cyclic.js` already runs its own STFT and is correct to. Likewise the view class:
`timeAtX`/`xAtTime` (`js/spectrogram.js:279-292`) are time-specific and
`_freqScale` pins the axis to `sampleRate/2` with `F_MIN = 20`
(`js/spectrogram.js:10,759-764`). Reuse the **quantiser and the LUT paint
pipeline**; make the axis layer a sibling class.

### 5.3 Interaction the analysis actually needs

1. **Selection-driven, never whole-file.** The plane is a statement about a
   stationary stretch. Take the spectrogram's existing drag selection as the
   input, and refuse below the Δα floor for the chosen α_max rather than
   silently returning a smooth, empty surface — a user who drags 400 ms and sees
   nothing will conclude the recording is featureless when the α axis had two
   bins in it.
2. **Click an α line → light the channels that carry it, back on the
   spectrogram.** This is the whole point of the coupling: `peakBin[]` and the
   per-channel ratios already exist (`cyclic.js:269-293`); mapping a channel index
   to a frequency band is `b * binHz`, and `yAtFreq` (`js/spectrogram.js:301-307`)
   already turns that into pixels. A watermark then *shows itself* as ten
   horizontal ticks between 1 and 3 kHz.
3. **A preset selector in Hz** (5 / 30 / 60 / 120) with the derived N, channel
   width, Δα and usable ceiling displayed. Not a sample count.
4. **A refusal gate on provenance.** `js/audio-engine.js:100-108` records
   `decodeReport.downgraded` / `upsampled` / `reason` when the browser resampled
   the file. A polyphase resampler at a non-integer ratio injects its own
   periodic structure. Gate the plane on that report and say why. Likewise
   surface the `light` MP3 vs `hi` FLAC variant (`field-library.js:195-199`) next
   to any band-support detection.

### 5.4 Coupling to segmentation

This is where the feature earns its keep for goal (a). The α profile is a
**per-segment feature vector**, and the signature table is already a classifier:

| region | rule from this estimator |
|---|---|
| static | no peak clears 12× |
| tonal carrier | no peak, but one channel far above the rest (`means[]`, `cyclic.js:204-211`) |
| speech | broad peak 4–6 Hz, b = 128, low strength |
| music | sharp peak 0.5–4 Hz with a harmonic comb, b = 128, concentrated at low f |
| data burst / keying | strong peak with harmonics, b small (1–5), confined in f; a wideband line at exactly 2× a narrowband one = hard keying |
| watermark candidate | comb at a sub-Hz spacing, b ≈ 10, confined to 1–3 kHz |

Run it on a sliding window and the segmentation falls out of the same numbers.

### 5.5 The doctrine question

Per `~/.claude/CLAUDE.md`: *what existing surface does this eliminate?*
`js/analysis/beattrack.js:44-51` computes a comb-weighted autocorrelation of the
onset envelope over 60–200 BPM — that is α ∈ [1.0, 3.3] Hz — on an envelope
sampled at fs/512 (`js/analysis/onsets.js:5-6`), with a musical prior baked in
(`PRIOR_CENTER = 120` BPM, `beattrack.js:7`). The α profile is a strict
generalisation of it: per-band, prior-free, and reaching from 0.05 Hz to 120 Hz.
Two independent tempo answers from one bench is a defect. Either fold the beat
tracker's tempo estimate into the α profile, or state plainly that the beat
tracker keeps the musical prior on purpose and the α profile is the prior-free
instrument. Do not ship both silently.

---

## 6. Test plan: signals whose answers are known before the code runs

The existing seven cases (`test/run.mjs:5592-5706`) already cover AM depth,
false-clock immunity, keying harmonics, the planted watermark, window/hop
derivation, the silence gate, and threshold calibration. These are the additions
the measurements above demand. Each has an analytic answer.

**A. Anti-aliasing (the §0.2 defect — this is the regression that must fail
today and pass after the hop change).**
Modulate a 1 kHz carrier at 40 Hz, 70 Hz and 100 Hz with `alphaMaxHz` 30.
Assert **no** peak is reported in 0–30 Hz. Currently reports 20.04, 9.96 and
20.04 Hz at strengths 8×10⁵–8×10⁵. Then assert that at `alphaMaxHz` 60 the 40 Hz
modulation is reported at 40 ± 0.2 Hz.

**B. The transfer law.** AM at 40 % depth, carrier on a bin centre, α swept 3–28
at `alphaMaxHz` 30. Assert depth/m falls monotonically through 0.95 → 0.06 and
crosses 0.707 at u = 0.72 ± 0.05. This pins the law in §0.1 and will catch any
change to the grouping or the window.

**C. Carrier-position error bound.** Sweep the carrier across one channel in
12.5 Hz steps at α = 7. Assert depth/m ∈ [0.75, 1.25] — quantitative. Repeat at
α = 20 and assert only that the peak is *found*, not its depth. This encodes
"depth is a measurement below u ≈ 0.6 and an indication above it".

**D. WWV, the end-to-end acceptance test.** 5 ms of 1000 Hz once per second,
ticks omitted at seconds 29 and 59 (this is the real NIST format, and
`wwv-1991` is on the shelf at 48 kHz FLAC, `field-library.js:96-99`). 90 s.
Assert: a peak at 1.000 ± 0.02 Hz located in the 1 kHz channel; a harmonic comb
at 2, 3, 4, 5, 6 Hz all marked as harmonics; and — the prediction that validates
the α axis and the resolution claim together — **1/60 Hz sidebands flanking the
1 Hz line**. Measured today at Δα = 0.0146, ratio-to-floor across
α = 0.9667 / 0.9833 / 1.0000 / 1.0167 / 1.0333 was **5.7 / 33.2 / 105.0 / 76.5 /
4.2**. The sidebands are there and the shoulders are clean. Nothing else on the
shelf has an exactly known α.

**E. Morse, both kinds, as one test.** A continuous 20 WPM dot train must give
8.33 Hz in the carrier channel *and* 16.67 Hz with a band count > 50 in the
splatter channels, the second at least 2× the first in strength. Real Morse text
at the same WPM must give **no** peak within 1 Hz of 16.67, and its strongest
peak must be below 5 Hz. This is the machine-vs-hand contrast and it is the
honest correction to "Morse produces an α line".

**F. FSK framing.** RTTY at 45.45 baud with Baudot framing (1 start + 5 data +
1.5 stop = 7.5 units), `maxBins` 512, 20 s: assert a peak at 6.06 ± 0.15 Hz in
the 2125/2295 Hz channels. The same generator with *unframed balanced random
bits* must produce no peak at 45.45 or at 6.06. Then 50 baud → 6.67 ± 0.15 Hz,
and assert the two are resolved as distinct peaks.

**G. PSK31 idle vs data.** Continuous reversals at 31.25 baud with a cosine
amplitude notch, `alphaMaxHz` 60: assert a peak at 31.25 ± 0.2 Hz with
`bands` = 128 and strength > 10⁵. The same at random data: assert strength drops
by at least three orders of magnitude. Encodes "detectable when idling, not when
sending".

**H. The PPM positive control.** Ten tones spaced across 1–3 kHz, 400 ms
symbols, a 12-symbol message repeating every 4.8 s, under a broadband masker,
`alphaMaxHz` 10, ≥ 60 s. Assert peaks at integer multiples of 0.2083 Hz and that
**every reported peak has `bands` between 8 and 12** — the band count is the
assertion, not the height. Then assert the same construction 10 dB weaker
produces at most one peak. **State plainly in the test comment that nothing on
the SIGNAL shelf carries a PPM watermark** — the shelf is 1942–2019 public-domain
shortwave (`field-library.js:96-134`) and CBET is a US broadcast practice from
~2007 — so this synthetic *is* the only positive control until a US FM/AM stream
is captured. A watermark detector validated only against negatives is not
validated.

**I. The codec mimic, as a deliberately-broken baseline.** Apply a coherent gain
ripple to every channel at 13.89 Hz. Assert: 1 % and 2 % produce no detection;
20 % produces a detection with `bands` > 100. The second half is the point — it
proves the test could have failed, and it fixes the discriminator (b→128 spanning
the whole spectrum = artifact; b≈10 confined to 1–3 kHz = candidate).

**J. Ultrasonic gating.** A 19 kHz OOK beacon at 10 Hz under noise at 48 kHz:
assert a peak at 10 ± 0.3 Hz with `bands` ≤ 4 above 18 kHz. Then low-pass the
same signal at 16 kHz (the MP3 condition) and assert the peak is **gone** and the
channel is inactive (`spectrum.active`) — not that it reads zero modulation. The
UI consequence is that a `light` variant must refuse the readout rather than
report "no beacon".

**K. Selection-length honesty.** Assert `envelope.seconds` and `Δα` for
selections of 4, 8, 20, 60, 120 s. Today: 2.13 / 4.27 / 17.07 / 34.13 / 68.27 s
used, Δα 0.469 / 0.234 / 0.059 / 0.029 / 0.015 Hz. Whatever the fix to
`largestPow2AtMost` (`cyclic.js:134`), the reported Δα must match the frames
actually transformed, and the UI must show the seconds used, not the seconds
selected.

---

## What this settles

1. The estimator is built and its structure is sound: power-summed grouped
   channels, depth normalisation, a median floor, a calibrated 12× threshold, and
   band support demoted from detector to attribute. The parameters were measured,
   not chosen, and the module's own comments record the measurements.
2. Its α-ceiling law is neither the brief's (hop) nor the reviewers' (Hann
   magnitude, null at 2·df). Measured: −3 dB at 0.72·df, dead by 3·df, **usable
   to 0.55 × the displayed ceiling**.
3. **The shipped hop has zero anti-alias margin and fabricates large, confident
   peaks at wrong frequencies.** This is the one defect that makes the surface
   lie, and the fix is one constant.
4. The 8 kHz half of the shelf is fully reachable; that alarm was based on
   assuming a fixed window.
5. Two of the brief's headline targets do not behave as promised: real Morse has
   no element line, and FSK has no baud line — it has a framing line at baud/7.5.
6. The novelty is assembly-and-application, not mathematics, and two prior-art
   checks remain open because this note was written without network access.
