import { measure, snap, tone } from './e12-lib.mjs';
import { resample } from '/Users/ian/Developer/yellowjacket/js/dsp/resample.js';
function run(hz, rIn, rOut, label) { const f = snap(hz, rOut); const x = tone(f, rIn, 2.01);
  const t0 = performance.now(); const out = resample(x, rIn, rOut); const ms = performance.now() - t0;
  const m = measure(out, rOut, f);
  console.log(`${label.padEnd(20)} ${m.toneHz.toFixed(0).padStart(6)} Hz  level ${m.levelDb.toFixed(2).padStart(7)} dB  worst image ${m.imageDb.toFixed(1).padStart(7)} dB @ ${(m.imageHz/1000).toFixed(2)} kHz  (${ms.toFixed(0)} ms for ${(x.length/rIn).toFixed(2)} s, out ${out.length})`); }
for (const f of [1000, 19000, 20000, 21000, 21500, 22000, 23000]) run(f, 48000, 96000, 'resample.js 48k->96k');
for (const f of [1000, 19000, 19500, 20000]) run(f, 44100, 96000, 'resample.js 44.1k->96k');
for (const f of [1000, 19000, 21000, 30000]) run(f, 96000, 48000, 'resample.js 96k->48k');
