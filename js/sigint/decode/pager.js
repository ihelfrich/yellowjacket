// POCSAG — the paging protocol, and the most quietly alarming thing a receiver
// can hear. It is unencrypted, it carries names, phone numbers, addresses,
// on-call rosters and hospital alerts, and it is still in service. A decoder
// for it belongs on a bench that takes signals seriously, and so does a plain
// statement of what it is: reading pager traffic you are not the addressee of
// is unlawful in most places. This decodes a recording. What a person does
// with a receiver is their own business and their own jurisdiction's.
//
// The encoding: direct FSK at 512, 1200 or 2400 baud, positive shift is a
// ZERO, 32-bit codewords, each a (31,21) BCH code with an even parity bit.
// A batch is a 32-bit preamble of alternating bits, then a 32-bit frame sync
// word 0x7CD215D8, then eight frames of two codewords. An address codeword has
// bit 31 clear and carries 18 address bits, which with the frame index give
// the pager's 21-bit capcode; a message codeword has bit 31 set and carries 20
// data bits, packed into 7-bit ASCII or 4-bit BCD numerals across codeword
// boundaries.
//
// The BCH code is what makes this trustworthy: every codeword either checks,
// or is corrected by one or two bit flips, or is thrown away. A decoder
// without it prints plausible garbage out of noise. This one reports how many
// codewords it corrected and how many it discarded, alongside the text.
//
// Pure and worker-safe.
import { analytic, instantaneousFreq } from '../../dsp/analytic.js';

export const BAUDS = Object.freeze([512, 1200, 2400]);
export const SYNC_WORD = 0x7cd215d8;
export const IDLE_WORD = 0x7a89c197;
const GENERATOR = 0b11101101001;   // x^10 + x^9 + x^8 + x^6 + x^5 + x^3 + 1

export const FUNCTIONS = Object.freeze(['A (tone / numeric)', 'B (tone)', 'C (tone)', 'D (alphanumeric)']);

/** BCH(31,21) syndrome of a 32-bit codeword, parity bit included in the check. */
export function syndrome(word) {
  let w = word >>> 0;
  let acc = w >>> 1;             // the 31 protected bits
  for (let i = 30; i >= 10; i--) {
    if (acc & (1 << i)) acc ^= GENERATOR << (i - 10);
  }
  return acc & 0x3ff;
}

const parityOf = (w) => {
  let v = w >>> 0, p = 0;
  while (v) { p ^= v & 1; v >>>= 1; }
  return p;
};

/**
 * Check and, where possible, repair a codeword. Returns the corrected word and
 * how many bits were flipped, or null when it cannot be made to check. One and
 * two bit errors are correctable by this code; three are not, and a decoder
 * that tries anyway is inventing traffic.
 */
export function correct(word) {
  const w = word >>> 0;
  if (syndrome(w) === 0 && parityOf(w) === 0) return { word: w, fixed: 0 };
  for (let i = 0; i < 32; i++) {
    const one = (w ^ (1 << i)) >>> 0;
    if (syndrome(one) === 0 && parityOf(one) === 0) return { word: one, fixed: 1 };
  }
  for (let i = 0; i < 32; i++) {
    for (let j = i + 1; j < 32; j++) {
      const two = (w ^ (1 << i) ^ (1 << j)) >>> 0;
      if (syndrome(two) === 0 && parityOf(two) === 0) return { word: two, fixed: 2 };
    }
  }
  return null;
}

/**
 * Bit phase from the transitions. The preamble is alternating bits, so a
 * receiver that starts slicing at an arbitrary sample averages two bits
 * together and gets noise: sliced blind, a rendered POCSAG batch came back
 * seven bits away from its own sync word. The zero crossings of the
 * demodulated frequency happen at bit boundaries, so folding them modulo the
 * bit period puts the boundary where they pile up and the eye half a bit
 * later.
 */
export function bitPhase(freq, centre, samplesPerBit, { from = 0, to = freq.length } = {}) {
  const bins = 32;
  const hist = new Float64Array(bins);
  let flips = 0, prev = null;
  for (let i = from; i < to; i++) {
    const v = freq[i];
    if (!Number.isFinite(v)) { prev = null; continue; }
    const s = v > centre;
    if (prev !== null && s !== prev) {
      hist[Math.floor(((i / samplesPerBit) % 1) * bins) % bins] += 1;
      flips++;
    }
    prev = s;
  }
  if (!flips) return { ok: false, phase: 0, concentration: 0, flips };
  let cx = 0, cy = 0;
  for (let b = 0; b < bins; b++) { const a = 2 * Math.PI * (b + 0.5) / bins; cx += hist[b] * Math.cos(a); cy += hist[b] * Math.sin(a); }
  // The BOUNDARY, not the eye. `fskSoftBits` adds the half bit that moves a
  // boundary to the centre of the symbol after it; returning the eye here too
  // put the slicer exactly one half-bit wrong, which read a clean render as
  // seven bits away from its own sync word.
  const boundary = ((Math.atan2(cy, cx) / (2 * Math.PI)) + 1) % 1;
  return { ok: true, phase: boundary, concentration: Math.hypot(cx, cy) / flips, flips };
}

