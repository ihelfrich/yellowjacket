// OP-Z project (.opz) decoder and Standard MIDI File export.
//
// The OP-Z has no display and no project export: a sketch leaves the device
// only as a stereo bounce. This reads the project file the device writes in
// content mode and turns it into notes, so a pattern can leave the device as
// editable MIDI. Read-only on a file already copied off the disk.
//
// Byte map: the Z-PO Project reverse engineering (lrk/z-po-project wiki) as
// re-verified field by field against fifteen real files in
// docs/lab/opz/cap-project-format.md — tempo inside 40–200 in 15/15, step
// count inside 1–16 in all 3,840 track chunks, velocity 100 in 3,625 of 3,657
// notes, the `age` byte zero in 211,200 of 211,200. Three facts here are not
// in the wiki and come from that measurement: the empty-note marker is
// `note == 0xFF` (not zero), micro-timing is stored at four times the
// documented range (±96, clustering on multiples of 8), and modern files
// carry a four-byte little-endian format-version trailer (value 7) after the
// 342,844-byte body.
//
// Every multi-byte field is little-endian: the file is a memory image from a
// Blackfin ADSP-BF703.

export const OPZ_MAGIC = 0x49;
export const OPZ_HEADER_BYTES = 572;
export const OPZ_PATTERN_BYTES = 21392;
export const OPZ_PATTERNS = 16;
export const OPZ_TRACKS = 16;
export const OPZ_STEPS = 16;
export const OPZ_NOTE_SLOTS = 55;
export const OPZ_BODY_BYTES = OPZ_HEADER_BYTES + OPZ_PATTERNS * OPZ_PATTERN_BYTES; // 342844
export const OPZ_TRACK_BYTES = 12;
export const OPZ_NOTE_BYTES = 8;
export const OPZ_STEP_BYTES = 54;
export const OPZ_EMPTY_NOTE = 0xff;

// Duration ticks. An empty slot is written as 2560 and real notes cluster on
// 2048/2304/2560/2816/3328 — a live-recorded sixteenth and its neighbours —
// so one step is 2560 ticks and a quarter note is four steps.
export const OPZ_TICKS_PER_STEP = 2560;
export const OPZ_TICKS_PER_QUARTER = 4 * OPZ_TICKS_PER_STEP;
// Micro-timing byte: ±96 spans the UI's −23…+24, i.e. half a step each way.
export const OPZ_MICRO_PER_STEP = 192;

export const OPZ_TRACK_NAMES = [
  'kick', 'snare', 'perc', 'sample',
  'bass', 'lead', 'arp', 'chord',
  'fx1', 'fx2', 'tape', 'master',
  'perform', 'module', 'lights', 'motion',
];

// Polyphony budget, written into the format: each step holds 55 note slots
// split across the tracks at fixed offsets (Z-PO and libopz agree byte for
// byte).
export const OPZ_NOTE_OFFSET = [0, 2, 4, 6, 8, 12, 16, 24, 28, 29, 30, 31, 35, 41, 47, 51];
export const OPZ_NOTE_COUNT = [2, 2, 2, 2, 4, 4, 8, 4, 1, 1, 1, 4, 6, 6, 4, 4];

// Factory config/midi.json: tracks 1–15 on MIDI channels 1–15, track 16 on 1.
export const OPZ_TRACK_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 0];

function bytesOf(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('parseOpz wants bytes');
}

/**
 * Decode a .opz project file.
 *
 * Returns the header (tempo, swing, mixer, metronome, saved chains), sixteen
 * patterns of sixteen tracks, and every real note with its step, MIDI note,
 * velocity, duration in ticks and micro-timing offset. `version` is the
 * trailer value (7 on every modern file) or null for a pre-trailer file.
 */
