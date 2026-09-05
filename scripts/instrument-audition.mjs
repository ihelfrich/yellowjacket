#!/usr/bin/env node
// card → one WAV: for each excitation, a rising compass of eight notes over
// --octaves (default 2) from the card's own pitch, then a chord from the
// card's related scale. 48 kHz 24-bit stereo, peak-normalised to −1 dBFS.
//
//   node scripts/instrument-audition.mjs card.json out.wav [--excitations strike,pluck,breath,bow] [--octaves 2]

import { readFileSync } from 'node:fs';
import { writeWav24 } from './lib/wav.mjs';
import { renderVoice, TRUTH_RATE } from '../js/instrument/render.js';
import { cardPitchHz } from '../js/instrument/family.js';
import { relatedScale } from '../js/instrument/tuning.js';
import { resample } from '../js/dsp/resample.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const [cardPath, outPath] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!cardPath || !outPath) { console.error('usage: node scripts/instrument-audition.mjs card.json out.wav [--excitations a,b] [--octaves 2]'); process.exit(2); }
const card = JSON.parse(readFileSync(cardPath, 'utf8'));
const excitations = opt('--excitations', 'strike,pluck,breath,bow').split(',').filter(Boolean);
const octaves = Number(opt('--octaves', 2)), f0 = cardPitchHz(card), gap = 0.15;

const parts = [];
let t = 0;
const place = (buf, at) => parts.push({ buf, at });
const sustained = (ex) => ex === 'breath' || ex === 'bow';
const lines = [];
for (const ex of excitations) {
  const t0 = t;
  for (let k = 0; k < 8; k++) {
    const pitch = f0 * Math.pow(2, octaves * k / 7);
    const v = renderVoice({ card, pitchHz: pitch, excitation: ex, seconds: sustained(ex) ? 1.2 : 1.5, dynamics: 0.9 });
    place(v.samples, t);
    t += (sustained(ex) ? 1.3 : 0.6) + gap;
  }
  lines.push(`${ex.padEnd(6)} ${t0.toFixed(1)}–${t.toFixed(1)} s`);
  t += 0.8;
}
const scale = relatedScale(card.modes).slice(0, 3);
const chordAt = t;
for (const s of [1, ...scale.map((x) => x.ratio)]) { const v = renderVoice({ card, pitchHz: f0 * s, excitation: excitations[0], seconds: 3 }); place(v.samples, t); }
t += 3.5;
lines.push(`chord  ${chordAt.toFixed(1)}–${t.toFixed(1)} s  (root + ${scale.map((x) => x.cents.toFixed(0) + 'c').join(', ') || 'no minima'})`);

const total = new Float32Array(Math.ceil(t * TRUTH_RATE));
for (const { buf, at } of parts) { const o = Math.round(at * TRUTH_RATE); for (let i = 0; i < buf.length && o + i < total.length; i++) total[o + i] += buf[i]; }
let peak = 0; for (let i = 0; i < total.length; i++) peak = Math.max(peak, Math.abs(total[i]));
const norm = peak > 0 ? Math.pow(10, -1 / 20) / peak : 1;
for (let i = 0; i < total.length; i++) total[i] *= norm;
const out = resample(total, TRUTH_RATE, 48000, { cutoffScale: 0.45 });
writeWav24(outPath, [out, out], 48000);
console.log(`wrote ${outPath}: ${(out.length / 48000).toFixed(1)} s, ${card.family.kind} at ${f0.toFixed(1)} Hz, peak before norm ${peak.toFixed(3)}`);
for (const l of lines) console.log('  ' + l);
