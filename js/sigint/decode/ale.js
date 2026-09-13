// ALE — Automatic Link Establishment, MIL-STD-188-141. How military,
// government and embassy HF stations find each other without a human turning a
// dial: every station sounds its own callsign into the band, listens for
// others, and scores the channels. The handshake itself is in the clear. The
// traffic that follows usually is not, but the handshake says who is calling
// whom, on what frequency, at what minute — which is most of what a direction-
// finding net wants and all of what a listener needs to know a link exists.
//
// The encoding, and why each layer is here:
//
//   8-FSK at 125 tones a second, tones at 750 Hz to 2500 Hz in 250 Hz steps,
//   three bits a tone. A 24-bit word is a 3-bit preamble naming the word's
//   role — TO, THIS IS, FROM, THIS WAS, DATA, THRU, COMMAND, REPEAT — and
//   three seven-bit characters. Each 12-bit half of the word is Golay(24,12)
//   encoded, which corrects up to three bit errors per half; a stuff bit makes
//   49; the 49 bits are interleaved so a fade takes one bit from many words
//   rather than many bits from one; and the whole thing is sent three times,
//   49 tones and 392 ms in total, and majority-voted at the receiver.
//
// That stack is the point. HF is a channel where a third of the bits can be
// wrong and the message still has to arrive intact or not at all — and this
// decoder reports, for every word, how many bits the majority vote had to
// break and how many the Golay code had to repair. A word that needed a lot of
// both is printed with that number beside it rather than as though it were
// read cleanly.
//
// HONEST LIMIT, stated because it matters: this is round-tripped against this
// module's own renderer, not against an off-air capture. The 8-FSK front end,
// the Golay code and the majority vote are all verifiable in themselves and
// are tested that way. The bit ORDER between the interleaver and the tone
// mapper is the part a specification gets to decide, and until a real ALE
// recording has been through this, a decode of real traffic is a hypothesis.
// `INTERLEAVE` is exported so that hypothesis can be swapped without touching
// anything else.
//
// Pure and worker-safe.
import { goertzel } from '../../dsp/analytic.js';

export const TONE_BASE_HZ = 750, TONE_STEP_HZ = 250, TONE_COUNT = 8;
export const SYMBOL_RATE = 125;
export const TONES = Object.freeze(Array.from({ length: TONE_COUNT }, (_, i) => TONE_BASE_HZ + i * TONE_STEP_HZ));
/** 49 tones a word: 147 bits, three redundant copies of 49. */
export const TONES_PER_WORD = 49;
export const WORD_SEC = TONES_PER_WORD / SYMBOL_RATE;   // 392 ms

export const PREAMBLES = Object.freeze(['DATA', 'THRU', 'TO', 'THIS WAS', 'FROM', 'THIS IS', 'COMMAND', 'REPEAT']);

// ---------------------------------------------------------------- Golay

const GOLAY_POLY = 0xc75;   // x^11 + x^10 + x^6 + x^5 + x^4 + x^2 + 1

/** Golay(23,12): 12 data bits in the top, 11 parity below. */
export function golay23Encode(data12) {
  let w = (data12 & 0xfff) << 11;
  const top = w;
  for (let i = 22; i >= 11; i--) if (w & (1 << i)) w ^= GOLAY_POLY << (i - 11);
  return (top | (w & 0x7ff)) >>> 0;
}

/** Golay(24,12): the 23-bit word plus an overall even-parity bit. */
export function golay24Encode(data12) {
  const w = golay23Encode(data12);
  let p = 0, v = w;
  while (v) { p ^= v & 1; v >>>= 1; }
  return ((w << 1) | p) >>> 0;
}

const syndromeOf = (w23) => {
  let w = w23 & 0x7fffff;
  for (let i = 22; i >= 11; i--) if (w & (1 << i)) w ^= GOLAY_POLY << (i - 11);
  return w & 0x7ff;
};

