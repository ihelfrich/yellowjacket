# Hardening log

Two review rounds ran after the first working end-to-end build: a 12-agent
find-and-refute pass (4 seam reviewers, every surviving finding independently
re-verified against the code), and a bounded Codex 5.6 numerical review of the
splice and denoise math. 14 findings came back, 8 survived verification, plus 3
from the numerical review. All 9 distinct defects are fixed below; the two
review tracks also returned explicit clean bills on the crossfade indexing,
equal-power coefficients, OLA normalization, threshold math, box-blur
boundaries, progress accounting, SRT/VTT retiming, and the whole
transcript-UI/export pair.

## Fixed

- js/main.js — B-side seeks used the wrong timeline (high). Waveform,
  spectrogram, and transcript clicks passed original-timeline seconds to an
  engine playing the rendered (cut-spliced) buffer, landing late by the total
  cut duration before the click. All UI seeks now route through uiSeek(),
  which maps through editedTime() when BENCH is active.
- js/main.js — stale transcription could attach to a new file (medium).
  A job started on file A committed its words after file B loaded. Added a
  per-load generation counter; stale results are dropped.
- js/main.js — stale render could attach to a new file (medium). Same hole,
  same generation guard; the render result now commits only if the file that
  started it is still loaded.
- js/main.js — loading a second file left transcript buttons enabled with
  project.words = null; RESTORE ALL then threw an uncaught TypeError.
  openFile() now disables the seven transcript-dependent buttons and clears
  the filler/dead-air readouts.
- js/main.js — the A/B toggle survived a new file load stuck on BENCH with no
  render behind it, silently disabling cut-skipping during playback while the
  playhead still mapped through the cuts. openFile() now resets to ORIGINAL
  and hides the toggle.
- js/main.js — after a failed model switch, re-selecting the previous model
  skipped loadModel (the worker had already disposed its pipeline) and every
  transcribe attempt failed. The load gate now also checks
  transcriber.modelLoaded.
- js/dsp/chain.js — renderChain took the caller's effect order on faith.
  It now walks REGISTRY so rack order (and single application per id) is
  enforced regardless of the config array.
- js/dsp/chain.js — greedy left-to-right fade allocation could starve the
  second join of a sub-fade-length kept segment into a hard splice
  (audible click). Interior segments now split their length between their
  two joins.
- workers/denoise-worker.js — no leading STFT padding: Hann(0)=0 erased the
  first samples (an impulse at sample 0 vanished even at strength 0), and
  zero-padded tail frames skewed the noise profile toward silence. The signal
  is now reflect-padded by N_FFT-HOP on both ends and trimmed after
  overlap-add; strength 0 is verified sample-exact identity in-browser.

## Verified non-bugs worth knowing

- DynamicsCompressorNode processes at most two channels; buffers above stereo
  keep their channel count but the compressor stage may internally downmix.
- Whisper (.en models) rejects a language option; the worker strips it.
- transformers.js stays pinned at 3.7.1 until 4.3.0 ships the onnxruntime
  QDQ fusion fix (onnxruntime#28306, transformers.js#1707).
