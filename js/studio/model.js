// Yellowjacket Studio document model. This is deliberately WebAudio-free so
// projects, undo, imports, and the test harness all agree on the same shape.

export const STUDIO_STEPS_PER_BAR = 16;
export const STUDIO_MAX_BARS = 4;
export const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const CARD_EXCITATIONS = Object.freeze(['strike', 'pluck', 'bow', 'breath']);
// A step's cents is a departure from its own note, so an octave is the widest
// one that still leaves `note` the pitch it is written at; more than that
// belongs in the note.
export const STEP_CENTS_LIMIT = 1200;
export const STUDIO_SCALES = {
  minor: { name: 'MINOR', intervals: [0, 2, 3, 5, 7, 8, 10] },
  major: { name: 'MAJOR', intervals: [0, 2, 4, 5, 7, 9, 11] },
  dorian: { name: 'DORIAN', intervals: [0, 2, 3, 5, 7, 9, 10] },
  pentatonic: { name: 'PENTATONIC', intervals: [0, 3, 5, 7, 10] },
};

/** The scale in force: a named one, or the studio's own `customScale` (an object's consonances, in exact semitones) under the id 'custom'. */
export function scaleSpec(studio) {
  if (studio && studio.scale === 'custom' && studio.customScale && Array.isArray(studio.customScale.intervals) && studio.customScale.intervals.length) return studio.customScale;
  return STUDIO_SCALES[studio && studio.scale] || STUDIO_SCALES.minor;
}

// Two degrees this close are one degree measured twice. The dissonance curve is
// sampled 600 times over a 2.05 ratio (instrument/tuning.js), so its minima sit
// on a 2.07-cent grid and two samples on one valley floor read as two minima;
// 5 cents is above that grid, at the pitch JND for successive tones, and an
// order of magnitude under the 54 cents between the Iowa brass bell's two
// degrees inside semitone 8, which the exact scale exists to keep apart.
export const SCALE_DEGREE_CENTS = 5;

/** Semitone intervals with 0 first, sorted, and degrees within SCALE_DEGREE_CENTS folded onto the lowest — kept at its measured value, never rounded. */
export function dedupeScaleIntervals(intervals) {
  const admitted = [0];
  for (const v of intervals || []) { const n = Number(v); if (Number.isFinite(n) && n > 0) admitted.push(n); }
  admitted.sort((a, b) => a - b);
  const out = [];
  for (const n of admitted) if (!out.length || (n - out[out.length - 1]) * 100 >= SCALE_DEGREE_CENTS) out.push(n);
  return out;
}

/** A measured scale for a status line: its degrees in whole cents, since raw semitone floats read as noise. */
export function scaleIntervalsLabel(intervals) {
  if (!Array.isArray(intervals) || !intervals.length) return '';
  return intervals.map((v) => Math.round(Number(v) * 100)).join(' ') + ' CENTS';
}

/**
 * Set a custom scale from semitone intervals (0 always included, sorted,
 * deduped). An interval is admitted by the semitone it lands nearest but kept
 * exactly as measured: the Iowa brass bell's 7.58 and 8.12 are one semitone
 * apart on the roll and 54 cents apart in the air, and rounding lost one of them.
 */
export function applyCustomScale(studio, intervals, name = 'CARD') {
  const admitted = [];
  for (const v of intervals || []) { const n = Number(v), column = Math.round(n); if (Number.isFinite(n) && column > 0 && column < 12) admitted.push(n); }
  studio.customScale = { name: scaleName(name), intervals: dedupeScaleIntervals(admitted) };
  studio.scale = 'custom';
  return studio;
}

function scaleName(name) { return String(name || 'CARD').toUpperCase().slice(0, 12); }

/**
 * A saved custom scale, restored as saved. Loading still validates — a project
 * file is untrusted input, so a degree must be a finite number inside ten
 * octaves, and the list comes back sorted with the root first — but it does not
 * re-run the card intake of `applyCustomScale`. That intake makes two decisions
 * about a fresh measurement, both wrong to make twice: it drops any degree
 * outside 0 < round(semitones) < 12, and it folds degrees within
 * SCALE_DEGREE_CENTS onto the lower one. Measured against the scales this
 * version writes, restoring through the intake changes none of them (all 15
 * cards in docs/lab/cards/ survive it bit for bit, as do the integer scales
 * every released version wrote); it silently deletes a degree only in a saved
 * file the intake would now reject — [0, 0.4, 7] loses the 40-cent degree,
 * [0, 7, 11.6] loses the 1160-cent one. A scale already inside a project is the
 * person's, not a measurement waiting to be re-admitted.
 */
