// Canonical, side-effect-free Studio score walker. Logical score time starts at
// zero: WebAudio scheduling headroom belongs to renderers, never to the music.

import { chordNotes, studioStepDuration, studioStepSeconds } from './model.js';

function clampMidi(value) {
  return Math.max(0, Math.min(127, Math.round(Number(value) || 0)));
}

export function compileStudioScore(studio, { trackIndex = null } = {}) {
  if (!studio || !Array.isArray(studio.tracks)) return [];
  const bars = Math.max(1, Math.min(4, Math.round(Number(studio.bars) || 1)));
  const totalSteps = bars * 16;
  const starts = new Array(totalSteps + 1).fill(0);
  for (let step = 0; step < totalSteps; step++) {
    starts[step + 1] = starts[step] + studioStepDuration(studio.bpm, studio.swing, step);
  }

  const anySolo = studio.tracks.some((track) => track && track.solo);
  const firstTrack = Number.isInteger(trackIndex) ? trackIndex : 0;
  const lastTrack = Number.isInteger(trackIndex) ? trackIndex + 1 : studio.tracks.length;
  const straight = studioStepSeconds(studio.bpm);
  const events = [];

  for (let stepIndex = 0; stepIndex < totalSteps; stepIndex++) {
    for (let index = firstTrack; index < lastTrack; index++) {
      const track = studio.tracks[index];
      const cell = track && Array.isArray(track.steps) ? track.steps[stepIndex] : null;
      if (!cell) continue;
      const transpose = track.synth && Number.isFinite(track.synth.transpose)
        ? track.synth.transpose : 0;
      const heardNotes = chordNotes(cell.note, cell.chord)
        .map((note) => clampMidi(note + transpose));
      events.push({
        eventRef: { surface: 'studio', trackId: track.id || ('instrument-' + (index + 1)), stepIndex },
        trackIndex: index,
        stepIndex,
        startSec: starts[stepIndex],
        durationSec: Math.max(0.01, Number(cell.gate || 0.9) * straight),
        rootNote: clampMidi(cell.note),
        chord: cell.chord || 'single',
        heardNotes,
        velocity: Math.max(0.05, Math.min(1, Number(cell.velocity) || 0.82)),
        gate: Math.max(0.05, Number(cell.gate) || 0.9),
        audible: !track.mute && (!anySolo || track.solo),
      });
    }
  }
  return events;
}
