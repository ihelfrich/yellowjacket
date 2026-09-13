#!/usr/bin/env node
// Pull a band's spectrum from a public receiver — the wide half of the survey.
//
//   node tools/kiwi-wf.mjs <host> <centreMHz> <spanKHz>
//   node tools/kiwi-wf.mjs g8ure.ddns.net:8073 10 1875
//   node tools/kiwi-wf.mjs g8ure.ddns.net:8073 --whole      all 0-30 MHz at once
//
// Four things this had to learn, on top of the three the audio path needed:
//
//   the path is /ws/kiwi/<ms>/W/F — "no_wf" in the path means "no waterfall",
//     which is what the audio recorder asks for and why it never saw a frame
//   SET zoom must come AFTER maxdb/mindb/wf_speed, or the receiver hangs up
//   a frame is "W/F" + a 12-byte header + exactly wf_fft_size (1024) bytes
//   the byte is dBm + 255 on a scale each receiver calibrates for itself, so
//     only dB ABOVE THE LOCAL FLOOR travels between receivers
//   `start` is ignored on a waterfall socket with no audio channel behind it.
//     Cross-correlating the spectrum at start=0 against start=512 on the same
//     receiver aligns at lag exactly 0: the same window, twice. So the honest
//     capability here is zoom 0 — the whole of 0-30 MHz in one grab, 29.3 kHz
//     per bin — which is what a discovery sweep wants anyway. Anything that
//     needs finer resolution than that goes through the audio path, which has
//     12 kHz of bandwidth at full resolution and has been checked against a
//     wall clock. surveyAt() therefore refuses a span it cannot honour.
//   every frame says which window it belongs to, and you must check it. The
//     server applies a new zoom/start several frames after you ask, so the
//     first frames back still describe the OLD window. Averaging them together
//     silently mixes two parts of the spectrum, which is what made a carrier
//     appear 124 bins low, then 364 high, then 384 low as the span narrowed.
//     x_bin is a little-endian uint32 at offset 4, zoom a uint16 at offset 8.
//   SET wf_comp=0 is required at any zoom above 0. Without it the receiver
//     sends 533-byte ADPCM frames instead of 1040-byte raw ones, and a reader
//     that checks the length simply discards every frame it is sent — 185
//     frames arrived, 185 were thrown away, and the survey reported silence
//
// Verified against known transmitters: zoom 4 start 300 put the medium-wave
// broadcast band exactly where it belongs, and start 5000 put the 31-metre
// band exactly where it belongs.
import { surveySpan } from '../js/sigint/spectrum.js';

export const FFT_BINS = 1024;
export const FULL_SPAN_HZ = 30e6;
export const MAX_ZOOM = 11;   // what receivers advertise; frames are checked anyway

/** Bin width and span at a zoom level. */
export const spanAt = (zoom) => FULL_SPAN_HZ / Math.pow(2, zoom);
export const binHzAt = (zoom) => spanAt(zoom) / FFT_BINS;

/**
 * The zoom and start that put `centreHz` in the middle of a window at least
 * `spanHz` wide. Clamped to the edges of the receiver's coverage, so asking
 * for a window centred on 200 kHz returns the leftmost window rather than a
 * negative start the receiver would refuse.
 */
export function planSpan(centreHz, spanHz) {
  let zoom = 0;
  while (zoom < MAX_ZOOM && spanAt(zoom + 1) >= spanHz) zoom++;
  // Only a window starting at bin 0 is trustworthy — see the header. A window
  // that would need a non-zero start is not available, and saying so beats
  // returning a spectrum of somewhere else.
  const bin = binHzAt(zoom);
  const maxStart = FFT_BINS * Math.pow(2, zoom) - FFT_BINS;
  let start = Math.round((centreHz - spanAt(zoom) / 2) / bin);
  start = Math.max(0, Math.min(maxStart, start));
  return { zoom, start, binHz: bin, leftHz: start * bin, spanHz: spanAt(zoom) };
}

/**
 * Average `frames` waterfall frames from one receiver.
 *
 * Averaging matters: a single frame of a noisy band is mostly variance, and a
 * peak finder run on one frame invents signals. Frames belonging to a window
 * the receiver has not switched to yet are discarded outright rather than
 * waited out by a frame count — the header says which window each frame is
 * from, so there is no need to guess how long the receiver will take.
 */
