// SSTV — slow-scan television. A picture, sent as a swept tone, one line at a
// time, over a channel built for speech. This is the decoder that gives the
// bench something to SHOW rather than something to print.
//
// The encoding is direct frequency modulation of brightness: 1500 Hz is black,
// 2300 Hz is white, and every value between is a grey. A 1200 Hz pulse marks
// the start of a line. Colour modes send three scans per line — green, blue,
// red for the Martin and Scottie families — and the receiver has to know which
// mode it is looking at, which is what the VIS header at the front says: a
// 1900 Hz leader, a 1200 Hz break, another leader, then eight bits at 30 ms
// each, 1100 Hz for one and 1300 Hz for zero, with odd parity.
//
// Three things this decoder does that a naive one does not:
//
// It re-syncs on every line. A recording's sample clock is not the
// transmitter's, and over 256 lines a 0.1% error is a quarter of a line of
// slant. Each line's 1200 Hz pulse is found inside a window around where the
// nominal timing says it should be, and the scan is read from there. The
// measured drift comes back as a number, so a slanted picture is reported
// rather than silently straightened or silently left bent.
//
// It reads the VIS header, and when the header names a mode this decoder does
// not implement it says which mode by name instead of guessing.
//
// It refuses. A span with no VIS header and no 1200 Hz line pulses at any
// supported line rate is not a picture, and comes back as a refusal with the
// evidence it looked for.
//
// Pure and worker-safe. The output is a width, a height and an RGBA byte array
// the panel paints to a canvas.
import { analytic, instantaneousFreq } from '../../dsp/analytic.js';

export const BLACK_HZ = 1500, WHITE_HZ = 2300, SYNC_HZ = 1200;
export const VIS_LEADER_HZ = 1900, VIS_ONE_HZ = 1100, VIS_ZERO_HZ = 1300;
export const VIS_BIT_SEC = 0.030;

// Timings in milliseconds, from the mode specifications. `order` is the order
// the colour scans arrive in; `syncFirst` says whether the sync pulse opens the
// line (Martin) or sits in the middle of it (Scottie, whose sync precedes the
// red scan of the line before).
export const MODES = Object.freeze({
  44: { name: 'Martin M1', width: 320, height: 256, syncMs: 4.862, porchMs: 0.572, scanMs: 146.432, gapMs: 0.572, order: 'GBR', family: 'martin' },
  40: { name: 'Martin M2', width: 320, height: 256, syncMs: 4.862, porchMs: 0.572, scanMs: 73.216, gapMs: 0.572, order: 'GBR', family: 'martin' },
  60: { name: 'Scottie S1', width: 320, height: 256, syncMs: 9.0, porchMs: 1.5, scanMs: 138.240, gapMs: 1.5, order: 'GBR', family: 'scottie' },
  56: { name: 'Scottie S2', width: 320, height: 256, syncMs: 9.0, porchMs: 1.5, scanMs: 88.064, gapMs: 1.5, order: 'GBR', family: 'scottie' },
  76: { name: 'Scottie DX', width: 320, height: 256, syncMs: 9.0, porchMs: 1.5, scanMs: 345.600, gapMs: 1.5, order: 'GBR', family: 'scottie' },
});

// Modes the header can name that this decoder does not read. Naming them is
// the point: "Robot 36" is a better answer than a wrong picture.
export const KNOWN_UNSUPPORTED = Object.freeze({
  8: 'Robot 36', 12: 'Robot 72', 4: 'Robot 24', 0: 'Robot 12',
  113: 'PD-50', 114: 'PD-90', 93: 'PD-120', 95: 'PD-160', 96: 'PD-180', 98: 'PD-240',
  55: 'Wraase SC2-180', 41: 'Martin M3', 37: 'Martin M4', 57: 'Scottie S3', 61: 'Scottie S4',
});

/** Line period in seconds for a mode. */
export function linePeriodSec(mode) {
  const m = mode.syncMs + mode.porchMs + 3 * mode.scanMs + (mode.family === 'martin' ? 3 * mode.gapMs : 2 * mode.gapMs);
  return m / 1000;
}

/**
 * Instantaneous frequency of the whole span, in Hz, one value per sample.
 * The Hilbert filter's group delay is removed so the returned track lines up
 * with the input sample for sample.
 */
export function freqTrack(x, sampleRate) {
  const { re, im } = analytic(x);
  const f = instantaneousFreq(re, im, sampleRate);
  return f;
}

