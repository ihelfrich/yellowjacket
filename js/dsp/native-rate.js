// Native sample-rate recovery, per docs/AUDIT-RESOLUTION.md section 1.
//
// decodeAudioData resamples to the AudioContext's rate, so a 96 or 192 kHz file
// loses half or three quarters of its samples before the bench ever sees it.
// Decoding through an OfflineAudioContext built at the FILE's rate keeps them,
// but that context has to be constructed before the decode — which means the
// rate must be read out of the container header first.
//
// Only WAV and FLAC are parsed. That is not laziness: MP3 tops out at 48 kHz and
// AAC in practice does too, so for every other container the context rate is
// already right and a guess could only be wrong.

// Rates outside this range are a corrupt header, not a recording. Feeding one to
// an OfflineAudioContext constructor throws, so it is screened here instead.
const MIN_RATE = 4000;
const MAX_RATE = 768000;

// A native-rate decode that would blow past this is worse than a downgrade the
// user is told about. The figure is compared against the FULL retained
// footprint, not the decoded buffer alone — see decodedFootprintBytes.
//
// 768 MB, not a round gigabyte, because this ceiling covers the SOURCE only.
// The same tab still has to hold the spectrogram's STFT matrix, a second full
// buffer once RENDER runs, and whatever CRATE has loaded. Spending the whole
// practical budget on the source and then dying at the first render is a worse
// outcome than decoding ten minutes of 96 kHz at 48 kHz and saying so.
export const DECODE_BUDGET_BYTES = 768 * 1024 * 1024;
// Past this the decode is refused outright: a single AudioBuffer this size
// fails to allocate in Chromium long before the tab is discarded, and no
// smaller decode keeps the file's bandwidth. The windowed loader is the door
// for files this long.
export const DECODE_HARD_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

// The peak pyramid holds a min and a max Float32 per block, at three block
// sizes, over the mono samples: 2 x 4 bytes x (1/64 + 1/512 + 1/4096) per frame.
const PEAK_BYTES_PER_FRAME = 8 * (1 / 64 + 1 / 512 + 1 / 4096);

/**
 * Bytes a loaded source keeps alive. Loading retains four allocations, and
 * budgeting only the first one under-counts by roughly half:
 *   - the decoded AudioBuffer   (frames x channels x 4)
 *   - the mono mixdown          (frames x 4)
 *   - the peak pyramid          (~0.14 x frames)
 *   - the encoded bytes, held for persistence and RESTORE
 * The encoded copy does not shrink when the decode rate does, but it is part of
 * the pressure the decision has to survive, so it counts.
 */
export function decodedFootprintBytes({ rate, seconds, channels = 2, encodedBytes = 0 } = {}) {
  const secs = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const hz = Number.isFinite(rate) && rate > 0 ? rate : 0;
  const chans = Math.max(1, Math.round(channels) || 1);
  const frames = secs * hz;
  const encoded = Number.isFinite(encodedBytes) && encodedBytes > 0 ? encodedBytes : 0;
  return frames * chans * 4 + frames * 4 + frames * PEAK_BYTES_PER_FRAME + encoded;
}

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input && input.buffer instanceof ArrayBuffer) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return null;
}

function tagAt(bytes, offset, text) {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function plausible(rate) {
  return Number.isFinite(rate) && rate >= MIN_RATE && rate <= MAX_RATE ? rate : null;
}

// RIFF chunks are a list, not a fixed layout: LIST, bext, and JUNK all legally
// precede 'fmt '. Reading a fixed offset 24 works on the files a synth writes
// and fails on the ones a field recorder writes.
function wavRate(bytes) {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const size = bytes[offset + 4] | (bytes[offset + 5] << 8)
      | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
    if (size < 0) return null;
    if (tagAt(bytes, offset, 'fmt ')) {
      const at = offset + 8 + 4;             // past the chunk header, format, channels
      if (at + 4 > bytes.length) return null;
      return plausible(bytes[at] | (bytes[at + 1] << 8)
        | (bytes[at + 2] << 16) | (bytes[at + 3] << 24));
    }
    offset += 8 + size + (size % 2);         // chunks are word-aligned
  }
  return null;
}

