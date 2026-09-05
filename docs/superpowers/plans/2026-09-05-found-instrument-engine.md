# Found-Instrument Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a recorded found sound into a playable, physically scaled instrument card, and render notes from it deterministically in node under strike, pluck, breath and bow excitations, with body, tuning and physics tests.

**Architecture:** Pure ES modules under `js/instrument/` with no DOM, timers, AudioContext or `Math.random`, following `js/machine/drum-dsp.js`. Analysis builds a JSON card from `fitModal`; `family.js` derives the mode table at any pitch from the card's laws; excitations either render in closed form through `synthModal` or drive a second-order resonator bank sample by sample; `render.js` fronts it all with a cache. Tests are named functions in `test/run.mjs` under the group `found instruments`.

**Tech Stack:** Node 24 ES modules, the repo's own DSP (`js/analysis/modal.js`, `js/dsp/resample.js`, `js/dsp/space.js`, `js/fft.js`), `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-09-04-found-instrument-engine-design.md`

## Global Constraints

- Pure modules: no timers, DOM, AudioContext or `Math.random` in `js/instrument/` (spec §8).
- Truth rate 96 000 Hz; nonlinear stages run at 4× and are decimated with `resample` from `js/dsp/resample.js` (spec §8).
- Card JSON `version: 1`; mode fields are `freqHz`, `tauSec`, `amp`, `phase` exactly as `fitModal` returns them (spec §3, adapted to the fitter's names).
- The `nonlinearity` field is optional and never invented; absence means linear (spec §3.4).
- Retune deltas round-trip bit-for-bit (spec §7).
- Every test is a physics check with a numeric tolerance stated in the assertion (spec §9).
- Tests live in `test/run.mjs`, group `['found instruments', instrumentCases]`, run with `node test/run.mjs`.
- Commit after every task with the repo's attribution trailer.

---

## File structure

| file | responsibility |
|---|---|
| `js/instrument/card.js` | recording → card: modes (via `fitModal`), damping law, family, residual print, nonlinearity law |
| `js/instrument/family.js` | card + pitch → mode table: scaling laws, damping-law decays, mode-shape position weights, Hertz hardness weights |
| `js/instrument/excite/bank.js` | second-order resonator bank driven by an excitation signal, with per-mode amplitude-dependent frequency |
| `js/instrument/excite/strike.js` | closed-form strike (half-sine force) |
| `js/instrument/excite/pluck.js` | closed-form pluck (triangle displacement) |
| `js/instrument/excite/breath.js` | Cook-style jet excitation driving the bank |
| `js/instrument/excite/bow.js` | friction (stick-slip) excitation driving the bank; `stableForceRange` |
| `js/instrument/body.js` | body/radiation stage: plate IR, measured IR, or family radiation filter; FFT convolution |
| `js/instrument/tuning.js` | retune deltas, dissonance curve, related scale |
| `js/instrument/render.js` | `renderVoice`, oversampling and decimation, metadata, cache |
| `js/instrument/card-format.md` | card JSON, reference ratio sets, citations |
| `scripts/lib/wav.mjs` | node WAV read/write (moved out of `scripts/master-take.mjs`) |
| `scripts/instrument-card.mjs` | recording → card JSON |
| `scripts/instrument-audition.mjs` | card → audition WAV across excitations and a compass |
| `docs/lab/cards/` | cards from the shelf's struck material |

---

### Task 1: Card from a recording — modes, damping law, family, residual print

**Files:**
- Create: `js/instrument/card.js`
- Create: `js/instrument/card-format.md`
- Modify: `test/run.mjs` (add imports, `instrumentCases`, group entry)

**Interfaces:**
- Consumes: `fitModal(samples, sampleRate, opts)` → `{ modes: [{freqHz, tauSec, amp, phase}], residual, fitDb, fundamentalHz }` from `js/analysis/modal.js`.
- Produces: `buildCard(samples, sampleRate, { name, license, note, maxModes = 16 })` → card object; `fitDampingLaw(modes)` → `{ model, q0, exponent, r2 }`; `classifyFamily(modes)` → `{ kind, confidence, inharmonicity, ratios }`; `qAt(damping, hz)` → number; `FAMILY_RATIOS` constant.

- [ ] **Step 1: Write the failing tests**

Add near the other imports at the top of `test/run.mjs`:

```js
import { buildCard, fitDampingLaw, classifyFamily, qAt, FAMILY_RATIOS } from '../js/instrument/card.js';
```

Add before `const groups = [`:

```js
// --- found instruments -----------------------------------------------------
// Synthetic objects with known physics; every assertion is a number.
function barRecording(sr = 48000, f1 = 440, seconds = 1.5, q = 800) {
  // free-free bar: ratios 1 : 2.756 : 5.404 : 8.933, constant Q
  return damped(sr, seconds, FAMILY_RATIOS.bar.slice(0, 4).map((r, i) => ({ f: f1 * r, tau: q / (Math.PI * f1 * r), amp: 0.5 / (i + 1), phase: 0 })));
}
const instrumentCases = [
  function aBarRecordingBecomesABarCardWithItsRatios() {
    const sr = 48000;
    const card = buildCard(barRecording(sr), sr, { name: 'synthetic bar', license: 'test' });
    assert.equal(card.version, 1);
    assert.equal(card.family.kind, 'bar', JSON.stringify(card.family));
    assert.ok(card.family.confidence > 0.3, 'confident: ' + card.family.confidence.toFixed(2));
    const ratios = card.family.ratios.slice(0, 3);
    close(ratios[1], 2.756, 0.0016 * 2.756, 'second partial within one cent');
    close(ratios[2], 5.404, 0.0016 * 5.404, 'third partial within one cent');
    assert.equal(card.damping.model, 'constant-q');
    close(card.damping.q0, 800, 40, 'Q within 5%');
    assert.ok(card.residual.samples.length > 0 && card.residual.seconds <= 0.1, 'a residual print of at most 100 ms');
    assert.equal(card.nonlinearity, undefined, 'a linear synthetic hit carries no nonlinearity law');
  },
  function theDampingLawPrefersThePowerModelWhenQFalls() {
    const modes = [200, 400, 800, 1600].map((f) => ({ freqHz: f, tauSec: (3000 * Math.pow(f / 200, -0.5)) / (Math.PI * f), amp: 1, phase: 0 }));
    const law = fitDampingLaw(modes);
    assert.equal(law.model, 'power');
    close(law.exponent, -0.5, 0.05, 'exponent');
    close(qAt(law, 800), 3000 * Math.pow(4, -0.5), 30, 'Q at 800 Hz');
  },
  function membraneAndStringRatiosClassifyThemselves() {
    const membrane = classifyFamily(FAMILY_RATIOS.membrane.map((r) => ({ freqHz: 100 * r, tauSec: 0.3, amp: 1, phase: 0 })));
    assert.equal(membrane.kind, 'membrane');
    const B = 0.0004;
    const string = classifyFamily([1, 2, 3, 4, 5, 6].map((n) => ({ freqHz: 220 * n * Math.sqrt(1 + B * n * n), tauSec: 0.5, amp: 1, phase: 0 })));
    assert.equal(string.kind, 'string');
    close(string.inharmonicity, B, B * 0.5, 'inharmonicity recovered to within half');
    const junk = classifyFamily([1, 1.31, 1.77, 2.9].map((r) => ({ freqHz: 300 * r, tauSec: 0.3, amp: 1, phase: 0 })));
    assert.equal(junk.kind, 'unknown', JSON.stringify(junk));
  },
];
```

And in `groups`: `['found instruments', instrumentCases],` as the first entry.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test/run.mjs 2>&1 | head -5`
Expected: `Error: Cannot find module '.../js/instrument/card.js'`

- [ ] **Step 3: Write the implementation**

`js/instrument/card.js`:

```js
// Instrument card: a recorded found sound written as the table of numbers it
// is, plus the laws fitted to that table. Pure; no DOM, no randomness.
// Format and reference sets: js/instrument/card-format.md.

import { fitModal } from '../analysis/modal.js';
import { sha256HexSync } from '../loom/identity.js';

export const CARD_VERSION = 1;

// Ratios of the lowest modes to the lowest, Fletcher & Rossing (see card-format.md).
export const FAMILY_RATIOS = Object.freeze({
  string:   [1, 2, 3, 4, 5, 6],
  bar:      [1, 2.756, 5.404, 8.933, 13.34, 18.64],       // free-free Euler-Bernoulli
  cantilever: [1, 6.267, 17.55, 34.39, 56.84, 84.91],     // clamped-free
  membrane: [1, 1.594, 2.136, 2.296, 2.653, 2.918],       // ideal circular membrane
  plate:    [1, 1.73, 2.33, 3.91, 4.11, 6.30],            // free circular plate, ν≈0.33
  bell:     [1, 2, 2.4, 3, 4, 5],                         // hum, prime, tierce, quint, nominal, deciem
});
export const UNKNOWN_CONFIDENCE = 0.25;

function linearFit(xs, ys) {
  const n = xs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; syy += ys[i] * ys[i]; }
  const den = n * sxx - sx * sx;
  const slope = den !== 0 ? (n * sxy - sx * sy) / den : 0;
  const intercept = (sy - slope * sx) / n;
  let ssRes = 0; const mean = sy / n; let ssTot = 0;
  for (let i = 0; i < n; i++) { const p = intercept + slope * xs[i]; ssRes += (ys[i] - p) ** 2; ssTot += (ys[i] - mean) ** 2; }
  return { slope, intercept, r2: ssTot > 0 ? 1 - ssRes / ssTot : 1 };
}

/** Q of a mode from its decay: Q = π f τ. */
export function modeQ(mode) { return Math.PI * mode.freqHz * mode.tauSec; }

