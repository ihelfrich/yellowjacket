# 2026-09-07 — The family classifier was scoring the bar in-sample

The question: when the INSTRUMENT panel prints `tuned bar (82%)` under a wine
glass, is the 82 % a measurement or an artefact?

An artefact. `classifyFamily` fitted the bar's one free parameter, `arch`, on
`ratios.slice(0, 3)` and then scored the hypothesis on those same three
numbers, while every other family was scored with `ratioDistance` over all six
measured ratios. `dist` is what `UNKNOWN_DISTANCE` gates, so the bar entered
the gate having already bent toward the only evidence the gate would see.
Anything with a plausible second and third partial passed. Shells — glasses,
bowls, cups, hemispheres — have no model in `FAMILY_RATIOS` at all, and were
labelled `bar` at high confidence rather than "no known family". The gate had
effectively stopped firing on objects the table cannot describe.

## 1. Before: every card in `docs/lab/cards/`

`familyScores` run over each card's stored modes. `dist` is the number the gate
reads, from the winning hypothesis whether or not it survived the gate.

| card | before | | | after | | |
|---|---|---|---|---|---|---|
| | kind | dist | arch | kind | dist | arch |
| iowa-bells-plastic-ff-E5 | bar | 0.0038 | 0.92 | bar | 0.0143 | 0.92 |
| iowa-bells-brass-Cs5 | bar | 0.0012 | 1.06 | bar | 0.0425 | 1.08 |
| iowa-bells-plastic-ff-Cs5 | bar | 0.0123 | 1.06 | bar | 0.0220 | 1.12 |
| iowa-bells-plastic-ff-A5 | bar | 0.0112 | 0.68 | bar | 0.0520 | 0.68 |
| freesound-wineglass | **bar** | 0.0184 | 0.94 | **unknown** | 0.0963 | — |
| carillon-bell | unknown | 0.0388 | — | unknown | 0.0810 | — |
| uvb76-buzz | unknown | 0.0509 | — | unknown | 0.0830 | — |
| ory-chord | bell | 0.0175 | — | bell | 0.0175 | — |
| hiawatha-vowel | string | 0.0092 | — | string | 0.0110 | — |
| fdr-vowel | unknown | 0.0334 | — | **string** | 0.0400 | — |
| commons-bell-15cm, crystal-bowl-d, freesound-bell-single, opz-thud, wwv-tone | unknown | — | — | unknown | — | — |

The last five have one voting mode each and never reach the scoring
loop; they are unknown for a different and correct reason.

The `after` column above is the first pass. A second pass the same day (§4)
changed what the card reports and normalised the string family's coverage;
fdr-vowel's row moved again, and §4's table is the current one. A third pass (§8) closed two
holes an adversarial checker found in the first two, and moves **no card in
this table**: every `kind`, `confidence`, `margin` and `dist` in §4.2 is the
same before and after it.

## 2. What the measurement decided, including what it killed

Scoring the arch over all the measured ratios is the fix, but on its own it
puts a **real** bell outside the gate. Iowa A5's partials are 1 : 3.171 :
6.429 : 8.828; its fourth sits at the free bar's 8.933 while its second and
third sit near arch 0.85, and no single arch holds all three. Scored that way
it lands at 0.052 — **worse than the wine glass at 0.043** (the first row of
the table below). So no threshold on
that number orders a real bar ahead of a shell, and the two levers named in the
brief (soften the charge, move `UNKNOWN_DISTANCE`) both fail: A5 is outside
0.03 even with the charge set to zero, and any threshold admitting it admits
the glass, the carillon bell and the UVB-76 buzz too.

Three designs were measured and rejected on the numbers:

| design | Iowa A5 | wine glass | carillon bell | verdict |
|---|---|---|---|---|
| one-parameter arch, scored over all ratios | 0.0520 | 0.0432 | 0.0570 | orders the glass ahead of a real bell |
| two-parameter arch (`a + s·slot`), charged n/(n−2) | 0.0351 | 0.0489 | **0.0109** | buys A5 nothing and manufactures a bar out of a carillon bell |
| median residual instead of the mean | 0.017 | 0.048 | **0.007** | robust to one unplaceable partial — which is exactly what the carillon has |

