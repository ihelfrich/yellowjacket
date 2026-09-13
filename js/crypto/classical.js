// Breaking classical ciphers by hill climbing, and — the part most
// implementations leave out — saying how likely the answer is to be wrong.
//
// A hill climber always returns something. Hand it a random string, an
// encrypted file, a message in the wrong language or a one-time pad, and it
// will still hand back its best key and a plaintext that reads as though
// someone wrote it, because the search is optimising exactly the statistic a
// reader uses to judge the result. That is how people convince themselves they
// have solved the Zodiac ciphers.
//
// Every solver here therefore runs its own null: the same climb, the same
// number of restarts, against the same ciphertext scrambled so that no key can
// be right. The spread of those scores is what a wrong answer looks like on
// THIS ciphertext at THIS length, and the solution is reported as a z score
// against it. Below z 3 the module says in words that this is not a solution.
//
// Pure and node-testable. Deterministic from the seed, so a result can be
// reproduced exactly.
import { letters, toText, score, indexOfCoincidence, zAgainstNull, verdictFor, rng, IC_ENGLISH, IC_RANDOM, SOLVED_Z, ENGLISH_SCORE } from './fitness.js';

// ------------------------------------------------------------------ Caesar

const bestCaesar = (codes) => {
  let best = null;
  for (let k = 0; k < 26; k++) {
    const p = Uint8Array.from(codes, (v) => (v - k + 26) % 26);
    const s = score(p);
    if (!best || s > best.score) best = { shift: k, score: s, plain: p };
  }
  return best;
};

/**
 * Every shift, scored. Exhaustive: there are twenty-six.
 *
 * The null is NOT the other twenty-five shifts. The best of twenty-six draws
 * sits about two standard deviations above their mean whatever the draws are,
 * so scoring the winner against its own losers makes random text look solved:
 * measured, that null put 200 letters of uniform noise at z 3.0, over the bar.
 * The null is the same best-of-twenty-six run against shuffled copies, which
 * carries the same selection effect and cannot succeed.
 */
export function solveCaesar(text, { seed = 1, nulls: nullRuns = 24 } = {}) {
  const c = letters(text);
  if (c.length < 12) return { ok: false, cipher: 'caesar', reason: `${c.length} letters is too few to tell one shift from another` };
  const best = bestCaesar(c);
  const rand = rng(seed ^ 0x27d4eb2f);
  const nulls = [];
  for (let r = 0; r < nullRuns; r++) {
    const sc = Uint8Array.from(c);
    for (let i = sc.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = sc[i]; sc[i] = sc[j]; sc[j] = t; }
    nulls.push(bestCaesar(sc).score);
  }
  const z = zAgainstNull(best.score, nulls);
  return {
    ok: Number.isFinite(z.z) && z.z >= SOLVED_Z && best.score >= ENGLISH_SCORE, cipher: 'caesar', key: best.shift, plaintext: toText(best.plain),
    score: +best.score.toFixed(4), ...z, z: +z.z.toFixed(2), letters: c.length,
    verdict: verdictFor(z.z, { letters: c.length }),
  };
}

// ------------------------------------------------- monoalphabetic substitution

function decodeWith(codes, key) {
  const out = new Uint8Array(codes.length);
  for (let i = 0; i < codes.length; i++) out[i] = key[codes[i]];
  return out;
}

/**
 * One hill climb: start from a key, swap two letters at a time, keep any swap
 * that improves the score, stop when a full pass improves nothing.
 */
function climbSubstitution(codes, start, rand) {
  const key = Uint8Array.from(start);
  let best = score(decodeWith(codes, key));
  for (;;) {
    let improved = false;
    for (let i = 0; i < 26; i++) {
      for (let j = i + 1; j < 26; j++) {
        const t = key[i]; key[i] = key[j]; key[j] = t;
        const s = score(decodeWith(codes, key));
        if (s > best) { best = s; improved = true; }
        else { const u = key[i]; key[i] = key[j]; key[j] = u; }
      }
    }
    if (!improved) break;
  }
  return { key, score: best };
}

function shuffled(rand) {
  const k = Uint8Array.from({ length: 26 }, (_, i) => i);
  for (let i = 25; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = k[i]; k[i] = k[j]; k[j] = t; }
  return k;
}