/** Constant-Q or power-law Q(f), whichever fits the modes better. */
export function fitDampingLaw(modes) {
  const usable = modes.filter((m) => m.freqHz > 0 && m.tauSec > 0);
  if (usable.length < 2) {
    const q0 = usable.length ? modeQ(usable[0]) : 100;
    return { model: 'constant-q', q0, exponent: 0, r2: 0 };
  }
  const logF = usable.map((m) => Math.log(m.freqHz));
  const logQ = usable.map((m) => Math.log(modeQ(m)));
  const meanLogQ = logQ.reduce((a, b) => a + b, 0) / logQ.length;
  let ssTot = 0; for (const v of logQ) ssTot += (v - meanLogQ) ** 2;
  const constant = { model: 'constant-q', q0: Math.exp(meanLogQ), exponent: 0, r2: ssTot > 0 ? 0 : 1 };
  const fit = linearFit(logF, logQ);
  const power = { model: 'power', q0: Math.exp(fit.intercept), exponent: fit.slope, r2: fit.r2 };
  // the power law always fits at least as well; prefer constant Q unless the exponent earns it
  return Math.abs(power.exponent) > 0.1 && power.r2 > 0.5 ? power : constant;
}

export function qAt(damping, hz) {
  return damping.model === 'power' ? damping.q0 * Math.pow(hz, damping.exponent) : damping.q0;
}

function ratioDistance(measured, reference) {
  // each measured ratio to its nearest reference ratio, mean |log| distance
  let sum = 0;
  for (const r of measured) {
    let best = Infinity;
    for (const ref of reference) best = Math.min(best, Math.abs(Math.log(r / ref)));
    sum += best;
  }
  return sum / measured.length;
}

function fitInharmonicity(ratios) {
  // f_n / (n f_1) = sqrt(1 + B n^2), n = nearest integer to the ratio
  let best = { B: 0, err: Infinity };
  for (let B = 0; B <= 0.02; B += 0.00005) {
    let err = 0;
    for (const r of ratios) { const n = Math.max(1, Math.round(r / Math.sqrt(1 + B))); err += Math.abs(Math.log(r / (n * Math.sqrt(1 + B * n * n)))); }
    if (err < best.err) best = { B, err: err / ratios.length };
  }
  return best;
}

/** Family from the ratios of the lowest six modes to the lowest. */
export function classifyFamily(modes) {
  const sorted = modes.filter((m) => m.freqHz > 0).slice().sort((a, b) => a.freqHz - b.freqHz).slice(0, 6);
  if (sorted.length < 2) return { kind: 'unknown', confidence: 0, inharmonicity: 0, ratios: sorted.map(() => 1) };
  const f1 = sorted[0].freqHz;
  const ratios = sorted.map((m) => m.freqHz / f1);
  const scores = [];
  for (const [kind, ref] of Object.entries(FAMILY_RATIOS)) {
    if (kind === 'string') { const { B, err } = fitInharmonicity(ratios); scores.push({ kind, dist: err, B }); }
    else scores.push({ kind, dist: ratioDistance(ratios, ref), B: 0 });
  }
  scores.sort((a, b) => a.dist - b.dist);
  const best = scores[0], second = scores[1];
  const confidence = second.dist > 0 ? Math.max(0, 1 - best.dist / second.dist) : 0;
  const tooFar = best.dist > 0.03; // 3% mean log distance: not this family either
  const kind = confidence < UNKNOWN_CONFIDENCE || tooFar ? 'unknown' : best.kind;
  return { kind, confidence, inharmonicity: kind === 'string' ? best.B : 0, ratios };
}

function residualPrint(residual, sampleRate) {
  const n = Math.min(residual.length, Math.round(0.1 * sampleRate));
  const out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(residual[i]));
  for (let i = 0; i < n; i++) out[i] = peak > 0 ? residual[i] / peak : 0;
  return { sampleRate, seconds: n / sampleRate, samples: Buffer.from(out.buffer, out.byteOffset, out.byteLength).toString('base64') };
}

