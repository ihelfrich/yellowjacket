# Yellowjacket v2 — the semantic tape machine

Locked 2026-07-26. Synthesized from three independent passes: Claude's product draft, a
Codex 5.6 architecture memo, and a five-agent research sweep (OP-XY interaction grammar,
browser music landscape, on-device ML feasibility, engine architecture, demand signals
with linked threads). Ian's decisions, same day: the semantic-tape spine is the v2
direction; the new bench is MACHINE; UNMIX ships in v2 as the final slice; microphone
recording waits for v3.

## The one idea

Any recording becomes a playable instrument, and every piece of it keeps its meaning.

Yellowjacket v1 already dissects a recording into meaning: words with timestamps, silence,
levels, spectra. v2 adds beats, slices, keys, and (optionally) stems, then makes all of it
playable: an eight-track groovebox where the raw material is whatever you dropped on the
page, and every clip knows what it is. A phrase becomes a hook. A breath becomes
percussion. Two bars of a bassline become a loop that follows your tempo. You perform it,
resample the performance back onto the bench, repair and master it there, and walk out
with a WAV. Codex named the spine correctly: semantic tape. Descript made speech editable
as text; this makes any audio playable as an instrument, on a static page, with nothing
leaving the machine.

## Why this wins (evidence, not vibes)

The niche is verifiably empty. The landscape sweep found three camps: cloud DAWs that
require accounts (BandLab, Soundtrap, Audiotool, Suno Studio), local open tools with zero
ML (openDAW, AudioMass, Wavacity, Strudel), and single-purpose local ML demos. No shipping
tool combines a serious sampler/groovebox workflow, full client-side operation, open
source, no account, and local ML. The nearest miss is LA Studio (closed source, freemium,
server-backed Pro, generic-DAW identity). openDAW is the strongest local engine and has
no ML at all; it is also AGPL, so we read it and never copy it.

The demand is ranked and sourced. From the mid-2024 to mid-2026 sweep of Reddit archives
and HN: (1) free local stem separation is the most recurrent wish, proven by
vocalremover.org's ubiquity and StemRoller's "free and runs on your hardware"
recommendation pattern; (2) podcast cleanup without a subscription meter, inflamed by
Descript's September 2025 repricing into media minutes plus AI credits (v1 already serves
this); (3) a modern simple editor (v1 again); (4) free fast sample flipping, currently
answered by $99 Serato Sample or mobile Koala; (5) no-account beat-making for Chromebook
classrooms, where a district blocked even Soundtrap's free tier over its sharing features.
v2's machine addresses 1, 4, and 5 while v1 keeps 2 and 3.

The price umbrella is comic. The OP-XY costs $2,299 and its own reviewers list what it
cannot do: no sample chop or slice, no time-stretch, no stem export, no per-step
probability. Every one of those is in this plan, free, plus the sequencer depth owners
actually envy (Elektron-style trig conditions). We steal the interaction grammar TE got
right and ship the features the hardware left out.

One honest correction from the research: the "sketchy upload site" privacy complaint is a
builder narrative, not a user one. Users want free, good, and instant; local is the
trust-building tiebreaker. Lead with what it does, mention that it cannot rug you.
Permanence is the differentiator no funded competitor can copy: Endlesss died, WavTool
died, freemusicdemixer retreated to the cloud. A static page cannot die.

## The surfaces

Keep TRANSCRIPT, SIGNAL, RACK exactly as shipped. Add one bench: **MACHINE**, with three
coupled states:

- **SLICE** — the source strip: waveform with beat grid, transient markers, word
  boundaries, and stems when present. Drag or click to carve ClipRefs: immutable
  references into source audio (start, end, gain, semantic tag). Never copies PCM.
  Transcript selections lift straight to pads: select three words, they become a chop.
- **PATTERN** — eight tracks, 64 steps, pages of 16. Tracks hold ClipRefs. QWERTY is the
  keybed (Ableton convention: A-row whites, W-row blacks, Z/X octaves; number keys select
  tracks). Steps are programmable objects, not booleans: hold a step and press a letter
  for a step component (pulse, hold, ratchet, velocity, ramp, random-in-scale, jump,
  skip-every-Nth), hold a step and drag any knob for a parameter lock, rendered as amber
  ticks and interpolated as vectors. Trig conditions (probability, A:B cycles, FILL) go
  beyond the OP-XY on purpose. Eight scenes swap whole pattern states without stopping.