// Syndrome to error pattern, for every pattern of up to three bad bits. 2,048
// syndromes and 2,047 correctable patterns, so the table is exact rather than
// an approximation: every syndrome except zero has exactly one pattern of
// weight three or less.
const SYNDROME_TABLE = (() => {
  const t = new Int32Array(2048).fill(-1);
  t[0] = 0;
  for (let i = 0; i < 23; i++) {
    const e1 = 1 << i;
    t[syndromeOf(e1)] = e1;
    for (let j = i + 1; j < 23; j++) {
      const e2 = e1 | (1 << j);
      t[syndromeOf(e2)] = e2;
      for (let k = j + 1; k < 23; k++) {
        const e3 = e2 | (1 << k);
        const s = syndromeOf(e3);
        if (t[s] === -1) t[s] = e3;
      }
    }
  }
  return t;
})();

/**
 * Decode a Golay(24,12) word. Returns the 12 data bits and how many bits it
 * had to change, or null when the word is beyond the code — which is a real
 * outcome and must not be smoothed over.
 */
export function golay24Decode(word24) {
  const w = word24 >>> 0;
  const w23 = (w >>> 1) & 0x7fffff;
  const pattern = SYNDROME_TABLE[syndromeOf(w23)];
  if (pattern === -1) return null;
  const fixed = (w23 ^ pattern) >>> 0;
  let errors = 0, v = pattern;
  while (v) { errors += v & 1; v >>>= 1; }
  // The overall parity bit is what makes this the EXTENDED code, and it is the
  // four-error detector. Golay(23,12) alone accepts every word it is handed —
  // every one of the 2,048 syndromes has a correctable pattern — so a decoder
  // that stops here reads noise as traffic, which this one did: five colours
  // of hiss came back as "THRU >t?" and "COMMAND ?>o70UWT".
  let p = 0, u = fixed;
  while (u) { p ^= u & 1; u >>>= 1; }
  // The received parity bit against the corrected word's own parity. Three
  // errors inside the codeword plus a fourth anywhere makes four, which this
  // code detects and does not correct; four inside the codeword leave a
  // weight-three pattern that flips the parity, and are caught the same way.
  const parityFlipped = ((w & 1) ^ p) === 1;
  const total = errors + (parityFlipped ? 1 : 0);
  if (total > 3) return null;
  return { data: (fixed >>> 11) & 0xfff, errors: total };
}

// ------------------------------------------------------- interleave, words

/**
 * The 49-bit interleave, as a permutation. Written out rather than computed so
 * it can be replaced by a different reading of the specification without
 * touching the demodulator: `deinterleave` is its inverse by construction.
 */
export const INTERLEAVE = Object.freeze((() => {
  const n = 49, stride = 7, out = new Int32Array(n);
  for (let i = 0; i < n; i++) out[i] = (i % stride) * stride + Math.floor(i / stride);
  return Array.from(out);
})());

export function interleave(bits49) {
  const out = new Uint8Array(49);
  for (let i = 0; i < 49; i++) out[i] = bits49[INTERLEAVE[i]];
  return out;
}

export function deinterleave(bits49) {
  const out = new Uint8Array(49);
  for (let i = 0; i < 49; i++) out[INTERLEAVE[i]] = bits49[i];
  return out;
}

/** A 24-bit ALE word to the 49 bits that go on the air (before redundancy). */
export function encodeWord(word24) {
  const hi = (word24 >>> 12) & 0xfff, lo = word24 & 0xfff;
  const a = golay24Encode(hi), b = golay24Encode(lo);
  const bits = new Uint8Array(49);
  for (let i = 0; i < 24; i++) bits[i] = (a >>> (23 - i)) & 1;
  for (let i = 0; i < 24; i++) bits[24 + i] = (b >>> (23 - i)) & 1;
  bits[48] = bits[47];        // the stuff bit repeats the last data bit
  return interleave(bits);
}

