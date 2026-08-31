// Yellowjacket service worker: versioned precache + cache-first runtime cache.
// Bump VERSION on every deploy — the activate handler drops every older yj- cache.
// Cross-origin requests (CDN transformers.js, HF model shards) are never intercepted;
// they manage their own caching. Scope-relative URLs keep this working under
// the /yellowjacket/ GitHub Pages subpath.
const VERSION = 'yj-v45';

const PRECACHE = [
  'js/app/persist.js',
  'js/app/project-bundle.js',
  'js/app/command-deck.js',
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
  'js/app/field-library.js',
  'js/dsp/native-rate.js',
  'js/analysis/soundscape.js',
  'js/midi/smf.js',
  'js/app/fingerprint.js',
  'js/machine/controller.js',
  'js/machine/drum-dsp.js',
  'js/machine/kits.js',
  'js/machine/kit-ui.js',
  'js/studio/model.js',
  'js/studio/engine.js',
  'js/studio/view.js',
  'js/studio/controller.js',
  'js/studio/midi.js',
  'js/studio/compile.js',
  'js/loom/identity.js',
  'js/loom/compile.js',
  'js/loom/capture.js',
  'js/loom/schedule.js',
  'js/loom/engine.js',
  'js/loom/view.js',
  'js/loom/controller.js',
  'js/performance/compile.js',
  'js/render/peaks.js',
  './',
  './index.html',
  './css/yj.css',
  './assets/fonts/fonts.css',
  './assets/fonts/archivo-latin.woff2',
  './assets/fonts/plex-mono-400.woff2',
  './assets/fonts/plex-mono-600.woff2',
  './assets/demo/zane-little-sparks.mp3',
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
  './js/machine/cliplist-ui.js',
  './js/machine/constellation-ui.js',
  './js/app/pipeline-ui.js',
  './js/machine/voicecurve-ui.js',
  './js/machine/synth.js',
  './js/machine/synth-ui.js',
  './js/machine/pads-ui.js',
  './js/app/firstrun-ui.js',
  './js/analysis/modal.js',
  './js/machine/modal-ui.js',
  './js/analysis/constellation.js',
  './js/machine/voice-ui.js',
  './js/machine/sequencer.js',
  './js/machine/slice-ui.js',
  './workers/analysis-worker.js',
  './workers/denoise-worker.js',
  './workers/loudness-worker.js',
  './workers/spectrogram-worker.js',
  './workers/whisper-worker.js'
];

// Deliberately NO skipWaiting here, and no clients.claim below.
//
// The seven Workers are created lazily by `new Worker()` the first time a bench
// needs one, so they are fetched through whichever service worker controls the
// page at that moment — not the one that served the page's modules. Taking over
// an open tab would therefore hand a page running the previous build a worker
// from the new one, and the cache sweep in activate would delete the cache that
// page was still reading from. Yellowjacket holds an unsaved session with
// decoded audio in memory, so being reconfigured underneath yourself is the
// worst available outcome.
//
// Instead the new worker installs, precaches, and waits. The page notices it,
// offers a reload, and only then sends SKIP_WAITING. An update lands when the
// person says so, or on their next natural visit.

// cache:'reload' is load-bearing, not decoration. A plain addAll() issues
// ordinary fetches, which the browser is free to satisfy from its own HTTP
// cache — so a freshly deployed build can precache the PREVIOUS build's files
// and pin them under the new version key until someone bumps VERSION again.
// This was observed live: v37 shipped a corrected css/yj.css, a direct request
// returned the new file, and the page was served the superseded one from the
// v37 cache. Forcing the network on install is the only way the version key
// means what it says.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(
      PRECACHE.map((url) => new Request(url, { cache: 'reload' }))
    ))
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Reached only once every page from the previous version is gone, which is
// exactly when its cache is safe to drop.
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
