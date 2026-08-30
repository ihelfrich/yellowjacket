# AUDIT — resolution and the found-sound workflow

Measured 2026-08-29 against two goals: handle the highest-resolution audio files,
and be a versatile bench for making music from found sounds, chopped songs,
existing audio, and MIDI files. Every claim below was executed, not inferred.

> **Status, same day.** Items 1, 2, 3, and 4 are FIXED and verified in the running
> app. A 96 kHz file loads at 96 kHz (status bar reads `96.0k`) and a 30 kHz tone
> that used to vanish measures −8 dBFS, level with the audible tone. A `.mid`
> dropped on the bench fills STUDIO's parts and carries its tempo. Export offers
> 32-bit float with a spec-correct IEEE header, and a 96 kHz session exports at
> 96 kHz. The STUDIO bounce follows the session rate instead of a hardcoded 48000
> (measured: `STUDIO BOUNCE · 24-BIT · 96 kHz`). **Only item 5 stands** — there is
> still no arrangement surface where two sources are live as audio at once.

## 1. The input path silently halves high-resolution audio

`Engine._ensureCtx()` in `js/audio-engine.js` builds `new Ctx()` with no
`sampleRate` option, so the AudioContext adopts the hardware rate. Per the Web
Audio spec, `decodeAudioData` resamples the decoded result to the context rate.
Everything the bench sees — waveform, spectrogram, LUFS, slices, harvest — is
downstream of that decode.

Measured in-browser on this machine, decoding a synthetic 96 kHz WAV:

| | rate | frames (1 s) |
|---|---|---|
| source file | 96000 | 96000 |
| `Engine.load` path (`new AudioContext()`) | **48000** | **48000** |
| `new OfflineAudioContext(1, n, 96000)` | 96000 | 96000 |

Half the samples are gone before the first bench touches the audio, and nothing
in the UI says so. A 192 kHz file loses three quarters.

**It is a clean loss, not a corrupting one.** A 30 kHz tone in the 96 kHz source
would alias to 18 kHz if the resampler had no anti-alias filter. Measured
energy at 18 kHz after decode: −83.7 dBFS, against a −96.4 dBFS control floor at
a silent bin. That is ~13 dB of residue, far below audibility. The browser's
resampler filters properly; the ultrasonic band is discarded, not folded back.

**Why it matters here specifically.** Pitching a field recording down two to four
octaves is the defining found-sound technique, and ultrasonic content is exactly
what survives that shift into the audible band. Bat calls, insect stridulation,
and the high detail in running water are destroyed at load. The FIELD shelf makes
this gap more acute, not less.

**The fix is small and already proven.** Decode through an
`OfflineAudioContext` created at the file's native rate, then resample for
playback only (`js/dsp/resample.js` exists). The table above is that fix working
in the same browser. Header parsing gives the native rate before decode; a
fallback decode-then-inspect covers containers that do not.

## 2. Rates are inconsistent across the engine

| path | rate | note |
|---|---|---|
| factory drums | 96000, 4× oversampled (384 kHz internal) | enforced — `renderFactoryVoice` throws `RangeError` on any other rate |
| loaded source audio | hardware rate (48000 measured) | resampled at decode, silently |
| STUDIO bounce | 48000 | hardcoded in `js/studio/engine.js:252` |
| SYNTH / modal fallback | 44100 | `R.sampleRate \|\| 44100` |
| OP-1 patch export | 44100 | correct — device requirement |

The synthesis engine is audiophile-grade and defends its rate with an exception.
The path that carries *the user's own audio* is the least protected one. For a
tool whose thesis is that any recording becomes an instrument, that is backwards.

## 3. WAV export is 16/24-bit PCM only

`encodeWavWithStats` clamps to `bitDepth === 24 ? 24 : 16`. There is no 32-bit
float export, which is the normal interchange format for an unfinished bounce
headed into another tool. The dither handling is correct and deliberate: TPDF
dither at 16-bit, none at 24-bit because the noise floor already sits below any
real source noise.

## 4. MIDI files can be written but not read

`js/studio/midi.js` builds a Standard MIDI File (`MThd`, division, tracks) and
`STUDIO` downloads `.studio.mid`. `js/midi/wire.js` parses *live* Web MIDI
messages for WIRE capture. There is no Standard MIDI File **parser** anywhere in
the tree, so a `.mid` on disk cannot enter the bench. Against a goal that names
"existing sound and midi files," this is a direct miss.

## 5. Combining sources works, but only by committing

One source occupies the bench at a time; `loadArrayBuffer` clears `p.clips` and
replaces the buffer. Combination happens one level up, and it does work:

- MACHINE track samples hold **detached PCM** (`track.sample.channels`), not
  references into the live source buffer, so they survive a source swap.
- CRATE persists instruments in its **own OPFS directory**
  (`yellowjacket-crate-v1`), so a session DISCARD never touches them.

So a field recording sliced in session one can play against a chopped record in
session five. The ceiling is 8 MACHINE tracks × 8 scenes, 6 STUDIO parts, and one
LOOM lane. What does not exist is an arrangement timeline where two sources
coexist as audio — combination requires committing a slice to a track or the
crate first.

## Ranked against the stated goals

1. **Native-rate decode** — the only item that contradicts a stated goal outright,
   and the cheapest to fix.
2. **Standard MIDI File import** — the other outright miss.
3. **32-bit float export**, and STUDIO bounce inheriting the project rate rather
   than a hardcoded 48000.
4. An arrangement surface for two live sources — real work, and the only item
   here that is a redesign rather than a repair.
