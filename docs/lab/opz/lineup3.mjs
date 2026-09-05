import { readFileSync, readdirSync } from 'node:fs';
import { parseOpz, patternEvents, OPZ_TICKS_PER_STEP, OPZ_STEPS } from '../../../js/export/opz-project.js';
const SR = 44100, BPM = 105;
const meta = JSON.parse(readFileSync('opz-play.json', 'utf8'));
const raw = readFileSync('opz-play.f32');
const mono = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const files = readdirSync('opz').filter((f) => f.endsWith('.opz')).sort();
const projects = files.map((f) => ({ file: f, p: parseOpz(readFileSync('opz/' + f)) }));

// --- three-band onset strength via a 512-point STFT, hop 128
const N = 512, hop = 128, frames = Math.floor((mono.length - N) / hop);
const win = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
const BANDS = [[20, 200], [200, 3000], [3000, 16000]].map(([lo, hi]) => [Math.round(lo * N / SR), Math.round(hi * N / SR)]);
const re = new Float32Array(N), im = new Float32Array(N);
function fft(re, im) { // in-place radix-2
  for (let i = 1, j = 0; i < N; i++) { let bit = N >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= N; len <<= 1) { const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) { let cr = 1, ci = 0; for (let j = 0; j < len / 2; j++) { const a = i + j, b = a + len / 2; const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } } }
}
const logE = BANDS.map(() => new Float32Array(frames));
for (let f = 0; f < frames; f++) {
  for (let i = 0; i < N; i++) { re[i] = mono[f * hop + i] * win[i]; im[i] = 0; }
  fft(re, im);
  BANDS.forEach(([a, b], k) => { let e = 0; for (let i = a; i < b; i++) e += re[i] * re[i] + im[i] * im[i]; logE[k][f] = Math.log(1e-6 + e); });
}
const onset = logE.map((e) => { const o = new Float32Array(frames); for (let i = 2; i < frames; i++) o[i] = Math.max(0, e[i] - Math.max(e[i - 1], e[i - 2])); return o; });
const stepSec = 60 / BPM / 4, binSec = stepSec / 4, BINS = OPZ_STEPS * 4, barSec = stepSec * OPZ_STEPS;
const t0 = meta.start, tEnd = meta.stop, bars = Math.floor((tEnd - t0) / barSec);
function barVectors(bar, phaseSec) {
  return onset.map((o) => { const v = new Float32Array(BINS);
    for (let i = 0; i < frames; i++) { const t = (i * hop + N / 2) / SR - t0 - phaseSec - bar * barSec; if (t < 0 || t >= barSec) continue; const k = Math.floor(t / binSec); v[k] = Math.max(v[k], o[i]); }
    return v; });
}
function pearson(a, b) { const n = a.length; let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; } return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0; }
// track groups per band: low = kick+bass, mid = snare+sample+lead+arp+chord, high = perc+sample
const GROUPS = [[0, 4], [1, 3, 5, 6, 7], [2, 3]];
const candidates = [];
for (const { file, p } of projects) for (const pat of p.patterns) {
  const vs = GROUPS.map((g) => { const v = new Float32Array(BINS); for (const e of patternEvents(pat, { bars: 1, tracks: g })) { const k = Math.floor(e.startTicks / (OPZ_TICKS_PER_STEP / 4)); if (k >= 0 && k < BINS) v[k] = 1; } return v; });
  if (!vs.some((v) => v.some((x) => x))) continue;
  candidates.push({ file, pattern: pat.index, vs, pat });
}
const score = (avs, c) => c.vs.reduce((s, v, k) => s + pearson(avs[k], v), 0);
function fileBest(file, vecsAt) { // vecsAt(phase) -> per-bar band vectors; returns best phase and per-bar picks
  let best = null;
  for (let ph = 0; ph < BINS; ph++) { const vecs = vecsAt(ph); let total = 0; const picks = [];
    for (let bar = 0; bar < bars; bar++) { let top = null; for (const c of candidates) if (c.file === file) { const s = score(vecs[bar], c); if (!top || s > top.s) top = { s, c }; } total += top.s; picks.push(top); }
    if (!best || total > best.total) best = { ph, total, picks }; }
  return best;
}
const phaseCache = new Map();
const realVecs = (ph) => { if (!phaseCache.has(ph)) phaseCache.set(ph, Array.from({ length: bars }, (_, b) => barVectors(b, ph * binSec))); return phaseCache.get(ph); };
// permutation null: shuffle bins within each bar, same permutation across bands
let seed = 12345; const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 100000) / 100000; };
const PERMS = 30;
const permVecs = [];
for (let q = 0; q < PERMS; q++) { const perms = Array.from({ length: bars }, () => { const idx = [...Array(BINS).keys()]; for (let i = BINS - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } return idx; });
  const cache = new Map();
  permVecs.push((ph) => { if (!cache.has(ph)) cache.set(ph, realVecs(ph).map((bandVecs, b) => bandVecs.map((v) => Float32Array.from(perms[b], (i) => v[i])))); return cache.get(ph); }); }
