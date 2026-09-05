# 2026-09-05 — Found-instrument engine: first cards, first auditions

Sub-project 1 of the symphony (spec: `docs/superpowers/specs/2026-09-04-found-instrument-engine-design.md`,
plan: `docs/superpowers/plans/2026-09-05-found-instrument-engine.md`). Ten
tasks, seventeen physics tests, all green. What was built, what the physics
forced me to change on the way, and what the first material taught.

## 1. What exists

`js/instrument/`: `card.js` (recording → card: modes, damping law, family from
partial ratios, residual print, nonlinearity law off the hit's own decay),
`family.js` (scaling laws, damping-law decays, mode-shape position, contact-time
hardness), `excite/bank.js` (resonator bank with amplitude-dependent frequency),
`excite/strike.js`, `excite/pluck.js` (closed form), `excite/breath.js`,
`excite/bow.js` (driven), `body.js` (FFT convolution; plate, measured IR, or
per-family radiation shelf), `tuning.js` (retune deltas, dissonance curve,
related scale), `render.js` (truth-rate voices, 4× oversampled driven path,
metadata, cache). CLIs: `scripts/instrument-card.mjs`,
`scripts/instrument-audition.mjs`; `scripts/lib/wav.mjs` shared with the
mastering script. Format: `js/instrument/card-format.md`.

## 2. What the tests forced

Every one of these started as a failing assertion.

- **Hardness must be monotonic.** The exact half-sine force spectrum has
  nulls; as contact time changed, modes walked through them and a harder
  mallet could sound darker. The weight is now the lobe *envelope*,
  1/(1 + (2 f τ_c)²): real contacts are not exact half-sines, and the
  envelope is what the ensemble of them shares.
- **Decay comparisons need room.** At Q = 800 a note takes four seconds to
  fall 60 dB; a one-second render puts every note at the wall. The octave
  test renders six seconds and finds the octave-up decaying in 0.5× the time.
- **Blowing is negative damping, and that means velocity.** Feeding the
  bank's *displacement* back to the jet never spoke: a resonator's
  displacement lags the force by 90° at its peak. Velocity feedback, in phase
  with the force, is what a blown resonator amplifies. With both the drive and
  the loop DC-blocked, a feedback drive scaled to the card's fundamental
  amplitude, and the jet's cubic saturating at a wide swing, the model is
  silent below a threshold pressure (≈0.3), locks to the first mode within
  1 %, and grows with pressure: rms 0.003 → 0.035 → 0.089 → 0.137 at
  pressure 0.4 / 0.6 / 0.9 / 1.2.
- **Driven banks must keep the fundamental's advantage.** Normalising every
  resonator by its own damping made all modes peak equally, and the bowed
  note went to the fourth harmonic, which the bow position couples 7× more
  strongly. Normalising to the fundamental's damping restores each mode's
  physical peak (amplitude × decay time), 16:1 in the fundamental's favour.
- **Bow hair is compliant and a bow has width.** Velocity feedback scales
  with ω, so even with the physical peaks the third mode's loop gain was
  twice the fundamental's at 0.12 of the length. A one-pole at 1.2 × the
  fundamental on the velocity the hair feels settles it: the bowed note holds
  the fundamental from force 0.3 to 0.8, grows with force, and jumps to the
  second harmonic at 1.5 — the over-pressure regime.
- **Test statistics have their own physics.** A magnitude-weighted centroid
  over all bins is dragged toward mid-band by sixteen thousand near-silent
  bins; a power-weighted one over-rewards a 1/n spectrum's fundamental. The
  right statistic for "brighter" is magnitude over the peaks, floor excluded.

## 3. First material, honestly

The spec assumed struck material was extractable from the shelf. It was not:

| source | what the fitter found | why |
|---|---|---|
| Sevilla bells over a marathon crowd | 0–1 modes in any slice | continuous peal over noise; the fitter reads its candidates from the first 200 ms at 18 dB spectral SNR and 0.8 phase coherence |
| Kid Ory 1921 record | 0 modes | a band mix; no isolated hit |
| OP-Z factory kit (six isolated hits recorded off the device) | thud: one mode, 182 Hz, τ 0.09 s; crack: two low modes; hat, click, samples: none | correct — drums are noise-like; a kick is one mode |
| crystal singing bowl (CC BY 3.0) | one mode, 261.8 Hz, τ 2.35 s, Q 1931; residual worse than the signal | the player is rubbing it: a sustained tone, not a strike |
| **Eulenspiegel carillon, noon chime** (PD mark, aporee 59454) | **4 modes** at 787 / 2513 / 6342 / 8102 Hz, τ 0.89 / 0.09 / 0.20 / 0.20, constant Q ≈ 2366, fit −2.4 dB | a real struck bell between crowd and traffic; the finder cards twelve candidates and keeps the one with most modes and least residual |

The carillon card's ratios 1 : 3.19 : 8.06 : 10.29 classified as `string`
(confidence 0.75): the hum and prime are below the fitter's floor in that
recording and the surviving partials sit near 3, 8 and 10. A bell it is; the
family is overridable and the ratios are recorded. Its related scale — the
intervals its own partials make consonant — comes out as root + 329, 425 and
1015 cents: a neutral third, a wide major third, a flat minor seventh. That
is the "harmony from the timbre" idea producing something a bell would agree
with.

Cards kept in `docs/lab/cards/`: `carillon-bell.json`, `opz-thud.json`,
`crystal-bowl-d.json` (attribution required, lab only). Junk cards deleted.

## 4. Auditions

`carillon-audition.wav` (41.9 s): strike, pluck, breath and bow across two
octaves from 787 Hz, then the root with its three related-scale intervals.
`thud-audition.wav` (22.7 s): the one-mode drum struck and bowed across three
octaves. Both peak-normalised to −1 dBFS; the carillon's raw peak was 0.053
because the card's amplitudes came from a distant recording.

## 5. What is next

- **Material.** One tap on a glass, a mug, a pan lid and a bowl, near the
  Mac, gives four clean cards in a minute and is the recording session the
  design assumed. The shelf's dense recordings need the harvester's
  separation first.
- **Hits surfaces** (`card.hits`): measured position/hardness from several
  taps, interpolated instead of the theory.
- **Family override and bell reference:** the bell set should be matched
  from the prime, not the lowest surviving partial.
- **Sub-project 2:** the score model, orchestration, and the offline
  renderer that turns cards and a movement into stems.