/** Slice at the eye centres: mean frequency over the middle half of each bit. */
export function fskSoftBits(freq, sampleRate, baud, { from = 0, to = freq.length, phase = 0 } = {}) {
  const spb = sampleRate / baud;
  const guard = spb * 0.25;
  const n = Math.max(0, Math.floor((to - from) / spb) - 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = from + (i + phase) * spb + spb / 2;
    let s = 0, k = 0;
    for (let j = Math.ceil(c - guard); j < c + guard && j < freq.length; j++) {
      const v = freq[j]; if (Number.isFinite(v)) { s += v; k++; }
    }
    out[i] = k ? s / k : NaN;
  }
  return out;
}

/**
 * Find the frame sync word in a bit stream at every bit offset, allowing up to
 * `maxErrors` wrong bits. POCSAG's sync word was chosen to be far from
 * everything else, so two errors is safe.
 */
export function findSync(bits, { maxErrors = 2, from = 0 } = {}) {
  const hits = [];
  for (let i = from; i + 32 <= bits.length; i++) {
    let w = 0;
    for (let k = 0; k < 32; k++) w = ((w << 1) | bits[i + k]) >>> 0;
    let d = 0, x = (w ^ SYNC_WORD) >>> 0;
    while (x) { d += x & 1; x >>>= 1; }
    if (d <= maxErrors) hits.push({ at: i, errors: d });
  }
  return hits;
}

const BCD = '0123456789*U -)(';

/** Decode one batch's codewords into messages. */
function readBatch(words, frameBase, state, stats) {
  for (let i = 0; i < words.length; i++) {
    const cw = words[i];
    if (cw === null) { stats.dropped++; state.flush('a codeword was unreadable'); continue; }
    if (cw === IDLE_WORD) { state.flush(); continue; }
    if ((cw >>> 31) === 0) {
      // Address codeword: 18 address bits at 30..13, function at 12..11.
      state.flush();
      const addr = (cw >>> 13) & 0x3ffff;
      const func = (cw >>> 11) & 0x3;
      const frame = Math.floor((frameBase + i) / 2) % 8;
      state.open((addr << 3) | frame, func);
    } else {
      // Message codeword: 20 data bits at 30..11, most significant first.
      const data = (cw >>> 11) & 0xfffff;
      state.push(data);
    }
  }
}

/**
 * Decode POCSAG from a real-valued span. `baud` forces a rate; otherwise all
 * three are tried and the one that finds the most clean sync words wins.
 */
export function decodePocsag(x, sampleRate, { baud = null, invert = null, freq = null } = {}) {
  if (!x || x.length < sampleRate * 0.2) return { ok: false, reason: 'span is under a fifth of a second' };
  const track = freq || freqOf(x, sampleRate);
  const attempts = [];
  for (const rate of (baud ? [baud] : BAUDS)) {
    for (const inv of (invert === null ? [false, true] : [invert])) {
      attempts.push({ baud: rate, invert: inv });
    }
  }
  let best = null;
  for (const a of attempts) {
    const r = attempt(x, sampleRate, a.baud, a.invert, track);
    if (!best || r.score > best.score) best = r;
  }
  if (!best || !best.syncs) {
    return {
      ok: false,
      reason: `no POCSAG frame sync at 512, 1200 or 2400 baud (the closest was ${best ? best.closest : 32} bits from the sync word)`,
      tried: BAUDS,
    };
  }
  const ok = best.messages.length > 0;
  return {
    ok,
    reason: ok ? undefined : `${best.syncs} frame sync word${best.syncs === 1 ? '' : 's'} found at ${best.baud} baud but no address codeword survived its BCH check`,
    baud: best.baud, inverted: best.invert,
    messages: best.messages,
    text: ok ? best.messages.map((m) => `${m.capcode}${m.function ? ' [' + m.function + ']' : ''}${m.text ? ': ' + m.text : ''}`).join('\n') : undefined,
    syncs: best.syncs, codewords: best.stats.total, corrected: best.stats.fixed, dropped: best.stats.dropped,
    note: ok
      ? `${best.stats.total} codewords, ${best.stats.fixed} repaired by their BCH check, ${best.stats.dropped} beyond repair and discarded`
      : null,
  };
}

