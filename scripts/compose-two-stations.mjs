// TWO STATIONS — a song composed from two radio signals, for the OP-Z.
//
// Every rule below is derived from a measurement made in this repo on
// 2026-09-04 (docs/lab/2026-09-04-cyclic-transcription.md):
//
//   tempo   105.7 bpm   UVB-76's buzzer cycle is 0.881 Hz; its second
//                       harmonic, 1.762 Hz, is the beat. One buzz = two beats.
//   key     B minor     WWV's minute tones: 500 Hz ≈ B4, 600 Hz ≈ D5 — a minor
//                       third. Verse and bridge live there.
//   lift    B major     UVB-76 carries a 156 Hz component ≈ D#3: the major
//                       third. The chorus takes it.
//   clock   1.000 Hz    WWV's tick, as a perc hit, runs the whole song at
//                       60 bpm against 105.7 — it phases through the beat
//                       and realigns every ~80 s. Nobody chose that.
//   bass    the buzz    one note every buzzer cycle (2 beats), held for the
//                       buzz's own duty (0.8 of 1.135 s).
//   texture the shape   UVB-76's pulse layers from the buzzer section, at
//                       their true rates and measured onsets, on the percs.
//   melody  the voice   the voice message's syllable rate (1.703 Hz ≈ one
//                       note per beat) gated by its phrase rate (0.646 Hz);
//                       pitch rises when the voice's loudness rises and falls
//                       when it falls, on the pentatonic; velocity is its level.
//
// Choices that are mine and not measurements: the form, the chord
// progressions (i–VI–III–VII / I–IV–V–I), the voicings, and which OP-Z track
// plays which role (from today's instrument atlas). Output: events for
// scripts/opz-perform.py, a Standard MIDI File, and the arrangement sheet.
//
//   node scripts/compose-two-stations.mjs <uvb76-score.json> <uvb76-8k.f32> <outdir>

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSmf } from '../js/export/opz-project.js';

const [scorePath, voicePath, outDir = '.'] = process.argv.slice(2);
const uvb = JSON.parse(readFileSync(scorePath, 'utf8'));

// ---- measurements in, constants out -------------------------------------
const BUZZ_HZ = 0.881;
const BPM = 2 * BUZZ_HZ * 60;                 // 105.72
const BEAT = 60 / BPM, BAR = 4 * BEAT;        // 0.5676 s, 2.2706 s
const TICK_HZ = 1.0;
const BUZZ_DUTY = 0.8 / 1.135;
const VOICE_NOTE_HZ = 1.703, VOICE_PHRASE_HZ = 0.646;

// OP-Z casting from the atlas (0-based MIDI channels; channel 0 is never used)
const CH = { kit: 1, perc: 2, sample: 3, bass: 4, lead: 5, arp: 6, pad: 7 };
const KICK = 48, SNARE = 60, HAT = 60, TICK = 36, TEX = 72;

// harmony: chord = [root name, pad voicing (MIDI), bass root (MIDI)]
const CHORDS = {
  Bm: [[59, 62, 66], 47], G: [[55, 59, 62], 43], D: [[62, 66, 69], 50], A: [[57, 61, 64], 45],
  B: [[59, 63, 66], 47], E: [[59, 64, 68], 52], Fs: [[58, 61, 66], 54],
};
const MINOR_PENT = [71, 74, 76, 78, 81, 83, 86, 88];   // B D E F# A B D E
const MAJOR_PENT = [71, 73, 75, 78, 80, 83, 85, 87];   // B C# D# F# G# B C# D#

// ---- form ----------------------------------------------------------------
const FORM = [
  { name: 'intro',    bars: 8,  chords: ['Bm', 'Bm', 'G', 'G', 'Bm', 'Bm', 'A', 'A'], tick: true, pad: 'swell' },
  { name: 'verse',    bars: 16, chords: ['Bm', 'G', 'D', 'A'], tick: true, pad: true, bass: 'buzz', kick: 'half', texture: true },
  { name: 'bridge',   bars: 8,  chords: ['G', 'A', 'Bm', 'Bm'], tick: true, pad: true, bass: 'buzz', melody: 'minor' },
  { name: 'chorus',   bars: 16, chords: ['B', 'E', 'Fs', 'B'], tick: true, pad: true, bass: 'beat', kick: 'four', hats: true, melody: 'major', arp: true },
  { name: 'verse 2',  bars: 8,  chords: ['Bm', 'G', 'D', 'A'], tick: true, pad: true, bass: 'buzz', kick: 'half', texture: true, melody: 'minor' },
  { name: 'chorus 2', bars: 16, chords: ['B', 'E', 'Fs', 'B'], tick: true, pad: true, bass: 'beat', kick: 'four', hats: true, melody: 'major', arp: true, texture: true },
  { name: 'outro',    bars: 8,  chords: ['Bm', 'G', 'Bm', 'Bm', 'G', 'Bm', 'Bm', 'Bm'], tick: true, pad: 'fade', bass: 'buzz-half', final: true },
];

