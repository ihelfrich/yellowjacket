# Documented-location validation input

Source: https://archive.org/details/aporee_63516_73093
Creator: Peter Cusack. Source labels the recording Public Domain Mark 1.0.
Place: Prenzlauerberg Volkspark, Berlin, Germany; source coordinates
52.537607761925, 13.461569392697, elevation 76 m.
Structured recording date: 2024-03-22 08:17 Europe/Berlin. The item title says
“8pm”; that inconsistency is preserved, not silently resolved for flight matching.

This is the existing Yellowjacket shelf entry `berlin-dawn`. It is used to
validate inspection and measurements on real field audio at a published
location, not to identify an aircraft or infer coordinates from sound.

Reproduce from repository root (curl/ffmpeg required):

```sh
curl -fL --max-time 60 'https://archive.org/download/aporee_63516_73093/2403220817rushhourroarsenseofspacedistsongbirdsjaywdpgncrowsgrnwdpkredit.mp3' -o test/fixtures/spectrogram/berlin.mp3
ffmpeg -v error -i test/fixtures/spectrogram/berlin.mp3 -t 30 -ac 1 -c:a pcm_f32le test/fixtures/spectrogram/berlin-30s.wav
node test/precision-recording.mjs
```

Audio files are locally retained and gitignored. `recording-result.json` contains
the excerpt hash and independent direct-DFT comparisons. `browser-result.json`
records the Chromium checks; PNGs show the actual app. Mobile check covers
inspector width only: the existing app's fixed header/footer can obscure a tall
panel screenshot. It does not establish general mobile usability.

Browser test: serve repository on localhost:8773; run
`PLAYWRIGHT_ROOT=/path/to/existing/playwright/project node test/precision-browser.mjs`.
Tests use a fresh browser context, not the user's saved projects.
