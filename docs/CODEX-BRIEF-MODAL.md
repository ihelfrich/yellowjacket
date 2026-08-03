# Codex brief: modal analysis and resynthesis

Run it with:

```
cd /Users/ian/Projects/yellowjacket
~/.npm-global/bin/codex exec -m gpt-5.6-sol -c model_reasoning_effort=xhigh \
  -c approval_policy=never -c sandbox_mode=workspace-write -c 'mcp_servers={}' \
  --skip-git-repo-check - < docs/CODEX-BRIEF-MODAL.md
```

(If it stalls with ~0s accumulated CPU for several minutes, kill it with
`pkill -f "codex exec"` and rerun once. That failure mode is known.)

---

You are adding one pure DSP module to Yellowjacket, a fully client-side browser
audio workstation. Deployed, in use, tested. Precision matters more than volume.

## Rules

- **Touch only these files:** `js/analysis/modal.js` (new),
  `scratch/test_modal.mjs` (new, gitignored). Nothing else. Other work is in
  flight across the UI layer and any other edit will collide.
- ES modules, **no dependencies, no build step**. Node v16.10.0.
- House conventions: no `console.log` in the module, no TODOs, 2-space indent,
  semicolons, sparse comments that cite the method or the reason.
- `node test/run.mjs` (17 suites, 86 cases) must stay green. Run it at the end.
- Reuse `js/fft.js` if its export surface fits (check first). Do not add a
  second FFT.
- Seeded randomness only (`mulberry32`), never `Math.random`, never an LCG. An
  LCG fixture once produced real lattice periodicity that the beat tracker
  correctly flagged as rhythmic.

## What this is for

A struck resonant object (kick drum, tom, bell, plucked string, bass note) in
free vibration is genuinely a sum of exponentially decaying sinusoids. That is
not a curve-fitting convenience, it falls out of the wave equation. So a
recorded drum hit can be described by a short table of numbers:

```
x(t) = SUM_i  A_i * exp(-t / tau_i) * sin(2*pi*f_i*t + phi_i)
```

The point is to let a user SEE those numbers for a slice they harvested off a
record, EDIT them, and hear the result. Your job is only the maths: fit, and
resynthesize. No UI, no Web Audio, no DOM.

## API

```js
export function fitModal(samples, sampleRate, opts) -> {
  modes: [{ freqHz, tauSec, amp, phase, energyFrac }],   // strongest first
  residual: Float32Array,      // samples minus the resynthesis, same length
  fitDb,                       // 20*log10(rms(residual)/rms(samples))
  fundamentalHz,               // freqHz of the highest-energy mode, or 0
}
// opts: { maxModes = 12, minFreqHz = 30, maxFreqHz = 12000,
//         minTauSec = 0.005, floorDb = -60 }

export function synthModal(modes, sampleRate, seconds) -> Float32Array
```

## Method (use this, it is chosen for robustness in a short window)

1. **Candidate frequencies.** Window the first ~200 ms (or the whole slice if
   shorter) with a Hann window, zero-pad to at least 4x, take the magnitude
   spectrum, and pick local maxima above `floorDb` relative to the strongest
   bin. Refine each peak to sub-bin accuracy by **quadratic interpolation on
   the log-magnitude** of the three bins around the peak (standard, and it
   matters: a bin-accurate frequency gives a visibly wrong decay fit).
2. **Per-partial envelope by heterodyne.** For each candidate frequency f,
   multiply the signal by `exp(-i*2*pi*f*t)` to shift that partial to DC,
   lowpass the result (a moving average of about `sampleRate/f` samples is
   enough, or a small FIR you justify), and decimate. The magnitude of that
   complex envelope is the partial's amplitude over time; its angle at t=0 is
   the phase.
3. **Decay fit.** Fit `ln(amplitude)` against time by **least squares over the
   region between the envelope peak and the point it falls `floorDb` below
   that peak** (not the whole window: the noise floor tail would flatten every
   slope toward zero and make every mode sound infinite). tau = -1 / slope.
   Reject a mode whose fitted tau is below `minTauSec` or non-finite.
4. **Amplitude and phase** come from the fit intercept and the envelope angle,
   both referred back to t=0.
5. Sort modes by energy (`amp^2 * tau` is a fair proxy for the energy a damped
   sinusoid carries; state whatever you use). Keep at most `maxModes`. Report
   `energyFrac` per mode as its share of the total modelled energy.
6. **Residual** = input minus `synthModal(modes, ...)` at the input length.

## Verification (scratch/test_modal.mjs, report the real numbers)

Build fixtures analytically so ground truth is known exactly:

- **Single damped sinusoid**, 220 Hz, tau 0.35 s, amp 0.6, phase 0.9 rad, 1 s
  at 44100. Assert recovered freq within **0.5 Hz**, tau within **5%**, amp
  within **10%**, and that resynthesis matches the input to better than
  **-30 dB** residual.
- **Three modes** at 110/271/523 Hz with different taus and amplitudes (make
  them inharmonic on purpose: a real drum is). Assert all three are found,
  each frequency within 1 Hz, and that no spurious mode carries more than 5%
  of the energy.
- **Noise robustness.** Same three modes plus mulberry32 white noise at -30 dB
  relative to the signal. Assert the three frequencies still land within 2 Hz
  and that `fitDb` degrades gracefully rather than the fit collapsing.
- **A deliberately broken baseline that must FAIL.** Fit the log-decay over
  the whole window including the silent tail instead of the peak-to-floor
  region, and show that it inflates tau by a large factor on the single-mode
  fixture. Print both numbers. This proves the test is not vacuous.
- **Degenerate inputs:** empty array, all zeros, a single sample, pure white
  noise (should return few or no confident modes, not garbage), a pure DC
  offset. None may throw, produce NaN, or return non-finite fields.
- **Determinism:** two identical calls return identical results.
- **Round trip:** `synthModal(fitModal(x).modes, ...)` has the same length as
  requested and never exceeds ~1.5x the input peak.

## What to report back

For each fixture, the recovered values against the true values, as numbers.
The broken-baseline comparison. The harness tail. Any place the method fails
that I should know about (I expect cymbals and snares to fit poorly; say so
with evidence rather than claiming it works on everything).
