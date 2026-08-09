// Pure adapter from one bar of raw Web MIDI notes to the gesture schema LOOM
// already compiles. Raw onset time is retained; fractional gridStep carries
// human timing onto Machine's one clock instead of flattening it to a piano roll.

import { stepTime } from '../machine/compile.js';
import { canonicalJson, sha256HexSync } from './identity.js';

function clamp(value, low, high, fallback = low) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(low, Math.min(high, number)) : fallback;
}

export function captureBarDuration(bpm = 120, swing = 50) {
  return stepTime(16, bpm, swing);
}

function fractionalGridStep(seconds, bpm, swing) {
  const time = Math.max(0, Number(seconds) || 0);
  for (let step = 0; step < 16; step++) {
    const start = stepTime(step, bpm, swing);
    const end = stepTime(step + 1, bpm, swing);
    if (time < end || step === 15) {
      return step + clamp((time - start) / Math.max(1e-9, end - start), 0, 0.999999, 0);
    }
  }
  return 15.999999;
}

export function capturedMidiGesture(rawNotes, {
  bpm = 120, swing = 50, label = 'MIDI INPUT', inputId = null,
  velocityDomain = 'midi',
} = {}) {
  if (velocityDomain !== 'midi' && velocityDomain !== 'normalized') {
    throw new RangeError('MIDI CAPTURE VELOCITY DOMAIN MUST BE midi OR normalized');
  }
  const safeBpm = clamp(bpm, 30, 300, 120);
  const safeSwing = clamp(swing, 50, 70, 50);
  const barSec = captureBarDuration(safeBpm, safeSwing);
  const notes = [];
  for (const item of Array.isArray(rawNotes) ? rawNotes : []) {
    if (!item || item.startSec == null) continue;
    const startSec = clamp(item.startSec, 0, barSec, 0);
    if (!(startSec < barSec)) continue;
    const endSec = clamp(item.endSec, startSec + 0.02, barSec,
      Math.min(barSec, startSec + 0.1));
    const gridStep = fractionalGridStep(startSec, safeBpm, safeSwing);
    const stepIndex = Math.max(0, Math.min(15, Math.round(gridStep)));
    const durationSec = Math.max(0.02, endSec - startSec);
    const straight = 60 / safeBpm / 4;
    const note = Math.round(clamp(item.note, 0, 127, 60));
    const channel = Math.round(clamp(item.channel, 0, 15, 0));
    notes.push({
      eventRef: {
        surface: 'wire-midi',
        inputId: inputId == null ? null : String(inputId),
        channel,
        note,
        captureIndex: notes.length,
      },
      trackIndex: channel,
      stepIndex,
      gridStep,
      startSec,
      rawStartSec: startSec,
      durationSec,
      nudge: gridStep - stepIndex,
      rootNote: note,
      writtenNote: note,
      chord: 'single',
      heardNotes: [note],
      // WIRE supplies MIDI 1.0 integers. A caller with already-normalized data
      // must say so explicitly; magnitude inference made raw velocity 1 become
      // full scale instead of 1/127.
      velocity: velocityDomain === 'midi'
        ? clamp(item.velocity, 0, 127, 101.6) / 127
        : clamp(item.velocity, 0, 1, 0.8),
      gate: clamp(durationSec / straight, 0.05, 16, 0.8),
      audible: true,
    });
  }
  notes.sort((a, b) => a.startSec - b.startSec
    || a.eventRef.channel - b.eventRef.channel || a.rootNote - b.rootNote);
  if (!notes.length) return null;
  for (let index = 0; index < notes.length; index++) notes[index].eventRef.captureIndex = index;
  const channels = Array.from(new Set(notes.map((event) => event.eventRef.channel)));
  const gesture = {
    kind: 'midi-capture',
    label: String(label || 'MIDI INPUT').toUpperCase().slice(0, 40),
    channel: channels.length === 1 ? channels[0] : 0,
    channels,
    inputId: inputId == null ? null : String(inputId),
    velocityDomain,
    bpm: safeBpm,
    swing: safeSwing,
    bars: 1,
    durationSec: barSec,
    timing: 'as-played',
    events: notes,
  };
  return {
    id: 'midi-capture-sha256-' + sha256HexSync(canonicalJson(gesture)),
    ...gesture,
  };
}
