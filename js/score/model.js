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

export const SCORE_FORMAT = 'yj-score-1';

// Keys sorted, so the fingerprint does not depend on the order a card's fields
// were written in; −0 and 0 read the same because they sound the same.
export const canonicalJson = (v) => Array.isArray(v) ? '[' + v.map(canonicalJson).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => k + ':' + canonicalJson(v[k])).join(',') + '}'
  : typeof v === 'number' ? (Object.is(v, -0) ? '0' : String(v)) : JSON.stringify(v ?? null);

/**
 * A card's sounding identity, 64 bits over exactly the fields js/instrument/
 * render.js feeds the voice: id, modes, damping, family, nonlinearity, retune.
 * `id` alone will not do — it is a sha256 of the source samples, and every
 * derivation keeps it: js/instrument/tuning.js applyRetune returns
 * `{ ...card, modes: <shifted>, retune }` under the same id, which measures
 * 5.4e-3 away from the original when rendered. So an id is wrong both as a file
 * reference and as a render-cache key; this is not. Computed every call: a
 * memo held in a WeakMap on the card object survives an in-place edit, which is
 * the same defect again with a step in front of it — fingerprint opz-thud,
 * double modes[0].freqHz on that object, and the memo still says
 * a79414c3928aff49 where a copy of the edited card says bcc751744540ed52. The
 * memo saved 15.6 ms over all 2,560 notes of the four movements, a third of one
 * 43 ms render out of the several hundred a movement makes, so it bought
 * nothing worth a stale sounding identity.
 */
export function cardFingerprint(card) {
  const s = canonicalJson({ id: card.id, modes: card.modes, damping: card.damping ?? null, family: card.family ?? null, nonlinearity: card.nonlinearity ?? null, retune: card.retune ?? null });
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x85ebca6b); }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

// The ten cards STUDIO offers by name (js/studio/found-cards.js), keyed by the
// card's sounding fingerprint, not its id: a retuned or remeasured card keeps
// the id but not the fingerprint, so it stops matching and is embedded whole
// rather than referenced back at the wrong pitch. Card ids in comments.
const FOUND_CARD_REFS = Object.freeze({
  '8035b30c1b8f1b5e': 'carillon-bell', // 68cb6f980f4fe191
  'c628a0715e766c57': 'iowa-bells-plastic-ff-Cs5', // 61c949dc0534bff6
  '2be404e60f9860ec': 'freesound-wineglass', // c6fcfc48639dfdaa
  '50eba74c70dadd62': 'commons-bell-15cm', // 3bcaceb2963b752c
  'a79414c3928aff49': 'opz-thud', // 8a403ddece96ee3e
  '48ca2b478fe8f95d': 'fdr-vowel', // 68686cb29006b304
  'dda08d8df591ef6f': 'hiawatha-vowel', // f23958170a27f52f
  'b1331c7d9239156b': 'uvb76-buzz', // 99d4162d5261a589
  '13328a370cfdf641': 'ory-chord', // 8600cdea41a5fdfb
  '0633bcd09119b3ba': 'wwv-tone', // f2659b9490d7d661
});

const round = (x, places) => { const f = Math.pow(10, places); return Math.round(x * f) / f; };
const roundDeep = (v, places) => Array.isArray(v) ? v.map((e) => roundDeep(e, places))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, e]) => [k, roundDeep(e, places)]))
  : typeof v === 'number' && Number.isFinite(v) ? round(v, places) : v;
// Measured data is carried verbatim, but copied: the returned object is a file,
// and editing the score afterwards must not edit the file that was written.
const copyDeep = (v) => Array.isArray(v) ? v.map(copyDeep)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, e]) => [k, copyDeep(e)]))
  : v;

/**
 * A score → a plain object safe to JSON.stringify: hertz and seconds, so a
 * piece survives leaving JavaScript without being rounded to semitones. A
 * part's card is embedded whole (measured data, carried verbatim, but copied —
 * nothing here aliases the live score) unless it is one of the found cards
 * *unaltered*, which becomes { ref: name }. Times keep 6 decimals (a
 * microsecond), pitches 3 (a millihertz), everything else 4.
 */
export function scoreToJson(score) {
  const json = {
    format: SCORE_FORMAT,
    title: score.title,
    sampleRate: score.sampleRate,
    parts: score.parts.map((p) => ({
      id: p.id,
      excitation: p.excitation,
      pan: round(p.pan || 0, 4),
      rmsDb: p.rmsDb == null ? null : round(p.rmsDb, 4),
      gainDb: round(p.gainDb || 0, 4),
      params: roundDeep(p.params || {}, 4),
      card: FOUND_CARD_REFS[cardFingerprint(p.card)] ? { ref: FOUND_CARD_REFS[cardFingerprint(p.card)] } : copyDeep(p.card),
      notes: p.notes.map((n) => ({ t: round(n.t, 6), hz: round(n.hz, 3), velocity: round(n.velocity, 4), seconds: round(n.seconds, 6) })),
    })),
  };
  if (score.markers && score.markers.length) json.markers = score.markers.map((m) => ({ t: round(m.t, 6), label: m.label }));
  return json;
}

const show = (v) => typeof v === 'number' ? String(v) : JSON.stringify(v) ?? String(v);

/**
 * One rule for every number in a score file: a field the file leaves out may
 * take the model's default, but a field the file *carries* must be a finite
 * number. JSON.parse never produces `undefined`, so absent and present are
 * distinguishable — and `null`, NaN, ±Infinity and '400' are corruption, not
 * defaults. Silently reading `velocity: null` as 0.05 (near-silent) or a
 * missing `seconds` as 0.5 is the loss this format exists to prevent.
 */
