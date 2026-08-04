// Yellowjacket — composition root. Constructs the store, engine, views, and
// instruments, then hands wiring to the six controllers listed in CONTROLLERS
// below. State lives in the store; controllers own their flows; this file only
// assembles and boots.

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
import { SongView } from './machine/song-ui.js';
import { ClipListView } from './machine/cliplist-ui.js';
import { ConstellationView } from './machine/constellation-ui.js';
import { VoiceView } from './machine/voice-ui.js';
import { CrateView } from './machine/crate-ui.js';
import { SynthView } from './machine/synth-ui.js';
import { ModalView } from './machine/modal-ui.js';
import { PadGridView } from './machine/pads-ui.js';
import { FirstRunView } from './app/firstrun-ui.js';
import { SYNTH_PRESETS } from './machine/synth.js';
import { Keybed } from './machine/keybed.js';
import { PipelineView, deriveStages } from './app/pipeline-ui.js';
import { ProjectStore } from './app/project-store.js';
import { initBenchController } from './app/bench-controller.js';
import { initSourceController } from './app/source-controller.js';
import { initMachineController } from './machine/controller.js';
import { RepairPanel } from './app/repair-panel.js';
import { initRepairController } from './app/repair-controller.js';
import { initWireController } from './app/wire-controller.js';
import { initPersistController } from './app/persist-controller.js';

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

// Views are constructed one at a time and isolated, for the same reason the
// controllers below are. Every constructor dereferences its host element
// immediately, so one missing div in index.html threw out of module scope
// before the controller try/catch existed, before any status was set, and
// before a single working panel had been built: a blank yellow page.
const VIEW_SPECS = [
  ['waveMini', () => new WaveformView($('waveMini'))],
  ['waveMain', () => new WaveformView($('waveMain'))],
  ['spec', () => new SpectrogramView($('specMain'))],
  ['transcript', () => new TranscriptView($('transcriptHost'))],
  ['sliceView', () => new SliceView($('sliceMain'), $('beatmapControls'))],
  ['patternView', () => new PatternView($('patternHost'))],
  ['songView', () => new SongView($('songHost'))],
  ['clipList', () => new ClipListView($('clipListHost'))],
  ['constellation', () => new ConstellationView($('constellationMain'))],
  ['voiceView', () => new VoiceView($('voiceHost'))],
  ['crateView', () => new CrateView($('crateHost'))],
  ['synthView', () => new SynthView($('synthHost'), SYNTH_PRESETS)],
  ['modalView', () => new ModalView($('modalHost'))],
  ['repairPanel', () => new RepairPanel($('repairHost'))],
  ['pipeline', () => new PipelineView($('pipelineHost'))],
  ['pads', () => new PadGridView($('padsHost'))],
  ['firstRun', () => new FirstRunView($('firstRunHost'))],
];
const views = {};
const deadViews = [];
for (const [name, make] of VIEW_SPECS) {
  try {
    views[name] = make();
  } catch (err) {
    views[name] = null;
    deadViews.push(name);
    (window.__yjErrors = window.__yjErrors || []).push({ view: name, error: err });
  }
}

const auditioner = new ClipAuditioner(engine);

const ctx = {
  store, engine, meter, transcriber, sequencer, keybed, auditioner, views,
  $, COPY, status, statusFault, fmtTime, fmtDb, setLed,
  api: {},
};

// Controllers are independent surfaces, so one throwing must not take the
// others with it. Before this, a single failure in any init left the app
// half-built and completely silent: no error, no working bench, nothing to
// tell the user what happened. Now the rest still come up and the status bar
// names what died.
const CONTROLLERS = [
  ['bench', initBenchController],
  ['machine', initMachineController],
  ['repair', initRepairController],
  ['wire', initWireController],
  ['source', initSourceController],
  // persist is last on purpose: restore needs every api registered above it.
  ['persist', initPersistController],
];
const failed = [];
for (const [name, init] of CONTROLLERS) {
  try {
    init(ctx);
  } catch (err) {
    failed.push(name);
    // Keep the real error reachable for a bug report rather than swallowing it.
    (window.__yjErrors = window.__yjErrors || []).push({ controller: name, error: err });
  }
}

// Any api a dead controller never registered would throw on first use, turning
// one broken surface into a broken app. A hand-maintained list of names drifts
// the moment a controller adds one (the first version of this already missed
// getLiftRange, the single member whose RETURN VALUE is consumed), so missing
// members are answered dynamically instead. Reads of a live member are
// untouched; only absent ones resolve to a no-op.
if (failed.length && typeof Proxy === 'function') {
  const real = ctx.api;
  ctx.api = new Proxy(real, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== 'string') return undefined;
      return () => undefined;
    },
  });
}

