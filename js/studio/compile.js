// Canonical, side-effect-free Studio score walker. Logical score time starts at
// zero: WebAudio scheduling headroom belongs to renderers, never to the music.

import { chordNotes, stepCents, stepPitch, studioStepDuration, studioStepSeconds } from './model.js';

function clampMidi(value) {
  return Math.max(0, Math.min(127, Math.round(Number(value) || 0)));
}

// A sounding pitch is a fractional semitone; it is bounded like a note but never
// rounded, or the cents it carries would round away with it.
function clampPitch(value) {
  const n = Number(value);
  return Math.max(0, Math.min(127, Number.isFinite(n) ? n : 0));
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
      // Two readings of one step, both required: the columns it is written in,
      // which every MIDI and OP-Z target downstream needs as integers, and the
      // pitches it sounds, which carry the step's cents. Neither is derived from
      // the other — rounding a sounding pitch would move a step at +60 cents
      // into the next column.
      const heardNotes = chordNotes(cell.note, cell.chord)
        .map((note) => clampMidi(note + transpose));
      const heardPitches = chordNotes(stepPitch(cell), cell.chord)
        .map((note) => clampPitch(note + transpose));
      events.push({
        eventRef: { surface: 'studio', trackId: track.id || ('instrument-' + (index + 1)), stepIndex },
        trackIndex: index,
        stepIndex,
        startSec: starts[stepIndex],
        durationSec: Math.max(0.01, Number(cell.gate || 0.9) * straight),
        rootNote: clampMidi(cell.note),
        rootPitch: clampPitch(stepPitch(cell)),
        cents: stepCents(cell),
        chord: cell.chord || 'single',
        heardNotes,
        heardPitches,
        velocity: Math.max(0.05, Math.min(1, Number(cell.velocity) || 0.82)),
        gate: Math.max(0.05, Number(cell.gate) || 0.9),
        audible: !track.mute && (!anySolo || track.solo),
      });
    }
  }
  return events;
}
