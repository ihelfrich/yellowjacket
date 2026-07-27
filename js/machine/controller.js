// Machine controller: clips, beatmap UI, pattern sequencer wiring, keybed, freeze.
// Moved from main.js in the STRUCTURE refactor; logic unchanged except sample
// assignment now also records an asset registry entry (persistence groundwork).

import { wordsToClip } from './cliprefs.js';
import { registerAsset } from '../app/project-store.js';
import { encodeWav, download } from '../export.js';

const MAX_TRACK_SAMPLE_SEC = 30;

export function initMachineController(ctx) {
  const { store, engine, sequencer, keybed, auditioner, views, $, COPY, status, statusFault, setLed } = ctx;
  const { sliceView, patternView } = views;
  const P = store.project;
  const R = store.runtime;

  let machineBpmTouched = false;

  sequencer.setMachine(P.machine);
  patternView.setMachine(P.machine);
  keybed.attach((i) => sequencer.trigger(i));
  keybed.enabled = false;

  function machineHasSound() {
    return P.machine.tracks.some((t) => t.sample);
  }

  function setBeatmapLed(mode, text) {
    const led = $('ledBeatmap');
    led.className = 'yj-led' + (mode === 'on' ? ' is-on' : mode === 'busy' ? ' is-busy' : mode === 'fault' ? ' is-fault' : '');
    $('beatmapState').textContent = text;
  }

  function updateClipReadout() {
    $('roClips').textContent = P.clips.length
      ? P.clips.length + (P.clips.length === 1 ? ' CLIP' : ' CLIPS')
      : COPY.noClips;
  }

  // ---------- analysis UI hooks (source-controller drives the worker) ----------
  ctx.api.analysisStarted = () => {
    if (typeof sliceView.setAnalyzing === 'function') sliceView.setAnalyzing(true);
    setBeatmapLed('busy', COPY.mapping);
  };
  ctx.api.analysisDone = (analysis) => {
    if (typeof sliceView.setAnalyzing === 'function') sliceView.setAnalyzing(false);
    sliceView.setAnalysis(analysis);
    const conf = analysis.confidence || 0;
    // A confident tempo seeds the machine clock, unless the user already set one.
    if (conf >= 0.6 && !machineBpmTouched && analysis.tempo > 0) {
      store.update('machine', (p) => { p.machine.bpm = Math.round(analysis.tempo); });
      patternView.setMachine(P.machine);
    }
    if (!analysis.beats || !analysis.beats.length) {
      setBeatmapLed('fault', COPY.notAnalyzed);
    } else if (conf >= 0.6) {
      setBeatmapLed('on', COPY.mapped + ' · ' + analysis.tempo.toFixed(1) + ' BPM');
    } else if (conf >= 0.3) {
      setBeatmapLed('busy', analysis.tempo.toFixed(1) + ' BPM · ROUGH');
    } else {
      setBeatmapLed('fault', COPY.lowConfidence);
    }
    $('sliceNote').textContent = COPY.sliceReady;
  };
  ctx.api.analysisFault = (message) => {
    if (typeof sliceView.setAnalyzing === 'function') sliceView.setAnalyzing(false);
    setBeatmapLed('fault', COPY.mapFault);
    statusFault(COPY.mapFault + ' — ' + message);
  };

  // ---------- slice view wiring ----------
  sliceView.addEventListener('clipadd', (e) => {
    store.update('clips', (p) => { p.clips.push(e.detail.clip); });
    sliceView.setClips(P.clips);
    updateClipReadout();
  });
  sliceView.addEventListener('clipdelete', (e) => {
    store.update('clips', (p) => { p.clips = p.clips.filter((c) => c.id !== e.detail.id); });
    sliceView.setClips(P.clips);
    updateClipReadout();
  });
  sliceView.addEventListener('audition', (e) => auditioner.play(e.detail.clip));
  sliceView.addEventListener('anchorchange', (e) => {
    const anchors = { bpm: e.detail.bpm ?? null, barOneTime: e.detail.barOneTime ?? null };
    if (R.analysis) R.analysis.anchors = anchors;
    ctx.api.runAnalysis(anchors, false); // envelope cached in the worker; anchors-only is cheap
  });
  sliceView.addEventListener('analyze', () => ctx.api.runAnalysis(null, true));
  sliceView.addEventListener('exportloop', (e) => {
    const clip = e.detail.clip;
    if (!clip || !R.buffer) return;
    const buf = R.buffer;
    const s = Math.max(0, Math.floor(clip.start * buf.sampleRate));
    const n = Math.min(buf.length, Math.ceil(clip.end * buf.sampleRate)) - s;
    if (n <= 0) return;
    const out = new AudioBuffer({ length: n, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
    for (let c = 0; c < buf.numberOfChannels; c++) {
      out.getChannelData(c).set(buf.getChannelData(c).subarray(s, s + n));
    }
    const base = (P.fileName || 'yellowjacket').replace(/\.[^.]+$/, '');
    const label = (clip.label || clip.tag || 'clip').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'clip';
    download(encodeWav(out, 16), base + '.' + label + '.wav', 'audio/wav');
    status('LOOP EXPORTED · ' + (n / buf.sampleRate).toFixed(2) + 's');
  });
  sliceView.addEventListener('clipselect', (e) => {
    patternView.setClipHint(e.detail.clip ? (e.detail.clip.label || e.detail.clip.tag) : null);
  });

  // ---------- pattern wiring ----------
  patternView.addEventListener('togglestep', (e) => {
    store.update('pattern', (p) => {
      const t = p.machine.tracks[e.detail.track];
      t.steps[e.detail.step] = t.steps[e.detail.step] ? 0 : 1;
    });
    patternView.setMachine(P.machine);
  });
  patternView.addEventListener('assign', (e) => {
    const clip = sliceView.selectedClip;
    if (!clip || !R.buffer) {
      statusFault('Select a clip in SLICE first, then assign it.');
      return;
    }
    const buf = R.buffer;
    const s = Math.max(0, Math.floor(clip.start * buf.sampleRate));
    let n = Math.min(buf.length, Math.ceil(clip.end * buf.sampleRate)) - s;
    if (n <= 0) return;
    const cap = MAX_TRACK_SAMPLE_SEC * buf.sampleRate;
    let trimmed = false;
    if (n > cap) { n = cap; trimmed = true; }
    const channels = [];
    for (let c = 0; c < buf.numberOfChannels; c++) {
      channels.push(buf.getChannelData(c).slice(s, s + n));
    }
    store.update('machine', (p) => {
      const label = clip.label || clip.tag;
      const id = registerAsset(p, { kind: 'sample', label, sampleRate: buf.sampleRate, frames: n });
      const track = p.machine.tracks[e.detail.track];
      track.sampleId = id;
      track.sample = { channels, sampleRate: buf.sampleRate, label };
    });
    sequencer.bumpTrack(e.detail.track);
    patternView.setMachine(P.machine);
    status(trimmed
      ? 'ASSIGNED · TRIMMED TO ' + MAX_TRACK_SAMPLE_SEC + 's (TRACK ' + (e.detail.track + 1) + ')'
      : 'ASSIGNED · TRACK ' + (e.detail.track + 1) + ' · ' + (clip.label || clip.tag));
  });
  patternView.addEventListener('cleartrack', (e) => {
    store.update('machine', (p) => {
      const track = p.machine.tracks[e.detail.track];
      track.sample = null;
      track.sampleId = null;
    });
    sequencer.bumpTrack(e.detail.track);
    patternView.setMachine(P.machine);
  });
  patternView.addEventListener('mix', (e) => {
    store.update('machine', (p) => { p.machine.tracks[e.detail.track][e.detail.key] = e.detail.value; });
    patternView.setMachine(P.machine);
  });
  patternView.addEventListener('bpm', (e) => {
    store.update('machine', (p) => { p.machine.bpm = e.detail.bpm; });
    machineBpmTouched = true;
    patternView.setMachine(P.machine);
  });
  patternView.addEventListener('swing', (e) => {
    store.update('machine', (p) => { p.machine.swing = e.detail.swing; });
    patternView.setMachine(P.machine);
  });
  patternView.addEventListener('trig', (e) => sequencer.trigger(e.detail.track));
  patternView.addEventListener('run', () => {
    if (!machineHasSound()) {
      statusFault('Nothing to run. Carve a clip in SLICE and assign it to a track.');
      return;
    }
    if (engine.playing) engine.pause();
    sequencer.start();
  });
  patternView.addEventListener('stopreq', () => sequencer.stop());
  patternView.addEventListener('freeze', async (e) => {
    if (!machineHasSound()) {
      statusFault('Nothing to freeze. The machine is empty.');
      return;
    }
    const wasRunning = sequencer.running;
    if (wasRunning) sequencer.stop();
    status('FREEZING · ' + e.detail.loops + (e.detail.loops === 1 ? ' LOOP' : ' LOOPS'), true);
    try {
      const blob = await sequencer.renderWav(e.detail.loops);
      await ctx.api.loadArrayBuffer(await blob.arrayBuffer(), 'machine.freeze.wav');
      status('FREEZE OK · the loop is the bench source now. The machine keeps its pattern.');
    } catch (err) {
      statusFault('FREEZE FAULT · ' + (err.message || err));
    }
  });

  sequencer.addEventListener('step', (e) => {
    patternView.setPlayhead(e.detail.loopStep % 64);
  });
  sequencer.addEventListener('state', (e) => {
    patternView.setRunning(e.detail.running);
    if (e.detail.running) {
      status('MACHINE RUNNING · ' + P.machine.bpm + ' BPM', true);
    } else {
      patternView.setPlayhead(null);
      status(COPY.loaded);
    }
  });

  // ---------- lift from transcript ----------
  $('btnLift').addEventListener('click', () => {
    const range = ctx.api.getLiftRange();
    if (!range || !P.words) return;
    const clip = wordsToClip(P.words, range.i0, range.i1);
    store.update('clips', (p) => { p.clips.push(clip); });
    sliceView.setClips(P.clips);
    updateClipReadout();
    document.querySelector('.yj-tab-btn[data-tab="machine"]').click();
    if (typeof sliceView.flashClip === 'function') sliceView.flashClip(clip.id);
  });

  // ---------- substate switcher ----------
  for (const btn of document.querySelectorAll('.yj-substate-btn')) {
    btn.addEventListener('click', () => {
      for (const b of document.querySelectorAll('.yj-substate-btn')) b.classList.toggle('is-active', b === btn);
      for (const pane of document.querySelectorAll('.yj-mstate')) pane.classList.remove('is-active');
      $('mstate-' + btn.dataset.mstate).classList.add('is-active');
      if (btn.dataset.mstate === 'slice') sliceView.render();
    });
  }

  // ---------- per-source reset ----------
  function resetForSource() {
    sliceView.setSource(R.mono, R.sampleRate, R.peaks);
    sliceView.setWords(null);
    sliceView.setClips(P.clips);
    updateClipReadout();
    setBeatmapLed('off', COPY.notAnalyzed);
    $('sliceNote').textContent = COPY.computingSpec;
  }

  ctx.api.machineReset = resetForSource;
  ctx.api.updateClipReadout = updateClipReadout;
  ctx.api.setKeybedEnabled = (b) => { keybed.enabled = b; };
}
