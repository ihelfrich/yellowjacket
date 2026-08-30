// Yellowjacket — exporters. WAV PCM encode, transcript text and caption
// formats, original-to-edited timeline mapping, object-URL download.
// Word times are seconds on the ORIGINAL buffer; editedTime() maps them onto
// the spliced timeline when cuts are applied.

const MAX_LINE = 42;   // caption chars per line
const SEG_GAP = 0.8;   // gaps at least this long always end a caption segment
const SOFT_GAP = 0.35; // shorter gaps only *prefer* a line break
const SOFT_MIN = 24;   // no preferred break on a line shorter than this
const PARA_GAP = 2;    // txt paragraph break on gaps over this
const MIN_CUE = 0.3;   // shortest caption emitted, seconds
const SENT_END = /[.!?…]["»”’)\]]*$/;
const CLAUSE_END = /[,;:.!?…]["»”’)\]]*$/;

// ---------- WAV ----------

const DITHER_SEED = 0x59454C4F; // fixed seed: identical input -> byte-identical WAV
// 9-tap F-weighted noise-shaping FIR (Lipshitz/Wannamaker F-weighting),
// coefficients from SoX src/dither.c `fwe44` (Shape_f_weighted). Designed near
// 44.1 kHz; applied at 44.1k and 48k where the weighting curve still holds.
const F_WEIGHTED_9 = [2.412, -3.370, 3.937, -4.174, 3.353, -2.205, 1.281, -0.569, 0.0847];

// mulberry32: tiny deterministic PRNG, uniform in [0, 1)
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 24-bit never dithers: its noise floor sits below any real source noise.
// The F-weighted curve is rate-specific, so shaping only runs at 44.1k/48k;
// other rates fall back to plain TPDF.
function resolveDither(bits, sampleRate, requested) {
  if (bits === 24) return 'none';
  if (requested === 'none' || requested === 'tpdf') return requested;
  return sampleRate === 44100 || sampleRate === 48000 ? 'shaped' : 'tpdf';
}

export function encodeWav(buffer, bitDepth = 16) {
  return encodeWavWithStats(buffer, bitDepth).blob;
}

// opts.dither: 'shaped' | 'tpdf' | 'none' (default: shaped at 44.1k/48k, else tpdf).
// stats.clippedSamples counts PRE-quantization overs (|s| > 1); the encoded
// stream still clamps them. stats.peakDb is the pre-quantization sample peak.
export function encodeWavWithStats(buffer, bitDepth = 16, opts = {}) {
  const bits = bitDepth === 32 ? 32 : bitDepth === 24 ? 24 : 16;
  const isFloat = bits === 32;
  const srcChannels = buffer && buffer.numberOfChannels ? buffer.numberOfChannels : 0;
  const channels = Math.max(1, srcChannels);
  const frames = srcChannels ? buffer.length : 0;
  const sampleRate = Math.max(1, Math.round(buffer && buffer.sampleRate ? buffer.sampleRate : 44100));
  const bytesPer = bits / 8;
  const blockAlign = channels * bytesPer;
  const dataSize = frames * blockAlign;
  // Float carries no quantization error, so there is nothing for dither to
  // decorrelate. resolveDither is only consulted for the integer depths.
  const dither = isFloat ? 'none' : resolveDither(bits, sampleRate, opts.dither);

  // A non-PCM format must declare cbSize, and a 'fact' chunk states the frame
  // count. 16-byte-fmt float files are common and mostly readable, but the
  // spec-correct header costs 14 bytes and removes the doubt entirely.
  const fmtSize = isFloat ? 18 : 16;
  const factSize = isFloat ? 12 : 0;
  const headerSize = 20 + fmtSize + factSize + 8;
  const ab = new ArrayBuffer(headerSize + dataSize);
  const dv = new DataView(ab);
  writeAscii(dv, 0, 'RIFF');
  dv.setUint32(4, headerSize - 8 + dataSize, true);
  writeAscii(dv, 8, 'WAVE');
  writeAscii(dv, 12, 'fmt ');
  dv.setUint32(16, fmtSize, true);
  dv.setUint16(20, isFloat ? 3 : 1, true);   // 3 = WAVE_FORMAT_IEEE_FLOAT
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bits, true);
  let at = 36;
  if (isFloat) {
    dv.setUint16(at, 0, true);               // cbSize: no extension follows
    at += 2;
    writeAscii(dv, at, 'fact');
    dv.setUint32(at + 4, 4, true);
    dv.setUint32(at + 8, frames, true);
    at += 12;
  }
  writeAscii(dv, at, 'data');
  dv.setUint32(at + 4, dataSize, true);

  const chans = [];
  for (let c = 0; c < srcChannels; c++) chans.push(buffer.getChannelData(c));
  let peak = 0;
  let clipped = 0;
  let off = headerSize;
  if (isFloat) {
    // No clamp: preserving overs is the entire reason to export float, so a
    // hot bounce can still be pulled back down in the next tool. Overs are
    // still counted, because the meter should say so.
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < srcChannels; c++) {
        const s = chans[c][f];
        const a = s < 0 ? -s : s;
        if (a > peak) peak = a;
        if (a > 1) clipped++;
        dv.setFloat32(off, s, true);
        off += 4;
      }
    }
  } else if (bits === 16) {
    const rand = mulberry32(DITHER_SEED);
    const tpdf = dither !== 'none';
    const shaped = dither === 'shaped';
    const hist = shaped ? chans.map(() => new Float64Array(9)) : null;
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < srcChannels; c++) {
        let s = chans[c][f];
        const a = s < 0 ? -s : s;
        if (a > peak) peak = a;
        if (a > 1) { clipped++; s = s < 0 ? -1 : 1; }
        let v = s < 0 ? s * 0x8000 : s * 0x7FFF;
        let e;
        if (shaped) {
          // error feedback w = x - sum(c_k * e[n-k]): noise transfer 1 - C(z)
          e = hist[c];
          let fb = 0;
          for (let k = 0; k < 9; k++) fb += F_WEIGHTED_9[k] * e[k];
          v -= fb;
        }
        // TPDF at +/-1 LSB: sum of two independent uniforms, dither inside
        // the loop (Lipshitz/Wannamaker/Vanderkooy, JAES 1992)
        const q = Math.round(tpdf ? v + rand() + rand() - 1 : v);
        if (shaped) {
          for (let k = 8; k > 0; k--) e[k] = e[k - 1];
          e[0] = q - v; // pre-clamp error: bounded feedback, stable at full scale
        }
        dv.setInt16(off, q < -0x8000 ? -0x8000 : q > 0x7FFF ? 0x7FFF : q, true);
        off += 2;
      }
    }
  } else {
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < srcChannels; c++) {
        let s = chans[c][f];
        const a = s < 0 ? -s : s;
        if (a > peak) peak = a;
        if (a > 1) { clipped++; s = s < 0 ? -1 : 1; }
        // two's complement 24-bit little-endian
        const v = Math.round(s < 0 ? s * 0x800000 : s * 0x7FFFFF) & 0xFFFFFF;
        dv.setUint8(off, v & 0xFF);
        dv.setUint8(off + 1, (v >>> 8) & 0xFF);
        dv.setUint8(off + 2, (v >>> 16) & 0xFF);
        off += 3;
      }
    }
  }
  return {
    blob: new Blob([ab], { type: 'audio/wav' }),
    stats: {
      peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
      clippedSamples: clipped,
      dither,
    },
  };
}