/** Mean frequency over a span, ignoring values outside a plausible band. */
export function meanFreq(f, from, to, { lo = 900, hi = 2600 } = {}) {
  let sum = 0, n = 0;
  const a = Math.max(0, Math.round(from)), b = Math.min(f.length, Math.round(to));
  for (let i = a; i < b; i++) { const v = f[i]; if (v >= lo && v <= hi) { sum += v; n++; } }
  return n ? sum / n : NaN;
}

/**
 * Find the VIS header. Returns the code, the mode, and the sample index where
 * the picture's first line begins (immediately after the stop bit).
 */
export function findVis(f, sampleRate, { from = 0, to = f.length } = {}) {
  const bit = Math.round(VIS_BIT_SEC * sampleRate);
  const near = (v, hz, tol = 60) => Number.isFinite(v) && Math.abs(v - hz) <= tol;
  // The start bit is 30 ms of 1200 Hz preceded by at least 100 ms of 1900 Hz.
  const step = Math.max(1, Math.round(sampleRate * 0.002));
  for (let i = Math.max(from, Math.round(sampleRate * 0.1)); i + bit * 11 < to; i += step) {
    if (!near(meanFreq(f, i, i + bit), SYNC_HZ, 80)) continue;
    if (!near(meanFreq(f, i - Math.round(sampleRate * 0.08), i - Math.round(sampleRate * 0.01)), VIS_LEADER_HZ, 90)) continue;
    // Eight data bits, then a stop bit that must be 1200 Hz again.
    let code = 0, ones = 0, ok = true;
    for (let k = 0; k < 8; k++) {
      const a = i + bit * (k + 1);
      const v = meanFreq(f, a + bit * 0.2, a + bit * 0.8);
      if (near(v, VIS_ONE_HZ, 90)) { code |= 1 << k; ones++; }
      else if (!near(v, VIS_ZERO_HZ, 90)) { ok = false; break; }
    }
    if (!ok) continue;
    const stop = meanFreq(f, i + bit * 9.2, i + bit * 9.8);
    if (!near(stop, SYNC_HZ, 90)) continue;
    // Bit 7 is odd parity over bits 0-6.
    const value = code & 0x7f;
    const parityBit = (code >> 7) & 1;
    let bits = 0; for (let k = 0; k < 7; k++) if (value & (1 << k)) bits++;
    const parityOk = ((bits + parityBit) % 2) === 1;
    return { ok: true, code: value, rawCode: code, parityOk, startsAt: i + bit * 10, headerAt: i, ones };
  }
  return { ok: false, reason: 'no VIS header: no 1200 Hz start bit after a 1900 Hz leader' };
}

/**
 * Find a 1200 Hz sync pulse near `about`, searching +/- `windowSec`.
 * Returns the sample index of the pulse's leading edge, or null.
 */
