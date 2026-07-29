// Yellowjacket — OP-1/OP-Z drum patch writer + reader.
// Every byte-layout fact here (chunk shapes, fixed-point rule, JSON schema)
// comes from docs/CONTRACT-WIRE.md §1, verified against a factory patch and
// the teoperator/libop1 writers. Do not re-derive them.
// Pure module: no DOM, no Web Audio; importable in node and workers.

export const PATCH_RATE = 44100;
export const PATCH_MAX_FRAMES = 529200; // 12 s at 44100
export const PATCH_SLOTS = 24;

const POSITION_MAX = 2147483646;
const FADE_FRAMES = 88; // 2 ms at 44100
// 80-bit IEEE extended 44100.0, byte-exact per contract
const RATE_44100_EXTENDED = [0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0];

// position = floor(frame * 2147483646 / 529200), clamped to the device range.
// Max product ~1.1e15 < 2^53, so float64 integer math is exact.
export function positionOf(frameIndex) {
  const p = Math.floor(frameIndex * POSITION_MAX / PATCH_MAX_FRAMES);
  if (p < 0) return 0;
  if (p > POSITION_MAX) return POSITION_MAX;
  return p;
}

export function buildDrumPatch({ segments, name }) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new RangeError('buildDrumPatch: need 1..24 segments');
  }
  if (segments.length > PATCH_SLOTS) {
    // Rejected, not truncated: the export UI slices to the first 24 upstream
    // (CONTRACT-WIRE §3), so more than 24 reaching this module is a bug.
    throw new RangeError(`buildDrumPatch: at most ${PATCH_SLOTS} segments (got ${segments.length})`);
  }
  const sources = segments.map((s, i) => {
    const a = s && s.samples;
    if (!a || a.length === 0) throw new RangeError(`buildDrumPatch: segment ${i} is empty`);
    return a;
  });

  let lengths = sources.map((a) => a.length);
  let total = 0;
  for (const n of lengths) total += n;
  const scaled = total > PATCH_MAX_FRAMES;
  if (scaled) {
    // Scale every length by budget/total (keeps musical proportions); floor
    // keeps the sum within budget. A slice still owns at least one frame.
    const before = total;
    lengths = lengths.map((n) => Math.max(1, Math.floor(n * PATCH_MAX_FRAMES / before)));
    total = 0;
    for (const n of lengths) total += n;
  }

  const pcm = new Int16Array(total);
  const start = [];
  const end = [];
  let cursor = 0;
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const len = lengths[i];
    start.push(positionOf(cursor));
    end.push(positionOf(cursor + len - 1));
    // 2 ms raised-cosine edges inside the segment so adjacent slices never
    // click on hardware; shortened for tiny slices so the ramps cannot overlap.
    const fade = Math.min(FADE_FRAMES, len >> 1);
    for (let j = 0; j < len; j++) {
      let v = src[j];
      if (j < fade) v *= 0.5 * (1 - Math.cos(Math.PI * j / fade));
      const fromEnd = len - 1 - j;
      if (fromEnd < fade) v *= 0.5 * (1 - Math.cos(Math.PI * fromEnd / fade));
      pcm[cursor + j] = floatToS16(v);
    }
    cursor += len;
  }
  // Unused slots duplicate the last real slice's boundaries.
  for (let i = sources.length; i < PATCH_SLOTS; i++) {
    start.push(start[sources.length - 1]);
    end.push(end[sources.length - 1]);
  }

  // Compact JSON, keys alphabetical (insertion order below IS alphabetical),
  // all per-slice arrays exactly 24 long. 8192 = one-shot, forward, unity.
  const json = JSON.stringify({
    drum_version: 1,
    dyna_env: [0, 8192, 0, 8192, 0, 0, 0, 0],
    end,
    fx_active: false,
    fx_params: [8000, 8000, 8000, 8000, 8000, 8000, 8000, 8000],
    fx_type: 'delay',
    lfo_active: false,
    lfo_params: [16000, 16000, 16000, 16000, 0, 0, 0, 0],
    lfo_type: 'tremolo',
    name: sanitizeName(name),
    octave: 0,
    pitch: new Array(PATCH_SLOTS).fill(0),
    playmode: new Array(PATCH_SLOTS).fill(8192),
    reverse: new Array(PATCH_SLOTS).fill(8192),
    start,
    type: 'drum',
    volume: new Array(PATCH_SLOTS).fill(8192),
  });

  const jsonLen = json.length; // ASCII by construction (name sanitized)
  let applSize = 4 + jsonLen + 1; // 'op-1' + json + 0x0A
  const pad = applSize & 1; // pad to even; the size COUNTS the pad (contract §1)
  applSize += pad;
  const ssndSize = 8 + 2 * total;
  const formSize = 4 + (8 + 18) + (8 + applSize) + (8 + ssndSize);

  const bytes = new ArrayBuffer(8 + formSize);
  const dv = new DataView(bytes);
  const u8 = new Uint8Array(bytes);
  let o = 0;
  o = writeFourCC(u8, o, 'FORM');
  dv.setUint32(o, formSize); o += 4;
  o = writeFourCC(u8, o, 'AIFF');

  o = writeFourCC(u8, o, 'COMM');
  dv.setUint32(o, 18); o += 4;
  dv.setInt16(o, 1); o += 2; // mono
  dv.setUint32(o, total); o += 4;
  dv.setInt16(o, 16); o += 2; // bit depth
  for (const b of RATE_44100_EXTENDED) u8[o++] = b;

  o = writeFourCC(u8, o, 'APPL');
  dv.setUint32(o, applSize); o += 4;
  o = writeFourCC(u8, o, 'op-1');
  for (let i = 0; i < jsonLen; i++) u8[o++] = json.charCodeAt(i);
  u8[o++] = 0x0a;
  if (pad) u8[o++] = 0;

  o = writeFourCC(u8, o, 'SSND');
  dv.setUint32(o, ssndSize); o += 4;
  dv.setUint32(o, 0); o += 4; // offset
  dv.setUint32(o, 0); o += 4; // blockSize
  for (let i = 0; i < total; i++) { dv.setInt16(o, pcm[i]); o += 2; }

  return {
    bytes,
    report: { frames: total, seconds: total / PATCH_RATE, slices: sources.length, scaled },
  };
}

