// Standard MIDI File export for Studio. One format-0 track carries six MIDI
// channels, so the result opens cleanly in every DAW without external code.

import { chordNotes, studioStepDuration, studioStepSeconds } from './model.js';

const DIVISION = 480;
const STEP_TICKS = DIVISION / 4;
const PROGRAMS = [38, 4, 89, 81, 24, 39]; // bass, keys, pad, lead, pluck, synth bass

function u16(value) { return [(value >>> 8) & 255, value & 255]; }
function u32(value) { return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]; }
function ascii(value) { return Array.from(String(value), (char) => char.charCodeAt(0) & 127); }

export function variableLength(value) {
  let current = Math.max(0, Math.round(value)) & 0x0fffffff;
  let packed = current & 0x7f;
  const out = [];
  while ((current >>>= 7)) { packed <<= 8; packed |= (current & 0x7f) | 0x80; }
  for (;;) {
    out.push(packed & 255);
    if (packed & 0x80) packed >>>= 8;
    else break;
  }
  return out;
}

function event(tick, order, bytes) { return { tick: Math.max(0, Math.round(tick)), order, bytes }; }

export function studioMidiFile(studio) {
  const events = [];
  const bpm = Math.max(30, Math.min(300, Number(studio && studio.bpm) || 120));
  const tempo = Math.round(60000000 / bpm);
  const name = ascii('YellowJacket Studio');
  events.push(event(0, 0, [0xff, 0x03, name.length, ...name]));
  events.push(event(0, 1, [0xff, 0x51, 0x03, (tempo >>> 16) & 255, (tempo >>> 8) & 255, tempo & 255]));
  events.push(event(0, 2, [0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08]));

  const tracks = studio && Array.isArray(studio.tracks) ? studio.tracks : [];
  const totalSteps = Math.max(1, Math.min(64, (Number(studio && studio.bars) || 1) * 16));
  const starts = new Array(totalSteps + 1).fill(0);
  const straight = studioStepSeconds(bpm);
  for (let step = 0; step < totalSteps; step++) {
    starts[step + 1] = starts[step] + studioStepDuration(bpm, studio.swing, step) / straight * STEP_TICKS;
  }

  for (let channel = 0; channel < Math.min(16, tracks.length); channel++) {
    const track = tracks[channel];
    events.push(event(0, 10 + channel, [0xc0 | channel, PROGRAMS[channel % PROGRAMS.length]]));
    if (!track || track.mute) continue;
    const solo = tracks.some((item) => item && item.solo);
    if (solo && !track.solo) continue;
    for (let step = 0; step < totalSteps; step++) {
      const noteEvent = track.steps && track.steps[step];
      if (!noteEvent) continue;
      const start = starts[step];
      const duration = Math.max(1, noteEvent.gate * STEP_TICKS);
      const velocity = Math.max(1, Math.min(127, Math.round(noteEvent.velocity * 127)));
      const transpose = track.synth && Number.isFinite(track.synth.transpose) ? track.synth.transpose : 0;
      for (const rawNote of chordNotes(noteEvent.note, noteEvent.chord)) {
        const note = Math.max(0, Math.min(127, Math.round(rawNote + transpose)));
        events.push(event(start, 30, [0x90 | channel, note, velocity]));
        events.push(event(start + duration, 20, [0x80 | channel, note, 0]));
      }
    }
  }

  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const trackBytes = [];
  let lastTick = 0;
  for (const item of events) {
    trackBytes.push(...variableLength(item.tick - lastTick), ...item.bytes);
    lastTick = item.tick;
  }
  trackBytes.push(0, 0xff, 0x2f, 0);
  return new Uint8Array([
    ...ascii('MThd'), ...u32(6), ...u16(0), ...u16(1), ...u16(DIVISION),
    ...ascii('MTrk'), ...u32(trackBytes.length), ...trackBytes,
  ]);
}