console.log(`multi-band lineup: ${bars} bars, clock ${BPM} bpm, ${candidates.length} candidate patterns, ${PERMS} permutations per file\n`);
const rows = [];
for (const { file, p } of projects) {
  if (!candidates.some((c) => c.file === file)) continue;
  const real = fileBest(file, realVecs);
  const nulls = permVecs.map((pv) => fileBest(file, pv).total);
  const mu = nulls.reduce((a, b) => a + b, 0) / PERMS, sd = Math.sqrt(nulls.reduce((a, b) => a + (b - mu) ** 2, 0) / (PERMS - 1)) || 1e-9;
  rows.push({ file, tempo: p.tempo, total: real.total, z: (real.total - mu) / sd, mu, ph: real.ph, picks: real.picks });
}
rows.sort((a, b) => b.z - a.z);
console.log('rank  file                    bpm   score   null µ    z     phase  picks');
rows.forEach((r, i) => console.log(`${String(i + 1).padStart(4)}  ${r.file.padEnd(22)} ${String(r.tempo).padStart(4)}   ${r.total.toFixed(2).padStart(5)}   ${r.mu.toFixed(2).padStart(5)}  ${r.z.toFixed(1).padStart(5)}   ${String(Math.round(r.ph * binSec * 1000)).padStart(4)}ms  ${r.picks.map((x) => 'p' + (x.c.pattern + 1)).join(' ')}`));
const w = rows[0];
console.log(`\nVERDICT: ${w.file} (${w.tempo} bpm; clock ${BPM} bpm ${w.tempo === BPM ? 'AGREES' : 'DISAGREES'}), z = ${w.z.toFixed(1)}; runner-up ${rows[1].file} z = ${rows[1].z.toFixed(1)}`);
const vecs = realVecs(w.ph);
const names = ['LOW  kick+bass', 'MID  snare+synth', 'HIGH perc'];
for (let bar = 0; bar < Math.min(bars, 2); bar++) {
  console.log(`\nbar ${bar + 1}: audio (X strong x weak) vs ${w.file} pattern ${w.picks[bar].c.pattern + 1}`);
  vecs[bar].forEach((v, k) => { const steps = []; for (let s = 0; s < OPZ_STEPS; s++) steps.push(Math.max(v[s * 4], v[s * 4 + 1], v[s * 4 + 2], v[s * 4 + 3])); const mx = Math.max(...steps) || 1;
    const arow = steps.map((x) => (x > 0.5 * mx ? 'X' : x > 0.25 * mx ? 'x' : '.')).join('');
    const fv = w.picks[bar].c.vs[k]; const frow = Array.from({ length: OPZ_STEPS }, (_, s) => (fv[s * 4] || fv[s * 4 + 1] || fv[s * 4 + 2] || fv[s * 4 + 3] ? 'x' : '.')).join('');
    console.log(`  ${names[k].padEnd(17)} ${arow}   ${frow}   r=${pearson(v, fv).toFixed(2)}`); });
}
