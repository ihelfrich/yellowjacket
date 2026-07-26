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

## The three benches

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

The **RACK** stacks the repair chain in signal order: high-pass, de-hum (mains fundamental
plus harmonics), spectral denoise, de-esser, four-band EQ, gate, compressor, lookahead
limiter, and loudness normalization to a LUFS target (-16 for podcasts is the default).
Every module has a power switch and a few honest parameters. Render, then A/B the result
against the original before exporting WAV at 16 or 24 bit.

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
peak is estimated by oversampling and is labeled as an estimate. The denoiser is the
spectral-gating recipe from the noisereduce literature (quietest-frames noise profile,
mean plus 1.5 sigma threshold per bin, mask smoothing at roughly 500 Hz by 50 ms) rather
than something improvised. Where a number is an approximation, the UI says so.

## Running it locally

```bash
git clone https://github.com/ihelfrich/yellowjacket && cd yellowjacket && python3 -m http.server 8080
```

Then open `http://localhost:8080`. A server is required (module workers don't run from
`file://`), but any static server works.

MIT license. Built by [Ian Helfrich](https://ianhelfrich.com).
