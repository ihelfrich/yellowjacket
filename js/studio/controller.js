// Studio controller: document mutations, transport, and stereo bounce.

import { applyInstrumentPreset, generateStudioIdea, normalizeStep, transformStudioBar } from './model.js';
import { studioMidiFile } from './midi.js';
import { parseSmf, smfToStudio } from '../midi/smf.js';
import { bounceSampleRate } from './engine.js';
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
      // The bounce follows the loaded session rather than a fixed 48 kHz, so a
      // 96 kHz session does not lose half its resolution on the way out.
      studioEngine.sessionRate = store.runtime.sampleRate || 0;
      const rate = bounceSampleRate(studioEngine.sessionRate);
      status('STUDIO · BOUNCING ' + Math.round(rate / 1000) + ' kHz STEREO…', true);
      const buffer = await studioEngine.render();
      const base = String(store.project.fileName || 'yellowjacket-studio').replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-');
      download(encodeWav(buffer, 24), base + '.studio.wav', 'audio/wav');
      status('STUDIO BOUNCE · ' + buffer.duration.toFixed(2) + 's · 24-BIT · '
        + Math.round(buffer.sampleRate / 1000) + ' kHz');
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

  // A .mid dropped on the bench fills STUDIO's parts. Only the parts the file
  // actually carries are overwritten: importing a two-part sketch should not
  // silently erase four parts of existing work, and UNDO covers the rest.
  ctx.api.importMidiFile = async (file) => {
    let imported;
    try {
      imported = smfToStudio(parseSmf(new Uint8Array(await file.arrayBuffer())));
    } catch (error) {
      statusFault('MIDI FAULT · ' + (error && error.message ? error.message : 'unreadable file'));
      return;
    }
    if (!imported.tracks.length) {
      statusFault('MIDI FAULT · no notes in that file');
      return;
    }
    edit('studio-midi-import', (s) => {
      s.bpm = Math.max(40, Math.min(240, Math.round(imported.bpm) || 120));
      s.bars = 4;
      imported.tracks.forEach((part, index) => {
        const track = s.tracks[index];
        if (!track) return;
        for (let step = 0; step < track.steps.length; step++) {
          track.steps[step] = part.steps[step] ? normalizeStep(part.steps[step]) : null;
        }
        if (part.name) track.name = part.name.slice(0, 16);
      });
    });
    const parts = imported.tracks.length;
    status('MIDI IN · ' + parts + (parts === 1 ? ' PART' : ' PARTS')
      + ' · ' + Math.round(imported.bpm) + ' BPM'
      + (imported.dropped ? ' · ' + imported.dropped + ' NOTES PAST 4 BARS DROPPED' : ''));
  };

  ctx.api.toggleStudio = () => studioEngine.toggle();
  ctx.api.stopStudio = () => studioEngine.stop();
  ctx.api.previewStudio = (track, note) => studioEngine.preview(track, note);
  ctx.api.generateStudioIdea = () => view.dispatchEvent(new CustomEvent('idea'));
}
