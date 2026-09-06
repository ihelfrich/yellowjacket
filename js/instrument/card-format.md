# Instrument card format, version 1

A card is one analysed object at one size. JSON, versioned, editable.

| field | meaning |
|---|---|
| `version` | 1 |
| `id` | first 16 hex of sha256 over the source samples |
| `source` | `name`, `sampleRate`, `seconds`, `license`, `note` (what was dropped, fit dB) |
| `modes[]` | `freqHz`, `tauSec` (time to 1/e), `amp` (linear), `phase` (rad) — exactly `fitModal`'s fields, sorted by frequency |
| `damping` | `model` `constant-q` or `power`, `q0`, `exponent`, `r2`; Q(f) = q0·f^exponent, with Q = π f τ |
| `family` | `kind` string/bar/cantilever/membrane/plate/bell/unknown, `confidence` (0–1 margin to the runner-up), `inharmonicity` B (string only), `ratios` of the lowest six modes |
| `nonlinearity[]` | optional; `{ mode, hzPerAmp, r2 }` — frequency shift per unit amplitude, measured on the hit's own decay; absent means linear |
| `residual` | the fitter's residual, first 100 ms, peak-normalised, float32 little-endian base64 |
| `hits[]` | optional; measured `{ position, hardness, modesAmp[] }` surface (reserved for the recording session; the engine reports whether it used theory or data) |
| `retune` | optional; `{ target, cents[] }` written by `applyRetune`; the physical card is the one without it |

## Reference ratio sets (`FAMILY_RATIOS`)

`tunedBar` (1 : 3.23 : 6.99 : 10.51 : 15.75) is measured, not derived:
University of Iowa MIS orchestral bells C5–B5, anechoic, 24 cards over two
mallets, 2026-09-06. It is not a family of its own: `bar` is fitted with one
parameter, `family.arch`, interpolating log-ratios from the free bar (0) to
this set (1) on the first two overtones. Only modes within 40 dB of the
strongest vote on the family (`RATIO_GATE_DB`), and `cardPitchHz` is the
lowest of those. A string hypothesis needs at least half its comb present.
Confidence is scaled by the share of reference slots a measured mode fills.
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
|log| distance; the string family instead fits B on a grid to 0.02.
Confidence is 1 − best/second. Below 0.25, or with a best distance over 3 %,
the family is `unknown` and the engine scales uniformly with no position
dependence. A human may override `family.kind`; the ratios stay recorded.
