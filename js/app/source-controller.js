// Source controller: file/URL/drop intake, decode, spectrogram + beatmap analysis
// pipeline, generation tokens. Moved from main.js in the STRUCTURE refactor.

import { buildPeakPyramid } from '../render/peaks.js';
import { SourceHandle } from './source-handle.js';
import { fingerprintId, sha256Hex } from './fingerprint.js';

export const DEMO_TRACK = Object.freeze({
  path: 'assets/demo/zane-little-sparks.mp3',
  name: 'Sparks — Zane Little.mp3',
});

export function sourceReplacementNeedsConfirmation(runtime) {
  return !!(runtime && runtime.buffer);
}

/** What a ?url= link points at, for the panel: "FILE · HOST", or '' when it does not parse. */
export function linkLabel(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (_) { return ''; }
  if (!/^https?:$/.test(u.protocol)) return '';
  const segments = u.pathname.split('/').filter(Boolean);
  let name = segments.length ? segments[segments.length - 1] : u.hostname;
  try { name = decodeURIComponent(name); } catch (_) { /* keep it encoded */ }
  return `${name} · ${u.hostname}`.toUpperCase();
}

export function initSourceController(ctx) {
  const { store, engine, views, $, COPY, status, statusFault, fmtTime } = ctx;
  const { waveMini, waveMain, spec, sliceView } = views;
  const P = store.project;
  const R = store.runtime;

  function confirmSourceReplacement() {
    if (!sourceReplacementNeedsConfirmation(R)) return true;
    const name = P.fileName ? '“' + P.fileName + '”' : 'the current source';
    const ok = typeof window.confirm !== 'function' || window.confirm(
      'Replace ' + name + '?\n\n'
      + 'Its transcript, cuts, repairs, slices, and saved resume point will be replaced. '
      + 'Machine tracks and CRATE instruments are kept.'
    );
    if (!ok) {
      $('dropZone').classList.add('is-hidden');
      status('SOURCE KEPT');
    }
    return ok;
  }

  // ---------- file loading ----------
  async function openFile(file) {
    if (/\.yjkt$/i.test(file && file.name || '')) {
      if (ctx.api.importProjectFile) await ctx.api.importProjectFile(file);
      else statusFault('PROJECT OPEN FAULT · project loader is not ready');
      return;
    }
    if (/\.midi?$/i.test(file && file.name || '')) {
      if (ctx.api.importMidiFile) await ctx.api.importMidiFile(file);
      else statusFault('MIDI FAULT · the studio is not ready');
      return;
    }
    if (!confirmSourceReplacement()) return;
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

  async function loadDemo() {
    if (!confirmSourceReplacement()) return;
    const btn = $('btnLoadDemo');
    btn.disabled = true;
    btn.classList.add('is-working');
    status('LOADING DEMO', true);
    try {
      const resp = await fetch(new URL(DEMO_TRACK.path, document.baseURI));
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      await loadArrayBuffer(await resp.arrayBuffer(), DEMO_TRACK.name);
    } catch (e) {
      statusFault('DEMO FAULT · reload the page or pick your own audio');
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-working');
    }
  }

  // anchors rides through to the deferred analysis run: RESTORE passes the saved
  // bpm/bar-one pins so the beatmap comes back as it was, not re-guessed.
  async function loadArrayBuffer(ab, name, anchors = null) {
    status(COPY.decoding, true);
    // Keep the encoded bytes for persistence and RESTORE: decodeAudioData detaches
    // its argument in some engines, so the copy must happen before decode.
    const sourceBytes = ab.slice(0);
    let sourceHash = null;
    try {
      sourceHash = fingerprintId(await sha256Hex(sourceBytes));
    } catch (error) { /* handled by the identity fault below */ }
    if (!sourceHash) {
      statusFault('SOURCE IDENTITY FAULT · SHA-256 IS REQUIRED FOR SEMANTIC LINEAGE');
      return;
    }
    try {
      await engine.load(ab, { fallback: () => sourceBytes.slice(0) });
    } catch (e) {
      if (e && e.code === 'over-budget') {
        statusFault("WON'T LOAD · " + String(e.message || '').toUpperCase() + ' · TRY A SHORTER FILE OR A LOWER RATE');
        return;
      }
      statusFault(COPY.decodeFail);
      return;
    }
    $('ripHelp').hidden = true;
    store.update('source', (p, r) => {
      r.generation++;
      p.fileName = name;
      p.words = null;
      if (p.transcript && Array.isArray(p.transcript.gapCuts)) p.transcript.gapCuts.length = 0;
      p.clips.length = 0;   // in place: references are held elsewhere
      // Immutable armed plans survive a source swap and become visibly offline.
      // Only the controller-local active draft is cleared.
      if (p.loom) {
        p.loom.plan = null;
        p.loom.activePlanId = null;
      }
      r.buffer = engine.buffer;
      r.mono = engine.mono;
      r.sampleRate = engine.sampleRate;
      r.renderedBuffer = null;
      r.analysis = null;
      r.sourceBytes = new SourceHandle(sourceBytes, { hash: sourceHash, generation: r.generation });
      r.sourceHash = sourceHash;
      // One pyramid, shared by every view that draws this source.
      r.peaks = buildPeakPyramid(r.mono);
    });
    // A new source is a new starting point: the old stack's docs (and the
    // machine-sample references they hold) are not something to undo into.
    if (typeof store.clearHistory === 'function') store.clearHistory();

    $('dropZone').classList.add('is-hidden');
    $('resumePanel').hidden = true;
    $('roDur').textContent = fmtTime(engine.duration);
    $('roTime').textContent = fmtTime(0);

    waveMini.setBuffer(R.mono, R.sampleRate, R.peaks);
    waveMain.setBuffer(R.mono, R.sampleRate, R.peaks);

    ctx.api.benchReset();
    ctx.api.machineReset();
    if (ctx.api.repairReset) ctx.api.repairReset();

    const report = engine.decodeReport;
    const kHz = (hz) => (hz % 1000 === 0 ? hz / 1000 : (hz / 1000).toFixed(1)) + ' kHz';
    const heavy = report && report.overBudget && !report.downgraded && report.reason
      ? ' · ' + report.reason.toUpperCase() : '';
    const T = engine.transport;
    const tRep = engine.transportReport;
    if (tRep && tRep.refused) {
      statusFault('LOADED AT ' + kHz(report.decodedRate) + ' · THE BROWSER REFUSED A ' + kHz(tRep.requested)
        + ' TRANSPORT · PLAYBACK INTERPOLATES ON THE ' + kHz(tRep.got) + ' DEVICE');
      ctx.api.statusRight();
      return;
    }
    const bench = T && !T.shared ? ' · BENCH AT ' + kHz(T.rate) + ' → ' + kHz(engine.deviceRate) + ' SINC' : '';
    if (report && report.downgraded && report.reason) {
      status('LOADED AT ' + kHz(report.decodedRate) + ' · ' + report.reason.toUpperCase(), !!heavy);
    } else if (report && report.upsampled) {
      // Only a failed native-rate decode reaches here now; say what happened.
      status('LOADED · ' + kHz(report.nativeRate) + ' SOURCE, DECODED AT '
        + kHz(report.decodedRate) + ' · ' + String(report.reason || '').toUpperCase());
    } else if (report && report.nativeRate && report.decodedRate === report.nativeRate) {
      status('LOADED AT ' + kHz(report.decodedRate) + ' · ITS OWN RATE' + bench + heavy, !!heavy);
    } else {
      status(COPY.loaded + heavy, !!heavy);
    }
    ctx.api.statusRight();

    $('specNote').textContent = COPY.computingSpec;
    const gen = R.generation;
    const specJob = ctx.api.beginJob ? ctx.api.beginJob('SPECTROGRAM', 'signal', 'slice') : null;
    spec.compute(R.mono, R.sampleRate).then(() => {
      $('specNote').textContent = COPY.specReady;
      spec.render();
    }).catch(() => {
      $('specNote').textContent = 'Spectrogram fault — see console.';
    }).finally(() => {
      if (specJob) specJob.end();
      // Analysis waits for the spectrogram: both are CPU-heavy, sequential is kinder.
      if (gen === R.generation) runAnalysis(anchors);
    });
  }

  // Clear only the source-facing half of the bench. Machine instruments are
  // document assets and survive until the caller applies a replacement
  // snapshot; this makes source-free portable projects possible without
  // tearing down the AudioContext that SYNTH and CRATE use.
  function clearSource() {
    if (engine.clear) engine.clear();
    store.update('source-clear', (p, r) => {
      r.generation++;
      p.fileName = null;
      p.words = null;
      if (p.transcript && Array.isArray(p.transcript.gapCuts)) p.transcript.gapCuts.length = 0;
      p.clips.length = 0;
      if (p.loom) {
        p.loom.plan = null;
        p.loom.activePlanId = null;
      }
      r.buffer = null;
      r.mono = null;
      r.sampleRate = 0;
      r.renderedBuffer = null;
      r.analysis = null;
      r.sourceBytes = null;
      r.sourceHash = null;
      r.peaks = null;
    });
    $('roDur').textContent = fmtTime(0);
    $('roTime').textContent = fmtTime(0);
    waveMini.setBuffer(null, 0, null);
    waveMain.setBuffer(null, 0, null);
    spec.compute(null, 0).catch(() => {});
    if (ctx.api.benchClear) ctx.api.benchClear();
    ctx.api.machineReset();
    if (ctx.api.repairReset) ctx.api.repairReset();
    ctx.api.statusRight();
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

  let analysisJob = null;   // the registry handle for the running beatmap
  function endAnalysisJob() { if (analysisJob) { analysisJob.end(); analysisJob = null; } }
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
          if (analysisJob) analysisJob.note(msg.pct);
        } else if (msg.type === 'done') {
          analysisBusy = false;
          endAnalysisJob();
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
          endAnalysisJob();
          ctx.api.analysisFault(msg.message || 'unknown');
        }
      };
      analysisWorker.onerror = () => {
        analysisBusy = false;
        endAnalysisJob();
        ctx.api.analysisFault('worker error');
      };
    }
    analysisBusy = true;
    endAnalysisJob();
    analysisJob = ctx.api.beginJob ? ctx.api.beginJob('MAPPING BEATS', 'machine', 'slice') : null;
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

  // displayName overrides the filename derived from the URL path — the FIELD
  // library passes a human name for archive files named things like
  // 2403220817rushhourroar….mp3.
  // `range` = {start, end} inclusive byte offsets: fetch only that window of
  // a long capture (archive.org honours Range with CORS). The decoded window
  // is an ordinary source; its name says where it came from.
  async function loadFromUrl(raw, displayName, { range = null } = {}) {
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
    if (!confirmSourceReplacement()) return;
    const btn = $('btnLoadUrl');
    btn.disabled = true;
    btn.classList.add('is-working');
    status(COPY.fetching, true);
    try {
      const init = range ? { headers: { Range: 'bytes=' + range.start + '-' + range.end } } : undefined;
      const resp = await fetch(u.href, init);
      if (!resp.ok) {
        statusFault('FETCH FAULT · HTTP ' + resp.status + ' from ' + u.hostname);
        return;
      }
      if (range && resp.status !== 206) {
        statusFault('WINDOW REFUSED · ' + u.hostname + ' sent the whole file instead of a range');
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
        parts.length = 0;   // the chunks are one full encoded copy; drop them before decode
        ab = buf.buffer;
      } else {
        ab = await resp.arrayBuffer();
      }
      const name = displayName || decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
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
  $('btnLoadDemo').addEventListener('click', loadDemo);
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
  // ?url= prefills the field and raises a panel at the top of the drop zone
  // naming the file and its host, with one button; fetching still takes that
  // click. A page that auto-fetches whatever the query string says is a page
  // that can be pointed at anything. The LOAD URL button reads as primary
  // whenever the field holds something to load.
  const markUrlButton = () => $('btnLoadUrl').classList.toggle('yj-btn-primary', !!$('urlInput').value.trim());
  $('urlInput').addEventListener('input', markUrlButton);
  {
    const pre = new URLSearchParams(location.search).get('url');
    if (pre) {
      $('urlInput').value = pre;
      const label = linkLabel(pre);
      if (label) {
        $('linkInfo').textContent = 'A LINK BROUGHT YOU HERE · ' + label;
        $('linkPanel').hidden = false;
        $('btnLoadLink').addEventListener('click', () => loadFromUrl(pre));
        $('btnLoadLink').focus();
        // Focus alone scrolls the button to the nearest edge; the panel reads
        // whole when it sits mid-screen, after layout has settled.
        requestAnimationFrame(() => $('linkPanel').scrollIntoView({ block: 'center' }));
      }
    }
    markUrlButton();
  }

  ctx.api.loadArrayBuffer = loadArrayBuffer;
  ctx.api.loadFromUrl = loadFromUrl;
  ctx.api.clearSource = clearSource;
  ctx.api.openFile = openFile;
  ctx.api.runAnalysis = runAnalysis;
}