export function parseOpz(input) {
  const b = bytesOf(input);
  if (b.length < OPZ_BODY_BYTES) throw new Error(`not an OP-Z project: ${b.length} bytes, need ${OPZ_BODY_BYTES}`);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== OPZ_MAGIC) throw new Error(`not an OP-Z project: file id 0x${magic.toString(16)}`);

  const chains = [];
  for (let c = 0; c < OPZ_PATTERNS; c++) {
    const at = 4 + c * 32;
    const ids = [];
    for (let i = 0; i < 16; i++) {
      const id = b[at + i];
      if (id === 0xff || id > 15) break; // 0xFF pads; what follows is garbage
      ids.push(id);
    }
    chains.push(ids);
  }

  const patterns = [];
  let noteCount = 0;
  for (let p = 0; p < OPZ_PATTERNS; p++) {
    const base = OPZ_HEADER_BYTES + p * OPZ_PATTERN_BYTES;
    const notesAt = base + OPZ_TRACKS * OPZ_TRACK_BYTES;
    const tracks = [];
    for (let t = 0; t < OPZ_TRACKS; t++) {
      const tc = base + t * OPZ_TRACK_BYTES;
      const notes = [];
      for (let s = 0; s < OPZ_STEPS; s++) {
        for (let k = 0; k < OPZ_NOTE_COUNT[t]; k++) {
          const n = notesAt + (s * OPZ_NOTE_SLOTS + OPZ_NOTE_OFFSET[t] + k) * OPZ_NOTE_BYTES;
          const note = b[n + 4];
          if (note === OPZ_EMPTY_NOTE) continue;
          notes.push({
            step: s,
            note,
            velocity: b[n + 5],
            duration: view.getInt32(n, true),
            micro: view.getInt8(n + 6),
          });
        }
      }
      noteCount += notes.length;
      tracks.push({
        index: t,
        name: OPZ_TRACK_NAMES[t],
        plug: view.getUint32(tc, true),
        steps: b[tc + 4],
        stepLength: b[tc + 6],
        quantize: b[tc + 7],
        noteStyle: b[tc + 8],
        noteLength: b[tc + 9],
        notes,
      });
    }
    const tail = notesAt + OPZ_STEPS * OPZ_NOTE_SLOTS * OPZ_NOTE_BYTES + OPZ_STEPS * OPZ_TRACKS * OPZ_STEP_BYTES + 18 * OPZ_TRACKS;
    patterns.push({
      index: p,
      tracks,
      mutes: b.slice(tail, tail + 40),
      tapeSend: view.getUint16(tail + 40, true),
      masterSend: view.getUint16(tail + 42, true),
      muteGroup: b[tail + 44],
    });
  }

  return {
    version: b.length >= OPZ_BODY_BYTES + 4 ? view.getUint32(OPZ_BODY_BYTES, true) : null,
    tempo: b[520],
    swing: b[565],
    mixer: { drum: b[516], synth: b[517], punch: b[518], master: b[519] },
    metronome: { level: b[566], sound: b[567] },
    chains,
    patterns,
    noteCount,
  };
}

/** Ticks per pass of a track: its own step count times its step length. */
export function trackPeriodTicks(track) {
  return Math.max(1, track.steps) * Math.max(1, track.stepLength) * OPZ_TICKS_PER_STEP;
}

/**
 * Lay a pattern out in time. Each track loops at its own length (the OP-Z is
 * polymetric: a 12-step track against a 16-step one drifts a bar every four),
 * so the pattern is rendered for `bars` bars of sixteen sixteenths and every
 * track repeats as often as its period fits. Returns absolute-tick events
 * sorted by start.
 */
export function patternEvents(pattern, { bars = 1, tracks = null } = {}) {
  const span = bars * OPZ_STEPS * OPZ_TICKS_PER_STEP;
  const events = [];
  for (const track of pattern.tracks) {
    if (tracks && !tracks.includes(track.index)) continue;
    if (!track.notes.length) continue;
    const stepTicks = Math.max(1, track.stepLength) * OPZ_TICKS_PER_STEP;
    const period = trackPeriodTicks(track);
    for (let pass = 0; pass * period < span; pass++) {
      for (const n of track.notes) {
        if (n.step >= track.steps) continue; // beyond the track's length: not played
        const start = pass * period + n.step * stepTicks + Math.round((n.micro / OPZ_MICRO_PER_STEP) * stepTicks);
        if (start < 0 || start >= span) continue;
        events.push({
          track: track.index,
          channel: OPZ_TRACK_CHANNELS[track.index],
          note: n.note,
          velocity: n.velocity,
          startTicks: start,
          durationTicks: Math.max(1, n.duration),
        });
      }
    }
  }
  events.sort((a, b) => a.startTicks - b.startTicks || a.track - b.track || a.note - b.note);
  return events;
}

/**
 * A pattern's rhythm as a step grid, one string per used track — for reading
 * a project without a device. `x` is a hit, `.` a rest, `|` the track's end.
 */
export function patternGrid(pattern) {
  const lines = [];
  for (const track of pattern.tracks) {
    if (!track.notes.length) continue;
    const hits = new Set(track.notes.filter((n) => n.step < track.steps).map((n) => n.step));
    let row = '';
    for (let s = 0; s < OPZ_STEPS; s++) {
      if (s === track.steps) row += '|';
      row += s < track.steps ? (hits.has(s) ? 'x' : '.') : ' ';
    }
    lines.push(`${track.name.padEnd(7)} ${row}  ${track.notes.length} notes`);
  }
  return lines;
}

/** One-screen description of a decoded project. */
export function describeOpz(project, { label = 'project' } = {}) {
  const lines = [];
  lines.push(`${label}: ${project.tempo} bpm, swing ${project.swing}, format v${project.version ?? '6 (no trailer)'}, ${project.noteCount} notes`);
  lines.push(`mixer drum ${project.mixer.drum} synth ${project.mixer.synth} punch ${project.mixer.punch} master ${project.mixer.master}`);
  const chains = project.chains.map((c, i) => (c.length ? `${i + 1}:[${c.map((x) => x + 1).join(' ')}]` : null)).filter(Boolean);
  if (chains.length) lines.push(`chains ${chains.join(' ')}`);
  for (const pattern of project.patterns) {
    const grid = patternGrid(pattern);
    if (!grid.length) continue;
    lines.push(`pattern ${pattern.index + 1}`);
    for (const row of grid) lines.push('  ' + row);
  }
  return lines.join('\n');
}

