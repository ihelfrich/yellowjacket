#!/usr/bin/env node
// Scan the same channels again and report only what changed.
//
//   node tools/watch.mjs --kinds marker,numbers --ears 2 --state scans/state.json
//   node tools/watch.mjs --kinds marker --every 1800     keep going, half-hourly
//
// The first pass establishes what is normal and says so. Every pass after that
// prints changes and nothing else, because a watch that reprints eighty
// unchanged lines every half hour is a watch nobody reads.
//
// The one thing it will not do is cry wolf. If a receiver lost its slot, or
// this pass listened on fewer ears than the last one, the channel is reported
// as unchecked or as thinner evidence — never as a transmitter that stopped.
// "The Buzzer has gone quiet" is a sentence that has to be earned.
import fs from 'node:fs';
import path from 'node:path';
import { receivers } from './kiwi-net.mjs';
import { scanTarget, contextCache } from './scan.mjs';
import { byKind, KINDS } from '../js/sigint/catalog.js';
import { diffPass, nextState } from '../js/sigint/watchdiff.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);

function loadState(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

export async function onePass(targets, list, opts = {}) {
  const contexts = contextCache();
  const current = {};
  const decodes = {};
  for (const t of targets) {
    const r = await scanTarget(t, list, { ...opts, contexts });
    current[String(t.hz)] = r.error ? { error: r.error } : r.verdict;
    if (r.decode?.read?.length) decodes[String(t.hz)] = r.decode.read;
    await sleep(1200);
  }
  return { current, decodes, listened: contexts.size };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const statePath = arg('--state', 'scans/state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const kinds = String(arg('--kinds', 'marker,numbers,military')).split(',').map(s => s.trim()).filter(Boolean);
  const ears = Number(arg('--ears', 2));
  const seconds = Number(arg('--seconds', 30));
  const every = Number(arg('--every', 0));
  const targets = byKind(kinds).slice(0, Number(arg('--limit', 999)));

  do {
    const list = await receivers({ fresh: true });
    const previous = loadState(statePath);
    const first = Object.keys(previous).length === 0;
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`\n[${stamp} UTC] ${targets.length} channel${targets.length === 1 ? '' : 's'} (${kinds.join(', ')}), ${ears} ears`);

    const { current, decodes, listened } = await onePass(targets, list, { ears, seconds, decode: !has('--no-decode') });
    const changes = diffPass(targets, previous, current);

    if (first) {
      const heard = Object.values(current).filter(v => v.verdict === 'on-air').length;
      console.log(`first pass: ${heard} of ${targets.length} corroborated on the air across ${listened} receiver${listened === 1 ? '' : 's'}. This is the baseline; from here only changes are printed.`);
    } else {
      const real = changes.filter(c => c.kind !== 'unchecked' && c.kind !== 'first-look');
      if (!real.length) console.log(`nothing changed (${changes.filter(c => c.kind === 'unchecked').length} channels could not be checked)`);
      for (const c of real) {
        console.log(`  ${c.kind.toUpperCase().padEnd(16)} ${(c.hz / 1e6).toFixed(4)} MHz  ${c.name}`);
        console.log(`      ${c.note}`);
        if (decodes[String(c.hz)]) for (const d of decodes[String(c.hz)]) console.log(`      READ ${d.name}: ${String(d.text).replace(/\n/g, ' / ').slice(0, 100)}`);
      }
    }
    fs.writeFileSync(statePath, JSON.stringify(nextState(previous, current), null, 1));
    if (every > 0) { console.log(`sleeping ${every}s`); await sleep(every * 1000); }
  } while (every > 0);
}
