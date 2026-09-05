# Found-instrument engine — design

Date: 2026-09-04. Status: approved in conversation, awaiting written review.
Sub-project 1 of 4 (engine → score model and orchestrator → the symphony →
bench panel). This spec covers the engine only.

## 1. Goal

Turn a recorded found sound into an *instrument*: a small, readable table of
numbers from which every note, dynamic, articulation and register is computed
by acoustics rather than by shifting the recording. Instruments must render
deterministically without a browser so a forty-minute work can be rendered in
node, and every physical claim the engine makes must have a mechanical test.

Non-goals for this sub-project: any bench UI beyond a node CLI that renders
audition files; the score model, orchestration and the symphony; spectral
resynthesis of sustained sources (the second-phase "C" path); writing anything
to the OP-Z.

## 2. Vocabulary

- **Card** — one analysed object at one size: the mode table plus the laws
  fitted to it. JSON, versioned, human-editable.
- **Family** — the object's class (string, bar, membrane, plate, bell,
  unknown), which fixes its mode shapes and dimensional scaling law.
- **Voice** — one rendered note: card + family parameters + pitch +
  excitation + dynamics + duration → mono float samples.
- **Excitation** — the driver: strike, pluck, bow, breath.
- **Retune** — a stored delta mapping a card's modes to a target spectrum;
  the physical card is never overwritten.

## 3. The card

Produced by `card.js` from a mono recording of one hit (or a set of hits of
the same object). Fields, all required unless marked optional:

```
{
  "version": 1,
  "id": "<sha256 of source samples + analysis options, first 16 hex>",
  "source": { "name", "sampleRate", "seconds", "license", "note" },
  "modes": [ { "hz", "amp", "decay", "phase" }, ... ],   // from fitModal, amp linear, decay in 1/s
  "damping": { "model": "constant-q" | "power", "q0", "exponent", "r2" },
  "family": { "kind", "confidence", "inharmonicity", "ratios": [1, r2, r3, ...] },
  "nonlinearity": [ { "mode": i, "hzPerAmp", "r2" }, ... ],   // optional per mode
  "residual": { "sampleRate", "samples": "<base64 float32>", "seconds" },
  "hits": [ { "position", "hardness", "modesAmp": [...] } ]   // optional, measured surface
}
```

### 3.1 Modes

`fitModal` (js/analysis/modal.js) as it stands: spectral-peak candidates,
heterodyne tracking, exponential decay fit per mode, residual returned.
Modes below −60 dB of the loudest, or with r² of the decay fit under 0.5, are
dropped and counted in `source.note`.

### 3.2 Damping law

Fit Q_i = π f_i / decay_i against f_i. Two candidate models, the better r²
wins: constant Q (metals, glass) and power law Q = q0 · f^exponent (wood,
skins). The law, not the per-mode decays, is what the family engine uses at
other pitches.

### 3.3 Family classification

From the ratios of the lowest six mode frequencies to the lowest mode:
nearest family by log-ratio distance against reference sets — string
(harmonic, with inharmonicity B fitted from f_n = n f_1 √(1 + B n²)), free
bar (1, 2.756, 5.404, 8.933), clamped bar, circular membrane (1, 1.594,
2.136, 2.296, 2.653, 2.918), plate and bell (their characteristic sets, from
Fletcher & Rossing, cited in `card-format.md`). Confidence is the margin to
the second-best family; below a threshold the family is `unknown`, and the
engine then scales uniformly and uses no position dependence. This is the
part of the design that infers mode shapes without seeing the object.

### 3.4 Nonlinearity law (invention)

During a loud hit's decay the heterodyne tracker already produces a
frequency track per mode. Regress instantaneous frequency against
instantaneous amplitude over the decay; a significant slope (r² ≥ 0.6)
becomes `hzPerAmp` for that mode. At render time a voice's mode frequency is
f_i + hzPerAmp_i · A_i(t), so loud playing bends and shimmers. Modes without a
significant slope are linear. A card from a soft hit will have none; the
field is optional and the engine must not invent one.

### 3.5 Residual print