/**
 * Standard MIDI File (type 1) for one or more patterns, played in order,
 * `bars` bars each, one MTrk per OP-Z track on its factory channel. Ticks are
 * the file's own — 10240 per quarter — so nothing is re-quantised.
 */
export function opzToSmf(project, { patterns = null, bars = 1, name = 'OP-Z' } = {}) {
  const ids = patterns ?? project.patterns.map((p) => p.index);
  const spanTicks = bars * OPZ_STEPS * OPZ_TICKS_PER_STEP;
  const perTrack = new Map();
  ids.forEach((id, i) => {
    const pattern = project.patterns[id];
    if (!pattern) throw new Error(`no pattern ${id}`);
    for (const ev of patternEvents(pattern, { bars })) {
      if (!perTrack.has(ev.track)) perTrack.set(ev.track, []);
      perTrack.get(ev.track).push({ ...ev, startTicks: ev.startTicks + i * spanTicks });
    }
  });
  const tracks = [...perTrack.entries()].sort((a, b) => a[0] - b[0]).map(([t, notes]) => ({
    name: OPZ_TRACK_NAMES[t],
    channel: OPZ_TRACK_CHANNELS[t],
    notes,
  }));
  return buildSmf({
    name,
    division: OPZ_TICKS_PER_QUARTER,
    tempoBpm: project.tempo,
    tracks,
    endTicks: ids.length * spanTicks,
  });
}

// --- Standard MIDI File writer ------------------------------------------

function varint(value) {
  const out = [value & 0x7f];
  value >>>= 7;
  while (value > 0) {
    out.unshift((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  return out;
}

function chunk(tag, body) {
  const out = new Uint8Array(8 + body.length);
  out[0] = tag.charCodeAt(0); out[1] = tag.charCodeAt(1); out[2] = tag.charCodeAt(2); out[3] = tag.charCodeAt(3);
  out[4] = (body.length >>> 24) & 0xff; out[5] = (body.length >>> 16) & 0xff; out[6] = (body.length >>> 8) & 0xff; out[7] = body.length & 0xff;
  out.set(body, 8);
  return out;
}

function trackChunk(events, endTicks) {
  // events: { ticks, bytes } — sorted here, note-offs before note-ons at a tie
  events.sort((a, b) => a.ticks - b.ticks || a.order - b.order);
  const body = [];
  let last = 0;
  for (const ev of events) {
    body.push(...varint(ev.ticks - last), ...ev.bytes);
    last = ev.ticks;
  }
  body.push(...varint(Math.max(0, endTicks - last)), 0xff, 0x2f, 0x00);
  return chunk('MTrk', Uint8Array.from(body));
}

function metaText(type, text) {
  const enc = new TextEncoder().encode(text);
  return [0xff, type, ...varint(enc.length), ...enc];
}

/**
 * Build a type-1 SMF. Tracks are `{ name, channel, notes: [{ note, velocity,
 * startTicks, durationTicks }] }`; the first MTrk carries tempo and 4/4.
 */
export function buildSmf({ name = '', division = 480, tempoBpm = 120, tracks = [], endTicks = 0 }) {
  const usPerQuarter = Math.round(60_000_000 / Math.max(1, tempoBpm));
  const head = new Uint8Array(14);
  head.set([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1]);
  const count = tracks.length + 1;
  head[10] = (count >> 8) & 0xff; head[11] = count & 0xff;
  head[12] = (division >> 8) & 0xff; head[13] = division & 0xff;

  const conductor = [
    { ticks: 0, order: 0, bytes: metaText(0x03, name) },
    { ticks: 0, order: 1, bytes: [0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff] },
    { ticks: 0, order: 2, bytes: [0xff, 0x58, 0x04, 4, 2, 24, 8] },
  ];
  let last = endTicks;
  const chunks = [trackChunk(conductor, endTicks)];
  for (const track of tracks) {
    const ch = track.channel & 0x0f;
    const events = [{ ticks: 0, order: 0, bytes: metaText(0x03, track.name || '') }];
    for (const n of track.notes) {
      const off = n.startTicks + Math.max(1, n.durationTicks);
      events.push({ ticks: n.startTicks, order: 2, bytes: [0x90 | ch, n.note & 0x7f, Math.max(1, Math.min(127, n.velocity))] });
      events.push({ ticks: off, order: 1, bytes: [0x80 | ch, n.note & 0x7f, 0] });
      if (off > last) last = off;
    }
    chunks.push(trackChunk(events, Math.max(endTicks, last)));
  }
  const total = head.length + chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  out.set(head, 0);
  let at = head.length;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
