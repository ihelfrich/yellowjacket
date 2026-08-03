// Machine controller: clips, beatmap UI, pattern sequencer wiring, keybed, freeze.
// Moved from main.js in the STRUCTURE refactor; logic unchanged except sample
// assignment now also records an asset registry entry (persistence groundwork).

import { wordsToClip } from './cliprefs.js';
import { registerAsset } from '../app/project-store.js';
import { encodeWav, download } from '../export.js';
import { patternLoopSteps, normalizeVoice } from './compile.js';
import { CrateStore } from '../app/crate.js';
import { renderFormula } from './synth.js';
import { fitModal, synthModal } from '../analysis/modal.js';

const MAX_TRACK_SAMPLE_SEC = 30;

export function initMachineController(ctx) {
  const { store, engine, sequencer, keybed, auditioner, views, $, COPY, status, statusFault, setLed } = ctx;
  const { sliceView, patternView, songView, voiceView, crateView, clipList,
    constellation, synthView, pads, modalView } = views;
  const P = store.project;
  const R = store.runtime;

  let machineBpmTouched = false;

  sequencer.setMachine(P.machine);
  patternView.setMachine(P.machine);
  // Every path that fires a track goes through here, so the pads light whether
  // the hit came from the mouse, the QWERTY keys, incoming MIDI or the grid.
  function fireTrack(i, velocity = 1) {
    sequencer.trigger(i, 0, velocity);
    if (pads) pads.flash(i);
  }
  ctx.api.fireTrack = fireTrack;

  keybed.attach(
    (i) => fireTrack(i),
    (on) => {
      sequencer.fill = on;
      patternView.setFill(on);
    }
  );
  keybed.enabled = false;

  function machineHasSound() {
    return P.machine.tracks.some((t) => t.sample);
  }

  function setBeatmapLed(mode, text) {
    // One LED mapping for the whole bench: this used to hand-copy main.js's
    // setLed body, so a new state or a renamed class updated some LEDs only.
    setLed('ledBeatmap', mode);
    $('beatmapState').textContent = text;
  }

  function refreshClips() {
    const selId = sliceView.selectedClip ? sliceView.selectedClip.id : null;
    sliceView.setClips(P.clips);
    if (clipList) clipList.setClips(P.clips, selId);
    if (constellation) constellation.setClips(P.clips, selId);
    updateClipReadout();
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
    refreshClips();
  });
  sliceView.addEventListener('clipdelete', (e) => {
    store.update('clips', (p) => {
      // Splice in place: replacing the array strands every reference held
      // elsewhere, which CONTRACT-PERSIST forbids for exactly this reason.
      const i = p.clips.findIndex((c) => c.id === e.detail.id);
      if (i >= 0) p.clips.splice(i, 1);
    });
    refreshClips();
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
    const id = e.detail.clip ? e.detail.clip.id : null;
    if (clipList) clipList.setSelected(id);
    if (constellation) constellation.setSelected(id);
  });

  // ---------- constellation: the kit as a timbre map ----------
  if (constellation) {
    constellation.addEventListener('pick', (e) => {
      const clip = sliceView.selectClip(e.detail.id);
      if (clipList) clipList.setSelected(clip ? clip.id : null);
      if (clip) {
        auditioner.play(clip);
        patternView.setClipHint(clip.label || clip.tag);
        status('SLICE · ' + (clip.label || clip.tag) + ' · '
          + (clip.end - clip.start).toFixed(2) + 's');
      }
    });
  }

  // ---------- clip list: the readable half of SLICE ----------
  if (clipList) {
    clipList.addEventListener('select', (e) => {
      const clip = sliceView.selectClip(e.detail.id);
      clipList.setSelected(clip ? clip.id : null);
      patternView.setClipHint(clip ? (clip.label || clip.tag) : null);
    });
    clipList.addEventListener('audition', (e) => {
      const clip = P.clips.find((c) => c.id === e.detail.id);
      if (clip) auditioner.play(clip);
    });
    clipList.addEventListener('remove', (e) => {
      sliceView.dispatchEvent(new CustomEvent('clipdelete', { detail: { id: e.detail.id } }));
    });
    clipList.addEventListener('assign', (e) => {
      // Select it first so ASSIGN reads the clip the row belongs to, then drop
      // it on the first free track (or the last one if the kit is full).
      sliceView.selectClip(e.detail.id);
      clipList.setSelected(e.detail.id);
      const tracks = P.machine.tracks;
      let slot = tracks.findIndex((t) => !t.sample);
      if (slot < 0) slot = tracks.length - 1;
      patternView.dispatchEvent(new CustomEvent('assign', { detail: { track: slot } }));
    });
  }

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
      // HARVEST's role rides along as clip.tag; without it every fitted slice
      // would take the tonal path and smear drum transients.
      const role = clip.tag ? String(clip.tag).toUpperCase() : undefined;
      const id = registerAsset(p, { kind: 'sample', label, sampleRate: buf.sampleRate, frames: n, role });
      const track = p.machine.tracks[e.detail.track];
      track.sampleId = id;
      track.sample = { channels, sampleRate: buf.sampleRate, label, role };
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
  patternView.addEventListener('trig', (e) => fireTrack(e.detail.track));
  // ---------- LOCK: step data, scenes, fill ----------
  patternView.addEventListener('stepedit', (e) => {
    const { track, step, patch } = e.detail;
    store.update('stepdata', (p) => {
      const t = p.machine.tracks[track];
      if (!t) return;
      const sd = { ...(t.stepData[step] || {}) };
      for (const key of Object.keys(patch || {})) {
        const v = patch[key];
        if (v === null || v === undefined) delete sd[key];
        else sd[key] = v;
      }
      // Drop entries that carry only defaults so the model stays sparse.
      for (const key of Object.keys(sd)) {
        const v = sd[key];
        if ((key === 'velocity' && v === 1) || (key === 'ratchet' && v === 1)
          || (key === 'nudge' && v === 0) || (key === 'gate' && v === 0)
          || (key === 'prob' && v === 100) || (key === 'pitch' && v === 0)
          || (key === 'reverse' && !v) || (key === 'cond' && v === null)) {
          delete sd[key];
        }
      }
      if (Object.keys(sd).length) t.stepData[step] = sd;
      else delete t.stepData[step];
    });
    patternView.setMachine(P.machine);
  });
  patternView.addEventListener('clearstep', (e) => {
    store.update('stepdata', (p) => {
      const t = p.machine.tracks[e.detail.track];
      if (t) delete t.stepData[e.detail.step];
    });
    patternView.setMachine(P.machine);
  });
  patternView.addEventListener('scene', (e) => {
    const index = e.detail.index | 0;
    store.update('scene', (p) => {
      const m = p.machine;
      if (index < 0 || index >= m.scenes.length || index === m.activeScene) return;
      // Samples are machine-sticky: a scene without a kit inherits the outgoing
      // scene's sample refs (never copies PCM). Per-scene kits can come later.
      const from = m.scenes[m.activeScene];
      const to = m.scenes[index];
      for (let i = 0; i < to.tracks.length; i++) {
        if (!to.tracks[i].sample && from.tracks[i] && from.tracks[i].sample) {
          to.tracks[i].sample = from.tracks[i].sample;
          to.tracks[i].sampleId = from.tracks[i].sampleId;
        }
      }
      m.activeScene = index;
    });
    patternView.setMachine(P.machine);
    // Send amounts are per track and are baked into the strip graph, so the
    // strips must be rebuilt from the incoming scene's tracks.
    if (typeof sequencer.bumpStrips === 'function') sequencer.bumpStrips();
    status('SCENE ' + (index + 1) + (sequencer.running ? ' · RUNNING' : ''));
  });
  patternView.addEventListener('scenecopy', (e) => {
    const { from, to } = e.detail;
    store.update('scene', (p) => {
      const m = p.machine;
      const src = m.scenes[from | 0];
      const dst = m.scenes[to | 0];
      if (!src || !dst || src === dst) return;
      dst.bpm = src.bpm;
      dst.swing = src.swing;
      dst.seed = src.seed;
      dst.tracks = src.tracks.map((t) => ({
        ...t,
        steps: t.steps.slice(),
        stepData: JSON.parse(JSON.stringify(t.stepData || {})),
        // sample/sampleId are shared references by design: pattern data copies, PCM never does
      }));
      m.activeScene = to | 0;
    });
    patternView.setMachine(P.machine);
    status('SCENE ' + ((from | 0) + 1) + ' COPIED TO ' + ((to | 0) + 1));
  });
  patternView.addEventListener('fill', (e) => {
    sequencer.fill = !!e.detail.on;
  });
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
    // Select it, which is real machinery, rather than the flashClip() that was
    // guarded for and never existed on SliceView.
    sliceView.selectClip(clip.id);
    if (clipList) clipList.setSelected(clip.id);
  });

  // ---------- substate switcher ----------
  for (const btn of document.querySelectorAll('.yj-substate-btn')) {
    btn.addEventListener('click', () => {
      for (const b of document.querySelectorAll('.yj-substate-btn')) b.classList.toggle('is-active', b === btn);
      for (const pane of document.querySelectorAll('.yj-mstate')) pane.classList.remove('is-active');
      $('mstate-' + btn.dataset.mstate).classList.add('is-active');
      if (btn.dataset.mstate === 'slice') {
        sliceView.render();
        if (constellation) constellation.render();
      }
    });
  }

  // ---------- per-source reset ----------
  function resetForSource() {
    sliceView.setSource(R.mono, R.sampleRate, R.peaks);
    sliceView.setWords(null);
    refreshClips();
    setBeatmapLed('off', COPY.notAnalyzed);
    $('sliceNote').textContent = COPY.computingSpec;
  }

  // ---------- SONG: voice drawer + arrangement (CONTRACT-SONG) ----------
  let voiceTrack = -1;

  function openVoice(track) {
    voiceTrack = track;
    const t = P.machine.tracks[track];
    if (t && !t.voice) t.voice = normalizeVoice(null);   // pre-SONG saves
    $('voiceHost').hidden = false;
    voiceView.setTrack(track, t);
    // Reveal first, then draw: a canvas measured while hidden reads zero.
    if (voiceView.render) requestAnimationFrame(() => voiceView.render());
  }

  patternView.addEventListener('voiceopen', (e) => openVoice(e.detail.track));
  voiceView.addEventListener('close', () => { $('voiceHost').hidden = true; voiceTrack = -1; });
  voiceView.addEventListener('trig', (e) => fireTrack(e.detail.track));
  // Sends live on the track, not the voice: they are mix controls, and they
  // sit with gain and pan (CONTRACT-CONFORM 4).
  voiceView.addEventListener('send', (e) => {
    const { track, which, value } = e.detail;
    store.update('mix', (p) => {
      const t = p.machine.tracks[track];
      if (t) t[which] = Math.max(0, Math.min(1, value));
    });
    sequencer.bumpStrips ? sequencer.bumpStrips() : null;
  });
  voiceView.addEventListener('voiceedit', (e) => {
    const { track, patch } = e.detail;
    store.update('voice', (p) => {
      const t = p.machine.tracks[track];
      if (!t) return;
      if (!t.voice) t.voice = normalizeVoice(null);
      Object.assign(t.voice, patch);
    });
    // Bake now, while the user is still turning the knob. A fitted bake costs
    // a couple of hundred milliseconds and would drop frames if it happened
    // when they hit play (CONTRACT-CONFORM 3).
    if ('fitSteps' in patch || 'reverse' in patch) {
      const steps = P.machine.tracks[track] && P.machine.tracks[track].voice.fitSteps;
      if (steps > 0) {
        status('FITTING · stretching the slice to ' + steps + ' steps', true);
        setTimeout(() => {
          sequencer.prebake();
          status('FIT · ' + steps + ' STEPS AT ' + P.machine.bpm.toFixed(1) + ' BPM');
        }, 0);
      }
    }
  });

  // Section seconds without compiling events: steps x stepDur x reps per entry.
  function songSectionSecs() {
    return P.machine.song.chain.map((entry) => {
      const scene = P.machine.scenes[entry.scene | 0];
      if (!scene) return 0;
      const steps = patternLoopSteps(scene.tracks);
      return steps * (60 / (scene.bpm || 120) / 4) * entry.reps;
    });
  }

  function refreshSong() {
    songView.setSong(P.machine.song, P.machine.scenes, songSectionSecs(), P.machine.activeScene);
  }

  songView.addEventListener('chainedit', (e) => {
    store.update('song', (p) => {
      p.machine.song.chain.length = 0;
      for (const entry of e.detail.chain) p.machine.song.chain.push(entry);
    });
    refreshSong();
  });
  songView.addEventListener('loop', (e) => {
    store.update('song', (p) => { p.machine.song.loop = !!e.detail.loop; });
  });
  songView.addEventListener('audition', (e) => {
    patternView.dispatchEvent(new CustomEvent('scene', { detail: { index: e.detail.scene } }));
    refreshSong();
  });
  songView.addEventListener('play', () => {
    sequencer.playSong();
    songView.setPlaying(sequencer.songPlaying);
    if (sequencer.songPlaying) status('SONG RUNNING · every pass rolls the same dice');
    else statusFault('SONG · nothing to play. Add sections with sound in them.');
  });
  songView.addEventListener('stop', () => {
    sequencer.stopSong();
    songView.setPlaying(false);
    status(COPY.loaded);
  });
  songView.addEventListener('render', async () => {
    try {
      status('RENDERING SONG…', true);
      const { bytes, stats, totalSec } = await sequencer.renderSongWav(24);
      const stem = (P.fileName || 'yellowjacket').replace(/\.[^.]+$/, '');
      download(bytes, stem + '-song.wav', 'audio/wav');
      const parts = ['SONG PRINTED · ' + totalSec.toFixed(1) + 'S · 24-BIT'];
      if (stats && stats.overs) parts.push(stats.overs + ' OVERS');
      status(parts.join(' · '));
    } catch (err) {
      statusFault('SONG RENDER FAULT · ' + (err.message || err));
    }
  });
  sequencer.addEventListener('songpos', (e) => songView.setPosition(e.detail.section, e.detail.rep));
  sequencer.addEventListener('songend', () => {
    if (!P.machine.song.loop) songView.setPlaying(false);
  });
  // Scene edits change section durations; keep the readout honest.
  store.addEventListener('change', (e) => {
    const kind = e.detail && e.detail.kind;
    if (kind === 'machine' || kind === 'scene' || kind === 'source') refreshSong();
  });
  refreshSong();

  // ---------- HARVEST: mine the whole track for a labeled kit ----------
  let harvestWorker = null;

  function runHarvest() {
    if (!R.mono || !R.analysis || !R.analysis.onsets) {
      statusFault('HARVEST · analyze the track first. The beatmap finds the onsets it mines.');
      return;
    }
    const btn = $('btnHarvest');
    btn.disabled = true;
    btn.classList.add('is-working');
    status('HARVESTING…', true);
    if (!harvestWorker) {
      harvestWorker = new Worker(new URL('../../workers/harvest-worker.js', import.meta.url), { type: 'module' });
    }
    const gen = R.generation;
    harvestWorker.onmessage = (e) => {
      btn.disabled = false;
      btn.classList.remove('is-working');
      const msg = e.data || {};
      if (gen !== R.generation) return;
      if (msg.type === 'error') {
        statusFault('HARVEST FAULT · ' + msg.message);
        return;
      }
      const picks = msg.picks || [];
      if (!picks.length) {
        statusFault('HARVEST · nothing worth keeping. The track may be too quiet or too dense.');
        return;
      }
      store.update('clips', (p) => {
        p.clips.length = 0;
        for (let i = 0; i < picks.length; i++) {
          const pick = picks[i];
          p.clips.push({
            id: 'h' + (i + 1),
            start: pick.t0,
            end: pick.t1,
            tag: pick.role.toLowerCase(),
            label: pick.label,
            score: pick.score,
            features: pick.features,   // the constellation projects these
          });
        }
      });
      refreshClips();
      const roles = {};
      for (const pick of picks) roles[pick.role] = (roles[pick.role] || 0) + 1;
      const spread = picks[picks.length - 1].t0 - picks[0].t0;
      status('HARVEST · ' + picks.length + ' SLICES ACROSS ' + spread.toFixed(0) + 'S · '
        + Object.keys(roles).map((r) => r + ' ' + roles[r]).join(' '));
    };
    harvestWorker.onerror = () => {
      btn.disabled = false;
      btn.classList.remove('is-working');
      statusFault('HARVEST FAULT · worker error');
    };
    const mono = R.mono.slice();
    harvestWorker.postMessage(
      { type: 'harvest', mono, sampleRate: R.sampleRate, onsets: Array.from(R.analysis.onsets) },
      [mono.buffer],
    );
  }

  $('btnHarvest').addEventListener('click', runHarvest);
  store.addEventListener('change', () => {
    $('btnHarvest').disabled = !(R.mono && R.analysis && R.analysis.onsets);
  });

  // ---------- CRATE: instruments that outlive the session ----------
  let crate = null;

  async function refreshCrate() {
    if (!crate) return;
    try {
      crateView.setInstruments(await crate.list());
    } catch (e) {
      statusFault('CRATE FAULT · ' + (e.message || e));
    }
  }

  async function crateTrack(index) {
    if (!crate) {
      statusFault('CRATE · this browser has no origin-private storage, so instruments cannot be saved.');
      return;
    }
    const track = P.machine.tracks[index];
    if (!track || !track.sample) return;
    const meta = P.assets[track.sampleId];
    try {
      crateView.setBusy(true);
      const name = (meta && meta.label) || ('TRACK ' + (index + 1));
      await crate.put({
        name,
        role: (meta && meta.role) || 'VOICE',
        source: P.fileName || 'unknown source',
        voice: { ...track.voice },
        sampleRate: track.sample.sampleRate,
        pcm: track.sample.channels[0],
      });
      await refreshCrate();
      status('CRATED · ' + name.toUpperCase() + ' · it outlives this session');
    } catch (e) {
      statusFault('CRATE FAULT · ' + (e.message || e));
    } finally {
      crateView.setBusy(false);
    }
  }

  async function loadFromCrate(id) {
    if (!crate) return;
    try {
      crateView.setBusy(true);
      const { meta, pcm } = await crate.get(id);
      if (!pcm) throw new Error('instrument audio is missing');
      const tracks = P.machine.tracks;
      let slot = tracks.findIndex((t) => !t.sample);
      if (slot < 0) slot = tracks.length - 1;
      store.update('assets', (p) => {
        const assetId = registerAsset(p, {
          kind: 'sample',
          label: meta.name,
          sampleRate: meta.sampleRate,
          frames: pcm.length,
          role: meta.role,
        });
        const track = p.machine.tracks[slot];
        track.sampleId = assetId;
        track.sample = { channels: [pcm], sampleRate: meta.sampleRate, label: meta.name, role: meta.role };
        if (meta.voice) Object.assign(track.voice, meta.voice);
      });
      sequencer.bumpTrack(slot);
      patternView.setMachine(P.machine);
      status('LOADED · ' + meta.name.toUpperCase() + ' → TRACK ' + (slot + 1)
        + ' · FROM ' + String(meta.source).toUpperCase());
    } catch (e) {
      statusFault('CRATE FAULT · ' + (e.message || e));
    } finally {
      crateView.setBusy(false);
    }
  }

  if (crateView) {
    crateView.addEventListener('load', (e) => loadFromCrate(e.detail.id));
    crateView.addEventListener('refresh', refreshCrate);
    crateView.addEventListener('delete', async (e) => {
      if (!crate) return;
      try {
        await crate.remove(e.detail.id);
        await refreshCrate();
        status('CRATE · INSTRUMENT REMOVED');
      } catch (err) {
        statusFault('CRATE FAULT · ' + (err.message || err));
      }
    });
    voiceView.addEventListener('crate', (e) => crateTrack(e.detail.track));
    CrateStore.open().then((store2) => {
      crate = store2;
      refreshCrate();
    });
  }

  // ---------- SYNTH: a sound written as maths ----------
  if (synthView) {
    let synthPcm = null;

    function drawSynthPlot(pcm) {
      const c = synthView.plotCanvas;
      if (!c || !c.getContext) return;
      const rect = c.getBoundingClientRect();
      if (!rect.width || !rect.height) return;   // hidden pane measures zero
      const dpr = Math.min(2, devicePixelRatio || 1);
      c.width = Math.round(rect.width * dpr);
      c.height = Math.round(rect.height * dpr);
      const g = c.getContext('2d');
      g.clearRect(0, 0, c.width, c.height);
      if (!pcm || !pcm.length) return;
      const mid = c.height / 2;
      g.strokeStyle = getComputedStyle(c).getPropertyValue('--yj-yellow').trim() || '#FFD400';
      g.lineWidth = 1;
      g.beginPath();
      const cols = c.width;
      const per = Math.max(1, Math.floor(pcm.length / cols));
      for (let x = 0; x < cols; x++) {
        let lo = 1;
        let hi = -1;
        const from = x * per;
        for (let i = from; i < from + per && i < pcm.length; i++) {
          if (pcm[i] < lo) lo = pcm[i];
          if (pcm[i] > hi) hi = pcm[i];
        }
        g.moveTo(x + 0.5, mid - hi * mid * 0.92);
        g.lineTo(x + 0.5, mid - lo * mid * 0.92);
      }
      g.stroke();
    }

    function buildSynth(detail) {
      const rate = R.sampleRate || 44100;
      try {
        const pcm = renderFormula(detail.formula, { sampleRate: rate, seconds: detail.seconds });
        synthPcm = pcm;
        synthView.setStatus(true, Math.round(pcm.length / rate * 1000) + ' ms · ' + rate + ' Hz');
        drawSynthPlot(pcm);
        return pcm;
      } catch (err) {
        synthPcm = null;
        synthView.setStatus(false, String(err.message || err));
        drawSynthPlot(null);
        return null;
      }
    }

    synthView.addEventListener('formula', (e) => buildSynth(e.detail));
    synthView.addEventListener('preview', (e) => {
      const pcm = buildSynth(e.detail) || synthPcm;
      if (!pcm || !engine.ctx) {
        if (!engine.ctx) statusFault('Press play once first: the audio engine wakes on a gesture.');
        return;
      }
      const rate = R.sampleRate || 44100;
      const buf = engine.ctx.createBuffer(1, pcm.length, rate);
      buf.getChannelData(0).set(pcm);
      const src = engine.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(engine.master);
      src.start();
    });
    synthView.addEventListener('make', (e) => {
      const pcm = buildSynth(e.detail);
      if (!pcm) return;
      const rate = R.sampleRate || 44100;
      const tracks = P.machine.tracks;
      let slot = tracks.findIndex((t) => !t.sample);
      if (slot < 0) slot = tracks.length - 1;
      store.update('assets', (p) => {
        const id = registerAsset(p, {
          kind: 'synth', label: e.detail.name, sampleRate: rate,
          frames: pcm.length, role: e.detail.role, formula: e.detail.formula,
        });
        const track = p.machine.tracks[slot];
        track.sampleId = id;
        // The formula rides on the sample so a synth voice can be re-rendered
        // or read back later; the sequencer only ever sees PCM.
        track.sample = {
          channels: [pcm], sampleRate: rate, label: e.detail.name,
          role: e.detail.role, formula: e.detail.formula,
        };
      });
      sequencer.bumpTrack(slot);
      patternView.setMachine(P.machine);
      status('SYNTH · ' + e.detail.name + ' → TRACK ' + (slot + 1) + ' · ' + e.detail.formula.slice(0, 40));
    });

    ctx.api.synthRedraw = () => { if (synthPcm) drawSynthPlot(synthPcm); };
  }

  if (pads) {
    pads.addEventListener('trig', (e) => fireTrack(e.detail.track, e.detail.velocity));
    pads.setTracks(P.machine.tracks);
    sequencer.addEventListener('step', (e) => pads.setPlayingStep(e.detail.step));
    store.addEventListener('change', (ev) => {
      const kind = ev.detail && ev.detail.kind;
      if (kind === 'machine' || kind === 'assets' || kind === 'scene' || kind === 'history') {
        pads.setTracks(P.machine.tracks);
      }
    });
  }

  // ---------- MODAL: a recorded hit as a table of numbers ----------
  // A struck resonant sound genuinely IS a sum of damped sinusoids, so a
  // harvested kick can be shown as its own equation, edited, and heard. The
  // SYNTH panel writes that maths by hand; this extracts it from a recording.
  if (modalView) {
    let modalFit = null;
    let modalModes = null;     // the user's edited copy, which drifts from the fit
    let modalRate = 44100;
    let modalName = 'MODAL';

    function slicePcm(clip) {
      if (!clip || !R.mono) return null;
      const sr = R.sampleRate;
      const s = Math.max(0, Math.floor(clip.start * sr));
      const e = Math.min(R.mono.length, Math.ceil(clip.end * sr));
      return e - s > 64 ? R.mono.slice(s, e) : null;
    }

    function playPcm(pcm) {
      if (!pcm || !pcm.length || !engine.ctx) {
        if (!engine.ctx) statusFault('Press play once first: the audio engine wakes on a gesture.');
        return;
      }
      const buf = engine.ctx.createBuffer(1, pcm.length, modalRate);
      buf.getChannelData(0).set(pcm);
      const src = engine.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(engine.master);
      src.start();
    }

    function fitSelected() {
      const clip = sliceView.selectedClip;
      const pcm = slicePcm(clip);
      if (!pcm) {
        statusFault('MODAL · select a slice in SLICE first. It needs a bit of audio to fit.');
        return;
      }
      modalRate = R.sampleRate;
      modalName = (clip.label || clip.tag || 'MODAL').toUpperCase().slice(0, 16);
      status('FITTING…', true);
      modalView.setBusy(true);
      // Off the click so the busy state paints before a fit that can take a
      // noticeable moment on a long slice.
      setTimeout(() => {
        try {
          modalFit = fitModal(pcm, modalRate);
          modalModes = modalFit.modes.map((m) => ({ ...m }));
          modalView.setFit(modalFit, modalRate);
          const n = modalFit.modes.length;
          status('MODAL · ' + n + (n === 1 ? ' MODE' : ' MODES')
            + ' · RESIDUAL ' + modalFit.fitDb.toFixed(1) + ' dB · ' + modalName);
        } catch (err) {
          modalFit = null;
          modalModes = null;
          modalView.setFit(null, modalRate);
          statusFault('MODAL FAULT · ' + (err.message || err));
        } finally {
          modalView.setBusy(false);
        }
      }, 0);
    }

    $('btnFitModal').addEventListener('click', fitSelected);
    store.addEventListener('change', () => {
      $('btnFitModal').disabled = !(R.mono && sliceView.selectedClip);
    });
    sliceView.addEventListener('clipselect', () => {
      $('btnFitModal').disabled = !(R.mono && sliceView.selectedClip);
    });

    // Edits arrive per keystroke. They update the model rather than firing
    // audio, because resynthesizing on every character would be unusable;
    // HEAR MODEL plays whatever the table currently says.
    modalView.addEventListener('edit', (e) => { modalModes = e.detail.modes; });

    modalView.addEventListener('hear', (e) => {
      if (!modalFit) return;
      const seconds = modalFit.residual.length / modalRate;
      if (e.detail.what === 'original') {
        playPcm(slicePcm(sliceView.selectedClip));
      } else if (e.detail.what === 'residual') {
        // What the model could NOT express: the beater click without the shell.
        playPcm(modalFit.residual);
      } else {
        playPcm(synthModal(modalModes || modalFit.modes, modalRate, seconds));
      }
    });

    modalView.addEventListener('make', (e) => {
      const modes = e.detail.modes && e.detail.modes.length ? e.detail.modes : modalModes;
      if (!modes || !modes.length || !modalFit) {
        statusFault('MODAL · nothing to make. Fit a slice first.');
        return;
      }
      const seconds = modalFit.residual.length / modalRate;
      const pcm = synthModal(modes, modalRate, seconds);
      const tracks = P.machine.tracks;
      let slot = tracks.findIndex((t) => !t.sample);
      if (slot < 0) slot = tracks.length - 1;
      const name = e.detail.name || modalName;
      store.update('assets', (p) => {
        const id = registerAsset(p, {
          kind: 'modal', label: name, sampleRate: modalRate,
          frames: pcm.length, role: 'TONE', modes: modes.map((m) => ({ ...m })),
        });
        const track = p.machine.tracks[slot];
        track.sampleId = id;
        track.sample = { channels: [pcm], sampleRate: modalRate, label: name, role: 'TONE' };
      });
      sequencer.bumpTrack(slot);
      patternView.setMachine(P.machine);
      if (pads) pads.setTracks(P.machine.tracks);
      status('MODAL · ' + name + ' → TRACK ' + (slot + 1) + ' · ' + modes.length + ' MODES RESYNTHESIZED');
    });
  }

  ctx.api.machineReset = resetForSource;
  ctx.api.updateClipReadout = refreshClips;
  ctx.api.songRefresh = refreshSong;
  ctx.api.crateRefresh = refreshCrate;
  ctx.api.setKeybedEnabled = (b) => { keybed.enabled = b; };
}
