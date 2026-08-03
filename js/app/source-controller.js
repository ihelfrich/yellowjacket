// Source controller: file/URL/drop intake, decode, spectrogram + beatmap analysis
// pipeline, generation tokens. Moved from main.js in the STRUCTURE refactor.

import { buildPeakPyramid } from '../render/peaks.js';

export function initSourceController(ctx) {
  const { store, engine, views, $, COPY, status, statusFault, fmtTime } = ctx;
  const { waveMini, waveMain, spec, sliceView } = views;
  const P = store.project;
  const R = store.runtime;

  // ---------- file loading ----------
  async function openFile(file) {
    status(COPY.decoding, true);
    let ab;
    try {
      ab = await file.arrayBuffer();
    } catch (e) {
      statusFault(COPY.decodeFail);
      return;
    }
    await loadArrayBuffer(ab, file.name);
  }

  // anchors rides through to the deferred analysis run: RESTORE passes the saved
  // bpm/bar-one pins so the beatmap comes back as it was, not re-guessed.
  async function loadArrayBuffer(ab, name, anchors = null) {
    status(COPY.decoding, true);
    // Keep the encoded bytes for persistence and RESTORE: decodeAudioData detaches
    // its argument in some engines, so the copy must happen before decode.
    const sourceBytes = ab.slice(0);
    try {
      await engine.load(ab);
    } catch (e) {
      statusFault(COPY.decodeFail);
      return;
    }
    $('ripHelp').hidden = true;
    store.update('source', (p, r) => {
      r.generation++;
      p.fileName = name;
      p.words = null;
      p.clips.length = 0;   // in place: references are held elsewhere
      r.buffer = engine.buffer;
      r.mono = engine.mono;
      r.sampleRate = engine.sampleRate;
      r.renderedBuffer = null;
      r.analysis = null;
      r.sourceBytes = sourceBytes;
      // One pyramid, shared by every view that draws this source.
      r.peaks = buildPeakPyramid(r.mono);
    });

    $('dropZone').classList.add('is-hidden');
    $('roDur').textContent = fmtTime(engine.duration);
    $('roTime').textContent = fmtTime(0);

    waveMini.setBuffer(R.mono, R.sampleRate, R.peaks);
    waveMain.setBuffer(R.mono, R.sampleRate, R.peaks);

    ctx.api.benchReset();
    ctx.api.machineReset();
    if (ctx.api.repairReset) ctx.api.repairReset();

    status(COPY.loaded);
    ctx.api.statusRight();

    $('specNote').textContent = COPY.computingSpec;
    const gen = R.generation;
    spec.compute(R.mono, R.sampleRate).then(() => {
      $('specNote').textContent = COPY.specReady;
      spec.render();
    }).catch(() => {
      $('specNote').textContent = 'Spectrogram fault — see console.';
    }).finally(() => {
      // Analysis waits for the spectrogram: both are CPU-heavy, sequential is kinder.
      if (gen === R.generation) runAnalysis(anchors);
    });
  }

  // ---------- beatmap analysis worker ----------
  let analysisWorker = null;
  let analysisBusy = false;
  // Per-run state the persistent onmessage handler reads. A closure would freeze the
  // first run's values forever and silently drop every later file's results.
  // Keyed by job id, not a single slot. The worker's replies now carry the job
  // they answer, so a result is matched to the request that produced it and
  // installed with THAT request's anchors. The single slot could only ask
  // whether the newest generation was still newest, which is trivially true
  // while holding the previous file's beatmap.
  let analysisSeq = 0;
  const analysisRuns = new Map();

  function analysisAnchors() {
    const a = R.analysis && R.analysis.anchors;
    return { bpm: a && a.bpm != null ? a.bpm : null, barOneTime: a && a.barOneTime != null ? a.barOneTime : null };
  }

  function runAnalysis(anchors = null, withMono = true) {
    if (!R.mono) return;
    const job = ++analysisSeq;
    const run = { gen: R.generation, anchors: anchors || analysisAnchors(), withMono };
    analysisRuns.set(job, run);
    if (!analysisWorker) {
      analysisWorker = new Worker(new URL('../../workers/analysis-worker.js', import.meta.url), { type: 'module' });
      analysisWorker.onmessage = (e) => {
        const msg = e.data || {};
        const run = analysisRuns.get(msg.job);
        if (!run) return;
        if (msg.type !== 'progress') analysisRuns.delete(msg.job);
        // The generation this job was STARTED for, against the one loaded now.
        if (run.gen !== R.generation) return;
        if (msg.type === 'progress') {
          if (analysisBusy) status(COPY.mapping + ' · ' + Math.round(msg.pct) + '%', true);
        } else if (msg.type === 'done') {
          analysisBusy = false;
          // Through the store so autosave sees it: anchors live in the snapshot.
          store.update('analysis', (p, r) => {
            r.analysis = { ...msg.analysis, anchors: run.anchors };
          });
          ctx.api.analysisDone(R.analysis);
          status(COPY.loaded);
        } else if (msg.type === 'error') {
          // Cache miss on an anchors-only rerun: resend with audio. Anything else is a fault.
          if (!run.withMono) { runAnalysis(run.anchors, true); return; }
          analysisBusy = false;
          ctx.api.analysisFault(msg.message || 'unknown');
        }
      };
      analysisWorker.onerror = () => {
        analysisBusy = false;
        ctx.api.analysisFault('worker error');
      };
    }
    analysisBusy = true;
    ctx.api.analysisStarted();
    const payload = { type: 'analyze', job, sampleRate: R.sampleRate, anchors: run.anchors, generation: run.gen };
    if (withMono) {
      const copy = R.mono.slice();
      payload.mono = copy;
      analysisWorker.postMessage(payload, [copy.buffer]);
    } else {
      analysisWorker.postMessage(payload);
    }
  }

  // ---------- load from URL ----------
  // Hosts that never hand raw audio to a cross-origin page. Attempting the fetch would
  // only produce an opaque CORS error, so go straight to the local-rip help.
  const WALLED = /(^|\.)(youtube\.com|youtu\.be|soundcloud\.com|spotify\.com|music\.apple\.com|tidal\.com|deezer\.com|bandcamp\.com|mixcloud\.com|vimeo\.com|twitch\.tv|tiktok\.com|instagram\.com|x\.com|twitter\.com)$/i;
  const MAX_FETCH_BYTES = 250 * 1024 * 1024;

  function shellQuote(u) {
    return "'" + u.replace(/'/g, "'\\''") + "'";
  }

  // A watch link carrying list/start_radio params makes yt-dlp queue the whole
  // playlist (a YouTube Mix is 200+ items). Strip the freight, keep the video.
  function cleanRipUrl(u) {
    try {
      const c = new URL(u.href);
      for (const p of ['list', 'index', 'start_radio', 'pp', 'si', 'utm_source', 'utm_medium', 'utm_campaign']) {
        c.searchParams.delete(p);
      }
      return c.href;
    } catch (e) {
      return u.href;
    }
  }

  function showRipHelp(u, msg) {
    $('ripHelpMsg').textContent = msg;
    $('ripCmd').value = 'yt-dlp -x --audio-format wav --no-playlist ' + shellQuote(typeof u === 'string' ? u : cleanRipUrl(u));
    $('ripHelp').hidden = false;
  }

  async function loadFromUrl(raw) {
    const s = (raw || '').trim();
    if (!s) return;
    let u;
    try {
      u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s);
    } catch (e) {
      statusFault("That doesn't parse as a URL.");
      return;
    }
    if (!/^https?:$/.test(u.protocol)) {
      statusFault('Only http and https URLs load here.');
      return;
    }
    $('ripHelp').hidden = true;
    if (WALLED.test(u.hostname)) {
      showRipHelp(u, "That host won't hand audio to a web page. Rip it on your machine, then drop the file here:");
      return;
    }
    const btn = $('btnLoadUrl');
    btn.disabled = true;
    btn.classList.add('is-working');
    status(COPY.fetching, true);
    try {
      const resp = await fetch(u.href);
      if (!resp.ok) {
        statusFault('FETCH FAULT · HTTP ' + resp.status + ' from ' + u.hostname);
        return;
      }
      const len = Number(resp.headers.get('Content-Length')) || 0;
      if (len > MAX_FETCH_BYTES) {
        statusFault('That file is over 250 MB. Decoded, it would not fit in browser memory.');
        return;
      }
      const type = (resp.headers.get('Content-Type') || '').toLowerCase();
      if (type.includes('text/html')) {
        showRipHelp(u, 'That URL serves a page, not audio. If a track lives on it, rip it locally and drop the file:');
        return;
      }
      let ab;
      if (resp.body && resp.body.getReader) {
        const reader = resp.body.getReader();
        const parts = [];
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          got += value.length;
          if (got > MAX_FETCH_BYTES) {
            reader.cancel();
            statusFault('Stopped at 250 MB. That is more than this bench can decode.');
            return;
          }
          status(COPY.fetching + (len ? ' · ' + Math.round((100 * got) / len) + '%' : ' · ' + (got / 1048576).toFixed(1) + ' MB'), true);
        }
        const buf = new Uint8Array(got);
        let o = 0;
        for (const p of parts) { buf.set(p, o); o += p.length; }
        ab = buf.buffer;
      } else {
        ab = await resp.arrayBuffer();
      }
      const name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
      await loadArrayBuffer(ab, name);
    } catch (e) {
      // A TypeError here is almost always CORS: the host never opted its files in.
      showRipHelp(u, "That host refused a browser fetch (no CORS headers). It isn't you, and it isn't fixable from here. Rip it locally and drop the file:");
      statusFault('FETCH BLOCKED · ' + u.hostname);
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-working');
    }
  }

  // ---------- intake wiring ----------
  $('btnOpen').addEventListener('click', () => $('fileInput').click());
  $('btnOpen2').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    if (e.target.files[0]) openFile(e.target.files[0]);
    e.target.value = '';
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    $('dropZone').classList.remove('is-hidden');
    $('dropZone').classList.add('is-over');
  });
  $('dropZone').addEventListener('dragleave', (e) => {
    if (e.target === $('dropZone')) {
      $('dropZone').classList.remove('is-over');
      if (R.buffer) $('dropZone').classList.add('is-hidden');
    }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    $('dropZone').classList.remove('is-over');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) openFile(f);
    else if (R.buffer) $('dropZone').classList.add('is-hidden');
  });

  $('btnLoadUrl').addEventListener('click', () => loadFromUrl($('urlInput').value));
  $('urlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadFromUrl(e.target.value);
  });
  $('btnOpenUrl').addEventListener('click', () => {
    $('dropZone').classList.remove('is-hidden');
    $('urlInput').focus();
  });
  $('btnCopyRip').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('ripCmd').value);
    } catch (e) {
      $('ripCmd').select();
      document.execCommand('copy');
    }
    $('btnCopyRip').textContent = 'COPIED';
    setTimeout(() => { $('btnCopyRip').textContent = 'COPY'; }, 1200);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && R.buffer) $('dropZone').classList.add('is-hidden');
  });
  // ?url= prefills the field; fetching still takes a click. A page that auto-fetches
  // whatever the query string says is a page that can be pointed at anything.
  {
    const pre = new URLSearchParams(location.search).get('url');
    if (pre) $('urlInput').value = pre;
  }

  ctx.api.loadArrayBuffer = loadArrayBuffer;
  ctx.api.openFile = openFile;
  ctx.api.runAnalysis = runAnalysis;
}
