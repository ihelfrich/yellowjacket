# Yellowjacket MACHINE — build contract, slice 2 (PATTERN)

Extends docs/CONTRACT.md and docs/CONTRACT-MACHINE.md (all conventions bind). Read
docs/VISION.md for intent. This slice ships: the 8-track step sequencer with live
playback and offline render from ONE shared event compiler, per-track sample assignment
from clips, a compact mixer, per-track length (polymeter), swing, a QWERTY keybed, and
FREEZE TO BENCH. No parameter locks, no step components, no scenes yet (LOCK slice), no
OPFS persistence yet (deliberately deferred; noted in VISION sequencing).

## One amendment to the ClipRef principle, with reason
VISION says patterns never duplicate PCM. FREEZE breaks pure references: printing the
machine's output as the new bench source invalidates every ClipRef into the old buffer.
So ASSIGNMENT COPIES: when a clip lands on a track, its samples are copied into the
track (exactly what a hardware sampler does when a sound hits a pad). Bounded: 30 s max
per track, 8 tracks, a few MB. Clips in SLICE stay references; tracks own samples.

## State (main.js owns, machine-ui renders)
```js
project.machine = {
  bpm: 120,              // defaults to round(analysis.tempo) when confidence >= 0.6
  swing: 50,             // 50..70, percent position of the off-16th inside its 8th
  tracks: [ 8 x {
    sample: null | { channels: Float32Array[], sampleRate: number, label: string },
    steps: Uint8Array(64),   // 0|1
    len: 16,                 // 4..64, steps before this track loops (polymeter)
    gainDb: 0,               // -24..+6
    pan: 0,                  // -1..1
    mute: false, solo: false,
  } ],
}
```

## New files

### js/machine/compile.js  (worker-safe, pure — Codex-owned)
```js
export function stepTime(step, bpm, swing): number
// seconds from pattern start to the given global step index. 16ths; swing shifts every
// odd step: pair of 16ths spans an 8th E = 2*stepDur; odd step sits at E*swing/100.
export function patternLoopSteps(tracks): number
// LCM of active tracks' len (tracks with a sample and any step on), capped at 256;
// 16 when nothing is active.
export function compileWindow(machine, fromSec, toSec): Event[]
// Event = { tSec, track, gain, pan }   (gain linear, mute/solo resolved)
// Pattern time is cyclic: global step g fires track k iff track.steps[g % track.len].
// Deterministic, allocation-light, safe to call every tick with a moving window.
// Events with tSec in [fromSec, toSec). fromSec/toSec in PATTERN-TIMELINE seconds.
export function compileRender(machine, loops): { events: Event[], loopSec, totalSec }
// loops full pattern cycles (loopSec = patternLoopSteps * stepDur with swing folded in
// only at event level; loop boundary is unswung).
```

### js/machine/sequencer.js  (main-thread — Codex-owned)
```js
export class Sequencer extends EventTarget {
  // events: 'step' {step, loopStep}   (fires per 16th, from the tick loop, for LED chase)
  //         'state' {running}
  constructor(engine)               // uses engine.ctx and engine.master (see notes)
  setMachine(machine)               // live reference; compiler reads it fresh each tick
  trackBuffer(i): AudioBuffer|null  // lazy AudioBuffer from tracks[i].sample, cached,
                                    // invalidated by bumpTrack(i)
  bumpTrack(i)                      // call after a sample assign
  start()                           // begins at step 0; 25 ms setInterval tick (NOT rAF:
                                    // hidden tabs stall rAF), 200 ms lookahead window,
                                    // schedules AudioBufferSourceNode.start(when) through
                                    // per-track GainNode -> StereoPannerNode -> engine.master
  stop()                            // cancels all scheduled-but-unplayed sources cleanly
  trigger(i, when = 0)              // fire track i once now (keybed), through its strip
  get running()
  async renderWav(loops): Blob      // OfflineAudioContext render of compileRender events
                                    // at the max track sampleRate (>= 44100), stereo,
                                    // through identical gain/pan strips, then encodeWav
                                    // (import from ../export.js) at 16-bit
}
```
Timing discipline: the tick loop derives everything from ctx.currentTime against a
t0 anchor set in start(); setInterval only wakes the compiler, it never keeps time.
Mid-play edits are picked up at the next uncompiled window (compiler reads live state).
Track strips are created once and reused; gain/pan changes apply via AudioParam ramps
(~15 ms) so mixer moves do not zipper. Solo logic: any solo on => non-solo tracks
silent. Swing, polymeter, mute/solo all live in compile.js so the offline render can
not diverge from live playback by construction.

