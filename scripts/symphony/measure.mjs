#!/usr/bin/env node
// Measure a rendered movement: BS.1770 integrated and short-term loudness,
// true peak, crest, the RMS profile in 10 s windows, and the tail.
//   node scripts/symphony/measure.mjs file.wav [more.wav ...]
import { readWav } from '../lib/wav.mjs';
import { measureLoudness } from '../../js/dsp/loudness.js';
import { truePeakDb } from '../../js/dsp/truepeak.js';

if (typeof globalThis.AudioBuffer === 'undefined') {
  globalThis.AudioBuffer = class {
    constructor({ numberOfChannels, length, sampleRate }) { this.numberOfChannels = numberOfChannels; this.length = length; this.sampleRate = sampleRate; this.duration = length / sampleRate; this._ch = Array.from({ length: numberOfChannels }, () => new Float32Array(length)); }
    getChannelData(i) { return this._ch[i]; }
    copyToChannel(src, i) { this._ch[i].set(src); }
  };
}
const db = (x) => 20 * Math.log10(Math.max(1e-9, x));
for (const path of process.argv.slice(2)) {
  const { channels, sampleRate } = readWav(path);
  const buffer = new AudioBuffer({ numberOfChannels: channels.length, length: channels[0].length, sampleRate });
  channels.forEach((c, i) => buffer.copyToChannel(c, i));
  const m = measureLoudness(buffer);
  const n = channels[0].length, win = Math.round(10 * sampleRate);
  const rms = [];
  for (let s = 0; s + win <= n; s += win) { let e = 0; for (let i = s; i < s + win; i++) for (const c of channels) e += c[i] * c[i]; rms.push(db(Math.sqrt(e / (win * channels.length)))); }
  let peak = 0, sq = 0; for (const c of channels) for (let i = 0; i < n; i++) { const v = Math.abs(c[i]); if (v > peak) peak = v; sq += v * v; }
  const wholeRms = Math.sqrt(sq / (n * channels.length));
  let lastLoud = 0; for (const c of channels) for (let i = n - 1; i >= 0; i--) if (Math.abs(c[i]) > 1e-3) { lastLoud = Math.max(lastLoud, i); break; }
  const clipped = channels.reduce((s, c) => { let k = 0; for (let i = 0; i < n; i++) if (Math.abs(c[i]) >= 0.999) k++; return s + k; }, 0);
  console.log(`${path.split('/').pop()}: ${(n / sampleRate).toFixed(1)} s · ${m.integrated.toFixed(1)} LUFS · short-term max ${m.shortTermMax.toFixed(1)} · true peak ${truePeakDb(channels).toFixed(1)} dBTP · crest ${(db(peak) - db(wholeRms)).toFixed(1)} dB · 10 s RMS ${rms.length ? Math.min(...rms).toFixed(1) + '…' + Math.max(...rms).toFixed(1) : '-'} dBFS · last sound ${(lastLoud / sampleRate).toFixed(1)} s · clipped samples ${clipped}`);
}