// ---- the voice's loudness, for the melody's contour -----------------------
const raw = readFileSync(voicePath);
const voice = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const VRATE = 8000, VOICE_START = 80, VOICE_LEN = 40;
function voiceLevel(tSrc) { // RMS of a 60 ms window at tSrc seconds into the recording
  const i0 = Math.max(0, Math.floor(tSrc * VRATE)), n = Math.floor(0.06 * VRATE);
  let e = 0; for (let i = i0; i < i0 + n && i < voice.length; i++) e += voice[i] * voice[i];
  return Math.sqrt(e / n);
}
const levels = []; for (let t = 0; t < VOICE_LEN; t += 0.02) levels.push(voiceLevel(VOICE_START + t));
const LEVEL_MAX = Math.max(...levels);

// ---- UVB-76 texture layers: the buzzer section's pulse layers -------------
const textureLayers = uvb.sections.filter((s) => s.startSec >= 20 && s.startSec < 80)
  .flatMap((s) => s.layers.filter((L) => L.motion === 'pulse' && L.alphaHz > 1.9)).slice(0, 4);

// ---- writing ----------------------------------------------------------------
const ev = [];
const on = (t, ch, note, vel) => ev.push({ t, kind: 'on', channel: ch, note, value: vel });
const off = (t, ch, note) => ev.push({ t, kind: 'off', channel: ch, note, value: 0 });
const note = (t, ch, n, vel, hold) => { on(t, ch, n, vel); off(t + hold, ch, n); };
const ccrel = (t, ch, cc, delta) => { if (delta) ev.push({ t, kind: 'ccrel', channel: ch, cc, delta }); };
const LEVEL_REL = 16 + 31; // relative twin of CC 16 (level)

