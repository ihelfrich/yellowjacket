#!/usr/bin/env node
// Read OP-Z project files and write them out as Standard MIDI Files.
//
//   node scripts/opz-export.mjs <file.opz>... [--out DIR] [--bars N] [--quiet]
//
// For every project: prints the inspector (tempo, swing, mixer, chains, and a
// step grid per used pattern), writes `<name>.mid` with every used pattern in
// order, and `<name>-pNN.mid` per used pattern. Reads files already copied off
// the device; never touches the device.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseOpz, describeOpz, opzToSmf } from '../js/export/opz-project.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const outDir = opt('--out', '.');
const bars = Number(opt('--bars', 1));
const quiet = args.includes('--quiet');
const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out' && args[i - 1] !== '--bars');
if (!files.length) {
  console.error('usage: node scripts/opz-export.mjs <file.opz>... [--out DIR] [--bars N] [--quiet]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

for (const file of files) {
  const name = basename(file).replace(/\.opz$/i, '');
  const project = parseOpz(readFileSync(file));
  if (!quiet) console.log(describeOpz(project, { label: name }) + '\n');
  const used = project.patterns.filter((p) => p.tracks.some((t) => t.notes.length)).map((p) => p.index);
  if (!used.length) { console.log(`${name}: no notes, nothing to write`); continue; }
  const written = [];
  const all = join(outDir, `${name}.mid`);
  writeFileSync(all, opzToSmf(project, { patterns: used, bars, name }));
  written.push(all);
  for (const id of used) {
    const one = join(outDir, `${name}-p${String(id + 1).padStart(2, '0')}.mid`);
    writeFileSync(one, opzToSmf(project, { patterns: [id], bars, name: `${name} pattern ${id + 1}` }));
    written.push(one);
  }
  console.log(`${name}: ${project.tempo} bpm, ${project.noteCount} notes, ${used.length} patterns -> ${written.length} files in ${outDir}`);
}