// ---------- timeline mapping ----------

// Maps an ORIGINAL-timeline time onto the edited (spliced) timeline by
// subtracting all cut time before t. Times inside a cut clamp to the cut's
// start. Assumes cuts sorted and non-overlapping (the Cut invariant).
export function editedTime(t, cuts) {
  if (!Array.isArray(cuts) || !cuts.length) return Math.max(0, t);
  let removed = 0;
  for (const c of cuts) {
    if (t <= c.start) break;
    if (t < c.end) return Math.max(0, c.start - removed);
    removed += c.end - c.start;
  }
  return Math.max(0, t - removed);
}

// ---------- transcript text ----------

export function toTxt(words, opts = {}) {
  const list = keptWords(words, !!opts.skipDeleted);
  if (!list.length) return '';
  let out = list[0].text;
  for (let i = 1; i < list.length; i++) {
    const gap = list[i].start - list[i - 1].end;
    out += (gap > PARA_GAP ? '\n\n' : ' ') + list[i].text;
  }
  return out + '\n';
}

export function toSrt(words, opts = {}) {
  const cues = buildCues(words, opts);
  let out = '';
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    out += (i + 1) + '\n'
      + stamp(c.start, ',') + ' --> ' + stamp(c.end, ',') + '\n'
      + c.lines.join('\n') + '\n\n';
  }
  return out;
}

