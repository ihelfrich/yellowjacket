# Yellowjacket — build contract, BRUSH slice (spectral repair)

Extends docs/CONTRACT.md conventions (binding). Read docs/VISION.md for register. This
slice ships: rectangle spectral selection on the SIGNAL spectrogram, RX-Attenuate-style
context-aware repair with feathered edges, TRANSIENT/TONE presets plus a harmonics
helper, preview-before-commit, and a non-destructive repair stack with per-entry bypass
— the structure no free competitor has (research: Notevibes/AudioMultiCut are
rectangle-mute with MP3 export; SpectroDraw is sound-design erasing). Deferred, by
design: freehand brush (a janky brush is worse than a good rectangle), Replace/Pattern
resynthesis modes, WebGPU rendering (separate slice; the repair UI rides the existing
Canvas2D spectrogram).

Honesty rule for all copy: this removes one-off blemishes (coughs, beeps, hum, squeaks)
from otherwise-clean audio. It does not remove noise underneath speech, and the UI
never implies it does.

## Data model (runtime; length-preserving edits so words/clips/beatmap stay valid)
```js
runtime.repairs = [ Repair ]        // ordered stack, applied top to bottom
Repair = { id, t0, t1, f0, f1,      // seconds and Hz against the ORIGINAL timeline
           strength: 0.05..1,       // 1 = magnitudes fully match surrounding context
           enabled: true, label }   // label e.g. 'R1 · 2.1s · 300-4k'
runtime.original = { buffer, mono } // captured on load; the stack's source of truth
// runtime.buffer / runtime.mono become the EDITED audio whenever any repair is
// enabled; with an empty/bypassed stack they are the original objects again.
```

## workers/repair-worker.js (mine; module worker importing ../js/fft.js)
```js
// in:  { type:'repair', channels: Float32Array[] (padded span, transfer), sampleRate,
//        padSec, regions: [{ t0, t1, f0, f1, strength }] }   // times relative to span start
// out: { type:'done', channels (transfer back) }
// out: { type:'error', message }
```
Algorithm (verified recipe, RX Attenuate class): STFT 4096 / hop 1024, Hann analysis
and synthesis, OLA normalized by the Hann-squared COLA sum. For each region: mask =
frames within [t0, t1] x bins within [f0, f1], feathered raised-cosine over 4 frames in
time and max(4 bins, 8% of the band) in frequency. Expected log-magnitude per masked
bin: distance-weighted linear interpolation between the mean log-magnitude of 16
context frames before the region and 16 after (fewer when clipped by the span edge;
one-sided when necessary). New magnitude = exp(lerp(logMag, expectedLogMag,
strength * feather)). PHASE IS UNCHANGED — attenuation reuses original phase, which is
why this mode needs no phase reconstruction. Resynthesize, then crossfade the span into
the surrounding audio over 10 ms at both ends. Regions apply in order within one call.
Deterministic, allocation-conscious, worker terminated by the controller after idle.

## js/app/repair-controller.js (mine)
Owns the stack and the rebuild: on any stack change, start from a fresh copy of
runtime.original PCM, apply enabled repairs in order via the worker (span = region
padded by 0.6 s for context + window), splice results, produce the edited buffer +
mono, then: engine.adoptBuffer(edited), waveform/slice views setBuffer with a rebuilt
pyramid, spectrogram recompute (async), status line ('REPAIR APPLIED · 3 ACTIVE').
Preview: process the selection's span only and audition it through the engine ctx as a
one-shot without touching the stack. Debounce rebuilds (strength drags). Registers
ctx.api.addRepair / previewRepair for the views.

## js/audio-engine.js (mine, one addition)
adoptBuffer(audioBuffer, mono): swap the playable buffer + mono WITHOUT decode,
preserving position/altBuffer semantics; used only for length-identical replacements.

## js/spectrogram.js (fleet agent A; extend in place, Canvas2D)
New: spectral region selection + repair overlays.
- Drag = select a time-frequency rectangle (crosshair cursor). The view already owns
  the log-frequency mapping; expose timeAtX/freqAtY and inverses as public methods.
- Emits 'regionselect' { t0, t1, f0, f1 } live during drag, null on click-clear.
- setRepairs(repairs, hoverId): draw each enabled repair as a hazard-tinted
  translucent region (--yj-cut style, amber border); hoverId gets a bright outline.
  Disabled repairs draw border-only, dim.
- Selection rectangle: --yj-select fill, yellow 1 px border, with a small readout chip
  at the corner ('1.24s · 310-2.4k Hz') in 9 px mono.
- Presets are VIEW gestures: plain drag = free rectangle; Alt+drag = TRANSIENT (snaps
  f0/f1 to full band, keeps the time span); Shift+drag = TONE (snaps the time span to
  the dragged extent but quantizes the band to the dragged frequencies exactly —
  i.e. a thin horizontal band). Document in the canvas-note line.
- Keep every existing behavior (playhead, seek on plain click without drag, zoom sync).
  Click-without-drag still seeks; a completed drag suppresses that seek.

## js/app/repair-panel.js (fleet agent B; DOM module, silkscreen register)
```js
export class RepairPanel extends EventTarget {
  // events: 'apply' {region, strength}, 'preview' {region, strength},
  //         'toggle' {id, enabled}, 'remove' {id}, 'hover' {id|null},
  //         'harmonics' {region, count}   (duplicate a TONE band at 2f..(count)f)
  constructor(host)
  setSelection(region|null)     // enables APPLY/PREVIEW; shows the readout
  setRepairs(repairs)           // stack list, newest on top
  setBusy(bool)                 // hazard-crawl on APPLY while the worker runs
}
```
Panel content: STRENGTH range 5..100% default 60; PREVIEW and APPLY buttons;
HARMONICS button (enabled only when the selection band is narrower than an octave;
select count x2..x6 beside it); the stack list — each entry a row with a square
bypass toggle (.is-on), the label, and a machined x to remove; hovering a row emits
'hover'. Empty state: 'Select a region on the spectrogram. Alt-drag grabs a transient,
Shift-drag grabs a tone.' All --yj vars, .yj-btn/.yj-well classes, scoped style block.

## Wiring (mine)
SIGNAL rail gains a REPAIR panel (host div in index.html). regionselect feeds
setSelection; apply -> controller.addRepair -> rebuild; harmonics adds count-1 extra
repairs with bands at k*f0..k*f1 clamped to Nyquist; RESTORE all = removing every
entry returns the literal original objects (verified by identity).

## Acceptance (mine; harness suite 'spectral repair' + browser)
- Synthetic: 440 Hz tone + injected 2-8 kHz chirp burst at 1.0-1.2 s. Repair that
  region strength 1: chirp band energy in-region drops >= 20 dB; tone bin outside the
  band changes < 0.15 dB; audio outside [t0-50ms, t1+50ms] is bit-identical; output
  length exactly equals input; two runs bit-identical.
- Strength 0.5 attenuates roughly half the dB distance (within 3 dB).
- Feather: no energy discontinuity > 6 dB between adjacent frames at region edges.
- Browser: select/preview/apply on the dirty speech fixture's hum band + harmonics
  helper; bypass toggles restore audibly and identity-restore on empty stack;
  transcript/clips survive a repair (length preserved); export carries the repair.
