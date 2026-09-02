# Yellowjacket

By [Ian Helfrich](https://ihelfrich.github.io).

An audio bench that runs entirely in your browser. Drop in a recording and Yellowjacket
transcribes it on your own hardware, lets you cut the audio by deleting words from the
transcript, shows the signal as waveform and spectrogram, measures loudness the way
broadcast meters measure it, and runs a repair chain (denoise, de-hum, de-ess, EQ, gate,
compression, limiting, loudness normalization) before handing you a WAV.

It is also a multi-instrument virtual production studio: six polyphonic melodic parts
sit beside the eight-track sample machine, with dual-oscillator sound design, chords, a
four-bar note sequencer, channel mixing, reverb/delay sends, and a 48 kHz stereo bounce.
LOOM binds source-grounded words or audio spans to MIDI gestures, then arms that binding
as a ninth, scene-local MACHINE lane. A recording can become an inspectable musical
performance without losing where any sound came from.

Live at **[ihelfrich.github.io/yellowjacket](https://ihelfrich.github.io/yellowjacket/)**.

It is a static page. There is no server to upload to. The only things fetched over the
network are the page itself, on first use the Whisper model weights from Hugging
Face's CDN, and any FIELD recording you choose to stream from archive.org; the browser
caches the first two, so the second session works on a plane. Your audio
never leaves the machine. If that claim sounds like marketing, open the network tab and
watch it stay empty while you work.

Audio gets in five ways: load the bundled demo, open a FIELD recording, drop a file,
pick one, or paste a URL. Files are decoded **at their own sample rate**, up to 192 kHz:
a browser normally resamples everything to the output device's rate on decode, which
quietly halves a 96 kHz recording before you ever see it, so Yellowjacket decodes through
a context built at the file's rate instead. That matters most for found sound — the
ultrasonic detail in a field recording is exactly what becomes audible when you pitch it
down. A `.mid` file dropped on the bench loads into STUDIO's six parts instead. The
demo is **Sparks** by Zane Little, a 2:40 electronic pop track released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/); its vocals, transients,
and tonal sections exercise every bench without asking a first-time visitor to find a
file. Direct links work
whenever the host allows browser fetches (podcast enclosures, archive.org, most CDNs).
YouTube and SoundCloud don't allow that, and no static page can change it; the tools
that claim to are servers doing the ripping for you. Paste one of those links anyway and
Yellowjacket writes you the yt-dlp command with your URL already in it, so the rip
happens on your machine and the file lands back on the bench.

**THE SHELF** started as nine field recordings and grew into five drawers, all
streamed from archive.org (which serves audio with CORS headers, so a static
page can fetch it) and all licence-checked by hand at their item pages — CC0,
Public Domain Mark, or old enough to be nobody's. **FIELD** holds places: a
nightingale at midnight, Berlin songbirds against the rush-hour roar, waves in
the lava caves of Pico Island, surf at Cox's Bazar, a Somerset thunderstorm, a
brook, spring peepers, night insects in Los Gatos, a cicada in one Catalan tree,
a Sevilla street under church bells. **VOICE** holds words, because a bench that
transcribes speech had no speech to try: Longfellow's *Hiawatha's Childhood*
read aloud, and eight minutes of the NASA control room on the day Voyager 1
left. **SCORE** holds Bach's Goldberg Variations from Musopen, in 24-bit.
**MUSIC** holds two 78s from 1921 and 1922 — Kid Ory's Sunshine Orchestra, the
first jazz record by a Black New Orleans band, and Ethel Waters singing —
transferred at 96 kHz/24-bit. **ODD** holds Stephen McGreevy's recordings of
the Earth's magnetosphere: a dawn chorus that is not birds, and lightning heard
as a descending whistler.

The shelf has one switch. **LIGHT** streams the MP3 the archive derived;
**LOSSLESS** streams the original where one exists, and the badge on each card
shows the rate and depth read from that file's own header, not from the
archive's metadata. A 96 kHz label is not 96 kHz of content — the cicada is 96
kHz on the tin and ordinary bandwidth inside — so the spectrogram, not the
badge, is the authority on what a recording holds. The point of any of it is
not background listening: SLICE a wave-crash into the sample machine, HARVEST
the cicada into a kit, transcribe Hiawatha and weave four of its words onto a
gesture in LOOM, and something that was nobody's becomes something you can
play.

## Why this exists

Descript proved that editing speech by editing text is the right interface, then built it
so the workflow can't run without their cloud. Originals upload whether you want that or
not, projects won't even open offline, transcription minutes are metered by plan, and the
AI cleanup tools burn purchased credits. The two top-voted requests on their forum are a
true offline mode and an option to keep files local. Those aren't feature requests,
they're the product description of a static site.

The text-based cutting itself never needed a server. A transcript with word-level
timestamps is an edit decision list; deleting a word is arithmetic. Whisper now runs in
the browser at usable speed (WebGPU when you have it, WASM when you don't), and the Web
Audio API has been able to splice, filter, and render audio offline for a decade. So this
is that: the local three-quarters of Descript, plus the measurement bench Descript never
had, on a page that costs nothing to host and nothing to use.

## The six benches

**TRANSCRIPT** is the Descript part. Pick a Whisper model, transcribe, then edit the audio
by editing words: click a word to seek there, select a run of words and delete them, and
the audio underneath goes with them. Filler words get flagged for one-click removal.
Silences longer than a threshold show up as bracketed gap pills you can cut in bulk. Cuts
preview instantly during playback (the player just skips them) and apply with short
crossfades on render. Export the transcript as TXT, SRT, VTT, or JSON, with caption
timings recomputed against the edited audio.

**SIGNAL** is the microscope: waveform stacked over spectrogram with a shared zoom. The
measurement rail runs the ITU-R BS.1770-5 loudness stack: gated integrated LUFS, short-term
and momentary maxima, sample peak, an estimated true peak, RMS, crest factor, DC offset,
and a clipped-sample count that turns red when it should.

The spectrogram is also an editing surface. Drag a rectangle around a cough, a beep, or a
hum band and REPAIR pulls that region toward what the surrounding audio predicts, with
feathered edges so there is no hole where the sound used to be. Alt-drag grabs a
transient top to bottom; Shift-drag grabs a tone band, and a harmonics button stacks the
same repair at 2x, 3x, 4x for mains hum. Every repair is an entry in a stack with its own
bypass toggle, so you can audition exactly what changed and take any of it back; an empty
stack returns the untouched original. Repairs are honest about their limits: they remove
one-off blemishes from otherwise-clean audio, and they do not pretend to lift noise out
from underneath speech.

On browsers with WebGPU the spectrogram image renders on the GPU. The full STFT matrix
sits in video memory, so zooming never re-rasterizes, and during playback the sweep
leaves a short phosphor trail that fades the way a storage scope fades, half a second to
black. The image math mirrors the 2D renderer down to the color lookup table, and the
bench drops back to that renderer the moment a GPU device is lost.

The **RACK** stacks the repair chain in signal order: high-pass, de-hum (mains fundamental
plus harmonics), spectral denoise, de-esser, four-band EQ, gate, compressor, lookahead
limiter, and loudness normalization to a LUFS target (-16 for podcasts is the default).
Every module has a power switch and a few honest parameters. Render, then A/B the result
against the original — and see it, not just hear it. The waveform draws the take
you are hearing in yellow over the one you are not in light blue, so the blue
that survives is exactly what the rack changed: a compressor shows as tall blue
lobes with the yellow squeezed inside them, and loudness normalisation shows as
yellow standing proud of the blue through the quiet passages. An all-bypass rack
renders sample-identical audio and shows no blue at all, which is the honest
answer. Export WAV at 16, 24, or 32-bit float — at the session's own
sample rate, so a 96 kHz load is still 96 kHz on the way out. The float export writes a
spec-correct IEEE header and keeps samples above full scale instead of clamping them, so a
hot bounce can still be pulled back down in whatever you open it with next.

**STUDIO** is the melodic production layer: six independent polyphonic instruments with
eight starting architectures (sub, bass, keys, pluck, pad, lead, organ, and glass). Each
part has two oscillators, detune or harmonic intervals, transpose, a resonant low-pass,
and a full ADSR envelope. A four-bar note sequencer writes single notes, fifths, minor or
major chords, and dominant sevenths with per-event velocity and gate. Its mixer adds
level, pan, mute, solo, plate reverb, and tempo delay; BOUNCE prints the whole loop through
the same graph as a 48 kHz stereo, 24-bit WAV. Pick a key and scale and IDEA writes a
deterministic six-part starting arrangement; SHIFT, INVERT, and DUPLICATE reshape bars,
while MIDI OUT sends the tempo, swing, chords, velocities, gates, and six channels to a
DAW. MIDI also comes back the other way: drop a Standard MIDI File and its tempo and notes
land on the grid, quantized to sixteenths, filling only the parts the file actually
carries and reporting anything that fell outside the four-bar window. Studio edits participate in undo, autosave, and portable `.yjkt` projects without
needing a recording loaded first.

**LOOM** is the semantic performance layer. Select kept transcript words and **WEAVE
WORDS** opens them as real source material in one action; a real audio span works too.
Gesture comes from a deterministic starter phrase, any populated STUDIO track, or one bar
played live from the selected WIRE MIDI input. Live capture keeps note, velocity, note-off
gate, and sub-step timing; note-off bounds the audible source span, while the as-played feel becomes a fractional position on Machine's
own clock rather than a second transport. WEAVE
binds material and gesture into an immutable event map addressed by canonical SHA-256. Every event
retains its source timestamps, word range, note, velocity, timing feel, pitch treatment,
and intended hardware channel, so TRACE returns to the exact recording span even when the
audio itself is offline.

ARM TO SCENE places that map above the eight MACHINE tracks as a ninth lane without
turning words into disposable samples. It runs on the same compiler clock as the drums,
follows the active scene's tempo and swing, survives scene copies and source replacement,
and can be bypassed or trimmed from PATTERN. PRINT 24-BIT renders the combined Machine +
semantic performance and downloads one ZIP containing a WAV and a `.yjmap.json` lineage
map. The encoded recording's local SHA-256—not its filename—is the source identity.
Material and gesture remain independently replaceable, while scenes already armed to an
older take keep their immutable recipe. The exact contract and fidelity boundary live in
[CONTRACT-SEMANTIC-TAKE](docs/CONTRACT-SEMANTIC-TAKE.md).

**MACHINE** is the sample production bench: it maps the beat grid
of whatever you loaded (spectral-flux onsets, Ellis-style dynamic-programming beat
tracking, with a confidence readout that admits when material has no usable pulse), then
lets you carve the audio into clips. Drag to cut a region with edges that snap to beats,
cut a whole selection into bars with one button, click any clip to hear it, and export a
clip as a WAV loop. Selected transcript words now enter LOOM directly and can ride above
the pattern as a traceable performance instead of becoming an irreversible clip. Tempo
detection wrong? Tap the tempo or pin
bar one and it re-tracks around your anchor.

MACHINE also starts without source audio. Its factory rack builds three coherent
eight-voice kits locally: deep analog 808 weight, a warmer tape-shaped set, and a
sharper digital set. These are not bundled MP3s or loosely matched presets. Each voice
is deterministic model synthesis with Float64 state and true phase accumulation; its
nonlinear core runs 4× at 384 kHz, then the same Kaiser sinc converter used elsewhere
produces the canonical 96 kHz PCM. Role-specific calibration leaves intentional mix
headroom instead of normalizing every hit to the same ceiling. The long 808 bass is
pitched through ordinary voice and step locks, and open/closed hats share a real
cross-track choke group.

Every kit includes authored grooves and deterministic NEW TAKES. A take holds the
musical anchors while recomposing ghost hits, velocities, probabilities, ratchets, and
bass pitches from a saved variation number; the result is repeatable after reload and
prints identically offline. LOAD SOUNDS keeps the current grid. LOAD + GROOVE replaces
it explicitly. Either operation is one undoable project edit.

MACHINE's PATTERN state is an eight-track step sequencer in the OP-XY lineage: assign
clips to tracks (the samples are copied in, like loading a pad), program 64 steps across
four pages, set per-track lengths for polymeter, swing the grid MPC-style, fire tracks
live from keys 1 through 8, and mix with per-track gain, pan, mute, and solo. Live
playback and offline render come from one event compiler, so FREEZE replays the same
deterministic musical decisions. The print lets already-started voices and Space returns
finish, then passes through the -0.3 dBTP offline limiter; it is intentionally not a
bit-identical capture of the live device path. The loop becomes the new bench source
while the machine keeps its pattern, and you can slice the freeze and go around again.

HARVEST mines a whole track for its best material instead of making you hunt
for it. It classifies every candidate slice by role (kick, snare, hat, bass,
tone, vocal, effect, crash) from its attack, its band balance, and how
harmonic and sustained it is, then fills a 24-slot kit under per-role quotas
with a diversity rule that spreads the picks across the song. Sustained
material gets its own sweep, because a held pad or a riser never produces the
onset spike a drum does. On a seven-minute record it returns twenty-four
labeled slices drawn from eighty-nine percent of the runtime. It then
seats them: the eight machine tracks are loaded straight from the harvest, kick
and snare first, the other roles behind them, and the best of whatever is left
backfilling the tracks a source could not fill. A frog chorus has no hi-hats; it
still comes back as a kit you can play rather than a list you have to place by
hand. Tracks that already hold a sound are left alone, so a second harvest adds
to a kit instead of overwriting one. Each seated slice is also brought up to a
playable level on the way in, with the boost capped at 18 dB so a near-silent
slice is not amplified into its own noise floor: the frog kit went from a -24
dBFS render to -6 without clipping. A slice you assign by hand keeps whatever
level it had, because that is a deliberate choice rather than a kit being
built for you. And because seating samples writes no steps, HARVEST also
lays down a starter groove keyed to the roles it found — kick and snare carry
the pulse, tonal material stays sparse, and a role that lands on more than one
track is rotated so the copies interlock instead of stacking. It writes only
over a pattern that is entirely empty, so your own beat is never overwritten.
Open a field recording, press HARVEST, press FREEZE: three clicks from a
wetland at night to a mixed-level loop.

Every track's sample is an editable VOICE: trim its start and end on a
waveform, pitch it up to two octaves either way, shape attack and release,
play it reversed, then colour it with a resonant lowpass, a highpass, and
tanh saturation. That colour section is what separates a rework from a
bootleg: a vocal chop pitched down five semitones through a 700 Hz filter
with the resonance up is not the record it came from.

CRATE is a sample library that outlives the session. Save any voice you have
built (its audio and every setting) and it stays in the browser's own
storage, independent of the project. Discard the session, load a different
song, come back a week later: the instrument is still there. Build a kit from
four different records and play them together. A pitched-down vocal tail becomes a bass; the first tenth
of a kick becomes a hat. Step locks stack on top, so a voice pitched -12 with
a +7 lock on step eleven plays -5 there, deterministically, every pass.

SONG is the fourth state: chain scenes into an arrangement (A×4 B×4 D×8 …),
loop it or let it end, and print the whole thing as one 24-bit WAV. The song
compiler is the pattern compiler applied per section, so what RENDER SONG
writes is sample-for-sample what PLAY SONG played, seeded dice and all.
Punch-in effects and the CHARACTER color rack are next; the plan lives in
docs/VISION.md.

## The command deck

Press **Command-K** (or **Control-K**) anywhere to open a searchable map of the
whole instrument. It jumps directly to every bench and MACHINE state, and it
surfaces contextual actions such as transcription, loudness measurement,
HARVEST, rack rendering, audio export, project import/export, and history. An
action that cannot run says why instead of disappearing. Undo and redo also
live visibly in the header; their shortcuts remain Command/Control-Z and
Command/Control-Shift-Z.

## Out the wire

The MACHINE bench has a third state: WIRE, the hardware side. Connect a USB MIDI
device and its pads fire the eight tracks with velocity; LOOM can capture one bar from that
same selected input as a source-traceable human gesture; LEARN maps any note or
knob to track mutes, scene switches, and momentary fill; CLOCK OUT makes the
bench a MIDI clock master, ticks scheduled with driver-level timestamps off the
same audio clock the sequencer runs on, so a groovebox on the desk locks to the
loop in the browser. Incoming clock gets an estimator and an ADOPT button rather
than hard sync: chasing a jittery tick stream sounds worse than snapping to its
tempo once it settles.

The other half is PATCH, in the SLICE state. Carve up to 24 clips and print a
drum kit as a single .aif in the OP-1 drum patch format: mono 44.1 kHz, twelve
seconds, slice points written in the device's own fixed-point scheme (verified
byte-for-byte against a factory patch). Drop the file onto an OP-Z in content
mode or an OP-1 disk and the pads play your slices. The whole trip runs in the
page: rip, beatmap, carve, repair if the source is rough, print, drag to the
device. A source-free factory or custom Machine kit can print directly from PATTERN;
its active voices are folded to mono and band-limited once from their real source rates
to the hardware format. Works with the teenage engineering OP-Z and OP-1; this is not a teenage
engineering product and is not affiliated with them.

## The bench remembers

Close the tab mid-session and nothing is lost. Yellowjacket autosaves the working state
to the browser's origin-private file system about a second after every change: the
source audio as loaded, the transcript, clips, the rack, every scene and step in the
machine, the repair stack, and the tempo pins. Reopening the page offers the last
session by name, with RESUME and DISCARD buttons; nothing loads until you choose. The
saved files never leave the machine, which is the same promise the rest of the tool
makes.

Autosave protects one browser on one device. **PROJECT OUT** goes further: it
packs the complete working session into one portable `.yjkt` file—the original
encoded source, transcript and cuts, repair stack, slices, sample PCM, voices,
patterns, scenes, song, rack, and MIDI map. **PROJECT IN** restores that file in
another browser. A `.yjkt` is a deliberately simple STORE-only ZIP with CRCs;
imports validate the format, source length, every referenced sample, duplicate
paths, traversal attempts, and checksums before the live bench is changed.
CRATE remains a separate instrument library and is never overwritten by a
project import.

## Models

| Model | Download | Notes |
|---|---|---|
| Whisper tiny.en | ~41 MB | fastest, rough edges |
| Whisper base.en | ~77 MB | the default; fine for clean speech |
| Whisper small.en | ~250 MB | noticeably better on messy audio |
| Whisper base / small | ~77 / ~250 MB | multilingual, 99 languages |

Sizes are the WASM-quantized downloads; WebGPU pulls larger, higher-precision weights.
First transcription includes the download. After that the model loads from browser cache.

## What it won't do

The caveat that actually matters day to day: Whisper was trained on clean transcripts and
often politely omits "um" and "uh" from its output, so the filler counter reports what the
model heard, not everything you said. The dead-air cutter works from word-gap timing rather
than transcript text, which is why it catches pauses the filler pass misses.

There is also no speaker diarization and no voice cloning. Those are the genuinely
server-heavy parts of the Descript feature set, and pretending a 77 MB model does them
would produce something worse than not having them.

Long files are bounded by browser memory. An hour of speech is fine on a laptop;
a four-hour board meeting may not be.

## Numbers worth trusting

The loudness code follows BS.1770-5: two-stage K-weighting (redesigned per sample rate
using the De Man parametrization, verified against the published 48 kHz coefficients),
400 ms blocks at 75% overlap, the -70 LUFS absolute gate and -10 LU relative gate. True
peak runs the standard's own 4x polyphase FIR structure, verified against analytic
intersample peaks to within 0.1 dB. The limiter derives its gain from those oversampled
peaks and holds its ceiling as a true-peak ceiling, not a sample-peak one. 16-bit
exports get TPDF dither with F-weighted noise shaping at 44.1 and 48 kHz (the SoX
coefficient set), and the export reports pre-quantization overs instead of silently
clipping them. The EQ uses Vicanek matched filters, so a 15 kHz peak still looks like
its analog prototype instead of cramping into Nyquist. Audio headed to Whisper is
resampled through a Kaiser polyphase sinc with 80 dB stopband; the denoiser is the
spectral-gating recipe from the noisereduce literature rather than something
improvised. Every one of these claims is locked by a test you can run yourself:
node test/run.mjs.

Factory drum PCM is fixed at 96 kHz and synthesized through a 4× nonlinear core before
band-limited decimation. Live monitoring still follows the actual AudioContext/device
rate—reported in the kit strip—while Machine FREEZE and SONG automatically choose the
highest active sample rate and therefore print a factory-kit performance at 96 kHz.
Editable drive stages request Web Audio's 4× oversampling in the one graph shared by
live and offline playback; the offline master retains the -0.3 dBTP true-peak ceiling.

## Running it locally

```bash
git clone https://github.com/ihelfrich/yellowjacket && cd yellowjacket && python3 -m http.server 8080
```

Then open `http://localhost:8080`. A server is required (module workers don't run from
`file://`), but any static server works.

## License

Copyright (c) 2026 Ian Helfrich. Yellowjacket is source-available under the
[Business Source License 1.1](LICENSE.md). Individuals may use it for their
own personal, noncommercial purposes. Production use by any organization—or
use for an employer, client, paid service, commercial product, or other
revenue-generating work—requires a separate commercial license from the
author. This includes businesses, nonprofits, educational and research
institutions, governments, public-safety organizations, and health
organizations. Write to ianthelfrich@gmail.com.

Each version converts to the Apache License 2.0 on the date specified in the
license, or no later than four years after that version was first publicly
distributed, as required by BSL 1.1.

The bundled Archivo and IBM Plex Mono fonts remain under their own SIL Open
Font License. Whisper models load from their upstream sources under their own
licenses. Built by [Ian Helfrich](https://ihelfrich.github.io).
