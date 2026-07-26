// Yellowjacket — bench wiring. This file owns state; everything else is instruments.

import { Engine } from './audio-engine.js';
import { WaveformView } from './waveform.js';
import { SpectrogramView } from './spectrogram.js';
import { Transcriber, MODELS } from './transcribe.js';
import { TranscriptView } from './transcript-ui.js';
import { REGISTRY, renderChain, spliceCuts } from './dsp/chain.js';
import { measureLoudness } from './dsp/loudness.js';
import { encodeWav, toSrt, toVtt, toTxt, download } from './export.js';
import { LevelMeter } from './meters.js';

const COPY = {
  idle: 'IDLE',
  noFile: 'NO FILE',
  decoding: 'DECODING…',
  decodeFail: "Decode failed — this file isn't audio this browser can read.",
  loaded: 'READY',
  modelNone: 'NO MODEL LOADED',
  modelLoading: 'FETCHING MODEL',
  modelReady: 'MODEL READY',
  transcribing: 'TRANSCRIBING',
  transcribeFail: 'TRANSCRIPTION FAULT',
  noTranscript: 'No transcript yet. Load audio, pick a model, hit TRANSCRIBE. First run downloads the model and caches it in this browser; after that it works offline.',
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
};

const engine = new Engine();
const waveMini = new WaveformView($('waveMini'));
const waveMain = new WaveformView($('waveMain'));
const spec = new SpectrogramView($('specMain'));
const transcript = new TranscriptView($('transcriptHost'));
const transcriber = new Transcriber();
const meter = new LevelMeter($('meterLive'));

let abState = 'a';           // 'a' original, 'b' rendered
let renderFresh = false;
let cuts = [];
let meterHooked = false;
let deviceLabel = '—';
let currentModel = null;

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
  let acc = 0;
  for (const c of cuts) {
    if (c.start - acc > t) break;
    t += c.end - c.start;
    acc += 0; // t is now advanced past this cut in original timeline terms
  }
  return t;
}
function activeCuts() {
  return abState === 'b' ? [] : cuts;
}

// ---------- file loading ----------
async function openFile(file) {
  status(COPY.decoding, true);
  try {
    const ab = await file.arrayBuffer();
    await engine.load(ab, file.name);
  } catch (e) {
    statusFault(COPY.decodeFail);
    return;
  }
  project.fileName = file.name;
  project.buffer = engine.buffer;
  project.mono = engine.mono;
  project.sampleRate = engine.sampleRate;
  project.words = null;
  project.renderedBuffer = null;
  cuts = [];
  abState = 'a';
  renderFresh = false;

  $('dropZone').classList.add('is-hidden');
  $('roDur').textContent = fmtTime(engine.duration);
  $('roTime').textContent = fmtTime(0);

  waveMini.setBuffer(project.mono, project.sampleRate);
  waveMain.setBuffer(project.mono, project.sampleRate);
  transcript.setWords([]);
  $('transcriptHint').hidden = false;
  $('transcriptHost').prepend($('transcriptHint'));

  for (const id of ['btnTranscribe', 'btnMeasure', 'btnRender', 'btnWav16', 'btnWav24']) $(id).disabled = false;
  $('btnTranscribe').disabled = !transcriber.modelLoaded && false; // transcribe loads on demand
  setRenderState(COPY.renderNone, 'off');
  updateCutReadout();

  status(COPY.loaded);
  statusRight();

  $('specNote').textContent = COPY.computingSpec;
  spec.compute(project.mono, project.sampleRate).then(() => {
    $('specNote').textContent = COPY.specReady;
    spec.render();
  }).catch(() => {
    $('specNote').textContent = 'Spectrogram fault — see console.';
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
  if (meterHooked || !engine.ctx) {
    if (!meterHooked && engine.ctx) { /* fallthrough below */ }
  }
  // engine creates ctx lazily inside play(); hook on next tick
  queueMicrotask(() => {
    if (!meterHooked && engine.ctx && engine.master) {
      meter.connect(engine.ctx, engine.master);
      meter.start();
      if ('onclip' in meter || true) {
        meter.onclip = () => $('btnClip').classList.add('is-lit');
      }
      meterHooked = true;
    }
  });
}

$('btnClip').addEventListener('click', () => $('btnClip').classList.remove('is-lit'));
$('btnPlay').addEventListener('click', togglePlay);
$('btnRtz').addEventListener('click', () => { engine.seek(0); $('roTime').textContent = fmtTime(0); });

// ---------- views sync ----------
for (const w of [waveMini, waveMain]) {
  w.addEventListener('seek', (e) => { engine.seek(e.detail.t); });
  w.addEventListener('view', (e) => {
    if (w === waveMain) spec.setView(e.detail.start, e.detail.end);
  });
}
spec.addEventListener('seek', (e) => engine.seek(e.detail.t));

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
    const modelId = selModel.value;
    if (currentModel !== modelId) {
      $('modelState').textContent = COPY.modelLoading;
      await transcriber.loadModel(modelId);
      currentModel = modelId;
      deviceLabel = (transcriber.device || 'wasm').toUpperCase();
      $('modelState').textContent = COPY.modelReady + ' · ' + deviceLabel;
    }
    setLed('ledModel', 'on');
    const words = await transcriber.transcribe(project.mono, project.sampleRate);
    project.words = words;
    $('transcriptHint').hidden = true;
    transcript.setWords(words);
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
transcript.addEventListener('wordclick', (e) => engine.seek(e.detail.t));
transcript.addEventListener('edited', onEdited);

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
    const before = measureLoudness({ channels: monoChannels(project.buffer), sampleRate: project.buffer.sampleRate }).integrated;
    project.renderedBuffer = await renderChain(project.buffer, cuts, project.chain, (pct) => {
      prog.querySelector('.yj-progress-fill').style.width = pct + '%';
      prog.querySelector('.yj-progress-note').textContent = Math.round(pct) + '%';
    });
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

// ---------- tabs ----------
for (const btn of document.querySelectorAll('.yj-tab-btn')) {
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.yj-tab-btn')) b.classList.toggle('is-active', b === btn);
    for (const pane of document.querySelectorAll('.yj-tabpane')) pane.classList.remove('is-active');
    $('tab-' + btn.dataset.tab).classList.add('is-active');
    // canvases need a size pass when they become visible
    waveMini.render(); waveMain.render(); spec.render();
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

// ---------- keys ----------
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.code === 'Home') engine.seek(0);
});

// ---------- boot ----------
buildRack();
status(COPY.idle);
statusRight();

// Debug handle for the curious (and for bug reports): poke the bench from the console.
window.__yj = { engine, project, transcript, transcriber, waveMain, waveMini, spec, get cuts() { return cuts; } };
