# Lab scripts

Models and measurements behind docs/lab/2026-09-03-playback-rate-decision.md.
They model Chromium's and WebKit's context→device resamplers and measure the
repo's Kaiser resampler with E12's method (Hann 65 536-point FFT, tones on bin
centres, worst component outside ±6 bins). They are not suite cases: run one
with `node test/lab/<name>.mjs`.