let t0 = 0, barNo = 0;
const sheet = [];
for (const S of FORM) {
  const start = t0, end = t0 + S.bars * BAR;
  sheet.push(`${S.name.padEnd(9)} bars ${String(barNo + 1).padStart(2)}–${String(barNo + S.bars).padStart(2)}  ${fmt(start)}–${fmt(end)}  ${S.chords.join(' ')}`);
  for (let b = 0; b < S.bars; b++) {
    const bt = start + b * BAR;
    const chord = S.chords[b % S.chords.length];
    const [voicing, root] = CHORDS[chord];
    // pad: one chord per bar, tied through the bar; intro swells, outro fades by level
    if (S.pad) for (const n of voicing) note(bt, CH.pad, n, S.pad === 'swell' ? 70 + 6 * b : 84, BAR - 0.02);
    // bass
    if (S.bass === 'buzz') for (let k = 0; k < 2; k++) note(bt + k * 2 * BEAT, CH.bass, root, 100, 2 * BEAT * BUZZ_DUTY);
    if (S.bass === 'buzz-half' && b % 2 === 0) note(bt, CH.bass, root, 84, 2 * BEAT * BUZZ_DUTY);
    if (S.bass === 'beat') for (let k = 0; k < 4; k++) note(bt + k * BEAT, CH.bass, root, k % 2 ? 90 : 108, BEAT * 0.7);
    // kit
    if (S.kick === 'half') { note(bt, CH.kit, KICK, 116, 0.2); note(bt + 2 * BEAT, CH.kit, SNARE, 104, 0.2); }
    if (S.kick === 'four') {
      for (let k = 0; k < 4; k++) note(bt + k * BEAT, CH.kit, KICK, k === 0 ? 120 : 110, 0.2);
      note(bt + BEAT, CH.kit, SNARE, 108, 0.2); note(bt + 3 * BEAT, CH.kit, SNARE, 112, 0.2);
    }
    if (S.hats) for (let k = 0; k < 8; k++) note(bt + k * BEAT / 2, CH.perc, HAT, k % 2 ? 62 : 88, 0.08);
    // arp: hold the chord for the bar; the OP-Z arpeggiates on its own clock
    if (S.arp) for (const n of voicing) note(bt + 0.01, CH.arp, n + 12, 92, BAR - 0.05);
  }
  // the clock: WWV's tick, every second of the song
  if (S.tick) for (let t = Math.ceil(start / TICK_HZ) / TICK_HZ; t < end; t += 1 / TICK_HZ) note(t, CH.perc, TICK, S.final ? 96 : 76, 0.05);
  // texture: the buzzer's own pulse layers at their true rates, quiet
  if (S.texture) for (const [i, L] of textureLayers.entries()) {
    const ch = i % 2 ? CH.sample : CH.perc, n = i % 2 ? 48 : TEX;
    for (let t = start + L.onset; t < end; t += L.period) note(t, ch, n, 48 + Math.round(30 * Math.min(1, L.depth)), 0.06);
  }
  // melody: the voice's cadence and contour
  if (S.melody) {
    const scale = S.melody === 'major' ? MAJOR_PENT : MINOR_PENT;
    let deg = 2;
    for (let t = start; t < end - 0.1; t += 1 / VOICE_NOTE_HZ) {
      const tSrc = VOICE_START + ((t - start) % VOICE_LEN);
      const gate = Math.cos(2 * Math.PI * VOICE_PHRASE_HZ * (t - start));
      if (gate < -0.35) continue;                                    // the voice breathes here
      const lvl = voiceLevel(tSrc) / LEVEL_MAX;
      if (lvl < 0.08) continue;                                      // silence in the source
      const slope = voiceLevel(tSrc + 0.25) - voiceLevel(tSrc - 0.25);
      if (slope > 0.02 * LEVEL_MAX) deg = Math.min(scale.length - 1, deg + 1);
      else if (slope < -0.02 * LEVEL_MAX) deg = Math.max(0, deg - 1);
      note(t, CH.lead, scale[deg], 70 + Math.round(50 * Math.min(1, lvl * 1.5)), 0.45 / VOICE_NOTE_HZ);
    }
  }
  // final: WWV's 600 Hz minute tone, D5, held over the last bar — the minor third has the last word
  if (S.final) note(end - BAR, CH.lead, 74, 100, BAR - 0.05);
  // pad level swells (relative, net zero): intro rises, outro falls
  if (S.pad === 'swell' || S.pad === 'fade') {
    const steps = 18, dir = S.pad === 'swell' ? -1 : 1;              // swell: start low, return; fade: end low, return
    for (let i = 0; i < steps; i++) ccrel(start + (i / steps) * (end - start) * 0.9, CH.pad, LEVEL_REL, dir);
    for (let i = 0; i < steps; i++) ccrel(S.pad === 'swell' ? start + (0.9 * (end - start)) * (0.3 + 0.7 * i / steps) : end - 0.05, CH.pad, LEVEL_REL, -dir);
  }
  t0 = end; barNo += S.bars;
}
const order = { off: 0, ccrel: 1, on: 2 };
ev.sort((a, b) => a.t - b.t || order[a.kind] - order[b.kind]);
const seconds = t0;

function fmt(s) { return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }

// ---- outputs ---------------------------------------------------------------
writeFileSync(join(outDir, 'two-stations-events.json'), JSON.stringify(ev));
const tps = 960 * BPM / 60;
const byCh = new Map();
const opens = new Map();
for (const e of ev) {
  if (e.kind !== 'on' && e.kind !== 'off') continue;
  const key = e.channel * 128 + e.note;
  if (e.kind === 'on') { opens.set(key, e); continue; }
  const o = opens.get(key); if (!o) continue; opens.delete(key);
  if (!byCh.has(e.channel)) byCh.set(e.channel, { name: Object.entries(CH).find(([, c]) => c === e.channel)[0], channel: e.channel, notes: [] });
  byCh.get(e.channel).notes.push({ note: o.note, velocity: o.value, startTicks: Math.round(o.t * tps), durationTicks: Math.max(1, Math.round((e.t - o.t) * tps)) });
}
writeFileSync(join(outDir, 'two-stations.mid'), buildSmf({ name: 'TWO STATIONS', division: 960, tempoBpm: BPM, tracks: [...byCh.values()].sort((a, b) => a.channel - b.channel), endTicks: Math.round(seconds * tps) }));
const kinds = {}; for (const e of ev) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
const net = {}; for (const e of ev) if (e.kind === 'ccrel') { const k = e.channel + ':' + e.cc; net[k] = (net[k] || 0) + e.delta; }
const out = [
  `TWO STATIONS — ${BPM.toFixed(1)} bpm (UVB-76 × 2), B minor (WWV 500/600 Hz) → B major (UVB-76 156 Hz), ${fmt(seconds)}`,
  ...sheet,
  `events ${JSON.stringify(kinds)}  relative-level net ${JSON.stringify(net)}  texture layers ${textureLayers.map((L) => L.alphaHz.toFixed(2)).join('/')} Hz`,
].join('\n');
writeFileSync(join(outDir, 'two-stations-sheet.txt'), out);
console.log(out);