/**
 * Monoalphabetic substitution. `restarts` climbs from that many random keys
 * and keeps the best; the same number of climbs run against a scrambled copy
 * of the ciphertext to build the null.
 */
export function solveSubstitution(text, { restarts = 24, seed = 1 } = {}) {
  const c = letters(text);
  if (c.length < 40) return { ok: false, cipher: 'substitution', reason: `${c.length} letters is too few to break a substitution; below about forty every key looks as good as every other` };
  const rand = rng(seed);
  let best = null;
  for (let r = 0; r < restarts; r++) {
    const got = climbSubstitution(c, shuffled(rand), rand);
    if (!best || got.score > best.score) best = got;
  }
  // The null: the same ciphertext with its letters shuffled, so its frequency
  // profile is intact and its structure is gone. A climb against that is a
  // climb that cannot succeed, and its scores are what failure looks like here.
  const nullRand = rng(seed ^ 0x5bf03635);
  const scrambled = Uint8Array.from(c);
  for (let i = scrambled.length - 1; i > 0; i--) { const j = Math.floor(nullRand() * (i + 1)); const t = scrambled[i]; scrambled[i] = scrambled[j]; scrambled[j] = t; }
  const nulls = [];
  for (let r = 0; r < Math.max(6, restarts >> 1); r++) nulls.push(climbSubstitution(scrambled, shuffled(nullRand), nullRand).score);
  const z = zAgainstNull(best.score, nulls);
  const plain = decodeWith(c, best.key);
  return {
    ok: Number.isFinite(z.z) && z.z >= SOLVED_Z && best.score >= ENGLISH_SCORE, cipher: 'substitution',
    key: toText(Uint8Array.from({ length: 26 }, (_, i) => best.key[i])),
    plaintext: toText(plain), score: +best.score.toFixed(4),
    ...z, z: +z.z.toFixed(2), restarts, letters: c.length,
    verdict: verdictFor(z.z, { letters: c.length }),
  };
}

// --------------------------------------------------------------- Vigenère

/** Index of coincidence per candidate key length, averaged over the columns. */
export function keyLengthProfile(codes, { maxLength = 20 } = {}) {
  const out = [];
  for (let L = 1; L <= Math.min(maxLength, Math.floor(codes.length / 4)); L++) {
    let sum = 0;
    for (let off = 0; off < L; off++) {
      const col = [];
      for (let i = off; i < codes.length; i += L) col.push(codes[i]);
      sum += indexOfCoincidence(Uint8Array.from(col));
    }
    out.push({ length: L, ic: +(sum / L).toFixed(4) });
  }
  return out;
}

const ENGLISH_FREQ = Object.freeze([
  0.08167, 0.01492, 0.02782, 0.04253, 0.12702, 0.02228, 0.02015, 0.06094, 0.06966, 0.00153,
  0.00772, 0.04025, 0.02406, 0.06749, 0.07507, 0.01929, 0.00095, 0.05987, 0.06327, 0.09056,
  0.02758, 0.00978, 0.02360, 0.00150, 0.01974, 0.00074,
]);

/** The shift for one column, by chi-squared against English letter frequency. */
function bestShift(col) {
  let best = 0, bestChi = Infinity;
  for (let k = 0; k < 26; k++) {
    const f = new Float64Array(26);
    for (const v of col) f[(v - k + 26) % 26]++;
    let chi = 0;
    for (let i = 0; i < 26; i++) { const e = ENGLISH_FREQ[i] * col.length; chi += e > 0 ? (f[i] - e) ** 2 / e : 0; }
    if (chi < bestChi) { bestChi = chi; best = k; }
  }
  return best;
}

/**
 * Vigenère. The key length comes from the index of coincidence — a periodic
 * polyalphabetic cipher raises the IC of every column back towards English —
 * and each column is then a Caesar shift solved by chi-squared. The result is
 * refined by hill climbing on the key letters, which repairs a column the
 * frequency test got wrong on a short message.
 */