export function restoreCustomScale(studio, saved) {
  const kept = [0];
  for (const v of (saved && saved.intervals) || []) { const n = Number(v); if (Number.isFinite(n) && n > 0 && n < 120) kept.push(n); }
  kept.sort((a, b) => a - b);
  studio.customScale = { name: scaleName(saved && saved.name), intervals: kept.filter((n, i) => i === 0 || n !== kept[i - 1]) };
  return studio;
}

export const INSTRUMENT_PRESETS = [
  { id: 'sub', name: 'SUB', wave1: 'sine', wave2: 'triangle', mix: 0.18, detune: -7, transpose: -12, cutoff: 520, resonance: 1.2, attack: 0.008, decay: 0.18, sustain: 0.82, release: 0.22 },
  { id: 'bass', name: 'BASS', wave1: 'sawtooth', wave2: 'square', mix: 0.22, detune: 5, transpose: -12, cutoff: 1250, resonance: 3.2, attack: 0.006, decay: 0.24, sustain: 0.54, release: 0.16 },
  { id: 'keys', name: 'KEYS', wave1: 'triangle', wave2: 'sine', mix: 0.38, detune: 7, transpose: 0, cutoff: 5200, resonance: 0.8, attack: 0.012, decay: 0.34, sustain: 0.55, release: 0.48 },
  { id: 'pluck', name: 'PLUCK', wave1: 'sawtooth', wave2: 'triangle', mix: 0.3, detune: 12, transpose: 0, cutoff: 3600, resonance: 4.5, attack: 0.003, decay: 0.13, sustain: 0.08, release: 0.2 },
  { id: 'pad', name: 'PAD', wave1: 'sawtooth', wave2: 'sawtooth', mix: 0.5, detune: 16, transpose: 0, cutoff: 2400, resonance: 1.4, attack: 0.48, decay: 0.7, sustain: 0.72, release: 1.8 },
  { id: 'lead', name: 'LEAD', wave1: 'square', wave2: 'sawtooth', mix: 0.28, detune: 8, transpose: 12, cutoff: 6800, resonance: 2.3, attack: 0.018, decay: 0.2, sustain: 0.7, release: 0.35 },
  { id: 'organ', name: 'ORGAN', wave1: 'square', wave2: 'sine', mix: 0.42, detune: 0, transpose: 0, cutoff: 9200, resonance: 0.6, attack: 0.025, decay: 0.05, sustain: 0.92, release: 0.28 },
  { id: 'glass', name: 'GLASS', wave1: 'sine', wave2: 'triangle', mix: 0.46, detune: 1200, transpose: 12, cutoff: 12000, resonance: 1.8, attack: 0.005, decay: 0.8, sustain: 0.2, release: 1.4 },
];

const STARTERS = ['bass', 'keys', 'pad', 'lead', 'pluck', 'sub'];
const CHORD_INTERVALS = {
  single: [0], fifth: [0, 7], minor: [0, 3, 7], major: [0, 4, 7], seventh: [0, 4, 7, 10],
};
const WAVES = new Set(['sine', 'triangle', 'sawtooth', 'square']);
const LABEL_CENTS = 2; // within a couple of cents of the grid the roll just reads the note

function clamp(v, lo, hi, fallback = lo) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value |= 0; value = value + 0x6D2B79F5 | 0;
    let out = Math.imul(value ^ value >>> 15, 1 | value);
    out = out + Math.imul(out ^ out >>> 7, 61 | out) ^ out;
    return ((out ^ out >>> 14) >>> 0) / 4294967296;
  };
}

export function presetById(id) {
  return INSTRUMENT_PRESETS.find((preset) => preset.id === id) || INSTRUMENT_PRESETS[0];
}

