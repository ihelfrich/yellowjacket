// Yellowjacket — bench wiring. This file owns state; everything else is instruments.

import { Engine } from './audio-engine.js';
import { WaveformView } from './waveform.js';
import { SpectrogramView } from './spectrogram.js';
import { Transcriber, MODELS } from './transcribe.js';
import { TranscriptView } from './transcript-ui.js';
import { REGISTRY, renderChain, spliceCuts } from './dsp/chain.js';
import { measureLoudness } from './dsp/loudness.js';
import { encodeWav, toSrt, toVtt, toTxt, download, editedTime } from './export.js';
import { LevelMeter } from './meters.js';
import { SliceView } from './machine/slice-ui.js';
import { wordsToClip, ClipAuditioner } from './machine/cliprefs.js';

const COPY = {
  idle: 'IDLE',
  noFile: 'NO FILE',
  decoding: 'DECODING…',
  decodeFail: "Decode failed. This file isn't audio this browser can read.",
  loaded: 'READY',
  modelNone: 'NO MODEL LOADED',
  modelLoading: 'FETCHING MODEL',
  modelReady: 'MODEL READY',
  transcribing: 'TRANSCRIBING',
  transcribeFail: 'TRANSCRIPTION FAULT',
  noTranscript: 'No transcript yet. Load audio, then pick a model and hit TRANSCRIBE. First run downloads the model and caches it in this browser; after that it works offline.',
  rendering: 'RENDERING',
  renderOk: 'RENDER OK',
  renderStale: 'RENDER STALE',
  renderNone: 'NO RENDER',
  renderFresh: 'RENDER FRESH',
  measuring: 'MEASURING…',
  measured: 'MEASURED',
  computingSpec: 'Computing spectrogram…',
  specReady: 'Click to seek. Zoom rides the waveform above.',
  noCuts: 'NO CUTS',
  fetching: 'FETCHING URL',
  mapping: 'MAPPING BEATS',
  mapped: 'BEATMAP READY',
  mapFault: 'BEATMAP FAULT',
  notAnalyzed: 'NOT ANALYZED',
  lowConfidence: 'LOW CONFIDENCE · TAP OR PIN',
  sliceReady: 'Drag to carve. Click a clip to hear it. Double-click a beat line to pin bar one.',
  noClips: 'NO CLIPS',
};

const $ = (id) => document.getElementById(id);

const project = {
  fileName: null,
  buffer: null,
  mono: null,
  sampleRate: 0,
  words: null,
  chain: REGISTRY.map((d) => ({ id: d.id, on: false, params: { ...d.defaults } })),
  renderedBuffer: null,
  analysis: null,
  clips: [],
};

const engine = new Engine();
const waveMini = new WaveformView($('waveMini'));
const waveMain = new WaveformView($('waveMain'));
const spec = new SpectrogramView($('specMain'));
const transcript = new TranscriptView($('transcriptHost'));
const transcriber = new Transcriber();
const meter = new LevelMeter($('meterLive'));
const sliceView = new SliceView($('sliceMain'), $('beatmapControls'));
const auditioner = new ClipAuditioner(engine);

let abState = 'a';           // 'a' original, 'b' rendered
let renderFresh = false;
let cuts = [];
let meterHooked = false;
let deviceLabel = '—';
let currentModel = null;
let loadGen = 0;             // bumped per loaded file; stale async jobs check it and bail

// ---------- formatting ----------
function fmtTime(t) {
  if (!isFinite(t) || t == null) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(3).padStart(6, '0');
}
function fmtDb(v, unit = ' dB') {
  return v === -Infinity || !isFinite(v) ? '-∞' : v.toFixed(1) + unit;
}

