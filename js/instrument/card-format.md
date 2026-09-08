# Instrument card format, version 1

A card is one analysed object at one size. JSON, versioned, editable.

| field | meaning |
|---|---|
| `version` | 1 |
| `id` | first 16 hex of sha256 over the source samples |
| `source` | `name`, `sampleRate`, `seconds`, `license`, `note` (what was dropped, fit dB) |
| `modes[]` | `freqHz`, `tauSec` (time to 1/e), `amp` (linear), `phase` (rad) — exactly `fitModal`'s fields, sorted by frequency |
| `damping` | `model` `constant-q` or `power`, `q0`, `exponent`, `r2`; Q(f) = q0·f^exponent, with Q = π f τ |
| `family` | `kind` string/bar/cantilever/membrane/plate/bell/unknown, `confidence` (0–1: how well the ratios fit that family; 0 when `kind` is `unknown`), `margin` (0–1 gap to the runner-up), `dist` (the charged distance the gate reads, `null` when nothing was scored), `inharmonicity` B (string only), `arch` (bar only), `ratios` of the lowest six modes |
| `nonlinearity[]` | optional; `{ mode, hzPerAmp, r2 }` — frequency shift per unit amplitude, measured on the hit's own decay; absent means linear |
| `residual` | the fitter's residual, first 100 ms, peak-normalised, float32 little-endian base64 |
| `hits[]` | optional; measured `{ position, hardness, modesAmp[] }` surface (reserved for the recording session; the engine reports whether it used theory or data) |
| `retune` | optional; `{ target, cents[] }` written by `applyRetune`; the physical card is the one without it |

## Reference ratio sets (`FAMILY_RATIOS`)

`tunedBar` (1 : 3.23 : 6.99 : 10.51 : 15.75) is measured, not derived:
University of Iowa MIS orchestral bells C5–B5, anechoic, 24 cards over two
mallets, 2026-09-06. It is not a family of its own: `bar` is fitted with one
parameter, `family.arch`, interpolating log-ratios from the free bar (0) to
this set (1). The arch is fitted **and scored over every measured ratio** —
reading it from the first two overtones and then scoring it on those same
three numbers was in-sample, and put a wine glass inside the gate at 1.8 %
(docs/lab/2026-09-07-classifier-honesty.md). Only modes within 40 dB of the
strongest and with a Q of at least 40 vote on the family (`RATIO_GATE_DB`,
`RATIO_GATE_Q_MIN`), and `cardPitchHz` is the lowest of those. `RATIO_GATE_Q_MIN`
is a Q, not a cycle count: Q = π f τ, so a Q of 40 is 40/π ≈ 13 cycles of ring.
A string hypothesis needs at least half its comb present, and a card with fewer
than `MIN_VOTING_MODES` = 3 voting modes is not scored against the table at all
— two modes are one informative ratio, since the first is 1 by construction,
and one ratio is placed by *some* family for 80.7 % of all ratios in 1…19.
`nonlinearity[].cents` records the pitch shift a law implies over the hit's
own amplitude range; laws under 12 cents are dropped as tracker drift.


Ratios of the lowest modes to the lowest, from N. H. Fletcher and T. D.
Rossing, *The Physics of Musical Instruments*, 2nd ed. (Springer, 1998):
free–free bar (ch. 2, Euler–Bernoulli: 1 : 2.756 : 5.404 : 8.933 : 13.34 : 18.64);
clamped–free bar (1 : 6.267 : 17.55 : 34.39 : 56.84 : 84.91); ideal circular
membrane (ch. 3: 1 : 1.594 : 2.136 : 2.296 : 2.653 : 2.918); free circular plate,
ν ≈ 0.33 (1 : 1.73 : 2.33 : 3.91 : 4.11 : 6.30); church bell partials relative
to the hum (ch. 21, hum : prime : tierce : quint : nominal : deciem =
1 : 2 : 2.4 : 3 : 4 : 5); stiff string f_n = n f_1 √(1 + B n²) (ch. 2).

Classification: each measured ratio to its nearest reference ratio, mean
|log| distance; the string family instead fits B on a grid to 0.02. Every
hypothesis then pays for what it did not explain, on the same terms:

    dist = err × fitOptimism(n) / coverage + COVERAGE_PENALTY × (1 − coverage)

`fitOptimism(n) = n/(n − 1)` is charged only by the two hypotheses with a free
parameter fitted to the same ratios they are scored against — `bar` (arch) and
`string` (B). Being a multiplier it cannot charge a fit that left no residual
at all, which is why the three-mode floor above is a rule and not a price.
`coverage` is the share of the reference's slots that a measured ratio fills
within 5 %, counting the slots up to **10 % above** the highest measured ratio
— not up to it. A mode sitting just under a slot is evidence for that slot:
without the headroom Iowa A5 is charged for missing the free bar's 8.933 when
its top partial at 8.828 is 1.2 % away (bar coverage 0.33 without it, 0.50
with). It cuts both ways, charging an unfilled slot up to 10 % above the top
measured mode — fdr-vowel's sixth harmonic (string comb 0.60 without, 0.50
with). The measure is the same for every family including `string`: the
string's reference is not the fixed six-element set but
the comb 1…N built out to the highest measured ratio, since a string's
harmonics do not stop at 6. Coverage used to be `indices.size / max(indices)`
for `string` alone — distinct rounded harmonic numbers over the largest one,
which never asked how near its integer a ratio sat, so a hemisphere at
1 : 1.7 : 2.4 : 3.2 rounded to {1, 2, 3} and scored a full 1.00 comb. That was
nearly inert while `dist` and `score` were separate numbers; it is not inert now
that one `dist` ranks, gates and is reported.

`family.confidence` is that distance on the gate's own scale,
`max(0, 1 − dist / UNKNOWN_DISTANCE)`: 1 at no distance, 0 at the gate and
beyond. It says how well the object matches the family named beside it, and
nothing else. The gap to the runner-up is `family.margin`, 1 − best/second,
which is a different question — two families the ratios fit equally well is not
the same failure as fitting none. `margin` below 0.25 (`UNKNOWN_MARGIN`), or a
distance over 6 % (`UNKNOWN_DISTANCE`), makes the family `unknown`, and the
engine then scales uniformly with no position dependence. An `unknown` card
reports `confidence` 0 whichever gate refused it: the number says how well the
ratios fit *the family named beside them*, and there is none. `dist` is `null`
only when nothing was scored — under three voting modes — and otherwise records
what the winning hypothesis measured, gate or no gate. A human may override
`family.kind`; the ratios stay recorded.