- **PERFORM** — the same pattern with the keyboard remapped to momentary punch-in FX
  (Z through M: stutter, reverse, octave, filter kill, tape stop, duck), a two-bar rolling
  tape buffer you can grab and scrub, and gesture recording. RESAMPLE prints the
  performance as a new source on the bench: the Koala move, the loop that makes the whole
  tool feed itself.

Analysis feeds the machine: beat and downbeat detection (hand-rolled spectral flux plus
dynamic programming, kept MIT-clean; essentia.js is AGPL and stale), key detection with
diatonic transpose (our answer to the OP-XY's Brain), and tempo conform via
signalsmith-stretch (MIT, 232 KB WASM, the browser state of the art). FREEZE renders any
pattern or performance back to a normal buffer where SIGNAL and RACK work unchanged.

**UNMIX** (locked: in v2, final slice) is stem separation as an optional preparation step.
The research is sobering: WASM Demucs runs at minutes per song, and the flagship
client-side demixer gave up and moved to cloud processing. But MIT-licensed ONNX ports
with WebGPU exist now (timcsy/demucs-web, StemSplit/demucs-onnx, 172-316 MB models). The
honest ship: two stems first (vocals/instrumental), WebGPU strongly recommended, chunks
written to IndexedDB as they complete, progress stated in minutes not spinners, and the
Whisper and Demucs models never resident together. Stems land as machine tracks.

## What we refuse to build

No piano roll. No synth engines. No linear timeline arranger. No plugin hosting (we
mirror the WAM interface shape internally so a host could exist later, but the ecosystem
is SharedArrayBuffer-coupled and research-scale today). No microphone multitrack
recording in v2 (getUserMedia's processing defaults ruin music takes and latency
reporting is untrustworthy; revisit once the machine stands). No cloud, no accounts, no
generative models (MusicGen-small is CC-BY-NC and glacial on WASM; Stable Audio Open's
browser story does not exist). Eight tracks, 64 steps, eight scenes: the constraint is
the instrument, which is the actual lesson of every loved TE box.

## Engine (agreed by both AI passes and the architecture sweep)

Main-thread lookahead scheduler (25 ms tick, 200 ms horizon) compiling pattern events
against the audio clock onto native AudioBufferSourceNodes with AudioParam automation for
locks. The same event compiler feeds live playback and OfflineAudioContext export, so the
bounce always matches the performance. AudioWorklet only where node graphs cannot go: the
rolling tape buffer and punch FX. Native GainNode/StereoPannerNode per track. Baseline is
crossOriginIsolated === false (GitHub Pages cannot set COOP/COEP); no SharedArrayBuffer
anywhere in the core design. Persistence: OPFS as working store (project dir: JSON plus
WAVs plus peaks cache), zip export following the DAWproject container pattern, aggressive
autosave. Memory: ~23 MB per stereo track-minute decoded; cap the working set near
2.5 GB, store cold samples as Int16, freeze tracks as the pressure valve, and refuse
operations over budget instead of letting Chrome kill the tab at 4 GB.

## Sequence (each slice ships alone, ordered by risk)

1. **BEATMAP** — beat/tempo/transient analysis with editable anchors, slicing, ClipRefs,
   words-to-clips, loop export. Upgrades the bench even if nothing else ships.
2. **PATTERN** — the sequencer core: scheduler, eight tracks, QWERTY keybed, mixer,
   freeze-to-bench, OPFS projects.
3. **LOCK** — parameter locks, step components, trig conditions, scenes. The release
   where a web page out-sequences a $2,299 instrument.
4. **CONFORM** — signalsmith-stretch tempo matching, key detect, diatonic transpose.
5. **LIVE** — worklet tape buffer, punch-in FX, gesture record, RESAMPLE.
6. **UNMIX** — two-stem separation, stem-aware tracks, chunked persistence.

## Decisions log

2026-07-26, Ian: spine approved as stated; the bench is MACHINE; UNMIX ships in v2 as
slice 6 (two stems, WebGPU-first, honest WASM expectations); microphone recording is v3
material.