### js/machine/pattern-ui.js  (fleet)
```js
export class PatternView extends EventTarget {
  // events: 'togglestep' {track, step}, 'assign' {track}, 'cleartrack' {track},
  //         'mix' {track, key, value}   (key: gainDb|pan|mute|solo|len),
  //         'bpm' {bpm}, 'swing' {swing}, 'run' {}, 'stopreq' {}, 'freeze' {loops},
  //         'trig' {track}
  constructor(host: HTMLElement)    // builds all DOM inside host once
  setMachine(machine)               // full re-render of grid + strips from state
  setPlayhead(step|null)            // LED-chase column highlight, cheap (class swap)
  setPage(p) / get page             // 4 pages x 16 steps; page buttons A B C D
  setClipHint(label|null)           // shows which clip ASSIGN would place
  setRunning(bool)
}
```
DOM grid, not canvas: 8 rows x 16 step buttons per page (class yj-step, .is-on,
.is-now, .is-off-page beyond track len), square, machined, yellow LED fill when on.
Row head: track number key hint (1-8), sample label (or 'EMPTY'), tiny TRIG button.
Row tail mixer strip: gain slider (-24..+6 dB), pan slider, M and S square toggles,
LEN select (4/8/12/16/24/32/48/64). Transport bar above the grid: RUN/STOP button
(chevron-crawl while running), BPM well (click-edit like slice-ui's), SWING param
50-70, page buttons, FREEZE button + loops select (1/2/4), ASSIGN hint well. All caps
silkscreen labels, --yj vars only, no new colors. Steps every 4th column get a
slightly brighter idle border (beat marks).

### js/machine/keybed.js  (fleet)
```js
export class Keybed {
  constructor()
  attach(onTrig: (trackIdx) => void)   // keys 1..8 = tracks 0..7, keydown only,
                                       // ignores repeats, inputs/selects/textareas,
                                       // and any modifier chords
  detach()
  get enabled() / set enabled(b)       // main.js enables only while MACHINE tab active
}
```

### index.html / css / main.js (integrator-owned)
MACHINE pane gets a state switcher under the tab bar (silkscreen sub-tabs SLICE |
PATTERN, class yj-substate), SLICE panel as-is, PATTERN panel host div. main.js:
machine state init + bpm default from analysis; SLICE 'clipselect' feeds
setClipHint and ASSIGN copies the selected clip's span from project.buffer into the
track (respecting the 30 s cap, trimming with a status note if over); FREEZE calls
sequencer.renderWav(loops) then loadArrayBuffer(await blob.arrayBuffer(),
'machine.freeze.wav') — the commit-to-tape move; machine keeps its samples and
pattern, so the flip loop continues. Keybed enabled on MACHINE tab only. Bench
transport and machine transport are separate; starting one stops the other
(status line says which owns the output).

## Acceptance (integrator)
- compile.js unit run (node): 120 BPM straight: step k at k*0.125 s exactly; swing 66:
  odd 16ths at 2/3 of their 8th; polymeter 12-vs-16 loops at LCM 48; mute/solo resolve.
- Live: program four-on-the-floor from a bar clip, run 60 s, 'step' cadence steady
  (audible check + no console errors); toggle steps mid-play, changes land next window;
  keys 1-8 fire; mixer moves are click-free.
- renderWav(2) of a 1-bar pattern at 120 = 4.0 s WAV +- 1 ms, decodes on the bench via
  FREEZE, loudness plausible, and the render is sample-identical on a second run.
