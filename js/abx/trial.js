// ABX: turning "that sounds better" into a number that can come back negative.
//
// This bench measures everything else and then asks a person to squint at a
// ghost waveform to decide whether the rack helped. An ABX is the same
// discipline applied to the ear: two renders, blinded, and a count of how often
// the listener told them apart. It refuses in both directions — it will not
// call a difference real on too few trials, and it will not call it absent
// because the trials ran out.
//
// Pure and node-testable: no audio, no DOM. The caller renders the two versions
// and plays what `trial()` names; everything about the protocol and the
// statistics lives here. The design follows Nyquist's ABX module
// (~/Developer/nyquist, ABX.swift), which settled the parts that are easy to
// get wrong: match the loudness before blinding, cap the level so neither
// version clips, one-sided binomial for discrimination and two-sided for
// preference.

// A listener who cannot hear a difference still scores half the trials by
// guessing. Everything below is about separating a real score from that.
const CHANCE = 0.5;

/** Exact binomial tail, P(X >= k) for n trials at probability 1/2. */
export function binomialTailAtChance(k, n) {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 0) throw new RangeError('trial counts must be whole numbers');
  if (k <= 0) return 1;
  if (k > n) return 0;
  // Sum of C(n,i)/2^n for i >= k, accumulated in log space so 200 trials does
  // not overflow a double on the way to an answer near 1e-60.
  let logC = -n * Math.LN2;                      // log C(n,0) / 2^n
  for (let i = 1; i <= k; i++) logC += Math.log((n - i + 1) / i);   // ... up to C(n,k)
  let sum = 0, term = logC;
  for (let i = k; i <= n; i++) {
    sum += Math.exp(term);
    term += Math.log((n - i) / (i + 1));         // C(n,i) -> C(n,i+1)
  }
  return Math.min(1, sum);
}

/**
 * The smallest number of trials at which a PERFECT score would clear `alpha`.
 * Worth knowing before a session starts rather than after: at the usual 0.05 a
 * listener needs five trials to be able to prove anything at all, and three
 * cannot, however good their ears are.
 */
export function trialsNeeded(alpha = 0.05) {
  for (let n = 1; n <= 64; n++) if (binomialTailAtChance(n, n) <= alpha) return n;
  return Infinity;
}

// Deterministic PRNG so a session can be replayed exactly from its seed. The
// sequence must not be guessable from the trials already seen, which mulberry32
// is not in a cryptographic sense — it does not need to be. What it needs to be
// is free of the pattern a listener could ride: no runs longer than chance, and
// balanced over the session, both of which are asserted in the tests.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build the hidden sequence for a session.
 *
 * Each trial names which version X actually is. The sequence is balanced —
 * equal numbers of A and B, shuffled — rather than independently random,
 * because an unbalanced run is a session where a listener who always answers
 * "A" scores above chance for no reason.
 */