export function grabSpectrum(host, { zoom = 0, start = 0, frames = 12, timeoutMs = 25000 } = {}) {
  return new Promise((resolve) => {
    const base = String(host).replace(/^https?:\/\//, '');
    let ws;
    try { ws = new WebSocket(`ws://${base}/ws/kiwi/${Date.now()}/W/F`); }
    catch (e) { resolve({ ok: false, error: 'connect: ' + e.message, host: base }); return; }
    ws.binaryType = 'arraybuffer';

    const acc = new Float64Array(FFT_BINS);
    let used = 0, seen = 0, stale = 0, short = 0, done = false, refusal = null;
    const send = (s) => { try { ws.send(s); } catch { /* closed */ } };
    const finish = (why) => {
      if (done) return; done = true;
      try { ws.close(); } catch { /* already */ }
      if (!used) {
        resolve({ ok: false, host: base, framesSeen: seen, stale, short,
          error: refusal || (stale === seen && seen > 0
            ? `receiver served ${seen} frames but never switched to zoom ${zoom} start ${start}`
            : why) });
        return;
      }
      const bins = Array.from(acc, (v) => v / used - 255);   // byte -> dBm
      resolve({ ok: true, host: base, zoom, start, frames: used, stale, bins });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs); timer.unref?.();

    ws.onopen = () => {
      send('SET auth t=kiwi p=');
      send('SET ident_user=yellowjacket');
      send('SET send_dB=1');
      send('SET maxdb=-10 mindb=-134');
      send('SET wf_speed=4');
      send('SET interp=0');
      send('SET wf_comp=0');   // raw bytes, not ADPCM — see header
      send(`SET zoom=${zoom} start=${start}`);   // must come last, see header
      const ka = setInterval(() => send('SET keepalive'), 4000); ka.unref?.();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') return;
      const b = new Uint8Array(ev.data);
      const tag = String.fromCharCode(b[0], b[1], b[2]);
      if (tag === 'MSG') {
        const t = new TextDecoder().decode(b.subarray(4));
        if (/badp=1|too_busy=[1-9]|rx_chans_busy=[1-9]/.test(t)) { refusal = 'refused: ' + t.slice(0, 80); finish(refusal); }
        return;
      }
      if (tag !== 'W/F') return;
      seen++;
      // Which window is this frame actually from? The server lags the request
      // by several frames, and a frame from the old window is not this band.
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const binServer = dv.getUint32(4, true);
      const zoomServer = dv.getUint16(8, true);
      if (zoomServer !== zoom || binServer !== start) { stale++; return; }
      const body = b.subarray(16);
      if (body.length < FFT_BINS) { short++; return; }
      for (let i = 0; i < FFT_BINS; i++) acc[i] += body[i];
      used++;
      if (used >= frames) finish('enough');
    };
    ws.onerror = () => finish('socket error');
    ws.onclose = () => finish(seen ? 'closed early' : 'closed before any frame');
  });
}

/**
 * Grab a span around a centre frequency and read what is on it.
 *
 * Refuses rather than lies when the requested window would need a non-zero
 * start, because the receiver would silently serve a different piece of
 * spectrum and every frequency in the result would be wrong.
 */
export async function surveyAt(host, centreHz, spanHz, opts = {}) {
  const plan = planSpan(centreHz, spanHz);
  if (plan.start !== 0) {
    return { ok: false, host, centreHz, ...plan,
      error: `a window centred on ${(centreHz / 1e6).toFixed(3)} MHz needs start=${plan.start}, and this receiver ignores start; use surveyBand() for the whole spectrum or the audio path for one channel` };
  }
  const grab = await grabSpectrum(host, { zoom: plan.zoom, start: plan.start, ...opts });
  if (!grab.ok) return { ok: false, host, error: grab.error, centreHz, ...plan };
  return {
    ok: true, host, centreHz, ...plan, frames: grab.frames,
    ...surveySpan(grab.bins, { binHz: plan.binHz, leftHz: plan.leftHz, overDb: opts.overDb ?? 8 }),
  };
}

/** The whole of 0-30 MHz in one grab: the verified capability. */
export async function surveyBand(host, opts = {}) {
  return surveyAt(host, FULL_SPAN_HZ / 2, FULL_SPAN_HZ, opts);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , host, a, b] = process.argv;
  if (!host) { console.error('usage: kiwi-wf.mjs <host> <centreMHz> <spanKHz> | <host> --whole'); process.exit(2); }
  const whole = a === '--whole';
  const centreHz = whole ? 15e6 : Number(a) * 1e6;
  const spanHz = whole ? 30e6 : Number(b || 1875) * 1e3;
  const s = await surveyAt(host, centreHz, spanHz);
  if (!s.ok) { console.log(JSON.stringify(s)); process.exit(1); }
  console.log(JSON.stringify({
    host: s.host, leftMHz: +(s.leftHz / 1e6).toFixed(4), rightMHz: +(s.rightHz / 1e6).toFixed(4),
    binHz: Math.round(s.binHz), floorDb: s.floorDb, occupancy: s.occupancy, found: s.emissions.length,
  }));
  for (const e of s.emissions.slice(0, 25)) {
    console.log(`  ${(e.hz / 1e6).toFixed(4)} MHz  +${e.overDb} dB over floor, ${e.prominenceDb} dB prominent, ${(e.widthHz / 1000).toFixed(1)} kHz wide`);
  }
  for (const r of s.busy || []) {
    console.log(`  busy ${(r.fromHz / 1e6).toFixed(3)}-${(r.toHz / 1e6).toFixed(3)} MHz (${(r.widthHz / 1e6).toFixed(2)} MHz continuously occupied)`);
  }
}