The fitter's residual, trimmed to the first 100 ms and normalised, is stored
as the object's contact-noise signature and used as the noise source for
breath and for strike transients, so an object is excited by its own noise.

## 4. Family generalisation (`family.js`)

Given a card and a target pitch, produce the mode table for that pitch.

- **Frequencies**: string — modes scale uniformly with f_1, inharmonicity
  B scales as (f_target / f_card)² (shorter string, stiffer relative to its
  length); bar — ratios preserved, all modes scale uniformly (f ∝ h/L², and
  the family engine varies L); membrane — ratios preserved, uniform scaling
  (tension); plate, bell, unknown — uniform scaling.
- **Decays**: from the damping law at the new frequency, never copied.
- **Amplitudes**: the card's amplitudes, then position weighting.
- **Position**: mode shape at the strike/pluck point p ∈ [0, 1]: string and
  bar sin(nπp) (free-bar shapes use the cosh/cos form); membrane and plate
  use the radial Bessel shape J0(k r) for axisymmetric modes and 1 for the
  rest, with p read as normalised radius;
  unknown uses 1. A strike on a node silences that mode — this is a test.
- **Hardness**: Hertz contact time τ_c from a hardness parameter h ∈ [0, 1]
  mapped over 0.2–8 ms; the excitation force is a half-sine of duration τ_c,
  whose spectrum is the low-pass that makes soft mallets dark.
- **Measured surface**: if the card carries `hits`, position and hardness
  weights are interpolated from data instead of theory; the voice metadata
  records which was used.

## 5. Excitations (`excite/`)

All excitations produce a driving signal for the mode bank, or a closed-form
result where one exists.

- **Strike** (`strike.js`): closed form. Each mode's response to a half-sine
  force pulse of duration τ_c is a damped sinusoid with amplitude scaled by
  the pulse's spectrum at f_i; rendered by `synthModal`. Exact and cheap.
- **Pluck** (`pluck.js`): closed form. Initial displacement triangle at p:
  mode n amplitude ∝ sin(nπp) / n²; phases from the displacement start.
- **Bow** (`bow.js`): McIntyre–Schumacher–Woodhouse. The bank runs as
  second-order resonators; at each sample the bow-string relative velocity is
  solved against a friction curve (static peak, sliding branch) with bow
  force and bow velocity as inputs. Outputs stick-slip (Helmholtz-like)
  motion at proper force, a stable sustain, crescendo with force, and
  raucous behaviour above the maximum force — all consequences, not
  settings.
- **Breath** (`breath.js`): a jet excitation in the Cook blown-bottle family:
  mouth pressure through a cubic pressure-to-flow nonlinearity driving the
  bank, the bank's output fed back to the jet, with the residual print as the
  turbulence noise. Locks to the first mode at moderate pressure, overblows
  to a higher mode at high pressure.

Dynamics for all four: amplitude of the excitation, plus the nonlinearity
law's frequency bend.

## 6. Body and radiation (`body.js`)

A convolution stage after the bank with one of: the generated plate impulse
already in `js/dsp/space.js` (short, bit-exact); a measured impulse
response supplied as a file (later, from the room); or a synthesised
radiation filter per family (a gentle high-shelf for bars and plates, a
low-mid bump for membranes). Body is part of the instrument, not the mix.

## 7. Tuning (`tuning.js`)

- **Retune**: map a card's modes to a target spectrum — harmonic, just
  intonation ratios, or an explicit list — stored as a per-mode delta in
  cents. Round-trips exactly: applying the delta and its negation returns
  the card bit-for-bit.
- **Dissonance curve**: Sethares' pairwise roughness over the card's
  spectrum (amplitudes weighted), sampled across an interval of a twelfth.
- **Related scale**: the local minima of the dissonance curve, returned as
  ratios and cents — the scale this timbre is most consonant in. For a
  harmonic spectrum the minima are the just intervals; that is a test.
- The orchestrator's cross-family tuning resolution is sub-project 2 and
  only consumes these outputs.

## 8. Rendering (`render.js`)

