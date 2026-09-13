#!/usr/bin/env node
// Record live audio from a public KiwiSDR.
//
//   node tools/kiwi-record.mjs <host> <kHz> <am|usb|lsb|cw> <seconds> <out.f32>
//   node tools/kiwi-record.mjs http://bikedork.myddns.me:8073 10000 am 190 wwv.f32
//
// The receiver list is at http://rx.linkfanel.net/kiwisdr_com.js — around 800
// are online at any time, run by volunteers with a handful of slots each. One
// connection, the audio you need, then disconnect. Reconnecting immediately to
// the same receiver gets the next session cut short, which is the receiver
// telling you something.
//
// Output is raw float32 mono at the rate the receiver reports, usually 12 kHz.
// Three things this had to learn the hard way, all in the protocol:
//
//   the WebSocket path is /ws/kiwi/<ms timestamp>/SND, not /<seconds>/SND
//   "too_busy=0" means NOT busy, so matching the key alone stops every session
//   the audio arrives as big-endian int16 after an 8-byte header
import fs from 'node:fs';

const [, , host, freqKHz, mode, seconds, outPath] = process.argv;
const SECS = Number(seconds || 60);
const ts = Date.now();
const base = host.replace(/^https?:\/\//, '');
const url = `ws://${base}/ws/no_wf/${ts}/SND`;

const lowCut = mode === 'am' ? -4900 : (mode === 'lsb' ? -2700 : 300);
const highCut = mode === 'am' ? 4900 : (mode === 'lsb' ? -300 : 2700);

const chunks = [];
let audioRate = 12000, gotRate = false, frames = 0;
let done = false;

const ws = new WebSocket(url);
ws.binaryType = 'arraybuffer';

const send = (s) => { try { ws.send(s); } catch (e) { /* closed */ } };

const finish = (why) => {
  if (done) return;
  done = true;
  try { ws.close(); } catch (e) { /* already */ }
  let total = 0; for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  fs.writeFileSync(outPath, Buffer.from(out.buffer, out.byteOffset, out.byteLength));
  console.log(JSON.stringify({ ok: total > 0, why, host: base, freqKHz: Number(freqKHz), mode, audioRate, frames, samples: total, seconds: +(total / audioRate).toFixed(1), out: outPath }));
  process.exit(total > 0 ? 0 : 1);
};

const timer = setTimeout(() => finish('time'), (SECS + 25) * 1000);
timer.unref?.();

ws.onopen = () => {
  send('SET auth t=kiwi p=');
  send('SET ident_user=yellowjacket');
  send('SET AR OK in=12000 out=48000');
  send('SET zoom=0 start=0');
  send(`SET mod=${mode} low_cut=${lowCut} high_cut=${highCut} freq=${Number(freqKHz).toFixed(2)}`);
  send('SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50');
  send('SET compression=0');
  setInterval(() => send('SET keepalive'), 5000).unref?.();
};

ws.onmessage = (ev) => {
  if (typeof ev.data === 'string') return;
  const buf = new Uint8Array(ev.data);
  const tag = String.fromCharCode(buf[0], buf[1], buf[2]);
  if (tag === 'MSG') {
    const text = new TextDecoder().decode(buf.subarray(4));
    const m = /audio_rate=([\d.]+)/.exec(text) || /sample_rate=([\d.]+)/.exec(text);
    if (m) { audioRate = Math.round(Number(m[1])); gotRate = true; }
    // Only a NON-ZERO value is a refusal. Matching the key alone stopped a
    // recording on "too_busy=0", which means the opposite.
    if (/badp=1|too_busy=[1-9]|rx_chans_busy=[1-9]/.test(text)) finish('refused: ' + text.slice(0, 90));
    return;
  }
  if (tag !== 'SND') return;
  // "SND" + flags(1) + seq(4) + int16 big-endian samples
  const dv = new DataView(buf.buffer, buf.byteOffset + 8, buf.byteLength - 8);
  const n = Math.floor(dv.byteLength / 2);
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = dv.getInt16(i * 2, false) / 32768;
  chunks.push(f);
  frames++;
  let total = 0; for (const c of chunks) total += c.length;
  if (total >= audioRate * SECS) finish('enough');
};

ws.onerror = (e) => finish('error: ' + (e && e.message ? e.message : 'socket'));
ws.onclose = () => finish('closed');