// STREAMINFO packs the rate as 20 bits at bit offset 80 of the block body,
// straddling three bytes. It is the field most often read wrong by four bits.
function flacRate(bytes) {
  const body = 8;
  if (body + 13 > bytes.length) return null;
  const rate = (bytes[body + 10] << 12)
    | (bytes[body + 11] << 4)
    | (bytes[body + 12] >> 4);
  return plausible(rate);
}

/** Native sample rate from a container header, or null when it cannot be known. */
export function sniffSampleRate(input) {
  const bytes = asBytes(input);
  if (!bytes || bytes.length < 12) return null;
  if (tagAt(bytes, 0, 'RIFF') && tagAt(bytes, 8, 'WAVE')) return wavRate(bytes);
  if (tagAt(bytes, 0, 'fLaC')) return flacRate(bytes);
  return null;
}

const EMPTY_PROBE = Object.freeze({ sampleRate: null, channels: 0, seconds: 0 });

function wavProbe(bytes) {
  const rate = wavRate(bytes);
  if (!rate) return EMPTY_PROBE;
  let channels = 0;
  let bits = 16;
  let dataBytes = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const size = bytes[offset + 4] | (bytes[offset + 5] << 8)
      | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
    if (size < 0) break;
    if (tagAt(bytes, offset, 'fmt ')) {
      channels = bytes[offset + 10] | (bytes[offset + 11] << 8);
      // bitsPerSample sits 14 bytes into the chunk body, after format, channels,
      // rate, byte rate, and block align.
      bits = (bytes[offset + 22] | (bytes[offset + 23] << 8)) || 16;
    } else if (tagAt(bytes, offset, 'data')) {
      dataBytes = size;
    }
    offset += 8 + size + (size % 2);
  }
  const frameBytes = Math.max(1, channels * Math.ceil(bits / 8));
  return {
    sampleRate: rate,
    channels: channels || 0,
    seconds: dataBytes > 0 ? dataBytes / frameBytes / rate : 0,
  };
}

// STREAMINFO again: channels is 3 bits at offset 100, total samples 36 bits at
// offset 108. Both straddle byte boundaries, which is why they get a test.
function flacProbe(bytes) {
  const rate = flacRate(bytes);
  if (!rate) return EMPTY_PROBE;
  const body = 8;
  if (body + 18 > bytes.length) return EMPTY_PROBE;
  const channels = ((bytes[body + 12] & 0x0E) >> 1) + 1;
  const total = (bytes[body + 13] & 0x0F) * 4294967296
    + ((bytes[body + 14] << 24) >>> 0)
    + (bytes[body + 15] << 16)
    + (bytes[body + 16] << 8)
    + bytes[body + 17];
  return { sampleRate: rate, channels, seconds: total > 0 ? total / rate : 0 };
}

// ---------- MPEG audio (MP3) ----------
//
// The frame header carries version, layer, bitrate, rate, and channel mode; a
// Xing/Info or VBRI tag in the first frame carries the frame count, which
// gives an exact duration. Without one the stream is treated as CBR and the
// duration is size × 8 / bitrate, which is exact for CBR and approximate for
// a VBR file with no tag (rare: every common encoder writes one).
const MPEG_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const MPEG_BITRATES = {
  // [version][layer] → kbps by index 1..14
  '3:3': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],   // MPEG1 L1
  '3:2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],      // MPEG1 L2
  '3:1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],       // MPEG1 L3
  '2:3': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],      // MPEG2/2.5 L1
  '2:2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],           // MPEG2/2.5 L2
  '2:1': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],           // MPEG2/2.5 L3
};

function id3v2Size(bytes) {
  if (!tagAt(bytes, 0, 'ID3') || bytes.length < 10) return 0;
  const size = ((bytes[6] & 0x7F) << 21) | ((bytes[7] & 0x7F) << 14) | ((bytes[8] & 0x7F) << 7) | (bytes[9] & 0x7F);
  return 10 + size + ((bytes[5] & 0x10) ? 10 : 0);
}