// Reads layout B (classic AIFF, big-endian PCM) and layout A (AIFC with FVER
// and 'sowt' little-endian PCM, as real devices write). Multi-channel input is
// averaged down to the mono Float32Array the bench works in.
export function parseDrumPatch(bytes) {
  const u8 = toU8(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < 12 || fourCC(u8, 0) !== 'FORM') {
    throw new Error('parseDrumPatch: not an AIFF file (no FORM header)');
  }
  const formType = fourCC(u8, 8);
  if (formType !== 'AIFF' && formType !== 'AIFC') {
    throw new Error(`parseDrumPatch: FORM type '${formType}' is not AIFF/AIFC`);
  }

  let channels = 0, frames = 0, bitDepth = 0, sampleRate = 0;
  let littleEndian = false, sawComm = false;
  let json = null;
  let ssndAt = -1;

  const fileEnd = Math.min(u8.length, 8 + dv.getUint32(4));
  let o = 12;
  while (o + 8 <= fileEnd) {
    const id = fourCC(u8, o);
    const size = dv.getUint32(o + 4);
    const dataAt = o + 8;
    if (dataAt + size > u8.length) break; // truncated trailing chunk
    if (id === 'COMM') {
      sawComm = true;
      channels = dv.getInt16(dataAt);
      frames = dv.getUint32(dataAt + 2);
      bitDepth = dv.getInt16(dataAt + 6);
      sampleRate = readExtended80(dv, dataAt + 8);
      if (formType === 'AIFC' && size >= 22) {
        const comp = fourCC(u8, dataAt + 18);
        if (comp === 'sowt') littleEndian = true;
        else if (comp !== 'NONE') throw new Error(`parseDrumPatch: unsupported AIFC compression '${comp}'`);
      }
    } else if (id === 'APPL' && size >= 4 && fourCC(u8, dataAt) === 'op-1') {
      json = JSON.parse(asciiSlice(u8, dataAt + 4, dataAt + size).replace(/[\s\u0000]+$/, ''));
    } else if (id === 'SSND') {
      ssndAt = dataAt;
    }
    o = dataAt + size + (size & 1); // odd-sized chunks carry an uncounted pad byte
  }

  if (!sawComm) throw new Error('parseDrumPatch: missing COMM chunk');
  if (ssndAt < 0) throw new Error('parseDrumPatch: missing SSND chunk');
  if (bitDepth !== 16) throw new Error(`parseDrumPatch: only 16-bit PCM supported (got ${bitDepth})`);

  const pcmAt = ssndAt + 8 + dv.getUint32(ssndAt); // skip offset/blockSize header
  if (pcmAt + 2 * channels * frames > u8.byteLength) {
    throw new Error('parseDrumPatch: SSND shorter than COMM frame count');
  }
  const pcm = new Float32Array(frames);
  if (channels === 1) {
    for (let i = 0; i < frames; i++) pcm[i] = dv.getInt16(pcmAt + 2 * i, littleEndian) / 32768;
  } else {
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      const base = pcmAt + 2 * channels * i;
      for (let c = 0; c < channels; c++) sum += dv.getInt16(base + 2 * c, littleEndian);
      pcm[i] = sum / (32768 * channels);
    }
  }
  return { json, frames, sampleRate, bitDepth, channels, pcm };
}

// Round half away from zero: Math.round is half-up, which is half-away for
// positives; mirror it for negatives. Clamp to s16.
function floatToS16(x) {
  const y = x * 32768;
  const r = y < 0 ? -Math.round(-y) : Math.round(y);
  if (r < -32768) return -32768;
  if (r > 32767) return 32767;
  return r;
}

// Printable ASCII only, max 24 chars in the JSON (contract); never empty.
function sanitizeName(name) {
  const clean = String(name == null ? '' : name).replace(/[^\x20-\x7e]/g, '').trim().slice(0, 24);
  return clean || 'drum';
}

function toU8(bytes) {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError('parseDrumPatch: expected ArrayBuffer or typed array');
}

function writeFourCC(u8, o, s) {
  u8[o] = s.charCodeAt(0); u8[o + 1] = s.charCodeAt(1);
  u8[o + 2] = s.charCodeAt(2); u8[o + 3] = s.charCodeAt(3);
  return o + 4;
}

function fourCC(u8, o) {
  return String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
}

function asciiSlice(u8, from, to) {
  let s = '';
  for (let i = from; i < to; i++) s += String.fromCharCode(u8[i]);
  return s;
}

// 80-bit IEEE extended: 1 sign, 15 exponent, 64 mantissa (explicit leading bit).
function readExtended80(dv, o) {
  const b0 = dv.getUint8(o);
  const exp = ((b0 & 0x7f) << 8) | dv.getUint8(o + 1);
  const hi = dv.getUint32(o + 2);
  const lo = dv.getUint32(o + 6);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  const sign = b0 & 0x80 ? -1 : 1;
  return sign * (hi * 4294967296 + lo) * Math.pow(2, exp - 16383 - 63);
}
