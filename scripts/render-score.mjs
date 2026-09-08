#!/usr/bin/env node
// score → WAV, by the physics.
//
//   node scripts/render-score.mjs score.json out.wav            a score file (either shape below)
//   node scripts/render-score.mjs in.mid out.wav --cards map.json   a MIDI file; map = { "0": { card, excitation, pan, rmsDb }, "ch1": {...}, "*": {...} }
//
// A score file is either format 'yj-score-1' (js/score/model.js scoreToJson — a part's card is
// embedded or { ref: '<found-card id>' }, resolved against docs/lab/cards/), or the older
// untagged shape { title, sampleRate, parts: [{ id, card: 'docs/lab/cards/x.json', excitation,
// pan, rmsDb, gainDb, notes: [{ t, hz | midi, velocity, seconds }] }] }; both are read, and both
// are validated by scoreFromJson — the untagged shape is translated into the tagged one rather
// than being built by hand, so deleting a file's `format` key cannot buy it a looser reader.
// Master afterwards with scripts/master-take.mjs.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { scoreFromSmf, scoreStats, scoreFromJson, hzOfMidi, SCORE_FORMAT } from '../js/score/model.js';
import { renderScore } from '../js/score/render.js';
import { parseSmf } from '../js/midi/smf.js';
import { writeWav24 } from './lib/wav.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [inPath, outPath] = positional;
if (!inPath || !outPath) { console.error('usage: node scripts/render-score.mjs score.json|in.mid out.wav [--cards map.json]'); process.exit(2); }

const loadCard = (p, base) => JSON.parse(readFileSync(resolve(base, p), 'utf8'));
let score;
if (/\.midi?$/i.test(inPath)) {
  const mapPath = opt('--cards', null);
  if (!mapPath) { console.error('a MIDI file needs --cards map.json'); process.exit(2); }
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  const cards = {};
  for (const [k, v] of Object.entries(map)) cards[k] = { ...v, card: loadCard(v.card, dirname(resolve(mapPath))) };
  const { score: s, skipped } = scoreFromSmf(parseSmf(readFileSync(inPath)), cards, { title: inPath });
  score = s;
  for (const sk of skipped) console.error(`skipped track ${sk.track} (${sk.name || 'unnamed'}, ch ${sk.channel}): ${sk.notes} notes, no card assigned`);
} else {
  const doc = JSON.parse(readFileSync(inPath, 'utf8'));
  if (doc.format === SCORE_FORMAT) {
    const cards = {};
    for (const p of doc.parts || []) {
      const ref = p && p.card && p.card.ref;
      if (ref && !cards[ref]) cards[ref] = JSON.parse(readFileSync(new URL('../docs/lab/cards/' + ref + '.json', import.meta.url), 'utf8'));
    }
    score = scoreFromJson(doc, { cards });
  } else {
    // The untagged shape differs from yj-score-1 in two places — a part's card is
    // a path relative to the file, and a note may carry `midi` instead of `hz` —
    // so it is translated and handed to the same reader. Building it with addPart
    // and addNote instead skipped every check the format installs: measured, a
    // part with excitation 'nope', pan 40 and velocity null rendered without a
    // word (as strike, hard right, and 0.05 — near silence), while the identical
    // file with its `format` key restored was refused at the first of the three.
    const base = dirname(resolve(inPath));
    score = scoreFromJson({
      format: SCORE_FORMAT,
      title: doc.title || inPath,
      sampleRate: doc.sampleRate,
      parts: (doc.parts || []).map((p) => (p && typeof p === 'object' ? {
        ...p,
        card: typeof p.card === 'string' ? loadCard(p.card, base) : p.card,
        notes: Array.isArray(p.notes) ? p.notes.map((n) => (n && n.hz == null && n.midi != null ? { ...n, hz: hzOfMidi(n.midi) } : n)) : p.notes,
      } : p)),
    });
  }
}
const stats = scoreStats(score);
console.log(`${stats.title}: ${stats.parts.length} parts, ${stats.notes} notes, ${stats.seconds.toFixed(1)} s`);
let last = 0;
const t0 = Date.now();
const out = await renderScore(score, { onProgress: (done, all, id) => { if (done - last >= Math.max(1, Math.floor(all / 20)) || done === all) { last = done; process.stdout.write(`  ${done}/${all} ${id}\n`); } } });
writeWav24(outPath, [out.left, out.right], out.sampleRate);
for (const p of out.parts) console.log(`  ${p.id.padEnd(16)} measured ${Number.isFinite(p.rmsDb) ? p.rmsDb.toFixed(1) : '   -'} dB RMS · gain ${(20 * Math.log10(p.gain)).toFixed(1)} dB`);
console.log(`wrote ${outPath} · ${(out.left.length / out.sampleRate).toFixed(1)} s · ${((Date.now() - t0) / 1000).toFixed(1)} s to render`);
