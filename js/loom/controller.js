// LOOM controller: snapshots material, chooses a MIDI-shaped gesture, compiles
// one reversible plan, and auditions it directly from the immutable source.

import {
  compileLoomPlan, demoMidiGesture, demoRegionFor, sameLoomPlanContent, sourceMatchesPlan, spanMaterials,
  studioGesture, traceLoomEvent, transcriptMaterials,
} from './compile.js';
import { captureBarDuration, capturedMidiGesture } from './capture.js';

function sourceDescriptor(project, runtime) {
  const size = runtime.sourceBytes ? runtime.sourceBytes.byteLength : null;
  return {
    // Encoded-source SHA is the stable lineage identity. Generation is only a
    // stale-job token and changes across a perfectly valid project restore.
    id: runtime.sourceHash || 'current-source',
    name: project.fileName || 'SOURCE',
    size,
  };
}

function waveform(mono, sampleRate, startSec, endSec, bins = 96) {
  if (!mono || !(sampleRate > 0)) return [];
  const start = Math.max(0, Math.floor(startSec * sampleRate));
  const end = Math.min(mono.length, Math.ceil(endSec * sampleRate));
  if (end <= start) return [];
  const out = new Array(bins).fill(0);
  for (let bin = 0; bin < bins; bin++) {
    const a = start + Math.floor((end - start) * bin / bins);
    const b = start + Math.max(1, Math.floor((end - start) * (bin + 1) / bins));
    let peak = 0;
    for (let index = a; index < Math.min(end, b); index++) peak = Math.max(peak, Math.abs(mono[index]));
    out[bin] = peak;
  }
  const max = Math.max(0.0001, ...out);
  return out.map((value) => value / max);
}

function materialState(materials, kind, runtime) {
  if (!materials || !materials.length) return null;
  const startSec = Math.min(...materials.map((item) => item.origin.startSec));
  const endSec = Math.max(...materials.map((item) => item.origin.endSec));
  const wordCount = kind === 'transcript' ? materials.reduce((count, item) => {
    const first = Number(item.origin.wordStart);
    const last = Number(item.origin.wordEnd);
    return count + (Number.isInteger(first) && Number.isInteger(last) && last >= first
      ? last - first + 1 : 0);
  }, 0) : 0;
  return {
    kind,
    materials,
    sourceName: materials[0].origin.sourceName,
    sourceSize: materials[0].origin.sourceSize,
    startSec,
    endSec,
    wordCount,
    voiceCount: materials.length,
    waveform: waveform(runtime.mono, runtime.sampleRate, startSec, endSec),
  };
}

function gestureFromPlan(plan) {
  if (!plan || !plan.gesture || !Array.isArray(plan.events)) return null;
  return {
    ...plan.gesture,
    events: plan.events.map((event) => {
      const saved = event && event.gesture && typeof event.gesture === 'object'
        ? event.gesture : {};
      const fallbackDuration = Math.max(0.01,
        (Number(event && event.outEndSec) || 0) - (Number(event && event.outStartSec) || 0));
      const note = Number.isFinite(saved.note) ? saved.note : 60;
      return {
        eventRef: saved.eventRef && typeof saved.eventRef === 'object' ? { ...saved.eventRef } : {},
        trackIndex: Math.max(0, Number(saved.channel) || 0),
        stepIndex: Number.isFinite(event && event.stepIndex) ? event.stepIndex : 0,
        gridStep: Number.isFinite(event && event.gridStep) ? event.gridStep : event.stepIndex,
        startSec: Number.isFinite(event && event.outStartSec) ? event.outStartSec : 0,
        durationSec: Number.isFinite(saved.durationSec)
          ? Math.max(0.01, saved.durationSec) : fallbackDuration,
        rawStartSec: Number.isFinite(saved.rawStartSec)
          ? saved.rawStartSec : (Number.isFinite(event && event.outStartSec) ? event.outStartSec : 0),
        nudge: Number.isFinite(saved.nudge) ? saved.nudge : 0,
        rootNote: note,
        writtenNote: Number.isFinite(saved.writtenNote) ? saved.writtenNote : note,
        chord: 'single',
        heardNotes: Array.isArray(saved.heardNotes) ? saved.heardNotes.slice() : [note],
        velocity: Number.isFinite(saved.velocity) ? saved.velocity : 0.8,
        gate: Number.isFinite(saved.gate) ? saved.gate : 0.9,
        audible: true,
      };
    }),
  };
}