function attempt(x, sampleRate, baud, invert, track) {
  const stats = { total: 0, fixed: 0, dropped: 0 };
  const freq = track;
  // Centre: the median of the frequency track. A recording with any offset in
  // its demodulator still slices correctly, and a span with only one tone has
  // no two populations and will fail the sync search rather than invent bits.
  const all = Array.from(freq).filter(Number.isFinite).sort((a, b) => a - b);
  if (all.length < 256) return { score: -1, syncs: 0, messages: [], stats, baud, invert, closest: 32 };
  const centre = all[all.length >> 1];
  const spb = sampleRate / baud;
  const clock = bitPhase(freq, centre, spb);
  if (!clock.ok) return { score: -1, syncs: 0, messages: [], stats, baud, invert, closest: 32 };
  const soft = fskSoftBits(freq, sampleRate, baud, { phase: clock.phase });
  const bits = new Uint8Array(soft.length);
  for (let i = 0; i < soft.length; i++) {
    const v = soft[i];
    // Positive shift is a zero in POCSAG, so above centre is bit 0 unless the
    // recording's sideband is flipped, which `invert` tries.
    bits[i] = Number.isFinite(v) ? ((v > centre) !== invert ? 0 : 1) : 0;
  }
  const hits = findSync(bits);
  let closest = 32;
  for (let i = 0; i + 32 <= bits.length; i += 1) {
    let w = 0; for (let k = 0; k < 32; k++) w = ((w << 1) | bits[i + k]) >>> 0;
    let d = 0, y = (w ^ SYNC_WORD) >>> 0; while (y) { d += y & 1; y >>>= 1; }
    if (d < closest) closest = d;
  }
  if (!hits.length) return { score: 0, syncs: 0, messages: [], stats, baud, invert, closest };

  const messages = [];
  const state = makeState(messages);
  let used = 0;
  let at = hits[0].at;
  const seen = new Set();
  while (at + 32 + 16 * 32 <= bits.length) {
    if (seen.has(at)) break;
    seen.add(at);
    used++;
    const words = [];
    for (let i = 0; i < 16; i++) {
      const off = at + 32 + i * 32;
      let w = 0; for (let k = 0; k < 32; k++) w = ((w << 1) | bits[off + k]) >>> 0;
      const c = correct(w);
      stats.total++;
      if (c) { stats.fixed += c.fixed; words.push(c.word); } else { words.push(null); }
    }
    readBatch(words, 0, state, stats);
    // The next batch begins immediately after this one unless a sync word says
    // otherwise within a bit or two.
    const nominal = at + 32 + 16 * 32;
    const near = hits.find((h) => Math.abs(h.at - nominal) <= 2);
    at = near ? near.at : nominal;
  }
  state.flush();
  const score = used * 10 + messages.length * 100 - stats.dropped;
  return { score, syncs: used, messages, stats, baud, invert, closest };
}

function freqOf(x, sampleRate) {
  const { re, im } = analytic(x);
  return instantaneousFreq(re, im, sampleRate);
}

function makeState(messages) {
  let open = null;
  let bitsAcc = [];
  const flush = (why) => {
    if (!open) { bitsAcc = []; return; }
    const { ascii, numeric } = render(bitsAcc);
    const m = {
      capcode: String(open.capcode).padStart(7, '0'),
      function: FUNCTIONS[open.func],
      numeric, ascii,
      text: pickText(ascii, numeric),
      truncated: !!why,
    };
    if (why) m.note = why;
    messages.push(m);
    open = null; bitsAcc = [];
  };
  return {
    flush,
    open(capcode, func) { open = { capcode, func }; bitsAcc = []; },
    push(data20) { if (open) for (let k = 19; k >= 0; k--) bitsAcc.push((data20 >> k) & 1); },
  };
}

function render(bits) {
  let ascii = '';
  for (let i = 0; i + 7 <= bits.length; i += 7) {
    let c = 0;
    // 7-bit ASCII, least significant bit first.
    for (let k = 0; k < 7; k++) c |= bits[i + k] << k;
    if (c === 0) break;
    ascii += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : (c === 0x0a || c === 0x0d ? '\n' : '�');
  }
  let numeric = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    let d = 0;
    for (let k = 0; k < 4; k++) d |= bits[i + k] << (3 - k);
    numeric += BCD[d];
  }
  return { ascii: ascii.replace(/�+$/, ''), numeric: numeric.replace(/\s+$/, '') };
}

/**
 * Which reading to show. A numeric page is digits and a handful of symbols; an
 * alphanumeric one is mostly printable text. Choosing by which reading has
 * fewer replacement characters is how a decoder avoids showing a phone number
 * as mojibake, and it is stated rather than guessed at: both readings are in
 * the result.
 */