function mpegFrameAt(bytes, at) {
  if (at + 4 > bytes.length || bytes[at] !== 0xFF || (bytes[at + 1] & 0xE0) !== 0xE0) return null;
  const version = (bytes[at + 1] >> 3) & 3;          // 0=2.5, 2=2, 3=1; 1 reserved
  const layerBits = (bytes[at + 1] >> 1) & 3;        // 1=L3, 2=L2, 3=L1; 0 reserved
  const bitrateIndex = (bytes[at + 2] >> 4) & 15;
  const rateIndex = (bytes[at + 2] >> 2) & 3;
  const channelMode = (bytes[at + 3] >> 6) & 3;
  if (version === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const rate = MPEG_RATES[version][rateIndex];
  const table = MPEG_BITRATES[(version === 3 ? '3' : '2') + ':' + layerBits];
  const kbps = table[bitrateIndex];
  const samplesPerFrame = layerBits === 3 ? 384 : layerBits === 2 ? 1152 : (version === 3 ? 1152 : 576);
  return { version, layer: 4 - layerBits, rate, kbps, channels: channelMode === 3 ? 1 : 2, samplesPerFrame };
}

function mp3Probe(bytes) {
  const start = id3v2Size(bytes);
  const limit = Math.min(bytes.length - 4, start + 65536);
  let at = start;
  let frame = null;
  for (; at <= limit; at++) {
    frame = mpegFrameAt(bytes, at);
    if (frame) break;
  }
  if (!frame) return EMPTY_PROBE;
  // Xing/Info sits after the side information; VBRI sits 32 bytes in.
  const side = frame.version === 3 ? (frame.channels === 1 ? 17 : 32) : (frame.channels === 1 ? 9 : 17);
  const xing = at + 4 + side;
  let frames = 0;
  if ((tagAt(bytes, xing, 'Xing') || tagAt(bytes, xing, 'Info')) && xing + 12 <= bytes.length) {
    const flags = bytes[xing + 7];
    if (flags & 1) frames = ((bytes[xing + 8] << 24) >>> 0) + (bytes[xing + 9] << 16) + (bytes[xing + 10] << 8) + bytes[xing + 11];
  } else if (tagAt(bytes, at + 36, 'VBRI') && at + 36 + 18 <= bytes.length) {
    const v = at + 36 + 14;
    frames = ((bytes[v] << 24) >>> 0) + (bytes[v + 1] << 16) + (bytes[v + 2] << 8) + bytes[v + 3];
  }
  const seconds = frames > 0
    ? frames * frame.samplesPerFrame / frame.rate
    : (bytes.length - at) * 8 / (frame.kbps * 1000);
  return { sampleRate: frame.rate, channels: frame.channels, seconds };
}

// ---------- ISO BMFF (M4A / MP4 / AAC in MP4) ----------
//
// Walk boxes to moov → trak → mdia; take the first track whose hdlr is 'soun':
// mdhd gives timescale and duration, stsd's first entry gives channels and the
// 16.16 sample rate. moov may sit at the end of a file that was not written
// with faststart, so the whole buffer is walked, box header by box header.
function be32(bytes, at) { return ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]; }
function be64(bytes, at) { return be32(bytes, at) * 4294967296 + be32(bytes, at + 4); }

function* boxes(bytes, from, to) {
  let at = from;
  while (at + 8 <= to) {
    let size = be32(bytes, at);
    let head = 8;
    if (size === 1) { size = be64(bytes, at + 8); head = 16; } else if (size === 0) size = to - at;
    if (size < head) return;
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    yield { type, body: at + head, end: Math.min(to, at + size) };
    at += size;
  }
}
function findBox(bytes, from, to, type) {
  for (const b of boxes(bytes, from, to)) if (b.type === type) return b;
  return null;
}

