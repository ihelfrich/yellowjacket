# Yellowjacket

An audio bench that runs entirely in your browser. Drop in a recording and Yellowjacket
transcribes it on your own hardware, lets you cut the audio by deleting words from the
transcript, shows the signal as waveform and spectrogram, measures loudness the way
broadcast meters measure it, and runs a repair chain (denoise, de-hum, de-ess, EQ, gate,
compression, limiting, loudness normalization) before handing you a WAV.

Live at **[ihelfrich.github.io/yellowjacket](https://ihelfrich.github.io/yellowjacket/)**.

It is a static page. There is no server to upload to. The only things fetched over the
network are the page itself and, on first use, the Whisper model weights from Hugging
Face's CDN; the browser caches those, so the second session works on a plane. Your audio
never leaves the machine. If that claim sounds like marketing, open the network tab and
watch it stay empty while you work.

Audio gets in three ways: drop a file, pick one, or paste a URL. Direct links work
whenever the host allows browser fetches (podcast enclosures, archive.org, most CDNs).
YouTube and SoundCloud don't allow that, and no static page can change it; the tools
that claim to are servers doing the ripping for you. Paste one of those links anyway and
Yellowjacket writes you the yt-dlp command with your URL already in it, so the rip
happens on your machine and the file lands back on the bench.

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

## The four benches

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
against the original before exporting WAV at 16 or 24 bit.

**MACHINE** is the newest bench and the start of something bigger: it maps the beat grid
of whatever you loaded (spectral-flux onsets, Ellis-style dynamic-programming beat
tracking, with a confidence readout that admits when material has no usable pulse), then
lets you carve the audio into clips. Drag to cut a region with edges that snap to beats,
cut a whole selection into bars with one button, click any clip to hear it, and export a
clip as a WAV loop. Selected words in the transcript lift straight over as clips, so a
spoken phrase becomes a loop in two clicks. Tempo detection wrong? Tap the tempo or pin
bar one and it re-tracks around your anchor.

MACHINE's PATTERN state is an eight-track step sequencer in the OP-XY lineage: assign
clips to tracks (the samples are copied in, like loading a pad), program 64 steps across
four pages, set per-track lengths for polymeter, swing the grid MPC-style, fire tracks
live from keys 1 through 8, and mix with per-track gain, pan, mute, and solo. Live
playback and offline render come from one event compiler, so FREEZE prints exactly what
you heard: the loop becomes the new bench source while the machine keeps its pattern,
and you can slice the freeze and go around again. Parameter locks, step components, and
punch-in effects are next; the plan lives in docs/VISION.md.

## The bench remembers

Close the tab mid-session and nothing is lost. Yellowjacket autosaves the working state
to the browser's origin-private file system about a second after every change: the
source audio as loaded, the transcript, clips, the rack, every scene and step in the
machine, the repair stack, and the tempo pins. Reopening the page offers the last
session by name, with RESUME and DISCARD buttons; nothing loads until you choose. The
saved files never leave the machine, which is the same promise the rest of the tool
makes.

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

## Running it locally

```bash
git clone https://github.com/ihelfrich/yellowjacket && cd yellowjacket && python3 -m http.server 8080
```

Then open `http://localhost:8080`. A server is required (module workers don't run from
`file://`), but any static server works.

MIT license. Built by [Ian Helfrich](https://ianhelfrich.com).
