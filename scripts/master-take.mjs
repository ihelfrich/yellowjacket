// Master a take with the bench's own stages, headless: loudness-normalise to a
// target (BS.1770 integrated) with the true-peak limiter at its ceiling, then
// write a 24-bit WAV and print before/after. The DSP is the same code the RACK
// runs in the browser; node only lacks AudioBuffer, so a minimal one is
// installed first.
//
//   node scripts/master-take.mjs in.wav out.wav [--target -14] [--ceiling -1]

import { readWav as readWavChannels, writeWav24 as writeChannels24 } from './lib/wav.mjs';

if (typeof globalThis.AudioBuffer === 'undefined') {
  globalThis.AudioBuffer = class {
    constructor({ numberOfChannels, length, sampleRate }) {
      this.numberOfChannels = numberOfChannels; this.length = length; this.sampleRate = sampleRate;
      this._ch = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
    }
    getChannelData(i) { return this._ch[i]; }
    copyToChannel(src, i, offset = 0) { this._ch[i].set(src, offset); }
    copyFromChannel(dst, i, offset = 0) { dst.set(this._ch[i].subarray(offset, offset + dst.length)); }
  };
}
if (typeof globalThis.MessageChannel === 'undefined') {
  const { MessageChannel } = await import('node:worker_threads');
  globalThis.MessageChannel = MessageChannel;
}

const { processLoudnorm } = await import('../js/dsp/loudnorm.js');
const { measureLoudness } = await import('../js/dsp/loudness.js');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : fallback; };
const [inPath, outPath] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const target = opt('--target', -14), ceiling = opt('--ceiling', -1);

function readWav(path) {
  const { channels, sampleRate } = readWavChannels(path);
  const buffer = new AudioBuffer({ numberOfChannels: channels.length, length: channels[0].length, sampleRate });
  channels.forEach((ch, c) => buffer.getChannelData(c).set(ch));
  return buffer;
}
function writeWav24(path, buffer) {
  writeChannels24(path, Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)), buffer.sampleRate);
}

const fmt = (m) => `integrated ${m.integrated.toFixed(1)} LUFS · short-term max ${m.shortTermMax.toFixed(1)} · sample peak ${m.samplePeakDb.toFixed(1)} dBFS · true peak ${m.truePeakDb.toFixed(1)} dBTP`;
const input = readWav(inPath);
const before = measureLoudness(input);
console.log(`in : ${(input.length / input.sampleRate).toFixed(1)} s · ${fmt(before)}`);
const mastered = await processLoudnorm(input, { params: { target, ceiling } });
const after = measureLoudness(mastered);
console.log(`out: ${fmt(after)}  (target ${target} LUFS, ceiling ${ceiling} dBTP)`);
writeWav24(outPath, mastered);
console.log('wrote', outPath);