What separates A5 from the glass is not distance at all. A5 fills every
reference slot it spans (coverage 1.00); the glass fills half (0.50) — it has
no partial anywhere near a bar's 3.2× second, the most diagnostic thing a bar
has. `slotCoverage` already measured this and was worth 0.02 on a `score` the
gate never read.

## 3. What changed

`js/instrument/card.js`. Every hypothesis now produces one number, on the same
terms, and the gate reads it:

- **The arch is fitted and scored over all the measured ratios.** No hypothesis
  is scored only where its own fit was allowed to look.
- **A fitted free parameter is charged** `fitOptimism(n) = n/(n − 1)`: a model
  that bent toward the same n ratios it is scored against has n − 1 residual
  degrees of freedom, so its mean residual understates its error by that
  factor. It is the correction that makes a sample variance unbiased, it has no
  tunable knob, and `bar` (arch) and `string` (B) both pay it. The fixed
  references have nothing to bend and do not.
- **The untested share of a hypothesis is charged at the rate the tested share
  earned**: `dist = err / coverage + COVERAGE_PENALTY · (1 − coverage)`. A
  reference slot no measured mode reached is a prediction the object never
  tested. The flat term is retained because it is load-bearing — a perfect
  harmonic series ties `string` and `bell` at distance zero, which no
  multiplicative term can separate; without it `1:2:3:4:5` classifies as
  nothing at all (this is what caught it, in `review fixes`).
- **`score` is gone.** There is one distance, and the gate, the ranking and the
  confidence margin all read it. The defect lived in the gap between the number
  that ranked and the number that gated.
- **`UNKNOWN_DISTANCE` 0.03 → 0.06**, stated: on the charged distance the four
  Iowa bells span 0.014–0.052 and the nearest object with no model in the table
  is half again past the worst of them — carillon bell 0.081, UVB-76 buzz
  0.083, wine glass 0.096. The old 3 % was calibrated against an in-sample bar
  distance; it is not a number that survives its own basis being corrected.
- `familyScores(modes)` is exported — the sorted candidates with their distance
  and coverage. `classifyFamily` is now a thin reader of it, and the honesty of
  a card can be inspected without re-deriving the scoring.
- **`family.confidence` is the fit, not the margin** (§4), and the margin is
  returned beside it as `family.margin`. `UNKNOWN_CONFIDENCE` is renamed
  `UNKNOWN_MARGIN`, because that is the quantity it gates and always was.
- **The string family's coverage is measured the way every other family's is**
  (§4.3).

One card changed label beyond the target in this first pass: **fdr-vowel** went
unknown → string at 0.040, on a string coverage of 1.00. §4.3 shows that 1.00
was an artefact of how the string family alone measured coverage, and the card
ends the day back at unknown. The reasoning below is superseded; it is kept
because it is what a lax coverage measure lets you talk yourself into:

> A voiced vowel is a harmonic comb, its sibling hiawatha-vowel already read as
> a string, and the fdr card's own stored family says `"kind": "string",
> "note": "read at harmonics of f0; treated as a comb"`. This is the classifier
> agreeing with what the card already recorded, not a new error.

## 4. Second pass: the number beside the label was a margin

`instrument-controller.js:95` takes `family.confidence` and prints it as a
percentage beside the family name. `classifyFamily` computed it as
`1 − best.dist / second.dist` — the gap to the runner-up. That answers "how
much better is this family than the next one", not "how well does this object
match the family I just named", and those are different questions with
different answers.

The clean counterexample is 600 · 1957.4 · 4613 Hz — ratios 1 : 3.26 : 7.69.
The nearest arch is 0.0249 away, which is a mediocre fit inside a 0.0600 gate;
the next family is 0.5815 away, twenty-three times further. It printed **96 %**.

It is not only a constructed case. Two shipped cards invert:

| card | family | charged distance | old number | new number |
|---|---|---|---|---|
| hiawatha-vowel | string | 0.0110 | 0.76 | 0.82 |
| iowa-bells-plastic-ff-A5 | bar | 0.0519 | 0.80 | 0.13 |

A5 fits its family 4.7× worse than the vowel fits its own, and carried the
larger number, because A5's runner-up happens to be far away (`cantilever`,
0.262) and the vowel's happens to be near (`bell`, 0.047). Nothing about that
ordering is a statement about either object.

### 4.1 What it is now

    family.confidence = max(0, 1 − dist / UNKNOWN_DISTANCE)

The charged distance on the gate's own scale: 1 at no distance, 0 at the gate
and beyond. It introduces no constant that was not already load-bearing. The
margin is kept, because it still gates — two families the ratios fit equally
well is a different failure from fitting none — and is returned as
`family.margin`; `dist` is returned too, so a stored card records the number it
was scored at instead of only a ratio of two numbers it does not carry.
`UNKNOWN_CONFIDENCE` is renamed `UNKNOWN_MARGIN` for the same reason: it gates
the margin, and never gated a fit.

Nothing about the *labels* changes here — the gate is unchanged — but the
percentage falls on every card that is not a close fit, most of all on the real
bells, which is the honest direction. Iowa A5 printing 13 % is the measurement:
it is the worst real bar in the set, 0.0081 inside a 0.0600 gate.

### 4.2 Every card, again

`old` is `1 − best/second` as shipped this morning; `new` is the fit. `dist` is
the charged distance of the winning hypothesis, before → after §4.3. Five cards
have one voting mode each and never reach the scoring loop.

| card | kind | old | new | dist |
|---|---|---|---|---|
| iowa-bells-plastic-ff-E5 | bar | 0.975 | 0.762 | 0.0143 |
| iowa-bells-plastic-ff-Cs5 | bar | 0.958 | 0.633 | 0.0220 |
| iowa-bells-brass-Cs5 | bar | 0.888 | 0.292 | 0.0425 |
| iowa-bells-plastic-ff-A5 | bar | 0.802 | 0.134 | 0.0520 |
| hiawatha-vowel | string | 0.764 | 0.817 | 0.0110 |
| ory-chord | bell | 0.767 | 0.709 | 0.0175 |
| **fdr-vowel** | **string → unknown** | 0.594 | 0.000 | **0.0400 → 0.0900** |
| carillon-bell | unknown | 0.888 | 0.000 | 0.0810 |
| uvb76-buzz | unknown | 0.157 | 0.000 | 0.0830 |
| freesound-wineglass | unknown | 0.784 | 0.000 | 0.0963 |
| commons-bell-15cm, crystal-bowl-d, freesound-bell-single, opz-thud, wwv-tone | unknown | 0.000 | 0.000 | — |

The carillon bell (0.888) and the wine glass (0.784) are the defect in its
plainest form: objects the table has no model for, sitting 0.081 and 0.096 from
the nearest family, storing a confidence of four-fifths and up. The panel never
printed those — it prints no percentage beside `unknown` — but
`scripts/instrument-card.mjs:44` does, and the number is in the card JSON on
disk. Under the fit they are 0, which is what "no known family" should read.

### 4.3 The string family measured coverage differently, and it is no longer inert

Every family's `coverage` came from `slotCoverage`: the share of the reference's
slots that a measured ratio fills **within 5 %**, counting the slots at or below
`ratios[last] × 1.1` — a 10 % headroom above the highest measured ratio, not the
highest measured ratio itself. The headroom is load-bearing and cuts both ways:
it raises Iowa A5's `bar` coverage from 0.33 to 0.50 (its top partial at 8.828
fills the free bar's 8.933, 1.2 % above it) and lowers fdr-vowel's string comb
from 0.60 to 0.50 (charging it for an unfilled sixth harmonic 6.0 % above its
top mode). The string family alone used `indices.size / max(indices)` — the count of
distinct rounded harmonic numbers over the largest one. That is a different
quantity, and a strictly laxer one: rounding cannot fail. A hemisphere at
1 : 1.7 : 2.4 : 3.2 rounds to {1, 2, 3} and scored a full 1.00 comb on partials
15 % and 20 % away from a harmonic.

While `dist` and `score` were separate numbers this was nearly inert. It is not
inert now: `coverage` divides the error in the one `dist` that ranks, gates and
is reported, so a family measuring its own coverage on an easier test buys a
smaller distance with it. The string's reference is now the comb 1…N built out
to the highest measured ratio — a string's harmonics do not stop at the six in
`FAMILY_RATIOS.string` — and `slotCoverage` reads it like any other.

**One card changes label: fdr-vowel, string → unknown**, dist 0.0400 → 0.0900.
Its coverage was 1.00 and is 0.50. The measurement that settles it is how far
each partial sits from the harmonic it was rounded onto:

| card | deviation of partials 2–6 from the nearest harmonic |
|---|---|
| hiawatha-vowel | −1.3 %, −1.1 %, −1.0 %, −1.1 %, −1.0 % |
| fdr-vowel | −2.1 %, 0.0 %, **−5.9 %, −5.8 %, −5.7 %** |

Being a comb is the whole content of the string hypothesis, and fdr-vowel's top
three partials are not on the comb — they are 4:5:6 of a *different*
fundamental, about 5.8 % below the one its own lowest voting mode implies. The old
measure could not see that, because it asked which integer each ratio was
nearest and never how near. hiawatha-vowel, built from the same fireside-chat
pipeline, is a real comb and keeps its label at a higher confidence than before
(0.76 → 0.82). §3's defence of fdr-vowel ("the classifier agreeing with what the
card already recorded") was leaning on a stored label that the same lax measure
produced; it does not survive.

**What is actually wrong with fdr-vowel is its f0, not its comb.** Fitting a
comb spacing by least squares through its twelve lowest voting modes
(f_n = n·d, minimising over d) gives d = 198.20 Hz, and its lowest voting mode
sits at 206.5 Hz — **4.2 % sharp of its own comb**. Per-partial, f_n/n runs
206.5, 202.1, 206.5, 194.5, 194.5, 194.8, 196.1, 195.9, 197.8, 198.9, 198.3,
200.8: a spoken vowel's pitch drifting across a 0.38 s window, which the modal
fitter records partial by partial. Divide the same six partials by 198.20
instead of by 206.5 and every one of them lands within 4.2 % of an integer —
1.042, 2.040, 3.126, 3.924, 4.908, 5.897 — inside the shared 5 % window, all
six slots filled, coverage 1.00.

So `unknown` is a true statement about the numbers the classifier is handed and
a false one about the object: FDR's vowel is a driven harmonic sound and it is
a comb. The classifier's blind spot is that it normalises by the lowest
measured mode and has no way to say "these are harmonics of something I did not
measure". That is a defect in f0 estimation, not in the coverage rule, and it
is not fixed by exempting the string family from the measure every other family
passes — which is what the retired `indices.size / max(indices)` did. Recorded
in §7 as the named limitation it is; the coverage normalisation stands.

This is a knife edge and is recorded as one: fdr's −5.7 % misses a 5 % window by
0.7 points. But it is the *shared* window — every family's coverage has that
same edge at 5 %, and normalising did not add a constant, it stopped exempting
one family from the one already there. Nothing else moves: hiawatha, uvb76 and
ory-chord have string coverage 1.00 under both definitions, and the carillon
bell and wine glass fail the half-comb test under both.

## 5. This changes audio, not only a label

`js/instrument/body.js:35` picks the radiation filter by family, and a card
that flips to `unknown` loses the bar's shelf. Measured on the 64-tap FIR at
48 kHz, `bar` against `unknown`: **+0.01 dB at 1 kHz, +1.62 dB at 3 kHz,
+2.92 dB at 6 kHz and above**. Two more couplings follow the same label:
`family.js:56` returns a flat 1 for every mode of an `unknown` card, so strike
position stops shaping timbre; `excite/bow.js:27` bows an `unknown` card as a
string.

So a wine glass carded today renders about 3 dB darker above 6 kHz than one
carded yesterday, and stops responding to strike position. That is the point —
it was being given a bar's radiation on a label that was not true — but it is a
real change to the sound of every shell-like card made from here.

Saved cards are not touched: `render.js:87` reads `card.family.kind` from the
JSON, so `docs/lab/cards/freesound-wineglass.json` still says `bar` and still
gets the shelf until it is re-carded. Re-carding the shipped cards is a
separate decision. Two stored labels would move if the shipped cards were
re-carded: the wine glass, `bar` → `unknown`, and fdr-vowel, `string` →
`unknown` (§4.3). fdr-vowel is a `breath`-excited part in all four symphony
movements, so re-carding it would change that rendering; until then
`render.js:87` reads the stored `string` and nothing moves. Three others
(carillon-bell, uvb76-buzz stored as `string`; iowa-A5 stored as `unknown`)
already disagreed with the classifier before today and are unrelated drift from
the spectral path and older code. Every stored `family.confidence` is now a
different quantity from the one the code computes — the cards on disk carry
margins, the classifier returns fits — which is one more reason re-carding is a
decision to take deliberately rather than by drift.

## 6. Settled

- No hypothesis is scored only on the evidence it was fitted to. If a family
  gains a free parameter, it pays `fitOptimism` for it.
- A slot the object never sounded costs the hypothesis. Distance alone cannot
  tell a bar from a shell that happens to land on some of a bar's slots — the
  measurement above is the proof, not an argument.
- "No known family" is a real verdict again: it fires on a wine glass, a
  carillon bell, the UVB-76 buzz and a hemisphere at 1 : 1.7 : 2.4 : 3.2, and
  the panel prints no percentage beside it (`cardSummary` in
  `js/app/instrument-controller.js`), and `family.confidence` is 0.
- The number printed beside a family says how well the object matches *that*
  family. How much it beat the runner-up is a different number with a different
  name.
- Pinned in `test/cases-classifier.mjs` (8 cases). **Seven of the eight fail
  against the pre-change module** — the count here previously said two, which
  was wrong; three of the original four fail, not two:

  | case | against the pre-change module |
  |---|---|
  | `theBarHypothesisIsScoredOnEveryMeasuredRatio` | fails — an exact tuned bar with two unplaceable upper partials is still at distance 0.0000 and reads `bar` at 0.96 |
  | `aRealOrchestralBellStillReadsAsATunedBar` | passes — it is the one case the old module also got right |
  | `aShellIsNoKnownFamilyRatherThanAConfidentBar` | fails — the wine glass reads `bar` at 0.82 |
  | `confidenceReadsTheFitAndTheMarginIsKeptSeparately` | fails — `family.margin` does not exist there, and numerically too: Iowa A5 reads 0.93 while the vowel comb it fits 4.7× worse than reads 0.77 |
  | `theGateSeparatesTheRealBellsFromTheObjectsWithNoModel` | fails — with `UNKNOWN_DISTANCE` 0.03 the strangers sit at 0.018 and 0.039, so the wine glass is inside the gate |
  | `anUnnamedCardReportsNoConfidence` | fails — 1 : 2 comes back `unknown` at a confidence of 1 (§8.1) |
  | `twoVotingModesAreOneRatioAndNameNothing` | fails — 1 : 2.90 reads `bar` at 99.8 % (§8.2) |
  | `theStringCombIsMeasuredTheWayEveryOtherFamilyIs` | fails — a hemisphere scores a full 1.00 comb (§4.3) |

  Running the current test file against the old module needs a shim: the old
  module scored inside `classifyFamily` and exported no `familyScores`. The
  shim reproduces the old loop exactly and adds nothing else.

## 7. What would overturn it

- **More Iowa notes carded — this is the weakest joint in the whole note.**
  The gate sits at 0.0600 because A5, the worst real bar, sits at 0.0519. That
  is 0.0081 of headroom: 13.5 % of the gate's width, 15.6 % of A5's own
  distance. The calibration rests on **four saved cards** — C#5 and A5 and E5
  plastic ff, C#5 brass — out of the **24 recordings** the calibration note
  analysed (`docs/lab/2026-09-06-iowa-calibration.md`, which also reports 13 of
  those 24 reading as bars with arch 0.54–1.12). Four points do not establish
  where the worst real bar sits; they establish where the worst of four sits.

  And the margin does not degrade smoothly. A 2 % error in **one** partial of
  A5 — its second, 2806 → 2862 Hz — takes that partial outside the 5 % window
  of every arch's slot, so `coverage` steps 1.00 → 0.67, the charged distance
  jumps **0.0519 → 0.0945**, and A5 leaves the gate entirely. It is a step, not
  a slope, and 2 % is inside what a modal fitter can be wrong by on a partial
  it half-resolves. Perturbing A5's other partials: −3 % on the third gives
  0.0841 (out), ±3 % on the fourth gives 0.0621 / 0.0611 (out), while ±2 % on
  the third or fourth stays in. So A5 clears the gate on measurements that a
  couple of percent of error in any one of three partials would reverse. Pinned
  in `theGateSeparatesTheRealBellsFromTheObjectsWithNoModel`.
- **A dozen more Iowa notes carded** would settle it either way. If real bars
  land above 0.06, the thing to replace is the one-parameter arch, not the
  threshold — moving the threshold to cover a bad model is the mistake this
  note undoes.
- **A shell family in `FAMILY_RATIOS`.** A glass or hemisphere reference would
  give the wine glass somewhere honest to go, and the gap this calibration
  rests on (0.052 to 0.081) is a gap between real bars and objects with *no*
  model — it would have to be re-measured against the new table.
- ~~**A bar carded from only two partials.** n = 2 pays the largest optimism
  charge (×2) and nothing in the card set exercises it.~~ **Measured the same
  day and wrong** (§8.2): ×2 is a *multiplier*, and at n = 2 the residual it
  multiplies is exactly 0, because one free parameter absorbs the one
  informative ratio. n = 2 paid the largest charge on nothing and read `bar` at
  99–100 %. Two-mode cards are now refused before scoring.
- The two-parameter arch is rejected on *these* four bells. A set where the
  per-slot arch drift is consistent in sign would reopen it; here it was
  increasing on C#5 brass and decreasing on E5 and A5.
- **The classifier normalises by the lowest measured mode, and for a drifting
  voice that mode is not the comb spacing.** fdr-vowel's is 4.2 % sharp of the
  198.20 Hz least-squares comb its own twelve lowest partials imply (§4.3), and
  that is what puts its upper partials outside the coverage window. A ratio set
  is only as good as its denominator, and nothing in `familyScores` can tell a
  bad denominator from an inharmonic object. Fitting the comb spacing before
  taking ratios — for the string hypothesis, which is the one that claims a
  comb — would fix fdr-vowel and is the change most likely to move a label
  next. It was not made here because it changes what every string card is
  scored on, and this note's calibration set has two vowels in it.
- **The 5 % coverage window.** fdr-vowel's upper partials miss it by 0.7 points
  (§4.3) and that is what makes it `unknown`. The window is shared by every
  family and was not chosen to produce this answer, but it is now the constant
  that decides one shipped card. A vowel corpus wide enough to say what
  deviation a real comb actually shows would set it on evidence instead.

## 8. Second wave, same day: what the fix did not reach

The fix above stopped the arch being scored on the evidence it was fitted to.
An adversarial checker then ran the result and found two places where the same
failure survived in a different shape. Both are real; both were reproduced
before they were changed.

### 8.1 `confidence` still lied when a *gate* refused the card

`classifyFamily` returned `fitScore(best.dist)` — the winner's fit — whatever
the gates then decided. So a card the engine refuses to name reported how well
the family it would not name fitted it:

    classifyFamily([600, 1200])  ->  { kind: 'unknown', confidence: 1, margin: 0, dist: 0 }

1 : 2 is placed exactly by both the string and the bell, so the *margin* gate
fires, correctly: two families the ratios fit equally well is not a verdict.
The fit is nonetheless 1.000, and that is what came back. It is not only the
degenerate case: sweeping all **126,170** three-mode triples 1 : a : b over
a ∈ [1.2, 8], b ∈ (a, 12] in steps of 0.02, **2,586 of them (2.0 %) are refused
by the margin gate while sitting inside the distance gate**, and the highest
confidence any of them reported was 1 : 2 : 5 at **0.867** — a card the panel
calls "no known family" carrying a stored confidence of 87 %.

`confidence` is now 0 whenever `kind` is `unknown`, by any of the three routes
(too few modes, margin gate, distance gate). `dist` and `margin` are still
returned, so nothing is lost: the card records what it measured, and reports no
confidence in a name it did not give. `cardSummary` already suppressed the
percentage for `unknown`, so the panel does not change; the card JSON and
`scripts/instrument-card.mjs` do.

### 8.2 A two-mode card had no evidence in it and was scored anyway

The checker's second finding: `[600, 1938]` -> bar fit 1.000, `[600, 1860]` ->
0.997, `[600, 1740]` -> 0.998, and a deliberately stray `[600, 1957.4]` ->
0.993. Its question was whether the arch genuinely spans that range or whether
`fitOptimism` and the coverage term flatter a two-mode card. **Both, and the
first is the larger.** The arch is a continuum swept from −0.2 to 1.4, so its
second slot runs

| arch | −0.2 | 0 (free bar) | 1 (Iowa set) | 1.4 |
|---|---|---|---|---|
| second partial | 2.670 | 2.756 | 3.230 | 3.442 |

— a band ±14.5 % wide about 3.03, every point of which some arch reaches at
distance 0. All four of the checker's second partials (2.900, 3.100, 3.230,
3.262) are inside it. And a two-mode card has exactly **one** informative
ratio: the first is 1 by construction and lands on every reference's first slot
whatever the object is. One free parameter against one informative ratio leaves
no residual, so `fitOptimism` — a multiplier — charges 2 × 0 = 0. §7's
prediction that "n = 2 pays the largest optimism charge" was exactly backwards.

The size of it, swept rather than argued: for a two-mode card 1 : r, with r
from 1.02 to 19.00 in steps of 0.001 (17,980 cards), **the table names a family
for 80.7 %** — `bar` 63.5 %, `cantilever` 8.9 %, `plate` 2.6 %, `bell` 2.5 %,
`membrane` 1.9 %, `string` 1.4 % — and 2.1 % of all r are reported at over
99 % confidence. With two informative ratios (three modes, sweeping 1 : a : b)
the table names **20.1 %**. A verdict that fires on four intervals in five is
measuring the density of `FAMILY_RATIOS`, not the object.

So `MIN_VOTING_MODES = 3`: under three voting modes `familyScores` returns no
scores and `classifyFamily` returns `unknown`, `confidence` 0, `dist` `null` —
the same "never reached the scoring loop" state the five one-mode cards were
already in. The measured ratios are still recorded.

**No shipped card moves.** All fifteen cards in `docs/lab/cards/` were
reclassified before and after: every `kind`, `confidence`, `margin` and `dist`
is identical. Voting-mode counts are 1 (×5), 4, 4, 4, 5, 5, 6, 19, 20, 22 —
nothing in the repository has exactly two, which is also why this went unseen.
The threshold was set on the sweep, not on a card.

What it costs: a genuinely two-partial object — a quiet pp note where the
fitter finds only two modes — is now `unknown` rather than `bar`, and by §5
loses the bar's radiation shelf (about 3 dB above 6 kHz) and its
position-dependent strike. That is the intended trade. The alternative was to
keep reporting a family chosen by which reference happens to have a slot near
one number.

### 8.3 What was checked and left alone

- **fdr-vowel's label.** The checker asked whether `unknown` is truthful for a
  driven harmonic sound. It is truthful about the ratios and false about the
  object, and the cause is the f0, not the coverage rule — measured in §4.3
  (comb spacing 198.20 Hz by least squares, lowest voting mode 4.2 % sharp of
  it; renormalised, all six partials land inside the 5 % window). The
  normalisation stands, is now pinned by
  `theStringCombIsMeasuredTheWayEveryOtherFamilyIs`, and the real defect is
  logged in §7.
- **A claimed suite failure.** A note-review reported that this document
  asserts a suite group fails ("not ok - front door"). It does not: `rg -n
  'front door|not ok' docs/lab/2026-09-07-classifier-honesty.md` returns
  nothing. There was nothing to remove.

## 9. Corrections to this note, same day

The sweep totals in §8.2 were recomputed independently after the note was
written and did not reproduce as first recorded: 126,170 triples, not 124,806;
2,586 margin-refused inside the distance gate, not 2,496 (2.0 % either way);
and the three-mode naming rate is 20.1 %, not 23.5 %. The corrected figures are
in the text above. The direction of every conclusion is unchanged — a table
that names a family for one interval pair in five is still measuring the
density of `FAMILY_RATIOS` — but the numbers now match what a second run
produces.

Two further claims were removed rather than corrected: that `familyScores`
used to return "a list of 1s" as the ratios of an unscored card (it returned
the real ratios), and that the five unscored cards have "fewer than two"
voting modes (they have exactly one, and the threshold this pass introduced is
three).