export function toVtt(words, opts = {}) {
  const cues = buildCues(words, opts);
  let out = 'WEBVTT\n\n';
  for (const c of cues) {
    out += stamp(c.start, '.') + ' --> ' + stamp(c.end, '.') + '\n'
      + c.lines.join('\n') + '\n\n';
  }
  return out;
}

// ---------- download ----------

export function download(data, filename, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'export';
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- caption grouping ----------

function keptWords(words, skipDeleted) {
  const out = [];
  for (const w of Array.isArray(words) ? words : []) {
    if (!w || typeof w.text !== 'string' || !w.text.length) continue;
    if (skipDeleted && w.deleted) continue;
    out.push(w);
  }
  return out;
}

// Groups kept words into cues of <= 2 lines, <= 42 chars each, breaking at
// sentence punctuation and long gaps first. Cue times come from the first and
// last word in the cue, retimed through editedTime when skipDeleted + cuts.
function buildCues(words, opts) {
  const skipDeleted = !!(opts && opts.skipDeleted);
  const kept = keptWords(words, skipDeleted);
  if (!kept.length) return [];

  // hard segments: sentence enders and long gaps
  const segs = [];
  let seg = [];
  for (let i = 0; i < kept.length; i++) {
    const w = kept[i];
    seg.push(w);
    const next = kept[i + 1];
    const gap = next ? next.start - w.end : 0;
    if (!next || SENT_END.test(w.text) || gap >= SEG_GAP) {
      segs.push(seg);
      seg = [];
    }
  }

  const cues = [];
  for (const s of segs) {
    const lines = wrapLines(s);
    for (let i = 0; i < lines.length; i += 2) {
      const pair = lines.slice(i, i + 2);
      cues.push({
        lines: pair.map((l) => l.text),
        start: pair[0].start,
        end: pair[pair.length - 1].end,
      });
    }
  }

  const cuts = opts && opts.cuts;
  if (skipDeleted && Array.isArray(cuts) && cuts.length) {
    for (const c of cues) {
      c.start = editedTime(c.start, cuts);
      c.end = editedTime(c.end, cuts);
    }
  }

  // sane, monotonic timing
  let prevEnd = 0;
  for (const c of cues) {
    if (c.start < prevEnd) c.start = prevEnd;
    if (c.end < c.start + MIN_CUE) c.end = c.start + MIN_CUE;
    prevEnd = c.end;
  }
  return cues;
}

// Greedy wrap to MAX_LINE chars, but when the rest of the segment cannot fit
// on the current line anyway, prefer to break after clause punctuation or an
// audible pause instead of mid-clause.
function wrapLines(seg) {
  const n = seg.length;
  const remaining = new Array(n + 1).fill(0); // chars of words i..end joined by spaces
  for (let i = n - 1; i >= 0; i--) {
    remaining[i] = seg[i].text.length + (remaining[i + 1] ? remaining[i + 1] + 1 : 0);
  }
  const lines = [];
  let text = '';
  let start = 0;
  let end = 0;
  let open = false;
  for (let i = 0; i < n; i++) {
    const w = seg[i];
    if (!open) {
      text = w.text; start = w.start; end = w.end; open = true;
    } else if (text.length + 1 + w.text.length <= MAX_LINE) {
      text += ' ' + w.text;
      end = w.end;
    } else {
      lines.push({ text, start, end });
      text = w.text; start = w.start; end = w.end;
    }
    const next = seg[i + 1];
    if (next && text.length >= SOFT_MIN) {
      const roomLeft = MAX_LINE - text.length - 1;
      const restFits = remaining[i + 1] <= roomLeft;
      const gap = next.start - w.end;
      if (!restFits && (CLAUSE_END.test(w.text) || gap >= SOFT_GAP)) {
        lines.push({ text, start, end });
        open = false;
      }
    }
  }
  if (open) lines.push({ text, start, end });
  return lines;
}

// ---------- small helpers ----------

function writeAscii(dv, off, s) {
  for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
}

function stamp(t, msSep) {
  const ms = Math.max(0, Math.round((isFinite(t) ? t : 0) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return pad2(h) + ':' + pad2(m) + ':' + pad2(s) + msSep + String(ms % 1000).padStart(3, '0');
}

function pad2(v) {
  return String(v).padStart(2, '0');
}
