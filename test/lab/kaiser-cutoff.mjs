// Same kernel as js/dsp/resample.js, cutoff scale parameterised (0.45 today).
import { measure, snap, tone } from './e12-lib.mjs';
const KAISER_BETA = 7.857, HALF_WIDTH = 160, PHASES = 512;
function besselI0(x) { let s = 1, t = 1; const h = x / 2; for (let k = 1; k < 40; k++) { t *= (h / k) * (h / k); s += t; if (t < s * 1e-16) break; } return s; }
const cache = new Map();
function kernelTable(cutoff) { const key = cutoff.toFixed(8); if (cache.has(key)) return cache.get(key);
  const n = HALF_WIDTH * PHASES + 1, T = new Float64Array(n), i0b = besselI0(KAISER_BETA);
  for (let i = 0; i < n; i++) { const t = i / PHASES, x = 2 * cutoff * t; const sinc = t === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const r = t / HALF_WIDTH; T[i] = 2 * cutoff * sinc * besselI0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - r * r))) / i0b; }
  cache.set(key, T); return T; }
function resample(input, inRate, outRate, scale) { const cutoff = scale * Math.min(inRate, outRate) / inRate; const table = kernelTable(cutoff);
  const ratio = inRate / outRate, outLen = Math.round(input.length * outRate / inRate), out = new Float32Array(outLen), n = input.length;
  for (let m = 0; m < outLen; m++) { const p = m * ratio, k0 = Math.max(0, Math.ceil(p - HALF_WIDTH)), k1 = Math.min(n - 1, Math.floor(p + HALF_WIDTH)); let acc = 0, ws = 0;
    for (let k = k0; k <= k1; k++) { const d = Math.abs(k - p) * PHASES; let di = d | 0; if (di >= table.length - 1) di = table.length - 2; const fr = d - di; const h = table[di] + (table[di + 1] - table[di]) * fr; acc += input[k] * h; ws += h; }
    out[m] = ws !== 0 ? acc / ws : 0; } return out; }
for (const scale of [0.45, 0.48, 0.485, 0.49, 0.4922]) {
  for (const [rIn, rOut, fs] of [[48000, 96000, [1000, 19000, 21000, 22000, 22500, 23000, 23500]], [44100, 96000, [15000, 19000, 20000, 21000, 21500]], [96000, 48000, [19000, 21000, 22000, 23000]]]) {
    for (const hz of fs) { const f = snap(hz, rOut); const x = tone(f, rIn, 2.01); const out = resample(x, rIn, rOut, scale); const m = measure(out, rOut, f);
      console.log(`scale ${scale.toFixed(4)} ${rIn/1000}k->${rOut/1000}k ${m.toneHz.toFixed(0).padStart(6)} Hz level ${m.levelDb.toFixed(2).padStart(7)} dB image ${m.imageDb.toFixed(1).padStart(7)} dB @ ${(m.imageHz/1000).toFixed(2)} kHz`); }
  }
}
