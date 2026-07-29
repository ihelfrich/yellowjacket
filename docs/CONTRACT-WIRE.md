# CONTRACT-WIRE — hardware I/O: OP-1/OP-Z drum patch export + Web MIDI performance layer

Binding for the WIRE slice. Two independent deliverables that share a story:
anything the bench slices becomes (a) a drum patch file the OP-Z eats natively
and (b) a live instrument played from hardware pads over USB MIDI. Everything
in section 1 and 2 was verified against primary sources on 2026-07-29 (factory
patch hex dump, teoperator/libop1/operator1 source, TE guides, Chromium
source); do not re-derive these facts, and do not soften them.

Scope exclusions, settled: no BLE MIDI (USB Web MIDI is strictly better; OS
pairing surfaces BLE as a normal port anyway). No sysex in the permission
request (nothing here needs it; Chrome gates the whole API behind a prompt
since 124 — request from a user gesture only). EP-133 sysex push is a LATER
slice, gated on hardware testing. No iOS path exists (WebKit has no Web MIDI);
feature-detect and show honest copy.

Branding, non-negotiable: body copy may say "works with the teenage
engineering OP-Z"; TE marks never appear in tool names, headings, or logos;
the README and the page footer carry "not affiliated with teenage
engineering." Every credible third-party tool does this (teoperator: "this is
not a teenage engineering product").

## 1. The OP-1 drum patch format (verified byte-exact)

Target layout (layout B, proven on OP-1 and OP-Z by teoperator, libop1, and
OP-Z-Simple-Tool): big-endian classic AIFF.

```
FORM <u32be totalSize-8> AIFF
  COMM <u32be 18>  numChannels s16be = 1
                   numSampleFrames u32be
                   sampleSize s16be = 16
                   sampleRate 80-bit IEEE extended = 44100.0
                     bytes: 40 0E AC 44 00 00 00 00 00 00
  APPL <u32be size> 'op-1' + compactJSON + 0x0A [+ padding to even]
                   (size counts the 4-byte signature + json + padding)
  SSND <u32be 8 + 2*frames> offset u32be = 0, blockSize u32be = 0,
                   s16be mono PCM
```

APPL JSON: compact (no spaces), keys in alphabetical order, ALL keys present,
all per-slice arrays exactly 24 long:

```json
{"drum_version":1,"dyna_env":[0,8192,0,8192,0,0,0,0],"end":[...24],
"fx_active":false,"fx_params":[8000,8000,8000,8000,8000,8000,8000,8000],
"fx_type":"delay","lfo_active":false,
"lfo_params":[16000,16000,16000,16000,0,0,0,0],"lfo_type":"tremolo",
"name":"<stem>","octave":0,"pitch":[0 x24],"playmode":[8192 x24],
"reverse":[8192 x24],"start":[...24],"type":"drum","volume":[8192 x24]}
```

8192 = one-shot playmode, forward, unity volume. The OP-Z reads only
start/end/pitch from drum patches; the rest must be present and valid but is
cosmetic there. drum_version 1 is what factory files and every working writer
emit.

Fixed point, THE rule (proved against factory file 1-drum.aif, every
position reproduced exactly): position = floor(sampleIndex * 2147483646 /
529200). 529200 = 12 s at 44100. The community "4058 per sample" constant is
an approximation of the same ratio; use the exact formula (float64 integer
math is safe: max product ~1.1e15 < 2^53). end[] uses the slice's last frame
index; the next slice's start uses its first frame index. Unused slots
duplicate the last real slice's start/end. Clamp all positions to
0..2147483646. Golden check: frame 463363 -> 1880318338.

Constraints: 44100 Hz mono s16 only, at most 529200 frames total (files
SHORTER than 12 s are fine, no padding), exactly 24 slots, extension .aif.
OP-Z ingestion: content mode (hold track + power), drop one .aif per slot
folder under samplepacks/1-kick .. 4-fx (tracks 5-8 want the 6 s SYNTH
format, out of scope), 24 MB device total, import happens on eject.

## 2. Web MIDI facts the implementation leans on (verified)

- Chrome 124+ gates ALL of Web MIDI behind a permission prompt: call
  navigator.requestMIDIAccess() (NO sysex flag) from an explicit click.
- MIDIOutput.send(data, timestamp) honors future DOMHighResTimeStamps: on
  macOS Chromium hands them to CoreMIDI for driver-level scheduling; on
  Windows/Linux a dedicated task runner fires them off-main-thread. A blocked
  main thread cannot jitter ticks already scheduled.
- Audio-to-MIDI clock domain conversion, per scheduler pass:
  `const {contextTime, performanceTime} = ctx.getOutputTimestamp();
   midiTs = performanceTime + (tAudio - contextTime) * 1000;`
  Re-sample the pair every pass; never cache it.
- Incoming event.timeStamp on macOS is the CoreMIDI receive timestamp, so
  inter-tick intervals are jitter-clean even when the main thread is busy.
  Always do clock math on event.timeStamp, never on handler-entry time.
- Transport bytes: 0xFA start, 0xF8 tick (24 per quarter), 0xFC stop. Sending
  a clock stream to an OP-Z automatically puts it into external sync mode.
- OP-Z: one MIDI channel per track (1-16, remappable), "channel one to
  active" redirects ch-1 input to the selected device track. Its drum-track
  note base is UNDOCUMENTED: ship a LEARN capture, never hardcode a guess.
- OP-Z quirk: pressing stop emits a burst of notes ("kill" messages).
  Suppress note input for 50 ms after an incoming 0xFC.
- Incoming clock jitter from software masters reaches multiple ms (E-RM
  measurements); hardware masters are cleaner. Slave mode is
  display-and-adopt: estimate, show, snap tempo on user action. Never chase
  per-tick.