- Truth rate 96 kHz. The nonlinear stages (bow, breath, nonlinearity law)
  run at 4× and are decimated with the Kaiser resampler in
  `js/dsp/resample.js`; closed-form strike and pluck render directly.
- No timers, DOM, AudioContext or `Math.random`; any noise comes from the
  residual print or a seeded xorshift stated in the metadata.
- `renderVoice({ card, pitchHz, excitation, params, dynamics, seconds, seed })`
  → `{ samples: Float32Array, sampleRate, meta: { peak, decay60Sec, centroidHz, used: { position: 'theory'|'measured', ... } } }`.
- A content hash of the inputs keys a render cache (in-memory in node, OPFS
  later in the bench) so a movement re-renders only what changed.
- Delivery rate for audition files is 48 kHz, 24-bit WAV, via the Kaiser
  resampler.

## 9. Tests (`test/run.mjs`, group `found instruments`)

Physics, not opinion:

1. A synthetic free-bar recording (known modes) yields a card whose family
   is `bar` and whose ratios are 1 : 2.756 : 5.404 within one cent.
2. A note an octave up decays in the time the damping law predicts, within
   5 %; a per-mode copy would fail this.
3. A strike at a node of mode 2 leaves mode 2 at least 40 dB below its
   antinode level.
4. Hardness 0 → 1 moves the spectral centroid monotonically upward.
5. The bow sustains at a steady RMS (±10 % over the second half of a 2 s
   note) at a force inside the range `bow.js` reports as stable for the card
   (`stableForceRange(card)`), and its RMS rises with force within that range.
6. The blown model's fundamental locks to the card's first mode within 1 %
   at moderate pressure.
7. A retune delta round-trips to the physical card exactly.
8. The related scale of a harmonic spectrum contains 3/2, 4/3, 5/4 and 6/5
   within 5 cents.
9. Two renders with identical inputs are bit-identical; the cache hit
   returns the same buffer.
10. A card with no `nonlinearity` field renders every mode at constant
    frequency.

## 10. Files

```
js/instrument/card.js          analysis → card
js/instrument/family.js        scaling laws, mode shapes, position, hardness
js/instrument/excite/strike.js
js/instrument/excite/pluck.js
js/instrument/excite/bow.js
js/instrument/excite/breath.js
js/instrument/body.js
js/instrument/tuning.js
js/instrument/render.js        renderVoice, cache, audition WAV
js/instrument/card-format.md   the JSON, the reference ratio sets, citations
scripts/instrument-card.mjs    recording (+ optional slice times) → card JSON
scripts/instrument-audition.mjs card → a WAV of its compass under each excitation
docs/lab/cards/                cards made from the shelf's struck material
```

Existing code reused unchanged: `fitModal`/`synthModal`, `plateImpulse`,
`resample`, `measureLoudness` for the audition file's level line. Existing
patterns followed: pure modules with no DOM; deterministic rendering as in
`js/machine/drum-dsp.js`; tests as named functions in `test/run.mjs`.

## 11. First material

Struck material from the shelf, extracted with the harvester's transient
picks: the Sevilla church bells (shelf entry "MARATHON AND CHURCH BELLS"), the 1921 record's
percussive events, and any bell-like hits in the SIGNAL drawer. Each yields
a card in `docs/lab/cards/` with its licence line. The recording session
with your own objects replaces or extends these later and adds measured
`hits` surfaces and a room impulse response.

## 12. Risks and decisions

- **Family misclassification** on real objects with mixed behaviour: the
  confidence threshold and the `unknown` fallback bound the damage; the card
  stores the ratios so a human can override `family.kind`.
- **The bow model is the hardest piece.** It is delivered last within the
  sub-project, behind strike, pluck and breath, so the instruments are
  usable before it lands.
- **Nonlinearity law from a single hit** may be noisy; the r² gate and the
  optional field mean absence is the default.
- **Render cost**: bowed and blown voices at 4× 96 kHz cost roughly
  400 k resonator updates per mode-second; with ~30 modes that is
  ~12 M/s, fine in node for a movement, and cached thereafter.
