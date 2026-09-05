// Master a take with the bench's own stages, headless: loudness-normalise to a
// target (BS.1770 integrated) with the true-peak limiter at its ceiling, then
// write a 24-bit WAV and print before/after. The DSP is the same code the RACK
// runs in the browser; node only lacks AudioBuffer, so a minimal one is
// installed first.
//
//   node scripts/master-take.mjs in.wav out.wav [--target -14] [--ceiling -1]

import { readFileSync, writeFileSync } from 'node:fs';

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
  const b = readFileSync(path);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV');
  let at = 12, fmt = null, data = null;
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4), size = v.getUint32(at + 4, true);
    if (id === 'fmt ') fmt = { format: v.getUint16(at + 8, true), channels: v.getUint16(at + 10, true), rate: v.getUint32(at + 12, true), bits: v.getUint16(at + 22, true) };
    if (id === 'data') data = { start: at + 8, size };
    at += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV without fmt/data');
  const bytes = fmt.bits / 8, frames = Math.floor(data.size / (bytes * fmt.channels));
  const buffer = new AudioBuffer({ numberOfChannels: fmt.channels, length: frames, sampleRate: fmt.rate });
  for (let c = 0; c < fmt.channels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < frames; i++) {
      const p = data.start + (i * fmt.channels + c) * bytes;
      ch[i] = fmt.format === 3 ? v.getFloat32(p, true)
        : bytes === 2 ? v.getInt16(p, true) / 32768
        : bytes === 3 ? ((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) << 8 >> 8) / 8388608
        : v.getInt32(p, true) / 2147483648;
    }
  }
  return buffer;
}

function writeWav24(path, buffer) {
  const ch = buffer.numberOfChannels, n = buffer.length, bytes = 3;
  const out = Buffer.alloc(44 + n * ch * bytes);
  out.write('RIFF', 0); out.writeUInt32LE(36 + n * ch * bytes, 4); out.write('WAVE', 8);
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(ch, 22);
  out.writeUInt32LE(buffer.sampleRate, 24); out.writeUInt32LE(buffer.sampleRate * ch * bytes, 28); out.writeUInt16LE(ch * bytes, 32); out.writeUInt16LE(24, 34);
  out.write('data', 36); out.writeUInt32LE(n * ch * bytes, 40);
  let p = 44;
  const chans = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const s = Math.max(-1, Math.min(1, chans[c][i])); const q = Math.round(s * 8388607);
    out[p++] = q & 0xff; out[p++] = (q >> 8) & 0xff; out[p++] = (q >> 16) & 0xff;
  }
  writeFileSync(path, out);
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
