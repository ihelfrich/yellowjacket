#!/usr/bin/env node
// recording → instrument card.
//
//   node scripts/instrument-card.mjs in.wav out.json [--start s --end s | --auto] [--name N] [--license L] [--list 8]
//
// The input is high-passed at 40 Hz first (room rumble is not the object).
// --auto cards the twelve best transients and keeps the one the physics likes:
// onset by an energy jump of ~13 dB in 5 ms, end where the envelope has fallen
// 40 dB or the next onset arrives. --list N prints the N best candidates instead of writing a
// card, so a hit can be chosen by ear and passed back with --start/--end.

import { writeFileSync } from 'node:fs';
import { readWav, monoOf } from './lib/wav.mjs';
import { buildCard } from '../js/instrument/card.js';
import { highpass, findHits, bestHit } from '../js/instrument/hits.js';

const args = process.argv.slice(2);
const flags = new Set(['--auto']);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !flags.has(args[i - 1])));
const [inPath, outPath] = positional;
if (!inPath) { console.error('usage: node scripts/instrument-card.mjs in.wav out.json [--start s --end s | --auto] [--name N] [--license L] [--list N]'); process.exit(2); }

const wav = readWav(inPath), sampleRate = wav.sampleRate, mono = highpass(monoOf(wav), sampleRate);

let start = Number(opt('--start', NaN)), end = Number(opt('--end', NaN));
const listN = Number(opt('--list', 0));
if (listN > 0) {
  for (const h of findHits(mono, sampleRate).slice(0, listN)) console.log(`${h.start.toFixed(3)}–${h.end.toFixed(3)} s  jump ${h.jump.toFixed(1)}  ring ${h.ring.toFixed(2)} s  score ${h.score.toFixed(1)}`);
  process.exit(0);
}
if (args.includes('--auto') || !Number.isFinite(start)) {
  // Let the physics judge: card each of the best candidates and keep the one
  // with the most modes and the lowest residual (js/instrument/hits.js).
  const best = bestHit(mono, sampleRate, { tries: 12, maxSeconds: 2.5 });
  if (!best) { console.error('no transient found'); process.exit(1); }
  if (args.includes('--verbose')) for (const t of best.tried) console.log(`  ${t.start.toFixed(2)}–${t.end.toFixed(2)} s: ${t.modes} modes, fit ${t.fitDb.toFixed(1)} dB, ${t.kind}`);
  start = best.hit.start; end = best.hit.end;
}
if (!Number.isFinite(end)) end = Math.min(mono.length / sampleRate, start + 3);
const slice = mono.subarray(Math.round(start * sampleRate), Math.round(end * sampleRate));
const card = buildCard(slice, sampleRate, { name: opt('--name', inPath), license: opt('--license', ''), note: `from ${start.toFixed(3)}–${end.toFixed(3)} s.` });
if (outPath) writeFileSync(outPath, JSON.stringify(card, null, 1));
console.log(`${card.source.name}: ${card.family.kind} (${card.family.confidence.toFixed(2)}), ${card.modes.length} modes, damping ${card.damping.model} q0 ${card.damping.q0.toFixed(0)} exp ${card.damping.exponent.toFixed(2)}${card.nonlinearity ? ', nonlinear ×' + card.nonlinearity.length : ''}  [${start.toFixed(2)}–${end.toFixed(2)} s]`);
console.log('  ' + card.modes.slice(0, 8).map((m) => `${m.freqHz.toFixed(1)} Hz τ${m.tauSec.toFixed(2)}`).join('  '));
console.log('  ratios ' + card.family.ratios.map((r) => r.toFixed(3)).join(' : '));
