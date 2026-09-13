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

export const PASSBANDS = Object.freeze({
  am: [-4900, 4900], usb: [300, 2700], lsb: [-2700, -300], cw: [300, 900],
});

/**
 * Connect, take the audio, disconnect. Resolves with the samples rather than
 * writing a file, so a scanner can hold a grab in memory and hand it straight
 * to the same decoders the browser uses.
 */
export function recordAudio(host, { freqKHz, mode = 'usb', seconds = 30, timeoutMs = null } = {}) {
  return new Promise((resolve) => {
    const base = String(host).replace(/^https?:\/\//, '');
    const [lowCut, highCut] = PASSBANDS[mode] || PASSBANDS.usb;
    let ws;
    try { ws = new WebSocket(`ws://${base}/ws/kiwi/${Date.now()}/SND`); }
    catch (e) { resolve({ ok: false, error: 'connect: ' + e.message, host: base }); return; }
    ws.binaryType = 'arraybuffer';

    const chunks = [];
    let audioRate = 12000, frames = 0, done = false, refusal = null;
    const send = (s) => { try { ws.send(s); } catch { /* closed */ } };
    const finish = (why) => {
      if (done) return; done = true;
      try { ws.close(); } catch { /* already */ }
      let total = 0; for (const c of chunks) total += c.length;
      if (!total) { resolve({ ok: false, error: refusal || why, host: base, freqKHz: Number(freqKHz), mode }); return; }
      const out = new Float32Array(total);
      let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
      resolve({
        ok: true, host: base, freqKHz: Number(freqKHz), mode, why,
        sampleRate: audioRate, frames, samples: out, seconds: +(total / audioRate).toFixed(1),
      });
    };
    const timer = setTimeout(() => finish('time'), timeoutMs ?? (seconds + 25) * 1000); timer.unref?.();

    ws.onopen = () => {
      send('SET auth t=kiwi p=');
      send('SET ident_user=yellowjacket');
      send('SET AR OK in=12000 out=48000');
      send('SET zoom=0 start=0');
      send(`SET mod=${mode} low_cut=${lowCut} high_cut=${highCut} freq=${Number(freqKHz).toFixed(2)}`);
      send('SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50');
      send('SET compression=0');
      const ka = setInterval(() => send('SET keepalive'), 5000); ka.unref?.();
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') return;
      const buf = new Uint8Array(ev.data);
      const tag = String.fromCharCode(buf[0], buf[1], buf[2]);
      if (tag === 'MSG') {
        const text = new TextDecoder().decode(buf.subarray(4));
        const m = /audio_rate=([\d.]+)/.exec(text) || /sample_rate=([\d.]+)/.exec(text);
        if (m) audioRate = Math.round(Number(m[1]));
        // Only a NON-ZERO value is a refusal. Matching the key alone stopped a
        // recording on "too_busy=0", which means the opposite.
        if (/badp=1|too_busy=[1-9]|rx_chans_busy=[1-9]/.test(text)) { refusal = 'refused: ' + text.slice(0, 90); finish(refusal); }
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
      if (total >= audioRate * seconds) finish('enough');
    };
    ws.onerror = (e) => finish('error: ' + (e && e.message ? e.message : 'socket'));
    ws.onclose = () => finish('closed');
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , host, freqKHz, mode, seconds, outPath] = process.argv;
  const r = await recordAudio(host, { freqKHz, mode, seconds: Number(seconds || 60) });
  if (!r.ok) { console.log(JSON.stringify(r)); process.exit(1); }
  const { samples, ...rest } = r;
  fs.writeFileSync(outPath, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  console.log(JSON.stringify({ ...rest, samples: samples.length, out: outPath }));
}
