// How English a candidate plaintext is, and — the part that matters — how
// much better that is than chance.
//
// Every hill-climbing attack in this directory needs a number to climb. The
// number itself is the mean trigram log probability of the candidate under the
// model in trigrams.js. What a solver must never do is report the best key it
// found as though finding a best were the same as finding the right one: given
// any ciphertext at all, a hill climber returns SOMETHING, and on a short or a
// wrongly-assumed message that something is a plausible-looking sentence made
// of nothing.
//
// So every solver here reports a Z SCORE against its own null: the same search
// run against the same ciphertext under keys that cannot be right, which gives
// the distribution of scores a wrong answer produces. A z of 2 is a coin
// flip dressed up. A real solution on a few hundred letters sits far past 10.
//
// Pure and node-testable.
import { PACKED, OFFSET, SCALE, TRIGRAM_LETTERS, TRIGRAM_SEEN } from './trigrams.js';

export const A = 65;
export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const decodeBase64 = (s) => {
  if (typeof atob === 'function') {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(s, 'base64'));
};

/** Trigram log10 probabilities, unpacked once. */
export const TRIGRAMS = (() => {
  const bytes = decodeBase64(PACKED);
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = OFFSET + bytes[i] * SCALE;
  return out;
})();

export const MODEL = Object.freeze({ letters: TRIGRAM_LETTERS, trigramsSeen: TRIGRAM_SEEN, source: "this repository's own prose" });

/** Letters only, upper case, as codes 0..25. */
export function letters(text) {
  const s = String(text || '').toUpperCase();
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) - A;
    if (c >= 0 && c < 26) out.push(c);
  }
  return Uint8Array.from(out);
}

export const toText = (codes) => String.fromCharCode(...Array.from(codes, (c) => c + A));

/**
 * Mean trigram log probability. Mean rather than sum so candidates of
 * different lengths are comparable, which matters when a solver is choosing
 * between key lengths.
 */
export function score(codes) {
  if (codes.length < 3) return -Infinity;
  let s = 0;
  for (let i = 0; i + 3 <= codes.length; i++) s += TRIGRAMS[codes[i] * 676 + codes[i + 1] * 26 + codes[i + 2]];
  return s / (codes.length - 2);
}

/** Index of coincidence: the chance two letters drawn at random match. */
export function indexOfCoincidence(codes) {
  const n = codes.length;
  if (n < 2) return 0;
  const f = new Float64Array(26);
  for (const c of codes) f[c]++;
  let s = 0;
  for (let i = 0; i < 26; i++) s += f[i] * (f[i] - 1);
  return s / (n * (n - 1));
}

// English runs near 0.0667; a uniform random string over 26 letters near
// 0.0385. Both are properties of the alphabet, not of this corpus.
export const IC_ENGLISH = 0.0667;
export const IC_RANDOM = 1 / 26;

/**
 * Turn a raw score into a z score against a null distribution of scores from
 * keys that cannot be right. `nullScores` is that sample.
 */
export function zAgainstNull(best, nullScores) {
  const n = nullScores.length;
  // One sample has no spread, and a z computed from it is zero however good
  // the answer is — which reads as "not solved" for a perfect decrypt. Two is
  // the minimum that can say anything, and below that the result says the z
  // is unavailable rather than reporting a number that means nothing.
  if (n < 2) return { z: NaN, nullMean: n ? nullScores[0] : 0, nullSd: 0, samples: n, note: 'a z score needs at least two null runs' };
  let mean = 0;
  for (const v of nullScores) mean += v;
  mean /= n;
  let varr = 0;
  for (const v of nullScores) varr += (v - mean) ** 2;
  const sd = Math.sqrt(varr / Math.max(1, n - 1));
  return { z: sd > 0 ? (best - mean) / sd : 0, nullMean: +mean.toFixed(4), nullSd: +sd.toFixed(4), samples: n };
}

/**
 * What a z score licenses, in words. The bands are not conventional
 * significance levels dressed up — they are where this model's own separation
 * sits, measured in the test suite on English against shuffled English.
 */
/**
 * The bar for calling something solved. Measured rather than chosen: across
 * 200- and 600-letter uniform random strings at three seeds, the best of the
 * four classical attacks reached z 4.0, and every genuine solution in the test
 * suite sits above 8. Five is the gap between them, and three — the usual
 * "significant" — is inside the noise.
 */
export const SOLVED_Z = 5;

/**
 * And the bar for calling a candidate plaintext English at all.
 *
 * A z score says a key beat the wrong keys; it does not say the result is a
 * language. Those are different questions and conflating them produced a real
 * wrong answer: on a Vigenere message the transposition solver reached z 9.8 —
 * higher than the Vigenere solver's 9.4 — because its own null happened to
 * have a very tight spread, while its "plaintext" scored -5.13, which is
 * shuffled-letters territory. A z is only comparable to other z scores from
 * the SAME search.
 *
 * Measured on text this corpus has never seen, in 120-letter samples:
 *
 *   English          -3.65 to -3.28
 *   English shuffled -5.05 to -4.57
 *   uniform random   -6.05 to -5.40
 *
 * The gap between English and its own shuffle is where the bar goes.
 */
export const ENGLISH_SCORE = -4.1;

export function verdictFor(z, { letters: n = 0 } = {}) {
  if (!Number.isFinite(z)) return { confident: false, text: 'no z score: the search needs at least two null runs to know what a wrong answer looks like' };
  if (z >= 8) return { confident: true, text: `${z.toFixed(1)} standard deviations above what wrong keys produce — this is the message` };
  if (z >= SOLVED_Z) return { confident: true, text: `${z.toFixed(1)} above the null; solid, though ${n} letters is not many` };
  if (z >= 3) return { confident: false, text: `${z.toFixed(1)} above the null — suggestive, not solved. A wrong key on noise reaches 4` };
  return { confident: false, text: `${z.toFixed(1)} above the null, which is what a wrong key looks like. This is not a solution` };
}

/** Deterministic PRNG, so a search can be replayed exactly from its seed. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
