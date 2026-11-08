# Precision spectrogram validation — November 7, 2026

SIGNAL now has an expandable precision inspector. It reads the same current
mono mix as the overview and recomputes the selected time interval in a worker.
The original overview and its editing/repair gestures remain intact. Selected
frequency bins remain Float32 dB values; only the displayed image uses color.
Rendering retains peaks within each display pixel to avoid dropping narrow
features when multiple bins/windows share a pixel. Cursors report individual
bins, not the pooled pixel maximum.

Controls: time bounds, 2,048–131,072 sample FFT windows, frequency bounds,
linear/log frequency axis, dB floor/ceiling, copy overview selection, cancellation,
and A/B cursors by click or numeric input. CSV contains both cursors and analysis
parameters. Settings and measurements are session-only and reset with new signal
data; changing analysis bounds invalidates old results. Display-only changes do
not recompute audio. Full Hann windows overlap 75%; times are their centres.

Validation:

- `node test/precision-regressions.mjs`: calibrated tone level, separation of
  100/103 Hz tones, a faint descending chirp below -90 dBFS, nonzero time origin,
  silence, one-window passages and explicit invalid/budget refusals passed.
- `node test/precision-recording.mjs`: first 30 seconds of the existing Berlin
  shelf recording, downmixed to mono at 48 kHz. Two measured bin levels agreed
  with an independent direct DFT (independent window construction) within
  0.000002 dB. This checks implementation agreement, not environmental accuracy.
- `test/precision-browser.mjs`: actual app file intake, module worker, cursor
  readings, CSV download, log axis, contrast, stale-result invalidation, short
  selection refusal, cancellation and inspector width at 390 pixels passed in
  Chromium. No page exceptions. Screenshot inspection covers the desktop panel;
  the existing mobile fixed chrome can obscure tall screenshots.

Example settings: 0–30 seconds, 20–500 Hz, 65,536 samples. At 48 kHz this gives
0.732421875 Hz bins, 1.365333 s windows, 0.341333 s steps, 84 full windows.
The image shows low-frequency urban energy and changing spectral texture.
No trace has been attributed to an aircraft. Cursors in the example are
arbitrary measurement probes, not detected events.

The source publishes coordinates for Prenzlauerberg Volkspark, Berlin. Those
coordinates are not independently surveyed here. The title says 8pm while the
structured time says 08:17; no precise-time matching is justified. Source,
licence, reproducible download/decode commands, SHA-256, numerical receipts and
screenshots are under `test/fixtures/spectrogram/`.

Limits: mono cancellation and applied repairs can remove features; MP3 source
is lossy. Bin spacing is not uncertainty. A long window smears fast changes.
Tone-normalized magnitudes are not noise power density. No phase estimator,
automatic ridge tracking, flight-data matcher, location solver or stereo channel
selector was added. Oversized passages are refused rather than decimated; a
shorter passage can be analyzed at full requested resolution. The public release is isolated from unrelated local changes. ArtCraft’s bundled
copy is not updated by this release.

Full existing `npm test` passed after regenerating the static import/preload graph,
including the nine audit regression groups and playback/field suites. The new
precision regression script is also included in `npm test`.

Release check: invalidation now runs on input rather than field blur. The older
live layout exposed a blur-time resize that could consume the next Analyze
click; the browser edit-and-submit regression passes after this change.
