// A score for found instruments: parts of notes in seconds and hertz, played by
// cards. This is the model a long piece is written in — the STUDIO's four bars
// and a MIDI file both convert into it — and the offline renderer reads it.
// Pitches are hertz so a part can play an object's own scale exactly; `midi`
// is a convenience that may be fractional. Pure.

import { CARD_EXCITATIONS } from '../studio/model.js';

export const SCORE_VERSION = 1;

export function hzOfMidi(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }
export function midiOfHz(hz) { return 69 + 12 * Math.log2(hz / 440); }
export function hzOfCents(rootHz, cents) { return rootHz * Math.pow(2, cents / 1200); }

/** A new, empty score. */
export function createScore({ title = 'untitled', sampleRate = 48000 } = {}) {
  return { version: SCORE_VERSION, title, sampleRate, parts: [], markers: [] };
}

/**
 * Add a part. `card` is a card object; `excitation` one the card speaks under;
 * `pan` −1..1; `rmsDb` the level its sounding samples are normalised to
 * (null = leave the physics' level). → the part
 */
export function addPart(score, { id, card, excitation = 'strike', pan = 0, rmsDb = -20, gainDb = 0, params = {} } = {}) {
  if (!card || !Array.isArray(card.modes)) throw new Error('a part needs a card');
  const part = { id: id || card.source && card.source.name || 'part' + (score.parts.length + 1), card, excitation: CARD_EXCITATIONS.includes(excitation) ? excitation : 'strike', pan: Math.max(-1, Math.min(1, pan)), rmsDb, gainDb, params, notes: [] };
  score.parts.push(part);
  return part;
}

/** Add a note to a part: time and duration in seconds, pitch in hertz (or `midi`), velocity 0..1. */
export function addNote(part, { t, hz = null, midi = null, velocity = 0.8, seconds = 0.5 } = {}) {
  const pitchHz = hz != null ? hz : hzOfMidi(midi != null ? midi : 60);
  if (!(t >= 0) || !(pitchHz > 0) || !(seconds > 0)) throw new Error('a note needs t ≥ 0, a pitch and a length');
  const note = { t, hz: pitchHz, velocity: Math.max(0.05, Math.min(1, velocity)), seconds };
  part.notes.push(note);
  return note;
}

export function addMarker(score, t, label) { score.markers.push({ t, label }); score.markers.sort((a, b) => a.t - b.t); }

/** Length in seconds: the last note-off plus the longest possible ring. */
export function scoreSeconds(score, { tail = 4 } = {}) {
  let end = 0;
  for (const p of score.parts) for (const n of p.notes) end = Math.max(end, n.t + n.seconds);
  return end + tail;
}

/** Counts and ranges, for a lab note. */
export function scoreStats(score) {
  const parts = score.parts.map((p) => {
    const hz = p.notes.map((n) => n.hz);
    return { id: p.id, excitation: p.excitation, notes: p.notes.length, lowHz: hz.length ? Math.min(...hz) : 0, highHz: hz.length ? Math.max(...hz) : 0, seconds: p.notes.reduce((s, n) => Math.max(s, n.t + n.seconds), 0) };
  });
  return { title: score.title, parts, notes: parts.reduce((s, p) => s + p.notes, 0), seconds: scoreSeconds(score, { tail: 0 }) };
}

/**
 * STUDIO's six parts against a parsed MIDI file, the way smfToStudio folds it:
 * the k-th track that carries notes plays on part k. Parts that carry a card
 * become card specs keyed by the track's index in `song.tracks`; synth parts
 * are reported in `skipped` (the offline renderer plays cards only).
 * → { cards, skipped: [{ track, part, name, notes }] }
 */
export function cardsForStudio(song, studioTracks, { rmsDb = -20 } = {}) {
  const cards = {}, skipped = [];
  let k = 0;
  (song.tracks || []).forEach((track, index) => {
    if (!track.notes || !track.notes.length) return;
    const part = studioTracks[k++];
    if (!part) return;
    if (part.card && part.card.card) cards[index] = { card: part.card.card, excitation: part.card.excitation, pan: part.pan || 0, rmsDb: rmsDb + (part.gainDb || 0) + 7 };
    else skipped.push({ track: index, part: k, name: part.name, notes: track.notes.length });
  });
  return { cards, skipped };
}

/**
 * A parsed Standard MIDI File (js/midi/smf.js parseSmf) becomes a score, one
 * part per MIDI track or channel that carries notes, each played by the card
 * assigned in `cards` ({ [trackIndexOrChannel]: { card, excitation, pan, rmsDb } }).
 * Note velocity 1–127 → 0.05..1. Tracks without an assignment are skipped and
 * reported in `skipped`.
 */
export function scoreFromSmf(song, cards, { title = 'midi', sampleRate = 48000 } = {}) {
  const score = createScore({ title, sampleRate });
  const skipped = [];
  const tracks = song.tracks || [];
  const division = song.division || 480, usPerQuarter = song.usPerQuarter || 500000;
  const secOf = (ticks) => ticks * usPerQuarter / (division * 1e6);
  tracks.forEach((track, index) => {
    const notes = (track.notes || []).filter((n) => n && n.durationTicks > 0);
    if (!notes.length) return;
    const channel = notes[0].channel;
    const spec = cards[index] ?? cards['ch' + channel] ?? cards['*'];
    if (!spec) { skipped.push({ track: index, name: track.name || '', channel, notes: notes.length }); return; }
    const part = addPart(score, { id: track.name || 'track ' + (index + 1), card: spec.card, excitation: spec.excitation, pan: spec.pan ?? 0, rmsDb: spec.rmsDb ?? -20 });
    for (const n of notes) addNote(part, { t: secOf(n.startTicks), midi: n.note, velocity: Math.max(0.05, Math.min(1, (n.velocity || 96) / 127)), seconds: secOf(n.durationTicks) });
  });
  return { score, skipped };
}
