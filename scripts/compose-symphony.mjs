#!/usr/bin/env node
// Thirteen Cards — assemble, render, master.
//
//   node scripts/compose-symphony.mjs out-dir [--movements 1,2,3,4] [--no-master]
//
// Loads the cards, builds each movement's score from js/score/symphony/,
// renders it by the physics (js/score/render.js), writes <dir>/movement-N.wav
// (48 kHz, 24-bit, unmastered) and <dir>/movement-N.json (stats), masters each
// to −15 LUFS / −1 dBTP with the RACK loudnorm (scripts/master-take.mjs), and
// joins the four with two seconds of silence into <dir>/thirteen-cards.wav.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { renderScore } from '../js/score/render.js';
import { scoreStats } from '../js/score/model.js';
import { writeWav24, readWav } from './lib/wav.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const outDir = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
if (!outDir) { console.error('usage: node scripts/compose-symphony.mjs out-dir [--movements 1,2,3,4] [--no-master]'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const which = String(opt('--movements', '1,2,3,4')).split(',').map(Number);
const master = !args.includes('--no-master');

const CARD_IDS = ['iowa-bells-brass-Cs5', 'iowa-bells-plastic-ff-Cs5', 'iowa-bells-plastic-ff-E5', 'iowa-bells-plastic-ff-A5', 'carillon-bell', 'freesound-wineglass', 'hiawatha-vowel', 'fdr-vowel', 'opz-thud', 'commons-bell-15cm', 'uvb76-buzz', 'wwv-tone', 'ory-chord'];
const cards = {};
for (const id of CARD_IDS) cards[id] = JSON.parse(readFileSync(new URL('../docs/lab/cards/' + id + '.json', import.meta.url), 'utf8'));

const pieces = [];
for (const n of which) {
  const mod = await import(`../js/score/symphony/movement-${n}.js`);
  const score = mod.movement({ cards });
  const stats = scoreStats(score);
  console.log(`movement ${n} · ${mod.TITLE} · ${stats.parts.length} parts · ${stats.notes} notes · ${stats.seconds.toFixed(1)} s (design ${mod.SECONDS} s)`);
  const t0 = Date.now();
  let shown = 0;
  const out = await renderScore(score, { tail: Math.max(0, mod.SECONDS - stats.seconds), onProgress: (d, a, id) => { if (d - shown >= Math.max(1, Math.floor(a / 10)) || d === a) { shown = d; process.stdout.write(`  ${d}/${a} ${id}\n`); } } });
  // The sum of RMS-normalised parts can pass full scale; a 24-bit file would
  // clamp it before the limiter ever saw it. The raw file leaves 3 dB of
  // headroom (a pure gain; the master re-levels).
  let peak = 0;
  for (const c of [out.left, out.right]) for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > peak) peak = v; }
  const headroom = peak > 0 ? Math.min(1, Math.pow(10, -3 / 20) / peak) : 1;
  if (headroom < 1) for (const c of [out.left, out.right]) for (let i = 0; i < c.length; i++) c[i] *= headroom;
  console.log(`  raw peak ${(20 * Math.log10(Math.max(1e-9, peak))).toFixed(1)} dBFS → ${headroom < 1 ? 'scaled by ' + (20 * Math.log10(headroom)).toFixed(1) + ' dB to −3 dBFS' : 'left as is'}`);
  const raw = resolve(outDir, `movement-${n}.wav`);
  writeWav24(raw, [out.left, out.right], out.sampleRate);
  writeFileSync(resolve(outDir, `movement-${n}.json`), JSON.stringify({ title: mod.TITLE, designSeconds: mod.SECONDS, stats, parts: out.parts, renderSeconds: (Date.now() - t0) / 1000 }, null, 1));
  for (const p of out.parts) console.log(`  ${p.id.padEnd(16)} ${Number.isFinite(p.rmsDb) ? p.rmsDb.toFixed(1).padStart(6) : '     -'} dB → gain ${(20 * Math.log10(p.gain)).toFixed(1)} dB`);
  console.log(`  wrote ${raw} · ${(out.left.length / out.sampleRate).toFixed(1)} s · rendered in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  let final = raw;
  if (master) {
    final = resolve(outDir, `movement-${n}-master.wav`);
    const log = execFileSync(process.execPath, [new URL('./master-take.mjs', import.meta.url).pathname, raw, final, '--target', '-15', '--ceiling', '-1'], { encoding: 'utf8' });
    process.stdout.write(log.split('\n').filter((l) => /^(in |out)/.test(l)).map((l) => '  ' + l).join('\n') + '\n');
  }
  pieces.push({ n, path: final, seconds: mod.SECONDS });
}

if (pieces.length > 1) {
  const gap = 2;
  const wavs = pieces.map((p) => readWav(p.path));
  const rate = wavs[0].sampleRate;
  const total = wavs.reduce((s, w) => s + w.channels[0].length, 0) + Math.round(gap * rate) * (wavs.length - 1);
  const L = new Float32Array(total), R = new Float32Array(total);
  let at = 0;
  const markers = [];
  for (const [i, w] of wavs.entries()) {
    markers.push({ movement: pieces[i].n, startSec: at / rate });
    L.set(w.channels[0], at); R.set((w.channels[1] || w.channels[0]), at);
    at += w.channels[0].length + Math.round(gap * rate);
  }
  const whole = resolve(outDir, 'thirteen-cards.wav');
  writeWav24(whole, [L, R], rate);
  writeFileSync(resolve(outDir, 'thirteen-cards.json'), JSON.stringify({ markers, seconds: total / rate, gapSeconds: gap }, null, 1));
  console.log(`wrote ${whole} · ${(total / rate / 60).toFixed(2)} min · movements start at ${markers.map((m) => m.startSec.toFixed(1)).join(', ')} s`);
}
