// Stand-in instrument for a cyclic score: renders the events with noise bursts and sines,
// then reads the result back with the detector. Usage: node scripts/cyclic-virtual.mjs score.json out.f32
import { scoreEvents, scoreFidelity } from '../js/compose/cyclic-score.js';
import { readFileSync, writeFileSync } from 'node:fs';
const [scorePath, outPath] = process.argv.slice(2);
const score = JSON.parse(readFileSync(scorePath, 'utf8'));
const rate = 22050, out = new Float32Array(Math.ceil((score.seconds + 1) * rate));
const noteHz = (n) => 440 * Math.pow(2, (n - 69) / 12);
let seed = 7; const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) * 2 - 1; };
const open = new Map(); let notes = 0;
for (const e of scoreEvents(score)) {
  if (e.kind !== 'on' && e.kind !== 'off') continue;
  const key = e.channel * 128 + e.note;
  if (e.kind === 'on') { open.set(key, e); continue; }
  const on = open.get(key); if (!on) continue; open.delete(key); notes++;
  const t0 = on.t, at = Math.floor(t0 * rate), len = Math.floor(Math.min(e.t - t0, 30) * rate);
  const section = score.sections.find((s) => s.startSec <= t0 && t0 < s.startSec + s.seconds);
  const layer = section && section.layers.find((L) => L.channel === e.channel && L.note === e.note);
  const hz = noteHz(e.note), gain = 0.3 * (on.value / 127);
  for (let i = 0; i < len && at + i < out.length; i++) {
    const tt = i / rate;
    let env = e.channel === 2 ? Math.exp(-tt / 0.012) : Math.min(1, tt / 0.005) * (len > rate ? 1 : Math.exp(-tt / 0.05));
    if (layer && layer.motion === 'swell') env *= 0.55 + 0.45 * Math.cos(2 * Math.PI * layer.alphaHz * (t0 + tt - section.startSec - layer.onset));
    out[at + i] += gain * env * (e.channel === 2 ? rnd() : Math.sin(2 * Math.PI * hz * tt));
  }
}
let mx = 0; for (const v of out) if (Math.abs(v) > mx) mx = Math.abs(v);
writeFileSync(outPath, Buffer.from(out.buffer));
const f = scoreFidelity(score, { mono: out, sampleRate: rate });
console.log(`virtual performance: ${notes} notes rendered, peak ${mx.toFixed(2)}; ${f.found}/${f.total} layers came back through the detector (${(100 * f.rate).toFixed(0)}%)`);
for (const s of f.sections) console.log('  ' + String(s.startSec).padStart(4) + ' s  ' + s.layers.map((L) => L.alphaHz.toFixed(2) + (L.detected ? ' ok' : ' --')).join('  ') + '   heard: ' + s.peaks.slice(0, 6).map((p) => p.alphaHz.toFixed(2)).join(' '));
