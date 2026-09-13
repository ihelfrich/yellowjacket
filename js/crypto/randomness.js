// Is this breakable at all?
//
// The most useful thing a bench can say about a numbers station is usually
// not a decrypt. It is that the traffic is consistent with a one-time pad, and
// that therefore no amount of computation will ever read it — not because the
// cipher is strong in the way a modern algorithm is strong, but because a
// message enciphered with truly random key material as long as itself has no
// unique solution. Every plaintext of that length is equally consistent with
// what was sent. That is a theorem, not an engineering claim, and a bench that
// says it plainly is more useful than one that runs a solver for a week.
//
// This module tests for the structure that would make a message breakable, and
// reports what it found rather than a verdict alone:
//
//   - Index of coincidence against the uniform expectation, with the standard
//     error of the estimate, so "0.041" comes with what 0.041 means on a
//     message of this length.
//   - A chi-squared goodness of fit over the alphabet.
//   - Repeated groups. A code book reuses its groups, and a five-figure group
//     appearing three times in one message is a code, not a pad.
//   - Repeated substrings and the distances between them — the Kasiski test.
//     A repeat whose distance shares a factor with other repeats is a periodic
//     key, which is the single most common way a "one-time" pad turns out not
//     to have been.
//   - The serial correlation of successive symbols, which catches a generator
//     that is not as random as its user believed.
//
// Nothing here can prove randomness. The honest statement, and the one it
// makes, is that a message showed none of the structure these tests look for,
// alongside how much structure they would have caught at this length.
//
// Pure and node-testable.

/** Symbols as integer codes over a named alphabet. */
export function symbols(text, alphabet) {
  const map = new Map();
  for (let i = 0; i < alphabet.length; i++) map.set(alphabet[i], i);
  const out = [];
  for (const ch of String(text || '').toUpperCase()) if (map.has(ch)) out.push(map.get(ch));
  return Uint8Array.from(out);
}

export const DIGITS = '0123456789';
export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Pick the alphabet the text is actually written in. */
export function alphabetOf(text) {
  const s = String(text || '').toUpperCase();
  let d = 0, a = 0;
  for (const ch of s) { if (ch >= '0' && ch <= '9') d++; else if (ch >= 'A' && ch <= 'Z') a++; }
  if (!d && !a) return null;
  return d >= a ? { name: 'digits', alphabet: DIGITS } : { name: 'letters', alphabet: LETTERS };
}

/**
 * Index of coincidence, with the value a uniform source of this alphabet would
 * give and the standard error of the estimate at this length. Reporting the
 * error is the whole point: on 60 symbols an IC of 0.11 against an expected
 * 0.10 means nothing at all.
 */
export function ic(codes, k) {
  const n = codes.length;
  if (n < 2) return { value: 0, expected: 1 / k, se: Infinity, z: 0 };
  const f = new Float64Array(k);
  for (const c of codes) f[c]++;
  let s = 0;
  for (let i = 0; i < k; i++) s += f[i] * (f[i] - 1);
  const value = s / (n * (n - 1));
  const expected = 1 / k;
  // Variance of the IC for a uniform multinomial, to leading order in n.
  const se = Math.sqrt(2 * (k - 1) / (k * k * n * (n - 1)));
  return { value: +value.toFixed(5), expected: +expected.toFixed(5), se: +se.toFixed(5), z: +((value - expected) / se).toFixed(2) };
}

