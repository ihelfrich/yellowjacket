// Persistence controller: autosave to OPFS and the RESUME/DISCARD flow. The store
// routes every mutation through update(), so autosave is one debounced listener.
// Nothing auto-loads: a saved session offers itself in the drop zone and waits.

import {
  serializeProject, snapshotDoc, applySnapshot, hydrateSample, projectHasContent,
  OpfsStore, FORMAT_VERSION,
} from './persist.js';
import {
  buildBundle, readBundle, projectEntries, parseProjectEntries, safeProjectName,
} from './project-bundle.js';
import { download } from '../export.js';
import { advanceClipCounter } from '../machine/cliprefs.js';

const SAVE_DEBOUNCE_MS = 800;
const MAX_BUNDLE_BYTES = 768 * 1024 * 1024;

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

  function sessionLabel(json) {
    if (json && json.fileName) return String(json.fileName);
    const machine = json && json.machine;
    const scenes = machine && Array.isArray(machine.scenes) ? machine.scenes : [];
    const active = machine && Number.isInteger(machine.activeScene) ? machine.activeScene : 0;
    const drums = scenes[active] && scenes[active].drums || machine && machine.drums;
    if (drums && drums.kitId) return String(drums.kitId).toUpperCase() + ' SESSION';
    return 'SOURCE-FREE SESSION';
  }

  function projectSummary(json) {
    const scenes = json.machine && Array.isArray(json.machine.scenes) ? json.machine.scenes : [];
    const instruments = json.assets && typeof json.assets === 'object' ? Object.keys(json.assets).length : 0;
    const liveScenes = scenes.filter((scene) => scene && Array.isArray(scene.tracks)
      && scene.tracks.some((track) => track && Array.isArray(track.steps) && track.steps.some(Boolean))).length;
    const takes = json.loom && json.loom.plans && typeof json.loom.plans === 'object'
      ? Object.keys(json.loom.plans).length : 0;
    const bits = [];
    if (json.words && json.words.length) bits.push(n(json.words.length, 'WORD'));
    if (json.repairs && json.repairs.length) bits.push(n(json.repairs.length, 'REPAIR'));
    if (instruments) bits.push(n(instruments, 'INSTRUMENT'));
    if (liveScenes) bits.push(n(liveScenes, 'SCENE'));
    if (takes) bits.push(n(takes, 'SEMANTIC TAKE'));
    return bits.length ? bits.join(' · ') : 'SOURCE ONLY';
  }

  // Validate every byte the snapshot will refer to before loadArrayBuffer or
  // clearSource changes the live bench. An incomplete archive never gets a
  // chance to destroy a good session.
  function preflightBundle(payload) {
    const { json, source, samples } = payload;
    if (!json || typeof json !== 'object' || json.formatVersion !== FORMAT_VERSION) {
      throw new Error('project format is ' + String(json && json.formatVersion)
        + '; this bench reads ' + FORMAT_VERSION);
    }
    const sourceSize = json.sourceBytes && Number(json.sourceBytes.size);
    if (sourceSize > 0 && (!source || source.byteLength !== sourceSize)) {
      throw new Error('source audio is missing or truncated');
    }
    if (!(sourceSize > 0) && source && source.byteLength) {
      throw new Error('archive has source audio that project.json does not describe');
    }

    const hydrated = new Map();
    const assets = json.assets && typeof json.assets === 'object' ? json.assets : {};
    const needed = new Set();
    const scenes = json.machine && Array.isArray(json.machine.scenes) ? json.machine.scenes : [];
    for (const scene of scenes) {
      for (const track of scene && Array.isArray(scene.tracks) ? scene.tracks : []) {
        if (track && typeof track.sampleId === 'string') needed.add(track.sampleId);
      }
    }
    for (const id of needed) {
      const meta = assets[id];
      const raw = samples.get(id);
      const frames = meta && Math.max(0, meta.frames | 0);
      const channels = meta && Math.max(1, meta.channelCount | 0);
      const expected = frames * channels * 4;
      if (!meta || !raw || !frames || raw.byteLength !== expected) {
        throw new Error('instrument ' + id + ' is missing or truncated');
      }
      const sample = hydrateSample(meta, raw);
      if (!sample) throw new Error('instrument ' + id + ' could not be decoded');
      hydrated.set(id, sample);
    }
    return { hasSource: sourceSize > 0, hydrated };
  }

  function attachHydrated(hydrated) {
    for (const scene of P.machine.scenes) {
      for (const track of scene.tracks) {
        if (!track.sampleId) continue;
        const sample = hydrated.get(track.sampleId);
        if (sample) track.sample = sample;
        else track.sampleId = null;
      }
    }
    for (let i = 0; i < P.machine.tracks.length; i++) ctx.sequencer.bumpTrack(i);
  }

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
        const hasSource = !!(json && json.sourceBytes && json.sourceBytes.size > 0);
        if (projectHasContent(json) && (!hasSource || await opfs.has('source.bin'))) {
          const scenes = json.machine && json.machine.scenes ? json.machine.scenes : [];
          const liveScenes = scenes.filter((s) => s && s.tracks
            && s.tracks.some((t) => t && t.steps && t.steps.some((v) => v))).length;
          const takes = json.loom && json.loom.plans && typeof json.loom.plans === 'object'
            ? Object.keys(json.loom.plans).length : 0;
          const sessionName = sessionLabel(json);
          const discarded = document.wasDiscarded === true;
          const bits = [discarded
            ? 'THE BROWSER DISCARDED THIS TAB · SAVED ' + timeAgo(json.savedAt || Date.now()).toUpperCase()
            : 'LAST SESSION · ' + String(sessionName).toUpperCase()];
          $('resumePanel').classList.toggle('is-discarded', discarded);
          if (json.words && json.words.length) bits.push(n(json.words.length, 'WORD'));
          if (json.repairs && json.repairs.length) bits.push(n(json.repairs.length, 'REPAIR'));
          const instruments = json.assets ? Object.keys(json.assets).length : 0;
          if (instruments) bits.push(n(instruments, 'INSTRUMENT'));
          if (liveScenes) bits.push(n(liveScenes, 'SCENE'));
          if (takes) bits.push(n(takes, 'SEMANTIC TAKE'));
          bits.push(timeAgo(json.savedAt || Date.now()));
          $('resumeInfo').textContent = bits.join(' · ');
          $('resumePanel').hidden = false;
          if (!R.buffer && $('btnResume')) $('btnResume').focus();
        }
      }
    } catch (e) { /* unreadable save: leave the panel hidden */ }
    store.addEventListener('change', scheduleSave);
    // OPFS opens asynchronously. A fast source-free SYNTH edit can land before
    // this listener exists, so inspect the already-live document once at boot.
    scheduleSave();
  }

  function scheduleSave() {
    if (!opfs || restoring || !projectHasContent(P, R)) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }

  async function saveNow() {
    saveTimer = 0;
    if (!opfs || restoring || !projectHasContent(P, R)) return;
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
      const handle = R.sourceBytes;
      if (handle && bytesGeneration !== gen) {
        await opfs.writeBytes('source.bin', await handle.bytes());
        bytesGeneration = gen;
        samplesWritten.clear();
        // The durable copy exists: release the memory copy, unless another
        // file arrived while the write was in flight (then this handle is
        // already history and source.bin will be rewritten for the new one).
        if (R.sourceBytes === handle && R.generation === gen && typeof handle.spill === 'function') {
          handle.spill(() => opfs.readBytes('source.bin'));
        }
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

  async function exportProject() {
    if (!projectHasContent(P, R)) {
      status('PROJECT EMPTY · load audio or build an instrument first');
      return;
    }
    const btn = $('btnProjectSave');
    if (btn) { btn.disabled = true; btn.classList.add('is-working'); }
    status('PACKING PROJECT…', true);
    try {
      const serialized = serializeProject(P, R);
      const sourceBytes = R.sourceBytes ? await R.sourceBytes.bytes() : null;
      const archive = buildBundle(projectEntries(serialized, sourceBytes));
      download(archive, safeProjectName(P.fileName), 'application/vnd.yellowjacket.project+zip');
      const mb = archive.byteLength / 1048576;
      status('PROJECT SAVED · ' + mb.toFixed(mb >= 10 ? 0 : 1) + ' MB · '
        + projectSummary(serialized.json));
    } catch (e) {
      statusFault('PROJECT SAVE FAULT · ' + (e.message || e));
    } finally {
      if (btn) { btn.classList.remove('is-working'); btn.disabled = !projectHasContent(P, R); }
    }
  }

  async function importProjectFile(file) {
    if (!file) return;
    if (file.size > MAX_BUNDLE_BYTES) {
      statusFault('PROJECT OPEN FAULT · file is over 768 MB');
      return;
    }
    const btn = $('btnProjectOpen');
    if (btn) { btn.disabled = true; btn.classList.add('is-working'); }
    status('CHECKING PROJECT…', true);
    let payload;
    let checked;
    try {
      payload = parseProjectEntries(readBundle(await file.arrayBuffer()));
      checked = preflightBundle(payload);
    } catch (e) {
      statusFault('PROJECT OPEN FAULT · ' + (e.message || e) + ' · nothing was changed');
      if (btn) { btn.disabled = false; btn.classList.remove('is-working'); }
      return;
    }

    if (projectHasContent(P, R) && typeof window.confirm === 'function'
      && !window.confirm('Open “' + (payload.json.fileName || file.name) + '”?\n\n'
        + 'This replaces the current bench session. CRATE instruments are kept.')) {
      status('PROJECT KEPT');
      if (btn) { btn.disabled = false; btn.classList.remove('is-working'); }
      return;
    }

    restoring = true;
    status('OPENING PROJECT…', true);
    try {
      if (checked.hasSource) {
        const genBefore = R.generation;
        await ctx.api.loadArrayBuffer(payload.source, payload.json.fileName, payload.json.anchors || null);
        if (R.generation === genBefore) throw new Error('source audio would not decode');
      } else {
        ctx.api.clearSource();
      }
      applySnapshot(payload.json, { project: P, runtime: R });
      advanceClipCounter(P.clips);
      attachHydrated(checked.hydrated);
      relightAll();
      if (R.repairs.length) await ctx.api.repairRebuild();
      store.clearHistory();
      $('resumePanel').hidden = true;
      $('dropZone').classList.add('is-hidden');
      if (!checked.hasSource && ctx.api.showTab) {
        ctx.api.showTab('machine');
        const crateTab = document.querySelector('.yj-substate-btn[data-mstate="crate"]');
        if (crateTab) crateTab.click();
      }
      status('PROJECT OPEN · ' + String(payload.json.fileName || 'SOURCE-FREE PROJECT').toUpperCase()
        + ' · ' + projectSummary(payload.json));
    } catch (e) {
      statusFault('PROJECT OPEN FAULT · ' + (e.message || e));
    } finally {
      restoring = false;
      if (btn) { btn.disabled = false; btn.classList.remove('is-working'); }
      scheduleSave();
    }
  }

  // The debounce is right while a knob is moving, but it must not be the last
  // word when the tab is backgrounded or closed. OPFS writes are asynchronous,
  // so visibilitychange is the useful early signal; pagehide is the backstop.
  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = 0;
    }
    saveNow();
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushSave();
    });
  }
  if (typeof window !== 'undefined') window.addEventListener('pagehide', flushSave);

  // Every surface that needs an explicit poke, relit in one place. RESTORE and
  // UNDO both land here so they can never drift apart.
  //
  // The list below is NOT the full set of surfaces and must not try to be. It
  // once claimed to be, and Pipeline and Pads were both missing from it: they
  // refresh from store change events, and restore mutates the document with
  // applySnapshot() without dispatching one, so after a RESUME the pipeline
  // strip still described the session you had before reloading. Anything that
  // listens to the store is covered by the dispatch at the end instead of by
  // being named here.
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
    // Now everything that mirrors the document by listening. Undo dispatches
    // its own 'history' event a moment later, so this is redundant there and
    // load-bearing for restore, which changes the document silently.
    store.revision++;
    store.dispatchEvent(new CustomEvent('change', {
      detail: { kind: 'relight', revision: store.revision },
    }));
  }
  ctx.api.relightAll = relightAll;

  // ---------- undo / redo ----------
  // applySnapshot deliberately nulls track.sample (PCM normally arrives from
  // disk afterwards). For undo the audio never left memory, so it is captured
  // by asset id and re-attached, or an undo would silently empty the kit.
  const historyPcm = new WeakMap();
  function takeHistorySnapshot() {
    const doc = snapshotDoc(P, R);
    const pcm = new Map();
    for (const scene of P.machine.scenes) {
      for (const track of scene.tracks) {
        if (track.sampleId && track.sample) pcm.set(track.sampleId, track.sample);
      }
    }
    // Weakly keyed by the exact history document: PCM is held only as long as
    // that undo/redo entry is. References are shared, never copied.
    historyPcm.set(doc, pcm);
    return doc;
  }
  store.attachHistory(
    takeHistorySnapshot,
    (doc) => {
      const pcm = historyPcm.get(doc) || new Map();
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
      if (!json) throw new Error('saved session is incomplete');
      // VALIDATE BEFORE DESTROYING. loadArrayBuffer resets fileName, words,
      // clips, machine and assets. If the snapshot is then rejected, the
      // project is an empty one holding the restored audio, and the autosave
      // 800 ms later writes that emptiness over the only copy of the session.
      // A formatVersion bump on deploy is enough to trigger it.
      if (!json.formatVersion || json.formatVersion !== FORMAT_VERSION) {
        throw new Error('saved session is version ' + json.formatVersion
          + ', this bench reads ' + FORMAT_VERSION + '. Nothing was changed.');
      }
      const hasSource = !!(json.sourceBytes && json.sourceBytes.size > 0);
      if (hasSource) {
        const bytes = await opfs.readBytes('source.bin');
        if (!bytes) throw new Error('saved source audio is missing');
        // The JSON and the audio are written separately, so a tab closed between
        // the two writes leaves them describing different files.
        if (Number.isFinite(json.sourceBytes.size) && json.sourceBytes.size !== bytes.byteLength) {
          throw new Error('saved audio does not match the saved session ('
            + bytes.byteLength + ' bytes on disk, ' + json.sourceBytes.size
            + ' expected). Nothing was changed.');
        }
        const genBefore = R.generation;
        // Saved anchors go along for the ride so the deferred analysis run
        // reproduces the beatmap instead of re-guessing it.
        await ctx.api.loadArrayBuffer(bytes, json.fileName, json.anchors || null);
        if (R.generation === genBefore) throw new Error('the saved audio would not decode');
      } else if (R.buffer) {
        throw new Error('this source-free session can only be resumed before another source is loaded');
      }
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
            attached.set(track.sampleId, hydrateSample(meta, raw));
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
      if (!hasSource) {
        $('dropZone').classList.add('is-hidden');
        if (ctx.api.showTab) ctx.api.showTab('machine');
        const crateTab = document.querySelector('.yj-substate-btn[data-mstate="crate"]');
        if (crateTab) crateTab.click();
      }
      const parts = ['RESTORED · ' + sessionLabel(json).toUpperCase()];
      if (document.wasDiscarded === true) parts[0] += ' · AFTER A TAB DISCARD';
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
    if (typeof window !== 'undefined' && typeof window.confirm === 'function'
      && !window.confirm('Discard the saved Yellowjacket session? This cannot be undone. CRATE instruments are kept.')) {
      status('SAVED SESSION KEPT');
      return;
    }
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
  $('btnProjectSave').addEventListener('click', exportProject);
  $('btnProjectOpen').addEventListener('click', () => $('projectInput').click());
  $('btnProjectOpen2').addEventListener('click', () => $('projectInput').click());
  $('projectInput').addEventListener('change', (e) => {
    if (e.target.files[0]) importProjectFile(e.target.files[0]);
    e.target.value = '';
  });
  store.addEventListener('change', () => {
    $('btnProjectSave').disabled = !projectHasContent(P, R);
  });
  $('btnProjectSave').disabled = !projectHasContent(P, R);

  ctx.api.exportProject = exportProject;
  ctx.api.importProjectFile = importProjectFile;

  boot();
}
