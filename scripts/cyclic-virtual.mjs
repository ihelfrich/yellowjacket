// Stand-in instrument for a cyclic score: renders the events with the shared
// synth (js/compose/cyclic-synth.js), then reads the result back with the
// detector. Usage: node scripts/cyclic-virtual.mjs score.json out.f32
import { scoreFidelity } from '../js/compose/cyclic-score.js';
import { renderScore } from '../js/compose/cyclic-synth.js';
import { readFileSync, writeFileSync } from 'node:fs';
const [scorePath, outPath] = process.argv.slice(2);
const score = JSON.parse(readFileSync(scorePath, 'utf8'));
const rate = 22050;
const out = renderScore(score, { rate });
let mx = 0; for (const v of out) if (Math.abs(v) > mx) mx = Math.abs(v);
if (outPath) writeFileSync(outPath, Buffer.from(out.buffer));
const f = scoreFidelity(score, { mono: out, sampleRate: rate });
console.log(`virtual performance: peak ${mx.toFixed(2)}; ${f.found}/${f.total} layers came back through the detector (${(100 * f.rate).toFixed(0)}%)`);
for (const s of f.sections) console.log('  ' + String(s.startSec).padStart(4) + ' s  ' + s.layers.map((L) => L.alphaHz.toFixed(2) + (L.detected ? ' ok' : ' --')).join('  ') + '   heard: ' + s.peaks.slice(0, 6).map((p) => p.alphaHz.toFixed(2)).join(' '));
