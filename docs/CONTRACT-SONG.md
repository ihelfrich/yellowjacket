# CONTRACT-SONG — per-voice slice editing + song arrangement (patterns of patterns)

Binding for the SONG slice. Two halves: VOICE (every track's sample gets
trim/pitch/envelope/reverse controls, composing with the existing step locks)
and SONG (a chain of scenes with repeat counts becomes an arrangement, played
live and rendered offline from ONE compiler). The prime directive holds: live
playback and offline render come from the same compiled event stream, so
RENDER SONG prints exactly what PLAY SONG played.

## 1. Voice model

Every track gains a persisted `voice` object (js/app/project-store.js
createTrack):

```
voice: {
  start: 0,        // 0..1 fraction into the sample
  end: 1,          // 0..1, always > start (enforce min span 0.005)
  pitch: 0,        // -24..+24 semitones; rate = 2^(pitch/12), no timestretch
  attack: 3,       // ms, 1..500, linear ramp
  release: 8,      // ms, 2..2000
  reverse: false,  // plays the TRIMMED span reversed
}
```

Composition rules with step locks (LOCK slice), applied in the compiler:
lock pitch ADDS semitones to voice pitch; lock reverse XORs voice reverse;
lock gate scales the trimmed slice duration as it scales durSec today;
velocity/gain/pan locks unchanged. compileTrigger (pad hits) uses the voice
too: what you audition is what the pattern plays.

Event shape grows (all optional, neutral when absent):
`offsetSec` (buffer-domain offset of the trim start, computed against the
reversed buffer when reverse is on: reversedOffset = (1 - end) * bufSec),
`sliceSec` (buffer-domain span), `attackSec`, `releaseSec`.

scheduleEvent changes (js/machine/sequencer.js): `src.start(when, offsetSec,
sliceSec)` when trim fields are present; envelope becomes voice-driven:
attack ramp over attackSec, then a release ramp that ENDS at the effective
wall end (min of gate wall time and sliceSec/rate) starting releaseSec
earlier, clamped so it never starts before the attack peak. This replaces
the old no-fade-at-buffer-end behavior: every voice now declicks at its end.
The old fixed ATTACK_SEC/RELEASE_SEC become the voice defaults (3 ms / 8 ms).
A track with the default voice must compile to events whose tSec, gain, pan,
rate, and durSec are IDENTICAL to today's output: the existing harness
suites (pattern compiler, LOCK compiler) must pass without edits to their
assertions.

## 2. Song model

```
machine.song = {
  chain: [ { scene: 0..7, reps: 1..99 } ],   // empty chain = no song yet
  loop: true,
}
```

New pure compiler in js/machine/compile.js:

```
compileSong(machine, opts={}) -> { events, ducks, sections, totalSec }
  // sections: [{ scene, startSec, loopSec, reps, endSec }]
```

Per chain entry, build a scene facade `{ scenes: machine.scenes,
activeScene: entry.scene, tracks: scene.tracks, bpm: scene.bpm, swing:
scene.swing }` and reuse compileRender(facade, reps) verbatim, offsetting
event/duck times by the accumulated section start. Each entry's cycle
counter starts at 0 (re-entering a scene later in the chain replays the same
seeded rolls; the song is deterministic end to end — document this in the UI
copy as a feature, not a bug). Tempo may differ per scene; each section uses
its own scene's bpm/swing. FILL is compiled off for songs.

Sequencer (js/machine/sequencer.js) gains:

```
playSong()    // compiles the full song, anchors to ctx.currentTime, and
              // feeds the SAME lookahead scheduler used for pattern play;
              // emits 'songpos' {section, rep} events at section boundaries
              // and 'songend' (then re-anchors when machine.song.loop)
stopSong()
renderSongWav(bitDepth=24) // OfflineAudioContext over compileSong; returns
                           // the encoded WAV bytes via existing encodeWavWithStats
get songPlaying
```

Pattern-mode transport (RUN) is unchanged. playSong stops pattern play first
and vice versa. Live FILL/keybed stay active during song playback (pad hits
layer on top; they are performance).

## 3. UI

New MACHINE substate SONG (index.html gets the button + pane; integrator
wires). js/machine/song-ui.js — pure view, EventTarget, no store access,
same conventions as pattern-ui:

- Chain editor: one row per entry: scene letter button (A..H = scenes 0..7,
  click cycles or opens a small picker), reps stepper (×1..×99), move up,
  move down, delete. ADD SECTION appends {scene: activeScene, reps: 4}.
- Transport row: PLAY SONG / STOP, LOOP toggle, RENDER SONG (WAV), and a
  readout well: total bars + duration + current position while playing.
- events out: 'chainedit' {chain}, 'loop' {loop}, 'play', 'stop', 'render',
  'audition' {scene} (click a letter = preview-switch that scene in PATTERN).
- setSong(song, scenes), setPosition(sectionIndex, rep), setPlaying(bool).

js/machine/voice-ui.js — pure view: a VOICE drawer for the PATTERN state.
- setTrack(index, track) renders: sample name, a mini waveform canvas of the
  track's sample PCM with draggable START/END handles (fractions), and
  controls: PITCH (semitone stepper -24..+24), ATTACK ms, RELEASE ms,
  REVERSE toggle, and a TRIG button to audition.
- events out: 'voiceedit' {track, patch} (partial voice fields), 'trig'
  {track}, 'close'.
- Reuses the peak-drawing idiom from slice-ui (no new rendering tech).
- Opened from pattern-ui: a per-row [V] button next to the track sample well
  (pattern-ui emits 'voiceopen' {track}; the integrator shows the drawer).

## 4. Persistence

serializeTrack gains `voice: clone(track.voice)`; applyTrack merges known
voice fields with clamps and keeps defaults when absent (old saves load
clean). json.machine gains `song`; applySnapshot merges chain entries with
scene/reps clamps into the existing machine.song object (contents, never the
object). formatVersion stays 2. The persist harness fixture grows voice and
song values so the roundtrip fixed-point property covers them.

## 5. Acceptance

Node harness additions (integrator promotes): voice-neutral compatibility
(default voice compiles identical tSec/gain/pan/rate/durSec to pre-slice
output on the LOCK fixture); trim math incl. reversed offset; pitch rate
2^(semi/12) exact at +12/-12/+7; lock-pitch additivity; compileSong section
offsets and per-scene bpm boundaries (scene A at 120 for 2 reps of 16 steps
= 8.0 s, section B starts at exactly 8.0 s at its own bpm); determinism
(two compiles bit-equal); stitched parity extended: compileSong of chain
[A×1, A×1] equals compileRender(A, 2) with sections concatenated.

Browser: carve → assign → open VOICE → trim a slice and pitch it -12,
audition, hear it in the pattern; build a chain A×2 B×2 C×4, PLAY SONG
(sections advance, position readout moves), RENDER SONG downloads a WAV
whose duration equals totalSec; reload → RESUME → voices, chain, loop flag
all back; existing 51 harness cases still green.
