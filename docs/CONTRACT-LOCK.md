# Yellowjacket MACHINE — build contract, slice 3 (LOCK)

Extends docs/CONTRACT.md, CONTRACT-MACHINE.md, CONTRACT-PATTERN.md (all binding). Read
docs/VISION.md and docs/research/codex-dsp-audit.md proposal 1 for intent. This slice
ships: per-step data (locks, components, conditions), the expressive sampler voice
(velocity, pitch, reverse, gate, ratchet, nudge, choke), compiled sidechain duck,
scenes, FILL, and the step inspector. The one law: compileWindow and compileRender stay
the only event producers, and every random choice is seeded, so live playback and
FREEZE stay identical by construction.

## Data model (extends the STRUCTURE scene model; store owns it)
```js
track.stepData[step] = {            // sparse: absent step = plain trigger
  velocity: 0.05..1,                // default 1; multiplies event gain
  pitch: -12..12,                   // semitones; rate = 2^(pitch/12)
  gainDb: -24..6 | undefined,       // LOCK: overrides track gain for this hit
  pan: -1..1 | undefined,           // LOCK: overrides track pan for this hit
  ratchet: 1..4,                    // sub-hits evenly inside the step
  nudge: -0.5..0.5,                 // fraction of a step, shifts hit time
  gate: 0.05..4 | 0,                // 0 = natural length; else fraction of a step
  reverse: true | undefined,
  prob: 1..100,                     // default 100
  cond: null | { a: 1..8, b: 2..8 } | 'fill' | 'notfill',
}
track.duckSource = -1 | 0..7        // -1 off; else source track index
track.duckDb = 0..24                // duck depth, default 12
track.choke = false                 // true = mono track: new hit kills the last
```

## compile.js (mine)
```js
Event = { tSec, track, gain, pan, rate, reverse, durSec|null, ratchetIndex }
DuckSeg = { tSec, track, depthDb }        // target track; shape constants live in sequencer
compileWindow(machine, fromSec, toSec, opts = { fill: false }) -> { events, ducks }
compileRender(machine, loops, opts) -> { events, ducks, loopSec, totalSec }
```
Semantics: per-track cycle = floor(globalStep / track.len). cond {a,b} fires when
cycle % b === a - 1 (Elektron A:B). prob uses mulberry32 seeded by
hash(scene.seed, cycle, track, step) — identical across live/offline by construction.
Ratchet k of N lands at t + k*stepDur/N, each sub-hit gets the same locks (own PRNG
draw per sub-hit for prob? NO: one draw per step; ratchets are all-or-nothing).
Nudge shifts the whole step (ratchets ride along). Duck: every event on a source
track emits DuckSegs to each track that ducks from it. Mute/solo resolve before
emission, as today. Swing applies before nudge.

## sequencer.js (mine)
Voice path per event: AudioBufferSourceNode (forward or cached-reversed buffer,
playbackRate = rate) -> voice GainNode (3 ms attack; if durSec, hold then 8 ms
release and src.stop) -> track strip (duckGain -> gain -> pan -> master).
Choke: track.choke schedules a 3 ms fade-and-stop of the previous voice at each new
hit. Duck automation on duckGain: at each DuckSeg tSec, ramp to 10^(-depthDb/20) in
5 ms, hold 60 ms, ramp back over 180 ms; overlapping segs take the deeper value
(cancelScheduledValues discipline documented in code). setMachine/trackBuffer/bumpTrack
unchanged; new: fill (bool property, read each compile tick), sceneChanged() (rebuilds
strips from the active scene without stopping transport). renderWav identical through
the same compiler + strip topology.

## keybed.js (mine, small)
KeyF = momentary FILL: onFill(true) on keydown (no repeat), onFill(false) on keyup.
attach(onTrig, onFill). Same gating rules as digits.

## pattern-ui.js (fleet agent)
New surfaces, all silkscreen-register, no new colors:
1. STEP INSPECTOR: hold a step button 260 ms (pointer stays down, moves < 6 px) to
   open, without toggling the step; quick click still toggles. The inspector is a
   panel pinned directly under the grid showing the held step's address (T3 · S07)
   and controls: VEL (5..100%), PITCH (-12..+12 st), GAIN lock (-24..+6 dB or OFF),
   PAN lock (L..R or OFF), RATCHET (x1..x4), NUDGE (-50..+50%), GATE (OFF/5..400%),
   REVERSE (square toggle), PROB (1..100%), COND (select: ALWAYS, 1:2, 2:2, 1:4, 2:4,
   3:4, 4:4, 1:8, FILL, NOT FILL), CLEAR STEP (drops all step data). OFF states for
   gain/pan locks mean "no lock" (undefined), distinct from a 0 value. Editing a
   control emits 'stepedit' { track, step, patch } with ONLY the changed key; CLEAR
   emits 'clearstep' { track, step }. Inspector closes on Escape, on opening another
   step, or on clicking outside the grid. It never mutates machine state itself.
2. LOCK MARKS: any step with stepData gets a 3 px amber corner tick (--yj-amber);
   a step whose prob < 100 or cond != null renders its fill at 60% opacity.
3. SCENES: a row of 8 square scene buttons (1-8) left of the transport controls;
   active scene = yellow fill; click emits 'scene' { index }; Alt+click emits
   'scenecopy' { from: activeIndex, to: index } (copy current pattern there, then
   switch). Non-empty scenes (any steps on) show a small amber dot.
4. FILL: a momentary FILL button in the transport bar (pressed state while held,
   pointer or Space/Enter); emits 'fill' { on } on press/release. Show key hint F.
5. MIXER STRIP additions per row: DUCK select (OFF, T1..T8, self excluded) emitting
   'mix' { track, key: 'duckSource', value: -1|0..7 }; when a source is set show a
   small DEPTH range 0..24 dB ('mix' key 'duckDb'); CHOKE square toggle ('mix' key
   'choke'). Keep rows compact; these fold into the existing strip block.
6. setMachine continues to re-render everything from state, including inspector
   values if its step still exists (else close it). setPlayhead/paging unchanged.
Report exact event payloads you emit and any deviations.

## controller (mine)
stepedit merges patch into stepData (deleting keys set to undefined/null per control
semantics, dropping the step entry when it becomes default-empty); scene switch keeps
transport running (sequencer.sceneChanged()), carries sample refs into the target
scene for tracks that have none (samples are machine-sticky; a later slice may add
per-scene kits); scenecopy deep-copies pattern data, never PCM. FILL from button and
keybed both set sequencer.fill.

## Acceptance (mine, harness suite 'LOCK compiler')
- Determinism: two compileRender runs identical including prob < 100 steps.
- prob 0/100 behave absolutely; ~50% over 400 seeded cycles lands in [35%, 65%].
- cond 3:4 fires exactly on cycles 2, 6, 10...; FILL/NOT FILL respect opts.fill.
- ratchet x3 = three events at exact thirds; nudge +25% shifts by stepDur/4;
  swing + nudge compose; gate 50% sets durSec = stepDur/2; pitch -12 halves rate.
- Duck: source hit emits segs to all subscribed targets, never to itself.
- Live/offline parity: stitched compileWindow across a loop equals compileRender
  event-for-event (same seed path).
- Browser: inspector edit -> audible change; scenes switch mid-play without stopping;
  FILL flips 'fill'-conditioned steps live; choke kills overlap; duck pumps.