function number(v, where, { nullOk = false, required = false } = {}) {
  if (v === undefined) { if (required) throw new Error(`${where} is missing`); return undefined; }
  if (nullOk && v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${where} is ${show(v)}, not a number`);
  return v;
}

/**
 * The inverse: a parsed score file → a score renderScore plays. `cards` is a
 * name → card map that resolves `{ ref }` parts. Anything structurally missing
 * throws by name; nothing structural is silently defaulted, and a structural
 * value that is present but unusable throws naming the part and note index
 * rather than being replaced.
 */
// A part's params reach the physics untouched, so a string or a null in one is a
// number the renderer will read as garbage. The rule the rest of this file
// states — a field the file carries must be usable — has to hold in here too.
function checkedParams(params, id) {
  if (params === undefined) return {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error(`part ${id} params is ${show(params)}, not an object`);
  }
  const walk = (node, path) => {
    for (const [key, value] of Object.entries(node)) {
      const where = path ? `${path}.${key}` : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) { walk(value, where); continue; }
      // A genuine string param (a mode name) is fine; a number written as a
      // string is a number that lost its type on the way through some other
      // tool, and the physics would read it as garbage.
      if (typeof value === 'string') {
        if (value.trim() !== '' && Number.isFinite(Number(value))) {
          throw new Error(`part ${id} params.${where} is ${show(value)}, a number written as a string`);
        }
        continue;
      }
      if (typeof value === 'boolean') continue;
      if (!Number.isFinite(value)) throw new Error(`part ${id} params.${where} is ${show(value)}, not a number`);
    }
  };
  walk(params, '');
  return params;
}

export function scoreFromJson(json, { cards = null } = {}) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('a score file must be a JSON object');
  if (json.format !== SCORE_FORMAT) throw new Error(`not a ${SCORE_FORMAT} file: format is ${JSON.stringify(json.format)}`);
  if (!Array.isArray(json.parts)) throw new Error('a score file needs a parts array');
  // renderScore reads `score.sampleRate || 48000`, so a file carrying null or
  // '48k' resampled to 48 k without saying so — the same silent substitution
  // the per-note rule exists to refuse, one level up.
  const sampleRate = number(json.sampleRate, 'sampleRate');
  if (sampleRate !== undefined && !(sampleRate > 0)) throw new Error(`sampleRate is ${sampleRate}, not a rate`);
  const score = createScore({ title: json.title, sampleRate });
  json.parts.forEach((p, i) => {
    if (!p || typeof p !== 'object') throw new Error('part ' + (i + 1) + ' is not an object');
    const id = p.id != null ? p.id : 'part ' + (i + 1);
    const ref = p.card && p.card.ref;
    const card = ref ? cards && cards[ref] : p.card;
    if (ref && !card) throw new Error(`part ${id} refers to card ${ref}, which was not in \`cards\``);
    if (!card || !Array.isArray(card.modes)) throw new Error(`part ${id} has no card`);
    // addPart clamps pan and falls back to 'strike'; both are silent repairs, so
    // the file's own values are checked here before it gets to.
    if (p.excitation !== undefined && !CARD_EXCITATIONS.includes(p.excitation)) throw new Error(`part ${id} speaks ${show(p.excitation)}, which is not one of ${CARD_EXCITATIONS.join(', ')}`);
    const pan = number(p.pan, `part ${id} pan`);
    if (pan !== undefined && (pan < -1 || pan > 1)) throw new Error(`part ${id} pan is ${pan}, outside −1..1`);
    const part = addPart(score, {
      id: p.id, card, excitation: p.excitation, pan,
      rmsDb: number(p.rmsDb, `part ${id} rmsDb`, { nullOk: true }),
      gainDb: number(p.gainDb, `part ${id} gainDb`), params: checkedParams(p.params, id),
    });
    if (p.notes !== undefined && !Array.isArray(p.notes)) throw new Error(`part ${id} notes is ${show(p.notes)}, not an array`);
    (p.notes || []).forEach((n, k) => {
      const at = `part ${id} note ${k + 1}`;
      if (!n || typeof n !== 'object') throw new Error(at + ' is not an object');
      const hz = number(n.hz, at + ' hz');
      // A note is a time, a pitch and a length; only its dynamic has a default.
      if (!(hz > 0)) throw new Error(`${at} has no hz`);
      const t = number(n.t, at + ' t', { required: true });
      if (t < 0) throw new Error(`${at} t is ${t}, before the piece starts`);
      const seconds = number(n.seconds, at + ' seconds', { required: true });
      if (!(seconds > 0)) throw new Error(`${at} seconds is ${seconds}, not a length`);
      // addNote clamps velocity to 0.05..1, which would quietly rewrite a file
      // that carries something else, the same way addPart clamps pan.
      const velocity = number(n.velocity, at + ' velocity');
      if (velocity !== undefined && (velocity < 0.05 || velocity > 1)) throw new Error(`${at} velocity is ${velocity}, outside 0.05..1`);
      addNote(part, { t, hz, velocity, seconds });
    });
  });
  // A markers field that is present but not an array used to vanish without a
  // word — the same silent substitution every other field here refuses.
  if (json.markers !== undefined) {
    if (!Array.isArray(json.markers)) throw new Error(`markers is ${show(json.markers)}, not an array`);
    json.markers.forEach((m, i) => addMarker(score, number(m && m.t, `marker ${i + 1} t`, { required: true }), m.label));
  }
  return score;
}
