// Machine controller: clips, beatmap UI, pattern sequencer wiring, keybed, freeze.
// Moved from main.js in the STRUCTURE refactor; logic unchanged except sample
// assignment now also records an asset registry entry (persistence groundwork).

import { cutExcerpt, excerptKey, ExcerptCache } from '../loom/excerpt.js';
import { createVoice, registerAsset } from '../app/project-store.js';
import { buildBundle } from '../app/project-bundle.js';
import { encodeWav, download } from '../export.js';
import { buildDrumPatch } from '../export/op1patch.js';
import { resample, PLAYBACK_CUTOFF_SCALE } from '../dsp/resample.js';
import { patternLoopSteps, normalizeVoice } from './compile.js';
import { CrateStore } from '../app/crate.js';
import { renderFormula } from './synth.js';
import { fitModal, synthModal } from '../analysis/modal.js';
import { planKitAssignment, kitGainFor, peakOfChannels } from '../analysis/harvest.js';
import {
  FACTORY_KITS, drumAssetId, getFactoryKit, grooveFor, renderFactoryKit,
  starterGrooveForRoles,
} from './kits.js';
import { sourceMatchesPlan } from '../loom/compile.js';

const MAX_TRACK_SAMPLE_SEC = 30;

export function initMachineController(ctx) {
  const { store, engine, sequencer, keybed, auditioner, views, $, COPY, status, statusFault, setLed } = ctx;
  const { sliceView, patternView, kitView, songView, voiceView, crateView, clipList,
    constellation, synthView, pads, modalView } = views;
  const P = store.project;
  const R = store.runtime;

  let machineBpmTouched = false;
  let semanticPrintBusy = false;

  sequencer.setMachine(P.machine);
  patternView.setMachine(P.machine);

  function activeSemanticTake() {
    const sceneIndex = P.machine.activeScene | 0;
    const scene = P.machine.scenes[sceneIndex];
    const lane = scene && scene.loomLane;
    const plans = P.loom && P.loom.plans ? P.loom.plans : {};
    const plan = lane && lane.planId ? plans[lane.planId] || null : null;
    const size = R.sourceBytes ? R.sourceBytes.byteLength : null;
    const online = !!plan && sourceMatchesPlan(plan, {
      id: R.sourceHash,
      hash: R.sourceHash,
      name: P.fileName,
      size,
    });
    return { sceneIndex, scene, lane, plan, online, size };
  }

  function refreshSemanticLane() {
    if (!patternView || typeof patternView.setLoomLane !== 'function') return;
    const take = activeSemanticTake();
    patternView.setLoomLane({
      lane: take.lane,
      plan: take.plan,
      online: take.online,
      sceneLabel: take.scene ? take.scene.name : 'SCENE ' + (take.sceneIndex + 1),
    });
  }

  const excerptCache = new ExcerptCache();
  sequencer.setPerformanceSources({
    plans: () => (P.loom && P.loom.plans) || {},
    bufferFor: (planId) => {
      const plans = P.loom && P.loom.plans ? P.loom.plans : {};
      const plan = planId ? plans[planId] : null;
      if (!plan || !R.buffer) return null;
      const size = R.sourceBytes ? R.sourceBytes.byteLength : null;
      return sourceMatchesPlan(plan, {
        id: R.sourceHash,
        hash: R.sourceHash,
        name: P.fileName,
        size,
      }) ? R.buffer : null;
    },
    // Short, rate-matched windows of the recording for the live semantic
    // lane, cut once per (source, plan, event, rate) and cached by seconds.
    excerptFor: (planId, event, rate) => {
      if (!R.buffer || !event) return null;
      const key = excerptKey(R.sourceHash, planId, event.eventId || event.id, rate);
      const hit = excerptCache.get(key);
      if (hit) return hit;
      const channels = [];
      for (let c = 0; c < R.buffer.numberOfChannels; c++) channels.push(R.buffer.getChannelData(c));
      const cut = cutExcerpt({
        channels,
        sourceRate: R.buffer.sampleRate,
        offsetSec: event.sourceOffsetSec,
        spanSec: event.sourceSpanSec,
        outRate: rate,
        resampleFn: (ch, inRate, outRate) => resample(ch, inRate, outRate, { cutoffScale: PLAYBACK_CUTOFF_SCALE }),
      });
      return cut ? excerptCache.set(key, cut) : null;
    },
    identityFor: (planId) => {
      const plan = P.loom && P.loom.plans && P.loom.plans[planId];
      return {
        sha256: R.sourceHash || (plan && plan.source && plan.source.sha256) || null,
        name: P.fileName || (plan && plan.source && plan.source.name) || null,
        size: R.sourceBytes ? R.sourceBytes.byteLength
          : (plan && plan.source && plan.source.size),
      };
    },
  });
  refreshSemanticLane();
  store.addEventListener('change', refreshSemanticLane);
  // Every path that fires a track goes through here, so the pads light whether
  // the hit came from the mouse, the QWERTY keys, incoming MIDI or the grid.
  function fireTrack(i, velocity = 1) {
    sequencer.trigger(i, 0, velocity);
    if (pads) pads.flash(i);
    if (kitView) {
      kitView.flash(i);
      if (!kitView.audioRate && engine.ctx) kitView.setState(P.machine, engine.ctx.sampleRate);
    }
  }
  ctx.api.fireTrack = fireTrack;

  // Source-free instruments are real kit material too. The legacy PATCH path
  // slices the loaded recording; this path prints the eight active Machine
  // voices directly, with the canonical Kaiser conversion required by OP-Z /
  // OP-1's 44.1 kHz drum-patch format.
  async function exportActiveKit() {
    const tracks = P.machine.tracks;
    if (!tracks.some((track) => track && track.sample)) {
      statusFault('KIT PRINT FAULT · load or build sounds in MACHINE first.');
      return;
    }
    status('PRINTING ACTIVE KIT…', true);
    try {
      const segments = [];
      for (let i = 0; i < 8; i++) {
        const track = tracks[i];
        if (!track || !track.sample) {
          // The OP format is positional but rejects empty segments. A 2 ms
          // silent slice preserves the missing pad instead of shifting every
          // later instrument down one slot.
          segments.push({ samples: new Float32Array(88) });
          continue;
        }
        const rendered = await sequencer.renderTrackVoice(i);
        if (!rendered || !rendered.length) throw new Error('track ' + (i + 1) + ' would not render');
        const mono = rendered.getChannelData(0).slice();
        segments.push({
          samples: rendered.sampleRate === 44100
            ? mono : resample(mono, rendered.sampleRate, 44100),
        });
      }
      const kitName = (P.machine.drums && P.machine.drums.kitId)
        || (P.fileName || 'yellowjacket').replace(/\.[^.]+$/, '');
      const { bytes, report } = buildDrumPatch({ segments, name: kitName });
      const stem = String(kitName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'yellowjacket';
      download(bytes, stem + '-op-kit.aif', 'audio/aiff');
      status('ACTIVE KIT PRINTED · ' + report.slices + ' VOICES · '
        + report.seconds.toFixed(2) + 'S · 44.1 KHZ OP-Z/OP-1');
    } catch (err) {
      statusFault('KIT PRINT FAULT · ' + (err.message || err));
    }
  }
  ctx.api.exportActiveKit = exportActiveKit;

  function copyStepData(target, source) {
    for (const key of Object.keys(target)) delete target[key];
    if (!source || typeof source !== 'object') return;
    for (const key of Object.keys(source)) {
      target[key] = JSON.parse(JSON.stringify(source[key]));
    }
  }

  function applyGrooveTracks(tracks, groove) {
    const parts = Array.isArray(groove) ? groove : (groove && groove.tracks);
    if (!Array.isArray(parts)) throw new Error('factory groove has no track data');
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const part = parts[i] || {};
      track.steps.fill(0);
      const steps = part.steps || [];
      const n = Math.min(track.steps.length, steps.length || 0);
      for (let step = 0; step < n; step++) track.steps[step] = steps[step] ? 1 : 0;
      copyStepData(track.stepData, part.stepData);
      track.len = Math.max(1, Math.min(64, Number(part.len) | 0 || 16));
    }
  }

  function pruneFactoryAssets(project) {
    const used = new Set();
    for (const scene of project.machine.scenes) {
      for (const track of scene.tracks) if (track.sampleId) used.add(track.sampleId);
    }
    for (const id of Object.keys(project.assets)) {
      const meta = project.assets[id];
      if (meta && meta.factoryKitId && !used.has(id)) delete project.assets[id];
    }
  }

  async function installFactoryKit(kitId, grooveId = null, withGroove = false, variation = 0) {
    const kit = getFactoryKit(kitId);
    if (!kit) throw new Error('unknown factory kit ' + String(kitId));
    if (kitView) kitView.setBusy(true, 'RENDERING 4× DSP…');
    status('BUILDING ' + kit.name.toUpperCase() + ' · 384 kHz DSP → 96 kHz PCM', true);
    // Let the busy state paint before deterministic synthesis begins.
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      const rendered = renderFactoryKit(kitId);
      const groove = withGroove ? grooveFor(kitId, grooveId, variation) : null;
      store.update('machine-kit', (p) => {
        const scene = p.machine.scenes[p.machine.activeScene];
        for (const item of rendered.voices) {
          const slot = Math.max(0, Math.min(scene.tracks.length - 1, item.slot | 0));
          const sampleRate = Math.round(Number(item.sampleRate || rendered.sampleRate || 96000));
          const stableId = drumAssetId(kit.id, slot);
          const meta = {
            kind: 'factory-drum', label: item.name, role: item.role,
            sampleRate, frames: item.pcm.length, channelCount: 1,
            factoryKitId: kit.id, factoryVoiceId: item.id || item.model,
            engineVersion: item.engineVersion || rendered.engineVersion,
            model: item.model, seed: item.seed,
            params: item.params ? JSON.parse(JSON.stringify(item.params)) : {},
            metrics: item.metrics ? { ...item.metrics } : undefined,
            oversample: kit.oversample || rendered.oversample || 4,
          };
          const id = stableId || registerAsset(p, meta);
          if (stableId) p.assets[id] = { id, ...meta };
          const track = scene.tracks[slot];
          track.sampleId = id;
          track.sample = {
            channels: [item.pcm], sampleRate, label: item.name, role: item.role,
            factoryKitId: kit.id, engineVersion: item.engineVersion || rendered.engineVersion,
          };
          Object.assign(track.voice, createVoice(), item.voice || {});
          const mix = item.mix || {};
          Object.assign(track, {
            gainDb: 0, pan: 0, mute: false, solo: false,
            duckSource: -1, duckDb: 12, choke: false, chokeGroup: 0,
            sendVerb: 0, sendDelay: 0,
          });
          for (const key of ['gainDb', 'pan', 'mute', 'solo', 'duckSource', 'duckDb',
            'choke', 'chokeGroup', 'sendVerb', 'sendDelay']) {
            if (mix[key] !== undefined) track[key] = mix[key];
          }
        }
        if (withGroove) {
          applyGrooveTracks(scene.tracks, groove);
          if (Number.isFinite(kit.bpm)) scene.bpm = kit.bpm;
          if (Number.isFinite(kit.swing)) scene.swing = kit.swing;
        }
        const previousKit = p.machine.drums.kitId;
        p.machine.drums.kitId = kit.id;
        if (withGroove) {
          p.machine.drums.grooveId = grooveId;
          p.machine.drums.variation = Math.max(0, variation | 0);
        } else if (previousKit !== kit.id) {
          p.machine.drums.grooveId = null;
          p.machine.drums.variation = 0;
        }
        pruneFactoryAssets(p);
      });
      for (let i = 0; i < P.machine.tracks.length; i++) sequencer.bumpTrack(i);
      if (typeof sequencer.bumpStrips === 'function') sequencer.bumpStrips();
      patternView.setMachine(P.machine);
      if (pads) pads.setTracks(P.machine.tracks);
      if (kitView) kitView.setState(P.machine, engine.ctx && engine.ctx.sampleRate);
      const label = withGroove ? ' + ' + String(grooveId).toUpperCase() + ' · TAKE '
        + String(variation + 1).padStart(2, '0') : ' · SOUNDS ONLY';
      status(kit.name.toUpperCase() + label + ' · 8 VOICES · CANONICAL 96 kHz');
      return rendered;
    } finally {
      if (kitView) kitView.setBusy(false);
    }
  }

  async function loadKitRequest(detail) {
    try {
      await installFactoryKit(detail.kitId, detail.grooveId, !!detail.withGroove, 0);
    } catch (err) {
      statusFault('FACTORY KIT FAULT · ' + (err.message || err));
    }
  }

  function writeNextTake(detail) {
    const drums = P.machine.drums;
    const variation = Math.max(0, drums.variation | 0) + 1;
    try {
      const kit = getFactoryKit(detail.kitId);
      const groove = grooveFor(detail.kitId, detail.grooveId, variation);
      store.update('machine-groove', (p) => {
        applyGrooveTracks(p.machine.tracks, groove);
        if (kit && Number.isFinite(kit.bpm)) p.machine.bpm = kit.bpm;
        if (kit && Number.isFinite(kit.swing)) p.machine.swing = kit.swing;
        p.machine.drums.kitId = detail.kitId;
        p.machine.drums.grooveId = detail.grooveId;
        p.machine.drums.variation = variation;
      });
      patternView.setMachine(P.machine);
      if (kitView) kitView.setState(P.machine, engine.ctx && engine.ctx.sampleRate);
      status('NEW TAKE · ' + String(variation + 1).padStart(2, '0')
        + ' · ANCHORS HELD, GHOSTS RECOMPOSED');
    } catch (err) {
      statusFault('NEW TAKE FAULT · ' + (err.message || err));
    }
  }

  if (kitView) {
    kitView.addEventListener('kitload', (event) => loadKitRequest(event.detail));
    kitView.addEventListener('variation', (event) => writeNextTake(event.detail));
    kitView.addEventListener('trig', (event) => fireTrack(event.detail.track));
    kitView.addEventListener('export', exportActiveKit);
    kitView.setState(P.machine, engine.ctx && engine.ctx.sampleRate);
    store.addEventListener('change', () => {
      kitView.setState(P.machine, engine.ctx && engine.ctx.sampleRate);
    });
  }

  ctx.api.loadDrumStarter = () => {
    const kit = FACTORY_KITS[0];
    const groove = kit && Array.isArray(kit.grooves) ? kit.grooves[0] : null;
    if (!kit) return Promise.reject(new Error('no factory kits are installed'));
    return loadKitRequest({
      kitId: kit.id,
      grooveId: groove && groove.id,
      withGroove: true,
    });
  };

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

  function machineHasPerformance() {
    const take = activeSemanticTake();
    return machineHasSound()
      || !!(take.plan && take.online && take.lane && take.lane.enabled !== false);
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
      setBeatmapLed('stale', analysis.tempo.toFixed(1) + ' BPM · ROUGH');
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
  // Cut one clip's samples out of the loaded source, shaped for a machine track.
  // Returns null when the clip cannot be cut (zero length, or no source).
  function sliceForTrack(clip) {
    const buf = R.buffer;
    if (!clip || !buf) return null;
    const s = Math.max(0, Math.floor(clip.start * buf.sampleRate));
    let n = Math.min(buf.length, Math.ceil(clip.end * buf.sampleRate)) - s;
    if (n <= 0) return null;
    const cap = MAX_TRACK_SAMPLE_SEC * buf.sampleRate;
    const trimmed = n > cap;
    if (trimmed) n = cap;
    const channels = [];
    for (let c = 0; c < buf.numberOfChannels; c++) {
      channels.push(buf.getChannelData(c).slice(s, s + n));
    }
    return { channels, frames: n, sampleRate: buf.sampleRate, trimmed };
  }

  // Seat a whole harvest at once. One store.update, so the whole kit is a single
  // undo step rather than eight.
  function assignHarvestToTracks(clips, occupied) {
    const nothing = { seated: 0, lifted: 0, grooved: 0 };
    if (!R.buffer) return nothing;
    const plan = planKitAssignment(clips, P.machine.tracks.length, occupied);
    const byId = new Map((clips || []).map((c) => [c.id, c]));
    const cut = [];
    for (let track = 0; track < plan.length; track++) {
      const clip = plan[track] ? byId.get(plan[track]) : null;
      if (!clip) continue;
      const slice = sliceForTrack(clip);
      if (slice) cut.push({ track, clip, slice });
    }
    if (!cut.length) return nothing;
    // Level the seated slices. Only on this path: HARVEST's promise is a kit
    // that plays, whereas a manual assignment is a deliberate choice of one clip
    // and keeps whatever level it had.
    let lifted = 0;
    for (const { slice } of cut) {
      const gain = kitGainFor(peakOfChannels(slice.channels));
      if (gain === 1) continue;
      if (gain > 1) lifted++;
      for (const chan of slice.channels) {
        for (let i = 0; i < chan.length; i++) chan[i] *= gain;
      }
    }
    // Seating samples writes no steps, so RUN would play silence and "ready to
    // play" would be a lie. A starter groove goes in the SAME update, so the
    // whole kit — samples, levels and beat — is one undo step. Only ever over a
    // pattern that is entirely empty; someone's own beat is never overwritten.
    const patternEmpty = !P.machine.tracks.some((t) => t.steps.some((s) => s));
    let grooved = 0;
    store.update('machine', (p) => {
      const roles = new Array(p.machine.tracks.length).fill('');
      for (const { track, clip, slice } of cut) {
        const label = clip.label || clip.tag;
        const role = clip.tag ? String(clip.tag).toUpperCase() : undefined;
        const id = registerAsset(p, {
          kind: 'sample', label, sampleRate: slice.sampleRate, frames: slice.frames, role,
        });
        const t = p.machine.tracks[track];
        t.sampleId = id;
        t.sample = { channels: slice.channels, sampleRate: slice.sampleRate, label, role };
        roles[track] = role || '';
      }
      if (!patternEmpty) return;
      const lanes = starterGrooveForRoles(roles);
      for (let i = 0; i < p.machine.tracks.length; i++) {
        const lane = lanes[i];
        if (!lane || !lane.some(Boolean)) continue;
        const track = p.machine.tracks[i];
        for (let s = 0; s < track.steps.length && s < lane.length; s++) track.steps[s] = lane[s];
        grooved++;
      }
    });
    for (const { track } of cut) sequencer.bumpTrack(track);
    patternView.setMachine(P.machine);
    return { seated: cut.length, lifted, grooved };
  }

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
  patternView.addEventListener('loomtoggle', (e) => {
    store.update('loom-lane', (p) => {
      const scene = p.machine.scenes[p.machine.activeScene];
      if (scene && scene.loomLane) scene.loomLane.enabled = !!e.detail.enabled;
    });
    refreshSemanticLane();
  });
  patternView.addEventListener('loomgain', (e) => {
    store.update('loom-lane', (p) => {
      const scene = p.machine.scenes[p.machine.activeScene];
      if (!scene || !scene.loomLane) return;
      const value = Number(e.detail.gainDb);
      if (Number.isFinite(value)) scene.loomLane.gainDb = Math.max(-48, Math.min(6, value));
    });
    refreshSemanticLane();
  });
  patternView.addEventListener('loomtrace', (e) => {
    const take = activeSemanticTake();
    if (ctx.api.traceLoomEvent) ctx.api.traceLoomEvent(e.detail.id, take.plan && take.plan.id);
  });
  patternView.addEventListener('loomopen', (e) => {
    const take = activeSemanticTake();
    // The active scene reference is authoritative. The event detail preserves
    // the view contract, but never lets a stale rendered row open another plan.
    const requested = e.detail && typeof e.detail.planId === 'string' ? e.detail.planId : null;
    const planId = take.plan && take.lane && take.lane.planId === take.plan.id
      && (!requested || requested === take.plan.id) ? take.plan.id : null;
    if (planId && ctx.api.openLoomPlan && ctx.api.openLoomPlan(planId)) return;
    if (ctx.api.showTab) ctx.api.showTab('loom');
  });
  patternView.addEventListener('loomprint', async () => {
    if (semanticPrintBusy) {
      status('SEMANTIC TAKE PRINT IS ALREADY RUNNING', true);
      return;
    }
    const take = activeSemanticTake();
    if (!take.plan) {
      statusFault('PRINT TAKE · ARM A LOOM WEAVE TO THIS SCENE FIRST');
      return;
    }
    if (!take.online) {
      statusFault('PRINT TAKE · SOURCE OFFLINE · RELOAD THE MATCHING RECORDING');
      return;
    }
    if (sequencer.running) sequencer.stop();
    const printSourceName = take.plan.source && take.plan.source.name
      ? take.plan.source.name : (P.fileName || 'yellowjacket');
    semanticPrintBusy = true;
    if (patternView.setLoomPrintBusy) patternView.setLoomPrintBusy(true);
    status('PRINTING SEMANTIC TAKE · 24-BIT AUDIO + SOURCE TRACE…', true);
    try {
      const result = await sequencer.renderPerformance(1, 24);
      const base = printSourceName.replace(/\.[^.]+$/, '');
      const stem = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        || 'yellowjacket';
      const archive = buildBundle([
        [stem + '-semantic-take.wav', result.bytes],
        [stem + '-semantic-take.yjmap.json', JSON.stringify(result.lineage, null, 2)],
      ]);
      download(archive, stem + '-semantic-take.zip', 'application/zip');
      status('SEMANTIC TAKE PRINTED · ' + result.totalSec.toFixed(2) + 'S · '
        + result.sampleRate + ' HZ · 24-BIT WAV + YJMAP');
    } catch (err) {
      statusFault('PRINT TAKE FAULT · ' + (err.message || err));
    } finally {
      semanticPrintBusy = false;
      if (patternView.setLoomPrintBusy) patternView.setLoomPrintBusy(false);
    }
  });
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
      const toHadSound = to.tracks.some((track) => track && track.sample);
      for (let i = 0; i < to.tracks.length; i++) {
        if (!to.tracks[i].sample && from.tracks[i] && from.tracks[i].sample) {
          to.tracks[i].sample = from.tracks[i].sample;
          to.tracks[i].sampleId = from.tracks[i].sampleId;
        }
      }
      if (!toHadSound) Object.assign(to.drums, from.drums);
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
      Object.assign(dst.drums, src.drums);
      Object.assign(dst.loomLane, src.loomLane);
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
  // The ninth lane's one-press fill. Loom owns the weave; this only relays.
  patternView.addEventListener('loomquicktake', () => {
    if (ctx.api.quickTake) ctx.api.quickTake();
    else statusFault('QUICK TAKE · LOOM IS NOT READY');
  });

  patternView.addEventListener('run', () => {
    if (!machineHasPerformance()) {
      statusFault('Nothing to run. Load a kit or arm a Semantic Take to this scene.');
      return;
    }
    if (engine.playing) engine.pause();
    if (ctx.api.stopLoom) ctx.api.stopLoom();
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
    if (kitView) kitView.setState(P.machine, engine.ctx && engine.ctx.sampleRate);
    if (e.detail.running) {
      const take = activeSemanticTake();
      status('MACHINE RUNNING · ' + P.machine.bpm + ' BPM'
        + (take.plan && take.online && take.lane.enabled !== false ? ' · SEMANTIC TAKE' : ''), true);
    } else {
      patternView.setPlayhead(null);
      status(COPY.loaded);
    }
  });

  // ---------- transcript selection → Loom (one action, no destructive clip) ----------
  $('btnLift').addEventListener('click', () => {
    const range = ctx.api.getLiftRange();
    if (!range || !P.words) return;
    if (ctx.api.weaveTranscriptSelection) ctx.api.weaveTranscriptSelection(range);
  });

  // ---------- substate switcher ----------
  for (const btn of document.querySelectorAll('.yj-substate-btn')) {
    btn.addEventListener('click', () => {
      for (const b of document.querySelectorAll('.yj-substate-btn')) b.classList.toggle('is-active', b === btn);
      for (const pane of document.querySelectorAll('.yj-mstate')) pane.classList.remove('is-active');
      $('mstate-' + btn.dataset.mstate).classList.add('is-active');
      // A canvas measured while hidden reads zero, so anything revealed here
      // has to redraw. This is why the SYNTH plot came up blank: the formula
      // was compiled and its PCM was ready, and the one draw it got happened
      // while the pane was still display:none.
      const revealed = {
        slice: () => { sliceView.render(); if (constellation) constellation.render(); },
        crate: () => { if (ctx.api.synthRedraw) ctx.api.synthRedraw(); },
      }[btn.dataset.mstate];
      // Called straight away, not on requestAnimationFrame: getBoundingClientRect
      // forces the layout it needs, and a queued frame never fires at all while
      // the tab is in the background, which leaves the canvas blank on return.
      if (revealed) revealed();
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
  function openVoice(track) {
    const t = P.machine.tracks[track];
    if (t && !t.voice) t.voice = normalizeVoice(null);   // pre-SONG saves
    $('voiceHost').hidden = false;
    voiceView.setTrack(track, t);
    // Reveal first, then draw: a canvas measured while hidden reads zero.
    if (voiceView.render) requestAnimationFrame(() => voiceView.render());
  }

  patternView.addEventListener('voiceopen', (e) => openVoice(e.detail.track));
  voiceView.addEventListener('close', () => { $('voiceHost').hidden = true; });
  voiceView.addEventListener('trig', (e) => fireTrack(e.detail.track));
  // Sends live on the track, not the voice: they are mix controls, and they
  // sit with gain and pan (CONTRACT-CONFORM 4).
  voiceView.addEventListener('send', (e) => {
    const { track, which, value } = e.detail;
    store.update('mix', (p) => {
      const t = p.machine.tracks[track];
      if (t) t[which] = Math.max(0, Math.min(1, value));
    });
    // No strip rebuild: send amounts are automation now, so the next voice
    // scheduled on this track carries the new value. Tearing the strips down
    // mid-pattern cut the reverb tail of whatever was still ringing.
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
    const job = ctx.api.beginJob ? ctx.api.beginJob('HARVESTING', 'machine', 'slice') : null;
    if (!harvestWorker) {
      harvestWorker = new Worker(new URL('../../workers/harvest-worker.js', import.meta.url), { type: 'module' });
    }
    const gen = R.generation;
    // HARVEST is rare and the worker caches nothing worth keeping; its isolate
    // and scratch go with it after each job.
    const retire = () => {
      if (job) job.end();
      if (!harvestWorker) return;
      try { harvestWorker.terminate(); } catch (e) { /* already gone */ }
      harvestWorker = null;
    };
    harvestWorker.onerror = () => {
      btn.disabled = false;
      btn.classList.remove('is-working');
      retire();
      statusFault('HARVEST FAILED · the worker died');
    };
    harvestWorker.onmessage = (e) => {
      btn.disabled = false;
      btn.classList.remove('is-working');
      retire();
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
      // Labelling slices and then leaving every track empty made a harvested
      // recording unplayable until eight manual assignments had been made.
      // Free tracks are filled here; occupied ones are left alone, so this adds
      // to a kit rather than overwriting one.
      const occupied = P.machine.tracks.map((t) => !!t.sample);
      const { seated, lifted, grooved } = assignHarvestToTracks(P.clips, occupied);
      const roles = {};
      for (const pick of picks) roles[pick.role] = (roles[pick.role] || 0) + 1;
      const spread = picks[picks.length - 1].t0 - picks[0].t0;
      status('HARVEST · ' + picks.length + ' SLICES ACROSS ' + spread.toFixed(0) + 'S · '
        + Object.keys(roles).map((r) => r + ' ' + roles[r]).join(' ')
        + (seated ? ' · ' + seated + ' ON TRACKS' : '')
        + (lifted ? ' · ' + lifted + ' LEVELLED' : '')
        + (grooved ? ' · GROOVE ON ' + grooved + ' · PRESS RUN' : ''));
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
      if (!pcm) return;
      engine.wake();
      engine.audition(pcm, { sampleRate: R.sampleRate || 44100 });
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
        // The formula rides on the sample and the asset so the CRATE can show
        // what a synth voice was made from. Nothing re-renders from it yet:
        // the sequencer only ever sees PCM, and the sample copy is dropped on
        // save while the asset copy survives.
        track.sample = {
          channels: [pcm], sampleRate: rate, label: e.detail.name,
          role: e.detail.role, formula: e.detail.formula,
        };
      });
      sequencer.bumpTrack(slot);
      patternView.setMachine(P.machine);
      status('SYNTH · ' + e.detail.name + ' → TRACK ' + (slot + 1) + ' · ' + e.detail.formula.slice(0, 40));
    });

    // Redraw on reveal, called by the substate switcher above. This existed
    // before with no caller at all, which is why removing it changed nothing
    // and why the plot was blank either way.
    ctx.api.synthRedraw = () => drawSynthPlot(synthPcm);

    // Now that the listener above exists, ask the view to re-announce the
    // preset it loaded during construction. Without this the panel opens
    // showing a formula that has never been compiled or plotted.
    if (typeof synthView.emitCurrent === 'function') synthView.emitCurrent();
  }

  if (pads) {
    pads.addEventListener('trig', (e) => fireTrack(e.detail.track, e.detail.velocity));
    pads.setTracks(P.machine.tracks);
    sequencer.addEventListener('step', (e) => pads.setPlayingStep(e.detail.step));
    store.addEventListener('change', (ev) => {
      const kind = ev.detail && ev.detail.kind;
      if (kind === 'machine' || kind === 'assets' || kind === 'scene'
        || kind === 'history' || kind === 'relight') {
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
      engine.audition(pcm, { sampleRate: modalRate });
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