// ---------- tabs ----------
function showTab(name) {
  for (const b of document.querySelectorAll('.yj-tab-btn')) {
    b.classList.toggle('is-active', b.dataset.tab === name);
  }
  for (const pane of document.querySelectorAll('.yj-tabpane')) pane.classList.remove('is-active');
  const pane = $('tab-' + name);
  if (pane) pane.classList.add('is-active');
  ctx.api.setKeybedEnabled(name === 'machine');
  // canvases need a size pass when they become visible
  // Hidden canvases measure 0, so anything revealed here needs a size pass.
  // Guarded per view: a view that failed to construct is null, not a reason
  // for every other canvas on the tab to stay unsized.
  for (const name of ['waveMini', 'waveMain', 'spec', 'sliceView', 'constellation']) {
    if (views[name]) views[name].render();
  }
}
ctx.api.showTab = showTab;

for (const btn of document.querySelectorAll('.yj-tab-btn')) {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
}

// The pipeline strip navigates by asking for a tab and, inside MACHINE, a
// substate; it clicks the real buttons so their own handlers still run.
if (views.pipeline) views.pipeline.addEventListener('jump', (e) => {
  const { tab, mstate } = e.detail.target || {};
  if (tab) showTab(tab);
  if (mstate) {
    const b = document.querySelector('.yj-substate-btn[data-mstate="' + mstate + '"]');
    if (b) b.click();
  }
});

// ---------- keys ----------
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  // A focused button owns Space (native click) — TAP TEMPO would double-fire otherwise.
  if (e.code === 'Space' && e.target.closest && e.target.closest('button')) return;
  if (e.code === 'Space') { e.preventDefault(); ctx.api.togglePlay(); }
  if (e.code === 'Home') engine.seek(0);
});

// Undo lives outside the typing guard above: it must work while a control has
// focus, but never while text is being edited.
window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.code !== 'KeyZ') return;
  if (e.target.matches('input[type="text"], input[type="url"], textarea, [contenteditable]')) return;
  e.preventDefault();
  if (e.shiftKey) ctx.api.redo();
  else ctx.api.undo();
});

// ---------- pipeline strip: recomputed from the document on every change ----------
function refreshPipeline() {
  if (views.pipeline) views.pipeline.setStages(deriveStages(store.project, store.runtime));
}
store.addEventListener('change', refreshPipeline);
refreshPipeline();

// ---------- first run ----------
// Shown once, only when there is nothing loaded. Taking a path counts as
// dismissing: the panel must not sit on top of the surface it just opened.
const FIRSTRUN_KEY = 'yj.firstrun.done';
const ROUTES = {
  kit: { tab: 'machine', mstate: 'slice' },
  clean: { tab: 'transcript' },
  synth: { tab: 'machine', mstate: 'crate' },
};
function markFirstRunDone() {
  try { localStorage.setItem(FIRSTRUN_KEY, '1'); } catch (e) { /* private mode: show it again */ }
}
function openStartRoute(path) {
  const route = ROUTES[path];
  if (!route) return;
  // SYNTH is deliberately source-free. The general intake overlay otherwise
  // remains above the route and makes this first-run choice impossible to use.
  if (path === 'synth') $('dropZone').classList.add('is-hidden');
  showTab(route.tab);
  if (route.mstate) {
    const b = document.querySelector('.yj-substate-btn[data-mstate="' + route.mstate + '"]');
    if (b) b.click();
  }
}
if (views.firstRun) views.firstRun.addEventListener('start', (e) => {
  markFirstRunDone();
  openStartRoute(e.detail.path);
});
if (views.firstRun) views.firstRun.addEventListener('dismiss', markFirstRunDone);
$('btnOpenSynth').addEventListener('click', () => {
  if (!$('resumePanel').hidden && typeof window.confirm === 'function'
    && !window.confirm('Start a new synth session? The saved resume session will be replaced after your first edit. CRATE instruments are kept.')) {
    status('SAVED SESSION KEPT');
    return;
  }
  markFirstRunDone();
  openStartRoute('synth');
});
try {
  if (views.firstRun && !localStorage.getItem(FIRSTRUN_KEY) && !store.runtime.buffer) views.firstRun.show();
} catch (e) { /* storage blocked: skip the overlay rather than break boot */ }

// ---------- boot ----------
if (failed.length || deadViews.length) {
  statusFault('STARTUP FAULT · ' + failed.concat(deadViews).join(', ').toUpperCase()
    + ' did not start. The rest of the bench is running. Details in the console: window.__yjErrors');
} else {
  status(COPY.idle);
}
ctx.api.statusRight();

// Debug handle for the curious (and for bug reports): poke the bench from the console.
window.__yj = {
  engine, store, transcriber, sequencer, auditioner, ...views,
  get project() { return store.project; },
  get runtime() { return store.runtime; },
  api: ctx.api,
};