/**
 * 49 received bits back to a 24-bit word. Returns the word and how many bits
 * the Golay code repaired, or null when either half is beyond the code.
 */
export function decodeWord(bits49) {
  const bits = deinterleave(bits49);
  let a = 0, b = 0;
  for (let i = 0; i < 24; i++) a = ((a << 1) | bits[i]) >>> 0;
  for (let i = 0; i < 24; i++) b = ((b << 1) | bits[24 + i]) >>> 0;
  const da = golay24Decode(a), db = golay24Decode(b);
  if (!da || !db) return null;
  return { word: ((da.data << 12) | db.data) >>> 0, repaired: da.errors + db.errors };
}

/**
 * The characters ALE addresses are built from. Everything outside this set is
 * evidence the window is not a word: the Golay code accepts a large share of
 * random bits, so the alphabet is what separates a callsign from a syndrome
 * that happened to check.
 */
export const ALE_38 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 @';
export const inAlphabet = (text) => [...text].every((c) => ALE_38.includes(c));

/** The role and three characters carried by a 24-bit word. */
export function readWord(word24) {
  const preamble = (word24 >>> 21) & 0x7;
  const chars = [];
  for (let i = 0; i < 3; i++) {
    const c = (word24 >>> (14 - i * 7)) & 0x7f;
    chars.push(c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '?');
  }
  return { preamble, role: PREAMBLES[preamble], text: chars.join('') };
}

/** A role and three characters to a 24-bit word. */
export function makeWord(preamble, text) {
  const p = typeof preamble === 'number' ? preamble : PREAMBLES.indexOf(preamble);
  if (p < 0) throw new RangeError('unknown preamble ' + preamble);
  const s = (text + '   ').slice(0, 3);
  let w = (p & 7) << 21;
  for (let i = 0; i < 3; i++) w |= (s.charCodeAt(i) & 0x7f) << (14 - i * 7);
  return w >>> 0;
}

// ------------------------------------------------------------ demodulation

/** Which of the eight tones each symbol is, with how sure the decision was. */
export function readTones(x, sampleRate, { from = 0, to = x.length, phase = 0 } = {}) {
  const spSym = sampleRate / SYMBOL_RATE;
  const n = Math.max(0, Math.floor((to - from) / spSym) - 1);
  const idx = new Uint8Array(n);
  const margin = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.round(from + (i + phase) * spSym);
    const len = Math.round(spSym);
    if (a + len > x.length) break;
    let best = 0, bestP = -1, second = 0;
    for (let t = 0; t < TONE_COUNT; t++) {
      const p = goertzel(x, sampleRate, TONES[t], { start: a, length: len });
      if (p > bestP) { second = bestP; bestP = p; best = t; }
      else if (p > second) second = p;
    }
    idx[i] = best;
    margin[i] = second > 0 ? 10 * Math.log10(bestP / second) : 30;
  }
  return { idx, margin, samplesPerSymbol: spSym };
}

/**
 * Where the symbol grid sits. Tried at a handful of offsets across one symbol,
 * scored by the mean decision margin: reading a tone across a boundary mixes
 * two tones and the margin collapses, so the offset with the widest margin is
 * the one on the grid.
 */
export function symbolPhase(x, sampleRate, { from = 0, to = x.length, steps = 8 } = {}) {
  let best = 0, bestScore = -Infinity;
  const span = Math.min(to, from + Math.round(sampleRate * 0.6));
  for (let s = 0; s < steps; s++) {
    const phase = s / steps;
    const { margin } = readTones(x, sampleRate, { from, to: span, phase });
    if (!margin.length) continue;
    let acc = 0;
    for (let i = 0; i < margin.length; i++) acc += margin[i];
    const score = acc / margin.length;
    if (score > bestScore) { bestScore = score; best = phase; }
  }
  return { phase: best, marginDb: +bestScore.toFixed(2) };
}

