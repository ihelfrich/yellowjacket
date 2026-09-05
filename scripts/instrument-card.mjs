#!/usr/bin/env node
// recording → instrument card.
//
//   node scripts/instrument-card.mjs in.wav out.json [--start s --end s | --auto] [--name N] [--license L] [--list 8]
//
// --auto picks the loudest transient with the longest ring: onset by an energy
// jump of ~13 dB in 5 ms, end where the envelope has fallen 40 dB or the next
// onset arrives. --list N prints the N best candidates instead of writing a
// card, so a hit can be chosen by ear and passed back with --start/--end.

import { writeFileSync } from 'node:fs';
import { readWav, monoOf } from './lib/wav.mjs';
import { buildCard } from '../js/instrument/card.js';

const args = process.argv.slice(2);
const flags = new Set(['--auto']);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !flags.has(args[i - 1])));
const [inPath, outPath] = positional;
if (!inPath) { console.error('usage: node scripts/instrument-card.mjs in.wav out.json [--start s --end s | --auto] [--name N] [--license L] [--list N]'); process.exit(2); }

const wav = readWav(inPath), sampleRate = wav.sampleRate, mono = monoOf(wav);

/** Candidate hits: { start, end, jump, ring, score }, best first. */
export function findHits(mono, sampleRate, { maxSeconds = 3 } = {}) {
  const hop = Math.round(0.005 * sampleRate), frames = Math.floor(mono.length / hop), e = new Float32Array(frames);
  for (let f = 0; f < frames; f++) { let s = 0; for (let i = 0; i < hop; i++) s += mono[f * hop + i] ** 2; e[f] = Math.log(1e-9 + s / hop); }
  const hits = [];
  for (let f = 4; f < frames - 40; f++) {
    const jump = e[f] - Math.max(e[f - 1], e[f - 2], e[f - 3]);
    if (jump < 1.5) continue; // ~6.5 dB in 5 ms; bells over a crowd do not jump 13 dB
    let ring = 0;
    while (f + ring < frames && e[f + ring] > e[f] - 9.2 && ring * hop / sampleRate < maxSeconds) {
      if (ring > 2 && e[f + ring] - Math.max(e[f + ring - 1], e[f + ring - 2]) > 3) break; // the next onset
      ring++;
    }
    if (ring * hop / sampleRate < 0.08) continue; // shorter than 80 ms is not a ring
    hits.push({ start: f * hop / sampleRate, end: Math.min(mono.length / sampleRate, (f + ring + 4) * hop / sampleRate), jump, ring: ring * hop / sampleRate, score: jump + 2 * Math.log(1 + ring) });
    f += Math.max(1, Math.min(ring, 20));
  }
  return hits.sort((a, b) => b.score - a.score);
}

let start = Number(opt('--start', NaN)), end = Number(opt('--end', NaN));
const listN = Number(opt('--list', 0));
if (listN > 0) {
  for (const h of findHits(mono, sampleRate).slice(0, listN)) console.log(`${h.start.toFixed(3)}–${h.end.toFixed(3)} s  jump ${h.jump.toFixed(1)}  ring ${h.ring.toFixed(2)} s  score ${h.score.toFixed(1)}`);
  process.exit(0);
}
if (args.includes('--auto') || !Number.isFinite(start)) {
  // Let the physics judge: card each of the best candidates and keep the one
  // with the most modes and the lowest residual.
  const tries = findHits(mono, sampleRate).slice(0, 12);
  if (!tries.length) { console.error('no transient found'); process.exit(1); }
  let best = null;
  for (const h of tries) {
    const sl = mono.subarray(Math.round(h.start * sampleRate), Math.round(Math.min(h.end, h.start + 2.5) * sampleRate));
    const c = buildCard(sl, sampleRate, { name: 'try' });
    const fitDb = Number((c.source.note.match(/fit (-?[\d.]+) dB/) || [0, 0])[1]);
    const rank = (c.modes.length >= 3 ? 100 : 0) + c.modes.length - fitDb / 3;
    if (args.includes('--verbose')) console.log(`  ${h.start.toFixed(2)}–${h.end.toFixed(2)} s: ${c.modes.length} modes, fit ${fitDb.toFixed(1)} dB, ${c.family.kind}`);
    if (!best || rank > best.rank) best = { ...h, rank, modes: c.modes.length, fitDb };
  }
  start = best.start; end = Math.min(best.end, best.start + 2.5);
}
if (!Number.isFinite(end)) end = Math.min(mono.length / sampleRate, start + 3);
const slice = mono.subarray(Math.round(start * sampleRate), Math.round(end * sampleRate));
const card = buildCard(slice, sampleRate, { name: opt('--name', inPath), license: opt('--license', ''), note: `from ${start.toFixed(3)}–${end.toFixed(3)} s.` });
if (outPath) writeFileSync(outPath, JSON.stringify(card, null, 1));
console.log(`${card.source.name}: ${card.family.kind} (${card.family.confidence.toFixed(2)}), ${card.modes.length} modes, damping ${card.damping.model} q0 ${card.damping.q0.toFixed(0)} exp ${card.damping.exponent.toFixed(2)}${card.nonlinearity ? ', nonlinear ×' + card.nonlinearity.length : ''}  [${start.toFixed(2)}–${end.toFixed(2)} s]`);
console.log('  ' + card.modes.slice(0, 8).map((m) => `${m.freqHz.toFixed(1)} Hz τ${m.tauSec.toFixed(2)}`).join('  '));
console.log('  ratios ' + card.family.ratios.map((r) => r.toFixed(3)).join(' : '));
