// Yellowjacket service worker: versioned precache + cache-first runtime cache.
// Bump VERSION on every deploy — the activate handler drops every older yj- cache.
// Cross-origin requests (CDN transformers.js, HF model shards) are never intercepted;
// they manage their own caching. Scope-relative URLs keep this working under
// the /yellowjacket/ GitHub Pages subpath.
const VERSION = 'yj-v11';

const PRECACHE = [
  'js/app/persist.js',
  'js/app/persist-controller.js',
  'js/app/wire-controller.js',
  'js/export/op1patch.js',
  'js/midi/wire.js',
  'js/midi/clock.js',
  'js/render/spectrogram-gpu.js',
  'js/app/repair-panel.js',
  'js/app/repair-controller.js',
  'workers/repair-worker.js',
  'js/app/project-store.js',
  'js/app/bench-controller.js',
  'js/app/source-controller.js',
  'js/machine/controller.js',
  'js/render/peaks.js',
  './',
  './index.html',
  './css/yj.css',
  './assets/fonts/fonts.css',
  './assets/fonts/archivo-latin.woff2',
  './assets/fonts/plex-mono-400.woff2',
  './assets/fonts/plex-mono-600.woff2',
  './js/main.js',
  './js/audio-engine.js',
  './js/export.js',
  './js/fft.js',
  './js/meters.js',
  './js/spectrogram.js',
  './js/transcribe.js',
  './js/transcript-ui.js',
  './js/waveform.js',
  './js/analysis/harvest.js',
  './js/app/crate.js',
  './js/machine/crate-ui.js',
  './workers/harvest-worker.js',
  './js/analysis/beattrack.js',
  './js/analysis/onsets.js',
  './js/dsp/chain.js',
  './js/dsp/compressor.js',
  './js/dsp/deess.js',
  './js/dsp/dehum.js',
  './js/dsp/denoise.js',
  './js/dsp/eq.js',
  './js/dsp/gate.js',
  './js/dsp/limiter.js',
  './js/dsp/loudness.js',
  './js/dsp/loudnorm.js',
  './js/dsp/resample.js',
  './js/dsp/stretch.js',
  './js/dsp/space.js',
  './js/dsp/truepeak.js',
  './js/machine/cliprefs.js',
  './js/machine/compile.js',
  './js/machine/keybed.js',
  './js/machine/pattern-ui.js',
  './js/machine/song-ui.js',
  './js/machine/voice-ui.js',
  './js/machine/sequencer.js',
  './js/machine/slice-ui.js',
  './workers/analysis-worker.js',
  './workers/denoise-worker.js',
  './workers/loudness-worker.js',
  './workers/spectrogram-worker.js',
  './workers/whisper-worker.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        // ihelfrich.github.io hosts several projects on one origin:
        // only ever delete this app's own yj- caches.
        keys
          .filter((key) => key.startsWith('yj-') && key !== VERSION)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request, { ignoreSearch: request.mode === 'navigate' })
      .then((hit) => {
        if (hit) return hit;
        return fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      })
  );
});