/** Three redundant copies of 49 bits, majority-voted. Returns bits and breaks. */
export function majority(bits147) {
  const out = new Uint8Array(49);
  let broken = 0;
  for (let i = 0; i < 49; i++) {
    const s = bits147[i] + bits147[i + 49] + bits147[i + 98];
    out[i] = s >= 2 ? 1 : 0;
    if (s === 1 || s === 2) broken++;
  }
  return { bits: out, broken };
}

/**
 * Decode ALE from a span. Every 49-tone window is tried; a window whose two
 * Golay halves both check is a word, and consecutive words are assembled into
 * the calls they make up.
 */
export function decodeAle(x, sampleRate, { maxWords = 64, minMarginDb = 1.5 } = {}) {
  if (!x || x.length < sampleRate * WORD_SEC) {
    return { ok: false, reason: `an ALE word is ${(WORD_SEC * 1000).toFixed(0)} ms of 8-FSK; the span is shorter` };
  }
  if (sampleRate < 2 * (TONE_BASE_HZ + (TONE_COUNT - 1) * TONE_STEP_HZ) * 1.05) {
    return { ok: false, reason: `sample rate ${sampleRate} cannot carry a ${TONES[TONE_COUNT - 1]} Hz tone` };
  }
  const grid = symbolPhase(x, sampleRate);
  const { idx, margin, samplesPerSymbol } = readTones(x, sampleRate, { phase: grid.phase });
  if (idx.length < TONES_PER_WORD) return { ok: false, reason: 'fewer than one word of symbols in the span' };
  let meanMargin = 0;
  for (let i = 0; i < margin.length; i++) meanMargin += margin[i];
  meanMargin /= Math.max(1, margin.length);
  if (meanMargin < minMarginDb) {
    return {
      ok: false,
      reason: `no 8-FSK on the ALE tone set: the strongest of the eight tones beats the next by only ${meanMargin.toFixed(1)} dB on average, `
        + `and ${minMarginDb} dB is the bar`,
      marginDb: +meanMargin.toFixed(2),
    };
  }
  const bits = new Uint8Array(idx.length * 3);
  for (let i = 0; i < idx.length; i++) {
    bits[i * 3] = (idx[i] >> 2) & 1;
    bits[i * 3 + 1] = (idx[i] >> 1) & 1;
    bits[i * 3 + 2] = idx[i] & 1;
  }
  // Every tone offset is tried, and a hit is only a candidate. What makes a
  // run of candidates a transmission is that they are BACK TO BACK: real words
  // are exactly 49 tones apart, and a chance hit has nothing after it.
  const candidates = [];
  for (let at = 0; at + TONES_PER_WORD * 3 <= bits.length; at += 3) {
    const vote = majority(bits.subarray(at, at + 147));
    const got = decodeWord(vote.bits);
    if (!got) continue;
    const read = readWord(got.word);
    if (!inAlphabet(read.text)) continue;
    let m = 0; for (let i = at / 3; i < at / 3 + TONES_PER_WORD && i < margin.length; i++) m += margin[i];
    candidates.push({
      ...read, word: got.word, tone: at / 3,
      atSec: +((at / 3) * samplesPerSymbol / sampleRate).toFixed(3),
      repaired: got.repaired, voteBreaks: vote.broken,
      marginDb: +(m / TONES_PER_WORD).toFixed(1),
    });
  }
  // The longest chain of candidates spaced exactly one word apart.
  const byTone = new Map();
  for (const c of candidates) if (!byTone.has(c.tone)) byTone.set(c.tone, c);
  let bestChain = [];
  for (const c of candidates) {
    const chain = [];
    let t = c.tone;
    while (byTone.has(t) && chain.length < maxWords) { chain.push(byTone.get(t)); t += TONES_PER_WORD; }
    if (chain.length > bestChain.length) bestChain = chain;
  }
  // How often this would happen by chance. The Golay pair accepts a measured
  // share of random windows, the alphabet another, and a chain of k words
  // needs all of them: stated so a one-word "decode" can be read for what it
  // is. Two words back to back is the bar, and one word is only allowed when
  // it needed no repair at all.
  const windows = Math.max(1, Math.floor(bits.length / 3) - TONES_PER_WORD);
  const perWindow = candidates.length / windows;
  const chanceOfChain = windows * perWindow ** Math.max(1, bestChain.length);
  const clean = bestChain.length === 1 && bestChain[0].repaired === 0 && bestChain[0].voteBreaks === 0;
  if (bestChain.length < 2 && !clean) {
    return {
      ok: false,
      reason: candidates.length
        ? `${candidates.length} of ${windows} windows passed the Golay check with in-alphabet characters, but none was followed by another `
          + `one word later — at this rate chance alone produces ${(windows * perWindow).toFixed(1)} such windows in a span this long, so a lone hit is not a call`
        : `the span carries 8-FSK on the ALE tone set at ${meanMargin.toFixed(1)} dB margin, but no 49-tone window passed both halves of its Golay check with ALE characters`,
      marginDb: +meanMargin.toFixed(2),
      candidates: candidates.length,
    };
  }
  const words = bestChain;
  const calls = assembleCalls(words);
  const repaired = words.reduce((a, w) => a + w.repaired, 0);
  const breaks = words.reduce((a, w) => a + w.voteBreaks, 0);
  return {
    ok: true,
    words, calls,
    text: calls.map((c) => c.text).join('\n'),
    marginDb: +meanMargin.toFixed(2),
    falseAlarmInSpan: +chanceOfChain.toFixed(4),
    note: `${words.length} words back to back · ${breaks} bits broken by the majority vote · ${repaired} repaired by Golay`
      + ` · chance alone would put ${chanceOfChain < 0.01 ? 'under 0.01' : chanceOfChain.toFixed(2)} runs this long in a span this size`
      + (repaired > words.length * 2 ? ' — a lot of repair, so read the callsigns with that in mind' : ''),
  };
}

