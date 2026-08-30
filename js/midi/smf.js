// Standard MIDI File reader, per docs/AUDIT-RESOLUTION.md section 4.
//
// js/studio/midi.js has always WRITTEN .mid files; nothing could read one back.
// This is the other direction: bytes on disk become notes, and notes become
// STUDIO steps. Pure and synchronous so the node suite can hold it to account
// without a browser.

import {
  STUDIO_MAX_BARS, STUDIO_STEPS_PER_BAR, normalizeStep,
} from '../studio/model.js';

const STUDIO_TRACKS = 6;
const STUDIO_STEPS = STUDIO_STEPS_PER_BAR * STUDIO_MAX_BARS;
const DEFAULT_US_PER_QUARTER = 500000;   // 120 bpm

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input && input.buffer instanceof ArrayBuffer) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return new Uint8Array(0);
}

function tagAt(bytes, offset, text) {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function u32(bytes, at) {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function u16(bytes, at) {
  return (bytes[at] << 8) | bytes[at + 1];
}

// Variable-length quantity: 7 bits per byte, high bit continues.
function readVlq(bytes, at) {
  let value = 0;
  let offset = at;
  for (let i = 0; i < 4 && offset < bytes.length; i++) {
    const byte = bytes[offset++];
    value = (value << 7) | (byte & 0x7F);
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: offset };
}

function parseTrack(bytes, start, end) {
  const notes = [];
  const open = new Map();       // (channel<<8)|note -> {startTicks, velocity}
  let name = '';
  let tempo = null;
  let ticks = 0;
  let status = 0;               // running status
  let at = start;

  const close = (channel, note, endTicks) => {
    const key = (channel << 8) | note;
    const held = open.get(key);
    if (!held) return;
    open.delete(key);
    notes.push({
      note,
      channel,
      velocity: held.velocity,
      startTicks: held.startTicks,
      durationTicks: Math.max(1, endTicks - held.startTicks),
    });
  };

  while (at < end) {
    const delta = readVlq(bytes, at);
    ticks += delta.value;
    at = delta.next;
    if (at >= end) break;

    let byte = bytes[at];
    if (byte & 0x80) { status = byte; at++; } else if (!status) { break; }
    // else: running status — `byte` is already the first data byte.

    if (status === 0xFF) {
      const type = bytes[at++];
      const len = readVlq(bytes, at);
      const dataAt = len.next;
      if (type === 0x51 && len.value === 3 && tempo === null) {
        tempo = (bytes[dataAt] << 16) | (bytes[dataAt + 1] << 8) | bytes[dataAt + 2];
      } else if (type === 0x03 && !name) {
        for (let i = 0; i < len.value; i++) name += String.fromCharCode(bytes[dataAt + i]);
      }
      at = dataAt + len.value;
      if (type === 0x2F) break;
      continue;
    }

    if (status === 0xF0 || status === 0xF7) {
      const len = readVlq(bytes, at);
      at = len.next + len.value;          // declared length, so contents cannot derail us
      status = 0;
      continue;
    }

    const kind = status & 0xF0;
    const channel = status & 0x0F;
    if (kind === 0x90 || kind === 0x80) {
      const note = bytes[at++];
      const velocity = bytes[at++];
      // A note-on at velocity 0 is a note-off. This is the common encoding, and
      // reading it literally leaves every note open forever.
      if (kind === 0x90 && velocity > 0) {
        open.set((channel << 8) | note, { startTicks: ticks, velocity });
      } else {
        close(channel, note, ticks);
      }
    } else if (kind === 0xC0 || kind === 0xD0) {
      at += 1;
    } else {
      at += 2;
    }
  }

  // Anything still held when the track ends stops at the track's end.
  for (const [key, held] of open) {
    notes.push({
      note: key & 0xFF,
      channel: key >> 8,
      velocity: held.velocity,
      startTicks: held.startTicks,
      durationTicks: Math.max(1, ticks - held.startTicks),
    });
  }

  notes.sort((a, b) => a.startTicks - b.startTicks || a.note - b.note);
  return { name, notes, tempo };
}

/** Parse a Standard MIDI File into tracks of absolute-tick notes. */
export function parseSmf(input) {
  const bytes = asBytes(input);
  if (!tagAt(bytes, 0, 'MThd')) {
    throw new Error('Not a MIDI file — no MThd header.');
  }
  const headerLen = u32(bytes, 4);
  const format = u16(bytes, 8);
  const division = u16(bytes, 12);
  const tracks = [];
  let tempo = null;

  let at = 8 + headerLen;
  while (at + 8 <= bytes.length) {
    const len = u32(bytes, at + 4);
    if (tagAt(bytes, at, 'MTrk')) {
      const track = parseTrack(bytes, at + 8, Math.min(at + 8 + len, bytes.length));
      if (track.tempo && tempo === null) tempo = track.tempo;
      tracks.push({ name: track.name, notes: track.notes });
    }
    at += 8 + len;
  }

  const usPerQuarter = tempo || DEFAULT_US_PER_QUARTER;
  return {
    format,
    // SMPTE division (negative when read as int16) has no ticks-per-quarter;
    // fall back to a sane PPQ rather than dividing by a frame rate.
    division: division & 0x8000 ? 480 : division,
    bpm: 60000000 / usPerQuarter,
    usPerQuarter,
    tracks,
  };
}

/**
 * Fold a parsed file onto STUDIO's grid: six parts, four bars of sixteenths.
 * Reports how many notes did not fit rather than folding them back into the
 * window, because a note silently wrapped to bar one is worse than a note lost.
 */
export function smfToStudio(song) {
  const ticksPerSixteenth = Math.max(1, (song.division || 480) / 4);
  const source = song.tracks.filter((t) => t.notes.length > 0).slice(0, STUDIO_TRACKS);
  let dropped = 0;

  const tracks = source.map((track) => {
    const steps = Array.from({ length: STUDIO_STEPS }, () => null);
    for (const note of track.notes) {
      const index = Math.round(note.startTicks / ticksPerSixteenth);
      if (index < 0 || index >= STUDIO_STEPS) { dropped++; continue; }
      // One note per step: STUDIO's grid holds a root plus a chord shape, not a
      // polyphonic cluster. Keep the first arrival, which sorting made the
      // lowest note of a simultaneous group.
      if (steps[index]) continue;
      steps[index] = normalizeStep({
        note: note.note,
        chord: 'single',
        velocity: note.velocity / 127,
        gate: note.durationTicks / ticksPerSixteenth,
      });
    }
    return { name: track.name, steps };
  });

  for (const track of song.tracks.slice(STUDIO_TRACKS)) dropped += track.notes.length;

  return { bpm: song.bpm, tracks, dropped };
}
