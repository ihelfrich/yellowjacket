// Node WAV io for the scripts: read PCM 16/24/32-bit and float32 WAVs into
// Float32Array channels; write 24-bit PCM. No dependencies.

import { readFileSync, writeFileSync } from 'node:fs';

/** → { channels: Float32Array[], sampleRate } */
export function readWav(path) {
  const b = readFileSync(path);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV: ' + path);
  let at = 12, fmt = null, data = null;
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4), size = v.getUint32(at + 4, true);
    if (id === 'fmt ') fmt = { format: v.getUint16(at + 8, true), channels: v.getUint16(at + 10, true), rate: v.getUint32(at + 12, true), bits: v.getUint16(at + 22, true) };
    if (id === 'data') data = { start: at + 8, size: Math.min(size, b.length - at - 8) };
    at += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV without fmt/data: ' + path);
  const bytes = fmt.bits / 8, frames = Math.floor(data.size / (bytes * fmt.channels));
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.channels; c++) {
    const p = data.start + (i * fmt.channels + c) * bytes;
    channels[c][i] = fmt.format === 3 ? v.getFloat32(p, true)
      : bytes === 2 ? v.getInt16(p, true) / 32768
      : bytes === 3 ? (((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) << 8) >> 8) / 8388608
      : v.getInt32(p, true) / 2147483648;
  }
  return { channels, sampleRate: fmt.rate };
}

/** Mono mixdown of a readWav result. */
export function monoOf({ channels }) {
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}

/** Write 24-bit PCM. `channels` is an array of Float32Array of equal length. */
export function writeWav24(path, channels, sampleRate) {
  const ch = channels.length, n = channels[0].length, bytes = 3;
  const out = Buffer.alloc(44 + n * ch * bytes);
  out.write('RIFF', 0); out.writeUInt32LE(36 + n * ch * bytes, 4); out.write('WAVE', 8);
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(ch, 22);
  out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * ch * bytes, 28); out.writeUInt16LE(ch * bytes, 32); out.writeUInt16LE(24, 34);
  out.write('data', 36); out.writeUInt32LE(n * ch * bytes, 40);
  let p = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const s = Math.max(-1, Math.min(1, channels[c][i])); const q = Math.round(s * 8388607);
    out[p++] = q & 0xff; out[p++] = (q >> 8) & 0xff; out[p++] = (q >> 16) & 0xff;
  }
  writeFileSync(path, out);
}
