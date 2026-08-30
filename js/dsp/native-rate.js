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

// Decoded audio is Float32, and the peak pyramid and analysis copies ride on top
// of it. A native-rate decode that would blow past this is worse than a
// downgrade the user is told about.
const DECODE_BUDGET_BYTES = 1024 * 1024 * 1024;

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

/**
 * Rate, channel count, and exact duration from a container header. Both formats
 * that can carry above 48 kHz state their own length, so the decode budget is
 * computed from the real figure rather than guessed from encoded byte count.
 */
export function probeContainer(input) {
  const bytes = asBytes(input);
  if (!bytes || bytes.length < 12) return EMPTY_PROBE;
  if (tagAt(bytes, 0, 'RIFF') && tagAt(bytes, 8, 'WAVE')) return wavProbe(bytes);
  if (tagAt(bytes, 0, 'fLaC')) return flacProbe(bytes);
  return EMPTY_PROBE;
}

/**
 * Decide the rate to decode at. Returns {rate, downgraded, reason} so the caller
 * can say plainly when a file was not kept at its own resolution, rather than
 * silently halving it the way the default path did.
 */
export function planDecodeRate({ nativeRate, seconds, channels = 2, contextRate = 48000 } = {}) {
  const native = plausible(nativeRate);
  if (!native) return { rate: contextRate, downgraded: false, reason: null };
  if (native <= contextRate) return { rate: native, downgraded: false, reason: null };

  const chans = Math.max(1, Math.round(channels) || 1);
  const secs = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const bytes = secs * native * chans * 4;
  if (bytes > DECODE_BUDGET_BYTES) {
    return {
      rate: contextRate,
      downgraded: true,
      reason: 'a ' + Math.round(native / 1000) + ' kHz decode of this length needs '
        + Math.round(bytes / (1024 * 1024 * 1024) * 10) / 10
        + ' GB of memory, so it was decoded at ' + Math.round(contextRate / 1000) + ' kHz',
    };
  }
  return { rate: native, downgraded: false, reason: null };
}
