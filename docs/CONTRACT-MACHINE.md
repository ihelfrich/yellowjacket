# Yellowjacket MACHINE — build contract, slice 1 (BEATMAP)

Extends docs/CONTRACT.md (v1 conventions all still bind: ES modules, no frameworks, no
SAB, worker rules, CSS-var colors, DPR-aware canvases, no console.log). Read docs/VISION.md
for intent. This slice ships: source analysis (onsets, tempo, beats, editable anchors),
the ClipRef model, the MACHINE tab with its SLICE state, clip audition, words-to-clips,
and loop export. No sequencer yet.

## State extensions (main.js owns)
```js
project.analysis = null | {
  onsets: Float32Array,      // onset times, seconds, ascending
  envelope: Float32Array,    // onset-strength envelope, hopSize 512 @ analysis rate
  envelopeRate: number,      // frames per second of envelope
  tempo: number,             // BPM
  beats: Float32Array,       // beat times, seconds
  downbeat: number,          // index into beats of estimated bar 1 (0 if unknown)
  beatsPerBar: 4,            // fixed this slice
  confidence: number,        // 0..1
  anchors: { bpm: number|null, barOneTime: number|null }  // user pins, null = auto
}
project.clips = ClipRef[]
ClipRef = { id: string, start: number, end: number, gain: 1, tag: 'word'|'beat'|'transient'|'manual', label: string }
// times in ORIGINAL source seconds. Immutable spans: edits create new ClipRefs.
```

## New files

### js/analysis/onsets.js (worker-safe, pure; Codex-owned)
```js
export function onsetAnalysis(mono: Float32Array, sampleRate): {
  envelope: Float32Array, envelopeRate: number, onsets: Float32Array }
```
Spectral flux: STFT 1024/hop 512 Hann (import fft.js), half-wave-rectified positive flux
per frame, log-magnitude compression (log(1+10*|X|)), envelope smoothed with a 3-frame
[0.25 0.5 0.25] kernel (NOT a median: a median erases the single-frame spikes sharp
transients produce) then mean-removed via 8-frame moving average (keep only positive
residual). Peak
pick: local max over +-3 frames AND above adaptive threshold (mean of surrounding 16
frames + 0.3 * their std), 30 ms minimum inter-onset gap.

### js/analysis/beattrack.js (worker-safe, pure; Codex-owned)
```js
export function trackBeats(envelope, envelopeRate, opts = { bpm: null, barOneTime: null }): {
  tempo, beats: Float32Array, downbeat, confidence }
```
Tempo: autocorrelation of the envelope over 60-200 BPM lags, comb-weighted (sum lag,
2*lag, 4*lag at 1/0.5/0.25 weights), log-Gaussian prior centered 120 BPM (sigma 0.9
octaves) unless opts.bpm pins it (then use opts.bpm exactly). Beats: Ellis-2007 dynamic
programming (score = envelope value + alpha * transition score, alpha 680, transition =
-(log(interval/period))^2 penalty), backtrace from best terminal. If opts.barOneTime set,
phase-rotate beats so one lands within 40 ms of it and mark it downbeat. Else downbeat =
beat index maximizing mean envelope at 4-beat spacing over the first 16 bars. Confidence:
ratio of chosen-period comb energy to median comb energy, squashed to 0..1 via x/(1+x).
Both functions deterministic, no allocation in inner loops where avoidable, brief
comments citing the method (Ellis 2007) at the formula sites.

### workers/analysis-worker.js (module worker; fleet)
```js
// in:  { type:'analyze', mono (transfer), sampleRate, anchors: {bpm, barOneTime} }
// out: { type:'progress', pct }
// out: { type:'done', analysis }   // full project.analysis shape minus anchors
```
Imports onsets.js + beattrack.js. Re-runs cheaply on anchor change (envelope cached in
worker between calls for same source generation id; include generation in messages).

### js/machine/cliprefs.js (fleet)
```js
export function makeClip(start, end, tag, label): ClipRef        // id = 'c' + counter
export function wordsToClip(words, i0, i1): ClipRef              // start/end from word spans, label = joined text (<= 24 chars + ellipsis), tag 'word'
export function snapToBeat(t, beats, toleranceSec = 0.08): number
export function clipsOverlap(a, b): bool
export class ClipAuditioner {                                     // owns ONE AudioContext-independent play path
  constructor(engine)                                             // reuses engine.ctx/master
  play(clip, { rate = 1 } = {})                                   // one-shot, 3 ms fade in/out to avoid clicks
  stop()
}
```

### js/machine/slice-ui.js (fleet)
```js
export class SliceView extends EventTarget {
  // events: 'clipadd' {clip}, 'clipdelete' {id}, 'audition' {clip}, 'anchorchange' {bpm, barOneTime}
  constructor(canvas, controlsHost)
  setSource(mono, sampleRate, pyramid?) // draws waveform strip (peaks via render/peaks.js, shared pyramid optional; do NOT import WaveformView)
  setAnalysis(analysis)               // beat grid: thin --yj-line verticals per beat, heavier --yj-amber-dim per bar, downbeat tick labels B1 B2..; onset ticks as 3px marks along the bottom; confidence + BPM readout well
  setWords(words|null)                // word boundary ticks along the top, dim
  setClips(clips)                     // clip spans as translucent --yj-select blocks with square handles, label in 9px mono
  render()
}
```
Interactions: drag on empty = carve a clip (snap both edges to beats when within 80 ms,
hold Alt to disable snap); click a clip = audition (emit both events); Backspace on
selected clip = delete; double-click a beat line = set bar one anchor there; BPM well is
click-editable (type a number, Enter commits, emits anchorchange). Zoom/pan: wheel and
shift+wheel, same feel as waveform.js.

Controls rendered into controlsHost (buttons use existing .yj-btn classes):
ANALYZE (re-run), TAP TEMPO (spacebar-friendly button: >= 4 taps sets anchor bpm from
median inter-tap), CLEAR ANCHORS, CUT AT BEATS (turn every bar of the current view
selection into beat-tagged clips), EXPORT LOOP (selected clip -> WAV via export.js
encodeWav on a copied span, filename <source>.<label>.wav).

### index.html / css/yj.css / js/main.js (integrator-owned, not fleet)
MACHINE tab button after RACK; tab pane holds SLICE state only this slice: full-width
SliceView canvas panel (data-label "MACHINE / SLICE") + right rail (data-label "BEATMAP")
with BPM well, confidence LED (green >= 0.6, yellow >= 0.3, red below), anchor controls,
clip count well, EXPORT LOOP. TRANSCRIPT rail gains one button: LIFT TO MACHINE (enabled
when a word range is selected; calls wordsToClip, switches to MACHINE, flashes the new
clip). Analysis kicks off automatically on file load AFTER the spectrogram completes
(sequential, not parallel: both are CPU-heavy).

## Acceptance (integrator runs before commit)
- 120 BPM click track (generate in test): tempo within 0.5 BPM, beats within 15 ms mean absolute error, confidence > 0.7.
- The dirty speech fixture: analysis completes < 10 s for 25 s audio in a hidden tab (MessageChannel yields, no rAF dependence), confidence low, and the UI says so instead of pretending.
- Carve, snap, audition, delete, undo-less delete confirm (no undo this slice), export loop round-trips through decodeAudioData.
- Word range -> LIFT TO MACHINE -> clip appears with correct span and label; audition plays exactly the words.