export function solveVigenere(text, { maxLength = 20, seed = 1, nulls: nullRuns = 10 } = {}) {
  const c = letters(text);
  if (c.length < 30) return { ok: false, cipher: 'vigenere', reason: `${c.length} letters is too few for a periodic cipher to show its period` };

  // The whole attack as one function, so the null can run it unchanged. The
  // first version's null used the chi-squared pass WITHOUT the hill climb that
  // the real attack ends with, which is a weaker procedure and therefore a
  // lower bar: measured, 200 letters of uniform noise came back "solved" at
  // z 7.3. A null has to be the same search against a ciphertext that cannot
  // be solved, not an easier search against one.
  const attack = (codes) => {
    const profile = keyLengthProfile(codes, { maxLength });
    const target = (IC_ENGLISH + IC_RANDOM) / 2;
    const plausible = profile.filter((p) => p.ic >= target).sort((a, b) => a.length - b.length);
    const candidates = plausible.length ? plausible.slice(0, 4) : profile.slice().sort((a, b) => b.ic - a.ic).slice(0, 4);
    let best = null;
    for (const cand of candidates) {
      const L = cand.length;
      const key = new Uint8Array(L);
      for (let off = 0; off < L; off++) {
        const col = [];
        for (let i = off; i < codes.length; i += L) col.push(codes[i]);
        key[off] = bestShift(col);
      }
      // Then hill climb the key letters against the trigram model, which
      // repairs a column the frequency test got wrong: on a 180-letter
      // message the chi-squared pass alone put a U where a K belonged,
      // because one column of fifteen letters is not enough for a frequency
      // profile to settle.
      const decode = (k) => Uint8Array.from(codes, (v, i) => (v - k[i % k.length] + 26) % 26);
      let s = score(decode(key));
      for (let pass = 0; pass < 12; pass++) {
        let improved = false;
        for (let off = 0; off < L; off++) {
          let bestLetter = key[off], bestScore = s;
          for (let k = 0; k < 26; k++) {
            key[off] = k;
            const t = score(decode(key));
            if (t > bestScore) { bestScore = t; bestLetter = k; }
          }
          key[off] = bestLetter;
          if (bestScore > s) { s = bestScore; improved = true; }
        }
        if (!improved) break;
      }
      const got = { length: L, key: Uint8Array.from(key), score: s, plain: decode(key), ic: cand.ic, profile };
      if (!best || got.score > best.score) best = got;
    }
    return best;
  };

  const best = attack(c);
  const rand = rng(seed ^ 0x2545f491);
  const nulls = [];
  for (let r = 0; r < nullRuns; r++) {
    const sc = Uint8Array.from(c);
    for (let i = sc.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = sc[i]; sc[i] = sc[j]; sc[j] = t; }
    const got = attack(sc);
    if (got) nulls.push(got.score);
  }
  const z = zAgainstNull(best.score, nulls);
  return {
    ok: Number.isFinite(z.z) && z.z >= SOLVED_Z && best.score >= ENGLISH_SCORE, cipher: 'vigenere',
    key: toText(best.key), keyLength: best.length,
    plaintext: toText(best.plain), score: +best.score.toFixed(4),
    ...z, z: +z.z.toFixed(2), letters: c.length,
    keyLengthProfile: best.profile,
    verdict: verdictFor(z.z, { letters: c.length }),
  };
}

// -------------------------------------------------- columnar transposition

function readColumns(codes, order) {
  const cols = order.length, rows = Math.ceil(codes.length / cols);
  const full = codes.length % cols;
  const heights = Array.from({ length: cols }, (_, i) => (full === 0 || i < full ? rows : rows - 1));
  const byCol = new Array(cols);
  let at = 0;
  for (const c of order) { byCol[c] = codes.slice(at, at + heights[c]); at += heights[c]; }
  const out = new Uint8Array(codes.length);
  let o = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (r < byCol[c].length) out[o++] = byCol[c][r];
  return out.subarray(0, o);
}

/**
 * Columnar transposition. The letters are English already, so the frequency
 * profile says nothing and only the ORDER carries the key — which is why the
 * trigram model is the whole attack here rather than a refinement of it.
 */
