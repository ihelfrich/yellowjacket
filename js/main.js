// Yellowjacket — composition root. Constructs the store, engine, views, and
// instruments, then hands wiring to three controllers. State lives in the store;
// controllers own their flows; this file only assembles and boots.

import { Engine } from './audio-engine.js';
import { WaveformView } from './waveform.js';
import { SpectrogramView } from './spectrogram.js';
import { Transcriber } from './transcribe.js';
import { TranscriptView } from './transcript-ui.js';
import { REGISTRY } from './dsp/chain.js';
import { LevelMeter } from './meters.js';
import { SliceView } from './machine/slice-ui.js';
import { ClipAuditioner } from './machine/cliprefs.js';
import { Sequencer } from './machine/sequencer.js';
import { PatternView } from './machine/pattern-ui.js';
import { Keybed } from './machine/keybed.js';
import { ProjectStore } from './app/project-store.js';
import { initBenchController } from './app/bench-controller.js';
import { initSourceController } from './app/source-controller.js';
import { initMachineController } from './machine/controller.js';
import { RepairPanel } from './app/repair-panel.js';
import { initRepairController } from './app/repair-controller.js';

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
  rendering: 'RENDERING',
  renderOk: 'RENDER OK',
  renderStale: 'RENDER STALE',
  renderNone: 'NO RENDER',
  renderFresh: 'RENDER FRESH',
  measuring: 'MEASURING…',
  measured: 'MEASURED',
  computingSpec: 'Computing spectrogram…',
  specReady: 'Drag selects a region. ALT grabs a transient, SHIFT a tone. Click seeks. Zoom rides the waveform above.',
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

// ---------- shared formatting + status ----------
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
function setLed(id, mode) {
  const led = $(id);
  led.className = 'yj-led' + (mode === 'on' ? ' is-on' : mode === 'busy' ? ' is-busy' : mode === 'fault' ? ' is-fault' : '');
}

// ---------- construction ----------
const store = new ProjectStore(REGISTRY.map((d) => ({ id: d.id, on: false, params: { ...d.defaults } })));
const engine = new Engine();
const transcriber = new Transcriber();
const meter = new LevelMeter($('meterLive'));
const sequencer = new Sequencer(engine);
const keybed = new Keybed();

const views = {
  waveMini: new WaveformView($('waveMini')),
  waveMain: new WaveformView($('waveMain')),
  spec: new SpectrogramView($('specMain')),
  transcript: new TranscriptView($('transcriptHost')),
  sliceView: new SliceView($('sliceMain'), $('beatmapControls')),
  patternView: new PatternView($('patternHost')),
  repairPanel: new RepairPanel($('repairHost')),
};
const auditioner = new ClipAuditioner(engine);

const ctx = {
  store, engine, meter, transcriber, sequencer, keybed, auditioner, views,
  $, COPY, status, statusFault, fmtTime, fmtDb, setLed,
  api: {},
};

initBenchController(ctx);
initMachineController(ctx);
initRepairController(ctx);
initSourceController(ctx);

// ---------- tabs ----------
for (const btn of document.querySelectorAll('.yj-tab-btn')) {
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.yj-tab-btn')) b.classList.toggle('is-active', b === btn);
    for (const pane of document.querySelectorAll('.yj-tabpane')) pane.classList.remove('is-active');
    $('tab-' + btn.dataset.tab).classList.add('is-active');
    ctx.api.setKeybedEnabled(btn.dataset.tab === 'machine');
    // canvases need a size pass when they become visible
    views.waveMini.render(); views.waveMain.render(); views.spec.render(); views.sliceView.render();
  });
}

// ---------- keys ----------
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  // A focused button owns Space (native click) — TAP TEMPO would double-fire otherwise.
  if (e.code === 'Space' && e.target.closest && e.target.closest('button')) return;
  if (e.code === 'Space') { e.preventDefault(); ctx.api.togglePlay(); }
  if (e.code === 'Home') engine.seek(0);
});

// ---------- boot ----------
status(COPY.idle);
ctx.api.statusRight();

// Debug handle for the curious (and for bug reports): poke the bench from the console.
window.__yj = {
  engine, store, transcriber, sequencer, auditioner, ...views,
  get project() { return store.project; },
  get runtime() { return store.runtime; },
  api: ctx.api,
};
