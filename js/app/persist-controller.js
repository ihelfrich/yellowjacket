// Persistence controller: autosave to OPFS and the RESUME/DISCARD flow. The store
// routes every mutation through update(), so autosave is one debounced listener.
// Nothing auto-loads: a saved session offers itself in the drop zone and waits.

import { serializeProject, snapshotDoc, applySnapshot, OpfsStore, FORMAT_VERSION } from './persist.js';
import { advanceClipCounter } from '../machine/cliprefs.js';

const SAVE_DEBOUNCE_MS = 800;

export function initPersistController(ctx) {
  const { store, views, $, status, statusFault } = ctx;
  const P = store.project;
  const R = store.runtime;

  let opfs = null;
  let saveTimer = 0;
  let saving = false;
  let savePending = false;
  let restoring = false;
  let warnedOnce = false;
  let bytesGeneration = -1;
  let restoreFailed = false;
  const samplesWritten = new Set();

  const n = (count, word) => count + ' ' + word + (count === 1 ? '' : 'S');

  function timeAgo(ms) {
    const d = Date.now() - ms;
    if (d < 90e3) return 'JUST NOW';
    if (d < 3600e3) return Math.round(d / 60e3) + ' MIN AGO';
    if (d < 86400e3) return Math.round(d / 3600e3) + ' H AGO';
    return Math.round(d / 86400e3) + ' D AGO';
  }

  async function boot() {
    opfs = await OpfsStore.open();
    if (!opfs) return; // no OPFS here: the bench works exactly as before
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    } catch (e) { /* advisory only */ }
    try {
      if (await opfs.has('project.json')) {
        const json = await opfs.readJson('project.json');
        if (json && json.fileName && await opfs.has('source.bin')) {
          const scenes = json.machine && json.machine.scenes ? json.machine.scenes : [];
          const liveScenes = scenes.filter((s) => s && s.tracks
            && s.tracks.some((t) => t && t.steps && t.steps.some((v) => v))).length;
          const bits = ['LAST SESSION · ' + String(json.fileName).toUpperCase()];
          if (json.words && json.words.length) bits.push(n(json.words.length, 'WORD'));
          if (json.repairs && json.repairs.length) bits.push(n(json.repairs.length, 'REPAIR'));
          if (liveScenes) bits.push(n(liveScenes, 'SCENE'));
          bits.push(timeAgo(json.savedAt || Date.now()));
          $('resumeInfo').textContent = bits.join(' · ');
          $('resumePanel').hidden = false;
        }
      }
    } catch (e) { /* unreadable save: leave the panel hidden */ }
    store.addEventListener('change', scheduleSave);
  }

  function scheduleSave() {
    if (!opfs || restoring || !R.buffer) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }

  async function saveNow() {
    saveTimer = 0;
    if (saving) { savePending = true; return; }
    saving = true;
    try {
      const { json, sampleFiles } = serializeProject(P, R);
      // Capture the generation and the bytes BEFORE awaiting. Stamping
      // R.generation after the await marks a generation as saved whose audio
      // was never written: load a second file while a 74 MB source.bin write
      // is in flight and the next save skips the write entirely, leaving the
      // first file's audio on disk under the second file's project state.
      const gen = R.generation;
      const bytes = R.sourceBytes;
      if (bytes && bytesGeneration !== gen) {
        await opfs.writeBytes('source.bin', bytes);
        bytesGeneration = gen;
        samplesWritten.clear();
      }
      for (const file of sampleFiles) {
        if (samplesWritten.has(file.id)) continue;
        await opfs.writeBytes('samples/' + file.id + '.f32', file.bytes);
        samplesWritten.add(file.id);
      }
      await opfs.writeJson('project.json', json);
    } catch (e) {
      if (!warnedOnce) {
        warnedOnce = true;
        statusFault('AUTOSAVE FAULT · ' + (e.message || e) + ' — this session will not survive a reload.');
      }
    } finally {
      saving = false;
      if (savePending) { savePending = false; saveNow(); }
    }
  }

  // Every surface that mirrors the document, relit in one place. RESTORE and
  // UNDO both land here so they can never drift apart.
  function relightAll() {
    // Isolated per surface. This runs inside the undo transaction, after the
    // history entry has already been popped, so a throw from any one view
    // would consume that step without applying it: the user presses undo, the
    // state does not move, and the step is gone. A dark panel is recoverable;
    // a silently eaten undo is not.
    const steps = [
      ['words', () => { if (P.words && P.words.length) ctx.api.wordsRestored(); }],
      ['clips', () => { views.sliceView.setClips(P.clips); ctx.api.updateClipReadout(); }],
      ['pattern', () => views.patternView.setMachine(P.machine)],
      ['song', () => ctx.api.songRefresh()],
      ['rack', () => ctx.api.rebuildRack()],
      ['repairs', () => ctx.api.repairsRestored()],
      ['wire', () => ctx.api.wireRestored()],
      ['buffers', () => {
        for (let i = 0; i < P.machine.tracks.length; i++) ctx.sequencer.bumpTrack(i);
        if (ctx.sequencer.bumpStrips) ctx.sequencer.bumpStrips();
      }],
    ];
    const broken = [];
    for (const [name, run] of steps) {
      try {
        run();
      } catch (err) {
        broken.push(name);
        (window.__yjErrors = window.__yjErrors || []).push({ relight: name, error: err });
      }
    }
    if (broken.length) statusFault('REFRESH FAULT · ' + broken.join(', ') + ' did not repaint');
  }
  ctx.api.relightAll = relightAll;

  // ---------- undo / redo ----------
  // applySnapshot deliberately nulls track.sample (PCM normally arrives from
  // disk afterwards). For undo the audio never left memory, so it is captured
  // by asset id and re-attached, or an undo would silently empty the kit.
  store.attachHistory(
    () => snapshotDoc(P, R),
    (doc) => {
      const pcm = new Map();
      for (const scene of P.machine.scenes) {
        for (const track of scene.tracks) {
          if (track.sampleId && track.sample) pcm.set(track.sampleId, track.sample);
        }
      }
      const repairsBefore = JSON.stringify(R.repairs);
      applySnapshot(doc, { project: P, runtime: R });
      for (const scene of P.machine.scenes) {
        for (const track of scene.tracks) {
          if (track.sampleId && !track.sample && pcm.has(track.sampleId)) {
            track.sample = pcm.get(track.sampleId);
          }
        }
      }
      relightAll();
      // Repairs are parametric: the list came back, the audio has to be rebuilt.
      if (JSON.stringify(R.repairs) !== repairsBefore && ctx.api.repairRebuild) {
        ctx.api.repairRebuild();
      }
    },
  );

  function historyStep(dir) {
    const moved = dir === 'undo' ? store.undo() : store.redo();
    if (!moved) {
      status(dir === 'undo' ? 'NOTHING TO UNDO' : 'NOTHING TO REDO');
      return;
    }
    // Through the public accessor, not store._past: two interfaces to one
    // piece of state meant the tested one was the one nobody ran.
    status((dir === 'undo' ? 'UNDO' : 'REDO') + ' · ' + store.undoDepth + ' STEPS BACK AVAILABLE');
  }
  ctx.api.undo = () => historyStep('undo');
  ctx.api.redo = () => historyStep('redo');

  async function restore() {
    if (!opfs) return;
    const btn = $('btnResume');
    btn.disabled = true;
    btn.classList.add('is-working');
    restoring = true;
    try {
      const json = await opfs.readJson('project.json');
      const bytes = await opfs.readBytes('source.bin');
      if (!json || !bytes) throw new Error('saved session is incomplete');
      // VALIDATE BEFORE DESTROYING. loadArrayBuffer resets fileName, words,
      // clips, machine and assets. If the snapshot is then rejected, the
      // project is an empty one holding the restored audio, and the autosave
      // 800 ms later writes that emptiness over the only copy of the session.
      // A formatVersion bump on deploy is enough to trigger it.
      if (!json.formatVersion || json.formatVersion !== FORMAT_VERSION) {
        throw new Error('saved session is version ' + json.formatVersion
          + ', this bench reads ' + FORMAT_VERSION + '. Nothing was changed.');
      }
      // The JSON and the audio are written separately, so a tab closed between
      // the two writes leaves them describing different files.
      if (json.sourceBytes && Number.isFinite(json.sourceBytes.size)
        && json.sourceBytes.size !== bytes.byteLength) {
        throw new Error('saved audio does not match the saved session ('
          + bytes.byteLength + ' bytes on disk, ' + json.sourceBytes.size
          + ' expected). Nothing was changed.');
      }
      const genBefore = R.generation;
      // Saved anchors go along for the ride so the deferred analysis run
      // reproduces the beatmap instead of re-guessing it.
      await ctx.api.loadArrayBuffer(bytes, json.fileName, json.anchors || null);
      if (R.generation === genBefore) throw new Error('the saved audio would not decode');
      applySnapshot(json, { project: P, runtime: R });
      advanceClipCounter(P.clips);

      // Attach machine sample PCM from the sample files.
      const attached = new Map();
      for (const scene of P.machine.scenes) {
        for (const track of scene.tracks) {
          if (!track.sampleId || track.sample) continue;
          const meta = P.assets[track.sampleId];
          if (!meta) { track.sampleId = null; continue; }
          if (!attached.has(track.sampleId)) {
            const raw = await opfs.readBytes('samples/' + track.sampleId + '.f32').catch(() => null);
            if (!raw) { attached.set(track.sampleId, null); continue; }
            const flat = new Float32Array(raw);
            const chans = [];
            for (let c = 0; c < meta.channelCount; c++) {
              chans.push(flat.slice(c * meta.frames, (c + 1) * meta.frames));
            }
            attached.set(track.sampleId, { channels: chans, sampleRate: meta.sampleRate, label: meta.label });
          }
          const sample = attached.get(track.sampleId);
          if (sample) track.sample = sample;
          else { track.sampleId = null; }
        }
      }
      for (let i = 0; i < P.machine.tracks.length; i++) ctx.sequencer.bumpTrack(i);

      // Light every surface the way live edits would have.
      relightAll();
      if (R.repairs.length) await ctx.api.repairRebuild();
      // A restored session is a fresh starting point, not something to undo into.
      store.clearHistory();   // a restored session is a starting point, not a step

      $('resumePanel').hidden = true;
      const parts = ['RESTORED · ' + String(json.fileName).toUpperCase()];
      if (R.repairs.length) parts.push(n(R.repairs.length, 'REPAIR'));
      status(parts.join(' · '));
      restoreFailed = false;
    } catch (e) {
      restoreFailed = true;
      statusFault('RESTORE FAULT · ' + (e.message || e));
    } finally {
      restoring = false;
      btn.disabled = false;
      btn.classList.remove('is-working');
      // Only resume autosaving if the restore actually succeeded: saving after
      // a failure overwrites the saved session with whatever half-state exists.
      if (!restoreFailed) scheduleSave();
    }
  }

  async function discard() {
    if (!opfs) return;
    try {
      await opfs.wipe();
      samplesWritten.clear();
      bytesGeneration = -1;
      $('resumePanel').hidden = true;
      status('SAVED SESSION DISCARDED');
    } catch (e) {
      statusFault('DISCARD FAULT · ' + (e.message || e));
    }
  }

  $('btnResume').addEventListener('click', restore);
  $('btnDiscard').addEventListener('click', discard);

  boot();
}