/**
 * Words to calls. A call is a role word followed by however many DATA words
 * continue its address: "TO" plus "ABC" plus DATA "DEF" is a call to ABCDEF.
 */
export function assembleCalls(words) {
  const calls = [];
  let open = null;
  const close = () => { if (open) { open.text = `${open.role} ${open.address}`.trim(); calls.push(open); open = null; } };
  for (const w of words) {
    if (w.role === 'DATA' && open) { open.address += w.text; open.endSec = w.atSec; continue; }
    close();
    if (w.role === 'DATA') continue;
    open = { role: w.role, address: w.text, startSec: w.atSec, endSec: w.atSec };
  }
  close();
  for (const c of calls) c.address = c.address.replace(/\s+$/, '');
  for (const c of calls) c.text = `${c.role} ${c.address}`.trim();
  return calls;
}

/** Render a call, for the tests and for hearing what one sounds like. */
export function encodeAle(words, sampleRate, { amplitude = 0.5, redundancy = 3, leadSec = 0 } = {}) {
  const symbols = [];
  for (let i = 0; i < Math.round(leadSec * SYMBOL_RATE); i++) symbols.push(0);
  for (const w of words) {
    const word24 = typeof w === 'number' ? w : makeWord(w.role, w.text);
    const bits = encodeWord(word24);
    const full = new Uint8Array(49 * redundancy);
    for (let r = 0; r < redundancy; r++) full.set(bits, r * 49);
    for (let i = 0; i + 3 <= full.length; i += 3) symbols.push((full[i] << 2) | (full[i + 1] << 1) | full[i + 2]);
  }
  const spSym = sampleRate / SYMBOL_RATE;
  const n = Math.ceil((symbols.length + 1) * spSym);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const s = symbols[Math.min(symbols.length - 1, Math.floor(i / spSym))];
    out[i] = amplitude * Math.sin(phase);
    phase += 2 * Math.PI * TONES[s] / sampleRate;
    if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
  }
  return out;
}