export function synthFromPreset(id) {
  const preset = presetById(id);
  return {
    wave1: preset.wave1, wave2: preset.wave2, mix: preset.mix, detune: preset.detune,
    transpose: preset.transpose, cutoff: preset.cutoff, resonance: preset.resonance,
    attack: preset.attack, decay: preset.decay, sustain: preset.sustain, release: preset.release,
  };
}

export function createStudioTrack(index = 0) {
  const preset = presetById(STARTERS[index % STARTERS.length]);
  return {
    id: 'instrument-' + (index + 1), name: preset.name, preset: preset.id,
    gainDb: index === 2 ? -10 : -7, pan: index % 2 ? 0.12 : -0.12,
    mute: false, solo: false, sendVerb: index === 2 ? 0.42 : 0.14,
    sendDelay: index === 3 ? 0.28 : 0.08, length: 64,
    synth: synthFromPreset(preset.id),
    // A found-instrument card, when this part plays one: { card, excitation }.
    // The synth block stays (transpose still applies) and comes back when a
    // preset is chosen again.
    card: null,
    steps: Array.from({ length: STUDIO_STEPS_PER_BAR * STUDIO_MAX_BARS }, () => null),
  };
}

export function createStudio() {
  return {
    touched: false, bpm: 120, swing: 50, bars: 1, masterDb: -3,
    metronome: false, keyRoot: 0, scale: 'minor', customScale: null, ideaSeed: 0x594a0001,
    tracks: Array.from({ length: 6 }, (_, i) => createStudioTrack(i)),
  };
}

export function applyInstrumentPreset(track, id) {
  const preset = presetById(id);
  track.preset = preset.id;
  track.name = preset.name;
  track.card = null;
  Object.assign(track.synth, synthFromPreset(preset.id));
  return track;
}

/** A part name from a card: the source's name without its extension, upper-cased, sixteen characters. */
export function cardInstrumentName(card) {
  const raw = String((card && card.source && card.source.name) || 'CARD').split('/').pop().replace(/\.[a-z0-9]{2,5}$/i, '');
  return (raw.replace(/[_-]+/g, ' ').trim().toUpperCase() || 'CARD').slice(0, 16);
}

/** Put a card on a part: it plays by the engine's physics under `excitation` until a preset replaces it. */
export function applyCardInstrument(track, card, excitation = 'strike', name = null) {
  if (!card || !Array.isArray(card.modes)) throw new Error('not a card');
  track.card = { card, excitation: CARD_EXCITATIONS.includes(excitation) ? excitation : 'strike' };
  track.preset = 'card';
  track.name = String(name || cardInstrumentName(card)).toUpperCase().slice(0, 16);
  return track;
}

export function chordNotes(root, chord = 'single') {
  // the root is a pitch, not a key index: a step off the twelve-tone grid
  // arrives fractional and its chord moves with it
  const note = clamp(root, 0, 127, 60);
  const intervals = CHORD_INTERVALS[chord] || CHORD_INTERVALS.single;
  return intervals.map((interval) => Math.min(127, note + interval));
}

export function noteName(midi) {
  const note = Math.round(clamp(midi, 0, 127, 60));
  return KEY_NAMES[note % 12] + (Math.floor(note / 12) - 1);
}

function specOf(scale) {
  return scale && typeof scale === 'object' ? scale : (STUDIO_SCALES[scale] || STUDIO_SCALES.minor);
}

function degreeIndex(spec, rawDegree) {
  const count = spec.intervals.length;
  return ((rawDegree % count) + count) % count;
}

/** The key column a degree lands in: its nearest semitone, so the roll stays twelve columns wide. */
export function scaleNote(keyRoot, scale, degree, octave = 4) {
  const spec = specOf(scale);
  const rawDegree = Math.round(Number(degree) || 0);
  const octaves = Math.floor(rawDegree / spec.intervals.length);
  const root = (Math.round(clamp(keyRoot, 0, 11, 0)) + 12 * (octave + 1));
  return Math.min(127, Math.max(0, root + Math.round(spec.intervals[degreeIndex(spec, rawDegree)]) + octaves * 12));
}

