#!/usr/bin/env node
// The score of each movement as a Standard MIDI File for the sheet: one track
// per part, pitches to the nearest semitone (the exact hertz live in the
// score; a note's cents are noted in the track name when a part is just), at
// 120 bpm so ticks are exact halves of a millisecond.
//   node scripts/symphony/export-midi.mjs out-dir [--movements 1,2,3,4]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSmf } from '../../js/export/opz-project.js';
import { midiOfHz } from '../../js/score/model.js';

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
if (!outDir) { console.error('usage: node scripts/symphony/export-midi.mjs out-dir [--movements 1,2,3,4]'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const i = args.indexOf('--movements');
const which = (i >= 0 ? args[i + 1] : '1,2,3,4').split(',').map(Number);
const CARD_IDS = ['iowa-bells-brass-Cs5', 'iowa-bells-plastic-ff-Cs5', 'iowa-bells-plastic-ff-E5', 'iowa-bells-plastic-ff-A5', 'carillon-bell', 'freesound-wineglass', 'hiawatha-vowel', 'fdr-vowel', 'opz-thud', 'commons-bell-15cm', 'uvb76-buzz', 'wwv-tone', 'ory-chord'];
const cards = {};
for (const id of CARD_IDS) cards[id] = JSON.parse(readFileSync(new URL('../../docs/lab/cards/' + id + '.json', import.meta.url), 'utf8'));
const DIV = 480, BPM = 120, TICK = 1 / (DIV * 2); // seconds per tick at 120 bpm
for (const n of which) {
  const mod = await import(`../../js/score/symphony/movement-${n}.js`);
  const score = mod.movement({ cards });
  const tracks = score.parts.map((p, k) => {
    let cents = 0;
    const notes = p.notes.map((x) => { const m = midiOfHz(x.hz); const r = Math.round(m); cents = Math.max(cents, Math.abs(m - r) * 100); return { startTicks: Math.round(x.t / TICK), durationTicks: Math.max(1, Math.round(x.seconds / TICK)), note: Math.max(0, Math.min(127, r)), velocity: Math.round(x.velocity * 127) }; });
    return { name: `${p.id} · ${p.excitation}${cents > 1 ? ' · to ' + cents.toFixed(0) + ' cents off 12-TET' : ''}`, channel: k % 16 === 9 ? 10 : k % 16, notes };
  });
  const end = Math.round(mod.SECONDS / TICK);
  const bytes = buildSmf({ name: `Thirteen Cards · ${n}. ${mod.TITLE}`, division: DIV, tempoBpm: BPM, tracks, endTicks: end });
  const path = resolve(outDir, `movement-${n}.mid`);
  writeFileSync(path, Buffer.from(bytes));
  console.log(`wrote ${path} · ${tracks.length} tracks · ${tracks.reduce((s, t) => s + t.notes.length, 0)} notes`);
}
