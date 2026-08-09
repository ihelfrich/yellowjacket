# STUDIO contract

STUDIO is YellowJacket's melodic production layer. MACHINE remains the sample,
drum, slice, and scene instrument; STUDIO adds six polyphonic synthesized parts.
Both layers meet at the same local Web Audio master and live in the same project.

## 1. Document

`project.studio` is serializable and contains tempo, swing, loop length, master
level, six tracks, synth parameters, mixer state, and 64 note events per track.
Audio nodes, timers, and transport position never enter the document.

A note event is `{ note, chord, velocity, gate }`. `note` is MIDI 0–127;
`chord` expands deterministically; `velocity` is linear amplitude; `gate` is a
multiple of one sixteenth note. A project from before STUDIO simply keeps the
default rack because the field remains optional in format version 2.

The document also carries `keyRoot`, `scale`, and `ideaSeed`. IDEA is therefore
repeatable: a given seed produces the same six parts, and the next idea remains
stable across save, resume, undo, and portable project transfer.

## 2. Synthesis

Every note creates two oscillators into one resonant low-pass filter and an ADSR
amplifier. The two oscillators have independent waves, mix, detune, and a shared
transpose. Voices are polyphonic and own their envelopes so one step cannot bend
or truncate another step's tail.

The six strips own gain, pan, mute, solo, reverb send, and tempo delay send.
Returns feed a gentle bus compressor before the existing YellowJacket master.

## 3. Clock and bounce

The scheduler looks ahead and gives each swung sixteenth an explicit duration.
An even/odd pair always totals two straight sixteenths, so swing never drifts.

BOUNCE uses the same note expansion, voice graph, swing durations, mix state, and
effects in an `OfflineAudioContext`. Output is a 48 kHz stereo, 24-bit WAV with
four seconds of tail for releases, reverb, and delay.

## 4. Editing and portability

Every sound, mixer, and note edit passes through `ProjectStore.update`, making it
undoable and autosaved. Studio-only work counts as project content. `.yjkt`
export/import carries it inside `project.json`; no extra PCM files are necessary.

Pattern transforms operate on one 16-step bar: SHIFT rotates without changing
events, INVERT mirrors pitches around that bar's range, and DUPLICATE deep-copies
into the next bar so later edits cannot alias the source.

## 5. MIDI

MIDI OUT writes a format-0 Standard MIDI File at 480 PPQ. Six instruments occupy
six channels with tempo, time signature, program hints, chord expansion, track
transpose, velocity, gate, mute/solo state, and swung note positions. The MIDI
file ends with a canonical end-of-track event and needs no browser dependency.