/** What that column owes the degree, in cents. Zero for the named scales; a measured scale is not twelve-tone. */
export function scaleCents(scale, degree) {
  const spec = specOf(scale);
  const interval = spec.intervals[degreeIndex(spec, Math.round(Number(degree) || 0))];
  return (interval - Math.round(interval)) * 100;
}

// The column for the roll, the cents for the air.
function degreeEvent(studio, scale, degree, octave, chord, velocity, gate) {
  return normalizeStep({ note: scaleNote(studio.keyRoot, scale, degree, octave), chord, velocity, gate, cents: scaleCents(scale, degree) });
}

// A useful starting arrangement, not a slot machine. The seed changes rhythm
// and melody while harmony stays inside the selected key and scale.
export function generateStudioIdea(studio, seed = null) {
  if (!studio || !Array.isArray(studio.tracks)) return studio;
  const nextSeed = seed == null ? ((studio.ideaSeed || 0) + 0x9e3779b9) >>> 0 : seed >>> 0;
  studio.ideaSeed = nextSeed;
  studio.bars = Math.max(2, Math.min(STUDIO_MAX_BARS, studio.bars || 2));
  const random = mulberry32(nextSeed);
  const scale = scaleSpec(studio);
  const scaleId = STUDIO_SCALES[studio.scale] ? studio.scale : (studio.scale === 'custom' ? 'custom' : 'minor');
  // A custom scale is voiced by its own third: a major third and no minor one
  // makes major triads, a minor third makes minor ones, neither makes fifths.
  const columns = scale.intervals.map((v) => Math.round(v));
  const custom = scaleId === 'custom' ? (columns.includes(4) && !columns.includes(3) ? 'major' : columns.includes(3) ? 'minor' : 'fifth') : null;
  const chord = scaleId === 'major' ? 'major' : scaleId === 'pentatonic' ? 'fifth' : scaleId === 'custom' ? custom : 'minor';
  const progression = chord === 'major' ? [0, 4, 5, 3] : [0, 5, 3, 4];
  for (const track of studio.tracks) track.steps.fill(null);

  const total = studio.bars * STUDIO_STEPS_PER_BAR;
  for (let bar = 0; bar < studio.bars; bar++) {
    const degree = progression[bar % progression.length];
    const at = bar * 16;
    studio.tracks[0].steps[at] = degreeEvent(studio, scale, degree, 2, 'single', 0.94, 1.8);
    studio.tracks[0].steps[at + 6] = degreeEvent(studio, scale, degree + 4, 2, 'single', 0.72, 0.8);
    studio.tracks[0].steps[at + 8] = degreeEvent(studio, scale, degree, 2, 'single', 0.86, 1.4);
    studio.tracks[0].steps[at + 11] = degreeEvent(studio, scale, degree + (random() > 0.5 ? 2 : 1), 2, 'single', 0.68, 0.7);
    studio.tracks[1].steps[at] = degreeEvent(studio, scale, degree, 3, chord, 0.68, 3.6);
    studio.tracks[1].steps[at + 8] = degreeEvent(studio, scale, degree, 3, chord, 0.58, 3.2);
    studio.tracks[2].steps[at] = degreeEvent(studio, scale, degree, 4, chord, 0.44, 12);
    studio.tracks[5].steps[at] = degreeEvent(studio, scale, degree, 1, 'single', 0.72, 7.5);
  }
  for (let step = 2; step < total; step += 4) {
    const bar = Math.floor(step / 16);
    const degree = progression[bar % progression.length] + (random() > 0.52 ? 2 : 4);
    studio.tracks[4].steps[step] = degreeEvent(studio, scale, degree, 4, 'single', 0.48 + random() * 0.22, 0.55);
  }
  for (let step = 0; step < total; step += 2) {
    if (random() < 0.34) continue;
    const bar = Math.floor(step / 16);
    const base = progression[bar % progression.length];
    const degree = base + Math.floor(random() * 7);
    studio.tracks[3].steps[step] = degreeEvent(studio, scale, degree, 4, 'single', 0.5 + random() * 0.35, random() > 0.8 ? 1.8 : 0.75);
  }
  studio.touched = true;
  return studio;
}

