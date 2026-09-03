// Bench controller: transport, metering, transcription, transcript editing and
// exports, measurement, rack, render, A/B, WAV export. Moved from main.js in the
// STRUCTURE refactor; logic unchanged, state now scoped here or in the store.

import { MODELS } from '../transcribe.js';
import { REGISTRY, renderChain, spliceCuts } from '../dsp/chain.js';
import { encodeWavWithStats, exportWavStream, toSrt, toVtt, toTxt, download, editedTime } from '../export.js';
import { LOOM_TRANSCRIPT_MAX_WORDS } from '../loom/compile.js';
import { mixdownMono } from '../audio-engine.js';
import { buildPeakPyramid } from '../render/peaks.js';
import { ndsi, bandLevelDb } from '../analysis/soundscape.js';
import { speedFactorsFor, slowedBuffer, speedLabel, slowBand } from '../dsp/varispeed.js';
import { previewWindow, previewChain, previewView, sliceAudioBuffer, describePreview } from '../dsp/preview.js';
import { soundingSources, transportLabel, transportTitle, SHORT } from './transport.js';

export function initBenchController(ctx) {
  const { store, engine, meter, transcriber, sequencer, views, $, COPY, status, statusFault, fmtTime, fmtDb, setLed } = ctx;
  const { waveMini, waveMain, spec, transcript, sliceView } = views;
  const P = store.project;
  const R = store.runtime;

  let abState = 'a';           // 'a' original, 'b' rendered
  let beforeCache = null;      // {key, integrated}: source loudness per generation
  function releaseTranscriber(why) {
    if (!transcriber || typeof transcriber.dispose !== 'function') return;
    if (transcriber.dispose()) {
      currentModel = null;
      setLed('ledModel', 'off');
      $('modelState').textContent = COPY.modelIdle || 'MODEL RELEASED · RELOADS FROM CACHE ON THE NEXT TRANSCRIBE';
    }
    void why;
  }
  store.addEventListener('change', (e) => {
    const kind = e.detail && e.detail.kind;
    if (kind === 'source' || kind === 'source-clear') {
      releaseTranscriber(kind);
      // The engine's 'transport' and 'loaded' events fire before the runtime
      // holds the buffer; the store change is the first moment both are true.
      refreshConversion();
    }
  });
  let renderFresh = false;
  // Peaks for the rendered take, built once per render and reused by both A/B
  // sides so the blue ghost costs nothing on toggle. Null until a render exists.
  let renderedMono = null;
  let renderedPeaks = null;
  let speed = 1;               // 1, 2 or 4: play and print at 1/speed
  let aboveCache = { gen: -1, lo: 0, hi: 0, db: -Infinity };   // energy above hearing, per source
  let cuts = [];
  let meterHooked = false;
  let deviceLabel = '—';
  let currentModel = null;
  let liftRange = null;        // {i0, i1} from the last transcript range selection

  function selectedKeptWordCount(range = liftRange) {
    if (!range || !Array.isArray(P.words) || !P.words.length) return 0;
    const low = Math.max(0, Math.min(range.i0 | 0, range.i1 | 0));
    const high = Math.min(P.words.length - 1, Math.max(range.i0 | 0, range.i1 | 0));
    let count = 0;
    for (let index = low; index <= high; index++) {
      const word = P.words[index];
      if (word && !word.deleted && Number(word.end) > Number(word.start)) count++;
    }
    return count;
  }

  function refreshWeaveWordsButton() {
    const button = $('btnLift');
    if (!button) return;
    const count = selectedKeptWordCount();
    const tooLong = count > LOOM_TRANSCRIPT_MAX_WORDS;
    button.disabled = count === 0 || tooLong;
    button.textContent = tooLong
      ? 'MAX ' + LOOM_TRANSCRIPT_MAX_WORDS + ' WORDS'
      : count
      ? 'WEAVE ' + count + (count === 1 ? ' WORD' : ' WORDS') : 'WEAVE WORDS';
    button.title = tooLong
      ? 'Selection has ' + count + ' kept words; choose at most '
        + LOOM_TRANSCRIPT_MAX_WORDS + ' for one Semantic Take'
      : count
      ? 'Load ' + count + (count === 1 ? ' selected kept word' : ' selected kept words')
        + ' as traceable source material in LOOM'
      : 'Select kept words in the transcript, then load them into LOOM';
  }

  // ---------- status right ----------
  function statusRight() {
    const bits = [];
    if (deviceLabel !== '—') bits.push(deviceLabel);
    if (currentModel) bits.push(currentModel.toUpperCase().replace(/^.*\//, ''));
    if (R.buffer) bits.push((R.sampleRate / 1000).toFixed(1) + 'k');
    if (R.buffer) bits.push(fmtTime(R.buffer.duration).slice(0, 5));
    $('stRight').textContent = bits.length ? bits.join(' · ') : COPY.noFile;
  }

  // ---------- timeline mapping (B side plays the edited timeline) ----------
  function originalFromEdited(t) {
    for (const c of cuts) {
      if (c.start > t) break;
      t += c.end - c.start;
    }
    return t;
  }
  function activeCuts() {
    return abState === 'b' ? [] : cuts;
  }
  function uiSeek(t) {
    engine.seek(abState === 'b' ? editedTime(t, cuts) : t);
  }

  // ---------- transport ----------
  const { loomEngine, studioEngine, auditioner } = ctx;
  function sounding() {
    return soundingSources({
      bench: !!engine.playing,
      machine: !!sequencer.running,
      loom: !!(loomEngine && loomEngine.playing),
      studio: !!(studioEngine && studioEngine.running),
      audition: !!(auditioner && auditioner.playing),
    });
  }
  // Stop every source at once. Each engine's own stop is idempotent.
  function stopAll() {
    if (engine.playing) engine.pause();
    if (sequencer.running) sequencer.stop();
    if (loomEngine && loomEngine.playing) loomEngine.stop();
    if (studioEngine && studioEngine.running) studioEngine.stop();
    if (auditioner && auditioner.playing) auditioner.stop();
    refreshTransport();
  }
  // The header button and Space: stop whatever is sounding; otherwise play
  // the bench. One transport owns the output at a time.
  function togglePlay() {
    if (sounding().length) { stopAll(); return; }
    if (!R.buffer) return;
    hookMeter();
    engine.play(activeCuts());
  }
  function refreshTransport() {
    const now = sounding();
    const btn = $('btnPlay');
    btn.textContent = transportLabel(now);
    btn.title = transportTitle(now, !!R.buffer);
    btn.classList.toggle('is-sounding', now.length > 0);
    // Yellow is always what you are hearing: name it beside the button.
    const ro = $('roSounding');
    if (ro) {
      ro.firstElementChild.classList.toggle('is-sounding', now.length > 0);
      $('soundingText').textContent = now.map((k) => SHORT[k] || k).join(' + ');
    }
  }
  engine.addEventListener('state', refreshTransport);
  sequencer.addEventListener('state', refreshTransport);
  if (loomEngine) loomEngine.addEventListener('state', refreshTransport);
  if (studioEngine) studioEngine.addEventListener('state', refreshTransport);
  ctx.api.stopAll = stopAll;
  ctx.api.sounding = sounding;
  // The bench reaching its end is not silence if the machine still runs.
  engine.addEventListener('ended', refreshTransport);
  engine.addEventListener('time', (e) => {
    let t = e.detail.t;
    if (abState === 'b') t = originalFromEdited(t);
    $('roTime').textContent = fmtTime(e.detail.t);
    waveMini.setPlayhead(t);
    waveMain.setPlayhead(t);
    if (views.waveRack) views.waveRack.setPlayhead(t);
    spec.setPlayhead(t);
    if (P.words) transcript.setActiveTime(t);
  });

  // Idempotent: hooks whichever contexts exist (the device context, and the
  // transport when it is a second context), so it can run on every play, on
  // every transport change, and when the machine or studio first runs.
  function hookMeter() {
    queueMicrotask(() => {
      if (engine.ctx && engine.master) meter.connect(engine.ctx, engine.master);
      const T = engine.transport;
      if (T && !T.shared) meter.connect(T.ctx, T.master);
      if (!meterHooked) {
        meter.start();
        meter.onclip = () => $('btnClip').classList.add('is-lit');
        meterHooked = true;
      }
    });
  }
  const kHzLabel = (hz) => (hz % 1000 === 0 ? hz / 1000 : (hz / 1000).toFixed(1)) + ' kHz';
  function refreshConversion() {
    const el = $('roConversion');
    if (!el) return;
    const T = engine.transport;
    const rep = engine.transportReport;
    el.classList.remove('is-fault');
    if (!R.buffer || !T) { el.textContent = ''; return; }
    if (rep && rep.refused) {
      el.textContent = 'DEVICE KEPT ' + kHzLabel(engine.deviceRate) + ' · PLAYBACK INTERPOLATES';
      el.classList.add('is-fault');
    } else if (T.shared) {
      el.textContent = 'MATCHED · NO CONVERSION';
    } else {
      el.textContent = 'TRANSPORT ' + kHzLabel(T.rate) + ' → DEVICE ' + kHzLabel(engine.deviceRate) + ' · CHROMIUM SINC';
    }
  }
  engine.addEventListener('transport', () => { hookMeter(); refreshConversion(); });
  engine.addEventListener('transportchange', (e) => {
    meter.drop(e.detail && e.detail.from);
    if (loomEngine && loomEngine.playing) loomEngine.stop();
    if (auditioner && auditioner.playing) auditioner.stop();
  });
  engine.addEventListener('loaded', refreshConversion);
  sequencer.addEventListener('state', (e) => { if (e.detail && e.detail.running) hookMeter(); });
  if (studioEngine) studioEngine.addEventListener('state', (e) => { if (e.detail && e.detail.playing) hookMeter(); });

  $('btnClip').addEventListener('click', () => $('btnClip').classList.remove('is-lit'));
  $('btnPlay').addEventListener('click', togglePlay);
  $('btnRtz').addEventListener('click', () => { engine.seek(0); $('roTime').textContent = fmtTime(0); });

  // ---------- views sync ----------
  for (const w of [waveMini, waveMain]) {
    w.addEventListener('seek', (e) => uiSeek(e.detail.t));
    w.addEventListener('view', (e) => {
      if (w === waveMain) spec.setView(e.detail.start, e.detail.end);
    });
  }
  spec.addEventListener('seek', (e) => uiSeek(e.detail.t));

  // ---------- transcription ----------
  const selModel = $('selModel');
  for (const m of MODELS) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    selModel.appendChild(opt);
  }
  selModel.value = 'onnx-community/whisper-base.en_timestamped';

  transcriber.addEventListener('progress', (e) => {
    const { stage, pct, note } = e.detail;
    const prog = $('progTrans');
    prog.hidden = false;
    prog.querySelector('.yj-progress-fill').style.width = pct + '%';
    prog.querySelector('.yj-progress-note').textContent = (note || stage).toUpperCase() + ' · ' + Math.round(pct) + '%';
    status((stage === 'download' ? COPY.modelLoading : COPY.transcribing) + ' · ' + Math.round(pct) + '%', true);
  });

  $('btnTranscribe').addEventListener('click', async () => {
    if (!R.mono) return;
    const btn = $('btnTranscribe');
    btn.disabled = true;
    btn.classList.add('is-working');
    const job = ctx.api.beginJob ? ctx.api.beginJob('TRANSCRIBE', 'transcript') : null;
    try {
      const gen = R.generation;
      const modelId = selModel.value;
      if (currentModel !== modelId || !transcriber.modelLoaded) {
        // The model LED reports the model, not the job: it blinks while the
        // model loads and holds green while the transcription runs (the
        // button stripes and the tab underbar show the job).
        setLed('ledModel', 'busy');
        $('modelState').textContent = COPY.modelLoading;
        await transcriber.loadModel(modelId);
        currentModel = modelId;
        deviceLabel = (transcriber.device || 'wasm').toUpperCase();
        $('modelState').textContent = COPY.modelReady + ' · ' + deviceLabel;
      }
      setLed('ledModel', 'on');
      const words = await transcriber.transcribe(R.mono, R.sampleRate);
      if (gen !== R.generation) return; // another file loaded mid-job; drop the stale result
      store.update('words', (p) => {
        p.words = words;
        if (p.transcript && Array.isArray(p.transcript.gapCuts)) {
          p.transcript.gapCuts.length = words.length;
          p.transcript.gapCuts.fill(false);
        }
      });
      $('transcriptHint').hidden = true;
      transcript.setWords(words, undefined, P.transcript && P.transcript.gapCuts);
      sliceView.setWords(words);
      liftRange = null;
      refreshWeaveWordsButton();
      onEdited();
      for (const id of ['btnCutFillers', 'btnCutDeadAir', 'btnRestoreAll', 'btnExpTxt', 'btnExpSrt', 'btnExpVtt', 'btnExpJson']) $(id).disabled = false;
      const fillers = words.filter((w) => w.filler).length;
      $('roFillers').textContent = fillers + ' FOUND';
      status(COPY.loaded);
    } catch (e) {
      setLed('ledModel', 'fault');
      $('modelState').textContent = COPY.transcribeFail;
      statusFault(COPY.transcribeFail + ' — ' + (e.message || e));
    } finally {
      // The model leaves memory with the job; the next press reloads it from
      // the browser cache in seconds. Holding 206–586 MB between jobs was
      // the ledger's largest single allocation.
      releaseTranscriber('job done');
      if (job) job.end();
      btn.disabled = false;
      btn.classList.remove('is-working');
      $('progTrans').hidden = true;
      statusRight();
    }
  });

  // ---------- transcript editing ----------
  transcript.addEventListener('wordclick', (e) => uiSeek(e.detail.t));
  transcript.addEventListener('beforeedit', () => {
    // The view mutates shared document arrays immediately after this intent.
    // Snapshot here so global undo and debounced autosave see the same edit.
    store.update('transcript-edit', () => {});
  });
  transcript.addEventListener('edited', onEdited);
  transcript.addEventListener('selectrange', (e) => {
    liftRange = Number.isInteger(e.detail.i0) && Number.isInteger(e.detail.i1)
      ? { i0: e.detail.i0, i1: e.detail.i1 } : null;
    refreshWeaveWordsButton();
  });

  function onEdited() {
    cuts = transcript.getCuts();
    waveMini.setCuts(cuts);
    waveMain.setCuts(cuts);
    updateCutReadout();
    refreshWeaveWordsButton();
    if (R.renderedBuffer) {
      renderFresh = false;
      setRenderState(COPY.renderStale, 'stale');
    }
  }

  function updateCutReadout() {
    if (!cuts.length) {
      $('roCutTotal').textContent = COPY.noCuts;
      return;
    }
    const total = cuts.reduce((a, c) => a + (c.end - c.start), 0);
    $('roCutTotal').textContent = total.toFixed(1) + 's CUT · ' + cuts.length + ' REGIONS';
  }

  $('btnCutFillers').addEventListener('click', () => {
    const n = transcript.markFillersDeleted();
    $('roFillers').textContent = (typeof n === 'number' ? n : P.words.filter((w) => w.filler).length) + ' CUT';
    onEdited();
  });
  $('rngGap').addEventListener('input', () => {
    $('valGap').textContent = Number($('rngGap').value).toFixed(1) + 's';
  });
  $('btnCutDeadAir').addEventListener('click', () => {
    const n = transcript.markDeadAir(Number($('rngGap').value));
    $('roDeadAir').textContent = n + ' CUT';
    onEdited();
  });
  $('btnRestoreAll').addEventListener('click', () => {
    transcript.restoreAll ? transcript.restoreAll() : (P.words.forEach((w) => (w.deleted = false)), transcript.setWords(P.words));
    $('roFillers').textContent = P.words.filter((w) => w.filler).length + ' FOUND';
    $('roDeadAir').textContent = '—';
    onEdited();
  });

  // ---------- transcript export ----------
  function transcriptFilename(ext) {
    return (P.fileName || 'transcript').replace(/\.[^.]+$/, '') + '.' + ext;
  }
  $('btnExpTxt').addEventListener('click', () => download(toTxt(P.words, { skipDeleted: true }), transcriptFilename('txt'), 'text/plain'));
  $('btnExpSrt').addEventListener('click', () => download(toSrt(P.words, { skipDeleted: true, cuts }), transcriptFilename('srt'), 'text/plain'));
  $('btnExpVtt').addEventListener('click', () => download(toVtt(P.words, { skipDeleted: true, cuts }), transcriptFilename('vtt'), 'text/vtt'));
  $('btnExpJson').addEventListener('click', () => download(JSON.stringify({ file: P.fileName, words: P.words }, null, 2), transcriptFilename('json'), 'application/json'));

  // ---------- measurement ----------
  // Off the main thread: the worker gets copies (transferred), the page stays live.
  let loudnessWorker = null;
  let measureSeq = 0;
  const measureJobs = new Map();   // job id -> {resolve, reject, onPct}
  // The worker keeps the transferred channel copies until its own next GC;
  // with no job pending it is cheaper to let the isolate go (~100 ms spawn).
  function retireLoudnessWorker() {
    if (measureJobs.size || !loudnessWorker) return;
    try { loudnessWorker.terminate(); } catch (e) { /* already gone */ }
    loudnessWorker = null;
  }
  function measureViaWorker(buf, onPct) {
    if (!loudnessWorker) {
      loudnessWorker = new Worker(new URL('../../workers/loudness-worker.js', import.meta.url), { type: 'module' });
    }
    // One handler for the life of the worker, dispatching by job id. Replacing
    // onmessage per call meant MEASURE during RENDER stole RENDER's reply: the
    // newest handler resolved with the older job's numbers, and the older
    // promise, having lost its only handler, never settled. RENDER then stayed
    // disabled with its progress bar up until the page was reloaded.
    if (!loudnessWorker.onmessage) {
      loudnessWorker.onmessage = (e) => {
        const msg = e.data || {};
        const job = measureJobs.get(msg.job);
        if (!job) return;   // a job whose caller has already gone away
        if (msg.type === 'progress') { if (job.onPct) job.onPct(msg.pct); }
        else if (msg.type === 'done') { measureJobs.delete(msg.job); job.resolve(msg.result); retireLoudnessWorker(); }
        else if (msg.type === 'error') {
          measureJobs.delete(msg.job);
          job.reject(new Error(msg.message));
          retireLoudnessWorker();
        }
      };
    }
    const seq = ++measureSeq;
    return new Promise((resolve, reject) => {
      measureJobs.set(seq, { resolve, reject, onPct });
      const channels = [];
      const transfers = [];
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const copy = buf.getChannelData(c).slice();
        channels.push(copy);
        transfers.push(copy.buffer);
      }
      loudnessWorker.postMessage({ type: 'measure', job: seq, channels, sampleRate: buf.sampleRate }, transfers);
    });
  }

  $('btnMeasure').addEventListener('click', async () => {
    const buf = abState === 'b' && R.renderedBuffer ? R.renderedBuffer : R.buffer;
    if (!buf) return;
    status(COPY.measuring, true);
    const m = await measureViaWorker(buf, (pct) => status(COPY.measuring + ' ' + Math.round(pct) + '%', true));
    $('mLufsI').textContent = fmtDb(m.integrated, ' LUFS');
    $('mLufsS').textContent = fmtDb(m.shortTermMax, ' LUFS');
    $('mPeak').textContent = fmtDb(m.samplePeakDb, ' dBFS');
    $('mTruePeak').textContent = fmtDb(m.truePeakDb, ' dBTP');
    $('mRms').textContent = fmtDb(m.rmsDb, ' dB');
    $('mCrest').textContent = fmtDb(m.crestDb, ' dB');
    $('mDc').textContent = (m.dcOffset >= 0 ? '+' : '') + m.dcOffset.toFixed(5);
    const clipEl = $('mClip');
    clipEl.textContent = m.clippedSamples + ' (' + m.clippedPct.toFixed(2) + '%)';
    clipEl.classList.toggle('is-fault', m.clippedSamples > 0);
    showSoundscape(abState === 'b' && renderedMono ? renderedMono : R.mono, R.sampleRate);
    status(COPY.measured + (abState === 'b' ? ' · BENCH' : ' · ORIGINAL'));
  });

  // Split the measured audio between the band engines occupy and the band
  // voices occupy. Blue is biophony, yellow anthrophony — the same colour
  // contract as the waveform ghost, so blue always means "the other thing".
  function showSoundscape(mono, sampleRate) {
    const host = $('soundscape');
    if (!host) return;
    const r = ndsi(mono, sampleRate);
    const total = r.biophony + r.anthrophony;
    if (!total) { host.hidden = true; return; }
    host.hidden = false;
    const bioPct = (r.biophony / total) * 100;
    $('ndsiBio').style.width = bioPct.toFixed(1) + '%';
    $('ndsiAnthro').style.width = (100 - bioPct).toFixed(1) + '%';
    $('ndsiValue').textContent = 'NDSI ' + (r.ndsi >= 0 ? '+' : '') + r.ndsi.toFixed(2);
    $('ndsiBar').setAttribute('aria-label',
      Math.round(bioPct) + '% voice band, ' + Math.round(100 - bioPct) + '% machine band');
    $('ndsiNote').textContent = r.bandLimited
      ? 'This rate stops below 11 kHz, so the voice band is clipped — not comparable with a 48 kHz reading.'
      : 'Measures the recording, not the ecosystem.';
  }

  // ---------- rack ----------
  function buildRack() {
    const host = $('rackHost');
    host.innerHTML = '';
    REGISTRY.forEach((desc, i) => {
      const cfg = P.chain.find((c) => c.id === desc.id);
      const mod = document.createElement('div');
      mod.className = 'yj-panel yj-mod' + (cfg.on ? '' : ' is-off');
      // The silkscreen prints the one fact only the rack knows: the position
      // in the signal path (order is part of the sound — chain.js).
      mod.dataset.label = String(i + 1).padStart(2, '0');

      const head = document.createElement('div');
      head.className = 'yj-mod-head';
      const power = document.createElement('button');
      power.className = 'yj-mod-power' + (cfg.on ? ' is-on' : '');
      power.title = 'Power';
      power.setAttribute('aria-pressed', String(!!cfg.on));
      const title = document.createElement('span');
      title.className = 'yj-mod-title';
      title.textContent = desc.title;
      const tag = document.createElement('span');
      tag.className = 'yj-mod-tag';
      tag.textContent = desc.tagline;
      head.append(power, title, tag);
      mod.appendChild(head);

      const params = document.createElement('div');
      params.className = 'yj-mod-params';
      for (const p of desc.params) {
        const row = document.createElement('label');
        row.className = 'yj-param';
        const lab = document.createElement('span');
        lab.className = 'yj-param-label';
        lab.textContent = p.label;
        const rng = document.createElement('input');
        rng.type = 'range';
        rng.min = p.min; rng.max = p.max; rng.step = p.step;
        rng.value = cfg.params[p.key];
        const val = document.createElement('span');
        val.className = 'yj-param-val';
        const decimals = p.step >= 1 ? 0 : p.step >= 0.1 ? 1 : p.step >= 0.01 ? 2 : 3;
        const show = () => { val.textContent = Number(rng.value).toFixed(decimals) + (p.unit || ''); };
        show();
        rng.addEventListener('input', () => {
          store.update('chain', () => { cfg.params[p.key] = Number(rng.value); });
          show();
          markStale();
        });
        row.append(lab, rng, val);
        params.appendChild(row);
      }
      mod.appendChild(params);

      power.addEventListener('click', () => {
        store.update('chain', () => { cfg.on = !cfg.on; });
        power.classList.toggle('is-on', cfg.on);
        power.setAttribute('aria-pressed', String(!!cfg.on));
        mod.classList.toggle('is-off', !cfg.on);
        markStale();
      });
      host.appendChild(mod);
    });
  }

  function markStale() {
    if (R.renderedBuffer) {
      renderFresh = false;
      setRenderState(COPY.renderStale, 'stale');
    }
  }

  // ---------- live preview: the blue RENDER would give, before rendering ----------
  //
  // Twelve seconds after the playhead are cut from the source, run through
  // the rack as it stands (loudnorm deferred: its gain is a whole-file
  // measurement), and painted as the blue ghost over that window on the RACK
  // strip. Redraws on any change to the rack, cuts, or source, and on seek;
  // only while the RACK tab is showing. A fresh render replaces the window
  // with the whole render, since that is now the honest blue.
  const waveRack = views.waveRack || null;
  // Only changes that can alter the blue schedule a preview; the machine and
  // studio churn the store constantly and none of it touches the rack.
  const PREVIEW_KINDS = new Set(['chain', 'source', 'source-clear', 'transcript-edit', 'words', 'repairs', 'history', 'undo', 'redo']);
  let previewOn = true;
  const ZOOM_KEY = 'yj-preview-zoom';
  let previewZoom = true;
  try { previewZoom = localStorage.getItem(ZOOM_KEY) !== '0'; } catch (e) { /* private mode */ }
  let previewGen = 0;
  let previewTimer = 0;
  let previewMono = null;
  let previewBusy = false;
  let previewDirty = false;

  function previewVisible() {
    const pane = $('tab-rack');
    return !!(pane && pane.classList.contains('is-active'));
  }
  function setPreviewOut(text, dim = false) {
    const el = $('previewOut');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('is-dim', dim);
  }
  function syncPreviewBuffer() {
    if (!waveRack) return;
    if (R.mono !== previewMono) {
      previewMono = R.mono;
      waveRack.setBuffer(R.mono, R.sampleRate, R.peaks);
      waveRack.setGhost(null);
      waveRack.setSelection(null);
    }
    waveRack.setCuts(activeCuts());
  }
  function schedulePreview(delay = 220) {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, delay);
  }
  // One preview at a time: a change that lands mid-render marks the run dirty
  // and the strip is redrawn once more afterwards, so a burst of knob moves
  // never cancels every render before one can finish.
  async function runPreview() {
    previewTimer = 0;
    if (!waveRack) return;
    if (previewBusy) { previewDirty = true; return; }
    previewBusy = true;
    try {
      await previewOnce();
    } finally {
      previewBusy = false;
      if (previewDirty) { previewDirty = false; schedulePreview(0); }
    }
  }
  async function previewOnce() {
    syncPreviewBuffer();
    const gen = ++previewGen;
    if (!R.buffer) { waveRack.setGhost(null); waveRack.setSelection(null); setPreviewOut('LOAD AUDIO TO PREVIEW THE RACK', true); return; }
    if (!previewOn) { waveRack.setGhost(null); waveRack.setSelection(null); setPreviewOut('PREVIEW OFF · BLUE RETURNS WHEN YOU SWITCH IT ON', true); return; }
    if (R.renderedBuffer && renderFresh && renderedMono) {
      waveRack.setView(0, R.buffer.duration);
      waveRack.setGhost(renderedMono, renderedPeaks, 0);
      waveRack.setSelection(null);
      setPreviewOut('RENDERED · BLUE IS THE RENDER ITSELF · CHANGE THE RACK TO PREVIEW AGAIN');
      return;
    }
    if (!previewVisible()) return;
    const { chain, deferred, flat } = previewChain(P.chain);
    const win = previewWindow({ playheadSec: engine.currentTime, durationSec: R.buffer.duration });
    if (win) {
      const v = previewView({ window: win, durationSec: R.buffer.duration, zoom: previewZoom });
      waveRack.setView(v.start, v.end);
    }
    if (flat || !win) {
      waveRack.setGhost(null);
      waveRack.setSelection(null);
      setPreviewOut(flat ? 'RACK IS FLAT · SWITCH A MODULE ON TO SEE WHAT IT WOULD DO' : 'NOTHING TO PREVIEW', true);
      return;
    }
    const t0 = performance.now();
    waveRack.setSelection({ start: win.startSec, end: win.endSec });
    setPreviewOut('PREVIEWING · ' + (win.endSec - win.startSec).toFixed(1) + 'S FROM THE PLAYHEAD…', true);
    try {
      const slice = sliceAudioBuffer(R.buffer, win.renderStartSec, win.endSec);
      const out = await renderChain(slice, [], chain);
      if (gen !== previewGen || !R.buffer) return;
      const mono = mixdownMono(out);
      const skip = Math.min(mono.length, Math.round(win.prerollSec * out.sampleRate));
      waveRack.setGhost(mono.subarray(skip), null, win.startSec);
      setPreviewOut(describePreview({ window: win, ms: performance.now() - t0, deferred, cuts: activeCuts().length > 0 }));
    } catch (e) {
      if (gen !== previewGen) return;
      waveRack.setGhost(null);
      setPreviewOut('PREVIEW FAILED · ' + (e && e.message ? e.message : 'THE RACK REFUSED THE WINDOW'), true);
    }
  }
  if (waveRack) {
    waveRack.addEventListener('seek', (e) => { uiSeek(e.detail.t); schedulePreview(80); });
    const previewBtn = $('btnPreview');
    if (previewBtn) {
      previewBtn.addEventListener('click', () => {
        previewOn = !previewOn;
        previewBtn.classList.toggle('is-active', previewOn);
        runPreview();
      });
    }
    const zoomBtn = $('btnPreviewZoom');
    if (zoomBtn) {
      zoomBtn.classList.toggle('is-active', previewZoom);
      zoomBtn.addEventListener('click', () => {
        previewZoom = !previewZoom;
        try { localStorage.setItem(ZOOM_KEY, previewZoom ? '1' : '0'); } catch (e) { /* private mode */ }
        zoomBtn.classList.toggle('is-active', previewZoom);
        runPreview();
      });
    }
    store.addEventListener('change', (e) => {
      const kind = e.detail && e.detail.kind;
      if (!kind || PREVIEW_KINDS.has(kind)) schedulePreview();
    });
    const pane = $('tab-rack');
    if (pane && typeof MutationObserver === 'function') {
      new MutationObserver(() => { if (previewVisible()) schedulePreview(30); })
        .observe(pane, { attributes: true, attributeFilter: ['class'] });
    }
    ctx.api.previewRack = runPreview;
  }

  function setRenderState(text, led) {
    $('renderState').textContent = text;
    setLed('ledRender', led);
  }

  // ---------- render ----------
  $('btnRender').addEventListener('click', async () => {
    if (!R.buffer) return;
    const btn = $('btnRender');
    btn.disabled = true;
    btn.classList.add('is-working');
    const job = ctx.api.beginJob ? ctx.api.beginJob('RENDER', 'rack') : null;
    const prog = $('progRender');
    prog.hidden = false;
    const t0 = performance.now();
    status(COPY.rendering, true);
    setRenderState(COPY.rendering, 'busy');
    try {
      const gen = R.generation;
      // Drop the previous take before the new pipeline allocates: a re-render
      // used to hold the old buffer, mono, and peaks through the whole run.
      if (R.renderedBuffer) {
        if (abState === 'b') setAb('a');
        R.renderedBuffer = null;
        renderedMono = null;
        renderedPeaks = null;
        waveMain.setGhost(null);
      }
      // The source does not change between renders, so its loudness is
      // measured once per generation (repairs re-key it), not per render.
      const beforeKey = gen + ':' + ((R.repairs && R.repairs.length) || 0);
      if (!beforeCache || beforeCache.key !== beforeKey) {
        beforeCache = { key: beforeKey, integrated: (await measureViaWorker(R.buffer)).integrated };
      }
      const before = beforeCache.integrated;
      const rendered = await renderChain(R.buffer, cuts, P.chain, (pct) => {
        prog.querySelector('.yj-progress-fill').style.width = pct + '%';
        prog.querySelector('.yj-progress-note').textContent = Math.round(pct) + '%';
      });
      if (gen !== R.generation) return; // another file loaded mid-render; drop the stale result
      R.renderedBuffer = rendered;
      // Build the rendered take's peaks now, so A/B can draw it against the
      // original without re-scanning the samples on every toggle.
      renderedMono = mixdownMono(rendered);
      renderedPeaks = buildPeakPyramid(renderedMono);
      const after = (await measureViaWorker(R.renderedBuffer)).integrated;
      const delta = after - before;
      $('roDelta').textContent = (delta >= 0 ? '+' : '') + delta.toFixed(1) + ' LU';
      renderFresh = true;
      schedulePreview(0);
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      setRenderState(COPY.renderFresh, 'on');
      $('abToggle').hidden = false;
      if ($('abKey')) $('abKey').hidden = false;
      status(COPY.renderOk + ' · ' + secs + 's');
      setAb('b');
    } catch (e) {
      setRenderState('RENDER FAULT', 'fault');
      statusFault('Render fault — ' + (e.message || e));
    } finally {
      btn.disabled = false;
      if (job) job.end();
      btn.classList.remove('is-working');
      prog.hidden = true;
    }
  });

  // ---------- A/B ----------
  function setAb(side) {
    abState = side;
    const wasPlaying = engine.playing;
    if (wasPlaying) engine.pause();
    engine.setAltBuffer(side === 'b' ? R.renderedBuffer : null);
    for (const b of $('abToggle').querySelectorAll('button')) {
      b.classList.toggle('is-active', b.dataset.ab === side);
    }
    // Yellow is whatever you are hearing; blue is the take you are not. Before
    // this the waveform showed the original whichever side was selected, so the
    // only evidence of what the RACK did was your ears.
    showComparison(side);
    if (wasPlaying) engine.play(activeCuts());
  }

  function showComparison(side) {
    if (!R.mono) return;
    const hasRender = !!(renderedMono && R.renderedBuffer);
    const live = hasRender && side === 'b'
      ? { mono: renderedMono, peaks: renderedPeaks }
      : { mono: R.mono, peaks: R.peaks };
    const other = !hasRender ? null : (side === 'b'
      ? { mono: R.mono, peaks: R.peaks }
      : { mono: renderedMono, peaks: renderedPeaks });
    waveMain.setBuffer(live.mono, R.sampleRate, live.peaks);
    waveMain.setGhost(other ? other.mono : null, other ? other.peaks : null);
    waveMain.setCuts(activeCuts());
  }
  $('abToggle').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ab]');
    if (b) setAb(b.dataset.ab);
  });

  // ---------- audio export ----------
  // Chromium with the File System Access API streams the file to disk chunk
  // by chunk — no whole-file ArrayBuffer, no Blob copy (167 MB saved on a
  // 3-minute float export at 48 kHz). Everywhere else, the Blob path.
  function canStreamExport() {
    return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
  }
  function reportExport(stats, bits, speedNote, rate) {
    if (stats.clippedSamples > 0 && bits !== 32) {
      statusFault('EXPORTED ' + speedNote + 'WITH ' + stats.clippedSamples + ' OVERS · peak ' + stats.peakDb.toFixed(2) + ' dBFS — pull the limiter in.');
    } else if (bits === 32) {
      // Float keeps overs instead of clamping them, so an over is information
      // rather than damage: report it without calling it a fault.
      status('EXPORTED ' + speedNote + '32-BIT FLOAT · ' + rate + ' kHz · PEAK ' + stats.peakDb.toFixed(1) + ' dBFS'
        + (stats.clippedSamples > 0 ? ' · ' + stats.clippedSamples + ' OVERS KEPT' : ''));
    } else {
      status('EXPORTED · ' + speedNote + rate + ' kHz · PEAK ' + stats.peakDb.toFixed(1) + ' dBFS · DITHER ' + stats.dither.toUpperCase());
    }
  }
  async function exportWav(bits) {
    // renderFresh was written in four places and read in none, so a render that
    // the UI had already marked STALE was still what got written to disk: cut a
    // word, export, and the file still has the word. Refusing is the only honest
    // answer, since falling back to the raw splice would silently drop the whole
    // rack the render was made with.
    if (R.renderedBuffer && !renderFresh) {
      statusFault('RENDER IS STALE · the edit moved after the last render. HIT RENDER, THEN EXPORT.');
      return;
    }
    let buf = R.renderedBuffer;
    if (!buf) {
      buf = cuts.length ? spliceCuts(R.buffer, cuts) : R.buffer;
    }
    // Printing at speed is the same samples under a slower clock — bit-exact.
    // The filename says so, because a quarter-speed file is not the source.
    let speedTag = '';
    if (speed > 1) {
      try {
        buf = slowedBuffer(buf, speed);
      } catch (error) {
        statusFault('EXPORT FAULT · ' + (error && error.message ? error.message : error));
        return;
      }
      speedTag = speed === 4 ? '.quarter-speed' : '.half-speed';
    }
    const speedNote = speed > 1 ? speedLabel(speed) + ' SPEED · ' : '';
    const name = (P.fileName || 'yellowjacket').replace(/\.[^.]+$/, '') + '.bench' + speedTag + '.' + bits + '.wav';
    const rate = Math.round((buf && buf.sampleRate ? buf.sampleRate : 0) / 1000);
    if (canStreamExport()) {
      const job = ctx.api.beginJob ? ctx.api.beginJob('EXPORT', 'rack') : null;
      try {
        status('WRITING ' + name + '…', true);
        const done = await exportWavStream(buf, bits, {
          onProgress: (st) => status('WRITING · ' + Math.round(100 * Math.min(1, (st.written || 0))) + '%', true),
        }, () => window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'WAV audio', accept: { 'audio/wav': ['.wav'] } }],
        }).catch((e) => { if (e && e.name === 'AbortError') return null; throw e; }));
        if (!done) { status('EXPORT CANCELLED'); return; }
        reportExport(done.stats, bits, speedNote, rate);
        return;
      } catch (error) {
        // No transient user activation (a scripted click) or a picker the
        // embedder blocks: the Blob path below still delivers the file.
        const name = error && error.name;
        if (name !== 'SecurityError' && name !== 'NotAllowedError' && name !== 'TypeError') {
          statusFault('EXPORT FAULT · ' + (error && error.message ? error.message : error));
          return;
        }
      } finally {
        if (job) job.end();
      }
    }
    // Blob path: the file is built in chunks and joined once. A RangeError
    // inside a click handler would leave no status and no file, so it is caught.
    let blob;
    let stats;
    try {
      ({ blob, stats } = encodeWavWithStats(buf, bits));
    } catch (error) {
      const mb = buf && buf.length
        ? Math.round((buf.length * buf.numberOfChannels * (bits / 8)) / 1048576)
        : 0;
      statusFault('EXPORT FAULT · this render needs about ' + mb + ' MB in one block, '
        + 'which the browser refused. Export a shorter selection or a lower bit depth.');
      return;
    }
    download(blob, name, 'audio/wav');
    reportExport(stats, bits, speedNote, rate);
  }
  $('btnWav16').addEventListener('click', () => exportWav(16));
  $('btnWav24').addEventListener('click', () => exportWav(24));
  $('btnWav32').addEventListener('click', () => exportWav(32));

  // ---------- speed: play and print at 1/2 or 1/4 ----------
  function setSpeed(factor) {
    const allowed = speedFactorsFor(R.sampleRate);
    speed = allowed.includes(factor) ? factor : 1;
    engine.setRate(speed);
    const b = $('btnSpeed');
    if (b) {
      b.textContent = speedLabel(speed);
      b.classList.toggle('is-active', speed > 1);
      b.title = speed > 1
        ? 'Playing and printing at ' + speedLabel(speed) + ' — same samples, clock at '
          + Math.round(R.sampleRate / speed / 1000) + ' kHz, pitched down ' + (speed === 4 ? 'two octaves' : 'an octave')
        : 'Play and print the source at ½ or ¼ speed — same samples, slower clock, pitched down. Bit-exact.';
    }
    showSlowView();
    if (speed > 1) status(speedLabel(speed) + ' SPEED · ' + Math.round(R.sampleRate / speed / 1000) + ' kHz CLOCK · '
      + 'ABOVE ' + Math.round(R.sampleRate / 2 / speed / 1000) + ' kHz IN THE SOURCE IS NOW AUDIBLE');
    else status(COPY.loaded);
  }

  // Paint the band SPEED brings down and say whether anything lives there. The
  // level is measured once per source; the honest answer for most files is
  // "nothing", and the view must be willing to say so.
  function showSlowView() {
    const out = $('slowOut');
    const band = R.mono ? slowBand(R.sampleRate, speed) : null;
    if (!band) {
      spec.setSlowBand(null);
      if (out) out.hidden = true;
      return;
    }
    if (aboveCache.gen !== R.generation || aboveCache.lo !== band.sourceLo || aboveCache.hi !== band.sourceHi) {
      aboveCache = { gen: R.generation, lo: band.sourceLo, hi: band.sourceHi,
        db: bandLevelDb(R.mono, R.sampleRate, band.sourceLo, band.sourceHi) };
    }
    const k = (hz) => Math.round(hz / 1000);
    const db = aboveCache.db;
    const nothing = !Number.isFinite(db) || db < -90;
    const level = Number.isFinite(db) ? db.toFixed(1) + ' dBFS' : 'nothing';
    spec.setSlowBand({ ...band,
      label: speedLabel(speed) + ' BRINGS ' + k(band.sourceLo) + '–' + k(band.sourceHi) + ' kHz DOWN TO '
        + k(band.playedLo) + '–' + k(band.playedHi) + ' kHz · ' + level });
    if (out) {
      out.hidden = false;
      out.textContent = 'ABOVE ' + k(band.sourceLo) + ' kHz: ' + level
        + (nothing ? ' · NOTHING TO REVEAL — THIS FILE IS ORDINARY BANDWIDTH IN A TALL CONTAINER'
                   : ' · ' + speedLabel(speed) + ' LANDS IT AT ' + k(band.playedLo) + '–' + k(band.playedHi) + ' kHz');
      out.classList.toggle('is-empty', nothing);
    }
  }
  $('btnSpeed').addEventListener('click', () => {
    const allowed = speedFactorsFor(R.sampleRate);
    const i = allowed.indexOf(speed);
    setSpeed(allowed[(i + 1) % allowed.length]);
  });

  // ---------- per-source reset (called by source-controller after decode) ----------
  function resetForSource(hasSource = true) {
    cuts = [];
    renderFresh = false;
    renderedMono = null;
    renderedPeaks = null;
    if ($('soundscape')) $('soundscape').hidden = true;
    speed = 1;
    spec.setSlowBand(null);
    if ($('slowOut')) $('slowOut').hidden = true;
    if ($('btnSpeed')) { $('btnSpeed').textContent = speedLabel(1); $('btnSpeed').classList.remove('is-active'); $('btnSpeed').disabled = !hasSource; }
    liftRange = null;
    setAb('a');
    $('abToggle').hidden = true;
    if ($('abKey')) $('abKey').hidden = true;
    transcript.setWords([]);
    $('transcriptHint').hidden = false;
    $('transcriptHost').prepend($('transcriptHint'));
    for (const id of ['btnTranscribe', 'btnMeasure', 'btnRender', 'btnWav16', 'btnWav24', 'btnWav32']) $(id).disabled = !hasSource;
    for (const id of ['btnCutFillers', 'btnCutDeadAir', 'btnRestoreAll', 'btnExpTxt', 'btnExpSrt', 'btnExpVtt', 'btnExpJson']) $(id).disabled = true;
    refreshWeaveWordsButton();
    $('roFillers').textContent = '—';
    $('roDeadAir').textContent = '—';
    setRenderState(COPY.renderNone, 'off');
    updateCutReadout();
  }

  buildRack();

  ctx.api.uiSeek = uiSeek;
  ctx.api.onEdited = onEdited;
  ctx.api.togglePlay = togglePlay;
  ctx.api.statusRight = statusRight;
  ctx.api.benchReset = resetForSource;
  ctx.api.benchClear = () => resetForSource(false);
  ctx.api.getLiftRange = () => liftRange;
  ctx.api.rebuildRack = buildRack;
  // Restore path: words came back from a saved session, light the same surfaces
  // a fresh transcription would.
  ctx.api.wordsRestored = () => {
    if (!P.words) return;
    liftRange = null;
    $('transcriptHint').hidden = true;
    transcript.setWords(P.words, undefined, P.transcript && P.transcript.gapCuts);
    sliceView.setWords(P.words);
    onEdited();
    for (const id of ['btnCutFillers', 'btnCutDeadAir', 'btnRestoreAll', 'btnExpTxt', 'btnExpSrt', 'btnExpVtt', 'btnExpJson']) $(id).disabled = false;
    $('roFillers').textContent = P.words.filter((w) => w.filler).length + ' FOUND';
  };
}