export function solveTransposition(text, { minCols = 2, maxCols = 12, restarts = 12, seed = 1 } = {}) {
  const c = letters(text);
  if (c.length < 40) return { ok: false, cipher: 'transposition', reason: `${c.length} letters is too few to see a column order` };
  const rand = rng(seed);
  const attack = (codes) => {
    let best = null;
    for (let cols = minCols; cols <= Math.min(maxCols, Math.floor(codes.length / 3)); cols++) {
      for (let r = 0; r < restarts; r++) {
        const order = Uint8Array.from({ length: cols }, (_, i) => i);
        for (let i = cols - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
        let s = score(readColumns(codes, order));
        for (;;) {
          let improved = false;
          for (let i = 0; i < cols; i++) {
            for (let j = i + 1; j < cols; j++) {
              const t = order[i]; order[i] = order[j]; order[j] = t;
              const v = score(readColumns(codes, order));
              if (v > s) { s = v; improved = true; } else { const u = order[i]; order[i] = order[j]; order[j] = u; }
            }
          }
          if (!improved) break;
        }
        if (!best || s > best.score) best = { cols, order: Uint8Array.from(order), score: s };
      }
    }
    return best;
  };
  const best = attack(c);
  const nullRand = rng(seed ^ 0x1b873593);
  const scrambled = Uint8Array.from(c);
  for (let i = scrambled.length - 1; i > 0; i--) { const j = Math.floor(nullRand() * (i + 1)); const t = scrambled[i]; scrambled[i] = scrambled[j]; scrambled[j] = t; }
  const nulls = [];
  for (let r = 0; r < 8; r++) { const got = attack(scrambled); if (got) nulls.push(got.score); }
  const z = zAgainstNull(best.score, nulls);
  return {
    ok: Number.isFinite(z.z) && z.z >= SOLVED_Z && best.score >= ENGLISH_SCORE, cipher: 'transposition',
    columns: best.cols, order: Array.from(best.order),
    plaintext: toText(readColumns(c, best.order)), score: +best.score.toFixed(4),
    ...z, z: +z.z.toFixed(2), letters: c.length,
    verdict: verdictFor(z.z, { letters: c.length }),
  };
}

// -------------------------------------------------------------- encipher

export const encipherCaesar = (text, shift) => toText(Uint8Array.from(letters(text), (v) => (v + shift) % 26));
export const encipherVigenere = (text, key) => {
  const k = letters(key);
  return toText(Uint8Array.from(letters(text), (v, i) => (v + k[i % k.length]) % 26));
};
export function encipherSubstitution(text, keyText) {
  const k = letters(keyText);
  const inv = new Uint8Array(26);
  for (let i = 0; i < 26; i++) inv[k[i]] = i;
  return toText(Uint8Array.from(letters(text), (v) => inv[v]));
}
export function encipherTransposition(text, order) {
  const c = letters(text), cols = order.length, rows = Math.ceil(c.length / cols);
  const byCol = Array.from({ length: cols }, () => []);
  for (let i = 0; i < c.length; i++) byCol[i % cols].push(c[i]);
  const out = [];
  for (const col of order) out.push(...byCol[col]);
  return toText(Uint8Array.from(out)) + (rows ? '' : '');
}

/**
 * Try every cipher this module knows and rank them. The answer a reader wants
 * is usually "which of these is it", and the z scores make that comparable:
 * the right cipher beats the others by a wide margin, and when nothing beats
 * anything the honest answer is that none of them is it.
 */
export function solveClassical(text, opts = {}) {
  const tried = [solveCaesar(text, opts), solveVigenere(text, opts), solveSubstitution(text, opts), solveTransposition(text, opts)]
    .filter((r) => r && Number.isFinite(r.z));
  // Rank by how English the plaintext is, not by z. A z compares a key against
  // other keys for the SAME cipher and is not comparable across ciphers: on a
  // Vigenere message the transposition solver reached z 9.8 against the
  // Vigenere solver's 9.4, purely because its null had a tighter spread, while
  // its output scored -5.13 and read as noise. Candidates that cleared their
  // own null come first, and among them the most English wins.
  tried.sort((a, b) => (b.ok ? 1 : 0) - (a.ok ? 1 : 0) || b.score - a.score);
  const best = tried[0] || null;
  return {
    ok: !!(best && best.ok),
    best,
    ranked: tried.map((r) => ({ cipher: r.cipher, z: r.z, score: r.score, ok: r.ok })),
    englishBar: ENGLISH_SCORE,
    reason: best && best.ok ? undefined
      : `no classical cipher this module knows fits: the best was ${best ? best.cipher : 'none'} at z ${best ? best.z : 0}, `
        + `and a wrong key on uniform noise reaches 4. Either it is a cipher not tried here, not English, or not breakable this way.`,
  };
}