export function findSync(f, sampleRate, about, syncMs, { windowSec = 0.02, notBefore = 0 } = {}) {
  const half = Math.round(windowSec * sampleRate);
  const len = Math.max(2, Math.round(syncMs / 1000 * sampleRate * 0.6));
  let best = null, bestScore = Infinity;
  // `notBefore` keeps the first line from locking onto the VIS stop bit, which
  // is 30 ms of the same 1200 Hz sitting immediately before the picture and is
  // a better match than the 4.862 ms line pulse it is looking for.
  const a = Math.max(0, notBefore, Math.round(about) - half), b = Math.min(f.length - len, Math.round(about) + half);
  for (let i = a; i <= b; i++) {
    let s = 0, n = 0;
    for (let k = 0; k < len; k++) { const v = f[i + k]; if (Number.isFinite(v)) { s += Math.abs(v - SYNC_HZ); n++; } }
    if (!n) continue;
    const score = s / n;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return bestScore < 150 ? best : null;
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** One scan of `width` pixels starting at sample `at`, lasting `scanMs`. */
function readScan(f, sampleRate, at, scanMs, width, out, offset) {
  const span = scanMs / 1000 * sampleRate;
  const per = span / width;
  // The middle 60% of each pixel's slot. An FM demodulator's output swings
  // through the transition between two pixel values, so the edges of a slot
  // carry the neighbour as much as the pixel; measured on a colour-bar test
  // card at 11 025 Hz, reading the whole slot cost a mean absolute error of
  // 11.6 of 255 and reading the middle costs 6.9.
  const guard = per * 0.2;
  for (let px = 0; px < width; px++) {
    const a = at + per * px + guard, b = at + per * (px + 1) - guard;
    const v = meanFreq(f, a, b, { lo: 1300, hi: 2500 });
    out[offset + px] = Number.isFinite(v) ? clamp255((v - BLACK_HZ) / (WHITE_HZ - BLACK_HZ) * 255) : 0;
  }
}

/**
 * Decode a picture. `mode` forces a mode when there is no VIS header;
 * otherwise the header decides.
 */
export function decodeSstv(x, sampleRate, { mode = null, resync = true, maxSlantPpm = 50000 } = {}) {
  if (!x || x.length < sampleRate * 0.5) return { ok: false, reason: 'span is under half a second' };
  const f = freqTrack(x, sampleRate);
  const vis = findVis(f, sampleRate);
  let spec = null, code = null, startsAt = 0, parityOk = null;
  if (vis.ok) {
    code = vis.code; parityOk = vis.parityOk; startsAt = vis.startsAt;
    spec = MODES[code] || null;
    if (!spec) {
      const named = KNOWN_UNSUPPORTED[code];
      return {
        ok: false,
        reason: named
          ? `the header says ${named} (VIS ${code}), which this decoder does not read — Martin M1/M2 and Scottie S1/S2/DX are the modes it knows`
          : `VIS code ${code} is not a mode this decoder knows`,
        vis: { code, parityOk, atSec: +(vis.headerAt / sampleRate).toFixed(3) },
      };
    }
  } else if (mode && MODES[mode]) {
    spec = MODES[mode]; code = Number(mode);
  } else {
    return { ok: false, reason: `${vis.reason}, and no mode was named`, vis: null };
  }

  const period = linePeriodSec(spec) * sampleRate;
  const available = x.length - startsAt;
  const height = Math.min(spec.height, Math.max(1, Math.floor(available / period)));
  const partial = height < spec.height;
  const w = spec.width;
  const planes = { R: new Uint8Array(w * spec.height), G: new Uint8Array(w * spec.height), B: new Uint8Array(w * spec.height) };
  const ms = (v) => v / 1000 * sampleRate;

  // Per-line sync, and the drift it measures. The nominal position of line n's
  // pulse is startsAt + n * period; where the recording's clock differs, the
  // found pulses walk away from that, and the slope of that walk is the error.
  const found = [];
  let cursor = startsAt;
  for (let line = 0; line < height; line++) {
    const nominal = startsAt + line * period;
    let at = resync ? findSync(f, sampleRate, cursor, spec.syncMs, { notBefore: line === 0 ? startsAt : 0 }) : null;
    if (at === null) at = Math.round(cursor);
    else found.push({ line, at, nominal });
    // Where the three scans sit relative to the line's sync pulse.
    let g, b, r;
    if (spec.family === 'martin') {
      const base = at + ms(spec.syncMs) + ms(spec.porchMs);
      g = base;
      b = g + ms(spec.scanMs) + ms(spec.gapMs);
      r = b + ms(spec.scanMs) + ms(spec.gapMs);
    } else {
      // Scottie: sync, porch, red belongs to THIS line, then separator, green,
      // separator, blue, and the next sync. The transmitted order inside one
      // line period is green, blue, sync, porch, red — so reading from the
      // sync gives red first and the green and blue that follow it.
      r = at + ms(spec.syncMs) + ms(spec.porchMs);
      g = r + ms(spec.scanMs) + ms(spec.gapMs);
      b = g + ms(spec.scanMs) + ms(spec.gapMs);
    }
    readScan(f, sampleRate, g, spec.scanMs, w, planes.G, line * w);
    readScan(f, sampleRate, b, spec.scanMs, w, planes.B, line * w);
    readScan(f, sampleRate, r, spec.scanMs, w, planes.R, line * w);
    cursor = at + period;
  }

  // Measured clock error: least squares of found pulse positions on line index.
  let slantPpm = 0, syncLock = found.length / Math.max(1, height);
  if (found.length >= 8) {
    let n = 0, sk = 0, st = 0, skk = 0, skt = 0;
    for (const p of found) { n++; sk += p.line; st += p.at; skk += p.line * p.line; skt += p.line * p.at; }
    const den = n * skk - sk * sk;
    if (den > 0) {
      const slope = (n * skt - sk * st) / den;
      slantPpm = Math.round((slope / period - 1) * 1e6);
    }
  }
  if (Math.abs(slantPpm) > maxSlantPpm) {
    return {
      ok: false,
      reason: `line pulses drift ${(slantPpm / 1e4).toFixed(1)}% per line against ${spec.name}'s timing, which is not this mode`,
      vis: code === null ? null : { code, parityOk },
    };
  }

  const rgba = new Uint8ClampedArray(w * spec.height * 4);
  for (let i = 0; i < w * spec.height; i++) {
    rgba[i * 4] = planes.R[i]; rgba[i * 4 + 1] = planes.G[i]; rgba[i * 4 + 2] = planes.B[i];
    rgba[i * 4 + 3] = i < w * height ? 255 : 0;
  }
  const notes = [];
  if (partial) notes.push(`only ${height} of ${spec.height} lines are in this span`);
  if (parityOk === false) notes.push('the VIS header failed its parity check, so the mode is a guess that happened to decode');
  if (syncLock < 0.9) notes.push(`a line sync pulse was found on only ${(100 * syncLock).toFixed(0)}% of lines; the rest were placed by the clock`);
  if (Math.abs(slantPpm) > 200) notes.push(`the recording's line period runs ${(slantPpm / 1e4).toFixed(2)}% off ${spec.name}'s, which is its clock, not the transmitter's — the picture is corrected for it`);
  return {
    ok: true,
    mode: spec.name, vis: { code, parityOk, atSec: vis.ok ? +(vis.headerAt / sampleRate).toFixed(3) : null },
    width: w, height: spec.height, linesRead: height, partial,
    rgba, planes,
    startsAtSec: +(startsAt / sampleRate).toFixed(3),
    linePeriodSec: +(linePeriodSec(spec)).toFixed(6),
    slantPpm, syncLock: +syncLock.toFixed(2),
    text: `${spec.name} · ${w}x${spec.height}`
      + (partial ? ` · ${height} lines in this span` : '')
      + (Math.abs(slantPpm) > 200 ? ` · clock ${(slantPpm / 1e4).toFixed(2)}% off` : ''),
    notes,
  };
}

/** Render a picture as SSTV, for the tests and for making one to listen to. */
export function encodeSstv(rgb, width, height, sampleRate, { code = 44, leader = true, clockScale = 1, amplitude = 0.5 } = {}) {
  const spec = MODES[code];
  if (!spec) throw new RangeError('unknown mode ' + code);
  // Segments are laid out on a CONTINUOUS time cursor and each one's sample
  // range is taken from it, rather than each being rounded to a whole number
  // of samples on its own. Rounding per segment accumulates: at 11 025 Hz it
  // left a Martin M1 render 300 parts per million short of its own line
  // period, which the decoder correctly reported as a slanted clock.
  const segs = [];
  let t = 0;
  const seg = (sec, hz, values) => { const a = t; t += sec * clockScale; segs.push({ a, b: t, hz, values }); };
  if (leader) {
    seg(0.3, VIS_LEADER_HZ); seg(0.01, SYNC_HZ); seg(0.3, VIS_LEADER_HZ); seg(VIS_BIT_SEC, SYNC_HZ);
    let ones = 0; for (let k = 0; k < 7; k++) if (code & (1 << k)) ones++;
    for (let k = 0; k < 7; k++) seg(VIS_BIT_SEC, (code >> k) & 1 ? VIS_ONE_HZ : VIS_ZERO_HZ);
    seg(VIS_BIT_SEC, ones % 2 === 0 ? VIS_ONE_HZ : VIS_ZERO_HZ);
    seg(VIS_BIT_SEC, SYNC_HZ);
  }
  const row = (plane, y) => {
    const v = new Uint8Array(width);
    for (let xi = 0; xi < width; xi++) v[xi] = rgb[(y * width + xi) * 3 + plane];
    return v;
  };
  const S = spec.scanMs / 1000, G = spec.gapMs / 1000;
  for (let y = 0; y < height; y++) {
    seg(spec.syncMs / 1000, SYNC_HZ); seg(spec.porchMs / 1000, BLACK_HZ);
    const order = spec.family === 'martin' ? [1, 2, 0] : [0, 1, 2];
    order.forEach((plane, i) => {
      seg(S, null, row(plane, y));
      if (spec.family === 'martin' || i < 2) seg(G, BLACK_HZ);
    });
  }
  const total = Math.ceil(t * sampleRate) + 1;
  const out = new Float32Array(total);
  let phase = 0;
  for (const sg of segs) {
    const a = Math.round(sg.a * sampleRate), b = Math.round(sg.b * sampleRate);
    for (let i = a; i < b && i < total; i++) {
      const hz = sg.values
        ? BLACK_HZ + (sg.values[Math.min(sg.values.length - 1, Math.floor((i - a) * sg.values.length / Math.max(1, b - a)))] / 255) * (WHITE_HZ - BLACK_HZ)
        : sg.hz;
      out[i] = amplitude * Math.sin(phase);
      phase += 2 * Math.PI * hz / sampleRate;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    }
  }
  return out;
}