export function transformStudioBar(track, page, operation) {
  if (!track || !Array.isArray(track.steps)) return false;
  const start = Math.max(0, Math.min(STUDIO_MAX_BARS - 1, page | 0)) * 16;
  const bar = track.steps.slice(start, start + 16);
  if (operation === 'left') bar.push(bar.shift());
  else if (operation === 'right') bar.unshift(bar.pop());
  else if (operation === 'invert') {
    const notes = bar.filter(Boolean).map((item) => item.note);
    if (!notes.length) return false;
    const pivot = Math.min(...notes) + Math.max(...notes);
    for (const item of bar) if (item) item.note = Math.max(0, Math.min(127, pivot - item.note));
  } else if (operation === 'duplicate') {
    const target = start + 16;
    if (target >= track.steps.length) return false;
    for (let i = 0; i < 16; i++) track.steps[target + i] = bar[i] ? { ...bar[i] } : null;
    return true;
  } else return false;
  for (let i = 0; i < 16; i++) track.steps[start + i] = bar[i];
  return true;
}

export function studioStepSeconds(bpm) {
  return 60 / clamp(bpm, 30, 300, 120) / 4;
}

export function studioStepDuration(bpm, swing, step) {
  const base = studioStepSeconds(bpm);
  const amount = ((clamp(swing, 50, 75, 50) - 50) / 25) * 0.45;
  return base * ((step & 1) ? (1 - amount) : (1 + amount));
}

export function studioHasContent(studio) {
  if (!studio || !Array.isArray(studio.tracks)) return false;
  return !!studio.touched || studio.tracks.some((track) => Array.isArray(track.steps) && track.steps.some(Boolean));
}

export function normalizeStep(value) {
  if (!value || typeof value !== 'object') return null;
  const chord = Object.prototype.hasOwnProperty.call(CHORD_INTERVALS, value.chord) ? value.chord : 'single';
  const cents = clampCents(value.cents);
  const step = {
    note: Math.round(clamp(value.note, 0, 127, 60)), chord,
    velocity: clamp(value.velocity, 0.05, 1, 0.82),
    gate: clamp(value.gate, 0.05, 16, 0.9),
  };
  // A twelve-tone step carries no cents key at all, so a project written before
  // this existed reloads as the same object and sounds the same sample.
  if (cents) step.cents = cents;
  return step;
}

/**
 * A cents value the model will act on. NaN and ±Infinity are not departures
 * that got too big — they are no measurement at all, so they drop to the grid
 * rather than clamping to ±STEP_CENTS_LIMIT, which would invent a semitone.
 */
export function clampCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(STEP_CENTS_LIMIT, Math.max(-STEP_CENTS_LIMIT, n));
}

/** A step's departure from its own note, in cents. */
export function stepCents(step) {
  return clampCents(step && step.cents);
}

/** What a step sounds, in semitones. Without cents it is the note itself — the same double, so the same frequency to the last bit. */
export function stepPitch(step) {
  const cents = stepCents(step);
  return cents ? step.note + cents / 100 : step.note;
}

/**
 * Is this step's departure too small for the roll to print? Then the roll calls
 * it the bare note, and everything else must call it that too — the label is the
 * only evidence the person has for what a step holds. Measured on the fifteen
 * cards in docs/lab/cards/: 4 of 69 scale degrees sound under a cent and a half
 * off the grid (hiawatha-vowel +1.24, ory-chord +0.08 and -0.50, Iowa plastic
 * C#5 -0.17), and LABEL_CENTS is itself under the ~5-cent pitch JND that
 * SCALE_DEGREE_CENTS is set by, so nothing audible hangs on the difference.
 */
export function stepIsOnGrid(step) {
  return Math.abs(Math.round(stepCents(step))) < LABEL_CENTS;
}

/** A step in the roll: its note, how far off the grid it sits, its chord. */
export function stepLabel(step) {
  if (!step) return '—';
  const cents = Math.round(stepCents(step));
  const departure = stepIsOnGrid(step) ? '' : ' ' + (cents > 0 ? '+' : '') + cents;
  return noteName(step.note) + departure + (step.chord === 'single' ? '' : ' ' + String(step.chord).toUpperCase());
}