export function initLoomController(ctx) {
  const { store, engine, loomEngine, studioEngine, sequencer, auditioner, views, status, statusFault } = ctx;
  const view = views.loom;
  if (!view || !loomEngine) return;
  const P = store.project;
  const R = store.runtime;
  let material = null;
  let gestureChoice = 'demo';
  let gesture = demoMidiGesture(P.studio.bpm, P.studio.swing);
  let selectedEventId = null;
  let activeEventId = null;
  let midiCaptureState = 'idle';
  let midiCaptureUnsubscribe = null;
  let midiCaptureTimer = 0;
  let midiCaptureFirstMs = null;
  let midiCaptureNotes = [];
  let midiCaptureOpen = new Map();
  let midiCaptureBpm = P.machine.bpm;
  let midiCaptureSwing = P.machine.swing;
  let midiCaptureInputId = null;

  function currentTempo() {
    const analysisTempo = R.analysis && Number(R.analysis.tempo);
    return analysisTempo > 30 && analysisTempo < 300 ? analysisTempo : P.studio.bpm;
  }

  function currentPlan() {
    const loom = P.loom;
    if (!loom) return null;
    const id = typeof loom.activePlanId === 'string' ? loom.activePlanId : null;
    if (id && loom.plans && loom.plans[id]) return loom.plans[id];
    return loom.plan && typeof loom.plan === 'object' ? loom.plan : null;
  }

  function planIsOnline(plan) {
    if (!plan || !R.buffer) return false;
    return sourceMatchesPlan(plan, {
      id: R.sourceHash,
      hash: R.sourceHash,
      name: P.fileName,
      size: R.sourceBytes && R.sourceBytes.byteLength,
    });
  }

  function armedState(plan) {
    const activeIndex = P.machine && Number.isInteger(P.machine.activeScene)
      ? P.machine.activeScene : 0;
    const scenes = P.machine && Array.isArray(P.machine.scenes) ? P.machine.scenes : [];
    const active = scenes[activeIndex] || null;
    const activePlanId = active && active.loomLane && typeof active.loomLane.planId === 'string'
      ? active.loomLane.planId : null;
    if (!plan || typeof plan.id !== 'string') {
      return { armedSceneIndex: null, armedPlanId: activePlanId };
    }
    const references = (scene) => !!(scene && scene.loomLane && scene.loomLane.planId === plan.id);
    const firstIndex = references(active) ? activeIndex : scenes.findIndex(references);
    return {
      armedSceneIndex: firstIndex >= 0 ? firstIndex : null,
      armedPlanId: firstIndex >= 0 ? plan.id : activePlanId,
    };
  }

  function choiceFromPlan(plan) {
    if (!plan || !plan.gesture) return 'demo';
    const kind = String(plan.gesture.kind || '');
    if (kind === 'starter' || plan.gesture.id === 'demo-midi-v1') return 'demo';
    if (kind && kind !== 'studio') return 'restored';
    const channel = Math.max(0, Math.min(P.studio.tracks.length - 1, Number(plan.gesture.channel) || 0));
    return 'studio-' + channel;
  }

  function restorePlanIntoEditor(plan) {
    if (!plan) return false;
    const kind = Array.isArray(plan.materials)
      && plan.materials.some((item) => item && item.role === 'word')
      ? 'transcript' : 'source-span';
    // An offline plan keeps its map and provenance, but must not draw a waveform
    // from whichever unrelated source happens to be loaded now.
    material = materialState(plan.materials, kind, planIsOnline(plan) ? R : {});
    gesture = gestureFromPlan(plan);
    gestureChoice = choiceFromPlan(plan);
    selectedEventId = plan.events && plan.events[0] ? plan.events[0].id : null;
    activeEventId = null;
    return true;
  }

  function invalidatePlan(kind) {
    if (!(P.loom && (P.loom.plan || P.loom.activePlanId))) return false;
    loomEngine.stop();
    selectedEventId = null;
    activeEventId = null;
    store.update(kind, (project) => {
      // Clear only the editable draft aliases. Content-addressed plans and any
      // Machine scene lanes that reference them are immutable history.
      project.loom.activePlanId = null;
      project.loom.plan = null;
    });
    return true;
  }

  function options() {
    const out = [{ id: 'demo', label: 'DEMO MIDI · 1 BAR' }];
    if (gestureChoice === 'midi-capture' && gesture) {
      out.push({
        id: 'midi-capture',
        label: String(gesture.label || 'MIDI INPUT').toUpperCase() + ' · '
          + gesture.events.length + (gesture.events.length === 1 ? ' NOTE' : ' NOTES'),
      });
    }
    if (gestureChoice === 'restored' && gesture) {
      out.push({ id: 'restored', label: String(gesture.label || 'RESTORED GESTURE').toUpperCase() + ' · RESTORED' });
    }
    const page = views.studio ? views.studio.page : 0;
    P.studio.tracks.forEach((track, index) => {
      const start = page * 16;
      const count = track.steps.slice(start, start + 16).filter(Boolean).length;
      out.push({
        id: 'studio-' + index,
        label: 'STUDIO ' + (index + 1) + ' · ' + String(track.name || 'TRACK').toUpperCase()
          + ' · ' + count + (count === 1 ? ' NOTE' : ' NOTES'),
        disabled: count === 0,
      });
    });
    return out;
  }

  function captureInputMatches(wireState) {
    const inputId = wireState && wireState.inputId != null ? String(wireState.inputId) : null;
    return !!(wireState && wireState.available && midiCaptureInputId != null
      && inputId === midiCaptureInputId);
  }

  function refresh() {
    const plan = currentPlan();
    const armed = armedState(plan);
    const wireState = ctx.api.wireCaptureState ? ctx.api.wireCaptureState() : null;
    let captureActive = midiCaptureState === 'armed' || midiCaptureState === 'capturing';
    if (captureActive && !captureInputMatches(wireState)) {
      resetMidiCapture();
      captureActive = false;
      statusFault('MIDI CAPTURE CANCELLED · SELECTED INPUT CHANGED OR WENT OFFLINE');
    }
    view.setState({
      material,
      gesture,
      gestureOptions: options(),
      gestureChoice,
      plan,
      selectedEventId,
      activeEventId,
      playing: loomEngine.playing,
      hasSource: !!R.buffer,
      armedSceneIndex: armed.armedSceneIndex,
      armedPlanId: armed.armedPlanId,
      sourceOnline: plan ? planIsOnline(plan) : !!R.buffer,
      midiCaptureAvailable: captureActive || !!(wireState && wireState.available),
      midiCaptureState: captureActive
        ? midiCaptureState : (wireState && wireState.available ? 'idle' : 'unavailable'),
    });
  }

  function setMaterial(materials, kind) {
    material = materialState(materials, kind, R);
    selectedEventId = null;
    invalidatePlan('loom-material');
    refresh();
  }

  function chooseDemoGesture() {
    gestureChoice = 'demo';
    gesture = demoMidiGesture(currentTempo(), R.analysis ? P.machine.swing : P.studio.swing);
    invalidatePlan('loom-gesture');
    refresh();
  }

  function chooseStudioGesture(index) {
    const page = views.studio ? views.studio.page : 0;
    const selected = studioGesture(P.studio, index, page);
    if (!selected) {
      statusFault('LOOM NEEDS NOTES · WRITE THE VISIBLE STUDIO BAR OR USE DEMO MIDI');
      return;
    }
    gestureChoice = 'studio-' + index;
    gesture = selected;
    invalidatePlan('loom-gesture');
    refresh();
  }

  function resetMidiCapture() {
    if (midiCaptureTimer) clearTimeout(midiCaptureTimer);
    midiCaptureTimer = 0;
    if (midiCaptureUnsubscribe) midiCaptureUnsubscribe();
    midiCaptureUnsubscribe = null;
    midiCaptureFirstMs = null;
    midiCaptureNotes = [];
    midiCaptureOpen = new Map();
    midiCaptureInputId = null;
    midiCaptureState = 'idle';
  }

  function finishMidiCapture() {
    if (midiCaptureState !== 'capturing') return;
    const wireState = ctx.api.wireCaptureState ? ctx.api.wireCaptureState() : null;
    if (!captureInputMatches(wireState)) {
      resetMidiCapture();
      refresh();
      statusFault('MIDI CAPTURE CANCELLED · SELECTED INPUT CHANGED OR WENT OFFLINE');
      return;
    }
    const capturedInputId = midiCaptureInputId;
    const barSec = captureBarDuration(midiCaptureBpm, midiCaptureSwing);
    for (const indexes of midiCaptureOpen.values()) {
      for (const index of indexes) {
        const note = midiCaptureNotes[index];
        if (note && !Number.isFinite(note.endSec)) note.endSec = barSec;
      }
    }
    const captured = capturedMidiGesture(midiCaptureNotes, {
      bpm: midiCaptureBpm,
      swing: midiCaptureSwing,
      label: 'MIDI INPUT',
      inputId: capturedInputId,
    });
    resetMidiCapture();
    if (!captured) {
      refresh();
      statusFault('MIDI CAPTURE EMPTY · ARM AGAIN AND PLAY AT LEAST ONE NOTE');
      return;
    }
    gestureChoice = 'midi-capture';
    gesture = captured;
    invalidatePlan('loom-gesture');
    refresh();
    status('MIDI GESTURE READY · ' + captured.events.length
      + (captured.events.length === 1 ? ' NOTE' : ' NOTES')
      + ' · FEEL AS PLAYED');
  }

  function captureWireNote(message) {
    if (midiCaptureState !== 'armed' && midiCaptureState !== 'capturing') return false;
    const wireState = ctx.api.wireCaptureState ? ctx.api.wireCaptureState() : null;
    if (!captureInputMatches(wireState)) {
      resetMidiCapture();
      refresh();
      statusFault('MIDI CAPTURE CANCELLED · SELECTED INPUT CHANGED OR WENT OFFLINE');
      return true;
    }
    const stamp = Number(message && message.timeStamp);
    if (!Number.isFinite(stamp)) return true;
    if (midiCaptureState === 'armed') {
      if (message.type !== 'noteon') return true;
      midiCaptureFirstMs = stamp;
      midiCaptureState = 'capturing';
      const barMs = captureBarDuration(midiCaptureBpm, midiCaptureSwing) * 1000;
      midiCaptureTimer = setTimeout(finishMidiCapture, Math.ceil(barMs) + 12);
      refresh();
      status('CAPTURING MIDI · 1 BAR · ' + midiCaptureBpm + ' BPM', true);
    }
    const elapsed = Math.max(0, (stamp - midiCaptureFirstMs) / 1000);
    const barSec = captureBarDuration(midiCaptureBpm, midiCaptureSwing);
    const key = String(message.channel) + ':' + String(message.note);
    if (message.type === 'noteon') {
      if (elapsed >= barSec) return true;
      const index = midiCaptureNotes.push({
        note: message.note,
        velocity: message.velocity,
        channel: message.channel,
        startSec: elapsed,
        endSec: null,
      }) - 1;
      const open = midiCaptureOpen.get(key) || [];
      open.push(index);
      midiCaptureOpen.set(key, open);
    } else if (message.type === 'noteoff') {
      const open = midiCaptureOpen.get(key);
      if (open && open.length) {
        const index = open.shift();
        const note = midiCaptureNotes[index];
        if (note) note.endSec = Math.max(note.startSec + 0.02, Math.min(barSec, elapsed));
        if (!open.length) midiCaptureOpen.delete(key);
      }
    }
    return true;
  }

  function armMidiCapture() {
    const wireState = ctx.api.wireCaptureState ? ctx.api.wireCaptureState() : null;
    if (!wireState || !wireState.available || !ctx.api.subscribeWireNotes) {
      statusFault('MIDI INPUT OFFLINE · CONNECT AND SELECT AN INPUT IN WIRE');
      refresh();
      return;
    }
    resetMidiCapture();
    midiCaptureBpm = P.machine.bpm;
    midiCaptureSwing = P.machine.swing;
    midiCaptureInputId = String(wireState.inputId);
    midiCaptureUnsubscribe = ctx.api.subscribeWireNotes(captureWireNote);
    midiCaptureState = 'armed';
    refresh();
    status('MIDI CAPTURE ARMED · WAITING FOR FIRST NOTE', true);
  }

  function cancelMidiCapture() {
    const active = midiCaptureState === 'armed' || midiCaptureState === 'capturing';
    resetMidiCapture();
    refresh();
    if (active) status('MIDI CAPTURE CANCELLED · PRIOR GESTURE KEPT');
  }

  function loadTranscriptRange(range, openLoom = false) {
    if (!R.buffer || !R.sourceHash || !P.words
      || !range || !Number.isInteger(range.i0) || !Number.isInteger(range.i1)) {
      statusFault('LOOM NEEDS SELECTED WORDS FROM AN ONLINE SOURCE');
      return 0;
    }
    let materials;
    try {
      materials = transcriptMaterials(P.words, range.i0, range.i1, sourceDescriptor(P, R));
    } catch (error) {
      statusFault(error && error.code
        ? error.message : 'LOOM COULD NOT GROUP THE SELECTED WORDS SAFELY');
      return 0;
    }
    if (!materials.length) {
      statusFault('LOOM NEEDS KEPT WORDS · THE SELECTION CONTAINS ONLY CUT OR INVALID TOKENS');
      return 0;
    }
    setMaterial(materials, 'transcript');
    if (openLoom && ctx.api.showTab) ctx.api.showTab('loom');
    const wordCount = material.wordCount || materials.length;
    const grouped = wordCount !== materials.length
      ? ' → ' + materials.length + ' VOICES · ADJACENT WORDS JOINED' : '';
    status('LOOM MATERIAL · ' + wordCount + (wordCount === 1 ? ' WORD' : ' WORDS')
      + grouped + ' · SOURCE PRESERVED');
    return wordCount;
  }

  view.addEventListener('materialselect', () => {
    if (!R.buffer) return;
    const source = sourceDescriptor(P, R);
    const range = ctx.api.getLiftRange && ctx.api.getLiftRange();
    if (range && P.words && loadTranscriptRange(range)) return;
    const clip = views.sliceView && views.sliceView.selectedClip;
    if (clip) {
      const materials = spanMaterials({
        sourceId: source.id, sourceName: source.name, sourceSize: source.size,
        startSec: clip.start, endSec: clip.end, segments: 1, label: clip.label || clip.tag || 'CLIP',
      });
      setMaterial(materials, 'clip');
      status('LOOM MATERIAL · 1 CLIP · SOURCE PRESERVED');
      return;
    }
    statusFault('LOOM NEEDS A SELECTION · DRAG WORDS IN TRANSCRIPT OR PICK A MACHINE CLIP');
  });

  view.addEventListener('demomaterial', () => {
    if (!R.buffer) return;
    const source = sourceDescriptor(P, R);
    const region = demoRegionFor(R.buffer.duration, P.fileName);
    const materials = spanMaterials({
      sourceId: source.id, sourceName: source.name, sourceSize: source.size,
      startSec: region.startSec, endSec: region.endSec, segments: 4, label: region.label,
    });
    setMaterial(materials, 'source-span');
    status('LOOM MATERIAL · ' + (region.endSec - region.startSec).toFixed(2) + 'S · 4 REAL SOURCE SPANS');
  });

  view.addEventListener('gesturechange', (event) => {
    if (midiCaptureState === 'armed' || midiCaptureState === 'capturing') resetMidiCapture();
    const id = String(event.detail.id || 'demo');
    if (id === 'demo') chooseDemoGesture();
    else if (id === 'midi-capture' && gesture && gesture.kind === 'midi-capture') {
      gestureChoice = 'midi-capture';
      refresh();
    }
    else if (/^studio-\d+$/.test(id)) chooseStudioGesture(Number(id.slice(7)));
  });
  view.addEventListener('capturemidi', armMidiCapture);
  view.addEventListener('cancelcapture', cancelMidiCapture);

  view.addEventListener('weave', () => {
    if (!material || !gesture) return;
    try {
      const weaveNumber = (P.loom.weaveCount | 0) + 1;
      const compiled = compileLoomPlan(material.materials, gesture, { weaveNumber });
      const existing = P.loom.plans && P.loom.plans[compiled.id];
      if (existing && !sameLoomPlanContent(existing, compiled)) {
        throw new Error('LOOM PLAN ID COLLISION · WEAVE WAS NOT STORED');
      }
      let plan;
      store.update('loom-compile', (project) => {
        project.loom.weaveCount = weaveNumber;
        if (!project.loom.plans || typeof project.loom.plans !== 'object') project.loom.plans = {};
        // IDs are content-addressed. Never overwrite an existing entry: scenes
        // may already point at that exact immutable performance recipe.
        if (!project.loom.plans[compiled.id]) project.loom.plans[compiled.id] = compiled;
        plan = project.loom.plans[compiled.id];
        project.loom.activePlanId = plan.id;
        project.loom.plan = plan; // legacy readers retain the active-plan alias
      });
      selectedEventId = plan.events[0] ? plan.events[0].id : null;
      refresh();
      status('LOOM WEAVE ' + String(P.loom.weaveCount).padStart(2, '0') + ' · '
        + plan.diagnostics.tracedCount + '/' + plan.diagnostics.eventCount + ' EVENTS TRACED');
    } catch (error) {
      statusFault('LOOM FAULT · ' + (error && error.message ? error.message : error));
    }
  });

  view.addEventListener('audition', () => {
    const plan = currentPlan();
    if (!plan || !planIsOnline(plan)) {
      statusFault('LOOM SOURCE OFFLINE · LOAD THE RECORDING THAT CREATED THIS WEAVE');
      return;
    }
    if (engine.playing) engine.pause();
    if (sequencer.running) sequencer.stop();
    if (studioEngine.running) studioEngine.stop();
    if (!loomEngine.play(plan)) {
      statusFault('LOOM AUDITION FAULT · SOURCE AUDIO IS NOT READY');
      return;
    }
    status('LOOM AUDITION · EVERY HIT RETAINS SOURCE + GESTURE', true);
  });
  view.addEventListener('stop', () => loomEngine.stop());
  view.addEventListener('arm', (event) => {
    const plan = currentPlan();
    if (!plan || !planIsOnline(plan)) {
      statusFault('LOOM SOURCE OFFLINE · RECONNECT THE RECORDING BEFORE ARMING A SCENE');
      return;
    }
    const requested = Number(event.detail && event.detail.sceneIndex);
    const scenes = P.machine && Array.isArray(P.machine.scenes) ? P.machine.scenes : [];
    const sceneIndex = Number.isInteger(requested) && requested >= 0 && requested < scenes.length
      ? requested : (P.machine && Number.isInteger(P.machine.activeScene) ? P.machine.activeScene : 0);
    const scene = P.machine && Array.isArray(P.machine.scenes) ? P.machine.scenes[sceneIndex] : null;
    if (!scene) {
      statusFault('LOOM ARM FAULT · ACTIVE MACHINE SCENE IS UNAVAILABLE');
      return;
    }
    const existing = P.loom && P.loom.plans && P.loom.plans[plan.id];
    if (existing && !sameLoomPlanContent(existing, plan)) {
      statusFault('LOOM PLAN ID COLLISION · SCENE WAS NOT CHANGED');
      return;
    }
    store.update('loom-arm', (project) => {
      const loom = project.loom;
      if (!loom.plans || typeof loom.plans !== 'object') loom.plans = {};
      if (!loom.plans[plan.id]) loom.plans[plan.id] = plan;
      const stored = loom.plans[plan.id];
      loom.activePlanId = stored.id;
      loom.plan = stored;
      const target = project.machine.scenes[sceneIndex];
      if (!target.loomLane || typeof target.loomLane !== 'object') {
        target.loomLane = { planId: null, enabled: true, gainDb: -9, pan: 0, repeatSteps: 16, startStep: 0 };
      }
      target.loomLane.planId = stored.id;
      target.loomLane.enabled = true;
    });
    refresh();
    status('SEMANTIC TAKE ARMED · SCENE ' + (sceneIndex + 1) + ' · ' + plan.events.length
      + (plan.events.length === 1 ? ' EVENT' : ' EVENTS'));
  });

  function hearOrigin(origin) {
    if (!origin) return false;
    if (!R.buffer) {
      statusFault('LOOM SOURCE OFFLINE · RECONNECT THE RECORDING TO HEAR THIS MATERIAL');
      return false;
    }
    engine.wake();
    auditioner.play({ start: origin.startSec, end: origin.endSec });
    return true;
  }

  view.addEventListener('hearmaterial', (event) => {
    const item = material && material.materials[event.detail.materialIndex];
    if (item) hearOrigin(item.origin);
  });
  view.addEventListener('hearevent', (event) => {
    const hit = traceLoomEvent(currentPlan(), event.detail.id);
    if (hit) hearOrigin(hit.source);
  });
  view.addEventListener('eventselect', (event) => {
    selectedEventId = event.detail.id;
    refresh();
  });
  function traceEventById(eventId, planId = null) {
    const plan = planId && P.loom && P.loom.plans
      ? P.loom.plans[planId] || null : currentPlan();
    const hit = traceLoomEvent(plan, eventId);
    if (!hit) return false;
    loomEngine.stop();
    if (!planIsOnline(plan)) {
      status('TRACE · SOURCE OFFLINE · ' + String(hit.source.sourceName || 'SOURCE').toUpperCase() + ' · '
        + hit.source.startSec.toFixed(3) + '–' + hit.source.endSec.toFixed(3) + 'S');
      return true;
    }
    if (ctx.api.uiSeek) ctx.api.uiSeek(hit.source.startSec);
    if (Number.isInteger(hit.source.wordStart) && views.transcript && views.transcript.selectRange) {
      views.transcript.selectRange(hit.source.wordStart, hit.source.wordEnd, { emit: false, scroll: true });
      if (ctx.api.showTab) ctx.api.showTab('transcript');
      status('TRACE · “' + hit.source.label.toUpperCase() + '” · '
        + hit.source.startSec.toFixed(3) + '–' + hit.source.endSec.toFixed(3) + 'S');
    } else {
      if (ctx.api.showTab) ctx.api.showTab('signal');
      status('TRACE · SOURCE SPAN · ' + hit.source.startSec.toFixed(3) + '–'
        + hit.source.endSec.toFixed(3) + 'S');
    }
    return true;
  }
  view.addEventListener('trace', (event) => traceEventById(event.detail.id));

  function openPlanById(planId) {
    const id = typeof planId === 'string' ? planId : null;
    const plan = id && P.loom && P.loom.plans ? P.loom.plans[id] || null : null;
    if (!plan) {
      statusFault('LOOM PLAN OFFLINE · THIS SCENE REFERENCE HAS NO SAVED PLAN');
      return false;
    }
    loomEngine.stop();
    if (!currentPlan() || currentPlan().id !== plan.id) {
      store.update('loom-open', (project) => {
        project.loom.activePlanId = plan.id;
        project.loom.plan = project.loom.plans[plan.id];
      });
    }
    restorePlanIntoEditor(plan);
    refresh();
    if (ctx.api.showTab) ctx.api.showTab('loom');
    status(planIsOnline(plan)
      ? 'LOOM PLAN OPEN · ' + plan.events.length + (plan.events.length === 1 ? ' EVENT' : ' EVENTS')
      : 'LOOM PLAN OPEN · SOURCE OFFLINE · TRACE REMAINS AVAILABLE');
    return true;
  }

  view.addEventListener('replacematerial', () => {
    if (ctx.api.showTab) ctx.api.showTab('transcript');
    status('LOOM · SELECT NEW WORDS, THEN RETURN AND USE SELECTION');
  });
  view.addEventListener('replacegesture', () => {
    if (ctx.api.showTab) ctx.api.showTab('studio');
    status('LOOM · WRITE OR EDIT A STUDIO BAR, THEN CHOOSE IT AS THE GESTURE');
  });
  view.addEventListener('openwire', () => {
    if (ctx.api.showTab) ctx.api.showTab('machine');
    const wire = document.querySelector('.yj-substate-btn[data-mstate="wire"]');
    if (wire) wire.click();
  });
  view.addEventListener('openmachine', (event) => {
    const requested = Number(event.detail && event.detail.sceneIndex);
    const scenes = P.machine && Array.isArray(P.machine.scenes) ? P.machine.scenes : [];
    const sceneIndex = Number.isInteger(requested) && requested >= 0 && requested < scenes.length
      ? requested : P.machine.activeScene;
    if (Number.isInteger(sceneIndex) && sceneIndex !== P.machine.activeScene) {
      store.update('scene', (project) => { project.machine.activeScene = sceneIndex; });
    }
    if (views.patternView && views.patternView.setMachine) views.patternView.setMachine(P.machine);
    if (ctx.api.showTab) ctx.api.showTab('machine');
    const pattern = document.querySelector('.yj-substate-btn[data-mstate="pattern"]');
    if (pattern) pattern.click();
    status('MACHINE · SCENE ' + ((P.machine.activeScene | 0) + 1) + ' · SEMANTIC TAKE ARMED');
  });

  loomEngine.addEventListener('event', (event) => {
    activeEventId = event.detail.id;
    refresh();
  });
  loomEngine.addEventListener('state', (event) => {
    if (!event.detail.playing) activeEventId = null;
    refresh();
    if (!event.detail.playing) status('LOOM AUDITION COMPLETE');
  });

  store.addEventListener('change', (event) => {
    const kind = String(event.detail.kind || '');
    if (kind === 'source' || kind === 'source-clear') {
      if (midiCaptureState === 'armed' || midiCaptureState === 'capturing') resetMidiCapture();
      loomEngine.stop();
      material = null;
      selectedEventId = null;
      chooseDemoGesture();
      return;
    }
    if (kind === 'analysis' && gestureChoice === 'demo' && !currentPlan()) {
      gesture = demoMidiGesture(currentTempo(), P.machine.swing);
    }
    if (kind.startsWith('studio')) {
      const match = /^studio-(\d+)$/.exec(gestureChoice);
      if (match) {
        const page = views.studio ? views.studio.page : 0;
        gesture = studioGesture(P.studio, Number(match[1]), page);
        selectedEventId = null;
        activeEventId = null;
      }
      refresh();
      return;
    }
    if (kind === 'history' || kind === 'relight') {
      const plan = currentPlan();
      if (plan) restorePlanIntoEditor(plan);
      else {
        selectedEventId = null;
      }
    }
    refresh();
  });

  const restored = currentPlan();
  if (restored) restorePlanIntoEditor(restored);
  refresh();
  // One press from anywhere: four real spans from the loaded source, woven
  // onto the starter phrase, armed as the ninth lane, and running. The same
  // three handlers a person would click, in order, with each step checked
  // before the next — a failed weave must not arm a stale plan.
  ctx.api.quickTake = () => {
    if (!R.buffer) { statusFault('QUICK TAKE · LOAD A RECORDING FIRST'); return false; }
    if (gestureChoice !== 'demo' || !gesture || gesture.kind === 'midi-capture') chooseDemoGesture();
    const before = P.loom.activePlanId || null;
    view.dispatchEvent(new CustomEvent('demomaterial'));
    if (!material) return false;
    view.dispatchEvent(new CustomEvent('weave'));
    const plan = currentPlan();
    if (!plan || (before === plan.id && P.loom.weaveCount === 0) || !planIsOnline(plan)) return false;
    view.dispatchEvent(new CustomEvent('arm', { detail: {} }));
    const armed = P.machine.scenes[P.machine.activeScene | 0];
    if (!armed || !armed.loomLane || armed.loomLane.planId !== plan.id) return false;
    if (ctx.api.jump) ctx.api.jump('machine', 'pattern');
    if (!sequencer.running && views.patternView) views.patternView.dispatchEvent(new CustomEvent('run'));
    status('QUICK TAKE · ' + plan.events.length + ' EVENTS ON LANE 9 · RUNNING · EVERY HIT TRACES TO THE SOURCE');
    return true;
  };
  ctx.api.weaveTranscriptSelection = (range) => loadTranscriptRange(range, true);
  ctx.api.traceLoomEvent = (eventId, planId = null) => traceEventById(eventId, planId);
  ctx.api.openLoomPlan = openPlanById;
  ctx.api.refreshLoom = refresh;
  ctx.api.stopLoom = () => loomEngine.stop();
  ctx.api.toggleLoom = () => {
    if (loomEngine.playing) loomEngine.stop();
    else view.dispatchEvent(new CustomEvent('audition'));
  };
}
