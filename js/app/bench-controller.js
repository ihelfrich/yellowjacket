// Bench controller: transport, metering, transcription, transcript editing and
// exports, measurement, rack, render, A/B, WAV export. Moved from main.js in the
// STRUCTURE refactor; logic unchanged, state now scoped here or in the store.

import { MODELS } from '../transcribe.js';
import { REGISTRY, renderChain, spliceCuts } from '../dsp/chain.js';
import { encodeWavWithStats, toSrt, toVtt, toTxt, download, editedTime } from '../export.js';
import { LOOM_TRANSCRIPT_MAX_WORDS } from '../loom/compile.js';

export function initBenchController(ctx) {
  const { store, engine, meter, transcriber, sequencer, views, $, COPY, status, statusFault, fmtTime, fmtDb, setLed } = ctx;
  const { waveMini, waveMain, spec, transcript, sliceView } = views;
  const P = store.project;
  const R = store.runtime;

  let abState = 'a';           // 'a' original, 'b' rendered
  let renderFresh = false;
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
  function togglePlay() {
    if (!R.buffer) return;
    if (engine.playing) {
      engine.pause();
    } else {
      if (sequencer.running) sequencer.stop(); // one transport owns the output at a time
      if (ctx.api.stopLoom) ctx.api.stopLoom();
      hookMeter();
      engine.play(activeCuts());
    }
  }

  engine.addEventListener('state', (e) => {
    $('btnPlay').textContent = e.detail.playing ? 'STOP' : 'PLAY';
  });
  engine.addEventListener('ended', () => {
    $('btnPlay').textContent = 'PLAY';
  });
  engine.addEventListener('time', (e) => {
    let t = e.detail.t;
    if (abState === 'b') t = originalFromEdited(t);
    $('roTime').textContent = fmtTime(e.detail.t);
    waveMini.setPlayhead(t);
    waveMain.setPlayhead(t);
    spec.setPlayhead(t);
    if (P.words) transcript.setActiveTime(t);
  });

  function hookMeter() {
    if (meterHooked) return;
    queueMicrotask(() => {
      if (!meterHooked && engine.ctx && engine.master) {
        meter.connect(engine.ctx, engine.master);
        meter.start();
        meter.onclip = () => $('btnClip').classList.add('is-lit');
        meterHooked = true;
      }
    });
  }

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
    setLed('ledModel', 'busy');
    try {
      const gen = R.generation;
      const modelId = selModel.value;
      if (currentModel !== modelId || !transcriber.modelLoaded) {
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
      setRenderState(COPY.renderStale, 'busy');
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
        else if (msg.type === 'done') { measureJobs.delete(msg.job); job.resolve(msg.result); }
        else if (msg.type === 'error') {
          measureJobs.delete(msg.job);
          job.reject(new Error(msg.message));
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
    status(COPY.measured + (abState === 'b' ? ' · BENCH' : ' · ORIGINAL'));
  });

  // ---------- rack ----------
  function buildRack() {
    const host = $('rackHost');
    host.innerHTML = '';
    for (const desc of REGISTRY) {
      const cfg = P.chain.find((c) => c.id === desc.id);
      const mod = document.createElement('div');
      mod.className = 'yj-panel yj-mod' + (cfg.on ? '' : ' is-off');
      mod.dataset.label = 'MODULE';

      const head = document.createElement('div');
      head.className = 'yj-mod-head';
      const power = document.createElement('button');
      power.className = 'yj-mod-power' + (cfg.on ? ' is-on' : '');
      power.title = 'Power';
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
        mod.classList.toggle('is-off', !cfg.on);
        markStale();
      });
      host.appendChild(mod);
    }
  }

  function markStale() {
    if (R.renderedBuffer) {
      renderFresh = false;
      setRenderState(COPY.renderStale, 'busy');
    }
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
    const prog = $('progRender');
    prog.hidden = false;
    const t0 = performance.now();
    status(COPY.rendering, true);
    try {
      const gen = R.generation;
      const before = (await measureViaWorker(R.buffer)).integrated;
      const rendered = await renderChain(R.buffer, cuts, P.chain, (pct) => {
        prog.querySelector('.yj-progress-fill').style.width = pct + '%';
        prog.querySelector('.yj-progress-note').textContent = Math.round(pct) + '%';
      });
      if (gen !== R.generation) return; // another file loaded mid-render; drop the stale result
      R.renderedBuffer = rendered;
      const after = (await measureViaWorker(R.renderedBuffer)).integrated;
      const delta = after - before;
      $('roDelta').textContent = (delta >= 0 ? '+' : '') + delta.toFixed(1) + ' LU';
      renderFresh = true;
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      setRenderState(COPY.renderFresh, 'on');
      $('abToggle').hidden = false;
      status(COPY.renderOk + ' · ' + secs + 's');
      setAb('b');
    } catch (e) {
      setRenderState('RENDER FAULT', 'fault');
      statusFault('Render fault — ' + (e.message || e));
    } finally {
      btn.disabled = false;
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
    if (wasPlaying) engine.play(activeCuts());
  }
  $('abToggle').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ab]');
    if (b) setAb(b.dataset.ab);
  });

  // ---------- audio export ----------
  function exportWav(bits) {
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
    const name = (P.fileName || 'yellowjacket').replace(/\.[^.]+$/, '') + '.bench.' + bits + '.wav';
    // The whole file is built as one ArrayBuffer. Since the 48 kHz decode cap
    // was lifted and float was added, that single allocation can reach hundreds
    // of megabytes, and a RangeError inside a click handler would leave no
    // status and no file — the button would simply look dead.
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
    const rate = Math.round((buf && buf.sampleRate ? buf.sampleRate : 0) / 1000);
    if (stats.clippedSamples > 0 && bits !== 32) {
      statusFault('EXPORTED WITH ' + stats.clippedSamples + ' OVERS · peak ' + stats.peakDb.toFixed(2) + ' dBFS — pull the limiter in.');
    } else if (bits === 32) {
      // Float keeps overs instead of clamping them, so an over is information
      // rather than damage: report it without calling it a fault.
      status('EXPORTED 32-BIT FLOAT · ' + rate + ' kHz · PEAK ' + stats.peakDb.toFixed(1) + ' dBFS'
        + (stats.clippedSamples > 0 ? ' · ' + stats.clippedSamples + ' OVERS KEPT' : ''));
    } else {
      status('EXPORTED · ' + rate + ' kHz · PEAK ' + stats.peakDb.toFixed(1) + ' dBFS · DITHER ' + stats.dither.toUpperCase());
    }
  }
  $('btnWav16').addEventListener('click', () => exportWav(16));
  $('btnWav24').addEventListener('click', () => exportWav(24));
  $('btnWav32').addEventListener('click', () => exportWav(32));

  // ---------- per-source reset (called by source-controller after decode) ----------
  function resetForSource(hasSource = true) {
    cuts = [];
    renderFresh = false;
    liftRange = null;
    setAb('a');
    $('abToggle').hidden = true;
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