/** Chi-squared over the alphabet, with its degrees of freedom. */
export function chiSquared(codes, k) {
  const n = codes.length;
  const f = new Float64Array(k);
  for (const c of codes) f[c]++;
  const e = n / k;
  let chi = 0;
  for (let i = 0; i < k; i++) chi += (f[i] - e) ** 2 / e;
  const df = k - 1;
  // Wilson-Hilferty: chi-squared to a standard normal, good enough to say
  // whether a frequency profile is unusual without a table.
  const z = (Math.cbrt(chi / df) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
  return { chi: +chi.toFixed(2), df, z: +z.toFixed(2), counts: Array.from(f, (v) => v) };
}

/** Groups of `size` that occur more than once, commonest first. */
export function repeatedGroups(codes, size = 5, alphabet = DIGITS) {
  const seen = new Map();
  for (let i = 0; i + size <= codes.length; i += size) {
    let key = '';
    for (let j = 0; j < size; j++) key += alphabet[codes[i + j]];
    const at = seen.get(key) || [];
    at.push(i / size);
    seen.set(key, at);
  }
  const repeats = [...seen.entries()].filter(([, at]) => at.length > 1)
    .map(([group, at]) => ({ group, count: at.length, at }))
    .sort((a, b) => b.count - a.count);
  const groups = Math.floor(codes.length / size);
  // How many repeats chance alone gives: the birthday problem over k^size
  // possible groups.
  const space = alphabet.length ** size;
  const expected = groups > 1 ? (groups * (groups - 1)) / (2 * space) : 0;
  return { repeats, groups, expectedByChance: +expected.toFixed(3) };
}

/**
 * Repeated substrings and the distances between them — Kasiski. A periodic key
 * puts the same plaintext through the same key at a distance that is a
 * multiple of the period, so shared factors among the distances are the
 * period.
 */
export function kasiski(codes, { k = 26, maxLength = 12, expectedCap = 0.5 } = {}) {
  // A substring length is only useful if chance would not already produce
  // repeats at it. With ten digits and 500 symbols there are a thousand
  // three-digit strings and 125,000 pairs of positions, so a genuine one-time
  // pad shows about 125 three-digit repeats and calling that a finding marks
  // every pad "breakable" — which the first version of this did. The shortest
  // useful length is where the expected number of chance repeats drops below
  // `expectedCap`.
  const n = codes.length;
  const pairs = (len) => Math.max(0, (n - len + 1) * (n - len) / 2);
  let minLength = 2;
  while (minLength <= maxLength && pairs(minLength) / k ** minLength > expectedCap) minLength++;
  if (minLength > maxLength) {
    return { repeats: 0, distances: [], topFactors: [], minLength: null, reason: `no substring length is long enough to be unlikely by chance in ${n} symbols` };
  }
  const distances = [];
  const found = [];
  let expected = 0;
  for (let L = minLength; L <= Math.min(maxLength, Math.floor(n / 3)); L++) {
    expected += pairs(L) / k ** L;
    const seen = new Map();
    for (let i = 0; i + L <= n; i++) {
      const key = Array.from(codes.subarray(i, i + L)).join(',');
      const at = seen.get(key);
      if (at !== undefined) { distances.push(i - at); found.push({ length: L, gap: i - at, at: [at, i] }); }
      seen.set(key, i);
    }
  }
  // Factors of the distances, which is where a period shows itself.
  const factors = new Map();
  for (const d of distances) {
    for (let f = 2; f <= Math.min(40, d); f++) if (d % f === 0) factors.set(f, (factors.get(f) || 0) + 1);
  }
  // Among the factors that explain the most distances, the LARGEST is the
  // period: every divisor of the true period explains exactly the same
  // distances, so sorting by count alone reports 2 for a six-letter key. Ties
  // on count break towards the bigger factor, which is the Kasiski reading.
  const ranked = [...factors.entries()].map(([factor, count]) => ({ factor, count }))
    .sort((a, b) => b.count - a.count || b.factor - a.factor);
  return {
    repeats: found.length, distances, topFactors: ranked.slice(0, 6),
    minLength, expectedByChance: +expected.toFixed(3),
    excess: +(found.length - expected).toFixed(2),
    found: found.slice(0, 12),
  };
}

/** Correlation between each symbol and the next. A pad has none. */
export function serialCorrelation(codes, k) {
  const n = codes.length - 1;
  if (n < 8) return { r: 0, z: 0 };
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = codes[i], y = codes[i + 1];
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  const r = den > 0 ? num / den : 0;
  return { r: +r.toFixed(4), z: +(r * Math.sqrt(n - 1)).toFixed(2) };
}

/**
 * The whole battery, with a verdict.
 *
 * `ok` here does not mean "solved". It means the tests ran. `breakable` is
 * what a reader wants: whether anything was found that a cryptanalyst could
 * pull on.
 */
export function assess(text, { groupSize = 5 } = {}) {
  const found = alphabetOf(text);
  if (!found) return { ok: false, reason: 'no letters or digits in this text' };
  const { alphabet, name } = found;
  const codes = symbols(text, alphabet);
  const k = alphabet.length;
  if (codes.length < 40) {
    return { ok: false, reason: `${codes.length} ${name} is too few to test: at this length a one-time pad and a Caesar shift look the same` };
  }
  const icR = ic(codes, k);
  const chi = chiSquared(codes, k);
  const groups = repeatedGroups(codes, groupSize, alphabet);
  const kas = kasiski(codes, { k });
  const serial = serialCorrelation(codes, k);

  const findings = [];
  if (Math.abs(icR.z) > 3) {
    findings.push({
      test: 'index of coincidence',
      what: `${icR.value} against ${icR.expected} expected, ${icR.z} standard errors away`,
      means: icR.value > icR.expected
        ? 'symbols repeat more than a random source would — this is a cipher with structure, or plaintext'
        : 'symbols repeat LESS than random, which a pad does not do either',
    });
  }
  if (Math.abs(chi.z) > 3) {
    findings.push({
      test: 'frequency',
      what: `chi-squared ${chi.chi} on ${chi.df} degrees of freedom, ${chi.z} standard deviations out`,
      means: 'the symbols are not equally likely, so the key is not uniform',
    });
  }
  const excess = groups.repeats.length - groups.expectedByChance;
  if (groups.repeats.length && excess > 2) {
    findings.push({
      test: 'repeated groups',
      what: `${groups.repeats.length} groups of ${groupSize} repeat, where chance gives ${groups.expectedByChance}`,
      means: 'a code book reuses its groups; a pad never repeats. The commonest are ' + groups.repeats.slice(0, 4).map((r) => `${r.group} x${r.count}`).join(', '),
    });
  }
  const top = kas.topFactors[0];
  // Only an EXCESS of repeats over what chance gives, and only when a factor
  // explains most of them. Without the excess test a genuine pad was flagged
  // breakable on repeats it was always going to have.
  if (kas.repeats >= 2 && kas.excess > 1.5 && top && top.count >= Math.max(2, kas.repeats * 0.5)) {
    findings.push({
      test: 'Kasiski',
      what: `${kas.repeats} repeated substrings of ${kas.minLength} or more, where chance gives ${kas.expectedByChance}; `
        + `${top.count} of their distances divide by ${top.factor}`,
      means: `the key may repeat every ${top.factor} symbols, which would make this a periodic cipher and breakable`,
    });
  }
  if (Math.abs(serial.z) > 3) {
    findings.push({
      test: 'serial correlation',
      what: `successive symbols correlate ${serial.r} (${serial.z} standard errors)`,
      means: 'the key generator has memory — it is not a pad, whatever it was called',
    });
  }

  const breakable = findings.length > 0;
  // What the tests could have caught at this length, so a clean result is read
  // as "nothing found here" and not as proof.
  const sensitivity = {
    icDetectableShift: +(3 * icR.se).toFixed(5),
    groupsAtThisLength: groups.groups,
    kasiskiRepeats: kas.repeats,
    kasiskiShortestUsefulLength: kas.minLength,
  };
  return {
    ok: true,
    alphabet: name, symbols: codes.length,
    ic: icR, chiSquared: chi, repeatedGroups: groups, kasiski: kas, serial,
    findings, breakable, sensitivity,
    text: breakable
      ? `structure found: ${findings.map((f) => f.test).join(', ')}`
      : 'no structure found — consistent with a one-time pad',
    verdict: breakable
      ? `This has structure a cryptanalyst can use. ${findings.length} test${findings.length === 1 ? '' : 's'} found something; the strongest is ${findings[0].test}.`
      : `Nothing in ${codes.length} ${name} departs from a uniform random source by more than three standard errors. `
        + 'If this is a one-time pad used once, it has no unique solution and no amount of computation will read it — every message of this '
        + `length is equally consistent with what was sent. What this does NOT say is that the traffic is random: these tests would have caught `
        + `an index of coincidence off by ${(3 * icR.se).toFixed(4)}, a repeating key showing in ${kas.repeats} substring repeats, and a reused `
        + `code group among ${groups.groups}. A pad reused twice, or a key shorter than the message, would show here. Nothing else would.`,
  };
}
