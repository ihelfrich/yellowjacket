# CONTRACT-CONFORM — role-aware time stretching and the space rack

Binding for the CONFORM slice. Two halves: CONFORM (a slice can be told how
many steps it occupies and it stretches to fit the scene tempo, keeping its
pitch) and SPACE (a send rack so a rework sounds finished rather than dry).

The design idea worth stating plainly: HARVEST already classified every slice
by role, so the stretcher does not have to guess what kind of sound it is
holding. Percussive roles keep their transients through overlap-add on
waveform similarity; tonal roles keep their pitch through a phase vocoder.
One switch, driven by information the bench already has.

## 1. js/dsp/stretch.js (pure, node-testable, no DOM, no Web Audio)

```
export const STRETCH_MODES = ['auto', 'percussive', 'tonal', 'resample'];
export function stretchMode(role)      // role -> 'percussive' | 'tonal'
export function stretchSamples(samples, ratio, sampleRate, opts) -> Float32Array
  // ratio = outputLength / inputLength. 0.25 .. 4 supported.
  // opts: {mode: 'auto'|'percussive'|'tonal'|'resample', role: 'KICK'|...}
  // 'auto' picks via stretchMode(opts.role); unknown role -> 'tonal'.
  // 'resample' is the honest escape hatch: plain rate change, pitch moves.
```

PERCUSSIVE (WSOLA). Frame 40 ms, hop-analysis derived from ratio, search
window +/- 10 ms, Hann cross-fade on overlap, next frame chosen by maximum
normalized cross-correlation against the tail already written. Transients
survive because frames are copied whole and only their alignment moves.

TONAL (phase vocoder with identity phase locking). FFT 2048, hop 512 in
(overlap 4), synthesis hop = round(512 * ratio). Per bin: phase advance
unwrapped against the expected advance, accumulated on the synthesis side.
Identity phase locking (Laroche and Dolson 1999): find spectral peaks, and
for every bin in a peak's region of influence, set its synthesis phase from
the peak's phase rotation rather than integrating independently. That is
what stops the classic phase-vocaded chorus smear on held notes.

Both paths: exact output length = round(input * ratio) (pad or trim the last
partial frame), silence in gives silence out, ratio 1 returns a copy that is
sample-identical to the input (assert this: it is what makes CONFORM safe to
leave on).

Node tests (scratch, then promoted): ratio 1 identity on both paths; length
correctness at ratios 0.5, 0.75, 1.5, 2, 3; a 440 Hz sine stretched 2x still
reads 440 Hz through Goertzel within 1 Hz on the tonal path (pitch preserved);
a click train at 8 Hz stretched 2x still has 8 clicks with peaks at the
expected positions within 5 ms on the percussive path (transients preserved
and correctly spaced); stretching noise does not blow up amplitude (peak
within 1.5x of input peak); ratio clamping outside 0.25..4.

## 2. Voice gains a fit

```
voice.fitSteps: 0     // 0 = OFF (play at natural speed, today's behaviour)
                      // 1..64 = this slice occupies N sixteenth steps
```

Compiler: when fitSteps > 0, target seconds = fitSteps * stepDur (scene bpm,
NOT swung: swing moves onsets, never durations). The event carries
`fitSec` and the sequencer bakes a stretched buffer for it. Pitch locks
still apply on top as playbackRate, so a fitted slice pitched +7 plays
faster than its fit; that is the musically expected behaviour and is
documented in the UI copy.

Neutrality rule, same as every slice before it: fitSteps 0 emits no fitSec
and changes no event field. The pattern golden fixture and every LOCK case
must pass untouched.

## 3. Sequencer baking

Stretch is offline work, so buffers are baked and cached, never computed per
voice. Cache key: (sample identity, reverse, fitSec rounded to 1e-4). The
existing per-track cache grows a `fitted` map. Baking happens lazily on the
first event that needs it and is synchronous (a 2 s slice at 44.1 kHz costs
single-digit milliseconds); if a bake throws, fall back to the unstretched
buffer rather than dropping the voice.

Offline render must produce the identical bake, so the bake function is
shared and deterministic.

## 4. js/dsp/space.js (pure, node-testable)

```
export function plateImpulse(sampleRate, seconds, decay, predelayMs) -> {left, right}
  // decaying noise plate: exponential decay, early diffusion, stereo
  // decorrelated by independent seeded noise, normalized to unity RMS
export function delayTimeFor(bpm, division)  // '1/4','1/8','1/8.','1/8t','1/16'
```

Impulses are generated, never fetched: no binary assets in the repo, and the
reverb is deterministic. Seeded PRNG (mulberry32), so two runs are identical.

Send rack wiring (integrator): two buses off the machine master, REVERB
(ConvolverNode fed by plateImpulse) and DELAY (DelayNode + feedback gain +
one-pole damping), each with a return gain. Per track: `sendVerb` and
`sendDelay` in 0..1 on the track (not the voice: it is a mix control, and
it belongs with gain and pan). Sends tap the voice AFTER its colour chain
so a filtered voice sends what you hear.

Persist: fitSteps with the voice, sendVerb/sendDelay with the track, plus
`machine.space {verbSec, verbDecay, verbMix, delayDivision, delayFeedback,
delayMix}` merged tolerantly like song and wire. formatVersion stays 2.

## 4b. The master stage, and what it costs

Offline renders pass through the TRUTH 1 true-peak limiter at -0.3 dBTP. The
live graph has no such stage, so this is a real and deliberate exception to
the live-equals-offline guarantee: when a mix would exceed the ceiling, the
WAV is gain-reduced and the live output is not. An adversarial review flagged
this as a determinism break, and it is one. The alternative is exporting
clipped audio from a bench that measures true peak to 0.1 dB, which is worse.
The guarantee to state accurately is: the same compiled event stream produces
the same audio up to the master stage. Do not claim bit-identity for renders.

## 5. Acceptance

Node: the stretch tests above; delayTimeFor at 120 bpm gives 0.5 for '1/4'
and 0.25 for '1/8' and 0.75 for '1/8.'; plateImpulse is deterministic,
finite, and decays monotonically in RMS across thirds; neutrality (fitSteps
0 and zero sends change no compiled event); persist roundtrip covers the new
fields.

Browser: a 2 s harvested loop assigned to a track with fitSteps 16 locks to
the bar at 100 bpm and at 140 bpm without changing pitch; sends audibly
place a dry slice in a room; a rendered song with fits and sends completes
and its duration still equals totalSec. Existing 63 harness cases stay green.
