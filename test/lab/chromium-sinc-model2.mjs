import { measure, snap, tone } from './e12-lib.mjs';
const K = 64, PH = 32, SCALE_ADJ = 0.92;
function kernels(ioRatio) { const a = 0.16, a0 = 0.5 * (1 - a), a1 = 0.5, a2 = 0.5 * a; const s = (ioRatio > 1 ? 1 / ioRatio : 1) * SCALE_ADJ; const T = [];
  for (let p = 0; p <= PH; p++) { const off = p / PH, k = new Float64Array(K);
    for (let i = 0; i < K; i++) { const pre = Math.PI * (i - K / 2 - off), x = (i - off) / K;
      const w = a0 - a1 * Math.cos(2 * Math.PI * x) + a2 * Math.cos(4 * Math.PI * x); k[i] = w * (pre ? Math.sin(s * pre) / pre : s); }
    T.push(k); } return T; }
function resample(input, ioRatio, outLen) { const T = kernels(ioRatio), out = new Float64Array(outLen); let pos = 0;
  for (let n = 0; n < outLen; n++) { const src = Math.floor(pos), frac = pos - src, kf = frac * PH, ki = Math.floor(kf), f = kf - ki;
    const k1 = T[ki], k2 = T[Math.min(ki + 1, PH)]; let s1 = 0, s2 = 0;
    for (let i = 0; i < K; i++) { const v = input[src + i] || 0; s1 += v * k1[i]; s2 += v * k2[i]; }
    out[n] = (1 - f) * s1 + f * s2; pos += ioRatio; } return out; }
function run(hz, rIn, rOut, label) { const f = snap(hz, rOut); const x = tone(f, rIn, 2 + 0.01);
  const out = rIn === rOut ? x : resample(x, rIn / rOut, rOut * 2); const m = measure(out, rOut, f);
  console.log(`${label.padEnd(18)} ${m.toneHz.toFixed(0).padStart(6)} Hz  level ${m.levelDb.toFixed(2).padStart(7)} dB  worst image ${m.imageDb.toFixed(1).padStart(7)} dB @ ${(m.imageHz/1000).toFixed(2)} kHz`); }
run(19000, 96000, 96000, 'control 96k->96k');
for (const f of [1000, 10000, 19000, 20000, 21000, 22000, 23000, 23500]) run(f, 48000, 96000, 'ctx48k->dev96k');
for (const f of [1000, 15000, 19000, 20000, 21000]) run(f, 44100, 96000, 'ctx44.1k->dev96k');
for (const f of [1000, 19000, 21000, 22000, 30000, 40000]) run(f, 96000, 48000, 'ctx96k->dev48k');