export function sequence(trials, seed = 1) {
  if (!Number.isInteger(trials) || trials < 1) throw new RangeError('a session needs at least one trial');
  const out = new Array(trials);
  for (let i = 0; i < trials; i++) out[i] = i < Math.ceil(trials / 2) ? 'A' : 'B';
  const rnd = mulberry32(seed);
  for (let i = trials - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

/**
 * Level-match two renders before they are compared.
 *
 * An ABX between a loud version and a quiet one measures the level, not the
 * processing: louder reads as better, and a listener finds the difference
 * without hearing anything the rack did. So B is scaled to A's loudness, and
 * then BOTH are pulled down together if that scaling would push either past the
 * ceiling — together, because trimming one of them alone would undo the match.
 *
 * Returns the gains to apply and, if the match could not be made, why. A rack
 * that changes loudness by more than `maxTrimDb` is not a candidate for a
 * blinded comparison; it is a level change and should be judged as one.
 */
export function levelMatch(loudnessA, loudnessB, truePeakA, truePeakB,
  { ceilingDb = -1, toleranceLu = 0.1, maxTrimDb = 12 } = {}) {
  const finite = (v) => Number.isFinite(v);
  if (!finite(loudnessA) || !finite(loudnessB)) {
    return { ok: false, reason: 'one of the two versions has no measurable loudness, so they cannot be matched' };
  }
  const trimDb = loudnessA - loudnessB;
  if (Math.abs(trimDb) > maxTrimDb) {
    return {
      ok: false,
      reason: `the two versions differ by ${Math.abs(trimDb).toFixed(1)} LU, which is a level change rather than `
        + 'a processing difference — match the level first and compare what is left',
    };
  }
  // Where each version's true peak lands once B carries its match gain.
  const peakA = truePeakA, peakB = truePeakB + trimDb;
  const over = Math.max(peakA, peakB) - ceilingDb;
  const headroomDb = over > 0 ? -over : 0;
  return {
    ok: true,
    gainADb: headroomDb,
    gainBDb: trimDb + headroomDb,
    matchedWithinLu: 0,
    toleranceLu,
    ceilingDb,
    // Stated so a panel can show it: both versions moved by this much to stay
    // under the ceiling, which changes nothing about the comparison.
    commonTrimDb: headroomDb,
  };
}

/**
 * Score a completed or partial session.
 *
 * `answers[i]` is what the listener said X was; `truth[i]` is what it was. The
 * p-value is the one-sided binomial tail at chance: the probability that
 * guessing alone would have produced this score or better. One-sided because
 * the question is "can they tell them apart", and scoring far BELOW chance is
 * not evidence of hearing in reverse, it is the same null.
 */
export function score(answers, truth, { alpha = 0.05 } = {}) {
  if (answers.length > truth.length) throw new RangeError('more answers than trials');
  const n = answers.length;
  let correct = 0;
  for (let i = 0; i < n; i++) if (answers[i] === truth[i]) correct++;
  const p = binomialTailAtChance(correct, n);
  const needed = trialsNeeded(alpha);
  const significant = n >= needed && p <= alpha;
  return {
    trials: n,
    correct,
    proportion: n ? correct / n : 0,
    chance: CHANCE,
    pValue: p,
    alpha,
    significant,
    // The two refusals, and they are different refusals.
    underpowered: n < needed,
    verdict: significant
      ? 'told apart'
      : (n < needed ? 'not enough trials to show anything' : 'not shown'),
    // Said in full, because "not significant" is where listening tests get
    // misread as "identical". What a null result licenses is a bound, not a
    // claim of sameness.
    reason: significant
      ? `${correct} of ${n} correct; guessing produces this or better ${(p * 100).toFixed(2)}% of the time`
      : (n < needed
        ? `${n} trials cannot reach p <= ${alpha} even with a perfect score — ${needed} are needed`
        : `${correct} of ${n} correct, p = ${p.toFixed(3)}. This does not show the two are identical: `
          + `a listener who heard the difference ${(100 * detectableAt(n, alpha)).toFixed(0)}% of the time `
          + 'would usually have failed this session too'),
  };
}

/**
 * The smallest per-trial success rate this session length would usually catch,
 * at 80% power. It is what a null result is allowed to say: not "no
 * difference", but "nothing bigger than this".
 */
export function detectableAt(n, alpha = 0.05) {
  if (n < 1) return 1;
  let k = n;
  while (k > 0 && binomialTailAtChance(k - 1, n) <= alpha) k--;
  if (binomialTailAtChance(k, n) > alpha) return 1;   // no score can clear alpha
  // k is the smallest score that clears alpha. Find the per-trial success rate
  // at which a listener reaches it 80% of the time.
  for (let rate = 0.5; rate < 1; rate += 0.005) {
    let power = 0;
    for (let i = k; i <= n; i++) {
      power += Math.exp(logChoose(n, i) + i * Math.log(rate) + (n - i) * Math.log1p(-rate));
    }
    if (power >= 0.8) return Math.min(1, rate);
  }
  return 1;
}

function logChoose(n, k) {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i);
  return s;
}
