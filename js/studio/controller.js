// Studio controller: document mutations, transport, and stereo bounce.

import { applyInstrumentPreset, generateStudioIdea, normalizeStep, transformStudioBar } from './model.js';
import { studioMidiFile } from './midi.js';
import { encodeWav, download } from '../export.js';

export function initStudioController(ctx) {
  const { store, studioEngine, views, status, statusFault, $ } = ctx;
  const view = views.studio;
  if (!view || !studioEngine) return;
  const studio = store.project.studio;

  studioEngine.setStudio(studio);
  view.setStudio(studio);

  function edit(kind, fn) {
    store.update(kind, (project) => {
      project.studio.touched = true;
      fn(project.studio);
      const loomPlan = project.loom && project.loom.plan;
      if (loomPlan && loomPlan.gesture && /^studio-/.test(loomPlan.gesture.id || '')) {
        project.loom.plan = null;
        project.loom.activePlanId = null;
      }
    });
    studioEngine.setStudio(studio);
    view.setStudio(studio);
    if ($('dropZone')) $('dropZone').classList.add('is-hidden');
  }

  view.addEventListener('play', () => {
    if (!studioEngine.running && ctx.api.stopLoom) ctx.api.stopLoom();
    studioEngine.toggle();
  });
  view.addEventListener('stop', () => studioEngine.stop());
  view.addEventListener('studio', (event) => edit('studio', (doc) => { doc[event.detail.key] = event.detail.value; }));
  view.addEventListener('preset', (event) => edit('studio-sound', (doc) => {
    const track = doc.tracks[event.detail.track];
    if (track) applyInstrumentPreset(track, event.detail.id);
  }));
  view.addEventListener('track', (event) => edit('studio-mix', (doc) => {
    const track = doc.tracks[event.detail.track];
    if (track) track[event.detail.key] = event.detail.value;
  }));
  view.addEventListener('synth', (event) => edit('studio-sound', (doc) => {
    const track = doc.tracks[event.detail.track];
    if (!track) return;
    track.preset = 'custom';
    track.name = 'CUSTOM ' + (event.detail.track + 1);
    track.synth[event.detail.key] = event.detail.value;
  }));
  view.addEventListener('step', (event) => edit('studio-notes', (doc) => {
    const track = doc.tracks[event.detail.track];
    if (track && event.detail.index >= 0 && event.detail.index < track.steps.length) {
      track.steps[event.detail.index] = normalizeStep(event.detail.value);
    }
  }));
  view.addEventListener('clearbar', (event) => edit('studio-notes', (doc) => {
    const track = doc.tracks[event.detail.track];
    if (!track) return;
    const start = event.detail.page * 16;
    for (let i = start; i < start + 16; i++) track.steps[i] = null;
  }));
  view.addEventListener('idea', () => {
    const hasNotes = studio.tracks.some((track) => track.steps.some(Boolean));
    if (hasNotes && typeof window.confirm === 'function'
      && !window.confirm('Replace the current Studio notes with a new key-aware idea? You can undo this.')) return;
    edit('studio-idea', (doc) => generateStudioIdea(doc));
    status('STUDIO IDEA · ' + studio.bars + ' BARS · ' + studio.bpm + ' BPM');
  });
  view.addEventListener('transform', (event) => edit('studio-notes', (doc) => {
    const track = doc.tracks[event.detail.track];
    if (!track) return;
    if (transformStudioBar(track, event.detail.page, event.detail.operation)
      && event.detail.operation === 'duplicate') {
      doc.bars = Math.max(doc.bars, Math.min(4, event.detail.page + 2));
    }
  }));
  view.addEventListener('preview', (event) => {
    const d = event.detail;
    studioEngine.preview(d.track, d.note, d.chord, d.velocity);
  });
  view.addEventListener('bounce', async () => {
    try {
      status('STUDIO · BOUNCING 48 kHz STEREO…', true);
      const buffer = await studioEngine.render();
      const base = String(store.project.fileName || 'yellowjacket-studio').replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-');
      download(encodeWav(buffer, 24), base + '.studio.wav', 'audio/wav');
      status('STUDIO BOUNCE · ' + buffer.duration.toFixed(2) + 's · 24-BIT WAV');
    } catch (error) {
      statusFault('STUDIO BOUNCE FAULT · ' + (error && error.message ? error.message : error));
    }
  });
  view.addEventListener('midiexport', () => {
    const base = String(store.project.fileName || 'yellowjacket-studio').replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-');
    download(studioMidiFile(studio), base + '.studio.mid', 'audio/midi');
    status('STUDIO MIDI · 6 CHANNELS · ' + studio.bars + (studio.bars === 1 ? ' BAR' : ' BARS'));
  });

  studioEngine.addEventListener('state', (event) => {
    view.setPlaying(event.detail.playing);
    status(event.detail.playing ? 'STUDIO PLAYING · ' + studio.bpm + ' BPM' : 'STUDIO STOPPED', event.detail.playing);
  });
  studioEngine.addEventListener('step', (event) => view.setStep(event.detail.step));

  // Undo, project import, and resume mutate the document behind this surface.
  store.addEventListener('change', (event) => {
    if (String(event.detail.kind).startsWith('studio')) return;
    studioEngine.setStudio(studio);
    view.setStudio(studio);
  });

  ctx.api.toggleStudio = () => studioEngine.toggle();
  ctx.api.stopStudio = () => studioEngine.stop();
  ctx.api.previewStudio = (track, note) => studioEngine.preview(track, note);
  ctx.api.generateStudioIdea = () => view.dispatchEvent(new CustomEvent('idea'));
}