## 3. Modules

### js/export/op1patch.js (pure, node-testable, no DOM)

```
export const PATCH_RATE = 44100;
export const PATCH_MAX_FRAMES = 529200;
export const PATCH_SLOTS = 24;
export function positionOf(frameIndex)          // the fixed-point rule, clamped
export function buildDrumPatch({segments, name})
  // segments: [{samples: Float32Array}] mono 44.1k, 1..24 entries
  // If total frames > PATCH_MAX_FRAMES, scale EVERY segment length by
  // budget/total (keeps musical proportions), floor, and report it.
  // Apply a 2 ms raised-cosine fade-in and fade-out inside each segment
  // (first/last ~88 frames) so adjacent slices never click on hardware.
  // Float -> s16 with round-half-away, clamp [-32768, 32767].
  // name: sanitized to ASCII, <= 24 chars in the JSON only.
  // -> {bytes: ArrayBuffer, report: {frames, seconds, slices, scaled}}
export function parseDrumPatch(bytes)
  // Reads layout A or B (AIFF or AIFC/sowt), returns {json, frames,
  // sampleRate, bitDepth, channels}. Used by tests; later an import path.
```

Byte-exactness is the whole point: FORM size, COMM fields including the
80-bit extended bytes, APPL even-length rule with the size counting the
signature, SSND offsets. A patch built from one full-length segment must
yield end[0] equal to positionOf(frames-1), and building then parsing must
round-trip every JSON field.

### js/midi/wire.js — MidiWire (EventTarget, no DOM)

```
requestAccess()        // from gesture; resolves {ins, outs} or throws
ports()                // current [{id, name, dir}]
setInput(id|null)      // persist choice by port.id; rebind on statechange
setOutput(id|null)
events: 'noteon' {note, velocity, channel, timeStamp}
        'noteoff', 'cc' {num, value, channel, timeStamp}
        'clocktick' {timeStamp}, 'transport' {type: start|stop|continue}
        'portschange'
send(bytes, midiTs)    // thin passthrough to the selected output
```

Channel filter: default ALL. The 50 ms post-0xFC note suppression lives here.
No Web MIDI object leaks past this module.

### js/midi/clock.js

ClockOut: lookahead 25 ms interval, 80 ms horizon (short on purpose: tempo
changes reach the wire within a pass; scheduled bytes cannot be recalled).
Tick period 60/(bpm*24) s, accumulated in float from the previous tick, never
recomputed from bar arithmetic. Follows the sequencer: 0xFA immediately
before the first tick when the machine starts, 0xFC on stop, ticks only while
running. Reads bpm live from machine.bpm each pass. Pure core exported for
tests: `planTicks(fromSec, toSec, bpm, phase) -> {ticks: [sec], phase}`.

ClockIn: interval estimator over event.timeStamp deltas: reject intervals
outside +/-30% of the running estimate, windowed mean of the last 24 accepted
intervals, exposes {bpm, stable} (stable = 24 accepted in a row). UI shows it;
ADOPT snaps machine.bpm to the rounded estimate. Nothing auto-adopts.

### js/app/wire-controller.js + WIRE panel (MACHINE tab)

Panel states: (no Web MIDI) -> one line of honest copy, no buttons. (before
permission) -> single CONNECT MIDI button. (connected) -> IN/OUT selects,
activity LED, CLOCK OUT toggle, CLOCK IN readout + ADOPT, NOTE base + LEARN
(capture next note-on as base), and a LEARN table mapping incoming note/CC to
actions: fire track 1-8 (notes base..base+7 by default), mute track 1-8,
scene 1-8, FILL momentary.

Note input fires the same path as the keybed (controller onTrig), with
velocity: sequencer.trigger grows an optional velocity01 argument that scales
the voice's amplitude linearly. Trigger at ctx.currentTime (input latency is
what it is; no artificial quantize in v1).

Persistence: {inId, outId, clockOut, noteBase, mappings} ride in
project.json as a `wire` top-level key. persist.js serializes and applies it
(formatVersion stays 2; old saves simply lack the key, applySnapshot treats a
missing key as defaults). CONTRACT-PERSIST.md gains a line for this.

### PATCH export (SLICE state toolbar)

Button "PATCH ·.aif" enabled when clips exist. Takes clips in timeline order
(first 24; report if more), cuts each from the CURRENT R.mono (repairs
included), per-segment resample R.sampleRate -> 44100 through
js/dsp/resample.js, buildDrumPatch, download as `<stem>-kit.aif`. Status line
reports slices, seconds, and whether lengths were scaled to fit. In-app copy
mentions dropping it onto the OP-Z content-mode disk (samplepacks folder) or
an OP-1; no deeper device UI in v1.

## 4. Acceptance

Node (harness suite `op1 patch`): fixed-point golden values incl. frame
463363 -> 1880318338; build->parse roundtrip of every JSON field; APPL even
length + signature accounting; COMM extended-rate bytes; SSND big-endian
sample values spot-checked against the input floats; 24-slot duplication;
over-budget scaling; fade endpoints near zero. Clock: planTicks tick count
and spacing at 120 and 174 bpm across window seams, phase continuity across
tempo change.

Browser: permission flow from click; ports enumerate; with IAC/loopback if
present: clock out ticks observed at expected spacing, FA/FC on transport;
note-in fires a track voice with velocity scaling; learn captures; mappings
persist across reload (PERSIST integration); no console errors. On a machine
with no MIDI ports: panel degrades to honest copy, everything else unaffected.

Hardware validation (Ian, post-ship): drop an exported kit onto a real OP-Z,
confirm 24 pads; confirm OP-Z external sync follows CLOCK OUT; LEARN the drum
base note and confirm pad->track fire.