function applyTrack(target, saved) {
  if (!saved || typeof saved !== 'object') return;
  if (typeof saved.name === 'string') target.name = saved.name.slice(0, 16);
  // A well-formed saved card wins over the preset label: a designer knob on a
  // card part used to relabel it 'custom' and lose the card on restore.
  const savedCard = saved.card && saved.card.card && Array.isArray(saved.card.card.modes) ? saved.card : null;
  if (savedCard) { target.preset = 'card'; target.card = { card: savedCard.card, excitation: CARD_EXCITATIONS.includes(savedCard.excitation) ? savedCard.excitation : 'strike' }; }
  else if (saved.preset === 'custom') { target.preset = 'custom'; target.card = null; }
  else if (typeof saved.preset === 'string') { target.preset = presetById(saved.preset).id; target.card = null; }
  target.gainDb = clamp(saved.gainDb, -48, 6, target.gainDb);
  target.pan = clamp(saved.pan, -1, 1, target.pan);
  target.sendVerb = clamp(saved.sendVerb, 0, 1, target.sendVerb);
  target.sendDelay = clamp(saved.sendDelay, 0, 1, target.sendDelay);
  if (typeof saved.mute === 'boolean') target.mute = saved.mute;
  if (typeof saved.solo === 'boolean') target.solo = saved.solo;
  target.length = Math.round(clamp(saved.length, 1, 64, target.length));
  const synth = saved.synth && typeof saved.synth === 'object' ? saved.synth : {};
  if (WAVES.has(synth.wave1)) target.synth.wave1 = synth.wave1;
  if (WAVES.has(synth.wave2)) target.synth.wave2 = synth.wave2;
  target.synth.mix = clamp(synth.mix, 0, 1, target.synth.mix);
  target.synth.detune = clamp(synth.detune, -2400, 2400, target.synth.detune);
  target.synth.transpose = Math.round(clamp(synth.transpose, -36, 36, target.synth.transpose));
  target.synth.cutoff = clamp(synth.cutoff, 40, 20000, target.synth.cutoff);
  target.synth.resonance = clamp(synth.resonance, 0.1, 20, target.synth.resonance);
  target.synth.attack = clamp(synth.attack, 0.001, 4, target.synth.attack);
  target.synth.decay = clamp(synth.decay, 0.005, 4, target.synth.decay);
  target.synth.sustain = clamp(synth.sustain, 0, 1, target.synth.sustain);
  target.synth.release = clamp(synth.release, 0.01, 8, target.synth.release);
  target.steps.fill(null);
  if (Array.isArray(saved.steps)) {
    for (let i = 0; i < Math.min(target.steps.length, saved.steps.length); i++) target.steps[i] = normalizeStep(saved.steps[i]);
  }
}

export function applyStudioSnapshot(target, saved) {
  if (!target || !saved || typeof saved !== 'object') return target;
  target.touched = saved.touched === true;
  target.bpm = Math.round(clamp(saved.bpm, 30, 300, target.bpm));
  target.swing = clamp(saved.swing, 50, 75, target.swing);
  target.bars = Math.round(clamp(saved.bars, 1, STUDIO_MAX_BARS, target.bars));
  target.masterDb = clamp(saved.masterDb, -24, 3, target.masterDb);
  target.metronome = saved.metronome === true;
  target.keyRoot = Math.round(clamp(saved.keyRoot, 0, 11, target.keyRoot));
  const custom = saved.customScale && Array.isArray(saved.customScale.intervals) ? saved.customScale : null;
  if (custom) restoreCustomScale(target, custom);
  else target.customScale = null;
  target.scale = typeof saved.scale === 'string' && (STUDIO_SCALES[saved.scale] || (saved.scale === 'custom' && custom)) ? saved.scale : (STUDIO_SCALES[target.scale] ? target.scale : 'minor');
  target.ideaSeed = Number.isFinite(saved.ideaSeed) ? saved.ideaSeed >>> 0 : target.ideaSeed;
  if (Array.isArray(saved.tracks)) {
    for (let i = 0; i < Math.min(target.tracks.length, saved.tracks.length); i++) applyTrack(target.tracks[i], saved.tracks[i]);
  }
  return target;
}