function status(left, hot = false) {
  const el = $('stLeft');
  el.textContent = left;
  el.classList.toggle('is-hot', hot);
  el.classList.remove('is-fault');
}
function statusFault(msg) {
  const el = $('stLeft');
  el.textContent = msg;
  el.classList.add('is-fault');
  el.classList.remove('is-hot');
}
function statusRight() {
  const bits = [];
  if (deviceLabel !== '—') bits.push(deviceLabel);
  if (currentModel) bits.push(currentModel.toUpperCase().replace(/^.*\//, ''));
  if (project.buffer) bits.push((project.sampleRate / 1000).toFixed(1) + 'k');
  if (project.buffer) bits.push(fmtTime(project.buffer.duration).slice(0, 5));
  $('stRight').textContent = bits.length ? bits.join(' · ') : COPY.noFile;
}

// ---------- timeline mapping (B side plays the edited timeline) ----------
function originalFromEdited(t) {
  // After each pass t is a candidate original-timeline position; a cut that
  // starts beyond it cannot affect it, so stop there.
  for (const c of cuts) {
    if (c.start > t) break;
    t += c.end - c.start;
  }
  return t;
}
function activeCuts() {
  return abState === 'b' ? [] : cuts;
}
// Seeks arrive in original-timeline seconds; the B side plays the edited timeline.
function uiSeek(t) {
  engine.seek(abState === 'b' ? editedTime(t, cuts) : t);
}

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

async function loadArrayBuffer(ab, name) {
  status(COPY.decoding, true);
  try {
    await engine.load(ab, name);
  } catch (e) {
    statusFault(COPY.decodeFail);
    return;
  }
  $('ripHelp').hidden = true;
  loadGen++;
  project.fileName = name;
  project.buffer = engine.buffer;
  project.mono = engine.mono;
  project.sampleRate = engine.sampleRate;
  project.words = null;
  project.renderedBuffer = null;
  cuts = [];
  renderFresh = false;
  setAb('a');
  $('abToggle').hidden = true;

  $('dropZone').classList.add('is-hidden');
  $('roDur').textContent = fmtTime(engine.duration);
  $('roTime').textContent = fmtTime(0);

  waveMini.setBuffer(project.mono, project.sampleRate);
  waveMain.setBuffer(project.mono, project.sampleRate);
  transcript.setWords([]);
  $('transcriptHint').hidden = false;
  $('transcriptHost').prepend($('transcriptHint'));

  for (const id of ['btnTranscribe', 'btnMeasure', 'btnRender', 'btnWav16', 'btnWav24']) $(id).disabled = false;
  for (const id of ['btnCutFillers', 'btnCutDeadAir', 'btnRestoreAll', 'btnExpTxt', 'btnExpSrt', 'btnExpVtt', 'btnExpJson']) $(id).disabled = true;
  $('roFillers').textContent = '—';
  $('roDeadAir').textContent = '—';
  setRenderState(COPY.renderNone, 'off');
  updateCutReadout();

  project.analysis = null;
  project.clips = [];
  $('btnLift').disabled = true;
  sliceView.setSource(project.mono, project.sampleRate);
  sliceView.setWords(null);
  sliceView.setClips(project.clips);
  updateClipReadout();
  setBeatmapLed('off', COPY.notAnalyzed);
  $('sliceNote').textContent = COPY.computingSpec;

  status(COPY.loaded);
  statusRight();

  $('specNote').textContent = COPY.computingSpec;
  const gen = loadGen;
  spec.compute(project.mono, project.sampleRate).then(() => {
    $('specNote').textContent = COPY.specReady;
    spec.render();
  }).catch(() => {
    $('specNote').textContent = 'Spectrogram fault — see console.';
  }).finally(() => {
    // Analysis waits for the spectrogram: both are CPU-heavy, sequential is kinder.
    if (gen === loadGen) runAnalysis();
  });
}

// ---------- transport ----------
function togglePlay() {
  if (!project.buffer) return;
  if (engine.playing) {
    engine.pause();
  } else {
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
  if (project.words) transcript.setActiveTime(t);
});

function hookMeter() {
  if (meterHooked) return;
  // The engine creates its AudioContext lazily; hook once it exists.
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

function setLed(id, mode) {
  const led = $(id);
  led.className = 'yj-led' + (mode === 'on' ? ' is-on' : mode === 'busy' ? ' is-busy' : mode === 'fault' ? ' is-fault' : '');
}

transcriber.addEventListener('progress', (e) => {
  const { stage, pct, note } = e.detail;
  const prog = $('progTrans');
  prog.hidden = false;
  prog.querySelector('.yj-progress-fill').style.width = pct + '%';
  prog.querySelector('.yj-progress-note').textContent = (note || stage).toUpperCase() + ' · ' + Math.round(pct) + '%';
  status((stage === 'download' ? COPY.modelLoading : COPY.transcribing) + ' · ' + Math.round(pct) + '%', true);
});

$('btnTranscribe').addEventListener('click', async () => {
  if (!project.mono) return;
  const btn = $('btnTranscribe');
  btn.disabled = true;
  btn.classList.add('is-working');
  setLed('ledModel', 'busy');
  try {
    const gen = loadGen;
    const modelId = selModel.value;
    if (currentModel !== modelId || !transcriber.modelLoaded) {
      $('modelState').textContent = COPY.modelLoading;
      await transcriber.loadModel(modelId);
      currentModel = modelId;
      deviceLabel = (transcriber.device || 'wasm').toUpperCase();
      $('modelState').textContent = COPY.modelReady + ' · ' + deviceLabel;
    }
    setLed('ledModel', 'on');
    const words = await transcriber.transcribe(project.mono, project.sampleRate);
    if (gen !== loadGen) return; // another file loaded mid-job; drop the stale result
    project.words = words;
    $('transcriptHint').hidden = true;
    transcript.setWords(words);
    sliceView.setWords(words);
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
transcript.addEventListener('edited', onEdited);
let liftRange = null; // {i0, i1} from the last transcript range selection
transcript.addEventListener('selectrange', (e) => {
  liftRange = Number.isInteger(e.detail.i0) && Number.isInteger(e.detail.i1)
    ? { i0: e.detail.i0, i1: e.detail.i1 } : null;
  $('btnLift').disabled = !liftRange;
});

function onEdited() {
  cuts = transcript.getCuts();
  waveMini.setCuts(cuts);
  waveMain.setCuts(cuts);
  updateCutReadout();
  if (project.renderedBuffer) {
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
  $('roFillers').textContent = (typeof n === 'number' ? n : project.words.filter((w) => w.filler).length) + ' CUT';
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
  transcript.restoreAll ? transcript.restoreAll() : (project.words.forEach((w) => (w.deleted = false)), transcript.setWords(project.words));
  $('roFillers').textContent = project.words.filter((w) => w.filler).length + ' FOUND';
  $('roDeadAir').textContent = '—';
  onEdited();
});

// ---------- transcript export ----------
function transcriptFilename(ext) {
  return (project.fileName || 'transcript').replace(/\.[^.]+$/, '') + '.' + ext;
}
$('btnExpTxt').addEventListener('click', () => download(toTxt(project.words, { skipDeleted: true }), transcriptFilename('txt'), 'text/plain'));
$('btnExpSrt').addEventListener('click', () => download(toSrt(project.words, { skipDeleted: true, cuts }), transcriptFilename('srt'), 'text/plain'));
$('btnExpVtt').addEventListener('click', () => download(toVtt(project.words, { skipDeleted: true, cuts }), transcriptFilename('vtt'), 'text/vtt'));
$('btnExpJson').addEventListener('click', () => download(JSON.stringify({ file: project.fileName, words: project.words }, null, 2), transcriptFilename('json'), 'application/json'));

// ---------- measurement ----------
$('btnMeasure').addEventListener('click', async () => {
  const buf = abState === 'b' && project.renderedBuffer ? project.renderedBuffer : project.buffer;
  if (!buf) return;
  status(COPY.measuring, true);
  await new Promise((r) => setTimeout(r, 30)); // let the status paint
  const channels = [];
  for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
  const m = measureLoudness({ channels, sampleRate: buf.sampleRate });
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
    const cfg = project.chain.find((c) => c.id === desc.id);
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
        cfg.params[p.key] = Number(rng.value);
        show();
        markStale();
      });
      row.append(lab, rng, val);
      params.appendChild(row);
    }
    mod.appendChild(params);

    power.addEventListener('click', () => {
      cfg.on = !cfg.on;
      power.classList.toggle('is-on', cfg.on);
      mod.classList.toggle('is-off', !cfg.on);
      markStale();
    });
    host.appendChild(mod);
  }
}

function markStale() {
  if (project.renderedBuffer) {
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
  if (!project.buffer) return;
  const btn = $('btnRender');
  btn.disabled = true;
  btn.classList.add('is-working');
  const prog = $('progRender');
  prog.hidden = false;
  const t0 = performance.now();
  status(COPY.rendering, true);
  try {
    const gen = loadGen;
    const before = measureLoudness({ channels: monoChannels(project.buffer), sampleRate: project.buffer.sampleRate }).integrated;
    const rendered = await renderChain(project.buffer, cuts, project.chain, (pct) => {
      prog.querySelector('.yj-progress-fill').style.width = pct + '%';
      prog.querySelector('.yj-progress-note').textContent = Math.round(pct) + '%';
    });
    if (gen !== loadGen) return; // another file loaded mid-render; drop the stale result
    project.renderedBuffer = rendered;
    const after = measureLoudness({ channels: monoChannels(project.renderedBuffer), sampleRate: project.renderedBuffer.sampleRate }).integrated;
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

function monoChannels(buf) {
  const chs = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
  return chs;
}

// ---------- A/B ----------
function setAb(side) {
  abState = side;
  const wasPlaying = engine.playing;
  if (wasPlaying) engine.pause();
  engine.setAltBuffer(side === 'b' ? project.renderedBuffer : null);
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
  let buf = project.renderedBuffer;
  if (!buf) {
    buf = cuts.length ? spliceCuts(project.buffer, cuts) : project.buffer;
  }
  const name = (project.fileName || 'yellowjacket').replace(/\.[^.]+$/, '') + '.bench.' + bits + '.wav';
  download(encodeWav(buf, bits), name, 'audio/wav');
}
$('btnWav16').addEventListener('click', () => exportWav(16));
$('btnWav24').addEventListener('click', () => exportWav(24));

// ---------- machine: beatmap analysis ----------
let analysisWorker = null;
let analysisBusy = false;
// Per-run state the persistent onmessage handler reads. A closure would freeze the
// first run's values forever and silently drop every later file's results.
let analysisRun = { gen: -1, anchors: null, withMono: true };

function setBeatmapLed(mode, text) {
  const led = $('ledBeatmap');
  led.className = 'yj-led' + (mode === 'on' ? ' is-on' : mode === 'busy' ? ' is-busy' : mode === 'fault' ? ' is-fault' : '');
  $('beatmapState').textContent = text;
}

function updateClipReadout() {
  $('roClips').textContent = project.clips.length
    ? project.clips.length + (project.clips.length === 1 ? ' CLIP' : ' CLIPS')
    : COPY.noClips;
}

function analysisAnchors() {
  const a = project.analysis && project.analysis.anchors;
  return { bpm: a && a.bpm != null ? a.bpm : null, barOneTime: a && a.barOneTime != null ? a.barOneTime : null };
}

function runAnalysis(anchors = null, withMono = true) {
  if (!project.mono) return;
  analysisRun = { gen: loadGen, anchors: anchors || analysisAnchors(), withMono };
  if (!analysisWorker) {
    analysisWorker = new Worker(new URL('../workers/analysis-worker.js', import.meta.url), { type: 'module' });
    analysisWorker.onmessage = (e) => {
      const msg = e.data || {};
      if (analysisRun.gen !== loadGen && msg.type !== 'progress') return;
      if (msg.type === 'progress') {
        if (analysisBusy) status(COPY.mapping + ' · ' + Math.round(msg.pct) + '%', true);
      } else if (msg.type === 'done') {
        analysisBusy = false;
        if (typeof sliceView.setAnalyzing === 'function') sliceView.setAnalyzing(false);
        project.analysis = { ...msg.analysis, anchors: analysisRun.anchors };
        sliceView.setAnalysis(project.analysis);
        const conf = project.analysis.confidence || 0;
        if (!project.analysis.beats || !project.analysis.beats.length) {
          setBeatmapLed('fault', COPY.notAnalyzed);
        } else if (conf >= 0.6) {
          setBeatmapLed('on', COPY.mapped + ' · ' + project.analysis.tempo.toFixed(1) + ' BPM');
        } else if (conf >= 0.3) {
          setBeatmapLed('busy', project.analysis.tempo.toFixed(1) + ' BPM · ROUGH');
        } else {
          setBeatmapLed('fault', COPY.lowConfidence);
        }
        $('sliceNote').textContent = COPY.sliceReady;
        status(COPY.loaded);
      } else if (msg.type === 'error') {
        // Cache miss on an anchors-only rerun: resend with audio. Anything else is a fault.
        if (!analysisRun.withMono) { runAnalysis(analysisRun.anchors, true); return; }
        analysisBusy = false;
        if (typeof sliceView.setAnalyzing === 'function') sliceView.setAnalyzing(false);
        setBeatmapLed('fault', COPY.mapFault);
        statusFault(COPY.mapFault + ' — ' + (msg.message || 'unknown'));
      }
    };
    analysisWorker.onerror = () => {
      analysisBusy = false;
      setBeatmapLed('fault', COPY.mapFault);
    };
  }
  analysisBusy = true;
  if (typeof sliceView.setAnalyzing === 'function') sliceView.setAnalyzing(true);
  setBeatmapLed('busy', COPY.mapping);
  const payload = { type: 'analyze', sampleRate: project.sampleRate, anchors: analysisRun.anchors, generation: analysisRun.gen };
  if (withMono) {
    const copy = project.mono.slice();
    payload.mono = copy;
    analysisWorker.postMessage(payload, [copy.buffer]);
  } else {
    analysisWorker.postMessage(payload);
  }
}

// ---------- machine: slice view wiring ----------
sliceView.addEventListener('clipadd', (e) => {
  project.clips.push(e.detail.clip);
  sliceView.setClips(project.clips);
  updateClipReadout();
});
sliceView.addEventListener('clipdelete', (e) => {
  project.clips = project.clips.filter((c) => c.id !== e.detail.id);
  sliceView.setClips(project.clips);
  updateClipReadout();
});
sliceView.addEventListener('audition', (e) => auditioner.play(e.detail.clip));
sliceView.addEventListener('anchorchange', (e) => {
  const anchors = { bpm: e.detail.bpm ?? null, barOneTime: e.detail.barOneTime ?? null };
  if (project.analysis) project.analysis.anchors = anchors;
  runAnalysis(anchors, false); // envelope is cached in the worker; anchors-only is cheap
});
sliceView.addEventListener('analyze', () => runAnalysis(null, true));
sliceView.addEventListener('exportloop', (e) => {
  const clip = e.detail.clip;
  if (!clip || !project.buffer) return;
  const buf = project.buffer;
  const s = Math.max(0, Math.floor(clip.start * buf.sampleRate));
  const n = Math.min(buf.length, Math.ceil(clip.end * buf.sampleRate)) - s;
  if (n <= 0) return;
  const out = new AudioBuffer({ length: n, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
  for (let c = 0; c < buf.numberOfChannels; c++) {
    out.getChannelData(c).set(buf.getChannelData(c).subarray(s, s + n));
  }
  const base = (project.fileName || 'yellowjacket').replace(/\.[^.]+$/, '');
  const label = (clip.label || clip.tag || 'clip').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'clip';
  download(encodeWav(out, 16), base + '.' + label + '.wav', 'audio/wav');
  status('LOOP EXPORTED · ' + (n / buf.sampleRate).toFixed(2) + 's');
});

$('btnLift').addEventListener('click', () => {
  if (!liftRange || !project.words) return;
  const clip = wordsToClip(project.words, liftRange.i0, liftRange.i1);
  project.clips.push(clip);
  sliceView.setClips(project.clips);
  updateClipReadout();
  document.querySelector('.yj-tab-btn[data-tab="machine"]').click();
  if (typeof sliceView.flashClip === 'function') sliceView.flashClip(clip.id);
});

// ---------- tabs ----------
for (const btn of document.querySelectorAll('.yj-tab-btn')) {
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.yj-tab-btn')) b.classList.toggle('is-active', b === btn);
    for (const pane of document.querySelectorAll('.yj-tabpane')) pane.classList.remove('is-active');
    $('tab-' + btn.dataset.tab).classList.add('is-active');
    // canvases need a size pass when they become visible
    waveMini.render(); waveMain.render(); spec.render(); sliceView.render();
  });
}

// ---------- file input / drop ----------
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
    if (project.buffer) $('dropZone').classList.add('is-hidden');
  }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  $('dropZone').classList.remove('is-over');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) openFile(f);
  else if (project.buffer) $('dropZone').classList.add('is-hidden');
});

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
  if (e.key === 'Escape' && project.buffer) $('dropZone').classList.add('is-hidden');
});
// ?url= prefills the field; fetching still takes a click. A page that auto-fetches
// whatever the query string says is a page that can be pointed at anything.
{
  const pre = new URLSearchParams(location.search).get('url');
  if (pre) $('urlInput').value = pre;
}

// ---------- keys ----------
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  // A focused button owns Space (native click) — TAP TEMPO would double-fire otherwise.
  if (e.code === 'Space' && e.target.closest && e.target.closest('button')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.code === 'Home') engine.seek(0);
});

// ---------- boot ----------
buildRack();
status(COPY.idle);
statusRight();

// Debug handle for the curious (and for bug reports): poke the bench from the console.
window.__yj = { engine, project, transcript, transcriber, waveMain, waveMini, spec, sliceView, auditioner, get cuts() { return cuts; } };
