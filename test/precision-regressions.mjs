import assert from 'node:assert/strict';
import { precisionSpectrum, spectrumPlan, spectrumCell } from '../js/analysis/precision-spectrum.js';

const sr = 48000, n = 65536;
const samples = new Float32Array(sr * 4);
const f = 137 * sr / n;
for (let i = 0; i < samples.length; i++) samples[i] = 0.01 * Math.sin(2 * Math.PI * f * i / sr);
const result = precisionSpectrum(samples, sr, { fftSize: n, lowHz: 50, highHz: 200, offset: 17 });
assert.equal(result.cols, 8);
assert.equal(result.firstTime, 17 + n / (2 * sr));
const cell = spectrumCell(result, result.firstTime, f);
assert.ok(Math.abs(cell.db + 40) < 0.001, `tone amplitude ${cell.db}`);
assert.equal(cell.hz, f);
assert.equal(spectrumCell(result, 1000, 10000).c, result.cols - 1);

// Two low-frequency tones 3 Hz apart must resolve independently in the fine view.
for (let i = 0; i < samples.length; i++) samples[i] = .01 * Math.sin(2 * Math.PI * 100 * i / sr) + .006 * Math.sin(2 * Math.PI * 103 * i / sr);
const two = precisionSpectrum(samples, sr, { fftSize: n, lowHz: 90, highHz: 110 });
const peak = (lo, hi) => {
  let best = { db: -Infinity };
  for (let b = 0; b < two.bins; b++) {
    const hz = (two.firstBin + b) * two.binHz;
    if (hz >= lo && hz <= hi && two.db[b] > best.db) best = { hz, db: two.db[b] };
  }
  return best;
};
assert.ok(Math.abs(peak(99, 101).hz - 100) <= two.binHz / 2);
assert.ok(Math.abs(peak(102, 104).hz - 103) <= two.binHz / 2);
assert.ok(spectrumCell(two, two.firstTime, 101.5).db < peak(102, 104).db - 6);

// Faint descending trace, with known instantaneous frequency at window centres.
let phase = 0;
for (let i = 0; i < samples.length; i++) { phase += 2 * Math.PI * (150 - 2 * i / sr) / sr; samples[i] = 1e-5 * Math.sin(phase); }
const chirp = precisionSpectrum(samples, sr, { fftSize: n, lowHz: 130, highHz: 160, offset: 9 });
for (let c = 0; c < chirp.cols; c++) {
  let bMax = 0;
  for (let b = 1; b < chirp.bins; b++) if (chirp.db[c * chirp.bins + b] > chirp.db[c * chirp.bins + bMax]) bMax = b;
  const expected = 150 - 2 * (chirp.firstTime - 9 + c * chirp.stepTime);
  assert.ok(Math.abs((chirp.firstBin + bMax) * chirp.binHz - expected) < chirp.binHz);
  assert.ok(chirp.db[c * chirp.bins + bMax] < -90, 'retain faint levels below overview floor');
}
const silent = precisionSpectrum(new Float32Array(n), sr, { fftSize: n, lowHz: 0, highHz: 10 });
assert.ok(silent.db.every(x => Number.isFinite(x) && x === -300));
assert.equal(silent.cols, 1);
assert.throws(() => spectrumPlan(100, sr, { fftSize: n }), /shorter/);
assert.throws(() => spectrumPlan(sr * 60 * 60, sr), /budget/);
assert.throws(() => spectrumPlan(n, sr, { fftSize: n, highHz: 50000 }), /Nyquist/);
assert.throws(() => spectrumPlan(n, sr, { fftSize: 3000 }), /valid/);
console.log('Precision spectrum: calibrated amplitude, close tones, faint chirp, absolute times, silence and bounds passed.');