export function residualSamples(card) {
  const buf = Buffer.from(card.residual.samples, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Build a card from a mono recording of one hit. Options: name, license,
 * note, maxModes (16), floorDb (-60). Nonlinearity is added by
 * `fitNonlinearity` (Task 2) only when the data supports it.
 */
export function buildCard(samples, sampleRate, { name = 'untitled', license = '', note = '', maxModes = 16, floorDb = -60 } = {}) {
  const fit = fitModal(samples, sampleRate, { maxModes, floorDb });
  const modes = fit.modes.filter((m) => m.tauSec > 0 && m.amp > 0).map((m) => ({ freqHz: m.freqHz, tauSec: m.tauSec, amp: m.amp, phase: m.phase }))
    .sort((a, b) => a.freqHz - b.freqHz);
  const dropped = fit.modes.length - modes.length;
  const card = {
    version: CARD_VERSION,
    id: sha256HexSync(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)).slice(0, 16),
    source: { name, sampleRate, seconds: samples.length / sampleRate, license, note: (note ? note + ' ' : '') + (dropped ? `${dropped} modes dropped.` : '') + ` fit ${fit.fitDb.toFixed(1)} dB.` },
    modes,
    damping: fitDampingLaw(modes),
    family: classifyFamily(modes),
    residual: residualPrint(fit.residual, sampleRate),
  };
  return card;
}
```

`js/instrument/card-format.md`:

```markdown
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
| `nonlinearity[]` | optional; `{ mode, hzPerAmp, r2 }` — frequency shift per unit amplitude, measured on the hit's own decay |
| `residual` | the fitter's residual, first 100 ms, peak-normalised, float32 little-endian base64 |
| `hits[]` | optional; measured `{ position, hardness, modesAmp[] }` surface |

## Reference ratio sets (`FAMILY_RATIOS`)

Ratios of the lowest modes to the lowest, from N. H. Fletcher and T. D.
Rossing, *The Physics of Musical Instruments*, 2nd ed. (Springer, 1998):
free–free bar (ch. 2, Euler–Bernoulli, 1 : 2.756 : 5.404 : 8.933 : 13.34 : 18.64);
clamped–free bar (1 : 6.267 : 17.55 : 34.39 : 56.84 : 84.91); ideal circular
membrane (ch. 3, 1 : 1.594 : 2.136 : 2.296 : 2.653 : 2.918); free circular plate,
ν ≈ 0.33 (1 : 1.73 : 2.33 : 3.91 : 4.11 : 6.30); church bell partials relative
to the hum (ch. 21, hum : prime : tierce : quint : nominal : deciem =
1 : 2 : 2.4 : 3 : 4 : 5); stiff string f_n = n f_1 √(1 + B n²) (ch. 2).

Classification: each measured ratio to its nearest reference ratio, mean
|log| distance; string fits B on a grid to 0.02. Confidence is 1 − best/second.
Below 0.25, or with a best distance over 3 %, the family is `unknown` and
the engine scales uniformly with no position dependence.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/run.mjs 2>&1 | rg -n "not ok|AssertionError|found instruments" | head -5`
Expected: `ok - found instruments: 3 cases`

- [ ] **Step 5: Commit**

```bash
git add js/instrument/card.js js/instrument/card-format.md test/run.mjs
git commit -m "Instrument cards: modes, damping law, family from partial ratios, residual print

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The nonlinearity law from a hit's own decay

**Files:**
- Modify: `js/instrument/card.js` (add `trackMode`, `fitNonlinearity`, wire into `buildCard`)
- Modify: `test/run.mjs`

**Interfaces:**
- Produces: `trackMode(samples, sampleRate, freqHz, { frameSec = 0.02 })` → `{ times, amps, freqs }`; `fitNonlinearity(samples, sampleRate, modes, { minR2 = 0.6 })` → array of `{ mode, hzPerAmp, r2 }` or `[]`. `buildCard` sets `card.nonlinearity` only when the array is non-empty.

- [ ] **Step 1: Write the failing tests**

Append to `instrumentCases`:

```js
  function aLoudHitWhosePitchBendsWithAmplitudeGetsALaw() {
    // one mode whose frequency is f0 + k·A(t): phase integrates the instantaneous frequency
    const sr = 48000, f0 = 300, k = 40, tau = 0.4, seconds = 1.2, n = sr * seconds;
    const x = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) { const A = 0.5 * Math.exp(-i / sr / tau); x[i] = A * Math.sin(phase); phase += 2 * Math.PI * (f0 + k * A) / sr; }
    const modes = [{ freqHz: f0 + k * 0.25, tauSec: tau, amp: 0.5, phase: 0 }];
    const law = fitNonlinearity(x, sr, modes);
    assert.equal(law.length, 1, 'one mode, one law');
    close(law[0].hzPerAmp, k, k * 0.15, 'Hz per unit amplitude within 15%');
    assert.ok(law[0].r2 >= 0.6, 'r² ' + law[0].r2.toFixed(2));
    const linear = fitNonlinearity(damped(sr, seconds, [{ f: f0, tau, amp: 0.5, phase: 0 }]), sr, [{ freqHz: f0, tauSec: tau, amp: 0.5, phase: 0 }]);
    assert.equal(linear.length, 0, 'a linear mode gets no law');
  },
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/run.mjs 2>&1 | rg -n "not ok|Error" | head -3`
Expected: `fitNonlinearity is not defined` (add it to the import line first: `import { buildCard, fitDampingLaw, classifyFamily, qAt, FAMILY_RATIOS, fitNonlinearity } from '../js/instrument/card.js';`)

- [ ] **Step 3: Implement**

Append to `js/instrument/card.js`:

```js
/**
 * Heterodyne one mode: per frame, the complex mean of x·e^{-iωt} gives the
 * mode's amplitude and phase; the phase advance between frames gives its
 * instantaneous frequency. Frames of `frameSec`, hop half a frame.
 */
export function trackMode(samples, sampleRate, freqHz, { frameSec = 0.02 } = {}) {
  const frame = Math.max(8, Math.round(frameSec * sampleRate)), hop = Math.max(1, frame >> 1);
  const w = 2 * Math.PI * freqHz / sampleRate;
  const times = [], amps = [], freqs = [];
  let prevPhase = null, prevT = 0;
  for (let start = 0; start + frame <= samples.length; start += hop) {
    let re = 0, im = 0;
    for (let i = 0; i < frame; i++) {
      const win = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / frame);
      const v = samples[start + i] * win, ang = w * (start + i);
      re += v * Math.cos(ang); im -= v * Math.sin(ang);
    }
    // Hann-windowed mean: amplitude of a·sin is (a/2)·(frame/2)·... normalise by the window sum
    const norm = 2 / (0.5 * frame);
    const amp = Math.hypot(re, im) * norm, ph = Math.atan2(im, re), t = (start + frame / 2) / sampleRate;
    if (prevPhase !== null) {
      let d = ph - prevPhase; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      freqs.push(freqHz + d / (2 * Math.PI * (t - prevT))); amps.push(amp); times.push(t);
    }
    prevPhase = ph; prevT = t;
  }
  return { times, amps, freqs };
}

/** Per-mode frequency-versus-amplitude slope over the decay, kept only when it explains the drift. */
export function fitNonlinearity(samples, sampleRate, modes, { minR2 = 0.6, minHzPerAmp = 1 } = {}) {
  const out = [];
  modes.forEach((m, index) => {
    const tr = trackMode(samples, sampleRate, m.freqHz);
    const peak = Math.max(0, ...tr.amps);
    const xs = [], ys = [];
    for (let i = 0; i < tr.amps.length; i++) if (tr.amps[i] > 0.05 * peak && tr.amps[i] < 0.95 * peak) { xs.push(tr.amps[i]); ys.push(tr.freqs[i]); }
    if (xs.length < 6) return;
    const fit = linearFit(xs, ys);
    if (fit.r2 >= minR2 && Math.abs(fit.slope) >= minHzPerAmp) out.push({ mode: index, hzPerAmp: fit.slope, r2: fit.r2 });
  });
  return out;
}
```

In `buildCard`, after `residual:` add nothing; after the `card` object is built add:

```js
  const law = fitNonlinearity(samples, sampleRate, modes);
  if (law.length) card.nonlinearity = law;
```

- [ ] **Step 4: Run the tests**

Run: `node test/run.mjs 2>&1 | rg -n "not ok|AssertionError|found instruments" | head -5`
Expected: `ok - found instruments: 4 cases`

- [ ] **Step 5: Commit**

```bash
git add js/instrument/card.js test/run.mjs
git commit -m "Instrument cards: nonlinearity law measured on a hit's own decay

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Family generalisation — modes at any pitch, position, hardness

**Files:**
- Create: `js/instrument/family.js`
- Modify: `test/run.mjs`

**Interfaces:**
- Consumes: `qAt(damping, hz)`, `card.family`, `card.modes`.
- Produces: `modesAt(card, pitchHz, { position = null, hardness = 0.5 })` → `[{ freqHz, tauSec, amp, phase, index, weight }]`; `contactTimeSec(hardness)` → seconds; `halfSineWeight(freqHz, tauC)` → 0..1; `modeShape(family, index, position)` → 0..1; `cardPitchHz(card)` → the lowest mode's frequency.

- [ ] **Step 1: Write the failing tests**

Append to `instrumentCases` (and add `import { modesAt, contactTimeSec, halfSineWeight, modeShape, cardPitchHz } from '../js/instrument/family.js';`):

```js
  function anOctaveUpDecaysAsTheDampingLawSaysNotAsTheCardSays() {
    const sr = 48000, card = buildCard(barRecording(sr), sr, { name: 'bar' });
    const base = modesAt(card, cardPitchHz(card));
    const up = modesAt(card, 2 * cardPitchHz(card));
    close(up[0].freqHz, 2 * base[0].freqHz, 0.01, 'pitch doubled');
    close(up[1].freqHz / up[0].freqHz, 2.756, 0.01, 'ratios preserved');
    // constant Q: τ = Q/(π f) halves an octave up
    close(up[0].tauSec, base[0].tauSec / 2, base[0].tauSec * 0.05, 'decay follows Q(f) within 5%');
  },
  function aStrikeOnANodeSilencesThatMode() {
    const sr = 48000, card = buildCard(barRecording(sr), sr, { name: 'bar' });
    // free-free bar: mode 2 (index 1) has a node at the centre
    const centre = modesAt(card, cardPitchHz(card), { position: 0.5 });
    const off = modesAt(card, cardPitchHz(card), { position: 0.3 });
    const db = 20 * Math.log10((centre[1].amp + 1e-12) / (off[1].amp + 1e-12));
    assert.ok(db < -40, 'mode 2 at its node is ' + db.toFixed(1) + ' dB below off-node');
    assert.ok(centre[0].amp > 0.5 * off[0].amp, 'the fundamental still sounds at the centre');
  },
  function hardnessBrightensMonotonically() {
    const sr = 48000, card = buildCard(barRecording(sr), sr, { name: 'bar' });
    const centroid = (h) => { const m = modesAt(card, cardPitchHz(card), { hardness: h }); let n = 0, d = 0; for (const x of m) { n += x.amp * x.freqHz; d += x.amp; } return n / d; };
    let last = -1;
    for (const h of [0, 0.25, 0.5, 0.75, 1]) { const c = centroid(h); assert.ok(c > last, `centroid rises: h=${h} → ${c.toFixed(0)} Hz`); last = c; }
    close(contactTimeSec(0), 0.008, 1e-6, 'soft: 8 ms'); close(contactTimeSec(1), 0.0002, 1e-6, 'hard: 0.2 ms');
    close(halfSineWeight(0, 0.003), 1, 1e-9, 'DC weight is one');
  },
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/run.mjs 2>&1 | rg -n "Cannot find module|not ok" | head -2`
Expected: `Cannot find module '.../js/instrument/family.js'`

- [ ] **Step 3: Implement**

`js/instrument/family.js`:

```js
// One card, a whole family: the mode table at any pitch, struck anywhere,
// with any mallet, by the object's own laws rather than by shifting audio.

import { qAt } from './card.js';

export function cardPitchHz(card) { return card.modes.length ? card.modes[0].freqHz : 440; }

/** Hertz contact time from hardness 0 (8 ms, felt) to 1 (0.2 ms, steel), log-mapped. */
export function contactTimeSec(hardness) {
  const h = Math.max(0, Math.min(1, hardness));
  return 0.008 * Math.pow(0.025, h);
}

/** Spectrum of a half-sine force pulse of duration tauC, normalised to 1 at DC. */
export function halfSineWeight(freqHz, tauC) {
  const x = freqHz * tauC; // cycles across the pulse
  const den = 1 - 4 * x * x;
  if (Math.abs(den) < 1e-6) return Math.PI / 4;
  return Math.abs(Math.cos(Math.PI * x) / den);
}

const FREE_BAR_BETA = [4.730, 7.853, 10.996, 14.137, 17.279, 20.420];
const BESSEL_ZEROS = [2.405, 5.520, 8.654];
function j0(x) { let term = 1, sum = 1; for (let k = 1; k < 30; k++) { term *= -(x * x) / (4 * k * k); sum += term; if (Math.abs(term) < 1e-12) break; } return sum; }
function freeBarShape(n, p) {
  const b = FREE_BAR_BETA[n] ?? (2 * n + 1) * Math.PI / 2, x = b * p;
  const sigma = (Math.cosh(b) - Math.cos(b)) / (Math.sinh(b) - Math.sin(b));
  const phi = Math.cosh(x) + Math.cos(x) - sigma * (Math.sinh(x) + Math.sin(x));
  const end = Math.cosh(b) + Math.cos(b) - sigma * (Math.sinh(b) + Math.sin(b)); // |phi| is largest at the free ends
  return Math.abs(phi) / Math.max(Math.abs(end), 1e-9);
}

/**
 * Mode-shape magnitude at position p in [0, 1] for mode `index` (0 = lowest).
 * Strings: |sin((n+1)πp)|. Bars: free-free beam shapes. Membranes and plates:
 * J0 at the axisymmetric modes (indices 0, 3, 5 in the reference set), 1
 * elsewhere, p read as normalised radius. Unknown: 1.
 */
export function modeShape(family, index, p) {
  const pos = Math.max(0, Math.min(1, p));
  switch (family) {
    case 'string': return Math.abs(Math.sin((index + 1) * Math.PI * pos));
    case 'bar': case 'cantilever': return freeBarShape(index, pos);
    case 'membrane': case 'plate': { const k = [0, 3, 5].indexOf(index); return k < 0 ? 1 : Math.abs(j0(BESSEL_ZEROS[k] * pos)); }
    default: return 1;
  }
}

/**
 * The card's modes at `pitchHz`: frequencies by the family's scaling law,
 * decays from the damping law, amplitudes weighted by strike position and
 * mallet hardness. `weight` records position×hardness for the metadata.
 */
export function modesAt(card, pitchHz, { position = null, hardness = 0.5 } = {}) {
  const f1 = cardPitchHz(card), scale = pitchHz / f1;
  const tauC = contactTimeSec(hardness);
  const B = card.family.inharmonicity || 0;
  return card.modes.map((m, index) => {
    let freqHz;
    if (card.family.kind === 'string' && B > 0) {
      const n = Math.max(1, Math.round(m.freqHz / f1 / Math.sqrt(1 + B)));
      const B2 = B * scale * scale;
      freqHz = n * pitchHz * Math.sqrt(1 + B2 * n * n) / Math.sqrt(1 + B2);
    } else freqHz = m.freqHz * scale;
    const tauSec = qAt(card.damping, freqHz) / (Math.PI * freqHz);
    const shape = position === null ? 1 : modeShape(card.family.kind, index, position);
    const weight = shape * halfSineWeight(freqHz, tauC);
    return { freqHz, tauSec, amp: m.amp * weight, phase: m.phase, index, weight };
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `node test/run.mjs 2>&1 | rg -n "not ok|AssertionError|found instruments" | head -5`
Expected: `ok - found instruments: 7 cases`

- [ ] **Step 5: Commit**

```bash
git add js/instrument/family.js test/run.mjs
git commit -m "Instrument families: scaling laws, damping-law decays, mode-shape position, Hertz hardness

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Resonator bank, strike and pluck

**Files:**
- Create: `js/instrument/excite/bank.js`, `js/instrument/excite/strike.js`, `js/instrument/excite/pluck.js`
- Modify: `test/run.mjs`

**Interfaces:**
- Consumes: `modesAt`, `synthModal(modes, sampleRate, seconds)`, `card.nonlinearity`.
- Produces: `runBank(modes, excitation, sampleRate, { nonlinearity = null, gain = 1 })` → `Float32Array` (same length as excitation); `strike(card, { pitchHz, position, hardness, velocity = 1, seconds, sampleRate })` → `Float32Array`; `pluck(card, { pitchHz, position = 0.2, velocity = 1, seconds, sampleRate })` → `Float32Array`; `pluckWeights(count, position)` → `number[]`.

- [ ] **Step 1: Write the failing tests**

Append (imports: `import { runBank } from '../js/instrument/excite/bank.js'; import { strike } from '../js/instrument/excite/strike.js'; import { pluck, pluckWeights } from '../js/instrument/excite/pluck.js';`):

```js
  function theBankRingsAnImpulseAtTheModesAmplitudeAndDecay() {
    const sr = 48000, modes = [{ freqHz: 500, tauSec: 0.2, amp: 0.4, phase: 0 }];
    const x = new Float32Array(sr); x[0] = 1;
    const y = runBank(modes, x, sr);
    let peak = 0; for (let i = 0; i < 200; i++) peak = Math.max(peak, Math.abs(y[i]));
    close(peak, 0.4, 0.04, 'first cycle peak is the mode amplitude');
    // energy at 0.2 s is 1/e of the start
    const env = (t) => { let m = 0; for (let i = Math.round(t * sr); i < Math.round(t * sr) + 200; i++) m = Math.max(m, Math.abs(y[i])); return m; };
    close(env(0.2) / env(0.002), Math.exp(-1), 0.05, 'decays to 1/e in tauSec');
  },
  function aNonlinearModeBendsWhileLoudAndSettlesWhenQuiet() {
    const sr = 48000, modes = [{ freqHz: 300, tauSec: 0.3, amp: 0.5, phase: 0 }];
    const x = new Float32Array(sr); x[0] = 1;
    const y = runBank(modes, x, sr, { nonlinearity: [{ mode: 0, hzPerAmp: 60, r2: 1 }] });
    const zeroRate = (a, b) => { let z = 0; for (let i = Math.round(a * sr) + 1; i < Math.round(b * sr); i++) if ((y[i - 1] < 0) !== (y[i] < 0)) z++; return z / (b - a) / 2; };
    assert.ok(zeroRate(0.01, 0.06) > zeroRate(0.8, 0.95) + 5, `loud ${zeroRate(0.01, 0.06).toFixed(1)} Hz vs quiet ${zeroRate(0.8, 0.95).toFixed(1)} Hz`);
    close(zeroRate(0.8, 0.95), 300, 3, 'settles to the linear frequency');
  },
  function pluckingNearTheBridgeIsBrighterThanTheMiddle() {
    const w = pluckWeights(6, 0.5);
    close(w[1], 0, 1e-9, 'a mid-string pluck cannot excite the even modes');
    const sr = 48000, card = buildCard(damped(sr, 1, [1, 2, 3, 4, 5, 6].map((n) => ({ f: 220 * n, tau: 0.6 / n, amp: 0.5 / n, phase: 0 }))), sr, { name: 'string' });
    const centroid = (x) => { const N = 1 << 15, re = new Float32Array(N), im = new Float32Array(N); for (let i = 0; i < N; i++) re[i] = x[i] || 0; new RepairFFT(N).forward(re, im); let n = 0, d = 0; for (let k = 1; k < N / 2; k++) { const m = Math.hypot(re[k], im[k]); n += m * k * sr / N; d += m; } return n / d; };
    const bridge = centroid(pluck(card, { pitchHz: 220, position: 0.05, seconds: 1, sampleRate: sr }));
    const middle = centroid(pluck(card, { pitchHz: 220, position: 0.5, seconds: 1, sampleRate: sr }));
    assert.ok(bridge > middle * 1.2, `bridge ${bridge.toFixed(0)} Hz vs middle ${middle.toFixed(0)} Hz`);
    const hit = strike(card, { pitchHz: 220, hardness: 0.8, seconds: 1, sampleRate: sr });
    assert.equal(hit.length, sr); assert.ok(Math.max(...hit) > 0.05, 'a strike sounds');
  },
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/run.mjs 2>&1 | rg -n "Cannot find module|not ok" | head -2`
Expected: `Cannot find module '.../js/instrument/excite/bank.js'`

- [ ] **Step 3: Implement**

`js/instrument/excite/bank.js`:

```js
// A bank of second-order resonators, one per mode, driven by an excitation
// signal. Each resonator's frequency may follow its own amplitude through the
// card's nonlinearity law, which is why this exists alongside the closed form.

/**
 * y_i[n] = 2 r cos(ω) y_i[n-1] - r² y_i[n-2] + g_i x[n], r = exp(-1/(τ sr)),
 * g_i = amp_i · sin(ω) so a unit impulse rings at amp_i. With a nonlinearity
 * entry, ω follows f_i + hzPerAmp · A_i where A_i is the resonator's own
 * envelope (peak follower with the mode's decay).
 */
export function runBank(modes, excitation, sampleRate, { nonlinearity = null, gain = 1 } = {}) {
  const n = excitation.length, out = new Float32Array(n);
  const law = new Map((nonlinearity || []).map((L) => [L.mode, L.hzPerAmp]));
  modes.forEach((m, index) => {
    if (!(m.freqHz > 0) || !(m.tauSec > 0) || !(m.amp > 0)) return;
    const r = Math.exp(-1 / (m.tauSec * sampleRate)), r2 = r * r;
    const k = law.get(index) || 0;
    const w0 = 2 * Math.PI * m.freqHz / sampleRate;
    let a1 = 2 * r * Math.cos(w0), g = m.amp * Math.sin(w0) * gain;
    let y1 = 0, y2 = 0, env = 0;
    const envDecay = Math.exp(-1 / (0.005 * sampleRate));
    for (let i = 0; i < n; i++) {
      if (k !== 0 && (i & 63) === 0) { // retune every 64 samples from the follower
        const w = 2 * Math.PI * Math.max(1, m.freqHz + k * env) / sampleRate;
        a1 = 2 * r * Math.cos(w); g = m.amp * Math.sin(w) * gain;
      }
      const y = a1 * y1 - r2 * y2 + g * excitation[i];
      y2 = y1; y1 = y;
      const ay = Math.abs(y); env = ay > env ? ay : env * envDecay;
      out[i] += y;
    }
  });
  return out;
}
```

`js/instrument/excite/strike.js`:

```js
// Strike: a half-sine force pulse of Hertz contact time. Linear cards render
// in closed form; cards with a nonlinearity law go through the bank.

import { synthModal } from '../../analysis/modal.js';
import { modesAt, contactTimeSec } from '../family.js';
import { runBank } from './bank.js';

export function strike(card, { pitchHz, position = null, hardness = 0.5, velocity = 1, seconds = 2, sampleRate = 96000 } = {}) {
  const modes = modesAt(card, pitchHz, { position, hardness }).map((m) => ({ ...m, amp: m.amp * velocity, phase: 0 }));
  if (!card.nonlinearity) return synthModal(modes, sampleRate, seconds);
  const n = Math.round(seconds * sampleRate), x = new Float32Array(n);
  const len = Math.max(1, Math.round(contactTimeSec(hardness) * sampleRate));
  for (let i = 0; i < len && i < n; i++) x[i] = Math.sin(Math.PI * i / len) * (2 / len); // unit-area half sine
  return runBank(modes.map((m) => ({ ...m, amp: m.amp })), x, sampleRate, { nonlinearity: card.nonlinearity });
}
```

`js/instrument/excite/pluck.js`:

```js
// Pluck: an initial triangular displacement at position p gives mode n an
// amplitude ∝ sin(nπp)/n². Closed form.

import { synthModal } from '../../analysis/modal.js';
import { modesAt } from '../family.js';

export function pluckWeights(count, position) {
  const p = Math.max(0.001, Math.min(0.999, position));
  const w = [];
  for (let n = 1; n <= count; n++) w.push(Math.abs(Math.sin(n * Math.PI * p)) / (n * n));
  const max = Math.max(...w) || 1;
  return w.map((v) => v / max);
}

export function pluck(card, { pitchHz, position = 0.2, velocity = 1, seconds = 2, sampleRate = 96000 } = {}) {
  const base = modesAt(card, pitchHz, { position: null, hardness: 1 });
  const w = pluckWeights(base.length, position);
  const modes = base.map((m, i) => ({ ...m, amp: m.amp * w[i] * velocity, phase: Math.PI / 2 })); // displacement starts at its extreme
  return synthModal(modes, sampleRate, seconds);
}
```

- [ ] **Step 4: Run the tests**

Run: `node test/run.mjs 2>&1 | rg -n "not ok|AssertionError|found instruments" | head -5`
Expected: `ok - found instruments: 10 cases`

- [ ] **Step 5: Commit**

```bash
git add js/instrument/excite test/run.mjs
git commit -m "Instrument excitations: resonator bank with amplitude-dependent frequency, strike, pluck

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Tuning — retune deltas, dissonance curve, related scale

**Files:**
- Create: `js/instrument/tuning.js`
- Modify: `test/run.mjs`

**Interfaces:**
- Produces: `retuneDelta(card, target)` where target is `'harmonic'`, `'just'`, or `number[]` of ratios → `{ target, cents: number[] }`; `applyRetune(card, delta)` → new card (modes with frequencies shifted by cents); `dissonanceCurve(modes, { steps = 600, maxRatio = 2.05 })` → `[{ ratio, cents, roughness }]`; `relatedScale(modes)` → `[{ ratio, cents }]` of local minima within (1, 2].

- [ ] **Step 1: Write the failing tests**

Append (import `retuneDelta, applyRetune, dissonanceCurve, relatedScale` from `'../js/instrument/tuning.js'`):

```js
  function aRetuneDeltaRoundTripsExactly() {
    const sr = 48000, card = buildCard(barRecording(sr), sr, { name: 'bar' });
    const delta = retuneDelta(card, 'harmonic');
    const tuned = applyRetune(card, delta);
    close(tuned.modes[1].freqHz / tuned.modes[0].freqHz, 2, 1e-9, 'second partial is now the octave');
    const back = applyRetune(tuned, { target: delta.target, cents: delta.cents.map((c) => -c) });
    assert.deepEqual(back.modes.map((m) => m.freqHz), card.modes.map((m) => m.freqHz), 'bit-for-bit');
    assert.notEqual(tuned, card, 'the physical card is untouched');
  },
  function theRelatedScaleOfAHarmonicTimbreIsJust() {
    const modes = [1, 2, 3, 4, 5, 6].map((n) => ({ freqHz: 261.6 * n, tauSec: 1, amp: 0.88 ** n, phase: 0 }));
    const scale = relatedScale(modes);
    const cents = scale.map((s) => s.cents);
    for (const [ratio, name] of [[3 / 2, 'fifth'], [4 / 3, 'fourth'], [5 / 4, 'major third'], [6 / 5, 'minor third']]) {
      const c = 1200 * Math.log2(ratio);
      assert.ok(cents.some((x) => Math.abs(x - c) <= 5), `${name} (${c.toFixed(1)} c) is a minimum: ${cents.map((x) => x.toFixed(0)).join(' ')}`);
    }
    const curve = dissonanceCurve(modes);
    assert.ok(curve[0].roughness < curve[Math.round(curve.length * 0.05)].roughness, 'unison is smoother than a small interval');
  },
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/run.mjs 2>&1 | rg -n "Cannot find module|not ok" | head -2`
Expected: `Cannot find module '.../js/instrument/tuning.js'`

- [ ] **Step 3: Implement**

`js/instrument/tuning.js`:

```js
// Tuning: retune a card's modes to a target spectrum (stored as a delta, the
// physical card untouched), and read the scale a timbre is most consonant
// in from its own partials (Sethares, Tuning Timbre Spectrum Scale, 1998).

const JUST = [1, 9 / 8, 5 / 4, 4 / 3, 3 / 2, 5 / 3, 15 / 8, 2, 9 / 4, 5 / 2, 8 / 3, 3, 10 / 3, 15 / 4, 4, 9 / 2, 5, 16 / 3, 6];

function targetRatios(target, count) {
  if (Array.isArray(target)) return target;
  if (target === 'harmonic') return Array.from({ length: count }, (_, i) => i + 1);
  if (target === 'just') return JUST.slice(0, count);
  throw new Error('unknown retune target ' + target);
}

/** Cents to move each mode so its ratio to the lowest matches the nearest target ratio. */
export function retuneDelta(card, target) {
  const f1 = card.modes[0].freqHz;
  const ratios = targetRatios(target, card.modes.length);
  const cents = card.modes.map((m) => {
    const r = m.freqHz / f1;
    let best = ratios[0];
    for (const t of ratios) if (Math.abs(Math.log(r / t)) < Math.abs(Math.log(r / best))) best = t;
    return 1200 * Math.log2(best / r);
  });
  return { target: Array.isArray(target) ? 'custom' : target, cents };
}

export function applyRetune(card, delta) {
  return { ...card, modes: card.modes.map((m, i) => ({ ...m, freqHz: m.freqHz * Math.pow(2, (delta.cents[i] || 0) / 1200) })), retune: delta };
}

// Sethares' pairwise roughness of two partials
function roughness(f1, a1, f2, a2) {
  const fmin = Math.min(f1, f2), s = 0.24 / (0.021 * fmin + 19), x = Math.abs(f2 - f1);
  return a1 * a2 * (Math.exp(-3.5 * s * x) - Math.exp(-5.75 * s * x));
}

/** Total roughness of the timbre against itself transposed by each ratio. */
export function dissonanceCurve(modes, { steps = 600, maxRatio = 2.05 } = {}) {
  const parts = modes.filter((m) => m.freqHz > 0 && m.amp > 0);
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const ratio = Math.pow(maxRatio, i / steps);
    let d = 0;
    for (const a of parts) for (const b of parts) d += roughness(a.freqHz, a.amp, b.freqHz * ratio, b.amp);
    out.push({ ratio, cents: 1200 * Math.log2(ratio), roughness: d });
  }
  return out;
}

/** Local minima of the dissonance curve within (1, 2], the timbre's own scale. */
export function relatedScale(modes, opts = {}) {
  const curve = dissonanceCurve(modes, opts);
  const scale = [];
  for (let i = 1; i < curve.length - 1; i++) {
    if (curve[i].ratio <= 1.01 || curve[i].ratio > 2.005) continue;
    if (curve[i].roughness < curve[i - 1].roughness && curve[i].roughness <= curve[i + 1].roughness) scale.push({ ratio: curve[i].ratio, cents: curve[i].cents });
  }
  return scale;
}
```

- [ ] **Step 4: Run the tests**

Run: `node test/run.mjs 2>&1 | rg -n "not ok|AssertionError|found instruments" | head -5`
Expected: `ok - found instruments: 12 cases`

- [ ] **Step 5: Commit**

```bash
git add js/instrument/tuning.js test/run.mjs
git commit -m "Instrument tuning: retune deltas that round-trip, dissonance curves, related scales

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Body and radiation

**Files:**
- Create: `js/instrument/body.js`
- Modify: `test/run.mjs`

**Interfaces:**
- Consumes: `plateImpulse(sampleRate, seconds, decay, predelayMs)` from `js/dsp/space.js`; `FFT` from `js/fft.js`.
- Produces: `convolve(x, ir)` → `Float32Array` (length x + ir − 1, FFT overlap-add); `radiationFilter(family, sampleRate)` → `Float32Array` short IR; `applyBody(samples, sampleRate, { kind = 'radiation', family = 'unknown', ir = null, mix = 1 })` → `Float32Array` same length as input.

- [ ] **Step 1: Write the failing tests**

Append (import `convolve, radiationFilter, applyBody` from `'../js/instrument/body.js'`):

```js
  function convolutionMatchesTheDirectSumAndTheBodyKeepsLength() {
    const x = Float32Array.from({ length: 300 }, (_, i) => Math.sin(i * 0.3)), ir = Float32Array.from([1, 0.5, -0.25, 0.125]);
    const y = convolve(x, ir);
    assert.equal(y.length, x.length + ir.length - 1);
    for (let i = 0; i < 20; i++) { let d = 0; for (let k = 0; k < ir.length; k++) if (i - k >= 0) d += x[i - k] * ir[k]; close(y[i], d, 1e-5, 'sample ' + i); }
    const sr = 48000, tone = Float32Array.from({ length: sr }, (_, i) => Math.sin(2 * Math.PI * 440 * i / sr) * Math.exp(-i / sr / 0.3));
    for (const kind of ['radiation', 'plate']) { const b = applyBody(tone, sr, { kind, family: 'bar' }); assert.equal(b.length, tone.length, kind + ' keeps length'); assert.ok(Math.max(...b) > 0.1, kind + ' sounds'); }
    const bars = radiationFilter('bar', sr), skins = radiationFilter('membrane', sr);
    const hf = (h) => { let s = 0; for (let i = 0; i < h.length; i++) s += h[i] * Math.cos(2 * Math.PI * 6000 * i / sr); return Math.abs(s); };
    assert.ok(hf(bars) > hf(skins), 'bars radiate more at 6 kHz than skins');
  },
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/run.mjs 2>&1 | rg -n "Cannot find module|not ok" | head -2`
Expected: `Cannot find module '.../js/instrument/body.js'`

- [ ] **Step 3: Implement**

`js/instrument/body.js`:

```js
// Body and radiation: what sits between the resonator and the air. A short
// impulse response — generated plate, measured room, or a per-family
// radiation filter — convolved by FFT overlap-add. Part of the instrument.

import { FFT, nextPow2 } from '../fft.js';
import { plateImpulse } from '../dsp/space.js';

export function convolve(x, ir) {
  const outLen = x.length + ir.length - 1;
  const block = Math.max(256, nextPow2(ir.length)), N = block * 2, fft = new FFT(N);
  const hre = new Float32Array(N), him = new Float32Array(N);
  hre.set(ir.subarray(0, Math.min(ir.length, block)));
  fft.forward(hre, him);
  const out = new Float32Array(outLen);
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let start = 0; start < x.length; start += block) {
    re.fill(0); im.fill(0);
    const len = Math.min(block, x.length - start);
    for (let i = 0; i < len; i++) re[i] = x[start + i];
    fft.forward(re, im);
    for (let k = 0; k < N; k++) { const a = re[k], b = im[k]; re[k] = a * hre[k] - b * him[k]; im[k] = a * him[k] + b * hre[k]; }
    fft.inverse(re, im);
    for (let i = 0; i < N && start + i < outLen; i++) out[start + i] += re[i];
  }
  return out;
}

/** A gentle per-family radiation curve as a 64-tap minimum-phase-ish FIR. */
export function radiationFilter(family, sampleRate) {
  const taps = 64, h = new Float32Array(taps);
  // bars/plates: +3 dB shelf above 3 kHz; membranes: −6 dB above 3 kHz with a 200 Hz bump; else flat
  const tilt = family === 'bar' || family === 'plate' || family === 'cantilever' ? 0.4 : family === 'membrane' ? -0.5 : 0;
  const fc = 3000 / sampleRate;
  for (let i = 0; i < taps; i++) {
    const n = i - taps / 2 + 0.5, sinc = Math.sin(2 * Math.PI * fc * n) / (Math.PI * n), w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / taps);
    h[i] = w * (-tilt * sinc); // high-shelf: pass-through minus/plus a low-pass
  }
  h[taps / 2] += 1 + (family === 'membrane' ? 0.0 : 0);
  if (family === 'membrane') { // low-mid bump: a short decaying cosine at 200 Hz
    for (let i = 0; i < taps; i++) h[i] += 0.15 * Math.cos(2 * Math.PI * 200 * i / sampleRate) * Math.exp(-i / 20);
  }
  return h;
}

export function applyBody(samples, sampleRate, { kind = 'radiation', family = 'unknown', ir = null, mix = 1 } = {}) {
  const impulse = kind === 'ir' && ir ? ir : kind === 'plate' ? plateImpulse(sampleRate, 0.25, 0.5, 0) : radiationFilter(family, sampleRate);
  const wet = convolve(samples, impulse);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < out.length; i++) out[i] = (1 - mix) * samples[i] + mix * wet[i];
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `node test/run.mjs 2>&1 | rg -n "not ok|AssertionError|found instruments" | head -5`
Expected: `ok - found instruments: 13 cases`

- [ ] **Step 5: Commit**

```bash
git add js/instrument/body.js test/run.mjs
git commit -m "Instrument body: FFT convolution, plate and measured IRs, per-family radiation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Render — voices, oversampling, metadata, cache, audition WAV

**Files:**
- Create: `js/instrument/render.js`, `scripts/lib/wav.mjs`
- Modify: `scripts/master-take.mjs` (import `readWav`/`writeWav24` from `scripts/lib/wav.mjs`), `test/run.mjs`

**Interfaces:**
- Consumes: `strike`, `pluck`, `runBank`, `applyBody`, `resample(input, inRate, outRate, { cutoffScale })`.
- Produces: `TRUTH_RATE = 96000`, `OVERSAMPLE = 4`; `renderVoice({ card, pitchHz, excitation = 'strike', params = {}, dynamics = 1, seconds = 2, body = { kind: 'radiation' }, seed = 1 })` → `{ samples, sampleRate, meta: { peak, decay60Sec, centroidHz, used: { position, path } }, key }`; `voiceKey(inputs)` → string; `clearCache()`; `readWav(path)` → `{ channels: Float32Array[], sampleRate }`; `writeWav24(path, channels, sampleRate)`.

- [ ] **Step 1: Write the failing tests**

Append (import `renderVoice, voiceKey, clearCache, TRUTH_RATE` from `'../js/instrument/render.js'`):

```js
  function rendersAreDeterministicCachedAndDescribed() {
    const sr = 48000, card = buildCard(barRecording(sr), sr, { name: 'bar' });
    clearCache();
    const a = renderVoice({ card, pitchHz: 440, excitation: 'strike', seconds: 1 });
    const b = renderVoice({ card, pitchHz: 440, excitation: 'strike', seconds: 1 });
    assert.equal(a.sampleRate, TRUTH_RATE);
    assert.equal(a.samples.length, TRUTH_RATE);
    assert.deepEqual(Array.from(a.samples.subarray(0, 64)), Array.from(b.samples.subarray(0, 64)), 'bit-identical');
    assert.equal(a.key, b.key); assert.equal(a.samples, b.samples, 'the second call is the cached buffer');
    assert.ok(a.meta.peak > 0 && a.meta.decay60Sec > 0.05 && a.meta.centroidHz > 400, JSON.stringify(a.meta));
    assert.equal(a.meta.used.path, 'closed-form');
    const other = renderVoice({ card, pitchHz: 880, excitation: 'pluck', seconds: 1 });
    assert.notEqual(other.key, a.key);
    assert.ok(other.meta.decay60Sec < a.meta.decay60Sec, 'an octave up decays sooner');
  },
  function aNonlinearCardTakesTheOversampledPathAndALinearOneDoesNot() {
    const sr = 48000, card = buildCard(barRecording(sr), sr, { name: 'bar' });
    const bent = { ...card, nonlinearity: [{ mode: 0, hzPerAmp: 30, r2: 1 }] };
    const v = renderVoice({ card: bent, pitchHz: 440, seconds: 0.5 });
    assert.equal(v.meta.used.path, 'bank-4x');
    assert.equal(v.samples.length, Math.round(0.5 * TRUTH_RATE));
    assert.ok(v.meta.peak > 0.01);
  },
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/run.mjs 2>&1 | rg -n "Cannot find module|not ok" | head -2`
Expected: `Cannot find module '.../js/instrument/render.js'`

- [ ] **Step 3: Implement**

`js/instrument/render.js`:

```js
// renderVoice: card + pitch + excitation + dynamics → samples at the truth
// rate, with metadata and a content-keyed cache. Closed-form paths render
// directly; the bank runs at 4× and is Kaiser-decimated. Deterministic.

import { resample } from '../dsp/resample.js';
import { strike } from './excite/strike.js';
import { pluck } from './excite/pluck.js';
import { applyBody } from './body.js';

export const TRUTH_RATE = 96000;
export const OVERSAMPLE = 4;

const cache = new Map();
export function clearCache() { cache.clear(); }

export function voiceKey(inputs) { // FNV-1a 64-bit over the canonical JSON; a cache key, not a signature
  const s = JSON.stringify(inputs);
  let h1 = 0x811c9dc5, h2 = 0xcbf29ce4;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0; h2 ^= c; h2 = Math.imul(h2, 0x01000193) >>> 0; }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function describe(samples, sampleRate) {
  let peak = 0, at = 0;
  for (let i = 0; i < samples.length; i++) { const v = Math.abs(samples[i]); if (v > peak) { peak = v; at = i; } }
  const floor = peak * 1e-3; // −60 dB
  let last = at; const win = Math.round(0.01 * sampleRate);
  for (let i = at; i < samples.length; i += win) { let m = 0; for (let k = i; k < i + win && k < samples.length; k++) m = Math.max(m, Math.abs(samples[k])); if (m > floor) last = i; }
  let n = 0, d = 0, prev = samples[0] || 0, zc = 0; // spectral centroid by short-time zero-crossing proxy is crude; use magnitude spectrum instead
  const N = Math.min(samples.length, 1 << 15);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = samples[i];
  for (let k = 1; k < N / 2; k += 2) { let sr = 0, si = 0; for (let i = 0; i < N; i += 4) { const a = 2 * Math.PI * k * i / N; sr += re[i] * Math.cos(a); si -= re[i] * Math.sin(a); } const m = Math.hypot(sr, si); n += m * k * sampleRate / N; d += m; }
  void prev; void zc; void im;
  return { peak, decay60Sec: (last - at) / sampleRate, centroidHz: d > 0 ? n / d : 0 };
}

export function renderVoice({ card, pitchHz, excitation = 'strike', params = {}, dynamics = 1, seconds = 2, body = { kind: 'radiation' }, seed = 1 } = {}) {
  const inputs = { id: card.id, modes: card.modes, damping: card.damping, family: card.family, nonlinearity: card.nonlinearity || null, retune: card.retune || null, pitchHz, excitation, params, dynamics, seconds, body, seed };
  const key = voiceKey(inputs);
  if (cache.has(key)) return cache.get(key);
  const nonlinear = !!card.nonlinearity;
  const rate = nonlinear ? TRUTH_RATE * OVERSAMPLE : TRUTH_RATE;
  let raw;
  if (excitation === 'strike') raw = strike(card, { ...params, pitchHz, velocity: dynamics, seconds, sampleRate: rate });
  else if (excitation === 'pluck') raw = pluck(card, { ...params, pitchHz, velocity: dynamics, seconds, sampleRate: rate });
  else throw new Error('excitation not available yet: ' + excitation);
  const truth = rate === TRUTH_RATE ? raw : resample(raw, rate, TRUTH_RATE, { cutoffScale: 0.45 }).subarray(0, Math.round(seconds * TRUTH_RATE));
  const samples = body && body.kind ? applyBody(truth, TRUTH_RATE, { ...body, family: card.family.kind }) : truth;
  const result = { samples, sampleRate: TRUTH_RATE, key, meta: { ...describe(samples, TRUTH_RATE), used: { position: card.hits ? 'measured' : 'theory', path: nonlinear ? 'bank-4x' : 'closed-form' } } };
  cache.set(key, result);
  return result;
}
```

`scripts/lib/wav.mjs` — move `readWav` and `writeWav24` out of `scripts/master-take.mjs` verbatim, generalised: `readWav(path)` returns `{ channels, sampleRate }` (an array of Float32Array), `writeWav24(path, channels, sampleRate)` takes an array of channels. Update `scripts/master-take.mjs` to build its AudioBuffer from `readWav`'s channels and to call `writeWav24(outPath, [...channels], rate)`. Run `node scripts/master-take.mjs` on any WAV to confirm it still prints before/after.

- [ ] **Step 4: Run the tests**

Run: `node test/run.mjs 2>&1 | rg -n "not ok|AssertionError|found instruments" | head -5`
Expected: `ok - found instruments: 15 cases`

- [ ] **Step 5: Commit**

```bash
git add js/instrument/render.js scripts/lib/wav.mjs scripts/master-take.mjs test/run.mjs
git commit -m "Instrument render: truth-rate voices, oversampled nonlinear path, metadata, cache; shared node WAV io

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Breath

**Files:**
- Create: `js/instrument/excite/breath.js`
- Modify: `js/instrument/render.js` (dispatch `'breath'`), `test/run.mjs`

**Interfaces:**
- Consumes: `modesAt`, `runBank` (used per sample via an inlined bank — see implementation), `residualSamples(card)`.
- Produces: `breath(card, { pitchHz, pressure = 0.6, noise = 0.05, seconds, sampleRate, seed = 1 })` → `Float32Array`.

- [ ] **Step 1: Write the failing test**

Append (import `breath` from `'../js/instrument/excite/breath.js'`):

```js
  function theBlownModelLocksToTheFirstMode() {
    const sr = 48000, card = buildCard(barRecording(sr, 330), sr, { name: 'bar' });
    const y = breath(card, { pitchHz: 330, pressure: 0.6, seconds: 1.5, sampleRate: sr });
    const tail = y.subarray(Math.round(0.5 * sr), Math.round(1.5 * sr));
    let z = 0; for (let i = 1; i < tail.length; i++) if ((tail[i - 1] < 0) !== (tail[i] < 0)) z++;
    const hz = z / 2 / (tail.length / sr);
    close(hz, 330, 3.3, 'fundamental within 1% of the first mode');
    let rms = 0; for (const v of tail) rms += v * v; rms = Math.sqrt(rms / tail.length);
    assert.ok(rms > 0.02, 'it sustains: rms ' + rms.toFixed(3));
    const v = renderVoice({ card, pitchHz: 330, excitation: 'breath', seconds: 0.5 });
    assert.equal(v.meta.used.path, 'bank-4x');
  },
```

- [ ] **Step 2: Run to verify it fails**

Expected: `Cannot find module '.../js/instrument/excite/breath.js'`

- [ ] **Step 3: Implement**

`js/instrument/excite/breath.js`:

```js
// Breath: a jet through a cubic pressure-to-flow law drives the bank, and the
// bank's output feeds back into the jet (Cook's blown-bottle family). The
// turbulence noise is the card's own residual print. Deterministic.

import { modesAt } from '../family.js';
import { residualSamples } from '../card.js';

export function breath(card, { pitchHz, pressure = 0.6, noise = 0.05, seconds = 2, sampleRate = 96000, feedback = 0.9, seed = 1 } = {}) {
  const modes = modesAt(card, pitchHz, { position: null, hardness: 0.3 }).filter((m) => m.amp > 0);
  const n = Math.round(seconds * sampleRate), out = new Float32Array(n);
  const print = residualSamples(card), printLen = print.length || 1;
  const state = modes.map((m) => { const w = 2 * Math.PI * m.freqHz / sampleRate, r = Math.exp(-1 / (m.tauSec * sampleRate)); return { a1: 2 * r * Math.cos(w), r2: r * r, g: m.amp * Math.sin(w), y1: 0, y2: 0 }; });
  const ramp = Math.round(0.03 * sampleRate);
  let fb = 0, s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    const p = pressure * Math.min(1, i / ramp);
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    const turb = noise * p * (print[i % printLen] * 0.7 + ((s >>> 0) / 4294967296 * 2 - 1) * 0.3);
    let u = p - fb; u = Math.max(-1, Math.min(1, u));
    const x = (u - u * u * u) + turb;          // jet flow through the cubic law
    let y = 0;
    for (const st of state) { const v = st.a1 * st.y1 - st.r2 * st.y2 + st.g * x; st.y2 = st.y1; st.y1 = v; y += v; }
    fb = feedback * Math.max(-1, Math.min(1, y * 4));
    out[i] = y;
  }
  return out;
}
```

In `render.js`, add `import { breath } from './excite/breath.js';` and, before the `else throw`, `else if (excitation === 'breath') raw = breath(card, { ...params, pitchHz, pressure: (params.pressure ?? 0.6) * dynamics, seconds, sampleRate: rate, seed });` and make `nonlinear` true for breath: `const nonlinear = !!card.nonlinearity || excitation === 'breath' || excitation === 'bow';`.

- [ ] **Step 4: Run the tests**

Expected: `ok - found instruments: 16 cases`. If the lock test fails, raise `feedback` toward 0.95 or the `y * 4` drive toward `y * 8`; the model locks when the loop gain around the first mode exceeds one.

- [ ] **Step 5: Commit**

```bash
git add js/instrument/excite/breath.js js/instrument/render.js test/run.mjs
git commit -m "Instrument excitations: breath (jet through a cubic law, fed back through the bank)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Bow

**Files:**
- Create: `js/instrument/excite/bow.js`
- Modify: `js/instrument/render.js` (dispatch `'bow'`), `test/run.mjs`

**Interfaces:**
- Produces: `bow(card, { pitchHz, force = 0.3, speed = 0.2, position = 0.12, seconds, sampleRate })` → `Float32Array`; `stableForceRange(card, { pitchHz })` → `{ min, max }`.

- [ ] **Step 1: Write the failing test**

Append (import `bow, stableForceRange` from `'../js/instrument/excite/bow.js'`):

```js
  function theBowSustainsInItsStableRangeAndGrowsWithForce() {
    const sr = 48000, card = buildCard(damped(sr, 1, [1, 2, 3, 4, 5, 6].map((n) => ({ f: 196 * n, tau: 0.8 / n, amp: 0.5 / n, phase: 0 }))), sr, { name: 'string' });
    const range = stableForceRange(card, { pitchHz: 196 });
    assert.ok(range.max > range.min && range.min >= 0, JSON.stringify(range));
    const rmsOf = (y, a, b) => { let s = 0, c = 0; for (let i = Math.round(a * sr); i < Math.round(b * sr); i++) { s += y[i] * y[i]; c++; } return Math.sqrt(s / c); };
    const mid = (range.min + range.max) / 2;
    const y = bow(card, { pitchHz: 196, force: mid, seconds: 2, sampleRate: sr });
    const r1 = rmsOf(y, 1.0, 1.5), r2 = rmsOf(y, 1.5, 2.0);
    assert.ok(r1 > 0.01, 'it sounds: ' + r1.toFixed(4));
    assert.ok(Math.abs(r1 - r2) / r1 < 0.1, `steady over the second half: ${r1.toFixed(4)} vs ${r2.toFixed(4)}`);
    const louder = bow(card, { pitchHz: 196, force: range.min + 0.8 * (range.max - range.min), seconds: 2, sampleRate: sr });
    const softer = bow(card, { pitchHz: 196, force: range.min + 0.2 * (range.max - range.min), seconds: 2, sampleRate: sr });
    assert.ok(rmsOf(louder, 1, 2) > rmsOf(softer, 1, 2), 'more force, more sound');
    const v = renderVoice({ card, pitchHz: 196, excitation: 'bow', seconds: 0.5 });
    assert.equal(v.meta.used.path, 'bank-4x');
  },
```

- [ ] **Step 2: Run to verify it fails**

Expected: `Cannot find module '.../js/instrument/excite/bow.js'`

- [ ] **Step 3: Implement**

`js/instrument/excite/bow.js`:

```js
// Bow: stick-slip friction on the mode bank (after McIntyre, Schumacher and
// Woodhouse). The string's velocity at the bow point is the bank's output;
// the friction force follows a curve in the relative velocity — a static peak
// and a falling sliding branch — so the string sticks to the bow, is carried,
// breaks free, and is caught again. Stable sustain, crescendo with force and
// raucous over-pressure are consequences of the curve, not settings.

import { modesAt, modeShape } from '../family.js';

const MU_STATIC = 0.8, MU_DYNAMIC = 0.3, V0 = 0.1;
function friction(vRel) { // signed coefficient: peak at rest, falling with speed
  const s = Math.sign(vRel) || 1, a = Math.abs(vRel);
  return s * (MU_DYNAMIC + (MU_STATIC - MU_DYNAMIC) * V0 / (V0 + a));
}

export function bow(card, { pitchHz, force = 0.3, speed = 0.2, position = 0.12, seconds = 2, sampleRate = 96000 } = {}) {
  const modes = modesAt(card, pitchHz, { position: null, hardness: 1 }).filter((m) => m.amp > 0);
  const n = Math.round(seconds * sampleRate), out = new Float32Array(n);
  const state = modes.map((m, i) => {
    const w = 2 * Math.PI * m.freqHz / sampleRate, r = Math.exp(-1 / (m.tauSec * sampleRate));
    const shape = modeShape(card.family.kind === 'unknown' ? 'string' : card.family.kind, i, position) || 1e-3;
    return { a1: 2 * r * Math.cos(w), r2: r * r, g: m.amp * Math.sin(w) * shape, shape, y1: 0, y2: 0 };
  });
  const ramp = Math.round(0.05 * sampleRate);
  let vString = 0;
  for (let i = 0; i < n; i++) {
    const f = force * Math.min(1, i / ramp), vBow = speed * Math.min(1, i / ramp);
    const vRel = vBow - vString;
    const x = f * friction(vRel);                    // friction force at the bow point
    let y = 0, v = 0;
    for (const st of state) { const yi = st.a1 * st.y1 - st.r2 * st.y2 + st.g * x; v += (yi - st.y1) * st.shape; st.y2 = st.y1; st.y1 = yi; y += yi; }
    vString = Math.max(-2, Math.min(2, v * sampleRate / 2000)); // displacement difference → a velocity in bow units
    out[i] = y;
  }
  return out;
}

/** Force range in which a 1 s note at 16 kHz holds a steady level (±10 % over its second half). */
export function stableForceRange(card, { pitchHz = 220 } = {}) {
  const sr = 16000, forces = [0.05, 0.1, 0.2, 0.3, 0.45, 0.6, 0.8, 1.0];
  const ok = [];
  for (const f of forces) {
    const y = bow(card, { pitchHz, force: f, seconds: 1, sampleRate: sr });
    const rms = (a, b) => { let s = 0, c = 0; for (let i = Math.round(a * sr); i < Math.round(b * sr); i++) { s += y[i] * y[i]; c++; } return Math.sqrt(s / c); };
    const r1 = rms(0.5, 0.75), r2 = rms(0.75, 1.0);
    if (r1 > 0.005 && Math.abs(r1 - r2) / r1 < 0.1) ok.push(f);
  }
  return ok.length ? { min: Math.min(...ok), max: Math.max(...ok) } : { min: 0, max: 0 };
}
```

In `render.js`: `import { bow, stableForceRange } from './excite/bow.js';`, dispatch `else if (excitation === 'bow') raw = bow(card, { ...params, pitchHz, force: (params.force ?? 0.3) * dynamics, seconds, sampleRate: rate });`, and re-export `stableForceRange`.

- [ ] **Step 4: Run the tests**

Expected: `ok - found instruments: 17 cases`. If the sustain is not steady, adjust the velocity scaling `v * sampleRate / 2000` (it sets how strongly the bank's motion feeds the friction curve) in powers of two until the mid-range force holds ±10 %; record the value used in a comment.

- [ ] **Step 5: Commit**

```bash
git add js/instrument/excite/bow.js js/instrument/render.js test/run.mjs
git commit -m "Instrument excitations: bow (stick-slip friction on the bank) with a measured stable-force range

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: CLIs and the first cards from the shelf

**Files:**
- Create: `scripts/instrument-card.mjs`, `scripts/instrument-audition.mjs`
- Create: `docs/lab/cards/*.json` (from the shelf), `docs/lab/2026-09-05-found-instruments.md`

**Interfaces:**
- Consumes: `buildCard`, `renderVoice`, `readWav`, `writeWav24`, `resample`, `measureLoudness`.
- Produces: `node scripts/instrument-card.mjs in.wav out.json [--start s --end s | --auto] [--name --license]`; `node scripts/instrument-audition.mjs card.json out.wav [--excitations strike,pluck,breath,bow] [--octaves 2]`.

- [ ] **Step 1: Write the card CLI**

```js
#!/usr/bin/env node
// recording → instrument card. --auto picks the loudest transient with the
// longest ring (onset by energy jump, end where the envelope falls 40 dB or
// the next onset comes). Prints the card's family, modes and damping law.
import { readFileSync, writeFileSync } from 'node:fs';
import { readWav } from './lib/wav.mjs';
import { buildCard } from '../js/instrument/card.js';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const [inPath, outPath] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--auto'));
const { channels, sampleRate } = readWav(inPath);
const mono = new Float32Array(channels[0].length);
for (const ch of channels) for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / channels.length;
let start = Number(opt('--start', NaN)), end = Number(opt('--end', NaN));
if (args.includes('--auto') || !Number.isFinite(start)) {
  const hop = Math.round(0.005 * sampleRate), frames = Math.floor(mono.length / hop), e = new Float32Array(frames);
  for (let f = 0; f < frames; f++) { let s = 0; for (let i = 0; i < hop; i++) s += mono[f * hop + i] ** 2; e[f] = Math.log(1e-9 + s / hop); }
  let best = { score: -Infinity, f: 0 };
  for (let f = 4; f < frames - 40; f++) {
    const jump = e[f] - Math.max(e[f - 1], e[f - 2], e[f - 3]);
    if (jump < 3) continue; // ~13 dB in 5 ms
    let ring = 0; while (f + ring < frames && e[f + ring] > e[f] - 9.2) ring++; // to −40 dB
    const score = jump + Math.log(1 + ring);
    if (score > best.score) best = { score, f };
  }
  start = best.f * hop / sampleRate; end = Math.min(mono.length / sampleRate, start + 3);
  let f = best.f; while (f < frames && e[f] > e[best.f] - 9.2 && (f - best.f) * hop / sampleRate < 3) f++;
  end = Math.min(end, (f + 4) * hop / sampleRate);
}
const slice = mono.subarray(Math.round(start * sampleRate), Math.round(end * sampleRate));
const card = buildCard(slice, sampleRate, { name: opt('--name', inPath), license: opt('--license', ''), note: `from ${start.toFixed(3)}–${end.toFixed(3)} s.` });
writeFileSync(outPath, JSON.stringify(card, null, 1));
console.log(`${card.source.name}: ${card.family.kind} (${card.family.confidence.toFixed(2)}), ${card.modes.length} modes, damping ${card.damping.model} q0 ${card.damping.q0.toFixed(0)} exp ${card.damping.exponent.toFixed(2)}${card.nonlinearity ? ', nonlinear ×' + card.nonlinearity.length : ''}`);
console.log('  ' + card.modes.slice(0, 8).map((m) => `${m.freqHz.toFixed(1)} Hz τ${m.tauSec.toFixed(2)}`).join('  '));
```

- [ ] **Step 2: Write the audition CLI**

```js
#!/usr/bin/env node
// card → one WAV: for each excitation, a rising compass of eight notes over
// --octaves (default 2) from the card's own pitch, then a chord from the
// card's related scale. 48 kHz 24-bit, peak-normalised to −1 dBFS.
import { readFileSync } from 'node:fs';
import { writeWav24 } from './lib/wav.mjs';
import { renderVoice, TRUTH_RATE } from '../js/instrument/render.js';
import { cardPitchHz } from '../js/instrument/family.js';
import { relatedScale } from '../js/instrument/tuning.js';
import { resample } from '../js/dsp/resample.js';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const [cardPath, outPath] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const card = JSON.parse(readFileSync(cardPath, 'utf8'));
const excitations = opt('--excitations', 'strike,pluck,breath,bow').split(',');
const octaves = Number(opt('--octaves', 2)), f0 = cardPitchHz(card), gap = 0.15;
const parts = [];
let t = 0; const place = (buf, at) => parts.push({ buf, at });
for (const ex of excitations) {
  for (let k = 0; k < 8; k++) {
    const pitch = f0 * Math.pow(2, octaves * k / 7);
    const v = renderVoice({ card, pitchHz: pitch, excitation: ex, seconds: ex === 'strike' || ex === 'pluck' ? 1.5 : 1.2, dynamics: 0.9 });
    place(v.samples, t); t += (ex === 'strike' || ex === 'pluck' ? 0.6 : 1.3) + gap;
  }
  t += 0.8;
}
const scale = relatedScale(card.modes).slice(0, 3);
for (const s of [1, ...scale.map((x) => x.ratio)]) { const v = renderVoice({ card, pitchHz: f0 * s, excitation: excitations[0], seconds: 3 }); place(v.samples, t); }
t += 3.5;
const total = new Float32Array(Math.ceil(t * TRUTH_RATE));
for (const { buf, at } of parts) { const o = Math.round(at * TRUTH_RATE); for (let i = 0; i < buf.length && o + i < total.length; i++) total[o + i] += buf[i]; }
let peak = 0; for (const v of total) peak = Math.max(peak, Math.abs(v));
const norm = peak > 0 ? Math.pow(10, -1 / 20) / peak : 1; for (let i = 0; i < total.length; i++) total[i] *= norm;
const out = resample(total, TRUTH_RATE, 48000, { cutoffScale: 0.45 });
writeWav24(outPath, [out, out], 48000);
console.log(`wrote ${outPath}: ${(out.length / 48000).toFixed(1)} s, ${excitations.join('/')}, related scale ${scale.map((x) => x.cents.toFixed(0) + 'c').join(' ')}`);
```

- [ ] **Step 3: Make the first cards**

Fetch the shelf's struck material into the scratchpad (never the repo): the Sevilla bells MP3 and the 1921 record, decode with ffmpeg to 48 kHz WAV, run `scripts/instrument-card.mjs --auto` on each, and on hand-picked windows where `--auto` picks a voice or a crowd. Save the cards to `docs/lab/cards/<name>.json` with the licence line. Run the audition CLI on each and listen-check the metadata (peak, decay, centroid) in `docs/lab/2026-09-05-found-instruments.md` along with the family each card was classified as and whether that is plausible for the object.

- [ ] **Step 4: Verify**

Run: `node test/run.mjs 2>&1 | rg -c '^ok'` (all groups green) and `node scripts/instrument-audition.mjs docs/lab/cards/<first>.json /tmp/x.wav` writes a file with a printed related scale.

- [ ] **Step 5: Commit**

```bash
git add scripts/instrument-card.mjs scripts/instrument-audition.mjs docs/lab/cards docs/lab/2026-09-05-found-instruments.md
git commit -m "Instrument CLIs and the first cards from the shelf's struck material

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage.** §3 card (Tasks 1–2), §4 family (3), §5 excitations (4, 8, 9), §6 body (6), §7 tuning (5), §8 render (7), §9 tests: 1 → Task 1; 2 → Task 3; 3 → Task 3; 4 → Task 3; 5 → Task 9; 6 → Task 8; 7 → Task 5; 8 → Task 5; 9 → Task 7; 10 → covered by Task 4's linear bank test plus Task 7's path assertion. §10 files all present; §11 first material → Task 10. Measured `hits` surfaces (§4 last bullet) are read by `renderVoice`'s metadata but no interpolation is implemented — deferred to the recording session, noted in `card-format.md` as optional.

**Placeholders.** None; every step carries code or an exact command.

**Type consistency.** Mode objects use `freqHz/tauSec/amp/phase` throughout; `modesAt` adds `index` and `weight`; `renderVoice` returns `{ samples, sampleRate, meta, key }` and Tasks 8–9 assert on `meta.used.path`; `readWav` returns `{ channels, sampleRate }` and `writeWav24(path, channels, sampleRate)` in both CLIs and `master-take.mjs`.