export function pickText(ascii, numeric) {
  if (!ascii && !numeric) return '';
  const bad = (ascii.match(/�/g) || []).length;
  const printableRun = ascii.replace(/[^\x20-\x7e]/g, '').length;
  if (ascii && bad === 0 && printableRun >= 3) return ascii;
  if (numeric && /^[0-9 \-()*U]+$/.test(numeric) && numeric.replace(/[^0-9]/g, '').length >= 3) return numeric;
  return ascii || numeric;
}

/** Render POCSAG, for the tests. `messages` is [{capcode, text, numeric}]. */
export function encodePocsag(messages, sampleRate, { baud = 1200, shiftHz = 800, centreHz = 1700, amplitude = 0.5, preambleBits = 576 } = {}) {
  // A receiver's discriminator output is what a bench ever sees, so the render
  // is audio-band FSK rather than the 4.5 kHz shift used on the air: a shift
  // that puts one tone below zero aliases onto the other in a real signal, and
  // both bits then produce the same tone.
  // Codewords are laid out flat first and cut into batches afterwards. An
  // address codeword has to land in the frame its capcode's low three bits
  // name, so idle words pad up to it; the message codewords that follow it
  // must be CONSECUTIVE, including across a batch boundary, because an idle
  // word ends a message. Padding between them truncated a seven-digit numeric
  // page to five digits.
  const flat = [];
  const padToFrame = (frame) => { while (Math.floor((flat.length % 16) / 2) !== frame || flat.length % 2 !== 0) flat.push(IDLE_WORD); };
  for (const m of messages) {
    const cap = m.capcode >>> 0;
    if (cap > 0x1fffff) throw new RangeError('a POCSAG capcode is 21 bits: ' + m.capcode);
    padToFrame(cap & 7);
    flat.push(withBch((((cap >>> 3) & 0x3ffff) << 13) | ((m.func ?? 3) << 11)));
    const payload = [];
    if (m.text) { for (const ch of m.text) for (let k = 0; k < 7; k++) payload.push((ch.charCodeAt(0) >> k) & 1); }
    else if (m.numeric) { for (const ch of m.numeric) { const d = Math.max(0, BCD.indexOf(ch)); for (let k = 3; k >= 0; k--) payload.push((d >> k) & 1); } }
    // Pad the last codeword the way a real transmitter does, which is not the
    // same for the two message types: a numeric page is filled with 0xC, seen
    // as a trailing space, and an alphanumeric one with NUL, which ends the
    // string. Filling a text page with 0xC appended "3f" to a twelve-letter
    // message, because the fill nibbles read as two more characters.
    const fillNibble = m.text ? 0x0 : 0xc;
    while (payload.length % 20) { for (let k = 3; k >= 0 && payload.length % 20; k--) payload.push((fillNibble >> k) & 1); }
    for (let i = 0; i < payload.length; i += 20) {
      let d = 0;
      for (let k = 0; k < 20; k++) d = (d << 1) | (payload[i + k] || 0);
      flat.push(withBch(0x80000000 | (d << 11)));
    }
  }
  while (flat.length % 16) flat.push(IDLE_WORD);
  const bits = [];
  for (let i = 0; i < preambleBits; i++) bits.push(i % 2);
  const pushWord = (w) => { for (let k = 31; k >= 0; k--) bits.push((w >>> k) & 1); };
  for (let i = 0; i < flat.length; i += 16) {
    pushWord(SYNC_WORD);
    for (let k = 0; k < 16; k++) pushWord(flat[i + k]);
  }
  const spb = sampleRate / baud;
  // Two bits of tail. The slicer drops its last bit rather than read past the
  // end of the span, and without the tail a render came out one bit short of
  // its own final batch, which was then never read.
  const n = Math.ceil((bits.length + 2) * spb) + 1;
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const bi = Math.min(bits.length - 1, Math.floor(i / spb));
    const hz = centreHz + (bits[bi] ? -shiftHz / 2 : shiftHz / 2);
    out[i] = amplitude * Math.sin(phase);
    phase += 2 * Math.PI * hz / sampleRate;
    if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
  }
  return { samples: out, bits: bits.length };
}

/** Attach the BCH parity bits and the even overall parity to a 21-bit payload. */
export function withBch(top21) {
  let w = (top21 >>> 0) & 0xfffff800;
  let acc = w >>> 1;
  for (let i = 30; i >= 10; i--) if (acc & (1 << i)) acc ^= GENERATOR << (i - 10);
  w = (w | ((acc & 0x3ff) << 1)) >>> 0;
  if (parityOf(w)) w = (w | 1) >>> 0;
  return w >>> 0;
}