function mp4Probe(bytes) {
  const moov = findBox(bytes, 0, bytes.length, 'moov');
  if (!moov) return EMPTY_PROBE;
  for (const trak of boxes(bytes, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = findBox(bytes, trak.body, trak.end, 'mdia');
    if (!mdia) continue;
    const hdlr = findBox(bytes, mdia.body, mdia.end, 'hdlr');
    if (!hdlr || !tagAt(bytes, hdlr.body + 8, 'soun')) continue;
    const mdhd = findBox(bytes, mdia.body, mdia.end, 'mdhd');
    const minf = findBox(bytes, mdia.body, mdia.end, 'minf');
    const stbl = minf && findBox(bytes, minf.body, minf.end, 'stbl');
    const stsd = stbl && findBox(bytes, stbl.body, stbl.end, 'stsd');
    if (!mdhd || !stsd) continue;
    const version = bytes[mdhd.body];
    const timescale = version === 1 ? be32(bytes, mdhd.body + 20) : be32(bytes, mdhd.body + 12);
    const duration = version === 1 ? be64(bytes, mdhd.body + 24) : be32(bytes, mdhd.body + 16);
    // stsd: version/flags (4), entry count (4), then the first sample entry.
    const entry = stsd.body + 8;
    const channels = (bytes[entry + 8 + 16] << 8) | bytes[entry + 8 + 17];
    const rate = be32(bytes, entry + 8 + 24) / 65536;
    return {
      sampleRate: plausible(rate) || null,
      channels: channels || 0,
      seconds: timescale > 0 && duration > 0 ? duration / timescale : 0,
    };
  }
  return EMPTY_PROBE;
}

// ---------- Ogg (Vorbis, Opus) ----------
//
// The identification header on the first page gives channels and rate; the
// granule position of the LAST page (searched for within the final 64 KiB)
// gives the total sample count. Opus always decodes at 48 kHz; its granule
// counts at 48 kHz too, less the pre-skip.
function le32(bytes, at) { return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0; }
function le64(bytes, at) { return le32(bytes, at) + le32(bytes, at + 4) * 4294967296; }

function oggProbe(bytes) {
  const segments = bytes[26];
  const packet = 27 + segments;                    // first packet of the first page
  let sampleRate = null, channels = 0, granuleRate = 0, preskip = 0;
  if (tagAt(bytes, packet + 1, 'vorbis') && bytes[packet] === 1) {
    channels = bytes[packet + 11];
    sampleRate = plausible(le32(bytes, packet + 12)) || null;
    granuleRate = sampleRate || 0;
  } else if (tagAt(bytes, packet, 'OpusHead')) {
    channels = bytes[packet + 9];
    preskip = bytes[packet + 10] | (bytes[packet + 11] << 8);
    sampleRate = 48000;                             // Opus output rate; the input rate is advisory
    granuleRate = 48000;
  } else {
    return EMPTY_PROBE;
  }
  let seconds = 0;
  const from = Math.max(0, bytes.length - 65536);
  for (let at = bytes.length - 27; at >= from; at--) {
    if (tagAt(bytes, at, 'OggS')) {
      const granule = le64(bytes, at + 6);
      if (granule > 0 && granuleRate) seconds = Math.max(0, granule - preskip) / granuleRate;
      break;
    }
  }
  return { sampleRate, channels, seconds };
}

/**
 * Rate, channel count, and duration from a container header, for WAV, FLAC,
 * MP3, MP4/M4A (AAC), and Ogg (Vorbis, Opus). The decode budget is computed
 * from the real figure wherever a header states one, rather than guessed from
 * encoded byte count.
 */
export function probeContainer(input) {
  const bytes = asBytes(input);
  if (!bytes || bytes.length < 12) return EMPTY_PROBE;
  if (tagAt(bytes, 0, 'RIFF') && tagAt(bytes, 8, 'WAVE')) return wavProbe(bytes);
  if (tagAt(bytes, 0, 'fLaC')) return flacProbe(bytes);
  if (tagAt(bytes, 0, 'OggS')) return oggProbe(bytes);
  if (tagAt(bytes, 4, 'ftyp')) return mp4Probe(bytes);
  if (tagAt(bytes, 0, 'ID3') || (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0)) return mp3Probe(bytes);
  return EMPTY_PROBE;
}

// A container the probe cannot read still has a length: assume the cheapest
// plausible encoding so the estimate errs high, never low. 64 kbps stereo is
// below any music encoder's floor, so a real file of that size is shorter.
export const UNKNOWN_KBPS_FLOOR = 64;
export function assumedSeconds(encodedBytes, seconds) {
  if (Number.isFinite(seconds) && seconds > 0) return seconds;
  const bytes = Number.isFinite(encodedBytes) && encodedBytes > 0 ? encodedBytes : 0;
  return bytes * 8 / (UNKNOWN_KBPS_FLOOR * 1000);
}

function gb(bytes) { return Math.round(bytes / (1024 * 1024 * 1024) * 10) / 10; }
function refuseReason(rate, bytes) {
  return 'this length at ' + Math.round(rate / 1000) + ' kHz needs about ' + gb(bytes)
    + ' GB of memory, past the ' + gb(DECODE_HARD_LIMIT_BYTES) + ' GB a browser tab can hold for one source';
}
function heavyReason(bytes) {
  return 'this source holds about ' + gb(bytes) + ' GB resident, more than the '
    + gb(DECODE_BUDGET_BYTES) + ' GB the bench budgets; a busy machine may discard the tab';
}

/**
 * Decide the rate to decode at. Returns {rate, downgraded, reason} so the caller
 * can say plainly when a file was not kept at its own resolution, rather than
 * silently halving it the way the default path did.
 */
export function planDecodeRate({
  nativeRate, seconds, channels = 2, contextRate = 48000, encodedBytes = 0,
} = {}) {
  const native = plausible(nativeRate);
  // Unknown length or channel count must not read as "free" (a long MP3 that
  // the probe missed used to budget as its encoded size alone).
  seconds = assumedSeconds(encodedBytes, seconds);
  channels = Number.isFinite(channels) && channels > 0 ? channels : 2;
  const footprint = (rate) => decodedFootprintBytes({ rate, seconds, channels, encodedBytes });
  const result = (rate, extra) => ({
    rate, downgraded: false, upsampled: false, overBudget: false, refused: false, reason: null,
    bytes: footprint(rate), ...extra,
  });

  // Rate unknown: only the context can decode it, so that is the cost.
  if (!native) {
    const bytes = footprint(contextRate);
    if (bytes > DECODE_HARD_LIMIT_BYTES) return result(contextRate, { overBudget: true, refused: true, reason: refuseReason(contextRate, bytes) });
    return result(contextRate, { overBudget: bytes > DECODE_BUDGET_BYTES, reason: bytes > DECODE_BUDGET_BYTES ? heavyReason(bytes) : null });
  }

  const nativeBytes = footprint(native);
  // At or below the context rate there is nothing cheaper to decode to that
  // keeps the file's bandwidth, so the file is decoded at its own rate — never
  // upsampled — and refused only past the hard limit.
  if (native <= contextRate) {
    if (nativeBytes > DECODE_HARD_LIMIT_BYTES) return result(native, { overBudget: true, refused: true, reason: refuseReason(native, nativeBytes) });
    return result(native, { overBudget: nativeBytes > DECODE_BUDGET_BYTES, reason: nativeBytes > DECODE_BUDGET_BYTES ? heavyReason(nativeBytes) : null });
  }

  // Above the context rate: keep the file's rate while it fits the budget;
  // past it, the context rate is the honest fallback (said so in `reason`),
  // and past the hard limit even that is refused.
  if (nativeBytes <= DECODE_BUDGET_BYTES) return result(native);
  const contextBytes = footprint(contextRate);
  if (contextBytes > DECODE_HARD_LIMIT_BYTES) return result(contextRate, { downgraded: true, overBudget: true, refused: true, reason: refuseReason(contextRate, contextBytes) });
  return result(contextRate, {
    downgraded: true,
    overBudget: true,
    reason: 'a ' + Math.round(native / 1000) + ' kHz decode of this length needs '
      + Math.round(nativeBytes / (1024 * 1024 * 1024) * 10) / 10
      + ' GB of memory, so it was decoded at ' + Math.round(contextRate / 1000) + ' kHz',
  });
}
