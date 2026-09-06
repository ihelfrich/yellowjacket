// Studio controller: document mutations, transport, and stereo bounce.

import { applyInstrumentPreset, applyCardInstrument, applyCustomScale, generateStudioIdea, normalizeStep, transformStudioBar, CARD_EXCITATIONS } from './model.js';
import { warmCardTrack } from './card-voice.js';
import { instrumentPool } from '../instrument/pool.js';
import { FOUND_CARDS, foundCardById, foundCardUrl } from './found-cards.js';
import { cardPitchHz } from '../instrument/family.js';
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
  // Cards: every note a card part will play is rendered ahead of playback,
  // between paints, so the sequencer only ever starts buffers it already has.
  const yieldToPaint = () => new Promise((resolve) => setTimeout(resolve, 0));
  let warming = null;
  function warmAll() {
    if (warming) return warming;
    warming = (async () => {
      await yieldToPaint();
      for (let i = 0; i < studio.tracks.length; i++) {
        const track = studio.tracks[i];
        if (!track.card) continue;
        await warmCardTrack(studioEngine.cache, studio, track, {
          pool: instrumentPool,
          yieldFn: yieldToPaint,
          onProgress: (done, total) => status('STUDIO · RENDERING ' + track.name + ' · ' + done + '/' + total, done < total),
        });
      }
      warming = null;
      // The warm ran under whatever the bench was saying; hand the status back.
      if (studioEngine.running) status('STUDIO PLAYING · ' + studio.bpm + ' BPM', true);
    })();
    return warming;
  }
  const cardFiles = new Map();
  async function loadFoundCard(id) {
    if (!cardFiles.has(id)) {
      cardFiles.set(id, fetch(foundCardUrl(id, document.baseURI)).then((r) => { if (!r.ok) throw new Error('card ' + id + ' · HTTP ' + r.status); return r.json(); }));
    }
    return cardFiles.get(id);
  }
  function setCard(trackIndex, card, excitation, name) {
    edit('studio-sound', (doc) => { applyCardInstrument(doc.tracks[trackIndex], card, excitation, name); });
    const track = studio.tracks[trackIndex];
    status('STUDIO · ' + track.name + ' ON PART ' + (trackIndex + 1) + ' · ' + track.card.excitation.toUpperCase());
    warmAll();
    return track;
  }
  ctx.api.studioSetScale = (intervals, name = 'CARD') => {
    edit('studio', (doc) => { applyCustomScale(doc, intervals, name); });
    status('STUDIO · SCALE ' + studio.customScale.name + ' · ' + studio.customScale.intervals.join(' '));
  };

  // The keyboard plays the selected part chromatically while STUDIO is up:
  // A W S E D F T G Y H U J from C, K O L P ; on into the next octave, Z and X
  // move the octave. A card part renders the note it does not have yet in a
  // worker and plays it when it lands; the octave around it warms behind.
  const KEY_SEMITONE = Object.assign(Object.create(null), { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16 });
  let keysEnabled = false, keyOctave = 4;
  async function playKey(midi) {
    const index = view.selectedTrack, track = studio.tracks[index];
    if (!track) return;
    if (track.card) {
      const { card, excitation } = track.card;
      const cache = studioEngine.cache;
      if (!cache.has(card, excitation, midi + (track.synth.transpose || 0), 0.85, 0.32)) await cache.renderAsync(instrumentPool, card, excitation, midi + (track.synth.transpose || 0), 0.85, 0.32);
      for (let m = midi - 5; m <= midi + 6; m++) if (!cache.has(card, excitation, m + (track.synth.transpose || 0), 0.85, 0.32)) cache.renderAsync(instrumentPool, card, excitation, m + (track.synth.transpose || 0), 0.85, 0.32).catch(() => {});
    }
    studioEngine.preview(index, midi, 'single', 0.85);
    status('STUDIO · PART ' + (index + 1) + ' · ' + track.name + ' · NOTE ' + midi + ' · Z/X OCTAVE ' + keyOctave);
  }
  window.addEventListener('keydown', (e) => {
    if (!keysEnabled || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target && e.target.closest && e.target.closest('input, select, textarea, [contenteditable], button')) return;
    if (e.code === 'KeyZ') { keyOctave = Math.max(1, keyOctave - 1); status('STUDIO · OCTAVE ' + keyOctave); e.preventDefault(); return; }
    if (e.code === 'KeyX') { keyOctave = Math.min(7, keyOctave + 1); status('STUDIO · OCTAVE ' + keyOctave); e.preventDefault(); return; }
    const semi = KEY_SEMITONE[e.code];
    if (semi === undefined) return;
    e.preventDefault();
    playKey(12 * (keyOctave + 1) + semi).catch(() => {});
  });
  ctx.api.setStudioKeysEnabled = (on) => { keysEnabled = !!on; if (on) status('STUDIO · KEYS A–; PLAY PART ' + (view.selectedTrack + 1) + ' · Z/X OCTAVE'); };

  ctx.api.studioSetCard = (card, excitation = 'strike', name = null, trackIndex = null) => {
    const index = trackIndex === null ? view.selectedTrack : trackIndex;
    const track = setCard(index, card, excitation, name);
    if (ctx.api.jump) ctx.api.jump('studio');
    const midi = Math.round(69 + 12 * Math.log2(cardPitchHz(card) / 440));
    try { studioEngine.preview(index, Math.max(0, Math.min(127, midi))); } catch (_) { /* no audio yet */ }
    return track;
  };

  view.addEventListener('preset', (event) => {
    const id = String(event.detail.id || '');
    if (id.startsWith('card:')) {
      const excitation = id.slice(5);
      edit('studio-sound', (doc) => { const t = doc.tracks[event.detail.track]; if (t.card && CARD_EXCITATIONS.includes(excitation)) t.card.excitation = excitation; });
      warmAll();
      return;
    }
    if (id.startsWith('found:')) {
      const spec = foundCardById(id.slice(6));
      if (!spec) return;
      status('STUDIO · FETCHING ' + spec.name + '…', true);
      loadFoundCard(spec.id)
        .then((card) => setCard(event.detail.track, card, spec.excitation, spec.name))
        .catch((err) => statusFault('STUDIO · ' + (err && err.message ? err.message : err)));
      return;
    }
    presetChange(event);
  });
  const presetChange = (event) => edit('studio-sound', (doc) => {
    const track = doc.tracks[event.detail.track];
    if (track) applyInstrumentPreset(track, event.detail.id);
  });
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
  view.addEventListener('play', () => warmAll());

  // Undo, project import, and resume mutate the document behind this surface.
  store.addEventListener('change', (event) => {
    if (String(event.detail.kind).startsWith('studio')) { if (event.detail.kind === 'studio-notes') warmAll(); return; }
    studioEngine.setStudio(studio);
    view.setStudio(studio);
    warmAll();
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
